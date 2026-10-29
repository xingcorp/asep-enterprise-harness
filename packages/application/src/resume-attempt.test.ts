// resumeAttemptToReview — risk admission on the resume path (exit criteria
// BR1/BR2/I4).
//
// A resume takes a lease, pushes and opens a pull request just as a fresh run
// does, so it must be gated the same way: the task's risk, read from the
// authoritative task row (never from the caller), is admitted BEFORE the lease
// and before any publication. Every port here is a recording fake, so the test
// can assert that a deferred risk reached nothing past the task read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  TenantScope, AttemptId, ArtifactId, OrganizationId, ProjectId, RepositoryBindingId,
  RunId, TaskId, TaskStatus, RiskLevel, EvidenceBundle,
} from '@asep/contracts';
import type {
  EvidenceStore, ForgeProvider, Lease, PullRequestRef, SideEffectLog, SideEffectRecord, WorkspaceLeaseRepository,
} from '@asep/ports';
import { pullRequestContent } from '@asep/ports';
import { resumeAttemptToReview, type ResumeAttemptInput } from './resume-attempt.js';

console.log('SUITE-ID: asep-suite:resume-attempt');

const scope: TenantScope = { organizationId: 'org-1' as OrganizationId, projectId: 'proj-1' as ProjectId };
const repositoryBindingId = 'bind-1' as RepositoryBindingId;
const taskId = 'task-1' as TaskId;
const attemptId = 'attempt-1' as AttemptId;
const baseSha = 'a'.repeat(40);
const commitSha = 'c'.repeat(40);
const evidenceId = 'E'.repeat(26) as ArtifactId;
const branch = 'asep/attempt-1';

const bundle: EvidenceBundle = {
  taskId, attemptId, baseSha, resultSha: commitSha, createdAt: '2026-10-29T00:00:00.000Z',
  environment: { imageDigest: `sha256:${'e'.repeat(64)}`, lockfileHash: 'f'.repeat(64), nodeVersion: 'v24.6.0' },
  diff: { artifactId: 'D'.repeat(26) as ArtifactId, sha256: 'd'.repeat(64) },
  checks: [],
} as unknown as EvidenceBundle;

