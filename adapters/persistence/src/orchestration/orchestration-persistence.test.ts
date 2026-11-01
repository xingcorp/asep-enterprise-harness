// The orchestration state stores on PGlite: the migrations 0100–0102 and
// 0104–0106, the attempt ordinal, the projection writer, the workspace registry
// and its resolver, the lease history, the approval requests with their
// decision outbox, and the budget ledger with the run's governance.
//
// Every store is idempotent on a natural key: a repeated write with the same
// facts changes nothing, the same key with other facts is refused. Every read
// and write stays in the caller's tenant. The oracles are independent of the
// stores: rows are read back with plain SQL, and the database's own rules are
// tried with raw statements, so no store check stands in for the schema.
// Two-connection races are the integration suite's (orchestration.itest.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type {
  ArtifactId, ArtifactRef, AttemptId, RepositoryBindingId, RunId, TaskId, TenantScope, WorkspaceId,
} from '@asep/contracts';
import { LeaseLostError, WorkspaceUnavailableError, type Lease } from '@asep/ports';
import { PgliteClient } from '../pglite-client.js';
import { migrate } from '../migrator.js';
import { MIGRATIONS } from '../migrations.js';
import {
  AttemptRepository, OrganizationRepository, ProjectRepository, RepositoryBindingRepository, RunRepository,
  TaskRepository,
} from '../repositories.js';
import { SqlWorkspaceLeaseRepository } from '../lease-repository.js';
import { ScopeViolationError, type SqlClient, type SqlExecutor } from '../sql.js';
import { ulid } from '../ulid.js';
import {
  ApprovalDecisionConflictError, ApprovalRequestClosedError, ApprovalRequestConflictError,
  AttemptIdentityConflictError, BudgetLedgerConflictError, ProjectionFactConflictError, ProjectionOwnershipError,
  RunGovernanceConflictError, SqlApprovalStore, SqlAssuranceWorkspaceResolver, SqlAttemptLeaseHistory,
  SqlAttemptOrdinal, SqlBudgetLedger, SqlProjectionWriter, SqlRunGovernance, SqlWorkspaceRegistry,
  type EnsureAttemptInput, type LedgerEntryInput, type OpenApprovalRequestInput, type RecordDecisionInput,
} from './index.js';

console.log('SUITE-ID: asep-suite:orchestration-persistence');

// --- fixtures ---------------------------------------------------------------

interface Tenant {
  readonly scope: TenantScope;
  readonly bindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
}

