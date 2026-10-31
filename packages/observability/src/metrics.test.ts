import test from 'node:test';
import assert from 'node:assert/strict';
import { runEventFields, runEventTypes } from '@asep/contracts';
import {
  loadMeasurementDictionary,
  validateDictionary,
  assertDictionaryValid,
  metricNames,
  metricFamilies,
  formulaConditionFields,
  formulaConditions,
  splitFormula,
  type MeasurementDictionary,
} from './metrics.js';

// A fully-mutable projection used only to build negative-case fixtures. The
// canonical MetricDefinition is deeply readonly, so we clone into a loose shape
// the tests can rewrite freely, then cast back to the readonly type on the way
// into the validator.
type LooseMetric = Record<string, unknown> & {
  sourceEvents?: string[];
  numerator?: Record<string, unknown>;
  denominator?: Record<string, unknown>;
  dimensions?: string[];
  privacyClass?: string;
  zeroDenominatorPolicy?: string;
};
type MutableDict = {
  version: string;
  privacyClasses: Record<string, unknown>;
  metrics: LooseMetric[];
};

function clone(d: MeasurementDictionary): MutableDict {
  return JSON.parse(JSON.stringify(d)) as MutableDict;
}

test('the committed measurement dictionary is valid (referential integrity holds)', () => {
  const errors = validateDictionary(loadMeasurementDictionary());
  assert.deepEqual(errors, [], `dictionary errors: ${JSON.stringify(errors)}`);
});

test('assertDictionaryValid returns the dictionary and does not throw', () => {
  const dict = assertDictionaryValid();
  assert.ok(dict.metrics.length > 0);
});

test('every metric operand event is a real RunEvent.eventType', () => {
  const known = new Set(runEventTypes());
  for (const m of loadMeasurementDictionary().metrics) {
    for (const ev of m.sourceEvents) {
      assert.ok(known.has(ev), `${m.name}: source event ${ev} not in RunEvent catalog`);
    }
  }
});

test('every metric field is a real RunEvent property', () => {
  const known = new Set(runEventFields());
  for (const m of loadMeasurementDictionary().metrics) {
    const fields = [
      ...(m.numerator.fields ?? []),
      ...(m.denominator?.fields ?? []),
      ...(m.dimensions ?? []),
    ];
    for (const f of fields) {
      assert.ok(known.has(f), `${m.name}: field ${f} not a RunEvent property`);
    }
  }
});

test('dictionary covers all mandated metric families (E2)', () => {
  const families = new Set(metricFamilies());
  for (const required of [
    'product',
    'dora',
    'agent',
    'trajectory',
    'review',
    'harness',
    'cost',
    'human',
    'false-completion',
  ]) {
    assert.ok(families.has(required), `missing metric family "${required}"`);
  }
});

test('cost-per-accepted-task metric is present (E2)', () => {
  assert.ok(metricNames().includes('cost_per_accepted_task'));
});

test('false-completion-rate metric is present (E2)', () => {
  assert.ok(metricNames().includes('false_completion_rate'));
});

// --- negative cases: the validator must actually reject bad dictionaries -----

test('an unknown source event is rejected (referential integrity)', () => {
  const bad = clone(loadMeasurementDictionary());
  bad.metrics[0]!.sourceEvents = ['not.a.real.event' as unknown as never];
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(errors.some((e) => e.problem.includes('unknown source event')));
});

test('an unknown field is rejected (referential integrity)', () => {
  const bad = clone(loadMeasurementDictionary());
  (bad.metrics[0]!.numerator as { fields?: string[] }).fields = ['totallyMadeUpField'];
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(errors.some((e) => e.problem.includes('unknown field')));
});

test('an unknown dimension is rejected (referential integrity)', () => {
  const bad = clone(loadMeasurementDictionary());
  (bad.metrics[0] as { dimensions?: string[] }).dimensions = ['bogusDimension'];
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(errors.some((e) => e.problem.includes('unknown field')));
});

test('an unknown privacy class is rejected (closed enum)', () => {
  const bad = clone(loadMeasurementDictionary());
  bad.metrics[0]!.privacyClass = 'made-up-class' as unknown as never;
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(errors.some((e) => e.problem.includes('unknown privacyClass')));
});

test('a ratio metric with no zero-denominator policy is rejected', () => {
  const bad = clone(loadMeasurementDictionary());
  // Find a ratio metric (has a denominator with count/sum aggregation).
  const ratio = bad.metrics.find(
    (m) => m.denominator && (m.denominator.aggregation === 'count' || m.denominator.aggregation === 'sum'),
  );
  assert.ok(ratio, 'expected at least one ratio metric');
  delete (ratio as { zeroDenominatorPolicy?: string }).zeroDenominatorPolicy;
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(errors.some((e) => e.problem.includes('zeroDenominatorPolicy')));
});

