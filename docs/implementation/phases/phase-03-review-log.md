# Phase 3 — Plan Review Disposition Log

> Lane A adjudication of the independent Codex plan review (workflow step 3), of the Codex lock-check of the
> v2 plan (section "Lock-check v2", which also records the v3 freeze gate), and of the Codex review of plan v3 and
> audit of the S2 code (section "Review v3", which records the v4 freeze gate), of the Codex re-audit of plan v4
> and the S2 fixes (section "Review v4", which records the v5 freeze gate), of the Codex re-audit of plan v5 and
> the S2 fixes (section "Review v5", which records the v6 freeze gate), of the Codex re-audit of plan v6 and the S2
> fixes (section "Review v6", which records the v7 freeze gate), of the Codex re-audit of plan v7 and the S2 fixes
> (section "Review v7", which records the v8 freeze gate), and of the Codex re-audit of plan v8 and the S2 fixes
> (section "Review v8", which records the S2 acceptance condition). It also records the rebase onto the accepted
> Phase 2 (section "Rebase onto the accepted Phase 2" at the end).
> Planner: Lane A (Claude). Reviewer: Codex `gpt-5.6-sol` via the kiro-proxy gateway, read-only, run by the
> controller on 2026-10-29. Raw review: `phase-03-plan-review-codex-v1.md`.
> Reviewed base: `80bb76a` · Verdict: **REQUEST_CHANGES** · Confidence: 0.98.
> Binding input applied alongside the review: the controller's shared-surface reconciliation v1 (R1–R14), which
> wins where it and this plan disagree, plus two user decisions:
> - Phase 4's reviewer runs in shadow mode only;
> - Phase 2 is repaired in full (cycle 7), so its fenced takeover, typed result binding and real agent runtime
>   are Phase 2 deliverables.
>
> Each finding is dispositioned `ACCEPTED` / `PARTIALLY_ACCEPTED` / `REJECTED_WITH_EVIDENCE`. Findings are not
> auto-accepted. Lane A re-read the cited code at `80bb76a` (code identical to `00a6889`) before each
> disposition. A rejection states its verification source (`.claude/rules/review-audit-self-decision.md`). Every
> accepted finding names the design section, the exit criterion and the slice that will prove it, so it cannot
> be fixed in name only.

## Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| CRITICAL | 1 | 1 | 0 | 0 |
| HIGH | 8 | 8 | 0 | 0 |
| MEDIUM | 9 | 8 | 1 | 0 |
| LOW | 1 | 1 | 0 | 0 |
| **Total** | **19** | **18** | **1** | **0** |

No finding was rejected. Every code claim in the review was re-checked against the tree, and each one held:

- `claude-provider.ts:99,141,156,211`;
- `command-runner.ts:32-39,86-104`; `packages/ports/src/index.ts:281-283`;
- `forge-provider.ts:300-336`;
- `evidence-store.ts:101-135`; `evidence-store.test.ts:189-212`.

The one partial acceptance (MED-006) declines only the hard-coded cross-lane schema total. That part is
overridden by the controller's R7.

---

## CRITICAL

### P3-PLAN-CRIT-001 — An attempt-scoped fencing epoch lets a zombie that lost its lease re-claim — ACCEPTED
**Concern:** `AttemptFence.claim()` only incremented an epoch per attempt. It never checked that the lease is
still `ACTIVE` and held by the claimant, so a zombie could claim a new epoch and regain side-effect authority
(v1 `phase-03-plan.md:489-502`, `phase-03-architecture.md:246-274`).
**Disposition:** ACCEPTED. The v1 claim was `update attempts set fencing_epoch = fencing_epoch + 1 … returning`
(v1 data model §3.2). It had no lease predicate at all, so the attack is real. Under R1 the platform has one
fencing mechanism, Phase 2 HIGH-006 (Lane R). Lane A withdraws its design and states the invariants it needs.
**Evidence:** v1 text quoted above; the reconciliation R1 states the same invariant; the current wedge is
pinned at `adapters/persistence/src/side-effect-log.test.ts:255`, and the fencing check is at
`side-effect-log.ts:174-181`.
**Locked change:**
- Plan §30 CR-05 is rewritten as a dependency on the Phase 2 primitive, with invariants F1–F5 and L1–L3. CR-06
  is withdrawn.
- Architecture §7.1 and §7.4.
- Data model §2: `0103` unused, and `attempts.fencing_epoch` removed.
- Plan §1.2 G3–G5.
**Validation:** E4 (claim refused for an expired, released, quarantined or superseded lease, plus a barrier test
proving the same-transaction check), E5 (an old holder's complete/fail/reopen refused after takeover), F7
(SIGSTOP zombie), F10. Slices S3, S6, S10, all gated on Phase 2 acceptance (plan §25).

## HIGH

### P3-PLAN-HIGH-001 — CR-05 kept `resultRef?: unknown` — ACCEPTED
**Concern:** v1 CR-05 kept free JSONB/`unknown` results, which Phase 2 HIGH-005 rejects (v1 `phase-03-plan.md:514-531`).
**Disposition:** ACCEPTED. Under R2 Lane A introduces no parallel result contract. It uses the typed result
binding that Phase 2 accepts.
**Evidence:** v1 plan text (`resultRef?: unknown` in `SideEffectCompleteInput` and `SideEffectRecord`); R2.
**Locked change:** Plan §30 CR-05 invariant F4 (no `resultRef?: unknown`). The v1 signature block is deleted.
Architecture §7.1 F4. Data model §1 (result binding owned by Phase 2).
**Validation:** E13 (adoption returns the typed result) and D6, both on the rebased primitive. Slices S3, S6.

### P3-PLAN-HIGH-002 — No full `FAILED` state machine; a FAILED record may hide a successful transport — ACCEPTED
**Concern:** v1 defined takeover only for low-epoch `PENDING`. It had no reopen or reconciliation rule for
`FAILED`, even though the transport may have succeeded before `FAILED` was written (v1
`phase-03-architecture.md:246-257`).
**Disposition:** ACCEPTED, and it applies to Lane A by R1. The `FAILED` lifecycle has three rules:
- every reopen reconciles the remote by natural key first;
- ambiguous outcomes stay `PENDING`;
- terminal failures are never reopened.

If the accepted primitive lacks this, Lane A files a change request against it.
**Evidence:** v1 architecture §7 bullet "`PENDING`/`FAILED` with `owner_epoch > E` → fencing error" was the only
`FAILED` rule.
**Locked change:** Architecture §7.1 (`FAILED` state machine); plan §30 CR-05 (`FAILED` lifecycle); plan §22
CX-31, CX-32, CX-33.
**Validation:** E13 (table test against the primitive); F18 (CX-31 external success then `fail`, CX-32 crash
after `FAILED`, CX-33 ambiguous timeout). Slices S6, S10.

### P3-PLAN-HIGH-003 — A crash between the decision insert and the Update strands the gate — ACCEPTED
**Concern:** The API inserted the decision and then sent the Update. A crash in between left the workflow
waiting until expiry, and a retry only returned the old receipt (v1 architecture §11, v1 data model §3.5, v1
exit I3).
**Disposition:** ACCEPTED. The fix has three parts:
- a transactional outbox: `approval_decision_deliveries`, written in the same transaction as the decision;
- a delivery relay in every API process, at startup and on an interval;
- an identical retry marks the row due again, so it always re-delivers.

Delivery is idempotent because `updateId = decisionId`. Related hardening: the workflow, not the API, writes
the audit row for an accepted control, so an API crash cannot lose it.
**Evidence:** v1 data model §3.5 ("identical → original receipt", no re-delivery) and v1 architecture §11
decision path.
**Locked change:** Data model §3.5 (outbox DDL); architecture §11 and §9; plan §10 and §19; threat T3-15; risk
PR3-29.
**Validation:** I3 (same-transaction write; identical retry re-delivers); F19 / CX-34 (SIGKILL the API exactly
between the commit and the Update, restart it, and the workflow continues exactly once). Slice S9.

### P3-PLAN-HIGH-004 — The Phase 3 slot does not match Phase 4 — ACCEPTED
**Concern:** The two plans differed in trigger, input, context, outcomes, repair base, terminal hooks and
admission hook (v1 `phase-03-plan.md:700-756`, v1 architecture §12; `phase-04-plan.md:525-597` at `a2a7b8a`).
**Disposition:** ACCEPTED, via R3. The slot follows Phase 4's semantics:
- one round after evidence and before push; none after a verification stop;
- outcomes `PROCEED | REPAIR | ESCALATE | BLOCK`;
- `recordAttemptOutcome()` at every attempt terminal;
- `admitWithAssurance` through the `admit` hook;
- repair at `repairBaseSha` with `buildRepairContextPack()`;
- Phase 4's `AssuranceStepContext` as the context.

Lane A owns the composition and the wrapper. Lane B stays framework-free. v1's `ReviewLoopPort`,
`VERIFICATION_FAILED` trigger, `seedDiffRef`, `AgentExecuteRequest.repairOrderRef` and the
`review-adjudication` approval kind are withdrawn. The slot TypeScript is Lane B's verbatim block, pasted on
controller hand-off.
**Evidence:** reviewer's eight-point comparison; Lane B draft `phase-04-plan.md` §7, §16 and §17.9 (read
read-only at `a2a7b8a`).
**Locked change:** Plan §30 CR-10 (heading `Review-loop slot contract (verbatim for S0)`, Lane A commitments);
architecture §4.1 and §12; plan §11 and §20; data model §3.5 (kinds), §4.2 (`maxRepairCycles` removed) and §4.3;
S0 in plan §26.
**Validation:** O1 (conformance kit), J1–J9 (position, default binding, four-outcome mapping, repair base and
context, one `recordAttemptOutcome` per attempt, Lane-B-free scripted slot, publish ordering, admit hook,
stable `now()`). Slices S0, S2, S6, S11.

### P3-PLAN-HIGH-005 — The provider does not enforce the request budget — ACCEPTED
**Concern:** The adapter uses `cfg.maxTurns`, not `req.budget.maxTurns`. It does not enforce `maxToolCalls` or
`maxCostUsd`. Only wall-clock comes from the request.
**Disposition:** ACCEPTED. Re-read: `--max-turns`/`ASEP_MAX_TURNS` use `this.cfg.maxTurns`
(`adapters/agent-claude/src/claude-provider.ts:141,156`), with the config field at `:99`. The only request-budget
use is wall-clock (`:211,276`; `grep maxToolCalls|maxCostUsd` → no hits). CR-25 is a change request against
the agent adapter after the Phase 2 rebase (HIGH-008 lands the real runtime first). Every cap is enforced from
the stream, and every unsupported cap fails closed before the container starts. The v1 claim "enforced by the
provider adapter (Phase 2)" is withdrawn.
**Evidence:** lines above; `packages/contracts/schema/work-order.schema.json:36` (all four caps required).
**Locked change:** Plan §30 CR-25; architecture §10; plan §1.2 G17; risk PR3-30; threat T3-13.
**Validation:** H9 (`asep-suite:agent-budget-caps`: a fake stream exceeds each cap → killed, `BUDGET_EXHAUSTED`;
an unsupported cap → `AgentBudgetCapUnsupportedError` before start); CX-26. Slice S4 (gated).

### P3-PLAN-HIGH-006 — Cancellation does not reach a running verification — ACCEPTED
**Concern:** The runner takes `AbortSignal` only through its constructor, `CommandRunner.run()` carries no
per-call signal, and no test cancels mid-verification.
**Disposition:** ACCEPTED. Re-read: `TrustedCommandRunner` takes `signal` in its constructor
(`adapters/command-runner/src/command-runner.ts:32-39`) and wires it at `:101-104`. The port is
`run(spec, sandbox)` (`packages/ports/src/index.ts:281-283`). CR-26 adds an optional per-call signal, which
`verifyStep` threads from `ctx.signal`. After an abort, the attempt's verify containers are reaped by label,
because killing the CLI's process group (`command-runner.ts:86-99`) is not proven to stop the container.
**Evidence:** lines above.
**Locked change:** Plan §30 CR-26; architecture §9 and §7.5; plan §1.2 G16; risk PR3-18; threat T3-07.
**Validation:** E14 (unit, per-call abort); G10 (real Temporal: cancel mid-verification → process group gone, no
`asep-verify-<attemptId>-*` container, no verification running, task `CANCELLED`). Slices S4, S11.

### P3-PLAN-HIGH-007 — Two incompatible `run_events` tables — ACCEPTED
**Concern:** Phase 3 `0107` and Phase 4 `0201` defined different DDL (primary key, payload hash,
append-only trigger).
**Disposition:** ACCEPTED, via R4. Lane A owns `0107_run_events` with the unified DDL:
- composite primary key `(organization_id, project_id, event_id)`;
- `payload_sha256` with conflict on different bytes;
- an append-only trigger rejecting `UPDATE`/`DELETE`;
- the scoped run FK.

The shared `RunEventSink` port and its PG adapter land in S0. Lane B withdraws `0201`.
**Evidence:** v1 data model §3.7; Lane B `phase-04-data-model.md` `0201_run_events` at `a2a7b8a`; R4.
**Locked change:** Data model §3.7 (full DDL, trigger function, sink semantics); plan §26 S0; plan §30 CR-11 and
CR-13/14 (S0 suites); plan §31 (`adapters/persistence/src/run-events/**`).
**Validation:** O2 (sink conformance, PGlite + real-PG race), O3 (DDL, cross-tenant FK, `UPDATE`/`DELETE` →
SQLSTATE `55000`), L3. Slice S0.

### P3-PLAN-HIGH-008 — Exactly-one-PR proven only on a double that enforces it itself — ACCEPTED
**Concern:** `DurableLocalForge` enforces uniqueness on its own. The real adapter is find-then-create and not
atomic. Concurrent creates and a lost create response have no contract proof.
**Disposition:** ACCEPTED. Re-read: `upsertPullRequest` lists by head and then creates
(`adapters/github-app/src/forge-provider.ts:300-336`). A `422` from create is rethrown (`:339-342` rethrows
everything except auth expiry). CR-27: on a `422` from create, re-list by head and return the PR if one exists.
It never parses message text. The contract test runs the real adapter through its injected `octokitFor` seam
(`forge-provider.ts:203-204`), using a real `@octokit/rest` client against an honest HTTP double. The double
implements one-open-PR-per-head and answers `422`. No live-GitHub uniqueness is claimed.
**Evidence:** lines above.
**Locked change:** Plan §30 CR-27; new slice S5; architecture §7.3; plan §21 (double parity); plan §1.2 G18; risk
PR3-31; research Q8.
**Validation:** E12 (`asep-suite:forge-pr-upsert-concurrency`: concurrent upserts, lost create response, `422`
reconciliation). Slice S5.

## MEDIUM

### P3-PLAN-MED-001 — "Duplicate callback" was replaced by duplicate API calls — ACCEPTED
**Concern:** The scope asks for duplicate-callback chaos tests, but no boundary was named as a real callback.
**Disposition:** ACCEPTED. Both remedies the reviewer offered are applied:
- "callback" is defined as three named transport boundaries, each injected there;
- the criterion is renamed so it claims nothing broader.

The three boundaries:
1. **Activity completion callbacks.** A recorded task token's completion is re-sent through
   `AsyncCompletionClient`.
2. **Workflow message delivery.** The same Update and Signal are sent twice at the gRPC boundary.
3. **Operator HTTP requests.** The same `Idempotency-Key` is replayed, including across an API crash.

