// Publication under a stale owner, through the publication activities on
// the vertical slice's publication ports. The forge is not fenced: an owner stalled inside
// a forge call can still reach it after a takeover. These interleavings show
// what holds instead, with the stale owner's call held inside the transport:
//
//   - the in-transport pull-request race: owner 1 reads the PR, owner 2 updates
//     it, owner 1 updates it — the PR ends byte-identical to owner 2's, because
//     both write pullRequestContent of the attempt's facts;
//   - a stale owner's push of a different commit is refused by the push's
//     compare-and-set and leaves the branch at the attempt's commit;
//   - a stale owner's late push of the same commit is a no-op;
//   - a PR whose title or body diverges from the facts is rewritten by
//     reconcilePublication, which reports contentRepaired on it; the activity
//     never creates, retargets, closes or merges a PR and never moves the branch.
//
// And the publication effect every result and failure carries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSURANCE_NOT_SATISFIED, pullRequestContent, type SandboxHandle, type SandboxProvider } from '@asep/ports';
import { pullRequestFactsOf, pushStep } from '../pipeline-steps.js';
import { PublicationActivityError } from './publication-activities.js';
import type { LeasedAttemptIdentity } from './identity.js';
import {
  IDS, REPOSITORY, SCOPE, TASK_BASE, createHarness, sha256, type Harness,
} from './activity-harness.test-support.js';

console.log('SUITE-ID: asep-suite:orchestration-activities');

const BUDGET = { maxTurns: 10, maxToolCalls: 50, maxCostUsd: 2, maxWallClockMinutes: 30 };
const CHECKS = [{ id: 'L0-workspace', level: 'L0' as const, category: 'workspace' as const, mandatory: true, commandId: 'cmd-l0' },
  { id: 'L1-static', level: 'L1' as const, category: 'static' as const, mandatory: true, commandId: 'cmd-l1' }];
const BASE_BRANCH = 'release/2026.10';

// A sandbox that enforces OS isolation, the shape verification requires of its handle.
const sandbox: SandboxProvider = {
  async start(profile): Promise<SandboxHandle> {
    return { sandboxId: 'sbx-1', profile, isolationEnforced: true };
  },
  async stop(): Promise<void> {},
};

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await createHarness({ sandbox });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

/** An attempt with its verified commit and evidence, ready to publish. */
async function committed(h: Harness): Promise<{ readonly attempt: LeasedAttemptIdentity; readonly resultSha: string; readonly evidenceId: string }> {
  const a = h.activities;
  const attempt = await h.leasedAttempt(1);
  const ctx = h.ctx();
  await a.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, ctx);
  await a.storeAttemptInputs({ ...attempt, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx);
  await a.runAgent({ ...attempt, workOrderRef: h.workOrderRef, budget: BUDGET }, ctx);
  await a.runVerification({ ...attempt, planId: 'plan-R0', checks: CHECKS }, ctx);
  const { resultSha } = await a.commitAttempt({ ...attempt, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef }, ctx);
  const { evidenceId } = await a.persistEvidence({ ...attempt, baseSha: TASK_BASE }, ctx);
  return { attempt, resultSha, evidenceId };
}

