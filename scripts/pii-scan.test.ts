// PII gate over git metadata.
//
// The file scan reads `git ls-files`, so the author and committer emails every
// commit publishes were never looked at. These tests run the REAL
// scripts/pii-scan.sh, end to end, inside a throwaway repository: a commit made
// under a personal address must fail the gate, with the address redacted in the
// report; noreply identities must pass. The in-script self-test (which the gate
// runs on every invocation) covers the legacy-allowance cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('SUITE-ID: asep-suite:pii-scan');

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'pii-scan.sh');

function git(repo: string, args: string[], identity?: { author: string; committer: string }) {
  const env = { ...process.env };
  if (identity) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: identity.author,
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: identity.committer,
    });
  }
  const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', env,
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A repository holding the scanner plus one ordinary file, committed under a
// clean identity. The ordinary file matters: the scanner itself is exempt from
// the file scan, and an empty file list must not be what a test exercises.
function scratchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'asep-pii-meta-'));
  spawnSync('git', ['init', '-q', repo]);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(SCRIPT, join(repo, 'scripts', 'pii-scan.sh'));
  writeFileSync(join(repo, 'NOTES.md'), 'placeholder contact: user@example.com\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'scanner'], {
    author: 'noreply@asep.dev', committer: 'noreply@asep.dev',
  });
  return repo;
}

function scan(repo: string) {
  const r = spawnSync('bash', [join(repo, 'scripts', 'pii-scan.sh')], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('a clean history with noreply identities passes', () => {
  const repo = scratchRepo();
  try {
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-q', '-m', 'docs'], {
      author: '345+someone@users.noreply.github.com', committer: 'bot@asep.invalid',
    });
    const r = scan(repo);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /git author\/committer metadata/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a commit authored under a personal address fails the gate, redacted', () => {
  const repo = scratchRepo();
  try {
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'leak'], {
      author: 'jane.canary@gmail.com', committer: 'noreply@asep.dev',
    });
    const r = scan(repo);
    assert.notEqual(r.code, 0, `personal author email passed the gate:\n${r.out}`);
    assert.match(r.out, /author email j\*\*\*@gmail\.com/);
    // The report must not re-publish the address it is protecting.
    assert.doesNotMatch(r.out, /jane\.canary@gmail\.com/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a personal committer address alone fails the gate', () => {
  const repo = scratchRepo();
  try {
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'committer leak'], {
      author: 'noreply@asep.dev', committer: 'jane.canary@gmail.com',
    });
    const r = scan(repo);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /committer email j\*\*\*@gmail\.com/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a commit reachable only from a remote-tracking ref is scanned', () => {
  const repo = scratchRepo();
  try {
    git(repo, ['checkout', '-q', '--detach']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'remote only'], {
      author: 'jane.canary@gmail.com', committer: 'jane.canary@gmail.com',
    });
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['update-ref', 'refs/remotes/origin/feature', sha]);
    git(repo, ['checkout', '-q', 'main']);
    const r = scan(repo);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /commit [0-9a-f]{12}: author email j\*\*\*@gmail\.com/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the in-script self-test covers the legacy allowance and is green', () => {
  const r = spawnSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  for (const line of [
    'legacy address tolerated on pinned history',
    'legacy address on a newer commit caught',
    'committer-only personal address caught',
    'other personal address on pinned history caught',
    'personal address in a commit trailer caught',
    'missing pinned head fails closed',
  ]) {
    assert.ok(r.stdout.includes(`self-test: PASS (${line})`), `missing self-test line: ${line}`);
  }
});
