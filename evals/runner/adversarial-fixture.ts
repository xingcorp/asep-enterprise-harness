// Honest adversarial egress fixture BODY (P1-CYCLE4-MED-002).
//
// This module holds the actual hostile-grader behaviour: ESM named-import
// captures at module top level, CJS require captures, constructor egress, a
// microtask-deferred reference, dynamic re-import, global fetch, and
// process/thread escape. It is DYNAMICALLY IMPORTED by adversarial-entry.ts
// ONLY AFTER that entry has asserted the determinism preload ran.
//
// Splitting the sentinel + the top-level captures into this separately-imported
// module is the containment invariant made testable: because the entry
// dynamic-imports this file only post-attestation, a launch that omitted the
// preload fails closed in the entry BEFORE this module is ever evaluated — so
// the SENTINEL below never prints and no capture side-effect occurs. The
// bootstrap-order regression test asserts exactly that absence.
//
// This fixture is HONEST: it weakens no guard, it does not (and cannot, under
// the canonical launch) capture a reference before the preload, and it reports
// blocked/allowed truthfully.

// SENTINEL: printed the instant this module body starts evaluating. Under an
// omit-preload launch the entry must fail before importing this module, so this
// line must be ABSENT from that run's output.
export const SENTINEL = 'ADVERSARIAL-FIXTURE-BODY-EVALUATED';
process.stderr.write(`${SENTINEL}\n`);

// ESM NAMED imports captured at module top level — the exact cycle-4 bypass
// shape. Because this module is evaluated post-preload and the preload ran
// syncBuiltinESMExports(), each of these bindings already resolves to a deny
// stub at capture time.
import { createSocket as namedCreateSocket } from 'node:dgram';
import { connect as namedNetConnect, Socket as NamedNetSocket } from 'node:net';
import { request as namedHttpRequest } from 'node:http';
import { createRequire } from 'node:module';
import dns from 'node:dns';
import net from 'node:net';
import { isDeterminismEnforced } from './env.js';

const require = createRequire(import.meta.url);

export interface Probe {
  readonly name: string;
  readonly blocked: boolean;
  readonly detail: string;
}

export interface AdversarialVerdict {
  readonly enforcedAtEval: boolean;
  readonly allAttemptsBlocked: boolean;
  readonly probes: readonly Probe[];
}

/**
 * Run every egress probe and return an honest verdict. A probe is BLOCKED when
 * the attempt throws (sync) or rejects (async) — the desired outcome; ALLOWED
 * when it completes without error — a containment hole.
 */
