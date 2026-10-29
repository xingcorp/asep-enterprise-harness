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
  RunRepository, TaskRepository, AttemptRepository,
} from './repositories.js';
import { SqlSideEffectLog } from './side-effect-log.js';
import { SqlWorkspaceLeaseRepository } from './lease-repository.js';
import { SideEffectFingerprintError, SideEffectFencingError, LeaseLostError } from '@asep/ports';
import type { Lease } from '@asep/ports';
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
  // Every side-effect record belongs to a real attempt (migration 0013 binds it
  // to the attempt AND that attempt's binding), so the fixture builds the chain.
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
  const log = new SqlSideEffectLog(client);
  // Ownership is a LEASE (migration 0014): every record is written under a live
  // workspace lease of its attempt, so the fixture holds one.
  const leases = new SqlWorkspaceLeaseRepository(client);
  const granted = await leases.acquire(scope, {
    repositoryBindingId: binding.id, branch: BRANCH, attemptId, ttlMs: 60_000,
  });
  if ('denied' in granted) throw new Error('fixture lease was denied');
  const owner = granted.leaseId;
  return {
    client, scope, binding, log, attemptId, runId: run.id, taskId: task.id,
    leases, lease: granted, owner,
  };
}

const BRANCH = 'asep/attempt-1';

// The closed outcome of the push the tests below record.
const PUSHED = { kind: 'push' as const, branch: 'asep/attempt-1', commitSha: 'a'.repeat(40) };

test('C7: begin claims a fresh PENDING record (existed=false)', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  const rec = await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: owner,
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  assert.equal(rec.existed, false);
  assert.equal(rec.state, 'PENDING');
  await client.close();
});

test('C7: a second begin for the SAME effect ADOPTS the record (existed=true) — no duplicate', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  const input = {
    operation: 'push' as const,
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: owner,
  };
  await log.begin(scope, input);
  const second = await log.begin(scope, input);
  assert.equal(second.existed, true, 'the retry adopts the existing PENDING record');
  await client.close();
});

test('C7: reusing a key with a DIFFERENT fingerprint FAILS CLOSED', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha1',
    ownerToken: owner,
  });
  await assert.rejects(
    () => log.begin(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      requestFingerprint: 'push:branch@sha2', // different commit → different effect
      ownerToken: owner,
    }),
    SideEffectFingerprintError,
  );
  await client.close();
});

test('C7: complete persists result_ref + natural_key and marks COMPLETED', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr:head->base',
    ownerToken: owner,
  });
  const pr = {
    kind: 'pr-upsert' as const, number: 42, url: 'https://github.com/acme/web/pull/42',
    headBranch: 'asep/attempt-1', baseBranch: 'main',
  };
  const done = await log.complete(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: owner,
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
    ownerToken: owner,
  });
  assert.equal(adopt.existed, true);
  assert.equal(adopt.state, 'COMPLETED');
  assert.deepEqual(adopt.resultRef, pr);
  await client.close();
});

test('C7: FENCING — a mismatched owner_token cannot complete another executor\'s effect', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: owner,
  });
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      resultRef: PUSHED,
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: 'lease-stolen', // a stale executor
    }),
    SideEffectFencingError,
  );
  await client.close();
});

test('C7: complete without a PENDING record fails closed', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      resultRef: PUSHED,
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: owner,
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
async function beginPush(
  log: SqlSideEffectLog, scope: TenantScope, bindingId: RepositoryBindingId, attemptId: AttemptId, owner: string,
) {
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
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  // begin claims PENDING; the executor "crashes" before pushing.
  const first = await beginPush(log, scope, binding.id, attemptId, owner);
  assert.equal(first.existed, false);
  assert.equal(first.state, 'PENDING');
  // Resume by the SAME owner: the row is adopted (existed=true, still PENDING),
  // so the caller reconciles-then-performs rather than inserting a second row.
  const resume = await beginPush(log, scope, binding.id, attemptId, owner);
  assert.equal(resume.existed, true);
  assert.equal(resume.state, 'PENDING');
  // Exactly one row exists for this effect.
  const rows = await client.query(
    `select count(*)::int as n from side_effect_records
     where organization_id = $1 and project_id = $2 and attempt_id = $3 and operation = 'push'`,
    [scope.organizationId, scope.projectId, attemptId],
  );
  assert.equal(rows.rows[0]!['n'], 1, 'a resume never duplicates the effect row');
  await client.close();
});

