// The assurance round, as one activity: the review-loop slot's
// runAssuranceRound, called through the context adapter with the attempt's
// persisted evidence and the caller's fence.
//
// The evidence reference is rebuilt from the stored bundle after its identity is
// checked against the attempt's recorded commit, so the slot reviews exactly the
// commit the attempt made. The outcome goes back to the workflow untouched: the
// decision core validates it field by field.

import type { ArtifactId, ArtifactRef } from '@asep/contracts';
import type { ActivityExecutionContext } from '@asep/ports';
import { adoptVerifiedEvidence } from '../pipeline-steps.js';
import { REVIEW_LOOP_SLOT_VERSION, type AssuranceOutcome } from '../review-loop/slot.js';
import { assuranceStepContext, throwIfCancelled } from './context.js';
import type { OrchestrationActivityDeps } from './deps.js';
import { recordedCommit } from './execution-activities.js';
import { OrchestrationContractError, type LeasedAttemptIdentity } from './identity.js';

export interface AssuranceRoundInput extends LeasedAttemptIdentity {
  readonly round: number;
  readonly evidenceId: string;
  /** The task's pinned base: the origin of the cumulative diff. */
  readonly taskBaseSha: string;
  /** The attempt's own base: the task base, or the repair base for a repair attempt. */
  readonly attemptBaseSha: string;
  readonly declaredComplete: boolean;
  readonly priorAdjudicationId: string | null;
  /** `<attemptId>:assurance:<round>`. */
  readonly idempotencyKey: string;
  readonly budgetRemaining: { readonly costMicroUsd: number | null; readonly wallClockMs: number };
  readonly workOrderRef: ArtifactRef;
}

export async function assuranceRound(
  deps: OrchestrationActivityDeps, input: AssuranceRoundInput, ctx: ActivityExecutionContext,
): Promise<{ readonly outcome: AssuranceOutcome }> {
  throwIfCancelled(ctx, 'the assurance round');
  const commit = await recordedCommit(deps, input);
  if (commit === null || commit.evidenceId !== input.evidenceId) {
    throw new OrchestrationContractError(`attempt ${input.attemptId} has no recorded commit naming evidence ${input.evidenceId}`);
  }
  const bundle = await deps.evidence.getEvidence(input.scope, input.evidenceId as ArtifactId);
  const evidence = adoptVerifiedEvidence(bundle, {
    evidenceId: input.evidenceId as ArtifactId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.attemptBaseSha,
    resultSha: commit.commitSha,
  });
  const outcome = await deps.slot.runAssuranceRound({
    slotVersion: REVIEW_LOOP_SLOT_VERSION,
    idempotencyKey: input.idempotencyKey,
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    risk: input.risk,
    round: input.round,
    evidenceRef: evidence.ref,
    workOrderRef: input.workOrderRef,
    taskBaseSha: input.taskBaseSha,
    resultSha: commit.commitSha,
    implementer: deps.implementer,
    declaredComplete: input.declaredComplete,
    priorAdjudicationId: input.priorAdjudicationId,
    fence: input.fence,
    budgetRemaining: input.budgetRemaining,
  }, assuranceStepContext(ctx));
  return { outcome };
}