export async function runAdversarialProbes(): Promise<AdversarialVerdict> {
  const probes: Probe[] = [];

  const probe = (name: string, fn: () => unknown): void => {
    try {
      const r = fn();
      probes.push({ name, blocked: false, detail: `no throw (returned ${typeof r})` });
    } catch (e) {
      probes.push({ name, blocked: true, detail: e instanceof Error ? e.name : String(e) });
    }
  };

  // (a) ESM NAMED dgram.createSocket — capture at top level, invoke now.
  probe('esm-named:dgram.createSocket', () => {
    const sock = namedCreateSocket('udp4');
    (sock as unknown as { bind: (p: number) => void }).bind(0);
    return sock;
  });

  // (b) ESM NAMED net.connect.
  probe('esm-named:net.connect', () => namedNetConnect(80, '1.1.1.1'));

  // (c) ESM NAMED net.Socket constructor egress.
  probe('esm-named:new net.Socket().connect', () => {
    const s = new NamedNetSocket();
    return (s as unknown as { connect: (p: number, h: string) => void }).connect(80, '1.1.1.1');
  });

  // (d) ESM NAMED http.request.
  probe('esm-named:http.request', () => namedHttpRequest('http://1.1.1.1/'));

  // (e) CJS/default require() dgram then createSocket.
  probe('cjs:require(dgram).createSocket', () => {
    const d = require('node:dgram') as { createSocket: (t: string) => unknown };
    const sock = d.createSocket('udp4');
    (sock as { bind: (p: number) => void }).bind(0);
    return sock;
  });

  // (f) CJS/default require() net.connect.
  probe('cjs:require(net).connect', () => {
    const n = require('node:net') as { connect: (p: number, h: string) => void };
    return n.connect(80, '1.1.1.1');
  });

  // (g) Constructor egress via new dns.Resolver().resolve4.
  probe('ctor:new dns.Resolver().resolve4', () => {
    const r = new dns.Resolver();
    return (r as unknown as { resolve4: (h: string) => void }).resolve4('example.com');
  });

  // (h) Constructor egress via new net.Socket().connect (default import).
  probe('ctor:new net.Socket().connect', () => {
    const s = new net.Socket();
    return (s as unknown as { connect: (p: number, h: string) => void }).connect(80, '1.1.1.1');
  });

  // (i) http/https/http2 default requests.
  probe('default:http.request', () => {
    const h = require('node:http') as { request: (u: string) => void };
    return h.request('http://1.1.1.1/');
  });
  probe('default:https.request', () => {
    const h = require('node:https') as { request: (u: string) => void };
    return h.request('https://1.1.1.1/');
  });
  probe('default:http2.connect', () => {
    const h2 = require('node:http2') as { connect: (u: string) => void };
    return h2.connect('https://1.1.1.1');
  });

  // (j) Process / thread escape — a fresh unguarded context would defeat the
  // whole guard, so these must throw too.
  probe('escape:child_process.spawn', () => {
    const cp = require('node:child_process') as { spawn: (c: string) => void };
    return cp.spawn('curl');
  });
  probe('escape:worker_threads.Worker', () => {
    const wt = require('node:worker_threads') as { Worker: new (s: string) => unknown };
    return new wt.Worker('data:text/javascript,');
  });

  // (k) DNS default lookup.
  probe('default:dns.lookup', () => {
    (dns as unknown as { lookup: (h: string, cb: () => void) => void }).lookup('example.com', () => {});
  });

  // (l) global fetch — captured now, awaited. Must reject with the deny error.
  if (typeof (globalThis as { fetch?: unknown }).fetch !== 'undefined') {
    const f = (globalThis as { fetch: (u: string) => Promise<unknown> }).fetch;
    try {
      await f('http://1.1.1.1/');
      probes.push({ name: 'global.fetch', blocked: false, detail: 'no throw' });
    } catch (e) {
      probes.push({ name: 'global.fetch', blocked: true, detail: e instanceof Error ? e.name : String(e) });
    }
  }

  // (m) Reference captured into a closure and fired from a microtask — proves
  // the deny is not merely a synchronous-call artifact.
  const deferredFactory = namedCreateSocket;
  await Promise.resolve().then(() => {
    try {
      const sock = deferredFactory('udp4');
      (sock as unknown as { bind: (p: number) => void }).bind(0);
      probes.push({ name: 'microtask:deferred dgram', blocked: false, detail: 'no throw' });
    } catch (e) {
      probes.push({ name: 'microtask:deferred dgram', blocked: true, detail: e instanceof Error ? e.name : String(e) });
    }
  });

  // (n) Dynamic re-import of a builtin AFTER enforcement — the named binding of
  // a fresh import must also be the deny stub.
  try {
    const freshDgram = (await import('node:dgram')) as unknown as {
      createSocket: (t: string) => unknown;
    };
    const sock = freshDgram.createSocket('udp4');
    (sock as { bind: (p: number) => void }).bind(0);
    probes.push({ name: 'dynamic-import:dgram.createSocket', blocked: false, detail: 'no throw' });
  } catch (e) {
    probes.push({ name: 'dynamic-import:dgram.createSocket', blocked: true, detail: e instanceof Error ? e.name : String(e) });
  }

  return {
    enforcedAtEval: isDeterminismEnforced(),
    allAttemptsBlocked: probes.every((p) => p.blocked),
    probes,
  };
}
