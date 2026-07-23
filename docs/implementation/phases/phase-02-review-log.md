# Phase 2 — Plan Review Disposition Log

> Controller adjudication of the independent Codex plan review (Prompt 3).
> Planner/controller: Claude Opus 4.8. Reviewer: codex `gpt-5.6-sol` (read-only), verdict **REQUEST_CHANGES** @ confidence 0.98.
> Raw review: `phase-02-plan-review-codex-v1.md` (reviewed base `e046885`).
>
> Each finding is dispositioned `ACCEPTED` / `PARTIALLY_ACCEPTED` / `REJECTED_WITH_EVIDENCE`.
> Findings are NOT auto-accepted. Where a finding is rejected, the verification source is stated (per `.claude/rules/review-audit-self-decision.md`).

## Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| CRITICAL | 1 | 1 | 0 | 0 |
| HIGH | 10 | 10 | 0 | 0 |
| MEDIUM | 8 | 8 | 0 | 0 |
| LOW | 1 | 1 | 0 | 0 |
| **Total** | **20** | **20** | **0** | **0** |

No finding was rejected. The review correctly cross-referenced real committed code (`packages/contracts/src/base.ts`, `packages/ports/src/index.ts`, `run-event.schema.json`, `approval-matrix.yaml`, `verification-matrix.yaml`, `scripts/verify-all.sh`) and the locked Phase 1 policy. Several findings identified contradictions in the v1 plan that I could not defend (as-is `CodingAgentProvider` reuse; ExecutionEnvelope called "versioned" without a schema; the runtime-reviewer gap vs. locked R1+ policy). The plan is materially strengthened by all 20.

---

## CRITICAL

### P2-PLAN-CRIT-001 — ForgeProvider can push to a protected/default ref — ACCEPTED
**Concern:** `ForgeProvider` accepts an arbitrary branch and the App holds `Contents:write`; nothing forbids pushing a verified commit straight to `main`, bypassing the PR-only/no-merge boundary.
**Disposition:** ACCEPTED. Real gap. The v1 plan asserted "no merge" but never made a direct default-ref push *impossible by construction*.
**Locked change:** Introduce a non-bypassable `RefSafetyPolicy` in the forge adapter and the application push step:
- Branches are generated under an ASEP-owned namespace (`asep/run/<runId>/attempt/<attemptId>`).
- `head` MUST differ from the configured default/protected refs; reject `HEAD`, tags, `main`/`master`.
- Validate with `git check-ref-format`.
- Allow only an exact `create`/`update` refspec; prohibit deletion and force, except `--force-with-lease` against a recorded expected SHA.
- Pilot repository MUST carry a ruleset denying direct default-branch writes and App merges.
**Validation:** bare-remote tests reject `main`/`master`/`HEAD`/tag/deletion/malformed/option-like/force targets; GitHub transport test proves only the namespaced ref is sent; live pilot records the active branch-protection ruleset and shows the installation token cannot update or merge the default branch.

---

## HIGH

### P2-PLAN-HIGH-001 — Runtime reviewer removed but locked policy requires R1+ review — ACCEPTED
**Concern:** Phase 2 excludes a runtime independent reviewer, yet `approval-matrix.yaml` requires 1 reviewer for R1 and `verification-matrix.yaml` requires L8 (independent review) for R2+. No admission ceiling → higher-risk work could push while mandatory assurance is missing, or the slice becomes impossible without silently weakening policy.
**Disposition:** ACCEPTED. This is the single most important correctness gap: it protects the locked Phase 1 policy from silent erosion.
**Locked change:** Define an explicit **Phase 2 risk-admission matrix**. Fail closed *before agent invocation* for any risk whose current mandatory gates cannot be satisfied. Automated pilot completion is restricted to **R0**; **R1** requires a separately-recorded human independent-review step that satisfies the L8/reviewer requirement; **R2–R4 are deferred** (not overridden). The Phase 1 `approvalFor`/`requiredLevels`/parity tests remain byte-unchanged.
**Validation:** table-driven tests over R0–R4 prove unsupported risks stop before workspace creation, agent invocation, and push; Phase 1 policy parity tests unchanged; pilot evidence states each task's risk and the gate that satisfied every required approval + assurance level.