async function seedTenant(db: SqlClient, name: string): Promise<Tenant> {
  const org = await new OrganizationRepository(db).create({ name });
  const project = await new ProjectRepository(db).create({ organizationId: org.id, name: 'web', defaultBranch: 'main' });
  const scope: TenantScope = { organizationId: org.id, projectId: project.id };
  const binding = await new RepositoryBindingRepository(db).create(scope, {
    githubHost: 'github.com', githubOwner: name, githubRepo: 'web', defaultBaseBranch: 'main',
  });
  const run = await new RunRepository(db).create(scope, { repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0' });
  const task = await new TaskRepository(db).create(scope, { runId: run.id, repositoryBindingId: binding.id, risk: 'R0' });
  return { scope, bindingId: binding.id, runId: run.id, taskId: task.id };
}

async function freshDb(): Promise<{ db: PgliteClient; a: Tenant; b: Tenant }> {
  const db = await PgliteClient.create();
  await migrate(db);
  return { db, a: await seedTenant(db, 'acme'), b: await seedTenant(db, 'globex') };
}

async function newTask(db: SqlClient, t: Tenant): Promise<TaskId> {
  return (await new TaskRepository(db).create(t.scope, { runId: t.runId, repositoryBindingId: t.bindingId, risk: 'R0' })).id;
}

async function legacyAttempt(db: SqlClient, t: Tenant, taskId: TaskId = t.taskId): Promise<AttemptId> {
  return (await new AttemptRepository(db).create(t.scope, { taskId, repositoryBindingId: t.bindingId })).id;
}

const sha40 = (label: string): string => createHash('sha1').update(label).digest('hex');
const sha64 = (label: string): string => createHash('sha256').update(label).digest('hex');

async function artifact(db: SqlClient, t: Tenant, kind: string, label: string): Promise<ArtifactRef> {
  const id = ulid() as ArtifactId;
  const sha256 = sha64(label);
  await db.query(
    `insert into artifacts (id, organization_id, project_id, kind, sha256, size_bytes, storage_key, content_type)
     values ($1, $2, $3, $4, $5, 1, $6, 'application/json')`,
    [id, t.scope.organizationId, t.scope.projectId, kind, sha256, `k/${id}`],
  );
  return { artifactId: id, sha256, kind };
}

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

const initial = (taskId: TaskId, attemptNumber: number, baseSha = sha40('base')): EnsureAttemptInput => ({
  taskId, attemptNumber, kind: 'initial', baseSha, parentAttemptNumber: null, repairOrderRef: null,
});

const refused = (err: unknown): boolean => /violates|immutable|cannot|fixed|keeps|must be/i.test((err as Error).message);

async function one(db: SqlClient, sql: string, params: readonly (string | number | null)[]): Promise<Record<string, unknown>> {
  const r = await db.query(sql, params);
  assert.equal(r.rowCount, 1, `one row for: ${sql}`);
  return { ...r.rows[0]! };
}

// --- migrations ----------------------------------------------------------------

test('the task status check admits the three orchestration statuses and nothing else', async () => {
  const { db, a } = await freshDb();
  try {
    for (const status of ['PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED', 'WAITING_FOR_HUMAN_REVIEW']) {
      await db.query('update tasks set status = $1 where id = $2', [status, a.taskId]);
    }
    await assert.rejects(() => db.query(`update tasks set status = 'ACCEPTED' where id = $1`, [a.taskId]), refused);
    const checks = await db.query(
      `select conname from pg_constraint where conrelid = 'tasks'::regclass and contype = 'c' and conname like 'tasks_status%'`, []);
    assert.deepEqual(checks.rows.map((r) => r['conname']), ['tasks_status_check'], 'one status check, by its name');
  } finally {
    await db.close();
  }
});

test('upgrading numbers each task\'s existing attempts in the order they started and makes them initial', async () => {
  const db = await PgliteClient.create();
  try {
    await migrate(db, MIGRATIONS.filter((m) => m.id < '0100'));
    const t = await seedTenant(db, 'acme');
    const other = await newTask(db, t);
    // Ids sort against start time on purpose, and two attempts start at the same moment.
    const rows: Array<[string, TaskId, string]> = [
      ['00000000000000000000000003', t.taskId, '2026-10-01T00:00:00Z'],
      ['00000000000000000000000002', t.taskId, '2026-10-02T00:00:00Z'],
      ['00000000000000000000000005', t.taskId, '2026-10-03T00:00:00Z'],
      ['00000000000000000000000004', t.taskId, '2026-10-03T00:00:00Z'],
      ['00000000000000000000000001', other, '2026-10-05T00:00:00Z'],
    ];
    for (const [id, taskId, startedAt] of rows) {
      await db.query(
        `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status, started_at)
         values ($1, $2, $3, $4, $5, 'STARTED', $6::timestamptz)`,
        [id, t.scope.organizationId, t.scope.projectId, taskId, t.bindingId, startedAt],
      );
    }
    const report = await migrate(db);
    assert.deepEqual(report.applied, MIGRATIONS.filter((m) => m.id >= '0100').map((m) => m.id));
    const numbered = await db.query('select id, attempt_number, attempt_kind from attempts order by id', []);
    assert.deepEqual(numbered.rows.map((r) => [r['id'], r['attempt_number'], r['attempt_kind']]), [
      ['00000000000000000000000001', 1, 'initial'],
      ['00000000000000000000000002', 2, 'initial'],
      ['00000000000000000000000003', 1, 'initial'],
      ['00000000000000000000000004', 3, 'initial'],
      ['00000000000000000000000005', 4, 'initial'],
    ]);
  } finally {
    await db.close();
  }
});

test('a writer that names no ordinal gets the next one of its task', async () => {
  const { db, a } = await freshDb();
  try {
    const other = await newTask(db, a);
    const ids = [await legacyAttempt(db, a), await legacyAttempt(db, a), await legacyAttempt(db, a, other), await legacyAttempt(db, a)];
    const r = await db.query('select id, task_id, attempt_number, attempt_kind from attempts where id = any($1::text[])', [`{${ids.join(',')}}`]);
    const byId = new Map(r.rows.map((row) => [row['id'], [row['attempt_number'], row['attempt_kind']]]));
    assert.deepEqual(ids.map((id) => byId.get(id)), [[1, 'initial'], [2, 'initial'], [1, 'initial'], [3, 'initial']]);
    await assert.rejects(
      () => db.query('update attempts set attempt_number = 1 where id = $1', [ids[1]!]),
      (err: unknown) => /attempts_task_ordinal|duplicate/i.test((err as Error).message),
      'two attempts of one task cannot share an ordinal',
    );
  } finally {
    await db.close();
  }
});

test('the repair lineage is a database rule: shape, same task, earlier parent, scoped repair order', async () => {
  const { db, a, b } = await freshDb();
  try {
    const parent = await legacyAttempt(db, a);
    const order = await artifact(db, a, 'repair-order', 'order 1');
    const foreignOrder = await artifact(db, b, 'repair-order', 'order 1');
    const wrongKind = await artifact(db, a, 'context-pack', 'order 1');
    const otherTask = await newTask(db, a);
    const otherParent = await legacyAttempt(db, a, otherTask);
    const later = ulid();
    await db.query(
      `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status, attempt_number)
       values ($1, $2, $3, $4, $5, 'STARTED', 20)`,
      [later, a.scope.organizationId, a.scope.projectId, a.taskId, a.bindingId],
    );
    const insert = (n: number, kind: string, parentId: string | null, ref: ArtifactRef | null, sha?: string | null) => db.query(
      `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status, attempt_number, attempt_kind,
                             parent_attempt_id, repair_order_artifact_id, repair_order_sha256)
       values ($1, $2, $3, $4, $5, 'STARTED', $6, $7, $8, $9, $10)`,
      [ulid(), a.scope.organizationId, a.scope.projectId, a.taskId, a.bindingId, n, kind, parentId,
        ref?.artifactId ?? null, sha === undefined ? (ref?.sha256 ?? null) : sha],
    );
    await assert.rejects(() => insert(2, 'repair', null, null), refused, 'a repair attempt without a lineage');
    await assert.rejects(() => insert(2, 'repair', parent, null), refused, 'a parent without a repair order');
    await assert.rejects(() => insert(2, 'initial', parent, order), refused, 'an initial attempt with a lineage');
    await assert.rejects(() => insert(2, 'repaired', null, null), refused, 'an unknown kind');
    await assert.rejects(() => insert(2, 'repair', otherParent, order), refused, 'a parent of another task');
    await assert.rejects(() => insert(5, 'repair', later, order), refused, 'a parent that is not earlier');
    await assert.rejects(() => insert(2, 'repair', parent, foreignOrder), refused, 'another tenant\'s repair order');
    await assert.rejects(() => insert(2, 'repair', parent, wrongKind), refused, 'an artifact of another kind');
    await assert.rejects(() => insert(2, 'repair', parent, order, 'b'.repeat(64)), refused, 'the wrong checksum');
    await assert.rejects(() => insert(0, 'initial', null, null), refused, 'ordinal zero');
    await insert(2, 'repair', parent, order);
    await insert(3, 'retry', parent, order);
    await insert(4, 'retry', null, null);
    const registered = await db.query(
      `select kind from artifact_reference_columns where table_name = 'attempts' and reference_name = 'repair_order'`, []);
    assert.deepEqual(registered.rows.map((r) => r['kind']), ['repair-order']);
  } finally {
    await db.close();
  }
});

// --- attempt ordinal --------------------------------------------------------------

test('ensureAttempt registers attempt n of a task once; a repeat returns the same row', async () => {
  const { db, a } = await freshDb();
  try {
    const ordinal = new SqlAttemptOrdinal(db);
    const first = await ordinal.ensureAttempt(a.scope, initial(a.taskId, 1));
    assert.equal(first.created, true);
    assert.deepEqual(
      { ...first.attempt, attemptId: 'x' },
      {
        attemptId: 'x', taskId: a.taskId, repositoryBindingId: a.bindingId, attemptNumber: 1, kind: 'initial',
        baseSha: sha40('base'), parentAttemptNumber: null, repairOrderRef: null, status: 'STARTED',
      },
    );
    const again = await ordinal.ensureAttempt(a.scope, initial(a.taskId, 1));
    assert.deepEqual(again, { attempt: first.attempt, created: false });
    const rows = await db.query('select id from attempts where task_id = $1 and attempt_number = 1', [a.taskId]);
    assert.deepEqual(rows.rows.map((r) => r['id']), [first.attempt.attemptId]);
    assert.deepEqual(await ordinal.findAttempt(a.scope, { taskId: a.taskId, attemptNumber: 1 }), first.attempt);
    assert.equal(await ordinal.findAttempt(a.scope, { taskId: a.taskId, attemptNumber: 2 }), null);
  } finally {
    await db.close();
  }
});

test('ensureAttempt refuses another identity on a registered ordinal and changes nothing', async () => {
  const { db, a } = await freshDb();
  try {
    const ordinal = new SqlAttemptOrdinal(db);
    const order = await artifact(db, a, 'repair-order', 'order');
    const otherOrder = await artifact(db, a, 'repair-order', 'other order');
    await ordinal.ensureAttempt(a.scope, initial(a.taskId, 1));
    const repair: EnsureAttemptInput = {
      taskId: a.taskId, attemptNumber: 2, kind: 'repair', baseSha: sha40('repair base'), parentAttemptNumber: 1, repairOrderRef: order,
    };
    const stored = (await ordinal.ensureAttempt(a.scope, repair)).attempt;
    const variants: Array<[string, EnsureAttemptInput]> = [
      ['another kind', { ...repair, kind: 'retry' }],
      ['another base', { ...repair, baseSha: sha40('elsewhere') }],
      ['another repair order', { ...repair, repairOrderRef: otherOrder }],
      ['no lineage', { ...repair, kind: 'retry', parentAttemptNumber: null, repairOrderRef: null }],
      ['the initial identity', { ...initial(a.taskId, 2) }],
    ];
    for (const [label, input] of variants) {
      await assert.rejects(() => ordinal.ensureAttempt(a.scope, input), AttemptIdentityConflictError, label);
    }
    await assert.rejects(() => ordinal.ensureAttempt(a.scope, initial(a.taskId, 1, sha40('moved'))), AttemptIdentityConflictError);
    assert.deepEqual(await ordinal.findAttempt(a.scope, { taskId: a.taskId, attemptNumber: 2 }), stored);
  } finally {
    await db.close();
  }
});

test('a repair attempt names its parent and repair order, and a retry of it keeps the lineage', async () => {
  const { db, a } = await freshDb();
  try {
    const ordinal = new SqlAttemptOrdinal(db);
    const order = await artifact(db, a, 'repair-order', 'order');
    const one1 = (await ordinal.ensureAttempt(a.scope, initial(a.taskId, 1))).attempt;
    const lineage = { parentAttemptNumber: 1, repairOrderRef: order, baseSha: sha40('repair base') };
    const two = (await ordinal.ensureAttempt(a.scope, { taskId: a.taskId, attemptNumber: 2, kind: 'repair', ...lineage })).attempt;
    const three = (await ordinal.ensureAttempt(a.scope, { taskId: a.taskId, attemptNumber: 3, kind: 'retry', ...lineage })).attempt;
    assert.deepEqual([two.kind, two.parentAttemptNumber, two.repairOrderRef, two.baseSha], ['repair', 1, order, sha40('repair base')]);
    assert.deepEqual([three.kind, three.parentAttemptNumber, three.repairOrderRef], ['retry', 1, order]);
    const parents = await db.query('select id, parent_attempt_id from attempts where task_id = $1 order by attempt_number', [a.taskId]);
    assert.deepEqual(parents.rows.map((r) => r['parent_attempt_id']), [null, one1.attemptId, one1.attemptId]);
  } finally {
    await db.close();
  }
});

test('ensureAttempt refuses a malformed registration before any write', async () => {
  const { db, a } = await freshDb();
  try {
    const ordinal = new SqlAttemptOrdinal(db);
    const order = await artifact(db, a, 'repair-order', 'order');
    const context = await artifact(db, a, 'context-pack', 'pack');
    await ordinal.ensureAttempt(a.scope, initial(a.taskId, 1));
    const repair: EnsureAttemptInput = {
      taskId: a.taskId, attemptNumber: 2, kind: 'repair', baseSha: sha40('b'), parentAttemptNumber: 1, repairOrderRef: order,
    };
    const bad: Array<[string, EnsureAttemptInput]> = [
      ['ordinal zero', initial(a.taskId, 0)],
      ['a fractional ordinal', initial(a.taskId, 1.5)],
      ['a short base', initial(a.taskId, 2, 'abc')],
      ['an upper-case base', initial(a.taskId, 2, sha40('x').toUpperCase())],
      ['an initial attempt with a lineage', { ...repair, kind: 'initial' }],
      ['a repair without a parent', { ...repair, parentAttemptNumber: null }],
      ['a repair without an order', { ...repair, repairOrderRef: null }],
      ['a parent that is not earlier', { ...repair, parentAttemptNumber: 2 }],
      ['an order of another kind', { ...repair, repairOrderRef: context }],
      ['an unknown kind', { ...repair, kind: 'rerun' as EnsureAttemptInput['kind'] }],
    ];
    for (const [label, input] of bad) {
      await assert.rejects(() => ordinal.ensureAttempt(a.scope, input), RangeError, label);
    }
    const count = await db.query('select count(*)::int as n from attempts where task_id = $1', [a.taskId]);
    assert.equal(count.rows[0]?.['n'], 1);
  } finally {
    await db.close();
  }
});

test('ensureAttempt and findAttempt stay in the caller\'s tenant, and a lineage needs its parent', async () => {
  const { db, a, b } = await freshDb();
  try {
    const ordinal = new SqlAttemptOrdinal(db);
    await ordinal.ensureAttempt(a.scope, initial(a.taskId, 1));
    await assert.rejects(() => ordinal.ensureAttempt(b.scope, initial(a.taskId, 1)), ScopeViolationError);
    await assert.rejects(() => ordinal.ensureAttempt(b.scope, initial(a.taskId, 2)), ScopeViolationError);
    assert.equal(await ordinal.findAttempt(b.scope, { taskId: a.taskId, attemptNumber: 1 }), null);
    const order = await artifact(db, a, 'repair-order', 'order');
    await assert.rejects(() => ordinal.ensureAttempt(a.scope, {
      taskId: a.taskId, attemptNumber: 3, kind: 'repair', baseSha: sha40('b'), parentAttemptNumber: 2, repairOrderRef: order,
    }), ScopeViolationError, 'the parent attempt 2 was never registered');
    const foreignOrder = await artifact(db, b, 'repair-order', 'order b');
    await assert.rejects(() => ordinal.ensureAttempt(a.scope, {
      taskId: a.taskId, attemptNumber: 2, kind: 'repair', baseSha: sha40('b'), parentAttemptNumber: 1, repairOrderRef: foreignOrder,
    }), refused, 'another tenant\'s repair order');
  } finally {
    await db.close();
  }
});

// --- projection -------------------------------------------------------------------

test('a task projection applies only with a higher sequence number and binds its workflow once', async () => {
  const { db, a } = await freshDb();
  try {
    const projection = new SqlProjectionWriter(db);
    const wf = `asep-task-${a.taskId}`;
    const read = () => one(db, 'select status, projection_seq, workflow_id, version from tasks where id = $1', [a.taskId]);
    assert.deepEqual(await projection.projectTask(a.scope, a.taskId, { workflowId: wf, seq: 1, status: 'READY' }), { applied: true });
    assert.deepEqual(await projection.projectTask(a.scope, a.taskId, { workflowId: wf, seq: 3, status: 'EXECUTING' }), { applied: true });
    const before = await read();
    assert.deepEqual([before['status'], Number(before['projection_seq']), before['workflow_id']], ['EXECUTING', 3, wf]);
    for (const seq of [3, 2, 1]) {
      assert.deepEqual(await projection.projectTask(a.scope, a.taskId, { workflowId: wf, seq, status: 'PAUSED' }), { applied: false }, `seq ${seq}`);
    }
    assert.deepEqual(await read(), before, 'an equal or older projection changes nothing');
    assert.deepEqual(await projection.projectTask(a.scope, a.taskId, { workflowId: wf, seq: 4, status: 'WAITING_FOR_APPROVAL' }), { applied: true });
    assert.equal((await read())['status'], 'WAITING_FOR_APPROVAL');
  } finally {
    await db.close();
  }
});

test('a projection from another workflow is refused whatever its sequence number', async () => {
  const { db, a } = await freshDb();
  try {
    const projection = new SqlProjectionWriter(db);
    const wf = `asep-task-${a.taskId}`;
    await projection.projectTask(a.scope, a.taskId, { workflowId: wf, seq: 5, status: 'EXECUTING' });
    for (const seq of [6, 5, 1]) {
      await assert.rejects(
        () => projection.projectTask(a.scope, a.taskId, { workflowId: `${wf}-second`, seq, status: 'FAILED' }),
        ProjectionOwnershipError, `seq ${seq}`,
      );
    }
    const other = await newTask(db, a);
    await assert.rejects(
      () => projection.projectTask(a.scope, other, { workflowId: wf, seq: 1, status: 'READY' }),
      ProjectionOwnershipError, 'a workflow bound to another task',
    );
    const row = await one(db, 'select status, projection_seq, workflow_id from tasks where id = $1', [a.taskId]);
    assert.deepEqual([row['status'], Number(row['projection_seq']), row['workflow_id']], ['EXECUTING', 5, wf]);
    assert.equal((await one(db, 'select workflow_id from tasks where id = $1', [other]))['workflow_id'], null);
  } finally {
    await db.close();
  }
});

test('attempt and run projections follow the same rules; an attempt\'s owner is its task\'s workflow', async () => {
  const { db, a } = await freshDb();
  try {
    const projection = new SqlProjectionWriter(db);
    const wf = `asep-task-${a.taskId}`;
    const attemptId = await legacyAttempt(db, a);
    assert.deepEqual(await projection.projectAttempt(a.scope, attemptId, { workflowId: wf, seq: 2, status: 'AGENT_RUNNING' }), { applied: true });
    assert.deepEqual(await projection.projectAttempt(a.scope, attemptId, { workflowId: wf, seq: 2, status: 'FAILED' }), { applied: false });
    await projection.projectTask(a.scope, a.taskId, { workflowId: wf, seq: 1, status: 'EXECUTING' });
    await assert.rejects(
      () => projection.projectAttempt(a.scope, attemptId, { workflowId: 'asep-task-other', seq: 9, status: 'FAILED' }),
      ProjectionOwnershipError,
    );
    assert.deepEqual(await projection.projectAttempt(a.scope, attemptId, { workflowId: wf, seq: 3, status: 'VERIFYING' }), { applied: true });
    const attempt = await one(db, 'select status, projection_seq from attempts where id = $1', [attemptId]);
    assert.deepEqual([attempt['status'], Number(attempt['projection_seq'])], ['VERIFYING', 3]);

    const runWf = `asep-run-${a.runId}`;
    assert.deepEqual(await projection.projectRun(a.scope, a.runId, { workflowId: runWf, seq: 1, status: 'EXECUTING' }), { applied: true });
    assert.deepEqual(await projection.projectRun(a.scope, a.runId, { workflowId: runWf, seq: 1, status: 'DONE' }), { applied: false });
    await assert.rejects(
      () => projection.projectRun(a.scope, a.runId, { workflowId: `${runWf}-second`, seq: 2, status: 'DONE' }),
      ProjectionOwnershipError,
    );
    const run = await one(db, 'select status, workflow_id from runs where id = $1', [a.runId]);
    assert.deepEqual([run['status'], run['workflow_id']], ['EXECUTING', runWf]);
  } finally {
    await db.close();
  }
});

test('an attempt projected before its task binds the task to that workflow, and another workflow is refused', async () => {
  const { db, a } = await freshDb();
  try {
    const projection = new SqlProjectionWriter(db);
    const first = `asep-task-${a.taskId}`;
    const attemptId = await legacyAttempt(db, a);
    assert.deepEqual(await projection.projectAttempt(a.scope, attemptId, { workflowId: first, seq: 100, status: 'FAILED' }), { applied: true });
    assert.equal((await one(db, 'select workflow_id from tasks where id = $1', [a.taskId]))['workflow_id'], first,
      'the first attempt projection binds the task');
    await assert.rejects(
      () => projection.projectAttempt(a.scope, attemptId, { workflowId: 'asep-task-other', seq: 200, status: 'SUCCEEDED' }),
      ProjectionOwnershipError, 'another workflow, whatever its sequence number');
    await assert.rejects(
      () => projection.projectTask(a.scope, a.taskId, { workflowId: 'asep-task-other', seq: 1, status: 'EXECUTING' }),
      ProjectionOwnershipError, 'the task is bound already');
    assert.deepEqual(await projection.projectAttempt(a.scope, attemptId, { workflowId: first, seq: 101, status: 'AGENT_RUNNING' }), { applied: true });
    // A workflow that projects one task cannot take a second task through one of its attempts.
    const otherTask = await newTask(db, a);
    const otherAttempt = await legacyAttempt(db, a, otherTask);
    await assert.rejects(
      () => projection.projectAttempt(a.scope, otherAttempt, { workflowId: first, seq: 1, status: 'AGENT_RUNNING' }),
      ProjectionOwnershipError);
    assert.deepEqual(await one(db,
      `select (select workflow_id from tasks where id = $1) as wf, (select projection_seq::int from attempts where id = $2) as seq`,
      [otherTask, otherAttempt]), { wf: null, seq: 0 }, 'nothing written');
  } finally {
    await db.close();
  }
});

test('projection writes stay in the caller\'s tenant and take only a positive sequence number', async () => {
  const { db, a, b } = await freshDb();
  try {
    const projection = new SqlProjectionWriter(db);
    const attemptId = await legacyAttempt(db, a);
    const write = { workflowId: 'asep-task-x', seq: 1 } as const;
    await assert.rejects(() => projection.projectTask(b.scope, a.taskId, { ...write, status: 'READY' }), ScopeViolationError);
    await assert.rejects(() => projection.projectAttempt(b.scope, attemptId, { ...write, status: 'FAILED' }), ScopeViolationError);
    await assert.rejects(() => projection.projectRun(b.scope, a.runId, { ...write, status: 'DONE' }), ScopeViolationError);
    for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => projection.projectTask(a.scope, a.taskId, { ...write, seq, status: 'READY' }), RangeError, `seq ${seq}`);
    }
    await assert.rejects(() => projection.projectTask(a.scope, a.taskId, { ...write, workflowId: '', status: 'READY' }), RangeError);
    const row = await one(db, 'select status, projection_seq, workflow_id from tasks where id = $1', [a.taskId]);
    assert.deepEqual([row['status'], Number(row['projection_seq']), row['workflow_id']], ['PENDING', 0, null]);
  } finally {
    await db.close();
  }
});

