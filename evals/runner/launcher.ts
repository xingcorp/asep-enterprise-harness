// Canonical evaluation launcher (P1-CYCLE4-MED-002).
//
// THE single trusted way to run the deterministic eval. It launches a fresh Node
// process whose FIRST application action is the determinism preload, then runs
// the worker-entry as the main module:
//
//   node --import <tsx-loader> --import <determinism-preload> <worker-entry>
//
// Trust properties (each maps to a task requirement):
//   (1) spawn with shell:false and an EXPLICIT arg list — no shell, no glob, no
//       word-splitting, no interpolation of untrusted strings;
//   (2) a SANITIZED environment — untrusted NODE_OPTIONS / --import / --require /
//       custom loader / inspector / arbitrary execArgv are stripped or rejected
//       so a caller cannot inject an alternate preload or a debugger that would
//       run before ours;
//   (3) the determinism preload is passed as an explicit --import controlled by
//       THIS launcher (absolute file: URL), so it is the first app-level action;
//   (4) raw stdout/stderr are captured IN FULL before any reducer/parse, so
//       evidence keeps the unmodified child output;
//   (5) the launcher verifies the preload ATTESTATION line is present in the
//       captured stderr — a run whose preload did not attest is treated as a
//       failure even if the child exited 0 (fail-closed);
//   (6) the child's exact exit code is propagated unchanged;
//   (7) the resolved preload path is surfaced in the result so evidence can bind
//       the exact bootstrap that executed.
//
// This launcher is deliberately NOT a security sandbox. See the threat-model note
// in env.ts and docs/architecture/adr/0016-phase-one-trusted-bootstrap.md: it is a trusted
// deterministic bootstrap, and OS-level isolation is a Phase 2 deliverable.

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the determinism preload this launcher controls. */
export const PRELOAD_PATH = join(HERE, 'determinism-preload.ts');
/** Absolute path to the trusted worker entry. */
export const WORKER_ENTRY_PATH = join(HERE, 'worker-entry.ts');
/** The attestation prefix the preload emits and this launcher requires. */
export const PRELOAD_ATTESTATION_PREFIX = 'ASEP-DETERMINISM-PRELOAD-OK';

export interface LaunchResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly attested: boolean;
  readonly preloadPath: string;
  readonly argv: readonly string[];
}

/**
 * Build a sanitized environment for the child. Anything that could cause code to
 * run BEFORE our preload — or swap our preload for another — is removed. We start
 * from a minimal allowlist rather than passing process.env wholesale.
 */
export function sanitizedChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Env vars that can inject pre-main code or a debugger into the child. These
  // are stripped unconditionally: the launcher, not the caller, decides what the
  // child loads before main.
  const DANGEROUS = new Set([
    'NODE_OPTIONS', // can carry --require/--import/--inspect/--loader
    'NODE_REPL_EXTERNAL_MODULE',
    'NODE_INSPECT_RESUME_ON_START',
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (DANGEROUS.has(k)) continue;
    // Any NODE_OPTIONS-like smuggling via oddly-cased keys is also dropped.
    if (/^NODE_OPTIONS$/i.test(k)) continue;
    out[k] = v;
  }
  // Pin locale/timezone in the child env too (the preload also sets these, but
  // setting them here means even pre-preload native init sees them).
  out.TZ = 'UTC';
  out.LANG = 'C';
  out.LC_ALL = 'C';
  return out;
}

/**
 * Resolve the tsx ESM loader entry so the child can execute the TypeScript
 * preload/worker directly. Using createRequire against this module keeps the
 * resolution local to the installed tsx, with no shell or PATH lookup.
 */
function resolveTsxLoader(): string {
  const require = createRequire(import.meta.url);
  // tsx's ESM loader entry (see its package.json "." export).
  const loaderPath = require.resolve('tsx');
  return pathToFileURL(loaderPath).href;
}

/**
 * Launch the deterministic eval through the trusted bootstrap. Returns the raw
 * captured output, the child's exit code, and whether the preload attested.
 * `opts.extraArgs` are passed to the worker-entry AFTER a `--` separator (none
 * used today, but the entry receives a clean argv).
 *
 * `opts.entryPath` overrides the main entry module (defaults to the canonical
 * worker-entry). Tests use this to drive an ADVERSARIAL entry through the exact
 * same trusted bootstrap (same sanitized env, same --import preload ordering),
 * so the adversarial fixture is evaluated post-preload just like real task code.
 *
 * `opts.omitPreload` launches the entry WITHOUT the determinism preload — the
 * bootstrap-order regression case. It must fail closed (attestation absent, the
 * entry's assertDeterminismEnforced throws) BEFORE any task/fixture module runs.
 */
export function launchEval(
  opts: {
    extraArgs?: readonly string[];
    entryPath?: string;
    omitPreload?: boolean;
  } = {},
): LaunchResult {
  const tsxLoader = resolveTsxLoader();
  const preloadUrl = pathToFileURL(PRELOAD_PATH).href;
  const entry = opts.entryPath ?? WORKER_ENTRY_PATH;

  // (1)+(3) Explicit arg list. Order matters: the tsx loader must be imported
  // before our TS preload so the preload's own TS can be evaluated; our preload
  // then runs before the worker-entry main module. When omitPreload is set we
  // deliberately DROP the determinism --import to exercise the fail-closed path.
  const args = [
    '--import',
    tsxLoader,
    ...(opts.omitPreload ? [] : ['--import', preloadUrl]),
    entry,
    ...(opts.extraArgs ?? []),
  ];

  // (2) Sanitized env; (1) shell:false explicit spawn.
  const child = spawnSync(process.execPath, args, {
    cwd: HERE,
    shell: false,
    env: sanitizedChildEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  // (4) Capture raw output in full.
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';

  // A spawn-level failure (missing binary, signal death) is a hard failure.
  if (child.error) {
    return {
      code: typeof child.status === 'number' ? child.status : 1,
      stdout,
      stderr: stderr + `launcher: spawn error: ${child.error.message}\n`,
      attested: false,
      preloadPath: PRELOAD_PATH,
      argv: args,
    };
  }

  // (5) Attestation check: the preload must have printed its OK line. Absence
  // means the preload did not run (or was replaced) — fail closed.
  const attested = stderr.includes(`${PRELOAD_ATTESTATION_PREFIX} `);

  // (6) Propagate the exact child exit code; a signal (null status) is a failure.
  let code = typeof child.status === 'number' ? child.status : 1;
  if (!attested && code === 0) {
    // The child exited clean but never attested — do NOT report success.
    code = 99;
  }

  return { code, stdout, stderr, attested, preloadPath: PRELOAD_PATH, argv: args };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const result = launchEval();
  // Stream the child's raw channels through unchanged.
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (!result.attested) {
    process.stderr.write(
      'launcher: FAIL — determinism preload did not attest; refusing to trust this run ' +
        '(P1-CYCLE4-MED-002)\n',
    );
  }
  process.exit(result.code);
}
