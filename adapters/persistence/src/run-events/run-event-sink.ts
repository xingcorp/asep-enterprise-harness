// RunEventSink over run_events (data model §3.7). The only writer of the table:
// an event is validated against the run-event version this build carries and
// checked against the caller's tenant before any insert; the insert is keyed by
// the tenant and the producer's event id; and a second write of an id stored
// already is a no-op only when its canonical bytes hash the same. No row is
// ever updated or deleted (the table's trigger refuses both). The sink runs its
// statements on the executor it is given, so a caller that needs the append to
// commit with other writes hands it the executor of its own transaction.

import { createHash } from 'node:crypto';
import { contractVersion, validate, type RunEvent, type TenantScope } from '@asep/contracts';
import { RunEventConflictError, type RunEventSink } from '@asep/ports';
import { ScopeViolationError, type SqlExecutor } from '../sql.js';
import { isUlid } from '../ulid.js';

/** The event is not a valid run event of the version the sink writes; nothing was inserted. */
export class RunEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunEventValidationError';
  }
}

/** JSON with keys sorted at every level and no insignificant whitespace; undefined members are dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const RUN_EVENT_VERSION = contractVersion('run-event');

function checkEvent(scope: TenantScope, event: RunEvent): void {
  const result = validate('run-event', event);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw new RunEventValidationError(`run event ${String(event?.eventId)} is not a valid run-event ${RUN_EVENT_VERSION}: ${detail}`);
  }
  // run_events keys runs, tasks and attempts by their ULIDs; any other id names nothing the table can hold.
  for (const [field, id] of [['runId', event.runId], ['taskId', event.taskId], ['attemptId', event.attemptId]] as const) {
    if (id !== undefined && !isUlid(id)) throw new RunEventValidationError(`run event ${event.eventId}: ${field} is not an id`);
  }
  if (event.organizationId !== undefined && event.organizationId !== scope.organizationId) {
    throw new ScopeViolationError('run-event', event.eventId);
  }
  if (event.projectId !== undefined && event.projectId !== scope.projectId) {
    throw new ScopeViolationError('run-event', event.eventId);
  }
}

export class SqlRunEventSink implements RunEventSink {
  constructor(private readonly db: SqlExecutor) {}

  async append(scope: TenantScope, event: RunEvent): Promise<{ readonly appended: boolean }> {
    checkEvent(scope, event);
    // Measurement and replay data has no runs row: an event must belong to a real run of this tenant. The scoped
    // foreign key refuses it too; the read names the cause before the insert is tried.
    const run = await this.db.query(
      'select 1 from runs where id = $1 and organization_id = $2 and project_id = $3',
      [event.runId, scope.organizationId, scope.projectId],
    );
    if (run.rowCount === 0) throw new ScopeViolationError('run', event.runId);
    const payload = canonicalJson(event);
    const digest = sha256Hex(payload);
    const inserted = await this.db.query(
      `insert into run_events
         (organization_id, project_id, event_id, event_type, schema_version, occurred_at,
          run_id, task_id, attempt_id, payload, payload_sha256)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::jsonb, $11)
       on conflict (organization_id, project_id, event_id) do nothing
       returning event_id`,
      [
        scope.organizationId, scope.projectId, event.eventId, event.eventType, RUN_EVENT_VERSION, event.occurredAt,
        event.runId, event.taskId ?? null, event.attemptId ?? null, payload, digest,
      ],
    );
    if (inserted.rowCount > 0) return { appended: true };
    const stored = await this.db.query(
      'select payload_sha256 from run_events where organization_id = $1 and project_id = $2 and event_id = $3',
      [scope.organizationId, scope.projectId, event.eventId],
    );
    if (stored.rows[0]?.['payload_sha256'] === digest) return { appended: false };
    throw new RunEventConflictError(
      `run event ${event.eventId} is stored with other bytes; a run event is never rewritten`,
    );
  }
}
