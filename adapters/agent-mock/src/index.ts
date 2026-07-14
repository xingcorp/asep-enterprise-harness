import type { CodingAgentProvider } from '@asep/ports';
import type { AgentAttemptResult, AttemptId, ContextPack, WorkOrder } from '@asep/contracts';

export class MockCodingAgentProvider implements CodingAgentProvider {
  readonly providerId = 'mock-agent';

  async execute(order: WorkOrder, context: ContextPack): Promise<AgentAttemptResult> {
    return {
      attemptId: `attempt-${order.id}` as AttemptId,
      status: 'SUCCEEDED',
      startSha: order.baseSha,
      resultSha: order.baseSha,
      changedFiles: [],
      summary: `Mock execution for ${context.objective}`,
      knownLimitations: ['No repository mutation; replace this adapter with Claude/Codex/OpenHands.'],
      artifactIds: [],
      usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 1 }
    };
  }

  async cancel(_attemptId: AttemptId): Promise<void> {}
}
