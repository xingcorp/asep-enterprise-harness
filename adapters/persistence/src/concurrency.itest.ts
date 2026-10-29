// Multi-connection PostgreSQL concurrency suite (disp. P2-FINAL-MED-001, exit
// criteria C3/C5). Runs against a REAL digest-pinned PostgreSQL through TWO or
// more pg.Pool connections — the semantics PGlite structurally CANNOT prove:
//
//   C3  the partial unique index `one_active_writer` arbitrates a GENUINE
//       two-connection race — exactly one ACTIVE lease wins, the loser is
//       denied — with both acquires issued concurrently via Promise.all against
//       separate pooled connections (not serialized onto one in-process conn).
//   C5  two migrators on SEPARATE connections contend on pg_advisory_lock and
//       converge: each migration applied exactly once, no double-apply, no
//       corruption — proving the ACROSS-SESSION advisory lock, not the
//       in-process JavaScript mutex PGlite falls back to.
//   C4  optimistic-concurrency under real contention: N concurrent updaters at
//       the same version, exactly ONE wins, the rest get a conflict.
//
// This suite is *.itest.ts so it runs ONLY under the integration gate, which
// provisions the backend first (P2-FINAL-HIGH-001). It fails closed (throws) if
// ASEP_PG_URL is unset — it never silently skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PgPoolClient } from './pg-pool-client.js';
import { migrate } from './migrator.js';
import { MIGRATIONS } from './migrations.js';
import { requirePgUrl, makePool, migratedClient } from './itest-support.js';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
} from './repositories.js';
import { SqlWorkspaceLeaseRepository } from './lease-repository.js';
import { SqlSideEffectLog } from './side-effect-log.js';
import { OptimisticConcurrencyError } from './sql.js';
import type { SqlClient, SqlExecutor } from './sql.js';
import { SideEffectFencingError } from '@asep/ports';
import type { TenantScope, AttemptId, RepositoryBindingId } from '@asep/contracts';

console.log('SUITE-ID: asep-suite:pg-concurrency');

// A private, uniquely-named database per test file run would be ideal, but the
// gate hands us one database; we isolate by using fresh ULID-keyed rows per test
// and never asserting global row counts. Migrations are idempotent so applying
// them once up front is safe.
async function seedScope(client: SqlClient): Promise<{
  scope: TenantScope; binding: RepositoryBindingId; newAttempt: () => Promise<AttemptId>;
}> {
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const org = await orgs.create({ name: `org-${Math.random().toString(36).slice(2)}` });
  const proj = await projects.create({ organizationId: org.id, name: `p-${Math.random().toString(36).slice(2)}`, defaultBranch: 'main' });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const binding = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: `r-${Math.random().toString(36).slice(2)}`, defaultBaseBranch: 'main',
  });
  // A lease names a real attempt of its own tenant and binding (FK).
  const newAttempt = async (): Promise<AttemptId> => {
    const run = await new RunRepository(client).create(scope, {
      repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
    });
    const task = await new TaskRepository(client).create(scope, {
      runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
    });
    return (await new AttemptRepository(client).create(scope, { taskId: task.id, repositoryBindingId: binding.id })).id;
  };
  return { scope, binding: binding.id, newAttempt };
}

// ---------------------------------------------------------------------------
// C5 — two migrators on SEPARATE connections converge (real advisory lock).
// ---------------------------------------------------------------------------

