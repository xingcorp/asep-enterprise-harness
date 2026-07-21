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
