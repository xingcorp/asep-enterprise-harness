# Phase 3 — Exit Criteria (DRAFT, machine-checkable)

> Phase 3 is COMPLETE only when every MUST below passes from a clean checkout of the phase branch, as run by
> the **controller** (lane contract step 5). Base `00a6889`.
> Each MUST names the executable test that proves it: `file` + SUITE-ID. Files marked *(new)* do not exist yet.
> They are created by the slice named in `phase-03-plan.md` §26. Unit suites run in `pnpm test`, and
> `*.itest.ts` suites run in `pnpm test:integration` against **real** Temporal, PostgreSQL, MinIO, Docker and
> Git. A MUST may not be satisfied by an in-process "Temporal-shaped" driver, by the SDK time-skipping test
> server, or by `TestWorkflowEnvironment.createLocal()` (research register §2). Claude and GitHub remain doubles,
> as in Phase 2. The forge double is durable and runs outside every worker process (`phase-03-plan.md` §21).
> Verdicts: **COMPLETE** (all MUSTs) or **INCOMPLETE** (any MUST unmet). Acceptance additionally depends on
> Phase 2 acceptance and the controller's rebase, so the gates are re-run after any rebase.

## A. Baseline and build integrity

- [ ] A1. `pnpm verify:all` exits 0 from a clean checkout (`scripts/verify-all.sh`).
- [ ] A2. `pnpm install --frozen-lockfile` is clean. Every new direct dependency is an exact pin with no `^`/`~`
      (manifest assertion in `scripts/project-references.test.ts` or a sibling manifest test *(new)*).
- [ ] A3. Compat gate passes for 16 schemas: 13 unchanged, 3 new at `1.0.0`. `run-event` is classified as a MINOR
      change and is at 1.2.0 (`packages/contracts/src/compat-gate.test.ts`, `asep-suite:compat-gate`).
- [ ] A4. The working tree is clean after `verify:all` and after `test:integration`. No `asep-itest-*`
      container or volume remains after the gate (`scripts/integration/run-integration.test.ts`,
      `asep-suite:integration-gate`).
- [ ] A5. Migrations `0100`+ apply forward on a clean PostgreSQL, re-apply as a no-op, run under the advisory
      lock with concurrent migrators, and an edited applied migration fails before later ones run. This extends
      the Phase 2 migration tests (`adapters/persistence/src/orchestration/orchestration.itest.ts` *(new)*,
      `asep-suite:pg-orchestration`).
- [ ] A6. The license inventory is green, including all Temporal transitive dependencies. The allowlist is
      unchanged, and any single-package override cites upstream evidence (`scripts/license-inventory.sh` via
      `check:publication`).
- [ ] A7. Every Phase 2 required suite (28 unit + 6 itest SUITE-IDs) is still present and green. No Phase 2 test is
      deleted or weakened, except the controller-approved replacement of the lease-handoff wedge test (CR-05),
      which is recorded in the review log (`scripts/run-canonical-tests.test.ts`, `asep-suite:canonical-runner`).

## B. Layering, determinism, single orchestrator

- [ ] B1. `@temporalio/*` is imported only under `adapters/temporal/**`. A seeded violation fails
      (`scripts/forbidden-imports.test.ts`, `asep-suite:forbidden-imports`).
- [ ] B2. `packages/orchestration/src/**` has only `import type` imports and none of the banned tokens (`Date`,
      `Math.random`, timers, `performance`, `process`, `crypto`, `require(`, `import(`). Seeded violations fail
      (same suite).
- [ ] B3. `adapters/temporal/src/workflows/**` imports only `@temporalio/workflow`, `@asep/orchestration` and
      relative workflow modules at runtime. A seeded violation fails (same suite).
- [ ] B4. A real `bundleWorkflowCode()` with **no** `ignoreModules` succeeds for the production workflows. A seeded
      workflow fixture importing `node:fs` makes the same test fail
      (`adapters/temporal/src/worker/bundle.test.ts` *(new)*, `asep-suite:temporal-bundle`).
