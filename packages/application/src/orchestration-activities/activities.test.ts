// The orchestration activities, each over ActivityExecutionContext, on the
// accepted pipeline primitives (a real database through PGlite).
//
//   - every activity, invoked twice with the same input, converges to one durable
//     outcome, also after a failure injected between its internal writes;
//   - the lookups that settle a failed registration and a failed or aborted lease
//     acquisition, and the pre-lease write with its lease-granted refusal mapped
//     to a result;
//   - the attempt terminal presents the caller's fence and must precede the
//     lease's release;
//   - evidence bytes are the same on every retry, timed by the workflow;
//   - each side-effect activity checks its abort signal and its fence
//     immediately before its external call (spy ordering);
//   - the FAILED lifecycle of a side-effect record, against the primitive;
//   - the admission hook, the context adapter, the default slot's binding, the
//     check-id catalog, the activity span and the audit vocabulary;
//   - the repair start is reported once across retries, by the slot alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactId, RiskLevel, RunEvent } from '@asep/contracts';
import {
  LeaseLostError, UnknownVerificationCommandError, type ActivityProgress, type SandboxHandle, type SandboxProvider, type SideEffectLog,
} from '@asep/ports';
import { ORCHESTRATION_AUDIT_ACTIONS } from '@asep/observability';
import { admitRisk, type AdmissionResult } from '../risk-admission.js';
import { governedExecution } from '../governed-execution.js';
import {
  AssuranceFencedError,
  ReviewLoopContractError,
  type ReviewLoopSlot,
} from '../review-loop/slot.js';
import { AssuranceUnavailableError, NotConfiguredAssuranceSlot } from './not-configured-slot.js';
import { ActivityCancelledError, assuranceStepContext } from './context.js';
import { AgentRedeliveryError, OrchestrationContractError, type LeasedAttemptIdentity } from './identity.js';
import { AttemptIdentityConflictError } from './ports.js';
import { PublicationActivityError } from './publication-activities.js';
import { workflowRunEvent } from './bookkeeping-activities.js';
import { createOrchestrationActivities } from './activities.js';
import {
  IDS, LOGICAL_NOW, REPOSITORY, SCOPE, TASK, TASK_BASE, WORKFLOW_ID, createHarness, sha256, type Harness, type HarnessOptions,
} from './activity-harness.test-support.js';

console.log('SUITE-ID: asep-suite:orchestration-activities');

const HERE = dirname(fileURLToPath(import.meta.url));

// A sandbox that enforces OS isolation, the shape verification requires of its handle.
const sandbox: SandboxProvider = {
  async start(profile): Promise<SandboxHandle> {
    return { sandboxId: 'sbx-1', profile, isolationEnforced: true };
  },
  async stop(): Promise<void> {},
};

