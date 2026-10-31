// The bookkeeping activities: projection, budget ledger, approvals, controls,
// workflow-detected audits and run events. Each write is idempotent by a key the
// workflow supplies, so a redelivery writes nothing new:
//
//   projectTaskState        monotonic projection_seq, owned by one workflow
//   recordUsage / recordOverrun / recordExtension
//                           ledger keys <attemptId>:attempt-usage, <attemptId>:overrun,
//                           <approvalRequestId>:extension
//   open / verify / expire / cancel approval request
//                           the request id <workflowId>:<gateSeq>; a decision is
//                           released only when PostgreSQL holds it
//   recordControl           the control's request id
//   recordAudit             the key the workflow gives (<workflowId>:<seq>)
//   emitRunEvent            event id <workflowId>:<eventSeq>, timed at the
//                           execution's logical time, so a redelivery is
//                           byte-identical and the sink appends nothing

import type { AttemptId, RunEvent, RunId, TaskId } from '@asep/contracts';
import type { ActivityExecutionContext } from '@asep/ports';
import { isOrchestrationAuditAction, type OrchestrationAuditAction } from '@asep/observability';
import type { OrchestrationActivityDeps } from './deps.js';
import {
  OrchestrationContractError, correlationOf, toMicroUsd,
  type AttemptActivityIdentity, type TaskActivityIdentity,
} from './identity.js';
import type { ApprovalKind } from './ports.js';

type Empty = Record<string, never>;

// --- projection ------------------------------------------------------------------

export async function projectTaskState(
  deps: OrchestrationActivityDeps, input: TaskActivityIdentity & { readonly projectionSeq: number; readonly status: string },
): Promise<Empty> {
  await deps.projection.projectTask(input.scope, {
    taskId: input.taskId, workflowId: input.workflowId, projectionSeq: input.projectionSeq, status: input.status,
  });
  return {};
}

// --- budget ledger -----------------------------------------------------------------

export interface RecordUsageInput extends AttemptActivityIdentity {
  /** Agent cost plus, once verification ran, the verification reserve. */
  readonly chargedCostUsd: number;
  readonly reportedCostUsd: number | null;
  readonly verificationReserveUsd: number;
  readonly chargedWallClockMinutes: number;
}

export async function recordUsage(deps: OrchestrationActivityDeps, input: RecordUsageInput): Promise<Empty> {
  // The tool calls come from the agent's recorded outcome, a set-once fact: every delivery writes the same entry.
  const agent = await deps.facts.get(input.scope, { attemptId: input.attemptId, kind: 'agent-outcome' }) as { readonly reportedToolCalls: number } | null;
  await deps.ledger.append(input.scope, {
    idempotencyKey: `${input.attemptId}:attempt-usage`,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    entryKind: 'attempt-usage',
    // A usable reported cost is the provider's; otherwise the harness charged the attempt's full cap.
    source: input.reportedCostUsd === null ? 'harness-measured' : 'provider-reported',
    amountMicroUsd: toMicroUsd(input.chargedCostUsd),
    toolCalls: agent?.reportedToolCalls ?? 0,
    wallClockMs: input.chargedWallClockMinutes * 60_000,
    usageOutOfBound: false,
  });
  return {};
}

export interface RecordOverrunInput extends AttemptActivityIdentity {
  readonly overrunUsd: number;
  readonly overrunToolCalls: number;
  readonly overrunWallClockMs: number;
  readonly usageOutOfBound: boolean;
}

export async function recordOverrun(deps: OrchestrationActivityDeps, input: RecordOverrunInput): Promise<Empty> {
  await deps.ledger.append(input.scope, {
    idempotencyKey: `${input.attemptId}:overrun`,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    entryKind: 'overrun',
    source: 'harness-measured',
    amountMicroUsd: toMicroUsd(input.overrunUsd),
    toolCalls: input.overrunToolCalls,
    wallClockMs: input.overrunWallClockMs,
    usageOutOfBound: input.usageOutOfBound,
  });
  return {};
}

export async function recordExtension(
  deps: OrchestrationActivityDeps,
  input: TaskActivityIdentity & { readonly approvalRequestId: string; readonly extensionUsd: number; readonly principalId: string },
  ctx: ActivityExecutionContext,
): Promise<Empty> {
  await deps.ledger.append(input.scope, {
    idempotencyKey: `${input.approvalRequestId}:extension`,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: null,
    entryKind: 'extension-granted',
    source: 'human-granted',
    amountMicroUsd: toMicroUsd(input.extensionUsd),
    toolCalls: 0,
    wallClockMs: 0,
    usageOutOfBound: false,
  });
  await audit(deps, input, null, ctx, `${input.approvalRequestId}:budget.extend`, 'budget.extend', input.principalId, {
    approvalRequestId: input.approvalRequestId, extensionUsd: input.extensionUsd,
  });
  return {};
}

