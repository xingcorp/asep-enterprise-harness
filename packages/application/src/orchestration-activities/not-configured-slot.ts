// The default review-loop slot of the orchestration composition: the binding
// when no independent assurance is configured.
//
// Its round answers only where risk admission already accounts for review:
// R0 (no independent reviewer) and R1 (a human reviews the PR). There it returns
// PROCEED with mode 'not-required' and nothing to show; for any other risk it
// throws AssuranceUnavailableError and the activity fails closed. It is not the
// literal opt-out (createDisabledAssuranceSlot): it records every attempt's
// terminal as the two attempt events, through the attempt-terminal store, which
// writes them fenced, idempotently and atomically under the attempt-row lock.
// So it is a stateful slot, and the conformance kit's stateful cases apply.
//
// The events are its idempotency record: their ids derive from the attempt, and
// their payload carries every field of the outcome input except the fence, so a
// redelivery with the same facts finds the same events and one with other facts
// finds a conflict.

import type { RiskLevel, RunEvent } from '@asep/contracts';
import type { AttemptRef, AttemptTerminalStore } from '@asep/ports';
import { admitRisk } from '../risk-admission.js';
import {
  AssuranceCancelledError,
  AssuranceFencedError,
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
  type AttemptTerminal,
  type BuildReviewPacketInput,
  type BuildReviewPacketOutput,
  type DeterministicCheckInput,
  type DeterministicCheckOutput,
  type RepairContextInput,
  type RepairContextOutput,
  type ReviewLoopSlot,
  type RunReviewerInput,
  type RunReviewerOutput,
} from '../review-loop/slot.js';
import {
  attemptOutcomeViolation, canonicalJson, refuseInput, roundInputViolation, sha256Hex, withoutFence,
} from '../review-loop/slot-rules.js';

/**
 * The task's risk requires independent review and no assurance is configured. Non-retryable: the activity fails
 * closed and the task stops before any publication.
 */
export class AssuranceUnavailableError extends Error {
  constructor(readonly risk: RiskLevel) {
    super(`risk ${risk} requires independent review, and no assurance is configured`);
    this.name = 'AssuranceUnavailableError';
  }
}

/** The risks admission already accounts for review of: R0 needs none, R1 a human reviewer after the PR. */
const REVIEWED_WITHOUT_ASSURANCE: readonly RiskLevel[] = ['R0', 'R1'];

const NOT_CONFIGURED = 'independent assurance is not configured: the round ends at its plan, and nothing is reviewed or repaired';

/**
 * Money is written to the events as USD (micro-USD / 10^6). Below 10^15 micro-USD that number reads back as the same
 * decimal, so two different amounts never write the same event; the slot refuses larger amounts rather than record
 * an amount it cannot tell apart.
 */
const EVENT_MONEY_LIMIT_MICRO_USD = 1e15;

const COMPLETED_OUTCOME: Readonly<Record<AttemptTerminal, NonNullable<RunEvent['outcome']>>> = {
  'proceeded': 'succeeded',
  'escalated': 'succeeded',
  'repair-requested': 'rejected',
  'blocked': 'blocked',
  'verification-stopped': 'fail',
  'agent-failed': 'failed',
  'infrastructure-failed': 'failed',
  'budget-exhausted': 'failed',
  'cancelled': 'cancelled',
};

