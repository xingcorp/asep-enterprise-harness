import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReviewPolicy, type ReviewPolicy } from '@asep/policy';
import { buildReviewPacket } from './packet.js';
import { renderReviewPrompt } from './prompt.js';
import { runDeterministicCheckRules } from './checks.js';
import { EgressClearanceError, decideEgress, rescanRequestBytes, sendIfCleared } from './egress.js';
import { sha256Hex } from './canonical-json.js';
import { fixtureWorld, utf8, worldFromDiff, type FixtureWorld } from './test-support.js';

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
