// Imports of the section below. The locked slot block was written as one
// module; split into its three files, each section imports what it names.
import { isDeepStrictEqual } from 'node:util';
import type { AttemptId, RiskLevel, TenantScope } from '@asep/contracts';
import { admitRisk } from '../risk-admission.js';
import {
  AssuranceCancelledError,
  AssuranceFencedError,
  REVIEW_LOOP_MAX_PAYLOAD_BYTES,
  REVIEW_LOOP_SLOT_VERSION,
  ReviewLoopContractError,
  assertWithinReviewLoopEnvelope,
  reviewLoopPayloadBytes,
  type AdjudicateInput,
  type AssuranceCapability,
  type AssuranceFence,
  type AssuranceOutcome,
  type AssurancePlan,
  type AssuranceSlotInput,
  type AssuranceStepContext,
  type AssuranceWorkspaceResolver,
  type AttemptOutcomeInput,
  type BuildReviewPacketInput,
  type BuildReviewPacketOutput,
  type DeterministicCheckInput,
  type DeterministicCheckOutput,
  type LeasedAttemptOutcomeInput,
  type PreLeaseAttemptOutcomeInput,
  type RepairContextInput,
  type RepairContextOutput,
  type ReviewLoopContractErrorCode,
  type ReviewLoopSlot,
  type ReviewMode,
  type RunReviewerInput,
  type RunReviewerOutput,
} from './slot.js';
import {
  attemptOutcomeViolation, canonicalJson, derivedArtifactRef, refuseInput, roundInputViolation, sha256Hex, withoutFence,
} from './slot-rules.js';

// ===========================================================================
// packages/application/src/review-loop/review-loop-contract.ts     (S0 conformance kit; signatures)
// ===========================================================================

/** A repair attempt prepared in the backing store, for the repair-helper parts of RLC-14, RLC-15 and RLC-17. */
export interface RepairContextFixture {
  /** A valid request for the repair attempt, carrying the fence of that attempt's lease. */
  readonly input: RepairContextInput;
  /** Hands the repair attempt's lease to a new holder in the backing store and returns its fence. */
  readonly rotateFence: () => Promise<AssuranceFence>;
}

/** An attempt registered in the backing store that has never held a workspace lease, for RLC-16, RLC-17 and RLC-18. */
export interface PreLeaseAttemptFixture {
  /** A valid pre-lease terminal of that attempt: fence null, terminal in PRE_LEASE_ATTEMPT_TERMINALS. */
  readonly attemptOutcome: PreLeaseAttemptOutcomeInput;
  /**
   * Acquires the attempt's first workspace lease through the composition's lease
   * acquisition, under the attempt-row lock; resolves the new holder's fence, or null when
   * acquisition is refused because the attempt already has a terminal.
   */
  readonly acquireLease: () => Promise<AssuranceFence | null>;
  /** Releases the lease `acquireLease` acquired. */
  readonly endLease: () => Promise<void>;
}

/** What every conformance fixture provides, stateful or not. */
export interface ConformanceFixtureBase {
  /** A valid round-1 input that the implementation's backing store accepts. */
  readonly input: AssuranceSlotInput;
  /** A valid round-1 input whose change trips the push guard; null when the implementation cannot produce one. */
  readonly pushGuardInput: AssuranceSlotInput | null;
  /** A valid terminal of `input`'s attempt, carrying `input.fence`. */
  readonly attemptOutcome: LeasedAttemptOutcomeInput;
  /**
   * Brings the backing store to a persisted REPAIR adjudication of `input`'s task with the
   * repair attempt's lease held; null when the implementation cannot reach REPAIR (the
   * repair-helper parts of RLC-14 and RLC-15 then report not-applicable in the detail).
   */
  readonly prepareRepair: (() => Promise<RepairContextFixture>) | null;
}

/**
 * The fixture of an implementation that persists anything (rows, artifacts or events).
 * Every hook is required, and no case that needs one may report not-applicable: the
 * atomicity part of RLC-16 included (R32).
 */
export interface StatefulConformanceFixture extends ConformanceFixtureBase {
  readonly stateless: false;
  /** Simulates a lease handoff of `input`'s attempt in the backing store and returns the new holder's fence. */
  readonly rotateFence: () => Promise<AssuranceFence>;
  /** Releases the lease of `input`'s attempt in the backing store. */
  readonly endLease: () => Promise<void>;
  /** Registers a fresh attempt of `input`'s task that has never held a lease. */
  readonly preLeaseAttempt: () => Promise<PreLeaseAttemptFixture>;
  /** Makes the next write transaction of the backing store fail at commit. */
  readonly failNextCommit: () => void;
  /** Canonical bytes of every row and run event the backing store holds for one round key, in a stable order. */
  readonly persistedRoundBytes: (roundKey: string) => Promise<string>;
  /**
   * Canonical bytes of every row, artifact and run event the backing store holds for one
   * attempt id (its attempt outcome, its repair ContextPack), in a stable order.
   */
  readonly persistedAttemptBytes: (attemptId: AttemptId) => Promise<string>;
}

/**
 * The fixture of an implementation that persists nothing: the disabled and scripted slots
 * (R32, R37). A slot that persists anything presents a StatefulConformanceFixture, Lane A's
 * NotConfiguredAssuranceSlot included because it persists outcome events. With this fixture the
 * fencing, pre-lease, atomicity, persistence and "no state change" parts of the cases report
 * not-applicable.
 */
export interface StatelessConformanceFixture extends ConformanceFixtureBase {
  readonly stateless: true;
  readonly rotateFence: null;
  readonly endLease: null;
  readonly preLeaseAttempt: null;
  readonly failNextCommit: null;
  readonly persistedRoundBytes: null;
  readonly persistedAttemptBytes: null;
}

export type ReviewLoopConformanceFixture = StatefulConformanceFixture | StatelessConformanceFixture;

/** The implementation under test over an empty backing store; the kit builds a fresh one per case. */
export type ReviewLoopConformanceSubject = () => Promise<{
  readonly slot: ReviewLoopSlot;
  readonly fixture: ReviewLoopConformanceFixture;
}>;

export interface ReviewLoopConformanceResult {
  readonly caseId: string;
  readonly status: 'passed' | 'failed' | 'not-applicable';
  readonly detail: string;
}

/**
 * Runs cases RLC-01…RLC-18 against any implementation. Framework-free; callers assert on
 * the result. `makeCtx(logicalTime)` returns a live context whose now() is `logicalTime`;
 * the kit reuses one value for every redelivery of one execution.
 */
export function runReviewLoopContract(
  makeSubject: ReviewLoopConformanceSubject,
  makeCtx: (logicalTime: string) => AssuranceStepContext,
): Promise<readonly ReviewLoopConformanceResult[]> {
  return runSlotCases(makeSubject, makeCtx);
}

/** One step of an attempt's life as the composition commits it, for RLC-19. */
export type AttemptLifecycleStep =
  /** The attempt is durably registered and the workflow has read that registration back. */
  | { readonly kind: 'registration-reconciled'; readonly attemptId: AttemptId }
  /** Anything bound to the attempt: lease acquisition, workspace creation, agent start, a slot call, a terminal write. */
  | { readonly kind: 'attempt-bound-effect'; readonly attemptId: AttemptId; readonly effect: string };

export interface RegistrationOrderingScenario {
  readonly name: string;
  /** Drives the composition's workflow through the scenario and returns every step it committed, in commit order. */
  readonly run: () => Promise<readonly AttemptLifecycleStep[]>;
}

/**
 * Runs case RLC-19 (R28 obligation 1, R32) against the orchestration composition: in every
 * scenario, no attempt-bound effect of an attempt precedes that attempt's
 * registration-reconciled step. The kit first runs its own check on a fixed trace whose
 * first step is an effect, and fails the case unless that trace is refused.
 */
export function runRegistrationOrderingContract(
  scenarios: readonly RegistrationOrderingScenario[],
): Promise<readonly ReviewLoopConformanceResult[]> {
  return runOrderingCases(scenarios);
}

export interface WorkspaceResolverConformanceFixture {
  readonly scope: TenantScope;
  /** An attempt whose workspace lease is ACTIVE and held by `fence` in the backing store. */
  readonly attemptId: AttemptId;
  readonly fence: AssuranceFence;
  /** Another tenant's scope that the backing store also holds. */
  readonly foreignScope: TenantScope;
  /** Ends the attempt's lease (expiry or release) in the backing store. */
  readonly endLease: () => Promise<void>;
}

/** Runs cases WRC-01…WRC-05 against any resolver, each on a fresh subject. */
export function runWorkspaceResolverContract(
  makeSubject: () => Promise<{
    readonly resolver: AssuranceWorkspaceResolver;
    readonly fixture: WorkspaceResolverConformanceFixture;
  }>,
): Promise<readonly ReviewLoopConformanceResult[]> {
  return runResolverCases(makeSubject);
}

export interface ScriptedReviewLoopScript {
  readonly mode: ReviewMode;
  /** Outcome kind returned for each round number; validated against this contract like a real implementation. */
  readonly outcomesByRound: Readonly<Record<number, AssuranceOutcome['kind']>>;
}

/** Scripted slot for orchestration tests; enforces every input and output invariant of this contract. */
export function createScriptedReviewLoopSlot(script: ScriptedReviewLoopScript): ReviewLoopSlot {
  return scriptedSlot(script);
}

// === end of the locked slot block text ===

