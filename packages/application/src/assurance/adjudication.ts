// Adjudication: the pure decision for one assurance round.
//
// Rules are evaluated in order and the first match decides; the rule that fired is
// recorded in `ruleFired`. The blocking set is the deterministic and SARIF findings
// at a blocking severity, plus grounded model findings at a blocking severity, plus
// prior findings of every source that are still blocking after closure authority is
// applied. A finding of this round that re-raises a prior is reconciled with it first, so
// the prior's disposition decides and the pair is counted once. Deterministic evidence
// outranks model review: a model verdict never clears a deterministic or SARIF finding,
// and an ungrounded model finding never blocks. Shadow mode
// records what gating would have decided and returns only PROCEED or BLOCK.
//
// Pure: no IO, no clock, no model call. Waiver expiry is judged at the round's opening
// time, an input fixed when the round opened, so every execution of a round decides the
// same and the record carries no timestamp.

import {
  FindingDispositionError,
  applyFindingDisposition,
  effectiveFindingState,
  expireWaiver,
  isLifecycleBlocking,
  openFinding,
  type FindingAggregate,
  type FindingDispositionInput,
  type FindingLifecycleState,
  type FindingSeverity,
} from '@asep/domain';
import { tupleKey, tupleSha256 } from './canonical-json.js';
import type { PushGuardResult, ScannerRun } from './checks.js';
import type { DiffFileChange } from './diff.js';
import { bySeverityDescending, findingFingerprint, preferFinding, type CheckFinding } from './findings.js';
import { groundFinding, groundResolution, type GroundingContext, type GroundingFailure, type GroundingResult } from './grounding.js';
import type {
  BlockReason,
  EgressDecision,
  EscalationReason,
  ReviewFindingRecord,
  ReviewMode,
  ReviewPacket,
  ReviewRecordStatus,
  ReviewerRole,
  ShadowVerdict,
} from './local-types.js';
import type { ModelFindingOutput, ReviewOutput } from './prompt.js';

export interface PlannedReviewerInput {
  readonly reviewerConfigId: string;
  readonly role: ReviewerRole;
  /** Family-independent of the implementer, as resolved by policy. */
  readonly independentOfImplementer: boolean;
}

export interface ReviewInput {
  readonly reviewerConfigId: string;
  readonly status: ReviewRecordStatus;
  /** Why the review did not complete validly (for example `context-overflow`); null otherwise. */
  readonly failureReason: string | null;
  readonly recordSha256: string | null;
  /** The validated model output; non-null exactly when the status is COMPLETED_VALID. */
  readonly output: ReviewOutput | null;
}

export interface PriorFindingInput {
  readonly record: ReviewFindingRecord;
  /** Set while the finding is waived. */
  readonly waiverExpiresAt: string | null;
  /**
   * SARIF priors only: the scanner version recorded when the finding was raised. Absent or
   * null, no scanner recheck can be proven and only a named human closes the finding.
   */
  readonly scannerVersion?: string | null;
}

export interface AdjudicationInput {
  readonly roundKey: string;
  readonly attemptId: string;
  readonly round: number;
  readonly mode: ReviewMode;
  readonly maxRounds: number;
  readonly blockingSeverities: readonly FindingSeverity[];
  readonly groundingMinChars: { readonly evidence: number; readonly requiredFix: number };
  /** Review-policy version plus its sha256. */
  readonly policyVersion: string;
  /**
   * When the round opened (`review_rounds.opened_at`), ISO-8601 UTC. Waiver expiry is judged
   * at this time, never at the clock of the execution that adjudicates.
   */
  readonly roundOpenedAt: string;
  readonly packet: ReviewPacket;
  readonly packetSha256: string;
  readonly diff: readonly DiffFileChange[];
  readonly repairDelta: readonly DiffFileChange[] | null;
  readonly checks: {
    readonly pushGuard: PushGuardResult;
    readonly egress: { readonly decision: EgressDecision; readonly packetSha256: string };
    readonly findings: readonly CheckFinding[];
    /** The scanner runs of this round's check report. */
    readonly scannerRuns: readonly ScannerRun[];
    readonly reportSha256: string;
  };
  /** Set by planning when the policy cannot be met. */
  readonly unsatisfiable: EscalationReason | null;
  readonly reviewers: readonly PlannedReviewerInput[];
  /** Exactly one per planned reviewer, in plan order. */
  readonly reviews: readonly ReviewInput[];
  readonly priorFindings: readonly PriorFindingInput[];
  /** The caller's lease identity, recorded as the fence that authorized the decision write. */
  readonly fence: { readonly leaseId: string; readonly fencingEpoch: number };
}

