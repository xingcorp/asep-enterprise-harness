// Canonical test discovery + required-suite manifest (P1-CYCLE4-MED-001).
//
// The previous canonical test command relied on a shell glob:
//   tsx --test packages/**/*.test.ts ... scripts/**/*.test.ts
// Under the /bin/sh used by `pnpm run`, `**` is NOT recursive, so
// `scripts/**/*.test.ts` matched only `scripts/lib/acceptance-crypto.test.ts`
// and silently DROPPED scripts/check-acceptance.test.ts (the acceptance
// self-test, empty-head, signature-forgery and env-digest-tamper cases) and
// scripts/forbidden-imports.test.ts. Those critical suites existed in the repo
// but never ran under `pnpm test`.
//
// This module replaces the shell glob with a deterministic, shell-free Node
// walk. It is imported by:
//   - scripts/run-canonical-tests.mjs        (the CLI runner)
//   - scripts/run-canonical-tests.test.ts    (the wiring test)
// so the discovery logic and the required-suite manifest are proven by the same
// test suite they gate.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Canonical source roots that may contain *.test.ts files. A test file living
// anywhere under these roots is IN SCOPE for the canonical command; if it is not
// discovered, the runner fails closed (a file that exists but never runs is a
// silent coverage hole — exactly the MED-001 defect).
export const TEST_ROOTS = [
  'packages',
  'apps',
  'workers',
  'adapters',
  'evals',
  'scripts',
];

// Directories never traversed during discovery.
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

const TEST_SUFFIX = '.test.ts';

/**
 * Recursively discover every *.test.ts file under the canonical roots.
 * Returns REPO-RELATIVE, POSIX-normalised, lexicographically-sorted paths so the
 * result is byte-stable across platforms and independent of readdir order.
 */
export function discoverTestFiles(repoRoot) {
  const found = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch {
      return; // a missing root is simply empty, not an error
    }
    for (const entry of entries.sort()) {
      if (IGNORE_DIRS.has(entry)) continue;
      const full = join(absDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(TEST_SUFFIX)) {
        found.push(full);
      }
    }
  };

  for (const root of TEST_ROOTS) {
    const absRoot = join(repoRoot, root);
    if (existsSync(absRoot)) walk(absRoot);
  }

  const rel = found.map((f) => relative(repoRoot, f).split(sep).join('/'));
  // De-dupe (defensive) and sort for a deterministic run order.
  return [...new Set(rel)].sort();
}

/**
 * Required critical suites. Each maps a machine-readable SUITE ID to the
 * repo-relative test file that MUST both (a) be discovered by the walk above and
 * (b) emit its SUITE ID at module load. The runner asserts every ID appears in
 * the captured test output, so a critical suite that is dropped, renamed away,
 * or crashes before running turns the gate RED even if the process exits 0.
 *
 * These are the security/assurance suites the MED-001 shell glob was silently
 * skipping, plus the crypto helpers and network guard they depend on.
 */
