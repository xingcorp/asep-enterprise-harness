#!/usr/bin/env node
// Canonical test runner (P1-CYCLE4-MED-001).
//
// Replaces the shell-glob-based `pnpm test`. The old command,
//   tsx --test packages/**/*.test.ts ... scripts/**/*.test.ts
// relied on `**` being recursive under /bin/sh — it is NOT, so critical suites
// under scripts/ (acceptance self-test, empty-head, signature-forgery,
// env-digest-tamper, forbidden-imports) were silently skipped by the canonical
// command while still passing when run by hand.
//
// This runner is shell-free and deterministic:
//   1. discover every *.test.ts under the canonical roots via a Node walk
//      (no shell, no glob) — normalised + sorted;
//   2. FAIL CLOSED if discovery finds nothing (a broken walk must not look green);
//   3. run the whole set in ONE `node --import tsx --test <files...>` child with
//      shell:false and an explicit arg list — no shell interpolation;
//   4. capture stdout+stderr in full and stream it through;
//   5. assert every REQUIRED_SUITES machine-readable SUITE ID appears in the
//      captured output — so a critical suite that is dropped, renamed, or
//      crashes before its first line turns the gate RED even on a 0 exit;
//   6. propagate the child's EXACT exit code (non-zero on any test failure).
//
// Usage:
//   node scripts/run-canonical-tests.mjs      # the canonical test command
//   pnpm test                                  # same, via the package alias

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  discoverTestFiles,
  REQUIRED_SUITES,
  missingRequiredSuites,
} from './lib/canonical-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

/**
 * Run the canonical test set. Returns { code, stdout, stderr, files } so the
 * wiring test can drive the runner in-process and assert on real output without
 * shelling out twice. When `opts.stream` is true (CLI use) child output is also
 * echoed to this process's stdio as it is captured.
 */
export function runCanonicalTests(opts = {}) {
  const stream = opts.stream !== false;
  const files = discoverTestFiles(REPO_ROOT);

  // (2) Fail closed on empty discovery: a walk that finds no tests is a bug in
  // the runner, not a clean tree. Never report success by running nothing.
  if (files.length === 0) {
    const msg =
      'canonical-tests: FAIL — discovered ZERO test files; refusing to report ' +
      'success by running nothing (P1-CYCLE4-MED-001)\n';
    if (stream) process.stderr.write(msg);
    return { code: 1, stdout: '', stderr: msg, files };
  }

  // (3) Explicit, shell-free child. `node --import tsx --test <files...>` runs
  // TypeScript tests directly; shell:false + an explicit argv means no glob,
  // no word-splitting, no interpolation. Files are passed as discrete args.
  // --test-concurrency bounds how many test FILES run in parallel. Several
  // Phase-2 suites each spin up an in-process pglite (WASM PostgreSQL) instance,
  // which is memory/CPU heavy; letting the default (≈CPU count) run at once made
  // the artifact-store suite intermittently time out under contention. Cap the
  // parallelism so the DB-heavy suites don't starve each other, keeping the gate
  // deterministic. Overridable via ASEP_TEST_CONCURRENCY for a faster local run.
  const concurrency = process.env['ASEP_TEST_CONCURRENCY'] ?? '2';
  const args = ['--import', 'tsx', `--test-concurrency=${concurrency}`, '--test', ...files];
  const child = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    shell: false,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  if (stream) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }

  // A spawn-level failure (binary missing, killed by signal) is fatal.
  if (child.error) {
    const msg = `canonical-tests: FAIL — could not launch test child: ${child.error.message}\n`;
    if (stream) process.stderr.write(msg);
    return { code: 1, stdout, stderr: stderr + msg, files };
  }

  // (5) Required-suite verification. Every critical suite must have emitted its
  // machine-readable SUITE ID. A missing ID means the suite did not run (glob
  // regression, rename, or a crash before its first line) — fail closed even if
  // the child exited 0.
  const combined = stdout + stderr;
  const missing = missingRequiredSuites(combined).map(
    ({ id, file }) => `${id} (${file})`,
  );

  // (6) Propagate the child's exact exit code. A signal death (code === null)
  // becomes a non-zero failure.
  let code = typeof child.status === 'number' ? child.status : 1;

  if (missing.length > 0) {
    const msg =
      'canonical-tests: FAIL — required critical suite(s) did not run ' +
      '(no SUITE-ID marker in output):\n' +
      missing.map((m) => `  - ${m}`).join('\n') +
      '\n';
    if (stream) process.stderr.write(msg);
    // Preserve a non-zero child code if present; otherwise force failure.
    if (code === 0) code = 1;
    return { code, stdout, stderr: stderr + msg, files };
  }

  if (stream && code === 0) {
    process.stdout.write(
      `\ncanonical-tests: PASS (${files.length} test file(s), ` +
        `${Object.keys(REQUIRED_SUITES).length} required suite(s) verified)\n`,
    );
  }
  return { code, stdout, stderr, files };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const { code } = runCanonicalTests({ stream: true });
  process.exit(code);
}
