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

  (2) The repairs of repair cycle 8 are unreviewed. Codex re-review cycle 7 at
  863fed0 (phase-02-final-rereview-codex-v7.md) returned REQUEST_CHANGES @ 0.99
  and did not accept Phase 2. Of the earlier findings it accepted (RESOLVED)
  only HIGH-001, HIGH-004, HIGH-007, MED-001, MED-002, MED-003, MED-004,
  MED-006, MED-NEW-001, MED-NEW-002, CYCLE5-PROVENANCE and CYCLE5-PILOT-TEST.
  It found HIGH-002, HIGH-005, HIGH-006, HIGH-008, HIGH-009, MED-005,
  MED-NEW-003 and MED-NEW-004 PARTIAL and HIGH-003 REGRESSED, and restated
  what remained as CYCLE7-HIGH-001..007 and CYCLE7-MED-001..004. Its snapshot
  predates the cycle-7 follow-up, which no independent review has seen either.
  Repair cycle 8 addresses every cycle-7 finding. Every repair, test and
  mutation check was produced and read by the implementer alone. Under this
  project's trust ordering (machine evidence > independent review >
  implementer self-review) that is not acceptance evidence, which is what the
  _UNREVIEWED suffix records.

  Earlier revisions of this report said every finding was closed (before cycle
  6) and that cycle 7 had repaired every PARTIAL or REGRESSED finding of cycle
  6. Both reviews showed those claims went beyond what the code did. This
  revision states the gate results observed in this cycle and the status of
  each finding, and nothing else as verified.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: base = `git merge-base main HEAD`.
  last_reviewed_head: 863fed0 (Codex re-review cycle 7, REQUEST_CHANGES)
  under_review: none
  implementation_head_sha: f11d49b0831cfad6c9b2c3ef1b371e809dece33a
  head_binding: >-
    implementation_head_sha is the last implementation commit of repair cycle
    8 (`git rev-parse f11d49b`). The commits after it change documentation
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
  test_runner: tsx --test

verification:
  observed_at: >-
    7bbee45557a3726e59387688b5372152722f0f21, from a clean tree; it differs from
    implementation_head_sha by documentation only
  install: "pnpm install --frozen-lockfile — exit 0"
  verify_all: "pnpm verify:all — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (35/35), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree"
  canonical_tests: "762 tests, 762 pass, 0 fail, 0 skipped, across 57 test files; 35 required suite markers verified by scripts/run-canonical-tests.mjs"
  integration_gate: "pnpm test:integration — exit 0; 34 tests, 34 pass, 0 fail, 0 skipped, across 7 *.itest.ts files on digest-pinned PostgreSQL and MinIO and Docker 29.6.1 (backends published on 127.0.0.1 only); 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained"
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates and was not run in
    this cycle. Its CONFORMANCE test last ran at dec962b (cycle-7 follow-up)
    and passed; cycle 8 changed the agent network's creation and inspection
    (9d782c1), which that run predates. Its LIVE test (real model API) has
    never run here: no credential.
  mutation_checks: >-
    Run by the implementer for every cycle-7 finding that changed code: 90
    mutants, 89 killed, 1 survived (equivalent: an unreachable defensive
    branch). Mutants and outcomes per finding are in phase-02-review-log.md,
    "Final review cycle 7 dispositions".