// --- approvals ------------------------------------------------------------------------

export interface OpenApprovalRequestInput extends TaskActivityIdentity {
  readonly approvalRequestId: string;
  readonly approvalKind: ApprovalKind;
  readonly attemptId: AttemptId | null;
  readonly ttlSeconds: number;
  readonly shortfallUsd: number | null;
  /** The principal who submitted the task: never allowed to decide its own approval. */
  readonly requestedBy: string;
}

export async function openApprovalRequest(
  deps: OrchestrationActivityDeps, input: OpenApprovalRequestInput, ctx: ActivityExecutionContext,
): Promise<Empty> {
  // The expiry is the workflow's logical time plus the TTL, so a redelivery opens the same request.
  const expiresAt = new Date(Date.parse(ctx.logicalNow) + input.ttlSeconds * 1000).toISOString();
  await deps.approvals.open(input.scope, {
    approvalRequestId: input.approvalRequestId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.approvalKind,
    requestedBy: input.requestedBy,
    expiresAt,
    shortfallMicroUsd: input.shortfallUsd === null ? null : toMicroUsd(input.shortfallUsd),
  });
  await audit(deps, input, input.attemptId, ctx, `${input.approvalRequestId}:approval.request`, 'approval.request', deps.actor, {
    approvalRequestId: input.approvalRequestId, approvalKind: input.approvalKind, expiresAt,
  });
  return {};
}

export async function verifyApprovalDecision(
  deps: OrchestrationActivityDeps, input: TaskActivityIdentity & { readonly approvalRequestId: string; readonly decisionId: string },
): Promise<{ readonly verified: boolean; readonly decision: 'approve' | 'reject' | null; readonly extensionUsd: number | null }> {
  const found = await deps.approvals.findDecision(input.scope, { approvalRequestId: input.approvalRequestId, decisionId: input.decisionId });
  if (found === null) return { verified: false, decision: null, extensionUsd: null };
  return { verified: true, decision: found.decision, extensionUsd: found.extensionUsd };
}

export async function expireApprovalRequest(
  deps: OrchestrationActivityDeps, input: TaskActivityIdentity & { readonly approvalRequestId: string }, ctx: ActivityExecutionContext,
): Promise<Empty> {
  await deps.approvals.close(input.scope, { approvalRequestId: input.approvalRequestId, status: 'EXPIRED' });
  await audit(deps, input, null, ctx, `${input.approvalRequestId}:approval.expire`, 'approval.expire', deps.actor, {
    approvalRequestId: input.approvalRequestId,
  });
  return {};
}

export async function cancelApprovalRequest(
  deps: OrchestrationActivityDeps, input: TaskActivityIdentity & { readonly approvalRequestId: string },
): Promise<Empty> {
  await deps.approvals.close(input.scope, { approvalRequestId: input.approvalRequestId, status: 'CANCELLED' });
  return {};
}

// --- controls, audits ----------------------------------------------------------------------

/** A run-level activity: the run's workflow has no task. */
export interface RunOrTaskIdentity extends Omit<TaskActivityIdentity, 'taskId' | 'risk'> {
  readonly taskId: TaskId | null;
}

export interface RecordControlInput extends RunOrTaskIdentity {
  readonly requestId: string;
  readonly control: 'pause' | 'resume' | 'cancel' | 'seal';
  readonly principalId: string;
}

const CONTROL_ACTION: Readonly<Record<RecordControlInput['control'], OrchestrationAuditAction>> = {
  pause: 'workflow.pause', resume: 'workflow.resume', cancel: 'workflow.cancel', seal: 'workflow.seal',
};

/** An accepted control: its audit row and its human.intervention run event, both keyed by the control's request. */
export async function recordControl(
  deps: OrchestrationActivityDeps, input: RecordControlInput, ctx: ActivityExecutionContext,
): Promise<Empty> {
  const key = `${input.workflowId}:control:${input.requestId}`;
  await audit(deps, input, null, ctx, key, CONTROL_ACTION[input.control], input.principalId, { requestId: input.requestId });
  await deps.runEvents.append(input.scope, {
    eventId: key,
    eventType: 'human.intervention',
    occurredAt: ctx.logicalNow,
    runId: input.runId,
    ...(input.taskId !== null ? { taskId: input.taskId } : {}),
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    repositoryBindingId: input.repositoryBindingId,
    workflowId: input.workflowId,
    interventionKind: input.control,
  });
  return {};
}

