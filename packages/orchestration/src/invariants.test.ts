// Property tests for the decision core.
//
// A seeded generator drives the task reducer through the sequential interpreter
// with random budgets and policy, activity results, activity failures, worker
// deaths, cap stops and overruns, assurance outcomes (valid, out of contract and
// unavailable), approvals, pauses, resumes, cancels and timer firings. Every generated trace must satisfy the safety invariants the
// durable workflow relies on. Seeds are fixed, so a failure is reproducible: the
// assertion message names the seed.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskId, RunId } from '@asep/contracts';
import { toMicroUsd } from './budget.js';
import { isLegalProjection } from './projection.js';
import { decideRun, startRun } from './run-core.js';
import type { RunCommand, RunCoreInput, RunEvent } from './run-core.js';
import { runTaskSequentially } from './sequential-interpreter.js';
import type { Answer, TaskEnvironment, TaskTrace } from './sequential-interpreter.js';
import { decideTask, startTask } from './task-core.js';
import { TASK_BASE, attemptOf, effectsOf, happyAnswer, proceed, ref, requests, shaFor } from './test-support/fixtures.js';
import { DEFAULT_ORCHESTRATION_POLICY, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import type {
  FailureClass,
  ProjectedTaskStatus,
  TaskCommand,
  TaskCoreInput,
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

function randomInput(rng: Rng): TaskCoreInput {
  const attemptCost = rng.int(1, 6);
  const taskCap = rng.int(2, 20);
  return {
    taskId: 'task-p' as TaskId,
    runId: 'run-p' as RunId,
    risk: 'R0',
    baseSha: TASK_BASE,
    attemptBudget: { maxTurns: 10, maxToolCalls: 50, maxCostUsd: attemptCost, maxWallClockMinutes: rng.int(10, 60) },
    taskBudget: {
      maxAttempts: rng.int(1, 4),
      maxCostUsd: taskCap,
      softCostUsd: rng.int(1, taskCap),
      maxWallClockMinutes: rng.int(30, 240),
    },
    verificationReserve: { costUsd: rng.int(0, 2), wallClockMinutes: rng.int(0, 20) },
    runRemainingUsd: rng.int(1, 40),
    governance: {
      publicationApprovalRequired: rng.chance(0.3),
      approvalTtlSeconds: 600,
      maxPauseHours: 1,
      assuranceMode: rng.pick(['shadow', 'gating'] as const),
    },
    policy: {
      ...DEFAULT_ORCHESTRATION_POLICY,
      // Sometimes a hostile policy that lists a never-replaceable class; the core must ignore it.
      replaceableFailureClasses: rng.chance(0.15)
        ? [...DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses, rng.pick(NEVER_REPLACEABLE_FAILURE_CLASSES)]
        : DEFAULT_ORCHESTRATION_POLICY.replaceableFailureClasses,
      maxBudgetExtensionUsd: rng.chance(0.7) ? 10 : null,
    },
  };
}

function failure(rng: Rng): Answer {
  return { kind: 'activityFailed', failureClass: rng.pick(CLASSES), timedOut: rng.chance(0.4) };
}

function randomEnvironment(rng: Rng, input: TaskCoreInput): TaskEnvironment {
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
          // Mostly within the caps, sometimes exactly at them, sometimes above (an overrun).
          const cost = rng.chance(0.1) ? Math.round(cap.maxCostUsd * (100 + rng.int(1, 60))) / 100
            : rng.chance(0.1) ? cap.maxCostUsd : Math.round(rng.next() * cap.maxCostUsd * 100) / 100;
          const toolCalls = rng.chance(0.05) ? cap.maxToolCalls + rng.int(1, 5) : rng.int(0, cap.maxToolCalls);
          if (rng.chance(0.2)) {
            return {
              kind: 'runAgent',
              status: rng.pick(['FAILED', 'BLOCKED', 'BUDGET_EXHAUSTED'] as const),
              reportedCostUsd: cost,
              reportedToolCalls: toolCalls,
              wallClockMs: rng.int(1, 3_600_000),
              failureClass: rng.chance(0.9) ? rng.pick(CLASSES) : null,
            };
          }
          return { kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: cost, reportedToolCalls: toolCalls, wallClockMs: rng.int(1, 3_600_000), failureClass: null };
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
        case 'verifyApprovalDecision': {
          const sent = sentDecisions.get(request.decisionId);
          if (rng.chance(0.05)) return failure(rng);
          if (!sent || rng.chance(0.2)) return { kind: 'verifyApprovalDecision', verified: false, decision: null, extensionUsd: null };
          return { kind: 'verifyApprovalDecision', verified: true, decision: sent.decision, extensionUsd: sent.extensionUsd };
        }
        default:
          if (rng.chance(0.06)) return failure(rng);
          return happyAnswer(request);
      }
    },
    messagesDuring(): readonly TaskMessage[] {
      const out: TaskMessage[] = [];
      while (rng.chance(0.12)) out.push(rng.chance(0.85) ? control() : decision(`asep-task-task-p:${rng.int(1, 3)}`));
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
      spent += toMicroUsd(c.effect.chargedCostUsd);
      wallClock += c.effect.chargedWallClockMinutes;
    }
    if (c.type === 'effect' && c.effect.kind === 'recordExtension') granted += toMicroUsd(c.effect.extensionUsd);
    if (c.type === 'effect' && c.effect.kind === 'recordOverrun') overrun = true;
    if (c.type === 'request' && c.request.kind === 'ensureAttempt') {
      const reserve = toMicroUsd(input.attemptBudget.maxCostUsd) + toMicroUsd(input.verificationReserve.costUsd);
      const minutes = input.attemptBudget.maxWallClockMinutes + input.verificationReserve.wallClockMinutes;
      assert.ok(spent + reserve <= toMicroUsd(input.taskBudget.maxCostUsd) + granted, `${label}: task cap reservation`);
      assert.ok(spent + reserve <= toMicroUsd(input.runRemainingUsd), `${label}: run cap reservation`);
      assert.ok(wallClock + minutes <= input.taskBudget.maxWallClockMinutes, `${label}: wall-clock reservation`);
      assert.ok(!overrun, `${label}: attempt started after a recorded overrun`);
    }
  }

  // Budget-extension approvals exist only while the policy sets an extension bound.
  if (input.policy.maxBudgetExtensionUsd === null) {
    assert.ok(!reqs.some((r) => r.kind === 'openApprovalRequest' && r.approvalKind === 'budget-extension'), `${label}: extension approval without a bound`);
  }

  // Exactly one attempt outcome and one usage entry per ensured attempt.
  const outcomes = effectsOf(commands, 'recordAttemptOutcome');
  assert.deepEqual(outcomes.map((o) => o.attemptNumber).sort(), ensured.map((r) => r.attemptNumber), `${label}: one outcome per attempt`);
  assert.deepEqual(
    effectsOf(commands, 'recordUsage').map((u) => u.attemptNumber).sort(),
    ensured.map((r) => r.attemptNumber),
    `${label}: one usage entry per attempt`,
  );

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

  // A non-replaceable agent failure ends the task FAILED (or CANCELLED), overrun or not, whatever the policy
  // lists: no further attempt follows it.
  const requestBySeq = new Map<number, TaskRequest>();
  for (const c of commands) if (c.type === 'request') requestBySeq.set(c.seq, c.request);
  for (const e of trace.events) {
    if (e.type !== 'result' || e.result.kind !== 'runAgent') continue;
    const r = e.result;
    const failed = r.status === 'FAILED' || r.status === 'BLOCKED' || (r.status === 'BUDGET_EXHAUSTED' && r.failureClass !== null);
    const replaceable = r.failureClass !== null && !NEVER_REPLACEABLE_FAILURE_CLASSES.includes(r.failureClass)
      && input.policy.replaceableFailureClasses.includes(r.failureClass);
    if (!failed || replaceable) continue;
    const request = requestBySeq.get(e.seq);
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

  // An accepted cancel ends the task CANCELLED.
  const cancelled = trace.messages.some((m) => m.message.type === 'cancelRequested' && m.receipt.accepted && !m.receipt.duplicate);
  if (cancelled) assert.equal(trace.summary.outcome, 'CANCELLED', `${label}: accepted cancel ends CANCELLED`);

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

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function generate(seed: number): { input: TaskCoreInput; trace: TaskTrace } {
  const rng = rngFor(seed);
  const input = randomInput(rng);
  return { input, trace: runTaskSequentially(input, randomEnvironment(rng, input)) };
}

test('generated task traces satisfy the orchestration safety invariants', () => {
  const outcomes = new Map<string, number>();
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const { input, trace } = generate(seed);
    checkTrace(input, trace, `seed ${seed}`);
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
    if (effectsOf(trace.commands, 'audit').some((a) => a.action === 'assurance-unavailable')) seen.add('assurance-unavailable');
    if (reqs.some((r) => r.kind === 'ensureAttempt' && r.attemptKind === 'retry' && r.repairOrderRef !== null)) seen.add('lineage-retry');
    const hostile = input.policy.replaceableFailureClasses.filter((c) => NEVER_REPLACEABLE_FAILURE_CLASSES.includes(c));
    if (trace.events.some((e) => e.type === 'result' && e.result.kind === 'runAgent' && e.result.failureClass !== null
      && e.result.status !== 'AGENT_DONE' && hostile.includes(e.result.failureClass))) seen.add('hostile-policy-failure');
  }
  assert.deepEqual([...seen].sort(), [
    'abort', 'approval-expired', 'assurance-unavailable', 'budget-approval', 'exhausted', 'extension-granted',
    'hostile-policy-failure', 'lineage-retry', 'overrun', 'pause-timeout', 'paused', 'publish-approval', 'recovered', 'repair', 'retry',
    'verification-stop', 'violation',
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

test('generated run histories start children one at a time, once each, in submission order', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const rng = rngFor(seed);
    const input: RunCoreInput = {
      runId: 'run-p' as RunId,
      runBudget: { maxCostUsd: rng.int(5, 40), softCostUsd: 4, maxTasks: rng.int(1, 6) },
    };
    let decision = startRun(input, null);
    const log: RunCommand[] = [];
    const accepted: string[] = [];
    const started: string[] = [];
    const model = { active: null as string | null, spent: 0, closed: false };
    const apply = (commands: readonly RunCommand[]) => {
      for (const c of commands) {
        log.push(c);
        if (c.kind === 'startChild') {
          assert.equal(model.active, null, `seed ${seed}: child started while another is active`);
          assert.equal(c.runRemainingUsd, Math.max(0, toMicroUsd(input.runBudget.maxCostUsd) - model.spent) / 1_000_000, `seed ${seed}: remainder`);
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
        model.spent += toMicroUsd(cost);
        model.active = null;
      } else if (r < 0.8) {
        event = { type: 'continueAsNewSuggested' };
      } else if (r < 0.88) {
        event = { type: 'pauseRequested', requestId: `p${rng.int(1, 3)}`, principalId: 'op' };
      } else if (r < 0.96) {
        event = { type: 'resumeRequested', requestId: `r${rng.int(1, 3)}`, principalId: 'op' };
      } else {
        event = { type: 'cancelRequested', requestId: `c${step}`, principalId: 'op' };
      }
      decision = decideRun(decision.state, event);
      if (event.type === 'submitTask' && decision.receipt?.accepted && !decision.receipt.duplicate) accepted.push(event.taskId);
      apply(decision.commands);
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
});
