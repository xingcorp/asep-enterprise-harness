// Orchestration policy loader.
//
// policies/orchestration-policy.yaml holds the defaults the control plane
// resolves into each task workflow's input at submit time; the workflow never
// reads a policy file. This module parses the file into a closed shape and
// refuses a policy no workflow may be given:
//
//   - one that lists a never-replaceable failure class as replaceable: an
//     attempt that broke a rule, claimed work it did not do or applied an effect
//     twice is never followed by a new attempt, whatever a policy says;
//   - a kill grace other than the agent adapter's stop bound, the only tolerance
//     on an attempt's measured wall-clock;
//   - an attempt wall-clock budget longer than the agent's egress proxy can live.
//
// The two bounds are the agent adapter's exported constants. This package
// imports no adapter, so the worker composition root passes them in.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Budget } from '@asep/contracts';
import { failureClasses, type FailureClass } from './failure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = join(HERE, '..', '..', '..', 'policies', 'orchestration-policy.yaml');

/**
 * Never replaceable: the attempt broke a rule, claimed work it did not do, or applied an effect twice. The
 * decision core holds the same three and ignores them in any policy; this loader refuses a file that lists one.
 */
export const NEVER_REPLACEABLE_FAILURE_CLASSES: readonly FailureClass[] = [
  'policy-violation',
  'false-completion',
  'duplicate-side-effect',
];

/** The agent adapter's bounds, passed by the composition root that holds the adapter. */
export interface OrchestrationPolicyBounds {
  /** The adapter's stop path, from its stop signal to the container's proven removal (AGENT_STOP_BOUND_MS). */
  readonly agentStopBoundMs: number;
  /** The longest attempt the egress proxy outlives: its maximum lifetime less its expiry grace. */
  readonly maxAttemptWallClockMs: number;
}

export interface BoundedDefault {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface OrchestrationPolicyDoc {
  readonly apiVersion: 'asep.orchestration-policy/v1';
  readonly version: string;
  readonly replaceableFailureClasses: readonly FailureClass[];
  /** Null: budget-extension approval is unavailable. */
  readonly maxBudgetExtensionUsd: number | null;
  readonly agentKillGraceSeconds: number;
  readonly attemptBudgetDefaults: Budget;
  readonly taskBudgetDefaults: {
    readonly maxAttempts: number;
    readonly maxCostUsd: number;
    readonly softCostUsd: number;
    readonly maxWallClockMinutes: number;
  };
  readonly leaseTtlSeconds: number;
  readonly heartbeatIntervalSeconds: number;
  readonly heartbeatTimeoutSeconds: number;
  readonly leaseRenewalSeconds: number;
  readonly approvalTtlSeconds: BoundedDefault;
  readonly maxPauseHours: BoundedDefault;
  readonly relayIntervalSeconds: number;
}

export class OrchestrationPolicyError extends Error {
  constructor(reason: string) {
    super(`orchestration policy: ${reason}`);
    this.name = 'OrchestrationPolicyError';
  }
}

/** The largest money amount anywhere in orchestration, in USD (the decision core's bound). */
const MAX_USD = 100_000_000;

type Mapping = Readonly<Record<string, unknown>>;

function mapping(value: unknown, at: string): Mapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new OrchestrationPolicyError(`${at} is not a mapping`);
  return value as Mapping;
}

function closed(m: Mapping, keys: readonly string[], at: string): void {
  for (const key of Object.keys(m)) {
    if (!keys.includes(key)) throw new OrchestrationPolicyError(`unknown key "${key}" in ${at}`);
  }
  for (const key of keys) {
    if (!(key in m)) throw new OrchestrationPolicyError(`${at} has no ${key}`);
  }
}

function integer(m: Mapping, key: string, at: string, min: number): number {
  const v = m[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) {
    throw new OrchestrationPolicyError(`${at}${key} is not an integer of at least ${min}`);
  }
  return v;
}

/** A money amount exactly representable in micro-USD, positive and within the bound. */
function money(m: Mapping, key: string, at: string): number {
  const v = m[key];
  const exact = typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(Math.round(v * 1e6))
    && Math.round(v * 1e6) / 1e6 === v;
  if (!exact || (v as number) <= 0 || (v as number) > MAX_USD) {
    throw new OrchestrationPolicyError(`${at}${key} is not a positive amount of whole micro-USD up to ${MAX_USD} USD`);
  }
  return v as number;
}

function bounded(m: Mapping, key: string, min: number): BoundedDefault {
  const b = mapping(m[key], key);
  closed(b, ['default', 'min', 'max'], key);
  const out = { default: integer(b, 'default', `${key}.`, min), min: integer(b, 'min', `${key}.`, min), max: integer(b, 'max', `${key}.`, min) };
  if (!(out.min <= out.default && out.default <= out.max)) throw new OrchestrationPolicyError(`${key} needs min <= default <= max`);
  return out;
}

const TOP_KEYS = [
  'apiVersion', 'version', 'replaceableFailureClasses', 'maxBudgetExtensionUsd', 'agentKillGraceSeconds',
  'attemptBudgetDefaults', 'taskBudgetDefaults', 'leaseTtlSeconds', 'heartbeatIntervalSeconds',
  'heartbeatTimeoutSeconds', 'leaseRenewalSeconds', 'approvalTtlSeconds', 'maxPauseHours', 'relayIntervalSeconds',
] as const;

