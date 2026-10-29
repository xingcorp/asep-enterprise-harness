// Core-local types of the workflow decision core.
//
// Everything here is plain data: the Temporal workflow persists none of it
// directly, but every value must survive JSON round-trips and replay, so there
// are no classes, Maps, Sets or functions in state, commands or events.
//
// Two groups are deliberately local and provisional:
//   - ProjectedTaskStatus mirrors TaskStatus plus PAUSED, WAITING_FOR_APPROVAL and
//     BUDGET_EXHAUSTED, until the contracts extension lands and TaskStatus carries
//     them itself;
//   - the Core* assurance types mirror only the fields of the review-loop slot
//     contract that the core reads, until the shared contract text replaces them.

import type { ArtifactRef, AttemptId, Budget, RiskLevel, RunId, TaskId } from '@asep/contracts';

export type { ArtifactRef, AttemptId, Budget, RiskLevel, RunId, TaskId };

/** The 17 classes of `policies/failure-taxonomy.yaml` (parity is tested). */
export type FailureClass =
  | 'baseline'
  | 'pre-existing'
  | 'introduced-regression'
  | 'environment'
  | 'flaky-test'
  | 'provider'
  | 'quota-rate-limit'
  | 'context'
  | 'skill-routing'
  | 'tool'
  | 'policy-violation'
  | 'agent-loop-stall'
  | 'false-completion'
  | 'review-escape'
  | 'duplicate-side-effect'
  | 'artifact-loss'
  | 'workflow-recovery-failure';

export type ProjectedTaskStatus =
  | 'PENDING'
  | 'READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'WAITING_FOR_HUMAN_REVIEW'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'PAUSED'
  | 'WAITING_FOR_APPROVAL'
  | 'BUDGET_EXHAUSTED';

export type TaskOutcome = 'WAITING_FOR_HUMAN_REVIEW' | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'CANCELLED';

export type TaskPhase =
  | 'ADMITTING'
  | 'BUDGET_CHECK'
  | 'ATTEMPT_STARTING'
  | 'AGENT_RUNNING'
  | 'INSPECTING'
  | 'VERIFYING'
  | 'COMMITTING'
  | 'EVIDENCE'
  | 'ASSURANCE_ROUND'
  | 'PUBLICATION_GATE'
  | 'AWAITING_APPROVAL'
  | 'PUBLISHING'
  | 'REVIEW_HANDOFF'
  | 'ATTEMPT_ABANDONED'
  | 'ATTEMPT_EXHAUSTED'
  | 'PAUSED'
  | 'CANCELLING'
  | 'CLEANUP'
  | 'CLOSED';

export type AttemptKind = 'initial' | 'retry' | 'repair';
export type AgentStatus = 'AGENT_DONE' | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED';
export type VerificationVerdict = 'PASS' | 'FAIL' | 'ERROR';

/** Attempt terminals reported through the slot's recordAttemptOutcome (architecture §12). */
export type AttemptTerminal =
  | 'verification-failed'
  | 'proceeded'
  | 'repair-requested'
  | 'escalated'
  | 'blocked'
  | 'budget-exhausted'
  | 'failed'
  | 'cancelled';

export type ApprovalKind = 'budget-extension' | 'publish-change';
export type ApprovalDecisionValue = 'approve' | 'reject';

// --- review-loop slot (core-local view) -------------------------------------

export type AssuranceOutcomeKind = 'PROCEED' | 'REPAIR' | 'ESCALATE' | 'BLOCK';

/** The fields of one assurance outcome that the core reads. Validated from `unknown`. */
export type CoreAssuranceOutcome =
  | {
      readonly kind: 'PROCEED';
      readonly adjudicationId: string;
      readonly prBodySectionRef: ArtifactRef;
    }
  | {
      readonly kind: 'ESCALATE';
      readonly adjudicationId: string;
      readonly reason: string;
      readonly prBodySectionRef: ArtifactRef;
    }
  | {
      readonly kind: 'REPAIR';
      readonly adjudicationId: string;
      readonly repairOrderRef: ArtifactRef;
      readonly nextRound: number;
      readonly repairBaseSha: string;
    }
  | {
      readonly kind: 'BLOCK';
      readonly adjudicationId: string;
      readonly reason: string;
    };

