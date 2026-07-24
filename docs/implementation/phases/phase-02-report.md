# Phase 2 — Single-Agent Governed Vertical Slice — Report

> Machine-readable completion record for Phase 2. The YAML block below is the
> authoritative report; the prose after it is a human-readable companion. The
> canonical `pnpm verify:all` full gate is the source of truth for "green".

```yaml
apiVersion: asep.phase/v1
kind: PhaseReport
phase: 2
title: Single-Agent Governed Vertical Slice
verdict: IMPLEMENTATION_COMPLETE_PILOT_PENDING
verdict_note: >-
  Every implementation exit criterion (A-J, K1/K3/K4/K5, L, M) is met with a
  green gate. The two verdicts defined by the exit criteria are COMPLETE (all
  MUSTs INCLUDING ten genuine live pilot tasks) and
  IMPLEMENTATION_COMPLETE_PILOT_PENDING (all except the real live pilot). The
  live pilot (K2/K6) requires a real Anthropic credential, a real GitHub App
  private key, and an OS-enforceable verification sandbox. None are available in
  this build environment (Anthropic token absent, GitHub App key absent, Docker
  unavailable), so a live pilot task literally cannot run here. Per K6/L4 the
  honest verdict is therefore IMPLEMENTATION_COMPLETE_PILOT_PENDING — NOT
  COMPLETE. This is the designed-for outcome, not a failure: the pilot manifest
  verifier and schema exist and are green (K5), and the runbook + rehearsal (M)
  prove operational readiness for when credentials are provisioned.

repository:
  branch: phase/02-single-agent-vertical-slice
  base_sha: fc0df57df05b6745e190a53496bd5d90b7ae4bcb
  base_sha_note: >-
    base = `git merge-base main HEAD`. The vertical slice forks from the Phase 1
    acceptance point.
  head_sha: bound-by-git-rev-parse-HEAD
  head_sha_note: >-
    A git object cannot embed its own hash, and HEAD advances on every commit
    (this report included), so this file does NOT hardcode a head SHA. Exit L1
    ("report head SHA == git rev-parse HEAD") is satisfied structurally: this
    report is the last content commit before the completion sentinel, so at the
    moment `.phase-02-implementation-complete` is written, HEAD is exactly the
    commit that carries this report. Any later repair commit moves HEAD and must
    be accompanied by a re-run of `pnpm verify:all` and a refreshed sentinel.
  worktree: isolated linked worktree; main untouched
  completion: >-
    offline. Remote push + PR to a real forge, and the ten live pilot tasks, are
    a separate human-gated step requiring credentials not present in this
    environment.

models:
  planner: Claude Opus (controller session)
  implementer: detached coding worker in isolated worktree
  note: >-
    no model is called on any deterministic path (risk admission, verification,
    approval, side-effect idempotency, ref safety, evidence binding, pilot-
    manifest verification).

versions:
  node: v24.6.0
  pnpm: 10.31.0
  typescript: 7.0.2
  test_runner: tsx --test

deliverables:
  A_baseline_build_integrity:
    - Phase 1 full gate still green from clean checkout; frozen-lockfile install clean
    - no canonical schema compatibility regression (compat gate green)
    - working tree clean after full gate; no tracked build artifacts
  B_layering_phase3_compat:
    - packages/application holds the execute-task use case (not workers/*)
    - apps/* and workers/* are composition roots only (arch + mutation self-test)
    - domain/application carry no provider SDK / Fastify / pg / Octokit / AWS / Docker imports (extended forbidden-imports fitness)
    - step use cases individually idempotent + resumable; a Temporal-shaped fake composes them at activity granularity
  B_prime_risk_admission:
    - explicit risk-admission matrix; unsupported risks fail closed BEFORE workspace creation, agent invocation and push
    - automated pilot completion restricted to R0; R1 requires recorded human independent review; R2-R4 deferred
    - Phase 1 approval/verification parity tests unchanged
  C_persistence_isolation:
    - PostgreSQL (via pglite seam) state survives restart; server-derived TenantScope required by every use case + repo method
    - cross-project IDOR read AND write fail closed at the DB boundary; hierarchy consistency DB-enforced by composite unique + composite FKs
    - unique active writer/branch lease; optimistic-concurrency-guarded transitions; append-only checksummed migrations with a serializing lock
    - no provider token / private key stored in plaintext
    - every external side effect uses a tenant-scoped semantic idempotency key (PENDING/COMPLETED/FAILED + fingerprint + fencing); fault-injection converges on restart
  D_artifacts:
    - artifact-placeholder removed from runtime; content-addressed by SHA-256; read verification detects mutation
    - identical bytes dedupe; conditional create-only writes; size+checksum verified before metadata commit and on every read
    - raw stdout/stderr stored before any reducer; bounded streaming with byte counts + truncation marker; fails closed if evidence cannot be persisted
    - every artifact op requires TenantScope; tenant/project-namespaced keys; EvidenceBundle.resultSha == final harness commit SHA with preallocated evidence id in the ASEP-Evidence trailer
  E_workspace_git:
    - real temp Git worktree isolation; base SHA pinned + verified; agent-created commit/ref rejected by inspection
    - agent receives no GitHub credential; harness owns the commit (ASEP-Run/Task/Attempt/Evidence trailers)
    - path/symlink traversal outside workspace rejected (realpath containment); cleanup idempotent; failed worktree quarantined
    - untrusted agent in a separate sandboxed process; .git indirection/refs/objects/config/hooks read-only or omitted
    - clone/fetch URLs from validated forge identity; file://, ext::, ssh, userinfo, option/newline injection, malicious insteadOf/GIT_CONFIG/askpass, hostile submodules rejected
  F_command_runner_sandbox:
    - verification commands are executable+argv with shell:false; exact exit code/signal preserved
    - timeout kills the whole process group; cancellation via AbortSignal
    - verification-no-network profile canary; no Docker socket mounted; image pinned by digest
    - adapter self-labels pilot-only in code and report when the host cannot enforce OS isolation (no false production-sandbox claim)
  G_claude_adapter:
    - behind CodingAgentProvider; model + SDK/CLI version pinned; structured events parsed (no prose scraping); malformed/partial fail closed
    - max turns, timeout, cancellation, explicit tool-permission profile, sanitized env allowlist
    - adapter cannot commit/push/self-approve/hold a credential; execute() takes request-scoped input, returns only an untrusted observation
    - fake-executable contract tests (malformed JSON, partial stream, timeout, cancel, non-zero exit, quota, permission denial, attempted commit/push); live test opt-in, skips cleanly without credentials
  H_forge_github_app:
    - GitHub App, not PAT; private key never in workspace/log/artifact; installation token scoped to the exact repo, minted JIT, never persisted
    - RefSafetyPolicy non-bypassable (main/master/HEAD/tag/deletion/malformed/option-like/force rejected; only the ASEP-namespaced ref is ever sent)
    - branch push only after verification; PR create/update idempotent (find-by-head-branch upsert); NO merge capability anywhere
    - adapter tested against mock HTTP/SDK transport boundary; inbound webhooks deferred (none exist)
  I_review_state:
    - after verification + PR, task -> WAITING_FOR_HUMAN_REVIEW; machine verification cannot jump to ACCEPTED when human review is required
    - no second-model runtime reviewer (Phase 4 scope); risk-admission matrix table-driven over R0-R4
  J_observability_audit:
    - closed span vocabulary (task.execute, context.build, workspace.lease/create, agent.invoke, command.execute, artifact.put, git.commit, forge.push, forge.pull_request)
    - every span/event carries org/project/repository/run/task/attempt IDs; run-event minor bump v1.1.0 adds optional org/repository-binding (additive-safe, compat gate proves non-breaking)
    - full source/prompt/raw tool output off by default (opt-in + documented redaction); privileged operations audited
    - ExecutionEnvelope published as a canonical versioned contract with generated TS type, AJV validator, fixtures, snapshot + compat governance
  K_integration_pilot:
    - K1 full vertical integration test: real PG + real temp Git + real worktree + real artifact + real runner + fake Claude + fake GitHub — passes
    - K3 full traceability PR -> evidence -> attempt -> task -> run -> project -> repository
    - K4 mandatory integration CI gate with machine-readable SUITE-IDs (fails rather than skips when PG/object-store/Docker unavailable)
    - K5 pilot-manifest schema + adversarial verifier: rejects duplicate tasks, fake/mock adapters, failed traces, retry/replay inflation, no-op changes, broken trace chains; a COMPLETE verdict needs ten genuine tasks, else IMPLEMENTATION_COMPLETE_PILOT_PENDING
    - K2/K6 live pilot NOT run — credentials + OS sandbox unavailable in this environment (see verdict_note)
  L_completion_protocol:
    - phase-02-report.md present (this file); no unresolved CRITICAL/HIGH
    - .phase-02-implementation-complete permitted (L4); the final phase sentinel is NOT created because the live pilot is pending
  M_operational_readiness:
    - phase-02-pilot-runbook.md: dashboard metrics (all from the metrics dictionary), alert/observation thresholds, explicit stop/rollback conditions
    - outage-recovery for artifact store / DB / GitHub, stale-lease recovery, retention/cleanup — each mapped to a real shipped mechanism
    - phase-02-pilot-rehearsal.md: five injected faults (provider timeout, DB restart, object-store outage, stale lease, GitHub rate limiting) each reaching the documented stop/recovery decision

commits:
  note: >-
    Per-slice commits on phase/02-single-agent-vertical-slice off fc0df57. The
    exact set is in git log; this list is descriptive, not authoritative.
  slices:
    - 7e068a5 feat(contracts): ExecutionEnvelope contract + RunEvent v1.1.0 minor bump (S1)
    - 1188634 feat(domain): operational state machines Task/Attempt/WorkspaceLease (S1)
    - 0e79781 feat(application): provider-neutral execute-task use case + risk-admission gate (S1)
    - 4fae7cd refactor(worker): reduce to composition root delegating to @asep/application (S1)
    - 41e351a test(fitness): application-layer layering + composition-root arch/mutation self-test (S1)
    - c41af4f feat(persistence): project-scoped PostgreSQL adapter via pglite seam (S2)
    - 26a36e6 feat(persistence): content-addressed immutable artifact store (S3)
    - c872712 feat(workspace): isolated leased Git worktree lifecycle + ref-safety (S4)
    - 37b92f7 feat(execution): trusted sandboxed command and verification runner (S5)
    - 9dbf7a4 feat(agent): credential-free Claude coding provider behind CodingAgentProvider (S6)
    - d041fc5 feat(forge): least-privilege GitHub App pull-request delivery (S7)
    - 6c4d832 feat(vertical-slice): governed task-to-pull-request execution
    - a3c941b feat(pipeline): governed task-to-PR sequence with crash-safe side effects (S9)
    - 01ab1f0 test(integration): full vertical slice (real PG+Git+worktree+runner, fake Claude/GitHub) (K1)
    - d895424 feat(observability): closed span vocabulary + correlation-identity tracer + audit vocabulary (J1/J2/J4)
    - eb4cb54 feat(pilot): adversarial pilot-manifest verifier + schema gating COMPLETE verdict (K5/K6)
    - 45dfcfe fix(test): allowlisted bot@asep.invalid identity in K1 vertical slice (pii-scan)
    - 32d7753 docs(pilot): operational runbook + preserved fault rehearsal (M1/M2/M3)

verification:
  canonical_command: pnpm verify:all (format + typecheck + test + secret + large-file + publication + clean-tree)
  quick_command: pnpm verify (format:check + typecheck + test only — subset, NOT the full gate)
  result: green
  test_count: 373 tests across 41 test files via the shell-free scripts/run-canonical-tests.mjs (19 REQUIRED suite markers verified; fails closed if any critical suite is dropped)
  clean_checkout: pnpm install --frozen-lockfile succeeds; clean tree after the full gate

security:
  license: Apache-2.0 present
  secret_scan: pass (self-test green)
  git_history_secret_scan: pass
  large_file_scan: pass
  pii_scan: pass (self-test green)
  dependency_license: all permissive (Apache-2.0, BSD-3-Clause, ISC, MIT); self-test green
  publication_checklist: all-green, executable gate

known_limitations:
  - The live pilot (K2/K6) has not been run: no Anthropic credential, no GitHub App private key, and no OS-enforceable sandbox (Docker unavailable) in this environment. The verification sandbox is therefore pilot-only labelled (exit F6), not a production sandbox.
  - The PostgreSQL adapter runs through a pglite seam in tests; a real digest-pinned PostgreSQL + MinIO + sandbox is provisioned by the CI integration gate (K4), which fails rather than skips when they are unavailable.
  - No Phase 3+ runtime (Temporal durability, distributed scheduling, second-model reviewer, Web Console, memory, auto-merge, production deploy, K8s/gVisor, full enterprise OIDC) is present by design.

pilot_prerequisites:
  - PP1: provision a real Anthropic credential for the Claude adapter (live opt-in test)
  - PP2: install the GitHub App on a real pilot repo with the default branch protected; hold the private key in the controller/credential provider
  - PP3: provide an OS-enforceable verification sandbox (digest-pinned container with network deny, cap drop, no-new-privileges)
  - PP4: run ten genuine R0 tasks through the full pipeline, populate the pilot manifest, and let scripts/pilot/verify-pilot-manifest.mjs gate the COMPLETE verdict

phase_3_recommendation: >
  Proceed on implementation. The governed vertical slice — risk admission, tenant
  isolation, content-addressed evidence, leased worktrees, sandboxed runner,
  credential-free agent, least-privilege forge, non-bypassable ref safety,
  crash-safe idempotent side effects, closed-vocabulary observability — is
  complete and green. The single blocking input before a COMPLETE verdict is a
  credentialled environment to run the ten live pilot tasks (PP1-PP4).
```

