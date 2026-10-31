import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadReviewPolicy, type ReviewPolicy } from '@asep/policy';
import { buildReviewPacket } from './packet.js';
import {
  isTestPath,
  runDeterministicCheckRules,
  sarifFindings,
  type SarifInput,
  type DeterministicCheckSources,
  type RecordedCheckVerdict,
} from './checks.js';
import { parseUnifiedDiff } from './diff.js';
import { canonicalBytes, sha256Hex } from './canonical-json.js';
import { CheckReportError, buildCheckReport, checkReportSummary, parseCheckReport, reviewerClearance } from './check-report.js';
import { CHECK_RULES, findingFingerprint, type CheckFinding } from './findings.js';
import { SECRET_PATTERNS, findSecrets, javascriptPattern } from './secret-patterns.js';
import type { ArchitectureInvariantRecord } from './local-types.js';
import {
  SARIF_MESSAGE_ID_LOG,
  SARIF_OMITTED_LEVEL_LOG,
  fixtureWorld,
  utf8,
  worldFromDiff,
  type DiffEntry,
  type FixtureWorld,
} from './test-support.js';

console.log('SUITE-ID: asep-suite:assurance-checks');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// Credential-shaped samples are assembled at runtime so no literal secret is committed.
const SAMPLES: readonly string[] = [
  'AKIA' + 'Z'.repeat(16),
  'ASIA' + '7'.repeat(16),
  '-----BEGIN ' + 'RSA PRIVATE KEY' + '-----',
  'ghp_' + 'a'.repeat(36),
  'gho_' + 'b'.repeat(36),
  'github_pat_' + 'c'.repeat(22),
  'xox' + 'b-' + '1'.repeat(10),
  'sk-' + 'ant-' + 'd'.repeat(20),
  'sk-' + 'e'.repeat(20),
  'AIza' + 'f'.repeat(35),
  'eyJ' + 'g'.repeat(10) + '.' + 'h'.repeat(10) + '.' + 'i'.repeat(10),
  'glpat-' + 'j'.repeat(20),
];
const NEAR_MISSES: readonly string[] = [
  'AKIA' + 'Z'.repeat(15),
  'ASIA' + '7'.repeat(15),
  '-----BEGIN ' + 'RSA PUBLIC KEY' + '-----',
  'ghp_' + 'a'.repeat(35),
  'gho_' + 'b'.repeat(35),
  'github_pat_' + 'c'.repeat(21),
  'xox' + 'b-' + '1'.repeat(9),
  'sk-' + 'ant-' + 'd'.repeat(19),
  'sk-' + 'e'.repeat(19),
  'AIza' + 'f'.repeat(34),
  'eyJ' + 'g'.repeat(10) + '.' + 'h'.repeat(9) + '.' + 'i'.repeat(10),
  'glpat-' + 'j'.repeat(19),
];
const AWS_KEY = SAMPLES[0]!;

function optedIn(policy: ReviewPolicy = loadReviewPolicy()): ReviewPolicy {
  return { ...policy, egress: { ...policy.egress, enabledProjects: ['project-1'] } };
}

function checksFor(
  world: FixtureWorld,
  extra: Partial<Omit<DeterministicCheckSources, 'built' | 'contents'>> = {},
): ReturnType<typeof runDeterministicCheckRules> {
  const built = buildReviewPacket(world.sources, world.limits);
  const recordedVerdicts: RecordedCheckVerdict[] = world.sources.execution.evidence.checks.map((c) => ({
    checkId: c.id,
    verdict: c.exitCode === 0 ? 'PASS' : 'FAIL',
  }));
  return runDeterministicCheckRules({
    policy: optedIn(),
    built,
    contents: world.contents,
    recordedVerdicts,
    invariants: [],
    sarif: [],
    ...extra,
  });
}

function rule(findings: readonly CheckFinding[], ruleId: string): CheckFinding[] {
  return findings.filter((f) => f.ruleId === ruleId);
}

const SRC = { allowedPaths: ['src/**', 'assets/**', 'certs/**', 'config/**', 'package.json', 'pnpm-lock.yaml'] };

test('secret patterns match the repository scanner', () => {
  const shell = readFileSync(join(REPO_ROOT, 'scripts', 'lib', 'secret-patterns.sh'), 'utf8');
  const block = /SECRET_PATTERNS=\(\n([\s\S]*?)\n\)/.exec(shell);
  assert.ok(block !== null, 'SECRET_PATTERNS array not found');
  const fromShell = block[1]!
    .split('\n')
    .map((line) => /^\s*'([^']*)'/.exec(line)?.[1])
    .filter((p): p is string => p !== undefined);
  assert.equal(fromShell.length, SAMPLES.length);
  assert.deepEqual(
    SECRET_PATTERNS.map((p) => p.pattern),
    fromShell,
  );

  fromShell.forEach((pattern, i) => {
    const sample = SAMPLES[i]!;
    assert.equal(new RegExp(pattern).test(sample), true, `sample ${i} must match its own pattern`);
    assert.ok(findSecrets(`prefix ${sample} suffix`).some((hit) => hit.patternIndex === i), `scanner misses pattern ${i}`);
    assert.deepEqual(findSecrets(`prefix ${NEAR_MISSES[i]!} suffix`), [], `near miss ${i} must not match`);
  });
});

