# Phase 2 — Single-Agent Governed Vertical Slice — Plan (LOCKED)

> Status: **LOCKED** — canonical plan for Phase 2 implementation.
> Supersedes `phase-02-plan-v1.md`. Adjudication of the Codex plan review (Prompt 2, verdict `REQUEST_CHANGES` @ 0.98) is in `phase-02-review-log.md`; every CRITICAL/HIGH/MEDIUM/LOW finding was ACCEPTED and folded into this plan (see §31).
> Planner: Claude Opus 4.8 (controller session, plan-only). Plan reviewer: codex gpt-5.6-sol, read-only.
> This remains a **planning session**. No production code, no dependencies added, no runtime files modified, no push, no PR.

```text
BASE_SHA: e046885ad9f800f8d0c7a1fee965f9e670baee96   (main)
PHASE_1_BASELINE: PASS (pnpm install --frozen-lockfile clean; pnpm verify:all all gates green)
TARGET_BRANCH: phase/02-single-agent-vertical-slice   (to be created from BASE_SHA at implementation time)
```

---

## 0. Execution model

Same on-machine model as Phase 1. Plan → independent plan review → lock → implement (isolated worktree, commit-per-slice, sentinel) → final independent audit → human-gated publish.

| Step | Role | Runner |
|---|---|---|
| PROMPT 1 | Planner (Opus 4.8) | controller session, read+plan only (**this document**) |
| PROMPT 2 | Plan reviewer | `codex` CLI, fresh read-only |
| PROMPT 3 | Plan lock | controller session + one docs commit |
| PROMPT 4 | Implementer | detached worker, isolated worktree, branch `phase/02-single-agent-vertical-slice`, commit-per-slice, `.task-complete` last |
| PROMPT 5 | Final auditor | `codex` CLI, fresh read-only, verifies repo+evidence not transcripts |
| PROMPT 6 | Dispatcher | launcher/monitor/recovery only |

---

## 1. Current-state audit (file-level evidence)

Verified on `main` @ `e046885`. Node **24.6.0**, pnpm **10.31.0**, TypeScript **7.0.2**, `tsx` runner. `pnpm install --frozen-lockfile` clean. `pnpm verify:all` green across: format-check, typecheck, canonical test runner, filter tests, compat gate, forbidden-imports fitness, secret/large-file/PII scans, publication gate, clean-tree.

### 1.1 Discovery: Phase 1 was accepted but unmerged

At session start `main` was at `9f60c9d` (plan-approval docs only). The accepted Phase 1 implementation (43 commits, Codex re-review **cycle 6 → ACCEPT_PHASE** @ `a150286`, recorded in commit `e046885`) lived only on `phase/01-evaluation-contracts`. Per user decision this session:
- Deleted the stale untracked `docs/implementation/phases/phase-01-final-independent-review.md` (superseded first-cycle `REQUEST_REPAIR` review; all its cited files exist only on the branch and all findings were repaired + re-accepted downstream).
- Fast-forwarded `main` (`9f60c9d..e046885`, 178 files) — a clean FF because `9f60c9d` was the merge-base.

Phase 2 therefore builds on the **real** Phase 1 foundation, not the reference starter.

### 1.2 Packages present (domain layer — DO NOT couple to providers)

| Package | Purpose | Key exports |
|---|---|---|
| `packages/contracts` | Canonical schemas (12) + generated TS types + AJV validators + compat gate | `WorkOrder`, `ContextPack`, `EvidenceBundle`, `ReviewReport`, `RunEvent`, branded IDs (`ProjectId`,`RunId`,`TaskId`,`AttemptId`,`ArtifactId`) |
| `packages/domain` | `RunAggregate` + `transition()` state machine (19 `RunStatus`) | `transition`, `isTerminal` |
| `packages/policy` | Deterministic risk/verification/approval/failure engines, YAML-sourced | `gatePolicy`(derived), `approvalFor`, `requiredLevels`, `classifyFailure` |
| `packages/ports` | Provider-neutral interfaces | `CodingAgentProvider`, `ReviewProvider`, `WorkflowEngine`, `ArtifactStore`, `MemoryProvider`, `OutputReducer` |
| `packages/observability` | Telemetry sink + evidence + metrics | `TelemetrySink`, `CorrelationContext`, evidence-bundle generator, metrics dictionary |

### 1.3 Apps / workers / adapters present

- `apps/control-plane-api/src/index.ts` — raw `node:http` server, 4 static routes (`/health/live`, `/health/ready`, `/v1/capabilities`, 404). No DB, no domain wiring.
- `workers/workflow-worker/src/index.ts` — `executeTaskKernel()` **application use case living in the worker package** (the layering defect to fix). Calls a `ReviewProvider` with `diffArtifactId: 'artifact-placeholder' as never` (line 37) — **the placeholder to replace**.
- `adapters/agent-mock` — `MockCodingAgentProvider`, returns `resultSha = baseSha`, no repo mutation.
- `adapters/memory-inmemory` — `InMemoryMemoryProvider` (not on Phase 2 critical path).