Inbound forge webhooks do not exist (deferred in Phase 2, `phase-02-plan.md:304`).
**Evidence:** `docs/implementation/90-day-plan.md:28`; `docs/engineering/testing-strategy.md:22` ("duplicate
callback/message").
**Locked change:** Architecture §8 (definition); plan §22 CX-35, CX-36; exit F11 renamed; threat T3-16; research
Q10.
**Validation:** F16 (CX-35), F17 (CX-36), F11, F19. Slice S10.

### P3-PLAN-MED-002 — G8 is stale at HEAD — ACCEPTED
**Concern:** The evidence store already adopts an orphan by identity-gated reconciliation, and a test pins it.
**Disposition:** ACCEPTED. Re-read: orphan reconciliation is at `adapters/persistence/src/evidence-store.ts:101-135`
and is pinned by `evidence-store.test.ts:189-212`. v1 cited the cycle-5 review
(`phase-02-final-rereview-codex-v5.md:31`), which predates that fix. G8 is struck from the blocker table.
Workflow-supplied `createdAt` stays as hardening. The v1 claim "G8 is the residual HIGH-006 wedge" is withdrawn.
**Evidence:** lines above.
**Locked change:** Plan §1.2 G8 (marked stale) and the "Reported to the controller" note; plan §1.1 (asset row);
exit E10 reworded as hardening plus a regression check.
**Validation:** E10 (byte-identical retry + the Phase 2 adoption test stays green); CX-09. Slice S6.

### P3-PLAN-MED-003 — Threat-model claims not backed by the gate — ACCEPTED
**Concern:**
- The threat model said the gate binds `127.0.0.1`, but the command used `--ip 0.0.0.0`.
- Workers also connect to the frontend.
- Control history held principal and free-text reason.
- Namespace auth, codec and retention had no acceptance test.

**Disposition:** ACCEPTED. In-container `--ip 0.0.0.0` is required for Docker's port mapping. The real gap was
host-side: the existing gate publishes with `-p <port>:<port>` (`scripts/integration/lib.mjs:138`;
`run-integration.mjs:135,147`). The changes:
- Temporal is published on `127.0.0.1` only, and asserted (C7).
- Non-loopback plaintext is refused at startup (C8).
- The API and the worker have separate connection settings.
- Control messages carry no free text, and principals are opaque ULIDs.
- Every schema string is constrained (B6).
- Retention is explicit, and a codec trigger rule exists.
- Namespace authorization stays a stated pre-production residual.

While adjudicating this, Lane A found G15: tenant tokens resolve to an organization only
(`apps/control-plane-api/src/auth.ts:72-80`), so no tenant principal or capability existed for controls and
approvals. CR-17 adds a principal resolver.
**Evidence:** lines above; `temporal server start-dev --help` from the pinned image lists `--ip` (research
register §2).
**Locked change:** Architecture §16 (new); data model §4.2 (`workflow-control/v1` without free text); plan §30
CR-09 (cancel without reason), CR-14 (loopback) and CR-17 (principals, credentials); threat T3-01, T3-03, T3-05
and §4; plan §1.2 G15.
**Validation:** C7, C8, B6, K7, I2. Slices S1, S7, S8, S9.

### P3-PLAN-MED-004 — The replay gate can pass with an empty or happy-path-only corpus — ACCEPTED
**Concern:** No manifest, no minimum count, and Worker Versioning deferred without a deployment rule.
**Disposition:** ACCEPTED. The corpus gets a manifest: `scenario`, `workflowType`, `sourceSha`, `historySha256`,
`eventCount` and the capturing suite. The suite fails on any of these:
- an empty manifest;
- an unlisted or missing file;
- a digest mismatch;
- a required scenario below its minimum. Required scenarios: kill, retry, zombie takeover, approval approve and
  expiry, pause/resume, cancel, assurance repair, continue-as-new.

Without Worker Versioning, workflow-code changes deploy drain-only or fully patched, and mixed-version rolling
deploys are unsupported.
**Evidence:** v1 exit B5 only required "every committed history replays".
**Locked change:** Architecture §6.5 and §6.6; exit B5 and M1; risk PR3-01 and PR3-14; research §5.
**Validation:** B5 (manifest assertions + seeded non-deterministic fixture); M1 runbook procedures. Slices S7,
S8, S13.

### P3-PLAN-MED-005 — Production Temporal on PostgreSQL never exercised — ACCEPTED
**Concern:** The SQLite gate does not exercise production persistence.
**Disposition:** ACCEPTED, as R14 decides. The SQLite dev-server gate stays for Phase 3. A production-shaped
pre-deployment smoke is added: digest-pinned `temporalio/server` + `admin-tools` with schema setup on
PostgreSQL, a real restart, and the happy path. The report claims no production readiness without it.
**Evidence:** digests re-observed in step 3 (research register §2).
**Locked change:** Exit C9 and N5; new slice S12; plan §4 deferral row; plan §30 CR-14 (images); research
register §2 and Q1; risk PR3-26.
**Validation:** C9 (`asep-suite:temporal-prod-smoke`, run before deployment); N5. Slice S12.

### P3-PLAN-MED-006 — Wrong prediction of Lane B's status change and of the schema count — PARTIALLY_ACCEPTED
**Concern:** Phase 3 predicted that Lane B changes `TaskStatus`, but Lane B changes `AttemptStatus`. Separate
migrations are needed. The reviewer asked for the cross-lane total to be set to 19.
**Disposition:** PARTIALLY_ACCEPTED.
- **Accepted:** two independent unions and constraints (R6). Lane A owns `tasks.status` (`0100`), and Lane B
  owns `attempts.status` (`02xx`). The v1 prediction is withdrawn.
- **Not accepted:** hard-coding "19". The controller's R7 says "Do not hard-code a final cross-lane total in
  either plan; the merge produces it". R7 also adopts D-1 option (b), under which Lane B adds new logical
  contracts instead of MAJOR bumps, so any total computed from v1 drafts is no longer reliable. Lane A asserts
  only its own +3.

**Evidence:** reconciliation v1 R6 and R7; Lane B `phase-04-plan.md` SR-C7 at `a2a7b8a` (`AttemptStatus`).
**Locked change:** Plan §30 CR-01 and CR-02; data model §3.0, §4.1 and §6; exit A3.
**Validation:** A3 (Lane A's +3 and MINOR `run-event`); A5 (`0100` applies; `attempts.status` untouched). Slices
S1, S3.

### P3-PLAN-MED-007 — N3 let a "recorded disposition" stand in for a fix — ACCEPTED
**Concern:** Unresolved CRITICAL/HIGH findings could pass with a disposition only.
**Disposition:** ACCEPTED. N3 now requires **zero** unresolved CRITICAL/HIGH findings. A finding counts as
resolved only when it is one of these:
- `fixed`, with commit and test;
- `not-applicable`, with evidence;
- an explicit user-accepted risk.

**Evidence:** v1 exit N3 wording.
**Locked change:** Exit N3; plan §1.3 lesson 4.
**Validation:** N3, checked by the controller at step 5.

### P3-PLAN-MED-008 — Phase 2 acceptance gated only the merge — ACCEPTED
**Concern:** S3, S5 and S9 (v1 numbering) changed fencing and result persistence before Phase 2 was stable.
**Disposition:** ACCEPTED, with the reconciliation ordering. Gate G-P2 (Phase 2 accepted → `main` → rebase)
blocks S0 and everything after it. Only S2 (the pure core) may start earlier. The v1 slices map as follows:
v1 S3 → v2 S3, v1 S5 → v2 S6, v1 S9 → v2 S10. All three are behind G-P2, as are S4 and S5, which touch the
rebased agent runtime and forge result binding. Lane A changes no Phase 2 test.
**Evidence:** v1 risk register "Blocking dependencies"; reconciliation "Ordering and gating" 1–3.
**Locked change:** Plan §0 and §25 (DAG with G-P2 and G-LB); §26 gate column; risk PR3-20 and "Blocking
dependencies"; exit preamble and A7.
**Validation:** controller enforcement at step 4; A7; N4 (gates re-run after the rebase).

### P3-PLAN-MED-009 — D5 vs D9 contradiction for a killed agent — ACCEPTED
**Concern:** D5 sets `runAgent` to `maximumAttempts: 1`, while D9 and F2 said a killed activity is rescheduled.
**Disposition:** ACCEPTED. The two are split:
- **D5 (agent).** The agent is never redelivered. Death leads to a new attempt.
- **D9 (retryable activities).** The same activity is redelivered within the bound.
- **D12 (agent death detection).** The timing bound for agent death.

F2 and F3 are reworded to match.
**Evidence:** v1 exit D5, D9 and F2 text.
**Locked change:** Exit D5, D9, D12, F2 and F3; architecture §5 (agent vs retryable); plan §22 CX-04 and CX-05.
**Validation:** D5 (core), D9 and D12 (timing in F3/F2). Slices S2, S10.

## LOW

### P3-PLAN-LOW-001 — Tag-missing and digest claims were unverifiable in the reviewer's sandbox — ACCEPTED
**Concern:** The reviewer's `docker image inspect` failed with `permission denied` on the Docker API, so the
claims needed CI evidence.
**Disposition:** ACCEPTED. Lane A re-observed the claims on the implementation host in step 3 and recorded the
verbatim output:
- `temporalio/auto-setup:1.31.0` → `not found` (exit 1);
- the four digests match;
- `temporal version 1.9.1 (Server 1.32.0, UI 2.54.1)`;
- the dev-server flags.

These are developer-host observations, not CI. The gate now prints the `--version` line into its log, and M3
preserves it, so the controller's CI run produces the same evidence. The claims stay labeled with their source.
**Evidence:** research register §2 "Step 3 re-observation" table (commands and outputs).
**Locked change:** Research register §2 and §9; exit C1 and M3; plan §1.2 G14 and §21.
**Validation:** C1 (version line in the gate log), C3 (compose ⇔ images parity), M3 (preserved log). Slice S8.

---

## Lane A additions found while adjudicating

Folded in for the same reason as the findings: each is a real gap on the cited evidence.

- **Tenant principal model (G15).** Tenant tokens resolve to an organization only (`auth.ts:72-80`). CR-17 adds
  `principalForToken` with id, class and capabilities. Exit K7.
- **Stable `now()` for the assurance context.** If `now()` advanced across redeliveries, a redelivered round
  would re-derive different bytes and trip `RunEventConflictError`. This is the same class of hazard as the
  Phase 2 evidence `createdAt` (`evidence-store.ts:106-121`). `ActivityExecutionContext.logicalNow` feeds it.
  Exit J9; risk PR3-33.
- **Repair base retention.** The parent workspace is cleaned only after the repair workspace is `ACTIVE`, and the
  `repairBaseSha` object is checked before `git worktree add`. Exit E6; risk PR3-34.
- **ESCALATE publishes.** Under R3, `ESCALATE` publishes a flagged PR (Phase 4 §7), so v1's
  `review-adjudication` approval kind and the `request-repair` decision are withdrawn. Data model §3.5;
  exit I6.
- **Verification stop ends the task.** No repair or approval path starts from a failed mandatory verification.
  Architecture §4.1; threat T3-14.

## Escalated to the controller

These are information or requests. None is decided by Lane A alone.

Status after reconciliation R15–R18: items 1, 2 and 3 are **resolved by R15**, and item 4 is pending under R18
(section "Lock-check v2").

1. **Lane B's directory claim for the sink.** Lane B's draft lists a run-event sink under
   `adapters/persistence/src/assurance/**` (`phase-04-plan.md` §18 at `a2a7b8a`). Under R4, Lane A lands the
   sink adapter in S0 at `adapters/persistence/src/run-events/**`. Please confirm Lane B withdraws its copy.
2. **Scoped run FK in the unified `run_events`.** The union keeps Lane A's composite FK onto `runs`. Lane B's
   draft had `run_id text` with no FK. If Lane B appends events for a run that has no `runs` row (for example
   benchmark replays), it must create the run row first, or the controller must drop the FK. Lane A recommends
   keeping it (tenant coherence, T3-08).
3. **`AssuranceStepContext.now()` semantics.** Lane A returns the activity's logical time, which is identical on
   every redelivery and does not advance within one round. Lane B must not rely on it advancing. Please carry
   this into the locked block's doc comment if Lane B agrees.
4. **CR-10 paste.** Waiting for the hand-off of Lane B's locked `Review-loop slot contract (verbatim for S0)`.
   Lane A will paste it byte-for-byte and record its source SHA below.
5. **Phase 2 items this plan depends on but cannot see yet.** These are the `FAILED` lifecycle and invariants
   F1–F5 and L1–L3. If the accepted Phase 2 primitive lacks any of them, Lane A will file change requests
   against it after the rebase (CR-05), not work around it.
6. **Phase 2 claims affected.** G10 (container orphaning on `docker` client SIGKILL) is still unverified and bears
   on the Phase 2 G3 timeout claim. Separately, the Phase 2 gate publishes PostgreSQL and MinIO on all host
   interfaces (`lib.mjs:138`; `run-integration.mjs:135,147`). Lane A changes neither (shared surface; Phase 2's
   gate).

## CR-10 paste record

| Field | Value |
|---|---|
| Source | Lane B plan, heading `Review-loop slot contract (verbatim for S0)` |
| Lane B locked SHA | _pending controller hand-off_ |
| Byte comparison | _pending_ |
| Doc updates triggered (architecture §12, exit J1–J10, the core's local names under exit O5) | _pending_ |

## Freeze gate (v2, superseded)

- [x] Every finding dispositioned (19/19).
- [x] 0 unresolved CRITICAL/HIGH (all 9 ACCEPTED and folded into design, exit criteria and slices).
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] Task DAG acyclic, with gates G-P2 and G-LB; each slice has acceptance checks mapped to exit criteria
      (plan §25–§26).
- [x] Reconciliation v1 applied: S0 added (R3, R4, R5); R1/R2 by invariant; R6 independent constraints; R8–R11
      and R14.
- [ ] CR-10 verbatim text pasted (open by design; G-LB).

**PLAN_STATUS (v2):** LOCKED v2, superseded by v3 below. The lock-check showed that the second box was ticked
although P3-PLAN-HIGH-004 still depended on the pending CR-10 text; the v3 freeze gate states that qualifier.

---

## Lock-check v2

> Lane A adjudication of the independent Codex lock-check of plan v2.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-29 with
> Codex CLI 0.147.0. That CLI version warned that it fell back to default model metadata for `gpt-6.1-sol`; the
> controller has since moved to Codex CLI 0.165.0. The gateway appends its own style instructions and tools to
> every request, so the review holds "via this gateway" (R16). Raw output: `phase-03-plan-review-codex-v2.md`.
> Reviewed snapshot: `98e92cf` · Verdict: **REQUEST_CHANGES** · Confidence: 0.97.
> Binding input: reconciliation R15–R20. R17, R19 and R20 settle the business behavior behind P3-PLAN2-HIGH-001…003
> and MED-005, and Lane A applies them exactly as written. Line numbers in quotes of the lock-check refer to
> `98e92cf`.

### Summary

The lock-check found 15 of the 19 v1 findings FOLDED and 4 PARTIAL (HIGH-004, MED-003, MED-004, LOW-001), and
raised 10 new findings.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| New HIGH (P3-PLAN2-HIGH-001…003) | 3 | 3 | 0 | 0 |
| New MEDIUM (P3-PLAN2-MED-001…007) | 7 | 7 | 0 | 0 |
| v1 PARTIAL, re-adjudicated: HIGH | 1 | 1 | 0 | 0 |
| v1 PARTIAL, re-adjudicated: MEDIUM | 2 | 2 | 0 | 0 |
| v1 PARTIAL, re-adjudicated: LOW | 1 | 1 | 0 | 0 |
| **Total** | **14** | **14** | **0** | **0** |

P3-PLAN-HIGH-004 is accepted, and its remaining part (the verbatim slot block, its source SHA and the byte
comparison) stays open by design until G-LB, because R18 hands the block over only after Lane B fixes it.

**Tally correction.** Lane A's step-3 report said "19 accepted". The step-3 summary table above was right: 18
ACCEPTED, 1 PARTIALLY_ACCEPTED (P3-PLAN-MED-006, whose declined part R7 overrides), no rejection. The report
wording was wrong; no disposition changes.

### P3-PLAN2-HIGH-001 — No single rule for budget exhaustion — ACCEPTED (R17)

**Finding.** v2 sent "cap exceeded" straight to `ATTEMPT_ABANDONED`, CR-25/H9 required the adapter to return
`BUDGET_EXHAUSTED`, and H5 still required every mandatory check after the budget ran out during the agent step
(`phase-03-architecture.md:138`, `phase-03-plan.md:1052`, `phase-03-exit-criteria.md:320,325` at `98e92cf`).

**Disposition.** ACCEPTED. R17 decides the behavior.

**Locked change.**

- The verification budget is reserved separately when an attempt starts, and agent spending can never consume it
  (architecture §10 "Verification has its own reservation"; data model §4.2 `verificationReserve`).
- One agent-outcome table (architecture §10 "Agent outcome"; §4.1 `AGENT_RUNNING`):
  - `AGENT_DONE` → the full path;
  - cap-triggered `BUDGET_EXHAUSTED` → inspect only, no verification, commit or publication, attempt terminal
    `budget-exhausted`;
  - reported usage above a cap the adapter did not stop at → the same, plus `recordOverrun` and an audited
    overrun incident; the recorded overrun then ends the task `BUDGET_EXHAUSTED` at the next reservation (R19);
  - infrastructure error → abandoned as replaceable; a `retry` only if `maxAttempts` and a fresh reservation
    allow.
- The attempt terminal `budget-exhausted` joins architecture §12's terminal table until the fixed block's
  vocabulary replaces it (R18).

**Validation.** H5 and H8 rewritten; H10 new (core table and e2e, paired with H9). S2 core trace 1; S11 e2e.

### P3-PLAN2-HIGH-002 — `REPAIR` without budget had two required outcomes — ACCEPTED (R17, R19)

**Finding.** Architecture and H3/H4 routed a failed reservation to a budget-extension approval, while J4 ended a
`REPAIR` without budget at once in `FAILED / repair-capacity-exhausted`, with no exception for approvals
(`phase-03-architecture.md:131,149`, `phase-03-exit-criteria.md:317,378` at `98e92cf`).

**Disposition.** ACCEPTED. R17 separates the two limits; R19 refines the budget scopes.

**Locked change.** The reservation-failure table (architecture §10; §4.1 `BUDGET_CHECK`), for every planned
attempt:

- `maxAttempts` exhausted → `FAILED` (`repair-capacity-exhausted` for a repair lineage, else
  `attempts-exhausted`), whatever the budget says;
- task cap short and `maxBudgetExtensionUsd` set → `WAITING_FOR_APPROVAL`; approve → reserve and continue with
  the same attempt plan and lineage; reject or expiry → `BUDGET_EXHAUSTED`;
- task cap short and `maxBudgetExtensionUsd` unset → `BUDGET_EXHAUSTED`;
- run remainder, wall-clock or a recorded overrun → `BUDGET_EXHAUSTED`; no task-level approval extends them.

A budget-extension approval is available only while the policy datum `maxBudgetExtensionUsd` is set. There is no
default in code (R19; architecture §10, §11; data model §4.2). That is the only switch: "approvals disabled"
means "`maxBudgetExtensionUsd` unset" (R20). J4 and H3 are amended.

**Where S2 changes (R19).** At `a133e32` a repair plan whose reservation failed for any reason other than the task
cap ended `FAILED / repair-capacity-exhausted` (`packages/orchestration/src/task-core.ts:620-621`), and the code
default was `maxBudgetExtensionUsd: 50` (`packages/orchestration/src/defaults.ts:42`). The S2 follow-up commit
routes every budget cause to `BUDGET_EXHAUSTED`, keeps `repair-capacity-exhausted` for `maxAttempts` only, and
removes the default.

**Validation.** H3, H4, J4. S2 core trace 2 (`maxBudgetExtensionUsd` set: approve keeps the lineage, reject ends
`BUDGET_EXHAUSTED`; `maxBudgetExtensionUsd` unset; run-remainder shortfall); S11 e2e.

### P3-PLAN2-HIGH-003 — The commit→PR critical section covered cancellable assurance and the repair loop — ACCEPTED (R17)

**Finding.** Cancel semantics still completed one critical section from commit to PR, while v2 put a cancellable
assurance round, the `REPAIR` loop and the publication approval inside that span
(`phase-03-architecture.md:142,149,155,231,456`, `phase-03-risk-register.md:27` at `98e92cf`).

**Disposition.** ACCEPTED. R17 decides the behavior.

**Locked change.** Each reconciling operation is its own critical unit: (1) commit plus evidence binding,
(2) push, (3) PR upsert (architecture §4.1, the §5 option table, §9 cancel row). A cancel inside a unit is
processed when the unit has reconciled. Once a push has started, the PR upsert completes too, so the remote holds
either no ASEP branch or the branch and its PR. Assurance rounds, repair planning and approval waits are
cancellable at any time; an open approval request is closed with `cancelApprovalRequest` (R19). Risk PR3-18;
threat T3-19.

**Validation.** G7 rewritten; G11 new (cancel during assurance); G12 new (cancel during the publication-approval
wait). S2 core trace 4; S11 e2e.

### P3-PLAN2-MED-001 — S2's fitness acceptance depended on the unaccepted Phase 2 framework — ACCEPTED

**Finding.** S2 had to deliver B2 in the shared forbidden-import suite, while CR-12 required the accepted Phase 2
AST framework after the rebase (`phase-03-plan.md:524,843,850`, `phase-03-exit-criteria.md:64,67` at `98e92cf`;
R8, R15).

**Disposition.** ACCEPTED.

**Locked change.** Two checkpoints (architecture §3; plan §25, CR-12, CR-13):

- S2: a package-local self-check, `packages/orchestration/src/purity.test.ts` (`asep-suite:orchestration-purity`).
  It does not touch `scripts/forbidden-imports.test.ts` or the shared rule framework.
- S7, after G-P2: the same rule in `scripts/forbidden-imports.test.ts` on the accepted framework.

The package-local suite stays registered after S7, because `REQUIRED_SUITES` is append-only (R10).

**Validation.** B2 (split into the two checkpoints).

### P3-PLAN2-MED-002 — The purity rule covered tests that need runtime imports — ACCEPTED

**Finding.** B2 applied to all of `packages/orchestration/src/**` with `import type` only, but the required suites
live there and use runtime imports (`phase-03-exit-criteria.md:67`, `phase-03-plan.md:858` at `98e92cf`; pattern
`packages/domain/src/operational.test.ts:1-2`).

**Disposition.** ACCEPTED.

**Locked change.** The rule scans production source only: `src/**/*.ts` except `*.test.ts` and
`src/test-support/**` (architecture §3). Production modules may import each other relatively. External imports
stay `import type` from `@asep/contracts` and `@asep/ports` only, and the nondeterminism constructs stay banned.
Tests may use `node:test`, `node:assert/strict` and the module under test. S2's fixtures move from
`src/test-fixtures.ts`, which the `a133e32` check scanned as production source, to `src/test-support/`.

**Validation.** B2: seeded violations fail, a valid construct passes, and the scanned file set excludes tests and
test support.

### P3-PLAN2-MED-003 — Per-slice gates had reverse dependencies — ACCEPTED

**Finding.** S0 had to pass O1 with `NotConfiguredAssuranceSlot`, which S6 implemented, and S7 delivered a strict
replay suite whose corpus only S8/S10/S11 produce (`phase-03-plan.md:522,528,529,543`,
`phase-03-architecture.md:281`, `phase-03-exit-criteria.md:42` at `98e92cf`).

**Disposition.** ACCEPTED.

**Locked change.**

- **Default slot.** S0 lands a minimal `NotConfiguredAssuranceSlot` in
  `packages/application/src/orchestration-activities/`, so O1 holds in S0 and J2 is proven from S0. S6 only binds
  it into the activity wrapper (plan §25, §26, CR-10).
- **Replay bootstrap.** The replay suite becomes required in S8, the first slice with a real server, with its
  seeded non-deterministic fixture, the first captured histories and `required-scenarios.json` listing exactly
  those scenarios. S10 and S11 append scenarios with their histories in the same commit, and the suite fails if a
  listed scenario lacks a history. S13 asserts that the list equals the full set (architecture §6.5; exit B5).
  Nothing is skipped, the manifest is never empty once the suite exists, and the final B5 is unchanged. Risk
  PR3-37.

**Validation.** O1 and J2 in S0; B5 staged in S8, S10 and S11, final in S13.

### P3-PLAN2-MED-004 — The callback injector sat outside the Temporal SDK boundary — ACCEPTED

**Finding.** CR-16 added `@temporalio/client` to `workers/temporal-worker` for `AsyncCompletionClient`, which B1
and architecture §3 forbid without a test exception (`phase-03-plan.md:937`, `phase-03-exit-criteria.md:64`,
`phase-03-architecture.md:109` at `98e92cf`).

**Disposition.** ACCEPTED.

**Locked change.** `workers/temporal-worker` gets no `@temporalio/*` dependency (CR-16). The CX-35 injector and
the CX-36 duplicate-delivery wrapper live in `adapters/temporal/src/test-support/` and export helpers whose
signatures use no SDK type. The confinement rule's allowed scope includes that directory, with no test exception
(architecture §3). Ownership: plan §31.

**Validation.** F16 amended; F17; B1.

### P3-PLAN2-MED-005 — A retry of a repair attempt had no lineage rule — ACCEPTED (R17)

**Finding.** Abandonment turned the next attempt into `kind = retry`, but only `repair` attempts carried the repair
base and ContextPack, so a retry could fall back to the task base (`phase-03-architecture.md:134,149,161,590`,
`phase-03-data-model.md:108` at `98e92cf`).

**Disposition.** ACCEPTED. R17 decides it.

**Locked change.** Attempt kind and repair lineage are separate (architecture §4.1 "Attempt kind and repair
lineage are separate", §12 "Repair"). A retry copies the lineage of the attempt it replaces: same `repairBaseSha`,
repair order, round and prior adjudication. Data model §3: `attempts_lineage_shape` replaces
`attempts_repair_shape`; a retry copies parent, repair order and `base_sha`, while round and prior adjudication
live in workflow state. The repair-workspace ordering covers the whole lineage. Risk PR3-36.

**Validation.** J4 amended with the trace `REPAIR` → agent death → replacement → assurance. S2 core trace 3; S11
e2e.

### P3-PLAN2-MED-006 — Drain-only stopped the workers before draining — ACCEPTED

**Finding.** The procedure stopped the old workers and then waited for open workflows to finish, which nothing
could then run (`phase-03-architecture.md:296,122` at `98e92cf`).

**Disposition.** ACCEPTED.

**Locked change.** Architecture §6.6: (1) stop new executions (API 503); (2) keep the old workers; (3) wait until
no open workflow remains on the task queue; (4) stop the old workers; (5) start the new build and re-enable
starts. Risk PR3-14; exit M1; runbook in S13.

**Validation.** M1.

### P3-PLAN2-MED-007 — The log still let measurement write operational `run_events` — ACCEPTED (R15)

**Finding.** Escalation item 2 still offered a fabricated `runs` row for benchmark replays, or dropping the FK,
after R15 had ruled both out (`phase-03-review-log.md:374`, `phase-03-data-model.md:283` at `98e92cf`).

**Disposition.** ACCEPTED.

**Locked change.** Escalation item 2 is closed as resolved by R15. The composite FK stays. Benchmark, replay and
corpus measurement never write operational `run_events`; their outputs go to Lane B's measurement storage. Neither
a fabricated run row nor dropping the FK remains an option. Data model §3.7 "Storage boundary"; threat T3-17.

**Validation.** O2 gains the case "event for a run with no `runs` row in the tenant → rejected" (S0).

### v1 findings the lock-check marked PARTIAL

#### P3-PLAN-HIGH-004 — The slot did not match Phase 4 — ACCEPTED; verbatim part open by design until G-LB

**Lock-check.** Semantics, repair base and terminal hook changed for real, but the TypeScript contract, its source
SHA and the byte comparison were still pending.

**Disposition.** ACCEPTED. The remaining part cannot be closed by Lane A: R18 hands the block over only after
Lane B fixes it. v3 records what the fixed block brings and what S0 does with it (architecture §12; plan §20,
CR-10):

- location `packages/application/src/review-loop/` (R16);
- two default slots: Lane A's `NotConfiguredAssuranceSlot` fails closed for any risk that requires review, and
  Lane B's `DisabledAssuranceSlot` is the explicit opt-out;
- the terminal vocabulary `verification-stopped` plus specific failure terminals;
- the workspace resolver port, implemented by Lane A over the lease table (S3, exit E15: wrong tenant, wrong
  lease, stale epoch);
- the fixed logical time, the `ArtifactRef` envelope within 64 KiB, and `shadow` only on `PROCEED`.

The lock-check's normalization note is folded as exit O5: S0 renames the core's local slot types and terminal
names to the block's, and a table test drives the core with each locked outcome, including `repairBaseSha`, the
repair order, `nextRound` and the adjudication lineage.

**Freeze gate.** This is the one open item, and S0 cannot start without it (G-LB).

#### P3-PLAN-MED-003 — Retention flag, value and read-back — ACCEPTED, folded

The flag was observed on the pinned image in this step: `temporal operator namespace create --help` lists
`--retention duration` (default `72h0m0s`), and the global `--output` accepts `json` (research register §2, Q9
resolved). The gate creates its namespace with `--retention 24h` and reads it back (exit C10, new). Production
uses `720h` unless the pre-deployment review decides otherwise, read back by the smoke (C9; architecture §16). The
JSON field that carries the retention is **not verified**, because it needs a running server; S8 pins it from the
gate's first real run.

#### P3-PLAN-MED-004 — Replay corpus bootstrap and drain order — ACCEPTED, folded

Both remaining parts are the new findings P3-PLAN2-MED-003 (bootstrap) and P3-PLAN2-MED-006 (drain order), folded
above.

#### P3-PLAN-LOW-001 — Pull and inspect output — ACCEPTED, folded

C1 and M3 now require the full `docker pull` and `docker image inspect` RepoDigests output of every pinned
Temporal image in the gate log, preserved under `artifacts/phase-03/` (CR-14).

### Other lock-check observations folded

- **Upgrade path.** S0 lands `0107` before S3's lower ids. The migrator checks a strictly ascending set
  (`adapters/persistence/src/migrator.ts:45-52`) and visits every migration, applying those not yet recorded
  (`:100-123`). A5 now exercises the real path: the Phase 2 head, then S0, then S3.
- **Migration count.** Seven ids are used (`0100`–`0102`, `0104`–`0107`) and `0103` is intentionally unused. No
  change.

### Reconciliation R15–R19 applied

- **R15.** S2 is the only slice before the rebase (`a133e32`) and appends only to the allowed registries; the
  `run_events` FK stays with the measurement boundary (MED-007); the fixed logical time is in architecture §12.
- **R16.** Slot location (plan §20, CR-10, §31; architecture §12); the gateway note in the lock-check's
  provenance; the reviewer model.
- **R17.** P3-PLAN2-HIGH-001…003 and MED-005, above.
- **R18.** The fixed block before hand-off (G-LB) and its known content, under P3-PLAN-HIGH-004 above.
- **R19.**
  - Budget-scope refinement: architecture §10; exits H3, J4.
  - Assurance-activity failure: shadow mode → audited `assurance-unavailable`, continue as `PROCEED`; gating mode
    → `ESCALATE`; never `FAILED` (architecture §4.1, §12; data model §4.2 `governance.assuranceMode`; exit J10,
    new; risk PR3-35; threat T3-18). At `a133e32` this ended the task `FAILED`
    (`packages/orchestration/src/task-core.ts:561-562`); the S2 follow-up commit changes it.
  - `maxBudgetExtensionUsd` has no default in code: architecture §10, §11; data model §4.2; risk PR3-38.
  - Accepted as proposed: the `VERIFYING → BUDGET_EXHAUSTED` edge (data model §4.1, S1); `cancelApprovalRequest`
    and `recordAudit` (architecture §5); admission-activity failure → `BLOCKED (admission-unavailable)` and
    `ensureAttempt` failure → `FAILED` without replacement (architecture §4.1); lease renewal while paused or
    waiting is S7's interpreter; the test-only `@asep/domain` devDependency.
  - Memory: lanes never touch the controller's memory directory (lane-contract addendum).

### R20: controller answers to the S2 follow-up questions

Lane A's S2 follow-up report (`5e9fb84`) raised four implementation choices. R20 settles them.

- **Reversed: a non-replaceable failure class beats the exhaustion path.** At `5e9fb84` any agent result with an
  overrun, or a cap stop, took the exhaustion path first (`packages/orchestration/src/task-core.ts:520`), so an
  agent failure with a never-replaceable class that also overran ended `BUDGET_EXHAUSTED`. The exhaustion path can
  lead to a budget extension and a new attempt, which must never follow such a failure. Commit `5b0afde` checks the
  failure class first (`task-core.ts:522-527`): a `FAILED` or `BLOCKED` result, or a cap stop that reports a
  failure class, whose class the policy does not list as replaceable (an unclassified failure included) is
  abandoned, and the task ends `FAILED` with that class. The overrun is still recorded and audited as an incident.
  Treating a cap stop that reports a non-replaceable class the same way applies R20's reason to the one other
  result that reaches the exhaustion path; it is Lane A's reading and is flagged for the controller. Tests, written
  first and red on `5e9fb84`: the four core traces "agent outcome: a non-replaceable failure beats the exhaustion
  path (…)" and a new property in "generated task traces satisfy the orchestration safety invariants" (no attempt
  follows a non-replaceable agent failure, and the task ends `FAILED` or `CANCELLED`). Architecture §4.1 and §10,
  exits H8 and H10, and plan §11, §18 and §26 (S2) are amended.
- **Accepted as implemented:**
  - an inspection that fails on an exhausted attempt is a normal abandon (`failed`, retried only for a replaceable
    class) (`task-core.ts:623-626`; architecture §4.1; exit H10);
  - out of attempts beats budget: after an exhausted attempt with no attempt left the task ends
    `FAILED / attempts-exhausted`, so H8 ends `BUDGET_EXHAUSTED` only while attempts remain (`task-core.ts:692-695`;
    architecture §10; exit H8);
  - verification wall-clock is charged at the reserved amount until verification results carry measured time
    (`task-core.ts:403`; architecture §10).
- **One switch.** "Approvals disabled" and "`maxBudgetExtensionUsd` unset" are the same condition. The wording is
  merged in this log, the exit criteria (J4), architecture §4.1 and §10, and plan §11 and §26.

### Freeze gate (v3)

- [x] Every lock-check finding dispositioned: 10/10 new, 4/4 v1 PARTIAL.
- [x] 0 unresolved CRITICAL/HIGH, **except** the verbatim-text part of P3-PLAN-HIGH-004, which is open by design
      until G-LB and blocks S0.
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] S2's acceptance carries the four core traces the lock-check asked for; S11 carries the matching e2e.
- [x] Reconciliation R15–R20 applied.
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**PLAN_STATUS (v3):** LOCKED v3, superseded by v4 below. The independent review of v3 found two plan gaps the
v3 gate did not catch (run drain below `maxTasks`, wall-clock overrun) and nine S2 code defects.

---

## Review v3

> Lane A adjudication of the independent Codex review of plan v3 and audit of the S2 code.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-29. The
> Codex CLI 0.147.0 binary was already loaded when the run started; the installed CLI is 0.165.0. The gateway
> appends its own style instructions and tools (R16). Raw output: `phase-03-review-codex-v3.md`.
> Reviewed snapshot: `5e9fb84` · Verdict: **REQUEST_CHANGES** · Confidence: 0.98. The review predates `5b0afde`
> and `e4fd343`, which apply R20.
> Binding input: reconciliation R21, the controller's final decisions on the behavioral findings. Lane A applies it
> exactly as written. Code line numbers below are at `e4fd343` unless a finding quotes the review's `5e9fb84`
> numbers. Between the two, production code differs only by the R20 change (`task-core.ts`: the agent outcome and
> `isReplaceable`; one comment in `types.ts`), per `git diff --stat 5e9fb84 e4fd343`.

### Summary

The review confirms every v2 finding FOLDED except P3-PLAN-HIGH-004, which stays PARTIAL by design until G-LB
(R18): the verbatim slot block, its source SHA and the byte comparison. It confirms R1–R20 at the plan level and
raises 15 new findings.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| Plan HIGH (P3-PLAN3-HIGH-001, 002) | 2 | 2 | 0 | 0 |
| Plan MEDIUM (P3-PLAN3-MED-001…003) | 3 | 3 | 0 | 0 |
| S2 HIGH (P3-S2-HIGH-001…005) | 5 | 5 | 0 | 0 |
| S2 MEDIUM (P3-S2-MED-001…005) | 5 | 5 | 0 | 0 |
| **Total** | **15** | **15** | **0** | **0** |

Three findings were already resolved before this step, and this log confirms them with evidence instead of
redoing them: P3-PLAN3-HIGH-001 and P3-S2-HIGH-001 (R20, `5b0afde`) and P3-PLAN3-MED-003 (`e4fd343`). The other
twelve are folded into design, exit criteria and slices below. The nine S2 code findings among them are fixed by
the S2 follow-up commits after this docs commit, test first; each new test fails on `e4fd343`, and the step report
names the commits and how each test failed.

New exit criteria: D13–D15, G13, G14, H11, H12, I8, I9. Amended: B2, D7, G7, H8, J5, M1.

### P3-PLAN3-HIGH-001 and P3-S2-HIGH-001 — Overrun beat a never-replaceable failure — ACCEPTED, already fixed (R20)

**Finding.** At `5e9fb84` an agent failure with a never-replaceable class that also overran took the exhaustion
path (`task-core.ts:520` at `5e9fb84`; architecture §10 row order).

**Evidence that it is resolved.** `5b0afde` checks the failure class first: `task-core.ts:522-527` abandons a
`FAILED` or `BLOCKED` result, or a cap stop reporting a class, whose class is not replaceable, and the task ends
`FAILED` with that class. The overrun is still recorded and audited (`recordUsage`, `task-core.ts:415-418`).
Architecture §10 row 2 and exit H8 state the rule. Tests: the four traces "agent outcome: a non-replaceable failure
beats the exhaustion path (…)" (`decide.test.ts:851-876`) and the property at `invariants.test.ts:330-344`; all were
red on `5e9fb84` (R20 entry above). The audit asked for all three classes with an overrun. The R20 traces cover
`policy-violation` (cost) and `false-completion` (tool calls). The hostile-policy table of P3-S2-HIGH-002 below adds
each of the three classes with a cost overrun, under a policy that lists the class as replaceable.

### P3-PLAN3-HIGH-002 and P3-S2-HIGH-004 — A run below `maxTasks` never closes, so drain never ends — ACCEPTED (R21)

**Finding.** The run reducer completes only on cancel or once `finishedTasks >= maxTasks`
(`run-core.ts:236-246`). A run with one finished task and a cap of ten stays open with an empty queue, and the
drain procedure (architecture §6.6) waits for every workflow to close.

**Disposition.** ACCEPTED. R21 decides the protocol.

**Locked change.**

- A run gains an explicit `seal` control. After it, no task submission is accepted (receipt `run-sealed`); a
  duplicate submission of a known task id still returns the original receipt. A second seal is refused
  (`already-sealed`), and a repeated request id is a duplicate.
- A run may be created already sealed with a fixed task list (`run-workflow-input.fixedTasks`, data model §4.2).
- A sealed run completes `COMPLETED` as soon as no task is open (none active, none queued), whatever `maxTasks`
  says. `maxTasks` stays a cap on submissions, not the only completion path.
- The sealed flag is carried across continue-as-new.
- Drain = stop new executions, seal every open run, keep the workers until no workflow is open, then stop them
  (architecture §6.6, exit M1).

The seal is an accepted control like pause and resume: it is audited (`workflow.seal`) with a `human.intervention`
event (`interventionKind: seal`, data model §4.3) and needs `executions:control` (plan §10, `POST
/v1/runs/:runId/seal`).

**Validation.** D15 (new): a run below `maxTasks` closes after seal, including a seal that arrives while a child is
running; a run created sealed with a fixed list closes after its last task; the seal survives continue-as-new;
a submission after the seal is refused. D7 amended; M1 amended. S2 core traces; S8/S9 e2e and route.

### P3-PLAN3-MED-001 and P3-S2-HIGH-005 — Wall-clock overrun was not an overrun — ACCEPTED (R21)

**Finding.** The overrun detector compared only reported cost and tool calls (`task-core.ts:364-384`). An
`AGENT_DONE` that ran 34 minutes on a 30-minute cap was verified, committed and published; the audit counted 19
such traces among 600 generated seeds. The architecture said usage had to be within every cap, while the overrun
row listed only cost and tool calls (architecture §10 at `5e9fb84`).

**Disposition.** ACCEPTED. R21 decides the behavior.

**Locked change.** Harness-measured attempt wall-clock above the attempt cap is an overrun exactly like cost or
tool calls: inspect only, no verification, commit or publication, `recordOverrun` with the wall-clock excess, an
audited incident, and the recorded overrun ends the task at the next reservation. The only tolerance is the
kill-escalation grace: the interval between the agent adapter's stop signal and its hard kill. It is policy data,
`policy.agentKillGraceSeconds` (data model §4.2), not a business allowance. Its code default is 0 (no tolerance).
The policy file sets it to the adapter's documented stop-to-kill interval, which CR-25 pins in S4. The rule applies
to every agent status, and a non-replaceable failure still beats it (R20). Architecture §4.1, §10; plan §18.
Consequence flagged for the controller: today's adapter sends `SIGKILL` the moment its timer fires
(`adapters/agent-claude/src/claude-provider.ts:229-235`), so its interval is 0. A wall-clock cap stop measured even a
millisecond past the cap is then an overrun and ends the task at the next reservation instead of being retried.
That is fail-closed and follows R21's text; if retries after wall-clock stops are wanted, S4 must define a real
stop-to-kill interval.

**Validation.** H11 (new): `AGENT_DONE` at the cap and at cap + grace gets the full path; one millisecond above
cap + grace is inspected only, records the overrun and an incident, and publishes nothing. H8 amended. The property
generator emits wall-clock at, around and above cap + grace, and checks that no attempt measured above it is
verified or published.

### P3-PLAN3-MED-002 — The canonical approval message had no extension amount — ACCEPTED

**Finding.** `workflow-control/v1` `approval-decision` carried no `extensionUsd` (data model §4.2 at `5e9fb84`),
while the core DTO carries one (`types.ts:351-358`) and a budget-extension approve without a valid amount is
rejected before verification (`approvals.ts:28-34`, `:57-59`).

**Disposition.** ACCEPTED.

**Locked change.** The canonical `approval-decision` message carries `extensionUsd`: a number, non-null exactly for
a `budget-extension` approve, positive, at most the policy bound and exactly representable in micro-USD (H12);
null otherwise. The API decision body carries the same field, and `approval_decisions.extension_usd` stores it
(data model §3.5, already there). The S7 control mapping turns the message into the core's
`approvalDecisionReceived` with the same amount. Plan §10, §19, CR-02; architecture §11.

**Validation.** I8 (new): a mapping test in S7 (`adapters/temporal`): a budget-extension approve with a valid amount
reaches `verifyApprovalDecision` with that amount; a missing, zero, inexact or out-of-bound amount, and an amount
on any other decision, is refused by the validator before any state change.

### P3-PLAN3-MED-003 — H8 and the disabled/unset wording — ACCEPTED, already folded (`e4fd343`)

**Evidence.** H8 states the attempts-exhausted exception ("with none left the task ends
`FAILED / attempts-exhausted`, R20") and the non-replaceable precedence (`phase-03-exit-criteria.md:366-371` at
`e4fd343`). The disabled/unset wording is one condition everywhere: architecture §10 (`phase-03-architecture.md:596-598`),
this log (P3-PLAN2-HIGH-002 and the R20 entry) and J4. No change in this step.

### P3-S2-HIGH-002 — "Never replaceable" held only for the default policy — ACCEPTED (R21)

**Finding.** `isReplaceable` trusted the policy list alone (`task-core.ts:703-706`). A policy listing
`policy-violation` made the reducer retry the attempt, and the retry could publish.

**Disposition.** ACCEPTED.

**Locked change.** The core holds the three never-replaceable classes (`policy-violation`, `false-completion`,
`duplicate-side-effect`) as a constant and never treats them as replaceable, whatever the policy says. It exports a
policy validator that reports such a policy as invalid. The orchestration policy loader (S6,
`packages/policy/src/orchestration-policy.ts`) rejects a policy file that lists any of them, using that rule, and
the S7 input mapping rejects a task input whose resolved policy does. Architecture §4.1; plan §26 (S2, S6, S7).

**Validation.** D14 (new): for each of the three classes, a hostile policy that lists it as replaceable still ends
the task `FAILED` with that class after one attempt, with and without a cost overrun, and nothing is published
(core table, S2); the validator reports each class (S2); the loader rejects each class (S6).

### P3-S2-HIGH-003 — A failing PR upsert after a push let a cancel finish `CANCELLED` — ACCEPTED (R21)

**Finding.** With a cancel pending after a successful push, a failing PR upsert closed the task `FAILED`, which
`close()` then turned into `CANCELLED` with no PR (`task-core.ts:642-645`, `:1033-1037`). The remote held a branch
without its PR, and the task said nothing about it.

**Disposition.** ACCEPTED. R21 decides the behavior.

**Locked change.**

- A cancel never finalizes while a publication unit is unreconciled.
- After a successful push, or an ambiguous one (the push activity failed retryably after its retries, or timed
  out), the PR upsert runs and keeps retrying under its retry policy (architecture §5).
- If the PR upsert finally fails (a non-retryable error, or its retries are exhausted), the task ends
  `FAILED / publication-incomplete`, never `CANCELLED`. The audit entry `publication.incomplete` names the remote
  branch and says whether the push was confirmed, so a human can reconcile it. The branch-without-PR state is
  reported, not hidden.
- A push that fails non-retryably is definite: nothing was pushed, and the task ends `FAILED / publication-failed`
  (`CANCELLED` if a cancel is pending).

Treating "retries exhausted" like "non-retryable" is Lane A's reading of "fails non-retryably": once the activity's
bounded retry policy ends, the engine retries no more. It is flagged for the controller. Two supporting changes:
the core learns the attempt's remote branch name from `ensureAttempt` (the attempt branch rule stays the Git
adapter's, `packages/application/src/vertical-slice-workflow.ts:27`), and an activity failure tells the core whether
the engine stopped on a non-retryable error. Architecture §4.1, §5, §9; threat T3-19 and risk PR3-18 amended.

**Validation.** G13 (new), core table: a cancel during the push, then a failing PR upsert, ends
`FAILED / publication-incomplete` with the audit naming the branch (push confirmed); an ambiguous push failure
still runs the PR upsert (success → the PR exists and the cancel ends `CANCELLED` with the PR left open and audited;
failure → `publication-incomplete`, push unconfirmed); a non-retryable push failure runs no PR upsert. The property
"an accepted cancel ends `CANCELLED`" now allows `FAILED / publication-incomplete` and nothing else. Real proof in
S11.

**Superseded in part by R24 (section "Review v4").** Retryability no longer decides whether a push happened: the
publication effect (`applied`, `none`, `unknown`) does, and an `unknown` effect is reconciled against the remote
before any terminal state.

### P3-S2-MED-001 — Rounding hid small overruns — ACCEPTED (R21)

**Finding.** `toMicroUsd` rounded (`budget.ts:8-10`), so a reported cost of `5.0000004` on a cap of `5` was no
overrun and published. Nothing bounded the precision or range of the amounts.

**Disposition.** ACCEPTED.

**Locked change.** Budget arithmetic stays in integer micro-USD. Reported usage converts with ceiling from its exact
decimal value, so no overrun is ever rounded away. Caps, reserves, the run remainder and extension amounts must be
exactly representable in micro-USD and at most `100 000 000` USD each, which keeps every sum the core forms within
the safe-integer range. The workflow-input mapping rejects anything else (S7), the core exports the rule, and an
extension amount outside it is refused like an out-of-bound one. A reported cost above that bound is charged at the
bound (it is an overrun either way). The bound is Lane A's choice within R21's "safe-integer range" and is flagged
for the controller. Architecture §10; data model §4.2.

**Superseded in part by R24 (section "Review v4").** "An overrun either way" was false at a cap equal to the bound;
overrun detection now compares usage with the cap before any clamping, and a usage value outside its bound is
itself an overrun.

**Validation.** H12 (new): `5.0000004` on a cap of `5` is an overrun of `0.000001`; `1.1` on `1.1` is none; a
sub-micro usage is charged one micro-dollar; inexact, negative, non-finite and out-of-range amounts are rejected by
the input rule. The property oracle no longer reuses the implementation's conversion: caps are generated with
fractional cents, and the oracle decides overruns by comparing the reported number with the cap directly.

### P3-S2-MED-002 — The regex purity check missed evasions — ACCEPTED (R21)

**Finding.** The detector missed `const m = Math; m.random()`, `Math["random"]()`, a re-export with a comment
(`export /* bridge */ { readFileSync as read } from "node:fs"`), and relative imports that leave the package or reach
test support (`purity.test.ts:117-150`).

**Disposition.** ACCEPTED.

**Locked change.** The package-local check becomes AST-based. It parses every production file with the TypeScript
compiler API the repo already depends on (TypeScript 7.0.2, `typescript/unstable/sync` over an in-memory file
system; research register Q11), and does not touch the shared fitness framework (R8). Rules: type-only status from
the import clause and each specifier; the target of every relative import or re-export must stay in `src/`, outside
`src/test-support/**`, and not be a test file; import-equals, dynamic `import()` and import types from other sources
are flagged; banned names are matched on the decoded identifier, so escapes do not hide them; `Math` is allowed only
as `Math.<member>` for a fixed list of pure members (`abs`, `ceil`, `floor`, `imul`, `max`, `min`, `round`, `sign`,
`trunc`); `Function` joins the banned names. Architecture §3; exit B2.

**Validation.** B2 amended. Seeded cases: alias, computed access, commented re-export, escaped identifier,
`export *` out of the package, imports of test support and of a test file, import-equals, an import type, and the
`Function` constructor; the earlier seeds stay; a clean set (mixed type specifiers, allowed `Math` members) passes.

### P3-S2-MED-003 — Pause while waiting for an approval did nothing visible — ACCEPTED (R21)

**Finding.** A pause during an approval wait only set `paused` (`task-core.ts:976-981`): no `PAUSED` projection and
no pause timer, because no request was in flight to reach a boundary.

**Disposition.** ACCEPTED.

**Locked change.** When no request is in flight, a pause applies at once: the task projects `PAUSED` and the pause
timer starts. A pause that arrives while an approval request is being opened or a decision verified applies as soon
as that request returns, if the task is still waiting. The approval expiry keeps its own timer, and pause does not
suspend it. A decision that arrives while paused is still verified (as before); if it releases the gate, the next
request is withheld until resume. Resume returns the projection to `WAITING_FOR_APPROVAL` while the request is still
open. Data model §4.1 gains `WAITING_FOR_APPROVAL → PAUSED`, `PAUSED → WAITING_FOR_APPROVAL` and
`PAUSED → BUDGET_EXHAUSTED` (an extension that expires or is rejected while paused); S1 adds them to the domain
table. Architecture §9, §11.

**Validation.** G14 (new), core table, for both approval kinds: pause in the wait projects `PAUSED` and starts the
pause timer; resume projects `WAITING_FOR_APPROVAL`; approval expiry while paused takes the kind's reject path; the
pause timeout while waiting ends the task `BLOCKED` and closes the request with `cancelApprovalRequest`.

### P3-S2-MED-004 — Two approval defenses had no test that kills them — ACCEPTED (R21)

**Finding.** Two mutations kept all 107 package tests green: dropping the `ap.expiryFired` branch
(`task-core.ts:887-890`) and dropping the `result.verified` check (`:891-893`). The interpreter delivered timers only
while idle (`sequential-interpreter.ts:103-107`), and the generator paired `verified: false` only with a null
decision (`invariants.test.ts:190`).

**Disposition.** ACCEPTED.

**Locked change.** The interpreter can deliver timer firings while a request is pending, as Temporal does.
Direct traces cover the two races for both approval kinds. The generator emits timers during pending requests and
`verified: false` together with a valid decision and amount, and the oracle replays the trace step by step: a gate is
released (an extension recorded, or the publish-change push issued or withheld for a pause) only by the result of a
`verifyApprovalDecision` that is verified, says approve, and arrives before that request's expiry fired.

**Validation.** I9 (new): the direct traces and the step-aligned oracle; with either mutation applied, at least one
test turns red (the step report records the runs).

### P3-S2-MED-005 — Attempt effects for an attempt that may not exist — ACCEPTED (R21)

**Finding.** The core added the attempt to its state when it issued `ensureAttempt` (`task-core.ts:288-317`). When
`ensureAttempt` failed, `close()` still emitted usage and an outcome for it (`:615-618`, `:1040-1043`), even if the
insert never happened, so an effect could carry `attemptId: null`.

**Disposition.** ACCEPTED.

**Locked change.**

- No attempt-bound effect (usage, outcome) is emitted for an attempt whose registration has not reconciled.
- `ensureAttempt` becomes non-cancellable (a short registration write, like the approval gate writes), so a cancel
  waits for it.
- When it fails, the core issues `findAttempt` (a non-cancellable lookup by the natural key
  `(task_id, attempt_number)`). Found means the insert committed: the attempt ends `failed` with zero usage. Absent
  means it failed before the insert: no attempt-bound effect. If the lookup fails too, the registration is unknown:
  no attempt-bound effect, and an audited `attempt.registration-unreconciled` names the attempt number for a human.
- In all three the task ends `FAILED / attempt-registration-failed` and the attempt is never replaced, so numbering
  stays contiguous.

Architecture §4.1, §5.

**Validation.** D13 (new), core table: the three lookups. J5 amended: one outcome and one usage entry per
**registered** attempt.

### S2 follow-up commits

One commit per S2 code finding, on top of the docs commit `ecf7b1c`. Each fix commit's new tests failed on the code
before it; the two test-only commits are proven by the mutations and evasions they kill. `pnpm verify:all` passed
after each commit.

| Finding | Commit | Proof |
|---|---|---|
| P3-S2-HIGH-002 | `f5fd317` | Hostile-policy table, loader rule and property: red before the fix. |
| P3-S2-HIGH-005 | `40676fd` | Wall-clock traces at cap, cap plus grace and above, and property: red before the fix. |
| P3-S2-MED-001 | `dd67fce` | `5.0000004` on `5`, sub-micro charge, input rule and property: red before the fix. |
| P3-S2-HIGH-003 | `867257d` | Publication-incomplete traces and property: red before the fix. |
| P3-S2-MED-005 | `10d072f` | Registration lookups and property: red before the fix. |
| P3-S2-HIGH-004 | `d0fa252` | Seal traces below `maxTasks` and across continue-as-new, and run property: red before the fix. |
| P3-S2-MED-003 | `d5c6aa2` | Approval-wait pause traces for both kinds, projection edges and step-replay property: red before the fix. |
| P3-S2-MED-004 | `ec9e420` | Dropping the `expiryFired` branch or the `verified` check turns direct race traces and the gate oracle red. |
| P3-S2-MED-002 | `4d6ce51` | 15 of the 33 seeds and the clean set fail under the regex detector; all pass on the AST detector. |

The interpreter hook `messagesDuring(request)` became `eventsDuring(request, activeTimers)` in `ec9e420`, so timer
firings can arrive while a request is in flight.

### Freeze gate (v4)

- [x] Every finding of the review dispositioned: 15/15 new; the v2 statuses confirmed, P3-PLAN-HIGH-004 still PARTIAL
      by design.
- [x] 0 unresolved CRITICAL/HIGH in the plan, **except** the verbatim-text part of P3-PLAN-HIGH-004, which is open by
      design until G-LB and blocks S0. The S2 code HIGHs are folded here and fixed by the follow-up commits.
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] Reconciliation R21 applied.
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**PLAN_STATUS (v4):** LOCKED v4, superseded by v5 below. The re-audit of v4 found two plan gaps and a register
drift (section "Review v4").

