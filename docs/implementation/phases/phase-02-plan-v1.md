# Phase 2 — Single-Agent Governed Vertical Slice — Plan (v1, DRAFT)

> Status: **DRAFT for independent review.** Not locked. Superseded by `phase-02-plan.md` after Codex review (Prompt 2) and disposition (Prompt 3).
> Planner: Claude Opus 4.8 (controller session, plan-only). Reviewer (next): codex gpt-5.6-sol, read-only.
> This is a **planning session**. No production code, no dependencies added, no runtime files modified, no push, no PR.

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

See `phase-02-architecture-v1.md` §2–§4 for full diagrams. Summary of new containers: PostgreSQL (operational state), object store (MinIO local / S3 prod parity), Git mirror cache + worktree pool, sandbox runtime (rootless Docker), Control Plane API (Fastify modular monolith), Task Executor CLI/worker.

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

Full detail in `phase-02-data-model-v1.md`. Hierarchy: `Organization → Project → RepositoryBinding → Run → Task → Attempt`, plus `WorkspaceLease`. New enums:
- `TaskStatus`: `PENDING → READY → EXECUTING → VERIFYING → WAITING_FOR_HUMAN_REVIEW | FAILED | BLOCKED | CANCELLED`. **No `ACCEPTED` reachable by machine** in Phase 2 — human review is the terminal machine state.
- `AttemptStatus`: `CREATED → AGENT_RUNNING → AGENT_DONE → VERIFYING → EVIDENCE_READY → PUSHED → PR_OPEN | FAILED(class) | CANCELLED`.
- `LeaseStatus`: `ACTIVE → RELEASED | EXPIRED | QUARANTINED`.

`ExecutionEnvelope` (operational routing, separate from `WorkOrder`):
```text
organizationId, projectId, repositoryBindingId, runId, taskId, attemptId,
workOrderRef: ArtifactRef, workOrderSchemaVersion, envelopeSchemaVersion
```
WorkOrder stays the business instruction; envelope carries operational identifiers. No breaking change to `work-order/v1`.

---

## 9. PostgreSQL schema and indexes

