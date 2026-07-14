import test from 'node:test';
import assert from 'node:assert/strict';
import { runEventFields, runEventTypes } from '@asep/contracts';
import {
  loadMeasurementDictionary,
  validateDictionary,
  assertDictionaryValid,
  metricNames,
  metricFamilies,
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
