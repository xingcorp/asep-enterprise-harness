// Persistence integration suite (exit criteria C1–C6). Runs against a REAL
// PostgreSQL engine via in-process PGlite (WASM) — genuine DDL, composite FKs,
// partial unique indexes and transactional rollback, no Docker required. A
// node-postgres pg.Pool implementing the same SqlClient seam would satisfy the
// identical assertions in CI when a container is available.
//
// Machine-readable suite marker (mirrors the Phase-1 SUITE-ID mechanism, exit
// criterion K4) so a dropped/renamed/crashed tenancy suite turns the gate RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PgliteClient } from './pglite-client.js';
import { migrate, MigrationChecksumError } from './migrator.js';
import { MIGRATIONS } from './migrations.js';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository, PullRequestRepository,
} from './repositories.js';
import { SqlAuditSink } from './audit-sink.js';
import { auditEvent, type CorrelationContext } from '@asep/observability';
import { SqlWorkspaceLeaseRepository } from './lease-repository.js';
import { LeaseLostError } from '@asep/ports';
import { OptimisticConcurrencyError, ScopeViolationError, type SqlClient } from './sql.js';
import type {
  OrganizationId, ProjectId, RepositoryBindingId, TenantScope, AttemptId,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:persistence-tenancy');

// A fully-migrated in-memory DB plus one registered org/project/binding/run.
async function freshDb() {
  const client = await PgliteClient.create();
  await migrate(client);
  return client;
}

async function seedScope(client: Awaited<ReturnType<typeof freshDb>>) {
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const org = await orgs.create({ name: 'Acme' });
  const proj = await projects.create({
    organizationId: org.id, name: 'web', defaultBranch: 'main',
  });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const binding = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
  });
  return { scope, binding };
}

// ---------------------------------------------------------------------------
// C5 — migrations: forward apply, idempotent re-apply, checksum immutability,
// concurrent-migrator serialization.
// ---------------------------------------------------------------------------

test('C5: full migration set applies forward on a clean DB', async () => {
  const client = await PgliteClient.create();
  const report = await migrate(client);
  assert.equal(report.applied.length, MIGRATIONS.length);
  assert.equal(report.skipped.length, 0);
  // Every table exists.
  const r = await client.query(
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  );
  const tables = r.rows.map((row) => row['table_name'] as string);
  for (const t of [
    'organizations', 'projects', 'repository_bindings', 'runs', 'tasks',
    'attempts', 'workspace_leases', 'artifacts', 'command_executions',
    'pull_requests', 'audit_events', 'side_effect_records', 'schema_migrations',
    'human_authorizations',
  ]) {
    assert.ok(tables.includes(t), `expected table ${t} to exist`);
  }
  await client.close();
});

test('C5: a second apply on an up-to-date DB is a no-op', async () => {
  const client = await freshDb();
  const report = await migrate(client);
  assert.equal(report.applied.length, 0);
  assert.equal(report.skipped.length, MIGRATIONS.length);
  await client.close();
});

test('C5: an edited applied migration fails closed on checksum', async () => {
  const client = await freshDb();
  const tampered = MIGRATIONS.map((m, i) =>
    i === 0 ? { ...m, sql: m.sql + '\n-- tampered\n' } : m,
  );
  await assert.rejects(() => migrate(client, tampered), MigrationChecksumError);
  await client.close();
});

test('C5: two concurrent migrators are serialized (both converge, no corruption)', async () => {
  const client = await PgliteClient.create();
  // PGlite is single-connection; the advisory lock still round-trips. Running
  // two migrate() calls concurrently must not double-apply or corrupt.
  const [a, b] = await Promise.all([migrate(client), migrate(client)]);
  const totalApplied = a.applied.length + b.applied.length;
  assert.equal(totalApplied, MIGRATIONS.length, 'each migration applied exactly once across both migrators');
  await client.close();
});

// ---------------------------------------------------------------------------
// C1 — state survives a process restart (reconnect to the same data dir).
// ---------------------------------------------------------------------------