- [ ] B5. Every committed history in `adapters/temporal/test-histories/` replays without
      `DeterminismViolationError`. A seeded non-deterministic fixture workflow fails replay
      (`adapters/temporal/src/worker/replay.test.ts` *(new)*, `asep-suite:temporal-replay`).
- [ ] B6. Every workflow input, Update/Signal payload and result fixture validates against the CR-02 schemas. Each
      payload stays under 64 KB. Every committed history passes the repo's secret and PII patterns and contains
      no command strings or source text (`adapters/temporal/src/payload-hygiene.test.ts` *(new)*,
      `asep-suite:workflow-payload-hygiene`).
- [ ] B7. `packages/application/**` imports no `@temporalio/*`. Activities depend only on
      `ActivityExecutionContext` (`asep-suite:forbidden-imports`).
- [ ] B8. No production entrypoint (`apps/control-plane-api/src/{server-main,pilot-main,cli-main}.ts`,
      `workers/temporal-worker/src/main.ts`) reaches `runVerticalSliceWorkflow`, `runVerticalSlice`,
      `governedExecution`, `completeToReview` or `executeTask` in its import graph. A seeded violation fails
      (`asep-suite:forbidden-imports`).
- [ ] B9. `FaultInjector` is unreachable from production entrypoints. A seeded violation fails
      (`asep-suite:forbidden-imports`).
- [ ] B10. The Phase 2 composition-root rules (`scripts/forbidden-imports.test.ts:261-333`) also apply to
      `workers/temporal-worker/src/**`, and the orchestration routes pass them.

## C. Mandatory integration gate

- [ ] C1. `pnpm test:integration` provisions `temporalio/temporal@sha256:ad4c82c9…` (digest-pinned) and waits for
      namespace readiness. With `ASEP_ITEST_OMIT_BACKEND=temporal` the gate exits **non-zero**
      (`scripts/integration/gate-fail-closed.itest.ts`, `asep-suite:gate-fail-closed`).
- [ ] C2. All CR-14 `REQUIRED_ITEST_SUITES` are enforced. A missing marker turns the gate red even on exit 0
      (`scripts/integration/run-integration.test.ts`, `asep-suite:integration-gate`).
- [ ] C3. `compose.yaml` and `scripts/integration/images.mjs` pin the same Temporal digest (parity test, same
      suite).
- [ ] C4. No `*.itest.ts` file imports `TestWorkflowEnvironment` or uses a time-skipping server. A seeded
      violation fails (`asep-suite:integration-gate`).
- [ ] C5. All CR-13 `REQUIRED_SUITES` are enforced by the canonical runner (`asep-suite:canonical-runner`).
- [ ] C6. The Temporal history volume used for the restart test is removed in `finally`, even when a suite fails
      (`asep-suite:integration-gate`).

## D. Workflows and activities

- [ ] D1. Contracts and ports from CR-01 … CR-10 compile. The Temporal adapter implements `WorkflowEngine` v2.
      Against the real server: start, submit, control, cancel, describe and isClosed behave as specified
      (`apps/control-plane-api/src/orchestration/api-temporal.itest.ts` *(new)*, `asep-suite:temporal-api-e2e`).
- [ ] D2. On real backends, a submitted R0 task reaches `WAITING_FOR_HUMAN_REVIEW` with one commit, one ref and
      one PR. Full traceability PR → evidence → attempt → task → run → project → repository is asserted on rows
      read back from PostgreSQL and the evidence object (`workers/temporal-worker/src/e2e/task-workflow.itest.ts`
      *(new)*, `asep-suite:temporal-e2e`).
- [ ] D3. Every activity option set declares `retry.maximumAttempts`, `startToCloseTimeout` and, for the activities
      marked in architecture §5, `heartbeatTimeout`. No activity uses defaults
      (`adapters/temporal/src/workflows/activity-options.test.ts` *(new)*, `asep-suite:temporal-activity-options`).
- [ ] D4. The non-retryable error mapping (architecture §5) is table-tested: each listed error name becomes
      `ApplicationFailure.nonRetryable` with that `type`, and every other error is retryable
      (`adapters/temporal/src/activity-bridge/bridge.test.ts` *(new)*, `asep-suite:temporal-activity-bridge`).
