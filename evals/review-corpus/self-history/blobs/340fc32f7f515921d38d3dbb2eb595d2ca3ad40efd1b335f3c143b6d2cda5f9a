// Pilot-manifest verifier suite (exit criteria K5/K6).
//
// Proves the verifier is genuinely adversarial: a valid ten-task manifest is
// accepted, and every falsification mode (short count, duplicate task, replayed
// work order, reused session, fake adapter, no-op change, broken trace, bad
// shapes) is rejected with a specific reason. Registered as a REQUIRED suite so
// it cannot be silently dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The verifier is plain ESM (.mjs); import its pure functions directly.
import {
  verifyManifest,
  verifyManifestAgainstAuthority,
  MIN_PILOT_TASKS,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './verify-pilot-manifest.mjs';
import {
  createSqlAuthorityResolver,
  createResolverFromEnv,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './authority-resolver.mjs';
import {
  signAuthorization,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './human-authorization-crypto.mjs';

console.log('SUITE-ID: asep-suite:pilot-manifest');

const SHA64 = 'a'.repeat(64);
const SHA40 = '0'.repeat(40);

// A single well-formed pilot task, parameterised so each test can perturb one
// field. The defaults describe a genuine, real-provider, changed, traceable task.
function makeTask(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const taskId = `task-${i}`;
  return {
    taskId,
    objective: `objective ${i}`,
    risk: 'R1',
    workOrderSha256: i.toString(16).padStart(64, '0'),
    baseSha: '0'.repeat(40),
    resultSha: (i + 1).toString(16).padStart(40, '0'),
    providerSessionId: `sess-${i}`,
    providerId: 'claude:claude-sonnet@cli-1.2.3',
    pullRequestUrl: `https://github.com/acme/repo/pull/${i + 1}`,
    evidenceChecksum: `sha256:${SHA64}`,
    trace: {
      pullRequestId: `pr-${i}`,
      evidenceArtifactId: `ev-${i}`,
      attemptId: `att-${i}`,
      taskId,
      runId: `run-${i}`,
      projectId: 'proj-1',
      organizationId: 'org-1',
      repositoryBindingId: 'rb-1',
    },
    humanDisposition: 'PENDING',
    ...over,
  };
}

function makeManifest(
  taskCount: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    verdict: 'COMPLETE',
    generatedAt: '2026-07-14T00:00:00.000Z',
    tasks: Array.from({ length: taskCount }, (_, i) => makeTask(i)),
    ...over,
  };
}

test('K5: a genuine ten-task manifest is accepted', () => {
  const res = verifyManifest(makeManifest(MIN_PILOT_TASKS));
  assert.equal(res.ok, true, res.reasons.join('; '));
  assert.deepEqual(res.reasons, []);
});

test('K5: a COMPLETE verdict with fewer than ten tasks is rejected', () => {
  const res = verifyManifest(makeManifest(MIN_PILOT_TASKS - 1));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /requires >= 10 genuine tasks/.test(r)));
});

test('K5: IMPLEMENTATION_COMPLETE_PILOT_PENDING accepts an empty task list', () => {
  const res = verifyManifest(
    makeManifest(0, { verdict: 'IMPLEMENTATION_COMPLETE_PILOT_PENDING' }),
  );
  assert.equal(res.ok, true, res.reasons.join('; '));
});

test('K5: a duplicate taskId is rejected (double-counting)', () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  (m.tasks as Record<string, unknown>[])[9] = makeTask(0); // clone task-0 shape onto slot 9
  const res = verifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /duplicate taskId "task-0"/.test(r)));
});

test('K5: a replayed work order is rejected (retry/replay inflation)', () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  const tasks = m.tasks as Record<string, unknown>[];
  // Distinct taskId + session, but the SAME work order sha as task-0.
  tasks[9] = makeTask(99, { workOrderSha256: (0).toString(16).padStart(64, '0') });
  const res = verifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /replayed workOrderSha256/.test(r)));
});

test('a reused provider session is rejected', () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  const tasks = m.tasks as Record<string, unknown>[];
  tasks[9] = makeTask(99, { providerSessionId: 'sess-0' });
  const res = verifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /reused providerSessionId "sess-0"/.test(r)));
});

