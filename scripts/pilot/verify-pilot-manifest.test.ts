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
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The verifier is plain ESM (.mjs); import its pure functions directly.
import {
  verifyManifest,
  verifyManifestAgainstAuthority,
  realClaudeProviderId,
  normalizeDockerFlags,
  MIN_PILOT_TASKS,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './verify-pilot-manifest.mjs';
import {
  createSqlAuthorityResolver,
  createResolverFromEnv,
  filesystemObjectReader,
  sqlBindingReader,
  createGitHubForgePort,
  loadVerificationPolicy,
  VERIFICATION_MATRIX_FILE,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './authority-resolver.mjs';
import {
  signAuthorization,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './human-authorization-crypto.mjs';

console.log('SUITE-ID: asep-suite:pilot-manifest');

const SHA64 = 'a'.repeat(64);
const SHA40 = '0'.repeat(40);
// The repository's verification matrix, pinned by its hash as the operator pins
// it, and the policy the resolver loads for that pin.
const MATRIX_SHA = createHash('sha256').update(readFileSync(VERIFICATION_MATRIX_FILE)).digest('hex');
const POLICY = await loadVerificationPolicy(MATRIX_SHA);
// The pilot's pinned Claude configuration, and the id the real adapter reports
// for it.
const PINS = Object.freeze({
  model: 'claude-sonnet',
  cliVersion: '1.2.3',
  agentImage: `asep-agent@sha256:${'1'.repeat(64)}`,
  proxyImage: `node@sha256:${'2'.repeat(64)}`,
  modelBaseUrl: 'https://api.anthropic.com',
  verifyImage: `verify@sha256:${'6'.repeat(64)}`,
  verificationMatrixSha256: MATRIX_SHA,
});
const REAL_ID = 'claude:claude-sonnet@cli-1.2.3';

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

test('K6: a provider id that is not the real Claude adapter\'s is rejected, whatever it is called', () => {
  // Not a list of known fakes: anything without the real adapter's shape fails,
  // including the local doubles' ids.
  for (const other of [
    'fake:claude', 'mock:agent', 'stub:x', 'fixture:y', 'inmemory:z', 'fake-claude', 'seam-test-agent',
    'claude', 'claude:model', 'claude:model@cli-', 'claude:@cli-1.2.3', 'Claude:model@cli-1.2.3', ' claude:m@cli-1',
  ]) {
    const m = makeManifest(MIN_PILOT_TASKS);
    const tasks = m.tasks as Record<string, unknown>[];
    tasks[0]!.providerId = other;
    const res = verifyManifest(m);
    assert.equal(res.ok, false, `provider ${JSON.stringify(other)} should be rejected`);
    assert.ok(res.reasons.some((r: string) => /providerId must be a Claude adapter id/.test(r)), res.reasons.join('; '));
  }
  assert.equal(realClaudeProviderId(PINS), REAL_ID, 'the shape the real adapter reports');
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

// What the harness records for genuine task i: the task's work order (whose
// sha256 is the manifest's), the attempt's context pack, the result commit, the
// canonical evidence bundle and the record of where its checks ran.
const resultOf = (i: number) => (i + 1).toString(16).padStart(40, '0');
const workOrderShaOf = (i: number) => i.toString(16).padStart(64, '0');
const contextPackShaOf = (i: number) => i.toString(16).padStart(64, 'c');
const DIFF_SHA = '7'.repeat(64);
// The hardened flags of the verification sandbox profile, then what a sandbox
// adds for one attempt: its working tree as the one writable mount with `.git`
// read-only over it, and its labels.
const PROFILE_FLAGS = Object.freeze([
  'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--cpus', '1', '--memory', '512m',
]);
const TREE = '/work/wt';
const verifyFlags = (i: number): string[] => [
  ...PROFILE_FLAGS,
  '-v', `${TREE}:${TREE}:rw`, '-v', `${TREE}/.git:${TREE}/.git:ro`,
  '--label', 'asep.role=verification', '--label', `asep.sandbox=sb-${i}`,
  '--label', 'asep.workspace=ws-1', '--label', `asep.attempt=att-${i}`,
];
// R1, the genuine tasks' risk, makes L0, L1 and L2 mandatory.
const GENUINE_CHECKS = [['L0-workspace', 'workspace'], ['L1-static', 'static'], ['L2-unit', 'unit']] as const;

test('the verification policy is the pinned matrix and the sandbox profile the command runner builds', () => {
  assert.deepEqual([...POLICY.sandboxFlags], [...PROFILE_FLAGS]);
  assert.deepEqual([...POLICY.matrix.R1], ['L0', 'L1', 'L2']);
  assert.equal(POLICY.matrixSha256, MATRIX_SHA);
});

test('a verification matrix that does not hash to its pin is never loaded', async () => {
  await assert.rejects(() => loadVerificationPolicy('b'.repeat(64)), /hashes to [0-9a-f]{64}, not the pinned b{64}/);
  await assert.rejects(() => loadVerificationPolicy('not-a-hash'), /is not a sha256/);
  const dir = mkdtempSync(join(tmpdir(), 'asep-matrix-'));
  const edited = join(dir, 'verification-matrix.yaml');
  // The reviewer's case: R1 asking for L0 only.
  writeFileSync(edited, readFileSync(VERIFICATION_MATRIX_FILE, 'utf8').replace('R1: [L0, L1, L2]', 'R1: [L0]'));
  await assert.rejects(() => loadVerificationPolicy(MATRIX_SHA, { matrixFile: edited }), /hashes to .* not the pinned/);
});

function genuineBundle(i: number): Record<string, any> {
  return {
    taskId: `task-${i}`,
    attemptId: `att-${i}`,
    baseSha: '0'.repeat(40),
    resultSha: resultOf(i),
    createdAt: '2026-10-29T00:00:00.000Z',
    environment: { imageDigest: PINS.agentImage, lockfileHash: 'f'.repeat(64), nodeVersion: 'v24.6.0' },
    diff: { artifactId: `diff-${i}`, sha256: DIFF_SHA },
    checks: GENUINE_CHECKS.map(([id, category], k) => ({
      id, category, command: 'git status --porcelain', exitCode: 0, durationMs: 0,
      stdoutArtifactId: `out-${i}-${k}`, stderrArtifactId: `err-${i}-${k}`,
    })),
  };
}

function genuineProvenance(i: number): Record<string, any> {
  return {
    taskId: `task-${i}`,
    attemptId: `att-${i}`,
    planId: 'plan-R1',
    risk: 'R1',
    verdict: 'PASS',
    checks: genuineBundle(i).checks.map((c: Record<string, unknown>, k: number) => ({
      id: c.id, level: `L${k}`, mandatory: true, verdict: 'PASS', command: c.command, exitCode: c.exitCode,
      stdoutArtifactId: c.stdoutArtifactId, stderrArtifactId: c.stderrArtifactId,
      provenance: { where: 'container', image: PINS.verifyImage, container: `sb-${i}-${k + 1}`, runFlags: verifyFlags(i) },
    })),
  };
}

// The artifacts of genuine task i by id, each intact.
function genuineArtifact(i: number, id: string): Record<string, unknown> | null {
  const intact = (kind: string, sha256: string) => ({ kind, sha256, bytesSha256: sha256 });
  if (id === `wo-${i}`) return intact('work-order', workOrderShaOf(i));
  if (id === `cp-${i}`) return intact('context-pack', contextPackShaOf(i));
  if (id === `diff-${i}`) return intact('git-diff', DIFF_SHA);
  if (id.startsWith(`out-${i}-`)) return intact('command-stdout', '8'.repeat(64));
  if (id.startsWith(`err-${i}-`)) return intact('command-stderr', '9'.repeat(64));
  return null;
}

// A resolver that reflects the GENUINE defaults of makeTask/makeManifest, so a
// pristine manifest cross-checks cleanly. Tests perturb either the manifest or
// this authority to drive a specific mismatch.
function genuineAuthority(over: {
  pins?: () => unknown;
  policy?: () => unknown;
  agentRun?: (i: number, base: Record<string, any>) => unknown;
  attempt?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  evidence?: (i: number, base: Record<string, any>) => Record<string, unknown> | null;
  artifact?: (i: number, id: string, base: Record<string, unknown> | null) => Record<string, unknown> | null;
  verification?: (i: number, base: Array<Record<string, any>>) => unknown;
  pr?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  livePr?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  auth?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
} = {}) {
  const idxOf = (s: string) => Number(String(s).replace(/[^0-9]/g, ''));
  const SHA64local = 'a'.repeat(64);
  return {
    pinnedAgent() {
      return over.pins ? over.pins() : PINS;
    },
    verificationPolicy() {
      return over.policy ? over.policy() : POLICY;
    },
    // What the real adapter recorded for this attempt: its invocation
    // manifest, the CLI's event stream and the egress proxy's log, each intact.
    async resolveAgentRun(trace: Record<string, unknown>) {
      const i = idxOf(trace.taskId as string);
      const intact = (n: string) => ({ sha256: n.repeat(64), bytesSha256: n.repeat(64) });
      const base = {
        invocation: [{
          ...intact('3'),
          manifest: {
            providerId: REAL_ID, model: PINS.model, cliVersion: PINS.cliVersion,
            image: PINS.agentImage, proxyImage: PINS.proxyImage, upstream: PINS.modelBaseUrl,
            inputs: [
              { name: 'work-order', artifactId: `wo-${i}`, sha256: workOrderShaOf(i) },
              { name: 'context-pack', artifactId: `cp-${i}`, sha256: contextPackShaOf(i) },
            ],
          },
        }],
        events: [{
          ...intact('4'),
          init: { sessionId: `sess-${i}`, model: PINS.model, cliVersion: PINS.cliVersion },
          result: { sessionId: `sess-${i}`, subtype: 'success', isError: false },
        }],
        egress: [{ ...intact('5'), modelCalls: 2 }],
      };
      return over.agentRun ? over.agentRun(i, base) : base;
    },
    async resolveAttempt(trace: Record<string, unknown>) {
      const i = idxOf(trace.taskId as string);
      const base = {
        attemptId: `att-${i}`,
        taskId: `task-${i}`,
        runId: `run-${i}`,
        repositoryBindingId: 'rb-1',
        baseSha: '0'.repeat(40),
        resultSha: resultOf(i),
        evidenceArtifactId: `ev-${i}`,
        evidenceSha256: SHA64local,
        providerId: REAL_ID,
        taskStatus: 'WAITING_FOR_HUMAN_REVIEW',
        taskRisk: 'R1',
        workOrderArtifactId: `wo-${i}`,
        workOrderSha256: workOrderShaOf(i),
        contextPackArtifactId: `cp-${i}`,
        contextPackSha256: contextPackShaOf(i),
      };
      return over.attempt ? over.attempt(i, base) : base;
    },
    // The stored bytes hash to the recorded sha256 and parse as the canonical
    // bundle of this very attempt.
    async resolveEvidence(trace: Record<string, unknown>, _id: string) {
      const i = idxOf(trace.taskId as string);
      const base = {
        sha256: SHA64local,
        kind: 'evidence-bundle',
        bytesSha256: SHA64local,
        bundle: genuineBundle(i),
      };
      return over.evidence ? over.evidence(i, base) : base;
    },
    async resolveArtifact(trace: Record<string, unknown>, id: string) {
      const i = idxOf(trace.taskId as string);
      const base = genuineArtifact(i, id);
      return over.artifact ? over.artifact(i, id, base) : base;
    },
    // The one record of where the attempt's verification checks ran, intact.
    async resolveVerification(trace: Record<string, unknown>) {
      const i = idxOf(trace.taskId as string);
      const base = [{ sha256: 'e'.repeat(64), bytesSha256: 'e'.repeat(64), record: genuineProvenance(i) }];
      return over.verification ? over.verification(i, base) : base;
    },
    async resolvePullRequest(trace: Record<string, unknown>, _id: string) {
      const i = idxOf(trace.taskId as string);
      const base = {
        number: i + 1,
        url: `https://github.com/acme/repo/pull/${i + 1}`,
        headBranch: `asep/${trace.taskId}`,
        baseBranch: 'main',
        state: 'OPEN',
        attemptId: `att-${i}`,
      };
      return over.pr ? over.pr(i, base) : base;
    },
    // What the forge reports for the PR right now.
    async resolveLivePullRequest(trace: Record<string, unknown>, _q: Record<string, unknown>) {
      const i = idxOf(trace.taskId as string);
      const base = {
        number: i + 1,
        url: `https://github.com/acme/repo/pull/${i + 1}`,
        headBranch: `asep/${trace.taskId}`,
        headSha: resultOf(i),
        baseBranch: 'main',
        state: 'open',
        merged: false,
      };
      return over.livePr ? over.livePr(i, base) : base;
    },
    async resolveHumanAuthorization(taskId: string) {
      const i = idxOf(taskId);
      const base = {
        disposition: 'PENDING', signedBy: 'reviewer@acme', signatureValid: true,
        attemptId: `att-${i}`, reviewedResultSha: resultOf(i), pullRequestId: `pr-${i}`,
      };
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
  // The local doubles' ids, a deny-list name, and real-shaped ids for another
  // model or CLI version than the pilot pinned.
  for (const persisted of [
    'fake-claude', 'seam-test-agent', 'fake:claude', 'claude:claude-sonnet@cli-1.2.4', 'claude:claude-opus@cli-1.2.3', '',
  ]) {
    const authority = genuineAuthority({ attempt: (i, base) => ({ ...base, providerId: persisted }) });
    const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
    assert.equal(res.ok, false, `persisted provider ${JSON.stringify(persisted)} must be rejected`);
    assert.ok(res.reasons.some((r: string) => /is not the real Claude adapter for the pinned model and CLI|has no providerId/.test(r)),
      res.reasons.join('; '));
  }
});

test('a manifest providerId that disagrees with the persisted provider is rejected', async () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  (m.tasks as Record<string, unknown>[])[0]!.providerId = 'claude:claude-sonnet@cli-9.9.9';
  const res = await verifyManifestAgainstAuthority(m, genuineAuthority());
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /manifest providerId .* != persisted provider/.test(r)), res.reasons.join('; '));
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

// --- the evidence bytes, the live PR, and what the signature binds ----------------

async function rejectsWith(authority: ReturnType<typeof genuineAuthority>, pattern: RegExp, what = '') {
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  const of = what === '' ? '' : `${what}: `;
  assert.equal(res.ok, false, `${of}expected a rejection matching ${pattern}`);
  assert.ok(res.reasons.some((r: string) => pattern.test(r)), `${of}${pattern} not among: ${res.reasons.join('; ')}`);
}

test('evidence whose stored bytes no longer hash to the recorded sha256 is rejected', async () => {
  await rejectsWith(genuineAuthority({ evidence: (i, b) => ({ ...b, bytesSha256: 'c'.repeat(64) }) }),
    /stored evidence bytes hash to/);
});

test('evidence whose bytes cannot be read back is rejected', async () => {
  await rejectsWith(genuineAuthority({ evidence: (i, b) => ({ ...b, bytesSha256: null, bundle: null }) }),
    /stored evidence bytes hash to/);
});

test('evidence bytes that are not an evidence bundle are rejected', async () => {
  await rejectsWith(genuineAuthority({ evidence: (i, b) => ({ ...b, bundle: null }) }),
    /not an evidence bundle/);
});

test('an artifact of another kind cannot stand in for the evidence bundle', async () => {
  await rejectsWith(genuineAuthority({ evidence: (i, b) => ({ ...b, kind: 'command-stdout' }) }),
    /is not an evidence bundle/);
});

test('an evidence bundle of another task, attempt, base or result is rejected', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ taskId: 'task-other' }, /evidence bundle names task "task-other"/],
    [{ attemptId: 'att-other' }, /evidence bundle names attempt "att-other"/],
    [{ resultSha: 'e'.repeat(40) }, /evidence bundle records result/],
    [{ baseSha: 'e'.repeat(40) }, /evidence bundle records base/],
  ];
  for (const [field, pattern] of cases) {
    await rejectsWith(genuineAuthority({
      evidence: (i, b) => ({ ...b, bundle: { ...(b.bundle as object), ...field } }),
    }), pattern);
  }
});

test('a PR the forge no longer has is rejected', async () => {
  await rejectsWith(genuineAuthority({ livePr: () => null }), /the forge has no pull request/);
});

test('a PR whose live head has moved off the reviewed commit is rejected', async () => {
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, headSha: 'f'.repeat(40) }) }),
    /live PR head .* != the attempt result/);
});

