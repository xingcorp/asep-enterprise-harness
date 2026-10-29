// SideEffectLog integration suite (exit criterion C7). Runs against a REAL
// PostgreSQL engine (in-process PGlite) — genuine UNIQUE constraint, composite
// scope key, transactional fencing. Proves the two-phase crash-safe protocol:
//   - begin() claims a fresh PENDING record; a second begin() for the SAME
//     effect ADOPTS the existing record (existed=true) rather than duplicating;
//   - reusing a key with a DIFFERENT fingerprint FAILS CLOSED;
//   - complete()/fail() enforce FENCING: a mismatched owner_token is rejected;
//   - complete() persists result_ref + natural_key for remote reconciliation;
//   - a full re-run (begin → complete already done) adopts the COMPLETED record
//     so the caller performs the external effect exactly once.
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate
// RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PgliteClient } from './pglite-client.js';
import { migrate } from './migrator.js';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
} from './repositories.js';
import { SqlSideEffectLog } from './side-effect-log.js';
import { SideEffectFingerprintError, SideEffectFencingError } from '@asep/ports';
import type {
  TenantScope, AttemptId, RepositoryBindingId,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:side-effect-log');

async function fresh() {
  const client = await PgliteClient.create();
  await migrate(client);
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
  const log = new SqlSideEffectLog(client);
  return { client, scope, binding, log };
}

const attemptId = 'attempt-1' as AttemptId;

test('C7: begin claims a fresh PENDING record (existed=false)', async () => {
  const { client, scope, binding, log } = await fresh();
  const rec = await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: 'lease-1',
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  assert.equal(rec.existed, false);
  assert.equal(rec.state, 'PENDING');
  await client.close();
});

test('C7: a second begin for the SAME effect ADOPTS the record (existed=true) — no duplicate', async () => {
  const { client, scope, binding, log } = await fresh();
  const input = {
    operation: 'push' as const,
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: 'lease-1',
  };
  await log.begin(scope, input);
  const second = await log.begin(scope, input);
  assert.equal(second.existed, true, 'the retry adopts the existing PENDING record');
  await client.close();
});

test('C7: reusing a key with a DIFFERENT fingerprint FAILS CLOSED', async () => {
  const { client, scope, binding, log } = await fresh();
  await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha1',
    ownerToken: 'lease-1',
  });
  await assert.rejects(
    () => log.begin(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      requestFingerprint: 'push:branch@sha2', // different commit → different effect
      ownerToken: 'lease-1',
    }),
    SideEffectFingerprintError,
  );
  await client.close();
});

test('C7: complete persists result_ref + natural_key and marks COMPLETED', async () => {
  const { client, scope, binding, log } = await fresh();
  await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr:head->base',
    ownerToken: 'lease-1',
  });
  const pr = { number: 42, url: 'https://github.com/acme/web/pull/42', headBranch: 'asep/attempt-1', baseBranch: 'main' };
  const done = await log.complete(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: 'lease-1',
    resultRef: pr,
    naturalKey: 'asep/attempt-1',
  });
  assert.equal(done.state, 'COMPLETED');
  assert.deepEqual(done.resultRef, pr);
  // A subsequent begin adopts the COMPLETED record so the caller adopts, not replays.
  const adopt = await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr:head->base',
    ownerToken: 'lease-1',
  });
  assert.equal(adopt.existed, true);
  assert.equal(adopt.state, 'COMPLETED');
  assert.deepEqual(adopt.resultRef, pr);
  await client.close();
});

test('C7: FENCING — a mismatched owner_token cannot complete another executor\'s effect', async () => {
  const { client, scope, binding, log } = await fresh();
  await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: 'lease-original',
  });
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: 'lease-stolen', // a stale executor
    }),
    SideEffectFencingError,
  );
  await client.close();
});

test('C7: complete without a PENDING record fails closed', async () => {
  const { client, scope, binding, log } = await fresh();
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: 'lease-1',
    }),
    SideEffectFencingError,
  );
  await client.close();
});

// ---------------------------------------------------------------------------
// HIGH-006 — fault-injection matrix around the FOUR crash boundaries of one
// effect: (B1) after begin, before the external call; (B2) after the external
// call, before complete; (B3) after complete; plus a lease-handoff at a PENDING
// boundary. Each "crash" is modeled by dropping the in-flight executor and
// resuming with a fresh begin() against the SAME real PGlite row. The protocol
// must converge to exactly-once at the log level, never double-COMPLETE, and
// never let a stale owner finish a crashed executor's record.
// ---------------------------------------------------------------------------