async function withHarness(fn: (h: Harness) => Promise<void>, options: Omit<HarnessOptions, 'sandbox'> = {}): Promise<void> {
  const h = await createHarness({ sandbox, ...options });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const count = (calls: readonly string[], name: string): number => calls.filter((c) => c === name).length;

/** The rows a read returns (a read without parameters reports no row count). */
async function rows(h: Harness, sql: string, params: readonly unknown[] = []): Promise<number> {
  return (await h.db.query(sql, params as never)).rows.length;
}

/** Runs an attempt from registration through its persisted evidence. */
async function throughEvidence(h: Harness, n = 1): Promise<{ readonly attempt: LeasedAttemptIdentity; readonly evidenceId: string; readonly resultSha: string }> {
  const a = h.activities;
  const attempt = await h.leasedAttempt(n);
  const ctx = h.ctx();
  await a.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, ctx);
  await a.storeAttemptInputs({ ...attempt, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx);
  await a.runAgent({ ...attempt, workOrderRef: h.workOrderRef, budget: BUDGET }, ctx);
  await a.inspectWorkspace(attempt, ctx);
  await a.runVerification({ ...attempt, planId: 'plan-R0', checks: CHECKS }, ctx);
  const { resultSha } = await a.commitAttempt({ ...attempt, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef }, ctx);
  const { evidenceId } = await a.persistEvidence({ ...attempt, baseSha: TASK_BASE }, ctx);
  return { attempt, evidenceId, resultSha };
}

const BUDGET = { maxTurns: 10, maxToolCalls: 50, maxCostUsd: 2, maxWallClockMinutes: 30 };
const CHECKS = [
  { id: 'L0-workspace', level: 'L0' as const, category: 'workspace' as const, mandatory: true, commandId: 'cmd-l0' },
  { id: 'L1-static', level: 'L1' as const, category: 'static' as const, mandatory: true, commandId: 'cmd-l1' },
];

async function twice<T>(fn: () => Promise<T>): Promise<T> {
  const first = await fn();
  const second = await fn();
  assert.deepEqual(second, first, 'a second delivery returns what the first did');
  return first;
}

// ---------------------------------------------------------------------------
// Every activity converges when invoked twice
// ---------------------------------------------------------------------------

test('double invoke: every activity, run twice with the same input, converges to one durable outcome', async () => {
  await withHarness(async (h) => {
    const a = h.activities;
    const ctx = h.ctx();
    assert.deepEqual(await twice(() => a.admitTask(TASK, ctx)), { admitted: true, reason: 'ADMITTED_AUTOMATED' });

    const ensure = { ...TASK, attemptNumber: 1, attemptKind: 'initial' as const, baseSha: TASK_BASE, parentAttemptNumber: null, repairOrderRef: null };
    const { attemptId, branch } = await twice(() => a.ensureAttempt(ensure, ctx));
    assert.equal(await rows(h, 'select 1 from attempts where task_id = $1', [IDS.taskId]), 1, 'one attempt row');
    const registered = { ...TASK, attemptNumber: 1, attemptId, branch };

    const { fence } = await twice(() => a.acquireLease(registered, ctx));
    assert.equal(await rows(h, 'select 1 from workspace_leases where attempt_id = $1', [attemptId]), 1, 'one lease');
    const attempt = { ...registered, fence };

    await twice(() => a.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, ctx));
    assert.equal(h.workspaces.records.size, 1, 'one workspace');
    await twice(() => a.storeAttemptInputs({ ...attempt, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx));
    const agent = await twice(() => a.runAgent({ ...attempt, workOrderRef: h.workOrderRef, budget: BUDGET }, ctx));
    assert.deepEqual(agent, { status: 'AGENT_DONE', reportedCostUsd: 0.25, reportedToolCalls: 7, wallClockMs: 1500, failureClass: null });
    assert.equal(count(h.calls, 'agent.execute'), 1, 'the agent ran once');
    assert.deepEqual(await twice(() => a.inspectWorkspace(attempt, ctx)), { overstep: false });
    assert.deepEqual(await twice(() => a.runVerification({ ...attempt, planId: 'plan-R0', checks: CHECKS }, ctx)), { verdict: 'PASS' });
    assert.equal(h.calls.filter((c) => c.startsWith('runner.run')).length, 2, 'each check ran once');
    const { resultSha } = await twice(() => a.commitAttempt({ ...attempt, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef }, ctx));
    assert.equal(count(h.calls, 'committer.commit'), 1, 'one harness commit');
    assert.equal(await rows(h, 'select 1 from evidence_reservations where attempt_id = $1', [attemptId]), 1, 'one evidence reservation');
    const { evidenceId } = await twice(() => a.persistEvidence({ ...attempt, baseSha: TASK_BASE }, ctx));
    assert.equal(await rows(h, `select 1 from artifacts where kind = 'evidence-bundle' and attempt_id = $1`, [attemptId]), 1, 'one bundle');

    const round = {
      ...attempt, round: 1, evidenceId, taskBaseSha: TASK_BASE, attemptBaseSha: TASK_BASE, declaredComplete: true,
      priorAdjudicationId: null, idempotencyKey: `${attemptId}:assurance:1`, budgetRemaining: { costMicroUsd: 1_000_000, wallClockMs: 60_000 },
      workOrderRef: h.workOrderRef,
    };
    const { outcome } = await twice(() => a.assuranceRound(round, ctx));
    assert.equal(outcome.kind, 'PROCEED');

    assert.deepEqual(await twice(() => a.publishBranch(attempt, ctx)), { effect: 'applied' });
    assert.deepEqual(h.forge.writes.filter((w) => w.startsWith('push')), [`push ${branch}@${resultSha}`], 'one push');
    const upsert = { ...attempt, repository: REPOSITORY, baseBranch: 'release/2026.10', flagged: false, prBodySectionRef: null };
    const { prNumber } = await twice(() => a.upsertPullRequest(upsert, ctx));
    assert.equal(h.forge.prs.length, 1, 'one pull request');
    const reconcile = { ...registered, repository: REPOSITORY, remoteBranch: branch, expectedHeadSha: resultSha, expectedBaseBranch: 'release/2026.10', fence };
    const observed = await twice(() => a.reconcilePublication(reconcile, ctx));
    assert.deepEqual(observed.pullRequests.map((p) => [p.number, p.baseBranch, p.contentRepaired]), [[prNumber, 'release/2026.10', false]]);

    const facts = { round: 1, declaredComplete: true, verificationVerdict: 'PASS' as const, adjudicationId: outcome.adjudicationId, failureClass: null };
    await twice(() => a.recordAttemptOutcome({ ...registered, ...facts, assuranceUnavailable: false, modelCostMicroUsd: 250_000, terminal: 'proceeded', fence }, ctx));
    assert.equal(await rows(h, 'select 1 from run_events where attempt_id = $1', [attemptId]), 2, 'the two terminal events, once');
    await twice(() => a.reapContainers(registered, ctx));
    await twice(() => a.cleanupWorkspace(registered, ctx));
    await twice(() => a.releaseLease(attempt, ctx));

    await twice(() => a.recordUsage({ ...registered, chargedCostUsd: 1.25, reportedCostUsd: 0.25, verificationReserveUsd: 1, chargedWallClockMinutes: 3 }, ctx));
    await twice(() => a.recordOverrun({ ...registered, overrunUsd: 0.000001, overrunToolCalls: 0, overrunWallClockMs: 0, usageOutOfBound: false }, ctx));
    await twice(() => a.recordExtension({ ...TASK, approvalRequestId: `${WORKFLOW_ID}:1`, extensionUsd: 1.5, principalId: 'human-1' }, ctx));
    assert.deepEqual([...h.ledger.entries.keys()], [`${attemptId}:attempt-usage`, `${attemptId}:overrun`, `${WORKFLOW_ID}:1:extension`]);
    assert.deepEqual(h.ledger.entries.get(`${attemptId}:attempt-usage`), {
      idempotencyKey: `${attemptId}:attempt-usage`, runId: IDS.runId, taskId: IDS.taskId, attemptId, entryKind: 'attempt-usage',
      source: 'provider-reported', amountMicroUsd: 1_250_000, toolCalls: 7, wallClockMs: 180_000, usageOutOfBound: false,
    });
    assert.equal(h.ledger.entries.get(`${attemptId}:overrun`)?.amountMicroUsd, 1, 'a sub-micro overrun is one micro-dollar');

    await twice(() => a.projectTaskState({ ...TASK, projectionSeq: 4, status: 'WAITING_FOR_HUMAN_REVIEW' }, ctx));
    assert.deepEqual(h.projection.tasks.get(IDS.taskId), { workflowId: WORKFLOW_ID, projectionSeq: 4, status: 'WAITING_FOR_HUMAN_REVIEW' });
    const approval = { ...TASK, approvalRequestId: `${WORKFLOW_ID}:2`, approvalKind: 'publish-change' as const, attemptId, ttlSeconds: 3600, shortfallUsd: null, requestedBy: 'human-0' };
    await twice(() => a.openApprovalRequest(approval, ctx));
    assert.equal(h.approvals.requests.get(`${WORKFLOW_ID}:2`)?.expiresAt, '2026-10-31T13:00:00.000Z', 'expiry from the workflow time');
    assert.deepEqual(await twice(() => a.verifyApprovalDecision({ ...TASK, approvalRequestId: `${WORKFLOW_ID}:2`, decisionId: 'd-1' }, ctx)),
      { verified: false, decision: null, extensionUsd: null });
    await twice(() => a.expireApprovalRequest({ ...TASK, approvalRequestId: `${WORKFLOW_ID}:2` }, ctx));
    await twice(() => a.cancelApprovalRequest({ ...TASK, approvalRequestId: `${WORKFLOW_ID}:2` }, ctx));
    assert.equal(h.approvals.requests.get(`${WORKFLOW_ID}:2`)?.status, 'EXPIRED', 'a closed request stays as it closed');

    await twice(() => a.recordControl({ ...TASK, requestId: 'req-1', control: 'pause', principalId: 'human-1' }, ctx));
    await twice(() => a.recordAudit({ ...TASK, attemptId, key: `${WORKFLOW_ID}:9`, action: 'publication.content-repaired', detail: { prNumber } }, ctx));
    await twice(() => a.emitRunEvent({ ...TASK, eventSeq: 1, eventType: 'task.started', attemptId: null, detail: { workflowId: WORKFLOW_ID } }, ctx));
    assert.equal(await rows(h, `select 1 from run_events where event_type in ('task.started', 'human.intervention')`), 2, 'each event once');
    assert.deepEqual([...h.audit.rows.keys()].sort(), [
      `${WORKFLOW_ID}:1:budget.extend`, `${WORKFLOW_ID}:2:approval.expire`, `${WORKFLOW_ID}:2:approval.request`,
      `${WORKFLOW_ID}:9`, `${WORKFLOW_ID}:control:req-1`,
    ].sort());
  });
});

test('crash variants: a delivery that fails between its internal writes is completed by the next, without a second effect', async () => {
  await withHarness(async (h) => {
    const a = h.activities;
    const ctx = h.ctx();
    // Registration: the row is inserted and the delivery fails before it returns.
    h.attempts.failNextEnsureAfterInsert = true;
    const ensure = { ...TASK, attemptNumber: 1, attemptKind: 'initial' as const, baseSha: TASK_BASE, parentAttemptNumber: null, repairOrderRef: null };
    await assert.rejects(a.ensureAttempt(ensure, ctx), /injected failure/);
    const { attemptId, branch } = await a.ensureAttempt(ensure, ctx);
    assert.equal(await rows(h, 'select 1 from attempts where task_id = $1', [IDS.taskId]), 1, 'one attempt row');
    await assert.rejects(a.ensureAttempt({ ...ensure, baseSha: 'c'.repeat(40) }, ctx), AttemptIdentityConflictError);

    // Lease: the grant commits and its answer is lost.
    const registered = { ...TASK, attemptNumber: 1, attemptId, branch };
    const acquire = h.deps.leases.acquire;
    const lostAnswer = { ...h.deps, leases: { ...h.deps.leases, acquire: async (...args: Parameters<typeof acquire>) => { await acquire(...args); throw new Error('answer lost'); } } };
    await assert.rejects(createOrchestrationActivities(lostAnswer).acquireLease(registered, ctx), /answer lost/);
    const { fence } = await a.acquireLease(registered, ctx);
    assert.equal(await rows(h, 'select 1 from workspace_leases where attempt_id = $1', [attemptId]), 1, 'the committed grant is the lease');
    const attempt = { ...registered, fence };

    await a.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, ctx);
    await a.storeAttemptInputs({ ...attempt, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx);
    await a.runAgent({ ...attempt, workOrderRef: h.workOrderRef, budget: BUDGET }, ctx);
    await a.runVerification({ ...attempt, planId: 'plan-R0', checks: CHECKS }, ctx);

    // Commit: the commit lands and the record's completion fails.
    const failComplete = (operation: string): SideEffectLog => ({
      ...h.sideEffects,
      complete: async (scope, input) => {
        if (input.operation === operation) throw new Error(`${operation} completion lost`);
        return h.sideEffects.complete(scope, input);
      },
    });
    const commitInput = { ...attempt, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef };
    await assert.rejects(createOrchestrationActivities({ ...h.deps, sideEffects: failComplete('commit') }).commitAttempt(commitInput, ctx), /completion lost/);
    const { resultSha } = await a.commitAttempt(commitInput, ctx);
    assert.equal(count(h.calls, 'committer.commit'), 1, 'the redelivery adopted the commit');
    assert.equal(await rows(h, 'select 1 from evidence_reservations where attempt_id = $1', [attemptId]), 1, 'and reserved nothing more');
    await a.persistEvidence({ ...attempt, baseSha: TASK_BASE }, ctx);

    // Push: the branch is written and the completion fails; the effect is unknown, and the redelivery adopts it.
    const pushFailure = await createOrchestrationActivities({ ...h.deps, sideEffects: failComplete('push') }).publishBranch(attempt, ctx)
      .then(() => null, (err: unknown) => err);
    assert.ok(pushFailure instanceof PublicationActivityError && pushFailure.effect === 'unknown', 'a failure after the call is unknown');
    assert.deepEqual(await a.publishBranch(attempt, ctx), { effect: 'applied' });
    assert.equal(h.forge.writes.filter((w) => w.startsWith('push')).length, 1, 'one push');
    assert.equal(h.forge.branches.get(branch), resultSha);

    // Upsert: the PR is created and the completion fails; the redelivery finds it by its head.
    const upsert = { ...attempt, repository: REPOSITORY, baseBranch: 'main', flagged: false, prBodySectionRef: null };
    const prFailure = await createOrchestrationActivities({ ...h.deps, sideEffects: failComplete('pr-upsert') }).upsertPullRequest(upsert, ctx)
      .then(() => null, (err: unknown) => err);
    assert.ok(prFailure instanceof PublicationActivityError && prFailure.effect === 'unknown');
    assert.deepEqual(await a.upsertPullRequest(upsert, ctx), { effect: 'applied', prNumber: 1 });
    assert.equal(h.forge.prs.length, 1, 'one pull request');
  });
});

test('runAgent: the agent never runs twice for one attempt; a lost lease stops it', async () => {
  await withHarness(async (h) => {
    const a = h.activities;
    const attempt = await h.leasedAttempt(1);
    const ctx = h.ctx();
    await a.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, ctx);
    await a.storeAttemptInputs({ ...attempt, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx);
    // An earlier delivery started the agent and died without an outcome.
    await h.facts.putOnce(SCOPE, { attemptId: attempt.attemptId, kind: 'agent-started', value: { at: LOGICAL_NOW } });
    await assert.rejects(a.runAgent({ ...attempt, workOrderRef: h.workOrderRef, budget: BUDGET }, ctx), AgentRedeliveryError);
    assert.equal(count(h.calls, 'agent.execute'), 0);

    // A second attempt whose lease is released while its agent runs: the renewal fails and the agent is aborted.
    const second = await h.leasedAttempt(2);
    await a.prepareWorkspace({ ...second, baseSha: TASK_BASE }, ctx);
    await a.storeAttemptInputs({ ...second, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx);
    const fast = createOrchestrationActivities({ ...h.deps, heartbeatEveryMs: 5, leaseRenewEveryMs: 5 });
    let aborted = false;
    h.agent = {
      ...h.agent,
      during: async (signal) => {
        await h.leases.release(SCOPE, second.fence.leaseId);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      },
    };
    const heartbeats: ActivityProgress[] = [];
    await assert.rejects(fast.runAgent({ ...second, workOrderRef: h.workOrderRef, budget: BUDGET }, h.ctx({ heartbeats })), LeaseLostError);
    assert.ok(aborted, 'the agent saw the abort');
    assert.ok(heartbeats.some((p) => p.stage === 'agent'), 'the activity heartbeated while the agent ran');
    assert.equal(await h.facts.get(SCOPE, { attemptId: second.attemptId, kind: 'agent-outcome' }), null, 'no outcome recorded');
  });
});

// ---------------------------------------------------------------------------
// The lookups and the pre-lease write
// ---------------------------------------------------------------------------

test('findAttempt: found after a registration that inserted and failed, absent otherwise; a failed lookup is an error', async () => {
  await withHarness(async (h) => {
    const a = h.activities;
    const ctx = h.ctx();
    h.attempts.failNextEnsureAfterInsert = true;
    await assert.rejects(a.ensureAttempt({ ...TASK, attemptNumber: 1, attemptKind: 'initial', baseSha: TASK_BASE, parentAttemptNumber: null, repairOrderRef: null }, ctx));
    const found = await a.findAttempt({ ...TASK, attemptNumber: 1 }, ctx);
    assert.match(String(found.attemptId), /^01K/);
    assert.deepEqual(await a.findAttempt({ ...TASK, attemptNumber: 2 }, ctx), { attemptId: null });
    const failing = createOrchestrationActivities({ ...h.deps, attempts: { ...h.deps.attempts, find: async () => { throw new Error('store unreadable'); } } });
    await assert.rejects(failing.findAttempt({ ...TASK, attemptNumber: 1 }, ctx), /store unreadable/);
  });
});

test('findLease and recordPreLeaseOutcome: a never-leased attempt records with fence null; a late grant is found and refuses that write', async () => {
  await withHarness(async (h) => {
    const a = h.activities;
    const ctx = h.ctx();
    const never = await h.registered(1);
    assert.deepEqual(await a.findLease(never, ctx), { fence: null });
    const facts = { round: 1, declaredComplete: false, verificationVerdict: null, adjudicationId: null, failureClass: 'environment' };
    assert.deepEqual(await a.recordPreLeaseOutcome({ ...never, ...facts, terminal: 'infrastructure-failed' }, ctx), { recorded: true });
    assert.deepEqual(await a.recordPreLeaseOutcome({ ...never, ...facts, terminal: 'infrastructure-failed' }, ctx), { recorded: true }, 'a redelivery');

    // A grant that committed after the lookup: the pre-lease write is refused as a result, then the lookup finds it.
    const late = await h.registered(2);
    const granted = await h.terminals.acquireLease(SCOPE, { attempt: { repositoryBindingId: IDS.bindingId, runId: IDS.runId, taskId: IDS.taskId, attemptId: late.attemptId }, branch: late.branch, ttlMs: 60_000 });
    assert.ok(!('denied' in granted));
    assert.deepEqual(await a.recordPreLeaseOutcome({ ...late, ...facts, terminal: 'cancelled' }, ctx), { recorded: false });
    const { fence } = await a.findLease(late, ctx);
    assert.deepEqual(fence, { leaseId: granted.leaseId, fencingEpoch: granted.fencingEpoch });
    await a.recordAttemptOutcome({ ...late, ...facts, assuranceUnavailable: false, modelCostMicroUsd: null, terminal: 'cancelled', fence }, ctx);
    assert.equal(await rows(h, `select 1 from run_events where attempt_id = $1 and event_type = 'attempt.completed'`, [late.attemptId]), 1);
  });
});

test('recordPreLeaseOutcome maps exactly the slot\'s lease-granted refusal to recorded: false; every other error stays an error', async () => {
  const cases: readonly (readonly [string, Error | null, boolean | 'throws'])[] = [
    ['recorded', null, true],
    ['lease-granted', new ReviewLoopContractError('lease-granted', 'history shows a lease'), false],
    ['fenced', new AssuranceFencedError('superseded'), 'throws'],
    ['conflicting-redelivery', new ReviewLoopContractError('conflicting-redelivery', 'other facts'), 'throws'],
    ['not-in-scope', new ReviewLoopContractError('not-in-scope', 'no'), 'throws'],
    ['transient', new Error('connection reset'), 'throws'],
  ];
  for (const [label, error, expected] of cases) {
    await withHarness(async (h) => {
      const never = await h.registered(1);
      const facts = { round: 1, declaredComplete: false, verificationVerdict: null, adjudicationId: null, failureClass: null, terminal: 'cancelled' as const };
      const run = h.activities.recordPreLeaseOutcome({ ...never, ...facts }, h.ctx());
      if (expected === 'throws') await assert.rejects(run, (err: unknown) => err === error, label);
      else assert.deepEqual(await run, { recorded: expected }, label);
    }, { slot: (store) => (error === null ? new NotConfiguredAssuranceSlot(store) : throwingOutcomeSlot(store, error)) });
  }
});

type TerminalStore = ConstructorParameters<typeof NotConfiguredAssuranceSlot>[0];

/** The default slot whose terminal write fails with the given error. */
function throwingOutcomeSlot(store: TerminalStore, error: Error): ReviewLoopSlot {
  const inner = new NotConfiguredAssuranceSlot(store);
  return Object.assign(Object.create(inner) as ReviewLoopSlot, { recordAttemptOutcome: async () => { throw error; } });
}

test('recordAttemptOutcome presents the caller\'s fence and must run before the lease is released', async () => {
  await withHarness(async (h) => {
    const a = h.activities;
    const ctx = h.ctx();
    const facts = { round: 1, declaredComplete: true, verificationVerdict: 'FAIL' as const, adjudicationId: null, failureClass: null, assuranceUnavailable: false, modelCostMicroUsd: null };
    // Outcome, then release: recorded.
    const first = await h.leasedAttempt(1);
    await a.recordAttemptOutcome({ ...first, ...facts, terminal: 'verification-stopped' }, ctx);
    await a.releaseLease(first, ctx);
    // Release, then outcome: the fence no longer holds and nothing is written.
    const second = await h.leasedAttempt(2);
    await a.releaseLease(second, ctx);
    await assert.rejects(a.recordAttemptOutcome({ ...second, ...facts, terminal: 'verification-stopped' }, ctx), AssuranceFencedError);
    assert.equal(await rows(h, 'select 1 from run_events where attempt_id = $1', [second.attemptId]), 0);
    // A leased attempt cannot be recorded as never leased.
    const third = await h.leasedAttempt(3);
    await assert.rejects(a.recordAttemptOutcome({ ...third, ...facts, terminal: 'cancelled', fence: null }, ctx),
      (err: unknown) => err instanceof ReviewLoopContractError && err.code === 'lease-granted');
  });
});

// ---------------------------------------------------------------------------
// Evidence bytes are the same on every retry
// ---------------------------------------------------------------------------

test('evidence: the bytes are identical across retries, timed by the workflow, also when the commit had to reserve again', async () => {
  await withHarness(async (h) => {
    const { attempt, evidenceId } = await throughEvidence(h);
    const bundle = await h.deps.evidence.getEvidence(SCOPE, evidenceId as ArtifactId);
    assert.equal(bundle.createdAt, LOGICAL_NOW, 'the evidence time is the workflow\'s logical time');
    const again = await h.activities.persistEvidence({ ...attempt, baseSha: TASK_BASE }, h.ctx({ logicalNow: '2027-01-01T00:00:00.000Z' }));
    assert.equal(again.evidenceId, evidenceId);
    const shas = await h.db.query(`select sha256 from artifacts where id = $1`, [evidenceId]);
    assert.equal(shas.rowCount, 1);
    assert.equal(shas.rows[0]!['sha256'], sha256(JSON.stringify(bundle)), 'the stored bytes are the bundle read back');

    // A commit delivery cancelled after it reserved: the next reserves the same draft bytes.
    const second = await h.leasedAttempt(2);
    const ctx = h.ctx();
    await h.activities.prepareWorkspace({ ...second, baseSha: TASK_BASE }, ctx);
    await h.activities.storeAttemptInputs({ ...second, contextPackRef: h.contextPackRef, repairOrderRef: null }, ctx);
    await h.activities.runAgent({ ...second, workOrderRef: h.workOrderRef, budget: BUDGET }, ctx);
    await h.activities.runVerification({ ...second, planId: 'plan-R0', checks: CHECKS }, ctx);
    const cancel = new AbortController();
    h.hooks.afterCall = (name) => { if (name === 'log.confirmOwner commit') cancel.abort(); };
    await assert.rejects(h.activities.commitAttempt({ ...second, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef }, h.ctx({ signal: cancel.signal })), ActivityCancelledError);
    h.hooks.afterCall = null;
    await h.activities.commitAttempt({ ...second, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef }, ctx);
    const drafts = await h.db.query(`select draft_sha256 from evidence_reservations where attempt_id = $1`, [second.attemptId]);
    assert.equal(drafts.rowCount, 2, 'the cancelled delivery reserved, and so did the next');
    assert.equal(drafts.rows[0]!['draft_sha256'], drafts.rows[1]!['draft_sha256'], 'with the same draft bytes');
  });
});

// ---------------------------------------------------------------------------
// The abort check and the fence immediately before each external call
// ---------------------------------------------------------------------------

/** The calls between the last fence check before `call` and `call` itself. */
function guardBefore(calls: readonly string[], call: string, fence: string): void {
  const at = calls.indexOf(call);
  assert.ok(at > 0, `${call} was made`);
  assert.equal(calls[at - 1], fence, `${call} is preceded immediately by ${fence}`);
}

test('side-effect activities check the fence immediately before their external call, and an abort there stops the call', async () => {
  await withHarness(async (h) => {
    const { attempt } = await throughEvidence(h);
    guardBefore(h.calls, 'workspaces.create', 'leases.heartbeat');
    guardBefore(h.calls, 'agent.execute', 'leases.heartbeat');
    guardBefore(h.calls, 'runner.run cmd-l0', 'leases.heartbeat');
    guardBefore(h.calls, 'committer.commit', 'log.confirmOwner commit');
    await h.activities.publishBranch(attempt, h.ctx());
    guardBefore(h.calls, 'forge.pushBranch', 'log.confirmOwner push');
    await h.activities.upsertPullRequest({ ...attempt, repository: REPOSITORY, baseBranch: 'main', flagged: false, prBodySectionRef: null }, h.ctx());
    guardBefore(h.calls, 'forge.upsertPullRequest', 'log.confirmOwner pr-upsert');
  });

  // An abort between the fence and the call: the call is never made.
  for (const [confirm, call] of [['log.confirmOwner push', 'forge.pushBranch'], ['log.confirmOwner pr-upsert', 'forge.upsertPullRequest']] as const) {
    await withHarness(async (h) => {
      const { attempt } = await throughEvidence(h);
      if (call === 'forge.upsertPullRequest') await h.activities.publishBranch(attempt, h.ctx());
      const cancel = new AbortController();
      h.hooks.afterCall = (name) => { if (name === confirm) cancel.abort(); };
      const run = call === 'forge.pushBranch'
        ? h.activities.publishBranch(attempt, h.ctx({ signal: cancel.signal }))
        : h.activities.upsertPullRequest({ ...attempt, repository: REPOSITORY, baseBranch: 'main', flagged: false, prBodySectionRef: null }, h.ctx({ signal: cancel.signal }));
      const failure = await run.then(() => null, (err: unknown) => err);
      assert.ok(failure instanceof PublicationActivityError, call);
      assert.ok(failure.cause instanceof ActivityCancelledError, `${call}: cancelled`);
      // This delivery created the record and never reached the forge: the effect is provably absent.
      assert.equal(failure.effect, 'none', call);
      assert.equal(count(h.calls, call), 0, `${call} never made`);
    });
  }

  await withHarness(async (h) => {
    const attempt = await h.leasedAttempt(1);
    const cancel = new AbortController();
    cancel.abort();
    await assert.rejects(h.activities.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, h.ctx({ signal: cancel.signal })), ActivityCancelledError);
    assert.equal(count(h.calls, 'workspaces.create'), 0);
    // A lease that is no longer live fails the fence before the call.
    await h.leases.release(SCOPE, attempt.fence.leaseId);
    await assert.rejects(h.activities.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, h.ctx()), LeaseLostError);
    assert.equal(count(h.calls, 'workspaces.create'), 0);
  });
});

