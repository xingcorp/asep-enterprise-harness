// Pilot-manifest verifier suite (exit criteria K5/K6).
//
// Proves the verifier is genuinely adversarial: a valid ten-task manifest is
// accepted, and every falsification mode (short count, duplicate task, replayed
// work order, reused session, fake adapter, no-op change, broken trace, bad
// shapes) is rejected with a specific reason. Registered as a REQUIRED suite so
// it cannot be silently dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
// The verifier is plain ESM (.mjs); import its pure functions directly.
import {
  verifyManifest,
  MIN_PILOT_TASKS,
  // @ts-expect-error - .mjs sibling has no type declarations; runtime import is fine under tsx.
} from './verify-pilot-manifest.mjs';

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
