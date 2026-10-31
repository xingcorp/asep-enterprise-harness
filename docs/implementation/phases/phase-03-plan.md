# Phase 3 — Durable Orchestration — Plan (LOCKED v8, pending controller confirmation)

> Status: **LOCKED v8 (pending controller confirmation)**. Lane A wrote v1 (`80bb76a`) in workflow step 1. The
> controller ran the independent Codex plan review (`phase-03-plan-review-codex-v1.md`, REQUEST_CHANGES 0.98).
> In step 3 Lane A adjudicated every finding in `phase-03-review-log.md` and folded each accepted one into the
> design, the exit criteria and the slice that proves it (v2, `98e92cf`). The controller then ran an independent
> Codex lock-check of v2 (`phase-03-plan-review-codex-v2.md`, REQUEST_CHANGES 0.97). v3 (`7cbf5d3`) adjudicates every
> new finding and every v1 finding it marked PARTIAL (review log, section "Lock-check v2") and folds them in the same
> way. The controller then ran an independent Codex review of v3 and audit of S2 (`phase-03-review-codex-v3.md`,
> REQUEST_CHANGES 0.98). v4 adjudicates its 15 findings (review log, section "Review v3") and folds them in. The
> controller then ran an independent Codex re-audit of v4 and of the S2 fixes at `7694b8b`
> (`phase-03-review-codex-v4.md`, REQUEST_CHANGES 0.98). v5 adjudicates its seven new findings and the three v3
> findings it marked PARTIAL (review log, section "Review v4") and folds them in. The controller then ran an
> independent Codex re-audit of v5 and of the S2 fixes at `ac04c8c` (`phase-03-review-codex-v5.md`,
> REQUEST_CHANGES 0.98). v6 adjudicates its seven new findings and the v4 finding it marked PARTIAL (review log,
> section "Review v5") and folds them in. The controller then ran an independent Codex re-audit of v6 and of the S2
> fixes at `392f259` (`phase-03-review-codex-v6.md`, REQUEST_CHANGES 0.97). v7 adjudicates its seven new findings and
> the v5 finding it marked PARTIAL (review log, section "Review v6") and folds them in, with R29 (the answers to
> Lane A's open pre-lease questions) and R31. The controller then ran an independent Codex re-audit of v7 and of the
> S2 fixes at `ac0a1bc` (`phase-03-review-codex-v7.md`, REQUEST_CHANGES 0.96). v8 adjudicates its eight new findings
> and the v6 finding it marked PARTIAL (review log, section "Review v7") and folds them in, with Phase 2's
> publication contract of cycle 9 (R30, Phase 2 head `a447983`, still under controller verification), R32 and R33.
> The controller then answered Lane A's turn-10 questions (R34) and ran an independent Codex re-audit of v8 and of the
> S2 fixes at `bed7a13` (`phase-03-review-codex-v8.md`, ACCEPT_WITH_CHANGES 0.95); its five LOWs are adjudicated in the
> review log (section "Review v8") and fixed without a version bump, because none changes the design.
> The controller's shared-surface reconciliation v1 (R1–R21, R24, the Lane A parts of R25–R28, R29, R30–R34, the
> Lane A part of R37, R38, R39, R43, R47–R52) is applied, and it wins wherever it disagrees with this plan.
> **Rebase (R51, R52).** Phase 2 was accepted at `8e71ed7`, and G-P2 released at its acceptance record `d6ee686`.
> Lane A rebased this branch onto `d6ee686`. §1.4 maps Phase 2 as accepted against this plan and amends the lines it
> names. S0, the shared foundation, is the first slice commit after it; the review log records it (section "S0").
> **S2 acceptance (R37):** the pure decision core S2 is accepted once the five LOWs of re-audit v8 are fixed and the
> controller has checked them; there is no further Codex round on S2 unless those fixes touch decision logic beyond
> them.
> The review-loop slot TypeScript (CR-10) is pasted verbatim from the block the controller handed over (R39, sha256
> `9cc21c98…71a`) and lands in S0.
> Only S2 is implemented before the Phase 2 rebase (R15): `a133e32`, then follow-up commits that bring it in
> line with v3 (`5e9fb84`), with R20 (`5b0afde`), with v4 and R21, with v5 and R24, with v6 and R27, with v7,
> R29 and R31, and with v8 and R33 (the commits after each docs commit).
> Scope source: `docs/implementation/90-day-plan.md:24-31` (Days 31–45).

```text
BASE_SHA:        d6ee686  (Phase 2 acceptance record, head of phase/02-single-agent-vertical-slice; Phase 2
                 accepted at 8e71ed7, R51, R52; the branch forked from 00a6889 and was rebased onto d6ee686)
PLAN_V1_SHA:     80bb76a  (reviewed by Codex)
PLAN_V2_SHA:     98e92cf  (lock-checked by Codex)
PLAN_V3_SHA:     7cbf5d3  (reviewed by Codex at 5e9fb84, together with the S2 code)
TARGET_BRANCH:   phase/03-durable-orchestration (Lane A worktree)
BASELINE_GATE:   pnpm install --frozen-lockfile → exit 0; pnpm verify:all → exit 0 (observed 2026-10-29 at
                 00a6889, in workflow step 1; §2)
IMPLEMENTATION:  starts only after the controller says "implement". Phase 2 is accepted (R51); main is not moved
                 (merge and push are user decisions), so Lane A rebases onto the Phase 2 branch head, and S0 is the
                 first slice commit after the rebase (§25). Only S2 started earlier.
```

Companion documents: `phase-03-architecture.md`, `phase-03-data-model.md`, `phase-03-exit-criteria.md`,
`phase-03-risk-register.md`, `phase-03-research-register.md`, `phase-03-threat-model-delta.md`,
`phase-03-review-log.md`, `phase-03-plan-review-codex-v1.md`, `phase-03-plan-review-codex-v2.md`,
`phase-03-review-codex-v3.md`, `phase-03-review-codex-v4.md`, `phase-03-review-codex-v5.md`,
`phase-03-review-codex-v6.md`, `phase-03-review-codex-v7.md`, `phase-03-review-codex-v8.md`.

---

## 0. Execution model (lane contract + reconciliation ordering)

| Step | Who | Output |
|---|---|---|
| 1 | Lane A | phase-03 docs, one docs commit (`80bb76a`) |
| 2 | Controller | Codex read-only plan review → `phase-03-plan-review-codex-v1.md` |
| 3 | Lane A | every finding adjudicated → `phase-03-review-log.md`; reconciliation applied; plan LOCKED v2 (`98e92cf`) |
| 3a | Controller | Codex read-only lock-check of v2 → `phase-03-plan-review-codex-v2.md` |
| 3b | Lane A | lock-check adjudicated and folded; R15–R19 applied; plan LOCKED v3; S2 brought in line |
| 3c | Controller | Codex read-only review of v3 and audit of S2 at `5e9fb84` → `phase-03-review-codex-v3.md` |
| 3d | Lane A | review v3 adjudicated and folded; R21 applied; plan LOCKED v4; S2 fixed, test first |
| 3e | Controller | Codex read-only re-audit of v4 and the S2 fixes at `7694b8b` → `phase-03-review-codex-v4.md` |
| 3f | Lane A | re-audit adjudicated and folded; R24 applied; plan LOCKED v5; S2 fixed, test first |
| 3g | Controller | Codex read-only re-audit of v5 and the S2 fixes at `ac04c8c` → `phase-03-review-codex-v5.md` |
| 3h | Lane A | re-audit v5 adjudicated and folded; R27 and the R28 slot rules applied; plan LOCKED v6; S2 fixed, test first |
| 3i | Controller | Codex read-only re-audit of v6 and the S2 fixes at `392f259` → `phase-03-review-codex-v6.md` |
| 3j | Lane A | re-audit v6 adjudicated and folded; R29 and R31 applied; plan LOCKED v7; S2 fixed, test first |
| 3k | Controller | Codex read-only re-audit of v7 and the S2 fixes at `ac0a1bc` → `phase-03-review-codex-v7.md` |
| 3l | Lane A | re-audit v7 adjudicated and folded; R30's publication contract, R32 and R33 applied; plan LOCKED v8; S2 fixed, test first |
| 3m | Controller | Codex read-only re-audit of v8 and the S2 fixes at `bed7a13` → `phase-03-review-codex-v8.md` (ACCEPT_WITH_CHANGES) |
| 3n | Lane A | the five LOWs of re-audit v8 adjudicated and fixed (R34, R37); plan stays LOCKED v8; S2 accepted once the controller has checked the fixes (R37) |
| 3o | Controller | S2 accepted at `75bf4b3` (R38); G-LB released, slot block `9cc21c98…` (R39); Phase 2 accepted at `8e71ed7` and G-P2 released at `d6ee686` (R51, R52) |
| 3p | Lane A (this step) | rebase onto `d6ee686`; Phase 2 delta mapped against the plan (§1.4); S0; then the controller's check and an independent review |
| 4 | Lane A, after "implement" | one slice per commit (§26), on this branch only, in the §25 order; S2 first (`a133e32`), as R15 allows |
| 5 | Controller | independent gate run + Codex final audit; Lane A repairs |
| 6 | Controller | merge on ACCEPT, in the order Phase 2 → Phase 3 → Phase 4 (R-ordering 4) |

Ordering fixed by the reconciliation:

1. Phase 2 lands first. Lane R repaired Phase 2 in full (cycles 7–16). The controller accepted it at `8e71ed7` (R51)
   and released G-P2 at its acceptance record `d6ee686` (R52). `main` is not moved, so Lane A rebased onto the Phase 2
   branch head `d6ee686`, which carries what `main` would (R51).
2. **S0 "shared foundation"** is Lane A's first commit after the rebase. It lands every `[S0]` item of the
   reconciliation exactly as specified there (§26). Lane B rebases onto S0 before any Lane B slice that touches
   a shared surface.
3. Slices that depend on Phase 2 fencing, result binding or agent runtime wait for Phase 2 acceptance and the
   rebase (P3-PLAN-MED-008). In v2 numbering those are S3, S4, S5, S6 and everything after them.

Lane A does not edit any shared surface before the controller says "implement".

---

## 1. Current-state audit (file-level evidence, read at `00a6889`)

### 1.1 What Phase 2 gives Phase 3 (reused, not rebuilt)

| Asset | Evidence |
|---|---|
| Framework-free step use cases: admission, agent, inspect, verify, commit, evidence, push, PR upsert, set-review | `packages/application/src/execute-task.ts:70,94,124`; `pipeline-steps.ts:181,342,475,609,692,786` |
| Admission runs first and refuses R2–R4 before any side effect | `governed-execution.ts:169-178`; `risk-admission.ts:82-135` |
| Two-phase side-effect log with fingerprint + fencing + remote reconciliation for commit/push/PR | `pipeline-steps.ts:342-420,609-659,692-771`; `adapters/persistence/src/side-effect-log.ts:82-205` |
| Preallocated evidence id + identity-checked adoption, including orphan adoption after a crash between object write and metadata insert | `pipeline-steps.ts:475-573`; `adapters/persistence/src/evidence-store.ts:101-135`; `evidence-store.test.ts:189-212` |
| Injectable observability seam for privileged boundaries | `pipeline-steps.ts:870-877` |
| Mandatory, fail-closed real-backend integration gate pattern | `scripts/integration/run-integration.mjs:96-211`; `scripts/integration/lib.mjs:31-62` |
| Required-suite markers for the unit gate | `scripts/lib/canonical-tests.mjs:91-211` |
| Forbidden-import fitness incl. composition-root rules | `scripts/forbidden-imports.test.ts:34-46,69-76,261-333` |
| `WorkflowEngine` seam reserved for Phase 3 (unused) | `packages/ports/src/index.ts:79-86` |

### 1.2 Defects and gaps that block durable recovery

| # | Finding (observed) | Evidence | Consequence under Temporal | Fix (v2 owner, slice) |
|---|---|---|---|---|
| G1 | Workspace state lives only in process memory: paths, baseline refs, base SHA | `adapters/git-worktree/src/worktree-manager.ts:60-71`; `pathOf()` throws for unknown ids `:142-147`; `cleanup()` is a no-op for unknown ids `:290-292` | After a worker restart no workspace can be inspected, committed, reconciled or cleaned. Recovery is impossible and worktrees are orphaned. | durable `workspaces` registry + rehydration (Lane A, S3, S4) |
| G2 | Two unrelated workspace ids: the manager mints one (`worktree-manager.ts:108`), the lease row mints another (`lease-repository.ts:43`) | same | The janitor cannot map an expired lease to its worktree | registry links lease ↔ workspace (Lane A, S3) |
| G3 | Lease `heartbeat` updates `heartbeat_at` only, never `expires_at` | `lease-repository.ts:83-89` | A long agent run outlives its TTL, and the next acquire sweeps the live lease to `EXPIRED` | invariant L1 of the Phase 2 primitive (R1); Lane A proves it after the rebase (S3) or files a change request against the primitive |
| G4 | Lease `acquire` denies a second acquire **by the same attempt** | `lease-repository.ts:75-79` | An engine retry after "insert committed, worker died" can never get its own lease back (wedge) | invariant L2 of the Phase 2 primitive (R1); proven in S3 |
| G5 | A re-leased executor can never complete a crashed executor's `PENDING` side effect. This is pinned by a Phase 2 test. | `side-effect-log.ts:174-181`; `side-effect-log.test.ts:255` | Wedge after lease loss; also the zombie-worker hazard | **Phase 2 HIGH-006 (Lane R)**: lease-bound fenced takeover; Lane A states invariants F1–F5 (architecture §7.1) and proves them after the rebase (S3, S6, S10) |
| G6 | Attempt rows are created with a fresh ULID per call, with no natural key | `vertical-slice-workflow.ts:291-293`; Phase 2 schema `migrations.ts:100-124` | An engine retry of "create attempt" inserts duplicate attempts | `(task_id, attempt_number)` natural key (Lane A, S3) |
| G7 | End-of-run persistence uses version-CAS updates | `vertical-slice-workflow.ts:525-551` | An engine retry raises `OptimisticConcurrencyError` after a partial write | monotonic projection writer, set-once facts (Lane A, S3, S6) |
| G8 | ~~Evidence `createdAt` wedge~~ **stale at `00a6889`** (P3-PLAN-MED-002) | orphan adoption exists and is pinned: `evidence-store.ts:101-135`, `evidence-store.test.ts:189-212` | none; v1 cited the cycle-5 review (`phase-02-final-rereview-codex-v5.md:31`), which predates the fix | not a blocker. A workflow-supplied `createdAt` stays as hardening (E10) |
| G9 | The evidence id is allocated in the driver, outside any step | `pipeline-steps.ts:916` | Non-deterministic in workflow code | allocation moves inside the `commitAttempt` activity; adoption already exists (`:350-398`) (S6) |
| G10 | Agent and verification containers have no deterministic name or label. The Claude adapter SIGKILLs the `docker` **client** on timeout or abort, and the runner kills the client's process group. | `claude-provider.ts:183-190,225-235`; `sandbox.ts:94`; `command-runner.ts:86-104`; no `--name`/`--label` under `adapters/` or `apps/` (`git grep`) | Suspected, **not verified**: the container may keep running after the client dies, mutating a worktree and spending budget | deterministic names + labels + `ExecutionReaper` on the rebased adapters (S4); verified by itest (research Q6) |
| G11 | `WorkflowEngine` port is untyped (`signal: unknown`) and unused | `packages/ports/src/index.ts:79-86` | Not usable as a contract | `WorkflowEngine` v2 (CR-09, S1) |
| G12 | Policy and application import Node builtins | `packages/policy/src/policy-source.ts:12-15` (`node:fs`); `pipeline-steps.ts:32` (`node:crypto`) | They cannot be imported by Temporal workflow code (bundler forbids builtins) | pure `@asep/orchestration` core; policy only in activities (S2) |
| G13 | The production pilot path runs the sequential driver directly | `apps/control-plane-api/src/pilot-main.ts:274`; the CLI calls `executeTask` with a mock agent `cli.ts:88`, `cli-main.ts:8` | Two orchestrators once Temporal exists (ADR 0013) | entrypoints dispatch only via `WorkflowEngine` (S9) |
| G14 | `compose.yaml` pins `temporalio/auto-setup:1.31.0` by mutable tag, and that tag does not exist | `compose.yaml:27-28`; `docker buildx imagetools inspect` → `not found` (re-observed 2026-10-29, research register §2) | `pnpm infra:up` cannot start Temporal on a clean host | digest-pinned `temporalio/temporal` dev server (CR-15, S8) |
| G15 | Tenant routes resolve a token to an **organization** only. No principal id, class or capability exists for tenant requests. | `apps/control-plane-api/src/auth.ts:72-80`; capabilities exist only for platform operators `:58-61,149-157` | Controls and approvals cannot check `executions:control` / `approvals:decide`, refuse agent principals or record `decided_by` | principal resolver (CR-17, S9; exit K7) — found by Lane A while adjudicating P3-PLAN-MED-003 |
| G16 | The command runner takes its `AbortSignal` only through the constructor, and `CommandRunner.run` has no per-call signal | `adapters/command-runner/src/command-runner.ts:32-39,96-105`; `packages/ports/src/index.ts:281-283` | Activity cancellation cannot reach a running verification | per-call signal (CR-26, S4) (P3-PLAN-HIGH-006) |
| G17 | The Claude adapter enforces only the request's wall-clock. Turns come from config, and tool calls and cost are not enforced. | `claude-provider.ts:99,141,156` (`cfg.maxTurns`), `:211` (wall-clock); no `maxToolCalls`/`maxCostUsd` use (`grep`) | Attempt budgets are not enforced | per-request caps on the rebased adapter (CR-25, S4) (P3-PLAN-HIGH-005) |
| G18 | The GitHub forge adapter's PR upsert is find-then-create, which is not atomic | `adapters/github-app/src/forge-provider.ts:300-336` | Concurrent creates or a lost create response can leave two PRs or an unreconciled one | create-conflict reconciliation + honest HTTP double contract test (CR-27, S5) (P3-PLAN-HIGH-008) |

**Reported to the controller (affects Phase 2 claims, not fixed by Lane A on its own):** G10's suspected
container orphaning on Claude-adapter timeout bears on Phase 2 exit G3 ("timeout … cancellation"). It is still
unverified at `00a6889`; the code only shows the `docker` client being killed (`claude-provider.ts:225-235`).
v1's statement that G8 was a residual Phase 2 wedge was wrong and is withdrawn. G5 is Phase 2 HIGH-006, which
Lane R owns. Status at the rebase base `d6ee686` (§1.4): G3, G5, G10 and G17 are resolved by Phase 2; G4 stands and is
settled by `findLease` (R29); G16 and G18 stand (CR-26, CR-27).

### 1.3 Phase 2 lessons applied

From `phase-02-final-review-codex-v1.md`, `phase-02-final-rereview-codex-v5.md` and this plan's own review:

1. **A green gate that never exercised the MUSTs.** Every Phase 3 MUST maps to a named executable test with a
   SUITE-ID (`phase-03-exit-criteria.md`). Chaos MUSTs run only against a real Temporal server, real PostgreSQL,
   real MinIO, real Docker and real Git. A missing backend turns the gate red, and a negative test proves it.
   Replay is gated on a non-empty manifest with required scenarios (B5), and the convergence helper has a
   negative self-test (F15).
2. **Backends faked where real ones were required.** In-process "Temporal-shaped" drivers prove the decision
   core only (S2). They are never cited for a recovery MUST. The SDK time-skipping server and the
   runtime-downloaded dev server are excluded from evidence (research register §2). Forge uniqueness is proven
   on the **real** adapter against an honest HTTP double (E12), not only on a double that enforces it itself.
3. **False implementer status claims.** The phase report must quote gate output verbatim and give the log path.
   Every claim carries `file:line`. Anything not run is written "not verified" (exit N1–N5).
4. **Findings fixed in name only.** Each accepted review finding names the design section, the exit criterion
   and the slice that proves it (review log "Locked change" and "Validation" lines). N3 resolves a CRITICAL/HIGH
   only with a fix plus its test, evidence of non-applicability, or an explicit user-accepted risk.

### 1.4 Phase 2 as accepted, at the rebase base `d6ee686` (R51, R52)

The controller accepted Phase 2 at `8e71ed7` (`IMPLEMENTATION_COMPLETE_PILOT_PENDING`, R51) and released G-P2 at its
acceptance record `d6ee686`, the head of `phase/02-single-agent-vertical-slice` (R52). `main` is not moved; merge and
push are user decisions (R51). Lane A rebased this branch from `00a6889` onto `d6ee686` (104 Phase 2 commits). This
section lists every accepted Phase 2 behaviour the plan depends on, as it stands at `d6ee686`, with the slice that
consumes it. Where Phase 2 differs from what the plan assumed, the plan line named in the last column is amended in
the same commit. Line numbers are at `d6ee686`.

