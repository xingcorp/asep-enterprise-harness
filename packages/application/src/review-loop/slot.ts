// ===========================================================================
// packages/application/src/review-loop/slot.ts                     (S0; review-loop/v1)
// ===========================================================================
// The review-loop slot: one assurance round after evidence is persisted and before
// push. Framework-free: no orchestration SDK, no wall-clock reads, no process
// environment.
//
// Envelope. Every input and output is plain JSON, recursively: null, a string, a
// boolean, a finite number, an array or a plain object of those; no undefined keys or
// values, non-finite numbers, -0, functions, bigint, symbols, Dates, Maps, Sets or class
// instances. No method returns undefined. reviewLoopPayloadBytes checks this before it
// measures, and every payload is at most REVIEW_LOOP_MAX_PAYLOAD_BYTES when serialized.
// A ContextPack, a packet, a check report, a review record, a repair order, a PR section
// and any list that grows with the change travel by ArtifactRef, never inline.
//
// Money. Every money field is named *MicroUsd and holds integer micro-USD: a non-negative
// safe integer, or null meaning unknown. reviewLoopPayloadBytes rejects any other value
// under such a key. A provider's decimal USD is converted once, in the adapter that
// receives it, rounding up (ceiling), so no overrun is rounded away; the slot never
// carries floating USD, and USD for display is rendered outside it.
//
// Time. AssuranceStepContext.now() is one fixed logical time per activity execution,
// identical on every retry of that execution. Every timestamp an implementation
// writes (row columns, run events) comes from it, so a redelivery writes
// byte-identical records and events. Content-addressed artifacts (packet, check
// report, review record, adjudication record, repair order) carry no timestamp, so
// their ids and the round's outcome do not depend on which execution produced them.
//
// The assurance service implements ReviewLoopSlot; the orchestration workflow composes
// it and wraps each call as an activity. Changing this file after S0 needs a new
// controller reconciliation.

import type {
  ArtifactRef,
  AttemptId,
  RepositoryBindingId,
  RiskLevel,
  RunId,
  TaskId,
  TenantScope,
} from '@asep/contracts';
import type { WorkspaceCapability } from '@asep/ports';
import type { AdmissionResult } from '../risk-admission.js';

export const REVIEW_LOOP_SLOT_VERSION = 'review-loop/v1' as const;
export type ReviewLoopSlotVersion = typeof REVIEW_LOOP_SLOT_VERSION;

/** Explicit literal a composition must pass to opt out of independent assurance (Phase 2 behaviour). */
export const REVIEW_LOOP_DISABLED = 'review-loop-disabled-phase2-behaviour' as const;

/** Largest serialized size of any slot input or output, in UTF-8 bytes of JSON.stringify(value). */
export const REVIEW_LOOP_MAX_PAYLOAD_BYTES = 65_536;

// --- delivery context ---------------------------------------------------------

export type AssuranceStepName =
  | 'plan'
  | 'packet'
  | 'checks'
  | 'reviewer'
  | 'adjudicate'
  | 'attempt-outcome'
  | 'repair-context';

/** Liveness detail. Never carries source text, prompts, finding text, model output or secrets. */
export interface AssuranceHeartbeat {
  readonly step: AssuranceStepName;
  readonly reviewerConfigId?: string;
  /** At most 200 characters. */
  readonly note?: string;
}

/**
 * Engine-neutral context for one delivery of one step. The orchestration adapter builds
 * it from its own activity context and the logical time carried in the activity input;
 * the sequential driver builds it from an AbortController and an injected clock.
 */
export interface AssuranceStepContext {
  readonly signal: AbortSignal;
  /**
   * ISO-8601 UTC timestamp: one fixed logical time per activity execution, identical on
   * every retry of that execution and not advancing within it. Steps take every
   * timestamp from it and never read the wall clock (see the file header).
   */
  now(): string;
  /** Called at least every 30 seconds while a step is working. */
  heartbeat(details: AssuranceHeartbeat): void;
}

// --- caller identity and fencing ----------------------------------------------

