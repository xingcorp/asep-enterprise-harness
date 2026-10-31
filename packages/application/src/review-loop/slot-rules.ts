// Rules of the review-loop slot contract that the implementations in this
// package apply alike: the canonical hashing behind content-derived ids, the
// input rules every method checks after the envelope (slot version, round key,
// round lineage, the pre-lease terminals), and the error a rule raises. Kept
// apart from slot.ts, which is the locked contract text and does not change.
// slot.ts, the section text of disabled-slot.ts and of review-loop-contract.ts
// reassemble into the locked block, sha256
// 9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a; the
// assurance-slot-contract suite checks those bytes.

import { createHash } from 'node:crypto';
import type { ArtifactRef } from '@asep/contracts';
import {
  PRE_LEASE_ATTEMPT_TERMINALS,
  REVIEW_LOOP_SLOT_VERSION,
  ReviewLoopContractError,
  type AssuranceSlotInput,
  type AttemptOutcomeInput,
  type AttemptTerminal,
} from './slot.js';

export const ATTEMPT_TERMINALS: readonly AttemptTerminal[] = [
  'verification-stopped', 'proceeded', 'repair-requested', 'escalated', 'blocked', 'agent-failed',
  'budget-exhausted', 'cancelled', 'infrastructure-failed',
];

/** JSON with keys sorted at every level and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A value without its `fence`: what a redelivery by the current lease holder must repeat exactly. */
export function withoutFence<T extends { readonly fence: unknown }>(value: T): Omit<T, 'fence'> {
  const { fence: _fence, ...rest } = value;
  return rest;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A content-addressed artifact reference: its id and sha256 derive from `parts`, so every execution names it alike. */
export function derivedArtifactRef(kind: string, parts: readonly unknown[]): ArtifactRef {
  const digest = createHash('sha256').update(canonicalJson([kind, ...parts]), 'utf8').digest();
  let id = '';
  for (let i = 0; i < 26; i++) id += CROCKFORD[digest[i]! % 32];
  return { artifactId: id as ArtifactRef['artifactId'], sha256: sha256Hex(canonicalJson(['artifact', kind, ...parts])), kind };
}

/** Throws ReviewLoopContractError 'invalid-input' with `violation`, when there is one. */
export function refuseInput(violation: string | null): void {
  if (violation !== null) throw new ReviewLoopContractError('invalid-input', violation);
}

/** The rules a round input keeps after its envelope: version, key and lineage; null when it keeps them. */
export function roundInputViolation(input: AssuranceSlotInput): string | null {
  if (input.slotVersion !== REVIEW_LOOP_SLOT_VERSION) return `slotVersion ${String(input.slotVersion)} is not ${REVIEW_LOOP_SLOT_VERSION}`;
  if (!Number.isSafeInteger(input.round) || input.round < 1) return `round ${String(input.round)} is not a positive integer`;
  if (input.idempotencyKey !== `${input.attemptId}:assurance:${input.round}`) {
    return 'idempotencyKey is not <attemptId>:assurance:<round>';
  }
  if (input.round === 1 && input.priorAdjudicationId !== null) return 'round 1 carries a priorAdjudicationId';
  if (input.round > 1 && input.priorAdjudicationId === null) return `round ${input.round} carries no priorAdjudicationId`;
  return null;
}

/** The rules an attempt outcome keeps after its envelope; null when it keeps them. */
export function attemptOutcomeViolation(input: AttemptOutcomeInput): string | null {
  if (input.slotVersion !== REVIEW_LOOP_SLOT_VERSION) return `slotVersion ${String(input.slotVersion)} is not ${REVIEW_LOOP_SLOT_VERSION}`;
  if (!ATTEMPT_TERMINALS.includes(input.terminal)) return `terminal ${String(input.terminal)} is not an attempt terminal`;
  if (input.fence === null && !(PRE_LEASE_ATTEMPT_TERMINALS as readonly string[]).includes(input.terminal)) {
    return `terminal ${input.terminal} with fence null: an attempt that never held a lease ends ${PRE_LEASE_ATTEMPT_TERMINALS.join(' or ')}`;
  }
  if (input.assuranceUnavailable && (input.adjudicationId !== null || (input.terminal !== 'proceeded' && input.terminal !== 'escalated'))) {
    return 'assuranceUnavailable holds only for a proceeded or escalated attempt without an adjudication';
  }
  return null;
}
