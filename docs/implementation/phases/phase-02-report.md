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

  (2) The repairs of repair cycle 16 are unreviewed, and one finding is not
  closed. Codex re-review cycle 15 at 6cf731b
  (phase-02-final-rereview-codex-v15.md) returned REQUEST_CHANGES @ 0.99 and
  did not accept Phase 2. It accepted (RESOLVED) CYCLE14-MED-002,
  CYCLE14-LOW-001, CYCLE14-LOW-002 and CYCLE13-MED-003, found the
  controller's four gates at 6cf731b valid under R47, and the controller's
  Linux check ran the registry and fake docker suites on a real /proc. It
  found CYCLE14-HIGH-001, CYCLE12-HIGH-001, CYCLE14-MED-001, CYCLE13-MED-001
  and CYCLE12-MED-001 PARTIAL, and raised CYCLE15-HIGH-001 (the readiness
  bound was held only by a timer, so a ready line after the bound got the
  credential while the timer had not yet run, and the spawn's time was not
  counted), CYCLE15-MED-001 (a group whose leader showed its token was
  signalled with its other members unchecked), CYCLE15-MED-002 (a registry
  that could not be read was taken as empty), CYCLE15-LOW-001 (the handshake
  took substrings, partial lines and lines out of order) and CYCLE15-LOW-002
  (a test poll on the wall clock). Repair cycle 16 applies the controller's
  decisions on that review (reconciliation R50). CYCLE11-HIGH-002 is not
  closed. The stall is in
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
  (cycle 11; its write went through the branch-keyed upsert), that the
  cause of CYCLE11-HIGH-002 had been found on the host (cycle 12; it is a
  strong hypothesis, not proven), that after worker death the credential was
  usable through a leftover proxy at most until the attempt's deadline plus
  30 s (cycle 13; a wall clock set back extended it), and that a test
  fixture's record stayed until its process was shown gone (cycle 13; a
  failed ps was taken as absence), and that every long-lived test process was
  in the run's registry and a test's own registry was kept beside the run's
  (cycle 14; the fitness test lists spawns that are not recorded, and two
  tests put their registry in place of the run's), and that the credential
  reached the proxy only on a ready line within its bound (cycle 15; a late
  line got it while the timer had not yet run). The reviews showed each was
  wrong. This revision states the gate results observed in
  this cycle and the status of each finding, and nothing else as verified.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: base = `git merge-base main HEAD`.
  last_reviewed_head: 6cf731b (Codex re-review cycle 15, REQUEST_CHANGES)
  under_review: none
  implementation_head_sha: 6f825cca7d82b6b28e284d8160a21eb84f44b6ea
  head_binding: >-
    implementation_head_sha is the last commit of repair cycle 16 that changes
    code or tests (`git rev-parse 6f825cc`). The commits after it change
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
    6f825cca7d82b6b28e284d8160a21eb84f44b6ea (implementation_head_sha), from a
    clean tree; every gate through the controller's gate.sh, which holds the
    host's gate lock and samples Node launches beside the run
  install: "not run at 6f825cc; pnpm install --frozen-lockfile opens the final gate sequence on the report commit"
  verify_all: "pnpm verify:all through gate.sh — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (36/36), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree; 540 s; sampler: 222 samples, longest Node launch 5875 ms, none of 10 s or more (valid under R47)"
  every_commit: "verify:all through gate.sh at each commit before the next, every run passed and valid under R47 (no Node launch of 10 s or more; longest 5.2–5.9 s): 18756f5 912, c27166b 913, 48e8119 914, 411d28e 916, 6f825cc 917 tests. No red run in this cycle"
  canonical_tests: "917 tests, 917 pass, 0 fail, 0 skipped, across 60 test files; 36 required suite markers verified by scripts/run-canonical-tests.mjs; its process registry found no recorded process still running from earlier runs or from this run; it listed six records of this run as gone (processes the runner's wiring tests started in nested runs, recorded in this run too since 8eb5dd0, and already ended)"
  integration_gate: "pnpm test:integration through gate.sh at 6f825cc — exit 0; 34 tests, 34 pass, 0 fail, 0 skipped, across 7 *.itest.ts files on digest-pinned PostgreSQL and MinIO and Docker 29.6.1 (backends published on 127.0.0.1 only), the real egress proxy's handshake among them; 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained; 102 s; sampler: 47 samples, longest Node launch 1081 ms (valid under R47)"
  gate_validity: "R47: a gate run is acceptance evidence only if its Node-launch sampler shows no launch of 10 s or more; a red run with such a stall is a host stall, neither pass nor fix; a red run without one is a real failure needing a root cause; acceptance needs two consecutive valid green runs of each gate at the final head (the final sequence on the report commit, bound by the sentinel)"
  synthetic_load: "not run in this cycle or the last (cycle 12's runs, which do not exercise the stall: 0 failures in 20 runs before its changes, 0 in 10 after; phase-02-review-log.md, \"Final review cycle 11 dispositions\")"
  integration_gate_under_load: "not run in this cycle"
  integration_gate_at_reviewed_head: "the controller's gates at 6cf731b, through gate.sh: verify:all twice, exit 0, 912 of 912 each (550 s and 556 s, longest Node launch 5.2 s and 5.1 s); test:integration twice, exit 0, 34 of 34 each (longest launch 1.17 s and 0.98 s); none with a launch of 10 s or more; the cycle-15 review recomputed the samplers from the raw logs and found the four runs valid under R47. The controller's Linux check at 6cf731b (Docker node:24-bookworm, procps-ng 4.0.2): process-registry.test.ts 17 of 17 and fake-docker.test.ts 6 of 6 on a real /proc; the runner's four nested-runner wiring tests could not run there (no tsx in the mounted tree)"
  earlier_red_runs: "verify:all at 7017cfc, twice (two tests each: the sandbox's first docker call, the tests' Node-based fake client, started at once and was killed at its 30 s bound; a probe beside the second run measured Node launches held 4.6–40.7 s while /bin/sh and /usr/bin/true launched in at most 173 ms — what holds them is a strong hypothesis, the host's launch-policy check, not proven); the controller's run 2 at 42b6d78 (fits the same stall; its window is no longer in the host's kernel log, so it cannot be checked; its canonical test step took 422 s against 351 s in run 1); the first run of repair cycle 11 at 21aeb0d (two agent tests: the egress proxy, a Node process, did not become ready within its timer; the same class, not checkable now); the controller's run 1 at a447983 (the hung-agent test 80.8 s against its 60 s check; not explained)"
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates and was not run in
    this cycle. Its CONFORMANCE test last ran at dec962b (cycle-7 follow-up)
    and passed; the agent network's creation and inspection (9d782c1) and the
    egress proxy's lifetime (0d95b1f, then d883e24) changed after it, so its
    rerun is a pilot prerequisite (PP1). Its LIVE test (real model API) has
    never run here: no credential.
  mutation_checks: >-
    Run by the implementer for every cycle-15 finding: 29 mutants, all killed (CYCLE15-HIGH-001 and -LOW-001 10, CYCLE15-MED-001 4, CYCLE15-MED-002 6, CYCLE15-LOW-002 9), the reviewer's timer + 1 s mutant among them, killed by the virtual-time schedule and by the real-timeout test's new upper bound; four handshake mutants first left a test waiting and were rerun after the test bounded its waits; one LOW-002 mutant (the persistence suite's moment back on the wall clock) survived the fitness test's first, narrower form, which was then widened, and was killed. Not distinguished by a test: fixing the readiness deadline before rather than after the spawn (the spawn returns within milliseconds). Not mutation-checked: the threat model and runbook text. Mutants per finding are in phase-02-review-log.md, "Final review cycle 15 dispositions". Cycle 14's, run in repair cycle 15: 35 mutants, all killed (CYCLE14-HIGH-001 11, CYCLE14-MED-001 12, CYCLE14-MED-002 5, CYCLE14-LOW-001 4, CYCLE14-LOW-002 3). Cycle 13's, run in repair cycle 14: 44 mutants, 43 killed (CYCLE13-HIGH-001 16, CYCLE13-MED-001 and -002 18, CYCLE13-MED-003 7, CYCLE13-MED-004 3). The one that survived — a response beginning after the deadline forwarded — removed a check that was redundant (the headers leave only with the first chunk or the end, both checked); the branch was removed, and a test of what the agent receives kills a mutant that flushes the headers at once. The reviewer's marker-prefix mutant has no target (the marker is gone); its class, an identity weakened to what a shared executable shows, was run on the token and the start time and killed by the shared-executable negative case. Two mutants (an unreadable table taken as absence; a process that cannot be recorded left running) did not end within the mutation runner's 600 s bound on their first run and were killed on a rerun; the processes those runs left were killed by pid after their identity was checked. Not mutation-checked: the threat model and runbook text. Mutants per finding are in phase-02-review-log.md, "Final review cycle 13 dispositions".

findings_cycle_15:
  note: >-
    Status after repair cycle 16, as assessed by the implementer; none is
    independently confirmed. Details, tests, mutation checks and residual
    concerns per finding: phase-02-review-log.md, "Final review cycle 15
    dispositions".
  accepted_by_review_at_cycle_15: [CYCLE14-MED-002, CYCLE14-LOW-001, CYCLE14-LOW-002, CYCLE13-MED-003]
  partial_at_cycle_15: "CYCLE14-HIGH-001 and CYCLE12-HIGH-001 (by CYCLE15-HIGH-001), CYCLE14-MED-001, CYCLE13-MED-001 and CYCLE12-MED-001 (by CYCLE15-MED-001 and CYCLE15-MED-002), CYCLE11-HIGH-002 (its cause not proven; R47 holds)"
  repaired_unreviewed:
    CYCLE15-HIGH-001: "c27166b — the provider fixes the proxy's readiness deadline on its monotonic clock just before the spawn, so the spawn's time counts against it, sets its timer for the time left, and checks the deadline as each line of the proxy arrives: past it, no credential is written and the start fails, whether or not the timer has fired. Tests: a ready line 1 ms past the deadline, at 180 s, and after a 45 s spawn against a 30 s bound, each with the timer pending, gets nothing; a late serving line fails the start; the timer's schedule; the reviewer's end-to-end model on the provider's and the proxy's code; the real-timeout test bounds the wait from above (500 ms past the bound)"
    CYCLE15-LOW-001: "c27166b — the proxy's stdout is read as whole lines, which must be exactly its ready line (port 8080) and then its serving line; a partial line gets nothing until it is whole, and a substring, another port or a line out of order fails the start"
    CYCLE15-MED-001: "48e8119 — a group is signalled only while every other member shows the recorded token and started no earlier than the leader, whether the leader runs or has exited; a member with another token, one whose environment cannot be read, or members that cannot be listed make it unknown. Tests: the reviewer's two live-leader probes and an unlistable group"
    CYCLE15-MED-002: "411d28e — only a directory that does not exist reads as empty; a registry root or run that cannot be read, or an owner record that cannot be read or parsed, is unknown, left as it is, and fails the gate, named; a fake docker fixture with a directory that cannot be read is kept. Tests: the reviewer's unreadable registry root through the runner, and each other case"
    CYCLE15-LOW-002: "6f825cc — every wait, moment and span the tests and their tools keep runs on the monotonic clock; a fitness test fails on a test source or test tool that keeps, returns or compares with a moment of Date.now()"
    docs: "T2-16, the runbook, the review log and this report match the fixed behaviour; the cycle-14 claim that the key went only to a proxy ready within its bound is corrected"
    CYCLE11-HIGH-002: "NOT CLOSED; disposition R47 unchanged. Every gate of this cycle ran through gate.sh and was valid under R47"

findings_cycle_14:
  note: >-
    Status after repair cycle 15, as assessed by the implementer then; the
    cycle-15 review's verdicts on them are above. Details:
    phase-02-review-log.md, "Final review cycle 14 dispositions".
  accepted_by_review_at_cycle_14: [CYCLE13-HIGH-001, CYCLE13-MED-002, CYCLE13-MED-004]
  partial_at_cycle_14: "CYCLE12-HIGH-001 (by CYCLE14-HIGH-001), CYCLE13-MED-001 and CYCLE12-MED-001 (by CYCLE14-MED-001 and CYCLE14-MED-002), CYCLE13-MED-003 (by CYCLE14-MED-002), CYCLE11-HIGH-002 (its cause not proven; R47 holds)"
  repaired_unreviewed:
    CYCLE14-HIGH-001: "9b5f65c — the egress proxy starts without the credential and refuses every request until it holds it; the provider writes it on the proxy's stdin only after the proxy reported ready within its readiness bound, once, and waits for the proxy to confirm (corrected in repair cycle 16: at 6cf731b the bound was held only by a timer, so a ready line after it got the key while the timer had not yet run — CYCLE15-HIGH-001, fixed in c27166b); the proxy's own credential window (60 s at most, on its monotonic clock from its start) ends it without one, and refuses a credential or a request after it. A worker that dies before readiness never hands the credential over; the window after worker death is min(remaining budget + grace, maximum) + readiness bound from the spawn. Tests: the reviewer's CYCLE14_LATE_START_MODEL on virtual time (no credential, nothing forwarded, ended at the window); the window's refusals; a proxy process given no credential; the provider's handshake on virtual time. T2-16 and the runbook drop the start-up exception"
    CYCLE14-MED-001: "ebf3fa4 — records carry a format version; a record without a valid version, pid, group flag, non-empty token or start time, or one that cannot be read, is never handed on: unknown, kept, never signalled, and the runner fails naming it and why; a token match needs a non-empty recorded token; a leader that exited before it was recorded is recorded by the start time it still shows. Tests: the reviewer's CYCLE14_LEGACY_RECORD_LIVE_LEADER and CYCLE14_LEGACY_RECORD_UNKNOWN_ENV, each missing field, a torn record, an empty token, and the runner on an earlier run holding legacy and torn records"
    CYCLE14-MED-002: "8eb5dd0 — a test adds a registry of its own with nestRegistry, beside the run's; a runner started inside a run keeps the outer run's registry; the fake docker, registry and runner tests assert that their helpers' processes are in the outer registry; a fitness test rejects a test that assigns or deletes the registry variable or hands a child a registry without the run's"
    CYCLE14-LOW-001: "07f6701 — an attempt whose budget plus the proxy's grace exceeds the proxy's maximum lifetime (a budget over 239.5 minutes), or whose budget is not a number, is BLOCKED before anything is done for it; the runbook says so"
    CYCLE14-LOW-002: "5acff7a — ASEP_PROCESS_TABLE_PROC names the directory read as /proc, for the tests; an environment it cannot show is unknown, the record kept and the runner's gate red; the reviewer's undefined → null mutant is killed"
    docs: "the review log's and this report's claims about nested registries and long-lived test processes corrected"
    CYCLE11-HIGH-002: "NOT CLOSED; disposition R47 unchanged. Every gate of this cycle ran through gate.sh and was valid under R47"

findings_cycle_13:
  note: >-
    Status after repair cycle 14, as assessed by the implementer then; the
    cycle-14 review's verdicts on them are above. Details:
    phase-02-review-log.md, "Final review cycle 13 dispositions".
  accepted_by_review_at_cycle_13: [CYCLE12-MED-002, CUT-MUTANT, INSTRUMENTATION, REAL-OCTOKIT-PROBE, TIMEOUTS, CYCLE10-HIGH-002, CYCLE11-HIGH-001, CYCLE11-MED-001, CONCERN-2, CYCLE10-HIGH-001, HIGH-006, MED-005, CYCLE7-HIGH-003, CYCLE8-HIGH-003, MONOTONIC-WAITS]
  partial_at_cycle_13: "CYCLE12-HIGH-001 (by CYCLE13-HIGH-001), CYCLE12-MED-001 (by CYCLE13-MED-001 to -004), CYCLE11-HIGH-002 (its cause not proven; R47 holds)"
  repaired_unreviewed:
    CYCLE13-HIGH-001: "d883e24, 6f4dc30 — the egress proxy takes a relative lifetime (--lifetime-ms, at most MAX_LIFETIME_MS, four hours; it refuses to start beyond) and fixes its deadline once on its own monotonic clock from its own start; admission, its exit timer and every request and stream in flight answer to that one deadline, and whichever first sees it reached ends the proxy: nothing more is forwarded, every open connection is destroyed, the proxy exits. The provider passes what is left of the budget at the proxy's spawn plus PROXY_EXPIRY_GRACE_MS, at most PROXY_MAX_LIFETIME_MS; a proxy not ready within its readiness bound is killed. Tests: the reviewer's rollback, latch-timer, stream-after-expiry and expiry-input probes (a real proxy with its wall clock moved an hour back and an hour forward; streams cut at the deadline whatever sees it first; a kept-alive request refused; start beyond the maximum refused); the provider's lifetime with a slow setup and a budget beyond the maximum. T2-16 and the runbook: the window after worker death is min(remaining budget + grace, maximum) + readiness bound, independent of wall-clock changes"
    CYCLE13-MED-001: "607b6dc, f02fe83 — a recorded test process carries a token of its own in its environment and its start time; it is signalled only while its pid shows both; a leaderless group only while every member shows the token; test cleanups end containers by that identity, never by a pid alone. The marker-prefix mutant's class (identity weakened to what a shared executable shows) is killed by the shared-executable negative case"
    CYCLE13-MED-002: "607b6dc — a ps that fails (status, spawn error, signal) or an environment that cannot be read is 'unknown': nothing is signalled, the record stays, the cleanup fails; in the registry, the fake docker, fixture removal and the canonical runner"
    CYCLE13-MED-003: "a94fa3e, 985ddf3 — every process a test starts is in the run's registry, the registry's own tests included, or on a fitness test's list with why it need not be (wording corrected in repair cycle 15)"
    CYCLE13-MED-004: "6fec876 — a leftover of an earlier run that cannot be shown gone fails the gate; a negative wiring test"
    CYCLE11-HIGH-002: "NOT CLOSED; disposition R47 unchanged. Every gate of this cycle ran through gate.sh and was valid under R47"

findings_cycle_12:
  note: >-
    Status after repair cycle 13, as assessed by the implementer then; the
    cycle-13 review's verdicts on them are above. Details:
    phase-02-review-log.md, "Final review cycle 12 dispositions".
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
  L2: "every cycle-15 finding has a recorded disposition; CYCLE11-HIGH-002 is not closed (the stall is in Node launch on this host; its cause a strong hypothesis, not proven; disposition R47); independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - 18756f5 docs(phase-2) add the cycle-15 independent review transcript
  - c27166b fix(agent-claude) the readiness bound is checked when the proxy's line arrives, not only by a timer (CYCLE15-HIGH-001, CYCLE15-LOW-001)
  - 48e8119 fix(process-registry) every member is shown ours before a group is signalled (CYCLE15-MED-001)
  - 411d28e fix(process-registry) an unreadable registry is not an empty one (CYCLE15-MED-002)
  - 6f825cc test tests time their waits on the monotonic clock (CYCLE15-LOW-002)
  - this report and the cycle-15 dispositions
commits_earlier_history: "`git log fc0df57..6cf731b`"

contract_changes_this_cycle:
  migrations: "none"
  ports: >-
    None in this cycle. Lanes A and B adopt the cycle-11 port delta
    (ForgeProvider.updatePullRequestContent, a fifth, required method) at
    their rebase after G-P2, and no adapter may implement
    updatePullRequestContent through a branch-keyed upsert (R47).
  adapters: >-
    @asep/agent-claude: the egress proxy starts without the credential:
    assets/egress-proxy.mjs takes --credential-window-ms (at most its exported
    CREDENTIAL_WINDOW_MS), prints "asep-egress-proxy serving" once it holds the
    credential, and its egressProxy takes credentialBy and returns a server
    with provideCredential(key); buildProxyRunArgs passes the window; new
    exports PROXY_START_TIMEOUT_MS, PROXY_CREDENTIAL_WINDOW_MS and
    proxyHandshake; an attempt whose budget plus PROXY_EXPIRY_GRACE_MS
    exceeds PROXY_MAX_LIFETIME_MS is BLOCKED before it starts. Repair cycle
    16: proxyHandshake takes readyBy (a moment fixed before the spawn) in
    place of bound, and fails the start on any stdout line other than the
    exact ready line and then the exact serving line.
  application: "none"
  apps: "none"
  test_tooling: >-
    scripts/lib/process-registry.mjs records { version, pid, group, token,
    startedAt } and exports RECORD_VERSION, identityGap, nestRegistry and
    PROC_ENV; endRecorded returns a record without full identity as
    'unknown' with record and why, and the canonical runner names it;
    withProcessRegistry keeps the outer run's registry. Fake docker records
    carry the version. Repair cycle 16: an unreadable registry directory is
    reported as { directory, outcome: 'unknown', why } and an unreadable
    owner record as { run, record: 'owner.json', owner: true, outcome:
    'unknown', why }; a group is signalled only while every member shows its
    token; the fake docker passes a listening container's ready line on with
    the port it was given; new helper scripts/testing/unreadable.mjs.

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 16 is unreviewed, and CYCLE11-HIGH-002 is not closed (see verdict_note)."
  - "Publication under takeover is not fenced at the forge. A stale owner — one paused inside a forge call while its lease lapsed — may still reach the forge, and GitHub offers no compare-and-set for a PR update. The push's compare-and-set conditions only on the branch's current value: expecting absence it accepts any SHA while the branch is absent, expecting the current value it accepts an update to any SHA. That only the attempt's commit lands comes from the harness, which always pushes the attempt's pinned commit; the compare-and-set makes a stale push of a different SHA fail once the branch exists. PR content is the same pure function of the attempt's facts. Before the terminal state the takeover puts the branch back on the attempt's commit and rewrites the title and body of the attempt's recorded PR, named by its number, when it reads that PR open on the attempt's base; the repair lists, selects and creates no PR, the harness never reopens or retargets a PR, and a PR read closed, merged, on another base or of unreported state is not written and fails the task on record. A human may close, merge or retarget a PR between the harness's read of it and its title/body write (the recorded PR in that repair, the branch's PR in a fresh run's upsert), so that write can land on a PR that just closed (residual read/write race: GitHub has no compare-and-set for a PR update, R30); the read of the PR that follows then fails the task. A stale write that lands after that reconciliation is not repaired by that resume; an open PR edited outside the harness is repaired only by a later resume; a PR closed after its task reached review leaves the task there (the harness has no transition past review), and the verifier refuses it."
  - "Accepted as a Phase 2 limit (R39): the failure of a task on a publication gap is written from the persisted task status, which stays PENDING until the workflow writes a terminal state (the success path writes WAITING_FOR_HUMAN_REVIEW the same way); the domain's transition check is not applied to the persisted row, and PENDING → FAILED is not in the domain's table. The failure taxonomy has no publication class; the outcome is the audit detail."
  - "Accepted as a Phase 2 limit (R39): a PR closed after its task reached review leaves the task there; review is the harness's terminal state and the verifier refuses that PR."
  - "Accepted as a Phase 2 limit (R43): completion binds the PR's head commit to the attempt's commit. GitHub may update a PR's head commit asynchronously after a push; a read that lands before it has caught up is a gap, and the task fails closed rather than completing. The symptom and the recovery (a new task) are in runbook §3.4; the pilot records each occurrence (runbook §1), which measures how often it happens."
  - "An attempt whose harness commit never landed is not resumed; it is re-executed as a new attempt (nothing left the harness). This includes a crash between commit-tree and the create-only attempt ref, which leaves an unreferenced object: not every Git-call boundary converges on the same attempt."
  - "Migrations 0017, 0018 and 0019 refuse data that predates them; they are not a compatible upgrade, and a database at this schema must be created fresh (no pilot data exists)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. Enforcement is the runner's own record: it runs a command only for a handle a sandbox provider made, where that provider put it, from its own frozen copy of the flags."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "The agent network needs Docker Engine 28.0.0 or later (isolated gateway mode). Verified on Docker Desktop 29.6.1 here; the CI runner's engine version is not verified."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1). The egress proxy among them ends itself at the end of its lifetime, counted on its own monotonic clock, at the latest — after worker death within min(remaining budget + 30 s, 4 h) plus the readiness bound, whatever is done to the wall clock — or when its stdin link closes; until then the agent can still reach the model API through it with the credential (threat model T2-16). A worker that dies before its proxy reported ready never sent it the credential, and a proxy that reports ready after its readiness deadline — fixed before its spawn and checked as its line arrives — never gets it: such a proxy forwards nothing and exits at its credential window (60 s). Not covered: host sleep, which neither clock counts."
  - "An attempt's wall-clock budget is at most 239.5 minutes (the egress proxy's 4 h maximum lifetime less its 30 s grace); a longer one is refused as BLOCKED before anything is done for it (runbook §2)."
  - "The pilot verifier rests on what the harness recorded — agent artifacts and the verification provenance record — and on the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin. The provenance record is not FK-bound to the evidence reservation."
  - "The pilot workflow plans L0 and L1 only, so an R1 task stops at verification for its missing L2: pilot tasks are R0."
  - "Test bounds that depend on host load are sized from measurements up to a load average of about 185 on 8 CPUs (bc4cca5); a heavier load can still exceed them. The stop-path assertions use the product's bounds plus a 2 s scheduling allowance (the stop came at most 4 ms late at load average up to 112); the hung-agent integration test needs its setup to finish inside its 45 s budget (measured up to 19.1 s at load average 60–106 with docker churn; not checked independently) — accepted as a test condition, not a product SLA (R39). A container not shown gone within its removal bound (one docker-call timeout after its client ended) fails the attempt or the run."
  - "The 80.8 s red run at a447983 is neither reproduced nor explained. Its log records only the test's duration, which includes the test's fixture setup and cleanup; how that time split between fixture, setup, stop and teardown is not recorded and cannot be verified. No reproduction here took more than 12.3 s from the deadline to the end of teardown."
  - "The gates are not reliable on this host (CYCLE11-HIGH-002). During bursts of Node launches on the host a new Node process waited up to 40.7 s (measured in cycle 12); that the host's launch-policy check (AppleSystemPolicy notifying syspolicyd) holds them is a strong hypothesis, not proven, and what makes the bursts is unknown. The unit tests' fake docker client is one Node launch per docker call, so a call in such a window exceeds its 30 s bound and the test fails: 2 of the 8 canonical test runs of cycle 12 after the instrumentation landed failed so; none of the 8 gate runs of cycle 13 had a Node launch of 10 s or more. Every docker call and every failed removal reports its timeline (call, client pid, end, signal, duration, bound, cut), which names such a failure. Disposition R47: every gate runs through gate.sh; a run counts only if its sampler shows no launch of 10 s or more; acceptance needs two consecutive valid green runs of each gate at the final head. Possible remedies, none applied: a host-policy exemption for the process that launches the gates (the user's choice; untested), keeping Node-launch bursts off the host during a gate, or a fake docker client that is not a Node launch per call."
  - "The test process registry reads a process's environment from /proc on Linux and with ps -E on macOS. Here only the macOS path runs against a real process table; the Linux path's reading runs here through a stand-in /proc directory (ASEP_PROCESS_TABLE_PROC). The controller's Linux check at 6cf731b passed the registry and fake docker suites on a real /proc (Docker node:24-bookworm); this cycle's registry changes have not run on Linux, and the CI runner (ubuntu-latest) is not verified."
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
16 has not been independently reviewed, and the gates are not reliable on this
host (CYCLE11-HIGH-002): a new Node process has waited tens of seconds to run
here — what holds it is a strong hypothesis, the host's launch-policy check,
not proven — and the unit tests' fake docker client is a Node process per
call. Under the controller's disposition (R47) a gate run counts only when its
Node-launch sampler shows no launch of 10 s or more.

The last independent review, Codex re-review cycle 15 at `6cf731b`, did not
accept Phase 2. It accepted the nested registries, the budget refusal and the
`/proc` read's tests, and the controller's Linux check ran the registry and
fake docker suites on a real `/proc`. It found that the proxy's readiness
bound was held only by a timer, so a ready line after the bound got the
credential while the timer had not yet run, and the spawn's time was not
counted; that the handshake took substrings, partial lines and lines out of
order; that a group whose leader showed its token was signalled with its
other members unchecked; that a registry that could not be read was taken as
empty; and that a new test poll ran on the wall clock. Repair cycle 16
addresses each as the controller decided (reconciliation R50): the readiness
deadline is fixed before the spawn and checked as each whole, exact line
arrives; every member of a group must show the token before it is signalled;
only a missing directory reads as empty; and the tests' waits run on the
monotonic clock. The dispositions, with their tests, mutation checks and what
was not checked, are in `phase-02-review-log.md` ("Final review cycle 15
dispositions"). They are
the implementer's own work and assessment; read them as claims to be checked.

What this cycle observed by machine, every gate through `gate.sh` with its Node-launch sampler: `pnpm verify:all` passed at each of the five commits of the cycle, 912 to 917 canonical tests, with no Node launch of 10 s or more in any run (the longest 5.9 s); at the implementation head `6f825cc`, from a clean tree, all 14 steps passed with 917 canonical tests across 60 files and 36 required suites, and `pnpm test:integration` passed 34 tests across 7 files against real PostgreSQL, MinIO and Docker. No gate run of the cycle was red. The final sequence on the report commit — a frozen install, two `verify:all` and two `test:integration` runs — is reported to the controller, and the sentinel is written only after it passes.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, an independent review, the CI runner's Docker
Engine version, or this cycle's registry changes reading a real Linux
`/proc`, which the CI runner does (the controller's check ran the cycle-15
registry there; here the Linux reading runs only through a stand-in
directory).

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
