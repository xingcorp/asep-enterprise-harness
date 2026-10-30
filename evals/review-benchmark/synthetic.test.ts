import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CYCLES, failingExcerpts } from '../review-corpus/collect.js';
import { RULE_P_DIFF_FLAGS, mappingSection } from '../review-corpus/freeze.js';
import { CORPUS_EXECUTION, attemptIdentity, corpusObjective, crockford128, maskFindingIds, phaseTitle, syntheticId, syntheticRecord } from '../review-corpus/synthetic.js';

console.log('SUITE-ID: asep-suite:review-benchmark');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = 'evals/review-benchmark/golden/P2-FINAL-HIGH-003';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(join(ROOT, path)));
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
const fromLatin1 = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));

// Reference ids computed outside this code base (Python: the first 16 bytes of sha256(label) as a
// 128-bit big-endian integer, two zero bits prepended, read in 5-bit groups over the Crockford alphabet).
const IDS: Readonly<Record<string, string>> = {
  'corpus:org': '28RYVJXRSBE47VFTM1VZ39R9HY',
  'corpus:project': '0W0462GQ0GRREABGMCXRH0C0D2',
  'corpus:binding': '69CA9EKP8SJZWA8AJB3VBF6QJP',
  'corpus:run': '7GYQTFNF1WJ8ER0KAQ83XDXRF9',
  'corpus:task:p2-final': '0E64H7H23NFT2605AYZM46V86H',
  'corpus:attempt:p2-final/reviewed/round-trip': '2CEZ1DNGEXPNTQJGCHHFKVMAWT',
  'corpus:attempt:p2-final/post-fix/round-trip': '2NY3HBQPR44KBMW4Z1R04EEZ0P',
};

const OBJECTIVE =
  'Phase 2 (Single-agent vertical slice) at the reviewed commit. The phase plan, exit criteria and code are part of the change; review the change against them.';

/** The synthetic record of the golden item's cycle, written out by hand from the recipe. */
const RECORD = {
  cycle: 'p2-final',
  identity: {
    organizationId: { label: 'corpus:org', id: IDS['corpus:org'] },
    projectId: { label: 'corpus:project', id: IDS['corpus:project'] },
    repositoryBindingId: { label: 'corpus:binding', id: IDS['corpus:binding'] },
    runId: { label: 'corpus:run', id: IDS['corpus:run'] },
    taskId: { label: 'corpus:task:p2-final', id: IDS['corpus:task:p2-final'] },
  },
  risk: 'R1',
  round: 1,
  reviewKind: 'fresh',
  workOrder: {
    objective: OBJECTIVE,
    requirementIds: [],
    requirements: [],
    allowedPaths: ['**'],
    forbiddenChanges: [],
    architectureInvariants: [],
    acceptanceCheckIds: [],
  },
  execution: { verdict: 'NOT_RECORDED', environment: null, checks: [] },
  priorFindings: [],
};

test('synthetic ids are the Crockford base32 of the first 16 bytes of the label digest', () => {
  assert.equal(crockford128(new Uint8Array(16)), '0'.repeat(26));
  assert.equal(crockford128(new Uint8Array(16).fill(0xff)), `7${'Z'.repeat(25)}`);
  assert.throws(() => crockford128(new Uint8Array(15)), /16 bytes/);
  for (const [label, id] of Object.entries(IDS)) assert.equal(syntheticId(label), id, label);
  assert.deepEqual(attemptIdentity('p2-final/reviewed/round-trip'), {
    label: 'corpus:attempt:p2-final/reviewed/round-trip',
    id: IDS['corpus:attempt:p2-final/reviewed/round-trip'],
  });
});

test('finding-id tokens are masked to their own length, and nothing else is', () => {
  const masked = (text: string) => {
    const out = maskFindingIds(fromLatin1(text));
    return [latin1(out.bytes), out.masked] as const;
  };
  assert.deepEqual(masked('see P2-FINAL-HIGH-003 and HIGH-007.'), [`see ${'X'.repeat(17)} and ${'X'.repeat(8)}.`, 2]);
  assert.deepEqual(masked('P4-PLAN3-MED-002'), ['X'.repeat(16), 1]);
  // A long-form id is one token, not a long form plus the short form inside it.
  assert.deepEqual(masked('(P2-PLAN-MED-003)'), [`(${'X'.repeat(15)})`, 1]);
  assert.deepEqual(masked('CRITICAL-001 CRIT-002 MEDIUM-010 LOW-999'), [`${'X'.repeat(12)} ${'X'.repeat(8)} ${'X'.repeat(10)} ${'X'.repeat(7)}`, 4]);
  for (const kept of ['XHIGH-007', '_HIGH-007', 'HIGH-0071', 'high-007', 'HIGH-07', 'P2-FINAL-HIGH-03', 'SHA-256', 'REQ-001', 'p2-final-high-003']) {
    assert.deepEqual(masked(`a ${kept} b`), [`a ${kept} b`, 0], kept);
  }
  // Bytes outside the tokens, including non-ASCII ones, are unchanged, so offsets do not move.
  const bytes = new Uint8Array([...new TextEncoder().encode('café HIGH-007 ü'), 0xff, 0x0a]);
  const out = maskFindingIds(bytes);
  assert.deepEqual([...out.bytes], [...new TextEncoder().encode(`café ${'X'.repeat(8)} ü`), 0xff, 0x0a]);
  assert.equal(out.masked, 1);
});

