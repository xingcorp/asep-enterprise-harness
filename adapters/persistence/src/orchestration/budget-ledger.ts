// The budget ledger and a run's governance (migration 0106).
//
// What a run spends is appended, one row per fact, under an idempotency key that
// is unique in its tenant: a retried append of the same facts is a no-op, other
// facts under the same key are BudgetLedgerConflictError. Money crosses this
// boundary as integer micro-USD and is stored as exact numeric USD. Totals are
// sums per run, optionally narrowed to a task, read in the caller's tenant.
//
// A run's governance (its caps, whether a publication needs a human approval,
// and the principal who set them) is bound once: the same values again are a
// no-op, other values RunGovernanceConflictError, and the database's trigger
// refuses any later change by any writer.

import type { AttemptId, RunId, TaskId, TenantScope } from '@asep/contracts';
import { ScopeViolationError, type SqlClient, type SqlRow } from '../sql.js';
import { isUlid, ulid } from '../ulid.js';
import { isMicroUsd, microUsdOf, usdDecimal } from './money.js';

export type LedgerEntryKind = 'attempt-usage' | 'extension-granted' | 'overrun';
export type LedgerSource = 'provider-reported' | 'harness-measured' | 'human-granted';

export interface LedgerEntryInput {
  readonly idempotencyKey: string;
  readonly runId: RunId;
  readonly taskId: TaskId | null;
  /** The attempt whose usage or overrun this is; null for an extension, which is a task's. */
  readonly attemptId: AttemptId | null;
  readonly entryKind: LedgerEntryKind;
  readonly costMicroUsd: number;
  /** Only on an overrun: the usage went past the bound it was given. */
  readonly usageOutOfBound: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: number | null;
  readonly wallClockMs: number | null;
  readonly source: LedgerSource;
}

export interface LedgerTotals {
  readonly attemptUsageMicroUsd: number;
  readonly overrunMicroUsd: number;
  readonly extensionGrantedMicroUsd: number;
  readonly entries: number;
}

export interface RunGovernance {
  readonly maxCostMicroUsd: number;
  readonly softCostMicroUsd: number;
  readonly maxTasks: number;
  readonly publicationApprovalRequired: boolean;
  /** The principal who started the run. */
  readonly createdBy: string;
}

/** The idempotency key holds an entry with other facts. Not retryable. */
export class BudgetLedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetLedgerConflictError';
  }
}

/** The run's governance is set already, to other values. Not retryable. */
export class RunGovernanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunGovernanceConflictError';
  }
}

const KEY = /^[A-Za-z0-9._:-]{1,255}$/;
const KINDS: readonly LedgerEntryKind[] = ['attempt-usage', 'extension-granted', 'overrun'];
const SOURCES: readonly LedgerSource[] = ['provider-reported', 'harness-measured', 'human-granted'];
const MAX_INT4 = 2_147_483_647;

const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): boolean =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max);

function malformedEntry(e: LedgerEntryInput): string | null {
  if (typeof e.idempotencyKey !== 'string' || !KEY.test(e.idempotencyKey)) return 'the idempotency key is not a plain key';
  if (typeof e.runId !== 'string' || !isUlid(e.runId)) return 'the run id is not an id';
  if (e.taskId !== null && (typeof e.taskId !== 'string' || !isUlid(e.taskId))) return 'the task id is not an id';
  if (e.attemptId !== null && (typeof e.attemptId !== 'string' || !isUlid(e.attemptId))) return 'the attempt id is not an id';
  if (!KINDS.includes(e.entryKind)) return `kind ${String(e.entryKind)} is not one of ${KINDS.join(', ')}`;
  if (!SOURCES.includes(e.source)) return `source ${String(e.source)} is not one of ${SOURCES.join(', ')}`;
  if (!isMicroUsd(e.costMicroUsd)) return 'the cost is not an amount of micro-USD';
  if (typeof e.usageOutOfBound !== 'boolean') return 'the out-of-bound flag is not a boolean';
  if (!isCount(e.inputTokens) || !isCount(e.outputTokens) || !isCount(e.toolCalls, MAX_INT4) || !isCount(e.wallClockMs)) {
    return 'a usage count is not a non-negative integer';
  }
  return null;
}

