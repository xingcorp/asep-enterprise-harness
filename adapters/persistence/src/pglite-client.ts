// PGlite-backed SqlClient (in-process WASM PostgreSQL). This is the ONLY file
// that imports a concrete database driver; everything else composes against the
// SqlClient/SqlExecutor seam in ./sql.ts. A real node-postgres pool implements
// the same interface for CI/prod — see PgPoolClient (S2+/CI) when Docker is
// available. PGlite gives genuine PostgreSQL DDL semantics (composite FKs,
// partial unique indexes, transactional DDL) without a Docker daemon, so the
// tenancy/lease/migration guarantees are exercised for real, not faked.

import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { SqlClient, SqlExecutor, SqlParam, SqlResult } from './sql.js';

function toResult(r: { rows: unknown[]; affectedRows?: number }): SqlResult {
  const rows = (r.rows ?? []) as SqlResult['rows'];
  // A SELECT reports affectedRows: 0 with rows populated, so `affectedRows ?? …`
  // would wrongly yield 0 (0 is not nullish). Prefer the row count when any rows
  // came back; fall back to affectedRows only for writes (INSERT/UPDATE/DELETE).
  const rowCount = rows.length > 0 ? rows.length : (r.affectedRows ?? 0);
  return { rows, rowCount };
}

// db.exec runs the simple-query protocol and returns one result PER statement
// in the script. For a single query we mirror db.query; for a multi-statement
// migration the caller only cares that it ran (no rows consumed), so we surface
// the LAST statement's rows/affectedRows — matching node-postgres, whose
// pool.query(multiStatement) also returns the final command's result.
function toExecResult(results: Array<{ rows?: unknown[]; affectedRows?: number }>): SqlResult {
  const last = results.length > 0 ? results[results.length - 1]! : { rows: [], affectedRows: 0 };
  const rows = (last.rows ?? []) as SqlResult['rows'];
  const rowCount = last.affectedRows ?? rows.length;
  return { rows, rowCount };
}

// PGlite runs one statement at a time on a single in-process connection, so a
// transaction is a straightforward BEGIN/COMMIT with ROLLBACK on throw. There
// is no connection pool to check out — the single instance IS the connection.
//
// Each instance would otherwise compile its own copy of the PostgreSQL
// WebAssembly modules. A test process opens dozens of instances, and compiling
// and later freeing that much wasm code has aborted V8 outright ("Check failed:
// end > addr"). The modules and the filesystem bundle are compiled and read
// once per process and shared; every instance still gets its own memory and its
// own database.
interface PgliteArtifacts {
  readonly pgliteWasmModule: WebAssembly.Module;
  readonly initdbWasmModule: WebAssembly.Module;
  readonly fsBundle: Blob;
}

let sharedArtifacts: Promise<PgliteArtifacts> | undefined;

function pgliteArtifacts(): Promise<PgliteArtifacts> {
  sharedArtifacts ??= (async () => {
    const dist = new URL('.', import.meta.resolve('@electric-sql/pglite'));
    const [pglite, initdb, data] = await Promise.all([
      readFile(new URL('pglite.wasm', dist)),
      readFile(new URL('initdb.wasm', dist)),
      readFile(new URL('pglite.data', dist)),
    ]);
    const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
      WebAssembly.compile(pglite), WebAssembly.compile(initdb),
    ]);
    return { pgliteWasmModule, initdbWasmModule, fsBundle: new Blob([data]) };
  })();
  return sharedArtifacts;
}

export class PgliteClient implements SqlClient {
  private constructor(private readonly db: PGlite) {}

  static async create(dataDir?: string): Promise<PgliteClient> {
    const db = new PGlite({ ...(dataDir ? { dataDir } : {}), ...(await pgliteArtifacts()) });
    await db.waitReady;
    return new PgliteClient(db);
  }

  // A parameterized statement goes through the extended-query protocol
  // (db.query, one command only). A no-param statement may be a multi-statement
  // DDL script (a migration), which the extended protocol rejects with
  // "cannot insert multiple commands into a prepared statement" (SQLSTATE
  // 42601); db.exec runs it via the simple-query protocol, exactly as
  // node-postgres `pool.query(text)` accepts a multi-statement string. We route
  // on presence of params so both backends behave identically.
  async query(text: string, params: readonly SqlParam[] = []): Promise<SqlResult> {
    if (params.length === 0) return toExecResult(await this.db.exec(text));
    return toResult(await this.db.query(text, params as unknown[]));
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.db.exec('BEGIN');
    try {
      const tx: SqlExecutor = {
        query: async (t, p = []) =>
          p.length === 0
            ? toExecResult(await this.db.exec(t))
            : toResult(await this.db.query(t, p as unknown[])),
      };
      const out = await fn(tx);
      await this.db.exec('COMMIT');
      return out;
    } catch (err) {
      await this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Readiness probe: run a trivial statement and report success. Any error
  // (backend down, connection lost) surfaces as `false`, never throws.
  async ping(): Promise<boolean> {
    try {
      await this.db.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
