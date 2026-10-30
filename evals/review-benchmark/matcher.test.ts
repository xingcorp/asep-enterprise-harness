import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_TABLE, MATCH_TOLERANCE, matchFindings, type GoldItem, type MatchableFinding } from './matcher.js';

console.log('SUITE-ID: asep-suite:review-benchmark');

const gold = (id: string, goldCategory: GoldItem['goldCategory'], ...locations: [string, number | null, number | null][]): GoldItem => ({
  id,
  goldCategory,
  locations: locations.map(([file, lineStart, lineEnd]) => ({ file, lineStart, lineEnd })),
});
/** A finding of chunk `c` unless stated; its fingerprint stands in for the runtime one. */
const finding = (
  fingerprint: string,
  category: MatchableFinding['category'],
  file: string | null,
  lineStart: number | null,
  lineEnd = lineStart,
  grounded = true,
  chunk = 'c',
): MatchableFinding => ({
  chunk,
  fingerprint,
  grounded,
  category,
  file,
  lineStart,
  lineEnd,
});

/** A finding's identity in a result, and an expected match. */
const ref = (fingerprint: string, chunk = 'c') => ({ chunk, fingerprint });
const match = (goldId: string, fingerprint: string, distance: number, chunk = 'c') => ({ goldId, chunk, fingerprint, distance });

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
  assert.deepEqual(one.matches, [match('G', 'near', 0)]);
  assert.deepEqual([one.duplicate, one.unlabelled, one.unmatchedGold], [[ref('far')], [], []]);

  // One finding near two gold items goes to the nearer; the other gold item stays unmatched.
  const two = matchFindings(
    [gold('A', 'CORRECTNESS', ['src/a.ts', 100, 102]), gold('B', 'CORRECTNESS', ['src/a.ts', 108, 109])],
    [finding('f', 'CORRECTNESS', 'src/a.ts', 107)],
    'strict',
  );
  assert.deepEqual(two.matches, [match('B', 'f', 1)]);
  assert.deepEqual(two.unmatchedGold, ['A']);

  // Equal distances: the gold item id decides, then the fingerprint.
  const tie = matchFindings(
    [gold('B', 'CORRECTNESS', ['src/a.ts', 100, 100]), gold('A', 'CORRECTNESS', ['src/a.ts', 100, 100])],
    [finding('y', 'CORRECTNESS', 'src/a.ts', 100), finding('x', 'CORRECTNESS', 'src/a.ts', 100)],
    'strict',
  );
  assert.deepEqual(tie.matches, [
    match('A', 'x', 0),
    match('B', 'y', 0),
  ]);
  // The gold id is compared before the fingerprint: A takes y, its only partner, before B takes x.
  const order = matchFindings(
    [gold('B', 'EVIDENCE_INTEGRITY', ['src/a.ts', 100, 100]), gold('A', 'TEST_QUALITY', ['src/a.ts', 100, 100])],
    [finding('x', 'SPEC', 'src/a.ts', 100), finding('y', 'TEST_QUALITY', 'src/a.ts', 100)],
    'strict',
  );
  assert.deepEqual(order.matches, [
    match('A', 'y', 0),
    match('B', 'x', 0),
  ]);

  // A multi-location gold item matches through its nearest location; an unrelated finding is unlabelled.
  const multi = matchFindings(
    [gold('M', 'SECURITY', ['src/a.ts', 10, 12], ['src/b.ts', 50, 55])],
    [finding('b', 'SECURITY', 'src/b.ts', 57), finding('c', 'SECURITY', 'src/c.ts', 1), finding('u', 'SECURITY', 'src/a.ts', 11, 11, false)],
    'strict',
  );
  assert.deepEqual(multi.matches, [match('M', 'b', 2)]);
  assert.deepEqual([multi.duplicate, multi.unlabelled, multi.ungrounded], [[], [ref('c')], [ref('u')]]);
  const nearest = matchFindings([gold('N', 'SECURITY', ['src/a.ts', 20, 22], ['src/a.ts', 10, 12])], [finding('f', 'SECURITY', 'src/a.ts', 15)], 'strict');
  assert.deepEqual(nearest.matches, [match('N', 'f', 3)]);

  // The result does not depend on the order of either list.
  const golds = [gold('A', 'CORRECTNESS', ['src/a.ts', 100, 102]), gold('B', 'SPEC', ['src/a.ts', 108, 109])];
  const findings = [finding('f', 'CORRECTNESS', 'src/a.ts', 107), finding('g', 'SPEC', 'src/a.ts', 101), finding('h', 'SPEC', 'src/z.ts', 1)];
  const forward = matchFindings(golds, findings, 'strict');
  assert.deepEqual(matchFindings([...golds].reverse(), [...findings].reverse(), 'strict'), forward);
  assert.throws(() => matchFindings(golds, [findings[0]!, findings[0]!], 'strict'), /twice/);
});