### 1.4 Canonical contracts already suited to Phase 2

- `EvidenceBundle` schema (`evidence-bundle/v1`): requires `taskId, attemptId, baseSha, resultSha, environment{imageDigest,lockfileHash}, diff{artifactId,sha256}, checks[]{id,category,command,exitCode,durationMs,stdoutArtifactId,stderrArtifactId}`, `createdAt`. Check `category` enum already includes `review` and `release`. **Raw stdout/stderr are referenced by artifact id, never embedded** — matches "raw before reduction".
- `RunEvent` schema (`run-event/v1`): closed `eventType` enum incl. `attempt.declared_complete`, `verification.completed`, `human.intervention`, `workflow.recovered`; carries `projectId`, `tenantId`, `risk`, cost/usage fields. Single catalog for all metric operands.
- `verification-matrix.yaml`: R0→[L0,L1] … R4→[L0..L9]. Monotonic.
- `approval-matrix.yaml`: R0/R1 `allowAutoMerge:true`; R2+ `allowAutoMerge:false`, `requireHumanMerge:true`. **R2+ never auto-merges.**
- `tool-policy.yaml`: defaults `network: deny`, `productionCredentials: deny`, `workspaceWrite: scoped`, `publicSkillInstall: deny`.

### 1.5 Gaps blocking the vertical slice (nothing on `main` provides these)

No application layer; no PostgreSQL; no operational entities (Organization/Project/RepositoryBinding/Attempt/lease); no real `ArtifactStore` implementation (interface only, `put/get`, no `verify`, no content-addressing enforcement); no Git mirror/worktree/lease; no trusted command runner; no sandbox; no real coding provider; no forge integration; no CLI; only a static HTTP server.

---

## 2. Phase 1 baseline gate result

```text
pnpm install --frozen-lockfile   → exit 0, clean
pnpm verify:all                  → exit 0, all gates green
git status --short               → clean (after FF + stale-file delete)
```

No unresolved Phase 1 CRITICAL/HIGH (cycle-6 `ACCEPT_PHASE`). **Not** `PLAN_BLOCKED_BY_PHASE_1`. Phase 2 planning proceeds.

---

## 3. Gap analysis

| Capability | Have on `main` | Need for Phase 2 | Slice |
|---|---|---|---|
| Application orchestration | in worker pkg (`executeTaskKernel`) | `packages/application` provider-neutral use case; worker = composition root | S1 |
| Operational domain | `RunAggregate` only | Organization→Project→RepositoryBinding→Run→Task→Attempt + lease + transitions | S1 |
| Operational routing contract | none (WorkOrder is business) | versioned `ExecutionEnvelope` | S1 |
| Persistence | none | PostgreSQL, migrations, repos, idempotency, audit | S2 |
| Artifacts | port only, placeholder | content-addressed immutable store + metadata + `verify` | S3 |
| Git isolation | none | mirror + worktree + writer lease + harness committer | S4 |
| Command exec | none | trusted runner (`shell:false`) + sandbox profiles | S5 |
| Coding agent | mock | one real Claude adapter behind port | S6 |
| Forge | none | GitHub App least-privilege, create/update PR, no merge | S7 |
| Driving adapters | static HTTP | modular Fastify control plane + CLI task-execute | S8 |
| Observability/pilot | console sink | OTel spans, audit, full integration test, pilot | S9 |

---

## 4. Phase 2 scope

**In scope:** application layer; operational domain model; PostgreSQL; project/repository/run/task registration; real immutable artifact store; Git mirror/worktree/lease; sandbox abstraction + Docker pilot adapter; trusted verification command runner; one Claude adapter; GitHub App forge adapter; harness-owned commit; create/update PR; EvidenceBundle; audit + OTel; CLI driving adapter; real pilot protocol; **no auto-merge**.

**Out of scope (Phase 3+):** Temporal workflows/activities; multi-project fair scheduler; distributed workers; multiple coding providers; cross-model runtime reviewer; Web Console; Mem0/Graphiti; ADK/DeerFlow/OpenHands; skill marketplace; RTK/Caveman; auto-merge; production release; Kubernetes/gVisor; full enterprise OIDC; UI/UX design skills. Interfaces may anticipate later adapters but no speculative abstraction without a concrete Phase 2 use case.

---

## 5. C4 container/component deltas

See `phase-02-architecture.md` §2–§4 for full diagrams. Summary of new containers: PostgreSQL (operational state), object store (MinIO local / S3 prod parity), Git mirror cache + worktree pool, sandbox runtime (rootless Docker), Control Plane API (Fastify modular monolith), Task Executor CLI/worker.

---

## 6. Module / package map (target)

