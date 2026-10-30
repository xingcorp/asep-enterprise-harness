// Review packet builder: the only input a reviewer ever sees.
//
// The packet is built by whitelist from trusted harness sources: the work order,
// trusted range diffs and post-images, the evidence bundle with its execution
// manifest, and (re-review only) prior adjudicated findings. Every field is picked
// explicitly; nothing is spread from a source object, so coder self-report, context
// packs, events, commit messages, PR text or another reviewer's output cannot ride
// along. Content over the byte budget is flagged, never cut. The budget counts the
// canonical packet itself, so every content-bearing field is in it, plus each content
// part the prompt embeds next to the packet.
//
// A corpus packet (a historical change replayed for the review benchmark) is built by the
// same whitelist from a synthetic identity and work order. A historical tree has no
// recorded execution, so its manifest is `NOT_RECORDED` with no environment and no checks;
// a runtime packet never carries that shape.
//
// Pure: callers resolve artifacts and pass bytes in; the packet is canonical JSON.

import type { ArtifactRef, EvidenceBundle, Requirement, RiskLevel, WorkOrder } from '@asep/contracts';
import { isNormalizedRepoPath } from '@asep/policy';
import { canonicalBytes, sha256Hex } from './canonical-json.js';
import { excerptTail, parseTestSummary } from './execution-manifest.js';
import type {
  ChangedFile,
  PacketCheck,
  PacketExecution,
  PacketFile,
  PacketIdentity,
  PacketOmission,
  PacketStreamRef,
  ReviewBlob,
  ReviewFindingRecord,
  ReviewKind,
  ReviewPacket,
} from './local-types.js';

export class PacketBuildError extends Error {
  constructor(message: string) {
    super(`review packet: ${message}`);
    this.name = 'PacketBuildError';
  }
}

export interface DiffSource {
  readonly ref: ArtifactRef;
  readonly bytes: number;
  /** The reader could not fit the diff in its limit: the packet is flagged over budget. */
  readonly overLimit: boolean;
  readonly changedFiles: readonly ChangedFile[];
}

export interface RawOutput {
  readonly ref: ArtifactRef;
  readonly content: Uint8Array;
}

export interface PacketSources {
  readonly identity: PacketIdentity;
  readonly risk: RiskLevel;
  readonly reviewKind: ReviewKind;
  readonly workOrder: WorkOrder;
  /** Requirement statements available to the harness; only the work order's ids are used. */
  readonly requirements: readonly Requirement[];
  readonly change: {
    readonly taskBaseSha: string;
    readonly resultSha: string;
    readonly repairBaseSha: string | null;
    readonly cumulativeDiff: DiffSource;
    readonly repairDelta: DiffSource | null;
    readonly postImages: readonly ReviewBlob[];
  };
  readonly execution: {
    readonly verdict: 'PASS' | 'FAIL' | 'ERROR';
    readonly evidence: EvidenceBundle;
    /** Raw stdout/stderr by artifact id, as captured before any reduction. */
    readonly streams: ReadonlyMap<string, RawOutput>;
  };
  readonly priorFindings: readonly ReviewFindingRecord[];
}

/**
 * The sources of a corpus packet: a historical change with its synthetic identity and work
 * order. There is no execution source and no evidence bundle to agree with.
 */
export interface CorpusPacketSources {
  readonly identity: PacketIdentity;
  readonly risk: RiskLevel;
  readonly reviewKind: ReviewKind;
  /** The synthetic work order, field for field as the packet carries it. */
  readonly workOrder: ReviewPacket['workOrder'];
  readonly change: PacketSources['change'];
  readonly priorFindings: readonly ReviewFindingRecord[];
}

export interface PacketLimits {
  readonly maxBytes: number;
  readonly excerptBytesPerStream: number;
  readonly excerptBytesTotal: number;
}

export interface BuiltPacket {
  readonly packet: ReviewPacket;
  /** Canonical review-packet/v1 bytes. */
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /**
   * The packet's measured size, reported beside it and never inside it: the UTF-8 length of
   * the canonical packet as it is stored, measured after `overBudget` is set, plus the bytes of
   * the diffs and every post-image the prompt embeds. A packet that is sent is at most
   * `maxBytes`; a rejected packet's stored `true` is one byte shorter than the `false` its
   * budget decision was taken on.
   */
  readonly includedBytes: number;
  readonly overBudget: boolean;
  readonly omissions: readonly PacketOmission[];
}

