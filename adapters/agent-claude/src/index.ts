// @asep/agent-claude — Claude coding provider behind the CodingAgentProvider
// port (S6).
//
// PUBLIC SURFACE. A credential-free coding agent adapter: it runs the pinned
// Claude CLI in a hardened container whose only route out is a per-attempt
// egress proxy to the model API, records the raw event stream as an immutable
// artifact, parses it fail-closed, and returns only an untrusted
// AgentAttemptObservation — no harness-owned facts (attemptId/resultSha/
// changedFiles) ever come from the provider. There is no host-execution mode.

export type {
  ClaudeEvent, ClaudeInit, ClaudeResult, ParsedStream,
} from './event-parser.js';
export {
  parseEventLine, parseStream, ClaudeStreamParser, MalformedEventError,
} from './event-parser.js';

export type { ToolWord, ClaudeToolGrant } from './tool-policy.js';
export { TOOL_VOCABULARY, claudeToolGrant, ToolPolicyError } from './tool-policy.js';

export type { ModelCredential, ModelCredentialProvider } from './model-credentials.js';
export {
  FileModelCredentialProvider, ModelCredentialError, DEFAULT_MODEL_BASE_URL,
  parseModelBaseUrl, redactSecrets,
} from './model-credentials.js';

export type {
  ClaudeProviderConfig, AgentSandboxConfig, AgentLifecycleEvent, AgentLifecyclePhase,
} from './claude-provider.js';
export {
  ClaudeCodingProvider, AgentConfigError, AGENT_STOP_BOUND_MS, AGENT_REMOVAL_BOUND_MS, agentRemovalDeadline,
  buildClaudeArgs, buildPrompt, buildAgentRunArgs, buildProxyRunArgs, initViolation,
  MODEL_KEY_PLACEHOLDER, EGRESS_ALLOWLIST, AGENT_NETWORK_FLAGS, agentNetworkIsolationGap,
} from './claude-provider.js';