```text
packages/application/{projects,repositories,execution,artifacts,forge}   NEW
packages/{contracts,domain,policy,ports,observability}                   EXTENDED (ports add operational interfaces)
packages/testing                                                          NEW (shared fakes/fixtures)
adapters/postgres, artifact-filesystem, artifact-s3, git-worktree,
         sandbox-docker, command-runner, agent-claude, github-app, auth-local   NEW
apps/{control-plane-api (Fastify), asep-cli}                             control-plane refactored; cli NEW
workers/workflow-worker                                                   reduced to composition root
```

---

## 7. Dependency direction (enforced by fitness test — S1)

```text
apps/*, workers/*   → application, adapters, ports        (composition roots)
packages/application→ domain, contracts, ports, policy, observability
packages/ports      → domain, contracts
packages/domain     → contracts
adapters/*          → ports (+ their own provider SDK)
```

Forbidden (grep/AST fitness, extends existing `scripts/forbidden-imports.test.ts`): provider SDK outside its adapter; Fastify outside control-plane adapter/app; `pg` outside postgres adapter; Octokit outside github adapter; `@aws-sdk/*` outside artifact-s3 adapter; Claude SDK/CLI outside agent-claude adapter; **no provider SDK type in domain/application/contracts/persisted records**.

---

## 8. Operational domain model + state machines

Full detail in `phase-02-data-model.md`. Hierarchy: `Organization → Project → RepositoryBinding → Run → Task → Attempt`, plus `WorkspaceLease`. New enums:
- `TaskStatus`: `PENDING → READY → EXECUTING → VERIFYING → WAITING_FOR_HUMAN_REVIEW | FAILED | BLOCKED | CANCELLED`. **No `ACCEPTED` reachable by machine** in Phase 2 — human review is the terminal machine state.
- `AttemptStatus`: `CREATED → AGENT_RUNNING → AGENT_DONE → VERIFYING → EVIDENCE_READY → PUSHED → PR_OPEN | FAILED(class) | CANCELLED`.
- `LeaseStatus`: `ACTIVE → RELEASED | EXPIRED | QUARANTINED`.

`ExecutionEnvelope` (operational routing, separate from `WorkOrder`):
```text
organizationId, projectId, repositoryBindingId, runId, taskId, attemptId,
workOrderRef: ArtifactRef, workOrderSchemaVersion, envelopeSchemaVersion
```
WorkOrder stays the business instruction; envelope carries operational identifiers. No breaking change to `work-order/v1`.

**ExecutionEnvelope is a canonical versioned contract, not a TS sketch** (disp. P2-PLAN-HIGH-010). It crosses API/CLI/worker/persistence and future Temporal boundaries, so S1 publishes `schema/execution-envelope.schema.json` (`$id` `https://asep.dev/schema/execution-envelope/v1`), a generated TS type, an AJV validator, valid+invalid fixtures, a `snapshots/v1/` entry, and it joins the compat/drift gates — exactly like the 12 Phase 1 contracts. Boundary code rejects malformed/unknown envelope versions.

### 8.1 Risk-admission matrix (disp. P2-PLAN-HIGH-001)

Phase 2 has no runtime independent reviewer, but the locked Phase 1 approval/verification matrices still bind (`approval-matrix.yaml`: R1 needs 1 reviewer; R2+ needs L8/different-family + human merge). Phase 2 therefore adds a deterministic **admission gate** that runs **before** workspace creation and agent invocation, and **fails closed** for any risk whose mandatory gates it cannot satisfy:

| Risk | Phase 2 automated pilot | Rationale |
|---|---|---|
| R0 | Allowed end-to-end (no independent reviewer required by policy) | matrix requires 0 reviewers |
| R1 | Allowed **only** if a separately recorded human independent-review step satisfies the 1-reviewer requirement | policy requires 1 reviewer; no runtime reviewer exists |
| R2–R4 | **Deferred** — admission gate refuses before agent invocation | requires L8 + different-model-family + human merge; not built in Phase 2 |

The gate never weakens `approval.ts`/`verification.ts`; it refuses unsupported risk rather than overriding policy. Table-driven tests prove an unsupported risk stops before workspace/agent/push.

### 8.2 RunEvent org/repo correlation (disp. P2-PLAN-HIGH-010)

Exit criterion J2 requires every event to resolve to org + repository. `run-event/v1` already carries `projectId` + `tenantId` but **not** `organizationId`/`repositoryBindingId`. S1 adds both as **optional** fields — an additive **minor bump to `run-event/v1.1.0`** (allowed by `COMPATIBILITY.md`; the compat gate must pass), with `snapshots/v1` retained. No breaking change; existing events stay valid.

---

## 9. PostgreSQL schema and indexes