test('C1: PostgreSQL state survives a client restart', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'asep-pg-'));

  const c1 = await PgliteClient.create(dir);
  await migrate(c1);
  const { scope } = await seedScope(c1);
  await c1.close();

  // Reopen the same directory — the org/project/binding must still be there.
  const c2 = await PgliteClient.create(dir);
  const orgs = new OrganizationRepository(c2);
  const got = await orgs.getById(scope.organizationId);
  assert.ok(got, 'organization survived restart');
  assert.equal(got!.id, scope.organizationId);
  await c2.close();
});

// ---------------------------------------------------------------------------
// C2 — TenantScope required; cross-project (IDOR) read AND write fail closed.
// ---------------------------------------------------------------------------

test('C2: a cross-project (IDOR) read fails closed', async () => {
  const client = await freshDb();
  const { scope } = await seedScope(client);
  const other = await seedScope(client);
  const runs = new RunRepository(client);
  const run = await runs.create(scope, {
    repositoryBindingId: (await seedBinding(client, scope)),
    status: 'EXECUTING', risk: 'R0',
  });
  // Reading project A's run under project B's scope must fail closed.
  await assert.rejects(() => runs.getScoped(other.scope, run.id), ScopeViolationError);
  await client.close();
});

test('C2: a cross-project (IDOR) write cannot target another project row', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  const task = await tasks.create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
  });
  // An update issued under the wrong scope matches zero rows → fail closed.
  await assert.rejects(
    () => tasks.updateStatus(other.scope, task.id, 0, 'READY'),
    OptimisticConcurrencyError,
  );
  // And the row is untouched under its real scope.
  const still = await tasks.getScoped(scope, task.id);
  assert.equal(still.status, 'PENDING');
  await client.close();
});

// ---------------------------------------------------------------------------
// C2b — hierarchy consistency DB-enforced by composite FK (not a row filter).
// ---------------------------------------------------------------------------

test('C2b: a task referencing a run from another project is rejected by the DB', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const runs = new RunRepository(client);
  // Run belongs to project B.
  const foreignRun = await runs.create(other.scope, {
    repositoryBindingId: other.binding.id, status: 'EXECUTING', risk: 'R0',
  });
  // Claiming project A scope but pointing at project B's run must be rejected
  // by the composite FK (run_id, organization_id, project_id) → runs.
  const tasks = new TaskRepository(client);
  await assert.rejects(
    () => tasks.create(scope, {
      runId: foreignRun.id, repositoryBindingId: binding.id, risk: 'R0',
    }),
    /foreign key|violates/i,
  );
  await client.close();
});

// HIGH-005: the DB rejects a task/attempt whose repository_binding_id belongs
// to another project — the composite FK (binding, org, project) → bindings makes
// "the binding I point at is in MY scope" a DB invariant, not a row filter.

test('HIGH-005: a task naming a binding from another project is rejected by the DB', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  // A legitimate run in scope A.
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  // Point the task at scope A's run but scope B's binding — the binding FK
  // (bindingB, orgA, projA) has no matching row, so the DB rejects it.
  await assert.rejects(
    () => tasks.create(scope, {
      runId: run.id, repositoryBindingId: other.binding.id, risk: 'R0',
    }),
    /foreign key|violates/i,
  );
  await client.close();
});

test('HIGH-005: an attempt naming a binding from another project is rejected by the DB', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const attempts = new AttemptRepository(client);
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  const task = await tasks.create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
  });
  // Attempt in scope A's task but pointing at scope B's binding → rejected.
  await assert.rejects(
    () => attempts.create(scope, {
      taskId: task.id, repositoryBindingId: other.binding.id,
    }),
    /foreign key|violates/i,
  );
  await client.close();
});

