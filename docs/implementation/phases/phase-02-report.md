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

  (2) The repairs of repair cycle 13 are unreviewed, and one finding is not
  closed. Codex re-review cycle 12 at d9255fb
  (phase-02-final-rereview-codex-v12.md) returned REQUEST_CHANGES @ 0.99 and
  did not accept Phase 2. It accepted (RESOLVED) CYCLE11-HIGH-001,
  CYCLE11-MED-001, concern 2, CYCLE10-HIGH-001, HIGH-006, MED-005,
  CYCLE7-HIGH-003, CYCLE8-HIGH-003 and the monotonic waits, and the earlier
  RESOLVED findings stand. It found CYCLE11-HIGH-002, the timeout work and
  CYCLE10-HIGH-002 PARTIAL, and raised CYCLE12-HIGH-001 (the egress proxy kept
  the model credential usable with no bound once its starter was gone),
  CYCLE12-MED-001 (test fixtures could leave processes behind and delete the
  records that find them) and CYCLE12-MED-002 (absence that arrived after the
  removal deadline was taken as proof); one mutant of the docker caller's cut
  survived. Repair cycle 13 applies the controller's decisions on that review
  (reconciliation R47). CYCLE11-HIGH-002 is not closed. The stall is in
  launching Node on this host (measured: a new Node process waited up to
  40.7 s while /bin/sh launched in at most 173 ms); that the host's
  launch-policy check holds those launches is a strong hypothesis, not
  proven; what makes the bursts of Node launches is unknown and may include
  this repository's own tests and concurrent lanes. Under R47 a gate run is
  acceptance evidence only if its Node-launch sampler shows no launch of 10 s
  or more, and acceptance needs two consecutive valid green runs of each gate
  at the final head; a host-policy exemption is the user's choice and is not
  assumed. Every repair, test, measurement and mutation check was produced and
  read by the implementer alone. Under this project's trust ordering (machine
  evidence > independent review > implementer self-review) that is not
  acceptance evidence, which is what the _UNREVIEWED suffix records.

  Earlier revisions of this report claimed more than the code did: that every
  finding was closed (before cycle 6), that cycle 7 had repaired every PARTIAL
  or REGRESSED finding, that every authoritative reference was a scoped key
  before migration 0019, that the fencing epoch carried to the forge held a
  stale owner off it, that the push's lease refused any commit but the
  attempt's, that the takeover's reconciliation made any PR the attempt's
  reviewable publication, that reconcile wrote only the recorded PR
  (cycle 11; its write went through the branch-keyed upsert), and that the
  cause of CYCLE11-HIGH-002 had been found on the host (cycle 12; it is a
  strong hypothesis, not proven). The reviews showed each was wrong. This revision states the gate results observed in
  this cycle and the status of each finding, and nothing else as verified.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: base = `git merge-base main HEAD`.
  last_reviewed_head: d9255fb (Codex re-review cycle 12, REQUEST_CHANGES)
  under_review: none
  implementation_head_sha: b95cb8267ad5621f7ec769c2ae236a7d8488422c
  head_binding: >-
    implementation_head_sha is the last commit of repair cycle 13 that changes
    code or tests (`git rev-parse b95cb82`). The commits after it change
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
    b95cb8267ad5621f7ec769c2ae236a7d8488422c (implementation_head_sha), from a
    clean tree; every gate through the controller's gate.sh, which holds the
    host's gate lock and samples Node launches beside the run
  install: "not run at b95cb82; pnpm install --frozen-lockfile opens the final gate sequence on the report commit"
  verify_all: "pnpm verify:all through gate.sh — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (36/36), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree; 427 s; sampler: 186 samples, longest Node launch 3101 ms, none of 10 s or more (valid under R47)"
  every_commit: "verify:all through gate.sh at each commit before the next, every run passed and valid under R47 (no Node launch of 10 s or more; longest 1.4–3.2 s): 158608f 869, e58c588 870, 87c231c 870, 0d95b1f 873, 2d974cb 884, e47b2cb 884, b95cb82 885 tests. No red run in this cycle"
  canonical_tests: "885 tests, 885 pass, 0 fail, 0 skipped, across 60 test files; 36 required suite markers verified by scripts/run-canonical-tests.mjs; its process registry found no recorded process still running from earlier runs or from this run, and no record left"
  integration_gate: "pnpm test:integration through gate.sh — exit 0; 34 tests, 34 pass, 0 fail, 0 skipped, across 7 *.itest.ts files on digest-pinned PostgreSQL and MinIO and Docker 29.6.1 (backends published on 127.0.0.1 only); 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained; 113 s; sampler: 50 samples, longest Node launch 988 ms (valid under R47)"
  gate_validity: "R47: a gate run is acceptance evidence only if its Node-launch sampler shows no launch of 10 s or more; a red run with such a stall is a host stall, neither pass nor fix; a red run without one is a real failure needing a root cause; acceptance needs two consecutive valid green runs of each gate at the final head (the final sequence on the report commit, bound by the sentinel)"
  synthetic_load: "not run in this cycle (cycle 12's runs, which do not exercise the stall: 0 failures in 20 runs before its changes, 0 in 10 after; phase-02-review-log.md, \"Final review cycle 11 dispositions\")"
  integration_gate_under_load: "not run in this cycle"
  integration_gate_at_reviewed_head: "the controller's gates at d9255fb, on a clean detached worktree with no lane running and a Node-launch sampler: verify:all twice, exit 0, 869 pass, 0 fail each; integration twice, 34 of 34 each; no leftover container or network; node -e 0 launch median 60 ms, at most 2.87 s over 452 samples (logs in the controller's lane directory)"
  earlier_red_runs: "verify:all at 7017cfc, twice (two tests each: the sandbox's first docker call, the tests' Node-based fake client, started at once and was killed at its 30 s bound; a probe beside the second run measured Node launches held 4.6–40.7 s while /bin/sh and /usr/bin/true launched in at most 173 ms — what holds them is a strong hypothesis, the host's launch-policy check, not proven); the controller's run 2 at 42b6d78 (fits the same stall; its window is no longer in the host's kernel log, so it cannot be checked; its canonical test step took 422 s against 351 s in run 1); the first run of repair cycle 11 at 21aeb0d (two agent tests: the egress proxy, a Node process, did not become ready within its timer; the same class, not checkable now); the controller's run 1 at a447983 (the hung-agent test 80.8 s against its 60 s check; not explained)"
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates and was not run in
    this cycle. Its CONFORMANCE test last ran at dec962b (cycle-7 follow-up)
    and passed; the agent network's creation and inspection (9d782c1) and the
    egress proxy's lifetime (0d95b1f) changed after it. Its LIVE test (real
    model API) has never run here: no credential.
  mutation_checks: >-
    Run by the implementer for every cycle-12 finding with a code or test
    change: 39 mutants, all killed (CYCLE12-MED-002 3; the cut and the
    instrumentation 6, the reviewer's cutMs + 1_000 among them;
    CYCLE12-HIGH-001 11; CYCLE12-MED-001 17; the real-Octokit probe 2). Two
    more, run against a first draft of the proxy's stop, have no code left to
    mutate: one was killed, the other survived on a branch that cannot be
    reached, and the draft was simplified. One run of a CYCLE12-MED-001 mutant
    hung in the Node test runner's parent and was killed; rerun twice, the
    mutant was killed. Not mutation-checked: the threat model and runbook
    text, and the manual container stdin probe. Mutants per finding are in
    phase-02-review-log.md, "Final review cycle 12 dispositions".

