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

/** The deterministic decision of one assurance round: the outcome, the rule that fired, the blocking set, grounding, closure decisions and the inputs and fence the decision was made from. adjudicationId is the sha256 of the canonical JSON array [roundKey, policyVersion, packetSha256, checkReportSha256, sorted reviewRecordSha256s]. There is no timestamp: the decision time is stored beside the record, never in it. */
export interface AdjudicationRecord {
  readonly adjudicationId: string;
  readonly roundKey: string;
  readonly reviewRoundId: string;
  readonly attemptId: AttemptId;
  readonly round: number;
  readonly mode: "not-required" | "shadow" | "gating";
  readonly outcome: "PROCEED" | "REPAIR" | "ESCALATE" | "BLOCK";
  readonly reason: "packet-over-budget" | "egress-stopped" | "independence-unsatisfiable" | "reviewer-unavailable" | "reviewer-escalated" | "max-repair-rounds" | "budget-exhausted" | "secret-in-diff" | "forbidden-path" | "unscannable-sensitive-change" | null;
  readonly ruleFired: "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9" | "A10" | "A11";
  readonly shadow: {
  readonly wouldBe: "PROCEED" | "REPAIR" | "ESCALATE";
  readonly reason: "packet-over-budget" | "egress-stopped" | "independence-unsatisfiable" | "reviewer-unavailable" | "reviewer-escalated" | "max-repair-rounds" | "budget-exhausted" | "blocking-findings" | null;
  readonly blockingFindings: number;
} | null;
  readonly pushGuard: {
  readonly decision: "PASS" | "BLOCK";
  readonly reason?: "secret-in-diff" | "forbidden-path" | "unscannable-sensitive-change";
};
  readonly egressDecision: "CLEAR" | "STOP_SECRET" | "STOP_CLASSIFIED" | "STOP_UNSCANNABLE";
  readonly blocking: readonly ({
  readonly findingId: string;
  readonly source: "model" | "deterministic" | "sarif";
  readonly raisedBy: string;
  readonly severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reason: "deterministic-rule" | "grounded-model-finding" | "prior-finding";
})[];
  readonly grounding: readonly ({
  readonly findingId: string;
  readonly grounded: boolean;
  readonly reason: "evidence-too-short" | "required-fix-too-short" | "citation-not-in-packet" | "citation-missing" | "lines-without-file" | "path-not-normalized" | "path-not-in-packet" | "line-range-invalid" | "lines-outside-file" | "content-not-in-packet" | "not-a-resolution" | null;
})[];
  readonly verdictMismatches: readonly ({
  readonly reviewId: string;
  readonly verdict: "APPROVE" | "REQUEST_CHANGES";
  readonly groundedBlockingCount: number;
})[];
  readonly closureDecisions: readonly ({
  readonly priorFindingId: string;
  readonly raisedBy: string;
  readonly claims: readonly ({
    readonly by: string;
    readonly status: "RESOLVED" | "PARTIAL" | "OPEN";
  })[];
  readonly effectiveState: "OPEN" | "ACKNOWLEDGED" | "FIXED" | "VERIFIED" | "CLOSED" | "REFUTED" | "ADJUDICATED" | "WAIVED";
  readonly rule: "deterministic-recheck" | "human" | "independent-reviewer" | "raiser-claim" | "closure-without-change" | "regression" | "unchanged";
})[];
  readonly policyVersion: string;
  readonly inputs: {
  readonly packetSha256: string;
  readonly checkReportSha256: string;
  readonly reviewRecordSha256s: readonly string[];
};
  readonly fence: {
  readonly leaseId: string;
  readonly fencingEpoch: number;
};
}