test('set-once facts: the result commit and the evidence are written once, a repeat is a no-op, another value is refused', async () => {
  const { db, a, b } = await freshDb();
  try {
    const projection = new SqlProjectionWriter(db);
    const attemptId = await legacyAttempt(db, a);
    const commit = sha40('commit');
    assert.deepEqual(await projection.setResultSha(a.scope, attemptId, commit), { applied: true });
    assert.deepEqual(await projection.setResultSha(a.scope, attemptId, commit), { applied: false });
    await assert.rejects(() => projection.setResultSha(a.scope, attemptId, sha40('other')), ProjectionFactConflictError);
    await assert.rejects(() => projection.setResultSha(a.scope, attemptId, 'abc'), RangeError);
    await assert.rejects(() => projection.setResultSha(b.scope, attemptId, commit), ScopeViolationError);

    const evidence = await artifact(db, a, 'evidence-bundle', 'evidence');
    await db.query(
      `insert into artifacts (id, organization_id, project_id, attempt_id, kind, sha256, size_bytes, storage_key, content_type)
       values ($1, $2, $3, $4, 'evidence-draft', $5, 1, 'k/draft', 'application/json')`,
      ['D0000000000000000000000001', a.scope.organizationId, a.scope.projectId, attemptId, sha64('draft')],
    );
    await db.query(
      `insert into evidence_reservations (id, organization_id, project_id, repository_binding_id, attempt_id, draft_artifact_id, draft_sha256)
       values ($1, $2, $3, $4, $5, 'D0000000000000000000000001', $6)`,
      [evidence.artifactId, a.scope.organizationId, a.scope.projectId, a.bindingId, attemptId, sha64('draft')],
    );
    assert.deepEqual(await projection.attachEvidence(a.scope, attemptId, evidence), { applied: true });
    assert.deepEqual(await projection.attachEvidence(a.scope, attemptId, evidence), { applied: false });
    const otherEvidence = await artifact(db, a, 'evidence-bundle', 'other evidence');
    await assert.rejects(() => projection.attachEvidence(a.scope, attemptId, otherEvidence), ProjectionFactConflictError);
    const row = await one(db, 'select result_sha, evidence_artifact_id, evidence_sha256 from attempts where id = $1', [attemptId]);
    assert.deepEqual([row['result_sha'], row['evidence_artifact_id'], row['evidence_sha256']], [commit, evidence.artifactId, evidence.sha256]);
  } finally {
    await db.close();
  }
});

