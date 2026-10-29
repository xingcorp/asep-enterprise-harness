# Phase 3 — Risk Register (DRAFT, pending plan review)

> Delivery and design risks for durable orchestration. Base `00a6889`. Severity = impact × likelihood.
> "Trigger / check" names the test or review that detects the risk (exit-criteria IDs in
> `phase-03-exit-criteria.md`).

| ID | Risk | Sev | Mitigation | Trigger / check |
|----|------|-----|-----------|-----------------|
| PR3-01 | Non-deterministic workflow code: a replay diverges and in-flight workflows get stuck | HIGH | Pure `@asep/orchestration` core; workflow-module purity fitness; real bundler test; replay corpus in `pnpm test`; `patched()` for code changes; schema compat for payloads | B2–B5 red on a seeded violation |
| PR3-02 | Activity at-least-once delivery duplicates an external side effect | CRITICAL | Natural keys for every durable write (data model §5); Phase 2 two-phase side-effect log + epoch fencing; HEAD CAS; remote natural-key reconciliation; agent never engine-retried | E1–E11, F1–F15 |
| PR3-03 | Zombie worker (paused, not dead) performs an effect after Temporal has retried it elsewhere | HIGH | Epoch fencing with atomic takeover; fence + abort checks just before each external call; local CAS; remote calls idempotent by natural key; the forge call log is asserted | F7 (SIGSTOP/SIGCONT), E5, E11 |
| PR3-04 | A killed worker leaves agent or verification containers running, still mutating the worktree and spending budget (suspected, `claude-provider.ts:225-235`; not verified) | HIGH | Deterministic container names + labels; `ExecutionReaper` before any retry or replacement, on cancel and in the janitor; the empirical test records actual Docker behavior | E8, F2, F3, G6; `assertConvergence` counts containers |
| PR3-05 | In-memory adapter state is lost on worker restart, which makes recovery impossible (`worktree-manager.ts:60-71`) | HIGH | Durable `workspaces` registry; manager rehydrates; create-or-adopt keyed by attempt | E6, F1, F4 |
| PR3-06 | Lease semantics break under retries: heartbeat never extends expiry (`lease-repository.ts:83-89`), and the same attempt is denied its own lease (`:75-79`) | HIGH | `renew()` extends expiry and reports `LOST`; acquire adopts a same-attempt lease; TTL sized well above the heartbeat timeout | E2, E3, G3, F10 |
| PR3-07 | Side-effect fencing cannot hand off, which wedges after lease loss (Phase 2 test `side-effect-log.test.ts:255`) | HIGH | Epoch takeover (CR-05). The Phase 2 wedge test is replaced only with explicit controller approval (A7). | E5, F10; review-log entry |
| PR3-08 | PostgreSQL becomes a second orchestrator (activities branch on projected status) | HIGH | Architecture §1 rule; projection writer is write-only with seq + ownership; the tamper test proves the workflow ignores the projection | F13, D11, design review |
| PR3-09 | A green gate that does not exercise the MUSTs: in-process fakes, the time-skipping server, a runtime-downloaded dev server, or chaos tests that never really kill | CRITICAL | Real digest-pinned server; C4 forbids `TestWorkflowEnvironment` in itests; chaos uses real OS signals on real worker processes; `assertConvergence` has a negative self-test; required SUITE-ID markers; Temporal-absent negative test | C1–C6, F15 |
| PR3-10 | Supply chain: a new SDK with native code (`core-bridge`), webpack and swc in the worker; `unionfs` has no license field; possible pnpm build-script approval | MED | Exact pins at `1.24.0` (six weeks of bake); license inventory must pass with no allowlist widening; single-package override only with upstream evidence; single-package `onlyBuiltDependencies` only if required | A2, A6; research Q3/Q4 |
| PR3-11 | `compose.yaml` Temporal image tag does not exist (`compose.yaml:28`), so local infra cannot start | MED | Replace with the digest-pinned dev server; parity test with the gate | C3 |
| PR3-12 | The Temporal frontend is reachable by more than the control plane, allowing forged starts, signals or approvals | HIGH | Gate binds to localhost; only the API holds a client; approvals need PostgreSQL decision evidence re-verified by the workflow; mTLS/namespace auth recorded as a pre-production dependency (threat T3-01) | I3; threat-model review |
| PR3-13 | Secrets, source or prompts leak into workflow history | HIGH | Refs-only payloads under canonical schemas; check ids instead of command strings; payload hygiene scan of every committed history | B6 |
| PR3-14 | Workflow code changes break in-flight histories | MED | `patched()`; replay corpus; breaking payload change means a new workflow type | B5, runbook M1 |
| PR3-15 | Long-lived run workflow exceeds history limits | MED | continue-as-new on `continueAsNewSuggested` with carried dedup, queue and budget state | D7 |
| PR3-16 | The provider under-reports cost, bypassing budgets | MED | Reservation uses the attempt's `maxCostUsd`; the provider enforces its own cap; harness-measured wall-clock; overrun recorded. Residual: a provider that ignores `maxCostUsd` and under-reports is bounded only by wall-clock. | H1, H8; residual stated in the report |
| PR3-17 | Approval forgery, self-approval, replay, or a race with expiry | HIGH | Capability + human principal + requester ≠ approver; decision row unique per request; Update ID dedup + validator; workflow re-verifies the PostgreSQL row; workflow timer is authoritative for expiry | I2–I5, F11 |
| PR3-18 | Cancellation in the middle of a side effect strands `PENDING` records or half-published state | HIGH | Non-cancellable critical section from commit to PR; cleanup scope; PR left open and audited | G7 |
| PR3-19 | Shared-surface conflicts with Lane B: `TaskStatus` union and its single DB `CHECK`; `run-event` bump; `run_events` table; fitness file; `index.ts` export lines; ADR numbers | HIGH | Everything listed in plan §30 with explicit coordination notes; the controller owns a single status migration and merges the bumps | controller reconciliation before S1 |
| PR3-20 | Phase 2 is not accepted, and cycle-6 repairs may reshape the ports and steps this plan builds on | HIGH | No Phase 2 line number assumed stable; affected CRs flagged for rebase (plan §32); gates re-run after rebase | controller rebase + N4 |
| PR3-21 | Scope creep into a fair scheduler, multi-host workers, Kubernetes or dashboards | MED | Explicit deferral table with reasons (plan §4); host-id guard instead of multi-host support | Codex final review |
| PR3-22 | Chaos tests are flaky because kill timing is racy | MED | Crash points block deterministically and signal readiness before SIGKILL; bounded waits; convergence asserted on durable state, not timing (except the D9 bound) | flakiness tracked across controller runs |
| PR3-23 | The integration gate gets too slow with the chaos matrix on real containers | MED | Shortened TTLs, heartbeat timeouts and expiries in test configuration only (never in production defaults); suites share one backend set; CI `timeout-minutes` set from measured runtime | measured at S9 |
| PR3-24 | ESM and TypeScript 7 are incompatible with the Temporal bundler | MED | Bundle from compiled `dist/`; dedicated tsconfig fallback; never mock the bundler | B4; research Q5 |
| PR3-25 | Worker processes on different hosts would act on a missing worktree | MED | Single-host pool; `host_id` in the registry; `WorkspaceUnavailableError` → abandon pre-publication only | F14 |
| PR3-26 | The gate's Temporal server persists to SQLite, so the production PostgreSQL persistence topology is unexercised | MED | Stated as a pre-production dependency; no claim of production readiness for Temporal persistence | report wording (N1) |
| PR3-27 | A chaos `FaultInjector` leaks into production and weakens behavior | MED | Injected only by the chaos entry; it can block or exit and nothing else (only red results possible); fitness forbids it in production entries | B9 |
| PR3-28 | Docker restarts during chaos tests leave state behind between suites | LOW | Per-suite namespaces and IDs; the gate tears down containers and volumes in `finally`; `assertConvergence` scopes queries to the suite's tenant | A4, C6 |

## Blocking dependencies

- **Controller reconciliation of plan §30** blocks S1 and every later slice.
- **Phase 2 acceptance** gates the merge of Phase 3, not its implementation.

## Rollback

Per-slice commits on `phase/03-durable-orchestration`. Migrations are additive. Leaving `WorkflowEngine`
unconfigured disables execution (503) without falling back to the sequential driver (plan §28).