## Review v4

> Lane A adjudication of the independent Codex re-audit of plan v4 and of the S2 fixes.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-29 as a single
> uninterrupted run of the Codex CLI 0.165.0; the gateway's own instructions apply (R16). Raw output:
> `phase-03-review-codex-v4.md`.
> Reviewed snapshot: `7694b8b` · Verdict: **REQUEST_CHANGES** · Confidence: 0.98.
> Controller gate at `7694b8b`, clean detached worktree: `pnpm verify:all` three runs in a row, each exit 0, 731 pass,
> 0 fail, 0 skipped; 53 test files, 31 required suites; no V8 crash.
> Binding input: reconciliation R24, the controller's final decisions on this re-audit. Lane A applies it exactly as
> written. Code line numbers below are at `7694b8b` (the code is unchanged between `7694b8b` and this docs commit).

### Summary

The re-audit confirms the five P3-PLAN3 findings FOLDED and P3-PLAN-HIGH-004 still PARTIAL by design until G-LB
(R18). Of the ten v3 S2 findings, seven are RESOLVED, each turned red by the reviewer's own removal of its fix, and
three are PARTIAL: P3-S2-HIGH-003, P3-S2-MED-001 and P3-S2-MED-002. It raises seven new findings.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| Plan HIGH (P3-PLAN4-HIGH-001, 002) | 2 | 2 | 0 | 0 |
| Plan MEDIUM (P3-PLAN4-MED-001) | 1 | 1 | 0 | 0 |
| S2 HIGH (P3-S2R-HIGH-001, 002) | 2 | 2 | 0 | 0 |
| S2 MEDIUM (P3-S2R-MED-001, 002) | 2 | 2 | 0 | 0 |
| **Total** | **7** | **7** | **0** | **0** |

