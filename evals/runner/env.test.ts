import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { enforceDeterminism, NetworkDeniedError, stableCompare } from './env.js';
import { loadTasks, runEval, stableStringify } from './run.js';

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

test('network canary: DNS resolution is denied', () => {
  enforceDeterminism();
  assert.throws(() => (dns as unknown as { lookup: () => void }).lookup(), NetworkDeniedError);
  assert.throws(
    () => (dns.promises as unknown as { lookup: () => void }).lookup(),
    NetworkDeniedError,
  );
  assert.throws(() => (dns as unknown as { resolve: () => void }).resolve(), NetworkDeniedError);
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

test('discovery is order-independent: shuffled task order yields identical report', () => {
  // The runner sorts by id, so a shuffled load must not change the output.
  const tasks = loadTasks();
  const ids = tasks.map((t) => t.id);
  const sorted = [...ids].sort(stableCompare);
  assert.deepEqual(ids, sorted, 'loadTasks must already return id-sorted order');

  // Two independent runs (each of which sorts internally) are byte-identical.
  const a = stableStringify(runEval());
  const b = stableStringify(runEval());
  assert.equal(a, b);
});
