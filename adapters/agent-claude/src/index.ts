// @asep/agent-claude — Claude coding provider behind the CodingAgentProvider
// port (S6).
//
// PUBLIC SURFACE. A credential-free coding agent adapter: it launches a pinned
// Claude CLI speaking stream-JSON, records the raw event stream as an immutable
// artifact, parses it fail-closed, and returns only an untrusted
// AgentAttemptObservation — no harness-owned facts (attemptId/resultSha/
// changedFiles) ever come from the provider.

export type { ClaudeEvent, ParsedStream } from './event-parser.js';
export { parseEventLine, parseStream, MalformedEventError } from './event-parser.js';

export type { ClaudeProviderConfig, AgentSandboxConfig } from './claude-provider.js';
export {
  ClaudeCodingProvider,
  // E8/G3 (disp. P2-FINAL-HIGH-002): isolation is the DEFAULT. Constructing an
  // unsandboxed provider requires stating this waiver literally, so a forgotten
  // config cannot silently downgrade the agent to host execution.
  HOST_EXECUTION_WAIVER, AgentIsolationRequiredError,
} from './claude-provider.js';