See `phase-02-data-model-v1.md` for DDL. Tables: `organizations, projects, repository_bindings, runs, tasks, attempts, workspace_leases, artifacts, command_executions, pull_requests, audit_events, idempotency_records`. Decisions: **ULID** text PKs (sortable, app-generated, no provider lock); all timestamps `timestamptz` UTC; optimistic-concurrency `version int` on mutable aggregates; FKs everywhere; **partial unique index** guaranteeing one `ACTIVE` lease per `(repository_binding_id, branch)`; unique idempotency keys; no ORM (raw `pg` + hand SQL); migration files append-only with checksum manifest; migrations tested forward on a clean database. Transactions use **one checked-out client** from `BEGIN`..`COMMIT/ROLLBACK`.

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
build immutable ContextPack → artifact
invoke Claude adapter (bounded; no forge cred; no commit)
capture provider events + raw stdout/stderr → artifacts
inspect Git state/diff (reject agent commits/refs/forbidden paths)
run required trusted verification commands (sandbox no-network) → raw artifacts
build EvidenceBundle (schema-valid)
harness-owned commit (bot identity + ASEP trailers)
push branch via GitHub App (JIT cred, forge adapter only)
create/update PR idempotently (never merge)
set task WAITING_FOR_HUMAN_REVIEW
release/retain workspace per policy
```
Failure at any step: persist classified failure (17-class taxonomy), preserve evidence, do not push/PR unless policy allows failed draft, release/quarantine workspace, never mark accepted.

---

## 12. Ports and adapters (new port signatures — see architecture doc §6)

`RepositoryMirror`, `WorkspaceManager`, `WorkspaceLeaseRepository`, `GitChangeInspector`, `GitCommitter`, `ArtifactStore` (extended with `verify`), `CommandRunner`, `SandboxProvider`, `ForgeProvider`, `GitHubAppCredentialProvider`, plus repositories for each aggregate. `CodingAgentProvider` reused as-is from `packages/ports`.

---

## 13. Trust boundaries

Agent (untrusted) ⟷ harness (trusted). Agent may mutate only the leased worktree working tree. Agent never receives: forge credentials, production credentials, network egress beyond the profile, `.git` write authority. Trusted verification commands come from approved project config + VerificationPlan mapping — never a model-generated shell string. Details in `phase-02-threat-model-delta-v1.md`.

---

## 14. Artifact lifecycle

`raw bytes → sha256 → object key (content-addressed) → immutable object write → metadata row in PostgreSQL`. `verify` re-hashes on read; mismatch fails closed. Artifacts written before summaries. Min set: ContextPack, provider event stream, raw stdout, raw stderr, git diff, git status, verification outputs, environment manifest, EvidenceBundle, PR metadata. Filesystem adapter for tests; S3-compatible adapter for MinIO/S3 parity.

---

## 15. Git / worktree lifecycle

Mirror (bare cache) separated from worktrees. Path `worktrees/<project>/<run>/<task>/<attempt>` derived from normalized/hashed IDs; `realpath` containment-checked under workspace root. Base SHA pinned + verified present. One writer per worktree (lease). Heartbeat + expiry. Stale/faulted worktree quarantined, never reused. Cleanup idempotent. Harness rejects agent-created commits/refs and creates its own commit with trailers `ASEP-Run/Task/Attempt/Evidence`. Submodules unsupported/governed. No forge token in worktree.

---

## 16. GitHub App lifecycle

App private key held by controller/credential provider (never workspace/log/artifact). Installation token minted JIT, scoped to the exact repository + minimum permissions (Metadata:read, Contents:read/write, Pull requests:read/write, Issues:read only if ingesting). Token treated as **opaque** (no length assumption). Webhook HMAC verified; delivery IDs deduplicated. Push only after verification. PR create/update idempotent (find-by-head-branch upsert). **No merge capability.** Rate-limit classified; remote URL scrubbed of credentials in logs.

---

## 17. Claude session lifecycle

Behind `CodingAgentProvider`. Structured JSON / stream JSON (not prose scraping). Pin model + SDK/CLI version. Max turns, timeout, cancellation (`AbortSignal`). Explicit allowed/disallowed tools; **no dangerous permission bypass**. Sanitized env allowlist. ContextPack + WorkOrder hashes passed. Capture session id + usage. Malformed/partial events fail closed. No commit/push/self-approval/forge credential. Do not resume a session after ContextPack/base SHA changed. Live calls opt-in; CI uses a fake executable contract.

---

## 18. Failure classification

Reuse Phase 1 `classifyFailure` (17 classes). Map slice faults to signals: provider error → `provider`; quota → `quota-rate-limit`; sandbox/tool fault → `tool`; missing artifact → `artifact-loss`; agent commit/push/scope attempt → `policy-violation`; declared-complete-but-red → `false-completion`; lease/worktree recovery fault → `workflow-recovery-failure`; duplicate PR/commit → `duplicate-side-effect`.

---

## 19. Idempotency strategy

Every side effect keyed in `idempotency_records`: attempt creation, worktree creation, artifact put (content-addressed = natural idempotency), commit (attempt→commit 1:1), branch push, PR upsert. Retried operations detect prior record and return the prior result rather than duplicating.

---

## 20. Testing pyramid

Domain transition tests; architecture dependency/forbidden-import fitness (extended); port contract tests; **real PostgreSQL** integration + migration clean-start; **real temporary Git repo/worktree** tests (base-SHA pin, concurrent-lease denial, path/symlink traversal, agent-commit rejection, idempotent cleanup); command runner (exact exit code, signal, timeout kills descendants, env allowlist, cwd containment); artifact corruption/checksum + cross-project isolation; **MinIO/S3** integration; Claude adapter fake-process (malformed/partial/timeout/cancel/non-zero/quota/permission-deny/commit-attempt); GitHub adapter transport-mock/contract; **full vertical integration** with real PG+Git+artifacts but fake Claude+GitHub; **opt-in** live smoke; crash/cleanup. No test weakening, no always-green scripts, live tests skip cleanly without credentials.

---

## 21. Observability and audit

Spans: `asep.task.execute, asep.context.build, asep.workspace.lease, asep.workspace.create, asep.agent.invoke, asep.command.execute, asep.artifact.put, asep.git.commit, asep.forge.push, asep.forge.pull_request`. Every span/event carries `organization_id, project_id, repository_binding_id, run_id, task_id, attempt_id, workspace_id?`. Full source/prompt/raw tool output **off by default** (OTel GenAI content is opt-in + redacted). Privileged operations audited to `audit_events`.

---

## 22. Migration from current kernel

`executeTaskKernel` moves to `packages/application/execution/execute-task.ts` as a provider-neutral use case taking injected ports. Worker becomes `composition-root.ts` (load config → build adapters → inject → call use case → manage lifecycle). The `artifact-placeholder` diff ref is replaced by a real content-addressed `ArtifactRef` from the artifact store. Existing kernel test is preserved/ported against the application package with fakes.

---

## 23. Phase 3 compatibility

The application use case is callable unchanged from a future Temporal activity: keep it framework-free, side-effects behind ports, all inputs serializable, idempotency keys explicit. No `node:http`/Fastify/Temporal import in `packages/application`. Ports designed so a durable dispatcher can wrap the same use case.

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

Machine-checkable list in `phase-02-exit-criteria-v1.md`. Highlights: Phase 1 gate still green; no canonical schema regression; application logic out of worker; PG state survives restart; real immutable artifacts replace placeholder; real worktree isolation tested; concurrent lease fails; agent cannot reach ACCEPTED; agent gets no forge credential; harness owns commit; verification preserves exact exit code; raw output stored before summaries; PR create/update idempotent; PR never merged; full fake-provider integration passes; ≥1 opt-in live pilot before claiming live integration; **10 real low-risk pilot tasks** required for full completion else `IMPLEMENTATION_COMPLETE_PILOT_PENDING`; full PR→evidence→attempt→task→run→project traceability; clean checkout verify passes; no CRITICAL/HIGH final review finding.

---

## 29. Pilot protocol

Low-risk public/test repository only; human-authorized; one real Claude invocation; one real PR; no merge; credentials redacted; PR/evidence traceability verified. Ten real tasks required for `COMPLETE`; synthetic fixtures cannot satisfy the pilot requirement.

---

## 30. Blocking questions (only genuine blockers)

1. **Pilot repository + GitHub App**: Phase 2 full completion needs one real low-risk pilot repo and a GitHub App installation (private key + installation id). Not needed to write code or pass the fake-provider gate; needed for live smoke + 10-task pilot. Provide at implementation/pilot boundary, else the honest verdict is `IMPLEMENTATION_COMPLETE_PILOT_PENDING`.
2. **Docker availability**: sandbox integration + no-network tests need a working Docker/rootless runtime on the implementation host. If unavailable, those tests skip and the sandbox is marked pilot-only (not "production secure").

Neither blocks planning; both are recorded so the final verdict stays honest.

---

## Output

```text
PLAN_STATUS: DRAFT (v1, awaiting Codex plan review)
BASE_SHA: e046885ad9f800f8d0c7a1fee965f9e670baee96
PHASE_1_BASELINE: PASS
PLAN_FILES:
  - docs/implementation/phases/phase-02-plan-v1.md
  - docs/implementation/phases/phase-02-architecture-v1.md
  - docs/implementation/phases/phase-02-data-model-v1.md
  - docs/implementation/phases/phase-02-threat-model-delta-v1.md
  - docs/implementation/phases/phase-02-risk-register-v1.md
  - docs/implementation/phases/phase-02-exit-criteria-v1.md
  - docs/implementation/phases/phase-02-research-register-v1.md
NEW_DEPENDENCIES_PROPOSED: fastify@5.10.0, pg@8.22.0 (+@types/pg@8.20.0),
  @aws-sdk/client-s3@3.1093.0, @octokit/auth-app@8.2.0, @octokit/rest@22.0.1,
  @anthropic-ai/claude-agent-sdk@0.3.218, @opentelemetry/sdk-node@0.221.0
  (+@opentelemetry/api@1.9.1)   [see research-register for justification/pinning]
ARCHITECTURE_DECISIONS: application layer extraction; ExecutionEnvelope vs WorkOrder;
  ULID PKs; raw pg no ORM; content-addressed artifacts; one-writer lease; harness-owned
  commit; GitHub App not PAT; rootless-Docker verification-no-network; human review terminal.
BLOCKERS: none for planning (2 pilot-boundary dependencies recorded in §30)
READY_FOR_CODEX_REVIEW: yes
```

Do not implement Phase 2.
