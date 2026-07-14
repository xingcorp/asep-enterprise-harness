// Deterministic failure classification.
//
// The 17 failure classes are loaded from the canonical
// policies/failure-taxonomy.yaml (never hardcoded). The classifier maps a set
// of observed, deterministic signals to exactly one class using a fixed
// precedence order. Pure signal matching: no model call, no network.

import { loadFailureTaxonomy, type FailureTaxonomyDoc } from './policy-source.js';

export type FailureClass =
  | 'baseline'
  | 'pre-existing'
  | 'introduced-regression'
  | 'environment'
  | 'flaky-test'
  | 'provider'
  | 'quota-rate-limit'
  | 'context'
  | 'skill-routing'
  | 'tool'
  | 'policy-violation'
  | 'agent-loop-stall'
  | 'false-completion'
  | 'review-escape'
  | 'duplicate-side-effect'
  | 'artifact-loss'
  | 'workflow-recovery-failure';

export type Attribution = 'agent' | 'environment' | 'provider' | 'pre-existing' | 'harness';

export interface FailureClassInfo {
  readonly description: string;
  readonly attribution: Attribution;
  readonly retriable: boolean;
  readonly countsAgainstAgent: boolean;
}

/**
 * Deterministic signals observed by the trusted harness for one attempt.
 * All optional; the classifier applies a fixed precedence over whatever is set.
 */
export interface FailureSignals {
  readonly succeeded?: boolean;
  readonly failingAtBaseSha?: boolean;
  readonly nonDeterministicAcrossReruns?: boolean;
  readonly providerError?: boolean;
  readonly quotaOrRateLimited?: boolean;
  readonly environmentFault?: boolean;
  readonly toolFault?: boolean;
  readonly artifactMissing?: boolean;
  readonly workflowRecoveryFailed?: boolean;
  readonly duplicateSideEffect?: boolean;
  readonly wrongSkillActivated?: boolean;
  readonly insufficientContext?: boolean;
  readonly policyViolation?: boolean;
  readonly declaredCompleteButGatesRed?: boolean;
  readonly loopedOrStalled?: boolean;
  readonly escapedDefect?: boolean;
  readonly introducedRegression?: boolean;
}

const doc: FailureTaxonomyDoc = loadFailureTaxonomy();

// Fixed precedence: environment/provider/infra faults are diagnosed BEFORE agent
// attribution so a flaky environment is never charged to the agent. Agent-fault
// classes (policy-violation, false-completion) rank above generic regressions.
const PRECEDENCE: readonly { class: FailureClass; when: (s: FailureSignals) => boolean }[] = [
  { class: 'baseline', when: (s) => s.succeeded === true },
  { class: 'pre-existing', when: (s) => s.failingAtBaseSha === true },
  { class: 'flaky-test', when: (s) => s.nonDeterministicAcrossReruns === true },
  { class: 'quota-rate-limit', when: (s) => s.quotaOrRateLimited === true },
  { class: 'provider', when: (s) => s.providerError === true },
  { class: 'environment', when: (s) => s.environmentFault === true },
  { class: 'artifact-loss', when: (s) => s.artifactMissing === true },
  { class: 'workflow-recovery-failure', when: (s) => s.workflowRecoveryFailed === true },
  { class: 'duplicate-side-effect', when: (s) => s.duplicateSideEffect === true },
  { class: 'tool', when: (s) => s.toolFault === true },
  { class: 'skill-routing', when: (s) => s.wrongSkillActivated === true },
  { class: 'context', when: (s) => s.insufficientContext === true },
  { class: 'policy-violation', when: (s) => s.policyViolation === true },
  { class: 'false-completion', when: (s) => s.declaredCompleteButGatesRed === true },
  { class: 'review-escape', when: (s) => s.escapedDefect === true },
  { class: 'agent-loop-stall', when: (s) => s.loopedOrStalled === true },
  { class: 'introduced-regression', when: (s) => s.introducedRegression === true },
];

/**
 * Classify an attempt from its deterministic signals. Returns the first class in
 * precedence order whose predicate matches. When nothing matches, the result is
 * `introduced-regression` only if that signal was set; otherwise it is
 * `environment` is NOT assumed — an all-false signal set throws, because a
 * failure with no signal is a harness bug, not a silent pass.
 */
export function classifyFailure(signals: FailureSignals): FailureClass {
  for (const rule of PRECEDENCE) {
    if (rule.when(signals)) return rule.class;
  }
  throw new Error(
    'failure: no signal matched; a failed attempt must set at least one signal',
  );
}

/** Metadata for a failure class, from the canonical taxonomy. */
export function failureInfo(cls: FailureClass): FailureClassInfo {
  const entry = doc.classes[cls];
  if (!entry) throw new Error(`failure: unknown class "${cls}"`);
  return entry as FailureClassInfo;
}

/** All known failure classes (sorted, deterministic). */
export function failureClasses(): FailureClass[] {
  return Object.keys(doc.classes).sort() as FailureClass[];
}
