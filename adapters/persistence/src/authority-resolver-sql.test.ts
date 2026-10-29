// The pilot authority resolver's SQL, executed against the REAL migrated schema
// (disp. P2-FINAL-HIGH-009).
//
// THE FINDING. Cycle 5: "Query attempt đọc cột `attempts.run_id` không tồn tại."
// That was correct and load-bearing. `resolveAttempt` selected `run_id` FROM
// `attempts`, but `run_id` lives on `tasks` — attempts reach a run through their
// task. So every call threw `column "run_id" does not exist`, which means the
// verifier's hierarchy check at verify-pilot-manifest.mjs
//
//     if (attempt.runId !== trace.runId) { …reject… }
//
// could never execute: the resolver blew up before returning a row. A check that
// cannot run is not a check.
//
// WHY THE EXISTING SUITE MISSED IT. scripts/pilot/verify-pilot-manifest.test.ts
// drives the resolver through `fakeDb`, a stub whose `query()` ignores the SQL
// text entirely and returns canned rows. It proves the resolver's LOGIC (scoping,
// signature verification, tamper detection) and proves it well — but a stub that
// never parses SQL cannot notice that the SQL is invalid. The column set was
// unfalsifiable there by construction.
//
// So this suite closes a different question: does each query actually RUN against
// the schema `migrate()` produces? It lives under adapters/persistence because
// that is the package that owns PGlite; the resolver is imported across the tree
// by relative path so exactly ONE copy of the SQL is under test — pinning a
// duplicated string here would defeat the entire point.
//
// It deliberately asserts on real rows rather than on SQL text: an assertion like
// `assert.match(sql, /t\.run_id/)` would just restate the implementation and
// would keep passing if the join were correct but the schema changed underneath.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactId, EvidenceBundle, TenantScope } from '@asep/contracts';
import { PgliteClient } from './pglite-client.js';
import { migrate } from './migrator.js';
import { FilesystemObjectStore } from './object-store.js';
import { ContentAddressedEvidenceStore } from './evidence-store.js';
// One resolver, one copy of the SQL. Reaching across packages is the point: the
// resolver's queries must be executed against the schema THIS package migrates,
// and PGlite is only resolvable from here.
import {
  createSqlAuthorityResolver,
  filesystemObjectReader,
  sqlBindingReader,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/authority-resolver.mjs';
import {
  signAuthorization,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/human-authorization-crypto.mjs';

console.log('SUITE-ID: asep-suite:authority-resolver-sql');

const keys = generateKeyPairSync('ed25519');
const REVIEWER_PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const REVIEWER_PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// ULID-shaped ids: the columns are char(26), so a short string would be padded
// and comparisons would silently fail for reasons unrelated to the query.
const ORG = 'O'.repeat(26);
const PROJ = 'P'.repeat(26);
const BINDING = 'B'.repeat(26);
const RUN = 'R'.repeat(26);
const TASK = 'T'.repeat(26);
const ATTEMPT = 'A'.repeat(26);
const PR = 'Q'.repeat(26);
const RESULT_SHA = 'd'.repeat(40);

/** Seed the full parent chain the resolver's joins and FKs require. */
async function seed(client: PgliteClient): Promise<void> {
  await client.query(
    `insert into organizations (id, name) values ($1, $2)`, [ORG, 'Acme'],
  );
  await client.query(
    `insert into projects (id, organization_id, name, default_branch)
     values ($1, $2, $3, $4)`, [PROJ, ORG, 'web', 'main'],
  );
  await client.query(
    `insert into repository_bindings
       (id, organization_id, project_id, forge, github_host, github_owner,
        github_repo, default_base_branch, github_repository_id)
     values ($1, $2, $3, 'github', $4, $5, $6, $7, $8)`,
    [BINDING, ORG, PROJ, 'github.com', 'acme', 'web', 'main', 4242],
  );
  await client.query(
    `insert into runs (id, organization_id, project_id, repository_binding_id, status, risk)
     values ($1, $2, $3, $4, 'EXECUTING', 'R0')`, [RUN, ORG, PROJ, BINDING],
  );
  await client.query(
    `insert into tasks (id, organization_id, project_id, run_id, repository_binding_id,
                        status, risk, base_sha)
     values ($1, $2, $3, $4, $5, 'WAITING_FOR_HUMAN_REVIEW', 'R0', $6)`,
    [TASK, ORG, PROJ, RUN, BINDING, '0'.repeat(40)],
  );
  await client.query(
    `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id,
                           status, base_sha, result_sha, agent_provider_id)
     values ($1, $2, $3, $4, $5, 'PR_OPEN', $6, $7, $8)`,
    [ATTEMPT, ORG, PROJ, TASK, BINDING, '0'.repeat(40), RESULT_SHA,
      'claude:claude-sonnet-4-20250514@cli-2.1.185'],
  );
  await client.query(
    `insert into pull_requests (id, organization_id, project_id, repository_binding_id,
                               attempt_id, forge, number, head_branch, base_branch, url, state)
     values ($1, $2, $3, $4, $5, 'github', $6, $7, $8, $9, 'OPEN')`,
    [PR, ORG, PROJ, BINDING, ATTEMPT, 77, 'asep/attempt-1', 'main',
      'https://github.com/acme/web/pull/77'],
  );
}

const trace = {
  organizationId: ORG, projectId: PROJ, runId: RUN,
  taskId: TASK, attemptId: ATTEMPT, repositoryBindingId: BINDING,
};

function resolverFor(client: PgliteClient, objectRoot = '/nonexistent-object-root') {
  return createSqlAuthorityResolver(client, {
    reviewerPublicKeyPem: REVIEWER_PUB,
    objects: filesystemObjectReader(objectRoot),
    forge: { findPullRequest: async () => null },
  });
}

// ---------------------------------------------------------------------------
// 1 — the defect itself: resolveAttempt must RUN and report the real run id.
// ---------------------------------------------------------------------------

test('HIGH-009: resolveAttempt runs against the real schema and reports the run id from tasks', async () => {
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    await seed(client);

    // Pre-fix this threw `column "run_id" does not exist`. Nothing downstream of
    // it — including the verifier's runId equality check — was reachable.
    const attempt = await resolverFor(client).resolveAttempt(trace);

    assert.ok(attempt !== null, 'a seeded attempt must resolve');
    assert.equal(attempt.attemptId, ATTEMPT);
    assert.equal(attempt.taskId, TASK);
    // The whole point: run_id is reached THROUGH tasks, and the value is the real
    // one — not null, not the task id.
    assert.equal(attempt.runId, RUN,
      'runId must come from the attempt\'s task, so the verifier hierarchy check can run');
    assert.equal(attempt.repositoryBindingId, BINDING);
    assert.equal(attempt.resultSha, RESULT_SHA);
    assert.match(String(attempt.providerId), /^claude:/);
  } finally {
    await client.close?.();
  }
});

// The column set is only trustworthy if a WRONG run id is actually distinguishable
// — otherwise the assertion above could pass on a coincidence.
test('HIGH-009: resolveAttempt reports the run of ITS OWN task, not another run', async () => {
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    await seed(client);

    // A second run + task + attempt in the same tenant. If the join were wrong
    // (or the value were hard-coded) the two attempts would report the same run.
    const RUN2 = 'S'.repeat(26);
    const TASK2 = 'U'.repeat(26);
    const ATTEMPT2 = 'V'.repeat(26);
    await client.query(
      `insert into runs (id, organization_id, project_id, repository_binding_id, status, risk)
       values ($1, $2, $3, $4, 'EXECUTING', 'R0')`, [RUN2, ORG, PROJ, BINDING],
    );
    await client.query(
      `insert into tasks (id, organization_id, project_id, run_id, repository_binding_id,
                          status, risk, base_sha)
       values ($1, $2, $3, $4, $5, 'EXECUTING', 'R0', $6)`,
      [TASK2, ORG, PROJ, RUN2, BINDING, '0'.repeat(40)],
    );
    await client.query(
      `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id,
                             status, base_sha, result_sha, agent_provider_id)
       values ($1, $2, $3, $4, $5, 'STARTED', $6, null, 'claude:x@cli-1')`,
      [ATTEMPT2, ORG, PROJ, TASK2, BINDING, '0'.repeat(40)],
    );

    const resolver = resolverFor(client);
    const first = await resolver.resolveAttempt(trace);
    const second = await resolver.resolveAttempt({ ...trace, taskId: TASK2, attemptId: ATTEMPT2 });

    assert.equal(first?.runId, RUN);
    assert.equal(second?.runId, RUN2, 'each attempt reports the run of its own task');
    assert.notEqual(first?.runId, second?.runId, 'the two runs must be distinguishable');
  } finally {
    await client.close?.();
  }
});

