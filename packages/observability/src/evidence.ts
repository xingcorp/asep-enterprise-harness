// EvidenceBundle generator.
//
// Produces a schema-valid EvidenceBundle (packages/contracts EvidenceBundle
// contract) for one trusted-runner attempt. The core rule (docs/platform/
// verification-and-review.md "Raw evidence rule"): raw stdout/stderr, exit code
// and machine output are captured by the trusted runner BEFORE any reducer runs.
// This generator therefore takes already-captured raw artifacts (by id + hash)
// and never embeds or reduces them — it only references them.
//
// The generated bundle is validated against the authoritative EvidenceBundle
// JSON Schema via the contracts validator; assertValid throws if it drifts.

import { assertValid, type EvidenceBundle } from '@asep/contracts';

export interface RawCheckCapture {
  readonly id: string;
  readonly category:
    | 'workspace' | 'static' | 'unit' | 'integration' | 'architecture'
    | 'security' | 'acceptance' | 'nonfunctional' | 'review' | 'release';
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  // Artifact ids for raw output captured BEFORE any reducer. Optional because a
  // check may produce no output, but when present they must be real artifact ids.
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
}

export interface EvidenceInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly createdAt: string;
  readonly environment: {
    readonly imageDigest: string;
    readonly lockfileHash: string;
    readonly nodeVersion?: string;
  };
  readonly diff: { readonly artifactId: string; readonly sha256: string };
  readonly checks: readonly RawCheckCapture[];
}

/**
 * Build a schema-valid EvidenceBundle from raw captures. Throws (via assertValid)
 * if the result does not conform to the EvidenceBundle contract, so a drifted
 * generator can never emit an invalid bundle silently.
 */
export function generateEvidenceBundle(input: EvidenceInput): EvidenceBundle {
  const bundle = {
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    resultSha: input.resultSha,
    createdAt: input.createdAt,
    environment: {
      imageDigest: input.environment.imageDigest,
      lockfileHash: input.environment.lockfileHash,
      ...(input.environment.nodeVersion !== undefined
        ? { nodeVersion: input.environment.nodeVersion }
        : {}),
    },
    diff: { artifactId: input.diff.artifactId, sha256: input.diff.sha256 },
    checks: input.checks.map((c) => ({
      id: c.id,
      category: c.category,
      command: c.command,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      ...(c.stdoutArtifactId !== undefined ? { stdoutArtifactId: c.stdoutArtifactId } : {}),
      ...(c.stderrArtifactId !== undefined ? { stderrArtifactId: c.stderrArtifactId } : {}),
    })),
  };

  // Validate against the authoritative schema. Throws on any drift.
  return assertValid<EvidenceBundle>('evidence-bundle', bundle);
}
