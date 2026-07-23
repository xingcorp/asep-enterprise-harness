// execute-task pipeline tests (exit criteria B1, B4, plus trust rules).
//
// Uses in-test fakes for the CodingAgentProvider and GitChangeInspector ports —
// the use case composes only against @asep/ports, so no real adapter is needed.
// Proves:
//   - a DEFERRED risk stops at admission, before the agent is ever invoked
//     (no workspace/agent/push side effect);
//   - a non-AGENT_DONE observation stops before inspection;
//   - resultSha/changedFiles come from the trusted inspector, never the
//     untrusted provider observation;
//   - an agent that created a commit/ref or touched .git is stopped at inspect
//     (harness owns commit identity);
//   - each step is independently callable (Temporal-shaped composition, B4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  TenantScope,
  AttemptId,
  ArtifactRef,
  Budget,
  OrganizationId,
  ProjectId,
  WorkspaceId,
} from '@asep/contracts';
import type {
  CodingAgentProvider,
  AgentExecuteRequest,
  AgentAttemptObservation,
  GitChangeInspector,
  GitChangeObservation,
  WorkspaceCapability,
  ToolPolicyProfile,
} from '@asep/ports';
import {
  executeTask,
  agentStep,
  inspectStep,
  admissionStep,
} from './execute-task.js';

const scope: TenantScope = {
  organizationId: 'org-1' as OrganizationId,
  projectId: 'proj-1' as ProjectId,
};
const workspace: WorkspaceCapability = {
  workspaceId: 'ws-1' as WorkspaceId,
  leaseId: 'lease-1',
};
const budget: Budget = {
  maxTurns: 10,
  maxToolCalls: 100,
  maxCostUsd: 5,
  maxWallClockMinutes: 15,
};
const toolPolicy: ToolPolicyProfile = {
  allowedTools: ['read', 'write', 'bash'],
  disallowedTools: ['network'],
  networkProfile: 'no-network',
};
const workOrderRef: ArtifactRef = { artifactId: 'art-wo' as never, sha256: 'a'.repeat(64), kind: 'work-order' };
const contextPackRef: ArtifactRef = { artifactId: 'art-cp' as never, sha256: 'b'.repeat(64), kind: 'context-pack' };

function fakeProvider(observation: AgentAttemptObservation): CodingAgentProvider & { calls: AgentExecuteRequest[] } {
  const calls: AgentExecuteRequest[] = [];
  return {
    providerId: 'fake',
    calls,
    async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
      calls.push(req);
      return observation;
    },
  };
}

function fakeInspector(change: GitChangeObservation): GitChangeInspector {
  return {
    async inspect(): Promise<GitChangeObservation> {
      return change;
    },
  };
}

const okObservation: AgentAttemptObservation = {
  status: 'AGENT_DONE',
  summary: 'done',
  knownLimitations: [],
  usage: { inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1 },
  eventArtifactRefs: [],
};

const cleanChange: GitChangeObservation = {
  headSha: 'c'.repeat(40),
  changedFiles: ['src/foo.ts'],
  createdRefs: [],
  touchedGitDir: false,
  diff: { artifactId: 'art-diff' as never, sha256: 'd'.repeat(64), kind: 'git-diff' },
};

function agentInput(provider: CodingAgentProvider) {
  return {
    provider,
    attemptId: 'attempt-1' as AttemptId,
    workOrderRef,
    contextPackRef,
    workspace,
    budget,
    toolPolicy,
    signal: new AbortController().signal,
  };
}

test('DEFERRED risk stops at admission — agent is NEVER invoked (no side effect)', async () => {
  const provider = fakeProvider(okObservation);
  const result = await executeTask({
    scope,
    risk: 'R3',
    agent: agentInput(provider),
    inspector: fakeInspector(cleanChange),
  });
  assert.equal(result.admitted, false);
  assert.equal(result.stoppedAt, 'admission');
  assert.equal(result.reachedInspection, false);
  // The gate must fail closed BEFORE the provider is touched.
  assert.equal(provider.calls.length, 0, 'provider must not be invoked for a deferred risk');
});

test('R0 happy path reaches inspection and derives change from the trusted inspector', async () => {
  const provider = fakeProvider(okObservation);
  const result = await executeTask({
    scope,
    risk: 'R0',
    agent: agentInput(provider),
    inspector: fakeInspector(cleanChange),
  });
  assert.equal(result.admitted, true);
  assert.equal(result.stoppedAt, 'complete');
  assert.equal(result.reachedInspection, true);
  assert.equal(provider.calls.length, 1);
  // resultSha/changedFiles are the INSPECTOR's, not the provider's self-report.
  assert.equal(result.change?.headSha, cleanChange.headSha);
  assert.deepEqual(result.change?.changedFiles, ['src/foo.ts']);
});

test('the provider observation carries no resultSha/changedFiles/attemptId (untrusted shape)', async () => {
  const provider = fakeProvider(okObservation);
  const step = await agentStep(agentInput(provider));
  const obs = step.observation as unknown as Record<string, unknown>;
  assert.equal('resultSha' in obs, false);
  assert.equal('changedFiles' in obs, false);
  assert.equal('attemptId' in obs, false);
});

test('a non-AGENT_DONE observation stops before inspection', async () => {
  const provider = fakeProvider({ ...okObservation, status: 'BUDGET_EXHAUSTED' });
  const result = await executeTask({
    scope,
    risk: 'R0',
    agent: agentInput(provider),
    inspector: fakeInspector(cleanChange),
  });
  assert.equal(result.stoppedAt, 'agent');
  assert.equal(result.reachedInspection, false);
});

test('agent that created a ref is STOPPED at inspect (harness owns commit identity)', async () => {
  const dirtyChange: GitChangeObservation = { ...cleanChange, createdRefs: ['refs/heads/agent-made-this'] };
  const step = await inspectStep({ inspector: fakeInspector(dirtyChange), scope, workspace });
  assert.equal(step.status, 'STOP');
});

test('agent that touched .git is STOPPED at inspect', async () => {
  const dirtyChange: GitChangeObservation = { ...cleanChange, touchedGitDir: true };
  const step = await inspectStep({ inspector: fakeInspector(dirtyChange), scope, workspace });
  assert.equal(step.status, 'STOP');
});

test('steps are independently callable (Temporal-shaped composition, B4)', async () => {
  // Drive the pipeline one activity at a time, checkpointing between — proving
  // no worker-only coupling and that a durable workflow could resume mid-run.
  const admission = admissionStep('R0');
  assert.equal(admission.status, 'OK');

  const provider = fakeProvider(okObservation);
  const agent = await agentStep(agentInput(provider));
  assert.equal(agent.status, 'OK');

  const inspect = await inspectStep({ inspector: fakeInspector(cleanChange), scope, workspace });
  assert.equal(inspect.status, 'OK');
});

test('R1 is admitted but flags a required human independent review', async () => {
  const provider = fakeProvider(okObservation);
  const result = await executeTask({
    scope,
    risk: 'R1',
    agent: agentInput(provider),
    inspector: fakeInspector(cleanChange),
  });
  assert.equal(result.admitted, true);
  assert.equal(result.requiresHumanIndependentReview, true);
});