| # | Accepted behaviour at `d6ee686` | Evidence | Consumed by | Plan assumption → amendment |
|---|---|---|---|---|
| P2-1 | **Forge port, five methods.** `pushBranch` is compare-and-set (`expectedRemoteSha`, `null` = absent); `upsertPullRequest` creates, or updates title and body of the open PR on the same base, and returns a closed, merged or retargeted PR as found; `updatePullRequestContent` is **required** and keyed by PR number: one write of exactly `{title, body}`, nothing listed, selected or created; `resolveRef` and `findPullRequest` are reads. `findPullRequest` returns one PR for the head branch (the adapter's `prForHead`), not the candidate set, and no read reports a repository ID. | `packages/ports/src/index.ts:410-463`; `PullRequestRef` `:343-363`; GitHub adapter `adapters/github-app/src/forge-provider.ts:415-457` (upsert), `:466-483` (by number), `:526-541` (find); port wrapper `adapters/github-app/src/port-adapter.ts:68`, `:129-136`; local double `adapters/local-doubles/src/index.ts:109`, `:207` | S1 (CR-28 port types), S5 (adapter reads, HTTP double), S6 (publication activities), S8 (`DurableLocalForge`) | The plan listed four methods (CR-28 at `a447983`). **Amended:** CR-28 lists five. R47: no adapter or double implements `updatePullRequestContent` through a branch-keyed upsert, so the S5 HTTP double and the S8 `DurableLocalForge` implement it by number, and the S5 parity table has a row for it (§21, S5). CR-28's PR listing and repository IDs stay needed: neither exists at `d6ee686`. |
| P2-2 | **Reconcile.** `reconcileBranchStep` puts a diverged branch back on the attempt's commit with a compare-and-set push (`absent: 'repair' | 'leave'`); `reconcilePullRequestStep` reads the PR, and only when it is the attempt's **recorded** PR (number, URL, head, open, unmerged, base, head SHA: `publicationGap`) and its title or body differs, writes title and body by that number through `updatePullRequestContent`, then reads again. It has no create, retarget or close path (R43). Both audit `forge.reconcile`. | `packages/application/src/pipeline-steps.ts:1075-1097`, `:1130-1162`, `publicationGap` `:891-913` | S6 (`reconcilePublication`) | R34's narrow repair said "never call `reconcilePullRequestStep` in a mode that creates or retargets"; at `d6ee686` the step has no such mode, so that holds by construction. Two things differ. The step repairs only the PR recorded by the attempt's `COMPLETED` pr-upsert record, and the plan let the activity repair "an open PR on the attempt branch". `reconcileBranchStep` writes to the branch. **Amended** (§11, S6, CR-28): `reconcilePublication` writes only through `reconcilePullRequestStep` with the attempt's `COMPLETED` pr-upsert record. With no such record (an `unknown` push, or an upsert whose record is `PENDING`) it writes nothing, and every PR it lists reports `contentRepaired: false`. A PR the harness created already carries `pullRequestContent(facts)`, so a missing repair changes no content the attempt wrote. It never calls `reconcileBranchStep`: it reads the branch with `resolveRef`, and the core decides. |
| P2-3 | **Fencing primitive (R1).** A lease is `{ leaseId, fencingEpoch }` per (binding, branch). Its epoch is strictly monotonic and unique, a non-`ACTIVE` lease never becomes `ACTIVE` again, and liveness is read on the database clock. `acquire` sweeps expired leases and inserts the next epoch; a second `ACTIVE` lease on the same (binding, branch) is `LeaseDenied`, also for the same attempt. `heartbeat` extends expiry while live and throws `LeaseLostError` otherwise. The side-effect log requires a live owner lease. A takeover needs a dead owner, the same branch and a strictly newer epoch, and reports `takenOver`. `confirmOwner` acts only on a `PENDING` record and renews the lease. A DB trigger enforces the same rules. | `packages/ports/src/index.ts:139-178`, `:722-744`; `adapters/persistence/src/lease-repository.ts:54-111` (acquire), `:113-127` (heartbeat); `migrations.ts:147` (one active writer), `:598` (epoch unique), `:619` (lease guard), `:665-719` (side-effect guard), `:777` (liveness on `clock_timestamp()`); `side-effect-log.ts:177-213` (takeover), `:236-273` (`confirmOwner`) | S0 (the fence shape), S3 (resolver over the lease table, attempt-locked acquisition), S6 (activities), S10 (chaos) | F1–F5, L1 and L3 hold (CR-05). G3 and G5 of §1.2 are resolved by Phase 2. Two lines differ. **L2:** the same attempt cannot re-acquire while its lease is live, so a crash right after the grant is settled by R29's `findLease`, which returns the committed grant's fence, not by re-acquisition. **`FAILED`:** Phase 2 never reopens a `FAILED` record (`confirmOwner` refuses any non-`PENDING` record), so the plan's "reopenable after reconciliation" is withdrawn: an activity that finds its publication record `FAILED` reports the effect `unknown`, and the core reconciles (R24). **Amended:** CR-05, §22 CX-02, architecture §7.1 and §7.4. The block's `AssuranceFence` is exactly `{ leaseId: Lease.leaseId, fencingEpoch: Lease.fencingEpoch }`: S0 gives the core that fence shape. R28 obligation 5 (an acquisition refuses an attempt with a recorded terminal, under the attempt-row lock) is the composition's: Lane A wraps Phase 2's `acquire` in a transaction that locks the attempt row first. That is no change request against the primitive. |
| P2-4 | **Result binding (R2).** Each operation's `result_ref` has a closed shape (`commit`, `push`, `pr-upsert`). It is parsed on every read, and a DB `CHECK` refuses any other JSON. | `packages/ports/src/index.ts:550-570`, `:606-661` | S6 | As assumed (F4, CR-05). |
| P2-5 | **Fitness framework (R8).** The AST guard runs the TypeScript checker (`typescript/unstable/sync`) over the shipped source of every project. It holds the rules `retired-isolation-waiver`, `isolation-claim`, `persistence-call-in-root` and `port-call-in-root`, with seeded virtual-file fixtures in the guard's suite. Import-specifier rules stay in the forbidden-imports suite; the reference graph is checked against imports. | `scripts/lib/ts-guard.mjs:10-41`, `runGuard` `:132-162`; `scripts/ts-guard.test.ts:26-39` (`asep-suite:ts-guard`); `scripts/forbidden-imports.test.ts:192-212`; `scripts/project-references.test.ts` | S7 (core purity, Temporal confinement, workflow purity), S9 (B8, B9) | **Amended** (CR-12): a checker rule (core purity, the B8 import graph, the B9 `FaultInjector` rule) lands as a `FileCheck` rule in `ts-guard.mjs`, with seeded virtual-file fixtures in `ts-guard.test.ts`. An import-specifier rule (`@temporalio/*` confinement) lands in `forbidden-imports.test.ts` with its own self-check. |
| P2-6 | **Kill grace (R24).** The accepted stop path at the wall-clock deadline (or on abort or a violation) runs `docker kill <name>`, one docker call bounded by `DOCKER_CALL_TIMEOUT_MS`, and SIGKILLs the client when it returns. Removal must then be shown (`docker inspect` finds no such container) within `AGENT_REMOVAL_BOUND_MS`. The exported bound for the whole path is `AGENT_STOP_BOUND_MS = DOCKER_CALL_TIMEOUT_MS + AGENT_REMOVAL_BOUND_MS = 30 000 + 30 000 = 60 000 ms`. | `adapters/agent-claude/src/claude-provider.ts:134` (`AGENT_REMOVAL_BOUND_MS`), `:142` (`AGENT_STOP_BOUND_MS`), `:148-151`, `:998-1012` (stop); `adapters/command-runner/src/container-teardown.ts:59` (`DOCKER_CALL_TIMEOUT_MS = 30_000`); exported at `adapters/agent-claude/src/index.ts:31` | S4 (test bound to the constant), S6 (loader), S7 (mapping) | The plan used 0 (`SIGKILL` at the timeout, CR-25 at `00a6889`). **Amended** (CR-25, S4, S6, architecture §10): `policy.agentKillGraceSeconds = AGENT_STOP_BOUND_MS / 1000 = 60`. The container stop timeout is the kill call's own 30 s bound (there is no separate `docker stop -t`), plus 30 s for forced removal. `packages/policy` may not import an adapter, so the worker composition root passes `AGENT_STOP_BOUND_MS` to the orchestration policy loader. The loader refuses a policy whose value differs, and the S6 test reads the constant, never a copied 60. |
| P2-7 | **Agent caps and containers.** The adapter enforces all four caps. Turns are `min(config, request)`. Cost goes to the CLI as its budget and is checked again from the result (`BUDGET_EXHAUSTED` above the cap). Tool calls are counted from the stream and stopped above the cap. Wall-clock is the deadline. Containers are named `asep-agent-<id8>-<random>` and `asep-egress-<id8>-<random>` and carry `asep.attempt=<attemptId>`, `asep.role` and `asep.container` labels. The agent network carries `asep.attempt`. Teardown removes every container and network with the attempt's label; verification sandboxes carry `asep.role` and `asep.attempt`. | `claude-provider.ts:755-756`, `:1032-1036`, `:1209-1211`, `:660`, `:664-666`, `:333-337`, `:376-380`, `:815`, `:933`, `:943`; `adapters/command-runner/src/sandbox.ts:108-111` | S4 (reaper, H9 suite) | G10 and G17 are resolved by Phase 2. **Amended** (CR-08, CR-25, S4): names carry a random suffix, so the `ExecutionReaper` finds an attempt's containers by the `asep.attempt` label (and `asep.role`), not by a deterministic name. CR-25 needs no adapter change: S4 proves H9 over Phase 2's enforcement. |
| P2-8 | **Egress proxy (R48–R50).** One proxy per agent attempt holds the model key. It starts without the key and reports ready. The worker writes the key on stdin only for a ready line that arrives within `PROXY_START_TIMEOUT_MS` (30 s), counted on the monotonic clock from just before the spawn. The proxy exits by itself with no key after `PROXY_CREDENTIAL_WINDOW_MS` (60 s). Its lifetime is `min(remaining budget + PROXY_EXPIRY_GRACE_MS (30 s), PROXY_MAX_LIFETIME_MS (4 h))`, latched on its own monotonic clock; at the end it refuses every request, cuts open streams and exits within `PROXY_EXIT_BOUND_MS` (2 s). A request whose wall-clock budget plus the grace exceeds 4 h is refused before anything is started (`BLOCKED`). | `claude-provider.ts:178`, `:186`, `:196`, `:203`, `:211`, `:627-629`, `:852-866` | S4, S6 (`runAgent`), S7 (input mapping), S10 (CX-04) | New for the plan. **Amended** (S6, S7): the input mapping and the loader refuse an attempt wall-clock budget above `PROXY_MAX_LIFETIME_MS − PROXY_EXPIRY_GRACE_MS` before any activity, read from the constants. `runAgent` keeps engine retry 1: after a worker death the old proxy holds the key until its own end (T2-16: `min(remaining budget + grace, maximum) + readiness bound` from the spawn), a replacement attempt starts its own proxy, and CX-04's reaper removes the dead attempt's labelled containers and network. |
| P2-9 | **Test tooling.** Every gate runs through the controller's `gate.sh` (one gate at a time, with a Node-launch sampler). A run is valid only with no launch of 10 s or more, and acceptance needs two consecutive valid green runs (R47). Every Node test process starts with `--no-wasm-code-gc` (`NODE_TEST_V8_FLAGS`, `nodeTestArgs`). A run-scoped process registry records long-lived test processes (`spawnRecorded`), and the canonical runner ends leftovers and fails on an unknown record. Fitness tests require every test `spawn(` to be recorded or listed with a reason, and every test wait to be timed on the monotonic clock. | `scripts/lib/node-test-flags.mjs:27`, `:33`; `scripts/lib/process-registry.mjs:55`, `:377`, `:387`, `:405`; `scripts/lib/process-registry.test.ts:785-804` | every slice's gate; S8, S10, S11 (spawned worker, API and Temporal processes) | New for the plan; the monotonic-wait rule failed the first gate after the rebase on S2's purity seeds (fixed in the commit after it). **Amended** (§21, CR-14): the chaos suites start worker and API processes with `spawnRecorded` and time every wait on `performance.now()`. |
| P2-10 | **CR-28 lands in Lane A's own commits after G-P2 (R34).** None of its three changes is in Phase 2. | `packages/ports/src/index.ts:380-407` (`PullRequestFacts` without assurance facts), `:459-462` (one PR, no IDs); `adapters/github-app/src/binding-resolver.ts:91-101` (`githubRepositoryId`) | S1, S5, S6, S7 | **Amended** (CR-28): item 1, the assurance facts in `PullRequestFacts` and `pullRequestContent`, is S1 (port type and pure function; Phase 2's content is byte-identical when `flagged` is false and the section is null), consumed by S6. Item 2, `listPullRequests` and repository IDs in the reads, is S1 (signature) and S5 (GitHub adapter, HTTP double; `DurableLocalForge` in S8). Item 3, the input's `repository` from the binding's `githubRepositoryId`, is S7. |
| P2-11 | **Still open at `d6ee686`.** `CommandRunner.run` takes no per-call signal (CR-26). The GitHub upsert is still list-then-create with no `422` handling (CR-27). `run-event` is still 1.1.0. Phase 2 migrations end at `0019`. | `packages/ports/src/index.ts:334-336`; `forge-provider.ts:427-455`; `packages/contracts/schema/run-event.schema.json:4`; `migrations.ts:1109-1127` | S4, S5, S0, S3 | CR-26 and CR-27 stand, with the line numbers re-derived (CR-27). S0 bumps `run-event` from 1.1.0. A5's upgrade path starts from a database at `0019`. |

Phase 2's pilot-pending items (K2, K5, K6, live CONFORMANCE, CYCLE16-LOW-001) and the R47 disposition of
CYCLE11-HIGH-002 do not change any Phase 3 slice. Phase 3 reports its own gates under R47 (valid runs only).

---

## 2. Baseline gate (observed in workflow step 1)

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

These lines were observed at `00a6889` in step 1. Step 3 changes docs only. The step 3 checks are in the Output
block. The Codex reviewer did not run `verify:all` (read-only sandbox), so this baseline is Lane A's observation
only. The controller re-runs it independently.

---

## 3. Gap analysis

| Capability (90-day plan) | Have at base | Need for Phase 3 | Slice |
|---|---|---|---|
| Temporal workflows/activities | step use cases + untyped seam | `taskWorkflow`, `runWorkflow`, janitor schedule; activity bridge; `WorkflowEngine` client | S2, S6, S7 |
| Pause / resume / cancel | none | durable controls with authz, audit and projection; cancellation that reaches agent **and** verification | S2, S4, S7, S9, S11 |
| Heartbeats | lease `heartbeat_at` only | engine heartbeats + lease renewal (L1) + cancellation bridge | S3, S6, S7 |
| Retries | none (sequential driver) | explicit per-activity retry/timeout table; agent never engine-retried; retryable activities redelivered | S2, S7 |
| Idempotency | side-effect log for commit/push/PR | natural keys for every durable write; the Phase 2 lease-bound fencing primitive with invariants F1–F5 and the `FAILED` lifecycle; forge create-conflict reconciliation | S3, S5, S6 |
| Worker-kill chaos tests | in-process fault matrix (PGlite) | real process SIGKILL/SIGSTOP across the full crash-point matrix on real backends | S10 |
| Duplicate-callback chaos tests | none | three named callback boundaries (activity completion, gRPC message delivery, operator HTTP) plus the API decision-delivery crash (architecture §8) | S10 |
| Budgets | per-attempt budget passed to provider; only wall-clock enforced | per-request agent caps; task + run budgets, reservation, soft/hard thresholds, ledger | S2, S3, S4, S6, S11 |
| Approvals | none (R1 human review is recorded after the PR) | durable approval gate (`budget-extension`, `publish-change`) with a transactional decision outbox | S2, S3, S6, S9, S11 |
| Review-loop slot for Phase 4 | none | the reconciled Phase 4 slot contract (S0) + Lane A's activity wrapper, context adapter, admit hook and default binding | S0, S6, S7, S11 |

---

## 4. Scope

**In scope:**

- Temporal task and run workflows plus a workspace janitor schedule;
- retry-safe activities over the Phase 2 step use cases;
- durable pause/resume/cancel; heartbeats; explicit retry and timeout policy;
- idempotency for every durable write, on top of the Phase 2 fencing primitive;
- durable workspace registry; container reaping; per-request agent caps;
- budgets at attempt, task and run level; human approvals with a decision outbox;
- the reconciled review-loop slot composition;
- a mandatory real-Temporal integration gate;
- a worker-kill / duplicate-delivery / infrastructure-outage chaos matrix;
- a production-shaped pre-deployment smoke (Temporal on PostgreSQL);
- orchestration API routes and the principal resolver;
- RunEvent persistence through the shared sink;
- the runbook.

**Out of scope, with the reason for each deferral:**

| Deferred item | Phase 2 status | Decision | Why |
|---|---|---|---|
| Multi-project **fair scheduler** | deferred to "Phase 3+" (`phase-02-plan.md:108`) | **stays deferred** (Phase 5+ scale work) | The exit criterion is recovery without duplicate side effects, not throughput fairness. The pilot is a single operator with low-risk repositories (`phase-02-threat-model-delta.md:52`), so there is no contention to arbitrate. A fair scheduler needs cross-run budget accounting and per-tenant quotas, which would double Phase 3 for no measurable exit benefit. Temporal task queues are the seam to add it later without changing workflow code. |
| **Distributed workers** (multiple hosts) | deferred to "Phase 3+" | **partially in:** N worker processes on **one** host. Multi-host stays deferred. | Worker-kill recovery needs more than one worker process, so a single-host pool is required. Worktrees and the Git mirror are host-local (`worktree-manager.ts:84-91,119-121`), so multi-host needs host-affine routing or shared workspace storage, which is a separate design. A host-id guard fails closed instead of silently running on a missing worktree (architecture §14). |
| Temporal **PostgreSQL persistence** | n/a | **per-commit gate: SQLite dev server; pre-deployment: production-shaped smoke in scope** (R14) | The mandatory gate uses the real server binary with SQLite persistence (research register §2). The production-shaped smoke (exit C9) runs `temporalio/server` on PostgreSQL with a real restart. It runs before any deployment, not on every commit. The report claims production readiness only if it passed (N5). |
| Worker build-id / deployment **versioning** | n/a | deferred; **drain-only or patched deploys** | `patched()` plus a manifest-gated replay corpus covers one deployment line (architecture §6.5–§6.6). Mixed-version rolling deploys are not supported. Deprecated versioning APIs are being removed in server 1.33 (research register §5). |
| Tenant / project / milestone **budgets** | n/a | deferred with the fair scheduler | They need cross-run accounting. Run and task budgets cover the cost-model's "hard thresholds pause or escalate" rule (`cost-model.md:12`) inside one run. |
| Parallel tasks / DAG inside a run | n/a | deferred | Sequential child execution makes the run budget exact without a reservation protocol (architecture §4.2). |
| Review, repair, re-review, adjudication **logic** | n/a | **Lane B (Phase 4)**; Phase 4's reviewer runs in **shadow mode** (user decision) | Lane A provides the composition, wrapper and default binding only (§20). It still handles all four outcomes, because later phases turn gating on. |
| Recovery / cost **dashboards** | n/a | Lane B (Phase 4, `90-day-plan.md:38`) | Phase 3 persists the events. Phase 4 visualises them. |
| R2–R4 execution | deferred by admission | stays deferred | Admission is unchanged unless the `admitWithAssurance` hook is bound at integration. |
| Inbound webhooks, live Claude/GitHub pilot, Temporal mTLS / namespace auth | deferred | stay deferred | Same reasons as Phase 2. Temporal frontend auth is a pre-production dependency (threat T3-01). Live GitHub PR uniqueness is not claimed (E12). |

---

## 5–7. Containers, module map, dependency direction

See `phase-03-architecture.md` §2–§3. Summary of new code:

```text
packages/orchestration                         NEW  deterministic decision core (no runtime imports)
packages/application/src/orchestration-activities/   NEW  retry-safe activities, assurance wrapper, default slot
adapters/temporal                              NEW  the only @temporalio/* importer
adapters/persistence/src/orchestration/        NEW  ordinal, registry, approvals + outbox, ledger, projection
adapters/persistence/src/run-events/           NEW (S0)  shared RunEventSink adapter
workers/temporal-worker                        NEW  composition root + chaos/e2e itests + pre-deployment smoke
apps/control-plane-api/src/orchestration/      NEW  routes, decision delivery relay, API chaos entry
```

Dependency direction is unchanged from Phase 2 (`phase-02-plan.md` §7), with two additions. First,
`adapters/temporal` → `@asep/orchestration`, `@asep/ports`, `@asep/contracts` and `@temporalio/*`. Second,
composition roots (`workers/temporal-worker`, `apps/control-plane-api/src/production-root.ts`) →
`@asep/temporal`. `packages/application` never imports `@asep/temporal` or `@temporalio/*`. The worker composition
root hands application activity functions, and at integration Lane B's assurance functions from
`assurance-root.ts`, to the adapter's `createWorker()`.

---

## 8. Orchestration model

`phase-03-architecture.md` §4 (task workflow, run workflow, janitor) and §13 (projection). Core rules:

- The workflow is the only place that decides what happens next, including how an assurance outcome is
  routed. PostgreSQL status columns are a projection.
- One workflow per task (`asep-task-<taskId>`) and one per run (`asep-run-<runId>`). Starts are idempotent.
- Retries create new **attempts** only before anything has been published. At most one attempt per task
  publishes, which gives one remote ref and one PR per task.
- A failed mandatory verification ends the task (`FAILED`). It is never retried by a new agent attempt and
  never routed to an assurance round.
- The terminal machine state for a successful task is still `WAITING_FOR_HUMAN_REVIEW`.

## 9. PostgreSQL schema

`phase-03-data-model.md`: migrations `0100`–`0107` in Lane A's range. `0103` is intentionally unused, and
`0107_run_events` lands in S0.

---

## 10. API and CLI contract (additions; Phase 2 routes unchanged)

```text
POST /v1/runs/:runId/executions                  start the run workflow           cap executions:start   idempotent (run id)
POST /v1/tasks/:taskId/executions                submit the task to its run       cap executions:start   idempotent (task id)
POST /v1/tasks/:taskId/pause | /resume           control message                  cap executions:control Idempotency-Key header → requestId
POST /v1/tasks/:taskId/cancel                    workflow cancellation            cap executions:control Idempotency-Key header
POST /v1/runs/:runId/pause | /resume | /cancel   run-level controls               cap executions:control
POST /v1/runs/:runId/seal                        no further submissions; the run   cap executions:control Idempotency-Key header → requestId
                                                 completes once no task is open (R21)
GET  /v1/tasks/:taskId/workflow                  live view (Temporal query)       tenant scope
GET  /v1/approvals?status=PENDING                project-scoped list              cap approvals:read
POST /v1/approvals/:approvalId/decision          decision + outbox row → deliver  cap approvals:decide     Idempotency-Key = decisionId
```

