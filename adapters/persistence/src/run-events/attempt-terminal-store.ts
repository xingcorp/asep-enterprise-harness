// AttemptTerminalStore over run_events and the workspace lease table: the fenced,
// idempotent, atomic write of an attempt's terminal that the review-loop slot
// contract requires of the default slot, and the lease acquisition that refuses
// an attempt once its terminal is recorded.
//
// Both writes take a row lock on the attempt first, so they serialize per
// attempt:
//   - recordTerminal checks the scope, then the caller's fence (the lease is
//     ACTIVE, live, the attempt's, at that epoch) or, without a fence, that the
//     attempt's lease history is empty, then compares the terminal events
//     already recorded, and only then appends through the run-event sink;
//   - acquireLease checks the scope and that no attempt.completed event exists,
//     then runs the lease repository's acquisition unchanged inside the same transaction.
// Whichever commits first wins: a terminal recorded first makes the
// acquisition refuse, and a grant committed first makes a fence-null terminal
// refuse as 'lease-granted'. A lease row is never deleted (the lease repository
// only moves its state), so history read under the lock is final.

import type { RunEvent, TenantScope } from '@asep/contracts';
import type {
  AttemptLeaseCheck, AttemptLeaseFence, AttemptRef, AttemptTerminalRefusal, AttemptTerminalStore,
  AttemptTerminalWrite, Lease, LeaseDenied,
} from '@asep/ports';
import { SqlWorkspaceLeaseRepository } from '../lease-repository.js';
import type { SqlClient, SqlExecutor } from '../sql.js';
import { isUlid } from '../ulid.js';
import { SqlRunEventSink, canonicalJson } from './run-event-sink.js';

const TERMINAL_EVENT_TYPES = ['attempt.declared_complete', 'attempt.completed'] as const;

function refused(reason: AttemptTerminalRefusal): AttemptTerminalWrite {
  return { kind: 'refused', reason };
}

function idsWellFormed(scope: TenantScope, attempt: AttemptRef): boolean {
  return [
    scope.organizationId, scope.projectId, attempt.repositoryBindingId, attempt.runId, attempt.taskId, attempt.attemptId,
  ].every((id) => typeof id === 'string' && isUlid(id));
}

/** Locks the attempt row, or reads it, when the scope owns the attempt with that run, task and binding. */
async function attemptInScope(db: SqlExecutor, scope: TenantScope, attempt: AttemptRef, lock: boolean): Promise<boolean> {
  if (!idsWellFormed(scope, attempt)) return false;
  const r = await db.query(
    `select a.id from attempts a
       join tasks t on t.id = a.task_id and t.organization_id = a.organization_id and t.project_id = a.project_id
      where a.id = $1 and a.organization_id = $2 and a.project_id = $3 and a.task_id = $4
        and a.repository_binding_id = $5 and t.run_id = $6
      ${lock ? 'for update of a' : ''}`,
    [attempt.attemptId, scope.organizationId, scope.projectId, attempt.taskId, attempt.repositoryBindingId, attempt.runId],
  );
  return r.rowCount > 0;
}

/** The fence is the attempt's current lease: ACTIVE and live by the database clock, at exactly that epoch. */
async function leaseHeld(db: SqlExecutor, scope: TenantScope, attempt: AttemptRef, fence: AttemptLeaseFence): Promise<boolean> {
  if (typeof fence.leaseId !== 'string' || !isUlid(fence.leaseId) || !Number.isSafeInteger(fence.fencingEpoch)) return false;
  const r = await db.query(
    `select 1 from workspace_leases
      where id = $1 and organization_id = $2 and project_id = $3 and attempt_id = $4 and fencing_epoch = $5
        and state = 'ACTIVE' and expires_at > clock_timestamp()
      for share`,
    [fence.leaseId, scope.organizationId, scope.projectId, attempt.attemptId, fence.fencingEpoch],
  );
  return r.rowCount > 0;
}

async function leaseEverGranted(db: SqlExecutor, scope: TenantScope, attempt: AttemptRef): Promise<boolean> {
  const r = await db.query(
    'select 1 from workspace_leases where attempt_id = $1 and organization_id = $2 and project_id = $3 limit 1',
    [attempt.attemptId, scope.organizationId, scope.projectId],
  );
  return r.rowCount > 0;
}

async function recordedTerminalEvents(
  db: SqlExecutor, scope: TenantScope, attempt: AttemptRef,
): Promise<ReadonlyMap<string, unknown>> {
  const r = await db.query(
    `select event_id, payload from run_events
      where organization_id = $1 and project_id = $2 and run_id = $3 and attempt_id = $4
        and event_type in ('attempt.declared_complete', 'attempt.completed')`,
    [scope.organizationId, scope.projectId, attempt.runId, attempt.attemptId],
  );
  return new Map(r.rows.map((row) => [row['event_id'] as string, row['payload']]));
}

