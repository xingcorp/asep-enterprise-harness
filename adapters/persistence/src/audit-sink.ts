// SqlAuditSink — the PostgreSQL-backed AuditSink (exit criterion J4, disp.
// P2-FINAL-MED-003). The pure @asep/observability layer fixes the closed set of
// privileged actions and the AuditEvent shape; THIS adapter persists them to
// the `audit_events` table (migration 0007), so a privileged operation leaves
// an authoritative, tenant-attributed row — not just a vocabulary type.
//
// It talks only to the SqlExecutor seam (pglite in tests, pg.Pool in prod) and
// binds every value as a parameter ($1..$N), never interpolated. The event was
// already validated by auditEvent() in the pure layer (closed action + full
// correlation identity), so this sink only maps fields to columns.

import type { AuditEvent, AuditSink } from '@asep/observability';
import type { SqlExecutor } from './sql.js';
import { ulid } from './ulid.js';

export class SqlAuditSink implements AuditSink {
  constructor(private readonly db: SqlExecutor) {}

  async record(event: AuditEvent): Promise<void> {
    const ctx = event.context;
    // organization_id/project_id are the load-bearing tenant columns; prefer the
    // explicit organizationId when present, else the legacy tenantId string.
    const organizationId = ctx.organizationId ?? ctx.tenantId;
    await this.db.query(
      `insert into audit_events
         (id, organization_id, project_id, run_id, task_id, attempt_id, actor, action, occurred_at, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ulid(),
        organizationId,
        ctx.projectId,
        ctx.runId ?? null,
        ctx.taskId ?? null,
        ctx.attemptId ?? null,
        event.actor,
        event.action,
        event.occurredAt,
        event.detail !== undefined ? JSON.stringify(event.detail) : null,
      ],
    );
  }
}
