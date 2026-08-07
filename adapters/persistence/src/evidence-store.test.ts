// EvidenceStore integration suite (exit criterion D8). Runs against a REAL
// PostgreSQL engine (in-process PGlite) for metadata + a real temp-dir
// filesystem ObjectStore for bytes. Proves the preallocated-id protocol:
//   - allocateEvidenceId() returns a non-content-derived id available BEFORE
//     the commit (so it can be embedded in the ASEP-Evidence trailer);
//   - putEvidence stores the bundle at that exact id, carrying resultSha;
//   - re-storing the byte-identical bundle at the same id is a no-op success
//     (crash between commit and evidence persistence recovers, no 2nd commit);
//   - storing DIFFERENT bytes at an existing id FAILS CLOSED (immutable);
//   - getEvidence round-trips and re-hashes on read (a mutated byte fails).
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate
// RED.
import test from 'node:test';
import assert from 'node:assert/strict';
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
import {
  ContentAddressedEvidenceStore, EvidenceImmutabilityError, EvidenceNotFoundError,
} from './evidence-store.js';
import type {
  TenantScope, AttemptId, TaskId, ArtifactId, EvidenceBundle,
} from '@asep/contracts';

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
  return { client, scope, objects, store, dir, taskId: task.id, attemptId: attempt.id };
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

test('D8: allocateEvidenceId returns a non-content-derived id BEFORE any commit', async () => {
  const { client, store, dir } = await fresh();
  const a = store.allocateEvidenceId();
  const b = store.allocateEvidenceId();
  assert.notEqual(a, b, 'ids are unique');
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID-shaped');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: putEvidence stores at the preallocated id carrying the harness resultSha', async () => {
  const { client, scope, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();
  const resultSha = 'a'.repeat(40);
  const ref = await store.putEvidence(scope, id, bundle(taskId, attemptId, { resultSha }));
  assert.equal(ref.artifactId, id, 'stored at the PREALLOCATED id, not a generated one');
  assert.equal(ref.kind, 'evidence-bundle');
  const got = await store.getEvidence(scope, id);
  assert.equal(got.resultSha, resultSha, 'resultSha is the harness commit SHA');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: re-storing the BYTE-IDENTICAL bundle at the same id is a no-op success (crash recovery)', async () => {
  const { client, scope, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();
  const b = bundle(taskId, attemptId);
  const first = await store.putEvidence(scope, id, b);
  const second = await store.putEvidence(scope, id, b);
  assert.deepEqual(second, first, 'idempotent retry converges without a second commit');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: storing DIFFERENT bytes at an existing evidence id FAILS CLOSED (immutable)', async () => {
  const { client, scope, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();
  await store.putEvidence(scope, id, bundle(taskId, attemptId, { resultSha: 'a'.repeat(40) }));
  await assert.rejects(
    () => store.putEvidence(scope, id, bundle(taskId, attemptId, { resultSha: '9'.repeat(40) })),
    EvidenceImmutabilityError,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: getEvidence for an unknown id fails closed', async () => {
  const { client, scope, store, dir } = await fresh();
  await assert.rejects(
    () => store.getEvidence(scope, store.allocateEvidenceId()),
    EvidenceNotFoundError,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: a cross-scope getEvidence resolves to nothing (tenant isolation)', async () => {
  const { client, scope, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();
  await store.putEvidence(scope, id, bundle(taskId, attemptId));
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const org = await orgs.create({ name: 'Other' });
  const proj = await projects.create({ organizationId: org.id, name: 'svc', defaultBranch: 'main' });
  const otherScope: TenantScope = { organizationId: org.id, projectId: proj.id };
  await assert.rejects(() => store.getEvidence(otherScope, id), EvidenceNotFoundError);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D8: getEvidence re-hashes on read — a mutated object byte fails closed', async () => {
  const { client, scope, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();
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
// THE DEFECT. putEvidence writes the object first, then inserts the metadata
// row. A crash BETWEEN those two leaves the object on disk at a key derived from
// the preallocated id, with no `artifacts` row. On resume the metadata probe
// finds nothing, getEvidence() reports ABSENT, and evidenceStep concludes "safe
// to write" — then re-derives the bundle with a NEW `createdAt` from the clock.
// Different bytes at the same key hit the create-only guard, which used to fail
// closed unconditionally. Every retry stamps a new timestamp, so the collision
// never clears: the attempt is wedged FOREVER, with no operator path forward.
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
  const { client, scope, objects, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();

  // The interrupted write: object landed, process died before the row.
  const durable = bundle(taskId, attemptId, { createdAt: '2026-01-01T00:00:00.000Z' });
  await objects.putIfAbsent(evKey(scope, id), new TextEncoder().encode(JSON.stringify(durable)));

  // The resume genuinely observes ABSENT — that is what makes it re-derive.
  await assert.rejects(() => store.getEvidence(scope, id), EvidenceNotFoundError);

  // Same attempt, same commit, LATER clock: byte-different, identity-identical.
  const resumed = bundle(taskId, attemptId, { createdAt: '2026-06-30T12:00:00.000Z' });
  const ref = await store.putEvidence(scope, id, resumed);

  assert.equal(ref.artifactId, id, 'adoption keeps the preallocated id');
  // The DURABLE bytes win: adoption completes the interrupted write rather than
  // replacing it, so the first run's timestamp survives.
  const got = await store.getEvidence(scope, id);
  assert.equal(got.createdAt, '2026-01-01T00:00:00.000Z',
    'the ORIGINAL bytes are adopted — the resume clock must not overwrite evidence');
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
    const { client, scope, objects, store, dir, taskId, attemptId } = await fresh();
    const id = store.allocateEvidenceId();
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

test('HIGH-006: a NON-BUNDLE orphan at the evidence key fails closed', async () => {
  const { client, scope, objects, store, dir, taskId, attemptId } = await fresh();
  const id = store.allocateEvidenceId();
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