### P2-PLAN-HIGH-002 — `CodingAgentProvider` reused as-is is unsafe — ACCEPTED
**Concern:** `execute(order, context)` receives no harness-owned attempt id, no leased workspace handle, no `AbortSignal`, no permission profile, and returns `attemptId`/`resultSha` even though the harness must own identity and commits. Implementing safely would need hidden mutable adapter state or a mid-implementation port rewrite.
**Disposition:** ACCEPTED. The v1 plan's "reused as-is" claim (§12) was wrong; I retract it.
**Locked change:** Redesign the provider-neutral request/result contract **before lock**:
- Request carries: harness-owned `attemptId`, an opaque workspace capability (no raw path), immutable `WorkOrder`/`ContextPack` refs + hashes, budgets, tool/network policy, and `AbortSignal`.
- Result carries **only untrusted attempt observations** (summary, declared status, usage, provider session id). Git state, changed files, and result commit SHA are derived by trusted harness components — never accepted from the provider.
- The legacy `CodingAgentProvider` in `packages/ports` is superseded by this contract; the mock adapter and Claude adapter both implement it.
**Validation:** port contract tests run concurrent attempts through one adapter instance with no state crossover; cancellation + budgets are request-scoped; provider-selected identities/SHAs are rejected; fake and live adapters share one request/result contract.

### P2-PLAN-HIGH-003 — Tenancy columns lack composite constraints (IDOR) — ACCEPTED
**Concern:** Duplicated `organization_id`/`project_id` guarded only by single-column FKs; a task can claim project A while referencing a run/binding from project B and still pass a scoped row filter. No server-derived auth context. `pull_requests` declares a unique index on `repository_binding_id` without declaring the column.
**Disposition:** ACCEPTED.
**Locked change:** Define a `TenantScope`/`AuthContext` sourced from authenticated server state, required by every application use case and repository method. Enforce hierarchy with **composite unique keys + composite foreign keys** (e.g. `runs(project_id, id)` referenced by `tasks(project_id, run_id)`), or drop duplicated scope columns and derive them through constrained parent relationships. Add `repository_binding_id` wherever repository resolution is required (pull_requests, audit, idempotency).
**Validation:** migration tests attempt every mismatched org/project/parent combination and fail at the DB boundary; application + repository tests independently reject IDOR reads/writes; the full-trace query resolves every record to exactly one org/project/repository.

### P2-PLAN-HIGH-004 — ArtifactStore ops not scope-aware / not create-only — ACCEPTED
**Concern:** `get/verify` accept only `ArtifactRef`, so caller project scope cannot be enforced; `storage_key` is digest-derived but not tenant-prefixed; authoritative links are arbitrary JSONB refs; "immutable" S3 lacks conditional-create so bytes can be overwritten or metadata can point at another project's object.
**Disposition:** ACCEPTED.
**Locked change:** Require `TenantScope` on every artifact operation; use tenant/project-prefixed digest keys (`<org>/<project>/sha256/<digest>`); make authoritative references scoped foreign keys carrying artifact id + expected checksum; use conditional create-only object writes (S3 `IfNoneMatch`, fs exclusive create); verify size + checksum before metadata commit and on every read; define orphan reconciliation after a metadata-write failure.
**Validation:** contract tests prove project A cannot read/verify/infer-existence-of/attach project B's object; concurrent different-byte writes to one key fail; overwrite attempts fail; corrupted bytes, checksum/size mismatch, wrong-scope references, and object/metadata failure permutations all fail closed.

