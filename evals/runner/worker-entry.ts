// Trusted worker entry (P1-CYCLE4-MED-002).
//
// This is the module the canonical launcher runs AS THE MAIN ENTRY, always
// preceded by `--import <determinism-preload>`. Node evaluates the preload
// first, so by the time this file's body runs the determinism guard is already
// installed. This entry then:
//
//   1. ASSERTS the determinism preload ran (assertDeterminismEnforced) BEFORE it
//      touches any task/grader module. If the entry was launched WITHOUT the
//      preload (e.g. `node worker-entry.js` directly), this throws and the
//      process exits non-zero BEFORE any fixture module — which may capture
//      builtin references at its own top level — is ever imported. Fail-closed.
//   2. Only AFTER attestation passes does it DYNAMIC-import the runner (run.js),
//      whose transitive imports pull in the graders and (at call time) the
//      fixtures. Using dynamic import — not a static top-level import — is what
//      guarantees ordering: a static import would be hoisted and evaluated
//      alongside this module's imports, before the assertion could run.
//   3. Emits the stable JSON report to stdout and propagates the eval's exit
//      code unchanged (non-zero if any fixture failed).
//
// The assertion + dynamic-import ordering is the containment invariant: task
// code cannot evaluate in a process where the preload did not run.

import { assertDeterminismEnforced } from './env.js';

async function main(): Promise<number> {
  // (1) Fail closed if the preload did not run. This MUST come before any
  // import of task/grader/fixture code.
  assertDeterminismEnforced();

  // (2) Only now is it safe to load the runner and its transitive task code.
  const { runEval, stableStringify } = await import('./run.js');

  // (3) Produce the deterministic report and propagate the pass/fail exit code.
  const report = runEval();
  process.stdout.write(stableStringify(report));
  return report.failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // A failed attestation (or any load error) lands here: report and exit
    // non-zero. The message is written to stderr so stdout stays a clean report
    // channel for the deterministic JSON.
    process.stderr.write(
      `worker-entry: FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(98);
  },
);