See `phase-02-data-model.md` for DDL. Tables: `organizations, projects, repository_bindings, runs, tasks, attempts, workspace_leases, artifacts, command_executions, pull_requests, audit_events, idempotency_records`. Decisions: **ULID** text PKs (sortable, app-generated, no provider lock); all timestamps `timestamptz` UTC; optimistic-concurrency `version int` on mutable aggregates; FKs everywhere; **partial unique index** guaranteeing one `ACTIVE` lease per `(repository_binding_id, branch)`; unique idempotency keys; no ORM (raw `pg` + hand SQL); migration files append-only with checksum manifest; migrations tested forward on a clean database. Transactions use **one checked-out client** from `BEGIN`..`COMMIT/ROLLBACK`.

---

## 10. API and CLI contract

**Control Plane API** (Fastify, registration/validation/query only — no long jobs in a request):
```text
POST /v1/organizations
POST /v1/projects
POST /v1/projects/:projectId/repository-bindings
POST /v1/projects/:projectId/runs
POST /v1/runs/:runId/tasks
GET  /v1/tasks/:taskId
GET  /v1/tasks/:taskId/attempts
GET  /v1/attempts/:attemptId/evidence
GET  /v1/artifacts/:artifactId            (metadata + verified stream)
GET  /health/live | /health/ready
```
Every mutating/reading route: validate (AJV against canonical schema) → authorize (project scope) → call use case → map response. No SQL/Git/Claude/forge in handlers.

**CLI / worker** (long execution off the request path):
```text
asep task execute --task-id <id>
```
Runs the shared application use case (§11).

---

## 11. Vertical-slice sequence (the application use case)

```text
load scoped task (org/project resolved, authz)
validate task state + policy (risk → verification plan)
create Attempt (idempotency key)
acquire WorkspaceLease (unique active per branch)
create worktree at pinned baseSha
admission gate (§8.1): refuse unsupported risk before any side effect
build immutable ContextPack → artifact
invoke Claude adapter (bounded; no forge cred; no commit)
capture provider events + raw stdout/stderr → artifacts (bounded streaming)
inspect Git state/diff (reject agent commits/refs/forbidden paths)
run required trusted verification commands (sandbox no-network) → raw artifacts
preallocate evidence artifact id (non-content-derived)
harness-owned commit of staged tree (bot identity + ASEP trailers incl. preallocated evidence id)
serialize EvidenceBundle with resultSha = harness commit SHA → store at preallocated id
begin side-effect record (PENDING) keyed by tenant-scoped natural key
push exact namespaced ref via GitHub App (JIT cred, forge adapter only)
create/update PR idempotently (never merge) → mark side-effect COMPLETED
set task WAITING_FOR_HUMAN_REVIEW
release/retain workspace per policy
```
**resultSha semantics (disp. P2-PLAN-HIGH-008):** `resultSha` = the final harness commit SHA. To break the commit↔content-addressed-evidence cycle, the evidence artifact id is **preallocated** (not derived from bundle bytes), the commit embeds that id in its `ASEP-Evidence` trailer, and the serialized bundle (carrying the resulting commit SHA) is stored *after* commit but *before* push. Crash between commit and evidence-store recovers without a second commit (idempotent re-store).

**Crash-safe side effects (disp. P2-PLAN-HIGH-005):** every external effect (commit, exact-ref push, PR upsert) is wrapped by a tenant-scoped side-effect record with `PENDING/COMPLETED/FAILED` state, a request fingerprint and an owner/fencing token. On restart the driver reconciles by natural key (branch ref, PR head) so a crash on either side of the external call converges to one commit, one expected ref, one PR — never a replay.

Failure at any step: persist classified failure (17-class taxonomy), preserve evidence, do not push/PR unless policy allows failed draft, release/quarantine workspace, never mark accepted.

---

## 12. Ports and adapters (new port signatures — see architecture doc §6)

`RepositoryMirror`, `WorkspaceManager`, `WorkspaceLeaseRepository`, `GitChangeInspector`, `GitCommitter`, `ArtifactStore` (scope-aware, extended with `verify`), `CommandRunner`, `SandboxProvider`, `ForgeProvider`, plus repositories for each aggregate.

**`CodingAgentProvider` is REDESIGNED, not reused as-is (disp. P2-PLAN-HIGH-002).** The existing `execute(order, context)` shape lets the provider return `attemptId`/`resultSha`, which violates harness-owned identity, and gives no request-scoped workspace/cancellation. The v2 port is request/result-scoped:

```text
interface AgentExecuteRequest {
  attemptId: AttemptId;                 // harness-owned, pre-created
  workOrderRef: ArtifactRef;            // immutable, + hash
  contextPackRef: ArtifactRef;          // immutable, + hash
  workspace: WorkspaceCapability;       // opaque handle to the leased worktree; no raw path
  budget: Budget;                       // turns/tool-calls/cost/wallclock
  toolPolicy: ToolPolicyProfile;        // allowed/disallowed tools, network profile
  signal: AbortSignal;                  // request-scoped cancellation
}
interface AgentAttemptObservation {     // UNTRUSTED — provider self-report only
  status: 'AGENT_DONE'|'FAILED'|'BLOCKED'|'BUDGET_EXHAUSTED';
  summary: string; knownLimitations: readonly string[];
  providerSessionId?: string; usage: Usage; eventArtifactRefs: readonly ArtifactRef[];
}
```