// A world in which a resume would succeed: the commit and its evidence are
// durable, the forge accepts everything. Each port call is recorded in `calls`.
// `commitState` is the commit record as the dead executor left it; `landed` is
// whether its commit is recorded under the attempt. `remote` is the forge's
// branch and PR, which the forge double keeps as a forge would: a push is
// compare-and-set, an upsert writes what it is given.
interface Remote { ref: string | null; pr: PullRequestRef | null; afterUpsert?: (() => void) | undefined }
function world(
  risk: RiskLevel, calls: string[],
  commitState: 'COMPLETED' | 'PENDING' | 'FAILED' | 'absent' = 'COMPLETED', landed = true,
  remote: Remote = { ref: null, pr: null },
): ResumeAttemptInput {
  const lease: Lease = {
    leaseId: 'lease-2', repositoryBindingId, branch, attemptId,
    expiresAt: '2099-01-01T00:00:00.000Z', fencingEpoch: 2,
  };
  const leases: WorkspaceLeaseRepository = {
    acquire: async () => { calls.push('lease.acquire'); return lease; },
    release: async () => { calls.push('lease.release'); },
    heartbeat: async () => { calls.push('lease.heartbeat'); },
  } as unknown as WorkspaceLeaseRepository;
  const record = (operation: SideEffectRecord['operation'], existed: boolean): SideEffectRecord => ({
    operation, state: 'PENDING', requestFingerprint: 'fp', existed,
  });
  let commitRecord: SideEffectRecord | null = commitState === 'absent' ? null
    : commitState === 'COMPLETED'
      ? { operation: 'commit', state: 'COMPLETED', requestFingerprint: 'fp', existed: true,
        resultRef: { kind: 'commit', commitSha, evidenceId } }
      : { ...record('commit', true), state: commitState };
  const sideEffects: SideEffectLog = {
    find: async (_s, key) => {
      calls.push(`log.find:${key.operation}`);
      return key.operation === 'commit' ? commitRecord : null;
    },
    begin: async (_s, i) => {
      calls.push(`log.begin:${i.operation}`);
      if (i.operation === 'commit' && commitRecord) return { ...commitRecord, existed: true, takenOver: true };
      return record(i.operation, false);
    },
    complete: async (_s, i) => {
      calls.push(`log.complete:${i.operation}`);
      const done: SideEffectRecord = { ...record(i.operation, true), state: 'COMPLETED', resultRef: i.resultRef };
      if (i.operation === 'commit') commitRecord = done;
      return done;
    },
    fail: async (_s, i) => { calls.push(`log.fail:${i.operation}`); return record(i.operation, true); },
    confirmOwner: async (_s, i) => { calls.push(`log.confirm:${i.operation}`); return { fencingEpoch: 2 }; },
  };
  const evidence: EvidenceStore = {
    reserveEvidence: async () => { throw new Error('a resume never reserves evidence'); },
    getReservation: async () => { throw new Error('the evidence is stored; its reservation is not read'); },
    putEvidence: async () => { throw new Error('a resume never writes evidence it did not find'); },
    getEvidence: async () => { calls.push('evidence.get'); return bundle; },
  };
  const forge: ForgeProvider = {
    pushBranch: async (_s, i) => {
      calls.push('forge.push');
      if (remote.ref !== i.expectedRemoteSha && remote.ref !== i.commitSha) throw new Error('stale lease');
      remote.ref = i.commitSha;
    },
    upsertPullRequest: async (_s, i) => {
      calls.push('forge.pr');
      remote.pr = {
        number: 7, url: 'https://example.invalid/pr/7', headBranch: i.headBranch, baseBranch: i.base,
        title: i.title, body: i.body,
      };
      const written = remote.pr;
      remote.afterUpsert?.();
      return written;
    },
    resolveRef: async () => { calls.push('forge.resolve'); return remote.ref; },
    findPullRequest: async () => { calls.push('forge.find'); return remote.pr; },
  };
  let status: TaskStatus = 'VERIFYING';
  return {
    scope, repositoryBindingId, runId: 'run-1' as RunId, taskId, attemptId, baseSha, branch,
    base: 'main', leaseTtlMs: 60_000,
    leases, sideEffects, evidence, forge,
    committer: {
      reconcile: async () => { calls.push('git.reconcile'); return landed ? { commitSha, evidenceId } : null; },
    },
    repositories: {
      attempts: {
        getScoped: async () => { calls.push('attempt.get'); return { version: 1, resultSha: null, evidenceArtifactId: null }; },
        setResultSha: async () => { calls.push('attempt.setResultSha'); return 2; },
        attachEvidence: async () => { calls.push('attempt.attachEvidence'); return 3; },
      },
      tasks: {
        getScoped: async () => { calls.push('task.get'); return { version: 1, status, risk }; },
        updateStatus: async (_s, _id, _v, to) => { calls.push(`task.status:${to}`); status = to; return 2; },
      },
      pullRequests: { upsert: async () => { calls.push('pr.persist'); return undefined; } },
    },
  };
}

for (const risk of ['R2', 'R3', 'R4'] as const) {
  test(`a resume of a ${risk} task stops at admission: no lease, no push, no PR, no transition`, async () => {
    const calls: string[] = [];
    const r = await resumeAttemptToReview(world(risk, calls));
    assert.equal(r.stoppedAt, 'admission');
    assert.match(r.reason ?? '', new RegExp(risk));
    assert.deepEqual(calls, ['task.get'], 'only the authoritative task row was read');
  });
}

for (const risk of ['R0', 'R1'] as const) {
  test(`a resume of an admitted ${risk} task runs admission first, then leases and publishes`, async () => {
    const calls: string[] = [];
    const r = await resumeAttemptToReview(world(risk, calls));
    assert.equal(r.stoppedAt, 'complete');
    assert.equal(calls[0], 'task.get', 'the risk is read before anything else');
    assert.ok(calls.indexOf('lease.acquire') > 0, 'the lease comes after admission');
    assert.ok(calls.includes('forge.push') && calls.includes('forge.pr'));
    assert.equal(r.requiresHumanIndependentReview, risk === 'R1');
  });
}

test('a resume of an executor that died after its commit but before recording it completes the record and publishes', async () => {
  const calls: string[] = [];
  const r = await resumeAttemptToReview(world('R0', calls, 'PENDING', true));
  assert.equal(r.stoppedAt, 'complete', r.reason);
  assert.equal(r.commitSha, commitSha, 'the recorded commit, not a new one');
  const at = (c: string) => calls.indexOf(c);
  assert.ok(at('lease.acquire') < at('log.begin:commit'), 'the record is taken over under the new lease');
  assert.ok(at('log.begin:commit') < at('git.reconcile'));
  assert.ok(at('git.reconcile') < at('log.complete:commit'), 'completed with what reconcile found');
  assert.ok(at('log.complete:commit') < at('forge.push'), 'nothing is published before the commit is recorded');
});

