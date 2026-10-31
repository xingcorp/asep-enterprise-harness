// Imports of the section below. The locked slot block was written as one
// module; split into its three files, each section imports what it names.
import type { RiskLevel } from '@asep/contracts';
import { admitRisk } from '../risk-admission.js';
import {
  AssuranceCancelledError,
  REVIEW_LOOP_DISABLED,
  REVIEW_LOOP_SLOT_VERSION,
  ReviewLoopContractError,
  assertWithinReviewLoopEnvelope,
  type AdjudicateInput,
  type AssuranceCapability,
  type AssuranceOutcome,
  type AssurancePlan,
  type AssuranceSlotInput,
  type AssuranceStepContext,
  type AttemptOutcomeInput,
  type BuildReviewPacketInput,
  type BuildReviewPacketOutput,
  type DeterministicCheckInput,
  type DeterministicCheckOutput,
  type RepairContextInput,
  type RepairContextOutput,
  type ReviewLoopSlot,
  type RunReviewerInput,
  type RunReviewerOutput,
} from './slot.js';
import {
  attemptOutcomeViolation, canonicalJson, refuseInput, roundInputViolation, sha256Hex, withoutFence,
} from './slot-rules.js';

// ===========================================================================
// packages/application/src/review-loop/disabled-slot.ts            (S0; signature)
// ===========================================================================

/**
 * The explicit, literal opt-out (Phase 2 behaviour), constructible only with the literal.
 * Every round returns PROCEED with mode 'not-required', shadow null, no reviewer call and
 * no event; recordAttemptOutcome validates its input like any implementation, then
 * resolves null and records nothing; admitWithAssurance
 * equals admitRisk; buildRepairContextPack throws ReviewLoopContractError 'invalid-input'.
 * It is never a default binding: when no assurance is configured, the orchestration lane
 * binds its NotConfiguredAssuranceSlot, which fails closed for any risk that requires
 * review.
 */
export function createDisabledAssuranceSlot(ack: typeof REVIEW_LOOP_DISABLED): ReviewLoopSlot {
  return disabledAssuranceSlot(ack);
}

// === end of the locked slot block text ===

const DISABLED_HELPER = 'review loop disabled: the round ends at its plan, and nothing is reviewed or repaired';

function disabledAssuranceSlot(ack: string): ReviewLoopSlot {
  if (ack !== REVIEW_LOOP_DISABLED) {
    throw new ReviewLoopContractError('invalid-input', 'the review loop is disabled only with the literal REVIEW_LOOP_DISABLED');
  }

  const plan = (input: AssuranceSlotInput): AssurancePlan => {
    assertWithinReviewLoopEnvelope('planAssurance input', input);
    refuseInput(roundInputViolation(input));
    return {
      slotVersion: REVIEW_LOOP_SLOT_VERSION,
      roundKey: input.idempotencyKey,
      mode: 'not-required',
      reviewKind: input.round === 1 ? 'fresh' : 're-review',
      reviewers: [],
      maxRounds: 1,
      blockingSeverities: [],
      packetBudgetBytes: 0,
      policyVersion: 'review-loop-disabled',
      unsatisfiable: null,
    };
  };

  const refuseStep = (label: string, input: unknown): never => {
    assertWithinReviewLoopEnvelope(label, input);
    throw new ReviewLoopContractError('invalid-input', DISABLED_HELPER);
  };

  return {
    slotVersion: REVIEW_LOOP_SLOT_VERSION,

    async runAssuranceRound(input: AssuranceSlotInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome> {
      plan(input);
      if (ctx.signal.aborted) throw new AssuranceCancelledError('the round was cancelled before it started');
      const outcome: AssuranceOutcome = {
        slotVersion: REVIEW_LOOP_SLOT_VERSION,
        roundKey: input.idempotencyKey,
        adjudicationId: sha256Hex(canonicalJson([REVIEW_LOOP_SLOT_VERSION, 'disabled', withoutFence(input)])),
        usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, reviewCostMicroUsd: 0 },
        kind: 'PROCEED',
        mode: 'not-required',
        shadow: null,
        prBodySectionRef: null,
      };
      assertWithinReviewLoopEnvelope('runAssuranceRound output', outcome);
      return outcome;
    },

    planAssurance: plan,

    buildReviewPacket(input: BuildReviewPacketInput): Promise<BuildReviewPacketOutput> {
      return Promise.resolve().then(() => refuseStep('buildReviewPacket input', input));
    },

    runDeterministicChecks(input: DeterministicCheckInput): Promise<DeterministicCheckOutput> {
      return Promise.resolve().then(() => refuseStep('runDeterministicChecks input', input));
    },

    runReviewer(input: RunReviewerInput): Promise<RunReviewerOutput> {
      return Promise.resolve().then(() => refuseStep('runReviewer input', input));
    },

    adjudicateRound(input: AdjudicateInput): Promise<AssuranceOutcome> {
      return Promise.resolve().then(() => refuseStep('adjudicateRound input', input));
    },

    async recordAttemptOutcome(input: AttemptOutcomeInput, ctx: AssuranceStepContext): Promise<null> {
      assertWithinReviewLoopEnvelope('recordAttemptOutcome input', input);
      refuseInput(attemptOutcomeViolation(input));
      if (ctx.signal.aborted) throw new AssuranceCancelledError('the outcome write was cancelled before it started');
      return null;
    },

    admitWithAssurance(risk: RiskLevel, _capability: AssuranceCapability) {
      return admitRisk(risk);
    },

    async buildRepairContextPack(input: RepairContextInput): Promise<RepairContextOutput> {
      assertWithinReviewLoopEnvelope('buildRepairContextPack input', input);
      throw new ReviewLoopContractError('invalid-input', DISABLED_HELPER);
    },
  };
}
