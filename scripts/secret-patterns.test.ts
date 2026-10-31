// The shared secret patterns, through both scans that use them.
//
// scripts/lib/secret-patterns.sh feeds the tracked-file scan
// (scripts/secret-scan.sh) and the history scan (check-publication.sh, one
// alternation through git grep over every commit). Each control here runs
// through both, on a throwaway repository: a workflow id must not read as a key,
// and real-looking keys must be caught wherever a key can stand on its own —
// at the start of a line, after `=`, after a quote, after whitespace. The key
// bodies are drawn at run time, so this file holds nothing a scanner would flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'lib', 'secret-patterns.sh');
const SCAN = join(HERE, 'secret-scan.sh');

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const draw = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

// An OpenAI-style secret key, and an Anthropic-style one whose base64url body
// carries an underscore and a dash early, as real ones can.
const openAiKey = () => `${'s'}k-${draw(ALNUM, 48)}`;
const anthropicKey = () => `${'s'}k-ant-api03-${draw(ALNUM, 2)}_${draw(ALNUM, 3)}-${draw(`${ALNUM}_-`, 85)}AA`;

// Where a key stands on its own in a file.
const CONTEXTS: [string, (k: string) => string][] = [
  ['the start of a line', (k) => `${k}\n`],
  ['after =', (k) => `OPENAI_API_KEY=${k}\n`],
  ['after a double quote', (k) => `{"apiKey": "${k}"}\n`],
  ['after a single quote', (k) => `const key = '${k}';\n`],
  ['after a space', (k) => `the key is ${k}\n`],
  ['after a tab', (k) => `key:\t${k}\n`],
];

// Workflow ids: `asep-task-` and a ULID. The tail of "task-" is "sk-", and a
// ULID is 26 letters and digits, so an unbounded `sk-` pattern reads the id as
// a key.
const WORKFLOW_IDS = [
  'asep-task-01JC8Z3K5V7N9QWRT2XYZ4ABCD',
  `asep-task-${draw('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 26)}`,
];
const NEGATIVES = [
  ...WORKFLOW_IDS.map((id) => `workflowId: ${id}\n`),
  ...WORKFLOW_IDS.map((id) => `{"workflowId": "${id}"}\n`),
  ...WORKFLOW_IDS.map((id) => `WORKFLOW_ID=${id}-attempt-1\n`),
  // The same boundary holds for the Anthropic form: inside a longer word it is
  // not a key.
  `slug: whisk-ant-${draw(ALNUM, 24)}\n`,
];

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// A repository holding the scanner, the shared patterns and `files`, committed
// and then removed from the tree in a later commit — so the tracked-file scan
// is run on the first commit and the history scan on the second.
function scans(files: Record<string, string>): { tree: { code: number | null; out: string }; history: string } {
  const repo = mkdtempSync(join(tmpdir(), 'asep-secret-patterns-'));
  try {
    const git = (...a: string[]) => {
      const r = run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], repo);
      assert.equal(r.code, 0, `git ${a.join(' ')}: ${r.out}`);
      return r.out;
    };
    git('init', '-q');
    mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
    copyFileSync(SCAN, join(repo, 'scripts', 'secret-scan.sh'));
    copyFileSync(LIB, join(repo, 'scripts', 'lib', 'secret-patterns.sh'));
    mkdirSync(join(repo, 'controls'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, 'controls', name), content);
    git('add', '.');
    git('commit', '-q', '-m', 'controls');
    const tree = run('bash', [join(repo, 'scripts', 'secret-scan.sh')], repo);
    git('rm', '-q', '-r', 'controls');
    git('commit', '-q', '-m', 'gone from the tree');
    // The history scan's own command: the shared alternation through git grep
    // over every commit, less the scanner files that hold the patterns
    // (check-publication.sh, check_history_secrets).
    const history = run('bash', ['-c',
      '. scripts/lib/secret-patterns.sh; git grep -nE "$SECRET_PATTERNS_ALT" $(git rev-list --all)'
        + " | grep -vE ':(scripts/secret-scan\\.sh|scripts/check-publication\\.sh|scripts/lib/secret-patterns\\.sh):' || true"], repo).out;
    return { tree, history };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('a workflow id is not a key: neither scan flags asep-task-<ULID>', () => {
  const files = Object.fromEntries(NEGATIVES.map((c, i) => [`negative-${i}.txt`, c]));
  const { tree, history } = scans(files);
  assert.equal(tree.code, 0, `the tracked-file scan flagged a workflow id:\n${tree.out}`);
  assert.match(tree.out, /secret-scan: PASS/);
  assert.equal(history.trim(), '', `the history scan flagged a workflow id:\n${history}`);
});

test('an sk- key that stands on its own is caught by both scans, wherever it stands', () => {
  const files: Record<string, string> = {};
  for (const [kind, key] of [['openai', openAiKey], ['anthropic', anthropicKey]] as const) {
    CONTEXTS.forEach(([, place], i) => { files[`${kind}-${i}.txt`] = place(key()); });
  }
  const { tree, history } = scans(files);
  assert.equal(tree.code, 1, `the tracked-file scan must fail:\n${tree.out}`);
  for (const name of Object.keys(files)) {
    const where = CONTEXTS[Number(/-(\d+)\.txt$/.exec(name)![1])]![0];
    assert.match(tree.out, new RegExp(`controls/${name}:1:`), `the tracked-file scan missed ${name} (${where})`);
    assert.match(history, new RegExp(`:controls/${name}:1:`), `the history scan missed ${name} (${where})`);
  }
});
