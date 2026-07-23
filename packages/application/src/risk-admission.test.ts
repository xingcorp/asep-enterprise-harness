// Risk-admission gate tests (exit criteria BR1/BR2/I4, disp. P2-PLAN-HIGH-001).
//
// Table-driven over R0-R4. Proves:
//   - R0 is admitted for full automation (to WAITING_FOR_HUMAN_REVIEW);
//   - R1 is admitted ONLY with a required, separately-recorded human review;
//   - R2..R4 are DEFERRED (fail closed) — never silently downgraded;
//   - a deferred/undecided risk reports admitted=false so the caller stops
//     BEFORE workspace creation / agent invocation / push.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskLevel } from '@asep/contracts';
import { admitRisk, isAdmitted } from './risk-admission.js';

interface Row {
  readonly risk: RiskLevel;
  readonly decision: 'ADMITTED_AUTOMATED' | 'ADMITTED_HUMAN_REVIEW' | 'DEFERRED';
  readonly admitted: boolean;
  readonly requiresHumanIndependentReview: boolean;
}

// Expected admission outcome for every Phase-2 risk level. This is the locked
// behavioural contract of the gate; a change here is a policy change.
const TABLE: readonly Row[] = [
  { risk: 'R0', decision: 'ADMITTED_AUTOMATED', admitted: true, requiresHumanIndependentReview: false },
  { risk: 'R1', decision: 'ADMITTED_HUMAN_REVIEW', admitted: true, requiresHumanIndependentReview: true },
  { risk: 'R2', decision: 'DEFERRED', admitted: false, requiresHumanIndependentReview: true },
  { risk: 'R3', decision: 'DEFERRED', admitted: false, requiresHumanIndependentReview: true },
  { risk: 'R4', decision: 'DEFERRED', admitted: false, requiresHumanIndependentReview: true },
];

for (const row of TABLE) {
  test(`risk ${row.risk} -> ${row.decision} (admitted=${row.admitted})`, () => {
    const result = admitRisk(row.risk);
    assert.equal(result.decision, row.decision, `decision for ${row.risk}`);
    assert.equal(result.admitted, row.admitted, `admitted for ${row.risk}`);
    assert.equal(
      result.requiresHumanIndependentReview,
      row.requiresHumanIndependentReview,
      `requiresHumanIndependentReview for ${row.risk}`,
    );
    assert.equal(isAdmitted(row.risk), row.admitted);
    assert.ok(result.reason.length > 0, 'a human-readable reason is always present');
  });
}

test('R2-R4 are deferred, NOT downgraded to an admitted automated run', () => {
  for (const risk of ['R2', 'R3', 'R4'] as const) {
    const r = admitRisk(risk);
    assert.equal(r.admitted, false);
    assert.notEqual(r.decision, 'ADMITTED_AUTOMATED');
    assert.notEqual(r.decision, 'ADMITTED_HUMAN_REVIEW');
  }
});

test('only R0 runs with no required human independent review', () => {
  const automatedNoHuman = (['R0', 'R1', 'R2', 'R3', 'R4'] as const).filter(
    (r) => admitRisk(r).admitted && !admitRisk(r).requiresHumanIndependentReview,
  );
  assert.deepEqual(automatedNoHuman, ['R0']);
});
