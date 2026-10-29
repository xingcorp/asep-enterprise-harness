import test from 'node:test';
import assert from 'node:assert/strict';
import { AdjudicationInputError, adjudicate, type Adjudication, type AdjudicationInput, type ReviewInput } from './adjudication.js';
import { sha256Hex } from './canonical-json.js';
import { parseUnifiedDiff } from './diff.js';
import { sarifFindings } from './checks.js';
import { findingFingerprint, type CheckFinding } from './findings.js';
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
  worldFromDiff,
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
    sha256Hex(JSON.stringify([input.roundKey, input.policyVersion, input.packetSha256, input.checks.reportSha256, shas])),
  );
  assert.equal(first.policyVersion, input.policyVersion);
  assert.deepEqual(first.inputs, {
    packetSha256: input.packetSha256,
    checkReportSha256: input.checks.reportSha256,
    reviewRecordSha256s: shas,
  });
  assert.deepEqual(first.fence, { leaseId: 'lease-1', fencingEpoch: 1 });
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

  // Findings are unioned across reviewers; one reviewer's findings with different keys
  // stay distinct even at one fingerprint.
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
  assert.deepEqual(union.blocking.map((b) => b.raisedBy).sort(), [COMPARATOR, PRIMARY, PRIMARY]);
  assert.equal(union.outcome, 'REPAIR');
});