// HIGH-005 (migration 0011): even WITHIN one project, a task must name the SAME
// binding as its parent run, and an attempt the same binding as its parent task.
// The earlier tests used a binding from another PROJECT (caught by the scoped
// binding FK). This one uses a second binding in the SAME scope, so only the
// hierarchy-coherence FK can catch it — the row filter and the scoped binding FK
// both pass.
test('HIGH-005: a task naming a DIFFERENT in-project binding than its run is rejected', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  // A second, legitimate binding in the SAME project.
  const binding2 = await seedBinding(client, scope);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  // Task points at run (binding1) but names binding2 — coherent-FK rejects it.
  await assert.rejects(
    () => tasks.create(scope, {
      runId: run.id, repositoryBindingId: binding2, risk: 'R0',
    }),
    /foreign key|violates/i,
  );
  await client.close();
});

test('HIGH-005: an attempt naming a DIFFERENT in-project binding than its task is rejected', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const binding2 = await seedBinding(client, scope);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const attempts = new AttemptRepository(client);
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  const task = await tasks.create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
  });
  // Attempt points at task (binding1) but names binding2 — coherent-FK rejects.
  await assert.rejects(
    () => attempts.create(scope, {
      taskId: task.id, repositoryBindingId: binding2,
    }),
    /foreign key|violates/i,
  );
  await client.close();
});

// HIGH-005: an attempt's evidence link is a SCOPED artifact reference. The
// composite FK (evidence_artifact_id, org, project) → artifacts makes "the
// evidence I attach lives in MY scope" a DB invariant; the pinned sha256 lets a
// swapped-bytes artifact be detected later.

// Seed an artifacts row directly (attempt_id null) so evidence-FK behaviour can
// be exercised without the full pipeline. Returns the artifact id + sha.
async function seedArtifact(
  client: Awaited<ReturnType<typeof freshDb>>, scope: TenantScope, sha: string,
): Promise<string> {
  const id = 'E'.repeat(26).slice(0, 25) + String(Math.floor(Math.random() * 10));
  await client.query(
    `insert into artifacts
       (id, organization_id, project_id, attempt_id, kind, sha256, size_bytes, storage_key, content_type)
     values ($1, $2, $3, null, 'evidence-bundle', $4, 10, $5, 'application/json')`,
    [id, scope.organizationId, scope.projectId, sha, `k/${id}`],
  );
  return id;
}

async function seedAttempt(
  client: Awaited<ReturnType<typeof freshDb>>, scope: TenantScope, bindingId: RepositoryBindingId,
): Promise<AttemptId> {
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const attempts = new AttemptRepository(client);
  const run = await runs.create(scope, { repositoryBindingId: bindingId, status: 'EXECUTING', risk: 'R0' });
  const task = await tasks.create(scope, { runId: run.id, repositoryBindingId: bindingId, risk: 'R0' });
  const attempt = await attempts.create(scope, { taskId: task.id, repositoryBindingId: bindingId });
  return attempt.id;
}

test('HIGH-005: attaching an in-scope evidence artifact ref persists id + expected sha', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const attempts = new AttemptRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const sha = 'c'.repeat(64);
  const artifactId = await seedArtifact(client, scope, sha);
  const v = await attempts.attachEvidence(scope, attemptId, 0, {
    artifactId: artifactId as never, sha256: sha, kind: 'evidence-bundle',
  });
  assert.equal(v, 1);
  const row = await attempts.getScoped(scope, attemptId);
  assert.equal(row.evidenceArtifactId, artifactId);
  assert.equal(row.evidenceSha256, sha);
  await client.close();
});

test('HIGH-005: attaching an evidence artifact from another project is rejected by the DB', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const attempts = new AttemptRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  // An evidence artifact that lives in scope B.
  const foreignArtifact = await seedArtifact(client, other.scope, 'd'.repeat(64));
  // Attaching it to scope A's attempt fails closed: the authoritative-checksum
  // cross-check resolves the artifact WITHIN scope A first, finds no such row,
  // and rejects before the composite FK is even reached.
  await assert.rejects(
    () => attempts.attachEvidence(scope, attemptId, 0, {
      artifactId: foreignArtifact as never, sha256: 'd'.repeat(64), kind: 'evidence-bundle',
    }),
    /mismatch|foreign key|violates/i,
  );
  await client.close();
});