/** Parse a policy file's text and refuse a policy no workflow may be given (file header). */
export function parseOrchestrationPolicy(text: string, bounds: OrchestrationPolicyBounds): OrchestrationPolicyDoc {
  const doc = mapping(parseYaml(text) as unknown, 'the policy document');
  closed(doc, TOP_KEYS, 'the policy document');
  if (doc['apiVersion'] !== 'asep.orchestration-policy/v1') throw new OrchestrationPolicyError('apiVersion is not asep.orchestration-policy/v1');
  if (typeof doc['version'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc['version'])) throw new OrchestrationPolicyError('version is not a semantic version');

  const listed = doc['replaceableFailureClasses'];
  if (!Array.isArray(listed)) throw new OrchestrationPolicyError('replaceableFailureClasses is not a list');
  const known = failureClasses();
  const replaceable: FailureClass[] = [];
  for (const c of listed as unknown[]) {
    if (typeof c !== 'string' || !known.includes(c as FailureClass)) throw new OrchestrationPolicyError(`unknown failure class "${String(c)}"`);
    if (NEVER_REPLACEABLE_FAILURE_CLASSES.includes(c as FailureClass)) {
      throw new OrchestrationPolicyError(`failure class "${c}" is never replaceable and may not be listed in replaceableFailureClasses`);
    }
    if (replaceable.includes(c as FailureClass)) throw new OrchestrationPolicyError(`failure class "${c}" is listed twice`);
    replaceable.push(c as FailureClass);
  }

  const maxBudgetExtensionUsd = doc['maxBudgetExtensionUsd'] === null ? null : money(doc, 'maxBudgetExtensionUsd', '');

  const agentKillGraceSeconds = integer(doc, 'agentKillGraceSeconds', '', 0);
  if (agentKillGraceSeconds * 1000 !== bounds.agentStopBoundMs) {
    throw new OrchestrationPolicyError(
      `agentKillGraceSeconds ${agentKillGraceSeconds} is not the agent adapter's stop bound of ${bounds.agentStopBoundMs / 1000} s`,
    );
  }

  const attempt = mapping(doc['attemptBudgetDefaults'], 'attemptBudgetDefaults');
  closed(attempt, ['maxTurns', 'maxToolCalls', 'maxCostUsd', 'maxWallClockMinutes'], 'attemptBudgetDefaults');
  const attemptBudgetDefaults: Budget = {
    maxTurns: integer(attempt, 'maxTurns', 'attemptBudgetDefaults.', 1),
    maxToolCalls: integer(attempt, 'maxToolCalls', 'attemptBudgetDefaults.', 1),
    maxCostUsd: money(attempt, 'maxCostUsd', 'attemptBudgetDefaults.'),
    maxWallClockMinutes: integer(attempt, 'maxWallClockMinutes', 'attemptBudgetDefaults.', 1),
  };
  if (attemptBudgetDefaults.maxWallClockMinutes * 60_000 > bounds.maxAttemptWallClockMs) {
    throw new OrchestrationPolicyError(
      `attemptBudgetDefaults.maxWallClockMinutes ${attemptBudgetDefaults.maxWallClockMinutes} exceeds the ` +
        `${bounds.maxAttemptWallClockMs} ms an attempt's egress proxy outlives`,
    );
  }

  const task = mapping(doc['taskBudgetDefaults'], 'taskBudgetDefaults');
  closed(task, ['maxAttempts', 'maxCostUsd', 'softCostUsd', 'maxWallClockMinutes'], 'taskBudgetDefaults');
  const taskBudgetDefaults = {
    maxAttempts: integer(task, 'maxAttempts', 'taskBudgetDefaults.', 1),
    maxCostUsd: money(task, 'maxCostUsd', 'taskBudgetDefaults.'),
    softCostUsd: money(task, 'softCostUsd', 'taskBudgetDefaults.'),
    maxWallClockMinutes: integer(task, 'maxWallClockMinutes', 'taskBudgetDefaults.', 1),
  };
  if (taskBudgetDefaults.softCostUsd > taskBudgetDefaults.maxCostUsd) throw new OrchestrationPolicyError('taskBudgetDefaults.softCostUsd exceeds maxCostUsd');

  const leaseTtlSeconds = integer(doc, 'leaseTtlSeconds', '', 1);
  const heartbeatIntervalSeconds = integer(doc, 'heartbeatIntervalSeconds', '', 1);
  const heartbeatTimeoutSeconds = integer(doc, 'heartbeatTimeoutSeconds', '', 1);
  const leaseRenewalSeconds = integer(doc, 'leaseRenewalSeconds', '', 1);
  if (!(heartbeatIntervalSeconds < heartbeatTimeoutSeconds && heartbeatTimeoutSeconds < leaseTtlSeconds && leaseRenewalSeconds < leaseTtlSeconds)) {
    throw new OrchestrationPolicyError('heartbeatIntervalSeconds < heartbeatTimeoutSeconds < leaseTtlSeconds, and leaseRenewalSeconds < leaseTtlSeconds');
  }

  return {
    apiVersion: 'asep.orchestration-policy/v1',
    version: doc['version'],
    replaceableFailureClasses: replaceable,
    maxBudgetExtensionUsd,
    agentKillGraceSeconds,
    attemptBudgetDefaults,
    taskBudgetDefaults,
    leaseTtlSeconds,
    heartbeatIntervalSeconds,
    heartbeatTimeoutSeconds,
    leaseRenewalSeconds,
    approvalTtlSeconds: bounded(doc, 'approvalTtlSeconds', 1),
    maxPauseHours: bounded(doc, 'maxPauseHours', 1),
    relayIntervalSeconds: integer(doc, 'relayIntervalSeconds', '', 1),
  };
}

/** Load and check the committed policies/orchestration-policy.yaml. */
export function loadOrchestrationPolicy(bounds: OrchestrationPolicyBounds): OrchestrationPolicyDoc {
  return parseOrchestrationPolicy(readFileSync(POLICY_FILE, 'utf8'), bounds);
}
