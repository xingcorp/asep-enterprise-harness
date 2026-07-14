export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ProjectId = Brand<string, 'ProjectId'>;
export type RunId = Brand<string, 'RunId'>;
export type MilestoneId = Brand<string, 'MilestoneId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';
export type RunStatus =
  | 'DRAFT' | 'DISCOVERY' | 'SPECIFICATION_REVIEW' | 'ARCHITECTURE_REVIEW'
  | 'PLANNING' | 'READY' | 'EXECUTING' | 'VERIFYING' | 'INDEPENDENT_REVIEW'
  | 'REPAIRING' | 'INTEGRATING' | 'PRODUCT_ACCEPTANCE' | 'RELEASE_REHEARSAL'
  | 'WAITING_FOR_APPROVAL' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'DONE';

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
  readonly priority: 'MUST' | 'SHOULD' | 'COULD';
}

export interface AcceptanceScenario {
  readonly id: string;
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
  readonly automated: boolean;
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

export interface SkillRef { readonly id: string; readonly version: string; }
export interface Budget {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxCostUsd: number;
  readonly maxWallClockMinutes: number;
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

export interface ReviewReport {
  readonly reviewerProvider: string;
  readonly reviewerModel: string;
  readonly verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE';
  readonly findings: readonly ReviewFinding[];
  readonly confidence: number;
}

export interface ReviewFinding {
  readonly id: string;
  readonly severity: 'INFO'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';
  readonly category: 'SPEC'|'ARCHITECTURE'|'CORRECTNESS'|'SECURITY'|'PERFORMANCE'|'TEST_QUALITY'|'MAINTAINABILITY';
  readonly requirementId?: string;
  readonly file?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly evidence: string;
  readonly requiredFix: string;
}
