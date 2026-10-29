// Migration runner (data-model §5, disp. P2-PLAN-MED-006). Applies the ordered
// MIGRATIONS set under a PostgreSQL advisory lock so two concurrent migrators
// cannot race; records a sha256 checksum per applied id in schema_migrations;
// and FAILS CLOSED if an already-applied migration's text differs from its
// recorded checksum (an edited applied migration is rejected BEFORE any later
// migration runs). Re-applying the full set on an up-to-date DB is a no-op.

import { createHash } from 'node:crypto';
import type { SqlClient, SqlExecutor } from './sql.js';
import { MIGRATIONS, type Migration } from './migrations.js';

// A fixed 64-bit key for pg_advisory_lock so every migrator contends on the
// same lock. Arbitrary but constant across processes.
const ADVISORY_LOCK_KEY = 4023110815;

export class MigrationChecksumError extends Error {
  constructor(id: string) {
    super(
      `migration ${id} has already been applied with a different checksum — ` +
        `applied migrations are immutable; refusing to continue`,
    );
    this.name = 'MigrationChecksumError';
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function ensureRegistry(db: SqlExecutor): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      id          text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);
}

interface MigrateReport {
  readonly applied: readonly string[]; // ids applied this run
  readonly skipped: readonly string[]; // ids already present (checksum verified)
}

// Verify order is strictly ascending by id so "before any later migration runs"
// is a meaningful guarantee. Called once at entry.
function assertOrdered(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i - 1]!.id >= migrations[i]!.id) {
      throw new Error(
        `migration set is not strictly ordered: ${migrations[i - 1]!.id} >= ${migrations[i]!.id}`,
      );
    }
  }
}

// In-process serialization (per SqlClient). The PostgreSQL advisory lock below
// serializes migrators running on SEPARATE connections (CI/prod pg.Pool). But a
// single-connection backend (pglite) treats pg_advisory_lock as re-entrant
// within the one session, so two overlapping migrate() calls on the same client
// would interleave and both try to CREATE TABLE. This per-client async mutex
// closes that gap so the "two concurrent migrators converge, no corruption"
// guarantee (C5) holds on both backends. Keyed by client so independent DBs do
// not contend.
const migrateChains = new WeakMap<SqlClient, Promise<unknown>>();

function withClientMutex<T>(client: SqlClient, fn: () => Promise<T>): Promise<T> {
  const prior = migrateChains.get(client) ?? Promise.resolve();
  // Chain regardless of the prior run's outcome so one failure doesn't wedge
  // the mutex; the caller still sees its own error.
  const next = prior.then(fn, fn);
  migrateChains.set(client, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Apply all pending migrations. Serialized by an advisory lock (cross-connection)
 * plus a per-client in-process mutex (single-connection backends); each migration
 * runs inside its own transaction (DDL is transactional in PostgreSQL) so a
 * mid-migration failure rolls back and is NOT marked applied. Returns which ids
 * were applied vs skipped.
 */
export async function migrate(
  client: SqlClient,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrateReport> {
  return withClientMutex(client, () => migrateLocked(client, migrations));
}

async function migrateLocked(
  client: SqlClient,
  migrations: readonly Migration[],
): Promise<MigrateReport> {
  assertOrdered(migrations);
  await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureRegistry(client);
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const m of migrations) {
      const sum = checksum(m.sql);
      const existing = await client.query(
        'select checksum from schema_migrations where id = $1',
        [m.id],
      );
      if (existing.rowCount > 0) {
        // Already applied — its text must be byte-identical (immutability). A
        // mismatch fails closed here, before any later migration is touched.
        const recorded = existing.rows[0]!['checksum'] as string;
        if (recorded !== sum) throw new MigrationChecksumError(m.id);
        skipped.push(m.id);
        continue;
      }
      // Apply the migration + record it atomically: if either half fails the
      // whole transaction rolls back and the id is not marked applied.
      await client.transaction(async (tx) => {
        await tx.query(m.sql);
        await tx.query(
          'insert into schema_migrations (id, checksum) values ($1, $2)',
          [m.id, sum],
        );
      });
      applied.push(m.id);
    }
    return { applied, skipped };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}