test('an sk- key counts only where it stands on its own, and a workflow id is never one', () => {
  // Assembled at run time, so this file holds nothing a scanner would flag. The Anthropic-style body is base64url
  // and carries an underscore and a dash early, as real ones can.
  const openAi = 'sk-' + 'Ab3'.repeat(16);
  const anthropic = 'sk-' + 'ant-api03-' + 'x7_Q2-' + 'Zz9'.repeat(10);
  // `asep-task-` and a ULID: the tail of "task-" is "sk-", followed by 26 letters and digits.
  const workflowIds = ['asep-task-' + '01JC8Z3K5V7N9QWRT2XYZ4ABCD', 'asep-task-' + '0123456789ABCDEFGHJKMNPQRS'];

  const negatives = [
    ...workflowIds.map((id) => `workflowId: ${id}\n`),
    ...workflowIds.map((id) => `{"workflowId": "${id}"}\n`),
    ...workflowIds.map((id) => `WORKFLOW_ID=${id}-attempt-1\n`),
    // In JSON text, an escaped line break before the id leaves "task-" in front of the key-shaped tail.
    ...workflowIds.map((id) => JSON.stringify({ log: `started\n${id}` })),
    // Inside a longer word the Anthropic form is no key either.
    'slug: whisk-' + 'ant-' + 'Ab3'.repeat(8) + '\n',
  ];
  for (const text of negatives) assert.deepEqual(findSecrets(text), [], text);

  // Where a key stands on its own, as the repository scanner reads a line; and in JSON text, after an escaped line
  // break or tab, once or twice escaped, since the packet and the reviewer request carry text as JSON strings.
  const contexts: readonly (readonly [string, (k: string) => string])[] = [
    ['the start of a line', (k) => `${k}\n`],
    ['the start of a later line', (k) => `first\n${k}\n`],
    ['after =', (k) => `OPENAI_API_KEY=${k}\n`],
    ['after a double quote', (k) => `{"apiKey": "${k}"}\n`],
    ['after a single quote', (k) => `const key = '${k}';\n`],
    ['after a space', (k) => `the key is ${k}\n`],
    ['after a tab', (k) => `key:\t${k}\n`],
    ['after an escaped line break', (k) => JSON.stringify({ out: `ok\n${k}` })],
    ['after an escaped tab', (k) => JSON.stringify({ out: `ok\t${k}` })],
    ['after an escaped control character', (k) => JSON.stringify({ out: `ok\u0001${k}` })],
    ['after a twice-escaped line break', (k) => JSON.stringify({ input: JSON.stringify({ out: `ok\n${k}` }) })],
  ];
  for (const [label, key] of [['OpenAI-style secret key', openAi], ['Anthropic-style key', anthropic]] as const) {
    for (const [where, place] of contexts) {
      const text = place(key);
      const hits = findSecrets(text);
      assert.ok(hits.some((h) => h.label === label), `${label} ${where}`);
      // The offset is where the key starts, never the character before it.
      for (const h of hits) assert.ok(text.startsWith('sk-', h.offset), `${label} ${where}: offset ${h.offset}`);
    }
  }
  // A boundary anywhere but at the start of a pattern has no JavaScript form here.
  assert.throws(() => javascriptPattern('x(^|[^a])y'), /unsupported boundary/);
});