const SHA1 = /^[0-9a-f]{40}$/;
const TEST_CATEGORIES = new Set(['unit', 'integration', 'acceptance']);

function fail(message: string): never {
  throw new PacketBuildError(message);
}

function byPath<T extends { readonly path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function pickRef(ref: ArtifactRef): ArtifactRef {
  return { artifactId: ref.artifactId, sha256: ref.sha256, kind: ref.kind };
}

function checkLimits(limits: PacketLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) fail(`limit ${name} must be a positive integer`);
  }
}

/** The round, the commits and the review kind agree; shared by runtime and corpus packets. */
function checkChange(s: Pick<PacketSources, 'identity' | 'reviewKind' | 'change' | 'priorFindings'>): void {
  const { identity, change } = s;
  if (!Number.isInteger(identity.round) || identity.round < 1) fail('round must be an integer >= 1');
  if (identity.roundKey !== `${identity.attemptId}:assurance:${identity.round}`) fail('roundKey does not match the attempt and round');
  const expectedKind: ReviewKind = identity.round === 1 ? 'fresh' : 're-review';
  if (s.reviewKind !== expectedKind) fail(`round ${identity.round} must be a ${expectedKind} review`);
  for (const [name, sha] of [
    ['taskBaseSha', change.taskBaseSha],
    ['resultSha', change.resultSha],
  ] as const) {
    if (!SHA1.test(sha)) fail(`${name} must be 40 lowercase hex`);
  }
  if (s.reviewKind === 'fresh') {
    if (change.repairBaseSha !== null || change.repairDelta !== null) fail('a fresh review has no repair base or delta');
    if (s.priorFindings.length > 0) fail('a fresh review has no prior findings');
  } else {
    if (change.repairBaseSha === null || !SHA1.test(change.repairBaseSha)) fail('a re-review needs a 40-hex repair base');
    if (change.repairDelta === null) fail('a re-review needs the repair delta');
  }
}

function checkConsistency(s: PacketSources): void {
  const { identity, change, execution } = s;
  checkChange(s);
  if (s.workOrder.id !== identity.taskId) fail('work order belongs to another task');
  if (execution.evidence.taskId !== identity.taskId || execution.evidence.attemptId !== identity.attemptId) {
    fail('evidence belongs to another attempt');
  }
  if (execution.evidence.resultSha !== change.resultSha) fail('evidence resultSha differs from the reviewed commit');
}

function buildFiles(change: PacketSources['change']): PacketFile[] {
  const blobs = new Map<string, ReviewBlob>();
  for (const blob of change.postImages) {
    if (blobs.has(blob.path)) fail(`duplicate post-image for ${blob.path}`);
    blobs.set(blob.path, blob);
  }
  const seen = new Set<string>();
  const files = [...change.cumulativeDiff.changedFiles].sort(byPath).map((file): PacketFile => {
    if (seen.has(file.path)) fail(`duplicate changed path ${file.path}`);
    seen.add(file.path);
    // A path that is not normalizable is kept, so the push guard can block the round on
    // it, but its content is never taken, whatever the reader returned for it.
    if (!isNormalizedRepoPath(file.path)) {
      return { path: file.path, status: file.status, binary: file.binary, postImage: null, lineCount: 0, omittedReason: 'unsafe-path' };
    }
    const blob = blobs.get(file.path);
    if (blob === undefined) fail(`no post-image result for changed file ${file.path}`);
    if ((blob.blob === null) === (blob.omittedReason === null)) {
      fail(`post-image of ${file.path} must be either present or omitted with a reason`);
    }
    if (file.status === 'D' && blob.omittedReason !== 'deleted') fail(`deleted file ${file.path} must be omitted as deleted`);
    if (file.binary && blob.blob !== null) fail(`binary file ${file.path} must be omitted`);
    return {
      path: file.path,
      status: file.status,
      binary: file.binary,
      postImage: blob.blob === null ? null : pickRef(blob.blob),
      lineCount: blob.lineCount,
      omittedReason: blob.omittedReason,
    };
  });
  for (const path of blobs.keys()) {
    if (!seen.has(path)) fail(`post-image for ${path}, which the diff does not change`);
  }
  return files;
}