/** Every ordering of a list. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('findings are grounded before they merge and the outcome ignores their order', () => {
  // Four findings at one location (one fingerprint): two share key k1, two share key k2.
  // k1: LOW and CRITICAL, both grounded. k2: an ungrounded CRITICAL (its lines run past
  // the file) and a grounded HIGH. Expected, stated independently: two identities, both
  // grounded, blocking at CRITICAL and HIGH, so gating requests a repair.
  const findings = [
    modelFinding({ key: 'k1', severity: 'LOW', lineStart: 2, lineEnd: 2 }),
    modelFinding({ key: 'k1', severity: 'CRITICAL', lineStart: 3, lineEnd: 3 }),
    modelFinding({ key: 'k2', severity: 'CRITICAL', lineStart: 2, lineEnd: 40 }),
    modelFinding({ key: 'k2', severity: 'HIGH', lineStart: 2, lineEnd: 2 }),
  ];
  const orders = permutations(findings);
  assert.equal(orders.length, 24);
  const decide = (list: readonly (typeof findings)[number][]) =>
    adjudicate({ ...adjudicationBase(), reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: list }))] });
  const first = decide(orders[0]!);
  assert.equal(first.record.outcome, 'REPAIR');
  assert.deepEqual(first.record.blocking.map((b) => b.severity).sort(), ['CRITICAL', 'HIGH']);
  assert.deepEqual(first.record.grounding.map((g) => g.grounded), [true, true]);
  for (const order of orders) assert.deepEqual(decide(order), first, JSON.stringify(order.map((f) => `${f.key}:${f.severity}`)));
  // The same holds in shadow mode, where the would-be outcome is what changes.
  const shadow = (list: readonly (typeof findings)[number][]) =>
    adjudicate({
      ...adjudicationBase(),
      mode: 'shadow',
      reviews: [completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: list }))],
    }).record.shadow;
  for (const order of orders) assert.deepEqual(shadow(order), { wouldBe: 'REPAIR', reason: 'blocking-findings', blockingFindings: 2 });

  // Never merged across requirement ids or keys: a LOW cannot absorb a HIGH that cites
  // another requirement, and two keys stay two findings.
  const acrossRequirements = decide([
    modelFinding({ key: 'k1', severity: 'LOW', requirementId: 'REQ-2' }),
    modelFinding({ key: 'k1', severity: 'HIGH', requirementId: 'REQ-1' }),
  ]).record;
  assert.equal(acrossRequirements.outcome, 'REPAIR');
  assert.equal(acrossRequirements.grounding.length, 2);
  assert.deepEqual(acrossRequirements.blocking.map((b) => b.severity), ['HIGH']);
  const acrossKeys = decide([modelFinding({ key: 'k1', severity: 'LOW' }), modelFinding({ key: 'k2', severity: 'LOW' })]).record;
  assert.equal(acrossKeys.grounding.length, 2);
  assert.equal(acrossKeys.outcome, 'PROCEED');
  // An ungrounded finding alone still never blocks.
  assert.equal(decide([modelFinding({ key: 'k1', severity: 'CRITICAL', lineStart: 2, lineEnd: 40 })]).record.outcome, 'PROCEED');
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

test('a review whose status and output disagree is rejected', () => {
  // Output exists exactly for a valid completion. Every other pairing describes no real
  // review, so the round is refused rather than decided: a valid status without output
  // would otherwise count as a clean approval.
  const output = reviewOutput();
  const inconsistent: readonly ReviewInput[] = [
    { reviewerConfigId: PRIMARY, status: 'COMPLETED_VALID', failureReason: null, recordSha256: 'a'.repeat(64), output: null },
    ...(['COMPLETED_INVALID', 'FAILED', 'EGRESS_STOPPED', 'SKIPPED_PUSH_GUARD'] as const).map(
      (status): ReviewInput => ({ reviewerConfigId: PRIMARY, status, failureReason: 'any-reason', recordSha256: null, output }),
    ),
  ];
  for (const review of inconsistent) {
    for (const mode of ['gating', 'shadow'] as const) {
      assert.throws(
        () => adjudicate({ ...adjudicationBase(), mode, reviews: [review] }),
        (err: unknown) => err instanceof AdjudicationInputError && /must carry output exactly when it completed validly/.test(err.message),
        `${review.status} with${review.output === null ? 'out' : ''} output (${mode})`,
      );
    }
  }

  // The consistent pairs of the same statuses are decided.
  const consistent: readonly ReviewInput[] = [
    completedReview(PRIMARY, output),
    ...(['COMPLETED_INVALID', 'FAILED', 'EGRESS_STOPPED'] as const).map((status) => failed(PRIMARY, 'any-reason', status)),
  ];
  for (const review of consistent) assert.doesNotThrow(() => adjudicate({ ...adjudicationBase(), reviews: [review] }), review.status);
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

  // A rendered prompt over the budget is decided like an over-budget packet.
  const tooLarge = { ...adjudicationBase(), reviews: [failed(PRIMARY, 'prompt-over-budget')] };
  const refused = adjudicate(tooLarge).record;
  assert.deepEqual([refused.ruleFired, refused.outcome, refused.reason], ['A3', 'ESCALATE', 'packet-over-budget']);
  const shadowRefused = adjudicate({ ...tooLarge, mode: 'shadow' }).record;
  assert.deepEqual([shadowRefused.outcome, shadowRefused.shadow?.wouldBe], ['PROCEED', 'ESCALATE']);
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

test('a resolution citing unchanged context leaves the finding blocking', () => {
  // The repair adds only line 3 of src/feature.ts; line 2, the finding's line, is context
  // directly above it.
  const delta = parseUnifiedDiff(
    [
      'diff --git a/src/feature.ts b/src/feature.ts',
      '--- a/src/feature.ts',
      '+++ b/src/feature.ts',
      '@@ -1,2 +1,3 @@',
      ' export function greet(name: string): string {',
      '   return `hello ${name}`;',
      '+}',
      '',
    ].join('\n'),
  );
  const context = adjudicate(reReview({ comparator: [{ ...RESOLVED, resolutionLine: 2 }] }, { repairDelta: delta })).record;
  assert.notEqual(context.closureDecisions[0]!.effectiveState, 'VERIFIED');
  assert.equal(context.outcome, 'REPAIR');
  assert.deepEqual(context.blocking.map((b) => b.findingRef), ['prior:prior-1']);
  // Citing the added line itself verifies.
  const edited = adjudicate(reReview({ comparator: [{ ...RESOLVED, resolutionLine: 3 }] }, { repairDelta: delta })).record;
  assert.deepEqual([edited.closureDecisions[0]!.effectiveState, edited.closureDecisions[0]!.rule], ['VERIFIED', 'independent-reviewer']);
  assert.equal(edited.outcome, 'PROCEED');
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

/** An OPEN HIGH SARIF finding of an earlier round: semgrep's js.eval-use at src/feature.ts:2. */
const SARIF_PRIOR: ReviewFindingRecord = {
  id: 'prior-sarif',
  source: 'sarif',
  raisedBy: 'sarif:semgrep',
  fingerprint: findingFingerprint({ category: 'SECURITY', file: 'src/feature.ts', lineStart: 2, ruleId: 'js.eval-use' }),
  severity: 'HIGH',
  category: 'SECURITY',
  evidence: '[js.eval-use] eval() on user input',
  requiredFix: 'Resolve the Semgrep result js.eval-use reported by check semgrep',
  grounded: true,
  lifecycleState: 'OPEN',
  ruleId: 'js.eval-use',
  file: 'src/feature.ts',
  lineStart: 2,
  lineEnd: 2,
};