export type AdjudicationRule = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A9' | 'A10' | 'A11';

export interface BlockingEntry {
  readonly findingRef: string;
  readonly source: 'model' | 'deterministic' | 'sarif';
  readonly raisedBy: string;
  readonly severity: FindingSeverity;
  readonly reason: 'deterministic-rule' | 'grounded-model-finding' | 'prior-finding';
}

export type ClosureRule =
  | 'deterministic-recheck'
  | 'scanner-recheck'
  | 'human'
  | 'independent-reviewer'
  | 'raiser-claim'
  | 'closure-without-change'
  | 'regression'
  | 'unchanged';

export interface ClosureDecision {
  readonly priorFindingId: string;
  readonly raisedBy: string;
  readonly claims: readonly { readonly by: string; readonly status: 'RESOLVED' | 'PARTIAL' | 'OPEN' }[];
  readonly effectiveState: FindingLifecycleState;
  readonly rule: ClosureRule;
}

export interface AdjudicationRecord {
  /** sha256 of the canonical JSON tuple [roundKey, policyVersion, packetSha256, checkReportSha256, sorted reviewRecordSha256s]. */
  readonly adjudicationId: string;
  readonly roundKey: string;
  readonly attemptId: string;
  readonly round: number;
  readonly mode: ReviewMode;
  readonly outcome: 'PROCEED' | 'REPAIR' | 'ESCALATE' | 'BLOCK';
  readonly reason: EscalationReason | BlockReason | null;
  readonly ruleFired: AdjudicationRule;
  /** Non-null exactly when the mode is shadow and the outcome is PROCEED. */
  readonly shadow: ShadowVerdict | null;
  readonly pushGuard: PushGuardResult;
  readonly egressDecision: EgressDecision;
  readonly blocking: readonly BlockingEntry[];
  readonly grounding: readonly { readonly findingRef: string; readonly grounded: boolean; readonly reason: GroundingFailure | null }[];
  readonly verdictMismatches: readonly { readonly reviewerConfigId: string; readonly verdict: 'APPROVE' | 'REQUEST_CHANGES'; readonly groundedBlockingCount: number }[];
  readonly closureDecisions: readonly ClosureDecision[];
  readonly policyVersion: string;
  readonly inputs: { readonly packetSha256: string; readonly checkReportSha256: string; readonly reviewRecordSha256s: readonly string[] };
  readonly fence: { readonly leaseId: string; readonly fencingEpoch: number };
}

/** A finding as adjudicated this round, in review-finding/v1 shape. */
export interface EvaluatedFinding extends ReviewFindingRecord {
  /**
   * `prior:<id>` for prior findings, `<raisedBy>#<fingerprint>` for check findings and
   * `<raisedBy>#<fingerprint>#<identity>` for model findings, where the identity digest also
   * covers the requirement id and the finding key.
   */
  readonly ref: string;
  readonly blocking: boolean;
}

export interface Adjudication {
  readonly record: AdjudicationRecord;
  readonly findings: readonly EvaluatedFinding[];
}

export class AdjudicationInputError extends Error {
  constructor(message: string) {
    super(`adjudication: ${message}`);
    this.name = 'AdjudicationInputError';
  }
}

function invalid(message: string): never {
  throw new AdjudicationInputError(message);
}