Result carries **no** `attemptId`/`resultSha`/`changedFiles` — Git state, changed files and the result commit SHA are derived by trusted `GitChangeInspector`/`GitCommitter`, never by the provider. `GitHubAppCredentialProvider` is **internal to the github-app adapter/composition root** (disp. P2-PLAN-MED-008), not an application port; application code depends only on `ForgeProvider`.

---

## 13. Trust boundaries

Agent (untrusted) ⟷ harness (trusted). Agent may mutate only the leased worktree working tree. Agent never receives: forge credentials, production credentials, network egress beyond the profile, `.git` write authority. Trusted verification commands come from approved project config + VerificationPlan mapping — never a model-generated shell string. Details in `phase-02-threat-model-delta.md`.

**Agent separation is OS-enforced, not post-hoc inspection (disp. P2-PLAN-HIGH-006).** The untrusted agent runs in a **separate sandboxed process**, never in the harness process. Only the intended worktree working-tree files are writable; the `.git` indirection file, all linked-worktree administrative files, the shared mirror, refs, objects, config and hooks are mounted **read-only or omitted**, and safe Git observations are exposed through trusted tooling. Post-execution `GitChangeInspector` is a second line of defence (detection), not the primary containment. OS-level tests from inside the sandbox MUST fail writes to every Git-metadata surface, and host snapshots MUST remain byte-identical after corruption attempts.

---

## 14. Artifact lifecycle

`raw bytes → sha256 → object key (content-addressed) → immutable object write → metadata row in PostgreSQL`. `verify` re-hashes on read; mismatch fails closed. Artifacts written before summaries. Min set: ContextPack, provider event stream, raw stdout, raw stderr, git diff, git status, verification outputs, environment manifest, EvidenceBundle, PR metadata. Filesystem adapter for tests; S3-compatible adapter for MinIO/S3 parity.

---

## 15. Git / worktree lifecycle

Mirror (bare cache) separated from worktrees. Path `worktrees/<project>/<run>/<task>/<attempt>` derived from normalized/hashed IDs; `realpath` containment-checked under workspace root. Base SHA pinned + verified present. One writer per worktree (lease). Heartbeat + expiry. Stale/faulted worktree quarantined, never reused. Cleanup idempotent. Harness rejects agent-created commits/refs and creates its own commit with trailers `ASEP-Run/Task/Attempt/Evidence`. Submodules **fail-closed** (unsupported unless explicitly governed). No forge token in worktree.

**Clone/fetch URLs are constructed from validated forge identity, never an arbitrary transport URL (disp. P2-PLAN-HIGH-007).** `repository_bindings` stores forge identity (host + owner + repo), not a free-form `remote_url`. The trusted mirror builds the URL and allows **only** configured GitHub HTTPS hosts; it rejects `file://`, `ext::`, `ssh`, local paths, userinfo, non-HTTPS protocols, and newline/option-injection. Git runs with `--end-of-options` where supported, sanitized `GIT_CONFIG*`/`GIT_SSH*`/askpass/proxy environment, `protocol.*.allow` restricted, and hooks disabled. Real-Git tests must reject every hostile transport/config/`insteadOf`/askpass/submodule case while allowing only the exact configured repository identity.

---

## 16. GitHub App lifecycle

App private key held by controller/credential provider (never workspace/log/artifact). Installation token minted JIT, scoped to the exact repository + minimum permissions (Metadata:read, Contents:read/write, Pull requests:read/write). Token treated as **opaque** (no length assumption). Push only after verification. PR create/update idempotent (find-by-head-branch upsert). **No merge capability** (no merge method wired; installation cannot merge the default branch). Rate-limit classified; remote URL scrubbed of credentials in logs.

**RefSafetyPolicy — non-bypassable (disp. P2-PLAN-CRIT-001).** The single CRITICAL finding: with `Contents:write` and an arbitrary branch argument, the harness could push straight to `main`. Mitigation, enforced by construction:
- Push targets are **generated** under an ASEP-owned namespace `asep/<runId>/<taskId>/<attemptId>`; the caller cannot supply a free-form ref.
- `head != configured default/protected refs`; validated with `git check-ref-format`; reject tags, `HEAD`, option-like and malformed refs.
- Only an exact `create`/`update` refspec is allowed. **Deletion and force are prohibited**, except `--force-with-lease` against a recorded expected SHA.
- The pilot repository MUST carry a branch-protection ruleset that denies direct default-branch writes and denies merges by the App installation; the live pilot records the active ruleset as evidence.
- Real bare-remote tests reject `main`/`master`/`HEAD`/tag/deletion/malformed/option-like/force targets; a transport test proves only the expected namespaced ref is ever sent.

