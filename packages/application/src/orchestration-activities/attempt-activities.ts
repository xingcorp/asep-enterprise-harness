// Attempt registration, lease settlement and attempt terminals.
//
//   admitTask              the admission hook, or admitRisk
//   ensureAttempt          idempotent registration on (task, attempt number); returns the attempt branch
//   findAttempt            read-only lookup after a failed registration
//   acquireLease           the caller's fence on the workspace lease primitive
//   findLease              read-only lookup of the attempt's lease history after a failed or aborted acquisition
//   recordPreLeaseOutcome  the terminal of an attempt that never held a lease (fence null)
//   recordAttemptOutcome   the terminal of an attempt, with the caller's fence, before its lease is released
//   releaseLease           the release, presenting the caller's fence
//   renewLease             the primitive's renewal

import type { ActivityExecutionContext } from '@asep/ports';
import type { ArtifactRef, AttemptId } from '@asep/contracts';
import { admitRisk } from '../risk-admission.js';
import {
  REVIEW_LOOP_SLOT_VERSION,
  type AssuranceFence,
  type AttemptOutcomeFields,
  type AttemptTerminal,
  type PreLeaseAttemptTerminal,
} from '../review-loop/slot.js';
import { recordPreLeaseOutcome as recordPreLease } from './pre-lease-outcome.js';
import { assuranceStepContext, throwIfCancelled } from './context.js';
import type { OrchestrationActivityDeps } from './deps.js';
import {
  attemptRefOf,
  type AttemptActivityIdentity,
  type LeasedAttemptIdentity,
  type TaskActivityIdentity,
} from './identity.js';
import type { AttemptKind } from './ports.js';

/** A lease the primitive denied, when the attempt's own history shows none: retryable, then settled by findLease. */
export class LeaseDeniedError extends Error {
  constructor(attemptId: string, reason: string) {
    super(`the workspace lease of attempt ${attemptId} was denied: ${reason}`);
    this.name = 'LeaseDeniedError';
  }
}

export async function admitTask(
  deps: OrchestrationActivityDeps, input: TaskActivityIdentity,
): Promise<{ readonly admitted: boolean; readonly reason: string }> {
  const admission = (deps.admit ?? admitRisk)(input.risk);
  return { admitted: admission.admitted, reason: admission.decision };
}

export interface EnsureAttemptInput extends TaskActivityIdentity {
  readonly attemptNumber: number;
  readonly attemptKind: AttemptKind;
  readonly baseSha: string;
  readonly parentAttemptNumber: number | null;
  readonly repairOrderRef: ArtifactRef | null;
}

export async function ensureAttempt(
  deps: OrchestrationActivityDeps, input: EnsureAttemptInput,
): Promise<{ readonly attemptId: AttemptId; readonly branch: string }> {
  const { attemptId } = await deps.attempts.ensure(input.scope, {
    runId: input.runId,
    taskId: input.taskId,
    repositoryBindingId: input.repositoryBindingId,
    attemptNumber: input.attemptNumber,
    kind: input.attemptKind,
    baseSha: input.baseSha,
    parentAttemptNumber: input.parentAttemptNumber,
    repairOrderRef: input.repairOrderRef,
  });
  return { attemptId, branch: deps.branchFor({ runId: input.runId, taskId: input.taskId, attemptId }) };
}

export async function findAttempt(
  deps: OrchestrationActivityDeps, input: TaskActivityIdentity & { readonly attemptNumber: number },
): Promise<{ readonly attemptId: AttemptId | null }> {
  return { attemptId: await deps.attempts.find(input.scope, { taskId: input.taskId, attemptNumber: input.attemptNumber }) };
}

export async function acquireLease(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity, ctx: ActivityExecutionContext,
): Promise<{ readonly fence: AssuranceFence }> {
  throwIfCancelled(ctx, 'the lease acquisition');
  const attempt = attemptRefOf(input);
  const lease = await deps.leases.acquire(input.scope, { attempt, branch: input.branch, ttlMs: deps.leaseTtlMs });
  if (!('denied' in lease)) return { fence: { leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch } };
  // A grant an earlier delivery of this acquisition committed holds the branch, so the primitive denies a second
  // one; the attempt's history shows it, and it is this caller's lease.
  const held = await deps.leases.findByAttempt(input.scope, attempt);
  if (held !== null) return { fence: { leaseId: held.leaseId, fencingEpoch: held.fencingEpoch } };
  throw new LeaseDeniedError(input.attemptId, lease.reason);
}

