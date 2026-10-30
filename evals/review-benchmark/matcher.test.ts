import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_TABLE, MATCH_TOLERANCE, matchFindings, type GoldItem, type MatchableFinding } from './matcher.js';

console.log('SUITE-ID: asep-suite:review-benchmark');

const gold = (id: string, goldCategory: GoldItem['goldCategory'], ...locations: [string, number | null, number | null][]): GoldItem => ({
  id,
  goldCategory,
  locations: locations.map(([file, lineStart, lineEnd]) => ({ file, lineStart, lineEnd })),
});
const finding = (id: string, category: MatchableFinding['category'], file: string | null, lineStart: number | null, lineEnd = lineStart, grounded = true): MatchableFinding => ({
  id,
  grounded,
  category,
  file,
  lineStart,
  lineEnd,
});

test('the category table and tolerance are the protocol constants', () => {
  // Stated independently from plan §7.8, table corpus-categories/v1.
  assert.deepEqual(CATEGORY_TABLE, {
    CORRECTNESS: ['CORRECTNESS', 'SECURITY'],
    SECURITY: ['SECURITY', 'CORRECTNESS'],
    ARCHITECTURE: ['ARCHITECTURE', 'MAINTAINABILITY', 'SPEC'],
    SPEC: ['SPEC', 'CORRECTNESS', 'ARCHITECTURE'],
    TEST_QUALITY: ['TEST_QUALITY', 'EVIDENCE_INTEGRITY'],
    EVIDENCE_INTEGRITY: ['EVIDENCE_INTEGRITY', 'TEST_QUALITY', 'SPEC'],
    PERFORMANCE: ['PERFORMANCE', 'CORRECTNESS'],
    MAINTAINABILITY: ['MAINTAINABILITY', 'ARCHITECTURE'],
  });
  assert.equal(MATCH_TOLERANCE, 10);
});

test('a location matches within ten lines of the gold range, in the same file only', () => {
  const g = [gold('G', 'CORRECTNESS', ['src/a.ts', 100, 110])];
  const matched = (f: MatchableFinding, variant: 'strict' | 'lenient' = 'strict') => matchFindings(g, [f], variant).matches.length === 1;
  assert.equal(matched(finding('f', 'CORRECTNESS', 'src/a.ts', 120)), true, 'ten lines after the end');
  assert.equal(matched(finding('f', 'CORRECTNESS', 'src/a.ts', 121)), false, 'eleven lines after the end');
  assert.equal(matched(finding('f', 'CORRECTNESS', 'src/a.ts', 85, 90)), true, 'ending ten lines before the start');
  assert.equal(matched(finding('f', 'CORRECTNESS', 'src/a.ts', 85, 89)), false, 'ending eleven lines before the start');
  assert.equal(matched(finding('f', 'CORRECTNESS', 'src/b.ts', 105)), false, 'another file');
  assert.equal(matched(finding('f', 'CORRECTNESS', null, null)), false, 'no file');
  assert.equal(matched(finding('f', 'CORRECTNESS', 'src/a.ts', null)), false, 'a file without lines against a gold range');
  // A gold location without lines matches any finding in its file.
  assert.equal(matchFindings([gold('G', 'CORRECTNESS', ['src/a.ts', null, null])], [finding('f', 'SECURITY', 'src/a.ts', 9000)], 'strict').matches.length, 1);
});

test('strict needs a compatible category; lenient needs only the path', () => {
  const g = [gold('G', 'CORRECTNESS', ['src/a.ts', 100, 110])];
  const result = (f: MatchableFinding) => [matchFindings(g, [f], 'strict').matches.length, matchFindings(g, [f], 'lenient').matches.length];
  assert.deepEqual(result(finding('f', 'SECURITY', 'src/a.ts', 105)), [1, 1], 'a compatible category');
  assert.deepEqual(result(finding('f', 'MAINTAINABILITY', 'src/a.ts', 105)), [0, 1], 'an incompatible category');
  assert.deepEqual(result(finding('f', 'CORRECTNESS', 'src/a.ts', 400)), [0, 1], 'far lines in the same file');
  assert.deepEqual(result(finding('f', 'CORRECTNESS', 'src/b.ts', 105)), [0, 0], 'another file');
  assert.deepEqual(result(finding('f', 'CORRECTNESS', 'src/a.ts', null)), [0, 1], 'the path without lines');
  assert.deepEqual(result(finding('f', 'CORRECTNESS', null, null)), [0, 0], 'no file');
  assert.deepEqual(result(finding('f', 'CORRECTNESS', 'src/a.ts', 105, 105, false)), [0, 0], 'an ungrounded finding never matches');
});

