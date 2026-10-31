// The activities that work in an attempt's workspace: prepare it, store the
// agent's inputs, run the agent, inspect, verify, commit and persist evidence,
// and reap, quarantine or clean up after it.
//
// Each one converges when invoked twice with the same input:
//   - a fact an activity establishes about the attempt (its context pack, that
//     its agent started, the agent's outcome, what verification found) is
//     written once and read back by every later delivery;
//   - the commit is the two-phase commit protocol keyed by the attempt, so a
//     redelivery adopts the recorded commit, and its evidence id is reserved
//     only when no commit of the attempt exists yet, with the draft timed at the
//     workflow's logical time, so a re-reservation holds the same bytes;
//   - the agent never runs twice for one attempt: a delivery that finds the
//     agent started and no outcome fails, and the workflow replaces the attempt.
//
// Every external call is preceded by the delivery's abort check and the
// caller's fence: the lease primitive's renewal (it fails for a lease that is not
// live), or, inside the side-effect protocol, the record's owner confirmation.

import type { ActivityExecutionContext, AgentAttemptObservation, CommitResultRef, GitChangeObservation, GitCommitter, WorkspaceCapability, WorkspaceRecord } from '@asep/ports';
import { WorkspaceUnavailableError, parseSideEffectResultRef } from '@asep/ports';
import type { ArtifactId, ArtifactRef, Budget, RiskLevel } from '@asep/contracts';
import { classifyFailure, type AssuranceLevel, type FailureClass } from '@asep/policy';
import { agentStep, inspectStep } from '../execute-task.js';
import {
  commitStep, evidenceDraft, evidenceStep, settleCommitStep, verifyStep,
  type ObserveBoundary, type VerificationCheckExecution, type VerificationCheckSpec,
} from '../pipeline-steps.js';
import { completionObserver, fencedBy } from '../completion-observer.js';
import { REVIEW_LOOP_SLOT_VERSION } from '../review-loop/slot.js';
import { ActivityCancelledError, assuranceStepContext, throwIfCancelled } from './context.js';
import type { ActivityGitBackend, OrchestrationActivityDeps } from './deps.js';
import {
  AgentRedeliveryError, OrchestrationContractError, correlationOf,
  type AttemptActivityIdentity, type LeasedAttemptIdentity,
} from './identity.js';
import { auditedLog } from './side-effect-audit.js';

// --- shared --------------------------------------------------------------------

/** The attempt's workspace, from the durable registry: on this host, and active. */
export async function workspaceOf(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity,
): Promise<{ readonly record: WorkspaceRecord; readonly capability: WorkspaceCapability }> {
  const record = await deps.workspaceRegistry.findByAttempt(input.scope, input.attemptId);
  if (record === null) throw new WorkspaceUnavailableError('missing', `attempt ${input.attemptId} has no workspace`);
  if (record.state === 'QUARANTINED') throw new WorkspaceUnavailableError('quarantined', `workspace ${record.workspaceId}`);
  if (record.hostId !== deps.hostId) throw new WorkspaceUnavailableError('other-host', `workspace ${record.workspaceId} is on another host`);
  if (record.state !== 'ACTIVE') throw new WorkspaceUnavailableError('missing', `workspace ${record.workspaceId} is ${record.state}`);
  return { record, capability: { workspaceId: record.workspaceId, leaseId: record.leaseId } };
}

async function gitOf(deps: OrchestrationActivityDeps, input: AttemptActivityIdentity): Promise<ActivityGitBackend> {
  return deps.gitBackend({ scope: input.scope, repositoryBindingId: input.repositoryBindingId });
}

/** The pipeline's boundary spans and audit rows, inside the activity; a pass-through when neither is wired. */
export function boundaryObserver(deps: OrchestrationActivityDeps, input: AttemptActivityIdentity): ObserveBoundary {
  if (deps.tracer === undefined && deps.boundaryAudit === undefined) return (_b, fn) => fn();
  return completionObserver({
    correlation: correlationOf(input, input.attemptId),
    actor: deps.actor,
    ...(deps.tracer !== undefined ? { tracer: deps.tracer } : {}),
    ...(deps.boundaryAudit !== undefined ? { audit: deps.boundaryAudit } : {}),
  });
}

/** The fence an external call is made under: not cancelled, and the caller's lease still live. */
async function checkFence(deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity, ctx: ActivityExecutionContext, what: string): Promise<void> {
  throwIfCancelled(ctx, what);
  await deps.leases.heartbeat(input.scope, input.fence.leaseId);
  throwIfCancelled(ctx, what);
}

