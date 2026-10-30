// Interval and agreement statistics for the corpus scorecards (docs/implementation/phases/phase-04-plan.md
// §7.2 item 10, §7.4; data model §7.4).
//
// Every proportion carries n and its Wilson 95% interval; a cell with n < 20 is descriptive
// only. k-run stability is the mean pairwise Jaccard of the matched gold sets, kept as an
// exact fraction so a floor compares it without rounding. Pure.

/** z for a two-sided 95% interval. */
const Z = 1.959963984540054;

export interface Count {
  readonly k: number;
  readonly n: number;
}

export interface Proportion {
  readonly value: number | null;
  readonly n: number;
  readonly wilson95: readonly [number, number] | null;
  readonly descriptiveOnly: boolean;
}

/** An exact non-negative fraction in lowest terms. */
export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Cells with fewer items than this are labelled descriptive only. */
export const DESCRIPTIVE_ONLY_BELOW = 20;

export function checkCount(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new Error(`statistics: ${k}/${n} is not a count`);
}

/** The Wilson score interval for k of n at 95%, clamped to [0, 1]; null when n is 0. */
export function wilson95(k: number, n: number): readonly [number, number] | null {
  checkCount(k, n);
  if (n === 0) return null;
  const p = k / n;
  const z2 = Z * Z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function proportion({ k, n }: Count): Proportion {
  checkCount(k, n);
  return { value: n === 0 ? null : k / n, n, wilson95: wilson95(k, n), descriptiveOnly: n < DESCRIPTIVE_ONLY_BELOW };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function fraction(numerator: bigint, denominator: bigint): Fraction {
  if (denominator <= 0n || numerator < 0n) throw new Error('statistics: a fraction needs a non-negative numerator and a positive denominator');
  const g = gcd(numerator, denominator) || 1n;
  return { numerator: numerator / g, denominator: denominator / g };
}

/** a ≤ b for exact fractions. */
export function atMost(a: Fraction, b: Fraction): boolean {
  return a.numerator * b.denominator <= b.numerator * a.denominator;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): Fraction {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return fraction(1n, 1n);
  const shared = [...a].filter((x) => b.has(x)).length;
  return fraction(BigInt(shared), BigInt(union.size));
}

/** Mean pairwise Jaccard over k runs' matched gold sets; null with fewer than two runs. */
export function kRunStability(runs: readonly (readonly string[])[]): Fraction | null {
  if (runs.length < 2) return null;
  const sets = runs.map((r) => new Set(r));
  let sum = fraction(0n, 1n);
  let pairs = 0n;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const p = jaccard(sets[i]!, sets[j]!);
      sum = fraction(sum.numerator * p.denominator + p.numerator * sum.denominator, sum.denominator * p.denominator);
      pairs += 1n;
    }
  }
  return fraction(sum.numerator, sum.denominator * pairs);
}