function buildChecks(execution: PacketSources['execution'], limits: PacketLimits): PacketCheck[] {
  let remaining = limits.excerptBytesTotal;
  const stream = (artifactId: string | undefined): { ref: PacketStreamRef; content: Uint8Array } | null => {
    if (artifactId === undefined) return null;
    const raw = execution.streams.get(artifactId);
    if (raw === undefined) fail(`raw output ${artifactId} referenced by the evidence is unavailable`);
    if (raw.ref.artifactId !== artifactId || sha256Hex(raw.content) !== raw.ref.sha256) {
      fail(`raw output ${artifactId} does not match its reference`);
    }
    const limit = Math.min(limits.excerptBytesPerStream, remaining);
    const excerpt = limit > 0 ? excerptTail(raw.content, limit) : null;
    if (excerpt !== null) remaining -= excerpt.bytes;
    return {
      ref: { artifactId, sha256: raw.ref.sha256, bytes: raw.content.byteLength, excerptTail: excerpt?.text ?? null },
      content: raw.content,
    };
  };
  const lenient = new TextDecoder();
  const checks = execution.evidence.checks.map((check): PacketCheck => {
    const stdout = stream(check.stdoutArtifactId);
    const stderr = stream(check.stderrArtifactId);
    let testSummary = null;
    if (TEST_CATEGORIES.has(check.category)) {
      for (const s of [stdout, stderr]) {
        if (testSummary === null && s !== null) testSummary = parseTestSummary(lenient.decode(s.content));
      }
    }
    return {
      id: check.id,
      category: check.category,
      command: check.command,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      stdout: stdout?.ref ?? null,
      stderr: stderr?.ref ?? null,
      testSummary,
    };
  });
  return checks;
}

/** A review-finding/v1 record with exactly its own fields, whatever else the source object carries. */
export function pickFindingRecord(f: ReviewFindingRecord): ReviewFindingRecord {
  return {
    id: f.id,
    source: f.source,
    raisedBy: f.raisedBy,
    fingerprint: f.fingerprint,
    severity: f.severity,
    category: f.category,
    evidence: f.evidence,
    requiredFix: f.requiredFix,
    grounded: f.grounded,
    lifecycleState: f.lifecycleState,
    ...(f.groundingReason === undefined ? {} : { groundingReason: f.groundingReason }),
    ...(f.requirementId === undefined ? {} : { requirementId: f.requirementId }),
    ...(f.file === undefined ? {} : { file: f.file }),
    ...(f.lineStart === undefined ? {} : { lineStart: f.lineStart }),
    ...(f.lineEnd === undefined ? {} : { lineEnd: f.lineEnd }),
    ...(f.ruleId === undefined ? {} : { ruleId: f.ruleId }),
    ...(f.priorFindingId === undefined ? {} : { priorFindingId: f.priorFindingId }),
  };
}

/** Build the canonical review packet. Throws PacketBuildError when the sources disagree. */
export function buildReviewPacket(sources: PacketSources, limits: PacketLimits): BuiltPacket {
  checkLimits(limits);
  checkConsistency(sources);
  const { workOrder, execution } = sources;
  const checks = buildChecks(execution, limits);

  const statements = new Map(sources.requirements.map((r) => [r.id, r] as const));
  const requirements = [...new Set(workOrder.requirementIds)].flatMap((id) => {
    const r = statements.get(id);
    return r === undefined ? [] : [{ id: r.id, statement: r.statement, priority: r.priority }];
  });

  return assemble(
    sources,
    {
      objective: workOrder.objective,
      requirementIds: [...workOrder.requirementIds],
      requirements,
      allowedPaths: [...workOrder.allowedPaths],
      forbiddenChanges: [...workOrder.forbiddenChanges],
      architectureInvariants: [...workOrder.architectureInvariants],
      acceptanceCheckIds: [...workOrder.acceptanceCheckIds],
    },
    {
      verdict: execution.verdict,
      environment: {
        imageDigest: execution.evidence.environment.imageDigest,
        lockfileHash: execution.evidence.environment.lockfileHash,
        nodeVersion: execution.evidence.environment.nodeVersion ?? null,
      },
      checks,
    },
    limits,
  );
}

/**
 * Build the canonical packet of a corpus change. Its execution manifest is always
 * `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }`. Throws PacketBuildError when
 * the sources disagree.
 */
export function buildCorpusReviewPacket(sources: CorpusPacketSources, limits: PacketLimits): BuiltPacket {
  checkLimits(limits);
  checkChange(sources);
  const { workOrder } = sources;
  return assemble(
    sources,
    {
      objective: workOrder.objective,
      requirementIds: [...workOrder.requirementIds],
      requirements: workOrder.requirements.map((r) => ({ id: r.id, statement: r.statement, priority: r.priority })),
      allowedPaths: [...workOrder.allowedPaths],
      forbiddenChanges: [...workOrder.forbiddenChanges],
      architectureInvariants: [...workOrder.architectureInvariants],
      acceptanceCheckIds: [...workOrder.acceptanceCheckIds],
    },
    { verdict: 'NOT_RECORDED', environment: null, checks: [] },
    limits,
  );
}

