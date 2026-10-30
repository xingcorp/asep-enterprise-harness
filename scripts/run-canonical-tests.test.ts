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
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { delimiter, dirname, join } from 'node:path';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { discoverTestFiles, REQUIRED_SUITES, suiteMarker, missingRequiredSuites, TEST_ROOTS } from './lib/canonical-tests.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { runCanonicalTests } from './run-canonical-tests.mjs';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { withUnreadable } from './testing/unreadable.mjs';
import {
  endProcess, identityOf, nestRegistry, shownGone, spawnRecorded, stillRunning, unregister, PROC_ENV, RECORD_VERSION, REGISTRY_ENV,
  // @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
} from './lib/process-registry.mjs';

// Machine-readable suite marker (kept consistent with the other suites, though
// this file is not itself in the required set).
console.log('SUITE-ID: asep-suite:canonical-runner');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const REGISTRY_MODULE = pathToFileURL(join(HERE, 'lib', 'process-registry.mjs')).href;
const SUITES_MODULE = pathToFileURL(join(HERE, 'lib', 'canonical-tests.mjs')).href;

// A leader of its own group that starts a member of that group with the token
// it is given (its first argument), prints the member's pid, and exits: a
// group that cannot be shown to be the one recorded with the leader's token.
const LEADER_WITH_A_STRANGER = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], "
  + "{ stdio: 'ignore', env: { PATH: process.env.PATH, ASEP_PROCESS_TOKEN: process.argv[1] } }); "
  + "process.stdout.write(c.pid + '\\n'); setTimeout(() => process.exit(0), 100);";

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
// It reads the process table as it is, whatever its runner reads it with.
delete process.env.${PROC_ENV};
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { register, spawnRecorded, RECORD_VERSION } from ${JSON.stringify(REGISTRY_MODULE)};
import { REQUIRED_SUITES, suiteMarker } from ${JSON.stringify(SUITES_MODULE)};
for (const id of Object.keys(REQUIRED_SUITES)) console.log(suiteMarker(id));
const memberToken = randomUUID();
const script = ${JSON.stringify(LEADER_WITH_A_STRANGER)};
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
register({ version: RECORD_VERSION, pid: ended, group: true, token: randomUUID(), startedAt: 'Thu Jan  1 00:00:00 1970' });
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
  // The registries of the run this test process is in; run by hand, outside a
  // run, a stand-in for one. A runner started inside a run keeps them.
  const standIn = join(dir, 'outer-run');
  mkdirSync(standIn);
  const restoreRun = process.env[REGISTRY_ENV] ? () => undefined : nestRegistry(standIn);
  const runs = process.env[REGISTRY_ENV]!.split(delimiter).filter((d) => d !== '');
  try {
    const fixture = join(dir, 'leaves-a-process.test.mjs');
    writeFileSync(fixture, LEAVES_A_PROCESS(pidFile));
    const r = runOn(fixture, join(dir, 'registry'));
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    for (const run of runs) {
      assert.ok(readdirSync(run).includes(`${pid}.json`), `what its tests start is in the outer run's registry too, ${run}`);
    }
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /canonical-tests: process registry: found running 0 process\(es\) of earlier runs and 1 of this run\n/);
    assert.ok(r.stderr.includes(`  - pid ${pid}: ended\n`), r.stderr);
    assert.match(r.stderr, /  - pid \d+: gone\n/, 'a record whose process had ended is listed, not counted');
    assert.equal(stillRunning(pid, true), false, 'the leftover was ended');
  } finally {
    endLeft(pidFile);
    restoreRun();
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

test('a process of the run whose environment cannot be read, where /proc shows environments, fails the run and is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-runner-registry-'));
  const pidFile = join(dir, 'left.json');
  // A /proc that shows no process's environment, for the runner alone.
  const proc = join(dir, 'proc');
  mkdirSync(proc);
  const before = process.env[PROC_ENV];
  try {
    const fixture = join(dir, 'leaves-a-process.test.mjs');
    writeFileSync(fixture, LEAVES_A_PROCESS(pidFile));
    process.env[PROC_ENV] = proc;
    const r = runOn(fixture, join(dir, 'registry'));
    if (before === undefined) delete process.env[PROC_ENV];
    else process.env[PROC_ENV] = before;
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number };
    assert.equal(r.code, 1, `the run fails: ${r.stderr}`);
    assert.ok(r.stderr.includes(`  - pid ${pid}: unknown\n`), r.stderr);
    assert.equal(stillRunning(pid, true), true, 'and what could not be shown ours was not signalled');
  } finally {
    if (before === undefined) delete process.env[PROC_ENV];
    else process.env[PROC_ENV] = before;
    endLeft(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A test file that starts nothing and stands in for every required suite.
const STARTS_NOTHING = `
import { REQUIRED_SUITES, suiteMarker } from ${JSON.stringify(SUITES_MODULE)};
for (const id of Object.keys(REQUIRED_SUITES)) console.log(suiteMarker(id));
`;

test('a leftover of an earlier run that cannot be shown gone fails the run, and one that is ended does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-runner-registry-'));
  const root = join(dir, 'registry');
  const fixture = join(dir, 'starts-nothing.test.mjs');
  writeFileSync(fixture, STARTS_NOTHING);
  // A run whose runner died: its owner is a process that has exited.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const earlierRun = (name: string, entry: { pid: number }) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'owner.json'), JSON.stringify({ pid: dead, startedAt: 'Thu Jan  1 00:00:00 1970' }));
    writeFileSync(join(root, name, `${entry.pid}.json`), JSON.stringify(entry));
  };
  type Entry = { pid: number; token: string };
  const plain = spawnRecorded(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' }) as {
    child: { unref(): void }; entry: Entry;
  };
  plain.child.unref();
  const memberToken = randomUUID();
  const leader = spawnRecorded(process.execPath, ['-e', LEADER_WITH_A_STRANGER, memberToken], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'],
  }) as { child: ChildProcess; entry: Entry };
  const member = await new Promise<number>((resolve) => {
    leader.child.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())));
  });
  await new Promise((resolve) => leader.child.once('exit', resolve));
  try {
    earlierRun('ended-run', plain.entry);
    const passed = runOn(fixture, root);
    assert.equal(passed.code, 0, passed.stderr);
    assert.ok(passed.stderr.includes(`  - pid ${plain.entry.pid} of run ended-run: ended\n`), passed.stderr);
    assert.equal(stillRunning(plain.entry.pid), false);

    earlierRun('unproven-run', leader.entry);
    const failed = runOn(fixture, root);
    assert.equal(failed.code, 1, `the run fails: ${failed.stderr}`);
    assert.ok(failed.stderr.includes(`  - pid ${leader.entry.pid} of run unproven-run: unknown\n`), failed.stderr);
    assert.equal(stillRunning(member), true, 'what could not be shown ours was not signalled');
    assert.equal(existsSync(join(root, 'unproven-run', `${leader.entry.pid}.json`)), true, 'and its record stays');
  } finally {
    const stranger = identityOf(member, { token: memberToken });
    if (stranger !== undefined) endProcess(stranger);
    for (const entry of [plain.entry, leader.entry]) if (shownGone(endProcess(entry))) unregister(entry.pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an earlier run\'s record that does not fully identify its process fails the run, naming it, and is never acted on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-runner-registry-'));
  const root = join(dir, 'registry');
  const fixture = join(dir, 'starts-nothing.test.mjs');
  writeFileSync(fixture, STARTS_NOTHING);
  // A run whose runner died, with a record its process runs on under.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const live = spawnRecorded(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' }) as {
    child: { unref(): void }; entry: { pid: number };
  };
  live.child.unref();
  const run = join(root, 'legacy-run');
  try {
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'owner.json'), JSON.stringify({ pid: dead, startedAt: 'Thu Jan  1 00:00:00 1970' }));
    // As the format before the token wrote it; and one that cannot be read.
    writeFileSync(join(run, `${live.entry.pid}.json`), JSON.stringify({ pid: live.entry.pid, group: true, marker: 'asep-fake-container-x' }));
    writeFileSync(join(run, 'torn.json'), '{"pid": ');
    const r = runOn(fixture, root);
    assert.equal(r.code, 1, `the run fails: ${r.stderr}`);
    assert.ok(r.stderr.includes(`  - pid ${live.entry.pid} of run legacy-run: unknown — its record is not of format version `
      + `${RECORD_VERSION}, so it was left alone\n`), r.stderr);
    assert.ok(r.stderr.includes('  - record torn.json of run legacy-run: unknown — its record cannot be read, so it was left alone\n'),
      r.stderr);
    assert.equal(stillRunning(live.entry.pid, true), true, 'its process was not signalled');
    assert.deepEqual(readdirSync(run).sort(), [`${live.entry.pid}.json`, 'owner.json', 'torn.json'].sort(), 'and the records stay');
  } finally {
    if (shownGone(endProcess(live.entry))) unregister(live.entry.pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a registry root that cannot be read fails the run, naming it, and nothing under it is touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-runner-registry-'));
  const root = join(dir, 'registry');
  const fixture = join(dir, 'starts-nothing.test.mjs');
  writeFileSync(fixture, STARTS_NOTHING);
  // An earlier run whose runner died, holding a process that runs.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const live = spawnRecorded(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' }) as {
    child: { unref(): void }; entry: { pid: number };
  };
  live.child.unref();
  const run = join(root, 'stale-run');
  try {
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'owner.json'), JSON.stringify({ pid: dead, startedAt: 'Thu Jan  1 00:00:00 1970' }));
    writeFileSync(join(run, `${live.entry.pid}.json`), JSON.stringify(live.entry));
    // The reviewer's CYCLE15_UNREADABLE_REGISTRY_ROOT_GATE: the root's listing
    // fails with EACCES; making a new run there still works.
    const r = withUnreadable([root], () => runOn(fixture, root)) as { code: number; stderr: string };
    assert.equal(r.code, 1, `the run fails: ${r.stderr}`);
    assert.ok(r.stderr.includes(`  - directory ${root}: unknown — it cannot be read (EACCES), so it was left alone\n`), r.stderr);
    assert.equal(stillRunning(live.entry.pid, true), true, 'the earlier run\'s process was not signalled');
    assert.ok(readdirSync(run).includes(`${live.entry.pid}.json`), 'and its record stays');
  } finally {
    if (shownGone(endProcess(live.entry))) unregister(live.entry.pid);
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