// ---------------------------------------------------------------------------
// The conformance kit.
//
// Every case builds its own fresh subjects. Some cases compare an outcome on one
// subject with the outcome of the same round on another fresh subject, so the
// fixtures of two fresh subjects present the same input apart from the fence. A
// case never throws: an unexpected error fails it, with the error in the detail.
// 'not-applicable' is reported only where the contract allows it: the state,
// fencing, pre-lease and atomicity parts for a StatelessConformanceFixture, and
// the parts that need a hook the fixture may leave null (pushGuardInput,
// prepareRepair).
// ---------------------------------------------------------------------------

/** Logical times the kit runs executions at; a later execution uses the second. */
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T01:00:00.000Z';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ESCALATION_REASONS: readonly string[] = [
  'packet-over-budget', 'egress-stopped', 'independence-unsatisfiable', 'reviewer-unavailable', 'reviewer-escalated',
  'max-repair-rounds', 'budget-exhausted',
];
const BLOCK_REASONS: readonly string[] = ['secret-in-diff', 'forbidden-path', 'unscannable-sensitive-change'];
const OUTCOME_KINDS: readonly string[] = ['PROCEED', 'REPAIR', 'ESCALATE', 'BLOCK'];
const MODES: readonly string[] = ['not-required', 'shadow', 'gating'];
const RISKS: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type Subject = Awaited<ReturnType<ReviewLoopConformanceSubject>>;
type MakeCtx = (logicalTime: string) => AssuranceStepContext;

class CaseLog {
  readonly failures: string[] = [];
  readonly notes: string[] = [];

  fail(message: string | null): void {
    if (message !== null) this.failures.push(message);
  }