// --- workspace registry -------------------------------------------------------------

interface WorkspaceFixture {
  readonly attemptId: AttemptId;
  readonly lease: Lease;
  readonly record: { workspaceId: WorkspaceId; repositoryBindingId: RepositoryBindingId; attemptId: AttemptId; leaseId: string; hostId: string; pathRel: string; baseSha: string };
}

async function workspaceFixture(db: SqlClient, t: Tenant): Promise<WorkspaceFixture> {
  const attemptId = await legacyAttempt(db, t);
  const lease = await acquire(db, t, attemptId);
  const workspaceId = ulid() as WorkspaceId;
  return {
    attemptId,
    lease,
    record: {
      workspaceId, repositoryBindingId: t.bindingId, attemptId, leaseId: lease.leaseId, hostId: 'worker-1.local',
      pathRel: `${t.bindingId}/${workspaceId}`, baseSha: sha40('base'),
    },
  };
}

test('begin is idempotent by attempt and records the lease the workspace is created under', async () => {
  const { db, a } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const f = await workspaceFixture(db, a);
    const begun = await registry.begin(a.scope, f.record);
    assert.deepEqual(begun, { ...f.record, baselineRefs: [], state: 'CREATING' });
    assert.deepEqual(await registry.begin(a.scope, f.record), begun);
    const second = { ...f.record, workspaceId: ulid() as WorkspaceId };
    assert.deepEqual(await registry.begin(a.scope, second), begun, 'the attempt\'s stored record, not a second one');
    const rows = await db.query('select id, lease_epoch from workspaces where attempt_id = $1', [f.attemptId]);
    assert.deepEqual(rows.rows.map((r) => [r['id'], Number(r['lease_epoch'])]), [[f.record.workspaceId, f.lease.fencingEpoch]]);
    assert.deepEqual(await registry.findByAttempt(a.scope, f.attemptId), begun);
    assert.deepEqual(await registry.findById(a.scope, f.record.workspaceId), begun);
  } finally {
    await db.close();
  }
});

test('begin refuses a lease that is not the attempt\'s, and malformed fields before any write', async () => {
  const { db, a, b } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const f = await workspaceFixture(db, a);
    const g = await workspaceFixture(db, a);
    await assert.rejects(() => registry.begin(a.scope, { ...f.record, leaseId: g.lease.leaseId }), ScopeViolationError);
    await assert.rejects(() => registry.begin(b.scope, f.record), ScopeViolationError);
    const bad: Array<[string, Partial<WorkspaceFixture['record']>]> = [
      ['an absolute path', { pathRel: '/srv/ws' }],
      ['a parent segment', { pathRel: 'binding/../ws' }],
      ['a dot segment', { pathRel: './ws' }],
      ['an empty segment', { pathRel: 'binding//ws' }],
      ['a backslash', { pathRel: 'binding\\ws' }],
      ['a short base', { baseSha: 'abc' }],
      ['an empty host', { hostId: '' }],
      ['a host with a space', { hostId: 'worker 1' }],
      ['a malformed workspace id', { workspaceId: 'ws-1' as WorkspaceId }],
    ];
    for (const [label, change] of bad) {
      await assert.rejects(() => registry.begin(a.scope, { ...f.record, ...change }), RangeError, label);
    }
    assert.equal((await db.query('select 1 from workspaces', [])).rows.length, 0);
    await assert.rejects(() => db.query(
      `insert into workspaces (id, organization_id, project_id, repository_binding_id, attempt_id, lease_id, lease_epoch,
                               host_id, path_rel, base_sha, state)
       values ($1, $2, $3, $4, $5, $6, $7, 'w', 'a/../b', $8, 'CREATING')`,
      [ulid(), a.scope.organizationId, a.scope.projectId, a.bindingId, f.attemptId, f.lease.leaseId, f.lease.fencingEpoch, sha40('base')],
    ), refused, 'the database refuses a parent segment too');
    await assert.rejects(() => db.query(
      `insert into workspaces (id, organization_id, project_id, repository_binding_id, attempt_id, lease_id, lease_epoch,
                               host_id, path_rel, base_sha, state)
       values ($1, $2, $3, $4, $5, $6, $7, 'w', 'a/b', $8, 'CREATING')`,
      [ulid(), a.scope.organizationId, a.scope.projectId, a.bindingId, f.attemptId, f.lease.leaseId, f.lease.fencingEpoch + 1, sha40('base')],
    ), refused, 'the lease at another epoch');
  } finally {
    await db.close();
  }
});

test('begin needs the caller\'s lease live; a successor lease of the attempt gets the stored record', async () => {
  const { db, a } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const leases = new SqlWorkspaceLeaseRepository(db);
    const kills: Array<[string, (f: WorkspaceFixture) => Promise<unknown>]> = [
      ['released', (f) => leases.release(a.scope, f.lease.leaseId)],
      ['expired', (f) => expire(db, f.lease.leaseId)],
      ['quarantined', (f) => db.query(`update workspace_leases set state = 'QUARANTINED' where id = $1`, [f.lease.leaseId])],
      ['superseded', async (f) => { await expire(db, f.lease.leaseId); await acquire(db, a, f.attemptId, f.lease.branch); }],
    ];
    for (const [label, kill] of kills) {
      const f = await workspaceFixture(db, a);
      await kill(f);
      await assert.rejects(() => registry.begin(a.scope, f.record),
        (err: unknown) => err instanceof LeaseLostError && err.leaseId === f.lease.leaseId, label);
      assert.equal(await registry.findByAttempt(a.scope, f.attemptId), null, `${label}: nothing registered`);
    }
    const f = await workspaceFixture(db, a);
    const begun = await registry.begin(a.scope, f.record);
    await leases.release(a.scope, f.lease.leaseId);
    await assert.rejects(() => registry.begin(a.scope, f.record), LeaseLostError, 'a holder that lost its lease gets nothing back');
    const successor = await acquire(db, a, f.attemptId, f.lease.branch);
    assert.deepEqual(await registry.begin(a.scope, { ...f.record, leaseId: successor.leaseId }), begun,
      'the stored record, created under the earlier lease');
  } finally {
    await db.close();
  }
});

test('activate moves CREATING to ACTIVE with its baseline refs; a repeat returns the stored record', async () => {
  const { db, a } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const f = await workspaceFixture(db, a);
    await registry.begin(a.scope, f.record);
    const refs = ['refs/heads/main', 'refs/heads/release'];
    const active = await registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: refs });
    assert.deepEqual(active, { ...f.record, baselineRefs: refs, state: 'ACTIVE' });
    assert.deepEqual(await registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: ['refs/heads/x'] }), active);
    await assert.rejects(() => registry.activate(a.scope, { workspaceId: ulid() as WorkspaceId, baselineRefs: [] }), WorkspaceUnavailableError);
    await assert.rejects(
      () => registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: ['refs/heads/\u0000'] }), RangeError);
  } finally {
    await db.close();
  }
});

test('markState moves a workspace forward only, and an ended workspace is not usable', async () => {
  const { db, a } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const f = await workspaceFixture(db, a);
    await registry.begin(a.scope, f.record);
    await registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: [] });
    await registry.markState(a.scope, { workspaceId: f.record.workspaceId, state: 'QUARANTINED', reason: 'lease expired' });
    await registry.markState(a.scope, { workspaceId: f.record.workspaceId, state: 'QUARANTINED', reason: 'again' });
    let row = await one(db, 'select state, state_reason from workspaces where id = $1', [f.record.workspaceId]);
    assert.deepEqual([row['state'], row['state_reason']], ['QUARANTINED', 'lease expired'], 'the first reason stays');
    await assert.rejects(
      () => registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: [] }),
      (err: unknown) => err instanceof WorkspaceUnavailableError && err.reason === 'quarantined',
    );
    await registry.markState(a.scope, { workspaceId: f.record.workspaceId, state: 'CLEANED', reason: 'janitor' });
    await registry.markState(a.scope, { workspaceId: f.record.workspaceId, state: 'QUARANTINED', reason: 'late' });
    row = await one(db, 'select state, state_reason from workspaces where id = $1', [f.record.workspaceId]);
    assert.deepEqual([row['state'], row['state_reason']], ['CLEANED', 'janitor'], 'a cleaned workspace stays cleaned');
    await assert.rejects(
      () => registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: [] }),
      (err: unknown) => err instanceof WorkspaceUnavailableError && err.reason === 'missing',
    );
    await assert.rejects(() => registry.markState(a.scope, { workspaceId: f.record.workspaceId, state: 'CLEANED', reason: '' }), RangeError);
    await assert.rejects(
      () => registry.markState(a.scope, { workspaceId: ulid() as WorkspaceId, state: 'CLEANED', reason: 'x' }),
      WorkspaceUnavailableError,
    );
  } finally {
    await db.close();
  }
});

test('the database keeps a workspace\'s identity and refuses a backward state', async () => {
  const { db, a } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const f = await workspaceFixture(db, a);
    await registry.begin(a.scope, f.record);
    await registry.activate(a.scope, { workspaceId: f.record.workspaceId, baselineRefs: ['refs/heads/main'] });
    const id = f.record.workspaceId;
    for (const [label, sql] of [
      ['host', `update workspaces set host_id = 'worker-2' where id = $1`],
      ['path', `update workspaces set path_rel = 'a/b' where id = $1`],
      ['base', `update workspaces set base_sha = '${sha40('other')}' where id = $1`],
      ['back to creating', `update workspaces set state = 'CREATING' where id = $1`],
      ['baseline refs once active', `update workspaces set baseline_refs = '[]'::jsonb where id = $1`],
      ['ended without a reason', `update workspaces set state = 'CLEANED' where id = $1`],
    ] as const) {
      await assert.rejects(() => db.query(sql, [id]), refused, label);
    }
    await db.query(`update workspaces set state = 'CLEANED', state_reason = 'done' where id = $1`, [id]);
    await assert.rejects(() => db.query(`update workspaces set state = 'ACTIVE', state_reason = null where id = $1`, [id]), refused);
    await assert.rejects(() => db.query(`update workspaces set state_reason = 'rewritten' where id = $1`, [id]), refused);
  } finally {
    await db.close();
  }
});