- [ ] D5. `runAgent` has engine `maximumAttempts: 1`. Agent failure or worker death leads to a **new attempt** only
      when no `push` side-effect record exists for the task, and to a terminal outcome otherwise
      (`packages/orchestration/src/decide.test.ts` *(new)*, `asep-suite:orchestration-core`; real proof F2).
- [ ] D6. Every activity, invoked twice with identical input (including after injected failures between its
      internal writes), converges to one durable outcome
      (`packages/application/src/orchestration-activities/activities.test.ts` *(new)*,
      `asep-suite:orchestration-activities`).
- [ ] D7. `runWorkflow` runs children sequentially, deduplicates `submitTask` by task ID across continue-as-new
      (forced in test), and carries queue, dedup set and budget totals across continue-as-new
      (`asep-suite:orchestration-core` + `asep-suite:temporal-e2e`).
- [ ] D8. Duplicate task start returns the existing workflow (`USE_EXISTING`). A task whose workflow completed
      cannot be started again (`REJECT_DUPLICATE` → API 409) (`asep-suite:temporal-api-e2e`).
- [ ] D9. Long activities heartbeat at least every 10 s (bridge test with `MockActivityEnvironment`). A killed
      worker is detected and the activity rescheduled within `heartbeatTimeout` + 30 s (timing assertion in
      F2) (`asep-suite:temporal-activity-bridge`, `asep-suite:temporal-chaos-kill`).
- [ ] D10. The janitor quarantines a workspace with an expired lease only when the owning workflow is closed. An
      expired lease of an **open** workflow is left untouched (`asep-suite:temporal-chaos-infra`).
- [ ] D11. Projection writes are idempotent (equal or older `seq` → no-op) and ownership-checked (a different
      `workflow_id` → `ProjectionOwnershipError`)
      (`adapters/persistence/src/orchestration/orchestration-persistence.test.ts` *(new)*,
      `asep-suite:orchestration-persistence`).

## E. Idempotency and fencing

- [ ] E1. `ensureAttempt` is idempotent on `(task_id, attempt_number)`. A concurrent race on two real `pg.Pool`
      connections yields one row. Conflicting identity raises a non-retryable error (`asep-suite:pg-orchestration`).
- [ ] E2. A lease held by the same attempt is adopted (`adopted: true`). Another attempt is denied. Both
      outcomes hold under a barrier race (`asep-suite:pg-orchestration`).
- [ ] E3. `renew` extends `expires_at`, and returns `LOST` with the right state once the lease is released,
      expired or quarantined (`asep-suite:orchestration-persistence`).
- [ ] E4. Concurrent `AttemptFence.claim` calls return strictly increasing, unique epochs
      (`asep-suite:pg-orchestration`).
- [ ] E5. Side-effect epochs: a lower-epoch `PENDING` row is taken over atomically and audited; a higher-epoch row
      fences out the caller; `COMPLETED` rows are adopted; `complete`/`fail` require an equal epoch. Unit and
      real-PG race (`asep-suite:orchestration-persistence`, `asep-suite:pg-orchestration`).
- [ ] E6. A **fresh process** can inspect, commit, reconcile, quarantine and clean up a workspace created by
      another process, using the registry alone. A `CREATING` record is promoted or quarantined according to
      the on-disk state (`adapters/git-worktree/src/rehydration.test.ts` *(new)*, `asep-suite:workspace-rehydration`).
- [ ] E7. `commit` refuses when HEAD ≠ `expectedHeadSha`, with a real Git repository (same suite).
- [ ] E8. Agent and verification containers carry the deterministic name and the four labels. `reap` removes all
      containers for an attempt and is idempotent. The suite records the observed behavior when the `docker`
      client is SIGKILLed, which resolves research Q6 (`adapters/command-runner/src/reaper.itest.ts` *(new)*,
      `asep-suite:temporal-orphan-containers`).
- [ ] E9. Duplicate inserts of an approval request, ledger entry or run event are no-ops
      (`asep-suite:orchestration-persistence`).