test('a resume whose begun commit never landed publishes nothing and asks for re-execution', async () => {
  const calls: string[] = [];
  const r = await resumeAttemptToReview(world('R0', calls, 'PENDING', false));
  assert.equal(r.stoppedAt, 'not-resumable');
  assert.match(r.reason ?? '', /never landed/);
  assert.ok(!calls.some((c) => c.startsWith('forge.') || c === 'log.complete:commit'));
});

for (const state of ['absent', 'FAILED'] as const) {
  test(`a resume whose commit record is ${state} touches no commit and publishes nothing`, async () => {
    const calls: string[] = [];
    const r = await resumeAttemptToReview(world('R0', calls, state));
    assert.equal(r.stoppedAt, 'not-resumable');
    assert.ok(!calls.some((c) => c.startsWith('forge.') || c.startsWith('log.begin') || c === 'git.reconcile'));
  });
}

// A stale owner may reach the forge after the takeover. Whatever it left, the
// resume ends with the branch and the PR the attempt's facts say, every repair
// on record, before the task reaches its terminal state.

const facts = { taskId, attemptId, commitSha, evidenceId, base: 'main' };

function audited(): { actions: { action: string; detail: unknown }[]; input: Pick<ResumeAttemptInput, 'audit' | 'actor'> } {
  const actions: { action: string; detail: unknown }[] = [];
  return {
    actions,
    input: { actor: 'resume-test', audit: { record: async (e) => { actions.push({ action: e.action, detail: e.detail }); } } },
  };
}

test('a resume puts an attempt branch holding another commit back on the attempt\'s commit, on record', async () => {
  const calls: string[] = [];
  const remote: Remote = { ref: 'e'.repeat(40), pr: null };
  const { actions, input } = audited();
  const r = await resumeAttemptToReview({ ...world('R0', calls, 'COMPLETED', true, remote), ...input });
  assert.equal(r.stoppedAt, 'complete', r.reason);
  assert.equal(r.branchRepaired, true);
  assert.equal(remote.ref, commitSha);
  const repairs = actions.filter((a) => a.action === 'forge.reconcile');
  assert.deepEqual(repairs.map((a) => a.detail), [
    { target: 'branch', branch, found: 'e'.repeat(40), commitSha },
  ]);
  assert.ok(calls.indexOf('task.status:WAITING_FOR_HUMAN_REVIEW') > calls.lastIndexOf('forge.resolve'),
    'the branch is reconciled before the terminal state');
});

test('a resume rewrites a PR a late writer changed after its upsert, on record, before the terminal state', async () => {
  const calls: string[] = [];
  const remote: Remote = { ref: null, pr: null };
  remote.afterUpsert = () => {
    remote.afterUpsert = undefined;
    remote.pr = { ...remote.pr!, title: 'a stale owner\'s title', body: 'a stale owner\'s body' };
  };
  const { actions, input } = audited();
  const r = await resumeAttemptToReview({ ...world('R0', calls, 'COMPLETED', true, remote), ...input });
  assert.equal(r.stoppedAt, 'complete', r.reason);
  assert.equal(r.prRepaired, true);
  const content = pullRequestContent(facts);
  assert.equal(remote.pr?.title, content.title);
  assert.equal(remote.pr?.body, content.body);
  assert.equal(actions.filter((a) => a.action === 'forge.reconcile').length, 1);
  assert.ok(calls.indexOf('task.status:WAITING_FOR_HUMAN_REVIEW') > calls.lastIndexOf('forge.pr'),
    'the PR is repaired before the terminal state');
});

test('a resume over a remote that already is the facts\' repairs nothing', async () => {
  const calls: string[] = [];
  const content = pullRequestContent(facts);
  const remote: Remote = {
    ref: commitSha,
    pr: { number: 7, url: 'https://example.invalid/pr/7', headBranch: branch, baseBranch: 'main', ...content },
  };
  const { actions, input } = audited();
  const r = await resumeAttemptToReview({ ...world('R0', calls, 'COMPLETED', true, remote), ...input });
  assert.equal(r.stoppedAt, 'complete', r.reason);
  assert.equal(r.branchRepaired, false);
  assert.equal(r.prRepaired, false);
  assert.equal(actions.filter((a) => a.action === 'forge.reconcile').length, 0);
});