test('K6: a fake/mock provider is rejected on a COMPLETE verdict', () => {
  for (const fake of ['fake:claude', 'mock:agent', 'stub:x', 'fixture:y', 'inmemory:z']) {
    const m = makeManifest(MIN_PILOT_TASKS);
    const tasks = m.tasks as Record<string, unknown>[];
    tasks[0]!.providerId = fake;
    const res = verifyManifest(m);
    assert.equal(res.ok, false, `provider ${fake} should be rejected`);
    assert.ok(res.reasons.some((r: string) => /non-real provider/.test(r)));
  }
});

test('a no-op change (baseSha == resultSha) is rejected', () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  const tasks = m.tasks as Record<string, unknown>[];
  tasks[0]!.resultSha = SHA40; // == baseSha default
  const res = verifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /baseSha == resultSha/.test(r)));
});

test('K3: a broken trace chain (trace.taskId mismatch) is rejected', () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  const tasks = m.tasks as Record<string, unknown>[];
  const t0 = tasks[0]!;
  (t0.trace as Record<string, unknown>).taskId = 'not-task-0';
  const res = verifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /broken traceability chain/.test(r)));
});

test('a structurally malformed manifest is rejected by the schema gate', () => {
  const res = verifyManifest({ verdict: 'COMPLETE', tasks: [] }); // missing required fields
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /^schema:/.test(r)));
});

test('a bad PR url shape is rejected by the schema gate', () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  const tasks = m.tasks as Record<string, unknown>[];
  tasks[0]!.pullRequestUrl = 'https://evil.example/pull/1';
  const res = verifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /^schema:/.test(r)));
});

test('an unknown verdict is rejected by the schema enum', () => {
  const res = verifyManifest(makeManifest(MIN_PILOT_TASKS, { verdict: 'DEFINITELY_DONE' }));
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /^schema:/.test(r)));
});

// ---------------------------------------------------------------------------
// HIGH-009 — authoritative cross-check. verifyManifest alone trusts every
// self-declared field; verifyManifestAgainstAuthority resolves each claim
// against persisted state via an injected resolver and fails closed on any
// absence or mismatch. A genuine manifest backed by a matching authority is
// accepted; every forgery mode (missing attempt, forged resultSha, fake
// persisted provider, forged evidence checksum, missing/forged PR, unsigned or
// mismatched human authorization) is rejected.
// ---------------------------------------------------------------------------

// A resolver that reflects the GENUINE defaults of makeTask/makeManifest, so a
// pristine manifest cross-checks cleanly. Tests perturb either the manifest or
// this authority to drive a specific mismatch.
function genuineAuthority(over: {
  attempt?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  evidence?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  pr?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  auth?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
} = {}) {
  const idxOf = (s: string) => Number(String(s).replace(/[^0-9]/g, ''));
  const SHA64local = 'a'.repeat(64);
  return {
    async resolveAttempt(trace: Record<string, unknown>) {
      const i = idxOf(trace.taskId as string);
      const base = {
        attemptId: `att-${i}`,
        taskId: `task-${i}`,
        runId: `run-${i}`,
        repositoryBindingId: 'rb-1',
        resultSha: (i + 1).toString(16).padStart(40, '0'),
        evidenceArtifactId: `ev-${i}`,
        evidenceSha256: SHA64local,
        providerId: 'claude:claude-sonnet@cli-1.2.3',
      };
      return over.attempt ? over.attempt(i, base) : base;
    },
    async resolveEvidence(trace: Record<string, unknown>, _id: string) {
      const i = idxOf(trace.taskId as string);
      const base = { sha256: SHA64local, kind: 'evidence-bundle' };
      return over.evidence ? over.evidence(i, base) : base;
    },
    async resolvePullRequest(trace: Record<string, unknown>, _id: string) {
      const i = idxOf(trace.taskId as string);
      const base = {
        number: i + 1,
        url: `https://github.com/acme/repo/pull/${i + 1}`,
        headBranch: `asep/${trace.taskId}`,
        attemptId: `att-${i}`,
      };
      return over.pr ? over.pr(i, base) : base;
    },
    async resolveHumanAuthorization(taskId: string) {
      const i = idxOf(taskId);
      const base = { disposition: 'PENDING', signedBy: 'reviewer@acme', signatureValid: true };
      return over.auth ? over.auth(i, base) : base;
    },
  };
}

