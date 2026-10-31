// Decision-core behavior tables: the task reducer, the run reducer and the pure
// building blocks they use (activity options, budget reservation, approvals,
// assurance-outcome validation, task-status projection).
//
// Scenarios run through the sequential in-memory interpreter, which drives the
// reducer exactly as the Temporal workflow will: one awaited request at a time,
// effects executed in order, messages delivered between results.

import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunId, TaskId } from '@asep/contracts';
import {
  PRE_LEASE_ATTEMPT_TERMINALS,
  REVIEW_LOOP_DISABLED,
  createDisabledAssuranceSlot,
  runRegistrationOrderingContract,
  type AttemptLifecycleStep,
} from '@asep/application';
import type * as Slot from '@asep/application';
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
import { MAX_USD, checkReservation, crossesSoftThreshold, isExactUsd, toMicroUsd } from './budget.js';
import { DEFAULT_ORCHESTRATION_POLICY, FAILURE_CLASSES, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import { isLegalProjection } from './projection.js';
import { decideRun, startRun } from './run-core.js';
import type { RunCommand, RunCoreInput } from './run-core.js';
import { runTaskSequentially } from './sequential-interpreter.js';
import type { TaskEnvironment, TaskTrace } from './sequential-interpreter.js';
import { decideTask, startTask, taskWorkflowId } from './task-core.js';
import { orchestrationPolicyErrors, runInputErrors, taskInputErrors } from './validation.js';
import {
  NO_USAGE,
  TASK_BASE,
  TASK_BASE_BRANCH,
  TASK_REPOSITORY,
  OTHER_BINDINGS,
  adjudicationId,
  attemptIdFor,
  baseInput,
  block,
  effectsOf,
  escalate,
  fenceFor,
  governance,
  happyAnswer,
  indexOfCommand,
  policy,
  proceed,
  ref,
  branchFor,
  repair,
  requestKinds,
  requests,
  roundRequest,
  scripted,
  shaFor,
} from './test-support/fixtures.js';
import { GIT_BRANCH_NAMES } from './test-support/git-branch-names.js';
import type {
  ArtifactRef,
  AssuranceFence,
  AssuranceMode,
  AssuranceOutcome,
  AssuranceOutcomeKind,
  AssuranceUsage,
  AttemptOutcomeFacts,
  AttemptOutcomeRecord,
  AttemptTerminal,
  BlockReason,
  CoreAssuranceRequest,
  EscalationReason,
  FailureClass,
  ObservedPullRequest,
  PreLeaseAttemptTerminal,
  ReviewMode,
  ShadowVerdict,
  TaskCoreInput,
  TaskOutcome,
  PublicationEffect,
  ForgeRepository,
  TaskCommand,
  TaskEffect,
  TaskEvent,
  TaskMessage,
  TaskRequest,
  TaskRequestKind,
  TaskState,
} from './types.js';

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
  'admitTask', 'ensureAttempt', 'findAttempt', 'acquireLease', 'prepareWorkspace', 'storeAttemptInputs', 'runAgent',
  'inspectWorkspace', 'runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound',
  'openApprovalRequest', 'verifyApprovalDecision', 'publishBranch', 'upsertPullRequest', 'reconcilePublication',
  'findLease', 'recordPreLeaseOutcome',
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

test('activity options: the attempt registration and its lookup are short writes a cancel waits for', () => {
  assert.equal(ACTIVITY_OPTIONS.ensureAttempt.cancellable, false);
  assert.equal(ACTIVITY_OPTIONS.findAttempt.cancellable, false);
});

test('activity options: the lease lookup and the pre-lease outcome write settle a lease and a cancel waits for them', () => {
  assert.equal(ACTIVITY_OPTIONS.acquireLease.cancellable, true, 'the acquisition itself stays cancellable');
  assert.equal(ACTIVITY_OPTIONS.findLease.cancellable, false);
  assert.equal(ACTIVITY_OPTIONS.recordPreLeaseOutcome.cancellable, false);
  assert.deepEqual(ACTIVITY_OPTIONS.recordPreLeaseOutcome.retry, ACTIVITY_OPTIONS.recordAttemptOutcome.retry);
});

test('activity options: the publication reconciliation is a read a cancel waits for, retried like the push', () => {
  assert.equal(ACTIVITY_OPTIONS.reconcilePublication.cancellable, false);
  assert.deepEqual(ACTIVITY_OPTIONS.reconcilePublication.retry, ACTIVITY_OPTIONS.publishBranch.retry);
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

test('budget precision: usage converts to micro-dollars with ceiling from its exact decimal value', () => {
  assert.equal(toMicroUsd(5.0000004), 5_000_001, 'a fraction of a micro-dollar is never dropped');
  assert.equal(toMicroUsd(1e-7), 1, 'a sub-micro amount is one micro-dollar');
  assert.equal(toMicroUsd(1.1), 1_100_000, 'a plain decimal stays exact, not its binary expansion');
  assert.equal(toMicroUsd(0.3), 300_000, 'a plain decimal stays exact');
  assert.equal(toMicroUsd(0), 0);
  assert.equal(toMicroUsd(MAX_USD), 100_000_000_000_000);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.000001, 1e300]) {
    assert.throws(() => toMicroUsd(bad), RangeError, `${bad} is not a money amount`);
  }
});

test('budget precision: an amount is exact only if it fits micro-dollars, is not negative and is at most the bound', () => {
  for (const ok of [0, 0.000001, 1.1, 5, 12.345678, MAX_USD]) assert.equal(isExactUsd(ok), true, `${ok} is exact`);
  for (const bad of [5.0000004, 1e-7, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_USD + 0.000001, 1e9]) {
    assert.equal(isExactUsd(bad), false, `${bad} is not exact`);
  }
});

test('budget precision: the input rules reject money that is not exact, not positive where a cap must be, or out of range', () => {
  assert.deepEqual(taskInputErrors(baseInput()), []);
  assert.deepEqual(taskInputErrors(baseInput({ attemptBudget: { ...baseInput().attemptBudget, maxCostUsd: 5.0000004 } })),
    ['attemptBudget.maxCostUsd: must be a positive amount exact in micro-USD and at most 100000000']);
  assert.deepEqual(taskInputErrors(baseInput({ taskBudget: { ...baseInput().taskBudget, maxCostUsd: 0, softCostUsd: 0 } })),
    ['taskBudget.maxCostUsd: must be a positive amount exact in micro-USD and at most 100000000']);
  assert.deepEqual(taskInputErrors(baseInput({ taskBudget: { ...baseInput().taskBudget, softCostUsd: 21 } })),
    ['taskBudget.softCostUsd: must be an amount exact in micro-USD, at most taskBudget.maxCostUsd']);
  assert.deepEqual(taskInputErrors(baseInput({ verificationReserve: { costUsd: Number.NaN, wallClockMinutes: 10 } })),
    ['verificationReserve.costUsd: must be an amount exact in micro-USD and at most 100000000']);
  assert.deepEqual(taskInputErrors(baseInput({ runRemainingUsd: 1e9 })),
    ['runRemainingUsd: must be an amount exact in micro-USD and at most 100000000']);
  assert.deepEqual(taskInputErrors(baseInput({ policy: policy({ maxBudgetExtensionUsd: 0.0000001 }) })),
    ['policy.maxBudgetExtensionUsd: must be unset or a positive amount exact in micro-USD and at most 100000000']);
  assert.deepEqual(runInputErrors({ runId: 'r' as RunId, runBudget: { maxCostUsd: 10.5, softCostUsd: 8, maxTasks: 3 }, fixedTasks: null }), []);
  assert.deepEqual(runInputErrors({ runId: 'r' as RunId, runBudget: { maxCostUsd: 10.0000001, softCostUsd: 11, maxTasks: 3 }, fixedTasks: null }), [
    'runBudget.maxCostUsd: must be a positive amount exact in micro-USD and at most 100000000',
    'runBudget.softCostUsd: must be an amount exact in micro-USD, at most runBudget.maxCostUsd',
  ]);
});

// The base branch is a Git branch name (Git's ref-name rules for a branch); the reviewers' bases come first.
const REFUSED_BASE_BRANCHES: readonly (readonly [string, unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['the empty string', ''],
  ['main..evil', 'main..evil'],
  ['a name with a leading slash', '/main'],
  ['a name starting with a dot', '.hidden'],
  ['a path component starting with a dot', 'release/.hidden'],
  ['a path component ending in .lock', 'a.lock/b'],
  ['HEAD', 'HEAD'],
  ['a name with a leading dash', '-main'],
  ['a name with a space', 'release 1'],
  ['a name with a control character', 'release\u0001'],
  ['a name with DEL', 'release\u007f'],
  ['a name with a tilde', 'main~1'],
  ['a name with a caret', 'main^1'],
  ['a name with a colon', 'main:evil'],
  ['a name with a question mark', 'main?'],
  ['a name with an asterisk', 'main*'],
  ['a name with an open bracket', 'main[1]'],
  ['a name with a backslash', 'main\\evil'],
  ['a reflog selector', 'main@{1}'],
  ['a double slash', 'release//1'],
  ['a trailing slash', 'release/'],
  ['a trailing dot', 'release.'],
  ['a .lock suffix', 'release.lock'],
  ['a name over 255 characters', 'r'.repeat(256)],
];

for (const [name, baseBranch] of REFUSED_BASE_BRANCHES) {
  test(`input rules: a base branch that is ${name} is refused`, () => {
    const errors = taskInputErrors(baseInput({ baseBranch: baseBranch as string }));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0]!, /^baseBranch: must be a Git branch name/);
  });
}

test('input rules: valid branch names other than main pass as the base branch', () => {
  for (const baseBranch of ['main', 'release/2026.10', 'develop', 'feature/x-1', 'refs/heads/main', 'v1.2-rc', 'a@b', 'r'.repeat(255)]) {
    assert.deepEqual(taskInputErrors(baseInput({ baseBranch })), [], baseBranch);
  }
});

test('input rules: the base branch rule gives git check-ref-format --branch\'s answer for every name of the committed table', () => {
  for (const { name, git } of GIT_BRANCH_NAMES) {
    const errors = taskInputErrors(baseInput({ baseBranch: name }));
    assert.equal(errors.length === 0 ? 'valid' : 'invalid', git, `${JSON.stringify(name)}: ${JSON.stringify(errors)}`);
  }
});

/**
 * Asks the git at `gitBinary` about every name of the committed branch-name table and expects the recorded answer. It
 * runs outside any repository, so `--branch` cannot expand `@{-N}` to a previous branch of the checkout. Without that
 * git it compares nothing and reports itself skipped with the reason; the committed table stays the oracle either way.
 */
function recheckBranchNamesWithGit(t: Pick<TestContext, 'skip'>, gitBinary: string): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asep-git-ref-')));
  try {
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) };
    const probe = spawnSync(gitBinary, ['--version'], { cwd: dir, env });
    if (probe.error !== undefined || probe.status !== 0) {
      t.skip('git is not available here, so git\'s answers were not re-checked; the committed table stands as the oracle');
      return;
    }
    for (const { name, git } of GIT_BRANCH_NAMES) {
      const answer = spawnSync(gitBinary, ['check-ref-format', '--branch', name], { cwd: dir, env });
      assert.equal(answer.status === 0 ? 'valid' : 'invalid', git, JSON.stringify(name));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('input rules: git still answers the committed branch-name table as recorded', (t) => {
  recheckBranchNamesWithGit(t, 'git');
});

test('input rules: without git, the git re-check of the branch-name table reports itself skipped, with the reason', () => {
  const skipped: (string | undefined)[] = [];
  const diagnostics: string[] = [];
  const context = { skip: (message?: string) => { skipped.push(message); }, diagnostic: (message: string) => { diagnostics.push(message); } };
  recheckBranchNamesWithGit(context, join(tmpdir(), 'asep-no-such-git', 'git'));
  assert.deepEqual(skipped, ['git is not available here, so git\'s answers were not re-checked; the committed table stands as the oracle']);
  assert.deepEqual(diagnostics, []);
});

// The repository is the binding's: the forge's numeric id, with an owner and name in the forge's name rules.
const REFUSED_REPOSITORIES: readonly (readonly [string, unknown])[] = [
  ['missing', undefined],
  ['without an id', { owner: 'acme', name: 'widgets' }],
  ['an id of zero', { id: 0, owner: 'acme', name: 'widgets' }],
  ['a negative id', { id: -4242, owner: 'acme', name: 'widgets' }],
  ['a fractional id', { id: 42.5, owner: 'acme', name: 'widgets' }],
  ['an id beyond the safe integers', { id: 2 ** 53, owner: 'acme', name: 'widgets' }],
  ['an id given as a string', { id: '4242', owner: 'acme', name: 'widgets' }],
  ['an empty owner', { id: 4242, owner: '', name: 'widgets' }],
  ['an empty name', { id: 4242, owner: 'acme', name: '' }],
  ['an owner with a slash', { id: 4242, owner: 'acme/x', name: 'widgets' }],
  ['an owner with a leading dash', { id: 4242, owner: '-acme', name: 'widgets' }],
  ['an owner over 39 characters', { id: 4242, owner: 'a'.repeat(40), name: 'widgets' }],
  ['a name with a space', { id: 4242, owner: 'acme', name: 'wid gets' }],
  ['the name ..', { id: 4242, owner: 'acme', name: '..' }],
  ['a name over 100 characters', { id: 4242, owner: 'acme', name: 'w'.repeat(101) }],
];

for (const [name, repository] of REFUSED_REPOSITORIES) {
  test(`input rules: a repository that is ${name} is refused`, () => {
    const errors = taskInputErrors(baseInput({ repository: repository as ForgeRepository }));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0]!, /^repository: must be a forge repository/);
  });
}

test('input rules: a repository with its forge id passes, its owner and name in any case', () => {
  for (const repository of [
    TASK_REPOSITORY,
    { id: 1, owner: 'a-b-1', name: 'x.y_z-1' },
    { id: Number.MAX_SAFE_INTEGER, owner: 'a'.repeat(39), name: 'w'.repeat(100) },
    { id: 4242, owner: 'Acme-Corp', name: 'Widgets.JS' },
  ]) {
    assert.deepEqual(taskInputErrors(baseInput({ repository })), [], JSON.stringify(repository));
  }
});

test('budget precision: a reported 5.0000004 on a cap of 5 is an overrun of one micro-dollar; 1.1 on 1.1 is none', () => {
  const over = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 5.0000004, reportedToolCalls: 10, wallClockMs: 1000, failureClass: null }),
  }));
  assert.deepEqual(effectsOf(over.commands, 'recordOverrun').map((o) => o.overrunUsd), [0.000001]);
  assert.ok(!requestKinds(over.commands).includes('publishBranch'), 'nothing published after a sub-micro overrun');
  assert.equal(over.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(over.summary.reason, 'overrun');

  const exact = runTaskSequentially(baseInput({ attemptBudget: { ...baseInput().attemptBudget, maxCostUsd: 1.1 } }), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 1.1, reportedToolCalls: 10, wallClockMs: 1000, failureClass: null }),
  }));
  assert.deepEqual(effectsOf(exact.commands, 'recordOverrun'), []);
  assert.equal(exact.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assert.deepEqual(effectsOf(exact.commands, 'recordUsage').map((u) => u.chargedCostUsd), [2.1]);

  const subMicro = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 1e-7, reportedToolCalls: 10, wallClockMs: 1000, failureClass: null }),
  }));
  assert.deepEqual(effectsOf(subMicro.commands, 'recordUsage').map((u) => u.chargedCostUsd), [1.000001], 'sub-micro usage is charged one micro-dollar');
});

// Overrun detection comes before any saturation of the ledger amount: at a cap equal to the bound, usage above it
// is still an overrun, and a usage value outside its bound is one whatever the cap.

const atBound = (attemptCapUsd: number = MAX_USD) => baseInput({
  attemptBudget: { ...baseInput().attemptBudget, maxCostUsd: attemptCapUsd },
  taskBudget: { ...baseInput().taskBudget, maxCostUsd: MAX_USD, softCostUsd: MAX_USD },
  verificationReserve: { costUsd: 0, wallClockMinutes: 0 },
  runRemainingUsd: MAX_USD,
});
const agentReports = (reportedCostUsd: number, reportedToolCalls = 10, wallClockMs = 1000) => () => ({
  kind: 'runAgent' as const, status: 'AGENT_DONE' as const, reportedCostUsd, reportedToolCalls, wallClockMs, failureClass: null,
});

