// Approval requests, human decisions and the decision outbox (migration 0105).
//
// A workflow that needs a human's yes opens a request whose id it derives
// itself, <workflow id>:<gate number>, so a retried open finds its row: the same
// facts again are a no-op, other facts under that id ApprovalRequestConflictError.
//
// A decision is recorded in one transaction with its delivery row, under a lock
// on the request: at most one decision per request; an identical decision again
// returns the original and makes its delivery due again (a retried POST always
// re-delivers); another decision is ApprovalDecisionConflictError; a request that
// is no longer pending, or is past its expiry time, takes no decision
// (ApprovalRequestClosedError). The request then shows the decision. Expiry and
// cancellation close a pending request and leave a decided one as it is: the
// workflow's timer, not the expiry column, decides when a gate expired, and the
// recorded human decision is never rewritten.
//
// The delivery rows are the relay's: due rows across tenants, a failure with a
// closed error code (never a message) and a backoff, delivered, or target
// closed. A delivery leaves PENDING only to DELIVERED or TARGET_CLOSED, and only
// a retried decision makes a delivered row due again.

import type { AttemptId, OrganizationId, ProjectId, RunId, TaskId, TenantScope } from '@asep/contracts';
import type { ApprovalKind } from '@asep/ports';
import { ScopeViolationError, type SqlClient, type SqlExecutor, type SqlRow } from '../sql.js';
import { isUlid } from '../ulid.js';
import { isMicroUsd, microUsdOf, usdDecimal } from './money.js';

export type ApprovalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
export type ApprovalDecisionValue = 'approve' | 'reject';
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'TARGET_CLOSED';

export interface OpenApprovalRequestInput {
  /** `<workflowId>:<gate number>`. */
  readonly approvalRequestId: string;
  readonly workflowId: string;
  readonly runId: RunId;
  readonly taskId: TaskId | null;
  /** The attempt a publication approval is for; null for a budget extension. */
  readonly attemptId: AttemptId | null;
  readonly kind: ApprovalKind;
  /** The principal id, or 'harness' when the workflow asks on its own. */
  readonly requestedBy: string;
  /** A budget extension's task-cap shortfall in micro-USD; null for a publication approval. */
  readonly shortfallMicroUsd: number | null;
  readonly expiresAt: string;
}

export interface ApprovalRequestRecord extends OpenApprovalRequestInput {
  readonly status: ApprovalRequestStatus;
}

export interface RecordDecisionInput {
  readonly decisionId: string;
  readonly approvalRequestId: string;
  readonly decision: ApprovalDecisionValue;
  /** The authenticated human principal's id. */
  readonly decidedBy: string;
  /** Stays in PostgreSQL; never enters workflow history. */
  readonly rationale: string;
  /** Exactly on a budget-extension approve: the extension in micro-USD. */
  readonly extensionMicroUsd: number | null;
}

export interface ApprovalDecisionRecord extends RecordDecisionInput {
  readonly decidedAt: string;
}

export interface DeliveryRecord {
  readonly decisionId: string;
  readonly workflowId: string;
  readonly updateId: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastErrorCode: string | null;
  readonly deliveredAt: string | null;
}

export interface DueDelivery {
  readonly scope: TenantScope;
  readonly decisionId: string;
  readonly workflowId: string;
  readonly updateId: string;
  readonly attempts: number;
}

/** The request id is open already with other facts. Not retryable. */
export class ApprovalRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRequestConflictError';
  }
}

/** The request takes no decision: it is no longer pending, or it is past its expiry time. Not retryable. */
export class ApprovalRequestClosedError extends Error {
  constructor(readonly approvalRequestId: string, readonly status: ApprovalRequestStatus, readonly pastExpiry: boolean) {
    super(`approval request ${approvalRequestId} takes no decision: it is ${status}${pastExpiry ? ' and past its expiry time' : ''}`);
    this.name = 'ApprovalRequestClosedError';
  }
}