test('a PR whose live head the forge does not report is rejected', async () => {
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, headSha: undefined }) }),
    /did not report the PR head commit/);
});

// A PR a human closed or merged, or one retargeted onto another base, is not
// the publication under review, whatever its head shows. The fixture is the
// genuine pilot with only the live PR changed.
test('a live PR that is closed, merged or on another base is rejected', async () => {
  const closedPr = genuineAuthority({ livePr: (i, b) => ({ ...b, state: 'closed', merged: false }) });
  await rejectsWith(closedPr, /live PR #\d+ is closed/);
  const mergedPr = genuineAuthority({ livePr: (i, b) => ({ ...b, state: 'closed', merged: true }) });
  await rejectsWith(mergedPr, /live PR #\d+ is merged/);
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, baseBranch: 'release/2' }) }),
    /live PR base "release\/2" != the attempt's recorded base "main"/);
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, state: undefined }) }), /not reported open/);
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, merged: undefined }) }),
    /did not report whether live PR #\d+ is merged/);
  await rejectsWith(genuineAuthority({ pr: (i, b) => ({ ...b, state: 'CLOSED' }) }), /recorded "CLOSED", not OPEN/);
});

test('a live PR with another number or url than the record is rejected', async () => {
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, number: 9000 + i }) }), /live PR number/);
  await rejectsWith(genuineAuthority({ livePr: (i, b) => ({ ...b, url: `https://github.com/acme/repo/pull/${9000 + i}` }) }),
    /live PR url/);
});

test('a resolver that cannot look the PR up on the forge is refused', async () => {
  const { resolveLivePullRequest: _drop, ...partial } = genuineAuthority();
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), partial);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /cannot look the pull request up on the forge/.test(r)), res.reasons.join('; '));
});

test('a signed authorization for another attempt, commit or PR is rejected', async () => {
  await rejectsWith(genuineAuthority({ auth: (i, b) => ({ ...b, attemptId: 'att-other' }) }),
    /authorization was signed for attempt "att-other"/);
  await rejectsWith(genuineAuthority({ auth: (i, b) => ({ ...b, reviewedResultSha: 'e'.repeat(40) }) }),
    /authorization was signed for result/);
  await rejectsWith(genuineAuthority({ auth: (i, b) => ({ ...b, pullRequestId: 'pr-other' }) }),
    /authorization was signed for pull request "pr-other"/);
});

// --- the agent run: only the real adapter, under the pilot's pins ----------------

