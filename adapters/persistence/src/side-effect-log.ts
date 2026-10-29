// SideEffectLog port impl — two-phase crash-safe side-effect protocol
// (disp. P2-PLAN-HIGH-005, exit criterion C7). Each external effect (harness
// commit, exact-ref push, PR upsert) is wrapped by a tenant-scoped
// `side_effect_records` row whose identity is TYPED (migration 0013):
// (organization_id, project_id, repository_binding_id, attempt_id, operation),
// UNIQUE, with a composite FK onto the attempt INCLUDING its binding. So a
// concurrent second begin() for the same effect loses the insert race and
// ADOPTS the existing row rather than performing the effect twice, and no row
// can name a binding other than its attempt's. The protocol is:
//
//   begin(PENDING) → perform external call → complete(COMPLETED)
//
// Trust rules enforced HERE (not in application logic):
//   - reusing a key with a DIFFERENT request fingerprint FAILS CLOSED
//     (SideEffectFingerprintError) — the same semantic operation cannot be
//     silently rebound to different inputs;
//   - complete()/fail() only succeed when the caller's owner_token matches the
//     row's owner_token (FENCING, SideEffectFencingError) — a stale executor
//     that lost its lease cannot complete another executor's operation;
//   - the outcome (result_ref) is the operation's CLOSED shape: validated here
//     before it is written, refused by the database's CHECK if anything else
//     reaches it, and parsed again on every read, so a consumer never receives
//     an unvalidated payload.

import type { TenantScope, RepositoryBindingId, AttemptId } from '@asep/contracts';
import type {
  SideEffectLog,
  SideEffectBeginInput,
  SideEffectCompleteInput,
  SideEffectRecord,
  SideEffectResultRef,
  SideEffectState,
  SideEffectOperation,
} from '@asep/ports';
import {
  SideEffectFingerprintError, SideEffectFencingError, parseSideEffectResultRef,
} from '@asep/ports';
import type { SqlClient, SqlExecutor, SqlRow } from './sql.js';
import { ulid } from './ulid.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === UNIQUE_VIOLATION) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && /unique/i.test(msg);
}

// The record's typed identity. Every lookup binds these four columns as
// parameters — there is no text key to construct or to drift.
interface EffectKey {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
}

const KEY_WHERE =
  'organization_id = $1 and project_id = $2 and repository_binding_id = $3 ' +
  'and attempt_id = $4 and operation = $5';

function keyParams(scope: TenantScope, key: EffectKey): string[] {
  return [
    scope.organizationId, scope.projectId, key.repositoryBindingId, key.attemptId, key.operation,
  ];
}

