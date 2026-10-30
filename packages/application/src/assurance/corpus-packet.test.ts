import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PacketBuildError,
  assertPacketWhitelist,
  buildCorpusReviewPacket,
  buildReviewPacket,
  type CorpusPacketSources,
  type PacketSources,
} from './packet.js';
import { packetNonce, renderReviewPrompt, reviewInstructions } from './prompt.js';
import { fixtureWorld, utf8 } from './test-support.js';

console.log('SUITE-ID: asep-suite:review-packet');

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