test('ties break on the gold item id, then the fingerprint, and the chunk last', () => {
  // The review's probe: gold A cites two files, gold B one of them; finding 'a' sits in chunk c2, finding 'b' in
  // chunk c1. By fingerprint, A takes 'a' and B takes 'b': both are rediscovered. Ordering by the pooled id
  // (chunk first) would give A 'b' and leave B unmatched.
  const probe = matchFindings(
    [gold('A', 'CORRECTNESS', ['src/a.ts', 10, 10], ['src/b.ts', 10, 10]), gold('B', 'CORRECTNESS', ['src/b.ts', 10, 10])],
    [finding('a', 'CORRECTNESS', 'src/a.ts', 10, 10, true, 'c2'), finding('b', 'CORRECTNESS', 'src/b.ts', 10, 10, true, 'c1')],
    'strict',
  );
  assert.deepEqual(probe.matches, [match('A', 'a', 0, 'c2'), match('B', 'b', 0, 'c1')]);
  assert.deepEqual(probe.unmatchedGold, []);

  // One fingerprint in two chunks: the chunk decides, last.
  const chunks = matchFindings(
    [gold('G', 'CORRECTNESS', ['src/a.ts', 10, 10])],
    [finding('f', 'CORRECTNESS', 'src/a.ts', 10, 10, true, 'c2'), finding('f', 'CORRECTNESS', 'src/a.ts', 10, 10, true, 'c1')],
    'strict',
  );
  assert.deepEqual([chunks.matches, chunks.duplicate], [[match('G', 'f', 0, 'c1')], [ref('f', 'c2')]]);

  // A finding's identity is its chunk and fingerprint together.
  assert.throws(() => matchFindings([], [finding('f', 'CORRECTNESS', 'src/a.ts', 1), finding('f', 'SPEC', 'src/b.ts', 2)], 'strict'), /twice/);
});

test('lenient matching is nearest first too', () => {
  // Two findings in the gold file: 'a' 290 lines past the range, 'b' inside it. Lenient matching needs only the
  // path, yet the nearer finding takes the gold item; 'a' sorts first by fingerprint, so only distance decides.
  const result = matchFindings(
    [gold('G', 'CORRECTNESS', ['src/a.ts', 100, 110])],
    [finding('a', 'MAINTAINABILITY', 'src/a.ts', 400), finding('b', 'MAINTAINABILITY', 'src/a.ts', 105)],
    'lenient',
  );
  assert.deepEqual(result.matches, [match('G', 'b', 0)]);
  assert.deepEqual([result.duplicate, result.unlabelled], [[ref('a')], []]);

  // The distance a lenient match reports is the line gap, as under strict.
  const far = matchFindings([gold('G', 'CORRECTNESS', ['src/a.ts', 100, 110])], [finding('a', 'MAINTAINABILITY', 'src/a.ts', 400)], 'lenient');
  assert.deepEqual(far.matches, [match('G', 'a', 290)]);
});
