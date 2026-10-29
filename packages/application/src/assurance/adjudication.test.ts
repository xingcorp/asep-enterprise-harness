import test from 'node:test';
import assert from 'node:assert/strict';
import { adjudicate, type AdjudicationInput, type ReviewInput } from './adjudication.js';
import { sha256Hex } from './canonical-json.js';
import { parseUnifiedDiff } from './diff.js';
import { findingFingerprint } from './findings.js';
import type { ReviewFindingRecord } from './local-types.js';
import type { PriorFindingClaimOutput } from './prompt.js';
import {
  COMPARATOR,
  MODEL_EVIDENCE,
  MODEL_FIX,
  PRIMARY,
  adjudicationBase,
  completedReview,
  fixtureWorld,
  modelFinding,
  reviewOutput,
} from './test-support.js';

console.log('SUITE-ID: asep-suite:adjudication');

type Mode = AdjudicationInput['mode'];

function failed(reviewerConfigId: string, failureReason: string, status: ReviewInput['status'] = 'FAILED'): ReviewInput {
  return { reviewerConfigId, status, failureReason, recordSha256: null, output: null };
}

const HIGH = modelFinding();

/** One scenario per rule, built from the consistent base. */
const SCENARIOS: Readonly<Record<string, (mode: Mode) => AdjudicationInput>> = {
  'push guard blocks': (mode) => {
    const base = adjudicationBase();
    return {
      ...base,
      mode,
      checks: { ...base.checks, pushGuard: { decision: 'BLOCK', reason: 'secret-in-diff' } },
      reviews: [{ reviewerConfigId: PRIMARY, status: 'SKIPPED_PUSH_GUARD', failureReason: 'push-guard', recordSha256: null, output: null }],
    };
  },
  'packet over budget': (mode) => {
    const base = adjudicationBase();
    return {
      ...base,
      mode,
      packet: { ...base.packet, budget: { ...base.packet.budget, overBudget: true } },
      reviews: [failed(PRIMARY, 'packet-over-budget')],
    };
  },
  'egress not clear': (mode) => {
    const base = adjudicationBase();
    return {
      ...base,
      mode,
      checks: { ...base.checks, egress: { ...base.checks.egress, decision: 'STOP_CLASSIFIED' } },
      reviews: [failed(PRIMARY, 'egress-classified', 'EGRESS_STOPPED')],
    };
  },
  'no eligible reviewer': (mode) => ({
    ...adjudicationBase(),
    mode,
    unsatisfiable: 'independence-unsatisfiable',
    reviewers: [],
    reviews: [],
  }),
  'budget insufficient': (mode) => ({
    ...adjudicationBase(),
    mode,
    unsatisfiable: 'budget-exhausted',
    reviews: [failed(PRIMARY, 'budget-exhausted')],
  }),
  'reviewer unavailable': (mode) => ({ ...adjudicationBase(), mode, reviews: [failed(PRIMARY, 'provider-error')] }),
  'reviewer escalates': (mode) => ({
    ...adjudicationBase(),
    mode,
    reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'ESCALATE' }))],
  }),
  'nothing blocks': (mode) => ({ ...adjudicationBase(), mode }),
  'blocking at the round limit': (mode) => ({
    ...adjudicationBase({ round: 2 }),
    mode,
    reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [HIGH] }))],
  }),
  'blocking below the round limit': (mode) => ({
    ...adjudicationBase(),
    mode,
    reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [HIGH] }))],
  }),
};

