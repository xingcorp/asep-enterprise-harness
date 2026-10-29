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

  (2) The repairs of repair cycle 10 are unreviewed. Codex re-review cycle 9 at
  a447983 (phase-02-final-rereview-codex-v9.md) returned REQUEST_CHANGES @ 0.99
  and did not accept Phase 2. It accepted (RESOLVED) HIGH-001..005, HIGH-007,
  HIGH-008, HIGH-009, MED-001..004, MED-006, MED-NEW-001..004,
  CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST, CYCLE7-HIGH-001, CYCLE7-HIGH-002,
  CYCLE7-HIGH-004..007, CYCLE7-MED-001..004, CYCLE8-HIGH-001, CYCLE8-HIGH-002,
  CYCLE8-HIGH-004, the --net alias and R26. It found HIGH-006, MED-005,
  CYCLE7-HIGH-003, CYCLE8-HIGH-003 and the timeout work PARTIAL, and raised
  CYCLE9-HIGH-001, CYCLE9-HIGH-002, CYCLE9-MED-001, CYCLE9-MED-002 and
  CYCLE9-LOW-001. The controller's integration run at a447983 under load was
  red (the hung-agent test, 80.8 s against a 60 s elapsed check). Repair
  cycle 10 applies the controller's decisions on that review (reconciliation
  R35). Every repair, test and mutation check was produced and read by the
  implementer alone. Under this project's trust ordering (machine evidence >
  independent review > implementer self-review) that is not acceptance
  evidence, which is what the _UNREVIEWED suffix records.

  Earlier revisions of this report claimed more than the code did: that every
  finding was closed (before cycle 6), that cycle 7 had repaired every PARTIAL
  or REGRESSED finding, that every authoritative reference was a scoped key
  before migration 0019, that the fencing epoch carried to the forge held a
  stale owner off it, that the push's lease refused any commit but the
  attempt's, and that the takeover's reconciliation made any PR the attempt's
  reviewable publication. The reviews showed each was wrong. This revision
  states the gate results observed in this cycle and the status of each
  finding, and nothing else as verified.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: base = `git merge-base main HEAD`.
  last_reviewed_head: a447983 (Codex re-review cycle 9, REQUEST_CHANGES)
  under_review: none
  implementation_head_sha: 1aabe5e2577225d6eff559c1576d8eb694109d9d
  head_binding: >-
    implementation_head_sha is the last commit of repair cycle 10 that changes
    code or tests (`git rev-parse 1aabe5e`). The commit after it changes
    documentation only. A commit cannot contain its own hash, so the true HEAD is bound
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
    1aabe5e2577225d6eff559c1576d8eb694109d9d (implementation_head_sha), from a
    clean tree
  install: "pnpm install --frozen-lockfile — exit 0"
  verify_all: "pnpm verify:all — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (36/36), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree"
  verify_all_earlier_run: "the first verify:all of this cycle, at f98a202, failed one test (a lifecycle test asserted the deadline equal to its first moment and was 1 ms off); fixed in 1aabe5e, then the run above"
  canonical_tests: "821 tests, 821 pass, 0 fail, 0 skipped, across 58 test files; 36 required suite markers verified by scripts/run-canonical-tests.mjs"
  integration_gate: "pnpm test:integration — exit 0; 34 tests, 34 pass, 0 fail, 0 skipped, across 7 *.itest.ts files on digest-pinned PostgreSQL and MinIO and Docker 29.6.1 (backends published on 127.0.0.1 only); 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained; load average about 6–10"
  integration_gate_under_load: "at bcbafc1, which differs from 1aabe5e only in one unit test and the review log, under synthetic load (24 host and 4 Docker-VM CPU burners, 2 container- and 2 network-churn loops; load average 28 rising to 112): exit 0, 34 of 34; the hung-agent test stopped 3 ms after its deadline and removed the agent 1.5 s after the stop"
  integration_gate_at_reviewed_head: "the controller's run 1 at a447983 (load average about 30) was red: 33 of 34, the hung-agent test 80.8 s against its 60 s elapsed check; where that time went is in phase-02-review-log.md, \"Final review cycle 9 dispositions\""
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates and was not run in
    this cycle. Its CONFORMANCE test last ran at dec962b (cycle-7 follow-up)
    and passed; the agent network's creation and inspection changed after it
    (9d782c1). Its LIVE test (real model API) has never run here: no
    credential.
  mutation_checks: >-
    Run by the implementer for every cycle-9 finding: 34 mutants, all killed
    (CYCLE9-HIGH-001 with the resume base 26, CYCLE9-HIGH-002 with
    CYCLE9-MED-001 8). Mutants per finding are in phase-02-review-log.md,
    "Final review cycle 9 dispositions".

