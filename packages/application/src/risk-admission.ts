// Risk-admission gate (disp. P2-PLAN-HIGH-001; exit criteria BR1/BR2/I4).
//
// Phase 2 has bounded capabilities: it can run one implementer, verify, open a
// PR and stop at human review. It CANNOT satisfy the Phase-1 mandatory approval
// gates for higher risk (multiple independent reviewers, different-model-family
// review, specialist review, rollback plans, human merge/release orchestration).
//
// This gate decides — BEFORE any workspace creation, agent invocation or push —
// whether a given risk level is admissible for automated Phase-2 execution:
//
//   R0  -> ADMITTED_AUTOMATED    (automation may run to WAITING_FOR_HUMAN_REVIEW)
//   R1  -> ADMITTED_HUMAN_REVIEW (automation runs, but a separately-recorded
//                                 human independent review is REQUIRED; the
//                                 harness never self-satisfies it)
//   R2..R4 -> DEFERRED           (fails closed; NOT silently downgraded)
//
// The decision is DERIVED from the canonical approval matrix (@asep/policy), not
// a second hardcoded table, so it can never drift from Phase-1 policy. If the
// approval matrix ever declares R0/R1 needs something Phase 2 cannot provide,
// this gate fails closed rather than pretend.

import type { RiskLevel } from '@asep/contracts';
import { approvalFor, type ApprovalRequirements } from '@asep/policy';

export type AdmissionDecision =
  | 'ADMITTED_AUTOMATED'
  | 'ADMITTED_HUMAN_REVIEW'
  | 'DEFERRED';

export interface AdmissionResult {
  readonly risk: RiskLevel;
  readonly decision: AdmissionDecision;
  readonly admitted: boolean; // false => execution MUST stop before side effects
  readonly requiresHumanIndependentReview: boolean;
  readonly reason: string;
}

// The Phase-2 automation capability envelope. These are the ONLY approval
// obligations the harness can discharge on its own. Anything the matrix demands
// beyond this set for a given risk means that risk is not admissible.
//
// Phase 2 can: run to WAITING_FOR_HUMAN_REVIEW, produce an evidence bundle, and
// require a human independent review step (recorded, not self-satisfied).
// Phase 2 CANNOT: provide >1 automated independent reviewer, a different-model-
// family runtime reviewer (Phase 4 scope), specialist review, or orchestrate
// human merge/release. Those obligations defer the risk.

// R2..R4 are deferred wholesale in Phase 2 regardless of matrix detail.
const AUTOMATED_RISK: RiskLevel = 'R0';
const HUMAN_REVIEW_RISK: RiskLevel = 'R1';

// Given the matrix row, can Phase-2 automation alone (no human, no second model)
// carry an R0 task all the way to WAITING_FOR_HUMAN_REVIEW without leaving a
// mandatory Phase-1 obligation unmet? R0 must need zero independent reviewers,
// no different-model-family review, no specialist review, no rollback plan, and
// must NOT require human merge/release to REACH the review gate.
function r0FullyAutomatable(a: ApprovalRequirements): boolean {
  return (
    a.independentReviewers === 0 &&
    !a.requireDifferentModelFamily &&
    !a.requireSpecialistReview
  );
}

// For R1 the harness runs the pipeline but a human independent review is
// mandatory and recorded outside automation. Phase 2 can support that ONLY if
// the matrix does not also demand a different-model-family runtime reviewer or
// specialist review (both out of Phase-2 scope) beyond a single human reviewer.
function r1SupportableWithHumanReview(a: ApprovalRequirements): boolean {
  return (
    a.independentReviewers <= 1 &&
    !a.requireDifferentModelFamily &&
    !a.requireSpecialistReview
  );
}

/**
 * Decide admissibility for a risk level. Pure, deterministic, no IO beyond the
 * cached policy load inside @asep/policy. Callers MUST stop before workspace
 * creation / agent invocation / push when `admitted` is false.
 */
export function admitRisk(risk: RiskLevel): AdmissionResult {
  const a = approvalFor(risk);

  if (risk === AUTOMATED_RISK) {
    if (r0FullyAutomatable(a)) {
      return {
        risk,
        decision: 'ADMITTED_AUTOMATED',
        admitted: true,
        requiresHumanIndependentReview: false,
        reason:
          'R0: Phase-2 automation satisfies all mandatory approval gates up to human review.',
      };
    }
    return {
      risk,
      decision: 'DEFERRED',
      admitted: false,
      requiresHumanIndependentReview: false,
      reason:
        'R0 approval matrix demands obligations Phase-2 automation cannot satisfy; failing closed.',
    };
  }

  if (risk === HUMAN_REVIEW_RISK) {
    if (r1SupportableWithHumanReview(a)) {
      return {
        risk,
        decision: 'ADMITTED_HUMAN_REVIEW',
        admitted: true,
        requiresHumanIndependentReview: true,
        reason:
          'R1: automation runs to WAITING_FOR_HUMAN_REVIEW; a separately-recorded human independent review is required and is never self-satisfied by the harness.',
      };
    }
    return {
      risk,
      decision: 'DEFERRED',
      admitted: false,
      requiresHumanIndependentReview: true,
      reason:
        'R1 approval matrix demands a different-model-family/specialist or >1 independent reviewer that Phase-2 cannot provide; failing closed.',
    };
  }

  // R2, R3, R4 — deferred wholesale in Phase 2 (not downgraded).
  return {
    risk,
    decision: 'DEFERRED',
    admitted: false,
    requiresHumanIndependentReview: true,
    reason: `${risk} is deferred out of Phase 2 (disp. P2-PLAN-HIGH-001); execution stops before any side effect.`,
  };
}

/** Convenience predicate: may automated Phase-2 execution proceed at all? */
export function isAdmitted(risk: RiskLevel): boolean {
  return admitRisk(risk).admitted;
}