/** What the core decides about one assurance round; the activity adds the durable facts. */
export interface CoreAssuranceRequest {
  readonly attemptNumber: number;
  readonly round: number;
  readonly evidenceId: string;
  readonly taskBaseSha: string;
  readonly declaredComplete: boolean;
  readonly priorAdjudicationId: string | null;
  readonly idempotencyKey: string;
}

// --- task workflow input ------------------------------------------------------

export interface TaskBudget {
  readonly maxAttempts: number;
  readonly maxCostUsd: number;
  readonly softCostUsd: number;
  readonly maxWallClockMinutes: number;
}

/**
 * Shadow: assurance never gates a merge, so an unavailable assurance round
 * continues as PROCEED. Gating: it continues as ESCALATE.
 */
export type AssuranceMode = 'shadow' | 'gating';

export interface TaskGovernance {
  readonly publicationApprovalRequired: boolean;
  readonly approvalTtlSeconds: number;
  readonly maxPauseHours: number;
  readonly assuranceMode: AssuranceMode;
}

export interface OrchestrationPolicy {
  /** Failure classes after which an abandoned attempt may be replaced by a new one. */
  readonly replaceableFailureClasses: readonly FailureClass[];
  /**
   * Upper bound of one budget-extension grant. Null (unset) makes budget-extension
   * approval unavailable: a task-cap shortfall then ends the task BUDGET_EXHAUSTED.
   */
  readonly maxBudgetExtensionUsd: number | null;
  /**
   * The agent adapter's interval between its stop signal at the wall-clock cap
   * and its hard kill: the only tolerance on the measured wall-clock. Data, not
   * a business allowance; 0 means none.
   */
  readonly agentKillGraceSeconds: number;
}

/** Reserved for mandatory verification at every attempt start, apart from the agent's cap. */
export interface VerificationReserve {
  readonly costUsd: number;
  readonly wallClockMinutes: number;
}

export interface TaskCoreInput {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly risk: RiskLevel;
  readonly baseSha: string;
  readonly attemptBudget: Budget;
  readonly taskBudget: TaskBudget;
  readonly verificationReserve: VerificationReserve;
  /** Run budget left when this task's workflow started. */
  readonly runRemainingUsd: number;
  readonly governance: TaskGovernance;
  readonly policy: OrchestrationPolicy;
}

// --- requests: activities whose result drives the next decision --------------

export type TaskRequest =
  | { readonly kind: 'admitTask'; readonly risk: RiskLevel }
  | {
      readonly kind: 'ensureAttempt';
      readonly attemptNumber: number;
      readonly attemptKind: AttemptKind;
      readonly baseSha: string;
      readonly parentAttemptNumber: number | null;
      readonly repairOrderRef: ArtifactRef | null;
    }
  | { readonly kind: 'acquireLease'; readonly attemptNumber: number }
  | { readonly kind: 'prepareWorkspace'; readonly attemptNumber: number; readonly baseSha: string }
  | {
      readonly kind: 'storeAttemptInputs';
      readonly attemptNumber: number;
      /** Set for an attempt with a repair lineage: the inputs are derived with buildRepairContextPack. */
      readonly repairOrderRef: ArtifactRef | null;
    }
  | { readonly kind: 'runAgent'; readonly attemptNumber: number; readonly budget: Budget }
  | { readonly kind: 'inspectWorkspace'; readonly attemptNumber: number }
  | { readonly kind: 'runVerification'; readonly attemptNumber: number }
  | { readonly kind: 'commitAttempt'; readonly attemptNumber: number; readonly expectedHeadSha: string }
  | { readonly kind: 'persistEvidence'; readonly attemptNumber: number }
  | { readonly kind: 'assuranceRound'; readonly request: CoreAssuranceRequest }
  | {
      readonly kind: 'openApprovalRequest';
      readonly approvalRequestId: string;
      readonly approvalKind: ApprovalKind;
      readonly attemptNumber: number | null;
      readonly ttlSeconds: number;
      readonly shortfallUsd: number | null;
    }
  | { readonly kind: 'verifyApprovalDecision'; readonly approvalRequestId: string; readonly decisionId: string }
  | { readonly kind: 'publishBranch'; readonly attemptNumber: number }
  | {
      readonly kind: 'upsertPullRequest';
      readonly attemptNumber: number;
      readonly flagged: boolean;
      /** Null when the assurance round was unavailable; the PR body then says so. */
      readonly prBodySectionRef: ArtifactRef | null;
    };

