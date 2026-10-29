// Task-status projection rules: which status each request implies, and which
// status changes are legal. The table is the domain transition table plus the
// data-model additions for PAUSED, WAITING_FOR_APPROVAL and BUDGET_EXHAUSTED,
// plus VERIFYING -> BUDGET_EXHAUSTED (a replacement attempt refused for budget
// after the task already reached verification) and the approval-wait pause
// edges: WAITING_FOR_APPROVAL <-> PAUSED, and PAUSED -> BUDGET_EXHAUSTED for an
// extension that expires or is rejected while paused. Every projection the core
// emits must be a legal edge; the property tests check it on every generated trace.

import type { ProjectedTaskStatus, TaskRequestKind } from './types.js';

const LEGAL: Readonly<Record<ProjectedTaskStatus, readonly ProjectedTaskStatus[]>> = {
  PENDING: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['EXECUTING', 'BLOCKED', 'CANCELLED', 'PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED', 'PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED'],
  VERIFYING: [
    'WAITING_FOR_HUMAN_REVIEW', 'FAILED', 'BLOCKED', 'CANCELLED', 'PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED',
  ],
  WAITING_FOR_HUMAN_REVIEW: [],
  BLOCKED: ['READY', 'EXECUTING', 'CANCELLED'],
  FAILED: [],
  CANCELLED: [],
  PAUSED: ['READY', 'EXECUTING', 'VERIFYING', 'WAITING_FOR_APPROVAL', 'BLOCKED', 'BUDGET_EXHAUSTED', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['READY', 'EXECUTING', 'VERIFYING', 'PAUSED', 'BLOCKED', 'BUDGET_EXHAUSTED', 'CANCELLED'],
  BUDGET_EXHAUSTED: [],
};

export function isLegalProjection(from: ProjectedTaskStatus, to: ProjectedTaskStatus): boolean {
  return LEGAL[from].includes(to);
}

export function isWorkStatus(status: ProjectedTaskStatus): boolean {
  return status === 'READY' || status === 'EXECUTING' || status === 'VERIFYING';
}

/**
 * The status a request runs under, or null when it leaves the projection alone.
 * Attempt preparation and the agent keep VERIFYING once the task has reached it,
 * so retry and repair attempts never move the task back to EXECUTING.
 */
export function statusForRequest(kind: TaskRequestKind, workStatus: ProjectedTaskStatus): ProjectedTaskStatus | null {
  switch (kind) {
    case 'admitTask':
    case 'findAttempt':
    case 'findLease':
    case 'recordPreLeaseOutcome':
    case 'openApprovalRequest':
    case 'verifyApprovalDecision':
      return null;
    case 'ensureAttempt':
    case 'acquireLease':
    case 'prepareWorkspace':
    case 'storeAttemptInputs':
    case 'runAgent':
    case 'inspectWorkspace':
      return workStatus === 'VERIFYING' ? 'VERIFYING' : 'EXECUTING';
    case 'runVerification':
    case 'commitAttempt':
    case 'persistEvidence':
    case 'assuranceRound':
    case 'publishBranch':
    case 'upsertPullRequest':
    case 'reconcilePublication':
      return 'VERIFYING';
  }
}