// ---------------------------------------------------------------------------
// The FAILED lifecycle against the primitive
// ---------------------------------------------------------------------------

test('FAILED lifecycle: a FAILED record is never reopened and reports unknown; a PENDING one is reconciled before any call', async () => {
  // A FAILED push record: reported unknown, no forge call, still FAILED after a redelivery.
  await withHarness(async (h) => {
    const { attempt, resultSha } = await throughEvidence(h);
    const key = { operation: 'push' as const, repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId };
    await h.sideEffects.begin(SCOPE, { ...key, requestFingerprint: `push:${attempt.branch}@${resultSha}`, ownerToken: attempt.fence.leaseId, naturalKey: attempt.branch });
    await h.sideEffects.fail(SCOPE, { ...key, ownerToken: attempt.fence.leaseId });
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const failure = await h.activities.publishBranch(attempt, h.ctx()).then(() => null, (err: unknown) => err);
      assert.ok(failure instanceof PublicationActivityError && failure.effect === 'unknown');
    }
    assert.equal(count(h.calls, 'forge.pushBranch'), 0, 'never re-executed');
    assert.equal((await h.sideEffects.find(SCOPE, key))?.state, 'FAILED', 'never reopened');
  });

  // A FAILED record of an expired earlier lease: the successor neither calls nor takes the record over.
  await withHarness(async (h) => {
    const { attempt, resultSha } = await throughEvidence(h);
    const key = { operation: 'push' as const, repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId };
    await h.sideEffects.begin(SCOPE, { ...key, requestFingerprint: `push:${attempt.branch}@${resultSha}`, ownerToken: attempt.fence.leaseId, naturalKey: attempt.branch });
    await h.sideEffects.fail(SCOPE, { ...key, ownerToken: attempt.fence.leaseId });
    await h.db.query(`update workspace_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [attempt.fence.leaseId]);
    const next = await h.leases.acquire(SCOPE, { repositoryBindingId: IDS.bindingId, branch: attempt.branch, attemptId: attempt.attemptId, ttlMs: 60_000 });
    assert.ok(!('denied' in next));
    const successor = { ...attempt, fence: { leaseId: next.leaseId, fencingEpoch: next.fencingEpoch } };
    const failure = await h.activities.publishBranch(successor, h.ctx()).then(() => null, (err: unknown) => err);
    assert.ok(failure instanceof PublicationActivityError && failure.effect === 'unknown');
    assert.equal(count(h.calls, 'forge.pushBranch'), 0, 'never re-executed');
    const record = await h.sideEffects.find(SCOPE, key);
    assert.equal(record?.state, 'FAILED');
    assert.equal(record?.ownerToken, attempt.fence.leaseId, 'the FAILED record keeps its owner');
    assert.ok(![...h.audit.rows.values()].some((e) => e.action === 'side-effect.takeover'), 'no takeover of a FAILED record');
  });

  // A PENDING record whose effect is on the remote: adopted as COMPLETED without a call.
  await withHarness(async (h) => {
    const { attempt, resultSha } = await throughEvidence(h);
    const key = { operation: 'push' as const, repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId };
    await h.sideEffects.begin(SCOPE, { ...key, requestFingerprint: `push:${attempt.branch}@${resultSha}`, ownerToken: attempt.fence.leaseId, naturalKey: attempt.branch });
    h.forge.branches.set(attempt.branch, resultSha);
    assert.deepEqual(await h.activities.publishBranch(attempt, h.ctx()), { effect: 'applied' });
    assert.equal(count(h.calls, 'forge.pushBranch'), 0);
    guardBefore(h.calls, 'log.complete push', 'forge.resolveRef');
    assert.equal((await h.sideEffects.find(SCOPE, key))?.state, 'COMPLETED');
  });

  // A PENDING record of a dead owner, effect absent: taken over, reconciled first, then performed by the new holder.
  await withHarness(async (h) => {
    const { attempt, resultSha } = await throughEvidence(h);
    const key = { operation: 'push' as const, repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId };
    await h.sideEffects.begin(SCOPE, { ...key, requestFingerprint: `push:${attempt.branch}@${resultSha}`, ownerToken: attempt.fence.leaseId, naturalKey: attempt.branch });
    await h.db.query(`update workspace_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [attempt.fence.leaseId]);
    const next = await h.leases.acquire(SCOPE, { repositoryBindingId: IDS.bindingId, branch: attempt.branch, attemptId: attempt.attemptId, ttlMs: 60_000 });
    assert.ok(!('denied' in next));
    const successor = { ...attempt, fence: { leaseId: next.leaseId, fencingEpoch: next.fencingEpoch } };
    h.calls.length = 0;
    assert.deepEqual(await h.activities.publishBranch(successor, h.ctx()), { effect: 'applied' });
    assert.ok(h.calls.indexOf('forge.resolveRef') < h.calls.indexOf('forge.pushBranch'), 'reconciled by natural key before the call');
    assert.equal(h.forge.branches.get(attempt.branch), resultSha);
    assert.ok([...h.audit.rows.values()].some((e) => e.action === 'side-effect.takeover'), 'the takeover is audited');
  });

  // An ambiguous transport outcome: the record stays PENDING and the effect is unknown; the next delivery adopts it.
  await withHarness(async (h) => {
    const { attempt, resultSha } = await throughEvidence(h);
    h.forge.failNext = { call: 'pushBranch', error: new Error('socket hang up'), afterWrite: true };
    const failure = await h.activities.publishBranch(attempt, h.ctx()).then(() => null, (err: unknown) => err);
    assert.ok(failure instanceof PublicationActivityError && failure.effect === 'unknown');
    const key = { operation: 'push' as const, repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId };
    assert.equal((await h.sideEffects.find(SCOPE, key))?.state, 'PENDING', 'never recorded FAILED');
    assert.deepEqual(await h.activities.publishBranch(attempt, h.ctx()), { effect: 'applied' });
    assert.equal(h.forge.branches.get(attempt.branch), resultSha);
    assert.equal(h.forge.writes.filter((w) => w.startsWith('push')).length, 1);
  });
});

