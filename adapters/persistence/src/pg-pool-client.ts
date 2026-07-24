// node-postgres `pg.Pool`-backed SqlClient (CI / integration / prod). This is
// the SECOND concrete driver behind the SqlClient/SqlExecutor seam (the first
// being the in-process PGlite WASM client). It is the ONLY file besides
// pglite-client.ts that imports a concrete database driver; everything above
// composes against the seam in ./sql.ts and never knows which backend is live.
//
// Why it exists (disp. P2-FINAL-MED-001 / HIGH-001): PGlite is a single
// in-process connection. It proves DDL semantics (composite FKs, partial unique
// indexes, transactional rollback) but it CANNOT prove multi-connection
// PostgreSQL concurrency — advisory-lock hand-off across sessions, the partial
// unique index arbitrating a genuine two-connection race, SELECT ... FOR UPDATE
// contention. The integration gate runs the SAME contract suites against a real
// digest-pinned PostgreSQL through this pool with >= 2 clients, so C3/C5 are
// proven under true concurrency, not simulated with a JavaScript mutex.
//
// A `transaction()` checks out ONE connection from the pool and runs the whole
// callback on it (BEGIN/COMMIT/ROLLBACK on that single client), matching the
// node-postgres pooling contract: statements outside a transaction may land on
// different pooled connections, statements inside one are pinned to a single
// connection so row locks / advisory locks behave.

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SqlClient, SqlExecutor, SqlParam, SqlResult, SqlRow } from './sql.js';

function toResult(r: { rows: unknown[]; rowCount: number | null }): SqlResult {
  const rows = (r.rows ?? []) as readonly SqlRow[];
  // node-postgres reports rowCount for writes; a SELECT also populates it, but
  // guard the null the types allow and fall back to the row count.
  const rowCount = r.rowCount ?? rows.length;
  return { rows, rowCount };
}

// An executor bound to a single checked-out connection (used inside a
// transaction so BEGIN/COMMIT and any row/advisory locks stay on one session).
function boundExecutor(client: PoolClient): SqlExecutor {
  return {
    query: async (text: string, params: readonly SqlParam[] = []) =>
      toResult(await client.query(text, params as unknown[])),
  };
}

export class PgPoolClient implements SqlClient {
  private constructor(private readonly pool: Pool) {}

  // Construct from an existing configured pool (tests can inject a pool with a
  // small max to force contention) or from a connection string / PoolConfig.
  static fromPool(pool: Pool): PgPoolClient {
    return new PgPoolClient(pool);
  }

  static create(config: string | PoolConfig): PgPoolClient {
    const pool = typeof config === 'string' ? new Pool({ connectionString: config }) : new Pool(config);
    return new PgPoolClient(pool);
  }

  // A statement outside a transaction runs on any pooled connection. pg binds
  // $1,$2,… positionally exactly like the seam requires; multi-statement DDL
  // scripts (migrations) run through the simple-query protocol when passed with
  // no params, matching pglite's routing so both backends behave identically.
  async query(text: string, params: readonly SqlParam[] = []): Promise<SqlResult> {
    return toResult(await this.pool.query(text, params as unknown[]));
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(boundExecutor(client));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A rollback failure (connection already broken) must not mask the
        // original error; surface the original.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Readiness probe: run a trivial statement on a pooled connection. Any error
  // (backend down, connection refused, auth failure) surfaces as `false`,
  // never throws — the composition root can gate startup on this without SQL.
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
