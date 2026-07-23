# Phase 2 — Exit Criteria (LOCKED, machine-checkable)

> Phase 2 is COMPLETE only when every MUST passes from a clean checkout. Base `e046885`.
> `[ ]` unmet · `[x]` met with evidence in `artifacts/phase-02/`.
> Two verdicts: **COMPLETE** (all incl. 10 genuine pilot tasks) · **IMPLEMENTATION_COMPLETE_PILOT_PENDING** (all except real pilot).
> LOCKED after Codex plan review (`REQUEST_CHANGES` @ 0.98); all findings folded (see `phase-02-review-log.md`). New MUST gates below carry a `disp.` tag to their finding.

## A. Baseline & build integrity (MUST)

- [ ] A1. Phase 1 full gate still passes: `pnpm verify:all` green from clean checkout.
- [ ] A2. `pnpm install --frozen-lockfile` clean.
- [ ] A3. No canonical Phase 1 schema compatibility regression (compat gate green; no WorkOrder break).
- [ ] A4. Working tree clean after full gate; no tracked build artifacts.

## B. Layering & Phase 3 compatibility (MUST)

- [ ] B1. `packages/application` exists; execution use case lives there, not in `workers/*`.
- [ ] B2. `apps/*` and `workers/*` are composition roots only (arch test).
- [ ] B3. Domain/application contain no provider SDK, Fastify, pg, Octokit, AWS, Docker imports (extended forbidden-imports fitness + mutation self-test).
- [ ] B4. The same application use case is callable from CLI/worker and would be callable from a Temporal activity (no worker-only coupling; demonstrated by a second thin caller in tests). Step use cases are individually idempotent and resumable so a Temporal-shaped fake workflow composes them at activity granularity (disp. P2-PLAN-MED-003).
- [ ] B5. Composition-root-only is defined as: no domain decision, persistence query, provider call or workflow sequencing in HTTP handlers; transport parsing, auth hooks, validation and response mapping are allowed. Arch mutation test rejects a seeded SQL/Git/provider/policy call in a handler and accepts a thin route (disp. P2-PLAN-LOW-001).

## B'. Risk admission (MUST) — disp. P2-PLAN-HIGH-001

- [ ] BR1. An explicit Phase 2 risk-admission matrix exists; for any risk whose Phase 1 mandatory approval/verification gates cannot be satisfied by Phase 2 capabilities, execution **fails closed before** workspace creation, agent invocation and push.
- [ ] BR2. Automated pilot completion is restricted to **R0**; **R1** requires a separately recorded human independent-review step satisfying the approval matrix; **R2–R4 are deferred** (not silently downgraded). Table-driven tests over R0–R4 prove unsupported risks stop before side effects.
- [ ] BR3. Phase 1 approval/verification parity tests remain unchanged (no policy weakening).

## C. Persistence & project isolation (MUST)

- [ ] C1. PostgreSQL state survives process restart (integration test).
- [ ] C2. A server-derived `TenantScope`/`AuthContext` is required by every application use case and repository method; a cross-project (IDOR) read AND write test fails closed at the DB boundary (disp. P2-PLAN-HIGH-003).
- [ ] C2b. Hierarchy consistency is DB-enforced by composite unique + composite foreign keys (a task referencing a run/binding from another project is rejected by PostgreSQL, not merely by a row filter). Every child row (attempts, artifacts, command_executions, pull_requests, audit, idempotency) resolves to exactly one organization, project and repository; `pull_requests` declares `repository_binding_id`.
- [ ] C3. Unique active writer/branch lease enforced; concurrent lease attempt fails.
- [ ] C4. State transitions explicit + optimistic-concurrency guarded (conflicting version update rejected).
- [ ] C5. Migrations append-only with checksums; forward migration on clean PG passes; a second no-op re-apply is clean; two concurrent migrators are serialized by a lock; mid-migration failure recovers; an edited applied migration fails before later migrations run (disp. P2-PLAN-MED-006).
- [ ] C6. No provider token or private key stored in plaintext.
- [ ] C7. Every external side effect (commit, exact-ref push, PR upsert) uses a tenant-scoped semantic idempotency key with `PENDING/COMPLETED/FAILED` state + request fingerprint + fencing; fault-injection killing the executor immediately before/after each Git/object/GitHub call and before/after the DB write converges on restart to one commit, one expected remote ref and one PR; reuse of a key with different input fails (disp. P2-PLAN-HIGH-005).

