// WorkspaceLeaseRepository port impl (data-model §3, exit criterion C3). The
// one-active-writer guarantee is enforced by the DB, not application logic: the
// partial unique index `one_active_writer on (repository_binding_id, branch)
// where state = 'ACTIVE'` means a second concurrent ACTIVE acquire violates a
// UNIQUE constraint. We catch that violation and return LeaseDenied rather than
// throwing — a losing acquirer is an expected outcome, not an error.
//
// Stale-lease sweep (data-model §4): an ACTIVE lease past expires_at is swept to
// EXPIRED before a new acquire is attempted, and its workspace is left for
// QUARANTINE by the manager (never silently reused). The sweep + insert run in
// one transaction so the winner is unambiguous.
//
// Fencing (migration 0014). Each granted lease takes the next `fencing_epoch`
// for its (binding, branch): the previous highest + 1, refused by a UNIQUE
// constraint if two acquirers race to the same number. Expiry is computed by
// the DATABASE clock (`clock_timestamp() + ttl`) — the same clock every
// liveness check compares against — so application/database skew cannot make a
// lease look live to one side and dead to the other. It is the clock at the
// statement, never `now()`: that is frozen at the start of the transaction, so
// a transaction opened while a lease was live would go on treating it as live
// (and grant a renewal, or block a successor) after it expired. A heartbeat renews a live lease by its
// TTL and throws LeaseLostError for one that is not live any more, so a holder
// can use it as the fence before each side effect.

import type {
  RepositoryBindingId, AttemptId, TenantScope, WorkspaceId,
} from '@asep/contracts';
import type { Lease, LeaseDenied, WorkspaceLeaseRepository } from '@asep/ports';
import { LeaseLostError } from '@asep/ports';
import type { SqlClient, SqlExecutor } from './sql.js';
import { ulid } from './ulid.js';

// PostgreSQL unique_violation SQLSTATE.
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  // pglite and node-postgres both surface the SQLSTATE on `.code`; some pglite
  // builds wrap it, so also match the message defensively.
  if (code === UNIQUE_VIOLATION) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' &&
    /one_active_writer|workspace_lease_epoch_uq/i.test(msg);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export class SqlWorkspaceLeaseRepository implements WorkspaceLeaseRepository {
  constructor(private readonly client: SqlClient) {}

  async acquire(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    attemptId: AttemptId;
    ttlMs: number;
  }): Promise<Lease | LeaseDenied> {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new RangeError(`lease ttlMs must be a positive integer, got ${input.ttlMs}`);
    }
    const id = ulid();
    const workspaceId = ulid() as WorkspaceId;
    try {
      return await this.client.transaction(async (tx) => {
        // 1. Sweep any expired-but-still-ACTIVE lease on this (binding, branch)
        //    so a stale holder cannot block a fresh acquire forever.
        await tx.query(
          `update workspace_leases set state = 'EXPIRED', version = version + 1
           where repository_binding_id = $1 and branch = $2 and state = 'ACTIVE'
             and expires_at <= clock_timestamp()`,
          [input.repositoryBindingId, input.branch],
        );
        // 2. Attempt the ACTIVE insert at the next epoch. If a live ACTIVE lease
        //    remains, the partial unique index rejects this row; if a concurrent
        //    acquirer took the same epoch, the epoch UNIQUE does — both mean a
        //    losing acquirer → unique_violation → LeaseDenied.
        const r = await tx.query(
          `insert into workspace_leases
             (id, organization_id, project_id, repository_binding_id, branch, attempt_id,
              workspace_id, state, expires_at, ttl_ms, fencing_epoch)
           select $1, $2, $3, $4, $5, $6, $7, 'ACTIVE',
                  clock_timestamp() + ($8::integer * interval '1 millisecond'), $8::integer,
                  coalesce(max(fencing_epoch), 0) + 1
           from workspace_leases
           where repository_binding_id = $4 and branch = $5
           returning expires_at, fencing_epoch`,
          [
            id, scope.organizationId, scope.projectId, input.repositoryBindingId,
            input.branch, input.attemptId, workspaceId, input.ttlMs,
          ],
        );
        const row = r.rows[0]!;
        const lease: Lease = {
          leaseId: id,
          repositoryBindingId: input.repositoryBindingId,
          branch: input.branch,
          attemptId: input.attemptId,
          expiresAt: iso(row['expires_at']),
          fencingEpoch: Number(row['fencing_epoch']),
        };
        return lease;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { denied: true, reason: 'active_writer_lease_held' };
      }
      throw err;
    }
  }

  async heartbeat(scope: TenantScope, leaseId: string): Promise<void> {
    // Renew ONLY a live lease. A lease past expires_at is dead even before the
    // next acquire sweeps it, so it cannot be revived by a late heartbeat.
    const r = await this.client.query(
      `update workspace_leases
         set heartbeat_at = clock_timestamp(),
             expires_at = clock_timestamp() + (ttl_ms * interval '1 millisecond'),
             version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3
         and state = 'ACTIVE' and expires_at > clock_timestamp()
       returning id`,
      [leaseId, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new LeaseLostError(leaseId);
  }

  async release(scope: TenantScope, leaseId: string): Promise<void> {
    await this.client.query(
      `update workspace_leases set state = 'RELEASED', version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3 and state = 'ACTIVE'`,
      [leaseId, scope.organizationId, scope.projectId],
    );
  }

  // Sweep helper used by tests / the manager: expire stale ACTIVE leases and
  // return the workspace ids that must be QUARANTINED (never reused).
  async sweepExpired(db: SqlExecutor = this.client): Promise<readonly string[]> {
    const r = await db.query(
      `update workspace_leases set state = 'EXPIRED', version = version + 1
       where state = 'ACTIVE' and expires_at <= clock_timestamp()
       returning workspace_id`,
      [],
    );
    return r.rows.map((row) => row['workspace_id'] as string);
  }
}