test('a SARIF finding blocks until a human closes it', () => {
  const base = reReview({ comparator: [{ ...RESOLVED, priorFindingId: 'prior-sarif' }] });
  const round = (over: { readonly state?: ReviewFindingRecord['lifecycleState']; readonly findings?: readonly CheckFinding[] } = {}) =>
    adjudicate({
      ...base,
      checks: { ...base.checks, findings: over.findings ?? base.checks.findings },
      priorFindings: [{ record: { ...SARIF_PRIOR, lifecycleState: over.state ?? 'OPEN' }, waiverExpiresAt: null }],
    }).record;
  const decided = (record: ReturnType<typeof round>) => [record.closureDecisions[0]!.effectiveState, record.closureDecisions[0]!.rule, record.outcome];

  // An OPEN HIGH SARIF prior that this round does not report again still blocks. An
  // independent reviewer's grounded RESOLVED claim on it changes nothing.
  const absent = round();
  assert.deepEqual(decided(absent), ['OPEN', 'unchanged', 'REPAIR']);
  assert.deepEqual(absent.blocking.map((b) => [b.findingRef, b.source, b.reason]), [['prior:prior-sarif', 'sarif', 'prior-finding']]);
  assert.equal(absent.ruleFired, 'A11');
  const shadow = adjudicate({ ...base, mode: 'shadow', priorFindings: [{ record: SARIF_PRIOR, waiverExpiresAt: null }] }).record;
  assert.equal(shadow.shadow?.wouldBe, 'REPAIR');

  // The result is still reported: this round's finding blocks, and the prior is not counted twice.
  const current: CheckFinding = {
    source: 'sarif',
    raisedBy: 'sarif:semgrep',
    ruleId: 'js.eval-use',
    severity: 'HIGH',
    category: 'SECURITY',
    file: 'src/feature.ts',
    lineStart: 2,
    lineEnd: 2,
    evidence: '[js.eval-use] eval() on user input',
    requiredFix: 'Resolve the Semgrep result js.eval-use reported by check semgrep',
    fingerprint: SARIF_PRIOR.fingerprint,
    unresolvedReference: false,
  };
  const stillThere = round({ findings: [current] });
  assert.deepEqual(decided(stillThere), ['OPEN', 'unchanged', 'REPAIR']);
  assert.deepEqual(stillThere.blocking.map((b) => b.findingRef), [`sarif:semgrep#${SARIF_PRIOR.fingerprint}`]);

  // A reviewer's claim decides nothing about it, even one citing a file the repair did not
  // change: the finding is neither closed nor reopened.
  const delta = parseUnifiedDiff(
    'diff --git a/src/util.ts b/src/util.ts\n--- a/src/util.ts\n+++ b/src/util.ts\n@@ -1 +1,2 @@\n export const answer = 42;\n+export const other = 7;\n',
  );
  for (const state of ['OPEN', 'FIXED'] as const) {
    const outside = adjudicate({ ...base, repairDelta: delta, priorFindings: [{ record: { ...SARIF_PRIOR, lifecycleState: state }, waiverExpiresAt: null }] }).record;
    assert.deepEqual(decided(outside), [state, 'unchanged', 'REPAIR'], state);
  }

  // Only a human disposition, persisted before the round, settles it, and it stays settled.
  for (const state of ['VERIFIED', 'CLOSED', 'REFUTED'] as const) {
    assert.deepEqual(decided(round({ state })), [state, 'unchanged', 'PROCEED'], state);
  }
});

test('a scanner log claiming a SARIF finding gone does not close it', () => {
  // The strongest claim a log can make: the scanner the prior was raised by, at the version it
  // was raised at, ran the rule over the file, every invocation completed, and nothing was
  // reported. The log goes through the real check step; the prior still blocks.
  const log = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'semgrep', version: '1.90.0', rules: [{ id: 'js.eval-use', defaultConfiguration: { enabled: true } }] } },
        invocations: [{ executionSuccessful: true }],
        artifacts: [{ location: { uri: 'src/feature.ts' }, roles: ['analysisTarget'] }],
        results: [],
      },
    ],
  };
  const checked = adjudicationBase({ round: 2, sarif: [{ checkId: 'semgrep', content: new TextEncoder().encode(JSON.stringify(log)) }] });
  assert.deepEqual(checked.checks.findings.filter((f) => f.source === 'sarif' || f.ruleId === 'sarif-malformed'), []);
  const raisedAt = { scannerVersion: '1.90.0' };
  const record = adjudicate({
    ...reReview({ comparator: [{ ...RESOLVED, priorFindingId: 'prior-sarif' }] }),
    checks: checked.checks,
    priorFindings: [{ record: SARIF_PRIOR, waiverExpiresAt: null, ...raisedAt }],
  }).record;
  assert.deepEqual(
    [record.closureDecisions[0]!.effectiveState, record.closureDecisions[0]!.rule, record.outcome, record.blocking.map((b) => b.findingRef)],
    ['OPEN', 'unchanged', 'REPAIR', ['prior:prior-sarif']],
  );
});

