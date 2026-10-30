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

  (2) The repairs of repair cycle 11 are unreviewed. Codex re-review cycle 10
  at 5dd2300 (phase-02-final-rereview-codex-v10.md) returned REQUEST_CHANGES
  @ 0.98 and did not accept Phase 2. It accepted (RESOLVED) CYCLE9-HIGH-002
  (both controller integration runs green at 5dd2300), CYCLE9-MED-002,
  CYCLE9-LOW-001, the resume-base mutation, the schema reference convention
  and R26, and the earlier RESOLVED findings stand. It found CYCLE9-HIGH-001,
  CYCLE9-MED-001, HIGH-006, MED-005, CYCLE7-HIGH-003, CYCLE8-HIGH-003 and the
  timeout work PARTIAL, and raised CYCLE10-HIGH-001, CYCLE10-HIGH-002,
  CYCLE10-MED-001, CYCLE10-MED-002 and CYCLE10-MED-003. Repair cycle 11
  applies the controller's decisions on that review (reconciliation R39),
  which also accept the declared limitations (2), (3) and (4) as Phase 2
  limits. Every repair, test and mutation check was produced and read by the
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
  last_reviewed_head: 5dd2300 (Codex re-review cycle 10, REQUEST_CHANGES)
  under_review: none
  implementation_head_sha: 6608d2136b84c04c152eac6572fb8162d0f284dc
  head_binding: >-
    implementation_head_sha is the last commit of repair cycle 11 that changes
    code or tests (`git rev-parse 6608d21`). The commits after it change
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
    21aeb0de16b814b61d6c3ac97f311ff9ca377fb6 (a documentation commit; it
    differs from implementation_head_sha in the review log only), from a clean
    tree
  install: "pnpm install --frozen-lockfile — exit 0"
  verify_all: "pnpm verify:all — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (36/36), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree"
  verify_all_earlier_run: "the first verify:all of this cycle, at 937d25e, failed one of 847 tests (the hung-kill timing test, 58 ms inside its timer: the moments were read from the wall clock); fixed in 6608d21. The first run at 21aeb0d then failed two agent tests (the egress proxy did not become ready within its timer) in a run in which the fake-docker tests of two suites ran up to 24 times slower than in every other run of this cycle (the test step took 833 s against 314 s at 937d25e); the agent suite alone and the rerun above passed; the cause of the slowdown is not established"
  canonical_tests: "849 tests, 849 pass, 0 fail, 0 skipped, across 58 test files; 36 required suite markers verified by scripts/run-canonical-tests.mjs"
  integration_gate: "pnpm test:integration — exit 0; 34 tests, 34 pass, 0 fail, 0 skipped, across 7 *.itest.ts files on digest-pinned PostgreSQL and MinIO and Docker 29.6.1 (backends published on 127.0.0.1 only); 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained; load average about 6–8"
  integration_gate_under_load: "not run in this cycle"
  integration_gate_at_reviewed_head: "the controller's gates at 5dd2300: verify:all 821/0/0; integration twice, 34/34 each, at load average about 29 and about 11 (as reported by the controller; the logs are in the controller's lane directory)"
  earlier_red_run: "the controller's run 1 at a447983 (load average about 30) was red: 33 of 34, the hung-agent test 80.8 s against its 60 s elapsed check; that duration includes the test's fixture setup and cleanup, and its split between fixture, setup, stop and teardown is not recorded and cannot be verified (phase-02-review-log.md, \"Final review cycle 9 dispositions\")"
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates and was not run in
    this cycle. Its CONFORMANCE test last ran at dec962b (cycle-7 follow-up)
    and passed; the agent network's creation and inspection changed after it
    (9d782c1). Its LIVE test (real model API) has never run here: no
    credential.
  mutation_checks: >-
    Run by the implementer for every cycle-10 finding with a code change and
    for this cycle's clock fix: 28 mutants, all killed (CYCLE10-HIGH-001 12,
    CYCLE10-HIGH-002 8, CYCLE10-MED-001 3 including the reviewer's state:
    'open', CYCLE10-MED-003 3, the clock fix 2); two HIGH-002 mutants were
    killed by a test's own timeout. Not mutation-checked: the runner's removal
    after a client error (no test seam) and the itest fixtures. Mutants per
    finding are in phase-02-review-log.md, "Final review cycle 10
    dispositions".

