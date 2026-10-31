// Object-store seam for artifact BYTES (metadata rows live in PostgreSQL via the
// artifacts table). The whole artifact store composes against this minimal
// interface so a filesystem backend (tests / no-Docker dev) and an
// S3-compatible backend (S3 parity) are drop-in — nothing above knows
// which is live. Keys are content-addressed and tenant-namespaced by the
// artifact store; this seam only stores/reads opaque bytes at an opaque key.
//
// The write is CONDITIONAL CREATE-ONLY (disp. P2-PLAN-HIGH-004): a second write
// to an existing key with DIFFERENT bytes must fail, never overwrite. On the
// filesystem this is O_EXCL; on S3 it is `If-None-Match: *`. A create-only write
// of byte-identical content is a benign no-op (idempotent retry), so the caller
// can safely retry a put after a crash between object write and metadata commit.

import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class ObjectExistsError extends Error {
  constructor(key: string) {
    super(`object key already exists with different bytes: ${key}`);
    this.name = 'ObjectExistsError';
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

export interface ObjectStore {
  // Create-only write. Resolves when the key holds exactly `bytes`. Throws
  // ObjectExistsError if the key already holds DIFFERENT bytes. A repeat write
  // of identical bytes is a no-op (idempotent).
  putIfAbsent(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
}

// Filesystem object store. Content is written to a temp file then atomically
// renamed into place; the rename only wins if the destination does not already
// exist (checked under the create-only contract). Byte-identical re-writes are
// tolerated so a retried put after a partial failure converges.
export class FilesystemObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    // key is already sanitized/namespaced by the artifact store; join under root.
    return join(this.root, key);
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<void> {
    const dest = this.pathFor(key);
    // Fast path: destination already present. Enforce create-only by comparing
    // bytes — identical is a benign idempotent retry, different is a collision.
    if (await this.exists(key)) {
      const existing = await readFile(dest);
      if (Buffer.compare(existing, Buffer.from(bytes)) === 0) return;
      throw new ObjectExistsError(key);
    }
    await mkdir(dirname(dest), { recursive: true });
    // Write to a unique temp file, then O_EXCL-guard the final placement: open
    // the destination with 'wx' (fail if exists) to win the create race, and if
    // two writers race, the loser sees EEXIST and re-checks bytes.
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await (await open(tmp, 'w')).close().catch(() => undefined);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tmp, bytes);
    try {
      // 'wx' create-only handle proves we won the race for the final key.
      const handle = await open(dest, 'wx');
      await handle.close();
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      if ((err as { code?: string }).code === 'EEXIST') {
        // Lost the race — converge on the create-only contract by byte compare.
        const existing = await readFile(dest);
        if (Buffer.compare(existing, Buffer.from(bytes)) === 0) return;
        throw new ObjectExistsError(key);
      }
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(key));
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return false;
      throw err;
    }
  }
}

// S3-compatible object store (the integration gate's S3-compatible server, S3
// in prod parity), disp. P2-REREVIEW-MED-NEW-001. The prior gate only
// HEALTH-CHECKED its object store and then ran every artifact test on the
// filesystem backend — so a broken S3 PUT/GET/create-only path could never turn
// the gate red. This adapter drives the SAME ObjectStore contract against a
// real bucket so the artifact suite exercises the S3 path for real.
//
// Create-only (D7): a PutObject with `IfNoneMatch: '*'` fails with
// PreconditionFailed / 412 when the key already exists, so a second write to an
// existing key NEVER overwrites. A byte-identical re-write is treated as a
// benign idempotent no-op (matching the filesystem backend) by comparing the
// stored bytes when the conditional put is refused; different bytes at an
// existing key throw ObjectExistsError.
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';

export interface S3ObjectStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

function isS3Status(err: unknown, status: number): boolean {
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const name = (err as { name?: string }).name ?? '';
  return meta?.httpStatusCode === status
    || (status === 412 && name === 'PreconditionFailed')
    || (status === 404 && (name === 'NotFound' || name === 'NoSuchKey'));
}

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  // The AWS SDK v3 Node stream exposes an async iterator of Buffer chunks.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3ObjectStoreConfig) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // Self-hosted S3 servers address buckets by path, not by virtual host.
      forcePathStyle: true,
    });
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        IfNoneMatch: '*',
      }));
    } catch (err) {
      // Key already exists: converge on the create-only contract by byte compare
      // — identical bytes are an idempotent retry, different bytes a collision.
      if (isS3Status(err, 412)) {
        const existing = await this.get(key);
        if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) === 0) return;
        throw new ObjectExistsError(key);
      }
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) throw new ObjectNotFoundError(key);
      return await streamToBytes(out.Body);
    } catch (err) {
      if (isS3Status(err, 404)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isS3Status(err, 404)) return false;
      throw err;
    }
  }
}