test('each diff check catches its seeded violation', () => {
  // A clean change trips no push-guard rule.
  const clean = checksFor(fixtureWorld());
  assert.deepEqual(clean.pushGuard, { decision: 'PASS' });
  assert.deepEqual(
    clean.findings.map((f) => f.ruleId),
    [],
  );

  // Secret in an added line: BLOCK, and the finding never repeats the secret.
  const secret = checksFor(
    worldFromDiff([{ path: 'src/config.ts', status: 'A', added: ['// settings', `export const key = '${AWS_KEY}';`] }], SRC),
  );
  assert.deepEqual(secret.pushGuard, { decision: 'BLOCK', reason: 'secret-in-diff' });
  const [hit] = rule(secret.findings, 'secret-in-diff');
  assert.equal(hit?.file, 'src/config.ts');
  assert.equal(hit?.lineStart, 2);
  assert.equal(hit?.severity, 'CRITICAL');
  assert.equal(JSON.stringify(secret).includes(AWS_KEY), false, 'check output repeats the secret');
  // A secret that only leaves the tree (removed line) is not pushed.
  const removed = checksFor(
    worldFromDiff([{ path: 'src/config.ts', status: 'M', context: ['// settings'], removed: [`const key = '${AWS_KEY}';`] }], SRC),
  );
  assert.deepEqual(removed.pushGuard, { decision: 'PASS' });

  // Forbidden or out-of-scope paths: BLOCK.
  for (const entries of [
    [{ path: 'infra/main.tf', status: 'M', context: ['a'], added: ['b'] }],
    [{ path: 'docs/readme.md', status: 'A', added: ['hello'] }],
    [{ path: 'SRC/case.ts', status: 'A', added: ['x'] }],
    [{ path: 'src/moved.tf', oldPath: 'infra/moved.tf', status: 'R', context: ['x'] }],
  ] as const satisfies readonly (readonly DiffEntry[])[]) {
    const result = checksFor(worldFromDiff(entries, { ...SRC, forbiddenChanges: ['infra/**'] }));
    assert.deepEqual(result.pushGuard, { decision: 'BLOCK', reason: 'forbidden-path' }, entries[0]!.path);
    assert.equal(rule(result.findings, 'forbidden-path').length, 1, entries[0]!.path);
  }

  // Content that cannot be scanned at a sensitive path: BLOCK.
  const binary = checksFor(worldFromDiff([{ path: 'certs/server.p12', status: 'A', binary: true }], SRC));
  assert.deepEqual(binary.pushGuard, { decision: 'BLOCK', reason: 'unscannable-sensitive-change' });
  const harmlessBinary = checksFor(worldFromDiff([{ path: 'assets/icon.png', status: 'A', binary: true }], SRC));
  assert.deepEqual(harmlessBinary.pushGuard, { decision: 'PASS' });

  // The most severe reason wins; every rule still reports.
  const both = checksFor(
    worldFromDiff(
      [
        { path: 'infra/main.tf', status: 'A', added: ['x'] },
        { path: 'src/config.ts', status: 'A', added: [`k = '${AWS_KEY}'`] },
      ],
      { ...SRC, forbiddenChanges: ['infra/**'] },
    ),
  );
  assert.deepEqual(both.pushGuard, { decision: 'BLOCK', reason: 'secret-in-diff' });
  assert.equal(rule(both.findings, 'forbidden-path').length, 1);

  // Skip markers added to test files.
  const markers: readonly (readonly [string, string])[] = [
    ['src/greet.test.ts', "test.skip('greets', () => {});"],
    ['src/greet.spec.ts', "it.skip('greets', () => {});"],
    ['src/greet.test.js', "xit('greets', () => {});"],
    ['src/__tests__/greet.ts', "describe.skip('greets', () => {});"],
    ['src/test/java/GreetTest.java', '@Disabled("flaky")'],
    ['src/tests/test_greet.py', '@pytest.mark.skip(reason="later")'],
    ['src/greet_test.go', 't.Skip("later")'],
  ];
  for (const [path, line] of markers) {
    const result = checksFor(worldFromDiff([{ path, status: 'A', added: ['// test', line] }], SRC));
    const [finding] = rule(result.findings, 'skipped-tests-introduced');
    assert.equal(finding?.file, path, path);
    assert.equal(finding?.lineStart, 2, path);
  }
  const notATest = checksFor(worldFromDiff([{ path: 'src/greet.ts', status: 'A', added: ["test.skip('x')"] }], SRC));
  assert.deepEqual(rule(notATest.findings, 'skipped-tests-introduced'), []);

  // A deleted test file.
  const deleted = checksFor(worldFromDiff([{ path: 'src/greet.test.ts', status: 'D', removed: ["test('greets', () => {});"] }], SRC));
  assert.equal(rule(deleted.findings, 'test-file-deleted')[0]?.file, 'src/greet.test.ts');

  // Dependency manifest and lockfile changes are flagged for review, never blocking on their own.
  const deps = checksFor(
    worldFromDiff(
      [
        { path: 'package.json', status: 'M', context: ['{'], added: ['  "left-pad": "1.3.0",'] },
        { path: 'pnpm-lock.yaml', status: 'M', context: ['lockfileVersion: 9.0'], added: ['  left-pad: 1.3.0'] },
      ],
      SRC,
    ),
  );
  assert.equal(rule(deps.findings, 'dependency-manifest-changed')[0]?.file, 'package.json');
  assert.equal(rule(deps.findings, 'lockfile-changed')[0]?.file, 'pnpm-lock.yaml');
  assert.deepEqual(deps.pushGuard, { decision: 'PASS' });
  assert.equal(CHECK_RULES['dependency-manifest-changed'].severity, 'INFO');

  // Forbidden imports declared by an architecture invariant, on added lines only.
  const invariant: ArchitectureInvariantRecord = {
    id: 'INV-1',
    statement: 'domain code never imports the database driver',
    category: 'LAYERING',
    check: { kind: 'forbidden-import', fromGlobs: ['src/domain/**'], specifierPattern: '^(db-driver|legacy-orm)$' },
  };
  const imports = checksFor(
    worldFromDiff(
      [
        { path: 'src/domain/repo.ts', status: 'A', added: ["import { Pool } from 'db-driver';", 'import {', '  Client,', "} from 'legacy-orm';"] },
        { path: 'src/adapters/db.ts', status: 'A', added: ["import { Pool } from 'db-driver';"] },
      ],
      SRC,
    ),
    { invariants: [invariant] },
  );
  // Hits in the same file and line bucket are one finding spanning their lines.
  const importHits = rule(imports.findings, 'forbidden-import:INV-1');
  assert.deepEqual(
    importHits.map((f) => [f.file, f.lineStart, f.lineEnd]),
    [['src/domain/repo.ts', 1, 4]],
  );
  assert.match(importHits[0]!.evidence, /line 1 \(imports 'db-driver'\); line 4 \(imports 'legacy-orm'\)/);
  assert.equal(importHits[0]?.raisedBy, 'deterministic:forbidden-import:INV-1');
  const invalid = checksFor(fixtureWorld(), {
    invariants: [{ ...invariant, check: { ...invariant.check!, specifierPattern: '(' } }],
  });
  assert.equal(rule(invalid.findings, 'invariant-check-invalid').length, 1);

  // An undecodable diff cannot be cleared for push.
  const world = fixtureWorld();
  const bad = new Uint8Array([0x2b, 0xff, 0x0a]);
  const contents = new Map(world.contents).set('art-diff', bad);
  const sources = {
    ...world.sources,
    change: {
      ...world.sources.change,
      cumulativeDiff: { ...world.sources.change.cumulativeDiff, ref: { ...world.sources.change.cumulativeDiff.ref, sha256: sha256Hex(bad) } },
    },
  };
  const undecodable = checksFor({ ...world, sources, contents });
  assert.deepEqual(undecodable.pushGuard, { decision: 'BLOCK', reason: 'unscannable-sensitive-change' });
});


