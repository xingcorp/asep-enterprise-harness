// The durable workspace registry (migration 0104), the WorkspaceRegistry port.
//
// One row per attempt records which worktree serves it: host, relative path,
// base, the lease it was created under (bound by a composite key to that very
// lease of the same tenant, binding and attempt, with its epoch), the baseline
// refs taken once its checkout was verified, and its state. A restarted worker
// rehydrates a workspace from this row or refuses it; it never guesses from the
// filesystem.
//
// begin records CREATING and is idempotent by attempt: a repeat returns the
// row stored for the attempt, which a caller whose fields differ must not take
// for its own. Registering is a claim, so begin needs the caller's lease live
// (LeaseLostError otherwise, and nothing is written or returned); a later lease
// of the same attempt gets the row created under the earlier one. activate
// records the baseline refs and moves CREATING to ACTIVE;
// a repeat returns the stored record. markState ends a workspace (CLEANED or
// QUARANTINED) and only moves forward: the same state again, or quarantining a
// cleaned workspace, changes nothing. A workspace that is absent from the
// caller's tenant, cleaned or quarantined is WorkspaceUnavailableError. The
// database's trigger holds the same transitions for any writer.

import type { AttemptId, RepositoryBindingId, TenantScope, WorkspaceId } from '@asep/contracts';
import { LeaseLostError, WorkspaceUnavailableError, type WorkspaceRecord, type WorkspaceRegistry } from '@asep/ports';
import { ScopeViolationError, type SqlClient, type SqlExecutor, type SqlRow } from '../sql.js';
import { isUlid } from '../ulid.js';

const SHA40 = /^[0-9a-f]{40}$/;
const HOST_ID = /^[A-Za-z0-9._-]{1,255}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_BASELINE_REFS = 10_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Plain segments joined by '/': never absolute, never empty, '.' or '..'. */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024) return false;
  return path.split('/').every((s) => PATH_SEGMENT.test(s) && s !== '.' && s !== '..');
}

function malformedBegin(rec: Omit<WorkspaceRecord, 'state' | 'baselineRefs'>): string | null {
  for (const [field, id] of [
    ['workspace id', rec.workspaceId], ['binding id', rec.repositoryBindingId], ['attempt id', rec.attemptId], ['lease id', rec.leaseId],
  ] as const) {
    if (typeof id !== 'string' || !isUlid(id)) return `the ${field} is not an id`;
  }
  if (typeof rec.hostId !== 'string' || !HOST_ID.test(rec.hostId)) return 'the host id is not a plain name';
  if (!isSafeRelativePath(rec.pathRel)) return 'the path is not a relative path of plain segments';
  if (typeof rec.baseSha !== 'string' || !SHA40.test(rec.baseSha)) return 'the base is not a 40-hex commit id';
  return null;
}

function checkBaselineRefs(refs: readonly string[]): void {
  if (!Array.isArray(refs) || refs.length > MAX_BASELINE_REFS
    || !refs.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 1024 && !CONTROL.test(r))) {
    throw new RangeError('workspace activation refused: the baseline refs are not a list of ref names');
  }
}

function checkReason(reason: string): void {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 1000) {
    throw new RangeError('workspace state refused: a reason of 1 to 1000 characters is required');
  }
}

function toRecord(row: SqlRow): WorkspaceRecord {
  const refs = typeof row['baseline_refs'] === 'string' ? JSON.parse(row['baseline_refs']) : row['baseline_refs'];
  return {
    workspaceId: row['id'] as WorkspaceId,
    repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
    attemptId: row['attempt_id'] as AttemptId,
    leaseId: row['lease_id'] as string,
    hostId: row['host_id'] as string,
    pathRel: row['path_rel'] as string,
    baseSha: row['base_sha'] as string,
    baselineRefs: refs as string[],
    state: row['state'] as WorkspaceRecord['state'],
  };
}

const COLUMNS = 'id, repository_binding_id, attempt_id, lease_id, host_id, path_rel, base_sha, baseline_refs, state';

function unavailable(state: string | null, workspaceId: string): WorkspaceUnavailableError {
  return state === 'QUARANTINED'
    ? new WorkspaceUnavailableError('quarantined', `workspace ${workspaceId} is quarantined`)
    : new WorkspaceUnavailableError('missing', `workspace ${workspaceId} ${state === 'CLEANED' ? 'was cleaned up' : 'is not registered'}`);
}

export class SqlWorkspaceRegistry implements WorkspaceRegistry {
  constructor(private readonly client: SqlClient) {}

