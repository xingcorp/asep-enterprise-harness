// Shared test fixtures for the decision-core suites (test support, not a test file;
// excluded from the purity scan with the tests).

import type {
  ArtifactRef,
  ArtifactId,
  AttemptId,
  RunId,
  TaskId,
} from '@asep/contracts';
import { DEFAULT_ORCHESTRATION_POLICY } from '../defaults.js';
import type {
  OrchestrationPolicy,
  TaskCommand,
  TaskCoreInput,
  TaskEffect,
  TaskGovernance,
  TaskRequest,
  TaskRequestKind,
} from '../types.js';
import type { Answer, TaskEnvironment } from '../sequential-interpreter.js';

export const TASK_BASE = 'b'.repeat(40);
/** Not `main`, so a base the core takes from anywhere but the input shows up in every scenario. */
export const TASK_BASE_BRANCH = 'release/2026.10';

export function shaFor(attemptNumber: number): string {
  return attemptNumber.toString(16).padStart(40, 'c');
}

/** The remote branch the attempt registration reports for attempt n (the Git adapter's naming rule). */
export function branchFor(attemptNumber: number): string {
  return `asep/run-1/task-1/att-${attemptNumber}`;
}

export function ref(name: string): ArtifactRef {
  const hex = Array.from(name, (c) => c.charCodeAt(0).toString(16)).join('');
  return { artifactId: `art-${name}` as ArtifactId, sha256: hex.padEnd(64, '0').slice(0, 64), kind: 'test' };
}

export function governance(overrides: Partial<TaskGovernance> = {}): TaskGovernance {
  return { publicationApprovalRequired: false, approvalTtlSeconds: 3600, maxPauseHours: 72, assuranceMode: 'shadow', ...overrides };
}

/** The default policy with a budget-extension bound set, so extension approvals are available. */
export function policy(overrides: Partial<OrchestrationPolicy> = {}): OrchestrationPolicy {
  return { ...DEFAULT_ORCHESTRATION_POLICY, maxBudgetExtensionUsd: 50, ...overrides };
}

export function baseInput(overrides: Partial<TaskCoreInput> = {}): TaskCoreInput {
  return {
    taskId: 'task-1' as TaskId,
    runId: 'run-1' as RunId,
    risk: 'R0',
    baseSha: TASK_BASE,
    baseBranch: TASK_BASE_BRANCH,
    attemptBudget: { maxTurns: 10, maxToolCalls: 50, maxCostUsd: 5, maxWallClockMinutes: 30 },
    taskBudget: { maxAttempts: 3, maxCostUsd: 20, softCostUsd: 12, maxWallClockMinutes: 240 },
    verificationReserve: { costUsd: 1, wallClockMinutes: 10 },
    runRemainingUsd: 100,
    governance: governance(),
    policy: policy(),
    ...overrides,
  };
}

/** Attempt number of a request, or null for task-level requests. */
export function attemptOf(request: TaskRequest): number | null {
  if (request.kind === 'assuranceRound') return request.request.attemptNumber;
  if ('attemptNumber' in request) return request.attemptNumber;
  return null;
}

export function proceed(name = 'adj-1'): unknown {
  return { kind: 'PROCEED', adjudicationId: name, mode: 'not-required', prBodySectionRef: ref(`pr-${name}`) };
}

/** A REPAIR outcome for the attempt whose harness commit is shaFor(attemptNumber). */
export function repair(attemptNumber: number, round: number, name = `adj-r${attemptNumber}`): unknown {
  return {
    kind: 'REPAIR',
    adjudicationId: name,
    repairOrderRef: ref(`ro-${attemptNumber}`),
    nextRound: round + 1,
    repairBaseSha: shaFor(attemptNumber),
  };
}