- Every route follows the Phase 2 pattern: validate (AJV, canonical schema) → authenticate the principal
  (CR-17) → authorize (server-derived `TenantScope` plus capability) → application use case → map the response.
  Handlers make no Temporal call directly: they call application use cases, which call the `WorkflowEngine`
  port (Phase 2 B5 rule, `forbidden-imports.test.ts:261-333`).
- `POST /v1/tasks/:taskId/executions` body:
  - `workOrder`: validated against `work-order/v1`, stored as an immutable artifact and set once on
    `tasks.work_order_ref`. Its `risk`, `baseSha` and `budget` must equal the task row.
  - `contextPack`: validated against `context-pack/v1` and stored.
  - `verificationPlanId`, and an optional `taskBudget` bounded by the run's governance.

  The use case builds `task-workflow-input/v1` from these plus server-side state. The client never supplies
  tenant IDs, principal class, command strings or governance flags.
- `POST /v1/runs/:runId/executions` body: optional `runBudget`, `publicationApprovalRequired` and `fixedTasks`.
  Setting `publicationApprovalRequired` needs `runs:govern`, and all three are immutable once the run workflow has
  started. A run started with `fixedTasks` is sealed from the start (R21).
- Decision route: the decision row and its delivery row commit in one transaction. Delivery is then attempted
  at once, and the relay (architecture §11) retries until delivered. An identical retry returns the original
  receipt and re-delivers. The body carries `decision`, the rationale (stored in PostgreSQL only) and
  `extensionUsd`, which is required for a budget-extension approve and null otherwise; the Update message carries
  the same amount (data model §4.2, exit I8).
- Money amounts in any body are rejected unless exactly representable in micro-USD and at most `100 000 000` USD
  (exit H12).
- Status codes: 401 unauthenticated, 403 missing capability, wrong principal class or self-approval, 404 out of
  scope, 409 conflicting decision / expired approval / closed workflow / sealed run, 503 when the engine is not
  configured. A 503 never falls back to the sequential driver.
- `asep task execute --task-id <id>` (CLI) becomes a client of the same use case (`submitTask`). It no longer
  runs the pipeline in-process (G13).

---

## 11. Task workflow sequence (the Phase 3 analogue of `phase-02-plan.md` §11)

```text
admitTask                         (activity; injected admit hook, default admitRisk; DEFERRED → BLOCKED;
                                   activity failure → BLOCKED admission-unavailable)
loop attempt n = 1..maxAttempts:
  budget reservation              (workflow core; agent cap + verification reserve, reserved separately; on
                                   failure, architecture §10 "Reservation failure": maxAttempts → FAILED;
                                   task cap short → budget-extension approval if maxBudgetExtensionUsd is set;
                                   else BUDGET_EXHAUSTED)
  ensureAttempt(n, kind, lineage) (natural key; non-cancellable; returns attempt id and remote branch; lineage =
                                   repairBaseSha, parent, repair order; a retry copies the lineage of the attempt it
                                   replaces; failure → findAttempt: found → attempt ends failed with zero usage,
                                   absent → no attempt effects, both task FAILED attempt-registration-failed;
                                   lookup fails → FAILED attempt-state-unknown (below); never replaced)
  acquireLease                    (Phase 2 primitive; invariants L1–L3; its result is the caller's fence, which the
                                   core carries to the attempt's terminal write and release; before it, R28's
                                   pre-lease rule applies; failure after its retries, or a cancel's abort →
                                   findLease (non-cancellable, R29): found → terminal with that fence → release;
                                   absent → recordPreLeaseOutcome(fence null); refused by a late grant (the slot's
                                   lease-granted code → recorded: false, R32) → findLease once more → terminal with
                                   its fence → release; then abandon (below), or CANCELLED after an abort)
  prepareWorkspace                (registry CREATING → worktree at base → ACTIVE)
  storeAttemptInputs              (WorkOrder / ContextPack refs; lineage: buildRepairContextPack; ExecutionEnvelope)
  runAgent                        (engine retry = 1; per-request caps; heartbeats; lease renewed; container asep-agent-<attemptId>)
    agent outcome, architecture §10 (first matching row wins):
    AGENT_DONE within every cap   → the full path below (wall-clock: at most cap + kill grace)
    non-replaceable failure class → abandon (below) → task FAILED with that class; an overrun is still audited
    BUDGET_EXHAUSTED or overrun   → inspectWorkspace only → reap → quarantine → recordUsage (+ recordOverrun) →
    (cost, tool calls, wall-clock)  recordAttemptOutcome(budget-exhausted) → releaseLease → next n (kind retry,
                                    same lineage)
    agent failure or infra error  → abandon (below)
  inspectWorkspace                (overstep → abandon attempt, policy-violation)
  runVerification                 (its own reservation; reap stale verify containers first; per-call cancellation)
  if verdict != PASS: recordAttemptOutcome(verification-failed) → reap → quarantine → releaseLease → task FAILED; stop
  commitAttempt + persistEvidence (critical unit 1: Phase 2 fence; HEAD CAS against base; evidence id allocated
                                   inside; createdAt = workflow time → retry-identical bytes; adoption as safety net)
  assuranceRound                  (cancellable; Lane B runAssuranceRound via the context adapter; Phase 3 default:
                                   PROCEED/not-required for R0/R1)
    REPAIR   → recordAttemptOutcome(repair-requested) → releaseLease → next n (kind repair, new lineage)
    BLOCK    → recordAttemptOutcome(blocked) → reap → quarantine → releaseLease → task BLOCKED; stop
    PROCEED | ESCALATE → continue (ESCALATE flags the PR)
    activity fails → audit assurance-unavailable; shadow mode → PROCEED; gating mode → ESCALATE; never FAILED
  publication approval            (only if the run requires it; a cancellable wait; a pause applies at once and the
                                   expiry timer keeps running)
  publishBranch                   (critical unit 2; Phase 2 pushStep: compare-and-set push of the attempt's commit,
                                   expectedRemoteSha null (R30); record fencing on the side-effect log; every result
                                   and failure carries the publication effect applied | none | unknown, never
                                   inferred from retryability (R24); none → FAILED publication-failed; unknown →
                                   reconcilePublication)
  reconcilePublication            (remote read after an unknown effect; reports the full observation: the branch
                                   with its repository and tip, and every PR with that head branch with its number,
                                   head and base repository, head branch, head SHA, base branch, state, merged flag
                                   and contentRepaired; a repository is its numeric forge ID with owner and name;
                                   its one write rewrites a diverged title and body of the PR that the attempt's
                                   COMPLETED pr-upsert record names, by its number, through Phase 2's
                                   reconcilePullRequestStep (R30, R33, R43; §1.4 P2-2); with no such record it
                                   writes nothing; it never moves the branch; the core audits each repair and applies one identity predicate (R27, R31, R33): the branch is
                                   in the input's repository (by ID) at the attempt's commit, and the candidates
                                   are none or exactly one open, unmerged PR with the input's repository as head and
                                   base repository, that branch and commit as head and the input's baseBranch as
                                   base. After the push: identity → PR upsert; branch absent and no PR → FAILED
                                   publication-failed; otherwise, or the read fails → FAILED publication-incomplete,
                                   audited with what was found)
  upsertPullRequest               (critical unit 3, always run once the push applied; repository and base = the
                                   input's repository and baseBranch (R33); title and body pullRequestContent(facts),
                                   no owner-specific field (R30); record fencing; create-conflict reconcile; effect
                                   none → FAILED
                                   publication-incomplete; unknown or applied → reconcilePublication: identity with
                                   exactly one PR → continue with that PR, else FAILED publication-incomplete;
                                   publication-incomplete is audited with the remote branch, never CANCELLED)
  recordAttemptOutcome(proceeded | escalated) → cleanupWorkspace → releaseLease
  projectTaskState WAITING_FOR_HUMAN_REVIEW; emit task.completed; done
on abandon (pre-publication only): reapContainers → quarantineWorkspace → recordUsage →
  recordAttemptOutcome(failed) → releaseLease → next n (kind retry, same lineage) if replaceable (never for
  policy-violation, false-completion or duplicate-side-effect, whatever the policy says)
on cancel: inside a critical unit → processed once it has reconciled (after push started: once the PR upsert
  has too, or the task ends publication-incomplete); anywhere else → at once; then reap → quarantine →
  recordAttemptOutcome(cancelled) → releaseLease → CANCELLED
every terminal of a leased attempt: recordUsage → recordAttemptOutcome(fence) → releaseLease(fence), in that
  order, each effect finished before the next starts (R27, R23); an attempt that never held a lease records its
  terminal with fence null and only as cancelled or infrastructure-failed (R28; architecture §4.1)
on a store that cannot be read or written (findAttempt or findLease after its retries, a second findLease that finds
  nothing, or a failed recordPreLeaseOutcome; R32): FAILED attempt-state-unknown, also over a pending cancel; no
  usage, outcome or release for that attempt; audit attempt.state-unknown with its idempotency key; the task result
  lists it in unrecordedAttempts (R29; exits D13, L6)
```

## 12. Ports and adapters

All new and changed port signatures are in §30 (CR-04, CR-07 … CR-10, CR-24 … CR-28), which is the binding
text for the controller. Fencing and side-effect result types are the accepted Phase 2 primitive's (CR-05),
not Lane A's.

## 13. Trust boundaries (delta)

`phase-03-threat-model-delta.md`. New boundaries:

- **Temporal frontend:** the control plane and the worker pool connect, with separate credential settings.
  Loopback only in the gate.
- **Workflow history:** refs-only, constrained-string payloads; no free text.
- **Approval decisions:** PostgreSQL evidence, delivered through an outbox and re-verified by the workflow
  before acting.
- **Worker pool:** fenced against zombies by the Phase 2 primitive.
- **Janitor:** acts only on closed workflows.

## 14. Determinism and versioning

Architecture §6:

- the real bundler test and the static purity fitness rules;
- a manifest-gated replay corpus replayed offline in `pnpm test`;
- canonical schemas for every workflow payload, governed by the existing compat gate;
- drain-only or patched deployments while Worker Versioning is deferred.

## 15. Retries, timeouts, idempotency

Architecture §5 (activity table) and data model §5 (idempotency key catalog). No activity relies on Temporal's
default unlimited retry (research register §4).

## 16. Fencing

Architecture §7. Record fencing is the Phase 2 lease-bound primitive under invariants F1–F5 and the `FAILED`
lifecycle. On top of it come local Git CAS and, at the forge, Phase 2's publication contract of cycle 9 (R30): a
compare-and-set push, PR content that is a pure function of immutable attempt facts, and reconciliation of the remote
before any terminal state (architecture §7.3), plus forge create-conflict reconciliation (CR-27). The forge itself is
not fenced: a stale owner may still reach it, and the guarantee is what it can write. Cancellation and fence checks
just before each external call narrow that window; they do not close it.

## 17. Pause / resume / cancel