/** The request has another decision, or the decision id names another decision. Not retryable. */
export class ApprovalDecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDecisionConflictError';
  }
}

const GATE_NUMBER = /^[0-9]{1,18}$/;
const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS: readonly ApprovalKind[] = ['budget-extension', 'publish-change'];
const MAX_RETRY_AFTER_MS = 2_147_483_647;

const isId = (v: unknown): v is string => typeof v === 'string' && isUlid(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

function malformedRequest(input: OpenApprovalRequestInput): string | null {
  const wf = input.workflowId;
  if (typeof wf !== 'string' || wf.length === 0 || wf.length > 255) return 'the workflow id is empty or too long';
  const id = input.approvalRequestId;
  if (typeof id !== 'string' || !id.startsWith(`${wf}:`) || !GATE_NUMBER.test(id.slice(wf.length + 1))) {
    return 'the request id is not <workflow id>:<gate number>';
  }
  if (!isId(input.runId)) return 'the run id is not an id';
  if (input.taskId !== null && !isId(input.taskId)) return 'the task id is not an id';
  if (input.attemptId !== null && !isId(input.attemptId)) return 'the attempt id is not an id';
  if (input.attemptId !== null && input.taskId === null) return 'an attempt is named with its task';
  if (!KINDS.includes(input.kind)) return `kind ${String(input.kind)} is not one of ${KINDS.join(', ')}`;
  if (input.kind === 'budget-extension') {
    if (input.taskId === null) return 'a budget extension is a task\'s';
    if (!isMicroUsd(input.shortfallMicroUsd, true)) return 'a budget extension states its shortfall in positive micro-USD';
  } else {
    if (input.attemptId === null) return 'a publication approval is an attempt\'s';
    if (input.shortfallMicroUsd !== null) return 'a publication approval carries no amount';
  }
  if (input.requestedBy !== 'harness' && !isId(input.requestedBy)) return 'the requester is neither the harness nor a principal id';
  if (!isTime(input.expiresAt)) return 'the expiry is not a time';
  return null;
}

function toRequest(row: SqlRow): ApprovalRequestRecord {
  const payload = (typeof row['payload'] === 'string' ? JSON.parse(row['payload']) : row['payload']) as Record<string, unknown>;
  return {
    approvalRequestId: row['id'] as string,
    workflowId: row['workflow_id'] as string,
    runId: row['run_id'] as RunId,
    taskId: (row['task_id'] as TaskId | null) ?? null,
    attemptId: (row['attempt_id'] as AttemptId | null) ?? null,
    kind: row['kind'] as ApprovalKind,
    requestedBy: row['requested_by'] as string,
    shortfallMicroUsd: payload['shortfallMicroUsd'] === undefined ? null : Number(payload['shortfallMicroUsd']),
    expiresAt: iso(row['expires_at']),
    status: row['status'] as ApprovalRequestStatus,
  };
}

function sameRequest(a: OpenApprovalRequestInput, b: OpenApprovalRequestInput): boolean {
  return a.workflowId === b.workflowId && a.runId === b.runId && a.taskId === b.taskId && a.attemptId === b.attemptId
    && a.kind === b.kind && a.requestedBy === b.requestedBy && a.shortfallMicroUsd === b.shortfallMicroUsd
    && Date.parse(a.expiresAt) === Date.parse(b.expiresAt);
}

function toDecision(row: SqlRow): ApprovalDecisionRecord {
  const extension = row['extension_micro_usd'];
  return {
    decisionId: row['id'] as string,
    approvalRequestId: row['request_id'] as string,
    decision: row['decision'] as ApprovalDecisionValue,
    decidedBy: row['decided_by'] as string,
    rationale: row['rationale'] as string,
    extensionMicroUsd: extension === null || extension === undefined ? null : microUsdOf(extension),
    decidedAt: iso(row['decided_at']),
  };
}

function sameDecision(a: RecordDecisionInput, b: RecordDecisionInput): boolean {
  return a.decisionId === b.decisionId && a.approvalRequestId === b.approvalRequestId && a.decision === b.decision
    && a.decidedBy === b.decidedBy && a.rationale === b.rationale && a.extensionMicroUsd === b.extensionMicroUsd;
}

const DECISION_COLUMNS =
  'id, request_id, decision, decided_by, rationale, (extension_usd * 1000000)::bigint as extension_micro_usd, decided_at';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export class SqlApprovalStore {
  constructor(private readonly client: SqlClient) {}

  async openRequest(
    scope: TenantScope,
    input: OpenApprovalRequestInput,
  ): Promise<{ readonly request: ApprovalRequestRecord; readonly created: boolean }> {
    const reason = malformedRequest(input);
    if (reason !== null) throw new RangeError(`approval request refused: ${reason}`);
    const payload = input.kind === 'budget-extension' ? { shortfallMicroUsd: input.shortfallMicroUsd } : {};
    const inserted = await this.client.query(
      `insert into approval_requests
         (id, organization_id, project_id, run_id, task_id, attempt_id, workflow_id, kind, requested_by, payload, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)
       on conflict (id) do nothing
       returning id`,
      [
        input.approvalRequestId, scope.organizationId, scope.projectId, input.runId, input.taskId, input.attemptId,
        input.workflowId, input.kind, input.requestedBy, JSON.stringify(payload), input.expiresAt,
      ],
    );
    const stored = await this.findRequest(scope, input.approvalRequestId);
    if (stored === null) throw new ScopeViolationError('approval request', input.approvalRequestId);
    if (!sameRequest(stored, input)) {
      throw new ApprovalRequestConflictError(
        `approval request ${input.approvalRequestId} is open with other facts — a request id is never reused`,
      );
    }
    return { request: stored, created: inserted.rowCount === 1 };
  }

  async findRequest(scope: TenantScope, approvalRequestId: string): Promise<ApprovalRequestRecord | null> {
    const found = await this.requestRow(this.client, scope, approvalRequestId, false);
    if (found === null) return null;
    const { pastExpiry: _, ...request } = found;
    return request;
  }

  /**
   * Expires or cancels a pending request. Returns the status the request has afterwards: the one asked for, or the
   * one it already had when it was no longer pending.
   */
  async closeRequest(
    scope: TenantScope,
    approvalRequestId: string,
    status: 'EXPIRED' | 'CANCELLED',
  ): Promise<ApprovalRequestStatus> {
    if (status !== 'EXPIRED' && status !== 'CANCELLED') throw new RangeError(`${String(status)} does not close a request`);
    const r = await this.client.query(
      `update approval_requests set status = $4, updated_at = now(), version = version + 1
        where id = $1 and organization_id = $2 and project_id = $3 and status = 'PENDING'
        returning status`,
      [approvalRequestId, scope.organizationId, scope.projectId, status],
    );
    if (r.rowCount > 0) return status;
    const stored = await this.findRequest(scope, approvalRequestId);
    if (stored === null) throw new ScopeViolationError('approval request', approvalRequestId);
    return stored.status;
  }

  async recordDecision(
    scope: TenantScope,
    input: RecordDecisionInput,
  ): Promise<{ readonly decision: ApprovalDecisionRecord; readonly replayed: boolean }> {
    if (!isId(input.decisionId)) throw new RangeError('decision refused: the decision id is not an id');
    if (input.decision !== 'approve' && input.decision !== 'reject') throw new RangeError(`decision refused: ${String(input.decision)}`);
    if (!isId(input.decidedBy)) throw new RangeError('decision refused: the decider is not a principal id');
    if (typeof input.rationale !== 'string' || input.rationale.length === 0 || input.rationale.length > 4000) {
      throw new RangeError('decision refused: a rationale of 1 to 4000 characters is required');
    }
    if (input.extensionMicroUsd !== null && !isMicroUsd(input.extensionMicroUsd, true)) {
      throw new RangeError('decision refused: an extension is a positive amount of micro-USD');
    }
    return this.client.transaction(async (tx) => {
      const request = await this.requestRow(tx, scope, input.approvalRequestId, true);
      if (request === null) throw new ScopeViolationError('approval request', input.approvalRequestId);
      const existing = await tx.query(
        `select ${DECISION_COLUMNS} from approval_decisions where request_id = $1 and organization_id = $2 and project_id = $3`,
        [input.approvalRequestId, scope.organizationId, scope.projectId],
      );
      if (existing.rowCount > 0) {
        const stored = toDecision(existing.rows[0]!);
        if (!sameDecision(stored, input)) {
          throw new ApprovalDecisionConflictError(
            `approval request ${input.approvalRequestId} has another decision already — it is decided once`,
          );
        }
        await tx.query(
          `update approval_decision_deliveries
              set status = 'PENDING', next_attempt_at = clock_timestamp(), version = version + 1
            where decision_id = $1 and organization_id = $2 and project_id = $3 and status <> 'TARGET_CLOSED'`,
          [input.decisionId, scope.organizationId, scope.projectId],
        );
        return { decision: stored, replayed: true };
      }
      if (request.status !== 'PENDING' || request.pastExpiry) {
        throw new ApprovalRequestClosedError(input.approvalRequestId, request.status, request.pastExpiry);
      }
      const withExtension = request.kind === 'budget-extension' && input.decision === 'approve';
      if (withExtension !== (input.extensionMicroUsd !== null)) {
        throw new RangeError(
          `decision refused: an extension amount comes exactly with a budget-extension approve (${request.kind}, ${input.decision})`,
        );
      }
      try {
        await tx.query(
          `insert into approval_decisions (id, organization_id, project_id, request_id, decision, decided_by, rationale, extension_usd)
           values ($1, $2, $3, $4, $5, $6, $7, $8::numeric)`,
          [
            input.decisionId, scope.organizationId, scope.projectId, input.approvalRequestId, input.decision,
            input.decidedBy, input.rationale, input.extensionMicroUsd === null ? null : usdDecimal(input.extensionMicroUsd),
          ],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApprovalDecisionConflictError(`decision id ${input.decisionId} names another decision`);
        }
        throw err;
      }
      await tx.query(
        `insert into approval_decision_deliveries (decision_id, organization_id, project_id, workflow_id, update_id)
         values ($1, $2, $3, $4, $1)
         on conflict (decision_id) do nothing`,
        [input.decisionId, scope.organizationId, scope.projectId, request.workflowId],
      );
      await tx.query(
        `update approval_requests set status = $4, updated_at = now(), version = version + 1
          where id = $1 and organization_id = $2 and project_id = $3`,
        [input.approvalRequestId, scope.organizationId, scope.projectId, input.decision === 'approve' ? 'APPROVED' : 'REJECTED'],
      );
      const recorded = await tx.query(
        `select ${DECISION_COLUMNS} from approval_decisions where id = $1`,
        [input.decisionId],
      );
      return { decision: toDecision(recorded.rows[0]!), replayed: false };
    });
  }

  async findDecision(scope: TenantScope, approvalRequestId: string): Promise<ApprovalDecisionRecord | null> {
    const r = await this.client.query(
      `select ${DECISION_COLUMNS} from approval_decisions where request_id = $1 and organization_id = $2 and project_id = $3`,
      [approvalRequestId, scope.organizationId, scope.projectId],
    );
    return r.rowCount === 0 ? null : toDecision(r.rows[0]!);
  }

  async findDelivery(scope: TenantScope, decisionId: string): Promise<DeliveryRecord | null> {
    const r = await this.client.query(
      `select decision_id, workflow_id, update_id, status, attempts, next_attempt_at, last_error_code, delivered_at
         from approval_decision_deliveries where decision_id = $1 and organization_id = $2 and project_id = $3`,
      [decisionId, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0]!;
    return {
      decisionId: row['decision_id'] as string,
      workflowId: row['workflow_id'] as string,
      updateId: row['update_id'] as string,
      status: row['status'] as DeliveryStatus,
      attempts: Number(row['attempts']),
      nextAttemptAt: iso(row['next_attempt_at']),
      lastErrorCode: (row['last_error_code'] as string | null) ?? null,
      deliveredAt: row['delivered_at'] === null || row['delivered_at'] === undefined ? null : iso(row['delivered_at']),
    };
  }

  /** Pending deliveries whose next attempt is due by the database clock, across tenants, oldest first. */
  async dueDeliveries(limit: number): Promise<readonly DueDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new RangeError('a due-delivery batch is 1 to 1000 rows');
    const r = await this.client.query(
      `select decision_id, organization_id, project_id, workflow_id, update_id, attempts
         from approval_decision_deliveries
        where status = 'PENDING' and next_attempt_at <= clock_timestamp()
        order by next_attempt_at, decision_id
        limit $1`,
      [limit],
    );
    return r.rows.map((row) => ({
      scope: { organizationId: row['organization_id'] as OrganizationId, projectId: row['project_id'] as ProjectId },
      decisionId: row['decision_id'] as string,
      workflowId: row['workflow_id'] as string,
      updateId: row['update_id'] as string,
      attempts: Number(row['attempts']),
    }));
  }

  async markDelivered(scope: TenantScope, decisionId: string): Promise<void> {
    await this.moveDelivery(scope, decisionId, `status = 'DELIVERED', delivered_at = clock_timestamp()`, []);
  }

  async markTargetClosed(scope: TenantScope, decisionId: string): Promise<void> {
    await this.moveDelivery(scope, decisionId, `status = 'TARGET_CLOSED'`, []);
  }

  /** A failed delivery attempt of a pending row: the closed error code, and the next attempt after `retryAfterMs`. */
  async recordDeliveryFailure(scope: TenantScope, input: {
    readonly decisionId: string;
    readonly errorCode: string;
    readonly retryAfterMs: number;
  }): Promise<void> {
    if (typeof input.errorCode !== 'string' || !ERROR_CODE.test(input.errorCode)) {
      throw new RangeError('delivery failure refused: the error code is a closed code, never a message');
    }
    if (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0 || input.retryAfterMs > MAX_RETRY_AFTER_MS) {
      throw new RangeError('delivery failure refused: the backoff is a non-negative number of milliseconds');
    }
    await this.moveDelivery(
      scope, input.decisionId,
      `attempts = attempts + 1, last_error_code = $4, next_attempt_at = clock_timestamp() + ($5::integer * interval '1 millisecond')`,
      [input.errorCode, input.retryAfterMs],
    );
  }

  /** Applies `set` to a pending delivery row; a row that is no longer pending stays as it is. */
  private async moveDelivery(
    scope: TenantScope,
    decisionId: string,
    set: string,
    params: readonly (string | number)[],
  ): Promise<void> {
    const r = await this.client.query(
      `update approval_decision_deliveries set ${set}, version = version + 1
        where decision_id = $1 and organization_id = $2 and project_id = $3 and status = 'PENDING'
        returning decision_id`,
      [decisionId, scope.organizationId, scope.projectId, ...params],
    );
    if (r.rowCount === 0 && (await this.findDelivery(scope, decisionId)) === null) {
      throw new ScopeViolationError('decision delivery', decisionId);
    }
  }

  private async requestRow(
    db: SqlExecutor,
    scope: TenantScope,
    approvalRequestId: string,
    lock: boolean,
  ): Promise<(ApprovalRequestRecord & { readonly pastExpiry: boolean }) | null> {
    const r = await db.query(
      `select id, workflow_id, run_id, task_id, attempt_id, kind, requested_by, payload, expires_at, status,
              expires_at <= clock_timestamp() as past_expiry
         from approval_requests where id = $1 and organization_id = $2 and project_id = $3${lock ? ' for update' : ''}`,
      [approvalRequestId, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0]!;
    return { ...toRequest(row), pastExpiry: row['past_expiry'] === true };
  }
}
