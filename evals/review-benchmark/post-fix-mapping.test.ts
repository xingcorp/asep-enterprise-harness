import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLocation, parseHunks } from './post-fix-mapping.js';

console.log('SUITE-ID: asep-suite:review-benchmark');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = 'evals/review-corpus/self-history';
const GOLDEN = 'evals/review-benchmark/golden/P2-FINAL-HIGH-003';

const section = (path: string, hunks: readonly string[]) => [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, ...hunks, ''].join('\n');
const at = (file: string, lineStart: number | null, lineEnd: number | null = lineStart) => ({ file, lineStart, lineEnd });

test('hunk headers are read with their default counts', () => {
  assert.deepEqual(parseHunks(section('a.ts', ['@@ -3 +3 @@', '-x', '+y', '@@ -10,0 +11,3 @@ context', '+a', '+b', '+c'])), [
    { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
    { oldStart: 10, oldLines: 0, newStart: 11, newLines: 3 },
  ]);
  assert.throws(() => parseHunks(section('a.ts', ['@@ -x +1 @@'])), /hunk header/);
});

test('a gold location maps through the post-fix diff as the protocol states', () => {
  // Hunks: lines 20-26 become 20-29 (+3), 40 gains three lines after it (+3), 60-61 are removed (-2).
  const diff = section('src/a.ts', ['@@ -20,7 +20,10 @@', ' c', '+n', '@@ -40,0 +44,3 @@', '+p', '+q', '+r', '@@ -60,2 +65,0 @@', '-s', '-t']);
  const mapped = (s: number | null, e: number | null = s) => mapLocation(at('src/a.ts', s, e), { newPath: 'src/a.ts', diff });
  assert.deepEqual(mapped(5, 9), at('src/a.ts', 5, 9), 'before every hunk');
  assert.deepEqual(mapped(30, 35), at('src/a.ts', 33, 38), 'after one hunk: +3');
  assert.deepEqual(mapped(22), at('src/a.ts', 20, 29), 'inside a hunk: its whole new range');
  assert.deepEqual(mapped(15, 22), at('src/a.ts', 15, 29), 'from before a hunk into it');
  assert.deepEqual(mapped(22, 30), at('src/a.ts', 20, 33), 'from inside a hunk to after it');
  assert.deepEqual(mapped(40), at('src/a.ts', 43, 43), 'the line an insertion follows does not move');
  assert.deepEqual(mapped(41), at('src/a.ts', 47, 47), 'after an insertion: +6');
  assert.deepEqual(mapped(60, 61), at('src/a.ts', 65, 65), 'a removed range maps to the line it followed');
  assert.deepEqual(mapped(70), at('src/a.ts', 74, 74), 'after every hunk: +3 +3 -2');
  assert.deepEqual(mapped(null), at('src/a.ts', null), 'a location without lines keeps its file');

  // An unchanged file keeps its lines; a rename follows the new path; a deleted file has no location.
  assert.deepEqual(mapLocation(at('src/b.ts', 7, 9), { newPath: 'src/b.ts', diff: null }), at('src/b.ts', 7, 9));
  const renamed = 'diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n';
  assert.deepEqual(mapLocation(at('src/old.ts', 3, 4), { newPath: 'src/new.ts', diff: renamed }), at('src/new.ts', 3, 4));
  assert.equal(mapLocation(at('src/gone.ts', 3, 4), { newPath: null, diff: 'diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\n' }), null);

  // Lines of a binary file cannot be followed; the file itself can.
  const binary = 'diff --git a/x.bin b/x.bin\nindex 1111111..2222222 100644\nBinary files a/x.bin and b/x.bin differ\n';
  assert.equal(mapLocation(at('x.bin', 1, 2), { newPath: 'x.bin', diff: binary }), null);
  assert.deepEqual(mapLocation(at('x.bin', null), { newPath: 'x.bin', diff: binary }), at('x.bin', null));
});

test('the golden item maps to the committed post-fix locations', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
  const golden = 'P2-FINAL-HIGH-003@2e61f24';
  const item = JSON.parse(read(`${CORPUS}/items/${golden}.json`)) as {
    locations: { file: string; lineStart: number; lineEnd: number }[];
    excerpts: { side: string; path: string; sha256: string }[];
  };
  const manifest = JSON.parse(read(`${CORPUS}/manifest.json`)) as {
    items: { id: string; mapping: { path: string; newPath: string | null; diffSha256: string | null }[] | null }[];
  };
  const mapping = manifest.items.find((i) => i.id === golden)!.mapping!;
  const mapped = item.locations.map((l) => {
    const m = mapping.find((s) => s.path === l.file)!;
    return mapLocation(l, { newPath: m.newPath, diff: m.diffSha256 === null ? null : read(`${CORPUS}/mapping/${m.diffSha256}`) });
  });
  assert.deepEqual(mapped, JSON.parse(read(`${GOLDEN}/post-fix/mapped-locations.json`)));

  // Independently of the mapping: every gold line outside a hunk reads the same at its mapped line.
  const lines = (side: string, path: string) => read(`${CORPUS}/blobs/${item.excerpts.find((e) => e.side === side && e.path === path)!.sha256}`).split('\n');
  for (const [i, l] of item.locations.entries()) {
    const [reviewed, postFix] = [lines('reviewed', l.file), lines('post-fix', mapped[i]!.file)];
    assert.equal(postFix[mapped[i]!.lineStart! - 1], reviewed[l.lineStart - 1], `${l.file}:${l.lineStart}`);
    assert.equal(postFix[mapped[i]!.lineEnd! - 1], reviewed[l.lineEnd - 1], `${l.file}:${l.lineEnd}`);
  }
});