test('rule table is total and deterministic', () => {
  // Independent statement of the rule table: rule, gating outcome, shadow outcome.
  const expected: Record<string, { rule: string; gating: [string, string | null]; shadow: [string, string | null] | 'BLOCK' }> = {
    'push guard blocks': { rule: 'A1', gating: ['BLOCK', 'secret-in-diff'], shadow: 'BLOCK' },
    'packet over budget': { rule: 'A3', gating: ['ESCALATE', 'packet-over-budget'], shadow: ['ESCALATE', 'packet-over-budget'] },
    'egress not clear': { rule: 'A4', gating: ['ESCALATE', 'egress-stopped'], shadow: ['ESCALATE', 'egress-stopped'] },
    'no eligible reviewer': {
      rule: 'A5',
      gating: ['ESCALATE', 'independence-unsatisfiable'],
      shadow: ['ESCALATE', 'independence-unsatisfiable'],
    },
    'budget insufficient': { rule: 'A6', gating: ['ESCALATE', 'budget-exhausted'], shadow: ['ESCALATE', 'budget-exhausted'] },
    'reviewer unavailable': { rule: 'A7', gating: ['ESCALATE', 'reviewer-unavailable'], shadow: ['ESCALATE', 'reviewer-unavailable'] },
    'reviewer escalates': { rule: 'A8', gating: ['ESCALATE', 'reviewer-escalated'], shadow: ['ESCALATE', 'reviewer-escalated'] },
    'nothing blocks': { rule: 'A9', gating: ['PROCEED', null], shadow: ['PROCEED', null] },
    'blocking at the round limit': { rule: 'A10', gating: ['ESCALATE', 'max-repair-rounds'], shadow: ['ESCALATE', 'max-repair-rounds'] },
    'blocking below the round limit': { rule: 'A11', gating: ['REPAIR', 'blocking-findings'], shadow: ['REPAIR', 'blocking-findings'] },
  };
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(expected).sort());

  for (const [name, build] of Object.entries(SCENARIOS)) {
    const want = expected[name]!;

    const gating = adjudicate(build('gating')).record;
    assert.equal(gating.ruleFired, want.rule, `${name} (gating)`);
    assert.equal(gating.outcome, want.gating[0], `${name} (gating)`);
    assert.equal(gating.reason, want.gating[0] === 'REPAIR' || want.gating[0] === 'PROCEED' ? null : want.gating[1], name);
    assert.equal(gating.shadow, null, name);

    // Shadow mode never decides anything but PROCEED or BLOCK; the gating outcome is recorded only.
    const shadow = adjudicate(build('shadow')).record;
    assert.equal(shadow.ruleFired, want.rule, `${name} (shadow)`);
    if (want.shadow === 'BLOCK') {
      assert.equal(shadow.outcome, 'BLOCK', name);
      assert.equal(shadow.shadow, null, name);
    } else {
      assert.equal(shadow.outcome, 'PROCEED', name);
      assert.equal(shadow.reason, null, name);
      assert.equal(shadow.shadow?.wouldBe, want.shadow[0], name);
      assert.equal(shadow.shadow?.reason, want.shadow[1], name);
    }
    assert.ok(['PROCEED', 'BLOCK'].includes(shadow.outcome), name);
  }

  // Review not required: proceed without reviewers in that mode.
  const notRequired = adjudicate({ ...adjudicationBase(), mode: 'not-required', reviewers: [], reviews: [] }).record;
  assert.deepEqual([notRequired.ruleFired, notRequired.outcome, notRequired.shadow], ['A2', 'PROCEED', null]);
  // ...but a push-guard block still blocks.
  const notRequiredBlocked = SCENARIOS['push guard blocks']!('not-required');
  assert.equal(adjudicate({ ...notRequiredBlocked, reviewers: [], reviews: [] }).record.outcome, 'BLOCK');

  // Pure and input-derived: the same input gives the same record and id.
  const input = SCENARIOS['blocking below the round limit']!('gating');
  const first = adjudicate(input).record;
  assert.deepEqual(adjudicate(input).record, first);
  const shas = input.reviews.map((r) => r.recordSha256).filter((s): s is string => s !== null).sort();
  assert.equal(
    first.adjudicationId,
    sha256Hex([input.roundKey, input.policyVersion, input.packetSha256, input.checks.reportSha256, shas.join(',')].join('|')),
  );
  assert.equal(first.policyVersion, input.policyVersion);
  assert.deepEqual(first.inputs, {
    packetSha256: input.packetSha256,
    checkReportSha256: input.checks.reportSha256,
    reviewRecordSha256s: shas,
  });
  assert.deepEqual(first.fence, input.fence);
  const changed = adjudicate({ ...input, reviews: [{ ...input.reviews[0]!, recordSha256: 'e'.repeat(64) }] }).record;
  assert.notEqual(changed.adjudicationId, first.adjudicationId);

  // Inputs that do not describe one round are refused.
  assert.throws(() => adjudicate({ ...input, reviews: [] }));
  assert.throws(() => adjudicate({ ...input, checks: { ...input.checks, egress: { ...input.checks.egress, packetSha256: 'f'.repeat(64) } } }));
});