findings_cycle_7:
  note: >-
    Status after repair cycle 8, as assessed by the implementer; none is
    independently confirmed. Details, tests, mutation checks and residual
    concerns per finding: phase-02-review-log.md, "Final review cycle 7
    dispositions".
  accepted_by_review_at_cycle_7: [HIGH-001, HIGH-004, HIGH-007, MED-001, MED-002, MED-003, MED-004, MED-006, MED-NEW-001, MED-NEW-002, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST]
  repaired_unreviewed:
    CYCLE7-HIGH-001: "de0fba1 — the runner runs a command only for a handle a sandbox provider made, where that provider put it; a copied, spread, destructured or hand-built handle runs nothing"
    CYCLE7-HIGH-002: "54af435, 0e7eb0d — migrations 0017 and 0018: every authoritative reference is a scoped key with checksum and kind; a PR names an attempt of its own binding; evidence links name a reservation of the same attempt"
    CYCLE7-HIGH-003: "0e7eb0d, 7fdd47d, 3de3f08 — resume between commit and evidence from the reserved draft; one create-only commit per attempt, reconciled without the dead worktree; ownership confirmed at each external call and the fencing epoch carried to the forge"
    CYCLE7-HIGH-004: "9d782c1 — the agent network has no host-side gateway (isolated gateway mode, checked by inspection); a canary on the real daemon shows the agent reaches only the proxy"
    CYCLE7-HIGH-005: "f11d49b — the verifier checks the task's state and risk, its work order and the agent's inputs, the canonical evidence bundle and a record of where each check ran"
    CYCLE7-HIGH-006: "dec962b (cycle-7 follow-up, after the reviewed snapshot) — verification containers stopped and removed by name"
    CYCLE7-HIGH-007: "946ba77 — resume runs the task's own risk admission before it takes a lease"
    CYCLE7-MED-001: "8c3f970 — migration 0016: lease liveness by clock_timestamp()"
    CYCLE7-MED-002: "61138bd — a failing artifact discovery fails the cold-cache reset"
    CYCLE7-MED-003: "ec280f8 (cycle-7 follow-up) — gate backends on 127.0.0.1 only; 9d782c1's canary shows the agent cannot reach them"
    CYCLE7-MED-004: "review log — the user's decision to keep published history and block new personal addresses, as attested by the controller"
    MED-005: "this report and the L1 sentinel"
  earlier_cycles: "cycle-6 dispositions (repair cycle 7) and the cycle-7 follow-up: phase-02-review-log.md"

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
  F_runner_sandbox: "asep-suite:command-runner; real Docker: asep-suite:sandbox-exec. The governed path first refuses a handle that does not claim isolation; the runner then runs a command only for a handle a sandbox provider made, in the place that provider recorded for it. There is no waiver."
  G_claude_adapter: "asep-suite:agent-claude, asep-suite:agent-sandbox; live run not performed"
  H_forge: "asep-suite:github-app, asep-suite:forge-port-adapter"
  I_review_state: "asep-suite:governed-execution, asep-suite:vertical-integration, asep-suite:resume-attempt"
  J_observability: "asep-suite:observability-spans, asep-suite:observability-audit; spans on the real path: asep-suite:vertical-slice-real"
  K1_K3_K4: "asep-suite:vertical-slice-real (real PostgreSQL and Docker), asep-suite:gate-fail-closed, asep-suite:integration-gate"
  K2: NOT MET — no live task run
  K5: "NOT MET — verifier exercised by asep-suite:pilot-manifest, asep-suite:authority-resolver-sql, asep-suite:pilot-verifier; no pilot manifest exists"
  K6: NOT MET — pilot pending
  L1: "this report; sentinel written last (see head_binding)"
  L2: "every cycle-7 finding has a recorded disposition; independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - 215db41 docs(phase-2) add the cycle-7 independent re-review transcript with its provenance
  - 61138bd fix(gate) fail the cold-cache reset when its artifact discovery fails (CYCLE7-MED-002)
  - 78413e3 docs(phase-2) end the cycle-7 review transcript with a newline
  - de0fba1 fix(sandbox) run a command only for a handle a sandbox provider made, where it put it (CYCLE7-HIGH-001)
  - 946ba77 fix(resume) admit the task's own risk before a resume takes its lease (CYCLE7-HIGH-007)
  - 8c3f970 fix(persistence) decide lease liveness by the database clock at the decision (CYCLE7-MED-001)
  - 54af435 fix(persistence) make every authoritative artifact reference a scoped key with checksum and kind (CYCLE7-HIGH-002)
  - 0e7eb0d fix(evidence) reserve the evidence draft before the commit and resume between commit and evidence (CYCLE7-HIGH-002, CYCLE7-HIGH-003)
  - 7fdd47d fix(resume) adopt a harness commit that landed before its record completed (CYCLE7-HIGH-003)
  - 3de3f08 fix(fencing) confirm ownership at each external call and carry the epoch to the forge (CYCLE7-HIGH-003)
  - 9d782c1 fix(agent) give the agent network no host address and prove the agent reaches only the proxy (CYCLE7-HIGH-004)
  - f11d49b fix(pilot) verify the task, its work order, the canonical evidence and where each check ran (CYCLE7-HIGH-005)
  - 7bbee45 docs(phase-2) record the cycle-7 dispositions and the controller-attested history decision (CYCLE7-MED-004)
