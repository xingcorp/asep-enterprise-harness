import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PacketBuildError,
  assertPacketWhitelist,
  buildReviewPacket,
  packetFieldPaths,
  type BuiltPacket,
  type PacketSources,
} from './packet.js';
import { renderReviewPrompt, PromptRenderError } from './prompt.js';
import { excerptTail, parseTestSummary } from './execution-manifest.js';
import { fixtureWorld, utf8, refFor, worldFromDiff, type FixtureWorld } from './test-support.js';
import type { ReviewFindingRecord } from './local-types.js';

console.log('SUITE-ID: asep-suite:review-packet');

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function render(world: FixtureWorld) {
  const built = buildReviewPacket(world.sources, world.limits);
  return { built, prompt: renderReviewPrompt(built, world.contents) };
}

test('coder self-report never reaches the reviewer', () => {
  const world = fixtureWorld();
  const canaries = {
    summary: 'CANARY-SUMMARY-7f3a',
    limitation: 'CANARY-LIMITATION-91c2',
    event: 'CANARY-EVENT-5d10',
    contextPack: 'CANARY-CONTEXTPACK-0be4',
    commit: 'CANARY-COMMIT-MESSAGE-3aa8',
    prBody: 'CANARY-PR-BODY-6c77',
    peer: 'CANARY-PEER-REVIEW-e912',
  };
  // Self-report and other untrusted side channels ride along on every object the builder
  // reads. A whitelisting builder copies none of them.
  const smuggled = {
    ...world.sources,
    agentResult: { summary: canaries.summary, knownLimitations: [canaries.limitation] },
    eventArtifacts: [canaries.event],
    contextPack: { objective: canaries.contextPack, specificationExcerpt: canaries.contextPack },
    workOrder: { ...world.sources.workOrder, coderSummary: canaries.summary, commitMessage: canaries.commit },
    change: {
      ...world.sources.change,
      prBody: canaries.prBody,
      cumulativeDiff: { ...world.sources.change.cumulativeDiff, commitMessage: canaries.commit },
    },
    execution: {
      ...world.sources.execution,
      peerReviews: [canaries.peer],
      evidence: {
        ...world.sources.execution.evidence,
        summary: canaries.summary,
        checks: world.sources.execution.evidence.checks.map((c) => ({ ...c, knownLimitations: [canaries.limitation] })),
      },
    },
  } as unknown as PacketSources;
  const { built, prompt } = render({ ...world, sources: smuggled });

  const packetText = decode(built.bytes);
  const promptText = decode(prompt.bytes);
  for (const canary of Object.values(canaries)) {
    assert.equal(packetText.includes(canary), false, `packet carries ${canary}`);
    assert.equal(promptText.includes(canary), false, `prompt carries ${canary}`);
  }

  // Positive control: content that legitimately is under review does reach the prompt, so the
  // search above would have found a leaked canary.
  const control = 'CANARY-IN-DIFF-CONTENT-4411';
  const withControl = fixtureWorld({ diff: `+// ${control}\n` });
  assert.equal(decode(render(withControl).prompt.bytes).includes(control), true);
});

test('packet schema whitelists trusted sources only', () => {
  const world = fixtureWorld();
  const { packet } = buildReviewPacket(world.sources, world.limits);
  assertPacketWhitelist(packet);

  // No allowed field can carry coder self-report, context, commit text, PR text or peer output.
  const forbidden =
    /^(summary|coderSummary|agentSummary|knownLimitations|limitations|contextPack|context|commitMessage|commitMessages|prBody|pullRequestBody|events?|eventArtifacts|session|sessionId|conversation|peerReviews?|reviews|reviewerOutput|response|responses|transcript)$/i;
  for (const path of packetFieldPaths()) {
    for (const segment of path.replaceAll('[]', '').split('.')) assert.doesNotMatch(segment, forbidden, path);
  }

  const tampered: readonly ((p: Record<string, any>) => void)[] = [
    (p) => (p['coderSummary'] = 'x'),
    (p) => (p['contextPack'] = {}),
    (p) => (p['workOrder']['knownLimitations'] = []),
    (p) => (p['change']['commitMessage'] = 'x'),
    (p) => (p['change']['files'][0]['prBody'] = 'x'),
    (p) => (p['execution']['checks'][0]['summary'] = 'x'),
    (p) => (p['execution']['checks'][0]['stdout']['transcript'] = 'x'),
    (p) => (p['execution']['peerReviews'] = []),
    (p) => (p['identity']['sessionId'] = 'x'),
  ];
  for (const tamper of tampered) {
    const copy = JSON.parse(JSON.stringify(packet)) as Record<string, any>;
    tamper(copy);
    assert.throws(() => assertPacketWhitelist(copy), PacketBuildError, tamper.toString());
  }
  // Missing fields are rejected too: the shape is exact.
  const missing = JSON.parse(JSON.stringify(packet)) as Record<string, any>;
  delete missing['budget'];
  assert.throws(() => assertPacketWhitelist(missing), PacketBuildError);
});

