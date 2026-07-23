// Hand-authored runtime types that are NOT part of the 12 canonical JSON-Schema
// contracts. Branded identifiers, lifecycle enums, and the internal execution
// shapes (agent attempt / verification result) live here. The 12 canonical
// contract types are generated from schema/*.schema.json into ./generated.ts;
// they import the shared names below via ./base.js.

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ProjectId = Brand<string, 'ProjectId'>;
export type RunId = Brand<string, 'RunId'>;
export type MilestoneId = Brand<string, 'MilestoneId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

// Phase 2 operational identifiers (data-model §1). ULID-shaped strings generated
// by the harness; branded so they cannot be crossed with business identifiers.
export type OrganizationId = Brand<string, 'OrganizationId'>;
export type RepositoryBindingId = Brand<string, 'RepositoryBindingId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type CommandExecutionId = Brand<string, 'CommandExecutionId'>;
export type PullRequestId = Brand<string, 'PullRequestId'>;

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
export type RunStatus =
  | 'DRAFT' | 'DISCOVERY' | 'SPECIFICATION_REVIEW' | 'ARCHITECTURE_REVIEW'
  | 'PLANNING' | 'READY' | 'EXECUTING' | 'VERIFYING' | 'INDEPENDENT_REVIEW'
  | 'REPAIRING' | 'INTEGRATING' | 'PRODUCT_ACCEPTANCE' | 'RELEASE_REHEARSAL'
  | 'WAITING_FOR_APPROVAL' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'DONE';

// ---------------------------------------------------------------------------
// Phase 2 operational lifecycle enums (data-model §4). These govern the
// harness-owned operational state machines in @asep/domain. They are NOT the
// business RunStatus above; a Task/Attempt/Lease progresses through these.
// ---------------------------------------------------------------------------

// Task: no machine transition into ACCEPTED/DONE — WAITING_FOR_HUMAN_REVIEW is
// terminal for the harness (data-model §4, exit criterion I2).
export type TaskStatus =
  | 'PENDING' | 'READY' | 'EXECUTING' | 'VERIFYING'
  | 'WAITING_FOR_HUMAN_REVIEW' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

export type AttemptStatus =
  | 'STARTED' | 'AGENT_RUNNING' | 'AGENT_DONE' | 'INSPECTING' | 'VERIFYING'
  | 'EVIDENCE_BUILT' | 'COMMITTED' | 'PUSHED' | 'PR_OPEN' | 'SUCCEEDED'
  | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED' | 'CANCELLED';

export type LeaseStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'QUARANTINED';

// A scoped, hash-carrying reference to an immutable content-addressed artifact.
// Authoritative links use this shape (artifact id + expected checksum + kind),
// never an arbitrary path (architecture §6, data-model §3 disp. P2-PLAN-HIGH-004).
export interface ArtifactRef {
  readonly artifactId: ArtifactId;
  readonly sha256: string;
  readonly kind: string;
}

// Shared value-object types referenced by the generated contracts via x-tsType.
export interface SkillRef { readonly id: string; readonly version: string; }
export interface Budget {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxCostUsd: number;
  readonly maxWallClockMinutes: number;
}

// Internal execution shapes (not canonical contracts, not schema-governed).
export interface AgentAttemptResult {
  readonly attemptId: AttemptId;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED';
  readonly startSha: string;
  readonly resultSha?: string;
  readonly changedFiles: readonly string[];
  readonly summary: string;
  readonly knownLimitations: readonly string[];
  readonly artifactIds: readonly ArtifactId[];
  readonly usage: Usage;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelCostUsd: number;
  readonly toolCalls: number;
  readonly wallClockMs: number;
}

export interface VerificationResult {
  readonly planId: string;
  readonly verdict: 'PASS' | 'FAIL' | 'ERROR';
  readonly checks: readonly CheckResult[];
  readonly evidenceArtifactIds: readonly ArtifactId[];
}

export interface CheckResult {
  readonly id: string;
  readonly category: 'workspace'|'static'|'unit'|'integration'|'architecture'|'security'|'acceptance'|'nonfunctional';
  readonly verdict: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  readonly durationMs: number;
  readonly artifactId?: ArtifactId;
  readonly message?: string;
}
