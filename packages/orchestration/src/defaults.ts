// Core defaults. The orchestration policy file loaded by the worker supplies the
// real values; these are the documented defaults it starts from.

import type { FailureClass, OrchestrationPolicy } from './types.js';

// A Record forces every class to be listed exactly once; the taxonomy parity
// test pins the list to `policies/failure-taxonomy.yaml`.
const FAILURE_CLASS_SET: Readonly<Record<FailureClass, true>> = {
  baseline: true,
  'pre-existing': true,
  'introduced-regression': true,
  environment: true,
  'flaky-test': true,
  provider: true,
  'quota-rate-limit': true,
  context: true,
  'skill-routing': true,
  tool: true,
  'policy-violation': true,
  'agent-loop-stall': true,
  'false-completion': true,
  'review-escape': true,
  'duplicate-side-effect': true,
  'artifact-loss': true,
  'workflow-recovery-failure': true,
};

export const FAILURE_CLASSES: readonly FailureClass[] = Object.keys(FAILURE_CLASS_SET) as FailureClass[];

/**
 * Never followed by a new attempt, whatever a policy says: the attempt broke a
 * rule, claimed work it did not do, or applied an effect twice.
 */
export const NEVER_REPLACEABLE_FAILURE_CLASSES: readonly FailureClass[] = [
  'policy-violation',
  'false-completion',
  'duplicate-side-effect',
];

export const DEFAULT_ORCHESTRATION_POLICY: OrchestrationPolicy = {
  // Failures a fresh attempt in a fresh worktree can plausibly recover from.
  // The never-replaceable classes above are never listed.
  replaceableFailureClasses: [
    'environment',
    'provider',
    'quota-rate-limit',
    'tool',
    'agent-loop-stall',
    'artifact-loss',
    'workflow-recovery-failure',
  ],
  // Policy data with no default in code: while it is unset, no budget-extension
  // approval is offered and a task-cap shortfall ends the task BUDGET_EXHAUSTED.
  maxBudgetExtensionUsd: null,
};