/**
 * The caller's workspace-lease identity, exactly as the caller presents it. Every claim,
 * completion and decision write the implementation makes, the writes of
 * recordAttemptOutcome and buildRepairContextPack included, checks in the same
 * transaction that this lease is ACTIVE, is held by `leaseId`, and is at `fencingEpoch`
 * (the Phase 2 fenced-takeover primitive). An implementation never substitutes the
 * epoch it reads from its own store for the caller's. A caller whose lease was taken
 * over or ended gets AssuranceFencedError and changes nothing.
 */
export interface AssuranceFence {
  readonly leaseId: string;
  /** Integer >= 1: the fencing epoch the accepted Phase 2 primitive assigned to this lease holder. */
  readonly fencingEpoch: number;
}

// --- workspace resolution -------------------------------------------------------

export interface AssuranceWorkspaceQuery {
  readonly attemptId: AttemptId;
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

/** Checked in this order; the first failing check is reported. */
export type AssuranceWorkspaceRefusal = 'not-in-scope' | 'lease-not-active' | 'lease-not-held' | 'stale-epoch';

export type AssuranceWorkspaceResolution =
  | { readonly kind: 'resolved'; readonly workspace: WorkspaceCapability }
  | { readonly kind: 'refused'; readonly reason: AssuranceWorkspaceRefusal };

/**
 * The only way an assurance step obtains the attempt's workspace for trusted reads (range
 * diffs and post-images). Framework-free and read-only; the orchestration lane implements
 * it over the workspace-lease table, and a workspace never comes from activity-local
 * memory. It checks that the attempt belongs to `scope` ('not-in-scope', which reveals
 * nothing about other tenants), and that the attempt's workspace lease is ACTIVE, is held
 * by `leaseId` and is at `fencingEpoch`. The slot maps 'not-in-scope' to
 * ReviewLoopContractError and every other refusal to AssuranceFencedError, before any
 * repository read.
 */
export interface AssuranceWorkspaceResolver {
  resolve(scope: TenantScope, query: AssuranceWorkspaceQuery): Promise<AssuranceWorkspaceResolution>;
}

// --- vocabulary ------------------------------------------------------------------

export type ReviewMode = 'not-required' | 'shadow' | 'gating';
export type ReviewKind = 'fresh' | 're-review';
export type ReviewerRole = 'primary' | 'comparator';
export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type EscalationReason =
  | 'packet-over-budget'
  | 'egress-stopped'
  | 'independence-unsatisfiable'
  | 'reviewer-unavailable'
  | 'reviewer-escalated'
  | 'max-repair-rounds'
  | 'budget-exhausted';

export type BlockReason = 'secret-in-diff' | 'forbidden-path' | 'unscannable-sensitive-change';

export type EgressDecision = 'CLEAR' | 'STOP_SECRET' | 'STOP_CLASSIFIED' | 'STOP_UNSCANNABLE';

/**
 * Reasons recorded in the packet's budget.omissions list. 'unsafe-path': the path is not a
 * normalized repository path (a control or line-separator character, an unresolved Git
 * quoted form); it is never read, and the push guard blocks the round.
 */
export type PacketOmissionReason = 'binary' | 'too-large' | 'deleted' | 'submodule' | 'non-utf8' | 'unsafe-path';

// --- round input -------------------------------------------------------------------

export interface AssuranceSlotInput {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** `${attemptId}:assurance:${round}`. A retry with the same key converges to the same outcome. */
  readonly idempotencyKey: string;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly risk: RiskLevel;
  /** 1 for the task's first attempt; +1 for each repair attempt. */
  readonly round: number;
  /** Persisted EvidenceBundle of this attempt; its resultSha is the harness commit. */
  readonly evidenceRef: ArtifactRef;
  readonly workOrderRef: ArtifactRef;
  /** 40 lowercase hex. Origin of the cumulative diff (the task's pinned base). */
  readonly taskBaseSha: string;
  /** 40 lowercase hex. The harness commit of this attempt; equals the evidence resultSha. */
  readonly resultSha: string;
  readonly implementer: { readonly providerId: string; readonly model: string };
  /** AgentAttemptObservation.status === 'AGENT_DONE'. */
  readonly declaredComplete: boolean;
  /** Non-null iff round > 1: the adjudication that requested this repair. */
  readonly priorAdjudicationId: string | null;
  readonly fence: AssuranceFence;
  /**
   * Remaining task budget; reviewer calls stop (budget-exhausted) rather than exceed it.
   * costMicroUsd: integer micro-USD, null when unknown.
   */
  readonly budgetRemaining: { readonly costMicroUsd: number | null; readonly wallClockMs: number };
}

// --- step contracts ------------------------------------------------------------------

export interface PlannedReviewer {
  readonly reviewerConfigId: string;
  readonly role: ReviewerRole;
  readonly model: string;
  /** Resolved by policy from the model id; never self-declared by a provider. */
  readonly family: string;
}

export interface AssurancePlan {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** Equals input.idempotencyKey. */
  readonly roundKey: string;
  readonly mode: ReviewMode;
  readonly reviewKind: ReviewKind;
  /** Empty when mode is 'not-required'. */
  readonly reviewers: readonly PlannedReviewer[];
  readonly maxRounds: number;
  readonly blockingSeverities: readonly FindingSeverity[];
  readonly packetBudgetBytes: number;
  /** Review-policy version plus its sha256. */
  readonly policyVersion: string;
  /** Set when the policy cannot be met (for example no eligible independent reviewer). */
  readonly unsatisfiable: EscalationReason | null;
}

export interface BuildReviewPacketInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
}

