// S3/MinIO object-store suite (disp. P2-REREVIEW-MED-NEW-001, exit D7). The
// prior gate only HEALTH-CHECKED MinIO and then ran every artifact test on the
// filesystem backend — so a broken S3 PUT/GET/create-only/checksum path could
// never turn the required gate red. This suite drives the SAME ObjectStore
// contract against a REAL bucket so MinIO is exercised for real:
//
//   - putIfAbsent then get round-trips the exact bytes;
//   - a create-only write of DIFFERENT bytes to an existing key is REFUSED
//     (ObjectExistsError), never an overwrite (D7);
//   - a byte-identical re-write is a benign idempotent no-op;
//   - exists() reflects presence/absence.
//
// This is *.itest.ts so it runs ONLY under the integration gate, which
// provisions MinIO first (P2-FINAL-HIGH-001). It fails closed (throws) if the
// ASEP_S3_* env is unset — it never silently skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3ObjectStore, ObjectExistsError, ObjectNotFoundError } from './object-store.js';
import { requireS3Config } from './itest-support.js';

console.log('SUITE-ID: asep-suite:object-store-s3');

const cfg = requireS3Config();
// A unique bucket per run so parallel/re-run suites never collide.
const bucket = `asep-artifacts-${createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 16)}`;

async function ensureBucket(): Promise<void> {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

function store(): S3ObjectStore {
  return new S3ObjectStore({ ...cfg, bucket });
}

// A content-addressed key like the artifact store builds (org/project/sha256/<hex>).
function keyFor(bytes: Uint8Array): string {
  const sha = createHash('sha256').update(bytes).digest('hex');
  return `org1/proj1/sha256/${sha}`;
}

test('MED-NEW-001: putIfAbsent then get round-trips exact bytes on real MinIO', async () => {
  await ensureBucket();
  const s = store();
  const bytes = new TextEncoder().encode('evidence bundle payload\n');
  const key = keyFor(bytes);

  assert.equal(await s.exists(key), false, 'key absent before write');
  await s.putIfAbsent(key, bytes);
  assert.equal(await s.exists(key), true, 'key present after write');

  const back = await s.get(key);
  assert.equal(new TextDecoder().decode(back), 'evidence bundle payload\n');
});

test('MED-NEW-001 (D7): a create-only write of DIFFERENT bytes to an existing key is REFUSED', async () => {
  await ensureBucket();
  const s = store();
  // Two different payloads that (artificially) share a key, to prove the
  // create-only guard rejects an overwrite regardless of addressing.
  const key = `org1/proj1/sha256/${'a'.repeat(64)}`;
  await s.putIfAbsent(key, new TextEncoder().encode('first bytes'));

  await assert.rejects(
    () => s.putIfAbsent(key, new TextEncoder().encode('DIFFERENT bytes')),
    ObjectExistsError,
    'a different-bytes write to an existing key must fail closed, never overwrite',
  );
  // The original bytes are intact — no partial overwrite occurred.
  const back = await s.get(key);
  assert.equal(new TextDecoder().decode(back), 'first bytes');
});

test('MED-NEW-001: a byte-identical re-write is a benign idempotent no-op', async () => {
  await ensureBucket();
  const s = store();
  const bytes = new TextEncoder().encode('idempotent payload');
  const key = keyFor(bytes);
  await s.putIfAbsent(key, bytes);
  // Second identical write must NOT throw (retry-after-crash convergence).
  await s.putIfAbsent(key, bytes);
  const back = await s.get(key);
  assert.deepEqual(back, bytes);
});

test('MED-NEW-001: get on an absent key fails closed with ObjectNotFoundError', async () => {
  await ensureBucket();
  const s = store();
  await assert.rejects(
    () => s.get(`org1/proj1/sha256/${'b'.repeat(64)}`),
    ObjectNotFoundError,
  );
});