  check(condition: boolean, message: string): void {
    if (!condition) this.failures.push(message);
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isContractError(err: unknown, code: ReviewLoopContractErrorCode): boolean {
  const named = err instanceof ReviewLoopContractError || (err instanceof Error && err.name === 'ReviewLoopContractError');
  return named && (err as { readonly code?: unknown }).code === code;
}

const contractError = (code: ReviewLoopContractErrorCode) => (err: unknown): boolean => isContractError(err, code);
const fencedError = (err: unknown): boolean =>
  err instanceof AssuranceFencedError || (err instanceof Error && err.name === 'AssuranceFencedError');
const cancelledError = (err: unknown): boolean =>
  err instanceof AssuranceCancelledError || (err instanceof Error && err.name === 'AssuranceCancelledError');

/** Runs `call` expecting a throw that `expected` accepts; returns the failure, or null. */
async function expectThrow(
  label: string,
  call: () => unknown,
  expected: (err: unknown) => boolean,
  what: string,
): Promise<string | null> {
  try {
    await call();
    return `${label}: expected ${what}, the call succeeded`;
  } catch (err) {
    return expected(err) ? null : `${label}: expected ${what}, got ${describe(err)}`;
  }
}

/** The subject's persisted bytes for the round and attempt of `input`; null for a stateless fixture. */
async function stateBytes(subject: Subject, input: AssuranceSlotInput): Promise<string | null> {
  const f = subject.fixture;
  if (f.stateless) return null;
  return canonicalJson([await f.persistedRoundBytes(input.idempotencyKey), await f.persistedAttemptBytes(input.attemptId)]);
}

async function attemptBytes(subject: Subject, attemptId: AttemptId): Promise<string | null> {
  const f = subject.fixture;
  return f.stateless ? null : f.persistedAttemptBytes(attemptId);
}

async function expectUnchanged(log: CaseLog, label: string, before: string | null, now: () => Promise<string | null>): Promise<void> {
  if (before === null) return;
  log.check((await now()) === before, `${label}: the persisted bytes changed`);
}

async function expectChanged(log: CaseLog, label: string, before: string | null, now: () => Promise<string | null>): Promise<void> {
  if (before === null) return;
  log.check((await now()) !== before, `${label}: the persisted bytes did not change`);
}

/** Another id of the same shape: the last character moved one step in the Crockford alphabet. */
function otherId(id: string): string {
  const last = id.slice(-1).toUpperCase();
  const i = CROCKFORD_ALPHABET.indexOf(last);
  const next = i < 0 ? (last === '0' ? '1' : '0') : CROCKFORD_ALPHABET[(i + 1) % CROCKFORD_ALPHABET.length]!;
  return `${id.slice(0, -1)}${next}`;
}

function foreignScope(scope: TenantScope): TenantScope {
  return {
    organizationId: otherId(scope.organizationId) as TenantScope['organizationId'],
    projectId: otherId(scope.projectId) as TenantScope['projectId'],
  };
}

function abortedCtx(live: AssuranceStepContext): AssuranceStepContext {
  return { signal: AbortSignal.abort(), now: () => live.now(), heartbeat: (details) => live.heartbeat(details) };
}

/** Within the envelope and JSON-round-trip deep-equal; the failure, or null. */
function payloadViolation(label: string, value: unknown): string | null {
  try {
    assertWithinReviewLoopEnvelope(label, value);
  } catch (err) {
    return `${label}: ${describe(err)}`;
  }
  return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value) ? null : `${label}: does not JSON-round-trip deep-equal`;
}

function isArtifactRef(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r['artifactId'] === 'string' && r['artifactId'] !== '' && typeof r['sha256'] === 'string'
    && SHA256_HEX.test(r['sha256']) && typeof r['kind'] === 'string' && r['kind'] !== '';
}

const isCount = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Every RLC-06 invariant a round outcome breaks, against the input it answers. */
function outcomeInvariantViolations(input: AssuranceSlotInput, outcome: AssuranceOutcome): string[] {
  const v: string[] = [];
  const o = outcome as unknown as Record<string, unknown>;
  if (o['slotVersion'] !== REVIEW_LOOP_SLOT_VERSION) v.push(`slotVersion ${String(o['slotVersion'])}`);
  if (o['roundKey'] !== input.idempotencyKey) v.push('roundKey is not the input idempotencyKey');
  if (typeof o['adjudicationId'] !== 'string' || !SHA256_HEX.test(o['adjudicationId'])) v.push('adjudicationId is not 64 lowercase hex');
  const usage = o['usage'] as Record<string, unknown> | null | undefined;
  if (usage === null || typeof usage !== 'object') v.push('usage is missing');
  else {
    for (const k of ['providerCalls', 'inputTokens', 'outputTokens'] as const) if (!isCount(usage[k])) v.push(`usage.${k} is not a count`);
    if (usage['reviewCostMicroUsd'] !== null && !isCount(usage['reviewCostMicroUsd'])) v.push('usage.reviewCostMicroUsd is not integer micro-USD');
  }
  const kind = o['kind'];
  const mode = o['mode'];
  if (typeof kind !== 'string' || !OUTCOME_KINDS.includes(kind)) {
    v.push(`kind ${String(kind)}`);
    return v;
  }
  if (typeof mode !== 'string' || !MODES.includes(mode)) v.push(`mode ${String(mode)}`);
  if ((mode === 'shadow' || mode === 'not-required') && kind !== 'PROCEED' && kind !== 'BLOCK') v.push(`${kind} in mode ${String(mode)}`);
  const hasShadow = Object.prototype.hasOwnProperty.call(o, 'shadow');
  if (kind === 'PROCEED') {
    if (!hasShadow) v.push('PROCEED has no shadow key');
    else if ((o['shadow'] !== null) !== (mode === 'shadow')) v.push('PROCEED shadow is not non-null exactly in shadow mode');
    else if (o['shadow'] !== null) {
      const s = o['shadow'] as Record<string, unknown>;
      if (!['PROCEED', 'REPAIR', 'ESCALATE'].includes(String(s['wouldBe']))) v.push(`shadow.wouldBe ${String(s['wouldBe'])}`);
      if (!isCount(s['blockingFindings'])) v.push('shadow.blockingFindings is not a count');
      if (s['reason'] !== null && s['reason'] !== 'blocking-findings' && !ESCALATION_REASONS.includes(String(s['reason']))) v.push(`shadow.reason ${String(s['reason'])}`);
    }
    if (o['prBodySectionRef'] !== null && !isArtifactRef(o['prBodySectionRef'])) v.push('PROCEED prBodySectionRef is neither null nor an artifact reference');
  } else if (hasShadow) {
    v.push(`${kind} carries a shadow key`);
  }
  if ((kind === 'REPAIR' || kind === 'ESCALATE') && mode !== 'gating') v.push(`${kind} outside gating mode`);
  if (kind === 'REPAIR') {
    if (o['nextRound'] !== input.round + 1) v.push(`REPAIR nextRound ${String(o['nextRound'])} is not round + 1`);
    if (o['repairBaseSha'] !== input.resultSha) v.push('REPAIR repairBaseSha is not the input resultSha');
    if (!isArtifactRef(o['repairOrderRef'])) v.push('REPAIR repairOrderRef is not an artifact reference');
  }
  if (kind === 'ESCALATE') {
    if (!ESCALATION_REASONS.includes(String(o['reason']))) v.push(`ESCALATE reason ${String(o['reason'])}`);
    if (!isArtifactRef(o['prBodySectionRef'])) v.push('ESCALATE prBodySectionRef is not an artifact reference');
  }
  if (kind === 'BLOCK') {
    if (!BLOCK_REASONS.includes(String(o['reason']))) v.push(`BLOCK reason ${String(o['reason'])}`);
    if (o['prBodySectionRef'] !== null && !isArtifactRef(o['prBodySectionRef'])) v.push('BLOCK prBodySectionRef is neither null nor an artifact reference');
  }
  return v;
}

function planViolations(input: AssuranceSlotInput, plan: AssurancePlan): string[] {
  const v: string[] = [];
  if (plan.slotVersion !== REVIEW_LOOP_SLOT_VERSION) v.push('plan slotVersion');
  if (plan.roundKey !== input.idempotencyKey) v.push('plan roundKey is not the input idempotencyKey');
  if (!MODES.includes(plan.mode)) v.push(`plan mode ${String(plan.mode)}`);
  if (plan.mode === 'not-required' && plan.reviewers.length > 0) v.push('a not-required plan names reviewers');
  return v;
}

function reviewerViolations(out: RunReviewerOutput): string[] {
  // Read loosely: the checks are on what the implementation returned, not on what its type promises.
  const o = out as unknown as Record<string, unknown>;
  const status = String(o['status']);
  const v: string[] = [];
  if (typeof o['reviewId'] !== 'string' || !SHA256_HEX.test(o['reviewId'])) v.push('reviewId is not 64 lowercase hex');
  if (status === 'COMPLETED_VALID' || status === 'COMPLETED_INVALID') {
    if (!isArtifactRef(o['reviewRecordRef'])) v.push(`${status} without a review record`);
    if (!(isCount(o['providerCalls']) && (o['providerCalls'] as number) >= 1)) v.push(`${status} with providerCalls ${String(o['providerCalls'])}`);
  } else if (status === 'FAILED') {
    if (o['reviewRecordRef'] !== null) v.push('FAILED with a review record');
    if (!isCount(o['providerCalls'])) v.push('FAILED providerCalls is not a count');
  } else if (status === 'EGRESS_STOPPED' || status === 'SKIPPED_PUSH_GUARD') {
    if (o['reviewRecordRef'] !== null) v.push(`${status} with a review record`);
    if (o['providerCalls'] !== 0) v.push(`${status} with provider calls`);
  } else {
    v.push(`reviewer status ${status}`);
  }
  return v;
}

function packetViolations(plan: AssurancePlan, packet: BuildReviewPacketOutput): string[] {
  const v: string[] = [];
  if (!isArtifactRef(packet.packetRef)) v.push('packetRef is not an artifact reference');
  if (!SHA256_HEX.test(packet.packetSha256)) v.push('packetSha256 is not 64 lowercase hex');
  if (!packet.overBudget && packet.includedBytes > plan.packetBudgetBytes) v.push('a packet within budget is larger than packetBudgetBytes');
  return v;
}

interface StepTrace {
  /** Null when the run stopped at a boundary or the plan ended the round. */
  readonly outcome: AssuranceOutcome | null;
  /** The plan required nothing and the next step refused as a disabled helper: the round ends at its plan. */
  readonly endedAtPlan: boolean;
  /** The step boundaries of the full round: 'plan', then 'packet', 'checks', each reviewer and 'adjudicate'. */
  readonly boundaries: readonly string[];
  readonly violations: readonly string[];
}

/**
 * The round as its individual steps, in order, up to and including boundary `stopAfter` (all of them when null).
 * A plan with mode 'not-required' and no reviewers may end the round: its next step refusing with
 * ReviewLoopContractError 'invalid-input' (a disabled helper) ends the run at the plan.
 */
async function runSteps(
  slot: ReviewLoopSlot,
  input: AssuranceSlotInput,
  ctx: AssuranceStepContext,
  stopAfter: number | null,
): Promise<StepTrace> {
  const violations: string[] = [];
  const plan = slot.planAssurance(input);
  violations.push(...planViolations(input, plan), ...nonNull(payloadViolation('planAssurance output', plan)));
  const boundaries = ['plan', 'packet', 'checks', ...plan.reviewers.map((r) => `reviewer ${r.reviewerConfigId}`), 'adjudicate'];
  const stop = (index: number): boolean => stopAfter !== null && stopAfter <= index;
  if (stop(0)) return { outcome: null, endedAtPlan: false, boundaries, violations };
  let packet: BuildReviewPacketOutput;
  try {
    packet = await slot.buildReviewPacket({ slot: input, plan }, ctx);
  } catch (err) {
    if (plan.mode === 'not-required' && plan.reviewers.length === 0 && isContractError(err, 'invalid-input')) {
      return { outcome: null, endedAtPlan: true, boundaries: ['plan'], violations };
    }
    throw err;
  }
  violations.push(...packetViolations(plan, packet), ...nonNull(payloadViolation('buildReviewPacket output', packet)));
  if (stop(1)) return { outcome: null, endedAtPlan: false, boundaries, violations };
  const checks = await slot.runDeterministicChecks({ slot: input, plan, packetRef: packet.packetRef }, ctx);
  violations.push(...nonNull(payloadViolation('runDeterministicChecks output', checks)));
  if (stop(2)) return { outcome: null, endedAtPlan: false, boundaries, violations };
  const reviewIds: string[] = [];
  for (const [i, reviewer] of plan.reviewers.entries()) {
    const out = await slot.runReviewer({
      slot: input, plan, packetRef: packet.packetRef, checkReportRef: checks.checkReportRef, reviewerConfigId: reviewer.reviewerConfigId,
    }, ctx);
    violations.push(...reviewerViolations(out), ...nonNull(payloadViolation('runReviewer output', out)));
    reviewIds.push(out.reviewId);
    if (stop(3 + i)) return { outcome: null, endedAtPlan: false, boundaries, violations };
  }
  const outcome = await slot.adjudicateRound({
    slot: input, plan, packetRef: packet.packetRef, checkReportRef: checks.checkReportRef, reviewIds,
  }, ctx);
  violations.push(...outcomeInvariantViolations(input, outcome), ...nonNull(payloadViolation('adjudicateRound output', outcome)));
  return { outcome, endedAtPlan: false, boundaries, violations };
}

function nonNull(message: string | null): string[] {
  return message === null ? [] : [message];
}

/** A terminal of `outcome`'s attempt other than its own, valid with the rest of the input unchanged. */
function otherTerminal(outcome: AttemptOutcomeInput): AttemptOutcomeInput['terminal'] {
  if (outcome.terminal === 'proceeded') return 'escalated';
  if (outcome.terminal === 'escalated') return 'proceeded';
  return outcome.terminal === 'cancelled' ? 'infrastructure-failed' : 'cancelled';
}

function otherFailureClass(failureClass: string | null): string {
  return failureClass === 'artifact-loss' ? 'workflow-recovery-failure' : 'artifact-loss';
}

/** The same attempt's terminal written without a fence: a pre-lease terminal by its shape. */
function fenceNullVariant(outcome: AttemptOutcomeInput): PreLeaseAttemptOutcomeInput {
  return { ...outcome, fence: null, terminal: 'cancelled', assuranceUnavailable: false, adjudicationId: null };
}

interface CaseSpec {
  readonly id: string;
  readonly run: (makeSubject: ReviewLoopConformanceSubject, makeCtx: MakeCtx, log: CaseLog) => Promise<string | void>;
}

async function runCase(spec: CaseSpec, makeSubject: ReviewLoopConformanceSubject, makeCtx: MakeCtx): Promise<ReviewLoopConformanceResult> {
  const log = new CaseLog();
  let notApplicable: string | void = undefined;
  try {
    notApplicable = await spec.run(makeSubject, makeCtx, log);
  } catch (err) {
    log.fail(`unexpected error: ${describe(err)}`);
  }
  if (log.failures.length > 0) return { caseId: spec.id, status: 'failed', detail: log.failures.join('; ') };
  if (typeof notApplicable === 'string') return { caseId: spec.id, status: 'not-applicable', detail: notApplicable };
  return { caseId: spec.id, status: 'passed', detail: log.notes.length > 0 ? log.notes.join('; ') : 'all assertions held' };
}

const STATELESS = 'the fixture is stateless: this case is about persisted state';

async function referenceOutcome(makeSubject: ReviewLoopConformanceSubject, makeCtx: MakeCtx): Promise<AssuranceOutcome> {
  const s = await makeSubject();
  return s.slot.runAssuranceRound(s.fixture.input, makeCtx(T0));
}

const HOSTILE_PAYLOADS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['an undefined value', () => ({ x: undefined })],
  ['Infinity', () => ({ x: Infinity })],
  ['-Infinity', () => ({ x: -Infinity })],
  ['NaN', () => ({ x: NaN })],
  ['-0', () => ({ x: -0 })],
  ['a Date', () => ({ x: new Date(0) })],
  ['a Map', () => ({ x: new Map() })],
  ['a Set', () => ({ x: new Set() })],
  ['a class instance', () => ({ x: new (class Point {})() })],
  ['a sparse array', () => [1, , 3]],
  ['a cycle', () => {
    const o: Record<string, unknown> = {};
    o['self'] = o;
    return o;
  }],
  ['a bigint', () => ({ x: 10n })],
  ['a function', () => ({ x: () => 1 })],
  ['an undefined root', () => undefined],
  ['fractional micro-USD (the 5.0000004 USD boundary)', () => ({ costMicroUsd: 5000000.4 })],
  ['negative micro-USD', () => ({ costMicroUsd: -1 })],
  ['micro-USD at 2^53', () => ({ costMicroUsd: 2 ** 53 })],
  ['micro-USD as a string', () => ({ costMicroUsd: '5' })],
  ['micro-USD as a boolean', () => ({ costMicroUsd: true })],
  ['micro-USD as an object', () => ({ costMicroUsd: {} })],
  ['micro-USD nested in an array element', () => ({ rounds: [{ usage: { reviewCostMicroUsd: 0.5 } }] })],
];

