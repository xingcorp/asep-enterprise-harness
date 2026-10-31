import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionTask,
  isTaskTerminal,
  taskReachableStates,
  transitionAttempt,
  isAttemptTerminal,
  attemptReachableStates,
  transitionLease,
  isLeaseTerminal,
  type TaskAggregate,
  type AttemptAggregate,
  type WorkspaceLeaseAggregate,
} from './operational.js';
import type {
  TaskId,
  AttemptId,
  WorkspaceId,
  RepositoryBindingId,
  TaskStatus,
  AttemptStatus,
} from '@asep/contracts';

function task(status: TaskStatus, version = 0): TaskAggregate {
  return { id: 'task-1' as TaskId, status, version };
}
function attempt(status: AttemptStatus, version = 0): AttemptAggregate {
  return { id: 'att-1' as AttemptId, status, version };
}
function lease(status: WorkspaceLeaseAggregate['status'], version = 0): WorkspaceLeaseAggregate {
  return {
    id: 'lease-1',
    repositoryBindingId: 'rb-1' as RepositoryBindingId,
    branch: 'asep/run-1/task-1/att-1',
    workspaceId: 'ws-1' as WorkspaceId,
    status,
    version,
  };
}

// --- Task -------------------------------------------------------------------

test('task happy path advances PENDING -> ... -> WAITING_FOR_HUMAN_REVIEW', () => {
  let t = task('PENDING');
  t = transitionTask(t, 'READY');
  t = transitionTask(t, 'EXECUTING');
  t = transitionTask(t, 'VERIFYING');
  t = transitionTask(t, 'WAITING_FOR_HUMAN_REVIEW');
  assert.equal(t.status, 'WAITING_FOR_HUMAN_REVIEW');
  assert.equal(t.version, 4);
});

test('task transition bumps version for optimistic concurrency', () => {
  const t = transitionTask(task('PENDING', 7), 'READY');
  assert.equal(t.version, 8);
});

test('task rejects illegal skips', () => {
  assert.throws(() => transitionTask(task('PENDING'), 'VERIFYING'));
  assert.throws(() => transitionTask(task('READY'), 'WAITING_FOR_HUMAN_REVIEW'));
});

test('TRUST INVARIANT (I2): no machine transition reaches ACCEPTED/DONE', () => {
  // WAITING_FOR_HUMAN_REVIEW is the harness ceiling. No task state has an
  // outgoing edge to any accepted/done-like target.
  for (const from of taskReachableStates()) {
    // Neither ACCEPTED nor DONE are even members of TaskStatus; assert the
    // machine never emits an edge whose name implies human-only acceptance.
    for (const forbidden of ['ACCEPTED', 'DONE', 'MERGED', 'RELEASED']) {
      assert.throws(
        () => transitionTask(task(from), forbidden as TaskStatus),
        `task ${from} must not transition to ${forbidden}`,
      );
    }
  }
});

test('WAITING_FOR_HUMAN_REVIEW is terminal for the harness', () => {
  assert.ok(isTaskTerminal('WAITING_FOR_HUMAN_REVIEW'));
  assert.throws(() => transitionTask(task('WAITING_FOR_HUMAN_REVIEW'), 'READY'));
});

// Every edge the table allows, as `FROM->TO`.
function taskEdges(): string[] {
  const edges: string[] = [];
  for (const from of taskReachableStates()) {
    for (const to of taskReachableStates()) {
      try {
        transitionTask(task(from), to);
        edges.push(`${from}->${to}`);
      } catch {
        // not an edge
      }
    }
  }
  return edges.sort();
}

test('task: the edges between the earlier statuses are unchanged', () => {
  const earlier = new Set(['PENDING', 'READY', 'EXECUTING', 'VERIFYING', 'WAITING_FOR_HUMAN_REVIEW', 'FAILED', 'BLOCKED', 'CANCELLED']);
  const kept = taskEdges().filter((edge) => edge.split('->').every((s) => earlier.has(s)));
  assert.deepEqual(kept, [
    'BLOCKED->CANCELLED', 'BLOCKED->EXECUTING', 'BLOCKED->READY',
    'EXECUTING->BLOCKED', 'EXECUTING->CANCELLED', 'EXECUTING->FAILED', 'EXECUTING->VERIFYING',
    'PENDING->BLOCKED', 'PENDING->CANCELLED', 'PENDING->READY',
    'READY->BLOCKED', 'READY->CANCELLED', 'READY->EXECUTING',
    'VERIFYING->BLOCKED', 'VERIFYING->CANCELLED', 'VERIFYING->FAILED', 'VERIFYING->WAITING_FOR_HUMAN_REVIEW',
  ]);
});

