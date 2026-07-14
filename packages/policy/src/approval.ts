// Deterministic approval matrix.
//
// Per-risk approval requirements, loaded from the canonical
// policies/approval-matrix.yaml. The legacy gatePolicy() shape is DERIVED from
// this same source (see deriveGatePolicy) so there is exactly one authority.
// Pure data lookup: no model call, no network.

import type { RiskLevel } from '@asep/contracts';
import { loadApprovalMatrix, type ApprovalMatrixDoc } from './policy-source.js';

export interface ApprovalRequirements {
  readonly independentReviewers: number;
  readonly requireDifferentModelFamily: boolean;
  readonly requireSpecialistReview: boolean;
  readonly requireHumanMerge: boolean;
  readonly requireHumanRelease: boolean;
  readonly allowAutoMerge: boolean;
  readonly requireRollbackPlan: boolean;
  readonly evidenceRequired: boolean;
}

const doc: ApprovalMatrixDoc = loadApprovalMatrix();

function bool(v: number | boolean | undefined, field: string, risk: string): boolean {
  if (typeof v !== 'boolean') {
    throw new Error(`approval: risk "${risk}" field "${field}" must be boolean`);
  }
  return v;
}

function num(v: number | boolean | undefined, field: string, risk: string): number {
  if (typeof v !== 'number') {
    throw new Error(`approval: risk "${risk}" field "${field}" must be a number`);
  }
  return v;
}

/** Full approval requirements for a risk level. */
export function approvalFor(risk: RiskLevel): ApprovalRequirements {
  const row = doc.matrix[risk];
  if (!row) throw new Error(`approval: no matrix entry for risk "${risk}"`);
  return {
    independentReviewers: num(row['independentReviewers'], 'independentReviewers', risk),
    requireDifferentModelFamily: bool(row['requireDifferentModelFamily'], 'requireDifferentModelFamily', risk),
    requireSpecialistReview: bool(row['requireSpecialistReview'], 'requireSpecialistReview', risk),
    requireHumanMerge: bool(row['requireHumanMerge'], 'requireHumanMerge', risk),
    requireHumanRelease: bool(row['requireHumanRelease'], 'requireHumanRelease', risk),
    allowAutoMerge: bool(row['allowAutoMerge'], 'allowAutoMerge', risk),
    requireRollbackPlan: bool(row['requireRollbackPlan'], 'requireRollbackPlan', risk),
    evidenceRequired: bool(row['evidenceRequired'], 'evidenceRequired', risk),
  };
}
