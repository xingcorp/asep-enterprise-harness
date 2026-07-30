import type {
  AgentAttemptResult, ContextPack, ReviewReport, WorkOrder,
  VerificationResult, VerificationPlan, EvidenceBundle,
  ArtifactId, ArtifactRef, AttemptId, TaskId, RiskLevel,
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
  // HIGH-007: the pinned base SHA the worktree was created at, and whether HEAD
  // moved away from it. A detached-HEAD commit advances HEAD WITHOUT creating a
  // ref, so createdRefs stays empty; comparing headSha against the snapshotted
  // base is the only trusted signal that the agent committed. The harness owns
  // commit identity, so ANY HEAD movement observed at inspection (before the
  // harness's own commit step) is an overstep.
  readonly baseSha: string;
  readonly headMovedFromBase: boolean;
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
  // Crash-recovery reconciliation for the commit side effect (disp.
  // P2-FINAL-HIGH-006, exit C7). A commit is NOT idempotent: re-running commit()
  // would mint a second, divergent object. So when a resume finds a PENDING
  // commit record, the caller must first ask whether the harness ALREADY
  // committed for this attempt. This inspects the workspace HEAD and returns the
  // recorded commit SHA + the evidence id carried in its `ASEP-Evidence` trailer
  // IFF HEAD is a harness commit whose `ASEP-Attempt` trailer matches; otherwise
  // null (the commit never landed, so it is safe to perform). Reading trailers
  // off the real object is the natural-key reconciliation the two-phase protocol
  // requires for the one effect that cannot be replayed.
  reconcile(scope: TenantScope, input: {
    workspace: WorkspaceCapability;
    attemptId: string;
    baseSha: string;
  }): Promise<{ commitSha: string; evidenceId: string } | null>;
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
  // Does the OS/container ACTUALLY enforce this profile's isolation (disp.
  // P2-FINAL-HIGH-002, exit E8/F6)? Declared on the PORT — not only on the
  // Docker adapter's handle — so a use case can fail closed when isolation is
  // mandatory without importing an adapter type (exit B3). Optional for
  // backwards compatibility, and every consumer must treat an absent value as
  // NOT enforced: unknown isolation is never a permission.
  readonly isolationEnforced?: boolean;
}

export interface WorkspaceMount {
  readonly workspaceId: WorkspaceId;
  readonly readOnlyPaths: readonly string[];
  readonly writablePaths: readonly string[];
  // Paths that must be read-only EVEN THOUGH they are nested inside a writable
  // path (disp. P2-FINAL-HIGH-002). A linked worktree carries its `.git`
  // indirection INSIDE the working tree, so mounting the tree `rw` also made
  // `.git` writable through the parent mount: an agent could rewrite the gitdir
  // pointer from inside the sandbox. Listing it here makes the sandbox layer a
  // nested read-only bind over the writable parent, so the write fails at the
  // OS level rather than being merely discouraged.
  readonly readOnlyOverlayPaths?: readonly string[];
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
// EvidenceStore — preallocated-id evidence persistence (disp. P2-PLAN-HIGH-008,
// exit D8). The canonical EvidenceBundle.resultSha must equal the FINAL harness
// commit SHA, but a content-addressed id would depend on the bundle bytes which
// depend on the commit SHA — a cycle. We break it by PREALLOCATING a
// non-content-derived id BEFORE the commit: the commit embeds that id in its
// `ASEP-Evidence` trailer, then the serialized bundle (carrying the resulting
// commit SHA) is stored at the preallocated id AFTER commit but BEFORE push.
// putEvidence is idempotent: re-storing identical bytes at the same id is a
// no-op success (crash between commit and evidence persistence recovers without
// a second commit); storing DIFFERENT bytes at an existing id fails closed.
// ---------------------------------------------------------------------------

export interface EvidenceStore {
  allocateEvidenceId(): ArtifactId;
  putEvidence(scope: TenantScope, id: ArtifactId, bundle: EvidenceBundle): Promise<ArtifactRef>;
  getEvidence(scope: TenantScope, id: ArtifactId): Promise<EvidenceBundle>;
}

// ---------------------------------------------------------------------------
// SideEffectLog — two-phase crash-safe side-effect protocol (disp.
// P2-PLAN-HIGH-005, exit C7). Each external effect (commit, exact-ref push, PR
// upsert) is wrapped by a tenant-scoped record keyed by a semantic key
// (repositoryBindingId:attemptId:operation) with a request fingerprint, a
// PENDING/COMPLETED/FAILED state, an owner/fencing token (the lease id) and a
// remote natural key for reconciliation. Protocol per effect: begin(PENDING) →
// perform external call → complete(COMPLETED). On restart a PENDING row is
// reconciled by natural key against the remote before retry-vs-adopt. Reusing a
// key with a DIFFERENT fingerprint fails closed; a stale owner token cannot
// complete another executor's operation (fencing).
// ---------------------------------------------------------------------------

export type SideEffectOperation = 'commit' | 'push' | 'pr-upsert';
export type SideEffectState = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface SideEffectRecord {
  readonly operation: SideEffectOperation;
  readonly state: SideEffectState;
  readonly requestFingerprint: string;
  readonly ownerToken?: string;
  readonly naturalKey?: string;
  readonly resultRef?: unknown;
  // True when begin() found an existing record for this key (the caller must
  // reconcile a PENDING/COMPLETED row rather than perform the effect again).
  readonly existed: boolean;
}

export interface SideEffectBeginInput {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly requestFingerprint: string;
  readonly ownerToken: string;
  readonly naturalKey?: string;
}

export interface SideEffectCompleteInput {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly ownerToken: string;
  readonly resultRef?: unknown;
  readonly naturalKey?: string;
}

export class SideEffectFingerprintError extends Error {}
export class SideEffectFencingError extends Error {}

export interface SideEffectLog {
  begin(scope: TenantScope, input: SideEffectBeginInput): Promise<SideEffectRecord>;
  complete(scope: TenantScope, input: SideEffectCompleteInput): Promise<SideEffectRecord>;
  fail(scope: TenantScope, input: { operation: SideEffectOperation; repositoryBindingId: RepositoryBindingId; attemptId: AttemptId; ownerToken: string }): Promise<SideEffectRecord>;
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