/** The default answer for every request: the happy path. */
export function happyAnswer(request: TaskRequest): Answer {
  const n = attemptOf(request) ?? 0;
  switch (request.kind) {
    case 'admitTask':
      return { kind: 'admitTask', admitted: true, reason: 'admitted' };
    case 'ensureAttempt':
      return { kind: 'ensureAttempt', attemptId: `att-${request.attemptNumber}` as AttemptId, branch: branchFor(request.attemptNumber) };
    case 'findAttempt':
      return { kind: 'findAttempt', attemptId: `att-${request.attemptNumber}` as AttemptId };
    case 'acquireLease':
      return { kind: 'acquireLease' };
    case 'prepareWorkspace':
      return { kind: 'prepareWorkspace' };
    case 'storeAttemptInputs':
      return { kind: 'storeAttemptInputs' };
    case 'runAgent':
      return { kind: 'runAgent', status: 'AGENT_DONE', reportedCostUsd: 1, reportedToolCalls: 10, wallClockMs: 60_000, failureClass: null };
    case 'inspectWorkspace':
      return { kind: 'inspectWorkspace', overstep: false };
    case 'runVerification':
      return { kind: 'runVerification', verdict: 'PASS' };
    case 'commitAttempt':
      return { kind: 'commitAttempt', resultSha: shaFor(n) };
    case 'persistEvidence':
      return { kind: 'persistEvidence', evidenceId: `ev-${n}` };
    case 'assuranceRound':
      return { kind: 'assuranceRound', outcome: proceed(`adj-${n}`) };
    case 'openApprovalRequest':
      return { kind: 'openApprovalRequest' };
    case 'verifyApprovalDecision':
      return { kind: 'verifyApprovalDecision', verified: true, decision: 'approve', extensionUsd: null };
    case 'publishBranch':
      return { kind: 'publishBranch', effect: 'applied' };
    case 'upsertPullRequest':
      return { kind: 'upsertPullRequest', effect: 'applied', prNumber: 7 };
    case 'reconcilePublication':
      return {
        kind: 'reconcilePublication',
        branchHeadSha: request.expectedHeadSha,
        pullRequest: { number: 7, headBranch: request.remoteBranch, headSha: request.expectedHeadSha, baseBranch: request.expectedBaseBranch },
      };
  }
}

export type Responder = (request: TaskRequest, occurrence: number) => Answer | undefined;

/** A scripted environment: per-kind overrides fall back to the happy path. */
export function scripted(
  overrides: Partial<Record<TaskRequestKind, Responder>> = {},
  hooks: Partial<Pick<TaskEnvironment, 'eventsDuring' | 'whenIdle'>> = {},
): TaskEnvironment {
  const seen = new Map<TaskRequestKind, number>();
  return {
    respond(request) {
      const occurrence = (seen.get(request.kind) ?? 0) + 1;
      seen.set(request.kind, occurrence);
      return overrides[request.kind]?.(request, occurrence) ?? happyAnswer(request);
    },
    eventsDuring: hooks.eventsDuring ?? (() => []),
    whenIdle:
      hooks.whenIdle ??
      ((_state, timers) => {
        throw new Error(`test environment has no idle script (timers: ${timers.join(',')})`);
      }),
  };
}

export function requests(commands: readonly TaskCommand[]): TaskRequest[] {
  return commands.flatMap((c) => (c.type === 'request' ? [c.request] : []));
}

export function requestKinds(commands: readonly TaskCommand[]): TaskRequestKind[] {
  return requests(commands).map((r) => r.kind);
}

export function effects(commands: readonly TaskCommand[]): TaskEffect[] {
  return commands.flatMap((c) => (c.type === 'effect' ? [c.effect] : []));
}

export function effectsOf<K extends TaskEffect['kind']>(
  commands: readonly TaskCommand[],
  kind: K,
): Extract<TaskEffect, { kind: K }>[] {
  return effects(commands).filter((e): e is Extract<TaskEffect, { kind: K }> => e.kind === kind);
}

export function indexOfCommand(commands: readonly TaskCommand[], match: (c: TaskCommand) => boolean): number {
  return commands.findIndex(match);
}
