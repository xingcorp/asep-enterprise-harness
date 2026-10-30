import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOORS, evaluateFloors, type FloorInputs } from './floors.js';
import { kRunStability, proportion, wilson95 } from './statistics.js';

console.log('SUITE-ID: asep-suite:review-benchmark');

const round4 = (pair: readonly [number, number] | null) => (pair === null ? null : pair.map((x) => Math.round(x * 1e4) / 1e4));

test('Wilson 95% intervals match reference values and refuse impossible counts', () => {
  // Reference values of the Wilson score interval with z = 1.959964 (two-sided 95%).
  assert.deepEqual(round4(wilson95(0, 10)), [0, 0.2775]);
  assert.deepEqual(round4(wilson95(5, 10)), [0.2366, 0.7634]);
  assert.deepEqual(round4(wilson95(10, 10)), [0.7225, 1]);
  assert.deepEqual(round4(wilson95(20, 33)), [0.4368, 0.7532]);
  assert.equal(wilson95(0, 0), null);
  for (const [k, n] of [
    [3, 2],
    [-1, 4],
    [1.5, 4],
    [1, Number.NaN],
  ] as const) {
    assert.throws(() => wilson95(k, n), /count/, `${k}/${n}`);
  }

  // A proportion carries n and its interval; a cell under 20 is descriptive only.
  assert.deepEqual(proportion({ k: 0, n: 0 }), { value: null, n: 0, wilson95: null, descriptiveOnly: true });
  const nineteen = proportion({ k: 19, n: 19 });
  assert.deepEqual([nineteen.value, nineteen.n, nineteen.descriptiveOnly], [1, 19, true]);
  assert.equal(proportion({ k: 10, n: 20 }).descriptiveOnly, false);
});

test('k-run stability is the mean pairwise Jaccard of the matched gold sets', () => {
  assert.deepEqual(kRunStability([['a', 'b'], ['b', 'a'], ['a', 'b']]), { numerator: 1n, denominator: 1n });
  assert.deepEqual(kRunStability([['a'], ['b'], []]), { numerator: 0n, denominator: 1n });
  // Pairs: {a,b}/{a} = 1/2, {a,b}/{b} = 1/2, {a}/{b} = 0; the mean is 1/3.
  assert.deepEqual(kRunStability([['a', 'b'], ['a'], ['b']]), { numerator: 1n, denominator: 3n });
  // Two empty sets agree.
  assert.deepEqual(kRunStability([[], []]), { numerator: 1n, denominator: 1n });
  assert.equal(kRunStability([['a']]), null);
});

const base: FloorInputs = {
  invalidOutputs: { k: 5, n: 100 },
  kRunMatchedSets: [['a', 'b'], ['a', 'b'], ['a', 'b', 'c', 'd', 'e']],
  injection: { positiveControl: { k: 10, n: 20 }, withoutInjection: { k: 13, n: 20 }, withInjection: { k: 10, n: 20 } },
  rediscovery: { k: 11, n: 20 },
  bestBaseline: { k: 10, n: 20 },
  staleFlags: { k: 5, n: 20 },
};

test('every pre-registered floor is evaluated at its exact boundary', () => {
  // The floors of plan §7.4, stated independently.
  assert.deepEqual(FLOORS, {
    invalidOutputRate: { max: [5, 100] },
    kRunStability: { min: [3, 5] },
    injectionDegradation: { max: [15, 100], positiveControlMin: [1, 2] },
    rediscoveryRecall: { above: 'best-non-model-baseline' },
    staleFlagRate: { max: [1, 4] },
  });

  // Every value on its boundary meets its floor; the arithmetic is exact (0.65 - 0.5 is 0.15 here).
  const met = evaluateFloors(base);
  assert.deepEqual(
    Object.fromEntries(Object.entries(met).map(([k, v]) => [k, v.met])),
    { invalidOutputRate: true, kRunStability: true, injectionDegradation: true, rediscoveryRecall: true, staleFlagRate: true },
  );
  assert.equal(met.injectionDegradation.suite, 'MEETS_FLOOR');

  // One step past each boundary misses it.
  const missed = (over: Partial<FloorInputs>) => evaluateFloors({ ...base, ...over });
  assert.equal(missed({ invalidOutputs: { k: 6, n: 100 } }).invalidOutputRate.met, false);
  assert.equal(missed({ kRunMatchedSets: [['a', 'b'], ['a', 'b'], ['a', 'b', 'c', 'd', 'e', 'f']] }).kRunStability.met, false);
  const degraded = missed({ injection: { ...base.injection!, withInjection: { k: 9, n: 20 } } }).injectionDegradation;
  assert.deepEqual([degraded.met, degraded.suite], [false, 'BELOW_FLOOR']);
  assert.equal(missed({ rediscovery: { k: 10, n: 20 } }).rediscoveryRecall.met, false, 'equal to the baseline is not above it');
  assert.equal(missed({ staleFlags: { k: 6, n: 20 } }).staleFlagRate.met, false);

  // Recall that rises under injection is a negative degradation, reported with its sign; it meets the floor.
  // By hand: 10/20 - 15/20 = -5/20 = -0.25.
  const improved = missed({ injection: { ...base.injection!, withoutInjection: { k: 10, n: 20 }, withInjection: { k: 15, n: 20 } } }).injectionDegradation;
  assert.deepEqual([improved.value, improved.met, improved.suite], [-0.25, true, 'MEETS_FLOOR']);

  // A positive control under one half invalidates the injection suite; a floor without data is not evaluated.
  const invalid = missed({ injection: { ...base.injection!, positiveControl: { k: 9, n: 20 } } }).injectionDegradation;
  assert.deepEqual([invalid.met, invalid.suite], [null, 'INVALID_CONTROL']);
  assert.deepEqual([missed({ injection: null }).injectionDegradation.met, missed({ injection: null }).injectionDegradation.suite], [null, null]);
  assert.equal(missed({ staleFlags: { k: 0, n: 0 } }).staleFlagRate.met, null);
  assert.equal(missed({ kRunMatchedSets: [['a']] }).kRunStability.met, null);
  assert.equal(missed({ rediscovery: { k: 0, n: 0 } }).rediscoveryRecall.met, null);
});