test('HIGH-006 B2: crash AFTER the external call, BEFORE complete — resume completes exactly once', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await beginPush(log, scope, binding.id, attemptId, owner);
  // ... external push happened here, then the executor "crashed" before complete.
  // Resume: begin adopts the PENDING row; the SAME owner now completes it.
  const resume = await beginPush(log, scope, binding.id, attemptId, owner);
  assert.equal(resume.state, 'PENDING');
  const done = await log.complete(scope, {
    operation: 'push',
    resultRef: PUSHED,
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: owner,
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  assert.equal(done.state, 'COMPLETED');
  // A SECOND complete (a late duplicate of the crashed step) is a no-op adopt at
  // begin: the record is already COMPLETED, so the caller never re-pushes.
  const afterComplete = await beginPush(log, scope, binding.id, attemptId, owner);
  assert.equal(afterComplete.state, 'COMPLETED');
  assert.equal(afterComplete.existed, true);
  await client.close();
});

test('HIGH-006 B3: crash AFTER complete — resume adopts the COMPLETED row and never replays', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await beginPush(log, scope, binding.id, attemptId, owner);
  await log.complete(scope, {
    operation: 'push',
    resultRef: PUSHED,
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: owner,
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  // The completion durably survived the crash; resume adopts it.
  const resume = await beginPush(log, scope, binding.id, attemptId, owner);
  assert.equal(resume.existed, true);
  assert.equal(resume.state, 'COMPLETED');
  await client.close();
});

// ---------------------------------------------------------------------------
// Fenced takeover. A crashed executor leaves its record PENDING under a lease
// that will never heartbeat again. Its successor must be able to take the
// record over — otherwise recovery wedges — but only once the old lease is dead,
// only with a strictly newer epoch on the same branch, and the dead owner must
// be refused for good afterwards.
// ---------------------------------------------------------------------------

// A second lease for the same attempt, once the fixture's lease is dead.
async function successor(fx: Awaited<ReturnType<typeof fresh>>, branch = BRANCH): Promise<Lease> {
  const next = await fx.leases.acquire(fx.scope, {
    repositoryBindingId: fx.binding.id, branch, attemptId: fx.attemptId, ttlMs: 60_000,
  });
  if ('denied' in next) throw new Error(`successor lease denied: ${next.reason}`);
  return next;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Crafted lease ids for the epoch-ordering test (acquire never mints these).
const HIGH_LEASE = 'H'.repeat(26);
const LOW_LEASE = 'K'.repeat(26);

test('a live owner cannot be taken over, even by another live lease of the same attempt', async () => {
  const fx = await fresh();
  await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, fx.owner);
  // The one-active-writer index already refuses a second lease on the branch…
  const denied = await fx.leases.acquire(fx.scope, {
    repositoryBindingId: fx.binding.id, branch: BRANCH, attemptId: fx.attemptId, ttlMs: 60_000,
  });
  assert.equal('denied' in denied, true, 'one active writer per (binding, branch)');
  // …and the log refuses on its own: a live lease elsewhere cannot steal the row.
  const elsewhere = await successor(fx, 'asep/attempt-1-other');
  await assert.rejects(
    () => beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, elsewhere.leaseId),
    (err: unknown) => err instanceof SideEffectFencingError && /owned by live lease/.test(err.message),
  );
  await fx.client.close();
});

test('after the owner lease EXPIRES, a newer lease takes the PENDING record over and finishes it', async () => {
  const fx = await fresh();
  // A short-lived lease stands in for an executor that stops heartbeating.
  await fx.leases.release(fx.scope, fx.owner);
  const short = await fx.leases.acquire(fx.scope, {
    repositoryBindingId: fx.binding.id, branch: BRANCH, attemptId: fx.attemptId, ttlMs: 150,
  });
  if ('denied' in short) throw new Error('short lease denied');
  const first = await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, short.leaseId);
  assert.equal(first.ownerEpoch, short.fencingEpoch);
  await sleep(250);
  // The executor never heartbeats again. Its lease is dead; the next acquire
  // sweeps it and is granted the next epoch.
  await assert.rejects(() => fx.leases.heartbeat(fx.scope, short.leaseId), LeaseLostError);
  const next = await successor(fx);
  assert.equal(next.fencingEpoch, short.fencingEpoch + 1, 'epochs increase per (binding, branch)');

  const resumed = await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, next.leaseId);
  assert.equal(resumed.existed, true);
  assert.equal(resumed.state, 'PENDING');
  assert.equal(resumed.takenOver, true, 'the caller is told to reconcile before acting');
  assert.equal(resumed.ownerToken, next.leaseId);
  assert.equal(resumed.ownerEpoch, next.fencingEpoch);
  const done = await fx.log.complete(fx.scope, {
    operation: 'push', resultRef: PUSHED, repositoryBindingId: fx.binding.id,
    attemptId: fx.attemptId, ownerToken: next.leaseId,
  });
  assert.equal(done.state, 'COMPLETED');
  await fx.client.close();
});

