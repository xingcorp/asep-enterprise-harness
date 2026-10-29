// EvidenceStore port impl — preallocated-id evidence persistence (disp.
// P2-PLAN-HIGH-008, exit criterion D8). The canonical EvidenceBundle.resultSha
// must equal the FINAL harness commit SHA. A content-addressed id would depend
// on the bundle bytes, which depend on the commit SHA — a cycle. We break it by
// PREALLOCATING a non-content-derived ULID BEFORE the commit; the commit embeds
// that id in its ASEP-Evidence trailer, then the serialized bundle (now
// carrying the resulting commit SHA) is stored at the preallocated id AFTER the
// commit but BEFORE the push.
//
// Bytes live in the same content-addressed ObjectStore as every other artifact
// (dedup + create-only + re-hash-on-read all reused); a small `evidence_index`
// concept is unnecessary because the preallocated id maps to a metadata row via
// the artifacts table. putEvidence is IDEMPOTENT at the preallocated id:
//   - first store: writes the bundle bytes + an artifacts row keyed to the
//     preallocated id;
//   - re-store of BYTE-IDENTICAL bundle at the same id: no-op success (a crash
//     between commit and evidence persistence recovers without a second commit);
//   - store of DIFFERENT bytes at an existing id: FAILS CLOSED (an evidence id
//     is immutable once written).

import { createHash } from 'node:crypto';
import type {
  TenantScope, ArtifactId, ArtifactRef, EvidenceBundle,
} from '@asep/contracts';
import type { EvidenceStore } from '@asep/ports';
import type { SqlClient } from './sql.js';
import { ScopeViolationError } from './sql.js';
import type { ObjectStore } from './object-store.js';
import { ObjectExistsError } from './object-store.js';
import { ulid } from './ulid.js';

const EVIDENCE_KIND = 'evidence-bundle';
const EVIDENCE_CONTENT_TYPE = 'application/json';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Deterministic serialization so a re-store of the same logical bundle produces
// byte-identical content (idempotent putEvidence). Keys are emitted in a fixed
// order; the bundle shape is closed so this is total.
function serialize(bundle: EvidenceBundle): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(bundle));
}

// Preallocated evidence bytes are namespaced like every other artifact, but at
// a key derived from the PREALLOCATED id (not the content hash) so the commit
// trailer's id is the stable handle. The content sha256 is still recorded for
// re-hash-on-read integrity.
function evidenceKey(scope: TenantScope, id: ArtifactId): string {
  return `${scope.organizationId}/${scope.projectId}/evidence/${id}`;
}

export class EvidenceImmutabilityError extends Error {
  constructor(id: string) {
    super(`evidence id ${id} already holds different bytes — evidence is immutable (fail closed)`);
    this.name = 'EvidenceImmutabilityError';
  }
}

export class EvidenceNotFoundError extends Error {
  constructor(id: string) {
    super(`evidence not visible in this scope: ${id}`);
    this.name = 'EvidenceNotFoundError';
  }
}

export class ContentAddressedEvidenceStore implements EvidenceStore {
  constructor(
    private readonly client: SqlClient,
    private readonly objects: ObjectStore,
  ) {}

  // Preallocate a non-content-derived id BEFORE the commit (exit D8). A ULID is
  // used so the id is unique and sortable without depending on the bundle bytes.
  allocateEvidenceId(): ArtifactId {
    return ulid() as ArtifactId;
  }

  async putEvidence(scope: TenantScope, id: ArtifactId, bundle: EvidenceBundle): Promise<ArtifactRef> {
    const bytes = serialize(bundle);
    const sha256 = sha256Hex(bytes);
    const key = evidenceKey(scope, id);

    // If a metadata row already exists at this preallocated id, this is a retry.
    // Byte-identical → no-op success; different bytes → fail closed (immutable).
    const existing = await this.client.query(
      `select sha256 from artifacts
       where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (existing.rowCount > 0) {
      if ((existing.rows[0]!['sha256'] as string) !== sha256) {
        throw new EvidenceImmutabilityError(id);
      }
      // Reconcile the object bytes (create-only, byte-identical) and return.
      await this.objects.putIfAbsent(key, bytes);
      return { artifactId: id, sha256, kind: EVIDENCE_KIND };
    }

    // Write the object FIRST (create-only). A create-only collision with
    // DIFFERENT bytes means another writer bound this id to other content —
    // fail closed.
    try {
      await this.objects.putIfAbsent(key, bytes);
    } catch (err) {
      if (err instanceof ObjectExistsError) throw new EvidenceImmutabilityError(id);
      throw err;
    }

    // Commit the metadata row at the PREALLOCATED id (not a generated one) so
    // the commit trailer's id resolves here. If this fails, the object is an
    // orphan reconcilable by a byte-identical retry; we do not claim success.
    await this.client.query(
      `insert into artifacts
         (id, organization_id, project_id, attempt_id, kind, sha256, size_bytes, storage_key, content_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id, scope.organizationId, scope.projectId, bundle.attemptId,
        EVIDENCE_KIND, sha256, bytes.byteLength, key, EVIDENCE_CONTENT_TYPE,
      ],
    );
    return { artifactId: id, sha256, kind: EVIDENCE_KIND };
  }

  async getEvidence(scope: TenantScope, id: ArtifactId): Promise<EvidenceBundle> {
    const r = await this.client.query(
      `select storage_key, sha256 from artifacts
       where id = $1 and organization_id = $2 and project_id = $3 and kind = $4`,
      [id, scope.organizationId, scope.projectId, EVIDENCE_KIND],
    );
    if (r.rowCount === 0) throw new EvidenceNotFoundError(id);
    const row = r.rows[0]!;
    const bytes = await this.objects.get(row['storage_key'] as string);
    // Re-hash on read: a mutated byte fails closed (D3 parity for evidence).
    const actual = sha256Hex(bytes);
    if (actual !== (row['sha256'] as string)) {
      throw new EvidenceImmutabilityError(id);
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as EvidenceBundle;
  }
}

export { ScopeViolationError };
