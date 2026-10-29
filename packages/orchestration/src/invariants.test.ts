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
import { TASK_BASE, attemptOf, branchFor, effectsOf, fenceFor, happyAnswer, proceed, ref, requests, shaFor } from './test-support/fixtures.js';
import { MAX_USD } from './budget.js';
import { DEFAULT_ORCHESTRATION_POLICY, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import type {
  ApprovalDecisionValue,
  ApprovalKind,
  FailureClass,
  ObservedPullRequest,
  ProjectedTaskStatus,
  ForgeRepository,
  TaskCommand,
  TaskCoreInput,
  TaskDecision,
  TaskEvent,
  TaskMessage,
  TaskRequest,
  TaskRequestKind,
  TaskResult,
  TaskState,
} from './types.js';

console.log('SUITE-ID: asep-suite:orchestration-properties');

const SEEDS = 2000;

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

// Base branches the generator publishes against; most are not `main`, so a base taken from anywhere but the input
// shows up.
const BASE_BRANCHES = ['main', 'release/2026.10', 'develop', 'hotfix/x-1.2'] as const;

// The bound choices draw from their own stream (`side`), and the base branch from another (`bases`), so adding them
// left every other draw of a seed unchanged.
function randomInput(rng: Rng, side: Rng, bases: Rng): TaskCoreInput {
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
    repository: { id: 4242, owner: 'acme', name: 'widgets' },
    baseBranch: bases.pick(BASE_BRANCHES),
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

const OTHER_REPOSITORY: ForgeRepository = { id: 9001, owner: 'attacker', name: 'fork' };

/**
 * The PRs a reconciliation read reports for the branch: mostly one, the attempt's own or one that differs in a single
 * respect (head SHA, head branch, base branch, base repository, a fork head, closed, merged), and sometimes a second
 * candidate beside it. The read sometimes repaired a PR's content; that draw comes from its own stream (`remote`),
 * so every other draw of a seed is unchanged.
 */
function observedPrs(side: Rng, remote: Rng, request: Extract<TaskRequest, { kind: 'reconcilePublication' }>, head: string | null): ObservedPullRequest[] {
  const own: ObservedPullRequest = {
    number: 11,
    headRepository: request.repository,
    headBranch: request.remoteBranch,
    headSha: head ?? request.expectedHeadSha,
    baseRepository: request.repository,
    baseBranch: request.expectedBaseBranch,
    state: 'open',
    merged: false,
    contentRepaired: false,
  };
  const variant = (): ObservedPullRequest => {
    switch (side.pick(['own', 'own', 'head', 'branch', 'base', 'base-repository', 'fork', 'closed', 'merged'] as const)) {
      case 'own':
        return own;
      case 'head':
        return { ...own, headSha: 'e'.repeat(40) };
      case 'branch':
        return { ...own, headBranch: `${request.remoteBranch}-other` };
      case 'base':
        return { ...own, baseBranch: 'release' };
      case 'base-repository':
        return { ...own, baseRepository: OTHER_REPOSITORY };
      case 'fork':
        return { ...own, headRepository: OTHER_REPOSITORY };
      case 'closed':
        return { ...own, state: 'closed' };
      case 'merged':
        return { ...own, state: 'closed', merged: true };
    }
  };
  const first = variant();
  const prs = side.chance(0.12) ? [first, { ...variant(), number: 12 }] : [first];
  return prs.map((pr) => (remote.chance(0.15) ? { ...pr, contentRepaired: true } : pr));
}

/** A publication failure: it reports the push or PR as applied, absent or unknown, or reports nothing (unknown). */
function publicationFailure(rng: Rng): Answer {
  const effect = rng.pick(['applied', 'none', 'unknown', null] as const);
  return { kind: 'activityFailed', failureClass: rng.pick(CLASSES), timedOut: rng.chance(0.3), ...(effect === null ? {} : { effect }) };
}

type DecisionMessage = Extract<TaskMessage, { type: 'approvalDecisionReceived' }>;

// The approval-content choices draw from the side stream too, so they leave the main draws of a seed unchanged.
/** A generated environment, with the durable lease history it models: the grants that committed, per attempt. */
type GeneratedEnvironment = TaskEnvironment & { readonly grants: ReadonlyMap<number, string> };

function randomEnvironment(rng: Rng, side: Rng, remote: Rng, input: TaskCoreInput): GeneratedEnvironment {
  const approvalKinds = new Map<string, ApprovalKind>();
  // The lease history: a grant may commit although its acquisition failed or was aborted, and later, between a lookup
  // and the pre-lease write; a recorded terminal refuses any later grant, and a grant never disappears.
  const grants = new Map<number, string>();
  const acquiring = new Set<number>();
  const terminals = new Set<number>();
  const grantLate = (n: number, p: number) => {
    if (acquiring.has(n) && !grants.has(n) && !terminals.has(n) && side.chance(p)) grants.set(n, fenceFor(n));
  };
  // The core accepts a decision only while no request is in flight, so the decision it verifies is the last one sent.
  let lastDecision: DecisionMessage | null = null;
  const accepted = new Map<string, DecisionMessage>();
  let controlCounter = 0;
  const controlId = () => (rng.chance(0.3) && controlCounter > 0 ? `ctl-${rng.int(1, controlCounter)}` : `ctl-${++controlCounter}`);
  let decisionCounter = 0;

  const decision = (approvalRequestId: string): TaskMessage => {
    const approve = rng.chance(0.65);
    const message: DecisionMessage = {
      type: 'approvalDecisionReceived',
      decisionId: rng.chance(0.2) && decisionCounter > 0 ? `dec-${rng.int(1, decisionCounter)}` : `dec-${++decisionCounter}`,
      approvalRequestId: rng.chance(0.1) ? `${approvalRequestId}-stale` : approvalRequestId,
      decision: approve ? 'approve' : 'reject',
      extensionUsd: approve && rng.chance(0.8) ? rng.int(0, 12) : null,
      principalId: 'human-p',
    };
    // Most decisions on an opened gate carry the content its kind requires, so both kinds reach verification.
    const kind = approvalKinds.get(message.approvalRequestId);
    if (kind !== undefined && side.chance(0.75)) {
      const max = input.policy.maxBudgetExtensionUsd ?? 1;
      const amount = message.extensionUsd !== null && message.extensionUsd > 0 && message.extensionUsd <= max ? message.extensionUsd : side.int(1, max);
      lastDecision = { ...message, extensionUsd: approve && kind === 'budget-extension' ? amount : null };
    } else {
      lastDecision = message;
    }
    return lastDecision;
  };

  const control = (): TaskMessage => {
    const kind = rng.pick(['pauseRequested', 'resumeRequested', 'cancelRequested'] as const);
    return { type: kind, requestId: controlId(), principalId: 'op-p' };
  };

  return {
    grants,
    respond(request: TaskRequest): Answer {
      const n = attemptOf(request) ?? 0;
      if (request.kind === 'openApprovalRequest') approvalKinds.set(request.approvalRequestId, request.approvalKind);
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
        case 'acquireLease':
          if (rng.chance(0.06)) {
            if (side.chance(0.5)) grants.set(n, fenceFor(n));
            return failure(rng);
          }
          grants.set(n, fenceFor(n));
          return happyAnswer(request);
        case 'findLease':
          // The lookups draw from the side stream, so the main draws of a seed are unchanged.
          if (side.chance(0.08)) return failure(side);
          grantLate(n, 0.3);
          return { kind: 'findLease', fence: grants.get(n) ?? null };
        case 'recordPreLeaseOutcome':
          if (side.chance(0.05)) return failure(side);
          grantLate(n, 0.3);
          if (grants.has(n)) return { kind: 'recordPreLeaseOutcome', recorded: false };
          terminals.add(n);
          return { kind: 'recordPreLeaseOutcome', recorded: true };
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
          if (rng.chance(0.3)) return publicationFailure(rng);
          // More unknown effects from the side stream, so reconciliation reads are common enough to meet every kind of
          // remote; the main draws of a seed stay unchanged.
          if (!side.chance(0.5)) return happyAnswer(request);
          return { kind: 'activityFailed', failureClass: 'provider', timedOut: false, effect: side.pick(['unknown', 'unknown', 'applied'] as const) };
        case 'reconcilePublication': {
          // The remote holds the attempt's commit, nothing, or something else, in the binding repository or another;
          // PRs are listed for the branch or not, and are the attempt's or differ (see observedPrs); or the read fails.
          // The details come from the side stream, so the main draws of a seed are unchanged.
          if (rng.chance(0.15)) return failure(rng);
          const head = rng.pick([request.expectedHeadSha, null, 'f'.repeat(40)]);
          const hasPr = head !== null ? rng.chance(0.5) : side.chance(0.15);
          const branch = head === null ? null : { repository: side.chance(0.08) ? OTHER_REPOSITORY : request.repository, headSha: head };
          return { kind: 'reconcilePublication', branch, pullRequests: hasPr ? observedPrs(side, remote, request, head) : [] };
        }
        case 'verifyApprovalDecision': {
          const sent = accepted.get(request.decisionId);
          if (sent === undefined) throw new Error(`verification of ${request.decisionId} without an accepted decision`);
          if (rng.chance(0.05)) return failure(rng);
          const r = rng.next();
          if (r < 0.1) return { kind: 'verifyApprovalDecision', verified: false, decision: null, extensionUsd: null };
          // PostgreSQL may withhold confirmation of an approve whose content is valid for the kind, and may confirm one
          // whose content is not: the core must release the gate on neither.
          const kind = approvalKinds.get(request.approvalRequestId);
          if (sent.decision === 'approve' && kind !== undefined && side.chance(0.15)) {
            const invalidUsd = kind === 'publish-change' ? 4 : (input.policy.maxBudgetExtensionUsd ?? 0) + 1;
            return { kind: 'verifyApprovalDecision', verified: true, decision: 'approve', extensionUsd: invalidUsd };
          }
          const withheld = sent.decision === 'approve' && side.chance(0.25);
          return { kind: 'verifyApprovalDecision', verified: r >= 0.3 && !withheld, decision: sent.decision, extensionUsd: sent.extensionUsd };
        }
        default:
          if (rng.chance(0.06)) return failure(rng);
          return happyAnswer(request);
      }
    },
    eventsDuring(request: TaskRequest, timers: readonly string[]) {
      if (request.kind === 'acquireLease') acquiring.add(request.attemptNumber);
      if (request.kind === 'verifyApprovalDecision') {
        if (lastDecision?.decisionId !== request.decisionId) throw new Error(`verification of ${request.decisionId} is not the last decision sent`);
        accepted.set(request.decisionId, lastDecision);
      }
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

  // Every publication request takes the repository and the PR's base from the task input, never from a default or
  // another request.
  for (const r of reqs) {
    if (r.kind === 'upsertPullRequest') {
      assert.deepEqual(r.repository, input.repository, `${label}: the PR upsert writes to the input's repository`);
      assert.equal(r.baseBranch, input.baseBranch, `${label}: the PR upsert targets the input's base`);
    }
    if (r.kind === 'reconcilePublication') {
      assert.deepEqual(r.repository, input.repository, `${label}: the reconciliation reads the input's repository`);
      assert.equal(r.expectedBaseBranch, input.baseBranch, `${label}: the reconciliation expects the input's base`);
    }
  }
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
  // exist: registered means its ensureAttempt returned, or the lookup after a failed one found it. An attempt whose
  // state a lookup could not read gets neither; the task then ends FAILED / attempt-state-unknown over any pending
  // cancel, and reports the attempt as a gap by its idempotency key, with an audit row carrying the key.
  const registered = trace.events.flatMap((e) => {
    const request = e.type === 'result' ? seqRequests.get(e.seq) : undefined;
    if (e.type !== 'result' || request === undefined) return [];
    if (e.result.kind === 'ensureAttempt' && request.kind === 'ensureAttempt') return [request.attemptNumber];
    if (e.result.kind === 'findAttempt' && request.kind === 'findAttempt' && e.result.attemptId !== null) return [request.attemptNumber];
    return [];
  }).sort();
  // A lookup failed (the attempt's existence or lease unknown), the pre-lease write failed (its terminal unknown), or a
  // second lease lookup found nothing after a refusal (the history contradicts itself).
  const stateUnknown = trace.events.flatMap((e) => {
    const request = seqRequests.get('seq' in e ? e.seq : -1);
    if (e.type === 'activityFailed' && (request?.kind === 'findAttempt' || request?.kind === 'findLease' || request?.kind === 'recordPreLeaseOutcome')) {
      return [request.attemptNumber];
    }
    const secondLookup = e.type === 'result' && e.result.kind === 'findLease' && e.result.fence === null && request?.kind === 'findLease'
      && reqs.filter((r) => r.kind === 'findLease' && r.attemptNumber === request.attemptNumber).length === 2
      && commands.findIndex((c) => c.type === 'request' && c.seq === e.seq) > commands.findIndex((c) => c.type === 'request'
        && c.request.kind === 'recordPreLeaseOutcome' && c.request.attemptNumber === request.attemptNumber);
    return secondLookup && request?.kind === 'findLease' ? [request.attemptNumber] : [];
  }).sort();
  const key = (n: number) => `${input.taskId}:attempt:${n}`;
  assert.deepEqual(trace.summary.unrecordedAttempts, stateUnknown.map((n) => ({ attemptNumber: n, idempotencyKey: key(n) })),
    `${label}: every attempt whose state could not be read is reported, and only those`);
  if (stateUnknown.length > 0) {
    assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['FAILED', 'attempt-state-unknown'], `${label}: a failed lookup ends the task`);
    assert.deepEqual(effectsOf(commands, 'audit').filter((a) => a.action === 'attempt.state-unknown').map((a) => a.detail['idempotencyKey']),
      stateUnknown.map(key), `${label}: the audit carries the idempotency key`);
  }
  const recorded = registered.filter((n) => !stateUnknown.includes(n));
  const outcomes = effectsOf(commands, 'recordAttemptOutcome');
  // A pre-lease terminal is recorded by its request when the slot accepts it; it counts like the effect.
  const preLeaseRecorded = trace.events.flatMap((e) => {
    const request = e.type === 'result' ? seqRequests.get(e.seq) : undefined;
    return e.type === 'result' && e.result.kind === 'recordPreLeaseOutcome' && e.result.recorded && request?.kind === 'recordPreLeaseOutcome'
      ? [request.attemptNumber] : [];
  });
  assert.deepEqual([...outcomes.map((o) => o.attemptNumber), ...preLeaseRecorded].sort(), recorded, `${label}: one outcome per registered attempt`);
  assert.deepEqual(
    effectsOf(commands, 'recordUsage').map((u) => u.attemptNumber).sort(),
    recorded,
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

  // Terminal outcome before lease release, per attempt: an attempt that held a lease records its outcome while it
  // still holds it, on every path. An attempt that never asked for a lease ends cancelled, or failed only when the
  // lookup after a failed registration found it (the pre-lease terminals).
  commands.forEach((c, i) => {
    if (c.type !== 'effect' || c.effect.kind !== 'releaseLease') return;
    const n = c.effect.attemptNumber;
    const outcomeAt = commands.findIndex((x) => x.type === 'effect' && x.effect.kind === 'recordAttemptOutcome' && x.effect.attemptNumber === n);
    assert.ok(outcomeAt >= 0 && outcomeAt < i, `${label}: the lease of attempt ${n} is released before its outcome is recorded`);
  });
  const foundAfterFailure = new Set(trace.events.flatMap((e) => {
    const request = e.type === 'result' ? seqRequests.get(e.seq) : undefined;
    return e.type === 'result' && e.result.kind === 'findAttempt' && e.result.attemptId !== null && request?.kind === 'findAttempt' ? [request.attemptNumber] : [];
  }));
  for (const o of outcomes) {
    if (reqs.some((r) => r.kind === 'acquireLease' && r.attemptNumber === o.attemptNumber)) continue;
    assert.ok(o.terminal === 'cancelled' || (o.terminal === 'failed' && foundAfterFailure.has(o.attemptNumber)),
      `${label}: attempt ${o.attemptNumber} never held a lease and ends ${o.terminal}`);
  }
  for (const r of reqs) {
    if (r.kind === 'recordPreLeaseOutcome') assert.ok(r.terminal === 'cancelled' || r.terminal === 'failed', `${label}: pre-lease terminal ${r.terminal}`);
  }

  // Resources: every workspace cleaned or quarantined once (leases: checkLeases).
  for (const r of reqs) {
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

  // An accepted cancel ends the task CANCELLED, unless the publication could not reconcile or an attempt's state could
  // not be read: then it ends FAILED / publication-incomplete or FAILED / attempt-state-unknown, and nothing else.
  const cancelled = trace.messages.some((m) => m.message.type === 'cancelRequested' && m.receipt.accepted && !m.receipt.duplicate);
  if (cancelled && trace.summary.reason !== 'publication-incomplete' && trace.summary.reason !== 'attempt-state-unknown') {
    assert.equal(trace.summary.outcome, 'CANCELLED', `${label}: accepted cancel ends CANCELLED`);
  }

  // Publication identity, on every publication: the PR a task reports is this attempt's. It comes from an upsert after
  // a push that applied (a push result, a push failure reporting applied, or a reconciliation after the push that
  // found this attempt's remote), or from a reconciliation after the upsert that found this attempt's PR.
  const pushAt = requestIndex(commands, (r) => r.kind === 'publishBranch')[0];
  if (pushAt !== undefined) {
    const push = commands[pushAt]!;
    assert.ok(push.type === 'request' && push.request.kind === 'publishBranch', `${label}: push request`);
    const n = push.request.attemptNumber;
    const identity = publicationIdentity(input, trace, n);
    const upsertSeq = requests(commands).some((r) => r.kind === 'upsertPullRequest')
      ? commands.flatMap((c) => (c.type === 'request' && c.request.kind === 'upsertPullRequest' ? [c.seq] : []))[0]!
      : Infinity;
    const reconciliations = trace.events.flatMap((e) =>
      (e.type === 'result' && e.result.kind === 'reconcilePublication' ? [{ seq: e.seq, result: e.result }] : []));
    const pushApplied = trace.events.some((e) => (e.type === 'result' && e.seq === push.seq)
      || (e.type === 'activityFailed' && e.seq === push.seq && e.effect === 'applied'))
      || reconciliations.some((r) => r.seq < upsertSeq && isThisAttempts(identity, r.result));
    const upserted = trace.events.find((e) => e.type === 'result' && e.result.kind === 'upsertPullRequest');
    const upsertedPr = upserted?.type === 'result' && upserted.result.kind === 'upsertPullRequest' ? upserted.result.prNumber : null;
    const reconciledPr = reconciliations.find((r) => r.seq > upsertSeq && r.result.pullRequests.length === 1 && isThisAttempts(identity, r.result));
    if (trace.summary.prNumber !== null) {
      assert.ok((pushApplied && upsertedPr === trace.summary.prNumber) || reconciledPr?.result.pullRequests[0]?.number === trace.summary.prNumber,
        `${label}: PR ${trace.summary.prNumber} is not shown to be attempt ${n}'s`);
    } else {
      // Without a PR the remote is known to hold nothing (the push failed with effect none, or the reconciliation
      // after it found no branch and no PR), or the task ends FAILED / publication-incomplete with an audit naming the
      // attempt's branch. Retryability plays no part.
      const definite = trace.events.some((e) => e.type === 'activityFailed' && e.seq === push.seq && e.effect === 'none')
        || reconciliations.some((r) => r.seq < upsertSeq && r.result.branch === null && r.result.pullRequests.length === 0);
      if (!definite) {
        assert.deepEqual([trace.summary.outcome, trace.summary.reason], ['FAILED', 'publication-incomplete'], `${label}: branch left without a PR is reported`);
        const incident = effectsOf(commands, 'audit').find((a) => a.action === 'publication.incomplete');
        assert.equal(incident?.detail['remoteBranch'], identity.branch, `${label}: the audit names the branch`);
      }
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

interface PublicationIdentity {
  readonly repository: ForgeRepository;
  readonly branch: string;
  readonly head: string;
  readonly base: string;
}

/** What the remote holds for attempt n's publication, from its registration and commit results and the task input. */
function publicationIdentity(input: TaskCoreInput, trace: TaskTrace, n: number): PublicationIdentity {
  const requestOf = new Map<number, TaskRequest>();
  for (const c of trace.commands) if (c.type === 'request') requestOf.set(c.seq, c.request);
  let branch: string | null = null;
  let head: string | null = null;
  for (const e of trace.events) {
    if (e.type !== 'result' || requestOf.get(e.seq)?.kind !== e.result.kind || attemptOf(requestOf.get(e.seq)!) !== n) continue;
    if (e.result.kind === 'ensureAttempt') branch = e.result.branch;
    if (e.result.kind === 'commitAttempt') head = e.result.resultSha;
  }
  assert.ok(branch !== null && head !== null, `attempt ${n} published without a registered branch or a commit`);
  return { repository: input.repository, branch, head, base: input.baseBranch };
}

/** A repository is its forge id; owner and name are informational (a rename or a transfer keeps the id). */
function sameRepository(a: ForgeRepository, b: ForgeRepository): boolean {
  return a.id === b.id;
}

/** How a listed PR differs from the attempt's own, the first difference found; `own` when it does not. */
function prDifference(identity: PublicationIdentity, pr: ObservedPullRequest): string {
  if (pr.merged) return 'merged';
  if (pr.state !== 'open') return 'closed';
  if (!sameRepository(pr.headRepository, identity.repository)) return 'fork';
  if (pr.headBranch !== identity.branch) return 'head-branch';
  if (pr.headSha !== identity.head) return 'head-sha';
  if (!sameRepository(pr.baseRepository, identity.repository)) return 'base-repository';
  if (pr.baseBranch !== identity.base) return 'base';
  return 'own';
}

/**
 * The identity rule, stated here independently of the core over the same full observation: the branch is in the
 * binding repository at the attempt's commit, and the PRs listed are none or exactly one that is the attempt's own.
 */
function isThisAttempts(identity: PublicationIdentity, read: Extract<TaskResult, { kind: 'reconcilePublication' }>): boolean {
  const branchOwn = read.branch !== null && sameRepository(read.branch.repository, identity.repository) && read.branch.headSha === identity.head;
  const [pr, ...others] = read.pullRequests;
  return branchOwn && others.length === 0 && (pr === undefined || prDifference(identity, pr) === 'own');
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
// reported applied) is followed at once by a reconciliation read, never by a terminal state. Each reconciliation
// result is followed by the decision the identity rule gives: after the push, this attempt's remote continues to the
// PR upsert and a remote with no branch and no PR means nothing was pushed; after the upsert, this attempt's remote
// with a PR continues as a successful upsert with that PR; anything else, and a failed read, ends the task
// FAILED / publication-incomplete, whatever cancel is pending.
function checkPublicationEffects(input: TaskCoreInput, trace: TaskTrace, label: string): void {
  const upsertSeq = trace.commands.flatMap((c) => (c.type === 'request' && c.request.kind === 'upsertPullRequest' ? [c.seq] : []))[0] ?? Infinity;
  for (const { before, event, decision } of replaySteps(input, trace)) {
    const answersReconciliation = (event.type === 'result' || event.type === 'activityFailed') && before.pending !== null
      && before.pending.seq === event.seq && before.pending.request.kind === 'reconcilePublication' && before.outcome === null;
    if (answersReconciliation && before.pending !== null && before.pending.request.kind === 'reconcilePublication') {
      const n = before.pending.request.attemptNumber;
      const completed = decision.commands.flatMap((c) => (c.type === 'complete' ? [c.summary] : []))[0];
      const ended = completed === undefined ? null : [completed.outcome, completed.reason, completed.prNumber];
      const issued = requests(decision.commands).map((r) => r.kind);
      const incomplete = ['FAILED', 'publication-incomplete', null];
      if (event.type === 'activityFailed') {
        assert.deepEqual(ended, incomplete, `${label}: a failed reconciliation read must end publication-incomplete`);
        continue;
      }
      assert.ok(event.type === 'result' && event.result.kind === 'reconcilePublication', `${label}: reconciliation result`);
      const read = event.result;
      // Every content repair the read reports is audited by the decision that reads it, whatever that decision is.
      assert.deepEqual(
        effectsOf(decision.commands, 'audit').filter((a) => a.action === 'publication.content-repaired').map((a) => a.detail['prNumber']),
        read.pullRequests.filter((pr) => pr.contentRepaired).map((pr) => pr.number),
        `${label}: every content repair is audited`,
      );
      const own = isThisAttempts(publicationIdentity(input, trace, n), read);
      const afterPush = event.seq < upsertSeq;
      if (afterPush && own) {
        assert.deepEqual([issued, ended], [['upsertPullRequest'], null], `${label}: this attempt's remote after the push continues to the PR`);
      } else if (afterPush && read.branch === null && read.pullRequests.length === 0) {
        assert.ok(ended !== null && (ended[1] === 'publication-failed' || ended[1] === 'cancelled') && ended[2] === null,
          `${label}: nothing on the remote after the push ends ${JSON.stringify(ended)}`);
      } else if (!afterPush && own && read.pullRequests.length === 1) {
        assert.ok(ended !== null && ['WAITING_FOR_HUMAN_REVIEW', 'CANCELLED'].includes(String(ended[0])) && ended[2] === read.pullRequests[0]!.number,
          `${label}: this attempt's PR after the upsert ends ${JSON.stringify(ended)}`);
      } else {
        assert.deepEqual(ended, incomplete, `${label}: a remote that is not attempt ${n}'s (${JSON.stringify(read)}) must end publication-incomplete`);
      }
      continue;
    }
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

// Leases, step by step: every terminal write and release carries the fence the workflow learned for the attempt (from
// its acquisition or a lookup), and fence null only for an attempt that never asked for a lease; a lookup follows only
// a lease request, a second one only a refused pre-lease write, and never a third; a pre-lease write is issued only
// when no lease is known. With the environment's lease history: every grant that committed is released once with its
// fence, unless the attempt's state could not be read.
function checkLeases(input: TaskCoreInput, trace: TaskTrace, grants: ReadonlyMap<number, string>, label: string): void {
  const fence = new Map<number, string>();
  const asked = new Set<number>();
  const lookups = new Map<number, number>();
  const refused = new Set<number>();
  const released = new Map<number, string[]>();
  for (const { before, event, decision } of replaySteps(input, trace)) {
    const request = (event.type === 'result' || event.type === 'activityFailed') && before.pending?.seq === event.seq ? before.pending.request : null;
    if (event.type === 'result' && request !== null) {
      const r = event.result;
      if (r.kind === 'acquireLease' && request.kind === 'acquireLease') fence.set(request.attemptNumber, r.fence);
      if (r.kind === 'findLease' && request.kind === 'findLease' && r.fence !== null) fence.set(request.attemptNumber, r.fence);
      if (r.kind === 'recordPreLeaseOutcome' && request.kind === 'recordPreLeaseOutcome' && !r.recorded) refused.add(request.attemptNumber);
    }
    for (const c of decision.commands) {
      if (c.type === 'request' && c.request.kind === 'acquireLease') asked.add(c.request.attemptNumber);
      if (c.type === 'request' && c.request.kind === 'findLease') {
        const n = c.request.attemptNumber;
        const count = (lookups.get(n) ?? 0) + 1;
        lookups.set(n, count);
        assert.ok(asked.has(n), `${label}: a lease lookup for attempt ${n}, which never asked for a lease`);
        assert.ok(count === 1 || (count === 2 && refused.has(n)), `${label}: lease lookup ${count} of attempt ${n}`);
      }
      if (c.type === 'request' && c.request.kind === 'recordPreLeaseOutcome') {
        const n = c.request.attemptNumber;
        assert.ok(!fence.has(n) && lookups.get(n) === 1 && !refused.has(n), `${label}: a pre-lease write for attempt ${n} with a lease known or unsought`);
      }
      if (c.type === 'effect' && c.effect.kind === 'recordAttemptOutcome') {
        const n = c.effect.attemptNumber;
        assert.equal(c.effect.fence, fence.get(n) ?? null, `${label}: the terminal of attempt ${n} carries the fence it was granted`);
        if (c.effect.fence === null) assert.ok(!asked.has(n), `${label}: attempt ${n} asked for a lease and records fence null`);
      }
      if (c.type === 'effect' && c.effect.kind === 'releaseLease') {
        const n = c.effect.attemptNumber;
        assert.equal(c.effect.fence, fence.get(n), `${label}: the lease of attempt ${n} is released with its fence`);
        released.set(n, [...(released.get(n) ?? []), c.effect.fence]);
      }
    }
  }
  const unrecorded = new Set(trace.summary.unrecordedAttempts.map((u) => u.attemptNumber));
  for (const [n, granted] of grants) {
    if (unrecorded.has(n)) {
      assert.equal(released.get(n), undefined, `${label}: attempt ${n} of unknown state is released`);
      continue;
    }
    assert.deepEqual(released.get(n), [granted], `${label}: the lease granted to attempt ${n} is released once with its fence`);
  }
  for (const n of released.keys()) assert.ok(grants.has(n), `${label}: attempt ${n} released a lease that was never granted`);
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
// withheld for a pause) only by the result of a verifyApprovalDecision that is verified, says approve with content valid
// for the kind, and arrives before that request's expiry fired. Such a result releases the gate unless a cancel is
// pending, and a result that arrives after the expiry fired expires the request.
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
    const { verified, decision: value, extensionUsd } = event.result;
    const approved = verified && value === 'approve'
      && contentValid(before.approval.kind, value, extensionUsd, input.policy.maxBudgetExtensionUsd);
    assert.ok(!released || (approved && !expired), `${label}: gate ${id} released by verified=${verified} decision=${value} extension=${extensionUsd} expired=${expired}`);
    if (approved && !expired && !before.cancelPending) assert.ok(released, `${label}: a confirmed approve left gate ${id} closed`);
    if (expired) {
      assert.deepEqual(effectsOf(decision.commands, 'expireApprovalRequest').map((e) => e.approvalRequestId), [id], `${label}: ${id} expired while verifying`);
    }
  }
}

/**
 * The decision content rule, stated here independently of the core: a budget-extension approve names a positive
 * amount in whole micro-dollars within the policy bound; every other decision names no amount.
 */
function contentValid(kind: ApprovalKind, decision: ApprovalDecisionValue | null, extensionUsd: number | null, maxUsd: number | null): boolean {
  if (decision === null) return false;
  if (kind === 'publish-change' || decision === 'reject') return extensionUsd === null;
  return extensionUsd !== null && maxUsd !== null && Number.isInteger(extensionUsd * 1_000_000) && extensionUsd > 0 && extensionUsd <= maxUsd;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function generate(seed: number): { input: TaskCoreInput; trace: TaskTrace; grants: ReadonlyMap<number, string> } {
  const rng = rngFor(seed);
  const side = rngFor(seed + 1_000_003);
  const input = randomInput(rng, side, rngFor(seed + 4_000_037));
  const environment = randomEnvironment(rng, side, rngFor(seed + 6_000_011), input);
  return { input, trace: runTaskSequentially(input, environment), grants: environment.grants };
}

const PUBLICATION_SEEDS = 3000;

const PUBLICATION_REQUESTS: readonly TaskRequestKind[] = ['publishBranch', 'upsertPullRequest', 'reconcilePublication'];

/**
 * A generator aimed at publication: every request before the push succeeds, so most traces publish, while the
 * publication answers, the reconciliation reads and the messages and timers in flight stay random.
 */
function generatePublication(seed: number): { input: TaskCoreInput; trace: TaskTrace } {
  const rng = rngFor(seed + 2_000_003);
  const side = rngFor(seed + 3_000_017);
  const input = randomInput(rng, side, rngFor(seed + 5_000_011));
  const random = randomEnvironment(rng, side, rngFor(seed + 7_000_003), input);
  return {
    input,
    trace: runTaskSequentially(input, {
      ...random,
      respond: (request) => (PUBLICATION_REQUESTS.includes(request.kind) ? random.respond(request) : happyAnswer(request)),
    }),
  };
}

test('generated task traces satisfy the orchestration safety invariants', () => {
  const outcomes = new Map<string, number>();
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const { input, trace, grants } = generate(seed);
    checkTrace(input, trace, `seed ${seed}`);
    checkLeases(input, trace, grants, `seed ${seed}`);
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
      if (e.type === 'result' && e.result.kind === 'reconcilePublication') {
        seen.add(e.result.branch === null ? 'reconciled-absent' : 'reconciled-present');
        const n = trace.commands.flatMap((c) => (c.type === 'request' && c.seq === e.seq && c.request.kind === 'reconcilePublication' ? [c.request.attemptNumber] : []))[0]!;
        const own = isThisAttempts(publicationIdentity(input, trace, n), e.result);
        if (e.result.pullRequests.length > 0) seen.add(own ? 'reconciled-own-pr' : e.result.branch?.headSha === publicationIdentity(input, trace, n).head ? 'reconciled-pr-not-own' : 'reconciled-branch-not-own-with-pr');
      }
      if (e.type === 'activityFailed' && e.activity === 'reconcilePublication') seen.add('reconciliation-failed');
    }
    for (const { before, event, decision } of replaySteps(input, trace)) {
      if (event.type === 'pauseRequested' && waitsForApproval(before) && !before.paused && decision.receipt?.accepted) seen.add('paused-while-waiting');
      if (event.type === 'timerFired' && before.paused && event.timerId.startsWith('approval:')) seen.add('expired-while-paused');
      if (event.type === 'timerFired' && before.pending !== null) {
        seen.add(event.timerId.startsWith('approval:') ? 'expiry-during-verification' : 'pause-timeout-in-flight');
      }
      // PostgreSQL withholds confirmation of an approve whose content is valid for the kind, so content alone must not
      // release the gate; and it confirms an approve whose content is not, which must not release it either.
      if (event.type === 'result' && event.result.kind === 'verifyApprovalDecision' && event.result.decision === 'approve'
        && before.approval !== null && !before.approval.expiryFired) {
        const valid = contentValid(before.approval.kind, 'approve', event.result.extensionUsd, input.policy.maxBudgetExtensionUsd);
        if (!event.result.verified && valid) seen.add(`unconfirmed-approve-${before.approval.kind}`);
        if (event.result.verified && !valid) seen.add(`invalid-content-${before.approval.kind}`);
      }
    }
    for (const e of trace.events) {
      if (e.type === 'result' && e.result.kind === 'findAttempt') seen.add(e.result.attemptId === null ? 'registration-absent' : 'registration-found');
      if (e.type === 'activityFailed' && e.activity === 'findAttempt') seen.add('registration-unknown');
      if (e.type === 'result' && e.result.kind === 'findLease') {
        const n = trace.commands.flatMap((c) => (c.type === 'request' && c.seq === e.seq && c.request.kind === 'findLease' ? [c.request.attemptNumber] : []))[0]!;
        const failed = trace.events.some((f) => f.type === 'activityFailed' && f.activity === 'acquireLease'
          && trace.commands.some((c) => c.type === 'request' && c.seq === f.seq && c.request.kind === 'acquireLease' && c.request.attemptNumber === n));
        seen.add(`lease-${e.result.fence === null ? 'absent' : 'found'}-after-${failed ? 'failure' : 'abort'}`);
      }
      if (e.type === 'result' && e.result.kind === 'recordPreLeaseOutcome' && !e.result.recorded) seen.add('lease-late-grant');
      if (e.type === 'activityFailed' && e.activity === 'findLease') seen.add('lease-lookup-failed');
      if (e.type === 'activityFailed' && e.activity === 'recordPreLeaseOutcome') seen.add('pre-lease-write-failed');
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
    'expiry-during-verification', 'extension-granted', 'hostile-policy-failure', 'invalid-content-budget-extension',
    'invalid-content-publish-change', 'lease-absent-after-abort', 'lease-absent-after-failure', 'lease-found-after-abort',
    'lease-found-after-failure', 'lease-late-grant', 'lease-lookup-failed', 'lineage-retry', 'micro-overrun', 'overrun',
    'overrun-at-bound',
    'pause-timeout', 'pause-timeout-in-flight', 'paused', 'paused-while-waiting', 'pre-lease-write-failed', 'publication-incomplete',
    'publish-approval', 'publishBranch-applied', 'publishBranch-none', 'publishBranch-unknown', 'reconciled-absent',
    'reconciled-branch-not-own-with-pr', 'reconciled-own-pr', 'reconciled-pr-not-own', 'reconciled-present',
    'reconciliation-failed',
    'recovered', 'registration-absent', 'registration-found', 'registration-unknown',
    'repair', 'retry', 'unconfirmed-approve-budget-extension', 'unconfirmed-approve-publish-change',
    'upsertPullRequest-applied', 'upsertPullRequest-none',
    'upsertPullRequest-unknown', 'usage-out-of-bound', 'verification-stop', 'verified-within-grace', 'violation',
    'wall-clock-overrun',
  ]);
});

test('generated publication traces satisfy the invariants and meet every kind of remote a reconciliation can read', () => {
  const seen = new Set<string>();
  let published = 0;
  let publishedOffMain = 0;
  for (let seed = 1; seed <= PUBLICATION_SEEDS; seed += 1) {
    const { input, trace } = generatePublication(seed);
    checkTrace(input, trace, `publication seed ${seed}`);
    checkPublicationEffects(input, trace, `publication seed ${seed}`);
    const push = requests(trace.commands).find((r) => r.kind === 'publishBranch');
    if (push?.kind !== 'publishBranch') continue;
    published += 1;
    if (input.baseBranch !== 'main') publishedOffMain += 1;
    const identity = publicationIdentity(input, trace, push.attemptNumber);
    const upsertSeq = trace.commands.flatMap((c) => (c.type === 'request' && c.request.kind === 'upsertPullRequest' ? [c.seq] : []))[0] ?? Infinity;
    for (const e of trace.events) {
      if (e.type !== 'result' || e.result.kind !== 'reconcilePublication') continue;
      const read = e.result;
      const branch = read.branch === null ? 'absent' : !sameRepository(read.branch.repository, identity.repository) ? 'other-repository'
        : read.branch.headSha === identity.head ? 'own' : 'moved';
      const differs = read.pullRequests.length === 0 ? 'none' : read.pullRequests.length > 1 ? 'multiple' : prDifference(identity, read.pullRequests[0]!);
      seen.add(`${e.seq < upsertSeq ? 'push' : 'pr'}:branch-${branch}:pr-${differs}`);
    }
  }
  assert.ok(published >= PUBLICATION_SEEDS / 4, `only ${published} of ${PUBLICATION_SEEDS} traces published`);
  assert.ok(publishedOffMain >= PUBLICATION_SEEDS / 8, `only ${publishedOffMain} traces published against a base other than main`);
  // Every predicate clause is met on its own, on both paths: a PR that differs in one respect only, or a second
  // candidate, with the branch at the attempt's commit; and a branch absent, moved or in another repository.
  for (const path of ['push', 'pr']) {
    for (const differs of ['base', 'base-repository', 'head-branch', 'head-sha', 'fork', 'closed', 'merged', 'multiple', 'own']) {
      assert.ok(seen.has(`${path}:branch-own:pr-${differs}`), `no ${path} reconciliation read a PR (${differs}) on the attempt's branch: ${[...seen].sort().join(' ')}`);
    }
    for (const branch of ['absent', 'moved', 'other-repository']) {
      assert.ok(seen.has(`${path}:branch-${branch}:pr-none`), `no ${path} reconciliation read a ${branch} branch: ${[...seen].sort().join(' ')}`);
    }
  }
});

test('the generator\'s seed 1351: a PR found while the branch holds another commit is not the attempt\'s, and the task reports it', () => {
  // An extended run of this generator found this seed handing off a PR whose branch held another commit: the push
  // failed reporting applied, the PR upsert failed with an unknown effect, and the read found the branch moved.
  const { input, trace } = generate(1351);
  const read = trace.events.flatMap((e) => (e.type === 'result' && e.result.kind === 'reconcilePublication' ? [e.result] : []));
  assert.equal(read.length, 1, 'one reconciliation read');
  assert.ok(read[0]!.branch?.headSha !== shaFor(1) && read[0]!.pullRequests.length > 0, 'the read found a PR while the branch holds another commit');
  assert.ok(trace.events.some((e) => e.type === 'activityFailed' && e.activity === 'upsertPullRequest' && e.effect === 'unknown'), 'after a PR upsert failure');
  assert.deepEqual([trace.summary.outcome, trace.summary.reason, trace.summary.prNumber], ['FAILED', 'publication-incomplete', null]);
  checkTrace(input, trace, 'seed 1351');
  checkPublicationEffects(input, trace, 'seed 1351');
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
