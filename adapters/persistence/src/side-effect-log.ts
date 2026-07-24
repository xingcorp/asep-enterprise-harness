// SideEffectLog port impl — two-phase crash-safe side-effect protocol
// (disp. P2-PLAN-HIGH-005, exit criterion C7). Each external effect (exact-ref
// push, PR upsert) is wrapped by a tenant-scoped `side_effect_records` row
// (migration 0007) keyed by (organization_id, project_id, scope, semantic_key)
// with a UNIQUE constraint, so a concurrent second begin() for the same effect
// loses the insert race and ADOPTS the existing row rather than performing the
// effect twice. The protocol is:
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
//   - result_ref + natural_key persist the remote outcome so a restart can
//     reconcile a PENDING row against the remote before retry-vs-adopt.

import type { TenantScope, RepositoryBindingId, AttemptId } from '@asep/contracts';
import type {
  SideEffectLog,
  SideEffectBeginInput,
  SideEffectCompleteInput,
  SideEffectRecord,
  SideEffectState,
  SideEffectOperation,
} from '@asep/ports';
import { SideEffectFingerprintError, SideEffectFencingError } from '@asep/ports';
import type { SqlClient, SqlRow } from './sql.js';
import { ulid } from './ulid.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === UNIQUE_VIOLATION) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && /unique/i.test(msg);
}

// The effect's identity: `scope` is the repository binding it acts on, and the
// semantic key pins the attempt + operation so retries of the SAME effect
// collide (one ref / one PR) while different operations stay independent.
function scopeColumn(bindingId: RepositoryBindingId): string {
  return bindingId;
}
function semanticKey(attemptId: AttemptId, operation: SideEffectOperation): string {
  return `${attemptId}:${operation}`;
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
  const resultRef = decodeResultRef(row['result_ref']);
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
    const scopeCol = scopeColumn(input.repositoryBindingId);
    const key = semanticKey(input.attemptId, input.operation);
    const id = ulid();
    try {
      // Attempt to claim the effect with a fresh PENDING row. The UNIQUE
      // (org, project, scope, semantic_key) constraint makes a second concurrent
      // begin() lose here → adopt path below.
      await this.client.query(
        `insert into side_effect_records
           (id, organization_id, project_id, scope, semantic_key, request_fingerprint,
            state, owner_token, natural_key)
         values ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)`,
        [
          id, scope.organizationId, scope.projectId, scopeCol, key,
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
      const existing = await this.load(scope, scopeCol, key);
      if (!existing) throw err;
      if ((existing['request_fingerprint'] as string) !== input.requestFingerprint) {
        throw new SideEffectFingerprintError(
          `side-effect ${input.operation} key ${key} reused with a different ` +
            `request fingerprint (expected ${existing['request_fingerprint'] as string}, ` +
            `got ${input.requestFingerprint}) — fail closed`,
        );
      }
      return toRecord(existing, input.operation, true);
    }
  }

  async complete(scope: TenantScope, input: SideEffectCompleteInput): Promise<SideEffectRecord> {
    const scopeCol = scopeColumn(input.repositoryBindingId);
    const key = semanticKey(input.attemptId, input.operation);
    return this.finish(scope, scopeCol, key, input.operation, 'COMPLETED', input.ownerToken, {
      ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
      ...(input.naturalKey !== undefined ? { naturalKey: input.naturalKey } : {}),
    });
  }

  async fail(scope: TenantScope, input: {
    operation: SideEffectOperation;
    repositoryBindingId: RepositoryBindingId;
    attemptId: AttemptId;
    ownerToken: string;
  }): Promise<SideEffectRecord> {
    const scopeCol = scopeColumn(input.repositoryBindingId);
    const key = semanticKey(input.attemptId, input.operation);
    return this.finish(scope, scopeCol, key, input.operation, 'FAILED', input.ownerToken, {});
  }

  private async finish(
    scope: TenantScope,
    scopeCol: string,
    key: string,
    operation: SideEffectOperation,
    state: Extract<SideEffectState, 'COMPLETED' | 'FAILED'>,
    ownerToken: string,
    extra: { resultRef?: unknown; naturalKey?: string },
  ): Promise<SideEffectRecord> {
    return this.client.transaction(async (tx) => {
      const cur = await tx.query(
        `select id, state, owner_token, request_fingerprint, natural_key, result_ref
         from side_effect_records
         where organization_id = $1 and project_id = $2 and scope = $3 and semantic_key = $4`,
        [scope.organizationId, scope.projectId, scopeCol, key],
      );
      if (cur.rowCount === 0) {
        throw new SideEffectFencingError(
          `side-effect ${operation} key ${key} cannot be ${state}: no PENDING record — fail closed`,
        );
      }
      const row = cur.rows[0]!;
      // FENCING: only the owner that claimed the PENDING record may finish it.
      // A stale executor whose lease was reassigned is rejected.
      if ((row['owner_token'] as string) !== ownerToken) {
        throw new SideEffectFencingError(
          `side-effect ${operation} key ${key} owned by a different token — ` +
            `stale executor cannot complete it (fencing, fail closed)`,
        );
      }
      const resultRefJson =
        extra.resultRef !== undefined ? JSON.stringify(extra.resultRef) : (row['result_ref'] ?? null);
      const naturalKey = extra.naturalKey ?? (row['natural_key'] as string | null) ?? null;
      await tx.query(
        `update side_effect_records
         set state = $5, result_ref = $6, natural_key = $7,
             updated_at = now(), version = version + 1
         where organization_id = $1 and project_id = $2 and scope = $3 and semantic_key = $4`,
        [
          scope.organizationId, scope.projectId, scopeCol, key,
          state, resultRefJson as never, naturalKey,
        ],
      );
      return {
        operation,
        state,
        requestFingerprint: row['request_fingerprint'] as string,
        existed: true,
        ownerToken,
        ...(naturalKey != null ? { naturalKey } : {}),
        ...(extra.resultRef !== undefined ? { resultRef: extra.resultRef } : {}),
      };
    });
  }

  private async load(scope: TenantScope, scopeCol: string, key: string): Promise<SqlRow | undefined> {
    const r = await this.client.query(
      `select id, state, owner_token, request_fingerprint, natural_key, result_ref
       from side_effect_records
       where organization_id = $1 and project_id = $2 and scope = $3 and semantic_key = $4`,
      [scope.organizationId, scope.projectId, scopeCol, key],
    );
    return r.rowCount === 0 ? undefined : r.rows[0]!;
  }
}
