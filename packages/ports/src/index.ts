import type {
  AgentAttemptResult, ContextPack, ReviewReport, WorkOrder,
  VerificationResult, ArtifactId, ArtifactRef, AttemptId, RiskLevel,
  RepositoryBindingId, WorkspaceId, TenantScope, Budget, Usage,
} from '@asep/contracts';

// ---------------------------------------------------------------------------
// CodingAgentProvider v2 (REDESIGNED — disp. P2-PLAN-HIGH-002).
//
// The Phase-1 shape `execute(order, context): AgentAttemptResult` is unsafe for
// Phase 2: it let an untrusted provider return `attemptId`/`resultSha`/
// `changedFiles`, which are HARNESS-OWNED facts. The v2 contract:
//   - the REQUEST carries harness-owned identity (pre-created attemptId), an
//     immutable + hashed WorkOrder/ContextPack reference, an opaque workspace
//     capability (no raw path), a budget, a tool policy and a request-scoped
//     AbortSignal for cancellation;
//   - the RESULT is an UNTRUSTED self-report only: status/summary/limitations/
//     usage/session id + references to event artifacts. It carries NO attemptId,
//     NO resultSha and NO changedFiles — those are derived by the trusted
//     GitChangeInspector/GitCommitter AFTER the agent exits.
// ---------------------------------------------------------------------------

// Opaque handle to a leased workspace. The agent never sees a raw filesystem
// path; the adapter resolves the capability to a sandbox mount internally.
export interface WorkspaceCapability {
  readonly workspaceId: WorkspaceId;
  readonly leaseId: string;
}

// Allowed/disallowed tools + network egress profile handed to the provider.
// No "dangerous permission bypass" is representable.
export interface ToolPolicyProfile {
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly networkProfile: 'no-network' | 'restricted-egress';
}

export interface AgentExecuteRequest {
  readonly attemptId: AttemptId;             // harness-owned, pre-created
  readonly workOrderRef: ArtifactRef;        // immutable + hash
  readonly contextPackRef: ArtifactRef;      // immutable + hash
  readonly workspace: WorkspaceCapability;   // opaque handle; no raw path
  readonly budget: Budget;
  readonly toolPolicy: ToolPolicyProfile;    // allowed/disallowed tools + net
  readonly signal: AbortSignal;              // request-scoped cancellation
}

// UNTRUSTED provider self-report. No attemptId/resultSha/changedFiles.
export interface AgentAttemptObservation {
  readonly status: 'AGENT_DONE' | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED';
  readonly summary: string;
  readonly knownLimitations: readonly string[];
  readonly providerSessionId?: string;
  readonly usage: Usage;
  readonly eventArtifactRefs: readonly ArtifactRef[];
}

export interface CodingAgentProvider {
  readonly providerId: string;
  execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation>;
}

// ---------------------------------------------------------------------------
// Review (unchanged from Phase 1).
// ---------------------------------------------------------------------------

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