export type TaskRequestKind = TaskRequest['kind'];

// --- effects: run in order, to completion, no result consumed ----------------

export type RunEventDetail = Readonly<Record<string, string | number | boolean>>;

/**
 * Run event types the workflows emit themselves. `attempt.declared_complete` and
 * `attempt.completed` are absent on purpose: recordAttemptOutcome is their only emitter.
 */
export type RunEventType =
  | 'run.started'
  | 'run.completed'
  | 'task.started'
  | 'task.completed'
  | 'attempt.started'
  | 'repair.started'
  | 'workflow.recovered'
  | 'approval.requested'
  | 'approval.expired'
  | 'budget.threshold_crossed';

export type TaskEffect =
  | { readonly kind: 'projectTaskState'; readonly projectionSeq: number; readonly status: ProjectedTaskStatus }
  | {
      readonly kind: 'emitRunEvent';
      readonly eventSeq: number;
      readonly eventType: RunEventType;
      readonly attemptNumber: number | null;
      readonly detail: RunEventDetail;
    }
  | {
      readonly kind: 'recordAttemptOutcome';
      readonly attemptNumber: number;
      readonly terminal: AttemptTerminal;
      readonly declaredComplete: boolean;
      readonly verificationVerdict: VerificationVerdict | null;
      readonly adjudicationId: string | null;
    }
  | {
      readonly kind: 'recordUsage';
      readonly attemptNumber: number;
      /** Agent cost plus, once verification ran, the verification reserve. */
      readonly chargedCostUsd: number;
      readonly reportedCostUsd: number | null;
      readonly verificationReserveUsd: number;
      readonly chargedWallClockMinutes: number;
    }
  | {
      readonly kind: 'recordOverrun';
      readonly attemptNumber: number;
      readonly overrunUsd: number;
      readonly overrunToolCalls: number;
      /** Measured wall-clock beyond the cap, once it exceeded the cap plus the kill grace. */
      readonly overrunWallClockMs: number;
    }
  | { readonly kind: 'recordExtension'; readonly approvalRequestId: string; readonly extensionUsd: number }
  | { readonly kind: 'reapContainers'; readonly attemptNumber: number }
  | { readonly kind: 'quarantineWorkspace'; readonly attemptNumber: number; readonly reason: string }
  | { readonly kind: 'cleanupWorkspace'; readonly attemptNumber: number }
  | { readonly kind: 'releaseLease'; readonly attemptNumber: number }
  | { readonly kind: 'expireApprovalRequest'; readonly approvalRequestId: string }
  | { readonly kind: 'cancelApprovalRequest'; readonly approvalRequestId: string }
  | {
      readonly kind: 'recordControl';
      readonly requestId: string;
      readonly control: 'pause' | 'resume' | 'cancel';
      readonly principalId: string;
    }
  | { readonly kind: 'audit'; readonly action: string; readonly detail: RunEventDetail }
  | { readonly kind: 'startTimer'; readonly timerId: string; readonly seconds: number }
  | { readonly kind: 'cancelTimer'; readonly timerId: string };

export interface TaskSummary {
  readonly outcome: TaskOutcome;
  readonly reason: string;
  readonly attempts: number;
  readonly chargedCostUsd: number;
  readonly prNumber: number | null;
}

export type TaskCommand =
  | { readonly type: 'effect'; readonly effect: TaskEffect }
  | { readonly type: 'request'; readonly seq: number; readonly request: TaskRequest }
  | { readonly type: 'complete'; readonly summary: TaskSummary };

