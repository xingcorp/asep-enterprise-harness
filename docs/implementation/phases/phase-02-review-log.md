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
| CYCLE9-HIGH-002 | ACCEPTED — the hung-agent test measures the interval the product bounds; the 80.8 s run explained as far as its log allows (below) | `9fc9a30` |
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

**Where the 80.8 s went.** At `a447983` the test measured from just before
`execute()` to its assertion, with a 9 s budget whose deadline counts from
the start of `execute()`, setup included. Run 1's log records only the total
(80.8 s) and that the status (`BUDGET_EXHAUSTED`) and the wall-clock note
passed, so setup finished before the deadline (otherwise the proxy's start
timer fails the attempt `FAILED` in setup) and the deadline stopped the agent;
about 72 s therefore went to the stop and teardown. That path was bounded only
by docker-call timeouts: `docker kill` of the agent (60 s), its `rm -f`
(60 s), the proxy's kill (30 s) and up to 5 s for its client, the proxy's
`rm -f` (60 s), a container sweep of up to 20 tries, `network rm` (60 s) and
a network sweep of up to 5 tries — far above 72 s. The 60 s total the test
asserted was below the product's own bound. Run 1 has no per-phase
timestamps, so which call took the time is not recorded. Reproductions here,
with the new timeline (times after the stop):

| Load | Setup | Stop after due | Agent removed | Torn down |
|---|---|---|---|---|
| idle, load average 3 | 0.35 s | 3 ms | 0.18 s | 0.61 s |
| 24 host and 4 VM CPU burners, 2 container-churn loops, load average 37–79 (2 runs) | 3.0–3.5 s | 1–4 ms | 0.92–1.28 s | 3.6–4.0 s |
| the same plus 6 container-churn and 6 network-churn loops, load average 60–106 (2 runs) | 13.4–19.1 s | 3 ms | 2.9–4.7 s | 11.4–12.3 s |
| full integration gate under 24 host and 4 VM burners, 2 container- and 2 network-churn loops, load average 28–112 | 5.6 s | 3 ms | 1.5 s | 5.5 s |

No reproduction came near 72 s after the deadline. The heaviest setup (19.1 s)
would have outlasted the old 9 s budget and failed the attempt in setup. In
the same run 1, the command runner's cancellation-and-normal-exit test took
71.6 s, which fits
a window in which daemon calls ran towards their client timeouts; that is an
inference from the log, not an observation. With the new assertions a stop
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