const PLAIN_PAYLOADS: ReadonlyArray<readonly [string, () => unknown]> = [
  ['null', () => null],
  ['an empty object', () => ({})],
  ['an empty array', () => []],
  ['a null-prototype object', () => Object.create(null) as unknown],
  ['a shared reference', () => {
    const shared = { v: 1 };
    return { a: shared, b: shared };
  }],
  ['micro-USD null', () => ({ costMicroUsd: null })],
  ['micro-USD 0', () => ({ costMicroUsd: 0 })],
  ['micro-USD at MAX_SAFE_INTEGER', () => ({ costMicroUsd: Number.MAX_SAFE_INTEGER })],
];

const SLOT_CASES: readonly CaseSpec[] = [
  {
    id: 'RLC-01',
    async run(makeSubject, makeCtx, log) {
      const exact = { pad: 'x'.repeat(REVIEW_LOOP_MAX_PAYLOAD_BYTES - '{"pad":""}'.length) };
      log.check(reviewLoopPayloadBytes(exact) === REVIEW_LOOP_MAX_PAYLOAD_BYTES, 'the boundary payload is not exactly the envelope');
      log.fail(payloadViolation('a payload of exactly the envelope', exact));
      log.fail(await expectThrow('a payload one byte over the envelope',
        () => assertWithinReviewLoopEnvelope('over', { pad: `${exact.pad}x` }), contractError('invalid-payload'), 'invalid-payload'));
      for (const [label, make] of HOSTILE_PAYLOADS) {
        log.fail(await expectThrow(`reviewLoopPayloadBytes(${label})`, () => reviewLoopPayloadBytes(make()), contractError('invalid-payload'), 'invalid-payload'));
      }
      for (const [label, make] of PLAIN_PAYLOADS) {
        try {
          reviewLoopPayloadBytes(make());
        } catch (err) {
          log.fail(`reviewLoopPayloadBytes(${label}) refused a plain payload: ${describe(err)}`);
        }
      }

      const s = await makeSubject();
      const { input, attemptOutcome } = s.fixture;
      const ctx = makeCtx(T0);
      log.fail(payloadViolation('fixture.input', input));
      log.fail(payloadViolation('fixture.attemptOutcome', attemptOutcome));
      const refusedInputs: Array<readonly [string, unknown]> = [
        ['an input padded past the envelope', { ...input, implementer: { ...input.implementer, providerId: 'p'.repeat(REVIEW_LOOP_MAX_PAYLOAD_BYTES) } }],
        ['budgetRemaining.costMicroUsd undefined', { ...input, budgetRemaining: { ...input.budgetRemaining, costMicroUsd: undefined } }],
        ['budgetRemaining.costMicroUsd 1.5', { ...input, budgetRemaining: { ...input.budgetRemaining, costMicroUsd: 1.5 } }],
        ['budgetRemaining.costMicroUsd -1', { ...input, budgetRemaining: { ...input.budgetRemaining, costMicroUsd: -1 } }],
        ['budgetRemaining.wallClockMs NaN', { ...input, budgetRemaining: { ...input.budgetRemaining, wallClockMs: NaN } }],
      ];
      for (const [label, bad] of refusedInputs) {
        const before = await stateBytes(s, input);
        log.fail(await expectThrow(`runAssuranceRound(${label})`, () => s.slot.runAssuranceRound(bad as AssuranceSlotInput, ctx), contractError('invalid-payload'), 'invalid-payload'));
        await expectUnchanged(log, `runAssuranceRound(${label})`, before, () => stateBytes(s, input));
      }
      const cost = attemptOutcome.cost ?? { modelCostMicroUsd: null, computeCostMicroUsd: null, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
      const fractional = { ...attemptOutcome, cost: { ...cost, modelCostMicroUsd: 0.5 } };
      const before = await attemptBytes(s, attemptOutcome.attemptId);
      log.fail(await expectThrow('recordAttemptOutcome(cost.modelCostMicroUsd 0.5)', () => s.slot.recordAttemptOutcome(fractional, ctx), contractError('invalid-payload'), 'invalid-payload'));
      await expectUnchanged(log, 'recordAttemptOutcome(cost.modelCostMicroUsd 0.5)', before, () => attemptBytes(s, attemptOutcome.attemptId));

      log.fail(payloadViolation('runAssuranceRound output', await s.slot.runAssuranceRound(input, ctx)));
      const steps = await runSteps(s.slot, input, ctx, null);
      log.failures.push(...steps.violations);
      for (const risk of RISKS) {
        log.fail(payloadViolation(`admitWithAssurance(${risk}) output`, s.slot.admitWithAssurance(risk, { reviewerEnabled: true, promotedReviewerConfigIds: [] })));
      }
      const recorded = await s.slot.recordAttemptOutcome(attemptOutcome, ctx);
      log.fail(payloadViolation('recordAttemptOutcome output', recorded));
      if (s.fixture.prepareRepair !== null) {
        const repair = await s.fixture.prepareRepair();
        log.fail(payloadViolation('prepareRepair input', repair.input));
        log.fail(payloadViolation('buildRepairContextPack output', await s.slot.buildRepairContextPack(repair.input, ctx)));
      } else {
        log.note('buildRepairContextPack: prepareRepair is null (not-applicable)');
      }
    },
  },
  {
    id: 'RLC-02',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const first = await s.slot.runAssuranceRound(s.fixture.input, makeCtx(T0));
      const bytes = await stateBytes(s, s.fixture.input);
      const second = await s.slot.runAssuranceRound(s.fixture.input, makeCtx(T0));
      log.check(isDeepStrictEqual(first, second), 'two runs of the same input differ');
      log.check(first.usage.providerCalls === second.usage.providerCalls, 'the second run reports other provider calls');
      await expectUnchanged(log, 'the second run (no provider request, no new record)', bytes, () => stateBytes(s, s.fixture.input));
      if (bytes === null) log.note(STATELESS);
    },
  },
  {
    id: 'RLC-03',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const ctx = makeCtx(T0);
      const wrong = 'review-loop/v2' as unknown as typeof REVIEW_LOOP_SLOT_VERSION;
      const before = await stateBytes(s, s.fixture.input);
      log.fail(await expectThrow('runAssuranceRound(slotVersion v2)', () => s.slot.runAssuranceRound({ ...s.fixture.input, slotVersion: wrong }, ctx), contractError('invalid-input'), 'invalid-input'));
      log.fail(await expectThrow('planAssurance(slotVersion v2)', () => s.slot.planAssurance({ ...s.fixture.input, slotVersion: wrong }), contractError('invalid-input'), 'invalid-input'));
      log.fail(await expectThrow('recordAttemptOutcome(slotVersion v2)', () => s.slot.recordAttemptOutcome({ ...s.fixture.attemptOutcome, slotVersion: wrong }, ctx), contractError('invalid-input'), 'invalid-input'));
      await expectUnchanged(log, 'slotVersion v2', before, () => stateBytes(s, s.fixture.input));
    },
  },
  {
    id: 'RLC-04',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const ctx = makeCtx(T0);
      const input = s.fixture.input;
      const roundOneWithPrior = { ...input, round: 1, idempotencyKey: `${input.attemptId}:assurance:1`, priorAdjudicationId: 'a'.repeat(64) };
      const roundTwoWithout = { ...input, round: 2, idempotencyKey: `${input.attemptId}:assurance:2`, priorAdjudicationId: null };
      const before = await stateBytes(s, input);
      log.fail(await expectThrow('round 1 with a priorAdjudicationId', () => s.slot.runAssuranceRound(roundOneWithPrior, ctx), contractError('invalid-input'), 'invalid-input'));
      log.fail(await expectThrow('round 2 without a priorAdjudicationId', () => s.slot.runAssuranceRound(roundTwoWithout, ctx), contractError('invalid-input'), 'invalid-input'));
      await expectUnchanged(log, 'lineage refusals', before, () => stateBytes(s, input));
    },
  },
  {
    id: 'RLC-05',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const f = s.fixture;
      if (f.stateless) return STATELESS;
      const reference = await referenceOutcome(makeSubject, makeCtx);
      const oldFence = f.input.fence;
      const newFence = await f.rotateFence();
      const before = await stateBytes(s, f.input);
      log.fail(await expectThrow('the round under the old fence', () => s.slot.runAssuranceRound({ ...f.input, fence: oldFence }, makeCtx(T0)), fencedError, 'AssuranceFencedError'));
      await expectUnchanged(log, 'the round under the old fence', before, () => stateBytes(s, f.input));
      const converged = await s.slot.runAssuranceRound({ ...f.input, fence: newFence }, makeCtx(T0));
      log.check(isDeepStrictEqual(converged, reference), 'the round under the new fence does not converge to the uninterrupted outcome');
    },
  },
  {
    id: 'RLC-06',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const ctx = makeCtx(T0);
      const outcome = await s.slot.runAssuranceRound(s.fixture.input, ctx);
      log.failures.push(...outcomeInvariantViolations(s.fixture.input, outcome).map((m) => `runAssuranceRound: ${m}`));
      const steps = await runSteps(s.slot, s.fixture.input, ctx, null);
      log.failures.push(...steps.violations.map((m) => `steps: ${m}`));
      if (s.fixture.pushGuardInput !== null) {
        const blocked = await s.slot.runAssuranceRound(s.fixture.pushGuardInput, ctx);
        log.failures.push(...outcomeInvariantViolations(s.fixture.pushGuardInput, blocked).map((m) => `pushGuardInput: ${m}`));
      }
    },
  },
  {
    id: 'RLC-07',
    async run(makeSubject, makeCtx, log) {
      const reference = await referenceOutcome(makeSubject, makeCtx);
      const s = await makeSubject();
      log.fail(await expectThrow('a round with an aborted signal', () => s.slot.runAssuranceRound(s.fixture.input, abortedCtx(makeCtx(T0))), cancelledError, 'AssuranceCancelledError'));
      const later = await s.slot.runAssuranceRound(s.fixture.input, makeCtx(T0));
      log.check(isDeepStrictEqual(later, reference), 'the round after a cancelled one does not converge to the uninterrupted outcome');
    },
  },
  {
    id: 'RLC-08',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const before = await attemptBytes(s, s.fixture.attemptOutcome.attemptId);
      const out: unknown = await s.slot.recordAttemptOutcome(s.fixture.attemptOutcome, makeCtx(T0));
      log.check(out === null, `recordAttemptOutcome resolved ${String(out)}, not null`);
      await expectChanged(log, 'recordAttemptOutcome (the terminal is recorded)', before, () => attemptBytes(s, s.fixture.attemptOutcome.attemptId));
      if (before === null) log.note(`persisted bytes: ${STATELESS}`);
    },
  },
  {
    id: 'RLC-09',
    async run(makeSubject, _makeCtx, log) {
      const s = await makeSubject();
      const capabilities: readonly AssuranceCapability[] = [
        { reviewerEnabled: false, promotedReviewerConfigIds: [] },
        { reviewerEnabled: true, promotedReviewerConfigIds: [] },
        { reviewerEnabled: true, promotedReviewerConfigIds: ['promoted-a'] },
        { reviewerEnabled: true, promotedReviewerConfigIds: ['promoted-a', 'promoted-b'] },
      ];
      for (const risk of RISKS) {
        for (const capability of capabilities.slice(0, 2)) {
          log.check(isDeepStrictEqual(s.slot.admitWithAssurance(risk, capability), admitRisk(risk)),
            `admitWithAssurance(${risk}, reviewerEnabled ${String(capability.reviewerEnabled)}, []) differs from admitRisk`);
        }
      }
      for (const risk of ['R3', 'R4'] as const) {
        for (const capability of capabilities) {
          log.check(s.slot.admitWithAssurance(risk, capability).decision === 'DEFERRED', `${risk} is not DEFERRED for ${canonicalJson(capability)}`);
        }
      }
    },
  },
  {
    id: 'RLC-10',
    async run(makeSubject, makeCtx, log) {
      const reference = await referenceOutcome(makeSubject, makeCtx);
      const s = await makeSubject();
      const steps = await runSteps(s.slot, s.fixture.input, makeCtx(T0), null);
      log.failures.push(...steps.violations);
      if (steps.endedAtPlan) {
        log.check(reference.kind === 'PROCEED' && reference.mode === 'not-required' && reference.shadow === null && reference.usage.providerCalls === 0,
          'the plan ended the round, but runAssuranceRound did not return PROCEED, not-required, with no provider call');
        log.note('the plan required nothing and the next step refused as a disabled helper: the round ends at its plan');
      } else {
        log.check(isDeepStrictEqual(steps.outcome, reference), 'the steps in order do not yield the outcome of runAssuranceRound');
      }
    },
  },
  {
    id: 'RLC-11',
    async run(makeSubject, makeCtx, log) {
      const probe = await makeSubject();
      const boundaries = (await runSteps(probe.slot, probe.fixture.input, makeCtx(T0), null)).boundaries;
      for (const [index, boundary] of boundaries.entries()) {
        const interrupted = await makeSubject();
        await runSteps(interrupted.slot, interrupted.fixture.input, makeCtx(T0), index);
        const redelivered = await interrupted.slot.runAssuranceRound(interrupted.fixture.input, makeCtx(T0));
        const uninterrupted = await makeSubject();
        const reference = await uninterrupted.slot.runAssuranceRound(uninterrupted.fixture.input, makeCtx(T0));
        log.check(isDeepStrictEqual(redelivered, reference), `after '${boundary}': the redelivery's outcome differs from an uninterrupted run`);
        const roundBytes = async (subject: Subject): Promise<string | null> =>
          subject.fixture.stateless ? null : subject.fixture.persistedRoundBytes(subject.fixture.input.idempotencyKey);
        const bytes = await roundBytes(interrupted);
        if (bytes !== null) log.check(bytes === await roundBytes(uninterrupted), `after '${boundary}': the persisted round bytes differ from an uninterrupted run`);
        const later = await interrupted.slot.runAssuranceRound(interrupted.fixture.input, makeCtx(T1));
        log.check(isDeepStrictEqual(later, reference), `after '${boundary}': a redelivery at a later logical time returns another outcome`);
        if (bytes !== null) log.check(bytes === await roundBytes(interrupted), `after '${boundary}': a redelivery at a later logical time changed persisted bytes`);
      }
      log.note(`boundaries: ${boundaries.join(', ')}${probe.fixture.stateless ? `; persisted bytes: ${STATELESS}` : ''}`);
    },
  },
  {
    id: 'RLC-12',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const guarded = s.fixture.pushGuardInput;
      if (guarded === null) return 'pushGuardInput is null: the implementation cannot produce a change that trips the push guard';
      const outcome = await s.slot.runAssuranceRound(guarded, makeCtx(T0));
      log.check(outcome.kind === 'BLOCK', `the push guard input returned ${outcome.kind}, not BLOCK`);
      if (outcome.kind === 'BLOCK') log.check(BLOCK_REASONS.includes(outcome.reason), `BLOCK reason ${outcome.reason}`);
      log.check(!Object.prototype.hasOwnProperty.call(outcome, 'shadow'), 'BLOCK carries a shadow key');
      log.check(outcome.usage.providerCalls === 0, 'a blocked round sent provider requests');
    },
  },
  {
    id: 'RLC-13',
    async run(makeSubject, makeCtx, log) {
      const s = await makeSubject();
      const f = s.fixture;
      if (f.stateless) return STATELESS;
      const foreign = foreignScope(f.input.scope);
      const ctx = makeCtx(T0);
      const before = await stateBytes(s, f.input);
      log.fail(await expectThrow('runAssuranceRound under another tenant', () => s.slot.runAssuranceRound({ ...f.input, scope: foreign }, ctx), contractError('not-in-scope'), 'not-in-scope'));
      log.fail(await expectThrow('recordAttemptOutcome under another tenant', () => s.slot.recordAttemptOutcome({ ...f.attemptOutcome, scope: foreign }, ctx), contractError('not-in-scope'), 'not-in-scope'));
      await expectUnchanged(log, 'another tenant', before, () => stateBytes(s, f.input));
    },
  },
  {
    id: 'RLC-14',
    async run(makeSubject, makeCtx, log) {
      const probe = await makeSubject();
      if (probe.fixture.stateless) return STATELESS;
      const ctx = makeCtx(T0);
      const outcomeId = probe.fixture.attemptOutcome.attemptId;
      const variants = (fence: AssuranceFence): Array<readonly [string, AssuranceFence]> => [
        ['an epoch one below', { ...fence, fencingEpoch: fence.fencingEpoch - 1 }],
        ['an epoch one above', { ...fence, fencingEpoch: fence.fencingEpoch + 1 }],
        ['another lease id', { ...fence, leaseId: otherId(fence.leaseId) }],
      ];
      for (const index of variants(probe.fixture.attemptOutcome.fence).keys()) {
        const s = await makeSubject();
        const [label, fence] = variants(s.fixture.attemptOutcome.fence)[index]!;
        const before = await attemptBytes(s, outcomeId);
        log.fail(await expectThrow(`recordAttemptOutcome with ${label}`, () => s.slot.recordAttemptOutcome({ ...s.fixture.attemptOutcome, fence }, ctx), fencedError, 'AssuranceFencedError'));
        await expectUnchanged(log, `recordAttemptOutcome with ${label}`, before, () => attemptBytes(s, outcomeId));
      }
      {
        const s = await makeSubject();
        if (!s.fixture.stateless) {
          const oldFence = s.fixture.attemptOutcome.fence;
          const newFence = await s.fixture.rotateFence();
          const before = await attemptBytes(s, outcomeId);
          log.fail(await expectThrow('recordAttemptOutcome with the old fence after rotation', () => s.slot.recordAttemptOutcome({ ...s.fixture.attemptOutcome, fence: oldFence }, ctx), fencedError, 'AssuranceFencedError'));
          await expectUnchanged(log, 'the old fence after rotation', before, () => attemptBytes(s, outcomeId));
          const out: unknown = await s.slot.recordAttemptOutcome({ ...s.fixture.attemptOutcome, fence: newFence }, ctx);
          log.check(out === null, 'the new holder could not record the terminal');
        }
      }
      {
        const s = await makeSubject();
        if (!s.fixture.stateless) {
          await s.fixture.endLease();
          const before = await attemptBytes(s, outcomeId);
          log.fail(await expectThrow('recordAttemptOutcome after the lease ended', () => s.slot.recordAttemptOutcome(s.fixture.attemptOutcome, ctx), fencedError, 'AssuranceFencedError'));
          await expectUnchanged(log, 'after the lease ended', before, () => attemptBytes(s, outcomeId));
        }
      }
      if (probe.fixture.prepareRepair === null) {
        log.note('buildRepairContextPack: prepareRepair is null (not-applicable)');
        return;
      }
      const repairVariants = async (s: Subject): Promise<RepairContextFixture> => {
        if (s.fixture.prepareRepair === null) throw new Error('prepareRepair became null');
        return s.fixture.prepareRepair();
      };
      const repairProbe = await repairVariants(await makeSubject());
      for (const index of variants(repairProbe.input.fence).keys()) {
        const s = await makeSubject();
        const repair = await repairVariants(s);
        const [label, fence] = variants(repair.input.fence)[index]!;
        const before = await attemptBytes(s, repair.input.attemptId);
        log.fail(await expectThrow(`buildRepairContextPack with ${label}`, () => s.slot.buildRepairContextPack({ ...repair.input, fence }, ctx), fencedError, 'AssuranceFencedError'));
        await expectUnchanged(log, `buildRepairContextPack with ${label}`, before, () => attemptBytes(s, repair.input.attemptId));
      }
      const s = await makeSubject();
      const repair = await repairVariants(s);
      const newFence = await repair.rotateFence();
      const before = await attemptBytes(s, repair.input.attemptId);
      log.fail(await expectThrow('buildRepairContextPack with the old fence after rotation', () => s.slot.buildRepairContextPack(repair.input, ctx), fencedError, 'AssuranceFencedError'));
      await expectUnchanged(log, 'buildRepairContextPack with the old fence', before, () => attemptBytes(s, repair.input.attemptId));
      await s.slot.buildRepairContextPack({ ...repair.input, fence: newFence }, ctx);
    },
  },
  {
    id: 'RLC-15',
    async run(makeSubject, makeCtx, log) {
      const ctx = makeCtx(T0);
      const s = await makeSubject();
      const f = s.fixture;
      const id = f.attemptOutcome.attemptId;
      await s.slot.recordAttemptOutcome(f.attemptOutcome, ctx);
      let before = await attemptBytes(s, id);
      const again: unknown = await s.slot.recordAttemptOutcome(f.attemptOutcome, makeCtx(T1));
      log.check(again === null, 'an identical redelivery did not resolve null');
      await expectUnchanged(log, 'an identical redelivery', before, () => attemptBytes(s, id));
      if (f.stateless) {
        log.note(`fence rotation, conflicting redelivery and persisted bytes: ${STATELESS}`);
      } else {
        const oldFence = f.attemptOutcome.fence;
        const newFence = await f.rotateFence();
        before = await attemptBytes(s, id);
        const underNew: unknown = await s.slot.recordAttemptOutcome({ ...f.attemptOutcome, fence: newFence }, ctx);
        log.check(underNew === null, 'the identical input under the new fence did not resolve null');
        await expectUnchanged(log, 'the identical input under the new fence', before, () => attemptBytes(s, id));
        const conflicting: Array<readonly [string, LeasedAttemptOutcomeInput]> = [
          ['another terminal', { ...f.attemptOutcome, fence: newFence, terminal: otherTerminal(f.attemptOutcome) }],
          ['another failureClass', { ...f.attemptOutcome, fence: newFence, failureClass: otherFailureClass(f.attemptOutcome.failureClass) }],
        ];
        for (const [label, input] of conflicting) {
          log.fail(await expectThrow(`a redelivery with ${label}`, () => s.slot.recordAttemptOutcome(input, ctx), contractError('conflicting-redelivery'), 'conflicting-redelivery'));
          await expectUnchanged(log, `a redelivery with ${label}`, before, () => attemptBytes(s, id));
        }
        const stale = { ...conflicting[0]![1], fence: oldFence };
        log.fail(await expectThrow('a conflicting redelivery under a stale fence', () => s.slot.recordAttemptOutcome(stale, ctx), fencedError, 'AssuranceFencedError (the fence is checked first)'));
        await expectUnchanged(log, 'a conflicting redelivery under a stale fence', before, () => attemptBytes(s, id));
      }
      if (f.prepareRepair === null) {
        log.note('buildRepairContextPack: prepareRepair is null (not-applicable)');
        return;
      }
      const r = await makeSubject();
      if (r.fixture.prepareRepair === null) throw new Error('prepareRepair became null');
      const repair = await r.fixture.prepareRepair();
      const first = await r.slot.buildRepairContextPack(repair.input, ctx);
      const repairBefore = await attemptBytes(r, repair.input.attemptId);
      const second = await r.slot.buildRepairContextPack(repair.input, makeCtx(T1));
      log.check(isDeepStrictEqual(first, second), 'an identical repair redelivery returned another context pack');
      await expectUnchanged(log, 'an identical repair redelivery', repairBefore, () => attemptBytes(r, repair.input.attemptId));
      if (r.fixture.stateless) return;
      const newFence = await repair.rotateFence();
      const third = await r.slot.buildRepairContextPack({ ...repair.input, fence: newFence }, ctx);
      log.check(isDeepStrictEqual(first, third), 'the identical repair input under the new fence returned another context pack');
      await expectUnchanged(log, 'the identical repair input under the new fence', repairBefore, () => attemptBytes(r, repair.input.attemptId));
      const changedRef = (ref: RepairContextInput['repairOrderRef']) => ({ ...ref, sha256: sha256Hex(canonicalJson(['other', ref])) });
      for (const [label, input] of [
        ['another repairOrderRef', { ...repair.input, fence: newFence, repairOrderRef: changedRef(repair.input.repairOrderRef) }],
        ['another originalContextPackRef', { ...repair.input, fence: newFence, originalContextPackRef: changedRef(repair.input.originalContextPackRef) }],
      ] as const) {
        log.fail(await expectThrow(`a repair redelivery with ${label}`, () => r.slot.buildRepairContextPack(input, ctx), contractError('conflicting-redelivery'), 'conflicting-redelivery'));
        await expectUnchanged(log, `a repair redelivery with ${label}`, repairBefore, () => attemptBytes(r, repair.input.attemptId));
      }
      log.fail(await expectThrow('a conflicting repair redelivery under a stale fence',
        () => r.slot.buildRepairContextPack({ ...repair.input, repairOrderRef: changedRef(repair.input.repairOrderRef) }, ctx), fencedError, 'AssuranceFencedError (the fence is checked first)'));
    },
  },
  {
    id: 'RLC-16',
    async run(makeSubject, makeCtx, log) {
      const ctx = makeCtx(T0);
      const probe = await makeSubject();
      if (probe.fixture.stateless) return STATELESS;
      const fresh = async (): Promise<{ s: Subject; pre: PreLeaseAttemptFixture; bytes: () => Promise<string | null> }> => {
        const s = await makeSubject();
        if (s.fixture.stateless) throw new Error('a stateful subject became stateless');
        const pre = await s.fixture.preLeaseAttempt();
        return { s, pre, bytes: () => attemptBytes(s, pre.attemptOutcome.attemptId) };
      };
      {
        const { s, pre, bytes } = await fresh();
        const before = await bytes();
        const out: unknown = await s.slot.recordAttemptOutcome(pre.attemptOutcome, ctx);
        log.check(out === null, 'the pre-lease terminal did not resolve null');
        await expectChanged(log, 'the pre-lease terminal (terminal, idempotency record and events)', before, bytes);
        const recorded = await bytes();
        log.check((await pre.acquireLease()) === null, 'a lease was granted after the terminal was recorded');
        await expectUnchanged(log, 'the refused acquisition', recorded, bytes);
        log.check((await s.slot.recordAttemptOutcome(pre.attemptOutcome, makeCtx(T1))) === null, 'an identical pre-lease redelivery did not resolve null');
        await expectUnchanged(log, 'an identical pre-lease redelivery', recorded, bytes);
      }
      {
        const { s, pre, bytes } = await fresh();
        const before = await bytes();
        const proceeded = { ...pre.attemptOutcome, terminal: 'proceeded' } as unknown as AttemptOutcomeInput;
        log.fail(await expectThrow('a pre-lease terminal proceeded', () => s.slot.recordAttemptOutcome(proceeded, ctx), contractError('invalid-input'), 'invalid-input'));
        await expectUnchanged(log, 'a pre-lease terminal proceeded', before, bytes);
        log.fail(await expectThrow('a pre-lease terminal under another tenant',
          () => s.slot.recordAttemptOutcome({ ...pre.attemptOutcome, scope: foreignScope(pre.attemptOutcome.scope) }, ctx), contractError('not-in-scope'), 'not-in-scope'));
        const unknownId = otherId(pre.attemptOutcome.attemptId) as AttemptId;
        const unknownBefore = await attemptBytes(s, unknownId);
        log.fail(await expectThrow('a pre-lease terminal of an attempt the store never registered',
          () => s.slot.recordAttemptOutcome({ ...pre.attemptOutcome, attemptId: unknownId }, ctx), contractError('not-in-scope'), 'not-in-scope'));
        await expectUnchanged(log, 'refused scopes', before, bytes);
        await expectUnchanged(log, 'the unregistered attempt', unknownBefore, () => attemptBytes(s, unknownId));
      }
      {
        const { s, pre, bytes } = await fresh();
        if (s.fixture.stateless) throw new Error('a stateful subject became stateless');
        const before = await bytes();
        s.fixture.failNextCommit();
        log.fail(await expectThrow('the pre-lease terminal at a failed commit', () => s.slot.recordAttemptOutcome(pre.attemptOutcome, ctx), () => true, 'an error'));
        await expectUnchanged(log, 'a failed commit (atomicity)', before, bytes);
        log.check((await s.slot.recordAttemptOutcome(pre.attemptOutcome, ctx)) === null, 'the retry after a failed commit did not resolve null');
        await expectChanged(log, 'the retry after a failed commit', before, bytes);
      }
      const orders = new Set<string>();
      for (let round = 0; round < 20; round++) {
        const { s, pre, bytes } = await fresh();
        const before = await bytes();
        const [written, granted] = await Promise.allSettled([s.slot.recordAttemptOutcome(pre.attemptOutcome, ctx), pre.acquireLease()]);
        if (granted.status === 'rejected') {
          log.fail(`race ${round}: acquireLease failed: ${describe(granted.reason)}`);
          continue;
        }
        if (written.status === 'fulfilled') {
          log.check(written.value === null, `race ${round}: the terminal did not resolve null`);
          log.check(granted.value === null, `race ${round}: both the terminal and the lease won`);
          await expectChanged(log, `race ${round}: the terminal`, before, bytes);
          orders.add('terminal first');
        } else {
          log.check(isContractError(written.reason, 'lease-granted'), `race ${round}: the losing terminal raised ${describe(written.reason)}, not lease-granted`);
          log.check(granted.value !== null, `race ${round}: neither the terminal nor the lease won`);
          await expectUnchanged(log, `race ${round}: the refused terminal`, before, bytes);
          if (granted.value !== null) {
            const recovered: unknown = await s.slot.recordAttemptOutcome({ ...pre.attemptOutcome, fence: granted.value }, ctx);
            log.check(recovered === null, `race ${round}: the terminal under the granted fence did not resolve null`);
            await expectChanged(log, `race ${round}: the terminal under the granted fence`, before, bytes);
          }
          orders.add('lease first');
        }
      }
      log.note(`race orders observed in 20 rounds: ${[...orders].sort().join(', ')}`);
    },
  },
  {
    id: 'RLC-17',
    async run(makeSubject, makeCtx, log) {
      const ctx = makeCtx(T0);
      const s = await makeSubject();
      const f = s.fixture;
      if (f.stateless) return STATELESS;
      const id = f.attemptOutcome.attemptId;
      const fenceNull = fenceNullVariant(f.attemptOutcome);
      const refusedHere = async (label: string): Promise<void> => {
        const before = await attemptBytes(s, id);
        log.fail(await expectThrow(`fence null ${label}`, () => s.slot.recordAttemptOutcome(fenceNull, ctx), contractError('lease-granted'), 'lease-granted'));
        await expectUnchanged(log, `fence null ${label}`, before, () => attemptBytes(s, id));
      };
      await refusedHere('while the lease is held');
      await f.rotateFence();
      await refusedHere('after the lease was rotated');
      await f.endLease();
      await refusedHere('after the lease ended');
      const p = await makeSubject();
      if (p.fixture.stateless) throw new Error('a stateful subject became stateless');
      const pre = await p.fixture.preLeaseAttempt();
      const granted = await pre.acquireLease();
      log.check(granted !== null, 'the pre-lease attempt was not granted its first lease');
      const preBytes = () => attemptBytes(p, pre.attemptOutcome.attemptId);
      let before = await preBytes();
      log.fail(await expectThrow('a pre-lease terminal after its lease was granted', () => p.slot.recordAttemptOutcome(pre.attemptOutcome, ctx), contractError('lease-granted'), 'lease-granted'));
      await expectUnchanged(log, 'a pre-lease terminal after its lease was granted', before, preBytes);
      await pre.endLease();
      before = await preBytes();
      log.fail(await expectThrow('a pre-lease terminal after its lease ended', () => p.slot.recordAttemptOutcome(pre.attemptOutcome, ctx), contractError('lease-granted'), 'lease-granted'));
      await expectUnchanged(log, 'a pre-lease terminal after its lease ended', before, preBytes);
      if (f.prepareRepair === null) {
        log.note('buildRepairContextPack: prepareRepair is null (not-applicable)');
        return;
      }
      const r = await makeSubject();
      if (r.fixture.prepareRepair === null) throw new Error('prepareRepair became null');
      const repair = await r.fixture.prepareRepair();
      const repairBefore = await attemptBytes(r, repair.input.attemptId);
      const noFence = { ...repair.input, fence: null } as unknown as RepairContextInput;
      log.fail(await expectThrow('buildRepairContextPack with fence null', () => r.slot.buildRepairContextPack(noFence, ctx), contractError('invalid-input'), 'invalid-input'));
      await expectUnchanged(log, 'buildRepairContextPack with fence null', repairBefore, () => attemptBytes(r, repair.input.attemptId));
    },
  },
  {
    id: 'RLC-18',
    async run(makeSubject, makeCtx, log) {
      const ctx = makeCtx(T0);
      const s = await makeSubject();
      if (s.fixture.stateless) return STATELESS;
      const pre = await s.fixture.preLeaseAttempt();
      const bytes = () => attemptBytes(s, pre.attemptOutcome.attemptId);
      const granted = await pre.acquireLease();
      if (granted === null) {
        log.fail('the pre-lease attempt was not granted its first lease');
        return;
      }
      let before = await bytes();
      log.fail(await expectThrow('the fence-null terminal after a late grant', () => s.slot.recordAttemptOutcome(pre.attemptOutcome, ctx), contractError('lease-granted'), 'lease-granted (never AssuranceFencedError)'));
      await expectUnchanged(log, 'the fence-null terminal after a late grant', before, bytes);
      const withFence = { ...pre.attemptOutcome, fence: granted };
      log.check((await s.slot.recordAttemptOutcome(withFence, ctx)) === null, 'the terminal under the granted fence did not resolve null');
      await expectChanged(log, 'the terminal under the granted fence', before, bytes);
      before = await bytes();
      log.check((await s.slot.recordAttemptOutcome(withFence, makeCtx(T1))) === null, 'its identical redelivery did not resolve null');
      await expectUnchanged(log, 'its identical redelivery', before, bytes);
      log.fail(await expectThrow('a later fence-null delivery', () => s.slot.recordAttemptOutcome(pre.attemptOutcome, ctx), contractError('lease-granted'), 'lease-granted'));
      await expectUnchanged(log, 'a later fence-null delivery', before, bytes);
    },
  },
];