export interface BuildReviewPacketOutput {
  /** Canonical review-packet/v1 bytes; the omission list lives inside it (budget.omissions). */
  readonly packetRef: ArtifactRef;
  readonly packetSha256: string;
  /**
   * UTF-8 length of the stored canonical packet bytes, measured after budget.overBudget is
   * set, for accepted and rejected packets alike, plus every content part the prompt embeds
   * (cumulative diff, repair delta, post-images). Recorded here and with the round, never
   * inside the hashed packet.
   */
  readonly includedBytes: number;
  /**
   * The packet as it would be sent (carrying overBudget false) plus its embedded parts
   * exceeds plan.packetBudgetBytes, or a diff did not fit its reader limit. Such a packet is
   * never rendered or sent; content is never cut to fit. When false, includedBytes is at
   * most plan.packetBudgetBytes.
   */
  readonly overBudget: boolean;
  /** Number of changed files whose content the packet omits, for any reason. */
  readonly omittedFiles: number;
}

export interface DeterministicCheckInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
  readonly packetRef: ArtifactRef;
}

export interface DeterministicCheckOutput {
  /** Every deterministic and SARIF finding; raw check output is persisted first. */
  readonly checkReportRef: ArtifactRef;
  /** Secret in added lines, forbidden path, or unscannable change at a sensitive path. */
  readonly pushGuard:
    | { readonly decision: 'PASS' }
    | { readonly decision: 'BLOCK'; readonly reason: BlockReason };
  /** Decision over the exact packet bytes. Only CLEAR permits any reviewer request. */
  readonly egress: { readonly decision: EgressDecision; readonly packetSha256: string };
  readonly findings: { readonly total: number; readonly blocking: number };
}

export interface RunReviewerInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
  readonly packetRef: ArtifactRef;
  /** Must carry egress CLEAR for this packet's sha256, otherwise no request is sent. */
  readonly checkReportRef: ArtifactRef;
  readonly reviewerConfigId: string;
}

export type ReviewRecordStatus =
  /** The provider completed; the output validated against the schema and was grounded. */
  | 'COMPLETED_VALID'
  /** The provider completed; the output failed validation. */
  | 'COMPLETED_INVALID'
  /** Provider error, refusal, incomplete output, budget, cancellation, served-model drift or an oversized prompt. */
  | 'FAILED'
  /** No request was sent: the egress decision was not CLEAR or the request bytes failed the re-scan. */
  | 'EGRESS_STOPPED'
  /** No request was sent: the push guard blocked the round. */
  | 'SKIPPED_PUSH_GUARD';

export interface RunReviewerOutputFields {
  /**
   * sha256 of the canonical JSON array [attemptId, round, reviewerConfigId, packetSha256],
   * 64 lowercase hex.
   */
  readonly reviewId: string;
  /** True when a terminal record from an earlier delivery was adopted instead of calling again. */
  readonly adopted: boolean;
}

/** The provider completed: the canonical review-record/v1, valid or not, is persisted. */
export interface CompletedReviewerOutput extends RunReviewerOutputFields {
  readonly status: 'COMPLETED_VALID' | 'COMPLETED_INVALID';
  readonly reviewRecordRef: ArtifactRef;
  /** Provider requests sent for this reviewId across all deliveries; at least 1. */
  readonly providerCalls: number;
}

