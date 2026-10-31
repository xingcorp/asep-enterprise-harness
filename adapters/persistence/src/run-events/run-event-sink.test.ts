// The run-event sink and the attempt-terminal writes on it, on PGlite.
//
// The sink is the only writer of run_events: an event is validated against its
// run-event version and checked against the caller's tenant before any insert,
// a second write of the same id is a no-op only with the same canonical bytes,
// and no row is ever updated or deleted. The attempt-terminal store writes the
// default assurance slot's terminal events through the sink in one transaction
// that locks the attempt row, checks the caller's fence (or the attempt's empty
// lease history) and compares any terminal already recorded; lease acquisition
// for an attempt takes the same lock and refuses once a terminal is recorded.
// The oracles are independent of the adapter: hashes are recomputed here, and
// rows are read back with plain SQL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type {
  AttemptId, RepositoryBindingId, RunEvent, RunId, TaskId, TenantScope,
} from '@asep/contracts';
import { RunEventConflictError, type AttemptLeaseFence, type AttemptRef } from '@asep/ports';
import { PgliteClient } from '../pglite-client.js';
import { migrate } from '../migrator.js';
import {
  AttemptRepository, OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository,
} from '../repositories.js';
import { SqlWorkspaceLeaseRepository } from '../lease-repository.js';
import { ScopeViolationError, type SqlClient } from '../sql.js';
import { SqlRunEventSink, RunEventValidationError } from './run-event-sink.js';
import { SqlAttemptTerminalStore } from './attempt-terminal-store.js';

console.log('SUITE-ID: asep-suite:run-event-sink');

// --- independent oracles ----------------------------------------------------

function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortedDeep((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function sha256Of(event: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortedDeep(event)), 'utf8').digest('hex');
}

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

async function newAttempt(db: SqlClient, t: Tenant): Promise<AttemptRef> {
  const attempt = await new AttemptRepository(db).create(t.scope, { taskId: t.taskId, repositoryBindingId: t.bindingId });
  return { repositoryBindingId: t.bindingId, runId: t.runId, taskId: t.taskId, attemptId: attempt.id };
}

async function freshDb(): Promise<{ db: PgliteClient; a: Tenant; b: Tenant }> {
  const db = await PgliteClient.create();
  await migrate(db);
  return { db, a: await seedTenant(db, 'acme'), b: await seedTenant(db, 'globex') };
}

function event(t: Tenant, eventId: string, extra: Partial<RunEvent> = {}): RunEvent {
  return {
    eventId,
    eventType: 'task.started',
    occurredAt: '2026-10-31T00:00:00.000Z',
    runId: t.runId,
    taskId: t.taskId,
    organizationId: t.scope.organizationId,
    projectId: t.scope.projectId,
    ...extra,
  };
}

async function rows(db: SqlClient, t: Tenant): Promise<Array<Record<string, unknown>>> {
  const r = await db.query(
    `select event_id, event_type, schema_version, payload, payload_sha256, run_id, task_id, attempt_id
       from run_events where organization_id = $1 and project_id = $2 order by event_id`,
    [t.scope.organizationId, t.scope.projectId],
  );
  return r.rows.map((row) => ({ ...row }));
}

function terminalEvents(t: Tenant, attempt: AttemptRef, occurredAt: string, extra: Partial<RunEvent> = {}): RunEvent[] {
  const base = {
    occurredAt,
    runId: attempt.runId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    organizationId: t.scope.organizationId,
    projectId: t.scope.projectId,
  };
  return [
    { ...base, eventId: `${attempt.attemptId}:attempt.declared_complete`, eventType: 'attempt.declared_complete', declaredComplete: true, passedRequiredAssurance: true },
    { ...base, eventId: `${attempt.attemptId}:attempt.completed`, eventType: 'attempt.completed', outcome: 'succeeded', attemptTerminal: 'proceeded', ...extra },
  ];
}

async function lease(db: SqlClient, t: Tenant, attempt: AttemptRef, branch = `asep/${attempt.attemptId}`): Promise<AttemptLeaseFence> {
  const granted = await new SqlWorkspaceLeaseRepository(db).acquire(t.scope, {
    repositoryBindingId: t.bindingId, branch, attemptId: attempt.attemptId, ttlMs: 600_000,
  });
  assert.ok(!('denied' in granted), 'the fixture lease is granted');
  return { leaseId: granted.leaseId, fencingEpoch: granted.fencingEpoch };
}

// --- the sink ---------------------------------------------------------------