async function runSlotCases(
  makeSubject: ReviewLoopConformanceSubject,
  makeCtx: (logicalTime: string) => AssuranceStepContext,
): Promise<readonly ReviewLoopConformanceResult[]> {
  const results: ReviewLoopConformanceResult[] = [];
  for (const spec of SLOT_CASES) results.push(await runCase(spec, makeSubject, makeCtx));
  return results;
}

// --- RLC-19: registration before effect -----------------------------------------------

/** The first step of `steps` that binds an attempt before that attempt's registration was reconciled, or null. */
function orderingViolation(steps: readonly AttemptLifecycleStep[]): string | null {
  const registered = new Set<string>();
  for (const [i, step] of steps.entries()) {
    if (step.kind === 'registration-reconciled') registered.add(step.attemptId);
    else if (step.kind === 'attempt-bound-effect') {
      if (!registered.has(step.attemptId)) return `step ${i}: '${step.effect}' of attempt ${step.attemptId} before its registration was reconciled`;
    } else {
      return `step ${i} has kind ${String((step as { kind?: unknown }).kind)}`;
    }
  }
  return null;
}

const EFFECT_BEFORE_REGISTRATION: readonly AttemptLifecycleStep[] = [
  { kind: 'attempt-bound-effect', attemptId: 'attempt-1' as AttemptId, effect: 'lease acquisition' },
  { kind: 'registration-reconciled', attemptId: 'attempt-1' as AttemptId },
];

