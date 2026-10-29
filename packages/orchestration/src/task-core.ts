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
// round, the publication gate, push and PR, review handoff. Abandoned attempts
// are replaced only while nothing has been pushed; a failed verification ends
// the task; REPAIR starts a repair attempt at the outcome's base.

import { ACTIVITY_OPTIONS } from './activity-options.js';
import { approvalRequestId, isWellFormedDecision, validateApprovalDecision } from './approvals.js';
import { parseAssuranceOutcome } from './assurance.js';
import { checkReservation, crossesSoftThreshold, fromMicroUsd, toMicroUsd } from './budget.js';
import { isLegalProjection, isWorkStatus, statusForRequest } from './projection.js';
import type {
  ApprovalKind,
  AttemptState,
  AttemptTerminal,
  ControlReceipt,
  FailureClass,
  OpenApproval,
  ProjectedTaskStatus,
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
  acquireLease: 'ATTEMPT_STARTING',
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
    publication: null,
    spentMicroUsd: 0,
    spentWallClockMinutes: 0,
    grantedExtensionMicroUsd: 0,
    softThresholdCrossed: false,
    overrun: false,
    pushRequested: false,
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
        onActivityFailed(step, request, event.failureClass, event.timedOut);
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

/**
 * Issue the next request, unless a pending cancel or a pause intervenes. The
 * second halves of the commit/evidence and push/PR sections are never withheld:
 * once a critical section starts, it finishes.
 */
function issue(step: Step, request: TaskRequest): void {
  const s = step.s;
  const continuesSection = request.kind === 'persistEvidence' || request.kind === 'upsertPullRequest';
  if (s.cancelPending && !continuesSection) {
    close(step, 'CANCELLED', 'cancelled');
    return;
  }
  if (s.paused && !continuesSection && request.kind !== 'verifyApprovalDecision') {
    defer(step, request);
    return;
  }
  const target = statusForRequest(request.kind, s.workStatus) ?? (s.projected === 'PAUSED' ? s.workStatus : null);
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
        baseSha: plan.baseSha,
        round: plan.round,
        priorAdjudicationId: plan.priorAdjudicationId,
        parentAttemptNumber: plan.parentAttemptNumber,
        repairOrderRef: plan.repairOrderRef,
        attemptId: null,
        leaseRequested: false,
        leaseReleased: false,
        workspaceRequested: false,
        workspaceActive: false,
        workspaceDisposed: false,
        agentStarted: false,
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
    case 'publishBranch':
      s.pushRequested = true;
      return;
    default:
      return;
  }
}

/** Withhold the request at a phase boundary: project the phase's status, then PAUSED, and start the pause timer. */
function defer(step: Step, request: TaskRequest): void {
  const s = step.s;
  project(step, statusForRequest(request.kind, s.workStatus) ?? s.workStatus);
  project(step, 'PAUSED');
  s.deferred = request;
  s.phase = 'PAUSED';
  s.pauseCount += 1;
  s.pauseTimerId = `pause:${s.pauseCount}`;
  startTimer(step, s.pauseTimerId, s.input.governance.maxPauseHours * 3600);
}

// ---------------------------------------------------------------------------
// Attempt bookkeeping
// ---------------------------------------------------------------------------

function chargeUsage(step: Step, a: MutableAttempt, reportedCostUsd: number | null, wallClockMs: number | null): void {
  const s = step.s;
  const budget = s.input.attemptBudget;
  const reported = reportedCostUsd !== null && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0 ? reportedCostUsd : null;
  const reservedMicro = toMicroUsd(budget.maxCostUsd);
  // An agent that never reported (it died, timed out or was cancelled) is charged its full reservation.
  const chargedMicro = !a.agentStarted ? 0 : reported !== null ? toMicroUsd(reported) : reservedMicro;
  const minutes = !a.agentStarted
    ? 0
    : wallClockMs !== null && Number.isFinite(wallClockMs) && wallClockMs >= 0
      ? Math.ceil(wallClockMs / 60_000)
      : budget.maxWallClockMinutes;
  const before = s.spentMicroUsd;
  s.spentMicroUsd += chargedMicro;
  s.spentWallClockMinutes += minutes;
  a.usageRecorded = true;
  effect(step, {
    kind: 'recordUsage',
    attemptNumber: a.attemptNumber,
    chargedCostUsd: fromMicroUsd(chargedMicro),
    reportedCostUsd: reported,
    chargedWallClockMinutes: minutes,
  });
  if (reported !== null && toMicroUsd(reported) > reservedMicro) {
    effect(step, { kind: 'recordOverrun', attemptNumber: a.attemptNumber, overrunUsd: fromMicroUsd(toMicroUsd(reported) - reservedMicro) });
    s.overrun = true;
  }
  if (!s.softThresholdCrossed && crossesSoftThreshold(before, s.spentMicroUsd, s.input.taskBudget.softCostUsd)) {
    s.softThresholdCrossed = true;
    emit(step, 'budget.threshold_crossed', a.attemptNumber, { thresholdKind: 'soft', budgetScope: 'task' });
    audit(step, 'budget.threshold_crossed', { thresholdKind: 'soft', budgetScope: 'task', spentUsd: fromMicroUsd(s.spentMicroUsd) });
  }
}

