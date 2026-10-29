// Shared fixtures for the assurance unit tests: an in-memory attempt whose packet
// sources, raw outputs and artifact contents are built from plain strings. Test
// support only; nothing in production imports this module.

import { createHash } from 'node:crypto';
import type { ArtifactId, ArtifactRef, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId } from '@asep/contracts';
import { loadReviewPolicy } from '@asep/policy';
import { buildReviewPacket, type PacketLimits, type PacketSources } from './packet.js';
import { runDeterministicCheckRules } from './checks.js';
import { parseUnifiedDiff } from './diff.js';
import type { AdjudicationInput, ReviewInput } from './adjudication.js';
import type { ModelFindingOutput, ReviewOutput } from './prompt.js';
import type { ChangedFile, PacketOmissionReason, ReviewBlob } from './local-types.js';

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function refFor(kind: string, id: string, bytes: Uint8Array): ArtifactRef {
  return { artifactId: id as ArtifactId, sha256: sha256Of(bytes), kind };
}

export const TASK_BASE_SHA = 'a'.repeat(40);
export const RESULT_SHA = 'b'.repeat(40);
export const PRIOR_RESULT_SHA = 'c'.repeat(40);

export const FEATURE_TS = [
  "export function greet(name: string): string {",
  "  return `hello ${name}`;",
  '}',
  '',
].join('\n');

export const UTIL_TS = ['export const answer = 42;', 'export const other = 7;', ''].join('\n');

export const DIFF = [
  'diff --git a/src/feature.ts b/src/feature.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/feature.ts',
  '@@ -0,0 +1,3 @@',
  '+export function greet(name: string): string {',
  '+  return `hello ${name}`;',
  '+}',
  'diff --git a/src/util.ts b/src/util.ts',
  '--- a/src/util.ts',
  '+++ b/src/util.ts',
  '@@ -1 +1,2 @@',
  ' export const answer = 42;',
  '+export const other = 7;',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export const legacy = 1;',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  '',
].join('\n');

export const NODE_TEST_STDOUT = [
  '✔ greets by name (0.4ms)',
  'ℹ tests 3',
  'ℹ suites 0',
  'ℹ pass 3',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 12.5',
  '',
].join('\n');

export interface FixtureWorld {
  readonly sources: PacketSources;
  /** Artifact contents by artifact id (diff, repair delta, post-images, raw outputs). */
  readonly contents: Map<string, Uint8Array>;
  readonly limits: PacketLimits;
}

export interface FixtureFile {
  readonly path: string;
  readonly status: 'A' | 'M' | 'D' | 'R';
  readonly binary?: boolean;
  /** Post-image text; omitted files have none. */
  readonly content?: string;
  readonly omittedReason?: PacketOmissionReason;
  readonly artifactId?: string;
}

/** The changed files of the default diff. */
export const DEFAULT_FILES: readonly FixtureFile[] = [
  { path: 'src/util.ts', status: 'M', content: UTIL_TS, artifactId: 'art-util' },
  { path: 'assets/logo.png', status: 'M', binary: true },
  { path: 'src/feature.ts', status: 'A', content: FEATURE_TS, artifactId: 'art-feature' },
  { path: 'src/old.ts', status: 'D' },
];

export interface FixtureOptions {
  readonly diff?: string;
  /** Changed files; must agree with `diff`. */
  readonly files?: readonly FixtureFile[];
  readonly unitStdout?: string;
  readonly unitExitCode?: number;
  readonly round?: number;
  readonly objective?: string;
  readonly allowedPaths?: readonly string[];
  readonly forbiddenChanges?: readonly string[];
  readonly acceptanceCheckIds?: readonly string[];
}

