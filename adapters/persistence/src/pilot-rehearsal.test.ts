// Executable pilot rehearsal (exit criterion M3, disp. P2-FINAL-MED-006).
//
// The prose rehearsal (docs/.../phase-02-pilot-rehearsal.md) described five
// injected faults against shipped mechanisms, but described them — it did not
// RUN them. This suite is the executable projection: each fault is injected
// against a REAL mechanism (in-process PGlite DB, a real temp-dir filesystem
// object store, the real side-effect log, the real lease repository) and the
// documented recovery decision is asserted on the resulting real state. A
// change to the side-effect log, lease repo, or object store that breaks a
// recovery path turns this suite RED — it is not a paper claim.
//
// The provider timeout is covered by the agent-claude suite. The object-store
// outage and GitHub rate limiting are also injected into a real run of the
// governed pipeline (apps/control-plane-api/src/pilot-faults.test.ts); the
// Fault 3 and Fault 5 cases here cover the persistence mechanisms underneath.
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteClient } from './pglite-client.js';
import { migrate } from './migrator.js';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
} from './repositories.js';
import { SqlWorkspaceLeaseRepository } from './lease-repository.js';
import { SqlSideEffectLog } from './side-effect-log.js';
import { FilesystemObjectStore, ObjectNotFoundError } from './object-store.js';
import type { TenantScope, AttemptId, RepositoryBindingId } from '@asep/contracts';

console.log('SUITE-ID: asep-suite:pilot-rehearsal');

async function seed(dataDir?: string) {
  const client = await PgliteClient.create(dataDir);
  await migrate(client);
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const org = await orgs.create({ name: 'Acme' });
  const proj = await projects.create({ organizationId: org.id, name: 'web', defaultBranch: 'main' });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const binding = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
  });
  // Side-effect records are FK-bound to a real attempt (migration 0013).
  const run = await new RunRepository(client).create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  const task = await new TaskRepository(client).create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
  });
  const attempt = await new AttemptRepository(client).create(scope, {
    taskId: task.id, repositoryBindingId: binding.id,
  });
  const attemptId: AttemptId = attempt.id;
  // Every side-effect record is owned by a live workspace lease of its attempt
  // (migration 0014), exactly as the pipeline writes them.
  const granted = await new SqlWorkspaceLeaseRepository(client).acquire(scope, {
    repositoryBindingId: binding.id, branch: 'asep/x', attemptId, ttlMs: 60_000,
  });
  if ('denied' in granted) throw new Error('seed lease denied');
  return { client, scope, binding, attemptId, owner: granted.leaseId };
}

