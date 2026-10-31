// Core-local types of the workflow decision core.
//
// Everything here is plain data: the Temporal workflow persists none of it
// directly, but every value must survive JSON round-trips and replay, so there
// are no classes, Maps, Sets or functions in state, commands or events.
//
// Two groups are deliberately local:
//   - ProjectedTaskStatus mirrors TaskStatus plus PAUSED, WAITING_FOR_APPROVAL and
//     BUDGET_EXHAUSTED, until the contracts extension lands and TaskStatus carries
//     them itself;
//   - the review-loop slot types (the round outcome, the fence, the attempt
//     terminals) carry the names and shapes of the locked slot contract in
//     packages/application/src/review-loop/slot.ts. They are copies, because the
//     core's production source imports only contracts and ports; a type-level test
//     holds each copy equal to the contract's.

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

/** Attempt terminals reported through the slot's recordAttemptOutcome (architecture §12): the slot contract's. */
export type AttemptTerminal =
  | 'verification-stopped'
  | 'proceeded'
  | 'repair-requested'
  | 'escalated'
  | 'blocked'
  | 'agent-failed'
  | 'budget-exhausted'
  | 'cancelled'
  | 'infrastructure-failed';

/** The only terminals of an attempt that never held a lease, written with fence null. */
export type PreLeaseAttemptTerminal = 'cancelled' | 'infrastructure-failed';

export type ApprovalKind = 'budget-extension' | 'publish-change';
export type ApprovalDecisionValue = 'approve' | 'reject';

// --- review-loop slot (the contract's names and shapes) ------------------------

export type ReviewLoopSlotVersion = 'review-loop/v1';

