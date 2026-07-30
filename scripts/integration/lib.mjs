// Integration-gate library (disp. P2-FINAL-HIGH-001). Pure-ish helpers the CLI
// (run-integration.mjs) composes and the negative-test suite
// (run-integration.test.ts) drives directly. Kept separate from the CLI so the
// fail-closed logic is unit-testable without spinning real containers.
//
// The gate's contract:
//   1. every backend image is digest-pinned (images.mjs / assertDigestPinned);
//   2. containers are started shell-free (spawnSync, argv, shell:false);
//   3. each backend is HEALTH-CHECKED with a bounded poll before any suite runs
//      — a backend that never becomes ready turns the gate RED, it is not a
//      silent skip;
//   4. the *.itest.ts suites are discovered by a Node walk (no shell glob) and
//      run in ONE child with ASEP_PG_URL / S3 env pointing at the live backends;
//   5. discovering ZERO itest files fails closed (a broken walk must not look
//      green by running nothing) — same mechanism as the unit runner;
//   6. containers are always torn down (finally), even on failure.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { assertDigestPinned } from './images.mjs';

// Roots that may hold *.itest.ts integration suites.
export const ITEST_ROOTS = ['packages', 'apps', 'workers', 'adapters', 'evals', 'scripts'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const ITEST_SUFFIX = '.itest.ts';

// Required integration suites: each maps a SUITE-ID (printed at module load) to
// its file. A dropped/renamed integration suite turns the gate RED even on a 0
// exit — the same fail-closed mechanism the unit runner uses for *.test.ts.
export const REQUIRED_ITEST_SUITES = Object.freeze({
  'asep-suite:pg-concurrency': 'adapters/persistence/src/concurrency.itest.ts',
  'asep-suite:sandbox-exec': 'adapters/command-runner/src/sandbox-exec.itest.ts',
  'asep-suite:agent-sandbox': 'adapters/agent-claude/src/agent-sandbox.itest.ts',
  // The gate's own end-to-end fail-closed proof: spawns THIS CLI with a backend
  // deliberately omitted and asserts a non-zero exit (HIGH-001's "deliberately
  // unavailable backend turns the required job RED, never skips").
  'asep-suite:gate-fail-closed': 'scripts/integration/gate-fail-closed.itest.ts',
  // K1 authoritative proof: the full governed slice on real digest-pinned
  // PostgreSQL (pg.Pool) + a real Docker sandbox. Registered required so
  // dropping or renaming the end-to-end suite turns the gate RED (disp.
  // P2-REREVIEW-MED-NEW-002).
  'asep-suite:vertical-slice-real': 'apps/control-plane-api/src/vertical-slice.itest.ts',
  // MinIO artifact-bytes proof: drives the ObjectStore contract (put/get/
  // create-only/checksum) against a REAL S3-compatible bucket, so a broken S3
  // path turns the gate RED instead of silently passing on the filesystem
  // backend (disp. P2-REREVIEW-MED-NEW-001).
  'asep-suite:object-store-s3': 'adapters/persistence/src/object-store-s3.itest.ts',
});

export const SUITE_ID_PREFIX = 'SUITE-ID:';
export function suiteMarker(id) {
  return `${SUITE_ID_PREFIX} ${id}`;
}

export function missingRequiredItestSuites(combinedOutput) {
  const missing = [];
  for (const [id, file] of Object.entries(REQUIRED_ITEST_SUITES)) {
    if (!combinedOutput.includes(suiteMarker(id))) missing.push({ id, file });
  }
  return missing;
}

// Recursive, shell-free discovery of every *.itest.ts under the roots.
export function discoverItestFiles(repoRoot) {
  const found = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (IGNORE_DIRS.has(entry)) continue;
      const full = join(absDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(ITEST_SUFFIX)) found.push(full);
    }
  };
  for (const root of ITEST_ROOTS) {
    const absRoot = join(repoRoot, root);
    if (existsSync(absRoot)) walk(absRoot);
  }
  const rel = found.map((f) => relative(repoRoot, f).split(sep).join('/'));
  return [...new Set(rel)].sort();
}

// Locate a usable docker binary. On this host /usr/local/bin/docker can be a
// dangling symlink to an unmounted volume, so we probe candidates and verify
// `docker version` actually responds.
export function resolveDocker(candidates = [
  'docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
]) {
  for (const bin of candidates) {
    const r = spawnSync(bin, ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
    });
    if (!r.error && r.status === 0 && (r.stdout ?? '').trim() !== '') {
      return { bin, serverVersion: r.stdout.trim() };
    }
  }
  return null;
}

// Bounded readiness poll. Runs `probe()` (returns true when ready) up to
// `attempts` times with `intervalMs` between tries. Returns true if it ever
// succeeds, false if it exhausts the budget — the caller turns a false RED.
export async function waitReady(probe, { attempts = 30, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Start a digest-pinned container detached, returning its id. Fails closed if
// the image is not digest-pinned or docker cannot start it.
export function runContainer(docker, { image, name, args = [], env = {}, ports = [] }) {
  assertDigestPinned(image);
  const argv = ['run', '-d', '--rm', '--name', name];
  for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
  for (const p of ports) argv.push('-p', p);
  argv.push(image, ...args);
  const r = spawnSync(docker, argv, { encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0) {
    throw new Error(
      `failed to start container ${name} (${image}): ${r.error?.message ?? r.stderr ?? 'unknown'}`,
    );
  }
  return (r.stdout ?? '').trim();
}

export function removeContainer(docker, name) {
  // -f so a still-running container is force-removed; ignore errors on teardown.
  spawnSync(docker, ['rm', '-f', name], { encoding: 'utf8', shell: false });
}
