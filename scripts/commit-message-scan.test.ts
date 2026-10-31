// The commit-message gate (scripts/commit-message-scan.sh), on throwaway
// repositories: a new commit whose message carries an AI attribution trailer,
// or a finding code in its subject or its body, fails the gate; a commit the
// pinned history holds, and a clean new commit, pass. The codes and trailers are
// assembled at run time, so this file carries none of them itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'commit-message-scan.sh');
const REPO_ROOT = join(HERE, '..');

const code = (...parts: string[]) => parts.join('-');
const trailer = `Co-Authored-By: ${'Clau'}de <noreply@${'anthro'}pic.com>`;

function scratch(): { repo: string; commit: (msg: string) => string } {
  const repo = mkdtempSync(join(tmpdir(), 'asep-commit-msg-'));
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], {
      cwd: repo, encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  return {
    repo,
    commit(msg) {
      git('commit', '-q', '--allow-empty', '-m', msg);
      return git('rev-parse', 'HEAD');
    },
  };
}

// The scanner's verdict on HEAD's history in `repo`, tolerating what `pinned`
// reaches: the gate's own function, with the pins a test chooses.
function scan(repo: string, pinned: string[] = [], path = process.env['PATH']): { flagged: boolean; out: string } {
  // bash by its path: a test may hand the scanner a PATH without it.
  const r = spawnSync('/bin/bash',
    ['-c', `. "${SCRIPT}"; scan_commit_messages "$1" HEAD "\${@:2}"`, 'scan', repo, ...pinned], {
      encoding: 'utf8', env: { ...process.env, PATH: path },
    });
  assert.ok(r.status === 0 || r.status === 1, `the scanner failed: ${r.stderr}`);
  return { flagged: r.status === 0, out: r.stdout };
}

test('a new commit with an AI attribution trailer fails the gate', () => {
  const s = scratch();
  try {
    const pinned = s.commit('chore: start');
    s.commit(`fix(gate): a change\n\nIt does the thing.\n\n${trailer}`);
    const r = scan(s.repo, [pinned]);
    assert.ok(r.flagged, r.out);
    assert.match(r.out, /AI attribution trailer/);
    assert.match(r.out, /AI attribution address/);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test('a "Generated with" line naming Claude fails the gate', () => {
  const s = scratch();
  try {
    const pinned = s.commit('chore: start');
    s.commit(`docs: a change\n\nGenerated with ${'Clau'}de Code`);
    const r = scan(s.repo, [pinned]);
    assert.ok(r.flagged, r.out);
    assert.match(r.out, /AI attribution line/);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test('a finding code in the subject fails the gate', () => {
  const s = scratch();
  try {
    const pinned = s.commit('chore: start');
    s.commit(`fix(gate): repair the scan (${code('CYCLE9', 'HIGH', '004')})`);
    const r = scan(s.repo, [pinned]);
    assert.ok(r.flagged, r.out);
    assert.match(r.out, /finding code: fix\(gate\): repair the scan/);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test('a finding code in the body fails the gate, with or without its prefix', () => {
  for (const found of [code('P2', 'FINAL', 'MED', '012'), code('LOW', '001'), code('P1', 'REREVIEW', 'CRIT', '001')]) {
    const s = scratch();
    try {
      const pinned = s.commit('chore: start');
      s.commit(`fix(gate): repair the scan\n\nThis closes ${found} for good.`);
      const r = scan(s.repo, [pinned]);
      assert.ok(r.flagged, `${found}: ${r.out}`);
      assert.match(r.out, /finding code: This closes/);
    } finally {
      rmSync(s.repo, { recursive: true, force: true });
    }
  }
});

test('a commit the pinned history holds passes, whatever its message; one after it does not', () => {
  const s = scratch();
  try {
    s.commit(`fix: older work (${code('CYCLE3', 'HIGH', '001')})\n\n${trailer}`);
    const pinned = s.commit(`docs: also older (${code('P1', 'MED', '002')})`);
    assert.deepEqual(scan(s.repo, [pinned]), { flagged: false, out: '' }, 'everything the pin reaches is tolerated');
    s.commit(`fix: newer work (${code('CYCLE4', 'LOW', '003')})`);
    const r = scan(s.repo, [pinned]);
    assert.ok(r.flagged, r.out);
    assert.equal(r.out.trim().split('\n').length, 1, `only the new commit is reported: ${r.out}`);
    // A pin the clone does not hold vouches for nothing.
    assert.ok(scan(s.repo, ['0'.repeat(40)]).flagged, 'a missing pin fails closed');
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test('a clean new commit passes, and so does prose that names severities without a code', () => {
  const s = scratch();
  try {
    const pinned = s.commit('chore: start');
    s.commit('fix(gate): take the base from origin/main\n\nA high or low risk, medium effort; co-authored by the team.\n\nCo-Authored-By: Jane Doe <jane@example.invalid>');
    assert.deepEqual(scan(s.repo, [pinned]), { flagged: false, out: '' });
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test('a history the scanner cannot read fails the gate rather than passing it', () => {
  // A repository without a commit has no HEAD to read.
  const s = scratch();
  try {
    const r = scan(s.repo);
    assert.ok(r.flagged, r.out);
    assert.match(r.out, /commit-message scanner failed/);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
  }
});

test('a scanner that cannot run its matcher fails the gate rather than passing it', () => {
  // Only what the scanner needs but perl on the PATH.
  const s = scratch();
  const bin = mkdtempSync(join(tmpdir(), 'asep-commit-msg-bin-'));
  try {
    s.commit(`fix: newer work (${code('CYCLE4', 'LOW', '003')})`);
    for (const tool of ['git', 'mktemp', 'rm']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, join(bin, tool));
    }
    const r = scan(s.repo, [], bin);
    assert.ok(r.flagged, r.out);
    assert.match(r.out, /commit-message scanner failed \(exit 127\)/);
  } finally {
    rmSync(s.repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('the gate passes on this repository: its history before the pins is tolerated, every newer commit is clean', () => {
  const r = spawnSync('bash', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /commit-message-scan: PASS/);
});

test('the publication gate runs the commit-message gate', () => {
  const src = readFileSync(join(HERE, 'check-publication.sh'), 'utf8');
  assert.match(src, /\n {2}if bash scripts\/commit-message-scan\.sh > \/tmp\/asep-msg-deleg\.\$\$ 2>&1; then\n/);
  assert.match(src, /\n {4}fail=1\n {2}fi\n {2}rm -f \/tmp\/asep-msg-deleg\.\$\$\n/);
});