test('an attempt the real adapter recorded nothing for (a local double ran) is rejected', async () => {
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS),
    genuineAuthority({ agentRun: () => ({ invocation: [], events: [], egress: [] }) }));
  assert.equal(res.ok, false);
  for (const what of [/no invocation manifest recorded/, /no event stream recorded/, /no egress log recorded/]) {
    assert.ok(res.reasons.some((r: string) => what.test(r)), `${what} not among: ${res.reasons.join('; ')}`);
  }
  await rejectsWith(genuineAuthority({ agentRun: () => null }), /no agent artifacts recorded/);
});

test('agent evidence whose bytes changed or vanished, or that is ambiguous, is rejected', async () => {
  for (const kind of ['invocation', 'events', 'egress'] as const) {
    await rejectsWith(genuineAuthority({
      agentRun: (i, b) => ({ ...b, [kind]: [{ ...b[kind][0], bytesSha256: 'f'.repeat(64) }] }),
    }), /bytes hash to .*tampered or missing agent evidence/);
    await rejectsWith(genuineAuthority({
      agentRun: (i, b) => ({ ...b, [kind]: [{ ...b[kind][0], bytesSha256: null }] }),
    }), /hash to nothing \(they could not be read\)/);
    await rejectsWith(genuineAuthority({
      agentRun: (i, b) => ({ ...b, [kind]: [b[kind][0], b[kind][0]] }),
    }), /2 .* artifacts recorded for one attempt/);
  }
});

test('an invocation manifest that does not name the pinned provider, model, CLI, images and model origin is rejected', async () => {
  const fields: Array<[string, string]> = [
    ['providerId', 'fake-claude'], ['model', 'claude-opus'], ['cliVersion', '1.2.4'],
    ['image', `asep-agent@sha256:${'9'.repeat(64)}`], ['proxyImage', `node@sha256:${'9'.repeat(64)}`],
    ['upstream', 'http://127.0.0.1:8080'],
  ];
  for (const [k, v] of fields) {
    await rejectsWith(genuineAuthority({
      agentRun: (i, b) => ({ ...b, invocation: [{ ...b.invocation[0], manifest: { ...b.invocation[0].manifest, [k]: v } }] }),
    }), new RegExp(`invocation manifest records ${k} "`));
  }
  await rejectsWith(genuineAuthority({
    agentRun: (i, b) => ({ ...b, invocation: [{ ...b.invocation[0], manifest: null }] }),
  }), /not the Claude adapter's manifest/);
});

test('an event stream whose CLI init or result is not the pinned, successful session of the manifest is rejected', async () => {
  const withInit = (init: unknown) => genuineAuthority({
    agentRun: (i, b) => ({ ...b, events: [{ ...b.events[0], init }] }),
  });
  await rejectsWith(withInit(null), /holds no init event/);
  await rejectsWith(withInit({ sessionId: 'sess-0', model: PINS.model, cliVersion: '9.9.9' }), /CLI reported version "9.9.9"/);
  await rejectsWith(withInit({ sessionId: 'sess-0', model: 'claude-opus', cliVersion: PINS.cliVersion }), /CLI reported model "claude-opus"/);
  await rejectsWith(genuineAuthority({
    agentRun: (i, b) => ({ ...b, events: [{ ...b.events[0], init: { ...b.events[0].init, sessionId: 'someone-else' } }] }),
  }), /CLI session is "someone-else", not the manifest providerSessionId/);
  const withResult = (result: unknown) => genuineAuthority({
    agentRun: (i, b) => ({ ...b, events: [{ ...b.events[0], result }] }),
  });
  await rejectsWith(withResult(null), /holds no result event/);
  await rejectsWith(withResult({ sessionId: 'sess-0', subtype: 'error_max_turns', isError: true }), /ended with result "error_max_turns"/);
  await rejectsWith(withResult({ sessionId: 'sess-0', subtype: 'success', isError: true }), /ended with result "success" \(is_error\)/);
  await rejectsWith(genuineAuthority({
    agentRun: (i, b) => ({ ...b, events: [{ ...b.events[0], result: { ...b.events[0].result, sessionId: 'other' } }] }),
  }), /result event belongs to session "other"/);
});

test('an egress log with no forwarded model call is rejected', async () => {
  for (const modelCalls of [0, -1, 1.5, undefined]) {
    await rejectsWith(genuineAuthority({
      agentRun: (i, b) => ({ ...b, egress: [{ ...b.egress[0], modelCalls }] }),
    }), /forwarded no successful model call/);
  }
});

test('the verifier refuses to judge agent runs without usable pins', async () => {
  await rejectsWith(genuineAuthority({ pins: () => ({ ...PINS, cliVersion: '' }) }), /pinned Claude configuration is unusable: missing cliVersion/);
  await rejectsWith(genuineAuthority({ pins: () => null }), /pinned Claude configuration is unusable/);
  await rejectsWith(genuineAuthority({ pins: () => { throw new Error('no pins here'); } }), /cannot report the pinned Claude configuration/);
  await rejectsWith(genuineAuthority({ pins: () => ({ ...PINS, verifyImage: undefined }) }), /pinned Claude configuration is unusable: missing verifyImage/);
  for (const drop of ['pinnedAgent', 'resolveAgentRun', 'resolveArtifact', 'resolveVerification'] as const) {
    const { [drop]: _gone, ...partial } = genuineAuthority();
    const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), partial);
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r: string) => new RegExp(`lacks ${drop}`).test(r)), res.reasons.join('; '));
  }
});

// --- the task, its work order, its evidence and where its checks ran -------------

// The probe that once passed: tasks seeded straight into the database with a
// local double's provider, risk R4, and a work order and agent session the
// manifest invents. Every one is refused, for every one of those reasons.
test('ten tasks run by a local double at risk R4, with invented work orders and sessions, are refused', async () => {
  const forged = genuineAuthority({
    attempt: (i, b) => ({ ...b, providerId: 'fake-claude', taskRisk: 'R4' }),
    agentRun: () => ({ invocation: [], events: [], egress: [] }),
  });
  for (const providerId of ['fake-claude', REAL_ID]) {
    const m = makeManifest(MIN_PILOT_TASKS);
    (m.tasks as Record<string, unknown>[]).forEach((t, i) => Object.assign(t, {
      providerId, risk: 'R4', workOrderSha256: (1000 + i).toString(16).padStart(64, 'f'), providerSessionId: `invented-${i}`,
    }));
    const res = await verifyManifestAgainstAuthority(m, forged);
    assert.equal(res.ok, false, `claimed provider ${providerId}`);
    if (providerId === 'fake-claude') {
      assert.ok(res.reasons.some((r: string) => /providerId must be a Claude adapter id/.test(r)), res.reasons.join('; '));
      continue;
    }
    for (let i = 0; i < MIN_PILOT_TASKS; i++) {
      const own = res.reasons.filter((r: string) => r.startsWith(`task "task-${i}"`));
      for (const why of [
        /persisted provider "fake-claude" is not the real Claude adapter/,
        /risk "R4" is not admissible/,
        /manifest workOrderSha256 .* != the task's work order/,
        /no event stream recorded/,
      ]) {
        assert.ok(own.some((r: string) => why.test(r)), `task-${i}: ${why} not among: ${own.join('; ')}`);
      }
    }
  }
});

test('a task that is not waiting for human review is refused', async () => {
  for (const status of ['PENDING', 'READY', 'EXECUTING', 'VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED', null]) {
    await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, taskStatus: status }) }),
      /is not waiting for human review/);
  }
});

test('a risk the manifest claims but the task does not have, or one Phase-2 automation may not run, is refused', async () => {
  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, taskRisk: 'R0' }) }),
    /manifest risk "R1" != the task's risk "R0"/);
  for (const risk of ['R2', 'R3', 'R4']) {
    const m = makeManifest(MIN_PILOT_TASKS);
    for (const t of m.tasks as Record<string, unknown>[]) t.risk = risk;
    const res = await verifyManifestAgainstAuthority(m, genuineAuthority({ attempt: (i, b) => ({ ...b, taskRisk: risk }) }));
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r: string) => new RegExp(`risk "${risk}" is not admissible`).test(r)), res.reasons.join('; '));
  }
  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, taskRisk: undefined }) }),
    /manifest risk "R1" != the task's risk/);
});

test('a base the attempt did not start from is refused', async () => {
  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, baseSha: 'e'.repeat(40) }) }),
    /manifest baseSha .* != the attempt's base/);
});

test('a work order the task does not carry, or whose artifact is missing, foreign or altered, is refused', async () => {
  const m = makeManifest(MIN_PILOT_TASKS);
  (m.tasks as Record<string, unknown>[])[0]!.workOrderSha256 = 'f'.repeat(64);
  const res = await verifyManifestAgainstAuthority(m, genuineAuthority());
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r: string) => /manifest workOrderSha256 "f+" != the task's work order/.test(r)), res.reasons.join('; '));

  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, workOrderArtifactId: null, workOrderSha256: null }) }),
    /the task has no work order attached/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('wo-') ? null : b) }),
    /the work order wo-0 is not an artifact of this tenant/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('wo-') ? { ...b, kind: 'context-pack' } : b) }),
    /the work order wo-0 is a "context-pack" artifact, not "work-order"/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('wo-') ? { ...b, bytesSha256: 'd'.repeat(64) } : b) }),
    /stored work order bytes hash to/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('wo-') ? { ...b, sha256: 'd'.repeat(64), bytesSha256: 'd'.repeat(64) } : b) }),
    /the work order wo-0 records sha256 "d+", not/);
});