findings_cycle_9:
  note: >-
    Status after repair cycle 10, as assessed by the implementer; none is
    independently confirmed. Details, tests, mutation checks and residual
    concerns per finding: phase-02-review-log.md, "Final review cycle 9
    dispositions".
  accepted_by_review_at_cycle_9: [HIGH-001, HIGH-002, HIGH-003, HIGH-004, HIGH-005, HIGH-007, HIGH-008, HIGH-009, MED-001, MED-002, MED-003, MED-004, MED-006, MED-NEW-001, MED-NEW-002, MED-NEW-003, MED-NEW-004, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST, CYCLE7-HIGH-001, CYCLE7-HIGH-002, CYCLE7-HIGH-004, CYCLE7-HIGH-005, CYCLE7-HIGH-006, CYCLE7-HIGH-007, CYCLE7-MED-001, CYCLE7-MED-002, CYCLE7-MED-003, CYCLE7-MED-004, CYCLE8-HIGH-001, CYCLE8-HIGH-002, CYCLE8-HIGH-004, CYCLE8-NET-ALIAS, R26]
  partial_at_cycle_9: "HIGH-006, CYCLE7-HIGH-003 and CYCLE8-HIGH-003 (by CYCLE9-HIGH-001), MED-005 (by CYCLE9-MED-002 and the red gate), the timeout work (by CYCLE9-HIGH-002 and CYCLE9-MED-001)"
  repaired_unreviewed:
    CYCLE9-HIGH-001: "a9da83f — the forge port reports PR state and merged; the upsert never reopens, retargets or edits a closed, merged or other-base PR; a fresh run and a resume that meet one fail the task (publication-incomplete, audited with what was found) and record no PR row; the verifier rejects such a live PR and any non-OPEN row"
    resume_base: "a9da83f — resume fixtures on base release/2; the resume reads the base from the binding row instead of a caller default of main"
    CYCLE9-HIGH-002: "9fc9a30 — the hung-agent test asserts the interval from the deadline to the agent's removal against AGENT_STOP_BOUND_MS plus a 2 s allowance; the 80.8 s run is explained as far as its log allows (review log)"
    CYCLE9-MED-001: "9fc9a30, 1aabe5e — wall-clock, cancellation, violation and killed-client tests assert the stop's reason, its time against when it was due, and removal against product bounds named from DOCKER_CALL_TIMEOUT_MS; no 5-minute allowances"
    CYCLE9-MED-002: "d45794c and this report — the lease conditions only on the branch's current value; only the attempt's commit lands because the harness always pushes the pinned commit; reconciliation claims match CYCLE9-HIGH-001"
    schema_reference_detection: "accepted limitation (R35); the convention is in the data model (bcbafc1)"
    R26_scope: "accepted (R35); note in scripts/lib/node-test-flags.mjs (bcbafc1)"
    CYCLE9-LOW-001: "f98a202"
    MED-005: "this report and the L1 sentinel"
  earlier_cycles: "cycle-8 dispositions (repair cycle 9), cycle-7 dispositions (repair cycle 8), cycle-6 dispositions (repair cycle 7) and the cycle-7 follow-up: phase-02-review-log.md"

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
  H_forge: "asep-suite:github-app, asep-suite:forge-port-adapter; publication under takeover and closed, merged or retargeted PRs: asep-suite:resume-attempt, asep-suite:crash-recovery, asep-suite:crash-takeover-real"
  I_review_state: "asep-suite:governed-execution, asep-suite:vertical-integration, asep-suite:resume-attempt"
  J_observability: "asep-suite:observability-spans, asep-suite:observability-audit; spans on the real path: asep-suite:vertical-slice-real"
  K1_K3_K4: "asep-suite:vertical-slice-real (real PostgreSQL and Docker), asep-suite:gate-fail-closed, asep-suite:integration-gate"
  K2: NOT MET — no live task run
  K5: "NOT MET — verifier exercised by asep-suite:pilot-manifest, asep-suite:authority-resolver-sql, asep-suite:pilot-verifier; no pilot manifest exists"
  K6: NOT MET — pilot pending
  L1: "this report; sentinel written last (see head_binding)"
  L2: "every cycle-9 finding has a recorded disposition; independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - 0554860 docs(phase-2) add the cycle-9 independent re-review transcript with its provenance
  - a9da83f fix(forge) a closed, merged or retargeted PR is never a completed publication (CYCLE9-HIGH-001)
  - 9fc9a30 fix(agent-claude) time the stop the product bounds, not the setup (CYCLE9-HIGH-002, CYCLE9-MED-001)
  - d45794c docs(phase-2) say what the push compare-and-set guarantees, and that only a reviewable PR completes (CYCLE9-MED-002)
  - bcbafc1 docs(phase-2) state the artifact reference convention and which test children need the wasm flag
  - f98a202 docs(phase-2) record the cycle-9 dispositions and drop the trailing blank line (CYCLE9-LOW-001)
  - 1aabe5e test(agent-claude) allow the first lifecycle moment to trail the deadline's start (CYCLE9-MED-001)
  - this report
