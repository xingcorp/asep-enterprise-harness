// Deterministic eval runner CLI.
//
// Usage: pnpm --filter @asep/evals eval
// Prints the stable JSON report to stdout (sorted keys, trailing newline) so
// two runs from a clean checkout are byte-identical and can be diffed / hashed.

import { runEval, stableStringify } from './run.js';

const report = runEval();
process.stdout.write(stableStringify(report));

// Exit non-zero if any fixture failed, so CI treats a grader regression as red.
process.exit(report.failed > 0 ? 1 : 0);