/** The successor: the stale owner's lease lapses, and a newer lease of the same branch takes the attempt over. */
async function takeOver(h: Harness, attempt: LeasedAttemptIdentity): Promise<LeasedAttemptIdentity> {
  await h.db.query(`update workspace_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [attempt.fence.leaseId]);
  const next = await h.leases.acquire(SCOPE, { repositoryBindingId: IDS.bindingId, branch: attempt.branch, attemptId: attempt.attemptId, ttlMs: 60_000 });
  assert.ok(!('denied' in next));
  return { ...attempt, fence: { leaseId: next.leaseId, fencingEpoch: next.fencingEpoch } };
}

/** Holds the next call of `call` inside the transport; resolves once it is held, with the release. */
function holdInTransport(h: Harness, call: 'pushBranch' | 'upsertPullRequest'): { readonly held: Promise<void>; release(): void } {
  let reached!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { reached = resolve; });
  h.forge.pause = { call, reached, release: new Promise<void>((resolve) => { release = resolve; }) };
  return { held, release: () => release() };
}

const upsertInput = (attempt: LeasedAttemptIdentity, extra: Partial<{ flagged: boolean; prBodySectionRef: null }> = {}) => ({
  ...attempt, repository: REPOSITORY, baseBranch: BASE_BRANCH, flagged: false, prBodySectionRef: null, ...extra,
});

test('the in-transport PR race: owner 1 reads, owner 2 updates, owner 1 updates; the PR ends byte-identical to owner 2\'s', async () => {
  await withHarness(async (h) => {
    const { attempt, resultSha, evidenceId } = await committed(h);
    await h.activities.publishBranch(attempt, h.ctx());
    // A PR is already open for the attempt branch, with content that is not the facts'.
    h.forge.prs.push({
      number: 1, headBranch: attempt.branch, baseBranch: BASE_BRANCH, title: 'opened by hand', body: 'edited by someone',
      state: 'open', merged: false, headRepository: REPOSITORY, baseRepository: REPOSITORY,
    });
    // Owner 1 confirms its record, reads the PR inside the transport, and stalls before its write.
    const hold = holdInTransport(h, 'upsertPullRequest');
    const owner1 = h.activities.upsertPullRequest(upsertInput(attempt), h.ctx()).then((r) => r, (err: unknown) => err);
    await hold.held;
    // Owner 2 takes the record over, finds the PR by its head, and makes its title and body the facts'.
    const successor = await takeOver(h, attempt);
    const owner2 = await h.activities.upsertPullRequest(upsertInput(successor), h.ctx());
    const afterOwner2 = { title: h.forge.prs[0]!.title, body: h.forge.prs[0]!.body };
    assert.ok([...h.audit.rows.values()].some((e) => e.action === 'side-effect.takeover'), 'the takeover is audited');
    hold.release();
    const late = await owner1;
    const expected = pullRequestContent(pullRequestFactsOf({
      taskId: IDS.taskId, attemptId: attempt.attemptId, commitSha: resultSha, evidenceId, base: BASE_BRANCH,
      assurance: { flagged: false, section: null },
    }));
    assert.deepEqual(afterOwner2, expected, 'owner 2 wrote the facts\' content');
    assert.deepEqual({ title: h.forge.prs[0]!.title, body: h.forge.prs[0]!.body }, afterOwner2, 'owner 1\'s late write changed nothing');
    assert.deepEqual(h.forge.writes.filter((w) => !w.startsWith('push')), ['content #1', 'update #1'], 'owner 2 repaired by number, then owner 1 wrote the same');
    assert.equal(h.forge.prs.length, 1, 'one pull request');
    assert.equal(owner2.prNumber, 1);
    assert.ok(late instanceof PublicationActivityError && late.effect === 'unknown', 'the stale owner cannot complete the record');
  });
});

test('a stale owner\'s push of a different commit is refused and leaves the branch at the attempt\'s commit', async () => {
  await withHarness(async (h) => {
    const { attempt, resultSha } = await committed(h);
    await h.activities.publishBranch(attempt, h.ctx());
    const other = 'f'.repeat(40);
    // A stale owner holding another commit pushes with the same compare-and-set (the branch must be absent).
    await assert.rejects(h.forge.pushBranch(SCOPE, { branch: attempt.branch, commitSha: other, expectedRemoteSha: null }), /push refused/);
    assert.equal(h.forge.branches.get(attempt.branch), resultSha);
    // Through the push step, under the stale owner's dead lease, it is refused before the forge.
    const stale = attempt;
    await takeOver(h, attempt);
    await assert.rejects(pushStep({
      forge: h.forge, log: h.sideEffects, scope: SCOPE, repositoryBindingId: IDS.bindingId, attemptId: stale.attemptId,
      branch: stale.branch, commitSha: other, leaseId: stale.fence.leaseId,
    }));
    assert.equal(h.forge.branches.get(attempt.branch), resultSha, 'the branch never moved');
    assert.equal(h.forge.writes.filter((w) => w.startsWith('push')).length, 1);
  });
});

test('a stale owner\'s late push of the same commit is a no-op', async () => {
  await withHarness(async (h) => {
    const { attempt, resultSha } = await committed(h);
    // Owner 1 confirms ownership and stalls inside the push.
    const hold = holdInTransport(h, 'pushBranch');
    const owner1 = h.activities.publishBranch(attempt, h.ctx()).then((r) => r, (err: unknown) => err);
    await hold.held;
    // Owner 2 takes the record over: reconciles the branch (absent), and pushes the attempt's commit.
    const successor = await takeOver(h, attempt);
    assert.deepEqual(await h.activities.publishBranch(successor, h.ctx()), { effect: 'applied' });
    hold.release();
    const late = await owner1;
    // The late push finds the branch at the same commit: nothing changes. Owner 1 cannot complete the record.
    assert.equal(h.forge.branches.get(attempt.branch), resultSha);
    assert.deepEqual(h.forge.writes.filter((w) => w.startsWith('push')), [`push ${attempt.branch}@${resultSha}`], 'one write');
    assert.ok(late instanceof PublicationActivityError && late.effect === 'unknown', 'the stale owner reports the effect unknown');
  });
});

test('reconcilePublication rewrites a diverged title and body by the recorded PR, reports it, and writes nothing else', async () => {
  await withHarness(async (h) => {
    const { attempt, resultSha } = await committed(h);
    await h.activities.publishBranch(attempt, h.ctx());
    const { prNumber } = await h.activities.upsertPullRequest(upsertInput(attempt), h.ctx());
    const content = { title: h.forge.prs[0]!.title, body: h.forge.prs[0]!.body };
    h.forge.prs[0]!.title = 'renamed by hand';
    // Another PR with the same head, from a fork: observed, never written.
    h.forge.prs.push({
      number: 2, headBranch: attempt.branch, baseBranch: 'main', title: 'fork', body: 'fork', state: 'closed', merged: false,
      headRepository: { id: 99, owner: 'fork', name: 'web' }, baseRepository: REPOSITORY,
    });
    h.forge.writes.length = 0;
    const input = { ...attempt, repository: REPOSITORY, remoteBranch: attempt.branch, expectedHeadSha: resultSha, expectedBaseBranch: BASE_BRANCH };
    const observed = await h.activities.reconcilePublication(input, h.ctx());
    assert.deepEqual(observed.branch, { repository: REPOSITORY, headSha: resultSha });
    assert.deepEqual(observed.pullRequests.map((p) => [p.number, p.headRepository.id, p.baseBranch, p.state, p.merged, p.contentRepaired]),
      [[prNumber, REPOSITORY.id, BASE_BRANCH, 'open', false, true], [2, 99, 'main', 'closed', false, false]]);
    assert.deepEqual({ title: h.forge.prs[0]!.title, body: h.forge.prs[0]!.body }, content, 'the facts\' content again');
    assert.deepEqual(h.forge.writes, [`content #${prNumber}`], 'one write, by number; no create, retarget, close, merge or push');
    assert.deepEqual({ title: h.forge.prs[1]!.title, state: h.forge.prs[1]!.state }, { title: 'fork', state: 'closed' });

    // Read again: nothing diverges, nothing is written.
    h.forge.writes.length = 0;
    const again = await h.activities.reconcilePublication(input, h.ctx());
    assert.ok(again.pullRequests.every((p) => !p.contentRepaired));
    assert.deepEqual(h.forge.writes, []);
  });
});