/** A complete, consistent attempt: fresh review of round 1 unless `round` says otherwise. */
export function fixtureWorld(options: FixtureOptions = {}): FixtureWorld {
  const contents = new Map<string, Uint8Array>();
  const store = (kind: string, id: string, text: string | Uint8Array): ArtifactRef => {
    const bytes = typeof text === 'string' ? utf8(text) : text;
    contents.set(id, bytes);
    return refFor(kind, id, bytes);
  };

  const round = options.round ?? 1;
  const reReview = round > 1;
  const diffText = options.diff ?? DIFF;
  const diffRef = store('review-diff', 'art-diff', diffText);
  const deltaRef = reReview ? store('review-diff', 'art-delta', diffText) : null;
  const changedFiles: ChangedFile[] = [];
  const postImages: ReviewBlob[] = [];
  (options.files ?? DEFAULT_FILES).forEach((file, i) => {
    const binary = file.binary ?? false;
    changedFiles.push({ path: file.path, status: file.status, binary });
    const omittedReason: PacketOmissionReason | null =
      file.status === 'D' ? 'deleted' : binary ? 'binary' : (file.omittedReason ?? null);
    const content = file.content ?? '';
    const lineCount = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;
    if (omittedReason === null) {
      const blob = store('review-blob', file.artifactId ?? `art-file-${i}`, content);
      postImages.push({ path: file.path, blob, bytes: utf8(content).byteLength, lineCount, omittedReason: null });
    } else {
      const bytes = omittedReason === 'deleted' ? 0 : binary ? 2048 : utf8(content).byteLength;
      postImages.push({ path: file.path, blob: null, bytes, lineCount: 0, omittedReason });
    }
  });
  const unitStdout = store('raw-output', 'art-unit-stdout', options.unitStdout ?? NODE_TEST_STDOUT);
  const unitStderr = store('raw-output', 'art-unit-stderr', '');
  const typecheckStdout = store('raw-output', 'art-typecheck-stdout', 'tsc: no errors\n');

  const streams = new Map<string, { readonly ref: ArtifactRef; readonly content: Uint8Array }>();
  for (const ref of [unitStdout, unitStderr, typecheckStdout]) {
    streams.set(ref.artifactId, { ref, content: contents.get(ref.artifactId)! });
  }

  const sources: PacketSources = {
    identity: {
      organizationId: 'org-1' as OrganizationId,
      projectId: 'project-1' as ProjectId,
      repositoryBindingId: 'binding-1' as RepositoryBindingId,
      runId: 'run-1' as RunId,
      taskId: 'task-1' as TaskId,
      attemptId: `attempt-${round}` as AttemptId,
      round,
      roundKey: `attempt-${round}:assurance:${round}`,
    },
    risk: 'R1',
    reviewKind: reReview ? 're-review' : 'fresh',
    workOrder: {
      id: 'task-1' as TaskId,
      runId: 'run-1' as RunId,
      objective: options.objective ?? 'Add a greeting helper',
      requirementIds: ['REQ-2', 'REQ-1'],
      baseSha: TASK_BASE_SHA,
      allowedPaths: [...(options.allowedPaths ?? ['src/**', 'assets/**'])],
      forbiddenChanges: [...(options.forbiddenChanges ?? ['infra/**'])],
      architectureInvariants: ['domain imports nothing from adapters'],
      acceptanceCheckIds: [...(options.acceptanceCheckIds ?? ['unit', 'typecheck'])],
      risk: 'R1',
      requiredSkills: [],
      budget: { maxTurns: 10, maxToolCalls: 50, maxCostUsd: 5, maxWallClockMinutes: 30 },
    },
    requirements: [
      { id: 'REQ-1', statement: 'Greets a user by name', priority: 'MUST' },
      { id: 'REQ-2', statement: 'Keeps the answer constant', priority: 'SHOULD' },
      { id: 'REQ-9', statement: 'Not part of this work order', priority: 'COULD' },
    ],
    change: {
      taskBaseSha: TASK_BASE_SHA,
      resultSha: RESULT_SHA,
      repairBaseSha: reReview ? PRIOR_RESULT_SHA : null,
      cumulativeDiff: {
        ref: diffRef,
        bytes: utf8(diffText).byteLength,
        overLimit: false,
        changedFiles,
      },
      repairDelta:
        deltaRef === null
          ? null
          : { ref: deltaRef, bytes: utf8(diffText).byteLength, overLimit: false, changedFiles: [] },
      postImages,
    },
    execution: {
      verdict: 'PASS',
      evidence: {
        taskId: 'task-1' as TaskId,
        attemptId: `attempt-${round}` as AttemptId,
        baseSha: reReview ? PRIOR_RESULT_SHA : TASK_BASE_SHA,
        resultSha: RESULT_SHA,
        createdAt: '2026-10-29T10:00:00.000Z',
        environment: { imageDigest: `sha256:${'d'.repeat(64)}`, lockfileHash: 'e'.repeat(64), nodeVersion: 'v24.10.0' },
        diff: { artifactId: 'art-diff' as ArtifactId, sha256: diffRef.sha256 },
        checks: [
          {
            id: 'unit',
            category: 'unit',
            command: 'pnpm test',
            exitCode: options.unitExitCode ?? 0,
            durationMs: 1200,
            stdoutArtifactId: unitStdout.artifactId,
            stderrArtifactId: unitStderr.artifactId,
          },
          {
            id: 'typecheck',
            category: 'static',
            command: 'pnpm typecheck',
            exitCode: 0,
            durationMs: 800,
            stdoutArtifactId: typecheckStdout.artifactId,
          },
        ],
      },
      streams,
    },
    priorFindings: [],
  };

  return { sources, contents, limits: { maxBytes: 400000, excerptBytesPerStream: 4096, excerptBytesTotal: 65536 } };
}

export interface DiffEntry {
  readonly path: string;
  readonly status: 'A' | 'M' | 'D' | 'R';
  readonly oldPath?: string;
  readonly binary?: boolean;
  /** Unchanged lines at the top of the hunk. */
  readonly context?: readonly string[];
  readonly removed?: readonly string[];
  readonly added?: readonly string[];
}

