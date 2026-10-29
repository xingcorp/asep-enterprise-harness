// The run workflow's decision core.
//
// A run executes its tasks one at a time, as child task workflows, in the order
// they were submitted. submitTask is deduplicated by task id with a set that is
// carried across continue-as-new, together with the queue and the run's budget
// totals. Each child starts with the run budget that is left, so the snapshot is
// exact without any cross-workflow reservation. Continue-as-new happens only
// between children.

import { crossesSoftThreshold, fromMicroUsd, toMicroUsd } from './budget.js';
import type { ControlReceipt, RunEventDetail, RunEventType, RunId, TaskId, TaskOutcome } from './types.js';

export interface RunBudget {
  readonly maxCostUsd: number;
  readonly softCostUsd: number;
  readonly maxTasks: number;
}

export interface RunCoreInput {
  readonly runId: RunId;
  readonly runBudget: RunBudget;
}

/** Everything a run carries into its continued execution. */
export interface RunCarry {
  readonly queue: readonly TaskId[];
  readonly submitted: readonly TaskId[];
  readonly spentMicroUsd: number;
  readonly finishedTasks: number;
  readonly paused: boolean;
  readonly softThresholdCrossed: boolean;
  readonly controlRequestIds: readonly string[];
  readonly eventSeq: number;
}

export type RunEvent =
  | { readonly type: 'submitTask'; readonly taskId: TaskId; readonly requestId: string }
  | {
      readonly type: 'childCompleted';
      readonly taskId: TaskId;
      readonly outcome: TaskOutcome;
      readonly chargedCostUsd: number;
    }
  | { readonly type: 'pauseRequested'; readonly requestId: string; readonly principalId: string }
  | { readonly type: 'resumeRequested'; readonly requestId: string; readonly principalId: string }
  | { readonly type: 'cancelRequested'; readonly requestId: string; readonly principalId: string }
  | { readonly type: 'continueAsNewSuggested' };

export type RunCommand =
  | { readonly kind: 'startChild'; readonly taskId: TaskId; readonly runRemainingUsd: number }
  | {
      readonly kind: 'signalChild';
      readonly taskId: TaskId;
      readonly signal: 'pause' | 'resume';
      readonly requestId: string;
      readonly principalId: string;
    }
  | { readonly kind: 'cancelChild'; readonly taskId: TaskId }
  | {
      readonly kind: 'recordControl';
      readonly requestId: string;
      readonly control: 'pause' | 'resume' | 'cancel';
      readonly principalId: string;
    }
  | { readonly kind: 'emitRunEvent'; readonly eventSeq: number; readonly eventType: RunEventType; readonly detail: RunEventDetail }
  | { readonly kind: 'continueAsNew'; readonly carry: RunCarry }
  | {
      readonly kind: 'complete';
      readonly outcome: 'COMPLETED' | 'CANCELLED';
      readonly finishedTasks: number;
      readonly chargedCostUsd: number;
    };

export interface RunState {
  readonly input: RunCoreInput;
  readonly workflowId: string;
  readonly queue: readonly TaskId[];
  readonly submitted: readonly TaskId[];
  readonly active: TaskId | null;
  readonly finishedTasks: number;
  readonly spentMicroUsd: number;
  readonly paused: boolean;
  readonly cancelRequested: boolean;
  readonly continueAsNewPending: boolean;
  readonly softThresholdCrossed: boolean;
  readonly controlRequestIds: readonly string[];
  readonly eventSeq: number;
  readonly closed: boolean;
}