/** The call failed (provider error, refusal, budget, cancellation, drift, an oversized prompt): no review record. */
export interface FailedReviewerOutput extends RunReviewerOutputFields {
  readonly status: 'FAILED';
  readonly reviewRecordRef: null;
  /** Provider requests sent for this reviewId across all deliveries; 0 when none was sent. */
  readonly providerCalls: number;
}

/** No request was ever sent: egress stopped it or the push guard blocked the round. */
export interface NotSentReviewerOutput extends RunReviewerOutputFields {
  readonly status: 'EGRESS_STOPPED' | 'SKIPPED_PUSH_GUARD';
  readonly reviewRecordRef: null;
  readonly providerCalls: 0;
}

export type RunReviewerOutput = CompletedReviewerOutput | FailedReviewerOutput | NotSentReviewerOutput;

export interface AdjudicateInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
  readonly packetRef: ArtifactRef;
  readonly checkReportRef: ArtifactRef;
  /** Exactly the reviewIds of plan.reviewers, in plan order. */
  readonly reviewIds: readonly string[];
}

// --- round outcome ---------------------------------------------------------------------

export interface AssuranceUsage {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Integer micro-USD: each call's tokens × configured price, converted once with ceiling,
   * then summed. Null when any call in the round has no configured price; never estimated.
   */
  readonly reviewCostMicroUsd: number | null;
}

/** What gating mode would have decided. Recorded only; it never changes the workflow. */
export interface ShadowVerdict {
  readonly wouldBe: 'PROCEED' | 'REPAIR' | 'ESCALATE';
  readonly reason: EscalationReason | 'blocking-findings' | null;
  readonly blockingFindings: number;
}

export interface AssuranceOutcomeBase {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** Equals input.idempotencyKey. */
  readonly roundKey: string;
  /** 64 lowercase hex: sha256 of a canonical JSON array of the round's inputs. */
  readonly adjudicationId: string;
  readonly usage: AssuranceUsage;
}

export interface ProceedOutcomeFields extends AssuranceOutcomeBase {
  readonly kind: 'PROCEED';
  /** Assurance section for the PR body; null when there is nothing to show. */
  readonly prBodySectionRef: ArtifactRef | null;
}

/** Shadow mode: the round proceeds and records what gating would have decided. */
export interface ShadowProceedOutcome extends ProceedOutcomeFields {
  readonly mode: 'shadow';
  /** PROCEED in shadow mode is the only outcome that carries a shadow verdict. */
  readonly shadow: ShadowVerdict;
}

/** Gating or not-required mode: the round proceeds on its own decision. */
export interface DecidedProceedOutcome extends ProceedOutcomeFields {
  readonly mode: 'gating' | 'not-required';
  readonly shadow: null;
}

export type ProceedOutcome = ShadowProceedOutcome | DecidedProceedOutcome;

/** Gating mode only. The orchestrator starts a repair attempt with a fresh workspace at repairBaseSha. */
export interface RepairOutcome extends AssuranceOutcomeBase {
  readonly kind: 'REPAIR';
  readonly mode: 'gating';
  readonly repairOrderRef: ArtifactRef;
  /** Equals input.round + 1. */
  readonly nextRound: number;
  /** Equals input.resultSha. */
  readonly repairBaseSha: string;
}

/** Gating mode only. The orchestrator pushes, opens the PR flagged, and stops at human review. */
export interface EscalateOutcome extends AssuranceOutcomeBase {
  readonly kind: 'ESCALATE';
  readonly mode: 'gating';
  readonly reason: EscalationReason;
  readonly prBodySectionRef: ArtifactRef;
}

/**
 * Any mode: the deterministic push guard. The orchestrator does not push; the task ends
 * BLOCKED. It carries no shadow verdict in any mode: the push guard is not a gating
 * decision, so a blocked round has no would-be outcome.
 */
export interface BlockOutcome extends AssuranceOutcomeBase {
  readonly kind: 'BLOCK';
  readonly mode: ReviewMode;
  readonly reason: BlockReason;
  readonly prBodySectionRef: ArtifactRef | null;
}