test('a new event is appended with its version and the sha256 of its canonical bytes', async () => {
  const { db, a } = await freshDb();
  try {
    const e = event(a, 'evt-1', { workflowId: 'asep-task-1' });
    assert.deepEqual(await new SqlRunEventSink(db).append(a.scope, e), { appended: true });
    const [row] = await rows(db, a);
    assert.equal(row?.['schema_version'], '1.2.0');
    assert.equal(row?.['event_type'], 'task.started');
    assert.equal(row?.['payload_sha256'], sha256Of(e));
    assert.deepEqual(row?.['payload'], e);
  } finally {
    await db.close();
  }
});

test('the same event id with the same canonical bytes is a no-op, whatever the key order', async () => {
  const { db, a } = await freshDb();
  try {
    const sink = new SqlRunEventSink(db);
    const e = event(a, 'evt-1');
    await sink.append(a.scope, e);
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as unknown as RunEvent;
    assert.deepEqual(await sink.append(a.scope, reordered), { appended: false });
    assert.equal((await rows(db, a)).length, 1);
  } finally {
    await db.close();
  }
});

test('the same event id with different bytes is a conflict, and the stored row is unchanged', async () => {
  const { db, a } = await freshDb();
  try {
    const sink = new SqlRunEventSink(db);
    await sink.append(a.scope, event(a, 'evt-1'));
    const before = await rows(db, a);
    await assert.rejects(() => sink.append(a.scope, event(a, 'evt-1', { occurredAt: '2026-10-31T00:00:01.000Z' })), RunEventConflictError);
    await assert.rejects(() => sink.append(a.scope, event(a, 'evt-1', { workflowId: 'x' })), RunEventConflictError);
    assert.deepEqual(await rows(db, a), before);
  } finally {
    await db.close();
  }
});

test('an event invalid for run-event 1.2.0 is rejected before any insert', async () => {
  const { db, a } = await freshDb();
  try {
    const sink = new SqlRunEventSink(db);
    const invalid: unknown[] = [
      { ...event(a, 'evt-x'), undocumented: 1 },
      { ...event(a, 'evt-x'), eventType: 'task.guessed' },
      { ...event(a, 'evt-x'), attemptTerminal: 'failed' },
      { ...event(a, 'evt-x'), reviewRound: 0 },
      { ...event(a, 'evt-x'), occurredAt: 'yesterday' },
    ];
    for (const e of invalid) {
      await assert.rejects(() => sink.append(a.scope, e as RunEvent), RunEventValidationError);
    }
    assert.deepEqual(await rows(db, a), []);
  } finally {
    await db.close();
  }
});

