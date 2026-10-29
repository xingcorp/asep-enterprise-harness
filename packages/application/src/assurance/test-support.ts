// Shared fixtures for the assurance unit tests: an in-memory attempt whose packet
// sources, raw outputs and artifact contents are built from plain strings. Test
// support only; nothing in production imports this module.

import { createHash } from 'node:crypto';
import type { ArtifactId, ArtifactRef, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId } from '@asep/contracts';
import type { PacketLimits, PacketSources } from './packet.js';

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

export interface FixtureOptions {
  readonly diff?: string;
  readonly unitStdout?: string;
  readonly unitExitCode?: number;
  readonly round?: number;
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
  const featureRef = store('review-blob', 'art-feature', FEATURE_TS);
  const utilRef = store('review-blob', 'art-util', UTIL_TS);
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
      objective: 'Add a greeting helper',
      requirementIds: ['REQ-2', 'REQ-1'],
      baseSha: TASK_BASE_SHA,
      allowedPaths: ['src/**', 'assets/**'],
      forbiddenChanges: ['infra/**'],
      architectureInvariants: ['domain imports nothing from adapters'],
      acceptanceCheckIds: ['unit', 'typecheck'],
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
        changedFiles: [
          { path: 'src/util.ts', status: 'M', binary: false },
          { path: 'assets/logo.png', status: 'M', binary: true },
          { path: 'src/feature.ts', status: 'A', binary: false },
          { path: 'src/old.ts', status: 'D', binary: false },
        ],
      },
      repairDelta:
        deltaRef === null
          ? null
          : { ref: deltaRef, bytes: utf8(diffText).byteLength, overLimit: false, changedFiles: [] },
      postImages: [
        { path: 'src/feature.ts', blob: featureRef, bytes: utf8(FEATURE_TS).byteLength, lineCount: 3, omittedReason: null },
        { path: 'src/util.ts', blob: utilRef, bytes: utf8(UTIL_TS).byteLength, lineCount: 2, omittedReason: null },
        { path: 'assets/logo.png', blob: null, bytes: 2048, lineCount: 0, omittedReason: 'binary' },
        { path: 'src/old.ts', blob: null, bytes: 0, lineCount: 0, omittedReason: 'deleted' },
      ],
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
