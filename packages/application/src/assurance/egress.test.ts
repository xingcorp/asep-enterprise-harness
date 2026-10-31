import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReviewPolicy, type ReviewPolicy } from '@asep/policy';
import { buildReviewPacket } from './packet.js';
import { renderReviewPrompt } from './prompt.js';
import { runDeterministicCheckRules } from './checks.js';
import { EgressClearanceError, decideEgress, rescanRequestBytes, sendIfCleared } from './egress.js';
import { sha256Hex } from './canonical-json.js';
import { fixtureWorld, gitDiff, utf8, worldFromDiff, type FixtureWorld } from './test-support.js';

console.log('SUITE-ID: asep-suite:assurance-egress');

const AWS_KEY = 'AKIA' + 'Q'.repeat(16);
const SRC = { allowedPaths: ['src/**', 'assets/**', 'config/**', 'certs/**'] };

function optedIn(policy: ReviewPolicy = loadReviewPolicy()): ReviewPolicy {
  return { ...policy, egress: { ...policy.egress, enabledProjects: ['project-1'] } };
}

/** The deterministic checks and the request bytes a reviewer call would send for this world. */
function prepare(world: FixtureWorld, policy: ReviewPolicy = optedIn()) {
  const built = buildReviewPacket(world.sources, world.limits);
  const checks = runDeterministicCheckRules({
    policy,
    built,
    contents: world.contents,
    recordedVerdicts: [],
    invariants: [],
    sarif: [],
  });
  let requestBytes: Uint8Array;
  try {
    requestBytes = renderReviewPrompt(built, world.contents).bytes;
  } catch {
    requestBytes = built.bytes;
  }
  return { built, checks, requestBytes };
}

function fakeProvider() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    send: async () => {
      calls += 1;
      return { status: 'COMPLETED' as const };
    },
  };
}

test('no reviewer request leaves the harness unless egress is clear', async () => {
  const withNonUtf8PostImage = (): FixtureWorld => {
    const world = fixtureWorld();
    const bad = new Uint8Array([0x65, 0xff, 0x0a]);
    const contents = new Map(world.contents).set('art-feature', bad);
    const postImages = world.sources.change.postImages.map((b) =>
      b.path === 'src/feature.ts' ? { ...b, blob: { ...b.blob!, sha256: sha256Hex(bad) }, bytes: bad.byteLength } : b,
    );
    return { ...world, contents, sources: { ...world.sources, change: { ...world.sources.change, postImages } } };
  };

  const stops: readonly (readonly [string, FixtureWorld, ReviewPolicy, string])[] = [
    [
      'push guard blocks a secret in an added line',
      worldFromDiff([{ path: 'src/config.ts', status: 'A', added: [`k = '${AWS_KEY}'`] }], SRC),
      optedIn(),
      'push-guard',
    ],
    [
      'secret in a removed line',
      worldFromDiff([{ path: 'src/config.ts', status: 'M', context: ['x'], removed: [`k = '${AWS_KEY}'`] }], SRC),
      optedIn(),
      'egress-secret',
    ],
    [
      'classified path',
      worldFromDiff([{ path: 'config/.env.example', status: 'A', added: ['LOG_LEVEL=debug'] }], SRC),
      optedIn(),
      'egress-classified',
    ],
    ['project not opted in', fixtureWorld(), loadReviewPolicy(), 'egress-classified'],
    ['content that cannot be scanned', withNonUtf8PostImage(), optedIn(), 'egress-unscannable'],
  ];
  for (const [label, world, policy, expected] of stops) {
    const { built, checks, requestBytes } = prepare(world, policy);
    const provider = fakeProvider();
    const outcome = await sendIfCleared(
      { pushGuard: checks.pushGuard, egress: { decision: checks.egress.decision, packetSha256: checks.egress.packetSha256 } },
      { packetSha256: built.sha256, requestBytes },
      provider.send,
    );
    assert.deepEqual(outcome, { sent: false, stop: expected }, label);
    assert.equal(provider.calls, 0, label);
  }

  // A clear packet whose final request bytes carry a secret (for example from a request field
  // added after the packet decision) is stopped by the re-scan of the exact bytes.
  const clean = prepare(fixtureWorld());
  assert.equal(clean.checks.egress.decision, 'CLEAR');
  const tainted = new Uint8Array([...clean.requestBytes, ...utf8(` ${AWS_KEY}`)]);
  const rescanProvider = fakeProvider();
  assert.deepEqual(
    await sendIfCleared(
      { pushGuard: clean.checks.pushGuard, egress: clean.checks.egress },
      { packetSha256: clean.built.sha256, requestBytes: tainted },
      rescanProvider.send,
    ),
    { sent: false, stop: 'egress-request-rescan' },
  );
  assert.equal(rescanProvider.calls, 0);

  // A decision made for another packet authorizes nothing.
  const other = fakeProvider();
  await assert.rejects(
    sendIfCleared(
      { pushGuard: clean.checks.pushGuard, egress: { decision: 'CLEAR', packetSha256: 'f'.repeat(64) } },
      { packetSha256: clean.built.sha256, requestBytes: clean.requestBytes },
      other.send,
    ),
    EgressClearanceError,
  );
  assert.equal(other.calls, 0);

  // Only a clear decision with clean request bytes sends, exactly once.
  const provider = fakeProvider();
  assert.deepEqual(
    await sendIfCleared(
      { pushGuard: clean.checks.pushGuard, egress: clean.checks.egress },
      { packetSha256: clean.built.sha256, requestBytes: clean.requestBytes },
      provider.send,
    ),
    { sent: true, result: { status: 'COMPLETED' } },
  );
  assert.equal(provider.calls, 1);
});

