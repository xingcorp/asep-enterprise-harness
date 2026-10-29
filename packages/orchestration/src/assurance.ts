// Validation of an assurance-round outcome.
//
// The slot implementation is outside this package, so its result arrives as
// `unknown` and is checked field by field. Anything outside the contract is a
// violation, which the task core audits and fails closed on. Extra fields are
// ignored: the core reads only what it routes on.

import type { ArtifactRef, AssuranceOutcomeKind, CoreAssuranceOutcome } from './types.js';

export interface AssuranceContext {
  /** Round of the attempt that ran the assurance round. */
  readonly round: number;
  /** The attempt's harness commit; a repair must start from it. */
  readonly resultSha: string;
}

export type ParsedAssuranceOutcome =
  | { readonly ok: true; readonly outcome: CoreAssuranceOutcome }
  | { readonly ok: false; readonly error: string };

const KINDS: readonly AssuranceOutcomeKind[] = ['PROCEED', 'REPAIR', 'ESCALATE', 'BLOCK'];

type Fields = Readonly<Record<string, unknown>>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function artifactRef(value: unknown): ArtifactRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Fields;
  if (!isNonEmptyString(v['artifactId']) || !isNonEmptyString(v['kind'])) return null;
  if (typeof v['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(v['sha256'])) return null;
  return { artifactId: v['artifactId'], sha256: v['sha256'], kind: v['kind'] } as ArtifactRef;
}

function fail(error: string): ParsedAssuranceOutcome {
  return { ok: false, error };
}

export function parseAssuranceOutcome(raw: unknown, context: AssuranceContext): ParsedAssuranceOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('outcome is not an object');
  const v = raw as Fields;
  const kind = v['kind'];
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return fail('unknown outcome kind');
  const adjudicationId = v['adjudicationId'];
  if (!isNonEmptyString(adjudicationId)) return fail(`${kind}: adjudicationId missing`);

  const outcomeKind = kind as AssuranceOutcomeKind;
  switch (outcomeKind) {
    case 'PROCEED': {
      const prBodySectionRef = artifactRef(v['prBodySectionRef']);
      if (!prBodySectionRef) return fail('PROCEED: prBodySectionRef missing or malformed');
      return { ok: true, outcome: { kind: 'PROCEED', adjudicationId, prBodySectionRef } };
    }
    case 'ESCALATE': {
      const prBodySectionRef = artifactRef(v['prBodySectionRef']);
      const reason = v['reason'];
      if (!isNonEmptyString(reason)) return fail('ESCALATE: reason missing');
      if (!prBodySectionRef) return fail('ESCALATE: prBodySectionRef missing or malformed');
      return { ok: true, outcome: { kind: 'ESCALATE', adjudicationId, reason, prBodySectionRef } };
    }
    case 'REPAIR': {
      const repairOrderRef = artifactRef(v['repairOrderRef']);
      const nextRound = v['nextRound'];
      const repairBaseSha = v['repairBaseSha'];
      if (!repairOrderRef) return fail('REPAIR: repairOrderRef missing or malformed');
      if (nextRound !== context.round + 1) return fail(`REPAIR: nextRound must be ${context.round + 1}`);
      if (typeof repairBaseSha !== 'string' || repairBaseSha !== context.resultSha) {
        return fail("REPAIR: repairBaseSha must be the attempt's harness commit");
      }
      return { ok: true, outcome: { kind: 'REPAIR', adjudicationId, repairOrderRef, nextRound, repairBaseSha } };
    }
    case 'BLOCK': {
      const reason = v['reason'];
      if (!isNonEmptyString(reason)) return fail('BLOCK: reason missing');
      return { ok: true, outcome: { kind: 'BLOCK', adjudicationId, reason } };
    }
  }
}
