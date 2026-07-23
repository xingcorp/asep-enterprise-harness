// Phase 2 operational state machines (data-model §4).
//
// These are the HARNESS-owned operational lifecycles — distinct from the
// business RunStatus machine in ./index.ts. A Task, Attempt and WorkspaceLease
// each progress through a table-driven allow-list, mirroring the existing
// transition() pattern, and every mutating aggregate carries a `version` for
// optimistic concurrency (data-model §1). All transitions are pure functions:
// no IO, no model call.
//
// Trust rule (exit criterion I2): NO machine transition advances a Task into an
// ACCEPTED/DONE state. WAITING_FOR_HUMAN_REVIEW is terminal for the harness —
// only a human (outside this automation) moves past it.

import type {
  TaskId,
  AttemptId,
  WorkspaceId,
  RepositoryBindingId,
  TaskStatus,
  AttemptStatus,
  LeaseStatus,
} from '@asep/contracts';

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const taskAllowed: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PENDING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['EXECUTING', 'BLOCKED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['WAITING_FOR_HUMAN_REVIEW', 'FAILED', 'BLOCKED', 'CANCELLED'],
  // Terminal for the harness: only a human advances past review.
  WAITING_FOR_HUMAN_REVIEW: [],
  // BLOCKED can be retried back into the pipeline or cancelled.
  BLOCKED: ['READY', 'EXECUTING', 'CANCELLED'],
  FAILED: [],
  CANCELLED: [],
};

export interface TaskAggregate {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly version: number;
}

export function transitionTask(task: TaskAggregate, next: TaskStatus): TaskAggregate {
  const nextStates = taskAllowed[task.status];
  if (!nextStates.includes(next)) {
    throw new Error(`Invalid task transition ${task.status} -> ${next}`);
  }
  return { ...task, status: next, version: task.version + 1 };
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return (
    status === 'WAITING_FOR_HUMAN_REVIEW' ||
    status === 'FAILED' ||
    status === 'CANCELLED'
  );
}

// The harness never transitions a Task into an accepted/done state — human
// review is the ceiling (exit criterion I2). Exposed so callers/tests can
// assert this invariant directly.
export function taskReachableStates(): readonly TaskStatus[] {
  return Object.keys(taskAllowed) as TaskStatus[];
}

// ---------------------------------------------------------------------------
// Attempt
// ---------------------------------------------------------------------------

// Terminal failure/interrupt states reachable from ANY non-terminal attempt.
const ATTEMPT_INTERRUPTS: readonly AttemptStatus[] = [
  'FAILED',
  'BLOCKED',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
];

const attemptHappyPath: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  STARTED: ['AGENT_RUNNING'],
  AGENT_RUNNING: ['AGENT_DONE'],
  AGENT_DONE: ['INSPECTING'],
  INSPECTING: ['VERIFYING'],
  VERIFYING: ['EVIDENCE_BUILT'],
  EVIDENCE_BUILT: ['COMMITTED'],
  COMMITTED: ['PUSHED'],
  PUSHED: ['PR_OPEN'],
  PR_OPEN: ['SUCCEEDED'],
  SUCCEEDED: [],
  FAILED: [],
  BLOCKED: [],
  BUDGET_EXHAUSTED: [],
  CANCELLED: [],
};

const ATTEMPT_TERMINAL: readonly AttemptStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
];

export interface AttemptAggregate {
  readonly id: AttemptId;
  readonly status: AttemptStatus;
  readonly version: number;
}

export function isAttemptTerminal(status: AttemptStatus): boolean {
  return ATTEMPT_TERMINAL.includes(status);
}

function attemptNextStates(status: AttemptStatus): readonly AttemptStatus[] {
  if (ATTEMPT_TERMINAL.includes(status)) return [];
  // Any non-terminal attempt may advance one step on the happy path OR be
  // interrupted into a classified failure/blocked/budget/cancelled state.
  return [...attemptHappyPath[status], ...ATTEMPT_INTERRUPTS];
}

export function transitionAttempt(
  attempt: AttemptAggregate,
  next: AttemptStatus,
): AttemptAggregate {
  const nextStates = attemptNextStates(attempt.status);
  if (!nextStates.includes(next)) {
    throw new Error(`Invalid attempt transition ${attempt.status} -> ${next}`);
  }
  return { ...attempt, status: next, version: attempt.version + 1 };
}

export function attemptReachableStates(): readonly AttemptStatus[] {
  return Object.keys(attemptHappyPath) as AttemptStatus[];
}

// ---------------------------------------------------------------------------
// WorkspaceLease
// ---------------------------------------------------------------------------

const leaseAllowed: Readonly<Record<LeaseStatus, readonly LeaseStatus[]>> = {
  ACTIVE: ['RELEASED', 'EXPIRED', 'QUARANTINED'],
  RELEASED: [],
  EXPIRED: ['QUARANTINED'],
  QUARANTINED: [],
};

export interface WorkspaceLeaseAggregate {
  readonly id: string;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly branch: string;
  readonly workspaceId: WorkspaceId;
  readonly status: LeaseStatus;
  readonly version: number;
}

export function transitionLease(
  lease: WorkspaceLeaseAggregate,
  next: LeaseStatus,
): WorkspaceLeaseAggregate {
  const nextStates = leaseAllowed[lease.status];
  if (!nextStates.includes(next)) {
    throw new Error(`Invalid lease transition ${lease.status} -> ${next}`);
  }
  return { ...lease, status: next, version: lease.version + 1 };
}

export function isLeaseTerminal(status: LeaseStatus): boolean {
  return status === 'RELEASED' || status === 'QUARANTINED';
}