export type AssuranceOutcome = ProceedOutcome | RepairOutcome | EscalateOutcome | BlockOutcome;

// --- attempt terminal telemetry ----------------------------------------------------------

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

/**
 * The only terminals an attempt that never held a workspace lease can end with: it was
 * cancelled, or infrastructure failed, after registration and before any lease. Lane A
 * confirms this list against every path of its core where an attempt is registered and
 * never leased; a terminal outside it goes back to the controller.
 */
export const PRE_LEASE_ATTEMPT_TERMINALS = ['cancelled', 'infrastructure-failed'] as const;
export type PreLeaseAttemptTerminal = (typeof PRE_LEASE_ATTEMPT_TERMINALS)[number];

export interface AttemptOutcomeFields {
  readonly slotVersion: ReviewLoopSlotVersion;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly risk: RiskLevel;
  readonly round: number;
  readonly declaredComplete: boolean;
  /** Null when verification never ran. */
  readonly verificationVerdict: 'PASS' | 'FAIL' | 'ERROR' | null;
  /** Null when no assurance round completed for this attempt. */
  readonly adjudicationId: string | null;
  /**
   * True only when the assurance activity failed after its retry policy, or
   * non-retryably: the orchestrator audited 'assurance-unavailable' and continued as
   * PROCEED (shadow) or ESCALATE (gating), so terminal is 'proceeded' or 'escalated' and
   * adjudicationId is null. Never true at a verification stop.
   */
  readonly assuranceUnavailable: boolean;
  /** Failure taxonomy class id (for example 'artifact-loss'); null on success. */
  readonly failureClass: string | null;
  readonly cost: {
    /** Integer micro-USD, null when unknown. */
    readonly modelCostMicroUsd: number | null;
    /** Integer micro-USD, null when unknown. */
    readonly computeCostMicroUsd: number | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
  } | null;
}

/**
 * The terminal of an attempt that holds (or held) its workspace lease. `fence` is the
 * caller's fence on that lease as the caller holds it at the terminal; the outcome is
 * recorded before the lease is released. After a release or a takeover the call fails
 * AssuranceFencedError and the current holder (if any) records the terminal.
 */
export interface LeasedAttemptOutcomeInput extends AttemptOutcomeFields {
  readonly terminal: AttemptTerminal;
  readonly fence: AssuranceFence;
}

/**
 * The terminal of an attempt that never held a workspace lease, recorded with fence null
 * (R28). Obligations, each proved by the conformance kit (RLC-16…RLC-19):
 *  1. the composition registers the attempt before any attempt-bound effect;
 *  2. the write transaction checks the tenant and locks the same attempt row that lease
 *     acquisition locks;
 *  3. fence null is accepted only when durable history shows the attempt never had a
 *     lease, not merely that no lease is ACTIVE now;
 *  4. the terminal is in PRE_LEASE_ATTEMPT_TERMINALS;
 *  5. lease acquisition refuses an attempt that already has a terminal, under that lock;
 *  6. the terminal, its idempotency record and its events commit atomically;
 *  7. an attempt that ever held a lease must present its caller fence (LeasedAttemptOutcomeInput);
 *  8. buildRepairContextPack always requires a fence.
 * A write refused under obligation 3 throws ReviewLoopContractError 'lease-granted', never
 * AssuranceFencedError: a grant that committed late is not a supersession. The workflow then
 * looks the lease up and records the same terminal with that lease's fence, at most two
 * lookups (R29). The single exception to "every terminal is recorded" is a store that cannot
 * be read or written after the retry policy (a failed lookup, or a failed pre-lease terminal
 * write): the task ends FAILED / attempt-state-unknown, its audit entry carries the attempt's
 * idempotency key, and telemetry completeness reports the attempt as a gap with that key
 * (R29, R32).
 */
export interface PreLeaseAttemptOutcomeInput extends AttemptOutcomeFields {
  readonly terminal: PreLeaseAttemptTerminal;
  readonly fence: null;
}

export type AttemptOutcomeInput = LeasedAttemptOutcomeInput | PreLeaseAttemptOutcomeInput;

// --- admission and repair helpers ----------------------------------------------------------

export interface AssuranceCapability {
  readonly reviewerEnabled: boolean;
  /**
   * Reviewer configurations holding a valid gating promotion. Promotion is deferred out of
   * Phase 4: every Phase 4 composition passes [].
   */
  readonly promotedReviewerConfigIds: readonly string[];
}