commits_earlier_history: "`git log fc0df57..f3bb704`"

contract_changes_this_cycle:
  migrations:
    - "0016_lease_liveness_clock — asep_lease_is_live on clock_timestamp(), owner lease read for share"
    - "0017_scoped_artifact_references — product spec, work order, context pack and evidence references as <name>_artifact_id + <name>_sha256 + generated <name>_kind, composite-FK-bound to artifacts; PR → attempt FK includes the binding; JSONB reference columns dropped"
    - "0018_evidence_reservations — evidence_reservations table; artifacts_attempt_scoped_ref_uq; side_effect_records.commit_evidence_id (generated) and the attempt and PR evidence links FK-bound to a reservation of the same attempt"
  ports: >-
    EvidenceStore: allocateEvidenceId removed; reserveEvidence, getReservation,
    EvidenceDraft, EvidenceReservation, evidenceBundleFrom. GitCommitter.commit
    takes attemptId and baseSha; GitCommitter.reconcile added. SideEffectLog.
    confirmOwner. ForgeProvider.pushBranch and upsertPullRequest take a required
    fencingEpoch; StaleFencingEpochError, withFencingMarker, fencingEpochOf.
    CommandResult.provenance (optional) and CommandProvenance.
  adapters: >-
    @asep/command-runner: SandboxHandleNotProvenError; handles are frozen and
    recorded per provider; results carry provenance.
    @asep/git-worktree: commit via commit-tree with a create-only
    refs/asep/attempts/<attemptId>, reconcile, HarnessCommitError.
    @asep/persistence: the task and attempt repositories attach the work order
    and context pack once (ReferenceAlreadyAttachedError, not exported);
    ContentAddressedEvidenceStore reservations;
    SqlSideEffectLog.confirmOwner. @asep/github-app: UpsertPrInput.fencingEpoch,
    the PR body carries the epoch marker. @asep/local-doubles: LocalPullRequest
    (title, body); the local forge records and checks the epoch. @asep/agent-claude:
    AGENT_NETWORK_FLAGS, agentNetworkIsolationGap; the agent network is created
    with isolated gateway mode and inspected (Docker Engine 28.0.0 or later).
  application: >-
    ResumeTaskPort.getScoped returns risk; resumeAttemptToReview runs admission
    first (stop 'admission') and takes a committer (reconcile);
    SliceTaskPort.attachWorkOrder, SliceAttemptPort.attachContextPack;
    settleCommitStep; CompleteToReviewInput.recordVerification;
    verificationProvenance and VerificationProvenance; VerificationCheckExecution
    .provenance. The workflow writes a verification-provenance artifact per
    attempt.
  apps: "VerticalSliceInput.objectStore (optional); ResumeVerticalSliceInput.mirrorPath and objectStore (optional)"
  pilot_verifier: >-
    The resolver contract adds resolveArtifact and resolveVerification;
    resolveAttempt also returns baseSha, taskStatus, taskRisk,
    workOrderArtifactId, workOrderSha256, contextPackArtifactId and
    contextPackSha256; resolveEvidence returns the whole bundle; the invocation
    facts include the agent's inputs. The pins add verifyImage
    (ASEP_VERIFY_IMAGE_DIGEST, digest-pinned), which createResolverFromEnv
    requires. New export ADMISSIBLE_RISKS.

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 8 and the cycle-7 follow-up are unreviewed (see verdict_note)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. Enforcement is the runner's own record: it runs a command only for a handle a sandbox provider made, where that provider put it."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "The agent network needs Docker Engine 28.0.0 or later (isolated gateway mode). Verified on Docker Desktop 29.6.1 here; the CI runner's engine version is not verified."
  - "Fencing residuals: a git ref cannot record an epoch, so a push relies on the ownership confirmation, one commit per attempt and a non-force push; GitHub has no compare-and-set on a PR, so the epoch check narrows but does not close a race between two upserts; an owner that confirmed and then stalls in the call longer than its renewed lease TTL can still reach the forge after a takeover."
  - "An attempt whose harness commit never landed is not resumed; it is re-executed as a new attempt (nothing left the harness)."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1)."
  - "The pilot verifier rests on what the harness recorded — agent artifacts and the verification provenance record — and on the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin. The provenance record is not FK-bound to the evidence reservation."
  - "Under heavy host load (load average 10–18 during this cycle) full canonical runs intermittently hit a V8 fatal ('Check failed: end > addr') in a PGlite suite and ~30 s timeouts in Docker-faking suites; each affected file passed when re-run alone, and the gate runs reported above passed whole."
  - "Fault 5 of the rehearsal pushes to a local bare remote; fault 1 is injected into the provider, not a full pipeline run."
  - "PGlite is a fast-test seam; the real-backend proofs run on PostgreSQL 17 in the integration gate."
  - "No Phase 3+ runtime (Temporal, distributed scheduling, second-model reviewer, Web Console, memory, auto-merge, deploy, K8s/gVisor, enterprise OIDC) by design."

