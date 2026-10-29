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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The verifier is plain ESM (.mjs); import its pure functions directly.
import {
  verifyManifest,
  verifyManifestAgainstAuthority,
  realClaudeProviderId,
  MIN_PILOT_TASKS,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './verify-pilot-manifest.mjs';
import {
  createSqlAuthorityResolver,
  createResolverFromEnv,
  filesystemObjectReader,
  sqlBindingReader,
  createGitHubForgePort,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './authority-resolver.mjs';
import {
  signAuthorization,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './human-authorization-crypto.mjs';

console.log('SUITE-ID: asep-suite:pilot-manifest');

const SHA64 = 'a'.repeat(64);
const SHA40 = '0'.repeat(40);
// The pilot's pinned Claude configuration, and the id the real adapter reports
// for it.
const PINS = Object.freeze({
  model: 'claude-sonnet',
  cliVersion: '1.2.3',
  agentImage: `asep-agent@sha256:${'1'.repeat(64)}`,
  proxyImage: `node@sha256:${'2'.repeat(64)}`,
  modelBaseUrl: 'https://api.anthropic.com',
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

// A resolver that reflects the GENUINE defaults of makeTask/makeManifest, so a
// pristine manifest cross-checks cleanly. Tests perturb either the manifest or
// this authority to drive a specific mismatch.
function genuineAuthority(over: {
  pins?: () => unknown;
  agentRun?: (i: number, base: Record<string, any>) => unknown;
  attempt?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  evidence?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  pr?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  livePr?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
  auth?: (i: number, base: Record<string, unknown>) => Record<string, unknown> | null;
} = {}) {
  const idxOf = (s: string) => Number(String(s).replace(/[^0-9]/g, ''));
  const SHA64local = 'a'.repeat(64);
  const resultOf = (i: number) => (i + 1).toString(16).padStart(40, '0');
  return {
    pinnedAgent() {
      return over.pins ? over.pins() : PINS;
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
        resultSha: resultOf(i),
        evidenceArtifactId: `ev-${i}`,
        evidenceSha256: SHA64local,
        providerId: REAL_ID,
      };
      return over.attempt ? over.attempt(i, base) : base;
    },
    // The stored bytes hash to the recorded sha256 and parse as the bundle of
    // this very attempt.
    async resolveEvidence(trace: Record<string, unknown>, _id: string) {
      const i = idxOf(trace.taskId as string);
      const base = {
        sha256: SHA64local,
        kind: 'evidence-bundle',
        bytesSha256: SHA64local,
        bundle: { taskId: `task-${i}`, attemptId: `att-${i}`, baseSha: '0'.repeat(40), resultSha: resultOf(i) },
      };
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
    // What the forge reports for the PR right now.
    async resolveLivePullRequest(trace: Record<string, unknown>, _q: Record<string, unknown>) {
      const i = idxOf(trace.taskId as string);
      const base = {
        number: i + 1,
        url: `https://github.com/acme/repo/pull/${i + 1}`,
        headBranch: `asep/${trace.taskId}`,
        headSha: resultOf(i),
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

async function rejectsWith(authority: ReturnType<typeof genuineAuthority>, pattern: RegExp) {
  const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), authority);
  assert.equal(res.ok, false, `expected a rejection matching ${pattern}`);
  assert.ok(res.reasons.some((r: string) => pattern.test(r)), `${pattern} not among: ${res.reasons.join('; ')}`);
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
  for (const drop of ['pinnedAgent', 'resolveAgentRun'] as const) {
    const { [drop]: _gone, ...partial } = genuineAuthority();
    const res = await verifyManifestAgainstAuthority(makeManifest(MIN_PILOT_TASKS), partial);
    assert.equal(res.ok, false);
    assert.ok(res.reasons.some((r: string) => new RegExp(`lacks ${drop}`).test(r)), res.reasons.join('; '));
  }
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
  reviewerPublicKeyPem: REVIEWER_PUB, objects: NO_OBJECTS, forge: NO_FORGE, agent: PINS, ...over,
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

  assert.equal(db.calls.length, 5);
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
  assert.throws(() => createSqlAuthorityResolver(db, resolverOpts({ agent: { ...PINS, modelBaseUrl: 'ftp://x' } })), /http\(s\)/);
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
  assert.deepEqual(run.invocation[0].manifest, {
    providerId: REAL_ID, model: PINS.model, cliVersion: PINS.cliVersion,
    image: PINS.agentImage, proxyImage: PINS.proxyImage, upstream: PINS.modelBaseUrl,
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

test('the resolver fetches the evidence bytes, re-hashes them and parses the bundle they hold', async () => {
  const bundle = { taskId: 'task-1', attemptId: 'att-1', baseSha: '0'.repeat(40), resultSha: 'b'.repeat(40), checks: [] };
  const bytes = Buffer.from(JSON.stringify(bundle));
  const asked: string[] = [];
  const objects = { get: async (key: string) => { asked.push(key); return new Uint8Array(bytes); } };
  const resolver = createSqlAuthorityResolver(fakeDb(() => [evidenceRow(bytes)]), resolverOpts({ objects }));
  const ev = await resolver.resolveEvidence({ organizationId: 'org-1', projectId: 'proj-1' }, 'ev-1');
  assert.deepEqual(asked, ['org-1/proj-1/evidence/ev-1'], 'the bytes come from the storage key the row records');
  assert.equal(ev.bytesSha256, ev.sha256);
  assert.deepEqual(ev.bundle, { taskId: 'task-1', attemptId: 'att-1', baseSha: '0'.repeat(40), resultSha: 'b'.repeat(40) });
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
      return { number: 4, url: 'https://github.com/acme/web/pull/4', headBranch: 'asep/x', baseBranch: 'main', headSha: 'c'.repeat(40) };
    },
  };
  const resolver = createSqlAuthorityResolver(fakeDb(() => []), resolverOpts({ forge }));
  const live = await resolver.resolveLivePullRequest(
    { organizationId: 'org-1', projectId: 'proj-1', attemptId: 'att-1' },
    { repositoryBindingId: 'rb-1', headBranch: 'asep/x' },
  );
  assert.deepEqual(calls, [[{ organizationId: 'org-1', projectId: 'proj-1' }, { repositoryBindingId: 'rb-1', headBranch: 'asep/x' }]]);
  assert.deepEqual(live, { number: 4, url: 'https://github.com/acme/web/pull/4', headBranch: 'asep/x', headSha: 'c'.repeat(40) });

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
          return { data: [{ number: 3, html_url: 'https://github.com/acme/web/pull/3', head: { ref: 'asep/x', sha: 'c'.repeat(40) }, base: { ref: 'main' } }] };
        },
        create: async () => { throw new Error('a lookup must not create'); },
        update: async () => { throw new Error('a lookup must not update'); },
      },
    }),
  });
  const pr = await forge.findPullRequest({ organizationId: 'org-1', projectId: 'proj-1' }, { repositoryBindingId: 'rb-1', headBranch: 'asep/x' });
  assert.deepEqual(pr, {
    number: 3, url: 'https://github.com/acme/web/pull/3', headBranch: 'asep/x', baseBranch: 'main', headSha: 'c'.repeat(40),
  });
  assert.deepEqual(listed, [{ owner: 'acme', repo: 'web', head: 'acme:asep/x', state: 'all' }]);
  assert.deepEqual([...db.calls[0]!.params].sort(), ['org-1', 'proj-1', 'rb-1'], 'the binding is read in the trace scope');
  await assert.rejects(
    () => forge.pushBranch({ organizationId: 'org-1', projectId: 'proj-1' }, { repositoryBindingId: 'rb-1', branch: 'asep/x', commitSha: 'c'.repeat(40) }),
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
  });
  try {
    for (const m of [
      'resolveAttempt', 'resolveEvidence', 'resolvePullRequest', 'resolveLivePullRequest', 'resolveHumanAuthorization',
      'pinnedAgent', 'resolveAgentRun',
    ]) {
      assert.equal(typeof handle.resolver[m], 'function', m);
    }
    // No base URL set: the public API, as for the pilot.
    assert.deepEqual({ ...handle.resolver.pinnedAgent() }, PINS);
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
});