Each v3 finding the review marks PARTIAL is closed through the new findings that name its remaining gap:

| v3 finding | Remaining gap | Closed through |
|---|---|---|
| P3-S2-HIGH-003 | a non-retryable push failure counted as "nothing pushed" | P3-PLAN4-HIGH-001, P3-S2R-HIGH-002 |
| P3-S2-MED-001 | clamping before the overrun check lost the overrun at a cap equal to `MAX_USD` | P3-PLAN4-HIGH-002, P3-S2R-HIGH-001 |
| P3-S2-MED-002 | a reflected constructor and a runtime module outside the scanned set passed | P3-S2R-MED-001, P3-S2R-MED-002 |

Two observations without an ID are settled by R24 and folded as well: drain with paused tasks, and the generator's
coverage of content-valid unconfirmed decisions. R24 also accepts the six lane choices reported at `7694b8b` (PR
upsert finality after its retry policy, `MAX_USD` as the input bound, kill grace 0 for the current adapter,
`eventsDuring`, `typescript/unstable/*` in tests, the pause projection edges in S1) and adds one post-rebase
obligation (kill grace). The S2 code findings are fixed by the follow-up commits after this docs commit, one finding
or tight group per commit, test first; the step report names each commit, the tests that prove it and the mutation
check that shows them red without the fix.

New: data model §4.4; risk PR3-44, PR3-45; threat T3-22. Amended: architecture §3, §4.1, §4.2, §5, §6.6, §9, §10;
data model §3.6; exit B2, D4, G13, H8, H11, H12, I9, M1; plan §17, §26 (S2, S4, S6, S7) and the step table; risk
PR3-16, PR3-18, PR3-40, PR3-42; threat T3-13, T3-19; research Q11.

### P3-PLAN4-HIGH-001 and P3-S2R-HIGH-002 — Retryability was read as proof that nothing was pushed — ACCEPTED (R24)

**Finding.** Plan v4 and the core treated a non-retryable push failure as definite: nothing pushed, no PR upsert,
and a pending cancel could finalize (architecture §5 and §4.1 at `7694b8b`; `task-core.ts:700-705`). The error
mapping itself makes the Phase 2 fencing errors non-retryable, and `pushStep` calls `forge.pushBranch()` before
`log.complete()`, which throws `SideEffectFencingError` for a missing or foreign `PENDING` record
(`packages/application/src/pipeline-steps.ts:645-651`, `adapters/persistence/src/side-effect-log.ts:169-180`). So a
non-retryable failure can follow a completed push. The reviewer's `PUSH_PROBE` reproduced it: the push reached the
remote, failed non-retryably with a cancel pending, and the task ended `CANCELLED` with `prNumber: null`, no PR
upsert and no publication audit. The direct test (`decide.test.ts:1508-1511`) and the property oracle
(`invariants.test.ts:520-524`) both exempted non-retryable push failures.

**Disposition.** ACCEPTED. R24 decides the behavior.

**Locked change.**

- Every result and failure of `publishBranch` and `upsertPullRequest` carries the publication effect: `applied`,
  `none` or `unknown`. `none` is allowed only when the activity proves it failed before the forge call, or when a
  reconciliation read shows the effect absent. A fencing error after the forge call, a timeout or any error after
  the call started is `unknown`, retryable or not. A failure without an effect reaches the core as `unknown`.
- Retryability no longer reaches the core at all: the `nonRetryable` flag on activity failures is removed, so it
  cannot stand in for certainty again.