test('C5 (multi-conn): two migrators on separate connections converge with no double-apply', async () => {
  // A pristine, isolated database name so migration bookkeeping is not shared
  // with the shared gate DB. We create it via the admin connection then run two
  // independent single-connection pools against it concurrently.
  const admin = new Pool({ connectionString: requirePgUrl(), max: 1 });
  const dbName = `asep_mig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`create database ${dbName}`);
  try {
    const base = new URL(requirePgUrl());
    base.pathname = `/${dbName}`;
    const url = base.toString();

    const poolA = new Pool({ connectionString: url, max: 1 });
    const poolB = new Pool({ connectionString: url, max: 1 });
    try {
      const a = PgPoolClient.fromPool(poolA);
      const b = PgPoolClient.fromPool(poolB);
      // Two migrators, two DISTINCT connections, launched together. The
      // cross-session pg_advisory_lock (not a JS mutex) must serialize them.
      const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
      const totalApplied = ra.applied.length + rb.applied.length;
      assert.equal(totalApplied, MIGRATIONS.length, 'each migration applied exactly once across both connections');
      // schema_migrations holds exactly one row per migration (no double-apply).
      const rows = await a.query('select id from schema_migrations');
      assert.equal(rows.rowCount, MIGRATIONS.length);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  } finally {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  }
});

// ---------------------------------------------------------------------------
// C3 — genuine two-connection ACTIVE-lease race arbitrated by the DB index.
// ---------------------------------------------------------------------------

test('C3 (multi-conn): a genuine two-connection race yields exactly one ACTIVE lease', async () => {
  const setup = await migratedClient();
  try {
    const { scope, binding, newAttempt } = await seedScope(setup.client);
    const [attemptA, attemptB] = [await newAttempt(), await newAttempt()];

    // Two SEPARATE clients (separate pools → separate backends) race to acquire
    // the SAME (binding, branch). The partial unique index — not app logic —
    // must let exactly one win.
    const poolA = makePool(1);
    const poolB = makePool(1);
    try {
      const leasesA = new SqlWorkspaceLeaseRepository(PgPoolClient.fromPool(poolA));
      const leasesB = new SqlWorkspaceLeaseRepository(PgPoolClient.fromPool(poolB));
      const branch = `asep/race-${Math.random().toString(36).slice(2)}`;
      const [ra, rb] = await Promise.all([
        leasesA.acquire(scope, { repositoryBindingId: binding, branch, attemptId: attemptA, ttlMs: 60_000 }),
        leasesB.acquire(scope, { repositoryBindingId: binding, branch, attemptId: attemptB, ttlMs: 60_000 }),
      ]);
      const wins = [ra, rb].filter((r) => 'leaseId' in r).length;
      const denied = [ra, rb].filter((r) => 'denied' in r).length;
      assert.equal(wins, 1, 'exactly one acquire wins the race');
      assert.equal(denied, 1, 'exactly one acquire is denied by the unique index');
    } finally {
      await poolA.end();
      await poolB.end();
    }
  } finally {
    await setup.pool.end();
  }
});

test('C3 (multi-conn): a fleet of N racers still yields exactly one winner', async () => {
  const setup = await migratedClient();
  try {
    const { scope, binding, newAttempt } = await seedScope(setup.client);
    const N = 8;
    const attempts: AttemptId[] = [];
    for (let i = 0; i < N; i++) attempts.push(await newAttempt());
    const pools = Array.from({ length: N }, () => makePool(1));
    try {
      const branch = `asep/fleet-${Math.random().toString(36).slice(2)}`;
      const results = await Promise.all(pools.map((p, i) => {
        const leases = new SqlWorkspaceLeaseRepository(PgPoolClient.fromPool(p));
        return leases.acquire(scope, { repositoryBindingId: binding, branch, attemptId: attempts[i]!, ttlMs: 60_000 });
      }));
      const wins = results.filter((r) => 'leaseId' in r).length;
      assert.equal(wins, 1, `exactly one of ${N} concurrent racers wins`);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  } finally {
    await setup.pool.end();
  }
});

// ---------------------------------------------------------------------------
// C4 — optimistic concurrency under real contention.
// ---------------------------------------------------------------------------

test('C4 (multi-conn): N concurrent version-0 updates → exactly one wins, rest conflict', async () => {
  const setup = await migratedClient();
  try {
    const { scope, binding } = await seedScope(setup.client);
    const runs = new RunRepository(setup.client);
    const tasks = new TaskRepository(setup.client);
    const run = await runs.create(scope, { repositoryBindingId: binding, status: 'EXECUTING', risk: 'R0' });
    const task = await tasks.create(scope, { runId: run.id, repositoryBindingId: binding, risk: 'R0' });

    const N = 6;
    const pools = Array.from({ length: N }, () => makePool(1));
    try {
      const outcomes = await Promise.allSettled(pools.map((p) => {
        const repo = new TaskRepository(PgPoolClient.fromPool(p));
        return repo.updateStatus(scope, task.id, 0, 'READY');
      }));
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').length;
      const conflicts = outcomes.filter(
        (o) => o.status === 'rejected' && (o as PromiseRejectedResult).reason instanceof OptimisticConcurrencyError,
      ).length;
      assert.equal(fulfilled, 1, 'exactly one version-0 update wins');
      assert.equal(conflicts, N - 1, 'every other updater sees an optimistic-concurrency conflict');
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  } finally {
    await setup.pool.end();
  }
});

// ---------------------------------------------------------------------------
// Lease liveness at the decision, across connections. Connection A opens a
// transaction while its lease is live and waits past the expiry; connection B
// is granted the successor lease meanwhile. A's late completion is then
// refused by the adapter, and its late direct write by the trigger — neither
// may treat the transaction's frozen start time as "now".
// ---------------------------------------------------------------------------

test('C3 (multi-conn): a transaction opened while its lease was live cannot act on it after it expired', async () => {
  const setup = await migratedClient();
  const poolA = makePool(1);
  const poolB = makePool(1);
  try {
    const { scope, binding, newAttempt } = await seedScope(setup.client);
    const attemptId = await newAttempt();
    const branch = `asep/clock-${Math.random().toString(36).slice(2)}`;
    const a = PgPoolClient.fromPool(poolA);
    const b = PgPoolClient.fromPool(poolB);
    const lease = await new SqlWorkspaceLeaseRepository(a).acquire(scope, {
      repositoryBindingId: binding, branch, attemptId, ttlMs: 500,
    });
    assert.ok('leaseId' in lease);
    const key = { operation: 'push' as const, repositoryBindingId: binding, attemptId };
    await new SqlSideEffectLog(a).begin(scope, { ...key, requestFingerprint: 'push:x', ownerToken: lease.leaseId });
    const pushed = { kind: 'push' as const, branch, commitSha: 'a'.repeat(40) };
    const inside = (tx: SqlExecutor): SqlClient => ({
      query: (t, p) => tx.query(t, p), transaction: (fn) => fn(tx), ping: () => a.ping(), close: async () => undefined,
    });

    for (const how of ['adapter', 'trigger'] as const) {
      await assert.rejects(
        a.transaction(async (tx) => {
          await tx.query('select 1', []);
          await new Promise((r) => setTimeout(r, 1_000));
          if (how === 'adapter') {
            await new SqlSideEffectLog(inside(tx)).complete(scope, { ...key, ownerToken: lease.leaseId, resultRef: pushed });
          } else {
            await tx.query(
              `update side_effect_records set state = 'COMPLETED', result_ref = $1 where attempt_id = $2 and operation = 'push'`,
              [JSON.stringify(pushed), attemptId],
            );
          }
        }),
        how === 'adapter' ? SideEffectFencingError : /not live/,
        `the ${how} accepted a write under an expired lease`,
      );
    }
    // The successor, on the other connection, is granted and takes the record over.
    const successor = await new SqlWorkspaceLeaseRepository(b).acquire(scope, {
      repositoryBindingId: binding, branch, attemptId, ttlMs: 60_000,
    });
    assert.ok('leaseId' in successor);
    const taken = await new SqlSideEffectLog(b).begin(scope, { ...key, requestFingerprint: 'push:x', ownerToken: successor.leaseId });
    assert.equal(taken.takenOver, true);
  } finally {
    await poolA.end();
    await poolB.end();
    await setup.pool.end();
  }
});

// The trigger reads the owner lease under a share lock, as the adapter does. A
// transaction that has just written a record under a live lease therefore holds
// that lease row until it ends, and a successor's sweep of the lease waits for
// it instead of expiring the lease under a decision already taken.
test('C3 (multi-conn): a successor sweep waits for a transaction that wrote under the lease', async () => {
  const setup = await migratedClient();
  const poolA = makePool(1);
  const poolB = makePool(1);
  try {
    const { scope, binding, newAttempt } = await seedScope(setup.client);
    const attemptId = await newAttempt();
    const branch = `asep/sweep-${Math.random().toString(36).slice(2)}`;
    const a = PgPoolClient.fromPool(poolA);
    const b = PgPoolClient.fromPool(poolB);
    const lease = await new SqlWorkspaceLeaseRepository(a).acquire(scope, {
      repositoryBindingId: binding, branch, attemptId, ttlMs: 700,
    });
    assert.ok('leaseId' in lease);
    const key = { operation: 'push' as const, repositoryBindingId: binding, attemptId };
    await new SqlSideEffectLog(a).begin(scope, { ...key, requestFingerprint: 'push:x', ownerToken: lease.leaseId });
    let committedAt = 0;
    const writer = a.transaction(async (tx) => {
      // A direct write, so only the trigger's lock is in play.
      await tx.query(`update side_effect_records set natural_key = 'k' where attempt_id = $1 and operation = 'push'`, [attemptId]);
      await new Promise((r) => setTimeout(r, 1_500));
      committedAt = Date.now();
    });
    await new Promise((r) => setTimeout(r, 1_000));
    const successor = await new SqlWorkspaceLeaseRepository(b).acquire(scope, {
      repositoryBindingId: binding, branch, attemptId, ttlMs: 60_000,
    });
    const grantedAt = Date.now();
    await writer;
    assert.ok('leaseId' in successor);
    assert.ok(committedAt > 0 && grantedAt >= committedAt,
      `the successor was granted ${committedAt - grantedAt}ms before the writer's transaction ended`);
  } finally {
    await poolA.end();
    await poolB.end();
    await setup.pool.end();
  }
});