export interface ArchitectureInvariant {
  readonly id: string;
  readonly statement: string;
  readonly category: "DEPENDENCY" | "LAYERING" | "SECURITY" | "DATA" | "NAMING" | "OTHER";
  readonly rationale?: string;
  readonly check?: {
  readonly kind: "forbidden-import";
  readonly fromGlobs: readonly string[];
  readonly specifierPattern: string;
};
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

/** What the next attempt is told after a gating REPAIR decision: the grounded blocking findings and a capped set of informational findings, anchored to the reviewed attempt's commit. The size limits on finding text are policy data, applied when the order is built. */
export interface RepairOrder {
  readonly repairOrderId: string;
  readonly taskId: TaskId;
  readonly fromAttemptId: AttemptId;
  readonly nextRound: number;
  readonly taskBaseSha: string;
  readonly repairBaseSha: string;
  readonly adjudicationId: string;
  readonly blockingFindings: readonly ReviewFindingRecord[];
  readonly informationalFindings: readonly ReviewFindingRecord[];
  readonly closureRule: "a fix is verified only by a different eligible reviewer, a human, or a deterministic re-check";
  readonly workOrderRef: ArtifactRef;
}

export interface Requirement {
  readonly id: string;
  readonly statement: string;
  readonly rationale?: string;
  readonly priority: "MUST" | "SHOULD" | "COULD";
}

/** A finding as the harness records it: raised by a model reviewer, a deterministic rule or a SARIF log, fingerprinted, grounded by the harness (never by a model) and carried through its lifecycle. A SARIF log is not parsed: it yields exactly one sarif-unparsed finding. */
export interface ReviewFindingRecord {
  readonly id: string;
  readonly source: "model" | "deterministic" | "sarif";
  readonly raisedBy: string;
  readonly fingerprint: string;
  readonly severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly category: "SPEC" | "ARCHITECTURE" | "CORRECTNESS" | "SECURITY" | "PERFORMANCE" | "TEST_QUALITY" | "MAINTAINABILITY" | "EVIDENCE_INTEGRITY";
  readonly evidence: string;
  readonly requiredFix: string;
  readonly grounded: boolean;
  readonly groundingReason?: string;
  readonly lifecycleState: "OPEN" | "ACKNOWLEDGED" | "FIXED" | "VERIFIED" | "CLOSED" | "REFUTED" | "ADJUDICATED" | "WAIVED";
  readonly requirementId?: string;
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly ruleId?: string;
  readonly priorFindingId?: string;
}

/** The only input a reviewer receives: the work order, the change as the harness committed it, the recorded execution and, on a re-review, the adjudicated prior findings. Built from trusted sources only. There is no field for the coder's self-report, a context pack, events, commit messages or another reviewer's output. The packet does not carry its own measured size. */
export interface ReviewPacket {
  readonly packetVersion: "review-packet/v1";
  readonly identity: {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly round: number;
  readonly roundKey: string;
};
  readonly risk: RiskLevel;
  readonly reviewKind: "fresh" | "re-review";
  readonly workOrder: {
  readonly objective: string;
  readonly requirementIds: readonly string[];
  readonly requirements?: readonly {
    readonly id: string;
    readonly statement: string;
    readonly priority: string;
  }[];
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
  readonly files: readonly ({
    readonly path: string;
    readonly status: "A" | "M" | "D" | "R";
    readonly binary: boolean;
    readonly postImage: ArtifactRef | null;
    readonly lineCount: number;
    readonly omittedReason: "binary" | "too-large" | "deleted" | "submodule" | "non-utf8" | "unsafe-path" | null;
  })[];
};
  readonly execution: {
  readonly verdict: "PASS" | "FAIL" | "ERROR" | "NOT_RECORDED";
  readonly environment: {
    readonly imageDigest: string;
    readonly lockfileHash: string;
    readonly nodeVersion: string | null;
  } | null;
  readonly checks: readonly ({
    readonly id: string;
    readonly category: "workspace" | "static" | "unit" | "integration" | "architecture" | "security" | "acceptance" | "nonfunctional" | "review" | "release";
    readonly command: string;
    readonly exitCode: number;
    readonly durationMs: number;
    readonly stdout: {
      readonly artifactId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly excerptTail: string | null;
    } | null;
    readonly stderr: {
      readonly artifactId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly excerptTail: string | null;
    } | null;
    readonly testSummary: {
      readonly runner: "node:test" | "tap" | "vitest" | "jest";
      readonly tests: number;
      readonly pass: number;
      readonly fail: number;
      readonly skipped: number;
      readonly todo: number;
    } | null;
  })[];
};
  readonly priorFindings: readonly ReviewFindingRecord[];
  readonly budget: {
  readonly maxBytes: number;
  readonly overBudget: boolean;
  readonly omissions: readonly ({
    readonly path: string;
    readonly reason: "binary" | "too-large" | "deleted" | "submodule" | "non-utf8" | "unsafe-path";
  })[];
};
}

/** The harness's record of one completed reviewer call, produced from validated model output only: who reviewed which packet with which prompt, what the provider served, what the model concluded and what the call cost. It never carries the coder's self-report or another reviewer's output. */
export interface ReviewRecord {
  readonly reviewId: string;
  readonly roundKey: string;
  readonly attemptId: AttemptId;
  readonly round: number;
  readonly reviewKind: "fresh" | "re-review";
  readonly reviewerConfigId: string;
  readonly reviewerConfigSha256: string;
  readonly reviewerRole: "primary" | "comparator";
  readonly requestedModel: string;
  readonly resolvedFamily: string;
  readonly servedModel: string;
  readonly packetSha256: string;
  readonly promptSha256: string;
  readonly rawRequestArtifactId: string;
  readonly rawResponseArtifactId: string;
  readonly validity: "VALID" | "INVALID";
  readonly verdict: "APPROVE" | "REQUEST_CHANGES" | "ESCALATE" | null;
  readonly findings: readonly ReviewFindingRecord[];
  readonly priorFindingClaims: readonly ({
  readonly priorFindingId: string;
  readonly status: "RESOLVED" | "PARTIAL" | "OPEN";
  readonly evidence: string;
  readonly resolutionFile: string | null;
  readonly resolutionLine: number | null;
})[];
  readonly usage: {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly wallClockMs: number;
  readonly transportAttempts: number;
};
  readonly providerCalls: number;
  readonly gatewayAlteration: {
  readonly status: "altered" | "unaltered" | "unknown";
  readonly appendedBytes: number | null;
  readonly appendedSha256: string | null;
  readonly appendixArtifactId: string | null;
  readonly toolsAttributed: boolean | null;
  readonly attributedFields: readonly string[];
};
  readonly confidence?: number;
  readonly packetCoverage?: "complete" | "partial";
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