- `unknown` is reconciled before any terminal state by a read-only `reconcilePublication` (the attempt branch head
  and the open PR for it; non-cancellable, part of the publication unit, so neither pause nor cancel splits it).
  After the push: the branch at the attempt's commit → the PR upsert runs; branch absent → `FAILED /
  publication-failed` (`CANCELLED` with a cancel pending, since nothing was pushed); branch at another commit or a
  failing read → `FAILED / publication-incomplete`. After the PR upsert: PR found → as a successful upsert; none
  found, or a failing read → `FAILED / publication-incomplete`.
- `FAILED / publication-incomplete` keeps its audit row naming the remote branch and is never `CANCELLED`.
- The test and the property oracle that exempted non-retryable failures are rewritten: a task may end without a PR
  after a push request only when the push failed with effect `none` or the reconciliation found the branch absent.

Architecture §4.1, §5, §9; data model §4.4; plan §17, §26 (S2, S6, S7); risk PR3-18, PR3-40, PR3-44; threat T3-19.

**Validation.** G13 rewritten: the effect matrix for push and PR upsert, each with and without a cancel pending,
with the same outcome whatever the retryability, `PUSH_PROBE` as a direct trace, and the property oracle above; D4
pins the bridge's effect mapping (S7).

**Superseded in part by R27 (section "Review v5").** "PR found → as a successful upsert" was too weak: a PR found
at another head was taken as this attempt's. Both reconciliation paths now apply one identity predicate to the
observed branch tip and PR identity.

### P3-PLAN4-HIGH-002 and P3-S2R-HIGH-001 — Clamping before the overrun check hid an overrun at the bound — ACCEPTED (R24)

**Finding.** The plan allows caps up to `100 000 000` USD and also clamps reported usage to that bound before the
overrun check (`budget.ts:50-52`, `task-core.ts:407-416`), so "an overrun either way" (architecture §10 at `7694b8b`;
this log, P3-S2-MED-001) is false at a cap equal to the bound. The reviewer's `CAP_PROBE` (every money cap
`MAX_USD`, zero reserve, reported cost `MAX_USD + 1`) passed `taskInputErrors()` with no error and published with no
`recordOverrun`. The existing test only tried a huge cost on the default cap of 5 (`decide.test.ts:247-253`), and
the generator only produced small caps.

**Disposition.** ACCEPTED. R24 decides the behavior; `MAX_USD` stays the input bound.

**Locked change.** Usage is compared with the cap before any clamping. A usage value outside its representable bound
is itself an overrun (inspect-only, incident), whatever the cap: a reported cost above `MAX_USD`, and, as every
instance of the class, a cost, tool-call count or measured wall-clock that is negative, not a number or not finite.
The overrun records `usageOutOfBound: true`. Only the ledger amount saturates: a cost above the bound is charged at
the bound, an invalid cost at the attempt cap, an invalid wall-clock at the attempt's wall-clock cap. Architecture
§10 (outcome table and budget precision); data model §3.6 (`usage_out_of_bound`), §4.4; risk PR3-16; threat T3-13.

**Validation.** H12 amended: `CAP_PROBE` as a direct trace; usage one micro-USD above a cap equal to `MAX_USD`; usage
equal to that cap is not an overrun; usage above the bound and invalid usage are overruns with `usageOutOfBound`;
micro-USD boundaries next to the bound; the generator produces caps at and next to the bound.

### P3-PLAN4-MED-001 — Risk and threat registers still said an overrun always ends `BUDGET_EXHAUSTED` — ACCEPTED (R24)

**Finding.** PR3-16 and T3-13 still concluded that an overrun always ends the task `BUDGET_EXHAUSTED`
(`phase-03-risk-register.md:27`, `phase-03-threat-model-delta.md:62` at `7694b8b`), while H8 already carries the
two R20 exceptions.

**Disposition.** ACCEPTED.

**Locked change.** PR3-16 and T3-13 state the two exceptions exactly as H8 does: with no attempt left the task ends
`FAILED / attempts-exhausted`, and an agent failure whose class is not replaceable wins, ending the task `FAILED`
with that class while the overrun is still recorded and audited.

**Validation.** Documentation only; H8 is the executable criterion.

### P3-S2R-MED-001 — A reflected Function constructor passed the purity check — ACCEPTED (R24)

**Finding.** The detector matched denied names only in the AST shapes it listed (`purity.test.ts:64`, `:143`).
`Reflect.get(() => {}, "constructor")("return Date.now()")()` reaches the `Function` constructor and the clock
without naming either; the reviewer appended it to `task-core.ts` in memory and all 183 package tests stayed green.

**Disposition.** ACCEPTED.

**Locked change.** The check asks the TypeScript checker, as the Phase 2 guard does. In production core source,
`Reflect`, `Proxy`, `Function`, `eval` and `globalThis` are violations, and so is any `constructor`, `prototype` or
`__proto__` member, as an identifier or a literal key. A computed member access whose key type is not a finite union
of literals is a violation, and literal keys are checked against the deny set. The detector is a defence layer, not
a proof; the plan says so. Architecture §3; exit B2; risk PR3-42; threat T3-22.

**Validation.** B2 amended: the reflected constructor and its computed and member-access equivalents are seeded
violations; a clean-set control stays green.

### P3-S2R-MED-002 — Relative imports were checked by string, not by resolution — ACCEPTED (R24)

**Finding.** The detector normalized the specifier string but never proved the target is a scanned file
(`purity.test.ts:102-106`, `:211`). A relative `.mjs` module (outside the `.ts` scan) passed, as did
`./%74est-support/fixtures.ts` and `./decide.test.ts?cache`; the reviewer's hidden `.mjs` holding `Date.now()` kept
all 183 tests green.

**Disposition.** ACCEPTED.

**Locked change.** Every relative import, re-export and import type is resolved with the compiler's module
resolution, and its target must be a `.ts` file of the scanned production set. A non-`.ts` target, a specifier
without the `.js` extension, a percent-encoded path and a query or fragment suffix are violations, as is a specifier
that does not resolve. Architecture §3; exit B2; research Q11.

**Validation.** B2 amended: the hidden `.mjs`, `%74est-support` and `?cache` probes are seeded violations, with the
reflected constructor of MED-001.

### Observations settled by R24

- **Drain with paused tasks.** Seal does not resume a paused task: a sealed run whose queue waits behind a run pause
  stays open (`run-core.ts:287`), and a test requires it (`decide.test.ts:1683-1692`). This does not break R21's "no
  task open" condition. Drain now reports sealed runs held open by a paused task as blocking items for an operator
  to resume or cancel, and never resumes one itself. Architecture §4.2, §6.6, §9; plan §17; exit M1.
- **Generator coverage.** The `unconfirmed-approve` marker did not check the amount, so it counted a publish-change
  approve carrying an amount (seed 535 in the review), which is not content-valid (`approvals.ts:33`). The generator
  now emits a content-valid `verified: false` decision for each kind (`publish-change` with a null amount,
  `budget-extension` with a valid amount), and the marker checks validity per kind. Exit I9.
- **Post-rebase kill grace.** After the rebase onto the accepted Phase 2, the kill grace is re-derived from the
  accepted stop path (container stop timeout plus the bound on forced removal), and the tests bind to the adapter's
  constant, not a copied literal. Architecture §10; plan §26 (S4); exit H11; risk PR3-45.
- **Gate crashes.** If `verify:all` crashes again with `Check failed: end > addr.`, the step report records the
  suite, the run number and the machine load, and the crash rate; no silent rerun until green.

### S2 follow-up commits (v5)

One commit per finding or tight group, on top of the docs commit `5a3a801`. Each fix commit's new tests failed on the
code before it, and removing the fix again turned them red. `pnpm verify:all` passed after each commit.

| Finding | Commit | Proof |
|---|---|---|
| P3-S2R-HIGH-002 (P3-PLAN4-HIGH-001) | `56e8b61` | The reviewer's push probe (fencing error after the push, cancel pending) and the effect matrix for push and PR upsert, with and without a cancel, and the effect property: red before the fix. Treating an unknown push as failed, or skipping the upsert reconciliation, turns direct traces and the property red. |
| P3-S2R-HIGH-001 (P3-PLAN4-HIGH-002) | `08681fb` | The reviewer's cap probe (cap at `MAX_USD`, usage one micro-dollar above), usage beyond the bound, invalid usage, micro-dollar boundaries next to the bound, and the property with caps near the bound: red before the fix. Dropping the out-of-bound overrun turns them red. |
| P3-S2R-MED-001, P3-S2R-MED-002 | `9e2f708` | All 21 new seeds, including the four surviving probes, pass the previous AST detector. The reviewer's two mutations, applied to `task-core.ts` on disk, turn the production check red. Removing the resolution closure, the computed-key rule, the reflective-member rule or `Reflect` turns seeds red. |
| Generator coverage (R24) | `3765c79` | The per-kind marker is red on the previous generator. Removing the core's content check was green on every test before; it is now red in two direct tests and the gate oracle. |

While building the checker detector, five evasions of the rules as first written passed it and were added as seeds
before the rule that catches them: a `"constructor"` key in a destructuring pattern, `"constructor"` passed as an
argument, `Function` reached through `Object.getOwnPropertyDescriptors(Object.getPrototypeOf(…))` and an index,
and clock reads through `Intl` (it formats the current time when given no date) and `Temporal.Now`. The deny set
therefore also holds `Intl`, `Temporal` and the `Object` members that reach a prototype without naming it, and a string
holding a reflective name is a literal key wherever it appears (architecture §3, exit B2).

### Freeze gate (v5)

- [x] Every finding of the re-audit dispositioned: 7/7 new ACCEPTED; the three v3 PARTIAL findings closed through
      them; the v3 RESOLVED statuses and P3-PLAN-HIGH-004 (PARTIAL by design) confirmed.
- [x] 0 unresolved CRITICAL/HIGH in the plan, **except** the verbatim-text part of P3-PLAN-HIGH-004, which is open by
      design until G-LB and blocks S0. The S2 code HIGHs are folded here and fixed by the follow-up commits.
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] Reconciliation R24 applied.
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**PLAN_STATUS (v5):** LOCKED v5, superseded by v6 below. The re-audit of v5 found two plan gaps and a register
drift (section "Review v5").

## Review v5

> Lane A adjudication of the independent Codex re-audit of plan v5 and of the S2 fixes.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-29 as a single
> uninterrupted run of the Codex CLI 0.165.0; the gateway's own instructions apply (R16). Raw output:
> `phase-03-review-codex-v5.md`.
> Reviewed snapshot: `ac04c8c` · Verdict: **REQUEST_CHANGES** · Confidence: 0.98.
> Controller gate at `ac04c8c`, clean detached worktree: `pnpm verify:all` exit 0, 777 pass, 0 fail, 0 skipped;
> 53 test files, 31 required suites.
> Binding input: reconciliation R27 (decisions on this re-audit) and the two slot-contract rules of R28; R25 accepts
> the stricter purity deny set of the v5 follow-ups, and R26 assigns the gate-crash workaround to the Phase 2 lane.
> Lane A applies them exactly as written. Code line numbers below are at `ac04c8c` (the code is unchanged between
> `ac04c8c` and this docs commit).

### Summary

The re-audit confirms the three P3-PLAN4 findings FOLDED. Of the four v4 S2 findings, P3-S2R-HIGH-001, MED-001 and
MED-002 are RESOLVED, and with them v3's P3-S2-MED-001 and MED-002; P3-S2R-HIGH-002 and v3's P3-S2-HIGH-003 stay
PARTIAL. P3-PLAN-HIGH-004 stays PARTIAL by design until G-LB (R18). It raises seven new findings.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| Plan HIGH (P3-PLAN5-HIGH-001, 002) | 2 | 2 | 0 | 0 |
| Plan MEDIUM (P3-PLAN5-MED-001) | 1 | 1 | 0 | 0 |
| S2 HIGH (P3-S2V5-HIGH-001, 002) | 2 | 2 | 0 | 0 |
| S2 MEDIUM (P3-S2V5-MED-001) | 1 | 1 | 0 | 0 |
| S2 LOW (P3-S2V5-LOW-001) | 1 | 0 | 0 | 1 |
| **Total** | **7** | **6** | **0** | **1** |

Each earlier finding the review marks PARTIAL is closed through the new finding that names its remaining gap:

| Earlier finding | Remaining gap | Closed through |
|---|---|---|
| P3-S2R-HIGH-002 | the reconciliation after a PR-upsert failure took any PR found as this attempt's | P3-PLAN5-HIGH-002, P3-S2V5-HIGH-001 |
| P3-S2-HIGH-003 | a PR at another head counted as a reconciled publication, also with a cancel pending | P3-PLAN5-HIGH-002, P3-S2V5-HIGH-001 |

The review's reconciliation table marks R17, R21 and R24 PARTIAL for the same publication gap, R23 as a deviation
(P3-PLAN5-HIGH-001, P3-S2V5-HIGH-002) and R10 as a minor deviation (P3-S2V5-LOW-001); each is settled below. The S2
code findings are fixed by the follow-up commits after this docs commit, one finding or tight group per commit, test
first; the step report names each commit, the tests that prove it and the mutation check that shows them red
without the fix.

New: risk PR3-46. Amended: architecture §3, §4.1 (flow, terminal before lease, pre-lease rule), §5, §9, §12; data
model §4.2 (`baseBranch`), §4.4; exit B2, D13, G4, G11, G13, J1, J5; plan §11, §17, §26 (S0, S2, S6, S7), the step
table and the output block; risk PR3-18, PR3-42, PR3-44; threat T3-19, T3-22; research Q11.

### P3-PLAN5-HIGH-002 and P3-S2V5-HIGH-001 — The reconciliation took any PR found as this attempt's — ACCEPTED (R27)

**Finding.** After a PR-upsert failure the core checks only `prNumber !== null` (`task-core.ts:763`), and the
reconciliation result carries no PR identity (`types.ts:376-382`). The plan required only "PR found"
(`phase-03-architecture.md:216` at `ac04c8c`). The reviewer's `PR_WRONG_HEAD_PROBE` read a branch tip other than
the attempt's commit with a PR present: the task ended `WAITING_FOR_HUMAN_REVIEW` with that PR and no incident, and
`CANCELLED` as a reconciled publication with a cancel pending. The generator produced the same counterexample at
seed 1351 of an extended run (push failure with effect `applied`, PR upsert `unknown`, branch tip `ffff…`, PR 11),
and the oracle passed it, because its publication check ran only when `prNumber === null`
(`invariants.test.ts:583`) and its effect check looked only at whether a reconciliation was issued
(`invariants.test.ts:645-659`). Re-running that generator here over seeds 1 to 10 000 at `ac04c8c` found eight such
handoffs, the first at seed 1351.

**Disposition.** ACCEPTED. R27 decides the behavior.

**Locked change.**

- One identity predicate on both reconciliation paths: the remote branch tip equals the attempt's verified commit,
  and the PR, if any, has that branch as head, that commit as head SHA and the expected base.
- The expected base needs a source the core can compare: the task workflow input gains `baseBranch` (the branch the
  task's PR targets, from the repository binding), the PR upsert request carries it, and the reconciliation request
  carries it as `expectedBaseBranch`. This is Lane A's choice of where the expected base comes from; R27 fixes only
  that the base is checked.
- The reconciliation result carries what the read observed (`branchHeadSha`, and `pullRequest` with its number,
  head branch, head SHA and base), so the core decides, not the activity.
- After the push: identity holds → the PR upsert runs; the branch absent with no PR → `FAILED / publication-failed`
  (the read shows the push absent, effect `none` under R24; `CANCELLED` with a cancel pending, since nothing is on
  the remote); anything else → `FAILED / publication-incomplete`. After the PR upsert: identity holds with a PR →
  as a successful upsert with that PR; anything else, a PR absent included → `FAILED / publication-incomplete`. A
  failed read → `FAILED / publication-incomplete`. `publication-incomplete` keeps its branch audit and wins over a
  pending cancel.
- Lane A reads R27's "a moved or missing branch" as a branch that is not at the attempt's commit once the push was
  confirmed, or that is missing while a PR exists. On the push path an absent branch with no PR is exactly R24's
  "a reconciliation read of the remote shows the effect absent", which R24 makes `none`; this keeps the v5 tests
  that R27 did not question. If the controller meant every absent branch, the change is one line in the core.
- The property oracle checks identity on every publication: a PR number the task reports comes from an upsert after
  an applied push or from a reconciliation result that satisfies the predicate, and every reconciliation result is
  followed by the decision the predicate gives. The generator answers reconciliations with wrong heads, moved and
  missing branches, and PRs at another head branch, head SHA or base, from its side stream, so seed 1351 keeps its
  scenario.

Architecture §4.1, §5, §9; data model §4.2, §4.4; plan §11, §17, §26 (S2, S6, S7); risk PR3-18, PR3-44; threat T3-19.

**Validation.** G13 amended: `PR_WRONG_HEAD_PROBE` and seed 1351 as tests; a wrong head, a moved or missing branch,
a PR at another head branch, head SHA or base, and an unreadable remote, each with and without a cancel pending, on
both paths; the oracle above.

### P3-PLAN5-HIGH-001 and P3-S2V5-HIGH-002 — The lease was released before the terminal outcome — ACCEPTED (R27, R28)

**Finding.** Abandon, exhaustion and close emit `releaseLease` before `recordAttemptOutcome`
(`task-core.ts:859-860`, `:883-884`, `:1202-1203`), and the plan prescribes that order
(`phase-03-plan.md:348`, `:352`; `phase-03-architecture.md:225` at `ac04c8c`). R23 requires the terminal outcome to
be recorded **before** the lease is released, with the caller's fence in the same transaction as the write, so the
planned fenced helper would run after the lease is gone. `REPAIR` already records first (`task-core.ts:946-948`), but
no test checks the order: the reviewer inserted a release before its `endAttempt` and all 229 package tests stayed
green.

**Disposition.** ACCEPTED. R27 applies R23 from the orchestrator side; R28 adds the pre-lease rule.

**Locked change.**

- On every path where the attempt holds a lease (repair, abandon, exhaustion, verification stop, `BLOCK`, review
  handoff, cancel, pause timeout and any other close) the order is reap and dispose, then `recordUsage` and
  `recordAttemptOutcome`, then `releaseLease`. The interpreter runs effects in order, each to completion before the
  next, so the outcome's result is in before the release starts; a failed outcome write never lets the release run.
- The core refuses to emit a release for an attempt whose outcome is not recorded, the property test checks the
  order per attempt, and each path has a direct test; the reviewer's mutation must turn them red.
- The outcome write presents the caller's fence from `acquireLease` (R23). An attempt that never held a lease records
  `fence: null`, and only with a terminal of the pre-lease allowlist `cancelled` or `infrastructure-failed` (R28).

Architecture §4.1, §5, §9, §12; plan §11, §17, §26 (S0, S6, S7); exit G4, G11, J5; risk PR3-46.

**Validation.** J5 amended: per-attempt ordering oracle, one direct core test per leased path, the reviewer's mutation
red.

**Pre-lease allowlist check (R28).** Every path in the core where an attempt is registered and never leased, with the
terminal the core emits today and the terminal it takes in the slot vocabulary:

| Path | Terminal today | Slot terminal |
|---|---|---|
| A cancel accepted while `ensureAttempt` ran (non-cancellable), so `acquireLease` is never issued | `cancelled` | `cancelled` |
| A pause withheld `acquireLease`; its pause timeout fires (task `BLOCKED / pause-timeout`) | `cancelled` | `cancelled` |
| A pause withheld `acquireLease`; a cancel follows | `cancelled` | `cancelled` |
| `ensureAttempt` failed and `findAttempt` found the row (task `FAILED / attempt-registration-failed`) | `failed` | `infrastructure-failed` (S0 rename); `cancelled` with a cancel pending |

Two paths are outside what the core can settle alone, and come back to the controller:

| Path | Terminal today | Why it is open |
|---|---|---|
| `acquireLease` fails after its retries, or a cancel aborts it (it is cancellable) | `failed`, or `cancelled` | The grant may have committed before the failure or the abort. If it did not, this is a pre-lease attempt and `infrastructure-failed` or `cancelled` with `fence: null` fits the allowlist. If it did, the attempt held a lease, so R28 (3) and (7) refuse `fence: null`, and the workflow never received the fence to present. No new terminal is proposed; the choice is between a lease lookup after a failed or aborted acquire (like `findAttempt`) and a slot-side rule for this case. |
| `ensureAttempt` failed and `findAttempt` failed too | none | Whether the row exists is unknown, so the core emits no attempt-bound effect (D13, R21) and audits `attempt.registration-unreconciled`. If the row does exist, it has no terminal, against R28's "every terminal is recorded". |

No path emits a terminal outside the allowlist once S0 maps the found-after-failure row to `infrastructure-failed`.

### P3-PLAN5-MED-001 — PR3-18 and T3-19 still ended every failed PR upsert `publication-incomplete` — ACCEPTED (R27)

**Finding.** PR3-18 and T3-19 still said a PR upsert that fails after its retries always ends
`FAILED / publication-incomplete` (`phase-03-risk-register.md:30`, `phase-03-threat-model-delta.md:68` at
`ac04c8c`), while G13 continues when the reconciliation confirms the PR (`phase-03-exit-criteria.md:396`).

**Disposition.** ACCEPTED.

**Locked change.** PR3-18 and T3-19 say `publication-incomplete` only for a publication that cannot be reconciled
under the identity predicate (or whose read fails, or that ends with no PR). PR3-44 adds the wrong-head case.

**Validation.** Documentation only; G13 is the executable criterion.

### P3-S2V5-MED-001 — Locale and host reads passed the purity check — ACCEPTED (R27)

**Finding.** The detector denied named globals only (`purity.test.ts:94`, `:247`), so `(1234.5).toLocaleString()`
and `navigator.hardwareConcurrency` scanned clean. The reviewer appended the locale read to `task-core.ts` in memory
and all 229 tests stayed green; the same expression gives `1,234.5`, `1.234,5` and `1 234,5` under three locales.

**Disposition.** ACCEPTED.

**Locked change.**

- Globals are an allowlist (R27): every identifier in a value position that the checker resolves to a declaration
  outside its own file (a lib or ambient declaration), or to nothing, must be one of `Object`, `Array`, `Number`,
  `String`, `Boolean`, `BigInt`, `Map`, `Set`, `JSON`, `Error`, `RangeError`, `TypeError`, `Symbol`, `Math`,
  `undefined`, `NaN`, `Infinity`. A shorthand property and a local re-export are resolved to the value behind them.
- The member deny set stays and gains the locale-dependent members `toLocaleString`, `toLocaleDateString`,
  `toLocaleTimeString`, `toLocaleUpperCase`, `toLocaleLowerCase` and `localeCompare`. `Symbol` is allowed without
  its registry reads `Symbol.for` and `Symbol.keyFor`; `Math` keeps its pure-member rule.
- Three shapes the allowlist alone would miss are rules too, each with a seed: a local `declare` (it reads a host
  global under a local name), `import.meta`, and the host-dependent error members `stack`, `captureStackTrace`,
  `prepareStackTrace` and `stackTraceLimit` (a stack holds host paths). Like R25's additions, they are stricter than
  R27's text.
- The architecture states what the detector still does not close.

Architecture §3; exit B2; risk PR3-42; threat T3-22; research Q11.

**Validation.** B2 amended: the reviewer's two probes and a global outside the allowlist reached directly, through
a shorthand property, a local re-export and a local `declare` are seeds; the clean-set control with the allowlisted
globals stays green on the production core.

### P3-S2V5-LOW-001 — The `usageMicroUsd` export was removed — REJECTED (R27)

**Finding.** The v5 follow-up removed `usageMicroUsd` from `packages/orchestration/src/index.ts`
(`index.ts:19`; it was exported at `7694b8b`), which R10 calls append-only.

**Disposition.** REJECTED, as R27 decides. R10's append-only rule exists so that cross-lane merges of shared index
files are a union. `packages/orchestration` is Lane A's own, unmerged package, and nothing outside it imports it
(`git grep -n "@asep/orchestration"` outside `packages/orchestration` and `git grep -n usageMicroUsd` outside the docs
both return nothing at `ac04c8c`). The removed function clamped usage to the bound before the overrun check, which is
what hid the overrun of P3-S2R-HIGH-001; removing it is the fix, and a compatibility wrapper would put that clamp
back within reach.

### Observations settled by R25, R26 and R28

- **Stricter purity deny set (R25).** `Intl`, `Temporal`, the four `Object` members that reach a prototype and "a
  string holding a reflective name anywhere" are accepted; the defence-layer statement still applies.
- **Gate crash root cause (R26).** The intermittent `Check failed: end > addr.` abort is the Node 24 V8 wasm
  import-wrapper bug (nodejs/node#66366). The Phase 2 lane adds `--no-wasm-code-gc` to every test process; Lane A
  adds nothing. Lane A still reports any crash with its suite, run and machine load (R24).
- **Money at the seam (R28).** Every money field of the slot block is integer micro-USD. The core already keeps money
  in integer micro-USD (architecture §10), so Lane A's side is the wrapper rule in architecture §12: fill the block's
  money fields from those integers and read reported usage as non-negative safe integers or `null`. Exit J1.

### S2 follow-up commits (v6)

One commit per finding, on top of the docs commit `1c3153b`. Each fix commit's new tests failed on the code before
it, and removing the fix again turned them red. `pnpm verify:all` passed after each commit.

| Finding | Commit | Proof |
|---|---|---|
| P3-S2V5-HIGH-001 (P3-PLAN5-HIGH-002) | `0a2a427` | 22 of the 28 new direct tests (the reviewer's wrong-head probe, and a moved or missing branch or a PR at another head branch, head SHA or base on both paths, each with and without a cancel) and the strengthened oracle were red on the old decision with the new result shape. Dropping any one predicate clause turns direct tests and a property red, the latter through a new publication-focused generator that meets every clause on both paths. Seed 1351 is a test. |
| P3-S2V5-HIGH-002 (P3-PLAN5-HIGH-001) | `f900294` | 10 of the 14 per-path tests and the per-attempt ordering oracle were red before the fix (repair, verification stop, `BLOCK` and handoff already recorded first). The reviewer's mutation, a release inserted before the `REPAIR` outcome, turns the per-path test and the property red; with the core's guard in place it fails 12 tests. A pre-lease oracle checks that an attempt that never asked for a lease ends only `cancelled`, or `failed` when found after a failed registration. |
| P3-S2V5-MED-001 | `91ac97c` | All 15 new seeds, including the reviewer's locale and `navigator` probes, scan clean under the previous detector. Both probes, appended to `task-core.ts` on disk, turn the production check red. Removing the allowlist, the denied members, the shorthand or local re-export resolution, the `declare` rule or the `Symbol` registry rule turns seeds red. |
| P3-S2V5-LOW-001 | — | Rejected (R27); no code change. |

### Freeze gate (v6)

- [x] Every finding of the re-audit dispositioned: 6/7 new ACCEPTED, P3-S2V5-LOW-001 REJECTED with R27's reason; the
      two PARTIAL findings closed through P3-S2V5-HIGH-001; the RESOLVED statuses and P3-PLAN-HIGH-004 (PARTIAL by
      design) confirmed.
- [x] 0 unresolved CRITICAL/HIGH in the plan, **except** the verbatim-text part of P3-PLAN-HIGH-004, which is open by
      design until G-LB and blocks S0. The S2 code HIGHs are folded here and fixed by the follow-up commits.
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] Reconciliation R27 and the R28 slot rules applied; the pre-lease paths listed above, two of them open with the
      controller.
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**PLAN_STATUS (v6):** LOCKED v6, superseded by v7 below. The re-audit of v6 found the publication identity
without repository, state and candidates, and the R29 protocol not yet in the plan or the code (section "Review v6").

## Review v6

> Lane A adjudication of the independent Codex re-audit of plan v6 and of the S2 fixes.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-30 as a single
> uninterrupted run of the Codex CLI 0.165.0; the gateway's own instructions apply (R16). Raw output:
> `phase-03-review-codex-v6.md`.
> Reviewed snapshot: `392f259` · Verdict: **REQUEST_CHANGES** · Confidence: 0.97.
> Controller gate at `392f259`, clean detached worktree: `pnpm verify:all` exit 0, 836 pass, 0 fail, 0 skipped;
> 53 test files, 31 required suites; no crash at load average 28.
> Binding input: reconciliation R29 (the controller's answers to Lane A's turn-8 questions, written after the
> snapshot) and R31 (decisions on this re-audit). Lane A applies them exactly as written. Code line numbers below are
> at `392f259` (the code is unchanged between `392f259` and this docs commit).

### Summary

The re-audit confirms the three P3-PLAN5 findings FOLDED, P3-S2V5-HIGH-002 and P3-S2V5-MED-001 RESOLVED, and the
rejection of P3-S2V5-LOW-001 (R27). P3-S2V5-HIGH-001 stays PARTIAL, and with it P3-S2R-HIGH-002 and v3's
P3-S2-HIGH-003. P3-PLAN-HIGH-004 stays PARTIAL by design until G-LB (R18). It raises seven new findings, three of
them the R29 work the re-audit already knew was under way, and reports two mutations that survived.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| Plan HIGH (P3-PLAN6-HIGH-001) | 1 | 1 | 0 | 0 |
| Plan MEDIUM (P3-PLAN6-MED-001, 002) | 2 | 2 | 0 | 0 |
| S2 HIGH (P3-S2V6-HIGH-001, 002, 003) | 3 | 3 | 0 | 0 |
| S2 MEDIUM (P3-S2V6-MED-001) | 1 | 1 | 0 | 0 |
| **Total** | **7** | **7** | **0** | **0** |

Each earlier finding the review marks PARTIAL is closed through the new finding that names its remaining gap:

| Earlier finding | Remaining gap | Closed through |
|---|---|---|
| P3-S2V5-HIGH-001 | the identity had no repository, PR state or candidate set, so a fork, closed, merged or duplicate PR projected onto a valid observation | P3-S2V6-HIGH-001, P3-PLAN6-MED-002 |
| P3-S2R-HIGH-002 | the reconciliation could not tell a PR in another repository | P3-S2V6-HIGH-001 |
| P3-S2-HIGH-003 | an observation without that metadata could still count as a reconciled publication, also with a cancel pending | P3-S2V6-HIGH-001 |

The review's reconciliation table marks R17, R21, R24, R27 and R28 PARTIAL for the same identity gap or for the
lease protocol, and R29 "PARTIAL, known, being fixed"; each is settled by the entries below. The two surviving
mutations are taken up as tests: the base forced to `main` (P3-S2V6-MED-001) and the constructor reached through an
asserted computed key (R31's purity hardening). The S2 code findings are fixed by the follow-up commits after this
docs commit, one finding or tight group per commit, test first; the step report names each commit, the tests that
prove it and the mutation check that shows them red without the fix.

New: exit D16, D17, L6; risk PR3-47, PR3-48; threat T3-23, T3-24; data model §4.5. Amended: architecture §3, §4.1
(flow, terminal before lease, pre-lease rule, lease settlement, attempt state unknown, the identity predicate), §5,
§9, §12, §15; data model §4.2, §4.4, §5; exit B2, D13, G7, G13, J5; plan §11, §17, §26 (S0, S2, S6, S7), the
step table and the output block; risk PR3-18, PR3-42, PR3-43, PR3-44; threat T3-19, T3-22; research Q11.

### P3-PLAN6-MED-002 and P3-S2V6-HIGH-001 — The publication identity had no repository, state or candidate set — ACCEPTED (R31)

**Finding.** The observation carried a PR's number, head branch, head SHA and base branch only (`types.ts:391-396`),
and the core's predicate read just those (`task-core.ts:780-781`). A PR from a fork with the same branch name, a
closed or merged PR, and a second matching PR all projected onto an observation the predicate accepted. The
re-audit's `IDENTITY_MATRIX` added `headRepository: 'attacker/fork'`, `state: 'closed', merged: true` and
`matchingPrCount: 2` to an otherwise matching observation, on both reconciliation paths, with and without a cancel:
all twelve runs handed off the PR (or ended `CANCELLED` as a reconciled publication), and the oracle passed them,
because it repeated the same lossy predicate (`invariants.test.ts:705-708`). The plan's contract had the same gap
(`phase-03-data-model.md:460`) and said "open PR" only in a comment (`types.ts:386`).

**Disposition.** ACCEPTED. R31 decides the observation and the rule.

**Locked change.**

- The task input carries the binding's repository (`repository: { owner, name }`, normalized to lower case), and
  the reconciliation request carries it.
- The observation is complete: the branch with its repository and tip SHA, or null; and every PR the forge lists
  with the attempt branch as head branch, in any state and from any head repository, each with its number, head
  repository, head branch, head SHA, base repository, base branch, state and merged flag.
- The core decides: reconciled only if the branch is in the binding repository at the attempt's verified commit,
  and the candidates are none or exactly one that is open, unmerged, with the binding repository as head and base
  repository, the attempt's branch and commit as head and the input's base branch as base. Repositories compare
  case-insensitively, as the forge does. Zero candidates after a confirmed push is "no PR". More than one candidate,
  a closed or merged one, a fork head, or any other mismatch is not reconciled: `FAILED / publication-incomplete`,
  whatever cancel is pending, with the audit naming what was found and carrying the observation.
- The property oracle states the same predicate over the same full observation, independently of the core, and the
  generator draws fork heads, closed and merged PRs, several candidates, a PR at another base repository and a
  branch in another repository on both paths.

Architecture §4.1, §5, §9; data model §4.2, §4.4; plan §11, §17, §26 (S2, S6, S7); risk PR3-18, PR3-44; threat T3-19.

**Validation.** G13 amended: the `IDENTITY_MATRIX` cases (fork head, closed, merged, two candidates; both paths; with
and without a cancel) are core tests, plus a PR at another base repository and a branch in another repository; the
oracle above.

### P3-PLAN6-HIGH-001, P3-S2V6-HIGH-002 and P3-S2V6-HIGH-003 — A failed or aborted lease acquisition, and a failed lookup — ACCEPTED (R29, R31)

**Finding.** The plan left both pre-lease questions open (`phase-03-architecture.md:277`,
`phase-03-exit-criteria.md:224` at `392f259`), and R29 answered them after the snapshot. In the code, a failed
`acquireLease` is abandoned at once (`task-core.ts:699-706`) and a cancel that aborts it closes the task at once
(`task-core.ts:1180-1184`), so no lookup settles whether the grant committed: the re-audit's `R29_acquire-failure`
and `R29_acquire-cancel` issue no `findLease` and record the terminal without a fence. A failed `findAttempt` ends
`attempt-registration-failed` (`task-core.ts:694-698`), and a pending cancel turns it into `CANCELLED`
(`task-core.ts:1218-1222`); the audit carries no idempotency key, and the summary reports zero attempts
(`R29_lookup-failure`, `R29_lookup-failure-cancel`). R29 also asks for a telemetry criterion that Phase 3's exits did
not have (J6 is the slot-plug criterion, `phase-03-exit-criteria.md:574`).

**Disposition.** ACCEPTED. R29 decides the protocol; R31 asks for it in the plan and the code.

**Locked change.**

- `acquireLease` returns the caller's fence, and the core carries it (opaque) to the terminal write and the release.
- After a failed or aborted `acquireLease`, the core issues the non-cancellable `findLease`. Found: the terminal is
  recorded with that lease's fence, then the lease is released with it. Absent: the terminal is written through the
  new `recordPreLeaseOutcome` request with `fence: null`; its result says whether the slot recorded it or refused it
  because durable history now shows a lease (a late grant). A refusal leads to one more `findLease` and the fenced
  write. A second lookup that finds nothing contradicts R29's "a lease in history never disappears" and is treated
  as a failed lookup. So at most two lookups happen. Then the attempt is abandoned as before (replaced only for a
  replaceable class), or the task ends `CANCELLED` after an abort.
- A lookup (`findAttempt`, `findLease`) that fails after its retries ends the task `FAILED / attempt-state-unknown`,
  also over a pending cancel. No usage, outcome or release is emitted for that attempt. The audit row
  `attempt.state-unknown` carries the attempt number, the lookup and the idempotency key `<taskId>:attempt:<n>` (the
  natural key `(task_id, attempt_number)`), and the task result lists the attempt in `unrecordedAttempts`. A
  `recordPreLeaseOutcome` that fails after its retries ends the same way, because whether the terminal committed is
  then unknown too; this is Lane A's reading of R29's "only when the store cannot be read", stated so the controller
  can correct it.
- The core refuses to record a terminal for an attempt whose lease request is unsettled, as it refuses a release
  before the outcome.
- Exit L6 is the telemetry criterion: the attempt is reported as a gap with its idempotency key, never hidden and
  never counted as an attempt with zero usage.

Architecture §4.1, §5, §9, §12, §15; data model §4.5, §5; plan §11, §17, §26 (S0, S2, S6, S7); exit D13, D17, J5,
L6; risk PR3-43, PR3-47; threat T3-24.

**Validation.** D13 and D17: the four `R29_*` probes are core tests; found, absent, a late grant refusing the
pre-lease write, a second lookup, a failed lookup and a failed pre-lease write, each with and without a cancel
pending; the property oracle checks the fence of every terminal write and release against the lease the attempt was
granted, at most two lookups per attempt, and `attempt-state-unknown` over any pending cancel.

**Pre-lease allowlist after R29.** The table of Review v5 stands, with its two open rows settled:

| Path | Terminal | Slot terminal |
|---|---|---|
| `acquireLease` failed or aborted, `findLease` found no lease and the pre-lease write was recorded | `failed`; `cancelled` after an abort or with a cancel pending | `infrastructure-failed`; `cancelled` |
| `acquireLease` failed or aborted, `findLease` found a lease | as for a leased attempt, with the found fence | (leased, not pre-lease) |
| a lookup failed (`findAttempt` or `findLease`), or a second `findLease` found nothing | none (`attempt-state-unknown`, reported as a gap) | none: R29's single exception |

No path emits a pre-lease terminal outside the allowlist.

### P3-PLAN6-MED-001 — §17 and the cancel table still made every failed PR upsert `publication-incomplete` — ACCEPTED (R31)

**Finding.** Plan §17 and the cancel row of architecture §9 said a PR upsert that fails after its retries ends
`FAILED / publication-incomplete` (`phase-03-plan.md:418`, `phase-03-architecture.md:616` at `392f259`), while G13
continues when the reconciliation confirms the PR (`phase-03-exit-criteria.md:406`).

**Disposition.** ACCEPTED.

**Locked change.** §17, the cancel row, the cancel line of the §4.1 flow and G7 say `publication-incomplete` only for
a publication that cannot be reconciled under the identity predicate: a PR upsert that fails with effect `none`, a
remote that is not exactly the attempt's, or a failed read. A PR upsert that fails with an `unknown` or `applied`
effect and reconciles is a completed upsert, so a pending cancel then ends `CANCELLED` with the PR left open.

**Validation.** Documentation only; G13 is the executable criterion.

### P3-S2V6-MED-001 — `baseBranch` was not validated, and no test held it — ACCEPTED (R31)

**Finding.** `taskInputErrors` does not look at `baseBranch` (`validation.ts:43-52`): the re-audit's `undefined`,
`null`, `""` and `main..evil` all gave `errors: []`, and with a fixture that echoes the expected base they reached a
handoff. Every fixture and the generator use `main` (`test-support/fixtures.ts:24`, `invariants.test.ts:102`), and the
publication oracle never compares the upsert request's base with the input, so forcing the upsert base to `main`
(`task-core.ts:797`) left all 288 package tests green (`HARDCODE_MAIN_COUNTEREXAMPLE`).

**Disposition.** ACCEPTED. R31 gives the rules.

**Locked change.**

- The input rules validate `baseBranch` with Git's ref-name rules as R31 lists them: non-empty, at most 255
  characters, no `..`, no leading `-`, no control or space character, none of `~^:?*[\`, no `@{`, not ending in `/`,
  `.` or `.lock`, and no `//`. They validate `repository` in its normalized form too.
- The fixtures and the generator use bases other than `main`, and the oracle checks every PR upsert and
  reconciliation request against the input's base and repository, not against another request.

Data model §4.2; plan §26 (S2, S7); exit D16; risk PR3-48; threat T3-23.

**Validation.** D16: the four invalid bases and the other rule cases are negative tests, a non-`main` base passes, and
the reviewer's mutation (the base forced to `main`) turns tests red.

### Observation E12 — A constructor through an asserted computed key passed the purity check — taken up (R31)

The re-audit appended `((() => {})[("constr" + "uctor") as "name"] as unknown as (body: string) => () => number)("return
Date.now()")()` to `task-core.ts` in memory: the checker reports the key's type as the asserted literal `"name"`, so
the scan found nothing and the 288 package tests stayed green. The review files it within the detector's declared
limits (`phase-03-architecture.md:140`), not as a finding. R31 hardens the detector anyway: in production core a
type assertion inside a computed member key or computed property name, and a double cast through `unknown` (or
`any`), are violations. The expression is a seed, and the same expression appended to the production core must turn
the production check red. Architecture §3; exit B2; risk PR3-42; threat T3-22; research Q11.

### Observations settled by the re-audit

- **The S2 interpreter proves command order, not completion.** The sequential interpreter collects effects and does
  not run them (`sequential-interpreter.ts:81`), so S2 proves that the outcome command precedes the release, not that
  the outcome activity completed first. The S7 obligation stands: the Temporal interpreter awaits each effect before
  the next (plan §26 S7, R27), and the integration tests prove a failed outcome write leaves the lease to the janitor.
- **The release guard throws.** If the guard fired, the reducer would return no decision, and a retry of the same
  state and event would throw again (E6). In the Temporal workflow that fails the workflow task, so the workflow stays
  visibly stuck rather than releasing a lease before its outcome. No valid path reaches the guard: the per-path tests,
  E11 and the property generator never fire it. The new lease-settlement guard behaves the same way.
- **Missing branch on the push path (R29).** The controller confirms Lane A's narrow reading: after an unknown push, a
  read that finds no branch and no PR proves the push absent, so `publication-failed` stands.
- **`baseBranch` in the task input, and the extra purity rules** (local `declare`, `import.meta`, the error `stack`
  members) are accepted (R29).

### S2 follow-up commits (v7)

One finding or tight group per commit, on top of the docs commit `0aedc3f`, invariant first. Each fix commit's new
tests failed on the code before it, and removing or bending the fix again turned them red; the counts below are of the
decision-core test files (`decide.test.ts`, `invariants.test.ts`; `purity.test.ts` for the purity commit). `pnpm
verify:all` passed after each commit.

| Finding | Commit | Proof |
|---|---|---|
| P3-S2V6-MED-001 | `5e6363a` | The 21 new base-branch rule cases (the reviewer's `undefined`, `null`, `""` and `main..evil`, and every other rule of R31) were red before the fix (21 of 237). The fixtures use the base `release/2026.10` and the generator draws several bases; the oracle checks every PR upsert and reconciliation request against the input's base. The reviewer's surviving mutation, the upsert base forced to `main`, now fails 6 tests (the non-`main` base test, both property suites, the reconciled-push tests and seed 1351); the reconciliation's base forced to `main` fails 7. |
| P3-S2V6-HIGH-001 (P3-PLAN6-MED-002) | `5d0c413` | On the old decision with the full observation, 77 of 278 tests were red: the `IDENTITY_MATRIX` cases (fork head, closed, merged, two candidates, the attempt's PR beside a closed one) on both paths, with and without a cancel, a PR into another repository, a branch in another repository, and both property suites. Dropping one clause of the predicate fails tests each time: branch repository 5, several candidates 9, merged 4, state 6, head repository 5, base repository 5, case-insensitive compare 1. |
| P3-S2V6-HIGH-003 | `27d825b` | 6 of 280 tests were red before the fix, among them the reviewer's `R29_lookup-failure` and `R29_lookup-failure-cancel` and the task property. Letting a pending cancel win fails 2 tests; restoring `attempt-registration-failed` fails 3; hiding the attempt from `unrecordedAttempts` fails 3; an audit without the idempotency key fails 3. |
| P3-S2V6-HIGH-002 (P3-PLAN6-HIGH-001) | `aa41f2f`, `243680b` | On the old decision, 20 of 303 tests were red: the reviewer's `R29_acquire-failure` and `R29_acquire-cancel`, lease found, absent, a late grant refusing the pre-lease write, a second absent lookup, a failed lookup and a failed pre-lease write, each with and without a cancel, the fences, and the task property. No lookup after a failed acquisition fails 17; the old behaviour 16; a cancel closing at once after the abort 8; a refused write taken as recorded 5; a pre-lease terminal that ignores the cancel 2; a terminal without the fence 8; a second absent lookup that goes round again 2. Removing the core's unsettled-lease guard alone left every test green, because no valid path reaches it; `243680b` replays the happy path with the fence cleared before the terminal and expects the refusal, so the removal now fails 1 test. |
| Observation E12 (R31 purity hardening) | `8fc1f61` | The 9 new seeds (E12 as a constructor call and as a double cast, an angle-bracket key, a computed property name, a nested key, double casts through `unknown`, `any`, angle brackets and parentheses) were red under the previous detector (9 of 83). The asserted-key rule removed fails 4; the double-cast rule removed fails 5. The reviewer's E12 expression appended to `task-core.ts` turns the production check red (2 tests); under the previous detector it stays green, as the re-audit found. |

The release guard from Review v5 also survives its removal alone, for the same reason as the new guard. The defect it
guards against is held without it: with the guard removed and the release moved before the `REPAIR` outcome, the
per-path test and the task property fail.

### Freeze gate (v7)

- [x] Every finding of the re-audit dispositioned: 7/7 new ACCEPTED; the three PARTIAL findings closed through
      P3-S2V6-HIGH-001; the FOLDED and RESOLVED statuses, the LOW-001 rejection and P3-PLAN-HIGH-004 (PARTIAL by
      design) confirmed; both surviving mutations taken up as tests.
- [x] 0 unresolved CRITICAL/HIGH in the plan, **except** the verbatim-text part of P3-PLAN-HIGH-004, which is open by
      design until G-LB and blocks S0. The S2 code HIGHs are folded here and fixed by the follow-up commits.
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] Reconciliation R29 and R31 applied; the pre-lease paths settled above.
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**PLAN_STATUS (v7):** LOCKED v7, superseded by v8 below. The re-audit of v7 found Phase 2's publication guarantees
(R30) not yet in the plan, the R32 decisions not synchronized, and three S2 MEDs (section "Review v7").

## Review v7

> Lane A adjudication of the independent Codex re-audit of plan v7 and of the S2 fixes.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-30 as a single
> uninterrupted run of the Codex CLI 0.165.0; the gateway's own instructions apply (R16). Raw output:
> `phase-03-review-codex-v7.md`.
> Reviewed snapshot: `ac0a1bc` · Verdict: **REQUEST_CHANGES** · Confidence: 0.96.
> Controller gate at `ac0a1bc`, clean detached worktree: `pnpm verify:all` exit 0, 935 pass, 0 fail, 0 skipped;
> 53 test files, 31 required suites.
> Binding input: R30 (the controller's Phase 2 publication decisions; Phase 2 implemented them in cycle 9, head
> `a447983`, still under controller verification and independent review, read here only through `git show`), R32
> and R33 (decisions on this re-audit). Lane A applies R33 exactly as written. Code line numbers below are at `ac0a1bc`
> (the code is unchanged between `ac0a1bc` and this docs commit).

### Summary

The re-audit confirms the three P3-PLAN6 findings FOLDED; P3-S2V6-HIGH-001, HIGH-002 and HIGH-003, and with them every
earlier PARTIAL (P3-S2V5-HIGH-001, P3-S2R-HIGH-002, P3-S2-HIGH-003), RESOLVED, each with tests that go red when the fix
is removed; and R31's purity hardening RESOLVED (E12 now fails 2 tests). No HIGH remains in code. P3-S2V6-MED-001 stays
PARTIAL: the four v6 inputs are refused, but some names Git refuses still pass. It raises eight new findings and
reports two identity mutations that survived. Its reconciliation table marks R30, R31 and R32 PARTIAL; R32 was
written after the snapshot, so those gaps are new synchronization work, not regressions.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| Plan HIGH (P3-PLAN7-HIGH-001) | 1 | 1 | 0 | 0 |
| Plan MEDIUM (P3-PLAN7-MED-001, 002, 003) | 3 | 3 | 0 | 0 |
| Plan LOW (P3-PLAN7-LOW-001) | 1 | 1 | 0 | 0 |
| S2 MEDIUM (P3-S2V7-MED-001, 002, 003) | 3 | 3 | 0 | 0 |
| **Total** | **8** | **8** | **0** | **0** |

| Earlier finding | Remaining gap | Closed through |
|---|---|---|
| P3-S2V6-MED-001 | the validator accepts `/main`, `.hidden`, `release/.hidden` and `a.lock/b`, which Git refuses | P3-S2V7-MED-001 |

The two surviving mutations are taken up as tests (P3-S2V7-MED-002): a head branch compared case-insensitively, and a
reconciliation request with a hard-coded repository. The S2 code findings are fixed by the follow-up commits after this
docs commit, one finding or tight group per commit, test first; the step report names each commit, the tests that
prove it and the mutation check that shows them red without the fix.

New: exit O6, D18, E16; risk PR3-49, PR3-50; threat T3-25; research Q12, Q13; plan CR-28. Amended: architecture §4.1
(identity by repository ID, content repair, the lease-granted refusal, the read-or-write exception, the `failed`-only
rename), §5 (publication and pre-lease rows, the lease-granted mapping), §7.3 (rewritten: publication at the forge),
§12, §15; data model §4.2, §4.4, §4.5; exit D16, D17, E11, G13, J5, L6; plan §11, §16, §17, §26 (S0, S2, S5, S6, S7),
CR-27, the step table and the output block; risk PR3-03, PR3-43, PR3-47, PR3-48; threat T3-06, T3-23, T3-24 and the
residual statement.

### P3-PLAN7-HIGH-001 — The plan did not carry Phase 2's publication guarantees — ACCEPTED (R30, R33)

**Finding.** Architecture §7.3 (`phase-03-architecture.md:570-580` at `ac0a1bc`) rested remote safety on natural keys
and on a fence check just before each forge call, and threat T3-06 (`phase-03-threat-model-delta.md:57`) cited the
same. Neither has a compare-and-set push, PR content fixed by immutable facts, or reconciliation of PR content before a
terminal state, and the observation carries no title or body (`types.ts:441-450`), so it cannot stand in for R30's
content reconciliation. R30 restates the guarantee for Phase 2: GitHub has no compare-and-set for a PR update, so the
forge is not fenced; what holds is a compare-and-set push, content from facts and reconciliation before any terminal.
Phase 2 implemented it in cycle 9 (`aa946cf`): `ForgeProvider.pushBranch` takes `expectedRemoteSha`,
`pullRequestContent(facts)` derives title and body, and `reconcileBranchStep` and `reconcilePullRequestStep` repair a
takeover's remote with the audit action `forge.reconcile` (`packages/ports/src/index.ts`,
`packages/application/src/pipeline-steps.ts` at `a447983`).

**Disposition.** ACCEPTED. R33 decides how Phase 3 takes it in.

**Locked change.**

- Architecture §7.3 is rewritten as "Publication at the forge": the forge is not fenced; `publishBranch` runs
  `pushStep` (compare-and-set, `expectedRemoteSha: null`); `upsertPullRequest` runs `upsertPrStep` with
  `pullRequestContent(facts)`; a redelivered activity reconciles by natural key before any call, and an `unknown`
  effect is reconciled by `reconcilePublication` before any terminal state.
- Content repair happens inside `reconcilePublication`: it rewrites a diverged title and body of an open PR on the
  attempt branch in the binding repository from the facts, reports `contentRepaired` on that PR, and the core audits
  `publication.content-repaired`. The core's identity rule stays R31's; the activity never creates, retargets, closes
  or merges a PR and never moves the branch.
- R30's interleavings are S6 acceptance (new exit E16): the in-transport PR race, a stale push of a different commit
  refused, a late push of the same commit a no-op.
- Every reference to forge calls fenced by an epoch is gone; the fence check before a call is described as narrowing a
  stale owner's window, not closing it (plan §16, exit E11, risk PR3-03, threat T3-06 and the residual statement).
- CR-28 lists the Phase 2 ports Phase 3 uses as they are at `a447983`, and requests three additive changes. One of
  them is Lane A's own consequence of R30, for the controller to confirm: Phase 3's PR carries the `ESCALATE` flag and
  the content-addressed assurance section, both immutable facts of the attempt, so `PullRequestFacts` gains them and
  `pullRequestContent` renders them; otherwise Phase 3 would either drop them or write content that is not a function
  of the facts. The other two are the PR listing the full observation needs and the repository ID in the input
  (P3-S2V7-MED-003).

Architecture §4.1, §5, §7.3, §15; plan §11, §16, §26 (S5, S6), CR-27, CR-28; risk PR3-03, PR3-50; threat T3-06.

**Validation.** E16 (S6, through the activities); the core audit of a reported repair is an S2 trace (26) in G13.

### P3-PLAN7-MED-001 — The single exception still said "cannot be read" — ACCEPTED (R32)

**Finding.** Architecture §4.1 said the exception "exists only when the store cannot be read"
(`phase-03-architecture.md:316-325` at `ac0a1bc`), L6 said "because a lookup failed"
(`phase-03-exit-criteria.md:660-665`), and data model §4.5 said "could not be read" (`phase-03-data-model.md:508`),
while D17 already ends a failed pre-lease write `attempt-state-unknown` (`phase-03-exit-criteria.md:259-272`) and the
code does too. R32 settles it: the exception covers a store that cannot be read or written after the retry policy.

**Disposition.** ACCEPTED. The code needs no change: R32 confirms the failed `recordPreLeaseOutcome` path.

**Locked change.** Architecture §4.1 and §12, data model §4.5, plan §11, exit J5 and L6, risk PR3-43 and threat T3-24 say
"cannot be read or written" and list the three paths (a failed lookup, a second `findLease` that finds no lease, a
failed pre-lease terminal write), each reported as the same gap with the idempotency key.

**Validation.** L6: each of the three paths has its own core test (`registration: when the lookup fails too …`,
`lease: a second lookup that finds no lease contradicts the history …`, `lease: a pre-lease write that fails leaves the
terminal unknown …`), and the e2e injects a lookup failure and a pre-lease write failure.

### P3-PLAN7-MED-002 — The lease-granted mapping and the kit's stateful cases were not in the plan — ACCEPTED (R32)

**Finding.** The S0 row said only that `recordPreLeaseOutcome` maps "the slot's refusal of `fence: null`" to
`recorded: false` (`phase-03-plan.md:657` at `ac0a1bc`). R32 names the refusal (`ReviewLoopContractError` code
`lease-granted`), forbids reading it as supersession or as a generic activity failure, makes RLC-16 mandatory for any
slot that persists anything, and adds a registration-before-effect ordering case for Lane A's workflow. None of these
was in the plan.

**Disposition.** ACCEPTED.

**Locked change.** The S0 row, architecture §4.1 (settling paragraph) and §5 (the `recordPreLeaseOutcome` row and an
error-mapping paragraph) map exactly `lease-granted` to `recorded: false`; any other error is an activity failure, and
one that remains after the retries ends `attempt-state-unknown`. New exit O6: Lane A runs RLC-16 against
`NotConfiguredAssuranceSlot`, which persists run events and so may not declare it `N/A`, and the registration-before-
effect case against its workflow. D17 adds the mapping table test.

**Validation.** D17 (activity and bridge table test after S0), O6.

### P3-PLAN7-MED-003 — The upsert request had no repository, and the oracle checked only the base — ACCEPTED (R33)

**Finding.** D16 said every PR upsert and reconciliation request carries the input's base and repository, checked by
the oracle. The upsert request carries no repository (`types.ts:256-264`), and the oracle checks only the base of each
request (`invariants.test.ts:443-447`).

**Disposition.** ACCEPTED. R33 chooses the contract: both requests carry the repository.

**Locked change.** The upsert request gains `repository`, taken from the input; the oracle checks the repository and the
base of both requests against the input. Data model §4.4, architecture §5.

**Validation.** D16, G13; S2 trace (27).

### P3-PLAN7-LOW-001 — S0 renamed every pre-lease terminal — ACCEPTED (R33)

**Finding.** The S0 row said the pre-lease terminals "map to `infrastructure-failed`" (`phase-03-plan.md:657` at
`ac0a1bc`), and architecture §12 mapped "the pre-lease rows above onto `infrastructure-failed`"
(`phase-03-architecture.md:933-934`), while those rows end `cancelled` after an abort or with a cancel pending.

**Disposition.** ACCEPTED.

**Locked change.** Only the core's `failed` is renamed to `infrastructure-failed` at S0; `cancelled` stays. The S0 row,
architecture §4.1 and §12, exit D17 and J5.

**Validation.** Documentation; O5 (the S0 table test) checks the names that reach `recordAttemptOutcome`.

### P3-S2V7-MED-001 — The validator accepts branch names Git refuses — ACCEPTED (R33)

**Finding.** `branchNameProblem` checks the whole name only (`validation.ts:25-34`), so `/main`, `.hidden`,
`release/.hidden` and `a.lock/b` pass with `errors: []`, and `git check-ref-format --branch` refuses all four. Probing
git 2.55.0 for the new table, Lane A also found `HEAD` accepted by the validator and refused by Git (research Q12).

**Disposition.** ACCEPTED.

**Locked change.** Per-component rules: every `/`-separated component non-empty (no leading or trailing `/`, no `//`),
no component starting with `.` or ending in `.lock`, and the name not `HEAD`. The oracle is independent: a committed
table of names with their `git check-ref-format --branch` result, which the validator must match, and a test-only check
that re-runs git on the table in an empty directory outside any repository (inside one, `--branch` expands `@{-N}`).
Data model §4.2; exit D16; risk PR3-48; threat T3-23; research Q12.

**Validation.** D16; S2 trace (24).

### P3-S2V7-MED-002 — Two identity mutations survived — ACCEPTED (R33)

**Finding.** The fixtures and the generator always use one repository (`test-support/fixtures.ts:28`,
`invariants.test.ts:108`), no candidate has a head branch that differs from the attempt's only in case, and the oracle
does not check a request's repository (`invariants.test.ts:443-447`). So comparing the head branch case-insensitively
(`task-core.ts:923`) and hard-coding the reconciliation request's repository (`task-core.ts:890`) both left all 387
tests of the three core files green, although each changes behavior (`M_HEAD_CASE_COUNTEREXAMPLE`,
`NONDEFAULT_REPOSITORY`).

**Disposition.** ACCEPTED.

**Locked change.** The fixtures and the generator vary the repository's ID, owner, name and case, and emit head
branches that differ only in case on both reconciliation paths; the oracle asserts each request's repository against
the input; both mutations must turn tests red. Exit G13, D18.

**Validation.** G13, D18; S2 trace (28), with both mutations reported in the step report.

### P3-S2V7-MED-003 — Owner and name do not identify a repository across a rename — ACCEPTED (R33)

**Finding.** The core identifies a repository by owner and name (`types.ts:177-181`, `task-core.ts:899-902`). After a
rename or a transfer, another repository can take the old pathname; the reviewer's `RENAME_SLUG_REUSE` (expected ID
101, observed 202, same pathname) was handed off. The forge's numeric repository ID survives a rename and is already
required by Phase 2's binding resolver (`adapters/github-app/src/binding-resolver.ts` at `a447983`, which fails closed
when `githubRepositoryId` is missing).

