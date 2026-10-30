import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANNOTATIONS_FILE,
  EXCLUSION_ORDER,
  MANIFEST_FILE,
  MAPPING_DIR,
  freezeCorpus,
  isLeakagePath,
  mappingSection,
  treeInputs,
  type FreezeInputs,
  type ManifestBody,
} from './freeze.js';

console.log('SUITE-ID: asep-suite:review-corpus');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string) => new TextEncoder().encode(text);

/** Canonical JSON as the manifest defines it, stated independently: keys sorted, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function committedManifest(): { bytes: Uint8Array; body: ManifestBody; corpusSha256: string } {
  const bytes = new Uint8Array(readFileSync(join(ROOT, MANIFEST_FILE)));
  const { corpusSha256, ...body } = JSON.parse(new TextDecoder().decode(bytes)) as ManifestBody & { corpusSha256: string };
  return { bytes, body, corpusSha256 };
}

test('a second freeze of the same tree is byte-identical and equals the committed manifest', () => {
  const first = freezeCorpus(treeInputs(ROOT));
  const second = freezeCorpus(treeInputs(ROOT));
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(second.corpusSha256, first.corpusSha256);

  // What is committed is what the freeze writes, the stored diff sections included.
  const committed = committedManifest();
  assert.deepEqual(first.bytes, committed.bytes);
  assert.equal(committed.corpusSha256, first.corpusSha256);
  assert.deepEqual(readdirSync(join(ROOT, MAPPING_DIR)).sort(), [...first.mappingBlobs.keys()].sort());
  for (const [sha, bytes] of first.mappingBlobs) assert.deepEqual(new Uint8Array(readFileSync(join(ROOT, MAPPING_DIR, sha))), bytes, sha);

  // The digest is the sha256 of the body's canonical JSON, and it covers every input.
  assert.equal(committed.corpusSha256, sha256(canonical(committed.body)));
  const inputs = treeInputs(ROOT);
  const [name, bytes] = [...inputs.itemFiles].find(([n]) => n.startsWith('P2-FINAL-HIGH-003@2e61f24'))!;
  const edited: FreezeInputs = { ...inputs, itemFiles: new Map([...inputs.itemFiles, [name, utf8(`${new TextDecoder().decode(bytes)} `)]]) };
  assert.notEqual(freezeCorpus(edited).corpusSha256, first.corpusSha256, 'an item byte');
  const reannotated: FreezeInputs = { ...inputs, annotationsBytes: utf8(`${new TextDecoder().decode(inputs.annotationsBytes)} `) };
  assert.notEqual(freezeCorpus(reannotated).corpusSha256, first.corpusSha256, 'an annotation byte');
});

test('the freeze rules apply in order and every exclusion is counted', () => {
  const { body } = committedManifest();
  const reason = (id: string) => body.items.find((i) => i.id === id)!.excluded?.reason ?? null;

  // Counts tallied from the collected items outside the freeze code.
  assert.deepEqual(body.counts.excluded, { 'leakage-filtered': 3, 'no-location': 16, 'plan-defect': 69, 'reviewed-tree-unknown': 19 });
  assert.equal(body.counts.items, 153);
  assert.equal(body.counts.included, 46);
  assert.deepEqual(body.counts.noLocationByPhase, { '1': 15, '2': 1 });
  assert.deepEqual(body.counts.includedBySet, { 'prompt-development': 2, reporting: 44 });
  assert.equal(body.counts.includedPrivateBundleOnly, 8);
  assert.equal(body.counts.includedDependsOnPrivateBundle, 12);

  // The first rule that applies wins: a plan label, an unknown tree, no location, then the leakage filter.
  assert.equal(reason('P1-ARCH-001@unknown'), 'plan-defect');
  assert.equal(reason('P2-FINAL-HIGH-005@unknown'), 'reviewed-tree-unknown', 'an unknown tree, though it cites no location');
  assert.equal(reason('P2-CYCLE6-HIGH-001@ebaf519'), 'no-location');
  assert.equal(reason('P2-FINAL-MED-005@2e61f24'), 'leakage-filtered', 'it cites only the phase report');
  assert.equal(reason('P2-FINAL-MED-005@594b628'), null, 'it also cites the exit criteria');
  assert.equal(reason('P2-FINAL-HIGH-003@2e61f24'), null);

  // Every reason is in the protocol's order; the packet plan's two rules are named, never counted.
  for (const item of body.items) if (item.excluded !== null) assert.ok(EXCLUSION_ORDER.includes(item.excluded.reason), item.id);
  assert.deepEqual(body.protocol.appliedByPacketPlan, ['not-in-packet', 'egress-stopped']);
  assert.deepEqual(body.items.filter((i) => i.excluded !== null && body.protocol.appliedByPacketPlan.includes(i.excluded.reason)), []);
  assert.equal(
    Object.values(body.counts.excluded).reduce((n, v) => n + v, 0) + body.counts.included,
    body.counts.items,
  );

  // Gold annotations exist exactly for the included items; excluded items carry none.
  for (const item of body.items) {
    const annotated = item.goldCategory !== null && item.goldCategoryRationale !== null && item.defectClass !== null;
    assert.equal(annotated, item.excluded === null, item.id);
  }
});

test('the leakage filter removes the protocol paths only', () => {
  const removed = [
    'docs/implementation/phases/phase-02-final-review-codex-v1.md',
    'docs/implementation/phases/phase-02-report.md',
    'artifacts/phase-02/run.json',
    'build.log',
    'logs/nested/run.log',
  ];
  const kept = [
    'docs/implementation/phases/phase-02-exit-criteria.md',
    'docs/implementation/phases/sub/phase-02-report.md',
    'docs/implementation/review-notes.md',
    'packages/artifacts/index.ts',
    'build.log.ts',
    'docs/implementation/phases/phase-02-report.mdx',
  ];
  for (const path of removed) assert.equal(isLeakagePath(path), true, path);
  for (const path of kept) assert.equal(isLeakagePath(path), false, path);
});

test('a diff section follows a rename and a deletion, and an unnamed file is unchanged', () => {
  const diff = utf8(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' one',
      '+two',
      ' three',
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index 3333333..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      '',
    ].join('\n'),
  );
  const a = mappingSection(diff, 'src/a.ts');
  assert.equal(a.newPath, 'src/a.ts');
  assert.equal(new TextDecoder().decode(a.bytes!), 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n one\n+two\n three\n');
  assert.equal(mappingSection(diff, 'src/old.ts').newPath, 'src/new.ts');
  assert.equal(mappingSection(diff, 'src/new.ts').bytes, null, 'a rename is found by its old path only');
  assert.equal(mappingSection(diff, 'src/gone.ts').newPath, null);
  assert.deepEqual(mappingSection(diff, 'src/other.ts'), { path: 'src/other.ts', newPath: 'src/other.ts', bytes: null });
  // A byte that is not UTF-8 comes back unchanged.
  const raw = new Uint8Array([...utf8('diff --git a/b.bin b/b.bin\n--- a/b.bin\n+++ b/b.bin\n@@ -1 +1 @@\n-'), 0xff, 0x0a]);
  assert.deepEqual(mappingSection(raw, 'b.bin').bytes, raw);
});

test('the freeze refuses annotations that do not cover exactly the included findings', () => {
  const inputs = treeInputs(ROOT);
  const annotations = JSON.parse(readFileSync(join(ROOT, ANNOTATIONS_FILE), 'utf8')) as { findings: Record<string, Record<string, string>> };
  const withFindings = (findings: Record<string, unknown>): FreezeInputs => ({ ...inputs, annotationsBytes: utf8(JSON.stringify({ ...annotations, findings })) });
  const { ['P2-FINAL-HIGH-003']: golden, ...others } = annotations.findings;
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['an included finding without an annotation', others],
    ['an annotation without an included finding', { ...annotations.findings, 'P2-FINAL-MED-999': golden }],
    ['a category outside the table', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, goldCategory: 'STYLE' } }],
    ['an unknown defect class', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, defectClass: 'docs' } }],
    ['a rationale of two lines', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, rationale: 'one\ntwo' } }],
    ['an empty rationale', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, rationale: '' } }],
    ['an extra key', { ...annotations.findings, 'P2-FINAL-HIGH-003': { ...golden, model: 'x' } }],
  ];
  for (const [label, findings] of cases) assert.throws(() => freezeCorpus(withFindings(findings)), /review-corpus freeze/, label);
});

test('a diff section that fails a publication gate is withheld, never stored', () => {
  const inputs = treeInputs(ROOT);
  const clean = freezeCorpus(inputs);
  const [blocked] = [...clean.mappingBlobs.keys()].sort();
  const failing: FreezeInputs = { ...inputs, gates: () => new Map([[blocked!, ['secret-scan']]]) };
  const frozen = freezeCorpus(failing);
  assert.equal(frozen.mappingBlobs.has(blocked!), false);
  const entries = frozen.body.items.flatMap((i) => i.mapping ?? []).filter((m) => m.withheldGates.length > 0);
  assert.ok(entries.length > 0);
  for (const m of entries) assert.deepEqual([m.diffSha256, m.withheldGates], [null, ['secret-scan']]);
  assert.equal(frozen.body.mappingDiffs.includes(blocked!), false);
});