## D. Artifacts (MUST)

- [ ] D1. `artifact-placeholder` removed from all runtime code.
- [ ] D2. Artifacts content-addressed by SHA-256; key not user-supplied path.
- [ ] D3. Read verification detects byte mutation/corruption.
- [ ] D4. Identical bytes deduplicate; object-write failure does not create accepted metadata; metadata failure does not claim success.
- [ ] D5. Raw stdout/stderr stored before any summary/reducer; capture is bounded streaming with recorded byte counts and an explicit truncation/overflow marker; a required check fails closed if complete evidence cannot be persisted; reducers never receive uncaptured output (disp. P2-PLAN-MED-002).
- [ ] D6. Every artifact operation (`put`/`get`/`verify`) requires `TenantScope`; project A cannot read, verify, infer existence of, or attach project B's object; storage keys are tenant/project-namespaced; authoritative references are scoped foreign keys carrying artifact id + expected checksum, not arbitrary JSONB (disp. P2-PLAN-HIGH-004).
- [ ] D7. Object writes are conditional create-only; two concurrent different-byte writes to one key fail; overwrite attempts fail; size + checksum verified before metadata commit and on every read; orphan reconciliation after metadata failure is defined (disp. P2-PLAN-HIGH-004).
- [ ] D8. The canonical `EvidenceBundle.resultSha` equals the final harness commit SHA; evidence artifact id is preallocated (non-content-derived), verification runs against the exact staged tree, the commit carries that id in the `ASEP-Evidence` trailer, and the bundle is serialized/stored before any push; crash between commit and evidence persistence recovers without a second commit (disp. P2-PLAN-HIGH-008).

## E. Workspace / Git (MUST)

- [ ] E1. Real temporary Git worktree isolation tested (not mocked).
- [ ] E2. Base SHA pinned and verified before agent runs.
- [ ] E3. Agent-created commit/ref rejected by harness inspection.
- [ ] E4. Agent receives no GitHub credential (env assertion test).
- [ ] E5. Harness owns the commit; ASEP-Run/Task/Attempt/Evidence trailers present.
- [ ] E6. Path/symlink traversal outside workspace root rejected (`realpath` containment).
- [ ] E7. Cleanup idempotent; failed worktree quarantined, not reused.
- [ ] E8. The untrusted agent runs in a separate sandboxed process (never the harness process) with only worktree working-tree files writable; `.git` indirection, mirror, refs, objects, config, hooks are read-only/omitted; OS-level write attempts from inside the sandbox to any of these fail, and host mirror snapshots stay byte-identical after corruption attempts (disp. P2-PLAN-HIGH-006).
- [ ] E9. Clone/fetch URLs are constructed from validated forge identity, not an arbitrary `remote_url`; `file://`, `ext::`, ssh, local paths, userinfo, newline/option injection, malicious `insteadOf`/`GIT_CONFIG*`/askpass and hostile submodules are rejected; only the configured GitHub HTTPS host + exact repo identity is allowed; submodule policy is fail-closed (disp. P2-PLAN-HIGH-007).

## F. Command runner & sandbox (MUST)

- [ ] F1. Verification commands are executable+argv with `shell:false`; no model-generated shell string.
- [ ] F2. Exact exit code/signal preserved (no swallowing 1→success).
- [ ] F3. Timeout kills the whole process group; cancellation via AbortSignal works.
- [ ] F4. `verification-no-network` profile has OS-enforced no network (canary test attempts and fails).
- [ ] F5. No Docker socket mounted; image pinned by digest; CPU/mem/PID limits + cap drop + no-new-privileges set.
- [ ] F6. If the environment cannot enforce isolation, the adapter is labelled pilot-only in code and report (no false "production sandbox" claim).

