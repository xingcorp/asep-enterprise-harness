import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contractVersion, runEventFields, type RunEvent } from '@asep/contracts';
import { loadMeasurementDictionary, runEventDateTimeFields, validateDictionary } from './metrics.js';
import {
  METRIC_EVALUATOR_VERSION,
  MemoryMetricSnapshotStore,
  MetricSnapshotRejectedError,
  evaluateMetric,
  recomputeMetricSnapshots,
  type MetricSnapshotKey,
  type MetricSnapshotStore,
  type MetricWindow,
} from './metric-eval.js';
import { GOLDEN_CAPTURE_OPT_IN, GOLDEN_EVENTS, GOLDEN_EVENTS_BY_DAY, GOLDEN_VALUES, GOLDEN_WINDOWS } from './metric-eval-golden.js';

console.log('SUITE-ID: asep-suite:metric-eval');

const DICT = loadMeasurementDictionary();
const SCOPE = { organizationId: '01JORGANIZATION00000000000', projectId: '01JPROJECT0000000000000000' };
const DAY_1: MetricWindow = { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' };
const DAY_2: MetricWindow = { start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' };
const DAY_3: MetricWindow = { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' };
const DAYS = [DAY_1, DAY_2, DAY_3];
const NO_DIMENSIONS_SHA256 = createHash('sha256').update('{}').digest('hex');

// The metrics the four assurance dashboards show (plan §15): false completion,
// review yield, cost and recovery.
const DASHBOARD_METRICS = [
  'false_completion_rate',
  'review_finding_yield',
  'review_false_positive_rate',
  'review_adjudication_coverage',
  'review_ungrounded_rate',
  'reviewer_failure_rate',
  'review_egress_stop_rate',
  'shadow_would_block_rate',
  'review_disposition_latency_ms',
  'repair_success_rate',
  'review_escalation_rate',
  'cost_per_accepted_task',
  'mean_review_cost_usd',
  'review_cost_coverage',
  'workflow_recovery_rate',
].sort();

function ev(fields: Record<string, unknown>): RunEvent {
  return { runId: 'run-1', ...fields } as unknown as RunEvent;
}

function key(metricName: string, window: MetricWindow): MetricSnapshotKey {
  return {
    ...SCOPE,
    metricName,
    dictionaryVersion: DICT.version,
    windowStart: window.start,
    windowEnd: window.end,
    dimensionsSha256: NO_DIMENSIONS_SHA256,
  };
}

function shape(s: { value: number | null; numerator: number | null; denominator: number | null; nullReason: string | null }) {
  return { value: s.value, numerator: s.numerator, denominator: s.denominator, nullReason: s.nullReason };
}

async function recompute(store: MetricSnapshotStore, events: readonly RunEvent[], computedAt: string, metricNames?: readonly string[]) {
  return recomputeMetricSnapshots({
    store, scope: SCOPE, dictionary: DICT, metricNames, windows: DAYS, events, computedAt,
    captureOptIn: GOLDEN_CAPTURE_OPT_IN,
  });
}

test('dictionary operands resolve against run-event 1.2.0', () => {
  assert.equal(contractVersion('run-event'), '1.2.0');
  assert.deepEqual(validateDictionary(DICT), []);
  const fields = new Set(runEventFields());
  const dates = runEventDateTimeFields();
  assert.ok(dates.has('occurredAt') && dates.has('reviewRoundCompletedAt'));
  let options = 0;
  for (const m of DICT.metrics) {
    for (const op of [m.numerator, m.denominator]) {
      if (op?.dedupeLatestBy !== undefined) {
        options += 1;
        assert.ok(fields.has(op.dedupeLatestBy), `${m.name}: ${op.dedupeLatestBy}`);
      }
      if (op?.cohortBy !== undefined) {
        options += 1;
        assert.ok(dates.has(op.cohortBy), `${m.name}: ${op.cohortBy}`);
      }
    }
  }
  // yield, false positives and coverage dedupe and cohort; latency cohorts only.
  assert.equal(options, 7);
});

test('evaluator matches golden values for every dashboard metric', () => {
  assert.deepEqual(Object.keys(GOLDEN_VALUES).sort(), DASHBOARD_METRICS);
  assert.deepEqual(GOLDEN_WINDOWS, DAYS);
  for (const name of DASHBOARD_METRICS) {
    GOLDEN_WINDOWS.forEach((window, i) => {
      const got = evaluateMetric(DICT, name, GOLDEN_EVENTS, window, { captureOptIn: GOLDEN_CAPTURE_OPT_IN });
      assert.deepEqual(shape(got), GOLDEN_VALUES[name]![i], `${name} in window ${i + 1}`);
      assert.equal(got.metricName, name);
      assert.equal(got.windowStart, window.start);
      assert.equal(got.windowEnd, window.end);
      assert.equal(got.privacyClass, DICT.metrics.find((m) => m.name === name)!.privacyClass);
    });
  }
});

test('the golden snapshots built day by day end at the golden values', async () => {
  const store = new MemoryMetricSnapshotStore();
  const seen: RunEvent[] = [];
  for (const [i, day] of GOLDEN_EVENTS_BY_DAY.entries()) {
    seen.push(...day);
    await recompute(store, seen, `2026-10-0${i + 1}T23:00:00.000Z`, DASHBOARD_METRICS);
  }
  for (const name of DASHBOARD_METRICS) {
    DAYS.forEach((window, i) => {
      const latest = store.versions(key(name, window)).at(-1);
      assert.ok(latest, `${name} window ${i + 1} has a snapshot`);
      assert.deepEqual(shape(latest), GOLDEN_VALUES[name]![i], `${name} window ${i + 1}`);
    });
  }
  // Day 1's yield: 0/4 after day 1, 1/4 after the acceptance on day 2; on day 3 one
  // finding is rejected and another accepted, 1/4 again, so no third version is written.
  assert.deepEqual(store.versions(key('review_finding_yield', DAY_1)).map((s) => s.value), [0, 0.25]);
  // Day 1's coverage grows with each human disposition of its round: 0, 1/4, 2/4.
  assert.deepEqual(store.versions(key('review_adjudication_coverage', DAY_1)).map((s) => s.value), [0, 0.25, 0.5]);
});

test("late human dispositions version their round's cohort snapshot", async () => {
  const round = '2026-10-01T09:00:00.000Z';
  const byDay: RunEvent[][] = [
    [ev({
      eventId: 'r1', eventType: 'review.completed', occurredAt: round, reviewerRole: 'primary', reviewMode: 'shadow',
      reviewFindingsTotal: 1, reviewFindingsUngrounded: 0, reviewerFailed: false, egressStopped: false,
    })],
    [ev({
      eventId: 'd1', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-02T09:00:00.000Z', findingId: 'f-1',
      findingValid: true, findingDisposition: 'ACCEPTED', dispositionActorKind: 'human', reviewRoundCompletedAt: round,
      dispositionLatencyMs: 86_400_000,
    })],
    [ev({
      eventId: 'd2', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-03T09:00:00.000Z', findingId: 'f-1',
      findingValid: false, findingDisposition: 'REJECTED', dispositionActorKind: 'human', reviewRoundCompletedAt: round,
      dispositionLatencyMs: 172_800_000,
    })],
  ];
  const names = ['review_finding_yield', 'review_false_positive_rate', 'review_disposition_latency_ms'];
  const store = new MemoryMetricSnapshotStore();
  const seen: RunEvent[] = [];
  const writtenPerDay: number[] = [];
  for (const [i, day] of byDay.entries()) {
    seen.push(...day);
    const { appended } = await recompute(store, seen, `2026-10-0${i + 1}T23:00:00.000Z`, names);
    writtenPerDay.push(appended.length);
  }

  const yieldDay1 = store.versions(key('review_finding_yield', DAY_1));
  assert.deepEqual(yieldDay1.map((s) => s.snapshotVersion), [1, 2, 3]);
  assert.deepEqual(yieldDay1.map((s) => s.value), [0, 1, 0]);
  assert.deepEqual(yieldDay1.map((s) => s.computedAt), [
    '2026-10-01T23:00:00.000Z', '2026-10-02T23:00:00.000Z', '2026-10-03T23:00:00.000Z',
  ]);
  const fpDay1 = store.versions(key('review_false_positive_rate', DAY_1));
  assert.deepEqual(fpDay1.map((s) => [s.snapshotVersion, s.value]), [[1, 0], [2, 1]]);
  // Latency per cohort: none yet, then the acceptance's, then the mean of both.
  const latencyDay1 = store.versions(key('review_disposition_latency_ms', DAY_1));
  assert.deepEqual(latencyDay1.map((s) => [s.value, s.nullReason]), [
    [null, 'no-values-to-average'], [86_400_000, null], [129_600_000, null],
  ]);
  // The dispositions arrived on days 2 and 3, but those windows hold no round of
  // their own: one null version each, never touched again.
  for (const day of [DAY_2, DAY_3]) {
    for (const [name, reason] of [
      ['review_finding_yield', 'report-null-when-no-findings'],
      ['review_false_positive_rate', 'report-null-when-no-findings'],
      ['review_disposition_latency_ms', 'no-values-to-average'],
    ] as const) {
      const versions = store.versions(key(name, day));
      assert.deepEqual(versions.map((s) => [s.snapshotVersion, s.value, s.nullReason]), [[1, null, reason]], `${name} ${day.start}`);
      assert.equal(versions[0]!.computedAt, '2026-10-01T23:00:00.000Z');
    }
  }
  // Day 1 writes all nine snapshots; day 2 yield and latency for day 1; day 3 all three for day 1.
  assert.deepEqual(writtenPerDay, [9, 2, 3]);
});

test('harness refutations count in neither yield, false positives, coverage nor latency', () => {
  const round = '2026-10-01T09:00:00.000Z';
  const events = [
    ev({
      eventId: 'r1', eventType: 'review.completed', occurredAt: round, reviewerRole: 'primary', reviewMode: 'shadow',
      reviewFindingsTotal: 2, reviewFindingsUngrounded: 1,
    }),
    // the harness refutes the ungrounded finding when the round is adjudicated
    ev({
      eventId: 'h1', eventType: 'review.finding_dispositioned', occurredAt: round, findingId: 'f-ungrounded',
      findingValid: false, findingDisposition: 'REJECTED', dispositionActorKind: 'harness-rule',
      reviewRoundCompletedAt: round, dispositionLatencyMs: 0,
    }),
    ev({
      eventId: 'd1', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-01T11:00:00.000Z', findingId: 'f-grounded',
      findingValid: true, findingDisposition: 'ACCEPTED', dispositionActorKind: 'human',
      reviewRoundCompletedAt: round, dispositionLatencyMs: 7_200_000,
    }),
  ];
  const at = (name: string) => shape(evaluateMetric(DICT, name, events, DAY_1));
  assert.deepEqual(at('review_finding_yield'), { value: 0.5, numerator: 1, denominator: 2, nullReason: null });
  assert.deepEqual(at('review_false_positive_rate'), { value: 0, numerator: 0, denominator: 2, nullReason: null });
  assert.deepEqual(at('review_adjudication_coverage'), { value: 0.5, numerator: 1, denominator: 2, nullReason: null });
  assert.deepEqual(at('review_disposition_latency_ms'), { value: 7_200_000, numerator: 7_200_000, denominator: 1, nullReason: null });
  // the refuted finding shows up where it belongs: the ungrounded rate
  assert.deepEqual(at('review_ungrounded_rate'), { value: 0.5, numerator: 1, denominator: 2, nullReason: null });
});

test('the latest disposition is chosen by occurrence time, then event id, whatever the input order', () => {
  const round = '2026-10-01T09:00:00.000Z';
  const review = ev({ eventId: 'r1', eventType: 'review.completed', occurredAt: round, reviewFindingsTotal: 1 });
  const disposition = (eventId: string, occurredAt: string, findingValid: boolean) => ev({
    eventId, eventType: 'review.finding_dispositioned', occurredAt, findingId: 'f-1', findingValid,
    dispositionActorKind: 'human', reviewRoundCompletedAt: round, dispositionLatencyMs: 1,
  });
  const later = disposition('a', '2026-10-02T09:00:00.000Z', true);
  const earlier = disposition('z', '2026-10-01T10:00:00.000Z', false);
  for (const events of [[review, earlier, later], [later, review, earlier]]) {
    assert.equal(evaluateMetric(DICT, 'review_finding_yield', events, DAY_1).value, 1);
  }
  // the same instant: the greater event id is the later one
  const tieLow = disposition('b', '2026-10-02T09:00:00.000Z', false);
  const tieHigh = disposition('c', '2026-10-02T09:00:00.000Z', true);
  for (const events of [[review, tieLow, tieHigh], [review, tieHigh, tieLow]]) {
    assert.equal(evaluateMetric(DICT, 'review_finding_yield', events, DAY_1).value, 1);
  }
});

test('missing source events yield null with a reason', () => {
  for (const m of DICT.metrics) {
    const got = evaluateMetric(DICT, m.name, [], DAY_1, { captureOptIn: ['sensitive', 'restricted'] });
    assert.equal(got.value, null, m.name);
    const expected = m.denominator ? m.zeroDenominatorPolicy : m.numerator.aggregation === 'mean' ? 'no-values-to-average' : 'no-source-events';
    assert.equal(got.nullReason, expected, m.name);
    assert.equal(got.sourceEventCount, 0, m.name);
  }
  // Lane A's recovery events and gating rounds do not exist yet: null, never 0.
  const recovery = evaluateMetric(DICT, 'workflow_recovery_rate', GOLDEN_EVENTS, DAY_1);
  assert.deepEqual(shape(recovery), { value: null, numerator: 0, denominator: 0, nullReason: 'report-null-when-no-recoveries' });
});

test('every evaluated value is a number or a null with a reason, never both', () => {
  const optIns: (readonly string[])[] = [[], GOLDEN_CAPTURE_OPT_IN];
  for (const captureOptIn of optIns) {
    for (const m of DICT.metrics) {
      for (const window of GOLDEN_WINDOWS) {
        const got = evaluateMetric(DICT, m.name, GOLDEN_EVENTS, window, { captureOptIn });
        if (got.value === null) {
          assert.equal(typeof got.nullReason, 'string', m.name);
          assert.ok(got.nullReason!.length > 0, m.name);
        } else {
          assert.ok(Number.isFinite(got.value), m.name);
          assert.equal(got.nullReason, null, m.name);
        }
      }
    }
  }
});

test('unpriced reviews are reported as uncovered, never zero', () => {
  const events = [
    ev({ eventId: 'p', eventType: 'review.completed', occurredAt: '2026-10-01T09:00:00.000Z', reviewerRole: 'primary', reviewCostPriced: true, reviewCostUsd: 0.5 }),
    ev({ eventId: 'c', eventType: 'review.completed', occurredAt: '2026-10-01T09:00:00.000Z', reviewerRole: 'comparator', reviewCostPriced: false }),
    ev({ eventId: 'd', eventType: 'review.completed', occurredAt: '2026-10-01T09:00:00.000Z', reviewerRole: 'deterministic' }),
  ];
  const coverage = evaluateMetric(DICT, 'review_cost_coverage', events, DAY_1);
  assert.deepEqual(shape(coverage), { value: 0.5, numerator: 1, denominator: 2, nullReason: null });
  // the unpriced review is not averaged in as a zero cost
  const mean = evaluateMetric(DICT, 'mean_review_cost_usd', events, DAY_1, { captureOptIn: ['restricted'] });
  assert.deepEqual(shape(mean), { value: 0.5, numerator: 0.5, denominator: 1, nullReason: null });
  // with no priced review at all the mean is null, not 0
  const none = evaluateMetric(DICT, 'mean_review_cost_usd', events.slice(1), DAY_1, { captureOptIn: ['restricted'] });
  assert.deepEqual(shape(none), { value: null, numerator: 0, denominator: 0, nullReason: 'no-values-to-average' });
});

test('restricted metrics respect opt-in capture', () => {
  for (const name of ['mean_review_cost_usd', 'cost_per_accepted_task']) {
    assert.equal(DICT.metrics.find((m) => m.name === name)!.privacyClass, 'restricted');
    const off = evaluateMetric(DICT, name, GOLDEN_EVENTS, DAY_1);
    assert.deepEqual(shape(off), { value: null, numerator: null, denominator: null, nullReason: 'capture-not-enabled' });
    assert.equal(off.sourceEventCount, 0, 'nothing is read for a metric whose capture is off');
    assert.deepEqual(evaluateMetric(DICT, name, GOLDEN_EVENTS, DAY_1, { captureOptIn: ['sensitive'] }).nullReason, 'capture-not-enabled');
    const on = evaluateMetric(DICT, name, GOLDEN_EVENTS, DAY_1, { captureOptIn: ['restricted'] });
    assert.deepEqual(shape(on), GOLDEN_VALUES[name]![0]);
  }
  // an operational metric needs no opt-in
  assert.equal(evaluateMetric(DICT, 'review_finding_yield', GOLDEN_EVENTS, DAY_1).value, 0.25);
});

test('a source event without its dedupe key or cohort time makes the metric null with that reason', () => {
  const round = '2026-10-01T09:00:00.000Z';
  const review = ev({ eventId: 'r1', eventType: 'review.completed', occurredAt: round, reviewFindingsTotal: 1 });
  const base = { eventType: 'review.finding_dispositioned', occurredAt: '2026-10-01T10:00:00.000Z', findingValid: true, dispositionActorKind: 'human' };
  const noKey = ev({ ...base, eventId: 'd1', reviewRoundCompletedAt: round });
  assert.deepEqual(shape(evaluateMetric(DICT, 'review_finding_yield', [review, noKey], DAY_1)), {
    value: null, numerator: null, denominator: null, nullReason: 'source-event-lacks-findingId',
  });
  const noCohort = ev({ ...base, eventId: 'd2', findingId: 'f-1' });
  assert.equal(evaluateMetric(DICT, 'review_finding_yield', [review, noCohort], DAY_1).nullReason, 'source-event-lacks-reviewRoundCompletedAt');
  const badCohort = ev({ ...base, eventId: 'd3', findingId: 'f-1', reviewRoundCompletedAt: 'yesterday' });
  assert.equal(evaluateMetric(DICT, 'review_finding_yield', [review, badCohort], DAY_1).nullReason, 'source-event-invalid-reviewRoundCompletedAt');
});

test('windows are half-open: an event at the end instant belongs to the next window', () => {
  const at = (occurredAt: string) => [ev({ eventId: occurredAt, eventType: 'attempt.declared_complete', occurredAt, declaredComplete: true, passedRequiredAssurance: false })];
  assert.equal(evaluateMetric(DICT, 'false_completion_rate', at(DAY_1.start), DAY_1).value, 1);
  assert.equal(evaluateMetric(DICT, 'false_completion_rate', at(DAY_1.end), DAY_1).value, null);
  assert.equal(evaluateMetric(DICT, 'false_completion_rate', at(DAY_1.end), DAY_2).value, 1);
  assert.throws(() => evaluateMetric(DICT, 'false_completion_rate', [], { start: DAY_1.end, end: DAY_1.start }), RangeError);
  assert.throws(() => evaluateMetric(DICT, 'no_such_metric', [], DAY_1), /unknown metric/);
});

test('the source event count is the events the window considered', () => {
  const got = evaluateMetric(DICT, 'review_finding_yield', GOLDEN_EVENTS, DAY_1);
  // day-1 cohort: the latest dispositions of three findings (g04, g18, g19) and five review.completed
  assert.equal(got.sourceEventCount, 8);
});

test('an unchanged recompute writes nothing and a changed one appends the next version', async () => {
  const store = new MemoryMetricSnapshotStore();
  const first = await recompute(store, GOLDEN_EVENTS_BY_DAY[0]!, '2026-10-01T23:00:00.000Z', ['review_finding_yield']);
  assert.equal(first.appended.length, 3);
  assert.equal(first.unchanged, 0);
  const again = await recompute(store, GOLDEN_EVENTS_BY_DAY[0]!, '2026-10-01T23:30:00.000Z', ['review_finding_yield']);
  assert.deepEqual([again.appended.length, again.unchanged], [0, 3]);
  const s = first.appended[0]!;
  assert.equal(s.snapshotVersion, 1);
  assert.equal(s.organizationId, SCOPE.organizationId);
  assert.equal(s.projectId, SCOPE.projectId);
  assert.equal(s.dictionaryVersion, '1.1.0');
  assert.equal(s.evaluatorVersion, METRIC_EVALUATOR_VERSION);
  assert.deepEqual(s.dimensions, {});
  assert.equal(s.dimensionsSha256, NO_DIMENSIONS_SHA256);
  assert.equal(s.privacyClass, 'operational');
  assert.equal(s.sourceWatermark, null);
  assert.equal(s.computedAt, '2026-10-01T23:00:00.000Z');
  assert.ok(Object.isFrozen(s));
});

test('a recompute that loses the version race re-reads and never repeats the winner', async () => {
  const inner = new MemoryMetricSnapshotStore();
  await recompute(inner, [], '2026-10-01T23:00:00.000Z', ['review_finding_yield']);
  // Another recompute appends day 1's 0/4 between this one's read and its write.
  let raced = false;
  const racing: MetricSnapshotStore = {
    latest: (k) => inner.latest(k),
    append: async (snapshot) => {
      if (!raced && snapshot.windowStart === DAY_1.start) {
        raced = true;
        assert.equal(await inner.append({ ...snapshot, computedAt: '2026-10-01T23:59:00.000Z' }), 'appended');
      }
      return inner.append(snapshot);
    },
  };
  const result = await recompute(racing, GOLDEN_EVENTS_BY_DAY[0]!, '2026-10-02T00:00:00.000Z', ['review_finding_yield']);
  assert.ok(raced);
  assert.equal(result.appended.length, 0, 'the winner already wrote the same value');
  assert.equal(result.unchanged, 3);
  const versions = inner.versions(key('review_finding_yield', DAY_1));
  assert.deepEqual(versions.map((v) => [v.snapshotVersion, v.value, v.computedAt]), [
    [1, null, '2026-10-01T23:00:00.000Z'], [2, 0, '2026-10-01T23:59:00.000Z'],
  ]);
});

test('the snapshot store keeps versions append-only, contiguous from 1, and each one a change', async () => {
  const store = new MemoryMetricSnapshotStore();
  const { appended } = await recompute(store, GOLDEN_EVENTS_BY_DAY[0]!, '2026-10-01T23:00:00.000Z', ['review_finding_yield']);
  const v1 = appended[0]!;
  const v2 = { ...v1, snapshotVersion: 2, value: 0.5, numerator: 2 };
  await assert.rejects(store.append({ ...v1, snapshotVersion: 3 }), MetricSnapshotRejectedError);
  await assert.rejects(store.append({ ...v1, snapshotVersion: 2 }), MetricSnapshotRejectedError, 'a version must change the value');
  assert.equal(await store.append({ ...v1 }), 'version-taken');
  assert.equal(await store.append(v2), 'appended');
  assert.equal(await store.append({ ...v2, value: 0.75 }), 'version-taken');
  const fresh = new MemoryMetricSnapshotStore();
  await assert.rejects(fresh.append({ ...v1, snapshotVersion: 2 }), MetricSnapshotRejectedError, 'the first version is 1');
  await assert.rejects(fresh.append({ ...v1, value: 1, nullReason: 'x' }), MetricSnapshotRejectedError, 'a value and a reason');
  await assert.rejects(fresh.append({ ...v1, value: null, nullReason: null }), MetricSnapshotRejectedError, 'a null without a reason');
  await assert.rejects(fresh.append({ ...v1, windowEnd: v1.windowStart }), MetricSnapshotRejectedError);
  await assert.rejects(fresh.append({ ...v1, privacyClass: 'secret' }), MetricSnapshotRejectedError);
  const kept = store.versions(key('review_finding_yield', DAY_1));
  assert.deepEqual(kept.map((s) => [s.snapshotVersion, s.value]), [[1, 0], [2, 0.5]]);
  assert.deepEqual((await store.latest(key('review_finding_yield', DAY_1)))?.snapshotVersion, 2);
  assert.equal(store.all().length, 4);
  assert.ok(Object.isFrozen(kept[0]));
  assert.equal(await store.latest({ ...key('review_finding_yield', DAY_1), projectId: 'other-project' }), null);
});

test('recompute refuses an unknown metric and an invalid computation time', async () => {
  const store = new MemoryMetricSnapshotStore();
  await assert.rejects(recompute(store, [], '2026-10-01T23:00:00.000Z', ['no_such_metric']), /unknown metric/);
  await assert.rejects(recompute(store, [], 'not a time', ['review_finding_yield']), RangeError);
  assert.equal(store.all().length, 0);
});
