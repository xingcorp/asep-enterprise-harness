// Money in the orchestration tables: integer micro-USD at every boundary, stored
// as an exact numeric of USD (the columns check that no fraction of a micro-USD
// is ever stored). A value goes in as the exact decimal text of its USD amount
// and comes back as `(column * 1000000)::bigint`, so no binary floating point
// touches an amount on either side.

/** A non-negative safe integer (positive when `positive`): an amount of micro-USD. */
export function isMicroUsd(value: unknown, positive = false): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

/** The exact USD decimal of an amount of micro-USD, for a `$n::numeric` parameter. */
export function usdDecimal(microUsd: number): string {
  if (!isMicroUsd(microUsd)) throw new RangeError(`${String(microUsd)} is not an amount of micro-USD`);
  const micro = BigInt(microUsd);
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
}

/** An amount read back as `(column * 1000000)::bigint`, which drivers return as text or a number. */
export function microUsdOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`stored amount ${String(value)} is not a safe integer of micro-USD`);
  return n;
}