/** The caller's fence on its workspace lease: the lease primitive's lease id and fencing epoch. */
export interface AssuranceFence {
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

export type ReviewMode = 'not-required' | 'shadow' | 'gating';

export type EscalationReason =
  | 'packet-over-budget'
  | 'egress-stopped'
  | 'independence-unsatisfiable'
  | 'reviewer-unavailable'
  | 'reviewer-escalated'
  | 'max-repair-rounds'
  | 'budget-exhausted';

export type BlockReason = 'secret-in-diff' | 'forbidden-path' | 'unscannable-sensitive-change';

export interface AssuranceUsage {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Integer micro-USD; null when a call of the round has no configured price. */
  readonly reviewCostMicroUsd: number | null;
}

/** What gating mode would have decided; recorded only. */
export interface ShadowVerdict {
  readonly wouldBe: 'PROCEED' | 'REPAIR' | 'ESCALATE';
  readonly reason: EscalationReason | 'blocking-findings' | null;
  readonly blockingFindings: number;
}

export interface AssuranceOutcomeBase {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** Equals the request's idempotency key. */
  readonly roundKey: string;
  /** 64 lowercase hex. */
  readonly adjudicationId: string;
  readonly usage: AssuranceUsage;
}

export interface ProceedOutcomeFields extends AssuranceOutcomeBase {
  readonly kind: 'PROCEED';
  /** Null when the round has nothing to show. */
  readonly prBodySectionRef: ArtifactRef | null;
}

export interface ShadowProceedOutcome extends ProceedOutcomeFields {
  readonly mode: 'shadow';
  readonly shadow: ShadowVerdict;
}

export interface DecidedProceedOutcome extends ProceedOutcomeFields {
  readonly mode: 'gating' | 'not-required';
  readonly shadow: null;
}

export type ProceedOutcome = ShadowProceedOutcome | DecidedProceedOutcome;

export interface RepairOutcome extends AssuranceOutcomeBase {
  readonly kind: 'REPAIR';
  readonly mode: 'gating';
  readonly repairOrderRef: ArtifactRef;
  /** The round plus one. */
  readonly nextRound: number;
  /** The attempt's harness commit. */
  readonly repairBaseSha: string;
}

export interface EscalateOutcome extends AssuranceOutcomeBase {
  readonly kind: 'ESCALATE';
  readonly mode: 'gating';
  readonly reason: EscalationReason;
  readonly prBodySectionRef: ArtifactRef;
}

export interface BlockOutcome extends AssuranceOutcomeBase {
  readonly kind: 'BLOCK';
  readonly mode: ReviewMode;
  readonly reason: BlockReason;
  readonly prBodySectionRef: ArtifactRef | null;
}

/** One assurance round's outcome. It arrives as `unknown` and is validated field by field. */
export type AssuranceOutcome = ProceedOutcome | RepairOutcome | EscalateOutcome | BlockOutcome;

export type AssuranceOutcomeKind = AssuranceOutcome['kind'];

/**
 * What the core decides about one assurance round, under the slot input's names; the activity adds the durable
 * facts (scope, ids, refs, implementer and the fence).
 */
export interface CoreAssuranceRequest {
  readonly attemptNumber: number;
  readonly round: number;
  readonly evidenceId: string;
  readonly taskBaseSha: string;
  readonly declaredComplete: boolean;
  readonly priorAdjudicationId: string | null;
  /** `<attemptId>:assurance:<round>`. */
  readonly idempotencyKey: string;
  /** What the task may still spend, from the core's integer ledger: micro-USD and milliseconds. */
  readonly budgetRemaining: { readonly costMicroUsd: number | null; readonly wallClockMs: number };
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

/**
 * A forge repository. Its identity is the forge's numeric id, which a rename or a transfer keeps; the owner and name
 * are those the binding records or the forge reports now, informational only.
 */
export interface ForgeRepository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
}

export interface TaskCoreInput {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly risk: RiskLevel;
  readonly baseSha: string;
  /** The repository binding's repository: every publication of the task goes there. */
  readonly repository: ForgeRepository;
  /** The branch the task's PR targets; the PR upsert uses it and a publication reconciliation checks the PR's base. */
  readonly baseBranch: string;
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
  /** After a failed ensureAttempt: look the attempt up by its natural key, to learn whether it exists. */
  | { readonly kind: 'findAttempt'; readonly attemptNumber: number }
  | { readonly kind: 'acquireLease'; readonly attemptNumber: number }
  /** After a failed or aborted acquireLease: read the attempt's durable lease history, to learn whether a grant committed. */
  | { readonly kind: 'findLease'; readonly attemptNumber: number }
  /**
   * The terminal of an attempt whose lease history shows no lease, written with fence null. The slot refuses it if
   * history shows a lease by then, so its result is awaited.
   */
  | {
      readonly kind: 'recordPreLeaseOutcome';
      readonly attemptNumber: number;
      readonly round: number;
      readonly terminal: PreLeaseAttemptTerminal;
      readonly declaredComplete: boolean;
      readonly verificationVerdict: VerificationVerdict | null;
      readonly adjudicationId: string | null;
      readonly failureClass: FailureClass | null;
    }
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
      /** The binding repository the PR is opened in: the task input's repository. */
      readonly repository: ForgeRepository;
      /** The PR's base: the task input's base branch. */
      readonly baseBranch: string;
      readonly flagged: boolean;
      /**
       * Null when the round had nothing to show (a `PROCEED` without a section) or was unavailable; the audit trail
       * tells the two apart.
       */
      readonly prBodySectionRef: ArtifactRef | null;
    }
  | {
      /**
       * A look at the remote after a publication effect reported `unknown`. Its only write rewrites a diverged title
       * and body of the attempt's open PR from the attempt's immutable facts, reported per PR as `contentRepaired`;
       * it never creates, retargets or closes a PR, and it decides nothing.
       */
      readonly kind: 'reconcilePublication';
      readonly attemptNumber: number;
      /** The binding repository the attempt branch was pushed to. */
      readonly repository: ForgeRepository;
      readonly remoteBranch: string;
      /** The attempt's commit: the push applied exactly when the branch head is this commit. */
      readonly expectedHeadSha: string;
      /** The base a PR of this attempt must have. */
      readonly expectedBaseBranch: string;
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

/** The facts of one attempt terminal that only the workflow knows, under the slot's attempt-outcome names. */
export interface AttemptOutcomeFacts {
  readonly attemptNumber: number;
  readonly round: number;
  readonly declaredComplete: boolean;
  readonly verificationVerdict: VerificationVerdict | null;
  readonly adjudicationId: string | null;
  /** The round failed and the attempt continued as `proceeded` or `escalated` without an adjudication. */
  readonly assuranceUnavailable: boolean;
  readonly failureClass: FailureClass | null;
  /** The agent's reported model cost in integer micro-USD, rounded up once; null when it reported none usable. */
  readonly modelCostMicroUsd: number | null;
}

/**
 * An attempt terminal as the core records it: with the caller's fence of the lease the attempt holds or held, or
 * with none, and then only with a pre-lease terminal, for an attempt that never held a lease.
 */
export type AttemptOutcomeRecord =
  | (AttemptOutcomeFacts & { readonly fence: AssuranceFence; readonly terminal: AttemptTerminal })
  | (AttemptOutcomeFacts & { readonly fence: null; readonly terminal: PreLeaseAttemptTerminal });

export type TaskEffect =
  | { readonly kind: 'projectTaskState'; readonly projectionSeq: number; readonly status: ProjectedTaskStatus }
  | {
      readonly kind: 'emitRunEvent';
      readonly eventSeq: number;
      readonly eventType: RunEventType;
      readonly attemptNumber: number | null;
      readonly detail: RunEventDetail;
    }
  | ({ readonly kind: 'recordAttemptOutcome' } & AttemptOutcomeRecord)
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
      /**
       * A reported cost, tool-call count or measured wall-clock was not a valid amount within its bound: an overrun
       * by itself, also when the excess cannot be stated (a cost above MAX_USD on a cap at the bound).
       */
      readonly usageOutOfBound: boolean;
    }
  | { readonly kind: 'recordExtension'; readonly approvalRequestId: string; readonly extensionUsd: number }
  | { readonly kind: 'reapContainers'; readonly attemptNumber: number }
  | { readonly kind: 'quarantineWorkspace'; readonly attemptNumber: number; readonly reason: string }
  | { readonly kind: 'cleanupWorkspace'; readonly attemptNumber: number }
  | { readonly kind: 'releaseLease'; readonly attemptNumber: number; readonly fence: AssuranceFence }
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
  /** Attempts whose terminal was not recorded because their state could not be read; telemetry reports each as a gap. */
  readonly unrecordedAttempts: readonly UnrecordedAttempt[];
}

