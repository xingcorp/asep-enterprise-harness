// Determinism preload (P1-CYCLE4-MED-002).
//
// This module is loaded via `node --import <determinism-preload> <worker-entry>`
// so that enforceDeterminism() is the FIRST application-level action in the
// process — it runs BEFORE the worker-entry module and therefore before ANY
// task/grader/fixture module is evaluated. Because Node evaluates `--import`
// modules before the main entry, no task-authored top-level code can capture an
// un-poisoned builtin reference: by the time any fixture's module body runs, the
// network/process surface is already denied and syncBuiltinESMExports() has
// rebuilt the ESM named bindings.
//
// The preload also emits a single machine-readable ATTESTATION line to stderr so
// the launcher can prove (from captured output) that the preload actually ran,
// and records the preload's own resolved path so evidence can bind the exact
// bootstrap that executed.
//
// This file intentionally does the LEAST possible: enforce, attest, done. It
// must not import task code, read fixtures, or open files beyond what
// enforceDeterminism needs — anything it touches runs pre-attestation.

import { fileURLToPath } from 'node:url';
import { enforceDeterminism, isDeterminismEnforced } from './env.js';

/** The machine-readable attestation prefix the launcher greps for. */
export const PRELOAD_ATTESTATION_PREFIX = 'ASEP-DETERMINISM-PRELOAD-OK';

// Enforce immediately at module load — this is the whole point of a preload.
enforceDeterminism();

// Fail hard if enforcement somehow did not take: never continue into an
// unguarded process pretending to be guarded.
if (!isDeterminismEnforced()) {
  process.stderr.write(
    'ASEP-DETERMINISM-PRELOAD-FAIL: enforceDeterminism() did not take effect\n',
  );
  process.exit(97);
}

// Attestation line: prefix + resolved preload path. The launcher asserts this
// exact prefix appears in captured stderr before it trusts the run, and the
// path lets evidence bind the specific bootstrap file/version that executed.
const selfPath = fileURLToPath(import.meta.url);
process.stderr.write(`${PRELOAD_ATTESTATION_PREFIX} ${selfPath}\n`);