test('every privacy class defines capture/redaction/retention/access rules (E4)', () => {
  const dict = loadMeasurementDictionary();
  for (const [name, rule] of Object.entries(dict.privacyClasses)) {
    assert.ok(rule.capture, `${name} missing capture`);
    assert.ok(rule.redaction, `${name} missing redaction`);
    assert.ok(typeof rule.retentionDays === 'number', `${name} missing retentionDays`);
    assert.ok(rule.access, `${name} missing access`);
  }
});

// --- P1-FINAL-MED-003: conjunctive filters + formula<->operand agreement -----

test('formulaConditionFields extracts every field from a multi-term where clause', () => {
  const fields = formulaConditionFields(
    'count(task.completed where outcome=accepted and repairCycles=0) / count(task.completed)',
  );
  assert.deepEqual([...fields].sort(), ['outcome', 'repairCycles']);
});

test('formulaConditionFields handles != terms and multiple where clauses', () => {
  const fields = formulaConditionFields(
    'count(a.b where failureClass!=x) / count(a.b where declaredComplete=true)',
  );
  assert.deepEqual([...fields].sort(), ['declaredComplete', 'failureClass']);
});

test('splitFormula splits on the top-level slash only, not slashes inside parens', () => {
  const { numerator, denominator } = splitFormula(
    'count(a.b where outcome=accepted) / count(a.b)',
  );
  assert.ok(numerator.includes('outcome=accepted'));
  assert.ok(!denominator.includes('outcome=accepted'));
  // a non-ratio formula returns the whole thing as numerator
  const single = splitFormula('mean(task.completed.toolCalls)');
  assert.equal(single.denominator, '');
});

test('the committed conjunctive metrics encode every where-clause term', () => {
  // first_attempt_pass_rate and false_completion_rate both have `A and B`
  // numerator where-clauses; they must carry a conjunctive `filters` array.
  const dict = loadMeasurementDictionary();
  for (const name of ['first_attempt_pass_rate', 'false_completion_rate']) {
    const m = dict.metrics.find((x) => x.name === name)!;
    assert.ok(m, `missing ${name}`);
    const conds = m.numerator.filters ?? (m.numerator.filter ? [m.numerator.filter] : []);
    const formulaFields = formulaConditionFields(splitFormula(m.formula).numerator);
    const condFields = new Set(conds.map((c) => c.field));
    for (const f of formulaFields) {
      assert.ok(condFields.has(f), `${name}: numerator operand missing filter for "${f}"`);
    }
    assert.ok(conds.length >= 2, `${name} should use a conjunctive filter`);
  }
});

test('formula<->operand drift: a formula where-term with no operand filter is rejected', () => {
  const bad = clone(loadMeasurementDictionary());
  const m = bad.metrics.find((x) => x.name === 'scope_violation_rate')!;
  // The formula says `where scopeViolation=true`; drop the operand filter so the
  // structured operand no longer encodes it — the validator must catch the drift.
  delete (m.numerator as { filter?: unknown }).filter;
  delete (m.numerator as { filters?: unknown }).filters;
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(
    errors.some((e) => e.metric === 'scope_violation_rate' && e.problem.includes('formula<->operand drift')),
    `expected drift error, got: ${JSON.stringify(errors)}`,
  );
});

test('formula<->operand drift: an operand filter absent from the formula is rejected', () => {
  const bad = clone(loadMeasurementDictionary());
  const m = bad.metrics.find((x) => x.name === 'scope_violation_rate')!;
  // Add a second operand filter the formula never mentions — must be caught.
  (m.numerator as { filters?: unknown[] }).filters = [
    { field: 'scopeViolation', equals: true },
    { field: 'escapedDefect', equals: true },
  ];
  delete (m.numerator as { filter?: unknown }).filter;
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(
    errors.some(
      (e) => e.metric === 'scope_violation_rate' && e.problem.includes('escapedDefect') && e.problem.includes('drift'),
    ),
    `expected drift error for escapedDefect, got: ${JSON.stringify(errors)}`,
  );
});

