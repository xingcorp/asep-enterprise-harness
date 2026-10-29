// Decision-core behavior tables: the task reducer, the run reducer and the pure
// building blocks they use (activity options, budget reservation, approvals,
// assurance-outcome validation, task-status projection).
//
// Scenarios run through the sequential in-memory interpreter, which drives the
// reducer exactly as the Temporal workflow will: one awaited request at a time,
// effects executed in order, messages delivered between results.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunId, TaskId } from '@asep/contracts';
import { taskReachableStates, transitionTask } from '@asep/domain';
import {
  ACTIVITY_OPTIONS,
  CRITICAL_UNITS,
  EFFECT_ACTIVITY,
  agentStartToCloseSeconds,
  verificationStartToCloseSeconds,
} from './activity-options.js';
import { ALLOWED_DECISIONS, APPROVAL_KINDS, approvalRequestId, validateApprovalDecision } from './approvals.js';
import { parseAssuranceOutcome } from './assurance.js';
import { checkReservation, crossesSoftThreshold, toMicroUsd } from './budget.js';
import { DEFAULT_ORCHESTRATION_POLICY, FAILURE_CLASSES, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import { isLegalProjection } from './projection.js';
import { decideRun, startRun } from './run-core.js';
import type { RunCommand, RunCoreInput } from './run-core.js';
import { runTaskSequentially } from './sequential-interpreter.js';
import type { TaskTrace } from './sequential-interpreter.js';
import { decideTask, startTask, taskWorkflowId } from './task-core.js';
import { orchestrationPolicyErrors } from './validation.js';
import {
  TASK_BASE,
  baseInput,
  effectsOf,
  governance,
  happyAnswer,
  indexOfCommand,
  policy,
  proceed,
  ref,
  repair,
  requestKinds,
  requests,
  scripted,
  shaFor,
} from './test-support/fixtures.js';
import type { TaskCommand, TaskEffect, TaskEvent, TaskRequest, TaskRequestKind } from './types.js';

console.log('SUITE-ID: asep-suite:orchestration-core');

function assertLegalProjections(trace: TaskTrace): void {
  let from = 'READY' as Parameters<typeof isLegalProjection>[0];
  for (const p of effectsOf(trace.commands, 'projectTaskState')) {
    assert.ok(isLegalProjection(from, p.status), `illegal projection ${from} -> ${p.status}`);
    from = p.status;
  }
}

function outcomes(trace: TaskTrace) {
  return effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.attemptNumber, o.terminal]);
}

// ---------------------------------------------------------------------------
// Activity options
// ---------------------------------------------------------------------------

const ALL_REQUESTS: readonly TaskRequestKind[] = [
  'admitTask', 'ensureAttempt', 'acquireLease', 'prepareWorkspace', 'storeAttemptInputs', 'runAgent',
  'inspectWorkspace', 'runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound',
  'openApprovalRequest', 'verifyApprovalDecision', 'publishBranch', 'upsertPullRequest',
];

test('activity options: every activity declares an explicit retry limit and start-to-close timeout', () => {
  for (const [name, o] of Object.entries(ACTIVITY_OPTIONS)) {
    assert.ok(Number.isInteger(o.retry.maximumAttempts) && o.retry.maximumAttempts >= 1, `${name} maximumAttempts`);
    assert.ok(o.startToCloseSeconds > 0, `${name} startToClose`);
    assert.ok(o.retry.initialIntervalSeconds > 0 && o.retry.backoffCoefficient >= 1, `${name} backoff`);
    assert.ok(o.retry.maximumIntervalSeconds >= o.retry.initialIntervalSeconds, `${name} max interval`);
  }
  for (const kind of ALL_REQUESTS) assert.ok(kind in ACTIVITY_OPTIONS, `no options for request ${kind}`);
});

test('activity options: long activities declare a heartbeat timeout; the agent is never engine-retried', () => {
  const long = ['prepareWorkspace', 'runAgent', 'inspectWorkspace', 'runVerification', 'commitAttempt',
    'persistEvidence', 'assuranceRound', 'publishBranch', 'upsertPullRequest'] as const;
  for (const name of long) assert.ok((ACTIVITY_OPTIONS[name].heartbeatTimeoutSeconds ?? 0) > 0, name);
  assert.equal(ACTIVITY_OPTIONS.runAgent.retry.maximumAttempts, 1);
  assert.equal(ACTIVITY_OPTIONS.runVerification.retry.maximumAttempts, 2);
});

test('activity options: the critical units are commit plus evidence, push, and PR upsert; nothing else is shielded', () => {
  assert.deepEqual(CRITICAL_UNITS, [['commitAttempt', 'persistEvidence'], ['publishBranch'], ['upsertPullRequest']]);
  for (const unit of CRITICAL_UNITS) {
    for (const name of unit) assert.equal(ACTIVITY_OPTIONS[name].cancellable, false, name);
  }
  for (const name of ['runAgent', 'runVerification', 'assuranceRound', 'inspectWorkspace', 'prepareWorkspace'] as const) {
    assert.equal(ACTIVITY_OPTIONS[name].cancellable, true, name);
  }
});

test('activity options: derived timeouts add five minutes of grace', () => {
  assert.equal(agentStartToCloseSeconds({ maxTurns: 1, maxToolCalls: 1, maxCostUsd: 1, maxWallClockMinutes: 30 }), 30 * 60 + 300);
  assert.equal(verificationStartToCloseSeconds([60, 120]), 180 + 300);
  assert.equal(verificationStartToCloseSeconds([]), 300);
});

test('activity options: every effect except timers runs as an activity with explicit options', () => {
  const kinds: readonly TaskEffect['kind'][] = [
    'projectTaskState', 'emitRunEvent', 'recordAttemptOutcome', 'recordUsage', 'recordOverrun', 'recordExtension',
    'reapContainers', 'quarantineWorkspace', 'cleanupWorkspace', 'releaseLease', 'expireApprovalRequest',
    'cancelApprovalRequest', 'recordControl', 'audit', 'startTimer', 'cancelTimer',
  ];
  for (const kind of kinds) {
    const activity = EFFECT_ACTIVITY[kind];
    if (kind === 'startTimer' || kind === 'cancelTimer') {
      assert.equal(activity, null, kind);
      continue;
    }
    assert.ok(activity !== null && activity in ACTIVITY_OPTIONS, kind);
    assert.equal(ACTIVITY_OPTIONS[activity].cancellable, false, `${kind} must complete even when the task is cancelled`);
  }
});

// ---------------------------------------------------------------------------
// Budget reservation
// ---------------------------------------------------------------------------

const RES = {
  attemptNumber: 1,
  attemptBudget: { maxTurns: 1, maxToolCalls: 1, maxCostUsd: 5, maxWallClockMinutes: 30 },
  taskBudget: { maxAttempts: 3, maxCostUsd: 20, softCostUsd: 12, maxWallClockMinutes: 240 },
  verificationReserve: { costUsd: 1, wallClockMinutes: 10 },
  runRemainingUsd: 100,
  spentMicroUsd: 0,
  spentWallClockMinutes: 0,
  grantedExtensionMicroUsd: 0,
  overrun: false,
};

test('reservation: an attempt and its verification reserve fit exactly at the task cap and fail one micro-dollar above it', () => {
  assert.deepEqual(checkReservation({ ...RES, spentMicroUsd: toMicroUsd(14) }), { ok: true });
  const over = checkReservation({ ...RES, spentMicroUsd: toMicroUsd(14) + 1 });
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.reason, 'task-budget');
  assert.equal(over.ok === false && over.shortfallUsd, 0.000001);
});

test('reservation: the verification reserve is reserved on top of the agent cap, in cost and wall-clock', () => {
  const noReserve = { ...RES, verificationReserve: { costUsd: 0, wallClockMinutes: 0 } };
  assert.deepEqual(checkReservation({ ...noReserve, spentMicroUsd: toMicroUsd(15) }), { ok: true });
  assert.equal((checkReservation({ ...RES, spentMicroUsd: toMicroUsd(15) }) as { reason: string }).reason, 'task-budget');
  assert.deepEqual(checkReservation({ ...noReserve, spentWallClockMinutes: 210 }), { ok: true });
  assert.equal((checkReservation({ ...RES, spentWallClockMinutes: 210 }) as { reason: string }).reason, 'wall-clock');
  assert.equal((checkReservation({ ...RES, runRemainingUsd: 5.5 }) as { reason: string }).reason, 'run-budget');
});

test('reservation: granted extensions raise only the task cap', () => {
  assert.deepEqual(
    checkReservation({ ...RES, spentMicroUsd: toMicroUsd(17), grantedExtensionMicroUsd: toMicroUsd(3) }),
    { ok: true },
  );
  const run = checkReservation({ ...RES, runRemainingUsd: 4, grantedExtensionMicroUsd: toMicroUsd(50) });
  assert.equal(run.ok === false && run.reason, 'run-budget');
});