function validate(input: AdjudicationInput): void {
  if (!Number.isInteger(input.round) || input.round < 1) invalid('round must be an integer >= 1');
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1) invalid('maxRounds must be an integer >= 1');
  const planned = input.reviewers.map((r) => r.reviewerConfigId);
  const reviewed = input.reviews.map((r) => r.reviewerConfigId);
  if (tupleKey(planned) !== tupleKey(reviewed)) {
    invalid('reviews must match the planned reviewers, in plan order');
  }
  if (input.mode === 'not-required' && planned.length > 0) invalid('a round that needs no review plans no reviewer');
  if (input.checks.egress.packetSha256 !== input.packetSha256) invalid('the egress decision covers another packet');
  for (const review of input.reviews) {
    if ((review.status === 'COMPLETED_VALID') !== (review.output !== null)) {
      invalid(`review ${review.reviewerConfigId} must carry output exactly when it completed validly`);
    }
  }
  if (input.unsatisfiable !== null && input.unsatisfiable !== 'independence-unsatisfiable' && input.unsatisfiable !== 'budget-exhausted') {
    invalid(`planning cannot report ${input.unsatisfiable}`);
  }
}

function toAggregate(record: ReviewFindingRecord, state: FindingLifecycleState, waiverExpiresAt: string | null): FindingAggregate {
  return {
    id: record.id,
    source: record.source,
    raisedBy: record.raisedBy,
    severity: record.severity,
    grounded: record.grounded,
    state,
    waiverExpiresAt: state === 'WAIVED' ? waiverExpiresAt : null,
    version: 0,
  };
}

function dispose(
  finding: FindingAggregate,
  input: Omit<FindingDispositionInput, 'waiver' | 'resolution'> & Partial<Pick<FindingDispositionInput, 'resolution'>>,
): FindingAggregate | null {
  try {
    return applyFindingDisposition(finding, { waiver: null, resolution: null, ...input });
  } catch (err) {
    if (err instanceof FindingDispositionError) return null;
    throw err;
  }
}

function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Whether this round's checks prove a SARIF prior gone: a run of the same scanner at the
 * version recorded with the prior effectively ran the prior's rule and scanned the prior's
 * file, no run of that scanner failed, and no result has the prior's fingerprint. A declared
 * rule is not proof that it ran.
 */
function scannerRecheckProven(input: AdjudicationInput, prior: PriorFindingInput): boolean {
  const F = prior.record;
  const tool = F.raisedBy.slice('sarif:'.length);
  const version = prior.scannerVersion ?? null;
  const rule = F.ruleId ?? null;
  const file = F.file ?? null;
  if (version === null || rule === null || file === null) return false;
  const runs = input.checks.scannerRuns.filter((r) => r.tool === tool);
  return (
    runs.every((r) => r.executionSuccessful) &&
    runs.some((r) => r.toolVersion === version && r.effectiveRules.includes(rule) && r.scannedFiles.includes(file)) &&
    !input.checks.findings.some((f) => f.raisedBy === F.raisedBy && f.fingerprint === F.fingerprint)
  );
}

/** A prior finding as persisted, with a waiver that had expired when the round opened lifted. */
function persistedAggregate(prior: PriorFindingInput, asOf: string): FindingAggregate {
  return expireWaiver(toAggregate(prior.record, prior.record.lifecycleState, prior.waiverExpiresAt), asOf);
}

/** The identity a finding keeps across rounds; a finding key is local to one review output. */
function persistedIdentity(f: { readonly raisedBy: string; readonly fingerprint: string; readonly requirementId?: string | undefined }): string {
  return tupleKey([f.raisedBy, f.fingerprint, f.requirementId ?? null]);
}

/**
 * Whether a prior's authoritative disposition makes a re-raise of it non-blocking: an
 * unexpired waiver, or a refutation of a grounded finding (only a human refutes those). A
 * finding the harness refuted as ungrounded shields nothing.
 */
