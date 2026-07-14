// Deterministic mandatory verification matrix.
//
// Maps each risk level R0-R4 to the assurance levels L0-L9 that are MANDATORY,
// loaded from the canonical policies/verification-matrix.yaml. An implementer
// may add checks but can never skip a mandatory level. Pure data lookup: no
// model call, no network.

import type { RiskLevel } from '@asep/contracts';
import { loadVerificationMatrix, type VerificationMatrixDoc } from './policy-source.js';

export type AssuranceLevel =
  | 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
  | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';

const ALL_LEVELS: readonly AssuranceLevel[] = [
  'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9',
];

const doc: VerificationMatrixDoc = loadVerificationMatrix();

function assertLevel(v: string, risk: string): AssuranceLevel {
  if (!(ALL_LEVELS as readonly string[]).includes(v)) {
    throw new Error(`verification: risk "${risk}" requires invalid level "${v}"`);
  }
  return v as AssuranceLevel;
}

/**
 * The mandatory assurance levels for a risk level, in ladder order (L0..L9).
 * Throws if the risk level is not defined in the matrix.
 */
export function requiredLevels(risk: RiskLevel): AssuranceLevel[] {
  const raw = doc.matrix[risk];
  if (!raw) throw new Error(`verification: no matrix entry for risk "${risk}"`);
  const levels = raw.map((l) => assertLevel(l, risk));
  // Return in canonical ladder order regardless of source ordering.
  return ALL_LEVELS.filter((l) => levels.includes(l));
}

/** Whether a given assurance level is mandatory at a risk level. */
export function isMandatory(risk: RiskLevel, level: AssuranceLevel): boolean {
  return requiredLevels(risk).includes(level);
}

/**
 * Validate that a proposed set of assurance levels satisfies the mandatory
 * minimum for the risk. Returns the missing mandatory levels (empty = ok).
 */
export function missingMandatory(
  risk: RiskLevel,
  proposed: readonly AssuranceLevel[],
): AssuranceLevel[] {
  const have = new Set(proposed);
  return requiredLevels(risk).filter((l) => !have.has(l));
}

export { ALL_LEVELS };
