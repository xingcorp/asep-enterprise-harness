import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseExperimentalOutputReducer, gatePolicy } from './index.js';

test('critical changes never auto merge', () => {
  assert.equal(gatePolicy('R4').allowAutoMerge, false);
  assert.equal(gatePolicy('R4').requireHumanRelease, true);
});

test('output reducer cannot process diagnostics', () => {
  assert.equal(canUseExperimentalOutputReducer({ risk: 'R1', commandCategory: 'DIAGNOSTIC', rawCaptured: true }), false);
});