/**
 * Keeps a long activity alive: heartbeats the engine, and renews the caller's lease less often. A renewal that
 * fails means a successor may own the attempt, so the work is aborted; so is a cancelled delivery.
 */
function keepAlive(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity, ctx: ActivityExecutionContext, stage: string,
): { readonly signal: AbortSignal; readonly lost: () => unknown; stop(): void } {
  const controller = new AbortController();
  let lostWith: unknown = null;
  const onAbort = (): void => controller.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
  let sinceRenewal = 0;
  const timer = setInterval(() => {
    ctx.heartbeat({ stage });
    sinceRenewal += deps.heartbeatEveryMs;
    if (sinceRenewal < deps.leaseRenewEveryMs) return;
    sinceRenewal = 0;
    deps.leases.heartbeat(input.scope, input.fence.leaseId).catch((err: unknown) => {
      lostWith = err;
      controller.abort(err);
    });
  }, deps.heartbeatEveryMs);
  return {
    signal: controller.signal,
    lost: () => lostWith,
    stop() {
      clearInterval(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    },
  };
}

/** The committer with the delivery's abort check made immediately before the commit, after the owner confirmation. */
function guardedCommitter(committer: GitCommitter, ctx: ActivityExecutionContext): GitCommitter {
  return {
    commit: (scope, input) => {
      throwIfCancelled(ctx, 'the commit');
      return committer.commit(scope, input);
    },
    reconcile: (scope, input) => committer.reconcile(scope, input),
  };
}

// --- prepareWorkspace, storeAttemptInputs ------------------------------------------

export async function prepareWorkspace(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity & { readonly baseSha: string }, ctx: ActivityExecutionContext,
): Promise<Record<string, never>> {
  const git = await gitOf(deps, input);
  await checkFence(deps, input, ctx, 'the workspace creation');
  // Create-or-adopt keyed by the attempt: a redelivery finds the workspace an earlier one made.
  await boundaryObserver(deps, input)(
    { span: 'workspace.create', action: 'workspace.create', detail: { baseSha: input.baseSha } },
    () => git.workspaces.create(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      baseSha: input.baseSha,
      leaseId: input.fence.leaseId,
      attemptId: input.attemptId,
    }),
  );
  return {};
}

export interface StoreAttemptInputsInput extends LeasedAttemptIdentity {
  /** The task's context pack, as the workflow input references it. */
  readonly contextPackRef: ArtifactRef;
  /** Set for an attempt with a repair lineage: its context pack is derived from the task's and the repair order. */
  readonly repairOrderRef: ArtifactRef | null;
}

export async function storeAttemptInputs(
  deps: OrchestrationActivityDeps, input: StoreAttemptInputsInput, ctx: ActivityExecutionContext,
): Promise<Record<string, never>> {
  const key = { attemptId: input.attemptId, kind: 'context-pack' as const };
  if (await deps.facts.get(input.scope, key) !== null) return {};
  throwIfCancelled(ctx, 'storing the attempt inputs');
  const contextPackRef = input.repairOrderRef === null
    ? input.contextPackRef
    : (await deps.slot.buildRepairContextPack({
      slotVersion: REVIEW_LOOP_SLOT_VERSION,
      scope: input.scope,
      attemptId: input.attemptId,
      originalContextPackRef: input.contextPackRef,
      repairOrderRef: input.repairOrderRef,
      fence: input.fence,
    }, assuranceStepContext(ctx))).contextPackRef;
  await deps.facts.putOnce(input.scope, { ...key, value: contextPackRef });
  return {};
}

// --- runAgent ----------------------------------------------------------------------

export interface RunAgentInput extends LeasedAttemptIdentity {
  readonly workOrderRef: ArtifactRef;
  readonly budget: Budget;
}

export interface RunAgentResult {
  readonly status: AgentAttemptObservation['status'];
  readonly reportedCostUsd: number;
  readonly reportedToolCalls: number;
  readonly wallClockMs: number;
  readonly failureClass: FailureClass | null;
}