test('registry reads stay in the caller\'s tenant', async () => {
  const { db, a, b } = await freshDb();
  try {
    const registry = new SqlWorkspaceRegistry(db);
    const f = await workspaceFixture(db, a);
    await registry.begin(a.scope, f.record);
    assert.equal(await registry.findByAttempt(b.scope, f.attemptId), null);
    assert.equal(await registry.findById(b.scope, f.record.workspaceId), null);
    await assert.rejects(() => registry.activate(b.scope, { workspaceId: f.record.workspaceId, baselineRefs: [] }), WorkspaceUnavailableError);
    await assert.rejects(
      () => registry.markState(b.scope, { workspaceId: f.record.workspaceId, state: 'QUARANTINED', reason: 'x' }),
      WorkspaceUnavailableError,
    );
    assert.equal((await one(db, 'select state from workspaces where id = $1', [f.record.workspaceId]))['state'], 'CREATING');
  } finally {
    await db.close();
  }
});

// --- workspace resolver and lease history ---------------------------------------------

async function activeWorkspace(db: SqlClient, t: Tenant): Promise<WorkspaceFixture> {
  const f = await workspaceFixture(db, t);
  const registry = new SqlWorkspaceRegistry(db);
  await registry.begin(t.scope, f.record);
  await registry.activate(t.scope, { workspaceId: f.record.workspaceId, baselineRefs: [] });
  return f;
}

test('the resolver resolves the attempt\'s workspace for its tenant, its held lease and that lease\'s epoch', async () => {
  const { db, a } = await freshDb();
  try {
    const resolver = new SqlAssuranceWorkspaceResolver(db);
    const f = await activeWorkspace(db, a);
    const query = { attemptId: f.attemptId, leaseId: f.lease.leaseId, fencingEpoch: f.lease.fencingEpoch };
    assert.deepEqual(await resolver.resolve(a.scope, query), {
      kind: 'resolved', workspace: { workspaceId: f.record.workspaceId, leaseId: f.lease.leaseId },
    });
  } finally {
    await db.close();
  }
});

test('wrong tenant, wrong lease and stale epoch each fail closed, checked in that order', async () => {
  const { db, a, b } = await freshDb();
  try {
    const resolver = new SqlAssuranceWorkspaceResolver(db);
    const f = await activeWorkspace(db, a);
    const g = await activeWorkspace(db, a);
    const ok = { attemptId: f.attemptId, leaseId: f.lease.leaseId, fencingEpoch: f.lease.fencingEpoch };
    const cases: Array<[string, TenantScope, typeof ok, string]> = [
      ['another tenant', b.scope, ok, 'not-in-scope'],
      ['another tenant with a stale epoch', b.scope, { ...ok, fencingEpoch: 99 }, 'not-in-scope'],
      ['an attempt id that is not one', a.scope, { ...ok, attemptId: 'attempt-1' as AttemptId }, 'not-in-scope'],
      ['another attempt\'s lease', a.scope, { ...ok, leaseId: g.lease.leaseId }, 'lease-not-held'],
      ['an unknown lease', a.scope, { ...ok, leaseId: ulid() }, 'lease-not-held'],
      ['another attempt\'s lease and a stale epoch', a.scope, { ...ok, leaseId: g.lease.leaseId, fencingEpoch: 99 }, 'lease-not-held'],
      ['a stale epoch', a.scope, { ...ok, fencingEpoch: f.lease.fencingEpoch + 1 }, 'stale-epoch'],
      ['epoch zero', a.scope, { ...ok, fencingEpoch: 0 }, 'stale-epoch'],
      ['a fractional epoch', a.scope, { ...ok, fencingEpoch: 1.5 }, 'stale-epoch'],
    ];
    for (const [label, scope, query, reason] of cases) {
      assert.deepEqual(await resolver.resolve(scope, query), { kind: 'refused', reason }, label);
    }
  } finally {
    await db.close();
  }
});

test('a released, expired, quarantined or superseded lease is not active', async () => {
  const { db, a } = await freshDb();
  try {
    const resolver = new SqlAssuranceWorkspaceResolver(db);
    const leases = new SqlWorkspaceLeaseRepository(db);
    const queryOf = (f: WorkspaceFixture, lease = f.lease) => ({ attemptId: f.attemptId, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch });

    const released = await activeWorkspace(db, a);
    await leases.release(a.scope, released.lease.leaseId);
    assert.deepEqual(await resolver.resolve(a.scope, queryOf(released)), { kind: 'refused', reason: 'lease-not-active' }, 'released');

    const expired = await activeWorkspace(db, a);
    await expire(db, expired.lease.leaseId);
    assert.deepEqual(await resolver.resolve(a.scope, queryOf(expired)), { kind: 'refused', reason: 'lease-not-active' }, 'expired');

    const quarantined = await activeWorkspace(db, a);
    await db.query(`update workspace_leases set state = 'QUARANTINED' where id = $1`, [quarantined.lease.leaseId]);
    assert.deepEqual(await resolver.resolve(a.scope, queryOf(quarantined)), { kind: 'refused', reason: 'lease-not-active' }, 'quarantined');

    const superseded = await activeWorkspace(db, a);
    await expire(db, superseded.lease.leaseId);
    const successor = await acquire(db, a, superseded.attemptId, superseded.lease.branch);
    assert.ok(successor.fencingEpoch > superseded.lease.fencingEpoch);
    assert.deepEqual(await resolver.resolve(a.scope, queryOf(superseded)), { kind: 'refused', reason: 'lease-not-held' }, 'superseded');
    assert.deepEqual(
      await resolver.resolve(a.scope, { ...queryOf(superseded, successor), fencingEpoch: superseded.lease.fencingEpoch }),
      { kind: 'refused', reason: 'stale-epoch' }, 'the successor\'s id with the old epoch',
    );
    assert.deepEqual(await resolver.resolve(a.scope, queryOf(superseded, successor)), {
      kind: 'resolved', workspace: { workspaceId: superseded.record.workspaceId, leaseId: successor.leaseId },
    }, 'the successor of the same attempt resolves the attempt\'s workspace');
  } finally {
    await db.close();
  }
});

test('a held lease with no usable workspace is not resolved', async () => {
  const { db, a } = await freshDb();
  try {
    const resolver = new SqlAssuranceWorkspaceResolver(db);
    const registry = new SqlWorkspaceRegistry(db);
    const unavailable = (reason: string) => (err: unknown) => err instanceof WorkspaceUnavailableError && err.reason === reason;

    const none = await workspaceFixture(db, a);
    const q = (f: WorkspaceFixture) => ({ attemptId: f.attemptId, leaseId: f.lease.leaseId, fencingEpoch: f.lease.fencingEpoch });
    await assert.rejects(() => resolver.resolve(a.scope, q(none)), unavailable('missing'), 'no registry row');

    const creating = await workspaceFixture(db, a);
    await registry.begin(a.scope, creating.record);
    await assert.rejects(() => resolver.resolve(a.scope, q(creating)), unavailable('missing'), 'still CREATING');

    const quarantined = await activeWorkspace(db, a);
    await registry.markState(a.scope, { workspaceId: quarantined.record.workspaceId, state: 'QUARANTINED', reason: 'x' });
    await assert.rejects(() => resolver.resolve(a.scope, q(quarantined)), unavailable('quarantined'));

    const cleaned = await activeWorkspace(db, a);
    await registry.markState(a.scope, { workspaceId: cleaned.record.workspaceId, state: 'CLEANED', reason: 'x' });
    await assert.rejects(() => resolver.resolve(a.scope, q(cleaned)), unavailable('missing'));
  } finally {
    await db.close();
  }
});

test('findLease returns the fence of the attempt\'s latest lease, or null when it never held one', async () => {
  const { db, a, b } = await freshDb();
  try {
    const history = new SqlAttemptLeaseHistory(db);
    const attemptId = await legacyAttempt(db, a);
    assert.equal(await history.findLease(a.scope, attemptId), null);
    const first = await acquire(db, a, attemptId);
    assert.deepEqual(await history.findLease(a.scope, attemptId), { leaseId: first.leaseId, fencingEpoch: first.fencingEpoch });
    await new SqlWorkspaceLeaseRepository(db).release(a.scope, first.leaseId);
    assert.deepEqual(await history.findLease(a.scope, attemptId), { leaseId: first.leaseId, fencingEpoch: first.fencingEpoch },
      'a released lease is still the attempt\'s history');
    const second = await acquire(db, a, attemptId);
    assert.deepEqual(await history.findLease(a.scope, attemptId), { leaseId: second.leaseId, fencingEpoch: second.fencingEpoch });
    await assert.rejects(() => history.findLease(b.scope, attemptId), ScopeViolationError);
    await assert.rejects(() => history.findLease(a.scope, ulid() as AttemptId), ScopeViolationError);
  } finally {
    await db.close();
  }
});

test('findLease returns the lease of the highest epoch, whatever the grant timestamps say', async () => {
  const { db, a } = await freshDb();
  try {
    const attemptId = await legacyAttempt(db, a);
    const first = await acquire(db, a, attemptId);
    await new SqlWorkspaceLeaseRepository(db).release(a.scope, first.leaseId);
    const second = await acquire(db, a, attemptId);
    assert.ok(second.fencingEpoch > first.fencingEpoch);
    // acquired_at is the granting transaction's now(): a clock step back, or a grant whose transaction began
    // earlier, puts an older lease after a newer one.
    await db.query(`update workspace_leases set acquired_at = acquired_at + interval '1 hour' where id = $1`, [first.leaseId]);
    assert.deepEqual(await new SqlAttemptLeaseHistory(db).findLease(a.scope, attemptId),
      { leaseId: second.leaseId, fencingEpoch: second.fencingEpoch });
  } finally {
    await db.close();
  }
});