// Independent count of a packet's budget: key-sorted JSON.stringify of the final packet object
// the builder returns, nothing zeroed, plus the bytes of every content part the prompt embeds,
// read from the artifacts. It applies to a packet that is sent, which carries `overBudget: false`.
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function expectedBudget(world: FixtureWorld, built: BuiltPacket): number {
  assert.equal(built.packet.budget.overBudget, false, 'the oracle measures a packet that is sent');
  const { change } = built.packet;
  const embedded = [change.cumulativeDiff, change.repairDelta, ...change.files.map((f) => f.postImage)]
    .filter((ref) => ref !== null)
    .reduce((n, ref) => n + world.contents.get(ref.artifactId)!.byteLength, 0);
  return Buffer.byteLength(sortedJson(built.packet), 'utf8') + embedded;
}

/**
 * The smallest budget the world's packet fits, by the independent count. The packet carries
 * its cap, so its size depends on the number of digits of `maxBytes`: measure under the cap
 * being tested. Each step lowers the cap, so every packet measured on the way is sent.
 */
function smallestBudget(world: FixtureWorld): number {
  let maxBytes = world.limits.maxBytes;
  for (let i = 0; i < 3; i += 1) maxBytes = expectedBudget(world, buildReviewPacket(world.sources, { ...world.limits, maxBytes }));
  assert.equal(String(maxBytes - 1).length, String(maxBytes).length, 'the boundary keeps the digit count');
  return maxBytes;
}

test('over-budget packet is flagged, never cut', () => {
  // A diff the source reader could not fit is flagged; nothing is dropped from the file list.
  const base = fixtureWorld();
  const overLimit = {
    ...base,
    sources: {
      ...base.sources,
      change: { ...base.sources.change, cumulativeDiff: { ...base.sources.change.cumulativeDiff, overLimit: true } },
    },
  };
  const flagged = buildReviewPacket(overLimit.sources, overLimit.limits);
  assert.equal(flagged.overBudget, true);
  assert.equal(flagged.packet.budget.overBudget, true);
  assert.deepEqual(
    flagged.packet.change.files.map((f) => f.path),
    ['assets/logo.png', 'src/feature.ts', 'src/old.ts', 'src/util.ts'],
  );
  assert.throws(() => renderReviewPrompt(flagged, overLimit.contents), PromptRenderError);

  // Content beyond the byte budget is flagged with the full count, not trimmed to fit.
  const fits = smallestBudget(base);
  const full = buildReviewPacket(base.sources, { ...base.limits, maxBytes: fits });
  const tight = buildReviewPacket(base.sources, { ...base.limits, maxBytes: fits - 1 });
  assert.equal(full.overBudget, false);
  assert.equal(tight.overBudget, true);
  assert.deepEqual([full.includedBytes, tight.includedBytes], [fits, fits - 1]);
  assert.deepEqual(tight.packet.change, full.packet.change);
  assert.deepEqual(tight.packet.execution, full.packet.execution);
  assert.throws(() => renderReviewPrompt(tight, base.contents), PromptRenderError);

  // Omitted content is recorded with its reason.
  assert.deepEqual(full.omissions, [
    { path: 'assets/logo.png', reason: 'binary' },
    { path: 'src/old.ts', reason: 'deleted' },
  ]);
  assert.deepEqual(full.packet.budget.omissions, full.omissions);
  const tooLarge = {
    ...base.sources,
    change: {
      ...base.sources.change,
      postImages: base.sources.change.postImages.map((b) =>
        b.path === 'src/util.ts' ? { ...b, blob: null, lineCount: 0, omittedReason: 'too-large' as const } : b,
      ),
    },
  };
  const large = buildReviewPacket(tooLarge, base.limits);
  assert.deepEqual(large.omissions, [
    { path: 'assets/logo.png', reason: 'binary' },
    { path: 'src/old.ts', reason: 'deleted' },
    { path: 'src/util.ts', reason: 'too-large' },
  ]);
  assert.equal(large.packet.change.files.find((f) => f.path === 'src/util.ts')?.postImage, null);
});

