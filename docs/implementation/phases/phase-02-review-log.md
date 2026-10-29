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
