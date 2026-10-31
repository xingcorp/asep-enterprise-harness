// The attempt ordinal (migration 0102): an attempt is registered by its natural
// key, (task, attempt number), so an engine retry of the registration after a
// lost response finds the row it wrote instead of inserting a second attempt.
//
// ensureAttempt inserts attempt n of a task, or returns the one already there,
// in one transaction: the task must be the caller's, a repair lineage's parent
// must be an earlier registered attempt of the same task, and an existing row
// must carry exactly the identity asked for (kind, base, lineage); anything else
// is AttemptIdentityConflictError and changes nothing. The insert does nothing
// on a conflict of the natural key, so two concurrent registrations of the same
// attempt yield one row and both read it back. findAttempt is the read-only
// lookup after a failed registration. The database holds the same lineage rules
// (0102's checks, foreign keys and trigger) for any writer.

import type {
  ArtifactId, ArtifactRef, AttemptId, AttemptStatus, RepositoryBindingId, TaskId, TenantScope,
} from '@asep/contracts';
import { ScopeViolationError, type SqlClient, type SqlExecutor, type SqlRow } from '../sql.js';
import { isUlid, ulid } from '../ulid.js';

export type AttemptKind = 'initial' | 'retry' | 'repair';

/** The artifact kind a repair order is stored under. */
export const REPAIR_ORDER_KIND = 'repair-order';

export interface EnsureAttemptInput {
  readonly taskId: TaskId;
  readonly attemptNumber: number;
  readonly kind: AttemptKind;
  /** 40 lowercase hex: the task base, or the repair base of an attempt with a repair lineage. */
  readonly baseSha: string;
  /** The attempt whose assurance round asked for the repair; null for an attempt without a repair lineage. */
  readonly parentAttemptNumber: number | null;
  /** The repair order of that round; present exactly when the parent is. */
  readonly repairOrderRef: ArtifactRef | null;
}

export interface OrdinalAttempt {
  readonly attemptId: AttemptId;
  readonly taskId: TaskId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptNumber: number;
  readonly kind: AttemptKind;
  /** Null only for an attempt a Phase 2 writer created without a base. */
  readonly baseSha: string | null;
  readonly parentAttemptNumber: number | null;
  readonly repairOrderRef: ArtifactRef | null;
  readonly status: AttemptStatus;
}

/** The ordinal is registered with another identity. Not retryable: a repeat finds the same row. */
export class AttemptIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptIdentityConflictError';
  }
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const KINDS: readonly AttemptKind[] = ['initial', 'retry', 'repair'];

function isOrdinal(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647;
}

/** Why the registration is malformed, or null. Mirrors the database's lineage rules, checked before any write. */
function malformed(input: EnsureAttemptInput): string | null {
  if (typeof input.taskId !== 'string' || !isUlid(input.taskId)) return 'the task id is not an id';
  if (!isOrdinal(input.attemptNumber)) return `attempt number ${String(input.attemptNumber)} is not a positive integer`;
  if (!KINDS.includes(input.kind)) return `attempt kind ${String(input.kind)} is not one of ${KINDS.join(', ')}`;
  if (typeof input.baseSha !== 'string' || !SHA40.test(input.baseSha)) return 'the base is not a 40-hex commit id';
  const parent = input.parentAttemptNumber;
  const order = input.repairOrderRef;
  if ((parent === null) !== (order === null)) return 'a repair lineage names both its parent and its repair order';
  if (input.kind === 'repair' && parent === null) return 'a repair attempt has a repair lineage';
  if (input.kind === 'initial' && parent !== null) return 'an initial attempt has no repair lineage';
  if (parent !== null && (!isOrdinal(parent) || parent >= input.attemptNumber)) {
    return `the lineage's parent ${String(parent)} is not an earlier attempt`;
  }
  if (order !== null) {
    if (typeof order.artifactId !== 'string' || !isUlid(order.artifactId)) return 'the repair order id is not an id';
    if (typeof order.sha256 !== 'string' || !SHA64.test(order.sha256)) return 'the repair order checksum is not 64-hex';
    if (order.kind !== REPAIR_ORDER_KIND) return `the repair order is a ${String(order.kind)} artifact`;
  }
  return null;
}

const SELECT_ATTEMPT = `
  select a.id, a.task_id, a.repository_binding_id, a.attempt_number, a.attempt_kind, a.base_sha, a.status,
         a.repair_order_artifact_id, a.repair_order_sha256, p.attempt_number as parent_number
    from attempts a
    left join attempts p on p.id = a.parent_attempt_id
   where a.task_id = $1 and a.attempt_number = $2 and a.organization_id = $3 and a.project_id = $4`;