  async begin(scope: TenantScope, rec: Omit<WorkspaceRecord, 'state' | 'baselineRefs'>): Promise<WorkspaceRecord> {
    const reason = malformedBegin(rec);
    if (reason !== null) throw new RangeError(`workspace registration refused: ${reason}`);
    return this.client.transaction(async (tx) => {
      // The lease must be one of this attempt, binding and tenant, and live by the database clock: registering a
      // workspace is a claim. It is locked FOR SHARE, so it cannot be released, swept or quarantined while this
      // transaction relies on it, and its epoch is recorded with the workspace.
      const lease = await tx.query(
        `select fencing_epoch, (state = 'ACTIVE' and expires_at > clock_timestamp()) as live
           from workspace_leases
          where id = $1 and organization_id = $2 and project_id = $3 and repository_binding_id = $4 and attempt_id = $5
          for share`,
        [rec.leaseId, scope.organizationId, scope.projectId, rec.repositoryBindingId, rec.attemptId],
      );
      if (lease.rowCount === 0) throw new ScopeViolationError('workspace lease', rec.leaseId);
      if (lease.rows[0]!['live'] !== true) throw new LeaseLostError(rec.leaseId);
      await tx.query(
        `insert into workspaces
           (id, organization_id, project_id, repository_binding_id, attempt_id, lease_id, lease_epoch,
            host_id, path_rel, base_sha, baseline_refs, state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, 'CREATING')
         on conflict (attempt_id) do nothing`,
        [
          rec.workspaceId, scope.organizationId, scope.projectId, rec.repositoryBindingId, rec.attemptId, rec.leaseId,
          Number(lease.rows[0]!['fencing_epoch']), rec.hostId, rec.pathRel, rec.baseSha,
        ],
      );
      const stored = await this.byAttempt(tx, scope, rec.attemptId);
      if (stored === null) throw new ScopeViolationError('workspace', rec.workspaceId);
      return stored;
    });
  }

  async activate(scope: TenantScope, input: {
    readonly workspaceId: WorkspaceId;
    readonly baselineRefs: readonly string[];
  }): Promise<WorkspaceRecord> {
    checkBaselineRefs(input.baselineRefs);
    const r = await this.client.query(
      `update workspaces set state = 'ACTIVE', baseline_refs = $4::jsonb, updated_at = now(), version = version + 1
        where id = $1 and organization_id = $2 and project_id = $3 and state = 'CREATING'
        returning ${COLUMNS}`,
      [input.workspaceId, scope.organizationId, scope.projectId, JSON.stringify(input.baselineRefs)],
    );
    if (r.rowCount > 0) return toRecord(r.rows[0]!);
    const stored = await this.findById(scope, input.workspaceId);
    if (stored === null || stored.state !== 'ACTIVE') throw unavailable(stored?.state ?? null, input.workspaceId);
    return stored;
  }

  async findByAttempt(scope: TenantScope, attemptId: AttemptId): Promise<WorkspaceRecord | null> {
    return this.byAttempt(this.client, scope, attemptId);
  }

  async findById(scope: TenantScope, workspaceId: WorkspaceId): Promise<WorkspaceRecord | null> {
    const r = await this.client.query(
      `select ${COLUMNS} from workspaces where id = $1 and organization_id = $2 and project_id = $3`,
      [workspaceId, scope.organizationId, scope.projectId],
    );
    return r.rowCount === 0 ? null : toRecord(r.rows[0]!);
  }

  async markState(scope: TenantScope, input: {
    readonly workspaceId: WorkspaceId;
    readonly state: 'CLEANED' | 'QUARANTINED';
    readonly reason: string;
  }): Promise<void> {
    if (input.state !== 'CLEANED' && input.state !== 'QUARANTINED') {
      throw new RangeError(`workspace state refused: ${String(input.state)} is not an end state`);
    }
    checkReason(input.reason);
    const r = await this.client.query(
      `update workspaces set state = $4, state_reason = $5, updated_at = now(), version = version + 1
        where id = $1 and organization_id = $2 and project_id = $3
          and (state in ('CREATING', 'ACTIVE') or (state = 'QUARANTINED' and $4 = 'CLEANED'))
        returning id`,
      [input.workspaceId, scope.organizationId, scope.projectId, input.state, input.reason],
    );
    if (r.rowCount > 0) return;
    // Nothing moved: the workspace is already in that state, or cleaned, which is final; or it is not registered.
    if ((await this.findById(scope, input.workspaceId)) === null) throw unavailable(null, input.workspaceId);
  }

  private async byAttempt(db: SqlExecutor, scope: TenantScope, attemptId: AttemptId): Promise<WorkspaceRecord | null> {
    const r = await db.query(
      `select ${COLUMNS} from workspaces where attempt_id = $1 and organization_id = $2 and project_id = $3`,
      [attemptId, scope.organizationId, scope.projectId],
    );
    return r.rowCount === 0 ? null : toRecord(r.rows[0]!);
  }
}