/** The event's facts: everything but the time it was written at, which differs between deliveries. */
function factsOf(payload: unknown): string {
  const { occurredAt: _occurredAt, ...facts } = payload as Record<string, unknown>;
  return canonicalJson(facts);
}

function assertTerminalEvents(attempt: AttemptRef, events: readonly RunEvent[]): void {
  const own = events.every((e) => e.runId === attempt.runId && e.taskId === attempt.taskId && e.attemptId === attempt.attemptId);
  const types = events.map((e) => e.eventType).sort();
  const ids = new Set(events.map((e) => e.eventId));
  if (!own || ids.size !== events.length || canonicalJson(types) !== canonicalJson([...TERMINAL_EVENT_TYPES].sort())) {
    throw new Error(`events are not the attempt's terminal: one attempt.declared_complete and one attempt.completed of attempt ${attempt.attemptId}`);
  }
}

/**
 * A client whose transactions are savepoints of the enclosing transaction, so a repository that opens its own
 * transaction runs inside the caller's and under its locks. A failure rolls back to the savepoint, leaving the
 * enclosing transaction usable.
 */
function nestedClient(tx: SqlExecutor): SqlClient {
  return {
    query: (text, params) => tx.query(text, params),
    async transaction(fn) {
      await tx.query('savepoint asep_nested');
      try {
        const out = await fn(tx);
        await tx.query('release savepoint asep_nested');
        return out;
      } catch (err) {
        await tx.query('rollback to savepoint asep_nested');
        await tx.query('release savepoint asep_nested');
        throw err;
      }
    },
    async ping() {
      await tx.query('select 1');
      return true;
    },
    close() {
      return Promise.reject(new Error('a transaction-bound client ends with its transaction'));
    },
  };
}

export class SqlAttemptTerminalStore implements AttemptTerminalStore {
  constructor(private readonly client: SqlClient) {}

  async checkLease(scope: TenantScope, attempt: AttemptRef, fence: AttemptLeaseFence): Promise<AttemptLeaseCheck> {
    if (!(await attemptInScope(this.client, scope, attempt, false))) return 'not-in-scope';
    return (await leaseHeld(this.client, scope, attempt, fence)) ? 'held' : 'fenced';
  }

  async recordTerminal(
    scope: TenantScope,
    attempt: AttemptRef,
    fence: AttemptLeaseFence | null,
    events: readonly RunEvent[],
  ): Promise<AttemptTerminalWrite> {
    assertTerminalEvents(attempt, events);
    return this.client.transaction(async (tx) => {
      if (!(await attemptInScope(tx, scope, attempt, true))) return refused('not-in-scope');
      if (fence !== null) {
        if (!(await leaseHeld(tx, scope, attempt, fence))) return refused('fenced');
      } else if (await leaseEverGranted(tx, scope, attempt)) {
        return refused('lease-granted');
      }
      const recorded = await recordedTerminalEvents(tx, scope, attempt);
      if (recorded.size > 0) {
        const same = recorded.size === events.length
          && events.every((e) => recorded.has(e.eventId) && factsOf(recorded.get(e.eventId)) === factsOf(e));
        return same ? { kind: 'redelivered' } : refused('conflicting-redelivery');
      }
      const sink = new SqlRunEventSink(tx);
      for (const e of events) await sink.append(scope, e);
      return { kind: 'recorded' };
    });
  }

  /**
   * The attempt's workspace lease, granted by the lease repository under the attempt row lock, or refused
   * because the scope does not own the attempt or its terminal is recorded already.
   */
  async acquireLease(scope: TenantScope, input: {
    readonly attempt: AttemptRef;
    readonly branch: string;
    readonly ttlMs: number;
  }): Promise<Lease | LeaseDenied> {
    return this.client.transaction(async (tx) => {
      if (!(await attemptInScope(tx, scope, input.attempt, true))) return { denied: true, reason: 'attempt-not-in-scope' };
      const terminal = await tx.query(
        `select 1 from run_events
          where organization_id = $1 and project_id = $2 and run_id = $3 and attempt_id = $4
            and event_type = 'attempt.completed'
          limit 1`,
        [scope.organizationId, scope.projectId, input.attempt.runId, input.attempt.attemptId],
      );
      if (terminal.rowCount > 0) return { denied: true, reason: 'attempt-terminal-recorded' };
      return new SqlWorkspaceLeaseRepository(nestedClient(tx)).acquire(scope, {
        repositoryBindingId: input.attempt.repositoryBindingId,
        branch: input.branch,
        attemptId: input.attempt.attemptId,
        ttlMs: input.ttlMs,
      });
    });
  }
}
