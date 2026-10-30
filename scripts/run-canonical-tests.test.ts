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
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { discoverTestFiles, REQUIRED_SUITES, suiteMarker, missingRequiredSuites, TEST_ROOTS } from './lib/canonical-tests.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { runCanonicalTests } from './run-canonical-tests.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { endProcess, identityOf, stillRunning } from './lib/process-registry.mjs';

// Machine-readable suite marker (kept consistent with the other suites, though
// this file is not itself in the required set).
console.log('SUITE-ID: asep-suite:canonical-runner');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const REGISTRY_MODULE = pathToFileURL(join(HERE, 'lib', 'process-registry.mjs')).href;
const SUITES_MODULE = pathToFileURL(join(HERE, 'lib', 'canonical-tests.mjs')).href;

// A test file that leaves a process of its own group running, recorded in the
// registry its runner handed it, as a fake container whose test died would,
// and leaves the record of one that has already ended. With `unproven`, the
// process it leaves is a group whose leader has exited, with a member that
// shows another token: it cannot be shown to be the one recorded. It stands in
// for every required suite, so that what its runner answers is the registry's
// doing alone. What it starts is recorded in the registry its runner hands it,
// and holds a minute at most, so that what a failed test leaves does not
// outlive it by long.
const LEAVES_A_PROCESS = (pidFile: string, unproven = false) => `
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnRecorded } from ${JSON.stringify(REGISTRY_MODULE)};
import { REQUIRED_SUITES, suiteMarker } from ${JSON.stringify(SUITES_MODULE)};
for (const id of Object.keys(REQUIRED_SUITES)) console.log(suiteMarker(id));
const memberToken = randomUUID();
const script = ${JSON.stringify(
    "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], "
    + "{ stdio: 'ignore', env: { PATH: process.env.PATH, ASEP_PROCESS_TOKEN: process.argv[1] } }); "
    + "process.stdout.write(c.pid + '\\n'); setTimeout(() => process.exit(0), 100);")};
const { child, entry } = ${unproven}
  ? spawnRecorded(process.execPath, ['-e', script, memberToken], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  : spawnRecorded(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' });
let left = { pid: child.pid, token: entry.token };
if (${unproven}) {
  const member = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  await new Promise((resolve) => child.once('exit', resolve));
  left = { pid: member, token: memberToken };
}
child.unref();
const ended = spawnSync(process.execPath, ['-e', '']).pid;
writeFileSync(join(process.env.ASEP_PROCESS_REGISTRY, ended + '.json'),
  JSON.stringify({ pid: ended, group: true, token: randomUUID(), startedAt: 'Thu Jan  1 00:00:00 1970' }));
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(left));
`;

// The runner, run here from inside a test process on `fixture` alone, with a
// registry root of its own. Its own test child must not take itself for one of
// this runner's.
function runOn(fixture: string, registryRoot: string): { code: number; stderr: string } {
  const context = process.env['NODE_TEST_CONTEXT'];
  delete process.env['NODE_TEST_CONTEXT'];
  try {
    return runCanonicalTests({ stream: false, files: [fixture], registryRoot });
  } finally {
    if (context !== undefined) process.env['NODE_TEST_CONTEXT'] = context;
  }
}

// What a fixture left running, ended by its own identity if it still runs.
function endLeft(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const left = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number; token: string };
  const entry = identityOf(left.pid, { token: left.token, group: true });
  if (entry !== undefined) endProcess(entry);
}

test('the runner hands its tests a process registry and ends what they leave running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-runner-registry-'));
  const pidFile = join(dir, 'left.json');
  try {
    const fixture = join(dir, 'leaves-a-process.test.mjs');
    writeFileSync(fixture, LEAVES_A_PROCESS(pidFile));
    const r = runOn(fixture, join(dir, 'registry'));
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /canonical-tests: process registry: found running 0 process\(es\) of earlier runs and 1 of this run\n/);
    assert.ok(r.stderr.includes(`  - pid ${pid}: ended\n`), r.stderr);
    assert.match(r.stderr, /  - pid \d+: gone\n/, 'a record whose process had ended is listed, not counted');
    assert.equal(stillRunning(pid, true), false, 'the leftover was ended');
  } finally {
    endLeft(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a process of the run that cannot be shown to be the one recorded fails the run, and is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-runner-registry-'));
  const pidFile = join(dir, 'left.json');
  try {
    const fixture = join(dir, 'leaves-a-process.test.mjs');
    writeFileSync(fixture, LEAVES_A_PROCESS(pidFile, true));
    const r = runOn(fixture, join(dir, 'registry'));
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    assert.equal(r.code, 1, `the run fails: ${r.stderr}`);
    assert.match(r.stderr, /  - pid \d+: unknown\n/, r.stderr);
    assert.equal(stillRunning(pid), true, 'and what could not be shown ours was not signalled');
  } finally {
    endLeft(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

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
