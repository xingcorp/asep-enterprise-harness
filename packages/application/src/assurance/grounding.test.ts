import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPacket } from './packet.js';
import { parseUnifiedDiff } from './diff.js';
import { groundFinding, groundResolution, type GroundingContext } from './grounding.js';
import type { ModelFindingOutput, PriorFindingClaimOutput } from './prompt.js';
import { fixtureWorld, worldFromDiff } from './test-support.js';

console.log('SUITE-ID: asep-suite:review-grounding');

const EVIDENCE = 'greet() interpolates the name without escaping it for HTML output';
const FIX = 'Escape the name before interpolating it';

function context(round = 1): GroundingContext {
  const world = fixtureWorld({ round });
  const built = buildReviewPacket(world.sources, world.limits);
  const diff = parseUnifiedDiff(new TextDecoder().decode(world.contents.get('art-diff')!));
  return {
    packet: built.packet,
    diff,
    repairDelta: round > 1 ? parseUnifiedDiff(new TextDecoder().decode(world.contents.get('art-delta')!)) : null,
    minChars: { evidence: 40, requiredFix: 20 },
  };
}

function finding(over: Partial<ModelFindingOutput> = {}): ModelFindingOutput {
  return {
    key: 'f1',
    severity: 'HIGH',
    category: 'CORRECTNESS',
    file: 'src/feature.ts',
    lineStart: 2,
    lineEnd: 2,
    requirementId: null,
    evidence: EVIDENCE,
    requiredFix: FIX,
    confidence: 0.8,
    ...over,
  };
}

test('citations outside the packet are refuted', () => {
  const ctx = context();
  assert.deepEqual(groundFinding(ctx, finding()), { grounded: true, reason: null });

  const refuted: readonly (readonly [string, Partial<ModelFindingOutput>, string])[] = [
    ['file not in the change', { file: 'src/elsewhere.ts' }, 'path-not-in-packet'],
    ['absolute path', { file: '/etc/passwd' }, 'path-not-normalized'],
    ['parent traversal', { file: '../outside.ts' }, 'path-not-normalized'],
    ['line past the end of the post-image', { lineStart: 3, lineEnd: 4 }, 'lines-outside-file'],
    ['reversed range', { lineStart: 3, lineEnd: 2 }, 'line-range-invalid'],
    ['zero line', { lineStart: 0, lineEnd: 1 }, 'line-range-invalid'],
    ['file without lines', { lineStart: null, lineEnd: null }, 'line-range-invalid'],
    ['omitted binary content', { file: 'assets/logo.png', lineStart: 1, lineEnd: 1 }, 'content-not-in-packet'],
    ['invented requirement', { requirementId: 'REQ-404' }, 'citation-not-in-packet'],
    ['lines without a file', { file: null, lineStart: 1, lineEnd: 1, category: 'SPEC', requirementId: 'REQ-1' }, 'lines-without-file'],
    ['no citation at all', { file: null, lineStart: null, lineEnd: null }, 'citation-missing'],
    ['correctness finding citing only a requirement', { file: null, lineStart: null, lineEnd: null, requirementId: 'REQ-1' }, 'citation-missing'],
    ['thin evidence', { evidence: 'looks wrong' }, 'evidence-too-short'],
    ['thin fix', { requiredFix: 'fix it' }, 'required-fix-too-short'],
  ];
  for (const [label, over, reason] of refuted) {
    assert.deepEqual(groundFinding(ctx, finding(over)), { grounded: false, reason }, label);
  }

  // Specification and evidence-integrity findings may cite a requirement or a check instead of a line.
  const noLines = { file: null, lineStart: null, lineEnd: null };
  assert.deepEqual(groundFinding(ctx, finding({ ...noLines, category: 'SPEC', requirementId: 'REQ-1' })), { grounded: true, reason: null });
  assert.deepEqual(groundFinding(ctx, finding({ ...noLines, category: 'EVIDENCE_INTEGRITY', requirementId: 'unit' })), {
    grounded: true,
    reason: null,
  });
  // Deleted lines are cited inside the diff hunk that removed them.
  assert.deepEqual(groundFinding(ctx, finding({ file: 'src/old.ts', lineStart: 1, lineEnd: 1 })), { grounded: true, reason: null });
  assert.deepEqual(groundFinding(ctx, finding({ file: 'src/old.ts', lineStart: 2, lineEnd: 2 })), {
    grounded: false,
    reason: 'content-not-in-packet',
  });
  // Minimum lengths count trimmed text.
  assert.equal(groundFinding(ctx, finding({ evidence: `${' '.repeat(50)}short` })).grounded, false);
});