/** The agent's recorded outcome: what the workflow is told, and the token counts its terminal reports. */
interface AgentOutcomeFact extends RunAgentResult {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function defaultAgentFailureClass(observation: AgentAttemptObservation): FailureClass {
  return observation.status === 'BLOCKED'
    ? classifyFailure({ insufficientContext: true })
    : classifyFailure({ providerError: true });
}

export async function runAgent(
  deps: OrchestrationActivityDeps, input: RunAgentInput, ctx: ActivityExecutionContext,
): Promise<RunAgentResult> {
  const outcomeKey = { attemptId: input.attemptId, kind: 'agent-outcome' as const };
  const recorded = await deps.facts.get(input.scope, outcomeKey) as AgentOutcomeFact | null;
  if (recorded !== null) return agentResult(recorded);
  const contextPackRef = await deps.facts.get(input.scope, { attemptId: input.attemptId, kind: 'context-pack' }) as ArtifactRef | null;
  if (contextPackRef === null) throw new OrchestrationContractError(`attempt ${input.attemptId} has no stored inputs`);
  const { capability } = await workspaceOf(deps, input);
  await checkFence(deps, input, ctx, 'the agent');
  // Claim the attempt's one agent run before starting it.
  const claim = await deps.facts.putOnce(input.scope, { attemptId: input.attemptId, kind: 'agent-started', value: { at: ctx.logicalNow } });
  if (!claim.created) {
    const late = await deps.facts.get(input.scope, outcomeKey) as AgentOutcomeFact | null;
    if (late !== null) return agentResult(late);
    throw new AgentRedeliveryError(input.attemptId);
  }
  const alive = keepAlive(deps, input, ctx, 'agent');
  const started = deps.monotonicMs();
  let observation: AgentAttemptObservation;
  try {
    observation = (await boundaryObserver(deps, input)(
      { span: 'agent.invoke', action: 'agent.invoke', detail: { providerId: deps.implementer.providerId } },
      () => agentStep({
        provider: deps.providerFor({ scope: input.scope }),
        attemptId: input.attemptId,
        workOrderRef: input.workOrderRef,
        contextPackRef,
        workspace: capability,
        budget: input.budget,
        toolPolicy: deps.toolPolicy,
        signal: alive.signal,
      }),
    )).observation;
  } finally {
    alive.stop();
  }
  if (alive.lost() !== null) throw alive.lost();
  if (ctx.signal.aborted) throw new ActivityCancelledError('recording the agent outcome');
  const failureClass = observation.status === 'FAILED' || observation.status === 'BLOCKED'
    ? (deps.classifyAgent ?? defaultAgentFailureClass)(observation)
    : null;
  const fact: AgentOutcomeFact = {
    status: observation.status,
    reportedCostUsd: observation.usage.modelCostUsd,
    reportedToolCalls: observation.usage.toolCalls,
    wallClockMs: Math.max(0, Math.ceil(deps.monotonicMs() - started)),
    failureClass,
    inputTokens: observation.usage.inputTokens,
    outputTokens: observation.usage.outputTokens,
  };
  const stored = await deps.facts.putOnce(input.scope, { ...outcomeKey, value: fact });
  return agentResult(stored.value as AgentOutcomeFact);
}

function agentResult(f: AgentOutcomeFact): RunAgentResult {
  return {
    status: f.status,
    reportedCostUsd: f.reportedCostUsd,
    reportedToolCalls: f.reportedToolCalls,
    wallClockMs: f.wallClockMs,
    failureClass: f.failureClass,
  };
}

// --- inspectWorkspace ----------------------------------------------------------------

export async function inspectWorkspace(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity, ctx: ActivityExecutionContext,
): Promise<{ readonly overstep: boolean }> {
  throwIfCancelled(ctx, 'the inspection');
  const git = await gitOf(deps, input);
  const { capability } = await workspaceOf(deps, input);
  const inspected = await inspectStep({ inspector: git.inspector, scope: input.scope, workspace: capability });
  return { overstep: inspected.status === 'STOP' };
}

// --- runVerification ------------------------------------------------------------------

/** A check of the workflow input: an approved command id, never a command string. */
export interface VerificationCheckRef {
  readonly id: string;
  readonly level: AssuranceLevel;
  readonly category: VerificationCheckSpec['category'];
  readonly mandatory: boolean;
  readonly commandId: string;
}

export interface RunVerificationInput extends LeasedAttemptIdentity {
  readonly planId: string;
  readonly checks: readonly VerificationCheckRef[];
}

/** What verification found, recorded once: the change it verified and every check's execution. */
export interface VerificationFact {
  readonly planId: string;
  readonly risk: RiskLevel;
  readonly verdict: 'PASS' | 'FAIL' | 'ERROR';
  readonly change: GitChangeObservation;
  readonly executions: readonly VerificationCheckExecution[];
}

export async function runVerification(
  deps: OrchestrationActivityDeps, input: RunVerificationInput, ctx: ActivityExecutionContext,
): Promise<{ readonly verdict: 'PASS' | 'FAIL' | 'ERROR' }> {
  const key = { attemptId: input.attemptId, kind: 'verification' as const };
  const recorded = await deps.facts.get(input.scope, key) as VerificationFact | null;
  if (recorded !== null) return { verdict: recorded.verdict };
  const git = await gitOf(deps, input);
  const { record, capability } = await workspaceOf(deps, input);
  // The trusted change this verification is about, read before any check runs.
  const change = (await inspectStep({ inspector: git.inspector, scope: input.scope, workspace: capability })).change;
  // The workflow carries check ids; the trusted catalog resolves each to its command, inside the activity.
  const checks: VerificationCheckSpec[] = [];
  for (const c of input.checks) {
    const command = await deps.catalog.resolve(input.scope, {
      repositoryBindingId: input.repositoryBindingId, commandId: c.commandId, workspaceId: record.workspaceId,
    });
    checks.push({ id: c.id, level: c.level, category: c.category, mandatory: c.mandatory, command });
  }
  // A container an earlier delivery left running is removed before this one starts its own.
  await deps.reaper.reap(input.scope, { attemptId: input.attemptId, role: 'verify' });
  const wtPath = await git.pathOf(record.workspaceId);
  await checkFence(deps, input, ctx, 'the verification');
  const alive = keepAlive(deps, input, ctx, 'verify');
  let verify: Awaited<ReturnType<typeof verifyStep>>;
  try {
    verify = await verifyStep({
      runner: deps.runnerFor({ scope: input.scope }),
      sandbox: deps.sandbox,
      mount: {
        workspaceId: record.workspaceId,
        readOnlyPaths: [],
        writablePaths: [wtPath],
        readOnlyOverlayPaths: [`${wtPath}/.git`],
        attemptId: input.attemptId,
      },
      planId: input.planId,
      risk: input.risk,
      checks,
      signal: alive.signal,
      observe: boundaryObserver(deps, input),
    });
  } finally {
    alive.stop();
  }
  if (alive.lost() !== null) throw alive.lost();
  // A cancelled run's verdict says nothing about the change: it is never recorded.
  if (ctx.signal.aborted) throw new ActivityCancelledError('recording the verification');
  const fact: VerificationFact = { planId: input.planId, risk: input.risk, verdict: verify.result.verdict, change, executions: verify.executions };
  const stored = await deps.facts.putOnce(input.scope, { ...key, value: fact });
  return { verdict: (stored.value as VerificationFact).verdict };
}

// --- commitAttempt, persistEvidence -------------------------------------------------------

export interface CommitAttemptInput extends LeasedAttemptIdentity {
  /** The commit's parent: the task base, or the repair base for a repair attempt. */
  readonly expectedHeadSha: string;
  /** The task's work order: its allowed paths bound the commit. */
  readonly workOrderRef: ArtifactRef;
}

const COMMIT_KEY = 'commit' as const;

/** The attempt's recorded commit, or null while it has none. */
export async function recordedCommit(deps: OrchestrationActivityDeps, input: AttemptActivityIdentity): Promise<CommitResultRef | null> {
  const record = await deps.sideEffects.find(input.scope, {
    operation: COMMIT_KEY, repositoryBindingId: input.repositoryBindingId, attemptId: input.attemptId,
  });
  return record !== null && record.state === 'COMPLETED' ? parseSideEffectResultRef(record.resultRef, 'commit') : null;
}

export async function commitAttempt(
  deps: OrchestrationActivityDeps, input: CommitAttemptInput, ctx: ActivityExecutionContext,
): Promise<{ readonly resultSha: string }> {
  const git = await gitOf(deps, input);
  const log = auditedLog(deps, input, ctx);
  const committer = guardedCommitter(git.committer, ctx);
  const observe = fencedBy(boundaryObserver(deps, input), () => deps.leases.heartbeat(input.scope, input.fence.leaseId));
  const common = {
    committer, log, scope: input.scope, repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId, baseSha: input.expectedHeadSha, leaseId: input.fence.leaseId,
  };
  // A commit of this attempt already begun is settled first: adopted when it landed, so no evidence id is
  // reserved for a commit that will never be made.
  const begun = await deps.sideEffects.find(input.scope, {
    operation: COMMIT_KEY, repositoryBindingId: input.repositoryBindingId, attemptId: input.attemptId,
  });
  if (begun !== null) {
    const settled = await settleCommitStep(common);
    if (settled !== null) return { resultSha: settled.commitSha };
  }
  const verification = await deps.facts.get(input.scope, { attemptId: input.attemptId, kind: 'verification' }) as VerificationFact | null;
  if (verification === null || verification.verdict !== 'PASS') {
    throw new OrchestrationContractError(`attempt ${input.attemptId} has no passed verification to commit`);
  }
  const { capability } = await workspaceOf(deps, input);
  const allowedPaths = await workOrderAllowedPaths(deps, input);
  throwIfCancelled(ctx, 'reserving the evidence');
  // The evidence is fixed before the commit, timed at the workflow's logical time: a redelivery that has to
  // reserve again reserves the same bytes.
  const evidenceId = await deps.evidence.reserveEvidence(input.scope, {
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    draft: evidenceDraft({
      taskId: input.taskId,
      attemptId: input.attemptId,
      baseSha: input.expectedHeadSha,
      change: verification.change,
      environment: deps.environment,
      executions: verification.executions,
      createdAt: ctx.logicalNow,
    }),
  });
  const commit = await observe(
    { span: 'git.commit', action: 'git.commit', detail: { baseSha: input.expectedHeadSha } },
    () => commitStep({ ...common, workspace: capability, allowedPaths, evidenceId, identity: deps.commitIdentity }),
  );
  return { resultSha: commit.commitSha };
}

async function workOrderAllowedPaths(deps: OrchestrationActivityDeps, input: CommitAttemptInput): Promise<readonly string[]> {
  const stream = await deps.artifacts.get(input.scope, input.workOrderRef);
  const order = JSON.parse(new TextDecoder().decode(stream.content)) as { readonly allowedPaths?: unknown };
  if (!Array.isArray(order.allowedPaths) || !order.allowedPaths.every((p) => typeof p === 'string')) {
    throw new OrchestrationContractError('the work order names no allowed paths');
  }
  return order.allowedPaths as string[];
}

export async function persistEvidence(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity & { readonly baseSha: string },
): Promise<{ readonly evidenceId: string }> {
  const commit = await recordedCommit(deps, input);
  if (commit === null) throw new OrchestrationContractError(`attempt ${input.attemptId} has no recorded commit`);
  const evidence = await boundaryObserver(deps, input)(
    { span: 'artifact.put', action: 'evidence.put', detail: { evidenceId: commit.evidenceId } },
    () => evidenceStep({
      store: deps.evidence,
      scope: input.scope,
      evidenceId: commit.evidenceId as ArtifactId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      baseSha: input.baseSha,
      resultSha: commit.commitSha,
    }),
  );
  return { evidenceId: evidence.ref.artifactId };
}

// --- reap, quarantine, cleanup ------------------------------------------------------------

export async function reapContainers(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity,
): Promise<Record<string, never>> {
  await deps.reaper.reap(input.scope, { attemptId: input.attemptId });
  return {};
}

export async function quarantineWorkspace(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity & { readonly reason: string }, ctx: ActivityExecutionContext,
): Promise<Record<string, never>> {
  const record = await deps.workspaceRegistry.findByAttempt(input.scope, input.attemptId);
  // No workspace was ever made, or it is already quarantined: nothing to do.
  if (record === null || record.state === 'QUARANTINED') return {};
  const git = await gitOf(deps, input);
  await git.workspaces.quarantine(input.scope, record.workspaceId, input.reason);
  await deps.audit.record(input.scope, {
    key: `${input.attemptId}:workspace.quarantine`,
    event: {
      actor: deps.actor,
      action: 'workspace.quarantine',
      context: correlationOf(input, input.attemptId),
      occurredAt: ctx.logicalNow,
      detail: { workspaceId: record.workspaceId, reason: input.reason },
    },
  });
  return {};
}

export async function cleanupWorkspace(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity,
): Promise<Record<string, never>> {
  const record = await deps.workspaceRegistry.findByAttempt(input.scope, input.attemptId);
  if (record === null || record.state === 'CLEANED' || record.state === 'QUARANTINED') return {};
  const git = await gitOf(deps, input);
  await git.workspaces.cleanup(input.scope, record.workspaceId);
  return {};
}