test('renewal extends a live lease and reports a released, expired, quarantined or superseded lease lost', async () => {
  const { db, a } = await freshDb();
  try {
    const leases = new SqlWorkspaceLeaseRepository(db);
    const expiry = async (id: string) => new Date(String((await one(db, 'select expires_at from workspace_leases where id = $1', [id]))['expires_at'])).getTime();
    const live = await acquire(db, a, await legacyAttempt(db, a));
    await db.query(`update workspace_leases set expires_at = clock_timestamp() + interval '1 second' where id = $1`, [live.leaseId]);
    const before = await expiry(live.leaseId);
    await leases.heartbeat(a.scope, live.leaseId);
    assert.ok(await expiry(live.leaseId) > before + 60_000, 'renewal extends the expiry by the lease TTL');

    const lost = (leaseId: string) => (err: unknown) => err instanceof LeaseLostError && err.leaseId === leaseId;
    const released = await acquire(db, a, await legacyAttempt(db, a));
    await leases.release(a.scope, released.leaseId);
    await assert.rejects(() => leases.heartbeat(a.scope, released.leaseId), lost(released.leaseId), 'released');
    const expired = await acquire(db, a, await legacyAttempt(db, a));
    await expire(db, expired.leaseId);
    await assert.rejects(() => leases.heartbeat(a.scope, expired.leaseId), lost(expired.leaseId), 'expired');
    const quarantined = await acquire(db, a, await legacyAttempt(db, a));
    await db.query(`update workspace_leases set state = 'QUARANTINED' where id = $1`, [quarantined.leaseId]);
    await assert.rejects(() => leases.heartbeat(a.scope, quarantined.leaseId), lost(quarantined.leaseId), 'quarantined');
    const attemptId = await legacyAttempt(db, a);
    const superseded = await acquire(db, a, attemptId);
    await expire(db, superseded.leaseId);
    await acquire(db, a, attemptId);
    await assert.rejects(() => leases.heartbeat(a.scope, superseded.leaseId), lost(superseded.leaseId), 'superseded');
  } finally {
    await db.close();
  }
});

// --- approvals --------------------------------------------------------------------------

interface ApprovalFixture {
  readonly workflowId: string;
  readonly attemptId: AttemptId;
  readonly budget: OpenApprovalRequestInput;
  readonly publish: OpenApprovalRequestInput;
}

async function approvalFixture(db: SqlClient, t: Tenant): Promise<ApprovalFixture> {
  const workflowId = `asep-task-${t.taskId}`;
  const attemptId = await legacyAttempt(db, t);
  const base = {
    workflowId, runId: t.runId, taskId: t.taskId, requestedBy: 'harness', expiresAt: '2999-01-01T00:00:00.000Z',
  } as const;
  return {
    workflowId,
    attemptId,
    budget: { ...base, approvalRequestId: `${workflowId}:1`, attemptId: null, kind: 'budget-extension', shortfallMicroUsd: 2_500_000 },
    publish: { ...base, approvalRequestId: `${workflowId}:2`, attemptId, kind: 'publish-change', shortfallMicroUsd: null },
  };
}

const HUMAN = `01H${'Z'.repeat(22)}0`;
const OTHER_HUMAN = `01H${'Y'.repeat(22)}0`;

function decisionOf(request: OpenApprovalRequestInput, extra: Partial<RecordDecisionInput> = {}): RecordDecisionInput {
  return {
    decisionId: ulid(), approvalRequestId: request.approvalRequestId, decision: 'approve', decidedBy: HUMAN,
    rationale: 'checked the evidence', extensionMicroUsd: request.kind === 'budget-extension' ? 1_000_000 : null, ...extra,
  };
}

test('an approval request opens once; a repeat is a no-op and other facts under its id are refused', async () => {
  const { db, a } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    const opened = await approvals.openRequest(a.scope, f.budget);
    assert.deepEqual(opened, { request: { ...f.budget, status: 'PENDING' }, created: true });
    assert.deepEqual(await approvals.openRequest(a.scope, f.budget), { ...opened, created: false });
    for (const [label, change] of [
      ['another shortfall', { shortfallMicroUsd: 2_500_001 }],
      ['another expiry', { expiresAt: '2999-01-02T00:00:00.000Z' }],
      ['another requester', { requestedBy: HUMAN }],
    ] as const) {
      await assert.rejects(() => approvals.openRequest(a.scope, { ...f.budget, ...change }), ApprovalRequestConflictError, label);
    }
    const rows = await db.query('select payload from approval_requests where id = $1', [f.budget.approvalRequestId]);
    assert.deepEqual(rows.rows.map((r) => r['payload']), [{ shortfallMicroUsd: 2_500_000 }]);
    assert.deepEqual(await approvals.findRequest(a.scope, f.budget.approvalRequestId), opened.request);
  } finally {
    await db.close();
  }
});

test('the request is the workflow\'s, its payload a closed shape per kind, its subject in its run', async () => {
  const { db, a, b } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    const bad: Array<[string, Partial<OpenApprovalRequestInput>]> = [
      ['an id that is not the workflow\'s', { approvalRequestId: 'asep-task-other:1' }],
      ['a gate number that is not one', { approvalRequestId: `${f.workflowId}:x` }],
      ['no shortfall on a budget extension', { shortfallMicroUsd: null }],
      ['a fractional shortfall', { shortfallMicroUsd: 0.5 }],
      ['a zero shortfall', { shortfallMicroUsd: 0 }],
      ['a requester that is not a principal', { requestedBy: 'someone' }],
      ['an expiry that is not a time', { expiresAt: 'tomorrow' }],
    ];
    for (const [label, change] of bad) {
      await assert.rejects(() => approvals.openRequest(a.scope, { ...f.budget, ...change }), RangeError, label);
    }
    await assert.rejects(() => approvals.openRequest(a.scope, { ...f.publish, shortfallMicroUsd: 5 }), RangeError, 'an amount on a publication');
    await assert.rejects(() => approvals.openRequest(a.scope, { ...f.publish, attemptId: null }), RangeError, 'a publication without its attempt');
    await assert.rejects(() => approvals.openRequest(b.scope, f.budget), refused, 'another tenant\'s run');
    const insert = (payload: string, kind = 'budget-extension') => db.query(
      `insert into approval_requests (id, organization_id, project_id, run_id, task_id, workflow_id, kind, requested_by, payload, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'harness', $8::jsonb, now())`,
      [`${f.workflowId}:9`, a.scope.organizationId, a.scope.projectId, a.runId, a.taskId, f.workflowId, kind, payload],
    );
    await assert.rejects(() => insert('{"shortfallMicroUsd": 5, "note": "x"}'), refused, 'an extra key');
    await assert.rejects(() => insert('{"shortfallMicroUsd": "5"}'), refused, 'a string amount');
    await assert.rejects(() => insert('{"shortfallMicroUsd": 1.5}'), refused, 'a fractional amount');
    await assert.rejects(() => insert('{}', 'publish-change'), refused, 'a publication without its attempt');
    const otherRun = await new RunRepository(db).create(a.scope, { repositoryBindingId: a.bindingId, status: 'EXECUTING', risk: 'R0' });
    const otherRunTask = await new TaskRepository(db).create(a.scope, { runId: otherRun.id, repositoryBindingId: a.bindingId, risk: 'R0' });
    await assert.rejects(() => db.query(
      `insert into approval_requests (id, organization_id, project_id, run_id, task_id, workflow_id, kind, requested_by, payload, expires_at)
       values ($1, $2, $3, $4, $5, $6, 'budget-extension', 'harness', '{"shortfallMicroUsd": 5}', now())`,
      [`${f.workflowId}:9`, a.scope.organizationId, a.scope.projectId, a.runId, otherRunTask.id, f.workflowId],
    ), refused, 'a task of another run');
  } finally {
    await db.close();
  }
});

function failingOn(db: SqlClient, statement: string): SqlClient {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction((tx) => fn({
      query: (text: string, params?: Parameters<SqlExecutor['query']>[1]) => (
        text.includes(statement) ? Promise.reject(new Error(`injected failure at ${statement}`)) : tx.query(text, params)),
    })),
    ping: () => db.ping(),
    close: () => db.close(),
  };
}

test('a decision and its delivery row commit in one transaction', async () => {
  const { db, a } = await freshDb();
  try {
    const f = await approvalFixture(db, a);
    await new SqlApprovalStore(db).openRequest(a.scope, f.budget);
    const decision = decisionOf(f.budget);
    await assert.rejects(
      () => new SqlApprovalStore(failingOn(db, 'insert into approval_decision_deliveries')).recordDecision(a.scope, decision),
      /injected failure/,
    );
    const counts = await one(db,
      `select (select count(*)::int from approval_decisions) as decisions,
              (select count(*)::int from approval_decision_deliveries) as deliveries,
              (select status from approval_requests where id = $1) as status`, [f.budget.approvalRequestId]);
    assert.deepEqual(counts, { decisions: 0, deliveries: 0, status: 'PENDING' });
    const recorded = await new SqlApprovalStore(db).recordDecision(a.scope, decision);
    assert.equal(recorded.replayed, false);
    const delivery = await one(db, 'select workflow_id, update_id, status, attempts from approval_decision_deliveries where decision_id = $1', [decision.decisionId]);
    assert.deepEqual(delivery, { workflow_id: f.workflowId, update_id: decision.decisionId, status: 'PENDING', attempts: 0 });
    assert.equal((await one(db, 'select status from approval_requests where id = $1', [f.budget.approvalRequestId]))['status'], 'APPROVED');
  } finally {
    await db.close();
  }
});