function recordOutcome(step: Step, a: MutableAttempt, terminal: AttemptTerminal): void {
  if (a.outcomeRecorded) return;
  a.outcomeRecorded = true;
  effect(step, {
    kind: 'recordAttemptOutcome',
    attemptNumber: a.attemptNumber,
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

function releaseLease(step: Step, a: MutableAttempt): void {
  if (!a.leaseRequested || a.leaseReleased) return;
  a.leaseReleased = true;
  effect(step, { kind: 'releaseLease', attemptNumber: a.attemptNumber });
}

/** Release an attempt's resources. A failed or interrupted attempt is reaped and quarantined. */
function releaseAttempt(step: Step, a: MutableAttempt, disposal: 'cleanup' | 'quarantine', reason: string): void {
  if (disposal === 'quarantine' && a.agentStarted && !a.reaped) {
    a.reaped = true;
    effect(step, { kind: 'reapContainers', attemptNumber: a.attemptNumber });
  }
  disposeWorkspace(step, a, disposal, reason);
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
      s.nextAttempt = {
        kind: 'initial',
        baseSha: s.input.baseSha,
        round: 1,
        priorAdjudicationId: null,
        parentAttemptNumber: null,
        repairOrderRef: null,
        replacesTimedOut: false,
      };
      budgetCheck(step);
      return;
    case 'ensureAttempt': {
      const a = current(s);
      a.attemptId = result.attemptId;
      emit(step, 'attempt.started', a.attemptNumber);
      if (a.kind === 'repair') emit(step, 'repair.started', a.attemptNumber, { repairRound: a.round });
      issue(step, { kind: 'acquireLease', attemptNumber: a.attemptNumber });
      return;
    }
    case 'acquireLease': {
      const a = current(s);
      issue(step, { kind: 'prepareWorkspace', attemptNumber: a.attemptNumber, baseSha: a.baseSha });
      return;
    }
    case 'prepareWorkspace': {
      const a = current(s);
      a.workspaceActive = true;
      // The parent's harness commit is the repair base. Its worktree keeps that
      // commit reachable, so it is disposed only once the repair worktree exists.
      if (a.parentAttemptNumber !== null) disposeWorkspace(step, attempt(s, a.parentAttemptNumber), 'cleanup', 'repaired');
      issue(step, { kind: 'storeAttemptInputs', attemptNumber: a.attemptNumber, repairOrderRef: a.repairOrderRef });
      return;
    }
    case 'storeAttemptInputs': {
      const a = current(s);
      issue(step, { kind: 'runAgent', attemptNumber: a.attemptNumber, budget: s.input.attemptBudget });
      return;
    }
    case 'runAgent': {
      const a = current(s);
      chargeUsage(step, a, result.reportedCostUsd, result.wallClockMs);
      if (result.status !== 'AGENT_DONE') {
        abandon(step, result.failureClass, false, result.failureClass ?? `agent-${result.status.toLowerCase()}`);
        return;
      }
      a.declaredComplete = true;
      issue(step, { kind: 'inspectWorkspace', attemptNumber: a.attemptNumber });
      return;
    }
    case 'inspectWorkspace': {
      const a = current(s);
      if (result.overstep) {
        abandon(step, 'policy-violation', false, 'policy-violation');
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
      issue(step, { kind: 'commitAttempt', attemptNumber: a.attemptNumber, expectedHeadSha: a.baseSha });
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
          round: a.round,
          evidenceId: result.evidenceId,
          taskBaseSha: s.input.baseSha,
          declaredComplete: a.declaredComplete,
          priorAdjudicationId: a.priorAdjudicationId,
          idempotencyKey: `${s.workflowId}:assurance:${a.attemptNumber}:${a.round}`,
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
    case 'publishBranch': {
      const plan = publication(s);
      issue(step, {
        kind: 'upsertPullRequest',
        attemptNumber: plan.attemptNumber,
        flagged: plan.flagged,
        prBodySectionRef: plan.prBodySectionRef,
      });
      return;
    }
    case 'upsertPullRequest':
      s.prNumber = result.prNumber;
      handoff(step);
      return;
  }
}

function onActivityFailed(step: Step, request: TaskRequest, failureClass: FailureClass, timedOut: boolean): void {
  const s = step.s;
  switch (request.kind) {
    case 'admitTask':
      close(step, 'BLOCKED', 'admission-unavailable');
      return;
    case 'ensureAttempt':
      // Numbering must stay contiguous, so an attempt that may not exist is never followed by another.
      close(step, 'FAILED', 'attempt-registration-failed');
      return;
    case 'acquireLease':
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
      close(step, 'FAILED', 'assurance-unavailable');
      return;
    case 'openApprovalRequest':
    case 'verifyApprovalDecision': {
      const ap = s.approval;
      if (ap === null) throw new Error('approval activity failed without an approval');
      rejectApproval(step, ap.kind, 'unavailable');
      return;
    }
    case 'publishBranch':
    case 'upsertPullRequest':
      close(step, 'FAILED', 'publication-failed');
      return;
  }
}

function publication(s: Draft) {
  if (s.publication === null) throw new Error('no publication plan');
  return s.publication;
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
      baseSha: plan.baseSha,
      parentAttemptNumber: plan.parentAttemptNumber,
      repairOrderRef: plan.repairOrderRef,
    });
    return;
  }
  if (reservation.reason === 'task-budget') {
    openApproval(step, 'budget-extension', null, reservation.shortfallUsd);
    return;
  }
  if (plan.kind === 'repair') {
    close(step, 'FAILED', 'repair-capacity-exhausted');
    return;
  }
  if (reservation.reason === 'attempts-exhausted') {
    close(step, 'FAILED', 'attempts-exhausted');
    return;
  }
  close(step, 'BUDGET_EXHAUSTED', reservation.reason);
}

/** Abandon the current attempt; replace it only if the class allows, nothing was pushed and attempts remain. */
function abandon(step: Step, failureClass: FailureClass | null, timedOut: boolean, reason: string): void {
  const s = step.s;
  const a = current(s);
  s.phase = 'ATTEMPT_ABANDONED';
  releaseAttempt(step, a, 'quarantine', reason);
  if (!a.usageRecorded) chargeUsage(step, a, null, null);
  recordOutcome(step, a, 'failed');
  s.currentAttempt = null;
  const replaceable = failureClass !== null && s.input.policy.replaceableFailureClasses.includes(failureClass);
  if (!replaceable) {
    close(step, 'FAILED', reason);
    return;
  }
  if (s.pushRequested) {
    close(step, 'FAILED', 'failed-after-push');
    return;
  }
  if (a.attemptNumber >= s.input.taskBudget.maxAttempts) {
    close(step, 'FAILED', 'attempts-exhausted');
    return;
  }
  s.nextAttempt = {
    kind: 'retry',
    baseSha: a.baseSha,
    round: a.round,
    priorAdjudicationId: a.priorAdjudicationId,
    parentAttemptNumber: a.parentAttemptNumber,
    repairOrderRef: a.repairOrderRef,
    replacesTimedOut: timedOut,
  };
  budgetCheck(step);
}

/** A failed or errored mandatory verification ends the task: no assurance round, no approval, no push. */
function verificationStop(step: Step, verdict: VerificationVerdict): void {
  const a = current(step.s);
  a.verdict = verdict;
  recordOutcome(step, a, 'verification-failed');
  close(step, 'FAILED', 'verification-failed');
}

function route(step: Step, raw: unknown): void {
  const s = step.s;
  const a = current(s);
  const parsed = parseAssuranceOutcome(raw, { round: a.round, resultSha: a.resultSha ?? '' });
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
      recordOutcome(step, a, 'repair-requested');
      // The repair attempt needs the writer lease; the parent's worktree stays until the repair worktree exists.
      releaseLease(step, a);
      s.currentAttempt = null;
      s.nextAttempt = {
        kind: 'repair',
        baseSha: outcome.repairBaseSha,
        round: outcome.nextRound,
        priorAdjudicationId: outcome.adjudicationId,
        parentAttemptNumber: a.attemptNumber,
        repairOrderRef: outcome.repairOrderRef,
        replacesTimedOut: false,
      };
      budgetCheck(step);
      return;
    case 'BLOCK':
      recordOutcome(step, a, 'blocked');
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
  recordOutcome(step, attempt(s, plan.attemptNumber), plan.terminal);
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
 * Close the task. An accepted cancel wins over any other outcome. Every attempt
 * ends with its resources released, one usage entry and one outcome record.
 */
function close(step: Step, outcome: TaskOutcome, reason: string, terminal?: AttemptTerminal): void {
  const s = step.s;
  if (s.cancelPending && outcome !== 'CANCELLED') {
    outcome = 'CANCELLED';
    reason = 'cancelled';
    terminal = 'cancelled';
  }
  const handedOff = outcome === 'WAITING_FOR_HUMAN_REVIEW';
  const attemptTerminal: AttemptTerminal = terminal ?? (outcome === 'CANCELLED' ? 'cancelled' : 'failed');
  for (const a of s.attempts) {
    releaseAttempt(step, a, handedOff ? 'cleanup' : 'quarantine', reason);
    if (!a.usageRecorded) chargeUsage(step, a, null, null);
    recordOutcome(step, a, attemptTerminal);
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
      attempts: s.attempts.length,
      chargedCostUsd: fromMicroUsd(s.spentMicroUsd),
      prNumber: s.prNumber,
    },
  });
}
