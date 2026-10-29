// Local stand-ins for shared types that other work lands later. Each group names
// the module that will own it; replacing a group is an import swap, the shapes
// here are copies of the agreed definitions.

import type { ArtifactRef, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RiskLevel, RunId, TaskId } from '@asep/contracts';
import type { FindingLifecycleState, FindingSeverity, FindingSource } from '@asep/domain';

// --- review-loop slot contract (packages/application/src/review-loop/slot.ts) ----------

export type ReviewKind = 'fresh' | 're-review';
export type PacketOmissionReason = 'binary' | 'too-large' | 'deleted' | 'submodule' | 'non-utf8';

// --- trusted review source port (@asep/ports: ReviewSourceReader) ----------------------

export interface ChangedFile {
  /** Repo-relative, normalized; never absolute, never '..'. */
  readonly path: string;
  readonly status: 'A' | 'M' | 'D' | 'R';
  readonly binary: boolean;
}

export interface ReviewBlob {
  readonly path: string;
  /** Null when omitted. */
  readonly blob: ArtifactRef | null;
  readonly bytes: number;
  readonly lineCount: number;
  readonly omittedReason: PacketOmissionReason | null;
}

// --- review contracts (@asep/contracts: review-finding/v1, review-packet/v1) -----------

export type FindingCategory =
  | 'SPEC'
  | 'ARCHITECTURE'
  | 'CORRECTNESS'
  | 'SECURITY'
  | 'PERFORMANCE'
  | 'TEST_QUALITY'
  | 'MAINTAINABILITY'
  | 'EVIDENCE_INTEGRITY';

export interface ReviewFindingRecord {
  readonly id: string;
  readonly source: FindingSource;
  readonly raisedBy: string;
  /** sha256(category, normalized path, line bucket, ruleId), 64 lowercase hex. */
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly category: FindingCategory;
  readonly evidence: string;
  readonly requiredFix: string;
  /** Set by the harness, never by a model. */
  readonly grounded: boolean;
  readonly groundingReason?: string;
  readonly lifecycleState: FindingLifecycleState;
  readonly requirementId?: string;
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly ruleId?: string;
  readonly priorFindingId?: string;
}

export interface PacketIdentity {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly round: number;
  readonly roundKey: string;
}

export interface PacketStreamRef {
  readonly artifactId: string;
  readonly sha256: string;
  /** Size of the whole raw stream. */
  readonly bytes: number;
  /** Last bytes of the stream as UTF-8; null when not included (total cap reached or not UTF-8). */
  readonly excerptTail: string | null;
}

export interface TestSummary {
  readonly runner: 'node:test' | 'tap' | 'vitest' | 'jest';
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly todo: number;
}

export type CheckCategory =
  | 'workspace'
  | 'static'
  | 'unit'
  | 'integration'
  | 'architecture'
  | 'security'
  | 'acceptance'
  | 'nonfunctional'
  | 'review'
  | 'release';

export interface PacketCheck {
  readonly id: string;
  readonly category: CheckCategory;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: PacketStreamRef | null;
  readonly stderr: PacketStreamRef | null;
  /** Null when the output matches no known runner summary; never guessed. */
  readonly testSummary: TestSummary | null;
}

export interface PacketFile {
  readonly path: string;
  readonly status: 'A' | 'M' | 'D' | 'R';
  readonly binary: boolean;
  readonly postImage: ArtifactRef | null;
  readonly lineCount: number;
  readonly omittedReason: PacketOmissionReason | null;
}

export interface PacketOmission {
  readonly path: string;
  readonly reason: PacketOmissionReason;
}

export interface ReviewPacket {
  readonly packetVersion: 'review-packet/v1';
  readonly identity: PacketIdentity;
  readonly risk: RiskLevel;
  readonly reviewKind: ReviewKind;
  readonly workOrder: {
    readonly objective: string;
    readonly requirementIds: readonly string[];
    /** Statements for the requirement ids that could be resolved, in work-order order. */
    readonly requirements: readonly { readonly id: string; readonly statement: string; readonly priority: string }[];
    readonly allowedPaths: readonly string[];
    readonly forbiddenChanges: readonly string[];
    readonly architectureInvariants: readonly string[];
    readonly acceptanceCheckIds: readonly string[];
  };
  readonly change: {
    readonly taskBaseSha: string;
    readonly resultSha: string;
    readonly repairBaseSha: string | null;
    readonly cumulativeDiff: ArtifactRef;
    readonly repairDelta: ArtifactRef | null;
    readonly files: readonly PacketFile[];
  };
  readonly execution: {
    readonly verdict: 'PASS' | 'FAIL' | 'ERROR';
    readonly environment: { readonly imageDigest: string; readonly lockfileHash: string; readonly nodeVersion: string | null };
    readonly checks: readonly PacketCheck[];
  };
  /** Re-review only: prior adjudicated findings with ids and lifecycle state. */
  readonly priorFindings: readonly ReviewFindingRecord[];
  readonly budget: {
    readonly maxBytes: number;
    /** Content bytes the prompt would carry: diffs, post-images and output excerpts. */
    readonly includedBytes: number;
    readonly overBudget: boolean;
    readonly omissions: readonly PacketOmission[];
  };
}
