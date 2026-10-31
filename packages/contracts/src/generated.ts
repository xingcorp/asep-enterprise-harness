// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: packages/contracts/schema/*.schema.json
// Regenerate with: pnpm --filter @asep/contracts gen:types
// The drift-guard test (src/drift.test.ts) fails if this file is stale.

import type { ArtifactId, ArtifactRef, AttemptId, Budget, OrganizationId, ProjectId, RepositoryBindingId, RiskLevel, RunId, SkillRef, TaskId } from './base.js';

export interface AcceptanceScenario {
  readonly id: string;
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
  readonly automated: boolean;
}

export interface ArchitectureInvariant {
  readonly id: string;
  readonly statement: string;
  readonly category: "DEPENDENCY" | "LAYERING" | "SECURITY" | "DATA" | "NAMING" | "OTHER";
  readonly rationale?: string;
}

export interface ContextPack {
  readonly id: string;
  readonly generatedAt: string;
  readonly baseSha: string;
  readonly objective: string;
  readonly specificationExcerpt: string;
  readonly architectureInvariants: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly relevantSymbols: readonly string[];
  readonly priorEvidenceIds: readonly string[];
  readonly skills: readonly SkillRef[];
  readonly allowedTools: readonly string[];
  readonly deniedOperations: readonly string[];
  readonly hash: string;
}

/** Trusted-runner evidence for one attempt. Raw stdout/stderr are captured before any reducer and referenced by artifact id, never embedded. */
export interface EvidenceBundle {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly createdAt: string;
  readonly environment: {
  readonly imageDigest: string;
  readonly lockfileHash: string;
  readonly nodeVersion?: string;
};
  readonly diff: {
  readonly artifactId: ArtifactId;
  readonly sha256: string;
};
  readonly checks: readonly ({
  readonly id: string;
  readonly category: "workspace" | "static" | "unit" | "integration" | "architecture" | "security" | "acceptance" | "nonfunctional" | "review" | "release";
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutArtifactId?: ArtifactId;
  readonly stderrArtifactId?: ArtifactId;
})[];
}

/** Operational routing record that crosses the API/CLI/worker/persistence (and future Temporal) boundaries. Separate from the business WorkOrder: the envelope carries the operational identifiers (org/project/repository-binding/run/task/attempt) plus an immutable reference to the WorkOrder and the schema versions in play. Boundary code rejects malformed or unknown envelope versions. */
export interface ExecutionEnvelope {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly workOrderRef: ArtifactRef;
  readonly workOrderSchemaVersion: string;
  readonly envelopeSchemaVersion: string;
}

export interface Finding {
  readonly id: string;
  readonly severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly category: "SPEC" | "ARCHITECTURE" | "CORRECTNESS" | "SECURITY" | "PERFORMANCE" | "TEST_QUALITY" | "MAINTAINABILITY";
  readonly requirementId?: string;
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly evidence: string;
  readonly requiredFix: string;
}

export interface ProductSpec {
  readonly id: string;
  readonly version: number;
  readonly objective: string;
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly requirements: readonly Requirement[];
  readonly nonFunctionalRequirements: readonly Requirement[];
  readonly acceptanceScenarios: readonly AcceptanceScenario[];
  readonly architectureInvariants: readonly string[];
}

export interface Requirement {
  readonly id: string;
  readonly statement: string;
  readonly rationale?: string;
  readonly priority: "MUST" | "SHOULD" | "COULD";
}

export interface ReviewReport {
  readonly reviewerProvider: string;
  readonly reviewerModel: string;
  readonly verdict: "APPROVE" | "REQUEST_CHANGES" | "ESCALATE";
  readonly findings: readonly Finding[];
  readonly confidence: number;
}

