// Property tests for the decision core.
//
// A seeded generator drives the task reducer through the sequential interpreter
// with random budgets and policy, activity results, activity failures, worker
// deaths, cap stops and overruns, assurance outcomes (valid, out of contract and
// unavailable), approvals and their verification (confirmed or not), pauses,
// resumes, cancels, and timer firings both while idle and while a request is in
// flight. Every generated trace must satisfy the safety invariants the
// durable workflow relies on. Seeds are fixed, so a failure is reproducible: the
// assertion message names the seed.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskId, RunId } from '@asep/contracts';
import { isLegalProjection } from './projection.js';
import { decideRun, startRun } from './run-core.js';
import type { RunCommand, RunCoreInput, RunEvent } from './run-core.js';
import { runTaskSequentially } from './sequential-interpreter.js';
import type { Answer, TaskEnvironment, TaskTrace } from './sequential-interpreter.js';
import { decideTask, startTask } from './task-core.js';
import { TASK_BASE, attemptOf, branchFor, effectsOf, happyAnswer, proceed, ref, requests, shaFor } from './test-support/fixtures.js';
import { MAX_USD } from './budget.js';
import { DEFAULT_ORCHESTRATION_POLICY, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import type {
  FailureClass,
  ProjectedTaskStatus,
  TaskCommand,
  TaskCoreInput,
  TaskDecision,
  TaskEvent,
  TaskMessage,
  TaskRequest,
  TaskState,
} from './types.js';

console.log('SUITE-ID: asep-suite:orchestration-properties');

const SEEDS = 600;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  chance(p: number): boolean;
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
}