test('reservation: attempts, overrun and wall-clock each bind, and are checked before the task cap', () => {
  assert.equal((checkReservation({ ...RES, attemptNumber: 4 }) as { reason: string }).reason, 'attempts-exhausted');
  assert.equal((checkReservation({ ...RES, overrun: true }) as { reason: string }).reason, 'overrun');
  assert.equal((checkReservation({ ...RES, spentWallClockMinutes: 201 }) as { reason: string }).reason, 'wall-clock');
  assert.deepEqual(checkReservation({ ...RES, spentWallClockMinutes: 200 }), { ok: true });
  // maxAttempts wins over every budget cause.
  assert.equal((checkReservation({ ...RES, attemptNumber: 4, overrun: true, runRemainingUsd: 0 }) as { reason: string }).reason,
    'attempts-exhausted');
});

test('soft threshold: crossed once, when spending moves from below to at-or-above it', () => {
  assert.equal(crossesSoftThreshold(toMicroUsd(11), toMicroUsd(12), 12), true);
  assert.equal(crossesSoftThreshold(toMicroUsd(12), toMicroUsd(13), 12), false);
  assert.equal(crossesSoftThreshold(toMicroUsd(1), toMicroUsd(2), 12), false);
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

test('approvals: exactly budget-extension and publish-change exist, each deciding approve or reject', () => {
  assert.deepEqual([...APPROVAL_KINDS], ['budget-extension', 'publish-change']);
  assert.deepEqual(ALLOWED_DECISIONS['budget-extension'], ['approve', 'reject']);
  assert.deepEqual(ALLOWED_DECISIONS['publish-change'], ['approve', 'reject']);
  assert.equal(approvalRequestId('asep-task-t', 3), 'asep-task-t:3');
});

test('approvals: the validator rejects unknown requests, disallowed decisions, bad extensions and conflicts', () => {
  const open = { approvalRequestId: 'w:1', kind: 'budget-extension' as const, pendingDecisionId: null };
  const msg = { type: 'approvalDecisionReceived' as const, decisionId: 'd1', approvalRequestId: 'w:1', decision: 'approve' as const, extensionUsd: 5, principalId: 'p' };
  const max = 50;
  assert.deepEqual(validateApprovalDecision(open, [], msg, max), { accepted: true, duplicate: false, reason: null });
  assert.equal(validateApprovalDecision(null, [], msg, max).reason, 'unknown-approval');
  assert.equal(validateApprovalDecision(open, [], { ...msg, approvalRequestId: 'w:2' }, max).reason, 'unknown-approval');
  assert.equal(validateApprovalDecision(open, [], { ...msg, decision: 'request-repair' as never }, max).reason, 'decision-not-allowed');
  assert.equal(validateApprovalDecision(open, [], { ...msg, extensionUsd: null }, max).reason, 'extension-out-of-bounds');
  assert.equal(validateApprovalDecision(open, [], { ...msg, extensionUsd: 51 }, max).reason, 'extension-out-of-bounds');
  assert.equal(validateApprovalDecision(open, [], { ...msg, extensionUsd: 0 }, max).reason, 'extension-out-of-bounds');
  assert.deepEqual(validateApprovalDecision(open, [], { ...msg, decision: 'reject', extensionUsd: null }, max),
    { accepted: true, duplicate: false, reason: null });
  const publish = { ...open, kind: 'publish-change' as const };
  assert.equal(validateApprovalDecision(publish, [], msg, max).reason, 'extension-out-of-bounds');
  assert.deepEqual(validateApprovalDecision(open, ['d1'], msg, max), { accepted: true, duplicate: true, reason: null });
  assert.equal(validateApprovalDecision({ ...open, pendingDecisionId: 'd0' }, ['d0'], msg, max).reason, 'decision-conflict');
  // Without a policy bound no extension amount is well formed.
  assert.equal(validateApprovalDecision(open, [], msg, null).reason, 'extension-out-of-bounds');
});

// ---------------------------------------------------------------------------
// Assurance outcome validation
// ---------------------------------------------------------------------------

const CTX = { round: 1, resultSha: shaFor(1) };

test('assurance: the four outcome kinds validate', () => {
  assert.equal(parseAssuranceOutcome(proceed(), CTX).ok, true);
  assert.equal(parseAssuranceOutcome({ kind: 'ESCALATE', adjudicationId: 'a', reason: 'reviewer-unavailable', prBodySectionRef: ref('x') }, CTX).ok, true);
  assert.equal(parseAssuranceOutcome({ kind: 'REPAIR', adjudicationId: 'a', repairOrderRef: ref('r'), nextRound: 2, repairBaseSha: shaFor(1) }, CTX).ok, true);
  assert.equal(parseAssuranceOutcome({ kind: 'BLOCK', adjudicationId: 'a', reason: 'secret-in-diff' }, CTX).ok, true);
});

test('assurance: anything outside the contract is a violation', () => {
  const bad: readonly unknown[] = [
    null,
    'PROCEED',
    { kind: 'APPROVED', adjudicationId: 'a' },
    { kind: 'PROCEED', prBodySectionRef: ref('x') },
    { kind: 'PROCEED', adjudicationId: '', prBodySectionRef: ref('x') },
    { kind: 'PROCEED', adjudicationId: 'a' },
    { kind: 'PROCEED', adjudicationId: 'a', prBodySectionRef: { artifactId: 'x', sha256: 'nothex', kind: 'k' } },
    { kind: 'ESCALATE', adjudicationId: 'a', prBodySectionRef: ref('x') },
    { kind: 'REPAIR', adjudicationId: 'a', repairOrderRef: ref('r'), nextRound: 3, repairBaseSha: shaFor(1) },
    { kind: 'REPAIR', adjudicationId: 'a', repairOrderRef: ref('r'), nextRound: 2, repairBaseSha: shaFor(9) },
    { kind: 'REPAIR', adjudicationId: 'a', nextRound: 2, repairBaseSha: shaFor(1) },
    { kind: 'BLOCK', adjudicationId: 'a' },
  ];
  for (const raw of bad) assert.equal(parseAssuranceOutcome(raw, CTX).ok, false, JSON.stringify(raw));
});

// ---------------------------------------------------------------------------
// Task reducer: happy path and admission
// ---------------------------------------------------------------------------

test('task: an R0 task runs one attempt to review handoff with one push and one PR', () => {
  const trace = runTaskSequentially(baseInput(), scripted());
  assert.deepEqual(requestKinds(trace.commands), [
    'admitTask', 'ensureAttempt', 'acquireLease', 'prepareWorkspace', 'storeAttemptInputs', 'runAgent',
    'inspectWorkspace', 'runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound',
    'publishBranch', 'upsertPullRequest',
  ]);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assert.equal(trace.summary.prNumber, 7);
  assert.deepEqual(outcomes(trace), [[1, 'proceeded']]);
  assert.deepEqual(effectsOf(trace.commands, 'projectTaskState').map((p) => p.status),
    ['EXECUTING', 'VERIFYING', 'WAITING_FOR_HUMAN_REVIEW']);
  assert.equal(effectsOf(trace.commands, 'cleanupWorkspace').length, 1);
  assert.equal(effectsOf(trace.commands, 'releaseLease').length, 1);
  const commit = requests(trace.commands).find((r) => r.kind === 'commitAttempt');
  assert.equal(commit?.kind === 'commitAttempt' && commit.expectedHeadSha, TASK_BASE);
  assertLegalProjections(trace);
});

test('task: a deferred admission blocks before any attempt exists', () => {
  const trace = runTaskSequentially(baseInput({ risk: 'R3' }), scripted({
    admitTask: () => ({ kind: 'admitTask', admitted: false, reason: 'risk-deferred' }),
  }));
  assert.deepEqual(requestKinds(trace.commands), ['admitTask']);
  assert.equal(trace.summary.outcome, 'BLOCKED');
  assert.deepEqual(outcomes(trace), []);
  assertLegalProjections(trace);
});

test('task: the workflow id is derived from the task id', () => {
  assert.equal(taskWorkflowId('t-9' as TaskId), 'asep-task-t-9');
  assert.equal(startTask(baseInput()).state.workflowId, 'asep-task-task-1');
});

// ---------------------------------------------------------------------------
// Agent failure and worker death
// ---------------------------------------------------------------------------

test('agent failure: worker death during the agent replaces the attempt before any push', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: (_r, n) => (n === 1 ? { kind: 'activityFailed', failureClass: 'workflow-recovery-failure', timedOut: true } : undefined),
  }));
  const ensured = requests(trace.commands).filter((r) => r.kind === 'ensureAttempt');
  assert.deepEqual(ensured.map((r) => r.kind === 'ensureAttempt' && [r.attemptNumber, r.attemptKind, r.baseSha]),
    [[1, 'initial', TASK_BASE], [2, 'retry', TASK_BASE]]);
  assert.deepEqual(outcomes(trace), [[1, 'failed'], [2, 'proceeded']]);
  const abandon = effectsOf(trace.commands, 'reapContainers').map((e) => e.attemptNumber);
  assert.deepEqual(abandon, [1]);
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1));
  assert.ok(effectsOf(trace.commands, 'releaseLease').some((e) => e.attemptNumber === 1));
  const recovered = effectsOf(trace.commands, 'emitRunEvent').filter((e) => e.eventType === 'workflow.recovered');
  assert.deepEqual(recovered.map((e) => e.detail['recoveryKind']), ['attempt-replaced']);
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'upsertPullRequest').length, 1);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