**Token lifetime (disp. P2-PLAN-MED-005).** Treat the installation token as an opaque value paired with the provider-reported expiry. Mint separately for each bounded forge operation (push, PR upsert); never persist. On auth-expiry during a long attempt, re-mint and reconcile by natural key **without replaying** a completed side effect (ties into §19 crash-safe protocol).

**Inbound webhooks are DEFERRED out of Phase 2 (disp. P2-PLAN-MED-004, scope-leak).** Creating/updating a PR needs no inbound webhook. No webhook route, secret, or dependency exists in Phase 2; the earlier HMAC/dedup MUST and its threat-model claims are removed. Revisit when a concrete use case (e.g. review-state ingestion) arrives in a later phase.

---

## 17. Claude session lifecycle

Behind `CodingAgentProvider`. Structured JSON / stream JSON (not prose scraping). Pin model + SDK/CLI version. Max turns, timeout, cancellation (`AbortSignal`). Explicit allowed/disallowed tools; **no dangerous permission bypass**. Sanitized env allowlist. ContextPack + WorkOrder hashes passed. Capture session id + usage. Malformed/partial events fail closed. No commit/push/self-approval/forge credential. Do not resume a session after ContextPack/base SHA changed. Live calls opt-in; CI uses a fake executable contract.

---

## 18. Failure classification

Reuse Phase 1 `classifyFailure` (17 classes). Map slice faults to signals: provider error → `provider`; quota → `quota-rate-limit`; sandbox/tool fault → `tool`; missing artifact → `artifact-loss`; agent commit/push/scope attempt → `policy-violation`; declared-complete-but-red → `false-completion`; lease/worktree recovery fault → `workflow-recovery-failure`; duplicate PR/commit → `duplicate-side-effect`.

---

## 19. Idempotency + crash-safe side-effect protocol (disp. P2-PLAN-HIGH-005)

A result-only row cannot atomically cover an external Git/GitHub effect: a crash *after* push but *before* recording replays the operation. Phase 2 uses a **two-phase side-effect protocol**, not a plain idempotency cache.

Each side effect (commit, exact-ref push, PR upsert) has a row keyed by a **tenant-scoped semantic key** (`(organization_id, project_id, repository_binding_id, attempt_id, operation)`) with:
- a **request fingerprint** (hash of the exact inputs) — reusing a key with different input **fails closed**;
- a **state**: `PENDING → COMPLETED | FAILED`;
- an **owner/fencing token** (the lease id) so a stale executor cannot complete another's operation;
- a **remote natural key** (branch ref, PR head branch) for reconciliation.

Protocol per effect: write `PENDING` → perform the external call → on return write `COMPLETED` with the remote result. On restart, any `PENDING` row is **reconciled by natural key** against the remote (does the ref/PR already exist at the expected SHA?) before deciding to retry vs. adopt. Content-addressed artifact `put` is naturally idempotent and needs only the fingerprint check. Convergence target: exactly one commit, one expected remote ref, one PR — regardless of crash point on either side of the call.

---

## 20. Testing pyramid + mandatory integration gate

Domain transition tests; architecture dependency/forbidden-import fitness (extended); port contract tests; **real PostgreSQL** integration + migration clean-start (+ re-apply no-op, concurrent-migrator lock, mid-migration failure recovery — disp. P2-PLAN-MED-006); **real temporary Git repo/worktree** tests (base-SHA pin, concurrent-lease denial, path/symlink traversal, agent-commit rejection, idempotent cleanup); command runner (exact exit code, signal, timeout kills descendants, env allowlist, cwd containment); artifact corruption/checksum + cross-project isolation; **MinIO/S3** integration; Claude adapter fake-process (malformed/partial/timeout/cancel/non-zero/quota/permission-deny/commit-attempt); GitHub adapter transport-mock/contract (+ ref-safety rejection matrix, token-expiry fake-clock); **full vertical integration** with real PG+Git+artifacts but fake Claude+GitHub; crash/fault-injection before/after each external call (§19); **opt-in** live smoke. No test weakening, no always-green scripts, live tests skip cleanly without credentials.

**Mandatory Phase 2 integration gate (disp. P2-PLAN-HIGH-009).** `verify:all` and CI gain a gate that **provisions digest-pinned PostgreSQL, object storage (MinIO), and the verification sandbox, waits for health, and FAILS (never skips) if unavailable.** Each critical suite carries a machine-readable `SUITE-ID` marker (tenancy, migration, artifact, git-worktree, sandbox), enforced the same way Phase 1's `canonical-tests.mjs` enforces `asep-suite:forbidden-imports` — a critical suite cannot be silently dropped. Only live Claude/GitHub tests remain opt-in. A CI-config test proves each marker is required and that unavailable PG/object-store/Docker turns the required job **red**.

**Raw-output capture (disp. P2-PLAN-MED-002).** Bounded streaming straight to immutable artifacts; **display/context limits are separate from evidence retention**; byte counts and an explicit truncation/overflow flag recorded; if complete raw evidence cannot be persisted, **mandatory verification fails closed** — a reducer never receives uncaptured output.

