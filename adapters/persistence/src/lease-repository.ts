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

import type {
  RepositoryBindingId, AttemptId, TenantScope, WorkspaceId,
} from '@asep/contracts';
import type { Lease, LeaseDenied, WorkspaceLeaseRepository } from '@asep/ports';
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
  return typeof msg === 'string' && /one_active_writer|unique/i.test(msg) && /active/i.test(msg);
}

export class SqlWorkspaceLeaseRepository implements WorkspaceLeaseRepository {
  constructor(private readonly client: SqlClient) {}

  async acquire(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    attemptId: AttemptId;
    ttlMs: number;
  }): Promise<Lease | LeaseDenied> {
    const id = ulid();
    const workspaceId = ulid() as WorkspaceId;
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    try {
      return await this.client.transaction(async (tx) => {
        // 1. Sweep any expired-but-still-ACTIVE lease on this (binding, branch)
        //    so a stale holder cannot block a fresh acquire forever.
        await tx.query(
          `update workspace_leases set state = 'EXPIRED', version = version + 1
           where repository_binding_id = $1 and branch = $2 and state = 'ACTIVE'
             and expires_at < now()`,
          [input.repositoryBindingId, input.branch],
        );
        // 2. Attempt the ACTIVE insert. If a live ACTIVE lease remains, the
        //    partial unique index rejects this row → unique_violation.
        await tx.query(
          `insert into workspace_leases
             (id, organization_id, project_id, repository_binding_id, branch, attempt_id, workspace_id, state, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
          [
            id, scope.organizationId, scope.projectId, input.repositoryBindingId,
            input.branch, input.attemptId, workspaceId, expiresAt,
          ],
        );
        const lease: Lease = {
          leaseId: id,
          repositoryBindingId: input.repositoryBindingId,
          branch: input.branch,
          attemptId: input.attemptId,
          expiresAt,
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
    await this.client.query(
      `update workspace_leases set heartbeat_at = now(), version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3 and state = 'ACTIVE'`,
      [leaseId, scope.organizationId, scope.projectId],
    );
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
       where state = 'ACTIVE' and expires_at < now()
       returning workspace_id`,
      [],
    );
    return r.rows.map((row) => row['workspace_id'] as string);
  }
}