test('a finding with an unresolved reference is never linked to a prior', () => {
  // A SARIF result whose file sits under a base the harness cannot bind, raised in an earlier
  // round and again now: the same raiser and fingerprint, both flagged.
  const fingerprint = sha256Hex(
    JSON.stringify(['SECURITY', 'check:semgrep', null, 'js.eval-use', 'unresolved-reference', '{"artifactLocation":{"uri":"src/feature.ts","uriBaseId":"FOREIGN"},"ruleId":"js.eval-use"}']),
  );
  const evidence = '[unresolved reference: artifactLocation.uriBaseId] [js.eval-use] eval() on user input';
  const current: CheckFinding = {
    source: 'sarif',
    raisedBy: 'sarif:semgrep',
    ruleId: 'js.eval-use',
    severity: 'HIGH',
    category: 'SECURITY',
    file: null,
    lineStart: null,
    lineEnd: null,
    evidence,
    requiredFix: 'Resolve the semgrep result js.eval-use reported by check semgrep',
    fingerprint,
    unresolvedReference: true,
  };
  const prior: ReviewFindingRecord = {
    id: 'prior-flagged',
    source: 'sarif',
    raisedBy: 'sarif:semgrep',
    fingerprint,
    severity: 'HIGH',
    category: 'SECURITY',
    evidence,
    requiredFix: current.requiredFix,
    grounded: true,
    lifecycleState: 'OPEN',
    ruleId: 'js.eval-use',
    unresolvedReference: true,
  };
  const round = (state: ReviewFindingRecord['lifecycleState'], waiverExpiresAt: string | null) => {
    const base = reReview({});
    return adjudicate({
      ...base,
      checks: { ...base.checks, findings: [...base.checks.findings, current] },
      priorFindings: [{ record: { ...prior, lifecycleState: state }, waiverExpiresAt }],
    });
  };
  const ref = `sarif:semgrep#${fingerprint}`;

  // An open prior: the flagged finding does not carry it, so each blocks on its own.
  const open = round('OPEN', null);
  assert.deepEqual(open.record.blocking.map((b) => b.findingRef).sort(), ['prior:prior-flagged', ref].sort());
  const evaluated = open.findings.find((f) => f.ref === ref)!;
  assert.deepEqual([evaluated.priorFindingId, evaluated.unresolvedReference, evaluated.lifecycleState], [undefined, true, 'OPEN']);

  // A waived prior shields nothing it is not linked to: the flagged finding still blocks.
  const waived = round('WAIVED', '2026-12-01T00:00:00.000Z');
  assert.deepEqual(waived.record.blocking.map((b) => b.findingRef), [ref]);
  assert.equal(waived.record.outcome, 'REPAIR');
});