test('HIGH-009: a genuine manifest backed by matching authority is accepted', async () => {
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), genuineAuthority());
  assert.equal(res.ok, true, res.reasons.join('; '));
});

test('HIGH-009: cross-check WITHOUT a resolver is refused (no self-declared manifest honoured)', async () => {
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), null);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /requires a resolver/.test(r)));
});

test('HIGH-009: a manifest with NO authoritative attempt is rejected', async () => {
  const authority = genuineAuthority({ attempt: () => null });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /no authoritative attempt/.test(r)));
});

test('HIGH-009: a forged resultSha (disagrees with persisted attempt) is rejected', async () => {
  const authority = genuineAuthority({
    attempt: (i, base) => ({ ...base, resultSha: 'f'.repeat(40) }),
  });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /forged result/.test(r)));
});

test('HIGH-009: a manifest claiming real Claude but backed by a FAKE persisted provider is rejected (K6 authoritative)', async () => {
  const authority = genuineAuthority({
    attempt: (i, base) => ({ ...base, providerId: 'fake:claude' }),
  });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /non-real adapter/.test(r)));
});

test('HIGH-009: a forged evidence checksum (disagrees with the stored artifact) is rejected', async () => {
  const authority = genuineAuthority({
    evidence: () => ({ sha256: 'b'.repeat(64), kind: 'evidence-bundle' }),
  });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /forged evidence/.test(r)));
});

test('HIGH-009: a missing authoritative PR is rejected', async () => {
  const authority = genuineAuthority({ pr: () => null });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /no authoritative pull request/.test(r)));
});

test('HIGH-009: a PR url that disagrees with the authoritative record is rejected', async () => {
  const authority = genuineAuthority({
    pr: (i, base) => ({ ...base, url: `https://github.com/acme/repo/pull/${9000 + i}` }),
  });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /forged PR link/.test(r)));
});

test('HIGH-009: an UNSIGNED human authorization is rejected (PR2-08)', async () => {
  const authority = genuineAuthority({
    auth: (i, base) => ({ ...base, signatureValid: false }),
  });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /signature is not valid/.test(r)));
});

test('HIGH-009: a missing human authorization is rejected (PR2-08)', async () => {
  const authority = genuineAuthority({ auth: () => null });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /no authoritative human authorization/.test(r)));
});

test('HIGH-009: a manifest disposition that disagrees with the authoritative record is rejected', async () => {
  const authority = genuineAuthority({
    auth: (i, base) => ({ ...base, disposition: 'REJECTED' }),
  });
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /self-declared disposition/.test(r)));
});

test('HIGH-009: a structurally malformed manifest never reaches the resolver', async () => {
  let resolverCalled = false;
  const authority = {
    async resolveAttempt() { resolverCalled = true; return null; },
    async resolveEvidence() { resolverCalled = true; return null; },
    async resolvePullRequest() { resolverCalled = true; return null; },
    async resolveHumanAuthorization() { resolverCalled = true; return null; },
  };
  const res = await verifyManifestAgainstAuthority({ verdict: 'COMPLETE', tasks: [] }, authority);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /^schema:/.test(r)));
  assert.equal(resolverCalled, false, 'the resolver must not run on a malformed manifest');
});

// ---------------------------------------------------------------------------
// HIGH-009 — THE REAL CLI. The defect was never in verifyManifestAgainstAuthority
// (which already existed and worked); it was that the CLI entrypoint called the
// self-declared path instead, so piping a manifest of ten fabricated tasks into
// the real command printed "pilot manifest OK" and exited 0. These tests SPAWN
// the actual CLI — the same argv an operator or CI job would use — because only
// that reproduces the finding. Asserting on the exported functions would have
// passed throughout the defect's lifetime.
// ---------------------------------------------------------------------------

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'verify-pilot-manifest.mjs');