export interface RecordAuditInput extends RunOrTaskIdentity {
  readonly attemptId: AttemptId | null;
  /** Unique within the workflow (`<workflowId>:<seq>`). */
  readonly key: string;
  readonly action: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/** A workflow-detected event's audit row. The action must be one of the closed orchestration set. */
export async function recordAudit(
  deps: OrchestrationActivityDeps, input: RecordAuditInput, ctx: ActivityExecutionContext,
): Promise<Empty> {
  if (!isOrchestrationAuditAction(input.action)) {
    throw new OrchestrationContractError(`audit action ${JSON.stringify(input.action)} is not an orchestration audit action`);
  }
  await audit(deps, input, input.attemptId, ctx, input.key, input.action, deps.actor, input.detail);
  return {};
}

async function audit(
  deps: OrchestrationActivityDeps,
  input: RunOrTaskIdentity | TaskActivityIdentity,
  attemptId: AttemptId | null,
  ctx: ActivityExecutionContext,
  key: string,
  action: OrchestrationAuditAction,
  actor: string,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  await deps.audit.record(input.scope, {
    key,
    event: { actor, action, context: correlationOf(input, attemptId), occurredAt: ctx.logicalNow, detail },
  });
}

// --- run events ------------------------------------------------------------------------------

/** The run events the workflows emit themselves; the slot emits the attempt and repair events. */
export type WorkflowRunEventType =
  | 'run.started' | 'run.completed' | 'task.started' | 'task.completed' | 'attempt.started'
  | 'workflow.recovered' | 'approval.requested' | 'approval.expired' | 'budget.threshold_crossed';

const WORKFLOW_EVENT_TYPES: readonly WorkflowRunEventType[] = [
  'run.started', 'run.completed', 'task.started', 'task.completed', 'attempt.started',
  'workflow.recovered', 'approval.requested', 'approval.expired', 'budget.threshold_crossed',
];

/** The decision core's outcome names, in the run-event contract's outcome vocabulary. */
const EVENT_OUTCOME: Readonly<Record<string, NonNullable<RunEvent['outcome']>>> = {
  WAITING_FOR_HUMAN_REVIEW: 'succeeded',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  BUDGET_EXHAUSTED: 'failed',
  CANCELLED: 'cancelled',
};

/** Detail keys the run-event contract carries as they are. */
const PASSED_THROUGH = ['workflowId', 'repairCycles', 'recoveryKind', 'approvalKind', 'budgetScope', 'thresholdKind'] as const;

export interface EmitRunEventInput extends RunOrTaskIdentity {
  readonly risk: TaskActivityIdentity['risk'] | null;
  readonly eventSeq: number;
  readonly eventType: string;
  readonly attemptId: AttemptId | null;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/** The run event of a workflow event, in the run-event contract; throws for a type or detail it has no field for. */
export function workflowRunEvent(input: EmitRunEventInput, occurredAt: string): RunEvent {
  if (!WORKFLOW_EVENT_TYPES.includes(input.eventType as WorkflowRunEventType)) {
    throw new OrchestrationContractError(`run event type ${JSON.stringify(input.eventType)} is not one the workflow emits`);
  }
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input.detail)) {
    if (key === 'outcome') {
      const outcome = EVENT_OUTCOME[String(value)];
      if (outcome === undefined) throw new OrchestrationContractError(`run event outcome ${JSON.stringify(value)} has no contract name`);
      fields['outcome'] = outcome;
    } else if ((PASSED_THROUGH as readonly string[]).includes(key)) {
      fields[key] = value;
    } else {
      throw new OrchestrationContractError(`run event detail ${JSON.stringify(key)} has no run-event field`);
    }
  }
  return {
    eventId: `${input.workflowId}:${input.eventSeq}`,
    eventType: input.eventType as RunEvent['eventType'],
    occurredAt,
    runId: input.runId as RunId,
    ...(input.taskId !== null ? { taskId: input.taskId } : {}),
    ...(input.attemptId !== null ? { attemptId: input.attemptId } : {}),
    ...(input.risk !== null ? { risk: input.risk } : {}),
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    repositoryBindingId: input.repositoryBindingId,
    ...fields,
  } as RunEvent;
}

export async function emitRunEvent(
  deps: OrchestrationActivityDeps, input: EmitRunEventInput, ctx: ActivityExecutionContext,
): Promise<Empty> {
  await deps.runEvents.append(input.scope, workflowRunEvent(input, ctx.logicalNow));
  return {};
}
