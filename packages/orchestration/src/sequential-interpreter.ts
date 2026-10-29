// A sequential, in-memory interpreter for the task reducer.
//
// It drives the reducer exactly as the Temporal workflow does: it executes
// effects in order, awaits one request at a time, delivers the messages and
// timer firings that arrive while a request is in flight, and asks the
// environment for the next message or timer when the reducer is idle (paused or
// waiting for an approval). The
// environment supplies activity results; no clock, timer or I/O is involved, so
// a trace is a pure function of the input and the environment's answers.

import { decideTask, startTask } from './task-core.js';
import type {
  ControlReceipt,
  FailureClass,
  TaskCommand,
  TaskCoreInput,
  TaskDecision,
  TaskEvent,
  TaskMessage,
  TaskRequest,
  TaskResult,
  TaskState,
  TaskSummary,
} from './types.js';

export type ActivityFailure = {
  readonly kind: 'activityFailed';
  readonly failureClass: FailureClass;
  /** True when the engine gave up because heartbeats stopped (worker death). */
  readonly timedOut: boolean;
  /** True for a non-retryable error; absent or false means retries or time ran out. */
  readonly nonRetryable?: boolean;
};

export type Answer = TaskResult | ActivityFailure;

export interface TaskEnvironment {
  /** The outcome of one request: its result, or the failure the engine reports after its retries. */
  respond(request: TaskRequest): Answer;
  /** Messages and firings of running timers that arrive while the request is in flight, in order. */
  eventsDuring(request: TaskRequest, activeTimers: readonly string[]): readonly (TaskMessage | TimerFired)[];
  /** The next message or timer firing while the reducer awaits no request. */
  whenIdle(state: TaskState, activeTimers: readonly string[]): TaskEvent;
}

export interface DeliveredMessage {
  readonly message: TaskMessage;
  readonly receipt: ControlReceipt;
}

export interface TaskTrace {
  /** Every command in the order the reducer issued it, starting with startTask's. */
  readonly commands: readonly TaskCommand[];
  /** Every event fed to the reducer after startTask, in order. */
  readonly events: readonly TaskEvent[];
  readonly receipts: readonly ControlReceipt[];
  readonly messages: readonly DeliveredMessage[];
  /** How many times the reducer asked to abort the request in flight. */
  readonly aborts: number;
  readonly summary: TaskSummary;
  readonly state: TaskState;
}

type TimerFired = Extract<TaskEvent, { type: 'timerFired' }>;

function isMessage(event: TaskEvent): event is TaskMessage {
  return event.type !== 'result' && event.type !== 'activityFailed' && event.type !== 'timerFired';
}

export function runTaskSequentially(input: TaskCoreInput, env: TaskEnvironment, maxSteps = 5000): TaskTrace {
  const commands: TaskCommand[] = [];
  const events: TaskEvent[] = [];
  const receipts: ControlReceipt[] = [];
  const messages: DeliveredMessage[] = [];
  const timers = new Set<string>();
  let aborts = 0;
  let summary: TaskSummary | null = null;
  let state: TaskState;

  const absorb = (decision: TaskDecision): void => {
    for (const command of decision.commands) {
      if (summary !== null) throw new Error('command issued after completion');
      commands.push(command);
      if (command.type === 'effect' && command.effect.kind === 'startTimer') timers.add(command.effect.timerId);
      if (command.type === 'effect' && command.effect.kind === 'cancelTimer') timers.delete(command.effect.timerId);
      if (command.type === 'complete') summary = command.summary;
    }
    state = decision.state;
  };

  const feed = (event: TaskEvent): void => {
    events.push(event);
    if (event.type === 'timerFired') timers.delete(event.timerId);
    const decision = decideTask(state, event);
    if (decision.abortInFlight) aborts += 1;
    if (isMessage(event)) {
      if (decision.receipt === null) throw new Error(`no receipt for message ${event.type}`);
      receipts.push(decision.receipt);
      messages.push({ message: event, receipt: decision.receipt });
    }
    absorb(decision);
  };

  absorb(startTask(input));
  for (let step = 0; summary === null; step += 1) {
    if (step >= maxSteps) throw new Error(`task did not complete within ${maxSteps} steps`);
    const pending: { readonly seq: number; readonly request: TaskRequest } | null = state!.pending;
    if (pending === null) {
      feed(env.whenIdle(state!, [...timers]));
      continue;
    }
    for (const event of env.eventsDuring(pending.request, [...timers])) {
      if (event.type === 'timerFired' && !timers.has(event.timerId)) throw new Error(`timer ${event.timerId} is not running`);
      feed(event);
    }
    if (summary !== null || state!.pending?.seq !== pending.seq) continue;
    const answer = env.respond(pending.request);
    feed(answer.kind === 'activityFailed'
      ? {
          type: 'activityFailed',
          seq: pending.seq,
          activity: pending.request.kind,
          failureClass: answer.failureClass,
          timedOut: answer.timedOut,
          nonRetryable: answer.nonRetryable ?? false,
        }
      : { type: 'result', seq: pending.seq, result: answer });
  }
  return { commands, events, receipts, messages, aborts, summary, state: state! };
}