test('the budget counts the canonical packet bytes and every embedded part', () => {
  const worlds: readonly (readonly [string, FixtureWorld])[] = [
    ['first round', fixtureWorld()],
    ['re-review with a repair delta', fixtureWorld({ round: 2 })],
    ['multi-byte objective', fixtureWorld({ objective: 'é'.repeat(1000) })],
    ['long output excerpt', fixtureWorld({ unitStdout: `ℹ tests 1\nℹ pass 1\nℹ fail 0\n${'log line\n'.repeat(400)}` })],
    // A post-image the packet leaves out is not embedded, so it is not counted.
    ['unsafe path', worldFromDiff([{ path: 'src/line\nbreak.ts', status: 'A', added: ['export const a = 1;'] }], { allowedPaths: ['**'] })],
  ];
  for (const [label, world] of worlds) {
    const built = buildReviewPacket(world.sources, world.limits);
    assert.equal(built.includedBytes, expectedBudget(world, built), label);
    assert.equal(built.overBudget, false, label);
    // The boundary: exactly the budget fits, one byte less is flagged.
    const at = (maxBytes: number) => buildReviewPacket(world.sources, { ...world.limits, maxBytes });
    const fits = smallestBudget(world);
    assert.equal(at(fits).includedBytes, expectedBudget(world, at(fits)), label);
    assert.deepEqual([at(fits).overBudget, at(fits - 1).overBudget], [false, true], label);
  }

  // The review's probe: a 450 000-character objective under a 400 000-byte budget.
  const long = fixtureWorld({ objective: 'x'.repeat(450_000) });
  assert.equal(long.limits.maxBytes, 400_000);
  const flagged = buildReviewPacket(long.sources, long.limits);
  assert.ok(flagged.includedBytes > 450_000);
  assert.deepEqual([flagged.overBudget, flagged.packet.budget.overBudget], [true, true]);
  assert.throws(() => renderReviewPrompt(flagged, long.contents), PromptRenderError);
});

test('the budget is the final packet bytes, at the cap and one byte over', () => {
  const worlds: readonly (readonly [string, FixtureWorld])[] = [
    // The review's probe: no diff content and no changed file.
    ['empty change', fixtureWorld({ diff: '', files: [] })],
    ['first round', fixtureWorld()],
    ['re-review with a repair delta', fixtureWorld({ round: 2 })],
  ];
  for (const [label, world] of worlds) {
    const cap = smallestBudget(world);
    const atCap = buildReviewPacket(world.sources, { ...world.limits, maxBytes: cap });
    const over = buildReviewPacket(world.sources, { ...world.limits, maxBytes: cap - 1 });
    // At the cap the packet is sent, and the bytes that are hashed and sent are the bytes
    // measured: the oracle serializes the packet object itself.
    assert.equal(atCap.overBudget, false, label);
    assert.equal(atCap.bytes.byteLength, Buffer.byteLength(sortedJson(atCap.packet), 'utf8'), label);
    assert.equal(atCap.sha256, createHash('sha256').update(atCap.bytes).digest('hex'), label);
    assert.ok(expectedBudget(world, atCap) <= cap, label);
    // One byte under that cap the same packet is one byte over: flagged, never sent.
    assert.deepEqual([over.overBudget, over.packet.budget.overBudget], [true, true], label);
    assert.throws(() => renderReviewPrompt(over, world.contents), PromptRenderError, label);
    assert.deepEqual([atCap.includedBytes, over.includedBytes], [expectedBudget(world, atCap), cap - 1], label);
    // The measured size is reported beside the packet, never inside it.
    assert.deepEqual(Object.keys(atCap.packet.budget).sort(), ['maxBytes', 'omissions', 'overBudget'], label);
  }
});