// ---------------------------------------------------------------------------
// 2 — tenant scoping survives the join. An INNER JOIN is a classic place to
//     lose it: joining on task id alone would let a sibling tenant's task
//     satisfy the join.
// ---------------------------------------------------------------------------

test('HIGH-009: resolveAttempt stays tenant-scoped across the join', async () => {
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    await seed(client);
    const resolver = resolverFor(client);

    // Right attempt id, wrong tenant → no row.
    assert.equal(
      await resolver.resolveAttempt({ ...trace, organizationId: 'Z'.repeat(26) }), null,
      'another organization must not resolve this attempt',
    );
    assert.equal(
      await resolver.resolveAttempt({ ...trace, projectId: 'Z'.repeat(26) }), null,
      'another project must not resolve this attempt',
    );
    // An attempt id that does not exist → no row (not a throw).
    assert.equal(
      await resolver.resolveAttempt({ ...trace, attemptId: 'N'.repeat(26) }), null,
      'an absent attempt resolves to null so the verifier fails closed',
    );
  } finally {
    await client.close?.();
  }
});

// ---------------------------------------------------------------------------
// 3 — the OTHER three queries must also be valid SQL against this schema.
//     resolveAttempt was broken for two review cycles precisely because no test
//     ever executed it; the same blind spot covers its siblings.
// ---------------------------------------------------------------------------