- [ ] E10. Evidence bytes are identical across retries of `persistEvidence` (workflow-supplied `createdAt`)
      (`asep-suite:orchestration-activities`; real proof F4/CX-09).
- [ ] E11. Each side-effect activity checks `ctx.signal` and `AttemptFence.assertCurrent` immediately before its
      external call. Spy ordering is asserted (`asep-suite:orchestration-activities`).

## F. Chaos and recovery on real backends

Each row runs real worker **processes** against the real gate backends and ends in `assertConvergence`
(architecture §8).

- [ ] F1. CX-01, CX-02, CX-03: pre-agent crash points (`workers/temporal-worker/src/chaos/worker-kill.itest.ts`
      *(new)*, `asep-suite:temporal-chaos-kill`).
- [ ] F2. CX-04: SIGKILL mid-agent. Container reaped, attempt replaced, one PR, `recoveryKind: attempt-replaced`,
      detection within the D9 bound (same suite).
- [ ] F3. CX-05: SIGKILL mid-verification (same suite).
- [ ] F4. CX-06 … CX-09: commit and evidence crash points, including object-written-metadata-missing (same suite).
- [ ] F5. CX-10 … CX-15: push and PR crash points. Exactly one ref and one PR; ≤ 1 successful PR create in the
      forge call log (same suite).
- [ ] F6. CX-16: crash between projection writes (same suite).
- [ ] F7. CX-17: zombie worker (SIGSTOP/SIGCONT). The zombie's `complete` is fenced out; one ref, one PR;
      `side-effect.takeover` audited (`workers/temporal-worker/src/chaos/zombie.itest.ts` *(new)*,
      `asep-suite:temporal-chaos-zombie`).
- [ ] F8. CX-18: Temporal server restart mid-agent and mid-publish
      (`workers/temporal-worker/src/chaos/infra-outage.itest.ts` *(new)*, `asep-suite:temporal-chaos-infra`).
- [ ] F9. CX-19 (PostgreSQL restart) and CX-20 (MinIO paused) (same suite).
- [ ] F10. CX-21: lease expiry during an outage longer than the TTL; re-acquire + epoch takeover (same suite).
- [ ] F11. CX-22 … CX-24: duplicate submissions, controls and approval decisions
      (`workers/temporal-worker/src/chaos/duplicate-delivery.itest.ts` *(new)*, `asep-suite:temporal-chaos-duplicates`).
- [ ] F12. CX-26 … CX-28: agent wall-clock overrun, malformed agent stream, forge rate limiting
      (`asep-suite:temporal-chaos-kill` / `asep-suite:temporal-chaos-infra`).
- [ ] F13. CX-29: a hand-edited `tasks.status` does not change workflow behavior, the projection is corrected at
      the next `seq`, and the drift is audited (`asep-suite:temporal-chaos-duplicates`).
- [ ] F14. CX-30: a workspace activity on a different host id fails `WorkspaceUnavailableError`, and the attempt is
      abandoned before publication (`asep-suite:temporal-chaos-infra`).
- [ ] F15. `assertConvergence` has a negative self-test. A seeded extra PR, extra ref, leftover container, leftover
      `ACTIVE` lease or `PENDING` side-effect record each make it fail (`asep-suite:temporal-chaos-duplicates`).

## G. Pause, resume, cancel (real Temporal)

All in `workers/temporal-worker/src/e2e/controls.itest.ts` *(new)*, `asep-suite:temporal-controls`, except G9.

- [ ] G1. Pause takes effect at the next phase boundary. An in-flight activity completes, the next phase does not
      start, the projection is `PAUSED`, and a duplicate pause is a no-op.
- [ ] G2. Resume continues from the recorded phase and converges to the same single commit, ref and PR.
- [ ] G3. The lease stays `ACTIVE` through a pause longer than the lease TTL (renewal timer).
- [ ] G4. Pause timeout → `BLOCKED`, with containers reaped, workspace quarantined and lease released.
- [ ] G5. Cancel before any side effect leaves no lease, workspace or container. Task `CANCELLED`.
- [ ] G6. Cancel during the agent: container reaped, workspace quarantined, no commit.
- [ ] G7. Cancel during the publication critical section: the section completes, no `PENDING` record remains, the
      PR stays open and is referenced in the audit row, task `CANCELLED`.
