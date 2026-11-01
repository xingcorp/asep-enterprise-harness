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

test('a committed attempt under review is pushed or asked for changes, and changes requested ends it', () => {
  let a = attempt('COMMITTED');
  for (const s of ['UNDER_REVIEW', 'PUSHED', 'PR_OPEN', 'SUCCEEDED'] as const) a = transitionAttempt(a, s);
  assert.equal(a.status, 'SUCCEEDED');
  // Without a review round the committed attempt is pushed directly.
  assert.equal(transitionAttempt(attempt('COMMITTED'), 'PUSHED').status, 'PUSHED');
  // The round asks for a repair: the attempt ends; the repair is the next attempt.
  assert.equal(transitionAttempt(attempt('UNDER_REVIEW'), 'CHANGES_REQUESTED').status, 'CHANGES_REQUESTED');
  assert.ok(isAttemptTerminal('CHANGES_REQUESTED'));
  assert.ok(!isAttemptTerminal('UNDER_REVIEW'));
  for (const next of ['UNDER_REVIEW', 'PUSHED', 'COMMITTED', 'FAILED'] as const) {
    assert.throws(() => transitionAttempt(attempt('CHANGES_REQUESTED'), next), `CHANGES_REQUESTED -> ${next}`);
  }
  // The push guard blocks a reviewed attempt.
  assert.equal(transitionAttempt(attempt('UNDER_REVIEW'), 'BLOCKED').status, 'BLOCKED');
  // Review sits between the commit and the push, nowhere else.
  const refused: readonly [AttemptStatus, AttemptStatus][] = [
    ['UNDER_REVIEW', 'PR_OPEN'], ['UNDER_REVIEW', 'COMMITTED'], ['UNDER_REVIEW', 'SUCCEEDED'], ['VERIFYING', 'UNDER_REVIEW'],
    ['EVIDENCE_BUILT', 'UNDER_REVIEW'], ['PUSHED', 'UNDER_REVIEW'], ['COMMITTED', 'CHANGES_REQUESTED'],
    ['PUSHED', 'CHANGES_REQUESTED'],
  ];
  for (const [from, to] of refused) assert.throws(() => transitionAttempt(attempt(from), to), `${from} -> ${to}`);
  assert.ok(attemptReachableStates().includes('UNDER_REVIEW') && attemptReachableStates().includes('CHANGES_REQUESTED'));
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
