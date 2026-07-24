import test from 'node:test';
import assert from 'node:assert/strict';
import { runExecuteTask } from './index.js';
import { MockCodingAgentProvider } from '@asep/agent-mock';
import type { ExecuteTaskInput } from '@asep/application';
import type { GitChangeInspector, GitChangeObservation, WorkspaceCapability } from '@asep/ports';
import type {
  ArtifactRef, AttemptId, OrganizationId, ProjectId, TenantScope, WorkspaceId,
} from '@asep/contracts';

// Second thin caller (exit criterion B4): the worker drives the SAME
// application use case a Temporal activity would, with no worker-only coupling.
// The worker adds no domain decision, persistence or sequencing of its own — it
// only forwards a fully-composed request. If this passes with identical results
// to the application-layer test, the use case is proven transport-agnostic.

const scope: TenantScope = {
  organizationId: 'org-1' as OrganizationId,
  projectId: 'proj-1' as ProjectId,
};

const ref = (kind: string): ArtifactRef => ({
  artifactId: `artifact-${kind}` as ArtifactRef['artifactId'],
  sha256: 'f'.repeat(64),
  kind,
});

const workspace: WorkspaceCapability = {
  workspaceId: 'ws-1' as WorkspaceId,
  leaseId: 'lease-1',
};

// Trusted inspector — a clean worktree with no agent overstep.
const cleanInspector: GitChangeInspector = {
  async inspect(): Promise<GitChangeObservation> {
    return {
      headSha: 'deadbeef',
      changedFiles: ['src/x.ts'],
      createdRefs: [],
      touchedGitDir: false,
      baseSha: 'deadbeef',
      headMovedFromBase: false,
      diff: ref('git-diff'),
    };
  },
};

function input(
  risk: ExecuteTaskInput['risk'],
  provider: MockCodingAgentProvider = new MockCodingAgentProvider(),
): ExecuteTaskInput {
  return {
    scope,
    risk,
    agent: {
      provider,
      attemptId: 'attempt-1' as AttemptId,
      workOrderRef: ref('work-order'),
      contextPackRef: ref('context-pack'),
      workspace,
      budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 },
      toolPolicy: { allowedTools: ['read'], disallowedTools: ['bash'], networkProfile: 'no-network' },
      signal: new AbortController().signal,
    },
    inspector: cleanInspector,
  };
}

test('worker composition root drives the use case to completion for R0', async () => {
  const result = await runExecuteTask(input('R0'));
  assert.equal(result.admitted, true);
  assert.equal(result.reachedInspection, true);
  assert.equal(result.stoppedAt, 'complete');
  // The result SHA comes from the trusted inspector, never the provider.
  assert.equal(result.change?.headSha, 'deadbeef');
});

test('worker fails closed on a deferred risk BEFORE invoking the agent', async () => {
  let invoked = false;
  const spyProvider = new MockCodingAgentProvider();
  const orig = spyProvider.execute.bind(spyProvider);
  spyProvider.execute = async (req) => { invoked = true; return orig(req); };

  const result = await runExecuteTask(input('R3', spyProvider));

  assert.equal(result.admitted, false);
  assert.equal(result.stoppedAt, 'admission');
  assert.equal(invoked, false, 'agent must NOT run for a deferred risk');
});
