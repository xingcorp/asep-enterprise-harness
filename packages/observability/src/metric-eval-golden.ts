// Golden fixture for the metric evaluator: labelled RunEvents over three days
// and the value of every dashboard metric in each daily window, derived by hand
// from the dictionary formulas (never from the evaluator's output).
//
// The evaluator's unit test checks these values, and the dashboard itest loads
// the snapshots the evaluator writes for these events into PostgreSQL and checks
// that every Grafana panel returns the same values.
//
// The story, per day (UTC):
//   day 1  attempt a1: a primary review with two findings, one of them
//          ungrounded and refuted by the harness rule; a comparator review with
//          one finding and no configured price; a deterministic record with one
//          finding. a1 is declared complete, passes, and gating would have
//          blocked it. Task t1 is accepted.
//          attempt a2: the primary reviewer fails; a2 is declared complete and
//          fails required assurance.
//   day 2  a human accepts a1's grounded primary finding (cohort: day 1).
//          attempt a3: egress stops the primary review; the deterministic
//          record has one finding. Task t2 is rejected.
//   day 3  the human reverses: a1's primary finding is rejected (cohort:
//          day 1); a1's deterministic finding is accepted (cohort: day 1);
//          a3's deterministic finding is accepted (cohort: day 2). Attempt a4
//          is not declared complete and runs no assurance round. Task t3 is
//          accepted.
//
// Money amounts are binary fractions so every sum is exact.

import type { RunEvent } from '@asep/contracts';
import type { MetricWindow } from './metric-eval.js';

