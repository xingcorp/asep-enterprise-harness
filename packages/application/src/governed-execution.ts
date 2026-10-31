// Top-level governed execution use case (disp. P2-FINAL-HIGH-003; exit criteria
// BR1/BR2/I4).
//
// This is the SINGLE entry point that OWNS the ordering of the irreversible
// side-effect sequence. The review found that admission ran only inside the
// reduced execute-task pipeline, AFTER a lease had already been acquired and a
// worktree created by the caller (vertical-integration.test.ts acquired the
// lease + built the worktree, THEN called admission). That violates BR1/BR2/I4:
// an unsupported risk must stop BEFORE any workspace creation, agent invocation
// or push.
//
// So this use case takes only task identity + the ports it needs, and runs
// admission FIRST. It acquires the lease and creates the workspace ITSELF, and
// only AFTER admission is admitted. When admission defers, it returns without
// touching the lease repo, the workspace manager, the agent provider or the
// forge — provable with spies (see governed-execution.test.ts, R0..R4).
//
// It composes only against @asep/ports interfaces + the pure admission logic —
// no provider SDK, pg, Octokit, Docker (exit B3). The post-admission body
// delegates to the existing agent/inspect steps so there is one authority for
// the trust rules, not two.

import type {
  RiskLevel,
  TenantScope,
  AttemptId,
  ArtifactRef,
  Budget,
  RepositoryBindingId,
  WorkspaceId,
} from '@asep/contracts';
import type {
  CodingAgentProvider,
  AgentAttemptObservation,
  ToolPolicyProfile,
  GitChangeInspector,
  GitChangeObservation,
  WorkspaceLeaseRepository,
  WorkspaceManager,
  Workspace,
  Lease,
} from '@asep/ports';
import type {
  SpanTracer, AuditSink, CorrelationContext,
} from '@asep/observability';
import { auditEvent } from '@asep/observability';
import { admitRisk, type AdmissionResult } from './risk-admission.js';
import { agentStep, inspectStep } from './execute-task.js';

// ---------------------------------------------------------------------------
// Where the governed sequence stopped. `admission` means NOTHING irreversible
// happened: no lease, no workspace, no agent, no push.
// ---------------------------------------------------------------------------

export type GovernedStop =
  | 'admission'
  | 'lease-denied'
  | 'agent'
  | 'inspect'
  | 'ready-for-completion';

export interface GovernedExecutionInput {
  readonly scope: TenantScope;
  readonly risk: RiskLevel;

  // Task identity — the use case is told WHICH task/attempt to run, and owns
  // everything downstream of that (lease, workspace, agent, inspection).
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly branch: string;
  readonly leaseTtlMs: number;

  // Ports the use case drives ITSELF, strictly after admission.
  readonly leases: WorkspaceLeaseRepository;
  readonly workspaces: WorkspaceManager;
  readonly provider: CodingAgentProvider;
  readonly inspector: GitChangeInspector;

  // Agent inputs.
  readonly workOrderRef: ArtifactRef;
  readonly contextPackRef: ArtifactRef;
  readonly budget: Budget;
  readonly toolPolicy: ToolPolicyProfile;
  readonly signal: AbortSignal;

  // MED-003 runtime observability (all optional so the pure use case still runs
  // without a wired sink). When provided, each privileged boundary emits a span
  // through the tracer AND an audit row through the sink, both carrying the full
  // org/project/repository/run/task/attempt correlation identity (J1/J2/J4).
  readonly tracer?: SpanTracer;
  readonly audit?: AuditSink;
  readonly traceId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly actor?: string;
  readonly now?: () => string;
}

export interface GovernedExecutionResult {
  readonly admission: AdmissionResult;
  readonly admitted: boolean;
  readonly stoppedAt: GovernedStop;
  readonly requiresHumanIndependentReview: boolean;

  // Populated only once the corresponding side effect actually happened, so a
  // caller (and a test) can assert exactly how far the sequence advanced.
  readonly leaseId?: string;
  readonly workspaceId?: WorkspaceId;
  readonly workspace?: Workspace;
  readonly observation?: AgentAttemptObservation;
  readonly change?: GitChangeObservation;
}

/**
 * Run the governed execution sequence for one attempt. Admission is evaluated
 * FIRST; when it defers, the function returns immediately having touched no
 * lease, workspace, agent or forge. Only an admitted risk proceeds to acquire a
 * lease, create the workspace, invoke the agent and inspect the result. The
 * caller then drives verify → commit → evidence → push → PR (completeToReview)
 * — this use case deliberately STOPS at inspection so the irreversible push
 * path stays in one place and can itself be admission-gated by construction
 * (nothing past here runs unless admission admitted).
 */