async function runOrderingCases(scenarios: readonly RegistrationOrderingScenario[]): Promise<readonly ReviewLoopConformanceResult[]> {
  if (orderingViolation(EFFECT_BEFORE_REGISTRATION) === null) {
    return [{ caseId: 'RLC-19', status: 'failed', detail: "the kit's own check accepted a trace whose first step is an effect" }];
  }
  if (scenarios.length === 0) return [{ caseId: 'RLC-19', status: 'failed', detail: 'no scenario was given' }];
  const results: ReviewLoopConformanceResult[] = [];
  for (const scenario of scenarios) {
    try {
      const steps = await scenario.run();
      const violation = steps.length === 0 ? 'the scenario committed no step' : orderingViolation(steps);
      results.push(violation === null
        ? { caseId: 'RLC-19', status: 'passed', detail: `${scenario.name}: ${steps.length} steps, every effect after its attempt's registration` }
        : { caseId: 'RLC-19', status: 'failed', detail: `${scenario.name}: ${violation}` });
    } catch (err) {
      results.push({ caseId: 'RLC-19', status: 'failed', detail: `${scenario.name}: unexpected error: ${describe(err)}` });
    }
  }
  return results;
}

// --- WRC-01…05: the workspace resolver --------------------------------------------------

type ResolverSubject = () => Promise<{ readonly resolver: AssuranceWorkspaceResolver; readonly fixture: WorkspaceResolverConformanceFixture }>;

