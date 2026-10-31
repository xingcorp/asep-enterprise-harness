// OTel-style span vocabulary + tracer (exit criteria J1/J2).
//
// J1 fixes the CLOSED set of span names the Phase-2 pipeline must emit:
//   task.execute, context.build, workspace.lease, workspace.create,
//   agent.invoke, command.execute, artifact.put, git.commit, forge.push,
//   forge.pull_request
// A span is emitted through the existing TelemetrySink as a structured event
// (name `asep.span.<name>`) so no new transport is introduced. J2 requires
// every span to carry the full correlation identity (org/project/repository/
// run/task/attempt IDs); the tracer therefore takes a CorrelationContext that
// already pins tenant + project and validates that the load-bearing ids are
// present before a span may start — a span missing its correlation identity
// fails closed rather than emitting an unattributable event.
//
// This module is framework-free and deterministic: it depends only on a clock
// (injectable for tests) and the TelemetrySink seam.

import type { CorrelationContext, TelemetrySink } from './index.js';

// The closed set of Phase-2 span names (exit J1). Adding/removing a span is a
// deliberate edit here, and the type flows to every call site.
export const SPAN_NAMES = [
  'task.execute',
  'context.build',
  'workspace.lease',
  'workspace.create',
  'agent.invoke',
  'command.execute',
  'artifact.put',
  'git.commit',
  'forge.push',
  'forge.pull_request',
] as const;

export type PipelineSpanName = (typeof SPAN_NAMES)[number];

// Durable orchestration's spans. `orchestration.activity` wraps one delivery of
// one workflow activity (attribute `asep.activity` names it) and carries the
// workflow id, the engine's delivery count and the caller's lease fence.
// Unlike the pipeline spans, an orchestration span may sit above an attempt (a
// task-level activity has none), so it requires the tenant, project and run.
export const ORCHESTRATION_SPAN_NAMES = [
  'orchestration.activity',
] as const;

export type OrchestrationSpanName = (typeof ORCHESTRATION_SPAN_NAMES)[number];

export type SpanName = PipelineSpanName | OrchestrationSpanName;

const PIPELINE_SPAN_SET: ReadonlySet<string> = new Set(SPAN_NAMES);
const SPAN_NAME_SET: ReadonlySet<string> = new Set([...SPAN_NAMES, ...ORCHESTRATION_SPAN_NAMES]);

export function isSpanName(value: string): value is SpanName {
  return SPAN_NAME_SET.has(value);
}

export type SpanStatus = 'OK' | 'ERROR';

// The immutable record produced when a span ends. It carries the span name, the
// full correlation context, timing, terminal status and any attributes set
// during the span. This is what a downstream exporter would ship.
export interface SpanRecord {
  readonly name: SpanName;
  readonly context: CorrelationContext;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface SpanHandle {
  setAttribute(key: string, value: unknown): void;
  // End the span, emitting it through the sink. Returns the immutable record.
  end(status?: SpanStatus): SpanRecord;
}

// Injectable clock so tests are deterministic. Defaults to Date.now.
export type Clock = () => number;

// The correlation identity every span MUST carry (exit J2). tenantId + projectId
// are always required; the run/task/attempt ids are required once a span is
// scoped to that level of the hierarchy. task.execute and everything downstream
// operate on a specific task+attempt, so we require runId/taskId/attemptId for
// all pipeline spans and fail closed if any is missing. An orchestration span
// requires the run; it carries the task and attempt when it has them.
function assertCorrelated(name: SpanName, ctx: CorrelationContext): void {
  const pipeline = PIPELINE_SPAN_SET.has(name);
  const missing: string[] = [];
  if (!ctx.tenantId) missing.push('tenantId');
  if (!ctx.projectId) missing.push('projectId');
  if (!ctx.runId) missing.push('runId');
  if (pipeline && !ctx.taskId) missing.push('taskId');
  if (pipeline && !ctx.attemptId) missing.push('attemptId');
  if (missing.length > 0) {
    throw new Error(
      `span "${name}" is missing required correlation ids: ${missing.join(', ')} ` +
        `(exit J2: every span must carry org/project/run/task/attempt identity) — fail closed`,
    );
  }
}

// A tracer bound to a TelemetrySink. `start` opens a span; the returned handle
// records attributes and, on `end`, emits an event `asep.span.<name>` carrying
// the correlation context + timing + status through the sink.
export class SpanTracer {
  constructor(
    private readonly sink: TelemetrySink,
    private readonly now: Clock = () => Date.now(),
  ) {}

  start(name: SpanName, context: CorrelationContext): SpanHandle {
    if (!isSpanName(name)) {
      throw new Error(`unknown span name "${name}" (not in the closed J1 set)`);
    }
    assertCorrelated(name, context);
    const startMs = this.now();
    const startedAt = new Date(startMs).toISOString();
    const attributes: Record<string, unknown> = {};
    let ended = false;

    const emit = (status: SpanStatus): SpanRecord => {
      if (ended) {
        throw new Error(`span "${name}" already ended`);
      }
      ended = true;
      const endMs = this.now();
      const record: SpanRecord = {
        name,
        context,
        startedAt,
        endedAt: new Date(endMs).toISOString(),
        durationMs: endMs - startMs,
        status,
        attributes: { ...attributes },
      };
      this.sink.event(`asep.span.${name}`, context, {
        durationMs: record.durationMs,
        status: record.status,
        ...record.attributes,
      });
      return record;
    };

    return {
      setAttribute(key: string, value: unknown): void {
        attributes[key] = value;
      },
      end(status: SpanStatus = 'OK'): SpanRecord {
        return emit(status);
      },
    };
  }

  // Convenience: run `fn` inside a span, ending OK on success and ERROR (then
  // re-throwing) on failure. The record is not returned — use start/end when the
  // caller needs the record — but the span is always emitted exactly once.
  async withSpan<T>(
    name: SpanName,
    context: CorrelationContext,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const span = this.start(name, context);
    try {
      const out = await fn(span);
      span.end('OK');
      return out;
    } catch (err) {
      span.end('ERROR');
      throw err;
    }
  }
}

// A capturing sink for tests + a Temporal-shaped in-memory exporter: records
// every event/metric so a test can assert the exact spans emitted.
export interface CapturedEvent {
  readonly name: string;
  readonly context: CorrelationContext;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export class CapturingTelemetrySink implements TelemetrySink {
  readonly events: CapturedEvent[] = [];
  readonly metrics: { name: string; value: number }[] = [];

  event(name: string, context: CorrelationContext, attributes: Readonly<Record<string, unknown>>): void {
    this.events.push({ name, context, attributes });
  }

  metric(point: { name: string; value: number }): void {
    this.metrics.push({ name: point.name, value: point.value });
  }
}