### P2-PLAN-HIGH-005 — Result-only idempotency row cannot cover external side effects — ACCEPTED
**Concern:** A `result_ref` row written before/after a Git/GitHub side effect cannot atomically cover it; a crash after push/PR but before recording replays the operation. No request hash, operation state, fencing token, or reconciliation state; uniqueness not tenant-scoped.
**Disposition:** ACCEPTED.
**Locked change:** Specify a **crash-safe side-effect protocol**: tenant-scoped semantic keys, request fingerprints, `PENDING`/`COMPLETED`/`FAILED` state, ownership/fencing token, and remote reconciliation by natural key. Commit creation, exact-ref push, and PR upsert each distinguish retries from new business attempts and recover from crashes on both sides of the external call.
**Validation:** fault-injection terminates the executor immediately before and after each Git/object/GitHub call and before/after the corresponding DB write; restart converges to one commit, one expected remote ref, one PR; reuse of a key with different input fails.

### P2-PLAN-HIGH-006 — Agent `.git` write authority undefined at OS level — ACCEPTED
**Concern:** The plan asserts the agent lacks `.git` write authority but never defines the OS mechanism. A linked worktree has a writable `.git` indirection file; an in-process SDK or host process can overwrite it or reach the shared mirror. Post-execution inspection is detection, not containment.
**Disposition:** ACCEPTED. This upgrades sandbox from "described" to "OS-enforced" — a core Phase 2 safety property.
**Locked change:** Lock the Claude integration surface + execution topology before implementation. Run the untrusted agent in a **separate sandboxed process** with only the intended worktree files writable. Mount the `.git` indirection and all linked-worktree/mirror metadata **read-only**, or omit them and expose safe Git observations through trusted tooling. Do **not** run untrusted agent tools in the harness process.
**Validation:** OS-level tests from inside the agent sandbox fail writes to `.git`, worktree admin files, refs, objects, config, hooks, and the mirror; host snapshots stay byte-identical after corruption attempts; the same tests run through the real Claude adapter boundary.

### P2-PLAN-HIGH-007 — Unconstrained `remote_url` enables Git transport abuse — ACCEPTED
**Concern:** `repository_bindings.remote_url` is unconstrained and used by trusted Git ops. Git accepts `file`, `ssh`, `ext::` helpers, local paths, option-like values, submodule URLs, and repo-controlled config → host file access, command execution, SSRF, or credential leak without a shell.
**Disposition:** ACCEPTED.
**Locked change:** Construct clone/fetch URLs from **validated forge identity** (owner/repo), not an arbitrary transport URL. Allow only configured GitHub HTTPS hosts; reject userinfo and non-HTTPS/local/`ext`/`ssh` protocols; terminate option parsing (`--`); sanitize `GIT_CONFIG*`/`SSH*`/askpass/proxy env; disable unapproved protocols + hooks (`protocol.*.allow`, `core.hooksPath=/dev/null`); fail-closed submodule policy.
**Validation:** real Git tests reject `file://`, `ext::`, ssh, local paths, userinfo, newline/option injection, malicious `insteadOf`/config/askpass, and hostile submodules; allow only the configured host + exact repo identity.

### P2-PLAN-HIGH-008 — EvidenceBundle built before harness commit → circular resultSha — ACCEPTED
**Concern:** The sequence builds the canonical `EvidenceBundle` before the harness commit, but `resultSha` should be the harness commit SHA and the commit must contain an `ASEP-Evidence` trailer → circularity or a pre-commit/provider SHA recorded.
**Disposition:** ACCEPTED.
**Locked change:** Define `resultSha` = the **final harness commit SHA**. Preallocate a non-content-derived evidence artifact id; run verification against the exact staged tree; commit with that stable id in the `ASEP-Evidence` trailer; then serialize + store the final bundle (containing the resulting commit SHA) **before any push**. Define recovery for a commit created before evidence persistence.
**Validation:** integration test reconstructs commit-trailer → evidence-artifact; `EvidenceBundle.resultSha` equals the pushed commit; diff + checks correspond to that commit's tree; recovery without a second commit after crashes at each boundary.

