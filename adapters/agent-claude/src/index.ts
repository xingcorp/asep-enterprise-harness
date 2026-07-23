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

export type { ClaudeProviderConfig } from './claude-provider.js';
export { ClaudeCodingProvider } from './claude-provider.js';
