// Span vocabulary + tracer suite (exit criteria J1/J2).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPAN_NAMES,
  isSpanName,
  SpanTracer,
  CapturingTelemetrySink,
  type SpanName,
} from './spans.js';
import type { CorrelationContext } from './index.js';

console.log('SUITE-ID: asep-suite:observability-spans');

// The full correlation identity every pipeline span must carry (exit J2).
const fullCtx: CorrelationContext = {
  traceId: 'trace-1',
  tenantId: 'org-1',
  projectId: 'proj-1',
  runId: 'run-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
};

// A deterministic clock: each read advances by 5ms.
function fakeClock(): () => number {
  let t = 1_000;
  return () => {
    const now = t;
    t += 5;
    return now;
  };
}

test('J1: the closed span set is exactly the ten mandated pipeline spans', () => {
  assert.deepEqual([...SPAN_NAMES].sort(), [
    'agent.invoke',
    'artifact.put',
    'command.execute',
    'context.build',
    'forge.pull_request',
    'forge.push',
    'git.commit',
    'task.execute',
    'workspace.create',
    'workspace.lease',
  ]);
});

test('J1: isSpanName accepts mandated names and rejects others', () => {
  assert.equal(isSpanName('task.execute'), true);
  assert.equal(isSpanName('forge.pull_request'), true);
  assert.equal(isSpanName('not.a.span'), false);
});

test('J1/J2: a span emits asep.span.<name> carrying full correlation identity', () => {
  const sink = new CapturingTelemetrySink();
  const tracer = new SpanTracer(sink, fakeClock());
  const span = tracer.start('agent.invoke', fullCtx);
  span.setAttribute('providerId', 'claude');
  const record = span.end('OK');

  assert.equal(record.name, 'agent.invoke');
  assert.equal(record.status, 'OK');
  assert.equal(record.durationMs, 5);
  assert.equal(record.attributes['providerId'], 'claude');

  assert.equal(sink.events.length, 1);
  const ev = sink.events[0]!;
  assert.equal(ev.name, 'asep.span.agent.invoke');
  // Every span carries the org/project/run/task/attempt identity (exit J2).
  assert.equal(ev.context.tenantId, 'org-1');
  assert.equal(ev.context.projectId, 'proj-1');
  assert.equal(ev.context.runId, 'run-1');
  assert.equal(ev.context.taskId, 'task-1');
  assert.equal(ev.context.attemptId, 'attempt-1');
  assert.equal(ev.attributes['status'], 'OK');
  assert.equal(ev.attributes['providerId'], 'claude');
});

test('J2: a span missing a required correlation id fails closed', () => {
  const sink = new CapturingTelemetrySink();
  const tracer = new SpanTracer(sink);
  const noAttempt: CorrelationContext = {
    traceId: 'trace-1',
    tenantId: 'org-1',
    projectId: 'proj-1',
    runId: 'run-1',
    taskId: 'task-1',
  };
  assert.throws(
    () => tracer.start('git.commit', noAttempt),
    /missing required correlation ids: attemptId/,
  );
  // Nothing was emitted for the rejected span.
  assert.equal(sink.events.length, 0);
});

test('J2: missing tenant + project + run are all reported', () => {
  const sink = new CapturingTelemetrySink();
  const tracer = new SpanTracer(sink);
  const bare: CorrelationContext = {
    traceId: 't',
    tenantId: '',
    projectId: '',
    taskId: 'task-1',
    attemptId: 'attempt-1',
  };
  assert.throws(
    () => tracer.start('task.execute', bare),
    /tenantId.*projectId.*runId/,
  );
});

test('a span cannot be ended twice', () => {
  const tracer = new SpanTracer(new CapturingTelemetrySink(), fakeClock());
  const span = tracer.start('command.execute', fullCtx);
  span.end('OK');
  assert.throws(() => span.end('OK'), /already ended/);
});

test('withSpan ends OK on success and ERROR (re-throwing) on failure', async () => {
  const sink = new CapturingTelemetrySink();
  const tracer = new SpanTracer(sink, fakeClock());

  const value = await tracer.withSpan('context.build', fullCtx, async () => 42);
  assert.equal(value, 42);
  assert.equal(sink.events[0]!.attributes['status'], 'OK');

  await assert.rejects(
    () => tracer.withSpan('forge.push', fullCtx, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const pushEvent = sink.events.find((e) => e.name === 'asep.span.forge.push')!;
  assert.equal(pushEvent.attributes['status'], 'ERROR');
});

test('every mandated span name is startable with a full context', () => {
  const sink = new CapturingTelemetrySink();
  const tracer = new SpanTracer(sink, fakeClock());
  for (const name of SPAN_NAMES as readonly SpanName[]) {
    tracer.start(name, fullCtx).end('OK');
  }
  assert.equal(sink.events.length, SPAN_NAMES.length);
});