test('the synthetic work order, identity and execution follow the recipe', () => {
  const plan = readFileSync(join(ROOT, 'docs/implementation/90-day-plan.md'), 'utf8');
  assert.equal(phaseTitle(plan, 1), 'Evaluation and contracts');
  assert.equal(phaseTitle(plan, 2), 'Single-agent vertical slice');
  assert.throws(() => phaseTitle(plan, 7), /phase 7/);
  assert.equal(corpusObjective(2, 'Single-agent vertical slice'), OBJECTIVE);
  assert.deepEqual(CORPUS_EXECUTION, { verdict: 'NOT_RECORDED', environment: null, checks: [] });

  // The cycle key is collection's own name for the golden item's cycle.
  assert.equal(CYCLES.find((c) => c.phase === 2 && c.cycle === 1)?.key, 'p2-final');
  assert.deepEqual(syntheticRecord('p2-final', 2, phaseTitle(plan, 2)), RECORD);
});

interface RoundTripPart {
  readonly part: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly masked: number;
}

interface RoundTripSide {
  readonly chunk: string;
  readonly attempt: { readonly label: string; readonly id: string };
  readonly taskBaseSha: string;
  readonly resultSha: string;
  readonly diff: RoundTripPart;
  readonly files: readonly (RoundTripPart & { readonly path: string; readonly status: string; readonly lineCount: number })[];
}

test('the golden item records its synthetic fields and round-trip parts, reproducible from git', () => {
  const golden = JSON.parse(readFileSync(join(ROOT, GOLDEN, 'item.json'), 'utf8')) as {
    baseSha: string;
    reviewedSha: string;
    postFixSha: string;
    synthetic: unknown;
    roundTrip: { maxBytes: number; sides: Readonly<Record<'reviewed' | 'post-fix', RoundTripSide>> };
  };
  assert.deepEqual(golden.synthetic, RECORD);

  // The hand-chosen chunk: the item's three cited files and the file the other-file output cites, in path order.
  const files = [
    'apps/control-plane-api/src/vertical-integration.test.ts',
    'packages/application/src/execute-task.test.ts',
    'packages/application/src/execute-task.ts',
    'packages/application/src/index.ts',
  ];
  // Line counts by `wc -l`, and the finding-id tokens each part carries before masking, by `grep -oE`.
  const lineCounts = { reviewed: [326, 202, 199, 56], 'post-fix': [364, 204, 204, 78] } as const;
  const tokens = {
    reviewed: [[], [], ['P2-PLAN-MED-003'], []],
    'post-fix': [['HIGH-008', 'HIGH-008'], [], ['P2-PLAN-MED-003', 'HIGH-007'], []],
  } as const;
  const masked = (original: Uint8Array, list: readonly string[]) => {
    let text = latin1(original);
    for (const token of list) {
      assert.ok(text.includes(token), token);
      text = text.replace(token, 'X'.repeat(token.length));
    }
    return text;
  };
  const resultOf = { reviewed: golden.reviewedSha, 'post-fix': golden.postFixSha } as const;
  const candidates = new Map<string, Uint8Array>();
  for (const side of ['reviewed', 'post-fix'] as const) {
    const record = golden.roundTrip.sides[side];
    const chunk = `p2-final/${side}/round-trip`;
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, GOLDEN, side, 'chunks.json'), 'utf8')), [{ id: chunk, files }], side);
    assert.equal(record.chunk, chunk, side);
    assert.deepEqual(record.attempt, { label: `corpus:attempt:${chunk}`, id: IDS[`corpus:attempt:${chunk}`] }, side);
    assert.deepEqual([record.taskBaseSha, record.resultSha], [golden.baseSha, resultOf[side]], side);

    // The chunk's diff is its files' sections of the cycle's rule-P diff, byte for byte, in path order.
    const whole = spawnSync('git', ['diff', ...RULE_P_DIFF_FLAGS, golden.baseSha, resultOf[side]], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
    assert.equal(whole.status, 0, side);
    const sections = files.map((path) => mappingSection(new Uint8Array(whole.stdout), path).bytes!);
    const diff = new Uint8Array(Buffer.concat(sections));
    const own: SpawnSyncReturns<Buffer> = spawnSync('git', ['diff', ...RULE_P_DIFF_FLAGS, golden.baseSha, resultOf[side], '--', ...files], { cwd: ROOT });
    assert.equal(latin1(diff), own.stdout.toString('latin1'), `${side}: the sections are the files' own diff`);
    const parts: [RoundTripPart, Uint8Array, readonly string[]][] = [[record.diff, diff, tokens[side].flat()]];

    assert.deepEqual(
      record.files.map((f) => [f.path, f.status, f.part, f.lineCount]),
      files.map((path, i) => [path, 'A', `${side}/round-trip/file-${i}`, lineCounts[side][i]]),
      side,
    );
    record.files.forEach((f, i) => {
      const shown: SpawnSyncReturns<Buffer> = spawnSync('git', ['show', `${resultOf[side]}:${f.path}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(shown.status, 0, f.path);
      parts.push([f, new Uint8Array(shown.stdout), tokens[side][i]!]);
    });

    const listing: string[] = [];
    for (const [recorded, original, list] of parts) {
      const committed = read(`${GOLDEN}/${recorded.part}`);
      assert.equal(latin1(committed), masked(original, list), recorded.part);
      assert.deepEqual([recorded.sha256, recorded.bytes, recorded.masked], [sha256(committed), original.byteLength, list.length], recorded.part);
      assert.equal(maskFindingIds(original).masked, list.length, recorded.part);
      listing.push(`${sha256(committed)}  ${recorded.part.slice(side.length + 1)}\n`);
      candidates.set(recorded.sha256, committed);
    }
    // The packet-source listing names every part's digest, in packet order.
    assert.equal(readFileSync(join(ROOT, GOLDEN, side, 'packet-sources.sha256'), 'utf8'), listing.join(''), side);
  }
  // Publication gates pass on every round-trip part.
  assert.deepEqual([...failingExcerpts(ROOT, candidates)], []);
});
