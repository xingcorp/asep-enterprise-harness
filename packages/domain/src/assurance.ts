// Independent-assurance state machines (finding lifecycle, review round, review record).
//
// The finding lifecycle carries the closure authority: who may move a finding to
// which state. A reviewer that raised a finding can only claim it fixed (still
// blocking); a fix is verified only by a different reviewer that is independent of
// the implementer and cites a grounded resolution inside the repair delta, by a
// named human, for deterministic findings by the same rule no longer firing, or, for
// SARIF findings, by a scanner recheck the harness proved clean.
// Only humans accept, waive (with rationale, expiry and signature) or reject a
// grounded finding. The rules mirror the database constraints on
// finding_dispositions, so a write the database would refuse is refused here first.
//
// All functions are pure: no IO, no clock, no model call. Callers pass every
// timestamp in.

// --- finding vocabulary ------------------------------------------------------------

export const FINDING_LIFECYCLE_STATES = [
  'OPEN',
  'ACKNOWLEDGED',
  'FIXED',
  'VERIFIED',
  'CLOSED',
  'REFUTED',
  'ADJUDICATED',
  'WAIVED',
] as const;
export type FindingLifecycleState = (typeof FINDING_LIFECYCLE_STATES)[number];

/** A finding blocks while it is in one of these states (an expired waiver reopens it). */
export const BLOCKING_LIFECYCLE_STATES = ['OPEN', 'ACKNOWLEDGED', 'FIXED'] as const;

export const FINDING_DISPOSITION_KINDS = [
  'ACCEPTED',
  'REJECTED_WITH_EVIDENCE',
  'WAIVED',
  'RESOLUTION_CLAIMED',
  'RESOLUTION_VERIFIED',
  'REOPENED',
] as const;
export type FindingDispositionKind = (typeof FINDING_DISPOSITION_KINDS)[number];

export type FindingSource = 'model' | 'deterministic' | 'sarif';
export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface FindingAggregate {
  readonly id: string;
  readonly source: FindingSource;
  /** reviewerConfigId for model findings, `deterministic:<ruleId>` or `sarif:<tool>` otherwise. */
  readonly raisedBy: string;
  readonly severity: FindingSeverity;
  /** Set by the harness's grounding check, never by a model. */
  readonly grounded: boolean;
  readonly state: FindingLifecycleState;
  /** ISO-8601 instant a waiver stops applying; non-null only while WAIVED. */
  readonly waiverExpiresAt: string | null;
  readonly version: number;
}

export type HarnessRule =
  | 'citation-unresolvable'
  | 'deterministic-recheck'
  | 'scanner-recheck'
  | 'closure-without-change'
  | 'waiver-expired';

/** The finding source each harness rule may verify: a re-check verifies only its own kind of evidence. */
const harnessVerifies: Readonly<Partial<Record<HarnessRule, FindingSource>>> = {
  'deterministic-recheck': 'deterministic',
  'scanner-recheck': 'sarif',
};

export type DispositionActor =
  /** A named, authenticated human. */
  | { readonly kind: 'human'; readonly id: string }
  /** A model reviewer configuration; independence of the implementer is decided by policy. */
  | { readonly kind: 'reviewer'; readonly reviewerConfigId: string; readonly independentOfImplementer: boolean }
  | { readonly kind: 'harness-rule'; readonly rule: HarnessRule };

export interface FindingDispositionInput {
  readonly disposition: FindingDispositionKind;
  readonly actor: DispositionActor;
  /** 1 to 4000 characters. */
  readonly rationale: string;
  /** ISO-8601 UTC instant the disposition is recorded. */
  readonly at: string;
  /** Required for WAIVED, absent otherwise. */
  readonly waiver: { readonly expiresAt: string; readonly signature: string } | null;
  /**
   * RESOLUTION_VERIFIED only; required when a reviewer verifies: whether its resolution
   * citation was grounded and lies inside the repair delta.
   */
  readonly resolution: { readonly grounded: boolean; readonly inRepairDelta: boolean } | null;
}