// ---------------------------------------------------------------------------
// The admission hook
// ---------------------------------------------------------------------------

test('admission hook: without it admission is exactly admitRisk; with it the injected function decides, and DEFERRED stops before any side effect', async () => {
  const risks: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];
  await withHarness(async (h) => {
    for (const risk of risks) {
      const plain = await h.activities.admitTask({ ...TASK, risk }, h.ctx());
      const expected = admitRisk(risk);
      assert.deepEqual(plain, { admitted: expected.admitted, reason: expected.decision }, risk);
    }
    const deferAll = (risk: RiskLevel): AdmissionResult => ({ risk, decision: 'DEFERRED', admitted: false, requiresHumanIndependentReview: true, reason: 'injected' });
    const hooked = createOrchestrationActivities({ ...h.deps, admit: deferAll });
    assert.deepEqual(await hooked.admitTask({ ...TASK, risk: 'R0' }, h.ctx()), { admitted: false, reason: 'DEFERRED' });

    // The same hook on the governed sequence: no lease, workspace or agent.
    const attempt = await h.registered(1);
    let acquired = 0;
    const governed = async (admit?: (risk: RiskLevel) => AdmissionResult) => governedExecution({
      scope: SCOPE, risk: 'R0', repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId, baseSha: TASK_BASE,
      branch: attempt.branch, leaseTtlMs: 3_600_000,
      leases: { acquire: async () => { acquired += 1; return { denied: true, reason: 'test' }; }, heartbeat: async () => {}, release: async () => {} },
      workspaces: h.workspaces, provider: { providerId: 'p', execute: async () => h.agent.observation },
      inspector: { inspect: async () => { throw new Error('unreachable'); } },
      workOrderRef: h.workOrderRef, contextPackRef: h.contextPackRef, budget: BUDGET,
      toolPolicy: h.deps.toolPolicy, signal: new AbortController().signal,
      ...(admit !== undefined ? { admit } : {}),
    });
    for (const risk of risks) {
      const r = await governedExecution({
        scope: SCOPE, risk, repositoryBindingId: IDS.bindingId, attemptId: attempt.attemptId, baseSha: TASK_BASE,
        branch: attempt.branch, leaseTtlMs: 3_600_000,
        leases: { acquire: async () => ({ denied: true, reason: 'test' }), heartbeat: async () => {}, release: async () => {} },
        workspaces: h.workspaces, provider: { providerId: 'p', execute: async () => h.agent.observation },
        inspector: { inspect: async () => { throw new Error('unreachable'); } },
        workOrderRef: h.workOrderRef, contextPackRef: h.contextPackRef, budget: BUDGET,
        toolPolicy: h.deps.toolPolicy, signal: new AbortController().signal,
      });
      assert.equal(JSON.stringify(r.admission), JSON.stringify(admitRisk(risk)), `${risk}: byte-identical to admitRisk`);
    }
    const blocked = await governed(deferAll);
    assert.equal(blocked.stoppedAt, 'admission');
    assert.equal(acquired, 0, 'no lease was requested');
    assert.equal(count(h.calls, 'workspaces.create'), 0);
    await governed();
    assert.equal(acquired, 1, 'without the hook R0 proceeds to the lease');
  });
});

