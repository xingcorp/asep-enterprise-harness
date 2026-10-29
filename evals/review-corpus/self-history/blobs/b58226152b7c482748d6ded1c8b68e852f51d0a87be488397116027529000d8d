// Content-addressed immutable artifact store (S3, exit criteria D2–D7). Bytes
// live in an ObjectStore (filesystem in tests, S3/MinIO in prod); metadata rows
// live in the PostgreSQL `artifacts` table (migration 0004). Implements the
// ArtifactStore port so the application composes against the port, never this.
//
// Guarantees:
//   D2 content-addressed: key = <org>/<project>/sha256/<sha256>, never a user path.
//   D3 verify() re-hashes on read; a mutated byte fails closed.
//   D4 identical bytes dedup (same sha → same key → create-only no-op + reused
//      metadata row); an object-write failure never leaves an accepted metadata
//      row; a metadata-commit failure never claims success.
//   D6 every op takes TenantScope; keys are tenant/project-namespaced; a
//      cross-scope get/verify/exists resolves to nothing and fails closed.
//   D7 object writes are conditional create-only; concurrent different-byte
//      writes to one key fail; size+checksum verified before metadata commit and
//      on every read; orphan (object written, metadata not committed) is a
//      byte-identical no-op for the next identical put and is reconcilable.

import { createHash } from 'node:crypto';
import type {
  ArtifactId, ArtifactRef, AttemptId, TenantScope,
} from '@asep/contracts';
import type {
  ArtifactStore, ArtifactPutInput, ArtifactStream, ArtifactVerification,
} from '@asep/ports';
import type { SqlClient, SqlExecutor } from './sql.js';
import { ScopeViolationError } from './sql.js';
import type { ObjectStore } from './object-store.js';
import { ulid } from './ulid.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class ArtifactChecksumError extends Error {
  constructor(expected: string, actual: string) {
    super(`artifact checksum mismatch: expected ${expected}, got ${actual} (fail closed)`);
    this.name = 'ArtifactChecksumError';
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`artifact not visible in this scope: ${id}`);
    this.name = 'ArtifactNotFoundError';
  }
}

// Tenant/project-namespaced, content-addressed key. Never derived from a
// user-supplied path (D2/D6). sha256 is validated hex so it cannot smuggle path
// separators.
function storageKey(scope: TenantScope, sha256: string): string {
  return `${scope.organizationId}/${scope.projectId}/sha256/${sha256}`;
}

const HEX64 = /^[0-9a-f]{64}$/;

export class ContentAddressedArtifactStore implements ArtifactStore {
  constructor(
    private readonly client: SqlClient,
    private readonly objects: ObjectStore,
  ) {}

  async put(scope: TenantScope, input: ArtifactPutInput): Promise<ArtifactRef> {
    // 1. Verify the caller's claimed checksum against the actual bytes BEFORE
    //    anything is written. A mismatch fails closed — we never store bytes
    //    under a key that does not match their hash.
    const actual = sha256Hex(input.content);
    if (!HEX64.test(input.sha256)) {
      throw new ArtifactChecksumError(input.sha256, actual);
    }
    if (actual !== input.sha256) {
      throw new ArtifactChecksumError(input.sha256, actual);
    }
    const sizeBytes = input.content.byteLength;
    const key = storageKey(scope, actual);

    // 2. Dedup: if a metadata row already exists for (scope, sha, kind), reuse
    //    it. Identical bytes must not create a second row (D4).
    const existing = await this.client.query(
      `select id from artifacts
       where organization_id = $1 and project_id = $2 and sha256 = $3 and kind = $4`,
      [scope.organizationId, scope.projectId, actual, input.kind],
    );
    if (existing.rowCount > 0) {
      // Ensure the object bytes are actually present (reconcile a prior metadata
      // row whose object may have been swept) — create-only, byte-identical.
      await this.objects.putIfAbsent(key, input.content);
      return { artifactId: existing.rows[0]!['id'] as ArtifactId, sha256: actual, kind: input.kind };
    }

    // 3. Write the object FIRST (create-only). If this throws, no metadata row
    //    is created — a failed object write never yields accepted metadata (D4).
    await this.objects.putIfAbsent(key, input.content);

    // 4. Commit the metadata row. If this fails, the object is an orphan: a
    //    byte-identical no-op for the next identical put, reconcilable by a
    //    sweep. We do NOT claim success (the error propagates).
    const id = ulid() as ArtifactId;
    await this.client.query(
      `insert into artifacts
         (id, organization_id, project_id, attempt_id, kind, sha256, size_bytes, storage_key, content_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id, scope.organizationId, scope.projectId, input.attemptId ?? null,
        input.kind, actual, sizeBytes, key, input.contentType,
      ],
    );
    return { artifactId: id, sha256: actual, kind: input.kind };
  }

  async get(scope: TenantScope, ref: ArtifactRef): Promise<ArtifactStream> {
    const row = await this.loadScopedRow(scope, ref.artifactId);
    const bytes = await this.objects.get(row.storageKey);
    // D3: re-hash on read; a mutated/corrupted byte fails closed.
    const actual = sha256Hex(bytes);
    if (actual !== row.sha256) throw new ArtifactChecksumError(row.sha256, actual);
    return {
      ref: { artifactId: ref.artifactId, sha256: row.sha256, kind: row.kind },
      content: bytes,
      sizeBytes: bytes.byteLength,
      contentType: row.contentType,
    };
  }

  async verify(scope: TenantScope, ref: ArtifactRef): Promise<ArtifactVerification> {
    const row = await this.loadScopedRow(scope, ref.artifactId);
    const bytes = await this.objects.get(row.storageKey);
    const actual = sha256Hex(bytes);
    const ok = actual === row.sha256 && bytes.byteLength === row.sizeBytes;
    return {
      ref: { artifactId: ref.artifactId, sha256: row.sha256, kind: row.kind },
      ok,
      actualSha256: actual,
      sizeBytes: bytes.byteLength,
    };
  }

  // Scoped metadata load: a row outside the caller's TenantScope resolves to
  // nothing and fails closed — project A cannot read/verify/infer B's object.
  private async loadScopedRow(scope: TenantScope, id: ArtifactId, db: SqlExecutor = this.client): Promise<{
    storageKey: string; sha256: string; sizeBytes: number; kind: string; contentType: string;
  }> {
    const r = await db.query(
      `select storage_key, sha256, size_bytes, kind, content_type
       from artifacts where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new ArtifactNotFoundError(id);
    const row = r.rows[0]!;
    return {
      storageKey: row['storage_key'] as string,
      sha256: row['sha256'] as string,
      sizeBytes: Number(row['size_bytes']),
      kind: row['kind'] as string,
      contentType: row['content_type'] as string,
    };
  }
}

export { ScopeViolationError };
export type { AttemptId };