export type FindingDispositionRejection =
  | 'invalid-input'
  | 'transition-not-allowed'
  | 'actor-not-permitted'
  | 'raiser-cannot-verify'
  | 'reviewer-not-independent'
  | 'resolution-not-grounded'
  | 'resolution-outside-repair-delta'
  | 'grounded-finding-needs-human'
  | 'waiver-incomplete'
  | 'waiver-not-expired';

export class FindingDispositionError extends Error {
  readonly code: FindingDispositionRejection;
  constructor(code: FindingDispositionRejection, message: string) {
    super(`finding disposition rejected (${code}): ${message}`);
    this.name = 'FindingDispositionError';
    this.code = code;
  }
}

const findingTransitions: Readonly<
  Record<FindingDispositionKind, { readonly from: readonly FindingLifecycleState[]; readonly to: FindingLifecycleState }>
> = {
  // A human judges the finding valid; also reverses an earlier rejection.
  ACCEPTED: { from: ['OPEN', 'REFUTED', 'ADJUDICATED'], to: 'ACKNOWLEDGED' },
  REJECTED_WITH_EVIDENCE: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'REFUTED' },
  WAIVED: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'WAIVED' },
  // A claim only: FIXED still blocks.
  RESOLUTION_CLAIMED: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'FIXED' },
  RESOLUTION_VERIFIED: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'VERIFIED' },
  REOPENED: { from: ['FIXED', 'VERIFIED', 'WAIVED'], to: 'OPEN' },
};