test('invisible and bidirectional characters are flagged', () => {
  const rlo = String.fromCodePoint(0x202e);
  const zwsp = String.fromCodePoint(0x200b);
  const bom = String.fromCodePoint(0xfeff);
  const result = checksFor(
    worldFromDiff(
      [
        {
          path: 'src/access.ts',
          status: 'M',
          context: ['export function canAccess(role: string) {'],
          removed: [`  // old ${rlo} comment`],
          added: [`  if (role === "admin${rlo} ${String.fromCodePoint(0x2066)}") return true;`, `  return false${zwsp};`],
        },
        { path: 'src/bom.ts', status: 'A', added: [`${bom}export const a = 1;`, `export const b = ${bom}2;`] },
      ],
      SRC,
    ),
  );
  const trojan = rule(result.findings, 'trojan-source');
  assert.deepEqual(
    trojan.map((f) => [f.file, f.lineStart, f.lineEnd, f.category, f.severity]),
    [
      ['src/access.ts', 2, 3, 'SECURITY', 'HIGH'],
      ['src/bom.ts', 2, 2, 'SECURITY', 'HIGH'],
    ],
  );
  assert.match(trojan[0]!.evidence, /line 2 \(U\+202E, U\+2066\); line 3 \(U\+200B\)/);
  assert.match(trojan[1]!.evidence, /line 2 \(U\+FEFF\)/);
});

