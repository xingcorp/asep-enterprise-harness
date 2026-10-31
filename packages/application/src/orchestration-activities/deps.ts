// What the orchestration activities are composed from: the pipeline ports, the
// durable-orchestration shapes of ./ports.ts, the review-loop slot and the
// host-shaped seams a pure use case must not compute itself. The worker
// composition root builds one of these and hands it to
// createOrchestrationActivities.

import type {
  EvidenceBundle, RepositoryBindingId, RiskLevel, RunId, TaskId, AttemptId, TenantScope, WorkspaceId,
} from '@asep/contracts';
import type {
  ArtifactStore, CodingAgentProvider, CommandRunner, EvidenceStore, ExecutionReaper, ForgeProvider,
  GitChangeInspector, GitCommitter, RunEventSink, SandboxProvider, SideEffectLog, ToolPolicyProfile,
  VerificationCommandCatalog, WorkspaceManager, WorkspaceRegistry, AgentAttemptObservation,
} from '@asep/ports';
import type { AuditSink, SpanTracer } from '@asep/observability';
import type { FailureClass } from '@asep/policy';
import type { AdmissionResult } from '../risk-admission.js';
import type { ReviewLoopSlot } from '../review-loop/slot.js';
import type {
  ApprovalStore, AttemptFactStore, AttemptLeases, AttemptRegistry, BudgetLedger, OrchestrationAuditLog,
  ProjectionWriter, PublicationReader,
} from './ports.js';

/** The Git side of one repository binding (the same shape the vertical slice resolves per binding). */
export interface ActivityGitBackend {
  readonly workspaces: WorkspaceManager;
  readonly inspector: GitChangeInspector;
  readonly committer: GitCommitter;
  /** Absolute path of a workspace of this backend, for the verification mount; an adapter concern. */
  readonly pathOf: (workspaceId: WorkspaceId) => Promise<string> | string;
}

export interface OrchestrationActivityDeps {
  // --- attempts, leases and attempt facts --------------------------------------
  readonly attempts: AttemptRegistry;
  readonly leases: AttemptLeases;
  readonly leaseTtlMs: number;
  readonly facts: AttemptFactStore;
  /** The attempt branch naming rule (a Git adapter concern). */
  readonly branchFor: (ids: { readonly runId: RunId; readonly taskId: TaskId; readonly attemptId: AttemptId }) => string;

  // --- workspaces, agent, verification -----------------------------------------
  readonly workspaceRegistry: WorkspaceRegistry;
  /** This worker's host; a workspace registered on another host is unavailable here. */
  readonly hostId: string;
  readonly gitBackend: (input: {
    readonly scope: TenantScope;
    readonly repositoryBindingId: RepositoryBindingId;
  }) => Promise<ActivityGitBackend> | ActivityGitBackend;
  readonly reaper: ExecutionReaper;
  readonly providerFor: (input: { readonly scope: TenantScope }) => CodingAgentProvider;
  readonly toolPolicy: ToolPolicyProfile;
  /**
   * The failure class of an agent that stopped FAILED or BLOCKED. Absent: a FAILED agent is a provider failure and
   * a BLOCKED one lacked the context to proceed.
   */
  readonly classifyAgent?: (observation: AgentAttemptObservation) => FailureClass;
  /** A monotonic clock in milliseconds, for the harness-measured wall-clock of the agent. */
  readonly monotonicMs: () => number;
  /** How often a long activity heartbeats, and how often of those it renews its lease. */
  readonly heartbeatEveryMs: number;
  readonly leaseRenewEveryMs: number;
  readonly catalog: VerificationCommandCatalog;
  readonly runnerFor: (input: { readonly scope: TenantScope }) => CommandRunner;
  readonly sandbox: SandboxProvider;

  // --- commit, evidence, publication --------------------------------------------
  readonly artifacts: ArtifactStore;
  readonly evidence: EvidenceStore;
  readonly environment: EvidenceBundle['environment'];
  readonly commitIdentity: { readonly name: string; readonly email: string };
  readonly sideEffects: SideEffectLog;
  readonly forge: ForgeProvider;
  readonly publicationReader: PublicationReader;

  // --- assurance -----------------------------------------------------------------
  readonly slot: ReviewLoopSlot;
  /**
   * The admission hook. Absent: admitRisk, admission unchanged. A composition with independent assurance
   * passes `(risk) => slot.admitWithAssurance(risk, capability)`.
   */
  readonly admit?: (risk: RiskLevel) => AdmissionResult;
  readonly implementer: { readonly providerId: string; readonly model: string };

  // --- bookkeeping -------------------------------------------------------------------
  readonly projection: ProjectionWriter;
  readonly ledger: BudgetLedger;
  readonly approvals: ApprovalStore;
  readonly runEvents: RunEventSink;
  readonly audit: OrchestrationAuditLog;

  // --- telemetry -----------------------------------------------------------------------
  /** Emits the orchestration.activity span, and the pipeline's boundary spans inside the activities. */
  readonly tracer?: SpanTracer;
  /** The pipeline's boundary audit rows (git.commit, forge.push, …) inside the activities. */
  readonly boundaryAudit?: AuditSink;
  readonly actor: string;
}
