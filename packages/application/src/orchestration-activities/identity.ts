// The identity every orchestration activity is called with, and the errors the
// activities define.
//
// The workflow carries ids, hashes, refs, numbers and closed enums only. It
// hands each activity the task's scope and identity, and for an attempt-bound
// activity the attempt's id, number and branch; for an activity that acts under
// the attempt's workspace lease, the caller's fence on it as acquireLease or
// findLease returned it.

import type {
  AttemptId, RepositoryBindingId, RiskLevel, RunId, TaskId, TenantScope,
} from '@asep/contracts';
import type { AttemptRef } from '@asep/ports';
import type { CorrelationContext } from '@asep/observability';
import type { AssuranceFence } from '../review-loop/slot.js';

export interface TaskActivityIdentity {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly risk: RiskLevel;
  /** `asep-task-<taskId>`. */
  readonly workflowId: string;
}

export interface AttemptActivityIdentity extends TaskActivityIdentity {
  readonly attemptNumber: number;
  readonly attemptId: AttemptId;
  /** The attempt's remote branch, as ensureAttempt returned it. */
  readonly branch: string;
}

export interface LeasedAttemptIdentity extends AttemptActivityIdentity {
  /** The caller's fence on the attempt's workspace lease. */
  readonly fence: AssuranceFence;
}

export function attemptRefOf(a: AttemptActivityIdentity): AttemptRef {
  return { repositoryBindingId: a.repositoryBindingId, runId: a.runId, taskId: a.taskId, attemptId: a.attemptId };
}

/** The attempt's natural key, rendered for an operator: `<taskId>:attempt:<n>`. */
export function attemptIdempotencyKey(taskId: TaskId, attemptNumber: number): string {
  return `${taskId}:attempt:${attemptNumber}`;
}

/** The correlation identity of an activity's spans and audit rows. */
export function correlationOf(
  t: Pick<TaskActivityIdentity, 'scope' | 'repositoryBindingId' | 'runId' | 'workflowId'> & { readonly taskId: TaskId | null },
  attemptId: AttemptId | null,
): CorrelationContext {
  return {
    traceId: t.workflowId,
    tenantId: t.scope.organizationId,
    projectId: t.scope.projectId,
    organizationId: t.scope.organizationId,
    repositoryBindingId: t.repositoryBindingId,
    runId: t.runId,
    ...(t.taskId !== null ? { taskId: t.taskId } : {}),
    ...(attemptId !== null ? { attemptId } : {}),
  };
}

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * USD as integer micro-USD, rounded up, so a fraction of a micro-dollar is never rounded away. It reads the
 * number's shortest decimal form, as the decision core does, rather than multiplying binary floating point, so
 * the amounts the workflow hands over (whole micro-dollars) convert back exactly. Throws for a negative,
 * non-finite or unrepresentably large amount.
 */
export function toMicroUsd(usd: number): number {
  const match = Number.isFinite(usd) && usd >= 0 ? DECIMAL.exec(String(usd)) : null;
  if (match === null) throw new RangeError(`not a money amount: ${usd}`);
  const integer = match[1]!;
  const digits = integer + (match[2] ?? '');
  const cut = integer.length + Number(match[3] ?? '0') + 6;
  if (cut <= 0) return /[1-9]/.test(digits) ? 1 : 0;
  const whole = cut >= digits.length ? digits + '0'.repeat(cut - digits.length) : digits.slice(0, cut);
  const micros = Number(whole) + (/[1-9]/.test(digits.slice(cut)) ? 1 : 0);
  if (!Number.isSafeInteger(micros)) throw new RangeError(`not a money amount: ${usd}`);
  return micros;
}

// --- errors ----------------------------------------------------------------------

/**
 * The agent of this attempt was started by an earlier delivery that left no outcome. The agent mutates a worktree
 * and spends money, so it never runs twice for one attempt: the workflow replaces the attempt instead. Not retryable.
 */
export class AgentRedeliveryError extends Error {
  constructor(attemptId: string) {
    super(`the agent of attempt ${attemptId} was already started by an earlier delivery and left no outcome`);
    this.name = 'AgentRedeliveryError';
  }
}

/**
 * The workflow asked for something outside the activities' contract: an audit action outside the closed set, a
 * run event detail the run-event contract has no field for, a step whose prerequisite fact is missing. A defect of
 * the caller, never transient. Not retryable.
 */
export class OrchestrationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestrationContractError';
  }
}