test('HIGH-009: resolvePullRequest and resolveEvidence execute against the real schema', async () => {
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    await seed(client);
    const resolver = resolverFor(client);

    const pr = await resolver.resolvePullRequest(trace, PR);
    assert.ok(pr !== null, 'the seeded PR must resolve');
    assert.equal(pr.number, 77);
    assert.equal(pr.headBranch, 'asep/attempt-1');
    assert.equal(pr.attemptId, ATTEMPT);
    assert.equal(pr.url, 'https://github.com/acme/web/pull/77');

    // Absent evidence is a null, not a crash — the verifier turns that into a
    // rejection rather than an unhandled error.
    assert.equal(await resolver.resolveEvidence(trace, 'E'.repeat(26)), null,
      'an absent evidence artifact resolves to null');

    // And a real artifact row round-trips its kind + hash.
    await client.query(
      `insert into artifacts
         (id, organization_id, project_id, kind, sha256, size_bytes, storage_key, content_type)
       values ($1, $2, $3, 'evidence-bundle', $4, 10, 'k/1', 'application/json')`,
      ['E'.repeat(26), ORG, PROJ, 'f'.repeat(64)],
    );
    const ev = await resolver.resolveEvidence(trace, 'E'.repeat(26));
    assert.equal(ev?.kind, 'evidence-bundle');
    assert.equal(ev?.sha256, 'f'.repeat(64));
  } finally {
    await client.close?.();
  }
});

