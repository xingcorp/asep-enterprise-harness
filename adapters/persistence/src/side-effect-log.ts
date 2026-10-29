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
//   - ownership is a LEASE (migration 0014). The owner token is the id of a
//     live workspace lease for this attempt; the record stores it with the
//     lease's fencing epoch. begin() refuses a caller whose lease is not live;
//   - FENCED TAKEOVER: an unfinished record whose owner lease died (expired,
//     released, quarantined) moves to a caller holding a live lease on the same
//     branch with a strictly newer epoch, and the caller is told so
//     (`takenOver`) — it must reconcile against the outside world before
//     acting. A record whose owner is still live, or a caller whose epoch is not
//     newer, fails closed (SideEffectFencingError);
//   - complete()/fail() succeed only for the CURRENT owner while its lease is
//     still live, and never rewrite a COMPLETED record — so the crashed owner is
//     rejected for good once its successor took the record over;
//   - confirmOwner(), called immediately before the external effect, succeeds
//     only for the current owner of a PENDING record while its lease is live,
//     and renews that lease — so an executor paused between begin() and the
//     effect cannot act after its record was taken over, and a successor
//     cannot take the record over while the confirmed call is in flight (until
//     the renewed lease lapses);
//   - the outcome (result_ref) is the operation's CLOSED shape: validated here
//     before it is written, refused by the database's CHECK if anything else
//     reaches it, and parsed again on every read, so a consumer never receives
//     an unvalidated payload.
//
// The database trigger from migration 0014 enforces the same ownership rules
// independently; the checks below exist so a caller gets a typed error instead
// of a constraint violation, and so they hold under the row lock the
// transaction takes.

import type { TenantScope, RepositoryBindingId, AttemptId } from '@asep/contracts';
import type {
  SideEffectLog,
  SideEffectBeginInput,
  SideEffectCompleteInput,
  SideEffectKey,
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

// The record's typed identity. Every lookup binds these columns as parameters —
// there is no text key to construct or to drift.
type EffectKey = SideEffectKey;

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
    ownerToken: row['owner_lease_id'] as string,
    ownerEpoch: Number(row['owner_epoch']),
    ...(row['natural_key'] != null ? { naturalKey: row['natural_key'] as string } : {}),
    ...(resultRef !== undefined ? { resultRef } : {}),
  };
}

// A lease the caller presents as its fencing token, as the database sees it now.
interface LeaseView {
  readonly epoch: number;
  readonly branch: string;
  readonly live: boolean;
}

export class SqlSideEffectLog implements SideEffectLog {
  constructor(private readonly client: SqlClient) {}