### P2-PLAN-HIGH-009 — Real PG/MinIO/sandbox suites not mandatory in CI — ACCEPTED
**Concern:** Required PostgreSQL/MinIO/OS-sandbox tests have no mandatory CI environment or required-suite marker; current CI provisions none; the risk register permits Docker tests to skip → CI can pass while persistence/artifact/sandbox semantics never execute.
**Disposition:** ACCEPTED. Without this, every other HIGH's "validation" is unenforced.
**Locked change:** Add a **mandatory Phase 2 integration gate** to `verify-all.sh` + CI that provisions digest-pinned PostgreSQL + object storage + the verification sandbox, waits for health, and **fails rather than skips**. Register machine-readable suite IDs (`asep-suite:tenancy`, `:migration`, `:artifact`, `:git-worktree`, `:sandbox`) enforced by the canonical runner (same mechanism as Phase 1 `asep-suite:forbidden-imports`). Only live Claude/GitHub tests remain opt-in.
**Validation:** CI-config tests prove each required suite marker is enforced; deliberately unavailable PG/object-store/Docker makes the required job red; a clean CI run reports executed real-backend test counts + no-network canary evidence.

### P2-PLAN-HIGH-010 — ExecutionEnvelope not a real contract; RunEvent lacks org/repo fields — ACCEPTED
**Concern:** `ExecutionEnvelope` is called "versioned" but is only a TS sketch (no schema/validator/fixtures/compat/snapshot). Separately, exit criterion J2 requires every event to carry org + repository IDs, but the closed `RunEvent/v1` schema has neither → implementation must make unplanned canonical changes or emit invalid events.
**Disposition:** ACCEPTED. The v1 plan overstated ExecutionEnvelope's status.
**Locked change:** ExecutionEnvelope crosses API/CLI/worker/persistence and future Temporal boundaries → publish a **canonical JSON Schema** (`https://asep.dev/schema/execution-envelope/v1`) with generated type, AJV validation, fixtures, snapshot, and compatibility governance (same pipeline as the 12 Phase 1 contracts). For RunEvent: add **optional** `organizationId` + `repositoryBindingId` as an **additive minor bump to `run-event/v1.1.0`** (allowed by `COMPATIBILITY.md`: new optional = minor; `RunEvent` already carries `projectId`+`tenantId`), with a new snapshot; the compat gate must pass. J2 is satisfied by the real fields, not by prose.
**Validation:** boundary tests reject malformed/unknown envelope versions; drift + compat gates cover the new schema and the RunEvent minor bump; persisted envelopes round-trip without provider types; every emitted RunEvent validates against its declared version.

---

## MEDIUM

### P2-PLAN-MED-001 — Ten-task pilot definition has a loophole — ACCEPTED
**Locked change:** A completed pilot task = a **distinct, human-authorized WorkOrder** run through real Claude + real sandbox + real GitHub App + real persistence, reaching the documented human-review outcome with a valid PR/evidence chain. Retries are attempts under one task and do **not** increase the count. A machine-verifiable pilot manifest (ten distinct task ids, objectives, risks, base+result SHAs, provider sessions, PRs, evidence checksums, human dispositions) + an automated verifier that rejects duplicate tasks, fake adapters, failed traces, and retry inflation.

### P2-PLAN-MED-002 — Raw output capture lacks bounds/backpressure — ACCEPTED
**Locked change:** Bounded **streaming capture directly to immutable artifacts**; separate display/context limits from evidence retention; record byte counts + explicit truncation/overflow state; **fail mandatory verification** if complete evidence cannot be persisted. Reducers never receive uncaptured output.
**Validation:** generate output beyond UI + resource thresholds; verify exact retained bytes or explicit fail-closed overflow; preserve exit/signal data.

### P2-PLAN-MED-003 — One giant execute-task activity hides step-level Temporal boundaries — ACCEPTED
**Locked change:** Separate **framework-free, idempotent step use cases** from the Phase 2 sequential driver. Document which state is operational projection vs. orchestration authority so Phase 3 composes the same steps as Temporal activities without a second durable orchestrator. Provide a second thin test driver that resumes from each persisted step; demonstrate a Temporal-shaped fake workflow composes the same step APIs with activity-level idempotency/heartbeat/cancellation.

