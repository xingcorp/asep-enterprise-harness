// Local stand-ins for shared types that other work lands later. Each group names
// the module that will own it; replacing a group is an import swap, the shapes
// here are copies of the agreed definitions.

import type { ArtifactRef, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RiskLevel, RunId, TaskId } from '@asep/contracts';
import type { FindingLifecycleState, FindingSeverity, FindingSource } from '@asep/domain';

// --- review-loop slot contract (packages/application/src/review-loop/slot.ts) ----------

export type ReviewKind = 'fresh' | 're-review';
/** `unsafe-path`: the path is not normalizable; it is never read, and the push guard blocks the round. */
export type PacketOmissionReason = 'binary' | 'too-large' | 'deleted' | 'submodule' | 'non-utf8' | 'unsafe-path';
export type BlockReason = 'secret-in-diff' | 'forbidden-path' | 'unscannable-sensitive-change';
export type EgressDecision = 'CLEAR' | 'STOP_SECRET' | 'STOP_CLASSIFIED' | 'STOP_UNSCANNABLE';
export type ReviewMode = 'not-required' | 'shadow' | 'gating';
export type ReviewerRole = 'primary' | 'comparator';

export type EscalationReason =
  | 'packet-over-budget'
  | 'egress-stopped'
  | 'independence-unsatisfiable'
  | 'reviewer-unavailable'
  | 'reviewer-escalated'
  | 'max-repair-rounds'
  | 'budget-exhausted';

export type ReviewRecordStatus = 'COMPLETED_VALID' | 'COMPLETED_INVALID' | 'FAILED' | 'EGRESS_STOPPED' | 'SKIPPED_PUSH_GUARD';

/** What gating mode would have decided. Recorded only; it never changes the workflow. */
export interface ShadowVerdict {
  readonly wouldBe: 'PROCEED' | 'REPAIR' | 'ESCALATE';
  readonly reason: EscalationReason | 'blocking-findings' | null;
  readonly blockingFindings: number;
}

// --- trusted review source port (@asep/ports: ReviewSourceReader) ----------------------

export interface ChangedFile {
  /** As git reports it. A path that is not normalizable is never read (omission `unsafe-path`). */
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

// --- review contracts (@asep/contracts: review-finding/v1, review-packet/v1,
//     architecture-invariant 1.1.0) -----------------------------------------------------

export interface ArchitectureInvariantRecord {
  readonly id: string;
  readonly statement: string;
  readonly category: 'DEPENDENCY' | 'LAYERING' | 'SECURITY' | 'DATA' | 'NAMING' | 'OTHER';
  readonly rationale?: string;
  /** Optional machine check; invariants without one are judged by reviewers only. */
  readonly check?: {
    readonly kind: 'forbidden-import';
    readonly fromGlobs: readonly string[];
    /** JavaScript regular expression over the import specifier. */
    readonly specifierPattern: string;
  };
}

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
