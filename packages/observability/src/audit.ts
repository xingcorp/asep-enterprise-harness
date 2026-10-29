// Privileged-operation audit vocabulary (exit criterion J4).
//
// J4 requires every PRIVILEGED operation to be audited. This module fixes the
// CLOSED set of auditable privileged actions and the pure shape of an audit
// event; the concrete PostgreSQL-backed sink (writing to the `audit_events`
// table, migration 0007) lives in adapters/persistence so this pure layer
// stays free of a driver import (exit B3, forbidden-imports fitness).
//
// An audit event carries the actor (who performed it), the action (what closed
// set), the full tenant + hierarchy correlation identity (so an audit row
// resolves to exactly one org/project/repository/run/task/attempt) and an
// optional structured detail payload. `occurredAt` is an ISO-8601 UTC stamp.

import type { CorrelationContext } from './index.js';

// The closed set of privileged actions that MUST be audited (exit J4). These
// are the operations that create an external side effect, mutate trust state,
// or cross a security boundary. Adding a new privileged operation is a
// deliberate edit here, and the type flows to every audit call site so an
// unaudited privileged action cannot compile.
export const PRIVILEGED_ACTIONS = [
  'workspace.lease.acquire',
  'workspace.create',
  'agent.invoke',
  'git.commit',
  'forge.push',
  'forge.pull_request.upsert',
  'artifact.put',
  'evidence.put',
  'task.status.transition',
  // Running a verification command inside the sandbox (disp. P2-FINAL-MED-003).
  //
  // WHY IT IS ADDED. The `command.execute` span was declared but never emitted;
  // wiring it revealed that the closed action set had no honest counterpart, so
  // the first attempt paired the span with `artifact.put`. That is a mislabelled
  // audit row: an operator reading it would see an artifact write where a command
  // actually ran in the sandbox. Executing a command against the working tree IS
  // a privileged boundary in its own right, so it gets its own name rather than
  // borrowing one that means something else.
  'command.execute',
  // Repairing the remote after a takeover: the attempt branch or its pull
  // request no longer matched the attempt's facts, and was rewritten from them.
  // A stale owner can still reach the forge after a takeover, so the successor
  // reconciles before any terminal state, and every repair is on record.
  'forge.reconcile',
] as const;

export type PrivilegedAction = (typeof PRIVILEGED_ACTIONS)[number];

const PRIVILEGED_ACTION_SET: ReadonlySet<string> = new Set(PRIVILEGED_ACTIONS);

export function isPrivilegedAction(value: string): value is PrivilegedAction {
  return PRIVILEGED_ACTION_SET.has(value);
}

// A privileged-operation audit event. `context` carries the full correlation
// identity (org/project + run/task/attempt) so the persisted row resolves to
// exactly one point in the hierarchy (exit J2/J4). `detail` is an optional
// structured payload (e.g. the pushed ref, the PR number) — it must NOT carry
// raw source/prompt/tool output (exit J3: that is off by default).
export interface AuditEvent {
  readonly actor: string;
  readonly action: PrivilegedAction;
  readonly context: CorrelationContext;
  readonly occurredAt: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

// The sink a composition root wires to persist audit events. The application
// layer depends only on this interface; the PostgreSQL impl lives in an adapter.
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

// Build a well-formed AuditEvent, failing closed on an unknown action or a
// correlation context missing its load-bearing ids. This is the single
// constructor every caller uses, so an audit event can never be emitted with an
// action outside the closed set or without full tenant/hierarchy attribution.
export function auditEvent(input: {
  actor: string;
  action: PrivilegedAction;
  context: CorrelationContext;
  occurredAt: string;
  detail?: Readonly<Record<string, unknown>>;
}): AuditEvent {
  if (!isPrivilegedAction(input.action)) {
    throw new Error(`unknown privileged action "${input.action}" (not in the closed J4 set)`);
  }
  const missing: string[] = [];
  if (!input.actor) missing.push('actor');
  if (!input.context.tenantId) missing.push('tenantId');
  if (!input.context.projectId) missing.push('projectId');
  if (!input.context.runId) missing.push('runId');
  if (!input.context.taskId) missing.push('taskId');
  if (!input.context.attemptId) missing.push('attemptId');
  if (missing.length > 0) {
    throw new Error(
      `audit event for "${input.action}" is missing required fields: ${missing.join(', ')} ` +
        `(exit J4: every privileged op audited with full correlation identity) — fail closed`,
    );
  }
  return {
    actor: input.actor,
    action: input.action,
    context: input.context,
    occurredAt: input.occurredAt,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}
