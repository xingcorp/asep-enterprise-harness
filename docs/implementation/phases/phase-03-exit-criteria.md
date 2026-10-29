# Phase 3 — Exit Criteria (LOCKED v6, pending controller confirmation; machine-checkable)

> Phase 3 is COMPLETE only when every MUST below passes from a clean checkout of the phase branch, as run by
> the **controller** (lane contract step 5). Base `00a6889`; v1 at `80bb76a`, v2 at `98e92cf`, v3 at `7cbf5d3`. v2
> folded in the Codex plan review and reconciliation R1–R14; v3 folds in the Codex lock-check of v2 and
> reconciliation R15–R20 (`phase-03-review-log.md`, section "Lock-check v2"); v4 folds in the Codex review of v3
> and audit of S2 and reconciliation R21 (section "Review v3"); v5 folds in the Codex re-audit of v4 and the S2
> fixes and reconciliation R24 (section "Review v4"); v6 folds in the Codex re-audit of v5 and the S2 fixes and
> reconciliation R25–R28 (section "Review v5").
> Each MUST names the executable test that proves it: `file` + SUITE-ID. Files marked *(new)* do not exist yet.
> They are created by the slice named in `phase-03-plan.md` §26. Unit suites run in `pnpm test`, and
> `*.itest.ts` suites run in `pnpm test:integration` against **real** Temporal, PostgreSQL, MinIO, Docker and
> Git. A MUST may not be satisfied by an in-process "Temporal-shaped" driver, by the SDK time-skipping test
> server, or by `TestWorkflowEnvironment.createLocal()` (research register §2). Claude and GitHub remain doubles,
> as in Phase 2. The forge double is durable and runs outside every worker process (`phase-03-plan.md` §21).
> MUSTs that rest on the Phase 2 fencing primitive, typed result binding or agent runtime are evaluated only after
> Phase 2 is accepted and Lane A has rebased (plan §25). The gates are re-run after every rebase.
> Verdicts: **COMPLETE** (all MUSTs) or **INCOMPLETE** (any MUST unmet).

## A. Baseline and build integrity

- [ ] A1. `pnpm verify:all` exits 0 from a clean checkout (`scripts/verify-all.sh`).
- [ ] A2. `pnpm install --frozen-lockfile` is clean. Every new direct dependency is an exact pin with no `^`/`~`
      (manifest assertion in `scripts/project-references.test.ts` or a sibling manifest test *(new)*).
- [ ] A3. The compat gate passes. Lane A's three new schemas are at `1.0.0`. `run-event` is classified as a
      MINOR change and is at 1.2.0. The gate's schema count and `COMPATIBILITY.md` rise by exactly Lane A's
      three schemas; the cross-lane total is produced at merge and is not asserted here (R7)
      (`packages/contracts/src/compat-gate.test.ts`, `asep-suite:compat-gate`).
- [ ] A4. The working tree is clean after `verify:all` and after `test:integration`. No `asep-itest-*`
      container or volume remains after the gate (`scripts/integration/run-integration.test.ts`,
      `asep-suite:integration-gate`).
- [ ] A5. Migrations `0100`+ apply forward on a clean PostgreSQL, re-apply as a no-op, run under the advisory
      lock with concurrent migrators, and an edited applied migration fails before later ones run. The real
      upgrade path is exercised too: a database at the accepted Phase 2 head, then S0 (`0107` only), then S3
      (`0100`–`0102`, `0104`–`0106`, all lower than `0107`), ends with every migration applied exactly once and the
      registry in ascending order. This extends the Phase 2 migration tests (`adapters/persistence/src/orchestration/orchestration.itest.ts` *(new)*,
      `asep-suite:pg-orchestration`).
- [ ] A6. The license inventory is green, including all Temporal transitive dependencies. The allowlist is
      unchanged, and any single-package override cites upstream evidence (`scripts/license-inventory.sh` via
      `check:publication`).
- [ ] A7. Every Phase 2 required suite present at the rebased base is still present and green. Lane A deletes,
      weakens or rewrites no Phase 2 test. Changes to the lease-handoff test
      (`adapters/persistence/src/side-effect-log.test.ts:255`) come only from the Phase 2 repair
      (`scripts/run-canonical-tests.test.ts`, `asep-suite:canonical-runner`).

## O. Shared foundation (S0)

- [ ] O1. The review-loop slot contract from S0 compiles exactly as the verbatim block that Lane B locked
      (byte comparison recorded in the review log at paste time), at `packages/application/src/review-loop/`
      (R16). The framework-free conformance kit `review-loop-contract.ts` passes for Lane A's
      `NotConfiguredAssuranceSlot`, which S0 itself lands in its minimal form (S6 only binds it into the activity
      wrapper), for Lane B's `DisabledAssuranceSlot`, and for a scripted slot that returns each of the four
      outcomes
      (`packages/application/src/orchestration-activities/assurance-slot.test.ts` *(new)*,
      `asep-suite:assurance-slot-contract`).
- [ ] O2. `RunEventSink` conformance:
      - same `eventId` with identical canonical bytes → `{ appended: false }`;
      - same `eventId` with different bytes → `RunEventConflictError`;
      - an event invalid for its declared `run-event` version → rejected before insert;
      - an event whose `run_id` has no `runs` row in the tenant → rejected (measurement storage boundary, data
        model §3.7).

      Proven on PGlite (`adapters/persistence/src/run-events/run-event-sink.test.ts` *(new)*,
      `asep-suite:run-event-sink`) and on real PostgreSQL under a two-connection race
      (`adapters/persistence/src/run-events/run-event-sink.itest.ts` *(new)*, `asep-suite:pg-run-events`).
- [ ] O3. `0107_run_events` matches data model §3.7. The primary key is `(organization_id, project_id,
      event_id)`. The scoped run FK rejects a cross-tenant run. `UPDATE` and `DELETE` raise SQLSTATE `55000`
      (`asep-suite:pg-run-events`).
- [ ] O4. `run-event` 1.2.0 contains Lane A's fields and Lane B's locked SR-C5 fields. Fixtures of both lanes
      validate, and the compat gate classifies the change as MINOR (`asep-suite:compat-gate`).
- [ ] O5. Normalization boundary: after S0 renames the decision core's local slot types to the locked ones, a
      table test drives the core with each locked outcome and asserts the routing, including `REPAIR`'s
      `repairBaseSha`, repair order, `nextRound` and adjudication lineage reaching the next attempt and its
      assurance request, and the locked terminal names reaching `recordAttemptOutcome`
      (`packages/orchestration/src/decide.test.ts`, `asep-suite:orchestration-core`).

## B. Layering, determinism, single orchestrator

- [ ] B1. `@temporalio/*` is imported only under `adapters/temporal/**`. A seeded violation fails
      (`scripts/forbidden-imports.test.ts`, `asep-suite:forbidden-imports`, on the rule framework the accepted
      Phase 2 lands, R8).
