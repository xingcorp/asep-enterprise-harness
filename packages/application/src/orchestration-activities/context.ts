// The engine-neutral delivery context, as the activities use it.
//
// Every activity runs over ActivityExecutionContext and never over an engine
// SDK. This module derives from it what the activities and the review-loop slot
// need:
//
//   - the slot's step context: the delivery's abort signal and heartbeat, and
//     one logical time for the whole activity execution — the workflow time at
//     scheduling, identical on every redelivery — so a redelivered round writes
//     byte-identical records and events;
//   - the check made immediately before an external call: the delivery was not
//     cancelled, and the caller still holds its lease (the lease primitive's
//     renewal fails for a lease that is not live). It narrows a stale owner's
//     window; it does not close it, which is why the forge writes are made
//     idempotent by content and compare-and-set instead.

import type { ActivityExecutionContext } from '@asep/ports';
import type { AssuranceHeartbeat, AssuranceStepContext } from '../review-loop/slot.js';

/** The delivery was cancelled (engine cancellation, heartbeat timeout, worker shutdown). Retryable by the engine. */
export class ActivityCancelledError extends Error {
  constructor(what: string) {
    super(`activity cancelled before ${what}`);
    this.name = 'ActivityCancelledError';
  }
}

export function throwIfCancelled(ctx: ActivityExecutionContext, what: string): void {
  if (ctx.signal.aborted) throw new ActivityCancelledError(what);
}

/**
 * The slot's step context for one activity execution (the context adapter). A heartbeat keeps the step and the
 * reviewer configuration id; the free-text note never reaches the engine, which keeps heartbeat details.
 */
export function assuranceStepContext(ctx: ActivityExecutionContext): AssuranceStepContext {
  const now = ctx.logicalNow;
  return {
    signal: ctx.signal,
    now: () => now,
    heartbeat: (details: AssuranceHeartbeat) => ctx.heartbeat({
      stage: details.step,
      ...(details.reviewerConfigId !== undefined ? { detail: { reviewerConfigId: details.reviewerConfigId } } : {}),
    }),
  };
}
