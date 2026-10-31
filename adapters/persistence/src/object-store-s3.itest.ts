// S3 object-store suite (disp. P2-REREVIEW-MED-NEW-001, exit D7). The prior
// gate only HEALTH-CHECKED its object store and then ran every artifact test on
// the filesystem backend — so a broken S3 PUT/GET/create-only/checksum path
// could never turn the required gate red. This suite drives the SAME
// ObjectStore contract against a REAL bucket of the gate's S3-compatible server
// (scripts/integration/images.mjs):
//
//   - putIfAbsent then get round-trips the exact bytes;
//   - a create-only write of DIFFERENT bytes to an existing key is REFUSED
//     (ObjectExistsError), never an overwrite (D7), and of writers racing for
//     one key exactly one lands;
//   - a byte-identical re-write is a benign idempotent no-op;
//   - exists() reflects presence/absence;
//   - the server keeps the checksum a write carries and refuses bytes that do
//     not match it.
//
// This is *.itest.ts so it runs ONLY under the integration gate, which
// provisions the object store first (P2-FINAL-HIGH-001). It fails closed
// (throws) if the ASEP_S3_* env is unset — it never silently skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import {
  S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3ObjectStore, ObjectExistsError, ObjectNotFoundError } from './object-store.js';
import { requireS3Config } from './itest-support.js';

console.log('SUITE-ID: asep-suite:object-store-s3');

const cfg = requireS3Config();
// A unique bucket per run so parallel/re-run suites never collide.
const bucket = `asep-artifacts-${createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 16)}`;

// A client of the server itself, beside the store under test.
function rawClient(): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,
  });
}

async function ensureBucket(): Promise<void> {
  const client = rawClient();
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    // Every test calls ensureBucket(), so only the FIRST create can succeed —
    // the rest legitimately find the bucket already there. The server answers
    // those with BucketAlreadyOwnedByYou (S3 uses BucketAlreadyExists for
    // another owner, which would be a real failure). Treating "we already own
    // it" as success keeps the helper idempotent; anything else still fails
    // closed.
    const name = (err as { name?: string }).name ?? '';
    if (name !== 'BucketAlreadyOwnedByYou') throw err;
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

test('MED-NEW-001: putIfAbsent then get round-trips exact bytes on the real S3 server', async () => {
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

test('of create-only writers racing for one key with different bytes, exactly one lands', async () => {
  await ensureBucket();
  const s = store();
  const key = `org1/proj1/sha256/${'c'.repeat(64)}`;
  const payloads = Array.from({ length: 8 }, (_, i) => new TextEncoder().encode(`writer ${i}`));
  const outcomes = await Promise.allSettled(payloads.map((bytes) => s.putIfAbsent(key, bytes)));
  const landed = outcomes.flatMap((o, i) => (o.status === 'fulfilled' ? [i] : []));
  assert.equal(landed.length, 1, `exactly one write lands: ${JSON.stringify(outcomes.map((o) => o.status))}`);
  for (const o of outcomes) {
    if (o.status === 'rejected') assert.ok(o.reason instanceof ObjectExistsError, String(o.reason));
  }
  assert.deepEqual(await s.get(key), payloads[landed[0]!], 'the key holds the bytes of the write that landed');
});

test('the server keeps the CRC32 a write carries, and refuses bytes that do not match their checksum', async () => {
  await ensureBucket();
  const s = store();
  const bytes = new TextEncoder().encode('checksummed payload\n');
  const key = keyFor(bytes);
  // The store's own write: the SDK sends the bytes' CRC32 with them.
  await s.putIfAbsent(key, bytes);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(bytes));
  const client = rawClient();
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
    await out.Body?.transformToByteArray();
    assert.equal(out.ChecksumCRC32, crc.toString('base64'), 'the server returns the CRC32 the write carried');

    const corrupt = `org1/proj1/sha256/${'d'.repeat(64)}`;
    await assert.rejects(
      () => client.send(new PutObjectCommand({ Bucket: bucket, Key: corrupt, Body: bytes, ChecksumCRC32: 'AAAAAA==' })),
      (err: { name?: string; $metadata?: { httpStatusCode?: number } }) =>
        err.$metadata?.httpStatusCode === 400 && /BadDigest|ChecksumMismatch/.test(err.name ?? ''),
      'bytes that do not match their checksum are refused',
    );
    assert.equal(await s.exists(corrupt), false, 'and nothing is stored under the key');
  } finally {
    client.destroy();
  }
});