test('after the owner lease is RELEASED, the successor takes over and the old owner is refused for good', async () => {
  const fx = await fresh();
  await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, fx.owner);
  // Revocation: the old lease leaves ACTIVE without finishing its record.
  await fx.leases.release(fx.scope, fx.owner);
  const next = await successor(fx);
  const resumed = await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, next.leaseId);
  assert.equal(resumed.takenOver, true);

  // The stale owner can neither finish, fail, nor re-claim the record…
  await assert.rejects(
    () => fx.log.complete(fx.scope, {
      operation: 'push', resultRef: PUSHED, repositoryBindingId: fx.binding.id,
      attemptId: fx.attemptId, ownerToken: fx.owner,
    }),
    (err: unknown) => err instanceof SideEffectFencingError && /different lease/.test(err.message),
  );
  await assert.rejects(
    () => fx.log.fail(fx.scope, {
      operation: 'push', repositoryBindingId: fx.binding.id, attemptId: fx.attemptId, ownerToken: fx.owner,
    }),
    SideEffectFencingError,
  );
  await assert.rejects(
    () => beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, fx.owner),
    (err: unknown) => err instanceof SideEffectFencingError && /not a live lease/.test(err.message),
  );
  // …and its lease cannot be revived to try again.
  await assert.rejects(() => fx.leases.heartbeat(fx.scope, fx.owner), LeaseLostError);
  await assert.rejects(
    () => fx.client.query(`update workspace_leases set state = 'ACTIVE' where id = $1`, [fx.owner]),
    /can never become ACTIVE again/,
  );

  // The successor finishes exactly once, and nothing rewrites the outcome.
  await fx.log.complete(fx.scope, {
    operation: 'push', resultRef: PUSHED, repositoryBindingId: fx.binding.id,
    attemptId: fx.attemptId, ownerToken: next.leaseId,
  });
  await assert.rejects(
    () => fx.log.complete(fx.scope, {
      operation: 'push', resultRef: { ...PUSHED, commitSha: 'c'.repeat(40) },
      repositoryBindingId: fx.binding.id, attemptId: fx.attemptId, ownerToken: next.leaseId,
    }),
    (err: unknown) => err instanceof SideEffectFencingError && /already COMPLETED/.test(err.message),
  );
  const record = await fx.log.find(fx.scope, {
    operation: 'push', repositoryBindingId: fx.binding.id, attemptId: fx.attemptId,
  });
  assert.deepEqual(record?.resultRef, PUSHED);
  await fx.client.close();
});