## G. Claude adapter (MUST)

- [ ] G1. Behind `CodingAgentProvider`; model + SDK/CLI version pinned.
- [ ] G2. Structured JSON/stream events parsed (no prose scraping); malformed/partial events fail closed.
- [ ] G3. Max turns, timeout, cancellation, explicit tool permission profile, sanitized env allowlist; no dangerous permission bypass.
- [ ] G4. Context-pack + work-order hashes recorded; provider events captured as artifacts.
- [ ] G5. Adapter cannot commit, push, self-approve, or hold a GitHub credential; `execute()` takes the request-scoped `AgentExecuteRequest` (harness-owned attemptId, opaque workspace, budget, tool/network policy, AbortSignal) and returns only an untrusted `AgentAttemptObservation` — no attemptId/resultSha/changedFiles from the provider; concurrent attempts through one adapter instance show no state crossover (disp. P2-PLAN-HIGH-002).
- [ ] G6. Fake-executable contract tests in CI (malformed JSON, partial stream, timeout, cancel, non-zero exit, quota error, permission denial, attempted commit/push). Live test opt-in, skips cleanly without credentials.

## H. Forge / GitHub App (MUST)

- [ ] H1. GitHub App used, not PAT; private key held by controller/credential provider, never in workspace/log/artifact.
- [ ] H2. Installation token scoped to the exact repository + minimum permissions; token treated as opaque (no length assumption); minted JIT per bounded operation, never persisted; auth-expiry re-mint reconciles without replaying a completed side effect; fake-clock tests cover expiry before/during push+PR, revocation, rotation (disp. P2-PLAN-MED-005).
- [ ] H3. **RefSafetyPolicy non-bypassable (disp. P2-PLAN-CRIT-001):** real bare-remote tests reject `main`/`master`/`HEAD`/tag/deletion/malformed/option-like/force targets; a transport test proves only the ASEP-namespaced ref is ever sent; the live pilot records the active branch-protection ruleset and shows the token cannot update or merge the default branch.
- [ ] H4. Branch push only after verification; PR create/update idempotent (find-by-head-branch upsert).
- [ ] H5. No merge capability/method exists anywhere in Phase 2 code.
- [ ] H6. Adapter tested against mock HTTP / SDK transport boundary (not mocked application logic).
- [ ] H7. `remote_url` is never accepted raw: clone/fetch URLs constructed from validated forge identity; real Git tests reject `file://`/`ext::`/ssh/local-path/userinfo/newline/option-injection/malicious-config/hostile-submodule; only the configured GitHub HTTPS host + exact repository identity allowed; `GIT_CONFIG*`/SSH/askpass/proxy env sanitized (disp. P2-PLAN-HIGH-007).
- [ ] H8. Inbound webhooks are DEFERRED: no webhook route, secret, or dependency exists in Phase 2 (disp. P2-PLAN-MED-004).

## I. Review state (MUST)

- [ ] I1. After verification + PR, task → `WAITING_FOR_HUMAN_REVIEW`.
- [ ] I2. Machine verification cannot transition directly to ACCEPTED when human review is required.
- [ ] I3. No second-model runtime reviewer implemented (Phase 4 scope); Codex confirms.
- [ ] I4. **Risk-admission matrix (disp. P2-PLAN-HIGH-001):** table-driven tests over R0–R4 prove any risk whose Phase-1 mandatory approval/verification gates cannot be satisfied fails closed **before** workspace creation, agent invocation and push. Automated pilot completion is restricted to R0; R1 requires a separately recorded human independent-review step; R2–R4 are deferred, not overridden. Phase 1 policy-parity tests remain unchanged.

## J. Observability & audit (MUST)

