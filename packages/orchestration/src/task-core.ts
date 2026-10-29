// The task workflow's decision core: a pure reducer over plain-data state.
//
// decideTask(state, event) returns the next state and the commands the
// interpreter carries out, in order: effects (run to completion, no result
// consumed), at most one awaited request (an activity), or completion. Every
// request has a sequence number; a result for anything but the pending request
// is stale and ignored, which is how the late result of an aborted request is
// discarded.
//
// The flow follows the task state machine: admission, budget check, attempt
// start, agent, inspection, verification, commit and evidence, one assurance
// round, the publication gate, push and PR, review handoff. An agent that stops
// at a cap or overruns one is inspected only and never verified or published.
// Abandoned and exhausted attempts are replaced only while nothing has been
// pushed and a fresh reservation fits; a failed verification ends the task;
// REPAIR starts a repair lineage at the outcome's base, and a retry keeps it.

import { ACTIVITY_OPTIONS } from './activity-options.js';
import { approvalRequestId, isWellFormedDecision, validateApprovalDecision } from './approvals.js';
import { parseAssuranceOutcome } from './assurance.js';
import { MAX_USD, checkReservation, crossesSoftThreshold, fromMicroUsd, reportedMicroUsd, toMicroUsd } from './budget.js';
import { NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import { isLegalProjection, isWorkStatus, statusForRequest } from './projection.js';
import type {
  ApprovalKind,
  AttemptState,
  AttemptOverrun,
  AttemptTerminal,
  ControlReceipt,
  FailureClass,
  LeaseFence,
  ObservedBranch,
  ObservedPullRequest,
  OpenApproval,
  ProjectedTaskStatus,
  PublicationEffect,
  RepairLineage,
  RepositoryId,
  RunEventDetail,
  RunEventType,
  TaskCommand,
  TaskCoreInput,
  TaskDecision,
  TaskEffect,
  TaskEvent,
  TaskId,
  TaskMessage,
  TaskOutcome,
  TaskPhase,
  TaskRequest,
  TaskRequestKind,
  TaskResult,
  TaskState,
  VerificationVerdict,
} from './types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableAttempt = Mutable<AttemptState>;

interface Draft
  extends Omit<Mutable<TaskState>, 'attempts' | 'approval' | 'decisionIds' | 'controlRequestIds' | 'activeTimers'> {
  attempts: MutableAttempt[];
  approval: Mutable<OpenApproval> | null;
  decisionIds: string[];
  controlRequestIds: string[];
  activeTimers: string[];
}

interface Step {
  readonly s: Draft;
  readonly out: TaskCommand[];
  abort: boolean;
  receipt: ControlReceipt | null;
}

const PHASE_OF: Readonly<Record<TaskRequestKind, TaskPhase>> = {
  admitTask: 'ADMITTING',
  ensureAttempt: 'ATTEMPT_STARTING',
  findAttempt: 'ATTEMPT_STARTING',
  acquireLease: 'ATTEMPT_STARTING',
  findLease: 'ATTEMPT_STARTING',
  recordPreLeaseOutcome: 'ATTEMPT_STARTING',
  prepareWorkspace: 'ATTEMPT_STARTING',
  storeAttemptInputs: 'ATTEMPT_STARTING',
  runAgent: 'AGENT_RUNNING',
  inspectWorkspace: 'INSPECTING',
  runVerification: 'VERIFYING',
  commitAttempt: 'COMMITTING',
  persistEvidence: 'EVIDENCE',
  assuranceRound: 'ASSURANCE_ROUND',
  openApprovalRequest: 'AWAITING_APPROVAL',
  verifyApprovalDecision: 'AWAITING_APPROVAL',
  publishBranch: 'PUBLISHING',
  upsertPullRequest: 'PUBLISHING',
  reconcilePublication: 'PUBLISHING',
};

const ACCEPTED: ControlReceipt = { accepted: true, duplicate: false, reason: null };
const DUPLICATE: ControlReceipt = { accepted: true, duplicate: true, reason: null };

export function taskWorkflowId(taskId: TaskId): string {
  return `asep-task-${taskId}`;
}

function approvalTimerId(id: string): string {
  return `approval:${id}`;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function startTask(input: TaskCoreInput): TaskDecision {
  const state: TaskState = {
    input,
    workflowId: taskWorkflowId(input.taskId),
    phase: 'ADMITTING',
    nextSeq: 1,
    pending: null,
    deferred: null,
    attempts: [],
    currentAttempt: null,
    nextAttempt: null,
    leaseLookup: null,
    publication: null,
    spentMicroUsd: 0,
    spentWallClockMinutes: 0,
    grantedExtensionMicroUsd: 0,
    softThresholdCrossed: false,
    overrun: false,
    pushRequested: false,
    pushConfirmed: false,
    approval: null,
    gateSeq: 0,
    decisionIds: [],
    controlRequestIds: [],
    paused: false,
    pauseCount: 0,
    pauseTimerId: null,
    activeTimers: [],
    cancelPending: false,
    projectionSeq: 0,
    projected: 'READY',
    workStatus: 'READY',
    eventSeq: 0,
    prNumber: null,
    outcome: null,
    reason: null,
  };
  const step = begin(state);
  issue(step, { kind: 'admitTask', risk: input.risk });
  return finish(step);
}

export function decideTask(state: TaskState, event: TaskEvent): TaskDecision {
  switch (event.type) {
    case 'result':
    case 'activityFailed': {
      if (state.outcome !== null || state.pending === null || state.pending.seq !== event.seq) return ignored(state);
      const step = begin(state);
      const request = state.pending.request;
      step.s.pending = null;
      if (event.type === 'result') {
        if (event.result.kind !== request.kind) {
          throw new Error(`result ${event.result.kind} does not answer pending request ${request.kind}`);
        }
        onResult(step, event.result);
      } else {
        onActivityFailed(step, request, event.failureClass, event.timedOut, event.effect);
      }
      return finish(step);
    }
    case 'timerFired': {
      if (state.outcome !== null || !state.activeTimers.includes(event.timerId)) return ignored(state);
      const step = begin(state);
      step.s.activeTimers = step.s.activeTimers.filter((t) => t !== event.timerId);
      onTimer(step, event.timerId);
      return finish(step);
    }
    default:
      return onMessage(state, event);
  }
}

function begin(state: TaskState): Step {
  const s: Draft = {
    ...state,
    attempts: state.attempts.map((a) => ({ ...a })),
    approval: state.approval === null ? null : { ...state.approval },
    decisionIds: [...state.decisionIds],
    controlRequestIds: [...state.controlRequestIds],
    activeTimers: [...state.activeTimers],
  };
  return { s, out: [], abort: false, receipt: null };
}

function finish(step: Step): TaskDecision {
  return { state: step.s, commands: step.out, abortInFlight: step.abort, receipt: step.receipt };
}

function ignored(state: TaskState): TaskDecision {
  return { state, commands: [], abortInFlight: false, receipt: null };
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function effect(step: Step, e: TaskEffect): void {
  step.out.push({ type: 'effect', effect: e });
}

function project(step: Step, status: ProjectedTaskStatus): void {
  const s = step.s;
  if (s.projected === status) return;
  s.projectionSeq += 1;
  effect(step, { kind: 'projectTaskState', projectionSeq: s.projectionSeq, status });
  s.projected = status;
  if (isWorkStatus(status)) s.workStatus = status;
}

function emit(step: Step, eventType: RunEventType, attemptNumber: number | null, detail: RunEventDetail = {}): void {
  const s = step.s;
  s.eventSeq += 1;
  effect(step, {
    kind: 'emitRunEvent',
    eventSeq: s.eventSeq,
    eventType,
    attemptNumber,
    detail: { workflowId: s.workflowId, ...detail },
  });
}

function audit(step: Step, action: string, detail: RunEventDetail): void {
  effect(step, { kind: 'audit', action, detail: { workflowId: step.s.workflowId, ...detail } });
}

function startTimer(step: Step, timerId: string, seconds: number): void {
  step.s.activeTimers.push(timerId);
  effect(step, { kind: 'startTimer', timerId, seconds });
}

function cancelTimer(step: Step, timerId: string): void {
  if (!step.s.activeTimers.includes(timerId)) return;
  step.s.activeTimers = step.s.activeTimers.filter((t) => t !== timerId);
  effect(step, { kind: 'cancelTimer', timerId });
}

function attempt(s: Draft, attemptNumber: number): MutableAttempt {
  const found = s.attempts.find((a) => a.attemptNumber === attemptNumber);
  if (!found) throw new Error(`unknown attempt ${attemptNumber}`);
  return found;
}

function current(s: Draft): MutableAttempt {
  if (s.currentAttempt === null) throw new Error('no current attempt');
  return attempt(s, s.currentAttempt);
}

/** The commit an attempt starts from: the lineage's repair base, else the task's base. */
function baseOf(s: Draft, lineage: RepairLineage | null): string {
  return lineage?.repairBaseSha ?? s.input.baseSha;
}

/**
 * True for the request that finishes a unit already under way: the evidence
 * binding after its commit, the PR upsert once a push has started, the lookup
 * that settles whether a failed registration inserted its attempt, and the lease
 * lookups and pre-lease write that settle a failed or aborted lease acquisition.
 */
function completesStartedUnit(s: Draft, request: TaskRequest): boolean {
  return request.kind === 'persistEvidence'
    || request.kind === 'findAttempt'
    || request.kind === 'findLease'
    || request.kind === 'recordPreLeaseOutcome'
    || request.kind === 'reconcilePublication'
    || (request.kind === 'upsertPullRequest' && s.pushRequested);
}

/**
 * Issue the next request, unless a pending cancel or a pause intervenes. A
 * request that finishes a critical unit already under way is never withheld.
 */
function issue(step: Step, request: TaskRequest): void {
  const s = step.s;
  const continuesUnit = completesStartedUnit(s, request);
  if (s.cancelPending && !continuesUnit) {
    close(step, 'CANCELLED', 'cancelled');
    return;
  }
  if (s.paused && !continuesUnit && request.kind !== 'verifyApprovalDecision') {
    defer(step, request);
    return;
  }
  // Leaving a pause returns to the working status; a request issued while still paused (a decision
  // verification) leaves the projection PAUSED.
  const target = statusForRequest(request.kind, s.workStatus) ?? (s.projected === 'PAUSED' && !s.paused ? s.workStatus : null);
  if (target !== null) project(step, target);
  markIssued(s, request);
  s.phase = PHASE_OF[request.kind];
  const seq = s.nextSeq;
  s.nextSeq += 1;
  s.pending = { seq, request };
  step.out.push({ type: 'request', seq, request });
}

function markIssued(s: Draft, request: TaskRequest): void {
  switch (request.kind) {
    case 'ensureAttempt': {
      const plan = s.nextAttempt;
      if (plan === null) throw new Error('ensureAttempt without an attempt plan');
      s.attempts.push({
        attemptNumber: request.attemptNumber,
        kind: plan.kind,
        lineage: plan.lineage,
        attemptId: null,
        branch: null,
        registered: false,
        stateUnknown: false,
        leaseRequested: false,
        fence: null,
        leaseReleased: false,
        workspaceRequested: false,
        workspaceActive: false,
        workspaceDisposed: false,
        agentStarted: false,
        agentUsage: null,
        overrun: null,
        exhausted: false,
        verificationStarted: false,
        reaped: false,
        declaredComplete: false,
        verdict: null,
        resultSha: null,
        evidenceId: null,
        adjudicationId: null,
        outcomeRecorded: false,
        usageRecorded: false,
      });
      s.currentAttempt = request.attemptNumber;
      s.nextAttempt = null;
      return;
    }
    case 'acquireLease':
      attempt(s, request.attemptNumber).leaseRequested = true;
      return;
    case 'prepareWorkspace':
      attempt(s, request.attemptNumber).workspaceRequested = true;
      return;
    case 'runAgent':
      attempt(s, request.attemptNumber).agentStarted = true;
      return;
    case 'runVerification':
      attempt(s, request.attemptNumber).verificationStarted = true;
      return;
    case 'publishBranch':
      s.pushRequested = true;
      return;
    default:
      return;
  }
}

/**
 * Withhold the request at a phase boundary: project the phase's status, then
 * PAUSED, and start the pause timer. A pause that already applied while the task
 * waited for an approval keeps its projection and timer.
 */
function defer(step: Step, request: TaskRequest): void {
  const s = step.s;
  const applied = s.pauseTimerId !== null;
  if (!applied) {
    project(step, statusForRequest(request.kind, s.workStatus) ?? s.workStatus);
    project(step, 'PAUSED');
  }
  s.deferred = request;
  s.phase = 'PAUSED';
  if (!applied) startPauseTimer(step);
}

function startPauseTimer(step: Step): void {
  const s = step.s;
  s.pauseCount += 1;
  s.pauseTimerId = `pause:${s.pauseCount}`;
  startTimer(step, s.pauseTimerId, s.input.governance.maxPauseHours * 3600);
}

/**
 * Apply a requested pause at once when nothing is in flight, which happens only
 * while the task waits for an approval: project PAUSED and start the pause timer.
 * The approval's expiry timer keeps running.
 */
function applyPauseIfIdle(step: Step): void {
  const s = step.s;
  if (!s.paused || s.pending !== null || s.deferred !== null || s.pauseTimerId !== null || s.outcome !== null) return;
  project(step, 'PAUSED');
  s.phase = 'PAUSED';
  startPauseTimer(step);
}

// ---------------------------------------------------------------------------
// Attempt bookkeeping
// ---------------------------------------------------------------------------

function nonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Note the agent's usage and detect an overrun: reported cost or tool calls
 * above a cap the adapter did not stop at, harness-measured wall-clock above
 * the cap plus the adapter's kill grace, or a usage value that is not a valid
 * amount within its bound. A recorded overrun fails every later reservation of
 * the task.
 */
function noteAgentUsage(step: Step, a: MutableAttempt, result: Extract<TaskResult, { kind: 'runAgent' }>): void {
  const s = step.s;
  const budget = s.input.attemptBudget;
  const toolCalls = nonNegative(result.reportedToolCalls);
  const wallClockMs = nonNegative(result.wallClockMs);
  const capMicro = toMicroUsd(budget.maxCostUsd);
  // Compared with the cap before any saturation: a report outside the bound is an overrun by itself, and only the
  // ledger amount saturates (at the bound above it, at the cap for a report that is no amount at all).
  const reportedMicro = reportedMicroUsd(result.reportedCostUsd);
  const chargedMicro = reportedMicro ?? (result.reportedCostUsd > MAX_USD ? toMicroUsd(MAX_USD) : capMicro);
  a.agentUsage = {
    chargedMicroUsd: chargedMicro,
    reportedCostUsd: nonNegative(result.reportedCostUsd),
    minutes: wallClockMs !== null ? Math.ceil(wallClockMs / 60_000) : budget.maxWallClockMinutes,
  };
  const capMs = budget.maxWallClockMinutes * 60_000;
  const toleratedMs = capMs + s.input.policy.agentKillGraceSeconds * 1000;
  const overrun: AttemptOverrun = {
    overrunUsd: fromMicroUsd(Math.max(0, chargedMicro - capMicro)),
    overrunToolCalls: toolCalls !== null ? Math.max(0, Math.ceil(toolCalls) - budget.maxToolCalls) : 0,
    overrunWallClockMs: wallClockMs !== null && wallClockMs > toleratedMs ? Math.ceil(wallClockMs - capMs) : 0,
    usageOutOfBound: reportedMicro === null || toolCalls === null || wallClockMs === null,
  };
  if (overrun.overrunUsd > 0 || overrun.overrunToolCalls > 0 || overrun.overrunWallClockMs > 0 || overrun.usageOutOfBound) {
    a.overrun = overrun;
    s.overrun = true;
  }
}

/**
 * One usage entry per attempt, at its terminal. An agent that never reported (it
 * died, timed out or was cancelled) is charged its full cap. Verification has no
 * metered cost source, so once it ran the attempt is also charged its reserve.
 */
function recordUsage(step: Step, a: MutableAttempt): void {
  if (a.usageRecorded) return;
  a.usageRecorded = true;
  const s = step.s;
  const budget = s.input.attemptBudget;
  const reserve = s.input.verificationReserve;
  const agent = a.agentUsage
    ?? (a.agentStarted
      ? { chargedMicroUsd: toMicroUsd(budget.maxCostUsd), reportedCostUsd: null, minutes: budget.maxWallClockMinutes }
      : { chargedMicroUsd: 0, reportedCostUsd: null, minutes: 0 });
  const reserveMicro = a.verificationStarted ? toMicroUsd(reserve.costUsd) : 0;
  const chargedMicro = agent.chargedMicroUsd + reserveMicro;
  const minutes = agent.minutes + (a.verificationStarted ? reserve.wallClockMinutes : 0);
  const before = s.spentMicroUsd;
  s.spentMicroUsd += chargedMicro;
  s.spentWallClockMinutes += minutes;
  effect(step, {
    kind: 'recordUsage',
    attemptNumber: a.attemptNumber,
    chargedCostUsd: fromMicroUsd(chargedMicro),
    reportedCostUsd: agent.reportedCostUsd,
    verificationReserveUsd: fromMicroUsd(reserveMicro),
    chargedWallClockMinutes: minutes,
  });
  if (a.overrun !== null) {
    effect(step, { kind: 'recordOverrun', attemptNumber: a.attemptNumber, ...a.overrun });
    audit(step, 'budget.overrun', { attemptNumber: a.attemptNumber, ...a.overrun });
  }
  if (!s.softThresholdCrossed && crossesSoftThreshold(before, s.spentMicroUsd, s.input.taskBudget.softCostUsd)) {
    s.softThresholdCrossed = true;
    emit(step, 'budget.threshold_crossed', a.attemptNumber, { thresholdKind: 'soft', budgetScope: 'task' });
    audit(step, 'budget.threshold_crossed', { thresholdKind: 'soft', budgetScope: 'task', spentUsd: fromMicroUsd(s.spentMicroUsd) });
  }
}

/** An attempt's terminal: its usage entry, then its one outcome record. */
function endAttempt(step: Step, a: MutableAttempt, terminal: AttemptTerminal): void {
  recordUsage(step, a);
  recordOutcome(step, a, terminal);
}

/**
 * The terminal is written with the caller's fence of the lease the attempt holds or held, or with none for an
 * attempt that never asked for a lease. An attempt whose lease request is not settled has no terminal yet: its lease
 * lookup comes first.
 */
function recordOutcome(step: Step, a: MutableAttempt, terminal: AttemptTerminal): void {
  if (a.outcomeRecorded) return;
  if (a.leaseRequested && a.fence === null) throw new Error(`terminal of attempt ${a.attemptNumber} before its lease is settled`);
  a.outcomeRecorded = true;
  effect(step, {
    kind: 'recordAttemptOutcome',
    attemptNumber: a.attemptNumber,
    fence: a.fence,
    terminal,
    declaredComplete: a.declaredComplete,
    verificationVerdict: a.verdict,
    adjudicationId: a.adjudicationId,
  });
}

function disposeWorkspace(step: Step, a: MutableAttempt, disposal: 'cleanup' | 'quarantine', reason: string): void {
  if (!a.workspaceRequested || a.workspaceDisposed) return;
  a.workspaceDisposed = true;
  a.workspaceActive = false;
  effect(step, disposal === 'cleanup'
    ? { kind: 'cleanupWorkspace', attemptNumber: a.attemptNumber }
    : { kind: 'quarantineWorkspace', attemptNumber: a.attemptNumber, reason });
}

/** The terminal outcome is written under the lease, so the lease is released only once the outcome is recorded. */
function releaseLease(step: Step, a: MutableAttempt): void {
  if (a.fence === null || a.leaseReleased) return;
  if (!a.outcomeRecorded) throw new Error(`lease of attempt ${a.attemptNumber} released before its outcome`);
  a.leaseReleased = true;
  effect(step, { kind: 'releaseLease', attemptNumber: a.attemptNumber, fence: a.fence });
}

/**
 * End an attempt and release its resources: a failed or interrupted attempt is
 * reaped and quarantined, then its usage and outcome are recorded, and only then
 * is its lease released. Effects run in order, so the outcome is written while
 * the attempt still holds the lease.
 */
function finishAttempt(
  step: Step,
  a: MutableAttempt,
  terminal: AttemptTerminal,
  disposal: 'cleanup' | 'quarantine',
  reason: string,
): void {
  if (disposal === 'quarantine' && a.agentStarted && !a.reaped) {
    a.reaped = true;
    effect(step, { kind: 'reapContainers', attemptNumber: a.attemptNumber });
  }
  disposeWorkspace(step, a, disposal, reason);
  endAttempt(step, a, terminal);
  releaseLease(step, a);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function onResult(step: Step, result: TaskResult): void {
  const s = step.s;
  switch (result.kind) {
    case 'admitTask':
      if (!result.admitted) {
        close(step, 'BLOCKED', result.reason);
        return;
      }
      emit(step, 'task.started', null);
      s.nextAttempt = { kind: 'initial', lineage: null, replacesTimedOut: false };
      budgetCheck(step);
      return;
    case 'ensureAttempt': {
      const a = current(s);
      a.attemptId = result.attemptId;
      a.branch = result.branch;
      a.registered = true;
      emit(step, 'attempt.started', a.attemptNumber);
      if (a.kind === 'repair' && a.lineage !== null) emit(step, 'repair.started', a.attemptNumber, { repairRound: a.lineage.round });
      issue(step, { kind: 'acquireLease', attemptNumber: a.attemptNumber });
      return;
    }
    case 'findAttempt': {
      // The registration failed; the attempt exists only if the lookup found it.
      // Either way it is never replaced, so numbering stays contiguous.
      const a = current(s);
      if (result.attemptId !== null) {
        a.attemptId = result.attemptId;
        a.registered = true;
      }
      close(step, 'FAILED', 'attempt-registration-failed');
      return;
    }
    case 'acquireLease': {
      const a = current(s);
      a.fence = result.fence;
      issue(step, { kind: 'prepareWorkspace', attemptNumber: a.attemptNumber, baseSha: baseOf(s, a.lineage) });
      return;
    }
    case 'findLease':
      leaseFound(step, result.fence);
      return;
    case 'recordPreLeaseOutcome':
      preLeaseOutcome(step, result.recorded);
      return;
    case 'prepareWorkspace': {
      const a = current(s);
      a.workspaceActive = true;
      // The parent's harness commit is the repair base. Its worktree keeps that
      // commit reachable, so it is disposed only once a lineage worktree exists;
      // a replaced lineage attempt is quarantined, which keeps it reachable too.
      if (a.lineage !== null) disposeWorkspace(step, attempt(s, a.lineage.parentAttemptNumber), 'cleanup', 'repaired');
      issue(step, { kind: 'storeAttemptInputs', attemptNumber: a.attemptNumber, repairOrderRef: a.lineage?.repairOrderRef ?? null });
      return;
    }
    case 'storeAttemptInputs': {
      const a = current(s);
      issue(step, { kind: 'runAgent', attemptNumber: a.attemptNumber, budget: s.input.attemptBudget });
      return;
    }
    case 'runAgent': {
      // The agent outcome table: a cap stop or an overrun is inspected only, to
      // record the workspace state; an agent failure abandons the attempt. A
      // non-replaceable failure beats both, because the exhaustion path can lead
      // to an extension and a new attempt; its overrun is still recorded.
      const a = current(s);
      noteAgentUsage(step, a, result);
      a.declaredComplete = result.status === 'AGENT_DONE';
      const failed = result.status === 'FAILED' || result.status === 'BLOCKED'
        || (result.status === 'BUDGET_EXHAUSTED' && result.failureClass !== null);
      if (failed && !isReplaceable(s, result.failureClass)) {
        abandon(step, result.failureClass, false, result.failureClass ?? `agent-${result.status.toLowerCase()}`);
        return;
      }
      if (result.status === 'BUDGET_EXHAUSTED' || a.overrun !== null) {
        a.exhausted = true;
      } else if (result.status !== 'AGENT_DONE') {
        abandon(step, result.failureClass, false, result.failureClass ?? `agent-${result.status.toLowerCase()}`);
        return;
      }
      issue(step, { kind: 'inspectWorkspace', attemptNumber: a.attemptNumber });
      return;
    }
    case 'inspectWorkspace': {
      const a = current(s);
      if (result.overstep) {
        abandon(step, 'policy-violation', false, 'policy-violation');
        return;
      }
      if (a.exhausted) {
        exhaust(step);
        return;
      }
      issue(step, { kind: 'runVerification', attemptNumber: a.attemptNumber });
      return;
    }
    case 'runVerification': {
      const a = current(s);
      if (result.verdict !== 'PASS') {
        verificationStop(step, result.verdict);
        return;
      }
      a.verdict = 'PASS';
      issue(step, { kind: 'commitAttempt', attemptNumber: a.attemptNumber, expectedHeadSha: baseOf(s, a.lineage) });
      return;
    }
    case 'commitAttempt': {
      const a = current(s);
      a.resultSha = result.resultSha;
      issue(step, { kind: 'persistEvidence', attemptNumber: a.attemptNumber });
      return;
    }
    case 'persistEvidence': {
      const a = current(s);
      a.evidenceId = result.evidenceId;
      issue(step, {
        kind: 'assuranceRound',
        request: {
          attemptNumber: a.attemptNumber,
          round: roundOf(a),
          evidenceId: result.evidenceId,
          taskBaseSha: s.input.baseSha,
          declaredComplete: a.declaredComplete,
          priorAdjudicationId: a.lineage?.priorAdjudicationId ?? null,
          idempotencyKey: `${s.workflowId}:assurance:${a.attemptNumber}:${roundOf(a)}`,
        },
      });
      return;
    }
    case 'assuranceRound':
      route(step, result.outcome);
      return;
    case 'openApprovalRequest':
      approvalOpened(step);
      return;
    case 'verifyApprovalDecision':
      approvalVerified(step, result);
      return;
    case 'publishBranch':
      pushApplied(step);
      return;
    case 'upsertPullRequest':
      pullRequestUpserted(step, result.prNumber);
      return;
    case 'reconcilePublication':
      publicationReconciled(step, result);
      return;
  }
}

function onActivityFailed(
  step: Step,
  request: TaskRequest,
  failureClass: FailureClass,
  timedOut: boolean,
  effect: PublicationEffect,
): void {
  const s = step.s;
  switch (request.kind) {
    case 'admitTask':
      close(step, 'BLOCKED', 'admission-unavailable');
      return;
    case 'ensureAttempt':
      // The insert may or may not have committed: settle it before any attempt-bound effect.
      issue(step, { kind: 'findAttempt', attemptNumber: request.attemptNumber });
      return;
    case 'findAttempt':
      // Whether the attempt exists stays unknown: no attempt-bound effect, and an operator reconciles it.
      attemptStateUnknown(step, attempt(s, request.attemptNumber), 'findAttempt');
      return;
    case 'acquireLease':
      lookUpLease(step, failureClass, timedOut);
      return;
    case 'findLease':
    case 'recordPreLeaseOutcome':
      // The store cannot tell whether the attempt holds a lease, or whether its pre-lease terminal committed.
      attemptStateUnknown(step, attempt(s, request.attemptNumber), request.kind);
      return;
    case 'prepareWorkspace':
    case 'storeAttemptInputs':
    case 'runAgent':
    case 'inspectWorkspace':
    case 'commitAttempt':
    case 'persistEvidence':
      abandon(step, failureClass, timedOut, failureClass);
      return;
    case 'runVerification':
      // Infrastructure errors were already retried inside the activity.
      verificationStop(step, 'ERROR');
      return;
    case 'assuranceRound':
      assuranceUnavailable(step, failureClass);
      return;
    case 'openApprovalRequest':
    case 'verifyApprovalDecision': {
      const ap = s.approval;
      if (ap === null) throw new Error('approval activity failed without an approval');
      rejectApproval(step, ap.kind, 'unavailable');
      return;
    }
    // Only the reported effect says what the remote holds; retryability never does.
    case 'publishBranch':
      if (effect === 'applied') pushApplied(step);
      else if (effect === 'none') close(step, 'FAILED', 'publication-failed');
      else reconcilePublication(step);
      return;
    case 'upsertPullRequest':
      // Known absent: the branch is left without a PR. Otherwise the PR may exist and its number is unknown.
      if (effect === 'none') publicationIncomplete(step, 'upsert-not-applied', null);
      else reconcilePublication(step);
      return;
    case 'reconcilePublication':
      publicationIncomplete(step, 'remote-unreadable', null);
      return;
  }
}

/**
 * A lease acquisition failed after its retries, or a cancel aborted it. The grant may have committed all the same,
 * and then the workflow never received its fence, so the attempt's lease history is read before any terminal.
 */
function lookUpLease(step: Step, failureClass: FailureClass | null, timedOut: boolean): void {
  const s = step.s;
  const a = current(s);
  s.leaseLookup = { attemptNumber: a.attemptNumber, lookups: 1, failureClass, timedOut };
  issue(step, { kind: 'findLease', attemptNumber: a.attemptNumber });
}

function leaseLookup(s: Draft) {
  if (s.leaseLookup === null) throw new Error('no lease lookup');
  return s.leaseLookup;
}

/**
 * The lease history is read. A lease found is the attempt's: its terminal and release carry that fence. None found
 * makes the terminal a pre-lease one, written with fence null, which a grant that committed since can refuse. A
 * second lookup runs only after such a refusal, and a lease in history never disappears, so a second lookup that
 * finds none means the store cannot be trusted.
 */
function leaseFound(step: Step, fence: LeaseFence | null): void {
  const s = step.s;
  const lookup = leaseLookup(s);
  const a = attempt(s, lookup.attemptNumber);
  if (fence !== null) {
    a.fence = fence;
    leaseSettled(step);
    return;
  }
  if (lookup.lookups > 1) {
    attemptStateUnknown(step, a, 'findLease');
    return;
  }
  issue(step, {
    kind: 'recordPreLeaseOutcome',
    attemptNumber: a.attemptNumber,
    terminal: lookup.failureClass === null || s.cancelPending ? 'cancelled' : 'failed',
    declaredComplete: a.declaredComplete,
    verificationVerdict: a.verdict,
    adjudicationId: a.adjudicationId,
  });
}

/**
 * The pre-lease terminal was recorded, and the attempt's usage entry (zero: its agent never ran) follows it; or it
 * was refused because a grant committed after the lookup, and the history is read again. Usage waits for the
 * terminal, so an attempt whose terminal stays unknown has no usage entry either.
 */
function preLeaseOutcome(step: Step, recorded: boolean): void {
  const s = step.s;
  const lookup = leaseLookup(s);
  if (recorded) {
    const a = attempt(s, lookup.attemptNumber);
    a.outcomeRecorded = true;
    recordUsage(step, a);
    leaseSettled(step);
    return;
  }
  s.leaseLookup = { ...lookup, lookups: lookup.lookups + 1 };
  issue(step, { kind: 'findLease', attemptNumber: lookup.attemptNumber });
}

/** The lease is settled: the attempt is abandoned as after any failed attempt activity, or the abort's cancel closes. */
function leaseSettled(step: Step): void {
  const s = step.s;
  const lookup = leaseLookup(s);
  s.leaseLookup = null;
  if (lookup.failureClass === null) close(step, 'CANCELLED', 'cancelled');
  else abandon(step, lookup.failureClass, lookup.timedOut, lookup.failureClass);
}

/** The attempt's natural key (task id, attempt number), rendered for audits and the task result. */
function attemptIdempotencyKey(s: Draft, attemptNumber: number): string {
  return `${s.input.taskId}:attempt:${attemptNumber}`;
}

/**
 * A lookup of the attempt's state failed after its retries: the store cannot be read, so whether the attempt
 * exists, or holds a lease, is unknown. Its terminal is not recorded, the one exception to every terminal being
 * recorded; the task fails, also over a pending cancel, and the audit and the task result name the attempt by its
 * idempotency key, so telemetry reports the gap.
 */
function attemptStateUnknown(step: Step, a: MutableAttempt, lookup: TaskRequestKind): void {
  const s = step.s;
  a.stateUnknown = true;
  audit(step, 'attempt.state-unknown', {
    attemptNumber: a.attemptNumber,
    idempotencyKey: attemptIdempotencyKey(s, a.attemptNumber),
    lookup,
    cancelRequested: s.cancelPending,
  });
  close(step, 'FAILED', 'attempt-state-unknown', 'failed', true);
}

function publication(s: Draft) {
  if (s.publication === null) throw new Error('no publication plan');
  return s.publication;
}

function pushApplied(step: Step): void {
  step.s.pushConfirmed = true;
  upsertPullRequest(step);
}

function pullRequestUpserted(step: Step, prNumber: number): void {
  step.s.prNumber = prNumber;
  handoff(step);
}

/** Read the remote before any terminal state: a push or PR upsert reported an unknown effect. */
function reconcilePublication(step: Step): void {
  const s = step.s;
  const a = attempt(s, publication(s).attemptNumber);
  if (a.branch === null || a.resultSha === null) throw new Error('publication without a remote branch or a commit');
  issue(step, {
    kind: 'reconcilePublication',
    attemptNumber: a.attemptNumber,
    repository: s.input.repository,
    remoteBranch: a.branch,
    expectedHeadSha: a.resultSha,
    expectedBaseBranch: s.input.baseBranch,
  });
}

type ReconciliationRead = Extract<TaskResult, { kind: 'reconcilePublication' }>;

/** The forge names repositories case-insensitively. */
function sameRepository(observed: RepositoryId, binding: RepositoryId): boolean {
  return observed.owner.toLowerCase() === binding.owner.toLowerCase() && observed.name.toLowerCase() === binding.name.toLowerCase();
}

/** What a read found of the attempt branch: `own` when it is in the binding repository at the attempt's commit. */
function branchFinding(s: Draft, a: MutableAttempt, branch: ObservedBranch | null): string {
  if (branch === null) return 'branch-missing';
  if (!sameRepository(branch.repository, s.input.repository)) return 'branch-other-repository';
  return branch.headSha === a.resultSha ? 'own' : 'branch-moved';
}

/**
 * What a read found among the PRs listed for the attempt branch: `none`, or `own` for exactly one that is open,
 * unmerged, from the binding repository with the attempt's branch and commit as head, into the binding repository's
 * task base; anything else names the first difference.
 */
function pullRequestFinding(s: Draft, a: MutableAttempt, candidates: readonly ObservedPullRequest[]): string {
  const [pr, ...others] = candidates;
  if (pr === undefined) return 'none';
  if (others.length > 0) return 'pull-requests-multiple';
  if (pr.merged) return 'pull-request-merged';
  if (pr.state !== 'open') return 'pull-request-closed';
  if (!sameRepository(pr.headRepository, s.input.repository)) return 'pull-request-fork-head';
  if (pr.headBranch !== a.branch || pr.headSha !== a.resultSha) return 'pull-request-other-head';
  if (!sameRepository(pr.baseRepository, s.input.repository) || pr.baseBranch !== s.input.baseBranch) return 'pull-request-other-base';
  return 'own';
}

/**
 * Settle an unknown effect from what the remote holds. The remote is this
 * attempt's publication only when the branch is in the binding repository at
 * the attempt's commit and the PRs listed for it are none or exactly the
 * attempt's own; the same rule holds before and after the push is confirmed.
 * Before it, a remote with no branch and no PR means nothing was pushed; after
 * it, the PR must be there. Anything else cannot be reconciled.
 */
function publicationReconciled(step: Step, result: ReconciliationRead): void {
  const s = step.s;
  const a = attempt(s, publication(s).attemptNumber);
  const branch = branchFinding(s, a, result.branch);
  const pr = pullRequestFinding(s, a, result.pullRequests);
  if (!s.pushConfirmed) {
    if (branch === 'own' && (pr === 'none' || pr === 'own')) pushApplied(step);
    else if (branch === 'branch-missing' && pr === 'none') close(step, 'FAILED', 'publication-failed');
    else publicationIncomplete(step, branch === 'own' ? pr : branch, result);
    return;
  }
  const [own] = result.pullRequests;
  if (branch === 'own' && pr === 'own' && own !== undefined) pullRequestUpserted(step, own.number);
  else publicationIncomplete(step, branch !== 'own' ? branch : pr === 'none' ? 'pull-request-missing' : pr, result);
}

function upsertPullRequest(step: Step): void {
  const plan = publication(step.s);
  issue(step, {
    kind: 'upsertPullRequest',
    attemptNumber: plan.attemptNumber,
    baseBranch: step.s.input.baseBranch,
    flagged: plan.flagged,
    prBodySectionRef: plan.prBodySectionRef,
  });
}

/**
 * The publication cannot reconcile: the PR upsert failed with the branch on the
 * remote, the remote could not be read, or it is not exactly the attempt's. The
 * task fails, also over a pending cancel, and the audit names the branch, what
 * was found and the read as observed, for a human.
 */
function publicationIncomplete(step: Step, finding: string, read: ReconciliationRead | null): void {
  const s = step.s;
  const a = attempt(s, publication(s).attemptNumber);
  audit(step, 'publication.incomplete', {
    attemptNumber: a.attemptNumber,
    remoteBranch: a.branch ?? '',
    pushConfirmed: s.pushConfirmed,
    cancelRequested: s.cancelPending,
    finding,
    ...(read === null ? {} : { observed: JSON.stringify({ branch: read.branch, pullRequests: read.pullRequests }) }),
  });
  close(step, 'FAILED', 'publication-incomplete', 'failed', true);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Check the reservation for the planned attempt and start it, ask for an extension, or stop. */
function budgetCheck(step: Step): void {
  const s = step.s;
  const plan = s.nextAttempt;
  if (plan === null) throw new Error('budget check without an attempt plan');
  s.phase = 'BUDGET_CHECK';
  const attemptNumber = s.attempts.length + 1;
  const reservation = checkReservation({
    attemptNumber,
    attemptBudget: s.input.attemptBudget,
    taskBudget: s.input.taskBudget,
    verificationReserve: s.input.verificationReserve,
    runRemainingUsd: s.input.runRemainingUsd,
    spentMicroUsd: s.spentMicroUsd,
    spentWallClockMinutes: s.spentWallClockMinutes,
    grantedExtensionMicroUsd: s.grantedExtensionMicroUsd,
    overrun: s.overrun,
  });
  if (reservation.ok) {
    if (plan.replacesTimedOut) emit(step, 'workflow.recovered', attemptNumber, { recoveryKind: 'attempt-replaced' });
    issue(step, {
      kind: 'ensureAttempt',
      attemptNumber,
      attemptKind: plan.kind,
      baseSha: baseOf(s, plan.lineage),
      parentAttemptNumber: plan.lineage?.parentAttemptNumber ?? null,
      repairOrderRef: plan.lineage?.repairOrderRef ?? null,
    });
    return;
  }
  // The reservation-failure table. Running out of attempts fails the task,
  // whatever the budget says; every budget cause ends it BUDGET_EXHAUSTED, after
  // a budget-extension approval only for the task cap and only while the policy
  // sets an extension bound.
  if (reservation.reason === 'attempts-exhausted') {
    close(step, 'FAILED', plan.lineage !== null ? 'repair-capacity-exhausted' : 'attempts-exhausted');
    return;
  }
  if (reservation.reason === 'task-budget' && s.input.policy.maxBudgetExtensionUsd !== null) {
    openApproval(step, 'budget-extension', null, reservation.shortfallUsd);
    return;
  }
  close(step, 'BUDGET_EXHAUSTED', reservation.reason);
}

/**
 * Only a failure class the policy lists as replaceable may be followed by a new
 * attempt, and never one of the never-replaceable classes, whatever the policy says.
 */
function isReplaceable(s: Draft, failureClass: FailureClass | null): boolean {
  return failureClass !== null
    && !NEVER_REPLACEABLE_FAILURE_CLASSES.includes(failureClass)
    && s.input.policy.replaceableFailureClasses.includes(failureClass);
}

/** Abandon the current attempt; replace it, with the same lineage, only if the class allows and nothing was pushed. */
function abandon(step: Step, failureClass: FailureClass | null, timedOut: boolean, reason: string): void {
  const s = step.s;
  const a = current(s);
  s.phase = 'ATTEMPT_ABANDONED';
  finishAttempt(step, a, 'failed', 'quarantine', reason);
  s.currentAttempt = null;
  if (!isReplaceable(s, failureClass)) {
    close(step, 'FAILED', reason);
    return;
  }
  if (s.pushRequested) {
    close(step, 'FAILED', 'failed-after-push');
    return;
  }
  s.nextAttempt = { kind: 'retry', lineage: a.lineage, replacesTimedOut: timedOut };
  budgetCheck(step);
}

/**
 * End an attempt whose agent stopped at a cap or overran one. Nothing of it is
 * verified, committed or published; a retry with the same lineage needs a fresh
 * reservation, which a recorded overrun never gets.
 */
function exhaust(step: Step): void {
  const s = step.s;
  const a = current(s);
  s.phase = 'ATTEMPT_EXHAUSTED';
  finishAttempt(step, a, 'budget-exhausted', 'quarantine', 'budget-exhausted');
  s.currentAttempt = null;
  s.nextAttempt = { kind: 'retry', lineage: a.lineage, replacesTimedOut: false };
  budgetCheck(step);
}

/** A failed or errored mandatory verification ends the task: no assurance round, no approval, no push. */
function verificationStop(step: Step, verdict: VerificationVerdict): void {
  const a = current(step.s);
  a.verdict = verdict;
  endAttempt(step, a, 'verification-failed');
  close(step, 'FAILED', 'verification-failed');
}

function roundOf(a: MutableAttempt): number {
  return a.lineage?.round ?? 1;
}

/**
 * The assurance activity failed after its retries, or non-retryably. That is an
 * infrastructure failure, never a task failure: in shadow mode assurance does
 * not gate a merge, so the attempt continues as PROCEED; in gating mode it
 * continues as ESCALATE. Either way the PR states that assurance was unavailable
 * and a human reviews it.
 */
function assuranceUnavailable(step: Step, failureClass: FailureClass): void {
  const s = step.s;
  const a = current(s);
  const mode = s.input.governance.assuranceMode;
  audit(step, 'assurance-unavailable', { attemptNumber: a.attemptNumber, failureClass, assuranceMode: mode });
  s.publication = {
    attemptNumber: a.attemptNumber,
    flagged: mode === 'gating',
    prBodySectionRef: null,
    terminal: mode === 'gating' ? 'escalated' : 'proceeded',
  };
  publicationGate(step);
}

function route(step: Step, raw: unknown): void {
  const s = step.s;
  const a = current(s);
  const parsed = parseAssuranceOutcome(raw, { round: roundOf(a), resultSha: a.resultSha ?? '' });
  if (!parsed.ok) {
    audit(step, 'review-slot.contract-violation', { attemptNumber: a.attemptNumber, error: parsed.error });
    close(step, 'FAILED', 'review-slot.contract-violation');
    return;
  }
  const outcome = parsed.outcome;
  a.adjudicationId = outcome.adjudicationId;
  switch (outcome.kind) {
    case 'PROCEED':
    case 'ESCALATE':
      s.publication = {
        attemptNumber: a.attemptNumber,
        flagged: outcome.kind === 'ESCALATE',
        prBodySectionRef: outcome.prBodySectionRef,
        terminal: outcome.kind === 'ESCALATE' ? 'escalated' : 'proceeded',
      };
      publicationGate(step);
      return;
    case 'REPAIR':
      endAttempt(step, a, 'repair-requested');
      // The repair attempt needs the writer lease; the parent's worktree stays until the repair worktree exists.
      releaseLease(step, a);
      s.currentAttempt = null;
      s.nextAttempt = {
        kind: 'repair',
        lineage: {
          repairBaseSha: outcome.repairBaseSha,
          repairOrderRef: outcome.repairOrderRef,
          round: outcome.nextRound,
          priorAdjudicationId: outcome.adjudicationId,
          parentAttemptNumber: a.attemptNumber,
        },
        replacesTimedOut: false,
      };
      budgetCheck(step);
      return;
    case 'BLOCK':
      endAttempt(step, a, 'blocked');
      close(step, 'BLOCKED', outcome.reason);
      return;
  }
}

function publicationGate(step: Step): void {
  const s = step.s;
  const plan = publication(s);
  s.phase = 'PUBLICATION_GATE';
  if (s.input.governance.publicationApprovalRequired) {
    openApproval(step, 'publish-change', plan.attemptNumber, null);
    return;
  }
  issue(step, { kind: 'publishBranch', attemptNumber: plan.attemptNumber });
}

function handoff(step: Step): void {
  const s = step.s;
  const plan = publication(s);
  if (s.cancelPending) {
    close(step, 'CANCELLED', 'cancelled');
    return;
  }
  s.phase = 'REVIEW_HANDOFF';
  endAttempt(step, attempt(s, plan.attemptNumber), plan.terminal);
  close(step, 'WAITING_FOR_HUMAN_REVIEW', plan.terminal === 'escalated' ? 'assurance-escalated' : 'review-handoff');
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

function openApproval(step: Step, kind: ApprovalKind, attemptNumber: number | null, shortfallUsd: number | null): void {
  const s = step.s;
  s.gateSeq += 1;
  const id = approvalRequestId(s.workflowId, s.gateSeq);
  s.approval = { approvalRequestId: id, kind, attemptNumber, opened: false, pendingDecisionId: null, expiryFired: false };
  issue(step, {
    kind: 'openApprovalRequest',
    approvalRequestId: id,
    approvalKind: kind,
    attemptNumber,
    ttlSeconds: s.input.governance.approvalTtlSeconds,
    shortfallUsd,
  });
}

function approvalOpened(step: Step): void {
  const s = step.s;
  const ap = s.approval;
  if (ap === null) throw new Error('approval opened without an approval');
  ap.opened = true;
  if (s.cancelPending) {
    close(step, 'CANCELLED', 'cancelled');
    return;
  }
  s.phase = 'AWAITING_APPROVAL';
  startTimer(step, approvalTimerId(ap.approvalRequestId), s.input.governance.approvalTtlSeconds);
  project(step, 'WAITING_FOR_APPROVAL');
  emit(step, 'approval.requested', ap.attemptNumber, { approvalKind: ap.kind });
  applyPauseIfIdle(step);
}

function approvalVerified(step: Step, result: Extract<TaskResult, { kind: 'verifyApprovalDecision' }>): void {
  const s = step.s;
  const ap = s.approval;
  if (ap === null) throw new Error('approval verified without an approval');
  const decisionId = ap.pendingDecisionId ?? '';
  ap.pendingDecisionId = null;
  if (ap.expiryFired) {
    expireApproval(step);
    return;
  }
  const verified = result.verified
    && result.decision !== null
    && isWellFormedDecision(ap.kind, result.decision, result.extensionUsd, s.input.policy.maxBudgetExtensionUsd);
  if (!verified || result.decision === null) {
    // PostgreSQL does not confirm the decision: the gate stays closed and keeps waiting.
    audit(step, 'approval.unverified', { approvalRequestId: ap.approvalRequestId, decisionId });
    if (s.cancelPending) close(step, 'CANCELLED', 'cancelled');
    else applyPauseIfIdle(step);
    return;
  }
  cancelTimer(step, approvalTimerId(ap.approvalRequestId));
  s.approval = null;
  if (result.decision === 'reject') {
    rejectApproval(step, ap.kind, 'rejected');
    return;
  }
  if (ap.kind === 'budget-extension') {
    const extensionUsd = result.extensionUsd ?? 0;
    effect(step, { kind: 'recordExtension', approvalRequestId: ap.approvalRequestId, extensionUsd });
    s.grantedExtensionMicroUsd += toMicroUsd(extensionUsd);
    budgetCheck(step);
    return;
  }
  issue(step, { kind: 'publishBranch', attemptNumber: publication(s).attemptNumber });
}

function expireApproval(step: Step): void {
  const s = step.s;
  const ap = s.approval;
  if (ap === null) throw new Error('approval expired without an approval');
  effect(step, { kind: 'expireApprovalRequest', approvalRequestId: ap.approvalRequestId });
  emit(step, 'approval.expired', ap.attemptNumber, { approvalKind: ap.kind });
  s.approval = null;
  rejectApproval(step, ap.kind, 'expired');
}

/** The kind's reject path, also taken on expiry and when the approval activities fail. */
function rejectApproval(step: Step, kind: ApprovalKind, cause: 'rejected' | 'expired' | 'unavailable'): void {
  if (kind === 'budget-extension') close(step, 'BUDGET_EXHAUSTED', `extension-${cause}`);
  else close(step, 'BLOCKED', `publication-${cause}`);
}

function onTimer(step: Step, timerId: string): void {
  const s = step.s;
  const ap = s.approval;
  if (ap !== null && timerId === approvalTimerId(ap.approvalRequestId)) {
    if (ap.pendingDecisionId !== null) {
      ap.expiryFired = true;
      return;
    }
    expireApproval(step);
    return;
  }
  if (timerId === s.pauseTimerId) {
    s.pauseTimerId = null;
    audit(step, 'workflow.pause-timeout', { maxPauseHours: s.input.governance.maxPauseHours });
    close(step, 'BLOCKED', 'pause-timeout', 'cancelled');
  }
}

// ---------------------------------------------------------------------------
// Messages: pause, resume, cancel, approval decisions
// ---------------------------------------------------------------------------

function onMessage(state: TaskState, message: TaskMessage): TaskDecision {
  const known = message.type === 'approvalDecisionReceived'
    ? state.decisionIds.includes(message.decisionId)
    : state.controlRequestIds.includes(message.requestId);
  if (state.outcome !== null) {
    return { ...ignored(state), receipt: known ? DUPLICATE : { accepted: false, duplicate: false, reason: 'closed' } };
  }
  if (known) return { ...ignored(state), receipt: DUPLICATE };

  const step = begin(state);
  const s = step.s;
  switch (message.type) {
    case 'approvalDecisionReceived': {
      const ap = s.approval;
      const receipt = validateApprovalDecision(ap?.opened ? ap : null, s.decisionIds, message, s.input.policy.maxBudgetExtensionUsd);
      if (!receipt.accepted || ap === null) return { ...ignored(state), receipt };
      step.receipt = receipt;
      s.decisionIds.push(message.decisionId);
      ap.pendingDecisionId = message.decisionId;
      issue(step, { kind: 'verifyApprovalDecision', approvalRequestId: ap.approvalRequestId, decisionId: message.decisionId });
      return finish(step);
    }
    case 'pauseRequested': {
      if (s.paused) return { ...ignored(state), receipt: { accepted: false, duplicate: false, reason: 'already-paused' } };
      acceptControl(step, message, 'pause');
      s.paused = true;
      applyPauseIfIdle(step);
      return finish(step);
    }
    case 'resumeRequested': {
      if (!s.paused) return { ...ignored(state), receipt: { accepted: false, duplicate: false, reason: 'not-paused' } };
      acceptControl(step, message, 'resume');
      s.paused = false;
      if (s.pauseTimerId !== null) cancelTimer(step, s.pauseTimerId);
      s.pauseTimerId = null;
      if (s.deferred !== null) {
        const request = s.deferred;
        s.deferred = null;
        issue(step, request);
      } else if (s.projected === 'PAUSED' && s.approval?.opened) {
        // Back to the approval wait the pause interrupted; a decision may be under verification.
        s.phase = 'AWAITING_APPROVAL';
        project(step, 'WAITING_FOR_APPROVAL');
      }
      return finish(step);
    }
    case 'cancelRequested': {
      acceptControl(step, message, 'cancel');
      const pending = s.pending;
      if (pending !== null && !ACTIVITY_OPTIONS[pending.request.kind].cancellable) {
        // A non-cancellable activity (a critical section or a gate write) finishes first.
        s.cancelPending = true;
        return finish(step);
      }
      if (pending !== null) {
        step.abort = true;
        s.pending = null;
      }
      if (pending?.request.kind === 'acquireLease') {
        // The aborted grant may still commit: the lease is settled before the cancelled terminal.
        s.cancelPending = true;
        lookUpLease(step, null, false);
        return finish(step);
      }
      close(step, 'CANCELLED', 'cancelled');
      return finish(step);
    }
  }
}

function acceptControl(
  step: Step,
  message: Extract<TaskMessage, { requestId: string }>,
  control: 'pause' | 'resume' | 'cancel',
): void {
  step.receipt = ACCEPTED;
  step.s.controlRequestIds.push(message.requestId);
  effect(step, { kind: 'recordControl', requestId: message.requestId, control, principalId: message.principalId });
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Close the task. An accepted cancel wins over any other outcome, except an
 * incomplete publication or an attempt whose state is unknown
 * (`overridesCancel`), which must stay visible. Every registered attempt ends
 * with one usage entry and one outcome record, recorded before its lease is
 * released; an attempt not known to exist, or whose state could not be read,
 * gets none.
 */
function close(
  step: Step,
  outcome: TaskOutcome,
  reason: string,
  terminal?: AttemptTerminal,
  overridesCancel = false,
): void {
  const s = step.s;
  if (s.cancelPending && outcome !== 'CANCELLED' && !overridesCancel) {
    outcome = 'CANCELLED';
    reason = 'cancelled';
    terminal = 'cancelled';
  }
  const handedOff = outcome === 'WAITING_FOR_HUMAN_REVIEW';
  const attemptTerminal: AttemptTerminal = terminal ?? (outcome === 'CANCELLED' ? 'cancelled' : 'failed');
  for (const a of s.attempts.filter((x) => x.registered && !x.stateUnknown)) {
    finishAttempt(step, a, attemptTerminal, handedOff ? 'cleanup' : 'quarantine', reason);
  }
  if (outcome === 'CANCELLED' && s.prNumber !== null) {
    // The PR stays open for a human; the harness never deletes remote refs.
    audit(step, 'workflow.cancel.after-publication', { prNumber: s.prNumber });
  }
  for (const timerId of [...s.activeTimers]) cancelTimer(step, timerId);
  if (s.approval?.opened) effect(step, { kind: 'cancelApprovalRequest', approvalRequestId: s.approval.approvalRequestId });
  s.approval = null;
  s.pauseTimerId = null;
  s.deferred = null;
  s.pending = null;
  s.leaseLookup = null;
  s.currentAttempt = null;
  if (!isLegalProjection(s.projected, outcome) && isLegalProjection(s.projected, s.workStatus)) project(step, s.workStatus);
  project(step, outcome);
  emit(step, 'task.completed', null, { outcome });
  s.outcome = outcome;
  s.reason = reason;
  s.phase = 'CLOSED';
  step.out.push({
    type: 'complete',
    summary: {
      outcome,
      reason,
      attempts: s.attempts.filter((a) => a.registered).length,
      chargedCostUsd: fromMicroUsd(s.spentMicroUsd),
      prNumber: s.prNumber,
      unrecordedAttempts: s.attempts
        .filter((a) => a.stateUnknown)
        .map((a) => ({ attemptNumber: a.attemptNumber, idempotencyKey: attemptIdempotencyKey(s, a.attemptNumber) })),
    },
  });
}