function decodeResultRef(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function toRecord(row: SqlRow, operation: SideEffectOperation, existed: boolean): SideEffectRecord {
  const raw = decodeResultRef(row['result_ref']);
  // Parsed on the way OUT as well: the CHECK constraint already refuses a
  // malformed outcome, and this keeps that true for any row a reader is handed.
  const resultRef: SideEffectResultRef | undefined =
    raw === undefined ? undefined : parseSideEffectResultRef(raw, operation);
  return {
    operation,
    state: row['state'] as SideEffectState,
    requestFingerprint: row['request_fingerprint'] as string,
    existed,
    ...(row['owner_token'] != null ? { ownerToken: row['owner_token'] as string } : {}),
    ...(row['natural_key'] != null ? { naturalKey: row['natural_key'] as string } : {}),
    ...(resultRef !== undefined ? { resultRef } : {}),
  };
}

export class SqlSideEffectLog implements SideEffectLog {
  constructor(private readonly client: SqlClient) {}

  async begin(scope: TenantScope, input: SideEffectBeginInput): Promise<SideEffectRecord> {
    const id = ulid();
    try {
      // Attempt to claim the effect with a fresh PENDING row. The UNIQUE typed
      // identity makes a second concurrent begin() lose here → adopt path below.
      await this.client.query(
        `insert into side_effect_records
           (id, organization_id, project_id, repository_binding_id, attempt_id, operation,
            request_fingerprint, state, owner_token, natural_key)
         values ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)`,
        [
          id, scope.organizationId, scope.projectId, input.repositoryBindingId,
          input.attemptId, input.operation,
          input.requestFingerprint, input.ownerToken, input.naturalKey ?? null,
        ],
      );
      return {
        operation: input.operation,
        state: 'PENDING',
        requestFingerprint: input.requestFingerprint,
        existed: false,
        ownerToken: input.ownerToken,
        ...(input.naturalKey ? { naturalKey: input.naturalKey } : {}),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Adopt the existing record. A DIFFERENT fingerprint for the same semantic
      // key is a policy hole (the same operation rebound to different inputs) —
      // fail closed.
      const existing = await this.load(this.client, scope, input);
      if (!existing) throw err;
      if ((existing['request_fingerprint'] as string) !== input.requestFingerprint) {
        throw new SideEffectFingerprintError(
          `side-effect ${input.operation} for attempt ${input.attemptId} reused with a different ` +
            `request fingerprint (expected ${existing['request_fingerprint'] as string}, ` +
            `got ${input.requestFingerprint}) — fail closed`,
        );
      }
      return toRecord(existing, input.operation, true);
    }
  }

  async complete(scope: TenantScope, input: SideEffectCompleteInput): Promise<SideEffectRecord> {
    // Validate BEFORE writing: the closed shape for this operation, or nothing.
    // The database CHECK refuses anything else too; failing here first keeps the
    // error typed and the transaction untouched.
    const resultRef = parseSideEffectResultRef(input.resultRef, input.operation);
    return this.finish(scope, input, 'COMPLETED', input.ownerToken, {
      resultRef,
      ...(input.naturalKey !== undefined ? { naturalKey: input.naturalKey } : {}),
    });
  }

  async fail(scope: TenantScope, input: {
    operation: SideEffectOperation;
    repositoryBindingId: RepositoryBindingId;
    attemptId: AttemptId;
    ownerToken: string;
  }): Promise<SideEffectRecord> {
    return this.finish(scope, input, 'FAILED', input.ownerToken, {});
  }

  private async finish(
    scope: TenantScope,
    key: EffectKey,
    state: Extract<SideEffectState, 'COMPLETED' | 'FAILED'>,
    ownerToken: string,
    extra: { resultRef?: SideEffectResultRef; naturalKey?: string },
  ): Promise<SideEffectRecord> {
    const label = `side-effect ${key.operation} for attempt ${key.attemptId}`;
    return this.client.transaction(async (tx) => {
      const row = await this.load(tx, scope, key, true);
      if (!row) {
        throw new SideEffectFencingError(`${label} cannot be ${state}: no PENDING record — fail closed`);
      }
      // FENCING: only the owner that claimed the PENDING record may finish it.
      // A stale executor whose lease was reassigned is rejected.
      if ((row['owner_token'] as string) !== ownerToken) {
        throw new SideEffectFencingError(
          `${label} owned by a different token — stale executor cannot complete it (fencing, fail closed)`,
        );
      }
      // A FAILED record carries no outcome; a COMPLETED one carries exactly the
      // validated closed shape. Nothing is carried over from the previous row.
      const resultRefJson = state === 'COMPLETED' && extra.resultRef !== undefined
        ? JSON.stringify(extra.resultRef)
        : null;
      const naturalKey = extra.naturalKey ?? (row['natural_key'] as string | null) ?? null;
      await tx.query(
        `update side_effect_records
         set state = $6, result_ref = $7, natural_key = $8,
             updated_at = now(), version = version + 1
         where ${KEY_WHERE}`,
        [...keyParams(scope, key), state, resultRefJson as never, naturalKey],
      );
      return {
        operation: key.operation,
        state,
        requestFingerprint: row['request_fingerprint'] as string,
        existed: true,
        ownerToken,
        ...(naturalKey != null ? { naturalKey } : {}),
        ...(state === 'COMPLETED' && extra.resultRef !== undefined ? { resultRef: extra.resultRef } : {}),
      };
    });
  }

  private async load(
    db: SqlExecutor,
    scope: TenantScope,
    key: EffectKey,
    forUpdate = false,
  ): Promise<SqlRow | undefined> {
    const r = await db.query(
      `select id, state, owner_token, request_fingerprint, natural_key, result_ref
       from side_effect_records
       where ${KEY_WHERE}${forUpdate ? ' for update' : ''}`,
      keyParams(scope, key),
    );
    return r.rowCount === 0 ? undefined : r.rows[0]!;
  }
}
