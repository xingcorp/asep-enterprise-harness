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
  RunRepository, TaskRepository, AttemptRepository,
} from './repositories.js';
import { SqlWorkspaceLeaseRepository } from './lease-repository.js';
import { OptimisticConcurrencyError, ScopeViolationError } from './sql.js';
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

// ---------------------------------------------------------------------------
// C3 — unique active writer/branch lease; concurrent attempt is denied.
// ---------------------------------------------------------------------------

test('C3: a second ACTIVE lease on the same (binding, branch) is denied', async () => {
  const client = await freshDb();
  const { scope, binding } = await seedScope(client);
  const leases = new SqlWorkspaceLeaseRepository(client);
  const a1 = 'A'.repeat(26) as AttemptId;
  const a2 = 'B'.repeat(26) as AttemptId;
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
  // Provider/forge SECRET material must never be stored. `owner_token` on
  // side_effect_records is a fencing token (a ULID lock owner id, disp.
  // P2-PLAN-HIGH-005), NOT a credential — the GitHub App private key and any
  // installation/access token live out of the DB (data-model §1). Match the
  // credential words but explicitly exclude the fencing-token column.
  const forbidden = /secret|private_key|password|credential|access_token|api_key/i;
  const leaks = r.rows
    .map((row) => `${row['table_name']}.${row['column_name']}`)
    .filter((c) => forbidden.test(c) && c !== 'side_effect_records.owner_token');
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
