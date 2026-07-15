import test from 'node:test';
import assert from 'node:assert/strict';
import type { RiskLevel } from '@asep/contracts';
import {
  loadRiskTaxonomy,
  loadVerificationMatrix,
  loadApprovalMatrix,
  loadFailureTaxonomy,
} from './policy-source.js';
import { changeCategories, riskForCategory, RISK_ORDER } from './risk.js';
import { requiredLevels } from './verification.js';
import { approvalFor, gatePolicy } from './index.js';
import { failureClasses, failureInfo } from './failure.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RISKS: RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];

// P1-CHANGE-004: the YAML is the single authority and the TS surface must be a
// faithful projection of it — no independent hardcoded second source.

// P1-FINAL-HIGH-005: the legacy policies/risk-policy.yaml was a second, divergent
// risk authority (nested envelope, R4 missing a field) that no code loaded. It is
// removed; the canonical risk authority is risk-taxonomy.yaml + approval-matrix.yaml.
// This guard fails if a duplicate risk authority silently reappears.
test('no legacy duplicate risk authority (risk-policy.yaml) exists', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..');
  const legacy = join(repoRoot, 'policies', 'risk-policy.yaml');
  assert.equal(
    existsSync(legacy),
    false,
    'policies/risk-policy.yaml reappeared — it is a removed duplicate risk authority; ' +
      'the canonical source is risk-taxonomy.yaml + approval-matrix.yaml (P1-FINAL-HIGH-005)',
  );
});

test('risk taxonomy: TS categories exactly match the YAML categories', () => {
  const doc = loadRiskTaxonomy();
  const yamlCats = Object.keys(doc.categories).sort();
  const tsCats = changeCategories().slice().sort();
  assert.deepEqual(tsCats, yamlCats);
});

test('risk taxonomy: every category resolves to a defined R0-R4 level', () => {
  for (const cat of changeCategories()) {
    const level = riskForCategory(cat);
    assert.ok(RISK_ORDER.includes(level), `${cat} -> ${level}`);
  }
});

test('risk taxonomy: covers the 13 mandated change categories', () => {
  const required = [
    'documentation', 'internal-refactor', 'public-api', 'database-migration',
    'authentication', 'authorization', 'secrets', 'infrastructure',
    'billing-payment', 'production-data', 'multi-tenant-isolation', 'ui-ux',
    'dependency-upgrade',
  ].sort();
  assert.deepEqual(changeCategories().slice().sort(), required);
});

test('verification matrix: every risk maps to a non-empty mandatory set', () => {
  const doc = loadVerificationMatrix();
  for (const risk of RISKS) {
    assert.ok(doc.matrix[risk], `YAML missing ${risk}`);
    assert.ok(requiredLevels(risk).length > 0, `${risk} has no mandatory levels`);
  }
});

test('verification matrix: mandatory levels are monotonic in risk', () => {
  // A higher risk must require a superset of every lower risk's levels.
  for (let i = 1; i < RISKS.length; i++) {
    const lower = new Set(requiredLevels(RISKS[i - 1]!));
    const higher = new Set(requiredLevels(RISKS[i]!));
    for (const l of lower) {
      assert.ok(higher.has(l), `${RISKS[i]} must include ${l} from ${RISKS[i - 1]}`);
    }
  }
});

test('approval matrix: TS approvalFor matches the YAML row for every risk', () => {
  const doc = loadApprovalMatrix();
  for (const risk of RISKS) {
    const row = doc.matrix[risk]!;
    const a = approvalFor(risk);
    assert.equal(a.independentReviewers, row['independentReviewers'], `${risk} reviewers`);
    assert.equal(a.requireHumanMerge, row['requireHumanMerge'], `${risk} humanMerge`);
    assert.equal(a.requireHumanRelease, row['requireHumanRelease'], `${risk} humanRelease`);
    assert.equal(a.allowAutoMerge, row['allowAutoMerge'], `${risk} autoMerge`);
    assert.equal(a.requireDifferentModelFamily, row['requireDifferentModelFamily'], `${risk} family`);
  }
});

test('gatePolicy is derived from the approval matrix (single authority)', () => {
  for (const risk of RISKS) {
    const g = gatePolicy(risk);
    const a = approvalFor(risk);
    assert.equal(g.independentReviewers, a.independentReviewers);
    assert.equal(g.requireDifferentModelFamily, a.requireDifferentModelFamily);
    assert.equal(g.requireHumanMerge, a.requireHumanMerge);
    assert.equal(g.requireHumanRelease, a.requireHumanRelease);
    assert.equal(g.allowAutoMerge, a.allowAutoMerge);
  }
});

test('gatePolicy preserves the historical R4 contract', () => {
  // Backward-compatibility with the pre-existing gate policy tests.
  assert.equal(gatePolicy('R4').allowAutoMerge, false);
  assert.equal(gatePolicy('R4').requireHumanRelease, true);
  assert.equal(gatePolicy('R0').allowAutoMerge, true);
  assert.equal(gatePolicy('R2').requireHumanMerge, true);
});

test('failure taxonomy: TS classes exactly match the YAML classes', () => {
  const doc = loadFailureTaxonomy();
  const yamlClasses = Object.keys(doc.classes).sort();
  assert.deepEqual(failureClasses().slice().sort(), yamlClasses);
});

test('failure taxonomy: every class has complete metadata', () => {
  const validAttribution = new Set(['agent', 'environment', 'provider', 'pre-existing', 'harness']);
  for (const cls of failureClasses()) {
    const info = failureInfo(cls);
    assert.ok(validAttribution.has(info.attribution), `${cls} attribution`);
    assert.equal(typeof info.retriable, 'boolean', `${cls} retriable`);
    assert.equal(typeof info.countsAgainstAgent, 'boolean', `${cls} countsAgainstAgent`);
    assert.ok(info.description.length > 0, `${cls} description`);
  }
});