test('an owner whose own lease lapsed cannot finish its record', async () => {
  const fx = await fresh();
  await fx.leases.release(fx.scope, fx.owner);
  const short = await fx.leases.acquire(fx.scope, {
    repositoryBindingId: fx.binding.id, branch: BRANCH, attemptId: fx.attemptId, ttlMs: 150,
  });
  if ('denied' in short) throw new Error('short lease denied');
  await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, short.leaseId);
  await sleep(250);
  await assert.rejects(
    () => fx.log.complete(fx.scope, {
      operation: 'push', resultRef: PUSHED, repositoryBindingId: fx.binding.id,
      attemptId: fx.attemptId, ownerToken: short.leaseId,
    }),
    (err: unknown) => err instanceof SideEffectFencingError && /no longer live/.test(err.message),
  );
  await fx.client.close();
});

test('a takeover needs the same branch and a strictly newer epoch', async () => {
  const fx = await fresh();
  // Owner on another branch of the same attempt, then dead.
  await fx.leases.release(fx.scope, fx.owner);
  const other = await successor(fx, 'asep/attempt-1-other');
  await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, other.leaseId);
  await fx.leases.release(fx.scope, other.leaseId);
  const sameBranchAsFixture = await successor(fx);
  await assert.rejects(
    () => beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, sameBranchAsFixture.leaseId),
    (err: unknown) => err instanceof SideEffectFencingError && /cannot take over a record owned on/.test(err.message),
  );

  // A live lease whose epoch is NOT newer than the dead owner's. Acquire never
  // produces one; a crafted row is how the rule is exercised.
  await fx.leases.release(fx.scope, sameBranchAsFixture.leaseId);
  const high = await fx.client.query(
    `insert into workspace_leases
       (id, organization_id, project_id, repository_binding_id, branch, attempt_id, workspace_id,
        state, expires_at, ttl_ms, fencing_epoch)
     values ($5, $1, $2, $3, 'asep/attempt-1-other', $4, 'ws', 'ACTIVE',
             now() + interval '1 minute', 60000, 9)
     returning id`,
    [fx.scope.organizationId, fx.scope.projectId, fx.binding.id, fx.attemptId, HIGH_LEASE] as never,
  );
  assert.equal(high.rowCount, 1);
  const moved = await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, HIGH_LEASE);
  assert.equal(moved.takenOver, true);
  assert.equal(moved.ownerEpoch, 9);
  await fx.leases.release(fx.scope, HIGH_LEASE);
  await fx.client.query(
    `insert into workspace_leases
       (id, organization_id, project_id, repository_binding_id, branch, attempt_id, workspace_id,
        state, expires_at, ttl_ms, fencing_epoch)
     values ($5, $1, $2, $3, 'asep/attempt-1-other', $4, 'ws', 'ACTIVE',
             now() + interval '1 minute', 60000, 5)`,
    [fx.scope.organizationId, fx.scope.projectId, fx.binding.id, fx.attemptId, LOW_LEASE] as never,
  );
  await assert.rejects(
    () => beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, LOW_LEASE),
    (err: unknown) => err instanceof SideEffectFencingError && /is not newer than owner epoch 9/.test(err.message),
  );
  await fx.client.close();
});

