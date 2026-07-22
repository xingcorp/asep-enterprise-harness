// Deterministic execution environment for the eval runner (Codex P1-OPT-002,
// hardened per P1-FINAL-MED-002).
//
// Every source of non-determinism is pinned or denied so that running the same
// fixtures twice from a clean checkout yields byte-identical output:
//   - locale pinned to C / en-US-POSIX ordering
//   - timezone pinned to UTC
//   - a fixed seed is exposed for any (currently none) pseudo-random need
//   - outbound network is default-DENY across EVERY egress path a grader could
//     reach for: the full DNS resolver surface (lookup/resolve*/reverse and the
//     promises API), raw TCP/TLS sockets (net/tls.connect), UDP datagram sockets
//     (dgram), http/https client requests, the HTTP/2 client (http2.connect),
//     and the global fetch(). Any attempt throws the same NetworkDenied error so
//     a determinism regression fails loud.
//
// The runner imports `enforceDeterminism()` before doing any work.

import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';

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

  // DNS resolution. Cover the whole resolver surface, not just three entries:
  // lookup/resolve, every resolveXxx record helper, reverse, and the promises
  // API. A grader that reached for dns.resolveTxt() must fail just as loudly as
  // one that called dns.lookup().
  const DNS_METHODS = [
    'lookup',
    'lookupService',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCname',
    'resolveCaa',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ] as const;
  for (const m of DNS_METHODS) {
    (dns as unknown as Record<string, unknown>)[m] = deny(`dns.${m}`);
    (dns.promises as unknown as Record<string, unknown>)[m] = deny(`dns.promises.${m}`);
  }

  // Raw sockets (TCP/TLS). This is the lowest-level egress and also what most
  // higher-level clients ultimately call.
  (net as unknown as { connect: unknown }).connect = deny('net.connect');
  (net as unknown as { createConnection: unknown }).createConnection = deny('net.createConnection');
  (tls as unknown as { connect: unknown }).connect = deny('tls.connect');

  // UDP (dgram) — a datagram socket is a full egress path (DNS-over-UDP, QUIC,
  // arbitrary UDP exfiltration) that bypasses net/tls entirely.
  (dgram as unknown as { createSocket: unknown }).createSocket = deny('dgram.createSocket');

  // ---- PROTOTYPE-LEVEL DENY (P1-FINAL-MED-002, cycle-3) --------------------
  //
  // Overriding only the module factory functions above is NOT enough. Codex
  // demonstrated two surviving egress paths:
  //   (a) PRE-CAPTURE: a grader that saved `const f = dgram.createSocket`
  //       BEFORE enforcement still held the original factory and could build a
  //       live socket afterward — our factory swap never touched that closure.
  //   (b) CONSTRUCTOR: `new dns.Resolver().resolve4(...)`, `new net.Socket().
  //       connect(...)`, and `new tls.TLSSocket().connect(...)` never went
  //       through the module factory at all, so they were entirely unguarded.
  //
  // The fix poisons the TRANSPORT METHODS on the shared PROTOTYPES. Every
  // socket/resolver instance — however it was constructed, and whether the
  // factory reference was captured early or late — resolves these methods off
  // the same prototype object, so the deny is unavoidable. The factory swaps
  // above are retained as a louder, earlier failure for the common direct-call
  // path; the prototype poison is the actual containment boundary.
  const poison = (
    proto: object | undefined,
    methods: readonly string[],
    label: string,
  ): void => {
    if (!proto) return;
    for (const m of methods) {
      if (typeof (proto as Record<string, unknown>)[m] === 'function') {
        (proto as Record<string, unknown>)[m] = deny(`${label}.${m}`);
      }
    }
  };

  // UDP: bind/send/connect are the only ways a datagram actually leaves. Poison
  // them on the Socket prototype so a pre-captured createSocket is inert.
  poison(
    (dgram as unknown as { Socket?: { prototype?: object } }).Socket?.prototype,
    ['bind', 'send', 'connect'],
    'dgram.Socket',
  );

  // TCP/TLS: connect on the Socket prototype (net.Socket / tls.TLSSocket) is the
  // constructor-based egress path. tls.TLSSocket extends net.Socket, but we
  // poison both prototypes explicitly in case the inheritance chain is bypassed.
  poison(
    (net as unknown as { Socket?: { prototype?: object } }).Socket?.prototype,
    ['connect'],
    'net.Socket',
  );
  poison(
    (tls as unknown as { TLSSocket?: { prototype?: object } }).TLSSocket?.prototype,
    ['connect'],
    'tls.TLSSocket',
  );

  // DNS: `new dns.Resolver()` carries its own copy of every resolver method on
  // the prototype, independent of the module-level dns.* functions patched
  // below. Poison the whole record surface on the prototype.
  poison(
    (dns as unknown as { Resolver?: { prototype?: object } }).Resolver?.prototype,
    DNS_METHODS,
    'dns.Resolver',
  );
  poison(
    (dns.promises as unknown as { Resolver?: { prototype?: object } }).Resolver?.prototype,
    DNS_METHODS,
    'dns.promises.Resolver',
  );

  // http/https client requests.
  (http as unknown as { request: unknown }).request = deny('http.request');
  (http as unknown as { get: unknown }).get = deny('http.get');
  (https as unknown as { request: unknown }).request = deny('https.request');
  (https as unknown as { get: unknown }).get = deny('https.get');

  // HTTP/2 client — http2.connect() opens a session over its own socket path,
  // so it must be denied independently of http/https.
  (http2 as unknown as { connect: unknown }).connect = deny('http2.connect');

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