Architecture §9. Cancellation reaches both the agent and the verification runner (CR-26, exit G10). There is no
single commit-to-PR critical section: each operation that needs reconciliation is its own critical unit (commit
plus evidence binding, push, PR upsert), and a cancel inside a unit is processed once that unit has reconciled.
Assurance rounds, repair planning and approval waits are cancellable at any time (R17; exits G7, G11, G12). The
workflow audits accepted controls after acceptance. A cancel never finalizes while a publication unit is
unreconciled: an `unknown` publication effect is reconciled against the remote first, under one identity
predicate on both paths over the full observation (the branch is in the binding repository, compared by its numeric
forge ID, at the attempt's commit, and the PR candidates are none or exactly one open, unmerged PR with the binding
repository as head and base repository, that branch and commit as head and the task's base branch as base). Only a publication that cannot
be reconciled under that predicate ends the task `FAILED / publication-incomplete`: a PR upsert that fails with
effect `none`, a remote that is not exactly the attempt's, or a failed read. A PR upsert that fails with an `unknown`
or `applied` effect and reconciles under the predicate is a completed upsert, and a pending cancel then ends the task
`CANCELLED` with the PR left open (G13; R21, R24, R27, R31). Every terminal outcome of a leased attempt is
recorded before its lease is released (J5; R27). A cancel that aborts `acquireLease` first settles the lease with
the non-cancellable `findLease`, and a lookup that fails ends the task `FAILED / attempt-state-unknown`, never
`CANCELLED` (D13, D17; R29). A pause during an approval wait applies at once, and the expiry timer keeps running (G14). A run gains a
`seal` control, and drain seals every open run (D15, M1; R21). Seal does not resume a paused task; drain reports the
sealed runs a paused task holds open as blocking items for an operator to resume or cancel, and never resumes one
itself (R24).

## 18. Budgets

Architecture §10:

- per-request agent caps enforced by the rebased adapter (CR-25);
- reservation-based hard caps at task and run level, with the verification budget reserved separately when an
  attempt starts, so agent spending can never consume it (R17);
- one agent-outcome table: `AGENT_DONE` gets the full path; a failure class that is not replaceable ends the task
  `FAILED` even after a cap stop or an overrun (R20); otherwise a cap stop or an overrun is inspected only and is
  never verified, committed or published; an infrastructure error is replaced only if `maxAttempts` and a fresh
  reservation allow (exits H5, H8, H10);
- harness-measured wall-clock above the attempt cap is an overrun like cost and tool calls; the only tolerance is
  the adapter's kill-escalation grace, held as policy data (R21, exit H11);
- integer micro-USD with ceiling conversion of usage; exact, bounded money inputs, rejected otherwise at the
  input mapping (R21, exit H12);
- one reservation-failure table: `maxAttempts` exhausted → `FAILED`; a task-cap shortfall → budget-extension
  approval when `maxBudgetExtensionUsd` is set (no default in code, R19); every other budget cause →
  `BUDGET_EXHAUSTED` (exits H3, H4, J4);
- soft-threshold events;
- verification never reduced, and never run on a path that cannot publish.

## 19. Approvals

Architecture §11:

- human-only and capability-checked; self-approval refused;
- the decision and its outbox row commit in one transaction, and a relay delivers the decision;
- PostgreSQL decision evidence re-verified by the workflow;
- durable expiry; Update-ID deduplication plus workflow-side validation;
- the canonical decision message carries `extensionUsd` (exit I8), and the expiry and verification races are
  proven by direct traces and a step-aligned property oracle (exit I9).

## 20. Review-loop slot (reconciled integration point for Lane B, R3)

Architecture §12 describes the behavior. The binding types are CR-10 in §30: the verbatim Lane B block, landed
in S0 at `packages/application/src/review-loop/` (R16). Summary:

- **Position and outcomes.** One assurance round per attempt that passes verification, after evidence and
  before push. Outcomes are exactly `PROCEED | REPAIR | ESCALATE | BLOCK`. No round runs after a verification
  stop. `recordAttemptOutcome()` runs at every attempt terminal.
- **Lane B's side.** Lane B implements `runAssuranceRound`, the step functions, `recordAttemptOutcome`,
  `buildRepairContextPack` and `admitWithAssurance` as framework-free application code. It never imports
  `@temporalio/*`, `@asep/orchestration` or `@asep/temporal`.
- **Lane A's side.** Lane A owns the composition:
  - one `assuranceRound` activity;
  - the `ActivityExecutionContext` → `AssuranceStepContext` adapter, whose `now()` is stable across
    redeliveries;
  - the `recordAttemptOutcome` activity at every terminal;
  - the injected `admit` hook;
  - the repair attempt at `repairBaseSha` with a ContextPack from `buildRepairContextPack()`, and a retry of a
    repair attempt that keeps the whole lineage (R17);
  - the `NotConfiguredAssuranceSlot` default, landed minimal in S0 and bound in S6. It fails closed for any risk
    that requires review, and it is distinct from Lane B's `DisabledAssuranceSlot`, the explicit opt-out (R18);
  - the workspace resolver port of the fixed block, implemented over the lease table (S3, exit E15);
  - an assurance-activity failure: audited `assurance-unavailable`, then `PROCEED` in shadow mode or `ESCALATE`
    in gating mode, never `FAILED` (R19, exit J10).
- **Binding.** The worker composition root binds the slot. Integration imports Lane B's `assurance-root.ts`
  and swaps the binding, and workflow code does not change (R10).
- **Proofs.** Lane B proves its implementation with its own sequential driver, as the lane contract requires.
  Lane A proves the composition with a scripted slot in S2 (core), S6 (activities) and S11 (real Temporal).
  Both lanes run the S0 conformance kit. When the fixed block lands, S0 renames the core's local slot types and
  terminal names to the block's and proves the mapping (exit O5). With Phase 4 in shadow mode, integration will observe `PROCEED` plus
  recorded findings, but all four outcome paths are proven now.

---

## 21. Testing pyramid and the mandatory gate

| Layer | What | Where it runs |
|---|---|---|
| Pure core | reducer table tests, property tests (one PR per task, budget never exceeded, no ACCEPTED, cancel always cleans up, one `attempt.completed` per attempt, no publish after `REPAIR`/`BLOCK`) with a sequential in-memory interpreter | `pnpm test` |
| Fitness | Temporal confinement, workflow purity, core purity on production source (package-local in S2, shared rule from S7), explicit activity options, no second driver in production entrypoints, no fault injector in production, real bundler test with a seeded failing fixture | `pnpm test` |
| Replay | manifest-listed histories replayed with `Worker.runReplayHistories`; required scenarios; a seeded non-deterministic fixture must fail | `pnpm test` (offline; native core-bridge, no server) |
| Activity bridge | `MockActivityEnvironment`: heartbeat mapping, cancellation → `AbortSignal`, logical time, error → non-retryable mapping | `pnpm test` |
| Activities | each activity invoked twice with identical input (PGlite + real temp Git) converges; crash-injected variants; `FAILED` lifecycle | `pnpm test` |
| Adapters | per-call runner abort; agent caps with a fake stream; real GitHub adapter vs an honest HTTP double (concurrent upsert, lost response, `422`) | `pnpm test` |
| Persistence | migrations `0100`+ apply, re-apply as a no-op, reject edits; Phase 2 primitive invariant races (F1, F2, L1, L2), ordinal, approval and outbox races on **real pg.Pool**; `run_events` append-only | `pnpm test` (PGlite) + `pnpm test:integration` (real PG) |
| End-to-end | real Temporal dev server + real PG + MinIO + Docker sandbox + Git; agent double in a container; durable out-of-process forge double | `pnpm test:integration` |
| Chaos | the CX matrix (§22) via real worker and API processes, SIGKILL/SIGSTOP, `docker restart`/`pause`, completion and message duplication at the transport | `pnpm test:integration` |
| Pre-deployment smoke | `temporalio/server` on PostgreSQL + `admin-tools` schema setup; happy path; real server restart | `pnpm --filter @asep/temporal-worker smoke:prod` (controller, before deployment) |

**Mandatory gate extension (CR-14).** `scripts/integration/run-integration.mjs` also provisions
`temporalio/temporal@sha256:ad4c82c9…`. The container runs `temporal server start-dev --ip 0.0.0.0 --headless
--namespace asep-itest --db-filename /data/temporal.db` on a container volume. In-container `0.0.0.0` is
needed for Docker's port mapping. The gate publishes the port on host loopback only (`-p 127.0.0.1:<port>:7233`)
and asserts that (C7). It also:

- prints the image's `temporal --version` line into the gate log (observed today: `temporal version 1.9.1
  (Server 1.32.0, UI 2.54.1)`);
- prints the full `docker pull` and `docker image inspect` RepoDigests output of every pinned Temporal image (C1);
- creates the namespace with `--retention 24h` and reads it back (C10);
- waits for namespace readiness through `temporal operator namespace describe` executed **inside** that
  container, so the gate script needs no SDK import;
- exports `ASEP_TEMPORAL_ADDRESS` / `ASEP_TEMPORAL_NAMESPACE`.

`ASEP_ITEST_OMIT_BACKEND=temporal` must turn the gate red, proven end to end in
`scripts/integration/gate-fail-closed.itest.ts`. New SUITE-IDs are required in both runners (CR-13, CR-14). Only
live Claude and live GitHub remain opt-in, as in Phase 2.

**Forge and agent doubles.** No credentials exist, so Claude and GitHub stay doubles, as in Phase 2.

- **Chaos forge.** Phase 2's `LocalBareForgeProvider` keeps PRs in memory
  (`adapters/local-doubles/src/index.ts:89-91`), and that state dies with a killed worker. So Phase 3 adds
  `DurableLocalForge` (new file). It pushes with real `git push` to a real bare remote. It keeps PRs plus an
  append-only **call log** in a file owned by the test process, outside every worker. It answers a duplicate
  create for a head with GitHub's `422`, exactly like the HTTP double, and a shared semantics table test pins
  the two to the same behavior. Both implement `updatePullRequestContent` by PR number, never through the
  branch-keyed upsert (R47, §1.4 P2-1). The chaos suites start their worker and API processes with the process
  registry's `spawnRecorded` and time every wait on the monotonic clock (§1.4 P2-9).
- **Real adapter proof.** Uniqueness on the real adapter is proven separately: the real
  `GitHubAppForgeProvider` runs against an honest local HTTP double of the pulls API (E12).
- **Agent.** The agent double runs inside the real Docker sandbox through the **rebased** real
  `ClaudeCodingProvider`, with a fake `claude` executable (the Phase 2 fake-executable pattern). It emits
  turn, tool-call and cost events, so container lifecycle, reaping and the CR-25 caps are real.

## 22. Chaos matrix (each row is a test; all end in `assertConvergence`, architecture §8)

| CX | Fault | Injection | Expected convergence |
|---|---|---|---|
| CX-01 | kill after `ensureAttempt` insert | crash point + SIGKILL | same attempt row reused; no second ordinal |
| CX-02 | kill after lease insert | crash point + SIGKILL | the committed grant's fence found by `findLease` (L2, R29; §1.4 P2-3); no `LeaseDenied` wedge |
| CX-03 | kill after `git worktree add`, registry `CREATING` | crash point + SIGKILL | promoted to ACTIVE or quarantined + replaced pre-agent |
| CX-04 | kill mid-agent, container running | SIGKILL worker | agent activity fails on heartbeat timeout (not redelivered); the attempt's containers and network reaped by the `asep.attempt` label (§1.4 P2-7); workspace quarantined; attempt 2 runs with its own egress proxy; 1 PR; `recoveryKind: attempt-replaced` |
| CX-05 | kill mid-verification | SIGKILL worker | same verification activity redelivered; stale verify containers reaped; 1 verdict recorded |
| CX-06/07/08 | kill after commit `begin` / after `git commit` / after `complete` | crash points | exactly 1 harness commit per attempt; adopted SHA = evidence `resultSha` |
| CX-09 | kill after evidence object write, before metadata insert | crash point | retry writes identical bytes (deterministic `createdAt`); evidence adopted; no wedge |
| CX-10/11/12 | kill after push `begin` / after `git push` / after `complete` | crash points | exactly 1 remote ref at the committed SHA |
| CX-13/14/15 | kill after PR `begin` / after create call / after `complete` | crash points | exactly 1 PR; ≤ 1 successful create in the call log |
| CX-16 | kill between projection writes | crash point | projection converges; `projection_seq` monotonic |
| CX-17 | zombie: SIGSTOP during `publishBranch` / `upsertPullRequest` after the external call; heartbeat timeout; worker B retries and takes over; SIGCONT A | SIGSTOP/SIGCONT | A can neither complete nor fail its record (F2); A's late completion is rejected by the server; 1 ref, 1 PR; `side-effect.takeover` audited |
| CX-18 | Temporal server restart mid-agent and mid-publish | `docker restart` (volume-persisted history) | workflow resumes; convergence holds |
| CX-19 | PostgreSQL restart mid-activity | `docker restart` | activity retries converge |
| CX-20 | object store unavailable during artifact/evidence put | `docker pause` / `unpause` MinIO | bounded retries; convergence after recovery |
| CX-21 | lease expiry during an outage longer than the lease TTL (TTL shortened in test config) | stop all workers past TTL, restart | re-acquire + takeover under F1–F3; 1 ref, 1 PR |
| CX-22 | 5 concurrent duplicate task submissions (operator HTTP) | parallel API calls | 1 workflow; 1 attempt 1 |
| CX-23 | duplicate pause/resume requests (same and different `Idempotency-Key`) | parallel API calls | one transition each; projection consistent |
| CX-24 | same approval decision ×3 concurrently + one conflicting decision | parallel API calls | 1 decision row; 1 effect; conflict → 409 and validator rejection |
| CX-25 | approval expiry, then a late decision | short TTL | kind's reject path; late decision 409; `approval.expired` |
| CX-26 | agent exceeds a cap (turns, tool calls, cost, wall-clock; one run each) | fake executable streams past the cap | agent killed at the cap; attempt `BUDGET_EXHAUSTED`; container reaped; next attempt or task outcome per budget |
| CX-27 | malformed agent stream | fake executable | attempt FAILED (classified); replacement per policy |
| CX-28 | forge rate limit for N calls | forge double fault mode | publish retries with backoff; 1 PR |
| CX-29 | projection tamper: `tasks.status` set to CANCELLED by hand mid-run | direct SQL | workflow unaffected; projection corrected at the next seq; drift audited |
| CX-30 | workspace activity scheduled on a worker with a different host id | two workers, two host ids | `WorkspaceUnavailableError` → abandon (pre-publication); never runs on a missing worktree |
| CX-31 | push and PR: the external call succeeds, its response is lost, and the activity records `fail` | forge double fault mode (apply, then drop response) | retry reopens only after reconciliation, finds the effect, adopts it; 1 ref, 1 PR |
| CX-32 | push and PR: kill right after `FAILED` is written | crash point | next delivery reconciles before reopen; exactly 1 effect |
| CX-33 | push and PR: ambiguous timeout with the effect applied | forge double delays past the client timeout | record stays `PENDING`; retry reconciles and adopts; 1 ref, 1 PR |
| CX-34 | API killed after the decision transaction commits, before the Update is sent | API chaos entry crash point + SIGKILL; restart API | relay delivers once; workflow continues once; 1 decision; delivery row `DELIVERED` |
| CX-35 | duplicate activity completion callback | re-send a recorded task token's completion via `AsyncCompletionClient`, after the genuine completion and after a superseding retry | server rejects both; exactly 1 completion event per scheduled activity |
| CX-36 | duplicate Update and Signal at the gRPC boundary | test-only client wrapper sends each request twice | exactly 1 effect each |

The crash points are a `FaultInjector` injected **only** by the chaos entries
(`workers/temporal-worker/src/chaos/chaos-worker-main.ts`, `apps/control-plane-api/src/orchestration/chaos/api-chaos-main.ts`).
It can block or exit and nothing else. It cannot skip a step or fake a result, so it can only produce a red
result. A fitness rule forbids the production entries from importing it (exit B9).

## 23. Observability and audit

Architecture §15.

## 24. Migration from the Phase 2 driver

- The step use cases are reused unchanged in behavior. Their inputs gain three things:
  - the fencing identity of the accepted Phase 2 primitive (in whatever shape it lands);
  - `expectedHeadSha` (CR-07);
  - a per-call signal for verification (CR-26).

  The Phase 2 sequential driver passes them too, so the Phase 2 suites keep running unmodified.
- `runVerticalSliceWorkflow` and `governedExecution` remain the **test** drivers for the Phase 2 K1 proofs
  (`apps/control-plane-api/src/vertical-slice.itest.ts`). After S9 no production entrypoint reaches them (exit B8).
- `workers/workflow-worker` (the Phase 2 thin caller, `workers/workflow-worker/src/index.ts:20-22`) stays as is.
  The Temporal worker is a new composition root.

## 25. Task DAG (acyclic) and gates

```text
G-P2: Phase 2 accepted → main → Lane A rebases          G-LB: Lane B's slot block locked and handed over
                  └──────────────────────┬──────────────────────────────┘
                                         ▼
                                        S0 ─▶ S1 ─┬─▶ S3 ─┐
S2 (only slice allowed before G-P2) ──────────────┼─▶ S4 ─┼─▶ S6 ─▶ S7 ─▶ S8 ─┬─▶ S9 ─┬─▶ S10 ─┐
                                                  └─▶ S5 ─┘                  └─▶ S12   └─▶ S11 ─┴─▶ S13
```

- **G-P2** blocks S0 and everything after it. S3 (persistence on the fencing primitive), S4 (agent runtime and
  runner), S5 (forge result binding), S6 (activities) and S10 (chaos) depend directly on Phase 2 semantics
  (P3-PLAN-MED-008). The controller re-runs both gates after the rebase.
- **G-LB** blocks S0, which needs the verbatim slot text.
- **S2 is the only slice allowed before G-P2.** It may start once the controller says "implement". It uses
  only types present at `00a6889` plus types local to `packages/orchestration`. S7 maps the generated workflow
  input types onto them, with a mapping test.
- S3, S4 and S5 are independent of each other. S7 needs S2 and S6.
- **S2 fitness checkpoints (P3-PLAN2-MED-001).** Before G-P2, S2 proves core purity with a package-local
  self-check over production source (exit B2) and does not touch `scripts/forbidden-imports.test.ts`. The shared
  rule lands in S7, on the accepted Phase 2 framework.
- **Default slot in S0 (P3-PLAN2-MED-003).** S0 lands a minimal `NotConfiguredAssuranceSlot`, so O1 is provable in
  S0. S6 only binds it into the activity wrapper.
- **Replay corpus staging (P3-PLAN2-MED-003).** The replay suite becomes required in S8, the first slice with a
  real Temporal server, together with its first captured histories and `required-scenarios.json`. S10 and S11
  append scenarios with their histories in the same commit; S13 asserts the full list (architecture §6.5). No
  slice skips the suite or runs it on an empty manifest.

v1 → v2 slice mapping: v1 S1 → S0 (shared items) + S1; S2 → S2; S3 → S3; S4 → S4 (+ CR-25, CR-26);
— → S5 (new, CR-27); S5 → S6; S6 → S7; S7 → S8; S8 → S9; S9 → S10; S10 → S11; — → S12 (new, smoke); S11 → S13.

## 26. Slices (one commit each) with acceptance checks

| Slice | Deliverable | Commit | Gate | Acceptance checks (exit criteria) |
|---|---|---|---|---|
| S0 | **Shared foundation**: every `[S0]` item of the reconciliation, exactly as specified there. (a) the fixed review-loop slot block (CR-10, verbatim Lane B block, R18) in `packages/application/src/review-loop/` (R16): the slot, Lane B's `DisabledAssuranceSlot`, the workspace resolver port and the framework-free conformance kit `review-loop-contract.ts`; (b) a minimal `NotConfiguredAssuranceSlot` in `packages/application/src/orchestration-activities/`; (c) `RunEventSink` + `RunEventConflictError` port, migration `0107_run_events` (unified DDL), PG adapter `adapters/persistence/src/run-events/**`; (d) `run-event` 1.2.0 superset (schema, fixtures, catalog, generated types); (e) the decision core adopts the block's names: its local slot types and terminal names are renamed to the block's (they stay core-local, because production source may type-import only `@asep/contracts`/`@asep/ports`), pinned by a type-level assignability check and the O5 table test (test-only `@asep/application` devDependency, like `@asep/domain`); on the pre-lease terminals (an attempt found registered after a failed `ensureAttempt`, and one whose failed or aborted `acquireLease` left no lease) only the core's `failed` is renamed to `infrastructure-failed`, and `cancelled` stays `cancelled` (R33); `recordAttemptOutcome` carries the caller's fence from `acquireLease` or `findLease`, `null` only for a never-leased attempt (R28, R29); `recordPreLeaseOutcome` maps the slot's `ReviewLoopContractError` code `lease-granted` (a `fence: null` write refused because durable history shows a lease) to `recorded: false`, never to supersession or an activity failure (R29, R32); every money field at the seam is integer micro-USD (R28); Lane A runs the kit's RLC-16 atomicity case against `NotConfiguredAssuranceSlot`, which persists events and so may not declare it `N/A`, and the kit's registration-before-effect ordering case against its workflow (R32) | `feat(shared): land the review-slot contract, run-event sink and run-event 1.2.0` | G-P2, G-LB; first commit after the rebase | O1–O6, J2 (default slot), A5 (`0107` and the upgrade path), L3 |
| S1 | Lane A contracts and ports: 3 new schemas + fixtures + snapshots + generated types (incl. `fixedTasks`, the `seal` control, `approval-decision.extensionUsd` and `policy.agentKillGraceSeconds`, R21); `TaskStatus` extension + domain transition table (incl. the R21 edges `WAITING_FOR_APPROVAL ⇄ PAUSED` and `PAUSED → BUDGET_EXHAUSTED`); ports CR-04, CR-07, CR-08, CR-09, CR-24, CR-26 types and error classes; principal types (CR-17); metrics dictionary entry; ADR 0017 | `feat(contracts): add durable-orchestration message contracts and ports` | after S0 | A1, A3, D1 (types compile), L5, domain table tests incl. the unchanged no-ACCEPTED invariant |
| S2 | `@asep/orchestration`: reducer, activity option table, budget arithmetic (agent cap and verification reserve), the agent-outcome and reservation-failure tables, approval and control handling with the critical units, assurance-outcome routing incl. assurance-activity failure, repair lineage on retry, sequential in-memory interpreter; package-local purity self-check over production source. Core traces in the acceptance tables: (1) cap exhaustion and overrun vs H5/H9; (2) `REPAIR` with a failed reservation: `maxBudgetExtensionUsd` set (approve, reject) or unset, and a run-remainder shortfall; (3) `REPAIR` → agent death → replacement keeping the lineage → round-2 assurance; (4) cancel during assurance and during the publication-approval wait; (5) a non-replaceable agent failure beats a cap stop or an overrun (R20); and for v4 (R21): (6) a hostile policy listing each never-replaceable class; (7) wall-clock at the cap, at cap + grace and above; (8) micro-USD boundaries; (9) a failing PR upsert after a successful or ambiguous push, with a cancel pending; (10) a run sealed below `maxTasks`, created sealed, and sealed across continue-as-new; (11) pause during both approval waits; (12) the three `findAttempt` outcomes; (13) the two approval races, with both mutations shown red; the purity check is AST-based; and for v5 (R24): (14) the publication effect for push and PR upsert (`applied`, `none`, `unknown` with each reconciliation result, and a failing reconciliation), with and without a cancel pending (retryability does not reach the core); (15) every money cap equal to `MAX_USD` with usage one micro-USD above it, usage above the bound and invalid usage; (16) content-valid `verified: false` decisions for each approval kind in the generator; the purity check uses the TypeScript checker with the module-resolution closure; and for v6 (R27): (17) the reconciliation identity predicate on both paths, with the reconciliation result carrying the observed SHAs, for a wrong head, a moved or missing branch, a PR at another head or base, and an unreadable remote, each with and without a cancel pending, the reviewer's probe and the generator's seed 1351; (18) terminal outcome before lease release on every leased path, per path and as a per-attempt ordering property, with the reviewer's release-before-outcome mutation shown red; (19) the ambient-global allowlist and the locale-dependent members in the purity check, with the reviewer's locale and `navigator` probes as seeds; and for v7 (R29, R31): (20) the full publication observation on both paths (a fork head, a closed or merged PR, several candidates, a PR at another head or base, a branch in another repository), each with and without a cancel pending, the reviewer's `IDENTITY_MATRIX` cases as tests; (21) `baseBranch` and `repository` validation with the reviewer's four invalid bases, fixtures and generator on non-`main` bases, and the oracle checking every request's base against the input, with the reviewer's base-forced-to-`main` mutation shown red; (22) lease settlement after a failed or aborted `acquireLease` (`findLease` found, absent, a late grant refusing the pre-lease write, a second lookup) and `attempt-state-unknown` on a lookup failure over a pending cancel, the four `R29_*` probes as tests, with fences and lookups checked by the property oracle; (23) a type assertion inside a computed key and the double cast in the purity check, with the reviewer's asserted-key constructor as a seed and as a mutation of the production core; and for v8 (R33): (24) Git ref validation per path component (no leading `/`, no component starting with `.` or ending in `.lock`, not `HEAD`) with the reviewer's four names, held by a committed table of names with their `git check-ref-format --branch` result and a test-only check that re-runs git on the table; (25) the repository identified by its numeric forge ID in the input and the observation: a rename or transfer with the same ID reconciles and is audited, another repository at the old owner and name (another ID) is refused, on both paths with and without a cancel; (26) a content repair the reconciliation reports is audited; (27) the repository on the PR upsert request and the oracle checking every publication request's repository and base against the input; (28) fixtures and the generator varying the repository's ID, owner, name and case and emitting head branches that differ only in case, with the reviewer's two surviving mutations (a case-folded head branch; a hard-coded repository) shown red | `feat(orchestration): add the deterministic workflow decision core` (`a133e32`) + `fix(orchestration): …` follow-ups for v3, R20, v4, v5, v6, v7 and v8 | may start before G-P2 | B2 (package-local), D5 (core), D7 (core), D13 (core), D14 (core), D15 (core), D16 (core), D17 (core), D18 (core), G7/G11/G12/G13/G14 (core), H1, H3/H4 (core), H5 (core), H8 (core), H10 (core), H11 (core), H12 (core), I6, I9, J3 (core table), J4 (core), J5 (property), J7, J10 (core), L6 (core) |
| S3 | Migrations `0100`–`0102`, `0104`–`0106`; `adapters/persistence/src/orchestration/**` (ordinal, registry, approvals + outbox, ledger, projection); the workspace resolver over the lease table; invariant race itests against the Phase 2 fencing primitive | `feat(persistence): make orchestration state idempotent on the fenced lease primitive` | G-P2 | A5 (full set and the upgrade path), D11, E1–E5, E9, E13 (persistence part), E15 |
| S4 | On the rebased adapters: Git worktree rehydration from the registry; `create` create-or-adopt (base or `repairBaseSha`); commit HEAD CAS; host-id guard; `ExecutionReaper` over Phase 2's container and network labels (`asep.attempt`, `asep.role`; the names carry a random suffix, §1.4 P2-7); per-call runner abort (CR-26); the H9 suite over Phase 2's per-request agent caps, which need no adapter change (CR-25); the kill grace re-derived from the accepted stop path, `AGENT_STOP_BOUND_MS` = `DOCKER_CALL_TIMEOUT_MS` + `AGENT_REMOVAL_BOUND_MS` = 60 s (§1.4 P2-6), bound in the tests to that constant, not a copied literal (R24); orphan-container itest | `feat(workspace): make workspaces, sandboxes and agent caps restart-safe` | G-P2 | E6, E7, E8 (resolves research Q6), E14, H9 |
| S5 | Forge PR-upsert convergence on the real GitHub adapter (CR-27) + honest HTTP double + contract test; the forge reads of CR-28 (every PR on a head branch, repositories by numeric ID); `DurableLocalForge` semantics parity table, including the compare-and-set push, the PR listing and `updatePullRequestContent` by number, never through the branch-keyed upsert (R47) | `fix(forge): reconcile a pull-request create that conflicts with an existing head` | G-P2 | E12 |
| S6 | `packages/application/src/orchestration-activities/**`: every activity over `ActivityExecutionContext`; check ids resolved through `VerificationCommandCatalog` (CR-24); fencing on the Phase 2 primitive with the `FAILED` lifecycle; deterministic evidence time; assurance wrapper + context adapter + binding of the S0 `NotConfiguredAssuranceSlot` + `recordAttemptOutcome` activity + admit hook; approval, budget, projection, control and run-event activities; `ensureAttempt` returning the attempt branch and the `findAttempt` lookup (R21); `acquireLease` returning the caller's fence, the read-only `findLease` lookup of the attempt's lease history and the `recordPreLeaseOutcome` write with its refusal result (R29); the publication effect on every push and PR-upsert result and failure, `none` only when the failure provably precedes the forge call; the publication activities over Phase 2's cycle-9 ports (R30, CR-28): `publishBranch` through `pushStep` (compare-and-set push, `expectedRemoteSha: null`), `upsertPullRequest` through `upsertPrStep` with `pullRequestContent(facts)` and the input's repository and `baseBranch`, and the `reconcilePublication` activity (R24), which reports the full observation (the branch with its repository and tip, every PR with that head branch with its repositories by numeric ID, head, base, state, merged flag and `contentRepaired`), repairs a diverged title and body only of the PR its `COMPLETED` pr-upsert record names, through `reconcilePullRequestStep` (by number, R43), reads the branch with `resolveRef` and never calls `reconcileBranchStep`, and decides nothing else (R27, R31, R33; §1.4 P2-2); a publication record found `FAILED` is reported as effect `unknown`, because Phase 2 never reopens it (§1.4 P2-3); R30's interleavings as tests through these activities: the in-transport PR race, a stale different-commit push refused, a late same-commit push a no-op (exit E16); the `lease-granted` mapping table test (R32); the `recordAttemptOutcome` activity presents the caller's fence and runs before `releaseLease` (R23, R27, R28); the orchestration policy loader `packages/policy/src/orchestration-policy.ts` (CR-21), which rejects a policy listing a never-replaceable class, refuses an `agentKillGraceSeconds` other than the `AGENT_STOP_BOUND_MS / 1000` the worker composition root passes it (the policy package imports no adapter), and refuses an attempt wall-clock budget above `PROXY_MAX_LIFETIME_MS − PROXY_EXPIRY_GRACE_MS` (R21; §1.4 P2-6, P2-8); double-invoke and crash-variant tests | `feat(application): expose step use cases as retry-safe activities` | G-P2 | B7, D6, D13 (lookup activity), D14 (loader), D17 (lookup and refusal activities), E10, E11, E13 (activity part), E16, J2, J8, J9 |
| S7 | `adapters/temporal`: workflows (task, run, janitor), activity bridge, error mapping, `WorkflowEngine` client with the connection guard, worker factory, bundler test, the test-support callback injector (CR-16); the input and control mapping (workflow input → core input, rejecting inexact or unbounded money and a policy with a never-replaceable class; `approval-decision.extensionUsd` → the core message; `seal`), and the interpreter's publication effect on activity failures, `unknown` when absent (R24); the interpreter awaits each effect before the next, so `recordAttemptOutcome` completes before `releaseLease` starts (R27); `baseBranch` and `repository` (numeric forge ID, owner and name) mapped from the repository binding and checked with the core's input rules (R27, R31, R33); the workflow result's `unrecordedAttempts` passed to the run's telemetry (R29); `workers/temporal-worker` root binding the default slot; Temporal confinement fitness and the shared core-purity rule in `scripts/forbidden-imports.test.ts` | `feat(temporal): run task and run workflows on Temporal` | after S2, S6 | A2, A6, B1, B2 (shared rule), B3, B4, B6, B10, C5, C8, D3, D4, D9 (bridge part), D16 (mapping), H12 (mapping), I8, L6 (e2e) |
| S8 | Gate: digest-pinned Temporal in `run-integration.mjs` (loopback publish, version line, pull/inspect output, namespace retention read-back), omit hook, negative test, new required itest IDs; `compose.yaml` Temporal fix; `DurableLocalForge`; first real end-to-end itest; the manifest-gated replay suite, now required, with its seeded non-deterministic fixture, the first captured histories and `required-scenarios.json` | `feat(integration): provision a digest-pinned Temporal server in the mandatory gate` | after S7 | A4, B5 (staged: S8 scenarios), C1–C4, C6, C7, C10, D2, D7 (e2e), D15 (e2e), L1 |
| S9 | API routes + application use cases for executions/controls/approvals/view (incl. the run `seal` route and the decision body's `extensionUsd`, R21); principal resolver and capabilities; decision outbox + delivery relay + API chaos entry; production-root `WorkflowEngine` wiring; pilot-main and CLI dispatch via the engine; no-second-driver fitness | `feat(control-plane): drive executions, controls and approvals through the workflow engine` | after S8 | B8, B9, D1, D8, F19, G9, I2, K1–K7 |
| S10 | Chaos matrix CX-01…CX-36, except CX-25 (S11) and CX-34 (S9), with `assertConvergence` and its negative self-test; captured replay scenarios appended with their histories | `test(chaos): prove crash, duplicate-delivery and outage recovery on real backends` | after S9 (G-P2) | B5 (staged: S10 scenarios), D9 (timing), D10, D12, F1–F18, I4, L2 (recovery rows), L4 |
| S11 | Real-Temporal e2e for pause/resume/cancel (incl. mid-verification, during assurance and during the publication-approval wait, pause during both approval waits, and a cancel with a failing PR create), budgets (agent-outcome and reservation-failure tables, incl. `REPAIR` with a failed reservation), approvals, every assurance outcome and an assurance-activity failure with a scripted slot, and `REPAIR` → agent death → replacement keeping the lineage; captured replay scenarios appended | `test(orchestration): prove controls, budgets, approvals and the assurance slot on Temporal` | after S9 | B5 (staged: S11 scenarios), G1–G8, G10–G14, H1–H8, H10, H11, I1, I3, I5, I7, J1, J3–J6, J10, L2 |
| S12 | Production-shaped pre-deployment smoke: `temporalio/server` + `admin-tools` on PostgreSQL, real restart, happy path | `test(temporal): add a production-shaped pre-deployment smoke on PostgreSQL persistence` | after S8 | C9 |
| S13 | `phase-03-report.md`, `phase-03-runbook.md` (drain-only order of architecture §6.6, sealing every open run), preserved rehearsal logs, final replay corpus and manifest, docs index | `docs(phase-3): record durable-orchestration evidence and runbook` | last | A7, B5 (final: `required-scenarios.json` equals the full list), M1–M3, N1–N5 |

Each slice runs these steps:

1. Re-read the exit criteria.
2. Write tests first where sensible.
3. Make the smallest change.
4. Run the narrowest suite.
5. Run `pnpm verify:all` (+ `pnpm test:integration` from S3 on).
6. Review the diff.
7. Commit.

No `git add -A`, and no squash before the final review.

## 27. Commit plan

Fourteen slice commits (S0–S13) plus `fix(phase-3): …` repairs. Repairs cite the finding in the commit subject
only. They never put plan IDs in code, test names or migration names (project rule).

## 28. Rollback

Per-slice commits on `phase/03-durable-orchestration`. Migrations are additive (the one constraint swap in
`0100` widens the allowed set). Rolling back code leaves extra columns and tables that Phase 2 code ignores.

- **S0 is shared.** Lane B rebases onto it. Rolling it back needs the controller, because it removes a contract
  both lanes use. `0107` is dropped only by a forward migration the controller orders (data model §3.7).
- **Runtime rollback (feature off)** means: do not configure `WorkflowEngine`. The API then returns 503 for the
  execution routes. There is **no** fallback to the sequential driver, because a silent fallback would
  reintroduce a second orchestrator.
- **In-flight workflows** under a rolled-back worker build are handled with the runbook's drain-only and
  replay-failure procedures (`phase-03-runbook.md`, S13).

## 29. Exit criteria

`phase-03-exit-criteria.md`. Each MUST is numbered and mapped to the executable test (file + SUITE-ID) that
proves it.

---

## 30. Shared-surface change requests

The controller's reconciliation v1 (R1–R14) has reconciled these. Nothing below is edited until the controller
says "implement". "Owner" names the lane that implements the change. Every change is additive unless marked
**BREAKING (internal)**: an internal TypeScript signature change with no persisted or wire compatibility impact.
Items marked **[S0]** land in S0 exactly as the reconciliation specifies.

### CR-01 — `TaskStatus` extension (`packages/contracts/src/base.ts:38-40`) + `tasks.status` CHECK (R6)

```typescript
export type TaskStatus =
  | 'PENDING' | 'READY' | 'EXECUTING' | 'VERIFYING'
  | 'WAITING_FOR_HUMAN_REVIEW' | 'FAILED' | 'BLOCKED' | 'CANCELLED'
  | 'PAUSED' | 'WAITING_FOR_APPROVAL' | 'BUDGET_EXHAUSTED';
```

Compat: hand-authored type (not a JSON Schema), so there is no schema version impact. Lane A owns the
`tasks.status` CHECK and migrates it in `0100` (data model §3.0). Lane B owns `AttemptStatus` and the
`attempts.status` CHECK in `02xx`. Neither lane touches the other's constraint. v1's note that predicted Lane B
task statuses is withdrawn. Domain transitions: data model §4.1. Owner: Lane A (S1, S3).

### CR-02 — New canonical schemas (`packages/contracts/schema/`)

`task-workflow-input.schema.json`, `run-workflow-input.schema.json`, `workflow-control.schema.json`. Each is at
`version 1.0.0` with `$id https://asep.dev/schema/<name>/v1`. Each comes with fixtures (valid + invalid),
templates where the repo pattern needs them, `snapshots/v1/` entries, generated TS types, AJV validators and
compat/drift coverage. Field lists: data model §4.2, including the v4 fields (R21): `run-workflow-input.fixedTasks`,
the `seal` control kind, `approval-decision.extensionUsd` and `policy.agentKillGraceSeconds`. All string fields are
constrained (`pattern`, `enum` or `format`). Money exactness is checked by the S7 mapping, not by `multipleOf`.

Compat: new `$id`s, so no existing schema is affected. Lane A raises the compat-gate schema count and
`COMPATIBILITY.md` by its three schemas. The cross-lane total comes out of the merge and is not hard-coded here
(R7). Owner: Lane A (S1).

### CR-03 — `run-event` 1.1.0 → 1.2.0 (MINOR) **[S0]** (R5)

One superset bump containing Lane A's fields (data model §4.3) and Lane B's SR-C5 fields as locked. Snapshot
`v1` is retained. `packages/contracts/src/run-event-catalog.ts` and the metrics-dictionary validator are updated
in lockstep. Neither lane bumps `run-event` again in Phase 3/4 without a new reconciliation. Owner: Lane A (S0).

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
  /** Workflow time at scheduling (ISO-8601). Identical on every redelivery of this execution. */
  readonly logicalNow: string;
  /** Liveness + checkpoint. Must not carry secrets, source or prompts. */
  heartbeat(progress: ActivityProgress): void;
}
```

Lane A only. Lane B's code receives Phase 4's `AssuranceStepContext` instead, which Lane A's adapter builds from
this context (architecture §12). Owner: Lane A (S1).

### CR-05 — Fencing and result binding: dependency on the Phase 2 primitive (R1, R2)

**v1's `AttemptFence`, `FencingToken`, epoch columns and the `fencingEpoch`/`resultRef?: unknown` changes to
`SideEffectLog` are withdrawn** (P3-PLAN-CRIT-001, P3-PLAN-HIGH-001). Lane A defines no fencing signature.
After the rebase, Lane A uses the accepted Phase 2 lease-bound fenced takeover (Phase 2 HIGH-006) and the typed
result binding (Phase 2 HIGH-005) as they land. It requires these invariants (architecture §7.1, §7.4):

- **F1.** A claim checks, in the same transaction, that the lease is `ACTIVE`, unexpired, held by the
  claimant's lease id and at the current lease epoch.
- **F2.** A zombie that lost its lease can never claim, complete, fail or reopen a record.
- **F3.** Takeover of a `PENDING` record is atomic and audited, and the new holder reconciles by natural key
  before any external call.
- **F4.** Completed records carry the closed, validated, DB-coherent result shape. No `resultRef?: unknown`.
- **F5.** A legitimate successor can always reach a terminal state, so there is no wedge.
- **L1.** Renewal extends expiry while `ACTIVE` and reports the lease lost otherwise.
- **L2.** A crash right after the lease insert does not wedge the same attempt's next delivery. At `d6ee686` the
  same attempt cannot re-acquire while its lease is live (one active writer per binding and branch), so the next
  delivery settles the grant through R29's `findLease`, which returns its fence (§1.4 P2-3).
- **L3.** The lease epoch, or its equivalent, is visible to the activity.
- **`FAILED` lifecycle** (P3-PLAN-HIGH-002). Amended at the rebase (§1.4 P2-3): Phase 2 never reopens a `FAILED`
  record (`confirmOwner` acts only on a `PENDING` one), which is stricter than the reopen-after-reconciliation this
  line required. A Phase 3 activity that finds its publication record `FAILED` reports the effect `unknown`, and the
  core reconciles the remote before any terminal state (R24). An ambiguous transport outcome stays `PENDING`.

If the accepted primitive lacks any of these, Lane A files the minimal generalisation as a change request
against the Phase 2 primitive. It does not build a parallel design. At `d6ee686` it lacks none: F1–F5, L1 and L3
hold, L2 holds through `findLease`, and R28 obligation 5 is a transaction of Lane A's composition around Phase 2's
`acquire`, not a change to it (§1.4 P2-3). The block's `AssuranceFence` is the lease's `{ leaseId, fencingEpoch }`. The Phase 2 lease-handoff test
(`side-effect-log.test.ts:255`) is changed only by the Phase 2 repair. Owner: Phase 2 (Lane R); Lane A proves
the invariants (S3, S6, S10).

### CR-06 — (withdrawn; merged into CR-05)

v1's lease `renew`/adopt API is withdrawn as an independent design (R1). Its needs are invariants L1–L3 in
CR-05.

### CR-07 — Restart-safe workspaces and commit CAS

```typescript
export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly leaseId: string;
  readonly hostId: string;
  readonly pathRel: string;                       // validated segments only; never absolute
  readonly baseSha: string;                       // task base, or repairBaseSha for a repair attempt
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
   *  baseSha is the task base, or repairBaseSha for a repair attempt; a missing commit object is non-retryable. */
  create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; baseSha: string; leaseId: string; attemptId: AttemptId;
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