function assertInspectedOnly(trace: TaskTrace, label: string): void {
  const kinds = requestKinds(trace.commands);
  for (const k of ['runVerification', 'commitAttempt', 'publishBranch', 'upsertPullRequest'] as const) {
    assert.ok(!kinds.includes(k), `${label}: ${k} after an overrun`);
  }
  assert.ok(kinds.includes('inspectWorkspace'), `${label}: inspected`);
  assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'budget.overrun'), `${label}: incident audited`);
  assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['BUDGET_EXHAUSTED', 'overrun'], label);
  for (const c of trace.commands) {
    if (c.type !== 'effect') continue;
    for (const v of Object.values(c.effect)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: ${c.effect.kind} carries ${v}`);
  }
}

test('budget bound: with every money cap at the bound, usage one dollar or one micro-dollar above it is an overrun', () => {
  // The reviewer's CAP_PROBE: the input is valid, and the usage is above the attempt cap.
  assert.deepEqual(taskInputErrors(atBound()), []);
  for (const reported of [MAX_USD + 1, MAX_USD + 0.000001]) {
    const trace = runTaskSequentially(atBound(), scripted({ runAgent: agentReports(reported) }));
    assertInspectedOnly(trace, `${reported}`);
    assert.deepEqual(effectsOf(trace.commands, 'recordOverrun').map((o) => [o.overrunUsd, o.usageOutOfBound]), [[0, true]],
      'the excess is beyond what the ledger can hold, so the overrun says so');
    assert.deepEqual(effectsOf(trace.commands, 'recordUsage').map((u) => u.chargedCostUsd), [MAX_USD], 'the ledger amount saturates');
  }
});

test('budget bound: usage equal to a cap at the bound is within it; next to the bound the excess is exact', () => {
  const atCap = runTaskSequentially(atBound(), scripted({ runAgent: agentReports(MAX_USD) }));
  assert.deepEqual(effectsOf(atCap.commands, 'recordOverrun'), []);
  assert.equal(atCap.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');

  const below = MAX_USD - 0.000001;
  const justOver = runTaskSequentially(atBound(below), scripted({ runAgent: agentReports(MAX_USD) }));
  assertInspectedOnly(justOver, 'one micro-dollar over a cap next to the bound');
  assert.deepEqual(effectsOf(justOver.commands, 'recordOverrun').map((o) => [o.overrunUsd, o.usageOutOfBound]), [[0.000001, false]]);

  const atBelow = runTaskSequentially(atBound(below), scripted({ runAgent: agentReports(below) }));
  assert.deepEqual(effectsOf(atBelow.commands, 'recordOverrun'), []);
  assert.equal(atBelow.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('budget bound: a reported cost beyond the bound is an overrun on any cap and is charged at the bound', () => {
  for (const reported of [1e9, 1e300, Number.POSITIVE_INFINITY]) {
    const trace = runTaskSequentially(baseInput(), scripted({ runAgent: agentReports(reported) }));
    assertInspectedOnly(trace, `${reported}`);
    assert.deepEqual(effectsOf(trace.commands, 'recordOverrun').map((o) => [o.overrunUsd, o.usageOutOfBound]), [[MAX_USD - 5, true]]);
    assert.deepEqual(effectsOf(trace.commands, 'recordUsage').map((u) => u.chargedCostUsd), [MAX_USD]);
  }
});

test('budget bound: a cost, tool-call count or wall-clock that is negative, not a number or not finite is an overrun', () => {
  const invalid = [-1, Number.NaN, Number.NEGATIVE_INFINITY];
  const cases = [
    ...invalid.map((v) => ({ label: `cost ${v}`, answer: agentReports(v), chargedCostUsd: 5, minutes: 1 })),
    ...[...invalid, Number.POSITIVE_INFINITY].map((v) => ({ label: `tool calls ${v}`, answer: agentReports(1, v), chargedCostUsd: 1, minutes: 1 })),
    ...[...invalid, Number.POSITIVE_INFINITY].map((v) => ({ label: `wall-clock ${v}`, answer: agentReports(1, 10, v), chargedCostUsd: 1, minutes: 30 })),
  ];
  for (const c of cases) {
    const trace = runTaskSequentially(baseInput(), scripted({ runAgent: c.answer }));
    assertInspectedOnly(trace, c.label);
    assert.deepEqual(effectsOf(trace.commands, 'recordOverrun').map((o) => o.usageOutOfBound), [true], c.label);
    assert.deepEqual(effectsOf(trace.commands, 'recordUsage').map((u) => [u.chargedCostUsd, u.chargedWallClockMinutes]),
      [[c.chargedCostUsd, c.minutes]], `${c.label}: an invalid cost is charged the cap, an invalid wall-clock the wall-clock cap`);
  }
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
  // An amount that is not exact in micro-dollars is refused like an out-of-bound one.
  assert.equal(validateApprovalDecision(open, [], { ...msg, extensionUsd: 2.0000001 }, max).reason, 'extension-out-of-bounds');
  assert.equal(validateApprovalDecision(open, [], { ...msg, extensionUsd: Number.NaN }, max).reason, 'extension-out-of-bounds');
});

// ---------------------------------------------------------------------------
// Assurance outcome validation
// ---------------------------------------------------------------------------

const ROUND_1: TaskRequest = {
  kind: 'assuranceRound',
  request: {
    attemptNumber: 1,
    round: 1,
    evidenceId: 'ev-1',
    taskBaseSha: TASK_BASE,
    declaredComplete: true,
    priorAdjudicationId: null,
    idempotencyKey: 'att-1:assurance:1',
    budgetRemaining: { costMicroUsd: 14_000_000, wallClockMs: 12_000_000 },
  },
};
const CTX = { round: 1, resultSha: shaFor(1), roundKey: 'att-1:assurance:1' };

const SHADOW_PROCEED = {
  ...(proceed(ROUND_1) as object),
  mode: 'shadow',
  shadow: { wouldBe: 'REPAIR', reason: 'blocking-findings', blockingFindings: 2 },
};

test('assurance: each outcome of the slot contract validates and is read back field for field', () => {
  const valid: readonly unknown[] = [
    proceed(ROUND_1),
    { ...(proceed(ROUND_1) as object), prBodySectionRef: null },
    { ...(proceed(ROUND_1) as object), mode: 'gating' },
    SHADOW_PROCEED,
    { ...SHADOW_PROCEED, shadow: { wouldBe: 'PROCEED', reason: null, blockingFindings: 0 } },
    { ...SHADOW_PROCEED, shadow: { wouldBe: 'ESCALATE', reason: 'reviewer-unavailable', blockingFindings: 0 } },
    escalate(ROUND_1),
    repair(ROUND_1),
    block(ROUND_1),
    { ...(block(ROUND_1) as object), mode: 'shadow', prBodySectionRef: ref('blocked') },
    { ...(block(ROUND_1) as object), mode: 'not-required', reason: 'unscannable-sensitive-change' },
    { ...(proceed(ROUND_1) as object), usage: { providerCalls: 3, inputTokens: 1200, outputTokens: 300, reviewCostMicroUsd: null } },
  ];
  for (const raw of valid) {
    const parsed = parseAssuranceOutcome(raw, CTX);
    assert.ok(parsed.ok, `${JSON.stringify(raw)}: ${parsed.ok ? '' : parsed.error}`);
    assert.deepEqual(parsed.outcome, raw);
  }
});

test('assurance: the parsed outcome carries exactly the contract fields; extra fields are dropped', () => {
  const parsed = parseAssuranceOutcome({ ...(proceed(ROUND_1) as object), approvedBy: 'slot', extra: { nested: true } }, CTX);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.outcome, proceed(ROUND_1));
});

test('assurance: anything outside the contract is a violation', () => {
  const p = { ...proceed(ROUND_1) } as Record<string, unknown>;
  const e = { ...escalate(ROUND_1) } as Record<string, unknown>;
  const r = { ...repair(ROUND_1) } as Record<string, unknown>;
  const b = { ...block(ROUND_1) } as Record<string, unknown>;
  const usage = (over: Record<string, unknown>) => ({ ...p, usage: { ...NO_USAGE, ...over } });
  const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
  const bad: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a string', 'PROCEED'],
    ['an array', [p]],
    ['an unknown kind', { ...p, kind: 'APPROVED' }],
    ['no slot version', without(p, 'slotVersion')],
    ['another slot version', { ...p, slotVersion: 'review-loop/v2' }],
    ['no round key', without(p, 'roundKey')],
    ["another round's key", { ...p, roundKey: 'att-1:assurance:2' }],
    ["another attempt's key", { ...p, roundKey: 'att-2:assurance:1' }],
    ['an empty adjudication id', { ...p, adjudicationId: '' }],
    ['a short adjudication id', { ...p, adjudicationId: 'a'.repeat(63) }],
    ['an uppercase adjudication id', { ...p, adjudicationId: 'A'.repeat(64) }],
    ['no usage', without(p, 'usage')],
    ['negative provider calls', usage({ providerCalls: -1 })],
    ['fractional input tokens', usage({ inputTokens: 1.5 })],
    ['NaN output tokens', usage({ outputTokens: Number.NaN })],
    ['an unsafe provider-call count', usage({ providerCalls: 2 ** 53 })],
    ['a review cost in USD', usage({ reviewCostMicroUsd: 0.25 })],
    ['a negative review cost', usage({ reviewCostMicroUsd: -1 })],
    ['a review cost as a string', usage({ reviewCostMicroUsd: '1' })],
    ['an unsafe review cost', usage({ reviewCostMicroUsd: 2 ** 53 })],
    ['PROCEED without a section field', without(p, 'prBodySectionRef')],
    ['PROCEED with a malformed section', { ...p, prBodySectionRef: { artifactId: 'x', sha256: 'nothex', kind: 'k' } }],
    ['PROCEED in an unknown mode', { ...p, mode: 'auto' }],
    ['PROCEED not-required with a shadow verdict', { ...p, shadow: SHADOW_PROCEED.shadow }],
    ['PROCEED gating with a shadow verdict', { ...p, mode: 'gating', shadow: SHADOW_PROCEED.shadow }],
    ['PROCEED shadow without a verdict', { ...SHADOW_PROCEED, shadow: null }],
    ['a shadow verdict that would block', { ...SHADOW_PROCEED, shadow: { ...SHADOW_PROCEED.shadow, wouldBe: 'BLOCK' } }],
    ['a shadow verdict with an unknown reason', { ...SHADOW_PROCEED, shadow: { ...SHADOW_PROCEED.shadow, reason: 'secret-in-diff' } }],
    ['a shadow verdict with negative findings', { ...SHADOW_PROCEED, shadow: { ...SHADOW_PROCEED.shadow, blockingFindings: -1 } }],
    ['ESCALATE in shadow mode', { ...e, mode: 'shadow' }],
    ['ESCALATE with an unknown reason', { ...e, reason: 'blocking-findings' }],
    ['ESCALATE without a section', { ...e, prBodySectionRef: null }],
    ['REPAIR in shadow mode', { ...r, mode: 'shadow' }],
    ['REPAIR skipping a round', { ...r, nextRound: 3 }],
    ['REPAIR at another base', { ...r, repairBaseSha: shaFor(9) }],
    ['REPAIR without a repair order', without(r, 'repairOrderRef')],
    ['BLOCK with an escalation reason', { ...b, reason: 'reviewer-unavailable' }],
    ['BLOCK in an unknown mode', { ...b, mode: 'auto' }],
    ['BLOCK with a malformed section', { ...b, prBodySectionRef: { artifactId: '', sha256: 'f'.repeat(64), kind: 'k' } }],
  ];
  for (const [label, raw] of bad) assert.equal(parseAssuranceOutcome(raw, CTX).ok, false, label);
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
  assert.deepEqual(outcomes(trace), [[1, 'infrastructure-failed'], [2, 'proceeded']]);
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
  assert.deepEqual(outcomes(trace), [[1, 'agent-failed']]);
  assert.equal(trace.summary.outcome, 'FAILED');
});

test('agent failure: once a push may exist, a failure is terminal and no attempt replaces it', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    upsertPullRequest: () => ({ kind: 'activityFailed', failureClass: 'provider', timedOut: false, effect: 'none' }),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 1);
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.deepEqual(outcomes(trace), [[1, 'infrastructure-failed']]);
});

test('agent failure: replacement stops at maxAttempts', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'activityFailed', failureClass: 'provider', timedOut: false }),
  }));
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 3);
  assert.deepEqual(outcomes(trace), [[1, 'infrastructure-failed'], [2, 'infrastructure-failed'], [3, 'infrastructure-failed']]);
  assert.equal(trace.summary.outcome, 'FAILED');
});

// ---------------------------------------------------------------------------
// Attempt registration that fails
// ---------------------------------------------------------------------------

const registrationFails = () => ({ kind: 'activityFailed' as const, failureClass: 'environment' as const, timedOut: false });

function assertRegistrationFailed(trace: TaskTrace): void {
  const kinds = requestKinds(trace.commands);
  assert.deepEqual(kinds, ['admitTask', 'ensureAttempt', 'findAttempt'], 'the registration is reconciled, never replaced');
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.equal(trace.summary.reason, 'attempt-registration-failed');
  assertLegalProjections(trace);
}

test('registration: ensureAttempt fails but the lookup finds the attempt: it ends infrastructure-failed, unfenced, with zero usage', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ ensureAttempt: registrationFails }));
  assertRegistrationFailed(trace);
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.attemptNumber, o.terminal, o.fence, o.failureClass]),
    [[1, 'infrastructure-failed', null, 'environment']]);
  assert.deepEqual(effectsOf(trace.commands, 'recordUsage').map((u) => [u.attemptNumber, u.chargedCostUsd, u.chargedWallClockMinutes]), [[1, 0, 0]]);
  assert.equal(trace.summary.attempts, 1);
});

test('registration: ensureAttempt fails before the insert: no usage and no outcome for an attempt that does not exist', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    ensureAttempt: registrationFails,
    findAttempt: () => ({ kind: 'findAttempt', attemptId: null }),
  }));
  assertRegistrationFailed(trace);
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome'), []);
  assert.deepEqual(effectsOf(trace.commands, 'recordUsage'), []);
  assert.equal(trace.summary.attempts, 0);
});

/** The attempt's idempotency key: its natural key (task id, attempt number), rendered. */
const attemptKey = (n: number) => `task-1:attempt:${n}`;

/**
 * The store could not tell the attempt's state: the task ends FAILED / attempt-state-unknown whatever cancel is
 * pending, the attempt gets no usage, outcome or release, and the audit and the task result name it by its key.
 */
function assertAttemptStateUnknown(trace: TaskTrace, attemptNumber: number, lookup: string, cancelRequested: boolean): void {
  assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['FAILED', 'attempt-state-unknown'], 'never CANCELLED');
  assert.deepEqual(trace.summary.unrecordedAttempts, [{ attemptNumber, idempotencyKey: attemptKey(attemptNumber) }], 'reported as a gap');
  for (const kind of ['recordAttemptOutcome', 'recordUsage', 'releaseLease'] as const) {
    assert.ok(!effectsOf(trace.commands, kind).some((e) => e.attemptNumber === attemptNumber), `no ${kind} for attempt ${attemptNumber}`);
  }
  assert.deepEqual(effectsOf(trace.commands, 'audit').filter((a) => a.action === 'attempt.state-unknown').map((a) => a.detail), [{
    workflowId: 'asep-task-task-1', attemptNumber, idempotencyKey: attemptKey(attemptNumber), lookup, cancelRequested,
  }], 'the audit carries the idempotency key for an operator');
  assertLegalProjections(trace);
}

test('registration: when the lookup fails too, the task ends FAILED / attempt-state-unknown with the attempt\'s key (the reviewer\'s R29_lookup-failure)', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ ensureAttempt: registrationFails, findAttempt: registrationFails }));
  assert.deepEqual(requestKinds(trace.commands), ['admitTask', 'ensureAttempt', 'findAttempt'], 'never replaced');
  assertAttemptStateUnknown(trace, 1, 'findAttempt', false);
  assert.equal(trace.summary.attempts, 0, 'not known to exist');
});

test('registration: a failed lookup wins over a pending cancel (the reviewer\'s R29_lookup-failure-cancel)', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ ensureAttempt: registrationFails, findAttempt: registrationFails }, {
    eventsDuring: (request) => (request.kind === 'findAttempt' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 0, 'the lookup is not interrupted');
  assertAttemptStateUnknown(trace, 1, 'findAttempt', true);
});

test('registration: a finished task with every terminal recorded reports no unrecorded attempt', () => {
  for (const environment of [scripted(), scripted({ ensureAttempt: registrationFails }), scripted({ inspectWorkspace: () => ({ kind: 'inspectWorkspace', overstep: true }) })]) {
    assert.deepEqual(runTaskSequentially(baseInput(), environment).summary.unrecordedAttempts, []);
  }
});

test('registration: a cancel during ensureAttempt waits for it, then cancels the registered attempt', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    eventsDuring: (request) => (request.kind === 'ensureAttempt' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 0, 'the registration is not interrupted');
  assert.deepEqual(requestKinds(trace.commands), ['admitTask', 'ensureAttempt']);
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
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
    assert.deepEqual(recorded.map((o) => [o.terminal, o.verificationVerdict]), [['verification-stopped', verdict]]);
    assert.equal(trace.summary.outcome, 'FAILED');
    assertLegalProjections(trace);
  });
}

test('a verification activity that gives up is a verification stop with verdict ERROR', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runVerification: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: false }),
  }));
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.terminal, o.verificationVerdict]),
    [['verification-stopped', 'ERROR']]);
  assert.equal(requestKinds(trace.commands).filter((k) => k === 'ensureAttempt').length, 1);
  assert.equal(trace.summary.outcome, 'FAILED');
});

// ---------------------------------------------------------------------------
// Assurance outcome routing
// ---------------------------------------------------------------------------

test('assurance routing: ESCALATE publishes a flagged PR and hands off to human review', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    assuranceRound: (r) => ({ kind: 'assuranceRound', outcome: escalate(r, 'adj-e') }),
  }));
  const pr = requests(trace.commands).find((r) => r.kind === 'upsertPullRequest');
  assert.equal(pr?.kind === 'upsertPullRequest' && pr.flagged, true);
  assert.deepEqual(pr?.kind === 'upsertPullRequest' && pr.prBodySectionRef, ref('esc-adj-e'));
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.terminal, o.adjudicationId]),
    [['escalated', adjudicationId('adj-e')]]);
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
    assuranceRound: (r) => ({ kind: 'assuranceRound', outcome: block(r, 'adj-b') }),
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
      ? { kind: 'assuranceRound', outcome: repair(r, 'adj-r1') }
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
    [[1, 1, null, TASK_BASE], [2, 2, adjudicationId('adj-r1'), TASK_BASE]]);
  assert.deepEqual(rounds.map((r) => r.idempotencyKey), ['att-1:assurance:1', 'att-2:assurance:2']);
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
    assuranceRound: (r) => ({ kind: 'assuranceRound', outcome: repair(r) }),
  }));
  assert.ok(!requestKinds(trace.commands).includes('publishBranch'));
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.equal(trace.summary.reason, 'repair-capacity-exhausted');
  assert.ok(effectsOf(trace.commands, 'quarantineWorkspace').some((e) => e.attemptNumber === 1));
  assert.ok(effectsOf(trace.commands, 'releaseLease').some((e) => e.attemptNumber === 1));
  assertLegalProjections(trace);
});

for (const [name, outcome] of [
  ['an unknown kind', (r: TaskRequest) => ({ ...(proceed(r) as object), kind: 'APPROVED' })],
  ['REPAIR at the wrong base', (r: TaskRequest) => ({ ...(repair(r) as object), repairBaseSha: shaFor(5) })],
  ['REPAIR with a skipped round', (r: TaskRequest) => ({ ...(repair(r) as object), nextRound: 4 })],
  ["an outcome for another round's key", (r: TaskRequest) => ({ ...(proceed(r) as object), roundKey: 'att-1:assurance:2' })],
  ['a review cost in USD', (r: TaskRequest) => ({ ...(proceed(r) as object), usage: { ...NO_USAGE, reviewCostMicroUsd: 0.5 } })],
] as const) {
  test(`assurance routing: ${name} is a contract violation: audited, task FAILED, nothing published`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ assuranceRound: (r) => ({ kind: 'assuranceRound', outcome: outcome(r) }) }));
    assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'review-slot.contract-violation'));
    assert.ok(!requestKinds(trace.commands).includes('publishBranch'));
    assert.deepEqual(outcomes(trace), [[1, 'infrastructure-failed']]);
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
  assert.deepEqual(outcomes(rejected), [[1, 'cancelled']], 'a human\'s no cancels the attempt; it did not fail');
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
    eventsDuring: (request) => (request.kind === 'verifyApprovalDecision'
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
    eventsDuring: (request) => (request.kind === 'runAgent' ? [pause('p1'), pause('p1'), pause('p2')] : []),
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
    eventsDuring: (request) => (request.kind === 'runAgent' ? [resume('r1')] : []),
  }));
  assert.deepEqual(trace.receipts.map((r) => r.reason), ['not-paused']);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('a pause that outlives maxPauseHours blocks the task and cleans up', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    eventsDuring: (request) => (request.kind === 'inspectWorkspace' ? [pause()] : []),
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
    eventsDuring: (request) => (request.kind === 'commitAttempt' ? [cancel()] : []),
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
    eventsDuring: (request) => (request.kind === 'publishBranch' ? [cancel()] : []),
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
    eventsDuring: (request) => (request.kind === 'admitTask' ? [cancel()] : []),
  }));
  assert.deepEqual(requestKinds(trace.commands), ['admitTask']);
  assert.deepEqual(outcomes(trace), []);
  assert.equal(effectsOf(trace.commands, 'releaseLease').length, 0);
  assert.equal(trace.summary.outcome, 'CANCELLED');
});

// Pause while waiting for an approval: nothing is in flight, so the pause applies at once.

const timer = (prefix: string) => (timers: readonly string[]): Extract<TaskEvent, { type: 'timerFired' }> => {
  const id = timers.find((t) => t.startsWith(prefix));
  if (id === undefined) throw new Error(`no ${prefix} timer among ${timers.join(',')}`);
  return { type: 'timerFired', timerId: id };
};

const WAITS = [
  {
    kind: 'budget-extension',
    input: tightBudget,
    approve: () => ({ type: 'approvalDecisionReceived' as const, decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'approve' as const, extensionUsd: 2, principalId: 'human-1' }),
    verified: () => ({ kind: 'verifyApprovalDecision' as const, verified: true, decision: 'approve' as const, extensionUsd: 2 }),
    rejectOutcome: ['BUDGET_EXHAUSTED', 'extension-expired'],
  },
  {
    kind: 'publish-change',
    input: baseInput({ governance: governance({ publicationApprovalRequired: true }) }),
    approve: () => ({ type: 'approvalDecisionReceived' as const, decisionId: 'd1', approvalRequestId: 'asep-task-task-1:1', decision: 'approve' as const, extensionUsd: null, principalId: 'human-1' }),
    verified: () => ({ kind: 'verifyApprovalDecision' as const, verified: true, decision: 'approve' as const, extensionUsd: null }),
    rejectOutcome: ['BLOCKED', 'publication-expired'],
  },
] as const;

function projections(trace: TaskTrace) {
  return effectsOf(trace.commands, 'projectTaskState').map((p) => p.status);
}

for (const wait of WAITS) {
  test(`pause while waiting for a ${wait.kind} approval applies at once; resume returns to the wait`, () => {
    const trace = runTaskSequentially(wait.input, scripted({ verifyApprovalDecision: wait.verified }, {
      whenIdle: idleScript(() => pause(), () => resume(), wait.approve),
    }));
    const statuses = projections(trace);
    const waitAt = statuses.indexOf('WAITING_FOR_APPROVAL');
    assert.deepEqual(statuses.slice(waitAt, waitAt + 3), ['WAITING_FOR_APPROVAL', 'PAUSED', 'WAITING_FOR_APPROVAL']);
    const timers = effectsOf(trace.commands, 'startTimer').map((t) => [t.timerId, t.seconds]);
    assert.deepEqual(timers, [['approval:asep-task-task-1:1', 3600], ['pause:1', 72 * 3600]], 'the pause timer starts, the expiry timer keeps running');
    assert.ok(effectsOf(trace.commands, 'cancelTimer').some((t) => t.timerId === 'pause:1'), 'resume cancels the pause timer');
    assert.deepEqual(effectsOf(trace.commands, 'recordControl').map((c) => c.control), ['pause', 'resume']);
    assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
    assertLegalProjections(trace);
  });

  test(`pause while waiting for a ${wait.kind} approval does not suspend expiry: expiry takes the reject path`, () => {
    const trace = runTaskSequentially(wait.input, scripted({}, {
      whenIdle: idleScript(() => pause(), timer('approval:')),
    }));
    assert.ok(projections(trace).includes('PAUSED'), 'the pause applied');
    assert.deepEqual(effectsOf(trace.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
    assert.ok(effectsOf(trace.commands, 'cancelTimer').some((t) => t.timerId === 'pause:1'), 'the pause timer is cancelled at close');
    assert.deepEqual([trace.summary.outcome, trace.summary.reason], wait.rejectOutcome);
    assertLegalProjections(trace);
  });

  test(`a pause timeout while waiting for a ${wait.kind} approval blocks the task and closes the request`, () => {
    const trace = runTaskSequentially(wait.input, scripted({}, {
      whenIdle: idleScript(() => pause(), timer('pause:')),
    }));
    assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['BLOCKED', 'pause-timeout']);
    assert.deepEqual(effectsOf(trace.commands, 'cancelApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
    assert.ok(effectsOf(trace.commands, 'cancelTimer').some((t) => t.timerId === 'approval:asep-task-task-1:1'), 'expiry timer cancelled');
    assertLegalProjections(trace);
  });
}

test('a pause that arrives while the approval request is opened applies once the task waits', () => {
  const trace = runTaskSequentially(WAITS[1].input, scripted({ verifyApprovalDecision: WAITS[1].verified }, {
    eventsDuring: (request) => (request.kind === 'openApprovalRequest' ? [pause()] : []),
    whenIdle: idleScript(() => resume(), WAITS[1].approve),
  }));
  const statuses = projections(trace);
  const waitAt = statuses.indexOf('WAITING_FOR_APPROVAL');
  assert.deepEqual(statuses.slice(waitAt, waitAt + 3), ['WAITING_FOR_APPROVAL', 'PAUSED', 'WAITING_FOR_APPROVAL']);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

test('a decision that releases the gate while paused is verified, and the push waits for resume', () => {
  const trace = runTaskSequentially(WAITS[1].input, scripted({ verifyApprovalDecision: WAITS[1].verified }, {
    whenIdle: idleScript(() => pause(), WAITS[1].approve, () => resume()),
  }));
  const pausedAt = indexOfCommand(trace.commands, (c) => c.type === 'effect' && c.effect.kind === 'projectTaskState' && c.effect.status === 'PAUSED');
  const verifyAt = indexOfCommand(trace.commands, (c) => c.type === 'request' && c.request.kind === 'verifyApprovalDecision');
  const resumeAt = indexOfCommand(trace.commands, (c) => c.type === 'effect' && c.effect.kind === 'recordControl' && c.effect.control === 'resume');
  const pushAt = indexOfCommand(trace.commands, (c) => c.type === 'request' && c.request.kind === 'publishBranch');
  assert.ok(pausedAt >= 0 && pausedAt < verifyAt, 'paused before the decision arrived');
  assert.ok(resumeAt > verifyAt && pushAt > resumeAt, 'the push waits for resume');
  assert.equal(effectsOf(trace.commands, 'startTimer').filter((t) => t.timerId.startsWith('pause:')).length, 1, 'one pause, one timer');
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  assertLegalProjections(trace);
});

test('a resume that arrives while a decision is verified returns the task to the wait when the decision is unconfirmed', () => {
  const unverified = () => ({ kind: 'verifyApprovalDecision' as const, verified: false, decision: null, extensionUsd: null });
  const trace = runTaskSequentially(WAITS[1].input, scripted({ verifyApprovalDecision: unverified }, {
    eventsDuring: (request) => (request.kind === 'verifyApprovalDecision' ? [resume()] : []),
    whenIdle: idleScript(() => pause(), WAITS[1].approve, timer('approval:')),
  }));
  const statuses = projections(trace);
  const waitAt = statuses.indexOf('WAITING_FOR_APPROVAL');
  assert.deepEqual(statuses.slice(waitAt), ['WAITING_FOR_APPROVAL', 'PAUSED', 'WAITING_FOR_APPROVAL', 'BLOCKED']);
  assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['BLOCKED', 'publication-expired']);
  assertLegalProjections(trace);
});

// Approval races: the expiry timer and controls can arrive while a decision is being verified.

function assertGateHeld(trace: TaskTrace): void {
  assert.deepEqual(effectsOf(trace.commands, 'recordExtension'), [], 'no extension recorded');
  const kinds = requestKinds(trace.commands);
  assert.ok(!kinds.includes('publishBranch'), 'nothing pushed');
  const openedAt = kinds.indexOf('openApprovalRequest');
  assert.ok(openedAt >= 0 && !kinds.slice(openedAt).includes('ensureAttempt'), 'no attempt after the approval request');
}

for (const wait of WAITS) {
  const duringVerification = (events: readonly ((timers: readonly string[]) => Extract<TaskEvent, { type: 'timerFired' }> | TaskMessage)[]) =>
    (request: TaskRequest, timers: readonly string[]) => (request.kind === 'verifyApprovalDecision' ? events.map((e) => e(timers)) : []);

  test(`an expiry that fires while a ${wait.kind} decision is verified wins: the request expires though the decision verifies`, () => {
    const trace = runTaskSequentially(wait.input, scripted({ verifyApprovalDecision: wait.verified }, {
      eventsDuring: duringVerification([timer('approval:')]),
      whenIdle: idleScript(wait.approve),
    }));
    assert.deepEqual(effectsOf(trace.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
    assertGateHeld(trace);
    assert.deepEqual([trace.summary.outcome, trace.summary.reason], wait.rejectOutcome);
    assertLegalProjections(trace);
  });

  test(`an unconfirmed ${wait.kind} decision never releases the gate, even with a valid decision and amount`, () => {
    const unconfirmed = () => ({ ...wait.verified(), verified: false });
    const trace = runTaskSequentially(wait.input, scripted({ verifyApprovalDecision: unconfirmed }, {
      whenIdle: idleScript(wait.approve, timer('approval:')),
    }));
    assert.deepEqual(effectsOf(trace.commands, 'audit').filter((a) => a.action === 'approval.unverified').map((a) => a.detail['decisionId']), ['d1']);
    assertGateHeld(trace);
    assert.deepEqual(effectsOf(trace.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
    assert.deepEqual([trace.summary.outcome, trace.summary.reason], wait.rejectOutcome);
    assertLegalProjections(trace);
  });

  test(`a confirmed ${wait.kind} approve whose content is not valid for the kind never releases the gate`, () => {
    const invalidAmounts = wait.kind === 'budget-extension' ? [null, 0, -2, 0.0000001, 1e9] : [4, 0.5];
    for (const extensionUsd of invalidAmounts) {
      const confirmed = () => ({ ...wait.verified(), extensionUsd });
      const trace = runTaskSequentially(wait.input, scripted({ verifyApprovalDecision: confirmed }, {
        whenIdle: idleScript(wait.approve, timer('approval:')),
      }));
      assert.deepEqual(effectsOf(trace.commands, 'audit').filter((a) => a.action === 'approval.unverified').map((a) => a.detail['decisionId']), ['d1'], `${extensionUsd}`);
      assertGateHeld(trace);
      assert.deepEqual([trace.summary.outcome, trace.summary.reason], wait.rejectOutcome, `${extensionUsd}`);
      assertLegalProjections(trace);
    }
  });

  test(`a cancel and the expiry while a ${wait.kind} decision is verified: the request expires, nothing is released, the task ends CANCELLED`, () => {
    const trace = runTaskSequentially(wait.input, scripted({ verifyApprovalDecision: wait.verified }, {
      eventsDuring: duringVerification([() => cancel(), timer('approval:')]),
      whenIdle: idleScript(wait.approve),
    }));
    assert.deepEqual(effectsOf(trace.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), ['asep-task-task-1:1']);
    assertGateHeld(trace);
    assert.equal(trace.summary.outcome, 'CANCELLED');
    assertLegalProjections(trace);
  });
}

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
  ['reported cost above the cap', { status: 'AGENT_DONE', reportedCostUsd: 7, reportedToolCalls: 10, wallClockMs: 1000 }, { overrunUsd: 2, overrunToolCalls: 0, overrunWallClockMs: 0, usageOutOfBound: false }],
  ['reported tool calls above the cap', { status: 'AGENT_DONE', reportedCostUsd: 1, reportedToolCalls: 53, wallClockMs: 1000 }, { overrunUsd: 0, overrunToolCalls: 3, overrunWallClockMs: 0, usageOutOfBound: false }],
  ['a replaceable agent failure that also overran its cost', { status: 'FAILED', reportedCostUsd: 7, reportedToolCalls: 10, wallClockMs: 1000 }, { overrunUsd: 2, overrunToolCalls: 0, overrunWallClockMs: 0, usageOutOfBound: false }],
  // The cap is 30 minutes and the default kill grace is 0: one millisecond more is an overrun.
  ['measured wall-clock above the cap', { status: 'AGENT_DONE', reportedCostUsd: 1, reportedToolCalls: 10, wallClockMs: 1_800_001 }, { overrunUsd: 0, overrunToolCalls: 0, overrunWallClockMs: 1, usageOutOfBound: false }],
  ['a cap stop measured above the cap', { status: 'BUDGET_EXHAUSTED', reportedCostUsd: 1, reportedToolCalls: 10, wallClockMs: 2_040_000 }, { overrunUsd: 0, overrunToolCalls: 0, overrunWallClockMs: 240_000, usageOutOfBound: false }],
] as const) {
  test(`agent outcome: ${name} is an overrun: recorded and audited, never verified or published, and the task ends BUDGET_EXHAUSTED`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      runAgent: () => ({ kind: 'runAgent', failureClass: answer.status === 'FAILED' ? 'provider' : null, ...answer }),
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
    assert.deepEqual(outcomes(trace), [[1, 'agent-failed']]);
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
  assert.deepEqual(outcomes(trace), [[1, 'infrastructure-failed']]);
  assert.equal(ensured(trace).length, 1);
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'task-budget');
});

// Wall-clock: the cap is 30 minutes (1 800 000 ms); a kill grace of 30 s is the only tolerance.
const withGrace = baseInput({ policy: policy({ agentKillGraceSeconds: 30 }) });
const agentDoneAfter = (wallClockMs: number) => scripted({
  runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 1, reportedToolCalls: 10, wallClockMs, failureClass: null }),
});

for (const [name, wallClockMs] of [['exactly at the cap', 1_800_000], ['at the cap plus the kill grace', 1_830_000]] as const) {
  test(`wall-clock: AGENT_DONE measured ${name} gets the full path`, () => {
    const trace = runTaskSequentially(withGrace, agentDoneAfter(wallClockMs));
    assert.deepEqual(requestsOfAttempt(trace, 1).slice(-6), [
      'runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound', 'publishBranch', 'upsertPullRequest',
    ]);
    assert.deepEqual(effectsOf(trace.commands, 'recordOverrun'), []);
    assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  });
}

test('wall-clock: AGENT_DONE measured one millisecond above the cap plus the kill grace is an overrun: inspected only, audited, nothing published', () => {
  const trace = runTaskSequentially(withGrace, agentDoneAfter(1_830_001));
  const kinds = requestKinds(trace.commands);
  assert.ok(kinds.includes('inspectWorkspace'), 'the overrun attempt is inspected');
  for (const k of NEVER_AFTER_EXHAUSTION) assert.ok(!kinds.includes(k), `${k} after a wall-clock overrun`);
  // The recorded excess is measured from the cap, not from the end of the grace.
  assert.deepEqual(effectsOf(trace.commands, 'recordOverrun'),
    [{ kind: 'recordOverrun', attemptNumber: 1, overrunUsd: 0, overrunToolCalls: 0, overrunWallClockMs: 30_001, usageOutOfBound: false }]);
  const incident = effectsOf(trace.commands, 'audit').find((a) => a.action === 'budget.overrun');
  assert.equal(incident?.detail['overrunWallClockMs'], 30_001, 'overrun incident audited with the excess');
  assert.deepEqual(outcomes(trace), [[1, 'budget-exhausted']]);
  assert.equal(trace.summary.outcome, 'BUDGET_EXHAUSTED');
  assert.equal(trace.summary.reason, 'overrun');
  assertLegalProjections(trace);
});

test('wall-clock: a non-replaceable failure still beats a wall-clock overrun, which is still recorded', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'FAILED', reportedCostUsd: 1, reportedToolCalls: 10, wallClockMs: 1_900_000, failureClass: 'policy-violation' }),
  }));
  assert.ok(!requestKinds(trace.commands).includes('inspectWorkspace'), 'not inspected');
  assert.deepEqual(effectsOf(trace.commands, 'recordOverrun').map((o) => o.overrunWallClockMs), [100_000]);
  assert.equal(trace.summary.outcome, 'FAILED');
  assert.equal(trace.summary.reason, 'policy-violation');
});

test('wall-clock: the policy rule requires the kill grace to be a whole number of seconds, zero or more', () => {
  assert.deepEqual(orchestrationPolicyErrors(policy({ agentKillGraceSeconds: 30 })), []);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(orchestrationPolicyErrors(policy({ agentKillGraceSeconds: bad })),
      ['agentKillGraceSeconds: must be a whole number of seconds, zero or more'], String(bad));
  }
});

test('defaults: no kill grace in code; without a stated adapter interval there is no wall-clock tolerance', () => {
  assert.equal(DEFAULT_ORCHESTRATION_POLICY.agentKillGraceSeconds, 0);
});

// ---------------------------------------------------------------------------
// Never-replaceable failure classes, whatever the policy says
// ---------------------------------------------------------------------------

const NEVER = ['policy-violation', 'false-completion', 'duplicate-side-effect'] as const;

function hostilePolicy(failureClass: (typeof NEVER)[number]) {
  return policy({ replaceableFailureClasses: [...DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses, failureClass] });
}

function assertEndsAfterOneAttempt(trace: TaskTrace, reason: string, terminal: 'agent-failed' | 'infrastructure-failed'): void {
  assert.equal(ensured(trace).length, 1, 'no attempt follows a never-replaceable failure');
  const kinds = requestKinds(trace.commands);
  assert.ok(!kinds.includes('publishBranch') && !kinds.includes('upsertPullRequest'), 'nothing is published');
  assert.ok(!kinds.includes('openApprovalRequest'), 'no budget-extension approval');
  assert.deepEqual(outcomes(trace), [[1, terminal]]);
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
      assertEndsAfterOneAttempt(trace, never, 'agent-failed');
      assert.equal(effectsOf(trace.commands, 'recordOverrun').length, reportedCostUsd > 5 ? 1 : 0, 'an overrun is still recorded');
    });
  }

  test(`never replaceable: a hostile policy that lists ${never} still ends the task FAILED after one attempt (activity failure)`, () => {
    const trace = runTaskSequentially(baseInput({ policy: hostilePolicy(never) }), scripted({
      runAgent: () => ({ kind: 'activityFailed', failureClass: never, timedOut: false }),
    }));
    assertEndsAfterOneAttempt(trace, never, 'infrastructure-failed');
  });
}

test('never replaceable: an overstep is a policy violation and is not retried under a policy that lists policy-violation', () => {
  const trace = runTaskSequentially(baseInput({ policy: hostilePolicy('policy-violation') }), scripted({
    inspectWorkspace: () => ({ kind: 'inspectWorkspace', overstep: true }),
  }));
  assertEndsAfterOneAttempt(trace, 'policy-violation', 'agent-failed');
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
    assuranceRound: (r, n) => (n === 1 ? { kind: 'assuranceRound', outcome: repair(r) } : undefined),
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
  assert.deepEqual(rounds.map((r) => [r.attemptNumber, r.round, r.priorAdjudicationId]), [[1, 1, null], [2, 2, adjudicationId('adj-r1')]]);
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
    [[1, 1, null, TASK_BASE], [3, 2, adjudicationId('adj-r1'), TASK_BASE]]);
  assert.deepEqual(outcomes(trace), [[1, 'repair-requested'], [2, 'infrastructure-failed'], [3, 'proceeded']]);
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
    eventsDuring: (request) => (request.kind === 'assuranceRound' ? [cancel()] : []),
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
    eventsDuring: (request) => (request.kind === 'persistEvidence' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 0);
  const kinds = requestKinds(trace.commands);
  assert.equal(kinds.filter((k) => k === 'persistEvidence').length, 1);
  assert.ok(!kinds.includes('assuranceRound') && !kinds.includes('publishBranch'), 'no assurance and no push after the cancel');
  assert.equal(trace.summary.outcome, 'CANCELLED');
});

// ---------------------------------------------------------------------------
// Publication: the reported effect, never retryability, decides what the remote holds
// ---------------------------------------------------------------------------

const publicationFails = (effect?: PublicationEffect, failureClass: FailureClass = 'provider') => () => ({
  kind: 'activityFailed' as const, failureClass, timedOut: false, ...(effect === undefined ? {} : { effect }),
});
/** A reconciliation read: the attempt branch at `branchHeadSha` (null: absent) in `branchRepository`, and the PRs listed for it. */
const reconciled = (branchHeadSha: string | null, pullRequests: readonly ObservedPullRequest[] = [], branchRepository: ForgeRepository = TASK_REPOSITORY) => () => ({
  kind: 'reconcilePublication' as const,
  branch: branchHeadSha === null ? null : { repository: branchRepository, headSha: branchHeadSha },
  pullRequests,
});
/**
 * A PR of attempt 1 as a read reports it: by default exactly the attempt's (open and unmerged, in the binding
 * repository, its branch and commit as head, the task base as base).
 */
const prOfAttempt = (number: number, overrides: Partial<ObservedPullRequest> = {}): ObservedPullRequest => ({
  number,
  headRepository: TASK_REPOSITORY,
  headBranch: branchFor(1),
  headSha: shaFor(1),
  baseRepository: TASK_REPOSITORY,
  baseBranch: TASK_BASE_BRANCH,
  state: 'open',
  merged: false,
  contentRepaired: false,
  ...overrides,
});
const OTHER_SHA = 'f'.repeat(40);
const cancelDuring = (kind: TaskRequestKind) => (request: TaskRequest) => (request.kind === kind ? [cancel()] : []);

function assertPublicationIncomplete(trace: TaskTrace, pushConfirmed: boolean, cancelRequested: boolean, finding: string): void {
  assert.equal(trace.summary.outcome, 'FAILED', 'an unreconciled publication is never CANCELLED');
  assert.equal(trace.summary.reason, 'publication-incomplete');
  assert.equal(trace.summary.prNumber, null);
  const audit = effectsOf(trace.commands, 'audit').find((a) => a.action === 'publication.incomplete');
  const { observed, ...detail } = audit?.detail ?? {};
  assert.deepEqual(detail, {
    workflowId: 'asep-task-task-1', attemptNumber: 1, remoteBranch: branchFor(1), pushConfirmed, cancelRequested, finding,
  }, 'the audit names the remote branch and what was found');
  // A reconciliation read is quoted in the audit as it was observed; without a read there is nothing to quote.
  const read = trace.events.flatMap((e) => (e.type === 'result' && e.result.kind === 'reconcilePublication' ? [e.result] : []));
  assert.equal(observed, read.length === 0 ? undefined : JSON.stringify({ branch: read[0]!.branch, pullRequests: read[0]!.pullRequests }));
  assert.ok(!effectsOf(trace.commands, 'audit').some((a) => a.action === 'workflow.cancel.after-publication'), 'no PR to leave open');
  assert.deepEqual(outcomes(trace), [[1, 'infrastructure-failed']]);
  assertLegalProjections(trace);
}

function assertPublished(trace: TaskTrace, prNumber: number, cancelled: boolean): void {
  assert.equal(trace.summary.prNumber, prNumber);
  if (cancelled) {
    assert.equal(trace.summary.outcome, 'CANCELLED');
    assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'workflow.cancel.after-publication'), 'the PR stays open and is audited');
  } else {
    assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
  }
  assertLegalProjections(trace);
}

function assertNothingPublished(trace: TaskTrace, cancelled: boolean): void {
  assert.deepEqual([trace.summary.outcome, trace.summary.reason], cancelled ? ['CANCELLED', 'cancelled'] : ['FAILED', 'publication-failed']);
  assert.ok(!requestKinds(trace.commands).includes('upsertPullRequest'), 'no PR upsert when nothing was pushed');
  assert.equal(trace.summary.prNumber, null);
  assertLegalProjections(trace);
}

const reconcileRequests = (trace: TaskTrace) => requests(trace.commands).filter((r) => r.kind === 'reconcilePublication');

test('publication: a push that reached the remote and then failed with a fencing error is reconciled, and its PR lands, also with a cancel pending', () => {
  // The push landed, then the side-effect log refused to complete (a fencing error after the forge call): the
  // activity cannot know the remote state, so the effect is unknown, whatever the error's retryability.
  for (const cancelled of [false, true]) {
    const trace = runTaskSequentially(baseInput(), scripted({ publishBranch: publicationFails('unknown', 'duplicate-side-effect') }, {
      eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [],
    }));
    assert.deepEqual(reconcileRequests(trace), [{
      kind: 'reconcilePublication', attemptNumber: 1, repository: TASK_REPOSITORY, remoteBranch: branchFor(1), expectedHeadSha: shaFor(1),
      expectedBaseBranch: TASK_BASE_BRANCH,
    }], 'the remote is read before any terminal state');
    assert.equal(requestKinds(trace.commands).filter((k) => k === 'upsertPullRequest').length, 1, 'the branch is there, so its PR upsert runs');
    assert.equal(trace.aborts, 0);
    assertPublished(trace, 7, cancelled);
  }
});

test('publication: a push failure that reports no effect is read as unknown and reconciled', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ publishBranch: publicationFails(), reconcilePublication: reconciled(null) }));
  assert.equal(reconcileRequests(trace).length, 1);
  assertNothingPublished(trace, false);
});

for (const cancelled of [false, true]) {
  const during = cancelled ? cancelDuring('publishBranch') : () => [];
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';

  test(`publication: a push failure proved to precede the forge call (effect none) publishes nothing, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ publishBranch: publicationFails('none') }, { eventsDuring: during }));
    assert.equal(reconcileRequests(trace).length, 0, 'nothing to reconcile');
    assertNothingPublished(trace, cancelled);
  });

  test(`publication: a push failure that reports the push applied continues as a completed push, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ publishBranch: publicationFails('applied') }, { eventsDuring: during }));
    assert.equal(reconcileRequests(trace).length, 0, 'the effect is known');
    assertPublished(trace, 7, cancelled);
  });

  test(`publication: an unknown push effect reconciled as absent publishes nothing, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(null),
    }, { eventsDuring: during }));
    assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
    assertNothingPublished(trace, cancelled);
  });

  test(`publication: an unknown push effect with the branch at another commit cannot reconcile: FAILED / publication-incomplete, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      publishBranch: publicationFails('unknown'), reconcilePublication: reconciled('d'.repeat(40)),
    }, { eventsDuring: during }));
    assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
    assert.ok(!requestKinds(trace.commands).includes('upsertPullRequest'), 'no PR for a branch that is not the attempt commit');
    assertPublicationIncomplete(trace, false, cancelled, 'branch-moved');
  });

  test(`publication: an unknown push effect whose reconciliation fails ends FAILED / publication-incomplete, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      publishBranch: publicationFails('unknown'), reconcilePublication: publicationFails(),
    }, { eventsDuring: during }));
    assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
    assertPublicationIncomplete(trace, false, cancelled, 'remote-unreadable');
  });

  const duringPush = cancelled ? cancelDuring('publishBranch') : () => [];

  test(`publication: a PR upsert that fails with effect none after a confirmed push ends FAILED / publication-incomplete, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ upsertPullRequest: publicationFails('none') }, { eventsDuring: duringPush }));
    assert.equal(reconcileRequests(trace).length, 0, 'the PR is known to be absent');
    assert.equal(trace.aborts, 0);
    assertPublicationIncomplete(trace, true, cancelled, 'upsert-not-applied');
  });

  for (const effect of ['unknown', 'applied'] as const) {
    test(`publication: a PR upsert that fails with effect ${effect} is reconciled; a PR found counts as upserted, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        upsertPullRequest: publicationFails(effect), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9)]),
      }, { eventsDuring: duringPush }));
      assert.deepEqual(reconcileRequests(trace).map((r) => r.attemptNumber), [1]);
      assertPublished(trace, 9, cancelled);
    });
  }

  test(`publication: a PR upsert with an unknown effect and no PR found ends FAILED / publication-incomplete, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1)),
    }, { eventsDuring: duringPush }));
    assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
    assertPublicationIncomplete(trace, true, cancelled, 'pull-request-missing');
  });

  test(`publication: a PR upsert with an unknown effect whose reconciliation fails ends FAILED / publication-incomplete, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      upsertPullRequest: publicationFails('unknown'), reconcilePublication: publicationFails(),
    }, { eventsDuring: duringPush }));
    assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
    assertPublicationIncomplete(trace, true, cancelled, 'remote-unreadable');
  });
}