findings_cycle_12:
  note: >-
    Status after repair cycle 13, as assessed by the implementer; none is
    independently confirmed. Details, tests, mutation checks and residual
    concerns per finding: phase-02-review-log.md, "Final review cycle 12
    dispositions".
  accepted_by_review_at_cycle_12: [CYCLE11-HIGH-001, CYCLE11-MED-001, CONCERN-2, CYCLE10-HIGH-001, HIGH-006, MED-005, CYCLE7-HIGH-003, CYCLE8-HIGH-003, MONOTONIC-WAITS]
  partial_at_cycle_12: "CYCLE11-HIGH-002 (the stall measured; what makes the bursts, and a fix, not verified), the timeout work, and CYCLE10-HIGH-002 (by the late absence of CYCLE12-MED-002)"
  repaired_unreviewed:
    CYCLE12-HIGH-001: "0d95b1f — the egress proxy is started with an absolute expiry (the attempt's deadline plus PROXY_EXPIRY_GRACE_MS, 30 s), refuses to start without a future one, refuses every request from its expiry on (also with the clock set back) and exits at it by its own timer; the provider keeps its stdin open after the credential, and when that link closes the proxy exits at once (PROXY_EXIT_BOUND_MS, 2 s). Tests: virtual-time refusal at the expiry; a real proxy whose starter is SIGKILLed exits within the bound; a real proxy exits at its expiry, not before; refusals to start; the provider's argv and open stdin. Threat model T2-16: after worker death the credential is usable through a leftover proxy until its expiry at most; the runbook sweep stays the backstop for the containers"
    CYCLE12-MED-001: "2d974cb, e47b2cb — the fake docker takes a container's record only once its process group is shown gone; every fake docker fixture is removed through removeFakeDockerFixture, which ends what is still recorded first; the test proxy helper records its proxy and kills it when it is not ready in time; a run-scoped process registry outside the test processes lets the canonical runner end what earlier runs left before the tests and what this run left after them, reporting both and failing a run that leaves a process it cannot end"
    controller_orphans: "the 33 processes listed in controller-orphans-20261030-1715.txt (31 egress proxies, 2 fake docker clients, all of this worktree) were sent SIGTERM and all exited, with their start times and command lines checked before and their absence after; two unlisted proxies of this worktree (pids 4822 and 89091, the previous asset) were left running, as the kill was limited to the list"
    CYCLE12-MED-002: "e58c588 — both removal helpers, the agent's and the runner's, refuse absence that arrives after their deadline and say how late it came; the reviewer's CYCLE12_LATE_ABSENCE is a test for both"
    cut_mutant: "87c231c — the docker caller's cut is bounded from above (TIMER_LATENESS_MS, KILL_TO_CLOSE_MS); the reviewer's cutMs + 1_000 mutant is killed"
    instrumentation: "87c231c — every DockerCallRecord carries its client's pid; the runner's teardown error names its client's pid; a failed kill of the egress proxy or of the agent at its stop is kept in the teardown notes; the tool-budget test and twelve other status assertions print the observation when they fail"
    real_octokit_probe: "b95cb82 — the reviewer's CYCLE12_REAL_OCTOKIT_PATCH is a test through the real @octokit/rest client with its fetch replaced: one PATCH of the PR's title and body, nothing else"
    CYCLE11-HIGH-002: "NOT CLOSED; disposition R47 recorded in the review log. The stall is in launching Node on this host (measured); the host's launch-policy check holding the launches is a strong hypothesis, not proven; what makes the bursts is unknown and may include this repository's own tests and concurrent lanes. Every gate of this cycle ran through gate.sh and was valid under R47"

