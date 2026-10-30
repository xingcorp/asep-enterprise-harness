import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactId, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId } from '@asep/contracts';
import { loadReviewPolicy } from '@asep/policy';
import { parseUnifiedDiff } from './diff.js';
import { findingFingerprint } from './findings.js';
import { groundFinding } from './grounding.js';
import {
  PacketBuildError,
  assertPacketWhitelist,
  buildCorpusReviewPacket,
  buildReviewPacket,
  type CorpusPacketSources,
  type PacketSources,
} from './packet.js';
import { REVIEW_OUTPUT_SCHEMA, packetNonce, renderReviewPrompt, reviewInstructions, type ReviewOutput } from './prompt.js';
import { fixtureWorld, utf8 } from './test-support.js';
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
  readonly part: string;
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
    readonly maxBytes: number;
    readonly sides: Readonly<
      Record<
        'reviewed' | 'post-fix',
        {
          readonly chunk: string;
          readonly attempt: LabelledId;
          readonly taskBaseSha: string;
          readonly resultSha: string;
          readonly diff: GoldenPart;
          readonly files: readonly (GoldenPart & { readonly path: string; readonly lineCount: number })[];
        }
      >
    >;
  };
}

type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
};

/** The subset of JSON Schema the review output schema uses; returns the first violation, or null. */
function schemaViolation(value: unknown, schema: JsonSchema, path = 'output'): string | null {
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const types = schema.type === undefined ? null : [schema.type].flat();
  if (types !== null && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) return `${path} is ${kind}`;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return `${path} is outside its enum`;
  if (kind === 'array' && schema.items !== undefined) {
    for (const [i, item] of (value as unknown[]).entries()) {
      const v = schemaViolation(item, schema.items, `${path}[${i}]`);
      if (v !== null) return v;
    }
  }
  if (kind === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) return `${path}.${key} is missing`;
    for (const [key, child] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
        continue;
      }
      const v = schemaViolation(child, sub, `${path}.${key}`);
      if (v !== null) return v;
    }
  }
  return null;
}

type RecordedGrounding = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, { grounded: boolean; reason: string | null; fingerprint: string }>>>>>>;

test('the golden historical item reproduces its recorded packet, prompt and grounding on both sides', () => {
  const golden = 'evals/review-benchmark/golden/P2-FINAL-HIGH-003';
  const read = (path: string) => new Uint8Array(readFileSync(join(REPO_ROOT, golden, path)));
  const json = <T>(path: string) => JSON.parse(readFileSync(join(REPO_ROOT, golden, path), 'utf8')) as T;
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  // A `.sha256` file's first field: the digest the independent oracle computed.
  const recordedDigest = (path: string) => readFileSync(join(REPO_ROOT, golden, path), 'utf8').split(/\s+/)[0]!;
  const item = json<GoldenItem>('item.json');
  const { synthetic, roundTrip } = item;
  const grounding = json<RecordedGrounding>('expected-grounding.json');
  const policy = loadReviewPolicy();
  assert.deepEqual(synthetic.execution, NOT_RECORDED);

  for (const side of ['reviewed', 'post-fix'] as const) {
    const record = roundTrip.sides[side];
    const [chunk] = json<{ id: string; files: string[] }[]>(`${side}/chunks.json`);
    assert.equal(chunk!.id, record.chunk, side);
    assert.deepEqual(record.files.map((f) => f.path), chunk!.files, side);

    // The packet sources are the parts the listing names, each with its digest.
    const listing = readFileSync(join(REPO_ROOT, golden, side, 'packet-sources.sha256'), 'utf8');
    const parts = [record.diff, ...record.files].map((part) => {
      const bytes = read(part.part);
      assert.equal(sha256(bytes), part.sha256, part.part);
      assert.ok(listing.includes(`${part.sha256}  ${part.part.slice(side.length + 1)}\n`), part.part);
      return bytes;
    });
    const [diff, ...postImages] = parts as [Uint8Array, ...Uint8Array[]];
    const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const changed = parseUnifiedDiff(decode(diff));
    assert.deepEqual(
      changed.map((f) => [f.path, f.status, f.binary]),
      chunk!.files.map((path) => [path, 'A', false]),
      side,
    );

    const ref = (kind: string, sha: string) => ({ artifactId: sha as ArtifactId, sha256: sha, kind });
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
        cumulativeDiff: { ref: ref('review-diff', record.diff.sha256), bytes: diff.byteLength, overLimit: false, changedFiles: changed.map((f) => ({ path: f.path, status: 'A', binary: f.binary })) },
        repairDelta: null,
        postImages: record.files.map((f, i) => ({ path: f.path, blob: ref('review-blob', f.sha256), bytes: postImages[i]!.byteLength, lineCount: f.lineCount, omittedReason: null })),
      },
      priorFindings: synthetic.priorFindings,
    };

    // The packet validator accepts the packet, and its digest is the one the independent oracle recorded.
    const built = buildCorpusReviewPacket(sources, { maxBytes: roundTrip.maxBytes, excerptBytesPerStream: 4096, excerptBytesTotal: 65536 });
    assertPacketWhitelist(JSON.parse(new TextDecoder().decode(built.bytes)));
    assert.deepEqual(built.packet.execution, NOT_RECORDED, side);
    assert.equal(built.sha256, recordedDigest(`${side}/packet.sha256`), `${side}: packet digest`);

    // The rendered prompt, rubric and output schema included, is the one the oracle recorded.
    const contents = new Map(parts.map((bytes, i) => [[record.diff, ...record.files][i]!.sha256, bytes] as const));
    const prompt = renderReviewPrompt(built, contents);
    assert.equal(prompt.sha256, recordedDigest(`${side}/prompt.sha256`), `${side}: prompt digest`);
    assert.doesNotMatch(new TextDecoder().decode(prompt.bytes), /\bP[0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b|\b(?:CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-[0-9]{3}\b/, side);

    // Each scripted output is a valid model output; its findings ground as the golden files record.
    const ctx = { packet: built.packet, diff: changed, repairDelta: null, minChars: policy.groundingMinChars };
    const outputs = readdirSync(join(REPO_ROOT, golden, 'outputs', side)).map((f) => f.replace(/\.json$/, '')).sort();
    assert.deepEqual(outputs, Object.keys(grounding[side]!).sort(), side);
    for (const name of outputs) {
      const output = json<ReviewOutput>(`outputs/${side}/${name}.json`);
      assert.equal(schemaViolation(output, REVIEW_OUTPUT_SCHEMA as JsonSchema), null, `${side} ${name}`);
      const recorded = grounding[side]![name]!;
      assert.deepEqual(Object.keys(recorded).sort(), output.findings.map((f) => f.key).sort(), `${side} ${name}`);
      for (const finding of output.findings) {
        const outcome = groundFinding(ctx, finding);
        const fingerprint = findingFingerprint({ category: finding.category, file: finding.file, lineStart: finding.lineStart, ruleId: null });
        assert.deepEqual({ ...outcome, fingerprint }, recorded[finding.key], `${side} ${name} ${finding.key}`);
      }
    }
  }
});
