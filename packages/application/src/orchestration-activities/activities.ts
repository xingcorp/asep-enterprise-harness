// The orchestration activities, composed. createOrchestrationActivities binds
// every activity of the workflow's activity catalog to its dependencies and
// wraps each in the orchestration.activity span: the activity's name, the
// workflow id, the engine's delivery count and, for an activity acting under the
// attempt's lease, the caller's fence. The engine's activity bridge registers
// the result; nothing here knows the engine.

import type { AttemptId, RepositoryBindingId, RunId, TaskId, TenantScope } from '@asep/contracts';
import type { ActivityExecutionContext } from '@asep/ports';
import type { AssuranceFence } from '../review-loop/slot.js';
import * as attempt from './attempt-activities.js';
import * as execution from './execution-activities.js';
import * as assurance from './assurance-activity.js';
import * as publication from './publication-activities.js';
import * as bookkeeping from './bookkeeping-activities.js';
import type { OrchestrationActivityDeps } from './deps.js';
import { correlationOf } from './identity.js';

/** The identity fields the activity span reads; every activity input carries the first four. */
interface SpanIdentity {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly workflowId: string;
  readonly taskId?: TaskId | null;
  readonly attemptId?: AttemptId | null;
  readonly fence?: AssuranceFence | null;
}

type Activity<I, O> = (input: I, ctx: ActivityExecutionContext) => Promise<O>;

function observed<I extends SpanIdentity, O>(deps: OrchestrationActivityDeps, name: string, fn: Activity<I, O>): Activity<I, O> {
  return (input, ctx) => {
    const tracer = deps.tracer;
    if (tracer === undefined) return fn(input, ctx);
    const correlation = correlationOf({ ...input, taskId: input.taskId ?? null }, input.attemptId ?? null);
    return tracer.withSpan('orchestration.activity', correlation, async (span) => {
      span.setAttribute('asep.activity', name);
      span.setAttribute('workflow_id', input.workflowId);
      span.setAttribute('activity_attempt', ctx.engineAttempt);
      if (input.fence !== undefined && input.fence !== null) {
        span.setAttribute('lease_id', input.fence.leaseId);
        span.setAttribute('fencing_epoch', input.fence.fencingEpoch);
      }
      return fn(input, ctx);
    });
  };
}

export function createOrchestrationActivities(deps: OrchestrationActivityDeps) {
  const bind = <I extends SpanIdentity, O>(name: string, fn: (deps: OrchestrationActivityDeps, input: I, ctx: ActivityExecutionContext) => Promise<O>) =>
    observed<I, O>(deps, name, (input, ctx) => fn(deps, input, ctx));
  return {
    admitTask: bind('admitTask', attempt.admitTask),
    ensureAttempt: bind('ensureAttempt', attempt.ensureAttempt),
    findAttempt: bind('findAttempt', attempt.findAttempt),
    acquireLease: bind('acquireLease', attempt.acquireLease),
    findLease: bind('findLease', attempt.findLease),
    recordPreLeaseOutcome: bind('recordPreLeaseOutcome', attempt.recordPreLeaseOutcome),
    recordAttemptOutcome: bind('recordAttemptOutcome', attempt.recordAttemptOutcome),
    releaseLease: bind('releaseLease', attempt.releaseLease),
    renewLease: bind('renewLease', attempt.renewLease),
    prepareWorkspace: bind('prepareWorkspace', execution.prepareWorkspace),
    storeAttemptInputs: bind('storeAttemptInputs', execution.storeAttemptInputs),
    runAgent: bind('runAgent', execution.runAgent),
    inspectWorkspace: bind('inspectWorkspace', execution.inspectWorkspace),
    runVerification: bind('runVerification', execution.runVerification),
    commitAttempt: bind('commitAttempt', execution.commitAttempt),
    persistEvidence: bind('persistEvidence', execution.persistEvidence),
    reapContainers: bind('reapContainers', execution.reapContainers),
    quarantineWorkspace: bind('quarantineWorkspace', execution.quarantineWorkspace),
    cleanupWorkspace: bind('cleanupWorkspace', execution.cleanupWorkspace),
    assuranceRound: bind('assuranceRound', assurance.assuranceRound),
    publishBranch: bind('publishBranch', publication.publishBranch),
    upsertPullRequest: bind('upsertPullRequest', publication.upsertPullRequest),
    reconcilePublication: bind('reconcilePublication', publication.reconcilePublication),
    projectTaskState: bind('projectTaskState', bookkeeping.projectTaskState),
    recordUsage: bind('recordUsage', bookkeeping.recordUsage),
    recordOverrun: bind('recordOverrun', bookkeeping.recordOverrun),
    recordExtension: bind('recordExtension', bookkeeping.recordExtension),
    openApprovalRequest: bind('openApprovalRequest', bookkeeping.openApprovalRequest),
    verifyApprovalDecision: bind('verifyApprovalDecision', bookkeeping.verifyApprovalDecision),
    expireApprovalRequest: bind('expireApprovalRequest', bookkeeping.expireApprovalRequest),
    cancelApprovalRequest: bind('cancelApprovalRequest', bookkeeping.cancelApprovalRequest),
    recordControl: bind('recordControl', bookkeeping.recordControl),
    recordAudit: bind('recordAudit', bookkeeping.recordAudit),
    emitRunEvent: bind('emitRunEvent', bookkeeping.emitRunEvent),
  };
}

export type OrchestrationActivities = ReturnType<typeof createOrchestrationActivities>;
