// The orchestration policy loader: the committed policy file, and the policies
// it refuses before any workflow can be given them.
//
//   - a policy that lists a never-replaceable failure class as replaceable;
//   - a kill grace other than the agent adapter's own stop bound, read here from
//     the adapter's exported constant, never a copied number;
//   - an attempt wall-clock budget the agent's egress proxy cannot outlive;
//   - anything else outside the file's closed shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_STOP_BOUND_MS, PROXY_EXPIRY_GRACE_MS, PROXY_MAX_LIFETIME_MS } from '@asep/agent-claude';
import {
  NEVER_REPLACEABLE_FAILURE_CLASSES,
  OrchestrationPolicyError,
  loadOrchestrationPolicy,
  parseOrchestrationPolicy,
  type OrchestrationPolicyBounds,
} from './orchestration-policy.js';
import { failureClasses } from './failure.js';

console.log('SUITE-ID: asep-suite:orchestration-policy-loader');

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_FILE = join(HERE, '..', '..', '..', 'policies', 'orchestration-policy.yaml');

/** What the worker composition root passes: the adapter's constants, as exported. */
const BOUNDS: OrchestrationPolicyBounds = {
  agentStopBoundMs: AGENT_STOP_BOUND_MS,
  maxAttemptWallClockMs: PROXY_MAX_LIFETIME_MS - PROXY_EXPIRY_GRACE_MS,
};

const committed = (): string => readFileSync(POLICY_FILE, 'utf8');

/** The committed file with one top-level line replaced. */
function withLine(key: string, value: string): string {
  const text = committed();
  const line = new RegExp(`^${key}:.*$`, 'm');
  assert.ok(line.test(text), `the committed policy has a ${key} line`);
  return text.replace(line, `${key}: ${value}`);
}

test('the committed policy loads with the adapter constants', () => {
  const policy = loadOrchestrationPolicy(BOUNDS);
  assert.equal(policy.agentKillGraceSeconds * 1000, AGENT_STOP_BOUND_MS);
  assert.deepEqual([...policy.replaceableFailureClasses], [
    'environment', 'provider', 'quota-rate-limit', 'tool', 'agent-loop-stall', 'artifact-loss', 'workflow-recovery-failure',
  ]);
  assert.equal(policy.maxBudgetExtensionUsd, null);
  assert.ok(policy.attemptBudgetDefaults.maxWallClockMinutes * 60_000 <= BOUNDS.maxAttemptWallClockMs);
  assert.ok(policy.leaseTtlSeconds * 1000 > policy.heartbeatTimeoutSeconds * 1000, 'a lease outlives a missed heartbeat');
  assert.ok(policy.approvalTtlSeconds.min <= policy.approvalTtlSeconds.default && policy.approvalTtlSeconds.default <= policy.approvalTtlSeconds.max);
  assert.ok(policy.maxPauseHours.min <= policy.maxPauseHours.default && policy.maxPauseHours.default <= policy.maxPauseHours.max);
});

test('the never-replaceable classes are the decision core\'s, and real failure classes', () => {
  assert.deepEqual([...NEVER_REPLACEABLE_FAILURE_CLASSES], ['policy-violation', 'false-completion', 'duplicate-side-effect']);
  // The decision core holds the same three: read from its source, since the policy package may not import it.
  const core = readFileSync(join(HERE, '..', '..', 'orchestration', 'src', 'defaults.ts'), 'utf8');
  const listed = /NEVER_REPLACEABLE_FAILURE_CLASSES: readonly FailureClass\[\] = \[([^\]]*)\]/.exec(core);
  assert.ok(listed, 'the core declares its never-replaceable classes');
  assert.deepEqual([...listed[1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]), [...NEVER_REPLACEABLE_FAILURE_CLASSES]);
  for (const c of NEVER_REPLACEABLE_FAILURE_CLASSES) assert.ok(failureClasses().includes(c), c);
});

for (const never of NEVER_REPLACEABLE_FAILURE_CLASSES) {
  test(`a policy listing ${never} as replaceable is refused`, () => {
    const text = withLine('replaceableFailureClasses', `[environment, ${never}]`);
    assert.throws(() => parseOrchestrationPolicy(text, BOUNDS), (err: unknown) =>
      err instanceof OrchestrationPolicyError && err.message.includes(never) && /never replaceable/.test(err.message));
  });
}

test('a replaceable class that is not a failure class is refused', () => {
  assert.throws(() => parseOrchestrationPolicy(withLine('replaceableFailureClasses', '[environment, flakey]'), BOUNDS),
    /unknown failure class "flakey"/);
});

test('a kill grace other than the adapter\'s stop bound is refused, either way', () => {
  const grace = AGENT_STOP_BOUND_MS / 1000;
  for (const wrong of [0, grace - 1, grace + 1]) {
    assert.throws(() => parseOrchestrationPolicy(withLine('agentKillGraceSeconds', String(wrong)), BOUNDS),
      (err: unknown) => err instanceof OrchestrationPolicyError && /agentKillGraceSeconds/.test(err.message), String(wrong));
  }
  // The bound comes from the caller: the same file is refused against another adapter's bound.
  assert.throws(() => parseOrchestrationPolicy(committed(), { ...BOUNDS, agentStopBoundMs: AGENT_STOP_BOUND_MS + 1000 }),
    /agentKillGraceSeconds/);
});

test('an attempt wall-clock budget the egress proxy cannot outlive is refused', () => {
  const limitMinutes = BOUNDS.maxAttemptWallClockMs / 60_000;
  const over = Math.floor(limitMinutes) + 1;
  const text = committed().replace(/^( {2}maxWallClockMinutes:).*$/m, `$1 ${over}`);
  assert.throws(() => parseOrchestrationPolicy(text, BOUNDS),
    (err: unknown) => err instanceof OrchestrationPolicyError && /maxWallClockMinutes/.test(err.message));
  const at = committed().replace(/^( {2}maxWallClockMinutes:).*$/m, `$1 ${Math.floor(limitMinutes)}`);
  assert.equal(parseOrchestrationPolicy(at, BOUNDS).attemptBudgetDefaults.maxWallClockMinutes, Math.floor(limitMinutes));
});

test('the file\'s shape is closed: an unknown key, a missing key or a wrong type is refused', () => {
  assert.throws(() => parseOrchestrationPolicy(`${committed()}\nsurprise: 1\n`, BOUNDS), /unknown key "surprise"/);
  assert.throws(() => parseOrchestrationPolicy(committed().replace(/^leaseTtlSeconds:.*\n/m, ''), BOUNDS), /leaseTtlSeconds/);
  assert.throws(() => parseOrchestrationPolicy(withLine('leaseTtlSeconds', '"600"'), BOUNDS), /leaseTtlSeconds/);
  assert.throws(() => parseOrchestrationPolicy(withLine('maxBudgetExtensionUsd', '0'), BOUNDS), /maxBudgetExtensionUsd/);
  assert.throws(() => parseOrchestrationPolicy(withLine('maxBudgetExtensionUsd', '0.0000001'), BOUNDS), /maxBudgetExtensionUsd/);
  assert.equal(parseOrchestrationPolicy(withLine('maxBudgetExtensionUsd', '25.5'), BOUNDS).maxBudgetExtensionUsd, 25.5);
  assert.throws(() => parseOrchestrationPolicy('- not\n- a mapping\n', BOUNDS), /mapping/);
});