test('reconcilePublication without a COMPLETED pr-upsert record writes nothing, whatever it observes', async () => {
  await withHarness(async (h) => {
    const { attempt, resultSha } = await committed(h);
    await h.activities.publishBranch(attempt, h.ctx());
    h.forge.prs.push({
      number: 1, headBranch: attempt.branch, baseBranch: BASE_BRANCH, title: 'x', body: 'y', state: 'open', merged: false,
      headRepository: REPOSITORY, baseRepository: REPOSITORY,
    });
    h.forge.writes.length = 0;
    const observed = await h.activities.reconcilePublication(
      { ...attempt, repository: REPOSITORY, remoteBranch: attempt.branch, expectedHeadSha: resultSha, expectedBaseBranch: BASE_BRANCH, fence: null }, h.ctx());
    assert.deepEqual(observed.pullRequests.map((p) => [p.number, p.contentRepaired]), [[1, false]]);
    assert.deepEqual(h.forge.writes, []);
    // A missing branch is observed as null.
    h.forge.branches.clear();
    assert.equal((await h.activities.reconcilePublication(
      { ...attempt, repository: REPOSITORY, remoteBranch: attempt.branch, expectedHeadSha: resultSha, expectedBaseBranch: BASE_BRANCH, fence: null }, h.ctx())).branch, null);
  });
});

