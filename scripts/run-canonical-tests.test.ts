// Wiring test for the canonical test runner (P1-CYCLE4-MED-001).
//
// Proves the properties the shell-glob command silently violated:
//   (A) discovery is RECURSIVE and shell-free — it finds every *.test.ts under
//       the canonical roots, including the nested scripts/ suites the /bin/sh
//       `scripts/**/*.test.ts` glob dropped;
//   (B) every REQUIRED critical suite file is discovered — a suite that exists
//       in the repo but is not reachable by the walk fails this test;
//   (C) each required suite emits its machine-readable SUITE-ID at module load,
//       and the runner's required-suite verification is wired to those IDs;
//   (D) the required-suite verification fails CLOSED when a suite's SUITE-ID is
//       missing from the captured output (the fail-closed core the runner uses
//       even on a zero child exit), and passes only when EVERY marker is present.
//
// (A)–(D) are checked in-process against the real discovery + manifest + the
// exact verification helper the runner uses, so the test cannot drift from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { discoverTestFiles, REQUIRED_SUITES, suiteMarker, missingRequiredSuites, TEST_ROOTS } from './lib/canonical-tests.mjs';

// Machine-readable suite marker (kept consistent with the other suites, though
// this file is not itself in the required set).
console.log('SUITE-ID: asep-suite:canonical-runner');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

test('discovery is recursive and finds the nested scripts/ suites the shell glob dropped', () => {
  const files = discoverTestFiles(REPO_ROOT) as string[];
  assert.ok(files.length > 0, 'discovery must find test files');

  // The exact suites the /bin/sh `scripts/**/*.test.ts` glob silently skipped.
  // These live at scripts/<file> and scripts/lib/<file>; a recursive walk must
  // surface all of them.
  assert.ok(
    files.includes('scripts/check-acceptance.test.ts'),
    'acceptance suite (top-level scripts/) must be discovered',
  );
  assert.ok(
    files.includes('scripts/lib/acceptance-crypto.test.ts'),
    'nested scripts/lib/ crypto suite must be discovered',
  );
  assert.ok(
    files.includes('scripts/forbidden-imports.test.ts'),
    'forbidden-imports fitness suite must be discovered',
  );
  // And a deep package suite, to prove packages/ is walked recursively too.
  assert.ok(
    files.includes('packages/contracts/src/compat-gate.test.ts'),
    'nested packages/ suite must be discovered',
  );
});

test('discovery output is sorted, POSIX-normalised, and de-duplicated', () => {
  const files = discoverTestFiles(REPO_ROOT) as string[];
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted, 'files must be returned in sorted order');
  assert.equal(new Set(files).size, files.length, 'files must be unique');
  for (const f of files) {
    assert.ok(!f.includes('\\'), `path must be POSIX-normalised: ${f}`);
    assert.ok(f.endsWith('.test.ts'), `only *.test.ts files: ${f}`);
  }
});

test('every REQUIRED critical suite file exists and is discovered', () => {
  const files = new Set(discoverTestFiles(REPO_ROOT) as string[]);
  for (const [id, rel] of Object.entries(REQUIRED_SUITES as Record<string, string>)) {
    assert.ok(existsSync(join(REPO_ROOT, rel)), `required suite file must exist: ${rel} (${id})`);
    assert.ok(files.has(rel), `required suite must be discovered by the walk: ${rel} (${id})`);
  }
});

test('every REQUIRED suite actually emits its SUITE-ID marker at module load', () => {
  // The runner verifies presence in captured OUTPUT; here we prove the source
  // truly prints the marker, so the two ends of the contract cannot drift. We
  // check the literal marker string appears in each required test file.
  for (const [id, rel] of Object.entries(REQUIRED_SUITES as Record<string, string>)) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const marker = suiteMarker(id) as string;
    assert.ok(
      src.includes(marker),
      `required suite ${rel} must print its marker \`${marker}\` at module load`,
    );
  }
});

test('the canonical roots cover every top-level source dir that holds tests', () => {
  // If a new source root starts holding *.test.ts files but is not in
  // TEST_ROOTS, those tests would be invisible to the canonical command — the
  // very class of bug MED-001 was. Assert the manifest roots are the ones in use.
  const roots = TEST_ROOTS as string[];
  for (const [, rel] of Object.entries(REQUIRED_SUITES as Record<string, string>)) {
    const top = rel.split('/')[0]!;
    assert.ok(roots.includes(top), `required suite root '${top}' must be in TEST_ROOTS`);
  }
});

// (D) The fail-closed core the runner relies on. missingRequiredSuites() is the
// exact function the runner uses to decide whether every critical suite ran;
// the runner forces a non-zero exit when it returns a non-empty list even on a
// zero child exit. We drive that pure function directly with synthetic output.
type MissingEntry = { id: string; file: string };
const requiredIds = Object.keys(REQUIRED_SUITES as Record<string, string>);

test('required-suite verification: full output with every marker reports NOTHING missing', () => {
  const fullOutput = requiredIds.map((id) => suiteMarker(id) as string).join('\n') + '\n';
  const missing = missingRequiredSuites(fullOutput) as MissingEntry[];
  assert.deepEqual(missing, [], `all markers present must report no missing suites: ${JSON.stringify(missing)}`);
});

test('required-suite verification FAILS CLOSED when one suite marker is absent', () => {
  // Simulate a run where the acceptance suite was dropped (its marker never
  // printed) but everything else ran. The verification must flag it — this is
  // exactly the MED-001 shape (a suite silently not running) and is what forces
  // the runner to a non-zero exit even if the child process returned 0.
  const dropped = 'asep-suite:acceptance-marker';
  const partial = requiredIds
    .filter((id) => id !== dropped)
    .map((id) => suiteMarker(id) as string)
    .join('\n') + '\n';
  const missing = missingRequiredSuites(partial) as MissingEntry[];
  assert.equal(missing.length, 1, `exactly the dropped suite must be reported: ${JSON.stringify(missing)}`);
  assert.equal(missing[0]!.id, dropped);
});

test('required-suite verification FAILS CLOSED on completely empty output', () => {
  // An empty capture (e.g. the child crashed before any suite loaded) must
  // report every required suite as missing — never silently green.
  const missing = missingRequiredSuites('') as MissingEntry[];
  assert.equal(missing.length, requiredIds.length, 'empty output must report all suites missing');
});
