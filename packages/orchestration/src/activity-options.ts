// Explicit Temporal activity options for every activity the workflows schedule.
// Nothing falls back to an engine default: each entry names its start-to-close
// timeout, retry policy, heartbeat timeout (for long activities) and whether a
// cancellation may interrupt it.

import type { Budget, TaskEffect, TaskRequestKind } from './types.js';

export type ActivityName =
  | TaskRequestKind
  | 'recordAttemptOutcome'
  | 'projectTaskState'
  | 'projectAttemptState'
  | 'recordUsage'
  | 'expireApprovalRequest'
  | 'cancelApprovalRequest'
  | 'recordControl'
  | 'recordAudit'
  | 'renewLease'
  | 'reapContainers'
  | 'quarantineWorkspace'
  | 'cleanupWorkspace'
  | 'releaseLease'
  | 'emitRunEvent';

export interface RetryOptions {
  readonly maximumAttempts: number;
  readonly initialIntervalSeconds: number;
  readonly backoffCoefficient: number;
  readonly maximumIntervalSeconds: number;
}

export interface ActivityOptions {
  /** For runAgent and runVerification this is the grace added to the derived duration. */
  readonly startToCloseSeconds: number;
  readonly heartbeatTimeoutSeconds: number | null;
  readonly retry: RetryOptions;
  /** False: the activity runs in a non-cancellable scope and always completes. */
  readonly cancellable: boolean;
}

const GRACE_SECONDS = 300;

function retry(maximumAttempts: number, maximumIntervalSeconds = 60): RetryOptions {
  return { maximumAttempts, initialIntervalSeconds: 1, backoffCoefficient: 2, maximumIntervalSeconds };
}

function options(
  startToCloseSeconds: number,
  heartbeatTimeoutSeconds: number | null,
  retryOptions: RetryOptions,
  cancellable: boolean,
): ActivityOptions {
  return { startToCloseSeconds, heartbeatTimeoutSeconds, retry: retryOptions, cancellable };
}

export const ACTIVITY_OPTIONS: Readonly<Record<ActivityName, ActivityOptions>> = {
  admitTask: options(30, null, retry(3), true),
  ensureAttempt: options(30, null, retry(10), true),
  acquireLease: options(30, null, retry(10), true),
  prepareWorkspace: options(300, 30, retry(3), true),
  storeAttemptInputs: options(120, null, retry(5), true),
  // The agent mutates a worktree and spends money: it is never re-run by the engine.
  runAgent: options(GRACE_SECONDS, 60, retry(1), true),
  inspectWorkspace: options(300, 30, retry(3), true),
  runVerification: options(GRACE_SECONDS, 30, retry(2), true),
  commitAttempt: options(300, 30, retry(10), false),
  persistEvidence: options(300, 30, retry(10), false),
  assuranceRound: options(1800, 60, retry(3), true),
  recordAttemptOutcome: options(30, null, retry(10), false),
  publishBranch: options(300, 30, retry(20, 300), false),
  upsertPullRequest: options(300, 30, retry(20, 300), false),
  projectTaskState: options(30, null, retry(50, 60), false),
  projectAttemptState: options(30, null, retry(50, 60), false),
  recordUsage: options(30, null, retry(10), false),
  openApprovalRequest: options(30, null, retry(10), false),
  verifyApprovalDecision: options(30, null, retry(10), false),
  expireApprovalRequest: options(30, null, retry(10), false),
  cancelApprovalRequest: options(30, null, retry(10), false),
  recordControl: options(30, null, retry(10), false),
  recordAudit: options(30, null, retry(10), false),
  renewLease: options(30, null, retry(5), true),
  reapContainers: options(120, null, retry(10), false),
  quarantineWorkspace: options(120, null, retry(10), false),
  cleanupWorkspace: options(120, null, retry(10), false),
  releaseLease: options(120, null, retry(10), false),
  emitRunEvent: options(30, null, retry(10), false),
};

/**
 * The critical units: each operation that needs reconciliation, in order. A
 * cancel that arrives inside a unit is processed once the unit has reconciled,
 * and once a push has started the PR upsert runs too, so the remote ends with no
 * ASEP branch or with the branch and its PR. Everything else, including the
 * assurance round, repair planning and approval waits, is cancellable at once.
 */
export const CRITICAL_UNITS: readonly (readonly TaskRequestKind[])[] = [
  ['commitAttempt', 'persistEvidence'],
  ['publishBranch'],
  ['upsertPullRequest'],
];

/** The activity that carries out each effect; timers are workflow-native and have none. */
export const EFFECT_ACTIVITY: Readonly<Record<TaskEffect['kind'], ActivityName | null>> = {
  projectTaskState: 'projectTaskState',
  emitRunEvent: 'emitRunEvent',
  recordAttemptOutcome: 'recordAttemptOutcome',
  recordUsage: 'recordUsage',
  recordOverrun: 'recordUsage',
  recordExtension: 'recordUsage',
  reapContainers: 'reapContainers',
  quarantineWorkspace: 'quarantineWorkspace',
  cleanupWorkspace: 'cleanupWorkspace',
  releaseLease: 'releaseLease',
  expireApprovalRequest: 'expireApprovalRequest',
  cancelApprovalRequest: 'cancelApprovalRequest',
  recordControl: 'recordControl',
  audit: 'recordAudit',
  startTimer: null,
  cancelTimer: null,
};

/** runAgent start-to-close: the attempt's wall-clock cap plus grace. */
export function agentStartToCloseSeconds(budget: Budget): number {
  return budget.maxWallClockMinutes * 60 + ACTIVITY_OPTIONS.runAgent.startToCloseSeconds;
}

/** runVerification start-to-close: the sum of the plan's check timeouts plus grace. */
export function verificationStartToCloseSeconds(checkTimeoutsSeconds: readonly number[]): number {
  let total = 0;
  for (const seconds of checkTimeoutsSeconds) total += seconds;
  return total + ACTIVITY_OPTIONS.runVerification.startToCloseSeconds;
}
