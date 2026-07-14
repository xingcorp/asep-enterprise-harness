import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalFor } from './approval.js';
import type { RiskLevel } from '@asep/contracts';

test('auto-merge is allowed only for R0 and R1', () => {
  assert.equal(approvalFor('R0').allowAutoMerge, true);
  assert.equal(approvalFor('R1').allowAutoMerge, true);
  assert.equal(approvalFor('R2').allowAutoMerge, false);
  assert.equal(approvalFor('R3').allowAutoMerge, false);
  assert.equal(approvalFor('R4').allowAutoMerge, false);
});

test('human release is required at R3 and R4', () => {
  assert.equal(approvalFor('R2').requireHumanRelease, false);
  assert.equal(approvalFor('R3').requireHumanRelease, true);
  assert.equal(approvalFor('R4').requireHumanRelease, true);
});

test('independent reviewer count escalates with risk', () => {
  assert.equal(approvalFor('R0').independentReviewers, 0);
  assert.equal(approvalFor('R1').independentReviewers, 1);
  assert.equal(approvalFor('R2').independentReviewers, 1);
  assert.equal(approvalFor('R3').independentReviewers, 2);
  assert.equal(approvalFor('R4').independentReviewers, 2);
});

test('rollback plan and specialist review required at R3+', () => {
  for (const risk of ['R0', 'R1', 'R2'] as RiskLevel[]) {
    assert.equal(approvalFor(risk).requireRollbackPlan, false);
    assert.equal(approvalFor(risk).requireSpecialistReview, false);
  }
  for (const risk of ['R3', 'R4'] as RiskLevel[]) {
    assert.equal(approvalFor(risk).requireRollbackPlan, true);
    assert.equal(approvalFor(risk).requireSpecialistReview, true);
  }
});

test('evidence is required at every risk level', () => {
  for (const risk of ['R0', 'R1', 'R2', 'R3', 'R4'] as RiskLevel[]) {
    assert.equal(approvalFor(risk).evidenceRequired, true);
  }
});

test('different model family required from R2 upward', () => {
  assert.equal(approvalFor('R1').requireDifferentModelFamily, false);
  assert.equal(approvalFor('R2').requireDifferentModelFamily, true);
});