test('deterministic evidence outranks model review', () => {
  // A deterministic false-green finding blocks even when the model approves.
  const world = fixtureWorld({ unitStdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n' });
  const base = adjudicationBase({ world });
  const zero = base.checks.findings.find((f) => f.ruleId === 'zero-tests-executed');
  assert.ok(zero, 'fixture must produce a deterministic finding');
  const { record } = adjudicate({ ...base, reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'APPROVE' }))] });
  assert.equal(record.outcome, 'REPAIR');
  assert.deepEqual(
    record.blocking.map((b) => [b.source, b.raisedBy]),
    [['deterministic', 'deterministic:zero-tests-executed']],
  );

  // Informational deterministic findings never block.
  const info = adjudicationBase();
  const withInfo = {
    ...info,
    checks: {
      ...info.checks,
      findings: [
        {
          ...zero,
          ruleId: 'lockfile-changed',
          raisedBy: 'deterministic:lockfile-changed',
          severity: 'INFO' as const,
          file: 'pnpm-lock.yaml',
          fingerprint: 'b'.repeat(64),
        },
      ],
    },
  };
  assert.equal(adjudicate(withInfo).record.outcome, 'PROCEED');

  // Findings are unioned across reviewers and de-duplicated by fingerprint per raiser.
  const twoReviewers: AdjudicationInput = {
    ...adjudicationBase(),
    reviewers: [
      { reviewerConfigId: PRIMARY, role: 'primary', independentOfImplementer: true },
      { reviewerConfigId: COMPARATOR, role: 'comparator', independentOfImplementer: true },
    ],
    reviews: [
      completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [HIGH, { ...HIGH, key: 'f2', lineStart: 3, lineEnd: 3 }] })),
      completedReview(COMPARATOR, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [HIGH] })),
    ],
  };
  const union = adjudicate(twoReviewers).record;
  assert.deepEqual(union.blocking.map((b) => b.raisedBy).sort(), [COMPARATOR, PRIMARY]);
  assert.equal(union.outcome, 'REPAIR');
});

test('model verdict cannot override findings or deterministic failures', () => {
  // An approval with a grounded blocking finding is decided by the finding.
  const approveWithFinding = adjudicate({
    ...adjudicationBase(),
    reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'APPROVE', findings: [HIGH] }))],
  }).record;
  assert.equal(approveWithFinding.outcome, 'REPAIR');
  assert.deepEqual(approveWithFinding.verdictMismatches, [{ reviewerConfigId: PRIMARY, verdict: 'APPROVE', groundedBlockingCount: 1 }]);

  // Changes requested without a grounded blocking finding do not block.
  const generic = adjudicate({
    ...adjudicationBase(),
    reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [{ ...HIGH, severity: 'LOW' }] }))],
  }).record;
  assert.equal(generic.outcome, 'PROCEED');
  assert.deepEqual(generic.verdictMismatches, [{ reviewerConfigId: PRIMARY, verdict: 'REQUEST_CHANGES', groundedBlockingCount: 0 }]);

  // A citation outside the packet is refuted by rule and never blocks.
  const outside = adjudicate({
    ...adjudicationBase(),
    reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [{ ...HIGH, file: 'src/invented.ts' }] }))],
  });
  assert.equal(outside.record.outcome, 'PROCEED');
  assert.deepEqual(outside.record.grounding.map((g) => [g.grounded, g.reason]), [[false, 'path-not-in-packet']]);
  const refuted = outside.findings.find((f) => f.source === 'model')!;
  assert.equal(refuted.lifecycleState, 'REFUTED');
  assert.equal(refuted.blocking, false);

  // A deterministic push-guard failure is not cleared by any verdict.
  const blocked = SCENARIOS['push guard blocks']!('gating');
  assert.equal(adjudicate(blocked).record.outcome, 'BLOCK');
});

test('reviewer failure escalates in gating mode', () => {
  const failures: readonly ReviewInput[] = [
    failed(PRIMARY, 'provider-error'),
    failed(PRIMARY, 'served-model-drift'),
    failed(PRIMARY, 'refused'),
    failed(PRIMARY, 'incomplete'),
    failed(PRIMARY, 'budget-exhausted'),
    failed(PRIMARY, 'malformed', 'COMPLETED_INVALID'),
  ];
  for (const review of failures) {
    const gating = adjudicate({ ...adjudicationBase(), reviews: [review] }).record;
    assert.deepEqual([gating.outcome, gating.reason], ['ESCALATE', 'reviewer-unavailable'], review.failureReason!);
    const shadow = adjudicate({ ...adjudicationBase(), mode: 'shadow', reviews: [review] }).record;
    assert.equal(shadow.outcome, 'PROCEED');
    assert.equal(shadow.shadow?.wouldBe, 'ESCALATE');
  }
  // One failing reviewer is enough even when the other approved.
  const mixed = adjudicate({
    ...adjudicationBase(),
    reviewers: [
      { reviewerConfigId: PRIMARY, role: 'primary', independentOfImplementer: true },
      { reviewerConfigId: COMPARATOR, role: 'comparator', independentOfImplementer: true },
    ],
    reviews: [completedReview(PRIMARY, reviewOutput()), failed(COMPARATOR, 'rate-limited')],
  }).record;
  assert.equal(mixed.outcome, 'ESCALATE');
});