test('a re-raised finding is reconciled with its prior before it blocks', () => {
  const LIVE = '2026-12-01T00:00:00.000Z';
  const LAPSED = '2026-10-01T00:00:00.000Z';
  // The primary reviewer raises again what it raised in an earlier round: the same raiser,
  // fingerprint and requirement id. The finding key is local to one output, so it differs.
  const reRaise = (
    record: Partial<ReviewFindingRecord>,
    waiverExpiresAt: string | null = null,
    findings = [modelFinding({ key: 'again' })],
    by = PRIMARY,
  ): Adjudication => {
    const base = reReview({});
    const output = reviewOutput({ verdict: 'REQUEST_CHANGES', findings });
    return adjudicate({
      ...base,
      reviews: base.reviews.map((r) => (r.reviewerConfigId === by ? completedReview(by, output) : r)),
      priorFindings: [{ record: priorFinding(record), waiverExpiresAt }],
    });
  };
  const summary = (a: Adjudication) => {
    const current = a.findings.filter((f) => !f.ref.startsWith('prior:'));
    const name = (ref: string) => (current.some((f) => f.ref === ref) ? 'current' : ref);
    return {
      outcome: a.record.outcome,
      blocking: a.record.blocking.map((b) => name(b.findingRef)),
      current: current.map((f) => [f.priorFindingId ?? null, f.lifecycleState, f.blocking]),
      closure: a.record.closureDecisions.map((d) => [d.effectiveState, d.rule]),
    };
  };

  const cases: readonly (readonly [string, Adjudication, ReturnType<typeof summary>])[] = [
    // The review's probe: an unexpired waiver holds against the re-raise.
    [
      'live waiver',
      reRaise({ lifecycleState: 'WAIVED' }, LIVE),
      { outcome: 'PROCEED', blocking: [], current: [['prior-1', 'WAIVED', false]], closure: [['WAIVED', 'unchanged']] },
    ],
    [
      'expired waiver',
      reRaise({ lifecycleState: 'WAIVED' }, LAPSED),
      { outcome: 'REPAIR', blocking: ['current'], current: [['prior-1', 'OPEN', true]], closure: [['OPEN', 'unchanged']] },
    ],
    [
      'human refutation',
      reRaise({ lifecycleState: 'REFUTED' }),
      { outcome: 'PROCEED', blocking: [], current: [['prior-1', 'REFUTED', false]], closure: [['REFUTED', 'unchanged']] },
    ],
    [
      'adjudicated refutation',
      reRaise({ lifecycleState: 'ADJUDICATED' }),
      { outcome: 'PROCEED', blocking: [], current: [['prior-1', 'ADJUDICATED', false]], closure: [['ADJUDICATED', 'unchanged']] },
    ],
    // An ungrounded first citation the harness refuted cannot shield a grounded re-raise.
    [
      'harness refutation',
      reRaise({ lifecycleState: 'REFUTED', grounded: false, groundingReason: 'path-not-in-packet' }),
      { outcome: 'REPAIR', blocking: ['current'], current: [['prior-1', 'OPEN', true]], closure: [['REFUTED', 'unchanged']] },
    ],
    [
      'verified prior',
      reRaise({ lifecycleState: 'VERIFIED' }),
      { outcome: 'REPAIR', blocking: ['current'], current: [['prior-1', 'OPEN', true]], closure: [['VERIFIED', 'regression']] },
    ],
    [
      'closed prior',
      reRaise({ lifecycleState: 'CLOSED' }),
      { outcome: 'REPAIR', blocking: ['current'], current: [['prior-1', 'OPEN', true]], closure: [['CLOSED', 'regression']] },
    ],
    // A prior that still blocks is carried by the re-raise and not counted twice.
    [
      'open prior',
      reRaise({}),
      { outcome: 'REPAIR', blocking: ['current'], current: [['prior-1', 'OPEN', true]], closure: [['OPEN', 'unchanged']] },
    ],
    // Another identity is not the prior's finding.
    [
      'another requirement id',
      reRaise({ lifecycleState: 'WAIVED', requirementId: 'REQ-1' }, LIVE),
      { outcome: 'REPAIR', blocking: ['current'], current: [[null, 'OPEN', true]], closure: [['WAIVED', 'unchanged']] },
    ],
    [
      'another raiser',
      reRaise({ lifecycleState: 'WAIVED' }, LIVE, [modelFinding({ key: 'again' })], COMPARATOR),
      { outcome: 'REPAIR', blocking: ['current'], current: [[null, 'OPEN', true]], closure: [['WAIVED', 'unchanged']] },
    ],
    // An ungrounded re-raise links nothing, so the open prior still blocks on its own.
    [
      'ungrounded re-raise',
      reRaise({}, null, [modelFinding({ key: 'again', evidence: 'too short' })]),
      { outcome: 'REPAIR', blocking: ['prior:prior-1'], current: [[null, 'REFUTED', false]], closure: [['OPEN', 'unchanged']] },
    ],
  ];
  for (const [label, adjudication, expected] of cases) assert.deepEqual(summary(adjudication), expected, label);

  // The same holds for a deterministic rule that fires again.
  const zeroWorld = adjudicationBase({ world: fixtureWorld({ round: 2, unitStdout: 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n' }) });
  const firing = zeroWorld.checks.findings.find((f) => f.ruleId === 'zero-tests-executed')!;
  const detPrior = (lifecycleState: ReviewFindingRecord['lifecycleState'], waiverExpiresAt: string | null = null) =>
    adjudicate({
      ...reReview({}),
      checks: zeroWorld.checks,
      packet: zeroWorld.packet,
      packetSha256: zeroWorld.packetSha256,
      priorFindings: [
        {
          record: priorFinding({
            id: 'prior-det',
            source: 'deterministic',
            raisedBy: firing.raisedBy,
            fingerprint: firing.fingerprint,
            category: firing.category,
            ruleId: 'zero-tests-executed',
            lifecycleState,
          }),
          waiverExpiresAt,
        },
      ],
    });
  const others = zeroWorld.checks.findings.filter((f) => f !== firing && (f.severity === 'HIGH' || f.severity === 'CRITICAL'));
  assert.deepEqual(others, [], 'the fixture fires only the rule under test');
  assert.deepEqual(summary(detPrior('WAIVED', LIVE)).outcome, 'PROCEED');
  assert.deepEqual(summary(detPrior('WAIVED', LAPSED)).blocking, ['current']);
  assert.deepEqual(summary(detPrior('VERIFIED')).closure, [['VERIFIED', 'regression']]);
  assert.deepEqual(summary(detPrior('VERIFIED')).blocking, ['current']);
  assert.deepEqual(summary(detPrior('OPEN')).blocking, ['current']);
});

test('a re-raise never downgrades a prior that still blocks', () => {
  // The primary reviewer raises an earlier finding of its own again, at another severity. The
  // pair counts once, at the higher severity, and the prior stays open until it is closed.
  const reRaise = (priorSeverity: 'LOW' | 'HIGH' | 'CRITICAL', severity: 'LOW' | 'HIGH' | 'CRITICAL', over: Partial<ReviewFindingRecord> = {}, mode: Mode = 'gating') => {
    const base = reReview({});
    const output = reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [modelFinding({ key: 'again', severity })] });
    const adjudication = adjudicate({
      ...base,
      mode,
      reviews: base.reviews.map((r) => (r.reviewerConfigId === PRIMARY ? completedReview(PRIMARY, output) : r)),
      priorFindings: [{ record: priorFinding({ severity: priorSeverity, ...over }), waiverExpiresAt: null }],
    });
    const current = adjudication.findings.filter((f) => !f.ref.startsWith('prior:'));
    const name = (ref: string) => (current.some((f) => f.ref === ref) ? 'current' : ref);
    return {
      outcome: adjudication.record.outcome,
      wouldBe: adjudication.record.shadow?.wouldBe ?? null,
      blocking: adjudication.record.blocking.map((b) => [name(b.findingRef), b.severity]),
      current: current.map((f) => [f.priorFindingId ?? null, f.lifecycleState, f.blocking]),
      prior: adjudication.record.closureDecisions.map((d) => [d.priorFindingId, d.effectiveState, d.rule]),
    };
  };
  const stillOpen = [['prior-1', 'OPEN', 'unchanged']];
  const cases = [
    // The review's probe, and the same downgrade from CRITICAL.
    ['HIGH re-raised at LOW', reRaise('HIGH', 'LOW'), 'REPAIR', [['current', 'HIGH']], stillOpen],
    ['CRITICAL re-raised at LOW', reRaise('CRITICAL', 'LOW'), 'REPAIR', [['current', 'CRITICAL']], stillOpen],
    // The surviving mutation's counterexample: CRITICAL again at CRITICAL.
    ['CRITICAL re-raised at CRITICAL', reRaise('CRITICAL', 'CRITICAL'), 'REPAIR', [['current', 'CRITICAL']], stillOpen],
    // Raising a finding higher than before takes the new severity.
    ['LOW re-raised at HIGH', reRaise('LOW', 'HIGH'), 'REPAIR', [['current', 'HIGH']], stillOpen],
    ['LOW re-raised at LOW', reRaise('LOW', 'LOW'), 'PROCEED', [], stillOpen],
    // A regression of a verified HIGH re-raised at LOW blocks at HIGH.
    ['verified HIGH re-raised at LOW', reRaise('HIGH', 'LOW', { lifecycleState: 'VERIFIED' }), 'REPAIR', [['current', 'HIGH']], [['prior-1', 'VERIFIED', 'regression']]],
  ] as const;
  for (const [label, result, outcome, blocking, prior] of cases) {
    assert.deepEqual(
      { outcome: result.outcome, blocking: result.blocking, current: result.current, prior: result.prior },
      { outcome, blocking, current: [['prior-1', 'OPEN', outcome !== 'PROCEED']], prior },
      label,
    );
  }
  // Shadow mode records the same verdict.
  assert.deepEqual([reRaise('HIGH', 'LOW', {}, 'shadow').outcome, reRaise('HIGH', 'LOW', {}, 'shadow').wouldBe], ['PROCEED', 'REPAIR']);
  // A live waiver still shields the re-raise, whatever its severity.
  const waived = adjudicate({
    ...reReview({}),
    reviews: reReview({}).reviews.map((r) =>
      r.reviewerConfigId === PRIMARY ? completedReview(PRIMARY, reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [modelFinding({ key: 'again', severity: 'CRITICAL' })] })) : r,
    ),
    priorFindings: [{ record: priorFinding({ lifecycleState: 'WAIVED' }), waiverExpiresAt: '2026-12-01T00:00:00.000Z' }],
  }).record;
  assert.deepEqual([waived.outcome, waived.blocking], ['PROCEED', []]);
});