/** The state each harness rule may reopen from. */
const harnessReopenFrom: Readonly<Partial<Record<HarnessRule, FindingLifecycleState>>> = {
  'closure-without-change': 'FIXED',
  'waiver-expired': 'WAIVED',
  'deterministic-recheck': 'VERIFIED',
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function instant(value: string, what: string): number {
  const ms = ISO_UTC.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new FindingDispositionError('invalid-input', `${what} must be an ISO-8601 UTC instant`);
  return ms;
}

function reject(code: FindingDispositionRejection, message: string): never {
  throw new FindingDispositionError(code, message);
}

/** The identity recorded as the disposition actor. */
export function dispositionActorId(actor: DispositionActor): string {
  switch (actor.kind) {
    case 'human':
      return actor.id;
    case 'reviewer':
      return actor.reviewerConfigId;
    case 'harness-rule':
      return `harness-rule:${actor.rule}`;
  }
}

/** A new finding, OPEN. The raiser identity must agree with the source. */
export function openFinding(input: {
  readonly id: string;
  readonly source: FindingSource;
  readonly raisedBy: string;
  readonly severity: FindingSeverity;
  readonly grounded: boolean;
}): FindingAggregate {
  if (input.id.length === 0) throw new Error('finding id must be non-empty');
  const prefixed = /^(deterministic|sarif):./.exec(input.raisedBy);
  const consistent =
    input.source === 'model'
      ? input.raisedBy.length > 0 && !/^(deterministic|sarif):/.test(input.raisedBy)
      : prefixed !== null && prefixed[1] === input.source;
  if (!consistent) {
    throw new Error(`finding raisedBy "${input.raisedBy}" does not match source "${input.source}"`);
  }
  return { ...input, state: 'OPEN', waiverExpiresAt: null, version: 0 };
}

function validateInput(input: FindingDispositionInput): number {
  const at = instant(input.at, 'at');
  if (input.rationale.length < 1 || input.rationale.length > 4000) {
    reject('invalid-input', 'rationale must be 1 to 4000 characters');
  }
  if (dispositionActorId(input.actor).length === 0) {
    reject('invalid-input', 'actor identity must be non-empty');
  }
  if (input.waiver !== null) {
    if (input.disposition !== 'WAIVED') reject('invalid-input', 'only a waiver carries waiver terms');
    instant(input.waiver.expiresAt, 'waiver.expiresAt');
  }
  if (input.resolution !== null && input.disposition !== 'RESOLUTION_VERIFIED') {
    reject('invalid-input', 'only a resolution verification carries resolution evidence');
  }
  return at;
}

function checkAuthority(finding: FindingAggregate, input: FindingDispositionInput, at: number): void {
  const { actor, disposition } = input;
  const actorId = dispositionActorId(actor);

  if (disposition === 'RESOLUTION_VERIFIED' && actorId === finding.raisedBy) {
    reject('raiser-cannot-verify', `"${actorId}" raised this finding`);
  }

  if (actor.kind === 'human') {
    if (disposition === 'WAIVED') {
      const waiver = input.waiver;
      if (waiver === null || waiver.signature.length === 0 || instant(waiver.expiresAt, 'waiver.expiresAt') <= at) {
        reject('waiver-incomplete', 'a waiver needs a signature and an expiry after the decision');
      }
    }
    return;
  }

  if (actor.kind === 'reviewer') {
    if (disposition === 'RESOLUTION_CLAIMED') return;
    if (disposition !== 'RESOLUTION_VERIFIED') reject('actor-not-permitted', `a reviewer cannot record ${disposition}`);
    if (finding.source !== 'model') reject('actor-not-permitted', `a reviewer cannot verify a ${finding.source} finding`);
    if (!actor.independentOfImplementer) reject('reviewer-not-independent', `"${actorId}" shares the implementer's family`);
    if (input.resolution === null) reject('invalid-input', 'a reviewer verification must carry its resolution evidence');
    if (!input.resolution.grounded) reject('resolution-not-grounded', 'the resolution citation is not grounded');
    if (!input.resolution.inRepairDelta) {
      reject('resolution-outside-repair-delta', 'the resolution cites a file the repair did not change');
    }
    return;
  }

  // Harness rules: refute ungrounded findings, verify deterministic and scanner re-checks, reopen.
  switch (disposition) {
    case 'REJECTED_WITH_EVIDENCE':
      if (actor.rule !== 'citation-unresolvable') reject('actor-not-permitted', `${actorId} cannot refute`);
      if (finding.grounded) reject('grounded-finding-needs-human', 'only a human rejects a grounded finding');
      return;
    case 'RESOLUTION_VERIFIED':
      if (harnessVerifies[actor.rule] !== finding.source) {
        reject('actor-not-permitted', `${actorId} cannot verify a ${finding.source} finding`);
      }
      return;
    case 'REOPENED':
      if (harnessReopenFrom[actor.rule] !== finding.state) {
        reject('actor-not-permitted', `${actorId} cannot reopen a ${finding.state} finding`);
      }
      if (actor.rule === 'deterministic-recheck' && finding.source !== 'deterministic') {
        reject('actor-not-permitted', `${actorId} cannot reopen a ${finding.source} finding`);
      }
      if (actor.rule === 'waiver-expired' && (finding.waiverExpiresAt === null || instant(finding.waiverExpiresAt, 'waiverExpiresAt') > at)) {
        reject('waiver-not-expired', 'the waiver has not expired');
      }
      return;
    default:
      reject('actor-not-permitted', `${actorId} cannot record ${disposition}`);
  }
}

/**
 * Apply one disposition to a finding. Throws FindingDispositionError when the input is
 * malformed, the transition is not in the lifecycle, or the actor lacks the authority.
 */
export function applyFindingDisposition(finding: FindingAggregate, input: FindingDispositionInput): FindingAggregate {
  const at = validateInput(input);
  const transition = findingTransitions[input.disposition];
  if (!transition.from.includes(finding.state)) {
    reject('transition-not-allowed', `${input.disposition} is not allowed from ${finding.state}`);
  }
  checkAuthority(finding, input, at);
  return {
    ...finding,
    state: transition.to,
    waiverExpiresAt: transition.to === 'WAIVED' ? input.waiver!.expiresAt : null,
    version: finding.version + 1,
  };
}

function waiverExpired(finding: FindingAggregate, now: string): boolean {
  return (
    finding.state === 'WAIVED' &&
    finding.waiverExpiresAt !== null &&
    instant(finding.waiverExpiresAt, 'waiverExpiresAt') <= instant(now, 'now')
  );
}

/** The state that applies at `now`: an expired waiver no longer shields the finding. */
export function effectiveFindingState(finding: FindingAggregate, now: string): FindingLifecycleState {
  return waiverExpired(finding, now) ? 'OPEN' : finding.state;
}

/** Whether the finding's lifecycle makes it blocking at `now` (severity and grounding are decided elsewhere). */
export function isLifecycleBlocking(finding: FindingAggregate, now: string): boolean {
  return (BLOCKING_LIFECYCLE_STATES as readonly FindingLifecycleState[]).includes(effectiveFindingState(finding, now));
}

/** Reopen a finding whose waiver has expired at `now`; any other finding is returned unchanged. */
export function expireWaiver(finding: FindingAggregate, now: string): FindingAggregate {
  if (!waiverExpired(finding, now)) return finding;
  return applyFindingDisposition(finding, {
    disposition: 'REOPENED',
    actor: { kind: 'harness-rule', rule: 'waiver-expired' },
    rationale: `waiver expired at ${finding.waiverExpiresAt}`,
    at: now,
    waiver: null,
    resolution: null,
  });
}

/** Record that a refutation was settled by the round's adjudication. */
export function markRefutationAdjudicated(finding: FindingAggregate): FindingAggregate {
  if (finding.state !== 'REFUTED') reject('transition-not-allowed', `cannot adjudicate a ${finding.state} finding`);
  return { ...finding, state: 'ADJUDICATED', version: finding.version + 1 };
}

/** Close a verified finding. */
export function closeVerifiedFinding(finding: FindingAggregate): FindingAggregate {
  if (finding.state !== 'VERIFIED') reject('transition-not-allowed', `cannot close a ${finding.state} finding`);
  return { ...finding, state: 'CLOSED', version: finding.version + 1 };
}

// --- review round ---------------------------------------------------------------------

export class ReviewStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewStateError';
  }
}