test('over-budget and context overflow escalate in gating and are recorded in shadow', () => {
  const overBudget = SCENARIOS['packet over budget']!;
  assert.deepEqual(
    [adjudicate(overBudget('gating')).record.outcome, adjudicate(overBudget('gating')).record.reason],
    ['ESCALATE', 'packet-over-budget'],
  );
  assert.equal(adjudicate(overBudget('shadow')).record.shadow?.wouldBe, 'ESCALATE');

  const overflow = { ...adjudicationBase(), reviews: [failed(PRIMARY, 'context-overflow')] };
  const gating = adjudicate(overflow).record;
  assert.deepEqual([gating.ruleFired, gating.outcome, gating.reason], ['A3', 'ESCALATE', 'packet-over-budget']);
  const shadow = adjudicate({ ...overflow, mode: 'shadow' }).record;
  assert.deepEqual([shadow.outcome, shadow.shadow?.wouldBe, shadow.shadow?.reason], ['PROCEED', 'ESCALATE', 'packet-over-budget']);
});

function priorFinding(over: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    id: 'prior-1',
    source: 'model',
    raisedBy: PRIMARY,
    fingerprint: findingFingerprint({ category: 'CORRECTNESS', file: 'src/feature.ts', lineStart: 2, ruleId: null }),
    severity: 'HIGH',
    category: 'CORRECTNESS',
    evidence: MODEL_EVIDENCE,
    requiredFix: MODEL_FIX,
    grounded: true,
    lifecycleState: 'OPEN',
    file: 'src/feature.ts',
    lineStart: 2,
    lineEnd: 2,
    ...over,
  };
}

const RESOLVED: PriorFindingClaimOutput = {
  priorFindingId: 'prior-1',
  status: 'RESOLVED',
  evidence: 'the name is now escaped before it is interpolated into the greeting',
  resolutionFile: 'src/feature.ts',
  resolutionLine: 2,
};

function reReview(
  claims: { readonly primary?: PriorFindingClaimOutput[]; readonly comparator?: PriorFindingClaimOutput[] },
  over: Partial<AdjudicationInput> = {},
) {
  const base = adjudicationBase({ round: 2 });
  return {
    ...base,
    maxRounds: 3,
    reviewers: [
      { reviewerConfigId: PRIMARY, role: 'primary' as const, independentOfImplementer: true },
      { reviewerConfigId: COMPARATOR, role: 'comparator' as const, independentOfImplementer: true },
    ],
    reviews: [
      completedReview(PRIMARY, reviewOutput({ priorFindingClaims: claims.primary ?? [] })),
      completedReview(COMPARATOR, reviewOutput({ priorFindingClaims: claims.comparator ?? [] })),
    ],
    priorFindings: [{ record: priorFinding(), waiverExpiresAt: null }],
    ...over,
  } satisfies AdjudicationInput;
}

test('closure without change keeps the finding open', () => {
  // The repair changed only src/util.ts; a claim citing src/feature.ts is a closure without change.
  const delta = parseUnifiedDiff(
    'diff --git a/src/util.ts b/src/util.ts\n--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1 +1,2 @@\n export const answer = 42;\n+export const other = 7;\n',
  );
  const open = adjudicate(reReview({ comparator: [RESOLVED] }, { repairDelta: delta })).record;
  assert.deepEqual(open.closureDecisions[0], {
    priorFindingId: 'prior-1',
    raisedBy: PRIMARY,
    claims: [{ by: COMPARATOR, status: 'RESOLVED' }],
    effectiveState: 'OPEN',
    rule: 'closure-without-change',
  });
  assert.equal(open.outcome, 'REPAIR');

  // A finding the raiser had claimed fixed is reopened.
  const wasFixed = reReview(
    { primary: [RESOLVED] },
    { repairDelta: delta, priorFindings: [{ record: priorFinding({ lifecycleState: 'FIXED' }), waiverExpiresAt: null }] },
  );
  const reopened = adjudicate(wasFixed).record.closureDecisions[0]!;
  assert.deepEqual([reopened.effectiveState, reopened.rule], ['OPEN', 'closure-without-change']);
});

