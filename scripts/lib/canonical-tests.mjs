// Canonical test discovery + required-suite manifest (P1-CYCLE4-MED-001).
//
// The previous canonical test command relied on a shell glob:
//   tsx --test packages/**/*.test.ts ... scripts/**/*.test.ts
// Under the /bin/sh used by `pnpm run`, `**` is NOT recursive, so
// `scripts/**/*.test.ts` matched only `scripts/lib/acceptance-crypto.test.ts`
// and silently DROPPED scripts/check-acceptance.test.ts (the acceptance
// self-test, empty-head, signature-forgery and env-digest-tamper cases) and
// scripts/forbidden-imports.test.ts. Those critical suites existed in the repo
// but never ran under `pnpm test`.
//
// This module replaces the shell glob with a deterministic, shell-free Node
// walk. It is imported by:
//   - scripts/run-canonical-tests.mjs        (the CLI runner)
//   - scripts/run-canonical-tests.test.ts    (the wiring test)
// so the discovery logic and the required-suite manifest are proven by the same
// test suite they gate.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Canonical source roots that may contain *.test.ts files. A test file living
// anywhere under these roots is IN SCOPE for the canonical command; if it is not
// discovered, the runner fails closed (a file that exists but never runs is a
// silent coverage hole — exactly the MED-001 defect).
export const TEST_ROOTS = [
  'packages',
  'apps',
  'workers',
  'adapters',
  'evals',
  'scripts',
];

// Directories never traversed during discovery.
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

const TEST_SUFFIX = '.test.ts';

/**
 * Recursively discover every *.test.ts file under the canonical roots.
 * Returns REPO-RELATIVE, POSIX-normalised, lexicographically-sorted paths so the
 * result is byte-stable across platforms and independent of readdir order.
 */
export function discoverTestFiles(repoRoot) {
  const found = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch {
      return; // a missing root is simply empty, not an error
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
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(TEST_SUFFIX)) {
        found.push(full);
      }
    }
  };

  for (const root of TEST_ROOTS) {
    const absRoot = join(repoRoot, root);
    if (existsSync(absRoot)) walk(absRoot);
  }

  const rel = found.map((f) => relative(repoRoot, f).split(sep).join('/'));
  // De-dupe (defensive) and sort for a deterministic run order.
  return [...new Set(rel)].sort();
}

/**
 * Required critical suites. Each maps a machine-readable SUITE ID to the
 * repo-relative test file that MUST both (a) be discovered by the walk above and
 * (b) emit its SUITE ID at module load. The runner asserts every ID appears in
 * the captured test output, so a critical suite that is dropped, renamed away,
 * or crashes before running turns the gate RED even if the process exits 0.
 *
 * These are the security/assurance suites the MED-001 shell glob was silently
 * skipping, plus the crypto helpers and network guard they depend on.
 */
export const REQUIRED_SUITES = Object.freeze({
  'asep-suite:acceptance-crypto': 'scripts/lib/acceptance-crypto.test.ts',
  'asep-suite:acceptance-marker': 'scripts/check-acceptance.test.ts',
  'asep-suite:forbidden-imports': 'scripts/forbidden-imports.test.ts',
  'asep-suite:eval-network-guard': 'evals/runner/env.test.ts',
  'asep-suite:trusted-bootstrap': 'evals/runner/launcher.test.ts',
  'asep-suite:compat-gate': 'packages/contracts/src/compat-gate.test.ts',
  // The runner's own wiring suite must itself run under the canonical command —
  // otherwise the mechanism that guards every other required suite could be
  // silently dropped, which is the MED-001 defect one level up.
  'asep-suite:canonical-runner': 'scripts/run-canonical-tests.test.ts',
  // Phase 2 critical suites (exit criterion K4): tenancy/migration/lease and the
  // content-addressed artifact store. Registered here so a dropped, renamed, or
  // crash-before-first-line Phase-2 suite turns the gate RED, same mechanism as
  // the Phase-1 SUITE-IDs above.
  'asep-suite:persistence-tenancy': 'adapters/persistence/src/persistence.test.ts',
  'asep-suite:artifact-store': 'adapters/persistence/src/artifact-store.test.ts',
  'asep-suite:git-worktree': 'adapters/git-worktree/src/git-worktree.test.ts',
  'asep-suite:command-runner': 'adapters/command-runner/src/command-runner.test.ts',
});

/** The machine-readable marker a suite prints at module load: `SUITE-ID: <id>`. */
export const SUITE_ID_PREFIX = 'SUITE-ID:';

/** Format the marker line a critical test file emits at module top level. */
export function suiteMarker(id) {
  return `${SUITE_ID_PREFIX} ${id}`;
}

/**
 * Pure required-suite verification (P1-CYCLE4-MED-001). Given the combined
 * stdout+stderr of a test run, return the list of required suites whose
 * SUITE-ID marker did NOT appear — i.e. suites that were dropped, renamed away,
 * or crashed before their first line. An empty list means every critical suite
 * ran. This is extracted as a pure function so the wiring test can drive the
 * fail-closed logic directly, without spawning a doctored child.
 */
export function missingRequiredSuites(combinedOutput) {
  const missing = [];
  for (const [id, file] of Object.entries(REQUIRED_SUITES)) {
    if (!combinedOutput.includes(suiteMarker(id))) {
      missing.push({ id, file });
    }
  }
  return missing;
}
