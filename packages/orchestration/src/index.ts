// @asep/orchestration — the deterministic workflow decision core.
//
// Pure reducers for the task and run workflows, the explicit activity option
// table, budget arithmetic, approval validation and assurance-outcome checks.
// The package has no runtime dependencies: it imports only types, so Temporal
// workflow code can bundle it without pulling in anything non-deterministic.

export { decideTask, startTask, taskWorkflowId } from './task-core.js';
export { decideRun, runWorkflowId, startRun } from './run-core.js';
export type { RunBudget, RunCarry, RunCommand, RunCoreInput, RunDecision, RunEvent, RunState } from './run-core.js';
export {
  ACTIVITY_OPTIONS,
  CRITICAL_UNITS,
  EFFECT_ACTIVITY,
  agentStartToCloseSeconds,
  verificationStartToCloseSeconds,
} from './activity-options.js';
export type { ActivityName, ActivityOptions, RetryOptions } from './activity-options.js';
export { MAX_USD, checkReservation, crossesSoftThreshold, fromMicroUsd, isExactUsd, toMicroUsd, usageMicroUsd } from './budget.js';
export type { Reservation, ReservationFailureReason, ReservationInput } from './budget.js';
export {
  ALLOWED_DECISIONS,
  APPROVAL_KINDS,
  approvalRequestId,
  isValidExtension,
  isWellFormedDecision,
  validateApprovalDecision,
} from './approvals.js';
export { parseAssuranceOutcome } from './assurance.js';
export type { AssuranceContext, ParsedAssuranceOutcome } from './assurance.js';
export { isLegalProjection, statusForRequest } from './projection.js';
export { DEFAULT_ORCHESTRATION_POLICY, FAILURE_CLASSES, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
export { orchestrationPolicyErrors, runInputErrors, taskInputErrors } from './validation.js';
export { runTaskSequentially } from './sequential-interpreter.js';
export type { ActivityFailure, Answer, DeliveredMessage, TaskEnvironment, TaskTrace } from './sequential-interpreter.js';
export type * from './types.js';
