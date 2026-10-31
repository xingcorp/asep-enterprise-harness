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
//   6. containers are always torn down (finally), even on failure;
//   7. every published port binds 127.0.0.1 only (assertLoopbackPublish).

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
  // Crash recovery on real PostgreSQL: an executor child is SIGKILLed the moment
  // its push (or PR) lands; the successor is denied while the dead lease is
  // live, takes the unfinished record over once it expired, and converges on
  // one commit, one remote ref and one PR while the dead lease stays refused.
  'asep-suite:crash-takeover-real': 'apps/control-plane-api/src/crash-takeover.itest.ts',
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

// The agent network's isolated gateway mode (claude-provider's agent network),
// which the containment suite relies on, needs Docker Engine 28.0.0 or later.
export const MIN_DOCKER_ENGINE = '28.0.0';

// Why the engine `version` cannot run the suites, or undefined when it can. An
// older engine, or a version that cannot be read, fails the gate by name rather
// than a suite part way through.
export function engineVersionGap(version, min = MIN_DOCKER_ENGINE) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim())?.slice(1).map(Number);
  const have = parse(version);
  const want = parse(min);
  if (!have) return `cannot read the Docker Engine version ${JSON.stringify(version)}`;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] > want[i]) return undefined;
    if (have[i] < want[i]) {
      return `Docker Engine ${version} is older than ${min}, which the agent network's isolated gateway mode needs`;
    }
  }
  return undefined;
}

// Builds the workspace the itests import: `tsc -b` over the root's project
// references. Each workspace package's `main` is its dist/, so a checkout never
// built has nothing to import, and one built before its last change would be
// tested as it was; `tsc -b` brings every out-of-date project up to date and
// leaves an up-to-date one alone. Returns why the build failed, or undefined.
// A compiler that cannot run, or a build that exits non-zero (tsc still emits
// on a type error), is a failure: no suite runs against output the source does
// not match.
export function buildWorkspace(repoRoot, tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')) {
  const r = spawnSync(process.execPath, [tsc, '-b', repoRoot], {
    cwd: repoRoot, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return `the workspace build failed (could not run ${tsc}: ${r.error.message})`;
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return `the workspace build failed (tsc -b, exit ${r.status ?? r.signal}):\n${out.slice(-4000)}`;
  }
  return undefined;
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

// The only host address a gate backend may be published on. A bare
// `-p 5432:5432` binds every host interface, so a throwaway database with a
// well-known password would be reachable from the network for the whole run.
export const LOOPBACK_HOST = '127.0.0.1';
const PORT = '([1-9][0-9]{0,4})';
const LOOPBACK_PUBLISH = new RegExp(`^127\\.0\\.0\\.1:${PORT}:${PORT}(/tcp)?$`);

/** `127.0.0.1:<hostPort>:<containerPort>` — the publish spec the gate uses. */
export function loopbackPublish(hostPort, containerPort) {
  return assertLoopbackPublish(`${LOOPBACK_HOST}:${hostPort}:${containerPort}`);
}

/** Refuse any publish spec that does not name the loopback host explicitly. */
export function assertLoopbackPublish(spec) {
  const m = LOOPBACK_PUBLISH.exec(String(spec));
  if (!m || Number(m[1]) > 65535 || Number(m[2]) > 65535) {
    throw new Error(
      `port publish '${spec}' does not bind ${LOOPBACK_HOST}: integration backends ` +
        'are published on the loopback interface only',
    );
  }
  return spec;
}

// The `docker run` argv for a gate backend. Pure, so the publish rule is
// asserted without a daemon.
export function containerRunArgv({ image, name, args = [], env = {}, ports = [] }) {
  assertDigestPinned(image);
  const argv = ['run', '-d', '--rm', '--name', name];
  for (const [k, v] of Object.entries(env)) argv.push('-e', `${k}=${v}`);
  for (const p of ports) argv.push('-p', assertLoopbackPublish(p));
  argv.push(image, ...args);
  return argv;
}

// Start a digest-pinned container detached, returning its id. Fails closed if
// the image is not digest-pinned, a port is not published on loopback only, or
// docker cannot start it.
export function runContainer(docker, { image, name, args = [], env = {}, ports = [] }) {
  const argv = containerRunArgv({ image, name, args, env, ports });
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
