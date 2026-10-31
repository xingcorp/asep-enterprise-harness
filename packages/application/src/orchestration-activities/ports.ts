// What the orchestration activities need from durable state, beyond the ports
// package: the shapes the persistence and forge adapters implement for durable
// orchestration. Declared here, structurally, so the activities compose against
// shapes and never name an adapter class, like the vertical slice's
// repository ports.
//
// Every write is idempotent by a natural key the workflow supplies, so an
// activity invoked twice with the same input converges to one durable outcome.

import type {
  ArtifactRef, AttemptId, RepositoryBindingId, RunId, TaskId, TenantScope,
} from '@asep/contracts';
import type { AttemptLeaseFence, AttemptRef, Lease, LeaseDenied } from '@asep/ports';
import type { AuditEvent } from '@asep/observability';

// --- attempts ----------------------------------------------------------------

export type AttemptKind = 'initial' | 'retry' | 'repair';

/** An attempt's registration: its natural key (task, number) and the identity that must match on every redelivery. */
export interface AttemptRegistration {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptNumber: number;
  readonly kind: AttemptKind;
  readonly baseSha: string;
  readonly parentAttemptNumber: number | null;
  readonly repairOrderRef: ArtifactRef | null;
}

/**
 * The attempt row already exists under that (task, number) with another kind, base, parent or repair order.
 * Not retryable: two workflows disagree about one attempt.
 */
export class AttemptIdentityConflictError extends Error {
  constructor(taskId: string, attemptNumber: number, field: string) {
    super(`attempt ${attemptNumber} of task ${taskId} is registered with another ${field}`);
    this.name = 'AttemptIdentityConflictError';
  }
}

export interface AttemptRegistry {
  /** Idempotent on (task, attempt number): returns the existing attempt when its identity matches, else throws AttemptIdentityConflictError. */
  ensure(scope: TenantScope, registration: AttemptRegistration): Promise<{ readonly attemptId: AttemptId }>;
  /** Read-only lookup by the natural key; null when no row exists. */
  find(scope: TenantScope, key: { readonly taskId: TaskId; readonly attemptNumber: number }): Promise<AttemptId | null>;
}

// --- leases --------------------------------------------------------------------

/**
 * The workspace lease of an attempt, on the workspace lease primitive. `acquire` runs the primitive's acquisition
 * under the lock on the attempt row that the terminal write also takes, and refuses an attempt whose terminal is
 * recorded. `findByAttempt` reads the attempt's durable lease history: the fence of the lease it holds or held.
 */
export interface AttemptLeases {
  acquire(scope: TenantScope, input: { readonly attempt: AttemptRef; readonly branch: string; readonly ttlMs: number }): Promise<Lease | LeaseDenied>;
  findByAttempt(scope: TenantScope, attempt: AttemptRef): Promise<AttemptLeaseFence | null>;
  /** Extends a live lease; throws LeaseLostError otherwise (the primitive's renewal). */
  heartbeat(scope: TenantScope, leaseId: string): Promise<void>;
  release(scope: TenantScope, leaseId: string): Promise<void>;
}

// --- attempt facts -------------------------------------------------------------

/**
 * Facts an activity establishes about an attempt and a later activity, or a redelivery, reads back: the context
 * pack the agent is handed, that the agent was started, its outcome, what verification found, and the publication
 * facts a pull request presents.
 */
export type AttemptFactKind = 'context-pack' | 'agent-started' | 'agent-outcome' | 'verification' | 'publication';

export interface AttemptFactStore {
  /**
   * Set once by (attempt, kind). The first write wins: a later write of the same key stores nothing and returns
   * the value stored first, so every delivery converges on one fact.
   */
  putOnce(scope: TenantScope, input: {
    readonly attemptId: AttemptId;
    readonly kind: AttemptFactKind;
    readonly value: unknown;
  }): Promise<{ readonly value: unknown; readonly created: boolean }>;
  get(scope: TenantScope, input: { readonly attemptId: AttemptId; readonly kind: AttemptFactKind }): Promise<unknown>;
}

// --- projection ----------------------------------------------------------------

/**
 * Two workflows project the same task or attempt. Not retryable: the projection belongs to the first one.
 */
export class ProjectionOwnershipError extends Error {
  constructor(target: string, workflowId: string) {
    super(`${target} is projected by another workflow than ${workflowId}`);
    this.name = 'ProjectionOwnershipError';
  }
}