findings_cycle_10:
  note: >-
    Status after repair cycle 11, as assessed by the implementer; none is
    independently confirmed. Details, tests, mutation checks and residual
    concerns per finding: phase-02-review-log.md, "Final review cycle 10
    dispositions".
  accepted_by_review_at_cycle_10: [CYCLE9-HIGH-002, CYCLE9-MED-002, CYCLE9-LOW-001, RESUME-BASE-MUTATION, SCHEMA-REFERENCE-CONVENTION, R26]
  partial_at_cycle_10: "CYCLE9-HIGH-001, HIGH-006, CYCLE7-HIGH-003 and CYCLE8-HIGH-003 (by CYCLE10-HIGH-001), CYCLE9-MED-001 and the timeout work (by CYCLE10-HIGH-002), MED-005 (by CYCLE10-MED-001 and CYCLE10-MED-002)"
  repaired_unreviewed:
    CYCLE10-HIGH-001: "2cbf335 — completion and the resume read the PR back after its record and bind it to the record (number, url, head and base branch, state, merged, head commit); what is returned and persisted is that observation; another PR, a mismatch or a change ends FAILED / publication-incomplete with the found and recorded PR audited; reconcile writes only the recorded PR and creates none; the reviewer's two probes are tests"
    CYCLE10-HIGH-002: "3fbfb9b — agent-removed and removed are reported only once the daemon shows the container gone (docker inspect / docker ps -a), within AGENT_REMOVAL_BOUND_MS and COMMAND_REMOVAL_BOUND_MS; not shown in time fails the attempt or run; the 91 s slow-retry case is a red test; the runner itest bounds removal"
    CYCLE10-MED-001: "6ad22d3 — the update's key set is asserted; the fake GitHub applies state and base; a human closing, merging or retargeting between list and PATCH is a test; the residual read/write race is stated"
    CYCLE10-MED-002: "53f966f — the 72 s attribution is withdrawn; the split is not recorded and cannot be verified; the duration includes fixture setup and cleanup"
    CYCLE10-MED-003: "4159b19 — every network and container is named and labelled before it is asked for and swept whatever the create answers"
    limitations_2_3_4: "accepted as Phase 2 limits (R39)"
    MED-005: "this report and the L1 sentinel"

findings_cycle_9:
  note: >-
    Status after repair cycle 10, as assessed by the implementer then; the
    cycle-10 review's verdicts on them are above. Details:
    phase-02-review-log.md, "Final review cycle 9 dispositions".
  accepted_by_review_at_cycle_9: [HIGH-001, HIGH-002, HIGH-003, HIGH-004, HIGH-005, HIGH-007, HIGH-008, HIGH-009, MED-001, MED-002, MED-003, MED-004, MED-006, MED-NEW-001, MED-NEW-002, MED-NEW-003, MED-NEW-004, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST, CYCLE7-HIGH-001, CYCLE7-HIGH-002, CYCLE7-HIGH-004, CYCLE7-HIGH-005, CYCLE7-HIGH-006, CYCLE7-HIGH-007, CYCLE7-MED-001, CYCLE7-MED-002, CYCLE7-MED-003, CYCLE7-MED-004, CYCLE8-HIGH-001, CYCLE8-HIGH-002, CYCLE8-HIGH-004, CYCLE8-NET-ALIAS, R26]
  partial_at_cycle_9: "HIGH-006, CYCLE7-HIGH-003 and CYCLE8-HIGH-003 (by CYCLE9-HIGH-001), MED-005 (by CYCLE9-MED-002 and the red gate), the timeout work (by CYCLE9-HIGH-002 and CYCLE9-MED-001)"
  repaired_unreviewed:
    CYCLE9-HIGH-001: "a9da83f — the forge port reports PR state and merged; the upsert does not write a PR it reads closed, merged or on another base (cycle 11: a human acting between that read and the write is a residual race); a fresh run and a resume that meet one fail the task (publication-incomplete, audited with what was found) and record no PR row; the verifier rejects such a live PR and any non-OPEN row"
    resume_base: "a9da83f — resume fixtures on base release/2; the resume reads the base from the binding row instead of a caller default of main"
    CYCLE9-HIGH-002: "9fc9a30 — the hung-agent test asserts the interval from the deadline to the agent's removal against AGENT_STOP_BOUND_MS plus a 2 s allowance; the 80.8 s run's per-phase split is not recorded and cannot be verified (review log)"
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
  L2: "every cycle-10 finding has a recorded disposition; independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - 399a634 docs(phase-2) add the cycle-10 independent re-review transcript with its provenance
  - 2cbf335 fix(application) complete and persist exactly the PR read back and checked against the record (CYCLE10-HIGH-001)
  - 53f966f docs(phase-2) withdraw the 72 s attribution of the 80.8 s run (CYCLE10-MED-002)
  - 3fbfb9b fix(sandbox) report a container removed only once the daemon shows it gone, within a named bound (CYCLE10-HIGH-002)
  - 6ad22d3 fix(github-app) the PR update carries only the title and body; state the residual read/write race (CYCLE10-MED-001)
  - 4159b19 fix(sandbox) name and label before every docker create, and sweep whatever the create answers (CYCLE10-MED-003)
  - 937d25e docs(phase-2) record the cycle-10 dispositions
  - 6608d21 fix(sandbox) read every bounded moment from a monotonic clock (verify:all at 937d25e failed one timing test)
  - 21aeb0d docs(phase-2) record the gate failure of this cycle and its fix
  - this report
