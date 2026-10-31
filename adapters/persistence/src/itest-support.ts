// Integration-test support (disp. P2-FINAL-HIGH-001 / MED-001). Shared wiring
// for the *.itest.ts suites that run against a REAL, digest-pinned PostgreSQL
// provisioned by scripts/integration/run-integration.mjs.
//
// The unit test runner (scripts/run-canonical-tests.mjs) discovers only
// *.test.ts, so these *.itest.ts suites NEVER run under `pnpm test` — they run
// ONLY under the integration gate, which brings up the backend first. That is
// the whole point of HIGH-001: the integration proof is a separate gate that
// provisions real services and goes RED when they are absent, not a marker that
// silently passes on a host with no database.
//
// FAIL-CLOSED CONTRACT: requirePgUrl() THROWS when ASEP_PG_URL is unset. An
// integration suite that cannot see its backend must abort loudly, never skip.
// The negative tests in run-integration.test.ts prove that pointing the gate at
// a dead backend turns it RED.

import { Pool } from 'pg';
import { PgPoolClient } from './pg-pool-client.js';
import { migrate } from './migrator.js';
import type { SqlClient } from './sql.js';

// The env var the integration gate sets to the live PostgreSQL DSN. Unset in a
// normal unit run — requirePgUrl() throws so a misrouted suite fails closed.
export const PG_URL_ENV = 'ASEP_PG_URL';

export function requirePgUrl(): string {
  const url = process.env[PG_URL_ENV];
  if (!url || url.trim() === '') {
    throw new Error(
      `${PG_URL_ENV} is not set — an integration suite requires a real ` +
        `PostgreSQL backend. This suite must run under the integration gate ` +
        `(scripts/integration/run-integration.mjs), never bare. Failing closed ` +
        `rather than skipping (P2-FINAL-HIGH-001).`,
    );
  }
  return url;
}

// A pg.Pool with a bounded `max` so tests can force real cross-connection
// contention (advisory-lock hand-off, partial-unique-index race) rather than
// serializing onto one connection the way PGlite does.
export function makePool(max: number): Pool {
  return new Pool({ connectionString: requirePgUrl(), max });
}

// A fully-migrated SqlClient over a fresh pool. Each call is independent so a
// suite can hold >= 2 clients pointed at the SAME database to prove
// multi-connection semantics.
export async function migratedClient(max = 4): Promise<{ client: SqlClient; pool: Pool }> {
  const pool = makePool(max);
  const client = PgPoolClient.fromPool(pool);
  await migrate(client);
  return { client, pool };
}

// The env vars the integration gate sets to the live MinIO/S3 backend (disp.
// P2-REREVIEW-MED-NEW-001). Unset in a normal unit run — requireS3Config()
// throws so a misrouted artifact suite fails closed rather than skipping.
export const S3_ENV = {
  endpoint: 'ASEP_S3_ENDPOINT',
  accessKey: 'ASEP_S3_ACCESS_KEY',
  secretKey: 'ASEP_S3_SECRET_KEY',
  region: 'ASEP_S3_REGION',
} as const;

export interface ItestS3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function requireS3Config(): ItestS3Config {
  const endpoint = process.env[S3_ENV.endpoint];
  const accessKeyId = process.env[S3_ENV.accessKey];
  const secretAccessKey = process.env[S3_ENV.secretKey];
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `${S3_ENV.endpoint}/${S3_ENV.accessKey}/${S3_ENV.secretKey} are not set — ` +
        `the artifact object-store suite requires a real S3-compatible backend. ` +
        `This suite must run under the integration gate, never bare. ` +
        `Failing closed rather than skipping (P2-REREVIEW-MED-NEW-001).`,
    );
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: process.env[S3_ENV.region] ?? 'us-east-1',
  };
}