test('agent failure: an attempt that died without a usage report is charged its full reservation', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: (_r, n) => (n === 1 ? { kind: 'activityFailed', failureClass: 'environment', timedOut: true } : undefined),
  }));
  const usage = effectsOf(trace.commands, 'recordUsage');
  // Attempt 2 also ran verification, so it is charged the verification reserve on top of its agent cost.
  assert.deepEqual(usage.map((u) => [u.attemptNumber, u.chargedCostUsd, u.reportedCostUsd, u.verificationReserveUsd]),
    [[1, 5, null, 0], [2, 2, 1, 1]]);
  assert.equal(trace.summary.chargedCostUsd, 7);
});

test('agent failure: a non-replaceable failure class ends the task without a new attempt', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'FAILED', reportedCostUsd: 1, reportedToolCalls: 3, wallClockMs: 1000, failureClass: 'policy-violation' }),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 1);
  assert.deepEqual(outcomes(trace), [[1, 'failed']]);
  assert.equal(trace.summary.outcome, 'FAILED');
});

test('agent failure: once a push may exist, a failure is terminal and no attempt replaces it', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    upsertPullRequest: () => ({ kind: 'activityFailed', failureClass: 'provider', timedOut: false }),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 1);
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.deepEqual(outcomes(trace), [[1, 'failed']]);
});

test('agent failure: replacement stops at maxAttempts', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'activityFailed', failureClass: 'provider', timedOut: false }),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 3);
  assert.deepEqual(outcomes(trace), [[1, 'failed'], [2, 'failed'], [3, 'failed']]);
  assert.equal(trace.summary.outcome, 'FAILED');
});

test('an overstep found by inspection is a policy violation and is not retried', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    inspectWorkspace: () => ({ kind: 'inspectWorkspace', overstep: true }),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 1);
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((q) => q.reason === 'policy-violation'));
});

// ---------------------------------------------------------------------------
// Verification stop
// ---------------------------------------------------------------------------

for (const verdict of ['FAIL', 'ERROR'] as const) {
  test(`a ${verdict} verification stops the task: no assurance round, no approval, no push`, () => {
    const trace = runTaskSequentially(baseInput({ governance: governance({ publicationApprovalRequired: true }) }),
      scripted({ runVerification: () => ({ kind: 'runVerification', verdict }) }));
    const kinds = requestKinds(trace.commands);
    for (const k of ['assuranceRound', 'openApprovalRequest', 'commitAttempt', 'publishBranch'] as const) {
      assert.ok(!kinds.includes(k), `${k} must not run after a verification stop`);
    }
    const recorded = effectsOf(trace.commands, 'recordAttemptOutcome');
    assert.deepEqual(recorded.map((o) => [o.terminal, o.verificationVerdict]), [['verification-failed', verdict]]);
    assert.equal(trace.summary.outcome, 'FAILED');
    assertLegalProjections(trace);
  });
}

test('a verification activity that gives up is a verification stop with verdict ERROR', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runVerification: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: false }),
  }));
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.terminal, o.verificationVerdict]),
    [['verification-failed', 'ERROR']]);
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 1);
  assert.equal(trace.summary.outcome, 'FAILED');
});

// ---------------------------------------------------------------------------
// Assurance outcome routing
// ---------------------------------------------------------------------------

test('assurance routing: ESCALATE publishes a flagged PR and hands off to human review', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    assuranceRound: () => ({ kind: 'assuranceRound', outcome: { kind: 'ESCALATE', adjudicationId: 'adj-e', reason: 'reviewer-unavailable', prBodySectionRef: ref('esc') } }),
  }));
  const pr = requests(trace.commands).find((r) => r.kind === 'upsertPullRequest');
  assert.equal(pr?.kind === 'upsertPullRequest' && pr.flagged, true);
  assert.deepEqual(pr?.kind === 'upsertPullRequest' && pr.prBodySectionRef, ref('esc'));
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.terminal, o.adjudicationId]),
    [['escalated', 'adj-e']]);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('assurance routing: PROCEED publishes an unflagged PR carrying the assurance section', () => {
  const trace = runTaskSequentially(baseInput(), scripted());
  const pr = requests(trace.commands).find((r) => r.kind === 'upsertPullRequest');
  assert.equal(pr?.kind === 'upsertPullRequest' && pr.flagged, false);
  assert.deepEqual(pr?.kind === 'upsertPullRequest' && pr.prBodySectionRef, ref('pr-adj-1'));
});

test('assurance routing: BLOCK publishes nothing and blocks the task', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    assuranceRound: () => ({ kind: 'assuranceRound', outcome: { kind: 'BLOCK', adjudicationId: 'adj-b', reason: 'secret-in-diff' } }),
  }));
  const kinds = requestKinds(trace.commands);
  assert.ok(!kinds.includes('publishBranch') && !kinds.includes('upsertPullRequest'));
  assert.deepEqual(outcomes(trace), [[1, 'blocked']]);
  assert.ok(effectsOf(trace.commands, 'reapContainers').some((e) => e.attemptNumber === 1));
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1));
  assert.equal(trace.summary.outcome, 'BLOCKED');
  assertLegalProjections(trace);
});

test('assurance routing: REPAIR starts a repair attempt at repairBaseSha with the next round and prior adjudication', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    assuranceRound: (r, n) => (n === 1
      ? { kind: 'assuranceRound', outcome: { kind: 'REPAIR', adjudicationId: 'adj-r1', repairOrderRef: ref('ro-1'), nextRound: 2, repairBaseSha: shaFor(1) } }
      : undefined),
  }));
  const all = requests(trace.commands);
  const ensure2 = all.find((r) => r.kind === 'ensureAttempt' && r.attemptNumber === 2);
  assert.deepEqual(ensure2, {
    kind: 'ensureAttempt', attemptNumber: 2, attemptKind: 'repair', baseSha: shaFor(1),
    parentAttemptNumber: 1, repairOrderRef: ref('ro-1'),
  });
  const prepare2 = all.find((r) => r.kind === 'prepareWorkspace' && r.attemptNumber === 2);
  assert.equal(prepare2?.kind === 'prepareWorkspace' && prepare2.baseSha, shaFor(1));
  const store2 = all.find((r) => r.kind === 'storeAttemptInputs' && r.attemptNumber === 2);
  assert.deepEqual(store2?.kind === 'storeAttemptInputs' && store2.repairOrderRef, ref('ro-1'));
  const commit2 = all.find((r) => r.kind === 'commitAttempt' && r.attemptNumber === 2);
  assert.equal(commit2?.kind === 'commitAttempt' && commit2.expectedHeadSha, shaFor(1));
  const rounds = all.flatMap((r) => (r.kind === 'assuranceRound' ? [r.request] : []));
  assert.deepEqual(rounds.map((r) => [r.attemptNumber, r.round, r.priorAdjudicationId, r.taskBaseSha]),
    [[1, 1, null, TASK_BASE], [2, 2, 'adj-r1', TASK_BASE]]);
  assert.notEqual(rounds[0]!.idempotencyKey, rounds[1]!.idempotencyKey);
  assert.deepEqual(outcomes(trace), [[1, 'repair-requested'], [2, 'proceeded']]);
  // The parent's workspace is disposed only after the repair workspace exists.
  const prepared2At = indexOfCommand(trace.commands, (c) => c.type === 'request' && c.request.kind === 'storeAttemptInputs' && c.request.attemptNumber === 2);
  const parentCleanupAt = indexOfCommand(trace.commands, (c) => c.type === 'effect' && c.effect.kind === 'cleanupWorkspace' && c.effect.attemptNumber === 1);
  assert.ok(parentCleanupAt > 0 && parentCleanupAt < prepared2At, 'parent cleanup between repair prepare and inputs');
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'publishBranch').length, 1);
  assert.equal(effectsOf(trace.commands, 'projectTaskState').filter((p) => p.status === 'EXECUTING').length, 1,
    'the task stays VERIFYING through the repair attempt');
  assertLegalProjections(trace);
});

test('assurance routing: REPAIR without attempt capacity fails the task and publishes nothing', () => {
  const trace = runTaskSequentially(baseInput({
    taskBudget: { maxAttempts: 1, maxCostUsd: 20, softCostUsd: 12, maxWallClockMinutes: 240 },
  }), scripted({
    assuranceRound: () => ({ kind: 'assuranceRound', outcome: { kind: 'REPAIR', adjudicationId: 'adj-r', repairOrderRef: ref('ro'), nextRound: 2, repairBaseSha: shaFor(1) } }),
  }));
  assert.ok(!requestKinds(trace.commands).includes('publishBranch'));
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.equal(trace.summary.reason, 'repair-capacity-exhausted');
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1));
  assert.ok(effectsOf(trace.commands, 'releaseLease').some((e) => e.attemptNumber === 1));
  assertLegalProjections(trace);
});

for (const [name, outcome] of [
  ['an unknown kind', { kind: 'APPROVED', adjudicationId: 'x' }],
  ['REPAIR at the wrong base', { kind: 'REPAIR', adjudicationId: 'x', repairOrderRef: ref('r'), nextRound: 2, repairBaseSha: shaFor(5) }],
  ['REPAIR with a skipped round', { kind: 'REPAIR', adjudicationId: 'x', repairOrderRef: ref('r'), nextRound: 4, repairBaseSha: shaFor(1) }],
] as const) {
  test(`assurance routing: ${name} is a contract violation: audited, task FAILED, nothing published`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ assuranceRound: () => ({ kind: 'assuranceRound', outcome }) }));
    assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'review-slot.contract-violation'));
    assert.ok(!requestKinds(trace.commands).includes('publishBranch'));
    assert.deepEqual(outcomes(trace), [[1, 'failed']]);
    assert.equal(trace.summary.outcome, 'FAILED');
  });
}

