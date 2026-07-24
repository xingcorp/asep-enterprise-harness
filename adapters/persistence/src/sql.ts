// SQL-executor seam (disp: no `pg` import leaks past this adapter). The whole
// persistence layer talks to this minimal interface, so an in-process pglite
// (tests / no-Docker dev) and a real node-postgres `pg.Pool` (CI / prod) are
// both drop-in — nothing above this file knows which backend is live.

export type SqlParam = string | number | boolean | null | Uint8Array;

export interface SqlRow {
  readonly [column: string]: unknown;
}

export interface SqlResult {
  readonly rows: readonly SqlRow[];
  readonly rowCount: number;
}

// A thing that can run a parameterized statement. Params are ALWAYS bound
// ($1,$2,…), never string-interpolated, so the seam is injection-safe by
// construction.
export interface SqlExecutor {
  query(text: string, params?: readonly SqlParam[]): Promise<SqlResult>;
}

// A client that additionally runs a function inside a single BEGIN..COMMIT
// (ROLLBACK on throw). The callback receives an executor bound to that one
// transactional connection — the node-postgres pooling contract.
export interface SqlClient extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  // A dependency-free readiness probe. Returns true when the backend answers a
  // trivial statement. Lives on the seam so a composition root can wire a
  // readiness check WITHOUT authoring raw SQL of its own (arch discipline).
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// A well-known error the repositories throw on an optimistic-concurrency miss
// (WHERE id=$ AND version=$ matched zero rows). Callers can branch on it.
export class OptimisticConcurrencyError extends Error {
  constructor(entity: string, id: string, expectedVersion: number) {
    super(
      `optimistic-concurrency conflict on ${entity}:${id} ` +
        `(expected version ${expectedVersion}; row was modified or absent)`,
    );
    this.name = 'OptimisticConcurrencyError';
  }
}

// Thrown when a scoped read/write resolves to a row outside the caller's
// TenantScope, or to no row at all — an IDOR attempt fails closed here.
export class ScopeViolationError extends Error {
  constructor(entity: string, id: string) {
    super(`scope violation: ${entity}:${id} is not visible in this TenantScope`);
    this.name = 'ScopeViolationError';
  }
}
