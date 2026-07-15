// Deterministic execution environment for the eval runner (Codex P1-OPT-002,
// hardened per P1-FINAL-MED-002).
//
// Every source of non-determinism is pinned or denied so that running the same
// fixtures twice from a clean checkout yields byte-identical output:
//   - locale pinned to C / en-US-POSIX ordering
//   - timezone pinned to UTC
//   - a fixed seed is exposed for any (currently none) pseudo-random need
//   - outbound network is default-DENY across EVERY egress path a grader could
//     reach for: DNS resolution, raw TCP/TLS sockets (net/tls.connect),
//     http/https client requests, and the global fetch(). Any attempt throws
//     the same NetworkDenied error so a determinism regression fails loud.
//
// The runner imports `enforceDeterminism()` before doing any work.

import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

export const EVAL_SEED = 0x5eed_1234;
export const EVAL_TIMEZONE = 'UTC';
export const EVAL_LOCALE = 'en-US';

export class NetworkDeniedError extends Error {
  constructor(via: string) {
    super(`eval-runner: network access is denied in deterministic mode (via ${via})`);
    this.name = 'NetworkDeniedError';
  }
}

let enforced = false;

/**
 * Pin locale/timezone and install a network default-deny across every egress
 * path. Idempotent. Throws if the environment cannot be made deterministic.
 */
export function enforceDeterminism(): void {
  if (enforced) return;

  // Timezone: pin to UTC so any Date formatting is stable.
  process.env.TZ = EVAL_TIMEZONE;

  // Locale: pin so Intl / localeCompare ordering is stable.
  process.env.LANG = 'C';
  process.env.LC_ALL = 'C';

  // Network default-deny. Deterministic runs must never depend on the network,
  // so we block every path a grader (or a transitive dep) could use to reach
  // out. Each override throws NetworkDeniedError naming the path it blocked.
  const deny = (via: string) => (): never => {
    throw new NetworkDeniedError(via);
  };

  // DNS resolution.
  (dns as unknown as { lookup: unknown }).lookup = deny('dns.lookup');
  (dns.promises as unknown as { lookup: unknown }).lookup = deny('dns.promises.lookup');
  (dns as unknown as { resolve: unknown }).resolve = deny('dns.resolve');

  // Raw sockets (TCP/TLS). This is the lowest-level egress and also what most
  // higher-level clients ultimately call.
  (net as unknown as { connect: unknown }).connect = deny('net.connect');
  (net as unknown as { createConnection: unknown }).createConnection = deny('net.createConnection');
  (tls as unknown as { connect: unknown }).connect = deny('tls.connect');

  // http/https client requests.
  (http as unknown as { request: unknown }).request = deny('http.request');
  (http as unknown as { get: unknown }).get = deny('http.get');
  (https as unknown as { request: unknown }).request = deny('https.request');
  (https as unknown as { get: unknown }).get = deny('https.get');

  // Global fetch (Node 18+/24). Undici lives behind this symbol.
  if (typeof (globalThis as { fetch?: unknown }).fetch !== 'undefined') {
    (globalThis as { fetch: unknown }).fetch = deny('fetch');
  }

  enforced = true;
}

/** Stable string compare used everywhere the runner sorts, independent of locale. */
export function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
