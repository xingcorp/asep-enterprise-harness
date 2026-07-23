import type { RunId, RunStatus } from '@asep/contracts';

const allowed: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  DRAFT: ['DISCOVERY', 'CANCELLED'],
  DISCOVERY: ['SPECIFICATION_REVIEW', 'BLOCKED', 'CANCELLED'],
  SPECIFICATION_REVIEW: ['ARCHITECTURE_REVIEW', 'DISCOVERY', 'WAITING_FOR_APPROVAL', 'CANCELLED'],
  ARCHITECTURE_REVIEW: ['PLANNING', 'SPECIFICATION_REVIEW', 'WAITING_FOR_APPROVAL', 'CANCELLED'],
  PLANNING: ['READY', 'ARCHITECTURE_REVIEW', 'BLOCKED', 'CANCELLED'],
  READY: ['EXECUTING', 'PAUSED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['INDEPENDENT_REVIEW', 'REPAIRING', 'FAILED', 'CANCELLED'],
  INDEPENDENT_REVIEW: ['INTEGRATING', 'REPAIRING', 'WAITING_FOR_APPROVAL', 'FAILED', 'CANCELLED'],
  REPAIRING: ['VERIFYING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  INTEGRATING: ['PRODUCT_ACCEPTANCE', 'REPAIRING', 'FAILED', 'CANCELLED'],
  PRODUCT_ACCEPTANCE: ['RELEASE_REHEARSAL', 'REPAIRING', 'FAILED', 'CANCELLED'],
  RELEASE_REHEARSAL: ['DONE', 'REPAIRING', 'WAITING_FOR_APPROVAL', 'FAILED', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['READY', 'EXECUTING', 'INTEGRATING', 'RELEASE_REHEARSAL', 'PAUSED', 'CANCELLED'],
  PAUSED: ['READY', 'EXECUTING', 'CANCELLED'],
  BLOCKED: ['DISCOVERY', 'PLANNING', 'EXECUTING', 'REPAIRING', 'CANCELLED'],
  FAILED: [], CANCELLED: [], DONE: []
};

export interface RunAggregate {
  readonly id: RunId;
  readonly status: RunStatus;
  readonly version: number;
}

export function transition(run: RunAggregate, next: RunStatus): RunAggregate {
  const nextStates = allowed[run.status]!;
  if (!nextStates.includes(next)) {
    throw new Error(`Invalid run transition ${run.status} -> ${next}`);
  }
  return { ...run, status: next, version: run.version + 1 };
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED';
}

// Phase 2 operational state machines (Task / Attempt / WorkspaceLease).
export {
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