- [ ] B2. The production source of `packages/orchestration` (`src/**/*.ts` except `*.test.ts` and
      `src/test-support/**`) has no external runtime dependency (only type imports from `@asep/contracts` and
      `@asep/ports`, plus relative imports between its own modules) and none of the banned constructs (`Date`,
      `Math` other than its listed pure members, timers, `performance`, `process`, `crypto`, `require`,
      `globalThis`, `eval`, `Function`, `Reflect`, `Proxy`, `fetch`, `Intl`, `Temporal`, dynamic `import()`, any
      `constructor`, `prototype` or `__proto__` member or an `Object` member that reaches a prototype without naming
      it (`getPrototypeOf`, `setPrototypeOf`, `getOwnPropertyDescriptor(s)`), also as a string anywhere, the
      locale-dependent members `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `toLocaleUpperCase`,
      `toLocaleLowerCase` and `localeCompare`, the host-dependent error members `stack`, `captureStackTrace`,
      `prepareStackTrace` and `stackTraceLimit`, `Symbol.for` and `Symbol.keyFor`, `import.meta`, any `declare`, a
      computed member access whose key type is not a finite union of literals or whose literal key is denied).
      Every identifier in a value position that the checker resolves outside its file (a lib or ambient
      declaration) or to nothing is on the allowlist of deterministic globals in architecture §3 (R27). Every
      relative import, re-export and import type resolves, through the compiler's module resolution, to a `.ts` file
      of the scanned production set; a specifier with a percent-encoded
      character, a query or a fragment, or without the `.js` extension, fails. Tests may use runtime imports. The
      check uses the TypeScript checker and is a defence layer, not a proof (architecture §3, R24). It asserts that
      every production file parsed. Seeded violations fail, including an alias of `Math`, computed access
      `Math["random"]`, a re-export with a comment, an escaped identifier, `export *` out of the package, imports of
      test support and of a test file, import-equals, an import type from another source, the `Function`
      constructor, and the re-audit's survivors (R24): the reflected constructor
      `Reflect.get(() => {}, "constructor")("return Date.now()")()` and its computed, member-access, destructuring,
      argument and prototype-descriptor equivalents, a hidden `.mjs` module, `./%74est-support/…` and
      `./decide.test.ts?cache`, and clock reads through `Intl` and `Temporal`; and the v5 re-audit's probes (R27):
      `(1234.5).toLocaleString()` and `navigator.hardwareConcurrency`, with a global outside the allowlist reached
      directly, through a shorthand property, a local re-export or a local `declare`; a clean-set control with valid
      constructs and the allowlisted globals stays green, and the scanned file set excludes tests and test support.
      The architecture states the detector's remaining limits. Two checkpoints
      (architecture §3):
      - S2: package-local self-check (`packages/orchestration/src/purity.test.ts`, `asep-suite:orchestration-purity`);
      - S7, after G-P2: the same rule in `scripts/forbidden-imports.test.ts` on the accepted Phase 2 framework
        (`asep-suite:forbidden-imports`); the package-local suite stays registered (append-only registry, R10).
- [ ] B3. `adapters/temporal/src/workflows/**` imports only `@temporalio/workflow`, `@asep/orchestration` and
      relative workflow modules at runtime. A seeded violation fails (same suite).
- [ ] B4. A real `bundleWorkflowCode()` with **no** `ignoreModules` succeeds for the production workflows. A seeded
      workflow fixture importing `node:fs` makes the same test fail
      (`adapters/temporal/src/worker/bundle.test.ts` *(new)*, `asep-suite:temporal-bundle`).
- [ ] B5. `adapters/temporal/test-histories/manifest.json` is non-empty. Every listed history exists and matches
      its `historySha256`, and no unlisted history exists. Every scenario in `required-scenarios.json` meets its
      minimum count. Every listed history replays without `DeterminismViolationError`. A seeded
      non-deterministic fixture workflow fails replay, and an empty manifest or a missing required scenario fails
      the suite (`adapters/temporal/src/worker/replay.test.ts` *(new)*, `asep-suite:temporal-replay`). Bootstrap
      (architecture §6.5): the suite becomes required in S8 with the scenarios S8 captures; S10 and S11 add theirs
      with their histories in the same commit; the final check (S13) asserts that `required-scenarios.json` equals
      the full list of architecture §6.5. No commit skips the suite or runs it on an empty manifest.
- [ ] B6. Every workflow input, Update/Signal payload and result fixture validates against the CR-02 schemas. Each
      payload stays under 64 KB. Every string field in those schemas carries a `pattern`, `enum` or `format`; an
      unconstrained string fails. Every committed history passes the repo's secret and PII patterns and contains
      no command strings, source text or free text (`adapters/temporal/src/payload-hygiene.test.ts` *(new)*,
      `asep-suite:workflow-payload-hygiene`).
- [ ] B7. `packages/application/**` imports no `@temporalio/*`. Activities depend only on
      `ActivityExecutionContext` (`asep-suite:forbidden-imports`).
- [ ] B8. No production entrypoint (`apps/control-plane-api/src/{server-main,pilot-main,cli-main}.ts`,
      `workers/temporal-worker/src/main.ts`) reaches `runVerticalSliceWorkflow`, `runVerticalSlice`,
      `governedExecution`, `completeToReview` or `executeTask` in its import graph. A seeded violation fails
      (`asep-suite:forbidden-imports`).
- [ ] B9. `FaultInjector` is unreachable from production entrypoints. A seeded violation fails
      (`asep-suite:forbidden-imports`).
- [ ] B10. The Phase 2 composition-root rules also apply to `workers/temporal-worker/src/**`, and the
      orchestration routes pass them (`asep-suite:forbidden-imports`).

## C. Mandatory integration gate and transport

- [ ] C1. `pnpm test:integration` provisions `temporalio/temporal@sha256:ad4c82c9…` (digest-pinned) and waits for
      namespace readiness. It prints the image's `temporal --version` line into the gate log, and the `docker pull`
      and `docker image inspect --format '{{json .RepoDigests}}'` output of every pinned Temporal image, so the
      controller's CI run carries the digest evidence that the review sandbox could not produce. With
      `ASEP_ITEST_OMIT_BACKEND=temporal` the gate exits **non-zero**
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
- [ ] C7. The gate publishes the Temporal frontend on host loopback only. `docker inspect` of the running server
      container shows `HostIp` `127.0.0.1` for port 7233 (`asep-suite:integration-gate`).
- [ ] C8. The Temporal client adapter and the worker factory refuse a plaintext connection to a non-loopback
      address and fail at startup. A loopback address passes, and so does a non-loopback address with TLS
      settings (`adapters/temporal/src/client/connection-guard.test.ts` *(new)*,
      `asep-suite:temporal-connection-guard`).
- [ ] C9. A production-shaped pre-deployment smoke exists and fails closed. It uses digest-pinned
      `temporalio/server:1.32.1` + `temporalio/admin-tools:1.32.1` with schema setup on the repo's digest-pinned
      PostgreSQL. It runs the D2 happy path, restarts the server container mid-workflow, and proves convergence.
      A missing image, a failed schema setup or a failed convergence exits non-zero
      (`workers/temporal-worker/src/smoke/prod-smoke.itest.ts` *(new)*, `asep-suite:temporal-prod-smoke`, run with
      `pnpm --filter @asep/temporal-worker smoke:prod`). It is not part of the per-commit gate. The controller
      runs it before any deployment (R14). It reads the production namespace retention back and fails on a
      mismatch.
- [ ] C10. The gate creates its namespace with `temporal operator namespace create --retention 24h` and reads it
      back with `temporal operator namespace describe` inside the server container; a different retention fails
      the gate (`asep-suite:integration-gate`).

## D. Workflows and activities

- [ ] D1. The ports from CR-04, CR-07, CR-08, CR-09, CR-10 (S0 block), CR-24 and CR-26 compile. The Temporal adapter
      implements `WorkflowEngine` v2. Against the real server: start, submit, control, cancel, describe and
      isClosed behave as specified (`apps/control-plane-api/src/orchestration/api-temporal.itest.ts` *(new)*,
      `asep-suite:temporal-api-e2e`).
- [ ] D2. On real backends, a submitted R0 task reaches `WAITING_FOR_HUMAN_REVIEW` with one commit, one ref and
      one PR. Full traceability PR → evidence → attempt → task → run → project → repository is asserted on rows
      read back from PostgreSQL and the evidence object (`workers/temporal-worker/src/e2e/task-workflow.itest.ts`
      *(new)*, `asep-suite:temporal-e2e`).
- [ ] D3. Every activity option set declares `retry.maximumAttempts`, `startToCloseTimeout` and, for the activities
      marked in architecture §5, `heartbeatTimeout`. No activity uses defaults
      (`adapters/temporal/src/workflows/activity-options.test.ts` *(new)*, `asep-suite:temporal-activity-options`).
- [ ] D4. The non-retryable error mapping (architecture §5) is table-tested: each listed error name becomes
      `ApplicationFailure.nonRetryable` with that `type`, and every other error is retryable. Separately, a push or
      PR-upsert failure carries its publication effect: a fencing error after the forge call, a timeout or any error
      after the call started maps to `unknown` whatever its retryability, `none` only to a failure proven to precede
      the call, and a failure without an effect reaches the core as `unknown` (R24)
      (`adapters/temporal/src/activity-bridge/bridge.test.ts` *(new)*, `asep-suite:temporal-activity-bridge`).
- [ ] D5. **Agent activity.** `runAgent` has engine `maximumAttempts: 1`. Agent failure or worker death is never
      redelivered to the same attempt. It leads to a **new attempt** only when no `push` side-effect record
      exists for the task, and to a terminal outcome otherwise
      (`packages/orchestration/src/decide.test.ts` *(new)*, `asep-suite:orchestration-core`; real proof F2).
- [ ] D6. Every activity, invoked twice with identical input (including after injected failures between its
      internal writes), converges to one durable outcome
      (`packages/application/src/orchestration-activities/activities.test.ts` *(new)*,
      `asep-suite:orchestration-activities`).
- [ ] D7. `runWorkflow` runs children sequentially, deduplicates `submitTask` by task ID across continue-as-new
      (forced in test), and carries queue, dedup set, budget totals and the sealed flag across continue-as-new
      (`asep-suite:orchestration-core` + `asep-suite:temporal-e2e`).
- [ ] D8. Duplicate task start returns the existing workflow (`USE_EXISTING`). A task whose workflow completed
      cannot be started again (`REJECT_DUPLICATE` → API 409) (`asep-suite:temporal-api-e2e`).
- [ ] D9. **Retryable activities.** Long activities heartbeat at least every 10 s (bridge test with
      `MockActivityEnvironment`). When a worker dies during a retryable activity such as `runVerification`, the
      **same** activity is redelivered (engine attempt 2) within `heartbeatTimeout` + 30 s, and its effects
      converge (timing assertion in F3) (`asep-suite:temporal-activity-bridge`, `asep-suite:temporal-chaos-kill`).
- [ ] D10. The janitor quarantines a workspace with an expired lease only when the owning workflow is closed. An
      expired lease of an **open** workflow is left untouched (`asep-suite:temporal-chaos-infra`).
- [ ] D11. Projection writes are idempotent (equal or older `seq` → no-op) and ownership-checked (a different
      `workflow_id` → `ProjectionOwnershipError`)
      (`adapters/persistence/src/orchestration/orchestration-persistence.test.ts` *(new)*,
      `asep-suite:orchestration-persistence`).
- [ ] D12. **Agent death detection.** When a worker dies during `runAgent`, the activity fails on heartbeat
      timeout within `heartbeatTimeout` + 30 s, and the replacement attempt starts after the old container is
      reaped (timing assertion in F2) (`asep-suite:temporal-chaos-kill`).
- [ ] D13. **Attempt registration (R21).** No usage or outcome is recorded for an attempt whose registration has not
      reconciled. `ensureAttempt` is non-cancellable. When it fails, `findAttempt` looks the attempt up by
      `(task_id, attempt_number)`: found → the attempt ends `failed` with zero usage (never leased, so `fence: null`,
      and S0 maps the terminal to `infrastructure-failed`, R28); absent → no attempt-bound
      effect; lookup failed → no attempt-bound effect and an audited `attempt.registration-unreconciled`. Each case
      ends the task `FAILED / attempt-registration-failed` with no replacement (core table in
      `asep-suite:orchestration-core`; the lookup activity in `asep-suite:orchestration-activities`).
- [ ] D14. **Never-replaceable classes are absolute (R21).** For each of `policy-violation`, `false-completion` and
      `duplicate-side-effect`, a hostile policy that lists it as replaceable still ends the task `FAILED` with that
      class after one attempt, with and without a cost overrun, and nothing is published (core table in
      `asep-suite:orchestration-core`). The core's policy rule reports each class (same suite), and the orchestration
      policy loader rejects a policy file that lists any of them
      (`packages/policy/src/orchestration-policy.test.ts` *(new, S6)*, `asep-suite:orchestration-policy-loader`).
- [ ] D15. **Run seal and drain (R21).** After `seal`, a submission of a new task is refused (`run-sealed`) and a
      second seal is refused (`already-sealed`). A sealed run completes `COMPLETED` once no task is open, whatever
      `maxTasks` says: a run below `maxTasks` closes after seal, also when the seal arrives while a child is running
      or while the run is paused with an empty queue. A run created sealed with `fixedTasks` runs exactly those tasks
      and closes. The sealed flag survives continue-as-new (core table in `asep-suite:orchestration-core`; real proof in
      `asep-suite:temporal-e2e`).

## E. Idempotency and fencing

The fencing MUSTs (E2–E5, E13) test the invariants of architecture §7.1 and §7.4 against the **accepted Phase 2
primitive** after the rebase. Lane A adds no parallel fencing mechanism.

- [ ] E1. `ensureAttempt` is idempotent on `(task_id, attempt_number)`. A concurrent race on two real `pg.Pool`
      connections yields one row. Conflicting identity raises a non-retryable error (`asep-suite:pg-orchestration`).
- [ ] E2. L2: after a crash that follows the lease insert, the same attempt's next delivery recovers its lease
      through the primitive and does not wedge. Another attempt is denied. Both outcomes hold under a barrier
      race on real PostgreSQL (`asep-suite:pg-orchestration`).
- [ ] E3. L1: renewal extends the lease expiry while the lease is `ACTIVE`, and reports it lost once it is
      released, expired, quarantined or superseded (`asep-suite:orchestration-persistence`,
      `asep-suite:pg-orchestration`).
- [ ] E4. F1: a claim succeeds only when, in the same transaction, the lease is `ACTIVE`, unexpired, held by the
      claimant and at the current lease epoch. The race tests run on two real `pg.Pool` connections:
      - a claimant holding an expired, released, quarantined or superseded lease is refused;
      - a barrier test supersedes the lease between the claimant's lease read and its claim, and the claim must
        fail. This proves the check runs in the same transaction.

      (`asep-suite:pg-orchestration`)
- [ ] E5. F2/F3: after a takeover, the old lease holder's `complete`, `fail` and `reopen` are all refused. The
      takeover is atomic and audited as `side-effect.takeover`. The new holder reconciles by natural key before
      any external call (spy ordering) (`asep-suite:pg-orchestration`, `asep-suite:orchestration-activities`).
- [ ] E6. A **fresh process** can inspect, commit, reconcile, quarantine and clean up a workspace created by
      another process, using the registry alone. A `CREATING` record is promoted or quarantined according to
      the on-disk state. A repair workspace is created at `repairBaseSha`, and a missing `repairBaseSha` object
      fails non-retryably (`adapters/git-worktree/src/rehydration.test.ts` *(new)*,
      `asep-suite:workspace-rehydration`).
- [ ] E7. `commit` refuses when HEAD ≠ `expectedHeadSha`, with a real Git repository; for a repair attempt
      `expectedHeadSha` is `repairBaseSha` (same suite).
- [ ] E8. Agent and verification containers carry the deterministic name and the four labels. `reap` removes all
      containers for an attempt and is idempotent. The suite records the observed behavior when the `docker`
      client is SIGKILLed, which resolves research Q6 (`adapters/command-runner/src/reaper.itest.ts` *(new)*,
      `asep-suite:temporal-orphan-containers`).
- [ ] E9. Duplicate inserts of an approval request, decision delivery row or ledger entry are no-ops
      (`asep-suite:orchestration-persistence`).
- [ ] E10. Hardening, not a blocker fix: evidence bytes are identical across retries of `persistEvidence`
      (workflow-supplied `createdAt`). Phase 2's orphan-adoption path (`adapters/persistence/src/evidence-store.ts:101-135`,
      pinned by `evidence-store.test.ts:189-212`) stays green as a regression check
      (`asep-suite:orchestration-activities`; real proof F4/CX-09).
- [ ] E11. Each side-effect activity checks `ctx.signal` and the F1 fence immediately before its external call.
      Spy ordering is asserted (`asep-suite:orchestration-activities`).
- [ ] E12. The **real** GitHub forge adapter converges on one PR per head branch against an honest HTTP double.
      The double implements GitHub's one-open-PR-per-head rule and returns `422` on a duplicate create. Two
      concurrent upserts for one head yield one PR and both return it. A create whose response is lost, followed
      by a retry, yields one PR. A `422` on create is reconciled by re-listing by head
      (`adapters/github-app/src/pr-upsert-concurrency.test.ts` *(new)*, `asep-suite:forge-pr-upsert-concurrency`).
      No live-GitHub claim is made beyond this evidence.
- [ ] E13. The `FAILED` lifecycle of architecture §7.1 is table-tested against the primitive:
      - every reopen reconciles by natural key first;
      - effect present → `COMPLETED` (adopted);
      - effect absent → `PENDING` under the new holder;
      - a terminal `FAILED` is never reopened;
      - an ambiguous transport outcome leaves the record `PENDING`.

      (`asep-suite:orchestration-activities`, `asep-suite:pg-orchestration`)
- [ ] E15. The workspace resolver port from the S0 block, implemented over the lease table, resolves a workspace
      only for the right tenant, an `ACTIVE` lease held by the given lease id, and the current fencing epoch. Wrong
      tenant, wrong lease and stale epoch each fail closed (`asep-suite:orchestration-persistence`,
      `asep-suite:pg-orchestration`).
- [ ] E14. `CommandRunner.run` honours a per-call `AbortSignal`. Aborting mid-command kills the process group and
      returns a cancelled result. The runner-level and per-call signals compose
      (`adapters/command-runner/src/per-call-abort.test.ts` *(new)*, `asep-suite:command-runner-abort`).

## F. Chaos and recovery on real backends

Each row runs real worker **processes** against the real gate backends and ends in `assertConvergence`
(architecture §8).

- [ ] F1. CX-01, CX-02, CX-03: pre-agent crash points (`workers/temporal-worker/src/chaos/worker-kill.itest.ts`
      *(new)*, `asep-suite:temporal-chaos-kill`).
- [ ] F2. CX-04: SIGKILL mid-agent. The agent activity fails on heartbeat timeout within the D12 bound and is not
      redelivered. The container is reaped and a replacement attempt runs. Exactly one PR; `recoveryKind:
      attempt-replaced` (same suite).
- [ ] F3. CX-05: SIGKILL mid-verification. The **same** verification activity is redelivered within the D9
      bound. Stale verify containers are reaped first, and one verdict is recorded (same suite).
- [ ] F4. CX-06 … CX-09: commit and evidence crash points, including object-written-metadata-missing (same suite).
- [ ] F5. CX-10 … CX-15: push and PR crash points. Exactly one ref and one PR; ≤ 1 successful PR create in the
      forge call log (same suite).
- [ ] F6. CX-16: crash between projection writes (same suite).
- [ ] F7. CX-17: zombie worker (SIGSTOP/SIGCONT). The zombie can neither complete nor fail its record (F2
      invariant); one ref, one PR; `side-effect.takeover` audited
      (`workers/temporal-worker/src/chaos/zombie.itest.ts` *(new)*, `asep-suite:temporal-chaos-zombie`).
- [ ] F8. CX-18: Temporal server restart mid-agent and mid-publish
      (`workers/temporal-worker/src/chaos/infra-outage.itest.ts` *(new)*, `asep-suite:temporal-chaos-infra`).
- [ ] F9. CX-19 (PostgreSQL restart) and CX-20 (MinIO paused) (same suite).
- [ ] F10. CX-21: lease expiry during an outage longer than the TTL; re-acquire and takeover under F1–F3 (same
      suite).
- [ ] F11. CX-22 … CX-24: duplicate operator HTTP requests: submissions, controls and approval decisions
      replayed with the same and different `Idempotency-Key`
      (`workers/temporal-worker/src/chaos/duplicate-delivery.itest.ts` *(new)*, `asep-suite:temporal-chaos-duplicates`).
- [ ] F12. CX-26 … CX-28: agent cap overrun, malformed agent stream, forge rate limiting
      (`asep-suite:temporal-chaos-kill` / `asep-suite:temporal-chaos-infra`).
- [ ] F13. CX-29: a hand-edited `tasks.status` does not change workflow behavior, the projection is corrected at
      the next `seq`, and the drift is audited (`asep-suite:temporal-chaos-duplicates`).
- [ ] F14. CX-30: a workspace activity on a different host id fails `WorkspaceUnavailableError`, and the attempt is
      abandoned before publication (`asep-suite:temporal-chaos-infra`).
- [ ] F15. `assertConvergence` has a negative self-test. Each of these seeded faults makes it fail: an extra PR,
      an extra ref, a leftover container, a leftover `ACTIVE` lease, a `PENDING` side-effect record, a second
      activity completion event, a second `attempt.completed`, and an undelivered decision row
      (`asep-suite:temporal-chaos-duplicates`).
- [ ] F16. CX-35: **duplicate activity completion callbacks.** The test re-sends a completion for a recorded task
      token through `AsyncCompletionClient`, once after the genuine completion and once after a retry has
      superseded the delivery. The SDK-specific injector lives in `adapters/temporal/src/test-support/`; the worker
      chaos suite calls a helper whose signature exposes no SDK type, so B1 holds without a test exception. The server rejects both. History holds exactly one completion per scheduled
      activity, and convergence holds (`asep-suite:temporal-chaos-duplicates`).
- [ ] F17. CX-36: **duplicate message delivery at the gRPC boundary.** The same `UpdateWorkflowExecution` request
      (same update id) and the same Signal are each sent twice by a test-only client wrapper. Exactly one
      effect each (`asep-suite:temporal-chaos-duplicates`).
- [ ] F18. CX-31 … CX-33: the `FAILED` crash cases for push and PR:
      - external success, then a recorded `fail`;
      - a crash right after `FAILED` is written;
      - a retry after an ambiguous timeout with the effect applied.

      Each converges to exactly one ref and one PR (`asep-suite:temporal-chaos-kill`).
- [ ] F19. CX-34: the API process is SIGKILLed after the decision transaction commits and before the Update is
      sent. After restart, the delivery relay delivers the decision exactly once. The workflow continues
      exactly once, with one decision row, one effect and a `DELIVERED` delivery row
      (`apps/control-plane-api/src/orchestration/decision-relay.itest.ts` *(new)*,
      `asep-suite:approval-delivery-recovery`).

## G. Pause, resume, cancel (real Temporal)

All in `workers/temporal-worker/src/e2e/controls.itest.ts` *(new)*, `asep-suite:temporal-controls`, except G9.

- [ ] G1. Pause takes effect at the next phase boundary. An in-flight activity completes, the next phase does not
      start, the projection is `PAUSED`, and a duplicate pause is a no-op.
- [ ] G2. Resume continues from the recorded phase and converges to the same single commit, ref and PR.
- [ ] G3. The lease stays `ACTIVE` through a pause longer than the lease TTL (renewal timer).
- [ ] G4. Pause timeout → `BLOCKED`, with containers reaped, workspace quarantined,
      `recordAttemptOutcome('cancelled')` recorded and then the lease released.
- [ ] G5. Cancel before any side effect leaves no lease, workspace or container. Task `CANCELLED`.
- [ ] G6. Cancel during the agent: container reaped, workspace quarantined, no commit.
- [ ] G7. Critical units (architecture §9): a cancel inside commit plus evidence binding is processed after that
      unit reconciles, with nothing pushed; a cancel after push has started completes push and PR upsert, no
      `PENDING` record remains, the PR stays open and is referenced in the audit row; task `CANCELLED` in both. When
      the PR upsert fails after its retry policy, G13 applies instead.
- [ ] G8. Run-level pause and cancel propagate to the active child, and no new child starts while paused.
- [ ] G9. Controls need `executions:control` held by an authenticated principal: 401 unauthenticated, 403 without
      capability, 404 cross-tenant. The workflow audits every accepted control with the principal id, and a
      rejected control writes no accepted-control audit row
      (`apps/control-plane-api/src/orchestration/orchestration-routes.test.ts` *(new)*, `asep-suite:orchestration-api`).
- [ ] G11. Cancel during the assurance round: the activity receives the cancellation, nothing is pushed, the
      workspace is quarantined, `recordAttemptOutcome('cancelled')` recorded, then the lease released, task `CANCELLED`
      (core table in `asep-suite:orchestration-core`; real proof here).
- [ ] G12. Cancel during the publication-approval wait: the task ends at once, the open request is closed with
      `cancelApprovalRequest` (a later decision gets 409), nothing is pushed, task `CANCELLED` (core table in
      `asep-suite:orchestration-core`; real proof here).
- [ ] G10. Cancel during verification: the cancellation reaches the runner's per-call signal, the verification
      process group is gone, no `asep-verify-<attemptId>-*` container remains, no verification process is
      running, no commit exists and the task is `CANCELLED`.
- [ ] G13. **Incomplete publication (R21, R24).** A cancel never finalizes while a publication unit is
      unreconciled, and the publication effect, never retryability, decides what is reconciled: an activity failure
      carries no retryability into the core at all. For push and PR upsert, each with and without a cancel pending:
      - a cancel during a successful push, then a PR upsert that fails with effect `none`, ends the task
        `FAILED / publication-incomplete`, never `CANCELLED`, with an audit row `publication.incomplete` naming the
        remote branch and `pushConfirmed: true`;
      - a push failure with effect `unknown` (for example a fencing error after the forge call) runs
        `reconcilePublication`: the identity predicate holds → the PR upsert runs, and with a cancel pending the
        task ends `CANCELLED` with the PR left open and audited; the branch absent with no PR → `FAILED /
        publication-failed` (`CANCELLED` with a cancel pending: nothing was pushed); the branch at another commit,
        a PR at another head, head SHA or base, or a failing read → `FAILED / publication-incomplete`;
      - a push failure with effect `none` runs no PR upsert and ends `FAILED / publication-failed` (`CANCELLED`
        with a cancel pending); a push failure with effect `applied` continues as a completed push;
      - a PR-upsert failure with effect `unknown` or `applied` runs `reconcilePublication`: the identity predicate
        holds with a PR → the task continues as after a successful upsert with that PR; no PR, the branch moved or
        missing, a PR at another head, head SHA or base, or a failing read → `FAILED / publication-incomplete`,
        whatever cancel is pending (the reviewer's `PR_WRONG_HEAD_PROBE` and generator seed 1351 are tests).

      The identity predicate (R27, architecture §4.1) is the same on both paths: the branch tip equals the
      attempt's verified commit, and a reported PR has that branch as head, that commit as head SHA and the task
      input's `baseBranch` as base; the reconciliation result carries the observed values and the core decides.
      The property oracle accepts a task that ends without a PR after a push request only when the push failed
      with effect `none`, or the reconciliation found the branch absent with no PR; otherwise the task ends
      `FAILED / publication-incomplete` with the branch audited, and no terminal state follows an `unknown` effect
      before its reconciliation. On every publication it checks identity: a PR number the task reports comes from
      an upsert after an applied push, or from a reconciliation result that satisfies the predicate, and every
      reconciliation result is followed by the decision the predicate gives.

      Core table in `asep-suite:orchestration-core`; real proof here with a forge double that fails the PR create.
- [ ] G14. **Pause while waiting for approval (R21).** For both approval kinds: a pause in the wait applies at once
      (projection `PAUSED`, pause timer started); resume projects `WAITING_FOR_APPROVAL` again; the approval expiry
      timer is not suspended, and expiry while paused takes the kind's reject path; a pause timeout while waiting
      ends the task `BLOCKED` and closes the request with `cancelApprovalRequest` (core table in
      `asep-suite:orchestration-core`; real proof here).

## H. Budgets

Core properties in `packages/orchestration/src/invariants.test.ts` *(new)* (`asep-suite:orchestration-properties`).
End-to-end checks in `workers/temporal-worker/src/e2e/budgets-approvals.itest.ts` *(new)*
(`asep-suite:temporal-budgets-approvals`).

- [ ] H1. Reservation: no attempt starts unless its `maxCostUsd` plus the verification reserve fits the task cap
      plus granted extensions and the run remainder, and its wall-clock plus the verification reserve fits the task
      wall-clock (property test over generated usage sequences + e2e).
- [ ] H2. Crossing the soft threshold emits `budget.threshold_crossed` (`soft`) and an audit row, and work
      continues.
- [ ] H3. A task-cap reservation failure opens a `budget-extension` approval when `maxBudgetExtensionUsd` is set.
      Approval continues the task with the same attempt plan, and the ledger gains a `human-granted` entry. When
      it is unset, or the cause is the run remainder, wall-clock or a recorded overrun, the task ends
      `BUDGET_EXHAUSTED` with no approval (architecture §10 "Reservation failure").
- [ ] H4. Reject or expiry → `BUDGET_EXHAUSTED`, with cleanup.
- [ ] H5. Verification has its own reservation: an agent that finishes `AGENT_DONE` having spent exactly its cap
      still gets every mandatory check, the commit, the assurance round and publication.
- [ ] H6. The run budget spans tasks: the second task's cap is the run remainder.
- [ ] H7. Ledger totals equal the workflow's totals at close (reconciliation assertion).
- [ ] H8. Usage above a cap (reported cost, reported tool calls, or harness-measured wall-clock beyond the cap plus
      the kill grace, H11), or a usage value outside its representable bound (H12), records an `overrun` entry and
      an audited incident; the
      attempt is inspected but never verified, committed or published, ends `budget-exhausted`, and the recorded
      overrun ends the task `BUDGET_EXHAUSTED` at the next reservation while attempts remain (with none left the
      task ends `FAILED / attempts-exhausted`, R20). If the agent also failed with a failure class that is not
      replaceable, that failure wins: the attempt is not inspected, ends `failed`, and the task ends `FAILED` with
      that class, while the overrun is still recorded and audited (R20).
- [ ] H9. The agent adapter (rebased Phase 2 adapter + CR-25) enforces each request cap. A fake stream that
      exceeds `maxTurns`, `maxToolCalls`, `maxCostUsd` or `maxWallClockMinutes` is killed as soon as the cap is
      crossed and reports `BUDGET_EXHAUSTED`. `--max-turns` comes from the request. A cap the adapter cannot
      observe raises `AgentBudgetCapUnsupportedError` before the container starts
      (`adapters/agent-claude/src/budget-caps.test.ts` *(new)*, `asep-suite:agent-budget-caps`; real proof CX-26).
- [ ] H10. Agent outcome table (architecture §10), core table plus e2e: a cap-triggered `BUDGET_EXHAUSTED` is
      inspected only (no verification, commit or publication), the attempt ends `budget-exhausted`, and a new
      `retry` attempt (same lineage) starts only if `maxAttempts` and a fresh reservation allow; otherwise the
      reservation-failure table decides. A cap stop that reports a non-replaceable failure class ends the task
      `FAILED` with that class, and an inspection that fails on an exhausted attempt is a normal abandon (`failed`,
      retried only for a replaceable class) (R20). Paired with H9, which proves the adapter reports the status
      (`asep-suite:orchestration-core`, `asep-suite:temporal-budgets-approvals`).
- [ ] H11. **Wall-clock overrun (R21).** With a kill grace `g` (`policy.agentKillGraceSeconds`): `AGENT_DONE` with a
      measured wall-clock equal to the cap, and equal to the cap plus `g`, gets the full path; one millisecond above
      the cap plus `g` is an overrun: inspected only, `recordOverrun` with the wall-clock excess over the cap, an
      audited incident, nothing verified, committed or published. With the code default `g = 0` one millisecond
      above the cap is an overrun. The property test checks that no attempt measured above the cap plus `g` is
      verified or published (`asep-suite:orchestration-core`, `asep-suite:orchestration-properties`; real proof in
      `asep-suite:temporal-budgets-approvals`). After the rebase onto the accepted Phase 2, `g` is re-derived from
      the accepted stop path (container stop timeout plus the bound on forced removal), and the tests bind to the
      adapter's exported constant, not a copied literal (R24).
- [ ] H12. **Budget precision (R21).** Budget arithmetic is in integer micro-USD and usage converts with ceiling:
      a reported `5.0000004` on a cap of `5` is an overrun of `0.000001`, `1.1` on `1.1` is none, and a sub-micro
      usage is charged one micro-dollar. Overrun detection is independent of ledger saturation (R24): with every
      money cap equal to `100 000 000` USD and a zero reserve, a reported cost one micro-USD above the cap is an
      overrun (inspected only; nothing verified, committed or published), usage equal to that cap is not, and a cost
      above the bound, or a negative, non-numeric or non-finite cost, tool-call count or wall-clock, is an overrun
      recorded with `usageOutOfBound`; the property generator produces caps at and next to the bound. The input
      rule rejects a money amount that is not exactly representable in
      micro-USD, negative, non-finite or above `100 000 000` USD, and the decision validator refuses such an
      extension amount (core in `asep-suite:orchestration-core`; property oracle independent of the implementation's
      conversion in `asep-suite:orchestration-properties`). The S7 input mapping rejects such an input before a
      workflow starts (`adapters/temporal/src/workflows/input-mapping.test.ts` *(new, S7)*,
      `asep-suite:temporal-input-mapping`).

## I. Approvals

- [ ] I1. An approval request is durable and idempotent. The projection shows `WAITING_FOR_APPROVAL`, and
      `approval.requested` is emitted (`asep-suite:temporal-budgets-approvals`).
- [ ] I2. These requests are refused (`asep-suite:orchestration-api`):
      - missing `approvals:decide` → 403;
      - an agent or service principal → 403;
      - `decided_by == requested_by` → 403;
      - cross-tenant → 404.
- [ ] I3. The decision row and its delivery row commit in one transaction before the Update is sent. An Update
      delivered straight to Temporal **without** a PostgreSQL decision row does not release the gate, and the
      attempt is audited. An identical retry of the POST re-delivers the Update idempotently
      (`asep-suite:temporal-budgets-approvals`; crash proof F19).
- [ ] I4. An identical repeated decision returns the original receipt. A conflicting decision → 409, and the
      workflow validator rejects it without a history entry (`asep-suite:temporal-chaos-duplicates`, CX-24).
- [ ] I5. Expiry follows the kind's reject path and emits `approval.expired`. A late decision → 409 (CX-25,
      `asep-suite:temporal-budgets-approvals`).
- [ ] I6. Only `budget-extension` and `publish-change` exist, each with its allowed decision set. No approval kind
      is reachable after a verification stop (`asep-suite:orchestration-core`).
- [ ] I7. `publicationApprovalRequired` cannot change after run start. When true, no push happens before an
      approve decision (`asep-suite:temporal-budgets-approvals`).
- [ ] I8. **The approval message carries the amount (R21, P3-PLAN3-MED-002).** `workflow-control/v1`
      `approval-decision` carries `extensionUsd`. The S7 mapping turns a budget-extension approve with a valid amount
      into the core's decision message with the same amount, and it reaches `verifyApprovalDecision`; a missing,
      zero, inexact or out-of-bound amount, or an amount on any other decision, is refused before any state change
      (`adapters/temporal/src/workflows/input-mapping.test.ts` *(new, S7)*, `asep-suite:temporal-input-mapping`).
- [ ] I9. **Approval races (R21).** For both kinds: an expiry timer that fires while a decision is being verified
      wins over a verified approve (the request expires, the kind's reject path runs, nothing is released); a
      verification result with `verified: false` and a valid approve and amount keeps the gate closed. The property
      generator delivers timers while requests are pending and `verified: false` with decisions whose content is
      valid for the kind (`publish-change` with a null amount, `budget-extension` with a valid amount), and its
      coverage marker checks that validity per kind (R24); a
      step-aligned oracle checks that every release (an extension recorded, a publish-change push issued or withheld
      for a pause) comes from a verified approve that arrived before its request's expiry fired. Dropping the
      expiry-wins branch or the `verified` check each turns a test red (`asep-suite:orchestration-core`,
      `asep-suite:orchestration-properties`).

## J. Review-loop slot (Phase 4 semantics, R3)

Real-Temporal proofs in `workers/temporal-worker/src/e2e/assurance-slot.itest.ts` *(new)*,
`asep-suite:temporal-assurance-slot`, driven by a scripted slot unless stated.

- [ ] J1. Exactly one assurance round runs per attempt that passes verification, after `persistEvidence` and
      before the publication gate. No round runs after a verification stop. The request carries every field of
      the S0 block, including `model`, `declaredComplete`, `priorAdjudicationId` (null iff round 1), the
      idempotency key and the claim identity. Every money field at the seam is integer micro-USD (`*MicroUsd`, a
      non-negative safe integer or `null`), filled from the core's integer amounts without passing through floating
      USD; a reported usage field that is not one is a contract violation (R28).
- [ ] J2. `NotConfiguredAssuranceSlot` gives `PROCEED`/`not-required` for R0 and R1 and fails closed
      (`AssuranceUnavailableError`) for any risk that requires review. It is distinct from Lane B's
      `DisabledAssuranceSlot`, the explicit opt-out (R18). It passes the S0 conformance kit
      (`asep-suite:assurance-slot-contract`). Terminal names follow the locked block at hand-off.
- [ ] J3. Outcome mapping:
      - `PROCEED` → publish → PR carrying the section → `WAITING_FOR_HUMAN_REVIEW`;
      - `ESCALATE` → publish → PR flagged "assurance not satisfied" → `WAITING_FOR_HUMAN_REVIEW`;
      - `REPAIR` → repair attempt (J4);
      - `BLOCK` → no push, task `BLOCKED`;
      - an out-of-contract outcome → audited `review-slot.contract-violation`, task `FAILED`.

      Core table in `asep-suite:orchestration-core`; each path on real Temporal.
- [ ] J4. `REPAIR` starts a `repair` attempt with these properties:
      - its workspace is at `repairBaseSha`;
      - its ContextPack is `buildRepairContextPack(original, repairOrder)`, stored and referenced;
      - `round = nextRound` and `priorAdjudicationId = adjudicationId`;
      - its evidence `baseSha` is `repairBaseSha`, and the next round's `taskBaseSha` is the task base.

      Capacity (R17, R19): with `maxAttempts` exhausted the task ends `FAILED` (`repair-capacity-exhausted`)
      whatever the budget says. With attempts left but a failed reservation, a task-cap shortfall opens a
      `budget-extension` approval while `maxBudgetExtensionUsd` is set (approve → the repair attempt starts with the
      same lineage; reject or expiry → `BUDGET_EXHAUSTED`); any other budget cause, or `maxBudgetExtensionUsd`
      unset, ends the task `BUDGET_EXHAUSTED`. Nothing is published in any of these cases. A `retry` that replaces a failed repair
      attempt keeps the lineage: same `repairBaseSha`, repair order, round and prior adjudication, and its
      assurance round continues them (trace `REPAIR` → agent death → replacement → assurance, core table + e2e).
- [ ] J5. `recordAttemptOutcome` is called exactly once per registered attempt at every terminal in architecture
      §12, and never for an attempt whose registration did not reconcile (D13). This holds across engine retries:
      one `attempt.completed` per registered attempt (property test in `asep-suite:orchestration-properties` + e2e).
      **Terminal before lease (R27, R28).** On every path where the attempt holds a lease (repair, abandon,
      exhaustion, verification stop, `BLOCK`, review handoff, cancel, pause timeout and any other close),
      `recordAttemptOutcome` precedes `releaseLease`: a per-attempt ordering oracle in the property test, a direct
      core test per path, and the reviewer's mutation (a release inserted before the `REPAIR` outcome) red. The
      outcome write presents the caller's fence; an attempt that never held a lease records `fence: null` and only
      `cancelled` or `infrastructure-failed` (architecture §4.1; the slot side is Lane B's conformance kit).
- [ ] J6. A scripted slot defined in a module that imports neither `@asep/orchestration`, `@asep/temporal` nor
      `@temporalio/*` drives the real workflow. This proves Lane B can plug in without Lane A imports.
- [ ] J7. In every generated path, the assurance outcome for an attempt precedes any publish command for it, and
      no publish command follows `REPAIR` or `BLOCK` for that attempt (`asep-suite:orchestration-properties`).
- [ ] J8. The admission hook: without it, admission results are byte-identical to `admitRisk` for every risk
      level (Phase 2 admission suite unchanged). With it, the injected function decides, and a `DEFERRED` result
      blocks before any side effect (`asep-suite:orchestration-activities`).
- [ ] J10. An assurance-activity failure (retries exhausted, or a non-retryable error) is audited as
      `assurance-unavailable` and never ends the task `FAILED`: in shadow mode the attempt continues as `PROCEED`
      (the PR states that assurance was unavailable), in gating mode as `ESCALATE` (R19) (core table in
      `asep-suite:orchestration-core`; real proof in `asep-suite:temporal-assurance-slot`).
- [ ] J9. The context adapter maps `signal` and `heartbeat`. `now()` returns the same value on every redelivery of
      one activity execution, and a redelivered round produces byte-identical run events
      (`asep-suite:orchestration-activities`).

## K. API and entrypoints

- [ ] K1. Each route in `phase-03-plan.md` §10 validates, authorizes and maps every documented status code
      (`asep-suite:orchestration-api`).
- [ ] K2. Start and submit are idempotent (unit + CX-22).
- [ ] K3. The new handlers call application use cases only (Phase 2 B5 rule, `asep-suite:forbidden-imports`).
- [ ] K4. `GET /v1/tasks/:taskId/workflow` returns the Temporal query view. The Phase 2 projection `GET` is
      unchanged (`asep-suite:temporal-api-e2e`).
- [ ] K5. With no engine configured, the execution routes return 503 and never fall back (`asep-suite:orchestration-api`).
- [ ] K6. `pilot-main` and the CLI submit through `WorkflowEngine` (unit tests on the entrypoints + B8).
- [ ] K7. The principal resolver returns a principal id, class (`human`/`service`/`agent`) and capabilities from
      server state only. A token with no principal → 401. The class can never come from the request
      (`asep-suite:orchestration-api`).

## L. Observability and audit

- [ ] L1. Each activity emits `orchestration.activity` with the Phase 2 correlation set plus `workflow_id`,
      `activity_attempt` and the fencing identity. The Phase 2 boundary spans still fire (captured spans asserted
      in `asep-suite:temporal-e2e`).
- [ ] L2. Audit rows exist for every accepted control, approval request/decision/delivery/expiry, takeover,
      quarantine and slot contract violation (asserted in the suites that trigger them).
- [ ] L3. `run_events` rows are written only through `RunEventSink` and validate against `run-event` 1.2.0
      before insert (`asep-suite:run-event-sink`).
- [ ] L4. Every F-group recovery emits `workflow.recovered` with the correct `recoveryKind`
      (asserted in each chaos suite).
- [ ] L5. The metrics-dictionary referential-integrity validator passes with the new metric and event types
      (`packages/observability/src/metrics.test.ts`).

## M. Operational readiness

- [ ] M1. `phase-03-runbook.md` covers:
      - starting, stopping and draining workers, with drain-only in this order: stop new executions, seal every
        open run, keep the old workers until no open workflow remains, then stop them and start the new build
        (architecture §6.6); seal does not resume a paused task, and drain reports each sealed run held open by a
        paused task as a blocking item for an operator to resume or cancel, never resuming it itself (R24);
      - the two deployment procedures of architecture §6.6 (drain-only, or patched with the replay corpus)
        and the command that lists open workflows on the task queue;
      - stuck workflows and the approval backlog, including undelivered decision rows;
      - a Temporal outage and a replay failure;
      - the janitor, namespace retention, the pre-deployment smoke (C9) and rollback.
- [ ] M2. Rollback: without an engine the execution routes return 503 (K5). Migrations are additive, so Phase 2
      code runs on the migrated schema (the Phase 2 suites run against the migrated DB in
      `asep-suite:pg-orchestration`).
- [ ] M3. The chaos suites' logs from the controller-run gate are preserved under `artifacts/phase-03/`, with the
      exact commands to reproduce. They include the image digests, the full `docker pull` and `docker image
      inspect` output of every pinned image (C1), and the `temporal --version` line.

## N. Completion protocol

- [ ] N1. `phase-03-report.md` quotes the exact gate summary lines and log paths. Test counts are copied from logs.
- [ ] N2. Every claim about code cites `file:line`. Anything not run is written "not verified".
- [ ] N3. **Zero** unresolved CRITICAL/HIGH findings from the Codex final audit. A CRITICAL/HIGH counts as
      resolved only when it is one of these:
      - `fixed`, with the fixing commit and the test that proves it;
      - `not-applicable`, with `file:line` or command evidence;
      - a user-accepted risk, recorded with the user's explicit decision.

      A disposition alone does not resolve a finding.
- [ ] N4. The report names a real `implementation_head_sha` (`git rev-parse` output). The controller re-runs both
      gates on that SHA, and on any later SHA.
- [ ] N5. The report claims production readiness of the Temporal deployment only if the C9 smoke passed on the
      reported SHA. Otherwise it states "production-shaped Temporal persistence not verified".

## Not Phase 3 exit (carried forward)

Fair multi-project scheduler; multi-host workers; worker build-id / deployment versioning (drain-only or patched
deploys instead, M1); tenant/project/milestone budgets; parallel tasks within a run; review, repair and
adjudication logic and dashboards (Phase 4, Lane B; Phase 4's reviewer runs in shadow mode); live Claude/GitHub
pilot; Temporal mTLS/namespace authorization; a payload codec (not needed while payloads stay classified,
architecture §16).
