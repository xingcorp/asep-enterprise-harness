// Canonical policy source loader.
//
// The four policy YAML files under <repo>/policies/ are the SINGLE canonical
// source for risk, verification, approval and failure policy. This module reads
// and parses them once. The TS engines (risk.ts, verification.ts, approval.ts,
// failure.ts) derive their behavior from these documents; they never hardcode
// the mappings. Parity tests assert the TS surface and the YAML agree.
//
// Policy evaluation is DETERMINISTIC: pure file read + parse + lookup. No model
// call, no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/policy/src -> repo root is three levels up.
const REPO_ROOT = join(HERE, '..', '..', '..');
const POLICY_DIR = join(REPO_ROOT, 'policies');

function loadYaml<T>(file: string): T {
  return parseYaml(readFileSync(join(POLICY_DIR, file), 'utf8')) as T;
}

export interface RiskTaxonomyDoc {
  readonly version: string;
  readonly levels: readonly string[];
  readonly categories: Record<string, { risk: string; description: string }>;
}

export interface VerificationMatrixDoc {
  readonly version: string;
  readonly levels: readonly string[];
  readonly matrix: Record<string, readonly string[]>;
}

export interface ApprovalMatrixDoc {
  readonly version: string;
  readonly matrix: Record<string, Record<string, number | boolean>>;
}

export interface FailureTaxonomyDoc {
  readonly version: string;
  readonly classes: Record<
    string,
    {
      description: string;
      attribution: string;
      retriable: boolean;
      countsAgainstAgent: boolean;
    }
  >;
}

export function loadRiskTaxonomy(): RiskTaxonomyDoc {
  return loadYaml<RiskTaxonomyDoc>('risk-taxonomy.yaml');
}
export function loadVerificationMatrix(): VerificationMatrixDoc {
  return loadYaml<VerificationMatrixDoc>('verification-matrix.yaml');
}
export function loadApprovalMatrix(): ApprovalMatrixDoc {
  return loadYaml<ApprovalMatrixDoc>('approval-matrix.yaml');
}
export function loadFailureTaxonomy(): FailureTaxonomyDoc {
  return loadYaml<FailureTaxonomyDoc>('failure-taxonomy.yaml');
}
