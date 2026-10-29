import test from 'node:test';
import assert from 'node:assert/strict';
import { adjudicate } from './adjudication.js';
import { canonicalBytes, sha256Hex } from './canonical-json.js';
import { REPAIR_CLOSURE_RULE, RepairOrderError, buildRepairOrder, type RepairOrderInput } from './repair.js';
import { PRIMARY, RESULT_SHA, TASK_BASE_SHA, adjudicationBase, completedReview, modelFinding, reviewOutput } from './test-support.js';

console.log('SUITE-ID: asep-suite:repair-order');

const WORK_ORDER_REF = { artifactId: 'art-work-order' as never, sha256: 'a'.repeat(64), kind: 'work-order' };
const LIMITS = { perFieldBytes: 4096, totalBytes: 65536 };

function repairInput(over: Partial<RepairOrderInput> = {}): RepairOrderInput {
  const input = {
    ...adjudicationBase(),
    reviews: [
      completedReview(
        PRIMARY,
        reviewOutput({
          verdict: 'REQUEST_CHANGES',
          findings: [
            modelFinding(),
            modelFinding({ key: 'f-low', severity: 'LOW', file: 'src/util.ts', lineStart: 1, lineEnd: 1 }),
            modelFinding({ key: 'f-ungrounded', file: 'src/invented.ts' }),
          ],
        }),
      ),
    ],
  };
  const adjudication = adjudicate(input);
  return {
    taskId: 'task-1',
    fromAttemptId: input.attemptId,
    round: input.round,
    taskBaseSha: TASK_BASE_SHA,
    resultSha: RESULT_SHA,
    adjudication,
    workOrderRef: WORK_ORDER_REF,
    limits: LIMITS,
    ...over,
  };
}

test('repair order is bounded and anchored to the prior commit', () => {
  const input = repairInput();
  assert.equal(input.adjudication.record.outcome, 'REPAIR');
  const { order, bytes, sha256 } = buildRepairOrder(input);

  // Anchored: the repair starts from the attempt that was reviewed.
  assert.equal(order.repairBaseSha, RESULT_SHA);
  assert.equal(order.taskBaseSha, TASK_BASE_SHA);
  assert.equal(order.fromAttemptId, input.fromAttemptId);
  assert.equal(order.nextRound, input.round + 1);
  assert.equal(order.adjudicationId, input.adjudication.record.adjudicationId);
  assert.deepEqual(order.workOrderRef, WORK_ORDER_REF);
  assert.equal(order.closureRule, REPAIR_CLOSURE_RULE);
  assert.equal(order.closureRule, 'a fix is verified only by a different eligible reviewer, a human, or a deterministic re-check');

  // Only grounded blocking findings are blocking; the low finding is informational; the
  // ungrounded one is absent.
  assert.deepEqual(
    order.blockingFindings.map((f) => [f.severity, f.file, f.grounded]),
    [['HIGH', 'src/feature.ts', true]],
  );
  assert.deepEqual(
    order.informationalFindings.map((f) => [f.severity, f.file]),
    [['LOW', 'src/util.ts']],
  );
  assert.equal(JSON.stringify(order).includes('src/invented.ts'), false);
  assert.equal(order.informationalOmitted, 0);

  // Canonical and input-derived.
  assert.deepEqual(bytes, canonicalBytes(order));
  assert.equal(sha256, sha256Hex(bytes));
  assert.equal(order.repairOrderId, sha256Hex(`${order.adjudicationId}|${order.nextRound}`));
  assert.deepEqual(buildRepairOrder(input).bytes, bytes);

  // Bounded: long finding text is clipped per field with an explicit marker.
  const long = repairInput({ limits: { perFieldBytes: 64, totalBytes: 65536 } });
  const clipped = buildRepairOrder(long).order.blockingFindings[0]!;
  assert.ok(new TextEncoder().encode(clipped.evidence).byteLength <= 64);
  assert.match(clipped.evidence, /\[truncated \d+ bytes\]$/);

  // Informational findings are capped by the total budget and counted, never silently dropped.
  const tight = buildRepairOrder(
    repairInput({ limits: { perFieldBytes: 4096, totalBytes: new TextEncoder().encode(JSON.stringify(order.blockingFindings)).byteLength + 10 } }),
  ).order;
  assert.equal(tight.blockingFindings.length, 1);
  assert.equal(tight.informationalFindings.length, 0);
  assert.equal(tight.informationalOmitted, 1);
  assert.ok(new TextEncoder().encode(JSON.stringify([...tight.blockingFindings, ...tight.informationalFindings])).byteLength <= 65536);

  // Blocking findings are never dropped to fit: the order is refused instead.
  assert.throws(() => buildRepairOrder(repairInput({ limits: { perFieldBytes: 4096, totalBytes: 100 } })), RepairOrderError);

  // Only a gating REPAIR adjudication produces a repair order.
  const proceed = adjudicate(adjudicationBase());
  assert.throws(() => buildRepairOrder({ ...input, adjudication: proceed }), RepairOrderError);
  const shadow = adjudicate({ ...adjudicationBase(), mode: 'shadow', reviews: repairInputReviews() });
  assert.throws(() => buildRepairOrder({ ...input, adjudication: shadow }), RepairOrderError);
  assert.throws(() => buildRepairOrder({ ...input, resultSha: 'not-a-sha' }), RepairOrderError);
  assert.throws(() => buildRepairOrder({ ...input, round: input.round + 1 }), RepairOrderError);
});

function repairInputReviews() {
  return [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [modelFinding()] }))];
}
