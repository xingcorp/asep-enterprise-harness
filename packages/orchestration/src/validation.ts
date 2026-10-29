// Input rules applied before a workflow starts: the orchestration policy loader
// and the workflow-input mapping reject an input that breaks them. The core
// enforces the rules that matter for safety on its own as well, so a rejected
// input is never silently corrected.

import { MAX_USD, isExactUsd } from './budget.js';
import { FAILURE_CLASSES, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import type { RunCoreInput } from './run-core.js';
import type { OrchestrationPolicy, TaskCoreInput } from './types.js';

const AMOUNT = `must be an amount exact in micro-USD and at most ${MAX_USD}`;
const POSITIVE = `must be a positive amount exact in micro-USD and at most ${MAX_USD}`;

function amountErrors(errors: string[], path: string, usd: number, positive: boolean): void {
  if (!isExactUsd(usd) || (positive && usd <= 0)) errors.push(`${path}: ${positive ? POSITIVE : AMOUNT}`);
}

function softCapErrors(errors: string[], path: string, softUsd: number, capPath: string, capUsd: number): void {
  if (!isExactUsd(softUsd) || softUsd > capUsd) errors.push(`${path}: must be an amount exact in micro-USD, at most ${capPath}`);
}

/** Why the policy is invalid, or an empty list. */
export function orchestrationPolicyErrors(policy: OrchestrationPolicy): string[] {
  const errors: string[] = [];
  for (const failureClass of policy.replaceableFailureClasses) {
    if (!FAILURE_CLASSES.includes(failureClass)) {
      errors.push(`replaceableFailureClasses: unknown failure class ${failureClass}`);
    } else if (NEVER_REPLACEABLE_FAILURE_CLASSES.includes(failureClass)) {
      errors.push(`replaceableFailureClasses: ${failureClass} is never replaceable`);
    }
  }
  const max = policy.maxBudgetExtensionUsd;
  if (max !== null && (!isExactUsd(max) || max <= 0)) {
    errors.push(`maxBudgetExtensionUsd: must be unset or a positive amount exact in micro-USD and at most ${MAX_USD}`);
  }
  if (!Number.isInteger(policy.agentKillGraceSeconds) || policy.agentKillGraceSeconds < 0) {
    errors.push('agentKillGraceSeconds: must be a whole number of seconds, zero or more');
  }
  return errors;
}

/** Why the task input is invalid, or an empty list: every money amount must be exact and in range. */
export function taskInputErrors(input: TaskCoreInput): string[] {
  const errors: string[] = [];
  amountErrors(errors, 'attemptBudget.maxCostUsd', input.attemptBudget.maxCostUsd, true);
  amountErrors(errors, 'taskBudget.maxCostUsd', input.taskBudget.maxCostUsd, true);
  softCapErrors(errors, 'taskBudget.softCostUsd', input.taskBudget.softCostUsd, 'taskBudget.maxCostUsd', input.taskBudget.maxCostUsd);
  amountErrors(errors, 'verificationReserve.costUsd', input.verificationReserve.costUsd, false);
  amountErrors(errors, 'runRemainingUsd', input.runRemainingUsd, false);
  for (const error of orchestrationPolicyErrors(input.policy)) errors.push(`policy.${error}`);
  return errors;
}

/** Why the run input is invalid, or an empty list. */
export function runInputErrors(input: RunCoreInput): string[] {
  const errors: string[] = [];
  amountErrors(errors, 'runBudget.maxCostUsd', input.runBudget.maxCostUsd, true);
  softCapErrors(errors, 'runBudget.softCostUsd', input.runBudget.softCostUsd, 'runBudget.maxCostUsd', input.runBudget.maxCostUsd);
  const fixed = input.fixedTasks;
  if (fixed !== null && (new Set(fixed).size !== fixed.length || fixed.length > input.runBudget.maxTasks)) {
    errors.push('fixedTasks: must list each task once, at most runBudget.maxTasks of them');
  }
  return errors;
}
