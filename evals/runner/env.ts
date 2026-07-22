// Deterministic execution environment for the eval runner (Codex P1-OPT-002,
// hardened per P1-FINAL-MED-002 / P1-CYCLE4-MED-002).
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
//   - process/thread escape (child_process.*, worker_threads.Worker) is denied
//     so a grader cannot spawn a fresh, UNGUARDED execution context.
//
// THREAT MODEL (precise — do not overstate):
//   Phase 1 guarantees that code loaded through the canonical evaluation
//   launcher cannot capture unguarded supported Node networking references
//   before the determinism preload, because the preload runs before task/grader
//   module evaluation. This mechanism is a DETERMINISTIC EXECUTION GUARD and a
//   defense against ACCIDENTAL egress. It is NOT a security boundary against
//   arbitrary hostile in-process native/runtime code (a native addon, a raw
//   syscall via FFI/WASI, or a V8 internals abuse can bypass any in-process
//   monkey-patch). Phase 2 MUST enforce network denial OUTSIDE the evaluated
//   process — network namespace, seccomp, gVisor, microVM, or equivalent OS-level
//   sandbox. See docs/architecture/adr/0016-phase-one-trusted-bootstrap.md.
//
// WHY A PRELOAD (not just an import at the top of run.ts): a fixture/grader
// module can execute code at its own top level (import side effects) and CAPTURE
// a builtin reference before run.ts's import of this module runs. Enforcing via
// `node --import <determinism-preload>` makes enforceDeterminism() the FIRST
// application-level action in the process, before ANY task/grader module is
// evaluated, and syncBuiltinESMExports() (below) makes even ESM named-import
// bindings resolve to the deny stubs. The worker-entry additionally calls
// assertDeterminismEnforced() before dynamic-importing task code, so a launch
// that skipped the preload fails closed before untrusted modules load.

import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import child_process from 'node:child_process';
import worker_threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

export const EVAL_SEED = 0x5eed_1234;
export const EVAL_TIMEZONE = 'UTC';
export const EVAL_LOCALE = 'en-US';

export class NetworkDeniedError extends Error {
  constructor(via: string) {
    super(`eval-runner: network access is denied in deterministic mode (via ${via})`);
    this.name = 'NetworkDeniedError';
  }
}

/**
 * A process-spawn / thread-spawn escape is denied for the same reason network
 * is: a deterministic eval must not fork a NEW process or worker thread, because
 * a child launched WITHOUT the determinism preload would run entirely outside
 * this guard (its network surface unpatched) — a determinism AND containment
 * hole. Denied loudly rather than silently.
 */
export class ProcessEscapeError extends Error {
  constructor(via: string) {
    super(`eval-runner: process/thread creation is denied in deterministic mode (via ${via})`);
    this.name = 'ProcessEscapeError';
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

  // ---- PROCESS / THREAD ESCAPE DENY -----------------------------------------
  //
  // Network poisoning is moot if a grader can spawn a fresh process (or worker
  // thread) that runs WITHOUT this preload: the child's network surface would be
  // pristine. Within the declared determinism contract a deterministic eval must
  // not fork new execution contexts at all, so we deny the spawn surface. These
  // throw ProcessEscapeError (a distinct class) so evidence can tell a spawn
  // attempt apart from a direct network attempt.
  const denyProc = (via: string) => (): never => {
    throw new ProcessEscapeError(via);
  };
  for (const m of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    (child_process as unknown as Record<string, unknown>)[m] = denyProc(`child_process.${m}`);
  }
  // worker_threads.Worker constructor: replace with a throwing shim.
  (worker_threads as unknown as { Worker: unknown }).Worker = class {
    constructor() {
      throw new ProcessEscapeError('worker_threads.Worker');
    }
  };

  // ---- ESM NAMED-EXPORT SYNC (P1-CYCLE4-MED-002) ----------------------------
  //
  // All the assignments above mutate the CJS/default export objects and the
  // prototypes. But a module that did `import { createSocket } from 'node:dgram'`
  // holds a LIVE BINDING to the ORIGINAL factory captured when the builtin's ESM
  // facade was first evaluated — mutating the default export object does NOT
  // update that named binding. Codex's surviving cycle-4 bypass was exactly this:
  // the named `createSocket` still built a live socket. syncBuiltinESMExports()
  // rebuilds every builtin's ESM named exports from the (now-patched) CJS export
  // objects, so `import { createSocket }` and `import { connect }` resolve to the
  // deny stubs too. This must run AFTER every factory swap above.
  syncBuiltinESMExports();

  enforced = true;
}

/**
 * Attestation that the determinism preload has run in THIS process. The trusted
 * launcher runs enforceDeterminism() via `node --import <preload>` as the first
 * application action, BEFORE any task/grader module is evaluated. The
 * worker-entry checks this attestation and refuses to load task code if it is
 * absent — so a worker launched WITHOUT the preload fails closed before any
 * fixture (which may capture references at module top level) can be evaluated.
 */
export function isDeterminismEnforced(): boolean {
  return enforced;
}

/**
 * Fail-closed guard the worker-entry calls before dynamic-importing any task or
 * grader module. Throws if the preload did not run, so untrusted module code
 * never evaluates in an unguarded process.
 */
export function assertDeterminismEnforced(): void {
  if (!enforced) {
    throw new Error(
      'eval-runner: determinism preload did NOT run before task load — refusing to ' +
        'evaluate task/grader modules in an unguarded process (P1-CYCLE4-MED-002). ' +
        'The evaluation MUST be launched via the canonical launcher ' +
        '(node --import <determinism-preload> <worker-entry>).',
    );
  }
}

/** Stable string compare used everywhere the runner sorts, independent of locale. */
export function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