// The future dispatch seam (Phase 3 Temporal). Phase 2 dispatches via CLI/worker
// without a durable engine; this interface is the seam, not a dependency.
export interface WorkflowEngine {
  startRun(input: { projectId: string; productSpecId: string; risk: RiskLevel }): Promise<string>;
  signal(runId: string, signal: unknown): Promise<void>;
  query(runId: string): Promise<unknown>;
  cancel(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ArtifactStore v2 (scope-aware + content-addressed + verify — disp.
// P2-PLAN-HIGH-004). Every op takes a TenantScope: project A can never read,
// verify, infer existence of, or attach project B's object. put() is a
// conditional create-only write (see adapters); get()/verify() re-hash and fail
// closed on mismatch.
// ---------------------------------------------------------------------------

export interface ArtifactPutInput {
  readonly kind: string;
  readonly content: Uint8Array;
  readonly sha256: string;                 // expected checksum, verified on write
  readonly contentType: string;
  readonly attemptId?: AttemptId;          // scoped link when produced by an attempt
}

export interface ArtifactStream {
  readonly ref: ArtifactRef;
  readonly content: Uint8Array;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface ArtifactVerification {
  readonly ref: ArtifactRef;
  readonly ok: boolean;                    // false => checksum/size mismatch (fail closed)
  readonly actualSha256: string;
  readonly sizeBytes: number;
}

export interface ArtifactStore {
  put(scope: TenantScope, input: ArtifactPutInput): Promise<ArtifactRef>;
  get(scope: TenantScope, ref: ArtifactRef): Promise<ArtifactStream>;
  verify(scope: TenantScope, ref: ArtifactRef): Promise<ArtifactVerification>;
}

// ---------------------------------------------------------------------------
// Workspace lease + manager + Git inspection/commit (design intent; concrete
// signatures decided in S4). Declared here so the application layer composes
// against ports, never adapters.
// ---------------------------------------------------------------------------

export interface Lease {
  readonly leaseId: string;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly branch: string;
  readonly attemptId: AttemptId;
  readonly expiresAt: string;
}

export interface LeaseDenied {
  readonly denied: true;
  readonly reason: string;
}

export interface WorkspaceLeaseRepository {
  acquire(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    attemptId: AttemptId;
    ttlMs: number;
  }): Promise<Lease | LeaseDenied>;
  heartbeat(scope: TenantScope, leaseId: string): Promise<void>;
  release(scope: TenantScope, leaseId: string): Promise<void>;
}

export interface Workspace {
  readonly workspaceId: WorkspaceId;
  readonly capability: WorkspaceCapability;
  readonly baseSha: string;
}

export interface WorkspaceManager {
  create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    baseSha: string;
    leaseId: string;
  }): Promise<Workspace>;
  cleanup(scope: TenantScope, workspaceId: WorkspaceId): Promise<void>;
  quarantine(scope: TenantScope, workspaceId: WorkspaceId, reason: string): Promise<void>;
}

// Trusted observation of workspace Git state AFTER the agent exits. The agent
// never reports these facts; the harness derives them (disp. P2-PLAN-HIGH-002).
export interface GitChangeObservation {
  readonly headSha: string;
  readonly changedFiles: readonly string[];
  readonly createdRefs: readonly string[];
  readonly touchedGitDir: boolean;
  readonly diff: ArtifactRef;
}

export interface GitChangeInspector {
  inspect(scope: TenantScope, workspace: WorkspaceCapability): Promise<GitChangeObservation>;
}

export interface GitCommitter {
  commit(scope: TenantScope, input: {
    workspace: WorkspaceCapability;
    allowedPaths: readonly string[];
    trailers: Record<string, string>;
    identity: { name: string; email: string };
  }): Promise<{ commitSha: string }>;
}

// ---------------------------------------------------------------------------
// Command runner + sandbox (design intent; concrete impl in S5). shell:false,
// exact exit/signal, raw output streamed to immutable artifacts.
// ---------------------------------------------------------------------------

export interface OutputPolicy {
  readonly maxEvidenceBytes: number;
  readonly displayHeadBytes: number;
  readonly displayTailBytes: number;
}

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;                    // workspace-relative, containment-checked
  readonly environmentProfile: string;
  readonly timeoutMs: number;
  readonly outputPolicy: OutputPolicy;
}

export interface CommandResult {
  readonly exitCode: number | null;        // exact; never coerced
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: ArtifactRef;            // full raw bytes, immutable artifact
  readonly stderr: ArtifactRef;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly profile: string;
}

export interface WorkspaceMount {
  readonly workspaceId: WorkspaceId;
  readonly readOnlyPaths: readonly string[];
  readonly writablePaths: readonly string[];
}

export interface SandboxProvider {
  start(
    profile: 'verification-no-network' | 'agent-restricted-egress',
    mount: WorkspaceMount,
  ): Promise<SandboxHandle>;
  stop(handle: SandboxHandle): Promise<void>;
}

export interface CommandRunner {
  run(spec: CommandSpec, sandbox: SandboxHandle): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Forge (design intent; concrete impl in S7). Refspec safety is non-bypassable
// and lives INSIDE pushBranch (disp. P2-PLAN-CRIT-001). No merge method.
// ---------------------------------------------------------------------------

export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface ForgeProvider {
  pushBranch(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha?: string;
  }): Promise<void>;
  upsertPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;
}

// ---------------------------------------------------------------------------
// Memory + output reducer (unchanged from Phase 1).
// ---------------------------------------------------------------------------

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

// The legacy AgentAttemptResult is retained in @asep/contracts for the mock and
// any Phase-1 consumers, but is NOT part of the v2 CodingAgentProvider surface.
export type { AgentAttemptResult };
