// Budget arithmetic. Money is held in integer micro-dollars so that sums and
// comparisons are exact and identical on every replay. Conversion reads the
// number's shortest decimal form rather than multiplying binary floating point,
// so 1.1 is exactly 1 100 000 micro-dollars, and it rounds up, so a fraction of a
// micro-dollar above a cap is still above it.

import type { Budget, TaskBudget, VerificationReserve } from './types.js';

const MICRO = 1_000_000;

/**
 * The largest money amount an input may carry. Ten attempts, each charged at
 * most this much for the agent plus its reserve, stay far inside the
 * safe-integer range of micro-dollars.
 */
export const MAX_USD = 100_000_000;

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/** The whole micro-dollars of a non-negative finite amount, and whether any non-zero digit lies beyond them. */
function decimalMicros(usd: number): { readonly micros: number; readonly remainder: boolean } | null {
  if (!Number.isFinite(usd) || usd < 0) return null;
  // String() yields the shortest decimal that reads back as the same number.
  const match = DECIMAL.exec(String(usd));
  if (match === null) return null;
  const integer = match[1]!;
  const digits = integer + (match[2] ?? '');
  const cut = integer.length + Number(match[3] ?? '0') + 6;
  if (cut <= 0) return { micros: 0, remainder: /[1-9]/.test(digits) };
  const whole = cut >= digits.length ? digits + '0'.repeat(cut - digits.length) : digits.slice(0, cut);
  const micros = Number(whole);
  return Number.isSafeInteger(micros) ? { micros, remainder: /[1-9]/.test(digits.slice(cut)) } : null;
}

/** Micro-dollars, rounded up. Throws for a negative, non-finite or unrepresentably large amount. */
export function toMicroUsd(usd: number): number {
  const parts = decimalMicros(usd);
  const micros = parts === null ? null : parts.micros + (parts.remainder ? 1 : 0);
  if (micros === null || !Number.isSafeInteger(micros)) throw new RangeError(`not a money amount: ${usd}`);
  return micros;
}

/** True for an amount exact in micro-dollars, not negative and at most MAX_USD: the rule every money input follows. */
export function isExactUsd(usd: number): boolean {
  const parts = decimalMicros(usd);
  return parts !== null && !parts.remainder && usd <= MAX_USD;
}

/**
 * Provider-reported cost (untrusted) in micro-dollars, rounded up, or null when
 * it is not an amount within the bound (negative, not a number, not finite, or
 * above MAX_USD). Such a report is an overrun by itself; it is never clamped
 * into the bound before the comparison with the cap.
 */
export function reportedMicroUsd(reportedUsd: number): number | null {
  return Number.isFinite(reportedUsd) && reportedUsd >= 0 && reportedUsd <= MAX_USD ? toMicroUsd(reportedUsd) : null;
}

export function fromMicroUsd(micro: number): number {
  return micro / MICRO;
}

export interface ReservationInput {
  readonly attemptNumber: number;
  readonly attemptBudget: Budget;
  readonly taskBudget: TaskBudget;
  readonly verificationReserve: VerificationReserve;
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
 * An attempt starts only if its agent cap and, separately, its verification
 * reserve fit, in cost and wall-clock, so agent spending can never consume the
 * verification budget. The attempt count is checked first: running out of
 * attempts wins over every budget cause. Only a task-cap shortfall can be met by
 * a human extension; the run remainder, the wall-clock cap and an overrun cannot.
 */
export function checkReservation(input: ReservationInput): Reservation {
  if (input.attemptNumber > input.taskBudget.maxAttempts) {
    return { ok: false, reason: 'attempts-exhausted', shortfallUsd: 0 };
  }
  if (input.overrun) return { ok: false, reason: 'overrun', shortfallUsd: 0 };
  const minutes = input.attemptBudget.maxWallClockMinutes + input.verificationReserve.wallClockMinutes;
  if (input.spentWallClockMinutes + minutes > input.taskBudget.maxWallClockMinutes) {
    return { ok: false, reason: 'wall-clock', shortfallUsd: 0 };
  }
  const needed = input.spentMicroUsd + toMicroUsd(input.attemptBudget.maxCostUsd) + toMicroUsd(input.verificationReserve.costUsd);
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