commits_earlier_history: "`git log fc0df57..a447983`"

contract_changes_this_cycle:
  migrations: "none"
  ports: >-
    PullRequestRef gains optional state ('open' | 'closed') and merged, as the
    forge reports them. ForgeProvider.upsertPullRequest: opens the PR on the
    given base, or updates the title and body of the open PR on that base; a
    PR for the head that is closed, merged or on another base is returned as
    found, never reopened, retargeted, edited or duplicated.
    findPullRequest returns the PR open, closed or merged, with its state.
  adapters: >-
    @asep/github-app: PullsApiPr (number, html_url, head {ref, sha?}, base,
    title?, body?, state?, merged?, merged_at?) is the row type of
    PullsApi.list/create/update; PullsApi.update no longer takes base;
    PullRequestResult gains state? and merged?; the open PR for a head wins
    over an older closed one; the port passes state and merged through.
    @asep/local-doubles: LocalPullRequest gains state and merged; new
    closePullRequest(headBranch, {merged}) and
    retargetPullRequest(headBranch, base); the upsert follows the port.
    @asep/command-runner: new DOCKER_CALL_TIMEOUT_MS (30 000, the
    dockerCaller default) and COMMAND_STOP_BOUND_MS; TrustedCommandRunner
    takes an optional fourth argument observeLifecycle(CommandLifecycleEvent)
    (phases spawned, stop, killed, exited, removed); a second stop request is
    ignored. @asep/agent-claude: ClaudeProviderConfig.observeLifecycle?
    (AgentLifecycleEvent: started, network-ready, proxy-ready,
    agent-started, stop, agent-killed, agent-exited, agent-removed,
    torn-down); new AGENT_STOP_BOUND_MS; every provider docker call is bounded
    by DOCKER_CALL_TIMEOUT_MS (was 60 s).
  application: >-
    New exports pullRequestGap(pr, facts) and pullRequestFound(pr).
    ReconcilePullRequestResult gains gap? and the base is no longer repaired.
    CompleteToReviewResult gains reason? and gap?. ResumeStop gains
    'publication-incomplete'. ResumeAttemptInput loses base;
    ResumeAttemptRepositories gains bindings (new ResumeBindingPort:
    getScoped(scope, id) → {defaultBaseBranch}). On a publication gap the
    fresh workflow and the resume write the task FAILED with a
    task.status.transition audit entry (outcome publication-incomplete) and no
    PR row.
  apps: "ResumeVerticalSliceInput loses base; resumeVerticalSlice passes RepositoryBindingRepository as the bindings port"
  pilot_verifier: >-
    resolvePullRequest returns baseBranch and state; resolveLivePullRequest
    returns baseBranch, state and merged. The verifier rejects a PR row whose
    state is not OPEN, and a live PR that is merged, closed, of unreported
    state or merged flag, or on another base than the row's.

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 10 is unreviewed (see verdict_note)."
  - "Publication under takeover is not fenced at the forge. A stale owner — one paused inside a forge call while its lease lapsed — may still reach the forge, and GitHub offers no compare-and-set for a PR update. The push's compare-and-set conditions only on the branch's current value: expecting absence it accepts any SHA while the branch is absent, expecting the current value it accepts an update to any SHA. That only the attempt's commit lands comes from the harness, which always pushes the attempt's pinned commit; the compare-and-set makes a stale push of a different SHA fail once the branch exists. PR content is the same pure function of the attempt's facts. Before the terminal state the takeover puts the branch back on the attempt's commit and rewrites an open PR on the attempt's base; a PR that is closed, merged, on another base or of unreported state is never reopened, retargeted or edited, and the task fails on record instead. A stale write that lands after that reconciliation is not repaired by that resume; an open PR edited outside the harness is repaired only by a later resume; a PR closed after its task reached review leaves the task there (the harness has no transition past review), and the verifier refuses it."
  - "The failure of a task on a publication gap is written from the persisted task status, which stays PENDING until the workflow writes a terminal state (the success path writes WAITING_FOR_HUMAN_REVIEW the same way); the domain's transition check is not applied to the persisted row. The failure taxonomy has no publication class; the outcome is the audit detail."
  - "An attempt whose harness commit never landed is not resumed; it is re-executed as a new attempt (nothing left the harness). This includes a crash between commit-tree and the create-only attempt ref, which leaves an unreferenced object: not every Git-call boundary converges on the same attempt."
  - "Migrations 0017, 0018 and 0019 refuse data that predates them; they are not a compatible upgrade, and a database at this schema must be created fresh (no pilot data exists)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. Enforcement is the runner's own record: it runs a command only for a handle a sandbox provider made, where that provider put it, from its own frozen copy of the flags."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "The agent network needs Docker Engine 28.0.0 or later (isolated gateway mode). Verified on Docker Desktop 29.6.1 here; the CI runner's engine version is not verified."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1)."
  - "The pilot verifier rests on what the harness recorded — agent artifacts and the verification provenance record — and on the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin. The provenance record is not FK-bound to the evidence reservation."
  - "The pilot workflow plans L0 and L1 only, so an R1 task stops at verification for its missing L2: pilot tasks are R0."
  - "Test bounds that depend on host load are sized from measurements up to a load average of about 185 on 8 CPUs (bc4cca5); a heavier load can still exceed them. The stop-path assertions use the product's bounds plus a 2 s scheduling allowance (the stop came at most 4 ms late at load average up to 112); the hung-agent integration test needs its setup to finish inside its 45 s budget (measured up to 19.1 s at load average 60–106 with docker churn)."
  - "The 80.8 s red run at a447983 was not reproduced: its log has no per-phase timing, and no reproduction here came near 72 s between the deadline and the end of teardown (at most 12.3 s). Its explanation (a docker call running towards its client timeout) is an inference."
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
still reach it after a takeover. What it can write there is bounded instead:
the harness only ever pushes the attempt's pinned commit, under a
compare-and-set that refuses a stale push of another SHA once the branch
exists, and PR content is a pure function of the attempt's facts. The
takeover reconciles the branch and an open PR with those facts, on record,
before the task reaches review. Only an open, unmerged PR on the attempt's
base completes: a PR a human closed, merged or retargeted is left as found and
the task fails, on record.