export interface RunDecision {
  readonly state: RunState;
  readonly commands: readonly RunCommand[];
  readonly receipt: ControlReceipt | null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Draft extends Omit<Mutable<RunState>, 'queue' | 'submitted' | 'controlRequestIds'> {
  queue: TaskId[];
  submitted: TaskId[];
  controlRequestIds: string[];
}

interface Step {
  readonly s: Draft;
  readonly out: RunCommand[];
  receipt: ControlReceipt | null;
}

const ACCEPTED: ControlReceipt = { accepted: true, duplicate: false, reason: null };
const DUPLICATE: ControlReceipt = { accepted: true, duplicate: true, reason: null };

function rejected(reason: NonNullable<ControlReceipt['reason']>): ControlReceipt {
  return { accepted: false, duplicate: false, reason };
}

export function runWorkflowId(runId: RunId): string {
  return `asep-run-${runId}`;
}

export function startRun(input: RunCoreInput, carry: RunCarry | null): RunDecision {
  const step: Step = {
    s: {
      input,
      workflowId: runWorkflowId(input.runId),
      queue: [...(carry?.queue ?? [])],
      submitted: [...(carry?.submitted ?? [])],
      active: null,
      finishedTasks: carry?.finishedTasks ?? 0,
      spentMicroUsd: carry?.spentMicroUsd ?? 0,
      paused: carry?.paused ?? false,
      cancelRequested: false,
      continueAsNewPending: false,
      softThresholdCrossed: carry?.softThresholdCrossed ?? false,
      controlRequestIds: [...(carry?.controlRequestIds ?? [])],
      eventSeq: carry?.eventSeq ?? 0,
      closed: false,
    },
    out: [],
    receipt: null,
  };
  if (carry === null) emit(step, 'run.started', {});
  advance(step);
  return finish(step);
}

export function decideRun(state: RunState, event: RunEvent): RunDecision {
  if (state.closed) {
    if (event.type === 'childCompleted' || event.type === 'continueAsNewSuggested') return unchanged(state, null);
    const known = event.type === 'submitTask'
      ? state.submitted.includes(event.taskId)
      : state.controlRequestIds.includes(event.requestId);
    return unchanged(state, known ? DUPLICATE : rejected('closed'));
  }
  const step: Step = {
    s: { ...state, queue: [...state.queue], submitted: [...state.submitted], controlRequestIds: [...state.controlRequestIds] },
    out: [],
    receipt: null,
  };
  const s = step.s;
  switch (event.type) {
    case 'submitTask':
      if (s.submitted.includes(event.taskId)) return unchanged(state, DUPLICATE);
      if (s.cancelRequested) return unchanged(state, rejected('closed'));
      if (s.submitted.length >= s.input.runBudget.maxTasks) return unchanged(state, rejected('run-task-limit'));
      step.receipt = ACCEPTED;
      s.submitted.push(event.taskId);
      s.queue.push(event.taskId);
      break;
    case 'childCompleted': {
      if (s.active !== event.taskId) return unchanged(state, null);
      s.active = null;
      s.finishedTasks += 1;
      const before = s.spentMicroUsd;
      s.spentMicroUsd += toMicroUsd(event.chargedCostUsd);
      if (!s.softThresholdCrossed && crossesSoftThreshold(before, s.spentMicroUsd, s.input.runBudget.softCostUsd)) {
        s.softThresholdCrossed = true;
        emit(step, 'budget.threshold_crossed', { thresholdKind: 'soft', budgetScope: 'run' });
      }
      break;
    }
    case 'pauseRequested':
      if (s.controlRequestIds.includes(event.requestId)) return unchanged(state, DUPLICATE);
      if (s.paused) return unchanged(state, rejected('already-paused'));
      acceptControl(step, event.requestId, 'pause', event.principalId);
      s.paused = true;
      if (s.active !== null) {
        step.out.push({ kind: 'signalChild', taskId: s.active, signal: 'pause', requestId: event.requestId, principalId: event.principalId });
      }
      break;
    case 'resumeRequested':
      if (s.controlRequestIds.includes(event.requestId)) return unchanged(state, DUPLICATE);
      if (!s.paused) return unchanged(state, rejected('not-paused'));
      acceptControl(step, event.requestId, 'resume', event.principalId);
      s.paused = false;
      if (s.active !== null) {
        step.out.push({ kind: 'signalChild', taskId: s.active, signal: 'resume', requestId: event.requestId, principalId: event.principalId });
      }
      break;
    case 'cancelRequested':
      if (s.controlRequestIds.includes(event.requestId)) return unchanged(state, DUPLICATE);
      acceptControl(step, event.requestId, 'cancel', event.principalId);
      s.cancelRequested = true;
      s.queue = [];
      if (s.active !== null) step.out.push({ kind: 'cancelChild', taskId: s.active });
      break;
    case 'continueAsNewSuggested':
      s.continueAsNewPending = true;
      break;
  }
  advance(step);
  return finish(step);
}

function unchanged(state: RunState, receipt: ControlReceipt | null): RunDecision {
  return { state, commands: [], receipt };
}

function finish(step: Step): RunDecision {
  return { state: step.s, commands: step.out, receipt: step.receipt };
}

function emit(step: Step, eventType: RunEventType, detail: RunEventDetail): void {
  step.s.eventSeq += 1;
  step.out.push({ kind: 'emitRunEvent', eventSeq: step.s.eventSeq, eventType, detail: { workflowId: step.s.workflowId, ...detail } });
}

function acceptControl(step: Step, requestId: string, control: 'pause' | 'resume' | 'cancel', principalId: string): void {
  step.receipt = ACCEPTED;
  step.s.controlRequestIds.push(requestId);
  step.out.push({ kind: 'recordControl', requestId, control, principalId });
}

/** Start the next child, continue as new, or complete — never while a child is running. */
function advance(step: Step): void {
  const s = step.s;
  if (s.active !== null) return;
  if (s.cancelRequested) {
    complete(step, 'CANCELLED');
    return;
  }
  if (s.finishedTasks >= s.input.runBudget.maxTasks) {
    complete(step, 'COMPLETED');
    return;
  }
  if (s.continueAsNewPending) {
    s.closed = true;
    step.out.push({
      kind: 'continueAsNew',
      carry: {
        queue: [...s.queue],
        submitted: [...s.submitted],
        spentMicroUsd: s.spentMicroUsd,
        finishedTasks: s.finishedTasks,
        paused: s.paused,
        softThresholdCrossed: s.softThresholdCrossed,
        controlRequestIds: [...s.controlRequestIds],
        eventSeq: s.eventSeq,
      },
    });
    return;
  }
  if (s.paused) return;
  const next = s.queue.shift();
  if (next === undefined) return;
  s.active = next;
  const remainingMicro = Math.max(0, toMicroUsd(s.input.runBudget.maxCostUsd) - s.spentMicroUsd);
  step.out.push({ kind: 'startChild', taskId: next, runRemainingUsd: fromMicroUsd(remainingMicro) });
}

function complete(step: Step, outcome: 'COMPLETED' | 'CANCELLED'): void {
  const s = step.s;
  emit(step, 'run.completed', { outcome });
  s.closed = true;
  step.out.push({ kind: 'complete', outcome, finishedTasks: s.finishedTasks, chargedCostUsd: fromMicroUsd(s.spentMicroUsd) });
}