const RESOLVER_CASES: ReadonlyArray<{
  readonly id: string;
  readonly run: (makeSubject: ResolverSubject) => Promise<string | null>;
}> = [
  {
    id: 'WRC-01',
    async run(makeSubject) {
      const { resolver, fixture } = await makeSubject();
      const r = await resolver.resolve(fixture.scope, { attemptId: fixture.attemptId, ...fixture.fence });
      if (r.kind !== 'resolved') return `the current holder was refused: ${r.reason}`;
      return r.workspace.leaseId === fixture.fence.leaseId ? null : 'the workspace resolved carries another lease id';
    },
  },
  {
    id: 'WRC-02',
    async run(makeSubject) {
      const { resolver, fixture } = await makeSubject();
      const r = await resolver.resolve(fixture.foreignScope, { attemptId: fixture.attemptId, ...fixture.fence });
      return r.kind === 'refused' && r.reason === 'not-in-scope' ? null : `another tenant got ${canonicalJson(r)}`;
    },
  },
  {
    id: 'WRC-03',
    async run(makeSubject) {
      const { resolver, fixture } = await makeSubject();
      const r = await resolver.resolve(fixture.scope, { attemptId: fixture.attemptId, ...fixture.fence, leaseId: otherId(fixture.fence.leaseId) });
      return r.kind === 'refused' && r.reason === 'lease-not-held' ? null : `another lease id got ${canonicalJson(r)}`;
    },
  },
  {
    id: 'WRC-04',
    async run(makeSubject) {
      const failures: string[] = [];
      for (const delta of [-1, 1]) {
        const { resolver, fixture } = await makeSubject();
        const r = await resolver.resolve(fixture.scope, { attemptId: fixture.attemptId, ...fixture.fence, fencingEpoch: fixture.fence.fencingEpoch + delta });
        if (!(r.kind === 'refused' && r.reason === 'stale-epoch')) failures.push(`epoch ${delta > 0 ? 'one above' : 'one below'} got ${canonicalJson(r)}`);
      }
      return failures.length === 0 ? null : failures.join('; ');
    },
  },
  {
    id: 'WRC-05',
    async run(makeSubject) {
      const { resolver, fixture } = await makeSubject();
      await fixture.endLease();
      const r = await resolver.resolve(fixture.scope, { attemptId: fixture.attemptId, ...fixture.fence });
      return r.kind === 'refused' && r.reason === 'lease-not-active' ? null : `an ended lease got ${canonicalJson(r)}`;
    },
  },
];