test('a SARIF re-raise never downgrades a prior that still blocks', () => {
  // The scanner reports again, at a lower level, the result it raised in an earlier round: the
  // same raiser and fingerprint. The pair counts once, at the higher severity, and the prior
  // stays open.
  const reRaise = (priorSeverity: 'HIGH' | 'CRITICAL', level: 'warning' | 'note', mode: Mode = 'gating') => {
    const log = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'semgrep', rules: [{ id: 'js.eval-use' }] } },
          results: [
            {
              ruleIndex: 0,
              level,
              message: { text: 'eval() on user input' },
              properties: { tags: ['security'] },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'src/feature.ts' }, region: { startLine: 2 } } }],
            },
          ],
        },
      ],
    };
    const findings = sarifFindings({ checkId: 'semgrep', content: new TextEncoder().encode(JSON.stringify(log)) });
    assert.deepEqual(
      findings.map((f) => [f.raisedBy, f.fingerprint]),
      [['sarif:semgrep', SARIF_PRIOR.fingerprint]],
    );
    const base = reReview({});
    const adjudication = adjudicate({
      ...base,
      mode,
      checks: { ...base.checks, findings: [...base.checks.findings, ...findings] },
      priorFindings: [{ record: { ...SARIF_PRIOR, severity: priorSeverity }, waiverExpiresAt: null }],
    });
    const current = adjudication.findings.filter((f) => f.source === 'sarif' && !f.ref.startsWith('prior:'));
    return {
      outcome: adjudication.record.outcome,
      wouldBe: adjudication.record.shadow?.wouldBe ?? null,
      blocking: adjudication.record.blocking.map((b) => [b.findingRef.startsWith('prior:') ? b.findingRef : 'current', b.severity]),
      current: current.map((f) => [f.priorFindingId ?? null, f.severity, f.lifecycleState, f.blocking]),
      prior: adjudication.record.closureDecisions.map((d) => [d.priorFindingId, d.effectiveState, d.rule]),
    };
  };
  const stillOpen = [['prior-sarif', 'OPEN', 'unchanged']];
  assert.deepEqual(reRaise('HIGH', 'warning'), {
    outcome: 'REPAIR',
    wouldBe: null,
    blocking: [['current', 'HIGH']],
    current: [['prior-sarif', 'HIGH', 'OPEN', true]],
    prior: stillOpen,
  });
  assert.deepEqual(reRaise('CRITICAL', 'note'), {
    outcome: 'REPAIR',
    wouldBe: null,
    blocking: [['current', 'CRITICAL']],
    current: [['prior-sarif', 'CRITICAL', 'OPEN', true]],
    prior: stillOpen,
  });
  // Shadow mode records the same verdict.
  const shadow = reRaise('HIGH', 'warning', 'shadow');
  assert.deepEqual([shadow.outcome, shadow.wouldBe, shadow.blocking], ['PROCEED', 'REPAIR', [['current', 'HIGH']]]);
});

