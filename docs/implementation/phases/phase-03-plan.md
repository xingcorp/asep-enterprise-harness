# Phase 3 — Durable Orchestration — Plan (DRAFT, pending Codex plan review)

> Status: **DRAFT v1**. It is written by Lane A in workflow step 1 (plan only). The controller runs the independent
> Codex plan review next. Lane A then adjudicates each finding in `phase-03-review-log.md` and locks the plan. No
> implementation code, tests, migrations or configuration are written in this step.
> Scope source: `docs/implementation/90-day-plan.md:24-31` (Days 31–45).

```text
BASE_SHA:        00a6889  (head of phase/02-single-agent-vertical-slice; Phase 2 NOT yet accepted)
TARGET_BRANCH:   phase/03-durable-orchestration (Lane A worktree)
BASELINE_GATE:   pnpm install --frozen-lockfile → exit 0; pnpm verify:all → exit 0 (observed 2026-10-29, §2)
INTEGRATION:     pnpm test:integration NOT run in this planning step (not required for a docs-only change)
```

Companion documents: `phase-03-architecture.md`, `phase-03-data-model.md`, `phase-03-exit-criteria.md`,
`phase-03-risk-register.md`, `phase-03-research-register.md`, `phase-03-threat-model-delta.md`,
`phase-03-review-log.md`.

---

## 0. Execution model (lane contract)

| Step | Who | Output |
|---|---|---|
| 1 | Lane A (this session) | these phase-03 docs, one docs commit |
| 2 | Controller | Codex read-only plan review → `phase-03-plan-review-codex-v1.md` |
| 3 | Lane A | adjudicate every finding → `phase-03-review-log.md`; fold changes in; plan LOCKED |
| 4 | Lane A, after "implement" | one slice per commit (§26), on this branch only |
| 5 | Controller | independent gate run + Codex final audit; Lane A repairs |
| 6 | Controller | reconcile shared surfaces with Lane B; merge on ACCEPT |

Lane A does not edit any shared surface (§30) before the controller has reconciled both lanes' requests.

---

## 1. Current-state audit (file-level evidence, read at `00a6889`)

### 1.1 What Phase 2 gives Phase 3 (reused, not rebuilt)

| Asset | Evidence |
|---|---|
| Framework-free step use cases: admission, agent, inspect, verify, commit, evidence, push, PR upsert, set-review | `packages/application/src/execute-task.ts:70,94,124`; `pipeline-steps.ts:181,342,475,609,692,786` |
| Admission runs first and refuses R2–R4 before any side effect | `governed-execution.ts:169-178`; `risk-admission.ts:82-135` |
| Two-phase side-effect log with fingerprint + fencing + remote reconciliation for commit/push/PR | `pipeline-steps.ts:342-420,609-659,692-771`; `adapters/persistence/src/side-effect-log.ts:82-205` |
| Preallocated evidence id + identity-checked adoption | `pipeline-steps.ts:475-573` |
| Injectable observability seam for privileged boundaries | `pipeline-steps.ts:870-877` |
| Mandatory, fail-closed real-backend integration gate pattern | `scripts/integration/run-integration.mjs:96-211`; `scripts/integration/lib.mjs:31-62` |
| Required-suite markers for the unit gate | `scripts/lib/canonical-tests.mjs:91-211` |
| Forbidden-import fitness incl. composition-root rules | `scripts/forbidden-imports.test.ts:34-46,69-76,261-333` |
| `WorkflowEngine` seam reserved for Phase 3 (unused) | `packages/ports/src/index.ts:79-86` |

### 1.2 Defects and gaps that block durable recovery (Phase 3 must fix)

| # | Finding (observed) | Evidence | Consequence under Temporal | Fix (slice) |
|---|---|---|---|---|
| G1 | Workspace state lives only in process memory: paths, baseline refs, base SHA | `adapters/git-worktree/src/worktree-manager.ts:60-71`; `pathOf()` throws for unknown ids `:142-147`; `cleanup()` is a no-op for unknown ids `:290-292` | After a worker restart no workspace can be inspected, committed, reconciled or cleaned. Recovery is impossible and worktrees are orphaned. | durable `workspaces` registry + rehydration (S3, S4) |
| G2 | Two unrelated workspace ids: the manager mints one (`worktree-manager.ts:108`), the lease row mints another (`lease-repository.ts:43`) | same | The janitor cannot map an expired lease to its worktree | registry links lease ↔ workspace (S3) |
| G3 | Lease `heartbeat` updates `heartbeat_at` only, never `expires_at` | `lease-repository.ts:83-89` | A long agent run outlives its TTL, and the next acquire sweeps the live lease to `EXPIRED` | `renew()` extends expiry and reports `LOST` (S3) |
| G4 | Lease `acquire` denies a second acquire **by the same attempt** | `lease-repository.ts:75-79` | An engine retry after "insert committed, worker died" can never get its own lease back (wedge) | acquire-or-adopt for the same attempt (S3) |
| G5 | A re-leased executor can never complete a crashed executor's `PENDING` side effect. This is pinned by a Phase 2 test. | `side-effect-log.ts:174-181`; `side-effect-log.test.ts:255` | Wedge after lease loss; also the zombie-worker hazard | fencing epochs with atomic takeover (S3, S5) |
| G6 | Attempt rows are created with a fresh ULID per call, with no natural key | `vertical-slice-workflow.ts:291-293`; Phase 2 schema `migrations.ts:100-124` | An engine retry of "create attempt" inserts duplicate attempts | `(task_id, attempt_number)` natural key (S3) |
| G7 | End-of-run persistence uses version-CAS updates | `vertical-slice-workflow.ts:525-551` | An engine retry raises `OptimisticConcurrencyError` after a partial write | monotonic projection writer, set-once facts (S3, S5) |
| G8 | Evidence `createdAt` comes from the wall clock on each call | `pipeline-steps.ts:549` | A retry after "object written, metadata not" regenerates different bytes and collides with create-only storage. The Phase 2 cycle-5 review reported this residual wedge (`phase-02-final-rereview-codex-v5.md:31`). | workflow supplies a deterministic `createdAt` through the existing `now` seam `pipeline-steps.ts:442` (S5) |
| G9 | The evidence id is allocated in the driver, outside any step | `pipeline-steps.ts:916` | Non-deterministic in workflow code | allocation moves inside the `commitAttempt` activity. Adoption already exists (`:350-398`). (S5) |
| G10 | Agent and verification containers have no deterministic name or label. The Claude adapter SIGKILLs the `docker` **client** on timeout or abort. | `claude-provider.ts:183-190,225-235`; `sandbox.ts:94`; no `--name`/`--label` under `adapters/` or `apps/` (`git grep`) | Suspected, **not verified**: the container may keep running after the client dies, mutating a worktree and spending budget | deterministic names + labels + `ExecutionReaper` (S4); verified by itest (research Q6) |
| G11 | `WorkflowEngine` port is untyped (`signal: unknown`) and unused | `packages/ports/src/index.ts:79-86` | Not usable as a contract | `WorkflowEngine` v2 (CR-09) |
| G12 | Policy and application import Node builtins | `packages/policy/src/policy-source.ts:12-15` (`node:fs`); `pipeline-steps.ts:32` (`node:crypto`) | They cannot be imported by Temporal workflow code (bundler forbids builtins) | pure `@asep/orchestration` core; policy only in activities (S2) |
| G13 | The production pilot path runs the sequential driver directly | `apps/control-plane-api/src/pilot-main.ts:274`; the CLI calls `executeTask` with a mock agent `cli.ts:88`, `cli-main.ts:8` | Two orchestrators once Temporal exists (ADR 0013) | entrypoints dispatch only via `WorkflowEngine` (S8) |
| G14 | `compose.yaml` pins `temporalio/auto-setup:1.31.0` by mutable tag, and that tag does not exist on Docker Hub | `compose.yaml:27-28`; research register §2 | `pnpm infra:up` cannot start Temporal on a clean host | digest-pinned `temporalio/temporal` dev server (CR-15) |

**Reported to the controller (affects Phase 2 claims, not fixed by Lane A on its own):** G10's suspected
container orphaning on Claude-adapter timeout bears on Phase 2 exit G3 ("timeout … cancellation"). G8 is the
residual HIGH-006 wedge from the cycle-5 review. If Phase 2 cycle 6 repairs G5, G8 or G10 in `0013`–`0099` or in
code, Lane A adopts those repairs and withdraws the overlapping change requests (CR-05, CR-20).

