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
// real docker binary to reach the health-check stage for the PG/S3 cases: with
// no docker at all every case would collapse into the same "no docker" branch and
// prove nothing about backend health. The nested runs use `ASEP_ITEST_OMIT_BACKEND`
// so no container is ever started for the omitted service, and a tiny
// `ASEP_ITEST_HEALTH_ATTEMPTS` budget so the negative path fails in ~2s instead
// of 40s.
//
// The nested gate runs are given DISTINCT ports so they can never collide with
// the outer gate's live containers.
//
// BUDGETS ARE ASYMMETRIC ON PURPOSE. Each negative case must fail at the health
// check for the backend it claims to be about, which means every OTHER backend it
// starts has to be given a realistic budget to come up. A single global
// 2-attempt budget made the "object store missing" case die on the cold-start
// PostgreSQL check instead — exit code still non-zero, so the weak form of the
// assertion passed while proving nothing whatsoever about the object store.
// Each case below therefore shrinks ONLY the budget of the backend it omits,
// and asserts on the specific health-check message, so a case that stops
// failing for its stated reason turns RED instead of passing for the wrong one.

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
      // Default: fast failure for the negative paths (2 attempts x 1s, not 40).
      // Individual cases override the PER-BACKEND budgets so that the backend a
      // case genuinely expects to come up gets a realistic window.
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
  // PG is the FIRST health check, so a tiny budget is enough to reach it. Proof
  // the run got past docker resolution is asserted below.
  const run = runGate({
    ASEP_ITEST_OMIT_BACKEND: 'postgres',
    ASEP_ITEST_PG_HEALTH_ATTEMPTS: '2',
  });
  assert.notEqual(run.status, 0, `gate must fail when PG is absent; output:\n${run.out}`);
  // The run genuinely reached the provisioning stage (docker resolved, suites
  // discovered) rather than dying earlier for an unrelated reason.
  assert.match(run.out, /itest suite\(s\) discovered/,
    'the run got past docker resolution and discovery');
  assert.match(run.out, /PostgreSQL never became healthy/,
    'the gate fails on the PG health check rather than proceeding');
  assert.ok(!/integration-gate: PASS/.test(run.out), 'no PASS banner without PostgreSQL');
  // Teardown still ran, so a failed gate leaves no containers behind.
  assert.match(run.out, /containers torn down/, 'containers are torn down even on failure');
});

// ---------------------------------------------------------------------------
// Object store absent → RED at the health check.
// ---------------------------------------------------------------------------

test('HIGH-001 e2e: a MISSING object store makes the required gate exit NON-ZERO', () => {
  // This case starts a REAL PostgreSQL and omits only the object store, so PG
  // must be given a full cold-start budget: the whole point is to get PAST the
  // PG health check and fail at the object store's. Its own budget stays tiny
  // so the run is quick.
  const run = runGate({
    ASEP_ITEST_OMIT_BACKEND: 'minio',
    ASEP_ITEST_PG_HEALTH_ATTEMPTS: '40',
    ASEP_ITEST_MINIO_HEALTH_ATTEMPTS: '2',
  });
  assert.notEqual(run.status, 0, `gate must fail when the object store is absent; output:\n${run.out}`);
  // Proof the run genuinely REACHED the object-store check: PostgreSQL came up
  // healthy first. Without this, a failure anywhere earlier would satisfy the
  // exit-code assertion while proving nothing about the object store.
  assert.match(run.out, /PostgreSQL healthy/,
    'the run got past PG, so the failure below is genuinely about the object store');
  assert.match(run.out, /the object store never became healthy/,
    'the gate fails on the object-store health check rather than proceeding');
  assert.ok(!/integration-gate: PASS/.test(run.out), 'no PASS banner without the object store');
  assert.match(run.out, /containers torn down/, 'containers are torn down even on failure');
});
