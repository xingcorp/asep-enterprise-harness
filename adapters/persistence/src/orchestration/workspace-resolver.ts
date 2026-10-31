// The attempt's workspace lease, read from the lease table: the review-loop
// slot's workspace resolver, and the lease history lookup that settles a lease
// acquisition whose outcome the caller did not see.
//
// The resolver is structurally the slot's AssuranceWorkspaceResolver (the
// persistence adapter does not depend on the application package; the
// composition that binds it checks the fit). It is read-only and fails closed,
// checking in this order and reporting the first failing check:
//   - the attempt belongs to the caller's tenant ('not-in-scope', which reveals
//     nothing about other tenants);
//   - the attempt holds an ACTIVE lease, live by the database clock
//     ('lease-not-active');
//   - one of those leases is the caller's lease id ('lease-not-held');
//   - that lease is at the caller's fencing epoch ('stale-epoch').
// Only then is the workspace read from the registry: the attempt's registered
// workspace, which must be ACTIVE, or WorkspaceUnavailableError. The capability
// carries the caller's held lease, which may be a later lease of the same
// attempt than the one the workspace was created under.
//
// findLease returns the fence of the attempt's latest lease, whatever its state
// now, or null when the attempt never held one. A lease row is never deleted and
// a lease that left ACTIVE never returns to it, so the history only grows.

import type { AttemptId, TenantScope, WorkspaceId } from '@asep/contracts';
import { WorkspaceUnavailableError, type AttemptLeaseFence, type WorkspaceCapability } from '@asep/ports';
import { ScopeViolationError, type SqlClient, type SqlExecutor } from '../sql.js';
import { isUlid } from '../ulid.js';

export interface WorkspaceResolutionQuery {
  readonly attemptId: AttemptId;
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

/** Checked in this order; the first failing check is reported. */
export type WorkspaceResolutionRefusal = 'not-in-scope' | 'lease-not-active' | 'lease-not-held' | 'stale-epoch';

export type WorkspaceResolution =
  | { readonly kind: 'resolved'; readonly workspace: WorkspaceCapability }
  | { readonly kind: 'refused'; readonly reason: WorkspaceResolutionRefusal };

async function attemptInScope(db: SqlExecutor, scope: TenantScope, attemptId: string): Promise<boolean> {
  if (![scope.organizationId, scope.projectId, attemptId].every((id) => typeof id === 'string' && isUlid(id))) return false;
  const r = await db.query(
    'select 1 from attempts where id = $1 and organization_id = $2 and project_id = $3',
    [attemptId, scope.organizationId, scope.projectId],
  );
  return r.rowCount > 0;
}

export class SqlAssuranceWorkspaceResolver {
  constructor(private readonly client: SqlClient) {}

  async resolve(scope: TenantScope, query: WorkspaceResolutionQuery): Promise<WorkspaceResolution> {
    if (!(await attemptInScope(this.client, scope, query.attemptId))) return { kind: 'refused', reason: 'not-in-scope' };
    const live = await this.client.query(
      `select id, fencing_epoch from workspace_leases
        where attempt_id = $1 and organization_id = $2 and project_id = $3
          and state = 'ACTIVE' and expires_at > clock_timestamp()`,
      [query.attemptId, scope.organizationId, scope.projectId],
    );
    if (live.rowCount === 0) return { kind: 'refused', reason: 'lease-not-active' };
    const held = live.rows.find((row) => row['id'] === query.leaseId);
    if (held === undefined) return { kind: 'refused', reason: 'lease-not-held' };
    if (!Number.isSafeInteger(query.fencingEpoch) || Number(held['fencing_epoch']) !== query.fencingEpoch) {
      return { kind: 'refused', reason: 'stale-epoch' };
    }
    const workspace = await this.client.query(
      'select id, state from workspaces where attempt_id = $1 and organization_id = $2 and project_id = $3',
      [query.attemptId, scope.organizationId, scope.projectId],
    );
    const row = workspace.rows[0];
    if (row === undefined || row['state'] !== 'ACTIVE') {
      const state = row?.['state'];
      throw state === 'QUARANTINED'
        ? new WorkspaceUnavailableError('quarantined', `the workspace of attempt ${query.attemptId} is quarantined`)
        : new WorkspaceUnavailableError('missing', `attempt ${query.attemptId} has no active workspace (${row === undefined ? 'none registered' : String(state)})`);
    }
    return { kind: 'resolved', workspace: { workspaceId: row['id'] as WorkspaceId, leaseId: query.leaseId } };
  }
}

export class SqlAttemptLeaseHistory {
  constructor(private readonly client: SqlClient) {}

  /** The fence of the attempt's latest lease, or null when durable history shows no lease of the attempt. */
  async findLease(scope: TenantScope, attemptId: AttemptId): Promise<AttemptLeaseFence | null> {
    if (!(await attemptInScope(this.client, scope, attemptId))) throw new ScopeViolationError('attempt', attemptId);
    const r = await this.client.query(
      `select id, fencing_epoch from workspace_leases
        where attempt_id = $1 and organization_id = $2 and project_id = $3
        order by acquired_at desc, fencing_epoch desc, id desc
        limit 1`,
      [attemptId, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) return null;
    return { leaseId: r.rows[0]!['id'] as string, fencingEpoch: Number(r.rows[0]!['fencing_epoch']) };
  }
}
