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
  This is not phase acceptance. Two things are outstanding.

  (1) The live pilot has not run. K2 (one live task), K5 (ten genuine tasks in
  a verified manifest) and K6 are unmet: no model credential and no GitHub App
  private key are available in this environment. Per K6/L4 that is the case
  reserved for a pilot-pending verdict.

  (2) The repairs of repair cycle 7 and of its follow-up are unreviewed. Codex
  re-review cycle 6 at 00a6889 (phase-02-final-rereview-codex-v6.md) returned
  REQUEST_CHANGES @ 0.99: HIGH-002, -005, -006, -008, -009 and MED-002, -004,
  -005, -006 PARTIAL, MED-NEW-003 and MED-NEW-004 REGRESSED. Cycle 7 repaired
  all eleven. The controller then raised five more items (cycle-7 follow-up),
  repaired here. The controller's gate run and Codex re-review cycle 7 cover
  863fed0, not the follow-up. Every repair, test and mutation check was
  produced and read by the implementer alone. Under this project's trust
  ordering (machine evidence > independent review > implementer self-review)
  that is not acceptance evidence, which is what the _UNREVIEWED suffix
  records.

  The previous revision of this report said every HIGH and MEDIUM finding was
  closed. Cycle 6 showed that was false. This revision states the gate results
  observed in this cycle and the status of each finding, and nothing else as
  verified.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: base = `git merge-base main HEAD`.
  last_reviewed_head: 00a6889 (Codex re-review cycle 6)
  under_review: 863fed0 (controller gate run and Codex re-review cycle 7, in progress)
  implementation_head_sha: dec962bd2e50b1522eefd6128ba8d784bd65f51e
  head_binding: >-
    implementation_head_sha is the last implementation commit of the cycle-7
    follow-up (`git rev-parse dec962bd2e50b1522eefd6128ba8d784bd65f51e`). The commits after
    it change documentation only. A commit cannot contain its own hash, so the
    true HEAD is bound outside this file (exit L1): the gitignored
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
  observed_at: implementation_head_sha, from a clean tree
  install: "pnpm install --frozen-lockfile — exit 0"
  verify_all: "pnpm verify:all — PASS, exit 0, all 14 steps: format:check, cold-cache reset, typecheck, test, contracts test (80/80), policy test (35/35), contracts compat (13 schemas), forbidden-imports (14/14), project-references (5/5), scan:secret, scan:large-file, scan:pii, check:publication, clean-tree"
  canonical_tests: "677 tests, 677 pass, 0 fail, 0 skipped, across 56 test files; 34 required suite markers verified by scripts/run-canonical-tests.mjs"
  integration_gate: "pnpm test:integration — exit 0; 30 tests, 30 pass, across 7 *.itest.ts files on digest-pinned PostgreSQL 17, MinIO and Docker (backends published on 127.0.0.1 only); 7 required suite markers verified; containers torn down; afterwards no container labelled asep.role and no network labelled asep.attempt remained"
  live_proofs: >-
    `pnpm test:live:claude` is opt-in and outside both gates. Its CONFORMANCE
    test ran at implementation_head_sha (with `ASEP_CLAUDE_CONFORMANCE_CLI` set
    to the host's Claude CLI 2.1.286: real CLI, real provider and egress proxy,
    fake docker client, fake model API) and passed: 1 pass, 1 skipped, 0 fail.
    Its LIVE test (real model API) was skipped: no credential.
  mutation_checks: >-
    Run by the implementer for each HIGH repaired in cycle 7, for MED-004, and
    for every follow-up item; mutants and outcomes are listed per finding in
    phase-02-review-log.md ("Final review cycle 6 dispositions", "Cycle 7
    follow-up dispositions").

findings_cycle_6:
  note: >-
    Status after repair cycle 7, as assessed by the implementer. Details, tests
    and residual concerns per finding: phase-02-review-log.md, "Final review
    cycle 6 dispositions".
  resolved_at_cycle_6_no_action: [HIGH-001, HIGH-003, HIGH-004, HIGH-007, MED-001, MED-003, MED-NEW-001, MED-NEW-002, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST]
  repaired_unreviewed:
    HIGH-002: "37956ac, ab580a6 — waivers removed from every public surface; TypeScript-checker guard on isolation claims"
    HIGH-005: "31aeca7 — migration 0013: typed, NOT NULL, FK-bound side-effect identity; closed outcome shape"
    HIGH-006: "c11078e — migration 0014: fenced lease takeover; resume use case"
    HIGH-008: "ab580a6 — contained real CLI with restricted egress and a proxy-held credential; LIVE not run"
    HIGH-009: "a52f6fa, 0d23b31 — verifier re-hashes evidence bytes, checks the live PR head through the forge port, and binds the signed authorization to attempt, result and PR"
    MED-002: "d5b2edd — bounded re-mint for resolveRef"
    MED-004: "c7f7e59 — membership use case; typed persistence-call and port-call rules for composition roots"
    MED-005: "this report and the L1 sentinel"
    MED-006: "5981089 — faults 3 and 5 injected into a real pipeline run"
    MED-NEW-003: "5e171a3 — fail-closed cold-cache reset"
    MED-NEW-004: "367395b — PII scan covers git author and committer metadata"
  found_during_repair:
    - "a52f6fa — the workflow never recorded the agent's provider id, so the verifier would have refused every genuine run"
    - "0d23b31 — the forge binding resolver required a local repository for PR lookups"
    - "a73ddb6 — many PGlite instances per process intermittently aborted V8"

cycle7_followup:
  note: >-
    Raised by the controller after the cycle-7 report; repaired, unreviewed.
    Details, tests, mutation checks and residuals per item:
    phase-02-review-log.md, "Cycle 7 follow-up dispositions".
  repaired_unreviewed:
    item_1_gate_loopback: "ec280f8 — every integration-gate publish and every compose port binds 127.0.0.1; refused otherwise before docker runs"
    item_2_container_lifetime: "dec962b — agent, egress-proxy and verification containers named and labelled per attempt, stopped by name on timeout/abort, removed by name when their client ends, swept by label and shown gone; a leftover fails closed"
    item_3_attribution: "applied — no AI attribution lines in commits from ec280f8 on"
    item_4_positive_provider: "d5e4bb3 — the verifier accepts only the real Claude adapter's id for the pinned model and CLI, with the invocation manifest, CLI event stream and egress log that adapter records for the attempt"
    item_5_lease_fk: "7d1b4df — migration 0015: composite lease → attempt FK, tenant- and binding-scoped"
    item_6_runner_timeout: "dec962b — same fix as item 2"

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
  F_runner_sandbox: "asep-suite:command-runner; real Docker: asep-suite:sandbox-exec. The governed path refuses a sandbox that does not claim isolation; there is no waiver."
  G_claude_adapter: "asep-suite:agent-claude, asep-suite:agent-sandbox; live run not performed"
  H_forge: "asep-suite:github-app, asep-suite:forge-port-adapter"
  I_review_state: "asep-suite:governed-execution, asep-suite:vertical-integration"
  J_observability: "asep-suite:observability-spans, asep-suite:observability-audit; spans on the real path: asep-suite:vertical-slice-real"
  K1_K3_K4: "asep-suite:vertical-slice-real (real PostgreSQL and Docker), asep-suite:gate-fail-closed, asep-suite:integration-gate"
  K2: NOT MET — no live task run
  K5: "NOT MET — verifier exercised by asep-suite:pilot-manifest, asep-suite:authority-resolver-sql, asep-suite:pilot-verifier; no pilot manifest exists"
  K6: NOT MET — pilot pending
  L1: "this report; sentinel written last (see head_binding)"
  L2: "every cycle-6 HIGH has a recorded disposition; independent confirmation outstanding"
  L3: "not applicable — .task-complete is not created for a pilot-pending verdict"
  L4: ".phase-02-implementation-complete only"
  M: "phase-02-pilot-runbook.md; phase-02-pilot-rehearsal.md; asep-suite:pilot-rehearsal, asep-suite:pilot-faults"

commits_this_cycle:
  - ae3ac32 docs(phase-2) record Codex re-review cycle 6 — REQUEST_CHANGES at 00a6889
  - 5e171a3 fix(gate) make the cold-cache reset fail closed (MED-NEW-003)
  - 367395b fix(pii) scan git author and committer metadata (MED-NEW-004)
  - d5b2edd fix(forge) give resolveRef the same bounded credential recovery as every op (MED-002)
  - 31aeca7 fix(persistence) make side-effect records DB-coherent with a closed outcome shape (HIGH-005)
  - 94504b2 style drop finding codes from new comments and test names
  - c11078e fix(recovery) fenced lease takeover so a successor can finish a crashed attempt (HIGH-006)
  - ab580a6 feat(agent) run the real Claude CLI contained, with restricted egress and a proxy-held credential (HIGH-008)
  - 37956ac fix(sandbox) remove the isolation waivers and guard isolation claims with the TypeScript checker (HIGH-002)
  - c7f7e59 fix(arch) route project membership through a use case and catch every persistence call in a root by type (MED-004)
  - a73ddb6 fix(persistence) compile the PGlite wasm modules once per process
  - a52f6fa fix(pilot) verify evidence bytes, the live PR head and what the signature binds (HIGH-009)
  - 0d23b31 fix(forge) resolve the local repository only when a push needs it (HIGH-009)
  - 5981089 test(rehearsal) inject the object-store outage and the GitHub rate limit into the governed pipeline (MED-006)
  - 863fed0 docs(phase-2) report only what the gates observed, and record cycle-6 dispositions (MED-005)
  followup:
    - ec280f8 fix(gate) publish integration backends on the loopback interface only
    - 7d1b4df fix(persistence) bind every workspace lease to a real attempt of its own tenant and binding
    - d5e4bb3 fix(pilot) accept only a run of the real Claude adapter under the pilot's pins
    - dec962b fix(sandbox) remove every container by its identity however its docker client ends
  earlier_history: "`git log fc0df57..HEAD`"

contract_changes_this_cycle:
  migrations: [0013 side-effect identity and closed outcome, 0014 lease fencing and owned side effects, 0015 lease → attempt composite FK]
  ports: >-
    PullRequestRef.headSha (optional); side-effect log types (SideEffectResultRef,
    parseSideEffectResultRef, typed complete input, LeaseLostError, lease
    fencingEpoch); WorkspaceMount.attemptId (optional, follow-up);
    SandboxRequirement removed from @asep/application.
  adapters: >-
    @asep/agent-claude public surface rewritten (sandbox and provider config,
    ModelCredentialProvider, FileModelCredentialProvider, tool vocabulary,
    stream parser; waiver removed); its artifacts are linked to the attempt and
    its containers carry asep.container (follow-up). @asep/command-runner:
    requirement API removed, optional dockerBinary on DockerSandboxConfig;
    follow-up: sandboxId is `asep-verify-<workspace>-<suffix>`, stop() sweeps
    and may throw, new exports sandboxLabels, dockerCaller, dockerClientEnv,
    removeLabelledContainers, SandboxTeardownError, DockerCall, DockerResult.
    @asep/github-app: PullRequestResult.headSha, lazy localRepoPath in
    SqlForgeBindingResolver.
  application: >-
    projectBelongsToOrganization + ProjectMembershipPort; SliceAttemptPort.create
    takes agentProviderId; resumeAttemptToReview; no sandboxRequirement input.
  apps: >-
    ProductionSeamConfig.claude reshaped (images, credential provider);
    VerticalSliceInput: toolPolicy and objectStoreDir added, sandboxRequirement
    removed; ResumeVerticalSliceInput.objectStoreDir; PilotEnv adds
    ASEP_EGRESS_PROXY_IMAGE_DIGEST, ASEP_ANTHROPIC_API_KEY_FILE,
    ASEP_ANTHROPIC_BASE_URL (optional), ASEP_OBJECT_STORE_DIR.
  pilot_verifier: >-
    createSqlAuthorityResolver requires objects, forge and (follow-up) agent
    pins; the resolver contract adds pinnedAgent and resolveAgentRun;
    createResolverFromEnv requires ASEP_OBJECT_STORE_DIR, the pilot's GitHub App
    settings and (follow-up) ASEP_CLAUDE_MODEL, ASEP_CLAUDE_CLI_VERSION,
    ASEP_AGENT_IMAGE_DIGEST, ASEP_EGRESS_PROXY_IMAGE_DIGEST, optional
    ASEP_ANTHROPIC_BASE_URL (https); pilot-manifest.schema.json pins the
    providerId shape. New export realClaudeProviderId.
  integration_gate: "follow-up: containerRunArgv, loopbackPublish, assertLoopbackPublish, LOOPBACK_HOST in scripts/integration/lib.mjs; compose.yaml ports bound to 127.0.0.1"

known_limitations:
  - "No live run: K2/K5/K6 unmet (no model credential, no GitHub App key)."
  - "Repair cycle 7 and its follow-up are unreviewed (see verdict_note)."
  - "The TypeScript fitness guard is a static net: a value computed at run time, or retyped through an interface a root declares itself, can evade it. The runtime isolation refusal remains the enforcement point."
  - "The agent's model provider is a trusted data channel: the egress proxy limits method, path and origin, not content."
  - "Containers are removed by the harness while it is alive; if the harness process itself dies, its containers run on until the operator sweep (runbook §0.1)."
  - "Crash resume covers attempts whose commit and evidence are durable; others are re-run as new attempts."
  - "The pilot verifier's provider check is positive but rests on artifacts the harness recorded and the configured model origin: whoever can write both the database and the object store could fabricate a run, and nothing attests who answers at that origin."
  - "Fault 5 of the rehearsal pushes to a local bare remote; fault 1 is injected into the provider, not a full pipeline run."
  - "PGlite is a fast-test seam; the real-backend proofs run on PostgreSQL 17 in the integration gate."
  - "No Phase 3+ runtime (Temporal, distributed scheduling, second-model reviewer, Web Console, memory, auto-merge, deploy, K8s/gVisor, enterprise OIDC) by design."

pilot_prerequisites:
  - "PP1: a model credential in a mode-600 file (ASEP_ANTHROPIC_API_KEY_FILE), the digest-pinned agent and egress-proxy images, and `pnpm test:live:claude` LIVE passing with the pilot's configuration (runbook §0.1)."
  - "PP2: the GitHub App installed on the pilot repository with the default branch protected; its private key held by the operator."
  - "PP3: a durable ASEP_OBJECT_STORE_DIR shared by the pilot runs and the verifier, and the verifier run with the pilot's own Claude pins (runbook §0.2)."
  - "PP4: ten genuine R0 tasks run end to end, each with a signed human authorization; the manifest gated by scripts/pilot/verify-pilot-manifest.mjs."
```

## Summary

Phase 2 delivers the single-agent governed vertical slice on
`phase/02-single-agent-vertical-slice`, off `fc0df57`. A task flows from a
work order through risk admission (R0 automated, R1 human-review-gated, R2–R4
refused before any side effect), a leased Git worktree, a Claude agent run in a
container whose only route out is a model-API egress proxy, sandboxed
verification, a harness-owned commit, content-addressed evidence bound to that
commit, a GitHub App that can push only an ASEP-namespaced branch and open a PR,
and lands in `WAITING_FOR_HUMAN_REVIEW`. External side effects are recorded
under fenced leases so a successor can take over a crashed attempt and converge
on one commit, one ref and one PR.

## Where this stands

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED**. Two items
are open: the live pilot has not run (no credentials here), and repair cycle 7
has not been independently reviewed.

Repair cycle 7 addressed every PARTIAL or REGRESSED finding of Codex re-review
cycle 6, and its follow-up the five items the controller raised after it. The
repairs are listed in the YAML above and dispositioned, with their tests,
mutation checks and residual concerns, in `phase-02-review-log.md` ("Final
review cycle 6 dispositions", "Cycle 7 follow-up dispositions"). They are the
implementer's own work and assessment; read them as claims to be checked.

What this cycle observed by machine: from a clean tree at the implementation head, `pnpm install --frozen-lockfile` succeeded; `pnpm verify:all` passed all 14 steps, including 677 canonical tests across 56 files with 34 required suites, the contract, policy and compatibility gates, the fitness suites, the scans and the publication gate; and `pnpm test:integration` passed 30 tests across 7 files against real PostgreSQL, MinIO and Docker. The sentinel is written only after both gates pass again on the report commit.

What it did not observe: a live model run, a push to github.com, a pilot
manifest with ten tasks, or an independent review.

See `phase-02-exit-criteria.md` for the MUST list, `phase-02-pilot-runbook.md`
for operating the pilot and its verifier, and `phase-02-pilot-rehearsal.md` for
the injected faults and the tests behind them.