pilot_prerequisites:
  - "PP1: a model credential in a mode-600 file (ASEP_ANTHROPIC_API_KEY_FILE), the digest-pinned agent and egress-proxy images, Docker Engine 28.0.0 or later, and `pnpm test:live:claude` LIVE passing with the pilot's configuration (runbook §0.1)."
  - "PP2: the GitHub App installed on the pilot repository with the default branch protected; its private key held by the operator."
  - "PP3: a durable ASEP_OBJECT_STORE_DIR shared by the pilot runs and the verifier, and the verifier run with the pilot's own Claude pins and verification image, ASEP_VERIFY_IMAGE_DIGEST (runbook §0.2)."
  - "PP4: ten genuine R0 or R1 tasks run end to end, each with a signed human authorization; the manifest gated by scripts/pilot/verify-pilot-manifest.mjs."
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
fenced leases and confirmed at each call, so a successor can take over a
crashed attempt and converge on one commit, one ref and one PR.

## Where this stands

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED**. Two items
are open: the live pilot has not run (no credentials here), and repair cycle 8
has not been independently reviewed.

The last independent review, Codex re-review cycle 7 at `863fed0`, did not
accept Phase 2. It accepted twelve earlier findings as resolved (listed in the
YAML above), found eight partial and one regressed, and raised eleven new
findings. Repair cycle 8 addresses each of the new findings and the report's
own overclaims. The repairs are listed in the YAML above and dispositioned,
with their tests, mutation checks and residual concerns, in
`phase-02-review-log.md` ("Final review cycle 7 dispositions"). They are the
implementer's own work and assessment; read them as claims to be checked.

What this cycle observed by machine: from a clean tree at `7bbee45` (the implementation head plus the review-log commit), `pnpm install --frozen-lockfile` succeeded; `pnpm verify:all` passed all 14 steps, including 762 canonical tests across 57 files with 35 required suites, the contract, policy and compatibility gates, the fitness suites, the scans and the publication gate; and `pnpm test:integration` passed 34 tests across 7 files against real PostgreSQL, MinIO and Docker. The sentinel is written only after both gates pass again on the report commit.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, an independent review, or the CI runner's Docker
Engine version.

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