  async begin(scope: TenantScope, input: SideEffectBeginInput): Promise<SideEffectRecord> {
    const label = `side-effect ${input.operation} for attempt ${input.attemptId}`;
    return this.client.transaction(async (tx) => {
      // The caller's lease must be a live lease of THIS attempt and binding.
      // Locked FOR SHARE so it cannot be released or swept while this
      // transaction relies on it.
      const mine = await this.lease(tx, scope, input.ownerToken, input, true);
      if (!mine || !mine.live) {
        throw new SideEffectFencingError(
          `${label}: owner lease ${input.ownerToken} is not a live lease of this attempt — fail closed`,
        );
      }

      // Claim the effect with a fresh PENDING row. The UNIQUE typed identity
      // makes a second concurrent begin() wait here, then do nothing → adopt.
      const id = ulid();
      const inserted = await tx.query(
        `insert into side_effect_records
           (id, organization_id, project_id, repository_binding_id, attempt_id, operation,
            request_fingerprint, state, owner_lease_id, owner_epoch, natural_key)
         values ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10)
         on conflict on constraint side_effect_identity_uq do nothing
         returning id`,
        [
          id, scope.organizationId, scope.projectId, input.repositoryBindingId,
          input.attemptId, input.operation,
          input.requestFingerprint, input.ownerToken, mine.epoch, input.naturalKey ?? null,
        ],
      );
      if (inserted.rowCount === 1) {
        return {
          operation: input.operation,
          state: 'PENDING',
          requestFingerprint: input.requestFingerprint,
          existed: false,
          ownerToken: input.ownerToken,
          ownerEpoch: mine.epoch,
          ...(input.naturalKey ? { naturalKey: input.naturalKey } : {}),
        };
      }

      // Adopt the existing record. A DIFFERENT fingerprint for the same typed
      // identity is a policy hole (the same operation rebound to different
      // inputs) — fail closed.
      const existing = await this.load(tx, scope, input, true);
      if (!existing) {
        throw new SideEffectFencingError(`${label}: record vanished during begin — fail closed`);
      }
      if ((existing['request_fingerprint'] as string) !== input.requestFingerprint) {
        throw new SideEffectFingerprintError(
          `${label} reused with a different request fingerprint (expected ` +
            `${existing['request_fingerprint'] as string}, got ${input.requestFingerprint}) — fail closed`,
        );
      }
      // A COMPLETED effect is a fact: anyone resuming adopts it, nobody owns it.
      const state = existing['state'] as SideEffectState;
      const owner = existing['owner_lease_id'] as string;
      if (state === 'COMPLETED' || owner === input.ownerToken) {
        return toRecord(existing, input.operation, true);
      }

      // Unfinished, and owned by another lease: fenced takeover, or nothing.
      // Epochs are ordered per (binding, branch), so a successor must hold the
      // SAME branch for "newer" to mean anything.
      const ownerEpoch = Number(existing['owner_epoch']);
      const previous = await this.lease(tx, scope, owner, input, true);
      if (!previous) {
        throw new SideEffectFencingError(`${label}: owner lease ${owner} not found — fail closed`);
      }
      if (previous.live) {
        throw new SideEffectFencingError(
          `${label} is owned by live lease ${owner} (epoch ${ownerEpoch}) — takeover refused (fencing, fail closed)`,
        );
      }
      if (previous.branch !== mine.branch) {
        throw new SideEffectFencingError(
          `${label}: lease for branch '${mine.branch}' cannot take over a record owned on ` +
            `'${previous.branch}' (fencing, fail closed)`,
        );
      }
      if (mine.epoch <= ownerEpoch) {
        throw new SideEffectFencingError(
          `${label}: lease epoch ${mine.epoch} is not newer than owner epoch ${ownerEpoch} — ` +
            'a stale lease cannot take the record over (fencing, fail closed)',
        );
      }
      await tx.query(
        `update side_effect_records
           set owner_lease_id = $6, owner_epoch = $7, updated_at = now(), version = version + 1
         where ${KEY_WHERE}`,
        [...keyParams(scope, input), input.ownerToken, mine.epoch],
      );
      return {
        ...toRecord(existing, input.operation, true),
        ownerToken: input.ownerToken,
        ownerEpoch: mine.epoch,
        takenOver: true,
      };
    });
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

  async confirmOwner(
    scope: TenantScope,
    input: SideEffectKey & { readonly ownerToken: string },
  ): Promise<{ readonly fencingEpoch: number }> {
    const label = `side-effect ${input.operation} for attempt ${input.attemptId}`;
    return this.client.transaction(async (tx) => {
      const row = await this.load(tx, scope, input, true);
      if (!row || (row['state'] as SideEffectState) !== 'PENDING') {
        throw new SideEffectFencingError(`${label}: no PENDING record to act for — fail closed`);
      }
      if ((row['owner_lease_id'] as string) !== input.ownerToken) {
        throw new SideEffectFencingError(
          `${label} is owned by another lease — a stale executor must not act (fencing, fail closed)`,
        );
      }
      // Renew the owner lease by the database clock, only while it is live.
      const renewed = await tx.query(
        `update workspace_leases
            set heartbeat_at = clock_timestamp(),
                expires_at = clock_timestamp() + (ttl_ms * interval '1 millisecond'),
                version = version + 1
          where id = $1 and organization_id = $2 and project_id = $3
            and repository_binding_id = $4 and attempt_id = $5
            and state = 'ACTIVE' and expires_at > clock_timestamp()
          returning fencing_epoch`,
        [input.ownerToken, scope.organizationId, scope.projectId, input.repositoryBindingId, input.attemptId],
      );
      if (renewed.rowCount === 0) {
        throw new SideEffectFencingError(
          `${label}: owner lease ${input.ownerToken} is no longer live — must not act (fencing, fail closed)`,
        );
      }
      const epoch = Number(renewed.rows[0]!['fencing_epoch']);
      if (epoch !== Number(row['owner_epoch'])) {
        throw new SideEffectFencingError(`${label}: owner epoch does not match its lease — fail closed`);
      }
      return { fencingEpoch: epoch };
    });
  }

  async find(scope: TenantScope, key: SideEffectKey): Promise<SideEffectRecord | null> {
    const row = await this.load(this.client, scope, key);
    return row ? toRecord(row, key.operation, true) : null;
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
      // A COMPLETED record is the authoritative outcome; nothing rewrites it.
      if ((row['state'] as SideEffectState) === 'COMPLETED') {
        throw new SideEffectFencingError(
          `${label} is already COMPLETED and cannot be ${state} again (exactly once, fail closed)`,
        );
      }
      // FENCING: only the CURRENT owner may finish the record, and only while
      // its lease is still live. A stale executor — one whose record was taken
      // over by a successor, or whose own lease lapsed — is rejected.
      if ((row['owner_lease_id'] as string) !== ownerToken) {
        throw new SideEffectFencingError(
          `${label} owned by a different lease — stale executor cannot finish it (fencing, fail closed)`,
        );
      }
      const mine = await this.lease(tx, scope, ownerToken, key, true);
      if (!mine || !mine.live) {
        throw new SideEffectFencingError(
          `${label}: owner lease ${ownerToken} is no longer live — cannot finish it (fencing, fail closed)`,
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
        ownerEpoch: Number(row['owner_epoch']),
        ...(naturalKey != null ? { naturalKey } : {}),
        ...(state === 'COMPLETED' && extra.resultRef !== undefined ? { resultRef: extra.resultRef } : {}),
      };
    });
  }