**Disposition.** ACCEPTED. R33 chooses the ID in the core over a check in the activity alone.

**Locked change.** The task input's `repository` is `{ id, owner, name }`; the observation carries IDs; the predicate
compares IDs only. A rename or transfer (same ID) stays reconcilable and is audited `publication.repository-renamed`;
another repository at the old pathname (another ID) is refused. Owner and name become informational, so the input no
longer needs them in lower case: R31's case-insensitive comparison of owner and name is replaced by the ID comparison,
and the input rules check owner and name against the forge's name rules in any case, with a positive integer ID.
The adapter reads IDs and addresses the repository by ID where the forge allows (CR-28, research Q13). Data model §4.2,
§4.4; architecture §4.1, §7.3; exit D18; risk PR3-49; threat T3-25.

**Validation.** D18; S2 trace (25): a rename and a transfer with the same ID reconcile and are audited, another ID at the
input's pathname is refused, on both paths, with and without a cancel.

### Observations settled by the re-audit

- **The release guard.** The reviewer confirms Lane A's reading: removing it alone changes no reachable behavior, and
  the misordering it guards against is caught without it (the per-path `REPAIR` test and the ordering property, seed
  38). No change.
- **The lease-settlement guard test** clears the fence by hand, so it proves the guard exists, not that the state is
  reachable; that is its purpose. If a guard fires, the reducer throws and the workflow task fails visibly (Review v6
  observations); runtime recovery from that is not an S2 claim.