test('HIGH-005: an evidence ref whose sha256 disagrees with the stored artifact is rejected', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const attempts = new AttemptRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  // A real in-scope artifact whose authoritative sha256 is all-'d'.
  const artifactId = await seedArtifact(client, scope, 'd'.repeat(64));
  // A ref that names the RIGHT artifact but claims a DIFFERENT checksum (a
  // forged/stale ref). The composite FK would accept it — the id + scope match —
  // so only the checksum cross-check can catch it.
  await assert.rejects(
    () => attempts.attachEvidence(scope, attemptId, 0, {
      artifactId: artifactId as never, sha256: 'e'.repeat(64), kind: 'evidence-bundle',
    }),
    /sha256 mismatch/,
  );
  await client.close();
});

// ---------------------------------------------------------------------------
// HIGH-009 — human_authorizations (migration 0010) is the AUTHORITATIVE record
// of a signed human review handoff. Before it, a pilot manifest's
// `humanDisposition` had no truth to be checked against. These tests prove the
// table's DB-enforced invariants: one authorization per task, tenant-scoped
// composite FKs onto task AND attempt, and a closed disposition enum. The
// signature-verification behaviour is proven in the pilot-manifest suite.
// ---------------------------------------------------------------------------

// Create run + task + attempt and return BOTH ids: an authorization row must
// reference a task and an attempt that live in the same scope.
async function seedTaskAndAttempt(
  client: Awaited<ReturnType<typeof freshDb>>, scope: TenantScope, bindingId: RepositoryBindingId,
): Promise<{ taskId: string; attemptId: AttemptId }> {
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const attempts = new AttemptRepository(client);
  const run = await runs.create(scope, { repositoryBindingId: bindingId, status: 'EXECUTING', risk: 'R0' });
  const task = await tasks.create(scope, { runId: run.id, repositoryBindingId: bindingId, risk: 'R0' });
  const attempt = await attempts.create(scope, { taskId: task.id, repositoryBindingId: bindingId });
  return { taskId: task.id, attemptId: attempt.id };
}