export interface RepairContextInput {
  readonly slotVersion: ReviewLoopSlotVersion;
  readonly scope: TenantScope;
  /** The repair attempt being prepared. */
  readonly attemptId: AttemptId;
  /** The task's original context-pack/v1 artifact; the pack itself never travels inline. */
  readonly originalContextPackRef: ArtifactRef;
  readonly repairOrderRef: ArtifactRef;
  /**
   * The caller's fence on the repair attempt's workspace lease, acquired on the fresh
   * workspace at repairBaseSha before this call. Always required; never null.
   */
  readonly fence: AssuranceFence;
}

export interface RepairContextOutput {
  /**
   * context-pack/v1 with its hash recomputed, persisted before return. Its generatedAt is
   * the decision time of the persisted REPAIR adjudication, so every execution derives the
   * same bytes.
   */
  readonly contextPackRef: ArtifactRef;
}

// --- the slot ---------------------------------------------------------------------------------

export interface ReviewLoopSlot {
  readonly slotVersion: ReviewLoopSlotVersion;

  /** One full round: plan, packet, checks, reviewers, adjudication. May be wrapped as one activity. */
  runAssuranceRound(input: AssuranceSlotInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome>;

  /** The same round as individual idempotent steps, for activity-granular composition. */
  planAssurance(input: AssuranceSlotInput): AssurancePlan;
  buildReviewPacket(input: BuildReviewPacketInput, ctx: AssuranceStepContext): Promise<BuildReviewPacketOutput>;
  runDeterministicChecks(input: DeterministicCheckInput, ctx: AssuranceStepContext): Promise<DeterministicCheckOutput>;
  runReviewer(input: RunReviewerInput, ctx: AssuranceStepContext): Promise<RunReviewerOutput>;
  adjudicateRound(input: AdjudicateInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome>;

  /**
   * Called at every attempt terminal, verification stops included; every terminal is
   * recorded, with the one exception stated on PreLeaseAttemptOutcomeInput. A leased attempt
   * is recorded with its caller fence before the lease is released; an attempt that never
   * held a lease with fence null (PreLeaseAttemptOutcomeInput). Resolves null. Keyed by
   * attemptId: a redelivery whose input equals the recorded one, fence aside, writes nothing
   * and resolves null; any other input for a recorded attempt throws ReviewLoopContractError
   * 'conflicting-redelivery' and writes nothing. The fence, or for fence null the attempt's
   * never-leased history ('lease-granted' if a lease ever existed), is checked before the
   * comparison.
   */
  recordAttemptOutcome(input: AttemptOutcomeInput, ctx: AssuranceStepContext): Promise<null>;

  /** Admission through the optional `admit` hook on GovernedExecutionInput. Pure. */
  admitWithAssurance(risk: RiskLevel, capability: AssuranceCapability): AdmissionResult;

  /**
   * ContextPack for a repair attempt whose workspace is created at the REPAIR outcome's
   * repairBaseSha, called with that attempt's lease held. Keyed by attemptId: a redelivery
   * whose input equals the recorded one, fence aside, returns the stored output and writes
   * nothing; any other input for that attempt throws ReviewLoopContractError
   * 'conflicting-redelivery' and writes nothing. The fence is checked before the comparison.
   */
  buildRepairContextPack(input: RepairContextInput, ctx: AssuranceStepContext): Promise<RepairContextOutput>;
}

// --- errors -----------------------------------------------------------------------------------
// Any other thrown error is transient and safe to retry with the same input.

export type ReviewLoopContractErrorCode =
  /** A payload is not plain JSON or is larger than the envelope. */
  | 'invalid-payload'
  /** A well-formed payload that breaks a rule of this contract (slot version, round lineage, a disabled helper). */
  | 'invalid-input'
  /** The scope does not own the referenced run, task or attempt; reveals nothing about other tenants. */
  | 'not-in-scope'
  /** A redelivery for a recorded attempt whose input differs from the recorded one. */
  | 'conflicting-redelivery'
  /**
   * A fence-null terminal refused because the attempt's durable history shows a lease: a
   * grant committed late. Not a supersession: the workflow looks the lease up and records the
   * terminal with its fence (R29).
   */
  | 'lease-granted'
  /** An output that violates this contract (a defect of the implementation itself). */
  | 'invalid-output';

/** Non-retryable, whatever the code; the code tells the caller which rule failed. */
export class ReviewLoopContractError extends Error {
  readonly code: ReviewLoopContractErrorCode;
  constructor(code: ReviewLoopContractErrorCode, message: string) {
    super(message);
    this.name = 'ReviewLoopContractError';
    this.code = code;
  }
}

/** The caller's lease is no longer current at the given epoch, or has ended. Non-retryable for this delivery. */
export class AssuranceFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssuranceFencedError';
  }
}