/** Send through the choke point with the round's own clearance, and also with the push guard ignored. */
async function sendsUnder(checks: ReturnType<typeof prepare>['checks'], built: ReturnType<typeof prepare>['built'], requestBytes: Uint8Array) {
  const provider = fakeProvider();
  const egress = { decision: checks.egress.decision, packetSha256: checks.egress.packetSha256 };
  const outcomes = [];
  for (const pushGuard of [checks.pushGuard, { decision: 'PASS' } as const]) {
    outcomes.push(await sendIfCleared({ pushGuard, egress }, { packetSha256: built.sha256, requestBytes }, provider.send));
  }
  return { outcomes, calls: provider.calls };
}

test('a path that is not normalizable is refused before the gateway', async () => {
  // Line breaks, other control characters and a path still in Git's quoted form. The diff
  // quotes each path the way git does, so the parser sees the real name.
  const unsafe = [
    'src/line\nbreak/secrets/customer.txt',
    'src/line\nbreak/customer.txt',
    'src/carriage\rreturn.ts',
    'src/line\u2028separator.ts',
    'src/paragraph\u2029separator.ts',
    'src/tab\tname.ts',
    'src/delete\u007fname.ts',
    'src/next\u0085line.ts',
    '"src/caf\\303\\251.ts"',
  ];
  const content = ['export const customer = "first record";'];
  for (const path of unsafe) {
    const label = JSON.stringify(path);
    const { built, checks, requestBytes } = prepare(worldFromDiff([{ path, status: 'A', added: content }], { allowedPaths: ['**'] }));
    // The packet keeps the path so the guard can block on it, and never takes its content.
    const file = built.packet.change.files.find((f) => f.path === path);
    assert.deepEqual([file?.postImage, file?.omittedReason], [null, 'unsafe-path'], label);
    assert.deepEqual(checks.pushGuard, { decision: 'BLOCK', reason: 'forbidden-path' }, label);
    assert.equal(checks.egress.decision, 'STOP_CLASSIFIED', label);
    assert.ok(checks.egress.hits.some((h) => h.kind === 'deny-path' && h.detail === path), label);
    // A finding never records such a path as its file.
    for (const finding of checks.findings) assert.notEqual(finding.file, path, label);
    const sent = await sendsUnder(checks, built, requestBytes);
    assert.deepEqual(sent.outcomes.map((o) => o.sent), [false, false], label);
    assert.equal(sent.calls, 0, label);
  }

  // The same name only as a rename's source, and only in a repair delta, blocks the same way.
  const renamed = prepare(
    worldFromDiff([{ path: 'src/plain.ts', oldPath: 'src/line\nbreak.ts', status: 'R', context: ['export const a = 1;'] }], {
      allowedPaths: ['**'],
    }),
  );
  assert.deepEqual(renamed.checks.pushGuard, { decision: 'BLOCK', reason: 'forbidden-path' });
  assert.equal(renamed.checks.egress.decision, 'STOP_CLASSIFIED');
  assert.equal((await sendsUnder(renamed.checks, renamed.built, renamed.requestBytes)).calls, 0);
  const delta = gitDiff([{ path: 'src/plain.ts', oldPath: 'src/line\u2028break.ts', status: 'R', context: ['export const a = 1;'] }]);
  const inDelta = prepare(
    worldFromDiff([{ path: 'src/plain.ts', status: 'A', added: ['export const a = 1;'] }], { allowedPaths: ['**'], round: 2, repairDelta: delta }),
  );
  assert.deepEqual(inDelta.checks.pushGuard, { decision: 'BLOCK', reason: 'forbidden-path' });

  // Positive control: the same change at a plain path is clear and sends exactly once.
  const plain = prepare(worldFromDiff([{ path: 'src/line/customer.txt', status: 'A', added: content }], { allowedPaths: ['**'] }));
  assert.deepEqual(plain.checks.pushGuard, { decision: 'PASS' });
  assert.equal(plain.checks.egress.decision, 'CLEAR');
  const provider = fakeProvider();
  const outcome = await sendIfCleared(
    { pushGuard: plain.checks.pushGuard, egress: plain.checks.egress },
    { packetSha256: plain.built.sha256, requestBytes: plain.requestBytes },
    provider.send,
  );
  assert.equal(outcome.sent, true);
  assert.equal(provider.calls, 1);
});