export type ReviewRoundState = 'OPEN' | 'ADJUDICATED' | 'SUPERSEDED';

const roundAllowed: Readonly<Record<ReviewRoundState, readonly ReviewRoundState[]>> = {
  OPEN: ['ADJUDICATED'],
  // Superseded when the task's next round opens.
  ADJUDICATED: ['SUPERSEDED'],
  SUPERSEDED: [],
};

export interface ReviewRoundAggregate {
  readonly id: string;
  readonly round: number;
  readonly state: ReviewRoundState;
  readonly version: number;
}

export function transitionReviewRound(round: ReviewRoundAggregate, next: ReviewRoundState): ReviewRoundAggregate {
  if (!roundAllowed[round.state].includes(next)) {
    throw new ReviewStateError(`Invalid review round transition ${round.state} -> ${next}`);
  }
  return { ...round, state: next, version: round.version + 1 };
}

// --- review record (projection of one fenced reviewer call) -----------------------------

export type ReviewRecordTerminalState = 'COMPLETED' | 'FAILED' | 'EGRESS_STOPPED' | 'SKIPPED_PUSH_GUARD';

export interface ReviewRecordAggregate {
  /** sha256(attemptId | round | reviewerConfigId | packetSha256). */
  readonly reviewId: string;
  readonly terminalState: ReviewRecordTerminalState;
  /** Advances with each newer claim of the same reviewer call. */
  readonly callGeneration: number;
  readonly version: number;
}

/**
 * Record a reviewer call outcome. Every outcome is final except FAILED, which only a
 * newer claim (a higher call generation) may replace, with FAILED or COMPLETED.
 */
export function recordReviewOutcome(
  previous: ReviewRecordAggregate | null,
  next: { readonly reviewId: string; readonly terminalState: ReviewRecordTerminalState; readonly callGeneration: number },
): ReviewRecordAggregate {
  if (!Number.isInteger(next.callGeneration) || next.callGeneration < 1) {
    throw new ReviewStateError('call generation must be an integer >= 1');
  }
  if (previous === null) return { ...next, version: 0 };
  if (previous.reviewId !== next.reviewId) {
    throw new ReviewStateError(`review record ${previous.reviewId} cannot take an outcome for ${next.reviewId}`);
  }
  if (previous.terminalState !== 'FAILED') {
    throw new ReviewStateError(`review record ${previous.reviewId} is final (${previous.terminalState})`);
  }
  if (next.terminalState !== 'FAILED' && next.terminalState !== 'COMPLETED') {
    throw new ReviewStateError(`a failed review call cannot become ${next.terminalState}`);
  }
  if (next.callGeneration <= previous.callGeneration) {
    throw new ReviewStateError('a failed review call is replaced only under a newer claim');
  }
  return { ...next, version: previous.version + 1 };
}
