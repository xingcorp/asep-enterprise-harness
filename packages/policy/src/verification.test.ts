import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredLevels,
  isMandatory,
  missingMandatory,
  type AssuranceLevel,
} from './verification.js';
import type { RiskLevel } from '@asep/contracts';

// Table-driven mandatory verification matrix (mirrors verification-matrix.yaml).
const EXPECTED: Record<RiskLevel, AssuranceLevel[]> = {
  R0: ['L0', 'L1'],
  R1: ['L0', 'L1', 'L2'],
  R2: ['L0', 'L1', 'L2', 'L3', 'L4', 'L8'],
  R3: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
  R4: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'],
};

test('required levels match the matrix for every risk', () => {
  for (const [risk, levels] of Object.entries(EXPECTED)) {
    assert.deepEqual(requiredLevels(risk as RiskLevel), levels, `risk ${risk}`);
  }
});

test('higher risk is a superset of lower risk (monotonic)', () => {
  const order: RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];
  for (let i = 1; i < order.length; i++) {
    const lower = new Set(requiredLevels(order[i - 1]!));
    const higher = new Set(requiredLevels(order[i]!));
    for (const l of lower) {
      assert.ok(higher.has(l), `${order[i]} must include ${l} from ${order[i - 1]}`);
    }
  }
});

test('independent review (L8) is mandatory from R2 upward', () => {
  assert.equal(isMandatory('R0', 'L8'), false);
  assert.equal(isMandatory('R1', 'L8'), false);
  assert.equal(isMandatory('R2', 'L8'), true);
  assert.equal(isMandatory('R3', 'L8'), true);
  assert.equal(isMandatory('R4', 'L8'), true);
});

test('release rehearsal (L9) is mandatory only at R4', () => {
  assert.equal(isMandatory('R3', 'L9'), false);
  assert.equal(isMandatory('R4', 'L9'), true);
});

test('missingMandatory reports gaps against a proposed set', () => {
  assert.deepEqual(missingMandatory('R2', ['L0', 'L1']), ['L2', 'L3', 'L4', 'L8']);
  assert.deepEqual(missingMandatory('R0', ['L0', 'L1']), []);
});