commits_earlier_history: "`git log fc0df57..5dd2300`"

contract_changes_this_cycle:
  migrations: "none"
  ports: "none (PullRequestRef already had an optional headSha)"
  adapters: >-
    @asep/command-runner: DockerCall takes an optional per-call
    { timeoutMs }; new removeContainerShownGone(docker, name, until, opts?),
    monotonicNow(), TeardownClock and COMMAND_REMOVAL_BOUND_MS; removeLabelledContainers
    takes until? and clock?; the runner's 'removed' moment now means shown
    gone. @asep/agent-claude: new AGENT_REMOVAL_BOUND_MS and
    agentRemovalDeadline({stoppedAt?, exitedAt}); AGENT_STOP_BOUND_MS is
    DOCKER_CALL_TIMEOUT_MS + AGENT_REMOVAL_BOUND_MS (60 000, unchanged);
    'agent-removed' now means shown gone. Both packages' lifecycle moments
    (AgentLifecycleEvent.at and deadline, CommandLifecycleEvent.at) are read
    from monotonicNow(): epoch milliseconds a wall-clock adjustment does not
    move, fractional. @asep/github-app: unchanged (the update already carried
    the title and body only; now asserted). The test fake docker emulates
    `inspect --type container`.
  application: >-
    New exports publicationGap(observed, recorded, facts),
    pullRequestRecorded(recorded) and the types RecordedPullRequest and
    ReconcilePullRequestInput (ReconcileRemoteInput plus a required recorded).
    reconcilePullRequestStep takes the record, no longer creates a missing
    PR, and returns pr: PullRequestRef | null (the last observation).
    pullRequestFound accepts null and adds headSha. CompleteToReviewResult
    gains recorded?, and its pr is the observation completion checked. The
    publication-incomplete audit detail gains recorded and found.headSha;
    found may be null.
  apps: "none (test doubles only)"

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 11 is unreviewed (see verdict_note)."
  - "Publication under takeover is not fenced at the forge. A stale owner — one paused inside a forge call while its lease lapsed — may still reach the forge, and GitHub offers no compare-and-set for a PR update. The push's compare-and-set conditions only on the branch's current value: expecting absence it accepts any SHA while the branch is absent, expecting the current value it accepts an update to any SHA. That only the attempt's commit lands comes from the harness, which always pushes the attempt's pinned commit; the compare-and-set makes a stale push of a different SHA fail once the branch exists. PR content is the same pure function of the attempt's facts. Before the terminal state the takeover puts the branch back on the attempt's commit and rewrites an open PR on the attempt's base; the harness never reopens or retargets a PR, and a PR read closed, merged, on another base or of unreported state is not written and fails the task on record. A human may close, merge or retarget the PR between the adapter's read and its title/body write, so that write can land on a PR that just closed (residual read/write race: GitHub has no compare-and-set for a PR update, R30); completion's read of the PR after its record then fails the task. A stale write that lands after that reconciliation is not repaired by that resume; an open PR edited outside the harness is repaired only by a later resume; a PR closed after its task reached review leaves the task there (the harness has no transition past review), and the verifier refuses it."
  - "Accepted as a Phase 2 limit (R39): the failure of a task on a publication gap is written from the persisted task status, which stays PENDING until the workflow writes a terminal state (the success path writes WAITING_FOR_HUMAN_REVIEW the same way); the domain's transition check is not applied to the persisted row, and PENDING → FAILED is not in the domain's table. The failure taxonomy has no publication class; the outcome is the audit detail."
  - "Accepted as a Phase 2 limit (R39): a PR closed after its task reached review leaves the task there; review is the harness's terminal state and the verifier refuses that PR."
  - "Completion binds the PR's head commit to the attempt's commit. GitHub may update a PR's head commit asynchronously after a push; a read that lands before it has caught up is a gap, and the task fails closed rather than completing."
  - "An attempt whose harness commit never landed is not resumed; it is re-executed as a new attempt (nothing left the harness). This includes a crash between commit-tree and the create-only attempt ref, which leaves an unreferenced object: not every Git-call boundary converges on the same attempt."
  - "Migrations 0017, 0018 and 0019 refuse data that predates them; they are not a compatible upgrade, and a database at this schema must be created fresh (no pilot data exists)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. Enforcement is the runner's own record: it runs a command only for a handle a sandbox provider made, where that provider put it, from its own frozen copy of the flags."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "The agent network needs Docker Engine 28.0.0 or later (isolated gateway mode). Verified on Docker Desktop 29.6.1 here; the CI runner's engine version is not verified."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1)."
  - "The pilot verifier rests on what the harness recorded — agent artifacts and the verification provenance record — and on the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin. The provenance record is not FK-bound to the evidence reservation."
  - "The pilot workflow plans L0 and L1 only, so an R1 task stops at verification for its missing L2: pilot tasks are R0."
  - "Test bounds that depend on host load are sized from measurements up to a load average of about 185 on 8 CPUs (bc4cca5); a heavier load can still exceed them. The stop-path assertions use the product's bounds plus a 2 s scheduling allowance (the stop came at most 4 ms late at load average up to 112); the hung-agent integration test needs its setup to finish inside its 45 s budget (measured up to 19.1 s at load average 60–106 with docker churn; not checked independently) — accepted as a test condition, not a product SLA (R39). A container not shown gone within its removal bound (one docker-call timeout after its client ended) fails the attempt or the run."
  - "The 80.8 s red run at a447983 is neither reproduced nor explained. Its log records only the test's duration, which includes the test's fixture setup and cleanup; how that time split between fixture, setup, stop and teardown is not recorded and cannot be verified. No reproduction here took more than 12.3 s from the deadline to the end of teardown."
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
before the task reaches review. Only the PR the attempt recorded, open,
unmerged, on the attempt's base and at the attempt's commit, completes:
completion reads it back after its record and persists exactly that read; a
PR a human closed, merged or retargeted, or another PR on the branch, is left
as found and the task fails, on record. A human acting between the adapter's
read and its title/body write can still receive that write (a residual
read/write race; GitHub has no compare-and-set for a PR update).