export interface UnrecordedAttempt {
  readonly attemptNumber: number;
  /** The attempt's natural key (task id, attempt number), rendered `<taskId>:attempt:<n>`, for an operator to reconcile. */
  readonly idempotencyKey: string;
}

export type TaskCommand =
  | { readonly type: 'effect'; readonly effect: TaskEffect }
  | { readonly type: 'request'; readonly seq: number; readonly request: TaskRequest }
  | { readonly type: 'complete'; readonly summary: TaskSummary };

// --- events fed back by the interpreter ---------------------------------------

export type TaskResult =
  | { readonly kind: 'admitTask'; readonly admitted: boolean; readonly reason: string }
  | {
      readonly kind: 'ensureAttempt';
      readonly attemptId: AttemptId;
      /** The attempt's remote branch, named by the Git adapter's attempt branch rule. */
      readonly branch: string;
    }
  /** Null: no attempt row exists, so the failed registration never inserted one. */
  | { readonly kind: 'findAttempt'; readonly attemptId: AttemptId | null }
  | { readonly kind: 'acquireLease'; readonly fence: AssuranceFence }
  /** Null: durable history shows no lease of the attempt. */
  | { readonly kind: 'findLease'; readonly fence: AssuranceFence | null }
  /**
   * False: refused, because durable history now shows a lease (a grant committed after the lookup); the slot's
   * `lease-granted` refusal, never an activity failure.
   */
  | { readonly kind: 'recordPreLeaseOutcome'; readonly recorded: boolean }
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
  | { readonly kind: 'publishBranch'; readonly effect: 'applied' }
  | { readonly kind: 'upsertPullRequest'; readonly effect: 'applied'; readonly prNumber: number }
  | {
      readonly kind: 'reconcilePublication';
      /** The attempt branch as read, or null when it does not exist. */
      readonly branch: ObservedBranch | null;
      /**
       * Every PR the forge lists with the attempt branch as head branch, in any state and from any head repository.
       * The core decides which, if any, is the attempt's; it does not rely on the read's filter.
       */
      readonly pullRequests: readonly ObservedPullRequest[];
    };