function toAttempt(row: SqlRow): OrdinalAttempt {
  const orderId = row['repair_order_artifact_id'] as string | null;
  const orderSha = row['repair_order_sha256'] as string | null;
  const parent = row['parent_number'];
  return {
    attemptId: row['id'] as AttemptId,
    taskId: row['task_id'] as TaskId,
    repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
    attemptNumber: Number(row['attempt_number']),
    kind: row['attempt_kind'] as AttemptKind,
    baseSha: (row['base_sha'] as string | null) ?? null,
    parentAttemptNumber: parent === null || parent === undefined ? null : Number(parent),
    repairOrderRef: orderId === null || orderSha === null
      ? null
      : { artifactId: orderId as ArtifactId, sha256: orderSha, kind: REPAIR_ORDER_KIND },
    status: row['status'] as AttemptStatus,
  };
}

/** The identity fields of the stored attempt that differ from the registration's. */
function differences(stored: OrdinalAttempt, input: EnsureAttemptInput): string[] {
  const out: string[] = [];
  if (stored.kind !== input.kind) out.push(`kind ${stored.kind}, not ${input.kind}`);
  if (stored.baseSha !== input.baseSha) out.push(`base ${String(stored.baseSha)}, not ${input.baseSha}`);
  if (stored.parentAttemptNumber !== input.parentAttemptNumber) {
    out.push(`lineage parent ${String(stored.parentAttemptNumber)}, not ${String(input.parentAttemptNumber)}`);
  }
  const s = stored.repairOrderRef;
  const i = input.repairOrderRef;
  if ((s === null) !== (i === null) || (s !== null && i !== null && (s.artifactId !== i.artifactId || s.sha256 !== i.sha256))) {
    out.push(`repair order ${s === null ? 'none' : `${s.artifactId}@${s.sha256}`}, not ${i === null ? 'none' : `${i.artifactId}@${i.sha256}`}`);
  }
  return out;
}

async function readAttempt(db: SqlExecutor, scope: TenantScope, taskId: TaskId, attemptNumber: number): Promise<OrdinalAttempt | null> {
  const r = await db.query(SELECT_ATTEMPT, [taskId, attemptNumber, scope.organizationId, scope.projectId]);
  return r.rowCount === 0 ? null : toAttempt(r.rows[0]!);
}

export class SqlAttemptOrdinal {
  constructor(private readonly client: SqlClient) {}

  async ensureAttempt(
    scope: TenantScope,
    input: EnsureAttemptInput,
  ): Promise<{ readonly attempt: OrdinalAttempt; readonly created: boolean }> {
    const reason = malformed(input);
    if (reason !== null) throw new RangeError(`attempt registration refused: ${reason}`);
    const label = `attempt ${input.attemptNumber} of task ${input.taskId}`;
    return this.client.transaction(async (tx) => {
      const task = await tx.query(
        'select repository_binding_id from tasks where id = $1 and organization_id = $2 and project_id = $3',
        [input.taskId, scope.organizationId, scope.projectId],
      );
      if (task.rowCount === 0) throw new ScopeViolationError('task', input.taskId);
      let parentId: string | null = null;
      if (input.parentAttemptNumber !== null) {
        const parent = await readAttempt(tx, scope, input.taskId, input.parentAttemptNumber);
        if (parent === null) throw new ScopeViolationError('attempt', `${input.taskId}:attempt:${input.parentAttemptNumber}`);
        parentId = parent.attemptId;
      }
      const inserted = await tx.query(
        `insert into attempts
           (id, organization_id, project_id, task_id, repository_binding_id, status, base_sha,
            attempt_number, attempt_kind, parent_attempt_id, repair_order_artifact_id, repair_order_sha256)
         values ($1, $2, $3, $4, $5, 'STARTED', $6, $7, $8, $9, $10, $11)
         on conflict (task_id, attempt_number) do nothing
         returning id`,
        [
          ulid(), scope.organizationId, scope.projectId, input.taskId, task.rows[0]!['repository_binding_id'] as string,
          input.baseSha, input.attemptNumber, input.kind, parentId,
          input.repairOrderRef?.artifactId ?? null, input.repairOrderRef?.sha256 ?? null,
        ],
      );
      const stored = await readAttempt(tx, scope, input.taskId, input.attemptNumber);
      if (stored === null) throw new ScopeViolationError('attempt', `${input.taskId}:attempt:${input.attemptNumber}`);
      const differs = differences(stored, input);
      if (differs.length > 0) {
        throw new AttemptIdentityConflictError(`${label} is registered with ${differs.join('; ')} — refusing to rebind it`);
      }
      return { attempt: stored, created: inserted.rowCount === 1 };
    });
  }

  /** The attempt registered as attempt n of the task, or null when no such row exists in the scope. */
  async findAttempt(
    scope: TenantScope,
    key: { readonly taskId: TaskId; readonly attemptNumber: number },
  ): Promise<OrdinalAttempt | null> {
    if (typeof key.taskId !== 'string' || !isUlid(key.taskId) || !isOrdinal(key.attemptNumber)) {
      throw new RangeError(`attempt lookup refused: ${String(key.taskId)}:attempt:${String(key.attemptNumber)} is not an attempt key`);
    }
    return readAttempt(this.client, scope, key.taskId, key.attemptNumber);
  }
}
