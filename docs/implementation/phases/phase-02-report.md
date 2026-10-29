# Phase 2 — Single-Agent Governed Vertical Slice — Report

> Machine-readable completion record for Phase 2. The YAML block below is the
> authoritative report; the prose after it is a human-readable companion. Every
> result stated here was observed by running the command named next to it;
> anything not run is marked as not run.

```yaml
apiVersion: asep.phase/v1
kind: PhaseReport
phase: 2
title: Single-Agent Governed Vertical Slice
verdict: IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED
verdict_note: >-
  This is not phase acceptance, and the "implementation complete" in the
  verdict is the implementer's claim, not a reviewed result. Two things are
  outstanding.

  (1) The live pilot has not run. K2 (one live task), K5 (ten genuine tasks in
  a verified manifest) and K6 are unmet: no model credential and no GitHub App
  private key are available in this environment. Per K6/L4 that is the case
  reserved for a pilot-pending verdict.

  (2) The repairs of repair cycle 9 are unreviewed. Codex re-review cycle 8 at
  d1d9e7a (phase-02-final-rereview-codex-v8.md) returned REQUEST_CHANGES @ 0.99
  and did not accept Phase 2. It accepted (RESOLVED) HIGH-001, HIGH-003,
  HIGH-004, HIGH-007, HIGH-008, MED-001, MED-002, MED-003, MED-004, MED-006,
  MED-NEW-001..004, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST, CYCLE7-HIGH-004,
  CYCLE7-HIGH-006, CYCLE7-HIGH-007 and CYCLE7-MED-001..004. It found HIGH-002,
  HIGH-005, HIGH-006, HIGH-009, MED-005, CYCLE7-HIGH-001, CYCLE7-HIGH-002,
  CYCLE7-HIGH-003 and CYCLE7-HIGH-005 PARTIAL, and restated what remained as
  CYCLE8-HIGH-001..004. Repair cycle 9 applies the controller's decisions on
  that review (reconciliation R30). Every repair, test and mutation check was
  produced and read by the implementer alone. Under this project's trust
  ordering (machine evidence > independent review > implementer self-review)
  that is not acceptance evidence, which is what the _UNREVIEWED suffix
  records.

  Earlier revisions of this report claimed more than the code did: that every
  finding was closed (before cycle 6), that cycle 7 had repaired every PARTIAL
  or REGRESSED finding, that every authoritative reference was a scoped key
  before migration 0019, and that the fencing epoch carried to the forge held a
  stale owner off it. The reviews showed each was wrong. This revision states
  the gate results observed in this cycle and the status of each finding, and
  nothing else as verified.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: base = `git merge-base main HEAD`.
  last_reviewed_head: d1d9e7a (Codex re-review cycle 8, REQUEST_CHANGES)
  under_review: none
  implementation_head_sha: aa946cf6d294704a3fedc17aa84d29da43c85eac
  head_binding: >-
    implementation_head_sha is the last implementation commit of repair cycle
    9 (`git rev-parse aa946cf`). The commits after it change documentation
    only. A commit cannot contain its own hash, so the true HEAD is bound
    outside this file (exit L1): the gitignored
    `.phase-02-implementation-complete` sentinel is written last, after
    `pnpm verify:all` and `pnpm test:integration` pass on the report commit, and
    holds the output of `git rev-parse HEAD` at that moment. Audit: compare the
    sentinel to `git rev-parse HEAD`; they must be byte-identical. Any later
    commit invalidates it.

versions:
  node: v24.6.0
  pnpm: 10.31.0
  typescript: 7.0.2
  docker: 29.6.1
  test_runner: tsx --test, every test process started with --no-wasm-code-gc

verification:
  observed_at: >-
    b7f1df1686bbd3cec354b69ad5d33274d14706e7, from a clean tree; it differs from
    implementation_head_sha by documentation only
  install: "pnpm install --frozen-lockfile — exit 0"
  verify_all: "pnpm verify:all — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (36/36), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree"
  canonical_tests: "795 tests, 795 pass, 0 fail, 0 skipped, across 58 test files; 36 required suite markers verified by scripts/run-canonical-tests.mjs"
  integration_gate: "pnpm test:integration — exit 0; 34 tests, 34 pass, 0 fail, 0 skipped, across 7 *.itest.ts files on digest-pinned PostgreSQL and MinIO and Docker 29.6.1 (backends published on 127.0.0.1 only); 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained"
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates and was not run in
    this cycle. Its CONFORMANCE test last ran at dec962b (cycle-7 follow-up)
    and passed; the agent network's creation and inspection changed after it
    (9d782c1). Its LIVE test (real model API) has never run here: no
    credential.
  mutation_checks: >-
    Run by the implementer for every cycle-8 finding: 48 mutants, all killed
    (CYCLE8-HIGH-001 6, CYCLE8-HIGH-002 7, CYCLE8-HIGH-003 19, CYCLE8-HIGH-004
    with the flag equality 16). Mutants per finding are in
    phase-02-review-log.md, "Final review cycle 8 dispositions".

findings_cycle_8:
  note: >-
    Status after repair cycle 9, as assessed by the implementer; none is
    independently confirmed. Details, tests, mutation checks and residual
    concerns per finding: phase-02-review-log.md, "Final review cycle 8
    dispositions".
  accepted_by_review_at_cycle_8: [HIGH-001, HIGH-003, HIGH-004, HIGH-007, HIGH-008, MED-001, MED-002, MED-003, MED-004, MED-006, MED-NEW-001, MED-NEW-002, MED-NEW-003, MED-NEW-004, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST, CYCLE7-HIGH-004, CYCLE7-HIGH-006, CYCLE7-HIGH-007, CYCLE7-MED-001, CYCLE7-MED-002, CYCLE7-MED-003, CYCLE7-MED-004]
  repaired_unreviewed:
    CYCLE8-HIGH-001: "0ab88f7 — the runner executes a private, frozen copy of the provider's flags; the handle and each result's provenance hold their own frozen copies"
    CYCLE8-HIGH-002: "fdd3226 — migration 0019: command output references bound with checksum and kind; a registry of every artifact reference; the test finds references by name, registry and foreign key"
    CYCLE8-HIGH-003: "aa946cf — not fenced at the forge: push compare-and-set, PR content a pure function of the attempt's facts, and reconciliation of branch and PR before any terminal state, each repair audited (forge.reconcile)"
    CYCLE8-HIGH-004: "9089154 — mandatory coverage from the pinned verification matrix for the task's risk; sandbox flags by equality with the profile, aliases normalized"
    migration_0018_old_data: "accepted as designed; data model and runbook say 0017-0019 need a fresh database or a separate data procedure"
    MED-005: "this report and the L1 sentinel"
    R26: "e6ede74 — every Node test process starts with --no-wasm-code-gc (nodejs/node#66366)"
    timeouts_under_load: "bc4cca5 — each ~30 s failure traced to a named bound and the bound sized from measurements"
  earlier_cycles: "cycle-7 dispositions (repair cycle 8), cycle-6 dispositions (repair cycle 7) and the cycle-7 follow-up: phase-02-review-log.md"

exit_criteria:
  note: >-
    Evidence pointers, not acceptance. "Exercised by" names the suites whose
    passing run in the gates above covers the group; the criteria text is in
    phase-02-exit-criteria.md.
  A_baseline: "exercised by verify:all (format, cold-cache reset, cold typecheck, all suites, contract compat, scans, publication, clean tree)"
  B_layering: "asep-suite:forbidden-imports, asep-suite:ts-guard, asep-suite:governed-execution"
  C_persistence: "asep-suite:persistence-tenancy, asep-suite:side-effect-log, asep-suite:crash-recovery; real PostgreSQL: asep-suite:pg-concurrency, asep-suite:crash-takeover-real"
  D_artifacts: "asep-suite:artifact-store, asep-suite:evidence-store; real MinIO: asep-suite:object-store-s3"
  E_workspace: "asep-suite:git-worktree; containment against the real daemon: asep-suite:agent-sandbox"
  F_runner_sandbox: "asep-suite:command-runner; real Docker: asep-suite:sandbox-exec. The governed path first refuses a handle that does not claim isolation; the runner then runs a command only for a handle a sandbox provider made, in the place that provider recorded for it, from its own frozen copy of the provider's flags. There is no waiver."
  G_claude_adapter: "asep-suite:agent-claude, asep-suite:agent-sandbox; live run not performed"
  H_forge: "asep-suite:github-app, asep-suite:forge-port-adapter; publication under takeover: asep-suite:resume-attempt, asep-suite:crash-recovery, asep-suite:crash-takeover-real"
  I_review_state: "asep-suite:governed-execution, asep-suite:vertical-integration, asep-suite:resume-attempt"
  J_observability: "asep-suite:observability-spans, asep-suite:observability-audit; spans on the real path: asep-suite:vertical-slice-real"
  K1_K3_K4: "asep-suite:vertical-slice-real (real PostgreSQL and Docker), asep-suite:gate-fail-closed, asep-suite:integration-gate"
  K2: NOT MET — no live task run
  K5: "NOT MET — verifier exercised by asep-suite:pilot-manifest, asep-suite:authority-resolver-sql, asep-suite:pilot-verifier; no pilot manifest exists"
  K6: NOT MET — pilot pending
  L1: "this report; sentinel written last (see head_binding)"
  L2: "every cycle-8 finding has a recorded disposition; independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - c2c0e12 docs(phase-2) add the cycle-8 independent re-review transcript with its provenance
  - e6ede74 fix(gate) start every Node test process with --no-wasm-code-gc (R26)
  - 0ab88f7 fix(sandbox) execute a private frozen copy of the provider's flags (CYCLE8-HIGH-001)
  - bc4cca5 test(sandbox) name every load-sensitive bound and size it from measurements
  - fdd3226 fix(persistence) bind command output references with checksum and kind (CYCLE8-HIGH-002)
  - 9089154 fix(pilot) check mandatory coverage from the pinned matrix and flags by exact profile (CYCLE8-HIGH-004)
  - aa946cf fix(forge) compare-and-set push, fact-derived PR content, takeover reconciliation (CYCLE8-HIGH-003)
  - d4be52e docs(phase-2) state the takeover guarantee, the fresh-database requirement and the cycle-8 dispositions
  - b7f1df1 docs(phase-2) shorten the controller log path in the cycle-8 transcript
commits_earlier_history: "`git log fc0df57..d1d9e7a`"

contract_changes_this_cycle:
  migrations:
    - "0019_command_output_references — command_executions.stdout_sha256 and stderr_sha256 (each both-or-neither with its _artifact_id), generated stdout_kind = 'command-stdout' and stderr_kind = 'command-stderr', composite FKs (…_artifact_id, organization_id, project_id, …_sha256, …_kind) → artifacts (id, organization_id, project_id, sha256, kind); new table artifact_reference_columns (table_name, reference_name, kind; primary key (table_name, reference_name)) listing all eight artifact references, which every later migration that adds or removes a reference must keep current; refuses to run over a command_executions row that names output"
    - "0017, 0018 and 0019 refuse rows that predate them: a database at this schema is created fresh"
  ports: >-
    ForgeProvider.pushBranch input is {repositoryBindingId, branch, commitSha,
    expectedRemoteSha: string | null} — expectedRemoteSha required (null: the
    branch must be absent), fencingEpoch removed. ForgeProvider.upsertPullRequest
    input loses fencingEpoch. PullRequestRef gains optional title and body
    (findPullRequest reports them). New: PullRequestFacts {taskId, attemptId,
    commitSha, evidenceId, base} and pullRequestContent(facts) → {title, body}.
    Removed: StaleFencingEpochError, withFencingMarker, fencingEpochOf.
    SideEffectLog.confirmOwner is unchanged and still returns fencingEpoch.
  adapters: >-
    @asep/git-worktree: new pushLeaseFor(branch, expectedRemoteSha);
    safeRefspecFor(branch) and safeCommitRefspecFor(commitSha, branch) lose
    their optional expectedRemoteSha; SafeRefspec.forceWithLeaseExpectedSha
    removed. @asep/github-app: PushInput.commitSha and expectedRemoteSha
    required; UpsertPrInput.fencingEpoch removed; PullRequestResult gains
    title? and body?; PullsApi.update takes base and list rows may carry title;
    the push argv always carries --force-with-lease=refs/heads/<branch>:<expected>.
    @asep/local-doubles: LocalBareForgeProvider pushes compare-and-set, writes
    title, body and base exactly, and reports title and body on lookup.
    @asep/command-runner: no API change (frozen copies).
  application: >-
    UpsertPrStepInput: taskId, commitSha and evidenceId added, title and body
    removed. PushStepInput.expectedRemoteSha removed. CompleteToReviewInput,
    ResumeAttemptInput: title and body removed. VerticalSliceWorkflowInput:
    prTitle and prBody removed. ResumeAttemptResult gains branchRepaired? and
    prRepaired?. New exports: reconcileBranchStep, reconcilePullRequestStep,
    pullRequestFactsOf, RemoteBranchDivergedError, and the types
    ReconcileRemoteInput, ReconcileBranchResult, ReconcilePullRequestResult.
  observability: "PRIVILEGED_ACTIONS gains 'forge.reconcile'"
  policy: "parseVerificationMatrix(text) exported; loadVerificationMatrix uses it"
  apps: "VerticalSliceInput.work loses prTitle and prBody; ResumeVerticalSliceInput loses prTitle and prBody"
  pilot_verifier: >-
    New pin ASEP_VERIFICATION_MATRIX_SHA256 (pinnedAgentConfig requires
    verificationMatrixSha256, 64 hex), required by createResolverFromEnv. New
    resolver method verificationPolicy(); createSqlAuthorityResolver requires
    opts.verificationPolicy whose matrixSha256 equals the pin. New exports
    VERIFICATION_MATRIX_SHA256_ENV, VERIFICATION_MATRIX_FILE,
    verificationPolicyConfig, loadVerificationPolicy (authority-resolver.mjs)
    and normalizeDockerFlags (verify-pilot-manifest.mjs).

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 9 is unreviewed (see verdict_note)."
  - "Publication under takeover is not fenced at the forge. A stale owner — one paused inside a forge call while its lease lapsed — may still reach the forge, and GitHub offers no compare-and-set for a PR update. The guarantee is content idempotence plus push compare-and-set plus reconciliation: its push can only land the attempt's own commit (any other is refused by the lease), its PR content is the same pure function of the attempt's facts, and the takeover reconciles branch and PR before the terminal state. A stale write that lands after that reconciliation is not repaired by that resume; a PR edited outside the harness is repaired only by a later resume."
  - "An attempt whose harness commit never landed is not resumed; it is re-executed as a new attempt (nothing left the harness). This includes a crash between commit-tree and the create-only attempt ref, which leaves an unreferenced object: not every Git-call boundary converges on the same attempt."
  - "Migrations 0017, 0018 and 0019 refuse data that predates them; they are not a compatible upgrade, and a database at this schema must be created fresh (no pilot data exists)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. Enforcement is the runner's own record: it runs a command only for a handle a sandbox provider made, where that provider put it, from its own frozen copy of the flags."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "The agent network needs Docker Engine 28.0.0 or later (isolated gateway mode). Verified on Docker Desktop 29.6.1 here; the CI runner's engine version is not verified."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1)."
  - "The pilot verifier rests on what the harness recorded — agent artifacts and the verification provenance record — and on the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin. The provenance record is not FK-bound to the evidence reservation."
  - "The pilot workflow plans L0 and L1 only, so an R1 task stops at verification for its missing L2: pilot tasks are R0."
  - "Test bounds that depend on host load are sized from measurements up to a load average of about 185 on 8 CPUs (bc4cca5); a heavier load can still exceed them."
  - "Fault 5 of the rehearsal pushes to a local bare remote; fault 1 is injected into the provider, not a full pipeline run."
  - "PGlite is a fast-test seam; the real-backend proofs run on PostgreSQL 17 in the integration gate."
  - "No Phase 3+ runtime (Temporal, distributed scheduling, second-model reviewer, Web Console, memory, auto-merge, deploy, K8s/gVisor, enterprise OIDC) by design."

pilot_prerequisites:
  - "PP1: a model credential in a mode-600 file (ASEP_ANTHROPIC_API_KEY_FILE), the digest-pinned agent and egress-proxy images, Docker Engine 28.0.0 or later, and `pnpm test:live:claude` LIVE passing with the pilot's configuration (runbook §0.1)."
  - "PP2: the GitHub App installed on the pilot repository with the default branch protected; its private key held by the operator."
  - "PP3: a durable ASEP_OBJECT_STORE_DIR shared by the pilot runs and the verifier, and the verifier run with the pilot's own Claude pins, verification image (ASEP_VERIFY_IMAGE_DIGEST) and verification matrix hash (ASEP_VERIFICATION_MATRIX_SHA256) (runbook §0.2)."
  - "PP4: ten genuine R0 tasks run end to end on a freshly created database, each with a signed human authorization; the manifest gated by scripts/pilot/verify-pilot-manifest.mjs."
```

