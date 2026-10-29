// Every Node process that runs tests starts with --no-wasm-code-gc
// (nodejs/node#66366; the reason is in scripts/lib/node-test-flags.mjs).
//
// Three checks: this very file, run by whichever runner ran it, carries the
// flag; a test child started with the runners' argv carries it; and every test
// entry point in the repository — package scripts, gate scripts, the CI
// workflow and the two runners — passes it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NODE_TEST_V8_FLAGS, nodeTestArgs,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './lib/node-test-flags.mjs';

console.log('SUITE-ID: asep-suite:node-test-flags');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLAG = '--no-wasm-code-gc';

test('the test runtime flag list holds the wasm code GC workaround', () => {
  assert.deepEqual([...NODE_TEST_V8_FLAGS], [FLAG]);
});

test('this test process runs with wasm code GC disabled', () => {
  assert.ok(process.execArgv.includes(FLAG),
    `the runner did not hand ${FLAG} to its test child: execArgv ${JSON.stringify(process.execArgv)}`);
});

test('a test child started with the runners\' argv carries the flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-test-flags-'));
  try {
    const probe = join(dir, 'probe.test.mjs');
    writeFileSync(probe, "import test from 'node:test';\n" +
      "test('probe', () => { console.log('PROBE-EXECARGV ' + JSON.stringify(process.execArgv)); });\n");
    // Started as a runner is, not as a child of this test run: without the
    // marker the test runner sets for its own children.
    const { NODE_TEST_CONTEXT: _child, ...env } = process.env;
    for (const opts of [{}, { concurrency: '2' }]) {
      const r = spawnSync(process.execPath, nodeTestArgs([probe], opts), { cwd: REPO, encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stderr);
      const line = r.stdout.split('\n').find((l) => l.includes('PROBE-EXECARGV '));
      assert.ok(line, r.stdout);
      const execArgv = JSON.parse(line.slice(line.indexOf('PROBE-EXECARGV ') + 'PROBE-EXECARGV '.length)) as string[];
      assert.ok(execArgv.includes(FLAG), `test child execArgv ${JSON.stringify(execArgv)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every package.json of the workspace.
function packageJsons(): string[] {
  const out = [join(REPO, 'package.json')];
  for (const top of ['packages', 'adapters', 'apps', 'workers', 'evals']) {
    if (!existsSync(join(REPO, top))) continue;
    for (const name of readdirSync(join(REPO, top))) {
      const p = join(REPO, top, name, 'package.json');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

// A command line that starts the Node test runner.
const RUNS_TESTS = /(^|[\s"'])--test(?=$|[\s"'])/;

test('every test entry point of the repository starts Node with the flag', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const p of packageJsons()) {
    const scripts = (JSON.parse(readFileSync(p, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (!RUNS_TESTS.test(cmd)) continue;
      seen++;
      if (!cmd.includes(FLAG)) offenders.push(`${p.slice(REPO.length + 1)} scripts.${name}: ${cmd}`);
    }
  }
  for (const f of ['scripts/verify-all.sh', 'scripts/capture-evidence.sh', '.github/workflows/ci.yml']) {
    if (!existsSync(join(REPO, f))) continue;
    readFileSync(join(REPO, f), 'utf8').split('\n').forEach((line, i) => {
      if (line.trimStart().startsWith('#') || !RUNS_TESTS.test(line)) return;
      seen++;
      if (!line.includes(FLAG)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  // The two runners build their argv only through nodeTestArgs.
  for (const f of ['scripts/run-canonical-tests.mjs', 'scripts/integration/run-integration.mjs']) {
    const src = readFileSync(join(REPO, f), 'utf8');
    seen++;
    if (!/nodeTestArgs\(/.test(src)) offenders.push(`${f}: does not build its argv with nodeTestArgs`);
    if (/['"]--test['"]/.test(src)) offenders.push(`${f}: spells '--test' itself instead of using nodeTestArgs`);
  }
  assert.ok(seen >= 9, `found only ${seen} test entry points — the scan is not looking where the tests start`);
  assert.deepEqual(offenders, [], `test entry points without ${FLAG}:\n${offenders.join('\n')}`);
});
