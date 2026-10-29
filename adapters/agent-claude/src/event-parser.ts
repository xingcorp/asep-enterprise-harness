// Claude CLI stream-json parser (exit criterion G2).
//
// `claude -p --verbose --output-format stream-json` writes one JSON object per
// line. The shapes below are the ones the pinned CLI actually emits — captured
// from the real binary, not invented:
//
//   {"type":"system","subtype":"init","session_id","model","tools":[…],
//    "mcp_servers":[…],"permissionMode","claude_code_version","cwd",…}
//   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",…}],…},
//    "session_id",…}
//   {"type":"user","message":{"content":[{"type":"tool_result",…}]},"session_id",…}
//   {"type":"result","subtype":"success"|"error_…","is_error","num_turns",
//    "duration_ms","total_cost_usd","usage":{"input_tokens","output_tokens",…},
//    "permission_denials":[…],"result"?,"session_id",…}
//
// We parse STRUCTURED events only — never scrape prose — and fail closed:
//   * a line that is not a JSON object, or whose `type` is not in the pinned
//     vocabulary, throws;
//   * `init` must be the first event, exactly once; `result` must be the last,
//     exactly once — a truncated stream can never be read as a completion;
//   * every event names the same session;
//   * a model fallback (the CLI switching away from the pinned model) is a
//     provenance violation and throws.
//
// Nothing the agent says about the repository is trusted: the harness derives
// resultSha / changedFiles itself after the agent exits.

export class MalformedEventError extends Error {
  constructor(reason: string, line: string) {
    // Truncate the offending line in the message so a huge blob can't flood logs.
    const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    super(`malformed Claude event: ${reason} — line: ${JSON.stringify(shown)}`);
    this.name = 'MalformedEventError';
  }
}

export interface ClaudeInit {
  readonly sessionId: string;
  readonly model: string;
  readonly cliVersion: string;
  readonly permissionMode: string;
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly cwd: string;
}

export interface ClaudeResult {
  readonly subtype: string;
  readonly isError: boolean;
  readonly text?: string;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly totalCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly permissionDenials: readonly string[];
}

export type ClaudeEvent =
  | { readonly type: 'init'; readonly init: ClaudeInit }
  | { readonly type: 'assistant'; readonly sessionId: string; readonly toolUses: readonly string[]; readonly text: string }
  | { readonly type: 'user'; readonly sessionId: string }
  | { readonly type: 'notice'; readonly sessionId?: string; readonly kind: string }
  | { readonly type: 'result'; readonly sessionId: string; readonly result: ClaudeResult };

// Top-level event types the pinned CLI emits that carry no authoritative fact.
// They are kept in the raw artifact and otherwise ignored.
const NOTICE_TYPES = new Set([
  'rate_limit_event', 'tool_progress', 'tool_use_summary', 'auth_status',
  'keep_alive', 'prompt_suggestion',
]);

// System subtypes that mean the CLI stopped using the pinned model.
const MODEL_FALLBACK = /^model_.*fallback$/;

// Assistant content blocks the CLI emits. Anything else is outside the pinned
// vocabulary.
const ASSISTANT_BLOCKS = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking']);

function asRecord(v: unknown, what: string, line: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new MalformedEventError(`${what} is not a JSON object`, line);
  }
  return v as Record<string, unknown>;
}

function num(o: Record<string, unknown>, k: string, line: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new MalformedEventError(`field '${k}' is not a finite number`, line);
  }
  return v;
}

function optNum(o: Record<string, unknown>, k: string, line: string): number {
  return o[k] === undefined || o[k] === null ? 0 : num(o, k, line);
}

function str(o: Record<string, unknown>, k: string, line: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new MalformedEventError(`field '${k}' is not a string`, line);
  return v;
}

function bool(o: Record<string, unknown>, k: string, line: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new MalformedEventError(`field '${k}' is not a boolean`, line);
  return v;
}

function strArray(o: Record<string, unknown>, k: string, line: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new MalformedEventError(`field '${k}' is not a string[]`, line);
  }
  return v as string[];
}

function parseInit(o: Record<string, unknown>, line: string): ClaudeInit {
  const servers = o['mcp_servers'];
  if (!Array.isArray(servers)) throw new MalformedEventError("field 'mcp_servers' is not an array", line);
  return {
    sessionId: str(o, 'session_id', line),
    model: str(o, 'model', line),
    cliVersion: str(o, 'claude_code_version', line),
    permissionMode: str(o, 'permissionMode', line),
    tools: strArray(o, 'tools', line),
    mcpServers: servers.map((s) => {
      if (typeof s === 'string') return s;
      const r = asRecord(s, 'mcp server', line);
      return str(r, 'name', line);
    }),
    cwd: str(o, 'cwd', line),
  };
}

function parseAssistant(o: Record<string, unknown>, line: string): Extract<ClaudeEvent, { type: 'assistant' }> {
  const message = asRecord(o['message'], "'message'", line);
  const content = message['content'];
  if (!Array.isArray(content)) throw new MalformedEventError("assistant 'message.content' is not an array", line);
  const toolUses: string[] = [];
  const text: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw, 'content block', line);
    const kind = str(block, 'type', line);
    if (!ASSISTANT_BLOCKS.has(kind)) {
      throw new MalformedEventError(`unknown assistant content block '${kind}'`, line);
    }
    if (kind === 'tool_use') toolUses.push(str(block, 'name', line));
    if (kind === 'text') text.push(str(block, 'text', line));
  }
  return { type: 'assistant', sessionId: str(o, 'session_id', line), toolUses, text: text.join('\n') };
}