/** The attempt branch as a reconciliation read observed it. */
export interface ObservedBranch {
  readonly repository: ForgeRepository;
  readonly headSha: string;
}

/** A PR as a reconciliation read observed it; the core, not the activity, decides whether it is the attempt's. */
export interface ObservedPullRequest {
  readonly number: number;
  readonly headRepository: ForgeRepository;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseRepository: ForgeRepository;
  readonly baseBranch: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  /**
   * The read found this PR's title or body different from the content the attempt's immutable facts give, and
   * rewrote them; the core audits every repair, whatever it decides about the publication.
   */
  readonly contentRepaired: boolean;
}

/**
 * Whether a publication activity's external effect (the push, the PR upsert)
 * happened. `none` only when the activity proves it failed before the forge
 * call, or a reconciliation read shows the effect absent. Anything after the
 * call started (a fencing error raised after it, a timeout) is `unknown`,
 * whatever the error's retryability.
 */
export type PublicationEffect = 'applied' | 'none' | 'unknown';

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
      /**
       * For a publication activity, the effect its failure reported; `unknown` when it reported none. Retryability
       * is deliberately absent: it says nothing about what the remote holds. Other activities ignore it.
       */
      readonly effect: PublicationEffect;
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
  | 'run-task-limit'
  | 'run-sealed'
  | 'already-sealed';

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
  /** The reported cost in micro-USD, rounded up; null when it is not an amount within the bound. */
  readonly reportedMicroUsd: number | null;
  readonly minutes: number;
}

export interface AttemptOverrun {
  readonly overrunUsd: number;
  readonly overrunToolCalls: number;
  readonly overrunWallClockMs: number;
  /** A reported cost, tool-call count or measured wall-clock was not a valid amount within its bound. */
  readonly usageOutOfBound: boolean;
}

export interface AttemptState {
  readonly attemptNumber: number;
  readonly kind: AttemptKind;
  readonly lineage: RepairLineage | null;
  readonly attemptId: AttemptId | null;
  readonly branch: string | null;
  /**
   * The attempt is known to exist: its registration returned, or the lookup
   * after a failed registration found it. Only registered attempts get usage
   * and outcome records.
   */
  readonly registered: boolean;
  /**
   * A lookup of the attempt's state failed: whether it exists, or whether it holds a lease, is unknown, so it gets
   * no usage, outcome or release.
   */
  readonly stateUnknown: boolean;
  readonly leaseRequested: boolean;
  /** The fence of the lease the attempt holds or held, from acquireLease or findLease; null while none is known. */
  readonly fence: AssuranceFence | null;
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
  /** The assurance round failed and the attempt continued without an adjudication (audited `assurance-unavailable`). */
  readonly assuranceUnavailable: boolean;
  /** The failure class the attempt ended on; null while none is known. */
  readonly failureClass: FailureClass | null;
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

/** A lease acquisition failed or was aborted: the lookups that settle whether its grant committed, and what follows. */
export interface LeaseLookup {
  readonly attemptNumber: number;
  /** findLease requests issued: one, and a second only after the pre-lease write was refused. */
  readonly lookups: number;
  /** The acquisition's failure class; null when a cancel aborted it. */
  readonly failureClass: FailureClass | null;
  readonly timedOut: boolean;
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
  readonly leaseLookup: LeaseLookup | null;
  readonly publication: PublicationPlan | null;
  readonly spentMicroUsd: number;
  readonly spentWallClockMinutes: number;
  readonly grantedExtensionMicroUsd: number;
  readonly softThresholdCrossed: boolean;
  readonly overrun: boolean;
  readonly pushRequested: boolean;
  /** The push activity completed; false after an ambiguous push failure. */
  readonly pushConfirmed: boolean;
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
