// Integration-gate negative tests (disp. P2-FINAL-HIGH-001). These prove the
// gate's FAIL-CLOSED contract WITHOUT provisioning containers, so they run under
// the fast `pnpm test` unit runner. The point HIGH-001 demands: the gate must go
// RED — never silently green — when a backend is absent, an image is not
// digest-pinned, discovery finds nothing, or a required suite marker is missing.
//
// The live-backend proof itself is the *.itest.ts suites under the integration
// gate; here we exercise the pure fail-closed logic the gate composes.

import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { assertDigestPinned, DIGEST_PINNED, IMAGES } from './images.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { discoverItestFiles, missingRequiredItestSuites, REQUIRED_ITEST_SUITES, suiteMarker, resolveDocker, waitReady } from './lib.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

console.log('SUITE-ID: asep-suite:integration-gate');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// ---------------------------------------------------------------------------
// Digest-pinning: a mutable tag must be rejected before any container starts.
// ---------------------------------------------------------------------------

test('every configured backend image is digest-pinned', () => {
  for (const [name, ref] of Object.entries(IMAGES) as [string, string][]) {
    assert.match(ref, DIGEST_PINNED, `${name} image must be @sha256-pinned`);
  }
});

test('assertDigestPinned REJECTS a mutable tag (fail closed before provisioning)', () => {
  assert.throws(() => assertDigestPinned('postgres:17'), /not digest-pinned/);
  assert.throws(() => assertDigestPinned('minio/minio:latest'), /not digest-pinned/);
  assert.throws(() => assertDigestPinned('postgres@sha256:tooshort'), /not digest-pinned/);
});

test('assertDigestPinned ACCEPTS a proper @sha256 digest', () => {
  const ok = `postgres@sha256:${'a'.repeat(64)}`;
  assert.equal(assertDigestPinned(ok), ok);
});

// ---------------------------------------------------------------------------
// Discovery: the real concurrency itest is found; a broken root finds nothing.
// ---------------------------------------------------------------------------

test('itest discovery finds the real *.itest.ts suites', () => {
  const files = discoverItestFiles(REPO_ROOT);
  assert.ok(files.length > 0, 'at least one itest suite exists');
  assert.ok(
    files.includes('adapters/persistence/src/concurrency.itest.ts'),
    'the multi-connection concurrency itest must be discovered',
  );
});

test('itest discovery returns EMPTY for a root with no itest files (gate fails closed on this)', () => {
  // Pointed at a directory with no *.itest.ts, discovery yields [] — the CLI
  // turns that into a RED gate rather than "success by running nothing".
  const files = discoverItestFiles(join(REPO_ROOT, 'docs'));
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// Required-suite verification: a missing SUITE-ID marker turns the gate RED.
// ---------------------------------------------------------------------------

test('required-itest verification reports NOTHING missing when every marker present', () => {
  const output = Object.keys(REQUIRED_ITEST_SUITES).map(suiteMarker).join('\n');
  assert.deepEqual(missingRequiredItestSuites(output), []);
});

test('required-itest verification FAILS CLOSED when a marker is absent', () => {
  const missing = missingRequiredItestSuites('no markers here at all');
  assert.ok(missing.length >= 1, 'a missing required suite is reported');
  assert.ok(
    missing.some((m: { id: string }) => m.id === 'asep-suite:pg-concurrency'),
    'the concurrency suite is flagged when its marker never appeared',
  );
});

// ---------------------------------------------------------------------------
// Health-check budget: waitReady returns false when the probe never succeeds,
// which the CLI converts into a RED gate ("backend never became healthy").
// ---------------------------------------------------------------------------

test('waitReady returns false when the probe never succeeds (dead-backend → RED)', async () => {
  const ok = await waitReady(() => false, { attempts: 3, intervalMs: 1 });
  assert.equal(ok, false);
});

test('waitReady returns true as soon as the probe succeeds', async () => {
  let n = 0;
  const ok = await waitReady(() => { n += 1; return n >= 2; }, { attempts: 5, intervalMs: 1 });
  assert.equal(ok, true);
});

test('waitReady treats a throwing probe as not-ready (never leaks the error)', async () => {
  const ok = await waitReady(() => { throw new Error('connection refused'); }, { attempts: 2, intervalMs: 1 });
  assert.equal(ok, false);
});

// ---------------------------------------------------------------------------
// resolveDocker: an all-bogus candidate list resolves to null (→ RED), never a
// false positive.
// ---------------------------------------------------------------------------

test('resolveDocker returns null when no candidate binary responds (→ gate RED)', () => {
  const r = resolveDocker(['/nonexistent/docker-xyz', '/also/not/here']);
  assert.equal(r, null);
});