function assemble(
  sources: Pick<PacketSources, 'identity' | 'risk' | 'reviewKind' | 'change' | 'priorFindings'>,
  workOrder: ReviewPacket['workOrder'],
  execution: PacketExecution,
  limits: PacketLimits,
): BuiltPacket {
  const { identity, change } = sources;
  const files = buildFiles(change);
  const omissions: PacketOmission[] = files
    .filter((f) => f.omittedReason !== null)
    .map((f) => ({ path: f.path, reason: f.omittedReason! }));

  const priorFindings = [...sources.priorFindings].map(pickFindingRecord).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const measured: ReviewPacket = {
    packetVersion: 'review-packet/v1',
    identity: {
      organizationId: identity.organizationId,
      projectId: identity.projectId,
      repositoryBindingId: identity.repositoryBindingId,
      runId: identity.runId,
      taskId: identity.taskId,
      attemptId: identity.attemptId,
      round: identity.round,
      roundKey: identity.roundKey,
    },
    risk: sources.risk,
    reviewKind: sources.reviewKind,
    workOrder,
    change: {
      taskBaseSha: change.taskBaseSha,
      resultSha: change.resultSha,
      repairBaseSha: change.repairBaseSha,
      cumulativeDiff: pickRef(change.cumulativeDiff.ref),
      repairDelta: change.repairDelta === null ? null : pickRef(change.repairDelta.ref),
      files,
    },
    execution,
    priorFindings,
    budget: { maxBytes: limits.maxBytes, overBudget: false, omissions },
  };
  // The budget decision: the canonical packet exactly as it would be sent, plus the diffs and
  // every post-image the prompt embeds. An over-budget packet only changes its flag and is never
  // sent. The size reported is then measured again on the packet as it is stored.
  const embeddedBytes =
    change.cumulativeDiff.bytes +
    (change.repairDelta?.bytes ?? 0) +
    files.reduce((n, f) => n + (f.postImage === null ? 0 : (change.postImages.find((b) => b.path === f.path)?.bytes ?? 0)), 0);
  const overBudget =
    canonicalBytes(measured).byteLength + embeddedBytes > limits.maxBytes ||
    change.cumulativeDiff.overLimit ||
    (change.repairDelta?.overLimit ?? false);
  const packet: ReviewPacket = overBudget ? { ...measured, budget: { ...measured.budget, overBudget } } : measured;
  assertPacketWhitelist(packet);
  const bytes = canonicalBytes(packet);
  return { packet, bytes, sha256: sha256Hex(bytes), includedBytes: bytes.byteLength + embeddedBytes, overBudget, omissions };
}

// --- whitelist -------------------------------------------------------------------------

type Shape =
  | 'string'
  | 'number'
  | 'boolean'
  | { readonly nullable: Shape }
  | { readonly array: Shape }
  | { readonly fields: Readonly<Record<string, Shape>>; readonly optional?: readonly string[] };

const REF: Shape = { fields: { artifactId: 'string', sha256: 'string', kind: 'string' } };
const STREAM: Shape = {
  nullable: { fields: { artifactId: 'string', sha256: 'string', bytes: 'number', excerptTail: { nullable: 'string' } } },
};

const FINDING: Shape = {
  fields: {
    id: 'string',
    source: 'string',
    raisedBy: 'string',
    fingerprint: 'string',
    severity: 'string',
    category: 'string',
    evidence: 'string',
    requiredFix: 'string',
    grounded: 'boolean',
    groundingReason: 'string',
    lifecycleState: 'string',
    requirementId: 'string',
    file: 'string',
    lineStart: 'number',
    lineEnd: 'number',
    ruleId: 'string',
    priorFindingId: 'string',
  },
  optional: ['groundingReason', 'requirementId', 'file', 'lineStart', 'lineEnd', 'ruleId', 'priorFindingId'],
};