function toEntry(row: SqlRow): LedgerEntryInput {
  const count = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    idempotencyKey: row['idempotency_key'] as string,
    runId: row['run_id'] as RunId,
    taskId: (row['task_id'] as TaskId | null) ?? null,
    attemptId: (row['attempt_id'] as AttemptId | null) ?? null,
    entryKind: row['entry_kind'] as LedgerEntryKind,
    costMicroUsd: microUsdOf(row['cost_micro_usd']),
    usageOutOfBound: row['usage_out_of_bound'] === true,
    inputTokens: count(row['input_tokens']),
    outputTokens: count(row['output_tokens']),
    toolCalls: count(row['tool_calls']),
    wallClockMs: count(row['wall_clock_ms']),
    source: row['source'] as LedgerSource,
  };
}

function sameEntry(a: LedgerEntryInput, b: LedgerEntryInput): boolean {
  return (Object.keys(a) as (keyof LedgerEntryInput)[]).every((k) => a[k] === b[k]);
}

export class SqlBudgetLedger {
  constructor(private readonly client: SqlClient) {}

  async append(scope: TenantScope, entry: LedgerEntryInput): Promise<{ readonly appended: boolean }> {
    const reason = malformedEntry(entry);
    if (reason !== null) throw new RangeError(`ledger entry refused: ${reason}`);
    const inserted = await this.client.query(
      `insert into budget_ledger
         (id, organization_id, project_id, run_id, task_id, attempt_id, entry_kind, cost_usd, usage_out_of_bound,
          input_tokens, output_tokens, tool_calls, wall_clock_ms, source, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15)
       on conflict (organization_id, project_id, idempotency_key) do nothing
       returning id`,
      [
        ulid(), scope.organizationId, scope.projectId, entry.runId, entry.taskId, entry.attemptId, entry.entryKind,
        usdDecimal(entry.costMicroUsd), entry.usageOutOfBound, entry.inputTokens, entry.outputTokens, entry.toolCalls,
        entry.wallClockMs, entry.source, entry.idempotencyKey,
      ],
    );
    if (inserted.rowCount > 0) return { appended: true };
    const stored = await this.client.query(
      `select idempotency_key, run_id, task_id, attempt_id, entry_kind, (cost_usd * 1000000)::bigint as cost_micro_usd,
              usage_out_of_bound, input_tokens, output_tokens, tool_calls, wall_clock_ms, source
         from budget_ledger where organization_id = $1 and project_id = $2 and idempotency_key = $3`,
      [scope.organizationId, scope.projectId, entry.idempotencyKey],
    );
    if (stored.rowCount === 0) throw new ScopeViolationError('ledger entry', entry.idempotencyKey);
    if (!sameEntry(toEntry(stored.rows[0]!), entry)) {
      throw new BudgetLedgerConflictError(
        `ledger key ${entry.idempotencyKey} holds an entry with other facts — a key is never reused`,
      );
    }
    return { appended: false };
  }

  /** Sums of the run's entries in the caller's tenant, or of one task's when `taskId` is given. */
  async totals(scope: TenantScope, of: { readonly runId: RunId; readonly taskId?: TaskId }): Promise<LedgerTotals> {
    const r = await this.client.query(
      `select (coalesce(sum(cost_usd) filter (where entry_kind = 'attempt-usage'), 0) * 1000000)::bigint as usage,
              (coalesce(sum(cost_usd) filter (where entry_kind = 'overrun'), 0) * 1000000)::bigint as overrun,
              (coalesce(sum(cost_usd) filter (where entry_kind = 'extension-granted'), 0) * 1000000)::bigint as granted,
              count(*) as entries
         from budget_ledger
        where organization_id = $1 and project_id = $2 and run_id = $3 and ($4::text is null or task_id = $4)`,
      [scope.organizationId, scope.projectId, of.runId, of.taskId ?? null],
    );
    const row = r.rows[0]!;
    return {
      attemptUsageMicroUsd: microUsdOf(row['usage']),
      overrunMicroUsd: microUsdOf(row['overrun']),
      extensionGrantedMicroUsd: microUsdOf(row['granted']),
      entries: Number(row['entries']),
    };
  }
}