test('the database refuses an ownership move the protocol forbids, whoever writes it', async () => {
  const fx = await fresh();
  await beginPush(fx.log, fx.scope, fx.binding.id, fx.attemptId, fx.owner);
  const moveTo = (lease: Lease) => fx.client.query(
    `update side_effect_records set owner_lease_id = $1, owner_epoch = $2
     where attempt_id = $3 and operation = 'push'`,
    [lease.leaseId, lease.fencingEpoch, fx.attemptId] as never,
  );
  // The owner is live: no raw UPDATE may move the record.
  const elsewhere = await successor(fx, 'asep/attempt-1-other');
  await assert.rejects(() => moveTo(elsewhere), /takeover refused/);
  // A record can never be created under a dead lease.
  await fx.leases.release(fx.scope, elsewhere.leaseId);
  await assert.rejects(
    () => fx.client.query(
      `insert into side_effect_records
         (id, organization_id, project_id, repository_binding_id, attempt_id, operation,
          request_fingerprint, state, owner_lease_id, owner_epoch)
       values ('DDDDDDDDDDDDDDDDDDDDDDDDDD', $1, $2, $3, $4, 'commit', 'fp', 'PENDING', $5, $6)`,
      [fx.scope.organizationId, fx.scope.projectId, fx.binding.id, fx.attemptId,
        elsewhere.leaseId, elsewhere.fencingEpoch] as never,
    ),
    /not live/,
  );
  // An owner epoch that is not the lease's own epoch has no lease to point at.
  await assert.rejects(
    () => fx.client.query(
      `update side_effect_records set owner_epoch = owner_epoch + 1 where attempt_id = $1`,
      [fx.attemptId] as never,
    ),
    /foreign key|violates|immutable/i,
  );
  // A COMPLETED record is frozen.
  await fx.log.complete(fx.scope, {
    operation: 'push', resultRef: PUSHED, repositoryBindingId: fx.binding.id,
    attemptId: fx.attemptId, ownerToken: fx.owner,
  });
  await assert.rejects(
    () => fx.client.query(
      `update side_effect_records set result_ref = $1 where attempt_id = $2`,
      [JSON.stringify({ ...PUSHED, commitSha: 'd'.repeat(40) }), fx.attemptId] as never,
    ),
    /COMPLETED and immutable/,
  );
  await fx.client.close();
});

test('C7: different operations for the same attempt are INDEPENDENT effects', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  const push = await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push',
    ownerToken: owner,
  });
  const pr = await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr',
    ownerToken: owner,
  });
  assert.equal(push.existed, false);
  assert.equal(pr.existed, false, 'the PR effect is independent of the push effect');
  await client.close();
});

// ---------------------------------------------------------------------------
// HIGH-005 (migration 0012) — the effect's repository binding is DB-scoped.
//
// `scope` was a bare text column holding a binding id with no foreign key, so a
// side-effect row could name a binding belonging to ANOTHER tenant (or one that
// does not exist at all) and the database would accept it. The authoritative
// crash-recovery record must not be able to point outside its own scope, so 0012
// adds `repository_binding_id` with the composite FK
// (repository_binding_id, organization_id, project_id) -> repository_bindings.
// This proves the constraint is enforced by the DB, not by a row filter.
// ---------------------------------------------------------------------------

test('HIGH-005: a side effect naming a binding from another project is rejected by the DB', async () => {
  const { client, scope, log, attemptId, owner, lease } = await fresh();
  // A second tenant with its OWN binding.
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const org2 = await orgs.create({ name: 'Other' });
  const proj2 = await projects.create({
    organizationId: org2.id, name: 'other', defaultBranch: 'main',
  });
  const scope2: TenantScope = { organizationId: org2.id, projectId: proj2.id };
  const foreign = await bindings.create(scope2, {
    githubHost: 'github.com', githubOwner: 'other', githubRepo: 'repo',
    defaultBaseBranch: 'main',
  });

  // Claiming tenant A's scope while naming tenant B's binding must be refused by
  // the composite FK — there is no (bindingB, orgA, projA) row in bindings. The
  // adapter refuses first (the owner lease is not a lease of that binding); the
  // raw row proves the database refuses it on its own.
  await assert.rejects(
    () => log.begin(scope, {
      operation: 'push',
      repositoryBindingId: foreign.id,
      attemptId,
      requestFingerprint: 'push:branch@sha',
      ownerToken: owner,
    }),
    /foreign key|violates|not a live lease/i,
  );
  await assert.rejects(
    () => rawInsert(client, scope, lease, { binding: foreign.id, attempt: attemptId, operation: 'push' }),
    /foreign key|violates/i,
  );
  await client.close();
});

test('HIGH-005: a side effect naming a NON-EXISTENT binding is rejected by the DB', async () => {
  const { client, scope, log, attemptId, owner, lease } = await fresh();
  await assert.rejects(
    () => log.begin(scope, {
      operation: 'commit',
      repositoryBindingId: 'Z'.repeat(26) as RepositoryBindingId,
      attemptId,
      requestFingerprint: 'commit:attempt-1',
      ownerToken: owner,
    }),
    /foreign key|violates|not a live lease/i,
  );
  await assert.rejects(
    () => rawInsert(client, scope, lease, { binding: 'Z'.repeat(26), attempt: attemptId, operation: 'commit' }),
    /foreign key|violates/i,
  );
  await client.close();
});

