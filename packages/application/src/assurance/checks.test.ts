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
  type DeterministicCheckSources,
  type RecordedCheckVerdict,
} from './checks.js';
import { parseUnifiedDiff } from './diff.js';
import { canonicalBytes, sha256Hex } from './canonical-json.js';
import { CheckReportError, buildCheckReport, checkReportSummary, parseCheckReport, reviewerClearance } from './check-report.js';
import { CHECK_RULES, findingFingerprint, type CheckFinding } from './findings.js';
import { SECRET_PATTERNS, findSecrets } from './secret-patterns.js';
import type { ArchitectureInvariantRecord } from './local-types.js';
import { fixtureWorld, utf8, worldFromDiff, type DiffEntry, type FixtureWorld } from './test-support.js';

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
  // A failing run with zero tests is already red; it is not a false green.
  const zeroRed = checksFor(fixtureWorld({ unitStdout: 'ℹ tests 0\n', unitExitCode: 1 }));
  assert.deepEqual(rule(zeroRed.findings, 'zero-tests-executed'), []);

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

test('sarif results become findings and malformed sarif fails closed', () => {
  const sarif = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Semgrep OSS' } },
        results: [
          {
            ruleId: 'js.eval-use',
            level: 'error',
            message: { text: 'eval() on user input' },
            properties: { tags: ['Security'] },
            locations: [{ physicalLocation: { artifactLocation: { uri: './src/feature.ts' }, region: { startLine: 2, endLine: 3 } } }],
          },
          { ruleId: 'style.note', level: 'note', message: { text: 'consider renaming' } },
          {
            message: { text: 'absolute location' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///etc/passwd' }, region: { startLine: 1 } } }],
          },
        ],
      },
    ],
  };
  const findings = sarifFindings({ checkId: 'semgrep', content: utf8(JSON.stringify(sarif)) });
  assert.equal(findings.length, 3);
  const [first, second, third] = findings;
  assert.equal(first?.source, 'sarif');
  assert.equal(first?.raisedBy, 'sarif:semgrep-oss');
  assert.equal(first?.severity, 'HIGH');
  assert.equal(first?.category, 'SECURITY');
  assert.deepEqual([first?.file, first?.lineStart, first?.lineEnd], ['src/feature.ts', 2, 3]);
  assert.equal(first?.ruleId, 'js.eval-use');
  assert.equal(second?.severity, 'LOW');
  assert.equal(second?.file, null);
  assert.equal(third?.severity, 'MEDIUM');
  assert.equal(third?.file, null);

  const malformed: readonly (readonly [string, Uint8Array])[] = [
    ['not json', utf8('{')],
    ['not utf-8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['wrong version', utf8(JSON.stringify({ ...sarif, version: '2.0.0' }))],
    ['no runs', utf8(JSON.stringify({ version: '2.1.0' }))],
    ['run without results', utf8(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'x' } } }] }))],
    ['run without tool name', utf8(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: {} }, results: [] }] }))],
    [
      'unknown level',
      utf8(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'x' } }, results: [{ level: 'fatal', message: { text: 'm' } }] }] })),
    ],
    [
      'result without text',
      utf8(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'x' } }, results: [{ message: {} }] }] })),
    ],
    [
      'bad region',
      utf8(
        JSON.stringify({
          version: '2.1.0',
          runs: [
            {
              tool: { driver: { name: 'x' } },
              results: [
                {
                  message: { text: 'm' },
                  locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 0 } } }],
                },
              ],
            },
          ],
        }),
      ),
    ],
  ];
  for (const [label, content] of malformed) {
    const result = sarifFindings({ checkId: 'semgrep', content });
    assert.equal(result.length, 1, label);
    assert.equal(result[0]?.ruleId, 'sarif-malformed', label);
    assert.equal(result[0]?.severity, 'HIGH', label);
    assert.equal(result[0]?.category, 'EVIDENCE_INTEGRITY', label);
  }

  // SARIF findings flow through the aggregate check run.
  const all = checksFor(fixtureWorld(), { sarif: [{ checkId: 'semgrep', content: utf8(JSON.stringify(sarif)) }] });
  assert.equal(all.findings.filter((f) => f.source === 'sarif').length, 3);
});

