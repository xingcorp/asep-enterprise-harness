// Object-store seam for artifact BYTES (metadata rows live in PostgreSQL via the
// artifacts table). The whole artifact store composes against this minimal
// interface so a filesystem backend (tests / no-Docker dev) and an
// S3-compatible backend (MinIO/S3 parity) are drop-in — nothing above knows
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