test('a context pack the attempt does not carry, or whose artifact is missing or altered, is refused', async () => {
  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, contextPackArtifactId: null, contextPackSha256: null }) }),
    /the attempt has no context pack attached/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('cp-') ? null : b) }),
    /the context pack cp-0 is not an artifact of this tenant/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('cp-') ? { ...b, bytesSha256: null } : b) }),
    /stored context pack bytes hash to nothing/);
});

test('an agent that was not handed the task\'s work order and the attempt\'s context pack is refused', async () => {
  const withInputs = (inputs: unknown) => genuineAuthority({
    agentRun: (i, b) => ({ ...b, invocation: [{ ...b.invocation[0], manifest: { ...b.invocation[0].manifest, inputs } }] }),
  });
  await rejectsWith(withInputs(undefined), /the agent was not handed the work order the task carries/);
  await rejectsWith(withInputs([{ name: 'work-order', artifactId: 'wo-other', sha256: workOrderShaOf(0) },
    { name: 'context-pack', artifactId: 'cp-0', sha256: contextPackShaOf(0) }]),
  /the agent was not handed the work order the task carries/);
  await rejectsWith(withInputs([{ name: 'work-order', artifactId: 'wo-0', sha256: workOrderShaOf(0) },
    { name: 'context-pack', artifactId: 'cp-0', sha256: 'd'.repeat(64) }]),
  /the agent was not handed the context pack the attempt carries/);
  await rejectsWith(withInputs([{ name: 'work-order', artifactId: 'wo-0', sha256: workOrderShaOf(0) },
    { name: 'context-pack', artifactId: 'cp-0', sha256: contextPackShaOf(0) },
    { name: 'work-order', artifactId: 'wo-9', sha256: workOrderShaOf(9) }]),
  /the agent was not handed the work order the task carries/);
  await rejectsWith(withInputs([{ name: 'work-order', artifactId: 'wo-0', sha256: workOrderShaOf(0) },
    { name: 'context-pack', artifactId: 'cp-0', sha256: contextPackShaOf(0) },
    { name: 'notes', artifactId: 'n-0', sha256: 'd'.repeat(64) }]),
  /the agent was handed inputs the harness does not give/);
});

test('an attempt with no evidence attached, or with other evidence than the trace, is refused', async () => {
  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, evidenceArtifactId: null, evidenceSha256: null }) }),
    /attempt.evidence_artifact_id "null" != trace.evidenceArtifactId/);
  await rejectsWith(genuineAuthority({ attempt: (i, b) => ({ ...b, evidenceSha256: null }) }),
    /attempt.evidence_sha256 "null" != authoritative artifact sha256/);
});

// The bundle is checked against the canonical evidence-bundle shape, field by
// field, not for four identity fields.
const withBundle = (edit: (b: Record<string, any>) => void) => genuineAuthority({
  evidence: (i, base) => {
    const bundle = JSON.parse(JSON.stringify(base.bundle));
    edit(bundle);
    return { ...base, bundle };
  },
});

test('an evidence bundle that is not the canonical shape is refused', async () => {
  for (const key of ['createdAt', 'environment', 'diff', 'checks', 'baseSha', 'resultSha']) {
    await rejectsWith(withBundle((b) => { delete b[key]; }), new RegExp(`the evidence bundle lacks ${key}`));
  }
  await rejectsWith(withBundle((b) => { b.verdict = 'PASS'; }), /the evidence bundle carries "verdict"/);
  await rejectsWith(withBundle((b) => { b.createdAt = 'yesterday'; }), /createdAt "yesterday" is not an ISO-8601 time/);
  await rejectsWith(withBundle((b) => { b.environment = 'docker'; }), /the evidence bundle environment is not an object/);
  await rejectsWith(withBundle((b) => { delete b.environment.lockfileHash; }), /environment lacks lockfileHash/);
  await rejectsWith(withBundle((b) => { b.environment.lockfileHash = ''; }), /environment lockfileHash is empty/);
  await rejectsWith(withBundle((b) => { b.environment.shell = 'bash'; }), /environment carries "shell"/);
  await rejectsWith(withBundle((b) => { b.environment.imageDigest = `asep-agent@sha256:${'9'.repeat(64)}`; }),
    /records environment image .* not the pinned agent image/);
  await rejectsWith(withBundle((b) => { delete b.diff.sha256; }), /the evidence bundle diff lacks sha256/);
  await rejectsWith(withBundle((b) => { b.diff.lines = 3; }), /diff carries "lines"/);
});

test('an evidence bundle whose checks are missing, malformed or not linked to their raw output is refused', async () => {
  await rejectsWith(withBundle((b) => { b.checks = []; }), /records no verification check/);
  await rejectsWith(withBundle((b) => { b.checks = 'all green'; }), /records no verification check/);
  await rejectsWith(withBundle((b) => { b.checks[0].note = 'fine'; }), /check "L0-workspace" carries "note"/);
  await rejectsWith(withBundle((b) => { b.checks[0].category = 'vibes'; }), /check "L0-workspace" has category "vibes"/);
  await rejectsWith(withBundle((b) => { b.checks[0].exitCode = '0'; }), /check "L0-workspace" has exit code "0"/);
  await rejectsWith(withBundle((b) => { b.checks[0].durationMs = -1; }), /check "L0-workspace" has duration -1/);
  await rejectsWith(withBundle((b) => { b.checks[0].command = ''; }), /check "L0-workspace" has no command/);
  await rejectsWith(withBundle((b) => { b.checks[1].id = 'L0-workspace'; }), /check id "L0-workspace" appears twice/);
  await rejectsWith(withBundle((b) => { delete b.checks[0].stdoutArtifactId; }), /check "L0-workspace" lacks stdoutArtifactId/);
  await rejectsWith(withBundle((b) => { delete b.checks[1].stderrArtifactId; }), /check "L1-static" lacks stderrArtifactId/);
});

test('evidence whose diff or raw check output is missing, of another kind or altered is refused', async () => {
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('diff-') ? null : b) }),
    /the diff diff-0 is not an artifact of this tenant/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('diff-') ? { ...b, kind: 'command-stdout' } : b) }),
    /the diff diff-0 is a "command-stdout" artifact, not "git-diff"/);
  await rejectsWith(withBundle((b) => { b.diff.sha256 = 'd'.repeat(64); }), /the diff diff-0 records sha256 "7+", not "d+"/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('out-') ? { ...b, bytesSha256: 'd'.repeat(64) } : b) }),
    /stored stdout of check "L0-workspace" bytes hash to/);
  await rejectsWith(genuineAuthority({ artifact: (i, id, b) => (id.startsWith('err-') ? { ...b, kind: 'command-stdout' } : b) }),
    /the stderr of check "L0-workspace" err-0-0 is a "command-stdout" artifact, not "command-stderr"/);
});

const withRecord = (edit: (r: Record<string, any>) => void) => genuineAuthority({
  verification: (i, base) => {
    const record = JSON.parse(JSON.stringify(base[0]!.record));
    edit(record);
    return [{ ...base[0], record }];
  },
});

test('an attempt with no single intact record of where its checks ran is refused', async () => {
  await rejectsWith(genuineAuthority({ verification: () => [] }), /no verification provenance record recorded for the attempt/);
  await rejectsWith(genuineAuthority({ verification: () => null }), /no verification provenance record recorded for the attempt/);
  await rejectsWith(genuineAuthority({ verification: (i, b) => [b[0], b[0]] }), /2 verification provenance record artifacts recorded/);
  await rejectsWith(genuineAuthority({ verification: (i, b) => [{ ...b[0], bytesSha256: 'd'.repeat(64) }] }),
    /stored verification provenance record bytes hash to/);
  await rejectsWith(genuineAuthority({ verification: (i, b) => [{ ...b[0], record: null }] }),
    /the verification provenance record is not one the harness writes/);
});