/** The three daily windows, [start, end). */
export const GOLDEN_WINDOWS: readonly MetricWindow[] = Object.freeze([
  { start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
  { start: '2026-10-02T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' },
  { start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' },
]);

/** Privacy classes the golden run opts in to: the cost metrics are restricted. */
export const GOLDEN_CAPTURE_OPT_IN: readonly string[] = Object.freeze(['restricted']);

function ev(fields: Record<string, unknown>): RunEvent {
  return Object.freeze({ runId: 'run-golden', ...fields }) as unknown as RunEvent;
}

const A1_ROUND = '2026-10-01T10:00:00.000Z';
const A3_ROUND = '2026-10-02T14:00:00.000Z';

const DAY_1: readonly RunEvent[] = [
  ev({
    eventId: 'g01', eventType: 'review.completed', occurredAt: A1_ROUND, attemptId: 'a1', reviewRound: 1,
    reviewerRole: 'primary', reviewMode: 'shadow', reviewFindingsTotal: 2, reviewFindingsUngrounded: 1,
    reviewFindingsBlocking: 0, reviewerFailed: false, egressStopped: false, reviewCostPriced: true, reviewCostUsd: 0.25,
  }),
  ev({
    eventId: 'g02', eventType: 'review.completed', occurredAt: A1_ROUND, attemptId: 'a1', reviewRound: 1,
    reviewerRole: 'comparator', reviewMode: 'shadow', reviewFindingsTotal: 1, reviewFindingsUngrounded: 0,
    reviewFindingsBlocking: 0, reviewerFailed: false, egressStopped: false, reviewCostPriced: false,
  }),
  ev({
    eventId: 'g03', eventType: 'review.completed', occurredAt: A1_ROUND, attemptId: 'a1', reviewRound: 1,
    reviewerRole: 'deterministic', reviewMode: 'shadow', reviewFindingsTotal: 1, reviewFindingsUngrounded: 0,
    reviewFindingsBlocking: 0, reviewerFailed: false, egressStopped: false,
  }),
  ev({
    eventId: 'g04', eventType: 'review.finding_dispositioned', occurredAt: A1_ROUND, attemptId: 'a1',
    findingId: 'f-a1-ungrounded', findingValid: false, findingDisposition: 'REJECTED',
    dispositionActorKind: 'harness-rule', findingSource: 'model', reviewRound: 1,
    reviewRoundCompletedAt: A1_ROUND, dispositionLatencyMs: 0,
  }),
  ev({
    eventId: 'g05', eventType: 'attempt.declared_complete', occurredAt: '2026-10-01T10:05:00.000Z', attemptId: 'a1',
    declaredComplete: true, passedRequiredAssurance: true,
  }),
  ev({
    eventId: 'g06', eventType: 'attempt.completed', occurredAt: '2026-10-01T10:05:00.000Z', attemptId: 'a1',
    reviewMode: 'shadow', assuranceOutcome: 'PROCEED', shadowWouldBlock: true, repairRound: false,
    modelCostUsd: 1.5, computeCostUsd: 0.25,
  }),
  ev({ eventId: 'g07', eventType: 'task.completed', occurredAt: '2026-10-01T12:00:00.000Z', taskId: 't1', outcome: 'accepted' }),
  ev({
    eventId: 'g08', eventType: 'review.completed', occurredAt: '2026-10-01T15:00:00.000Z', attemptId: 'a2', reviewRound: 1,
    reviewerRole: 'primary', reviewMode: 'shadow', reviewFindingsTotal: 0, reviewFindingsUngrounded: 0,
    reviewFindingsBlocking: 0, reviewerFailed: true, egressStopped: false, reviewCostPriced: true, reviewCostUsd: 0.125,
  }),
  ev({
    eventId: 'g09', eventType: 'review.completed', occurredAt: '2026-10-01T15:00:00.000Z', attemptId: 'a2', reviewRound: 1,
    reviewerRole: 'deterministic', reviewMode: 'shadow', reviewFindingsTotal: 0, reviewFindingsUngrounded: 0,
    reviewFindingsBlocking: 0, reviewerFailed: false, egressStopped: false,
  }),
  ev({
    eventId: 'g10', eventType: 'attempt.declared_complete', occurredAt: '2026-10-01T15:05:00.000Z', attemptId: 'a2',
    declaredComplete: true, passedRequiredAssurance: false,
  }),
  ev({
    eventId: 'g11', eventType: 'attempt.completed', occurredAt: '2026-10-01T15:05:00.000Z', attemptId: 'a2',
    reviewMode: 'shadow', assuranceOutcome: 'PROCEED', shadowWouldBlock: false,
    modelCostUsd: 0.5, computeCostUsd: 0.125, reviewCostUsd: 0.125,
  }),
];

const DAY_2: readonly RunEvent[] = [
  ev({
    eventId: 'g12', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-02T10:00:00.000Z', attemptId: 'a1',
    findingId: 'f-a1-primary', findingValid: true, findingDisposition: 'ACCEPTED', dispositionActorKind: 'human',
    findingSource: 'model', reviewRound: 1, reviewRoundCompletedAt: A1_ROUND, dispositionLatencyMs: 86_400_000,
  }),
  ev({
    eventId: 'g13', eventType: 'review.completed', occurredAt: A3_ROUND, attemptId: 'a3', reviewRound: 1,
    reviewerRole: 'primary', reviewMode: 'shadow', reviewFindingsTotal: 0, reviewFindingsUngrounded: 0,
    reviewFindingsBlocking: 0, reviewerFailed: false, egressStopped: true, reviewCostPriced: true, reviewCostUsd: 0,
  }),
  ev({
    eventId: 'g14', eventType: 'review.completed', occurredAt: A3_ROUND, attemptId: 'a3', reviewRound: 1,
    reviewerRole: 'deterministic', reviewMode: 'shadow', reviewFindingsTotal: 1, reviewFindingsUngrounded: 0,
    reviewFindingsBlocking: 1, reviewerFailed: false, egressStopped: false,
  }),
  ev({
    eventId: 'g15', eventType: 'attempt.declared_complete', occurredAt: '2026-10-02T14:05:00.000Z', attemptId: 'a3',
    declaredComplete: true, passedRequiredAssurance: true,
  }),
  ev({
    eventId: 'g16', eventType: 'attempt.completed', occurredAt: '2026-10-02T14:05:00.000Z', attemptId: 'a3',
    reviewMode: 'shadow', assuranceOutcome: 'PROCEED', shadowWouldBlock: false,
    modelCostUsd: 0.75, computeCostUsd: 0.25, reviewCostUsd: 0,
  }),
  ev({ eventId: 'g17', eventType: 'task.completed', occurredAt: '2026-10-02T16:00:00.000Z', taskId: 't2', outcome: 'rejected' }),
];

const DAY_3: readonly RunEvent[] = [
  ev({
    eventId: 'g18', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-03T10:00:00.000Z', attemptId: 'a1',
    findingId: 'f-a1-primary', findingValid: false, findingDisposition: 'REJECTED', dispositionActorKind: 'human',
    findingSource: 'model', reviewRound: 1, reviewRoundCompletedAt: A1_ROUND, dispositionLatencyMs: 172_800_000,
  }),
  ev({
    eventId: 'g19', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-03T12:00:00.000Z', attemptId: 'a1',
    findingId: 'f-a1-deterministic', findingValid: true, findingDisposition: 'ACCEPTED', dispositionActorKind: 'human',
    findingSource: 'deterministic', reviewRound: 1, reviewRoundCompletedAt: A1_ROUND, dispositionLatencyMs: 180_000_000,
  }),
  ev({
    eventId: 'g20', eventType: 'review.finding_dispositioned', occurredAt: '2026-10-03T09:00:00.000Z', attemptId: 'a3',
    findingId: 'f-a3-deterministic', findingValid: true, findingDisposition: 'ACCEPTED', dispositionActorKind: 'human',
    findingSource: 'deterministic', reviewRound: 1, reviewRoundCompletedAt: A3_ROUND, dispositionLatencyMs: 68_400_000,
  }),
  ev({
    eventId: 'g21', eventType: 'attempt.declared_complete', occurredAt: '2026-10-03T11:00:00.000Z', attemptId: 'a4',
    declaredComplete: false, passedRequiredAssurance: false,
  }),
  ev({
    eventId: 'g22', eventType: 'attempt.completed', occurredAt: '2026-10-03T11:00:00.000Z', attemptId: 'a4',
    reviewMode: 'not-required', modelCostUsd: 0.25, computeCostUsd: 0.0625,
  }),
  ev({ eventId: 'g23', eventType: 'task.completed', occurredAt: '2026-10-03T13:00:00.000Z', taskId: 't3', outcome: 'accepted' }),
];

/** The events in the order they arrive, one list per day. */
export const GOLDEN_EVENTS_BY_DAY: readonly (readonly RunEvent[])[] = Object.freeze([DAY_1, DAY_2, DAY_3]);

/** Every golden event. */
export const GOLDEN_EVENTS: readonly RunEvent[] = Object.freeze([...DAY_1, ...DAY_2, ...DAY_3]);

export interface GoldenValue {
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly nullReason: string | null;
}

function v(numerator: number, denominator: number, value: number): GoldenValue {
  return { value, numerator, denominator, nullReason: null };
}

function nul(numerator: number, denominator: number, nullReason: string): GoldenValue {
  return { value: null, numerator, denominator, nullReason };
}

// A mean reports the sum of its values as numerator and their count as
// denominator, so the value can be re-derived from the row.
const NO_VALUES = 'no-values-to-average';

/**
 * The value of every dashboard metric over every golden event, one entry per
 * window of GOLDEN_WINDOWS. The working is in the comments.
 */
export const GOLDEN_VALUES: Readonly<Record<string, readonly [GoldenValue, GoldenValue, GoldenValue]>> = Object.freeze({
  // declared complete: day 1 a1, a2 (a2 failed assurance); day 2 a3; day 3 a4 did not declare.
  false_completion_rate: [v(1, 2, 0.5), v(0, 1, 0), nul(0, 0, 'report-null-when-no-declarations')],
  // findings: day 1 2+1+1+0+0 = 4; day 2 0+1 = 1; day 3 none. Latest human disposition per finding,
  // by the cohort of its round: day 1 primary rejected, deterministic accepted (the harness refutation
  // is not a human's); day 2 a3's deterministic accepted. The day-2 acceptance of a1's finding counts
  // in day 1 and was replaced on day 3.
  review_finding_yield: [v(1, 4, 0.25), v(1, 1, 1), nul(0, 0, 'report-null-when-no-findings')],
  review_false_positive_rate: [v(1, 4, 0.25), v(0, 1, 0), nul(0, 0, 'report-null-when-no-findings')],
  review_adjudication_coverage: [v(2, 4, 0.5), v(1, 1, 1), nul(0, 0, 'report-null-when-no-findings')],
  review_ungrounded_rate: [v(1, 4, 0.25), v(0, 1, 0), nul(0, 0, 'report-null-when-no-findings')],
  // model reviews: day 1 a1 primary, a1 comparator, a2 primary (failed); day 2 a3 primary (egress stop).
  reviewer_failure_rate: [v(1, 3, 1 / 3), v(0, 1, 0), nul(0, 0, 'report-null-when-no-reviews')],
  review_egress_stop_rate: [v(0, 3, 0), v(1, 1, 1), nul(0, 0, 'report-null-when-no-reviews')],
  // shadow attempts: day 1 a1 (would block), a2; day 2 a3; day 3 a4 ran no round.
  shadow_would_block_rate: [v(1, 2, 0.5), v(0, 1, 0), nul(0, 0, 'report-null-when-no-shadow-rounds')],
  // human dispositions by cohort, every one (no dedupe): day 1 86.4e6 + 172.8e6 + 180e6 = 439.2e6 over 3;
  // day 2 68.4e6 over 1.
  review_disposition_latency_ms: [v(439_200_000, 3, 146_400_000), v(68_400_000, 1, 68_400_000), nul(0, 0, NO_VALUES)],
  repair_success_rate: [
    nul(0, 0, 'report-null-when-no-repairs'), nul(0, 0, 'report-null-when-no-repairs'), nul(0, 0, 'report-null-when-no-repairs'),
  ],
  review_escalation_rate: [
    nul(0, 0, 'report-null-when-no-gating-rounds'),
    nul(0, 0, 'report-null-when-no-gating-rounds'),
    nul(0, 0, 'report-null-when-no-gating-rounds'),
  ],
  // attempt cost: day 1 (1.5 + 0.25) + (0.5 + 0.125 + 0.125) = 2.5 over t1; day 2 0.75 + 0.25 + 0 = 1
  // over no accepted task; day 3 0.25 + 0.0625 = 0.3125 over t3.
  cost_per_accepted_task: [v(2.5, 1, 2.5), nul(1, 0, 'report-null-when-no-accepted-tasks'), v(0.3125, 1, 0.3125)],
  // priced review cost: day 1 0.25 and 0.125 (the comparator has no price); day 2 0; day 3 no review.
  mean_review_cost_usd: [v(0.375, 2, 0.1875), v(0, 1, 0), nul(0, 0, NO_VALUES)],
  review_cost_coverage: [v(2, 3, 2 / 3), v(1, 1, 1), nul(0, 0, 'report-null-when-no-reviews')],
  // nothing emits workflow.recovered yet.
  workflow_recovery_rate: [
    nul(0, 0, 'report-null-when-no-recoveries'),
    nul(0, 0, 'report-null-when-no-recoveries'),
    nul(0, 0, 'report-null-when-no-recoveries'),
  ],
});