## Where this stands

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED**. Two items
are open: the live pilot has not run (no credentials here), and repair cycle 10
has not been independently reviewed.

The last independent review, Codex re-review cycle 9 at `a447983`, did not
accept Phase 2. It accepted every cycle-8 probe as refused and most findings as
resolved (listed in the YAML above), and raised five: a PR a human closed or
merged was completed to review and recorded `OPEN`; the integration gate was
red at that head under load; the timing assertions no longer proved a prompt
stop; the documents credited the push compare-and-set with what harness
pinning provides; and a blank line at the end of the review log. Repair cycle
10 addresses each as the controller decided (reconciliation R35), together
with the resume's base, the reference convention and the wasm-flag scope. The
repairs are dispositioned, with their tests, mutation checks, residual
concerns and an account of the red run, in `phase-02-review-log.md` ("Final
review cycle 9 dispositions"). They are the implementer's own work and
assessment; read them as claims to be checked.

What this cycle observed by machine: from a clean tree at `1aabe5e` (the implementation head), `pnpm install --frozen-lockfile` succeeded; `pnpm verify:all` passed all 14 steps, including 821 canonical tests across 58 files with 36 required suites, the contract, policy and compatibility gates, the fitness suites, the scans and the publication gate; and `pnpm test:integration` passed 34 tests across 7 files against real PostgreSQL, MinIO and Docker — and also under synthetic load (load average up to 112) at `bcbafc1`, which differs only in one unit test and the review log. The sentinel is written only after both gates pass again on the report commit.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, an independent review, or the CI runner's Docker
Engine version.

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