test('a provenance record of another task, attempt or risk, or of a verification that did not pass, is refused', async () => {
  await rejectsWith(withRecord((r) => { r.attemptId = 'att-other'; }), /provenance record names attempt "att-other"/);
  await rejectsWith(withRecord((r) => { r.taskId = 'task-other'; }), /provenance record names task "task-other"/);
  await rejectsWith(withRecord((r) => { r.risk = 'R0'; }), /verified at risk "R0", not the task's "R1"/);
  await rejectsWith(withRecord((r) => { r.verdict = 'FAIL'; }), /the verification verdict was "FAIL", not PASS/);
});

test('a provenance record that does not match the evidence check for check is refused', async () => {
  await rejectsWith(withRecord((r) => { r.checks.pop(); }), /records 2 checks, the evidence bundle 3/);
  await rejectsWith(withRecord((r) => { r.checks = 'ran'; }), /records no checks/);
  for (const field of ['id', 'command', 'exitCode', 'stdoutArtifactId', 'stderrArtifactId']) {
    await rejectsWith(withRecord((r) => { r.checks[1][field] = field === 'exitCode' ? 7 : 'other'; }),
      new RegExp(`provenance check 1 records ${field} .* the evidence check`));
  }
});

test('a check that did not run in the pinned, hardened verification sandbox is refused', async () => {
  await rejectsWith(withRecord((r) => { r.checks[0].provenance = { where: 'host' }; }),
    /check "L0-workspace" ran on the host, not in the verification sandbox/);
  await rejectsWith(withRecord((r) => { delete r.checks[0].provenance; }),
    /check "L0-workspace" has no record of where it ran/);
  await rejectsWith(withRecord((r) => { r.checks[0].provenance.image = `verify@sha256:${'9'.repeat(64)}`; }),
    /check "L0-workspace" ran in image .* not the pinned verification image/);
});

// The flags a check ran under are compared whole with the sandbox profile, not
// searched for known-dangerous ones: any flag added, dropped or changed, in any
// spelling docker accepts, is refused.
test('a check whose docker flags are not exactly the verification sandbox profile is refused', async () => {
  const flags = (edit: (f: string[], i: number) => string[]) => withRecord((r) => {
    const i = Number(String(r.attemptId).replace(/\D/g, ''));
    r.checks[0].provenance.runFlags = edit(verifyFlags(i), i);
  });
  const notProfile = /check "L0-workspace" ran with flags that are not the verification sandbox profile/;
  const without = (f: string[], ...drop: string[]) => {
    const at = f.findIndex((x, k) => drop.every((d, j) => f[k + j] === d));
    assert.ok(at >= 0, `${drop.join(' ')} is in the profile`);
    f.splice(at, drop.length);
    return f;
  };
  const swap = (f: string[], from: string[], to: string[]) => {
    const at = f.findIndex((x, k) => from.every((d, j) => f[k + j] === d));
    assert.ok(at >= 0, `${from.join(' ')} is in the profile`);
    f.splice(at, from.length, ...to);
    return f;
  };
  const refused: Array<[string, (f: string[], i: number) => string[]]> = [
    ['--network none dropped', (f) => without(f, '--network', 'none')],
    ['--read-only dropped', (f) => without(f, '--read-only')],
    ['--cap-drop ALL dropped', (f) => without(f, '--cap-drop', 'ALL')],
    ['no-new-privileges dropped', (f) => without(f, '--security-opt', 'no-new-privileges')],
    ['--net host appended', (f) => [...f, '--net', 'host']],
    ['--net=host appended', (f) => [...f, '--net=host']],
    ['--network=host appended', (f) => [...f, '--network=host']],
    ['--net host instead of --network none', (f) => swap(f, ['--network', 'none'], ['--net', 'host'])],
    ['--net=host instead of --network none', (f) => swap(f, ['--network', 'none'], ['--net=host'])],
    ['--network=host instead of --network none', (f) => swap(f, ['--network', 'none'], ['--network=host'])],
    ['--network=bridge appended', (f) => [...f, '--network=bridge']],
    ['--privileged appended', (f) => [...f, '--privileged']],
    ['--cap-add NET_ADMIN appended', (f) => [...f, '--cap-add', 'NET_ADMIN']],
    ['the docker socket mounted', (f) => [...f, '-v', '/var/run/docker.sock:/var/run/docker.sock']],
    ['a read-only root made writable', (f) => swap(f, ['--read-only'], ['--read-only=false'])],
    ['a looser memory limit', (f) => swap(f, ['--memory', '512m'], ['--memory', '64g'])],
    ['.git left writable', (f) => without(f, '-v', `${TREE}/.git:${TREE}/.git:ro`)],
    ['a second writable mount', (f) => swap(f, ['-v', `${TREE}:${TREE}:rw`], ['-v', `${TREE}:${TREE}:rw`, '-v', '/home:/home:rw'])],
    ['the host root as the working tree', (f, i) => [...PROFILE_FLAGS, '-v', '/:/:rw', '-v', '//.git://.git:ro',
      ...verifyFlags(i).slice(PROFILE_FLAGS.length + 4)]],
    ['a working tree that climbs out', (f) => swap(swap(f, ['-v', `${TREE}:${TREE}:rw`], ['-v', '/work/..:/work/..:rw']),
      ['-v', `${TREE}/.git:${TREE}/.git:ro`], ['-v', '/work/../.git:/work/../.git:ro'])],
    ['another attempt\'s label', (f, i) => swap(f, ['--label', `asep.attempt=att-${i}`], ['--label', `asep.attempt=att-${i + 100}`])],
    ['the flags reordered', (f) => swap(f, ['--read-only', '--tmpfs', '/tmp'], ['--tmpfs', '/tmp', '--read-only'])],
  ];
  for (const [what, edit] of refused) await rejectsWith(flags(edit), notProfile, what);
  await rejectsWith(withRecord((r) => { r.checks[0].provenance.runFlags = 'run --rm'; }),
    /check "L0-workspace" records no docker run flags/);
  await rejectsWith(withRecord((r) => { r.checks[0].provenance.container = 'elsewhere-1'; }),
    /ran in container "elsewhere-1", not one of its sandbox "sb-\d+"/);
  // The same profile in another spelling docker accepts is the same profile.
  const respelled = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), flags((f) => {
    swap(f, ['--network', 'none'], ['--network=none']);
    swap(f, ['--rm'], ['--rm=true']);
    swap(f, ['--label', 'asep.role=verification'], ['-l', 'asep.role=verification']);
    return swap(f, ['--cap-drop', 'ALL'], ['--cap-drop=ALL']);
  }));
  assert.equal(respelled.ok, true, respelled.reasons.join('; '));
  assert.deepEqual(normalizeDockerFlags(['--net=host', '-v', 'a:a:ro', '--rm=true', '--read-only=false', '-l', 'k=v']),
    ['--network', 'host', '--volume', 'a:a:ro', '--rm', '--read-only=false', '--label', 'k=v']);
});

// Both the evidence bundle and the provenance record, edited together, so only
// the coverage of the checks differs from a genuine run.
const withChecks = (edit: (bundleChecks: any[], recordChecks: any[]) => void) => genuineAuthority({
  evidence: (i, base) => {
    const bundle = JSON.parse(JSON.stringify(base.bundle));
    edit(bundle.checks, []);
    return { ...base, bundle };
  },
  verification: (i, base) => {
    const record = JSON.parse(JSON.stringify(base[0]!.record));
    edit([], record.checks);
    return [{ ...base[0], record }];
  },
});

// What verification must cover is the pinned matrix's row for the task's own
// risk: R1 makes L0, L1 and L2 mandatory, whatever the record calls mandatory.
test('a verification that does not cover every level the matrix makes mandatory for the task\'s risk is refused', async () => {
  // The reviewer's probe: R1 with only its L0 check, under an invented plan.
  const onlyL0 = genuineAuthority({
    evidence: (i, base) => {
      const bundle = JSON.parse(JSON.stringify(base.bundle));
      bundle.checks = bundle.checks.slice(0, 1);
      return { ...base, bundle };
    },
    verification: (i, base) => {
      const record = JSON.parse(JSON.stringify(base[0]!.record));
      Object.assign(record, { planId: 'invented', checks: record.checks.slice(0, 1) });
      return [{ ...base[0], record }];
    },
  });
  const probe = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), onlyL0);
  assert.equal(probe.ok, false);
  assert.ok(probe.reasons.some((r: string) => /no check covers L1, which the verification matrix makes mandatory at R1/.test(r)), probe.reasons.join('; '));
  assert.ok(probe.reasons.some((r: string) => /no check covers L2, which the verification matrix makes mandatory at R1/.test(r)), probe.reasons.join('; '));
  // A missing level.
  await rejectsWith(withChecks((b, r) => { b.pop(); r.pop(); }), /no check covers L2, which the verification matrix makes mandatory at R1/);
  // A wrong level: the unit check recorded at another level, or at none the matrix has.
  await rejectsWith(withChecks((b, r) => { if (r[2]) r[2].level = 'L3'; }), /check "L2-unit" is recorded at L3, but the evidence records a "unit" check/);
  await rejectsWith(withChecks((b, r) => { if (r[2]) r[2].level = 'L3'; }), /no check covers L2/);
  await rejectsWith(withChecks((b, r) => { if (r[2]) r[2].level = 'L10'; }), /check "L2-unit" records level "L10", which the verification matrix does not have/);
  await rejectsWith(withChecks((b, r) => { if (b[2]) b[2].category = 'static'; }), /check "L2-unit" is recorded at L2, but the evidence records a "static" check/);
  // A mandatory check relabelled advisory — passing or not.
  await rejectsWith(withChecks((b, r) => { if (r[1]) r[1].mandatory = false; }), /check "L1-static" at L1, mandatory at R1, is recorded advisory/);
  await rejectsWith(withChecks((b, r) => {
    if (b[1]) b[1].exitCode = 1;
    if (r[1]) Object.assign(r[1], { exitCode: 1, mandatory: false, verdict: 'FAIL' });
  }), /check "L1-static" at L1, mandatory at R1, is recorded advisory/);
  await rejectsWith(withChecks((b, r) => { for (const c of r) c.mandatory = false; }), /at L0, mandatory at R1, is recorded advisory/);
  await rejectsWith(withChecks((b, r) => { if (r[0]) delete r[0].mandatory; }), /check "L0-workspace" does not record whether it was mandatory/);
});

test('a mandatory check that did not pass is refused; an advisory check at a level the risk does not require may fail', async () => {
  await rejectsWith(withRecord((r) => { r.checks[0].verdict = 'FAIL'; }), /mandatory check "L0-workspace" did not pass/);
  await rejectsWith(withChecks((b, r) => {
    if (b[0]) b[0].exitCode = 1;
    if (r[0]) r[0].exitCode = 1;
  }), /mandatory check "L0-workspace" did not pass/);
  // L3 is not mandatory at R1: a failing advisory integration check is evidence, not a gate.
  const extra = (b: any[], r: any[]) => {
    if (b.length > 0) b.push({ ...b[2], id: 'L3-integration', category: 'integration', exitCode: 1, stdoutArtifactId: b[2].stdoutArtifactId.replace(/-2$/, '-3'), stderrArtifactId: b[2].stderrArtifactId.replace(/-2$/, '-3') });
    if (r.length > 0) r.push({ ...r[2], id: 'L3-integration', level: 'L3', mandatory: false, verdict: 'FAIL', exitCode: 1, stdoutArtifactId: r[2].stdoutArtifactId.replace(/-2$/, '-3'), stderrArtifactId: r[2].stderrArtifactId.replace(/-2$/, '-3') });
  };
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), withChecks(extra));
  assert.equal(res.ok, true, res.reasons.join('; '));
});

