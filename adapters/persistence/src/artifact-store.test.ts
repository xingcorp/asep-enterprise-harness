// Artifact-store integration suite (exit criteria D2–D7). Runs against a REAL
// PostgreSQL engine (in-process PGlite) for metadata + a real temp-dir
// filesystem ObjectStore for bytes — genuine content-addressing, checksum
// re-verification, create-only collisions and tenant-scope isolation, no Docker.
//
// Machine-readable suite marker (K4) so a dropped/renamed/crashed artifact
// suite turns the gate RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { PgliteClient } from './pglite-client.js';
import { migrate } from './migrator.js';
import {
  OrganizationRepository, ProjectRepository,
} from './repositories.js';
import { FilesystemObjectStore, ObjectExistsError } from './object-store.js';
import {
  ContentAddressedArtifactStore, ArtifactChecksumError, ArtifactNotFoundError,
} from './artifact-store.js';
import type { ArtifactRef, TenantScope } from '@asep/contracts';

console.log('SUITE-ID: asep-suite:artifact-store');

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// A migrated DB + a temp object dir + one registered org/project scope.
async function fresh() {
  const client = await PgliteClient.create();
  await migrate(client);
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const org = await orgs.create({ name: 'Acme' });
  const proj = await projects.create({
    organizationId: org.id, name: 'web', defaultBranch: 'main',
  });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const dir = mkdtempSync(join(tmpdir(), 'asep-obj-'));
  const objects = new FilesystemObjectStore(dir);
  const store = new ContentAddressedArtifactStore(client, objects);
  return { client, scope, objects, store, dir };
}

async function secondScope(client: Awaited<ReturnType<typeof fresh>>['client']): Promise<TenantScope> {
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const org = await orgs.create({ name: 'Other' });
  const proj = await projects.create({
    organizationId: org.id, name: 'svc', defaultBranch: 'main',
  });
  return { organizationId: org.id, projectId: proj.id };
}

const bytesOf = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// D2 — content-addressed by sha256; key is not a user path.
// ---------------------------------------------------------------------------

