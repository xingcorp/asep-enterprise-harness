// The orchestration state on real PostgreSQL (digest-pinned, provisioned by the
// integration gate), across separate connections: what PGlite, one in-process
// connection, cannot show.
//
//   - the migration set: forward on a fresh database, a second run applies
//     nothing, two migrators at once apply each migration once, an edited applied
//     migration fails before any later one runs, and the upgrade path from the
//     Phase 2 head with data, through 0107 alone, to 0100–0102 and 0104–0106;
//   - the attempt ordinal: ensureAttempt raced on two connections, and a writer
//     that names no ordinal racing one that does;
//   - the lease primitive: a crash right after the grant is settled through
//     findLease while another attempt is denied; renewal; a claim (a side-effect
//     record or a workspace) refused for a dead or superseded lease, also when the
//     lease is superseded between the claimant's read and its claim, and a
//     supersede that waits for a claim in flight;
//   - takeover: the old holder's complete, fail, confirm and claim refused, raced
//     with the takeover, and the FAILED lifecycle table;
//   - the workspace resolver; the projection, approval, ledger, governance and
//     registry races.
//
// A barrier holds one connection inside its transaction right after a chosen
// statement, while the other connection acts, and lets it go however the
// other side's checks end; the test waits for the other
// connection's server process to be blocked on a lock by asking
// pg_stat_activity, never by a timed guess. Each test seeds its own tenants, since the gate's database is
// shared by every suite; the migration tests use databases of their own.
//
// *.itest.ts: it runs only under the integration gate and fails closed when
// ASEP_PG_URL is unset.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import type { AttemptId, RepositoryBindingId, RunId, TaskId, TenantScope, WorkspaceId } from '@asep/contracts';
import {
  LeaseLostError, SideEffectFencingError, WorkspaceUnavailableError, type Lease, type PushResultRef,
  type SideEffectBeginInput,
} from '@asep/ports';
import { PgPoolClient } from '../pg-pool-client.js';
import { migrate, MigrationChecksumError } from '../migrator.js';
import { MIGRATIONS } from '../migrations.js';
import { makePool, requirePgUrl } from '../itest-support.js';
import {
  AttemptRepository, OrganizationRepository, ProjectRepository, RepositoryBindingRepository, RunRepository,
  TaskRepository,
} from '../repositories.js';
import { SqlWorkspaceLeaseRepository } from '../lease-repository.js';
import { SqlSideEffectLog } from '../side-effect-log.js';
import type { SqlClient, SqlExecutor } from '../sql.js';
import { ulid } from '../ulid.js';
import {
  ApprovalDecisionConflictError, ApprovalRequestClosedError, AttemptIdentityConflictError, BudgetLedgerConflictError,
  ProjectionOwnershipError, RunGovernanceConflictError, SqlApprovalStore, SqlAssuranceWorkspaceResolver,
  SqlAttemptLeaseHistory, SqlAttemptOrdinal, SqlBudgetLedger, SqlProjectionWriter, SqlRunGovernance,
  SqlWorkspaceRegistry, type EnsureAttemptInput, type LedgerEntryInput, type OpenApprovalRequestInput,
  type RecordDecisionInput,
} from './index.js';

console.log('SUITE-ID: asep-suite:pg-orchestration');

// --- fixtures ---------------------------------------------------------------

interface Tenant {
  readonly scope: TenantScope;
  readonly bindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
}

