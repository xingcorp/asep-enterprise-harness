// Validation of an assurance-round outcome.
//
// The slot implementation is outside this package, so its result arrives as
// `unknown` and is checked field by field against the slot contract's outcome
// shape. Anything outside the contract is a violation, which the task core audits
// and fails closed on. Extra fields are dropped: the parsed outcome carries
// exactly the contract's fields.

import type {
  ArtifactRef,
  AssuranceOutcome,
  AssuranceOutcomeKind,
  AssuranceUsage,
  BlockReason,
  EscalationReason,
  ReviewMode,
  ShadowVerdict,
} from './types.js';

export interface AssuranceContext {
  /** Round of the attempt that ran the assurance round. */
  readonly round: number;
  /** The attempt's harness commit; a repair must start from it. */
  readonly resultSha: string;
  /** The round's idempotency key, which the outcome's roundKey repeats. */
  readonly roundKey: string;
}

export type ParsedAssuranceOutcome =
  | { readonly ok: true; readonly outcome: AssuranceOutcome }
  | { readonly ok: false; readonly error: string };

const SLOT_VERSION = 'review-loop/v1';
const KINDS: readonly AssuranceOutcomeKind[] = ['PROCEED', 'REPAIR', 'ESCALATE', 'BLOCK'];
const MODES: readonly ReviewMode[] = ['not-required', 'shadow', 'gating'];
const ESCALATION_REASONS: readonly EscalationReason[] = [
  'packet-over-budget', 'egress-stopped', 'independence-unsatisfiable', 'reviewer-unavailable', 'reviewer-escalated',
  'max-repair-rounds', 'budget-exhausted',
];
const BLOCK_REASONS: readonly BlockReason[] = ['secret-in-diff', 'forbidden-path', 'unscannable-sensitive-change'];
const WOULD_BE: readonly ShadowVerdict['wouldBe'][] = ['PROCEED', 'REPAIR', 'ESCALATE'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function artifactRef(value: unknown): ArtifactRef | null {
  const v = fields(value);
  if (v === null || !isNonEmptyString(v['artifactId']) || !isNonEmptyString(v['kind'])) return null;
  if (typeof v['sha256'] !== 'string' || !SHA256_HEX.test(v['sha256'])) return null;
  return { artifactId: v['artifactId'], sha256: v['sha256'], kind: v['kind'] } as ArtifactRef;
}

/** Counts are non-negative safe integers and the cost is integer micro-USD or null; never a USD amount. */
function usage(value: unknown): AssuranceUsage | null {
  const v = fields(value);
  if (v === null) return null;
  const cost = v['reviewCostMicroUsd'];
  if (!isCount(v['providerCalls']) || !isCount(v['inputTokens']) || !isCount(v['outputTokens'])) return null;
  if (cost !== null && !isCount(cost)) return null;
  return { providerCalls: v['providerCalls'], inputTokens: v['inputTokens'], outputTokens: v['outputTokens'], reviewCostMicroUsd: cost };
}

function shadowVerdict(value: unknown): ShadowVerdict | null {
  const v = fields(value);
  if (v === null || !oneOf(WOULD_BE, v['wouldBe']) || !isCount(v['blockingFindings'])) return null;
  const reason = v['reason'];
  if (reason !== null && reason !== 'blocking-findings' && !oneOf(ESCALATION_REASONS, reason)) return null;
  return { wouldBe: v['wouldBe'], reason, blockingFindings: v['blockingFindings'] };
}

function fail(error: string): ParsedAssuranceOutcome {
  return { ok: false, error };
}

export function parseAssuranceOutcome(raw: unknown, context: AssuranceContext): ParsedAssuranceOutcome {
  const v = fields(raw);
  if (v === null) return fail('outcome is not an object');
  const kind = v['kind'];
  if (!oneOf(KINDS, kind)) return fail('unknown outcome kind');
  if (v['slotVersion'] !== SLOT_VERSION) return fail(`${kind}: slotVersion is not ${SLOT_VERSION}`);
  if (v['roundKey'] !== context.roundKey) return fail(`${kind}: roundKey is not the round's idempotency key`);
  const adjudicationId = v['adjudicationId'];
  if (typeof adjudicationId !== 'string' || !SHA256_HEX.test(adjudicationId)) return fail(`${kind}: adjudicationId is not 64 lowercase hex`);
  const roundUsage = usage(v['usage']);
  if (roundUsage === null) return fail(`${kind}: usage is not counts and integer micro-USD`);
  const base = { slotVersion: SLOT_VERSION, roundKey: context.roundKey, adjudicationId, usage: roundUsage } as const;
  const mode = v['mode'];

  switch (kind) {
    case 'PROCEED': {
      const section = v['prBodySectionRef'];
      const prBodySectionRef = artifactRef(section);
      if (section !== null && prBodySectionRef === null) return fail('PROCEED: prBodySectionRef malformed');
      if (mode === 'shadow') {
        const shadow = shadowVerdict(v['shadow']);
        if (shadow === null) return fail('PROCEED: a shadow-mode outcome needs a shadow verdict');
        return { ok: true, outcome: { ...base, kind, mode, shadow, prBodySectionRef } };
      }
      if (mode !== 'gating' && mode !== 'not-required') return fail('PROCEED: unknown mode');
      if (v['shadow'] !== null) return fail(`PROCEED: a ${mode} outcome carries no shadow verdict`);
      return { ok: true, outcome: { ...base, kind, mode, shadow: null, prBodySectionRef } };
    }
    case 'ESCALATE': {
      const prBodySectionRef = artifactRef(v['prBodySectionRef']);
      const reason = v['reason'];
      if (mode !== 'gating') return fail('ESCALATE: mode is not gating');
      if (!oneOf(ESCALATION_REASONS, reason)) return fail('ESCALATE: unknown reason');
      if (!prBodySectionRef) return fail('ESCALATE: prBodySectionRef missing or malformed');
      return { ok: true, outcome: { ...base, kind, mode, reason, prBodySectionRef } };
    }
    case 'REPAIR': {
      const repairOrderRef = artifactRef(v['repairOrderRef']);
      const nextRound = v['nextRound'];
      const repairBaseSha = v['repairBaseSha'];
      if (mode !== 'gating') return fail('REPAIR: mode is not gating');
      if (!repairOrderRef) return fail('REPAIR: repairOrderRef missing or malformed');
      if (nextRound !== context.round + 1) return fail(`REPAIR: nextRound must be ${context.round + 1}`);
      if (typeof repairBaseSha !== 'string' || repairBaseSha !== context.resultSha) {
        return fail("REPAIR: repairBaseSha must be the attempt's harness commit");
      }
      return { ok: true, outcome: { ...base, kind, mode, repairOrderRef, nextRound: context.round + 1, repairBaseSha } };
    }
    case 'BLOCK': {
      const section = v['prBodySectionRef'];
      const prBodySectionRef = artifactRef(section);
      const reason = v['reason'];
      if (!oneOf(MODES, mode)) return fail('BLOCK: unknown mode');
      if (!oneOf(BLOCK_REASONS, reason)) return fail('BLOCK: unknown reason');
      if (section !== null && prBodySectionRef === null) return fail('BLOCK: prBodySectionRef malformed');
      return { ok: true, outcome: { ...base, kind, mode, reason, prBodySectionRef } };
    }
  }
}
