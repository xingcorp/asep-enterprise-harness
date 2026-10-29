// Cold-cache reset gate step.
//
// verify:all wipes every `dist/` and `*.tsbuildinfo` outside node_modules before
// `tsc -b`, so the typecheck that follows is the cold build a fresh CI checkout
// runs. The step is only worth anything if it FAILS when the wipe does not
// happen: a stale `dist/` lets a missing project reference resolve through the
// node_modules symlink and the gate goes green on a tree CI cannot build.
//
// These tests drive the real script against a throwaway tree. Removal failure is
// forced with a PATH shim for `rm`, which works the same for root and non-root
// users (a chmod-based denial is bypassed by root).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('SUITE-ID: asep-suite:cold-cache-reset');

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'cold-cache-reset.sh');

function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'asep-cold-reset-'));
  for (const pkg of ['packages/a', 'adapters/b', 'scripts']) {
    mkdirSync(join(root, pkg, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(root, pkg, 'dist', 'nested', 'index.js'), 'stale\n');
    writeFileSync(join(root, pkg, 'tsconfig.tsbuildinfo'), '{}\n');
  }
  // A dependency's own build output must be left alone.
  mkdirSync(join(root, 'node_modules', 'dep', 'dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'dist', 'index.js'), 'vendor\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'dep.tsbuildinfo'), '{}\n');
  return root;
}

// A PATH directory whose `rm` does what `body` says instead of removing.
function rmShim(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asep-rm-shim-'));
  const shim = join(dir, 'rm');
  writeFileSync(shim, `#!/bin/sh\n${body}\n`);
  chmodSync(shim, 0o755);
  return dir;
}

// The script's scratch listing goes under the fixture, so a shimmed `rm` cannot
// leave it behind in the real temp directory.
function run(root: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync('bash', [SCRIPT, root], { encoding: 'utf8', env: { ...env, TMPDIR: root } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('removes every dist/ and *.tsbuildinfo outside node_modules and reports PASS', () => {
  const root = fixtureTree();
  try {
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /cold-cache reset: PASS/);
    for (const pkg of ['packages/a', 'adapters/b', 'scripts']) {
      assert.equal(existsSync(join(root, pkg, 'dist')), false, `${pkg}/dist survived`);
      assert.equal(existsSync(join(root, pkg, 'tsconfig.tsbuildinfo')), false, `${pkg} tsbuildinfo survived`);
    }
    assert.equal(existsSync(join(root, 'node_modules', 'dep', 'dist', 'index.js')), true);
    assert.equal(existsSync(join(root, 'node_modules', 'dep', 'dep.tsbuildinfo')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing removal makes the step fail and never prints PASS', () => {
  const root = fixtureTree();
  const shim = rmShim('echo "rm: simulated failure" >&2; exit 1');
  try {
    const r = run(root, { ...process.env, PATH: `${shim}:${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.code, 0, `a failed removal must fail the gate:\n${r.out}`);
    assert.doesNotMatch(r.out, /cold-cache reset: PASS/);
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a removal that silently does nothing is caught by the leftover check', () => {
  const root = fixtureTree();
  const shim = rmShim('exit 0');
  try {
    const r = run(root, { ...process.env, PATH: `${shim}:${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.code, 0, `stale build output survived but the gate passed:\n${r.out}`);
    assert.doesNotMatch(r.out, /cold-cache reset: PASS/);
    // The failure names what survived, so the developer can see why.
    assert.match(r.out, /packages\/a\/dist/);
    assert.match(r.out, /tsbuildinfo/);
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// A PATH directory whose `find` runs `body`; `$@` is the real find's argv and
// REAL_FIND points at the real binary, so a shim can fail only some calls.
function findShim(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asep-find-shim-'));
  const shim = join(dir, 'find');
  writeFileSync(shim, `#!/bin/sh\n${body}\n`);
  chmodSync(shim, 0o755);
  return dir;
}

function realFind(): string {
  const r = spawnSync('sh', ['-c', 'command -v find'], { encoding: 'utf8' });
  return r.stdout.trim();
}

test('a discovery that fails outright makes the step fail and never prints PASS', () => {
  const root = fixtureTree();
  const shim = findShim('echo "find: simulated failure" >&2; exit 1');
  try {
    const r = run(root, { ...process.env, PATH: `${shim}:${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.code, 0, `a failed discovery listed nothing, so nothing survived, but it is not a clean tree:\n${r.out}`);
    assert.doesNotMatch(r.out, /cold-cache reset: PASS/);
    assert.match(r.out, /could not list/);
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a discovery that lists some artifacts and then fails is still a failure', () => {
  const root = fixtureTree();
  // Real output, then a non-zero exit — what an unreadable subdirectory gives.
  const shim = findShim(`"$REAL_FIND" "$@"; echo "find: ./x: Permission denied" >&2; exit 1`);
  try {
    const r = run(root, { ...process.env, REAL_FIND: realFind(), PATH: `${shim}:${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /cold-cache reset: PASS/);
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a leftover scan that fails is a failure even when the removal pass succeeded', () => {
  const root = fixtureTree();
  const marker = join(root, '.find-calls');
  // The first call (removal pass) is real; every later call (leftover scan) fails.
  const shim = findShim(
    `if [ -e "${marker}" ]; then exit 1; fi; : > "${marker}"; exec "$REAL_FIND" "$@"`,
  );
  try {
    const r = run(root, { ...process.env, REAL_FIND: realFind(), PATH: `${shim}:${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.code, 0, `the leftover scan could not run, yet the step passed:\n${r.out}`);
    assert.doesNotMatch(r.out, /cold-cache reset: PASS/);
  } finally {
    rmSync(shim, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('an exported shell function shadowing find cannot make the reset pass', () => {
  const root = fixtureTree();
  try {
    const r = spawnSync('bash', ['-c', `find() { return 1; }; export -f find; bash "${SCRIPT}" "${root}"`], {
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.notEqual(r.status, 0, out);
    assert.doesNotMatch(out, /cold-cache reset: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dist symlink outside node_modules is removed, not left to feed stale output', () => {
  const root = fixtureTree();
  try {
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    mkdirSync(join(root, 'apps', 'c'), { recursive: true });
    spawnSync('ln', ['-s', join(root, 'elsewhere'), join(root, 'apps', 'c', 'dist')]);
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(root, 'apps', 'c', 'dist')), false, 'symlinked dist survived');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify:all runs this script as a gated step before typecheck', () => {
  const verifyAll = readFileSync(join(HERE, 'verify-all.sh'), 'utf8');
  const reset = verifyAll.indexOf('step "cold-cache reset"');
  const typecheck = verifyAll.indexOf('step "typecheck"');
  assert.ok(reset >= 0, 'verify-all.sh has no cold-cache reset step');
  assert.ok(typecheck > reset, 'cold-cache reset must run before typecheck');
  const line = verifyAll.slice(reset, verifyAll.indexOf('\n', reset));
  assert.match(line, /bash scripts\/cold-cache-reset\.sh/, 'the step must run the script, not inline code');
  // No error swallowing anywhere in the step's command.
  assert.doesNotMatch(line, /\|\|\s*true/);
});