test("included bytes are the stored packet's final size", () => {
  // Independent count on the packet object the builder returns, flagged or not: its canonical
  // bytes plus every part the prompt embeds.
  const stored = (world: FixtureWorld, built: BuiltPacket) => {
    const { change } = built.packet;
    const embedded = [change.cumulativeDiff, change.repairDelta, ...change.files.map((f) => f.postImage)]
      .filter((ref) => ref !== null)
      .reduce((n, ref) => n + world.contents.get(ref.artifactId)!.byteLength, 0);
    return Buffer.byteLength(sortedJson(built.packet), 'utf8') + embedded;
  };
  for (const [label, world] of [
    ['first round', fixtureWorld()],
    ['re-review with a repair delta', fixtureWorld({ round: 2 })],
  ] as const) {
    const cap = smallestBudget(world);
    const accepted = buildReviewPacket(world.sources, { ...world.limits, maxBytes: cap });
    const rejected = buildReviewPacket(world.sources, { ...world.limits, maxBytes: cap - 1 });
    assert.deepEqual([accepted.overBudget, rejected.overBudget], [false, true], label);
    // Accepted: the stored bytes are the bytes sent, within the cap.
    assert.equal(accepted.includedBytes, stored(world, accepted), label);
    assert.ok(accepted.includedBytes <= cap, label);
    // Rejected: measured after the flag is set, so the stored `true` is one byte shorter than
    // the `false` the decision was taken on.
    assert.equal(rejected.includedBytes, stored(world, rejected), label);
    assert.equal(rejected.includedBytes, cap - 1, label);
  }
  // Far over the cap, and over a diff's reader limit, the size is still the stored one.
  const long = fixtureWorld({ objective: 'x'.repeat(450_000) });
  const far = buildReviewPacket(long.sources, long.limits);
  assert.deepEqual([far.overBudget, far.includedBytes], [true, stored(long, far)]);
  const base = fixtureWorld();
  const overLimit = {
    ...base.sources,
    change: { ...base.sources.change, cumulativeDiff: { ...base.sources.change.cumulativeDiff, overLimit: true } },
  };
  const limited = buildReviewPacket(overLimit, base.limits);
  assert.deepEqual([limited.overBudget, limited.includedBytes], [true, stored(base, limited)]);
});

test('packet carries a bounded execution manifest', () => {
  const world = fixtureWorld();
  const { packet } = buildReviewPacket(world.sources, world.limits);
  const evidence = world.sources.execution.evidence;

  assert.equal(packet.execution.verdict, 'PASS');
  assert.deepEqual(packet.execution.environment, {
    imageDigest: evidence.environment.imageDigest,
    lockfileHash: evidence.environment.lockfileHash,
    nodeVersion: 'v24.10.0',
  });
  const unit = packet.execution.checks.find((c) => c.id === 'unit')!;
  assert.equal(unit.command, 'pnpm test');
  assert.equal(unit.category, 'unit');
  assert.equal(unit.exitCode, 0);
  assert.equal(unit.durationMs, 1200);
  const rawStdout = world.contents.get('art-unit-stdout')!;
  assert.deepEqual(unit.stdout, {
    artifactId: 'art-unit-stdout',
    sha256: createHash('sha256').update(rawStdout).digest('hex'),
    bytes: rawStdout.byteLength,
    excerptTail: decode(rawStdout),
  });
  assert.deepEqual(unit.stderr, {
    artifactId: 'art-unit-stderr',
    sha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
    bytes: 0,
    excerptTail: '',
  });
  assert.deepEqual(unit.testSummary, { runner: 'node:test', tests: 3, pass: 3, fail: 0, skipped: 0, todo: 0 });
  // Test summaries are parsed only for test checks.
  const typecheck = packet.execution.checks.find((c) => c.id === 'typecheck')!;
  assert.equal(typecheck.testSummary, null);
  assert.equal(typecheck.stderr, null);

  // Excerpts are the tail of each stream, bounded per stream and in total.
  const longOutput = `${'x'.repeat(10_000)}\nℹ tests 0\nℹ pass 0\nℹ fail 0\n`;
  const long = fixtureWorld({ unitStdout: longOutput });
  const bounded = buildReviewPacket(long.sources, long.limits).packet.execution.checks.find((c) => c.id === 'unit')!;
  assert.equal(bounded.stdout!.bytes, utf8(longOutput).byteLength);
  assert.equal(utf8(bounded.stdout!.excerptTail!).byteLength, 4096);
  assert.equal(longOutput.endsWith(bounded.stdout!.excerptTail!), true);
  // The summary is parsed from the whole stream, not the excerpt.
  assert.deepEqual(bounded.testSummary, { runner: 'node:test', tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 });

  const capped = buildReviewPacket(long.sources, { ...long.limits, excerptBytesPerStream: 4096, excerptBytesTotal: 4096 });
  const cappedChecks = capped.packet.execution.checks;
  const excerptBytes = cappedChecks
    .flatMap((c) => [c.stdout, c.stderr])
    .reduce((n, s) => n + (s?.excerptTail === null || s === null ? 0 : utf8(s.excerptTail).byteLength), 0);
  assert.ok(excerptBytes <= 4096, `total excerpt bytes ${excerptBytes}`);
  // A stream past the total cap keeps its reference but carries no excerpt.
  const typecheckCapped = cappedChecks.find((c) => c.id === 'typecheck')!;
  assert.equal(typecheckCapped.stdout!.excerptTail, null);
  assert.equal(typecheckCapped.stdout!.artifactId, 'art-typecheck-stdout');
});