v1's `seedDiffRef` is withdrawn (R3). Owner: Lane A (S1 types, S4 implementation).

Amended at S1 (on the accepted Phase 2): the `GitCommitter` lines above were written at `00a6889`. At `d6ee686`,
`commit` already takes `attemptId` and `baseSha`, refuses unless the workspace HEAD is `baseSha`
(`adapters/git-worktree/src/worktree-manager.ts:268-270`) and moves HEAD with a compare-and-swap from `baseSha`
(`:308`), and `reconcile` needs no workspace, so a successor that never held the dead executor's worktree can
reconcile. `expectedHeadSha` is therefore Phase 2's `baseSha`: S1 changes neither method, and S4 proves the HEAD
compare-and-swap on the accepted adapter. S1 lands `WorkspaceRecord`, `WorkspaceRegistry`,
`WorkspaceUnavailableError` (with a closed `reason`: `other-host`, `missing`, `quarantined`) and the `attemptId` of
`WorkspaceManager.create`.

### CR-08 — Container reaping

```typescript
export interface ExecutionReaper {
  /** Force-remove every container labelled asep.attempt=<attemptId> (optionally one role). Idempotent. */
  reap(scope: TenantScope, input: { readonly attemptId: AttemptId; readonly role?: 'agent' | 'verify' }): Promise<{ readonly removed: number }>;
}
```

Adapter changes (CR-20): none for names and labels. Amended at the rebase (§1.4 P2-7): Phase 2 already labels
every agent, egress-proxy and verification container and the agent network with `asep.attempt=<attemptId>` and
`asep.role`, and names them with a random suffix, so `reap` finds them by label, never by a deterministic name.
`asep.org` and `asep.project` are not added. Owner: Lane A (S1 type, S4 implementation).

### CR-09 — `WorkflowEngine` v2 (replaces the unused shape at `packages/ports/src/index.ts:79-86`)

```typescript
import type { TaskWorkflowInput, RunWorkflowInput, WorkflowControlMessage } from '@asep/contracts'; // generated (CR-02)

export type ApprovalKind = 'budget-extension' | 'publish-change';
export type TaskWorkflowPhase =
  | 'ADMITTING' | 'BUDGET_CHECK' | 'ATTEMPT_STARTING' | 'AGENT_RUNNING' | 'INSPECTING' | 'VERIFYING'
  | 'COMMITTING' | 'EVIDENCE' | 'ASSURANCE_ROUND' | 'PUBLICATION_GATE' | 'AWAITING_APPROVAL' | 'PUBLISHING'
  | 'REVIEW_HANDOFF' | 'ATTEMPT_ABANDONED' | 'ATTEMPT_EXHAUSTED' | 'PAUSED' | 'CANCELLING' | 'CLEANUP' | 'CLOSED';

export interface WorkflowStartReceipt {
  readonly workflowId: string;
  readonly alreadyStarted: boolean;
}
export interface WorkflowControlReceipt {
  readonly accepted: boolean;
  readonly reason?: 'already-paused' | 'not-paused' | 'closed' | 'unknown-approval'
    | 'decision-conflict' | 'approval-expired' | 'duplicate' | 'already-sealed' | 'run-sealed';
}
export interface TaskWorkflowView {
  readonly workflowId: string;
  readonly phase: TaskWorkflowPhase;
  readonly paused: boolean;
  readonly closed: boolean;
  readonly attemptNumber: number;
  readonly assuranceRound: number;
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
  /** pause | resume | seal (run only) | approval-decision; Update id = message.requestId. */
  control(scope: TenantScope, message: WorkflowControlMessage): Promise<WorkflowControlReceipt>;
  /** Durable cancellation of a task or run workflow; idempotent. No free text crosses into history. */
  cancel(scope: TenantScope, input: {
    readonly target: { readonly scope: 'task' | 'run'; readonly id: string };
    readonly requestId: string; readonly principalId: string;
  }): Promise<WorkflowControlReceipt>;
  describeTask(scope: TenantScope, taskId: TaskId): Promise<TaskWorkflowView | null>;
  isClosed(scope: TenantScope, workflowId: string): Promise<boolean>;
}
```

Owner: Lane A (S1 types, S7 implementation).

### CR-10 — Review-loop slot contract **[S0]** (R3; replaces v1's `ReviewLoopPort`)

v1's `ReviewLoopPort`, `ReviewLoopTrigger`, `ReviewLoopRequest`, `ReviewLoopDecision`,
`ReviewLoopUnavailableError` and the `AgentExecuteRequest.repairOrderRef` field are **withdrawn**
(P3-PLAN-HIGH-004).

**Location (R16).** The slot, Lane B's `DisabledAssuranceSlot` and the conformance kit live in
`packages/application/src/review-loop/`, not in `packages/ports`: the slot returns `AdmissionResult` from
`@asep/application`, and ports must not depend on application. Lane A still lands the files in S0.

#### Review-loop slot contract (verbatim for S0)

The controller handed over the block locked at Lane B's `287ed0f` (R39): 894 lines, sha256
`9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a`, the file
`slot-block-287ed0f.ts`. The fence below holds exactly those bytes. S0 lands them in
`packages/application/src/review-loop/` as three files, one per banner: `slot.ts` is its first section unchanged;
`disabled-slot.ts` and `review-loop-contract.ts` carry their sections unchanged except for the imports before the
banner, and each `export declare function` turned into the same signature with a one-statement body that calls the
implementation after the line `// === end of the locked slot block text ===`. The suite
`asep-suite:assurance-slot-contract` reassembles the block from the three files, undoing exactly those two edits,
and checks this sha256 against the files and against this fence.