findings_cycle_11:
  note: >-
    Status after repair cycle 12, as assessed by the implementer then; the
    cycle-12 review's verdicts on them are above. Details:
    phase-02-review-log.md, "Final review cycle 11 dispositions".
  accepted_by_review_at_cycle_11: [CYCLE10-HIGH-002, CYCLE10-MED-001, CYCLE10-MED-002, CYCLE10-MED-003, STATE-OPEN-MUTATION, CYCLE9-HIGH-001, CYCLE9-MED-001]
  partial_at_cycle_11: "CYCLE10-HIGH-001, HIGH-006, CYCLE7-HIGH-003 and CYCLE8-HIGH-003 (by CYCLE11-HIGH-001), MED-005 and the timeout work (by CYCLE11-HIGH-002 and the red gate run)"
  repaired_unreviewed:
    CYCLE11-HIGH-001: "fab5760 — the forge port's updatePullRequestContent writes the title and body of one PR by its number, with no list, no selection and no create; reconcile repairs the recorded PR through it and reads it back; the close-#1-open-#2 interleaving and a PR no longer listed between reconcile's check and the write are tests at the step and through the GitHub adapter and port (FAILED / publication-incomplete, #2 untouched, the write log never names #2, nothing created); the residual is R30's race on the recorded PR"
    CYCLE11-HIGH-002: "NOT CLOSED; the stall located in Node launch on the host (wording corrected in repair cycle 13, R47) — a375f1e: every docker call reports the signal that ended its client, its duration, its bound and whether its caller cut it; every failed removal reports its calls; the runner's teardown error adds the command client's end; the agent's setup calls and the proxy wait say how they ended. bd08654: the docker probe, the one unbounded docker call, is bounded and gets only the client environment. Synthetic CPU and fsync load did not reproduce the stall (0 of 20 runs before, 0 of 10 after). Two verify:all runs at 7017cfc did, and with the timeline and a probe they locate the stall: during bursts of Node launches on the host (about 16,000–18,000 in 20–50 s) a new Node process waited up to 40.7 s, so a docker call through the tests' Node-based fake client exceeded its 30 s bound. That the host's launch-policy check (AppleSystemPolicy notifying syspolicyd) holds the launches, one at a time, is a strong hypothesis, not proven; what makes the bursts is unknown. If the hypothesis holds, the fix is on the host (launch the gates from a process the policy does not assess, untested; or keep such bursts off the host during a gate); otherwise or also, a redesign of the fake docker client; neither made. No bound raised; fault 3 keeps its assertion"
    CYCLE11-MED-001: "056457a — an inspect (agent) or ps (runner) failing with permission denied, no daemon, or an unrelated error fails the attempt or run with no removal marker; the reviewer's /./ mutant is killed"
    concern_2: "056457a — the runner takes a SpawnClient; the reviewer's client-error-after-spawn probe is a test"
    concern_3: "accepted as a Phase 2 limit (R43); runbook §1 and §3.4"
    test_polling_bounds: "a8f45ca — the four named waits and two lease waits of crash-takeover.itest.ts read monotonicNow()"
    loosened_assertion_6608d21: "named in the review log with its reason and the virtual-time tests that bound each step"
    MED-005: "fab5760 (data model, threat model, runbook), the review log and this report"