test('blocking records are in canonical tuple order', () => {
  // Two open priors whose raisers differ where a line feed and a slash sort differently
  // escaped and raw. The record lists blocking entries by the canonical JSON of the tuple
  // (raiser, reference), stated here independently of the adjudicator.
  const raisers = ['a\nz', 'a/z'];
  const priors = raisers.map((raisedBy, i) => ({ record: priorFinding({ id: `prior-${i}`, raisedBy }), waiverExpiresAt: null }));
  for (const order of [priors, [...priors].reverse()]) {
    const record = adjudicate({ ...reReview({}), priorFindings: order }).record;
    const entries = record.blocking.map((b) => [b.raisedBy, b.findingRef]);
    const canonical = [...entries].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : JSON.stringify(x) > JSON.stringify(y) ? 1 : 0));
    assert.deepEqual(entries, canonical);
    assert.deepEqual(entries, [
      ['a/z', 'prior:prior-1'],
      ['a\nz', 'prior:prior-0'],
    ]);
  }
});

test('identity keys are canonical tuples and never collide', () => {
  // Fields that differ only in where a separator falls, or in null against "", name two
  // different findings. The work order cites every requirement id used here.
  const ids = ['REQ', 'REQ\nf1', ''];
  const round = (findings: readonly ReturnType<typeof modelFinding>[], prior: Partial<ReviewFindingRecord> | null) => {
    const base = reReview({});
    const output = reviewOutput({ verdict: 'REQUEST_CHANGES', findings: [...findings] });
    return adjudicate({
      ...base,
      packet: { ...base.packet, workOrder: { ...base.packet.workOrder, requirementIds: [...base.packet.workOrder.requirementIds, ...ids] } },
      reviews: base.reviews.map((r) => (r.reviewerConfigId === PRIMARY ? completedReview(PRIMARY, output) : r)),
      priorFindings: prior === null ? [] : [{ record: priorFinding(prior), waiverExpiresAt: '2026-12-01T00:00:00.000Z' }],
    });
  };
  const current = (a: Adjudication) =>
    a.findings.filter((f) => !f.ref.startsWith('prior:')).map((f) => [f.requirementId ?? null, f.priorFindingId ?? null, f.lifecycleState, f.blocking]);

  // The review's probe: a HIGH under "REQ\nf1" with key "x", and one under "REQ" with key
  // "f1\nx" that a live waiver covers. The unwaived one still blocks.
  const waivedReq: Partial<ReviewFindingRecord> = { lifecycleState: 'WAIVED', requirementId: 'REQ' };
  const unwaived = modelFinding({ requirementId: 'REQ\nf1', key: 'x' });
  const waived = modelFinding({ requirementId: 'REQ', key: 'f1\nx' });
  assert.equal(round([unwaived], waivedReq).record.outcome, 'REPAIR');
  assert.equal(round([waived], waivedReq).record.outcome, 'PROCEED');
  const byRequirement = (rows: ReturnType<typeof current>) => [...rows].sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  for (const findings of [[unwaived, waived], [waived, unwaived]]) {
    const both = round(findings, waivedReq);
    assert.equal(both.record.outcome, 'REPAIR');
    assert.deepEqual(byRequirement(current(both)), [
      ['REQ', 'prior-1', 'WAIVED', false],
      ['REQ\nf1', null, 'OPEN', true],
    ]);
  }

  // null and "" are different requirement ids.
  const unset = round([modelFinding({ requirementId: null, key: 'k' }), modelFinding({ requirementId: '', key: 'k' })], null);
  assert.deepEqual(current(unset).map((f) => f[0]).length, 2);
  assert.deepEqual(new Set(current(unset).map((f) => f[0])), new Set([null, '']));

  // The adjudication id: moving a separator between two inputs changes it.
  const base = adjudicationBase();
  const idOf = (roundKey: string, policyVersion: string) => adjudicate({ ...base, roundKey, policyVersion }).record.adjudicationId;
  assert.notEqual(idOf('R|a', 'b'), idOf('R', 'a|b'));
  const shas = base.reviews.map((r) => r.recordSha256).filter((s): s is string => s !== null).sort();
  assert.equal(idOf('R', 'a|b'), sha256Hex(JSON.stringify(['R', 'a|b', base.packetSha256, base.checks.reportSha256, shas])));

  // One planned reviewer whose id joins two reviews' ids is not those two reviews.
  const joined = `${PRIMARY}\n${COMPARATOR}`;
  assert.throws(
    () =>
      adjudicate({
        ...reReview({}),
        reviewers: [{ reviewerConfigId: joined, role: 'primary', independentOfImplementer: true }],
      }),
    /reviews must match the planned reviewers/,
  );
});