function shields(state: FindingLifecycleState, prior: PriorFindingInput): boolean {
  return state === 'WAIVED' || ((state === 'REFUTED' || state === 'ADJUDICATED') && prior.record.grounded);
}

/** Closure authority for one prior finding. */
function closePrior(
  input: AdjudicationInput,
  ctx: GroundingContext,
  prior: PriorFindingInput,
): { readonly decision: ClosureDecision; readonly state: FindingLifecycleState } {
  const F = prior.record;
  const claims = input.reviews.flatMap((review) =>
    (review.output?.priorFindingClaims ?? []).filter((c) => c.priorFindingId === F.id).map((claim) => ({ by: review.reviewerConfigId, claim })),
  );
  const decision = (state: FindingLifecycleState, rule: ClosureRule) => ({
    decision: {
      priorFindingId: F.id,
      raisedBy: F.raisedBy,
      claims: claims.map((c) => ({ by: c.by, status: c.claim.status })),
      effectiveState: state,
      rule,
    },
    state,
  });
  const asOf = input.roundOpenedAt;
  const at = { rationale: 'decided by the round adjudication', at: asOf };
  let agg = persistedAggregate(prior, asOf);
  const current = effectiveFindingState(agg, asOf);

  if (F.source === 'deterministic') {
    const firing = input.checks.findings.some((f) => f.raisedBy === F.raisedBy && f.fingerprint === F.fingerprint);
    if (!firing && isLifecycleBlocking(agg, asOf)) {
      const verified = dispose(agg, {
        ...at,
        disposition: 'RESOLUTION_VERIFIED',
        actor: { kind: 'harness-rule', rule: 'deterministic-recheck' },
      });
      if (verified !== null) return decision(verified.state, 'deterministic-recheck');
    }
    return decision(current, 'unchanged');
  }
  if (F.source === 'sarif') {
    if (isLifecycleBlocking(agg, asOf) && scannerRecheckProven(input, prior)) {
      const verified = dispose(agg, {
        ...at,
        disposition: 'RESOLUTION_VERIFIED',
        actor: { kind: 'harness-rule', rule: 'scanner-recheck' },
      });
      if (verified !== null) return decision(verified.state, 'scanner-recheck');
    }
    return decision(current, 'unchanged');
  }
  if (!isLifecycleBlocking(agg, asOf)) return decision(current, 'unchanged');

  const eligible = new Set(input.reviewers.filter((r) => r.independentOfImplementer).map((r) => r.reviewerConfigId));
  const resolved = claims
    .filter((c) => c.claim.status === 'RESOLVED')
    .map((c) => ({ ...c, grounding: groundResolution(ctx, c.claim, F) }));

  for (const c of resolved) {
    if (c.by === F.raisedBy || !eligible.has(c.by) || !c.grounding.grounded || !c.grounding.changedLine) continue;
    const verified = dispose(agg, {
      ...at,
      disposition: 'RESOLUTION_VERIFIED',
      actor: { kind: 'reviewer', reviewerConfigId: c.by, independentOfImplementer: true },
      resolution: { grounded: true, inRepairDelta: true },
    });
    if (verified !== null) return decision(verified.state, 'independent-reviewer');
  }
  const raiserClaim = resolved.find((c) => c.by === F.raisedBy && c.grounding.grounded && c.grounding.fileInRepairDelta);
  if (raiserClaim !== undefined) {
    const fixed = dispose(agg, {
      ...at,
      disposition: 'RESOLUTION_CLAIMED',
      actor: { kind: 'reviewer', reviewerConfigId: F.raisedBy, independentOfImplementer: eligible.has(F.raisedBy) },
    });
    if (fixed !== null) return decision(fixed.state, 'raiser-claim');
  }
  if (resolved.some((c) => c.grounding.grounded && !c.grounding.fileInRepairDelta)) {
    if (agg.state === 'FIXED') {
      agg =
        dispose(agg, { ...at, disposition: 'REOPENED', actor: { kind: 'harness-rule', rule: 'closure-without-change' } }) ?? agg;
    }
    return decision(effectiveFindingState(agg, asOf), 'closure-without-change');
  }
  return decision(current, 'unchanged');
}

