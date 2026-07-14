import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRisk,
  riskForCategory,
  changeCategories,
  type ChangeCategory,
} from './risk.js';

// Table-driven: every one of the 13 categories has an expected baseline level.
const EXPECTED: Record<ChangeCategory, string> = {
  documentation: 'R0',
  'internal-refactor': 'R1',
  'ui-ux': 'R2',
  'dependency-upgrade': 'R2',
  'public-api': 'R3',
  'database-migration': 'R3',
  authentication: 'R3',
  authorization: 'R3',
  infrastructure: 'R3',
  'billing-payment': 'R3',
  secrets: 'R4',
  'production-data': 'R4',
  'multi-tenant-isolation': 'R4',
};

test('all 13 change categories are present', () => {
  assert.equal(changeCategories().length, 13);
});

test('each category maps to its expected baseline risk', () => {
  for (const [category, level] of Object.entries(EXPECTED)) {
    assert.equal(
      riskForCategory(category as ChangeCategory),
      level,
      `category ${category} should be ${level}`,
    );
  }
});

test('effective risk is the maximum across categories', () => {
  assert.equal(classifyRisk(['documentation', 'secrets']), 'R4');
  assert.equal(classifyRisk(['documentation', 'internal-refactor']), 'R1');
  assert.equal(classifyRisk(['public-api', 'ui-ux']), 'R3');
});

test('an empty change set is R0', () => {
  assert.equal(classifyRisk([]), 'R0');
});

test('an unknown category throws (deterministic, no silent default)', () => {
  assert.throws(() => riskForCategory('nonsense' as ChangeCategory));
});
