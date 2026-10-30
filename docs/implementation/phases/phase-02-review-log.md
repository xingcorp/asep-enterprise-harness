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

---

## Final review cycle 6 dispositions

> Reviewer: Codex `gpt-5.6-sol`, re-review cycle 6 at `00a6889`
> (`phase-02-final-rereview-codex-v6.md`), verdict **REQUEST_CHANGES** @ 0.99.
> Repairs: repair cycle 7, on `phase/02-single-agent-vertical-slice` from
> `00a6889`. Every disposition and every repair below was made and verified by
> the implementer only; none has been independently reviewed. Mutation checks
> named below were run by the implementer: each mutant was applied to the
> source, the named suites were run, and the mutant was reverted.

### Summary

| ID | Cycle-6 verdict | Disposition | Commits |
|---|---|---|---|
| HIGH-001 | RESOLVED | no action | — |
| HIGH-002 | PARTIAL | ACCEPTED — fixed | `ab580a6`, `37956ac` |
| HIGH-003 | RESOLVED | no action | — |
| HIGH-004 | RESOLVED | no action | — |
| HIGH-005 | PARTIAL | ACCEPTED — fixed | `31aeca7` |
| HIGH-006 | PARTIAL | ACCEPTED — fixed | `c11078e` |
| HIGH-007 | RESOLVED | no action | — |
| HIGH-008 | PARTIAL | ACCEPTED — fixed; live run not performed | `ab580a6` |
| HIGH-009 | PARTIAL | ACCEPTED — fixed | `a52f6fa`, `0d23b31` |
| MED-001 | RESOLVED | no action | — |
| MED-002 | PARTIAL | ACCEPTED — fixed | `d5b2edd` |
| MED-003 | RESOLVED | no action | — |
| MED-004 | PARTIAL | ACCEPTED — fixed | `c7f7e59` |
| MED-005 | PARTIAL | ACCEPTED — fixed | report commit + sentinel (see below) |
| MED-006 | PARTIAL | ACCEPTED — fixed | `5981089` |
| MED-NEW-001 | RESOLVED | no action | — |
| MED-NEW-002 | RESOLVED | no action | — |
| CYCLE5-PROVENANCE | RESOLVED | no action | — |
| CYCLE5-PILOT-TEST | RESOLVED | no action | — |
| MED-NEW-003 | REGRESSED | ACCEPTED — fixed | `5e171a3` |
| MED-NEW-004 | REGRESSED | ACCEPTED — fixed | `367395b` |

Also in this cycle: `94504b2` (finding codes removed from new comments and
test names) and `a73ddb6` (PGlite wasm modules compiled once per process — an
intermittent V8 abort, `Check failed: end > addr`, took down a whole suite
during a full run).

### HIGH-002 — the waiver was public; the regex guard was evadable — ACCEPTED

**Concern:** a host-execution waiver was still exported, and the
`forbidden-imports` regex could be evaded by an alias, a computed property or
an object spread.
**Change:** the agent adapter lost its host mode and waiver in `ab580a6`.
`37956ac` removes the sandbox requirement and its pilot waiver from every
public surface (`@asep/command-runner` no longer exports `SandboxRequirement`,
`resolveSandboxRequirement`, `assertSandboxSatisfiesRequirement`,
`SandboxRequiredError`; `verifyStep`, `completeToReview`, the workflow and
`runVerticalSlice` take no input that relaxes isolation). The workflow probes
the sandbox and refuses, before its first side effect, any handle that does not
claim `isolationEnforced: true`; `verifyStep` re-checks the handle it runs
commands in. The regex rule is replaced by `scripts/lib/ts-guard.mjs`, which
uses the TypeScript 7 checker: only `adapters/command-runner/src/sandbox.ts`
may produce a value whose type claims isolation, and the retired waiver names
and constant-folded tokens may not return.
**Tests:** `scripts/ts-guard.test.ts` (`asep-suite:ts-guard`) — alias, computed
(folded, aliased, unresolvable), object spread (literal, real handle), untyped
spread, shorthand/assignment/element write/`Object.assign`/destructured
assign/`defineProperty`/`Reflect.set`/class member/getter/casts from `any`/
double cast/`any` flow/property name in a string, honest code not flagged,
retired waiver names and cross-module folded tokens.
`packages/application/src/pipeline-steps.test.ts` — "no input waives isolation
— a smuggled legacy waiver field is ignored".
`apps/control-plane-api/src/vertical-integration.test.ts` — "the vertical
slice refuses the honest host provider before any side effect", "… a provider
whose handle is silent about isolation …".
**Mutation check:** 7 guard mutants (no spread check, no identifier fold, empty
claim allowlist, literal-only claim value, `any` treated as no claim,
unresolvable computed key ignored, waiver re-added to shipped code), 2
`verifyStep` gate mutants and 2 workflow-probe mutants — all killed.
**Residual:** the guard is static; a value computed at run time can evade it,
which is why the runtime refusal remains the enforcement point.

### HIGH-005 — side-effect identity was nullable text and the outcome was JSONB — ACCEPTED

**Change (`31aeca7`, migration 0013):** records carry `attempt_id` and
`operation`; `repository_binding_id` is NOT NULL and composite-FK-bound to the
attempt's own binding; uniqueness is on (org, project, binding, attempt,
operation); the text `scope`/`semantic_key` columns are dropped. `result_ref`
is NULL unless COMPLETED and then exactly the operation's closed shape
(`side_effect_result_closed` CHECK); `parseSideEffectResultRef` in
`@asep/ports` parses it; `complete()` validates before writing.
**Tests:** `adapters/persistence/src/side-effect-log.test.ts` — "the text
identity columns are gone and the binding is NOT NULL", "the DB refuses a
side-effect row with no repository binding", "… whose binding is not its
attempt's binding", "… a second row for the same (binding, attempt,
operation)", "… any outcome that is not the operation's closed shape",
"complete() validates the outcome before writing and leaves the record
PENDING", "a COMPLETED outcome is read back already parsed into its closed
shape".

### HIGH-006 — a successor could not take over a crashed owner's PENDING record — ACCEPTED

**Change (`c11078e`, migration 0014):** leases gain a per-(binding, branch)
`fencing_epoch` and `ttl_ms`, with expiry on the database clock; records are
owned by `owner_lease_id` + `owner_epoch`; the `side_effect_guard` trigger
allows writes only under a live owner lease and ownership moves only from a
dead lease to a strictly newer epoch on the same branch. `SqlSideEffectLog`
takes over only from a dead lease; heartbeat throws `LeaseLostError`.
`resumeAttemptToReview` acquires the lease, takes over, reconciles push and PR
against the forge and persists the transitions; it resumes only attempts whose
commit and evidence are durable.
**Tests:** `side-effect-log.test.ts` takeover cases (expired owner, released
owner, live owner refused, lapsed owner refused, newer epoch required, the
database refuses a forbidden move); `apps/control-plane-api/src/crash-recovery.test.ts`
(five cases); `apps/control-plane-api/src/crash-takeover.itest.ts` SIGKILLs a
real executor child on real PostgreSQL.
**Residual:** no FK from a lease to its attempt (added since, by migration 0015
— see "Cycle 7 follow-up dispositions"); the lease TTL must outlive the agent's
wall-clock budget (`leaseTtlForBudget` refuses a shorter one).

### HIGH-008 — the live agent could not run — ACCEPTED (live run not performed)

**Change (`ab580a6`):** each attempt runs the real Claude CLI in a container on
a per-attempt internal network whose only peer is an egress proxy forwarding
`POST /v1/messages` and `/v1/messages/count_tokens` to the configured model
origin; the credential reaches the proxy on stdin only; the work order and
context pack are re-hashed, mounted read-only and re-checked; the real CLI
flags and a stream-json parser are used; `system/init` is checked against the
pins; the tool-call budget is enforced live; everything is torn down in
`finally`.
**Tests:** `adapters/agent-claude/src/agent-claude.test.ts` (strict fake CLI,
fake docker client, real proxy, fake model API); `agent-sandbox.itest.ts`
against the real daemon (canaries: every write/chmod outside the worktree is
EROFS, direct egress ENETUNREACH, DNS fails, proxy refuses absolute-form,
CONNECT and other paths, model reached with the real key upstream).
`claude-live.live.ts` CONFORMANCE ran in this session against the host's
Claude CLI 2.1.286 and passed. LIVE was not run: no model credential is
available here.
**Residual:** the model provider is a trusted data channel (the proxy limits
method and path, not content); `--setting-sources user` is passed.

### HIGH-009 — the verifier trusted rows, not bytes or the forge — ACCEPTED

