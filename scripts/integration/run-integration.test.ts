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
import { readFileSync } from 'node:fs';

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

// ---------------------------------------------------------------------------
// compose.yaml <-> images.mjs digest parity (disp. P2-FINAL-HIGH-001).
//
// The review flagged compose.yaml pinning postgres/minio by MUTABLE TAG while
// the gate pinned by digest. Both are now digest-pinned, and this test keeps
// them byte-identical forever: `pnpm infra:up` (developer) and the integration
// gate (CI) must provision the SAME immutable backend build, or the suites are
// proven against something other than what a developer runs. Re-pointing one
// without the other turns this RED.
// ---------------------------------------------------------------------------

test('compose.yaml pins postgres + minio BY DIGEST (no mutable tag)', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
  const pg = images.filter((i) => i.startsWith('postgres'));
  const minio = images.filter((i) => i.startsWith('minio/minio'));
  assert.ok(pg.length >= 1, 'compose declares a postgres image');
  assert.ok(minio.length >= 1, 'compose declares a minio image');
  for (const ref of [...pg, ...minio]) {
    assert.match(ref, DIGEST_PINNED, `compose image '${ref}' must be @sha256-pinned, not a tag`);
  }
});

test('compose.yaml digests are IDENTICAL to the integration gate images', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
  assert.ok(
    images.includes(IMAGES.postgres),
    `compose postgres digest must equal the gate's (${IMAGES.postgres})`,
  );
  assert.ok(
    images.includes(IMAGES.minio),
    `compose minio digest must equal the gate's (${IMAGES.minio})`,
  );
});

test('compose.yaml health-checks BOTH postgres and minio (gate can wait, not race)', () => {
  const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
  // Split into top-level service blocks and assert each of the two backends the
  // integration gate depends on declares its own healthcheck.
  const serviceBlock = (name: string): string => {
    const start = compose.indexOf(`\n  ${name}:`);
    assert.notEqual(start, -1, `compose declares a '${name}' service`);
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n {2}\w[\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  for (const svc of ['postgres', 'minio']) {
    assert.match(
      serviceBlock(svc),
      /healthcheck:/,
      `service '${svc}' must declare a healthcheck so readiness is waited on`,
    );
  }
});

// ---------------------------------------------------------------------------
// The end-to-end fail-closed proof is REGISTERED as a required integration
// suite. HIGH-001's core demand ("a deliberately-unavailable backend turns the
// required job RED") is proven by gate-fail-closed.itest.ts spawning the real
// CLI; if that suite were dropped or renamed, the gate must go RED rather than
// quietly lose its own negative proof.
// ---------------------------------------------------------------------------

test('the e2e fail-closed suite is a REQUIRED integration suite', () => {
  assert.equal(
    REQUIRED_ITEST_SUITES['asep-suite:gate-fail-closed'],
    'scripts/integration/gate-fail-closed.itest.ts',
  );
  // And a run that never printed its marker is reported missing (→ RED).
  const missing = missingRequiredItestSuites('');
  assert.ok(
    missing.some((m: { id: string }) => m.id === 'asep-suite:gate-fail-closed'),
    'a dropped fail-closed suite turns the gate RED',
  );
});

// ---------------------------------------------------------------------------
// CI wiring fitness (disp. P2-FINAL-HIGH-001).
//
// The review's HIGH-001 was precisely that CI ran only `verify:all` — a shallow
// gate that never provisioned a backend — so real-backend claims were green by
// absence. A deep integration job now exists; these tests keep it MANDATORY.
// Deleting the job, gating it behind `if:`, or marking it continue-on-error
// would restore the exact defect, so each of those turns this suite RED.
// ---------------------------------------------------------------------------

const ciWorkflow = (): string =>
  readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

// The `integration:` job block, i.e. from its key to the next top-level job key.
function integrationJobBlock(): string {
  const ci = ciWorkflow();
  const start = ci.indexOf('\n  integration:');
  assert.notEqual(start, -1, 'CI must declare a top-level `integration:` job');
  const rest = ci.slice(start + 1);
  const next = rest.search(/\n {2}\w[\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('CI declares a required integration job that runs the deep gate', () => {
  const block = integrationJobBlock();
  assert.match(
    block,
    /pnpm test:integration/,
    'the integration job must run the real-backend gate (pnpm test:integration)',
  );
});

test('the CI integration job is UNCONDITIONAL and cannot soft-fail', () => {
  const block = integrationJobBlock();
  // Strip comments: prose may legitimately mention these keys while explaining
  // why they are absent. Only real YAML keys matter.
  const yamlOnly = block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/^\s*continue-on-error:/m.test(yamlOnly),
    'integration must not be continue-on-error — its failure has to fail CI',
  );
  assert.ok(
    !/^\s*if:/m.test(yamlOnly),
    'integration must not be conditional — a skipped deep gate is the HIGH-001 defect',
  );
});

test('the CI integration job asserts a real Docker daemon before running suites', () => {
  const block = integrationJobBlock();
  assert.match(block, /docker version/, 'the job proves docker exists rather than skipping');
  assert.match(
    block,
    /--network none/,
    'the job proves the sandbox can run network-isolated before trusting F4',
  );
});
