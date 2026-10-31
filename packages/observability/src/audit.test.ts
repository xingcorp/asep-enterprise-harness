// Privileged-operation audit vocabulary suite (exit criterion J4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVILEGED_ACTIONS,
  ORCHESTRATION_AUDIT_ACTIONS,
  isPrivilegedAction,
  isOrchestrationAuditAction,
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
    'command.execute',
    // A takeover's repair of the attempt branch or its PR is a forge write too.
    'forge.reconcile',
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

test('the orchestration actions are a closed set of their own, each needing only the run', () => {
  assert.deepEqual([...ORCHESTRATION_AUDIT_ACTIONS].sort(), [
    'approval.expire', 'approval.request', 'approval.unverified', 'assurance-unavailable', 'attempt.state-unknown',
    'budget.extend', 'budget.overrun', 'budget.threshold', 'publication.content-repaired', 'publication.incomplete',
    'publication.repository-renamed', 'review-slot.contract-violation', 'side-effect.takeover', 'workflow.cancel',
    'workflow.cancel.after-publication', 'workflow.pause', 'workflow.pause-timeout', 'workflow.resume', 'workflow.seal',
    'workspace.quarantine',
  ]);
  for (const action of ORCHESTRATION_AUDIT_ACTIONS) {
    assert.equal(isOrchestrationAuditAction(action), true, action);
    assert.equal(isPrivilegedAction(action), false, `${action} is not a pipeline boundary`);
  }
  // A run's seal has no task, and a task-level control no attempt.
  const runOnly: CorrelationContext = { traceId: 't', tenantId: 'org-1', projectId: 'proj-1', runId: 'run-1' };
  const ev = auditEvent({ actor: 'principal-1', action: 'workflow.seal', context: runOnly, occurredAt: '2026-10-31T00:00:00.000Z' });
  assert.equal(ev.action, 'workflow.seal');
  assert.throws(
    () => auditEvent({ actor: 'principal-1', action: 'workflow.seal', context: { traceId: 't', tenantId: 'org-1', projectId: 'proj-1' }, occurredAt: 'x' }),
    /missing required fields: runId/,
  );
  assert.throws(
    () => auditEvent({ actor: 'h', action: 'workflow.start' as never, context: runOnly, occurredAt: 'x' }),
    /unknown privileged action "workflow.start"/,
  );
});