// A reconciliation settles a publication only when the remote is exactly this attempt's: the branch tip is the
// attempt's commit, and a PR, if any, has that branch as head, that commit as head SHA and the task's base branch.
// The same rule holds after the push and after the PR upsert; anything else is not reconciled.
const NOT_THIS_ATTEMPT: readonly (readonly [string, string | null, ObservedPullRequest, string])[] = [
  ['the branch moved to another commit and a PR follows it', OTHER_SHA, prOfAttempt(9, { headSha: OTHER_SHA }), 'branch-moved'],
  ['the branch moved to another commit and the PR is still at the attempt commit', OTHER_SHA, prOfAttempt(9), 'branch-moved'],
  ['the branch is at the attempt commit but the PR head is another commit', shaFor(1), prOfAttempt(9, { headSha: OTHER_SHA }), 'pull-request-other-head'],
  ['the branch is at the attempt commit but the PR head is another branch', shaFor(1), prOfAttempt(9, { headBranch: 'asep/run-1/task-1/att-9' }), 'pull-request-other-head'],
  ['the branch is at the attempt commit but the PR targets another base', shaFor(1), prOfAttempt(9, { baseBranch: 'release' }), 'pull-request-other-base'],
  ['the branch is missing while a PR for it is open', null, prOfAttempt(9), 'branch-missing'],
];