test('closure authority decides which prior findings still block', () => {
  // A different, independent reviewer with a grounded resolution in the repair delta verifies.
  const verified = adjudicate(reReview({ comparator: [RESOLVED] })).record;
  assert.deepEqual([verified.closureDecisions[0]!.effectiveState, verified.closureDecisions[0]!.rule], ['VERIFIED', 'independent-reviewer']);
  assert.equal(verified.outcome, 'PROCEED');

  // The raiser's own claim only moves the finding to FIXED, which still blocks.
  const raiserOnly = adjudicate(reReview({ primary: [RESOLVED] })).record;
  assert.deepEqual([raiserOnly.closureDecisions[0]!.effectiveState, raiserOnly.closureDecisions[0]!.rule], ['FIXED', 'raiser-claim']);
  assert.equal(raiserOnly.outcome, 'REPAIR');
  assert.deepEqual(raiserOnly.blocking.map((b) => b.findingRef), ['prior:prior-1']);

  // A reviewer that shares the implementer's family cannot verify.
  const dependent = reReview({ comparator: [RESOLVED] });
  const notIndependent = adjudicate({
    ...dependent,
    reviewers: [dependent.reviewers[0]!, { ...dependent.reviewers[1]!, independentOfImplementer: false }],
  }).record;
  assert.notEqual(notIndependent.closureDecisions[0]!.effectiveState, 'VERIFIED');
  assert.equal(notIndependent.outcome, 'REPAIR');

  // An ungrounded resolution does not verify.
  const thin = adjudicate(reReview({ comparator: [{ ...RESOLVED, evidence: 'fixed' }] })).record;
  assert.notEqual(thin.closureDecisions[0]!.effectiveState, 'VERIFIED');

  // At the round limit an unverified prior finding escalates.
  const limit = adjudicate({ ...reReview({ primary: [RESOLVED] }), maxRounds: 2 }).record;
  assert.deepEqual([limit.outcome, limit.reason], ['ESCALATE', 'max-repair-rounds']);

  // Deterministic findings close only when their rule no longer fires.
  const detRecord: ReviewFindingRecord = {
    id: 'prior-det',
    source: 'deterministic',
    raisedBy: 'deterministic:zero-tests-executed',
    fingerprint: findingFingerprint({ category: 'EVIDENCE_INTEGRITY', file: 'check:unit', lineStart: null, ruleId: 'zero-tests-executed' }),
    severity: 'HIGH',
    category: 'EVIDENCE_INTEGRITY',
    evidence: 'check "unit" (pnpm test) exited 0 but its node:test summary reports 0 tests',
    requiredFix: 'Make the check execute the tests it is meant to run',
    grounded: true,
    lifecycleState: 'OPEN',
    ruleId: 'zero-tests-executed',
  };
  const clean = adjudicate({ ...reReview({}), priorFindings: [{ record: detRecord, waiverExpiresAt: null }] }).record;
  assert.deepEqual([clean.closureDecisions[0]!.effectiveState, clean.closureDecisions[0]!.rule], ['VERIFIED', 'deterministic-recheck']);
  assert.equal(clean.outcome, 'PROCEED');
  const stillFiring = reReview({});
  const zeroWorld = adjudicationBase({ world: fixtureWorld({ round: 2, unitStdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n' }) });
  const firing = adjudicate({
    ...stillFiring,
    checks: zeroWorld.checks,
    packet: zeroWorld.packet,
    packetSha256: zeroWorld.packetSha256,
    priorFindings: [{ record: detRecord, waiverExpiresAt: null }],
  }).record;
  assert.deepEqual([firing.closureDecisions[0]!.effectiveState, firing.closureDecisions[0]!.rule], ['OPEN', 'unchanged']);
  // A model cannot close a deterministic finding.
  const modelClaim = adjudicate({
    ...reReview({ comparator: [{ ...RESOLVED, priorFindingId: 'prior-det' }] }),
    checks: zeroWorld.checks,
    packet: zeroWorld.packet,
    packetSha256: zeroWorld.packetSha256,
    priorFindings: [{ record: detRecord, waiverExpiresAt: null }],
  }).record;
  assert.equal(modelClaim.closureDecisions[0]!.effectiveState, 'OPEN');

  // Findings already settled by a human stay settled; an expired waiver blocks again.
  for (const state of ['VERIFIED', 'REFUTED', 'WAIVED'] as const) {
    const settled = adjudicate({
      ...reReview({}),
      priorFindings: [{ record: priorFinding({ lifecycleState: state }), waiverExpiresAt: state === 'WAIVED' ? '2026-12-01T00:00:00.000Z' : null }],
    }).record;
    assert.equal(settled.outcome, 'PROCEED', state);
  }
  const expired = adjudicate({
    ...reReview({}),
    priorFindings: [{ record: priorFinding({ lifecycleState: 'WAIVED' }), waiverExpiresAt: '2026-10-01T00:00:00.000Z' }],
  }).record;
  assert.equal(expired.outcome, 'REPAIR');
});