function malformedGovernance(g: RunGovernance): string | null {
  if (!isMicroUsd(g.maxCostMicroUsd, true)) return 'the cost cap is not a positive amount of micro-USD';
  if (!isMicroUsd(g.softCostMicroUsd) || g.softCostMicroUsd > g.maxCostMicroUsd) {
    return 'the soft cost is not an amount of micro-USD at most the cap';
  }
  if (!Number.isSafeInteger(g.maxTasks) || g.maxTasks <= 0 || g.maxTasks > MAX_INT4) return 'the task cap is not a positive integer';
  if (typeof g.publicationApprovalRequired !== 'boolean') return 'the publication approval flag is not a boolean';
  if (typeof g.createdBy !== 'string' || !isUlid(g.createdBy)) return 'the creator is not a principal id';
  return null;
}

const GOVERNANCE_COLUMNS = `(budget_max_cost_usd * 1000000)::bigint as max_micro, (budget_soft_cost_usd * 1000000)::bigint as soft_micro,
  budget_max_tasks, publication_approval_required, created_by`;

export class SqlRunGovernance {
  constructor(private readonly client: SqlClient) {}

  async bind(scope: TenantScope, runId: RunId, governance: RunGovernance): Promise<{ readonly bound: boolean }> {
    if (typeof runId !== 'string' || !isUlid(runId)) throw new RangeError(`governance refused: ${String(runId)} is not an id`);
    const reason = malformedGovernance(governance);
    if (reason !== null) throw new RangeError(`governance refused: ${reason}`);
    const r = await this.client.query(
      `update runs
          set budget_max_cost_usd = $4::numeric, budget_soft_cost_usd = $5::numeric, budget_max_tasks = $6,
              publication_approval_required = $7, created_by = $8, version = version + 1
        where id = $1 and organization_id = $2 and project_id = $3 and created_by is null
        returning id`,
      [
        runId, scope.organizationId, scope.projectId, usdDecimal(governance.maxCostMicroUsd),
        usdDecimal(governance.softCostMicroUsd), governance.maxTasks, governance.publicationApprovalRequired, governance.createdBy,
      ],
    );
    if (r.rowCount > 0) return { bound: true };
    // No row moved: the run is not in the caller's tenant (find throws), or its governance is set already.
    const stored = await this.find(scope, runId);
    if (stored === null || (Object.keys(governance) as (keyof RunGovernance)[]).some((k) => stored[k] !== governance[k])) {
      throw new RunGovernanceConflictError(`run ${runId} has other governance already — it is set once`);
    }
    return { bound: false };
  }

  /** The run's governance, or null for a run that has none (a run created before it existed). */
  async find(scope: TenantScope, runId: RunId): Promise<RunGovernance | null> {
    const r = await this.client.query(
      `select ${GOVERNANCE_COLUMNS} from runs where id = $1 and organization_id = $2 and project_id = $3`,
      [runId, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new ScopeViolationError('run', runId);
    const row = r.rows[0]!;
    if (row['created_by'] === null || row['created_by'] === undefined) return null;
    return {
      maxCostMicroUsd: microUsdOf(row['max_micro']),
      softCostMicroUsd: microUsdOf(row['soft_micro']),
      maxTasks: Number(row['budget_max_tasks']),
      publicationApprovalRequired: row['publication_approval_required'] === true,
      createdBy: row['created_by'] as string,
    };
  }
}