async function seedTenant(db: SqlClient): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const org = await new OrganizationRepository(db).create({ name: `org-${suffix}` });
  const project = await new ProjectRepository(db).create({ organizationId: org.id, name: `p-${suffix}`, defaultBranch: 'main' });
  const scope: TenantScope = { organizationId: org.id, projectId: project.id };
  const binding = await new RepositoryBindingRepository(db).create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: `r-${suffix}`, defaultBaseBranch: 'main',
  });
  const run = await new RunRepository(db).create(scope, { repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0' });
  const task = await new TaskRepository(db).create(scope, { runId: run.id, repositoryBindingId: binding.id, risk: 'R0' });
  return { scope, bindingId: binding.id, runId: run.id, taskId: task.id };
}

async function newTask(db: SqlClient, t: Tenant): Promise<TaskId> {
  return (await new TaskRepository(db).create(t.scope, { runId: t.runId, repositoryBindingId: t.bindingId, risk: 'R0' })).id;
}

async function newAttempt(db: SqlClient, t: Tenant, taskId: TaskId = t.taskId): Promise<AttemptId> {
  return (await new AttemptRepository(db).create(t.scope, { taskId, repositoryBindingId: t.bindingId })).id;
}

const sha40 = (label: string): string => createHash('sha1').update(label).digest('hex');
const HUMAN = `01H${'Z'.repeat(22)}0`;

const initial = (taskId: TaskId, attemptNumber: number, baseSha = sha40('base')): EnsureAttemptInput => ({
  taskId, attemptNumber, kind: 'initial', baseSha, parentAttemptNumber: null, repairOrderRef: null,
});

async function acquire(db: SqlClient, t: Tenant, attemptId: AttemptId, branch = `asep/${attemptId}`): Promise<Lease> {
  const lease = await new SqlWorkspaceLeaseRepository(db).acquire(t.scope, {
    repositoryBindingId: t.bindingId, branch, attemptId, ttlMs: 600_000,
  });
  assert.ok('leaseId' in lease, `lease for ${attemptId} granted`);
  return lease;
}

/** Moves a lease's expiry into the past on the database clock, as time would. */
async function expire(db: SqlClient, leaseId: string): Promise<void> {
  await db.query(`update workspace_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [leaseId]);
}

/** Expires the lease and grants its attempt the next lease on the same branch, which sweeps the old one. */
async function supersede(db: SqlClient, t: Tenant, lease: Lease): Promise<Lease> {
  await expire(db, lease.leaseId);
  const successor = await acquire(db, t, lease.attemptId, lease.branch);
  assert.ok(successor.fencingEpoch > lease.fencingEpoch, 'the successor holds a newer epoch');
  return successor;
}

async function rows(db: SqlClient, sql: string, params: readonly (string | number)[]): Promise<Record<string, unknown>[]> {
  return (await db.query(sql, params)).rows.map((r) => ({ ...r }));
}

/** Two one-connection clients whose connections stay open for the whole test, so a server process id holds. */
async function withTwoConnections<T>(fn: (a: SqlClient, b: SqlClient) => Promise<T>): Promise<T> {
  const poolA = new Pool({ connectionString: requirePgUrl(), max: 1, idleTimeoutMillis: 0 });
  const poolB = new Pool({ connectionString: requirePgUrl(), max: 1, idleTimeoutMillis: 0 });
  try {
    return await fn(PgPoolClient.fromPool(poolA), PgPoolClient.fromPool(poolB));
  } finally {
    await poolA.end();
    await poolB.end();
  }
}

/** The shared, fully migrated database of the gate, with two tenants of this test's own. */
async function withTenants<T>(fn: (db: SqlClient, a: Tenant, b: Tenant) => Promise<T>): Promise<T> {
  const pool = makePool(2);
  try {
    const db = PgPoolClient.fromPool(pool);
    await migrate(db);
    return await fn(db, await seedTenant(db), await seedTenant(db));
  } finally {
    await pool.end();
  }
}

/** A database of the test's own, dropped afterwards; `fn` gets its URL. */
async function withFreshDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: requirePgUrl(), max: 1 });
  const name = `asep_orch_${randomUUID().replace(/-/g, '')}`;
  await admin.query(`create database ${name}`);
  try {
    const url = new URL(requirePgUrl());
    url.pathname = `/${name}`;
    return await fn(url.toString());
  } finally {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}

async function withPool<T>(url: string, max: number, fn: (db: SqlClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max });
  try {
    return await fn(PgPoolClient.fromPool(pool));
  } finally {
    await pool.end();
  }
}

/** Marks a promise's rejection as handled here; whoever awaits it still gets it. */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/**
 * Runs `operation` on `client` and holds its transaction right after the first
 * statement matching `at`; runs `meanwhile`; then lets the transaction go on,
 * however `meanwhile` ended. Returns what `operation` returns.
 */
async function holding<T>(
  client: SqlClient,
  at: (sql: string) => boolean,
  operation: (held: SqlClient) => Promise<T>,
  meanwhile: () => Promise<void>,
): Promise<T> {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let armed = true;
  const hold = (tx: SqlExecutor): SqlExecutor => ({
    query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (armed && at(sql)) {
        armed = false;
        reach();
        await released;
      }
      return result;
    },
  });
  const running = handled(operation({
    query: (sql, params) => client.query(sql, params),
    transaction: (fn) => client.transaction((tx) => fn(hold(tx))),
    ping: () => client.ping(),
    close: () => client.close(),
  }));
  const endedFirst = handled(running.then(() => { throw new Error('the operation ended without reaching the held statement'); }));
  try {
    await Promise.race([reached, endedFirst]);
    await meanwhile();
  } finally {
    release();
  }
  return running;
}

/** The server process behind a one-connection client. */
async function backendPid(client: SqlClient): Promise<number> {
  return Number((await client.query('select pg_backend_pid() as pid', [])).rows[0]!['pid']);
}

/** Resolves once the server process `pid` waits on a lock. */
async function blockedOnLock(observer: SqlClient, pid: number): Promise<void> {
  for (let poll = 0; poll < 400; poll++) {
    const r = await observer.query(
      `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid]);
    if (r.rows.length > 0) return;
    await sleep(25);
  }
  assert.fail(`server process ${pid} never waited on a lock`);
}