test('the assurance round carries the declared completion of the attempt', () => {
  const trace = runTaskSequentially(baseInput(), scripted());
  const round = requests(trace.commands).find((r) => r.kind === 'assuranceRound');
  assert.equal(round?.kind === 'assuranceRound' && round.request.declaredComplete, true);
});

// ---------------------------------------------------------------------------
// Budgets and approvals
// ---------------------------------------------------------------------------

function idleScript(...events: readonly ((timers: readonly string[]) => TaskEvent)[]) {
  let i = 0;
  return (_s: unknown, timers: readonly string[]): TaskEvent => {
    const next = events[i++];
    if (!next) throw new Error(`idle script exhausted (timers: ${timers.join(',')})`);
    return next(timers);
  };
}

// The first attempt needs 5 (agent cap) + 1 (verification reserve) against a task cap of 4.
const tightBudget = baseInput({ taskBudget: { maxAttempts: 3, maxCostUsd: 4, softCostUsd: 3, maxWallClockMinutes: 240 } });

test('budget extension: a failed task-cap reservation opens a budget-extension approval; approval continues the task', () => {
  const trace = runTaskSequentially(tightBudget, scripted({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: true, decision: 'approve', extensionUsd: 2 }),
  }, {
    whenIdle: idleScript(() => ({ type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'approve', extensionUsd: 2, principalId: 'human-1' })),
  }));
  const open = requests(trace.commands).find((r) => r.kind === 'openApprovalRequest');
  assert.deepEqual(open, {
    kind: 'openApprovalRequest', approvalRequestId: 'asep-task-task-1:1', approvalKind: 'budget-extension',
    attemptNumber: null, ttlSeconds: 3600, shortfallUsd: 2,
  });
  assert.deepEqual(effectsOf(trace.commands, 'recordExtension'), [{ kind: 'recordExtension', approvalRequestId: 'asep-task-task-1:1', extensionUsd: 2 }]);
  assert.ok(effectsOf(trace.commands, 'cancelTimer').some((t) => t.timerId === 'approval:asep-task-task-1:1'));
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assert.ok(effectsOf(trace.commands, 'projectTaskState').some((p) => p.status === 'WAITING_FOR_APPROVAL'));
  assertLegalProjections(trace);
});

test('budget extension: a rejected extension ends the task BUDGET_EXHAUSTED', () => {
  const trace = runTaskSequentially(tightBudget, scripted({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: true, decision: 'reject', extensionUsd: null }),
  }, {
    whenIdle: idleScript(() => ({ type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'reject', extensionUsd: null, principalId: 'h' })),
  }));
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.ok(!requestKinds(trace.commands).includes('ensureAttempt'));
  assertLegalProjections(trace);
});

test('approval expiry is a timer; it expires the request and follows the reject path', () => {
  const trace = runTaskSequentially(tightBudget, scripted({}, {
    whenIdle: idleScript((timers) => ({ type: 'timerFired', timerId: timers[0]! })),
  }));
  assert.deepEqual(effectsOf(trace.commands, 'startTimer'), [{ kind: 'startTimer', timerId: 'approval:asep-task-task-1:1', seconds: 3600 }]);
  assert.deepEqual(effectsOf(trace.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
  assert.ok(effectsOf(trace.commands, 'emitRunEvent').some((e) => e.eventType === 'approval.expired'));
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
});

test('a decision that PostgreSQL does not confirm never releases the gate', () => {
  const trace = runTaskSequentially(tightBudget, scripted({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: false, decision: null, extensionUsd: null }),
  }, {
    whenIdle: idleScript(
      () => ({ type: 'approvalDecisionReceived', decisionId: 'forged', approvalRequestId: 'asep-task-task-1:1', decision: 'approve', extensionUsd: 2, principalId: 'x' }),
      (timers) => ({ type: 'timerFired', timerId: timers[0]! }),
    ),
  }));
  assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'approval.unverified'));
  assert.deepEqual(effectsOf(trace.commands, 'recordExtension'), []);
  assert.ok(!requestKinds(trace.commands).includes('ensureAttempt'));
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
});

test('budget extension: while maxBudgetExtensionUsd is unset no approval is offered and the task ends BUDGET_EXHAUSTED', () => {
  const trace = runTaskSequentially({ ...tightBudget, policy: policy({ maxBudgetExtensionUsd: null }) }, scripted());
  assert.ok(!requestKinds(trace.commands).includes('openApprovalRequest'));
  assert.ok(!requestKinds(trace.commands).includes('ensureAttempt'));
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'task-budget');
  assertLegalProjections(trace);
});

test('a run-budget shortfall cannot be extended per task: BUDGET_EXHAUSTED without an approval', () => {
  const trace = runTaskSequentially(baseInput({ runRemainingUsd: 3 }), scripted());
  assert.ok(!requestKinds(trace.commands).includes('openApprovalRequest'));
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assertLegalProjections(trace);
});

test('crossing the soft threshold emits one threshold event and work continues', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: (_r, n) => (n < 3
      ? { kind: 'runAgent', status: 'FAILED', reportedCostUsd: 5, reportedToolCalls: 5, wallClockMs: 1000, failureClass: 'provider' }
      : { kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 2, reportedToolCalls: 5, wallClockMs: 1000, failureClass: null }),
  }));
  // Spending runs 5, 10, 13 (the third attempt also pays its verification reserve): one crossing of 12.
  const crossed = effectsOf(trace.commands, 'emitRunEvent').filter((e) => e.eventType === 'budget.threshold_crossed');
  assert.deepEqual(crossed.map((e) => [e.detail['thresholdKind'], e.detail['budgetScope']]), [['soft', 'task']]);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('with publication approval required, no push happens before an approve', () => {
  const input = baseInput({ governance: governance({ publicationApprovalRequired: true, approvalTtlSeconds: 600 }) });
  const approved = runTaskSequentially(input, scripted({}, {
    whenIdle: idleScript(() => ({ type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'approve', extensionUsd: null, principalId: 'h' })),
  }));
  const kinds = requestKinds(approved.commands);
  assert.ok(kinds.indexOf('openApprovalRequest') < kinds.indexOf('publishBranch'));
  assert.ok(kinds.indexOf('verifyApprovalDecision') < kinds.indexOf('publishBranch'));
  assert.equal(approved.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(approved);

  const rejected = runTaskSequentially(input, scripted({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: true, decision: 'reject', extensionUsd: null }),
  }, {
    whenIdle: idleScript(() => ({ type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'reject', extensionUsd: null, principalId: 'h' })),
  }));
  assert.ok(!requestKinds(rejected.commands).includes('publishBranch'));
  assert.deepEqual(outcomes(rejected), [[1, 'failed']]);
  assert.equal(rejected.summary.outcome, 'BLOCKED');
  assertLegalProjections(rejected);
});

test('approval decisions are validated before any state change; duplicates return the original receipt', () => {
  const input = baseInput({ governance: governance({ publicationApprovalRequired: true, approvalTtlSeconds: 600 }) });
  const trace = runTaskSequentially(input, scripted({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: true, decision: 'approve', extensionUsd: null }),
  }, {
    whenIdle: idleScript(
      () => ({ type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:9', decision: 'approve', extensionUsd: null, principalId: 'h' }),
      () => ({ type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'approve', extensionUsd: null, principalId: 'h' }),
    ),
    messagesDuring: (request) => (request.kind === 'verifyApprovalDecision'
      ? [
          { type: 'approvalDecisionReceived', decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'approve', extensionUsd: null, principalId: 'h' },
          { type: 'approvalDecisionReceived', decisionId: 'd2', approvalRequestId: 'asep-task-task-1:1', decision: 'reject', extensionUsd: null, principalId: 'h2' },
        ]
      : []),
  }));
  assert.deepEqual(trace.receipts.map((r) => [r.accepted, r.duplicate, r.reason]), [
    [false, false, 'unknown-approval'],
    [true, false, null],
    [true, true, null],
    [false, false, 'decision-conflict'],
  ]);
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'verifyApprovalDecision').length, 1);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

// ---------------------------------------------------------------------------
// Pause, resume, cancel
// ---------------------------------------------------------------------------

const pause = (requestId = 'p1') => ({ type: 'pauseRequested' as const, requestId, principalId: 'op' });
const resume = (requestId = 'r1') => ({ type: 'resumeRequested' as const, requestId, principalId: 'op' });
const cancel = (requestId = 'c1') => ({ type: 'cancelRequested' as const, requestId, principalId: 'op' });