interface Candidate {
  readonly finding: ModelFindingOutput;
  readonly fingerprint: string;
  readonly result: GroundingResult;
}

/** Grounded before ungrounded, then the finding order of `preferFinding`. */
function preferCandidate(a: Candidate, b: Candidate): number {
  if (a.result.grounded !== b.result.grounded) return a.result.grounded ? -1 : 1;
  return preferFinding(a.finding, b.finding);
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Decide one assurance round. Throws AdjudicationInputError on inconsistent input. */
export function adjudicate(input: AdjudicationInput): Adjudication {
  validate(input);
  const blockingSeverity = new Set(input.blockingSeverities);
  const ctx: GroundingContext = {
    packet: input.packet,
    diff: input.diff,
    repairDelta: input.repairDelta,
    minChars: input.groundingMinChars,
  };

  // Deterministic and SARIF findings of this round.
  const evaluated: EvaluatedFinding[] = input.checks.findings.map((f) => ({
    ref: `${f.raisedBy}#${f.fingerprint}`,
    id: `${f.raisedBy}#${f.fingerprint}`,
    source: f.source,
    raisedBy: f.raisedBy,
    fingerprint: f.fingerprint,
    severity: f.severity,
    category: f.category,
    evidence: f.evidence,
    requiredFix: f.requiredFix,
    grounded: true,
    lifecycleState: 'OPEN',
    ...optional('ruleId', f.ruleId),
    ...optional('file', f.file),
    ...optional('lineStart', f.lineStart),
    ...optional('lineEnd', f.lineEnd),
    blocking: blockingSeverity.has(f.severity),
  }));

  // Model findings: each is grounded by the harness on its own first. Findings of one
  // identity (fingerprint, requirement id, key) then merge conservatively: a grounded member
  // wins over an ungrounded one, then the highest severity, then a fixed order, so neither
  // the order of the list nor an ungrounded duplicate can change what blocks.
  const grounding: AdjudicationRecord['grounding'][number][] = [];
  const verdictMismatches: AdjudicationRecord['verdictMismatches'][number][] = [];
  for (const review of input.reviews) {
    if (review.output === null) continue;
    const identities = new Map<string, Candidate[]>();
    for (const finding of review.output.findings) {
      const fingerprint = findingFingerprint({
        category: finding.category,
        file: finding.file,
        lineStart: finding.lineStart,
        ruleId: null,
      });
      const identity = tupleSha256([fingerprint, finding.requirementId, finding.key]);
      identities.set(identity, [...(identities.get(identity) ?? []), { finding, fingerprint, result: groundFinding(ctx, finding) }]);
    }
    let groundedBlockingCount = 0;
    for (const [identity, members] of sortBy([...identities], ([id]) => id)) {
      const { finding, fingerprint, result } = [...members].sort(preferCandidate)[0]!;
      const ref = `${review.reviewerConfigId}#${fingerprint}#${identity.slice(0, 16)}`;
      grounding.push({ findingRef: ref, grounded: result.grounded, reason: result.reason });
      let lifecycle: FindingLifecycleState = 'OPEN';
      if (!result.grounded) {
        const opened = openFinding({ id: ref, source: 'model', raisedBy: review.reviewerConfigId, severity: finding.severity, grounded: false });
        lifecycle = applyFindingDisposition(opened, {
          disposition: 'REJECTED_WITH_EVIDENCE',
          actor: { kind: 'harness-rule', rule: 'citation-unresolvable' },
          rationale: `citation-unresolvable: ${result.reason}`,
          at: input.roundOpenedAt,
          waiver: null,
          resolution: null,
        }).state;
      }
      const blocking = result.grounded && blockingSeverity.has(finding.severity);
      if (blocking) groundedBlockingCount += 1;
      evaluated.push({
        ref,
        id: ref,
        source: 'model',
        raisedBy: review.reviewerConfigId,
        fingerprint,
        severity: finding.severity,
        category: finding.category,
        evidence: finding.evidence,
        requiredFix: finding.requiredFix,
        grounded: result.grounded,
        lifecycleState: lifecycle,
        ...optional('groundingReason', result.reason),
        ...optional('requirementId', finding.requirementId),
        ...optional('file', finding.file),
        ...optional('lineStart', finding.lineStart),
        ...optional('lineEnd', finding.lineEnd ?? finding.lineStart),
        blocking,
      });
    }
    const verdict = review.output.verdict;
    if ((verdict === 'APPROVE' && groundedBlockingCount > 0) || (verdict === 'REQUEST_CHANGES' && groundedBlockingCount === 0)) {
      verdictMismatches.push({ reviewerConfigId: review.reviewerConfigId, verdict, groundedBlockingCount });
    }
  }

  // Reconcile this round's grounded findings with the priors of the same persisted identity.
  // The prior's disposition as persisted decides: a live waiver or a human refutation keeps
  // the re-raise non-blocking, a verified or closed prior makes it a regression, and any other
  // prior is carried by the re-raise. The re-raise then stands for the pair at the higher
  // severity, so it never downgrades a prior it does not shield, and a linked prior is not
  // counted again below. An ungrounded finding links nothing, so it can never stand in for a
  // prior that still blocks.
  const priors = sortBy(input.priorFindings, (p) => p.record.id).map((prior) => ({
    prior,
    state: effectiveFindingState(persistedAggregate(prior, input.roundOpenedAt), input.roundOpenedAt),
  }));
  const linked = new Set<string>();
  const regressions = new Set<string>();
  for (const [i, f] of evaluated.entries()) {
    if (!f.grounded) continue;
    const matches = priors.filter((p) => persistedIdentity(p.prior.record) === persistedIdentity(f));
    if (matches.length === 0) continue;
    for (const m of matches) linked.add(m.prior.record.id);
    const open = matches.filter((m) => !shields(m.state, m.prior));
    if (open.length === 0) {
      evaluated[i] = { ...f, priorFindingId: matches[0]!.prior.record.id, lifecycleState: matches[0]!.state, blocking: false };
      continue;
    }
    const settled = open.find((m) => m.state === 'VERIFIED' || m.state === 'CLOSED');
    if (settled !== undefined) regressions.add(settled.prior.record.id);
    const severity = [f.severity, ...open.map((m) => m.prior.record.severity)].sort(bySeverityDescending)[0]!;
    evaluated[i] = {
      ...f,
      severity,
      priorFindingId: (settled ?? open[0]!).prior.record.id,
      lifecycleState: 'OPEN',
      blocking: blockingSeverity.has(severity),
    };
  }

  // Prior findings under closure authority, of every source.
  const closureDecisions: ClosureDecision[] = [];
  for (const { prior } of priors) {
    const closed = closePrior(input, ctx, prior);
    const { state } = closed;
    closureDecisions.push(regressions.has(prior.record.id) ? { ...closed.decision, rule: 'regression' } : closed.decision);
    const blocking =
      !linked.has(prior.record.id) &&
      prior.record.grounded &&
      blockingSeverity.has(prior.record.severity) &&
      (['OPEN', 'ACKNOWLEDGED', 'FIXED'] as const).some((s) => s === state);
    evaluated.push({ ...prior.record, lifecycleState: state, ref: `prior:${prior.record.id}`, blocking });
  }

  const blocking: BlockingEntry[] = sortBy(
    evaluated.filter((f) => f.blocking),
    (f) => tupleKey([f.raisedBy, f.ref]),
  ).map((f) => ({
    findingRef: f.ref,
    source: f.source,
    raisedBy: f.raisedBy,
    severity: f.severity,
    reason: f.ref.startsWith('prior:') ? 'prior-finding' : f.source === 'model' ? 'grounded-model-finding' : 'deterministic-rule',
  }));

  // The rule table.
  type Decision = { readonly rule: AdjudicationRule; readonly kind: 'PROCEED' | 'REPAIR' | 'ESCALATE'; readonly reason: EscalationReason | null };
  const gatingDecision = (): Decision => {
    const reviews = input.reviews;
    const overflow = (r: ReviewInput) =>
      r.status === 'FAILED' && (r.failureReason === 'context-overflow' || r.failureReason === 'prompt-over-budget');
    if (input.packet.budget.overBudget || reviews.some(overflow)) {
      return { rule: 'A3', kind: 'ESCALATE', reason: 'packet-over-budget' };
    }
    if (input.checks.egress.decision !== 'CLEAR' || reviews.some((r) => r.status === 'EGRESS_STOPPED')) {
      return { rule: 'A4', kind: 'ESCALATE', reason: 'egress-stopped' };
    }
    if (input.unsatisfiable === 'independence-unsatisfiable' || !input.reviewers.some((r) => r.independentOfImplementer)) {
      return { rule: 'A5', kind: 'ESCALATE', reason: 'independence-unsatisfiable' };
    }
    if (input.unsatisfiable === 'budget-exhausted') return { rule: 'A6', kind: 'ESCALATE', reason: 'budget-exhausted' };
    if (reviews.some((r) => r.status !== 'COMPLETED_VALID')) return { rule: 'A7', kind: 'ESCALATE', reason: 'reviewer-unavailable' };
    if (blocking.length === 0) {
      if (reviews.some((r) => r.output?.verdict === 'ESCALATE')) return { rule: 'A8', kind: 'ESCALATE', reason: 'reviewer-escalated' };
      return { rule: 'A9', kind: 'PROCEED', reason: null };
    }
    if (input.round >= input.maxRounds) return { rule: 'A10', kind: 'ESCALATE', reason: 'max-repair-rounds' };
    return { rule: 'A11', kind: 'REPAIR', reason: null };
  };

  let ruleFired: AdjudicationRule;
  let outcome: AdjudicationRecord['outcome'];
  let reason: AdjudicationRecord['reason'] = null;
  let shadow: ShadowVerdict | null = null;
  if (input.checks.pushGuard.decision === 'BLOCK') {
    ruleFired = 'A1';
    outcome = 'BLOCK';
    reason = input.checks.pushGuard.reason;
  } else if (input.mode === 'not-required') {
    ruleFired = 'A2';
    outcome = 'PROCEED';
  } else {
    const d = gatingDecision();
    ruleFired = d.rule;
    if (input.mode === 'gating') {
      outcome = d.kind;
      reason = d.reason;
    } else {
      outcome = 'PROCEED';
      shadow = {
        wouldBe: d.kind,
        reason: d.kind === 'REPAIR' ? 'blocking-findings' : d.reason,
        blockingFindings: blocking.length,
      };
    }
  }

  const reviewRecordSha256s = input.reviews
    .map((r) => r.recordSha256)
    .filter((s): s is string => s !== null)
    .sort();
  const record: AdjudicationRecord = {
    adjudicationId: tupleSha256([input.roundKey, input.policyVersion, input.packetSha256, input.checks.reportSha256, reviewRecordSha256s]),
    roundKey: input.roundKey,
    attemptId: input.attemptId,
    round: input.round,
    mode: input.mode,
    outcome,
    reason,
    ruleFired,
    shadow,
    pushGuard: input.checks.pushGuard,
    egressDecision: input.checks.egress.decision,
    blocking,
    grounding,
    verdictMismatches,
    closureDecisions,
    policyVersion: input.policyVersion,
    inputs: { packetSha256: input.packetSha256, checkReportSha256: input.checks.reportSha256, reviewRecordSha256s },
    fence: { leaseId: input.fence.leaseId, fencingEpoch: input.fence.fencingEpoch },
  };
  return { record, findings: evaluated };
}