test('formula<->operand drift: a numerator/denominator condition swap is caught', () => {
  const bad = clone(loadMeasurementDictionary());
  const m = bad.metrics.find((x) => x.name === 'task_pass_rate')!;
  // task_pass_rate numerator formula is `where outcome=accepted`; move that
  // filter onto the denominator operand. Per-operand attribution must flag both
  // the missing numerator filter and the extraneous denominator filter.
  delete (m.numerator as { filter?: unknown }).filter;
  (m.denominator as { filter?: unknown }).filter = { field: 'outcome', equals: 'accepted' };
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  const swapErrors = errors.filter((e) => e.metric === 'task_pass_rate' && e.problem.includes('drift'));
  assert.ok(swapErrors.length >= 2, `expected numerator+denominator drift, got: ${JSON.stringify(errors)}`);
});

// --- P1-FINAL-MED-003: operator + value agreement, not just field name -------

test('formulaConditions parses field, operator AND value from each where term', () => {
  const conds = formulaConditions(
    'count(task.completed where outcome=accepted and repairCycles=0) / count(task.completed)',
  );
  assert.deepEqual(conds, [
    { field: 'outcome', operator: '=', value: 'accepted' },
    { field: 'repairCycles', operator: '=', value: '0' },
  ]);
});

test('formulaConditions parses != terms', () => {
  const conds = formulaConditions('count(a.b where failureClass!=workflow-recovery-failure)');
  assert.deepEqual(conds, [
    { field: 'failureClass', operator: '!=', value: 'workflow-recovery-failure' },
  ]);
});

test('BYPASS (MED-003): a VALUE mismatch is caught — formula =accepted vs operand =rejected', () => {
  // The old field-only check let this through: the operand filters the right
  // FIELD (outcome) but the WRONG VALUE (rejected). The metric would silently
  // compute the opposite of what its formula promises.
  const bad = clone(loadMeasurementDictionary());
  const m = bad.metrics.find((x) => x.name === 'task_pass_rate')!;
  (m.numerator as { filter?: unknown }).filter = { field: 'outcome', equals: 'rejected' };
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(
    errors.some(
      (e) =>
        e.metric === 'task_pass_rate' &&
        e.problem.includes('drift') &&
        e.problem.includes('outcome'),
    ),
    `expected a value-drift error, got: ${JSON.stringify(errors)}`,
  );
});

test('BYPASS (MED-003): an OPERATOR mismatch is caught — formula =accepted vs operand !=accepted', () => {
  // Same field, same value, but the operand negates the condition. Field-only
  // comparison misses this; operator-aware comparison must flag it.
  const bad = clone(loadMeasurementDictionary());
  const m = bad.metrics.find((x) => x.name === 'task_pass_rate')!;
  delete (m.numerator as { filter?: unknown }).filter;
  (m.numerator as { filter?: unknown }).filter = { field: 'outcome', notEquals: 'accepted' };
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(
    errors.some(
      (e) =>
        e.metric === 'task_pass_rate' &&
        e.problem.includes('drift') &&
        e.problem.includes('outcome'),
    ),
    `expected an operator-drift error, got: ${JSON.stringify(errors)}`,
  );
});

test('BYPASS (MED-003): a != value mismatch is caught on workflow_recovery_rate', () => {
  // Formula: `where failureClass!=workflow-recovery-failure`. Flip the operand
  // to a DIFFERENT excluded value; the field matches but the value does not.
  const bad = clone(loadMeasurementDictionary());
  const m = bad.metrics.find((x) => x.name === 'workflow_recovery_rate')!;
  (m.numerator as { filter?: unknown }).filter = {
    field: 'failureClass',
    notEquals: 'artifact-loss',
  };
  const errors = validateDictionary(bad as unknown as MeasurementDictionary);
  assert.ok(
    errors.some(
      (e) =>
        e.metric === 'workflow_recovery_rate' &&
        e.problem.includes('drift') &&
        e.problem.includes('failureClass'),
    ),
    `expected a !=-value drift error, got: ${JSON.stringify(errors)}`,
  );
});

test('a correct operator+value operand still validates (no false positive)', () => {
  // Sanity: the committed task_pass_rate (formula =accepted, operand equals
  // accepted) must NOT be flagged — the tightened check has no false positives.
  const dict = loadMeasurementDictionary();
  const errors = validateDictionary(dict).filter((e) => e.problem.includes('drift'));
  assert.deepEqual(errors, [], `no drift expected on committed dict, got: ${JSON.stringify(errors)}`);
});

// --- operand options for disposition metrics: dedupeLatestBy and cohortBy ------

function withNumerator(extra: Record<string, unknown>): MeasurementDictionary {
  const d = clone(loadMeasurementDictionary());
  const m = d.metrics.find((x) => x.name === 'review_ungrounded_rate')!;
  Object.assign(m.numerator!, extra);
  return d as unknown as MeasurementDictionary;
}

