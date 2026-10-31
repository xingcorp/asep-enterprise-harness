// The result of a pre-lease terminal write, as the workflow's recordPreLeaseOutcome
// step reports it.
//
// An attempt whose lease lookup found no lease records its terminal with fence null.
// The slot refuses that write with ReviewLoopContractError 'lease-granted' when
// durable history shows a lease by then: a grant that committed after the lookup.
// That refusal is a result, `recorded: false`, after which the workflow looks the
// lease up once more. It is never a supersession and never an activity failure.
// Every other error stays an error, for the activity's retry policy and then the
// workflow's attempt-state-unknown path.

import {
  ReviewLoopContractError,
  type AssuranceStepContext,
  type PreLeaseAttemptOutcomeInput,
  type ReviewLoopSlot,
} from '../review-loop/slot.js';

export interface PreLeaseOutcomeResult {
  /** False: the slot refused the write because the attempt's lease history now shows a lease. */
  readonly recorded: boolean;
}

export async function recordPreLeaseOutcome(
  slot: ReviewLoopSlot,
  input: PreLeaseAttemptOutcomeInput,
  ctx: AssuranceStepContext,
): Promise<PreLeaseOutcomeResult> {
  try {
    await slot.recordAttemptOutcome(input, ctx);
    return { recorded: true };
  } catch (err) {
    if (err instanceof ReviewLoopContractError && err.code === 'lease-granted') return { recorded: false };
    throw err;
  }
}
