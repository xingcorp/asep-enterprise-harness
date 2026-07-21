import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import { enforceDeterminism, NetworkDeniedError, EVAL_SEED, stableCompare } from './env.js';
import { loadTasks, runEval, gradeTasks, stableStringify } from './run.js';

// P1-FINAL-MED-002: prove the determinism harness has teeth.
//
// (1) Network default-deny is a CANARY: after enforceDeterminism(), every egress
//     path a grader (or a transitive dependency) could use must throw. A test
//     that merely asserts "we set dns.lookup" would be circular; instead we call
//     each entry point and assert it throws NetworkDeniedError.
// (2) Discovery order-independence: the runner sorts tasks by id, so the report
//     must be byte-identical regardless of the order fixtures are discovered in.

test('enforceDeterminism is idempotent and pins locale/timezone', () => {
  enforceDeterminism();
  enforceDeterminism();
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(process.env.LC_ALL, 'C');
});

test('network canary: the full DNS resolver surface is denied', () => {
  enforceDeterminism();
  // Not just lookup/resolve: every record-type resolver, reverse, and the
  // promises API must be blocked. A grader reaching for dns.resolveTxt() or
  // dns.reverse() has to fail exactly as loudly as one calling dns.lookup().
  const methods = [
    'lookup',
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
  for (const m of methods) {
    assert.throws(
      () => (dns as unknown as Record<string, () => void>)[m]!(),
      NetworkDeniedError,
      `dns.${m} must be denied`,
    );
    assert.throws(
      () => (dns.promises as unknown as Record<string, () => void>)[m]!(),
      NetworkDeniedError,
      `dns.promises.${m} must be denied`,
    );
  }
});

test('network canary: raw TCP/TLS sockets are denied', () => {
  enforceDeterminism();
  assert.throws(() => (net as unknown as { connect: () => void }).connect(), NetworkDeniedError);
  assert.throws(
    () => (net as unknown as { createConnection: () => void }).createConnection(),
    NetworkDeniedError,
  );
  assert.throws(() => (tls as unknown as { connect: () => void }).connect(), NetworkDeniedError);
});

test('network canary: UDP datagram sockets are denied', () => {
  enforceDeterminism();
  assert.throws(
    () => (dgram as unknown as { createSocket: () => void }).createSocket(),
    NetworkDeniedError,
  );
});

test('network canary: HTTP/2 client is denied', () => {
  enforceDeterminism();
  assert.throws(
    () => (http2 as unknown as { connect: () => void }).connect(),
    NetworkDeniedError,
  );
});

test('network canary: http/https client requests are denied', () => {
  enforceDeterminism();
  assert.throws(() => (http as unknown as { request: () => void }).request(), NetworkDeniedError);
  assert.throws(() => (http as unknown as { get: () => void }).get(), NetworkDeniedError);
  assert.throws(() => (https as unknown as { request: () => void }).request(), NetworkDeniedError);
  assert.throws(() => (https as unknown as { get: () => void }).get(), NetworkDeniedError);
});

test('network canary: global fetch is denied', async () => {
  enforceDeterminism();
  await assert.rejects(
    async () => (globalThis as { fetch: (u: string) => Promise<unknown> }).fetch('http://example.com'),
    NetworkDeniedError,
  );
});

// Seeded deterministic shuffle (Fisher–Yates over a small LCG). Same seed ->
// same permutation, so this test stays byte-reproducible while still feeding
// gradeTasks a genuinely reordered list.
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    // Numerical Recipes LCG constants.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test('discovery is order-independent: a genuinely shuffled task list yields the sorted report', () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 2, 'need at least two tasks to prove order-independence');

  const shuffled = seededShuffle(tasks, EVAL_SEED);
  // Sanity: the shuffle must actually change the order, otherwise the test is
  // vacuous. (With >=9 fixtures the LCG permutation is not the identity.)
  const beforeIds = tasks.map((t) => t.id);
  const shuffledIds = shuffled.map((t) => t.id);
  assert.notDeepEqual(shuffledIds, beforeIds, 'seededShuffle must reorder the tasks');

  // Grading the shuffled list must produce the SAME report as grading the
  // canonical (sorted) list — proving the report is a pure function of the set
  // of tasks, not their discovery order.
  const fromShuffled = stableStringify(gradeTasks(shuffled));
  const fromSorted = stableStringify(gradeTasks(tasks));
  assert.equal(fromShuffled, fromSorted);

  // And the result ids come out in sorted order regardless of input order.
  const resultIds = gradeTasks(shuffled).results.map((r) => r.id);
  assert.deepEqual(resultIds, [...resultIds].sort(stableCompare));
});

test('runEval remains byte-identical across repeated runs (D2)', () => {
  const a = stableStringify(runEval());
  const b = stableStringify(runEval());
  assert.equal(a, b);
});