export async function findLease(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity,
): Promise<{ readonly fence: AssuranceFence | null }> {
  const held = await deps.leases.findByAttempt(input.scope, attemptRefOf(input));
  return { fence: held === null ? null : { leaseId: held.leaseId, fencingEpoch: held.fencingEpoch } };
}

/** The facts of a terminal only the workflow knows, under the slot's attempt-outcome names. */
export interface AttemptOutcomeFacts {
  readonly round: number;
  readonly declaredComplete: boolean;
  readonly verificationVerdict: 'PASS' | 'FAIL' | 'ERROR' | null;
  readonly adjudicationId: string | null;
  readonly failureClass: string | null;
}

export interface PreLeaseOutcomeActivityInput extends AttemptActivityIdentity, AttemptOutcomeFacts {
  readonly terminal: PreLeaseAttemptTerminal;
}

export async function recordPreLeaseOutcome(
  deps: OrchestrationActivityDeps, input: PreLeaseOutcomeActivityInput, ctx: ActivityExecutionContext,
): Promise<{ readonly recorded: boolean }> {
  return recordPreLease(deps.slot, {
    ...outcomeFields(input, false, null),
    terminal: input.terminal,
    fence: null,
  }, assuranceStepContext(ctx));
}

export interface AttemptOutcomeActivityInput extends AttemptActivityIdentity, AttemptOutcomeFacts {
  readonly assuranceUnavailable: boolean;
  /** The agent's reported model cost in integer micro-USD, rounded up once by the workflow; null when none. */
  readonly modelCostMicroUsd: number | null;
  readonly terminal: AttemptTerminal;
  /** The caller's fence of the lease the attempt holds or held; null only for an attempt that never held one. */
  readonly fence: AssuranceFence | null;
}

/**
 * The attempt's terminal through the slot, before its lease is released. Token and tool-call counts come from the
 * agent's recorded outcome, a set-once fact, so a redelivery presents the same input.
 */
export async function recordAttemptOutcome(
  deps: OrchestrationActivityDeps, input: AttemptOutcomeActivityInput, ctx: ActivityExecutionContext,
): Promise<Record<string, never>> {
  const usage = await deps.facts.get(input.scope, { attemptId: input.attemptId, kind: 'agent-outcome' }) as AgentUsageFact | null;
  const fields = outcomeFields(input, input.assuranceUnavailable, usage === null && input.modelCostMicroUsd === null ? null : {
    modelCostMicroUsd: input.modelCostMicroUsd,
    computeCostMicroUsd: null,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    toolCalls: usage?.reportedToolCalls ?? 0,
  });
  const step = assuranceStepContext(ctx);
  if (input.fence === null) {
    if (input.terminal !== 'cancelled' && input.terminal !== 'infrastructure-failed') {
      throw new RangeError(`an attempt that never held a lease ends cancelled or infrastructure-failed, not ${input.terminal}`);
    }
    await deps.slot.recordAttemptOutcome({ ...fields, terminal: input.terminal, fence: null }, step);
  } else {
    await deps.slot.recordAttemptOutcome({ ...fields, terminal: input.terminal, fence: input.fence }, step);
  }
  return {};
}

/** What the agent activity records about its usage, read back for the attempt's terminal. */
export interface AgentUsageFact {
  readonly reportedToolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function outcomeFields(
  input: AttemptActivityIdentity & AttemptOutcomeFacts,
  assuranceUnavailable: boolean,
  cost: AttemptOutcomeFields['cost'],
): AttemptOutcomeFields {
  return {
    slotVersion: REVIEW_LOOP_SLOT_VERSION,
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    risk: input.risk,
    round: input.round,
    declaredComplete: input.declaredComplete,
    verificationVerdict: input.verificationVerdict,
    adjudicationId: input.adjudicationId,
    assuranceUnavailable,
    failureClass: input.failureClass,
    cost,
  };
}

export async function releaseLease(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity,
): Promise<Record<string, never>> {
  await deps.leases.release(input.scope, input.fence.leaseId);
  return {};
}

export async function renewLease(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity, ctx: ActivityExecutionContext,
): Promise<Record<string, never>> {
  throwIfCancelled(ctx, 'the lease renewal');
  await deps.leases.heartbeat(input.scope, input.fence.leaseId);
  return {};
}