// ---------------------------------------------------------------------------
// The context adapter
// ---------------------------------------------------------------------------

test('context adapter: signal and heartbeat are the delivery\'s, now() is the logical time on every redelivery, and a redelivered terminal writes the same events', async () => {
  const controller = new AbortController();
  const seen: ActivityProgress[] = [];
  const ctx = { engineAttempt: 1, signal: controller.signal, lastProgress: null, logicalNow: LOGICAL_NOW, heartbeat: (p: ActivityProgress) => { seen.push(p); } };
  const step = assuranceStepContext(ctx);
  assert.equal(step.signal, controller.signal);
  assert.equal(step.now(), LOGICAL_NOW);
  assert.equal(assuranceStepContext({ ...ctx, engineAttempt: 3 }).now(), LOGICAL_NOW, 'the same on a redelivery');
  step.heartbeat({ step: 'reviewer', reviewerConfigId: 'rv-1', note: 'free text never reaches the engine' });
  step.heartbeat({ step: 'packet' });
  assert.deepEqual(seen, [{ stage: 'reviewer', detail: { reviewerConfigId: 'rv-1' } }, { stage: 'packet' }]);

  await withHarness(async (h) => {
    const attempt = await h.leasedAttempt(1);
    const facts = { round: 1, declaredComplete: false, verificationVerdict: null, adjudicationId: null, failureClass: 'provider', assuranceUnavailable: false, modelCostMicroUsd: null };
    await h.activities.recordAttemptOutcome({ ...attempt, ...facts, terminal: 'agent-failed' }, h.ctx({ engineAttempt: 1 }));
    const first = await h.db.query('select event_id, payload from run_events where attempt_id = $1 order by event_id', [attempt.attemptId]);
    await h.activities.recordAttemptOutcome({ ...attempt, ...facts, terminal: 'agent-failed' }, h.ctx({ engineAttempt: 2 }));
    const second = await h.db.query('select event_id, payload from run_events where attempt_id = $1 order by event_id', [attempt.attemptId]);
    assert.equal(JSON.stringify(second.rows), JSON.stringify(first.rows), 'byte-identical after the redelivery');
    assert.ok(first.rows.every((r) => (r['payload'] as RunEvent).occurredAt === LOGICAL_NOW));
  });
});