test('seeded false-green evidence is caught', () => {
  const falseGreenRules = [
    'exit-code-verdict-mismatch',
    'failed-tests-recorded-pass',
    'required-check-missing',
    'zero-tests-executed',
    'skipped-tests-introduced',
    'test-file-deleted',
  ];
  const clean = checksFor(fixtureWorld());
  for (const id of falseGreenRules) assert.deepEqual(rule(clean.findings, id), [], id);

  // Zero tests executed while the check exits 0.
  const zero = checksFor(fixtureWorld({ unitStdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n' }));
  const [zeroHit] = rule(zero.findings, 'zero-tests-executed');
  assert.equal(zeroHit?.category, 'EVIDENCE_INTEGRITY');
  assert.equal(zeroHit?.severity, 'HIGH');
  assert.match(zeroHit!.evidence, /unit/);
  // Zero tests executed is a finding whatever the exit code: a failing run that executed
  // nothing proves nothing either.
  const zeroRed = checksFor(fixtureWorld({ unitStdout: 'ℹ tests 0\n', unitExitCode: 1 }));
  assert.equal(rule(zeroRed.findings, 'zero-tests-executed').length, 1);

  // An added skip marker in a test file.
  const skipped = checksFor(worldFromDiff([{ path: 'src/greet.test.ts', status: 'M', context: ['import test from "node:test";'], added: ["test.skip('greets', () => {});"] }], SRC));
  assert.equal(rule(skipped.findings, 'skipped-tests-introduced').length, 1);

  // A check recorded as passing while its raw exit code is non-zero.
  const world = fixtureWorld({ unitExitCode: 3 });
  const mismatch = checksFor(world, { recordedVerdicts: [{ checkId: 'unit', verdict: 'PASS' }, { checkId: 'typecheck', verdict: 'PASS' }] });
  const [mismatchHit] = rule(mismatch.findings, 'exit-code-verdict-mismatch');
  assert.match(mismatchHit!.evidence, /unit/);
  assert.match(mismatchHit!.evidence, /3/);
  assert.equal(mismatchHit?.category, 'EVIDENCE_INTEGRITY');
  const honest = checksFor(world, { recordedVerdicts: [{ checkId: 'unit', verdict: 'FAIL' }, { checkId: 'typecheck', verdict: 'PASS' }] });
  assert.deepEqual(rule(honest.findings, 'exit-code-verdict-mismatch'), []);

  // A required acceptance check missing from the evidence.
  const missing = checksFor(fixtureWorld({ acceptanceCheckIds: ['unit', 'typecheck', 'integration'] }));
  const missingHits = rule(missing.findings, 'required-check-missing');
  assert.equal(missingHits.length, 1);
  assert.match(missingHits[0]!.evidence, /integration/);

  for (const id of falseGreenRules) assert.ok(CHECK_RULES[id as keyof typeof CHECK_RULES], id);
});

test('false green counts executed tests and recorded failures', () => {
  const pass = (checkId: string): RecordedCheckVerdict => ({ checkId, verdict: 'PASS' });
  const fail = (checkId: string): RecordedCheckVerdict => ({ checkId, verdict: 'FAIL' });
  const fired = (unitStdout: string, unitExitCode: number, unit: RecordedCheckVerdict) => {
    const result = checksFor(fixtureWorld({ unitStdout, unitExitCode }), { recordedVerdicts: [unit, pass('typecheck')] });
    return ['zero-tests-executed', 'failed-tests-recorded-pass', 'exit-code-verdict-mismatch'].filter(
      (id) => rule(result.findings, id).length > 0,
    );
  };
  const cases: readonly (readonly [string, string, number, RecordedCheckVerdict, readonly string[]])[] = [
    // The review's probes.
    ['every test skipped', 'ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 3\n', 0, pass('unit'), ['zero-tests-executed']],
    ['a failure recorded as a pass', 'ℹ tests 1\nℹ pass 0\nℹ fail 1\n', 0, pass('unit'), ['failed-tests-recorded-pass']],
    // Executed is tests minus skipped minus todo.
    ['skipped and todo cover every test', 'ℹ tests 3\nℹ pass 0\nℹ fail 0\nℹ skipped 1\nℹ todo 2\n', 0, pass('unit'), ['zero-tests-executed']],
    ['one test executed', 'ℹ tests 3\nℹ pass 1\nℹ fail 0\nℹ skipped 2\n', 0, pass('unit'), []],
    ['nothing executed in a red run', 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n', 1, fail('unit'), ['zero-tests-executed']],
    ['Vitest, every test skipped', ' Tests  2 skipped (2)\n', 0, pass('unit'), ['zero-tests-executed']],
    ['TAP, every test todo', '# tests 2\n# pass 0\n# todo 2\n', 0, pass('unit'), ['zero-tests-executed']],
    ['Jest, a failure recorded as a pass', 'Tests:       1 failed, 1 passed, 2 total\n', 0, pass('unit'), ['failed-tests-recorded-pass']],
    // An honest red run, and a red run recorded green on both counts.
    ['a failure recorded as a failure', 'ℹ tests 1\nℹ pass 0\nℹ fail 1\n', 1, fail('unit'), []],
    ['a red run recorded as a pass', 'ℹ tests 1\nℹ pass 0\nℹ fail 1\n', 1, pass('unit'), ['failed-tests-recorded-pass', 'exit-code-verdict-mismatch']],
    // An unrecognized format has no summary; nothing is guessed from it.
    ['unknown format', 'ran 0 checks, 0 failed\n', 0, pass('unit'), []],
    ['unknown format in a red run', 'ran 0 checks, 1 failed\n', 1, fail('unit'), []],
  ];
  for (const [label, stdout, exitCode, recorded, expected] of cases) {
    assert.deepEqual(fired(stdout, exitCode, recorded), expected, label);
  }
  const unknown = buildReviewPacket(fixtureWorld({ unitStdout: 'ran 0 checks\n' }).sources, fixtureWorld().limits);
  assert.equal(unknown.packet.execution.checks.find((c) => c.id === 'unit')?.testSummary, null);
  const failure = rule(checksFor(fixtureWorld({ unitStdout: 'ℹ tests 1\nℹ pass 0\nℹ fail 1\n' }), { recordedVerdicts: [pass('unit')] }).findings, 'failed-tests-recorded-pass');
  assert.deepEqual(failure.map((f) => [f.severity, f.category]), [['HIGH', 'EVIDENCE_INTEGRITY']]);
});

test('a SARIF log is one blocking finding a human must close, never parsed', () => {
  // Stated independently of the reader: the one finding of a log, named by its check and digest.
  const expected = (checkId: string, content: Uint8Array) => {
    const sha256 = sha256Hex(content);
    return {
      source: 'sarif',
      raisedBy: 'sarif:unparsed',
      ruleId: 'sarif-unparsed',
      severity: 'HIGH',
      category: 'EVIDENCE_INTEGRITY',
      file: null,
      lineStart: null,
      lineEnd: null,
      fingerprint: sha256Hex(JSON.stringify(['EVIDENCE_INTEGRITY', JSON.stringify(['sarif-log', checkId, sha256]), null, 'sarif-unparsed'])),
      cites: [`"${checkId}"`, sha256, `${content.byteLength} bytes`],
    };
  };
  const observed = (f: CheckFinding, cites: readonly string[]) => {
    for (const cite of cites) assert.ok(f.evidence.includes(cite), `evidence cites ${cite}`);
    const { evidence: _evidence, requiredFix: _requiredFix, ...rest } = f;
    return { ...rest, cites };
  };
  const logs: readonly (readonly [string, Uint8Array])[] = [
    ['a message reference', utf8(JSON.stringify(SARIF_MESSAGE_ID_LOG))],
    ['an omitted level', utf8(JSON.stringify(SARIF_OMITTED_LEVEL_LOG))],
    ['not JSON', utf8('{')],
    ['not UTF-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['empty', new Uint8Array()],
  ];
  for (const [label, content] of logs) {
    const findings = sarifFindings({ checkId: 'semgrep', content });
    assert.equal(findings.length, 1, label);
    const want = expected('semgrep', content);
    assert.deepEqual(observed(findings[0]!, want.cites), want, label);
  }

  // Through the round's checks: two logs are two findings, whatever order they arrive in.
  const two = logs.slice(0, 2).map(([, content], i) => ({ checkId: `scan-${i}`, content }));
  const sarifOf = (inputs: readonly SarifInput[]) => checksFor(fixtureWorld(), { sarif: inputs }).findings.filter((f) => f.source === 'sarif');
  const both = sarifOf(two);
  assert.deepEqual(both.map((f) => f.fingerprint).sort(), two.map((t) => expected(t.checkId, t.content).fingerprint).sort());
  assert.deepEqual(sarifOf([...two].reverse()), both);
  assert.equal(checksFor(fixtureWorld(), { sarif: two }).findings.some((f) => f.ruleId === 'sarif-malformed'), false);
  // The same bytes under two checks are two findings, and a new log of one check is a new finding.
  const same = utf8(JSON.stringify(SARIF_MESSAGE_ID_LOG));
  assert.equal(new Set(sarifOf([{ checkId: 'a', content: same }, { checkId: 'b', content: same }]).map((f) => f.fingerprint)).size, 2);
  const again = sarifOf([{ checkId: 'scan-0', content: utf8(JSON.stringify({ ...SARIF_MESSAGE_ID_LOG, runs: [] })) }]);
  assert.notEqual(again[0]!.fingerprint, both.find((f) => f.evidence.includes('"scan-0"'))!.fingerprint);
});

test('git diffs are read line by line', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-gone',
    '+++plus is content',
    '+--- minus is content',
    ' tail',
    '\\ No newline at end of file',
    '@@ -10,0 +11,1 @@',
    '+late',
    'diff --git a/old name.ts b/new name.ts',
    'similarity index 100%',
    'rename from old name.ts',
    'rename to new name.ts',
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/caf\\303\\251.ts"',
    '@@ -0,0 +1 @@',
    '+x',
    'diff --git a/bin.dat b/bin.dat',
    'deleted file mode 100644',
    'Binary files a/bin.dat and /dev/null differ',
    'diff --git a/src/a.ts b/src/copy.ts',
    'similarity index 100%',
    'copy from src/a.ts',
    'copy to src/copy.ts',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.status, f.binary]),
    [
      ['src/a.ts', null, 'M', false],
      ['new name.ts', 'old name.ts', 'R', false],
      ['café.ts', null, 'A', false],
      ['bin.dat', null, 'D', true],
      ['src/copy.ts', 'src/a.ts', 'C', false],
    ],
  );
  const a = files[0]!;
  assert.deepEqual(a.added, [
    { line: 2, text: '++plus is content' },
    { line: 3, text: '--- minus is content' },
    { line: 11, text: 'late' },
  ]);
  assert.deepEqual(a.removed, [{ line: 2, text: 'gone' }]);
  assert.deepEqual(a.hunks, [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
    { oldStart: 10, oldLines: 0, newStart: 11, newLines: 1 },
  ]);
  assert.throws(() => parseUnifiedDiff('diff --git a/x b/x\n@@ -1 +1 @@\n+a\n+b\n'));
  assert.equal(isTestPath('src/a.test.ts'), true);
  assert.equal(isTestPath('src/a.ts'), false);
});

test('check findings are fingerprinted, de-duplicated and ordered', () => {
  const result = checksFor(
    worldFromDiff([{ path: 'src/config.ts', status: 'A', added: [`a = '${AWS_KEY}'`, `b = '${AWS_KEY}'`] }], SRC),
  );
  // Two hits in the same line bucket of one file are one finding.
  assert.equal(rule(result.findings, 'secret-in-diff').length, 1);
  const f = result.findings[0]!;
  assert.equal(f.fingerprint, findingFingerprint({ category: f.category, file: f.file, lineStart: f.lineStart, ruleId: f.ruleId }));
  assert.match(f.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    findingFingerprint({ category: 'SECURITY', file: 'a.ts', lineStart: 1, ruleId: 'r' }),
    findingFingerprint({ category: 'SECURITY', file: 'a.ts', lineStart: 9, ruleId: 'r' }),
  );
  assert.notEqual(
    findingFingerprint({ category: 'SECURITY', file: 'a.ts', lineStart: 1, ruleId: 'r' }),
    findingFingerprint({ category: 'SECURITY', file: 'a.ts', lineStart: 11, ruleId: 'r' }),
  );
  // Same input, same output.
  const again = checksFor(
    worldFromDiff([{ path: 'src/config.ts', status: 'A', added: [`a = '${AWS_KEY}'`, `b = '${AWS_KEY}'`] }], SRC),
  );
  assert.deepEqual(again, result);
  for (const finding of result.findings) assert.match(finding.raisedBy, /^(deterministic|sarif):/);
});

test('check identity keys are canonical tuples and never collide', () => {
  // The fingerprint is the sha256 of the canonical JSON tuple, computed here independently.
  const oracle = (category: string, file: string | null, lineStart: number | null, ruleId: string | null) =>
    sha256Hex(JSON.stringify([category, file, lineStart === null ? null : Math.floor(lineStart / 10), ruleId]));
  const fp = (file: string | null, lineStart: number | null, ruleId: string | null) =>
    findingFingerprint({ category: 'CORRECTNESS', file, lineStart, ruleId });
  for (const [file, lineStart, ruleId] of [['src/a.ts', 12, 'r'], [null, null, null], ['', 0, '']] as const) {
    assert.equal(fp(file, lineStart, ruleId), oracle('CORRECTNESS', file, lineStart, ruleId));
  }
  // null and "" differ; a separator inside a field cannot shift it into the next one.
  assert.notEqual(fp(null, null, 'r'), fp('', null, 'r'));
  assert.notEqual(fp('src/a.ts', 1, null), fp('src/a.ts', 1, ''));
  assert.notEqual(fp('x\n1', null, 'r'), fp('x', 10, '\nr'));

  // A diff whose one path joins two of the packet's paths with a line feed does not match the
  // packet, so nothing is scanned from it.
  const escaped = 'src/a.ts\\nsrc/b.ts';
  const diff = [
    `diff --git "a/${escaped}" "b/${escaped}"`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ "b/${escaped}"`,
    '@@ -0,0 +1 @@',
    '+export const a = 1;',
    '',
  ].join('\n');
  const world = fixtureWorld({
    diff,
    files: [
      { path: 'src/a.ts', status: 'A', content: 'export const a = 1;\n' },
      { path: 'src/b.ts', status: 'A', content: 'export const a = 1;\n' },
    ],
  });
  assert.equal(rule(checksFor(world).findings, 'unscannable-sensitive-change').length, 1);
});

test('the check report is canonical and fails closed when it is read back', () => {
  const sarif = [{ checkId: 'lint', content: utf8(JSON.stringify(SARIF_OMITTED_LEVEL_LOG)) }];
  const reportFor = (world: FixtureWorld, inputs: typeof sarif = []) => ({
    result: checksFor(world, { sarif: inputs }),
    packetSha256: buildReviewPacket(world.sources, world.limits).sha256,
  });

  // Canonical and input-derived: the same checks give the same bytes, and the parser returns the report.
  const { result, packetSha256 } = reportFor(fixtureWorld({ unitStdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n' }), sarif);
  const report = buildCheckReport(result, { packetSha256, sarif });
  assert.deepEqual(buildCheckReport(result, { packetSha256, sarif }).bytes, report.bytes);
  assert.equal(report.sha256, sha256Hex(report.bytes));
  assert.deepEqual(parseCheckReport(report.bytes, report.sha256), report.report);
  assert.deepEqual(Object.keys(report.report).sort(), ['egress', 'findings', 'packetSha256', 'pushGuard', 'reportVersion', 'sarifInputs']);
  assert.deepEqual(report.report.findings, result.findings);
  assert.deepEqual(report.report.sarifInputs, [{ checkId: 'lint', sha256: sha256Hex(sarif[0]!.content), bytes: sarif[0]!.content.byteLength }]);
  // A log listed twice under its check is one finding, and its report still reads back.
  const twice = [...sarif, ...sarif];
  const repeated = reportFor(fixtureWorld(), twice);
  const listedTwice = buildCheckReport(repeated.result, { packetSha256: repeated.packetSha256, sarif: twice });
  assert.equal(listedTwice.report.findings.filter((f) => f.source === 'sarif').length, 1);
  assert.deepEqual(parseCheckReport(listedTwice.bytes, listedTwice.sha256), listedTwice.report);

  // The step's summary counts and the clearance a reviewer request is checked against.
  const blocking = result.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
  assert.ok(blocking > 0, 'the zero-test run must raise a blocking finding');
  assert.deepEqual(
    result.findings.filter((f) => f.source === 'sarif').map((f) => [f.ruleId, f.severity]),
    [['sarif-unparsed', 'HIGH']],
    'the log is one HIGH finding',
  );
  assert.deepEqual(checkReportSummary(report.report, ['CRITICAL', 'HIGH']), { total: result.findings.length, blocking });
  assert.deepEqual(reviewerClearance(report.report), { pushGuard: { decision: 'PASS' }, egress: { decision: 'CLEAR', packetSha256 } });

  // A blocked round's report keeps the block and the egress stop it implies.
  const leaked = reportFor(worldFromDiff([{ path: 'src/k.ts', status: 'A', added: [`const k = '${AWS_KEY}';`] }], SRC));
  const blocked = buildCheckReport(leaked.result, { packetSha256: leaked.packetSha256, sarif: [] });
  assert.deepEqual(reviewerClearance(blocked.report), {
    pushGuard: { decision: 'BLOCK', reason: 'secret-in-diff' },
    egress: { decision: 'STOP_SECRET', packetSha256: leaked.packetSha256 },
  });
  assert.equal(new TextDecoder().decode(blocked.bytes).includes(AWS_KEY), false, 'the report never carries the matched text');

  // A report for another packet is never built.
  assert.throws(() => buildCheckReport(result, { packetSha256: 'f'.repeat(64), sarif }), CheckReportError);

  // Every tampered or inconsistent report is refused.
  const docOf = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const clean = docOf(report.bytes);
  const stopped = docOf(blocked.bytes);
  const cleanEgress = clean['egress'] as Record<string, unknown>;
  const stoppedEgress = stopped['egress'] as Record<string, unknown>;
  const firstFinding = result.findings[0]!;
  const cleanFindings = clean['findings'] as Record<string, unknown>[];
  const sarifFinding = cleanFindings.find((f) => f['source'] === 'sarif')!;
  const withoutSarif = cleanFindings.filter((f) => f !== sarifFinding);
  const reread = (value: unknown) => {
    const bytes = canonicalBytes(value);
    return () => parseCheckReport(bytes, sha256Hex(bytes));
  };
  const tampered: readonly (readonly [string, () => unknown])[] = [
    ['digest mismatch', () => parseCheckReport(report.bytes, 'f'.repeat(64))],
    ['not JSON', () => parseCheckReport(utf8('{'), sha256Hex(utf8('{')))],
    ['not UTF-8', () => parseCheckReport(new Uint8Array([0x7b, 0xff, 0x7d]), sha256Hex(new Uint8Array([0x7b, 0xff, 0x7d])))],
    ['unknown key', reread({ ...clean, extra: true })],
    ['missing key', reread(Object.fromEntries(Object.entries(clean).filter(([key]) => key !== 'findings')))],
    ['wrong version', reread({ ...clean, reportVersion: 'check-report/v0' })],
    ['egress for another packet', reread({ ...clean, egress: { ...cleanEgress, packetSha256: 'f'.repeat(64) } })],
    ['clear despite stop hits', reread({ ...stopped, egress: { ...stoppedEgress, decision: 'CLEAR' } })],
    ['stop without hits', reread({ ...clean, egress: { ...cleanEgress, decision: 'STOP_SECRET' } })],
    ['a stop its hits do not imply', reread({ ...stopped, egress: { ...stoppedEgress, decision: 'STOP_CLASSIFIED' } })],
    ['unknown hit kind', reread({ ...stopped, egress: { ...stoppedEgress, hits: [{ kind: 'other', part: 'diff', detail: 'x' }] } })],
    ['unknown push-guard reason', reread({ ...stopped, pushGuard: { decision: 'BLOCK', reason: 'other' } })],
    ['block without its finding', reread({ ...clean, pushGuard: { decision: 'BLOCK', reason: 'secret-in-diff' } })],
    ['pass despite a blocking finding', reread({ ...stopped, pushGuard: { decision: 'PASS' } })],
    ['another block reason', reread({ ...stopped, pushGuard: { decision: 'BLOCK', reason: 'forbidden-path' } })],
    ['pass with a reason', reread({ ...clean, pushGuard: { decision: 'PASS', reason: 'secret-in-diff' } })],
    ['unknown severity', reread({ ...clean, findings: [{ ...firstFinding, severity: 'SEVERE' }] })],
    ['bad line range', reread({ ...clean, findings: [{ ...firstFinding, lineStart: null, lineEnd: 3 }] })],
    ['raiser of another source', reread({ ...clean, findings: [{ ...firstFinding, raisedBy: 'sarif:x' }] })],
    ['short fingerprint', reread({ ...clean, findings: [{ ...firstFinding, fingerprint: 'abc' }] })],
    ['a listed SARIF log without its finding', reread({ ...clean, findings: withoutSarif })],
    ['a SARIF finding for no listed log', reread({ ...clean, sarifInputs: [] })],
    ['a SARIF finding at another severity', reread({ ...clean, findings: [...withoutSarif, { ...sarifFinding, severity: 'MEDIUM' }] })],
    ['a SARIF finding of another log', reread({ ...clean, findings: [...withoutSarif, { ...sarifFinding, fingerprint: 'b'.repeat(64) }] })],
    ['a SARIF finding twice', reread({ ...clean, findings: [...cleanFindings, sarifFinding] })],
    ['a parsed SARIF result', reread({ ...clean, findings: [...withoutSarif, { ...sarifFinding, ruleId: 'js.eval-use', raisedBy: 'sarif:semgrep' }] })],
    ['negative sarif size', reread({ ...clean, sarifInputs: [{ checkId: 'lint', sha256: 'a'.repeat(64), bytes: -1 }] })],
    ['a scanner-run record', reread({ ...clean, scannerRuns: [] })],
  ];
  for (const [label, read] of tampered) assert.throws(read, CheckReportError, label);
});

test('the check report lists SARIF logs in one order whatever order they arrive in', () => {
  // Two logs of one check and the log of an earlier check whose digest sorts after both, so neither key alone gives
  // the order. In every arrival order: one report, its logs listed by check id and then digest.
  const world = fixtureWorld();
  const packetSha256 = buildReviewPacket(world.sources, world.limits).sha256;
  const same = [SARIF_MESSAGE_ID_LOG, SARIF_OMITTED_LEVEL_LOG].map((log) => utf8(JSON.stringify(log)));
  const latest = same.map((c) => sha256Hex(c)).sort()[1]!;
  const late = Array.from({ length: 256 }, (_, i) => utf8(`{"n":${i}}`)).find((c) => sha256Hex(c) > latest);
  assert.ok(late !== undefined, 'a log whose digest sorts after both');
  const logs: readonly SarifInput[] = [
    { checkId: 'semgrep', content: same[0]! },
    { checkId: 'semgrep', content: same[1]! },
    { checkId: 'codeql', content: late },
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const reports = orders.map((order) => {
    const sarif = order.map((i) => logs[i]!);
    return buildCheckReport(checksFor(world, { sarif }), { packetSha256, sarif });
  });
  for (const [i, r] of reports.entries()) assert.deepEqual(r.bytes, reports[0]!.bytes, `order ${orders[i]!.join()}`);
  const [first, second] = [sha256Hex(logs[0]!.content), sha256Hex(logs[1]!.content)].sort();
  assert.deepEqual(
    reports[0]!.report.sarifInputs.map((s) => [s.checkId, s.sha256]),
    [['codeql', sha256Hex(logs[2]!.content)], ['semgrep', first], ['semgrep', second]],
  );
});

test('the check summary counts a SARIF finding as blocking whatever the severity policy says', () => {
  const sarif: readonly SarifInput[] = [{ checkId: 'semgrep', content: utf8(JSON.stringify(SARIF_OMITTED_LEVEL_LOG)) }];
  const reportOf = (world: FixtureWorld) =>
    buildCheckReport(checksFor(world, { sarif }), { packetSha256: buildReviewPacket(world.sources, world.limits).sha256, sarif }).report;

  // A clean round: the log's finding is the only one, and it blocks under every policy, one without HIGH included.
  const clean = reportOf(fixtureWorld());
  assert.deepEqual(clean.findings.map((f) => [f.source, f.severity]), [['sarif', 'HIGH']]);
  for (const policy of [['CRITICAL'], ['CRITICAL', 'HIGH'], ['INFO']] as const) {
    assert.deepEqual(checkReportSummary(clean, policy), { total: 1, blocking: 1 }, policy.join());
  }

  // Other findings still count by the policy: the zero-test run's HIGH findings block only under a policy with HIGH,
  // and the SARIF finding beside them counts once under both.
  const zero = reportOf(fixtureWorld({ unitStdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n' }));
  const deterministic = zero.findings.filter((f) => f.source === 'deterministic');
  assert.ok(deterministic.length > 0 && deterministic.every((f) => f.severity === 'HIGH'), 'the zero-test run raises HIGH findings only');
  const total = deterministic.length + 1;
  assert.deepEqual(checkReportSummary(zero, ['CRITICAL']), { total, blocking: 1 });
  assert.deepEqual(checkReportSummary(zero, ['CRITICAL', 'HIGH']), { total, blocking: total });
});