test('coverage is read from the matrix row of the task\'s own risk', async () => {
  // At R0 the matrix asks for L0 and L1 only: the same run without its L2 check is complete.
  const r0 = (i: number, base: Record<string, unknown>) => ({ ...base, taskRisk: 'R0' });
  const authority = genuineAuthority({
    attempt: r0,
    evidence: (i, base) => {
      const bundle = JSON.parse(JSON.stringify(base.bundle));
      bundle.checks.pop();
      return { ...base, bundle };
    },
    verification: (i, base) => {
      const record = JSON.parse(JSON.stringify(base[0]!.record));
      Object.assign(record, { risk: 'R0', checks: record.checks.slice(0, 2) });
      return [{ ...base[0], record }];
    },
  });
  const m = makeManifest(MIN_PILOT_TASKS);
  for (const t of m.tasks as Record<string, unknown>[]) t.risk = 'R0';
  const res = await verifyManifestAgainstAuthority(m, authority);
  assert.equal(res.ok, true, res.reasons.join('; '));
});

test('a verification policy that is not the pinned matrix, or is malformed, refuses every task', async () => {
  await rejectsWith(genuineAuthority({ policy: () => ({ ...POLICY, matrixSha256: 'c'.repeat(64) }) }),
    /the verification policy is unusable: it is matrix "c{64}", not the pinned/);
  await rejectsWith(genuineAuthority({ policy: () => ({ ...POLICY, matrix: { ...POLICY.matrix, R1: ['L0', 'L42'] } }) }),
    /its mandatory levels for R1 are not levels it knows/);
  await rejectsWith(genuineAuthority({ policy: () => ({ ...POLICY, sandboxFlags: [] }) }), /it has no sandbox profile flags/);
  await rejectsWith(genuineAuthority({ policy: () => { throw new Error('no matrix'); } }),
    /cannot report the verification policy — fail closed \(no matrix\)/);
  await rejectsWith(genuineAuthority({ attempt: (i, base) => ({ ...base, taskRisk: 'R9' }) }),
    /the verification matrix has no mandatory levels for the task's risk "R9"/);
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

// Object and forge readers for resolver tests that do not exercise them.
const NO_OBJECTS = { get: async (key: string) => { throw new Error(`no object at ${key}`); } };
const NO_FORGE = { findPullRequest: async () => null };
const resolverOpts = (over: Record<string, unknown> = {}) => ({
  reviewerPublicKeyPem: REVIEWER_PUB, objects: NO_OBJECTS, forge: NO_FORGE, agent: PINS, verificationPolicy: POLICY, ...over,
});

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
  const resolver = createSqlAuthorityResolver(db, resolverOpts());
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
  const resolver = createSqlAuthorityResolver(db, resolverOpts());
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
  const resolver = createSqlAuthorityResolver(db, resolverOpts());
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
  const resolver = createSqlAuthorityResolver(db, resolverOpts());
  await resolver.resolveAttempt(trace);
  await resolver.resolveEvidence(trace, 'ev-1');
  await resolver.resolvePullRequest(trace, 'pr-1');
  await resolver.resolveHumanAuthorization('task-1', trace);
  await resolver.resolveAgentRun(trace);
  await resolver.resolveArtifact(trace, 'wo-1');
  await resolver.resolveVerification(trace);

  assert.equal(db.calls.length, 7);
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
    () => createSqlAuthorityResolver(db, resolverOpts({ reviewerPublicKeyPem: '' })),
    /requires a reviewer public key/,
  );
});

test('a resolver cannot be built without the evidence bytes or the forge', () => {
  const db = fakeDb(() => []);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ objects: undefined })), /evidence object reader/);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ forge: undefined })), /forge/);
});

test('a resolver cannot be built without usable Claude pins', () => {
  const db = fakeDb(() => []);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: undefined })), /lacks model/);
  for (const k of Object.keys(PINS)) {
    assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, [k]: ' ' } })), new RegExp(`lacks ${k}`));
  }
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, agentImage: 'asep-agent:latest' } })),
    /agentImage .* is not digest-pinned/);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, proxyImage: 'node:20' } })),
    /proxyImage .* is not digest-pinned/);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, verifyImage: 'alpine:3' } })),
    /verifyImage .* is not digest-pinned/);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, modelBaseUrl: 'ftp://x' } })), /http\(s\)/);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, verificationMatrixSha256: 'R1: [L0]' } })),
    /verificationMatrixSha256 .* is not a sha256/);
  // The policy must be the matrix the pins name, and be one.
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ verificationPolicy: undefined })), /no verification policy/);
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ verificationPolicy: { ...POLICY, matrixSha256: 'd'.repeat(64) } })),
    /the verification policy is matrix d{64}, not the pinned/);
  // The origin is compared the way the adapter records it.
  const pinned = createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, modelBaseUrl: 'https://api.anthropic.com/' } }))
    .pinnedAgent();
  assert.equal(pinned.modelBaseUrl, 'https://api.anthropic.com');
});

// The three artifacts the real adapter records, as the store holds them.
function agentArtifacts() {
  const sessionId = 'sess-1';
  const invocation = Buffer.from(JSON.stringify({
    providerId: REAL_ID, model: PINS.model, cliVersion: PINS.cliVersion, image: PINS.agentImage,
    proxyImage: PINS.proxyImage, network: { internal: 'asep-agent-net-x', egress: 'bridge', upstream: PINS.modelBaseUrl },
    inputs: [
      { name: 'work-order', artifactId: 'wo-1', sha256: '1'.repeat(64), path: '/in/work-order.json' },
      { name: 'context-pack', artifactId: 'cp-1', sha256: '2'.repeat(64), path: '/in/context-pack.json' },
    ],
    teardown: [],
  }));
  const events = Buffer.from([
    { type: 'system', subtype: 'init', session_id: sessionId, model: PINS.model, claude_code_version: PINS.cliVersion },
    { type: 'assistant', session_id: sessionId, message: { content: [] } },
    'not json at all',
    { type: 'result', subtype: 'success', is_error: false, session_id: sessionId },
  ].map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
  const egress = Buffer.from([
    '2026-10-29T00:00:00.000Z POST /v1/messages -> 200',
    '2026-10-29T00:00:01.000Z POST /v1/messages/count_tokens -> 200',
    '2026-10-29T00:00:02.000Z POST /v1/messages -> 529',
    '2026-10-29T00:00:03.000Z GET /v1/models -> 403',
    '2026-10-29T00:00:04.000Z POST /v1/messages -> 201',
    '',
  ].join('\n'));
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const rows = [
    { kind: 'claude-invocation', sha256: sha(invocation), storage_key: 'k/inv' },
    { kind: 'claude-event-stream', sha256: sha(events), storage_key: 'k/ev' },
    { kind: 'claude-egress-log', sha256: sha(egress), storage_key: 'k/eg' },
  ];
  const bytes: Record<string, Buffer> = { 'k/inv': invocation, 'k/ev': events, 'k/eg': egress };
  return { rows, bytes, sessionId };
}

test('the resolver reads the agent artifacts linked to the attempt, re-hashes them and parses what they say', async () => {
  const { rows, bytes, sessionId } = agentArtifacts();
  const db = fakeDb(() => rows);
  const objects = { get: async (key: string) => new Uint8Array(bytes[key]!) };
  const run = await createSqlAuthorityResolver(db, resolverOpts({ objects }))
    .resolveAgentRun({ organizationId: 'org-1', projectId: 'proj-1', attemptId: 'att-1' });
  assert.match(db.calls[0]!.text, /attempt_id = \$1/);
  assert.deepEqual([...db.calls[0]!.params], ['att-1', 'org-1', 'proj-1', 'claude-invocation', 'claude-event-stream', 'claude-egress-log']);
  assert.equal(run.invocation.length, 1);
  assert.equal(run.invocation[0].bytesSha256, run.invocation[0].sha256);
  // What the agent was handed, by artifact id and checksum; where the files lay
  // on the host is not evidence of anything.
  assert.deepEqual(run.invocation[0].manifest, {
    providerId: REAL_ID, model: PINS.model, cliVersion: PINS.cliVersion,
    image: PINS.agentImage, proxyImage: PINS.proxyImage, upstream: PINS.modelBaseUrl,
    inputs: [
      { name: 'work-order', artifactId: 'wo-1', sha256: '1'.repeat(64) },
      { name: 'context-pack', artifactId: 'cp-1', sha256: '2'.repeat(64) },
    ],
  });
  assert.deepEqual(run.events[0].init, { sessionId, model: PINS.model, cliVersion: PINS.cliVersion });
  assert.deepEqual(run.events[0].result, { sessionId, subtype: 'success', isError: false });
  assert.equal(run.egress[0].modelCalls, 2, 'only forwarded, answered POST /v1/messages calls count');
});

test('agent artifacts whose bytes changed or vanished are reported as such, and none is an empty run', async () => {
  const { rows, bytes } = agentArtifacts();
  const trace = { organizationId: 'org-1', projectId: 'proj-1', attemptId: 'att-1' };
  const changed = await createSqlAuthorityResolver(fakeDb(() => rows),
    resolverOpts({ objects: { get: async (key: string) => new Uint8Array(Buffer.concat([bytes[key]!, Buffer.from('x')])) } }))
    .resolveAgentRun(trace);
  for (const k of ['invocation', 'events', 'egress'] as const) assert.notEqual(changed[k][0].bytesSha256, changed[k][0].sha256);
  const vanished = await createSqlAuthorityResolver(fakeDb(() => rows), resolverOpts()).resolveAgentRun(trace);
  assert.equal(vanished.invocation[0].bytesSha256, null);
  assert.equal(vanished.invocation[0].manifest, null);
  assert.equal(vanished.events[0].init, null);
  assert.equal(vanished.egress[0].modelCalls, 0);
  const none = await createSqlAuthorityResolver(fakeDb(() => []), resolverOpts()).resolveAgentRun(trace);
  assert.deepEqual(none, { invocation: [], events: [], egress: [] });
});

// The evidence row as the database holds it, for a bundle of `bytes`.
function evidenceRow(bytes: Buffer, over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1', kind: 'evidence-bundle', sha256: createHash('sha256').update(bytes).digest('hex'),
    storage_key: 'org-1/proj-1/evidence/ev-1', ...over,
  };
}