test('an identical decision returns the original and makes its delivery due again; another decision is refused', async () => {
  const { db, a } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    await approvals.openRequest(a.scope, f.publish);
    const decision = decisionOf(f.publish, { decision: 'reject' });
    const first = await approvals.recordDecision(a.scope, decision);
    assert.deepEqual({ ...first.decision, decidedAt: 'x' }, { ...decision, decidedAt: 'x' });
    await approvals.markDelivered(a.scope, decision.decisionId);
    const again = await approvals.recordDecision(a.scope, decision);
    assert.deepEqual(again, { decision: first.decision, replayed: true });
    const delivery = await approvals.findDelivery(a.scope, decision.decisionId);
    assert.equal(delivery?.status, 'PENDING', 'a retried POST re-delivers');
    for (const [label, other] of [
      ['the other value', { ...decision, decision: 'approve' as const }],
      ['another rationale', { ...decision, rationale: 'changed my mind' }],
      ['another decider', { ...decision, decidedBy: OTHER_HUMAN }],
      ['another decision id', { ...decision, decisionId: ulid() }],
    ] as const) {
      await assert.rejects(() => approvals.recordDecision(a.scope, other), ApprovalDecisionConflictError, label);
    }
    const counts = await one(db,
      `select (select count(*)::int from approval_decisions where request_id = $1) as decisions,
              (select count(*)::int from approval_decision_deliveries) as deliveries`, [f.publish.approvalRequestId]);
    assert.deepEqual(counts, { decisions: 1, deliveries: 1 });
    assert.deepEqual(await approvals.findDecision(a.scope, f.publish.approvalRequestId), first.decision);
  } finally {
    await db.close();
  }
});

test('a decision on a request that is closed, expired or another tenant\'s is refused', async () => {
  const { db, a, b } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    await approvals.openRequest(a.scope, f.budget);
    await approvals.openRequest(a.scope, { ...f.publish, expiresAt: '2000-01-01T00:00:00.000Z' });
    assert.equal(await approvals.closeRequest(a.scope, f.budget.approvalRequestId, 'EXPIRED'), 'EXPIRED');
    await assert.rejects(() => approvals.recordDecision(a.scope, decisionOf(f.budget)),
      (err: unknown) => err instanceof ApprovalRequestClosedError && err.status === 'EXPIRED' && !err.pastExpiry,
      'expired by the workflow\'s timer');
    await assert.rejects(() => approvals.recordDecision(a.scope, decisionOf(f.publish)),
      (err: unknown) => err instanceof ApprovalRequestClosedError && err.status === 'PENDING' && err.pastExpiry,
      'past its expiry time, before the timer closed it');
    await assert.rejects(() => approvals.recordDecision(b.scope, decisionOf(f.publish)), ScopeViolationError);
    assert.equal((await db.query('select 1 from approval_decisions', [])).rows.length, 0);
  } finally {
    await db.close();
  }
});

test('an extension amount comes only with a budget-extension approve, in exact micro-USD', async () => {
  const { db, a } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    await approvals.openRequest(a.scope, f.budget);
    await approvals.openRequest(a.scope, f.publish);
    const bad: Array<[string, RecordDecisionInput]> = [
      ['an approve without an amount', decisionOf(f.budget, { extensionMicroUsd: null })],
      ['a zero amount', decisionOf(f.budget, { extensionMicroUsd: 0 })],
      ['a fractional amount', decisionOf(f.budget, { extensionMicroUsd: 1.5 })],
      ['an unsafe amount', decisionOf(f.budget, { extensionMicroUsd: Number.MAX_SAFE_INTEGER + 1 })],
      ['a reject with an amount', decisionOf(f.budget, { decision: 'reject', extensionMicroUsd: 5 })],
      ['a publication approve with an amount', decisionOf(f.publish, { extensionMicroUsd: 5 })],
      ['an empty rationale', decisionOf(f.publish, { rationale: '' })],
      ['a decider that is not a principal id', decisionOf(f.publish, { decidedBy: 'harness' })],
      ['a decision id that is not one', decisionOf(f.publish, { decisionId: 'd-1' })],
    ];
    for (const [label, input] of bad) {
      await assert.rejects(() => approvals.recordDecision(a.scope, input), RangeError, label);
    }
    const recorded = await approvals.recordDecision(a.scope, decisionOf(f.budget, { extensionMicroUsd: 1_234_567 }));
    assert.equal(recorded.decision.extensionMicroUsd, 1_234_567);
    const stored = await one(db, 'select extension_usd::text as usd from approval_decisions where request_id = $1', [f.budget.approvalRequestId]);
    assert.equal(Number(stored['usd']), 1.234567);
    await assert.rejects(() => db.query(`update approval_decisions set extension_usd = 0.0000001 where request_id = $1`, [f.budget.approvalRequestId]), refused);
  } finally {
    await db.close();
  }
});

test('closeRequest expires or cancels a pending request once and leaves a decided one as it is', async () => {
  const { db, a, b } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    await approvals.openRequest(a.scope, f.budget);
    await approvals.openRequest(a.scope, f.publish);
    assert.equal(await approvals.closeRequest(a.scope, f.budget.approvalRequestId, 'CANCELLED'), 'CANCELLED');
    assert.equal(await approvals.closeRequest(a.scope, f.budget.approvalRequestId, 'EXPIRED'), 'CANCELLED');
    await approvals.recordDecision(a.scope, decisionOf(f.publish));
    assert.equal(await approvals.closeRequest(a.scope, f.publish.approvalRequestId, 'EXPIRED'), 'APPROVED');
    await assert.rejects(() => approvals.closeRequest(b.scope, f.publish.approvalRequestId, 'EXPIRED'), ScopeViolationError);
  } finally {
    await db.close();
  }
});

test('the delivery relay\'s rows: due, failed with a closed code and a backoff, delivered, target closed', async () => {
  const { db, a } = await freshDb();
  try {
    const approvals = new SqlApprovalStore(db);
    const f = await approvalFixture(db, a);
    await approvals.openRequest(a.scope, f.budget);
    await approvals.openRequest(a.scope, f.publish);
    const one1 = decisionOf(f.budget);
    const two = decisionOf(f.publish);
    await approvals.recordDecision(a.scope, one1);
    await approvals.recordDecision(a.scope, two);
    const due = await approvals.dueDeliveries(10);
    assert.deepEqual(new Set(due.map((d) => d.decisionId)), new Set([one1.decisionId, two.decisionId]));
    assert.ok(due.every((d) => d.workflowId === f.workflowId && d.updateId === d.decisionId && d.scope.projectId === a.scope.projectId));

    await approvals.recordDeliveryFailure(a.scope, { decisionId: one1.decisionId, errorCode: 'unavailable', retryAfterMs: 60_000 });
    const failed = await approvals.findDelivery(a.scope, one1.decisionId);
    assert.deepEqual([failed?.status, failed?.attempts, failed?.lastErrorCode], ['PENDING', 1, 'unavailable']);
    assert.deepEqual((await approvals.dueDeliveries(10)).map((d) => d.decisionId), [two.decisionId], 'backing off');
    await assert.rejects(() => approvals.recordDeliveryFailure(a.scope, { decisionId: one1.decisionId, errorCode: 'Connection reset by peer', retryAfterMs: 1 }), RangeError);

    await approvals.markDelivered(a.scope, two.decisionId);
    await approvals.markDelivered(a.scope, two.decisionId);
    await approvals.markTargetClosed(a.scope, one1.decisionId);
    await approvals.recordDeliveryFailure(a.scope, { decisionId: one1.decisionId, errorCode: 'late', retryAfterMs: 0 });
    assert.deepEqual([(await approvals.findDelivery(a.scope, two.decisionId))?.status, (await approvals.findDelivery(a.scope, one1.decisionId))?.status],
      ['DELIVERED', 'TARGET_CLOSED']);
    assert.deepEqual(await approvals.dueDeliveries(10), []);
    await approvals.recordDecision(a.scope, one1);
    assert.equal((await approvals.findDelivery(a.scope, one1.decisionId))?.status, 'TARGET_CLOSED', 'a closed target stays closed on a retry');
  } finally {
    await db.close();
  }
});

// --- ledger and governance --------------------------------------------------------------

function usage(t: Tenant, attemptId: AttemptId, extra: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    idempotencyKey: `${attemptId}:attempt-usage`, runId: t.runId, taskId: t.taskId, attemptId, entryKind: 'attempt-usage',
    costMicroUsd: 1_500_000, usageOutOfBound: false, inputTokens: 1000, outputTokens: 200, toolCalls: 7, wallClockMs: 60_000,
    source: 'provider-reported', ...extra,
  };
}

test('a ledger entry is appended once per key; other facts under the same key are refused', async () => {
  const { db, a } = await freshDb();
  try {
    const ledger = new SqlBudgetLedger(db);
    const attemptId = await legacyAttempt(db, a);
    const entry = usage(a, attemptId);
    assert.deepEqual(await ledger.append(a.scope, entry), { appended: true });
    assert.deepEqual(await ledger.append(a.scope, entry), { appended: false });
    for (const [label, change] of [
      ['another cost', { costMicroUsd: 1_500_001 }],
      ['other tool calls', { toolCalls: 8 }],
      ['another source', { source: 'harness-measured' }],
    ] as const) {
      await assert.rejects(() => ledger.append(a.scope, { ...entry, ...change }), BudgetLedgerConflictError, label);
    }
    assert.equal((await db.query('select 1 from budget_ledger', [])).rows.length, 1);
  } finally {
    await db.close();
  }
});