export interface ProjectionWriter {
  /**
   * Monotonic: applies only when `projectionSeq` is newer than the stored one, and the row is unowned or owned by
   * this workflow; an equal or older sequence is a no-op; another owner throws ProjectionOwnershipError.
   */
  projectTask(scope: TenantScope, input: {
    readonly taskId: TaskId;
    readonly workflowId: string;
    readonly projectionSeq: number;
    readonly status: string;
  }): Promise<{ readonly applied: boolean }>;
}

// --- budget ledger -------------------------------------------------------------

export type LedgerEntryKind = 'attempt-usage' | 'extension-granted' | 'overrun';
export type LedgerSource = 'provider-reported' | 'harness-measured' | 'human-granted';

export interface LedgerEntry {
  /** `<attemptId>:attempt-usage`, `<attemptId>:overrun` or `<approvalRequestId>:extension`. */
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId | null;
  readonly entryKind: LedgerEntryKind;
  readonly source: LedgerSource;
  /** Integer micro-USD. */
  readonly amountMicroUsd: number;
  readonly toolCalls: number;
  readonly wallClockMs: number;
  readonly usageOutOfBound: boolean;
}

export interface BudgetLedger {
  /** Idempotent by (scope, idempotencyKey): a repeat of the same entry is a no-op. */
  append(scope: TenantScope, entry: LedgerEntry): Promise<{ readonly appended: boolean }>;
}

// --- approvals -----------------------------------------------------------------

export type ApprovalKind = 'budget-extension' | 'publish-change';

export interface ApprovalRequestRecord {
  /** `<workflowId>:<gateSeq>`, deterministic from the workflow. */
  readonly approvalRequestId: string;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId | null;
  readonly kind: ApprovalKind;
  readonly requestedBy: string;
  readonly expiresAt: string;
  /** Integer micro-USD; set for a budget extension. */
  readonly shortfallMicroUsd: number | null;
}

/** A human decision as PostgreSQL holds it, for the workflow to act on only once verified there. */
export interface ApprovalDecisionRecord {
  readonly decisionId: string;
  readonly approvalRequestId: string;
  readonly decision: 'approve' | 'reject';
  readonly extensionUsd: number | null;
  readonly decidedBy: string;
}

export interface ApprovalStore {
  /** Idempotent by approvalRequestId: a repeat of the same request is a no-op. */
  open(scope: TenantScope, request: ApprovalRequestRecord): Promise<{ readonly opened: boolean }>;
  findDecision(scope: TenantScope, key: { readonly approvalRequestId: string; readonly decisionId: string }): Promise<ApprovalDecisionRecord | null>;
  /** Closes a PENDING request; a request already closed stays as it is. */
  close(scope: TenantScope, input: { readonly approvalRequestId: string; readonly status: 'EXPIRED' | 'CANCELLED' }): Promise<{ readonly closed: boolean }>;
}

// --- audit -----------------------------------------------------------------------

export interface OrchestrationAuditLog {
  /** Idempotent by (scope, key): a repeat writes nothing. */
  record(scope: TenantScope, entry: { readonly key: string; readonly event: AuditEvent }): Promise<{ readonly recorded: boolean }>;
}

// --- publication reads -------------------------------------------------------------

/** A forge repository by its numeric id; owner and name are informational. */
export interface ForgeRepositoryRef {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
}

export interface ListedPullRequest {
  readonly number: number;
  readonly headRepository: ForgeRepositoryRef;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseRepository: ForgeRepositoryRef;
  readonly baseBranch: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly title: string;
  readonly body: string;
}

/**
 * The forge reads a publication reconciliation needs: the branch with its repository, and every pull request
 * with a head branch, in any state and from any head repository, with repositories by numeric id.
 */
export interface PublicationReader {
  readBranch(scope: TenantScope, input: {
    readonly repositoryBindingId: RepositoryBindingId;
    readonly branch: string;
  }): Promise<{ readonly repository: ForgeRepositoryRef; readonly headSha: string } | null>;
  listPullRequests(scope: TenantScope, input: {
    readonly repositoryBindingId: RepositoryBindingId;
    readonly headBranch: string;
  }): Promise<readonly ListedPullRequest[]>;
}