export async function governedExecution(
  input: GovernedExecutionInput,
): Promise<GovernedExecutionResult> {
  // MED-003: build the full correlation identity once. Spans/audit rows only
  // emit when the load-bearing hierarchy ids (run/task/attempt) are all present
  // — a partial context would fail auditEvent()'s closed validation, so we skip
  // emission rather than throw and abort a real execution.
  const correlation: CorrelationContext | null =
    input.runId && input.taskId
      ? {
          traceId: input.traceId ?? `trace-${input.attemptId}`,
          tenantId: input.scope.organizationId,
          projectId: input.scope.projectId,
          organizationId: input.scope.organizationId,
          repositoryBindingId: input.repositoryBindingId,
          runId: input.runId,
          taskId: input.taskId,
          attemptId: input.attemptId,
        }
      : null;
  const actor = input.actor ?? 'harness';
  const nowIso = input.now ?? (() => new Date().toISOString());

  // Emit a span + an audit row for one privileged boundary, then run it. When no
  // tracer/sink is wired (or the context is partial) this is a no-op wrapper, so
  // the pure use case is unchanged. J1 span name + J4 audit action are paired.
  const observe = async <T>(
    span: import('@asep/observability').SpanName,
    action: import('@asep/observability').PrivilegedAction,
    detail: Readonly<Record<string, unknown>>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (!correlation) return fn();
    if (input.audit) {
      await input.audit.record(auditEvent({
        actor, action, context: correlation, occurredAt: nowIso(), detail,
      }));
    }
    if (input.tracer) {
      return input.tracer.withSpan(span, correlation, fn);
    }
    return fn();
  };

  // --- GATE: admission runs before ANY side effect --------------------------
  const admission = admitRisk(input.risk);
  if (!admission.admitted) {
    return {
      admission,
      admitted: false,
      stoppedAt: 'admission',
      requiresHumanIndependentReview: admission.requiresHumanIndependentReview,
    };
  }

  // --- side effect 1: acquire the workspace lease (only now) ----------------
  if (input.leaseTtlMs <= budgetWallClockMs(input.budget)) {
    throw new LeaseTtlTooShortError(input.leaseTtlMs, budgetWallClockMs(input.budget));
  }
  const lease = await observe(
    'workspace.lease', 'workspace.lease.acquire', { branch: input.branch },
    () => input.leases.acquire(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      branch: input.branch,
      attemptId: input.attemptId,
      ttlMs: input.leaseTtlMs,
    }),
  );
  if (!isLease(lease)) {
    return {
      admission,
      admitted: true,
      stoppedAt: 'lease-denied',
      requiresHumanIndependentReview: admission.requiresHumanIndependentReview,
    };
  }

  // --- side effect 2: create the workspace (only after a granted lease) -----
  const workspace = await observe(
    'workspace.create', 'workspace.create', { baseSha: input.baseSha },
    () => input.workspaces.create(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      baseSha: input.baseSha,
      leaseId: lease.leaseId,
      attemptId: input.attemptId,
    }),
  );

  // --- side effect 3: invoke the agent (untrusted self-report) --------------
  const agent = await observe(
    'agent.invoke', 'agent.invoke', { providerId: input.provider.providerId },
    () => agentStep({
      provider: input.provider,
      attemptId: input.attemptId,
      workOrderRef: input.workOrderRef,
      contextPackRef: input.contextPackRef,
      workspace: workspace.capability,
      budget: input.budget,
      toolPolicy: input.toolPolicy,
      signal: input.signal,
    }),
  );
  if (agent.status === 'STOP') {
    return {
      admission,
      admitted: true,
      stoppedAt: 'agent',
      requiresHumanIndependentReview: admission.requiresHumanIndependentReview,
      leaseId: lease.leaseId,
      workspaceId: workspace.workspaceId,
      workspace,
      observation: agent.observation,
    };
  }

  // --- trusted inspection: harness-derived facts (never provider-reported) --
  const inspect = await inspectStep({
    inspector: input.inspector,
    scope: input.scope,
    workspace: workspace.capability,
  });

  return {
    admission,
    admitted: true,
    stoppedAt: inspect.status === 'STOP' ? 'inspect' : 'ready-for-completion',
    requiresHumanIndependentReview: admission.requiresHumanIndependentReview,
    leaseId: lease.leaseId,
    workspaceId: workspace.workspaceId,
    workspace,
    observation: agent.observation,
    change: inspect.change,
  };
}

// A granted lease carries a leaseId; a denial carries a reason. Narrow on the
// discriminating field rather than a status string so the port stays minimal.
function isLease(v: Lease | { readonly reason: string }): v is Lease {
  return 'leaseId' in v;
}

// --- lease TTL vs the agent's wall clock -------------------------------------
//
// A lease is renewed by a heartbeat at every completion boundary, but nothing
// can heartbeat while the agent runs. So the TTL must outlive the longest
// agent run the budget allows; otherwise the lease lapses mid-run, a successor
// may take the branch over, and the healthy holder fails at its next fence.
// That is safe (the stale holder is refused) but it turns every long run into a
// failure, so a too-short TTL is refused before the lease is taken.

/** Slack on top of the agent's wall-clock budget for inspection + the first fence. */
export const LEASE_TTL_MARGIN_MS = 60_000;

function budgetWallClockMs(budget: Budget): number {
  return Math.ceil(budget.maxWallClockMinutes * 60_000);
}

/** The lease TTL a run under `budget` needs: the agent's wall clock plus margin. */
export function leaseTtlForBudget(budget: Budget): number {
  return budgetWallClockMs(budget) + LEASE_TTL_MARGIN_MS;
}

export class LeaseTtlTooShortError extends Error {
  constructor(ttlMs: number, wallClockMs: number) {
    super(
      `lease TTL ${ttlMs}ms does not outlive the agent's wall-clock budget of ${wallClockMs}ms — ` +
      'the lease would lapse mid-run (fail closed; see leaseTtlForBudget)',
    );
    this.name = 'LeaseTtlTooShortError';
  }
}