test('an event whose run is not in the caller\'s tenant, or that names another tenant, is rejected', async () => {
  const { db, a, b } = await freshDb();
  try {
    const sink = new SqlRunEventSink(db);
    await assert.rejects(() => sink.append(a.scope, event(b, 'evt-b')), ScopeViolationError);
    await assert.rejects(() => sink.append(a.scope, { ...event(a, 'evt-c'), runId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' as RunId }), ScopeViolationError);
    await assert.rejects(() => sink.append(a.scope, { ...event(a, 'evt-d'), organizationId: b.scope.organizationId }), ScopeViolationError);
    await assert.rejects(() => sink.append(a.scope, { ...event(a, 'evt-e'), projectId: b.scope.projectId }), ScopeViolationError);
    await assert.rejects(() => sink.append(a.scope, { ...event(a, 'evt-f'), taskId: 'task-1' as TaskId }), RunEventValidationError);
    assert.deepEqual(await rows(db, a), []);
    assert.deepEqual(await rows(db, b), []);
  } finally {
    await db.close();
  }
});

test('run_events refuses UPDATE and DELETE with SQLSTATE 55000, and its scoped FK refuses another tenant\'s run', async () => {
  const { db, a, b } = await freshDb();
  try {
    await new SqlRunEventSink(db).append(a.scope, event(a, 'evt-1'));
    for (const sql of [`update run_events set event_type = 'task.completed'`, 'delete from run_events']) {
      await assert.rejects(() => db.query(sql), (err: unknown) => (err as { code?: string }).code === '55000');
    }
    await assert.rejects(
      () => db.query(
        `insert into run_events (organization_id, project_id, event_id, event_type, schema_version, occurred_at, run_id, payload, payload_sha256)
         values ($1, $2, 'raw', 'task.started', '1.2.0', now(), $3, '{}', $4)`,
        [a.scope.organizationId, a.scope.projectId, b.runId, 'a'.repeat(64)],
      ),
      (err: unknown) => (err as { code?: string }).code === '23503',
    );
    assert.equal((await rows(db, a)).length, 1);
  } finally {
    await db.close();
  }
});

// --- attempt terminals --------------------------------------------------------

test('a terminal under the held fence is recorded; a redelivery at another time writes nothing; other facts conflict', async () => {
  const { db, a } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const attempt = await newAttempt(db, a);
    const fence = await lease(db, a, attempt);
    assert.deepEqual(await store.recordTerminal(a.scope, attempt, fence, terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z')), { kind: 'recorded' });
    const recorded = await rows(db, a);
    assert.deepEqual(recorded.map((r) => r['event_id']), [`${attempt.attemptId}:attempt.completed`, `${attempt.attemptId}:attempt.declared_complete`]);
    assert.deepEqual(
      await store.recordTerminal(a.scope, attempt, fence, terminalEvents(a, attempt, '2026-10-31T05:00:00.000Z')),
      { kind: 'redelivered' },
    );
    assert.deepEqual(
      await store.recordTerminal(a.scope, attempt, fence, terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z', { attemptTerminal: 'escalated' })),
      { kind: 'refused', reason: 'conflicting-redelivery' },
    );
    assert.deepEqual(await rows(db, a), recorded);
  } finally {
    await db.close();
  }
});

test('a fence at another epoch, of another lease, or of a released or expired lease is refused and writes nothing', async () => {
  const { db, a } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const leases = new SqlWorkspaceLeaseRepository(db);
    const attempt = await newAttempt(db, a);
    const other = await newAttempt(db, a);
    const fence = await lease(db, a, attempt);
    const otherFence = await lease(db, a, other);
    const events = terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z');
    for (const wrong of [
      { ...fence, fencingEpoch: fence.fencingEpoch + 1 },
      { ...fence, fencingEpoch: fence.fencingEpoch - 1 },
      { ...fence, leaseId: otherFence.leaseId },
      { ...fence, leaseId: 'not-a-lease' },
      { ...fence, fencingEpoch: 1.5 },
    ]) {
      assert.deepEqual(await store.recordTerminal(a.scope, attempt, wrong, events), { kind: 'refused', reason: 'fenced' });
      assert.equal(await store.checkLease(a.scope, attempt, wrong), 'fenced');
    }
    assert.equal(await store.checkLease(a.scope, attempt, fence), 'held');
    await db.query(`update workspace_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [fence.leaseId]);
    assert.deepEqual(await store.recordTerminal(a.scope, attempt, fence, events), { kind: 'refused', reason: 'fenced' });
    await leases.release(a.scope, otherFence.leaseId);
    assert.deepEqual(
      await store.recordTerminal(a.scope, other, otherFence, terminalEvents(a, other, '2026-10-31T00:00:00.000Z')),
      { kind: 'refused', reason: 'fenced' },
    );
    assert.deepEqual(await rows(db, a), []);
  } finally {
    await db.close();
  }
});

test('fence null is recorded only while the attempt never held a lease; any lease in its history refuses it', async () => {
  const { db, a } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const never = await newAttempt(db, a);
    const cancelled = { attemptTerminal: 'cancelled' as const, outcome: 'cancelled' as const };
    assert.deepEqual(await store.recordTerminal(a.scope, never, null, terminalEvents(a, never, '2026-10-31T00:00:00.000Z', cancelled)), { kind: 'recorded' });
    const leased = await newAttempt(db, a);
    const fence = await lease(db, a, leased);
    const events = terminalEvents(a, leased, '2026-10-31T00:00:00.000Z', cancelled);
    assert.deepEqual(await store.recordTerminal(a.scope, leased, null, events), { kind: 'refused', reason: 'lease-granted' });
    await new SqlWorkspaceLeaseRepository(db).release(a.scope, fence.leaseId);
    assert.deepEqual(await store.recordTerminal(a.scope, leased, null, events), { kind: 'refused', reason: 'lease-granted' });
    assert.equal((await rows(db, a)).filter((r) => r['attempt_id'] === leased.attemptId).length, 0);
  } finally {
    await db.close();
  }
});

test('an attempt outside the scope, or with another run, task or binding, is not in scope and nothing is written', async () => {
  const { db, a, b } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const attempt = await newAttempt(db, a);
    const foreign = await newAttempt(db, b);
    const events = terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z', { attemptTerminal: 'cancelled', outcome: 'cancelled' });
    const refusedFor = async (scope: TenantScope, ref: AttemptRef) =>
      assert.deepEqual(await store.recordTerminal(scope, ref, null, events.map((e) => ({ ...e, runId: ref.runId, taskId: ref.taskId, attemptId: ref.attemptId }))), { kind: 'refused', reason: 'not-in-scope' });
    await refusedFor(b.scope, attempt);
    await refusedFor(a.scope, { ...attempt, runId: b.runId });
    await refusedFor(a.scope, { ...attempt, taskId: b.taskId });
    await refusedFor(a.scope, { ...attempt, repositoryBindingId: b.bindingId });
    await refusedFor(a.scope, { ...attempt, attemptId: foreign.attemptId });
    await refusedFor(a.scope, { ...attempt, attemptId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' as AttemptId });
    await refusedFor(a.scope, { ...attempt, attemptId: 'attempt-1' as AttemptId });
    const fence = await lease(db, a, attempt);
    assert.equal(await store.checkLease(b.scope, attempt, fence), 'not-in-scope');
    assert.deepEqual(await rows(db, a), []);
    assert.deepEqual(await rows(db, b), []);
  } finally {
    await db.close();
  }
});

test('the terminal events commit together or not at all', async () => {
  const { db, a } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const attempt = await newAttempt(db, a);
    const fence = await lease(db, a, attempt);
    const [declared, completed] = terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z');
    const broken = { ...completed!, reviewRound: 0 } as RunEvent;
    await assert.rejects(() => store.recordTerminal(a.scope, attempt, fence, [declared!, broken]), RunEventValidationError);
    assert.deepEqual(await rows(db, a), []);
    assert.deepEqual(await store.recordTerminal(a.scope, attempt, fence, [declared!, completed!]), { kind: 'recorded' });
  } finally {
    await db.close();
  }
});

test('lease acquisition takes the attempt lock and refuses an attempt whose terminal is recorded', async () => {
  const { db, a, b } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const attempt = await newAttempt(db, a);
    const branch = `asep/${attempt.attemptId}`;
    assert.deepEqual(await store.acquireLease(b.scope, { attempt, branch, ttlMs: 600_000 }), { denied: true, reason: 'attempt-not-in-scope' });
    const granted = await store.acquireLease(a.scope, { attempt, branch, ttlMs: 600_000 });
    assert.ok(!('denied' in granted), 'a registered attempt without a terminal is granted its lease');
    assert.equal(granted.attemptId, attempt.attemptId);
    const held = await store.acquireLease(a.scope, { attempt, branch, ttlMs: 600_000 });
    assert.ok('denied' in held && held.reason === 'active_writer_lease_held', 'one active writer per branch still holds');
    const fence = { leaseId: granted.leaseId, fencingEpoch: granted.fencingEpoch };
    await store.recordTerminal(a.scope, attempt, fence, terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z'));
    await new SqlWorkspaceLeaseRepository(db).release(a.scope, fence.leaseId);
    const before = await db.query('select count(*)::int as n from workspace_leases where attempt_id = $1', [attempt.attemptId]);
    assert.deepEqual(await store.acquireLease(a.scope, { attempt, branch, ttlMs: 600_000 }), { denied: true, reason: 'attempt-terminal-recorded' });
    const after = await db.query('select count(*)::int as n from workspace_leases where attempt_id = $1', [attempt.attemptId]);
    assert.deepEqual(after.rows, before.rows);
    const neverLeased = await newAttempt(db, a);
    await store.recordTerminal(a.scope, neverLeased, null, terminalEvents(a, neverLeased, '2026-10-31T00:00:00.000Z', { attemptTerminal: 'cancelled', outcome: 'cancelled' }));
    assert.deepEqual(
      await store.acquireLease(a.scope, { attempt: neverLeased, branch: `asep/${neverLeased.attemptId}`, ttlMs: 600_000 }),
      { denied: true, reason: 'attempt-terminal-recorded' },
    );
  } finally {
    await db.close();
  }
});

test('terminal events that are not the attempt\'s own are a programming error, refused before any write', async () => {
  const { db, a } = await freshDb();
  try {
    const store = new SqlAttemptTerminalStore(db);
    const attempt = await newAttempt(db, a);
    const other = await newAttempt(db, a);
    const fence = await lease(db, a, attempt);
    const events = terminalEvents(a, attempt, '2026-10-31T00:00:00.000Z');
    await assert.rejects(() => store.recordTerminal(a.scope, attempt, fence, terminalEvents(a, other, '2026-10-31T00:00:00.000Z')), /not the attempt's terminal/);
    await assert.rejects(() => store.recordTerminal(a.scope, attempt, fence, [events[0]!]), /not the attempt's terminal/);
    await assert.rejects(() => store.recordTerminal(a.scope, attempt, fence, [events[1]!, { ...events[1]!, eventId: 'second' }]), /not the attempt's terminal/);
    assert.deepEqual(await rows(db, a), []);
  } finally {
    await db.close();
  }
});