/** ctx.signal was aborted. Retryable by the engine. */
export class AssuranceCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssuranceCancelledError';
  }
}

// --- envelope -------------------------------------------------------------------------------------

/** Money at the seam: null (unknown) or a non-negative safe integer number of micro-USD. */
function isMicroUsd(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/**
 * Where `value` first stops being plain JSON, or null when all of it is. Plain JSON is
 * null, a string, a boolean, a finite number other than -0, an array without holes or
 * extra keys, or an object whose prototype is Object.prototype or null and whose own
 * keys are all enumerable string-keyed data properties; values are plain JSON in turn.
 * A value shared by two keys is allowed; a cycle is not. A value under an object key that
 * ends in MicroUsd must also be null or a non-negative safe integer (file header).
 */
function plainJsonViolation(value: unknown, path: string, ancestors: Set<object>): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return `${path} is -0`;
    return Number.isFinite(value) ? null : `${path} is ${String(value)}`;
  }
  if (typeof value !== 'object') return `${path} is ${typeof value}`;
  if (ancestors.has(value)) return `${path} is circular`;
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return `${path} is not a plain object or array`;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return `${path} has a symbol key`;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => !(isArray && key === 'length'));
  if (isArray && keys.some((key, index) => key !== String(index))) return `${path} has holes or non-index keys`;
  if (isArray && keys.length !== (value as readonly unknown[]).length) return `${path} has holes or non-index keys`;
  ancestors.add(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    const at = isArray ? `${path}[${key}]` : `${path}.${key}`;
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return `${at} is not an enumerable data property`;
    }
    const found = plainJsonViolation(descriptor.value, at, ancestors);
    if (found !== null) return found;
    if (!isArray && key.endsWith('MicroUsd') && !isMicroUsd(descriptor.value)) {
      return `${at} is not integer micro-USD (null or a non-negative safe integer)`;
    }
  }
  ancestors.delete(value);
  return null;
}

/**
 * Serialized size of a slot payload: UTF-8 bytes of JSON.stringify(value), measured only
 * after the whole payload is checked to be plain JSON with integer micro-USD money (file
 * header). A payload that is not, or that cannot be walked at all, throws
 * ReviewLoopContractError 'invalid-payload'. Semantic rules (unions, lineage, allowlists)
 * are checked separately by the implementation.
 */
export function reviewLoopPayloadBytes(value: unknown): number {
  let violation: string | null;
  let json = '';
  try {
    violation = plainJsonViolation(value, '$', new Set());
    if (violation === null) json = JSON.stringify(value);
  } catch {
    violation = '$ cannot be walked (nested too deeply)';
  }
  if (violation !== null) throw new ReviewLoopContractError('invalid-payload', `payload breaks the slot envelope: ${violation}`);
  return new TextEncoder().encode(json).byteLength;
}

/**
 * Throws ReviewLoopContractError 'invalid-payload' when a payload is not plain JSON or is
 * larger than REVIEW_LOOP_MAX_PAYLOAD_BYTES. Implementations call it on every input before
 * any state change and on every output before returning; orchestration adapters may call
 * it before scheduling an activity.
 */
export function assertWithinReviewLoopEnvelope(label: string, value: unknown): void {
  const bytes = reviewLoopPayloadBytes(value);
  if (bytes > REVIEW_LOOP_MAX_PAYLOAD_BYTES) {
    throw new ReviewLoopContractError(
      'invalid-payload',
      `${label} serializes to ${bytes} bytes; the slot envelope allows ${REVIEW_LOOP_MAX_PAYLOAD_BYTES}`,
    );
  }
}
