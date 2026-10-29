// SideEffectLog integration suite (exit criterion C7). Runs against a REAL
// PostgreSQL engine (in-process PGlite) — genuine UNIQUE constraint, composite
// scope key, transactional fencing. Proves the two-phase crash-safe protocol:
//   - begin() claims a fresh PENDING record; a second begin() for the SAME
//     effect ADOPTS the existing record (existed=true) rather than duplicating;
//   - reusing a key with a DIFFERENT fingerprint FAILS CLOSED;
//   - complete()/fail() enforce FENCING: a mismatched owner_token is rejected;
//   - complete() persists result_ref + natural_key for remote reconciliation;
//   - a full re-run (begin → complete already done) adopts the COMPLETED record
//     so the caller performs the external effect exactly once.
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate
// RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PgliteClient } from './pglite-client.js';
import { migrate } from './migrator.js';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
} from './repositories.js';
import { SqlSideEffectLog } from './side-effect-log.js';
import { SideEffectFingerprintError, SideEffectFencingError } from '@asep/ports';
import type {
  TenantScope, AttemptId, RepositoryBindingId,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:side-effect-log');

async function fresh() {
  const client = await PgliteClient.create();
  await migrate(client);
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const org = await orgs.create({ name: 'Acme' });
  const proj = await projects.create({
    organizationId: org.id, name: 'web', defaultBranch: 'main',
  });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const binding = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
  });
  const log = new SqlSideEffectLog(client);
  return { client, scope, binding, log };
}

const attemptId = 'attempt-1' as AttemptId;

test('C7: begin claims a fresh PENDING record (existed=false)', async () => {
  const { client, scope, binding, log } = await fresh();
  const rec = await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: 'lease-1',
    naturalKey: 'refs/heads/asep/attempt-1',
  });
  assert.equal(rec.existed, false);
  assert.equal(rec.state, 'PENDING');
  await client.close();
});

test('C7: a second begin for the SAME effect ADOPTS the record (existed=true) — no duplicate', async () => {
  const { client, scope, binding, log } = await fresh();
  const input = {
    operation: 'push' as const,
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: 'lease-1',
  };
  await log.begin(scope, input);
  const second = await log.begin(scope, input);
  assert.equal(second.existed, true, 'the retry adopts the existing PENDING record');
  await client.close();
});

test('C7: reusing a key with a DIFFERENT fingerprint FAILS CLOSED', async () => {
  const { client, scope, binding, log } = await fresh();
  await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha1',
    ownerToken: 'lease-1',
  });
  await assert.rejects(
    () => log.begin(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      requestFingerprint: 'push:branch@sha2', // different commit → different effect
      ownerToken: 'lease-1',
    }),
    SideEffectFingerprintError,
  );
  await client.close();
});

test('C7: complete persists result_ref + natural_key and marks COMPLETED', async () => {
  const { client, scope, binding, log } = await fresh();
  await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr:head->base',
    ownerToken: 'lease-1',
  });
  const pr = { number: 42, url: 'https://github.com/acme/web/pull/42', headBranch: 'asep/attempt-1', baseBranch: 'main' };
  const done = await log.complete(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    ownerToken: 'lease-1',
    resultRef: pr,
    naturalKey: 'asep/attempt-1',
  });
  assert.equal(done.state, 'COMPLETED');
  assert.deepEqual(done.resultRef, pr);
  // A subsequent begin adopts the COMPLETED record so the caller adopts, not replays.
  const adopt = await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr:head->base',
    ownerToken: 'lease-1',
  });
  assert.equal(adopt.existed, true);
  assert.equal(adopt.state, 'COMPLETED');
  assert.deepEqual(adopt.resultRef, pr);
  await client.close();
});

test('C7: FENCING — a mismatched owner_token cannot complete another executor\'s effect', async () => {
  const { client, scope, binding, log } = await fresh();
  await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push:branch@sha',
    ownerToken: 'lease-original',
  });
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: 'lease-stolen', // a stale executor
    }),
    SideEffectFencingError,
  );
  await client.close();
});

test('C7: complete without a PENDING record fails closed', async () => {
  const { client, scope, binding, log } = await fresh();
  await assert.rejects(
    () => log.complete(scope, {
      operation: 'push',
      repositoryBindingId: binding.id,
      attemptId,
      ownerToken: 'lease-1',
    }),
    SideEffectFencingError,
  );
  await client.close();
});

test('C7: different operations for the same attempt are INDEPENDENT effects', async () => {
  const { client, scope, binding, log } = await fresh();
  const push = await log.begin(scope, {
    operation: 'push',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'push',
    ownerToken: 'lease-1',
  });
  const pr = await log.begin(scope, {
    operation: 'pr-upsert',
    repositoryBindingId: binding.id,
    attemptId,
    requestFingerprint: 'pr',
    ownerToken: 'lease-1',
  });
  assert.equal(push.existed, false);
  assert.equal(pr.existed, false, 'the PR effect is independent of the push effect');
  await client.close();
});