// --- Fault 2 — DB restart mid-attempt: a PENDING side-effect row is reconciled
// (adopted) on recovery, NOT replayed. Injected with a REAL process-level DB
// restart: the first PGlite client opens, writes the PENDING row, and is
// CLOSED (simulating the process death); a SECOND client opens the same
// on-disk dataDir — simulating the restart — and must see the row survive.
//
// Before this fix the test used the same live client for "restart", which
// proved nothing about durability: it only tested that a row is visible to the
// connection that wrote it. Close + reopen is the minimum that actually validates
// the C1 guarantee ("state survives process restart").
test('M3/Fault2: a PENDING side effect survives a REAL DB restart and is ADOPTED, not replayed', async () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'asep-rehearsal-db-'));
  try {
    // First process: seed + begin(), then "crash" (close the client).
    const { client: first, scope, binding, attemptId, owner } = await seed(dbDir);
    const beginInput = {
      operation: 'push' as const,
      repositoryBindingId: binding.id,
      attemptId,
      requestFingerprint: 'push:asep/x@sha',
      ownerToken: owner,
      naturalKey: 'refs/heads/asep/x',
    };
    await new SqlSideEffectLog(first).begin(scope, beginInput);
    await first.close(); // === process crash / DB shutdown ===

    // Second process: open the SAME persistent dataDir (the restart).
    const resumed = await PgliteClient.create(dbDir);
    const resumeLog = new SqlSideEffectLog(resumed);
    const row = await resumeLog.begin(scope, beginInput);
    assert.equal(row.existed, true, 'the PENDING row survived the restart');
    assert.equal(row.state, 'PENDING', 'state is still PENDING — not lost or reset');

    // A different fingerprint on the same key still fails closed.
    await assert.rejects(
      () => resumeLog.begin(scope, { ...beginInput, requestFingerprint: 'push:asep/x@DIFFERENT' }),
      /fingerprint/i,
    );
    await resumed.close();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// --- Fault 3 — object-store outage during evidence persist: a missing object
// fails closed on read (ObjectNotFoundError), so a task cannot advance with
// absent evidence bytes. Injected against a real filesystem store.
test('M3/Fault3: an object-store outage fails closed on read (no partial-evidence advance)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-rehearsal-'));
  try {
    const objects = new FilesystemObjectStore(join(dir, 'objects'));
    // A read of a never-written key (the outage: bytes absent) fails closed.
    await assert.rejects(() => objects.get('org/proj/evidence/missing'), ObjectNotFoundError);
    // A create-only write then read round-trips (recovery after the store is back).
    const bytes = new TextEncoder().encode('evidence bytes');
    await objects.putIfAbsent('org/proj/evidence/e1', bytes);
    const back = await objects.get('org/proj/evidence/e1');
    assert.deepEqual([...back], [...bytes]);
    // A conflicting re-write with DIFFERENT bytes fails closed (immutable).
    await assert.rejects(
      () => objects.putIfAbsent('org/proj/evidence/e1', new TextEncoder().encode('tampered')),
      /already exists/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fault 4 — stale lease from a dead worker: the expired ACTIVE lease is
// swept and a fresh acquire wins; a concurrent LIVE lease is denied. Injected
// against the real lease repository with a 1ms TTL to force expiry.
test('M3/Fault4: a stale (expired) lease is swept so a fresh acquire wins; a live one is denied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-rehearsal-'));
  try {
    const { client, scope, binding } = await seed();
    const leases = new SqlWorkspaceLeaseRepository(client);
    const branch = 'asep/run/task/attempt';
    // A dead worker's lease with an immediately-past TTL (1ms).
    const dead = await leases.acquire(scope, {
      repositoryBindingId: binding.id, branch, attemptId: 'A'.repeat(26) as AttemptId, ttlMs: 1,
    });
    assert.ok('leaseId' in dead, 'the first (soon-stale) lease is granted');
    // A tiny wait so expires_at is strictly in the past.
    await new Promise((r) => setTimeout(r, 5));
    // The next acquire sweeps the expired ACTIVE lease and wins.
    const fresh = await leases.acquire(scope, {
      repositoryBindingId: binding.id, branch, attemptId: 'B'.repeat(26) as AttemptId, ttlMs: 60_000,
    });
    assert.ok('leaseId' in fresh, 'a fresh acquire wins after the stale lease is swept');
    // A concurrent LIVE acquire on the same (binding, branch) is denied.
    const denied = await leases.acquire(scope, {
      repositoryBindingId: binding.id, branch, attemptId: 'C'.repeat(26) as AttemptId, ttlMs: 60_000,
    });
    assert.ok('denied' in denied, 'a concurrent live acquire is denied');
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fault 5 (side-effect facet) — a delayed retry of a COMPLETED forge effect
// is ADOPTED, converging to one PR. The transport rate-limit/expiry recovery is
// proven in the github-app MED-002 suite; here we prove the log-level
// idempotency the runbook relies on for "idempotent retry converges".
test('M3/Fault5: a delayed retry of a COMPLETED forge side effect is adopted (single PR)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-rehearsal-'));
  try {
    const { client, scope, binding, attemptId, owner } = await seed();
    const log = new SqlSideEffectLog(client);
    const beginInput = {
      operation: 'pr-upsert' as const,
      repositoryBindingId: binding.id,
      attemptId,
      requestFingerprint: 'pr:asep/x->main',
      ownerToken: owner,
    };
    await log.begin(scope, beginInput);
    const pr = {
      kind: 'pr-upsert' as const, number: 7, url: 'https://github.com/acme/web/pull/7',
      headBranch: 'asep/x', baseBranch: 'main',
    };
    await log.complete(scope, { ...beginInput, resultRef: pr, naturalKey: 'asep/x' });
    // A delayed retry after the rate-limit backoff adopts the COMPLETED record.
    const adopt = await log.begin(scope, beginInput);
    assert.equal(adopt.existed, true);
    assert.equal(adopt.state, 'COMPLETED');
    assert.deepEqual(adopt.resultRef, pr, 'the recorded PR is adopted — no duplicate opened');
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