### 1.3 Phase 2 lessons applied

From `phase-02-final-review-codex-v1.md` and `phase-02-final-rereview-codex-v5.md`:

1. **A green gate that never exercised the MUSTs.** Every Phase 3 MUST maps to a named executable test with a
   SUITE-ID (`phase-03-exit-criteria.md`). Chaos MUSTs run only against a real Temporal server, real PostgreSQL,
   real MinIO, real Docker and real Git. A missing backend turns the gate red, and a negative test proves it.
2. **Backends faked where real ones were required.** In-process "Temporal-shaped" drivers prove the decision
   core only (S2). They are never cited for a recovery MUST. The SDK time-skipping server and the
   runtime-downloaded dev server are excluded from evidence (research register §2).
3. **False implementer status claims.** The phase report must quote gate output verbatim and give the log path.
   Every claim carries `file:line`. Anything not run is written "not verified" (exit N1–N4).

---

## 2. Baseline gate (observed in this session)

```text
pnpm install --frozen-lockfile   → exit 0   (pnpm warns: "Ignored build scripts: esbuild@0.28.1")
pnpm verify:all                  → exit 0   "=== verify:all: PASS (all gates green) ==="
  canonical tests                → tests 548, pass 548, fail 0; "50 test file(s), 28 required suite(s) verified"
  @asep/contracts test           → tests 80, pass 80
  @asep/policy test              → tests 35, pass 35
  contracts compat               → "compat-gate: PASS (13 schema(s) compatible with snapshot v1)"
  forbidden-imports              → tests 16, pass 16
  project-references             → tests 5, pass 5
  scans + publication            → secret / large-file / PII / license-inventory / check-publication PASS
  clean-tree                     → PASS
Toolchain: node v24.6.0, pnpm 10.31.0, tsc 7.0.2, Docker server 29.6.1
```

The baseline is green. Phase 3 planning proceeds on top of the unaccepted Phase 2 head, as the lane contract
requires.

---

## 3. Gap analysis

| Capability (90-day plan) | Have at base | Need for Phase 3 | Slice |
|---|---|---|---|
| Temporal workflows/activities | step use cases + untyped seam | `taskWorkflow`, `runWorkflow`, janitor schedule; activity bridge; `WorkflowEngine` client | S2, S5, S6 |
| Pause / resume / cancel | none | durable controls with authz, audit and projection | S2, S6, S8, S10 |
| Heartbeats | lease `heartbeat_at` only | engine heartbeats + lease renewal + cancellation bridge | S3, S5, S6 |
| Retries | none (sequential driver) | explicit per-activity retry/timeout table; agent never engine-retried | S2, S6 |
| Idempotency | side-effect log for commit/push/PR | natural keys for every durable write; epoch fencing; deterministic evidence bytes | S3, S5 |
| Worker-kill chaos tests | in-process fault matrix (PGlite) | real process SIGKILL/SIGSTOP across the full crash-point matrix on real backends | S9 |
| Duplicate-callback chaos tests | none | duplicate start / update / signal / decision / late activity completion | S9 |
| Budgets | per-attempt budget passed to provider | task + run budgets, reservation, soft/hard thresholds, ledger | S2, S3, S5, S10 |
| Approvals | none (R1 human review is recorded after the PR) | durable approval gate (budget-extension, publish-change, review-adjudication) | S2, S3, S5, S8, S10 |
| Review-loop slot for Phase 4 | none | typed `ReviewLoopPort` + default policy-only implementation | S1, S5, S6 |

---

## 4. Scope

**In scope:** Temporal task and run workflows plus a workspace janitor schedule; retry-safe activities over the
Phase 2 step use cases; durable pause/resume/cancel; heartbeats; explicit retry and timeout policy; idempotency
for every durable write; epoch fencing; durable workspace registry; container reaping; budgets at attempt, task
and run level; human approvals; the typed review-loop slot; a mandatory real-Temporal integration gate; a
worker-kill / duplicate-delivery / infrastructure-outage chaos matrix; orchestration API routes; RunEvent
persistence for recovery metrics; runbook.

**Out of scope, with the reason for each deferral:**

| Deferred item | Phase 2 status | Decision | Why |
|---|---|---|---|
| Multi-project **fair scheduler** | deferred to "Phase 3+" (`phase-02-plan.md:108`) | **stays deferred** (Phase 5+ scale work) | The exit criterion is recovery without duplicate side effects, not throughput fairness. The pilot is a single operator with low-risk repositories (`phase-02-threat-model-delta.md:52`), so there is no contention to arbitrate. A fair scheduler needs cross-run budget accounting and per-tenant quotas, which would double Phase 3 for no measurable exit benefit. Temporal task queues are the seam to add it later without changing workflow code. |
| **Distributed workers** (multiple hosts) | deferred to "Phase 3+" | **partially in:** N worker processes on **one** host. Multi-host stays deferred. | Worker-kill recovery needs more than one worker process, so a single-host pool is required. Worktrees and the Git mirror are host-local (`worktree-manager.ts:84-91,119-121`), so multi-host needs host-affine routing or shared workspace storage, which is a separate design. A host-id guard fails closed instead of silently running on a missing worktree (architecture §14). |
| Temporal **PostgreSQL persistence** in the gate | n/a | deferred, pre-production | The gate uses the real server binary with SQLite persistence (research register §2). Production persistence topology is a deployment concern (PR3-26). |
| Worker build-id / deployment **versioning** | n/a | deferred | `patched()` plus the replay corpus is enough for one deployment line. Deprecated versioning APIs are being removed in server 1.33 (research register §5). |
| Tenant / project / milestone **budgets** | n/a | deferred with the fair scheduler | They need cross-run accounting. Run and task budgets cover the cost-model's "hard thresholds pause or escalate" rule (`cost-model.md:12`) inside one run. |
| Parallel tasks / DAG inside a run | n/a | deferred | Sequential child execution makes the run budget exact without a reservation protocol (architecture §4.2). |
| Review, repair, re-review, adjudication **logic** | n/a | **Lane B (Phase 4)** | Lane A provides only the typed slot and the repair-attempt composition (§20). |
| Recovery / cost **dashboards** | n/a | Lane B (Phase 4, `90-day-plan.md:38`) | Phase 3 persists the events. Phase 4 visualises them. |
| R2–R4 execution | deferred by admission | stays deferred | Admission is unchanged. It needs Lane B's independent reviewer. |
| Inbound webhooks, live Claude/GitHub pilot, Temporal mTLS / namespace auth | deferred | stay deferred | Same reasons as Phase 2. Temporal frontend auth is a pre-production dependency (threat T3-01). |

---

## 5–7. Containers, module map, dependency direction

See `phase-03-architecture.md` §2–§3. Summary of new code:

```text
packages/orchestration                         NEW  deterministic decision core (no runtime imports)
packages/application/src/orchestration-activities/   NEW  retry-safe activity implementations
adapters/temporal                              NEW  the only @temporalio/* importer
adapters/persistence/src/orchestration/        NEW  orchestration repositories (ordinal, fence, registry, approvals, ledger, projection, run events)
workers/temporal-worker                        NEW  composition root + chaos/e2e itests
apps/control-plane-api/src/orchestration/      NEW  routes
```

Dependency direction is unchanged from Phase 2 (`phase-02-plan.md` §7), with two additions. First,
`adapters/temporal` → `@asep/orchestration`, `@asep/ports`, `@asep/contracts` and `@temporalio/*`. Second,
composition roots (`workers/temporal-worker`, `apps/control-plane-api/src/production-root.ts`) →
`@asep/temporal`. `packages/application` never imports `@asep/temporal` or `@temporalio/*`. The worker composition
root hands application activity functions to the adapter's `createWorker()`.

---

## 8. Orchestration model

`phase-03-architecture.md` §4 (task workflow, run workflow, janitor) and §13 (projection). Core rules:

- The workflow is the only place that decides what happens next. PostgreSQL status columns are a projection.
- One workflow per task (`asep-task-<taskId>`) and one per run (`asep-run-<runId>`). Starts are idempotent.
- Retries create new **attempts** only before anything has been published. At most one attempt per task
  publishes, which gives one remote ref and one PR per task.
