# Phase 3 — Plan Review Disposition Log

> Lane A adjudication of the independent Codex plan review (workflow step 3), and of the Codex lock-check of the
> v2 plan (section "Lock-check v2" at the end, which also records the v3 freeze gate).
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

**PLAN_STATUS:** LOCKED v3 (pending controller confirmation)