findings_cycle_10:
  note: >-
    Status after repair cycle 11, as assessed by the implementer then; the
    cycle-11 review's verdicts on them are above. Details:
    phase-02-review-log.md, "Final review cycle 10 dispositions".
  accepted_by_review_at_cycle_10: [CYCLE9-HIGH-002, CYCLE9-MED-002, CYCLE9-LOW-001, RESUME-BASE-MUTATION, SCHEMA-REFERENCE-CONVENTION, R26]
  partial_at_cycle_10: "CYCLE9-HIGH-001, HIGH-006, CYCLE7-HIGH-003 and CYCLE8-HIGH-003 (by CYCLE10-HIGH-001), CYCLE9-MED-001 and the timeout work (by CYCLE10-HIGH-002), MED-005 (by CYCLE10-MED-001 and CYCLE10-MED-002)"
  repaired_unreviewed:
    CYCLE10-HIGH-001: "2cbf335 — completion and the resume read the PR back after its record and bind it to the record (number, url, head and base branch, state, merged, head commit); what is returned and persisted is that observation; another PR, a mismatch or a change ends FAILED / publication-incomplete with the found and recorded PR audited; the reviewer's two probes are tests. This entry first also said reconcile wrote only the recorded PR and created none: its write went through the branch-keyed upsert, which could write another PR or create one (CYCLE11-HIGH-001, fixed in fab5760)"
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
  L2: "every cycle-12 finding has a recorded disposition; CYCLE11-HIGH-002 is not closed (the stall is in Node launch on this host; its cause a strong hypothesis, not proven; disposition R47); independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - 158608f docs(phase-2) add the cycle-12 independent review transcript
  - e58c588 fix(sandbox) absence that arrives after the removal deadline is refused (CYCLE12-MED-002)
  - 87c231c test(sandbox) bound the cut from above; docker calls carry the client pid; kill results are kept
  - 0d95b1f fix(agent) the egress proxy has a lifetime of its own (CYCLE12-HIGH-001)
  - 2d974cb test(harness) test processes are recorded outside the test worker and ended before their records go (CYCLE12-MED-001)
  - e47b2cb test(harness) fixture removal forgets what it ended; the runner counts what it found running (CYCLE12-MED-001)
  - b95cb82 test(forge) the reviewer's real-Octokit probe is a test
  - this report and the cycle-12 dispositions
commits_earlier_history: "`git log fc0df57..d9255fb`"