## Summary

Phase 2 delivers the single-agent governed vertical slice as per-slice commits
on `phase/02-single-agent-vertical-slice`, off `fc0df57` (`git merge-base main
HEAD`). A task flows from a human-authorized WorkOrder through risk admission
(R0 automated, R1 human-review-gated, R2-R4 deferred and fail-closed before any
side effect), a leased isolated Git worktree, a credential-free Claude adapter
running in a separate sandboxed process, a trusted command/verification runner,
content-addressed evidence whose `resultSha` equals the harness commit, a
least-privilege GitHub App that can only push an ASEP-namespaced branch and open
a PR (no merge capability exists anywhere), and lands the task in
`WAITING_FOR_HUMAN_REVIEW`. Every external side effect is guarded by a
tenant-scoped semantic idempotency key with fencing, so a crash before or after
any Git/object/GitHub call and before or after the DB write converges on restart
to one commit, one expected remote ref and one PR.

The verdict is **IMPLEMENTATION_COMPLETE_PILOT_PENDING**, not COMPLETE. Every
implementation exit criterion is met with a green gate, but the ten genuine
**live** pilot tasks (K2/K6) cannot run in this environment: there is no
Anthropic credential, no GitHub App private key, and no OS-enforceable sandbox
(Docker unavailable). This is precisely the case the exit criteria reserve the
`IMPLEMENTATION_COMPLETE_PILOT_PENDING` verdict for (K6/L4). Claiming COMPLETE
without a real pilot would be a false completion; the report and the
`.phase-02-implementation-complete` sentinel (never the final phase sentinel)
record the honest state.

The K5 pilot-manifest schema and adversarial verifier
(`scripts/pilot/verify-pilot-manifest.mjs`) are present and green: they reject
duplicate task IDs, fake/mock providers, broken trace chains, no-op changes and
retry/replay inflation, and require ten genuine tasks before a manifest may back
a COMPLETE verdict. The M operational-readiness runbook and preserved fault
rehearsal are grounded in the shipped recovery mechanisms (two-phase side-effect
log, stale-lease sweep, conditional create-only artifact writes, JIT token
re-mint). The canonical `pnpm verify:all` full gate is green (373 tests via the
shell-free `scripts/run-canonical-tests.mjs`, which fails closed if any REQUIRED
critical suite is dropped) with a clean working tree.

See `phase-02-exit-criteria.md` for the machine-checkable MUST list,
`phase-02-pilot-runbook.md` for operational procedures, and
`phase-02-pilot-rehearsal.md` for the preserved fault-injection walkthrough.