test('D2: put stores by sha256 and round-trips the exact bytes', async () => {
  const { client, scope, store, dir } = await fresh();
  const content = bytesOf('hello artifact');
  const sha = sha256Hex(content);
  const ref = await store.put(scope, { kind: 'git-diff', content, sha256: sha, contentType: 'text/plain' });
  assert.equal(ref.sha256, sha);
  assert.equal(ref.kind, 'git-diff');
  const got = await store.get(scope, ref);
  assert.deepEqual([...got.content], [...content]);
  assert.equal(got.contentType, 'text/plain');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D2: a put whose claimed sha does not match the bytes fails closed', async () => {
  const { client, scope, store, dir } = await fresh();
  const content = bytesOf('real bytes');
  await assert.rejects(
    () => store.put(scope, { kind: 'x', content, sha256: 'f'.repeat(64), contentType: 'text/plain' }),
    ArtifactChecksumError,
  );
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

// ---------------------------------------------------------------------------
// D3 — read verification detects byte mutation/corruption.
// ---------------------------------------------------------------------------

test('D3: a mutated object byte is detected on get AND verify (fail closed)', async () => {
  const { client, scope, store, objects, dir } = await fresh();
  const content = bytesOf('tamper target');
  const sha = sha256Hex(content);
  const ref = await store.put(scope, { kind: 'stdout', content, sha256: sha, contentType: 'text/plain' });
  // Corrupt the underlying object bytes directly (simulate storage rot).
  const key = `${scope.organizationId}/${scope.projectId}/sha256/${sha}`;
  await writeFile(join(dir, key), bytesOf('tamper targeX'));
  await assert.rejects(() => store.get(scope, ref), ArtifactChecksumError);
  const v = await store.verify(scope, ref);
  assert.equal(v.ok, false);
  assert.notEqual(v.actualSha256, sha);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D3: verify returns ok for an intact artifact', async () => {
  const { client, scope, store, dir } = await fresh();
  const content = bytesOf('intact');
  const sha = sha256Hex(content);
  const ref = await store.put(scope, { kind: 'stdout', content, sha256: sha, contentType: 'text/plain' });
  const v = await store.verify(scope, ref);
  assert.equal(v.ok, true);
  assert.equal(v.actualSha256, sha);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

// ---------------------------------------------------------------------------
// D4 — identical bytes deduplicate; no second metadata row.
// ---------------------------------------------------------------------------

test('D4: putting identical (scope, sha, kind) twice reuses one metadata row', async () => {
  const { client, scope, store, dir } = await fresh();
  const content = bytesOf('dedup me');
  const sha = sha256Hex(content);
  const r1 = await store.put(scope, { kind: 'git-diff', content, sha256: sha, contentType: 'text/plain' });
  const r2 = await store.put(scope, { kind: 'git-diff', content, sha256: sha, contentType: 'text/plain' });
  assert.equal(r1.artifactId, r2.artifactId, 'dedup returns the same artifact id');
  const count = await client.query(
    `select count(*)::int as n from artifacts where organization_id = $1 and project_id = $2 and sha256 = $3 and kind = $4`,
    [scope.organizationId, scope.projectId, sha, 'git-diff'],
  );
  assert.equal(count.rows[0]!['n'], 1, 'exactly one metadata row for identical bytes');
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

// ---------------------------------------------------------------------------
// D6 — TenantScope required; cross-scope read/verify fails closed.
// ---------------------------------------------------------------------------

test('D6: project B cannot get or verify project A artifact (fail closed)', async () => {
  const { client, scope, store, dir } = await fresh();
  const other = await secondScope(client);
  const content = bytesOf('secret to A');
  const sha = sha256Hex(content);
  const ref: ArtifactRef = await store.put(scope, { kind: 'git-diff', content, sha256: sha, contentType: 'text/plain' });
  await assert.rejects(() => store.get(other, ref), ArtifactNotFoundError);
  await assert.rejects(() => store.verify(other, ref), ArtifactNotFoundError);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D6: identical bytes under two scopes get DIFFERENT tenant-namespaced keys', async () => {
  const { client, scope, store, dir } = await fresh();
  const other = await secondScope(client);
  const content = bytesOf('same bytes both projects');
  const sha = sha256Hex(content);
  const rA = await store.put(scope, { kind: 'x', content, sha256: sha, contentType: 'text/plain' });
  const rB = await store.put(other, { kind: 'x', content, sha256: sha, contentType: 'text/plain' });
  assert.notEqual(rA.artifactId, rB.artifactId, 'each scope gets its own artifact row');
  // Both are independently readable within their own scope.
  assert.equal((await store.get(scope, rA)).sizeBytes, content.byteLength);
  assert.equal((await store.get(other, rB)).sizeBytes, content.byteLength);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

// ---------------------------------------------------------------------------
// D7 — object writes are conditional create-only; different bytes to one key
// fail; a byte-identical re-write is a benign no-op (orphan reconciliation).
// ---------------------------------------------------------------------------

test('D7: create-only object write rejects DIFFERENT bytes at an existing key', async () => {
  const { client, objects, dir } = await fresh();
  await objects.putIfAbsent('k/one', bytesOf('first'));
  // Same key, different bytes → collision.
  await assert.rejects(() => objects.putIfAbsent('k/one', bytesOf('second')), ObjectExistsError);
  // Same key, identical bytes → idempotent no-op.
  await objects.putIfAbsent('k/one', bytesOf('first'));
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

test('D7: an orphan object (bytes present, no metadata) is a byte-identical no-op for the next identical put', async () => {
  const { client, scope, store, objects, dir } = await fresh();
  const content = bytesOf('orphan then put');
  const sha = sha256Hex(content);
  // Simulate a crash-after-object-write-before-metadata: bytes at the exact key,
  // no metadata row. The next put must converge (reconcile), not fail.
  const key = `${scope.organizationId}/${scope.projectId}/sha256/${sha}`;
  await objects.putIfAbsent(key, content);
  const ref = await store.put(scope, { kind: 'stdout', content, sha256: sha, contentType: 'text/plain' });
  assert.equal(ref.sha256, sha);
  const got = await store.get(scope, ref);
  assert.deepEqual([...got.content], [...content]);
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});
