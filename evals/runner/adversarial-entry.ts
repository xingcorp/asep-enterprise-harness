// Adversarial entry (P1-CYCLE4-MED-002) — the hostile-grader launch harness.
//
// Run AS THE MAIN ENTRY through the canonical launcher, exactly like the real
// worker-entry:
//   node --import <tsx> --import <determinism-preload> <adversarial-entry>
//
// It mirrors the worker-entry contract precisely, which is the whole point:
//
//   1. ASSERT the determinism preload ran (assertDeterminismEnforced) BEFORE it
//      touches the adversarial fixture module. If launched WITHOUT the preload,
//      this throws and the process exits non-zero BEFORE the fixture module —
//      which carries the SENTINEL side-effect and all top-level reference
//      captures — is ever imported. The bootstrap-order regression test asserts
//      the sentinel is ABSENT in that case.
//   2. Only AFTER attestation passes does it DYNAMIC-import the adversarial
//      fixture body and run every egress probe.
//   3. Emit a single machine-readable ADVERSARIAL-RESULT: line the test parses,
//      and exit 0 iff every probe was blocked.
//
// Keeping the sentinel + captures in the SEPARATELY dynamic-imported fixture
// (not here) is what makes the ordering guarantee observable: task-shaped code
// cannot evaluate in a process where the preload did not run.

import { assertDeterminismEnforced } from './env.js';

async function main(): Promise<number> {
  // (1) Fail closed if the preload did not run — BEFORE importing the fixture.
  assertDeterminismEnforced();

  // (2) Only now is it safe to evaluate the adversarial fixture body (which
  // prints the sentinel and performs its top-level reference captures).
  const { runAdversarialProbes } = await import('./adversarial-fixture.js');
  const verdict = await runAdversarialProbes();

  // (3) Emit the machine-readable verdict and propagate pass/fail.
  process.stdout.write(`ADVERSARIAL-RESULT:${JSON.stringify(verdict)}\n`);
  return verdict.allAttemptsBlocked ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `adversarial-entry: FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(98);
  },
);