// ---------------------------------------------------------------------------
// The default slot bound into the assurance activity
// ---------------------------------------------------------------------------

test('the default slot through the assurance activity: PROCEED not-required for R0 and R1, unavailable for any risk that needs review', async () => {
  for (const [risk, expected] of [['R0', 'PROCEED'], ['R1', 'PROCEED'], ['R2', 'unavailable'], ['R4', 'unavailable']] as const) {
    await withHarness(async (h) => {
      const { attempt, evidenceId } = await throughEvidence(h);
      const round = {
        ...attempt, risk, round: 1, evidenceId, taskBaseSha: TASK_BASE, attemptBaseSha: TASK_BASE, declaredComplete: true,
        priorAdjudicationId: null, idempotencyKey: `${attempt.attemptId}:assurance:1`, budgetRemaining: { costMicroUsd: null, wallClockMs: 1 },
        workOrderRef: h.workOrderRef,
      };
      if (expected === 'unavailable') {
        await assert.rejects(h.activities.assuranceRound(round, h.ctx()), AssuranceUnavailableError, risk);
      } else {
        const { outcome } = await h.activities.assuranceRound(round, h.ctx());
        assert.deepEqual([outcome.kind, outcome.mode, outcome.kind === 'PROCEED' ? outcome.prBodySectionRef : 'x'], ['PROCEED', 'not-required', null], risk);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Check ids through the catalog
// ---------------------------------------------------------------------------

test('verification runs the catalog\'s command for each check id, and an unknown id fails before any command runs', async () => {
  await withHarness(async (h) => {
    const attempt = await h.leasedAttempt(1);
    const ctx = h.ctx();
    await h.activities.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, ctx);
    await assert.rejects(
      h.activities.runVerification({ ...attempt, planId: 'plan-R0', checks: [...CHECKS, { ...CHECKS[0]!, id: 'x', commandId: 'rm -rf /' }] }, ctx),
      UnknownVerificationCommandError,
    );
    assert.equal(h.calls.filter((c) => c.startsWith('runner.run')).length, 0, 'nothing ran');
    assert.equal(await h.facts.get(SCOPE, { attemptId: attempt.attemptId, kind: 'verification' }), null);
    h.exitCodes.set('cmd-l1', 1);
    assert.deepEqual(await h.activities.runVerification({ ...attempt, planId: 'plan-R0', checks: CHECKS }, ctx), { verdict: 'FAIL' });
    assert.deepEqual(h.calls.filter((c) => c.startsWith('runner.run')), ['runner.run cmd-l0', 'runner.run cmd-l1']);
    assert.ok(h.calls.indexOf('reaper.reap verify') < h.calls.indexOf('runner.run cmd-l0'), 'leftover containers reaped first');
    // A failed verification records no commit.
    await assert.rejects(h.activities.commitAttempt({ ...attempt, expectedHeadSha: TASK_BASE, workOrderRef: h.workOrderRef }, ctx), OrchestrationContractError);
  });

  // A cancelled verification's verdict is never recorded.
  await withHarness(async (h) => {
    const attempt = await h.leasedAttempt(1);
    await h.activities.prepareWorkspace({ ...attempt, baseSha: TASK_BASE }, h.ctx());
    const cancel = new AbortController();
    h.hooks.afterCall = (name) => { if (name === 'runner.run cmd-l0') cancel.abort(); };
    await assert.rejects(h.activities.runVerification({ ...attempt, planId: 'plan-R0', checks: CHECKS }, h.ctx({ signal: cancel.signal })), ActivityCancelledError);
    assert.equal(await h.facts.get(SCOPE, { attemptId: attempt.attemptId, kind: 'verification' }), null);
  });
});

// ---------------------------------------------------------------------------
// The activity span and the audit vocabulary
// ---------------------------------------------------------------------------

test('every activity emits orchestration.activity with its name, the workflow id, the delivery count and the fence', async () => {
  await withHarness(async (h) => {
    const attempt = await h.leasedAttempt(1);
    await h.activities.renewLease(attempt, h.ctx({ engineAttempt: 2 }));
    await h.activities.recordControl({ ...TASK, taskId: null, requestId: 'seal-1', control: 'seal', principalId: 'human-1' }, h.ctx());
    const spans = h.telemetry.events.filter((e) => e.name === 'asep.span.orchestration.activity');
    const renew = spans.find((e) => e.attributes['asep.activity'] === 'renewLease');
    assert.deepEqual(renew && {
      workflow: renew.attributes['workflow_id'], delivery: renew.attributes['activity_attempt'],
      lease: renew.attributes['lease_id'], epoch: renew.attributes['fencing_epoch'], attempt: renew.context.attemptId, status: renew.attributes['status'],
    }, { workflow: WORKFLOW_ID, delivery: 2, lease: attempt.fence.leaseId, epoch: attempt.fence.fencingEpoch, attempt: attempt.attemptId, status: 'OK' });
    const seal = spans.find((e) => e.attributes['asep.activity'] === 'recordControl');
    assert.equal(seal?.context.taskId, undefined, 'a run-level activity has no task');
    assert.equal(h.audit.rows.get(`${WORKFLOW_ID}:control:seal-1`)?.action, 'workflow.seal');
  }, { tracer: true });
});

test('every audit action the decision core writes is a declared orchestration audit action, and recordAudit refuses any other', async () => {
  const core = ['task-core.ts', 'run-core.ts'].map((f) => readFileSync(join(HERE, '..', '..', '..', 'orchestration', 'src', f), 'utf8')).join('\n');
  const written = [...new Set([...core.matchAll(/\baudit\(step, '([^']+)'/g)].map((m) => m[1]!))].sort();
  assert.ok(written.length >= 10, 'the scan finds the core\'s audits');
  for (const action of written) assert.ok((ORCHESTRATION_AUDIT_ACTIONS as readonly string[]).includes(action), action);
  await withHarness(async (h) => {
    await assert.rejects(
      h.activities.recordAudit({ ...TASK, attemptId: null, key: `${WORKFLOW_ID}:1`, action: 'budget.threshold_crossed', detail: {} }, h.ctx()),
      OrchestrationContractError,
    );
    assert.equal(h.audit.rows.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Run events of the workflow, and the repair start
// ---------------------------------------------------------------------------

test('workflow run events map to the run-event contract and refuse a type or detail it has no field for', () => {
  const base = { ...TASK, attemptId: null, risk: 'R0' as const };
  const completed = workflowRunEvent({ ...base, eventSeq: 9, eventType: 'task.completed', detail: { workflowId: WORKFLOW_ID, outcome: 'WAITING_FOR_HUMAN_REVIEW', repairCycles: 1 } }, LOGICAL_NOW);
  assert.deepEqual(completed, {
    eventId: `${WORKFLOW_ID}:9`, eventType: 'task.completed', occurredAt: LOGICAL_NOW, runId: IDS.runId, taskId: IDS.taskId, risk: 'R0',
    organizationId: IDS.organizationId, projectId: IDS.projectId, repositoryBindingId: IDS.bindingId, workflowId: WORKFLOW_ID,
    outcome: 'succeeded', repairCycles: 1,
  });
  for (const [outcome, mapped] of [['FAILED', 'failed'], ['BLOCKED', 'blocked'], ['BUDGET_EXHAUSTED', 'failed'], ['CANCELLED', 'cancelled'], ['COMPLETED', 'succeeded']]) {
    assert.equal(workflowRunEvent({ ...base, eventSeq: 1, eventType: 'task.completed', detail: { outcome: outcome! } }, LOGICAL_NOW).outcome, mapped);
  }
  assert.throws(() => workflowRunEvent({ ...base, eventSeq: 1, eventType: 'repair.started', detail: {} }, LOGICAL_NOW), OrchestrationContractError);
  assert.throws(() => workflowRunEvent({ ...base, eventSeq: 1, eventType: 'task.started', detail: { spentUsd: 1 } }, LOGICAL_NOW), /spentUsd/);
});

test('repair start: the slot reports it once across retries, and the workflow\'s events carry none', async () => {
  // The slot that decided the repair reports its start when it derives the repair attempt's inputs. Its event id
  // derives from the attempt, so a retried derivation finds the event already appended.
  let derivations = 0;
  let sink: { append: (s: typeof SCOPE, e: RunEvent) => Promise<unknown> } | null = null;
  const repairSlot = (store: TerminalStore): ReviewLoopSlot => {
    const inner = new NotConfiguredAssuranceSlot(store);
    return Object.assign(Object.create(inner) as ReviewLoopSlot, {
      buildRepairContextPack: async (input: Parameters<ReviewLoopSlot['buildRepairContextPack']>[0], ctx: Parameters<ReviewLoopSlot['buildRepairContextPack']>[1]) => {
        derivations += 1;
        await sink!.append(input.scope, {
          eventId: `${input.attemptId}:repair.started`, eventType: 'repair.started', occurredAt: ctx.now(), runId: IDS.runId,
          taskId: IDS.taskId, attemptId: input.attemptId, organizationId: input.scope.organizationId, projectId: input.scope.projectId,
          repositoryBindingId: IDS.bindingId, repairRound: true,
        });
        return { contextPackRef: input.originalContextPackRef };
      },
    });
  };
  await withHarness(async (h) => {
    sink = h.deps.runEvents;
    const attempt = await h.leasedAttempt(2);
    const input = { ...attempt, contextPackRef: h.contextPackRef, repairOrderRef: h.workOrderRef };
    // The first delivery derives the inputs and fails before recording them; the retry derives them again.
    const facts = h.deps.facts;
    const lossy = createOrchestrationActivities({
      ...h.deps,
      facts: { ...facts, get: facts.get.bind(facts), putOnce: async () => { throw new Error('connection reset'); } },
    });
    await assert.rejects(lossy.storeAttemptInputs(input, h.ctx()), /connection reset/);
    await h.activities.storeAttemptInputs(input, h.ctx());
    await h.activities.storeAttemptInputs(input, h.ctx());
    assert.equal(derivations, 2, 'derived twice');
    // The workflow's own events for the attempt, delivered twice each.
    for (const [seq, type] of [[3, 'attempt.started'], [4, 'workflow.recovered']] as const) {
      const event = { ...TASK, eventSeq: seq, eventType: type, attemptId: attempt.attemptId, detail: type === 'workflow.recovered' ? { recoveryKind: 'attempt-replaced' } : {} };
      await h.activities.emitRunEvent(event, h.ctx());
      await h.activities.emitRunEvent(event, h.ctx({ engineAttempt: 2 }));
    }
    const started = await h.db.query(`select event_id from run_events where event_type = 'repair.started'`);
    assert.deepEqual(started.rows.map((r) => r['event_id']), [`${attempt.attemptId}:repair.started`], 'exactly one repair.started');
    assert.equal(await rows(h, `select 1 from run_events where event_type in ('attempt.started', 'workflow.recovered')`), 2);
  }, { slot: repairSlot });
});