- [ ] G8. Run-level pause and cancel propagate to the active child, and no new child starts while paused.
- [ ] G9. Controls need `executions:control`: 401 unauthenticated, 403 without capability, 404 cross-tenant.
      Every accepted control is audited with the principal
      (`apps/control-plane-api/src/orchestration/orchestration-routes.test.ts` *(new)*, `asep-suite:orchestration-api`).

## H. Budgets

Core properties in `packages/orchestration/src/invariants.test.ts` *(new)* (`asep-suite:orchestration-properties`).
End-to-end checks in `workers/temporal-worker/src/e2e/budgets-approvals.itest.ts` *(new)*
(`asep-suite:temporal-budgets-approvals`).

- [ ] H1. Reservation: no attempt starts if its `maxCostUsd` could exceed the task or run cap plus granted
      extensions (property test over generated usage sequences + e2e).
- [ ] H2. Crossing the soft threshold emits `budget.threshold_crossed` (`soft`) and an audit row, and work
      continues.
- [ ] H3. A failed hard reservation opens a `budget-extension` approval. Approval continues the task, and the
      ledger gains a `human-granted` entry.
- [ ] H4. Reject or expiry → `BUDGET_EXHAUSTED`, with cleanup.
- [ ] H5. With the budget exhausted during the agent step, verification still runs every mandatory check of that
      attempt.
- [ ] H6. The run budget spans tasks: the second task's cap is the run remainder.
- [ ] H7. Ledger totals equal the workflow's totals at close (reconciliation assertion).
- [ ] H8. Provider-reported cost above the reservation records an `overrun` entry and exhausts the task budget.

## I. Approvals

- [ ] I1. An approval request is durable and idempotent. The projection shows `WAITING_FOR_APPROVAL`, and
      `approval.requested` is emitted (`asep-suite:temporal-budgets-approvals`).
- [ ] I2. Missing `approvals:decide` → 403. Agent or service principal → 403. `decided_by == requested_by` → 403.
      Cross-tenant → 404 (`asep-suite:orchestration-api`).
- [ ] I3. The decision row is inserted before the Update is delivered. An Update delivered straight to Temporal
      **without** a PostgreSQL decision row does not release the gate, and the attempt is audited
      (`asep-suite:temporal-budgets-approvals`).
- [ ] I4. An identical repeated decision returns the original receipt. A conflicting decision → 409, and the
      workflow validator rejects it without a history entry (`asep-suite:temporal-chaos-duplicates`, CX-24).
- [ ] I5. Expiry follows the kind's reject path and emits `approval.expired`. A late decision → 409 (CX-25,
      `asep-suite:temporal-budgets-approvals`).
- [ ] I6. Allowed decisions per kind are enforced. `review-adjudication` on `VERIFICATION_FAILED` cannot approve
      (`asep-suite:orchestration-core` + `asep-suite:temporal-review-slot`).
- [ ] I7. `publicationApprovalRequired` cannot change after run start. When true, no push happens before an
      approve decision (`asep-suite:temporal-budgets-approvals`).

## J. Review-loop slot

- [ ] J1. The slot is called after verification (`VERIFICATION_FAILED`) and after evidence (`READY_FOR_REVIEW`).
      The request matches CR-10: `idempotencyKey` format, and `resultSha`/`evidenceRef` present iff ready
      (`workers/temporal-worker/src/e2e/review-slot.itest.ts` *(new)*, `asep-suite:temporal-review-slot`).
- [ ] J2. `PolicyOnlyReviewLoop`: R0/R1 ready → `NOT_REQUIRED`; failed verification → `REJECTED`; any risk
      needing automated review → `ReviewLoopUnavailableError`. It passes the CR-10 contract kit
      (`packages/application/src/orchestration-activities/review-loop.test.ts` *(new)*, `asep-suite:review-loop-slot`).
