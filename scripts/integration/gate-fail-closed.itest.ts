// End-to-end fail-closed proof for the integration gate (disp. P2-FINAL-HIGH-001).
//
// The unit suite (run-integration.test.ts) proves the gate's PURE logic —
// digest-pinning, discovery, marker verification, readiness budget. It cannot
// prove the thing HIGH-001 actually demands, which is a claim about the GATE
// PROCESS itself:
//
//     "deliberately-unavailable PG / object-store / Docker turns the required
//      job RED — it does not skip."
//
// That is a statement about an exit code, so this suite ASSERTS ON EXIT CODES by
// spawning the real gate CLI (scripts/integration/run-integration.mjs) three
// times with a backend deliberately removed, via the injection hooks documented
// in that file. Each run must exit NON-ZERO and say WHY. A regression that made
// the gate skip-on-missing-backend (the "skip trá hình" failure mode) would make
// these runs exit 0 and turn this suite RED.
//
// It lives under the integration gate itself (*.itest.ts) because it needs a
// real docker binary to reach the health-check stage for the PG/MinIO cases: with
// no docker at all every case would collapse into the same "no docker" branch and
// prove nothing about backend health. The nested runs use `ASEP_ITEST_OMIT_BACKEND`
// so no container is ever started for the omitted service, and a tiny
// `ASEP_ITEST_HEALTH_ATTEMPTS` budget so the negative path fails in ~2s instead
// of 40s.
//
// The nested gate runs are given DISTINCT ports so they can never collide with
// the outer gate's live containers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

console.log('SUITE-ID: asep-suite:gate-fail-closed');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const GATE = join(HERE, 'run-integration.mjs');

interface GateRun {
  readonly status: number | null;
  readonly out: string;
}

// Run the REAL gate CLI in a child process with injected absence. shell:false,
// argv only. Returns the exit status + combined output.
function runGate(env: Record<string, string>): GateRun {
  const r = spawnSync(process.execPath, [GATE], {
    cwd: REPO_ROOT,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // Fast failure for the negative paths: 2 attempts x 1s, not 40.
      ASEP_ITEST_HEALTH_ATTEMPTS: '2',
      // Ports distinct from the outer gate's live containers (55440 / 59000).
      ASEP_ITEST_PG_PORT: '55441',
      ASEP_ITEST_MINIO_PORT: '59001',
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// Docker absent → RED. The gate must refuse to run at all, not skip.
// ---------------------------------------------------------------------------

test('HIGH-001 e2e: NO DOCKER makes the required gate exit NON-ZERO (never skip)', () => {
  const run = runGate({ ASEP_ITEST_DOCKER_BIN: '/nonexistent/docker-absent-xyz' });
  assert.notEqual(run.status, 0, `gate must fail when docker is absent; output:\n${run.out}`);
  assert.match(run.out, /no working docker binary found/,
    'the gate says WHY it failed (docker unavailable)');
  assert.match(run.out, /refuses to skip/, 'the gate explicitly refuses to skip');
  // A skip would look like a pass; prove no PASS banner was printed.
  assert.ok(!/integration-gate: PASS/.test(run.out), 'no PASS banner on a missing backend');
});

// ---------------------------------------------------------------------------
// PostgreSQL absent → RED at the health check.
// ---------------------------------------------------------------------------

test('HIGH-001 e2e: a MISSING PostgreSQL makes the required gate exit NON-ZERO', () => {
  const run = runGate({ ASEP_ITEST_OMIT_BACKEND: 'postgres' });
  assert.notEqual(run.status, 0, `gate must fail when PG is absent; output:\n${run.out}`);
  assert.match(run.out, /PostgreSQL never became healthy/,
    'the gate fails on the PG health check rather than proceeding');
  assert.ok(!/integration-gate: PASS/.test(run.out), 'no PASS banner without PostgreSQL');
  // Teardown still ran, so a failed gate leaves no containers behind.
  assert.match(run.out, /containers torn down/, 'containers are torn down even on failure');
});

// ---------------------------------------------------------------------------
// Object store (MinIO) absent → RED at the health check.
// ---------------------------------------------------------------------------

test('HIGH-001 e2e: a MISSING object store (MinIO) makes the required gate exit NON-ZERO', () => {
  const run = runGate({ ASEP_ITEST_OMIT_BACKEND: 'minio' });
  assert.notEqual(run.status, 0, `gate must fail when MinIO is absent; output:\n${run.out}`);
  assert.match(run.out, /MinIO never became healthy/,
    'the gate fails on the MinIO health check rather than proceeding');
  assert.ok(!/integration-gate: PASS/.test(run.out), 'no PASS banner without the object store');
  assert.match(run.out, /containers torn down/, 'containers are torn down even on failure');
});