test('pause takes effect at the next boundary; resume continues from the recorded phase', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'runAgent' ? [pause('p1'), pause('p1'), pause('p2')] : []),
    whenIdle: idleScript(() => resume('r1')),
  }));
  assert.deepEqual(trace.receipts.map((r) => [r.accepted, r.duplicate, r.reason]), [
    [true, false, null],
    [true, true, null],
    [false, false, 'already-paused'],
    [true, false, null],
  ]);
  const kinds = requestKinds(trace.commands);
  assert.equal(kinds.filter((k) => k === 'inspectWorkspace').length, 1);
  const pausedAt = indexOfCommand(trace.commands, (c) => c.type === 'effect' && c.effect.kind === 'projectTaskState' && c.effect.status === 'PAUSED');
  const inspectAt = indexOfCommand(trace.commands, (c) => c.type === 'request' && c.request.kind === 'inspectWorkspace');
  assert.ok(pausedAt > 0 && pausedAt < inspectAt, 'the next phase starts only after resume');
  assert.deepEqual(effectsOf(trace.commands, 'recordControl').map((c) => [c.control, c.requestId]), [['pause', 'p1'], ['resume', 'r1']]);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

test('resume of a task that is not paused is refused', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'runAgent' ? [resume('r1')] : []),
  }));
  assert.deepEqual(trace.receipts.map((r) => r.reason), ['not-paused']);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('a pause that outlives maxPauseHours blocks the task and cleans up', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'inspectWorkspace' ? [pause()] : []),
    whenIdle: idleScript((timers) => ({ type: 'timerFired', timerId: timers[0]! })),
  }));
  assert.deepEqual(effectsOf(trace.commands, 'startTimer').map((t) => [t.timerId, t.seconds]), [['pause:1', 72 * 3600]]);
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.ok(effectsOf(trace.commands, 'reapContainers').some((e) => e.attemptNumber === 1));
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1));
  assert.ok(effectsOf(trace.commands, 'releaseLease').some((e) => e.attemptNumber === 1));
  assert.equal(trace.summary.outcome, 'BLOCKED');
  assert.equal(trace.summary.reason, 'pause-timeout');
  assertLegalProjections(trace);
});

test('cancel during the agent aborts it, reaps, quarantines, releases and ignores the late result', () => {
  let last = startTask(baseInput());
  let state = last.state;
  const drive = (event: TaskEvent) => {
    const d = decideTask(state, event);
    state = d.state;
    return d;
  };
  // Walk to the agent request with happy-path results.
  let seq = -1;
  for (;;) {
    const request = last.commands.find((c): c is Extract<TaskCommand, { type: 'request' }> => c.type === 'request');
    assert.ok(request, 'expected a request');
    seq = request.seq;
    if (request.request.kind === 'runAgent') break;
    const result = happyAnswer(request.request);
    assert.ok(result.kind !== 'activityFailed');
    last = drive({ type: 'result', seq, result });
  }
  const cancelled = drive(cancel());
  assert.equal(cancelled.abortInFlight, true);
  assert.deepEqual(cancelled.receipt, { accepted: true, duplicate: false, reason: null });
  const kinds = cancelled.commands.map((c) => (c.type === 'effect' ? c.effect.kind : c.type));
  for (const k of ['recordControl', 'reapContainers', 'quarantineWorkspace', 'releaseLease', 'recordAttemptOutcome'] as const) {
    assert.ok(kinds.includes(k), k);
  }
  assert.equal(cancelled.commands.at(-1)?.type, 'complete');
  assert.equal(state.outcome, 'CANCELLED');
  const late = drive({ type: 'result', seq, result: { kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 1, reportedToolCalls: 1, wallClockMs: 1, failureClass: null } });
  assert.deepEqual(late.commands, []);
  const again = drive(cancel('c2'));
  assert.equal(again.receipt?.reason, 'closed');
});

test('cancel during commit finishes the commit section, then cancels without assurance or push', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'commitAttempt' ? [cancel()] : []),
  }));
  const kinds = requestKinds(trace.commands);
  assert.ok(kinds.includes('persistEvidence'));
  assert.ok(!kinds.includes('assuranceRound') && !kinds.includes('publishBranch'));
  assert.equal(trace.aborts, 0);
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assertLegalProjections(trace);
});

test('cancel during the push finishes the PR, leaves it open and audits it', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'publishBranch' ? [cancel()] : []),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'upsertPullRequest').length, 1);
  assert.equal(trace.aborts, 0);
  const audit = effectsOf(trace.commands, 'audit').find((a) => a.action === 'workflow.cancel.after-publication');
  assert.equal(audit?.detail['prNumber'], 7);
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assert.equal(trace.summary.prNumber, 7);
  assertLegalProjections(trace);
});

test('cancel before any attempt leaves no attempt effects', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'admitTask' ? [cancel()] : []),
  }));
  assert.deepEqual(requestKinds(trace.commands), ['admitTask']);
  assert.deepEqual(outcomes(trace), []);
  assert.equal(effectsOf(trace.commands, 'releaseLease').length, 0);
  assert.equal(trace.summary.outcome, 'CANCELLED');
});

test('cancel while waiting for an approval cancels the approval request', () => {
  const trace = runTaskSequentially(tightBudget, scripted({}, { whenIdle: idleScript(() => cancel()) }));
  assert.deepEqual(effectsOf(trace.commands, 'cancelApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assertLegalProjections(trace);
});

// ---------------------------------------------------------------------------
// Agent outcome table
// ---------------------------------------------------------------------------

function requestsOfAttempt(trace: TaskTrace, attemptNumber: number): TaskRequestKind[] {
  return requests(trace.commands).flatMap((r) => {
    const n = r.kind === 'assuranceRound' ? r.request.attemptNumber : 'attemptNumber' in r ? r.attemptNumber : null;
    return n === attemptNumber ? [r.kind] : [];
  });
}

function ensured(trace: TaskTrace) {
  return requests(trace.commands).flatMap((r) => (r.kind === 'ensureAttempt' ? [r] : []));
}

const NEVER_AFTER_EXHAUSTION = ['runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound', 'publishBranch', 'upsertPullRequest'] as const;

test('agent outcome: AGENT_DONE having spent exactly its cap gets every check, the commit, the assurance round and the PR', () => {
  // Task cap 6 = agent cap 5 + verification reserve 1: the agent spends all of its own share.
  const trace = runTaskSequentially(baseInput({ taskBudget: { maxAttempts: 1, maxCostUsd: 6, softCostUsd: 6, maxWallClockMinutes: 240 } }), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 5, reportedToolCalls: 50, wallClockMs: 1000, failureClass: null }),
  }));
  assert.deepEqual(requestsOfAttempt(trace, 1), [
    'ensureAttempt', 'acquireLease', 'prepareWorkspace', 'storeAttemptInputs', 'runAgent', 'inspectWorkspace',
    'runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound', 'publishBranch', 'upsertPullRequest',
  ]);
  assert.deepEqual(effectsOf(trace.commands, 'recordOverrun'), []);
  assert.deepEqual(effectsOf(trace.commands, 'recordUsage').map((u) => [u.chargedCostUsd, u.verificationReserveUsd]), [[6, 1]]);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('agent outcome: a cap stop is inspected only; the attempt ends budget-exhausted and a retry with a fresh reservation continues', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: (_r, n) => (n === 1
      ? { kind: 'runAgent', status: 'BUDGET_EXHAUSTED', reportedCostUsd: 5, reportedToolCalls: 20, wallClockMs: 1000, failureClass: null }
      : undefined),
  }));
  assert.deepEqual(requestsOfAttempt(trace, 1), ['ensureAttempt', 'acquireLease', 'prepareWorkspace', 'storeAttemptInputs', 'runAgent', 'inspectWorkspace']);
  assert.deepEqual(outcomes(trace), [[1, 'budget-exhausted'], [2, 'proceeded']]);
  assert.deepEqual(ensured(trace).map((r) => [r.attemptNumber, r.attemptKind, r.baseSha]), [[1, 'initial', TASK_BASE], [2, 'retry', TASK_BASE]]);
  assert.deepEqual(effectsOf(trace.commands, 'recordUsage').map((u) => [u.attemptNumber, u.chargedCostUsd, u.verificationReserveUsd]),
    [[1, 5, 0], [2, 2, 1]]);
  assert.ok(effectsOf(trace.commands, 'reapContainers').some((e) => e.attemptNumber === 1), 'attempt 1 reaped');
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1 && e.reason === 'budget-exhausted'), 'attempt 1 quarantined as budget-exhausted');
  assert.deepEqual(effectsOf(trace.commands, 'recordOverrun'), []);
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'upsertPullRequest').length, 1);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

test('agent outcome: a cap stop with no room for a fresh reservation ends the task BUDGET_EXHAUSTED', () => {
  // After the stop 5 is spent; a retry needs 5 + 5 + 1 against a cap of 10, and no extension bound is set.
  const trace = runTaskSequentially(baseInput({
    taskBudget: { maxAttempts: 3, maxCostUsd: 10, softCostUsd: 9, maxWallClockMinutes: 240 },
    policy: policy({ maxBudgetExtensionUsd: null }),
  }), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'BUDGET_EXHAUSTED', reportedCostUsd: 5, reportedToolCalls: 20, wallClockMs: 1000, failureClass: null }),
  }));
  assert.deepEqual(outcomes(trace), [[1, 'budget-exhausted']]);
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'task-budget');
  assertLegalProjections(trace);
});