test('a ledger replay with any field changed under the same key is refused and changes nothing', async () => {
  const { db, a } = await freshDb();
  try {
    const ledger = new SqlBudgetLedger(db);
    const attemptId = await legacyAttempt(db, a);
    const sibling = await legacyAttempt(db, a);
    const otherTask = await newTask(db, a);
    const otherTaskAttempt = await legacyAttempt(db, a, otherTask);
    const otherRun = await new RunRepository(db).create(a.scope, { repositoryBindingId: a.bindingId, status: 'EXECUTING', risk: 'R0' });
    const otherRunTask = (await new TaskRepository(db).create(a.scope, { runId: otherRun.id, repositoryBindingId: a.bindingId, risk: 'R0' })).id;
    const otherRunAttempt = await legacyAttempt(db, a, otherRunTask);
    const entry = usage(a, attemptId);
    const overrun = usage(a, attemptId, { idempotencyKey: `${attemptId}:overrun`, entryKind: 'overrun', source: 'harness-measured' });
    await ledger.append(a.scope, entry);
    await ledger.append(a.scope, overrun);
    const changes: Array<[LedgerEntryInput, Partial<LedgerEntryInput>]> = [
      [entry, { runId: otherRun.id, taskId: otherRunTask, attemptId: otherRunAttempt }],
      [entry, { taskId: otherTask, attemptId: otherTaskAttempt }],
      [entry, { attemptId: sibling }],
      [entry, { entryKind: 'overrun', source: 'harness-measured' }],
      [entry, { costMicroUsd: 1_500_001 }],
      [entry, { costMicroUsd: 0 }],
      [overrun, { usageOutOfBound: true }],
      [entry, { inputTokens: 1001 }],
      [entry, { inputTokens: null }],
      [entry, { outputTokens: 201 }],
      [entry, { outputTokens: null }],
      [entry, { toolCalls: 8 }],
      [entry, { toolCalls: null }],
      [entry, { wallClockMs: 60_001 }],
      [entry, { wallClockMs: null }],
      [entry, { source: 'harness-measured' }],
    ];
    const covered = new Set(changes.flatMap(([, change]) => Object.keys(change)));
    assert.deepEqual([...covered].sort(), Object.keys(entry).filter((k) => k !== 'idempotencyKey').sort(),
      'every field but the key is changed by some case');
    for (const [base, change] of changes) {
      await assert.rejects(() => ledger.append(a.scope, { ...base, ...change }), BudgetLedgerConflictError, JSON.stringify(change));
    }
    const stored = await db.query(
      `select idempotency_key, run_id, task_id, attempt_id, entry_kind, cost_usd::text as usd, usage_out_of_bound,
              input_tokens::int as input_tokens, output_tokens::int as output_tokens, tool_calls, wall_clock_ms::int as wall_clock_ms, source
         from budget_ledger where organization_id = $1 order by idempotency_key`, [a.scope.organizationId]);
    assert.deepEqual(stored.rows.map((r) => ({ ...r, usd: Number(r['usd']) })), [entry, overrun].map((e) => ({
      idempotency_key: e.idempotencyKey, run_id: e.runId, task_id: e.taskId, attempt_id: e.attemptId, entry_kind: e.entryKind,
      usd: e.costMicroUsd / 1_000_000, usage_out_of_bound: e.usageOutOfBound, input_tokens: e.inputTokens,
      output_tokens: e.outputTokens, tool_calls: e.toolCalls, wall_clock_ms: e.wallClockMs, source: e.source,
    })).sort((x, y) => x.idempotency_key.localeCompare(y.idempotency_key)));
  } finally {
    await db.close();
  }
});

test('the ledger is append-only in the database: an entry is never updated or deleted', async () => {
  const { db, a } = await freshDb();
  try {
    const attemptId = await legacyAttempt(db, a);
    await new SqlBudgetLedger(db).append(a.scope, usage(a, attemptId));
    const key = `${attemptId}:attempt-usage`;
    const appendOnly = (err: unknown) => /append-only/i.test((err as Error).message) && (err as { code?: unknown }).code === '55000';
    await assert.rejects(() => db.query('update budget_ledger set cost_usd = 0 where idempotency_key = $1', [key]), appendOnly, 'update');
    await assert.rejects(() => db.query('delete from budget_ledger where idempotency_key = $1', [key]), appendOnly, 'delete');
    assert.equal(Number((await one(db, 'select cost_usd::text as usd from budget_ledger where idempotency_key = $1', [key]))['usd']), 1.5);
  } finally {
    await db.close();
  }
});

test('ledger money is exact micro-USD and totals add up per run and per task', async () => {
  const { db, a, b } = await freshDb();
  try {
    const ledger = new SqlBudgetLedger(db);
    const first = await legacyAttempt(db, a);
    const otherTask = await newTask(db, a);
    const second = await legacyAttempt(db, a, otherTask);
    await ledger.append(a.scope, usage(a, first, { costMicroUsd: 1_234_567 }));
    await ledger.append(a.scope, usage(a, first, {
      idempotencyKey: `${first}:overrun`, entryKind: 'overrun', costMicroUsd: 1, usageOutOfBound: true, source: 'harness-measured',
    }));
    await ledger.append(a.scope, {
      ...usage(a, first), idempotencyKey: `asep-task-${a.taskId}:3:extension`, attemptId: null, entryKind: 'extension-granted',
      costMicroUsd: 2_000_000, source: 'human-granted', inputTokens: null, outputTokens: null, toolCalls: null, wallClockMs: null,
    });
    await ledger.append(a.scope, usage(a, second, { taskId: otherTask, costMicroUsd: 3 }));
    assert.deepEqual(await ledger.totals(a.scope, { runId: a.runId, taskId: a.taskId }), {
      attemptUsageMicroUsd: 1_234_567, overrunMicroUsd: 1, extensionGrantedMicroUsd: 2_000_000, entries: 3,
    });
    assert.deepEqual(await ledger.totals(a.scope, { runId: a.runId }), {
      attemptUsageMicroUsd: 1_234_570, overrunMicroUsd: 1, extensionGrantedMicroUsd: 2_000_000, entries: 4,
    });
    assert.deepEqual(await ledger.totals(b.scope, { runId: a.runId }), {
      attemptUsageMicroUsd: 0, overrunMicroUsd: 0, extensionGrantedMicroUsd: 0, entries: 0,
    });
    const stored = await one(db, `select cost_usd::text as usd from budget_ledger where idempotency_key = $1`, [`${first}:attempt-usage`]);
    assert.equal(Number(stored['usd']), 1.234567);
    for (const [label, change] of [
      ['a fractional amount', { costMicroUsd: 0.5 }],
      ['a negative amount', { costMicroUsd: -1 }],
      ['an unsafe amount', { costMicroUsd: Number.MAX_SAFE_INTEGER + 1 }],
      ['a key with a space', { idempotencyKey: 'a b' }],
      ['negative tokens', { inputTokens: -1 }],
    ] as const) {
      await assert.rejects(() => ledger.append(a.scope, usage(a, first, { idempotencyKey: `${first}:x`, ...change })), RangeError, label);
    }
  } finally {
    await db.close();
  }
});

test('the ledger\'s database rules: a grant is human, usage is an attempt\'s, the attempt its task\'s, the tenant the caller\'s', async () => {
  const { db, a, b } = await freshDb();
  try {
    const ledger = new SqlBudgetLedger(db);
    const attemptId = await legacyAttempt(db, a);
    const otherTask = await newTask(db, a);
    const cases: Array<[string, LedgerEntryInput]> = [
      ['a grant measured by a provider', usage(a, attemptId, { entryKind: 'extension-granted', attemptId: null })],
      ['usage granted by a human', usage(a, attemptId, { source: 'human-granted' })],
      ['usage without an attempt', usage(a, attemptId, { attemptId: null })],
      ['an out-of-bound flag on usage', usage(a, attemptId, { usageOutOfBound: true })],
      ['an attempt of another task', usage(a, attemptId, { taskId: otherTask })],
      ['a grant without a task', usage(a, attemptId, { entryKind: 'extension-granted', source: 'human-granted', attemptId: null, taskId: null })],
    ];
    for (const [label, entry] of cases) {
      await assert.rejects(() => ledger.append(a.scope, entry), (err: unknown) => err instanceof RangeError || refused(err), label);
    }
    await assert.rejects(() => ledger.append(b.scope, usage(a, attemptId)), refused, 'another tenant\'s run');
    await assert.rejects(() => db.query(
      `insert into budget_ledger (id, organization_id, project_id, run_id, task_id, attempt_id, entry_kind, cost_usd, source, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, 'attempt-usage', 0.0000001, 'provider-reported', 'k')`,
      [ulid(), a.scope.organizationId, a.scope.projectId, a.runId, a.taskId, attemptId],
    ), refused, 'a fraction of a micro-USD');
    assert.equal((await db.query('select 1 from budget_ledger', [])).rows.length, 0);
  } finally {
    await db.close();
  }
});

test('a run\'s governance is set once and then fixed', async () => {
  const { db, a, b } = await freshDb();
  try {
    const governance = new SqlRunGovernance(db);
    assert.equal(await governance.find(a.scope, a.runId), null);
    const gov = { maxCostMicroUsd: 50_000_000, softCostMicroUsd: 40_000_000, maxTasks: 10, publicationApprovalRequired: true, createdBy: HUMAN };
    assert.deepEqual(await governance.bind(a.scope, a.runId, gov), { bound: true });
    assert.deepEqual(await governance.bind(a.scope, a.runId, gov), { bound: false });
    assert.deepEqual(await governance.find(a.scope, a.runId), gov);
    await assert.rejects(() => governance.bind(a.scope, a.runId, { ...gov, publicationApprovalRequired: false }), RunGovernanceConflictError);
    await assert.rejects(() => db.query('update runs set publication_approval_required = false where id = $1', [a.runId]), refused);
    await assert.rejects(() => db.query('update runs set budget_max_cost_usd = 1 where id = $1', [a.runId]), refused);
    await assert.rejects(() => governance.bind(b.scope, a.runId, gov), ScopeViolationError);
    await assert.rejects(() => governance.bind(a.scope, b.runId, { ...gov, softCostMicroUsd: 60_000_000 }), RangeError, 'soft above max');
    await assert.rejects(() => governance.bind(a.scope, b.runId, { ...gov, createdBy: 'harness' }), RangeError, 'not a principal');
    await assert.rejects(() => governance.bind(a.scope, b.runId, { ...gov, maxTasks: 0 }), RangeError, 'no tasks');
    await db.query(`update runs set status = 'DONE' where id = $1`, [a.runId]);
    assert.equal((await one(db, 'select status from runs where id = $1', [a.runId]))['status'], 'DONE', 'other run columns stay writable');
  } finally {
    await db.close();
  }
});