test('test summaries are parsed for known runners and never guessed', () => {
  assert.deepEqual(parseTestSummary('ℹ tests 4\nℹ pass 3\nℹ fail 1\nℹ skipped 0\nℹ todo 0\n'), {
    runner: 'node:test',
    tests: 4,
    pass: 3,
    fail: 1,
    skipped: 0,
    todo: 0,
  });
  assert.deepEqual(parseTestSummary('TAP version 13\n# tests 5\n# pass 4\n# fail 0\n# skipped 1\n# todo 0\n'), {
    runner: 'tap',
    tests: 5,
    pass: 4,
    fail: 0,
    skipped: 1,
    todo: 0,
  });
  assert.deepEqual(parseTestSummary(' Test Files  2 passed (2)\n      Tests  3 failed | 9 passed | 1 skipped (13)\n'), {
    runner: 'vitest',
    tests: 13,
    pass: 9,
    fail: 3,
    skipped: 1,
    todo: 0,
  });
  assert.deepEqual(parseTestSummary('\u001b[1mTests:\u001b[22m       1 failed, 2 skipped, 1 todo, 10 passed, 14 total\n'), {
    runner: 'jest',
    tests: 14,
    pass: 10,
    fail: 1,
    skipped: 2,
    todo: 1,
  });
  // Several node:test runs in one stream are summed.
  assert.deepEqual(parseTestSummary('ℹ tests 2\nℹ pass 2\nℹ fail 0\n...\nℹ tests 3\nℹ pass 2\nℹ fail 1\n'), {
    runner: 'node:test',
    tests: 5,
    pass: 4,
    fail: 1,
    skipped: 0,
    todo: 0,
  });
  for (const unknown of ['', 'all good\n', 'Ran 12 tests in 0.3s\n\nOK\n', 'tests 4 passed\n']) {
    assert.equal(parseTestSummary(unknown), null, JSON.stringify(unknown));
  }

  // Excerpts never split a UTF-8 sequence and are null for non-UTF-8 output.
  assert.deepEqual(excerptTail(utf8('ab€'), 2), { text: '', bytes: 0 });
  assert.deepEqual(excerptTail(utf8('ab€'), 3), { text: '€', bytes: 3 });
  assert.deepEqual(excerptTail(utf8('ab€'), 4), { text: 'b€', bytes: 4 });
  assert.equal(excerptTail(new Uint8Array([0x61, 0xff, 0x62]), 10), null);
  assert.deepEqual(excerptTail(new Uint8Array(), 10), { text: '', bytes: 0 });
});

