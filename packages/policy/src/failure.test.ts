import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  failureInfo,
  failureClasses,
  type FailureClass,
  type FailureSignals,
} from './failure.js';

// Table-driven: one signal set per class, asserting the deterministic verdict.
const CASES: { name: string; signals: FailureSignals; expect: FailureClass }[] = [
  { name: 'success', signals: { succeeded: true }, expect: 'baseline' },
  { name: 'pre-existing', signals: { failingAtBaseSha: true }, expect: 'pre-existing' },
  { name: 'flaky', signals: { nonDeterministicAcrossReruns: true }, expect: 'flaky-test' },
  { name: 'quota', signals: { quotaOrRateLimited: true }, expect: 'quota-rate-limit' },
  { name: 'provider', signals: { providerError: true }, expect: 'provider' },
  { name: 'environment', signals: { environmentFault: true }, expect: 'environment' },
  { name: 'artifact', signals: { artifactMissing: true }, expect: 'artifact-loss' },
  { name: 'recovery', signals: { workflowRecoveryFailed: true }, expect: 'workflow-recovery-failure' },
  { name: 'duplicate', signals: { duplicateSideEffect: true }, expect: 'duplicate-side-effect' },
  { name: 'tool', signals: { toolFault: true }, expect: 'tool' },
  { name: 'skill', signals: { wrongSkillActivated: true }, expect: 'skill-routing' },
  { name: 'context', signals: { insufficientContext: true }, expect: 'context' },
  { name: 'policy', signals: { policyViolation: true }, expect: 'policy-violation' },
  { name: 'false-completion', signals: { declaredCompleteButGatesRed: true }, expect: 'false-completion' },
  { name: 'review-escape', signals: { escapedDefect: true }, expect: 'review-escape' },
  { name: 'stall', signals: { loopedOrStalled: true }, expect: 'agent-loop-stall' },
  { name: 'regression', signals: { introducedRegression: true }, expect: 'introduced-regression' },
];

test('every failure class is reachable from a signal set', () => {
  for (const c of CASES) {
    assert.equal(classifyFailure(c.signals), c.expect, c.name);
  }
});

test('exactly 17 failure classes exist', () => {
  assert.equal(failureClasses().length, 17);
});

test('environment faults are diagnosed before agent attribution', () => {
  // Both an environment fault AND an introduced regression signalled: the
  // environment fault must win so a flaky sandbox is never charged to the agent.
  const verdict = classifyFailure({ environmentFault: true, introducedRegression: true });
  assert.equal(verdict, 'environment');
  assert.equal(failureInfo(verdict).countsAgainstAgent, false);
});

test('agent-fault classes count against the agent', () => {
  for (const cls of ['introduced-regression', 'policy-violation', 'false-completion', 'review-escape', 'agent-loop-stall'] as FailureClass[]) {
    assert.equal(failureInfo(cls).countsAgainstAgent, true, cls);
  }
});

test('non-agent classes do not count against the agent', () => {
  for (const cls of ['pre-existing', 'environment', 'flaky-test', 'provider', 'quota-rate-limit'] as FailureClass[]) {
    assert.equal(failureInfo(cls).countsAgainstAgent, false, cls);
  }
});

test('a failed attempt with no signal throws (no silent pass)', () => {
  assert.throws(() => classifyFailure({}), /no signal matched/);
});