test('the resolver fetches the evidence bytes, re-hashes them and parses the whole bundle they hold', async () => {
  const bundle = { ...genuineBundle(1), extra: 'kept, so the verifier can refuse it' };
  const bytes = Buffer.from(JSON.stringify(bundle));
  const asked: string[] = [];
  const objects = { get: async (key: string) => { asked.push(key); return new Uint8Array(bytes); } };
  const resolver = createSqlAuthorityResolver(fakeDb(() => [evidenceRow(bytes)]), resolverOpts({ objects }));
  const ev = await resolver.resolveEvidence({ organizationId: 'org-1', projectId: 'proj-1' }, 'ev-1');
  assert.deepEqual(asked, ['org-1/proj-1/evidence/ev-1'], 'the bytes come from the storage key the row records');
  assert.equal(ev.bytesSha256, ev.sha256);
  assert.deepEqual(ev.bundle, bundle);
});

test('the resolver re-hashes any artifact of the tenant by id, and reports one it cannot read', async () => {
  const bytes = Buffer.from('{"objective":"x"}');
  const row = { id: 'wo-1', kind: 'work-order', sha256: createHash('sha256').update(bytes).digest('hex'), storage_key: 'k/wo' };
  const db = fakeDb(() => [row]);
  const art = await createSqlAuthorityResolver(db, resolverOpts({ objects: { get: async () => new Uint8Array(bytes) } }))
    .resolveArtifact({ organizationId: 'org-1', projectId: 'proj-1' }, 'wo-1');
  assert.deepEqual(art, { kind: 'work-order', sha256: row.sha256, bytesSha256: row.sha256 });
  assert.deepEqual([...db.calls[0]!.params], ['wo-1', 'org-1', 'proj-1']);
  const unread = await createSqlAuthorityResolver(fakeDb(() => [row]), resolverOpts())
    .resolveArtifact({ organizationId: 'org-1', projectId: 'proj-1' }, 'wo-1');
  assert.equal(unread.bytesSha256, null);
  assert.equal(await createSqlAuthorityResolver(fakeDb(() => []), resolverOpts())
    .resolveArtifact({ organizationId: 'org-1', projectId: 'proj-1' }, 'wo-1'), null);
});

test('the resolver reads the attempt\'s verification provenance records, re-hashes and parses them', async () => {
  const record = genuineProvenance(1);
  const bytes = Buffer.from(JSON.stringify(record));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const rows = [{ sha256: sha, storage_key: 'k/vp' }, { sha256: sha, storage_key: 'k/junk' }];
  const db = fakeDb(() => rows);
  const objects = { get: async (key: string) => new Uint8Array(key === 'k/vp' ? bytes : Buffer.from('not json')) };
  const list = await createSqlAuthorityResolver(db, resolverOpts({ objects }))
    .resolveVerification({ organizationId: 'org-1', projectId: 'proj-1', attemptId: 'att-1' });
  assert.match(db.calls[0]!.text, /attempt_id = \$1/);
  assert.deepEqual([...db.calls[0]!.params], ['att-1', 'org-1', 'proj-1', 'verification-provenance']);
  assert.deepEqual(list[0], { sha256: sha, bytesSha256: sha, record });
  assert.equal(list[1].record, null, 'bytes that are not a record parse to null');
  assert.notEqual(list[1].bytesSha256, list[1].sha256);
});

test('evidence bytes that changed, vanished or are not a bundle are reported as such', async () => {
  const scope = { organizationId: 'org-1', projectId: 'proj-1' };
  const original = Buffer.from(JSON.stringify({ taskId: 't', attemptId: 'a', baseSha: 'x', resultSha: 'y' }));
  const tampered = Buffer.from(original.toString().replace('"y"', '"z"'));
  const changed = await createSqlAuthorityResolver(fakeDb(() => [evidenceRow(original)]),
    resolverOpts({ objects: { get: async () => new Uint8Array(tampered) } })).resolveEvidence(scope, 'ev-1');
  assert.notEqual(changed.bytesSha256, changed.sha256);
  assert.equal(changed.bytesSha256, createHash('sha256').update(tampered).digest('hex'));

  const vanished = await createSqlAuthorityResolver(fakeDb(() => [evidenceRow(original)]), resolverOpts())
    .resolveEvidence(scope, 'ev-1');
  assert.equal(vanished.bytesSha256, null);
  assert.equal(vanished.bundle, null);

  const junk = Buffer.from('not json');
  const notBundle = await createSqlAuthorityResolver(fakeDb(() => [evidenceRow(junk)]),
    resolverOpts({ objects: { get: async () => new Uint8Array(junk) } })).resolveEvidence(scope, 'ev-1');
  assert.equal(notBundle.bytesSha256, notBundle.sha256);
  assert.equal(notBundle.bundle, null);
});

test('the resolver asks the forge for the live PR in the trace scope and reports its head', async () => {
  const calls: unknown[] = [];
  const forge = {
    findPullRequest: async (scope: unknown, q: unknown) => {
      calls.push([scope, q]);
      return {
        number: 4, url: 'https://github.com/acme/web/pull/4', headBranch: 'asep/x', baseBranch: 'release/2',
        headSha: 'c'.repeat(40), state: 'closed', merged: true, title: 'not reported on',
      };
    },
  };
  const resolver = createSqlAuthorityResolver(fakeDb(() => []), resolverOpts({ forge }));
  const live = await resolver.resolveLivePullRequest(
    { organizationId: 'org-1', projectId: 'proj-1', attemptId: 'att-1' },
    { repositoryBindingId: 'rb-1', headBranch: 'asep/x' },
  );
  assert.deepEqual(calls, [[{ organizationId: 'org-1', projectId: 'proj-1' }, { repositoryBindingId: 'rb-1', headBranch: 'asep/x' }]]);
  assert.deepEqual(live, {
    number: 4, url: 'https://github.com/acme/web/pull/4', headBranch: 'asep/x', headSha: 'c'.repeat(40),
    baseBranch: 'release/2', state: 'closed', merged: true,
  });

  const none = createSqlAuthorityResolver(fakeDb(() => []), resolverOpts());
  assert.equal(await none.resolveLivePullRequest({ organizationId: 'o', projectId: 'p' }, { repositoryBindingId: 'r', headBranch: 'b' }), null);
});

test('the resolver reports which attempt, commit and PR an authorization was signed for', async () => {
  const db = fakeDb(() => [signedAuthRow()]);
  const auth = await createSqlAuthorityResolver(db, resolverOpts())
    .resolveHumanAuthorization('task-1', { organizationId: 'org-1', projectId: 'proj-1' });
  assert.equal(auth.attemptId, 'att-1');
  assert.equal(auth.reviewedResultSha, 'b'.repeat(40));
  assert.equal(auth.pullRequestId, 'pr-1');
});

test('the filesystem evidence reader stays under its root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asep-objects-'));
  mkdirSync(join(root, 'org', 'proj', 'evidence'), { recursive: true });
  writeFileSync(join(root, 'org', 'proj', 'evidence', 'ev'), 'bytes');
  const reader = filesystemObjectReader(root);
  assert.equal(Buffer.from(await reader.get('org/proj/evidence/ev')).toString(), 'bytes');
  for (const key of ['../outside', 'org/../../outside', '/etc/hosts', 'org\\x', '', 'a/\0b']) {
    await assert.rejects(() => reader.get(key), /refusing evidence key/, `key ${JSON.stringify(key)}`);
  }
});