**Change (`a52f6fa`):** the resolver fetches the evidence bytes from the object
store and re-hashes them; the verifier requires them to hash to the recorded
sha256 and the bundle to name the task, attempt, the attempt's result commit
and the manifest base. It asks the forge, through the `ForgeProvider` port, for
the PR on the attempt's branch and requires its number, URL and live head
(`PullRequestRef.headSha`, new and optional) to match. It requires the signed
authorization to bind the attempt, the result commit and the PR. The
production factory builds the GitHub App forge port from env and reads
`ASEP_OBJECT_STORE_DIR`; the pilot writes its objects there. The workflow now
records the agent's `providerId` on the attempt — it never did, so the verifier
would have refused every genuine run. `0d23b31`: the forge binding resolver
resolved the local repository eagerly, so every PR lookup without a worktree
failed (the verifier's included); it now resolves it only for a push.
**Tests:** `scripts/pilot/verify-pilot-manifest.test.ts` (tampered,
unreadable, non-bundle and wrong-kind evidence; bundle of another task,
attempt, base or result; PR missing on the forge, head moved, head unreported,
number/URL mismatch; resolver without the forge lookup; authorization for
another attempt, commit or PR; resolver construction; scoped forge lookup;
filesystem reader traversal; binding reader; the verifier's GitHub forge
looking a PR up); `adapters/persistence/src/authority-resolver-sql.test.ts`
(bytes written by the real evidence store re-hashed and seen to change);
`apps/control-plane-api/src/pilot-verifier.test.ts` (`asep-suite:pilot-verifier`:
a real slice is accepted, then refused after the PR head moves, the evidence
bytes change, or the authorization is re-signed for another commit);
`adapters/github-app/src/port-adapter.test.ts` (head commit reported;
lookups never ask for the local repository).
**Mutation check:** 18 mutants across the verifier, the resolver, the GitHub
adapter, the port, the local forge double and the workflow — all killed; the
eager-locator mutant was killed by two tests.

### MED-002 — `resolveRef` lacked bounded re-mint — ACCEPTED

**Change (`d5b2edd`):** all four token-spending operations share one loop;
expired mints are skipped, only expiry/revocation retries,
`ForgeAuthExpiredError` names the operation, a non-auth probe failure is a
scrubbed `ForgeReconcileError`; git's HTTPS auth wording counts as expiry;
re-mints bypass the token cache.
**Tests:** `adapters/github-app/src/github-app.test.ts` — the six cases added in
`d5b2edd`.

### MED-004 — the resolver called persistence; the fitness rule missed `projects` — ACCEPTED

**Change (`c7f7e59`):** membership is the application use case
`projectBelongsToOrganization` over a structural `ProjectMembershipPort`; the
principal resolver forwards to it. The TypeScript guard gains
`persistence-call-in-root` (any call in `apps/*`/`workers/*` that resolves, by
symbol or by type, to a declaration in the persistence adapter; open, migrate
and ping exempt) and `port-call-in-root` (the same call with the adapter
retyped as a port from `packages/application` or `packages/ports`).
**Tests:** `scripts/ts-guard.test.ts` — any receiver name, destructured,
`.call`, `.apply`, `.bind(...)()`, element access, bound-then-called, cast,
imported function, raw query, union receiver; port-typed laundering (application
and ports interfaces); wiring not flagged; root selection.
`apps/control-plane-api/src/control-plane.test.ts` — "projectBelongsToOrganization
answers from the persisted row, and the resolver forwards to it".
**Mutation check:** 12 mutants — all killed.
**Residual:** a value retyped through an interface the root declares itself is
beyond the static check.

### MED-005 — the report overclaimed; the L1 sentinel was absent — ACCEPTED

**Change:** `phase-02-report.md` is rewritten to state only what was observed
by machine in this cycle, with each finding's status and the fact that the
repairs are unreviewed. The `.phase-02-implementation-complete` sentinel is
written last, after the final gate on the report commit, and holds the output
of `git rev-parse HEAD` at that moment (exit L1). It is gitignored by design.

### MED-006 — faults 3 and 5 were not injected into the pipeline — ACCEPTED

**Change (`5981089`):** `apps/control-plane-api/src/pilot-faults.test.ts`
(`asep-suite:pilot-faults`) injects both into a real `runVerticalSlice` run.
Fault 3: the object store disappears after verification; the run stops with
nothing published, artifacts re-verify after restore, the attempt is reported
not resumable. Fault 5: a 403 rate limit through the real GitHub App adapter;
the run stops with the push recorded and the PR pending; after back-off the
resume opens exactly one PR. `phase-02-pilot-rehearsal.md` no longer calls
itself a paper rehearsal; it names the test behind each fault and what is not
live. The runbook's §3.1 and §3.3 now describe what the code does.
**Residual:** fault 5's pushes go to a local bare remote; fault 1 is injected
into the provider, not a whole pipeline run.

### MED-NEW-003 — cold-cache reset swallowed errors — ACCEPTED

**Change (`5e171a3`):** `scripts/cold-cache-reset.sh` checks every removal,
rescans, and fails naming any survivor; symlinked `dist` entries are removed.
**Tests:** `scripts/cold-cache-reset.test.ts` — five cases including a failing
`rm` shim and one that silently does nothing.

### MED-NEW-004 — PII scan ignored git metadata — ACCEPTED

**Change (`367395b`):** the scan covers author and committer of every commit
reachable from `refs/heads`, `refs/tags` and `refs/remotes`. By the owner's
decision published history is kept: one legacy personal address is tolerated
only on ancestors of the pinned `main`, `phase/01` and `phase/02` heads,
matched by hash so the address is never written to the tree; anything newer,
or any other personal address, fails.
**Tests:** `scripts/pii-scan.test.ts` — five cases.

### Findings raised by this repair cycle itself

- The governed workflow never set `attempts.agent_provider_id` (fixed in
  `a52f6fa`).
- `SqlForgeBindingResolver` resolved the local repository for every operation
  (fixed in `0d23b31`).
- Many PGlite instances in one process intermittently aborted V8 (fixed in
  `a73ddb6`).

---

## Cycle 7 follow-up dispositions (controller)

> Raised by the controller after reading the cycle-7 report at `863fed0`, while
> its independent gate run and Codex re-review cycle 7 ran on snapshots of that
> commit. Item 1 was reported by Lane A. Items 4–6 are concerns the cycle-7
> report itself listed. Repairs are on `phase/02-single-agent-vertical-slice`
> from `863fed0`. As with cycle 7, every disposition, repair and mutation check
> below was made and verified by the implementer only. From this follow-up on,
> commits carry no AI attribution lines (lane-contract addendum, item 3);
> earlier commits are left as they are.

### Summary

| Item | Concern | Disposition | Commit |
|---|---|---|---|
| 1 | Integration gate published backends on every host interface | ACCEPTED — fixed | `ec280f8` |
| 2 | A container could outlive a killed docker client | ACCEPTED — fixed | `dec962b` |
| 3 | No AI attribution in commits; no memory-file changes | ACCEPTED — applied from `ec280f8` on | — |
| 4 | The verifier's fake-provider check was a deny-prefix | ACCEPTED — fixed | `d5e4bb3` |
| 5 | No foreign key from a lease to its attempt | ACCEPTED — fixed | `7d1b4df` |
| 6 | Verification runner timeout killed the client, not the container | ACCEPTED — fixed with item 2 | `dec962b` |

### 1 — gate backends published on every interface — ACCEPTED

**Change (`ec280f8`):** `runContainer` builds its argv through
`containerRunArgv`, which refuses any publish spec that does not name
`127.0.0.1` explicitly, before a docker client is invoked. The CLI builds both
specs with `loopbackPublish()`. Every `compose.yaml` port is bound to
`127.0.0.1`, including jaeger's two random-port publishes (`127.0.0.1::4317`).
`docker compose config` was run to confirm compose parses these as host IP
`127.0.0.1`.
**Tests:** `scripts/integration/run-integration.test.ts`
(`asep-suite:integration-gate`):
- "a publish spec is accepted only when it names 127.0.0.1 explicitly";
- "the gate publishes every backend port on 127.0.0.1 and refuses anything
  else before docker runs";
- "no gate source publishes a port except through the loopback-checked
  builder" (scans the CLI, its helpers, every itest and the CI job);
- "compose.yaml publishes every service port on 127.0.0.1 only";
- "the compose port parser reports what it cannot read instead of skipping it".

Against the old CLI and compose file, the scan and the compose test failed.
**Mutation check:** unguarded publish in the builder, a host-agnostic spec
rule, and no port-range bound — all 3 killed.

### 2 / 6 — a container could outlive its docker client — ACCEPTED

**Change (`dec962b`):**

Verification containers:
- Each is named `<sandboxId>-<n>` and labelled `asep.role=verification`,
  `asep.sandbox`, `asep.workspace`, `asep.attempt` (from the new optional
  `WorkspaceMount.attemptId`, which the workflow sets) and `asep.container`.
- On a timeout or a cancellation the container is stopped by name with
  `docker kill` before the client is killed. Measured on this host:
  `docker rm -f` on a `--rm` container whose client was still attached took
  11.04 s; `docker kill` took 0.32 s.
- Whenever the client ends, the container is removed by name and confirmed
  absent with `docker ps -a`. A container that cannot be shown gone makes
  `run()` throw `SandboxTeardownError`.
- `DockerSandboxProvider.stop` sweeps anything still carrying the sandbox
  label, and throws when it cannot.

Agent and egress-proxy containers:
- Each also carries `asep.container`.
- A stop kills the container before its client.
- The proxy is stopped before its attached client is killed.
- After name-based removal, everything labelled `asep.attempt=<id>` is swept
  and confirmed absent, and the network is checked with `docker network ls`.
- Anything left fails the attempt as FAILED.

Every docker client call of a sandbox now uses the shared docker-client
environment, so a removal reaches the daemon the run did.

**Tests:**

`adapters/command-runner/src/command-runner.test.ts` (fake docker client,
whose containers outlive a killed client):
- naming and labels;
- "killing the docker client mid-run does not leave its container running";
- timeout;
- cancellation;
- "a container that cannot be removed fails the run closed";
- "stopping a sandbox removes any container still carrying its id, and fails
  when it cannot".

`adapters/agent-claude/src/agent-claude.test.ts`:
- "killing the agent and proxy docker clients mid-run leaves no container or
  network behind";
- "an attempt whose containers cannot be shown removed fails closed".

Real daemon:
- `sandbox-exec.itest.ts`: client SIGKILLed mid-run, timeout, cancellation and
  normal exit.
- `agent-sandbox.itest.ts`: agent and proxy clients SIGKILLed mid-run;
  cancellation.

**Mutation check:** 11 mutants against the fake-docker suites — all killed:

| Area | Mutant |
|---|---|
| Runner | no removal after the client ends |
| Runner | timeout kills only the client |
| Runner | container unnamed and unlabelled |
| Runner | a leftover is not fatal |
| Runner | sandbox labels dropped |
| Sandbox | `stop` is a no-op |
| Teardown | removal never reports failure |
| Agent | agent not removed by identity |
| Agent | leftovers not fatal |
| Agent | proxy not removed by identity |
| Agent | network leftovers ignored |

Two of these were also run against the real daemon; the SIGKILL itest of each
suite failed:
- runner, no removal after the client ends;
- agent not removed by identity.

**Residual:** the harness removes what it started only while it is alive. If
the harness process itself dies, its containers keep running until the
operator sweep in the pilot runbook, which now says so.

### 4 — the provider check was a deny-prefix — ACCEPTED

**Change (`d5e4bb3`):**

What is checked:
- The manifest's `providerId` must have the real adapter's shape
  (`claude:<model>@cli-<version>`), in the verifier and in
  `pilot-manifest.schema.json`.
- The persisted provider must be exactly
  `claude:<pinned model>@cli-<pinned version>`, and the manifest must claim
  the same id.
- The attempt must carry exactly one of each of these, re-hashed from the
  object store:
  - an invocation manifest naming that id, the pinned agent and proxy images
    and the pinned model origin;
  - a CLI event stream whose init event reports the pinned version and model
    and the manifest's `providerSessionId`, ending in success;
  - an egress-proxy log with at least one forwarded `POST /v1/messages` the
    model answered 2xx.

How it is wired:
- The Claude adapter links the artifacts it records to the attempt.
- The resolver gains `resolveAgentRun` and `pinnedAgent`, and
  `createSqlAuthorityResolver` requires the pins.
- `createResolverFromEnv` reads them from the pilot's own variables.

**Tests:**
- `apps/control-plane-api/src/pilot-verifier.test.ts` now runs the slice
  through the real `ClaudeCodingProvider` (fake docker client, real egress
  proxy, fake model API, strict fake CLI scenario `ok-model`). The verifier
  accepts it under its pins. It refuses it under another CLI version, model
  origin or image; after the egress log is rewritten; and for the cycle-7
  reasons.
- "a run through the local agent double is refused, whatever the manifest
  claims about it": `fake-claude`, claimed as the real id or declared
  honestly.
- `scripts/pilot/verify-pilot-manifest.test.ts`: every agent-evidence refusal
  and the pins.
- `adapters/persistence/src/authority-resolver-sql.test.ts`: one attempt's
  artifacts only, against the real schema.
- `adapters/agent-claude/src/agent-claude.test.ts`: every recorded artifact is
  linked to its attempt.

**Mutation check:** 16 mutants — all killed:
- verifier: deny-prefix authority check, no agent-run check, bytes not
  compared, session unchecked, model calls unchecked, upstream unchecked,
  manifest id vs persisted, shape check off, ambiguity allowed, result
  unchecked, init version unchecked;
- resolver: no attempt filter, any egress line counts, pins not
  digest-checked, bytes not re-hashed;
- adapter: artifacts not linked to the attempt.

**Residual:** the check proves the run went through the real adapter, under
the pinned CLI, images and model origin, and that the proxy forwarded model
calls the origin answered. It cannot prove who answers at that origin. Someone
able to write both the database and the object store could still fabricate
these artifacts; there is no provider-side attestation.

### 5 — no foreign key from a lease to its attempt — ACCEPTED

**Change (`7d1b4df`, migration 0015):** composite FK `(attempt_id,
organization_id, project_id, repository_binding_id)` → `attempts`, the key
0013 added for side-effect records. An upgrade over a lease that names no such
attempt fails with a count instead of deleting or re-pointing it. Production
creates the attempt before acquiring its lease. Tests that leased fabricated
attempt ids now lease real ones, including `concurrency.itest.ts`.
**Tests:** `adapters/persistence/src/persistence.test.ts`:
- "the DB refuses a lease for an attempt that does not exist";
- "… for another tenant's attempt";
- "… whose binding is not its attempt's binding";
- "upgrading a database whose lease names no attempt fails instead of
  guessing one".

All three refusal tests failed before the migration.
**Mutation check:** no FK, FK without the binding column, no orphan pre-check —
all 3 killed.

### Live proof after the follow-up

Items 2 and 4 changed the Claude provider's teardown and artifact linking. The
opt-in CONFORMANCE proof (`pnpm test:live:claude` with
`ASEP_CLAUDE_CONFORMANCE_CLI` set to the host's Claude CLI 2.1.286) was re-run
at `dec962b` and passed: 1 pass, 1 skipped (LIVE, no credential), 0 fail.

---

## Final review cycle 7 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 7 at `863fed0`
> (`phase-02-final-rereview-codex-v7.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The review covers `863fed0` only; the cycle-7 follow-up (`ec280f8`..`f3bb704`)
> came after its snapshot. Repairs: repair cycle 8, on
> `phase/02-single-agent-vertical-slice` from `f3bb704`. As before, every
> disposition, repair, test and mutation check below was made and verified by
> the implementer only; none has been independently reviewed. A mutation check
> applies each mutant to the source, rebuilds, runs the named suites, and
> reverts it; "killed" means at least one named test failed.

### What the review accepted, and what it did not

Of the cycle-6 findings it re-checked, the review marked these **RESOLVED**:
HIGH-001, HIGH-004, HIGH-007, MED-001, MED-002, MED-003, MED-004, MED-006,
MED-NEW-001, MED-NEW-002, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST.

It did not accept the rest. HIGH-002, HIGH-005, HIGH-006, HIGH-008, HIGH-009,
MED-005, MED-NEW-003 and MED-NEW-004 were **PARTIAL**; HIGH-003 was
**REGRESSED** by the new resume path. It restated what remained as eleven new
findings, CYCLE7-HIGH-001..007 and CYCLE7-MED-001..004, plus the report's
honesty (tracked here as MED-005). From its implementer-limitations table it
required (5), (7) and (8) to be fixed in Phase 2. (5) and (7) were fixed in
the follow-up (`dec962b`, `7d1b4df`); (8) by `d5e4bb3` and CYCLE7-HIGH-005
below.

### Summary

| ID | Restates | Disposition | Commits |
|---|---|---|---|
| CYCLE7-HIGH-001 | HIGH-002 | ACCEPTED — fixed | `de0fba1` |
| CYCLE7-HIGH-002 | HIGH-005 | ACCEPTED — fixed | `54af435`, `0e7eb0d` |
| CYCLE7-HIGH-003 | HIGH-006 | ACCEPTED — fixed; residuals below | `0e7eb0d`, `7fdd47d`, `3de3f08` |
| CYCLE7-HIGH-004 | HIGH-008 | ACCEPTED — fixed | `9d782c1` |
| CYCLE7-HIGH-005 | HIGH-009, limitation (8) | ACCEPTED — fixed | `f11d49b` |
| CYCLE7-HIGH-006 | limitation (5), F3 | ACCEPTED — fixed in the follow-up, after the reviewed snapshot | `dec962b` |
| CYCLE7-HIGH-007 | HIGH-003 (REGRESSED) | ACCEPTED — fixed | `946ba77` |
| CYCLE7-MED-001 | — | ACCEPTED — fixed | `8c3f970` |
| CYCLE7-MED-002 | MED-NEW-003 | ACCEPTED — fixed | `61138bd` |
| CYCLE7-MED-003 | follow-up item 1 | ACCEPTED — fixed in the follow-up; agent-side reachability proven by the CYCLE7-HIGH-004 canary | `ec280f8`, `9d782c1` |
| CYCLE7-MED-004 | MED-NEW-004 | ACCEPTED — controller-attested user decision recorded | this log |
| MED-005 | report honesty | ACCEPTED — report rewritten | report commit + sentinel |

Also: `215db41` and `78413e3` add the cycle-7 transcript with its provenance
note.

### CYCLE7-HIGH-001 — an object rest kept the isolation claim and ran on the host — ACCEPTED

**Invariant:** a command runs where the sandbox provider that made its handle
put it, never where the handle's own fields say.
**Change (`de0fba1`):** each provider records, for the handle object it
returns, how commands for it execute (a container with these flags, image and
client, or the host), and freezes the handle. The runner looks that record up
by the handle's identity and never reads the handle's fields to decide. A
copied, spread, destructured or hand-built handle, or one whose sandbox has
stopped, has no record and runs nothing (`SandboxHandleNotProvenError`). The
host path also refuses a handle that claims isolation. The type guard flags an
object rest that copies the claim. The use-case check on `isolationEnforced`
is described as what it is: a first refusal on a claim, not proof of
containment.
**Tests:** `command-runner.test.ts` — "a handle no sandbox provider made is
refused and runs nothing, on the host or in a container", "a handle a provider
made cannot be altered after the fact", "a genuine handle still runs where its
provider put it"; `vertical-integration.test.ts` — "the vertical slice refuses
a handle stripped down to its isolation claim, and runs nothing on the host"
(the reviewer's probe); `ts-guard.test.ts` — object-rest evasion and its
negative control.
**Mutation check:** re-run in this cycle at `f11d49b`, 8 mutants, 7 killed:
runner falls back to the host for an unrecorded handle; runner decides from the
handle's own fields; Docker stop does not retire the handle; local stop does
not retire the handle; handles not frozen; the guard ignores object rests; the
old logic end to end (killed by the vertical-slice probe). One **survived**:
dropping the host path's refusal of a handle that claims isolation. It is
equivalent under the current code: the only host record is issued by
`LocalUnsandboxedProvider` for a frozen handle with `isolationEnforced: false`,
and nothing else can issue one, so no test can reach that branch. It is kept
as defence in depth.

### CYCLE7-HIGH-002 — hierarchy and authoritative references were not closed — ACCEPTED

**Invariant:** every authoritative reference is a scoped key with checksum and
kind that the database checks.
> **Superseded in repair cycle 9.** The cycle-8 review (CYCLE8-HIGH-002)
> showed this did not hold: `command_executions.stdout_artifact_id` and
> `stderr_artifact_id` were left bare, and the test hand-listed five
> references. Migration 0019 closes them; see "Final review cycle 8
> dispositions".

**Change:**
- `54af435`, migration 0017: a PR names an attempt of its own binding. The
  product spec, work order, context pack and both evidence links are
  `<name>_artifact_id` + `<name>_sha256` (both or neither) with a generated
  kind, composite-FK-bound to `artifacts (id, organization, project, sha256,
  kind)`. The upgrade keeps JSONB references that name such an artifact and
  fails on one that does not. The workflow attaches the WorkOrder to its task
  and the context pack to its attempt.
- `0e7eb0d`, migration 0018: the commit record's evidence id, the attempt's
  evidence and the PR's evidence are FK-bound to an evidence reservation of
  the same attempt, whose draft is an artifact of that attempt.
**Tests:** `persistence.test.ts` — "the DB refuses a pull request whose
attempt belongs to another binding", one "is a scoped artifact reference with
checksum and kind" test per reference column, "no reference column is free
JSONB any more", the repository round-trip, the upgrade over JSONB; the
reservation tests in `evidence-store.test.ts` and `side-effect-log.test.ts`;
`vertical-integration.test.ts` — "the vertical slice attaches the WorkOrder to
its task and the context pack to its attempt".
**Mutation check:** re-run in this cycle, 7 mutants, all killed: PR
attempt/binding FK absent; reference FK ignores the checksum; id and checksum
need not be paired; JSONB columns kept; workflow does not attach the work
order; work-order kind not enforced; work-order FK by id and tenant only.; reservation and evidence binding: 13 mutants,
all killed (one first survived — the draft's attempt was not checked on read;
a test was added and it was then killed).

### CYCLE7-HIGH-003 — recovery narrowed the mandatory crash windows — ACCEPTED

**Invariant:** a restart converges on one commit, one ref and one PR after a
crash at any boundary, and an owner whose records were taken over reaches no
external system.
> **Superseded in repair cycle 9.** The cycle-8 review (CYCLE8-HIGH-003)
> reproduced an owner paused between reading the PR and updating it writing
> after its successor; the epoch marker narrowed the race and did not close
> it. The second half of this invariant cannot hold at the forge: a stale
> owner may still reach it, and GitHub has no compare-and-set for a PR
> update. The marker is removed; what holds instead — content idempotence,
> push compare-and-set, reconciliation — is under "Final review cycle 8
> dispositions". Nor does the first half hold at every Git-call boundary: a
> crash between `commit-tree` and the attempt ref leaves the attempt
> not resumable (it is re-executed; nothing was published).
**Change:**
- `0e7eb0d` — between commit and evidence: the evidence draft is reserved
  before the commit, so a resume completes it with the committed SHA instead
  of re-executing. An unreadable draft publishes nothing.
- `7fdd47d` — commit landed, record not completed: the commit is made with
  `git commit-tree` and recorded create-only at `refs/asep/attempts/<attemptId>`
  before HEAD moves; `reconcile` finds it without the dead executor's worktree.
  A second commit for an attempt, a mismatched parent or trailer, and an empty
  commit are refused. A PENDING commit record is completed with that commit; a
  commit that never landed asks for re-execution.
- `3de3f08` — in-flight race: `confirmOwner` (current owner, PENDING, live
  lease by database clock; renews; returns the epoch) runs immediately before
  the commit, the push and the PR. The forge calls carry `fencingEpoch`; the PR
  body records it and an upsert refuses a PR a newer epoch wrote.
**Tests:** `crash-recovery.test.ts` and `pilot-faults.test.ts` now expect the
same attempt to resume (fault 3, the commit/evidence crash, the unreadable
draft, the commit-landed-before-record crash); `git-worktree.test.ts` — six
commit/reconcile tests; `pipeline-steps.test.ts`, `resume-attempt.test.ts`,
`side-effect-log.test.ts` (four `confirmOwner` tests), `github-app.test.ts`.
Real PostgreSQL (`crash-takeover.itest.ts`): SIGKILL at three crash points
including `at-commit-record`, and "a paused executor cannot act after a
successor took its records over (in-flight race)" — both passed in this cycle.
**Mutation check:** commit reconciliation 9 mutants, all killed; fencing 9
mutants, all killed. One of these hung the in-flight itest at its pause point
for 27 minutes; it was killed by hand and the test now has a 120 s timeout.
**Residual:** a git ref cannot record an epoch, so a push relies on the
confirmation, on one commit per attempt and on a non-force push. GitHub has no
compare-and-set on a PR, so the epoch check narrows but does not close a race
between two upserts inside one read-then-update. An owner that confirmed and
then stalls in the call longer than its renewed TTL can still reach the forge
after a takeover.

### CYCLE7-HIGH-004 — `--internal` did not prove the agent reaches only the proxy — ACCEPTED

**Invariant:** the agent's network gives it no host address; only the proxy is
reachable.
**Change (`9d782c1`):** the agent network is created `--internal` with
`com.docker.network.bridge.gateway_mode_ipv4=isolated` and `…_ipv6=isolated`
(Docker Engine 28.0.0 or later), so the bridge holds no gateway address on the
host. After creating it the provider inspects it and fails the attempt before
anything starts unless the daemon describes it as internal, isolated in both
families and without an IPAM gateway. Verified by hand on Docker Desktop
29.6.1: a plain `--internal` network's gateway reached a listener on the host
network namespace; the isolated network had no gateway and did not.
**Tests:** `agent-claude.test.ts` — "a daemon that does not isolate the agent
network from the host fails the attempt before anything starts", "the agent
network counts as isolated only as the daemon describes an isolated one".
Real daemon (`agent-sandbox.itest.ts`): the canary in the agent container
probes a host-network listener, the integration gate's PostgreSQL and MinIO
ports, `172.17.0.1`, `192.168.65.254`, `host.docker.internal` and the would-be
gateway, public DNS and a public resolver, and IPv6; all fail. A control
container on a plain `--internal` network reaches the same listener, checked
before and after the run.
**Mutation check:** 5 mutants, all killed. The first canary run was vacuous:
the control probe's reset crashed the host listener, so later probes reached
nothing. The listener now ignores socket errors, and the control is re-checked
after the run; the plain-`--internal` mutant then failed with "the host is
reachable from the agent at 172.28.0.1:<port>". The gateway-address mutant
first survived; a unit test of `agentNetworkIsolationGap` killed it.
**Residual:** the CI runner's Docker Engine version (≥ 28.0.0 required) is not
verified here.

### CYCLE7-HIGH-005 — the verifier could certify a pilot that was not genuine — ACCEPTED

**Invariant:** every fact the verdict rests on is read from what the harness
wrote — the task, its work order, the canonical evidence and where each check
ran — never from the manifest.
**Change (`f11d49b`):**
- The resolver reports, with the attempt, the task's status, risk and work
  order and the attempt's base and context pack; the whole evidence bundle;
  any artifact of the tenant by id (kind, recorded checksum, hash of its
  bytes); and the attempt's `verification-provenance` records. The pins add
  the verification image (`ASEP_VERIFY_IMAGE_DIGEST`).
- The verifier requires, per task: `WAITING_FOR_HUMAN_REVIEW`; the manifest's
  risk, base and work order to be the task's, at R0 or R1 (what Phase-2
  admission admits); intact `work-order` and `context-pack` artifacts that the
  agent's invocation manifest names as its only inputs; a bundle in the
  canonical shape, closed at every level, with the pinned agent image, an
  intact `git-diff` artifact and checks linked to intact raw output; the
  attempt to carry that very evidence; and one intact provenance record that
  matches the bundle check for check, with every check run in a container of
  the pinned verification image under `--network none`, `--read-only`,
  `--cap-drop ALL` and `--security-opt no-new-privileges` (and no other
  network, `--privileged` or `--cap-add`), and every mandatory check passed.
- Producer side: `CommandResult.provenance` says where the runner ran a
  command, from the provider's record of the handle; verification keeps it per
  check; `completeToReview` hands a provenance record to `recordVerification`
  before it reserves the evidence; the workflow stores it as an artifact of the
  attempt.
**Tests:**
- The reviewer's probe, twice: "ten tasks run by a local double at risk R4,
  with invented work orders and sessions, are refused" (fake authority), and
  "ten tasks seeded at risk R4 with a local double's provider and invented work
  orders and sessions are refused" (`authority-resolver-sql.test.ts`: real
  schema, real evidence store, genuine Ed25519 signatures, PR heads equal to the
  results). Each task is refused for its provider, its risk, its work order, its
  missing agent evidence, its missing provenance and its empty checks; and not
  for its bytes, PR or signature, which are genuine.
- Each property alone in `verify-pilot-manifest.test.ts` (task state, risk,
  base, work order, context pack, agent inputs, attached evidence, bundle shape,
  checks, diff and raw output, provenance presence, identity, match, sandbox
  image and flags, mandatory checks).
- `pilot-verifier.test.ts` no longer treats a fabricated work order as genuine:
  the manifest carries the work order the task carries, the bundle records the
  agent image as the pilot does, and the pins carry the sandbox image. It
  refuses the same run once the task leaves review, the manifest claims another
  risk or work order, the work order or the provenance record is rewritten, or
  the verification image differs. A new test ties `ADMISSIBLE_RISKS` to
  `admitRisk`.
- Producer: `pipeline-steps.test.ts` (record before reservation, unknown
  provenance stays unknown, none on a red gate), `command-runner.test.ts` (the
  result says host or container, with the provider's image and flags and the
  container's name).
**Mutation check:** 29 mutants — 21 in the verifier, 4 in the resolver, 4 in
the producer — all killed.
**Residual:** as for the agent evidence, the provenance record is written by
the harness to the database and object store; whoever can write both could
fabricate it. It is not FK-bound to the evidence reservation.

### CYCLE7-HIGH-006 — verification timeout did not stop the container — ACCEPTED

Fixed by `dec962b` in the cycle-7 follow-up, after the reviewed snapshot; the
change, tests and mutation checks are under "2 / 6" in "Cycle 7 follow-up
dispositions" above. No further change in this cycle.

### CYCLE7-HIGH-007 — resume bypassed risk admission — ACCEPTED

**Invariant:** no path takes a lease or publishes for a risk Phase 2 does not
admit.
**Change (`946ba77`):** `resumeAttemptToReview` reads the authoritative task
row first and runs the same admission a fresh run does; R2–R4 stop at
`admission` having touched nothing but that read.
**Tests:** `resume-attempt.test.ts` — one test per risk R0–R4 with recording
fakes; `crash-recovery.test.ts` — "a resume of a task whose authoritative risk
is deferred stops at admission and touches nothing" on real persistence. The
suite is required.
**Mutation check:** re-run in this cycle, 3 mutants, all killed: no admission
on resume; admission from a caller-side constant instead of the task row;
admission after the lease.

### CYCLE7-MED-001 — lease liveness used transaction-start time — ACCEPTED

**Change (`8c3f970`, migration 0016):** liveness, renewal, expiry and sweeps
use `clock_timestamp()`; the trigger reads the owner lease `for share`, as the
adapter does.
**Tests:** `side-effect-log.test.ts` — four "a transaction opened before a
lease expired …" tests; `concurrency.itest.ts` — the same across two real
PostgreSQL connections, and "a successor sweep waits for a transaction that
wrote under the lease".
**Mutation check:** re-run in this cycle, 5 mutants, all killed: adapter
liveness, trigger liveness, heartbeat renewal, acquire sweep and acquire expiry
each on `now()`.

### CYCLE7-MED-002 — cold-cache discovery failed open — ACCEPTED

**Change (`61138bd`):** both `find` passes write to a scratch file instead of
a process substitution, so a failing `find` fails the step.
**Tests:** `cold-cache-reset.test.ts` — discovery failing outright, after
partial output, only on the leftover scan, and the reviewer's
exported-function probe.
**Mutation check:** 2 mutants, both killed: a failing discovery ignored; the
leftover scan not re-run.

### CYCLE7-MED-003 — the gate published its backends on every interface — ACCEPTED

Fixed by `ec280f8` in the cycle-7 follow-up ("1" above). The review also asked
for reachability from the agent network: the CYCLE7-HIGH-004 canary probes the
gate's PostgreSQL and MinIO ports on every host address the agent could hold,
and all fail.

### CYCLE7-MED-004 — the PII exception had no owner disposition — ACCEPTED

**Controller-attested user decision.** The repository's history contains one
legacy personal address in commit metadata (`pii-scan.sh` tolerates it only on
ancestors of the pinned heads, matched by hash). Rewriting published history
is the owner's call, not the implementer's.
- **Who decided:** the user (repository owner), asked by the controller.
- **When:** 2026-10-29.
- **Choice:** "keep published history, block it from now on".
- **Options offered:** the controller's message to this lane states the choice
  but does not list the options that were put to the user, so they are not
  recorded here. The controller is asked to add them.
- **Attestation:** the controller relayed this decision to the implementer in
  the cycle-8 instructions. The implementer did not observe the exchange.

The scanner already implements the choice (`367395b`): the tolerated address
passes only on history reachable from the pinned heads; anything newer, and
any other personal address, fails `scan:pii`. No code changed.

### MED-005 — the report overclaimed — ACCEPTED

The report no longer says cycle 7 "repaired all eleven". It states what the
independent review accepted, as above, and calls the use case's isolation
check what it is: a first refusal on the handle's claim, behind which the
runner refuses any handle no sandbox provider made. The numbers it states were
observed in this cycle; the L1 sentinel is written last.

### Mutation checks re-run in this cycle

The mutation checks for `de0fba1`, `946ba77`, `8c3f970`,
`54af435` and `61138bd` were first run before an interruption of this cycle's
session lost their results; they were re-run at `f11d49b` and the numbers above
are from that re-run. The reservation, commit-reconciliation, fencing,
network-isolation and verifier checks were run once, at their commits. In all,
90 mutants: 89 killed, 1 survived (equivalent, under CYCLE7-HIGH-001).

---

## Final review cycle 8 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 8 at `d1d9e7a`
> (`phase-02-final-rereview-codex-v8.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The controller's decisions on it (reconciliation R30) were applied as
> stated. Repairs: repair cycle 9, on `phase/02-single-agent-vertical-slice`
> from `d1d9e7a`. Every disposition, repair, test and mutation check below
> was made and verified by the implementer only; none has been independently
> reviewed. A mutation check applies each mutant to the source, rebuilds when
> the named suites read the mutated package from its build, runs those suites
> and reverts the mutant; "killed" means at least one named test failed.

### What the review accepted, and what it did not

The review marked **RESOLVED**: HIGH-001, HIGH-003, HIGH-004, HIGH-007,
HIGH-008, MED-001, MED-002, MED-003, MED-004, MED-006, MED-NEW-001,
MED-NEW-002, MED-NEW-003, MED-NEW-004, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST,
CYCLE7-HIGH-004, CYCLE7-HIGH-006, CYCLE7-HIGH-007 and CYCLE7-MED-001..004.

It found **PARTIAL**: HIGH-002, HIGH-005, HIGH-006, HIGH-009, MED-005,
CYCLE7-HIGH-001, CYCLE7-HIGH-002, CYCLE7-HIGH-003 and CYCLE7-HIGH-005, and
restated what remained as four new findings, CYCLE8-HIGH-001..004. Of the
implementer's declared limitations it required (a) — a push carried no epoch
and a PR update has no compare-and-set — to be fixed in Phase 2 (CYCLE8-HIGH-003
below) and accepted (b)–(f). It also reported a surviving mutation (the
`--net` alias of `--network`) and that migration 0018 refuses old data.

### Summary

| ID | Restates | Disposition | Commits |
|---|---|---|---|
| CYCLE8-HIGH-001 | HIGH-002, CYCLE7-HIGH-001 | ACCEPTED — fixed | `0ab88f7` |
| CYCLE8-HIGH-002 | HIGH-005, CYCLE7-HIGH-002 | ACCEPTED — fixed | `fdd3226` |
| CYCLE8-HIGH-003 | HIGH-006, CYCLE7-HIGH-003, limitation (a) | ACCEPTED — invariant restated and proven as R30 decides; residuals below | `aa946cf` |
| CYCLE8-HIGH-004 | HIGH-009, CYCLE7-HIGH-005 | ACCEPTED — fixed | `9089154` |
| `--net` alias mutation | CYCLE7-HIGH-005 | ACCEPTED — flags compared by equality with the profile | `9089154` |
| Migration 0018 refuses old data | — | ACCEPTED as designed; documented as needing a fresh database | docs commit |
| MED-005 | report honesty | ACCEPTED — report rewritten | docs commit + sentinel |
| Gate crash (V8, nodejs/node#66366) | limitation (e) | fixed (R26) | `e6ede74` |
| ~30 s timeouts under load | limitation (e) | bounds named and sized from measurements | `bc4cca5` |

Also: `c2c0e12` adds the cycle-8 transcript with its provenance note.

### CYCLE8-HIGH-001 — a genuine handle's flags could still be changed — ACCEPTED

**Invariant:** nothing reachable from a handle or a result can change what
the runner executes.
**Change (`0ab88f7`):** `issue()` froze the handle and its execution record
only at the top level, and the Docker provider put one `labelled` array into
both, so a holder of a genuine handle could `splice` `--network host` into
its `runFlags`. Now the handle, the runner's private record and each result's
provenance hold their own frozen copies; the runner builds `docker run` from
its record only.
**Tests:** `command-runner.test.ts` — "the flags a handle and a result expose
are frozen copies, never the ones the runner executes": the reviewer's probe
as assertions, then `splice`, `push` and index assignment through the handle
and through provenance all throw, and two runs' argv equal the provider's
profile (`buildSandboxRunFlags` plus the sandbox labels, name, working
directory, image and command) byte for byte.
**Mutation check:** 6 mutants, all killed: handle shares the record's flags;
handle's run prefix unfrozen; record keeps the provider's array; the old
shallow freeze; provenance returns the runner's array; provenance copy not
frozen.

### CYCLE8-HIGH-002 — command output references were not protected — ACCEPTED

**Invariant:** every artifact reference in the schema is a scoped key with
checksum and kind that the database checks, and the test finds every one
without a hand list.
**Change (`fdd3226`, migration 0019):** `command_executions.stdout_artifact_id`
and `stderr_artifact_id` get `<name>_sha256` (both or neither), a generated
`<name>_kind` (`command-stdout`, `command-stderr`) and a composite FK to
`artifacts (id, organization_id, project_id, sha256, kind)`. The migration
creates `artifact_reference_columns`, the registry of every artifact
reference, which migrations keep current; it refuses to upgrade over a row
that already names output (no checksum to bind).
**Tests:** `persistence.test.ts` — "the reference registry, the naming
convention and the foreign keys into artifacts agree" (references found by the
`%_artifact_id` pattern, by the registry and by `pg_constraint` FKs into
`artifacts`; every key must carry tenant, checksum and kind); "every
registered artifact reference refuses a missing, foreign, mis-hashed or
mis-kinded artifact" (one subtest per registry row, plus a half-set pair and
an accepted control); "upgrading over command output without a checksum fails
instead of inventing one".
**Mutation check:** 7 mutants, all killed: no stdout FK; stderr FK without
checksum or kind; stdout FK without kind; stdout pairing check dropped; stderr
not registered; stdout kind generated wrong; existing output not refused.

### CYCLE8-HIGH-003 — the epoch narrowed the race and did not fence publication — ACCEPTED

**Restated invariant (R30).** A stale owner — one paused inside a forge call
while its lease lapsed and a successor took its records over — **may still
reach the forge**: nothing recalls a call in flight, and **GitHub offers no
compare-and-set for a PR update** (its REST docs support conditional requests
for `PATCH` only where an endpoint documents them, and "Update a pull
request" documents none; checked by the controller on 2026-10-30). Ownership
is still confirmed immediately before every external call, which refuses an
owner taken over before that point. The guarantee at the forge is **content
idempotence plus push compare-and-set plus reconciliation**; nothing in this
repository is fenced at the forge.
**Change (`aa946cf`):**
- *Push compare-and-set.* `ForgeProvider.pushBranch` takes a required
  `expectedRemoteSha` (`null`: absent); both adapters push the attempt's
  exact commit with `--force-with-lease=refs/heads/<branch>:<expected>`
  (`pushLeaseFor`). `pushStep` always expects absence and always pushes the
  attempt's recorded commit, so a stale owner's late push is a no-op (same
  commit) or refused (`stale info`); it refuses to publish over a branch
  holding another commit (`RemoteBranchDivergedError`). The unused optional
  lease field of `SafeRefspec` is removed: one lease mechanism.
- *Content idempotence.* PR title and body are `pullRequestContent(facts)` —
  task id, attempt id, verified commit SHA, evidence id, base — and nothing
  else. The epoch marker, `StaleFencingEpochError`, `withFencingMarker`,
  `fencingEpochOf`, the read-marker-then-update check and every
  caller-supplied PR title and body are gone; the adapters write exactly the
  title, body and base they are given (an update now also sets the base).
- *Reconciliation.* Before any terminal state `resumeAttemptToReview` runs
  `reconcileBranchStep` (before the push step, for a branch holding another
  commit, and after the PR step) and `reconcilePullRequestStep`: a diverged
  branch is put back on the commit with a lease on the value found; a missing
  PR, or one whose title, body or base differs, is rewritten from the facts.
  Each repair is the new privileged action `forge.reconcile`, audited with
  what was found; the result reports `branchRepaired` and `prRepaired`.
**Tests:**
- The reviewer's interleaving inside the transport (`github-app.test.ts`):
  "owner 1 reads the PR, owner 2 updates it, owner 1 updates it: the PR is
  byte-identical to owner 2's", with the real `GitHubAppForgeProvider` and
  owner 1 held between `pulls.list()` and `pulls.update()`; and "owner 1
  reads no PR, owner 2 opens it, owner 1 tries to open it: still owner 2's one
  PR".
- Push race on a real bare remote (`github-app.test.ts`): "a push is
  compare-and-set at the remote: a late push of the same commit changes
  nothing, of another is refused", including a repair with the lease on the
  found value; the same for the local double (`crash-recovery.test.ts`, "the
  local bare forge takes a push only over the value the branch is expected to
  hold"); the argv carries the lease and never a force.
- `crash-takeover.itest.ts`, real PostgreSQL: the paused owner now reaches the
  forge — its late PR write leaves the successor's PR byte for byte and equal
  to `pullRequestContent`; its late push of the attempt's commit changes
  nothing; a late push of another commit is refused by the remote. Its records
  stay the successor's.
- Steps and use case: `pipeline-steps.test.ts` (content is the facts and
  nothing else; two owners ask for the same PR byte for byte; the push expects
  absence; divergence refused; both reconcile steps, their audit boundary and
  their compare-and-set); `resume-attempt.test.ts` (a diverged branch, and a
  PR changed after the resume's own upsert, repaired before the terminal
  state); `crash-recovery.test.ts` ("a successor rewrites a diverged branch
  and PR from the attempt's facts, each repair on record": audit rows before
  the resumed transition).
**Mutation check:** 19 mutants, all killed: PR body carries the owner's lease;
PR content carries a clock; adapter push without the lease; adapter push with
a bare force; lease without its expected value; lease accepts an abbreviated
value; local double pushes without the lease; push step publishes over a
diverged branch; push step expects the commit instead of absence; branch
repair ignores what it found; branch repair audited as a push; PR repair
audited as an upsert; PR reconcile ignores the base; PR reconcile ignores the
body; resume skips the final reconcile; resume skips the pre-push reconcile;
adapter update keeps the old base; adapter adds a marker of its own; port
lookup drops the PR text.
**Residual:** a stale write that lands after the successor's reconciliation is
not repaired by that resume; by construction it is the same PR content, or the
attempt's own commit (any other commit is refused by the lease). A PR edited
by a writer outside the harness is repaired only by a later resume.
`confirmOwner` still returns the owner's epoch, as a record of who acted; no
forge call carries it.

### CYCLE8-HIGH-004 — the verifier accepted verification missing mandatory levels — ACCEPTED

**Invariant:** the verifier derives the mandatory levels from trusted policy
for the task's authoritative risk, and accepts flags only equal to the trusted
sandbox profile.
**Change (`9089154`):** the pins add `ASEP_VERIFICATION_MATRIX_SHA256`; the
resolver reads `policies/verification-matrix.yaml` only when its bytes hash
to the pin, parses them with `parseVerificationMatrix` and exposes
`verificationPolicy()`. For the task's risk every mandatory level needs a
check recorded mandatory; each check must be at a level the matrix has and of
that level's evidence category; every mandatory check must have passed. The
flags a check ran under are compared whole with the profile — the runner's own
`buildSandboxRunFlags` output, the attempt's tree as the one writable mount
with `.git` read-only over it, the sandbox labels for the attempt — after
normalizing `--flag=value` and the `--net`, `-v` and `-l` aliases.
**Tests:** `verify-pilot-manifest.test.ts` — "a verification that does not
cover every level the matrix makes mandatory for the task's risk is refused"
(includes the reviewer's R1-with-only-L0 probe), "a mandatory check that did
not pass is refused; an advisory check at a level the risk does not require
may fail", "coverage is read from the matrix row of the task's own risk", "a
verification policy that is not the pinned matrix, or is malformed, refuses
every task", "a check whose docker flags are not exactly the verification
sandbox profile is refused" (`--net host`, `--net=host`, `--network=host`
appended or in place, and every added, dropped, changed or reordered flag);
`authority-resolver-sql.test.ts` — "the verification policy is the pinned
matrix and the sandbox profile the command runner builds", "a verification
matrix that does not hash to its pin is never loaded";
`verification.test.ts` — "the matrix parser reads the canonical document and
refuses a malformed one". The positive fixture is R1 with L0, L1 and L2; the
test that accepted a failing advisory L1 now expects the relabelling refused.
**Mutation check:** 16 mutants, all killed: coverage loop skipped; advisory
relabel accepted; coverage from the record's risk; level/category check
dropped; unknown level accepted; mandatory failure accepted; policy pin not
compared; flags compared by prefix only; flags length not compared; `--net`
alias dropped (the reviewer's surviving mutant); `--flag=value` not split;
attempt label read from the record; container not tied to the sandbox; any
working-tree path; resolver does not compare the matrix pin; loader does not
check the matrix hash.
**Note:** the pilot workflow plans L0 and L1 only, so an R1 task stops at
verification for its missing L2; pilot tasks are R0 (runbook §0.2). The
runner needs no flag check of its own: it executes the provider's frozen
profile (CYCLE8-HIGH-001).

### Migration 0018 refuses old data — ACCEPTED

As designed: 0018 (and 0017, 0019) refuses rows it cannot bind instead of
inventing a draft, an artifact or a checksum. No pilot data exists. The data
model and the runbook (§0) now say these migrations need a fresh database or a
separate, reviewed data procedure, and are not a compatible upgrade.

### MED-005 — the report overclaimed — ACCEPTED

The report no longer says every authoritative reference was a scoped key
before 0019, nor that the epoch fenced the forge; it states the takeover
guarantee as above, names its residuals, and records the pilot risk as R0.

### Gate crash and timeouts

- **R26 (`e6ede74`).** Every Node process that runs tests starts with
  `--no-wasm-code-gc` (nodejs/node#66366); a required suite checks the flag
  reaches the test children and every test entry point.
- **Timeouts (`bc4cca5`).** Reproduced under synthetic load (load average
  roughly 55–185) and traced each to its bound: a 10 s test-spec bound, 15 s elapsed
  checks in the agent tests, a 1-minute default budget, a 1.8 s hung-agent
  budget shorter than setup, and a torn read of the fake daemon's records.
  Each bound is now named and sized from the measurements; the production
  bounds (`claude-provider.ts:110`, `container-teardown.ts:42`) never fired.

---

## Final review cycle 9 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 9 at `a447983`
> (`phase-02-final-rereview-codex-v9.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The controller's decisions on it (reconciliation R35) were applied as
> stated. Repairs: repair cycle 10, on `phase/02-single-agent-vertical-slice`
> from `a447983`. Every disposition, repair, test and mutation check below
> was made and verified by the implementer only; none has been independently
> reviewed. A mutation check applies each mutant to the source, rebuilds,
> runs the named suites and reverts the mutant; "killed" means at least one
> named test failed (a mutant that does not compile is not counted).

### What the review accepted, and what it did not

The review marked **RESOLVED**: HIGH-001, HIGH-002, HIGH-003, HIGH-004,
HIGH-005, HIGH-007, HIGH-008, HIGH-009, MED-001, MED-002, MED-003, MED-004,
MED-006, MED-NEW-001..004, CYCLE5-PROVENANCE, CYCLE5-PILOT-TEST,
CYCLE7-HIGH-001, CYCLE7-HIGH-002, CYCLE7-HIGH-004..007, CYCLE7-MED-001..004,
CYCLE8-HIGH-001, CYCLE8-HIGH-002, CYCLE8-HIGH-004, the `--net` alias and R26.

It found **PARTIAL**: HIGH-006, MED-005, CYCLE7-HIGH-003, CYCLE8-HIGH-003 and
the timeout work, and raised CYCLE9-HIGH-001 (a closed or merged PR was
completed and recorded `OPEN`), CYCLE9-HIGH-002 (the integration gate was red
at the reviewed head), CYCLE9-MED-001 (timing assertions no longer proved a
prompt stop), CYCLE9-MED-002 (the documents gave the push compare-and-set a
guarantee that comes from harness pinning) and CYCLE9-LOW-001 (a blank line
at the end of this file). Of the declared limitations it accepted the R30
model for (a) but not the reconciliation guarantee as stated, accepted (b)
fail-closed for Phase 2, and (c) for a pilot-pending verdict. It also showed
that the resume fixtures could not tell the attempt's base from `main`, that
a reference column outside the naming convention, the registry and the
foreign keys escapes the three-way test, and that the crash-takeover executor
child does not carry the wasm flag.

### Summary

| ID | Disposition | Commits |
|---|---|---|
| CYCLE9-HIGH-001 | ACCEPTED — fixed; the reviewer's probes are tests | `a9da83f` |
| Resume base | ACCEPTED — fixtures on `release/2`; the resume reads the base from the binding row | `a9da83f` |
| CYCLE9-HIGH-002 | ACCEPTED — the hung-agent test measures the interval the product bounds; the 80.8 s run's per-phase split is not recorded (below) | `9fc9a30` |
| CYCLE9-MED-001 | ACCEPTED — interval assertions against named product bounds, no 5-minute allowances | `9fc9a30` |
| CYCLE9-MED-002 | ACCEPTED — data model, threat model and runbook restated; report in the docs commit | `d45794c` |
| Schema reference detection | accepted limitation (R35); convention documented | `bcbafc1` |
| R26 scope | accepted (R35); note where `nodeTestArgs()` is defined | `bcbafc1` |
| CYCLE9-LOW-001 | fixed | docs commit |
| MED-005 | report updated | docs commit + sentinel |

Also: `0554860` adds the cycle-9 transcript with its provenance note.

### CYCLE9-HIGH-001 — a closed or merged PR completed to review and was recorded OPEN — ACCEPTED

**Invariant:** only an open, unmerged PR on the attempt's base is a
publication under review. Nothing completes to `WAITING_FOR_HUMAN_REVIEW` or
writes a `pull_requests` row for any other PR, the harness never reopens,
retargets or edits it, and the task fails on record with what was found.
**Change (`a9da83f`):**
- *Port.* `PullRequestRef` gains `state?: 'open' | 'closed'` and `merged?`.
  `upsertPullRequest` opens the PR on the base given, or updates the title
  and body of the open PR on that base; a PR for the head that is closed,
  merged or on another base is returned as found. `findPullRequest` returns
  the PR open, closed or merged, with its state.
- *GitHub adapter.* State and merged come from the pulls API (a listed PR
  reports a merge by `merged_at`, create and update responses by `merged`).
  The open PR for a head wins over an older closed one. The upsert returns a
  closed, merged or other-base PR untouched and no longer sends a base on
  update. The port passes state and merged through. The local double holds
  PRs the same way and gains `closePullRequest` and `retargetPullRequest`.
- *Application.* `pullRequestGap(pr, facts)` names what makes a PR
  unreviewable: merged, closed, a state or merged flag the forge did not
  report (fail closed), or another base. `reconcilePullRequestStep` writes
  nothing to such a PR and reports the gap; the base is no longer repaired.
  `completeToReview` asks the forge for an adopted PR's state and stops with
  the gap. The fresh workflow and `resumeAttemptToReview` fail the task on a
  gap: one `task.status.transition` audit entry with detail `{to: 'FAILED',
  outcome: 'publication-incomplete', reason, found: {number, url, headBranch,
  baseBranch, state, merged}, expectedBase, commitSha}`, the attempt's commit
  and evidence recorded, no PR row. A resumed task already under review is
  left there. The resume reads the attempt's base from the binding row
  (`ResumeAttemptRepositories.bindings`) instead of `ResumeAttemptInput.base`,
  which the composition root had defaulted to `main`.
- *Verifier.* A PR row whose state is not `OPEN` is refused; so is a live PR
  that is merged, closed, of unreported state or merged flag, or whose base is
  not the recorded base. The resolver returns the row's base and state and
  the live PR's base, state and merged flag.
**Tests:**
- The reviewer's `CYCLE9_CLOSED_PR`, through the GitHub adapter, its port and
  the real resume (`crash-recovery.test.ts`, "through the GitHub adapter and
  port, a successor over a PR a human closed|merged fails the task and writes
  nothing"): merged false and true, the PR found by its head after the crash;
  `publication-incomplete`, task `FAILED`, no GitHub write, the PR exactly as
  the human left it, no PR row, one audit row naming the PR found.
- The same over the local forge for a closed, a merged and a retargeted PR,
  with the exact audit detail, and a second resume `not-resumable`; "a run
  whose head branch already has a closed PR fails the task on record and
  opens nothing" for the fresh path; the local forge never reopens, retargets
  or edits such a PR.
- `CYCLE9_VERIFIER_CLOSED_PR` (`verify-pilot-manifest.test.ts`, "a live PR
  that is closed, merged or on another base is rejected"): closed, merged,
  `release/2`, state unreported, merged unreported, and a `CLOSED` row. The
  resolver reports the live state and the row's base and state
  (`authority-resolver-sql.test.ts`).
- `resume-attempt.test.ts`: fixtures on base `release/2`; closed, merged and
  other-base PRs fail the task with the exact audit detail, no PR row and no
  forge write; a stateless PR fails closed; a task under review stays there;
  the PR is opened on the attempt's base. `pipeline-steps.test.ts`: the gap
  cases, reconcile writes nothing to an unreviewable PR, `completeToReview`
  stops on one and asks the forge for an adopted PR's state.
  `github-app.test.ts`: lookups report state and merged; an upsert never
  reopens, edits or duplicates a closed or merged PR and never retargets or
  edits one on another base; the open PR wins over an older closed one.
**Mutation check:** 26 mutants, all killed: gap ignores merged; gap ignores
state; gap ignores base; reconcile writes to an unreviewable PR; completion
ignores the gap; fresh run does not fail the task; resume ignores the gap
(persists `OPEN`); resume fails a task already under review; resume facts
hard-code base `main` (the reviewer's mutant); resume base hard-coded `main`;
adapter upsert writes a closed PR; adapter upsert edits a PR on another base;
adapter drops state; adapter ignores `merged_at`; adapter picks the newest
over the open PR; port lookup drops state; port upsert drops state; local
double edits a closed PR; verifier accepts a merged, a closed, an
unreported-merged and an other-base live PR (4); verifier accepts a non-`OPEN`
row; resolver drops the live state; resolver drops the row's base; resolver
drops the row's state.
**Note:** the domain allows `VERIFYING → FAILED`, but the persisted task row is
`PENDING` until the workflow writes its terminal state (the success path
writes `WAITING_FOR_HUMAN_REVIEW` over it the same way), so the failure is
written from the persisted status without a domain transition check.
`policies/failure-taxonomy.yaml` has no publication class and is unchanged;
the outcome is the audit detail.

### CYCLE9-HIGH-002, CYCLE9-MED-001 — elapsed time instead of the bounded interval — ACCEPTED

**Invariant:** a timing assertion measures an interval the product bounds,
from the product's own signal, against a bound named from the product's
timers plus a stated scheduling allowance; setup is never part of it.
**Change (`9fc9a30`):**
- `ClaudeProviderConfig.observeLifecycle` receives each moment of an attempt:
  `started` (with its deadline), `network-ready`, `proxy-ready`,
  `agent-started`, `stop` (reason `timeout`, `aborted` or `violation`),
  `agent-killed`, `agent-exited`, `agent-removed`, `torn-down`. It is called
  synchronously; what it does or throws changes nothing.
- `DOCKER_CALL_TIMEOUT_MS = 30_000` names the docker-caller bound
  (`container-teardown.ts`); the provider's own docker calls, 60 s before,
  use it too. `AGENT_STOP_BOUND_MS = 2 × DOCKER_CALL_TIMEOUT_MS`: from the
  stop, the agent container is killed by name and removed by name.
- The command runner gets an optional observer (`spawned`, `stop`, `killed`,
  `exited`, `removed`) and `COMMAND_STOP_BOUND_MS = DOCKER_CALL_TIMEOUT_MS`.
**Tests:** a shared assertion in `agent-claude.test.ts` and
`agent-sandbox.itest.ts`: the stop has the expected reason; it came no
earlier than it was due and at most `SCHEDULING_ALLOWANCE_MS` (2 s) after —
due is the deadline (or agent start when setup outlasted it) for the wall
clock, the moment the test delivered the cancellation for an abort; and the
agent was removed at most `AGENT_STOP_BOUND_MS` + 2 s after the stop. The
wall-clock, cancellation and hung-agent tests use it; violation stops assert
the reason and the removal bound; agents that end on their own assert no stop
and removal within one docker call; the killed-client integration test
asserts no stop, the client's end within the allowance of the kill and
removal within one docker call. New: "a docker kill that never answers is cut
at its bound, and the agent is still removed in time" (the kill cut between
30 s and 30 s + 2 s after the stop); "the lifecycle observer sees each moment
of an attempt in order, and one that throws changes nothing"; the runner's
equivalent. The command runner's in-container timeout test asserts its timer
fired when due and the command stopped within one docker call, instead of a
60 s total. The 2 s allowance: every wall-clock stop below came at most 4 ms
after its deadline. The hung-agent integration budget is 45 s (setup took
up to 19.1 s under the heaviest load below); each integration test prints its
timeline to the gate log.
**Mutation check:** 8 mutants, all killed: wall-clock stop 5 s late;
wall-clock stop early (half the remaining budget); cancellation acted on 5 s
late; stop delayed past the product bound (by `AGENT_STOP_BOUND_MS` + 5 s);
docker calls bounded at 120 s instead of 30 s; agent container not removed by
name; a stop that never kills the container; the runner's timeout 5 s late.

**Where the 80.8 s went: not recorded.** At `a447983` the test measured from
just before `execute()` to its assertion, with a 9 s budget whose deadline
counts from the start of `execute()`, setup included. Run 1's log records only
the test's duration (80.8 s), which also includes the test's own fixture setup
and cleanup, and that the status (`BUDGET_EXHAUSTED`) and the wall-clock note
passed. The split of that time between fixture, setup, stop and teardown is
not recorded and cannot be verified. The status does not show that the setup
finished before the deadline: `docker network connect` runs after the proxy is
ready and before the agent starts, can itself run past the deadline, and the
agent's timer then fires after its 1 ms minimum. (An earlier version of this
paragraph attributed about 72 s to the stop and teardown on that inference; the
cycle-10 review showed the log does not support it, and it is withdrawn —
CYCLE10-MED-002.) Whatever the split, the path from the stop to the end of
teardown was bounded at the time only by docker-call timeouts: `docker kill`
of the agent (60 s), its `rm -f` (60 s), the proxy's kill (30 s) and up to 5 s
for its client, the proxy's `rm -f` (60 s), a container sweep of up to 20
tries, `network rm` (60 s) and a network sweep of up to 5 tries — so the 60 s
total the test asserted was below the product's own bound. Reproductions here,
with the new timeline (times after the stop):

| Load | Setup | Stop after due | Agent removed | Torn down |
|---|---|---|---|---|
| idle, load average 3 | 0.35 s | 3 ms | 0.18 s | 0.61 s |
| 24 host and 4 VM CPU burners, 2 container-churn loops, load average 37–79 (2 runs) | 3.0–3.5 s | 1–4 ms | 0.92–1.28 s | 3.6–4.0 s |
| the same plus 6 container-churn and 6 network-churn loops, load average 60–106 (2 runs) | 13.4–19.1 s | 3 ms | 2.9–4.7 s | 11.4–12.3 s |
| full integration gate under 24 host and 4 VM burners, 2 container- and 2 network-churn loops, load average 28–112 | 5.6 s | 3 ms | 1.5 s | 5.5 s |

No reproduction came near the run's 80.8 s: the longest from the deadline to
the end of teardown was 12.3 s. The heaviest setup (19.1 s) would have
outlasted the old 9 s budget. In the same run 1, the command runner's
cancellation-and-normal-exit test took 71.6 s, which fits a window in which
daemon calls ran towards their client timeouts; that is an inference from the
log, not an observation, and it does not say where the hung-agent test's time
went. With the new assertions a stop
delayed within the product's bounds passes and its timeline shows where the
time went; a stop delayed beyond them fails.

### CYCLE9-MED-002 — the documents credited the compare-and-set with the pinning guarantee — ACCEPTED

**Change (`d45794c`, and the report in the docs commit):** the data model,
threat model (T2-01, T2-17, closing summary), runbook (§3.4) and report say:
the lease conditions only on the branch's current value — expecting absence
it accepts any SHA while the branch is absent, expecting the current value it
accepts an update to any SHA; that only the attempt's commit lands comes from
the harness always pushing the attempt's pinned commit; the compare-and-set
makes a stale push of a different SHA fail once the branch exists. The
reconciliation claims match CYCLE9-HIGH-001: only an open PR on the attempt's
base is rewritten; a closed, merged or retargeted PR fails the task on record
and is left as found; the runbook says what an operator sees and what the
verifier requires. The cycle-8 dispositions above keep their original wording
as the record of that cycle.

### Schema reference detection — accepted limitation

Per R35. The data model states the convention (`bcbafc1`): every artifact
reference column is named `<name>_artifact_id` or listed in
`artifact_reference_columns`; the three-way test enforces agreement for every
column it can find by name, registry or foreign key, and cannot find a column
with none of the three. No database constraint ties the registry to the
schema.

### R26 scope — accepted

Per R35. `scripts/lib/node-test-flags.mjs` now says that a test's own child
process decides its flags, that a child loading PGlite must carry the flag,
and that none does: the crash-takeover executor runs against the integration
gate's real PostgreSQL and registers no tests (`bcbafc1`).

### CYCLE9-LOW-001 — trailing blank line — fixed

The blank line at the end of this file is gone; `git diff --check` over the
cycle exits 0.

## Final review cycle 10 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 10 at `5dd2300`
> (`phase-02-final-rereview-codex-v10.md`), verdict **REQUEST_CHANGES** @ 0.98.
> The controller's decisions on it (reconciliation R39) were applied as
> stated. Repairs: repair cycle 11, on `phase/02-single-agent-vertical-slice`
> from `5dd2300`. Every disposition, repair, test and mutation check below
> was made and verified by the implementer only; none has been independently
> reviewed. A mutation check applies each mutant to the source, rebuilds,
> runs the named suites and reverts the mutant; "killed" means at least one
> named test failed or was cancelled by its own timeout (a mutant that does
> not compile is not counted).

### What the review accepted, and what it did not

The review marked **RESOLVED**: CYCLE9-HIGH-002 (both controller integration
runs green at `5dd2300`), CYCLE9-MED-002, CYCLE9-LOW-001, the resume-base
mutation, the schema reference convention and R26. It found **PARTIAL**:
CYCLE9-HIGH-001, CYCLE9-MED-001, HIGH-006, MED-005, CYCLE7-HIGH-003,
CYCLE8-HIGH-003 and the timeout work, and raised CYCLE10-HIGH-001
(completion checked one PR and returned another), CYCLE10-HIGH-002 (the
removal bound measured a client's return, not the container's absence),
CYCLE10-MED-001 (the documents promised a closed PR is never edited; a
surviving `state: 'open'` mutation), CYCLE10-MED-002 (the 72 s attribution
of the 80.8 s run had no evidence) and CYCLE10-MED-003 (an ambiguous network
create skipped its cleanup). Per R39 the declared limitations (2), (3) and
(4) are accepted as Phase 2 limits: the failure written from the persisted
`PENDING` status without a domain transition check, a PR closed after its
task reached review, and the hung-agent test's setup inside its 45 s budget
as a test condition, not a product SLA.

### Summary

| ID | Disposition | Commits |
|---|---|---|
| CYCLE10-HIGH-001 | ACCEPTED — completion and resume read the PR back after its record and bind it to the record; the probes are tests | `2cbf335` |
| CYCLE10-HIGH-002 | ACCEPTED — removal reported only once shown gone, within a named bound; the 91 s case is a red test; runner itest bounded | `3fbfb9b` |
| CYCLE10-MED-001 | ACCEPTED — update payload key set asserted; the fake applies `state` and `base`; the human interleavings are tests; residual race stated | `6ad22d3` |
| CYCLE10-MED-002 | ACCEPTED — the 72 s attribution withdrawn; the split is not recorded | `53f966f` |
| CYCLE10-MED-003 | ACCEPTED — named and labelled before every create, swept whatever the answer | `4159b19` |
| Gate failure in this cycle | fixed — bounded moments read from a monotonic clock | `6608d21` |
| Limitations (2), (3), (4) | accepted as Phase 2 limits (R39) | report |
| MED-005 | report updated | docs commit + sentinel |

Also: `399a634` adds the cycle-10 transcript with its provenance note.

### CYCLE10-HIGH-001 — completion checked one PR and returned another — ACCEPTED

**Invariant:** what completion returns, and the workflow and the resume
persist, is the PR the forge showed after the attempt's `pr-upsert` record,
checked against that record — never the upsert's answer or the record
itself. A different PR on the branch, a mismatch, or a change between the
upsert and that read ends `FAILED / publication-incomplete` with an audit
entry.
**Change (`2cbf335`):**
- `publicationGap(observed, recorded, facts)`: the PR shown for the branch
  must be the recorded one (number, url, head branch, base branch), open,
  unmerged, on the attempt's base (`pullRequestGap`), and its head commit
  must be the attempt's commit; nothing shown, another PR, a head commit the
  forge did not report, or another commit is a gap.
- `reconcilePullRequestStep` takes the record (`recorded`), checks before
  any write, writes only to the recorded, reviewable PR (title and body from
  the facts, audited `forge.reconcile`), reads it back after a write and
  returns that observation. It no longer creates a missing PR. *(Correction,
  repair cycle 12: the check named the recorded PR, but the write went
  through the branch-keyed upsert, which selected the branch's PR again and
  could write another PR a human had opened there, or create one; see
  CYCLE11-HIGH-001 below.)*
- `completeToReview` runs it after the upsert (fresh and adopted alike) and
  returns the observation as `pr`, the record as `recorded`, and stops
  `upsert-pr` with the gap. `resumeAttemptToReview` runs it with the record
  in place of its number check (which threw) and persists the observation.
- The workflow fails the task on any gap, with or without a PR shown. The
  audit detail gains `recorded: {number, url, headBranch, baseBranch}` and
  `found.headSha`; `found` is `null` when nothing was shown.
**Tests:**
- `CYCLE10_REAL_ADAPTER_REPLACEMENT` through the GitHub adapter, its port and
  the real run and resume (`crash-recovery.test.ts`, "a successor that finds
  another PR on the attempt's branch fails the task and writes nothing"):
  the executor dies after PR #1 is recorded; a human closes #1 and opens #2
  on the same head; the successor adopts #1 from its record, the forge shows
  #2: `publication-incomplete`, task `FAILED`, GitHub writes only the
  original `create`, both PRs as left, no PR row, the audit row names #2 as
  found and #1 as recorded. The same at the resume level and the pipeline
  level (`resume-attempt.test.ts`, `pipeline-steps.test.ts`).
- `CYCLE10_FRESH_PR_CHANGED_DURING_RECORD`: a log whose `complete('pr-upsert')`
  lets a human close, merge, retarget or move the PR stops completion with
  the gap (`pipeline-steps.test.ts`); through the adapter and port, a PR a
  human closes, merges or retargets right after it is opened fails the run
  with the exact audit detail and no PR row, and a PR the forge no longer
  shows fails it with `found: null` (`crash-recovery.test.ts`).
- Completion returns the very observation it checked, not the upsert's
  answer; `publicationGap` cases (number, url, head, base, state, head commit
  wrong or unreported); reconcile writes nothing to another PR and creates
  none; a PR closed between the repair's write and its read-back is a gap
  with that observation returned. Forge doubles report a PR's head commit
  as GitHub does (the branch tip, learned from the pushes).
**Mutation check:** 12 mutants, all killed: completion returns the upsert's
answer; number, url, head branch or recorded base not bound (4); head commit
not bound; an unreported head commit accepted; no read-back after a repair;
identity checked only after the write; completion reads only the upsert's
answer; the workflow fails the task only when a PR was shown; the resume
persists despite another PR.
**Limitation:** the forge may update a PR's head commit asynchronously after
a push; a read that lands before GitHub has caught up is a gap, failing the
task closed rather than completing it.

### CYCLE10-HIGH-002 — the removal bound measured the client, not the container — ACCEPTED

**Invariant:** a container is reported removed only once the daemon shows it
gone, and only within a named bound; a removal not shown in time is a
failure of the attempt or the run, and a timing assertion sees it.
**Change (`3fbfb9b`):**
- `removeContainerShownGone(docker, name, until)` (`@asep/command-runner`):
  `docker rm -f`, then `docker inspect --type container`, which must answer
  "No such container" — after a successful or a failed rm; tried again while
  time is left, no try started past `until`, every call cut at what is left
  (`DockerCall` takes a per-call timeout). `removeLabelledContainers` takes a
  deadline the same way.
- Agent: `AGENT_REMOVAL_BOUND_MS` (one docker-call timeout) after the client
  ended, never past `AGENT_STOP_BOUND_MS` (kill plus removal, still 60 s)
  after a stop (`agentRemovalDeadline`). `agent-removed` is emitted only once
  shown gone; otherwise the container is a leftover and the attempt fails
  closed.
- Runner: `COMMAND_REMOVAL_BOUND_MS` (one docker-call timeout) after the
  client ended; `removed` is emitted only when `docker ps -a` lists no
  container with its label; otherwise `SandboxTeardownError`.
- The fake docker emulates `inspect --type container`.
**Tests:**
- The reviewer's `CYCLE10_REMOVAL_ORACLE`, as a deterministic double: the
  removal path on virtual time, through the product's deadline and removal
  helper, with the kill cut at 30 s and the container gone only at 91 s
  (slow retries of 5 s, and fast ones): no `agent-removed`, and the stop-bound
  assertion is red; a removal reported at 91 s is red too; one gone at 45 s
  is shown, reported and green (`agent-claude.test.ts`). The same deadline
  behaviour for both helpers (`command-runner.test.ts`).
- A daemon that keeps the agent while answering its rm with success: never
  reported removed, attempt `FAILED`. One whose inspect never answers: fails
  at the bound. One whose rm errs after removing: shown gone, reported. The
  removal is reported after the inspect, not the rm. The runner's refused
  and hung removals: no `removed`, `SandboxTeardownError`, the hung one at
  its bound.
- Integration: `sandbox-exec.itest.ts` bounds `exited → removed` by
  `COMMAND_REMOVAL_BOUND_MS` and `stop → removed` by the stop and removal
  bounds, each plus the 2 s allowance; `agent-sandbox.itest.ts` bounds the
  killed-client case by `AGENT_REMOVAL_BOUND_MS`, and its stop-bound
  assertion now runs to the proven moment.
**Mutation check:** 8 mutants, all killed: provider reports removal without
proof; a successful rm counts as proof; provider removal without a deadline
(cancelled by the test's timeout); deadline ignores the stop bound; by-name
calls not cut at the deadline; runner reports removal without proof; runner
removal without a deadline (cancelled by the test's timeout); label removal
ignores its deadline.

### CYCLE10-MED-001 — "never edited" was more than the adapter can promise — ACCEPTED

**Invariant:** the harness never reopens or retargets a PR — its update
carries the PR's name, title and body and nothing else; it does not write a
PR it reads closed, merged or on another base. A human acting between that
read and the write still receives the title/body write: a residual
read/write race GitHub offers no compare-and-set to close (R30).
**Change (`6ad22d3`):** the fake pulls API applies `state` and `base` when an
update carries them (a merged PR cannot be reopened) and records each
update. Adapter and local-double comments, data model, threat model (T2-17
and its summary), runbook §3.4 and the report state the residual race; the
completion read after it (CYCLE10-HIGH-001) fails the task. The cycle-9
dispositions above keep their original wording as the record of that cycle.
**Tests:** the update's key set is exactly `owner, repo, pull_number, title,
body`, on the plain update and in each interleaving; a human closes, merges
or retargets the PR between `pulls.list()` and `pulls.update()`: the PR is
neither reopened nor retargeted, no second PR is opened, and the title and
body land on it as the human left it (`github-app.test.ts`).
**Mutation check:** 3 mutants, all killed: the reviewer's `...{ state: 'open' }`
in the update; a `base` in the update; any other extra field.

### CYCLE10-MED-002 — the 72 s attribution — ACCEPTED

Withdrawn (`53f966f`). The cycle-9 section above now says the 80.8 s is the
whole test, fixture setup and cleanup included, that the per-phase split is
not recorded and cannot be verified, and that the status does not show the
setup finished before the deadline (`network connect` runs after the proxy is
ready and can run past it). The report says the same.

### CYCLE10-MED-003 — an ambiguous network create skipped its cleanup — ACCEPTED

**Invariant:** every network and container the harness asks the daemon for
is named and labelled before it is asked for, and is removed by that name
and swept by that label whatever the create answers; only a client that
never started asked for nothing.
**Change (`4159b19`):** the agent network is marked created before
`network create`; a create whose client never started is not; a failed
create says why; the teardown's `network rm` of a network that was never
made is not a teardown note. Every other create of the class: the egress
proxy is marked created before its client is spawned (it was set right
after, synchronously); the agent container already was; the command
runner's verification container is named and labelled before its client and
is now removed also when the client errs after it started (previously only
on `close`); the integration gate's backends are named before `docker run`
and removed by name in `finally` (unchanged); no volume is created anywhere;
the agent itest's own upstream network, model container, host service and
probe network are removed by name when their create fails.
**Tests:** a create that errs, or whose client is cut at its timeout, after
the daemon made the network: removed by name, swept by label, nothing left,
no false note; a refused create: swept, no false note; a docker binary that
cannot start still fails with its own reason (`agent-claude.test.ts`).
**Mutation check:** 3 mutants, all killed: the network marked created only
after a confirmed create (the old code); an unstarted client counted as a
create; a missing network reported not removed. Not mutation-checked: the
runner's removal after a client error (no test seam produces a client
`error` after a successful spawn), the proxy flag's order (equivalent: it
was already set synchronously at spawn), and the itest fixtures.

### A gate failure in this cycle — moments read from the wall clock

`pnpm verify:all` at `937d25e` failed one of 847 tests: "a docker kill that
never answers is cut at its bound" measured the hung kill cut 29 942 ms after
the stop, 58 ms inside its 30 000 ms timer. That timer runs on the monotonic
clock and is armed after the stop moment is read, so on one clock the
interval cannot be shorter than 30 s; the moments were read from
`Date.now()`, which a wall-clock correction moves (the host's clock measured
144 ms off `time.apple.com` shortly after). A plain test of the alternative
(work in the same event-loop iteration making a timer fire early) fired on
time and is ruled out.
**Change (`6608d21`):** `monotonicNow()` (`@asep/command-runner`) — the wall
clock at the process's start plus monotonic time since — is read for every
bounded moment: the agent's start, deadline, lifecycle moments, removal
deadline and wall-clock usage (rounded), the runner's lifecycle moments and
removal deadline, and the removal helpers' real clock. Tests read the moments
they compare from the same clock; the inspect-before-report test now records
what the fake docker had been asked at the moment of the report rather than
comparing timestamps across processes (it had failed once that way after the
clock change). The cannot-show-removal test bounds only from below; the
teardown after the removal is not product-bounded and slows with host load
(one run under load took 79 s), so its upper bound is the test's timeout,
and the removal deadline itself is pinned by the deadline and virtual-time
tests.
**Tests:** `Date.now()` set back a minute mid-attempt and mid-run: the stop
is still on time and the moments in order (`agent-claude.test.ts`,
`command-runner.test.ts`).
**Mutation check:** 2 mutants, both killed: the provider's moments read from
`Date.now()`; the runner's moments read from `Date.now()`.

## Final review cycle 11 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 11 at `42b6d78`
> (`phase-02-final-rereview-codex-v11.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The controller's decisions on it (reconciliation R43, with R42 recording the
> red gate run) were applied as stated. Repairs: repair cycle 12, on
> `phase/02-single-agent-vertical-slice` from `42b6d78`. Every disposition,
> repair, test, measurement and mutation check below was made and verified by
> the implementer only; none has been independently reviewed. Mutation checks
> work as in the cycle-10 section.

### What the review accepted, and what it did not

The review marked **RESOLVED**: CYCLE10-HIGH-002, CYCLE10-MED-001,
CYCLE10-MED-002, CYCLE10-MED-003, the `state: 'open'` mutation,
CYCLE9-HIGH-001 and CYCLE9-MED-001. It found **PARTIAL**: CYCLE10-HIGH-001,
HIGH-006, CYCLE7-HIGH-003 and CYCLE8-HIGH-003 (all by CYCLE11-HIGH-001),
MED-005 and the timeout work (by the red gate run), and raised
CYCLE11-HIGH-001 (reconcile's repair could write a PR that replaced the
recorded one, or create one), CYCLE11-HIGH-002 (one of the controller's two
`verify:all` runs at `42b6d78` was red) and CYCLE11-MED-001 (no test held the
difference between an inspect error and absence). On the declared concerns:
(2), the runner's client error after spawn, needs a regression test; (3), the
head-SHA lag, is accepted as a Phase 2 limit (R43), with the runbook stating
its symptom and recovery.

### Summary

| ID | Disposition | Commits |
|---|---|---|
| CYCLE11-HIGH-001 | ACCEPTED — the repair is one update of the recorded PR by its number; no list, no selection, no create; both probes are tests | `fab5760` |
| CYCLE11-HIGH-002 | ACCEPTED; the stall located in Node launch on the host, not fixed in the repository (its cause a strong hypothesis, not proven; wording corrected in repair cycle 13) — every docker call reports its signal, duration and bound, and every removal failure its calls; the one unbounded docker call is bounded; with that evidence two red runs at `7017cfc` and a probe beside one show a Node launch held up to 40.7 s on the host (by its launch-policy check: a strong hypothesis, not proven); no bound raised, fault 3 unchanged | `a375f1e`, `bd08654` |
| CYCLE11-MED-001 | ACCEPTED — inspect and ps errors are tests for agent and runner; the `/./` mutant is killed | `056457a` |
| Concern 2 (runner client error after spawn) | ACCEPTED — a spawn seam; the probe is a test | `056457a` |
| Concern 3 (head-SHA lag) | accepted as a Phase 2 limit (R43); runbook | `7017cfc` |
| Test polling bounds | moved to the monotonic clock, with two lease waits of the same kind | `a8f45ca` |
| The loosened assertion in `6608d21` | named below | `7017cfc` |
| MED-005 | data model, threat model and runbook in `fab5760`; review log and report | `7017cfc`, `9585d33`, the report commit |
| Gate failures in this cycle | `c67b25b` failed format-check, fixed; `7017cfc` failed twice by the Node-launch stall on the host (CYCLE11-HIGH-002), not changed | `52d4d62` |

Also: `c67b25b` adds the cycle-11 transcript with its provenance note.

### CYCLE11-HIGH-001 — the repair could write a PR that replaced the recorded one — ACCEPTED

**Invariant:** reconcile writes only the attempt's recorded PR, named by its
number; it lists nothing, selects nothing and creates nothing. The one write
that can still land after its check is that PR's own title and body, after a
human closed, merged or retargeted it (R30's race); the read after the write
then fails the task.
**Change (`fab5760`):**
- Forge port: `updatePullRequestContent(scope, {repositoryBindingId, number,
  title, body}): Promise<PullRequestRef>` — the title and body of one PR, by
  its number; an unknown number is an error, never a create.
- GitHub adapter: `GitHubAppForgeProvider.updatePullRequestContent` sends one
  `pulls.update` of `{owner, repo, pull_number, title, body}`, under the same
  JIT credential loop as every operation (`ForgeOperation` gains
  `'pr-update'`); a number that is not a positive whole number calls nothing.
  `GitHubAppForgePort` translates it. The local doubles write the PR by its
  number in whatever state it is in.
- `reconcilePullRequestStep` calls it with `recorded.number` and keeps its
  read afterwards; the branch-keyed upsert is no longer reachable from it.
- The fitness rule against direct forge calls in a composition root covers the
  new write.
**Tests (failing first on `42b6d78`):**
- Pipeline: between reconcile's check and its write a human closes #7 and
  opens #8 on the branch — the old code wrote `update:8`; now the one write is
  `update:7`, #8 is as the human opened it, the gap names #8. The forge stops
  listing the PR between the check and the write — the old code created #8;
  now the write is `update:7` and the gap is "shows no pull request".
- The reviewer's `CYCLE11_COMPLETION_REPAIR_REPLACEMENT` and
  `CYCLE11_RECONCILE_MISSING_BETWEEN_READ_AND_UPSERT`, through the GitHub
  adapter and port on a fresh run (`crash-recovery.test.ts`): a stale owner's
  title lands on #1 after it is opened; right after the run's check, a human
  closes #1 and opens #2, or GitHub stops listing #1. The old code wrote
  `['create', 'update:2']` and `['create', 'create']`; now the write log is
  `['create', 'update:1']` and never names #2, #2 is untouched, no PR is
  created, and the run ends `FAILED / publication-incomplete` with the found
  and recorded PR audited and no PR row.
- Adapter: the update by number is one PATCH with exactly that key set, no
  list and no create, and leaves another PR on the head untouched; a number
  GitHub does not hold fails with its 404 and creates nothing; a number that
  is not a positive whole number calls nothing; the re-mint table covers it.
  Port: the update goes to the named PR only, in the port's ref shape; a
  binding of another tenant is refused.
- Existing repair tests now assert the update by number and no upsert; the
  resume's repair is one `forge.pr.update`.
**Mutation check:** 5 mutants, all killed: reconcile repairs through the
branch-keyed upsert (7 tests red, the reviewer's two probes among them); the
update also sends `state: 'open'`; any number accepted; the adapter selects
the head's open PR by a list first; the fitness rule misses the new write.
**Port delta for Lanes A and B:** `ForgeProvider` has a fifth, required
method, `updatePullRequestContent`; every implementation (production port,
local doubles, test doubles) needs it. `GitHubAppForgeProvider` gains the
method and the `UpdatePrContentInput` type; `ForgeOperation` gains
`'pr-update'`. `upsertPullRequest`, `findPullRequest`, `resolveRef` and
`pushBranch` are unchanged.

### CYCLE11-HIGH-002 — the gate was red at the reviewed head — ACCEPTED; the stall located in Node launch on the host

**Evidence.** Controller run 2 at `42b6d78`: fault 3 rejected with
`SandboxTeardownError … could not be shown removed in time: docker ps failed:
exit null` after 71.1 s, and "a crash between the commit and its evidence"
passed after 69.3 s (5.1 s in run 1). Its canonical test step took 422 s
against 351 s in run 1 (R43's "176 s" is not in run 1's log; 175.9 ms is the
duration of another step). In run 2 no other test stands out against run 1.
The canonical runner runs two test files at a time
(`ASEP_TEST_CONCURRENCY`, default 2); `crash-recovery.test.ts` and
`pilot-faults.test.ts` are adjacent in its sorted list, so the two slow tests
were the two running together: the slow window covered exactly what ran in
it. `exit null` with empty stderr is a client ended by a signal; the old
caller recorded neither the signal nor who sent it, nor any time.

**Step 1 — evidence (`a375f1e`).** Every docker client call of a sandbox goes
through `dockerCaller`, whose result now carries the signal that ended the
client and a `DockerCallRecord`: the call's first words, when it was spawned,
how long the spawn and the call took, the bound it was given and, when its
caller killed it at that bound, when the kill ran. A removal that cannot show
its container gone reports every call it made (`ps -aq at +0ms: signal SIGKILL
after 30004ms (spawn 3ms, bound 30000ms, cut at 30001ms)`) beside its last
reason; the runner's teardown error adds how the command's client ended,
after how long, and how soon the removal followed. The agent's setup calls go
through the same caller and say how they ended; a proxy that never becomes
ready says how long it was waited for against its bound and whether its
client wrote anything. Mutation check: 8 mutants (signal, cut, either
removal's call list, the runner's client line, the setup timing, the proxy's
wait and bound), all killed; the last survived at first, and its test now
asserts the bound it reports.

**Step 2 — reproduction under synthetic load.** Local tools only: Node CPU
burners (`for (;;) {}`), Node fsync burners (rewriting a 256 MiB file in
8 MiB chunks, `fsync` after each), and concurrent copies of
`node --test --test-concurrency=2 pilot-faults.test.ts crash-recovery.test.ts`,
with host samples every second; for the traced rounds a temporary,
uncommitted trace recorded each call's record and, inside the fake docker
client, when its Node process started and when its script began and ended.

| Load | Runs | Failed | fault 3 | crash between commit and evidence | docker calls (traced) |
|---|---|---|---|---|---|
| 3 copies, 8 CPU burners (load average up to 125) | 3 | 0 | 16.0–17.8 s | 7.0–7.9 s | not traced |
| 4 copies, 16 CPU burners, 2 rounds (load average up to 104) | 8 | 0 | 20.9–25.7 s | 9.2–12.6 s | 768: p50 158 ms, p99 1.6 s, max 4.0 s |
| 3 copies, 4 CPU and 4 fsync burners, 2 rounds | 6 | 0 | 28.4–32.1 s | 17.1–22.4 s | 336 (first round): p50 205 ms, max 1.3 s |
| 3 copies, 8 CPU and 4 fsync burners | 3 | 0 | 43.0–45.5 s | 14.0–15.0 s | 288: p50 185 ms, p99 3.1 s, max 6.1 s |

Reproduction rate before any change past the instrumentation: **0 of 20
runs**. Probes beside these: under 16 CPU burners, the first exec of a freshly
written shim costs no more than a repeat (shell 10–23 ms, Node 51–83 ms); a
storm of back-to-back Node launches makes a launch 61–316 ms; under four fsync
burners a file create and rename takes 131 ms on average (359 ms at most, from
under 1 ms idle) and one loop of append, write and rename took 8.2 s. The
host during these runs: 8 CPUs, 16 GB, 6.4–6.5 of 7.2 GB swap in use, about
4.4 GB compressed, and the data volume 97% full (6.7 GB free). Memory
pressure was not added: with that little swap and disk left it could have
starved every other process on the host.

**Step 3 — where the time goes.** Under every synthetic load the docker calls
stayed short: the longest was 6.1 s, almost all of it between the spawn and
the fake client's Node process starting (`exec → node`: p50 58–93 ms, worst
5.9 s); Node's own start-up took at most 377 ms, the client's work at most
253 ms, and the caller saw it close within 338 ms. The slowed tests spent
their time in their own work. Those loads did not reproduce the stall because
they did not exercise its cause, which two red runs of this cycle, read with
step 1's timeline, and a probe beside the second showed:

- `pnpm verify:all` at `7017cfc` (documentation only; the code is `a8f45ca`'s)
  failed twice, 867 of 869 each time. First run (15:38–15:45, 414 s): "a crash
  between the commit and its evidence" and fault 5 of the rehearsal — the two
  test files running together — both rejected with
  `docker sandbox unavailable: docker CLI or daemon not reachable: version --format at +0ms: signal SIGKILL after 30004ms (spawn 0ms, bound 30000ms, cut at 30003ms)`
  (30002 ms for fault 5). Second run (16:00–16:08, 458 s): "a removal whose
  docker ps fails with permission denied …" with the same `version` line
  (30003 ms), and "G3: the tool-call budget is enforced while the agent runs"
  ended `FAILED` instead of `BUDGET_EXHAUSTED` after 69.9 s (the assertion
  does not print the attempt's reasons). In each timeline the client started
  at once (`spawn 0ms`) and was still running when its caller killed it at its
  bound: the time went into the fake docker client itself, a `/bin/sh` script
  that execs Node, whose work for `version` is a few file writes.
- A probe ran beside the second run: once a second it started `node -e 0`,
  the same through `/bin/sh`, the tests' fake docker `version`, `/bin/sh -c :`
  and `/usr/bin/true`. From 16:02:04 to 16:03:10 every Node launch, in all
  three forms, took 4.6–40.7 s, while `/bin/sh` and `/usr/bin/true` launched
  in at most 173 ms at the same moments. The delayed launches finished in the
  order they started until about 16:02:51; those started from 16:02:17 on all
  finished together at about 16:03:07: a queue served one at a time, then
  released. The same probe saw two more such windows (41.6 s at 16:10, after
  the run, and 35.1 s at 16:17 during a canonical test run that passed).
- The kernel log names the queue. Every launch of `/usr/local/bin/node`
  (signed Developer ID Application: Node.js Foundation) is reported by
  AppleSystemPolicy — "Validation category (6) does not match top-level policy
  match (3)", "Notifying syspolicyd about /usr/local/bin/node with PID …",
  "Security policy would not allow process" — and syspolicyd records a
  Gatekeeper policy-violation event for each; `/bin/sh` and `/usr/bin/true`
  are not reported. Each long window came with a burst of Node launches on
  the host: 17,100 in 15:42:40–15:43:00, just before the first red run's
  probes were cut; 16,104 in 16:02:00–16:02:30, the probe's 16:02 window;
  about 17,000 in 16:09:40–16:10:10 and about 18,000 in 16:17:00–16:17:50.
  Smaller bursts, 1,000–2,400 launches per 10 s, gave the probe waits of
  0.8–1.7 s. The 16:02 backlog cleared at about 16:03:07, roughly 240 launches
  a second. syspolicyd ran at 41–78% CPU when sampled. From 15:43:00 to
  15:43:28, while the first red run's two test files each waited in its
  probe, only two Node launches every 5 s, at a fixed rhythm, reached the log:
  whether launches wait in one queue or one per launching process is not
  established.
- Who launches Node in those bursts is not established either. The lane's own
  canonical run starts about 1,350 fake docker clients in five minutes
  (counted in a traced run); bursts came while it ran and while nothing of
  the lane's but the probe ran (16:09:40–16:10:10). A burst of 400 or 1,500
  Node launches made here (at most 118 a second) left no backlog once it
  ended. A larger one was not made: it would hold every Node launch on this
  shared host for tens of seconds, other sessions' included.

**Cause.** *Corrected in repair cycle 13 (R47): this paragraph first stated
the launch-policy queue as the cause found. The evidence supports less, as
follows.* Measured: on this host a new Node process waited up to 40.7 s before
it ran, while `/bin/sh` and `/usr/bin/true` launched in at most 173 ms at the
same moments. The tests' docker clients are Node processes, so a docker call
that falls in such a window exceeds its 30 s bound, whichever test makes it. A
strong hypothesis, not proven: that the host's launch-policy check holds the
launches and serves them one at a time. The kernel log shows a notification
for each Node launch, and the delayed launches were released together, but
the log does not record when each policy request began and ended, and no
control run with the policy exemption was made. Unknown: what makes the
bursts of Node launches. They may include this repository's own tests — the
fake docker client is a Node launch per call and starts a Node process per
container — and concurrent lanes on the host. Controller run 2 at `42b6d78` fits: a
`docker ps` killed with empty stderr, and the test beside it slowed by about
65 s while its first docker call — then unbounded — waited the queue out. Its
window has rolled out of the kernel log (about an hour is kept on this host),
so that run cannot be checked. The `21aeb0d` failure (the egress proxy, a
Node process, not ready in time) is the same class by the same reasoning, also
not checkable now. No bound is shown wrong: the delay is outside the process,
not load on it, and no bound that keeps its meaning covers it.

**What would fix it.** If the hypothesis holds, the fix is on the host, outside this lane's reach:
launch the gates from a process the launch policy does not assess (macOS lets
an operator add a terminal or agent host under Privacy & Security ›
Developer Tools; untested here, as it is a system setting this lane may not
change), or keep Node-launch bursts off the host while a gate runs. A
repository change could remove the dependency only by making the fake docker
client something other than one Node launch per call — one long-lived fake
daemon per test and a client in `/bin/sh` — a redesign of the test fixture,
not made in this cycle and left to the controller.

**What was fixed (`bd08654`).** The one docker call outside `dockerCaller`:
the `docker version` probe a sandbox makes before it starts ran through
`execFile` with no timeout and the whole process environment. It is now a
bounded call with the client environment, and a refusal says how it ended.
Test: a variable set in the test process does not reach the probe, and an
unreachable daemon is refused with the call's end, duration and bound.
Mutation check: the probe given the whole environment; the refusal without
how the probe ended — both killed. In production the bound covers a CLI that
hangs. Under this host's queue it turns
a slow pass (crash-between took 69.3 s in controller run 2) into a failure at
the bound, which states what happened: the docker client did not answer in
time.

**Not changed.** No bound was raised. Fault 3 keeps its assertion.

**Step 4 — after.** The same burners and copies, one round each, untraced, at
`a8f45ca` (every code and test change of this cycle):

| Load | Runs | Failed | fault 3 | crash between commit and evidence | peak load average |
|---|---|---|---|---|---|
| 3 copies, 8 CPU burners | 3 | 0 | 19.6–19.9 s | 10.7–10.8 s | 43 (125 before) |
| 4 copies, 16 CPU burners | 4 | 0 | 25.5–26.3 s | 12.8–13.0 s | 45 (104 before) |
| 3 copies, 4 CPU and 4 fsync burners | 3 | 0 | 23.6–24.1 s | 21.2–22.3 s | 37 (28 before) |
| 3 copies, 8 CPU and 4 fsync burners | — | — | — | — | stopped |

Reproduction rate after, under synthetic load: **0 of 10 runs**. The fourth
load did not complete: the data volume filled while it ran (other work on the
host had taken its free space from 6.7 GB to about 1 GB, and the fsync burners
write 1 GiB), three burners and the three test copies failed with `ENOSPC`,
and the round was stopped and its files removed. Its failures are the disk's,
and it is not counted. These loads are not the cause, so these rates say
nothing about it. The rate that does: of the canonical test runs on this host
in this cycle after the instrumentation landed — `verify:all` at `a375f1e`,
`bd08654`, `056457a`, `a8f45ca` and twice at `7017cfc`, and two canonical test
runs at `7017cfc` beside the probe (one with the temporary trace) — **2 of 8
failed**, both by this queue. The fix above has not been applied, so there is
no rate after it.

### CYCLE11-MED-001 — inspect errors were not held apart from absence by any test — ACCEPTED

**Invariant:** only "no such container" from `docker inspect` (agent), or a
`docker ps -a` that lists none (runner), shows a container gone; a call that
fails with anything else on stderr is no answer, and the attempt or run
fails with no removal marker.
**Tests (`056457a`):** for each of permission denied on the daemon socket, no
daemon, and an unrelated daemon error: the agent's attempt fails with
`docker inspect failed: <that error>` and no `agent-removed`; the runner's run
fails with `docker ps failed: <that error>` and no `removed`; the helpers
never take such an answer for absence, after an rm that succeeded or failed
(virtual time).
**Mutation check:** the reviewer's `NO_SUCH_CONTAINER = /./` (4 tests red); a
failing `ps` taken as an empty listing (4 red).

### Concern 2 — the runner's client error after spawn — ACCEPTED

The runner takes the function that starts a command's client (`SpawnClient`,
default node's `spawn`), so a test can make a client fail after it started
(`056457a`). The reviewer's `CYCLE11_RUNNER_CLIENT_ERROR` is a test: the
client reports an error and dies while its container runs; the run asks
`version`, `run`, then `ps`, `rm`, `ps`, reports the container removed once
shown gone, and throws the client's own error. A client that never started
makes no docker call. Mutation check: no removal after a client error; a
removal for a client that never started — both killed. This closes the gap
the cycle-10 MED-003 entry left ("not mutation-checked: the runner's removal
after a client error").

### Concern 3 — GitHub's head SHA can lag a push — accepted as a Phase 2 limit (R43)

Fail closed is the intended behaviour. The runbook (§3.4) states the symptom
(a `publication-incomplete` failure whose reason names another head commit,
while the PR shows the attempt's commit when looked at later) and the
recovery (run the work order as a new task), and asks the pilot to log each
occurrence so its rate is measured.

### Test polling bounds — moved to the monotonic clock

The four helpers the review named (`agent-claude.test.ts`,
`agent-sandbox.itest.ts`, `command-runner.test.ts`, `sandbox-exec.itest.ts`)
and the two lease waits of `crash-takeover.itest.ts`, the same kind, measure
their waits with `monotonicNow()` (`a8f45ca`).

### The assertion loosened in `6608d21`

`6608d21` removed the upper bound (`AGENT_REMOVAL_BOUND_MS + 15_000`) on the
whole teardown in "G3: an agent removal the daemon cannot show within its
bound fails the attempt at the bound" (`agent-claude.test.ts`). The reason: the
teardown after the removal — the proxy's kill and removal, the label sweeps,
the network — is not bounded by the product and slowed with host load (one
run took 79 s). The test keeps its lower bound (the removal was given its
whole bound) and its 120 s timeout. Each step's own bound is held by
virtual-time tests instead: "G3: the agent removal deadline is its bound
after the client ended, never past the stop bound" and "G3: a removal that
lands 91 s after the stop turns the stop-bound assertion red"
(`agent-claude.test.ts`), and "a removal is shown gone only by the daemon,
and never past its deadline" (`command-runner.test.ts`). The removal's own
end is now also named in the attempt's failure (the inspect killed at its
bound, cycle 12).

### MED-005 — what reconcile writes

After `fab5760`: one update of the recorded PR's title and body, by its
number; nothing listed, selected or created. The data model, threat model
(T2-17 and its summary) and runbook (§3.4) say so in `fab5760` and keep only
R30's residual; the selection race the review found never had a description
to drop. The cycle-10 entry above ("writes only to the recorded, reviewable
PR … no longer creates a missing PR") was wrong about the write, which went
through the branch-keyed upsert; it carries a correction note.

### Gate failures in this cycle

`pnpm verify:all` at `c67b25b` failed at format-check: the reviewer's output,
copied verbatim, has no final newline. `52d4d62` adds it and names the edit in
the provenance note.

`pnpm verify:all` at `7017cfc` failed twice, 867 of 869 each time, by the
Node-launch stall described under CYCLE11-HIGH-002 (step 3). No change was
made for them: the stall is on the host.

## Final review cycle 12 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 12 at `d9255fb`
> (`phase-02-final-rereview-codex-v12.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The controller's decisions on it (reconciliation R47) were applied as
> stated. Repairs: repair cycle 13, on `phase/02-single-agent-vertical-slice`
> from `d9255fb`. Every disposition, repair, test, measurement and mutation
> check below was made and verified by the implementer only; none has been
> independently reviewed. Mutation checks work as in the cycle-10 section.
> Every full gate of this cycle ran through the controller's `gate.sh`, which
> holds the host's gate lock and samples Node launches beside the run (R47).

### What the review accepted, and what it did not

The review marked **RESOLVED**: CYCLE11-HIGH-001, CYCLE11-MED-001, concern 2,
CYCLE10-HIGH-001, HIGH-006, MED-005, CYCLE7-HIGH-003, CYCLE8-HIGH-003 and the
monotonic waits. It found **PARTIAL**: CYCLE11-HIGH-002 (the Node stall is
measured; what makes the bursts, and a fix, are not verified), the timeout
work, and CYCLE10-HIGH-002 (reopened by its probe `CYCLE12_LATE_ABSENCE`). It
raised CYCLE12-HIGH-001 (the egress proxy keeps the model credential usable
for as long as it runs, and nothing bounds that once the worker that started
it is gone), CYCLE12-MED-001 (fixtures can leave processes behind and delete
the only record that finds them) and CYCLE12-MED-002 (both removal helpers
took absence that arrived after their deadline as proof). A mutant of the
docker caller's cut, `cutMs + 1_000`, survived.

### Summary

| ID | Disposition | Commits |
|---|---|---|
| CYCLE12-HIGH-001 | ACCEPTED — the proxy has a lifetime of its own: an absolute expiry (the attempt's deadline plus `PROXY_EXPIRY_GRACE_MS`, 30 s) given at start, and its stdin as its link to its starter; past either it refuses and exits | `0d95b1f` |
| CYCLE12-MED-001 | ACCEPTED — a fake container's record goes only once its process group is shown gone; fixtures end every recorded container before deleting state; the test proxy helper cleans up on failure; a run-scoped registry outside the test worker lets the canonical runner end leftovers before and after the tests; the controller's 33 listed orphans were killed | `2d974cb`, `e47b2cb` |
| CYCLE12-MED-002 | ACCEPTED — both removal helpers refuse absence that arrives after the deadline; the probe is a test | `e58c588` |
| The surviving cut mutant | ACCEPTED — the cut is bounded from above, when it runs and how long the cut call takes | `87c231c` |
| Instrumentation | ACCEPTED — every docker call record carries the client's pid; the proxy's and the agent's kill results are kept; the status assertions print the observation | `87c231c` |
| `CYCLE12_REAL_OCTOKIT_PATCH` | the probe is a test, through the real Octokit | `b95cb82` |
| CYCLE11-HIGH-002 | NOT CLOSED; disposition R47 recorded; the cause stated at the confidence the evidence supports | this commit |
| Port and schema deltas | none to ports or schema; the egress proxy asset and its argv builder take a required expiry | `0d95b1f` |

Also: `158608f` adds the cycle-12 transcript with its provenance note.

### CYCLE12-HIGH-001 — the proxy's credential had no bound of its own — ACCEPTED

**Invariant:** the model credential is usable through the egress proxy only
until the attempt's deadline plus a named grace, and only while the process
that started the proxy holds its link to it — whichever ends first — and
nothing has to be alive to take it back.
**Change (`0d95b1f`):**
- `assets/egress-proxy.mjs` requires `--expires-at` (epoch milliseconds) and
  refuses to start without one, or with one already past. It refuses every
  request once its clock has reached the expiry — also if the clock is then
  set back — and exits at the expiry by its own timer. Stdin carries the
  credential as its first line and then stays open; when it closes — the
  starter ended it, or died and the operating system closed it — the proxy
  exits at once. Its request handling is exported (`egressProxy`, with the
  clock as a parameter), so the expiry is tested on virtual time.
- The provider passes `--expires-at` = the wall clock of the attempt's
  deadline plus `PROXY_EXPIRY_GRACE_MS` (30 s; the grace covers only a proxy
  container whose clock runs behind the host's) and keeps the proxy's stdin
  open after the credential. `PROXY_EXIT_BOUND_MS` (2 s) names how soon the
  proxy exits once its lifetime ends or its link closes.
- Threat model T2-16 states the capability window after worker death: the
  agent can use the credential through a leftover proxy until the proxy's
  expiry at most, then has no route out at all; the runbook keeps the sweep
  as the operator backstop for the containers.
**Tests (written first; red against the previous asset and provider, the two
constants added first so that the suite could load):**
- Virtual time: the proxy serves at expiry − 1 ms and refuses at the expiry
  (403, "no longer serving: its lifetime ended") and after the clock is set
  back 30 s; nothing refused reaches the upstream.
- A real process whose starter is SIGKILLed after it served one request: the
  proxy is gone within `PROXY_EXIT_BOUND_MS` plus the 2 s scheduling
  allowance, its log says "its parent link closed", and its port refuses
  connections.
- A real process with a 5 s lifetime: it serves, then exits at its expiry —
  not before it, and within the same bound — with exit 0 and "its lifetime
  ended".
- It refuses to start without `--expires-at`, with one that is not epoch
  milliseconds or already past, with stdin closed before a credential, or
  with an empty credential; given a credential and then the end of stdin, it
  stops.
- The provider's proxy argv carries the deadline plus the grace; the fake
  docker records a container's stdin per chunk and whether it ended, and the
  credential test shows the provider never ends the proxy's.
**Mutation check:** 11 mutants, all killed: no per-request expiry check; no
expiry timer; the link closing ignored; no grace; the provider ends the
proxy's stdin; a past expiry accepted; a missing expiry defaulted; exit 1 s
before the expiry; no `--expires-at` in the argv; a clock set back serving
again; the per-request check 1 s late. Two more were run against a first
draft whose stop kept serving refusals until the process exited: "end() does
not stop serving" (killed) and "a link that closed during setup is
forgotten", which survived because its branch cannot be reached (Node
delivers a pipe's data and its end in separate callbacks and runs the
credential's continuation between them). The draft was simplified so that
stopping is exiting; neither branch exists any more.
**In a container.** The stdin link runs through the docker client and the
daemon. A manual probe on Docker 29.6.1 (`docker run --rm -i` of the pinned
node image, its stdin from a FIFO): the container saw its stdin end and was
gone 0.17 s after the writer to the client's stdin was SIGKILLed, and gone
0.19 s after the client itself was SIGKILLed. This was observed once by hand,
is not a gate test, and is not relied on: the bound relied on after worker
death is the expiry.

### CYCLE12-MED-001 — fixtures could leave processes and delete their records — ACCEPTED

**Invariant:** a process a test starts is ended and shown gone before the
last record that finds it is deleted, and a record of it is kept outside the
test process for as long as it runs.
**Change (`2d974cb`):**
- The fake docker takes a container's record away only once nothing of its
  process group runs; `kill` and `rm -f` that cannot show that answer with the
  daemon's error and keep the record (a `kill-does-not-take` state file stands
  for such a daemon). When a container's process ends, the rest of its group
  is killed before its record goes.
- Every fixture that runs the fake docker — the agent-claude harness, the
  command-runner fixtures, crash-recovery, pilot-faults, pilot-target,
  pilot-verifier, vertical-integration and the live proof — is removed through
  `removeFakeDockerFixture` (`scripts/testing/fake-docker-fixture.mjs`), which
  ends every container still recorded under it, shows it gone, and only then
  deletes the fixture; one that cannot be shown gone keeps the fixture and
  fails the teardown.
- The test proxy helper records its proxy and kills it when it is not ready
  in time; the stdin link from HIGH-001 ends it if the test process dies. The
  starter test's processes are recorded and ended as well.
- `scripts/lib/process-registry.mjs`: a run-scoped registry under the system
  temporary directory, one root per checkout. The canonical runner opens a
  run, hands it to the tests in `ASEP_PROCESS_REGISTRY` (each docker shim
  exports it, as the provider strips the docker client's environment), ends
  what earlier runs whose runner is gone left behind before the tests, and
  ends what this run left after them. It prints both on every run and fails a
  run that leaves a process it cannot end. A process is ended only while its
  command line still carries the marker it was recorded with; a group record
  ends the whole group.
**Follow-up (`e47b2cb`).** The first gate with the registry listed six
records of its own run at the end, every process already gone: containers
that fixture removal had ended through their fixture records kept their
registry records, and the runner called them "left by this run". Fixture
removal now takes what it shows gone out of the registry too, and the runner
reports how many recorded processes it found still running, beside every
record and what became of it. Tests first (both red before the change);
mutation check: fixture removal leaving what it ended in the registry, the
runner counting every record as running — both killed.
**Tests:** the fake docker's three tests (record kept while the process runs,
for `kill` and for `rm -f`; containers in the registry while they run;
fixture removal) were written first and red against the previous fake; the
registry's tests are new with the module; the runner wiring is a test that
runs the runner on a test file leaving a process; the harness close, the
test proxy helper and the exited-container group are tests too (the proxy
helper's and the harness's were written together with the helpers, in the
same file).
**Mutation check (`2d974cb`):** 15 mutants, all killed: the fake's `rm` or `kill` taking a
record while the process runs; containers not recorded; fixture removal
ending nothing; the marker ignored; only the leader killed; a live runner's
run swept; dead runners' runs not swept; a run not ending what it recorded; a
test proxy not ready in time left running; the harness deleting its state
without ending containers; the runner not handing over the registry; an
exited container's group not ended; a record forgotten while its process
runs; a fixture removed while a container still runs. The first run of "a
run not ending what it recorded", in a combined run with
`--test-force-exit`, hung for 16 minutes in the Node test runner's parent
process (sampled busy in `Buffer.indexOf` while parsing a test file's output,
the file's process already exited) and was killed; rerun per file and in a
second combined run without `--test-force-exit`, it was killed both times. The
gate does not pass `--test-force-exit`. The mutant runs left 8 processes,
since their mutants disable the cleanup; they were killed by pid, with their
command lines and start times recorded before and their absence after.
**The controller's orphans.** `controller-orphans-20261030-1715.txt` listed
33 processes, all with this worktree's command paths: 31 egress proxies and
2 fake docker clients. Before: each pid still had the start time and command
line the list gives, with parent pid 1. All 33 were sent SIGTERM and all
exited; none needed SIGKILL. After: none of the 33 runs. Two more proxies of
this worktree, pids 4822 and 89091 (children of the listed fake docker
clients 4809 and 89078, started 08:50 and 08:34), are not in the list and
were left running as the instruction limits the kill to the listed pids;
they run the previous proxy asset, with no lifetime of its own.

### CYCLE12-MED-002 — absence that arrived after the deadline was taken as proof — ACCEPTED

**Invariant:** absence shows a container gone only if the call that showed it
returned by the deadline, for the agent (`removeContainerShownGone`) and the
runner (`removeLabelledContainers`).
**Change (`e58c588`):** each helper checks the time left after its `ps`,
`rm` and `inspect` return; an answer that came after the deadline is refused
with how late it was (`docker ps listed none only 4000ms after the deadline`,
`docker rm returned 4000ms after the deadline, leaving no time to show it
gone`, `docker inspect showed it gone only 4100ms after the deadline`).
**Tests (written first, red before the fix):** the reviewer's
`CYCLE12_LATE_ABSENCE` on virtual time for both helpers: a `ps` that lists
none late, an `rm` that returns late, and an `inspect` that shows absence late
after a timely `rm`.
**Mutation check:** the label helper taking a late listing; the name helper
taking a late absence; a 5 s tolerance — all killed.

### The surviving cut mutant, and the instrumentation — ACCEPTED

**Cut (`87c231c`):** the docker caller's test bounds the cut from above: the
kill runs no earlier than the bound and no later than the bound plus a named
timer lateness (`TIMER_LATENESS_MS`, 500 ms), and the cut call ends within
that plus a named kill-to-close allowance (`KILL_TO_CLOSE_MS`, 400 ms). The
reviewer's `cutMs + 1_000` mutant is killed.
**Instrumentation (`87c231c`):** every `DockerCallRecord` carries the client's
pid, and its description names it (`(pid 4711, spawn 3ms, bound 30000ms, cut
at 30001ms)`); a client that never started has none. The runner's teardown
error names its command client's pid. The result of the egress proxy's kill
at teardown and of the agent's kill at its stop are kept in the attempt's
teardown notes when they fail for anything but absence. The tool-budget test
and twelve other status assertions print the observation — status, summary,
limitations and, for the budget test, the timeline — when they fail.
**Mutation check:** the kill 1 s after its bound; no pid in the record; the
proxy's kill result dropped; the agent's kill result dropped; no client pid
in the runner's error; the budget stop reporting FAILED (its failure printed
the observation) — all killed. Tests and code were written together.

### `CYCLE12_REAL_OCTOKIT_PATCH` — the probe is a test

The review confirmed with the real Octokit on a fetch double that
`updatePullRequestContent` sends exactly one request, `PATCH
/repos/acme/web/pulls/1` with `{"title":"T","body":"B"}`; the adapter's tests
drove a fake Octokit only. The probe is now a test through the production
transport (`b95cb82`): the real `@octokit/rest` client, built as the
composition root builds it, with only its fetch replaced. It passes on the
code as reviewed — it confirms a behaviour rather than finds a fault.
**Mutation check:** the update also sending `state: 'open'`; the update
listing the head's PRs first — both killed.

### CYCLE11-HIGH-002 — disposition R47; the cause at the confidence the evidence supports

**What the evidence supports.** The stall is in launching Node on this host:
in the red runs the docker client started at once and was still running at
its 30 s bound, and the probe beside the second red run measured Node
launches held 4.6–40.7 s while `/bin/sh` and `/usr/bin/true` launched in at
most 173 ms. That the host's launch-policy check (AppleSystemPolicy notifying
syspolicyd for each Node launch) is what holds them, one launch at a time, is
a strong hypothesis, not proven: the kernel log shows a notification per
launch and the timing fits a queue released at once, but it does not record
when each policy request began and ended, and no control run with the policy
exemption was made. What makes the bursts of Node launches is unknown; they
may include this repository's own tests — the fake docker client is one Node
launch per call and starts a Node process per container — and concurrent
lanes on the host. The cycle-11 entry above stated the cause as found; its
wording is corrected there.

**The disposition (R47), applied as stated:**
1. Every gate on this host runs through `gate.sh`.
2. A gate run is valid acceptance evidence only if its sampler shows no Node
   launch of 10 s or more. A red run with such a stall is a host stall and
   counts as neither pass nor fix; a red run without one is a real failure
   and needs a root cause.
3. Acceptance needs two consecutive valid green runs of each gate at the
   final head.
4. The controller keeps a burst-parent sampler running; a source inside this
   repository's tooling becomes a fix.
5. The report and this log state the cause at the confidence the evidence
   supports. A host-policy exemption is the user's choice and is not assumed.

R47 also corrects the run lengths quoted in R43: the canonical test step at
`42b6d78` took 351 s in run 1 and 422 s in run 2, not 176 s (the cycle-11
entry already says so).

**Gate runs of this cycle.** Every one through `gate.sh`; the sampler line is
its own summary.

| Commit | Gate | Result | Tests | Duration | Sampler: samples, longest Node launch, launches of 10 s or more | Valid under R47 |
|---|---|---|---|---|---|---|
| `158608f` | `verify:all` | exit 0 | 869 of 869 | 455 s | 198, 2921 ms, 0 | yes |
| `e58c588` | `verify:all` | exit 0 | 870 of 870 | 429 s | 185, 3204 ms, 0 | yes |
| `87c231c` | `verify:all` | exit 0 | 870 of 870 | 496 s | 213, 1425 ms, 0 | yes |
| `0d95b1f` | `verify:all` | exit 0 | 873 of 873 | 393 s | 172, 2899 ms, 0 | yes |
| `2d974cb` | `verify:all` | exit 0 | 884 of 884 | 439 s | 195, 2415 ms, 0 | yes |
| `e47b2cb` | `verify:all` | exit 0 | 884 of 884 | 403 s | 175, 2900 ms, 0 | yes |
| `b95cb82` | `verify:all` | exit 0 | 885 of 885 | 427 s | 186, 3101 ms, 0 | yes |
| `b95cb82` | `test:integration` | exit 0 | 34 of 34 | 113 s | 50, 988 ms, 0 | yes |

No gate run of this cycle was red. From `2d974cb` on, the canonical runner
reports its process registry on every run: it found no recorded process
still running, before or after the tests, in any of them; the records of
already-ended processes it listed fell from six (`2d974cb`) to one
(`e47b2cb`) to none (`b95cb82`). After the integration run no container
labelled `asep.role` and no network labelled `asep.attempt` remained. The
final sequence on the report commit — `pnpm install --frozen-lockfile`, two
`verify:all` and two `test:integration` runs, each through `gate.sh` — is
bound by the L1 sentinel and reported to the controller with its sampler
lines.

### Port and schema deltas for Lanes A and B

No port, schema or migration changes in this cycle. Lanes A and B adopt the
cycle-11 port delta (`ForgeProvider.updatePullRequestContent`) at their
rebase after G-P2, and no adapter may implement `updatePullRequestContent`
through a branch-keyed upsert (R47). Other contract changes, all inside
adapters and test tooling:
- `@asep/agent-claude`: `buildProxyRunArgs` takes a required `expiresAt`;
  `assets/egress-proxy.mjs` requires `--expires-at` and keeps reading stdin
  after the credential, and exports `egressProxy`; new exports
  `PROXY_EXPIRY_GRACE_MS` and `PROXY_EXIT_BOUND_MS`; teardown notes may name a
  failed kill of the proxy or of the agent at its stop.
- `@asep/command-runner`: `DockerCallRecord` gains `pid?`, and
  `describeDockerCall` names it; the runner's teardown error names its
  client's pid.
- Test tooling: `scripts/lib/process-registry.mjs`,
  `scripts/testing/fake-docker-fixture.mjs`; the canonical runner sets
  `ASEP_PROCESS_REGISTRY` for its tests and reports what it ended; the fake
  docker's records carry `group` and `marker`.

## Final review cycle 13 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 13 at `26d2a55`
> (`phase-02-final-rereview-codex-v13.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The controller's decisions on it (reconciliation R48) were applied as
> stated. Repairs: repair cycle 14, on `phase/02-single-agent-vertical-slice`
> from `26d2a55`. Every disposition, repair, test, measurement and mutation
> check below was made and verified by the implementer only; none has been
> independently reviewed. Mutation checks work as in the cycle-10 section.
> Every full gate of this cycle ran through the controller's `gate.sh` (R47).

### What the review accepted, and what it did not

The review marked **RESOLVED**: CYCLE12-MED-002, the cut mutant, the three
instrumentation items (the client's pid, the proxy's kill result, the
tool-budget assertion), the real-Octokit probe, the timeout work,
CYCLE10-HIGH-002, CYCLE11-HIGH-001, CYCLE11-MED-001, concern 2,
CYCLE10-HIGH-001, HIGH-006, MED-005, CYCLE7-HIGH-003, CYCLE8-HIGH-003 and the
monotonic waits. It found the controller's four gates at `26d2a55` valid
under R47 and the L1 sentinel byte-identical to that head. It found
**PARTIAL**: CYCLE12-HIGH-001 (the proxy's lifetime was its own, but read
from the wall clock), CYCLE12-MED-001 (the registry existed, but its
identity check, its proof of absence and its coverage fell short) and
CYCLE11-HIGH-002 (its cause is not proven; the R47 disposition is enough for
gate evidence). It raised CYCLE13-HIGH-001 (a wall clock set back extends
the model capability, and a stream open after the expiry was observed goes
on), CYCLE13-MED-001 (the registry could kill another process after pid
reuse), CYCLE13-MED-002 (a failed `ps` was taken as proof a process was
gone), CYCLE13-MED-003 (test helpers still started processes outside the
canonical run's registry) and CYCLE13-MED-004 (leftovers of an earlier run
did not fail the gate). The controller ended the two proxies left running
in cycle 13 (pids 4822 and 89091).

### Summary

| ID | Disposition | Commits |
|---|---|---|
| CYCLE13-HIGH-001 (rest of CYCLE12-HIGH-001) | ACCEPTED — the proxy takes a relative lifetime, at most a named maximum, and fixes its deadline once on its own monotonic clock; admission, its timer and every request and stream in flight answer to that deadline; at it the proxy destroys every open connection and exits | `d883e24`, `6f4dc30` |
| CYCLE13-MED-001 (with CYCLE12-MED-001) | ACCEPTED — a recorded process carries a token of its own in its environment and its start time; it is signalled only while its pid shows both; test cleanups end containers by that identity, never by a pid alone | `607b6dc`, `f02fe83` |
| CYCLE13-MED-002 | ACCEPTED — a `ps` that fails, or an environment that cannot be read, is "unknown": nothing is signalled, the record stays, the cleanup fails; in the registry and in the fake docker | `607b6dc` |
| CYCLE13-MED-003 | ACCEPTED — every process a test starts is in the run's registry, the registry's own tests included, or a fitness test's list says why it need not be (wording corrected in repair cycle 15) | `a94fa3e`, `985ddf3` |
| CYCLE13-MED-004 | ACCEPTED — a leftover of an earlier run that cannot be shown gone fails the gate | `6fec876` |
| CYCLE11-HIGH-002 | NOT CLOSED; disposition R47 unchanged | — |
| Port and schema deltas | none to ports, schema or migrations; the egress proxy's argv and asset take a relative lifetime | `d883e24` |

Also: `ceb300e` adds the cycle-13 transcript with its provenance note.

### CYCLE13-HIGH-001 — the proxy's lifetime ran on the wall clock — ACCEPTED

**Invariant (R48):** the model credential is usable through the egress proxy
for at most one lifetime, counted on the proxy's own monotonic clock from its
own start: admission, its exit timer and every open request or stream answer
to one deadline fixed once; at that deadline the proxy destroys every open
connection and exits. No change to any wall clock moves it.
**Change (`d883e24`):**
- `assets/egress-proxy.mjs` takes `--lifetime-ms` — a whole number of
  milliseconds from 1 to `MAX_LIFETIME_MS` (four hours, exported); beyond it,
  it refuses to start ("is beyond the maximum lifetime … refusing to start").
  Its deadline is that lifetime on `performance.now()`, which counts from the
  process's start and which setting the system clock does not move. A
  lifetime that ends before the credential arrives refuses to start.
- `egressProxy({ deadline, now, schedule, onExpired, … })`: one deadline for
  everything. Whichever first sees it reached — the timer, a request
  arriving, a chunk or the end of a request body, a chunk or the end of a
  response — ends the proxy: that request is refused (403 with `connection:
  close`), nothing more is forwarded, every open connection to the agent and
  every request to the upstream is destroyed, the server stops listening and
  `onExpired` runs, which in the process is `stop` (exit). Bodies are relayed
  chunk by chunk with that check instead of `pipe`. Once reached, the
  deadline stays reached. The chunked wall-clock timer is gone.
- The provider passes `lifetimeMs = min(ceil(remaining budget) +
  PROXY_EXPIRY_GRACE_MS, PROXY_MAX_LIFETIME_MS)`, counted just before it
  spawns the proxy, after the network setup, so the time the proxy's own
  start takes is the only extra, and the readiness bound (30 s, or what is
  left of the budget if less) caps it: a proxy not ready by then is killed.
  `PROXY_MAX_LIFETIME_MS` (four hours) is exported and equal to the asset's
  `MAX_LIFETIME_MS`. The invocation manifest records the proxy argv from
  that moment.
- T2-16 and the runbook state the window after worker death as
  `min(remaining budget + grace, maximum) + readiness bound`, independent of
  wall-clock changes, with two limits: a worker that dies while its proxy is
  still starting leaves nothing to kill a late starter (that proxy's lifetime
  runs from whenever it starts), and host sleep is counted by neither clock.
**Tests (written first, except the late-response test, which came after the
asset; the eight run against the previous asset and provider — with
`PROXY_MAX_LIFETIME_MS` added first so that the suite could load — all
failed; the changed assertion of the contained-attempt test was not run
red):**
- `CYCLE13_CLOCK_ROLLBACK_BEFORE_EXPIRY` and `CYCLE13_EXPIRED_LATCH_TIMER` as
  a real process: a proxy whose `Date` an `--import` double moves an hour
  back — and one an hour forward — 200 ms after it loads (its access log
  shows the moved clock) serves, keeps a stream open, and at the end of its
  8 s lifetime cuts the stream and exits: not before its lifetime from the
  spawn, and within `PROXY_EXIT_BOUND_MS` plus the scheduling allowance of it
  from readiness.
- `CYCLE13_STREAM_AFTER_EXPIRY_OBSERVED`, on virtual time: a request and its
  response streaming at the deadline are cut whichever sees the deadline
  first — the timer, more of the response, the response's end, more of the
  request, the request's end, a new request on another connection — and
  nothing of either past the deadline reaches the other side.
- A request on a kept-alive connection at the deadline is refused, and then
  the proxy ends; a timer firing early is set again for the deadline; after
  the end neither the timer nor a clock set back changes anything.
- A response whose headers come only after the deadline reaches the agent
  not at all — not even its status line (`6f4dc30`).
- `CYCLE13_EXPIRY_INPUT`: `--lifetime-ms` of the maximum plus 1 and of
  `Number.MAX_SAFE_INTEGER` are refused; the maximum is accepted; 0, 1.5 and
  a word are refused; a lifetime of 1 ms has ended before the credential.
- The provider: with a network inspect slowed by 2 s, the lifetime is at
  least 2 s short of budget plus grace; with a 24-hour budget it is the
  maximum, which the asset accepts. The contained attempt checks the argv
  carries no wall-clock moment.
- The existing tests still hold: a proxy whose starter is SIGKILLed exits
  within the bound; one not ready in time fails the attempt and is torn
  down; the real-daemon sandbox suite passed against the new asset.
**Mutation check:** 14 mutants on `d883e24`'s draft, 13 killed: the
deadline read from the wall clock; no check per chunk; none at a stream's
end; open connections not destroyed; a refusal at the deadline not ending the
proxy; no check at admission; no timer; the timer 10 s late; the maximum not
enforced; the lifetime counted 5 s past the process's start; the provider
without the grace, without the clamp, or counting from before the setup. The
fourteenth, "a response beginning after the deadline is forwarded", survived:
the check it removed, at the response's headers, was redundant, since
`writeHead` only queues the headers, which leave with the first chunk or the
end, both checked. The branch was removed before the commit. `6f4dc30` makes
that a test of what the agent receives: a mutant that flushes the headers at
once is killed.
**The red run did not exit by itself.** After its last test, the test process
stayed open: the "forwards only the model API" test left its fake upstream
listening when its proxy failed to start (as every proxy did against the old
asset's argv). The process was killed by pid; that test now closes its
upstream on that path.

### CYCLE13-MED-001 — the registry could kill another process after pid reuse — ACCEPTED

**Invariant (R48):** each recorded process carries a run-unique token the
sweep can see and its start time; the sweep signals only a process whose
token and start time both match; when identity cannot be shown, it does not
signal and the cleanup fails.
**Change (`607b6dc`):**
- A recorded process is started with `ASEP_PROCESS_TOKEN` (a random UUID) in
  its environment and recorded as `{ pid, group, token, startedAt }`, the
  start time as `ps -o lstart` shows it (`identityOf`); recording fails when
  the table does not show the token. The environment is read from
  `/proc/<pid>/environ` on Linux and from `ps -E` on macOS, where `ps` shows
  none for the system's own binaries — such a process cannot be recorded.
- `endProcess` signals only when the pid shows both ('not-ours' otherwise; a
  pid that shows another start time is another process now). A group whose
  leader has exited is ended only if every member left shows the token and
  started no earlier; otherwise 'unknown'.
- `spawnRecorded` spawns with a fresh token and records the child; one that
  cannot be recorded is killed and the error thrown. The fake docker gives
  each container its token, records it in the run's registry before its own
  container record, keeps the identity in that record, and ends containers
  through `endProcess`. The run's owner is its runner's pid and start time.
- `f02fe83`: four test cleanups that sent SIGKILL to a container's process
  group by a pid read earlier now end it by its record's identity; a fitness
  test finds any group signalled by a pid alone in the test sources.
**The reviewer's marker-prefix mutant.** The marker is gone, so
`marker.split(' ')[0]` has no target. Its class — an identity weakened to
what another process of the same executable also shows — was run on the
token: any token taken as ours (M1), the token compared by its first eight
characters (M2), the start time not compared (M3). All three are killed by
the shared-executable negative case: at the recorded pid, the same `node -e`
command line without the token, with a token one character off, with another
start time, and with no start time recorded, is each left alone.
**Tests:** the registry's and the fake docker's tests were rewritten with the
module; against the previous registry they failed only at load (its new
exports were missing), so the mutation check is what shows each assertion
bites. `CYCLE13_REGISTRY_PID_REUSE` is the shared-executable case above.

### CYCLE13-MED-002 — a failed `ps` was taken as proof of absence — ACCEPTED

**Invariant (R48):** a `ps` that fails — non-zero status, spawn error,
signal — yields "unknown": the record stays and the cleanup fails, in the
registry and in the fake docker.
**Change (`607b6dc`):** every `ps` call checks its status, error and signal;
presence comes from `kill(pid, 0)` (only ESRCH is absence), and a `ps` that
fails for a present pid is "unknown". `stillRunning` answers true when it
cannot tell. Records are removed only for 'gone', 'ended' or 'not-ours'. The
fake docker's `kill` and `rm -f` keep a container whose table cannot be read
and answer "could not tell whether process N is still running"; fixture
removal fails with each outcome; the canonical runner fails on any record of
its run not shown gone. A run whose runner cannot be read is left as it is.
`ASEP_PROCESS_TABLE_PS` names the `ps` to use, for the tests.
**Tests:** `CYCLE13_REGISTRY_PS_FAILURE` and `CYCLE13_FAKE_DOCKER_PS_FAILURE`
as tests, for a `ps` that exits 1, one killed by a signal and one that cannot
start: `endProcess` is 'unknown' for a process and for a leaderless group,
nothing is signalled, the record stays, recording fails; the fake docker's
`kill` and `rm -f` keep the container and say why. A run whose runner cannot
be read is left in place; an environment the table does not show is
'unknown'; a process that cannot be recorded is not left running.
**Mutation check (CYCLE13-MED-001 and -002, 16 mutants):** M1–M3 above; an
unreadable table taken as absence (M4); an unreadable group listing taken as
no members (M5); the status of `ps` not checked (M6); a record whose
identity is unknown removed (M7); members of a leaderless group not checked
for the token (M8); a runner taken as alive by its pid alone (M9); a runner
that cannot be read taken as gone (M10); an environment not shown taken as
one without the token (M11); a process not showing its token recorded anyway
(M12); a process that cannot be recorded left running (M13); the fake docker
taking an unknown table as the container gone (M14); fixture removal
counting only 'still-running' (M15); the runner not failing on an unknown
process of its run (M16) — all killed. The first run of M4 and M13 did not
end within the mutation runner's 600 s bound — their failures were already
reported, but the test file's process did not exit — and the runner ended
it; those mutants left processes that the registry's tests then held
forever. The tests' processes now hold a minute at most; rerun, both mutants
were killed in 136 s. Those runs left four processes, each with this
worktree as its working directory and a test token in its environment; they
were killed by pid after their start times and environments were checked.
`f02fe83`: a cleanup signalling a group by a pid alone again, and an allowed
signal that is gone but still listed — both killed.

### CYCLE13-MED-003 — test helpers started processes outside the run's registry — ACCEPTED

**Invariant (R48):** every long-lived test helper and direct spawn registers,
including the registry's own tests.
**Change (`a94fa3e`):** the fake docker test helper starts its client with
`spawnRecorded` and the run's registry in its environment, so the client and
its container are both recorded; a test that keeps a registry of its own
keeps it beside the run's (`ASEP_PROCESS_REGISTRY` may list several
directories, joined by the path delimiter: a process is recorded and
forgotten in each). [Corrected in repair cycle 15: at `bfd0e7f` the two tests
written for this finding put a registry of their own in place of the run's
(CYCLE14-MED-002); true since `8eb5dd0`.] The registry's own helpers record
what they start and
forget it once shown gone; the one helper that by design shows no token of
ours, and the system binary `ps` shows no environment of, hold a minute at
most. The runner's wiring fixture records what it starts. A fitness test
scans every test source — test, itest and live files and the test tooling —
for `spawn(`: each is recorded or listed with why it need not be (a docker
client through a shim, whose container the fake docker records; a process
outside the canonical run, such as the live proof's and the integration
runner's; a member of a recorded group), and the list must stay current.
`985ddf3`: the gate at `a94fa3e` listed one record of its run whose process
had gone — the registry's leaderless-group test tried to end the group
before its stranger member; it now ends the stranger first.
**Tests:** `CYCLE13_TEST_HELPER_REGISTRY_GAP` as two tests: a container the
fake docker helper starts, and its client, are in the run's registry without
being handed it; what the registry's helpers start is in the run's registry,
and a registry of a test's own is kept beside it. The fitness test was red
against the previous fake docker test file (its direct spawns). The two
probe tests were written after the helpers were changed; the mutation check
shows each fails without its change.
**Mutation check:** the helper not handing its client the run's registry;
the helper not recording its client; the registry's helper not recording; a
registry list taken as one directory; an unrecorded spawn not listed; a
listed spawn no longer there; the runner's fixture starting its process
without recording it — all killed.

### CYCLE13-MED-004 — leftovers of an earlier run did not fail the gate — ACCEPTED

**Invariant (R48):** leftovers of an earlier run fail the gate, as the
runner's header promises.
**Change (`6fec876`):** the runner fails when any record, of this run or of an
earlier one, is not shown gone ('still-running' or 'unknown'); its header
says so.
**Tests (written first, red before the change):** the negative wiring test:
the runner on a test file that starts nothing, with an earlier run whose
runner is gone holding (a) a plain recorded process — it is ended and the run
passes — and then (b) a leaderless group whose member shows another token —
the run exits 1, lists it as 'unknown', signals nothing and keeps its record.
`CYCLE13_EARLIER_STUCK_GATE` is (b).
**Mutation check:** the runner counting only this run's records as stuck —
killed.

### CYCLE11-HIGH-002 — disposition R47 unchanged

Nothing in this cycle changes what is known of the Node launch stall. Every
gate ran through `gate.sh`; none showed a launch of 10 s or more.

**Gate runs of this cycle.** Every one through `gate.sh`; the sampler line is
its own summary.

| Commit | Gate | Result | Tests | Duration | Sampler: samples, longest Node launch, launches of 10 s or more | Valid under R47 |
|---|---|---|---|---|---|---|
| `ceb300e` | `verify:all` | exit 0 | 885 of 885 | 461 s | 202, 3081 ms, 0 | yes |
| `d883e24` | `verify:all` | exit 0 | 888 of 888 | 452 s | 198, 2851 ms, 0 | yes |
| `607b6dc` | `verify:all` | exit 0 | 895 of 895 | 444 s | 192, 3533 ms, 0 | yes |
| `f02fe83` | `verify:all` | exit 0 | 896 of 896 | 522 s | 220, 5316 ms, 0 | yes |
| `a94fa3e` | `verify:all` | exit 0 | 899 of 899 | 502 s | 215, 4741 ms, 0 | yes |
| `985ddf3` | `verify:all` | exit 0 | 899 of 899 | 514 s | 217, 4653 ms, 0 | yes |
| `6f4dc30` | `verify:all` | exit 0 | 899 of 899 | 528 s | 223, 4767 ms, 0 | yes |
| `6fec876` | `verify:all` | exit 0 | 900 of 900 | 552 s | 234, 3440 ms, 0 | yes |
| `6fec876` | `test:integration` | exit 0 | 34 of 34 | 110 s | 50, 1003 ms, 0 | yes |

No gate run of this cycle was red. The canonical runner at `a94fa3e` listed
one record of its own run whose process had already gone; `985ddf3` removed
its cause (see CYCLE13-MED-003), and no other run listed any. No run found a recorded process still running, before or after
the tests. After the integration run no container labelled `asep.role` and
no network labelled `asep.attempt` remained. The final sequence on the
report commit —
`pnpm install --frozen-lockfile`, two `verify:all` and two
`test:integration` runs, each through `gate.sh` — is bound by the L1
sentinel and reported to the controller with its sampler lines.

### Port and schema deltas for Lanes A and B

No port, schema or migration changes in this cycle. Contract changes, all
inside adapters and test tooling:
- `@asep/agent-claude`: `buildProxyRunArgs` takes a required `lifetimeMs`
  in place of `expiresAt`; `assets/egress-proxy.mjs` takes `--lifetime-ms` in
  place of `--expires-at`, refuses a lifetime beyond its exported
  `MAX_LIFETIME_MS`, and its `egressProxy` takes `deadline`, `now`,
  `schedule` and `onExpired` in place of `expiresAt`; new export
  `PROXY_MAX_LIFETIME_MS`.
- Test tooling: `scripts/lib/process-registry.mjs` records
  `{ pid, group, token, startedAt }` (no marker) and exports `identityOf`,
  `spawnRecorded`, `shownGone`, `TOKEN_ENV` and `PS_ENV`; `register(entry,
  dir)`, `endProcess(entry, { waitMs, kill })` with the outcome 'unknown',
  `withProcessRegistry(root, fn)`; `ASEP_PROCESS_REGISTRY` may list several
  directories. Fake docker containers get `ASEP_PROCESS_TOKEN` in their
  environment, and its records carry the identity. `runCanonicalTests`
  accepts `registryRoot` and fails on leftovers of earlier runs.

## Final review cycle 14 dispositions

> Reviewer: Codex `gpt-6.1-sol`, re-review cycle 14 at `bfd0e7f`
> (`phase-02-final-rereview-codex-v14.md`), verdict **REQUEST_CHANGES** @ 0.99.
> The controller's decisions on it (reconciliation R49) were applied as
> stated. Repairs: repair cycle 15, on `phase/02-single-agent-vertical-slice`
> from `bfd0e7f`. Every disposition, repair, test, measurement and mutation
> check below was made and verified by the implementer only; none has been
> independently reviewed. Mutation checks work as in the cycle-10 section.
> Every full gate of this cycle ran through the controller's `gate.sh` (R47).

### What the review accepted, and what it did not

The review marked **RESOLVED**: CYCLE13-HIGH-001 (the proxy's lifetime on its
own monotonic clock), CYCLE13-MED-002 (a failed `ps` is unknown) and
CYCLE13-MED-004 (an earlier run's leftovers fail the gate), and found the
controller's four gates at `bfd0e7f` valid under R47. It found **PARTIAL**:
CYCLE12-HIGH-001 (the window after worker death did not hold for a worker
that died while its proxy was starting), CYCLE13-MED-001 and CYCLE12-MED-001
(a record of an earlier format could be forgotten, or acted on, without the
identity the new format carries) and CYCLE13-MED-003 (two new tests put a
registry of their own in place of the run's). It raised CYCLE14-HIGH-001 (the
credential was written to the proxy before it was ready, so a proxy that
started after its worker died held it past the published window: in its
model `CYCLE14_LATE_START_MODEL`, a request is forwarded at 190 s against a
published end of 120 s), CYCLE14-MED-001 (a marker-format record was
forgotten while its leader ran, `CYCLE14_LEGACY_RECORD_LIVE_LEADER`, and chose
a leaderless group to signal when its member's environment could not be read,
`CYCLE14_LEGACY_RECORD_UNKNOWN_ENV`), CYCLE14-MED-002 (the two tests above,
`CYCLE14_NESTED_PROBE_REGISTRY_GAP`), CYCLE14-LOW-001 (a budget beyond the
proxy's maximum ran, and its agent would lose the model API part way through)
and CYCLE14-LOW-002 (no test reads an unreadable `/proc/<pid>/environ`; the
`undefined → null` mutant of that read survived, `CYCLE14_ENVIRON_MUTANT`,
`CYCLE14_LINUX_ENVIRON_MUTATION`). It also found two claims of the cycle-14
review log and report broader than the code (see "Docs" below).

### Summary

| ID | Disposition | Commits |
|---|---|---|
| CYCLE14-HIGH-001 (rest of CYCLE12-HIGH-001) | ACCEPTED — the proxy starts without the credential and serves nothing until it holds it; the provider sends it only after the proxy reported ready within its bound; the proxy's own credential window ends it without one | `9b5f65c` |
| CYCLE14-MED-001 (rest of CYCLE13-MED-001 and CYCLE12-MED-001) | ACCEPTED — records carry a format version; a record without full identity is unknown: kept, never signalled, and the gate fails naming it; a token match needs a non-empty recorded token | `ebf3fa4` |
| CYCLE14-MED-002 (rest of CYCLE13-MED-003) | ACCEPTED — a test adds a registry of its own beside the run's, never in its place; a runner started inside a run keeps the outer run's registry; a fitness test rejects a test that drops it | `8eb5dd0` |
| CYCLE14-LOW-001 | ACCEPTED — a budget the proxy cannot outlive is refused before anything is done for it | `07f6701` |
| CYCLE14-LOW-002 | ACCEPTED — an unreadable `/proc/<pid>/environ` is a test: unknown, record kept, gate red | `5acff7a` |
| Docs | ACCEPTED — the review log's and the report's claims about nested registries and long-lived test processes now match the code | this section and the report |
| CYCLE11-HIGH-002 | NOT CLOSED; disposition R47 unchanged | — |
| Port and schema deltas | none to ports, schema or migrations; the egress proxy's protocol and the test registry's record format changed (below) | — |

Also: `81dd27c` adds the cycle-14 transcript with its provenance note (eight
absolute paths the publication gate rejects are shortened there, and the
note says so).

### CYCLE14-HIGH-001 — the credential reached the proxy before it was ready — ACCEPTED

**Invariant (R49):** the credential reaches the proxy only after readiness:
the proxy starts without it, reports ready, and serves nothing until it
receives it; the worker sends it on stdin only after it saw readiness within
its bound. The proxy has a named credential window on its own monotonic clock
from its start: with no credential by then, it exits. A worker that dies
before readiness never hands the credential over, and the window after
worker death stays `min(remaining budget + grace, maximum) + readiness
bound`, counted from the spawn.
**Change (`9b5f65c`):**
- `assets/egress-proxy.mjs`: `egressProxy({ …, credentialBy })` holds no
  credential at first and refuses every request ("not serving yet: it holds
  no credential", 403), forwarding nothing. `provideCredential(key)` takes one
  non-empty key, once, only before the credential window and the deadline; a
  key that arrives after the window is refused and ends the proxy ("a
  credential arrived after its credential window"), and so is a request after
  it. While it holds no key its timer fires at the earlier of the window and
  the deadline. The process takes `--credential-window-ms` (a whole number of
  milliseconds from 1 to the exported `CREDENTIAL_WINDOW_MS`, 60 s; otherwise
  it refuses to start), prints `asep-egress-proxy listening <port>`, reads its
  first stdin line as the key and then prints `asep-egress-proxy serving`;
  stdin that closes before a key, or an empty key, makes it refuse to serve
  and exit 2.
- The provider: `proxyHandshake(child, { apiKey, bound, startedAt, spawnMs })`
  writes the key once, only when the proxy reported ready within `bound`
  (`PROXY_START_TIMEOUT_MS`, 30 s, or what is left of the budget if less,
  from the spawn), and then waits, within the same bound, for `serving`. Not
  ready, or not confirmed, in time fails the attempt, whose teardown kills the
  proxy; the failure says how long it waited and when the key was sent.
  `buildProxyRunArgs` passes `--credential-window-ms`
  `PROXY_CREDENTIAL_WINDOW_MS` (60 s, longer than the readiness bound, so
  that a proxy ready in time always gets its key within its window). New
  exports: `PROXY_START_TIMEOUT_MS`, `PROXY_CREDENTIAL_WINDOW_MS`,
  `proxyHandshake`. The fake docker logs when a container reports it listens,
  beside what reached its stdin.
- T2-16 and the runbook drop the start-up exception: a worker that died
  before its proxy reported ready never sent the key, and that proxy forwards
  nothing and exits at its credential window. Host sleep stays a stated
  limit.
**Tests (written first: against the previous asset, and a provider with the
new exports but the previous handshake, 16 tests failed):**
- On virtual time: a request before the key is refused and nothing is
  forwarded; a key within the window is taken once (a second is refused); no
  key by the window ends the proxy; a key, or a request, after the window is
  refused and ends it.
- The reviewer's `CYCLE14_LATE_START_MODEL` as a test, on virtual time: a
  proxy whose worker died before it was ready, so that no key ever reaches
  it, starts 180 s after the spawn with the 90 s lifetime it was given; a
  request 10 s after its start (190 s after the spawn, where the probe saw a
  forward) is refused, nothing is ever forwarded, and the proxy ends at its
  credential window.
- A proxy process given no key reports ready, refuses every request and exits
  at its window (3 s here); the start refusals cover the window's bounds (a
  word, 0, 1.5, the maximum plus 1) and the refusals to serve.
- The provider's handshake on virtual time: nothing is written before
  readiness; the key once, on the first ready line, and not again; a proxy
  ready after its bound gets nothing; the attempt waits for `serving`. Through
  the fake docker, the proxy reported ready before anything reached its stdin,
  and a proxy that never becomes ready got nothing on its stdin. The contained
  attempt's argv carries the window, equal to the asset's maximum and longer
  than the readiness bound.
**Mutation check:** 11 mutants, all killed: the proxy serving without a key;
no timer for the window; a key after the window taken; a request after the
window refused without ending the proxy; the window's maximum not enforced;
a second key replacing the first; the provider sending the key at the spawn,
after its bound, on every ready line, or not waiting for the confirmation;
no window passed.
**The red run did not exit by itself.** Proxy tests whose proxy failed to
start against the previous asset left their fake upstreams listening (the
upstream was created before the `try` that closes it). The test file's
process (pid 43046, started by the implementer) was killed by pid; every
such test now closes its upstream when its proxy fails to start.

### CYCLE14-MED-001 — records without full identity were acted on — ACCEPTED

**Invariant (R49):** records carry a format version; on read, a record
without a valid version, token and start time (and a group record whose
members' tokens cannot be read) is unknown: kept, never signalled, and the
gate fails naming it. The token match requires a non-empty recorded token.
**Change (`ebf3fa4`):**
- Every record is `{ version, pid, group, token, startedAt }` with
  `RECORD_VERSION` (1). `identityGap(entry)` says what a record lacks: this
  version, a pid, whether it leads a group, a non-empty token, a start time —
  or that it cannot be read. `endRecorded` never hands such a record to its
  end function: it stays, as 'unknown', with its file's name and why;
  `endProcess` answers 'unknown' for it before it reads the table. The
  canonical runner names it: `pid N of run R: unknown — its record is not of
  format version 1, so it was left alone`; a record without a pid by its
  file's name.
- Every token comparison goes through one check that never matches an empty
  or missing recorded token; the members of a leaderless group are checked
  with it, so an unreadable environment never matches a missing token. An
  environment's empty token now reads as empty on macOS too (it read as
  none). The `-Infinity` start time for a record without one is gone.
- `identityOf`: a group leader that exited before it was recorded is recorded
  by the start time it still shows while it waits to be reaped; one already
  reaped while its group lives cannot be recorded, so every record written
  has full identity.
**Tests (written first: against the previous registry, with `RECORD_VERSION`
exported first so that the suites could load, 5 failed):**
- The reviewer's two probes: a marker-format record for a leader that runs,
  and one for a leaderless group whose member's environment cannot be read
  (here through a `ps` that cannot read environments; since `5acff7a` through a
  `/proc` that shows none as well). Each is 'unknown', is not handed on, its
  record stays and nothing is signalled.
- Records without a version (the cycle-14 format), a token, an empty token, a
  start time, a start time that is none, the group flag or a pid, and one that
  cannot be read: each 'unknown', with why, kept.
- A process whose environment holds an empty token is neither recorded by it
  nor ended by a record carrying it.
- A leader recorded after it exited: recorded by the start time the table
  still shows, and its group ended.
- The runner, on an earlier run holding a marker-format record of a live
  process and a torn record: the run fails, names both with why, signals
  nothing and keeps both.
**Mutation check:** 12 mutants, all killed: no gap ever found; no version,
token, start time, group flag or pid required; an empty token matching; an
exited leader showing no start time; the runner not saying why; a record
that cannot be read skipped; `endProcess` acting on a record without full
identity; `endRecorded` handing one to its end function.
**The red run left two processes.** The record test's cleanup was not
reached when its first assertion failed, so its two helpers (a recorded
process and a leaderless group's member) held their minute and then exited by
themselves; the test's cleanup now covers every failure.

### CYCLE14-MED-002 — two tests dropped the run's registry — ACCEPTED

**Invariant (R49):** nested test registries keep the outer one: the fake
docker and registry tests add their registry to the existing
`ASEP_PROCESS_REGISTRY` and assert that the helper appears in the outer
registry too; the fitness test rejects an assignment that drops the outer
value.
**Change (`8eb5dd0`):** `nestRegistry(dir)` adds a test's own registry to the
run's in the environment, beside it, and returns what restores the
environment; the two tests, and the agent adapter's test that already kept
the run's by hand, use it. Every instance of the class: a runner started
inside a run (`withProcessRegistry`, as the runner's wiring tests do) now
keeps the outer run's registry beside its own, so what a nested run's tests
start is in the outermost run's registry too. The fake docker test's
containers hold a minute at most, as the registry test's processes do.
**Tests (written first: against the previous registry with a `nestRegistry`
that put the test's registry in place of the run's, as the tests did before,
4 failed):** the fake docker, registry and runner tests assert that what
their helpers start is in the outer registry (a stand-in for one when the
file is run by hand), and the registry test that the environment lists its
own registry and then the run's. The fitness test rejects any test source
that assigns or deletes the registry variable, or hands a child an
environment with a registry not on its list of ones that keep the run's (one
entry: the fake docker test's `registryEnv`). It passed against the previous
registry — it reads the test sources, which by then used `nestRegistry` — so
the mutation check is what shows it bites.
**Mutation check:** 5 mutants, all killed: `nestRegistry` putting the registry
in place of the run's; a nested run dropping the outer registry; a test
assigning its own registry, handing a child a registry without the run's, or
deleting the registry variable (each caught by the fitness test).
**Residual:** a nested run's records stay in the outer run until the outer
run's close, which finds them gone: the canonical runner at `8eb5dd0` listed
four such records as `gone`.

### CYCLE14-LOW-001 — a budget beyond the proxy's maximum ran — ACCEPTED

**Invariant (R49):** budgets beyond the proxy maximum are refused before any
side effect.
**Change (`07f6701`):** the provider refuses, as BLOCKED, an attempt whose
wall-clock budget plus `PROXY_EXPIRY_GRACE_MS` exceeds `PROXY_MAX_LIFETIME_MS`
— a budget of more than 239.5 minutes — or that is not a number, with a named
reason ("its wall-clock budget of N minute(s) and the egress proxy's 30000 ms
grace exceed its maximum lifetime of 14400000 ms"), before the credential is
read or docker is asked for anything. The runbook says so.
**Tests (written first; red against the previous provider):** a 24-hour
budget, the longest allowed budget plus one millisecond, and NaN are refused,
no credential is asked for and no docker call is made; the longest allowed
budget runs, and its proxy's lifetime is within 10 s of the maximum.
**Mutation check:** 4 mutants, all killed: no refusal; a budget that is not a
number passing; the grace not counted; the longest allowed budget refused.

### CYCLE14-LOW-002 — no test of an unreadable /proc environment — ACCEPTED

**Invariant (R49):** a test where reading `/proc/<pid>/environ` fails: outcome
unknown, record kept, gate red; the `undefined → null` mutant must fail.
**Change (`5acff7a`):** `ASEP_PROCESS_TABLE_PROC` (exported as `PROC_ENV`) names
the directory read as `/proc`, for the tests; with it set the registry reads
environments as it does on Linux, on any host.
**Tests (written first; against the previous registry, with `PROC_ENV` exported first so that the suites could load, the two new tests failed):** a recorded process whose environment is
read through such a directory: as a file of NUL-ended entries it shows the
token and identifies the process; as a directory it cannot be read, and the
process is unknown — recording fails, nothing is signalled, its record stays.
The runner, reading through a `/proc` that shows no environment, fails its
run, names the process as unknown and signals nothing. The record test of
CYCLE14-MED-001 reads its leaderless group's member through such a `/proc`
as well.
**Mutation check:** 3 mutants, all killed: a failed read taken as an environment without
the token (the reviewer's `undefined → null`); the stand-in ignored; the
entries split by newline instead of NUL.
**Not verified:** the real `/proc` of a Linux host. This host is macOS; the
CI runner (ubuntu-latest) takes that path.

### Docs — claims broader than the code — ACCEPTED

The cycle-14 review found two claims broader than the code, both corrected in
place with a note:
- "A test that keeps a registry of its own keeps it beside the run's"
  (CYCLE13-MED-003 above): at `bfd0e7f` two tests put theirs in place of the
  run's. True since `8eb5dd0`.
- "Every long-lived process a test starts is in the run's registry" (the
  cycle-13 summary and the report): the fitness test allows spawns that are
  not recorded, each on its list with why — docker clients through a shim,
  whose containers the fake docker records; processes of the live proof and
  the integration runner, outside the canonical run; members of recorded
  groups; and, by design, a process that shows no token of ours, a system
  binary whose environment `ps` does not show, and (since `ebf3fa4`) a leader
  the test records itself after it exited. The claim now reads: every process
  a test starts is recorded in the run's registry, or is on that list with
  why it need not be.

### CYCLE11-HIGH-002 — disposition R47 unchanged

Nothing in this cycle changes what is known of the Node launch stall. Every
gate ran through `gate.sh`; none showed a launch of 10 s or more.

**Gate runs of this cycle.** Every one through `gate.sh`; the sampler line is
its own summary.

| Commit | Gate | Result | Tests | Duration | Sampler: samples, longest Node launch, launches of 10 s or more | Valid under R47 |
|---|---|---|---|---|---|---|
| `81dd27c` | `verify:all` | exit 0 | 900 of 900 | 557 s | 233, 4353 ms, 0 | yes |
| `9b5f65c` | `verify:all` | exit 0 | 904 of 904 | 507 s | 208, 3472 ms, 0 | yes |
| `ebf3fa4` | `verify:all` | exit 0 | 908 of 908 | 531 s | 222, 4652 ms, 0 | yes |
| `8eb5dd0` | `verify:all` | exit 0 | 909 of 909 | 531 s | 223, 6362 ms, 0 | yes |
| `07f6701` | `verify:all` | exit 0 | 910 of 910 | 522 s | 220, 4328 ms, 0 | yes |
| `5acff7a` | `verify:all` | exit 0 | 912 of 912 | 526 s | 219, 4146 ms, 0 | yes |
| `5acff7a` | `test:integration` | exit 0 | 34 of 34 | 102 s | 46, 1194 ms, 0 | yes |

No gate run of this cycle was red. The canonical runner listed records of its own run as `gone` from `8eb5dd0` on —
four at `8eb5dd0` and `07f6701`, six at `5acff7a`: processes the runner's
wiring tests start in nested runs, recorded in the outer run too since
`8eb5dd0`, and already ended (see CYCLE14-MED-002). No run found a recorded
process still running, before or after the tests. After the integration
run no container labelled `asep.role` and no network labelled `asep.attempt`
remained. The final sequence on the
report commit — `pnpm install --frozen-lockfile`, two `verify:all` and two
`test:integration` runs, each through `gate.sh` — is bound by the L1
sentinel and reported to the controller with its sampler lines.

### Port and schema deltas for Lanes A and B

No port, schema or migration changes in this cycle. Contract changes, all
inside adapters and test tooling:
- `@asep/agent-claude`: the egress proxy starts without the credential:
  `assets/egress-proxy.mjs` takes `--credential-window-ms` (at most its
  exported `CREDENTIAL_WINDOW_MS`), prints `asep-egress-proxy serving` once it
  holds the credential, and its `egressProxy` takes `credentialBy` and returns
  a server with `provideCredential(key)`; new exports `PROXY_START_TIMEOUT_MS`,
  `PROXY_CREDENTIAL_WINDOW_MS` and `proxyHandshake`; an attempt whose budget
  plus the grace exceeds `PROXY_MAX_LIFETIME_MS` is BLOCKED before it starts.
- Test tooling: `scripts/lib/process-registry.mjs` records
  `{ version, pid, group, token, startedAt }` and exports `RECORD_VERSION`,
  `identityGap`, `nestRegistry` and `PROC_ENV`; `endRecorded` returns a record
  without full identity as 'unknown' with `record` and `why`;
  `withProcessRegistry` keeps the outer run's registry. Fake docker records
  carry the version.