```typescript
// ===========================================================================
// packages/application/src/review-loop/slot.ts                     (S0; review-loop/v1)
// ===========================================================================
// The review-loop slot: one assurance round after evidence is persisted and before
// push. Framework-free: no orchestration SDK, no wall-clock reads, no process
// environment.
//
// Envelope. Every input and output is plain JSON, recursively: null, a string, a
// boolean, a finite number, an array or a plain object of those; no undefined keys or
// values, non-finite numbers, -0, functions, bigint, symbols, Dates, Maps, Sets or class
// instances. No method returns undefined. reviewLoopPayloadBytes checks this before it
// measures, and every payload is at most REVIEW_LOOP_MAX_PAYLOAD_BYTES when serialized.
// A ContextPack, a packet, a check report, a review record, a repair order, a PR section
// and any list that grows with the change travel by ArtifactRef, never inline.
//
// Money. Every money field is named *MicroUsd and holds integer micro-USD: a non-negative
// safe integer, or null meaning unknown. reviewLoopPayloadBytes rejects any other value
// under such a key. A provider's decimal USD is converted once, in the adapter that
// receives it, rounding up (ceiling), so no overrun is rounded away; the slot never
// carries floating USD, and USD for display is rendered outside it.
//
// Time. AssuranceStepContext.now() is one fixed logical time per activity execution,
// identical on every retry of that execution. Every timestamp an implementation
// writes (row columns, run events) comes from it, so a redelivery writes
// byte-identical records and events. Content-addressed artifacts (packet, check
// report, review record, adjudication record, repair order) carry no timestamp, so
// their ids and the round's outcome do not depend on which execution produced them.
//
// The assurance service implements ReviewLoopSlot; the orchestration workflow composes
// it and wraps each call as an activity. Changing this file after S0 needs a new
// controller reconciliation.

import type {
  ArtifactRef,
  AttemptId,
  RepositoryBindingId,
  RiskLevel,
  RunId,
  TaskId,
  TenantScope,
} from '@asep/contracts';
import type { WorkspaceCapability } from '@asep/ports';
import type { AdmissionResult } from '../risk-admission.js';

export const REVIEW_LOOP_SLOT_VERSION = 'review-loop/v1' as const;
export type ReviewLoopSlotVersion = typeof REVIEW_LOOP_SLOT_VERSION;

/** Explicit literal a composition must pass to opt out of independent assurance (Phase 2 behaviour). */
export const REVIEW_LOOP_DISABLED = 'review-loop-disabled-phase2-behaviour' as const;

/** Largest serialized size of any slot input or output, in UTF-8 bytes of JSON.stringify(value). */
export const REVIEW_LOOP_MAX_PAYLOAD_BYTES = 65_536;

// --- delivery context ---------------------------------------------------------

export type AssuranceStepName =
  | 'plan'
  | 'packet'
  | 'checks'
  | 'reviewer'
  | 'adjudicate'
  | 'attempt-outcome'
  | 'repair-context';

/** Liveness detail. Never carries source text, prompts, finding text, model output or secrets. */
export interface AssuranceHeartbeat {
  readonly step: AssuranceStepName;
  readonly reviewerConfigId?: string;
  /** At most 200 characters. */
  readonly note?: string;
}

/**
 * Engine-neutral context for one delivery of one step. The orchestration adapter builds
 * it from its own activity context and the logical time carried in the activity input;
 * the sequential driver builds it from an AbortController and an injected clock.
 */
export interface AssuranceStepContext {
  readonly signal: AbortSignal;
  /**
   * ISO-8601 UTC timestamp: one fixed logical time per activity execution, identical on
   * every retry of that execution and not advancing within it. Steps take every
   * timestamp from it and never read the wall clock (see the file header).
   */
  now(): string;
  /** Called at least every 30 seconds while a step is working. */
  heartbeat(details: AssuranceHeartbeat): void;
}

// --- caller identity and fencing ----------------------------------------------

/**
 * The caller's workspace-lease identity, exactly as the caller presents it. Every claim,
 * completion and decision write the implementation makes, the writes of
 * recordAttemptOutcome and buildRepairContextPack included, checks in the same
 * transaction that this lease is ACTIVE, is held by `leaseId`, and is at `fencingEpoch`
 * (the Phase 2 fenced-takeover primitive). An implementation never substitutes the
 * epoch it reads from its own store for the caller's. A caller whose lease was taken
 * over or ended gets AssuranceFencedError and changes nothing.
 */
export interface AssuranceFence {
  readonly leaseId: string;
  /** Integer >= 1: the fencing epoch the accepted Phase 2 primitive assigned to this lease holder. */
  readonly fencingEpoch: number;
}

// --- workspace resolution -------------------------------------------------------

export interface AssuranceWorkspaceQuery {
  readonly attemptId: AttemptId;
  readonly leaseId: string;
  readonly fencingEpoch: number;
}

/** Checked in this order; the first failing check is reported. */
export type AssuranceWorkspaceRefusal = 'not-in-scope' | 'lease-not-active' | 'lease-not-held' | 'stale-epoch';

export type AssuranceWorkspaceResolution =
  | { readonly kind: 'resolved'; readonly workspace: WorkspaceCapability }
  | { readonly kind: 'refused'; readonly reason: AssuranceWorkspaceRefusal };

/**
 * The only way an assurance step obtains the attempt's workspace for trusted reads (range
 * diffs and post-images). Framework-free and read-only; the orchestration lane implements
 * it over the workspace-lease table, and a workspace never comes from activity-local
 * memory. It checks that the attempt belongs to `scope` ('not-in-scope', which reveals
 * nothing about other tenants), and that the attempt's workspace lease is ACTIVE, is held
 * by `leaseId` and is at `fencingEpoch`. The slot maps 'not-in-scope' to
 * ReviewLoopContractError and every other refusal to AssuranceFencedError, before any
 * repository read.
 */
export interface AssuranceWorkspaceResolver {
  resolve(scope: TenantScope, query: AssuranceWorkspaceQuery): Promise<AssuranceWorkspaceResolution>;
}

// --- vocabulary ------------------------------------------------------------------

export type ReviewMode = 'not-required' | 'shadow' | 'gating';
export type ReviewKind = 'fresh' | 're-review';
export type ReviewerRole = 'primary' | 'comparator';
export type FindingSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type EscalationReason =
  | 'packet-over-budget'
  | 'egress-stopped'
  | 'independence-unsatisfiable'
  | 'reviewer-unavailable'
  | 'reviewer-escalated'
  | 'max-repair-rounds'
  | 'budget-exhausted';

export type BlockReason = 'secret-in-diff' | 'forbidden-path' | 'unscannable-sensitive-change';

export type EgressDecision = 'CLEAR' | 'STOP_SECRET' | 'STOP_CLASSIFIED' | 'STOP_UNSCANNABLE';

/**
 * Reasons recorded in the packet's budget.omissions list. 'unsafe-path': the path is not a
 * normalized repository path (a control or line-separator character, an unresolved Git
 * quoted form); it is never read, and the push guard blocks the round.
 */
export type PacketOmissionReason = 'binary' | 'too-large' | 'deleted' | 'submodule' | 'non-utf8' | 'unsafe-path';

// --- round input -------------------------------------------------------------------

export interface AssuranceSlotInput {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** `${attemptId}:assurance:${round}`. A retry with the same key converges to the same outcome. */
  readonly idempotencyKey: string;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly risk: RiskLevel;
  /** 1 for the task's first attempt; +1 for each repair attempt. */
  readonly round: number;
  /** Persisted EvidenceBundle of this attempt; its resultSha is the harness commit. */
  readonly evidenceRef: ArtifactRef;
  readonly workOrderRef: ArtifactRef;
  /** 40 lowercase hex. Origin of the cumulative diff (the task's pinned base). */
  readonly taskBaseSha: string;
  /** 40 lowercase hex. The harness commit of this attempt; equals the evidence resultSha. */
  readonly resultSha: string;
  readonly implementer: { readonly providerId: string; readonly model: string };
  /** AgentAttemptObservation.status === 'AGENT_DONE'. */
  readonly declaredComplete: boolean;
  /** Non-null iff round > 1: the adjudication that requested this repair. */
  readonly priorAdjudicationId: string | null;
  readonly fence: AssuranceFence;
  /**
   * Remaining task budget; reviewer calls stop (budget-exhausted) rather than exceed it.
   * costMicroUsd: integer micro-USD, null when unknown.
   */
  readonly budgetRemaining: { readonly costMicroUsd: number | null; readonly wallClockMs: number };
}

// --- step contracts ------------------------------------------------------------------

export interface PlannedReviewer {
  readonly reviewerConfigId: string;
  readonly role: ReviewerRole;
  readonly model: string;
  /** Resolved by policy from the model id; never self-declared by a provider. */
  readonly family: string;
}

export interface AssurancePlan {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** Equals input.idempotencyKey. */
  readonly roundKey: string;
  readonly mode: ReviewMode;
  readonly reviewKind: ReviewKind;
  /** Empty when mode is 'not-required'. */
  readonly reviewers: readonly PlannedReviewer[];
  readonly maxRounds: number;
  readonly blockingSeverities: readonly FindingSeverity[];
  readonly packetBudgetBytes: number;
  /** Review-policy version plus its sha256. */
  readonly policyVersion: string;
  /** Set when the policy cannot be met (for example no eligible independent reviewer). */
  readonly unsatisfiable: EscalationReason | null;
}

export interface BuildReviewPacketInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
}

export interface BuildReviewPacketOutput {
  /** Canonical review-packet/v1 bytes; the omission list lives inside it (budget.omissions). */
  readonly packetRef: ArtifactRef;
  readonly packetSha256: string;
  /**
   * UTF-8 length of the stored canonical packet bytes, measured after budget.overBudget is
   * set, for accepted and rejected packets alike, plus every content part the prompt embeds
   * (cumulative diff, repair delta, post-images). Recorded here and with the round, never
   * inside the hashed packet.
   */
  readonly includedBytes: number;
  /**
   * The packet as it would be sent (carrying overBudget false) plus its embedded parts
   * exceeds plan.packetBudgetBytes, or a diff did not fit its reader limit. Such a packet is
   * never rendered or sent; content is never cut to fit. When false, includedBytes is at
   * most plan.packetBudgetBytes.
   */
  readonly overBudget: boolean;
  /** Number of changed files whose content the packet omits, for any reason. */
  readonly omittedFiles: number;
}

export interface DeterministicCheckInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
  readonly packetRef: ArtifactRef;
}

export interface DeterministicCheckOutput {
  /** Every deterministic and SARIF finding; raw check output is persisted first. */
  readonly checkReportRef: ArtifactRef;
  /** Secret in added lines, forbidden path, or unscannable change at a sensitive path. */
  readonly pushGuard:
    | { readonly decision: 'PASS' }
    | { readonly decision: 'BLOCK'; readonly reason: BlockReason };
  /** Decision over the exact packet bytes. Only CLEAR permits any reviewer request. */
  readonly egress: { readonly decision: EgressDecision; readonly packetSha256: string };
  readonly findings: { readonly total: number; readonly blocking: number };
}

export interface RunReviewerInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
  readonly packetRef: ArtifactRef;
  /** Must carry egress CLEAR for this packet's sha256, otherwise no request is sent. */
  readonly checkReportRef: ArtifactRef;
  readonly reviewerConfigId: string;
}

export type ReviewRecordStatus =
  /** The provider completed; the output validated against the schema and was grounded. */
  | 'COMPLETED_VALID'
  /** The provider completed; the output failed validation. */
  | 'COMPLETED_INVALID'
  /** Provider error, refusal, incomplete output, budget, cancellation, served-model drift or an oversized prompt. */
  | 'FAILED'
  /** No request was sent: the egress decision was not CLEAR or the request bytes failed the re-scan. */
  | 'EGRESS_STOPPED'
  /** No request was sent: the push guard blocked the round. */
  | 'SKIPPED_PUSH_GUARD';

export interface RunReviewerOutputFields {
  /**
   * sha256 of the canonical JSON array [attemptId, round, reviewerConfigId, packetSha256],
   * 64 lowercase hex.
   */
  readonly reviewId: string;
  /** True when a terminal record from an earlier delivery was adopted instead of calling again. */
  readonly adopted: boolean;
}

/** The provider completed: the canonical review-record/v1, valid or not, is persisted. */
export interface CompletedReviewerOutput extends RunReviewerOutputFields {
  readonly status: 'COMPLETED_VALID' | 'COMPLETED_INVALID';
  readonly reviewRecordRef: ArtifactRef;
  /** Provider requests sent for this reviewId across all deliveries; at least 1. */
  readonly providerCalls: number;
}

/** The call failed (provider error, refusal, budget, cancellation, drift, an oversized prompt): no review record. */
export interface FailedReviewerOutput extends RunReviewerOutputFields {
  readonly status: 'FAILED';
  readonly reviewRecordRef: null;
  /** Provider requests sent for this reviewId across all deliveries; 0 when none was sent. */
  readonly providerCalls: number;
}

/** No request was ever sent: egress stopped it or the push guard blocked the round. */
export interface NotSentReviewerOutput extends RunReviewerOutputFields {
  readonly status: 'EGRESS_STOPPED' | 'SKIPPED_PUSH_GUARD';
  readonly reviewRecordRef: null;
  readonly providerCalls: 0;
}

export type RunReviewerOutput = CompletedReviewerOutput | FailedReviewerOutput | NotSentReviewerOutput;

export interface AdjudicateInput {
  readonly slot: AssuranceSlotInput;
  readonly plan: AssurancePlan;
  readonly packetRef: ArtifactRef;
  readonly checkReportRef: ArtifactRef;
  /** Exactly the reviewIds of plan.reviewers, in plan order. */
  readonly reviewIds: readonly string[];
}

// --- round outcome ---------------------------------------------------------------------

export interface AssuranceUsage {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Integer micro-USD: each call's tokens × configured price, converted once with ceiling,
   * then summed. Null when any call in the round has no configured price; never estimated.
   */
  readonly reviewCostMicroUsd: number | null;
}

/** What gating mode would have decided. Recorded only; it never changes the workflow. */
export interface ShadowVerdict {
  readonly wouldBe: 'PROCEED' | 'REPAIR' | 'ESCALATE';
  readonly reason: EscalationReason | 'blocking-findings' | null;
  readonly blockingFindings: number;
}

export interface AssuranceOutcomeBase {
  readonly slotVersion: ReviewLoopSlotVersion;
  /** Equals input.idempotencyKey. */
  readonly roundKey: string;
  /** 64 lowercase hex: sha256 of a canonical JSON array of the round's inputs. */
  readonly adjudicationId: string;
  readonly usage: AssuranceUsage;
}

export interface ProceedOutcomeFields extends AssuranceOutcomeBase {
  readonly kind: 'PROCEED';
  /** Assurance section for the PR body; null when there is nothing to show. */
  readonly prBodySectionRef: ArtifactRef | null;
}

/** Shadow mode: the round proceeds and records what gating would have decided. */
export interface ShadowProceedOutcome extends ProceedOutcomeFields {
  readonly mode: 'shadow';
  /** PROCEED in shadow mode is the only outcome that carries a shadow verdict. */
  readonly shadow: ShadowVerdict;
}

/** Gating or not-required mode: the round proceeds on its own decision. */
export interface DecidedProceedOutcome extends ProceedOutcomeFields {
  readonly mode: 'gating' | 'not-required';
  readonly shadow: null;
}

export type ProceedOutcome = ShadowProceedOutcome | DecidedProceedOutcome;

/** Gating mode only. The orchestrator starts a repair attempt with a fresh workspace at repairBaseSha. */
export interface RepairOutcome extends AssuranceOutcomeBase {
  readonly kind: 'REPAIR';
  readonly mode: 'gating';
  readonly repairOrderRef: ArtifactRef;
  /** Equals input.round + 1. */
  readonly nextRound: number;
  /** Equals input.resultSha. */
  readonly repairBaseSha: string;
}

/** Gating mode only. The orchestrator pushes, opens the PR flagged, and stops at human review. */
export interface EscalateOutcome extends AssuranceOutcomeBase {
  readonly kind: 'ESCALATE';
  readonly mode: 'gating';
  readonly reason: EscalationReason;
  readonly prBodySectionRef: ArtifactRef;
}

/**
 * Any mode: the deterministic push guard. The orchestrator does not push; the task ends
 * BLOCKED. It carries no shadow verdict in any mode: the push guard is not a gating
 * decision, so a blocked round has no would-be outcome.
 */
export interface BlockOutcome extends AssuranceOutcomeBase {
  readonly kind: 'BLOCK';
  readonly mode: ReviewMode;
  readonly reason: BlockReason;
  readonly prBodySectionRef: ArtifactRef | null;
}

export type AssuranceOutcome = ProceedOutcome | RepairOutcome | EscalateOutcome | BlockOutcome;

// --- attempt terminal telemetry ----------------------------------------------------------

export type AttemptTerminal =
  | 'verification-stopped'
  | 'proceeded'
  | 'repair-requested'
  | 'escalated'
  | 'blocked'
  | 'agent-failed'
  | 'budget-exhausted'
  | 'cancelled'
  | 'infrastructure-failed';

/**
 * The only terminals an attempt that never held a workspace lease can end with: it was
 * cancelled, or infrastructure failed, after registration and before any lease. Lane A
 * confirms this list against every path of its core where an attempt is registered and
 * never leased; a terminal outside it goes back to the controller.
 */
export const PRE_LEASE_ATTEMPT_TERMINALS = ['cancelled', 'infrastructure-failed'] as const;
export type PreLeaseAttemptTerminal = (typeof PRE_LEASE_ATTEMPT_TERMINALS)[number];

export interface AttemptOutcomeFields {
  readonly slotVersion: ReviewLoopSlotVersion;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly risk: RiskLevel;
  readonly round: number;
  readonly declaredComplete: boolean;
  /** Null when verification never ran. */
  readonly verificationVerdict: 'PASS' | 'FAIL' | 'ERROR' | null;
  /** Null when no assurance round completed for this attempt. */
  readonly adjudicationId: string | null;
  /**
   * True only when the assurance activity failed after its retry policy, or
   * non-retryably: the orchestrator audited 'assurance-unavailable' and continued as
   * PROCEED (shadow) or ESCALATE (gating), so terminal is 'proceeded' or 'escalated' and
   * adjudicationId is null. Never true at a verification stop.
   */
  readonly assuranceUnavailable: boolean;
  /** Failure taxonomy class id (for example 'artifact-loss'); null on success. */
  readonly failureClass: string | null;
  readonly cost: {
    /** Integer micro-USD, null when unknown. */
    readonly modelCostMicroUsd: number | null;
    /** Integer micro-USD, null when unknown. */
    readonly computeCostMicroUsd: number | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
  } | null;
}

/**
 * The terminal of an attempt that holds (or held) its workspace lease. `fence` is the
 * caller's fence on that lease as the caller holds it at the terminal; the outcome is
 * recorded before the lease is released. After a release or a takeover the call fails
 * AssuranceFencedError and the current holder (if any) records the terminal.
 */
export interface LeasedAttemptOutcomeInput extends AttemptOutcomeFields {
  readonly terminal: AttemptTerminal;
  readonly fence: AssuranceFence;
}

/**
 * The terminal of an attempt that never held a workspace lease, recorded with fence null
 * (R28). Obligations, each proved by the conformance kit (RLC-16…RLC-19):
 *  1. the composition registers the attempt before any attempt-bound effect;
 *  2. the write transaction checks the tenant and locks the same attempt row that lease
 *     acquisition locks;
 *  3. fence null is accepted only when durable history shows the attempt never had a
 *     lease, not merely that no lease is ACTIVE now;
 *  4. the terminal is in PRE_LEASE_ATTEMPT_TERMINALS;
 *  5. lease acquisition refuses an attempt that already has a terminal, under that lock;
 *  6. the terminal, its idempotency record and its events commit atomically;
 *  7. an attempt that ever held a lease must present its caller fence (LeasedAttemptOutcomeInput);
 *  8. buildRepairContextPack always requires a fence.
 * A write refused under obligation 3 throws ReviewLoopContractError 'lease-granted', never
 * AssuranceFencedError: a grant that committed late is not a supersession. The workflow then
 * looks the lease up and records the same terminal with that lease's fence, at most two
 * lookups (R29). The single exception to "every terminal is recorded" is a store that cannot
 * be read or written after the retry policy (a failed lookup, or a failed pre-lease terminal
 * write): the task ends FAILED / attempt-state-unknown, its audit entry carries the attempt's
 * idempotency key, and telemetry completeness reports the attempt as a gap with that key
 * (R29, R32).
 */
export interface PreLeaseAttemptOutcomeInput extends AttemptOutcomeFields {
  readonly terminal: PreLeaseAttemptTerminal;
  readonly fence: null;
}

export type AttemptOutcomeInput = LeasedAttemptOutcomeInput | PreLeaseAttemptOutcomeInput;

// --- admission and repair helpers ----------------------------------------------------------

export interface AssuranceCapability {
  readonly reviewerEnabled: boolean;
  /**
   * Reviewer configurations holding a valid gating promotion. Promotion is deferred out of
   * Phase 4: every Phase 4 composition passes [].
   */
  readonly promotedReviewerConfigIds: readonly string[];
}

export interface RepairContextInput {
  readonly slotVersion: ReviewLoopSlotVersion;
  readonly scope: TenantScope;
  /** The repair attempt being prepared. */
  readonly attemptId: AttemptId;
  /** The task's original context-pack/v1 artifact; the pack itself never travels inline. */
  readonly originalContextPackRef: ArtifactRef;
  readonly repairOrderRef: ArtifactRef;
  /**
   * The caller's fence on the repair attempt's workspace lease, acquired on the fresh
   * workspace at repairBaseSha before this call. Always required; never null.
   */
  readonly fence: AssuranceFence;
}

export interface RepairContextOutput {
  /**
   * context-pack/v1 with its hash recomputed, persisted before return. Its generatedAt is
   * the decision time of the persisted REPAIR adjudication, so every execution derives the
   * same bytes.
   */
  readonly contextPackRef: ArtifactRef;
}

// --- the slot ---------------------------------------------------------------------------------

export interface ReviewLoopSlot {
  readonly slotVersion: ReviewLoopSlotVersion;

  /** One full round: plan, packet, checks, reviewers, adjudication. May be wrapped as one activity. */
  runAssuranceRound(input: AssuranceSlotInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome>;

  /** The same round as individual idempotent steps, for activity-granular composition. */
  planAssurance(input: AssuranceSlotInput): AssurancePlan;
  buildReviewPacket(input: BuildReviewPacketInput, ctx: AssuranceStepContext): Promise<BuildReviewPacketOutput>;
  runDeterministicChecks(input: DeterministicCheckInput, ctx: AssuranceStepContext): Promise<DeterministicCheckOutput>;
  runReviewer(input: RunReviewerInput, ctx: AssuranceStepContext): Promise<RunReviewerOutput>;
  adjudicateRound(input: AdjudicateInput, ctx: AssuranceStepContext): Promise<AssuranceOutcome>;

  /**
   * Called at every attempt terminal, verification stops included; every terminal is
   * recorded, with the one exception stated on PreLeaseAttemptOutcomeInput. A leased attempt
   * is recorded with its caller fence before the lease is released; an attempt that never
   * held a lease with fence null (PreLeaseAttemptOutcomeInput). Resolves null. Keyed by
   * attemptId: a redelivery whose input equals the recorded one, fence aside, writes nothing
   * and resolves null; any other input for a recorded attempt throws ReviewLoopContractError
   * 'conflicting-redelivery' and writes nothing. The fence, or for fence null the attempt's
   * never-leased history ('lease-granted' if a lease ever existed), is checked before the
   * comparison.
   */
  recordAttemptOutcome(input: AttemptOutcomeInput, ctx: AssuranceStepContext): Promise<null>;

  /** Admission through the optional `admit` hook on GovernedExecutionInput. Pure. */
  admitWithAssurance(risk: RiskLevel, capability: AssuranceCapability): AdmissionResult;

  /**
   * ContextPack for a repair attempt whose workspace is created at the REPAIR outcome's
   * repairBaseSha, called with that attempt's lease held. Keyed by attemptId: a redelivery
   * whose input equals the recorded one, fence aside, returns the stored output and writes
   * nothing; any other input for that attempt throws ReviewLoopContractError
   * 'conflicting-redelivery' and writes nothing. The fence is checked before the comparison.
   */
  buildRepairContextPack(input: RepairContextInput, ctx: AssuranceStepContext): Promise<RepairContextOutput>;
}

// --- errors -----------------------------------------------------------------------------------
// Any other thrown error is transient and safe to retry with the same input.

export type ReviewLoopContractErrorCode =
  /** A payload is not plain JSON or is larger than the envelope. */
  | 'invalid-payload'
  /** A well-formed payload that breaks a rule of this contract (slot version, round lineage, a disabled helper). */
  | 'invalid-input'
  /** The scope does not own the referenced run, task or attempt; reveals nothing about other tenants. */
  | 'not-in-scope'
  /** A redelivery for a recorded attempt whose input differs from the recorded one. */
  | 'conflicting-redelivery'
  /**
   * A fence-null terminal refused because the attempt's durable history shows a lease: a
   * grant committed late. Not a supersession: the workflow looks the lease up and records the
   * terminal with its fence (R29).
   */
  | 'lease-granted'
  /** An output that violates this contract (a defect of the implementation itself). */
  | 'invalid-output';

/** Non-retryable, whatever the code; the code tells the caller which rule failed. */
export class ReviewLoopContractError extends Error {
  readonly code: ReviewLoopContractErrorCode;
  constructor(code: ReviewLoopContractErrorCode, message: string) {
    super(message);
    this.name = 'ReviewLoopContractError';
    this.code = code;
  }
}

/** The caller's lease is no longer current at the given epoch, or has ended. Non-retryable for this delivery. */
export class AssuranceFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssuranceFencedError';
  }
}

/** ctx.signal was aborted. Retryable by the engine. */
export class AssuranceCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssuranceCancelledError';
  }
}

// --- envelope -------------------------------------------------------------------------------------

/** Money at the seam: null (unknown) or a non-negative safe integer number of micro-USD. */
function isMicroUsd(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/**
 * Where `value` first stops being plain JSON, or null when all of it is. Plain JSON is
 * null, a string, a boolean, a finite number other than -0, an array without holes or
 * extra keys, or an object whose prototype is Object.prototype or null and whose own
 * keys are all enumerable string-keyed data properties; values are plain JSON in turn.
 * A value shared by two keys is allowed; a cycle is not. A value under an object key that
 * ends in MicroUsd must also be null or a non-negative safe integer (file header).
 */
function plainJsonViolation(value: unknown, path: string, ancestors: Set<object>): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return `${path} is -0`;
    return Number.isFinite(value) ? null : `${path} is ${String(value)}`;
  }
  if (typeof value !== 'object') return `${path} is ${typeof value}`;
  if (ancestors.has(value)) return `${path} is circular`;
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return `${path} is not a plain object or array`;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return `${path} has a symbol key`;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => !(isArray && key === 'length'));
  if (isArray && keys.some((key, index) => key !== String(index))) return `${path} has holes or non-index keys`;
  if (isArray && keys.length !== (value as readonly unknown[]).length) return `${path} has holes or non-index keys`;
  ancestors.add(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    const at = isArray ? `${path}[${key}]` : `${path}.${key}`;
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return `${at} is not an enumerable data property`;
    }
    const found = plainJsonViolation(descriptor.value, at, ancestors);
    if (found !== null) return found;
    if (!isArray && key.endsWith('MicroUsd') && !isMicroUsd(descriptor.value)) {
      return `${at} is not integer micro-USD (null or a non-negative safe integer)`;
    }
  }
  ancestors.delete(value);
  return null;
}

/**
 * Serialized size of a slot payload: UTF-8 bytes of JSON.stringify(value), measured only
 * after the whole payload is checked to be plain JSON with integer micro-USD money (file
 * header). A payload that is not, or that cannot be walked at all, throws
 * ReviewLoopContractError 'invalid-payload'. Semantic rules (unions, lineage, allowlists)
 * are checked separately by the implementation.
 */
export function reviewLoopPayloadBytes(value: unknown): number {
  let violation: string | null;
  let json = '';
  try {
    violation = plainJsonViolation(value, '$', new Set());
    if (violation === null) json = JSON.stringify(value);
  } catch {
    violation = '$ cannot be walked (nested too deeply)';
  }
  if (violation !== null) throw new ReviewLoopContractError('invalid-payload', `payload breaks the slot envelope: ${violation}`);
  return new TextEncoder().encode(json).byteLength;
}

/**
 * Throws ReviewLoopContractError 'invalid-payload' when a payload is not plain JSON or is
 * larger than REVIEW_LOOP_MAX_PAYLOAD_BYTES. Implementations call it on every input before
 * any state change and on every output before returning; orchestration adapters may call
 * it before scheduling an activity.
 */
export function assertWithinReviewLoopEnvelope(label: string, value: unknown): void {
  const bytes = reviewLoopPayloadBytes(value);
  if (bytes > REVIEW_LOOP_MAX_PAYLOAD_BYTES) {
    throw new ReviewLoopContractError(
      'invalid-payload',
      `${label} serializes to ${bytes} bytes; the slot envelope allows ${REVIEW_LOOP_MAX_PAYLOAD_BYTES}`,
    );
  }
}

// ===========================================================================
// packages/application/src/review-loop/disabled-slot.ts            (S0; signature)
// ===========================================================================

/**
 * The explicit, literal opt-out (Phase 2 behaviour), constructible only with the literal.
 * Every round returns PROCEED with mode 'not-required', shadow null, no reviewer call and
 * no event; recordAttemptOutcome validates its input like any implementation, then
 * resolves null and records nothing; admitWithAssurance
 * equals admitRisk; buildRepairContextPack throws ReviewLoopContractError 'invalid-input'.
 * It is never a default binding: when no assurance is configured, the orchestration lane
 * binds its NotConfiguredAssuranceSlot, which fails closed for any risk that requires
 * review.
 */
export declare function createDisabledAssuranceSlot(ack: typeof REVIEW_LOOP_DISABLED): ReviewLoopSlot;

// ===========================================================================
// packages/application/src/review-loop/review-loop-contract.ts     (S0 conformance kit; signatures)
// ===========================================================================

/** A repair attempt prepared in the backing store, for the repair-helper parts of RLC-14, RLC-15 and RLC-17. */
export interface RepairContextFixture {
  /** A valid request for the repair attempt, carrying the fence of that attempt's lease. */
  readonly input: RepairContextInput;
  /** Hands the repair attempt's lease to a new holder in the backing store and returns its fence. */
  readonly rotateFence: () => Promise<AssuranceFence>;
}

/** An attempt registered in the backing store that has never held a workspace lease, for RLC-16, RLC-17 and RLC-18. */
export interface PreLeaseAttemptFixture {
  /** A valid pre-lease terminal of that attempt: fence null, terminal in PRE_LEASE_ATTEMPT_TERMINALS. */
  readonly attemptOutcome: PreLeaseAttemptOutcomeInput;
  /**
   * Acquires the attempt's first workspace lease through the composition's lease
   * acquisition, under the attempt-row lock; resolves the new holder's fence, or null when
   * acquisition is refused because the attempt already has a terminal.
   */
  readonly acquireLease: () => Promise<AssuranceFence | null>;
  /** Releases the lease `acquireLease` acquired. */
  readonly endLease: () => Promise<void>;
}

/** What every conformance fixture provides, stateful or not. */
export interface ConformanceFixtureBase {
  /** A valid round-1 input that the implementation's backing store accepts. */
  readonly input: AssuranceSlotInput;
  /** A valid round-1 input whose change trips the push guard; null when the implementation cannot produce one. */
  readonly pushGuardInput: AssuranceSlotInput | null;
  /** A valid terminal of `input`'s attempt, carrying `input.fence`. */
  readonly attemptOutcome: LeasedAttemptOutcomeInput;
  /**
   * Brings the backing store to a persisted REPAIR adjudication of `input`'s task with the
   * repair attempt's lease held; null when the implementation cannot reach REPAIR (the
   * repair-helper parts of RLC-14 and RLC-15 then report not-applicable in the detail).
   */
  readonly prepareRepair: (() => Promise<RepairContextFixture>) | null;
}

/**
 * The fixture of an implementation that persists anything (rows, artifacts or events).
 * Every hook is required, and no case that needs one may report not-applicable: the
 * atomicity part of RLC-16 included (R32).
 */
export interface StatefulConformanceFixture extends ConformanceFixtureBase {
  readonly stateless: false;
  /** Simulates a lease handoff of `input`'s attempt in the backing store and returns the new holder's fence. */
  readonly rotateFence: () => Promise<AssuranceFence>;
  /** Releases the lease of `input`'s attempt in the backing store. */
  readonly endLease: () => Promise<void>;
  /** Registers a fresh attempt of `input`'s task that has never held a lease. */
  readonly preLeaseAttempt: () => Promise<PreLeaseAttemptFixture>;
  /** Makes the next write transaction of the backing store fail at commit. */
  readonly failNextCommit: () => void;
  /** Canonical bytes of every row and run event the backing store holds for one round key, in a stable order. */
  readonly persistedRoundBytes: (roundKey: string) => Promise<string>;
  /**
   * Canonical bytes of every row, artifact and run event the backing store holds for one
   * attempt id (its attempt outcome, its repair ContextPack), in a stable order.
   */
  readonly persistedAttemptBytes: (attemptId: AttemptId) => Promise<string>;
}

/**
 * The fixture of an implementation that persists nothing: the disabled and scripted slots
 * (R32, R37). A slot that persists anything presents a StatefulConformanceFixture, Lane A's
 * NotConfiguredAssuranceSlot included because it persists outcome events. With this fixture the
 * fencing, pre-lease, atomicity, persistence and "no state change" parts of the cases report
 * not-applicable.
 */
export interface StatelessConformanceFixture extends ConformanceFixtureBase {
  readonly stateless: true;
  readonly rotateFence: null;
  readonly endLease: null;
  readonly preLeaseAttempt: null;
  readonly failNextCommit: null;
  readonly persistedRoundBytes: null;
  readonly persistedAttemptBytes: null;
}

export type ReviewLoopConformanceFixture = StatefulConformanceFixture | StatelessConformanceFixture;

/** The implementation under test over an empty backing store; the kit builds a fresh one per case. */
export type ReviewLoopConformanceSubject = () => Promise<{
  readonly slot: ReviewLoopSlot;
  readonly fixture: ReviewLoopConformanceFixture;
}>;

export interface ReviewLoopConformanceResult {
  readonly caseId: string;
  readonly status: 'passed' | 'failed' | 'not-applicable';
  readonly detail: string;
}

/**
 * Runs cases RLC-01…RLC-18 against any implementation. Framework-free; callers assert on
 * the result. `makeCtx(logicalTime)` returns a live context whose now() is `logicalTime`;
 * the kit reuses one value for every redelivery of one execution.
 */
export declare function runReviewLoopContract(
  makeSubject: ReviewLoopConformanceSubject,
  makeCtx: (logicalTime: string) => AssuranceStepContext,
): Promise<readonly ReviewLoopConformanceResult[]>;

/** One step of an attempt's life as the composition commits it, for RLC-19. */
export type AttemptLifecycleStep =
  /** The attempt is durably registered and the workflow has read that registration back. */
  | { readonly kind: 'registration-reconciled'; readonly attemptId: AttemptId }
  /** Anything bound to the attempt: lease acquisition, workspace creation, agent start, a slot call, a terminal write. */
  | { readonly kind: 'attempt-bound-effect'; readonly attemptId: AttemptId; readonly effect: string };

export interface RegistrationOrderingScenario {
  readonly name: string;
  /** Drives the composition's workflow through the scenario and returns every step it committed, in commit order. */
  readonly run: () => Promise<readonly AttemptLifecycleStep[]>;
}

/**
 * Runs case RLC-19 (R28 obligation 1, R32) against the orchestration composition: in every
 * scenario, no attempt-bound effect of an attempt precedes that attempt's
 * registration-reconciled step. The kit first runs its own check on a fixed trace whose
 * first step is an effect, and fails the case unless that trace is refused.
 */
export declare function runRegistrationOrderingContract(
  scenarios: readonly RegistrationOrderingScenario[],
): Promise<readonly ReviewLoopConformanceResult[]>;

export interface WorkspaceResolverConformanceFixture {
  readonly scope: TenantScope;
  /** An attempt whose workspace lease is ACTIVE and held by `fence` in the backing store. */
  readonly attemptId: AttemptId;
  readonly fence: AssuranceFence;
  /** Another tenant's scope that the backing store also holds. */
  readonly foreignScope: TenantScope;
  /** Ends the attempt's lease (expiry or release) in the backing store. */
  readonly endLease: () => Promise<void>;
}

/** Runs cases WRC-01…WRC-05 against any resolver, each on a fresh subject. */
export declare function runWorkspaceResolverContract(
  makeSubject: () => Promise<{
    readonly resolver: AssuranceWorkspaceResolver;
    readonly fixture: WorkspaceResolverConformanceFixture;
  }>,
): Promise<readonly ReviewLoopConformanceResult[]>;

export interface ScriptedReviewLoopScript {
  readonly mode: ReviewMode;
  /** Outcome kind returned for each round number; validated against this contract like a real implementation. */
  readonly outcomesByRound: Readonly<Record<number, AssuranceOutcome['kind']>>;
}

/** Scripted slot for orchestration tests; enforces every input and output invariant of this contract. */
export declare function createScriptedReviewLoopSlot(script: ScriptedReviewLoopScript): ReviewLoopSlot;
```