- [ ] J1. Spans present: task.execute, context.build, workspace.lease, workspace.create, agent.invoke, command.execute, artifact.put, git.commit, forge.push, forge.pull_request.
- [ ] J2. Every span/event carries org/project/repository/run/task/attempt IDs. **(disp. P2-PLAN-HIGH-010)** Because `run-event/v1` has no `organizationId`/`repositoryBindingId`, these are added as **optional** fields via a minor bump `run-event/v1.1.0` (additive-safe per COMPATIBILITY.md; compat gate proves non-breaking). Every emitted RunEvent validates against its declared schema version.
- [ ] J3. Full source/prompt/raw tool output off by default (opt-in + redaction documented).
- [ ] J4. Privileged operations audited.
- [ ] J5. **ExecutionEnvelope is a canonical versioned contract (disp. P2-PLAN-HIGH-010):** published as `execution-envelope/v1` JSON Schema with generated TS type, AJV validator, valid+invalid fixtures, snapshot and compatibility governance (same regime as the 12 Phase-1 contracts). Boundary tests reject malformed/unknown envelope versions; persisted envelopes round-trip without provider types.

## K. Integration & pilot (MUST)

- [ ] K1. Full vertical integration test: real PG + real temp Git + real worktree + real artifact + real runner + fake Claude + fake GitHub — passes. A fully mocked test is NOT called "end to end".
- [ ] K2. ≥1 opt-in live pilot task succeeds (real Claude + real GitHub App, one real PR, no merge) before claiming live integration.
- [ ] K3. Full traceability: PR → evidence → attempt → task → run → project → repository.
- [ ] K4. **Mandatory integration CI gate (disp. P2-PLAN-HIGH-009):** `verify:all` + CI provision digest-pinned PostgreSQL, object storage (MinIO) and the verification sandbox, wait for health, and **fail rather than skip** if unavailable. Machine-readable suite IDs registered for tenancy, migration, artifact, Git and sandbox critical suites (same mechanism as Phase-1 `SUITE-ID`); a CI-config test proves each required marker is enforced and that deliberately-unavailable PG/object-store/Docker turns the required job red. Only live Claude/GitHub tests remain opt-in.
- [ ] K5. **Ten genuine pilot tasks defined (disp. P2-PLAN-MED-001):** a completed pilot task is a **distinct, human-authorized WorkOrder** run through real Claude + real sandbox + real GitHub App + real persistence, reaching `WAITING_FOR_HUMAN_REVIEW` with a valid PR/evidence chain. Retries are attempts under one task and do NOT increase the count. A machine-readable pilot manifest lists ten distinct task IDs, objectives, risks, base+result SHAs, provider sessions, PRs, evidence checksums and human dispositions; a verifier rejects duplicate tasks, fake adapters, failed traces and retry inflation.
- [ ] K6. Ten genuine low-risk pilot tasks for `COMPLETE`; if unavailable → `IMPLEMENTATION_COMPLETE_PILOT_PENDING`, not `COMPLETE`.

## L. Completion protocol (MUST)

- [ ] L1. `phase-02-report.md` present; report head SHA == `git rev-parse HEAD`.
- [ ] L2. No unresolved CRITICAL/HIGH from Codex final review (or recorded disposition).
- [ ] L3. `.task-complete` created last, only after report + evidence + green gate + clean tree + honest verdict.
- [ ] L4. `IMPLEMENTATION_COMPLETE_PILOT_PENDING` may create `.phase-02-implementation-complete` but NOT the final phase sentinel.

## M. Operational readiness (MUST — disp. P2-PLAN-MED-007)

- [ ] M1. Pilot runbook present: metrics/dashboard requirements, alert/observation thresholds, and explicit stop/rollback conditions.
- [ ] M2. Outage-recovery procedures documented for artifact-store, DB and GitHub outages, plus stale-lease recovery and retention/cleanup.
- [ ] M3. A preserved pilot rehearsal covers provider timeout, DB restart, object-store outage, stale lease and GitHub rate limiting, and shows the runbook leads to the documented stop/recovery decision.

## Not Phase 2 exit (carried to later phases)

- Temporal durability, distributed scheduling, second-model reviewer runtime, Web Console, memory systems, auto-merge, production deploy, K8s/gVisor, full enterprise OIDC.