/** A git-style unified diff for the given entries. */
export function gitDiff(entries: readonly DiffEntry[]): string {
  const out: string[] = [];
  for (const e of entries) {
    const oldPath = e.oldPath ?? e.path;
    out.push(`diff --git a/${oldPath} b/${e.path}`);
    if (e.status === 'A') out.push('new file mode 100644');
    if (e.status === 'D') out.push('deleted file mode 100644');
    if (e.status === 'R') out.push('similarity index 90%', `rename from ${oldPath}`, `rename to ${e.path}`);
    if (e.binary) {
      out.push(`Binary files ${e.status === 'A' ? '/dev/null' : `a/${oldPath}`} and ${e.status === 'D' ? '/dev/null' : `b/${e.path}`} differ`);
      continue;
    }
    const context = e.context ?? [];
    const removed = e.removed ?? [];
    const added = e.added ?? [];
    if (context.length + removed.length + added.length === 0) continue;
    out.push(e.status === 'A' ? '--- /dev/null' : `--- a/${oldPath}`);
    out.push(e.status === 'D' ? '+++ /dev/null' : `+++ b/${e.path}`);
    const oldCount = context.length + removed.length;
    const newCount = context.length + added.length;
    out.push(`@@ -${oldCount === 0 ? 0 : 1},${oldCount} +${newCount === 0 ? 0 : 1},${newCount} @@`);
    for (const line of context) out.push(` ${line}`);
    for (const line of removed) out.push(`-${line}`);
    for (const line of added) out.push(`+${line}`);
  }
  return `${out.join('\n')}\n`;
}

/** A fixture whose diff and changed files both come from `entries`. */
export function worldFromDiff(entries: readonly DiffEntry[], options: Omit<FixtureOptions, 'diff' | 'files'> = {}): FixtureWorld {
  const files: FixtureFile[] = entries.map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.binary ? { binary: true } : {}),
    ...(e.status === 'D' || e.binary ? {} : { content: [...(e.context ?? []), ...(e.added ?? [])].map((l) => `${l}\n`).join('') }),
  }));
  return fixtureWorld({ ...options, diff: gitDiff(entries), files });
}

// --- adjudication fixtures -------------------------------------------------------------------

export const PRIMARY = 'primary-gpt';
export const COMPARATOR = 'comparator-deepseek';
export const MODEL_EVIDENCE = 'greet() interpolates the name without escaping it for HTML output';
export const MODEL_FIX = 'Escape the name before interpolating it';

export function modelFinding(over: Partial<ModelFindingOutput> = {}): ModelFindingOutput {
  return {
    key: 'f1',
    severity: 'HIGH',
    category: 'CORRECTNESS',
    file: 'src/feature.ts',
    lineStart: 2,
    lineEnd: 2,
    requirementId: null,
    evidence: MODEL_EVIDENCE,
    requiredFix: MODEL_FIX,
    confidence: 0.8,
    ...over,
  };
}

export function reviewOutput(over: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    verdict: 'APPROVE',
    findings: [],
    priorFindingClaims: [],
    packetAssessment: { coverage: 'complete', notes: '' },
    ...over,
  };
}

export function completedReview(reviewerConfigId: string, output: ReviewOutput, recordSha256 = sha256Of(utf8(reviewerConfigId))): ReviewInput {
  return { reviewerConfigId, status: 'COMPLETED_VALID', failureReason: null, recordSha256, output };
}

/** A consistent adjudication input: one independent primary reviewer that approved, gating mode. */
export function adjudicationBase(options: { readonly round?: number; readonly world?: FixtureWorld } = {}): AdjudicationInput {
  const world = options.world ?? fixtureWorld({ round: options.round ?? 1 });
  const round = world.sources.identity.round;
  const built = buildReviewPacket(world.sources, world.limits);
  const policy = loadReviewPolicy();
  const checks = runDeterministicCheckRules({
    policy: { ...policy, egress: { ...policy.egress, enabledProjects: ['project-1'] } },
    built,
    contents: world.contents,
    recordedVerdicts: world.sources.execution.evidence.checks.map((c) => ({
      checkId: c.id,
      verdict: c.exitCode === 0 ? ('PASS' as const) : ('FAIL' as const),
    })),
    invariants: [],
    sarif: [],
  });
  const decode = (id: string) => new TextDecoder().decode(world.contents.get(id)!);
  return {
    roundKey: built.packet.identity.roundKey,
    attemptId: built.packet.identity.attemptId,
    round,
    mode: 'gating',
    maxRounds: 2,
    blockingSeverities: ['CRITICAL', 'HIGH'],
    groundingMinChars: { evidence: 40, requiredFix: 20 },
    policyVersion: `1.0.0+sha256:${'7'.repeat(64)}`,
    now: '2026-10-29T10:00:00.000Z',
    packet: built.packet,
    packetSha256: built.sha256,
    diff: parseUnifiedDiff(decode('art-diff')),
    repairDelta: round > 1 ? parseUnifiedDiff(decode('art-delta')) : null,
    checks: {
      pushGuard: checks.pushGuard,
      egress: { decision: checks.egress.decision, packetSha256: checks.egress.packetSha256 },
      findings: checks.findings,
      reportSha256: sha256Of(utf8(JSON.stringify(checks.findings))),
    },
    unsatisfiable: null,
    reviewers: [{ reviewerConfigId: PRIMARY, role: 'primary', independentOfImplementer: true }],
    reviews: [completedReview(PRIMARY, reviewOutput())],
    priorFindings: [],
    fence: { leaseId: 'lease-1', leaseEpoch: 1 },
  };
}