test('HIGH-009: resolveHumanAuthorization executes and verifies a real signed row', async () => {
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    await seed(client);
    const resolver = resolverFor(client);

    // No authorization yet: null, so a COMPLETE claim cannot be honoured.
    assert.equal(await resolver.resolveHumanAuthorization(TASK, trace), null,
      'a missing authorization resolves to null (verifier fails closed)');

    const decision = {
      task_id: TASK,
      attempt_id: ATTEMPT,
      pull_request_id: PR,
      disposition: 'ACCEPTED',
      reviewed_result_sha: RESULT_SHA,
      signed_by: 'reviewer@acme',
    };
    const signed = signAuthorization(decision, REVIEWER_PRIV);
    await client.query(
      `insert into human_authorizations
         (id, organization_id, project_id, task_id, attempt_id, pull_request_id,
          disposition, reviewed_result_sha, signed_by, signature)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ['H'.repeat(26), ORG, PROJ, TASK, ATTEMPT, PR, decision.disposition,
        decision.reviewed_result_sha, decision.signed_by, signed.signature],
    );

    const auth = await resolver.resolveHumanAuthorization(TASK, trace);
    assert.ok(auth !== null, 'the signed authorization must resolve');
    assert.equal(auth.disposition, 'ACCEPTED');
    assert.equal(auth.signedBy, 'reviewer@acme');
    assert.equal(auth.attemptId, ATTEMPT);
    assert.equal(auth.reviewedResultSha, RESULT_SHA);
    assert.equal(auth.pullRequestId, PR);
    // The signature must verify against the row as PERSISTED — proving the
    // resolver selects every field the signature covers. A dropped column here
    // would surface as signatureValid=false rather than as a SQL error.
    assert.equal(auth.signatureValid, true,
      'the persisted row verifies, so the selected columns cover the signed payload');
  } finally {
    await client.close?.();
  }
});

// ---------------------------------------------------------------------------
// 4 — evidence is checked by its BYTES. The real evidence store writes a
//     bundle; the resolver reads it back through the filesystem reader over
//     the same object root, re-hashes it, and reports its identity. Editing the
//     stored file changes the hash it reports.
// ---------------------------------------------------------------------------

test('resolveEvidence re-hashes the bytes the real evidence store wrote, and sees them change', async () => {
  const client = await PgliteClient.create();
  const root = await mkdtemp(join(tmpdir(), 'asep-resolver-objects-'));
  try {
    await migrate(client);
    await seed(client);
    const scope: TenantScope = { organizationId: ORG as never, projectId: PROJ as never };
    const store = new ContentAddressedEvidenceStore(client, new FilesystemObjectStore(root));
    const id = store.allocateEvidenceId();
    const bundle: EvidenceBundle = {
      taskId: TASK as never, attemptId: ATTEMPT as never, baseSha: '0'.repeat(40), resultSha: RESULT_SHA,
      createdAt: '2026-10-29T00:00:00.000Z',
      environment: { imageDigest: `img@sha256:${'1'.repeat(64)}`, lockfileHash: '2'.repeat(64) },
      diff: { artifactId: id as ArtifactId, sha256: '3'.repeat(64) },
      checks: [],
    };
    const ref = await store.putEvidence(scope, id, bundle);

    const resolver = resolverFor(client, root);
    const ev = await resolver.resolveEvidence(trace, id);
    assert.equal(ev.sha256, ref.sha256);
    assert.equal(ev.bytesSha256, ref.sha256, 'the stored bytes hash to the recorded sha256');
    assert.deepEqual(ev.bundle, { taskId: TASK, attemptId: ATTEMPT, baseSha: '0'.repeat(40), resultSha: RESULT_SHA });

    const key = (await client.query('select storage_key from artifacts where id = $1', [id])).rows[0]!['storage_key'] as string;
    await writeFile(join(root, key), JSON.stringify({ ...bundle, resultSha: 'e'.repeat(40) }));
    const tampered = await resolver.resolveEvidence(trace, id);
    assert.notEqual(tampered.bytesSha256, tampered.sha256, 'edited bytes no longer hash to the recorded sha256');
    assert.equal(tampered.bundle.resultSha, 'e'.repeat(40));

    await rm(join(root, key));
    const vanished = await resolver.resolveEvidence(trace, id);
    assert.equal(vanished.bytesSha256, null, 'missing bytes are reported, not assumed');
  } finally {
    await client.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('the forge binding reader runs against the real schema and stays in its tenant', async () => {
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    await seed(client);
    const reader = sqlBindingReader(client);
    assert.deepEqual(await reader.getScoped({ organizationId: ORG, projectId: PROJ }, BINDING), {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', githubRepositoryId: 4242,
    });
    await assert.rejects(
      () => reader.getScoped({ organizationId: 'Z'.repeat(26), projectId: PROJ }, BINDING),
      /not visible in this scope/,
    );
  } finally {
    await client.close?.();
  }
});