test('both sides of every entry of both diffs are classified', async () => {
  const content = ['customer = first record'];
  const round2 = (entries: Parameters<typeof worldFromDiff>[0], delta: string) =>
    worldFromDiff(entries, { allowedPaths: ['**'], round: 2, repairDelta: delta });
  const stops: readonly (readonly [string, FixtureWorld, string])[] = [
    // The review's probe: the repair moves a classified file to an ordinary path; the
    // cumulative diff shows only the target.
    [
      'rename out of a classified path, in the repair delta only',
      round2([{ path: 'src/customer.txt', status: 'A', added: content }], gitDiff([{ path: 'src/customer.txt', oldPath: 'secrets/customer.txt', status: 'R', context: content }])),
      'secrets/customer.txt',
    ],
    [
      'copy of a classified file, in the cumulative diff',
      worldFromDiff([{ path: 'src/settings.txt', oldPath: '.env', status: 'C', added: content }], { allowedPaths: ['**'] }),
      '.env',
    ],
    [
      'copy of a classified file, in the repair delta only',
      round2([{ path: 'src/settings.txt', status: 'A', added: content }], gitDiff([{ path: 'src/settings.txt', oldPath: 'config/.env.local', status: 'C', added: content }])),
      'config/.env.local',
    ],
    [
      'deletion of a classified file, in the repair delta only',
      round2([{ path: 'src/a.ts', status: 'A', added: ['export const a = 1;'] }], gitDiff([{ path: 'deploy/tls.key', status: 'D', removed: content }])),
      'deploy/tls.key',
    ],
    [
      'a classified file only the repair delta changes',
      round2([{ path: 'src/a.ts', status: 'A', added: ['export const a = 1;'] }], gitDiff([{ path: 'secrets/db.yaml', status: 'M', context: ['a: 1'], removed: content }])),
      'secrets/db.yaml',
    ],
  ];
  for (const [label, world, sensitive] of stops) {
    const { built, checks, requestBytes } = prepare(world);
    assert.equal(checks.egress.decision, 'STOP_CLASSIFIED', label);
    assert.ok(checks.egress.hits.some((h) => h.kind === 'deny-path' && h.detail === sensitive), `${label}: ${JSON.stringify(checks.egress.hits)}`);
    const sent = await sendsUnder(checks, built, requestBytes);
    assert.equal(sent.calls, 0, label);
  }

  // A repair delta that cannot be parsed cannot be classified, so nothing is sent.
  const garbled = prepare(round2([{ path: 'src/a.ts', status: 'A', added: ['export const a = 1;'] }], 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n+a\n+b\n'));
  assert.equal(garbled.checks.egress.decision, 'STOP_UNSCANNABLE');
  assert.ok(garbled.checks.egress.hits.some((h) => h.kind === 'unscannable' && h.part === 'repair-delta'));
  assert.equal((await sendsUnder(garbled.checks, garbled.built, garbled.requestBytes)).calls, 0);

  // Positive control: both sides of both diffs are ordinary paths, and the round is clear.
  const ordinary = prepare(
    round2([{ path: 'src/customer.txt', status: 'A', added: content }], gitDiff([{ path: 'src/customer.txt', oldPath: 'src/draft.txt', status: 'R', context: content }])),
  );
  assert.equal(ordinary.checks.egress.decision, 'CLEAR', JSON.stringify(ordinary.checks.egress.hits));
});

test('egress decision scans every part the prompt carries', () => {
  const policy = optedIn();
  const decide = (world: FixtureWorld) => decideEgress(policy, buildReviewPacket(world.sources, world.limits), world.contents);

  assert.deepEqual(decide(fixtureWorld()).hits, []);

  const cases: readonly (readonly [string, FixtureWorld, string])[] = [
    ['work order text', fixtureWorld({ objective: `rotate ${AWS_KEY}` }), 'packet'],
    ['output excerpt', fixtureWorld({ unitStdout: `ℹ tests 1\nℹ pass 1\nℹ fail 0\nkey=${AWS_KEY}\n` }), 'packet'],
    [
      'post-image',
      fixtureWorld({
        files: [{ path: 'src/feature.ts', status: 'A', content: `export const k = '${AWS_KEY}';\n`, artifactId: 'art-feature' }],
        diff: 'diff --git a/src/feature.ts b/src/feature.ts\nnew file mode 100644\n',
      }),
      'file-0',
    ],
    ['diff', worldFromDiff([{ path: 'src/a.ts', status: 'M', context: ['x'], removed: [AWS_KEY] }], SRC), 'diff'],
    [
      'repair delta',
      worldFromDiff([{ path: 'src/a.ts', status: 'M', context: ['x'], added: [AWS_KEY] }], { ...SRC, round: 2 }),
      'repair-delta',
    ],
  ];
  for (const [label, world, part] of cases) {
    const result = decide(world);
    assert.equal(result.decision, 'STOP_SECRET', label);
    assert.ok(
      result.hits.some((h) => h.kind === 'secret' && h.part === part),
      `${label}: ${JSON.stringify(result.hits)}`,
    );
    // The decision record names the pattern, never the value.
    assert.equal(JSON.stringify(result).includes(AWS_KEY), false, label);
  }

  // Missing or substituted content is unscannable, never assumed clean.
  const world = fixtureWorld();
  const missing = new Map(world.contents);
  missing.delete('art-util');
  const built = buildReviewPacket(world.sources, world.limits);
  assert.equal(decideEgress(policy, built, missing).decision, 'STOP_UNSCANNABLE');
  const swapped = new Map(world.contents).set('art-util', utf8('export const swapped = true;\n'));
  assert.equal(decideEgress(policy, built, swapped).decision, 'STOP_UNSCANNABLE');
  assert.equal(decideEgress(policy, built, world.contents).packetSha256, built.sha256);
});

test('classification and opt-in come from the review policy', () => {
  const decide = (world: FixtureWorld, policy: ReviewPolicy) =>
    decideEgress(policy, buildReviewPacket(world.sources, world.limits), world.contents);

  const notOptedIn = decide(fixtureWorld(), loadReviewPolicy());
  assert.equal(notOptedIn.decision, 'STOP_CLASSIFIED');
  assert.deepEqual(notOptedIn.hits.map((h) => h.kind), ['not-opted-in']);

  for (const [path, entry] of [
    ['config/.env.example', { path: 'config/.env.example', status: 'A', added: ['A=1'] }],
    ['certs/tls.key', { path: 'certs/tls.key', status: 'D', removed: ['x'] }],
    ['certs/server.p12', { path: 'certs/server.p12', status: 'A', binary: true }],
    ['.env (renamed away)', { path: 'src/settings.txt', oldPath: '.env', status: 'R', context: ['A=1'] }],
  ] as const) {
    const result = decide(worldFromDiff([entry], SRC), optedIn());
    assert.equal(result.decision, 'STOP_CLASSIFIED', path);
    assert.ok(result.hits.some((h) => h.kind === 'deny-path'), path);
  }

  // The exact request bytes are re-scanned on their own.
  assert.equal(rescanRequestBytes(utf8('{"input":"clean"}')), 'CLEAR');
  assert.equal(rescanRequestBytes(utf8(`{"input":"${AWS_KEY}"}`)), 'STOP_SECRET');
  assert.equal(rescanRequestBytes(new Uint8Array([0x7b, 0xff, 0x7d])), 'STOP_UNSCANNABLE');
});

test('a key at the start of a line still stops egress when the line is inside JSON text', () => {
  const policy = optedIn();
  const decide = (world: FixtureWorld) => decideEgress(policy, buildReviewPacket(world.sources, world.limits), world.contents);
  // Assembled at run time, so this file holds nothing a scanner would flag.
  const key = 'sk-' + 'Ab3'.repeat(16);
  const workflowId = 'asep-task-' + '01JC8Z3K5V7N9QWRT2XYZ4ABCD';

  // A test's output excerpt is a JSON string in the packet: its line breaks are escaped there.
  const leaked = decide(fixtureWorld({ unitStdout: `ℹ tests 1\nℹ pass 1\nℹ fail 0\n${key}\n` }));
  assert.equal(leaked.decision, 'STOP_SECRET');
  assert.ok(leaked.hits.some((h) => h.kind === 'secret' && h.part === 'packet'), JSON.stringify(leaked.hits));
  // A workflow id in the same place is no key.
  assert.equal(decide(fixtureWorld({ unitStdout: `ℹ tests 1\nℹ pass 1\nℹ fail 0\n${workflowId}\n` })).decision, 'CLEAR');

  // The request carries the prompt, which carries the packet: a line break there is escaped once or twice.
  assert.equal(rescanRequestBytes(utf8(JSON.stringify({ input: `ok\n${key}` }))), 'STOP_SECRET');
  assert.equal(rescanRequestBytes(utf8(JSON.stringify({ input: JSON.stringify({ out: `ok\n${key}` }) }))), 'STOP_SECRET');
  assert.equal(rescanRequestBytes(utf8(JSON.stringify({ input: JSON.stringify({ out: `ok\n${workflowId}` }) }))), 'CLEAR');
});