// ---------------------------------------------------------------------------
// Typed identity and closed outcome: the record is DB-coherent and its
// outcome is a CLOSED shape. Each property is checked with RAW SQL as well as
// through the adapter, because the point is that the database refuses the bad
// row no matter who writes it.
// ---------------------------------------------------------------------------

const SHA = 'b'.repeat(40);
let rawRowSeq = 0;

async function rawInsert(
  client: PgliteClient,
  scope: TenantScope,
  owner: Lease,
  row: { binding: string | null; attempt: string; operation: string; state?: string; result?: unknown },
) {
  return client.query(
    `insert into side_effect_records
       (id, organization_id, project_id, repository_binding_id, attempt_id, operation,
        request_fingerprint, state, owner_lease_id, owner_epoch, result_ref)
     values ($1, $2, $3, $4, $5, $6, 'fp', $7, $8, $9, $10)`,
    [
      `S${String(++rawRowSeq).padStart(25, '0')}`, scope.organizationId, scope.projectId,
      row.binding, row.attempt, row.operation, row.state ?? 'PENDING',
      owner.leaseId, owner.fencingEpoch,
      row.result === undefined ? null : JSON.stringify(row.result),
    ] as never,
  );
}

test('the text identity columns are gone and the binding is NOT NULL', async () => {
  const { client } = await fresh();
  const cols = await client.query(
    `select column_name, is_nullable from information_schema.columns
     where table_name = 'side_effect_records'`,
    [] as never,
  );
  const byName = new Map(cols.rows.map((r) => [r['column_name'] as string, r['is_nullable'] as string]));
  assert.equal(byName.has('scope'), false, 'the text `scope` key must not exist');
  assert.equal(byName.has('semantic_key'), false, 'the text `semantic_key` must not exist');
  assert.equal(byName.get('repository_binding_id'), 'NO');
  assert.equal(byName.get('attempt_id'), 'NO');
  assert.equal(byName.get('operation'), 'NO');
  await client.close();
});

test('the DB refuses a side-effect row with no repository binding', async () => {
  const { client, scope, attemptId, lease } = await fresh();
  await assert.rejects(
    () => rawInsert(client, scope, lease, { binding: null, attempt: attemptId, operation: 'push' }),
    /null value|not-null|violates/i,
  );
  await client.close();
});

test('the DB refuses a record whose binding is not its attempt\'s binding', async () => {
  const { client, scope, attemptId, log, owner, lease } = await fresh();
  // A second binding in the SAME project: tenant-scoped, but not this attempt's.
  const other = await new RepositoryBindingRepository(client).create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'api', defaultBaseBranch: 'main',
  });
  await assert.rejects(
    () => rawInsert(client, scope, lease, { binding: other.id, attempt: attemptId, operation: 'push' }),
    /foreign key|violates/i,
  );
  await assert.rejects(
    () => log.begin(scope, {
      operation: 'push', repositoryBindingId: other.id, attemptId,
      requestFingerprint: 'push:x@y', ownerToken: owner,
    }),
    /foreign key|violates|not a live lease/i,
  );
  await client.close();
});

test('the DB refuses a second row for the same (binding, attempt, operation)', async () => {
  const { client, scope, binding, attemptId, lease } = await fresh();
  await rawInsert(client, scope, lease, { binding: binding.id, attempt: attemptId, operation: 'commit' });
  await assert.rejects(
    () => rawInsert(client, scope, lease, { binding: binding.id, attempt: attemptId, operation: 'commit' }),
    /unique|duplicate|violates/i,
  );
  // An unknown operation is not a side effect at all.
  await assert.rejects(
    () => rawInsert(client, scope, lease, { binding: binding.id, attempt: attemptId, operation: 'merge' }),
    /check|violates/i,
  );
  await client.close();
});