// Run the CLI with an EMPTY-ish env by default: the production path must not be
// satisfiable by whatever happens to be exported in the developer's shell.
function runCli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    shell: false,
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function writeManifest(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'asep-pilot-'));
  const p = join(dir, 'pilot-manifest.json');
  writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

test('HIGH-009 (CLI): a FORGED ten-task COMPLETE manifest is REJECTED by the real command', () => {
  // This manifest is internally perfect and entirely invented — exactly the
  // artifact that previously exited 0 with "pilot manifest OK".
  const path = writeManifest(makeManifest(MIN_PILOT_TASKS));
  const res = runCli([path]);
  assert.notEqual(res.code, 0, `forged COMPLETE manifest must not exit 0; got ${res.code}: ${res.stdout}`);
  assert.ok(!/pilot manifest OK/.test(res.stdout), 'the CLI must not print OK for a self-declared manifest');
  assert.match(res.stderr, /REJECTED/);
  // And the reason names the missing authority wiring, not some incidental error.
  assert.match(res.stderr, /ASEP_PG_URL/);
});

test('HIGH-009 (CLI): --self-check-only REFUSES to honour a COMPLETE verdict', () => {
  const path = writeManifest(makeManifest(MIN_PILOT_TASKS));
  const res = runCli([path, '--self-check-only']);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /COMPLETE verdict cannot be verified without the authoritative cross-check/);
});

test('HIGH-009 (CLI): --self-check-only DOES accept an honest PILOT_PENDING manifest', () => {
  const path = writeManifest(
    makeManifest(0, { verdict: 'IMPLEMENTATION_COMPLETE_PILOT_PENDING' }),
  );
  const res = runCli([path, '--self-check-only']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /self-consistent \(NOT authority-checked\)/);
});

test('HIGH-009 (CLI): a missing reviewer public key is a REJECTION, not a downgrade', () => {
  const path = writeManifest(makeManifest(MIN_PILOT_TASKS));
  // PG url present, signing key absent: the gate must still refuse rather than
  // fall back to trusting the manifest's own humanDisposition.
  const res = runCli([path], { ASEP_PG_URL: 'postgresql://unused:5432/db' });
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /ASEP_REVIEWER_PUBLIC_KEY/);
});

// ---------------------------------------------------------------------------
// HIGH-009 — the production resolver. Driven against a fake SQL executor that
// records the exact (text, params) it is asked, so we prove:
//   * every lookup is tenant-scoped and parameter-bound (no interpolation);
//   * `signatureValid` is the result of REAL ed25519 verification over the row's
//     own canonical payload — a fabricated or post-signing-edited row is false.
// ---------------------------------------------------------------------------

type Captured = { text: string; params: readonly unknown[] };

function fakeDb(rowsFor: (text: string, params: readonly unknown[]) => Record<string, unknown>[]) {
  const calls: Captured[] = [];
  return {
    calls,
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });
      const rows = rowsFor(text, params);
      return { rows, rowCount: rows.length };
    },
  };
}

const keys = generateKeyPairSync('ed25519');
const REVIEWER_PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const REVIEWER_PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function signedAuthRow(over: Record<string, unknown> = {}) {
  const decision = {
    task_id: 'task-1',
    attempt_id: 'att-1',
    pull_request_id: 'pr-1',
    disposition: 'ACCEPTED',
    reviewed_result_sha: 'b'.repeat(40),
    signed_by: 'reviewer@acme',
  };
  const signed = signAuthorization(decision, REVIEWER_PRIV);
  // `over` is applied AFTER signing on purpose: that is the tamper scenario.
  return { ...signed, ...over };
}

test('HIGH-009 (resolver): a genuinely signed authorization reports signatureValid=true', async () => {
  const db = fakeDb(() => [signedAuthRow()]);
  const resolver = createSqlAuthorityResolver(db, { reviewerPublicKeyPem: REVIEWER_PUB });
  const auth = await resolver.resolveHumanAuthorization('task-1', {
    organizationId: 'org-1', projectId: 'proj-1',
  });
  assert.equal(auth.signatureValid, true);
  assert.equal(auth.disposition, 'ACCEPTED');
});

