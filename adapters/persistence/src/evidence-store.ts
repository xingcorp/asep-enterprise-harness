// EvidenceStore port impl — reserved-id evidence persistence (disp.
// P2-PLAN-HIGH-008, exit criterion D8). The canonical EvidenceBundle.resultSha
// must equal the FINAL harness commit SHA. A content-addressed id would depend
// on the bundle bytes, which depend on the commit SHA — a cycle. We break it by
// RESERVING a non-content-derived ULID BEFORE the commit; the commit embeds
// that id in its ASEP-Evidence trailer, then the serialized bundle (now
// carrying the resulting commit SHA) is stored at the reserved id AFTER the
// commit but BEFORE the push.
//
// The reservation (migration 0018) is a row of the attempt that carries the
// DRAFT — the bundle minus resultSha — as an 'evidence-draft' artifact. So the
// evidence is fixed before the commit, a crash between commit and evidence is
// recovered by completing the draft with the committed SHA, and putEvidence
// accepts nothing at a reserved id but that draft plus a resultSha.
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
  TenantScope, ArtifactId, ArtifactRef, EvidenceBundle, AttemptId, RepositoryBindingId,
} from '@asep/contracts';
import type { EvidenceStore, EvidenceDraft, EvidenceReservation } from '@asep/ports';
import { ContentAddressedArtifactStore } from './artifact-store.js';
import type { SqlClient } from './sql.js';
import { ScopeViolationError } from './sql.js';
import type { ObjectStore } from './object-store.js';
import { ObjectExistsError } from './object-store.js';
import { ulid } from './ulid.js';

const EVIDENCE_KIND = 'evidence-bundle';
const DRAFT_KIND = 'evidence-draft';
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

// The id was never reserved in this scope: there is no draft it could hold.
export class EvidenceNotReservedError extends Error {
  constructor(id: string) {
    super(`evidence id ${id} is not reserved in this scope — refusing to store or read evidence for it`);
    this.name = 'EvidenceNotReservedError';
  }
}

// The bundle offered at a reserved id is not that reservation's draft plus a
// resultSha: the evidence was fixed before the commit and cannot be rewritten.
export class EvidenceDraftMismatchError extends Error {
  constructor(id: string, reason: string) {
    super(`evidence for ${id} does not match its reserved draft: ${reason} (fail closed)`);
    this.name = 'EvidenceDraftMismatchError';
  }
}

// JSON with keys sorted at every level: equality of meaning, not of key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function draftOf(bundle: EvidenceBundle): EvidenceDraft {
  const { resultSha: _resultSha, ...draft } = bundle;
  return draft;
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

  // Reserve a non-content-derived id BEFORE the commit (exit D8), durably, with
  // the draft it will hold. A ULID is used so the id is unique and sortable
  // without depending on the bundle bytes.
  async reserveEvidence(scope: TenantScope, input: {
    readonly repositoryBindingId: RepositoryBindingId;
    readonly attemptId: AttemptId;
    readonly draft: EvidenceDraft;
  }): Promise<ArtifactId> {
    if (input.draft.attemptId !== input.attemptId) {
      throw new EvidenceDraftMismatchError('(new reservation)', `draft names attempt ${String(input.draft.attemptId)}`);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(input.draft));
    const draft = await new ContentAddressedArtifactStore(this.client, this.objects).put(scope, {
      kind: DRAFT_KIND, content: bytes, sha256: sha256Hex(bytes),
      contentType: EVIDENCE_CONTENT_TYPE, attemptId: input.attemptId,
    });
    const id = ulid() as ArtifactId;
    await this.client.query(
      `insert into evidence_reservations
         (id, organization_id, project_id, repository_binding_id, attempt_id, draft_artifact_id, draft_sha256)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id, scope.organizationId, scope.projectId, input.repositoryBindingId, input.attemptId,
        draft.artifactId, draft.sha256,
      ],
    );
    return id;
  }

  async getReservation(scope: TenantScope, id: ArtifactId): Promise<EvidenceReservation> {
    const r = await this.client.query(
      `select repository_binding_id, attempt_id, draft_artifact_id, draft_sha256
         from evidence_reservations
        where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new EvidenceNotReservedError(id);
    const row = r.rows[0]!;
    // Re-hashed on read by the artifact store; the reservation pins its sha256.
    const stream = await new ContentAddressedArtifactStore(this.client, this.objects).get(scope, {
      artifactId: row['draft_artifact_id'] as ArtifactId,
      sha256: row['draft_sha256'] as string,
      kind: DRAFT_KIND,
    });
    const draft = JSON.parse(new TextDecoder().decode(stream.content)) as EvidenceDraft;
    if (draft.attemptId !== row['attempt_id']) {
      throw new EvidenceDraftMismatchError(id, `draft names attempt ${String(draft.attemptId)}, reservation ${String(row['attempt_id'])}`);
    }
    return {
      evidenceId: id,
      repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
      attemptId: row['attempt_id'] as AttemptId,
      draft,
    };
  }

  async putEvidence(scope: TenantScope, id: ArtifactId, bundle: EvidenceBundle): Promise<ArtifactRef> {
    // Only the reserved draft, completed by a resultSha, may be stored here.
    const reservation = await this.getReservation(scope, id);
    if (canonical(draftOf(bundle)) !== canonical(reservation.draft)) {
      throw new EvidenceDraftMismatchError(id, 'the bundle differs from the draft in more than its resultSha');
    }
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

    // Write the object FIRST (create-only). A crash between this write and the
    // metadata insert below leaves an orphan object with no row. The retry
    // writes the same bytes — the draft fixed everything but the resultSha, and
    // the commit fixed that — so the create-only put is a byte-identical no-op
    // and the retry completes the insert. Different bytes at the key are not an
    // interrupted write of THIS evidence, whatever identity they claim, and are
    // never adopted.
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