for (const [name, answer, overrun] of [
  ['reported cost above the cap', { status: 'AGENT_DONE', reportedCostUsd: 7, reportedToolCalls: 10 }, { overrunUsd: 2, overrunToolCalls: 0 }],
  ['reported tool calls above the cap', { status: 'AGENT_DONE', reportedCostUsd: 1, reportedToolCalls: 53 }, { overrunUsd: 0, overrunToolCalls: 3 }],
  ['a replaceable agent failure that also overran its cost', { status: 'FAILED', reportedCostUsd: 7, reportedToolCalls: 10 }, { overrunUsd: 2, overrunToolCalls: 0 }],
] as const) {
  test(`agent outcome: ${name} is an overrun: recorded and audited, never verified or published, and the task ends BUDGET_EXHAUSTED`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      runAgent: () => ({ kind: 'runAgent', wallClockMs: 1000, failureClass: answer.status === 'FAILED' ? 'provider' : null, ...answer }),
    }));
    const kinds = requestKinds(trace.commands);
    assert.ok(kinds.includes('inspectWorkspace'), 'the overrun attempt is inspected');
    for (const k of NEVER_AFTER_EXHAUSTION) assert.ok(!kinds.includes(k), `${k} after an overrun`);
    assert.deepEqual(effectsOf(trace.commands, 'recordOverrun'), [{ kind: 'recordOverrun', attemptNumber: 1, ...overrun }]);
    assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'budget.overrun' && a.detail['attemptNumber'] === 1), 'overrun incident audited');
    assert.deepEqual(outcomes(trace), [[1, 'budget-exhausted']]);
    // A recorded overrun is not extendable, even though an extension bound is set.
    assert.ok(!kinds.includes('openApprovalRequest'), 'no extension approval for an overrun');
    assert.equal(ensured(trace).length, 1);
    assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
    assert.equal(trace.summary.reason, 'overrun');
    assertLegalProjections(trace);
  });
}

for (const [name, answer, reason, overrun] of [
  ['a policy violation with a cost overrun', { status: 'FAILED', failureClass: 'policy-violation', reportedCostUsd: 7, reportedToolCalls: 10 }, 'policy-violation', [{ overrunUsd: 2, overrunToolCalls: 0 }]],
  ['a false completion with a tool-call overrun', { status: 'BLOCKED', failureClass: 'false-completion', reportedCostUsd: 1, reportedToolCalls: 53 }, 'false-completion', [{ overrunUsd: 0, overrunToolCalls: 3 }]],
  ['an unclassified failure with a cost overrun', { status: 'FAILED', failureClass: null, reportedCostUsd: 7, reportedToolCalls: 10 }, 'agent-failed', [{ overrunUsd: 2, overrunToolCalls: 0 }]],
  ['a cap stop that reports a duplicate side effect', { status: 'BUDGET_EXHAUSTED', failureClass: 'duplicate-side-effect', reportedCostUsd: 5, reportedToolCalls: 10 }, 'duplicate-side-effect', []],
] as const) {
  test(`agent outcome: a non-replaceable failure beats the exhaustion path (${name}): the task FAILS with that class`, () => {
    // Approvals are available and attempts remain, so only the failure class stops a new attempt or an extension.
    const trace = runTaskSequentially(baseInput(), scripted({
      runAgent: () => ({ kind: 'runAgent', wallClockMs: 1000, ...answer }),
    }));
    const kinds = requestKinds(trace.commands);
    for (const k of ['inspectWorkspace', 'openApprovalRequest', ...NEVER_AFTER_EXHAUSTION] as const) {
      assert.ok(!kinds.includes(k), `${k} after a non-replaceable failure`);
    }
    assert.equal(ensured(trace).length, 1);
    assert.deepEqual(outcomes(trace), [[1, 'failed']]);
    assert.deepEqual(effectsOf(trace.commands, 'recordOverrun').map(({ overrunUsd, overrunToolCalls }) => ({ overrunUsd, overrunToolCalls })), overrun);
    assert.equal(effectsOf(trace.commands, 'audit').filter((a) => a.action === 'budget.overrun').length, overrun.length,
      'an overrun is still audited as an incident');
    assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1 && e.reason === reason), 'attempt 1 quarantined');
    assert.equal(trace.summary.outcome, 'FAILED');
    assert.equal(trace.summary.reason, reason);
    assertLegalProjections(trace);
  });
}

test('agent outcome: an infrastructure error is replaced only with a fresh reservation', () => {
  // The dead attempt is charged its full cap (5); a retry needs 5 + 5 + 1 against a cap of 10.
  const trace = runTaskSequentially(baseInput({
    taskBudget: { maxAttempts: 3, maxCostUsd: 10, softCostUsd: 9, maxWallClockMinutes: 240 },
    policy: policy({ maxBudgetExtensionUsd: null }),
  }), scripted({
    runAgent: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: true }),
  }));
  assert.deepEqual(outcomes(trace), [[1, 'failed']]);
  assert.equal(ensured(trace).length, 1);
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'task-budget');
});

// ---------------------------------------------------------------------------
// Never-replaceable failure classes, whatever the policy says
// ---------------------------------------------------------------------------

const NEVER = ['policy-violation', 'false-completion', 'duplicate-side-effect'] as const;

function hostilePolicy(failureClass: (typeof NEVER)[number]) {
  return policy({ replaceableFailureClasses: [...DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses, failureClass] });
}

function assertEndsAfterOneAttempt(trace: TaskTrace, reason: string): void {
  assert.equal(ensured(trace).length, 1, 'no attempt follows a never-replaceable failure');
  const kinds = requestKinds(trace.commands);
  assert.ok(!kinds.includes('publishBranch') && !kinds.includes('upsertPullRequest'), 'nothing is published');
  assert.ok(!kinds.includes('openApprovalRequest'), 'no budget-extension approval');
  assert.deepEqual(outcomes(trace), [[1, 'failed']]);
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.equal(trace.summary.reason, reason);
  assertLegalProjections(trace);
}

for (const never of NEVER) {
  for (const [label, reportedCostUsd] of [['no overrun', 1], ['a cost overrun', 7]] as const) {
    test(`never replaceable: a hostile policy that lists ${never} still ends the task FAILED after one attempt (agent result, ${label})`, () => {
      const trace = runTaskSequentially(baseInput({ policy: hostilePolicy(never) }), scripted({
        runAgent: () => ({ kind: 'runAgent', status: 'FAILED', reportedCostUsd, reportedToolCalls: 10, wallClockMs: 1000, failureClass: never }),
      }));
      assertEndsAfterOneAttempt(trace, never);
      assert.equal(effectsOf(trace.commands, 'recordOverrun').length, reportedCostUsd > 5 ? 1 : 0, 'an overrun is still recorded');
    });
  }

  test(`never replaceable: a hostile policy that lists ${never} still ends the task FAILED after one attempt (activity failure)`, () => {
    const trace = runTaskSequentially(baseInput({ policy: hostilePolicy(never) }), scripted({
      runAgent: () => ({ kind: 'activityFailed', failureClass: never, timedOut: false }),
    }));
    assertEndsAfterOneAttempt(trace, never);
  });
}

test('never replaceable: an overstep is a policy violation and is not retried under a policy that lists policy-violation', () => {
  const trace = runTaskSequentially(baseInput({ policy: hostilePolicy('policy-violation') }), scripted({
    inspectWorkspace: () => ({ kind: 'inspectWorkspace', overstep: true }),
  }));
  assertEndsAfterOneAttempt(trace, 'policy-violation');
});

test('never replaceable: the policy rule reports each never-replaceable class and accepts the default policy', () => {
  assert.deepEqual(orchestrationPolicyErrors(DEFAULT_ORCHESTRATION_POLICY), []);
  for (const never of NEVER) {
    assert.deepEqual(orchestrationPolicyErrors(hostilePolicy(never)), [`replaceableFailureClasses: ${never} is never replaceable`]);
  }
  assert.deepEqual(orchestrationPolicyErrors(policy({ replaceableFailureClasses: ['not-a-class' as never] })),
    ['replaceableFailureClasses: unknown failure class not-a-class']);
});

// ---------------------------------------------------------------------------
// Repair with a failed reservation, and repair lineage on retry
// ---------------------------------------------------------------------------

// Attempt 1 needs 5 + 1 and spends 1 + 1; the repair attempt then needs 2 + 5 + 1 = 8 against a cap of 7.
const repairShort = baseInput({ taskBudget: { maxAttempts: 3, maxCostUsd: 7, softCostUsd: 7, maxWallClockMinutes: 240 } });
const repairOnce = scripted.bind(null);
const decide = (decision: 'approve' | 'reject', extensionUsd: number | null) => () => ({
  type: 'approvalDecisionReceived' as const, decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision, extensionUsd, principalId: 'human-1',
});

function repairFirst(extra: Parameters<typeof scripted>[0] = {}, hooks: Parameters<typeof scripted>[1] = {}) {
  return repairOnce({
    assuranceRound: (r, n) => (n === 1 && r.kind === 'assuranceRound' ? { kind: 'assuranceRound', outcome: repair(1, r.request.round) } : undefined),
    ...extra,
  }, hooks);
}

