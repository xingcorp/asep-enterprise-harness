#!/usr/bin/env node
// Integration gate CLI (disp. P2-FINAL-HIGH-001). The REAL-backend proof that is
// deliberately SEPARATE from `pnpm test`:
//
//   * `pnpm test` runs the fast *.test.ts unit/PGlite suites and NEVER touches a
//     container — it must stay green on any dev laptop.
//   * `pnpm test:integration` (this script) provisions digest-pinned PostgreSQL
//     and MinIO, HEALTH-CHECKS them, then runs the *.itest.ts suites against the
//     live backends with ASEP_PG_URL / S3 env pointing at them.
//
// The gate FAILS CLOSED (exit non-zero, loud message) — never a silent skip —
// when: docker is unavailable, an image is not digest-pinned, a backend never
// becomes healthy, zero itest files are discovered, a required SUITE-ID marker
// is missing, or any suite fails. Containers are always torn down in `finally`.
//
// Usage:
//   node scripts/integration/run-integration.mjs
//   pnpm test:integration

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { IMAGES } from './images.mjs';
import {
  resolveDocker, runContainer, removeContainer, waitReady, loopbackPublish, LOOPBACK_HOST,
  discoverItestFiles, missingRequiredItestSuites, REQUIRED_ITEST_SUITES,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const PG_NAME = `asep-itest-pg-${process.pid}`;
const MINIO_NAME = `asep-itest-minio-${process.pid}`;
const PG_PORT = process.env.ASEP_ITEST_PG_PORT ?? '55440';
const MINIO_PORT = process.env.ASEP_ITEST_MINIO_PORT ?? '59000';
const PG_USER = 'asep';
const PG_PASSWORD = 'asep-itest';
const PG_DB = 'asep';
const MINIO_USER = 'asepminio';
const MINIO_PASSWORD = 'asepminio-secret';

// ---------------------------------------------------------------------------
// Fault-injection hooks for the gate's OWN negative tests (disp.
// P2-FINAL-HIGH-001). HIGH-001 demands proof that a MISSING backend turns the
// required job RED rather than skipping. The only honest way to prove that is to
// actually run this CLI with a backend deliberately absent and observe a
// non-zero exit, so the absence is injectable:
//
//   ASEP_ITEST_OMIT_BACKEND=postgres,minio  — do NOT start those containers; the
//       health check must then fail the gate (never skip it).
//   ASEP_ITEST_DOCKER_BIN=/nonexistent/docker — probe this binary FIRST, so a
//       bogus value proves "no docker → RED".
//   ASEP_ITEST_HEALTH_ATTEMPTS=n — shrink the readiness budget so a negative
//       test fails fast instead of burning the full 40s. Per-backend overrides
//       (ASEP_ITEST_PG_HEALTH_ATTEMPTS / ASEP_ITEST_MINIO_HEALTH_ATTEMPTS) exist
//       because the negative tests need ASYMMETRIC budgets: the "MinIO missing"
//       case must still let the REAL PostgreSQL it started become healthy (cold
//       postgres init takes several seconds) so the run actually REACHES the
//       MinIO health check it is meant to prove. With one global 2-attempt
//       budget the run died on the PG check instead and proved nothing about
//       MinIO — the failure mode this knob removes.
//
// These only ever make the gate STRICTER (they can cause a red, never a green),
// so they cannot be abused to fake a pass: a backend that is genuinely required
// must still become healthy on its own budget or the gate goes RED.
const OMITTED_BACKENDS = new Set(
  (process.env.ASEP_ITEST_OMIT_BACKEND ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const HEALTH_ATTEMPTS = Number(process.env.ASEP_ITEST_HEALTH_ATTEMPTS ?? '40');
const PG_HEALTH_ATTEMPTS = Number(
  process.env.ASEP_ITEST_PG_HEALTH_ATTEMPTS ?? HEALTH_ATTEMPTS,
);
const MINIO_HEALTH_ATTEMPTS = Number(
  process.env.ASEP_ITEST_MINIO_HEALTH_ATTEMPTS ?? HEALTH_ATTEMPTS,
);

function fail(msg) {
  process.stderr.write(`integration-gate: FAIL — ${msg}\n`);
  return 1;
}

async function pgReady(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

async function main() {
  const dockerCandidates = process.env.ASEP_ITEST_DOCKER_BIN
    ? [process.env.ASEP_ITEST_DOCKER_BIN]
    : undefined;
  const docker = dockerCandidates ? resolveDocker(dockerCandidates) : resolveDocker();
  if (!docker) {
    return fail(
      'no working docker binary found — the integration gate REQUIRES a real ' +
        'PostgreSQL + MinIO backend and refuses to skip (P2-FINAL-HIGH-001)',
    );
  }
  process.stdout.write(`integration-gate: docker ${docker.serverVersion} at ${docker.bin}\n`);

  // Discover itest suites BEFORE paying for containers; zero is a fail-closed bug.
  const files = discoverItestFiles(REPO_ROOT);
  if (files.length === 0) {
    return fail(
      'discovered ZERO *.itest.ts files; refusing to report success by running ' +
        'nothing (P2-FINAL-HIGH-001)',
    );
  }
  process.stdout.write(`integration-gate: ${files.length} itest suite(s) discovered\n`);

  // Clean any stale containers from a previous crashed run.
  removeContainer(docker.bin, PG_NAME);
  removeContainer(docker.bin, MINIO_NAME);

  const pgUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@${LOOPBACK_HOST}:${PG_PORT}/${PG_DB}`;
  const s3Endpoint = `http://${LOOPBACK_HOST}:${MINIO_PORT}`;

  try {
    if (OMITTED_BACKENDS.has('postgres')) {
      process.stdout.write('integration-gate: PostgreSQL DELIBERATELY OMITTED (negative test)\n');
    } else {
      process.stdout.write(`integration-gate: starting PostgreSQL (${IMAGES.postgres})\n`);
      runContainer(docker.bin, {
        image: IMAGES.postgres,
        name: PG_NAME,
        env: { POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB },
        ports: [loopbackPublish(PG_PORT, 5432)],
      });
    }

    if (OMITTED_BACKENDS.has('minio')) {
      process.stdout.write('integration-gate: MinIO DELIBERATELY OMITTED (negative test)\n');
    } else {
      process.stdout.write(`integration-gate: starting MinIO (${IMAGES.minio})\n`);
      runContainer(docker.bin, {
        image: IMAGES.minio,
        name: MINIO_NAME,
        env: { MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD },
        ports: [loopbackPublish(MINIO_PORT, 9000)],
        args: ['server', '/data'],
      });
    }

    const pgOk = await waitReady(() => pgReady(pgUrl), {
      attempts: PG_HEALTH_ATTEMPTS, intervalMs: 1000,
    });
    if (!pgOk) return fail(`PostgreSQL never became healthy at ${pgUrl}`);
    process.stdout.write('integration-gate: PostgreSQL healthy\n');

    const minioOk = await waitReady(async () => {
      const r = await fetch(`${s3Endpoint}/minio/health/live`).catch(() => null);
      return !!r && r.ok;
    }, { attempts: MINIO_HEALTH_ATTEMPTS, intervalMs: 1000 });
    if (!minioOk) return fail(`MinIO never became healthy at ${s3Endpoint}`);
    process.stdout.write('integration-gate: MinIO healthy\n');

    // Run the itest suites in ONE shell-free child with live-backend env.
    const args = ['--import', 'tsx', '--test', ...files];
    const child = spawnSync(process.execPath, args, {
      cwd: REPO_ROOT,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        ASEP_PG_URL: pgUrl,
        ASEP_S3_ENDPOINT: s3Endpoint,
        ASEP_S3_ACCESS_KEY: MINIO_USER,
        ASEP_S3_SECRET_KEY: MINIO_PASSWORD,
        ASEP_S3_REGION: 'us-east-1',
      },
    });
    const stdout = child.stdout ?? '';
    const stderr = child.stderr ?? '';
    process.stdout.write(stdout);
    process.stderr.write(stderr);

    if (child.error) return fail(`could not launch itest child: ${child.error.message}`);

    const combined = stdout + stderr;
    const missing = missingRequiredItestSuites(combined).map(({ id, file }) => `${id} (${file})`);
    let code = typeof child.status === 'number' ? child.status : 1;
    if (missing.length > 0) {
      process.stderr.write(
        'integration-gate: FAIL — required itest suite(s) did not run:\n' +
          missing.map((m) => `  - ${m}`).join('\n') + '\n',
      );
      if (code === 0) code = 1;
      return code;
    }
    if (code === 0) {
      process.stdout.write(
        `\nintegration-gate: PASS (${files.length} itest file(s), ` +
          `${Object.keys(REQUIRED_ITEST_SUITES).length} required suite(s) verified)\n`,
      );
    }
    return code;
  } finally {
    removeContainer(docker.bin, PG_NAME);
    removeContainer(docker.bin, MINIO_NAME);
    process.stdout.write('integration-gate: containers torn down\n');
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`integration-gate: FAIL — ${err?.stack ?? err}\n`);
  process.exit(1);
});