export const REQUIRED_SUITES = Object.freeze({
  'asep-suite:acceptance-crypto': 'scripts/lib/acceptance-crypto.test.ts',
  'asep-suite:acceptance-marker': 'scripts/check-acceptance.test.ts',
  'asep-suite:forbidden-imports': 'scripts/forbidden-imports.test.ts',
  // TypeScript-checker fitness guard: retired isolation waivers and isolation
  // claims outside the Docker sandbox provider (exit E8/G3).
  'asep-suite:ts-guard': 'scripts/ts-guard.test.ts',
  // Build-graph fitness: a project that imports a workspace package without
  // declaring the matching `references` entry passes on a warm tree and fails on
  // a clean checkout. Registered so the guard cannot be dropped silently.
  'asep-suite:project-references': 'scripts/project-references.test.ts',
  // The cold-cache reset that runs before typecheck must fail closed: a removal
  // error or a surviving dist/ / *.tsbuildinfo fails the step instead of
  // printing PASS over a warm tree.
  'asep-suite:cold-cache-reset': 'scripts/cold-cache-reset.test.ts',
  // The PII gate covers git author/committer metadata, not only tracked files:
  // a commit under a personal address fails it (published history excepted for
  // the one pinned legacy address).
  'asep-suite:pii-scan': 'scripts/pii-scan.test.ts',
  'asep-suite:eval-network-guard': 'evals/runner/env.test.ts',
  'asep-suite:trusted-bootstrap': 'evals/runner/launcher.test.ts',
  'asep-suite:compat-gate': 'packages/contracts/src/compat-gate.test.ts',
  // The runner's own wiring suite must itself run under the canonical command —
  // otherwise the mechanism that guards every other required suite could be
  // silently dropped, which is the MED-001 defect one level up.
  'asep-suite:canonical-runner': 'scripts/run-canonical-tests.test.ts',
  // Phase 2 critical suites (exit criterion K4): tenancy/migration/lease and the
  // content-addressed artifact store. Registered here so a dropped, renamed, or
  // crash-before-first-line Phase-2 suite turns the gate RED, same mechanism as
  // the Phase-1 SUITE-IDs above.
  'asep-suite:persistence-tenancy': 'adapters/persistence/src/persistence.test.ts',
  'asep-suite:artifact-store': 'adapters/persistence/src/artifact-store.test.ts',
  'asep-suite:git-worktree': 'adapters/git-worktree/src/git-worktree.test.ts',
  'asep-suite:command-runner': 'adapters/command-runner/src/command-runner.test.ts',
  'asep-suite:agent-claude': 'adapters/agent-claude/src/agent-claude.test.ts',
  'asep-suite:github-app': 'adapters/github-app/src/github-app.test.ts',
  // S9 crash-safety suites (exit criteria D8/C7): the preallocated-id evidence
  // store and the two-phase side-effect log carry the correctness guarantees for
  // resultSha integrity and single-ref/single-PR convergence, so a dropped or
  // renamed suite must turn the gate RED.
  'asep-suite:evidence-store': 'adapters/persistence/src/evidence-store.test.ts',
  'asep-suite:side-effect-log': 'adapters/persistence/src/side-effect-log.test.ts',
  // K1 full vertical integration test: real PG + real temp Git + real worktree
  // + real artifact + real runner + fake Claude + fake GitHub. Registered so a
  // dropped/renamed end-to-end suite turns the gate RED.
  'asep-suite:vertical-integration': 'apps/control-plane-api/src/vertical-integration.test.ts',
  // J observability suites (exit criteria J1/J2/J4): the closed span vocabulary
  // + correlation-identity tracer and the privileged-operation audit vocabulary.
  // Registered so a dropped/renamed observability suite turns the gate RED.
  'asep-suite:observability-spans': 'packages/observability/src/spans.test.ts',
  'asep-suite:observability-audit': 'packages/observability/src/audit.test.ts',
  // K5/K6 pilot-manifest verifier: the adversarial gate on a COMPLETE verdict
  // (ten genuine tasks, real provider, unique work orders, resolvable traces).
  // Registered so a dropped/renamed pilot gate turns the gate RED.
  'asep-suite:pilot-manifest': 'scripts/pilot/verify-pilot-manifest.test.ts',
  // HIGH-001 integration-gate negative tests: prove the gate goes RED (never a
  // silent skip) when a backend is absent, an image is not digest-pinned,
  // discovery finds nothing, or a required itest marker is missing. The
  // fail-closed logic runs under the fast unit runner; the live-backend proof is
  // the *.itest.ts suites under scripts/integration/run-integration.mjs.
  'asep-suite:integration-gate': 'scripts/integration/run-integration.test.ts',
  // HIGH-003 governed-execution: proves the TOP-LEVEL use case runs admission
  // BEFORE any lease/workspace/agent/inspect side effect — R2..R4 defer with
  // every downstream port spy at exactly zero calls. Registered so a dropped or
  // renamed admission-ordering suite turns the gate RED.
  'asep-suite:governed-execution': 'packages/application/src/governed-execution.test.ts',
  // MED-006 executable pilot rehearsal: the five injected faults run against
  // REAL mechanisms (PGlite DB restart / side-effect reconciliation, filesystem
  // object-store outage, real lease TTL-sweep) and assert the documented
  // recovery decision on real state. Registered so a dropped/renamed rehearsal
  // suite turns the gate RED.
  'asep-suite:pilot-rehearsal': 'adapters/persistence/src/pilot-rehearsal.test.ts',
  // HIGH-008 forge port conformance: the ONE type that both `implements
  // ForgeProvider` and drives the GitHub App adapter. Proves the real adapter is
  // reachable through the application port (pushing the EXACT harness commit
  // from a detached worktree to a real bare remote), that ref safety and tenant
  // scoping hold through the seam, and that no merge capability exists.
  // Registered so a dropped/renamed conformance suite turns the gate RED.
  'asep-suite:forge-port-adapter': 'adapters/github-app/src/port-adapter.test.ts',
  // HIGH-008 production composition root: proves the ONE wiring that binds the
  // REAL ClaudeCodingProvider + GitHubAppForgePort to the seams the vertical
  // slice consumes, and that an unconfigured deployment fails CLOSED instead of
  // silently falling back to a test double. Registered so deleting the only
  // production wiring turns the gate RED.
  'asep-suite:production-root': 'apps/control-plane-api/src/production-root.test.ts',
  // HIGH-008 pilot ENTRYPOINT: the caller that turns the production seams into a
  // live run. Pins fail-closed config reading (every knob required, blank ==
  // absent, base SHA must be a real 40-hex commit) and the hardened agent
  // container flags. Registered because "supply credentials and it runs live" is
  // only falsifiable if the entrypoint's contract is itself gated.
  'asep-suite:pilot-main': 'apps/control-plane-api/src/pilot-main.test.ts',
  // HIGH-008/K2 pilot TARGET seams: proves the driver attempts against the
  // caller's real mirror + registers the real owner/repo INCLUDING the numeric
  // github_repository_id the forge resolver fails closed without, publishes the
  // leased worktree path, and honours the real work order + provenance. Also
  // pins that omitting them keeps the synthetic default, so both K1 proofs stay
  // byte-for-byte unchanged.
  'asep-suite:pilot-target': 'apps/control-plane-api/src/pilot-target.test.ts',
  // HIGH-009: the pilot authority resolver's SQL executed against the REAL
  // migrated schema. The existing resolver suite uses a fake db that returns
  // canned rows and never parses SQL, which is how `select attempts.run_id` — a
  // column that does not exist — shipped green: every authoritative attempt
  // lookup threw at runtime, so the COMPLETE gate could not verify a manifest at
  // all. Registered so a schema/query divergence turns the gate RED.
  'asep-suite:authority-resolver-sql': 'adapters/persistence/src/authority-resolver-sql.test.ts',
  // Crash recovery through a fenced lease takeover: a successor waits out a live
  // lease, takes the dead executor's unfinished side effects over under a newer
  // epoch, reconciles them against the forge and converges on one commit, one
  // ref and one PR, while the dead executor is refused.
  'asep-suite:crash-recovery': 'apps/control-plane-api/src/crash-recovery.test.ts',
  // The pilot verifier over a real governed slice: the production resolver
  // accepts what the run backs, and refuses it once the PR head moves, the
  // stored evidence bytes change, or the signature binds another commit.
  'asep-suite:pilot-verifier': 'apps/control-plane-api/src/pilot-verifier.test.ts',
  // Pilot rehearsal faults 3 (object-store outage at the evidence write) and 5
  // (GitHub rate limit on the PR) injected into a real run of the governed
  // pipeline, with the runbook's recovery followed on the state it leaves.
  'asep-suite:pilot-faults': 'apps/control-plane-api/src/pilot-faults.test.ts',
  // The resume path is admitted from the task row's own risk BEFORE its lease:
  // a deferred risk (R2–R4) stops having touched nothing but that read.
  'asep-suite:resume-attempt': 'packages/application/src/resume-attempt.test.ts',
  // Every Node process that runs tests starts with --no-wasm-code-gc
  // (nodejs/node#66366): this run's own test child, a child started with the
  // runners' argv, and every test entry point of the repository.
  'asep-suite:node-test-flags': 'scripts/node-test-flags.test.ts',
  // The deterministic workflow decision core: the task and run reducer tables
  // (agent failure and replacement, budgets, approvals, assurance routing,
  // pause/cancel, sequential children), the generated-trace safety properties
  // (one push per task, reservation, one outcome per attempt, assurance before
  // publish), and the static determinism rules for its source files.
  'asep-suite:orchestration-core': 'packages/orchestration/src/decide.test.ts',
  'asep-suite:orchestration-properties': 'packages/orchestration/src/invariants.test.ts',
  'asep-suite:orchestration-purity': 'packages/orchestration/src/purity.test.ts',
  // The shared foundation of the two lanes: the review-loop slot conformance kit
  // run against the default, disabled and scripted slots (the stateful default
  // slot on a real database), and the run-event sink with the attempt-terminal
  // writes on it.
  'asep-suite:assurance-slot-contract': 'packages/application/src/orchestration-activities/assurance-slot.test.ts',
  'asep-suite:run-event-sink': 'adapters/persistence/src/run-events/run-event-sink.test.ts',
  // The orchestration policy loader refuses a never-replaceable class, a kill
  // grace other than the agent adapter's stop bound, and an attempt wall-clock
  // the egress proxy cannot outlive.
  'asep-suite:orchestration-policy-loader': 'packages/policy/src/orchestration-policy.test.ts',
});

/** The machine-readable marker a suite prints at module load: `SUITE-ID: <id>`. */
export const SUITE_ID_PREFIX = 'SUITE-ID:';

/** Format the marker line a critical test file emits at module top level. */
export function suiteMarker(id) {
  return `${SUITE_ID_PREFIX} ${id}`;
}

/**
 * Pure required-suite verification (P1-CYCLE4-MED-001). Given the combined
 * stdout+stderr of a test run, return the list of required suites whose
 * SUITE-ID marker did NOT appear — i.e. suites that were dropped, renamed away,
 * or crashed before their first line. An empty list means every critical suite
 * ran. This is extracted as a pure function so the wiring test can drive the
 * fail-closed logic directly, without spawning a doctored child.
 */
export function missingRequiredSuites(combinedOutput) {
  const missing = [];
  for (const [id, file] of Object.entries(REQUIRED_SUITES)) {
    if (!combinedOutput.includes(suiteMarker(id))) {
      missing.push({ id, file });
    }
  }
  return missing;
}