- **Telemetry integration** of `unrecordedAttempts` stays an S7 obligation (L6 e2e); the core reports the gap.
- **Branch names with `#`, `%2F`, `+`, `$`, `&`.** The core keeps and compares the string exactly. URL encoding and
  pagination of the forge reads are S5/S6 work (CR-28, research Q13).
- **A draft PR** that is open, unmerged and matches the identity is accepted; R31 does not require ready-for-review. No
  change.
- **The re-audit did not run `verify:all`** and did not use the lane's count; the controller's gate at `ac0a1bc` is the
  evidence for that snapshot.

### S2 follow-up commits (v8)

One finding per commit, on top of the docs commit `116266d`, invariant first. Each fix commit's new tests failed on the
code before it, and removing or bending the fix again turned them red; the counts are of the decision-core test files
(`decide.test.ts`, `invariants.test.ts`, and `purity.test.ts` where noted). `pnpm verify:all` passed after each commit.

| Finding | Commit | Proof |
|---|---|---|
| P3-S2V7-MED-001 | `f25b0c5` | 6 of 304 tests were red before the fix: the reviewer's four names, `HEAD`, and the test that the rule gives `git check-ref-format --branch`'s answer for every name of the committed table (`test-support/git-branch-names.ts`). Removing the per-component check fails 8; the leading-dot component rule 3; the `.lock` component rule 3; the `HEAD` rule 2; the empty-component rule 4; the trailing-dot rule 2. Recording a wrong answer in the table turns the test-only git re-check red. |
| P3-S2V7-MED-003 | `fff470c` | 31 of 339 tests were red before the fix: another repository at the binding's owner and name (the reviewer's `RENAME_SLUG_REUSE`) as branch, PR head and PR base on both paths, with and without a cancel; the binding repository renamed, transferred or re-cased (same id) reconciling with the move audited; and the id input rules. Comparing owner and name again fails 20; accepting the pathname beside the id 12; dropping the move audit 12; not validating the id 6; keeping the owner to lower case 1. |
| P3-PLAN7-HIGH-001 (code part) | `42447e1` | 8 of 346 tests were red before the fix: a content repair of the attempt's PR on both paths and of PRs that are not the attempt's, each with and without a cancel, and both property suites (the oracle checks that the decision reading a result audits exactly the repaired PRs). Not auditing fails 8; auditing only a single-PR read 3; auditing after the incomplete close instead of before the decision 9. |
| P3-PLAN7-MED-003 | `f4c837d` | 4 of 347 tests were red before the fix: a task bound to a repository other than the fixture's, whose publication requests must all name it, and the property oracle checking every publication request's repository and base. Hard-coding the upsert's repository or the reconciliation's fails the direct test. |
| P3-S2V7-MED-002 | `b251777` | With the previous commit's tests, the reviewer's case-folded head branch left all 347 tests green and an owner-and-name comparison left both property suites green. With this commit the case-folded head branch fails 5 (the case-only rows on both paths, with and without a cancel, and the publication property on its own); the hard-coded reconciliation repository 3 (both property suites on their own); a hard-coded upsert repository 3; an owner-and-name comparison both property suites. |

### Freeze gate (v8)

- [x] Every finding of the re-audit dispositioned: 8/8 new ACCEPTED; the PARTIAL P3-S2V6-MED-001 closed through
      P3-S2V7-MED-001; the FOLDED and RESOLVED statuses and P3-PLAN-HIGH-004 (PARTIAL by design) confirmed; both
      surviving mutations taken up as tests.
- [x] 0 unresolved CRITICAL/HIGH in the plan, **except** the verbatim-text part of P3-PLAN-HIGH-004, which is open by
      design until G-LB and blocks S0. No HIGH is open in code.
- [x] Canonical docs updated: plan, architecture, data model, exit criteria, risk register, research register,
      threat model delta.
- [x] R30's publication contract (as Phase 2 implemented it at `a447983`), the Lane A parts of R32, and R33 applied;
      CR-28's additive port changes requested from the controller (approved afterwards by R34: Lane A lands them in
      its own commits after G-P2; section "Review v8").
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**PLAN_STATUS:** LOCKED v8 (pending controller confirmation)

## Review v8

> Lane A adjudication of the independent Codex re-audit of plan v8 and of the S2 fixes.
> Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, read-only, run by the controller on 2026-10-30 as a single
> uninterrupted run of the Codex CLI 0.165.0; the gateway's own instructions apply (R16). Raw output:
> `phase-03-review-codex-v8.md`.
> Reviewed snapshot: `bed7a13` · Verdict: **ACCEPT_WITH_CHANGES** · Confidence: 0.95.
> Controller gate at `bed7a13`, clean detached worktree: `pnpm verify:all` exit 0, 982 pass, 0 fail, 0 skipped;
> 53 test files, 31 required suites.
> Binding input: R34 (the controller's answers to Lane A's turn-10 questions) and R37 (decisions on this re-audit).
> R37: the pure decision core S2 is accepted once these five LOWs are fixed and the controller has checked them, with
> no further Codex round on S2 unless the fixes touch decision logic beyond them. Code line numbers below are at
> `bed7a13`.

### Summary

The re-audit marks all five P3-PLAN7 findings FOLDED and every v7 S2 finding RESOLVED, with the remaining part of
P3-S2V6-MED-001 closed by the component validation; both v7 surviving mutations now fail tests (`M_HEAD_CASE` 5,
`M_REPO_HARDCODE` 3). It marks R30, R32 and R33 FOLDED (R33 with a LOW left) and R34 PARTIAL in the docs only. It
raises five LOWs and reports one surviving mutation, `M_ID_COERCE`. All five are ACCEPTED and fixed without a plan
version bump, because none changes the design: two are wording, three add audit coverage or tests to the core.

| Group | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| Plan LOW (P3-PLAN8-LOW-001, 002) | 2 | 2 | 0 | 0 |
| S2 LOW (P3-S2V8-LOW-001, 002, 003) | 3 | 3 | 0 | 0 |
| **Total** | **5** | **5** | **0** | **0** |

The plan LOWs are fixed in this docs commit; the S2 LOWs by the follow-up commits after it, one per finding, test first.

### P3-PLAN8-LOW-001 — CR-28 still read "requested" — ACCEPTED (R34)

**Finding.** CR-28 said "Phase 3 needs three additive changes, requested here" and that the port lines "land only with
the controller's approval" (`phase-03-plan.md:1301`, `:1321` at `bed7a13`), and the v8 freeze gate said they were
requested (`phase-03-review-log.md:2009`), while R34 had already decided: Lane A lands them in its own commits after
G-P2.

**Disposition.** ACCEPTED.

**Locked change.** CR-28 records the approval by R34 (after G-P2, in Lane A's own commits, on the accepted Phase 2, with
the union rule for shared files) and the narrow repair R34 accepts: the reconcile activity repairs only the title and
body of the attempt's open PR and never calls `reconcilePullRequestStep` in a mode that creates or retargets a PR;
creation stays a core decision. The v8 freeze-gate line points here. Architecture §7.3 says the same of the repair.

### P3-PLAN8-LOW-002 — Two core comments called the reconciliation read-only — ACCEPTED (R34)

**Finding.** `types.ts:272` ("A read-only look at the remote …") and `activity-options.ts:80` ("A read of the remote
…") at `bed7a13` describe `reconcilePublication` as read-only, while the contract lets it rewrite a diverged PR title
and body (architecture §5, `phase-03-architecture.md:426`).

**Disposition.** ACCEPTED. Comment-only; no behavior changes.

**Locked change.** Both comments say the activity's only write rewrites a diverged title and body of the attempt's open
PR from the attempt's immutable facts, reported per PR as `contentRepaired`, and that it never creates, retargets or
closes a PR.

### P3-S2V8-LOW-001 — The rename audit read only the branch's repository — ACCEPTED (R37)

**Finding.** `auditRepositoryMove` is called with `result.branch.repository` only (`task-core.ts:966`, `:974` at
`bed7a13`). A read whose PR head or base carries the binding's ID under another owner or name, with the branch under
the bound one, reconciles without an audit; the reviewer's `RENAME_PR_ONLY_MATRIX` reproduces it in all eight cases
(both paths, PR head or base, with and without a cancel).

**Disposition.** ACCEPTED.

**Locked change.** Every observed repository that carries the binding's ID (the branch's, and each listed PR's head and
base) under an owner or name other than the input's is audited `publication.repository-renamed`, once per distinct
observed owner and name, before the decision and whatever it is; the identity rule is unchanged. Data model §4.4,
architecture §4.1, exit D18.

**Validation.** D18: a PR-only rename (head, base, both) on both paths, with and without a cancel; deduplication across
branch, head and base; the property oracle checks the audits each reconciliation decision emits.

### P3-S2V8-LOW-002 — No test held strict identity against a malformed observed ID — ACCEPTED (R37)

**Finding.** The core compares repository IDs with `===` (`task-core.ts:901`), but no test or generated observation
carries a malformed ID, so `Number(observed.id) === binding.id` (`M_ID_COERCE`) passed all 434 tests of the three core
files while accepting an observed `"101"` for the binding `101` in all twelve combinations.

**Disposition.** ACCEPTED. The code is right; the regression is missing.

**Locked change.** Direct tests put a missing, zero, negative, unsafe and numeric-string ID on the branch, the PR head and
the PR base, on both paths with and without a cancel, and expect `FAILED / publication-incomplete`; the generator emits
the same malformed IDs from its own stream; `M_ID_COERCE` must fail. Exit D18.

### P3-S2V8-LOW-003 — Without git the re-check reported a pass — ACCEPTED (R37)

**Finding.** When git cannot run, the external re-check writes a diagnostic and returns (`decide.test.ts:313-316` at
`bed7a13`), so the runner counts it as passed although Git was never asked (`M_NO_GIT`: 434 pass, 0 skipped).

**Disposition.** ACCEPTED.

**Locked change.** Without git the re-check calls `t.skip()` with the reason (git's answers were not re-checked); the
check of the validator against the committed table runs either way. Exit D16.

### Observations settled by the re-audit

- **`startTask` does not run the input rules** (`task-core.ts:113`). That is by design: the S7 input mapping applies
  them before a workflow starts (plan §26 S7, data model §4.2); the core's tests do not stand in for that obligation.
- **S6 and S7 obligations stand**: the compare-and-set push, the narrow repair, the error mapping, runtime validation
  and telemetry integration are proven there, not in S2.
- **R34** settles the owner and name case, the reading of "informational and audited", the narrow repair and the
  6000 publication seeds; the plan and the review log follow it.

### S2 follow-up commits (v8 LOWs)

One finding per commit, on top of the docs commit `b97ed1c`, test first. The counts are of the decision-core test files
(`decide.test.ts` and `invariants.test.ts`, or `decide.test.ts` alone where noted). `pnpm verify:all` passed after each
commit: 996, 1011 and 1012 tests, 0 fail, 0 skipped, 53 test files, 31 required suites. No commit changes a decision.

| Finding | Commit | Proof |
|---|---|---|
| P3-S2V8-LOW-001 | `5728c7c` | 16 of 365 tests were red before the fix: a rename only the PR's head, base, or head and base shows, on both paths, with and without a cancel; each observed owner and name audited once, in the order read; a rename audited also when the publication does not reconcile; and both property suites (the oracle derives the expected audits from the read on its own). Auditing only the branch's repository fails 15; auditing heads but not bases 6; not deduplicating 20; auditing only on a reconciled read 3. |
| P3-S2V8-LOW-002 | `b4097b0` | With the previous commit's tests, the reviewer's `Number(observed.id) === binding.id` left all 365 tests green. With this commit it fails 4 of 380: the binding id as a string on the branch, the PR head and the PR base (on both paths, with and without a cancel), and the publication property on its own (`publication seed 574: PR 7 is not shown to be attempt 1's`). A loose `==` comparison fails the same 4. The missing, zero, negative and unsafe ids are refused by both the code and the mutant, and are held by 12 direct tests. A generator without malformed ids fails the publication coverage, which requires every kind of malformed id and a read that only strict identity refuses, on both paths. |
| P3-S2V8-LOW-003 | `a4dc968` | With the re-check still writing a diagnostic, the new test, which runs it against a git binary that does not exist, was red. Writing a diagnostic instead of skipping fails it (1 of 374 in `decide.test.ts`); skipping without the reason 1; not returning after the skip 1. With git removed from `PATH`, the runner reports the re-check as skipped with the reason, and the check of the validator against the committed table passes. |

### Freeze gate (v8, after the re-audit)

- [x] Every finding of the re-audit dispositioned: 5/5 LOWs ACCEPTED; the RESOLVED and FOLDED statuses confirmed.
- [x] No CRITICAL, HIGH or MEDIUM open in the plan or in S2; the verbatim-text part of P3-PLAN-HIGH-004 stays open by
      design until G-LB.
- [x] Plan LOWs fixed in this docs commit; the S2 LOWs fixed by the follow-up commits, test first, without decision
      logic changes beyond them.
- [ ] CR-10 verbatim text pasted (open by design; G-LB, R18).

**S2 acceptance (R37):** the pure decision core S2 is accepted once these five LOWs are fixed and the controller has
checked them.

**PLAN_STATUS:** LOCKED v8 (pending controller confirmation)

## Rebase onto the accepted Phase 2 (`d6ee686`)

> Lane A record of the rebase that R51 and R52 allow, and of the Phase 2 delta mapping (plan §1.4). No review finding
> is adjudicated here. S2 was accepted at `75bf4b3` (R38), G-LB released with the slot block `9cc21c98…` (R39), Phase 2
> accepted at `8e71ed7` (R51) and G-P2 released at its acceptance record `d6ee686` (R52). The controller kept the
> backup ref `backup/phase-03-pre-rebase-75bf4b3`.

**Rebase.** `git rebase d6ee686` replayed the 49 commits since the fork point `00a6889`. One commit conflicted, the
first one (`a133e32`, the decision core), in `scripts/lib/canonical-tests.mjs`: Phase 2 appended five required suites
where S2 appended its three. It is resolved by union (R10), with Phase 2's entries first. `pnpm-lock.yaml` merged without
a conflict (S2's `packages/orchestration` importer). `pnpm install --offline` then reported "Lockfile is up to date",
needed no network, and left the merged file byte-identical. `pnpm install --offline --frozen-lockfile` passes on the
rebased tree. Lane A's files are unchanged by the rebase (`git diff backup/phase-03-pre-rebase-75bf4b3 HEAD` over
`packages/orchestration` and the phase-03 docs is empty). The S2 suites ran 464 tests before and 464 after (0 fail,
0 skipped).

**One red gate after the rebase.** The first `verify:all` at the rebased head `aa19f73` failed (exit 1, 1380 pass,
1 fail; Node-launch sampler max 4.5 s, so a real failure under R47). Phase 2's fitness test "tests time their waits on
the monotonic clock, never on the wall clock" (`scripts/lib/process-registry.test.ts:785`) reads every test source
line and took five purity seeds for waits. Their text reads the wall clock on purpose, because the detector must catch
it. Every rebased commit from `a133e32` on carries those seeds, so each of them fails the same test.
`f9a886f` builds the seeds' clock read from one constant spelled in two parts. The source each seed hands the
detector is unchanged, and the Phase 2 rule is unchanged. At `f9a886f`, through `gate.sh`: `verify:all` exit 0, 1381
pass, 0 fail, 0 skipped, 63 test files, 39 required suites; `test:integration` exit 0, 34 of 34, 7 itest files, 7
suites; both valid under R47.

**Phase 2 delta mapping.** Plan §1.4 lists every accepted Phase 2 behaviour the plan depends on (P2-1…P2-11) with its
`file:line` at `d6ee686` and the consuming slice. The plan lines it amends are §0 (step table, ordering), §1.2 (gap
status), §11 (`reconcilePublication`), §21 (forge doubles, chaos processes), §22 (CX-02, CX-04), §26 (S4, S5, S6),
CR-05 (L2, `FAILED`), CR-08 (labels), CR-12 (rule framework), CR-20, CR-25 (caps, kill grace 60 s), CR-27, CR-28 (five
methods, the narrow repair, slices), §32 and the output block. The architecture follows in §7.1, §7.3, §7.4, §7.5 and
§10. Nothing Phase 3 needs is missing from the primitive, so no change request against Phase 2 is filed. The plan stays
`LOCKED v8`, with the controller's confirmation pending.

## S0 — shared foundation

> Lane A record of S0 (`feat(shared): land the review-slot contract, run-event sink and run-event 1.2.0`), the first
> slice commit after the rebase, made on top of `3b349d5`. No review finding is adjudicated here. The controller's
> check and an independent review follow.

**Paste record (O1, R39).** The block is the controller's file `slot-block-287ed0f.ts`: 894 lines, sha256
`9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a`. At `3b349d5` the plan held no copy (CR-10 read
"Text pending"); S0 replaces that note with a fence of exactly these bytes, and `cmp` of the fence against the
controller's file reports them identical. In source the block is split as its own banners direct: `slot.ts` is its
section 1 (lines 1–720), `disabled-slot.ts` and `review-loop-contract.ts` carry sections 2 and 3, each declaration with
a one-statement body that calls the implementation below the file's end marker. `asep-suite:assurance-slot-contract`
reassembles the three files into the 894 lines and pins the sha256; a second test pins the plan's fence. The rules the
block states and leaves to its implementations live apart, in `slot-rules.ts`, whose header also states the sha256.

**Exit criteria and the tests that prove them.**

| Exit | Proof |
|---|---|
| O1 | `assurance-slot.test.ts` (`asep-suite:assurance-slot-contract`): the reassembly and plan-fence byte tests; the kit against `NotConfiguredAssuranceSlot` on PGlite (every case passed, RLC-12 not applicable: no push-guard input), against the disabled slot (every stateless case) and against the scripted slot for PROCEED in each mode, REPAIR, ESCALATE and BLOCK |
| O2 | `run-event-sink.test.ts` (`asep-suite:run-event-sink`, PGlite): same id and bytes → `{ appended: false }` whatever the key order; different bytes → `RunEventConflictError`, row unchanged; invalid for 1.2.0 → refused before insert; a run outside the tenant, or an event naming another tenant → refused. `run-event-sink.itest.ts` (`asep-suite:pg-run-events`, real PostgreSQL): the same two cases as two-connection races, 20 rounds each |
| O3 | `0107_run_events` is data model §3.7's DDL. Both suites: `UPDATE` and `DELETE` raise SQLSTATE `55000`, and the scoped FK refuses another tenant's run (`23503`) |
| O4 | `compat-gate.test.ts`: the change is MINOR against the snapshot and against the 1.1.0 schema; every fixture of both lanes validates and the five negative fixtures are refused |
| O5 | `decide.test.ts` (`asep-suite:orchestration-core`): the type-level test holds the core's copies equal to the contract's types (terminals, pre-lease terminals, fence, outcome and its parts, the round request's fields, the terminal record's facts and fence pairing); the routing table drives the core with each locked outcome (PROCEED in each mode and with a null section, ESCALATE, REPAIR, BLOCK in each mode, and an unavailable round in both modes) and checks the PR, the terminals with their adjudication ids and the task outcome; the REPAIR test follows `repairBaseSha`, the repair order, `nextRound` and the adjudication into the repair attempt and its round request; one scenario per terminal shows each of the nine names reaching `recordAttemptOutcome`, and every recorded terminal is accepted by the contract's own input rules (Lane B's opt-out slot) |
| O6 | RLC-16 passes against `NotConfiguredAssuranceSlot` (not declared N/A). The workflow case runs the kit's `runRegistrationOrderingContract` over eight replayed core scenarios (first attempt, repair, cancel before the lease, registration found after a failure, failed and aborted lease acquisition, worker death with replacement, publication with an unknown effect) |
| J2 | the default-slot tests: `PROCEED`/`not-required` with no provider call for R0 and R1, `AssuranceUnavailableError` for R2–R4, the opt-out proceeding where it fails closed |
| A5 | `pg-run-events`: a fresh database at the Phase 2 migration set takes `0107_run_events` alone, a rerun applies nothing, and the registry is in ascending order |
| L3 | the sink validates against `run-event` 1.2.0 before any insert; the default slot writes only through it, inside the attempt-terminal store's transaction |