test('repair budget: a task-cap shortfall with approvals available waits for a budget extension; approve keeps the repair lineage', () => {
  const trace = runTaskSequentially(repairShort, repairFirst({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: true, decision: 'approve', extensionUsd: 1 }),
  }, { whenIdle: idleScript(decide('approve', 1)) }));
  const open = requests(trace.commands).find((r) => r.kind === 'openApprovalRequest');
  assert.equal(open?.kind === 'openApprovalRequest' && open.approvalKind, 'budget-extension');
  assert.equal(open?.kind === 'openApprovalRequest' && open.shortfallUsd, 1);
  assert.ok(effectsOf(trace.commands, 'projectTaskState').some((p) => p.status === 'WAITING_FOR_APPROVAL'), 'projected WAITING_FOR_APPROVAL');
  assert.deepEqual(ensured(trace).map((r) => [r.attemptNumber, r.attemptKind, r.baseSha, r.parentAttemptNumber, r.repairOrderRef]),
    [[1, 'initial', TASK_BASE, null, null], [2, 'repair', shaFor(1), 1, ref('ro-1')]]);
  const rounds = requests(trace.commands).flatMap((r) => (r.kind === 'assuranceRound' ? [r.request] : []));
  assert.deepEqual(rounds.map((r) => [r.attemptNumber, r.round, r.priorAdjudicationId]), [[1, 1, null], [2, 2, 'adj-r1']]);
  assert.deepEqual(outcomes(trace), [[1, 'repair-requested'], [2, 'proceeded']]);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

test('repair budget: rejecting the extension ends the task BUDGET_EXHAUSTED and publishes nothing', () => {
  const trace = runTaskSequentially(repairShort, repairFirst({
    verifyApprovalDecision: () => ({ kind: 'verifyApprovalDecision', verified: true, decision: 'reject', extensionUsd: null }),
  }, { whenIdle: idleScript(decide('reject', null)) }));
  assert.ok(!requestKinds(trace.commands).includes('publishBranch'), 'nothing pushed');
  assert.equal(ensured(trace).length, 1);
  assert.deepEqual(outcomes(trace), [[1, 'repair-requested']]);
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1), 'attempt 1 quarantined');
  assertLegalProjections(trace);
});

test('repair budget: with approvals unavailable a task-cap shortfall ends the task BUDGET_EXHAUSTED at once', () => {
  const trace = runTaskSequentially({ ...repairShort, policy: policy({ maxBudgetExtensionUsd: null }) }, repairFirst());
  assert.ok(!requestKinds(trace.commands).includes('openApprovalRequest'), 'no extension approval');
  assert.ok(!requestKinds(trace.commands).includes('publishBranch'), 'nothing pushed');
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'task-budget');
  assertLegalProjections(trace);
});

test('repair budget: a run-remainder shortfall is not extendable and ends the task BUDGET_EXHAUSTED, not FAILED', () => {
  const trace = runTaskSequentially(baseInput({ runRemainingUsd: 7 }), repairFirst());
  assert.ok(!requestKinds(trace.commands).includes('openApprovalRequest'), 'no extension approval');
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'run-budget');
  assertLegalProjections(trace);
});

test('repair budget: with maxAttempts exhausted the task FAILS as repair-capacity-exhausted, whatever the budget says', () => {
  const trace = runTaskSequentially({ ...repairShort, taskBudget: { ...repairShort.taskBudget, maxAttempts: 1 } }, repairFirst());
  assert.ok(!requestKinds(trace.commands).includes('openApprovalRequest'), 'no extension approval');
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.equal(trace.summary.reason, 'repair-capacity-exhausted');
});

test('repair lineage: REPAIR, then the repair agent dies, then the replacement keeps the lineage into round 2', () => {
  const trace = runTaskSequentially(baseInput(), repairFirst({
    runAgent: (_r, n) => (n === 2 ? { kind: 'activityFailed', failureClass: 'workflow-recovery-failure', timedOut: true } : undefined),
  }));
  assert.deepEqual(ensured(trace).map((r) => [r.attemptNumber, r.attemptKind, r.baseSha, r.parentAttemptNumber, r.repairOrderRef]), [
    [1, 'initial', TASK_BASE, null, null],
    [2, 'repair', shaFor(1), 1, ref('ro-1')],
    [3, 'retry', shaFor(1), 1, ref('ro-1')],
  ]);
  const all: TaskRequest[] = requests(trace.commands);
  const prepare3 = all.find((r) => r.kind === 'prepareWorkspace' && r.attemptNumber === 3);
  assert.equal(prepare3?.kind === 'prepareWorkspace' && prepare3.baseSha, shaFor(1));
  const store3 = all.find((r) => r.kind === 'storeAttemptInputs' && r.attemptNumber === 3);
  assert.deepEqual(store3?.kind === 'storeAttemptInputs' && store3.repairOrderRef, ref('ro-1'));
  const commit3 = all.find((r) => r.kind === 'commitAttempt' && r.attemptNumber === 3);
  assert.equal(commit3?.kind === 'commitAttempt' && commit3.expectedHeadSha, shaFor(1));
  const rounds = all.flatMap((r) => (r.kind === 'assuranceRound' ? [r.request] : []));
  assert.deepEqual(rounds.map((r) => [r.attemptNumber, r.round, r.priorAdjudicationId, r.taskBaseSha]),
    [[1, 1, null, TASK_BASE], [3, 2, 'adj-r1', TASK_BASE]]);
  assert.deepEqual(outcomes(trace), [[1, 'repair-requested'], [2, 'failed'], [3, 'proceeded']]);
  // The parent's worktree goes once the first lineage worktree exists; the dead repair attempt is quarantined, not deleted.
  assert.deepEqual(effectsOf(trace.commands, 'cleanupWorkspace').map((e) => e.attemptNumber), [1, 3]);
  assert.deepEqual(effectsOf(trace.commands, 'quarantineWorkspace').map((e) => e.attemptNumber), [2]);
  assert.equal(effectsOf(trace.commands, 'emitRunEvent').filter((e) => e.eventType === 'workflow.recovered').length, 1);
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'publishBranch').length, 1);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

// ---------------------------------------------------------------------------
// Assurance-activity failure
// ---------------------------------------------------------------------------

for (const [mode, flagged, terminal, reason] of [
  ['shadow', false, 'proceeded', 'review-handoff'],
  ['gating', true, 'escalated', 'assurance-escalated'],
] as const) {
  test(`assurance unavailable in ${mode} mode: audited, then published as ${terminal}; never FAILED`, () => {
    const trace = runTaskSequentially(baseInput({ governance: governance({ assuranceMode: mode }) }), scripted({
      assuranceRound: () => ({ kind: 'activityFailed', failureClass: 'provider', timedOut: false }),
    }));
    const audit = effectsOf(trace.commands, 'audit').find((a) => a.action === 'assurance-unavailable');
    assert.deepEqual(audit && [audit.detail['attemptNumber'], audit.detail['assuranceMode'], audit.detail['failureClass']], [1, mode, 'provider']);
    const pr = requests(trace.commands).find((r) => r.kind === 'upsertPullRequest');
    assert.equal(pr?.kind === 'upsertPullRequest' && pr.flagged, flagged);
    assert.equal(pr?.kind === 'upsertPullRequest' && pr.prBodySectionRef, null, 'the PR states that assurance was unavailable');
    assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.terminal, o.adjudicationId]), [[terminal, null]]);
    assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
    assert.equal(trace.summary.reason, reason);
    assertLegalProjections(trace);
  });
}

// ---------------------------------------------------------------------------
// Cancellation around the critical units
// ---------------------------------------------------------------------------

test('cancel during the assurance round interrupts it: nothing is pushed, the attempt is cleaned up and the task CANCELLED', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'assuranceRound' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 1);
  const kinds = requestKinds(trace.commands);
  assert.ok(!kinds.includes('publishBranch') && !kinds.includes('openApprovalRequest'), 'no approval and no push after the cancel');
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1), 'attempt 1 quarantined');
  assert.ok(effectsOf(trace.commands, 'releaseLease').some((e) => e.attemptNumber === 1), 'lease 1 released');
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assertLegalProjections(trace);
});

test('cancel during the publication-approval wait ends the task at once and closes the open request', () => {
  const trace = runTaskSequentially(baseInput({ governance: governance({ publicationApprovalRequired: true }) }),
    scripted({}, { whenIdle: idleScript(() => cancel()) }));
  assert.deepEqual(effectsOf(trace.commands, 'cancelApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
  assert.ok(effectsOf(trace.commands, 'cancelTimer').some((t) => t.timerId === 'approval:asep-task-task-1:1'), 'expiry timer cancelled');
  assert.ok(!requestKinds(trace.commands).includes('publishBranch'), 'nothing pushed');
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assertLegalProjections(trace);
});

test('cancel during evidence binding lets the unit reconcile, then cancels before the assurance round', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'persistEvidence' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 0);
  const kinds = requestKinds(trace.commands);
  assert.equal(kinds.filter((k) => k === 'persistEvidence').length, 1);
  assert.ok(!kinds.includes('assuranceRound') && !kinds.includes('publishBranch'), 'no assurance and no push after the cancel');
  assert.equal(trace.summary.outcome, 'CANCELLED');
});

test('cancel during the PR upsert lets it complete; the PR stays open and the cancel is audited', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    messagesDuring: (request) => (request.kind === 'upsertPullRequest' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 0);
  assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'workflow.cancel.after-publication'), 'cancel after publication audited');
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assert.equal(trace.summary.prNumber, 7);
});