contract_changes_this_cycle:
  migrations: "none"
  ports: >-
    None in this cycle. Lanes A and B adopt the cycle-11 port delta
    (ForgeProvider.updatePullRequestContent, a fifth, required method) at
    their rebase after G-P2, and no adapter may implement
    updatePullRequestContent through a branch-keyed upsert (R47).
  adapters: >-
    @asep/agent-claude: buildProxyRunArgs takes a required expiresAt (epoch
    milliseconds); assets/egress-proxy.mjs requires --expires-at, keeps reading
    stdin after the credential line as its link to its starter, and exports
    egressProxy; new exports PROXY_EXPIRY_GRACE_MS and PROXY_EXIT_BOUND_MS;
    the teardown notes may name a failed kill of the proxy or of the agent at
    its stop. @asep/command-runner: DockerCallRecord gains pid?, which
    describeDockerCall names; the runner's teardown error names its client's
    pid; both removal helpers refuse absence that arrives after their
    deadline, with how late it came.
  application: "none"
  apps: "none (test fixtures only)"
  test_tooling: >-
    scripts/lib/process-registry.mjs and scripts/testing/fake-docker-fixture.mjs
    are new; the canonical runner sets ASEP_PROCESS_REGISTRY for its tests,
    ends what earlier and current runs left, and reports it; the fake docker
    records carry group and marker, keep a container's record until its
    process group is shown gone, and log a container's stdin per chunk.

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 13 is unreviewed, and CYCLE11-HIGH-002 is not closed (see verdict_note)."
  - "Publication under takeover is not fenced at the forge. A stale owner — one paused inside a forge call while its lease lapsed — may still reach the forge, and GitHub offers no compare-and-set for a PR update. The push's compare-and-set conditions only on the branch's current value: expecting absence it accepts any SHA while the branch is absent, expecting the current value it accepts an update to any SHA. That only the attempt's commit lands comes from the harness, which always pushes the attempt's pinned commit; the compare-and-set makes a stale push of a different SHA fail once the branch exists. PR content is the same pure function of the attempt's facts. Before the terminal state the takeover puts the branch back on the attempt's commit and rewrites the title and body of the attempt's recorded PR, named by its number, when it reads that PR open on the attempt's base; the repair lists, selects and creates no PR, the harness never reopens or retargets a PR, and a PR read closed, merged, on another base or of unreported state is not written and fails the task on record. A human may close, merge or retarget a PR between the harness's read of it and its title/body write (the recorded PR in that repair, the branch's PR in a fresh run's upsert), so that write can land on a PR that just closed (residual read/write race: GitHub has no compare-and-set for a PR update, R30); the read of the PR that follows then fails the task. A stale write that lands after that reconciliation is not repaired by that resume; an open PR edited outside the harness is repaired only by a later resume; a PR closed after its task reached review leaves the task there (the harness has no transition past review), and the verifier refuses it."
  - "Accepted as a Phase 2 limit (R39): the failure of a task on a publication gap is written from the persisted task status, which stays PENDING until the workflow writes a terminal state (the success path writes WAITING_FOR_HUMAN_REVIEW the same way); the domain's transition check is not applied to the persisted row, and PENDING → FAILED is not in the domain's table. The failure taxonomy has no publication class; the outcome is the audit detail."
  - "Accepted as a Phase 2 limit (R39): a PR closed after its task reached review leaves the task there; review is the harness's terminal state and the verifier refuses that PR."
  - "Accepted as a Phase 2 limit (R43): completion binds the PR's head commit to the attempt's commit. GitHub may update a PR's head commit asynchronously after a push; a read that lands before it has caught up is a gap, and the task fails closed rather than completing. The symptom and the recovery (a new task) are in runbook §3.4; the pilot records each occurrence (runbook §1), which measures how often it happens."
  - "An attempt whose harness commit never landed is not resumed; it is re-executed as a new attempt (nothing left the harness). This includes a crash between commit-tree and the create-only attempt ref, which leaves an unreferenced object: not every Git-call boundary converges on the same attempt."
  - "Migrations 0017, 0018 and 0019 refuse data that predates them; they are not a compatible upgrade, and a database at this schema must be created fresh (no pilot data exists)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. Enforcement is the runner's own record: it runs a command only for a handle a sandbox provider made, where that provider put it, from its own frozen copy of the flags."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "The agent network needs Docker Engine 28.0.0 or later (isolated gateway mode). Verified on Docker Desktop 29.6.1 here; the CI runner's engine version is not verified."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1). The egress proxy among them ends itself at its expiry, the attempt's deadline plus 30 s, at the latest, or when its stdin link closes; until then the agent can still reach the model API through it with the credential (threat model T2-16)."
  - "The pilot verifier rests on what the harness recorded — agent artifacts and the verification provenance record — and on the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin. The provenance record is not FK-bound to the evidence reservation."
  - "The pilot workflow plans L0 and L1 only, so an R1 task stops at verification for its missing L2: pilot tasks are R0."
  - "Test bounds that depend on host load are sized from measurements up to a load average of about 185 on 8 CPUs (bc4cca5); a heavier load can still exceed them. The stop-path assertions use the product's bounds plus a 2 s scheduling allowance (the stop came at most 4 ms late at load average up to 112); the hung-agent integration test needs its setup to finish inside its 45 s budget (measured up to 19.1 s at load average 60–106 with docker churn; not checked independently) — accepted as a test condition, not a product SLA (R39). A container not shown gone within its removal bound (one docker-call timeout after its client ended) fails the attempt or the run."
  - "The 80.8 s red run at a447983 is neither reproduced nor explained. Its log records only the test's duration, which includes the test's fixture setup and cleanup; how that time split between fixture, setup, stop and teardown is not recorded and cannot be verified. No reproduction here took more than 12.3 s from the deadline to the end of teardown."
  - "The gates are not reliable on this host (CYCLE11-HIGH-002). During bursts of Node launches on the host a new Node process waited up to 40.7 s (measured in cycle 12); that the host's launch-policy check (AppleSystemPolicy notifying syspolicyd) holds them is a strong hypothesis, not proven, and what makes the bursts is unknown. The unit tests' fake docker client is one Node launch per docker call, so a call in such a window exceeds its 30 s bound and the test fails: 2 of the 8 canonical test runs of cycle 12 after the instrumentation landed failed so; none of the 8 gate runs of cycle 13 had a Node launch of 10 s or more. Every docker call and every failed removal reports its timeline (call, client pid, end, signal, duration, bound, cut), which names such a failure. Disposition R47: every gate runs through gate.sh; a run counts only if its sampler shows no launch of 10 s or more; acceptance needs two consecutive valid green runs of each gate at the final head. Possible remedies, none applied: a host-policy exemption for the process that launches the gates (the user's choice; untested), keeping Node-launch bursts off the host during a gate, or a fake docker client that is not a Node launch per call."
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
takeover reconciles the branch with those facts and rewrites the title and
body of the PR the attempt recorded, named by its number, on record, before
the task reaches review; it creates no PR. Only the PR the attempt recorded,
open, unmerged, on the attempt's base and at the attempt's commit, completes:
completion reads it back after its record and persists exactly that read; a
PR a human closed, merged or retargeted, or another PR on the branch, is left
as found and the task fails, on record. A human closing, merging or
retargeting a PR between the harness's read of it and its title/body write can
still receive that write (a residual read/write race; GitHub has no
compare-and-set for a PR update); the read that follows fails the task.