for (const cancelled of [false, true]) {
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';

  test(`publication: a PR found after a failed PR upsert while the branch holds another commit is not this attempt's publication, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(OTHER_SHA, [prOfAttempt(9, { headSha: OTHER_SHA })]),
    }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
    assertPublicationIncomplete(trace, true, cancelled, 'branch-moved');
  });

  for (const [name, branchHeadSha, pullRequest, finding] of NOT_THIS_ATTEMPT) {
    test(`publication: after a failed PR upsert, ${name}: FAILED / publication-incomplete, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(branchHeadSha, [pullRequest]),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
      assertPublicationIncomplete(trace, true, cancelled, finding);
    });

    test(`publication: after an unknown push, ${name}: FAILED / publication-incomplete, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(branchHeadSha, [pullRequest]),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assert.equal(reconcileRequests(trace).length, 1, 'the remote is read before any terminal state');
      assert.ok(!requestKinds(trace.commands).includes('upsertPullRequest'), 'no PR upsert for a remote that is not this attempt');
      assertPublicationIncomplete(trace, false, cancelled, finding);
    });
  }

  test(`publication: after an unknown push, the attempt's branch with the attempt's own PR is a confirmed push, and the upsert runs, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9)]),
    }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
    const upserts = requests(trace.commands).filter((r) => r.kind === 'upsertPullRequest');
    assert.deepEqual(upserts.map((r) => r.kind === 'upsertPullRequest' && r.baseBranch), [TASK_BASE_BRANCH], 'the PR targets the task base');
    assertPublished(trace, 7, cancelled);
  });
}