function errorsFor(dict: MeasurementDictionary, metric: string) {
  return validateDictionary(dict).filter((e) => e.metric === metric);
}

test('dedupeLatestBy and cohortBy are accepted on RunEvent fields of the right kind', () => {
  const dict = withNumerator({ dedupeLatestBy: 'findingId', cohortBy: 'reviewRoundCompletedAt' });
  assert.deepEqual(errorsFor(dict, 'review_ungrounded_rate'), []);
});

test('a dedupeLatestBy that is not a RunEvent field is rejected', () => {
  const errors = errorsFor(withNumerator({ dedupeLatestBy: 'noSuchField' }), 'review_ungrounded_rate');
  assert.ok(errors.some((e) => e.problem.includes('dedupeLatestBy') && e.problem.includes('noSuchField')), JSON.stringify(errors));
});

test('a cohortBy that is not a date-time RunEvent field is rejected', () => {
  const unknown = errorsFor(withNumerator({ cohortBy: 'noSuchField' }), 'review_ungrounded_rate');
  assert.ok(unknown.some((e) => e.problem.includes('cohortBy') && e.problem.includes('noSuchField')), JSON.stringify(unknown));
  // findingId exists on RunEvent but is not a date-time: a window cannot select by it.
  const notDate = errorsFor(withNumerator({ cohortBy: 'findingId' }), 'review_ungrounded_rate');
  assert.ok(notDate.some((e) => e.problem.includes('cohortBy') && e.problem.includes('date-time')), JSON.stringify(notDate));
});

test('an operand key the evaluator does not know is rejected, so a misspelt option cannot be ignored', () => {
  const errors = errorsFor(withNumerator({ cohortby: 'reviewRoundCompletedAt' }), 'review_ungrounded_rate');
  assert.ok(errors.some((e) => e.problem.includes('unknown operand key "cohortby"')), JSON.stringify(errors));
});

// --- dictionary 1.1.0: review metrics from human dispositions and the assurance metrics

test('the dictionary is version 1.1.0', () => {
  assert.equal(loadMeasurementDictionary().version, '1.1.0');
});

function metric(name: string) {
  const m = loadMeasurementDictionary().metrics.find((x) => x.name === name);
  assert.ok(m, `${name} is in the dictionary`);
  return m;
}

const SUM_FINDINGS = { aggregation: 'sum', events: ['review.completed'], fields: ['reviewFindingsTotal'] };
const MODEL_REVIEWS = {
  aggregation: 'count',
  events: ['review.completed'],
  filter: { field: 'reviewerRole', notEquals: 'deterministic' },
};
const HUMAN = { field: 'dispositionActorKind', equals: 'human' };
const LATEST_IN_COHORT = { dedupeLatestBy: 'findingId', cohortBy: 'reviewRoundCompletedAt' };

test('review yield and false positives count the latest human disposition in the cohort of the round it disposes', () => {
  for (const [name, valid] of [['review_finding_yield', true], ['review_false_positive_rate', false]] as const) {
    const m = metric(name);
    assert.equal(
      m.formula,
      `count(review.finding_dispositioned where findingValid=${valid} and dispositionActorKind=human) / sum(review.completed.reviewFindingsTotal)`,
    );
    assert.deepEqual(m.numerator, {
      aggregation: 'count',
      events: ['review.finding_dispositioned'],
      filters: [{ field: 'findingValid', equals: valid }, HUMAN],
      ...LATEST_IN_COHORT,
    });
    assert.deepEqual(m.denominator, SUM_FINDINGS);
    assert.equal(m.zeroDenominatorPolicy, 'report-null-when-no-findings');
    assert.equal(m.privacyClass, 'operational');
  }
});