  // The lease as the database sees it right now: its epoch, and whether it is
  // still live (ACTIVE and not past expires_at by the clock at this statement,
  // not the transaction's frozen `now()`). Scoped to this tenant, binding and
  // attempt — a lease of another attempt is no lease at all here.
  private async lease(
    db: SqlExecutor,
    scope: TenantScope,
    leaseId: string,
    key: { readonly repositoryBindingId: RepositoryBindingId; readonly attemptId: AttemptId },
    lock: boolean,
  ): Promise<LeaseView | undefined> {
    const r = await db.query(
      `select fencing_epoch, branch, (state = 'ACTIVE' and expires_at > clock_timestamp()) as live
       from workspace_leases
       where id = $1 and organization_id = $2 and project_id = $3
         and repository_binding_id = $4 and attempt_id = $5${lock ? ' for share' : ''}`,
      [leaseId, scope.organizationId, scope.projectId, key.repositoryBindingId, key.attemptId],
    );
    if (r.rowCount === 0) return undefined;
    const row = r.rows[0]!;
    return {
      epoch: Number(row['fencing_epoch']),
      branch: row['branch'] as string,
      live: row['live'] === true,
    };
  }

  private async load(
    db: SqlExecutor,
    scope: TenantScope,
    key: EffectKey,
    forUpdate = false,
  ): Promise<SqlRow | undefined> {
    const r = await db.query(
      `select id, state, owner_lease_id, owner_epoch, request_fingerprint, natural_key, result_ref
       from side_effect_records
       where ${KEY_WHERE}${forUpdate ? ' for update' : ''}`,
      keyParams(scope, key),
    );
    return r.rowCount === 0 ? undefined : r.rows[0]!;
  }
}