function rngFor(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    chance: (p) => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

const CLASSES: readonly FailureClass[] = [
  'environment', 'provider', 'tool', 'agent-loop-stall', 'workflow-recovery-failure',
  'policy-violation', 'false-completion', 'context', 'duplicate-side-effect',
];

// Money in the oracle is counted in micro-dollars independently of the implementation's conversion: every amount
// the generator produces, and every amount the core records, is exact in micro-dollars, so rounding the scaled
// number is exact here.
function micro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** A random amount in whole cents between lo and hi dollars, so caps are fractional. */
function cents(rng: Rng, lo: number, hi: number): number {
  return rng.int(lo * 100, hi * 100) / 100;
}

// The bound choices draw from their own stream (`side`), so adding them left every other draw of a seed unchanged.
function randomInput(rng: Rng, side: Rng): TaskCoreInput {
  // Sometimes every money cap sits at or next to the input bound, with no verification reserve, so the reservation
  // still fits and usage around the bound reaches the overrun check.
  const nearBound = side.chance(0.12);
  const attemptCost = nearBound ? side.pick([MAX_USD, MAX_USD - 0.000001]) : cents(rng, 1, 6);
  const taskCap = nearBound ? MAX_USD : cents(rng, 2, 20);
  return {
    taskId: 'task-p' as TaskId,
    runId: 'run-p' as RunId,
    risk: 'R0',
    baseSha: TASK_BASE,
    attemptBudget: { maxTurns: 10, maxToolCalls: 50, maxCostUsd: attemptCost, maxWallClockMinutes: rng.int(10, 60) },
    taskBudget: {
      maxAttempts: rng.int(1, 4),
      maxCostUsd: taskCap,
      softCostUsd: nearBound ? MAX_USD : cents(rng, 1, taskCap),
      maxWallClockMinutes: rng.int(30, 240),
    },
    verificationReserve: { costUsd: nearBound ? 0 : cents(rng, 0, 2), wallClockMinutes: rng.int(0, 20) },
    runRemainingUsd: nearBound ? MAX_USD : cents(rng, 1, 40),
    governance: {
      publicationApprovalRequired: rng.chance(0.3),
      approvalTtlSeconds: 600,
      maxPauseHours: 1,
      assuranceMode: rng.pick(['shadow', 'gating'] as const),
    },
    policy: {
      ...DEFAULT_ORCHESTRATION_POLICY,
      // Sometimes a hostile policy that lists a never-replaceable class; the core must ignore it.
      replaceableFailureClasses: rng.chance(0.25)
        ? [...DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses, rng.pick(NEVER_REPLACEABLE_FAILURE_CLASSES)]
        : DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses,
      maxBudgetExtensionUsd: rng.chance(0.7) ? 10 : null,
      agentKillGraceSeconds: rng.pick([0, 30]),
    },
  };
}

function failure(rng: Rng): Answer {
  return { kind: 'activityFailed', failureClass: rng.pick(CLASSES), timedOut: rng.chance(0.4) };
}

/** A publication failure: it reports the push or PR as applied, absent or unknown, or reports nothing (unknown). */
function publicationFailure(rng: Rng): Answer {
  const effect = rng.pick(['applied', 'none', 'unknown', null] as const);
  return { kind: 'activityFailed', failureClass: rng.pick(CLASSES), timedOut: rng.chance(0.3), ...(effect === null ? {} : { effect }) };
}

function randomEnvironment(rng: Rng, side: Rng, input: TaskCoreInput): TaskEnvironment {
  const sentDecisions = new Map<string, Extract<TaskMessage, { type: 'approvalDecisionReceived' }>>();
  let controlCounter = 0;
  const controlId = () => (rng.chance(0.3) && controlCounter > 0 ? `ctl-${rng.int(1, controlCounter)}` : `ctl-${++controlCounter}`);
  let decisionCounter = 0;

  const decision = (approvalRequestId: string): TaskMessage => {
    const approve = rng.chance(0.65);
    const message: Extract<TaskMessage, { type: 'approvalDecisionReceived' }> = {
      type: 'approvalDecisionReceived',
      decisionId: rng.chance(0.2) && decisionCounter > 0 ? `dec-${rng.int(1, decisionCounter)}` : `dec-${++decisionCounter}`,
      approvalRequestId: rng.chance(0.1) ? `${approvalRequestId}-stale` : approvalRequestId,
      decision: approve ? 'approve' : 'reject',
      extensionUsd: approve && rng.chance(0.8) ? rng.int(0, 12) : null,
      principalId: 'human-p',
    };
    if (!sentDecisions.has(message.decisionId)) sentDecisions.set(message.decisionId, message);
    return message;
  };

  const control = (): TaskMessage => {
    const kind = rng.pick(['pauseRequested', 'resumeRequested', 'cancelRequested'] as const);
    return { type: kind, requestId: controlId(), principalId: 'op-p' };
  };

  return {
    respond(request: TaskRequest): Answer {
      const n = attemptOf(request) ?? 0;
      switch (request.kind) {
        case 'admitTask':
          if (rng.chance(0.05)) return failure(rng);
          return rng.chance(0.06)
            ? { kind: 'admitTask', admitted: false, reason: 'risk-deferred' }
            : happyAnswer(request);
        case 'runAgent': {
          if (rng.chance(0.15)) return failure(rng);
          const cap = input.attemptBudget;
          // Mostly within the caps, sometimes exactly at them, sometimes above (an overrun), including by less than
          // a micro-dollar.
          const c = rng.next();
          const cost = c < 0.08 ? Math.round(cap.maxCostUsd * (100 + rng.int(1, 60))) / 100
            : c < 0.12 ? cap.maxCostUsd + rng.pick([0.0000004, 0.000001, 1e-9])
              : c < 0.2 ? cap.maxCostUsd : Math.round(rng.next() * cap.maxCostUsd * 100) / 100;
          const toolCalls = rng.chance(0.05) ? cap.maxToolCalls + rng.int(1, 5) : rng.int(0, cap.maxToolCalls);
          // Now and then a report that is no valid amount at all.
          const invalid = (v: number) => (side.chance(0.02) ? side.pick([Number.NaN, -1, Number.POSITIVE_INFINITY]) : v);
          // Measured wall-clock: mostly within the cap, sometimes exactly at the cap or at the cap plus the
          // kill grace, sometimes one millisecond or minutes beyond that (an overrun).
          const capMs = cap.maxWallClockMinutes * 60_000;
          const toleratedMs = capMs + input.policy.agentKillGraceSeconds * 1000;
          const w = rng.next();
          const wallClockMs = w < 0.06 ? capMs : w < 0.12 ? toleratedMs : w < 0.18 ? toleratedMs + 1
            : w < 0.24 ? toleratedMs + rng.int(1, 30) * 60_000 : rng.int(1, capMs);
          if (rng.chance(0.2)) {
            return {
              kind: 'runAgent',
              status: rng.pick(['FAILED', 'BLOCKED', 'BUDGET_EXHAUSTED'] as const),
              reportedCostUsd: invalid(cost),
              reportedToolCalls: invalid(toolCalls),
              wallClockMs: invalid(wallClockMs),
              failureClass: rng.chance(0.9) ? rng.pick(CLASSES) : null,
            };
          }
          return {
            kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: invalid(cost), reportedToolCalls: invalid(toolCalls), wallClockMs: invalid(wallClockMs),
            failureClass: null,
          };
        }
        case 'ensureAttempt':
          return rng.chance(0.08) ? failure(rng) : happyAnswer(request);
        case 'findAttempt': {
          // After a failed registration the row may exist, may not, or the lookup may fail too.
          const r = rng.next();
          if (r < 0.2) return failure(rng);
          return r < 0.6 ? happyAnswer(request) : { kind: 'findAttempt', attemptId: null };
        }
        case 'inspectWorkspace':
          if (rng.chance(0.06)) return failure(rng);
          return { kind: 'inspectWorkspace', overstep: rng.chance(0.05) };
        case 'runVerification': {
          const r = rng.next();
          if (r < 0.1) return failure(rng);
          if (r < 0.2) return { kind: 'runVerification', verdict: rng.pick(['FAIL', 'ERROR'] as const) };
          return happyAnswer(request);
        }
        case 'assuranceRound': {
          const round = request.request.round;
          const r = rng.next();
          if (r < 0.05) return failure(rng);
          if (r < 0.45) return { kind: 'assuranceRound', outcome: proceed(`adj-${n}`) };
          if (r < 0.6) {
            return { kind: 'assuranceRound', outcome: { kind: 'ESCALATE', adjudicationId: `adj-${n}`, reason: 'reviewer-unavailable', prBodySectionRef: ref(`esc-${n}`) } };
          }
          if (r < 0.8) {
            return {
              kind: 'assuranceRound',
              outcome: { kind: 'REPAIR', adjudicationId: `adj-${n}`, repairOrderRef: ref(`ro-${n}`), nextRound: round + 1, repairBaseSha: shaFor(n) },
            };
          }
          if (r < 0.9) return { kind: 'assuranceRound', outcome: { kind: 'BLOCK', adjudicationId: `adj-${n}`, reason: 'secret-in-diff' } };
          return {
            kind: 'assuranceRound',
            outcome: rng.pick([
              { kind: 'APPROVED', adjudicationId: 'x' },
              { kind: 'REPAIR', adjudicationId: 'x', repairOrderRef: ref('r'), nextRound: round + 2, repairBaseSha: shaFor(n) },
              { kind: 'REPAIR', adjudicationId: 'x', repairOrderRef: ref('r'), nextRound: round + 1, repairBaseSha: TASK_BASE },
              null,
            ]),
          };
        }
        case 'publishBranch':
        case 'upsertPullRequest':
          return rng.chance(0.3) ? publicationFailure(rng) : happyAnswer(request);
        case 'reconcilePublication': {
          // The remote holds the attempt's commit, nothing, or something else; the PR is there or not; or the read fails.
          if (rng.chance(0.15)) return failure(rng);
          const head = rng.pick([request.expectedHeadSha, null, 'f'.repeat(40)]);
          return { kind: 'reconcilePublication', branchHeadSha: head, prNumber: head !== null && rng.chance(0.5) ? 11 : null };
        }
        case 'verifyApprovalDecision': {
          const sent = sentDecisions.get(request.decisionId);
          if (rng.chance(0.05)) return failure(rng);
          const r = rng.next();
          if (!sent || r < 0.1) return { kind: 'verifyApprovalDecision', verified: false, decision: null, extensionUsd: null };
          // PostgreSQL may not confirm a decision whose content is valid: the core must not release on content alone.
          return { kind: 'verifyApprovalDecision', verified: r >= 0.3, decision: sent.decision, extensionUsd: sent.extensionUsd };
        }
        default:
          if (rng.chance(0.06)) return failure(rng);
          return happyAnswer(request);
      }
    },
    eventsDuring(request: TaskRequest, timers: readonly string[]) {
      const out: (TaskMessage | Extract<TaskEvent, { type: 'timerFired' }>)[] = [];
      while (rng.chance(0.12)) out.push(rng.chance(0.85) ? control() : decision(`asep-task-task-p:${rng.int(1, 3)}`));
      // A running timer (an approval expiry or a pause timeout) can fire while the request is in flight, before or
      // after the messages.
      if (timers.length > 0 && rng.chance(request.kind === 'verifyApprovalDecision' ? 0.35 : 0.1)) {
        out.splice(rng.int(0, out.length), 0, { type: 'timerFired', timerId: rng.pick(timers) });
      }
      return out;
    },
    whenIdle(state: TaskState, timers: readonly string[]) {
      const r = rng.next();
      if (state.approval?.opened) {
        if (r < 0.6) return decision(state.approval.approvalRequestId);
        if (r < 0.85 && timers.length > 0) return { type: 'timerFired', timerId: rng.pick(timers) };
        return control();
      }
      if (r < 0.55) return { type: 'resumeRequested', requestId: controlId(), principalId: 'op-p' };
      if (r < 0.8 && timers.length > 0) return { type: 'timerFired', timerId: rng.pick(timers) };
      return control();
    },
  };
}

// ---------------------------------------------------------------------------
// Invariant checks over one trace
// ---------------------------------------------------------------------------

const KNOWN_STATUSES = new Set<ProjectedTaskStatus>([
  'PENDING', 'READY', 'EXECUTING', 'VERIFYING', 'WAITING_FOR_HUMAN_REVIEW', 'FAILED', 'BLOCKED', 'CANCELLED',
  'PAUSED', 'WAITING_FOR_APPROVAL', 'BUDGET_EXHAUSTED',
]);

function requestIndex(commands: readonly TaskCommand[], match: (r: TaskRequest) => boolean): number[] {
  const out: number[] = [];
  commands.forEach((c, i) => {
    if (c.type === 'request' && match(c.request)) out.push(i);
  });
  return out;
}

function checkTrace(input: TaskCoreInput, trace: TaskTrace, label: string): void {
  const { commands } = trace;
  const reqs = requests(commands);

  // The trace is closed exactly once, by its last command.
  assert.equal(commands.filter((c) => c.type === 'complete').length, 1, `${label}: one completion`);
  assert.equal(commands.at(-1)?.type, 'complete', `${label}: completion is last`);

  // Request sequence numbers strictly increase.
  const seqs = commands.flatMap((c) => (c.type === 'request' ? [c.seq] : []));
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i]! > seqs[i - 1]!, `${label}: seq order`);

  // One-PR-per-task.
  assert.ok(reqs.filter((r) => r.kind === 'publishBranch').length <= 1, `${label}: at most one push`);
  assert.ok(reqs.filter((r) => r.kind === 'upsertPullRequest').length <= 1, `${label}: at most one PR upsert`);

  const seqRequests = new Map<number, TaskRequest>();
  for (const c of commands) if (c.type === 'request') seqRequests.set(c.seq, c.request);

  // Attempt numbering: contiguous from 1, never above maxAttempts.
  const ensured = reqs.flatMap((r) => (r.kind === 'ensureAttempt' ? [r] : []));
  assert.deepEqual(ensured.map((r) => r.attemptNumber), ensured.map((_r, i) => i + 1), `${label}: contiguous attempts`);
  assert.ok(ensured.length <= input.taskBudget.maxAttempts, `${label}: attempts within maxAttempts`);

  // Reservation: every attempt start fits its agent cap plus the verification reserve within the task
  // cap plus granted extensions, the run remainder and the wall-clock cap, recomputed from the ledger
  // effects issued before it. No attempt starts after a recorded overrun.
  let spent = 0;
  let granted = 0;
  let wallClock = 0;
  let overrun = false;
  for (const c of commands) {
    if (c.type === 'effect' && c.effect.kind === 'recordUsage') {
      spent += micro(c.effect.chargedCostUsd);
      wallClock += c.effect.chargedWallClockMinutes;
    }
    if (c.type === 'effect' && c.effect.kind === 'recordExtension') granted += micro(c.effect.extensionUsd);
    if (c.type === 'effect' && c.effect.kind === 'recordOverrun') overrun = true;
    if (c.type === 'request' && c.request.kind === 'ensureAttempt') {
      const reserve = micro(input.attemptBudget.maxCostUsd) + micro(input.verificationReserve.costUsd);
      const minutes = input.attemptBudget.maxWallClockMinutes + input.verificationReserve.wallClockMinutes;
      assert.ok(spent + reserve <= micro(input.taskBudget.maxCostUsd) + granted, `${label}: task cap reservation`);
      assert.ok(spent + reserve <= micro(input.runRemainingUsd), `${label}: run cap reservation`);
      assert.ok(wallClock + minutes <= input.taskBudget.maxWallClockMinutes, `${label}: wall-clock reservation`);
      assert.ok(!overrun, `${label}: attempt started after a recorded overrun`);
    }
  }

  // Budget-extension approvals exist only while the policy sets an extension bound.
  if (input.policy.maxBudgetExtensionUsd === null) {
    assert.ok(!reqs.some((r) => r.kind === 'openApprovalRequest' && r.approvalKind === 'budget-extension'), `${label}: extension approval without a bound`);
  }

  // Exactly one attempt outcome and one usage entry per registered attempt, and none for an attempt not known to
  // exist: registered means its ensureAttempt returned, or the lookup after a failed one found it.
  const registered = trace.events.flatMap((e) => {
    const request = e.type === 'result' ? seqRequests.get(e.seq) : undefined;
    if (e.type !== 'result' || request === undefined) return [];
    if (e.result.kind === 'ensureAttempt' && request.kind === 'ensureAttempt') return [request.attemptNumber];
    if (e.result.kind === 'findAttempt' && request.kind === 'findAttempt' && e.result.attemptId !== null) return [request.attemptNumber];
    return [];
  }).sort();
  const outcomes = effectsOf(commands, 'recordAttemptOutcome');
  assert.deepEqual(outcomes.map((o) => o.attemptNumber).sort(), registered, `${label}: one outcome per registered attempt`);
  assert.deepEqual(
    effectsOf(commands, 'recordUsage').map((u) => u.attemptNumber).sort(),
    registered,
    `${label}: one usage entry per registered attempt`,
  );
  assert.equal(trace.summary.attempts, registered.length, `${label}: the summary counts registered attempts`);

  // An exhausted attempt is never verified, committed or published; usage includes the verification
  // reserve exactly when verification ran.
  for (const o of outcomes.filter((x) => x.terminal === 'budget-exhausted')) {
    const later = reqs.filter((r) => 'attemptNumber' in r && r.attemptNumber === o.attemptNumber).map((r) => r.kind);
    for (const k of ['runVerification', 'commitAttempt', 'persistEvidence', 'publishBranch', 'upsertPullRequest'] as const) {
      assert.ok(!later.includes(k), `${label}: ${k} for exhausted attempt ${o.attemptNumber}`);
    }
  }
  for (const u of effectsOf(commands, 'recordUsage')) {
    const verified = reqs.some((r) => r.kind === 'runVerification' && r.attemptNumber === u.attemptNumber);
    assert.equal(u.verificationReserveUsd, verified ? input.verificationReserve.costUsd : 0, `${label}: reserve charge ${u.attemptNumber}`);
  }

  // Lineage: a retry copies the lineage of the attempt it replaces, a repair starts one at the previous
  // attempt's commit, and an initial attempt has none. Each assurance round continues its lineage.
  for (const r of ensured) {
    if (r.attemptKind === 'initial') {
      assert.deepEqual([r.baseSha, r.parentAttemptNumber, r.repairOrderRef], [TASK_BASE, null, null], `${label}: initial lineage`);
    } else if (r.attemptKind === 'retry') {
      const prev = ensured[r.attemptNumber - 2]!;
      assert.deepEqual([r.baseSha, r.parentAttemptNumber, r.repairOrderRef], [prev.baseSha, prev.parentAttemptNumber, prev.repairOrderRef],
        `${label}: retry ${r.attemptNumber} keeps the lineage`);
    } else {
      assert.deepEqual([r.baseSha, r.parentAttemptNumber], [shaFor(r.attemptNumber - 1), r.attemptNumber - 1], `${label}: repair lineage`);
    }
  }
  const roundOf = new Map<number, { round: number; prior: string | null }>();
  for (const r of reqs) if (r.kind === 'assuranceRound') roundOf.set(r.request.attemptNumber, { round: r.request.round, prior: r.request.priorAdjudicationId });
  const lineageRound = (n: number): { round: number; prior: string | null } => {
    const r = ensured[n - 1]!;
    if (r.parentAttemptNumber === null) return { round: 1, prior: null };
    const parent = roundOf.get(r.parentAttemptNumber);
    assert.ok(parent, `${label}: parent ${r.parentAttemptNumber} of ${n} had an assurance round`);
    return { round: parent.round + 1, prior: `adj-${r.parentAttemptNumber}` };
  };
  for (const [n, got] of roundOf) assert.deepEqual(got, lineageRound(n), `${label}: assurance round of attempt ${n}`);

  // An agent measured above its wall-clock cap plus the kill grace overran it, and its overrun records the excess
  // over the cap.
  const capMs = input.attemptBudget.maxWallClockMinutes * 60_000;
  const toleratedMs = capMs + input.policy.agentKillGraceSeconds * 1000;
  // An overrun is recorded exactly when the agent's usage exceeded a cap, by any amount, or a usage value was not a
  // valid amount within its bound: the oracle compares the reported numbers with the caps and the bound directly,
  // before any clamping, so no conversion or saturation can hide an overrun. An overrun attempt is never verified or
  // published.
  const valid = (v: number) => Number.isFinite(v) && v >= 0;
  for (const e of trace.events) {
    if (e.type !== 'result' || e.result.kind !== 'runAgent') continue;
    const request = seqRequests.get(e.seq);
    if (request?.kind !== 'runAgent') continue;
    const r = e.result;
    const n = request.attemptNumber;
    const cap = input.attemptBudget;
    const costOutOfBound = !(valid(r.reportedCostUsd) && r.reportedCostUsd <= MAX_USD);
    const outOfBound = costOutOfBound || !valid(r.reportedToolCalls) || !valid(r.wallClockMs);
    const costOver = !costOutOfBound && r.reportedCostUsd > cap.maxCostUsd;
    const wallOver = valid(r.wallClockMs) && r.wallClockMs > toleratedMs;
    const expected = outOfBound || costOver || (valid(r.reportedToolCalls) && Math.ceil(r.reportedToolCalls) > cap.maxToolCalls) || wallOver;
    const recorded = effectsOf(commands, 'recordOverrun').find((o) => o.attemptNumber === n);
    assert.equal(recorded !== undefined, expected, `${label}: overrun recorded for attempt ${n}`);
    if (recorded) {
      assert.equal(recorded.usageOutOfBound, outOfBound, `${label}: out-of-bound usage of attempt ${n}`);
      if (!costOutOfBound) assert.equal(recorded.overrunUsd > 0, costOver, `${label}: cost overrun of attempt ${n}`);
      assert.equal(recorded.overrunWallClockMs, wallOver ? Math.ceil(r.wallClockMs - capMs) : 0, `${label}: wall-clock excess of ${n}`);
    }
    if (expected) {
      for (const k of ['runVerification', 'commitAttempt', 'publishBranch'] as const) {
        assert.ok(!reqs.some((q) => q.kind === k && q.attemptNumber === n), `${label}: ${k} after an overrun of ${n}`);
      }
    }
  }
  // Every number the core hands to an activity is finite, so it survives JSON payloads unchanged.
  for (const c of commands) {
    if (c.type !== 'effect') continue;
    for (const v of Object.values(c.effect)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}: ${c.effect.kind} carries ${v}`);
  }

  // A non-replaceable agent failure ends the task FAILED (or CANCELLED), overrun or not, whatever the policy
  // lists: no further attempt follows it.
  for (const e of trace.events) {
    if (e.type !== 'result' || e.result.kind !== 'runAgent') continue;
    const r = e.result;
    const failed = r.status === 'FAILED' || r.status === 'BLOCKED' || (r.status === 'BUDGET_EXHAUSTED' && r.failureClass !== null);
    const replaceable = r.failureClass !== null && !NEVER_REPLACEABLE_FAILURE_CLASSES.includes(r.failureClass)
      && input.policy.replaceableFailureClasses.includes(r.failureClass);
    if (!failed || replaceable) continue;
    const request = seqRequests.get(e.seq);
    assert.ok(request?.kind === 'runAgent', `${label}: agent result answers runAgent`);
    const n = request.attemptNumber;
    assert.ok(ensured.every((x) => x.attemptNumber <= n), `${label}: attempt after non-replaceable failure of ${n}`);
    assert.ok(['FAILED', 'CANCELLED'].includes(trace.summary.outcome), `${label}: non-replaceable failure of ${n} ends ${trace.summary.outcome}`);
  }

  // An unavailable assurance round never fails the task: it continues as PROCEED (shadow) or ESCALATE
  // (gating), and the PR carries no assurance section.
  assert.notEqual(trace.summary.reason, 'assurance-unavailable', `${label}: FAILED for assurance unavailability`);
  for (const a of effectsOf(commands, 'audit').filter((x) => x.action === 'assurance-unavailable')) {
    const pr = reqs.find((r) => r.kind === 'upsertPullRequest' && r.attemptNumber === a.detail['attemptNumber']);
    if (pr?.kind === 'upsertPullRequest') {
      assert.equal(pr.flagged, input.governance.assuranceMode === 'gating', `${label}: unavailable assurance flag`);
      assert.equal(pr.prBodySectionRef, null, `${label}: unavailable assurance section`);
    }
  }

  // A push follows that attempt's assurance outcome, which was PROCEED or ESCALATE, or an unavailable round.
  const seqToRequest = new Map<number, TaskRequest>();
  for (const c of commands) if (c.type === 'request') seqToRequest.set(c.seq, c.request);
  const assuranceKinds = new Map<number, unknown>();
  for (const e of trace.events) {
    if (e.type !== 'result' || e.result.kind !== 'assuranceRound') continue;
    const request = seqToRequest.get(e.seq);
    if (request?.kind !== 'assuranceRound') continue;
    const raw = e.result.outcome as { kind?: unknown } | null;
    assuranceKinds.set(request.request.attemptNumber, raw && typeof raw === 'object' ? raw.kind : undefined);
  }
  for (const at of requestIndex(commands, (r) => r.kind === 'publishBranch')) {
    const publish = commands[at]!;
    assert.ok(publish.type === 'request' && publish.request.kind === 'publishBranch');
    const n = publish.request.attemptNumber;
    const roundAt = requestIndex(commands, (r) => r.kind === 'assuranceRound' && r.request.attemptNumber === n);
    assert.ok(roundAt.length === 1 && roundAt[0]! < at, `${label}: assurance precedes publish`);
    const unavailable = effectsOf(commands, 'audit').some((a) => a.action === 'assurance-unavailable' && a.detail['attemptNumber'] === n);
    assert.ok(unavailable || ['PROCEED', 'ESCALATE'].includes(String(assuranceKinds.get(n))), `${label}: publish only after PROCEED/ESCALATE`);
    const terminal = outcomes.find((o) => o.attemptNumber === n)?.terminal;
    assert.ok(terminal !== 'repair-requested' && terminal !== 'blocked', `${label}: no publish after REPAIR/BLOCK`);
  }

  // Replacement attempts start only while nothing has been pushed.
  const firstPush = requestIndex(commands, (r) => r.kind === 'publishBranch')[0] ?? Infinity;
  for (const at of requestIndex(commands, (r) => r.kind === 'ensureAttempt' && r.attemptKind !== 'initial')) {
    assert.ok(at < firstPush, `${label}: replacement before any push`);
  }

  // Projections: legal edges from READY, known statuses only (never ACCEPTED or DONE).
  let from: ProjectedTaskStatus = 'READY';
  const projections = effectsOf(commands, 'projectTaskState');
  for (const p of projections) {
    assert.ok(KNOWN_STATUSES.has(p.status), `${label}: known status ${p.status}`);
    assert.ok(isLegalProjection(from, p.status), `${label}: illegal projection ${from} -> ${p.status}`);
    from = p.status;
  }
  assert.deepEqual(projections.map((p) => p.projectionSeq), projections.map((_p, i) => i + 1), `${label}: projection seq`);
  assert.equal(from, trace.summary.outcome, `${label}: final projection is the outcome`);

  // Resources: every lease released once, every workspace cleaned or quarantined once.
  for (const r of reqs) {
    if (r.kind === 'acquireLease') {
      assert.equal(effectsOf(commands, 'releaseLease').filter((e) => e.attemptNumber === r.attemptNumber).length, 1, `${label}: lease ${r.attemptNumber} released once`);
    }
    if (r.kind === 'prepareWorkspace') {
      const disposed = [...effectsOf(commands, 'cleanupWorkspace'), ...effectsOf(commands, 'quarantineWorkspace')]
        .filter((e) => e.attemptNumber === r.attemptNumber);
      assert.equal(disposed.length, 1, `${label}: workspace ${r.attemptNumber} disposed once`);
    }
  }

  // Timers: everything started is cancelled or fired by the end.
  const started = effectsOf(commands, 'startTimer').map((t) => t.timerId);
  const ended = new Set([
    ...effectsOf(commands, 'cancelTimer').map((t) => t.timerId),
    ...trace.events.flatMap((e) => (e.type === 'timerFired' ? [e.timerId] : [])),
  ]);
  for (const id of started) assert.ok(ended.has(id), `${label}: timer ${id} left running`);

  // An accepted cancel ends the task CANCELLED, unless the publication could not reconcile: then it ends
  // FAILED / publication-incomplete, and nothing else.
  const cancelled = trace.messages.some((m) => m.message.type === 'cancelRequested' && m.receipt.accepted && !m.receipt.duplicate);
  if (cancelled && trace.summary.reason !== 'publication-incomplete') {
    assert.equal(trace.summary.outcome, 'CANCELLED', `${label}: accepted cancel ends CANCELLED`);
  }

  // Once a push may have happened, the task never ends without a PR unless it says so: CANCELLED, review handoff and
  // every other outcome after a push request have the PR, or the remote is known to hold nothing (the push failed
  // with effect none, or the reconciliation read after it found no branch), or the task ends
  // FAILED / publication-incomplete with an audit naming the attempt's branch. Retryability plays no part.
  const pushAt = requestIndex(commands, (r) => r.kind === 'publishBranch')[0];
  if (pushAt !== undefined && trace.summary.prNumber === null) {
    const push = commands[pushAt]!;
    assert.ok(push.type === 'request' && push.request.kind === 'publishBranch', `${label}: push request`);
    const upsertAt = requestIndex(commands, (r) => r.kind === 'upsertPullRequest')[0] ?? Infinity;
    const pushReconciliations = commands.flatMap((c, i) =>
      (c.type === 'request' && c.request.kind === 'reconcilePublication' && i < upsertAt ? [c.seq] : []));
    const definite = trace.events.some((e) => (e.type === 'activityFailed' && e.seq === push.seq && e.effect === 'none')
      || (e.type === 'result' && e.result.kind === 'reconcilePublication' && pushReconciliations.includes(e.seq) && e.result.branchHeadSha === null));
    if (!definite) {
      assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['FAILED', 'publication-incomplete'], `${label}: branch left without a PR is reported`);
      const incident = effectsOf(commands, 'audit').find((a) => a.action === 'publication.incomplete');
      assert.equal(incident?.detail['remoteBranch'], branchFor(push.request.attemptNumber), `${label}: the audit names the branch`);
    }
  }

  // A verification stop is final: no assurance, approval or publication afterwards.
  const stop = commands.findIndex((c) => c.type === 'effect' && c.effect.kind === 'recordAttemptOutcome' && c.effect.terminal === 'verification-failed');
  if (stop >= 0) {
    const later = requests(commands.slice(stop)).map((r) => r.kind);
    for (const k of ['assuranceRound', 'openApprovalRequest', 'publishBranch', 'ensureAttempt'] as const) {
      assert.ok(!later.includes(k), `${label}: ${k} after a verification stop`);
    }
    assert.ok(trace.summary.outcome === 'FAILED' || trace.summary.outcome === 'CANCELLED', `${label}: verification stop outcome`);
  }

  // Approval gates: with publication approval required, the push follows a verified decision on the
  // publish-change request that preceded it.
  if (input.governance.publicationApprovalRequired) {
    for (const at of requestIndex(commands, (r) => r.kind === 'publishBranch')) {
      const opened = requestIndex(commands, (r) => r.kind === 'openApprovalRequest' && r.approvalKind === 'publish-change')
        .filter((i) => i < at);
      assert.ok(opened.length > 0, `${label}: push without a publish-change request`);
      const verified = requestIndex(commands, (r) => r.kind === 'verifyApprovalDecision').filter((v) => v > opened.at(-1)! && v < at);
      assert.ok(verified.length > 0, `${label}: push without a verified publish-change decision`);
    }
  }
}

interface ReplayedStep {
  readonly before: TaskState;
  readonly event: TaskEvent;
  readonly decision: TaskDecision;
}

/** The trace replayed one event at a time: the state each event met and the reducer's decision on it. */
function replaySteps(input: TaskCoreInput, trace: TaskTrace): ReplayedStep[] {
  let state = startTask(input).state;
  return trace.events.map((event) => {
    const decision = decideTask(state, event);
    const replayed = { before: state, event, decision };
    state = decision.state;
    return replayed;
  });
}

/** True when the task waits for an opened approval with nothing in flight. */
function waitsForApproval(state: TaskState): boolean {
  return state.outcome === null && state.pending === null && state.approval?.opened === true;
}

// Publication effects, step by step: a push or PR upsert failure whose effect is not known to be none (or a push
// reported applied) is followed at once by a reconciliation read, never by a terminal state.
function checkPublicationEffects(input: TaskCoreInput, trace: TaskTrace, label: string): void {
  for (const { before, event, decision } of replaySteps(input, trace)) {
    if (event.type !== 'activityFailed' || before.pending === null || before.pending.seq !== event.seq || before.outcome !== null) continue;
    const kind = before.pending.request.kind;
    if (kind !== 'publishBranch' && kind !== 'upsertPullRequest') continue;
    const issued = requests(decision.commands).map((r) => r.kind);
    const closed = decision.commands.some((c) => c.type === 'complete');
    const mustReconcile = kind === 'publishBranch' ? event.effect === 'unknown' : event.effect !== 'none';
    if (mustReconcile) {
      assert.deepEqual([issued, closed], [['reconcilePublication'], false], `${label}: ${kind} effect ${event.effect} not reconciled first`);
    } else {
      assert.ok(!issued.includes('reconcilePublication'), `${label}: ${kind} effect ${event.effect} needs no reconciliation`);
    }
  }
}

// Pause checks, step by step: a pause takes effect at once when nothing is in flight, and never suspends an
// approval's expiry.
function checkPauses(input: TaskCoreInput, trace: TaskTrace, label: string): void {
  for (const { before, event, decision } of replaySteps(input, trace)) {
    const after = decision.state;
    // Whenever the task is paused and awaits no request, it shows PAUSED and its pause timer runs.
    if (after.paused && after.pending === null && after.outcome === null) {
      assert.equal(after.projected, 'PAUSED', `${label}: an idle paused task projects ${after.projected}`);
      assert.ok(after.pauseTimerId !== null && after.activeTimers.includes(after.pauseTimerId), `${label}: an idle paused task has no pause timer`);
    }
    // An unpaused task waiting for an approval shows the wait.
    if (!after.paused && waitsForApproval(after)) {
      assert.equal(after.projected, 'WAITING_FOR_APPROVAL', `${label}: an approval wait projects ${after.projected}`);
    }
    if (before.approval !== null && waitsForApproval(before)) {
      const approvalTimer = `approval:${before.approval.approvalRequestId}`;
      const cancelled = decision.commands.some((c) => c.type === 'effect' && c.effect.kind === 'cancelTimer' && c.effect.timerId === approvalTimer);
      // Pausing or resuming leaves the approval's expiry timer running.
      if (event.type === 'pauseRequested' || event.type === 'resumeRequested') {
        assert.ok(!cancelled, `${label}: a ${event.type} stopped the expiry of ${before.approval.approvalRequestId}`);
      }
      // The expiry timer fires while paused exactly as it does otherwise: the request expires.
      if (event.type === 'timerFired' && event.timerId === approvalTimer) {
        assert.ok(effectsOf(decision.commands, 'expireApprovalRequest').length === 1, `${label}: expiry ignored while paused=${before.paused}`);
      }
    }
  }
}

// Approval gates, step by step: a gate is released (an extension recorded, or the publish-change push issued or
// withheld for a pause) only by the result of a verifyApprovalDecision that is verified, says approve, and arrives
// before that request's expiry fired. Such a result releases the gate unless a cancel is pending, and a result that
// arrives after the expiry fired expires the request.
function checkApprovalGates(input: TaskCoreInput, trace: TaskTrace, label: string): void {
  const fired = new Set<string>();
  for (const { before, event, decision } of replaySteps(input, trace)) {
    const after = decision.state;
    const recorded = effectsOf(decision.commands, 'recordExtension').length > 0;
    const pushed = requests(decision.commands).some((r) => r.kind === 'publishBranch') || after.deferred?.kind === 'publishBranch';
    const released = before.approval !== null && (recorded || (before.approval.kind === 'publish-change' && pushed));
    const answersVerification = event.type === 'result' && before.pending !== null && before.pending.seq === event.seq
      && before.pending.request.kind === 'verifyApprovalDecision' && before.approval !== null && before.outcome === null;
    if (!answersVerification || event.type !== 'result' || event.result.kind !== 'verifyApprovalDecision' || before.approval === null) {
      assert.ok(!released, `${label}: gate ${before.approval?.approvalRequestId} released by ${event.type}`);
      if (event.type === 'timerFired') fired.add(event.timerId);
      continue;
    }
    const id = before.approval.approvalRequestId;
    const expired = fired.has(`approval:${id}`);
    const approved = event.result.verified && event.result.decision === 'approve';
    assert.ok(!released || (approved && !expired), `${label}: gate ${id} released by verified=${event.result.verified} decision=${event.result.decision} expired=${expired}`);
    if (approved && !expired && !before.cancelPending) assert.ok(released, `${label}: a confirmed approve left gate ${id} closed`);
    if (expired) {
      assert.deepEqual(effectsOf(decision.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), [id], `${label}: ${id} expired while verifying`);
    }
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function generate(seed: number): { input: TaskCoreInput; trace: TaskTrace } {
  const rng = rngFor(seed);
  const side = rngFor(seed + 1_000_003);
  const input = randomInput(rng, side);
  return { input, trace: runTaskSequentially(input, randomEnvironment(rng, side, input)) };
}

test('generated task traces satisfy the orchestration safety invariants', () => {
  const outcomes = new Map<string, number>();
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const { input, trace } = generate(seed);
    checkTrace(input, trace, `seed ${seed}`);
    checkPauses(input, trace, `seed ${seed}`);
    checkApprovalGates(input, trace, `seed ${seed}`);
    checkPublicationEffects(input, trace, `seed ${seed}`);
    outcomes.set(trace.summary.outcome, (outcomes.get(trace.summary.outcome) ?? 0) + 1);
  }
  // The generator must actually reach every terminal outcome, or the invariants prove little.
  for (const outcome of ['WAITING_FOR_HUMAN_REVIEW', 'FAILED', 'BLOCKED', 'BUDGET_EXHAUSTED', 'CANCELLED']) {
    assert.ok((outcomes.get(outcome) ?? 0) > 0, `no generated trace ended ${outcome}`);
  }
});

test('the generator covers repair, replacement, approvals, pause and cancel paths', () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const { input, trace } = generate(seed);
    const reqs = requests(trace.commands);
    if (reqs.some((r) => r.kind === 'ensureAttempt' && r.attemptKind === 'repair')) seen.add('repair');
    if (reqs.some((r) => r.kind === 'ensureAttempt' && r.attemptKind === 'retry')) seen.add('retry');
    if (reqs.some((r) => r.kind === 'openApprovalRequest' && r.approvalKind === 'budget-extension')) seen.add('budget-approval');
    if (reqs.some((r) => r.kind === 'openApprovalRequest' && r.approvalKind === 'publish-change')) seen.add('publish-approval');
    if (effectsOf(trace.commands, 'recordExtension').length > 0) seen.add('extension-granted');
    if (effectsOf(trace.commands, 'expireApprovalRequest').length > 0) seen.add('approval-expired');
    if (effectsOf(trace.commands, 'projectTaskState').some((p) => p.status === 'PAUSED')) seen.add('paused');
    if (trace.summary.reason === 'pause-timeout') seen.add('pause-timeout');
    if (trace.aborts > 0) seen.add('abort');
    if (effectsOf(trace.commands, 'audit').some((a) => a.action === 'review-slot.contract-violation')) seen.add('violation');
    if (effectsOf(trace.commands, 'recordAttemptOutcome').some((o) => o.terminal === 'verification-failed')) seen.add('verification-stop');
    if (effectsOf(trace.commands, 'emitRunEvent').some((e) => e.eventType === 'workflow.recovered')) seen.add('recovered');
    if (effectsOf(trace.commands, 'recordAttemptOutcome').some((o) => o.terminal === 'budget-exhausted')) seen.add('exhausted');
    if (effectsOf(trace.commands, 'recordOverrun').length > 0) seen.add('overrun');
    if (effectsOf(trace.commands, 'recordOverrun').some((o) => o.overrunWallClockMs > 0)) seen.add('wall-clock-overrun');
    if (effectsOf(trace.commands, 'recordOverrun').some((o) => o.overrunUsd === 0.000001)) seen.add('micro-overrun');
    if (effectsOf(trace.commands, 'recordOverrun').some((o) => o.usageOutOfBound)) seen.add('usage-out-of-bound');
    if (input.attemptBudget.maxCostUsd === MAX_USD && effectsOf(trace.commands, 'recordOverrun').some((o) => o.usageOutOfBound && o.overrunUsd === 0)) {
      seen.add('overrun-at-bound');
    }
    if (trace.summary.reason === 'publication-incomplete') seen.add('publication-incomplete');
    for (const e of trace.events) {
      if (e.type === 'activityFailed' && (e.activity === 'publishBranch' || e.activity === 'upsertPullRequest')) seen.add(`${e.activity}-${e.effect}`);
      if (e.type === 'result' && e.result.kind === 'reconcilePublication') seen.add(e.result.branchHeadSha === null ? 'reconciled-absent' : 'reconciled-present');
      if (e.type === 'activityFailed' && e.activity === 'reconcilePublication') seen.add('reconciliation-failed');
    }
    for (const { before, event, decision } of replaySteps(input, trace)) {
      if (event.type === 'pauseRequested' && waitsForApproval(before) && !before.paused && decision.receipt?.accepted) seen.add('paused-while-waiting');
      if (event.type === 'timerFired' && before.paused && event.timerId.startsWith('approval:')) seen.add('expired-while-paused');
      if (event.type === 'timerFired' && before.pending !== null) {
        seen.add(event.timerId.startsWith('approval:') ? 'expiry-during-verification' : 'pause-timeout-in-flight');
      }
      if (event.type === 'result' && event.result.kind === 'verifyApprovalDecision' && !event.result.verified && event.result.decision === 'approve'
        && before.approval !== null && !before.approval.expiryFired) seen.add('unconfirmed-approve');
    }
    for (const e of trace.events) {
      if (e.type === 'result' && e.result.kind === 'findAttempt') seen.add(e.result.attemptId === null ? 'registration-absent' : 'registration-found');
      if (e.type === 'activityFailed' && e.activity === 'findAttempt') seen.add('registration-unknown');
    }
    const toleratedMs = input.attemptBudget.maxWallClockMinutes * 60_000 + input.policy.agentKillGraceSeconds * 1000;
    if (input.policy.agentKillGraceSeconds > 0 && trace.events.some((e) => e.type === 'result' && e.result.kind === 'runAgent'
      && e.result.status === 'AGENT_DONE' && e.result.wallClockMs === toleratedMs) && reqs.some((r) => r.kind === 'runVerification')) {
      seen.add('verified-within-grace');
    }
    if (effectsOf(trace.commands, 'audit').some((a) => a.action === 'assurance-unavailable')) seen.add('assurance-unavailable');
    if (reqs.some((r) => r.kind === 'ensureAttempt' && r.attemptKind === 'retry' && r.repairOrderRef !== null)) seen.add('lineage-retry');
    const hostile = input.policy.replaceableFailureClasses.filter((c) => NEVER_REPLACEABLE_FAILURE_CLASSES.includes(c));
    if (trace.events.some((e) => (e.type === 'activityFailed' && hostile.includes(e.failureClass))
      || (e.type === 'result' && e.result.kind === 'runAgent' && e.result.failureClass !== null
        && e.result.status !== 'AGENT_DONE' && hostile.includes(e.result.failureClass)))) seen.add('hostile-policy-failure');
  }
  assert.deepEqual([...seen].sort(), [
    'abort', 'approval-expired', 'assurance-unavailable', 'budget-approval', 'exhausted', 'expired-while-paused',
    'expiry-during-verification', 'extension-granted', 'hostile-policy-failure', 'lineage-retry', 'micro-overrun', 'overrun',
    'overrun-at-bound',
    'pause-timeout', 'pause-timeout-in-flight', 'paused', 'paused-while-waiting', 'publication-incomplete',
    'publish-approval', 'publishBranch-applied', 'publishBranch-none', 'publishBranch-unknown', 'reconciled-absent',
    'reconciled-present', 'reconciliation-failed',
    'recovered', 'registration-absent', 'registration-found', 'registration-unknown',
    'repair', 'retry', 'unconfirmed-approve', 'upsertPullRequest-applied', 'upsertPullRequest-none',
    'upsertPullRequest-unknown', 'usage-out-of-bound', 'verification-stop', 'verified-within-grace', 'violation',
    'wall-clock-overrun',
  ]);
});

test('the reducer is a pure function of plain-data state: replaying recorded events from JSON reproduces the trace', () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const { input, trace } = generate(seed);
    const first = startTask(input);
    const commands: TaskCommand[] = [...first.commands];
    let state: TaskState = first.state;
    for (const event of trace.events) {
      const decision = decideTask(JSON.parse(JSON.stringify(state)) as TaskState, event);
      commands.push(...decision.commands);
      state = decision.state;
    }
    assert.deepEqual(commands, trace.commands, `seed ${seed}: replay diverged`);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), JSON.parse(JSON.stringify(trace.state)), `seed ${seed}: final state`);
  }
});

test('the same seed always produces the same trace', () => {
  for (const seed of [3, 77, 420]) assert.deepEqual(generate(seed), generate(seed));
});

// ---------------------------------------------------------------------------
// Run workflow properties
// ---------------------------------------------------------------------------

test('generated run histories start children one at a time, once each, in submission order, and a sealed run closes', () => {
  let sealedClosures = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const rng = rngFor(seed);
    const maxTasks = rng.int(1, 6);
    const fixedTasks = rng.chance(0.2) ? Array.from({ length: rng.int(1, maxTasks) }, (_x, i) => `f${i + 1}` as TaskId) : null;
    const input: RunCoreInput = {
      runId: 'run-p' as RunId,
      runBudget: { maxCostUsd: rng.int(5, 40), softCostUsd: 4, maxTasks },
      fixedTasks,
    };
    let decision = startRun(input, null);
    const log: RunCommand[] = [];
    const accepted: string[] = [...(fixedTasks ?? [])];
    const started: string[] = [];
    const model = { active: null as string | null, spent: 0, closed: false, sealed: fixedTasks !== null, cancelled: false };
    const apply = (commands: readonly RunCommand[]) => {
      for (const c of commands) {
        log.push(c);
        if (c.kind === 'startChild') {
          assert.equal(model.active, null, `seed ${seed}: child started while another is active`);
          assert.equal(c.runRemainingUsd, Math.max(0, micro(input.runBudget.maxCostUsd) - model.spent) / 1_000_000, `seed ${seed}: remainder`);
          model.active = c.taskId;
          started.push(c.taskId);
        }
        if (c.kind === 'continueAsNew') {
          assert.equal(model.active, null, `seed ${seed}: continue-as-new with an active child`);
          decision = startRun(input, JSON.parse(JSON.stringify(c.carry)) as typeof c.carry);
          apply(decision.commands);
        }
        if (c.kind === 'complete') model.closed = true;
      }
    };
    apply(decision.commands);
    for (let step = 0; step < 60 && !model.closed; step += 1) {
      const r = rng.next();
      let event: RunEvent;
      if (r < 0.4) {
        event = { type: 'submitTask', taskId: `t${rng.int(1, 8)}` as TaskId, requestId: `s${step}` };
      } else if (r < 0.7 && model.active !== null) {
        const cost = rng.int(0, 6);
        event = { type: 'childCompleted', taskId: model.active as TaskId, outcome: 'WAITING_FOR_HUMAN_REVIEW', chargedCostUsd: cost };
        model.spent += micro(cost);
        model.active = null;
      } else if (r < 0.8) {
        event = { type: 'continueAsNewSuggested' };
      } else if (r < 0.88) {
        event = { type: 'pauseRequested', requestId: `p${rng.int(1, 3)}`, principalId: 'op' };
      } else if (r < 0.94) {
        event = { type: 'resumeRequested', requestId: `r${rng.int(1, 3)}`, principalId: 'op' };
      } else if (r < 0.98) {
        event = { type: 'sealRequested', requestId: `seal${rng.int(1, 2)}`, principalId: 'op' };
      } else {
        event = { type: 'cancelRequested', requestId: `c${step}`, principalId: 'op' };
      }
      decision = decideRun(decision.state, event);
      const fresh = decision.receipt?.accepted === true && !decision.receipt.duplicate;
      if (event.type === 'submitTask' && fresh) {
        assert.ok(!model.sealed, `seed ${seed}: a submission accepted after the seal`);
        accepted.push(event.taskId);
      }
      if (event.type === 'sealRequested' && fresh) model.sealed = true;
      if (event.type === 'cancelRequested' && fresh) model.cancelled = true;
      apply(decision.commands);
      // A sealed run with no task open (none active, every accepted task started) is closed.
      if (model.sealed && !model.cancelled && model.active === null && started.length === accepted.length) {
        assert.ok(model.closed, `seed ${seed}: a sealed run with no open task stays open`);
        sealedClosures += 1;
      }
    }
    assert.equal(new Set(started).size, started.length, `seed ${seed}: a task started twice`);
    assert.deepEqual(started, accepted.slice(0, started.length), `seed ${seed}: start order`);
    if (model.closed) {
      const after = decideRun(decision.state, { type: 'submitTask', taskId: 'late' as TaskId, requestId: 'late' });
      assert.deepEqual(after.commands, [], `seed ${seed}: commands after close`);
      assert.equal(after.receipt?.reason, 'closed');
    }
    assert.ok(log.filter((c) => c.kind === 'emitRunEvent' && c.eventType === 'run.started').length === 1, `seed ${seed}: one run.started`);
  }
  assert.ok(sealedClosures > 0, 'the generator must reach sealed runs that close');
});