test('the assurance metrics are defined as the data model states', () => {
  const expected: Record<string, { formula: string; numerator: unknown; denominator?: unknown; zero?: string; privacy: string }> = {
    review_adjudication_coverage: {
      formula: 'count(review.finding_dispositioned where dispositionActorKind=human) / sum(review.completed.reviewFindingsTotal)',
      numerator: { aggregation: 'count', events: ['review.finding_dispositioned'], filter: HUMAN, ...LATEST_IN_COHORT },
      denominator: SUM_FINDINGS,
      zero: 'report-null-when-no-findings',
      privacy: 'operational',
    },
    review_ungrounded_rate: {
      formula: 'sum(review.completed.reviewFindingsUngrounded) / sum(review.completed.reviewFindingsTotal)',
      numerator: { aggregation: 'sum', events: ['review.completed'], fields: ['reviewFindingsUngrounded'] },
      denominator: SUM_FINDINGS,
      zero: 'report-null-when-no-findings',
      privacy: 'operational',
    },
    reviewer_failure_rate: {
      formula:
        'count(review.completed where reviewerFailed=true and reviewerRole!=deterministic) / count(review.completed where reviewerRole!=deterministic)',
      numerator: {
        aggregation: 'count',
        events: ['review.completed'],
        filters: [{ field: 'reviewerFailed', equals: true }, { field: 'reviewerRole', notEquals: 'deterministic' }],
      },
      denominator: MODEL_REVIEWS,
      zero: 'report-null-when-no-reviews',
      privacy: 'operational',
    },
    review_egress_stop_rate: {
      formula:
        'count(review.completed where egressStopped=true and reviewerRole!=deterministic) / count(review.completed where reviewerRole!=deterministic)',
      numerator: {
        aggregation: 'count',
        events: ['review.completed'],
        filters: [{ field: 'egressStopped', equals: true }, { field: 'reviewerRole', notEquals: 'deterministic' }],
      },
      denominator: MODEL_REVIEWS,
      zero: 'report-null-when-no-reviews',
      privacy: 'operational',
    },
    shadow_would_block_rate: {
      formula:
        'count(attempt.completed where reviewMode=shadow and shadowWouldBlock=true) / count(attempt.completed where reviewMode=shadow)',
      numerator: {
        aggregation: 'count',
        events: ['attempt.completed'],
        filters: [{ field: 'reviewMode', equals: 'shadow' }, { field: 'shadowWouldBlock', equals: true }],
      },
      denominator: { aggregation: 'count', events: ['attempt.completed'], filter: { field: 'reviewMode', equals: 'shadow' } },
      zero: 'report-null-when-no-shadow-rounds',
      privacy: 'operational',
    },
    review_cost_coverage: {
      formula:
        'count(review.completed where reviewCostPriced=true and reviewerRole!=deterministic) / count(review.completed where reviewerRole!=deterministic)',
      numerator: {
        aggregation: 'count',
        events: ['review.completed'],
        filters: [{ field: 'reviewCostPriced', equals: true }, { field: 'reviewerRole', notEquals: 'deterministic' }],
      },
      denominator: MODEL_REVIEWS,
      zero: 'report-null-when-no-reviews',
      privacy: 'operational',
    },
    mean_review_cost_usd: {
      formula: 'mean(review.completed.reviewCostUsd)',
      numerator: { aggregation: 'mean', events: ['review.completed'], fields: ['reviewCostUsd'] },
      privacy: 'restricted',
    },
    review_disposition_latency_ms: {
      formula: 'mean(review.finding_dispositioned.dispositionLatencyMs where dispositionActorKind=human)',
      numerator: {
        aggregation: 'mean',
        events: ['review.finding_dispositioned'],
        fields: ['dispositionLatencyMs'],
        filter: HUMAN,
        cohortBy: 'reviewRoundCompletedAt',
      },
      privacy: 'operational',
    },
    repair_success_rate: {
      formula:
        'count(attempt.completed where repairRound=true and repairClosedAllBlocking=true) / count(attempt.completed where repairRound=true)',
      numerator: {
        aggregation: 'count',
        events: ['attempt.completed'],
        filters: [{ field: 'repairRound', equals: true }, { field: 'repairClosedAllBlocking', equals: true }],
      },
      denominator: { aggregation: 'count', events: ['attempt.completed'], filter: { field: 'repairRound', equals: true } },
      zero: 'report-null-when-no-repairs',
      privacy: 'operational',
    },
    review_escalation_rate: {
      formula: 'count(attempt.completed where assuranceOutcome=ESCALATE) / count(attempt.completed where reviewMode=gating)',
      numerator: { aggregation: 'count', events: ['attempt.completed'], filter: { field: 'assuranceOutcome', equals: 'ESCALATE' } },
      denominator: { aggregation: 'count', events: ['attempt.completed'], filter: { field: 'reviewMode', equals: 'gating' } },
      zero: 'report-null-when-no-gating-rounds',
      privacy: 'operational',
    },
  };
  for (const [name, want] of Object.entries(expected)) {
    const m = metric(name);
    assert.equal(m.formula, want.formula, name);
    assert.deepEqual(m.numerator, want.numerator, name);
    assert.deepEqual(m.denominator, want.denominator, name);
    assert.equal(m.zeroDenominatorPolicy, want.zero, name);
    assert.equal(m.privacyClass, want.privacy, name);
  }
});