test('packet bytes are canonical and deterministic', () => {
  const world = fixtureWorld();
  const first = buildReviewPacket(world.sources, world.limits);

  // The same facts in a different order give the same bytes.
  const shuffled: PacketSources = {
    ...world.sources,
    change: {
      ...world.sources.change,
      cumulativeDiff: {
        ...world.sources.change.cumulativeDiff,
        changedFiles: [...world.sources.change.cumulativeDiff.changedFiles].reverse(),
      },
      postImages: [...world.sources.change.postImages].reverse(),
    },
    execution: { ...world.sources.execution, streams: new Map([...world.sources.execution.streams].reverse()) },
    requirements: [...world.sources.requirements].reverse(),
  };
  const second = buildReviewPacket(shuffled, world.limits);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(second.sha256, first.sha256);
  assert.equal(first.sha256, createHash('sha256').update(first.bytes).digest('hex'));

  // Canonical JSON: sorted keys, no insignificant whitespace.
  const text = decode(first.bytes);
  assert.equal(text, JSON.stringify(JSON.parse(text), (_k, v) => sortKeys(v)));
  assert.equal(/\n|": /.test(text), false);

  // Requirements keep work-order order and include only the work order's ids.
  assert.deepEqual(first.packet.workOrder.requirements.map((r) => r.id), ['REQ-2', 'REQ-1']);
  assert.equal(first.packet.packetVersion, 'review-packet/v1');
  assert.equal(first.packet.identity.roundKey, 'attempt-1:assurance:1');
});

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

test('a prior finding keeps exactly its review-finding fields, its unresolved flag included', () => {
  const world = fixtureWorld({ round: 2 });
  const prior: ReviewFindingRecord = {
    id: 'prior-sarif',
    source: 'sarif',
    raisedBy: 'sarif:semgrep',
    fingerprint: 'a'.repeat(64),
    severity: 'HIGH',
    category: 'SECURITY',
    evidence: '[unresolved reference: artifactLocation.uriBaseId] [js.eval-use] eval() on user input',
    requiredFix: 'Resolve the semgrep result js.eval-use reported by check semgrep',
    grounded: true,
    lifecycleState: 'OPEN',
    ruleId: 'js.eval-use',
    unresolvedReference: true,
  };
  // An adjudicated finding carries more than its record; the packet copies the record only.
  const adjudicated = { ...prior, ref: 'prior:prior-sarif', blocking: true };
  const { packet } = buildReviewPacket({ ...world.sources, priorFindings: [adjudicated] }, world.limits);
  assert.deepEqual(packet.priorFindings, [prior]);
  assertPacketWhitelist(packet);
});

test('packet sources must agree with the attempt under review', () => {
  const world = fixtureWorld();
  const s = world.sources;
  const cases: readonly [string, PacketSources][] = [
    ['evidence result sha', { ...s, execution: { ...s.execution, evidence: { ...s.execution.evidence, resultSha: 'f'.repeat(40) } } }],
    ['evidence attempt', { ...s, execution: { ...s.execution, evidence: { ...s.execution.evidence, attemptId: 'other' as never } } }],
    ['work order task', { ...s, workOrder: { ...s.workOrder, id: 'other' as never } }],
    ['fresh review with prior findings', { ...s, priorFindings: [{} as never] }],
    ['fresh review with a repair base', { ...s, change: { ...s.change, repairBaseSha: 'c'.repeat(40) } }],
    ['re-review in round one', { ...s, reviewKind: 're-review' }],
    ['malformed sha', { ...s, change: { ...s.change, resultSha: 'B'.repeat(40) } }],
    [
      'changed file without a blob',
      { ...s, change: { ...s.change, postImages: s.change.postImages.filter((b) => b.path !== 'src/util.ts') } },
    ],
    ['missing raw output', { ...s, execution: { ...s.execution, streams: new Map() } }],
    [
      'raw output with the wrong digest',
      {
        ...s,
        execution: {
          ...s.execution,
          streams: new Map(
            [...s.execution.streams].map(([id, stream]) => [id, { ...stream, content: utf8('tampered') }] as const),
          ),
        },
      },
    ],
  ];
  for (const [label, sources] of cases) {
    assert.throws(() => buildReviewPacket(sources, world.limits), PacketBuildError, label);
  }

  // A changed path that is not normalized is kept as an omission, never read, so the push
  // guard can block the round instead of the build failing without a decision.
  const escaping = buildReviewPacket(
    {
      ...s,
      change: {
        ...s.change,
        cumulativeDiff: {
          ...s.change.cumulativeDiff,
          changedFiles: [...s.change.cumulativeDiff.changedFiles, { path: '../escape.ts', status: 'A', binary: false }],
        },
      },
    },
    world.limits,
  );
  assert.deepEqual(escaping.packet.change.files.find((f) => f.path === '../escape.ts'), {
    path: '../escape.ts',
    status: 'A',
    binary: false,
    postImage: null,
    lineCount: 0,
    omittedReason: 'unsafe-path',
  });
  assert.ok(escaping.omissions.some((o) => o.path === '../escape.ts' && o.reason === 'unsafe-path'));

  // A re-review needs its repair base and repair delta.
  const repair = fixtureWorld({ round: 2 });
  const built = buildReviewPacket(repair.sources, repair.limits);
  assert.equal(built.packet.reviewKind, 're-review');
  assert.equal(built.packet.change.repairBaseSha, 'c'.repeat(40));
  assert.deepEqual(built.packet.change.repairDelta, refFor('review-diff', 'art-delta', repair.contents.get('art-delta')!));
  assert.throws(
    () => buildReviewPacket({ ...repair.sources, change: { ...repair.sources.change, repairDelta: null } }, repair.limits),
    PacketBuildError,
  );
});