## Where this stands

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED**. Two items
are open: the live pilot has not run (no credentials here), and repair cycle 11
has not been independently reviewed.

The last independent review, Codex re-review cycle 10 at `5dd2300`, did not
accept Phase 2, with all three controller gate runs green at that head. It
raised five findings: completion checked one PR and returned another; the
removal bound measured a docker client's return, not the container's
absence; the documents promised a closed PR is never edited, and a
`state: 'open'` mutation survived; the 72 s attribution of the earlier red run
had no evidence; and an ambiguous network create skipped its cleanup. Repair
cycle 11 addresses each as the controller decided (reconciliation R39), which
also accepts three declared limitations as Phase 2 limits. The repairs are
dispositioned, with their tests, mutation checks and what was not checked, in
`phase-02-review-log.md` ("Final review cycle 10 dispositions"). They are the
implementer's own work and assessment; read them as claims to be checked.

What this cycle observed by machine: from a clean tree at `21aeb0d` (a documentation commit after the implementation head `6608d21`), `pnpm install --frozen-lockfile` succeeded; `pnpm verify:all` passed all 14 steps, including 849 canonical tests across 58 files with 36 required suites, the contract, policy and compatibility gates, the fitness suites, the scans and the publication gate; and `pnpm test:integration` passed 34 tests across 7 files against real PostgreSQL, MinIO and Docker. No run under synthetic load was made in this cycle. Two earlier `verify:all` runs of the cycle failed: one on a timing test that read the wall clock (fixed in `6608d21`), one in a run whose fake-docker tests ran up to 24 times slower than in every other run, for a reason not established (YAML, `verify_all_earlier_run`). The sentinel is written only after both gates pass again on the report commit.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, an independent review, or the CI runner's Docker
Engine version.

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
