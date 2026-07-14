import test from 'node:test';
import assert from 'node:assert/strict';
import { transition } from './index.js';
import type { RunId } from '@asep/contracts';

test('run state machine rejects unsafe skips', () => {
  const run = { id: 'run-1' as RunId, status: 'DRAFT' as const, version: 0 };
  assert.throws(() => transition(run, 'DONE'));
  assert.equal(transition(run, 'DISCOVERY').status, 'DISCOVERY');
});
