import type {
  AgentAttemptResult, ContextPack, ReviewReport, WorkOrder,
  VerificationResult, VerificationPlan, EvidenceBundle,
  ArtifactId, ArtifactRef, AttemptId, TaskId,
  RepositoryBindingId, WorkspaceId, TenantScope, Budget, Usage,
  RunEvent, RunId, TaskWorkflowInput, RunWorkflowInput, WorkflowControlMessage,
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

// ---------------------------------------------------------------------------
// WorkflowEngine: the durable-engine seam the API and the CLI dispatch
// through. Only the Temporal adapter implements it. Inputs and control messages
// are the canonical workflow contracts, which carry no free text.
// ---------------------------------------------------------------------------

export type ApprovalKind = 'budget-extension' | 'publish-change';

export type TaskWorkflowPhase =
  | 'ADMITTING' | 'BUDGET_CHECK' | 'ATTEMPT_STARTING' | 'AGENT_RUNNING' | 'INSPECTING' | 'VERIFYING'
  | 'COMMITTING' | 'EVIDENCE' | 'ASSURANCE_ROUND' | 'PUBLICATION_GATE' | 'AWAITING_APPROVAL' | 'PUBLISHING'
  | 'REVIEW_HANDOFF' | 'ATTEMPT_ABANDONED' | 'ATTEMPT_EXHAUSTED' | 'PAUSED' | 'CANCELLING' | 'CLEANUP' | 'CLOSED';

export interface WorkflowStartReceipt {
  readonly workflowId: string;
  readonly alreadyStarted: boolean;
}

export interface WorkflowControlReceipt {
  readonly accepted: boolean;
  readonly reason?: 'already-paused' | 'not-paused' | 'closed' | 'unknown-approval'
    | 'decision-conflict' | 'approval-expired' | 'duplicate' | 'already-sealed' | 'run-sealed';
}

export interface TaskWorkflowView {
  readonly workflowId: string;
  readonly phase: TaskWorkflowPhase;
  readonly paused: boolean;
  readonly closed: boolean;
  readonly attemptNumber: number;
  readonly assuranceRound: number;
  readonly pendingApproval: {
    readonly approvalRequestId: string;
    readonly kind: ApprovalKind;
    readonly expiresAt: string;
  } | null;
  readonly spentUsd: number;
  readonly capUsd: number;
}

export interface WorkflowEngine {
  /** Idempotent by runId (workflow id asep-run-<runId>, conflict policy USE_EXISTING). */
  startRun(scope: TenantScope, input: RunWorkflowInput): Promise<WorkflowStartReceipt>;
  /** Idempotent by taskId (update id submit-<taskId>); starts the run workflow if needed. */
  submitTask(scope: TenantScope, input: {
    readonly runId: RunId;
    readonly task: TaskWorkflowInput;
    readonly requestId: string;
  }): Promise<WorkflowStartReceipt>;
  /** pause | resume | seal (run only) | approval-decision; the update id is message.requestId. */
  control(scope: TenantScope, message: WorkflowControlMessage): Promise<WorkflowControlReceipt>;
  /** Durable cancellation of a task or run workflow; idempotent. No free text crosses into history. */
  cancel(scope: TenantScope, input: {
    readonly target: { readonly scope: 'task' | 'run'; readonly id: string };
    readonly requestId: string;
    readonly principalId: string;
  }): Promise<WorkflowControlReceipt>;
  describeTask(scope: TenantScope, taskId: TaskId): Promise<TaskWorkflowView | null>;
  isClosed(scope: TenantScope, workflowId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Activity execution context: the engine-neutral view of one activity delivery.
// Application activities depend on it, never on a durable-engine SDK; only the
// engine's activity bridge knows how it maps to the engine.
// ---------------------------------------------------------------------------

export interface ActivityProgress {
  readonly stage: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface ActivityExecutionContext {
  /** 1-based count of deliveries of this activity execution by the engine. */
  readonly engineAttempt: number;
  /** Aborted on engine cancellation, heartbeat timeout or worker shutdown. */
  readonly signal: AbortSignal;
  /** Last progress recorded by a previous delivery, or null. Non-authoritative. */
  readonly lastProgress: ActivityProgress | null;
  /** Workflow time at scheduling (ISO-8601). Identical on every redelivery of this execution. */
  readonly logicalNow: string;
  /** Liveness and checkpoint. Must not carry secrets, source or prompts. */
  heartbeat(progress: ActivityProgress): void;
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

// A workspace lease is the one-active-writer right over (binding, branch), and
// the FENCING TOKEN every durable side effect is recorded under.
//
// `fencingEpoch` is strictly monotonic per (binding, branch): each granted lease
// gets the previous highest epoch + 1, and the database refuses a duplicate. A
// lease that is no longer ACTIVE can never become ACTIVE again. So "the newer
// writer" is a total order the database maintains, not something an executor
// claims about itself — which is what lets a side-effect record move from a
// crashed owner to its successor and then refuse the crashed owner forever.
export interface Lease {
  readonly leaseId: string;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly branch: string;
  readonly attemptId: AttemptId;
  readonly expiresAt: string;
  readonly fencingEpoch: number;
}

export interface LeaseDenied {
  readonly denied: true;
  readonly reason: string;
}

/**
 * The caller no longer holds a live lease: it was released, swept to EXPIRED,
 * quarantined, or its `expires_at` passed without a heartbeat. A holder that
 * sees this has been (or may at any moment be) superseded and must stop before
 * its next side effect.
 */
export class LeaseLostError extends Error {
  constructor(readonly leaseId: string) {
    super(`workspace lease ${leaseId} is no longer live — the holder must stop (fencing, fail closed)`);
    this.name = 'LeaseLostError';
  }
}

export interface WorkspaceLeaseRepository {
  acquire(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    attemptId: AttemptId;
    ttlMs: number;
  }): Promise<Lease | LeaseDenied>;
  // Extends a LIVE lease by its TTL. Throws LeaseLostError when the lease is no
  // longer live, so a heartbeat doubles as the fence a holder checks before each
  // side effect.
  heartbeat(scope: TenantScope, leaseId: string): Promise<void>;
  release(scope: TenantScope, leaseId: string): Promise<void>;
}

export interface Workspace {
  readonly workspaceId: WorkspaceId;
  readonly capability: WorkspaceCapability;
  readonly baseSha: string;
}

// The durable workspace registry: which worktree serves which attempt, on which
// host, so a restarted worker rehydrates or refuses a workspace instead of
// guessing from the filesystem.
export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly leaseId: string;
  readonly hostId: string;
  /** Validated path segments relative to the workspace root; never absolute. */
  readonly pathRel: string;
  /** The task base, or the repair base for a repair attempt. */
  readonly baseSha: string;
  readonly baselineRefs: readonly string[];
  readonly state: 'CREATING' | 'ACTIVE' | 'CLEANED' | 'QUARANTINED';
}

export interface WorkspaceRegistry {
  /** Idempotent by attemptId. */
  begin(scope: TenantScope, rec: Omit<WorkspaceRecord, 'state' | 'baselineRefs'>): Promise<WorkspaceRecord>;
  activate(scope: TenantScope, input: {
    readonly workspaceId: WorkspaceId;
    readonly baselineRefs: readonly string[];
  }): Promise<WorkspaceRecord>;
  findByAttempt(scope: TenantScope, attemptId: AttemptId): Promise<WorkspaceRecord | null>;
  findById(scope: TenantScope, workspaceId: WorkspaceId): Promise<WorkspaceRecord | null>;
  markState(scope: TenantScope, input: {
    readonly workspaceId: WorkspaceId;
    readonly state: 'CLEANED' | 'QUARANTINED';
    readonly reason: string;
  }): Promise<void>;
}

/**
 * The workspace cannot be used from this worker: it lives on another host, it is
 * missing, or it is quarantined. Not retryable: another delivery on this worker
 * finds the same.
 */
export class WorkspaceUnavailableError extends Error {
  constructor(readonly reason: 'other-host' | 'missing' | 'quarantined', detail: string) {
    super(`workspace unavailable (${reason}): ${detail}`);
    this.name = 'WorkspaceUnavailableError';
  }
}

export interface WorkspaceManager {
  // Create-or-adopt, keyed by the attempt: a redelivery for the same attempt
  // finds its workspace rather than making a second one. `baseSha` is the task
  // base, or the repair base for a repair attempt; a base commit that does not
  // exist is not retryable.
  create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    baseSha: string;
    leaseId: string;
    attemptId: AttemptId;
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
  // The attempt's one harness commit. It is recorded, create-only, under a ref
  // keyed by the attempt in the repository the workspaces share, BEFORE the
  // workspace HEAD moves: so an attempt can never get a second, divergent
  // commit, and the commit stays discoverable without the workspace that made
  // it (a crashed executor's worktree is never reused).
  commit(scope: TenantScope, input: {
    workspace: WorkspaceCapability;
    attemptId: string;
    baseSha: string;
    allowedPaths: readonly string[];
    trailers: Record<string, string>;
    identity: { name: string; email: string };
  }): Promise<{ commitSha: string }>;
  // Crash-recovery reconciliation for the commit side effect (exit C7/D8). A
  // commit is NOT idempotent: re-running commit() would mint a second,
  // divergent object. So when a resume finds a PENDING commit record, the
  // caller first asks whether the harness ALREADY committed for this attempt.
  // Returns the attempt's recorded commit SHA + the evidence id carried in its
  // `ASEP-Evidence` trailer, or null when the attempt has no commit (it never
  // landed, so it is safe to perform). A recorded commit that is not this
  // attempt's harness commit on `baseSha` throws: it is never adopted, and never
  // a reason to commit again. Needs no workspace, so a successor that never
  // held the dead executor's worktree can reconcile.
  reconcile(scope: TenantScope, input: {
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

// Where a command actually ran, as the runner that ran it knows it: in a
// container of this image with these run flags, or on the host. Verification
// evidence records it, so a reader can check the checks ran in the pinned,
// isolated sandbox rather than take that on trust.
export type CommandProvenance =
  | {
    readonly where: 'container';
    readonly image: string;
    readonly container: string;
    readonly runFlags: readonly string[];
  }
  | { readonly where: 'host' };

export interface CommandResult {
  readonly exitCode: number | null;        // exact; never coerced
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: ArtifactRef;            // full raw bytes, immutable artifact
  readonly stderr: ArtifactRef;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  // Absent when the runner cannot say; a reader treats that as unknown, never
  // as sandboxed.
  readonly provenance?: CommandProvenance;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly profile: string;
  // Does the OS/container ACTUALLY enforce this profile's isolation (disp.
  // P2-FINAL-HIGH-002, exit E8/F6)? Declared on the PORT — not only on the
  // Docker adapter's handle — so a use case can fail closed when isolation is
  // mandatory without importing an adapter type (exit B3). Optional for
  // backwards compatibility, and every consumer must treat an absent value as
  // NOT enforced: unknown isolation is never a permission. It is a claim, not a
  // capability: `true` is necessary, never sufficient. Whoever executes
  // commands decides where from its own record of the handle, not from this.
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
  // The attempt the mount serves. A sandbox labels what it starts with it, so
  // every container of an attempt can be found, and removed, by one identity.
  readonly attemptId?: AttemptId;
}

export interface SandboxProvider {
  start(
    profile: 'verification-no-network' | 'agent-restricted-egress',
    mount: WorkspaceMount,
  ): Promise<SandboxHandle>;
  stop(handle: SandboxHandle): Promise<void>;
}

export interface CommandRunOptions {
  /** Aborts this run: the process group is killed and the result reports cancellation. */
  readonly signal?: AbortSignal;
}

export interface CommandRunner {
  run(spec: CommandSpec, sandbox: SandboxHandle, options?: CommandRunOptions): Promise<CommandResult>;
}

// Removes what an attempt left running. Containers are found by the attempt
// label every agent, egress-proxy and verification container carries
// (asep.attempt=<attemptId>, with asep.role), never by name: names carry a
// random suffix.
export interface ExecutionReaper {
  /** Force-removes every container labelled with the attempt (optionally one role). Idempotent. */
  reap(scope: TenantScope, input: {
    readonly attemptId: AttemptId;
    readonly role?: 'agent' | 'verify';
  }): Promise<{ readonly removed: number }>;
}

// Verification commands by approved id. A callback cannot cross the workflow
// boundary and a command string must not enter workflow history, so the
// workflow carries check ids and a trusted, config-sourced catalog resolves
// them inside the activity.
export interface VerificationCommandCatalog {
  /**
   * The trusted command an approved id stands for, for a binding. An unknown id
   * or binding throws UnknownVerificationCommandError. Never accepts a command
   * string.
   */
  resolve(scope: TenantScope, input: {
    readonly repositoryBindingId: RepositoryBindingId;
    readonly commandId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<CommandSpec>;
}

/** The catalog has no such command for the binding. Not retryable. */
export class UnknownVerificationCommandError extends Error {
  constructor(readonly repositoryBindingId: RepositoryBindingId, readonly commandId: string) {
    super(`no approved verification command ${JSON.stringify(commandId)} for binding ${repositoryBindingId}`);
    this.name = 'UnknownVerificationCommandError';
  }
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
  // The commit the PR head points at, as the forge reports it at the time of
  // the call. Absent when the forge does not report one; a reader that needs
  // it (the pilot verifier's live check) treats absence as a failure.
  readonly headSha?: string;
  // The PR's title and body as the forge holds them now, reported by a lookup
  // (findPullRequest) so a takeover can compare them with what the attempt's
  // facts say they must be.
  readonly title?: string;
  readonly body?: string;
  // Whether the PR is open, and whether it was merged, as the forge reports
  // them at the time of the call. Only an open, unmerged PR on the attempt's
  // base is a reviewable publication; a reader treats a state the forge did
  // not report as not reviewable.
  readonly state?: 'open' | 'closed';
  readonly merged?: boolean;
}

// PUBLICATION UNDER TAKEOVER. A stale owner — an executor paused inside a forge
// call while its lease lapsed and a successor took its records over — may
// still reach the forge: no lease check or marker before a call can recall a
// call already in flight, and GitHub offers no compare-and-set for a pull
// request update. So the forge is not fenced. What holds instead:
//   - a push is compare-and-set: pushBranch writes the attempt's one commit
//     only over the value the branch is expected to hold (null: absent), so a
//     stale owner's late push is a no-op (same commit) or refused;
//   - a PR's content is a pure function of the attempt's immutable facts
//     (pullRequestContent), so a stale owner's late create or update writes
//     byte-identical content;
//   - a takeover reconciles the branch and the PR with those facts before any
//     terminal state, and repairs a divergence with an audit entry.

/** The immutable facts of an attempt a pull request presents. */
export interface PullRequestFacts {
  readonly taskId: string;
  readonly attemptId: string;
  // The verified harness commit the PR head must be.
  readonly commitSha: string;
  readonly evidenceId: string;
  // The branch the PR targets.
  readonly base: string;
}

/**
 * The title and body of an attempt's pull request: a pure function of its
 * facts, with nothing that depends on which owner writes it or when.
 */
export function pullRequestContent(facts: PullRequestFacts): { readonly title: string; readonly body: string } {
  return {
    title: `ASEP ${facts.taskId}: attempt ${facts.attemptId}`,
    body: [
      'Automated ASEP attempt, waiting for human review.',
      '',
      `Task: ${facts.taskId}`,
      `Attempt: ${facts.attemptId}`,
      `Commit: ${facts.commitSha}`,
      `Evidence: ${facts.evidenceId}`,
      `Base: ${facts.base}`,
      '',
    ].join('\n'),
  };
}

export interface ForgeProvider {
  // Compare-and-set: the branch must hold `expectedRemoteSha` (null: it must
  // not exist), or already hold `commitSha`, for the push to land; otherwise it
  // is refused and nothing changes.
  pushBranch(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha: string | null;
  }): Promise<void>;
  // Creates the PR for `headBranch` on `base`, or updates the title and body of
  // the open one on `base` with exactly those given. A PR for the head branch
  // that is closed, merged or on another base is a human's decision: it is
  // returned as found, never reopened, retargeted, edited or duplicated.
  upsertPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;
  // Sets the title and body of the PR numbered `number` to exactly those given:
  // one write, naming that PR. Nothing is listed, selected or created, and
  // nothing else about the PR changes — one a human closed, merged or
  // retargeted stays so. A number the forge holds no PR for is an error. This
  // is how an attempt's recorded PR is repaired: the write cannot land on
  // another PR for the same head branch.
  updatePullRequestContent(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    number: number;
    title: string;
    body: string;
  }): Promise<PullRequestRef>;
  // --- crash-recovery reconciliation (disp. P2-FINAL-HIGH-006, exit C7) ------
  //
  // A resume that finds a PENDING push/PR record cannot tell whether the effect
  // reached the forge before the crash. Re-calling blindly is what the two-phase
  // protocol exists to prevent, so the caller first asks the REMOTE what is
  // actually there — the natural-key reconciliation the protocol requires.
  //
  // resolveRef returns the commit SHA the remote ref currently points at, or
  // null when the ref does not exist (the push never landed).
  resolveRef(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
  }): Promise<string | null>;
  // findPullRequest returns the PR whose head is `headBranch` — open, closed or
  // merged, with its state — or null when no PR exists yet (the upsert never
  // landed).
  findPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
  }): Promise<PullRequestRef | null>;
}

// ---------------------------------------------------------------------------
// EvidenceStore — reserved-id evidence persistence (disp. P2-PLAN-HIGH-008,
// exit D8). The canonical EvidenceBundle.resultSha must equal the FINAL harness
// commit SHA, but a content-addressed id would depend on the bundle bytes which
// depend on the commit SHA — a cycle. We break it by RESERVING a
// non-content-derived id BEFORE the commit: the commit embeds that id in its
// `ASEP-Evidence` trailer, then the bundle (carrying the resulting commit SHA)
// is stored at the reserved id AFTER commit but BEFORE push.
//
// The reservation is durable and carries the DRAFT: the bundle minus the one
// fact only the commit can supply. So the evidence for a commit is fixed before
// the commit exists, a crash between commit and evidence persistence recovers
// by completing the draft with the committed SHA — never by re-deriving it —
// and the id a commit names is always a reservation of that commit's own
// attempt and tenant. putEvidence accepts only the reserved draft plus a
// resultSha, is idempotent for identical bytes and fails closed on different
// ones.
// ---------------------------------------------------------------------------

export type EvidenceDraft = Omit<EvidenceBundle, 'resultSha'>;

/** The bundle for a reserved draft once its commit exists, in canonical field order. */
export function evidenceBundleFrom(draft: EvidenceDraft, resultSha: string): EvidenceBundle {
  return {
    taskId: draft.taskId,
    attemptId: draft.attemptId,
    baseSha: draft.baseSha,
    resultSha,
    createdAt: draft.createdAt,
    environment: draft.environment,
    diff: draft.diff,
    checks: draft.checks,
  };
}

export interface EvidenceReservation {
  readonly evidenceId: ArtifactId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly draft: EvidenceDraft;
}

export interface EvidenceStore {
  reserveEvidence(scope: TenantScope, input: {
    readonly repositoryBindingId: RepositoryBindingId;
    readonly attemptId: AttemptId;
    readonly draft: EvidenceDraft;
  }): Promise<ArtifactId>;
  getReservation(scope: TenantScope, id: ArtifactId): Promise<EvidenceReservation>;
  putEvidence(scope: TenantScope, id: ArtifactId, bundle: EvidenceBundle): Promise<ArtifactRef>;
  getEvidence(scope: TenantScope, id: ArtifactId): Promise<EvidenceBundle>;
}

// ---------------------------------------------------------------------------
// SideEffectLog — two-phase crash-safe side-effect protocol (disp.
// P2-PLAN-HIGH-005, exit C7). Each external effect (commit, exact-ref push, PR
// upsert) is wrapped by a tenant-scoped record keyed by its typed identity
// (repositoryBindingId, attemptId, operation) with a request fingerprint, a
// PENDING/COMPLETED/FAILED state, an owner lease + its fencing epoch, and a
// remote natural key for reconciliation. Protocol per effect: begin(PENDING) →
// perform external call → complete(COMPLETED). On restart a PENDING row is
// reconciled by natural key against the remote before retry-vs-adopt; when its
// owner lease died, a successor lease with a newer epoch takes it over first.
// Reusing a key with a DIFFERENT fingerprint fails closed; a stale owner cannot
// complete another executor's operation (fencing).
// ---------------------------------------------------------------------------

export type SideEffectOperation = 'commit' | 'push' | 'pr-upsert';
export type SideEffectState = 'PENDING' | 'COMPLETED' | 'FAILED';

// The authoritative outcome recorded on a COMPLETED side effect (disp.
// P2-REREVIEW HIGH-005, exit D6).
//
// THE HOLE. `resultRef` was typed `unknown` and persisted as free JSONB, and
// every consumer recovered it with a blind cast. On a resume the adopted commit
// SHA and evidence id — the facts the whole crash-safety protocol hinges on —
// were therefore trusted without ever being checked.
//
// So the payload is a CLOSED discriminated union, one shape per operation, and
// it is closed at every boundary: writers must construct one of these shapes
// (the complete() input type pins the shape to the operation), the persistence
// adapter validates it before writing, the database refuses any other JSON with
// a CHECK constraint, and readers get it back already parsed. "Closed" is
// literal: an extra key is as much a violation as a missing one, because a
// payload carrying fields nobody validated is a payload nobody can trust.
export interface CommitResultRef {
  readonly kind: 'commit';
  readonly commitSha: string;      // 40-hex harness commit
  readonly evidenceId: string;     // the id embedded in its ASEP-Evidence trailer
}

export interface PushResultRef {
  readonly kind: 'push';
  readonly branch: string;         // the exact namespaced branch that was pushed
  readonly commitSha: string;      // 40-hex commit the remote ref was set to
}

export interface PullRequestResultRef {
  readonly kind: 'pr-upsert';
  readonly number: number;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export type SideEffectResultRef = CommitResultRef | PushResultRef | PullRequestResultRef;

/** A persisted result_ref did not match its operation's shape — refuse to adopt it. */
export class SideEffectResultRefError extends Error {
  constructor(operation: string, reason: string) {
    super(
      `side-effect ${operation} result_ref is not a valid authoritative outcome: ${reason} ` +
      `— refusing to adopt an unverified payload (fail closed)`,
    );
    this.name = 'SideEffectResultRefError';
  }
}

const SHA40 = /^[0-9a-f]{40}$/;

const RESULT_KEYS: Readonly<Record<SideEffectResultRef['kind'], readonly string[]>> = {
  'commit': ['kind', 'commitSha', 'evidenceId'],
  'push': ['kind', 'branch', 'commitSha'],
  'pr-upsert': ['kind', 'number', 'url', 'headBranch', 'baseBranch'],
};

function nonEmptyString(rec: Record<string, unknown>, key: string, op: string): string {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new SideEffectResultRefError(op, `${key} is missing`);
  }
  return v;
}

/**
 * Validate a `result_ref` against the closed shape for `expect`. Returns the
 * typed ref, or throws SideEffectResultRefError. `expect` pins which shape the
 * caller requires, so a commit record carrying a PR payload (or vice versa)
 * fails closed instead of being coerced. The `kind` discriminator is REQUIRED
 * and must equal `expect`; unknown keys are rejected.
 */
export function parseSideEffectResultRef(raw: unknown, expect: 'commit'): CommitResultRef;
export function parseSideEffectResultRef(raw: unknown, expect: 'push'): PushResultRef;
export function parseSideEffectResultRef(raw: unknown, expect: 'pr-upsert'): PullRequestResultRef;
export function parseSideEffectResultRef(
  raw: unknown,
  expect: SideEffectResultRef['kind'],
): SideEffectResultRef;
export function parseSideEffectResultRef(
  raw: unknown,
  expect: SideEffectResultRef['kind'],
): SideEffectResultRef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SideEffectResultRefError(expect, `expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  const rec = raw as Record<string, unknown>;
  if (rec['kind'] !== expect) {
    throw new SideEffectResultRefError(
      expect,
      rec['kind'] === undefined ? 'kind discriminator is missing' : `payload declares kind '${String(rec['kind'])}'`,
    );
  }
  const allowed = RESULT_KEYS[expect];
  const extra = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new SideEffectResultRefError(expect, `unexpected key(s) ${extra.join(', ')}`);
  }
  if (expect === 'commit') {
    const commitSha = nonEmptyString(rec, 'commitSha', expect);
    if (!SHA40.test(commitSha)) {
      throw new SideEffectResultRefError(expect, 'commitSha is not a 40-hex commit id');
    }
    return { kind: 'commit', commitSha, evidenceId: nonEmptyString(rec, 'evidenceId', expect) };
  }
  if (expect === 'push') {
    const commitSha = nonEmptyString(rec, 'commitSha', expect);
    if (!SHA40.test(commitSha)) {
      throw new SideEffectResultRefError(expect, 'commitSha is not a 40-hex commit id');
    }
    return { kind: 'push', branch: nonEmptyString(rec, 'branch', expect), commitSha };
  }
  const number = rec['number'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new SideEffectResultRefError(expect, 'number is not a positive integer');
  }
  const url = nonEmptyString(rec, 'url', expect);
  if (!/^https?:\/\//.test(url)) {
    throw new SideEffectResultRefError(expect, 'url is not an http(s) URL');
  }
  return {
    kind: 'pr-upsert',
    number,
    url,
    headBranch: nonEmptyString(rec, 'headBranch', expect),
    baseBranch: nonEmptyString(rec, 'baseBranch', expect),
  };
}

export interface SideEffectRecord {
  readonly operation: SideEffectOperation;
  readonly state: SideEffectState;
  readonly requestFingerprint: string;
  // The lease that currently owns the record, and that lease's fencing epoch.
  readonly ownerToken?: string;
  readonly ownerEpoch?: number;
  readonly naturalKey?: string;
  // Present exactly when state is COMPLETED, already validated against the
  // operation's closed shape.
  readonly resultRef?: SideEffectResultRef;
  // True when begin() found an existing record for this key (the caller must
  // reconcile a PENDING/COMPLETED row rather than perform the effect again).
  readonly existed: boolean;
  // True when this begin() moved an unfinished record from a dead owner lease to
  // the caller's newer lease. The effect may or may not have reached the outside
  // world before the old owner died, so the caller MUST reconcile against
  // external state before performing it.
  readonly takenOver?: boolean;
}

export interface SideEffectBeginInput {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly requestFingerprint: string;
  // The id of a LIVE workspace lease held for this attempt and binding. It is
  // the fencing token: the record is owned by that lease, and only a live
  // lease with a strictly newer epoch can take an unfinished record over.
  readonly ownerToken: string;
  readonly naturalKey?: string;
}

// The record's typed identity, for reads that must not claim anything.
export interface SideEffectKey {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
}

interface SideEffectCompleteBase {
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly ownerToken: string;
  readonly naturalKey?: string;
}

// The result shape is pinned to the operation by the type: a commit can only be
// completed with a CommitResultRef, a push with a PushResultRef, a PR upsert
// with a PullRequestResultRef. A completion without its outcome is not
// representable.
export type SideEffectCompleteInput =
  | (SideEffectCompleteBase & { readonly operation: 'commit'; readonly resultRef: CommitResultRef })
  | (SideEffectCompleteBase & { readonly operation: 'push'; readonly resultRef: PushResultRef })
  | (SideEffectCompleteBase & { readonly operation: 'pr-upsert'; readonly resultRef: PullRequestResultRef });

export class SideEffectFingerprintError extends Error {}
export class SideEffectFencingError extends Error {}

// The ownership rules every implementation enforces:
//   - begin() requires a live owner lease. A new record is owned by it. An
//     existing PENDING/FAILED record owned by ANOTHER lease is taken over only
//     when that lease is no longer live AND the caller's epoch is strictly
//     newer; otherwise begin() fails closed with SideEffectFencingError.
//   - complete()/fail() succeed only for the current owner while its lease is
//     still live, and never rewrite a COMPLETED record.
//   - confirmOwner() is called immediately before the external call: it
//     succeeds only for the current owner of a PENDING record while its lease
//     is live, renews that lease, and returns the owner's epoch (a record of
//     who acted; the forge call does not carry it).
//     An executor whose record was taken over while it was paused before this
//     call is refused here (SideEffectFencingError). One that confirmed and
//     then stalled inside the call can still reach the forge after a takeover:
//     see PUBLICATION UNDER TAKEOVER for what holds then.
//   - find() reads a record without claiming it.
export interface SideEffectLog {
  begin(scope: TenantScope, input: SideEffectBeginInput): Promise<SideEffectRecord>;
  confirmOwner(scope: TenantScope, input: SideEffectKey & { readonly ownerToken: string }): Promise<{ readonly fencingEpoch: number }>;
  complete(scope: TenantScope, input: SideEffectCompleteInput): Promise<SideEffectRecord>;
  fail(scope: TenantScope, input: { operation: SideEffectOperation; repositoryBindingId: RepositoryBindingId; attemptId: AttemptId; ownerToken: string }): Promise<SideEffectRecord>;
  find(scope: TenantScope, key: SideEffectKey): Promise<SideEffectRecord | null>;
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

// ---------------------------------------------------------------------------
// Run events (shared append-only sink; both lanes inject the one adapter).
// ---------------------------------------------------------------------------

export interface RunEventSink {
  /**
   * Idempotent on event.eventId within the scope: the same id with identical canonical
   * bytes returns { appended: false }; the same id with different bytes throws
   * RunEventConflictError. The event is validated against run-event 1.2.0 before insert.
   */
  append(scope: TenantScope, event: RunEvent): Promise<{ readonly appended: boolean }>;
}

export class RunEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunEventConflictError';
  }
}

// ---------------------------------------------------------------------------
// Attempt terminals of the default assurance slot.
//
// The default slot records an attempt's terminal as its two attempt events,
// written through the run-event sink. The store makes that write the fenced,
// idempotent and atomic one the review-loop slot contract requires: in one
// transaction it locks the attempt row, checks the scope, checks the caller's
// fence (or, for an attempt presented without one, that its durable lease history
// is empty), compares any terminal already recorded, and appends the events.
// ---------------------------------------------------------------------------

/** The caller's lease identity on an attempt's workspace lease, as the fenced lease primitive granted it. */
export interface AttemptLeaseFence {
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

/** An attempt with the run, task and binding it belongs to; all of them must lie in the caller's scope. */
export interface AttemptRef {
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
}

/**
 * 'fenced': the lease is not ACTIVE and live, is not the attempt's, or is at another epoch.
 * 'not-in-scope': the scope does not own the attempt with that run, task and binding.
 */
export type AttemptLeaseCheck = 'held' | 'not-in-scope' | 'fenced';

export type AttemptTerminalRefusal =
  /** The scope does not own the attempt with that run, task and binding. */
  | 'not-in-scope'
  /** The fence presented is not the attempt's current lease. */
  | 'fenced'
  /** No fence was presented, but the attempt's durable lease history shows a lease. */
  | 'lease-granted'
  /** A terminal is recorded for the attempt and its events differ from these. */
  | 'conflicting-redelivery';

export type AttemptTerminalWrite =
  | { readonly kind: 'recorded' }
  /** A terminal with the same events, occurredAt aside, is already recorded: nothing was written. */
  | { readonly kind: 'redelivered' }
  /** Nothing was written. */
  | { readonly kind: 'refused'; readonly reason: AttemptTerminalRefusal };

export interface AttemptTerminalStore {
  /** Whether `fence` is the attempt's current lease: ACTIVE, live, held by `fence.leaseId` at `fence.fencingEpoch`. */
  checkLease(scope: TenantScope, attempt: AttemptRef, fence: AttemptLeaseFence): Promise<AttemptLeaseCheck>;
  /**
   * Records the attempt's terminal as `events` (each of the attempt, with an id derived from it) in one
   * transaction, under the lock on the attempt row that lease acquisition also takes. `fence` null is accepted
   * only while the attempt has never held a lease.
   */
  recordTerminal(
    scope: TenantScope,
    attempt: AttemptRef,
    fence: AttemptLeaseFence | null,
    events: readonly RunEvent[],
  ): Promise<AttemptTerminalWrite>;
}