// --- events fed back by the interpreter ---------------------------------------

export type TaskResult =
  | { readonly kind: 'admitTask'; readonly admitted: boolean; readonly reason: string }
  | { readonly kind: 'ensureAttempt'; readonly attemptId: AttemptId }
  | { readonly kind: 'acquireLease' }
  | { readonly kind: 'prepareWorkspace' }
  | { readonly kind: 'storeAttemptInputs' }
  | {
      readonly kind: 'runAgent';
      /** BUDGET_EXHAUSTED: the adapter stopped the agent at one of its caps. */
      readonly status: AgentStatus;
      /** Provider-reported usage (untrusted) and harness-measured wall-clock. */
      readonly reportedCostUsd: number;
      readonly reportedToolCalls: number;
      readonly wallClockMs: number;
      /** Required when status is FAILED or BLOCKED; a cap stop may carry one too. */
      readonly failureClass: FailureClass | null;
    }
  | { readonly kind: 'inspectWorkspace'; readonly overstep: boolean }
  | { readonly kind: 'runVerification'; readonly verdict: VerificationVerdict }
  | { readonly kind: 'commitAttempt'; readonly resultSha: string }
  | { readonly kind: 'persistEvidence'; readonly evidenceId: string }
  | { readonly kind: 'assuranceRound'; readonly outcome: unknown }
  | { readonly kind: 'openApprovalRequest' }
  | {
      readonly kind: 'verifyApprovalDecision';
      readonly verified: boolean;
      readonly decision: ApprovalDecisionValue | null;
      readonly extensionUsd: number | null;
    }
  | { readonly kind: 'publishBranch' }
  | { readonly kind: 'upsertPullRequest'; readonly prNumber: number };

export type TaskMessage =
  | { readonly type: 'pauseRequested'; readonly requestId: string; readonly principalId: string }
  | { readonly type: 'resumeRequested'; readonly requestId: string; readonly principalId: string }
  | { readonly type: 'cancelRequested'; readonly requestId: string; readonly principalId: string }
  | {
      readonly type: 'approvalDecisionReceived';
      readonly decisionId: string;
      readonly approvalRequestId: string;
      readonly decision: ApprovalDecisionValue;
      readonly extensionUsd: number | null;
      readonly principalId: string;
    };

export type TaskEvent =
  | { readonly type: 'result'; readonly seq: number; readonly result: TaskResult }
  | {
      readonly type: 'activityFailed';
      readonly seq: number;
      readonly activity: TaskRequestKind;
      readonly failureClass: FailureClass;
      /** True when the engine gave up because heartbeats stopped (worker death). */
      readonly timedOut: boolean;
    }
  | { readonly type: 'timerFired'; readonly timerId: string }
  | TaskMessage;

export type ControlRejection =
  | 'already-paused'
  | 'not-paused'
  | 'closed'
  | 'unknown-approval'
  | 'decision-conflict'
  | 'decision-not-allowed'
  | 'extension-out-of-bounds'
  | 'run-task-limit';

export interface ControlReceipt {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly reason: ControlRejection | null;
}

// --- task state ---------------------------------------------------------------

/**
 * What an attempt builds on after an assurance REPAIR. It is separate from the
 * attempt kind: a repair attempt starts a lineage, a retry copies the lineage of
 * the attempt it replaces, and an initial attempt (or a retry of one) has none.
 */
export interface RepairLineage {
  readonly repairBaseSha: string;
  readonly repairOrderRef: ArtifactRef;
  readonly round: number;
  readonly priorAdjudicationId: string;
  /** The attempt whose harness commit is the repair base. */
  readonly parentAttemptNumber: number;
}

/** The agent's usage as charged: reported cost if usable, else the full cap. */
export interface AgentUsage {
  readonly chargedMicroUsd: number;
  readonly reportedCostUsd: number | null;
  readonly minutes: number;
}