async function runResolverCases(makeSubject: ResolverSubject): Promise<readonly ReviewLoopConformanceResult[]> {
  const results: ReviewLoopConformanceResult[] = [];
  for (const spec of RESOLVER_CASES) {
    try {
      const failure = await spec.run(makeSubject);
      results.push({ caseId: spec.id, status: failure === null ? 'passed' : 'failed', detail: failure ?? 'all assertions held' });
    } catch (err) {
      results.push({ caseId: spec.id, status: 'failed', detail: `unexpected error: ${describe(err)}` });
    }
  }
  return results;
}

// --- the scripted slot ------------------------------------------------------------------

function scriptedSlot(script: ScriptedReviewLoopScript): ReviewLoopSlot {
  const mode: ReviewMode = script.mode;
  if (!MODES.includes(mode)) throw new ReviewLoopContractError('invalid-input', `scripted mode ${String(mode)}`);

  const kindFor = (input: AssuranceSlotInput): AssuranceOutcome['kind'] => {
    const kind = script.outcomesByRound[input.round];
    if (kind === undefined) throw new ReviewLoopContractError('invalid-input', `no scripted outcome for round ${input.round}`);
    return kind;
  };

  const checkedInput = (label: string, input: AssuranceSlotInput): void => {
    assertWithinReviewLoopEnvelope(label, input);
    refuseInput(roundInputViolation(input));
  };

  const planOf = (input: AssuranceSlotInput): AssurancePlan => {
    checkedInput('planAssurance input', input);
    kindFor(input);
    return {
      slotVersion: REVIEW_LOOP_SLOT_VERSION,
      roundKey: input.idempotencyKey,
      mode,
      reviewKind: input.round === 1 ? 'fresh' : 're-review',
      reviewers: [],
      maxRounds: Math.max(1, ...Object.keys(script.outcomesByRound).map(Number)),
      blockingSeverities: ['HIGH', 'CRITICAL'],
      packetBudgetBytes: REVIEW_LOOP_MAX_PAYLOAD_BYTES,
      policyVersion: 'scripted',
      unsatisfiable: null,
    };
  };

  const ref = (kind: string, input: AssuranceSlotInput) => derivedArtifactRef(kind, ['scripted', mode, withoutFence(input)]);

  const outcomeOf = (input: AssuranceSlotInput): AssuranceOutcome => {
    const kind = kindFor(input);
    const base = {
      slotVersion: REVIEW_LOOP_SLOT_VERSION,
      roundKey: input.idempotencyKey,
      adjudicationId: sha256Hex(canonicalJson([REVIEW_LOOP_SLOT_VERSION, 'scripted', mode, kind, withoutFence(input)])),
      usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, reviewCostMicroUsd: 0 },
    };
    // The shape follows the script; a script that asks for a shape the contract forbids gets 'invalid-output'.
    const raw: Record<string, unknown> = { ...base, kind, mode };
    if (kind === 'PROCEED') {
      raw['shadow'] = mode === 'shadow' ? { wouldBe: 'PROCEED', reason: null, blockingFindings: 0 } : null;
      raw['prBodySectionRef'] = mode === 'not-required' ? null : ref('pr-body-section', input);
    } else if (kind === 'REPAIR') {
      raw['repairOrderRef'] = ref('repair-order', input);
      raw['nextRound'] = input.round + 1;
      raw['repairBaseSha'] = input.resultSha;
    } else if (kind === 'ESCALATE') {
      raw['reason'] = 'reviewer-escalated';
      raw['prBodySectionRef'] = ref('pr-body-section', input);
    } else {
      raw['reason'] = 'secret-in-diff';
      raw['prBodySectionRef'] = null;
    }
    const outcome = raw as unknown as AssuranceOutcome;
    const violations = outcomeInvariantViolations(input, outcome);
    if (violations.length > 0) throw new ReviewLoopContractError('invalid-output', `scripted ${kind} in mode ${mode}: ${violations.join('; ')}`);
    assertWithinReviewLoopEnvelope('scripted outcome', outcome);
    return outcome;
  };

  const live = (ctx: AssuranceStepContext): void => {
    if (ctx.signal.aborted) throw new AssuranceCancelledError('the scripted step was cancelled');
  };

  return {
    slotVersion: REVIEW_LOOP_SLOT_VERSION,

    async runAssuranceRound(input: AssuranceSlotInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome> {
      checkedInput('runAssuranceRound input', input);
      live(ctx);
      return outcomeOf(input);
    },

    planAssurance: planOf,

    async buildReviewPacket(input: BuildReviewPacketInput, ctx: AssuranceStepContext): Promise<BuildReviewPacketOutput> {
      assertWithinReviewLoopEnvelope('buildReviewPacket input', input);
      planOf(input.slot);
      live(ctx);
      const packetRef = ref('review-packet', input.slot);
      return { packetRef, packetSha256: packetRef.sha256, includedBytes: 0, overBudget: false, omittedFiles: 0 };
    },

    async runDeterministicChecks(input: DeterministicCheckInput, ctx: AssuranceStepContext): Promise<DeterministicCheckOutput> {
      assertWithinReviewLoopEnvelope('runDeterministicChecks input', input);
      const kind = kindFor(input.slot);
      planOf(input.slot);
      live(ctx);
      return {
        checkReportRef: ref('check-report', input.slot),
        pushGuard: kind === 'BLOCK' ? { decision: 'BLOCK', reason: 'secret-in-diff' } : { decision: 'PASS' },
        egress: { decision: 'CLEAR', packetSha256: input.packetRef.sha256 },
        findings: { total: 0, blocking: 0 },
      };
    },

    async runReviewer(input: RunReviewerInput): Promise<RunReviewerOutput> {
      assertWithinReviewLoopEnvelope('runReviewer input', input);
      planOf(input.slot);
      throw new ReviewLoopContractError('invalid-input', `reviewer ${input.reviewerConfigId} is not in the scripted plan, which plans none`);
    },

    async adjudicateRound(input: AdjudicateInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome> {
      assertWithinReviewLoopEnvelope('adjudicateRound input', input);
      planOf(input.slot);
      if (input.reviewIds.length !== 0) throw new ReviewLoopContractError('invalid-input', 'reviewIds name reviewers the scripted plan does not plan');
      live(ctx);
      return outcomeOf(input.slot);
    },

    async recordAttemptOutcome(input: AttemptOutcomeInput, ctx: AssuranceStepContext): Promise<null> {
      assertWithinReviewLoopEnvelope('recordAttemptOutcome input', input);
      refuseInput(attemptOutcomeViolation(input));
      live(ctx);
      return null;
    },

    admitWithAssurance(risk: RiskLevel) {
      return admitRisk(risk);
    },

    async buildRepairContextPack(input: RepairContextInput, ctx: AssuranceStepContext): Promise<RepairContextOutput> {
      assertWithinReviewLoopEnvelope('buildRepairContextPack input', input);
      if (input.slotVersion !== REVIEW_LOOP_SLOT_VERSION) throw new ReviewLoopContractError('invalid-input', `slotVersion ${String(input.slotVersion)}`);
      if ((input as { readonly fence: AssuranceFence | null }).fence === null) {
        throw new ReviewLoopContractError('invalid-input', 'buildRepairContextPack always requires a fence');
      }
      live(ctx);
      return { contextPackRef: derivedArtifactRef('context-pack', ['scripted', withoutFence(input)]) };
    },
  };
}
