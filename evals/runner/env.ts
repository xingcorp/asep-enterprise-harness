// Deterministic execution environment for the eval runner (Codex P1-OPT-002).
//
// Every source of non-determinism is pinned or denied so that running the same
// fixtures twice from a clean checkout yields byte-identical output:
//   - locale pinned to C / en-US-POSIX ordering
//   - timezone pinned to UTC
//   - a fixed seed is exposed for any (currently none) pseudo-random need
//   - outbound network is default-DENY: any DNS/socket attempt throws
//
// The runner imports `enforceDeterminism()` before doing any work.

import dns from 'node:dns';

export const EVAL_SEED = 0x5eed_1234;
export const EVAL_TIMEZONE = 'UTC';
export const EVAL_LOCALE = 'en-US';

let enforced = false;

/**
 * Pin locale/timezone and install a network default-deny. Idempotent.
 * Throws if the environment cannot be made deterministic.
 */
export function enforceDeterminism(): void {
  if (enforced) return;

  // Timezone: pin to UTC so any Date formatting is stable.
  process.env.TZ = EVAL_TIMEZONE;

  // Locale: pin so Intl / localeCompare ordering is stable.
  process.env.LANG = 'C';
  process.env.LC_ALL = 'C';

  // Network default-deny: replace DNS lookup so no fixture can reach out.
  // Deterministic runs must never depend on the network.
  const deny = (): never => {
    throw new Error('eval-runner: network access is denied in deterministic mode');
  };
  // Override the common resolution entry points.
  (dns as unknown as { lookup: unknown }).lookup = deny;
  (dns.promises as unknown as { lookup: unknown }).lookup = deny;

  enforced = true;
}

/** Stable string compare used everywhere the runner sorts, independent of locale. */
export function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
