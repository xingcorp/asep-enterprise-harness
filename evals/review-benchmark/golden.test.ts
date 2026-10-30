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

type Expected = Readonly<Record<'matched' | 'duplicate' | 'unlabelled', readonly string[]>>;

/**
 * The matcher's view of a scripted output. Its findings are taken as grounded and their key
 * stands for the fingerprint: the runtime validation and grounding over the rebuilt packet
 * take this place once the evals package is bound to the runtime packet code and the packets
 * themselves are rebuilt.
 */
function scripted(output: ScriptedOutput, side: string): MatchableFinding[] {
  return output.findings.map((f) => ({ id: `${side}#${f.key}`, grounded: true, category: f.category, file: f.file, lineStart: f.lineStart, lineEnd: f.lineEnd }));
}

test('golden historical item maps its locations and matches as specified on both sides', () => {
  const golden = json<GoldenItem>(`${GOLDEN}/item.json`);

  // The golden item is the frozen corpus item, with its frozen annotation.
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
  for (const side of SIDES) {
    const outputs = readdirSync(join(ROOT, GOLDEN, 'outputs', side)).map((f) => f.replace(/\.json$/, '')).sort();
    assert.deepEqual(outputs, Object.keys(expected[side]).sort(), side);
    const gold: GoldItem[] = [{ id: golden.id, goldCategory: golden.goldCategory, locations: goldOf[side] }];
    for (const name of outputs) {
      const findings = scripted(json<ScriptedOutput>(`${GOLDEN}/outputs/${side}/${name}.json`), side);
      for (const variant of ['strict', 'lenient'] as const) {
        const result = matchFindings(gold, findings, variant);
        const keys = (ids: readonly string[]) => ids.map((id) => id.slice(side.length + 1)).sort();
        assert.deepEqual(
          { matched: keys(result.matches.map((m) => m.findingId)), duplicate: keys(result.duplicate), unlabelled: keys(result.unlabelled) },
          expected[side][name]![variant],
          `${side} ${name} ${variant}`,
        );
        assert.deepEqual(result.ungrounded, []);
      }
    }
  }
});