/** The complete review-packet/v1 shape. A field that is not here cannot reach a reviewer. */
const PACKET_SHAPE: Shape = {
  fields: {
    packetVersion: 'string',
    identity: {
      fields: {
        organizationId: 'string',
        projectId: 'string',
        repositoryBindingId: 'string',
        runId: 'string',
        taskId: 'string',
        attemptId: 'string',
        round: 'number',
        roundKey: 'string',
      },
    },
    risk: 'string',
    reviewKind: 'string',
    workOrder: {
      fields: {
        objective: 'string',
        requirementIds: { array: 'string' },
        requirements: { array: { fields: { id: 'string', statement: 'string', priority: 'string' } } },
        allowedPaths: { array: 'string' },
        forbiddenChanges: { array: 'string' },
        architectureInvariants: { array: 'string' },
        acceptanceCheckIds: { array: 'string' },
      },
    },
    change: {
      fields: {
        taskBaseSha: 'string',
        resultSha: 'string',
        repairBaseSha: { nullable: 'string' },
        cumulativeDiff: REF,
        repairDelta: { nullable: REF },
        files: {
          array: {
            fields: {
              path: 'string',
              status: 'string',
              binary: 'boolean',
              postImage: { nullable: REF },
              lineCount: 'number',
              omittedReason: { nullable: 'string' },
            },
          },
        },
      },
    },
    execution: {
      fields: {
        verdict: 'string',
        environment: { nullable: { fields: { imageDigest: 'string', lockfileHash: 'string', nodeVersion: { nullable: 'string' } } } },
        checks: {
          array: {
            fields: {
              id: 'string',
              category: 'string',
              command: 'string',
              exitCode: 'number',
              durationMs: 'number',
              stdout: STREAM,
              stderr: STREAM,
              testSummary: {
                nullable: {
                  fields: {
                    runner: 'string',
                    tests: 'number',
                    pass: 'number',
                    fail: 'number',
                    skipped: 'number',
                    todo: 'number',
                  },
                },
              },
            },
          },
        },
      },
    },
    priorFindings: { array: FINDING },
    budget: {
      fields: {
        maxBytes: 'number',
        overBudget: 'boolean',
        omissions: { array: { fields: { path: 'string', reason: 'string' } } },
      },
    },
  },
};

function check(value: unknown, shape: Shape, path: string): void {
  if (shape === 'string' || shape === 'number' || shape === 'boolean') {
    if (typeof value !== shape || (shape === 'number' && !Number.isFinite(value))) fail(`${path} must be a ${shape}`);
    return;
  }
  if ('nullable' in shape) {
    if (value !== null) check(value, shape.nullable, path);
    return;
  }
  if ('array' in shape) {
    if (!Array.isArray(value)) fail(`${path} must be a list`);
    value.forEach((item, i) => check(item, shape.array, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in shape.fields)) fail(`${path}.${key} is not a review packet field`);
  }
  for (const [key, child] of Object.entries(shape.fields)) {
    if (!(key in obj) || obj[key] === undefined) {
      if (shape.optional?.includes(key)) continue;
      fail(`${path}.${key} is required`);
    }
    check(obj[key], child, `${path}.${key}`);
  }
}

const VERDICTS: ReadonlySet<unknown> = new Set(['PASS', 'FAIL', 'ERROR', 'NOT_RECORDED']);

/** A recorded verdict has an environment; only NOT_RECORDED has none, and no checks either. */
function checkExecution(execution: { readonly verdict: unknown; readonly environment: unknown; readonly checks: readonly unknown[] }): void {
  if (!VERDICTS.has(execution.verdict)) fail('packet.execution.verdict must be PASS, FAIL, ERROR or NOT_RECORDED');
  const notRecorded = execution.verdict === 'NOT_RECORDED';
  if ((execution.environment === null) !== notRecorded || (notRecorded && execution.checks.length > 0)) {
    fail('packet.execution has no environment and no checks exactly when its verdict is NOT_RECORDED');
  }
}

/** Throws PacketBuildError unless `value` has exactly the review-packet/v1 shape. */
export function assertPacketWhitelist(value: unknown): void {
  check(value, PACKET_SHAPE, 'packet');
  checkExecution((value as ReviewPacket).execution);
}

/** Every field path a packet may carry, e.g. `change.files[].path`. */
export function packetFieldPaths(): readonly string[] {
  const out: string[] = [];
  const walk = (shape: Shape, path: string): void => {
    if (typeof shape === 'string') return;
    if ('nullable' in shape) return walk(shape.nullable, path);
    if ('array' in shape) return walk(shape.array, `${path}[]`);
    for (const [key, child] of Object.entries(shape.fields)) {
      const next = path === '' ? key : `${path}.${key}`;
      out.push(next);
      walk(child, next);
    }
  };
  walk(PACKET_SHAPE, '');
  return out;
}
