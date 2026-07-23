// Claude stream-JSON event parser (exit criterion G2). The Claude CLI emits one
// JSON object per line (JSONL). We parse STRUCTURED events only — never scrape
// prose. A malformed line, an unknown event type, or a truncated final line
// FAILS CLOSED (throws) rather than being silently ignored, so a partial or
// corrupt stream can never be mistaken for a clean completion.
//
// The event shapes we accept are deliberately minimal: the harness derives all
// authoritative facts (resultSha/changedFiles) elsewhere, so the provider stream
// only carries a session id, usage accounting, tool-call notes, and a terminal
// result event with a status. Anything the agent claims about the repository is
// advisory text, not trusted.

export class MalformedEventError extends Error {
  constructor(reason: string, line: string) {
    // Truncate the offending line in the message so a huge blob can't flood logs.
    const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    super(`malformed Claude event: ${reason} — line: ${JSON.stringify(shown)}`);
    this.name = 'MalformedEventError';
  }
}

export type ClaudeEvent =
  | { readonly type: 'system'; readonly sessionId: string }
  | { readonly type: 'tool_use'; readonly name: string }
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'result';
      readonly status: 'AGENT_DONE' | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED';
      readonly summary: string;
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly modelCostUsd: number;
        readonly toolCalls: number;
        readonly wallClockMs: number;
      };
      readonly knownLimitations: readonly string[];
    };

const RESULT_STATUSES = new Set(['AGENT_DONE', 'FAILED', 'BLOCKED', 'BUDGET_EXHAUSTED']);

function asRecord(v: unknown, line: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new MalformedEventError('event is not a JSON object', line);
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

function str(o: Record<string, unknown>, k: string, line: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new MalformedEventError(`field '${k}' is not a string`, line);
  return v;
}

/** Parse a single JSONL line into a typed event. Throws on anything unexpected. */
export function parseEventLine(line: string): ClaudeEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new MalformedEventError('not valid JSON', line);
  }
  const o = asRecord(raw, line);
  const type = o['type'];
  switch (type) {
    case 'system':
      return { type: 'system', sessionId: str(o, 'sessionId', line) };
    case 'tool_use':
      return { type: 'tool_use', name: str(o, 'name', line) };
    case 'text':
      return { type: 'text', text: str(o, 'text', line) };
    case 'result': {
      const status = str(o, 'status', line);
      if (!RESULT_STATUSES.has(status)) {
        throw new MalformedEventError(`unknown result status '${status}'`, line);
      }
      const usageRaw = asRecord(o['usage'], line);
      const limitsRaw = o['knownLimitations'] ?? [];
      if (!Array.isArray(limitsRaw) || limitsRaw.some((x) => typeof x !== 'string')) {
        throw new MalformedEventError("'knownLimitations' is not a string[]", line);
      }
      return {
        type: 'result',
        status: status as 'AGENT_DONE' | 'FAILED' | 'BLOCKED' | 'BUDGET_EXHAUSTED',
        summary: str(o, 'summary', line),
        usage: {
          inputTokens: num(usageRaw, 'inputTokens', line),
          outputTokens: num(usageRaw, 'outputTokens', line),
          modelCostUsd: num(usageRaw, 'modelCostUsd', line),
          toolCalls: num(usageRaw, 'toolCalls', line),
          wallClockMs: num(usageRaw, 'wallClockMs', line),
        },
        knownLimitations: limitsRaw as string[],
      };
    }
    default:
      throw new MalformedEventError(`unknown event type '${String(type)}'`, line);
  }
}

export interface ParsedStream {
  readonly sessionId?: string;
  readonly toolCalls: readonly string[];
  readonly result: Extract<ClaudeEvent, { type: 'result' }>;
}

/**
 * Parse a full JSONL stream. Requires EXACTLY one terminal `result` event; a
 * stream with no result (truncated / crashed mid-run) fails closed, so a partial
 * stream can never be read as success. Blank trailing lines are tolerated;
 * a non-blank malformed line is not.
 */
export function parseStream(stdout: string): ParsedStream {
  const lines = stdout.split('\n');
  let sessionId: string | undefined;
  const toolCalls: string[] = [];
  let result: Extract<ClaudeEvent, { type: 'result' }> | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const ev = parseEventLine(line);
    if (ev.type === 'system') sessionId = ev.sessionId;
    else if (ev.type === 'tool_use') toolCalls.push(ev.name);
    else if (ev.type === 'result') {
      if (result) throw new MalformedEventError('more than one result event', line);
      result = ev;
    }
  }

  if (!result) {
    throw new MalformedEventError('stream ended with no result event (truncated/partial)', stdout.slice(-200));
  }
  return sessionId === undefined ? { toolCalls, result } : { sessionId, toolCalls, result };
}