test('the forge binding reader is tenant-scoped and parameter-bound', async () => {
  const db = fakeDb(() => [{ github_host: 'github.com', github_owner: 'acme', github_repo: 'web', github_repository_id: 42 }]);
  const row = await sqlBindingReader(db).getScoped({ organizationId: 'org-1', projectId: 'proj-1' }, 'rb-1');
  assert.deepEqual(row, { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', githubRepositoryId: 42 });
  assert.match(db.calls[0]!.text, /organization_id = \$\d/);
  assert.match(db.calls[0]!.text, /project_id = \$\d/);
  assert.deepEqual([...db.calls[0]!.params].sort(), ['org-1', 'proj-1', 'rb-1']);
  await assert.rejects(
    () => sqlBindingReader(fakeDb(() => [])).getScoped({ organizationId: 'o', projectId: 'p' }, 'rb-x'),
    /not visible in this scope/,
  );
});

test('HIGH-009 (resolver): createResolverFromEnv fails closed on missing env', async () => {
  await assert.rejects(() => createResolverFromEnv({}), /ASEP_PG_URL is not set/);
  await assert.rejects(
    () => createResolverFromEnv({ ASEP_PG_URL: 'postgresql://x/y' }),
    /ASEP_REVIEWER_PUBLIC_KEY is not set/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'asep-resolver-env-'));
  const pub = join(dir, 'reviewer.pub.pem');
  writeFileSync(pub, REVIEWER_PUB);
  const base = { ASEP_PG_URL: 'postgresql://x/y', ASEP_REVIEWER_PUBLIC_KEY: pub };
  await assert.rejects(() => createResolverFromEnv(base), /ASEP_OBJECT_STORE_DIR is not set/);
  await assert.rejects(
    () => createResolverFromEnv({ ...base, ASEP_OBJECT_STORE_DIR: join(dir, 'missing') }),
    /ASEP_OBJECT_STORE_DIR .* is not a directory/,
  );
  const withObjects = { ...base, ASEP_OBJECT_STORE_DIR: dir };
  await assert.rejects(() => createResolverFromEnv(withObjects), /ASEP_GITHUB_APP_ID is not set/);
  await assert.rejects(
    () => createResolverFromEnv({ ...withObjects, ASEP_GITHUB_APP_ID: '1' }),
    /ASEP_GITHUB_PRIVATE_KEY_PATH is not set/,
  );
  await assert.rejects(
    () => createResolverFromEnv({ ...withObjects, ASEP_GITHUB_APP_ID: '1', ASEP_GITHUB_PRIVATE_KEY_PATH: pub }),
    /ASEP_GITHUB_INSTALLATION_ID is not set/,
  );
  await assert.rejects(
    () => createResolverFromEnv({ ...withObjects, ASEP_GITHUB_APP_ID: 'one', ASEP_GITHUB_PRIVATE_KEY_PATH: pub, ASEP_GITHUB_INSTALLATION_ID: '2' }),
    /ASEP_GITHUB_APP_ID must be a positive integer/,
  );
  // The Claude pins the pilot ran under, from the pilot's own variables.
  const withApp = { ...withObjects, ASEP_GITHUB_APP_ID: '1', ASEP_GITHUB_PRIVATE_KEY_PATH: pub, ASEP_GITHUB_INSTALLATION_ID: '2' };
  const pins = {
    ASEP_CLAUDE_MODEL: PINS.model, ASEP_CLAUDE_CLI_VERSION: PINS.cliVersion,
    ASEP_AGENT_IMAGE_DIGEST: PINS.agentImage, ASEP_EGRESS_PROXY_IMAGE_DIGEST: PINS.proxyImage,
    ASEP_VERIFY_IMAGE_DIGEST: PINS.verifyImage,
    ASEP_VERIFICATION_MATRIX_SHA256: MATRIX_SHA,
  };
  for (const name of Object.keys(pins)) {
    const { [name as keyof typeof pins]: _gone, ...rest } = pins;
    await assert.rejects(() => createResolverFromEnv({ ...withApp, ...rest }), new RegExp(`${name} is not set`));
  }
  await assert.rejects(
    () => createResolverFromEnv({ ...withApp, ...pins, ASEP_ANTHROPIC_BASE_URL: 'http://api.anthropic.com' }),
    /ASEP_ANTHROPIC_BASE_URL must be https/,
  );
  await assert.rejects(
    () => createResolverFromEnv({ ...withApp, ...pins, ASEP_AGENT_IMAGE_DIGEST: 'asep-agent:latest' }),
    /not digest-pinned/,
  );
  await assert.rejects(
    () => createResolverFromEnv({ ...withApp, ...pins, ASEP_VERIFY_IMAGE_DIGEST: 'alpine:3' }),
    /verifyImage .* not digest-pinned/,
  );
  // A matrix the repository no longer holds is never checked against.
  await assert.rejects(
    () => createResolverFromEnv({ ...withApp, ...pins, ASEP_VERIFICATION_MATRIX_SHA256: 'e'.repeat(64) }),
    /verification matrix .* hashes to [0-9a-f]{64}, not the pinned e{64}/,
  );
});

// The verifier's forge is the real GitHub App adapter behind the forge port: a
// lookup resolves the binding in the trace's tenant, queries the PR by head
// branch, and reports its head commit — without needing a local repository.
test('the verifier forge looks a PR up through the GitHub App adapter and reports its head', async () => {
  const db = fakeDb((text) => (/repository_bindings/.test(text)
    ? [{ github_host: 'github.com', github_owner: 'acme', github_repo: 'web', github_repository_id: 42 }]
    : []));
  const listed: unknown[] = [];
  const forge = await createGitHubForgePort(db, { appId: 1, privateKey: 'unused', installationId: 9 }, {
    auth: async () => ({ token: 'ghs_verifier', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    octokitFor: () => ({
      pulls: {
        list: async (q: unknown) => {
          listed.push(q);
          return {
            data: [{
              number: 3, html_url: 'https://github.com/acme/web/pull/3', head: { ref: 'asep/x', sha: 'c'.repeat(40) },
              base: { ref: 'main' }, state: 'closed', merged_at: '2026-10-30T00:00:00Z',
            }],
          };
        },
        create: async () => { throw new Error('a lookup must not create'); },
        update: async () => { throw new Error('a lookup must not update'); },
      },
    }),
  });
  const pr = await forge.findPullRequest({ organizationId: 'org-1', projectId: 'proj-1' }, { repositoryBindingId: 'rb-1', headBranch: 'asep/x' });
  // With its state: a listed PR says it was merged by its merge time.
  assert.deepEqual(pr, {
    number: 3, url: 'https://github.com/acme/web/pull/3', headBranch: 'asep/x', baseBranch: 'main', headSha: 'c'.repeat(40),
    state: 'closed', merged: true,
  });
  assert.deepEqual(listed, [{ owner: 'acme', repo: 'web', head: 'acme:asep/x', state: 'all' }]);
  assert.deepEqual([...db.calls[0]!.params].sort(), ['org-1', 'proj-1', 'rb-1'], 'the binding is read in the trace scope');
  await assert.rejects(
    () => forge.pushBranch({ organizationId: 'org-1', projectId: 'proj-1' }, { repositoryBindingId: 'rb-1', branch: 'asep/x', commitSha: 'c'.repeat(40), expectedRemoteSha: null }),
    /never pushes/,
  );
});

// The production path builds the real GitHub App forge port from the built
// adapter. Nothing connects here: the pool opens lazily, and no lookup runs.
test('createResolverFromEnv builds the resolver over the real GitHub App forge port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asep-resolver-prod-'));
  const pub = join(dir, 'reviewer.pub.pem');
  writeFileSync(pub, REVIEWER_PUB);
  const appKey = join(dir, 'app.pem');
  writeFileSync(appKey, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs1', format: 'pem' }).toString(), { mode: 0o600 });
  const handle = await createResolverFromEnv({
    ASEP_PG_URL: 'postgresql://unused@127.0.0.1:1/none',
    ASEP_REVIEWER_PUBLIC_KEY: pub,
    ASEP_OBJECT_STORE_DIR: dir,
    ASEP_GITHUB_APP_ID: '1',
    ASEP_GITHUB_PRIVATE_KEY_PATH: appKey,
    ASEP_GITHUB_INSTALLATION_ID: '2',
    ASEP_CLAUDE_MODEL: PINS.model,
    ASEP_CLAUDE_CLI_VERSION: PINS.cliVersion,
    ASEP_AGENT_IMAGE_DIGEST: PINS.agentImage,
    ASEP_EGRESS_PROXY_IMAGE_DIGEST: PINS.proxyImage,
    ASEP_VERIFY_IMAGE_DIGEST: PINS.verifyImage,
    ASEP_VERIFICATION_MATRIX_SHA256: MATRIX_SHA,
  });
  try {
    for (const m of [
      'resolveAttempt', 'resolveEvidence', 'resolvePullRequest', 'resolveLivePullRequest', 'resolveHumanAuthorization',
      'pinnedAgent', 'verificationPolicy', 'resolveAgentRun', 'resolveArtifact', 'resolveVerification',
    ]) {
      assert.equal(typeof handle.resolver[m], 'function', m);
    }
    // No base URL set: the public API, as for the pilot.
    assert.deepEqual({ ...handle.resolver.pinnedAgent() }, PINS);
    assert.deepEqual(handle.resolver.verificationPolicy(), POLICY);
  } finally {
    await handle.close();
  }
});

test('HIGH-009 (resolver): an absent authoritative row resolves to null (verifier fails closed)', async () => {
  const db = fakeDb(() => []);
  const resolver = createSqlAuthorityResolver(db, resolverOpts());
  assert.equal(await resolver.resolveAttempt({ organizationId: 'o', projectId: 'p', attemptId: 'a' }), null);
  assert.equal(await resolver.resolveEvidence({ organizationId: 'o', projectId: 'p' }, 'ev'), null);
  assert.equal(await resolver.resolvePullRequest({ organizationId: 'o', projectId: 'p' }, 'pr'), null);
  assert.equal(await resolver.resolveHumanAuthorization('t', { organizationId: 'o', projectId: 'p' }), null);
  assert.equal(await resolver.resolveArtifact({ organizationId: 'o', projectId: 'p' }, 'x'), null);
  assert.deepEqual(await resolver.resolveVerification({ organizationId: 'o', projectId: 'p', attemptId: 'a' }), []);
});