The seam rules: the pre-lease write's result maps `ReviewLoopContractError('lease-granted')` to `recorded: false` and
every other error (each other code, `AssuranceFencedError`, `AssuranceCancelledError`, a plain error, a look-alike with
the same `code`) stays an error (`recordPreLeaseOutcome`, table test plus the default slot on PGlite). Money at the
seam is integer micro-USD: the round request's `budgetRemaining` comes from the integer ledger, the terminal record
carries `modelCostMicroUsd` (the reported cost rounded up once), and the core refuses an outcome whose usage carries a
fractional, negative, string or unsafe `reviewCostMicroUsd`.

**Counts.** `pnpm test`: 1446 tests, 0 fail, 0 skipped, 65 files, 41 required suites (1381, 63 and 39 at `3b349d5`;
+23 in `decide.test.ts`, 374 → 397; +26 `assurance-slot-contract`; +13 `run-event-sink`; +3 `compat-gate`).
`pnpm test:integration` before the commit: 40 of 40, 8 itest files, 8 suites, containers torn down; the pre-lease race
observed both orders (lease first, terminal first) on real PostgreSQL. `invariants.test.ts` and `purity.test.ts` keep
their 90 tests.

**Test first, where it was and where it was not.** The `run-event` 1.2.0 schema was written before its tests; the new
compat tests were then shown red on the 1.1.0 schema (4 failing) and green on 1.2.0. The sink, the store, the default
slot and the kit were written with their tests. The decision-core rename came before its new tests. For all of them
the evidence that the tests bite is the mutation table below: each mutant was applied alone to the working tree, the
named suite run, and the file restored byte for byte (persistence mutants run against the application suite were
rebuilt into `dist/` first, because that suite imports the built package).

| Mutant | Suite | Result |
|---|---|---|
| close's default terminal `agent-failed` | orchestration-core | 10 of 397 fail, among them the contract-violation rows and the ordering case |
| an agent result abandoned as `infrastructure-failed` | orchestration-core | 13 fail |
| round key in the old `<workflowId>:assurance:<n>:<round>` form | orchestration-core | 2 fail (both REPAIR lineage tests) |
| `budgetRemaining.costMicroUsd` in USD | orchestration-core | 1 fails (slot money) |
| close finishes unregistered attempts | orchestration-core | 2 fail (ordering case, registration) |
| `assuranceUnavailable` kept on every terminal | orchestration-core | 1 fails |
| publish-change rejection as `infrastructure-failed` | orchestration-core | 2 fail |
| model cost in USD | orchestration-core | 1 fails |
| a tenth terminal; the epoch a string; `reviewCostUsd`; a widened pre-lease set; a non-null budget cost | typecheck | each fails `tsc -b` at the type-level test |
| conflict by bytes skipped | run-event-sink | 1 of 13 fails |
| schema validation skipped | run-event-sink | 2 fail |
| event tenant unchecked; run-in-tenant read skipped | run-event-sink | 1 fails each |
| append-only trigger returns the old row | run-event-sink | 1 fails (`55000`) |
| fence epoch ignored; lease liveness ignored | run-event-sink | 1 fails each |
| lease history ignored for fence null | run-event-sink | 1 fails |
| redelivery facts not compared | run-event-sink | 1 fails |
| acquisition ignores a recorded terminal | run-event-sink | 1 fails |
| attempt's run not checked | run-event-sink | 1 fails |
| one terminal event written before the transaction | run-event-sink | 6 of 13 fail |
| one terminal event written after the transaction, whether it commits or fails | run-event-sink; assurance-slot-contract | 1 of 13 fails (the events commit together); the kit's RLC-15 and RLC-16 fail for the default slot |
| the default slot proceeds for any risk | assurance-slot-contract | the J2 test fails |
| the fence-null rule dropped from the slot rules | assurance-slot-contract | the kit fails for the default slot |
| every contract error, or a look-alike `code`, read as a late grant | assurance-slot-contract | the pre-lease result table fails |
| the round runs under a stale fence | assurance-slot-contract | the kit fails for the default slot |

**Decisions and deviations for the controller and Lane B.**

- `run-event` 1.2.0 adds three Lane A fields that data model §4.3 did not list (`attemptTerminal`,
  `verificationVerdict`, `adjudicationId`), so that the default slot's two attempt events carry every fact of the
  outcome and are its idempotency record. Data model §4.3 is amended.
- The default slot's `PROCEED` has `prBodySectionRef: null` (the block allows it); architecture §12 said a
  content-addressed artifact and is amended. Rendering "assurance not configured" in the PR body is the publication's
  (S5, S6).
- The default slot refuses money of 10^15 micro-USD or more (`invalid-input`), so that the USD numbers its events
  carry stay distinct.
- Terminal mapping in the core: an abandonment is `agent-failed` when the agent's result or the overstep inspection
  caused it and `infrastructure-failed` when an activity failed, whatever class it reports; every close without its
  own terminal is `infrastructure-failed`; a publish-change approval rejected or expired is `cancelled`, an
  unavailable gate `infrastructure-failed`. Architecture §12 and §10 are amended.
- `assuranceUnavailable` is recorded `true` only on the `proceeded` or `escalated` terminal, as the block's rule
  requires; an attempt that continued without an adjudication and then ended otherwise records `false`, and the
  `assurance-unavailable` audit row keeps the fact.
- The round request's idempotency key is now the block's `<attemptId>:assurance:<round>`.
- The core still emits `repair.started`; Lane B's SR-A6 says not to. Not changed in S0.
- A concrete task workflow id `asep-task-<ULID>` matches the repository's secret pattern `sk-[A-Za-z0-9]{20,}`
  (`scripts/lib/secret-patterns.sh`), so no tracked file may carry one; the S0 fixtures use the placeholder task
  `task-1`. Later slices that commit traces or fixtures meet the same rule.

**What Lane B adopts.** The port `RunEventSink` with `RunEventConflictError` (`packages/ports`), and with it the
attempt-terminal store port; migration `0107_run_events`, which the Phase 2 set plus `0107` alone upgrades to; the
`run-event` 1.2.0 schema with the three Lane A fields above next to Lane B's locked list; the slot files at
`packages/application/src/review-loop/`; `recordPreLeaseOutcome` as the seam's reading of `lease-granted`.

**Gates.** The gate lines of this commit are reported to the controller with it and recorded here in the next docs
commit.

**Gates, recorded after the commit.** Lane A's gate runs on `b549aeb`, from `gate.sh`'s node-launch sampler logs of
the two runs (started 11:27 and 11:35): `verify:all` samples=216
max_node_launch_ms=4589 stalls_ge_10s=0; `test:integration` samples=45 max_node_launch_ms=849 stalls_ge_10s=0. Their
exit status and counts went to the controller in the S0 status report; the controller's own runs on a detached
worktree are in R55 (`verify:all` twice, exit 0; `test:integration` twice, 40 of 40).

## S0 follow-ups and S1 — contracts and ports

> Lane A record of the two S0 follow-ups the controller assigned with R55 and of S1
> (`feat(contracts): add durable-orchestration message contracts and ports`). No review finding is adjudicated here.

### Follow-up: the parser refuses a shadow key outside PROCEED (`18b37e7`)

The slot contract gives only `PROCEED` a `shadow` field. `parseAssuranceOutcome` refused a malformed shadow on
`PROCEED` but accepted `ESCALATE`, `REPAIR` and `BLOCK` carrying the key. It now refuses any outcome other than
`PROCEED` whose object has a `shadow` key at all, `null` included (`packages/orchestration/src/assurance.ts:104-105`).
The verbatim slot block is untouched (`asep-suite:assurance-slot-contract` still pins its sha256).

- Tests (`decide.test.ts`): six rows in the "outside the contract" table, `shadow: null` and a shadow verdict on each
  of `ESCALATE`, `REPAIR` and `BLOCK` (the `BLOCK` one in shadow mode); the table now reports every row it accepted, by
  label. One routing row drives the core with a `BLOCK` carrying `shadow: null` and expects the contract-violation path.
- Test first: before the fix, 2 of 398 tests failed, and the table listed all six labels as accepted. After it,
  `decide`, `invariants` and `purity` pass 488 of 488 and `tsc -b` exits 0.
- Gate: the first `verify:all` exited 0 with 1447 tests passing, but recorded one Node launch of 16827 ms
  (`samples=245 max_node_launch_ms=16827 stalls_ge_10s=1`), so it does not count. The rerun: exit 0, `canonical-tests:
  PASS (65 test file(s), 41 required suite(s) verified)`, tests 1447, pass 1447, fail 0, skipped 0,
  `samples=220 max_node_launch_ms=4887 stalls_ge_10s=0`.

### Follow-up: an independent oracle for the terminal-to-event mapping (`d51e0b6`)

The default slot's table (`not-configured-slot.ts:72-82`) was pinned only for `proceeded`. A new case in
`assurance-slot.test.ts` records one attempt per terminal, plus verification `ERROR`, on one PGlite database through
the real attempt-terminal store, and compares both stored payloads with expectations written from what each terminal
means, not from the table: a review handoff (`proceeded`, `escalated`) `succeeded` and is never `accepted`; a repair
request is `rejected`; a block is `blocked`; a verification stop carries the verdict's word (`fail`, `error`); an
agent, infrastructure or budget end is `failed`; a cancellation stays `cancelled` (R33). `passedRequiredAssurance`
follows the data model's not-required rule: verification passed and no round blocked the attempt. A compile-time
`Record<AttemptTerminal, true>` keeps the case list covering every terminal of the contract.

The test was written after the code it checks (S0's). The evidence that it bites is mutation: each mutant applied alone
to `not-configured-slot.ts`, the suite run with and without the new case, the file restored byte for byte.

| Mutant | Suite without the new case (26 tests) | With it (27 tests) |
|---|---|---|
| `'cancelled': 'succeeded'` (`:81`) | 26 pass | 1 fails: the new case |
| verification `ERROR` no longer stored as `error` (`:143`) | 26 pass | 1 fails: the new case |
| a blocked attempt no longer fails `passedRequiredAssurance` (`:137`) | 26 pass | 1 fails: the new case |

Gate: exit 0, `canonical-tests: PASS (65 test file(s), 41 required suite(s) verified)`, tests 1448, pass 1448, fail 0,
skipped 0, `samples=223 max_node_launch_ms=4732 stalls_ge_10s=0`.

### S1 (`5cc8eaf`)

| Exit | Proof |
|---|---|
| A1 | `verify:all` on `5cc8eaf`: every stage passes except the publication gate's history scan, which fails on a commit outside this branch (Gates, below) |
| A3 | `compat-gate.test.ts`: the live schemas against snapshot v1, at least 16 checked (`compat-gate: PASS (16 schema(s) compatible with snapshot v1)`); `workflow-contracts.test.ts`: the three new contracts at `1.0.0` with a v1 `$id` and a snapshot equal to the schema. `run-event` stays 1.2.0, MINOR against its snapshot. `COMPATIBILITY.md` says 16 |
| D1 (types) | `tsc -b` exits 0 over the repository with the CR-04, CR-07, CR-08, CR-09, CR-24 and CR-26 ports (CR-10 is S0's block) |
| L5 | `metrics.test.ts`: the referential-integrity validator passes with `duplicate_side_effect_incidents`, and a test pins its formula and operand (`count(incident.opened where failureClass=duplicate-side-effect)`, no denominator) |
| domain table | `operational.test.ts`: the edges between the earlier statuses are unchanged; the edges touching `PAUSED`, `WAITING_FOR_APPROVAL` and `BUDGET_EXHAUSTED` are exactly data model §4.1's, `VERIFYING → BUDGET_EXHAUSTED` and the approval-wait pause edges included; `BUDGET_EXHAUSTED` is terminal. The no-accepted-state invariant test is byte-identical and now walks the new statuses too. `decide.test.ts`: the core's projection table equals the domain table over every status |

What landed:

- **Contracts.** `task-workflow-input`, `run-workflow-input` and `workflow-control`, each at `1.0.0` with
  `https://asep.dev/schema/<name>/v1`, valid and invalid fixtures, a v1 snapshot and generated types (`TaskWorkflowInput`,
  `RunWorkflowInput`, `WorkflowControlMessage`). The field lists are data model §4.2's, with `fixedTasks`, the `seal`
  control, `approval-decision.extensionUsd` and `policy.agentKillGraceSeconds`. Every string field has a pattern, an
  enum or a format; a test walks the three schemas for any that has none, and shows on a seeded variant that it finds
  one. The base-branch and repository patterns mirror the core's input rules: a core test runs Git's committed
  branch-name table and every refused base branch and repository of the core's tables against the schema.
- **Contract tooling.** `workflow-control`'s root is a `oneOf`, which the type generator, the compatibility classifier
  and the `x-tsType` parity walk did not read. The generator renders a `oneOf` as a union (a root `oneOf` as a type
  alias) and `null` as `null`. The classifier compares `oneOf`/`anyOf` variants by position (a changed variant count is
  breaking), classifies `uniqueItems`, and treats a change to any keyword it does not read (`allOf`, `if`, `const`, ...)
  as breaking; without this a breaking change inside a variant classified as no change. The parity walk enters union
  variants. Each rule has a test in `compat.test.ts` or `base-parity.test.ts`.
- **Task statuses.** `TaskStatus` gains the three statuses (`packages/contracts/src/base.ts`), and the domain table
  their edges (`packages/domain/src/operational.ts`).
- **Ports** (`packages/ports/src/index.ts`): `WorkflowEngine` replaced by CR-09's engine seam over the workflow
  contracts, with `ApprovalKind`, `TaskWorkflowPhase`, the receipts and `TaskWorkflowView`; `ActivityProgress` and
  `ActivityExecutionContext` (CR-04); `WorkspaceRecord`, `WorkspaceRegistry`, `WorkspaceUnavailableError` and the
  `attemptId` of `WorkspaceManager.create` (CR-07); `ExecutionReaper` (CR-08); `CommandRunOptions` and the optional
  per-call options of `CommandRunner.run` (CR-26); `VerificationCommandCatalog` and `UnknownVerificationCommandError`
  (CR-24). `governedExecution` passes the attempt id to `create`.
- **Principal types (CR-17):** `TenantPrincipal`, `TenantPrincipalClass` and the five orchestration capabilities in
  `apps/control-plane-api/src/auth.ts`.
- **Metric (CR-19):** `duplicate_side_effect_incidents`, SLO target 0.
- **ADR 0017**, "Durable orchestration topology: pure workflow core, retry-safe activities, lease-bound fencing".

**Test first.** The fixtures and every new or changed test were written first and run red against the unchanged
production code: contracts 18 of 90 failing (fixtures of unknown contracts, the workflow-contract tests, the schema
count, the variant and keyword classification, the parity walk), domain 2 of 13, the four selected core tests 3 of 4
(the two schema-mirror tests and the projection test), observability 1 of 27. After the production change the same
sets pass: contracts 90 of 90 (97 of 97 over all contract tests), domain 13 of 13, the selected core tests 4 of 4 (the
core suite 490 of 490), observability 27 of 27, and `tsc -b` exits 0. The ports, the principal
types and the ADR have no failing-first test: the check for them is that the repository compiles (D1), and the
generator's union output is held by the drift guard and by the `@ts-expect-error` lines in `workflow-contracts.test.ts`,
which fail the typecheck if a seal could target a task or `cancel` were a message.

**Decisions and deviations for the controller.**

- **`GitCommitter` is unchanged.** At `d6ee686` `commit` already refuses unless the workspace HEAD is `baseSha` and
  moves HEAD with a compare-and-swap from it; `reconcile` needs no workspace. CR-07 is amended to say so.
- **Port before adapter.** `WorkspaceManager.create` takes the attempt id, but the Git adapter ignores it until S4
  (create-or-adopt, rehydration); no runner honours the per-call signal until S4; `ExecutionReaper`, `WorkspaceRegistry`
  and `VerificationCommandCatalog` have no implementation before S4 and S6. This is the plan's "S1 types, S4
  implementation" split.
- **Added beyond the CR text:** `UnknownVerificationCommandError` (CR-24 amended), and a closed `reason` on
  `WorkspaceUnavailableError` (`other-host`, `missing`, `quarantined`).
- **Schema choices.** `fixedTasks` is a `oneOf` of a unique-item array and `null`, with no minimum length (the data
  model allows an empty list). The attempt cap's cost and wall-clock are above 0. `replaceableFailureClasses` may name
  any of the 17 classes; refusing a never-replaceable one stays the loader's and the mapping's (data model §4.2). The
  work-order and context-pack references carry fixed kinds. `run-workflow-input` carries `repositoryBindingId`, because
  a run belongs to one binding. That `extensionUsd` is non-null exactly for a budget-extension approve is the mapping's
  check: the message does not carry the approval's kind, so the schema accepts a reject with an amount.
- **The count.** `COMPATIBILITY.md` said 12 contracts and the gate test asserted at least 12 while 13 schemas existed
  (`validate.ts` said 13). Both now say 16: the 13 plus Lane A's three.
- **Statuses before their constraint.** The new statuses are in the type and the domain table; the `tasks.status`
  CHECK learns them in `0100` (S3), and no code writes them before then.
- **Principal resolution** (`PrincipalResolver.principalForToken`) lands with its implementations in S9; S1 has the
  types only.
- **CR-19's check of the source events.** `attempt.declared_complete` is emitted since S0 (the default slot,
  `not-configured-slot.ts:131-138`). `workflow.recovered` and `human.intervention` are in `run-event` 1.2.0 but have no
  producer before S6 and S7, so `workflow_recovery_rate` and `human_intervention_rate` have no data yet.
- **Scope of S1: CR-18 and CR-28 not landed.** Their own text (and §1.4 P2-10 for CR-28) names S1, but the S1 row in
  §26, which this step follows, does not list them. Landing them with their consumers avoids two defects: a span or
  audit action declared with no emitter is the "declared but never emitted" defect the repository already fixed once
  (`packages/application/src/pipeline-steps.test.ts:1731-1744`), and `listPullRequests` added to `ForgeProvider` must
  be implemented by every forge adapter and double to compile, which is S5's work. Proposed: CR-18 with its emitters
  (S6, S7); CR-28 item 1 with its consumer (S6); item 2 in S5. The controller decides.

**Counts.** `pnpm test` at `5cc8eaf`: tests 1468, pass 1468, fail 0, skipped 0; 66 files, 41 required suites (1448, 65
and 41 at `d51e0b6`; +1 file, `workflow-contracts.test.ts`).

**Gates.** `verify:all` on `5cc8eaf` exited 1, `samples=250 max_node_launch_ms=3949 stalls_ge_10s=0`. Every stage up to
the publication gate passed (typecheck, canonical tests, contracts, policy, compat, forbidden imports, project
references, the three scans), and in the publication gate the license, path, dependency-license, secret, large-file and
PII checks passed. The history scan failed on one line:
`9fbde9da…:scripts/secret-patterns.test.ts:46`, a negative control that writes a task workflow id (`asep-task-`
followed by a ULID, which this branch's pattern reads as an `sk-` key). That commit is not in this
branch: it is the head of `phase/02-single-agent-vertical-slice` (`fix(secret-scan): an sk- key must stand on its own`,
committed at 14:20 while this gate ran), and the scan reads `git rev-list --all` of the shared repository with this
branch's pattern, which that fix replaces. The same scan over this branch's own history (`git rev-list HEAD`) finds
nothing. The clean-tree stage did not run; `git status --porcelain` was empty after the gate. Until this branch moves
onto that fix, every `verify:all` here fails the same way.
