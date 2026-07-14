// Deterministic risk classification.
//
// The 13 change categories -> R0-R4 mapping is loaded from the canonical
// policies/risk-taxonomy.yaml (never hardcoded here). When a change touches
// multiple categories, the effective risk is the MAXIMUM level across matches.
// Pure data lookup: no model call, no network.

import type { RiskLevel } from '@asep/contracts';
import { loadRiskTaxonomy, type RiskTaxonomyDoc } from './policy-source.js';

export type ChangeCategory =
  | 'documentation'
  | 'internal-refactor'
  | 'ui-ux'
  | 'dependency-upgrade'
  | 'public-api'
  | 'database-migration'
  | 'authentication'
  | 'authorization'
  | 'infrastructure'
  | 'billing-payment'
  | 'secrets'
  | 'production-data'
  | 'multi-tenant-isolation';

const RISK_ORDER: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];

function rankOf(level: RiskLevel): number {
  const i = RISK_ORDER.indexOf(level);
  if (i < 0) throw new Error(`risk: unknown level "${level}"`);
  return i;
}

const doc: RiskTaxonomyDoc = loadRiskTaxonomy();

function assertRiskLevel(v: string, category: string): RiskLevel {
  if (!(RISK_ORDER as readonly string[]).includes(v)) {
    throw new Error(`risk: category "${category}" maps to invalid level "${v}"`);
  }
  return v as RiskLevel;
}

/** The baseline risk level for a single change category. */
export function riskForCategory(category: ChangeCategory): RiskLevel {
  const entry = doc.categories[category];
  if (!entry) throw new Error(`risk: unknown change category "${category}"`);
  return assertRiskLevel(entry.risk, category);
}

/**
 * Effective risk for a set of change categories = the maximum baseline level.
 * An empty set is R0 (nothing risky changed).
 */
export function classifyRisk(categories: readonly ChangeCategory[]): RiskLevel {
  let max: RiskLevel = 'R0';
  for (const c of categories) {
    const level = riskForCategory(c);
    if (rankOf(level) > rankOf(max)) max = level;
  }
  return max;
}

/** All known change categories (sorted, deterministic). */
export function changeCategories(): ChangeCategory[] {
  return Object.keys(doc.categories).sort() as ChangeCategory[];
}

/** Compare helper exported for the verification/approval engines. */
export function riskRank(level: RiskLevel): number {
  return rankOf(level);
}

export { RISK_ORDER };