test('task: the edges touching PAUSED, WAITING_FOR_APPROVAL and BUDGET_EXHAUSTED are exactly the durable-orchestration additions', () => {
  const added = new Set(['PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED']);
  const touching = taskEdges().filter((edge) => edge.split('->').some((s) => added.has(s)));
  assert.deepEqual(touching, [
    // A work status can be paused, can wait for an approval, and can run out of budget.
    'EXECUTING->BUDGET_EXHAUSTED', 'EXECUTING->PAUSED', 'EXECUTING->WAITING_FOR_APPROVAL',
    // Resume returns to the status the pause left, including an approval wait; a budget-extension request can
    // expire or be rejected while paused.
    'PAUSED->BLOCKED', 'PAUSED->BUDGET_EXHAUSTED', 'PAUSED->CANCELLED', 'PAUSED->EXECUTING', 'PAUSED->READY',
    'PAUSED->VERIFYING', 'PAUSED->WAITING_FOR_APPROVAL',
    'READY->BUDGET_EXHAUSTED', 'READY->PAUSED', 'READY->WAITING_FOR_APPROVAL',
    // A replacement attempt refused for budget after the task reached verification.
    'VERIFYING->BUDGET_EXHAUSTED', 'VERIFYING->PAUSED', 'VERIFYING->WAITING_FOR_APPROVAL',
    // A pause during an approval wait applies at once.
    'WAITING_FOR_APPROVAL->BLOCKED', 'WAITING_FOR_APPROVAL->BUDGET_EXHAUSTED', 'WAITING_FOR_APPROVAL->CANCELLED',
    'WAITING_FOR_APPROVAL->EXECUTING', 'WAITING_FOR_APPROVAL->PAUSED', 'WAITING_FOR_APPROVAL->READY',
    'WAITING_FOR_APPROVAL->VERIFYING',
  ]);
});

test('task: BUDGET_EXHAUSTED is terminal; a pause and an approval wait are not', () => {
  assert.ok(isTaskTerminal('BUDGET_EXHAUSTED'));
  assert.ok(!isTaskTerminal('PAUSED'));
  assert.ok(!isTaskTerminal('WAITING_FOR_APPROVAL'));
  assert.ok(taskReachableStates().includes('BUDGET_EXHAUSTED'));
  for (const to of taskReachableStates()) {
    assert.throws(() => transitionTask(task('BUDGET_EXHAUSTED'), to), `BUDGET_EXHAUSTED -> ${to}`);
  }
  // Neither the pause nor the approval wait leads to review: the task goes back to work first.
  assert.throws(() => transitionTask(task('PAUSED'), 'WAITING_FOR_HUMAN_REVIEW'));
  assert.throws(() => transitionTask(task('WAITING_FOR_APPROVAL'), 'WAITING_FOR_HUMAN_REVIEW'));
});

// --- Attempt ----------------------------------------------------------------

test('attempt happy path STARTED -> SUCCEEDED', () => {
  let a = attempt('STARTED');
  const path: AttemptStatus[] = [
    'AGENT_RUNNING', 'AGENT_DONE', 'INSPECTING', 'VERIFYING',
    'EVIDENCE_BUILT', 'COMMITTED', 'PUSHED', 'PR_OPEN', 'SUCCEEDED',
  ];
  for (const s of path) a = transitionAttempt(a, s);
  assert.equal(a.status, 'SUCCEEDED');
  assert.equal(a.version, path.length);
});

test('attempt can be interrupted into a classified failure from any live state', () => {
  for (const from of attemptReachableStates()) {
    if (isAttemptTerminal(from)) continue;
    for (const interrupt of ['FAILED', 'BLOCKED', 'BUDGET_EXHAUSTED', 'CANCELLED'] as const) {
      const a = transitionAttempt(attempt(from), interrupt);
      assert.equal(a.status, interrupt);
    }
  }
});

test('attempt rejects happy-path skips and post-terminal moves', () => {
  assert.throws(() => transitionAttempt(attempt('STARTED'), 'COMMITTED'));
  assert.throws(() => transitionAttempt(attempt('SUCCEEDED'), 'PR_OPEN'));
  assert.throws(() => transitionAttempt(attempt('FAILED'), 'AGENT_RUNNING'));
});

// --- WorkspaceLease ---------------------------------------------------------

test('lease ACTIVE -> RELEASED and ACTIVE -> EXPIRED -> QUARANTINED', () => {
  assert.equal(transitionLease(lease('ACTIVE'), 'RELEASED').status, 'RELEASED');
  const expired = transitionLease(lease('ACTIVE'), 'EXPIRED');
  assert.equal(expired.status, 'EXPIRED');
  assert.equal(transitionLease(expired, 'QUARANTINED').status, 'QUARANTINED');
});

test('lease rejects illegal transitions and bumps version', () => {
  assert.throws(() => transitionLease(lease('RELEASED'), 'ACTIVE'));
  assert.ok(isLeaseTerminal('RELEASED'));
  assert.ok(isLeaseTerminal('QUARANTINED'));
  assert.equal(transitionLease(lease('ACTIVE', 3), 'RELEASED').version, 4);
});