// The full observation: a candidate that matches the attempt's branch, head SHA and base is still not the attempt's
// when it comes from a fork, is closed or merged, or is one of several, or when the branch or the PR's base lies in
// another repository. A repository is its forge id, so another repository that took over the binding's owner and
// name after a rename is another repository too, and a branch name compares exactly, case included. The first four
// rows are the reviewer's IDENTITY_MATRIX, the three after the branch row its RENAME_SLUG_REUSE, and the last its
// M_HEAD_CASE_COUNTEREXAMPLE.
const FORK: ForgeRepository = { id: 9001, owner: 'attacker', name: 'fork' };
const REUSED_PATHNAME: ForgeRepository = { id: 202, owner: TASK_REPOSITORY.owner, name: TASK_REPOSITORY.name };
const NOT_THIS_ATTEMPTS_PR: readonly (readonly [string, readonly ObservedPullRequest[], string, ForgeRepository])[] = [
  ['a PR from a fork with the same branch name', [prOfAttempt(9, { headRepository: FORK })], 'pull-request-fork-head', TASK_REPOSITORY],
  ['a closed PR', [prOfAttempt(9, { state: 'closed' })], 'pull-request-closed', TASK_REPOSITORY],
  ['a merged PR', [prOfAttempt(9, { state: 'closed', merged: true })], 'pull-request-merged', TASK_REPOSITORY],
  ['two PRs for the branch', [prOfAttempt(9), prOfAttempt(10)], 'pull-requests-multiple', TASK_REPOSITORY],
  ['the attempt\'s PR beside a closed one', [prOfAttempt(9), prOfAttempt(8, { state: 'closed' })], 'pull-requests-multiple', TASK_REPOSITORY],
  ['a PR into another repository', [prOfAttempt(9, { baseRepository: FORK })], 'pull-request-other-base', TASK_REPOSITORY],
  ['the branch in another repository', [prOfAttempt(9)], 'branch-other-repository', FORK],
  ['the branch in another repository at the binding\'s owner and name', [prOfAttempt(9)], 'branch-other-repository', REUSED_PATHNAME],
  ['a PR from another repository at the binding\'s owner and name', [prOfAttempt(9, { headRepository: REUSED_PATHNAME })], 'pull-request-fork-head', TASK_REPOSITORY],
  ['a PR into another repository at the binding\'s owner and name', [prOfAttempt(9, { baseRepository: REUSED_PATHNAME })], 'pull-request-other-base', TASK_REPOSITORY],
  ['a PR whose head branch differs from the attempt branch only in case', [prOfAttempt(9, { headBranch: branchFor(1).toUpperCase() })], 'pull-request-other-head', TASK_REPOSITORY],
];

for (const cancelled of [false, true]) {
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';
  for (const [name, pullRequests, finding, branchRepository] of NOT_THIS_ATTEMPTS_PR) {
    test(`publication identity: after an unknown push, ${name} is not this attempt's: FAILED / publication-incomplete, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), pullRequests, branchRepository),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assert.ok(!requestKinds(trace.commands).includes('upsertPullRequest'), 'no PR upsert for a remote that is not this attempt');
      assertPublicationIncomplete(trace, false, cancelled, finding);
    });

    test(`publication identity: after a failed PR upsert, ${name} is not this attempt's: FAILED / publication-incomplete, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), pullRequests, branchRepository),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assertPublicationIncomplete(trace, true, cancelled, finding);
    });
  }
}

// The binding repository renamed or transferred: the forge keeps its id, so the publication is still the attempt's,
// and the new owner and name are audited.
const RENAMED: readonly (readonly [string, ForgeRepository])[] = [
  ['renamed', { id: TASK_REPOSITORY.id, owner: TASK_REPOSITORY.owner, name: 'gadgets' }],
  ['transferred', { id: TASK_REPOSITORY.id, owner: 'acme-corp', name: TASK_REPOSITORY.name }],
  ['re-cased', { id: TASK_REPOSITORY.id, owner: 'Acme', name: 'Widgets' }],
];

/** The read showed the binding repository under each of `observed`, in that order, and each is audited once. */
function assertRenameAudited(trace: TaskTrace, ...observed: readonly ForgeRepository[]): void {
  assert.deepEqual(effectsOf(trace.commands, 'audit').filter((a) => a.action === 'publication.repository-renamed').map((a) => a.detail),
    observed.map((r) => ({
      workflowId: 'asep-task-task-1', attemptNumber: 1, repositoryId: TASK_REPOSITORY.id,
      bound: `${TASK_REPOSITORY.owner}/${TASK_REPOSITORY.name}`, observed: `${r.owner}/${r.name}`,
    })));
}

for (const cancelled of [false, true]) {
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';
  for (const [how, moved] of RENAMED) {
    const pr = prOfAttempt(9, { headRepository: moved, baseRepository: moved });

    test(`publication identity: after a failed PR upsert, the binding repository ${how} (same forge id) is still the attempt's and the move is audited, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [pr], moved),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assertPublished(trace, 9, cancelled);
      assertRenameAudited(trace, moved);
    });

    test(`publication identity: after an unknown push, the binding repository ${how} (same forge id) is a confirmed push and the move is audited, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [pr], moved),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assert.equal(requestKinds(trace.commands).filter((k) => k === 'upsertPullRequest').length, 1, 'a confirmed push');
      assertPublished(trace, 7, cancelled);
      assertRenameAudited(trace, moved);
    });
  }
}

// An observed repository id the forge could never report for the binding: missing, zero, negative, unsafe, or the
// binding's id as a string. Ids compare strictly, so none of them is the binding's, wherever it appears.
const MALFORMED_IDS: readonly (readonly [string, unknown])[] = [
  ['missing', undefined],
  ['zero', 0],
  ['negative', -TASK_REPOSITORY.id],
  ['unsafe', 2 ** 53 + 2],
  ['the binding id as a string', String(TASK_REPOSITORY.id)],
];
const withObservedId = (id: unknown): ForgeRepository =>
  (id === undefined ? { owner: TASK_REPOSITORY.owner, name: TASK_REPOSITORY.name } : { ...TASK_REPOSITORY, id }) as unknown as ForgeRepository;
const OBSERVED_AT: readonly (readonly [string, (r: ForgeRepository) => readonly [ObservedPullRequest, ForgeRepository], string])[] = [
  ['branch', (r) => [prOfAttempt(9), r], 'branch-other-repository'],
  ['PR head', (r) => [prOfAttempt(9, { headRepository: r }), TASK_REPOSITORY], 'pull-request-fork-head'],
  ['PR base', (r) => [prOfAttempt(9, { baseRepository: r }), TASK_REPOSITORY], 'pull-request-other-base'],
];

for (const [idName, id] of MALFORMED_IDS) {
  for (const [where, place, finding] of OBSERVED_AT) {
    test(`publication identity: a ${where} repository observed with an id that is ${idName} is not the binding's, on both paths, with and without a cancel`, () => {
      const [pr, branchRepository] = place(withObservedId(id));
      for (const failing of ['publishBranch', 'upsertPullRequest'] as const) {
        for (const cancelled of [false, true]) {
          const trace = runTaskSequentially(baseInput(), scripted({
            [failing]: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [pr], branchRepository),
          }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
          assertPublicationIncomplete(trace, failing === 'upsertPullRequest', cancelled, finding);
        }
      }
    });
  }
}

// A rename only the PR shows: its head or base, or both, carries the binding's id under the new owner and name while
// the branch read shows the bound ones. The reviewer's RENAME_PR_ONLY_MATRIX.
const MOVED: ForgeRepository = { id: TASK_REPOSITORY.id, owner: 'acme-corp', name: 'gadgets' };
const PR_ONLY_RENAMES: readonly (readonly [string, Partial<ObservedPullRequest>])[] = [
  ['head', { headRepository: MOVED }],
  ['base', { baseRepository: MOVED }],
  ['head and base', { headRepository: MOVED, baseRepository: MOVED }],
];

for (const cancelled of [false, true]) {
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';
  for (const [where, overrides] of PR_ONLY_RENAMES) {
    test(`publication identity: after a failed PR upsert, a rename only the PR's ${where} shows is audited once, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, overrides)]),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assertPublished(trace, 9, cancelled);
      assertRenameAudited(trace, MOVED);
    });

    test(`publication identity: after an unknown push, a rename only the PR's ${where} shows is audited once, ${when}`, () => {
      const trace = runTaskSequentially(baseInput(), scripted({
        publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, overrides)]),
      }, { eventsDuring: cancelled ? cancelDuring('publishBranch') : () => [] }));
      assertPublished(trace, 7, cancelled);
      assertRenameAudited(trace, MOVED);
    });
  }
}

test('publication identity: each owner and name the read shows under the binding id is audited once, in the order read', () => {
  const branchMoved: ForgeRepository = { id: TASK_REPOSITORY.id, owner: TASK_REPOSITORY.owner, name: 'gadgets' };
  const trace = runTaskSequentially(baseInput(), scripted({
    upsertPullRequest: publicationFails('unknown'),
    reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, { headRepository: MOVED, baseRepository: branchMoved })], branchMoved),
  }));
  assertPublished(trace, 9, false);
  assertRenameAudited(trace, branchMoved, MOVED);
});

test('publication identity: a rename is audited also when the publication does not reconcile', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    upsertPullRequest: publicationFails('unknown'),
    reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, { headRepository: MOVED, baseRepository: MOVED, state: 'closed' })], MOVED),
  }));
  assertPublicationIncomplete(trace, true, false, 'pull-request-closed');
  assertRenameAudited(trace, MOVED);
});

// The reconciliation read rewrites a PR whose title or body diverged from the attempt's facts, and says so on that PR;
// the core audits every repair it is told of, before and whatever it decides.
const contentRepairs = (trace: TaskTrace) =>
  effectsOf(trace.commands, 'audit').filter((a) => a.action === 'publication.content-repaired').map((a) => a.detail);

