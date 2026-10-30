import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchFindings, type GoldItem, type GoldLocation, type MatchableFinding } from './matcher.js';
import { mapLocation } from './post-fix-mapping.js';

console.log('SUITE-ID: asep-suite:review-benchmark');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = 'evals/review-corpus/self-history';
const GOLDEN = 'evals/review-benchmark/golden/P2-FINAL-HIGH-003';
const SIDES = ['reviewed', 'post-fix'] as const;

const text = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const json = <T>(path: string) => JSON.parse(text(path)) as T;

interface GoldenItem {
  readonly id: string;
  readonly corpusItemSha256: string;
  readonly goldCategory: GoldItem['goldCategory'];
  readonly goldCategoryRationale: string;
  readonly locations: readonly GoldLocation[];
  readonly outputsPlacedAt: Readonly<Record<(typeof SIDES)[number], GoldLocation>>;
}

interface ScriptedOutput {
  readonly findings: readonly { readonly key: string; readonly category: MatchableFinding['category']; readonly file: string | null; readonly lineStart: number | null; readonly lineEnd: number | null }[];
}

type Expected = Readonly<Record<'matched' | 'duplicate' | 'unlabelled' | 'ungrounded', readonly string[]>>;

/** The recorded grounding outcome of each finding, by side, output and key; the application golden test asserts it. */
type Grounding = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { readonly grounded: boolean; readonly fingerprint: string }>>>>>>;

/**
 * The matcher's view of a scripted output: each finding in the chunk that holds its file, with the
 * grounding outcome and fingerprint the golden files record. Running validation, grounding and the
 * matcher in one pass over the rebuilt chunks comes once the evals package is bound to the runtime
 * packet code.
 */
function scripted(output: ScriptedOutput, chunks: readonly { readonly id: string; readonly files: readonly string[] }[], recorded: Grounding[string][string]): MatchableFinding[] {
  return output.findings.map((f) => ({
    chunk: chunks.find((c) => f.file !== null && c.files.includes(f.file))!.id,
    fingerprint: recorded[f.key]!.fingerprint,
    grounded: recorded[f.key]!.grounded,
    category: f.category,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
  }));
}

test('golden historical item maps its locations and matches as specified on both sides', () => {
  const golden = json<GoldenItem>(`${GOLDEN}/item.json`);

  // The golden item is the collected corpus item, with its annotation as the manifest records it.
  const itemFile = `${CORPUS}/items/${golden.id}.json`;
  assert.equal(golden.corpusItemSha256, createHash('sha256').update(readFileSync(join(ROOT, itemFile))).digest('hex'));
  const item = json<{ locations: GoldLocation[] }>(itemFile);
  assert.deepEqual(golden.locations, item.locations);
  const manifest = json<{
    items: { id: string; goldCategory: string; goldCategoryRationale: string; mapping: { path: string; newPath: string | null; diffSha256: string | null }[] }[];
  }>(`${CORPUS}/manifest.json`);
  const frozen = manifest.items.find((i) => i.id === golden.id)!;
  assert.deepEqual([golden.goldCategory, golden.goldCategoryRationale], [frozen.goldCategory, frozen.goldCategoryRationale]);

  // Both sides' gold: the reviewed locations, and the post-fix mapping of each.
  const mapped = golden.locations.map((l) => {
    const m = frozen.mapping.find((s) => s.path === l.file)!;
    return mapLocation(l, { newPath: m.newPath, diff: m.diffSha256 === null ? null : text(`${CORPUS}/mapping/${m.diffSha256}`) })!;
  });
  assert.deepEqual(mapped, json(`${GOLDEN}/post-fix/mapped-locations.json`));
  assert.ok(mapped.some((l) => JSON.stringify(l) === JSON.stringify(golden.outputsPlacedAt['post-fix'])), 'the post-fix outputs sit at a mapped location');
  assert.ok(golden.locations.some((l) => JSON.stringify(l) === JSON.stringify(golden.outputsPlacedAt.reviewed)), 'the reviewed outputs sit at a gold location');
  const goldOf = { reviewed: golden.locations, 'post-fix': mapped } as const;

  // Every scripted output, each side, both variants, gives exactly the expected result.
  const expected = json<Record<(typeof SIDES)[number], Record<string, Record<'strict' | 'lenient', Expected>>>>(`${GOLDEN}/expected-matches.json`);
  const grounding = json<Grounding>(`${GOLDEN}/expected-grounding.json`);
  for (const side of SIDES) {
    const chunks = json<{ id: string; files: string[] }[]>(`${GOLDEN}/${side}/chunks.json`);
    const outputs = readdirSync(join(ROOT, GOLDEN, 'outputs', side)).map((f) => f.replace(/\.json$/, '')).sort();
    assert.deepEqual(outputs, Object.keys(expected[side]).sort(), side);
    const gold: GoldItem[] = [{ id: golden.id, goldCategory: golden.goldCategory, locations: goldOf[side] }];
    for (const name of outputs) {
      const output = json<ScriptedOutput>(`${GOLDEN}/outputs/${side}/${name}.json`);
      assert.deepEqual(Object.keys(grounding[side]![name]!).sort(), output.findings.map((f) => f.key).sort(), `${side} ${name}`);
      const findings = scripted(output, chunks, grounding[side]![name]!);
      const key = new Map(findings.map((f, i) => [`${f.chunk}#${f.fingerprint}`, output.findings[i]!.key]));
      for (const variant of ['strict', 'lenient'] as const) {
        const result = matchFindings(gold, findings, variant);
        const keys = (refs: readonly { readonly chunk: string; readonly fingerprint: string }[]) => refs.map((r) => key.get(`${r.chunk}#${r.fingerprint}`)!).sort();
        assert.deepEqual(
          { matched: keys(result.matches), duplicate: keys(result.duplicate), unlabelled: keys(result.unlabelled), ungrounded: keys(result.ungrounded) },
          expected[side][name]![variant],
          `${side} ${name} ${variant}`,
        );
      }
    }
  }
});