## Where this stands

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED**. Three
items are open: the live pilot has not run (no credentials here), repair cycle
13 has not been independently reviewed, and the gates are not reliable on this
host (CYCLE11-HIGH-002): a new Node process has waited tens of seconds to run
here — what holds it is a strong hypothesis, the host's launch-policy check,
not proven — and the unit tests' fake docker client is a Node process per
call. Under the controller's disposition (R47) a gate run counts only when its
Node-launch sampler shows no launch of 10 s or more.

The last independent review, Codex re-review cycle 12 at `d9255fb`, did not
accept Phase 2. It found the egress proxy kept the model credential usable
with nothing to bound it once the process that started it was gone; that test
fixtures could leave processes running and delete the records that find them;
and that both container-removal helpers took absence that arrived after their
deadline as proof; a mutant of the docker caller's cut survived. Repair cycle
13 addresses each as the controller decided (reconciliation R47): the proxy
has a lifetime of its own (an expiry and a link to its starter), test
processes are recorded outside the test process and ended before their
records go, late absence is refused, and the cut is bounded from above. The
dispositions, with their tests, mutation checks and what was not checked, are
in `phase-02-review-log.md` ("Final review cycle 12 dispositions"). They are
the implementer's own work and assessment; read them as claims to be checked.

What this cycle observed by machine, every gate through `gate.sh` with its Node-launch sampler: `pnpm verify:all` passed at each of the seven commits of the cycle, 869 to 885 canonical tests, with no Node launch of 10 s or more in any run (the longest 3.2 s); at the implementation head `b95cb82`, from a clean tree, all 14 steps passed with 885 canonical tests across 60 files and 36 required suites, and `pnpm test:integration` passed 34 tests across 7 files against real PostgreSQL, MinIO and Docker. No gate run of the cycle was red. The final sequence on the report commit — a frozen install, two `verify:all` and two `test:integration` runs — is reported to the controller, and the sentinel is written only after it passes.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, an independent review, or the CI runner's Docker
Engine version.

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