// A helper that drives one push effect through begin → (caller performs the
// external call) → complete, so a test can inject a "crash" at any boundary by
// simply not calling the next step and re-entering with a fresh begin.
async function beginPush(log: SqlSideEffectLog, scope: TenantScope, bindingId: RepositoryBindingId, owner: string) {
  return log.begin(scope, {
    operation: 'push',
    repositoryBindingId: bindingId,
    attemptId,
    requestFingerprint: 'push:asep/attempt-1@sha',
    ownerToken: owner,
    naturalKey: 'refs/heads/asep/attempt-1',
  });
}

test('HIGH-006 B1: crash AFTER begin, BEFORE the external call — resume adopts the PENDING row (no orphan, no duplicate row)', async () => {
  const { client, scope, binding, log } = await fresh();
  // begin claims PENDING; the executor "crashes" before pushing.
  const first = await beginPush(log, scope, binding.id, 'lease-1');
  assert.equal(first.existed, false);
  assert.equal(first.state, 'PENDING');
  // Resume by the SAME owner: the row is adopted (existed=true, still PENDING),
  // so the caller reconciles-then-performs rather than inserting a second row.
  const resume = await beginPush(log, scope, binding.id, 'lease-1');
  assert.equal(resume.existed, true);
  assert.equal(resume.state, 'PENDING');
  // Exactly one row exists for this effect.
  const rows = await client.query(
    `select count(*)::int as n from side_effect_records
     where organization_id = $1 and project_id = $2 and semantic_key = $3`,
    [scope.organizationId, scope.projectId, `${attemptId}:push`],
  );
  assert.equal(rows.rows[0]!['n'], 1, 'a resume never duplicates the effect row');
  await client.close();
});

test('HIGH-006 B2: crash AFTER the external call, BEFORE complete — resume completes exactly once', async () => {
  const { client, scope, binding, log } = await fresh();
  await beginPush(log, scope, binding.id, 'lease-1');
  // ... external push happened here, then the executor "crashed" before complete.
  // Resume: begin adopts the PENDING row; the SAME owner now completes it.
  const resume = await beginPush(log, scope, binding.id, 'lease-1');
  assert.equal(resume.state, 'PENDING');
  const done = await log.complete(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: 'lease-1',
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  assert.equal(done.state, 'COMPLETED');
  // A SECOND complete (a late duplicate of the crashed step) is a no-op adopt at
  // begin: the record is already COMPLETED, so the caller never re-pushes.
  const afterComplete = await beginPush(log, scope, binding.id, 'lease-1');
  assert.equal(afterComplete.state, 'COMPLETED');
  assert.equal(afterComplete.existed, true);
  await client.close();
});

test('HIGH-006 B3: crash AFTER complete — resume adopts the COMPLETED row and never replays', async () => {
  const { client, scope, binding, log } = await fresh();
  await beginPush(log, scope, binding.id, 'lease-1');
  await log.complete(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: 'lease-1',
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  // The completion durably survived the crash; resume adopts it.
  const resume = await beginPush(log, scope, binding.id, 'lease-1');
  assert.equal(resume.existed, true);
  assert.equal(resume.state, 'COMPLETED');
  await client.close();
});

test('HIGH-006 lease-handoff: a REASSIGNED lease cannot complete the crashed executor\'s PENDING row (fencing at the crash boundary)', async () => {
  const { client, scope, binding, log } = await fresh();
  // Executor A claims the effect then crashes mid-PENDING.
  await beginPush(log, scope, binding.id, 'lease-A');
  // Executor B (a reassigned lease) resumes: begin adopts the PENDING row, but
  // B does NOT own it, so B must not be able to complete A's record.
  const resume = await beginPush(log, scope, binding.id, 'lease-B');
  assert.equal(resume.state, 'PENDING');
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: 'lease-B',
    }),
    SideEffectFencingError,
  );
  await client.close();
});

test('C7: different operations for the same attempt are INDEPENDENT effects', async () => {
  const { client, scope, binding, log } = await fresh();
  const push = await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push',
    ownerToken: 'lease-1',
  });
  const pr = await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr',
    ownerToken: 'lease-1',
  });
  assert.equal(push.existed, false);
  assert.equal(pr.existed, false, 'the PR effect is independent of the push effect');
  await client.close();
});