for (const cancelled of [false, true]) {
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';
  const during = cancelled ? cancelDuring('publishBranch') : () => [];

  test(`publication: after a failed PR upsert, a content repair of the attempt's PR is audited, and the PR counts as upserted, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, { contentRepaired: true })]),
    }, { eventsDuring: during }));
    assert.deepEqual(contentRepairs(trace), [{ workflowId: 'asep-task-task-1', attemptNumber: 1, prNumber: 9 }]);
    assertPublished(trace, 9, cancelled);
  });

  test(`publication: after an unknown push, a content repair of the attempt's PR is audited, and the push is confirmed, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      publishBranch: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, { contentRepaired: true })]),
    }, { eventsDuring: during }));
    assert.deepEqual(contentRepairs(trace), [{ workflowId: 'asep-task-task-1', attemptNumber: 1, prNumber: 9 }]);
    assertPublished(trace, 7, cancelled);
  });

  test(`publication: content repairs of PRs that are not the attempt's publication are audited before it ends publication-incomplete, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      upsertPullRequest: publicationFails('unknown'),
      reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9, { contentRepaired: true }), prOfAttempt(10, { contentRepaired: true })]),
    }, { eventsDuring: during }));
    assert.deepEqual(contentRepairs(trace).map((d) => d['prNumber']), [9, 10]);
    const actions = effectsOf(trace.commands, 'audit').map((a) => a.action).filter((a) => a.startsWith('publication.'));
    assert.deepEqual(actions, ['publication.content-repaired', 'publication.content-repaired', 'publication.incomplete']);
    assertPublicationIncomplete(trace, true, cancelled, 'pull-requests-multiple');
  });
}

test('publication: a read that repaired nothing audits no repair', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9)]),
  }));
  assertPublished(trace, 9, false);
  assert.deepEqual(contentRepairs(trace), []);
});

test('publication identity: a reconciled read under the bound owner and name audits no move', () => {
  const trace = runTaskSequentially(baseInput(), scripted({
    upsertPullRequest: publicationFails('unknown'), reconcilePublication: reconciled(shaFor(1), [prOfAttempt(9)]),
  }));
  assertPublished(trace, 9, false);
  assert.ok(!effectsOf(trace.commands, 'audit').some((a) => a.action === 'publication.repository-renamed'));
});

test('publication: a task based on another branch publishes and reconciles against that branch, never a default', () => {
  // The reviewer's NONDEFAULT_BASE and HARDCODE_MAIN_COUNTEREXAMPLE: every request that names the PR's base takes it
  // from the task input.
  for (const baseBranch of ['release', 'develop', 'main']) {
    const happy = runTaskSequentially(baseInput({ baseBranch }), scripted());
    assert.deepEqual(requests(happy.commands).flatMap((r) => (r.kind === 'upsertPullRequest' ? [r.baseBranch] : [])), [baseBranch]);
    const reconciling = runTaskSequentially(baseInput({ baseBranch }), scripted({ upsertPullRequest: publicationFails('unknown') }));
    assert.deepEqual(reconcileRequests(reconciling).map((r) => r.kind === 'reconcilePublication' && r.expectedBaseBranch), [baseBranch]);
    assertPublished(reconciling, 7, false);
  }
});

test('publication: every publication request names the input\'s repository, never a default', () => {
  // The reviewer's NONDEFAULT_REPOSITORY: the PR upsert and both reconciliation reads take the repository from the
  // task input; a request that named another repository would read or write somewhere else.
  for (const repository of OTHER_BINDINGS) {
    for (const [failing, order] of [
      ['publishBranch', ['reconcilePublication', 'upsertPullRequest']],
      ['upsertPullRequest', ['upsertPullRequest', 'reconcilePublication']],
    ] as const) {
      const trace = runTaskSequentially(baseInput({ repository }), scripted({ [failing]: publicationFails('unknown') }));
      const named = requests(trace.commands).flatMap((r) => (r.kind === 'upsertPullRequest' || r.kind === 'reconcilePublication' ? [[r.kind, r.repository]] : []));
      assert.deepEqual(named, order.map((kind) => [kind, repository]), `${JSON.stringify(repository)} after a failing ${failing}`);
      assertPublished(trace, 7, false);
    }
  }
});

test('publication: the reconciliation continues the publication unit; a pause does not withhold it', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ publishBranch: publicationFails('unknown') }, {
    eventsDuring: (request) => (request.kind === 'publishBranch' ? [pause()] : []),
    whenIdle: idleScript(() => resume()),
  }));
  const kinds = requestKinds(trace.commands);
  assert.equal(kinds[kinds.indexOf('publishBranch') + 1], 'reconcilePublication', 'the read follows the push at once');
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('cancel during the PR upsert lets it complete; the PR stays open and the cancel is audited', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, {
    eventsDuring: (request) => (request.kind === 'upsertPullRequest' ? [cancel()] : []),
  }));
  assert.equal(trace.aborts, 0);
  assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'workflow.cancel.after-publication'), 'cancel after publication audited');
  assert.deepEqual(outcomes(trace), [[1, 'cancelled']]);
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assert.equal(trace.summary.prNumber, 7);
});

// ---------------------------------------------------------------------------
// Terminal outcome before lease release
// ---------------------------------------------------------------------------

// An attempt that holds a lease records its terminal outcome while it still holds it: the fenced outcome write needs
// the lease, so every leased path emits recordAttemptOutcome before releaseLease, and effects run in order.
function assertOutcomeBeforeRelease(trace: TaskTrace, expected: readonly (readonly [number, string])[]): void {
  assert.deepEqual(outcomes(trace), expected);
  const at = (kind: 'recordAttemptOutcome' | 'releaseLease', n: number) =>
    indexOfCommand(trace.commands, (c) => c.type === 'effect' && c.effect.kind === kind && c.effect.attemptNumber === n);
  for (const [n] of expected) {
    assert.ok(at('releaseLease', n) >= 0, `attempt ${n} held a lease and releases it`);
    assert.ok(at('recordAttemptOutcome', n) < at('releaseLease', n), `attempt ${n}: outcome recorded before the lease is released`);
  }
  assertLegalProjections(trace);
}

const agentFails = (failureClass: FailureClass) => () => ({ kind: 'runAgent' as const, status: 'FAILED' as const, reportedCostUsd: 1, reportedToolCalls: 3, wallClockMs: 1000, failureClass });
const firstOnly = <T,>(answer: (r: TaskRequest) => T) => (r: TaskRequest, n: number) => (n === 1 ? answer(r) : undefined);

for (const [path, environment, expected] of [
  ['repair', scripted({ assuranceRound: firstOnly((r) => ({ kind: 'assuranceRound' as const, outcome: repair(r) })) }),
    [[1, 'repair-requested'], [2, 'proceeded']]],
  ['abandon after worker death, replaced', scripted({ runAgent: firstOnly(() => ({ kind: 'activityFailed' as const, failureClass: 'environment' as const, timedOut: true })) }),
    [[1, 'infrastructure-failed'], [2, 'proceeded']]],
  ['abandon after a non-replaceable agent failure', scripted({ runAgent: agentFails('policy-violation') }), [[1, 'agent-failed']]],
  ['abandon after a failed workspace activity', scripted({ prepareWorkspace: firstOnly(() => ({ kind: 'activityFailed' as const, failureClass: 'environment' as const, timedOut: false })) }),
    [[1, 'infrastructure-failed'], [2, 'proceeded']]],
  ['abandon after a failed lease acquisition whose grant the lookup found', scripted({ acquireLease: firstOnly(() => ({ kind: 'activityFailed' as const, failureClass: 'environment' as const, timedOut: false })) }),
    [[1, 'infrastructure-failed'], [2, 'proceeded']]],
  ['cancel that aborts a lease acquisition whose grant the lookup found', scripted({}, { eventsDuring: (request) => (request.kind === 'acquireLease' ? [cancel()] : []) }),
    [[1, 'cancelled']]],
  ['abandon after an overstep found by inspection', scripted({ inspectWorkspace: () => ({ kind: 'inspectWorkspace' as const, overstep: true }) }), [[1, 'agent-failed']]],
  ['exhaustion at a cap', scripted({ runAgent: firstOnly(() => ({ kind: 'runAgent' as const, status: 'BUDGET_EXHAUSTED' as const, reportedCostUsd: 5, reportedToolCalls: 50, wallClockMs: 1000, failureClass: null })) }),
    [[1, 'budget-exhausted'], [2, 'proceeded']]],
  ['verification stop', scripted({ runVerification: () => ({ kind: 'runVerification' as const, verdict: 'FAIL' as const }) }), [[1, 'verification-stopped']]],
  ['assurance BLOCK', scripted({ assuranceRound: (r) => ({ kind: 'assuranceRound' as const, outcome: block(r) }) }),
    [[1, 'blocked']]],
  ['review handoff', scripted(), [[1, 'proceeded']]],
  ['close on an assurance contract violation', scripted({ assuranceRound: (r) => ({ kind: 'assuranceRound' as const, outcome: { ...(proceed(r) as object), kind: 'APPROVED' } }) }),
    [[1, 'infrastructure-failed']]],
  ['close on an incomplete publication', scripted({ upsertPullRequest: publicationFails('none') }), [[1, 'infrastructure-failed']]],
  ['cancel during the agent', scripted({}, { eventsDuring: (request) => (request.kind === 'runAgent' ? [cancel()] : []) }), [[1, 'cancelled']]],
  ['cancel during the assurance round', scripted({}, { eventsDuring: (request) => (request.kind === 'assuranceRound' ? [cancel()] : []) }), [[1, 'cancelled']]],
  ['pause timeout', scripted({}, {
    eventsDuring: (request) => (request.kind === 'inspectWorkspace' ? [pause()] : []),
    whenIdle: idleScript((timers) => ({ type: 'timerFired', timerId: timers[0]! })),
  }), [[1, 'cancelled']]],
] as const) {
  test(`terminal before lease: ${path} records the outcome before it releases the lease`, () => {
    assertOutcomeBeforeRelease(runTaskSequentially(baseInput(), environment), expected);
  });
}

// ---------------------------------------------------------------------------
// Lease acquisition that fails or is aborted
// ---------------------------------------------------------------------------

// The grant may commit although acquireLease failed or a cancel aborted it, and then the workflow never received the
// fence. A non-cancellable lookup settles the lease history first: a lease found is recorded and released with its
// fence; none found makes the terminal a pre-lease write with fence null, which a late grant can refuse, and then the
// lookup runs once more. A lookup that cannot read the store ends the task attempt-state-unknown.

const leaseFails = (failureClass: FailureClass = 'environment') => () => ({ kind: 'activityFailed' as const, failureClass, timedOut: true });
const noLease = () => ({ kind: 'findLease' as const, fence: null });
const lookupFails = () => ({ kind: 'activityFailed' as const, failureClass: 'environment' as const, timedOut: false });

function leaseTrail(trace: TaskTrace) {
  return {
    lookups: requests(trace.commands).flatMap((r) => (r.kind === 'findLease' ? [r.attemptNumber] : [])),
    preLease: requests(trace.commands).flatMap((r) => (r.kind === 'recordPreLeaseOutcome' ? [[r.attemptNumber, r.terminal]] : [])),
    outcomes: effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.attemptNumber, o.terminal, o.fence]),
    releases: effectsOf(trace.commands, 'releaseLease').map((r) => [r.attemptNumber, r.fence]),
  };
}

test('lease: an acquisition that fails is settled by a lookup, and the lease found is recorded and released with its fence (the reviewer\'s R29_acquire-failure)', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ acquireLease: leaseFails() }));
  assert.deepEqual(leaseTrail(trace), {
    lookups: [1, 2, 3],
    preLease: [],
    outcomes: [[1, 'infrastructure-failed', fenceFor(1)], [2, 'infrastructure-failed', fenceFor(2)], [3, 'infrastructure-failed', fenceFor(3)]],
    releases: [[1, fenceFor(1)], [2, fenceFor(2)], [3, fenceFor(3)]],
  });
  assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['FAILED', 'attempts-exhausted']);
  assertLegalProjections(trace);
});

test('lease: a cancel that aborts the acquisition settles the lease first, and the lease found is recorded and released (the reviewer\'s R29_acquire-cancel)', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, { eventsDuring: (request) => (request.kind === 'acquireLease' ? [cancel()] : []) }));
  assert.equal(trace.aborts, 1, 'the acquisition is interrupted');
  assert.deepEqual(leaseTrail(trace), { lookups: [1], preLease: [], outcomes: [[1, 'cancelled', fenceFor(1)]], releases: [[1, fenceFor(1)]] });
  assert.equal(trace.summary.outcome, 'CANCELLED');
  assertLegalProjections(trace);
});

for (const cancelled of [false, true]) {
  const when = cancelled ? 'with a cancel pending' : 'without a cancel';
  const during = (kind: TaskRequestKind) => (cancelled ? cancelDuring(kind) : () => []);

  test(`lease: no lease found after a failed acquisition: the terminal is a pre-lease write with no release, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ acquireLease: firstOnly(leaseFails()), findLease: noLease }, { eventsDuring: during('findLease') }));
    const usageAt = indexOfCommand(trace.commands, (c) => c.type === 'effect' && c.effect.kind === 'recordUsage' && c.effect.attemptNumber === 1);
    const writeAt = indexOfCommand(trace.commands, (c) => c.type === 'request' && c.request.kind === 'recordPreLeaseOutcome');
    assert.ok(writeAt >= 0 && usageAt > writeAt, 'the zero usage entry follows the recorded terminal');
    assert.deepEqual(effectsOf(trace.commands, 'recordUsage').filter((u) => u.attemptNumber === 1).map((u) => u.chargedCostUsd), [0]);
    if (cancelled) {
      assert.deepEqual(leaseTrail(trace), { lookups: [1], preLease: [[1, 'cancelled']], outcomes: [], releases: [] });
      assert.equal(trace.summary.outcome, 'CANCELLED');
    } else {
      assert.deepEqual(leaseTrail(trace), { lookups: [1], preLease: [[1, 'infrastructure-failed']], outcomes: [[2, 'proceeded', fenceFor(2)]], releases: [[2, fenceFor(2)]] });
      assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW', 'the attempt was abandoned and replaced');
    }
    assertLegalProjections(trace);
  });

  test(`lease: no lease found after an aborted acquisition: the cancelled terminal is a pre-lease write, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ findLease: noLease }, { eventsDuring: during('acquireLease') }));
    if (cancelled) {
      assert.deepEqual(leaseTrail(trace), { lookups: [1], preLease: [[1, 'cancelled']], outcomes: [], releases: [] });
      assert.equal(trace.summary.outcome, 'CANCELLED');
    } else {
      assert.deepEqual(leaseTrail(trace).lookups, [], 'nothing was aborted, so nothing is looked up');
      assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
    }
  });

  test(`lease: a late grant refuses the pre-lease write; the second lookup finds it, and the terminal and release carry its fence, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      acquireLease: firstOnly(leaseFails()),
      findLease: (r, n) => (n === 1 ? noLease() : { kind: 'findLease' as const, fence: fenceFor(r.kind === 'findLease' ? r.attemptNumber : 0) }),
      recordPreLeaseOutcome: () => ({ kind: 'recordPreLeaseOutcome' as const, recorded: false }),
    }, { eventsDuring: during('recordPreLeaseOutcome') }));
    const expected = cancelled
      ? { lookups: [1, 1], preLease: [[1, 'infrastructure-failed']], outcomes: [[1, 'infrastructure-failed', fenceFor(1)]], releases: [[1, fenceFor(1)]] }
      : { lookups: [1, 1], preLease: [[1, 'infrastructure-failed']], outcomes: [[1, 'infrastructure-failed', fenceFor(1)], [2, 'proceeded', fenceFor(2)]], releases: [[1, fenceFor(1)], [2, fenceFor(2)]] };
    assert.deepEqual(leaseTrail(trace), expected, 'at most two lookups');
    assert.equal(trace.summary.outcome, cancelled ? 'CANCELLED' : 'WAITING_FOR_HUMAN_REVIEW');
    assertLegalProjections(trace);
  });

  test(`lease: a second lookup that finds no lease contradicts the history: FAILED / attempt-state-unknown, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      acquireLease: leaseFails(), findLease: noLease, recordPreLeaseOutcome: () => ({ kind: 'recordPreLeaseOutcome' as const, recorded: false }),
    }, { eventsDuring: during('recordPreLeaseOutcome') }));
    assert.deepEqual(leaseTrail(trace).lookups, [1, 1], 'no third lookup');
    assertAttemptStateUnknown(trace, 1, 'findLease', cancelled);
    assert.equal(trace.summary.attempts, 1, 'the attempt exists');
  });

  test(`lease: a lease lookup that fails ends the task FAILED / attempt-state-unknown, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ acquireLease: leaseFails(), findLease: lookupFails }, { eventsDuring: during('findLease') }));
    assert.equal(trace.aborts, 0, 'the lookup is not interrupted');
    assertAttemptStateUnknown(trace, 1, 'findLease', cancelled);
  });

  test(`lease: a lease lookup after an aborted acquisition that fails ends FAILED / attempt-state-unknown, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({ findLease: lookupFails }, { eventsDuring: during('acquireLease') }));
    if (cancelled) assertAttemptStateUnknown(trace, 1, 'findLease', true);
    else assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW', 'nothing was aborted');
  });

  test(`lease: a pre-lease write that fails leaves the terminal unknown: FAILED / attempt-state-unknown, ${when}`, () => {
    const trace = runTaskSequentially(baseInput(), scripted({
      acquireLease: leaseFails(), findLease: noLease, recordPreLeaseOutcome: lookupFails,
    }, { eventsDuring: during('findLease') }));
    assertAttemptStateUnknown(trace, 1, 'recordPreLeaseOutcome', cancelled);
  });
}

test('lease: a never-replaceable class on the failed acquisition still ends the task with that class after the lookup', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ acquireLease: leaseFails('duplicate-side-effect') }));
  assert.deepEqual(leaseTrail(trace), { lookups: [1], preLease: [], outcomes: [[1, 'infrastructure-failed', fenceFor(1)]], releases: [[1, fenceFor(1)]] });
  assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['FAILED', 'duplicate-side-effect']);
});

test('lease: a pause does not withhold the lease lookup or the pre-lease write', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ acquireLease: firstOnly(leaseFails()), findLease: noLease }, {
    eventsDuring: (request) => (request.kind === 'acquireLease' ? [pause()] : []),
    whenIdle: idleScript(() => resume()),
  }));
  const kinds = requestKinds(trace.commands);
  assert.deepEqual(kinds.slice(kinds.indexOf('acquireLease'), kinds.indexOf('acquireLease') + 3), ['acquireLease', 'findLease', 'recordPreLeaseOutcome']);
  assert.equal(trace.summary.outcome, 'WAITING_FOR_HUMAN_REVIEW');
});

test('lease: every terminal write of a leased attempt carries the fence its acquisition returned', () => {
  const trace = runTaskSequentially(baseInput(), scripted({ assuranceRound: firstOnly((r) => ({ kind: 'assuranceRound' as const, outcome: repair(r) })) }));
  assert.deepEqual(leaseTrail(trace), {
    lookups: [], preLease: [], outcomes: [[1, 'repair-requested', fenceFor(1)], [2, 'proceeded', fenceFor(2)]], releases: [[1, fenceFor(1)], [2, fenceFor(2)]],
  });
});

test('lease: an attempt that never asked for a lease records its terminal with fence null and releases nothing', () => {
  const trace = runTaskSequentially(baseInput(), scripted({}, { eventsDuring: (request) => (request.kind === 'ensureAttempt' ? [cancel()] : []) }));
  assert.deepEqual(leaseTrail(trace), { lookups: [], preLease: [], outcomes: [[1, 'cancelled', null]], releases: [] });
});

test('lease: the core refuses a terminal for an attempt whose lease request is not settled', () => {
  // No valid path reaches this state: the lookup settles the lease first. The guard keeps a regression from writing
  // a terminal without the fence of a lease that may have been granted.
  const trace = runTaskSequentially(baseInput(), scripted());
  let state = startTask(baseInput()).state;
  for (const event of trace.events) {
    const decision = decideTask(state, event);
    if (effectsOf(decision.commands, 'recordAttemptOutcome').length > 0) {
      assert.ok(state.attempts[0]!.leaseRequested, 'the attempt asked for a lease');
      const unsettled: TaskState = { ...state, attempts: state.attempts.map((a) => (a.attemptNumber === 1 ? { ...a, fence: null } : a)) };
      assert.throws(() => decideTask(unsettled, event), /terminal of attempt 1 before its lease is settled/);
      return;
    }
    state = decision.state;
  }
  assert.fail('the happy path records a terminal');
});

// ---------------------------------------------------------------------------
// The run workflow
// ---------------------------------------------------------------------------

const RUN: RunCoreInput = { runId: 'run-1' as RunId, runBudget: { maxCostUsd: 10, softCostUsd: 8, maxTasks: 3 }, fixedTasks: null };
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

const seal = (requestId = 'seal-1') => ({ type: 'sealRequested' as const, requestId, principalId: 'op' });

function completion(commands: readonly RunCommand[]) {
  return commands.find((c): c is Extract<RunCommand, { kind: 'complete' }> => c.kind === 'complete');
}

test('run seal: a run below maxTasks closes once it is sealed and no task is open', () => {
  let d = startRun(RUN, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, done('a', 1));
  assert.equal(completion(d.commands), undefined, 'one of three tasks finished: the run stays open for submissions');
  d = decideRun(d.state, seal());
  assert.deepEqual(d.receipt, { accepted: true, duplicate: false, reason: null });
  assert.deepEqual(d.commands.filter((c) => c.kind === 'recordControl').map((c) => c.kind === 'recordControl' && c.control), ['seal']);
  assert.deepEqual(completion(d.commands), { kind: 'complete', outcome: 'COMPLETED', finishedTasks: 1, chargedCostUsd: 1 });
});

test('run seal: a seal during a running child stops submissions; the run closes after its queued tasks', () => {
  let d = startRun(RUN, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, submit('b'));
  d = decideRun(d.state, seal());
  assert.equal(completion(d.commands), undefined, 'a child is still running');
  d = decideRun(d.state, submit('c'));
  assert.deepEqual(d.receipt, { accepted: false, duplicate: false, reason: 'run-sealed' });
  d = decideRun(d.state, submit('a', 'replayed'));
  assert.deepEqual(d.receipt, { accepted: true, duplicate: true, reason: null }, 'a known task keeps its original receipt');
  d = decideRun(d.state, seal('seal-2'));
  assert.deepEqual(d.receipt, { accepted: false, duplicate: false, reason: 'already-sealed' });
  d = decideRun(d.state, seal());
  assert.deepEqual(d.receipt, { accepted: true, duplicate: true, reason: null }, 'a repeated request id is a duplicate');
  d = decideRun(d.state, done('a', 1));
  assert.deepEqual(startedChildren(d.commands), [['b', 9]]);
  d = decideRun(d.state, done('b', 2));
  assert.equal(completion(d.commands)?.outcome, 'COMPLETED');
});

test('run seal: a run created sealed with a fixed task list runs exactly those tasks and closes', () => {
  let d = startRun({ ...RUN, fixedTasks: ['a' as TaskId, 'b' as TaskId] }, null);
  assert.deepEqual(startedChildren(d.commands), [['a', 10]]);
  d = decideRun(d.state, submit('c'));
  assert.deepEqual(d.receipt, { accepted: false, duplicate: false, reason: 'run-sealed' });
  d = decideRun(d.state, seal());
  assert.deepEqual(d.receipt, { accepted: false, duplicate: false, reason: 'already-sealed' });
  d = decideRun(d.state, done('a', 1));
  assert.deepEqual(startedChildren(d.commands), [['b', 9]]);
  d = decideRun(d.state, done('b', 1));
  assert.deepEqual(completion(d.commands), { kind: 'complete', outcome: 'COMPLETED', finishedTasks: 2, chargedCostUsd: 2 });
});

test('run seal: the sealed flag survives continue-as-new', () => {
  let d = startRun(RUN, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, submit('b'));
  d = decideRun(d.state, seal());
  d = decideRun(d.state, { type: 'continueAsNewSuggested' });
  d = decideRun(d.state, done('a', 1));
  const can = d.commands.find((c) => c.kind === 'continueAsNew');
  assert.ok(can && can.kind === 'continueAsNew', 'continues as new between children');
  assert.equal(can.carry.sealed, true);
  let next = startRun(RUN, JSON.parse(JSON.stringify(can.carry)) as typeof can.carry);
  assert.deepEqual(startedChildren(next.commands), [['b', 9]]);
  next = decideRun(next.state, submit('c'));
  assert.deepEqual(next.receipt, { accepted: false, duplicate: false, reason: 'run-sealed' });
  next = decideRun(next.state, done('b', 1));
  assert.equal(completion(next.commands)?.outcome, 'COMPLETED');
});

test('run seal: a paused run with nothing left closes on seal; with queued tasks it waits for resume', () => {
  let d = startRun(RUN, null);
  d = decideRun(d.state, submit('a'));
  d = decideRun(d.state, { type: 'pauseRequested', requestId: 'p1', principalId: 'op' });
  d = decideRun(d.state, done('a', 1));
  d = decideRun(d.state, seal());
  assert.equal(completion(d.commands)?.outcome, 'COMPLETED', 'a pause holds no work when nothing is queued');

  let q = startRun(RUN, null);
  q = decideRun(q.state, submit('a'));
  q = decideRun(q.state, submit('b'));
  q = decideRun(q.state, { type: 'pauseRequested', requestId: 'p1', principalId: 'op' });
  q = decideRun(q.state, done('a', 1));
  q = decideRun(q.state, seal());
  assert.equal(completion(q.commands), undefined, 'task b is still queued');
  assert.deepEqual(startedChildren(q.commands), [], 'and the pause holds it');
  q = decideRun(q.state, { type: 'resumeRequested', requestId: 'r1', principalId: 'op' });
  assert.deepEqual(startedChildren(q.commands), [['b', 9]]);
  q = decideRun(q.state, done('b', 1));
  assert.equal(completion(q.commands)?.outcome, 'COMPLETED');
});

test('run seal: the run input rule rejects a fixed task list with a repeat or above maxTasks', () => {
  const base = { runId: 'r' as RunId, runBudget: { maxCostUsd: 10, softCostUsd: 8, maxTasks: 2 } };
  assert.deepEqual(runInputErrors({ ...base, fixedTasks: ['a' as TaskId, 'b' as TaskId] }), []);
  for (const fixedTasks of [['a', 'a'], ['a', 'b', 'c']] as const) {
    assert.deepEqual(runInputErrors({ ...base, fixedTasks: fixedTasks as unknown as TaskId[] }),
      ['fixedTasks: must list each task once, at most runBudget.maxTasks of them'], fixedTasks.join(','));
  }
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

test('projection: the edges touching the new statuses are the data-model additions, VERIFYING -> BUDGET_EXHAUSTED and the approval-wait pause edges', () => {
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
    // A pause while waiting for an approval applies at once, resume returns to the wait, and a budget-extension
    // request can expire or be rejected while paused.
    'PAUSED->WAITING_FOR_APPROVAL', 'PAUSED->BUDGET_EXHAUSTED', 'WAITING_FOR_APPROVAL->PAUSED',
    'READY->BUDGET_EXHAUSTED', 'READY->PAUSED', 'READY->WAITING_FOR_APPROVAL',
    // A replacement attempt refused for budget after the task reached verification (for example a retry
    // of an exhausted repair attempt); the domain table gains it with the status extension.
    'VERIFYING->BUDGET_EXHAUSTED',
    'VERIFYING->PAUSED', 'VERIFYING->WAITING_FOR_APPROVAL',
    'WAITING_FOR_APPROVAL->BLOCKED', 'WAITING_FOR_APPROVAL->BUDGET_EXHAUSTED', 'WAITING_FOR_APPROVAL->CANCELLED',
    'WAITING_FOR_APPROVAL->EXECUTING', 'WAITING_FOR_APPROVAL->READY', 'WAITING_FOR_APPROVAL->VERIFYING',
  ].sort());
});

// ---------------------------------------------------------------------------
// The slot contract at the core's boundary: names, routing, terminals, registration order
// ---------------------------------------------------------------------------

/** True exactly when A and B are the same type; mutual assignability would miss readonly and optional differences. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Compiles only for `true`: the type checker of verify:all is this check's oracle. */
const sameType = <T extends true>(): T | null => null;

test('slot names: the core\'s copies of the slot contract\'s types are the contract\'s types', () => {
  sameType<Same<AttemptTerminal, Slot.AttemptTerminal>>();
  sameType<Same<PreLeaseAttemptTerminal, Slot.PreLeaseAttemptTerminal>>();
  sameType<Same<AssuranceFence, Slot.AssuranceFence>>();
  sameType<Same<AssuranceOutcome, Slot.AssuranceOutcome>>();
  sameType<Same<AssuranceOutcomeKind, Slot.AssuranceOutcome['kind']>>();
  sameType<Same<ReviewMode, Slot.ReviewMode>>();
  sameType<Same<EscalationReason, Slot.EscalationReason>>();
  sameType<Same<BlockReason, Slot.BlockReason>>();
  sameType<Same<AssuranceUsage, Slot.AssuranceUsage>>();
  sameType<Same<ShadowVerdict, Slot.ShadowVerdict>>();
  // Every field of the round request the core decides is the slot input's field of that name and type.
  type RoundFields = 'round' | 'taskBaseSha' | 'declaredComplete' | 'priorAdjudicationId' | 'idempotencyKey' | 'budgetRemaining';
  sameType<Same<Pick<CoreAssuranceRequest, RoundFields>, Pick<Slot.AssuranceSlotInput, RoundFields>>>();
  // The terminal record: the facts the core decides, and which fence goes with which terminals.
  type OutcomeFields = 'round' | 'declaredComplete' | 'verificationVerdict' | 'adjudicationId' | 'assuranceUnavailable';
  sameType<Same<Pick<AttemptOutcomeFacts, OutcomeFields>, Pick<Slot.AttemptOutcomeFields, OutcomeFields>>>();
  sameType<Same<AttemptOutcomeFacts['modelCostMicroUsd'], NonNullable<Slot.AttemptOutcomeFields['cost']>['modelCostMicroUsd']>>();
  type Leased = Extract<AttemptOutcomeRecord, { readonly fence: AssuranceFence }>;
  type PreLease = Extract<AttemptOutcomeRecord, { readonly fence: null }>;
  sameType<Same<Leased['terminal'], Slot.LeasedAttemptOutcomeInput['terminal']>>();
  sameType<Same<Leased['fence'], Slot.LeasedAttemptOutcomeInput['fence']>>();
  sameType<Same<PreLease['terminal'], Slot.PreLeaseAttemptOutcomeInput['terminal']>>();
  sameType<Same<PreLease['fence'], Slot.PreLeaseAttemptOutcomeInput['fence']>>();
  // The core's failure classes are class ids the slot accepts.
  const failureClass: Slot.AttemptOutcomeFields['failureClass'] = 'artifact-loss' satisfies FailureClass;
  assert.equal(failureClass, 'artifact-loss');
  assert.deepEqual([...PRE_LEASE_ATTEMPT_TERMINALS], ['cancelled', 'infrastructure-failed']);
});

const SLOT_SCOPE = { organizationId: 'org-1', projectId: 'project-1' } as unknown as Slot.AttemptOutcomeFields['scope'];

/** The slot input the composition builds from a recorded terminal: the core's facts plus the durable ones. */
function slotOutcomeInput(o: Extract<TaskEffect, { kind: 'recordAttemptOutcome' }>): Slot.AttemptOutcomeInput {
  const fields: Slot.AttemptOutcomeFields = {
    slotVersion: 'review-loop/v1',
    scope: SLOT_SCOPE,
    repositoryBindingId: 'binding-1' as Slot.AttemptOutcomeFields['repositoryBindingId'],
    runId: 'run-1' as RunId,
    taskId: 'task-1' as TaskId,
    attemptId: attemptIdFor(o.attemptNumber),
    risk: 'R0',
    round: o.round,
    declaredComplete: o.declaredComplete,
    verificationVerdict: o.verificationVerdict,
    adjudicationId: o.adjudicationId,
    assuranceUnavailable: o.assuranceUnavailable,
    failureClass: o.failureClass,
    cost: { modelCostMicroUsd: o.modelCostMicroUsd, computeCostMicroUsd: null, inputTokens: 0, outputTokens: 0, toolCalls: 0 },
  };
  return o.fence === null ? { ...fields, fence: null, terminal: o.terminal } : { ...fields, fence: o.fence, terminal: o.terminal };
}

const SLOT_CTX: Slot.AssuranceStepContext = {
  signal: new AbortController().signal,
  now: () => '2026-01-01T00:00:00.000Z',
  heartbeat: () => undefined,
};

/** Every terminal the trace records is one the slot contract accepts: Lane B's opt-out slot validates it as any slot does. */
async function assertSlotAcceptsTerminals(trace: TaskTrace): Promise<void> {
  const slot = createDisabledAssuranceSlot(REVIEW_LOOP_DISABLED);
  for (const o of effectsOf(trace.commands, 'recordAttemptOutcome')) {
    await slot.recordAttemptOutcome(slotOutcomeInput(o), SLOT_CTX);
  }
}

interface RoutingRow {
  readonly name: string;
  readonly assuranceMode: AssuranceMode;
  /** The round's answer: one of the contract's outcomes for the round the request asks for, or the activity failing. */
  readonly answer: (r: TaskRequest) => Slot.AssuranceOutcome | 'activity-failed';
  /** The PR the first attempt publishes (flagged, section), or null for none. */
  readonly published: readonly [boolean, ArtifactRef | null] | null;
  /** Per terminal: attempt, terminal, its adjudication id, assuranceUnavailable. */
  readonly terminals: readonly (readonly [number, Slot.AttemptTerminal, string | null, boolean])[];
  readonly task: readonly [TaskOutcome, string];
}

const SHADOW_VERDICT: Slot.ShadowVerdict = { wouldBe: 'REPAIR', reason: 'blocking-findings', blockingFindings: 2 };

const ROUTING: readonly RoutingRow[] = [
  {
    name: 'PROCEED, not required, with a section',
    assuranceMode: 'shadow',
    answer: (r) => proceed(r, 'adj-p'),
    published: [false, ref('pr-adj-p')],
    terminals: [[1, 'proceeded', adjudicationId('adj-p'), false]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'review-handoff'],
  },
  {
    name: 'PROCEED, not required, with nothing to show (the not-configured default)',
    assuranceMode: 'shadow',
    answer: (r) => ({ ...proceed(r, 'adj-n'), prBodySectionRef: null }),
    published: [false, null],
    terminals: [[1, 'proceeded', adjudicationId('adj-n'), false]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'review-handoff'],
  },
  {
    name: 'PROCEED in shadow mode: the shadow verdict never changes the route',
    assuranceMode: 'shadow',
    answer: (r) => ({ ...proceed(r, 'adj-s'), mode: 'shadow', shadow: SHADOW_VERDICT }),
    published: [false, ref('pr-adj-s')],
    terminals: [[1, 'proceeded', adjudicationId('adj-s'), false]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'review-handoff'],
  },
  {
    name: 'PROCEED in gating mode',
    assuranceMode: 'gating',
    answer: (r) => ({ ...proceed(r, 'adj-g'), mode: 'gating' }),
    published: [false, ref('pr-adj-g')],
    terminals: [[1, 'proceeded', adjudicationId('adj-g'), false]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'review-handoff'],
  },
  {
    name: 'ESCALATE',
    assuranceMode: 'gating',
    answer: (r) => escalate(r, 'adj-e', 'max-repair-rounds'),
    published: [true, ref('esc-adj-e')],
    terminals: [[1, 'escalated', adjudicationId('adj-e'), false]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'assurance-escalated'],
  },
  {
    name: 'REPAIR, then PROCEED on the repair attempt',
    assuranceMode: 'gating',
    answer: (r) => (roundRequest(r).attemptNumber === 1 ? repair(r, 'adj-r') : proceed(r, 'adj-p2')),
    published: [false, ref('pr-adj-p2')],
    terminals: [[1, 'repair-requested', adjudicationId('adj-r'), false], [2, 'proceeded', adjudicationId('adj-p2'), false]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'review-handoff'],
  },
  {
    name: 'BLOCK in gating mode',
    assuranceMode: 'gating',
    answer: (r) => block(r, 'adj-b'),
    published: null,
    terminals: [[1, 'blocked', adjudicationId('adj-b'), false]],
    task: ['BLOCKED', 'secret-in-diff'],
  },
  {
    name: 'BLOCK in shadow mode, with a section',
    assuranceMode: 'shadow',
    answer: (r) => ({ ...block(r, 'adj-b', 'forbidden-path'), mode: 'shadow', prBodySectionRef: ref('blocked') }),
    published: null,
    terminals: [[1, 'blocked', adjudicationId('adj-b'), false]],
    task: ['BLOCKED', 'forbidden-path'],
  },
  {
    name: 'BLOCK in not-required mode',
    assuranceMode: 'shadow',
    answer: (r) => ({ ...block(r, 'adj-b', 'unscannable-sensitive-change'), mode: 'not-required' }),
    published: null,
    terminals: [[1, 'blocked', adjudicationId('adj-b'), false]],
    task: ['BLOCKED', 'unscannable-sensitive-change'],
  },
  {
    name: 'an unavailable round in shadow mode continues as PROCEED without an adjudication',
    assuranceMode: 'shadow',
    answer: () => 'activity-failed',
    published: [false, null],
    terminals: [[1, 'proceeded', null, true]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'review-handoff'],
  },
  {
    name: 'an unavailable round in gating mode continues as ESCALATE without an adjudication',
    assuranceMode: 'gating',
    answer: () => 'activity-failed',
    published: [true, null],
    terminals: [[1, 'escalated', null, true]],
    task: ['WAITING_FOR_HUMAN_REVIEW', 'assurance-escalated'],
  },
];

for (const row of ROUTING) {
  test(`slot routing: ${row.name}`, async () => {
    const trace = runTaskSequentially(baseInput({ governance: governance({ assuranceMode: row.assuranceMode }) }), scripted({
      assuranceRound: (r) => {
        const answer = row.answer(r);
        return answer === 'activity-failed' ? { kind: 'activityFailed', failureClass: 'provider', timedOut: false } : { kind: 'assuranceRound', outcome: answer };
      },
    }));
    const pr = requests(trace.commands).flatMap((r) => (r.kind === 'upsertPullRequest' ? [[r.flagged, r.prBodySectionRef] as const] : []));
    assert.deepEqual(pr, row.published === null ? [] : [row.published]);
    if (row.published === null) assert.ok(!requestKinds(trace.commands).includes('publishBranch'), 'nothing is pushed');
    assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.attemptNumber, o.terminal, o.adjudicationId, o.assuranceUnavailable]),
      row.terminals);
    assert.deepEqual([trace.summary.outcome, trace.summary.reason], row.task);
    await assertSlotAcceptsTerminals(trace);
    assertLegalProjections(trace);
  });
}

test('slot routing: an unavailable round is reported only on the terminal that continued without it', async () => {
  const unavailable = () => ({ kind: 'activityFailed' as const, failureClass: 'provider' as const, timedOut: false });
  for (const [label, environment, terminal] of [
    ['a cancel after the round', scripted({ assuranceRound: unavailable }, { eventsDuring: (request) => (request.kind === 'publishBranch' ? [cancel()] : []) }), 'cancelled'],
    ['an incomplete publication', scripted({ assuranceRound: unavailable, upsertPullRequest: publicationFails('none') }), 'infrastructure-failed'],
  ] as const) {
    const trace = runTaskSequentially(baseInput(), environment);
    assert.ok(effectsOf(trace.commands, 'audit').some((a) => a.action === 'assurance-unavailable'), `${label}: audited`);
    assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.terminal, o.adjudicationId, o.assuranceUnavailable]),
      [[terminal, null, false]], label);
    await assertSlotAcceptsTerminals(trace);
  }
});

test('slot routing: REPAIR carries its base, order, round and adjudication into the repair attempt and its round', () => {
  const trace = runTaskSequentially(baseInput({ governance: governance({ assuranceMode: 'gating' }) }), scripted({
    assuranceRound: (r, n) => (n === 1 ? { kind: 'assuranceRound', outcome: repair(r, 'adj-r') } : undefined),
  }));
  const all = requests(trace.commands);
  // The oracle is the outcome the slot returned, written out: base shaFor(1), order ro-1, next round 2.
  assert.deepEqual(all.filter((r) => r.kind === 'ensureAttempt' && r.attemptNumber === 2), [{
    kind: 'ensureAttempt', attemptNumber: 2, attemptKind: 'repair', baseSha: shaFor(1), parentAttemptNumber: 1, repairOrderRef: ref('ro-1'),
  }]);
  assert.deepEqual(all.flatMap((r) => (r.kind === 'prepareWorkspace' ? [[r.attemptNumber, r.baseSha]] : [])), [[1, TASK_BASE], [2, shaFor(1)]]);
  assert.deepEqual(all.flatMap((r) => (r.kind === 'storeAttemptInputs' ? [[r.attemptNumber, r.repairOrderRef]] : [])), [[1, null], [2, ref('ro-1')]]);
  assert.deepEqual(all.flatMap((r) => (r.kind === 'commitAttempt' ? [[r.attemptNumber, r.expectedHeadSha]] : [])), [[1, TASK_BASE], [2, shaFor(1)]]);
  assert.deepEqual(all.flatMap((r) => (r.kind === 'assuranceRound'
    ? [[r.request.attemptNumber, r.request.round, r.request.priorAdjudicationId, r.request.taskBaseSha, r.request.idempotencyKey]]
    : [])), [
    [1, 1, null, TASK_BASE, 'att-1:assurance:1'],
    [2, 2, adjudicationId('adj-r'), TASK_BASE, 'att-2:assurance:2'],
  ]);
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => [o.attemptNumber, o.terminal, o.round]),
    [[1, 'repair-requested', 1], [2, 'proceeded', 2]]);
});

test('slot money: the round request carries what the task may still spend as integer micro-USD and milliseconds', () => {
  // Attempt 1 reports 0.1234567 USD, charged once and rounded up (123 457 micro-USD), plus the 1 USD verification
  // reserve; 1 minute of agent plus the 10-minute reserve. Task cap 20 USD and 240 minutes, run remainder 100 USD.
  const fractional = scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 0.1234567, reportedToolCalls: 10, wallClockMs: 60_000, failureClass: null }),
  });
  const trace = runTaskSequentially(baseInput(), fractional);
  const [round] = requests(trace.commands).flatMap((r) => (r.kind === 'assuranceRound' ? [r.request] : []));
  assert.deepEqual(round?.budgetRemaining, { costMicroUsd: 20_000_000 - 123_457 - 1_000_000, wallClockMs: (240 - 1 - 10) * 60_000 });
  assert.deepEqual(effectsOf(trace.commands, 'recordAttemptOutcome').map((o) => o.modelCostMicroUsd), [123_457]);
  for (const value of [round!.budgetRemaining.costMicroUsd, round!.budgetRemaining.wallClockMs]) assert.ok(Number.isSafeInteger(value));

  // The run remainder caps it when it is below the task cap: 7 USD less the 2 USD charged.
  const runCapped = runTaskSequentially(baseInput({ runRemainingUsd: 7 }), scripted());
  const [capped] = requests(runCapped.commands).flatMap((r) => (r.kind === 'assuranceRound' ? [r.request] : []));
  assert.equal(capped?.budgetRemaining.costMicroUsd, 5_000_000);

  // A repair attempt's round counts both attempts: 20 USD less 2 + 2, 240 minutes less 11 + 11.
  const repaired = runTaskSequentially(baseInput(), scripted({ assuranceRound: (r, n) => (n === 1 ? { kind: 'assuranceRound', outcome: repair(r) } : undefined) }));
  assert.deepEqual(requests(repaired.commands).flatMap((r) => (r.kind === 'assuranceRound' ? [r.request.budgetRemaining] : [])), [
    { costMicroUsd: 18_000_000, wallClockMs: 229 * 60_000 },
    { costMicroUsd: 16_000_000, wallClockMs: 218 * 60_000 },
  ]);

  // A report the core cannot use is no model cost: null, never a USD number.
  const unusable = runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: Number.NaN, reportedToolCalls: 10, wallClockMs: 60_000, failureClass: null }),
  }));
  assert.deepEqual(effectsOf(unusable.commands, 'recordAttemptOutcome').map((o) => o.modelCostMicroUsd), [null]);
});

/** One scenario per terminal of the contract's vocabulary: the exact path that ends attempt 1 with it. */
const TERMINAL_PATHS: Readonly<Record<Slot.AttemptTerminal, () => TaskTrace>> = {
  'verification-stopped': () => runTaskSequentially(baseInput(), scripted({ runVerification: () => ({ kind: 'runVerification', verdict: 'FAIL' }) })),
  'proceeded': () => runTaskSequentially(baseInput(), scripted()),
  'repair-requested': () => runTaskSequentially(baseInput(), scripted({ assuranceRound: (r, n) => (n === 1 ? { kind: 'assuranceRound', outcome: repair(r) } : undefined) })),
  'escalated': () => runTaskSequentially(baseInput(), scripted({ assuranceRound: (r) => ({ kind: 'assuranceRound', outcome: escalate(r) }) })),
  'blocked': () => runTaskSequentially(baseInput(), scripted({ assuranceRound: (r) => ({ kind: 'assuranceRound', outcome: block(r) }) })),
  'agent-failed': () => runTaskSequentially(baseInput(), scripted({
    runAgent: () => ({ kind: 'runAgent', status: 'FAILED', reportedCostUsd: 1, reportedToolCalls: 3, wallClockMs: 1000, failureClass: 'policy-violation' }),
  })),
  'budget-exhausted': () => runTaskSequentially(baseInput(), scripted({
    runAgent: (_r, n) => (n === 1 ? { kind: 'runAgent', status: 'BUDGET_EXHAUSTED', reportedCostUsd: 5, reportedToolCalls: 50, wallClockMs: 1000, failureClass: null } : undefined),
  })),
  'cancelled': () => runTaskSequentially(baseInput(), scripted({}, { eventsDuring: (request) => (request.kind === 'runAgent' ? [cancel()] : []) })),
  'infrastructure-failed': () => runTaskSequentially(baseInput(), scripted({ prepareWorkspace: () => ({ kind: 'activityFailed', failureClass: 'artifact-loss', timedOut: false }) })),
};

test('slot terminals: each terminal of the contract reaches recordAttemptOutcome under its own name, and the slot accepts it', async () => {
  for (const [terminal, run] of Object.entries(TERMINAL_PATHS)) {
    const trace = run();
    const [first] = effectsOf(trace.commands, 'recordAttemptOutcome');
    assert.deepEqual([first?.attemptNumber, first?.terminal], [1, terminal], terminal);
    await assertSlotAcceptsTerminals(trace);
  }
});

test('slot terminals: an attempt that never held a lease ends only with a pre-lease terminal of the contract', async () => {
  const preLease = new Set<string>(PRE_LEASE_ATTEMPT_TERMINALS);
  const unleased: TaskTrace[] = [
    // Found registered after a failed registration: infrastructure-failed.
    runTaskSequentially(baseInput(), scripted({ ensureAttempt: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: false }) })),
    // A cancel that waited for the registration: cancelled.
    runTaskSequentially(baseInput(), scripted({}, { eventsDuring: (request) => (request.kind === 'ensureAttempt' ? [cancel()] : []) })),
  ];
  const written: string[] = [];
  for (const trace of unleased) {
    for (const o of effectsOf(trace.commands, 'recordAttemptOutcome')) {
      assert.equal(o.fence, null);
      written.push(o.terminal);
    }
    await assertSlotAcceptsTerminals(trace);
  }
  // A failed or aborted acquisition whose lookup finds no lease: the pre-lease write.
  for (const environment of [
    scripted({
      acquireLease: (_r, n) => (n === 1 ? { kind: 'activityFailed', failureClass: 'environment', timedOut: false } : undefined),
      findLease: () => ({ kind: 'findLease', fence: null }),
    }),
    scripted({ findLease: () => ({ kind: 'findLease', fence: null }) }, { eventsDuring: (request) => (request.kind === 'acquireLease' ? [cancel()] : []) }),
  ]) {
    const trace = runTaskSequentially(baseInput(), environment);
    for (const r of requests(trace.commands)) if (r.kind === 'recordPreLeaseOutcome') written.push(r.terminal);
  }
  assert.deepEqual(written, ['infrastructure-failed', 'cancelled', 'infrastructure-failed', 'cancelled']);
  for (const terminal of written) assert.ok(preLease.has(terminal), terminal);
});

test('slot terminals: a publish-change approval that is refused cancels the attempt, and an unavailable gate is infrastructure', () => {
  const input = baseInput({ governance: governance({ publicationApprovalRequired: true }) });
  const gateFails = runTaskSequentially(input, scripted({ openApprovalRequest: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: false }) }));
  assert.deepEqual(outcomes(gateFails), [[1, 'infrastructure-failed']]);
  assert.deepEqual([gateFails.summary.outcome, gateFails.summary.reason], ['BLOCKED', 'publication-unavailable']);
  const expired = runTaskSequentially(input, scripted({}, { whenIdle: idleScript((timers) => ({ type: 'timerFired', timerId: timers[0]! })) }));
  assert.deepEqual(outcomes(expired), [[1, 'cancelled']]);
  assert.deepEqual([expired.summary.outcome, expired.summary.reason], ['BLOCKED', 'publication-expired']);
});

// ---------------------------------------------------------------------------
// Registration before any attempt-bound effect: the slot kit's ordering case against the workflow
// ---------------------------------------------------------------------------

/** Requests that act on an attempt; the registration and its lookup are not among them. */
const ATTEMPT_BOUND_REQUESTS: ReadonlySet<TaskRequestKind> = new Set([
  'acquireLease', 'findLease', 'recordPreLeaseOutcome', 'prepareWorkspace', 'storeAttemptInputs', 'runAgent', 'inspectWorkspace',
  'runVerification', 'commitAttempt', 'persistEvidence', 'assuranceRound', 'publishBranch', 'upsertPullRequest', 'reconcilePublication',
]);
const ATTEMPT_BOUND_EFFECTS: ReadonlySet<TaskEffect['kind']> = new Set([
  'recordAttemptOutcome', 'recordUsage', 'recordOverrun', 'releaseLease', 'reapContainers', 'quarantineWorkspace', 'cleanupWorkspace',
]);

/** The attempt a command acts on, if it is attempt-bound. */
function boundAttempt(c: TaskCommand): { readonly attemptNumber: number; readonly effect: string } | null {
  if (c.type === 'request' && ATTEMPT_BOUND_REQUESTS.has(c.request.kind)) {
    const n = c.request.kind === 'assuranceRound' ? c.request.request.attemptNumber : (c.request as { readonly attemptNumber: number }).attemptNumber;
    return { attemptNumber: n, effect: c.request.kind };
  }
  if (c.type === 'effect' && ATTEMPT_BOUND_EFFECTS.has(c.effect.kind)) {
    return { attemptNumber: (c.effect as { readonly attemptNumber: number }).attemptNumber, effect: c.effect.kind };
  }
  return null;
}

/**
 * Replays the trace through the reducer and lists, in commit order, each attempt's registration as the workflow
 * reads it back (the ensureAttempt result, or a lookup that finds the attempt) and every attempt-bound command. An
 * effect is named by the id the registration of its attempt number reports, which the environment fixes.
 */
function lifecycleSteps(input: TaskCoreInput, trace: TaskTrace): AttemptLifecycleStep[] {
  const steps: AttemptLifecycleStep[] = [];
  const commit = (commands: readonly TaskCommand[]): void => {
    for (const c of commands) {
      const bound = boundAttempt(c);
      if (bound !== null) steps.push({ kind: 'attempt-bound-effect', attemptId: attemptIdFor(bound.attemptNumber), effect: bound.effect });
    }
  };
  let decision = startTask(input);
  commit(decision.commands);
  for (const event of trace.events) {
    const pending = decision.state.pending;
    decision = decideTask(decision.state, event);
    if (event.type === 'result' && pending?.seq === event.seq) {
      const r = event.result;
      if (r.kind === 'ensureAttempt' || (r.kind === 'findAttempt' && r.attemptId !== null)) {
        steps.push({ kind: 'registration-reconciled', attemptId: r.attemptId! });
      }
    }
    commit(decision.commands);
  }
  return steps;
}

const ORDERING_SCENARIOS: readonly (readonly [string, TaskCoreInput, TaskEnvironment])[] = [
  ['the first attempt to review handoff', baseInput(), scripted()],
  ['a repair attempt', baseInput(), scripted({ assuranceRound: (r, n) => (n === 1 ? { kind: 'assuranceRound', outcome: repair(r) } : undefined) })],
  ['a cancel before the lease', baseInput(), scripted({}, { eventsDuring: (request) => (request.kind === 'ensureAttempt' ? [cancel()] : []) })],
  ['a failed registration the lookup finds', baseInput(), scripted({ ensureAttempt: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: false }) })],
  ['a failed lease acquisition with no lease found', baseInput(), scripted({
    acquireLease: (_r, n) => (n === 1 ? { kind: 'activityFailed', failureClass: 'environment', timedOut: false } : undefined),
    findLease: () => ({ kind: 'findLease', fence: null }),
  })],
  ['an aborted lease acquisition', baseInput(), scripted({ findLease: () => ({ kind: 'findLease', fence: null }) }, {
    eventsDuring: (request) => (request.kind === 'acquireLease' ? [cancel()] : []),
  })],
  ['a worker that dies under the agent, and the replacement', baseInput(), scripted({
    runAgent: (_r, n) => (n === 1 ? { kind: 'activityFailed', failureClass: 'workflow-recovery-failure', timedOut: true } : undefined),
  })],
  ['a publication with an unknown effect, reconciled', baseInput(), scripted({ publishBranch: publicationFails('unknown') })],
];

test('registration order: no attempt-bound effect precedes its attempt\'s registration, by the slot kit\'s ordering case', async () => {
  const results = await runRegistrationOrderingContract(ORDERING_SCENARIOS.map(([name, input, environment]) => ({
    name,
    run: async () => lifecycleSteps(input, runTaskSequentially(input, environment)),
  })));
  assert.equal(results.length, ORDERING_SCENARIOS.length);
  for (const result of results) assert.equal(result.status, 'passed', `${result.caseId}: ${result.detail}`);
  // The steps are those the trace committed: the first scenario registers its attempt, then binds it.
  const steps = lifecycleSteps(baseInput(), runTaskSequentially(baseInput(), scripted()));
  assert.deepEqual(steps[0], { kind: 'registration-reconciled', attemptId: attemptIdFor(1) });
  assert.ok(steps.length > 1 && steps.slice(1).every((s) => s.kind === 'attempt-bound-effect'));
  // A registration that inserted nothing commits no step at all, which the kit would refuse as an empty scenario.
  const nothing = runTaskSequentially(baseInput(), scripted({
    ensureAttempt: () => ({ kind: 'activityFailed', failureClass: 'environment', timedOut: false }),
    findAttempt: () => ({ kind: 'findAttempt', attemptId: null }),
  }));
  assert.deepEqual(lifecycleSteps(baseInput(), nothing), []);
});

test('registration order: the ordering case fails a trace that binds an attempt the workflow never registered', async () => {
  // A failed registration that inserted nothing, with a usage entry written for its attempt as a faulty close would.
  const faulty: AttemptLifecycleStep[] = [{ kind: 'attempt-bound-effect', attemptId: attemptIdFor(1), effect: 'recordUsage' }];
  const [result] = await runRegistrationOrderingContract([{ name: 'faulty close', run: async () => faulty }]);
  assert.equal(result?.status, 'failed');
});
