import type {
  CodingAgentProvider,
  AgentExecuteRequest,
  AgentAttemptObservation,
} from '@asep/ports';

// Mock coding provider for CI and the vertical-slice driver. It performs NO
// repository mutation: it returns an UNTRUSTED self-report only (v2 contract,
// disp. P2-PLAN-HIGH-002). Harness-owned facts (resultSha, changedFiles) are
// derived by the trusted GitChangeInspector/GitCommitter after the agent exits,
// so the mock deliberately cannot influence them. Replace with the real Claude
// adapter in S6.
export class MockCodingAgentProvider implements CodingAgentProvider {
  readonly providerId = 'mock-agent';

  async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
    // Honour request-scoped cancellation immediately if already aborted.
    if (req.signal.aborted) {
      return {
        status: 'BLOCKED',
        summary: 'Aborted before start.',
        knownLimitations: ['Request was cancelled via AbortSignal.'],
        usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 0 },
        eventArtifactRefs: [],
      };
    }
    return {
      status: 'AGENT_DONE',
      summary: `Mock agent completed for work-order ref ${req.workOrderRef.artifactId}`,
      knownLimitations: [
        'No repository mutation; replace this adapter with the Claude coding provider (S6).',
      ],
      providerSessionId: `mock-session-${req.attemptId}`,
      usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 1 },
      eventArtifactRefs: [],
    };
  }
}