test('matching is one-to-one, nearest first, and the rest is duplicate or unlabelled', () => {
  // Two findings near one gold item: the nearer matches, the other is a duplicate.
  const one = matchFindings([gold('G', 'CORRECTNESS', ['src/a.ts', 100, 110])], [finding('far', 'CORRECTNESS', 'src/a.ts', 118), finding('near', 'CORRECTNESS', 'src/a.ts', 104)], 'strict');
  assert.deepEqual(one.matches, [{ goldId: 'G', findingId: 'near', distance: 0 }]);
  assert.deepEqual([one.duplicate, one.unlabelled, one.unmatchedGold], [['far'], [], []]);

  // One finding near two gold items goes to the nearer; the other gold item stays unmatched.
  const two = matchFindings(
    [gold('A', 'CORRECTNESS', ['src/a.ts', 100, 102]), gold('B', 'CORRECTNESS', ['src/a.ts', 108, 109])],
    [finding('f', 'CORRECTNESS', 'src/a.ts', 107)],
    'strict',
  );
  assert.deepEqual(two.matches, [{ goldId: 'B', findingId: 'f', distance: 1 }]);
  assert.deepEqual(two.unmatchedGold, ['A']);

  // Equal distances: the gold item id decides, then the finding id.
  const tie = matchFindings(
    [gold('B', 'CORRECTNESS', ['src/a.ts', 100, 100]), gold('A', 'CORRECTNESS', ['src/a.ts', 100, 100])],
    [finding('y', 'CORRECTNESS', 'src/a.ts', 100), finding('x', 'CORRECTNESS', 'src/a.ts', 100)],
    'strict',
  );
  assert.deepEqual(tie.matches, [
    { goldId: 'A', findingId: 'x', distance: 0 },
    { goldId: 'B', findingId: 'y', distance: 0 },
  ]);
  // The gold id is compared before the finding id: A takes y, its only partner, before B takes x.
  const order = matchFindings(
    [gold('B', 'EVIDENCE_INTEGRITY', ['src/a.ts', 100, 100]), gold('A', 'TEST_QUALITY', ['src/a.ts', 100, 100])],
    [finding('x', 'SPEC', 'src/a.ts', 100), finding('y', 'TEST_QUALITY', 'src/a.ts', 100)],
    'strict',
  );
  assert.deepEqual(order.matches, [
    { goldId: 'A', findingId: 'y', distance: 0 },
    { goldId: 'B', findingId: 'x', distance: 0 },
  ]);

  // A multi-location gold item matches through its nearest location; an unrelated finding is unlabelled.
  const multi = matchFindings(
    [gold('M', 'SECURITY', ['src/a.ts', 10, 12], ['src/b.ts', 50, 55])],
    [finding('b', 'SECURITY', 'src/b.ts', 57), finding('c', 'SECURITY', 'src/c.ts', 1), finding('u', 'SECURITY', 'src/a.ts', 11, 11, false)],
    'strict',
  );
  assert.deepEqual(multi.matches, [{ goldId: 'M', findingId: 'b', distance: 2 }]);
  assert.deepEqual([multi.duplicate, multi.unlabelled, multi.ungrounded], [[], ['c'], ['u']]);
  const nearest = matchFindings([gold('N', 'SECURITY', ['src/a.ts', 20, 22], ['src/a.ts', 10, 12])], [finding('f', 'SECURITY', 'src/a.ts', 15)], 'strict');
  assert.deepEqual(nearest.matches, [{ goldId: 'N', findingId: 'f', distance: 3 }]);

  // The result does not depend on the order of either list.
  const golds = [gold('A', 'CORRECTNESS', ['src/a.ts', 100, 102]), gold('B', 'SPEC', ['src/a.ts', 108, 109])];
  const findings = [finding('f', 'CORRECTNESS', 'src/a.ts', 107), finding('g', 'SPEC', 'src/a.ts', 101), finding('h', 'SPEC', 'src/z.ts', 1)];
  const forward = matchFindings(golds, findings, 'strict');
  assert.deepEqual(matchFindings([...golds].reverse(), [...findings].reverse(), 'strict'), forward);
  assert.throws(() => matchFindings(golds, [findings[0]!, findings[0]!], 'strict'), /twice/);
});