async function insertAuthorization(
  client: Awaited<ReturnType<typeof freshDb>>,
  scope: TenantScope,
  input: { taskId: string; attemptId: string; disposition?: string; prId?: string },
): Promise<void> {
  await client.query(
    `insert into human_authorizations
       (id, organization_id, project_id, task_id, attempt_id, pull_request_id,
        disposition, reviewed_result_sha, signed_by, signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      'H'.repeat(25) + String(Math.floor(Math.random() * 10)),
      scope.organizationId, scope.projectId, input.taskId, input.attemptId,
      input.prId ?? 'P'.repeat(26),
      input.disposition ?? 'ACCEPTED', 'e'.repeat(40), 'reviewer@acme', 'c2ln',
    ],
  );
}

test('HIGH-009: a signed authorization for an in-scope task+attempt persists', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const { taskId, attemptId } = await seedTaskAndAttempt(client, scope, binding.id);
  await insertAuthorization(client, scope, { taskId, attemptId });
  const r = await client.query(
    `select disposition, signed_by, signature from human_authorizations
     where task_id = $1 and organization_id = $2 and project_id = $3`,
    [taskId, scope.organizationId, scope.projectId],
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0]!['disposition'], 'ACCEPTED');
  assert.equal(r.rows[0]!['signed_by'], 'reviewer@acme');
  await client.close();
});

test('HIGH-009: a SECOND authorization for the same task is rejected by the DB', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const { taskId, attemptId } = await seedTaskAndAttempt(client, scope, binding.id);
  await insertAuthorization(client, scope, { taskId, attemptId, disposition: 'PENDING' });
  // One human decision per task: a second row cannot be stacked on to upgrade a
  // PENDING handoff into an ACCEPTED one.
  await assert.rejects(
    () => insertAuthorization(client, scope, { taskId, attemptId, disposition: 'ACCEPTED' }),
    /unique|duplicate/i,
  );
  await client.close();
});

test('HIGH-009: an authorization naming ANOTHER tenant\'s task is rejected by the composite FK', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const mine = await seedTaskAndAttempt(client, scope, binding.id);
  const theirs = await seedTaskAndAttempt(client, other.scope, other.binding.id);
  // Scope A cannot authorize scope B's task: there is no (taskId, orgA, projA)
  // row in tasks, so the composite FK refuses the insert.
  await assert.rejects(
    () => insertAuthorization(client, scope, { taskId: theirs.taskId, attemptId: mine.attemptId }),
    /foreign key|violates/i,
  );
  await client.close();
});

test('HIGH-009: an unknown disposition is rejected by the enum check', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const { taskId, attemptId } = await seedTaskAndAttempt(client, scope, binding.id);
  await assert.rejects(
    () => insertAuthorization(client, scope, { taskId, attemptId, disposition: 'TOTALLY_FINE' }),
    /check|constraint|violates/i,
  );
  await client.close();
});

// HIGH-008: the PullRequestRepository persists the authoritative PR row so the
// K1 traceability chain resolves on real state. The upsert is idempotent on
// (binding, head_branch) and carries a SCOPED evidence ref (composite FK).

test('HIGH-008: PR upsert is idempotent on (binding, head_branch) and persists the scoped evidence ref', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const prs = new PullRequestRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const sha = 'a'.repeat(64);
  const artifactId = await seedArtifact(client, scope, sha);
  const first = await prs.upsert(scope, {
    repositoryBindingId: binding.id, attemptId, forge: 'github',
    number: 7, headBranch: 'asep/attempt-1', baseBranch: 'main',
    url: 'https://forge/pr/7', state: 'OPEN',
    evidenceRef: { artifactId: artifactId as never, sha256: sha, kind: 'evidence-bundle' },
  });
  assert.equal(first.number, 7);
  assert.equal(first.evidenceArtifactId, artifactId);
  assert.equal(first.evidenceSha256, sha);
  // A retry with the SAME head branch updates the existing row (no duplicate).
  const again = await prs.upsert(scope, {
    repositoryBindingId: binding.id, attemptId, forge: 'github',
    number: 7, headBranch: 'asep/attempt-1', baseBranch: 'main',
    url: 'https://forge/pr/7', state: 'OPEN',
    evidenceRef: { artifactId: artifactId as never, sha256: sha, kind: 'evidence-bundle' },
  });
  assert.equal(again.id, first.id, 'the same PR row is reused, not duplicated');
  assert.ok(again.version > first.version, 'the retry bumps version on the existing row');
  // Exactly one PR row exists for this (binding, branch).
  const count = await client.query(
    `select count(*)::int as n from pull_requests
     where repository_binding_id = $1 and head_branch = $2`,
    [binding.id, 'asep/attempt-1'],
  );
  assert.equal(count.rows[0]!['n'], 1, 'idempotent upsert never duplicates the PR');
  await client.close();
});

test('HIGH-008: a PR naming an evidence artifact from another project is rejected by the DB', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const prs = new PullRequestRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const foreignArtifact = await seedArtifact(client, other.scope, 'b'.repeat(64));
  await assert.rejects(
    () => prs.upsert(scope, {
      repositoryBindingId: binding.id, attemptId, forge: 'github',
      number: 1, headBranch: 'asep/attempt-1', baseBranch: 'main',
      url: null, state: 'OPEN',
      evidenceRef: { artifactId: foreignArtifact as never, sha256: 'b'.repeat(64), kind: 'evidence-bundle' },
    }),
    /foreign key|violates/i,
  );
  await client.close();
});

// MED-003: the SqlAuditSink persists a privileged-operation AuditEvent to the
// audit_events table with full tenant/hierarchy attribution — a privileged op
// leaves an authoritative row, not just a vocabulary type (exit J4).

test('MED-003: SqlAuditSink persists a privileged AuditEvent to audit_events with full attribution', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const attemptRow = await new AttemptRepository(client).getScoped(scope, attemptId);
  const sink = new SqlAuditSink(client);
  const ctx: CorrelationContext = {
    traceId: 'trace-1',
    tenantId: scope.organizationId,
    projectId: scope.projectId,
    organizationId: scope.organizationId,
    repositoryBindingId: binding.id,
    runId: attemptRow.taskId, // any in-scope id; run linkage exercised via task
    taskId: attemptRow.taskId,
    attemptId,
  };
  const ev = auditEvent({
    actor: 'harness',
    action: 'forge.push',
    context: ctx,
    occurredAt: '2026-01-01T00:00:00.000Z',
    detail: { ref: 'refs/heads/asep/x' },
  });
  await sink.record(ev);
  const r = await client.query(
    `select organization_id, project_id, task_id, attempt_id, actor, action, detail
     from audit_events where organization_id = $1 and action = $2`,
    [scope.organizationId, 'forge.push'],
  );
  assert.equal(r.rowCount, 1, 'exactly one audit row persisted');
  const row = r.rows[0]!;
  assert.equal(row['organization_id'], scope.organizationId, 'tenant-attributed');
  assert.equal(row['project_id'], scope.projectId);
  assert.equal(row['attempt_id'], attemptId, 'resolves to the exact attempt');
  assert.equal(row['actor'], 'harness');
  assert.equal(row['action'], 'forge.push');
  await client.close();
});

// ---------------------------------------------------------------------------
// C3 — unique active writer/branch lease; concurrent attempt is denied.
// ---------------------------------------------------------------------------

test('C3: a second ACTIVE lease on the same (binding, branch) is denied', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const leases = new SqlWorkspaceLeaseRepository(client);
  const a1 = await seedAttempt(client, scope, binding.id);
  const a2 = await seedAttempt(client, scope, binding.id);
  const first = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId: a1, ttlMs: 60_000,
  });
  assert.ok('leaseId' in first, 'first acquire wins');
  const second = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId: a2, ttlMs: 60_000,
  });
  assert.ok('denied' in second, 'second concurrent acquire is denied');
  // After releasing the first, a new acquire wins.
  await leases.release(scope, (first as { leaseId: string }).leaseId);
  const third = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId: a2, ttlMs: 60_000,
  });
  assert.ok('leaseId' in third, 'acquire wins after release');
  await client.close();
});

test('each granted lease takes the next fencing epoch for its (binding, branch)', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const leases = new SqlWorkspaceLeaseRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const epochs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const l = await leases.acquire(scope, {
      repositoryBindingId: binding.id, branch: 'asep/x', attemptId, ttlMs: 60_000,
    });
    if ('denied' in l) throw new Error('acquire denied');
    epochs.push(l.fencingEpoch);
    await leases.release(scope, l.leaseId);
  }
  assert.deepEqual(epochs, [1, 2, 3], 'strictly increasing, no reuse');
  // Another branch has its own sequence.
  const other = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/y', attemptId, ttlMs: 60_000,
  });
  assert.ok('leaseId' in other && other.fencingEpoch === 1);
  // The database owns the sequence: a duplicate epoch and an edited epoch are refused.
  await assert.rejects(
    () => client.query(
      `insert into workspace_leases
         (id, organization_id, project_id, repository_binding_id, branch, attempt_id,
          workspace_id, state, expires_at, ttl_ms, fencing_epoch)
       values ($1, $2, $3, $4, 'asep/x', $5, 'ws', 'RELEASED', now(), 1000, 2)`,
      ['Q'.repeat(26), scope.organizationId, scope.projectId, binding.id, attemptId] as never,
    ),
    /unique|duplicate/i,
  );
  await assert.rejects(
    () => client.query(
      `update workspace_leases set fencing_epoch = 99 where branch = 'asep/y'`, [] as never,
    ),
    /fencing epoch is immutable/,
  );
  await client.close();
});

test('a heartbeat renews a live lease by its TTL and refuses a dead one', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const leases = new SqlWorkspaceLeaseRepository(client);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const l = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId, ttlMs: 300,
  });
  if ('denied' in l) throw new Error('acquire denied');
  // Heartbeating keeps the lease alive well past its original expiry.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 150));
    await leases.heartbeat(scope, l.leaseId);
  }
  const row = await client.query(
    `select state, expires_at > now() as live from workspace_leases where id = $1`, [l.leaseId],
  );
  assert.equal(row.rows[0]!['state'], 'ACTIVE');
  assert.equal(row.rows[0]!['live'], true, 'renewed past the original 300ms TTL');
  // Once it lapses it is dead, even before any sweep: no heartbeat revives it.
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(() => leases.heartbeat(scope, l.leaseId), LeaseLostError);
  // A released lease cannot heartbeat either, and a non-positive TTL is refused.
  const m = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId, ttlMs: 60_000,
  });
  if ('denied' in m) throw new Error('acquire denied');
  await leases.release(scope, m.leaseId);
  await assert.rejects(() => leases.heartbeat(scope, m.leaseId), LeaseLostError);
  await assert.rejects(
    () => leases.acquire(scope, { repositoryBindingId: binding.id, branch: 'asep/x', attemptId, ttlMs: 0 }),
    RangeError,
  );
  await client.close();
});

// A lease belongs to a real attempt of its own tenant and repository binding:
// a composite foreign key (attempt, organization, project, binding) onto
// attempts. Without it a lease could name an attempt that never existed or
// one in another tenant, and every side-effect record owned by that lease
// would inherit the dangling identity.
test('the DB refuses a lease for an attempt that does not exist', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const leases = new SqlWorkspaceLeaseRepository(client);
  await assert.rejects(
    () => leases.acquire(scope, {
      repositoryBindingId: binding.id, branch: 'asep/x', attemptId: 'Z'.repeat(26) as AttemptId, ttlMs: 60_000,
    }),
    /foreign key|violates/i,
  );
  await assert.rejects(
    () => client.query(
      `insert into workspace_leases
         (id, organization_id, project_id, repository_binding_id, branch, attempt_id,
          workspace_id, state, expires_at, ttl_ms, fencing_epoch)
       values ($1, $2, $3, $4, 'asep/x', $5, 'ws', 'ACTIVE', now() + interval '1 minute', 60000, 1)`,
      ['Q'.repeat(26), scope.organizationId, scope.projectId, binding.id, 'Z'.repeat(26)] as never,
    ),
    /foreign key|violates/i,
  );
  const n = await client.query(`select count(*)::int as n from workspace_leases`);
  assert.equal(n.rows[0]!['n'], 0, 'no lease row was written');
  await client.close();
});

test("the DB refuses a lease for another tenant's attempt", async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const other = await seedScope(client);
  const foreignAttempt = await seedAttempt(client, other.scope, other.binding.id);
  const leases = new SqlWorkspaceLeaseRepository(client);
  // Scope A's binding, scope B's attempt.
  await assert.rejects(
    () => leases.acquire(scope, {
      repositoryBindingId: binding.id, branch: 'asep/x', attemptId: foreignAttempt, ttlMs: 60_000,
    }),
    /foreign key|violates/i,
  );
  // Scope A naming scope B's binding and attempt is refused as well.
  await assert.rejects(
    () => leases.acquire(scope, {
      repositoryBindingId: other.binding.id, branch: 'asep/x', attemptId: foreignAttempt, ttlMs: 60_000,
    }),
    /foreign key|violates/i,
  );
  // The owning tenant gets it.
  const own = await leases.acquire(other.scope, {
    repositoryBindingId: other.binding.id, branch: 'asep/x', attemptId: foreignAttempt, ttlMs: 60_000,
  });
  assert.ok('leaseId' in own, 'the attempt\'s own tenant and binding are granted the lease');
  await client.close();
});

test("the DB refuses a lease whose binding is not its attempt's binding", async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const otherBinding = await seedBinding(client, scope);
  const attemptId = await seedAttempt(client, scope, binding.id);
  const leases = new SqlWorkspaceLeaseRepository(client);
  await assert.rejects(
    () => leases.acquire(scope, {
      repositoryBindingId: otherBinding, branch: 'asep/x', attemptId, ttlMs: 60_000,
    }),
    /foreign key|violates/i,
  );
  const own = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId, ttlMs: 60_000,
  });
  assert.ok('leaseId' in own);
  await client.close();
});

test('upgrading a database whose lease names no attempt fails instead of guessing one', async () => {
  const before = MIGRATIONS.findIndex((m) => m.id === '0015_lease_attempt_fk');
  assert.ok(before > 0, 'the lease-attempt migration is registered');
  const insertLease = (client: SqlClient, scope: TenantScope, bindingId: string, id: string, attemptId: string) =>
    client.query(
      `insert into workspace_leases
         (id, organization_id, project_id, repository_binding_id, branch, attempt_id,
          workspace_id, state, expires_at, ttl_ms, fencing_epoch)
       values ($1, $2, $3, $4, $5, $6, 'ws', 'RELEASED', now(), 1000, 1)`,
      [id, scope.organizationId, scope.projectId, bindingId, `asep/${id}`, attemptId] as never,
    );

  // A database whose leases all name a real attempt upgrades cleanly.
  const clean = await PgliteClient.create();
  await migrate(clean, MIGRATIONS.slice(0, before));
  const ok = await seedScope(clean);
  await insertLease(clean, ok.scope, ok.binding.id, 'L'.repeat(26), await seedAttempt(clean, ok.scope, ok.binding.id));
  const report = await migrate(clean);
  assert.deepEqual(report.applied, MIGRATIONS.slice(before).map((m) => m.id));
  await clean.close();

  // One dangling lease stops the upgrade, and nothing is deleted.
  const dirty = await PgliteClient.create();
  await migrate(dirty, MIGRATIONS.slice(0, before));
  const bad = await seedScope(dirty);
  await insertLease(dirty, bad.scope, bad.binding.id, 'M'.repeat(26), 'Z'.repeat(26));
  await assert.rejects(() => migrate(dirty), /name no attempt of their own tenant and binding/);
  const n = await dirty.query(`select count(*)::int as n from workspace_leases`);
  assert.equal(n.rows[0]!['n'], 1, 'the dangling lease is left for an operator, not deleted');
  await dirty.close();
});

// ---------------------------------------------------------------------------
// C4 — optimistic-concurrency: a stale version update is rejected.
// ---------------------------------------------------------------------------

test('C4: a conflicting (stale-version) update is rejected', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  const task = await tasks.create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
  });
  // First update at version 0 succeeds and bumps to 1.
  const v1 = await tasks.updateStatus(scope, task.id, 0, 'READY');
  assert.equal(v1, 1);
  // A second update still using version 0 is a lost-update conflict.
  await assert.rejects(
    () => tasks.updateStatus(scope, task.id, 0, 'EXECUTING'),
    OptimisticConcurrencyError,
  );
  await client.close();
});

// ---------------------------------------------------------------------------
// C6 — no provider token / private key column exists anywhere.
// ---------------------------------------------------------------------------

test('C6: no table stores a provider token or private key', async () => {
  const client = await freshDb();
  const r = await client.query(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public'`,
  );
  // Provider/forge SECRET material must never be stored — the GitHub App
  // private key and any installation/access token live out of the DB
  // (data-model §1). Side-effect ownership is a lease id (a ULID lock owner),
  // not a credential.
  const forbidden = /secret|private_key|password|credential|access_token|api_key/i;
  const leaks = r.rows
    .map((row) => `${row['table_name']}.${row['column_name']}`)
    .filter((c) => forbidden.test(c));
  assert.deepEqual(leaks, [], `no secret-bearing columns; found: ${leaks.join(', ')}`);
  await client.close();
});

// Helper: create a second binding under the same scope (for run creation in the
// IDOR read test, keeping each test's rows independent).
async function seedBinding(
  client: Awaited<ReturnType<typeof freshDb>>,
  scope: TenantScope,
): Promise<RepositoryBindingId> {
  const bindings = new RepositoryBindingRepository(client);
  const b = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: `r-${Math.random().toString(36).slice(2)}`,
    defaultBaseBranch: 'main',
  });
  return b.id;
}