---

## 21. Observability and audit

Spans: `asep.task.execute, asep.context.build, asep.workspace.lease, asep.workspace.create, asep.agent.invoke, asep.command.execute, asep.artifact.put, asep.git.commit, asep.forge.push, asep.forge.pull_request`. Every span/event carries `organization_id, project_id, repository_binding_id, run_id, task_id, attempt_id, workspace_id?`. Full source/prompt/raw tool output **off by default** (OTel GenAI content is opt-in + redacted). Privileged operations audited to `audit_events`.

---

## 22. Migration from current kernel

`executeTaskKernel` moves to `packages/application/execution/execute-task.ts` as a provider-neutral use case taking injected ports. Worker becomes `composition-root.ts` (load config → build adapters → inject → call use case → manage lifecycle). The `artifact-placeholder` diff ref is replaced by a real content-addressed `ArtifactRef` from the artifact store. Existing kernel test is preserved/ported against the application package with fakes.

---

## 23. Phase 3 compatibility

The application use case is callable unchanged from a future Temporal activity: keep it framework-free, side-effects behind ports, all inputs serializable, idempotency keys explicit. No `node:http`/Fastify/Temporal import in `packages/application`. Ports designed so a durable dispatcher can wrap the same use case.

**Step decomposition (disp. P2-PLAN-MED-003).** The vertical-slice sequence (§11) is authored as a set of individually idempotent, framework-free **step use cases** (`buildContext`, `invokeAgent`, `captureArtifacts`, `inspectGit`, `runVerification`, `buildEvidence`, `commit`, `push`, `upsertPr`, `setReview`), composed by a thin **Phase 2 sequential driver**. Each step reads/writes only through ports + the crash-safe protocol (§19) and can resume from its persisted state. S9 ships a second thin test driver that resumes from each persisted step and a Temporal-shaped fake workflow that composes the same step APIs with activity-level idempotency/heartbeat/cancellation boundaries — proving Phase 3 can adopt the steps as activities without duplicating orchestration ownership. PostgreSQL holds **operational projection**; the driver (Phase 2) / Temporal (Phase 3) holds **orchestration authority** — documented so PG never becomes a second orchestrator.

---

## 24. Task DAG (acyclic)

```text
S1 application+domain ─┬─> S2 postgres ─┐
                       ├─> S3 artifacts ┼─> S8 control-plane+CLI ─> S9 obs+integration+pilot
                       │                │
                       ├─> S4 git/worktree ┤
                       ├─> S5 runner/sandbox┤
                       ├─> S6 claude ───────┤
                       └─> S7 github-app ───┘
```
S2–S7 depend only on S1 (ports/use-case shape). S8 wires them. S9 proves the slice. No cycles.

---

## 25. Slice decomposition + commit messages

| Slice | Deliverable | Commit |
|---|---|---|
| S1 | application layer + operational domain + ExecutionEnvelope + fitness rules | `refactor(application): establish provider-neutral execution use cases` |
| S2 | PostgreSQL persistence, migrations, repos, idempotency, audit, leases | `feat(persistence): add project-scoped PostgreSQL operational state` |
| S3 | immutable content-addressed artifact store (fs + S3) | `feat(artifacts): add immutable content-addressed evidence storage` |
| S4 | Git mirror, worktree, writer lease, harness committer | `feat(workspace): add isolated leased Git worktree lifecycle` |
| S5 | trusted command runner + Docker sandbox profiles | `feat(execution): add trusted sandboxed command and verification runner` |
| S6 | Claude coding provider behind port | `feat(agent): add bounded Claude coding provider adapter` |
| S7 | GitHub App forge adapter | `feat(forge): integrate least-privilege GitHub App pull-request delivery` |
| S8 | Fastify control plane modules + CLI vertical slice | `feat(vertical-slice): deliver governed task-to-pull-request execution` |
| S9 | OTel/audit + full integration + pilot evidence | `docs(phase-2): record vertical-slice evidence and pilot readiness` |

Each slice: read exit criteria → test-first where sensible → smallest change → slice gate → review diff → commit → evidence.

---

## 26. Commit plan

Nine slice commits (§25) + `fix(phase-2): address <finding-id> …` for repairs. No `git add -A`; selective staging after `git status` + secret/size scan. Docs-lock commit at PROMPT 3. No squash before final review.

---

## 27. Rollback plan

Per-slice commits on the throwaway `phase/02-*` branch off `main`; any slice revertable. `main` untouched until human merge. Worktrees removable without touching `main`. New infra (PostgreSQL, MinIO, Docker) is local dev only via `compose.yaml`; no production side effects.

---

## 28. Exit criteria