test("waiver expiry is judged at the round's opening time", () => {
  const opened = '2026-10-29T09:00:00.000Z';
  const waived = (waiverExpiresAt: string) =>
    adjudicate({
      ...reReview({}),
      roundOpenedAt: opened,
      priorFindings: [{ record: priorFinding({ lifecycleState: 'WAIVED' }), waiverExpiresAt }],
    }).record;

  // A waiver that runs past the round's opening holds for the whole round, even when the
  // round is adjudicated after the waiver's expiry, so a later execution of the same round
  // cannot decide differently.
  const held = waived('2026-10-29T09:30:00.000Z');
  assert.equal(held.outcome, 'PROCEED');
  assert.deepEqual([held.closureDecisions[0]!.effectiveState, held.closureDecisions[0]!.rule], ['WAIVED', 'unchanged']);
  // A waiver that had expired when the round opened no longer covers the finding.
  const lapsed = waived('2026-10-29T08:59:59.999Z');
  assert.equal(lapsed.outcome, 'REPAIR');
  assert.deepEqual(lapsed.blocking.map((b) => b.findingRef), ['prior:prior-1']);

  // The decision record carries no timestamp, so its bytes depend only on the round's inputs.
  assert.equal(JSON.stringify(held).includes('2026-10-29'), false);
  assert.deepEqual(waived('2026-10-29T09:30:00.000Z'), held);
});

test('a shadow round blocked by the push guard carries no shadow verdict', () => {
  // A credential-shaped line, assembled at runtime so no literal secret is committed.
  const key = 'AKIA' + 'Z'.repeat(16);
  const world = worldFromDiff([{ path: 'src/k.ts', status: 'A', added: [`const k = '${key}';`] }]);
  const base = adjudicationBase({ world });
  assert.deepEqual(base.checks.pushGuard, { decision: 'BLOCK', reason: 'secret-in-diff' });
  const skipped: ReviewInput = { reviewerConfigId: PRIMARY, status: 'SKIPPED_PUSH_GUARD', failureReason: 'push-guard', recordSha256: null, output: null };

  // The push guard decides the round in every mode; the block is the outcome, not a verdict a
  // shadow round would only record, so no mode attaches a shadow verdict to it.
  for (const mode of ['shadow', 'gating', 'not-required'] as const) {
    const input = mode === 'not-required' ? { ...base, mode, reviewers: [], reviews: [] } : { ...base, mode, reviews: [skipped] };
    const record = adjudicate(input).record;
    assert.deepEqual([record.ruleFired, record.outcome, record.reason, record.shadow], ['A1', 'BLOCK', 'secret-in-diff', null], mode);
    assert.deepEqual(record.pushGuard, base.checks.pushGuard, mode);
  }

  // A shadow round that is not blocked records the verdict gating would have reached.
  const clean = adjudicate({ ...adjudicationBase(), mode: 'shadow' }).record;
  assert.equal(clean.outcome, 'PROCEED');
  assert.deepEqual(clean.shadow, { wouldBe: 'PROCEED', reason: null, blockingFindings: 0 });
});