test('HIGH-009 (resolver): a disposition EDITED after signing reports signatureValid=false', async () => {
  // The row says ACCEPTED but the signature covers PENDING's payload — flipping
  // the decision in the database cannot produce a valid signature.
  const db = fakeDb(() => [signedAuthRow({ disposition: 'REJECTED' })]);
  const resolver = createSqlAuthorityResolver(db, { reviewerPublicKeyPem: REVIEWER_PUB });
  const auth = await resolver.resolveHumanAuthorization('task-1', {
    organizationId: 'org-1', projectId: 'proj-1',
  });
  assert.equal(auth.signatureValid, false, 'an edited decision must not verify');
});

test('HIGH-009 (resolver): a FABRICATED row (inserted by whoever can write the DB) does not verify', async () => {
  const db = fakeDb(() => [{
    task_id: 'task-1', attempt_id: 'att-1', pull_request_id: 'pr-1',
    disposition: 'ACCEPTED', reviewed_result_sha: 'c'.repeat(40),
    signed_by: 'attacker@evil', signature: Buffer.alloc(64).toString('base64'),
  }]);
  const resolver = createSqlAuthorityResolver(db, { reviewerPublicKeyPem: REVIEWER_PUB });
  const auth = await resolver.resolveHumanAuthorization('task-1', {
    organizationId: 'org-1', projectId: 'proj-1',
  });
  assert.equal(auth.signatureValid, false);
});

test('HIGH-009 (resolver): every lookup is tenant-scoped and fully parameter-bound', async () => {
  const trace = {
    organizationId: 'org-1', projectId: 'proj-1', attemptId: 'att-1',
    taskId: 'task-1', evidenceArtifactId: 'ev-1', pullRequestId: 'pr-1',
  };
  const db = fakeDb(() => []);
  const resolver = createSqlAuthorityResolver(db, { reviewerPublicKeyPem: REVIEWER_PUB });
  await resolver.resolveAttempt(trace);
  await resolver.resolveEvidence(trace, 'ev-1');
  await resolver.resolvePullRequest(trace, 'pr-1');
  await resolver.resolveHumanAuthorization('task-1', trace);

  assert.equal(db.calls.length, 4);
  for (const call of db.calls) {
    assert.match(call.text, /organization_id = \$\d/, `scoped by org: ${call.text}`);
    assert.match(call.text, /project_id = \$\d/, `scoped by project: ${call.text}`);
    assert.ok(call.params.includes('org-1'), 'org id is bound as a parameter');
    assert.ok(call.params.includes('proj-1'), 'project id is bound as a parameter');
    // Nothing tenant-identifying may be spliced into the SQL text itself.
    assert.ok(!call.text.includes('org-1'), 'no interpolated org id in SQL');
  }
});

test('HIGH-009 (resolver): a resolver cannot be built WITHOUT a reviewer public key', () => {
  const db = fakeDb(() => []);
  assert.throws(
    () => createSqlAuthorityResolver(db, { reviewerPublicKeyPem: '' }),
    /requires a reviewer public key/,
  );
});

test('HIGH-009 (resolver): createResolverFromEnv fails closed on missing env', async () => {
  await assert.rejects(() => createResolverFromEnv({}), /ASEP_PG_URL is not set/);
  await assert.rejects(
    () => createResolverFromEnv({ ASEP_PG_URL: 'postgresql://x/y' }),
    /ASEP_REVIEWER_PUBLIC_KEY is not set/,
  );
});

test('HIGH-009 (resolver): an absent authoritative row resolves to null (verifier fails closed)', async () => {
  const db = fakeDb(() => []);
  const resolver = createSqlAuthorityResolver(db, { reviewerPublicKeyPem: REVIEWER_PUB });
  assert.equal(await resolver.resolveAttempt({ organizationId: 'o', projectId: 'p', attemptId: 'a' }), null);
  assert.equal(await resolver.resolveEvidence({ organizationId: 'o', projectId: 'p' }, 'ev'), null);
  assert.equal(await resolver.resolvePullRequest({ organizationId: 'o', projectId: 'p' }, 'pr'), null);
  assert.equal(await resolver.resolveHumanAuthorization('t', { organizationId: 'o', projectId: 'p' }), null);
});