function parseResult(o: Record<string, unknown>, line: string): ClaudeResult {
  const subtype = str(o, 'subtype', line);
  if (subtype !== 'success' && !subtype.startsWith('error_')) {
    throw new MalformedEventError(`unknown result subtype '${subtype}'`, line);
  }
  const usage = asRecord(o['usage'], "'usage'", line);
  const denialsRaw = o['permission_denials'] ?? [];
  if (!Array.isArray(denialsRaw)) {
    throw new MalformedEventError("field 'permission_denials' is not an array", line);
  }
  const permissionDenials = denialsRaw.map((d) => {
    const r = asRecord(d, 'permission denial', line);
    return str(r, 'tool_name', line);
  });
  const text = o['result'];
  if (text !== undefined && typeof text !== 'string') {
    throw new MalformedEventError("field 'result' is not a string", line);
  }
  return {
    subtype,
    isError: bool(o, 'is_error', line),
    ...(text !== undefined ? { text } : {}),
    numTurns: num(o, 'num_turns', line),
    durationMs: num(o, 'duration_ms', line),
    totalCostUsd: num(o, 'total_cost_usd', line),
    // Cache reads and writes are input the model processed; count them.
    inputTokens: num(usage, 'input_tokens', line) +
      optNum(usage, 'cache_creation_input_tokens', line) +
      optNum(usage, 'cache_read_input_tokens', line),
    outputTokens: num(usage, 'output_tokens', line),
    permissionDenials,
  };
}

/** Parse a single JSONL line into a typed event. Throws on anything unexpected. */
export function parseEventLine(line: string): ClaudeEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new MalformedEventError('not valid JSON', line);
  }
  const o = asRecord(raw, 'event', line);
  const type = o['type'];
  switch (type) {
    case 'system': {
      const subtype = str(o, 'subtype', line);
      if (subtype === 'init') return { type: 'init', init: parseInit(o, line) };
      if (MODEL_FALLBACK.test(subtype)) {
        throw new MalformedEventError(
          `the CLI fell back from the pinned model (system/${subtype}) — provenance lost`, line,
        );
      }
      return { type: 'notice', sessionId: str(o, 'session_id', line), kind: `system/${subtype}` };
    }
    case 'assistant':
      return parseAssistant(o, line);
    case 'user':
      asRecord(o['message'], "'message'", line);
      return { type: 'user', sessionId: str(o, 'session_id', line) };
    case 'result':
      return { type: 'result', sessionId: str(o, 'session_id', line), result: parseResult(o, line) };
    default:
      if (typeof type === 'string' && NOTICE_TYPES.has(type)) {
        const sid = o['session_id'];
        return typeof sid === 'string' ? { type: 'notice', sessionId: sid, kind: type } : { type: 'notice', kind: type };
      }
      throw new MalformedEventError(`unknown event type '${String(type)}'`, line);
  }
}

export interface ParsedStream {
  readonly init: ClaudeInit;
  readonly sessionId: string;
  readonly toolCalls: readonly string[];
  readonly notices: readonly string[];
  readonly result: ClaudeResult;
}

/**
 * Incremental parser. The provider feeds it each complete line as it arrives —
 * so a tool-call budget can be enforced while the agent is still running — and
 * calls finish() once the stream ends. Every structural rule is checked as the
 * line arrives; finish() adds the rules that need the whole stream.
 */
export class ClaudeStreamParser {
  private init: ClaudeInit | undefined;
  private result: ClaudeResult | undefined;
  private readonly toolCalls: string[] = [];
  private readonly notices: string[] = [];

  /** Tool calls seen so far. */
  get toolCallCount(): number {
    return this.toolCalls.length;
  }

  /** The init event, once it has arrived (even if the stream later fails). */
  finishedInit(): ClaudeInit | undefined {
    return this.init;
  }

  push(rawLine: string): ClaudeEvent | undefined {
    const line = rawLine.trim();
    if (line.length === 0) return undefined;
    if (this.result) throw new MalformedEventError('event after the result event', line);
    const ev = parseEventLine(line);
    if (ev.type === 'init') {
      if (this.init) throw new MalformedEventError('more than one init event', line);
      this.init = ev.init;
      return ev;
    }
    if (!this.init) throw new MalformedEventError('stream does not start with system/init', line);
    const sid = ev.sessionId;
    if (sid !== undefined && sid !== this.init.sessionId) {
      throw new MalformedEventError(`event for session '${sid}' in session '${this.init.sessionId}'`, line);
    }
    if (ev.type === 'assistant') this.toolCalls.push(...ev.toolUses);
    else if (ev.type === 'notice') this.notices.push(ev.kind);
    else if (ev.type === 'result') this.result = ev.result;
    return ev;
  }

  finish(tail = ''): ParsedStream {
    if (!this.init) throw new MalformedEventError('stream has no system/init event', tail);
    if (!this.result) {
      throw new MalformedEventError('stream ended with no result event (truncated/partial)', tail);
    }
    return {
      init: this.init,
      sessionId: this.init.sessionId,
      toolCalls: this.toolCalls,
      notices: this.notices,
      result: this.result,
    };
  }
}

/** Parse a complete JSONL stream (see ClaudeStreamParser for the rules). */
export function parseStream(stdout: string): ParsedStream {
  const parser = new ClaudeStreamParser();
  const lines = stdout.split('\n');
  // A final line with no newline is a line the writer may not have finished.
  // The CLI terminates every event with '\n'; anything after the last one is a
  // truncated write and fails closed.
  const last = lines.pop() ?? '';
  for (const line of lines) parser.push(line);
  if (last.trim() !== '') throw new MalformedEventError('truncated final line', last);
  return parser.finish(stdout.slice(-200));
}
