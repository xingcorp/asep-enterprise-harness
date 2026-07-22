// Deterministic eval runner CLI (P1-CYCLE4-MED-002).
//
// Usage: pnpm --filter @asep/evals eval
//
// This CLI is the canonical, trusted way to run the eval from the command line.
// It does NOT grade in-process; instead it delegates to the trusted launcher
// (launcher.ts), which spawns a fresh Node process whose FIRST application-level
// action is the determinism preload:
//
//   node --import <tsx> --import <determinism-preload> <worker-entry>
//
// Doing it this way — rather than calling runEval() directly here — is the whole
// point of the cycle-4 repair: a direct in-process runEval() would let any task/
// grader/fixture module captured at import time obtain an un-poisoned builtin
// reference before enforceDeterminism() ran. Routing through the launcher makes
// the preload the first thing that executes, and makes the run fail closed if the
// preload did not attest.
//
// The launcher streams the child's raw stdout (the stable JSON report) and stderr
// (including the preload attestation line) through unchanged, and this CLI
// propagates the child's exact exit code. So `pnpm --filter @asep/evals eval`
// still prints byte-identical JSON on stdout, but now with the trusted-bootstrap
// guarantee behind it.

import { launchEval } from './launcher.js';

const result = launchEval();

// Stream the child's raw channels through unchanged: stdout is the deterministic
// JSON report; stderr carries the preload attestation line evidence binds to.
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

if (!result.attested) {
  process.stderr.write(
    'eval: FAIL — determinism preload did not attest; refusing to trust this run ' +
      '(P1-CYCLE4-MED-002)\n',
  );
}

// Propagate the child's exact exit code (non-zero on any fixture failure, on a
// missing/failed attestation, or on a spawn-level error).
process.exit(result.code);