/** Immutable telemetry record emitted by the trusted harness. This is the single source catalog for every metric operand: the measurement dictionary may only reference eventType values and field names defined here. */
export interface RunEvent {
  readonly eventId: string;
  readonly eventType: "run.started" | "run.completed" | "task.started" | "task.completed" | "attempt.started" | "attempt.declared_complete" | "attempt.completed" | "verification.completed" | "review.completed" | "repair.started" | "integration.completed" | "deployment.completed" | "incident.opened" | "human.intervention" | "workflow.recovered" | "approval.requested" | "approval.expired" | "budget.threshold_crossed" | "review.finding_dispositioned";
  readonly occurredAt: string;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly attemptId?: AttemptId;
  readonly risk?: RiskLevel;
  readonly outcome?: "accepted" | "rejected" | "failed" | "blocked" | "cancelled" | "succeeded" | "pass" | "fail" | "error";
  readonly declaredComplete?: boolean;
  readonly passedRequiredAssurance?: boolean;
  readonly failureClass?: string;
  readonly scopeViolation?: boolean;
  readonly reviewFindingsTotal?: number;
  readonly reviewFindingsValid?: number;
  readonly reviewFindingsFalsePositive?: number;
  readonly escapedDefect?: boolean;
  readonly repairCycles?: number;
  readonly leadTimeMs?: number;
  readonly deploymentFrequencyWindowDays?: number;
  readonly changeFailure?: boolean;
  readonly restoreTimeMs?: number;
  readonly modelCostUsd?: number;
  readonly computeCostUsd?: number;
  readonly reviewCostUsd?: number;
  readonly humanMinutes?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolCalls?: number;
  readonly durationMs?: number;
  readonly requirementAccepted?: boolean;
  readonly userJourneySuccess?: boolean;
  readonly tenantId?: string;
  readonly projectId?: ProjectId;
  readonly organizationId?: OrganizationId;
  readonly repositoryBindingId?: RepositoryBindingId;
  readonly interventionKind?: "pause" | "resume" | "cancel" | "seal" | "approval-approve" | "approval-reject";
  readonly recoveryKind?: "activity-retry" | "side-effect-reconciled" | "fencing-takeover" | "attempt-replaced" | "workspace-rehydrated" | "decision-redelivered";
  readonly approvalKind?: "budget-extension" | "publish-change";
  readonly budgetScope?: "attempt" | "task" | "run";
  readonly thresholdKind?: "soft" | "hard";
  readonly workflowId?: string;
  readonly attemptTerminal?: "verification-stopped" | "proceeded" | "repair-requested" | "escalated" | "blocked" | "agent-failed" | "budget-exhausted" | "cancelled" | "infrastructure-failed";
  readonly verificationVerdict?: "PASS" | "FAIL" | "ERROR";
  readonly adjudicationId?: string;
  readonly reviewRound?: number;
  readonly reviewerConfigId?: string;
  readonly reviewerRole?: "primary" | "comparator" | "deterministic";
  readonly reviewMode?: "not-required" | "shadow" | "gating";
  readonly assuranceOutcome?: "PROCEED" | "REPAIR" | "ESCALATE" | "BLOCK";
  readonly shadowWouldBlock?: boolean;
  readonly reviewFindingsUngrounded?: number;
  readonly reviewFindingsBlocking?: number;
  readonly reviewerFailed?: boolean;
  readonly egressStopped?: boolean;
  readonly reviewCostPriced?: boolean;
  readonly repairRound?: boolean;
  readonly repairClosedAllBlocking?: boolean;
  readonly findingId?: string;
  readonly findingValid?: boolean;
  readonly findingDisposition?: "ACCEPTED" | "REJECTED" | "WAIVED";
  readonly dispositionActorKind?: "human" | "harness-rule";
  readonly findingSource?: "model" | "deterministic" | "sarif";
  readonly findingSeverity?: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reviewRoundCompletedAt?: string;
  readonly dispositionLatencyMs?: number;
  readonly assuranceUnavailable?: boolean;
}

export interface SkillManifest {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly signature?: string;
  readonly provenance: {
  readonly source: "internal" | "vendored" | "public";
  readonly upstream?: string | null;
  readonly commit?: string | null;
};
  readonly activation: {
  readonly phases: readonly string[];
  readonly taskTypes: readonly string[];
  readonly requiredRiskCategories?: readonly string[];
  readonly conflictsWith?: readonly string[];
};
  readonly execution: {
  readonly role: "primary" | "adjunct";
  readonly requiredInputs?: readonly string[];
  readonly produces?: readonly string[];
};
  readonly permissions: {
  readonly tools: readonly string[];
  readonly network: "none" | "allowlist" | "full";
  readonly productionAccess: "forbidden" | "human-only" | "allowed";
};
  readonly verification: {
  readonly requiredChecks: readonly string[];
};
  readonly compatibility: {
  readonly harness: string;
  readonly languages?: readonly string[];
};
}

export interface VerificationPlan {
  readonly id: string;
  readonly workOrderId: TaskId;
  readonly risk: RiskLevel;
  readonly requiredLevels: readonly ("L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9")[];
  readonly checks: readonly ({
  readonly id: string;
  readonly level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9";
  readonly category: "workspace" | "static" | "unit" | "integration" | "architecture" | "security" | "acceptance" | "nonfunctional" | "review" | "release";
  readonly mandatory: boolean;
  readonly description?: string;
})[];
}

export interface WorkOrder {
  readonly id: TaskId;
  readonly runId: RunId;
  readonly objective: string;
  readonly requirementIds: readonly string[];
  readonly baseSha: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly architectureInvariants: readonly string[];
  readonly acceptanceCheckIds: readonly string[];
  readonly risk: RiskLevel;
  readonly requiredSkills: readonly SkillRef[];
  readonly budget: Budget;
}