Lane A's commitments around that block (they do not restate or alter it):

- **Activity wrapper.** One `assuranceRound` activity wraps `runAssuranceRound` (architecture §5, §12).
  Options: 30 min start-to-close, 60 s heartbeat, retry 3. It needs the request's idempotency key and the R1
  claim identity to converge on redelivery.
- **Context adapter.** `toAssuranceStepContext(ctx: ActivityExecutionContext)` maps `signal` to `ctx.signal`,
  `heartbeat(details)` to `ctx.heartbeat({ stage: 'assurance', … })`, and `now()` to `ctx.logicalNow`, which is
  stable across redeliveries.
- **`recordAttemptOutcome()`.** An activity called once at every attempt terminal, per the table in
  architecture §12.
- **Admission.** The `admitTask` activity takes an injected `admit: (risk) => AdmissionResult` (the SR-X1
  shape). It defaults to `admitRisk`, with byte-identical behavior when absent. At integration it is bound to
  `admitWithAssurance(risk, capability)`.
- **Repair.** A fresh workspace at `repairBaseSha`, a ContextPack from `buildRepairContextPack()`,
  `round = nextRound` and `priorAdjudicationId = adjudicationId`. A `retry` that replaces a failed repair attempt
  keeps the same lineage (R17).
- **Default binding.** `NotConfiguredAssuranceSlot` (architecture §12) passes the conformance kit. S0 lands it
  minimal in `packages/application/src/orchestration-activities/` (Lane A's directory), so O1 holds in S0; S6
  binds it. It fails closed for any risk that requires review. Lane B's `DisabledAssuranceSlot` is the explicit
  opt-out and is not a default Lane A binds.
- **Workspace resolver.** Lane A implements the block's resolver port over the lease table (S3, exit E15): right
  tenant, an `ACTIVE` lease held by the given lease id, the current fencing epoch, else fail closed. No workspace
  comes from activity-local memory.
- **Terminal vocabulary.** The block's terminals win. At hand-off Lane A updates architecture §12's terminal
  table, exit J2 and the core's local terminal names (S0, exit O5).
- **Assurance-activity failure.** Audited `assurance-unavailable`, then `PROCEED` in shadow mode or `ESCALATE` in
  gating mode, never `FAILED` (R19, exit J10).
- **Request fields.** The union both plans need, as the locked block gives them: `model`, `declaredComplete`,
  `priorAdjudicationId`, the idempotency key and the R1 claim/fencing identity.
- **Attempt status projection.** Lane B's `UNDER_REVIEW`/`CHANGES_REQUESTED` are written only after Lane B's
  constraint and domain edges merge (R6).

Owner: Lane B writes the contract text, Lane A lands it (S0). Lane A owns the composition (S2, S6, S7).

### CR-11 — Migrations (`adapters/persistence/src/migrations.ts`)

Lane A's migrations, as listed in `phase-03-data-model.md` §2:

- `0100` (`tasks.status`), `0101`, `0102`, `0104`, `0105` and `0106` land in S3;
- `0107_run_events` (unified DDL, R4) lands in S0;
- `0103` is intentionally unused (the migrator allows gaps, `migrator.ts:45-51`).

Lane B withdraws `0201_run_events`. Owner: Lane A.

### CR-12 — Fitness rules (`scripts/forbidden-imports.test.ts`)

Add the rules in `phase-03-architecture.md` §3, each with a seeded-violation self-check. They are written against
the AST-based rule framework that the accepted Phase 2 lands, after the rebase (R8). At `d6ee686` that is
`scripts/lib/ts-guard.mjs` (`runGuard`, TypeScript checker rules over the shipped source, with seeded virtual-file
fixtures in `scripts/ts-guard.test.ts`, `asep-suite:ts-guard`); a rule that resolves symbols or types lands there, and
an import-specifier rule lands in `scripts/forbidden-imports.test.ts` with its own self-check (§1.4 P2-5). Coverage:

- core purity on the production source of `packages/orchestration` (the rule S2 proves package-locally);
- forbid `@temporalio/*` everywhere except `adapters/temporal/**` (its `src/test-support/**` included), with no
  test exception;
- extend the composition-root coverage to `workers/temporal-worker`;
- add the production-entrypoint import-graph rule (exit B8) and the `FaultInjector` rule (exit B9).

Lane B's rules land in the same file. The registry is append-only per lane and unioned at merge (R10). Owner:
Lane A, in two checkpoints (P3-PLAN2-MED-001). S2 does not touch this file: it carries the package-local
self-check `packages/orchestration/src/purity.test.ts` (`asep-suite:orchestration-purity`, exit B2). S7 adds the
core-purity, confinement and workflow-purity rules here, after G-P2; the package-local suite stays registered.
S9 adds the B8 and B9 rules.

### CR-13 — Required unit suites (`scripts/lib/canonical-tests.mjs` `REQUIRED_SUITES`, append-only, R10)

```text
asep-suite:assurance-slot-contract       packages/application/src/orchestration-activities/assurance-slot.test.ts   (S0)
asep-suite:run-event-sink                adapters/persistence/src/run-events/run-event-sink.test.ts                 (S0)
asep-suite:orchestration-core            packages/orchestration/src/decide.test.ts
asep-suite:orchestration-properties      packages/orchestration/src/invariants.test.ts
asep-suite:orchestration-purity          packages/orchestration/src/purity.test.ts                                  (S2)
asep-suite:orchestration-activities      packages/application/src/orchestration-activities/activities.test.ts
asep-suite:orchestration-policy-loader   packages/policy/src/orchestration-policy.test.ts                           (S6)
asep-suite:orchestration-persistence     adapters/persistence/src/orchestration/orchestration-persistence.test.ts
asep-suite:workspace-rehydration         adapters/git-worktree/src/rehydration.test.ts
asep-suite:command-runner-abort          adapters/command-runner/src/per-call-abort.test.ts
asep-suite:agent-budget-caps             adapters/agent-claude/src/budget-caps.test.ts
asep-suite:forge-pr-upsert-concurrency   adapters/github-app/src/pr-upsert-concurrency.test.ts
asep-suite:temporal-bundle               adapters/temporal/src/worker/bundle.test.ts
asep-suite:temporal-replay               adapters/temporal/src/worker/replay.test.ts                                (S8)
asep-suite:temporal-activity-bridge      adapters/temporal/src/activity-bridge/bridge.test.ts
asep-suite:temporal-activity-options     adapters/temporal/src/workflows/activity-options.test.ts
asep-suite:temporal-input-mapping        adapters/temporal/src/workflows/input-mapping.test.ts                     (S7)
asep-suite:temporal-connection-guard     adapters/temporal/src/client/connection-guard.test.ts
asep-suite:workflow-payload-hygiene      adapters/temporal/src/payload-hygiene.test.ts
asep-suite:orchestration-api             apps/control-plane-api/src/orchestration/orchestration-routes.test.ts
```

S2 has appended `orchestration-core`, `orchestration-properties` and `orchestration-purity` (R15). Owner: Lane A.

### CR-14 — Integration gate (`scripts/integration/**`)

- `images.mjs`: add these pins.
  - `temporal: 'temporalio/temporal@sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e'`
  - for the pre-deployment smoke:
    `temporalServer: 'temporalio/server@sha256:acecbab5b0b8ae9cf4012b508866ca97feda3709577bf157b537239f40029049'`
    and
    `temporalAdminTools: 'temporalio/admin-tools@sha256:9ef0dc5b063bf4ffd5c1512de72e0e73e225bd2c7006a18ce69bd592a8862a83'`
- `run-integration.mjs` must:
  - provision the server and publish it on `127.0.0.1` only;
  - log the `temporal --version` line and the full `docker pull` and `docker image inspect` RepoDigests output of
    every pinned Temporal image (C1, M3);
  - health-check with in-container `temporal operator namespace describe`;
  - create the namespace with `temporal operator namespace create --retention 24h` and read the retention back,
    failing on a mismatch (C10; flag verified on the pinned image, research register Q9);
  - pass `ASEP_TEMPORAL_ADDRESS`/`ASEP_TEMPORAL_NAMESPACE`;
  - honor `ASEP_ITEST_OMIT_BACKEND=temporal`;
  - always tear down in `finally`.

  The chaos suites need a container **volume** for the server-restart test, and the gate removes that volume in
  `finally`. `lib.mjs` `runContainer` already passes `-p` strings through (`lib.mjs:136-138`), so the loopback
  form needs no helper change.
- `lib.mjs` `REQUIRED_ITEST_SUITES` additions (append-only, R10):

```text
asep-suite:pg-run-events                 adapters/persistence/src/run-events/run-event-sink.itest.ts            (S0)
asep-suite:pg-orchestration              adapters/persistence/src/orchestration/orchestration.itest.ts
asep-suite:temporal-orphan-containers    adapters/command-runner/src/reaper.itest.ts
asep-suite:temporal-e2e                  workers/temporal-worker/src/e2e/task-workflow.itest.ts
asep-suite:temporal-controls             workers/temporal-worker/src/e2e/controls.itest.ts
asep-suite:temporal-budgets-approvals    workers/temporal-worker/src/e2e/budgets-approvals.itest.ts
asep-suite:temporal-assurance-slot       workers/temporal-worker/src/e2e/assurance-slot.itest.ts
asep-suite:temporal-chaos-kill           workers/temporal-worker/src/chaos/worker-kill.itest.ts
asep-suite:temporal-chaos-zombie         workers/temporal-worker/src/chaos/zombie.itest.ts
asep-suite:temporal-chaos-infra          workers/temporal-worker/src/chaos/infra-outage.itest.ts
asep-suite:temporal-chaos-duplicates     workers/temporal-worker/src/chaos/duplicate-delivery.itest.ts
asep-suite:temporal-api-e2e              apps/control-plane-api/src/orchestration/api-temporal.itest.ts
asep-suite:approval-delivery-recovery    apps/control-plane-api/src/orchestration/decision-relay.itest.ts
```

- `gate-fail-closed.itest.ts`: add the Temporal-omitted case (must exit non-zero).
- `run-integration.test.ts`: digest-pin and parity assertions for the Temporal image (compose ⇔ images.mjs), the
  loopback `HostIp` assertion (C7) and the `TestWorkflowEnvironment` ban (C4).
- The pre-deployment smoke (`asep-suite:temporal-prod-smoke`) is **not** in `REQUIRED_ITEST_SUITES`. It runs on
  its own command, before deployment (R14).

Owner: Lane A (S0 for `pg-run-events`, S8 for the rest).

### CR-15 — `compose.yaml` Temporal service (R9)

Replace `temporalio/auto-setup:1.31.0`, whose tag does not exist (re-observed 2026-10-29, research register
§2), with the same digest-pinned `temporalio/temporal` dev server the gate uses. Pin `temporal-ui` by digest
(`temporalio/ui:2.54.1@sha256:ff0943fe…`). The parity test in CR-14 covers it. Lane B adds the Grafana
provisioning mount in a different section, and the two edits are unioned at merge. Owner: Lane A (S8).

### CR-16 — Dependencies

```text
adapters/temporal/package.json   dependencies:    @temporalio/workflow 1.24.0, @temporalio/activity 1.24.0,
                                                  @temporalio/worker 1.24.0, @temporalio/client 1.24.0,
                                                  @temporalio/common 1.24.0
                                  devDependencies: @temporalio/testing 1.24.0
workers/temporal-worker/package.json  no @temporalio/* dependency (P3-PLAN2-MED-004)
pnpm-lock.yaml                   regenerated; frozen install from a clean checkout must pass
root package.json                ONLY IF research Q4 shows a native build script is required:
                                  "pnpm": { "onlyBuiltDependencies": ["<that one package>"] }
```

The CX-35 callback injector (`AsyncCompletionClient`) and the CX-36 duplicate-delivery client wrapper live in
`adapters/temporal/src/test-support/`, inside the only package allowed to import `@temporalio/*`. They export
helpers whose signatures use no SDK type (task-token bytes as `Uint8Array`, plain result objects), so the worker
chaos suites call them without importing the SDK and exit B1 needs no test exception (exit F16).

No other new dependency. The honest GitHub HTTP double uses `node:http`. License gate expectations: research
register §1.1 (`unionfs`). Owner: Lane A (S7).

### CR-17 — Composition roots, principals and Temporal credentials

- `apps/control-plane-api/src/production-root.ts` stays Lane A's (R10). Add `productionWorkflowEngine(cfg)`,
  which builds the Temporal client adapter with fail-closed config: address, namespace, and TLS settings, which
  are required for a non-loopback address (C8).
- `workers/temporal-worker/src/main.ts`: its own Temporal connection settings, separate from the API's, under
  the same TLS rule.
- `apps/control-plane-api/src/auth.ts` (G15): extend `PrincipalResolver` with
  `principalForToken(token): Promise<TenantPrincipal | undefined>`.

  ```typescript
  export interface TenantPrincipal {
    readonly principalId: string;            // ULID; server state
    readonly principalClass: 'human' | 'service' | 'agent';
    readonly organizationId: OrganizationId;
    readonly capabilities: readonly string[];
  }
  ```

  Capability constants: `executions:start`, `executions:control`, `approvals:read`, `approvals:decide`,
  `runs:govern`. Only `human` principals may decide approvals. The existing `organizationForToken` path is
  unchanged for Phase 2 routes.
- `apps/control-plane-api/src/app.ts`: one registration line for `src/orchestration/routes.ts` (owned by Lane A),
  plus starting the decision delivery relay.
- `server-main.ts`, `pilot-main.ts`, `cli.ts`, `cli-main.ts`: dispatch through the engine (G13).
- Lane B's `assurance-root.ts` is imported by Lane A's worker composition root at integration time (R10).

Owner: Lane A (S9).

### CR-18 — Observability vocabulary (`packages/observability/src/spans.ts`, `audit.ts`)

Spans and audit actions in architecture §15. Closed-set additions only. Owner: Lane A (S1).

### CR-19 — Metrics dictionary (`docs/platform/metrics-dictionary.yaml`)

Add `duplicate_side_effect_incidents` = `count(incident.opened where failureClass = duplicate-side-effect)`,
SLO target 0 (`docs/operations/slo-and-alerting.md`: "duplicate irreversible side effect = 0"). Confirm that the
source events of `workflow_recovery_rate`, `human_intervention_rate` and `false_completion_rate` are now
emitted. Lane B's metric additions are unioned at merge. Owner: Lane A (S1).

### CR-20 — Existing adapter modules Lane A must modify (not claimed; listed for reconciliation)

| File | Change |
|---|---|
| `adapters/persistence/src/side-effect-log.ts`, `lease-repository.ts` | **none by Lane A** (Phase 2 primitive, CR-05) |
| `adapters/persistence/src/repositories.ts` | attempt creation via ordinal; Phase 2 call sites unchanged in behavior |
| `adapters/persistence/src/index.ts` | export lines for `./orchestration/index.js` and `./run-events/index.js` (append-only) |
| `adapters/git-worktree/src/worktree-manager.ts` | registry-backed rehydration, create-or-adopt, HEAD CAS, host guard (CR-07) |
| `adapters/agent-claude/src/claude-provider.ts` (rebased) | none: Phase 2 labels its containers and enforces the four caps (§1.4 P2-7) |
| `adapters/command-runner/src/{sandbox.ts,command-runner.ts}` (rebased) | per-call signal (CR-26); new `reaper.ts` over the `asep.attempt` label (CR-08) |
| `adapters/github-app/src/forge-provider.ts` | PR create-conflict reconciliation (CR-27); the PR listing and repository IDs of CR-28; `updatePullRequestContent` stays by number (R47) |
| `adapters/local-doubles/src/index.ts` | one export line for the new `durable-forge.ts` |

### CR-21 — Existing package modules Lane A must modify

| File | Change |
|---|---|
| `packages/application/src/pipeline-steps.ts` | thread the Phase 2 fencing identity, `expectedHeadSha` and a per-call verification signal; no behavior change for the Phase 2 driver |
| `packages/application/src/governed-execution.ts`, `vertical-slice-workflow.ts` | pass the new inputs (test drivers). The SR-X1 `admit` hook in `governed-execution.ts` is Lane B's request; Lane A's `admitTask` activity uses the same hook shape |
| `packages/application/src/index.ts` | one `export * from './orchestration-activities/index.js'` line (append-only; Lane B adds its own) |
| `packages/domain/src/operational.ts` (+ test) | task transitions for CR-01 |
| `packages/policy/src/index.ts` | one export line for a new `orchestration-policy.ts` loader of a new `policies/orchestration-policy.yaml` (defaults: lease TTL, heartbeat timings, approval TTL bounds, max pause, budget defaults, replaceable failure classes, relay interval) |

### CR-22 — Root build and CI

- Root `tsconfig.json` `references`: add `packages/orchestration`, `adapters/temporal` and
  `workers/temporal-worker`. The Phase 2 project-references fitness (`scripts/project-references.test.ts`)
  enforces it.
- `.github/workflows/ci.yml`: no structural change expected (the integration job already runs
  `pnpm test:integration`). A `timeout-minutes` raise for the chaos suites may be needed, decided from measured
  runtime at S10 (PR3-23). The pre-deployment smoke never runs in CI unless the controller adds it.
- `pnpm-workspace.yaml`: none (globs already cover the new packages).

### CR-23 — ADR number

**ADR 0017** "Durable orchestration topology: pure workflow core, retry-safe activities, lease-bound fencing" is
Lane A's (R11). It is written in S1. Lane B takes 0018 and up.

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
configuration. The test implementation is a fixed in-memory map. Owner: Lane A (S1, S6). S1 also lands the error
`resolve` throws for an unknown id or binding, `UnknownVerificationCommandError` (not retryable), so the activity
bridge can classify it without matching a message.

### CR-25 — Per-request agent caps (agent adapter, after the Phase 2 rebase; P3-PLAN-HIGH-005)

Applies to the rebased `ClaudeCodingProvider` (Phase 2 HIGH-008 lands the real agent runtime first). Amended at the
rebase (§1.4 P2-6, P2-7): at `d6ee686` the adapter already does what the first three bullets asked, so S4 changes no
adapter code for them and proves them with the H9 suite.

- `--max-turns` comes from `min(cfg.maxTurns, req.budget.maxTurns)` (`claude-provider.ts:755`).
- Tool calls are counted from the event stream and the agent is stopped above `maxToolCalls` (`:1032-1036`); the
  cost cap goes to the CLI as its budget (`:756`) and a reported cost above it is `BUDGET_EXHAUSTED` (`:1209-1211`).
  The observation names the cap.
- Wall-clock: the deadline is the request's budget (`:660`). The stop path at the deadline is `docker kill`, bounded
  by `DOCKER_CALL_TIMEOUT_MS`, then removal shown within `AGENT_REMOVAL_BOUND_MS`; the adapter exports the sum as
  `AGENT_STOP_BOUND_MS` = 60 000 ms (`:142`). `policy.agentKillGraceSeconds` = `AGENT_STOP_BOUND_MS / 1000` = 60, the
  only tolerance on the wall-clock cap (R21, R24, architecture §10). The worker composition root passes the constant
  to the policy loader, and the tests read it.
- **Fail closed on unsupported caps.** The adapter declares which caps it can observe. If a request carries a
  cap it cannot observe, `execute()` throws `AgentBudgetCapUnsupportedError` (new, `packages/ports`,
  non-retryable) before the container starts. All four caps are required by `work-order.schema.json:36`, so
  an adapter that cannot see cost cannot run any task.

Proof: exit H9 (`asep-suite:agent-budget-caps`), CX-26. Owner: Lane A (S4), as a change on Phase 2's adapter.

### CR-26 — Per-call cancellation for `CommandRunner` (`packages/ports/src/index.ts:281-283`; P3-PLAN-HIGH-006)

```typescript
export interface CommandRunOptions {
  /** Aborts this run: the process group is killed and the result reports cancellation. */
  readonly signal?: AbortSignal;
}
export interface CommandRunner {
  run(spec: CommandSpec, sandbox: SandboxHandle, options?: CommandRunOptions): Promise<CommandResult>;  // additive
}
```

`TrustedCommandRunner` composes the constructor signal (`command-runner.ts:36-39`) with the per-call signal.
`verifyStep` passes `ctx.signal` for every check. After an abort the activity reaps the attempt's verify
containers by label. Proof: E14 and G10. Owner: Lane A (S1 type, S4 implementation).

### CR-27 — Forge PR-upsert convergence (`adapters/github-app/src/forge-provider.ts:283-345`; P3-PLAN-HIGH-008)

Behavior, with no signature change. When `pulls.create` fails with `422`, the adapter re-lists by
`owner:head`. If a pull request for that head exists, it returns it (updating title and body as today).
Otherwise it rethrows. The adapter keys on the status and the re-list result, never on GitHub's error message
text (research register Q8). The contract test runs the **real** `GitHubAppForgeProvider`. Through its injected
`octokitFor` seam (`forge-provider.ts:203-204`) it gets a real `@octokit/rest` client whose base URL points at a
local HTTP double. The test covers:

- two concurrent upserts for one head;
- create succeeds but the response is lost, then a retry;
- a `422` on create.

The double implements one-open-PR-per-head. No live-GitHub uniqueness is claimed beyond this evidence. Proof:
E12. Owner: Lane A (S5). The line numbers above are at `00a6889`. Re-derived at the rebase (§1.4 P2-11): at `d6ee686`
the upsert is still list-then-create with no `422` handling (`adapters/github-app/src/forge-provider.ts:427-455`), and
the injected seam is `octokitFor`.

### CR-28 — Publication on Phase 2's cycle-9 forge contract (`packages/ports/src/index.ts`; R30, R33)

Phase 2 cycle 9 (`aa946cf`) replaced epoch fencing at the forge with R30's contract, and cycle 12 (R43, R47) added a
fifth, required port method that repairs a PR by its number. Phase 3 publishes through the accepted contract
unchanged (§1.4 P2-1, P2-2; `packages/ports/src/index.ts:410-463` at `d6ee686`):

```typescript
// Phase 2 at d6ee686 (accepted, R51), used as is:
ForgeProvider.pushBranch(scope, { repositoryBindingId, branch, commitSha, expectedRemoteSha: string | null }): Promise<void>
ForgeProvider.upsertPullRequest(scope, { repositoryBindingId, headBranch, base, title, body }): Promise<PullRequestRef>
ForgeProvider.updatePullRequestContent(scope, { repositoryBindingId, number, title, body }): Promise<PullRequestRef>
                                     // required; one write naming that PR; no adapter or double may implement it
                                     // through a branch-keyed upsert (R47)
ForgeProvider.resolveRef(scope, { repositoryBindingId, branch }): Promise<string | null>
ForgeProvider.findPullRequest(scope, { repositoryBindingId, headBranch }): Promise<PullRequestRef | null>
                                     // one PR for the head branch, no repository IDs
pullRequestContent(facts: PullRequestFacts): { title: string; body: string }   // pure, from immutable facts
pushStep / upsertPrStep / reconcileBranchStep / reconcilePullRequestStep        // application steps; audit 'forge.reconcile'
```

Phase 3 needs three additive changes. R34 approves them: Lane A lands them itself, in its own commits after G-P2 (on
the accepted Phase 2, not in Phase 2's repair), with the union rule for shared files:

1. **The assurance facts in the PR content.** Phase 3's PR carries the `ESCALATE` flag ("assurance not satisfied")
   and the content-addressed assurance section (architecture §12). Both are immutable facts of the attempt, so
   `PullRequestFacts` gains `flagged: boolean` and `assuranceSection: string | null` (the text of the section
   artifact, which its content address fixes), and `pullRequestContent` renders them after the Phase 2 lines. The
   content stays a pure function of facts; nothing owner-specific or mutable enters it.
2. **The full observation.** `ForgeProvider` gains one read, `listPullRequests(scope, { repositoryBindingId, headBranch
   })`: every PR in the binding repository whose head ref name is `headBranch`, in any state and from any head
   repository, paginated to the end, each with its number, head and base repository (`{ id, owner, name }`, the
   forge's numeric ID and the owner and name it reports now), head ref, head SHA, base ref, state, merged flag, title
   and body. `resolveRef` (or a sibling read) reports the repository the adapter read, with its numeric ID. The
   adapter addresses the repository by the binding's numeric ID where the forge allows it, so a pathname reused by
   another repository is never read as the binding's.
3. **Repository identity in the input.** The S7 mapping fills the task input's `repository` with the binding's
   numeric `githubRepositoryId` (the binding resolver already requires it, `adapters/github-app/src/binding-resolver.ts`)
   and its owner and name.

The `reconcilePublication` activity uses these reads and repairs only the title and body of the attempt's open PR; it
never creates, retargets or closes a PR, and never calls `reconcilePullRequestStep` in a mode that does (R34,
architecture §7.3). At `d6ee686` that step has no such mode at all (R43): it writes only to the PR the attempt's
`COMPLETED` pr-upsert record names, by its number. So the activity repairs only through it, with that record, writes
nothing when no such record exists, and reads the branch without `reconcileBranchStep` (§1.4 P2-2). Creating a PR
stays a core decision: the upsert after a confirmed push with no PR. Proof: E16 and G13 (activity part).

Slices (R34: after G-P2, in Lane A's own commits; §1.4 P2-10): item 1 is S1 (the `PullRequestFacts` fields and
`pullRequestContent`, whose output stays byte-identical to Phase 2's when `flagged` is false and the section is
null), consumed by S6; item 2 is S1 (the `listPullRequests` signature and the repository in the reads) and S5 (the
GitHub adapter and the honest HTTP double; `DurableLocalForge` in S8); item 3 is S7 (the input mapping).

---

## 31. Directory ownership (Lane A)

New directories and files Lane A owns exclusively. They must not overlap with Lane B.

```text
packages/orchestration/**
packages/application/src/orchestration-activities/**
adapters/temporal/**
adapters/persistence/src/orchestration/**
adapters/persistence/src/run-events/**                     (S0; shared sink adapter, owned by Lane A)
adapters/git-worktree/src/rehydration.test.ts
adapters/command-runner/src/reaper.ts
adapters/command-runner/src/reaper.itest.ts
adapters/command-runner/src/per-call-abort.test.ts
adapters/agent-claude/src/budget-caps.test.ts
adapters/github-app/src/pr-upsert-concurrency.test.ts
adapters/github-app/src/test-support/pulls-http-double.ts
adapters/local-doubles/src/durable-forge.ts
workers/temporal-worker/**
apps/control-plane-api/src/orchestration/**
packages/policy/src/orchestration-policy.ts
policies/orchestration-policy.yaml
docs/implementation/phases/phase-03-*
docs/architecture/adr/0017-*
```

Lane B's draft lists a run-event sink under `adapters/persistence/src/assurance/**` (`phase-04-plan.md` §18 at
`a2a7b8a`). Under R4 the sink adapter is Lane A's S0 item in `adapters/persistence/src/run-events/**`, and Lane B
injects it. Lane B's claim `adapters/agent-claude/src/reviewer-credential-isolation.test.ts` does not overlap
`budget-caps.test.ts`.

`adapters/temporal/**` includes `src/test-support/**` (the SDK-specific test injectors, CR-16) and
`test-histories/required-scenarios.json` (architecture §6.5). `packages/orchestration/**` includes
`src/test-support/**` (the core's test fixtures, excluded from the purity scan).

`packages/application/src/review-loop/**` is **not** claimed: Lane B owns its content (R16), and Lane A lands it
byte-for-byte in S0. Lane A's `NotConfiguredAssuranceSlot` lives in its own
`packages/application/src/orchestration-activities/**`.

Everything else Lane A touches is an existing module and is listed in §30 (CR-01 … CR-28) rather than claimed.

---

## 32. Assumptions and blocking questions

1. **Phase 2 is accepted (R51) and this branch is rebased onto `d6ee686` (R52).** Its fenced takeover (HIGH-006),
   typed result binding (HIGH-005) and real agent runtime (HIGH-008) are the Phase 2 deliverables Phase 3 builds on.
   §1.4 re-derives the affected CRs on the accepted shapes (CR-05, CR-08, CR-12, CR-20, CR-25, CR-27, CR-28); no
   invariant is missing, so no change request against the Phase 2 primitive is filed. Line numbers are those at
   `d6ee686`.
2. **Docker on the implementation host** is required for the mandatory gate. It was observed present (server
   29.6.1, re-observed in step 3). If it is absent at implementation time, the gate goes red. It never skips.
3. **No live credentials** are needed for Phase 3 exit (Claude and GitHub stay doubles, with live opt-in as in
   Phase 2). This is not a blocker.
4. **S0 needs Lane B's fixed and locked slot block** (G-LB, R18). If it changes field names used in architecture
   §12, the locked block wins, and Lane A updates §12, J1–J10 and the core's local names (O5) in the paste
   commit's review-log entry.
5. **Shadow mode in Phase 4 (user decision).** Lane A still implements and proves all four outcomes.

No genuine blocker for locking the plan. Implementation is gated as in §25.

---

## Output

```text
PLAN_STATUS: LOCKED v8 (pending controller confirmation); the five LOWs of re-audit v8 fixed without a version bump
S2_ACCEPTANCE: R37 — the pure decision core S2 is accepted once the five LOWs of re-audit v8 (bed7a13,
  ACCEPT_WITH_CHANGES 0.95) are fixed and the controller has checked them
PLAN_V1_SHA: 80bb76a (Codex reviewed: REQUEST_CHANGES 0.98; 1 CRITICAL, 8 HIGH, 9 MEDIUM, 1 LOW)
PLAN_V2_SHA: 98e92cf (Codex lock-check: REQUEST_CHANGES 0.97; 15 of 19 v1 findings FOLDED, 4 PARTIAL;
  new: 3 HIGH, 7 MEDIUM; all 10 new ACCEPTED, all 4 PARTIAL re-adjudicated and folded or open by design)
PLAN_V3_SHA: 7cbf5d3 (Codex review of v3 + S2 audit at 5e9fb84: REQUEST_CHANGES 0.98; v2 findings FOLDED except
  P3-PLAN-HIGH-004, PARTIAL by design; new: 2 HIGH + 3 MEDIUM plan, 5 HIGH + 5 MEDIUM S2; all 15 ACCEPTED,
  3 of them already resolved by 5b0afde/e4fd343)
PLAN_V4_SHA: ecf7b1c (Codex re-audit of v4 + S2 fixes at 7694b8b: REQUEST_CHANGES 0.98; v3 plan findings FOLDED;
  7 of 10 v3 S2 findings RESOLVED, 3 PARTIAL; new: 2 HIGH + 1 MEDIUM plan, 2 HIGH + 2 MEDIUM S2; all 7 ACCEPTED,
  the 3 PARTIAL closed by them)
PLAN_V5_SHA: 5a3a801 (Codex re-audit of v5 + S2 fixes at ac04c8c: REQUEST_CHANGES 0.98; v4 plan findings FOLDED;
  P3-S2R-HIGH-001, MED-001, MED-002 RESOLVED, P3-S2R-HIGH-002 PARTIAL; new: 2 HIGH + 1 MEDIUM plan, 2 HIGH +
  1 MEDIUM + 1 LOW S2; 6 ACCEPTED, LOW-001 REJECTED (R27); the PARTIAL closed through P3-S2V5-HIGH-001)
PLAN_V6_SHA: 1c3153b (Codex re-audit of v6 + S2 fixes at 392f259: REQUEST_CHANGES 0.97; v5 plan findings FOLDED;
  P3-S2V5-HIGH-002 and MED-001 RESOLVED, P3-S2V5-HIGH-001 PARTIAL; new: 1 HIGH + 2 MEDIUM plan, 3 HIGH + 1 MEDIUM
  S2; all 7 ACCEPTED (R29, R31); the PARTIAL closed through P3-S2V6-HIGH-001)
PLAN_V7_SHA: 0aedc3f (Codex re-audit of v7 + S2 fixes at ac0a1bc: REQUEST_CHANGES 0.96; v6 plan findings FOLDED;
  every v6 S2 HIGH and earlier PARTIAL RESOLVED, P3-S2V6-MED-001 PARTIAL; new: 1 HIGH + 3 MEDIUM + 1 LOW plan,
  3 MEDIUM S2; all 8 ACCEPTED (R33); the PARTIAL closed through P3-S2V7-MED-001)
BASE_SHA: d6ee686 (Phase 2 acceptance record; Phase 2 accepted at 8e71ed7, R51, R52; forked from 00a6889, rebased)
PHASE2_DELTA: §1.4 maps Phase 2 as accepted at d6ee686 against this plan (P2-1…P2-11) and amends the lines it names
BASELINE: pnpm install --frozen-lockfile exit 0; pnpm verify:all exit 0 (548/548 canonical tests), observed in step 1
RECONCILIATION: v1 (R1–R21, R24, R25, R27, the R28 slot rules, R29, R30's publication contract, R31, the Lane A parts of R32, R33, R34, the Lane A part of R37, R38, R39, R43, R47–R52) applied; S0 shared foundation added; G-P2 released (R52), G-LB released (R39)
OPEN_BY_DESIGN: none for S0; the CR-10 verbatim slot text is pasted (block sha256 9cc21c98…71a, R39) and lands in S0
PLAN_FILES:
  - docs/implementation/phases/phase-03-plan.md
  - docs/implementation/phases/phase-03-architecture.md
  - docs/implementation/phases/phase-03-data-model.md
  - docs/implementation/phases/phase-03-exit-criteria.md
  - docs/implementation/phases/phase-03-risk-register.md
  - docs/implementation/phases/phase-03-research-register.md
  - docs/implementation/phases/phase-03-threat-model-delta.md
  - docs/implementation/phases/phase-03-review-log.md
  - docs/implementation/phases/phase-03-plan-review-codex-v1.md
  - docs/implementation/phases/phase-03-plan-review-codex-v2.md
  - docs/implementation/phases/phase-03-review-codex-v3.md
  - docs/implementation/phases/phase-03-review-codex-v4.md
  - docs/implementation/phases/phase-03-review-codex-v5.md
  - docs/implementation/phases/phase-03-review-codex-v6.md
  - docs/implementation/phases/phase-03-review-codex-v7.md
  - docs/implementation/phases/phase-03-review-codex-v8.md
NEW_DEPENDENCIES_PROPOSED (exact pins): @temporalio/{workflow,activity,worker,client,common} 1.24.0,
  @temporalio/testing 1.24.0 (dev)
NEW_BACKEND_IMAGES: temporalio/temporal:1.9.1@sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e (gate);
  temporalio/server:1.32.1@sha256:acecbab5…, temporalio/admin-tools:1.32.1@sha256:9ef0dc5b… (pre-deployment smoke)
DEFERRED_WITH_REASON: fair scheduler; multi-host workers (single-host pool IN); worker versioning (drain-only or
  patched deploys); tenant/project budgets; parallel tasks in a run; Temporal mTLS/namespace auth
BLOCKERS: none; G-P2 and G-LB are released, the branch is rebased onto d6ee686, and S0 is landed for the
  controller's check and an independent review
```