- [ ] J3. Contract violations (`NOT_REQUIRED`/`APPROVED` on failed verification, a missing `repairOrderRef`, an
      unknown kind) fail closed and are audited (`asep-suite:orchestration-core`).
- [ ] J4. `REPAIR_REQUIRED` starts a `repair` attempt whose `AgentExecuteRequest.repairOrderRef` is set, and the
      cycle increments. At `maxRepairCycles` the gate escalates (`asep-suite:temporal-review-slot`).
- [ ] J5. `ESCALATE_TO_HUMAN` opens a `review-adjudication` approval (same suite).
- [ ] J6. A scripted `ReviewLoopPort` defined in a module that imports neither `@asep/orchestration`,
      `@asep/temporal` nor `@temporalio/*` drives the real workflow (proves Lane B can plug in without Lane A
      imports) (same suite).
- [ ] J7. In every generated path, the slot decision for an attempt precedes any publish command for it
      (`asep-suite:orchestration-properties`).

## K. API and entrypoints

- [ ] K1. Each route in `phase-03-plan.md` §10 validates, authorizes and maps every documented status code
      (`asep-suite:orchestration-api`).
- [ ] K2. Start and submit are idempotent (unit + CX-22).
- [ ] K3. The new handlers call application use cases only (Phase 2 B5 rule, `asep-suite:forbidden-imports`).
- [ ] K4. `GET /v1/tasks/:taskId/workflow` returns the Temporal query view. The Phase 2 projection `GET` is
      unchanged (`asep-suite:temporal-api-e2e`).
- [ ] K5. With no engine configured, the execution routes return 503 and never fall back (`asep-suite:orchestration-api`).
- [ ] K6. `pilot-main` and the CLI submit through `WorkflowEngine` (unit tests on the entrypoints + B8).

## L. Observability and audit

- [ ] L1. Each activity emits `orchestration.activity` with the Phase 2 correlation set plus `workflow_id`,
      `activity_attempt` and `fencing_epoch`. The Phase 2 boundary spans still fire (captured spans asserted in
      `asep-suite:temporal-e2e`).
- [ ] L2. Audit rows exist for every control, approval request/decision/expiry, takeover, quarantine and slot
      contract violation (asserted in the suites that trigger them).
- [ ] L3. `run_events` rows validate against `run-event` 1.2.0 before insert. Insert of an invalid event fails
      (`asep-suite:orchestration-persistence`).
- [ ] L4. Every F-group recovery emits `workflow.recovered` with the correct `recoveryKind`
      (asserted in each chaos suite).
- [ ] L5. The metrics-dictionary referential-integrity validator passes with the new metric and event types
      (`packages/observability/src/metrics.test.ts`).

## M. Operational readiness

- [ ] M1. `phase-03-runbook.md` covers starting, stopping and draining workers, stuck workflows, approval
      backlog, Temporal outage, replay failure (patch, or a new workflow type), the janitor, and rollback.
- [ ] M2. Rollback: without an engine the execution routes return 503 (K5). Migrations are additive, so Phase 2
      code runs on the migrated schema (the Phase 2 suites run against the migrated DB in
      `asep-suite:pg-orchestration`).
- [ ] M3. The chaos suites' logs from the controller-run gate are preserved under `artifacts/phase-03/`, with the
      exact commands to reproduce.

## N. Completion protocol

- [ ] N1. `phase-03-report.md` quotes the exact gate summary lines and log paths. Test counts are copied from logs.
- [ ] N2. Every claim about code cites `file:line`. Anything not run is written "not verified".
- [ ] N3. No unresolved CRITICAL/HIGH from the Codex final audit, or a recorded disposition.
- [ ] N4. The report names a real `implementation_head_sha` (`git rev-parse` output). The controller re-runs both
      gates on that SHA, and on any later SHA.

## Not Phase 3 exit (carried forward)

Fair multi-project scheduler; multi-host workers; Temporal PostgreSQL persistence; worker build-id versioning;
tenant/project/milestone budgets; parallel tasks within a run; review/repair/adjudication logic and dashboards
(Phase 4, Lane B); live Claude/GitHub pilot; Temporal mTLS/namespace authorization.
