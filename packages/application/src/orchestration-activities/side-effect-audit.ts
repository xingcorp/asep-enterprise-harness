// The side-effect log as the commit and publication activities use it: the
// log unchanged, with a takeover put on record. When begin() moves an
// unfinished record from a dead owner's lease to the caller's newer one, the
// takeover is audited as side-effect.takeover, once per record and new owner.

import type { ActivityExecutionContext, SideEffectLog } from '@asep/ports';
import type { OrchestrationActivityDeps } from './deps.js';
import { correlationOf, type AttemptActivityIdentity } from './identity.js';

export function auditedLog(
  deps: OrchestrationActivityDeps, input: AttemptActivityIdentity, ctx: ActivityExecutionContext,
): SideEffectLog {
  const log = deps.sideEffects;
  return {
    async begin(scope, begin) {
      const record = await log.begin(scope, begin);
      if (record.takenOver === true) {
        await deps.audit.record(scope, {
          key: `${begin.attemptId}:${begin.operation}:takeover:${begin.ownerToken}`,
          event: {
            actor: deps.actor,
            action: 'side-effect.takeover',
            context: correlationOf(input, input.attemptId),
            occurredAt: ctx.logicalNow,
            detail: { operation: begin.operation, state: record.state, ownerEpoch: record.ownerEpoch ?? null },
          },
        });
      }
      return record;
    },
    confirmOwner: (scope, key) => log.confirmOwner(scope, key),
    complete: (scope, done) => log.complete(scope, done),
    fail: (scope, failed) => log.fail(scope, failed),
    find: (scope, key) => log.find(scope, key),
  };
}