const VERDICTS: readonly unknown[] = ['PASS', 'FAIL', 'ERROR'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isCount = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isEventMoney = (n: unknown): boolean => n === null || (isCount(n) && (n as number) < EVENT_MONEY_LIMIT_MICRO_USD);

/** The rules an outcome must keep to be written as run events; null when it keeps them. */
function eventFieldViolation(input: AttemptOutcomeInput): string | null {
  if (!isCount(input.round) || input.round < 1) return `round ${String(input.round)} is not a positive integer`;
  if (typeof input.declaredComplete !== 'boolean' || typeof input.assuranceUnavailable !== 'boolean') return 'declaredComplete and assuranceUnavailable are booleans';
  if (input.verificationVerdict !== null && !VERDICTS.includes(input.verificationVerdict)) return `verificationVerdict ${String(input.verificationVerdict)}`;
  if (input.adjudicationId !== null && (typeof input.adjudicationId !== 'string' || !SHA256_HEX.test(input.adjudicationId))) {
    return 'adjudicationId is neither null nor 64 lowercase hex';
  }
  if (input.failureClass !== null && (typeof input.failureClass !== 'string' || input.failureClass === '')) return 'failureClass is neither null nor a class id';
  const cost = input.cost;
  if (cost !== null) {
    if (!isEventMoney(cost.modelCostMicroUsd) || !isEventMoney(cost.computeCostMicroUsd)) return 'a cost is not below 10^15 micro-USD';
    if (!isCount(cost.inputTokens) || !isCount(cost.outputTokens) || !isCount(cost.toolCalls)) return 'token and tool-call counts are non-negative integers';
  }
  return null;
}

function attemptRefOf(input: { readonly repositoryBindingId: AttemptRef['repositoryBindingId']; readonly runId: AttemptRef['runId']; readonly taskId: AttemptRef['taskId']; readonly attemptId: AttemptRef['attemptId'] }): AttemptRef {
  return { repositoryBindingId: input.repositoryBindingId, runId: input.runId, taskId: input.taskId, attemptId: input.attemptId };
}

/** The attempt's two terminal events: every field of the input except the fence, timed at the execution's logical now. */
export function attemptTerminalEvents(input: AttemptOutcomeInput, occurredAt: string): RunEvent[] {
  const base = {
    occurredAt,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    repositoryBindingId: input.repositoryBindingId,
    risk: input.risk,
  };
  const cost = input.cost === null ? {} : {
    ...(input.cost.modelCostMicroUsd === null ? {} : { modelCostUsd: input.cost.modelCostMicroUsd / 1_000_000 }),
    ...(input.cost.computeCostMicroUsd === null ? {} : { computeCostUsd: input.cost.computeCostMicroUsd / 1_000_000 }),
    inputTokens: input.cost.inputTokens,
    outputTokens: input.cost.outputTokens,
    toolCalls: input.cost.toolCalls,
  };
  return [
    {
      ...base,
      eventId: `${input.attemptId}:attempt.declared_complete`,
      eventType: 'attempt.declared_complete',
      declaredComplete: input.declaredComplete,
      // Not-required mode: the required assurance is the mandatory verification, and a blocked round fails it.
      passedRequiredAssurance: input.verificationVerdict === 'PASS' && input.terminal !== 'blocked',
    },
    {
      ...base,
      eventId: `${input.attemptId}:attempt.completed`,
      eventType: 'attempt.completed',
      outcome: input.terminal === 'verification-stopped' && input.verificationVerdict === 'ERROR' ? 'error' : COMPLETED_OUTCOME[input.terminal],
      attemptTerminal: input.terminal,
      reviewRound: input.round,
      repairRound: input.round > 1,
      assuranceUnavailable: input.assuranceUnavailable,
      ...(input.verificationVerdict === null ? {} : { verificationVerdict: input.verificationVerdict }),
      ...(input.adjudicationId === null ? {} : { adjudicationId: input.adjudicationId }),
      ...(input.failureClass === null ? {} : { failureClass: input.failureClass }),
      ...cost,
    },
  ];
}

export class NotConfiguredAssuranceSlot implements ReviewLoopSlot {
  readonly slotVersion = REVIEW_LOOP_SLOT_VERSION;

  constructor(private readonly store: AttemptTerminalStore) {}

  async runAssuranceRound(input: AssuranceSlotInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome> {
    this.planAssurance(input);
    if (ctx.signal.aborted) throw new AssuranceCancelledError('the round was cancelled before it started');
    const lease = await this.store.checkLease(input.scope, attemptRefOf(input), input.fence);
    if (lease === 'not-in-scope') throw new ReviewLoopContractError('not-in-scope', 'the scope does not own the attempt');
    if (lease === 'fenced') throw new AssuranceFencedError('the caller no longer holds the attempt\'s lease at that epoch');
    const outcome: AssuranceOutcome = {
      slotVersion: REVIEW_LOOP_SLOT_VERSION,
      roundKey: input.idempotencyKey,
      adjudicationId: sha256Hex(canonicalJson([REVIEW_LOOP_SLOT_VERSION, 'not-configured', withoutFence(input)])),
      usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, reviewCostMicroUsd: 0 },
      kind: 'PROCEED',
      mode: 'not-required',
      shadow: null,
      prBodySectionRef: null,
    };
    assertWithinReviewLoopEnvelope('runAssuranceRound output', outcome);
    return outcome;
  }

  planAssurance(input: AssuranceSlotInput): AssurancePlan {
    assertWithinReviewLoopEnvelope('planAssurance input', input);
    refuseInput(roundInputViolation(input));
    if (!REVIEWED_WITHOUT_ASSURANCE.includes(input.risk)) throw new AssuranceUnavailableError(input.risk);
    return {
      slotVersion: REVIEW_LOOP_SLOT_VERSION,
      roundKey: input.idempotencyKey,
      mode: 'not-required',
      reviewKind: input.round === 1 ? 'fresh' : 're-review',
      reviewers: [],
      maxRounds: 1,
      blockingSeverities: [],
      packetBudgetBytes: 0,
      policyVersion: 'not-configured',
      unsatisfiable: null,
    };
  }

  async buildReviewPacket(input: BuildReviewPacketInput): Promise<BuildReviewPacketOutput> {
    return refuseStep('buildReviewPacket input', input);
  }

  async runDeterministicChecks(input: DeterministicCheckInput): Promise<DeterministicCheckOutput> {
    return refuseStep('runDeterministicChecks input', input);
  }

  async runReviewer(input: RunReviewerInput): Promise<RunReviewerOutput> {
    return refuseStep('runReviewer input', input);
  }

  async adjudicateRound(input: AdjudicateInput): Promise<AssuranceOutcome> {
    return refuseStep('adjudicateRound input', input);
  }

  async recordAttemptOutcome(input: AttemptOutcomeInput, ctx: AssuranceStepContext): Promise<null> {
    assertWithinReviewLoopEnvelope('recordAttemptOutcome input', input);
    refuseInput(attemptOutcomeViolation(input));
    refuseInput(eventFieldViolation(input));
    if (ctx.signal.aborted) throw new AssuranceCancelledError('the outcome write was cancelled before it started');
    const write = await this.store.recordTerminal(input.scope, attemptRefOf(input), input.fence, attemptTerminalEvents(input, ctx.now()));
    if (write.kind !== 'refused') return null;
    switch (write.reason) {
      case 'not-in-scope':
        throw new ReviewLoopContractError('not-in-scope', 'the scope does not own the attempt');
      case 'fenced':
        throw new AssuranceFencedError('the caller no longer holds the attempt\'s lease at that epoch');
      case 'lease-granted':
        throw new ReviewLoopContractError('lease-granted', 'the attempt\'s lease history shows a lease: record the terminal with its fence');
      case 'conflicting-redelivery':
        throw new ReviewLoopContractError('conflicting-redelivery', 'the attempt\'s terminal is recorded with other facts');
    }
  }

  admitWithAssurance(risk: RiskLevel, _capability: AssuranceCapability) {
    return admitRisk(risk);
  }

  async buildRepairContextPack(input: RepairContextInput): Promise<RepairContextOutput> {
    assertWithinReviewLoopEnvelope('buildRepairContextPack input', input);
    throw new ReviewLoopContractError('invalid-input', NOT_CONFIGURED);
  }
}

function refuseStep(label: string, input: unknown): never {
  assertWithinReviewLoopEnvelope(label, input);
  throw new ReviewLoopContractError('invalid-input', NOT_CONFIGURED);
}