- The terminal machine state for a successful task is still `WAITING_FOR_HUMAN_REVIEW`.

## 9. PostgreSQL schema

`phase-03-data-model.md` (migrations `0100`–`0107`, all in Lane A's range).

---

## 10. API and CLI contract (additions; Phase 2 routes unchanged)

```text
POST /v1/runs/:runId/executions                  start the run workflow           cap executions:start   idempotent (run id)
POST /v1/tasks/:taskId/executions                submit the task to its run       cap executions:start   idempotent (task id)
POST /v1/tasks/:taskId/pause | /resume           control message                  cap executions:control Idempotency-Key header → requestId
POST /v1/tasks/:taskId/cancel                    workflow cancellation            cap executions:control Idempotency-Key header
POST /v1/runs/:runId/pause | /resume | /cancel   run-level controls               cap executions:control
GET  /v1/tasks/:taskId/workflow                  live view (Temporal query)       tenant scope
GET  /v1/approvals?status=PENDING                project-scoped list              cap approvals:read
POST /v1/approvals/:approvalId/decision          record decision → deliver update cap approvals:decide     Idempotency-Key = decisionId
```

- Every route follows the Phase 2 pattern: validate (AJV, canonical schema) → authorize (server-derived
  `TenantScope` plus capability) → application use case → map the response. Handlers make no Temporal call
  directly: they call application use cases, which call the `WorkflowEngine` port (Phase 2 B5 rule,
  `forbidden-imports.test.ts:261-333`).
- `POST /v1/tasks/:taskId/executions` body: `workOrder` (validated against `work-order/v1`, stored as an
  immutable artifact and set once on `tasks.work_order_ref`; its `risk`, `baseSha` and `budget` must equal the
  task row), `contextPack` (validated against `context-pack/v1`, stored), `verificationPlanId` and optional
  `taskBudget` (bounded by the run's governance). The use case builds `task-workflow-input/v1` from these plus
  server-side state. The client never supplies tenant IDs, command strings or governance flags.
- `POST /v1/runs/:runId/executions` body: optional `runBudget` and `publicationApprovalRequired`. Setting the
  latter needs `runs:govern`, and both are immutable once the run workflow has started.
- Status codes: 401 unauthenticated, 403 missing capability or self-approval, 404 out of scope, 409 conflicting
  decision / expired approval / closed workflow, 503 when the engine is not configured. A 503 never falls back
  to the sequential driver.
- `asep task execute --task-id <id>` (CLI) becomes a client of the same use case (`submitTask`). It no longer
  runs the pipeline in-process (G13).

---

## 11. Task workflow sequence (the Phase 3 analogue of `phase-02-plan.md` §11)

```text
admitTask                         (activity; Phase 2 admission; DEFERRED → BLOCKED, nothing else touched)
loop attempt n = 1..maxAttempts:
  budget reservation              (workflow core; may open budget-extension approval)
  ensureAttempt(n, kind)          (natural key)
  acquireLease                    (acquire-or-adopt)
  prepareWorkspace                (registry CREATING → worktree at pinned base → [repair: apply parent diff] → ACTIVE)
  storeAttemptInputs              (WorkOrder / ContextPack / RepairOrder refs, ExecutionEnvelope)
  runAgent                        (engine retry = 1; heartbeats; lease renewed; container asep-agent-<attemptId>)
  inspectWorkspace                (overstep → abandon attempt, policy-violation)
  runVerification                 (reap stale verify containers first)
  if verdict != PASS: reviewLoop(VERIFICATION_FAILED) → REPAIR → next n | ESCALATE → approval | REJECTED → FAILED
  commitAttempt                   (fence claim; HEAD CAS; evidence id allocated inside; side-effect protocol)
  persistEvidence                 (createdAt = workflow time, deterministic → retry-identical bytes)
  reviewLoop(READY_FOR_REVIEW)    (Phase 3 default: NOT_REQUIRED for R0/R1)
  publication approval            (only if the run requires it)
  publishBranch                   (non-cancellable; fence; side-effect protocol; remote reconcile)
  upsertPullRequest               (non-cancellable; fence; side-effect protocol; PR reconcile)
  projectTaskState WAITING_FOR_HUMAN_REVIEW; emit task.completed; cleanup; done
on abandon (pre-publication only): reapContainers → quarantineWorkspace → releaseLease → recordUsage → next n
```

## 12. Ports and adapters

All new and changed port signatures are in §30 (CR-04 … CR-10, CR-24), which is the binding text for the controller.

## 13. Trust boundaries (delta)

`phase-03-threat-model-delta.md`. New boundaries: Temporal frontend (control-plane only); workflow history
(refs-only payloads); approval decisions (PostgreSQL evidence re-verified by the workflow before acting); worker
pool (fencing against zombies); janitor (acts only on closed workflows).

## 14. Determinism and versioning

Architecture §6. The real bundler test, the static purity fitness rules, a replay corpus replayed offline in
`pnpm test`, and canonical schemas for every workflow payload, governed by the existing compat gate.

## 15. Retries, timeouts, idempotency

Architecture §5 (activity table) and data model §5 (idempotency key catalog). No activity relies on Temporal's
default unlimited retry (research register §4).

## 16. Fencing

Architecture §7. Record fencing by epoch, local Git CAS, remote natural-key idempotency, and cancellation and
fence checks just before each external call.

## 17. Pause / resume / cancel

Architecture §9.

## 18. Budgets

Architecture §10. Reservation-based hard caps at task and run level, soft-threshold events, approval-based
extension, and verification never reduced.

## 19. Approvals

Architecture §11. Human-only, capability-checked, self-approval refused, PostgreSQL decision evidence re-verified
by the workflow, durable expiry, Update-ID deduplication plus workflow-side validation.

## 20. Review-loop slot (typed integration point for Lane B)

Architecture §12 describes the behavior. The binding types are CR-10 in §30. Summary for Lane B:

- Lane B implements `ReviewLoopPort.evaluate(scope, request, ctx)` as framework-free application code, using
  only `@asep/ports` / `@asep/contracts` types. It never imports `@temporalio/*`, `@asep/orchestration` or
  `@asep/temporal`.
- The composition root (`workers/temporal-worker/src/main.ts`) binds the implementation to the `reviewLoop`
  activity. Phase 3 ships `PolicyOnlyReviewLoop`. Integration swaps the binding, and workflow code does not
  change.
- Lane B proves its implementation with its own sequential driver, as the lane contract requires. Lane A proves
  the slot's workflow behavior with a scripted `ReviewLoopPort` double in S6 (unit) and S10 (real Temporal).
- A shared contract-test kit (`packages/ports/src/review-loop-contract.ts`, CR-10) lets both lanes run the same
  conformance checks without depending on each other.

---

## 21. Testing pyramid and the mandatory gate

| Layer | What | Where it runs |
|---|---|---|
| Pure core | reducer table tests, property tests (one PR per task, budget never exceeded, no ACCEPTED, cancel always cleans up) with a sequential in-memory interpreter | `pnpm test` |
| Fitness | Temporal confinement, workflow/core purity, explicit activity options, no second driver in production entrypoints, real bundler test with a seeded failing fixture | `pnpm test` |
| Replay | committed histories replayed with `Worker.runReplayHistories`, plus a seeded non-deterministic fixture that must fail | `pnpm test` (offline; native core-bridge, no server) |
| Activity bridge | `MockActivityEnvironment`: heartbeat mapping, cancellation → `AbortSignal`, error → non-retryable mapping | `pnpm test` |
| Activities | each activity invoked twice with identical input (PGlite + real temp Git) converges; crash-injected variants | `pnpm test` |
| Persistence | migrations `0100`+ apply, re-apply as a no-op, reject edits; epoch/takeover/ordinal/approval races on **real pg.Pool** | `pnpm test` (PGlite) + `pnpm test:integration` (real PG) |
| End-to-end | real Temporal dev server + real PG + MinIO + Docker sandbox + Git; agent double in a container; durable out-of-process forge double | `pnpm test:integration` |
| Chaos | the CX matrix (§22) via real worker processes, SIGKILL/SIGSTOP, `docker restart`/`pause` | `pnpm test:integration` |

**Mandatory gate extension (CR-14).** `scripts/integration/run-integration.mjs` also provisions
`temporalio/temporal@sha256:ad4c82c9…` (`temporal server start-dev --ip 0.0.0.0 --headless --namespace asep-itest
--db-filename /data/temporal.db` on a container volume), waits for namespace readiness through `temporal operator
namespace describe` executed **inside** that container (so the gate script needs no SDK import), and exports
`ASEP_TEMPORAL_ADDRESS` / `ASEP_TEMPORAL_NAMESPACE`. `ASEP_ITEST_OMIT_BACKEND=temporal` must turn the gate red,
proven end to end in `scripts/integration/gate-fail-closed.itest.ts`. New SUITE-IDs are required in both runners
(CR-13, CR-14). Only live Claude and live GitHub remain opt-in, as in Phase 2.

**Forge and agent doubles in the chaos suites.** No credentials exist, so Claude and GitHub stay doubles, as in
Phase 2. Phase 2's `LocalBareForgeProvider` keeps PRs in memory (`adapters/local-doubles/src/index.ts:89-91`), and
that state dies with a killed worker. So Phase 3 adds `DurableLocalForge` (new file). It pushes with real
`git push` to a real bare remote and keeps PRs plus an append-only **call log** in a file owned by the test
process, outside every worker. It enforces GitHub's one-open-PR-per-head rule. The agent double runs inside the
real Docker sandbox through the **real** `ClaudeCodingProvider` with a fake `claude` executable (the Phase 2
fake-executable pattern), so container lifecycle and reaping are real.

## 22. Chaos matrix (each row is a test; all end in `assertConvergence`, architecture §8)

| CX | Fault | Injection | Expected convergence |
|---|---|---|---|
| CX-01 | kill after `ensureAttempt` insert | crash point + SIGKILL | same attempt row reused; no second ordinal |
| CX-02 | kill after lease insert | crash point + SIGKILL | lease adopted; no `LeaseDenied` wedge |
| CX-03 | kill after `git worktree add`, registry `CREATING` | crash point + SIGKILL | promoted to ACTIVE or quarantined + replaced pre-agent |
| CX-04 | kill mid-agent, container running | SIGKILL worker | container reaped; workspace quarantined; attempt 2 runs; 1 PR; `recoveryKind: attempt-replaced` |
| CX-05 | kill mid-verification | SIGKILL worker | stale verify containers reaped; verification re-run; 1 verdict recorded |
| CX-06/07/08 | kill after commit `begin` / after `git commit` / after `complete` | crash points | exactly 1 harness commit per attempt; adopted SHA = evidence `resultSha` |
| CX-09 | kill after evidence object write, before metadata insert | crash point | retry writes identical bytes (deterministic `createdAt`); evidence adopted; no wedge |
| CX-10/11/12 | kill after push `begin` / after `git push` / after `complete` | crash points | exactly 1 remote ref at the committed SHA |
| CX-13/14/15 | kill after PR `begin` / after create call / after `complete` | crash points | exactly 1 PR; ≤ 1 successful create in the call log |
| CX-16 | kill between projection writes | crash point | projection converges; `projection_seq` monotonic |
| CX-17 | zombie: SIGSTOP during `publishBranch` / `upsertPullRequest` after the external call; heartbeat timeout; worker B retries; SIGCONT A | SIGSTOP/SIGCONT | A's `complete` fails fencing; A's late completion is rejected by the server; 1 ref, 1 PR; `side-effect.takeover` audited |
| CX-18 | Temporal server restart mid-agent and mid-publish | `docker restart` (volume-persisted history) | workflow resumes; convergence holds |
| CX-19 | PostgreSQL restart mid-activity | `docker restart` | activity retries converge |
| CX-20 | object store unavailable during artifact/evidence put | `docker pause` / `unpause` MinIO | bounded retries; convergence after recovery |
| CX-21 | lease expiry during an outage longer than the lease TTL (TTL shortened in test config) | stop all workers past TTL, restart | re-acquire + epoch takeover; 1 ref, 1 PR |
| CX-22 | 5 concurrent duplicate task submissions | parallel API calls | 1 workflow; 1 attempt 1 |
| CX-23 | duplicate pause/resume deliveries (same and different `requestId`) | parallel API calls | one transition each; projection consistent |
| CX-24 | same approval decision ×3 concurrently + one conflicting decision | parallel API calls | 1 decision row; 1 effect; conflict → 409 and validator rejection |
| CX-25 | approval expiry, then a late decision | short TTL | kind's reject path; late decision 409; `approval.expired` |
| CX-26 | agent exceeds wall-clock | fake executable sleeps | attempt `BUDGET_EXHAUSTED`; container reaped; next attempt or task outcome per budget |
| CX-27 | malformed agent stream | fake executable | attempt FAILED (classified); replacement per policy |
| CX-28 | forge rate limit for N calls | forge double fault mode | publish retries with backoff; 1 PR |
| CX-29 | projection tamper: `tasks.status` set to CANCELLED by hand mid-run | direct SQL | workflow unaffected; projection corrected at the next seq; drift audited |
| CX-30 | workspace activity scheduled on a worker with a different host id | two workers, two host ids | `WorkspaceUnavailableError` → abandon (pre-publication); never runs on a missing worktree |

The crash points are a `FaultInjector` injected **only** by the chaos worker entry
(`workers/temporal-worker/src/chaos/chaos-worker-main.ts`). It can block or exit and nothing else. It cannot skip
a step or fake a result, so it can only produce a red result. A fitness rule forbids the production entry from
importing it (exit B9).

## 23. Observability and audit

Architecture §15.

## 24. Migration from the Phase 2 driver

- The step use cases are reused unchanged in behavior. Their inputs gain `fencingEpoch` and `expectedHeadSha`
  (CR-05, CR-07), and the Phase 2 sequential driver passes them too, so the Phase 2 suites keep running.
- `runVerticalSliceWorkflow` and `governedExecution` remain the **test** drivers for the Phase 2 K1 proofs
  (`apps/control-plane-api/src/vertical-slice.itest.ts`). After S8 no production entrypoint reaches them (exit B8).
- `workers/workflow-worker` (the Phase 2 thin caller, `workers/workflow-worker/src/index.ts:20-22`) stays as is.
  The Temporal worker is a new composition root.

## 25. Task DAG (acyclic)

```text
S1 contracts+ports ─> S2 core ─┬─> S3 persistence ─┐
                               └─> S4 workspace/containers ─┤
                                                            └─> S5 activities ─> S6 temporal ─> S7 gate+e2e ─> S8 API ─┬─> S9 chaos ─┐
                                                                                                                      └─> S10 controls/budgets/approvals e2e ─┴─> S11 docs/report
```

S1 needs controller approval of the shared surfaces. S3 and S4 are independent of each other.

## 26. Slices (one commit each) with acceptance checks

| Slice | Deliverable | Commit | Acceptance checks (exit criteria) |
|---|---|---|---|
| S1 | Contracts: 3 new schemas + fixtures + snapshots + generated types; run-event 1.2.0; `TaskStatus` extension + domain transition table; ports CR-04…CR-10 and CR-24 types, error classes and the review-loop contract kit; metrics dictionary entry; ADR 0017 | `feat(contracts): add durable-orchestration message contracts and ports` | A1, A3, A7, D1 (types compile), L5, domain table tests incl. the unchanged no-ACCEPTED invariant |
| S2 | `@asep/orchestration`: reducer, activity option table, budget arithmetic, approval and control handling, review-slot routing, sequential in-memory interpreter; determinism fitness rules | `feat(orchestration): add the deterministic workflow decision core` | B2, D5 (core), D7 (core), H1, I6, J3, J7 |
| S3 | Migrations `0100`–`0107`; `adapters/persistence/src/orchestration/**` repositories; lease renew/adopt; side-effect epochs/takeover; attempt ordinal; registry; projection writer; approvals; ledger; run events; pg.Pool race itests | `feat(persistence): make orchestration state idempotent and fenced` | A5, D11, E1–E5, E9, L3 |
| S4 | Git worktree rehydration from the registry; `create` create-or-adopt; commit HEAD CAS; host-id guard; deterministic container names/labels; `ExecutionReaper`; orphan-container itest | `feat(workspace): make workspaces and sandboxes restart-safe` | E6, E7, E8 (resolves research Q6) |
| S5 | `packages/application/src/orchestration-activities/**`: every activity over `ActivityExecutionContext`; check ids resolved through `VerificationCommandCatalog` (CR-24); fence claim and assert; deterministic evidence time; `PolicyOnlyReviewLoop`; approval/budget/projection/run-event activities; double-invoke and crash-variant tests | `feat(application): expose step use cases as retry-safe activities` | B7, D6, E10, E11, J2 |
| S6 | `adapters/temporal`: workflows (task, run, janitor), activity bridge, error mapping, `WorkflowEngine` client, worker factory, bundler test, replay test (seeded fixtures); `workers/temporal-worker` root; Temporal confinement fitness | `feat(temporal): run task and run workflows on Temporal` | A2, A6, B1, B3, B4, B5, B6, B10, C5, D3, D4, D9 (bridge part) |
| S7 | Gate: digest-pinned Temporal in `run-integration.mjs`, omit hook, negative test, new required itest IDs; compose.yaml Temporal fix; `DurableLocalForge`; first real end-to-end itest; first replay-corpus capture | `feat(integration): provision a digest-pinned Temporal server in the mandatory gate` | A4, C1–C4, C6, D2, D7 (e2e), L1 |
| S8 | API routes + application use cases for executions/controls/approvals/view; capabilities; production-root `WorkflowEngine` wiring; pilot-main and CLI dispatch via the engine; no-second-driver fitness | `feat(control-plane): drive executions, controls and approvals through the workflow engine` | B8, B9, D1, D8, G9, I2, K1–K6 |
| S9 | Chaos matrix CX-01…CX-30, except CX-25 (S10), with `assertConvergence` and its negative self-test | `test(chaos): prove crash, duplicate-delivery and outage recovery on real backends` | D9 (timing), D10, F1–F15, I4, L2 (recovery rows), L4 |
| S10 | Real-Temporal e2e for pause/resume/cancel, budgets, approvals, review-slot routing with a scripted port | `test(orchestration): prove controls, budgets, approvals and the review slot on Temporal` | G1–G8, H1–H8, I1, I3, I5–I7, J1, J4–J6, L2 |
| S11 | `phase-03-report.md`, `phase-03-runbook.md`, preserved rehearsal logs, final replay corpus, docs index | `docs(phase-3): record durable-orchestration evidence and runbook` | M1–M3, N1–N4 |

Each slice runs: re-read the exit criteria → write tests first where sensible → smallest change → narrowest
suite → `pnpm verify:all` (+ `pnpm test:integration` from S3 on) → review the diff → commit. No `git add -A`, no
squash before the final review.

## 27. Commit plan

Eleven slice commits plus `fix(phase-3): …` repairs. Repairs cite the finding in the commit subject only. They
never put plan IDs in code, test names or migration names (project rule).

## 28. Rollback

Per-slice commits on `phase/03-durable-orchestration`. Migrations are additive and only `ALTER`/`CREATE`. Rolling
back code leaves extra columns and tables that Phase 2 code ignores. A runtime rollback (feature off) is: do not
configure `WorkflowEngine`. The API then returns 503 for the execution routes. There is **no** fallback to the
sequential driver: a silent fallback would reintroduce a second orchestrator. Workflows in flight under a rolled-back
worker build are handled with the runbook's "replay failure" procedure (`phase-03-runbook.md`, S11).

## 29. Exit criteria

`phase-03-exit-criteria.md`. Each MUST is numbered and mapped to the executable test (file + SUITE-ID) that
proves it.

---

## 30. Shared-surface change requests

Nothing below is edited until the controller reconciles it with Lane B. "Owner after merge" names the lane that
implements the change if approved. Every change is additive unless marked **BREAKING (internal)**: an internal
TypeScript signature change with no persisted or wire compatibility impact.

### CR-01 — `TaskStatus` extension (`packages/contracts/src/base.ts:38-40`) + DB check (coordinated)

```typescript
export type TaskStatus =
  | 'PENDING' | 'READY' | 'EXECUTING' | 'VERIFYING'
  | 'WAITING_FOR_HUMAN_REVIEW' | 'FAILED' | 'BLOCKED' | 'CANCELLED'
  | 'PAUSED' | 'WAITING_FOR_APPROVAL' | 'BUDGET_EXHAUSTED';   // Lane A
  // Lane B may add e.g. 'REVIEWING' | 'REPAIRING' — controller merges into ONE union
```

Compat: hand-authored type (not a JSON Schema), so there is no schema version impact. The DB `CHECK` on
`tasks.status` (`migrations.ts:87-88`) must be replaced by **one** controller-owned migration with the union of
both lanes' values (data model §6). Domain transitions: data model §4.1.

### CR-02 — New canonical schemas (`packages/contracts/schema/`)

`task-workflow-input.schema.json`, `run-workflow-input.schema.json`, `workflow-control.schema.json`, each at
`version 1.0.0`, `$id https://asep.dev/schema/<name>/v1`, with fixtures (valid + invalid), templates where the
repo pattern needs them, `snapshots/v1/` entries, generated TS types, AJV validators and compat/drift coverage.
Field lists: data model §4.2. Compat: new `$id`s, so there is no impact on the 13 existing schemas. The compat
gate grows from 13 to 16 schemas.

### CR-03 — `run-event` 1.1.0 → 1.2.0 (MINOR)

Additive enum values and optional fields per data model §4.3. Snapshot `v1` retained.
`packages/contracts/src/run-event-catalog.ts` and the metrics-dictionary validator are updated in lockstep.
**Coordinate:** if Lane B also bumps `run-event`, the controller merges both into one 1.2.0.

### CR-04 — Activity execution context (`packages/ports/src/index.ts`)

```typescript
export interface ActivityProgress {
  readonly stage: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

/** Engine-neutral view of one activity delivery. Application code depends on
 *  this, never on a durable-engine SDK. */
export interface ActivityExecutionContext {
  /** 1-based count of deliveries of this activity execution by the engine. */
  readonly engineAttempt: number;
  /** Aborted on engine cancellation, heartbeat timeout or worker shutdown. */
  readonly signal: AbortSignal;
  /** Last progress recorded by a previous delivery, or null. Non-authoritative. */
  readonly lastProgress: ActivityProgress | null;
  /** Liveness + checkpoint. Must not carry secrets, source or prompts. */
  heartbeat(progress: ActivityProgress): void;
}
```

Needed by both lanes. Lane B's `ReviewLoopPort` receives it.

### CR-05 — Fencing epochs (`packages/ports/src/index.ts`; implemented in `adapters/persistence/src/side-effect-log.ts`)

```typescript
export interface FencingToken {
  readonly leaseId: string;
  readonly epoch: number;            // >= 1; strictly increasing per attempt
}

export interface AttemptFence {
  /** Atomically advance the attempt's fencing epoch and return the new token. */
  claim(scope: TenantScope, input: { readonly attemptId: AttemptId; readonly leaseId: string }): Promise<FencingToken>;
  /** Throw SideEffectFencingError when a newer epoch has been claimed. */
  assertCurrent(scope: TenantScope, input: { readonly attemptId: AttemptId; readonly token: FencingToken }): Promise<void>;
}

// CHANGED (BREAKING (internal)): fencingEpoch is required on begin/complete/fail.
export interface SideEffectBeginInput {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly requestFingerprint: string;
  readonly ownerToken: string;       // lease id (unchanged meaning)
  readonly fencingEpoch: number;     // NEW
  readonly naturalKey?: string;
}
export interface SideEffectCompleteInput {
  readonly operation: SideEffectOperation;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly ownerToken: string;
  readonly fencingEpoch: number;     // NEW
  readonly resultRef?: unknown;
  readonly naturalKey?: string;
}
export interface SideEffectRecord {
  readonly operation: SideEffectOperation;
  readonly state: SideEffectState;
  readonly requestFingerprint: string;
  readonly ownerToken?: string;
  readonly ownerEpoch: number;       // NEW
  readonly takenOver: boolean;       // NEW: true when begin() took over a lower-epoch PENDING row
  readonly naturalKey?: string;
  readonly resultRef?: unknown;
  readonly existed: boolean;
}
export interface SideEffectLog {
  begin(scope: TenantScope, input: SideEffectBeginInput): Promise<SideEffectRecord>;
  complete(scope: TenantScope, input: SideEffectCompleteInput): Promise<SideEffectRecord>;
  fail(scope: TenantScope, input: {
    operation: SideEffectOperation; repositoryBindingId: RepositoryBindingId;
    attemptId: AttemptId; ownerToken: string; fencingEpoch: number;
  }): Promise<SideEffectRecord>;
}
```

Semantics: architecture §7. Migration `0103`. The Phase 2 test at `side-effect-log.test.ts:255` asserts the old
wedge ("a REASSIGNED lease cannot complete the crashed executor's PENDING row"). It is **replaced** by two tests:
a lower-epoch row is taken over, and a higher-epoch row fences out the caller. That is a deliberate,
reviewed behavior change, not test weakening. The controller must approve it explicitly. Withdrawn if Phase 2
cycle 6 repairs the handoff differently (research Q7).

### CR-06 — Lease renewal and same-attempt adoption

```typescript
export type LeaseRenewal =
  | { readonly status: 'RENEWED'; readonly expiresAt: string }
  | { readonly status: 'LOST'; readonly state: 'RELEASED' | 'EXPIRED' | 'QUARANTINED' | 'MISSING' };

export interface Lease {
  readonly leaseId: string;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly branch: string;
  readonly attemptId: AttemptId;
  readonly expiresAt: string;
  readonly adopted: boolean;         // NEW: true when an ACTIVE lease of the SAME attempt was returned
}

export interface WorkspaceLeaseRepository {
  /** CHANGED SEMANTICS: an ACTIVE lease on (binding, branch) held by the SAME
   *  attemptId is adopted (returned with adopted=true) instead of denied. */
  acquire(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; branch: string; attemptId: AttemptId; ttlMs: number;
  }): Promise<Lease | LeaseDenied>;
  /** Retained for Phase 2 callers; delegates to renew() with the acquire TTL. */
  heartbeat(scope: TenantScope, leaseId: string): Promise<void>;
  /** NEW: extends expires_at = now() + ttlMs while ACTIVE; LOST otherwise. */
  renew(scope: TenantScope, input: { leaseId: string; attemptId: AttemptId; ttlMs: number }): Promise<LeaseRenewal>;
  release(scope: TenantScope, leaseId: string): Promise<void>;
}
```

### CR-07 — Restart-safe workspaces and commit CAS

```typescript
export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly leaseId: string;
  readonly hostId: string;
  readonly pathRel: string;                       // validated segments only; never absolute
  readonly baseSha: string;
  readonly baselineRefs: readonly string[];
  readonly state: 'CREATING' | 'ACTIVE' | 'CLEANED' | 'QUARANTINED';
}

export interface WorkspaceRegistry {
  begin(scope: TenantScope, rec: Omit<WorkspaceRecord, 'state' | 'baselineRefs'>): Promise<WorkspaceRecord>; // idempotent by attemptId
  activate(scope: TenantScope, input: { workspaceId: WorkspaceId; baselineRefs: readonly string[] }): Promise<WorkspaceRecord>;
  findByAttempt(scope: TenantScope, attemptId: AttemptId): Promise<WorkspaceRecord | null>;
  findById(scope: TenantScope, workspaceId: WorkspaceId): Promise<WorkspaceRecord | null>;
  markState(scope: TenantScope, input: {
    workspaceId: WorkspaceId; state: 'CLEANED' | 'QUARANTINED'; reason: string;
  }): Promise<void>;
}

/** The workspace is not usable from this worker (other host, missing, quarantined). Non-retryable. */
export class WorkspaceUnavailableError extends Error {}

export interface WorkspaceManager {
  /** CHANGED (BREAKING (internal)): attemptId added; create-or-adopt keyed by attempt.
   *  seedDiffRef (repair attempts only): the parent attempt's checksum-verified diff artifact,
   *  applied by the harness to the working tree after checkout; HEAD stays at baseSha. */
  create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; baseSha: string; leaseId: string; attemptId: AttemptId;
    seedDiffRef?: ArtifactRef;
  }): Promise<Workspace>;
  cleanup(scope: TenantScope, workspaceId: WorkspaceId): Promise<void>;
  quarantine(scope: TenantScope, workspaceId: WorkspaceId, reason: string): Promise<void>;
}

export interface GitCommitter {
  /** CHANGED (BREAKING (internal)): refuses unless HEAD === expectedHeadSha (compare-and-swap). */
  commit(scope: TenantScope, input: {
    workspace: WorkspaceCapability;
    allowedPaths: readonly string[];
    trailers: Record<string, string>;
    identity: { name: string; email: string };
    expectedHeadSha: string;
  }): Promise<{ commitSha: string }>;
  reconcile(scope: TenantScope, input: {
    workspace: WorkspaceCapability; attemptId: string; baseSha: string;
  }): Promise<{ commitSha: string; evidenceId: string } | null>;
}
```

### CR-08 — Container reaping

```typescript
export interface ExecutionReaper {
  /** Force-remove every container labelled asep.attempt=<attemptId> (optionally one role). Idempotent. */
  reap(scope: TenantScope, input: { readonly attemptId: AttemptId; readonly role?: 'agent' | 'verify' }): Promise<{ readonly removed: number }>;
}
```

Adapter changes (CR-20): `adapters/agent-claude` and `adapters/command-runner` add
`--name asep-agent-<attemptId>` / `--name asep-verify-<attemptId>-<checkId>` and labels `asep.attempt`,
`asep.role`, `asep.org`, `asep.project` to their `docker run` argv.

### CR-09 — `WorkflowEngine` v2 (replaces the unused shape at `packages/ports/src/index.ts:79-86`)

```typescript
import type { TaskWorkflowInput, RunWorkflowInput, WorkflowControlMessage } from '@asep/contracts'; // generated (CR-02)

export type ApprovalKind = 'budget-extension' | 'publish-change' | 'review-adjudication';
export type TaskWorkflowPhase =
  | 'ADMITTING' | 'BUDGET_CHECK' | 'ATTEMPT_STARTING' | 'AGENT_RUNNING' | 'INSPECTING' | 'VERIFYING'
  | 'REVIEW_SLOT' | 'COMMITTING' | 'EVIDENCE' | 'PUBLICATION_GATE' | 'AWAITING_APPROVAL' | 'PUBLISHING'
  | 'REVIEW_HANDOFF' | 'ATTEMPT_ABANDONED' | 'PAUSED' | 'CANCELLING' | 'CLEANUP' | 'CLOSED';

export interface WorkflowStartReceipt {
  readonly workflowId: string;
  readonly alreadyStarted: boolean;
}
export interface WorkflowControlReceipt {
  readonly accepted: boolean;
  readonly reason?: 'already-paused' | 'not-paused' | 'closed' | 'unknown-approval'
    | 'decision-conflict' | 'approval-expired' | 'duplicate';
}
export interface TaskWorkflowView {
  readonly workflowId: string;
  readonly phase: TaskWorkflowPhase;
  readonly paused: boolean;
  readonly closed: boolean;
  readonly attemptNumber: number;
  readonly pendingApproval: {
    readonly approvalRequestId: string; readonly kind: ApprovalKind; readonly expiresAt: string;
  } | null;
  readonly spentUsd: number;
  readonly capUsd: number;
}

export interface WorkflowEngine {
  /** Idempotent by runId (workflow id asep-run-<runId>, conflict policy USE_EXISTING). */
  startRun(scope: TenantScope, input: RunWorkflowInput): Promise<WorkflowStartReceipt>;
  /** Idempotent by taskId (update id submit-<taskId>); starts the run workflow if needed. */
  submitTask(scope: TenantScope, input: {
    readonly runId: RunId; readonly task: TaskWorkflowInput; readonly requestId: string;
  }): Promise<WorkflowStartReceipt>;
  /** pause | resume | approval-decision; Update id = message.requestId. */
  control(scope: TenantScope, message: WorkflowControlMessage): Promise<WorkflowControlReceipt>;
  /** Durable cancellation of a task or run workflow; idempotent. */
  cancel(scope: TenantScope, input: {
    readonly target: { readonly scope: 'task' | 'run'; readonly id: string };
    readonly requestId: string; readonly principalId: string; readonly reason: string;
  }): Promise<WorkflowControlReceipt>;
  describeTask(scope: TenantScope, taskId: TaskId): Promise<TaskWorkflowView | null>;
  isClosed(scope: TenantScope, workflowId: string): Promise<boolean>;
}
```

### CR-10 — Review-loop slot (`packages/ports/src/index.ts`) + `AgentExecuteRequest.repairOrderRef`

```typescript
export type ReviewLoopTrigger = 'VERIFICATION_FAILED' | 'READY_FOR_REVIEW';

export interface ReviewLoopRequest {
  readonly slotVersion: 'review-loop/v1';
  /** `${attemptId}:${trigger}:${cycle}` — implementations MUST dedupe on it. */
  readonly idempotencyKey: string;
  readonly trigger: ReviewLoopTrigger;
  readonly risk: RiskLevel;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repositoryBindingId: RepositoryBindingId;
  /** Repair cycles already completed for this task (0 on the first review). */
  readonly cycle: number;
  readonly maxRepairCycles: number;
  readonly implementerProviderId: string;
  readonly workOrderRef: ArtifactRef;
  readonly contextPackRef: ArtifactRef;
  readonly diffRef: ArtifactRef;
  readonly verification: {
    readonly verdict: 'PASS' | 'FAIL' | 'ERROR';
    readonly evidenceArtifactIds: readonly ArtifactId[];
  };
  readonly baseSha: string;
  /** Present iff trigger === 'READY_FOR_REVIEW'. */
  readonly resultSha?: string;
  /** Present iff trigger === 'READY_FOR_REVIEW'. */
  readonly evidenceRef?: ArtifactRef;
  readonly priorReviewReportRefs: readonly ArtifactRef[];
  readonly budgetRemaining: { readonly costUsd: number; readonly wallClockMinutes: number };
}

export type ReviewLoopDecision =
  | { readonly kind: 'NOT_REQUIRED'; readonly reason: string }
  | { readonly kind: 'APPROVED'; readonly reviewReportRefs: readonly ArtifactRef[] }
  | { readonly kind: 'REPAIR_REQUIRED'; readonly repairOrderRef: ArtifactRef; readonly reviewReportRefs: readonly ArtifactRef[] }
  | { readonly kind: 'ESCALATE_TO_HUMAN'; readonly reason: string; readonly reviewReportRefs: readonly ArtifactRef[] }
  | { readonly kind: 'REJECTED'; readonly reason: string; readonly reviewReportRefs: readonly ArtifactRef[] };

export interface ReviewLoopPort {
  readonly slotVersion: 'review-loop/v1';
  evaluate(scope: TenantScope, request: ReviewLoopRequest, ctx: ActivityExecutionContext): Promise<ReviewLoopDecision>;
}

/** No implementation is available for a risk that requires automated review. Non-retryable. */
export class ReviewLoopUnavailableError extends Error {}

// AgentExecuteRequest gains ONE optional field (additive):
//   readonly repairOrderRef?: ArtifactRef;   // set only for attempt kind 'repair'
```

Plus `packages/ports/src/review-loop-contract.ts`: a framework-free conformance kit (`runReviewLoopContract(port,
fixtures)`) that both lanes execute in their own suites. Lane B owns the content of the review-report and
repair-order artifacts. Lane A only transports their refs.

### CR-11 — Migrations (`adapters/persistence/src/migrations.ts`)

`0100`–`0107` as listed in `phase-03-data-model.md` §2. Two need explicit coordination: the status `CHECK` (data
model §6) and `run_events` (Lane B consumes it and must not create its own).

### CR-12 — Fitness rules (`scripts/forbidden-imports.test.ts`)

Add the seven rules in `phase-03-architecture.md` §3, each with a seeded-violation self-check. Extend
`APPLICATION_PACKAGES` coverage to forbid `@temporalio/*`. Extend `ROOT_PACKAGES` with
`{ base: 'workers', names: ['temporal-worker'] }`. Add a production-entrypoint import-graph rule (exit B8) and a
rule that forbids `FaultInjector` in production entries (exit B9). Coordinate with Lane B, whose fitness
additions land in the same file.

### CR-13 — Required unit suites (`scripts/lib/canonical-tests.mjs` `REQUIRED_SUITES`)

```text
asep-suite:orchestration-core            packages/orchestration/src/decide.test.ts
asep-suite:orchestration-properties      packages/orchestration/src/invariants.test.ts
asep-suite:orchestration-activities      packages/application/src/orchestration-activities/activities.test.ts
asep-suite:review-loop-slot              packages/application/src/orchestration-activities/review-loop.test.ts
asep-suite:orchestration-persistence     adapters/persistence/src/orchestration/orchestration-persistence.test.ts
asep-suite:workspace-rehydration         adapters/git-worktree/src/rehydration.test.ts
asep-suite:temporal-bundle               adapters/temporal/src/worker/bundle.test.ts
asep-suite:temporal-replay               adapters/temporal/src/worker/replay.test.ts
asep-suite:temporal-activity-bridge      adapters/temporal/src/activity-bridge/bridge.test.ts
asep-suite:temporal-activity-options     adapters/temporal/src/workflows/activity-options.test.ts
asep-suite:workflow-payload-hygiene      adapters/temporal/src/payload-hygiene.test.ts
asep-suite:orchestration-api             apps/control-plane-api/src/orchestration/orchestration-routes.test.ts
```

### CR-14 — Integration gate (`scripts/integration/**`)

- `images.mjs`: add `temporal: 'temporalio/temporal@sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e'`.
- `run-integration.mjs`: provision, health-check (in-container `temporal operator namespace describe`), pass
  `ASEP_TEMPORAL_ADDRESS`/`ASEP_TEMPORAL_NAMESPACE`, honor `ASEP_ITEST_OMIT_BACKEND=temporal`, and always tear
  down in `finally`. The chaos suites need a container **volume** for the server-restart test, and the gate
  removes that volume in `finally`.
- `lib.mjs` `REQUIRED_ITEST_SUITES` additions:

```text
asep-suite:pg-orchestration              adapters/persistence/src/orchestration/orchestration.itest.ts
asep-suite:temporal-orphan-containers    adapters/command-runner/src/reaper.itest.ts
asep-suite:temporal-e2e                  workers/temporal-worker/src/e2e/task-workflow.itest.ts
asep-suite:temporal-controls             workers/temporal-worker/src/e2e/controls.itest.ts
asep-suite:temporal-budgets-approvals    workers/temporal-worker/src/e2e/budgets-approvals.itest.ts
asep-suite:temporal-review-slot          workers/temporal-worker/src/e2e/review-slot.itest.ts
asep-suite:temporal-chaos-kill           workers/temporal-worker/src/chaos/worker-kill.itest.ts
asep-suite:temporal-chaos-zombie         workers/temporal-worker/src/chaos/zombie.itest.ts
asep-suite:temporal-chaos-infra          workers/temporal-worker/src/chaos/infra-outage.itest.ts
asep-suite:temporal-chaos-duplicates     workers/temporal-worker/src/chaos/duplicate-delivery.itest.ts
asep-suite:temporal-api-e2e              apps/control-plane-api/src/orchestration/api-temporal.itest.ts
```

- `gate-fail-closed.itest.ts`: add the Temporal-omitted case (must exit non-zero).
- `run-integration.test.ts`: digest-pin and parity assertions for the Temporal image (compose ⇔ images.mjs).

### CR-15 — `compose.yaml` Temporal service

Replace `temporalio/auto-setup:1.31.0` (tag does not exist, research register §2) with the same digest-pinned
`temporalio/temporal` dev server the gate uses. `temporal-ui` gets pinned by digest (`temporalio/ui:2.54.1@sha256:ff0943fe…`).
The parity test in CR-14 covers it. Not on the hotspot list, but listed here because the gate's parity test reads it.

### CR-16 — Dependencies

```text
adapters/temporal/package.json   dependencies:    @temporalio/workflow 1.24.0, @temporalio/activity 1.24.0,
                                                  @temporalio/worker 1.24.0, @temporalio/client 1.24.0,
                                                  @temporalio/common 1.24.0
                                  devDependencies: @temporalio/testing 1.24.0
pnpm-lock.yaml                   regenerated; frozen install from a clean checkout must pass
root package.json                ONLY IF research Q4 shows a native build script is required:
                                  "pnpm": { "onlyBuiltDependencies": ["<that one package>"] }
```

No other new dependency. License gate expectations: research register §1.1 (`unionfs`).

### CR-17 — Composition roots and app wiring

- `apps/control-plane-api/src/production-root.ts`: add `productionWorkflowEngine(cfg)` that builds the Temporal
  client adapter (fail-closed config: address, namespace, TLS settings when present).
- `apps/control-plane-api/src/app.ts`: one registration line for `src/orchestration/routes.ts` (owned by Lane A).
- `server-main.ts`, `pilot-main.ts`, `cli.ts`, `cli-main.ts`: dispatch through the engine (G13).
- `auth.ts`: capability constants `executions:start`, `executions:control`, `approvals:read`, `approvals:decide`,
  `runs:govern`.

### CR-18 — Observability vocabulary (`packages/observability/src/spans.ts`, `audit.ts`)

Spans and audit actions in architecture §15. Closed-set additions only.

### CR-19 — Metrics dictionary (`docs/platform/metrics-dictionary.yaml`)

Add `duplicate_side_effect_incidents` = `count(incident.opened where failureClass = duplicate-side-effect)`,
SLO target 0 (`docs/operations/slo-and-alerting.md`: "duplicate irreversible side effect = 0"). Confirm
`workflow_recovery_rate` and `human_intervention_rate` source events are now emitted. Coordinate with Lane B's
dashboard metrics.

### CR-20 — Existing adapter modules Lane A must modify (not claimed; listed for reconciliation)

| File | Change |
|---|---|
| `adapters/persistence/src/side-effect-log.ts` (+ its test) | epochs + takeover (CR-05) |
| `adapters/persistence/src/lease-repository.ts` | adopt + `renew` (CR-06) |
| `adapters/persistence/src/repositories.ts` | attempt creation via ordinal; Phase 2 call sites unchanged in behavior |
| `adapters/persistence/src/index.ts` | one `export * from './orchestration/index.js'` line |
| `adapters/git-worktree/src/worktree-manager.ts` | registry-backed rehydration, create-or-adopt, HEAD CAS, host guard (CR-07) |
| `adapters/agent-claude/src/claude-provider.ts` | container name + labels (CR-08) |
| `adapters/command-runner/src/{sandbox.ts,command-runner.ts}` | container name + labels; new `reaper.ts` (CR-08) |
| `adapters/local-doubles/src/index.ts` | one export line for the new `durable-forge.ts` |

### CR-21 — Existing package modules Lane A must modify

| File | Change |
|---|---|
| `packages/application/src/pipeline-steps.ts` | thread `fencingEpoch` + `expectedHeadSha`; no behavior change for the Phase 2 driver |
| `packages/application/src/governed-execution.ts`, `vertical-slice-workflow.ts` | pass the new inputs (test drivers) |
| `packages/application/src/index.ts` | one `export * from './orchestration-activities/index.js'` line (Lane B is likely to add its own line, so the controller merges both) |
| `packages/domain/src/operational.ts` (+ test) | transitions for CR-01 |
| `packages/policy/src/index.ts` | one export line for a new `orchestration-policy.ts` loader of a new `policies/orchestration-policy.yaml` (defaults: lease TTL, heartbeat timings, approval TTL bounds, max pause, max repair cycles, budget defaults) |

### CR-22 — Root build and CI

- Root `tsconfig.json` `references`: add `packages/orchestration`, `adapters/temporal`, `workers/temporal-worker`.
  The Phase 2 project-references fitness (`scripts/project-references.test.ts`) enforces it.
- `.github/workflows/ci.yml`: no structural change expected (the integration job already runs
  `pnpm test:integration`). Possible `timeout-minutes` raise for the chaos suites, decided from measured runtime
  at S9 (PR3-23).
- `pnpm-workspace.yaml`: none (globs already cover the new packages).

### CR-23 — ADR number allocation

Lane A requests **ADR 0017** "Durable orchestration topology: pure workflow core, retry-safe activities, epoch
fencing" (written in S1). The controller assigns final numbers if Lane B also adds ADRs.

### CR-24 — Verification command catalog (`packages/ports/src/index.ts`)

Phase 2 builds verification commands in the composition root with a `checkCommand(workspacePath)` callback
(`packages/application/src/vertical-slice-workflow.ts:218,440`). A callback cannot cross the workflow boundary,
and a command string must not enter history (T3-05). So the workflow carries **check ids**, and a trusted,
config-sourced catalog resolves them inside the activity:

```typescript
export interface VerificationCommandCatalog {
  /** Resolve an approved command id for a binding to a trusted CommandSpec.
   *  Unknown id or binding → throws (non-retryable). Never accepts a command string. */
  resolve(scope: TenantScope, input: {
    readonly repositoryBindingId: RepositoryBindingId;
    readonly commandId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<CommandSpec>;
}
```

The production implementation reads an operator-approved, versioned catalog file named in the worker
configuration. The test implementation is a fixed in-memory map. Lane B may also need it if a reviewer runs
architecture or security checks.

---

## 31. Directory ownership (Lane A)

New directories and files Lane A owns exclusively. They must not overlap with Lane B.

```text
packages/orchestration/**
packages/application/src/orchestration-activities/**
adapters/temporal/**
adapters/persistence/src/orchestration/**
adapters/git-worktree/src/rehydration.test.ts
adapters/command-runner/src/reaper.ts
adapters/command-runner/src/reaper.itest.ts
adapters/local-doubles/src/durable-forge.ts
workers/temporal-worker/**
apps/control-plane-api/src/orchestration/**
packages/policy/src/orchestration-policy.ts
policies/orchestration-policy.yaml
docs/implementation/phases/phase-03-*
docs/architecture/adr/0017-*        (number subject to CR-23)
```

Everything else Lane A touches is an existing module and is listed in §30 (CR-01 … CR-22, CR-24) rather than claimed.

---

## 32. Assumptions and blocking questions

1. **Phase 2 is unaccepted.** The plan builds on Phase 2 behavior and port contracts as of `00a6889`. If cycle-6
   repairs change `SideEffectLog`, `pipeline-steps.ts` or the lease repository, the affected CRs (CR-05, CR-06,
   CR-20, CR-21) are rebased onto the repaired shapes at reconciliation. No Phase 2 line number is assumed stable.
2. **Docker on the implementation host** is required for the mandatory gate. It was observed present
   (server 29.6.1). If it is absent at implementation time, the gate goes red. It never skips.
3. **No live credentials** are needed for Phase 3 exit (Claude and GitHub stay doubles, with live opt-in as in
   Phase 2). This is not a blocker.
4. **Shared-surface reconciliation** (§30) blocks S1. Lane A cannot start implementing until the controller
   approves at least CR-01 … CR-10 and CR-24.

No genuine blocker for planning.

---

## Output

```text
PLAN_STATUS: DRAFT v1 (awaiting controller-run Codex plan review)
BASE_SHA: 00a6889 (Phase 2 head, unaccepted)
BASELINE: pnpm install --frozen-lockfile exit 0; pnpm verify:all exit 0 (548/548 canonical tests)
PLAN_FILES:
  - docs/implementation/phases/phase-03-plan.md
  - docs/implementation/phases/phase-03-architecture.md
  - docs/implementation/phases/phase-03-data-model.md
  - docs/implementation/phases/phase-03-exit-criteria.md
  - docs/implementation/phases/phase-03-risk-register.md
  - docs/implementation/phases/phase-03-research-register.md
  - docs/implementation/phases/phase-03-threat-model-delta.md
  - docs/implementation/phases/phase-03-review-log.md (skeleton)
NEW_DEPENDENCIES_PROPOSED (exact pins): @temporalio/{workflow,activity,worker,client,common} 1.24.0,
  @temporalio/testing 1.24.0 (dev)
NEW_BACKEND_IMAGE: temporalio/temporal:1.9.1@sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e
DEFERRED_WITH_REASON: fair scheduler; multi-host workers (single-host pool IN); Temporal PG persistence;
  worker versioning; tenant/project budgets; parallel tasks in a run
BLOCKERS: none for planning; S1 waits for shared-surface reconciliation
```