### P2-PLAN-MED-004 — Inbound webhooks: promised, conditional, and an open question — ACCEPTED (defer)
**Concern + disposition:** ACCEPTED as a scope leak. Inbound webhooks are **not needed** to create/update a Phase 2 PR; they add externally-exposed attack surface without a current use case.
**Locked change:** **Defer inbound webhooks entirely.** Remove their Phase 2 MUST + threat-model claims; no webhook route or dependency may exist in Phase 2. (If a future phase retains them: authenticated route, payload limits, event allowlist, durable delivery dedup, secret rotation — out of Phase 2 scope.)

### P2-PLAN-MED-005 — Installation-token expiry/rotation undefined — ACCEPTED
**Locked change:** Treat credentials as **opaque values paired with provider-reported expiry**; mint separately for each bounded forge operation; never persist; one safe re-mint/reconcile path for auth expiry that does **not** replay completed side effects (ties to HIGH-005).
**Validation:** fake-clock transport tests cover expiry before/during operations, revocation, rotation, re-minting; log/artifact/DB scans prove neither token value nor private key is retained.

### P2-PLAN-MED-006 — Migration locking/transaction/repeat-apply undefined — ACCEPTED
**Locked change:** Define migration **advisory locking** (single migrator), transaction rules, repeat-apply (second run is a no-op), and recovery from a partially-applied non-transactional migration. Applied migration files are immutable; a checksum mismatch fails **before** executing later migrations.
**Validation:** real PG tests apply twice, run two migrators concurrently, inject mid-migration failure + restart, and reject an edited applied migration.

### P2-PLAN-MED-007 — Exit criteria omit DoD operational readiness — ACCEPTED
**Locked change:** Add to exit criteria: pilot **runbook**, metrics/dashboard requirements, alert/observation thresholds, artifact/DB/GitHub outage recovery, retention/cleanup procedure, and explicit rollback/stop conditions.
**Validation:** a preserved pilot rehearsal covering provider timeout, DB restart, object-store outage, stale lease, and GitHub rate limiting; dashboards + runbook lead to the documented stop/recovery decision.

### P2-PLAN-MED-008 — GitHub credential port leaks provider specificity; caret ranges vs. pin policy — ACCEPTED
**Locked change:** Keep GitHub credential minting **internal to the GitHub adapter/composition root**; application code depends only on `ForgeProvider` (drop `GitHubAppCredentialProvider` from the shared application ports). Reconcile the dependency policy: use **exact** direct dependency versions (matches the risk register), not caret ranges.
**Validation:** architecture tests reject GitHub installation/token types outside the adapter + composition root; manifest tests assert the locked version policy + frozen-lockfile install from a clean checkout.

---

## LOW

### P2-PLAN-LOW-001 — "composition-root only" is too literal — ACCEPTED
**Locked change:** Define composition-root-only as: **no domain decisions, no persistence queries, no provider calls, no workflow sequencing in handlers** — while allowing transport parsing, authentication hooks, request validation, and response mapping.
**Validation:** architecture mutation tests reject a seeded policy/SQL/Git/provider call in a handler while accepting a thin route that maps an authenticated request to a use case.

---

## Freeze gate

All 20 findings dispositioned; 0 unresolved CRITICAL/HIGH. The canonical Phase 2 documents (`phase-02-plan.md`, `-architecture.md`, `-data-model.md`, `-threat-model-delta.md`, `-risk-register.md`, `-exit-criteria.md`, `-research-register.md`) incorporate every accepted change. Task DAG remains acyclic; every slice has tests + exit evidence; no Phase 3 functionality is required for Phase 2 success; no canonical Phase 1 contract is broken without governed versioning (RunEvent minor bump is additive); all operational data is multi-project scoped; the agent cannot approve/commit/push/merge; real artifacts replace the placeholder; the ten-task pilot cannot be satisfied by synthetic fixtures.

**PLAN_STATUS: LOCKED** at disposition of Codex review `phase-02-plan-review-codex-v1.md`.