test('the publication effect: applied on success, none only before this delivery\'s forge call on its own record, unknown otherwise', async () => {
  // Before any record: a missing prerequisite is none.
  await withHarness(async (h) => {
    const attempt = await h.leasedAttempt(1);
    const failure = await h.activities.publishBranch(attempt, h.ctx()).then(() => null, (err: unknown) => err);
    assert.ok(failure instanceof PublicationActivityError && failure.effect === 'none', 'no commit, nothing begun');
  });
  // A failure inside the forge call: unknown, also when the forge refused before writing.
  await withHarness(async (h) => {
    const { attempt } = await committed(h);
    h.forge.failNext = { call: 'pushBranch', error: new Error('502 bad gateway'), afterWrite: false };
    const failure = await h.activities.publishBranch(attempt, h.ctx()).then(() => null, (err: unknown) => err);
    assert.ok(failure instanceof PublicationActivityError && failure.effect === 'unknown');
    assert.equal(failure.operation, 'push');
  });
  // A record begun by an earlier delivery, and a failure before this delivery's call: unknown.
  await withHarness(async (h) => {
    const { attempt } = await committed(h);
    h.forge.failNext = { call: 'pushBranch', error: new Error('timeout'), afterWrite: false };
    await h.activities.publishBranch(attempt, h.ctx()).catch(() => undefined);
    await h.leases.release(SCOPE, attempt.fence.leaseId);
    const failure = await h.activities.publishBranch(attempt, h.ctx()).then(() => null, (err: unknown) => err);
    assert.ok(failure instanceof PublicationActivityError && failure.effect === 'unknown', 'the earlier delivery may have pushed');
  });
  // The upsert answered with a PR that is not the attempt's reviewable publication: applied, for the workflow to reconcile.
  await withHarness(async (h) => {
    const { attempt } = await committed(h);
    await h.activities.publishBranch(attempt, h.ctx());
    h.forge.prs.push({
      number: 1, headBranch: attempt.branch, baseBranch: BASE_BRANCH, title: 't', body: 'b', state: 'closed', merged: false,
      headRepository: REPOSITORY, baseRepository: REPOSITORY,
    });
    const failure = await h.activities.upsertPullRequest(upsertInput(attempt), h.ctx()).then(() => null, (err: unknown) => err);
    assert.ok(failure instanceof PublicationActivityError && failure.effect === 'applied');
    assert.match(String((failure.cause as Error).message), /closed/);
    assert.equal(h.forge.prs.length, 1, 'never reopened or duplicated');
  });
});

test('the assurance facts are part of the PR content: a flagged PR and its section, the same on every write', async () => {
  await withHarness(async (h) => {
    const { attempt, resultSha, evidenceId } = await committed(h);
    await h.activities.publishBranch(attempt, h.ctx());
    const sectionText = '## Independent assurance\n\nEscalated: the reviewer found a blocking issue.';
    const bytes = new TextEncoder().encode(sectionText);
    const sectionRef = await h.artifacts.put(SCOPE, { kind: 'pr-body-section', content: bytes, sha256: sha256(bytes), contentType: 'text/markdown' });
    const input = { ...attempt, repository: REPOSITORY, baseBranch: BASE_BRANCH, flagged: true, prBodySectionRef: sectionRef };
    await h.activities.upsertPullRequest(input, h.ctx());
    const pr = h.forge.prs[0]!;
    assert.ok(pr.title.endsWith(`(${ASSURANCE_NOT_SATISFIED})`));
    assert.ok(pr.body.includes(sectionText));
    assert.deepEqual({ title: pr.title, body: pr.body }, pullRequestContent(pullRequestFactsOf({
      taskId: IDS.taskId, attemptId: attempt.attemptId, commitSha: resultSha, evidenceId, base: BASE_BRANCH,
      assurance: { flagged: true, section: sectionText },
    })));
    // A redelivery presenting other assurance facts still writes the first recorded ones.
    await h.activities.upsertPullRequest({ ...input, flagged: false, prBodySectionRef: null }, h.ctx());
    assert.ok(h.forge.prs[0]!.body.includes(sectionText));
  });
});

test('without assurance facts the PR content is byte-identical to the content without them', () => {
  const facts = { taskId: 'task-1', attemptId: 'attempt-1', commitSha: 'a'.repeat(40), evidenceId: 'ev-1', base: 'main' };
  const phase2 = {
    title: 'ASEP task-1: attempt attempt-1',
    body: 'Automated ASEP attempt, waiting for human review.\n\nTask: task-1\nAttempt: attempt-1\n'
      + `Commit: ${'a'.repeat(40)}\nEvidence: ev-1\nBase: main\n`,
  };
  assert.deepEqual(pullRequestContent(facts), phase2);
  assert.deepEqual(pullRequestContent({ ...facts, flagged: false, assuranceSection: null }), phase2);
  assert.notDeepEqual(pullRequestContent({ ...facts, flagged: true }), phase2);
  assert.notDeepEqual(pullRequestContent({ ...facts, assuranceSection: 'x' }), phase2);
});