test('the DB refuses any outcome that is not the operation\'s closed shape', async () => {
  const { client, scope, binding, attemptId, lease } = await fresh();
  const evidenceId = '01J0000000000000000000000E';
  const bad: ReadonlyArray<readonly [string, string, unknown]> = [
    ['free-form object', 'commit', { anything: 1 }],
    ['missing kind', 'commit', { commitSha: SHA, evidenceId }],
    ['wrong kind', 'commit', { kind: 'pr-upsert', commitSha: SHA, evidenceId }],
    ['extra key', 'commit', { kind: 'commit', commitSha: SHA, evidenceId, note: 'x' }],
    ['short sha', 'commit', { kind: 'commit', commitSha: 'abc', evidenceId }],
    ['evidence id not a ULID', 'commit', { kind: 'commit', commitSha: SHA, evidenceId: 'ev-1' }],
    ['push without commit', 'push', { kind: 'push', branch: 'asep/x' }],
    ['pr number as string', 'pr-upsert', { kind: 'pr-upsert', number: '7', url: 'https://g/p/7', headBranch: 'h', baseBranch: 'b' }],
    ['pr url not http', 'pr-upsert', { kind: 'pr-upsert', number: 7, url: 'ext::sh', headBranch: 'h', baseBranch: 'b' }],
    ['array', 'push', ['push']],
    ['null outcome on COMPLETED', 'push', null],
  ];
  for (const [label, operation, result] of bad) {
    await assert.rejects(
      () => rawInsert(client, scope, lease, {
        binding: binding.id, attempt: attemptId, operation, state: 'COMPLETED',
        result: result === null ? undefined : result,
      }),
      /check|violates|asep_side_effect_result_valid/i,
      `${label}: the database must refuse this outcome`,
    );
  }
  // A PENDING record carries no outcome at all.
  await assert.rejects(
    () => rawInsert(client, scope, lease, {
      binding: binding.id, attempt: attemptId, operation: 'push', state: 'PENDING',
      result: { kind: 'push', branch: 'asep/x', commitSha: SHA },
    }),
    /check|violates/i,
  );
  // And the well-formed shape is accepted.
  await rawInsert(client, scope, lease, {
    binding: binding.id, attempt: attemptId, operation: 'commit', state: 'COMPLETED',
    result: { kind: 'commit', commitSha: SHA, evidenceId },
  });
  await client.close();
});

test('complete() validates the outcome before writing and leaves the record PENDING', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  await log.begin(scope, {
    operation: 'commit', repositoryBindingId: binding.id, attemptId,
    requestFingerprint: `commit:${attemptId}`, ownerToken: owner,
  });
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'commit', repositoryBindingId: binding.id, attemptId, ownerToken: owner,
      resultRef: { commitSha: SHA, evidenceId: 'x' } as never,
    }),
    (err: unknown) => (err as { name?: string })?.name === 'SideEffectResultRefError',
  );
  const again = await log.begin(scope, {
    operation: 'commit', repositoryBindingId: binding.id, attemptId,
    requestFingerprint: `commit:${attemptId}`, ownerToken: owner,
  });
  assert.equal(again.state, 'PENDING', 'a refused completion writes nothing');
  assert.equal(again.resultRef, undefined);
  await client.close();
});

test('a COMPLETED outcome is read back already parsed into its closed shape', async () => {
  const { client, scope, binding, log, attemptId, owner } = await fresh();
  const input = {
    operation: 'commit' as const, repositoryBindingId: binding.id, attemptId,
    requestFingerprint: `commit:${attemptId}`, ownerToken: owner,
  };
  await log.begin(scope, input);
  const evidenceId = '01J0000000000000000000000E';
  await log.complete(scope, {
    operation: 'commit', repositoryBindingId: binding.id, attemptId, ownerToken: owner,
    resultRef: { kind: 'commit', commitSha: SHA, evidenceId },
  });
  const adopted = await log.begin(scope, input);
  assert.deepEqual(adopted.resultRef, { kind: 'commit', commitSha: SHA, evidenceId });
  await client.close();
});