test('sarif logs record the scanner runs a recheck needs', () => {
  const log = (...runs: unknown[]) => utf8(JSON.stringify({ version: '2.1.0', runs }));
  const runsOf = (checkId: string, content: Uint8Array) => checksFor(fixtureWorld(), { sarif: [{ checkId, content }] }).scannerRuns;
  const driver = (extra: Record<string, unknown>) => ({ tool: { driver: { name: 'Semgrep OSS', ...extra } }, results: [] });

  assert.deepEqual(
    runsOf(
      'semgrep',
      log({
        ...driver({ version: '1.90.0', rules: [{ id: 'js.eval-use' }, { id: 'js.xss' }] }),
        invocations: [{ executionSuccessful: true }, { executionSuccessful: true }],
      }),
    ),
    [{ checkId: 'semgrep', tool: 'semgrep-oss', toolVersion: '1.90.0', rules: ['js.eval-use', 'js.xss'], executionSuccessful: true }],
  );
  // The semantic version stands in for a missing version; no version is recorded as null.
  assert.deepEqual(
    runsOf('semgrep', log({ ...driver({ semanticVersion: '2.0.1' }), invocations: [{ executionSuccessful: true }] })).map((r) => r.toolVersion),
    ['2.0.1'],
  );
  assert.deepEqual(runsOf('semgrep', log({ ...driver({}), invocations: [{ executionSuccessful: true }] })).map((r) => r.toolVersion), [null]);
  // Completion is proven only by invocations that all report success.
  assert.deepEqual(
    [
      runsOf('semgrep', log(driver({ version: '1' }))),
      runsOf('semgrep', log({ ...driver({ version: '1' }), invocations: [] })),
      runsOf('semgrep', log({ ...driver({ version: '1' }), invocations: [{ executionSuccessful: true }, { executionSuccessful: false }] })),
    ].map((runs) => runs.map((r) => r.executionSuccessful)),
    [[false], [false], [false]],
  );
  // Each run of a log is recorded, in a fixed order whatever order the logs arrive in.
  const two = [
    { checkId: 'lint', content: log({ tool: { driver: { name: 'eslint', version: '9.0.0' } }, results: [], invocations: [{ executionSuccessful: true }] }) },
    { checkId: 'semgrep', content: log(driver({ version: '1' }), driver({ version: '2' })) },
  ];
  const forward = checksFor(fixtureWorld(), { sarif: two }).scannerRuns;
  assert.deepEqual(forward.map((r) => [r.checkId, r.tool, r.toolVersion]), [['lint', 'eslint', '9.0.0'], ['semgrep', 'semgrep-oss', '1'], ['semgrep', 'semgrep-oss', '2']]);
  assert.deepEqual(checksFor(fixtureWorld(), { sarif: [...two].reverse() }).scannerRuns, forward);

  // A log whose scanner identity cannot be read records no run and fails closed.
  for (const [label, content] of [
    ['version not text', log({ ...driver({ version: 1 }), invocations: [{ executionSuccessful: true }] })],
    ['rule without an id', log({ ...driver({ rules: [{ name: 'x' }] }), invocations: [{ executionSuccessful: true }] })],
    ['rules not a list', log({ ...driver({ rules: {} }), invocations: [{ executionSuccessful: true }] })],
    ['invocation flag not a boolean', log({ ...driver({}), invocations: [{ executionSuccessful: 'true' }] })],
    ['invocations not a list', log({ ...driver({}), invocations: {} })],
    ['not json', utf8('{')],
  ] as const) {
    const result = checksFor(fixtureWorld(), { sarif: [{ checkId: 'semgrep', content }] });
    assert.deepEqual(result.scannerRuns, [], label);
    assert.deepEqual(result.findings.filter((f) => f.source === 'sarif' || f.ruleId === 'sarif-malformed').map((f) => f.ruleId), ['sarif-malformed'], label);
  }
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

  // Two SARIF results of one rule in one line bucket are one finding at the higher
  // severity, whichever order the log lists them in.
  const sarifResult = (level: string, line: number) => ({
    ruleId: 'r1',
    level,
    message: { text: `result at line ${line}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: 'src/feature.ts' }, region: { startLine: line } } }],
  });
  const logOf = (results: unknown[]) => [
    { checkId: 'lint', content: utf8(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'lint' } }, results }] })) },
  ];
  const noteFirst = checksFor(fixtureWorld(), { sarif: logOf([sarifResult('note', 2), sarifResult('error', 3)]) }).findings;
  const errorFirst = checksFor(fixtureWorld(), { sarif: logOf([sarifResult('error', 3), sarifResult('note', 2)]) }).findings;
  const sarifOnly = (list: readonly CheckFinding[]) => list.filter((f) => f.source === 'sarif');
  assert.deepEqual(sarifOnly(noteFirst).map((f) => f.severity), ['HIGH']);
  assert.deepEqual(noteFirst, errorFirst);
});

test('the check report is canonical and fails closed when it is read back', () => {
  const sarifLog = {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'lint' } }, results: [{ ruleId: 'r1', level: 'warning', message: { text: 'unused' } }] }],
  };
  const sarif = [{ checkId: 'lint', content: utf8(JSON.stringify(sarifLog)) }];
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
  assert.deepEqual(Object.keys(report.report).sort(), ['egress', 'findings', 'packetSha256', 'pushGuard', 'reportVersion', 'sarifInputs', 'scannerRuns']);
  assert.deepEqual(report.report.scannerRuns, [{ checkId: 'lint', tool: 'lint', toolVersion: null, rules: [], executionSuccessful: false }]);
  assert.deepEqual(report.report.scannerRuns, result.scannerRuns);
  assert.deepEqual(report.report.findings, result.findings);
  assert.deepEqual(report.report.sarifInputs, [{ checkId: 'lint', sha256: sha256Hex(sarif[0]!.content), bytes: sarif[0]!.content.byteLength }]);

  // The step's summary counts and the clearance a reviewer request is checked against.
  const blocking = result.findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
  assert.ok(blocking > 0, 'the zero-test run must raise a blocking finding');
  assert.ok(result.findings.length > blocking, 'the sarif warning must not block');
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
  const cleanRun = (clean['scannerRuns'] as Record<string, unknown>[])[0]!;
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
    ['negative sarif size', reread({ ...clean, sarifInputs: [{ checkId: 'lint', sha256: 'a'.repeat(64), bytes: -1 }] })],
    ['scanner run with an unknown key', reread({ ...clean, scannerRuns: [{ ...cleanRun, extra: true }] })],
    ['scanner run without its log', reread({ ...clean, scannerRuns: [{ ...cleanRun, checkId: 'other' }] })],
    ['scanner run flag not a boolean', reread({ ...clean, scannerRuns: [{ ...cleanRun, executionSuccessful: 'true' }] })],
    ['scanner rules not text', reread({ ...clean, scannerRuns: [{ ...cleanRun, rules: [1] }] })],
    ['scanner version not text', reread({ ...clean, scannerRuns: [{ ...cleanRun, toolVersion: 1 }] })],
  ];
  for (const [label, read] of tampered) assert.throws(read, CheckReportError, label);
});