test('resolution claims are grounded against the repair delta', () => {
  const world = worldFromDiff(
    [
      { path: 'src/feature.ts', status: 'M', context: ['export function greet(name: string): string {'], added: ['  return escape(name);', '}'] },
      { path: 'src/util.ts', status: 'M', context: ['export const answer = 42;', 'export const other = 7;'] },
    ],
    { round: 2, allowedPaths: ['src/**'] },
  );
  const built = buildReviewPacket(world.sources, world.limits);
  const decode = (id: string) => new TextDecoder().decode(world.contents.get(id)!);
  // The repair delta touches only src/feature.ts lines 2-3.
  const delta = parseUnifiedDiff(
    'diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -2,1 +2,2 @@\n-  return name;\n+  return escape(name);\n+}\n',
  );
  const ctx: GroundingContext = {
    packet: built.packet,
    diff: parseUnifiedDiff(decode('art-diff')),
    repairDelta: delta,
    minChars: { evidence: 40, requiredFix: 20 },
  };
  const claim = (over: Partial<PriorFindingClaimOutput>): PriorFindingClaimOutput => ({
    priorFindingId: 'prior-1',
    status: 'RESOLVED',
    evidence: 'the name is now escaped before it is interpolated into the greeting',
    resolutionFile: 'src/feature.ts',
    resolutionLine: 2,
    ...over,
  });

  const prior = { file: 'src/feature.ts', lineStart: 2, lineEnd: 2 };
  assert.deepEqual(groundResolution(ctx, claim({}), prior), {
    grounded: true,
    reason: null,
    fileInRepairDelta: true,
    changedLine: true,
  });
  // A file the repair did not change: grounded citation, but outside the delta.
  assert.deepEqual(groundResolution(ctx, claim({ resolutionFile: 'src/util.ts', resolutionLine: 1 }), prior), {
    grounded: true,
    reason: null,
    fileInRepairDelta: false,
    changedLine: false,
  });
  // Inside a changed file but away from the changed lines.
  assert.deepEqual(groundResolution(ctx, claim({ resolutionLine: 1 }), prior), {
    grounded: true,
    reason: null,
    fileInRepairDelta: true,
    changedLine: false,
  });
  assert.equal(groundResolution(ctx, claim({ resolutionFile: 'src/nowhere.ts' }), prior).grounded, false);
  assert.equal(groundResolution(ctx, claim({ resolutionFile: null, resolutionLine: null }), prior).grounded, false);
  assert.equal(groundResolution(ctx, claim({ evidence: 'done' }), prior).grounded, false);
  assert.equal(groundResolution(ctx, claim({ status: 'PARTIAL' }), prior).grounded, false);
  // Without a repair delta (a fresh review) nothing is inside it.
  assert.equal(groundResolution({ ...ctx, repairDelta: null }, claim({}), prior).fileInRepairDelta, false);
});

test('only a changed line closes a finding, never its context', () => {
  // Post-image of src/feature.ts: 1 signature, 2 return, 3 comment, 4 brace.
  const lines = ['export function greet(name: string): string {', '  return `hello ${name}`;', '  // escaped by the caller', '}'];
  const world = worldFromDiff([{ path: 'src/feature.ts', status: 'A', added: lines }], { round: 2, allowedPaths: ['src/**'] });
  const built = buildReviewPacket(world.sources, world.limits);
  const ctxFor = (delta: string): GroundingContext => ({
    packet: built.packet,
    diff: parseUnifiedDiff(new TextDecoder().decode(world.contents.get('art-diff')!)),
    repairDelta: parseUnifiedDiff(delta),
    minChars: { evidence: 40, requiredFix: 20 },
  });
  const header = 'diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n';
  const claim = (resolutionLine: number): PriorFindingClaimOutput => ({
    priorFindingId: 'prior-1',
    status: 'RESOLVED',
    evidence: 'the comment states that the caller escapes the name before the call',
    resolutionFile: 'src/feature.ts',
    resolutionLine,
  });
  const prior = { file: 'src/feature.ts', lineStart: 2, lineEnd: 2 };

  // The repair added only line 3; lines 1, 2 and 4 are context in the same hunk.
  const added = ctxFor(`${header}@@ -1,3 +1,4 @@\n ${lines[0]}\n ${lines[1]}\n+${lines[2]}\n ${lines[3]}\n`);
  const changed = [1, 2, 3, 4].map((line) => groundResolution(added, claim(line), prior));
  assert.deepEqual(changed.map((r) => r.grounded), [true, true, true, true]);
  assert.deepEqual(changed.map((r) => r.fileInRepairDelta), [true, true, true, true]);
  assert.deepEqual(changed.map((r) => r.changedLine), [false, false, true, false]);

  // Deletion only: the repair removed old line 2, the finding's own cited line.
  const removedTheLine = ctxFor(`${header}@@ -1,3 +1,2 @@\n ${lines[0]}\n-  return name;\n ${lines[1]}\n`);
  assert.equal(groundResolution(removedTheLine, claim(1), prior).changedLine, true);
  // ...but not when the finding cites a line the deletion left in place.
  assert.equal(groundResolution(removedTheLine, claim(1), { ...prior, lineStart: 2, lineEnd: 3 }).changedLine, false);
  assert.equal(groundResolution(removedTheLine, claim(1), { ...prior, lineStart: 3, lineEnd: 3 }).changedLine, false);
  // ...nor for a finding in another file, nor one without lines.
  assert.equal(groundResolution(removedTheLine, claim(1), { ...prior, file: 'src/util.ts' }).changedLine, false);
  assert.equal(groundResolution(removedTheLine, claim(1), { file: 'src/feature.ts' }).changedLine, false);
  // A change that also adds lines is not deletion-only: only its added lines close.
  const replaced = ctxFor(`${header}@@ -1,3 +1,3 @@\n ${lines[0]}\n-  return name;\n+${lines[1]}\n ${lines[2]}\n`);
  assert.deepEqual([1, 2, 3].map((line) => groundResolution(replaced, claim(line), prior).changedLine), [false, true, false]);
});
