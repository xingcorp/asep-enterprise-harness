import type {
  AgentAttemptResult, ContextPack, ReviewReport, WorkOrder,
  VerificationResult, ArtifactId, AttemptId, RiskLevel
} from '@asep/contracts';

export interface CodingAgentProvider {
  readonly providerId: string;
  execute(order: WorkOrder, context: ContextPack): Promise<AgentAttemptResult>;
  cancel(attemptId: AttemptId): Promise<void>;
}

export interface ReviewProvider {
  readonly providerId: string;
  review(input: {
    order: WorkOrder;
    context: ContextPack;
    diffArtifactId: ArtifactId;
    verification: VerificationResult;
    implementerProviderId: string;
  }): Promise<ReviewReport>;
}

export interface WorkflowEngine {
  startRun(input: { projectId: string; productSpecId: string; risk: RiskLevel }): Promise<string>;
  signal(runId: string, signal: unknown): Promise<void>;
  query(runId: string): Promise<unknown>;
  cancel(runId: string): Promise<void>;
}

export interface ArtifactStore {
  put(input: { kind: string; content: Uint8Array; sha256: string; metadata: Record<string,string> }): Promise<ArtifactId>;
  get(id: ArtifactId): Promise<Uint8Array>;
}

export interface MemoryProvider {
  search(input: { tenantId: string; projectId: string; query: string; limit: number }): Promise<readonly MemoryCandidate[]>;
  append(input: MemoryRecordInput): Promise<string>;
  expire(id: string): Promise<void>;
}

export interface MemoryCandidate {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly provenanceArtifactIds: readonly ArtifactId[];
  readonly humanVerified: boolean;
}

export interface MemoryRecordInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly classification: 'EPISODIC'|'PREFERENCE'|'FAILURE_PATTERN';
  readonly text: string;
  readonly provenanceArtifactIds: readonly ArtifactId[];
  readonly expiresAt?: string;
}

export interface OutputReducer {
  readonly reducerId: string;
  reduce(input: { command: string; exitCode: number; stdout: string; stderr: string }): Promise<{ summary: string; rawRequired: boolean }>;
}