## Summary

Phase 2 delivers the single-agent governed vertical slice on
`phase/02-single-agent-vertical-slice`, off `fc0df57`. A task flows from a
work order through risk admission (R0 automated, R1 human-review-gated, R2–R4
refused before any side effect, on a fresh run and on a resume), a leased Git
worktree, a Claude agent run in a container whose network gives it no host
address and whose only route out is a model-API egress proxy, sandboxed
verification whose every command runs where the sandbox provider put it, a
harness-owned commit, evidence fixed before the commit and bound to it, a
GitHub App that can push only an ASEP-namespaced branch and open a PR, and
lands in `WAITING_FOR_HUMAN_REVIEW`. External side effects are recorded under
leases with fencing epochs, and ownership is confirmed before each call, so a
successor can take over a crashed attempt and converge on one commit, one ref
and one PR. The forge itself is not fenced: an owner already inside a call may
still reach it after a takeover. What it can write there is bounded instead —
a compare-and-set push of the attempt's one commit and PR content that is a
pure function of the attempt's facts — and the takeover reconciles branch and
PR with those facts, on record, before the task reaches review.

## Where this stands

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED**. Two items
are open: the live pilot has not run (no credentials here), and repair cycle 9
has not been independently reviewed.

The last independent review, Codex re-review cycle 8 at `d1d9e7a`, did not
accept Phase 2. It accepted most earlier findings as resolved (listed in the
YAML above), found nine partial, and restated what remained as four new
findings: mutable execution flags, unprotected command-output references,
publication under takeover, and mandatory verification coverage. Repair cycle
9 addresses each as the controller decided (reconciliation R30), together with
the reviewer's surviving flag mutation, the 0018 upgrade wording and this
report's overclaims. The repairs are dispositioned, with their tests,
mutation checks and residual concerns, in `phase-02-review-log.md` ("Final
review cycle 8 dispositions"). They are the implementer's own work and
assessment; read them as claims to be checked.

What this cycle observed by machine: from a clean tree at `b7f1df1` (the implementation head plus two documentation commits), `pnpm install --frozen-lockfile` succeeded; `pnpm verify:all` passed all 14 steps, including 795 canonical tests across 58 files with 36 required suites, the contract, policy and compatibility gates, the fitness suites, the scans and the publication gate; and `pnpm test:integration` passed 34 tests across 7 files against real PostgreSQL, MinIO and Docker. The sentinel is written only after both gates pass again on the report commit.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, an independent review, or the CI runner's Docker
Engine version.

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
