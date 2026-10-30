import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId } from '@asep/contracts';
import { parseUnifiedDiff } from './diff.js';
import {
  PacketBuildError,
  assertPacketWhitelist,
  buildCorpusReviewPacket,
  buildReviewPacket,
  type CorpusPacketSources,
  type PacketSources,
} from './packet.js';
import { packetNonce, renderReviewPrompt, reviewInstructions } from './prompt.js';
import { fixtureWorld, refFor, utf8 } from './test-support.js';
import type { ReviewPacket } from './local-types.js';

console.log('SUITE-ID: asep-suite:review-packet');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// The one execution shape of a corpus packet, stated independently of the code under test.
const NOT_RECORDED = { verdict: 'NOT_RECORDED', environment: null, checks: [] };

/** The corpus sources of a fixture attempt: its packet's work order, no execution. */
function corpusSources(sources: PacketSources): CorpusPacketSources {
  const runtime = buildReviewPacket(sources, fixtureWorld().limits).packet;
  return {
    identity: sources.identity,
    risk: sources.risk,
    reviewKind: sources.reviewKind,
    workOrder: runtime.workOrder,
    change: sources.change,
    priorFindings: sources.priorFindings,
  };
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

test('a corpus packet records that no execution evidence exists', () => {
  const world = fixtureWorld();
  const built = buildCorpusReviewPacket(corpusSources(world.sources), world.limits);
  assert.deepEqual(built.packet.execution, NOT_RECORDED);

  // Every other field is what the runtime builder makes of the same sources.
  const runtime = buildReviewPacket(world.sources, world.limits).packet;
  assert.deepEqual({ ...built.packet, execution: null }, { ...runtime, execution: null });

  // Canonical bytes, accepted by the validator and rendered for a reviewer.
  assert.equal(new TextDecoder().decode(built.bytes), sortedJson(built.packet));
  assert.equal(built.sha256, createHash('sha256').update(built.bytes).digest('hex'));
  assertPacketWhitelist(built.packet);
  const prompt = renderReviewPrompt(built, world.contents);
  assert.ok(prompt.input.includes(`${prompt.nonce}| ${sortedJson(built.packet)}`));

  // A re-review is built the same way.
  const repair = fixtureWorld({ round: 2 });
  const rebuilt = buildCorpusReviewPacket(corpusSources(repair.sources), repair.limits);
  assert.deepEqual([rebuilt.packet.reviewKind, rebuilt.packet.execution], ['re-review', NOT_RECORDED]);
});

test('corpus packet sources must agree with the change under review', () => {
  const world = fixtureWorld();
  const s = corpusSources(world.sources);
  const cases: readonly [string, CorpusPacketSources][] = [
    ['fresh review with prior findings', { ...s, priorFindings: [{} as never] }],
    ['fresh review with a repair base', { ...s, change: { ...s.change, repairBaseSha: 'c'.repeat(40) } }],
    ['re-review in round one', { ...s, reviewKind: 're-review' }],
    ['round key of another attempt', { ...s, identity: { ...s.identity, roundKey: 'other:assurance:1' } }],
    ['malformed sha', { ...s, change: { ...s.change, taskBaseSha: 'A'.repeat(40) } }],
    [
      'changed file without a blob',
      { ...s, change: { ...s.change, postImages: s.change.postImages.filter((b) => b.path !== 'src/util.ts') } },
    ],
  ];
  for (const [label, sources] of cases) {
    assert.throws(() => buildCorpusReviewPacket(sources, world.limits), PacketBuildError, label);
  }
  assert.throws(() => buildCorpusReviewPacket(s, { ...world.limits, maxBytes: 0 }), PacketBuildError, 'limits');

  // Nothing else on the sources reaches the packet.
  const smuggled = { ...s, execution: world.sources.execution, workOrder: { ...s.workOrder, coderSummary: 'CANARY-7d2e' } } as CorpusPacketSources;
  const built = buildCorpusReviewPacket(smuggled, world.limits);
  assert.deepEqual(built.packet.execution, NOT_RECORDED);
  assert.equal(new TextDecoder().decode(built.bytes).includes('CANARY-7d2e'), false);
});

test('the validator accepts no execution evidence only as NOT_RECORDED with no environment and no checks', () => {
  const world = fixtureWorld();
  const runtime = buildReviewPacket(world.sources, world.limits).packet;
  const corpus = buildCorpusReviewPacket(corpusSources(world.sources), world.limits).packet;
  const withExecution = (packet: object, execution: unknown) => ({ ...packet, execution });
  const environment = runtime.execution.environment;

  for (const verdict of ['PASS', 'FAIL', 'ERROR']) assertPacketWhitelist(withExecution(runtime, { ...runtime.execution, verdict }));
  assertPacketWhitelist(withExecution(runtime, NOT_RECORDED));

  const rejected: readonly [string, unknown][] = [
    ['a recorded verdict without an environment', { ...runtime.execution, environment: null }],
    ['a recorded verdict without an environment or checks', { verdict: 'PASS', environment: null, checks: [] }],
    ['NOT_RECORDED with an environment', { verdict: 'NOT_RECORDED', environment, checks: [] }],
    ['NOT_RECORDED with checks', { verdict: 'NOT_RECORDED', environment: null, checks: runtime.execution.checks }],
    ['a verdict outside the four', { ...runtime.execution, verdict: 'SKIPPED' }],
    ['a lower-case verdict', { ...NOT_RECORDED, verdict: 'not_recorded' }],
    ['no environment field', { verdict: 'NOT_RECORDED', checks: [] }],
  ];
  for (const [label, execution] of rejected) {
    assert.throws(() => assertPacketWhitelist(withExecution(corpus, execution)), PacketBuildError, label);
  }

  // The runtime builder never records NOT_RECORDED: its execution always has evidence.
  const forged = { ...world.sources, execution: { ...world.sources.execution, verdict: 'NOT_RECORDED' } } as unknown as PacketSources;
  assert.throws(() => buildReviewPacket(forged, world.limits), PacketBuildError);
});

test('the instructions say what a NOT_RECORDED execution manifest means', () => {
  const sentence =
    'An execution manifest whose verdict is NOT_RECORDED, with a null environment and no checks, means that no execution evidence exists for the reviewed commit.';
  const nonce = packetNonce(utf8('any packet'));
  assert.ok(reviewInstructions(nonce).includes(sentence));
});

interface LabelledId {
  readonly label: string;
  readonly id: string;
}

interface GoldenPart {
  readonly path: string;
  readonly sha256: string;
}

/** The parts of the golden historical item this test reads (evals/review-benchmark). */
interface GoldenItem {
  readonly synthetic: {
    readonly identity: Readonly<Record<'organizationId' | 'projectId' | 'repositoryBindingId' | 'runId' | 'taskId', LabelledId>>;
    readonly risk: ReviewPacket['risk'];
    readonly round: number;
    readonly reviewKind: ReviewPacket['reviewKind'];
    readonly workOrder: ReviewPacket['workOrder'];
    readonly execution: unknown;
    readonly priorFindings: readonly [];
  };
  readonly roundTrip: {
    readonly file: string;
    readonly sides: Readonly<
      Record<'reviewed' | 'post-fix', { readonly attempt: LabelledId; readonly taskBaseSha: string; readonly resultSha: string; readonly diff: GoldenPart; readonly postImage: GoldenPart }>
    >;
  };
}

test('the golden historical item round-trips through the packet validator and the prompt renderer on both sides', () => {
  const golden = 'evals/review-benchmark/golden/P2-FINAL-HIGH-003';
  const item = JSON.parse(readFileSync(join(REPO_ROOT, golden, 'item.json'), 'utf8')) as GoldenItem;
  const { synthetic, roundTrip } = item;
  assert.deepEqual(synthetic.execution, NOT_RECORDED);
  const read = (part: GoldenPart) => {
    const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, golden, part.path)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256, part.path);
    return bytes;
  };

  for (const side of ['reviewed', 'post-fix'] as const) {
    const record = roundTrip.sides[side];
    const diff = read(record.diff);
    const postImage = read(record.postImage);
    const diffText = new TextDecoder('utf-8', { fatal: true }).decode(diff);
    const postImageText = new TextDecoder('utf-8', { fatal: true }).decode(postImage);
    const changed = parseUnifiedDiff(diffText);
    assert.deepEqual(
      changed.map((f) => [f.path, f.status, f.binary]),
      [[roundTrip.file, 'A', false]],
      side,
    );
    const diffRef = refFor('review-diff', `golden-${side}-diff`, diff);
    const blobRef = refFor('review-blob', `golden-${side}-file`, postImage);
    const sources: CorpusPacketSources = {
      identity: {
        organizationId: synthetic.identity.organizationId.id as OrganizationId,
        projectId: synthetic.identity.projectId.id as ProjectId,
        repositoryBindingId: synthetic.identity.repositoryBindingId.id as RepositoryBindingId,
        runId: synthetic.identity.runId.id as RunId,
        taskId: synthetic.identity.taskId.id as TaskId,
        attemptId: record.attempt.id as AttemptId,
        round: synthetic.round,
        roundKey: `${record.attempt.id}:assurance:${synthetic.round}`,
      },
      risk: synthetic.risk,
      reviewKind: synthetic.reviewKind,
      workOrder: synthetic.workOrder,
      change: {
        taskBaseSha: record.taskBaseSha,
        resultSha: record.resultSha,
        repairBaseSha: null,
        cumulativeDiff: { ref: diffRef, bytes: diff.byteLength, overLimit: false, changedFiles: changed.map((f) => ({ path: f.path, status: 'A', binary: f.binary })) },
        repairDelta: null,
        postImages: [
          { path: roundTrip.file, blob: blobRef, bytes: postImage.byteLength, lineCount: postImageText.replace(/\n$/, '').split('\n').length, omittedReason: null },
        ],
      },
      priorFindings: synthetic.priorFindings,
    };

    // The validator accepts the packet, whose execution is the one corpus shape.
    const built = buildCorpusReviewPacket(sources, { maxBytes: 200000, excerptBytesPerStream: 4096, excerptBytesTotal: 65536 });
    assertPacketWhitelist(JSON.parse(new TextDecoder().decode(built.bytes)));
    assert.deepEqual(built.packet.execution, NOT_RECORDED, side);
    assert.deepEqual(built.packet.workOrder, synthetic.workOrder, side);
    assert.equal(built.packet.budget.overBudget, false, side);

    // The renderer embeds the packet, the diff and the post-image, every line datamarked, and the
    // instructions say what NOT_RECORDED means.
    const prompt = renderReviewPrompt(built, new Map([
      [diffRef.artifactId, diff],
      [blobRef.artifactId, postImage],
    ]));
    const block = (part: string, text: string) =>
      [`<<<UNTRUSTED ${prompt.nonce} ${part}>>>`, ...text.replace(/\n$/, '').split('\n').map((l) => `${prompt.nonce}| ${l}`), `<<<END ${prompt.nonce} ${part}>>>`].join('\n');
    assert.ok(prompt.input.includes(block('diff', diffText)), `${side}: diff`);
    assert.ok(prompt.input.includes(block('file-0', postImageText)), `${side}: post-image`);
    assert.ok(prompt.instructions.includes('NOT_RECORDED'), side);

    // No finding-id token reaches the reviewer: the parts were masked before they were frozen.
    const promptText = new TextDecoder().decode(prompt.bytes);
    assert.doesNotMatch(promptText, /\bP[0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b|\b(?:CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-[0-9]{3}\b/, side);
  }
});