// ---------------------------------------------------------------------------
// The run workflow
// ---------------------------------------------------------------------------

const RUN: RunCoreInput = { runId: 'run-1' as RunId, runBudget: { maxCostUsd: 10, softCostUsd: 8, maxTasks: 3 } };
const submit = (taskId: string, requestId = `s-${taskId}`) => ({ type: 'submitTask' as const, taskId: taskId as TaskId, requestId });
const done = (taskId: string, chargedCostUsd: number) => ({ type: 'childCompleted' as const, taskId: taskId as TaskId, outcome: 'WAITING_FOR_HUMAN_REVIEW' as const, chargedCostUsd });

function startedChildren(commands: readonly RunCommand[]) {
  return commands.flatMap((c) => (c.kind === 'startChild' ? [[c.taskId, c.runRemainingUsd]] : []));
}

test('run: tasks run one at a time in submission order, each capped by the run remainder', () => {
  let d = startRun(RUN, null);
  const log: RunCommand[] = [...d.commands];
  for (const e of [submit('a'), submit('b'), done('a', 4), done('b', 3)] as const) {
    d = decideRun(d.state, e);
    log.push(...d.commands);
  }
  assert.deepEqual(startedChildren(log), [['a', 10], ['b', 6]]);
  assert.ok(log.some((c) => c.kind === 'emitRunEvent' && c.eventType === 'run.started'));
});

test('run: submitTask is deduplicated by task id, and the run task limit is enforced', () => {
  let d = startRun({ ...RUN, runBudget: { ...RUN.runBudget, maxTasks: 2 } }, null);
  d = decideRun(d.state, submit('a'));
  assert.deepEqual(d.receipt, { accepted: true, duplicate: false, reason: null });
  d = decideRun(d.state, submit('a', 'other-request'));
  assert.deepEqual(d.receipt, { accepted: true, duplicate: true, reason: null });
  assert.deepEqual(startedChildren(d.commands), []);
  d = decideRun(d.state, submit('b'));
  d = decideRun(d.state, submit('c'));
  assert.deepEqual(d.receipt, { accepted: false, duplicate: false, reason: 'run-task-limit' });
});

test('run: continue-as-new waits for the active child and carries queue, dedup set and budget totals', () => {
  let d = startRun(RUN, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, submit('b'));
  d = decideRun(d.state, { type: 'continueAsNewSuggested' });
  assert.deepEqual(d.commands.filter((c) => c.kind === 'continueAsNew'), [], 'never while a child is active');
  d = decideRun(d.state, done('a', 4));
  const can = d.commands.find((c) => c.kind === 'continueAsNew');
  assert.ok(can && can.kind === 'continueAsNew');
  assert.deepEqual(startedChildren(d.commands), [], 'the next child starts in the new run');
  assert.deepEqual(can.carry.queue, ['b']);
  assert.deepEqual([...can.carry.submitted].sort(), ['a', 'b']);
  assert.equal(can.carry.spentMicroUsd, toMicroUsd(4));
  assert.equal(can.carry.finishedTasks, 1);

  let next = startRun(RUN, can.carry);
  assert.ok(!next.commands.some((c) => c.kind === 'emitRunEvent' && c.eventType === 'run.started'), 'run.started only once');
  assert.deepEqual(startedChildren(next.commands), [['b', 6]]);
  next = decideRun(next.state, submit('a', 'replayed'));
  assert.deepEqual(next.receipt, { accepted: true, duplicate: true, reason: null });
});

test('run: the run completes when maxTasks children have finished', () => {
  let d = startRun({ ...RUN, runBudget: { ...RUN.runBudget, maxTasks: 1 } }, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, done('a', 1));
  const complete = d.commands.find((c) => c.kind === 'complete');
  assert.ok(complete && complete.kind === 'complete' && complete.outcome === 'COMPLETED');
  assert.ok(d.commands.some((c) => c.kind === 'emitRunEvent' && c.eventType === 'run.completed'));
});

test('run pause forwards to the child and holds the queue; cancel cancels the child and drops the queue', () => {
  let d = startRun(RUN, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, submit('b'));
  d = decideRun(d.state, { type: 'pauseRequested', requestId: 'p1', principalId: 'op' });
  assert.deepEqual(d.commands.filter((c) => c.kind === 'signalChild').map((c) => c.kind === 'signalChild' && [c.taskId, c.signal]), [['a', 'pause']]);
  d = decideRun(d.state, done('a', 1));
  assert.deepEqual(startedChildren(d.commands), [], 'no new child while paused');
  d = decideRun(d.state, { type: 'resumeRequested', requestId: 'r1', principalId: 'op' });
  assert.deepEqual(startedChildren(d.commands), [['b', 9]]);
  d = decideRun(d.state, { type: 'cancelRequested', requestId: 'c1', principalId: 'op' });
  assert.ok(d.commands.some((c) => c.kind === 'cancelChild' && c.taskId === 'b'));
  d = decideRun(d.state, { type: 'childCompleted', taskId: 'b' as TaskId, outcome: 'CANCELLED', chargedCostUsd: 0 });
  const complete = d.commands.find((c) => c.kind === 'complete');
  assert.ok(complete && complete.kind === 'complete' && complete.outcome === 'CANCELLED');
});

test('run: the run soft threshold is reported once', () => {
  let d = startRun(RUN, null);
  const log: RunCommand[] = [];
  for (const e of [submit('a'), submit('b'), done('a', 5), done('b', 4)] as const) {
    d = decideRun(d.state, e);
    log.push(...d.commands);
  }
  const crossed = log.filter((c) => c.kind === 'emitRunEvent' && c.eventType === 'budget.threshold_crossed');
  assert.equal(crossed.length, 1);
});

test('defaults: no budget-extension bound in code; while it is unset, extension approval is unavailable', () => {
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.maxBudgetExtensionUsd, null);
});

test('defaults: replaceable and never-replaceable failure classes match the architecture', () => {
  assert.deepEqual([...DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses].sort(), [
    'agent-loop-stall', 'artifact-loss', 'environment', 'provider', 'quota-rate-limit', 'tool', 'workflow-recovery-failure',
  ]);
  assert.deepEqual([...NEVER_REPLACEABLE_FAILURE_CLASSES], ['policy-violation', 'false-completion', 'duplicate-side-effect']);
  for (const never of NEVER_REPLACEABLE_FAILURE_CLASSES) {
    assert.ok(!DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses.includes(never), never);
  }
});

test('the core failure classes are exactly the classes of the canonical failure taxonomy', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const yaml = readFileSync(join(repoRoot, 'policies', 'failure-taxonomy.yaml'), 'utf8');
  const section = yaml.slice(yaml.indexOf('\nclasses:'));
  const names = [...section.matchAll(/^ {2}([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
  assert.equal(names.length, 17);
  assert.deepEqual([...FAILURE_CLASSES].sort(), [...names].sort());
});

// ---------------------------------------------------------------------------
// Projection edges
// ---------------------------------------------------------------------------

test('projection: between the existing statuses the core allows exactly the domain transition table', () => {
  const existing = taskReachableStates();
  for (const from of existing) {
    for (const to of existing) {
      let domainAllows = true;
      try {
        transitionTask({ id: 't' as TaskId, status: from, version: 0 }, to);
      } catch {
        domainAllows = false;
      }
      assert.equal(isLegalProjection(from, to), domainAllows, `${from} -> ${to}`);
    }
  }
});

test('projection: the edges touching the new statuses are the data-model additions plus VERIFYING -> BUDGET_EXHAUSTED', () => {
  const added = new Set(['PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED']);
  const all = [...taskReachableStates(), ...added] as Parameters<typeof isLegalProjection>[0][];
  const edges: string[] = [];
  for (const from of all) {
    for (const to of all) {
      if ((added.has(from) || added.has(to)) && isLegalProjection(from, to)) edges.push(`${from}->${to}`);
    }
  }
  assert.deepEqual(edges.sort(), [
    'EXECUTING->BUDGET_EXHAUSTED', 'EXECUTING->PAUSED', 'EXECUTING->WAITING_FOR_APPROVAL',
    'PAUSED->BLOCKED', 'PAUSED->CANCELLED', 'PAUSED->EXECUTING', 'PAUSED->READY', 'PAUSED->VERIFYING',
    'READY->BUDGET_EXHAUSTED', 'READY->PAUSED', 'READY->WAITING_FOR_APPROVAL',
    // A replacement attempt refused for budget after the task reached verification (for example a retry
    // of an exhausted repair attempt); the domain table gains it with the status extension.
    'VERIFYING->BUDGET_EXHAUSTED',
    'VERIFYING->PAUSED', 'VERIFYING->WAITING_FOR_APPROVAL',
    'WAITING_FOR_APPROVAL->BLOCKED', 'WAITING_FOR_APPROVAL->BUDGET_EXHAUSTED', 'WAITING_FOR_APPROVAL->CANCELLED',
    'WAITING_FOR_APPROVAL->EXECUTING', 'WAITING_FOR_APPROVAL->READY', 'WAITING_FOR_APPROVAL->VERIFYING',
  ].sort());
});