/** Whether a promise has settled by the time the event loop has turned. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await sleep(0);
  return settled;
}

// --- migrations ---------------------------------------------------------------

const ids = (migrations: readonly { readonly id: string }[]): string[] => migrations.map((m) => m.id);
const ORCHESTRATION = MIGRATIONS.filter((m) => m.id >= '0100' && m.id < '0107');

test('the full migration set applies forward on a fresh database, and a second run applies nothing', async () => {
  await withFreshDatabase((url) => withPool(url, 2, async (db) => {
    const first = await migrate(db);
    assert.deepEqual(first.applied, ids(MIGRATIONS));
    const again = await migrate(db);
    assert.deepEqual([again.applied, again.skipped], [[], ids(MIGRATIONS)]);
  }));
});

test('two migrators at once on a fresh database apply each migration exactly once', async () => {
  await withFreshDatabase((url) => withPool(url, 1, (a) => withPool(url, 1, async (b) => {
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    assert.deepEqual([...ra.applied, ...rb.applied].sort(), ids(MIGRATIONS));
    const registry = await rows(a, 'select id, count(*) over (partition by id)::int as n from schema_migrations order by id', []);
    assert.deepEqual(registry.map((r) => r['id']), ids(MIGRATIONS));
    assert.ok(registry.every((r) => r['n'] === 1), 'each id recorded once');
  })));
});

test('an edited applied orchestration migration fails the run before any later migration', async () => {
  await withFreshDatabase((url) => withPool(url, 2, async (db) => {
    const throughOrdinal = MIGRATIONS.filter((m) => m.id <= '0102_attempt_ordinal');
    await migrate(db, throughOrdinal);
    const edited = MIGRATIONS.map((m) => (m.id === '0101_workflow_bindings_projection'
      ? { ...m, sql: `${m.sql}\n-- edited after it was applied\n` } : m));
    await assert.rejects(() => migrate(db, edited),
      (err: unknown) => err instanceof MigrationChecksumError && /0101_workflow_bindings_projection/.test(err.message));
    assert.deepEqual((await rows(db, 'select id from schema_migrations order by id', [])).map((r) => r['id']), ids(throughOrdinal));
    assert.deepEqual(await rows(db, `select to_regclass('public.workspaces') is null as absent`, []), [{ absent: true }],
      'no later migration ran');
  }));
});

test('upgrade path: the Phase 2 head with data, then 0107 alone, then 0100–0102 and 0104–0106, each applied once', async () => {
  await withFreshDatabase((url) => withPool(url, 2, async (db) => {
    const phase2 = MIGRATIONS.filter((m) => m.id < '0100');
    assert.equal(phase2[phase2.length - 1]?.id, '0019_command_output_references');
    await migrate(db, phase2);
    const t = await seedTenant(db);
    // Attempts whose ids do not follow the order in which they started.
    const started: Array<[string, string]> = [];
    for (const day of ['2026-10-03', '2026-10-01', '2026-10-02']) {
      const id = ulid();
      await db.query(
        `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status, started_at)
         values ($1, $2, $3, $4, $5, 'STARTED', $6::timestamptz)`,
        [id, t.scope.organizationId, t.scope.projectId, t.taskId, t.bindingId, `${day}T00:00:00Z`],
      );
      started.push([id, day]);
    }

    const withRunEvents = MIGRATIONS.filter((m) => m.id < '0100' || m.id === '0107_run_events');
    assert.deepEqual((await migrate(db, withRunEvents)).applied, ['0107_run_events']);
    assert.deepEqual(ids(ORCHESTRATION), [
      '0100_orchestration_task_status', '0101_workflow_bindings_projection', '0102_attempt_ordinal',
      '0104_workspaces', '0105_approvals', '0106_budget_ledger',
    ]);
    assert.deepEqual((await migrate(db)).applied, ids(ORCHESTRATION), 'the lower ids apply after 0107');
    assert.deepEqual((await migrate(db)).applied, []);

    const registry = await rows(db, 'select id from schema_migrations order by id', []);
    assert.deepEqual(registry.map((r) => r['id']), ids(MIGRATIONS), 'every migration recorded once, in ascending id order');
    const applyOrder = await rows(db, 'select id from schema_migrations order by applied_at, id', []);
    assert.deepEqual(applyOrder.map((r) => r['id']), [...ids(phase2), '0107_run_events', ...ids(ORCHESTRATION)]);

    const numbered = await rows(db, 'select id, attempt_number, attempt_kind from attempts where task_id = $1', [t.taskId]);
    const byId = new Map(numbered.map((r) => [r['id'], [r['attempt_number'], r['attempt_kind']]]));
    assert.deepEqual(started.map(([id]) => byId.get(id)), [[3, 'initial'], [1, 'initial'], [2, 'initial']],
      'numbered in the order they started');
    const next = await new SqlAttemptOrdinal(db).ensureAttempt(t.scope, initial(t.taskId, 4));
    assert.equal(next.created, true);
    assert.equal((await rows(db, 'select attempt_number from attempts where id = $1', [await newAttempt(db, t)]))[0]?.['attempt_number'], 5);
  }));
});

// --- attempt ordinal ------------------------------------------------------------

test('ensureAttempt raced on two connections registers one row; a conflicting identity is refused', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    for (let n = 1; n <= 10; n++) {
      const input = initial(t.taskId, n);
      const results = await Promise.all([
        new SqlAttemptOrdinal(a).ensureAttempt(t.scope, input), new SqlAttemptOrdinal(b).ensureAttempt(t.scope, input),
      ]);
      assert.deepEqual(results.map((r) => r.created).sort(), [false, true], `round ${n}`);
      assert.equal(results[0].attempt.attemptId, results[1].attempt.attemptId, `round ${n}: one row`);
    }
    for (let n = 11; n <= 20; n++) {
      const outcomes = await Promise.allSettled([
        new SqlAttemptOrdinal(a).ensureAttempt(t.scope, initial(t.taskId, n, sha40('one'))),
        new SqlAttemptOrdinal(b).ensureAttempt(t.scope, initial(t.taskId, n, sha40('two'))),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, `round ${n}: one registration wins`);
      const lost = outcomes.find((o) => o.status === 'rejected');
      assert.ok(lost?.status === 'rejected' && lost.reason instanceof AttemptIdentityConflictError, `round ${n}: the other is refused`);
    }
    const stored = await rows(db, 'select count(*)::int as n, count(distinct attempt_number)::int as d from attempts where task_id = $1', [t.taskId]);
    assert.deepEqual(stored, [{ n: 20, d: 20 }]);
  }));
});

test('a writer that names no ordinal waits for an insert in flight and takes the next ordinal', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    await new SqlAttemptOrdinal(db).ensureAttempt(t.scope, initial(t.taskId, 1));
    const bPid = await backendPid(b);
    let legacy: Promise<AttemptId> | undefined;
    const registered = await holding(a, (sql) => sql.includes('insert into attempts'),
      (held) => new SqlAttemptOrdinal(held).ensureAttempt(t.scope, initial(t.taskId, 2)),
      async () => {
        legacy = handled(newAttempt(b, t));
        await blockedOnLock(db, bPid);
        assert.equal(await settledYet(legacy), false, 'the unnumbered insert waits for the numbered one');
      });
    assert.equal(registered.created, true);
    assert.deepEqual(await rows(db, 'select attempt_number from attempts where id = $1', [await legacy!]), [{ attempt_number: 3 }]);
    // Unnumbered writers raced against each other get distinct, consecutive ordinals.
    await Promise.all([1, 2, 3, 4].map((i) => newAttempt(i % 2 === 0 ? a : b, t)));
    const numbers = await rows(db, 'select attempt_number from attempts where task_id = $1 order by attempt_number', [t.taskId]);
    assert.deepEqual(numbers.map((r) => r['attempt_number']), [1, 2, 3, 4, 5, 6, 7]);
  }));
});

// --- lease primitive ------------------------------------------------------------

test('a crash right after the lease grant is settled through findLease, while another attempt is denied', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    for (let round = 0; round < 10; round++) {
      const crashed = await newAttempt(db, t);
      const other = await newAttempt(db, t);
      const branch = `asep/${crashed}`;
      // The grant commits, and its result never reaches the caller.
      await acquire(db, t, crashed, branch);
      const recover = async () => {
        const again = await new SqlWorkspaceLeaseRepository(a).acquire(t.scope, {
          repositoryBindingId: t.bindingId, branch, attemptId: crashed, ttlMs: 600_000,
        });
        assert.ok('denied' in again, 'the same attempt cannot acquire again while its lease is live');
        const fence = await new SqlAttemptLeaseHistory(a).findLease(t.scope, crashed);
        assert.ok(fence !== null, 'the committed grant is in the history');
        await new SqlWorkspaceLeaseRepository(a).heartbeat(t.scope, fence.leaseId);
        return fence;
      };
      const [fence, intruder] = await Promise.all([
        recover(),
        new SqlWorkspaceLeaseRepository(b).acquire(t.scope, { repositoryBindingId: t.bindingId, branch, attemptId: other, ttlMs: 600_000 }),
      ]);
      assert.ok('denied' in intruder, `round ${round}: another attempt is denied`);
      const active = await rows(db,
        `select id, fencing_epoch::int as epoch, attempt_id from workspace_leases
          where repository_binding_id = $1 and branch = $2 and state = 'ACTIVE'`, [t.bindingId, branch]);
      assert.deepEqual(active, [{ id: fence.leaseId, epoch: fence.fencingEpoch, attempt_id: crashed }], `round ${round}`);
      // The recovered fence passes every lease check of the resolver; only the workspace is not registered yet.
      await assert.rejects(() => new SqlAssuranceWorkspaceResolver(a).resolve(t.scope, {
        attemptId: crashed, leaseId: fence.leaseId, fencingEpoch: fence.fencingEpoch,
      }), (err: unknown) => err instanceof WorkspaceUnavailableError && err.reason === 'missing');
    }
  }));
});

test('renewal extends a live lease and reports a released, expired, quarantined or superseded lease lost', async () => {
  await withTenants((db, t) => withTwoConnections(async (a) => {
    const leases = new SqlWorkspaceLeaseRepository(a);
    const live = await acquire(db, t, await newAttempt(db, t));
    await db.query(`update workspace_leases set expires_at = clock_timestamp() + interval '1 second' where id = $1`, [live.leaseId]);
    await leases.heartbeat(t.scope, live.leaseId);
    const [extended] = await rows(db,
      `select expires_at > clock_timestamp() + interval '60 seconds' as extended from workspace_leases where id = $1`, [live.leaseId]);
    assert.deepEqual(extended, { extended: true }, 'renewal extends the expiry by the lease TTL');

    const lost = (leaseId: string) => (err: unknown) => err instanceof LeaseLostError && err.leaseId === leaseId;
    const released = await acquire(db, t, await newAttempt(db, t));
    await new SqlWorkspaceLeaseRepository(db).release(t.scope, released.leaseId);
    await assert.rejects(() => leases.heartbeat(t.scope, released.leaseId), lost(released.leaseId), 'released');
    const expired = await acquire(db, t, await newAttempt(db, t));
    await expire(db, expired.leaseId);
    await assert.rejects(() => leases.heartbeat(t.scope, expired.leaseId), lost(expired.leaseId), 'expired');
    const quarantined = await acquire(db, t, await newAttempt(db, t));
    await db.query(`update workspace_leases set state = 'QUARANTINED' where id = $1`, [quarantined.leaseId]);
    await assert.rejects(() => leases.heartbeat(t.scope, quarantined.leaseId), lost(quarantined.leaseId), 'quarantined');
    const superseded = await acquire(db, t, await newAttempt(db, t));
    const successor = await supersede(db, t, superseded);
    await assert.rejects(() => leases.heartbeat(t.scope, superseded.leaseId), lost(superseded.leaseId), 'superseded');
    await leases.heartbeat(t.scope, successor.leaseId);
  }));
});

const fingerprint = (label: string): string => createHash('sha256').update(label).digest('hex');

function claimOf(t: Tenant, lease: Lease): SideEffectBeginInput {
  return {
    operation: 'push', repositoryBindingId: t.bindingId, attemptId: lease.attemptId,
    requestFingerprint: fingerprint(`push ${lease.attemptId}`), ownerToken: lease.leaseId, naturalKey: lease.branch,
  };
}

const pushed = (lease: Lease): PushResultRef => ({ kind: 'push', branch: lease.branch, commitSha: sha40(`commit ${lease.attemptId}`) });

test('a claim is refused for a released, expired, quarantined or superseded lease, on side effects and workspaces', async () => {
  await withTenants((db, t) => withTwoConnections(async (a) => {
    const log = new SqlSideEffectLog(a);
    const registry = new SqlWorkspaceRegistry(a);
    const dead: Array<[string, (lease: Lease) => Promise<unknown>]> = [
      ['released', (lease) => new SqlWorkspaceLeaseRepository(db).release(t.scope, lease.leaseId)],
      ['expired', (lease) => expire(db, lease.leaseId)],
      ['quarantined', (lease) => db.query(`update workspace_leases set state = 'QUARANTINED' where id = $1`, [lease.leaseId])],
      ['superseded', (lease) => supersede(db, t, lease)],
    ];
    for (const [label, kill] of dead) {
      const lease = await acquire(db, t, await newAttempt(db, t));
      await kill(lease);
      await assert.rejects(() => log.begin(t.scope, claimOf(t, lease)), SideEffectFencingError, `side effect, ${label}`);
      await assert.rejects(() => registry.begin(t.scope, {
        workspaceId: ulid() as WorkspaceId, repositoryBindingId: t.bindingId, attemptId: lease.attemptId, leaseId: lease.leaseId,
        hostId: 'worker-1', pathRel: `ws/${lease.attemptId}`, baseSha: sha40('base'),
      }), (err: unknown) => err instanceof LeaseLostError && err.leaseId === lease.leaseId, `workspace, ${label}`);
      assert.deepEqual(await rows(db,
        `select (select count(*)::int from side_effect_records where attempt_id = $1) as effects,
                (select count(*)::int from workspaces where attempt_id = $1) as workspaces`, [lease.attemptId]),
      [{ effects: 0, workspaces: 0 }], `nothing claimed, ${label}`);
    }
  }));
});

test('a lease superseded between the claimant\'s read and its claim fails the claim', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    const lease = await acquire(db, t, await newAttempt(db, t));
    // The claimant reads its lease and finds it live...
    assert.equal((await rows(a, `select state from workspace_leases where id = $1`, [lease.leaseId]))[0]?.['state'], 'ACTIVE');
    // ...another connection supersedes it...
    await supersede(b, t, lease);
    // ...and the claim, which checks the lease again in its own transaction, fails.
    await assert.rejects(() => new SqlSideEffectLog(a).begin(t.scope, claimOf(t, lease)), SideEffectFencingError);
    await assert.rejects(() => new SqlWorkspaceRegistry(a).begin(t.scope, {
      workspaceId: ulid() as WorkspaceId, repositoryBindingId: t.bindingId, attemptId: lease.attemptId, leaseId: lease.leaseId,
      hostId: 'worker-1', pathRel: `ws/${lease.attemptId}`, baseSha: sha40('base'),
    }), LeaseLostError);
  }));
});

test('a supersede waits for a claim in flight, and the claimed record then refuses the old holder', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    const bPid = await backendPid(b);
    const leaseRead = (sql: string) => sql.includes('from workspace_leases') && sql.includes('for share');

    // A side-effect claim, held right after it read and locked its lease.
    const effectLease = await acquire(db, t, await newAttempt(db, t));
    let quarantine: Promise<unknown> | undefined;
    const claimed = await holding(a, leaseRead, (held) => new SqlSideEffectLog(held).begin(t.scope, claimOf(t, effectLease)), async () => {
      quarantine = handled(b.query(`update workspace_leases set state = 'QUARANTINED' where id = $1`, [effectLease.leaseId]));
      await blockedOnLock(db, bPid);
      assert.equal(await settledYet(quarantine), false, 'the supersede waits for the claim');
    });
    assert.equal(claimed.state, 'PENDING');
    await quarantine;
    await assert.rejects(() => new SqlSideEffectLog(a).confirmOwner(t.scope, { ...claimOf(t, effectLease) }), SideEffectFencingError,
      'the quarantined holder cannot act on its claim');
    await assert.rejects(() => new SqlSideEffectLog(a).complete(t.scope, {
      operation: 'push', repositoryBindingId: t.bindingId, attemptId: effectLease.attemptId, ownerToken: effectLease.leaseId,
      resultRef: pushed(effectLease),
    }), SideEffectFencingError);

    // A workspace claim, held the same way.
    const wsLease = await acquire(db, t, await newAttempt(db, t));
    let release: Promise<void> | undefined;
    const registered = await holding(a, leaseRead, (held) => new SqlWorkspaceRegistry(held).begin(t.scope, {
      workspaceId: ulid() as WorkspaceId, repositoryBindingId: t.bindingId, attemptId: wsLease.attemptId, leaseId: wsLease.leaseId,
      hostId: 'worker-1', pathRel: `ws/${wsLease.attemptId}`, baseSha: sha40('base'),
    }), async () => {
      release = handled(new SqlWorkspaceLeaseRepository(b).release(t.scope, wsLease.leaseId));
      await blockedOnLock(db, bPid);
      assert.equal(await settledYet(release), false, 'the release waits for the workspace claim');
    });
    assert.equal(registered.state, 'CREATING');
    await release;
    assert.deepEqual(await rows(db, 'select state from workspace_leases where id = $1', [wsLease.leaseId]), [{ state: 'RELEASED' }]);
  }));
});

// --- takeover and the FAILED lifecycle -----------------------------------------

test('after a takeover the old holder cannot complete, fail, confirm or claim again, also racing the takeover', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    for (let round = 0; round < 5; round++) {
      const old = await acquire(db, t, await newAttempt(db, t));
      await new SqlSideEffectLog(db).begin(t.scope, claimOf(t, old));
      const successor = await supersede(db, t, old);
      const [takeover, lateComplete] = await Promise.allSettled([
        new SqlSideEffectLog(a).begin(t.scope, claimOf(t, successor)),
        new SqlSideEffectLog(b).complete(t.scope, {
          operation: 'push', repositoryBindingId: t.bindingId, attemptId: old.attemptId, ownerToken: old.leaseId, resultRef: pushed(old),
        }),
      ]);
      assert.ok(takeover.status === 'fulfilled' && takeover.value.takenOver === true && takeover.value.state === 'PENDING',
        `round ${round}: the successor takes the record over`);
      assert.ok(lateComplete.status === 'rejected' && lateComplete.reason instanceof SideEffectFencingError,
        `round ${round}: the old holder's complete is refused`);
      const oldLog = new SqlSideEffectLog(b);
      const key = { operation: 'push' as const, repositoryBindingId: t.bindingId, attemptId: old.attemptId };
      await assert.rejects(() => oldLog.fail(t.scope, { ...key, ownerToken: old.leaseId }), SideEffectFencingError, 'fail');
      await assert.rejects(() => oldLog.confirmOwner(t.scope, { ...key, ownerToken: old.leaseId }), SideEffectFencingError, 'confirm');
      await assert.rejects(() => oldLog.begin(t.scope, claimOf(t, old)), SideEffectFencingError, 'claim again');
      const [record] = await rows(db,
        'select state, owner_lease_id, owner_epoch::int as epoch from side_effect_records where attempt_id = $1', [old.attemptId]);
      assert.deepEqual(record, { state: 'PENDING', owner_lease_id: successor.leaseId, epoch: successor.fencingEpoch });
      await new SqlSideEffectLog(a).confirmOwner(t.scope, { ...key, ownerToken: successor.leaseId });
      assert.equal((await new SqlSideEffectLog(a).complete(t.scope, { ...key, ownerToken: successor.leaseId, resultRef: pushed(old) })).state,
        'COMPLETED', 'the successor reaches a terminal state');
    }
  }));
});

test('the FAILED lifecycle on the primitive: absent → PENDING under the new holder, present → COMPLETED, FAILED stays FAILED, ambiguous stays PENDING', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    const key = (lease: Lease) => ({ operation: 'push' as const, repositoryBindingId: t.bindingId, attemptId: lease.attemptId });
    const state = async (lease: Lease) => (await rows(db, 'select state from side_effect_records where attempt_id = $1', [lease.attemptId]))[0]?.['state'];

    // The effect did not happen: the successor holds the PENDING record and may act on it.
    const absent = await acquire(db, t, await newAttempt(db, t));
    await new SqlSideEffectLog(a).begin(t.scope, claimOf(t, absent));
    const absentNext = await supersede(db, t, absent);
    const reopened = await new SqlSideEffectLog(b).begin(t.scope, claimOf(t, absentNext));
    assert.deepEqual([reopened.state, reopened.takenOver, reopened.ownerToken], ['PENDING', true, absentNext.leaseId]);
    await new SqlSideEffectLog(b).confirmOwner(t.scope, { ...key(absent), ownerToken: absentNext.leaseId });

    // The effect did happen: the successor adopts it as COMPLETED, which nothing rewrites.
    const present = await acquire(db, t, await newAttempt(db, t));
    await new SqlSideEffectLog(a).begin(t.scope, claimOf(t, present));
    const presentNext = await supersede(db, t, present);
    await new SqlSideEffectLog(b).begin(t.scope, claimOf(t, presentNext));
    await new SqlSideEffectLog(b).complete(t.scope, { ...key(present), ownerToken: presentNext.leaseId, resultRef: pushed(present) });
    assert.equal(await state(present), 'COMPLETED');
    const adopted = await new SqlSideEffectLog(a).begin(t.scope, claimOf(t, presentNext));
    assert.deepEqual([adopted.state, adopted.existed], ['COMPLETED', true]);
    await assert.rejects(() => new SqlSideEffectLog(a).fail(t.scope, { ...key(present), ownerToken: presentNext.leaseId }), SideEffectFencingError);

    // A FAILED record is never reopened: a successor finds it FAILED and cannot act on it.
    const failed = await acquire(db, t, await newAttempt(db, t));
    await new SqlSideEffectLog(a).begin(t.scope, claimOf(t, failed));
    await new SqlSideEffectLog(a).fail(t.scope, { ...key(failed), ownerToken: failed.leaseId });
    const failedNext = await supersede(db, t, failed);
    const found = await new SqlSideEffectLog(b).begin(t.scope, claimOf(t, failedNext));
    assert.equal(found.state, 'FAILED');
    await assert.rejects(() => new SqlSideEffectLog(b).confirmOwner(t.scope, { ...key(failed), ownerToken: failedNext.leaseId }), SideEffectFencingError);
    assert.equal(await state(failed), 'FAILED');

    // An ambiguous transport outcome records nothing: the record stays PENDING for the next holder to reconcile.
    const ambiguous = await acquire(db, t, await newAttempt(db, t));
    await new SqlSideEffectLog(a).begin(t.scope, claimOf(t, ambiguous));
    await new SqlSideEffectLog(a).confirmOwner(t.scope, { ...key(ambiguous), ownerToken: ambiguous.leaseId });
    assert.equal(await state(ambiguous), 'PENDING');
    const ambiguousNext = await supersede(db, t, ambiguous);
    const inherited = await new SqlSideEffectLog(b).begin(t.scope, claimOf(t, ambiguousNext));
    assert.deepEqual([inherited.state, inherited.takenOver, inherited.naturalKey], ['PENDING', true, ambiguous.branch],
      'the next holder gets the natural key to reconcile by');
  }));
});

// --- workspace resolver ---------------------------------------------------------

test('the resolver resolves only for the right tenant, the held ACTIVE lease and its current epoch', async () => {
  await withTenants((db, t, other) => withTwoConnections(async (a, b) => {
    const attemptId = await newAttempt(db, t);
    const lease = await acquire(db, t, attemptId);
    const workspaceId = ulid() as WorkspaceId;
    const registry = new SqlWorkspaceRegistry(b);
    await registry.begin(t.scope, {
      workspaceId, repositoryBindingId: t.bindingId, attemptId, leaseId: lease.leaseId, hostId: 'worker-1',
      pathRel: `ws/${attemptId}`, baseSha: sha40('base'),
    });
    await registry.activate(t.scope, { workspaceId, baselineRefs: ['refs/heads/main'] });
    const resolver = new SqlAssuranceWorkspaceResolver(a);
    const ok = { attemptId, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch };
    assert.deepEqual(await resolver.resolve(t.scope, ok), { kind: 'resolved', workspace: { workspaceId, leaseId: lease.leaseId } });
    const otherLease = await acquire(db, t, await newAttempt(db, t));
    for (const [label, scope, query, reason] of [
      ['another tenant', other.scope, ok, 'not-in-scope'],
      ['another attempt\'s lease', t.scope, { ...ok, leaseId: otherLease.leaseId }, 'lease-not-held'],
      ['a stale epoch', t.scope, { ...ok, fencingEpoch: lease.fencingEpoch + 1 }, 'stale-epoch'],
    ] as const) {
      assert.deepEqual(await resolver.resolve(scope, query), { kind: 'refused', reason }, label);
    }
    const successor = await supersede(b, t, lease);
    assert.deepEqual(await resolver.resolve(t.scope, ok), { kind: 'refused', reason: 'lease-not-held' }, 'superseded');
    assert.deepEqual(await resolver.resolve(t.scope, { attemptId, leaseId: successor.leaseId, fencingEpoch: successor.fencingEpoch }),
      { kind: 'resolved', workspace: { workspaceId, leaseId: successor.leaseId } });
    await new SqlWorkspaceLeaseRepository(b).release(t.scope, successor.leaseId);
    assert.deepEqual(await resolver.resolve(t.scope, { attemptId, leaseId: successor.leaseId, fencingEpoch: successor.fencingEpoch }),
      { kind: 'refused', reason: 'lease-not-active' }, 'released');
  }));
});

// --- projection, approvals, ledger, governance, registry races --------------------

test('projections raced on two connections keep the highest sequence number, and two workflows cannot share a task', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    const workflowId = `asep-task-${t.taskId}`;
    const statuses = ['READY', 'EXECUTING', 'VERIFYING'] as const;
    await Promise.all(Array.from({ length: 20 }, (_, i) => i + 1).map((seq) =>
      new SqlProjectionWriter(seq % 2 === 0 ? a : b).projectTask(t.scope, t.taskId, { workflowId, seq, status: statuses[seq % 3]! })));
    assert.deepEqual(await rows(db, 'select projection_seq::int as seq, status, workflow_id from tasks where id = $1', [t.taskId]),
      [{ seq: 20, status: statuses[20 % 3], workflow_id: workflowId }]);

    for (let round = 0; round < 5; round++) {
      const taskId = await newTask(db, t);
      const outcomes = await Promise.allSettled([
        new SqlProjectionWriter(a).projectTask(t.scope, taskId, { workflowId: `asep-task-${taskId}`, seq: 1, status: 'READY' }),
        new SqlProjectionWriter(b).projectTask(t.scope, taskId, { workflowId: `asep-task-${taskId}-rogue`, seq: 1, status: 'READY' }),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, `round ${round}: one workflow binds the task`);
      const lost = outcomes.find((o) => o.status === 'rejected');
      assert.ok(lost?.status === 'rejected' && lost.reason instanceof ProjectionOwnershipError, `round ${round}`);
    }
  }));
});

test('approval writes raced on two connections: one request, one decision, one delivery row', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    for (let round = 0; round < 5; round++) {
      const attemptId = await newAttempt(db, t);
      const workflowId = `asep-task-${t.taskId}-${round}`;
      const request: OpenApprovalRequestInput = {
        approvalRequestId: `${workflowId}:1`, workflowId, runId: t.runId, taskId: t.taskId, attemptId, kind: 'publish-change',
        requestedBy: 'harness', shortfallMicroUsd: null, expiresAt: '2999-01-01T00:00:00.000Z',
      };
      const opened = await Promise.all([new SqlApprovalStore(a).openRequest(t.scope, request), new SqlApprovalStore(b).openRequest(t.scope, request)]);
      assert.deepEqual(opened.map((o) => o.created).sort(), [false, true], `round ${round}: one request`);

      const decision: RecordDecisionInput = {
        decisionId: ulid(), approvalRequestId: request.approvalRequestId, decision: 'approve', decidedBy: HUMAN,
        rationale: 'checked the evidence', extensionMicroUsd: null,
      };
      const recorded = await Promise.all([new SqlApprovalStore(a).recordDecision(t.scope, decision), new SqlApprovalStore(b).recordDecision(t.scope, decision)]);
      assert.deepEqual(recorded.map((r) => r.replayed).sort(), [false, true], `round ${round}: one decision, one replay`);
      await assert.rejects(() => new SqlApprovalStore(a).recordDecision(t.scope, { ...decision, decisionId: ulid(), decision: 'reject' }),
        ApprovalDecisionConflictError);
      assert.deepEqual(await rows(db,
        `select (select count(*)::int from approval_decisions where request_id = $1) as decisions,
                (select count(*)::int from approval_decision_deliveries where decision_id = $2) as deliveries,
                (select status from approval_requests where id = $1) as status`, [request.approvalRequestId, decision.decisionId]),
      [{ decisions: 1, deliveries: 1, status: 'APPROVED' }]);
    }
    // Two different decisions at once: one is recorded, the other refused.
    for (let round = 0; round < 5; round++) {
      const workflowId = `asep-task-${t.taskId}-conflict-${round}`;
      const request: OpenApprovalRequestInput = {
        approvalRequestId: `${workflowId}:1`, workflowId, runId: t.runId, taskId: t.taskId, attemptId: null, kind: 'budget-extension',
        requestedBy: 'harness', shortfallMicroUsd: 1_000_000, expiresAt: '2999-01-01T00:00:00.000Z',
      };
      await new SqlApprovalStore(db).openRequest(t.scope, request);
      const approve: RecordDecisionInput = {
        decisionId: ulid(), approvalRequestId: request.approvalRequestId, decision: 'approve', decidedBy: HUMAN,
        rationale: 'yes', extensionMicroUsd: 1_000_000,
      };
      const reject: RecordDecisionInput = { ...approve, decisionId: ulid(), decision: 'reject', rationale: 'no', extensionMicroUsd: null };
      const outcomes = await Promise.allSettled([
        new SqlApprovalStore(a).recordDecision(t.scope, approve), new SqlApprovalStore(b).recordDecision(t.scope, reject),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, `round ${round}: one decision`);
      const lost = outcomes.find((o) => o.status === 'rejected');
      assert.ok(lost?.status === 'rejected' && lost.reason instanceof ApprovalDecisionConflictError, `round ${round}`);
    }
    // A decision racing the workflow's expiry: either the decision is recorded and the request shows it, or the
    // request expired and the decision is refused; never both.
    for (let round = 0; round < 5; round++) {
      const workflowId = `asep-task-${t.taskId}-expiry-${round}`;
      const attemptId = await newAttempt(db, t);
      const request: OpenApprovalRequestInput = {
        approvalRequestId: `${workflowId}:1`, workflowId, runId: t.runId, taskId: t.taskId, attemptId, kind: 'publish-change',
        requestedBy: 'harness', shortfallMicroUsd: null, expiresAt: '2999-01-01T00:00:00.000Z',
      };
      await new SqlApprovalStore(db).openRequest(t.scope, request);
      const decision: RecordDecisionInput = {
        decisionId: ulid(), approvalRequestId: request.approvalRequestId, decision: 'approve', decidedBy: HUMAN,
        rationale: 'in time?', extensionMicroUsd: null,
      };
      const [decided, closed] = await Promise.allSettled([
        new SqlApprovalStore(a).recordDecision(t.scope, decision),
        new SqlApprovalStore(b).closeRequest(t.scope, request.approvalRequestId, 'EXPIRED'),
      ]);
      assert.equal(closed.status, 'fulfilled');
      const [stored] = await rows(db,
        `select status, (select count(*)::int from approval_decisions where request_id = $1) as decisions
           from approval_requests where id = $1`, [request.approvalRequestId]);
      if (decided.status === 'fulfilled') {
        assert.deepEqual([stored, closed.status === 'fulfilled' && closed.value], [{ status: 'APPROVED', decisions: 1 }, 'APPROVED'], `round ${round}`);
      } else {
        assert.ok(decided.reason instanceof ApprovalRequestClosedError, `round ${round}: refused as closed`);
        assert.deepEqual(stored, { status: 'EXPIRED', decisions: 0 }, `round ${round}`);
      }
    }
  }));
});

test('ledger, governance and registry writes raced on two connections land once', async () => {
  await withTenants((db, t) => withTwoConnections(async (a, b) => {
    const attemptId = await newAttempt(db, t);
    const entry: LedgerEntryInput = {
      idempotencyKey: `${attemptId}:attempt-usage`, runId: t.runId, taskId: t.taskId, attemptId, entryKind: 'attempt-usage',
      costMicroUsd: 1_234_567, usageOutOfBound: false, inputTokens: 10, outputTokens: 2, toolCalls: 1, wallClockMs: 1000,
      source: 'provider-reported',
    };
    const appended = await Promise.all([new SqlBudgetLedger(a).append(t.scope, entry), new SqlBudgetLedger(b).append(t.scope, entry)]);
    assert.deepEqual(appended.map((r) => r.appended).sort(), [false, true]);
    const conflicting = { ...entry, idempotencyKey: `${attemptId}:other`, costMicroUsd: 1 };
    const outcomes = await Promise.allSettled([
      new SqlBudgetLedger(a).append(t.scope, conflicting), new SqlBudgetLedger(b).append(t.scope, { ...conflicting, costMicroUsd: 2 }),
    ]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.ok(outcomes.some((o) => o.status === 'rejected' && o.reason instanceof BudgetLedgerConflictError));
    assert.deepEqual(await new SqlBudgetLedger(db).totals(t.scope, { runId: t.runId }),
      { attemptUsageMicroUsd: 1_234_567 + (outcomes[0]!.status === 'fulfilled' ? 1 : 2), overrunMicroUsd: 0, extensionGrantedMicroUsd: 0, entries: 2 });

    const governance = { maxCostMicroUsd: 50_000_000, softCostMicroUsd: 40_000_000, maxTasks: 10, publicationApprovalRequired: true, createdBy: HUMAN };
    const bound = await Promise.all([new SqlRunGovernance(a).bind(t.scope, t.runId, governance), new SqlRunGovernance(b).bind(t.scope, t.runId, governance)]);
    assert.deepEqual(bound.map((r) => r.bound).sort(), [false, true]);
    const run2 = await new RunRepository(db).create(t.scope, { repositoryBindingId: t.bindingId, status: 'EXECUTING', risk: 'R0' });
    const governed = await Promise.allSettled([
      new SqlRunGovernance(a).bind(t.scope, run2.id, governance),
      new SqlRunGovernance(b).bind(t.scope, run2.id, { ...governance, publicationApprovalRequired: false }),
    ]);
    assert.equal(governed.filter((o) => o.status === 'fulfilled').length, 1);
    assert.ok(governed.some((o) => o.status === 'rejected' && o.reason instanceof RunGovernanceConflictError));

    const lease = await acquire(db, t, attemptId);
    const record = (workspaceId: WorkspaceId) => ({
      workspaceId, repositoryBindingId: t.bindingId, attemptId, leaseId: lease.leaseId, hostId: 'worker-1',
      pathRel: `ws/${attemptId}`, baseSha: sha40('base'),
    });
    const begun = await Promise.all([
      new SqlWorkspaceRegistry(a).begin(t.scope, record(ulid() as WorkspaceId)),
      new SqlWorkspaceRegistry(b).begin(t.scope, record(ulid() as WorkspaceId)),
    ]);
    assert.deepEqual(begun[0], begun[1], 'both get the attempt\'s one stored record');
    assert.deepEqual(await rows(db, 'select count(*)::int as n from workspaces where attempt_id = $1', [attemptId]), [{ n: 1 }]);
    // The same registration retried on both connections at once.
    const retriedAttempt = await newAttempt(db, t);
    const retriedLease = await acquire(db, t, retriedAttempt);
    const retried = {
      workspaceId: ulid() as WorkspaceId, repositoryBindingId: t.bindingId, attemptId: retriedAttempt, leaseId: retriedLease.leaseId,
      hostId: 'worker-1', pathRel: `ws/${retriedAttempt}`, baseSha: sha40('base'),
    };
    const twice = await Promise.all([new SqlWorkspaceRegistry(a).begin(t.scope, retried), new SqlWorkspaceRegistry(b).begin(t.scope, retried)]);
    assert.deepEqual(twice[0], twice[1]);
    assert.deepEqual(twice[0], { ...retried, baselineRefs: [], state: 'CREATING' });
  }));
});
