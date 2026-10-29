// Public surface of @asep/policy.
//
// Risk, verification, approval and failure policy are all DERIVED from the
// canonical YAML under <repo>/policies/ (loaded via ./policy-source.ts). There
// is exactly one authority for each policy; parity tests (index.test.ts,
// parity.test.ts) assert the TS surface and the YAML never diverge.
//
// All policy evaluation is DETERMINISTIC: pure file read + parse + lookup. No
// model call, no network — a hard requirement so risk routing is reproducible.

import type { RiskLevel } from '@asep/contracts';
import { approvalFor } from './approval.js';

export {
  classifyRisk,
  riskForCategory,
  changeCategories,
  riskRank,
  RISK_ORDER,
  type ChangeCategory,
} from './risk.js';

export {
  requiredLevels,
  isMandatory,
  missingMandatory,
  ALL_LEVELS,
  type AssuranceLevel,
} from './verification.js';

export {
  approvalFor,
  type ApprovalRequirements,
} from './approval.js';

export {
  classifyFailure,
  failureInfo,
  failureClasses,
  type FailureClass,
  type FailureClassInfo,
  type FailureSignals,
  type Attribution,
} from './failure.js';

export {
  loadRiskTaxonomy,
  loadVerificationMatrix,
  parseVerificationMatrix,
  loadApprovalMatrix,
  loadFailureTaxonomy,
  type RiskTaxonomyDoc,
  type VerificationMatrixDoc,
  type ApprovalMatrixDoc,
  type FailureTaxonomyDoc,
} from './policy-source.js';

export {
  REVIEW_POLICY_FILE,
  REVIEW_SEVERITIES,
  POLICY_REVIEW_MODES,
  REASONING_EFFORTS,
  INDEPENDENT_REVIEWER_KINDS,
  ReviewPolicyError,
  parseReviewPolicy,
  loadReviewPolicy,
  resolveModelFamily,
  reviewerIndependence,
  independentReviewRequirement,
  isEgressEnabled,
  isSensitivePath,
  matchesPathGlob,
  type ReviewPolicy,
  type ReviewSeverity,
  type PolicyReviewMode,
  type ReasoningEffort,
  type IndependentReviewerKind,
  type ReviewerPolicyRole,
  type ModelFamilyRule,
  type ReviewerPricing,
  type ReviewerConfig,
  type IndependenceFailure,
  type IndependenceVerdict,
  type IndependentReviewRequirement,
} from './review.js';

// ---------------------------------------------------------------------------
// Legacy gate-policy surface (kept compatible). It is now DERIVED from the
// canonical approval matrix rather than being an independent hardcoded table,
// so the two can never diverge (P1-CHANGE-004).
// ---------------------------------------------------------------------------

export interface GatePolicy {
  readonly independentReviewers: number;
  readonly requireDifferentModelFamily: boolean;
  readonly requireHumanMerge: boolean;
  readonly requireHumanRelease: boolean;
  readonly allowAutoMerge: boolean;
}

export function gatePolicy(risk: RiskLevel): GatePolicy {
  const a = approvalFor(risk);
  return {
    independentReviewers: a.independentReviewers,
    requireDifferentModelFamily: a.requireDifferentModelFamily,
    requireHumanMerge: a.requireHumanMerge,
    requireHumanRelease: a.requireHumanRelease,
    allowAutoMerge: a.allowAutoMerge,
  };
}

export function canUseExperimentalOutputReducer(input: {
  risk: RiskLevel;
  commandCategory: 'LISTING' | 'DIAGNOSTIC' | 'SECURITY' | 'MIGRATION' | 'MACHINE_READABLE';
  rawCaptured: boolean;
}): boolean {
  if (!input.rawCaptured) return false;
  if (input.risk === 'R3' || input.risk === 'R4') return false;
  return input.commandCategory === 'LISTING';
}