Machine-checkable list in `phase-02-exit-criteria.md`. Highlights: Phase 1 gate still green; no canonical schema regression; application logic out of worker; PG state survives restart; real immutable artifacts replace placeholder; real worktree isolation tested; concurrent lease fails; agent cannot reach ACCEPTED; agent gets no forge credential; harness owns commit; verification preserves exact exit code; raw output stored before summaries; PR create/update idempotent; PR never merged; full fake-provider integration passes; ≥1 opt-in live pilot before claiming live integration; **10 real low-risk pilot tasks** required for full completion else `IMPLEMENTATION_COMPLETE_PILOT_PENDING`; full PR→evidence→attempt→task→run→project traceability; clean checkout verify passes; no CRITICAL/HIGH final review finding.

---

## 29. Pilot protocol

Low-risk public/test repository only; human-authorized; one real Claude invocation; one real PR; no merge; credentials redacted; PR/evidence traceability verified.

**Ten-task completion is defined strictly (disp. P2-PLAN-MED-001).** A *completed pilot task* is a **distinct, human-authorized WorkOrder** run end-to-end through **real Claude, real sandbox, real GitHub App and real PostgreSQL/object storage**, reaching the documented `WAITING_FOR_HUMAN_REVIEW` outcome with a valid PR→evidence chain and a recorded human disposition. **Retries of the same task are attempts under one task and do NOT increase the count.** Fake-provider runs, failed traces, and retry inflation do not count.

A machine-readable **pilot manifest** lists ten distinct `taskId`, objective, risk, base+result SHA, provider session, PR URL, evidence checksum and human disposition. An automated verifier rejects duplicate tasks, fake adapters, failed traces and retry inflation. Synthetic fixtures cannot satisfy the pilot requirement. If fewer than ten genuine tasks exist, the verdict is `IMPLEMENTATION_COMPLETE_PILOT_PENDING`, never `COMPLETE`.

Per-task risk is bounded by the §8.1 admission matrix: automated pilot completion is **R0 only**; R1 requires a recorded human independent-review step; R2–R4 are deferred.

---

## 30. Blocking questions (only genuine blockers)

1. **Pilot repository + GitHub App**: Phase 2 full completion needs one real low-risk pilot repo and a GitHub App installation (private key + installation id). Not needed to write code or pass the fake-provider gate; needed for live smoke + 10-task pilot. Provide at implementation/pilot boundary, else the honest verdict is `IMPLEMENTATION_COMPLETE_PILOT_PENDING`.
2. **Docker availability**: sandbox integration + no-network tests need a working Docker/rootless runtime on the implementation host. If unavailable, those tests skip and the sandbox is marked pilot-only (not "production secure").

Neither blocks planning; both are recorded so the final verdict stays honest.

---

## Output

```text
PLAN_STATUS: LOCKED (canonical; Codex REQUEST_CHANGES @ 0.98 adjudicated in phase-02-review-log.md)
BASE_SHA: e046885ad9f800f8d0c7a1fee965f9e670baee96
PHASE_1_BASELINE: PASS
CODEX_PLAN_REVIEW: REQUEST_CHANGES @ 0.98 — 1 CRIT + 10 HIGH + 8 MED + 1 LOW; all ACCEPTED, none rejected
PLAN_FILES (canonical, -v1 retained as review record):
  - docs/implementation/phases/phase-02-plan.md
  - docs/implementation/phases/phase-02-architecture.md
  - docs/implementation/phases/phase-02-data-model.md
  - docs/implementation/phases/phase-02-threat-model-delta.md
  - docs/implementation/phases/phase-02-risk-register.md
  - docs/implementation/phases/phase-02-exit-criteria.md
  - docs/implementation/phases/phase-02-research-register.md
  - docs/implementation/phases/phase-02-review-log.md
  - docs/implementation/phases/phase-02-plan-review-codex-v1.md
NEW_DEPENDENCIES_PROPOSED (pin EXACT, no caret — disp. P2-PLAN-MED-008): fastify 5.10.0,
  pg 8.22.0 (+@types/pg 8.20.0), @aws-sdk/client-s3 3.1093.0, @octokit/auth-app 8.2.0,
  @octokit/rest 22.0.1, @anthropic-ai/claude-agent-sdk 0.3.218,
  @opentelemetry/sdk-node 0.221.0 (+@opentelemetry/api 1.9.1)   [research-register for justification]
ARCHITECTURE_DECISIONS: application layer extraction; ExecutionEnvelope as canonical versioned
  schema; risk-admission matrix (R0 auto / R1 human-review / R2-R4 deferred); TenantScope +
  composite FKs; scope-aware create-only artifacts; crash-safe side-effect protocol; RefSafetyPolicy
  (no default-branch write, no merge); OS-enforced agent sandbox; validated forge-derived Git URLs;
  redesigned request/result CodingAgentProvider; mandatory PG/MinIO/sandbox CI gate; webhooks deferred.
BLOCKERS: none for planning (2 pilot-boundary dependencies recorded in §30)
READY_FOR_IMPLEMENTATION: yes (Prompt 4)
```

Do not implement Phase 2 until Prompt 4.
