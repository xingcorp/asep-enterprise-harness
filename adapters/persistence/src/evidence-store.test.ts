// EvidenceStore integration suite (exit criterion D8). Runs against a REAL
// PostgreSQL engine (in-process PGlite) for metadata + a real temp-dir
// filesystem ObjectStore for bytes. Proves the reserved-id protocol:
//   - reserveEvidence() durably reserves a non-content-derived id BEFORE the
//     commit (so it can be embedded in the ASEP-Evidence trailer), holding the
//     draft — the bundle minus resultSha — for that attempt;
//   - putEvidence stores at that exact id only the draft plus a resultSha;
//   - re-storing the byte-identical bundle at the same id is a no-op success
//     (crash between commit and evidence persistence recovers, no 2nd commit);
//   - storing DIFFERENT bytes at an existing id FAILS CLOSED (immutable);
//   - getEvidence round-trips and re-hashes on read (a mutated byte fails).
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate
// RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteClient } from './pglite-client.js';
import { migrate } from './migrator.js';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
} from './repositories.js';
import { FilesystemObjectStore } from './object-store.js';
import { ContentAddressedArtifactStore } from './artifact-store.js';
import {
  ContentAddressedEvidenceStore, EvidenceImmutabilityError, EvidenceNotFoundError,
  EvidenceNotReservedError, EvidenceDraftMismatchError,
} from './evidence-store.js';
import type {
  TenantScope, AttemptId, TaskId, ArtifactId, EvidenceBundle, RepositoryBindingId,
} from '@asep/contracts';
import type { EvidenceDraft } from '@asep/ports';

console.log('SUITE-ID: asep-suite:evidence-store');

// A migrated DB + a temp object dir + a full org→project→binding→run→task→
// attempt chain, because artifacts.attempt_id is a composite FK into attempts.
async function fresh() {
  const client = await PgliteClient.create();
  await migrate(client);
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const attempts = new AttemptRepository(client);
  const org = await orgs.create({ name: 'Acme' });
  const proj = await projects.create({
    organizationId: org.id, name: 'web', defaultBranch: 'main',
  });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const binding = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
  });
  const run = await runs.create(scope, { repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0' });
  const task = await tasks.create(scope, { runId: run.id, repositoryBindingId: binding.id, risk: 'R0' });
  const attempt = await attempts.create(scope, { taskId: task.id, repositoryBindingId: binding.id });
  const dir = mkdtempSync(join(tmpdir(), 'asep-ev-'));
  const objects = new FilesystemObjectStore(dir);
  const store = new ContentAddressedEvidenceStore(client, objects);
  const taskId = task.id;
  const attemptId = attempt.id;
  // Reserve an id holding the draft of bundle(...) with these overrides.
  const reserve = (over: Partial<EvidenceBundle> = {}): Promise<ArtifactId> =>
    store.reserveEvidence(scope, {
      repositoryBindingId: binding.id, attemptId, draft: draftOf(bundle(taskId, attemptId, over)),
    });
  // Another attempt of the same task, for cross-attempt probes.
  const otherAttempt = async (): Promise<AttemptId> =>
    (await attempts.create(scope, { taskId: task.id, repositoryBindingId: binding.id })).id;
  return { client, scope, objects, store, dir, taskId, attemptId, bindingId: binding.id, reserve, otherAttempt };
}

function draftOf(b: EvidenceBundle): EvidenceDraft {
  const { resultSha: _r, ...draft } = b;
  return draft;
}

function bundle(taskId: TaskId, attemptId: AttemptId, overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    taskId,
    attemptId,
    baseSha: 'b'.repeat(40),
    resultSha: 'c'.repeat(40),
    createdAt: '2026-01-01T00:00:00.000Z',
    environment: { imageDigest: 'sha256:' + 'e'.repeat(64), lockfileHash: 'f'.repeat(64), nodeVersion: '20.0.0' },
    diff: { artifactId: 'art-diff' as ArtifactId, sha256: 'd'.repeat(64) },
    checks: [
      { id: 'L0', category: 'workspace', command: 'git status', exitCode: 0, durationMs: 5 },
    ],
    ...overrides,
  };
}

