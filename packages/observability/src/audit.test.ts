// Privileged-operation audit vocabulary suite (exit criterion J4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVILEGED_ACTIONS,
  isPrivilegedAction,
  auditEvent,
} from './audit.js';
import type { CorrelationContext } from './index.js';

console.log('SUITE-ID: asep-suite:observability-audit');

const fullCtx: CorrelationContext = {
  traceId: 'trace-1',
  tenantId: 'org-1',
  projectId: 'proj-1',
  runId: 'run-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
};

test('J4: the closed privileged-action set covers every external side effect + trust mutation', () => {
  // The side-effecting / boundary-crossing operations the pipeline performs.
  for (const required of [
    'workspace.lease.acquire',
    'workspace.create',
    'agent.invoke',
    'git.commit',
    'forge.push',
    'forge.pull_request.upsert',
    'artifact.put',
    'evidence.put',
    'task.status.transition',
  ]) {
    assert.ok(
      (PRIVILEGED_ACTIONS as readonly string[]).includes(required),
      `privileged action set missing "${required}"`,
    );
  }
});

test('J4: isPrivilegedAction accepts mandated actions and rejects others', () => {
  assert.equal(isPrivilegedAction('forge.push'), true);
  assert.equal(isPrivilegedAction('task.status.transition'), true);
  assert.equal(isPrivilegedAction('some.random.op'), false);
});

test('J4: auditEvent builds a well-formed event carrying full correlation identity', () => {
  const ev = auditEvent({
    actor: 'harness:executor',
    action: 'forge.push',
    context: fullCtx,
    occurredAt: '2026-07-14T00:00:00.000Z',
    detail: { ref: 'refs/heads/asep/attempt-1' },
  });
  assert.equal(ev.actor, 'harness:executor');
  assert.equal(ev.action, 'forge.push');
  assert.equal(ev.context.tenantId, 'org-1');
  assert.equal(ev.context.projectId, 'proj-1');
  assert.equal(ev.context.runId, 'run-1');
  assert.equal(ev.context.taskId, 'task-1');
  assert.equal(ev.context.attemptId, 'attempt-1');
  assert.deepEqual(ev.detail, { ref: 'refs/heads/asep/attempt-1' });
});

test('J4: auditEvent omits detail cleanly when absent', () => {
  const ev = auditEvent({
    actor: 'harness:executor',
    action: 'git.commit',
    context: fullCtx,
    occurredAt: '2026-07-14T00:00:00.000Z',
  });
  assert.ok(!('detail' in ev));
});

test('J4: an audit event missing a required correlation id fails closed', () => {
  const noAttempt: CorrelationContext = {
    traceId: 'trace-1',
    tenantId: 'org-1',
    projectId: 'proj-1',
    runId: 'run-1',
    taskId: 'task-1',
  };
  assert.throws(
    () =>
      auditEvent({
        actor: 'harness:executor',
        action: 'forge.push',
        context: noAttempt,
        occurredAt: '2026-07-14T00:00:00.000Z',
      }),
    /missing required fields: attemptId/,
  );
});

test('J4: an audit event with a blank actor fails closed', () => {
  assert.throws(
    () =>
      auditEvent({
        actor: '',
        action: 'forge.push',
        context: fullCtx,
        occurredAt: '2026-07-14T00:00:00.000Z',
      }),
    /missing required fields: actor/,
  );
});
