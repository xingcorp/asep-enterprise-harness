// The observer every privileged completion boundary runs through.
//
// completeToReview is a PURE module: it must not import SpanTracer/AuditSink or
// read a clock, so the span + audit wrapper is built by the use case that holds
// the tracer, the audit sink and the full correlation identity, and is injected
// as `observe`. Both the fresh slice and a resume build it the same way, so it
// lives here once.
//
// `fencedBy` adds the lease fence. Before each boundary's effect runs, the
// holder renews its lease; a renewal that fails (LeaseLostError) means a
// successor may already own the attempt, so the effect never starts. That is
// the holder-side half of fencing — the side-effect log refuses a stale owner's
// writes regardless.

import type { SpanTracer, AuditSink, CorrelationContext } from '@asep/observability';
import { isSpanName, isPrivilegedAction, auditEvent } from '@asep/observability';
import type { ObserveBoundary } from './pipeline-steps.js';

export function completionObserver(opts: {
  readonly correlation: CorrelationContext;
  readonly actor: string;
  readonly tracer?: SpanTracer;
  readonly audit?: AuditSink;
  readonly now?: () => string;
}): ObserveBoundary {
  const now = opts.now ?? ((): string => new Date().toISOString());
  return async (boundary, fn) => {
    // The closed sets live in @asep/observability; validate rather than cast so
    // a typo in a boundary name fails loudly instead of emitting an unnamed span.
    const span = boundary.span;
    const action = boundary.action;
    if (!isSpanName(span) || !isPrivilegedAction(action)) {
      throw new Error(
        `unknown span/action pair '${span}'/'${action}' — ` +
        'a completion boundary must use a declared name',
      );
    }
    if (opts.audit) {
      await opts.audit.record(auditEvent({
        actor: opts.actor,
        action,
        context: opts.correlation,
        occurredAt: now(),
        detail: boundary.detail,
      }));
    }
    if (opts.tracer) {
      return opts.tracer.withSpan(span, opts.correlation, fn);
    }
    return fn();
  };
}

/** Run `fence` (a lease renewal) immediately before every observed effect. */
export function fencedBy(observe: ObserveBoundary, fence: () => Promise<void>): ObserveBoundary {
  return (boundary, fn) => observe(boundary, async () => {
    await fence();
    return fn();
  });
}