test('D8: reserveEvidence returns a non-content-derived id BEFORE any commit, holding its draft', async () => {
  const { client, scope, store, dir, attemptId, bindingId, reserve } = await fresh();
  const a = await reserve();
  const b = await reserve({ createdAt: '2026-02-02T00:00:00.000Z' });
  assert.notEqual(a, b, 'ids are unique');
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID-shaped');
  const r = await store.getReservation(scope, a);
  assert.equal(r.attemptId, attemptId);
  assert.equal(r.repositoryBindingId, bindingId);
  assert.equal(r.draft.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal((r.draft as Partial<EvidenceBundle>).resultSha, undefined, 'the draft has no resultSha');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: evidence is refused at an id that was never reserved', async () => {
  const { client, scope, store, dir, taskId, attemptId } = await fresh();
  await assert.rejects(
    () => store.putEvidence(scope, 'Z'.repeat(26) as ArtifactId, bundle(taskId, attemptId)),
    EvidenceNotReservedError,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: evidence that differs from its reserved draft in more than resultSha is refused', async () => {
  const { client, scope, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  for (const over of [
    { createdAt: '2026-06-30T12:00:00.000Z' },
    { checks: [{ id: 'L0', category: 'workspace' as const, command: 'true', exitCode: 0, durationMs: 1 }] },
    { baseSha: '8'.repeat(40) },
  ]) {
    await assert.rejects(
      () => store.putEvidence(scope, id, bundle(taskId, attemptId, over)),
      EvidenceDraftMismatchError, JSON.stringify(over),
    );
  }
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test("D8: a reservation names an attempt of the reserver's own tenant and binding", async () => {
  const { client, scope, store, dir, taskId, attemptId, bindingId } = await fresh();
  const other = await fresh();
  try {
    // Another tenant's attempt, reserved under this scope: refused by the DB.
    await assert.rejects(
      () => store.reserveEvidence(scope, {
        repositoryBindingId: bindingId, attemptId: other.attemptId,
        draft: draftOf(bundle(other.taskId, other.attemptId)),
      }),
      /foreign key|violates/i,
    );
    // This attempt under another binding: refused by the DB.
    const second = await new RepositoryBindingRepository(client).create(scope, {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'api', defaultBaseBranch: 'main',
    });
    await assert.rejects(
      () => store.reserveEvidence(scope, {
        repositoryBindingId: second.id as RepositoryBindingId, attemptId, draft: draftOf(bundle(taskId, attemptId)),
      }),
      /foreign key|violates/i,
    );
    // A draft for another attempt than the reservation's.
    await assert.rejects(
      () => store.reserveEvidence(scope, {
        repositoryBindingId: bindingId, attemptId, draft: draftOf(bundle(taskId, other.attemptId)),
      }),
      EvidenceDraftMismatchError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
    await client.close();
    await other.client.close();
  }
});

test('the database refuses a reservation whose draft is another attempt\'s', async () => {
  const { client, scope, dir, bindingId, reserve, otherAttempt } = await fresh();
  const mine = await reserve();
  const other = await otherAttempt();
  const draft = await client.query(
    'select draft_artifact_id, draft_sha256 from evidence_reservations where id = $1', [mine]);
  await assert.rejects(
    () => client.query(
      `insert into evidence_reservations
         (id, organization_id, project_id, repository_binding_id, attempt_id, draft_artifact_id, draft_sha256)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['R'.repeat(26), scope.organizationId, scope.projectId, bindingId, other,
        draft.rows[0]!['draft_artifact_id'] as string, draft.rows[0]!['draft_sha256'] as string],
    ),
    /foreign key|violates/i,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('a reserved draft whose content names another attempt is refused on read', async () => {
  const { client, scope, objects, store, dir, taskId, attemptId, bindingId, otherAttempt } = await fresh();
  const other = await otherAttempt();
  // A draft artifact filed under `other` whose bytes describe `attemptId`.
  const bytes = new TextEncoder().encode(JSON.stringify(draftOf(bundle(taskId, attemptId))));
  const art = await new ContentAddressedArtifactStore(client, objects).put(scope, {
    kind: 'evidence-draft', content: bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'application/json', attemptId: other,
  });
  const id = 'R'.repeat(26) as ArtifactId;
  await client.query(
    `insert into evidence_reservations
       (id, organization_id, project_id, repository_binding_id, attempt_id, draft_artifact_id, draft_sha256)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, scope.organizationId, scope.projectId, bindingId, other, art.artifactId, art.sha256],
  );
  await assert.rejects(() => store.getReservation(scope, id), EvidenceDraftMismatchError);
  await assert.rejects(
    () => store.putEvidence(scope, id, bundle(taskId, attemptId)), EvidenceDraftMismatchError);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: putEvidence stores at the reserved id carrying the harness resultSha', async () => {
  const { client, scope, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  const resultSha = 'a'.repeat(40);
  const ref = await store.putEvidence(scope, id, bundle(taskId, attemptId, { resultSha }));
  assert.equal(ref.artifactId, id, 'stored at the RESERVED id, not a generated one');
  assert.equal(ref.kind, 'evidence-bundle');
  const got = await store.getEvidence(scope, id);
  assert.equal(got.resultSha, resultSha, 'resultSha is the harness commit SHA');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: re-storing the BYTE-IDENTICAL bundle at the same id is a no-op success (crash recovery)', async () => {
  const { client, scope, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  const b = bundle(taskId, attemptId);
  const first = await store.putEvidence(scope, id, b);
  const second = await store.putEvidence(scope, id, b);
  assert.deepEqual(second, first, 'idempotent retry converges without a second commit');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: storing DIFFERENT bytes at an existing evidence id FAILS CLOSED (immutable)', async () => {
  const { client, scope, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  await store.putEvidence(scope, id, bundle(taskId, attemptId, { resultSha: 'a'.repeat(40) }));
  await assert.rejects(
    () => store.putEvidence(scope, id, bundle(taskId, attemptId, { resultSha: '9'.repeat(40) })),
    EvidenceImmutabilityError,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: getEvidence for an unknown id fails closed', async () => {
  const { client, scope, store, dir, reserve } = await fresh();
  const reserved = await reserve();
  await assert.rejects(
    () => store.getEvidence(scope, reserved),
    EvidenceNotFoundError,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: a cross-scope getEvidence resolves to nothing (tenant isolation)', async () => {
  const { client, scope, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  await store.putEvidence(scope, id, bundle(taskId, attemptId));
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const org = await orgs.create({ name: 'Other' });
  const proj = await projects.create({ organizationId: org.id, name: 'svc', defaultBranch: 'main' });
  const otherScope: TenantScope = { organizationId: org.id, projectId: proj.id };
  await assert.rejects(() => store.getEvidence(otherScope, id), EvidenceNotFoundError);
  await assert.rejects(() => store.getReservation(otherScope, id), EvidenceNotReservedError);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: getEvidence re-hashes on read — a mutated object byte fails closed', async () => {
  const { client, scope, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  const ref = await store.putEvidence(scope, id, bundle(taskId, attemptId));
  // Locate the stored object key and overwrite its bytes out-of-band.
  const r = await client.query(
    `select storage_key from artifacts where id = $1`, [id],
  );
  const key = r.rows[0]!['storage_key'] as string;
  // FilesystemObjectStore is create-only, so write the tampered bytes directly.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, key), new TextEncoder().encode('tampered evidence'));
  await assert.rejects(() => store.getEvidence(scope, id), EvidenceImmutabilityError);
  assert.equal(ref.artifactId, id);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

// ---------------------------------------------------------------------------
// HIGH-006 (cycle-5 residue) — the ORPHAN-OBJECT crash window.
//
// putEvidence writes the object first, then inserts the metadata row. A crash
// BETWEEN those two leaves the object on disk at a key derived from the reserved
// id, with no `artifacts` row. On resume the metadata probe finds nothing and
// getEvidence() reports ABSENT, so the evidence step writes the draft plus the
// committed SHA again — the same bytes, now that the draft fixes the clock —
// and the store completes the interrupted write rather than wedge on the
// create-only guard.
//
// These tests drive that exact window by writing the object out-of-band (the
// same thing the interrupted call did) and leaving the row absent.
// ---------------------------------------------------------------------------

// The object key layout putEvidence uses. Duplicated here deliberately: the test
// must be able to plant an orphan without going through the store.
function evKey(scope: TenantScope, id: ArtifactId): string {
  return `${scope.organizationId}/${scope.projectId}/evidence/${id}`;
}

test('HIGH-006: an ORPHANED object (crash before the metadata insert) is ADOPTED, not wedged', async () => {
  const { client, scope, objects, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();

  // The interrupted write: object landed, process died before the row.
  const durable = bundle(taskId, attemptId);
  await objects.putIfAbsent(evKey(scope, id), new TextEncoder().encode(JSON.stringify(durable)));

  // The resume genuinely observes ABSENT — that is what makes it write again.
  await assert.rejects(() => store.getEvidence(scope, id), EvidenceNotFoundError);

  const ref = await store.putEvidence(scope, id, bundle(taskId, attemptId));
  assert.equal(ref.artifactId, id, 'adoption keeps the reserved id');
  const got = await store.getEvidence(scope, id);
  assert.deepEqual(got, durable, 'the interrupted write was completed');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('HIGH-006: adoption is IDENTITY-GATED — an orphan for another commit still fails closed', async () => {
  // Adoption must not become a general "overwrite whatever is there". The four
  // harness-owned facts (task, attempt, baseSha, resultSha) come from trusted
  // inspection, never from the agent, so disagreement on any of them means the id
  // is genuinely bound to other content.
  const cases: readonly (readonly [string, Partial<EvidenceBundle>])[] = [
    ['resultSha', { resultSha: '9'.repeat(40) }],
    ['baseSha', { baseSha: '8'.repeat(40) }],
  ];
  for (const [label, override] of cases) {
    const { client, scope, objects, store, dir, taskId, attemptId, reserve } = await fresh();
    const id = await reserve();
    // Plant an orphan describing a DIFFERENT commit.
    const foreign = bundle(taskId, attemptId, override);
    await objects.putIfAbsent(evKey(scope, id), new TextEncoder().encode(JSON.stringify(foreign)));
    await assert.rejects(
      () => store.putEvidence(scope, id, bundle(taskId, attemptId)),
      EvidenceImmutabilityError,
      `an orphan disagreeing on ${label} must NOT be adopted`,
    );
    rmSync(dir, { recursive: true, force: true });
    await client.close();
  }
});

test('an orphan that agrees on identity but is not the reserved draft is never adopted', async () => {
  // The four identity fields are not the evidence: the draft fixed the diff, the
  // checks, the environment and the clock before the commit. An orphan that
  // differs in any of them is not this reservation's interrupted write.
  const cases: readonly (readonly [string, Partial<EvidenceBundle>])[] = [
    ['createdAt', { createdAt: '2026-03-03T00:00:00.000Z' }],
    ['checks', { checks: [{ id: 'L0', category: 'workspace', command: 'git status', exitCode: 1, durationMs: 5 }] }],
    ['diff', { diff: { artifactId: 'art-other' as ArtifactId, sha256: '7'.repeat(64) } }],
  ];
  for (const [label, override] of cases) {
    const { client, scope, objects, store, dir, taskId, attemptId, reserve } = await fresh();
    const id = await reserve();
    const planted = bundle(taskId, attemptId, override);
    await objects.putIfAbsent(evKey(scope, id), new TextEncoder().encode(JSON.stringify(planted)));
    await assert.rejects(
      () => store.putEvidence(scope, id, bundle(taskId, attemptId)),
      EvidenceImmutabilityError,
      `an orphan differing in ${label} must NOT be adopted`,
    );
    await assert.rejects(() => store.getEvidence(scope, id), EvidenceNotFoundError, `${label}: nothing was recorded`);
    rmSync(dir, { recursive: true, force: true });
    await client.close();
  }
});

test('HIGH-006: a NON-BUNDLE orphan at the evidence key fails closed', async () => {
  const { client, scope, objects, store, dir, taskId, attemptId, reserve } = await fresh();
  const id = await reserve();
  // Whatever this is, it is not our interrupted evidence write.
  await objects.putIfAbsent(evKey(scope, id), new TextEncoder().encode('not json at all'));
  await assert.rejects(
    () => store.putEvidence(scope, id, bundle(taskId, attemptId)),
    EvidenceImmutabilityError,
    'unparseable content must never be adopted as evidence',
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});
