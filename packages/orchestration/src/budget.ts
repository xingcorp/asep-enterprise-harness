// Budget arithmetic. Money is held in integer micro-dollars so that sums and
// comparisons are exact and identical on every replay.

import type { Budget, TaskBudget } from './types.js';

const MICRO = 1_000_000;

export function toMicroUsd(usd: number): number {
  return Math.round(usd * MICRO);
}

export function fromMicroUsd(micro: number): number {
  return micro / MICRO;
}

export interface ReservationInput {
  readonly attemptNumber: number;
  readonly attemptBudget: Budget;
  readonly taskBudget: TaskBudget;
  /** Run budget left when the task started; the task's spending counts against it. */
  readonly runRemainingUsd: number;
  readonly spentMicroUsd: number;
  readonly spentWallClockMinutes: number;
  readonly grantedExtensionMicroUsd: number;
  readonly overrun: boolean;
}

export type ReservationFailureReason = 'attempts-exhausted' | 'overrun' | 'wall-clock' | 'run-budget' | 'task-budget';

export type Reservation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReservationFailureReason; readonly shortfallUsd: number };

/**
 * An attempt starts only if its full cost and wall-clock reservations fit. Only a
 * task-cap shortfall can be met by a human extension; the run remainder, the
 * attempt count, the wall-clock cap and an overrun cannot.
 */
export function checkReservation(input: ReservationInput): Reservation {
  if (input.attemptNumber > input.taskBudget.maxAttempts) {
    return { ok: false, reason: 'attempts-exhausted', shortfallUsd: 0 };
  }
  if (input.overrun) return { ok: false, reason: 'overrun', shortfallUsd: 0 };
  if (input.spentWallClockMinutes + input.attemptBudget.maxWallClockMinutes > input.taskBudget.maxWallClockMinutes) {
    return { ok: false, reason: 'wall-clock', shortfallUsd: 0 };
  }
  const needed = input.spentMicroUsd + toMicroUsd(input.attemptBudget.maxCostUsd);
  const runCap = toMicroUsd(input.runRemainingUsd);
  if (needed > runCap) return { ok: false, reason: 'run-budget', shortfallUsd: fromMicroUsd(needed - runCap) };
  const taskCap = toMicroUsd(input.taskBudget.maxCostUsd) + input.grantedExtensionMicroUsd;
  if (needed > taskCap) return { ok: false, reason: 'task-budget', shortfallUsd: fromMicroUsd(needed - taskCap) };
  return { ok: true };
}

/** True when spending moves from below the soft threshold to at or above it. */
export function crossesSoftThreshold(beforeMicroUsd: number, afterMicroUsd: number, softCostUsd: number): boolean {
  const soft = toMicroUsd(softCostUsd);
  return beforeMicroUsd < soft && afterMicroUsd >= soft;
}