export interface AttemptOverrun {
  readonly overrunUsd: number;
  readonly overrunToolCalls: number;
  readonly overrunWallClockMs: number;
}

export interface AttemptState {
  readonly attemptNumber: number;
  readonly kind: AttemptKind;
  readonly lineage: RepairLineage | null;
  readonly attemptId: AttemptId | null;
  readonly leaseRequested: boolean;
  readonly leaseReleased: boolean;
  readonly workspaceRequested: boolean;
  readonly workspaceActive: boolean;
  readonly workspaceDisposed: boolean;
  readonly agentStarted: boolean;
  readonly agentUsage: AgentUsage | null;
  /** Usage above a cap the adapter did not stop at: reported cost or tool calls, or measured wall-clock. */
  readonly overrun: AttemptOverrun | null;
  /** The agent stopped at a cap or overran one: the attempt is inspected, never verified or published. */
  readonly exhausted: boolean;
  readonly verificationStarted: boolean;
  readonly reaped: boolean;
  readonly declaredComplete: boolean;
  readonly verdict: VerificationVerdict | null;
  readonly resultSha: string | null;
  readonly evidenceId: string | null;
  readonly adjudicationId: string | null;
  readonly outcomeRecorded: boolean;
  readonly usageRecorded: boolean;
}

export interface OpenApproval {
  readonly approvalRequestId: string;
  readonly kind: ApprovalKind;
  readonly attemptNumber: number | null;
  /** False until openApprovalRequest has completed; decisions for an unopened request are unknown. */
  readonly opened: boolean;
  /** The accepted decision being verified against PostgreSQL, if any. */
  readonly pendingDecisionId: string | null;
  /** The expiry timer fired while a decision was being verified; expiry wins once verification returns. */
  readonly expiryFired: boolean;
}

export interface PendingRequest {
  readonly seq: number;
  readonly request: TaskRequest;
}

export interface PublicationPlan {
  readonly attemptNumber: number;
  readonly flagged: boolean;
  readonly prBodySectionRef: ArtifactRef | null;
  readonly terminal: 'proceeded' | 'escalated';
}

export interface NextAttemptPlan {
  readonly kind: AttemptKind;
  readonly lineage: RepairLineage | null;
  readonly replacesTimedOut: boolean;
}

export interface TaskState {
  readonly input: TaskCoreInput;
  readonly workflowId: string;
  readonly phase: TaskPhase;
  readonly nextSeq: number;
  readonly pending: PendingRequest | null;
  /** A request withheld because the task was paused at a phase boundary. */
  readonly deferred: TaskRequest | null;
  readonly attempts: readonly AttemptState[];
  readonly currentAttempt: number | null;
  readonly nextAttempt: NextAttemptPlan | null;
  readonly publication: PublicationPlan | null;
  readonly spentMicroUsd: number;
  readonly spentWallClockMinutes: number;
  readonly grantedExtensionMicroUsd: number;
  readonly softThresholdCrossed: boolean;
  readonly overrun: boolean;
  readonly pushRequested: boolean;
  readonly approval: OpenApproval | null;
  readonly gateSeq: number;
  readonly decisionIds: readonly string[];
  readonly controlRequestIds: readonly string[];
  readonly paused: boolean;
  readonly pauseCount: number;
  readonly pauseTimerId: string | null;
  readonly activeTimers: readonly string[];
  readonly cancelPending: boolean;
  readonly projectionSeq: number;
  readonly projected: ProjectedTaskStatus;
  /** The last working status (READY, EXECUTING or VERIFYING); PAUSED and approval waits return to it. */
  readonly workStatus: ProjectedTaskStatus;
  readonly eventSeq: number;
  readonly prNumber: number | null;
  readonly outcome: TaskOutcome | null;
  readonly reason: string | null;
}

export interface TaskDecision {
  readonly state: TaskState;
  readonly commands: readonly TaskCommand[];
  /** True when the in-flight request must be cancelled; its late result is ignored. */
  readonly abortInFlight: boolean;
  /** Present when the event was a message (Update/Signal). */
  readonly receipt: ControlReceipt | null;
}
