import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTaskKernel } from './index.js';
import { MockCodingAgentProvider } from '@asep/agent-mock';
import type { ContextPack, RunId, TaskId, VerificationResult, WorkOrder } from '@asep/contracts';

const order: WorkOrder = {
  id: 'task-1' as TaskId, runId: 'run-1' as RunId, objective: 'test', requirementIds: [],
  baseSha: 'abc', allowedPaths: ['src/**'], forbiddenChanges: [], architectureInvariants: [],
  acceptanceCheckIds: ['check'], risk: 'R0', requiredSkills: [],
  budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 }
};

test('accepts only after mandatory verification', async () => {
  const result = await executeTaskKernel({
    order,
    implementer: new MockCodingAgentProvider(),
    activities: {
      async buildContext(): Promise<ContextPack> { return { id:'c', generatedAt:'', baseSha:'abc', objective:'test', specificationExcerpt:'', architectureInvariants:[], relevantFiles:[], relevantSymbols:[], priorEvidenceIds:[], skills:[], allowedTools:[], deniedOperations:[], hash:'h' }; },
      async verify(): Promise<VerificationResult> { return { planId:'p', verdict:'PASS', checks:[], evidenceArtifactIds:[] }; },
      async persistCheckpoint(): Promise<void> {}
    }
  });
  assert.equal(result.accepted, true);
});
