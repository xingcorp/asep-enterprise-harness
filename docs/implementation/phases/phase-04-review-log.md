# Phase 4 — Plan Review Disposition Log

> Lane B adjudication record for the independent Codex plan review of the Phase 4 plan.
> Planner: Claude (Lane B session). Reviewer: Codex `gpt-5.6-sol` via the kiro-proxy gateway, read-only,
> commissioned by the controller on 2026-10-29.
> Raw review: `phase-04-plan-review-codex-v1.md` (verbatim copy with provenance). Reviewed HEAD: `a2a7b8a`
> (`a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f`). Verdict: REQUEST_CHANGES, confidence 0.99.
> Binding inputs applied alongside: controller reconciliation `reconciliation-v1.md` (R1–R14) and the user
> decisions relayed by the controller on 2026-10-29.
> v3: the lock-check of v2 (`phase-04-plan-review-codex-v2.md`, Codex `gpt-6.1-sol`, snapshot `3201335`,
> REQUEST_CHANGES 0.97) and controller decisions R18 and R19 are dispositioned in "Lock-check v2" below.
> v4: the review of v3, the slot block and the pre-S0 code (`phase-04-review-codex-v3.md`, Codex `gpt-6.1-sol`,
> snapshot `9e3a1c3`, REQUEST_CHANGES 0.99) and controller decisions R22 and R23 are dispositioned in "Review v3"
> below.
> v5: the re-check of v4, the slot block and the code fixes (`phase-04-review-codex-v4.md`, Codex `gpt-6.1-sol`,
> snapshot `7cc20f4`, REQUEST_CHANGES 0.99) and controller decisions R26 and R28 are dispositioned in "Review v4"
> below.
> v6: the re-check of v5, the slot block and the code fixes (`phase-04-review-codex-v5.md`, Codex `gpt-6.1-sol`,
> snapshot `fb2e432`, REQUEST_CHANGES 0.99) and controller decision R32 are dispositioned in "Review v5" below.
> v7: the re-check of v6, the slot block and the code fixes (`phase-04-review-codex-v6.md`, Codex `gpt-6.1-sol`,
> snapshot `d0907b9`, REQUEST_CHANGES 0.98, `HAND-OFF: READY`) and controller decision R37 are dispositioned in
> "Review v6" below.
> v7 re-check: the re-check of v7 and its code fixes (`phase-04-review-codex-v7.md`, Codex `gpt-6.1-sol`, snapshot
> `287ed0f`, ACCEPT_WITH_CHANGES 0.96) and controller decisions R39 and R40 are dispositioned in "Review v7" below;
> the plan stays v7.
> v7 confirmed: the controller accepted the pre-S0 pure core at `27927d9` and confirmed the v7 lock (R41); see
> "Controller confirmation of v7" below.
>
> Each finding is dispositioned `ACCEPTED` / `PARTIALLY_ACCEPTED` / `REJECTED_WITH_EVIDENCE`. Nothing was
> auto-accepted: each finding's cited code was re-read before deciding. An accepted finding names its design
> change, its exit criterion, the slice that proves it and, for key guards, its mutation proof.

## Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| CRITICAL | 1 | 1 | 0 | 0 |
| HIGH | 8 | 7 | 1 | 0 |
| MEDIUM | 5 | 5 | 0 | 0 |
| LOW | 1 | 0 | 1 | 0 |
| **Total** | **15** | **13** | **2** | **0** |

## Decisions

| ID | Decision | Resolution | By | Reviewer opinion |
|---|---|---|---|---|
| D-1 | Review contract evolution | (b) new logical contracts; v1 untouched; per-major gate withdrawn | controller, R7 | (b) — agreed |
| D-2 | Promoted model reviewer satisfies R1's "1 independent reviewer" | **Yes — user-accepted policy, against the reviewer's recommendation.** Designed and tested as a policy rule; **inactive in Phase 4** because promotion is deferred; R1 keeps human independent review in practice (plan §3) | user | No, because R1 allows auto-merge (`policies/approval-matrix.yaml:32-40`) — overruled by the user |
| D-3 | Promotion threshold | Deferred with promotion (DF-3); precondition: pre-registered numeric floors on an independent corpus | user | numeric floors then human approval — adopted as the pickup precondition |
| D-4 | Different-family comparator | Mandatory; `deepseek-v4-pro`, not yet probed | user | mandatory; does not replace human relabel — recorded (DF-8) |
| D-5 | Push guard for every admitted risk | Yes, before the gateway and before push | controller, R14 | yes, before gateway and push — agreed |
| D-6 | Grafana in the required gate | Yes; digest-pinned Grafana loaded and queried | controller, R14 | yes — agreed |
| D-7 | Policy values | Experimental starting values as data; `n < 20` descriptive only, never a promotion threshold | controller, R14 | amend; `n < 20` descriptive only — agreed |
| U-1 | Reviewer authority | Shadow only; gating, signed promotion, thresholds and R2 admission deferred (plan §5.3) | user | "R2 admission and signed promotion are dangerous scope" — agreed |
| U-2 | Measurement | Descriptive rediscovery on self-labelled history + mandatory comparator; never production-valid | user | proposed verdict `IMPLEMENTATION_COMPLETE_DESCRIPTIVE_SELF_HISTORY_ONLY_UNVALIDATED` — adopted |

## Shared-surface reconciliation (R1–R14 applied)

| Item | v1 | Reconciled outcome in v2 |
|---|---|---|
| R1 fencing | own `PENDING` claim, re-call allowed | Phase 2 primitive by invariant (plan §16 I1–I5); CR-F1 for the minimal generalisation |
| R2 result binding | — | no parallel result contract; reviewer-call result shape is a CR-F1 request against the closed Phase 2 union |
| R3 slot | §16 signatures, Lane A had a different port | full TypeScript under "Review-loop slot contract (verbatim for S0)" (plan §18); placed in `packages/application/src/review-loop/` because the slot returns `AdmissionResult` (`risk-admission.ts:30-36`); conformance kit RLC-01…10; disabled and scripted slots |
| R4 `run_events` | Lane B `0201_run_events` | withdrawn; Lane A `0107`; `RunEventSink` in S0 |
| R5 `run-event` 1.2.0 | Lane B SR-C5 | Lane B fields and the one new event type listed for the S0 superset (plan §18.4) |
| R6 status unions | Lane B `attempts.status` | unchanged: Lane B owns `attempts.status` (`0202`), Lane A owns `tasks.status` |
| R7 contracts | MAJOR v2 + per-major gate | new logical contracts; SR-C3 withdrawn; counts only for Lane B additions |
| R8 forbidden imports | regex rules | rules written against the Phase 2 AST framework, each with a seeded self-check |
| R9 compose | Grafana mount | unchanged, distinct section |
| R10 registries/exports/roots | append | append-only; `assurance-root.ts` sibling; no `production-root.ts` change |
| R11 ADR numbers | none needed | none requested; 0018+ if ever needed |
| R12 corpus | SR-G1 tag reviewed SHAs | withdrawn; content-addressed excerpts; private bundle named; verifier bundle mode |
| R13 credential | env read in the adapter | composition-root credential source, bounded lifetime, rotation; pre-gateway stop with zero-request tests |
| R14 D-5/D-6/D-7 | open | applied (Decisions table) |

Lane A's committed plan (`80bb76a`) was read read-only; a grep of its plan, architecture, data model and exit
criteria found none of the Lane B-owned paths of plan §20.

---

## CRITICAL

### P4-PLAN-CRIT-001 — Secret can reach the gateway before the block — ACCEPTED
**Concern:** v1 built the packet, called reviewers and only then adjudicated, so a secret in the diff was sent to the
gateway even though the round would BLOCK (`phase-04-plan.md:341-347` at `a2a7b8a`).
**Disposition:** Correct; the v1 sequence (§7 there) ran `runDeterministicChecks` and `runReviewer` side by side and
applied rule 1 only at adjudication.
**Locked change:** plan §8 (sequence: checks before any reviewer), §10.1 (egress decision `CLEAR | STOP_SECRET |
STOP_CLASSIFIED | STOP_UNSCANNABLE`, per-project opt-in, request-byte re-scan, push guard before the gateway),
§12 (rules A1, A4); architecture §3, §7 (reviewer call protocol steps 1–2), §9; slot contract
(`DeterministicCheckOutput.egress`, `RunReviewerInput.checkReportRef`, `EGRESS_STOPPED`, `SKIPPED_PUSH_GUARD`); data
model `review_records_no_request_ck`; threat T4-05.
**Validation:** EC D1 (unit, fake provider call counter = 0 for five stop cases), D2 (itest, real adapter +
`assurance-root` vs local fake gateway, request counter = 0), F2; slices S6, S12, S16; mutation proofs D1, D2, F2.

## HIGH

### P4-PLAN-HIGH-001 — `review_records` lacks owner, fencing, expiry and takeover — ACCEPTED
**Concern:** a resumed step could re-call the model with no safe takeover, repeating Phase 2 HIGH-006.
**Disposition:** Correct. Re-read: `side-effect-log.ts:174-181` fences by `owner_token` but no takeover exists, and
`side-effect-log.test.ts:255-273` proves only rejection. Per R1, Phase 4 reuses the Phase 2 primitive Lane R is
building and states the dependency by invariant.
**Locked change:** plan §16 (invariants I1–I5; CR-F1: reviewId-qualified side-effect operation with closed result
shape, in-transaction fence check); slot contract `AssuranceFence` on every input and `AssuranceFencedError`;
architecture §7 reviewer call protocol; data model: `fence_lease_id`/`fence_lease_epoch` on machine-written rows,
final-record and append-only triggers; conformance case RLC-05.
**Validation:** EC E2 (new owner completes after handoff; old owner fenced; one winner; expired lease cannot claim;
reopened FAILED adopts the existing raw response), E12, H3; slices S8, S12, S16; mutation proof E2.

### P4-PLAN-HIGH-002 — The raising reviewer can self-confirm a fix — ACCEPTED
**Concern:** a `RESOLVED` claim plus a touched file sufficed to unblock a finding.
**Disposition:** Correct for v1 §11/§12.
**Locked change:** plan §13 (closure authority on the documented lifecycle `OPEN → ACKNOWLEDGED → FIXED → VERIFIED →
CLOSED`; raiser can only move to `FIXED`; `VERIFIED` only by a different eligible reviewer with a grounded resolution
in the repair delta, a human, or a deterministic re-check); architecture §11 algorithm; data model constraints
`finding_dispositions_raiser_ck`, `finding_dispositions_reviewer_ck`, `finding_dispositions_harness_verify_ck`;
deferred DF-7 (red→green proof for model findings).
**Validation:** EC E6 (unit + DB itest); slice S4, S7, S8, S16 (drill: closure by the other reviewer → PROCEED;
raiser-only closure → ESCALATE at max rounds); mutation proof E6. A scratch PGlite probe already confirmed the DB
rejects a raiser's verification and accepts another reviewer's (data model §3.5).

### P4-PLAN-HIGH-003 — Self-history is not a blind test; labels mostly from the same model — PARTIALLY_ACCEPTED
**Concern:** the "test split" labels were visible to the prompt author, and hash-freezing does not create a blind
holdout; required: reframe as descriptive rediscovery, no promotion use, independent human relabel, post-fix negative
pairs, controller-signed preregistration.
**Disposition:** Accepted: reframing (user decision U-2), no promotion use (constant `eligibleForPromotion: false`,
`blindHoldout: false`), post-fix negative pairs as first-class scored items, controller-approved preregistration,
`prompt-development`/`reporting` naming, mandatory comparator. Partial on two points, with reasons: (1) **independent
human relabel is not a Phase 4 MUST** — the user decided the Phase 4 measurement is descriptive rediscovery plus a
comparator (U-2); the blind relabel protocol is kept as DF-8 and every scorecard states labels are not human-verified;
(2) **"signed"** preregistration is procedural (controller commits the file or records its sha256 in this log; a lane
cannot produce it), not a cryptographic signature; the plan says so (SR-G3).
**Locked change:** plan §7.2–§7.6, §19.11 SR-G3; data model §7.1–§7.4; risk PR4-01, PR4-03.
**Validation:** EC I3, I4, I8, I9, I11; slices S19–S21; mutation proof I3.

### P4-PLAN-HIGH-004 — Yield and false-positive metrics computed from harness self-grading — ACCEPTED
**Concern:** `review.completed` is immutable at round close; later human dispositions never reach the metrics.
**Disposition:** Correct: `metrics-dictionary.yaml:276-314` sums `review.completed` fields that are only known after a
human disposition.
**Locked change:** plan §15 and §19.9 (SR-D2: numerators from `review.finding_dispositioned` by a human, latest per
`findingId`; SR-X6: `dedupeLatestBy`; dictionary 1.0.0 → 1.1.0); run-event 1.2.0 fields `findingId`,
`findingValid`, `findingDisposition`, `dispositionActorKind`; data model §5 (metric table; `review_ungrounded_rate`
for harness refutations); snapshot recompute with `revision`.
**Validation:** EC H6 (accept then reject after the round changes the next snapshot each time; harness refutations
excluded), J1; slice S17; mutation proof H6.

### P4-PLAN-HIGH-005 — v2 MAJOR bump drops the live v1 validator — ACCEPTED
**Concern:** the validator is keyed by logical name and cannot hold two majors.
**Disposition:** Correct: `packages/contracts/src/validate.ts:48-62` (closed `ContractName` union) and `:76-92`
(schemas keyed by the name taken from `$id`). Controller decision D-1 = (b) (R7).
**Locked change:** plan §3 D-1, §19.3 (new logical contracts; SR-C3 withdrawn); data model §1–§2; exit A3, B1, B2.
**Validation:** EC A3 (legacy schemas and v1 snapshots byte-identical), B1, B2; slice S1.

### P4-PLAN-HIGH-006 — Injection suite can be green at zero detection; no quality floor; promotion could open R2 — ACCEPTED
**Concern:** v1 D5 had no threshold; D-3 set no floor; signed promotion could still unlock R2.
**Disposition:** Correct. With the user's deferral of promotion and R2 admission (U-1), the Phase 4 part is the
falsifiable measurement.
**Locked change:** plan §7.4 (pre-registered floors: invalid-output rate, k-run stability, injection degradation
with a positive control, relative rediscovery recall, stale-flag rate; reported, not gating), §5.3 (DF-1…DF-4 with
floors on an independent corpus as preconditions), §10.3; data model §7.4 (`floorsMet`, `INVALID_CONTROL`);
`reviewer_promotions` removed.
**Validation:** EC D6 (zero control detection → `INVALID_CONTROL`, never a pass), I3, I11, K3; slices S3, S20; mutation
proofs I3, K3.

### P4-PLAN-HIGH-007 — Repair loop can pass with a fake coder; the real agent has no network or model credential — ACCEPTED
**Concern:** S12 did not require a real coder; Phase 2 HIGH-008 blocks a real loop.
**Disposition:** Correct: `apps/control-plane-api/src/pilot-main.ts:156` (`--network none`),
`adapters/agent-claude/src/claude-provider.ts:131-142` (no model credential forwarded), `:153-162`
(harness-specific CLI flags).
**Locked change:** plan §1.8, §21 (S16 named "assurance-only"; S22 real-coder shadow round, blocked on the Phase 2
agent-runtime repair), §23 (`ASSURANCE_ONLY_LOOP` qualifier), §25; risk PR4-27.
**Validation:** EC N1 (`asep-suite:real-coder-shadow`, registered when S22 lands), E10 (assurance-only scope stated).

### P4-PLAN-HIGH-008 — Packet has verdicts only; reviewer cannot see false-green evidence — ACCEPTED
**Concern:** without commands, exit codes, environment digest and raw-evidence refs, skipped tests or fake backends
are invisible.
**Disposition:** Correct: `evidence-bundle.schema.json:16-47` and `docs/platform/verification-and-review.md:37-39`
provide exactly these facts; v1 dropped them.
**Locked change:** plan §9 item 1, §14 item 3 (false-green checks); architecture §8 (execution manifest row); data
model §2.3 `execution`; seeded false-green suite (F6).
**Validation:** EC F5 (zero tests with exit 0, added skip marker, passing record with non-zero exit, missing required
check — all caught deterministically; manifest present), F6; slices S5, S6, S20; mutation proof F5.

## MEDIUM

### P4-PLAN-MED-001 — Coverage guard does not prove the named test ran or asserts the MUST — ACCEPTED
**Disposition:** Correct: `scripts/run-canonical-tests.mjs:95-114` checks only `SUITE-ID` markers.
**Locked change:** plan §19.7 SR-T3 (JUnit reporter + post-run proof check; Node supports paired multiple reporters,
research register §5); §21 S23; exit "How MUSTs map to tests" (three layers), L3, L4 (12 mutation proofs on † rows).
**Validation:** EC L3, L4; slice S23.

### P4-PLAN-MED-002 — Dashboards could be green without Grafana loading the provisioning — ACCEPTED
**Disposition:** Correct; controller decision D-6 = yes (R14).
**Locked change:** plan §15, §19.7 SR-T4 (digest-pinned Grafana in the integration gate, health-gated, torn down);
research register §5 (`GET /api/health`, `GET /api/datasources/uid/:uid`, `POST /api/ds/query` fetched; dashboard
paths confirmed in S18).
**Validation:** EC J4; slice S18.

### P4-PLAN-MED-003 — "Full DDL" omitted artifact FKs, trigger bodies, names and rollback — ACCEPTED
**Disposition:** Correct for v1 data model §3.
**Locked change:** data model §3.1–§3.3 (every constraint named, artifact FKs, indexes, four trigger functions,
`attempts_id_task_scope_uq`), §3.6 (rollback SQL), §3.4 (withdrawn items). Design validation: the SQL blocks were
applied verbatim on PGlite 0.5.4 after the twelve Phase 2 migrations in a scratch directory, the rollback applied,
and a row-level probe confirmed the key triggers and constraints (data model §3.5).
**Validation:** EC H1, H2, H3; slice S8 (PGlite and PostgreSQL 17).

### P4-PLAN-MED-004 — Credential read from env at call time; live path only opt-in — ACCEPTED
**Disposition:** Correct; R13 binds.
**Locked change:** plan §10.2; architecture §6 (`ReviewerCredentialSource`), §9; fitness rule (no `process.env` in
reviewer adapters); `ASEP_REQUIRE_LIVE_REVIEWER=1` makes the live test required.
**Validation:** EC C5, G7 (production composition through the injected source, always on), G8 (live, required when
flagged); slices S10, S15.

### P4-PLAN-MED-005 — S11–S13 too large — ACCEPTED
**Disposition:** Correct.
**Locked change:** plan §21: v1 S11 → S12 (steps), S13 (slot implementation, events, admission, repair context),
S14 (drivers); v1 S12 → S15 (composition + CLI), S16 (assurance-only loop itest); v1 S13 → S17 (evaluator), S18
(dashboards + Grafana gate). Each has its own acceptance checks and is independently revertible.
**Validation:** slice table; DAG plan §22.

## LOW

### P4-PLAN-LOW-001 — Baseline green not independently verified — PARTIALLY_ACCEPTED
**Concern:** the reviewer's `pnpm verify:all` exited 1 with `EPERM` creating temp files in its read-only sandbox.
**Disposition:** The claim itself stands: Lane B re-ran `pnpm verify:all` on a clean tree at `a2a7b8a` in this
session — exit 0, "verify:all: PASS (all gates green)", `tests 548`, `pass 548`, `fail 0`, "50 test file(s), 28
required suite(s) verified", "13 schema(s) compatible with snapshot v1". The reviewer's failure is its sandbox, not
the repository. Accepted part: the plan now labels the baseline as lane-observed and makes the controller's rerun
from a clean writable checkout authoritative (exit A1 records exit code, test count, required-suite count, HEAD).
**Locked change:** plan §2, Output block; exit A1.
**Validation:** controller rerun (A1).

---

## Integration notes from the review (not numbered findings)

| Note | Outcome |
|---|---|
| Slot lacks claim owner / fencing identity | `AssuranceFence` in `AssuranceSlotInput`, which every step input carries; RLC-05. **Corrected in v4:** the earlier wording "in every slot input" was false — `AttemptOutcomeInput` and `RepairContextInput` carried no fence until v4 (P4-SLOT-MED-003); since v4 both do, checked in the write's transaction (RLC-14) |
| Slot is wrappable as a Temporal activity (JSON I/O, signal and clock in context) | kept; context is `AssuranceStepContext` (R3) |
| Migration range `0200–0299` correct | kept; ids now `0200`, `0201_metric_snapshots`, `0202` |
| `attempts.status` conflict | R6: Lane B owns it |
| `run-event` needs one owner for the bump | R5: S0 superset |
| Directory ownership not verifiable against Lane A by the reviewer | verified by Lane B against Lane A's committed plan (above) |

## Additional evidence produced while adjudicating

- The verbatim slot block (plan §18) was extracted and type-checked in a scratch directory outside the repository with
  TypeScript 7.0.2 and the repository's base compiler options (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, declaration emit), against stub modules mirroring `@asep/contracts` base types and
  `AdmissionResult`: no errors. It has not been compiled against the real packages (the files do not exist yet).
- Data model DDL validation on PGlite: see MED-003.

## Controller-approved amendment (2026-10-29)

Recorded when the controller confirmed the lock for the pre-S0 slices. It changes facts and one shared-surface rule;
it reopens no finding.

| Item | Before | After | Where |
|---|---|---|---|
| U-3 gateway alteration | suspected, not verified | **verified by the controller**: the gateway appends ~330 tokens of terse-style instructions to `instructions` and attributes ~300 tokens of tools on every request (`/v1/responses` and `/v1/chat/completions`); evidence is the returned `instructions` field and `usage` attribution for fields the caller never sent. Served ≠ sent; replay and independence hold only "via this gateway"; S10 detects the alteration per call; every verdict names the gateway | plan §3, §7.2, §11, §23; architecture §6, §10; data model `gateway_alteration`; exit G10, I3, I9; PR4-30 (now HIGH); T4-03, T4-09 |
| U-4 primary reviewer | `gpt-5.6-sol` (also the labeller) | `gpt-6.1-sol` primary candidate (different model, same vendor: circularity reduced, not removed); the different-family comparator stays mandatory; neither is probed yet | plan §3, §7.6; policy YAML in data model §6; research register; PR4-01 |
| R15 `run_events` and time | Lane B listed a draft run-event sink; `now()` undocumented | `run_events` keeps its FK onto `runs`; benchmark and replay never write there; the only sink is Lane A's `adapters/persistence/src/run-events/**`; `AssuranceStepContext.now()` is one fixed logical time per activity execution, identical across retries; assurance steps never read the wall clock | plan §11, §15, §18.4, §20; architecture |

The only change to the verbatim slot block (plan §18) is the doc comment on `now()`; no signature changed. The
gateway address is not recorded in the repository: scorecards carry a label and the sha256 of the base URL.

---

## Lock-check v2 (Codex `gpt-6.1-sol`, snapshot `3201335`)

> Raw review: `phase-04-plan-review-codex-v2.md` (verbatim copy with provenance). Verdict: REQUEST_CHANGES,
> confidence 0.97. Controller decisions applied alongside: `reconciliation-v1.md` R18 (final, applied as written)
> and the assurance-activity-failure rule of R19. Each finding's cited text was re-read at `b2096d3` before deciding;
> line numbers in the findings refer to `3201335`.

### Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| HIGH (new) | 2 | 2 | 0 | 0 |
| MEDIUM (new) | 8 | 8 | 0 | 0 |
| v1 carried over (P4-PLAN-MED-001, PARTIAL in the lock-check) | 1 | 1 | 0 | 0 |
| **Total** | **11** | **11** | **0** | **0** |

The lock-check confirmed 14 of the 15 v1 dispositions as folded. MED-008 was already folded by `7799bbe` before the
lock-check ran on `3201335`; it is confirmed below, not redone.

### P4-PLAN2-HIGH-001 — Pre-S0 labels did not separate pure core from contract binding and gate wiring — ACCEPTED
**Concern:** S5–S7 were marked pre-S0 although the contracts and ports they bind land in S1/S2 after S0; registries
and package exports are shared surfaces; `evals/tsconfig.json` includes neither review directory; the DAG lacked
the policy → packet/checks → adjudication and runtime grounding → scorer edges (`phase-04-plan.md:1361-1398` at
`3201335`; `evals/tsconfig.json:7-11`).
**Disposition:** Correct. Re-read: `evals/tsconfig.json` includes `runner/**/*.ts` and `schema/**/*.ts` only and
references contracts and policy only; `scripts/lib/canonical-tests.mjs` `REQUIRED_SUITES` is a shared hotspot under
the lane contract. R18 settles the split.
**Locked change:** plan §0 (pure-core/integration rule), §21 table "When" column, new §21.1 (per-slice pure core and
integration part, the early integration work listed), new §21.2 (owners for `local-types.ts`, `ports.ts`, contract
schema files, the check report, package exports, both suite registries, `evals/tsconfig.json`, `evals/package.json`,
root references, the mutation manifest and the proof-manifest module), §22 DAG with the required edges, §19.10
SR-X8 (`evals/tsconfig.json`) and SR-X9 (`readPolicyFile`); risk PR4-32, PR4-36.
**Validation:** each integration part's type-level assignability check and fixture round trip (plan §21.1); the
slice is accepted only when both parts land.

**Integration work that landed early, in pure-core commits.** By the v3 staging these are integration items:
`packages/policy/src/index.ts` export lines and `packages/policy/src/policy-source.ts` `readPolicyFile` (`040ee5e`),
`packages/domain/src/index.ts` export lines (`723b3f4`), and nine `REQUIRED_SUITES` ids (`asep-suite:review-policy`,
`finding-lifecycle`, `review-packet`, `review-prompt`, `assurance-checks`, `assurance-egress`, `review-grounding`,
`adjudication`, `repair-order`; `040ee5e`…`b2096d3`). None touches a surface the lane contract or the step's
instructions forbid (`packages/ports`, `packages/contracts`, migrations, composition roots, `operational.ts`,
`scripts/forbidden-imports.test.ts`); all are append-only lines that the reconciliation unions at merge (R10). They
are kept, not reverted. New pure-core test files from v3 on land unregistered and are registered by their slice's
integration part.

### P4-PLAN2-HIGH-002 — S19/S20 lacked a packet recipe and scoring protocol precise enough to freeze — ACCEPTED
**Concern:** the corpus item had no cumulative-diff origin, WorkOrder or execution-manifest recipe; the matcher had
no category table, strict/lenient definition, cardinality or post-fix mapping (`phase-04-data-model.md:738-763`,
`phase-04-architecture.md:371` at `3201335`).
**Disposition:** Correct; the runtime packet needs `taskBaseSha`, `resultSha`, WorkOrder and execution, and v2 did not
say where a historical item gets them. R18 requires the protocol to be locked before any freeze.
**Locked change:** plan §7.8 (units and derived SHAs; rule P with diff flags, leakage filter and same-length ID
masking, post-image limit, label-independent chunking, the synthetic-field table, egress; rule C with synthesized
prior findings and status matching; post-fix negatives at the next cycle's reviewed tree; post-fix location mapping;
the matcher with category table `corpus-categories/v1`, strict and lenient variants, one-to-one greedy cardinality,
`duplicate` and `unlabelled`; the ordered exclusion table split into provenance-level and packet-level; the golden
fixture spec for `P2-FINAL-HIGH-003@2e61f24` on both sides); §7.5 (collection is not freezing); §25 item 6; data
model §2.3 (`NOT_RECORDED`, corpus only), §7.1, §7.2; architecture §12; risk PR4-33; threat T4-25. The derived SHAs in
the golden spec were checked in this session: `git rev-parse 3ea0293^` is `2e61f244…`, `git rev-parse e1c3c68^` is
`061ec236…`, both reachable from `phase/02-single-agent-vertical-slice`, and `packages/application/src/execute-task.ts`
exists at `2e61f24`.
**Validation:** exit I12 (golden item, both sides), I13 (S19 collection), I2, I5; slices S19 (collection now, freeze
after confirmation), S20.

### P4-PLAN2-MED-001 — The packet step had no seam for the workspace capability — ACCEPTED
**Concern:** `ReviewSourceReader` takes a `WorkspaceCapability`; neither `AssuranceSlotInput` nor the packet input
carries one, and no resolver was declared (`phase-04-architecture.md:182-207`, `phase-04-plan.md:762,818` at
`3201335`).
**Disposition:** Correct; `WorkspaceCapability` is `{ workspaceId, leaseId }` (`packages/ports/src/index.ts:26-29`)
and nothing in the slot input yields a workspace id. R18 chooses a framework-free resolver port.
**Locked change:** slot block `AssuranceWorkspaceResolver`, `AssuranceWorkspaceQuery`, `AssuranceWorkspaceResolution`,
`AssuranceWorkspaceRefusal` with the refusal order and the error mapping; `AssuranceFence.leaseEpoch` renamed
`fencingEpoch` so the resolver query and the fence use one name; resolver kit WRC-01…05 (plan §18, §18.2); plan §8,
§16 I6, §18.3 SR-A8; architecture §4, §6, §7 (packet step); risk PR4-34; threat T4-24. Placement: the resolver lives
in the S0 slot block in `packages/application/src/review-loop/` — the application-local ports both lanes share at
S0 — because Lane A implements it; Lane A's v3 plan expects it there.
**Validation:** exit E13 (wrong tenant, wrong lease, stale epoch, ended lease; refusal before any read); RLC-13;
WRC-01…05 on Lane B's fake (S12) and on Lane A's lease table (SR-A8).

### P4-PLAN2-MED-002 — R15 was not inside the clock contract — ACCEPTED
**Concern:** the block required only an ISO `now()` and no wall-clock reads; the fixed-logical-time invariant lived
only in Lane A's companion (`phase-04-plan.md:715` at `3201335`).
**Disposition:** Correct for `3201335`. `7799bbe` had already added the invariant to the `now()` doc comment after
the snapshot; R18 asks for it in the block itself with a byte-comparing redelivery test.
**Locked change:** slot block file header (envelope and time; content-addressed artifacts carry no timestamp);
`now()` comment; kit signature with a fresh subject per case, `makeCtx(logicalTime)` and `persistedRoundBytes`;
RLC-11; SR-A9; plan §11 (no timestamp in content-addressed artifacts; the repair ContextPack's required `generatedAt`
taken from the persisted REPAIR decision; waiver expiry judged at the round's opening time). The plan's measurement
paragraph already said benchmark and replay never write operational events (`phase-04-plan.md` §15, `7799bbe`);
§18.4 now also names the sink owner.
**Validation:** exit E14 (RLC-11 byte comparison of records and events; waiver expiry at the round's opening time).

### P4-PLAN2-MED-003 — The proof gate did not cover integration and left the optional live skip unresolved — ACCEPTED
**Concern:** SR-T3 gave the JUnit reporter to the canonical runner only; G8's credential-less skip would turn L3 red
(`phase-04-exit-criteria.md:115,177` at `3201335`).
**Disposition:** Correct. Re-read: `scripts/integration/run-integration.mjs:166` runs `node --import tsx --test` on
the discovered `*.itest.ts` files, so the same reporter pair applies. R18: proof manifest over both runners; live
optionality is a policy test, not a runner skip; `ASEP_REQUIRE_LIVE_REVIEWER=1` fails closed.
**Locked change:** plan §10.2 (`liveReviewerRequirement` decision), §19.7 SR-T3 (both runners, shared
`scripts/lib/proof-manifest.mjs`, conditional proofs named); exit "How MUSTs map to tests" layer 2, G8, L3, suite
`asep-suite:proof-manifest`; research register (integration runner invocation); risk PR4-07.
**Validation:** exit L3, G8; slice S23.

### P4-PLAN-MED-001 (v1, PARTIAL in the lock-check) — The proof manifest did not cover the integration runner — ACCEPTED
**Disposition:** The lock-check is right that the v2 fold stopped at the canonical runner. Folded together with
P4-PLAN2-MED-003 above.
**Validation:** exit L3, L4; slice S23.

### P4-PLAN2-MED-004 — The repair helper broke the slot's own 64 KiB envelope — ACCEPTED
**Concern:** `RepairContextInput.original` and `RepairContextOutput.contextPack` carried a full ContextPack, whose
`specificationExcerpt` has no length bound; the reviewer measured 65 853 bytes for a pack with a 65 536-character
excerpt (`phase-04-plan.md:667,1003` at `3201335`).
**Disposition:** Correct. Re-read: `packages/contracts/schema/context-pack.schema.json` declares
`specificationExcerpt` as a plain string with no `maxLength`. R18: ContextPack and large results by `ArtifactRef`,
plus a boundary test.
**Locked change:** slot block `RepairContextInput.originalContextPackRef`, `RepairContextOutput` reduced to
`contextPackRef`, `BuildReviewPacketOutput.omissions` replaced by `omittedFiles` (the list stays in the packet),
`REVIEW_LOOP_MAX_PAYLOAD_BYTES`, `reviewLoopPayloadBytes`, `assertWithinReviewLoopEnvelope` (implemented in the
block); RLC-01 boundary case; SR-A2; plan §18.4 change table; data model §2.3.
**Validation:** exit E1 (65 536 accepted, 65 537 rejected), E12 (RLC-01). The compiled helper accepted 65 536 and
rejected 65 537 bytes in the scratch type-check below.

### P4-PLAN2-MED-005 — RLC-06 contradicted a shadow BLOCK — ACCEPTED
**Concern:** RLC-06 required a non-null `shadow` in shadow mode, `BlockOutcome` has no `shadow`, and the DDL sets
`would_be_outcome` only for a shadow PROCEED (`phase-04-plan.md:944,1136`; `phase-04-data-model.md:469` at `3201335`).
**Disposition:** Correct. Re-read: `adjudications_shadow_ck` is `(review_mode = 'shadow' and outcome = 'PROCEED') =
(would_be_outcome is not null)`, and `packages/application/src/assurance/adjudication.ts:436-457` already returns a
null shadow verdict for A1 in every mode. R18: `shadow` only on PROCEED, plus a shadow-BLOCK case.
**Locked change:** slot block docs on `ProceedOutcome.shadow` and `BlockOutcome`; RLC-06 reworded; RLC-12 with the
fixture's `pushGuardInput`; plan §12; exit E9.
**Validation:** exit E9 (new unit proof "a shadow round blocked by the push guard carries no shadow verdict"), E12
(RLC-12), H3 (DDL).

### P4-PLAN2-MED-006 — Late dispositions had no window semantics — ACCEPTED
**Concern:** a disposition could be counted in the window in which it arrived rather than the window of the review
it disposes (`phase-04-data-model.md:503,651`; `phase-04-exit-criteria.md:127` at `3201335`).
**Disposition:** Correct design gap, as the reviewer says, not a reproduced runtime defect. R18: cohort semantics,
append-only snapshot versions, disposition latency.
**Locked change:** plan §15 (cohort rule, versions, latency, the day 1/2/3 test), §18.4 and data model §5 event
fields `reviewRoundCompletedAt`, `dispositionLatencyMs`; operand option `cohortBy` (SR-X6, data model §5);
`review_disposition_latency_ms` (SR-D1); data model §3.2 `metric_snapshots` rewritten as append-only versions with a
contiguity trigger, the append-only trigger and `metric_snapshots_latest`, §3.6 rollback; architecture §13; exit H6
(rewritten), H7 (new); risk PR4-28, PR4-35. The new DDL was applied on PGlite (below).
**Validation:** exit H6, H7; slices S8, S17.

### P4-PLAN2-MED-007 — Lane A's default binding and terminal vocabulary differed from the block — ACCEPTED
**Concern:** Phase 3's default slot emits attempt events and refuses risks outside R0/R1, while Phase 4's disabled
slot emits nothing and was named as Lane A's pre-integration binding; Phase 3 used `verification-failed`/`failed`.
**Disposition:** Correct; Lane A's v3 architecture already names `NotConfiguredAssuranceSlot` as its default. R18:
two default slots with distinct jobs and Lane B's terminal vocabulary.
**Locked change:** `createDisabledReviewLoopSlot` renamed `createDisabledAssuranceSlot` and documented as the literal
opt-out, never a default; §18.2 rewritten (two default slots; the terminal mapping Lane A applies to its prose,
terminal table and exit J2 at hand-off).
**Validation:** exit E12 (the kit runs on the disabled, scripted and — on Lane A's side — not-configured slots).

### P4-PLAN2-MED-008 — R16 not applied before S3/S20 — ACCEPTED (already folded in `7799bbe`)
**Concern:** the policy example still pinned `gpt-5.6-sol`, and the plan, risk register and threat model called the
gateway injection unverified (`3201335`).
**Disposition:** Folded by `7799bbe` (2026-10-29, before this lock-check's snapshot was superseded), confirmed in this
session: `policies/review-policy.yaml:49-52` pins `primary-gpt-6.1-sol` / `gpt-6.1-sol`; data model §6 matches;
plan §3 U-3 (verified injection) and U-4 (`gpt-6.1-sol` primary, distinct from the labeller `gpt-5.6-sol`); risk
PR4-30 (HIGH, verified); threat T4-09 (verified); the comparator stays mandatory and of a different family
(`packages/policy/src/review.ts:299-302` rejects a comparator of the primary's family). Reviewer configuration hashes do not
exist yet (S10/S20), so there is nothing else to synchronise.
**Validation:** exit C3, I3, I9, G10 as recorded in the amendment above; nothing redone.

### R18 and R19 applied

| Item | Applied as | Where |
|---|---|---|
| Workspace seam | `resolve(scope, { attemptId, leaseId, fencingEpoch })` in the S0 block; tenant + `ACTIVE` + holder + epoch; fails closed; Lane A implements over the lease table; tests wrong tenant, wrong lease, stale epoch | plan §16 I6, §18, §18.2 WRC, §18.3 SR-A8; exit E13 |
| Clock | R15 invariant in the block header and `now()` doc; RLC-11 compares persisted record and event bytes | plan §11, §18, §18.2; exit E14 |
| Envelope | ContextPack and large results by `ArtifactRef`; envelope helper; boundary case | plan §18, §18.4; exit E1, E12 |
| Shadow BLOCK | `shadow` only on PROCEED; RLC-12 | plan §12, §18; exit E9 |
| Defaults and vocabulary | `NotConfiguredAssuranceSlot` (Lane A, default) and `createDisabledAssuranceSlot` (Lane B, literal opt-out); Lane B terminals | plan §18.2 |
| Late dispositions | cohort of the disposed round; append-only snapshot versions; latency; day 1/2/3 test | plan §15; data model §3.2, §5; exit H6, H7 |
| Pre-S0 staging | pure core and integration per slice; owners; DAG edges | plan §21.1, §21.2, §22 |
| Corpus protocol | recipe, matcher and golden fixtures locked before any freeze; S19 collects only | plan §7.5, §7.8; data model §7 |
| Proof gate | both runners; live optionality as a policy test; flag fails closed | plan §10.2, §19.7; exit G8, L3 |
| R19 assurance-activity failure | audited `assurance-unavailable`; shadow → PROCEED, gating → ESCALATE, never `FAILED`; `AttemptOutcomeInput.assuranceUnavailable` and the `assuranceUnavailable` event field | plan §18 block, §18.3 SR-A10, §18.4; data model §5 |

### Slot block type-check

The v3 block was extracted from plan §18 (byte-compared with the checked file afterwards) and compiled as one module
in a scratch directory outside the repository with TypeScript 7.0.2 and the repository's base options (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, declaration emit, `types: ["node"]`, `NodeNext`), with
`@asep/contracts` and `@asep/ports` mapped to this branch's built declarations
(`packages/contracts/dist/index.d.ts`, `packages/ports/dist/index.d.ts`, rebuilt by `pnpm -s typecheck` at `b2096d3`,
exit 0) and `AdmissionResult` re-exported from `packages/application/dist/risk-admission.js` — the real types, not the
stubs used for v2. Result: exit 0. Control: appending an `AssuranceFence` literal with the old `leaseEpoch` field
failed with TS2353. The emitted JavaScript of the envelope helper reported 65 536 bytes for a 65 534-character string,
accepted it, rejected one more character with `ReviewLoopContractError`, and rejected a `bigint` and `undefined`
payload the same way. Not verified: compilation as three separate files inside `packages/application` (they do not
exist until S0).

### DDL re-validation

Data model §3.1–§3.3 and the §3.6 rollback were extracted from the v3 document and applied on PGlite `0.5.4` after the
twelve Phase 2 migrations (`adapters/persistence/dist/migrations.js`, last id `0012_side_effect_binding_fk`) in a
scratch directory outside the repository: all applied. The snapshot-version probe and its results are recorded in
data model §3.5.

### Freeze gate (v3)

Every lock-check finding is dispositioned (11 accepted, 0 rejected); R18 and the R19 assurance-failure rule are
applied; the slot block is fixed and type-checked against the real built types. Remaining before the corpus freeze
and before Lane A receives the block: the controller confirms v3.

### Corpus collection: rules the freeze must confirm

S19's pure core (`evals/review-corpus/collect.ts`, data model §7.1) applied the §7.8 reviewed-SHA rule to every
cycle and met four cases the rule does not name. Each is recorded in the items and needs the controller's
confirmation together with §7.8:

- Phase 1 cycle 1 (`P1-FINAL-*` first occurrences, 10 items): the review document was never committed, so the
  reviewed SHA is `unknown` and the items are excluded `tree-unavailable`.
- Phase 2 re-review v4 (9 residual items): `5c5471b` added the v4 and v5 documents together, so "parent of the adding
  commit" would postdate v5's own recorded tree. The collector marks such a SHA `unknown` (`tree-unavailable`); v4's
  status rows still confirm the v3 items.
- Phase 2 re-review v5 names its tree (`bb11d00`, unreachable since the history rewrite), so its 9 residual items are
  `object-store-only` and excerpt-only; the fix commits found for the v3 items run up to that tree and so include
  pre-rewrite commits that only the local object store holds.
- The self-found `P2-CYCLE6-HIGH-001` has no review document: its reviewed SHA is the parent of the fix commit the
  Phase 2 report names (`derived-from-fix`).

Collected: 153 items (65 included, 69 `plan-defect`, 19 `tree-unavailable`, 0 `excerpt-unpublishable`) and 122
excerpts; exit I13 verifies them against the repository. (R22 then settled these four cases and R23 renamed the
vocabulary: `tree-unavailable` → `reviewed-tree-unknown`, `object-store-only` → `private-bundle-only`,
`derived-from-fix` → `inferred-parent-of-fix`; see "Review v3".)

---

## Review v3 (Codex `gpt-6.1-sol`, snapshot `9e3a1c3`)

> Raw review: `phase-04-review-codex-v3.md` (verbatim copy with provenance). Verdict: REQUEST_CHANGES, confidence
> 0.99. Controller decisions applied alongside: `reconciliation-v1.md` R22 (corpus answers) and R23 (contract and code
> decisions; final, applied as written). Each finding's cited text was re-read at `9e3a1c3` before deciding; line
> numbers below refer to `9e3a1c3`. The controller's gate at that snapshot: `pnpm verify:all` exit 0, 598 tests, 598
> pass, 0 fail, 0 skipped, 60 files, 37 required suites.

### Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| MEDIUM — plan (P4-PLAN3) | 3 | 3 | 0 | 0 |
| MEDIUM — slot block (P4-SLOT) | 3 | 3 | 0 | 0 |
| HIGH — code (P4-CODE) | 6 | 6 | 0 | 0 |
| MEDIUM — code (P4-CODE) | 3 | 3 | 0 | 0 |
| LOW — code (P4-CODE) | 1 | 1 | 0 | 0 |
| **Total numbered** | **16** | **16** | **0** | **0** |
| Unnumbered: surviving mutation; four implementation-mirroring oracles | 2 | 2 | 0 | 0 |

The review confirmed every P4-PLAN2 finding and v1 MED-001 as folded. The plan and slot-block fixes land in the
docs-only commit that carries this section; each code finding lands in its own commit with a failing-first test whose
oracle is independent of the code under test (R23), and each HIGH fix with a mutation check (revert the fix, show the
new test fails, restore), reported in the lane report.

### P4-PLAN3-MED-001 — R22 not synchronised into the protocol and provenance vocabulary — ACCEPTED
**Concern:** the snapshot used `tree-unavailable`, `object-store-only` and `derived-from-fix` where R22 says
`reviewed-tree-unknown`, `private-bundle-only` and `inferred-parent-of-fix`; the plan did not require the
bundle-dependent count or name the Phase 1 no-location drop (`evals/review-corpus/collect.ts:37-39`,
`phase-04-data-model.md:829-846`).
**Disposition:** Correct; R22 was issued after the snapshot, so this is the R22 delta. Confirmed at `collect.ts:37-42`.
**Locked change:** plan §7.5 (provenance vocabulary bullet; collection records `reviewed-tree-unknown`), §7.8 units
(`inferred-parent-of-fix`) and exclusion table (row 2 renamed; new freeze-level row 4 `no-location`; a
`private-bundle-only` item is counted, not excluded); data model §7.1 (`reachability`, new `dependsOnPrivateBundle`,
`fixCommits[]` with reachability, `excluded`); exit I10, I13. The collector, its test and the committed data follow in
the corpus commit.
**Validation:** exit I13 (`collect.test.ts` › "collected provenance and excerpts verify against the repository"); the
lane report states the included, `reviewed-tree-unknown`, `private-bundle-only` and Phase 1 no-location counts.

### P4-PLAN3-MED-002 — Two corpus execution shapes — ACCEPTED
**Concern:** the recipe fixes `execution: { verdict: 'NOT_RECORDED', environment: null, checks: [] }` while the S20
staging row said `execution: null` (`phase-04-plan.md:486`, `:1840`).
**Disposition:** Correct (both lines re-read). R23 keeps the first shape.
**Locked change:** plan §7.8 rule P item 5 (the only shape; golden fixture round-trips it through the packet validator
and the renderer), §21.1 S20 row (wording replaced; the whitelist accepts `environment: null` only with
`NOT_RECORDED`). Data model §2.3 already had the first shape.
**Validation:** exit I12 (S20 golden item test).

### P4-PLAN3-MED-003 — Closure predicate differed between plan and architecture — ACCEPTED
**Concern:** the plan required the resolution citation inside the repair delta, the architecture only that the cited
file be in the delta's file list; the code treated hunk context as changed (`phase-04-architecture.md:397`,
`grounding.ts:104`).
**Disposition:** Correct; `grounding.ts:104-107` tests `newStart … newStart + max(newLines, 1) − 1`, which includes
context lines. The code half is P4-CODE-HIGH-004.
**Locked change:** the R23 changed-line predicate, written identically in plan §13 and architecture §11 (a `+` line;
for a deletion-only change the finding's own cited lines among the `-` lines; context never qualifies).
**Validation:** exit E6 (`grounding.test.ts` › "only a changed line closes a finding, never its context";
`adjudication.test.ts` › "a resolution citing unchanged context leaves the finding blocking").

### P4-SLOT-MED-001 — `Promise<void>` broke the JSON-output contract — ACCEPTED
**Concern:** `recordAttemptOutcome` returned `Promise<void>`, the header promised plain-JSON outputs and the helper
rejected an `undefined` root (`phase-04-plan.md:1338`, `:1384`).
**Disposition:** Correct. R23: no `void` outputs.
**Locked change:** `recordAttemptOutcome(...): Promise<null>`; the header states that no method returns `undefined`;
RLC-08 requires exactly `null`; the disabled slot resolves `null`.
**Validation:** RLC-08; the type-check control below (a `Promise<void>` implementation fails TS2322).

### P4-SLOT-MED-002 — The envelope helper accepted payloads that serialization changes — ACCEPTED
**Concern:** `reviewLoopPayloadBytes` only called `JSON.stringify`, so `{x: undefined}`, `{x: Infinity}`, a `Date` and a
`Map` were accepted (`phase-04-plan.md:1377-1386`).
**Disposition:** Correct; reproduced in this session with the v3 helper body (16 of 20 negative fixtures accepted,
below).
**Locked change:** a recursive plain-JSON check (`plainJsonViolation`) inside `reviewLoopPayloadBytes`, before it
measures: null, string, boolean, finite number other than `-0`, hole-free arrays, objects with `Object.prototype` or
`null` prototype and only enumerable string-keyed data properties; no cycles; a walk that overflows is a contract error,
never a transient one. `-0` is rejected as well because `JSON.stringify` turns it into `0` and RLC-01 compares round
trips with deep equality. RLC-01 gains the negative fixtures and two slot-input cases.
**Validation:** RLC-01; the helper executed from the block text (below).

### P4-SLOT-MED-003 — The two writing helpers carried no caller identity — ACCEPTED
**Concern:** `AttemptOutcomeInput` and `RepairContextInput` had no fence although the block requires every write to be
fence-checked; the log claimed a fence in every slot input (`phase-04-plan.md:1259-1311`; this log's integration-note
row, now corrected).
**Disposition:** Correct. R23: both helpers take the caller's fence and check it in the write's transaction through the
Phase 2 primitive; the identity is what the caller presents; the terminal is recorded before release; identical
redelivery is a no-op returning the stored output, a conflicting one raises a distinct code.
**Locked change:** `fence: AssuranceFence` on both inputs; the `AssuranceFence` doc forbids substituting a stored
epoch; `ReviewLoopContractErrorCode` (`invalid-payload`, `invalid-input`, `not-in-scope`, `conflicting-redelivery`,
`invalid-output`) and `ReviewLoopContractError.code`; redelivery keyed by `attemptId`, compared deep-equal with
`fence` removed (so the current holder after a takeover may redeliver the same facts), fence checked before the
comparison; check order in §18.2; RLC-14 (fencing of both helpers, after `rotateFence()` and after `endLease()`) and
RLC-15 (identical and conflicting redelivery of both helpers); fixture fields `attemptOutcome`, `endLease`,
`prepareRepair`, `persistedAttemptBytes`; SR-A2 (acquire the repair attempt's lease, then call the helper), SR-A3
(record before release), activity policy (`conflicting-redelivery` → non-retryable activity failure). An attempt that
ends before it holds a lease has no fence; the block says it is not recorded here, and risk PR4-37 asks the controller
to confirm this at the focused check.
**Validation:** RLC-08, RLC-14, RLC-15; the type-check controls below (an input without `fence` fails TS2741).

### P4-CODE-HIGH-001 — Control and line-separator paths passed normalization and dodged the globs — ACCEPTED
**Concern:** a path with LF was normalized, `**` compiled to `.` without the `s` flag, and
`src/line\nbreak/secrets/customer.txt` reached a fake sender with push guard PASS and egress CLEAR
(`packages/policy/src/review.ts:515-538`).
**Disposition:** Correct: `review.ts:516-518` rejects only `/`, `\`, NUL and empty/`.`/`..` segments; `:538` builds the
regex with flags `''` or `'i'`.
**Locked change:** plan §10.1 (definition of "not normalizable"; push guard, egress, builder behaviour), §14 item 1;
architecture §8, §9; data model §2.1, `review_findings_file_ck`; threat T4-26. Code: `isNormalizedRepoPath` rejects C0,
DEL, C1, U+2028, U+2029 and a leading `"`; globs use the `s` and `u` flags; the push guard raises `forbidden-path` for
a non-normalizable path on any side of either diff; the packet builder keeps such a path as an `unsafe-path` omission
instead of throwing (a build failure would leave the round without a push-guard decision and, in shadow mode after the
retry policy, end as `PROCEED` under SR-A10).
**Validation:** exit D1 (`egress.test.ts` › "a path that is not normalizable is refused before the gateway";
`review.test.ts` › "control and line-separator paths are not normalizable and globs match every code point"); mutation
check in the commit report.

### P4-CODE-HIGH-002 — Egress classified only the cumulative diff's old paths — ACCEPTED
**Concern:** a rename `secrets/customer.txt → src/customer.txt` present only in the repair delta was `CLEAR`
(`egress.ts:37`, `:100`, `:109`).
**Disposition:** Correct: `egress.ts:100-108` parses only the `diff` part. The diff parser also drops a copy's source
path (`diff.ts:218`).
**Locked change:** plan §10.1, architecture §9 (both sides of every entry of both diffs; an unparseable delta is
unscannable); threat T4-27. Code: the parser records copies (`C`, with the source path) and the pre-image of any entry
whose sides differ; egress parses both diffs and classifies `path` and `oldPath` of every entry.
**Validation:** exit D1 (`egress.test.ts` › "both sides of every entry of both diffs are classified": rename, copy,
delete, delta-only file); mutation check in the commit report.

### P4-CODE-HIGH-003 — Dedupe before grounding made the outcome order-dependent — ACCEPTED
**Concern:** the first finding per fingerprint was kept before grounding; the fingerprint ignores severity, key and
requirement id, so `[LOW, CRITICAL]` gave PROCEED and the reverse REPAIR (`adjudication.ts:339`, `findings.ts:82`).
**Disposition:** Correct: `adjudication.ts:337-347` skips a repeated fingerprint before `groundFinding` at `:349`;
`findings.ts:163-182` keeps the first check finding per key after a sort that leaves equal keys in input order, so a
SARIF log with two levels in one bucket has the same defect.
**Locked change:** plan §12 (identity, conservative merge, permutation invariance); data model §2.1 and
`review_findings_dedupe_uq` (identity incl. requirement id and key, nulls not distinct); exit E4; threat T4-28. Code:
ground every finding, group by `(raisedBy, fingerprint, requirementId, key)`, merge conservatively; check findings merge
per `(raisedBy, fingerprint)` keeping the highest severity; refs carry the identity, so records stay unique.
**Validation:** exit E4 (`adjudication.test.ts` › "findings are grounded before they merge and the outcome ignores
their order", all 24 orders of a four-element list); mutation check in the commit report.

### P4-CODE-HIGH-004 — Hunk context counted as a changed line for closure — ACCEPTED
**Concern:** `lineInRepairDelta` accepted any line of the new hunk range; a comment added at line 3 let a citation of
line 2 verify a HIGH finding (`grounding.ts:104`, `adjudication.ts:268`).
**Disposition:** Correct (`grounding.ts:104-107`).
**Locked change:** the changed-line predicate (plan §13, architecture §11). Code: `groundResolution` takes the prior
finding and computes the predicate from the delta entry's added and removed lines.
**Validation:** exit E6 (`grounding.test.ts` › "only a changed line closes a finding, never its context";
`adjudication.test.ts` › "a resolution citing unchanged context leaves the finding blocking", citation on the
unchanged line directly above an added line); mutation check in the commit report.

### P4-CODE-HIGH-005 — A SARIF prior stopped blocking without any closure — ACCEPTED
**Concern:** a HIGH SARIF prior still `OPEN` was left out of the blocking set because its source is not `model`, and no
rule could close a SARIF finding (`adjudication.ts:261`, `:391-401`; `packages/domain/src/assurance.ts:207`, `:224`).
**Disposition:** Correct: `adjudication.ts:261` returns `unchanged` for every non-model prior and `:397-398` counts
only model priors.
**Locked change:** plan §12 (`B` includes SARIF and deterministic priors), §13 (scanner recheck proof), §14 item 6;
architecture §11; data model §2.4, §2.8 (scanner runs in the check report), `finding_dispositions_harness_verify_ck`
and new `finding_dispositions_reviewer_verify_ck`; exit E6; threat T4-28. Code: harness rule `scanner-recheck` in the
domain (verifies `sarif` findings only); SARIF parsing records tool, version, declared rules and invocation success;
the check report carries them; adjudication keeps SARIF priors blocking unless the proof holds or a human closed them.
**Validation:** exit E6 (`adjudication.test.ts` › "a SARIF finding blocks until a scanner recheck proves it gone or a
human closes it"; `assurance.test.ts` › "only a proven scanner recheck verifies a SARIF finding"); mutation check in
the commit report.

### P4-CODE-HIGH-006 — Corpus collection ignored scanner failure — ACCEPTED
**Concern:** the collector ignored each gate's status, error and signal and withheld an excerpt only when the output
named it; five gates failing with status 2 withheld nothing (`collect.ts:575-581`).
**Disposition:** Correct (`collect.ts:577-581`). In the temporary repository `check-publication.sh` also always failed
for an unrelated reason (its dependency-license step needs `scripts/license-inventory.sh` and pnpm), which the old code
could not notice.
**Locked change:** plan §7.5 (gates fail closed; documented codes); data model §7.1; exit I13; threat T4-29. Code: a
gate runner seam; the four scripts accept 0/1, the path-leak scan runs `grep -lE` with `check-publication.sh`'s
`LEAK_PATTERNS` and accepts 1/0; anything else aborts before anything is written; scripts are untracked in the
temporary repository so only excerpts are scanned. The same class in `GitReader` (a spawn error or signal read as "no
such object") aborts too.
**Validation:** exit I13 (`collect.test.ts` › "a publication gate that does not complete aborts collection": crash,
missing executable, error output without an excerpt path, status outside the documented codes); mutation check in
the commit report.

### P4-CODE-MED-001 — A re-raised finding ignored its prior's disposition — ACCEPTED
**Concern:** the same raiser and fingerprint under an unexpired waiver produced a second, `OPEN` entry and REPAIR
(`adjudication.ts:351`, `:363`, `:394`).
**Disposition:** Correct (`adjudication.ts:351-383` opens every current finding; priors are evaluated separately at
`:394-402`).
**Locked change:** plan §12 "Reconciling with prior findings". Interpretation recorded for the controller: R23 says
a `REFUTED` prior does not block; Lane B applies that to priors refuted while grounded (only a human can refute a
grounded finding) and not to priors the harness refuted as ungrounded, so an unresolvable first citation cannot shield
a later grounded one.
**Validation:** exit E4 (`adjudication.test.ts` › "a re-raised finding is reconciled with its prior before it blocks":
live waiver, expired waiver, human refutation, harness refutation, verified prior → regression).

### P4-CODE-MED-002 — The budget left most of the packet uncounted — ACCEPTED
**Concern:** a 450 000-character objective gave `includedBytes` 850 under a 400 000 cap; the 452 993-byte packet and
459 199-byte prompt were accepted (`packet.ts:246`, `:267`; `prompt.ts:230`).
**Disposition:** Correct (`packet.ts:246-249`; `prompt.ts:230` checks only the flag).
**Locked change:** plan §8 "Byte budget"; architecture §8; data model §2.3. Code: `includedBytes` from the canonical
packet bytes plus embedded parts; the renderer measures the prompt and throws `PromptOverBudgetError`; A3 treats
`prompt-over-budget` like an over-budget packet.
**Validation:** exit D7 (`packet.test.ts` › "the budget counts the canonical packet bytes and every embedded part",
oracle: a key-sorted `JSON.stringify` byte count; `prompt.test.ts` › "a rendered prompt over the budget is refused").

### P4-CODE-MED-003 — False green counted only `tests === 0` — ACCEPTED
**Concern:** `tests=3, pass=0, skipped=3` and `tests=1, fail=1, exitCode=0, recorded PASS` raised nothing
(`checks.ts:210`, `:237`).
**Disposition:** Correct (`checks.ts:212`, `:238`).
**Locked change:** plan §14 item 3 (executed = tests − skipped − todo; new rule `failed-tests-recorded-pass`); exit F5.
R23 says executed 0 is a finding without an exit-code condition, so the earlier assertion that a failing run with zero
tests raises nothing is replaced by its opposite; this is the controller's rule change, recorded here.
**Validation:** exit F5 (`checks.test.ts` › "false green counts executed tests and recorded failures").

### P4-CODE-LOW-001 — Extra blank line at the end of `adjudication.ts` — ACCEPTED
**Concern:** `git diff --check a2a7b8a..HEAD` exits 2 for the trailing blank line (`adjudication.ts:494`).
**Disposition:** Correct.
**Locked change:** remove it; `git diff --check a2a7b8a..HEAD` must exit 0 for every Lane B file.
**Validation:** `git diff --check a2a7b8a..HEAD` in the commit report.

### Surviving mutation at the status/output guard — ACCEPTED
**Concern:** replacing the guard at `adjudication.ts:186` with `false` left every test green; `COMPLETED_VALID` with
`output: null` then gave PROCEED.
**Disposition:** Correct: no test feeds an inconsistent pair.
**Locked change:** none in the plan; the test rejects `COMPLETED_VALID` with `output: null` and every other status with a
non-null output.
**Validation:** `adjudication.test.ts` › "a review whose status and output disagree is rejected"; the mutation is
re-run in the commit report.

### Oracles that mirrored the implementation — ACCEPTED
The four named oracles are replaced in the commits that fix their findings: the budget threshold is an independent
byte count (MED-002); grounding cites in-hunk context (HIGH-004); closure has a reviewer repeating the finding
(MED-001); publication covers scanner failure (HIGH-006).

### R22 and R23 applied

| Item | Applied as | Where |
|---|---|---|
| R22 unknown reviewed SHA | excluded `reviewed-tree-unknown`, never guessed | plan §7.5, §7.8; data model §7.1 |
| R22 private-bundle tree | kept, `private-bundle-only`, per-item `dependsOnPrivateBundle`, count reported | plan §7.5, §7.8; data model §7.1; exit I10 |
| R22 self-found item | `inferred-parent-of-fix` | plan §7.8; data model §7.1 |
| R22 Phase 1 without locations | freeze rule `no-location`, count reported | plan §7.8 |
| R22 commit trailers | the eight earlier lane commits are unchanged | — |
| R23 slot decisions | JSON outputs; validating envelope; fenced helpers; terminal before release; redelivery codes | plan §18, §18.2, §18.3 |
| R23 code decisions | paths, egress coverage, identity, changed-line predicate, SARIF, corpus gates, repeated findings, budget, false green, mutation, vocabulary, execution shape | plan §7.5, §7.8, §8, §10.1, §12–§14, §21.1; architecture §8, §9, §11; data model §2, §3.1, §7.1; exit criteria |

### Slot block type-check and helper execution (v4)

The block was extracted from plan §18 with
`awk '/^### Review-loop slot contract \(verbatim for S0\)/{f=1} f&&/^```typescript$/{inb=1;next} inb&&/^```$/{exit} inb{print}'`
into a scratch directory outside the repository (707 lines, sha256
`20c540d060d70df6b0cb2e8aa345ed171ae2e7a59d2fed2c099d3e552a39ddc4`; `cmp` against a second extraction: identical) and compiled as one
module with TypeScript 7.0.2 and the base options (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
declaration emit, `types: ["node"]`, `NodeNext`), with `@asep/contracts` and `@asep/ports` mapped to this branch's
built declarations (`packages/contracts/dist/index.d.ts`, `packages/ports/dist/index.d.ts`, rebuilt by
`pnpm -s typecheck`, exit 0) and `AdmissionResult` re-exported from `packages/application/dist/risk-admission.js`.
`tsc -p tsconfig.json`: exit 0. Controls in a second project over the same block, each expected to fail: an
`AttemptOutcomeInput` and a `RepairContextInput` without `fence` (TS2741 twice), a `recordAttemptOutcome` returning
`Promise<void>` (TS2322), a `ReviewLoopContractError` without a code (TS2554) and with an unknown code (TS2345); exit 1
with exactly those five errors.

The envelope helper was executed from the block text itself with Node 24.6.0's type stripping
(`node --disable-warning=ExperimentalWarning probe.mjs ./src/review-loop/slot-block.ts`, importing the extracted `.ts`)
and again from the `tsc` emit. Each of the 20 negative fixtures — `{x: undefined}`, `{x: Infinity}`, `{x: -Infinity}`,
`{x: NaN}`, `{x: -0}`, `{x: new Date(0)}`, `{x: new Map()}`, `{x: new Set()}`, a class instance, `[1, , 3]`, a cycle,
a `bigint`, a function, an `undefined` root, a nested `undefined`, a getter, a non-enumerable property, a symbol key, an
array with an extra key and a 200 000-deep nesting — threw `ReviewLoopContractError` with code `invalid-payload`; the
six positive controls (`null`, `{}`, `[]`, `Object.create(null)` with a key, a shared reference, a nested plain
object) were accepted and round-trip; 65 536 bytes accepted and 65 537 rejected with `invalid-payload`; `'é'` measured
4 bytes. Exit 0 both ways. Control: the same probe against a copy whose helper body is the v3 `JSON.stringify`-only
version accepted 16 of the 20 negative fixtures and exited 1. Not verified: compilation as three separate files inside
`packages/application` (they do not exist until S0).

### DDL re-validation (v4)

See data model §3.5: the §3.1–§3.3 blocks and the §3.6 rollback applied on PGlite `0.5.4` after the twelve Phase 2
migrations, and a constraint probe confirmed the new identity, path and disposition-actor constraints.

### Freeze gate (v4)

Every numbered finding of the review is dispositioned (16 accepted, 0 rejected) and R22 and R23 are applied in the
documents. Remaining before the corpus freeze and before Lane A receives the block: the controller's focused check of
the slot block and of the code fixes at the lane head, and confirmation of v4.

## Review v4 (Codex `gpt-6.1-sol`, snapshot `7cc20f4`)

> Raw review: `phase-04-review-codex-v4.md` (verbatim copy with provenance). Verdict: REQUEST_CHANGES, confidence
> 0.99, `HAND-OFF: NOT_READY`. Controller decisions applied alongside: `reconciliation-v1.md` R26 (root cause of the
> V8 gate crash; the Phase 2 lane owns the workaround) and R28 (final decisions for this re-check, including two slot
> rules that bind both lanes; applied as written). Each finding's cited text was re-read at `7cc20f4` before deciding;
> line numbers below refer to `7cc20f4`. The controller's gate at that snapshot, on a clean detached worktree:
> `pnpm verify:all` twice, each exit 0, 613 pass, 0 fail, 0 skipped, 60 files, 37 required suites.

### Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| HIGH — plan (P4-PLAN4) | 1 | 1 | 0 | 0 |
| MEDIUM — plan (P4-PLAN4) | 2 | 2 | 0 | 0 |
| MEDIUM — slot block (P4-SLOT4) | 2 | 2 | 0 | 0 |
| HIGH — code (P4-CODE4) | 3 | 3 | 0 | 0 |
| MEDIUM — code (P4-CODE4) | 2 | 2 | 0 | 0 |
| **Total numbered** | **10** | **10** | **0** | **0** |
| Unnumbered: telemetry contradiction; types that allow invalid combinations; surviving mutation at the re-raise branch; budget oracle that mirrored the zeroed rule; collector versus the full publication gate | 5 | 5 | 0 | 0 |

The re-check confirmed P4-PLAN3-MED-001…003 and P4-SLOT-MED-001…003 as FOLDED, and P4-CODE-HIGH-001, -002, -004,
-006, P4-CODE-MED-003, P4-CODE-LOW-001 and the v3 status/output mutation as RESOLVED. The four v3 items it found
PARTIAL continue as new findings: P4-CODE-HIGH-003 → P4-CODE4-HIGH-003; P4-CODE-HIGH-005 → P4-CODE4-HIGH-002 and
P4-PLAN4-HIGH-001; P4-CODE-MED-001 → P4-CODE4-HIGH-001; P4-CODE-MED-002 → P4-CODE4-MED-001 and P4-PLAN4-MED-001.

The plan and slot-block fixes land in the docs-only commit that carries this section; each code finding lands in its
own commit with a failing-first test and a mutation check (revert the fix, show the new test fails, restore),
reported in the lane report.

### P4-PLAN4-HIGH-001 — A declared SARIF rule counted as proof that it ran — ACCEPTED
**Concern:** plan §13 and architecture §11 accepted a recheck from a run that declares the finding's rule; a disabled
rule satisfied the predicate (`phase-04-plan.md:874`; `phase-04-architecture.md:435`).
**Disposition:** Correct. Both lines re-read; in the code `checks.ts:502-506` records every declared rule id and `:507`
only the invocations' success, and nothing reads the rule configuration, notifications or artifacts. R28 defines the
proof.
**Locked change:** plan §13 (effective execution and coverage: same scanner and version, the rule enabled in the
effective configuration, no notification associated with it, every invocation successful, the finding's file among the
scanned artifacts, no result for its fingerprint; anything unproven is not proven), §14 item 6; architecture §11
(`scannerRecheck(F)` with `effectiveRules` and `scannedFiles`); data model §2.8 (scanner run `{checkId, tool,
toolVersion, executionSuccessful, effectiveRules, scannedFiles}`); research register (SARIF 2.1.0 schema properties,
retrieved 2026-10-30); exit E6; threat T4-28.
**Validation:** exit E6, the four R28 cases; the code half is P4-CODE4-HIGH-002.

### P4-PLAN4-MED-001 — The budget measured the packet with its own figures zeroed — ACCEPTED
**Concern:** plan §8 and data model §2.3 measured the packet with `includedBytes = 0` and `overBudget = false`, not the
canonical serialized packet R23 names (`phase-04-plan.md:648`; `phase-04-data-model.md:71`).
**Disposition:** Correct: `packet.ts:295` builds the measured packet with both figures zeroed, `:303-304` measures it,
and `:307` writes the real figures into the packet that `:309-310` hashes, so the hashed bytes are longer than the
measured ones by the digits of `includedBytes` (the reviewer's probe: 2 261 measured, 2 264 actual, cap 2 261,
accepted).
**Locked change:** plan §8 (`includedBytes` is the UTF-8 length of the **final** canonical packet bytes plus every
embedded part; it is recorded beside the packet — `BuildReviewPacketOutput.includedBytes`,
`review_rounds.packet_included_bytes` — never inside it; `budget.overBudget` is a decision, and an accepted packet is
measured with the `false` it carries; the invariant and its independent oracle); architecture §8; data model §2.3
(`budget: {maxBytes, overBudget, omissions}`), §3.1 (`packet_included_bytes`, `review_rounds_packet_size_ck`, and the
round guard keeps the packet hash, its size and the over-budget flag immutable once set); slot block
`BuildReviewPacketOutput.includedBytes`; RLC-06; exit D7.
**Validation:** exit D7 (`packet.test.ts` › "the budget is the final packet bytes, at the cap and one byte over", oracle
`Buffer.byteLength` of the canonical JSON of the final packet object); the code half is P4-CODE4-MED-001.

### P4-PLAN4-MED-002 — `prompt-over-budget` could not be persisted — ACCEPTED
**Concern:** the plan records a refused prompt as `FAILED` with reason `prompt-over-budget`, which
`review_records_failure_ck` does not allow (`phase-04-plan.md:655`; `phase-04-data-model.md:261`).
**Disposition:** Correct: the enum at `phase-04-data-model.md:261-263` has no such value.
**Locked change:** data model §3.1: `review_records_failure_ck` adds `'prompt-over-budget'`; v5 also requires
`record_artifact_id` for a `COMPLETED` record (`review_records_completed_ck`) and a non-negative integer micro-USD cost
with its price source (`review_records_cost_ck`); exit H3 adds the S8 persistence regression (R28).
**Validation:** the DDL probe below (`FAILED with prompt-over-budget, no request: accepted`); exit H3
(`assurance-persistence.itest.ts` › "every review failure reason is accepted by the database", in S8).

### P4-SLOT4-MED-001 — Money at the seam was floating USD — ACCEPTED
**Concern:** `budgetRemaining.costUsd`, `AssuranceUsage.reviewCostUsd`, `modelCostUsd` and `computeCostUsd` were USD
`number`s with no unit, rounding, null or bounds contract against Phase 3's integer micro-USD ledger
(`phase-04-plan.md:1209`, `:1321`, `:1417`); the R21 boundary `5.0000004` on a cap of `5` must stay an overrun.
**Disposition:** Correct (the three lines re-read). R28: integer micro-USD at the seam.
**Locked change:** slot block v5: `budgetRemaining.costMicroUsd`, `AssuranceUsage.reviewCostMicroUsd`,
`cost.modelCostMicroUsd`, `cost.computeCostMicroUsd`; `null` means unknown; conversion from a provider's decimal USD
happens once, in the adapter, with ceiling; the envelope helper rejects a `*MicroUsd` value that is not `null` or a
non-negative safe integer, at any depth (`payload breaks the slot envelope: … is not integer micro-USD`). RLC-01 money
fixtures (`5000000.4`, the boundary before ceiling, is rejected); SR-A13; data model §3.1
`review_records.cost_micro_usd bigint` and "Money in events" (the run-event v1 USD fields are written as
`microUsd / 1 000 000` and read back to the same decimal); risk PR4-40.
**Validation:** RLC-01; the helper probe below (seven money negatives rejected, the money positives accepted); controls
C14 and C15.

### P4-SLOT4-MED-002 — A terminal before the lease was left out of the slot — ACCEPTED
**Concern:** the v4 block did not record a terminal reached before a lease, while SR-A3 and exit H4 require every
terminal; "Lane A audits it" had no contract with the same event semantics (`phase-04-plan.md:1427`, `:1796`;
`phase-04-risk-register.md:47`).
**Disposition:** Correct: `phase-04-plan.md:1427` says such an attempt "is not recorded here" and `:1796` (SR-A3)
requires every terminal. R28 adopts the reviewer's conditions as eight obligations (its conditions 3 and 4 — never
leased, read from durable history — are one obligation).
**Locked change:** slot block v5: `AttemptOutcomeInput = LeasedAttemptOutcomeInput | PreLeaseAttemptOutcomeInput`;
`fence: null` only on the pre-lease variant, whose terminal is in `PRE_LEASE_ATTEMPT_TERMINALS` (`cancelled`,
`infrastructure-failed`), with obligations 1–8 written on it; `RepairContextInput.fence` stays required (obligation
8). Plan §18.2: "every terminal is recorded", the obligations table, RLC-16 (pre-lease terminal; redelivery;
allowlist; scope; atomicity; the race with lease acquisition over 20 fresh subjects, exactly one wins) and RLC-17
(`fence: null` refused while leased, after `rotateFence()`, after `endLease()`, and after a pre-lease attempt's own
lease; a null fence on the repair helper → `invalid-input`); fixture fields `preLeaseAttempt` and `failNextCommit`.
§18.3: SR-A3 back to "every terminal is recorded"; SR-A11 (composition obligations 1, 2, 5); SR-A12 (Lane A lists
every never-leased path and its terminal; anything outside the allowlist goes back to the controller). Exit E12, H4;
risk PR4-37 resolved, PR4-39; threat T4-30.
**Validation:** RLC-16, RLC-17; controls C1, C3 and C7.

### P4-CODE4-HIGH-001 — A lower-severity re-raise hid an open prior — ACCEPTED
**Concern:** a grounded `OPEN` HIGH prior re-raised at LOW by the same raiser was linked, left the blocking set, and
the round became PROCEED in gating and shadow alike (`adjudication.ts:487`, `:499`, `:510`).
**Disposition:** Correct: `:487` marks every matched prior linked, `:499` takes only the current finding's severity,
and `:510` drops every linked prior from `B`.
**Locked change:** plan §12 "A re-raise never downgrades"; data model §2.1; architecture reconciliation paragraph;
exit E4; threat T4-28. Code: a re-raise linked to a prior it does not shield carries the highest severity of itself
and every such prior; the pair counts once in `B`.
**Validation:** exit E4 (`adjudication.test.ts` › "a re-raise never downgrades a prior that still blocks":
HIGH→LOW, CRITICAL→LOW, CRITICAL→CRITICAL, each asserting outcome, blocking severity and the prior's lifecycle);
the reviewer's surviving mutation is re-run in the commit report.

### P4-CODE4-HIGH-002 — A disabled SARIF rule closed a finding — ACCEPTED
**Concern:** a log that declares the rule with `defaultConfiguration.enabled: false` and an override disabling it,
with `executionSuccessful: true`, produced the proof and closed a SARIF HIGH as `VERIFIED` (`checks.ts:488`;
`adjudication.ts:253`).
**Disposition:** Correct (`checks.ts:488-508` re-read; see P4-PLAN4-HIGH-001).
**Locked change:** as P4-PLAN4-HIGH-001. Code: the scanner run records `effectiveRules` (declared, enabled by its
default configuration and by every override, no notification associated with it) and `scannedFiles` (artifacts whose
roles, when present, include `analysisTarget`); a structural error is malformed and proves nothing; the recheck needs
the rule in `effectiveRules` and the file in `scannedFiles`.
**Validation:** exit E6 (`checks.test.ts` › "a scanner run records the rules it effectively ran and the files it
scanned"; `adjudication.test.ts` › "a SARIF recheck needs effective execution and coverage": disabled by default
configuration, disabled by override, rule-failure notification, file not scanned); mutation check in the commit report.

### P4-CODE4-HIGH-003 — Joined-string identities collided — ACCEPTED
**Concern:** `(requirementId "REQ\nf1", key "x")` and `("REQ", "f1\nx")` produce the same identity at
`adjudication.ts:424`; with a live waiver on one, the unwaived HIGH disappeared in the merge and the round became
PROCEED. The WorkOrder and reviewer-output schemas allow both strings.
**Disposition:** Correct: `:424` joins with `'\n'` and maps `null` to `''`. The same class elsewhere at `7cc20f4`:
the fingerprint (`findings.ts:101`), the check merge and dedupe keys (`findings.ts:171`, `:206`), the adjudication id
(`adjudication.ts:586`, `|` and `,`), the reviewer-list comparison (`:195`), the blocking order key (`:519`), the
repair-order id (`repair.ts:121`) and the diff-path comparison (`checks.ts:125`). R28: every identity, fingerprint and
dedupe key, not only the cited one.
**Locked change:** plan §12 "Identity encoding"; data model §2.1, §2.4; architecture reconciliation paragraph; exit
E4; threat T4-28. Code: one canonical-JSON tuple helper used for each key above; `null` and `""` stay distinct.
**Validation:** exit E4 (`adjudication.test.ts` › "identity keys are canonical tuples and never collide";
`checks.test.ts` › "check identity keys are canonical tuples and never collide"), collision fixtures with separators
inside fields and `null` against `""`; mutation check in the commit report.

### P4-CODE4-MED-001 — The budget boundary was wrong on the final bytes — ACCEPTED
**Concern:** with an empty diff and file list, cap 2 261, `includedBytes` 2 261 and actual bytes 2 264, the packet was
accepted; the test oracle zeroed the same two fields and so mirrored the bug (`packet.ts:295`, `:303`;
`packet.test.ts:121`).
**Disposition:** Correct (see P4-PLAN4-MED-001).
**Locked change:** as P4-PLAN4-MED-001. Code: the packet carries `{maxBytes, overBudget, omissions}`; the builder
measures the final canonical bytes (with the `overBudget` value they carry) plus the embedded parts and returns
`includedBytes` beside the packet.
**Validation:** exit D7 (`packet.test.ts` › "the budget is the final packet bytes, at the cap and one byte over": the
oracle serializes the returned packet object independently; at the cap accepted, at cap + 1 flagged); mutation check
in the commit report.

### P4-CODE4-MED-002 — The collector could run a stale copy of the leak patterns — ACCEPTED
**Concern:** `leakPatterns` parsed only the first `LEAK_PATTERNS=(` block, so a valid `LEAK_PATTERNS+=(…)` after it was
silently ignored (`collect.ts:625`, `:678`; `collect.test.ts:324`).
**Disposition:** Correct: `collect.ts:626` matches the first block only, and `scripts/check-publication.sh:26-31` is the
second copy of the source of truth.
**Locked change:** plan §7.5 "One source for the path-leak patterns": `scripts/lib/publication-leak-patterns.txt`, one
ERE per line, read by both `scripts/check-publication.sh` (the minimal change R28 allows) and the collector; the
collector never replaces the full publication gate, which still runs before any public push; exit I13; threat T4-29.
**Validation:** exit I13 (`collect.test.ts` › "the collector and the publication gate read one list of leak
patterns": the real script's path scanner and the collector run on the same fixtures and agree, and a pattern
appended to the file is seen by both).

### Telemetry contradiction (unnumbered) — ACCEPTED
**Concern:** the block excluded pre-lease terminals while SR-A3 and exit H4 required every terminal
(`phase-04-plan.md:1427`, `:1796`; `phase-04-exit-criteria.md:132`).
**Disposition:** Correct; resolved with P4-SLOT4-MED-002. SR-A3 and H4 now read "every terminal is recorded".

### Types that allowed invalid combinations (unnumbered) — ACCEPTED
**Concern:** `RunReviewerOutput` allowed `COMPLETED_VALID` with `reviewRecordRef: null`, and the outcome types allowed
mode and shadow to disagree (`phase-04-plan.md:1293`, `:1331`).
**Disposition:** Correct. R28: discriminated unions with negative fixtures; envelope validation stays JSON-only.
**Locked change:** `RunReviewerOutput = CompletedReviewerOutput | FailedReviewerOutput | NotSentReviewerOutput`;
`ProceedOutcome = ShadowProceedOutcome | DecidedProceedOutcome`; REPAIR and ESCALATE carry `mode: 'gating'`; RLC-06
checks the same invariants at runtime on every output.
**Validation:** controls C8–C13; RLC-06 negative fixtures (the scripted slot returning each violating shape fails).

### Surviving mutation at the re-raise branch (unnumbered) — ACCEPTED
**Concern:** `blocking: blockingSeverity.has(f.severity) && f.severity !== 'CRITICAL'` at `adjudication.ts:499` left
all 61 pure-core tests green; a CRITICAL re-raise of an open CRITICAL prior then gave PROCEED.
**Disposition:** Correct: the re-raise cases use HIGH only.
**Validation:** the CRITICAL→CRITICAL case of P4-CODE4-HIGH-001's test; the mutation is re-run in the commit report.

### Budget oracle that mirrored the zeroed rule (unnumbered) — ACCEPTED
Replaced in P4-CODE4-MED-001's commit by an oracle that serializes the final packet object independently.

### Collector versus the full publication gate (unnumbered) — ACCEPTED
The collector scans excerpts only; LICENSE, history and dependency-license checks stay with the full gate
(`scripts/check-publication.sh`), which still runs before any public push. Plan §7.5 states it.

### R26 and R28 applied

| Item | Applied as | Where |
|---|---|---|
| R26 V8 gate crash | not Lane B's change; the Phase 2 lane adds the workaround; any crash in a Lane B gate run is recorded (suite, run number, load) as R24 requires | lane report |
| R28 money | integer micro-USD at the seam, conversion once with ceiling in the adapter, envelope negatives | plan §18 block, §18.2 RLC-01, §18.3 SR-A13; data model §3.1, money in events; risk PR4-40 |
| R28 terminal before lease | nullable fence only for a never-leased attempt, eight obligations, allowlist, RLC-16, RLC-17; SR-A3 and H4 back to every terminal | plan §18 block, §18.2, §18.3; exit E12, H4; risk PR4-37, PR4-39; threat T4-30 |
| R28 discriminated unions | reviewer output and outcome types; controls C8–C13 | plan §18 block, RLC-06 |
| R28 no downgrade | highest severity of the linked pair; counted once | plan §12; data model §2.1; architecture; exit E4 |
| R28 scanner proof | effective execution and coverage; four cases | plan §13, §14; architecture §11; data model §2.8; research register; exit E6 |
| R28 identity encoding | canonical JSON tuples for every key | plan §12; data model §2.1, §2.4; exit E4 |
| R28 final-byte budget | final bytes; size beside the packet; oracle at cap and cap + 1 | plan §8; architecture §8; data model §2.3, §3.1; exit D7 |
| R28 `prompt-over-budget` | in `review_records_failure_ck`; S8 regression | data model §3.1; exit H3 |
| R28 one leak-pattern source | `scripts/lib/publication-leak-patterns.txt`; parity test; the gate is not replaced | plan §7.5; exit I13; threat T4-29 |
| R28 MED-001 interpretation | confirmed: a harness refutation does not shield a grounded re-raise | plan §12 |

### Slot block type-check and helper execution (v5)

The block was extracted from plan §18 with
`awk '/^### Review-loop slot contract \(verbatim for S0\)/{f=1} f&&/^```typescript$/{inb=1;next} inb&&/^```$/{exit} inb{print}'`
into a scratch directory outside the repository (839 lines, sha256
`a772194f34bc6efb84a2bc48b68b452a1958cf8c20ba9812d3062272c7340df3`; `cmp` against a second extraction: identical) and
compiled as one module with TypeScript 7.0.2 and the v4 options (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, declaration emit, `types: ["node"]`, `NodeNext`), with `@asep/contracts` and `@asep/ports`
mapped to this branch's built declarations and `AdmissionResult` re-exported from
`packages/application/dist/risk-admission.js`. `tsc -p tsconfig.json`: exit 0. Fifteen controls in a second project
over the same block, each expected to fail with exactly one error: C1 a leased outcome without `fence` (TS2741), C2 a
repair request without `fence` (TS2741), C3 a repair request with `fence: null` (TS2322), C4 a `Promise<void>`
`recordAttemptOutcome` (TS2322), C5 an error without a code (TS2554), C6 an unknown code (TS2345), C7 `fence: null`
with terminal `proceeded` (TS2322), C8 `COMPLETED_VALID` with a null record (TS2322), C9 `FAILED` with a record
(TS2322), C10 a never-sent review with one provider call (TS2322), C11 shadow PROCEED without a shadow verdict
(TS2322), C12 gating PROCEED with one (TS2322), C13 REPAIR in shadow mode (TS2322), C14 `budgetRemaining.costUsd`
(TS2353), C15 `cost.modelCostUsd` (TS2353). `tsc -p tsconfig.control.json`: exit 1 with exactly those 15 errors, one per
control line.

The envelope helper was executed from the block text with Node 24.6.0's type stripping
(`node --disable-warning=ExperimentalWarning probe.mjs ./src/review-loop/slot-block.ts`) and again from the `tsc` emit
(`node probe.mjs ./dist/review-loop/slot-block.js`); both printed the same lines and exited 0. The v4 probe's 20
negative fixtures and six positive controls behave as in v4; the seven money negatives — a fractional
`budgetRemaining.costMicroUsd` (`5000000.4`), a negative `usage.reviewCostMicroUsd`, `2 ** 53` as
`cost.modelCostMicroUsd`, a string, a boolean and an object as `cost.computeCostMicroUsd`, and a fraction inside an array
element — each threw `ReviewLoopContractError` `invalid-payload`; `*MicroUsd` values `null`, `0` and
`Number.MAX_SAFE_INTEGER` and a fraction under a key that is not `*MicroUsd` were accepted and round-trip; 65 536 bytes
accepted, 65 537 rejected with `invalid-payload`; `'é'` measured 4 bytes. Control: the same probe against the v4 block
exited 1 with seven unexpected results (the money negatives). The reviewer's own one-line probe
(`stripTypeScriptTypes` over the plan text, run from the repository root) extended with the seven money negatives and
three money positives printed `negative 25/25 positive 9/9`, `65536 ACCEPT`, `65537 ReviewLoopContractError
invalid-payload`, exit 0. Not verified: compilation as three separate files inside `packages/application` (they do not
exist until S0).

### DDL re-validation (v5)

See data model §3.5: the §3.1–§3.3 blocks and the §3.6 rollback applied on PGlite `0.5.4` after the twelve Phase 2
migrations, and the constraint probe passed 29 of 29, including the round's packet size, `prompt-over-budget`, a
completed record without its artifact and the micro-USD cost.

### Freeze gate (v5)

Every numbered finding of the review is dispositioned (10 accepted, 0 rejected) and R26 and R28 are applied in the
documents. Remaining before the corpus freeze and before Lane A receives the block: the controller's re-check of the
v5 block and of the code fixes at the lane head, and confirmation of v5.

## Review v5 (Codex `gpt-6.1-sol`, snapshot `fb2e432`)

> Raw review: `phase-04-review-codex-v5.md` (verbatim copy with provenance). Verdict: REQUEST_CHANGES, confidence
> 0.99, `HAND-OFF: NOT_READY`. Controller decision applied alongside: `reconciliation-v1.md` R32 (final decisions for
> this re-check; applied as written), checked against R29 (pre-lease recovery and the store-unreadable exception) and
> R31 (publication identity, Lane A's). Each finding's cited text was re-read at `fb2e432` before deciding; line numbers
> below refer to `fb2e432`. The controller's checks at that snapshot, on a clean detached worktree: `pnpm verify:all`
> exit 0, 620 pass, 0 fail, 0 skipped, 60 files, 37 required suites; shellcheck (Docker `koalaman/shellcheck:stable`)
> on `scripts/check-publication.sh`: one SC2046 warning, identical to the `00a6889` version, no new warning.

### Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| HIGH — slot block (P4-SLOT5) | 1 | 1 | 0 | 0 |
| HIGH — code (P4-CODE5) | 3 | 3 | 0 | 0 |
| MEDIUM — plan (P4-PLAN5) | 1 | 1 | 0 | 0 |
| MEDIUM — slot block (P4-SLOT5) | 1 | 1 | 0 | 0 |
| MEDIUM — code (P4-CODE5) | 1 | 1 | 0 | 0 |
| LOW — plan (P4-PLAN5) | 1 | 1 | 0 | 0 |
| LOW — code (P4-CODE5) | 1 | 1 | 0 | 0 |
| **Total numbered** | **9** | **9** | **0** | **0** |
| Unnumbered: surviving SARIF severity mutation; blocking-order mutant wrongly declared equivalent; `result.rule.toolComponent` overlooked; line-based `git ls-files`; `providerCalls` typed as any number; R31 note | 6 | 5 | 0 | 0 (1 acknowledged, no change) |

The re-check confirmed P4-CODE4-HIGH-001, HIGH-003, MED-001, MED-002, v3 P4-CODE-HIGH-003, MED-001, MED-002 and the v4
CRITICAL mutation as RESOLVED, the block's helper as rejecting 27/27 hostile payloads, and the block as type-checking
with 0 diagnostics and 15/15 controls. Its PARTIAL items continue here: P4-SLOT4-MED-002 → P4-SLOT5-HIGH-001 and
P4-SLOT5-MED-001; P4-CODE4-HIGH-002 and v3 P4-CODE-HIGH-005 → P4-CODE5-HIGH-001 and HIGH-002, which R32 settles by
deferring scanner-recheck closure out of Phase 4.

The plan and slot-block fixes land in the docs-only commit that carries this section; each code finding lands in its
own commit with a failing-first test and a mutation check, reported in the lane report.

### P4-PLAN5-MED-001 — The R29 exception to "every terminal is recorded" was not stated — ACCEPTED
**Concern:** R29 lets a terminal go unrecorded when a lookup fails after its retry policy; the plan, SR-A3 and H4 still
said "every terminal" without exception, and J6 did not require a gap report keyed by the attempt's idempotency key
(`phase-04-plan.md:1638`, `:1943`, `:2012`; `phase-04-exit-criteria.md:133`, `:165`).
**Disposition:** Correct (all five lines re-read). R32 widens the wording to a store that cannot be read or written
after the retry policy (a failed lookup, or a failed pre-lease terminal write), matching Lane A's turn 9.
**Locked change:** the block's `PreLeaseAttemptOutcomeInput` and `recordAttemptOutcome` docs; plan §18.2 terminal
vocabulary; SR-A3 (the exception, `FAILED` / `attempt-state-unknown`, the idempotency key in the audit entry, the gap
report); SR-A14; exits H4 and J6. `attempt-state-unknown` is a task outcome, not a pre-lease terminal (the allowlist is
unchanged).
**Validation:** exit H4; exit J6 (`assurance-dashboards.itest.ts` › "telemetry completeness reports an unrecorded
terminal with its idempotency key").

### P4-PLAN5-LOW-001 — `provenance: excerpt-only` sat next to the R22 vocabulary — ACCEPTED
**Concern:** the plan still marked items `provenance: excerpt-only` beside `private-bundle-only`
(`phase-04-plan.md:477`, `:482`).
**Disposition:** Correct (`:477` re-read).
**Locked change:** plan §7.5 describes the verification mode (a clean clone checks a `private-bundle-only` item's
excerpts only for internal consistency; checking them against git needs the bundle) and states that this is not a
provenance value.
**Validation:** wording only; the collector has no `excerpt-only` value (`evals/review-corpus/collect.ts` vocabulary
unchanged).

### P4-SLOT5-HIGH-001 — A late lease grant was read as supersession — ACCEPTED
**Concern:** a `fence: null` write refused because a grant committed late raised `AssuranceFencedError`, and the
activity policy maps every `AssuranceFencedError` to supersession; R29 requires a lookup and a write with the found
fence (`phase-04-plan.md:1644`, `:1989`, `:2012`, `:2023`).
**Disposition:** Correct: `:1989` names `AssuranceFencedError` for a null fence on a leased attempt and `:2023` reads
every `AssuranceFencedError` as supersession. R32: a distinct code.
**Locked change:** `ReviewLoopContractErrorCode` gains `lease-granted`; the pre-lease doc, the `recordAttemptOutcome`
doc and the §18.2 check order name it; RLC-16's race expects `lease-granted` and then the recovery write; RLC-17
expects `lease-granted` (never `AssuranceFencedError`); new RLC-18 (late grant: refusal, recovery with the found fence,
redelivery); SR-A14 (the R29 procedure, at most two lookups, lookup failure under SR-A3's exception); activity policy
(`lease-granted` → a typed non-retryable result the workflow handles under SR-A14, never supersession); risk PR4-39;
threat T4-30; exits E12, H4.
**Validation:** RLC-16, RLC-17, RLC-18; exit H4 (`steps.test.ts` › "a late lease grant is refused with lease-granted and
recorded with its fence"); the helper probe below constructs the code from the block text.

### P4-SLOT5-MED-001 — Atomicity could be skipped and registration ordering was unproven — ACCEPTED
**Concern:** a stateful implementation could pass `failNextCommit: null` and report RLC-16's atomicity part
not-applicable; the unregistered-attempt case did not prove registration before every attempt-bound effect
(`phase-04-plan.md:1857`, `:1954`, `:1983`; `phase-04-exit-criteria.md:96`).
**Disposition:** Correct (`:1857` re-read: "null when the implementation cannot inject that").
**Locked change:** `ReviewLoopConformanceFixture` is now `StatefulConformanceFixture | StatelessConformanceFixture`: a
stateful fixture must supply every hook (the commit-failure hook included), and only the disabled, not-configured and
scripted slots may declare `stateless: true`; RLC-16's atomicity part is mandatory for stateful subjects; new
`runRegistrationOrderingContract` (RLC-19), which Lane A runs against its workflow (scenarios: first attempt, repair
attempt, cancel before any lease, failed or aborted acquisition, crash and redelivery), with the kit's own negative
trace; SR-A11; exit E12; risk PR4-41.
**Validation:** controls C16 and C17 (a stateful fixture without the hook, a stateless one with a persistence hook) and
C18 (an effect without an attempt id) fail to type-check; RLC-16, RLC-19; exit E12 (`slot.test.ts` › "the
registration-ordering kit refuses an effect before registration").

### P4-CODE5-HIGH-001 — A valid reference form changed a SARIF finding's fingerprint and closed its prior — ACCEPTED
**Concern:** `result.ruleIndex`, `result.rule` and `artifactLocation.index` were ignored, so the same result written in
another form got another fingerprint, and the recheck closed the HIGH prior as `VERIFIED` (`checks.ts:633`, `:645`;
`adjudication.ts:255`).
**Disposition:** Correct: `checks.ts:633` reads only `result.ruleId`, `:645-646` only `artifactLocation.uri`, and
`adjudication.ts:255` closes on the fingerprint's absence. R32 settles it two ways: the recheck closure is removed
(nothing a log says can close a SARIF finding), and ingestion resolves every reference form or flags it.
**Locked change:** plan §5.3 DF-9 (scanner-recheck closure deferred, with entry criteria), §13 (a SARIF finding closes
only by an authorized human), §14 item 6 (reference resolution and the `unresolved-reference` flag), §12 (a flagged
finding is never linked to a prior); architecture §11; data model §2.1, §2.4, §2.8, `review_findings.unresolved_reference`
and `review_findings_unresolved_ck`, `finding_dispositions_harness_verify_ck` without `scanner-recheck`; exits E6, F3;
threat T4-28; risks PR4-42, PR4-43. Code: remove the recheck path, the scanner-run record and the domain's
`scanner-recheck` rule; resolve references.
**Validation:** exit E6 (`adjudication.test.ts` › "a SARIF finding blocks until a human closes it", "a scanner log
claiming a SARIF finding gone does not close it"; `assurance.test.ts` › "only a human verifies a SARIF finding"); exit F3
(`checks.test.ts` › "sarif references resolve to one finding or are flagged, never dropped": the four probe forms give
one fingerprint; `adjudication.test.ts` › "a finding with an unresolved reference is never linked to a prior");
mutation checks in the commit report.

### P4-CODE5-HIGH-002 — Coverage under a foreign `uriBaseId` counted for the repaired tree — ACCEPTED
**Concern:** an artifact with `uriBaseId: "FOREIGN"` bound by `originalUriBaseIds` to another checkout still counted as
scanned, and the recheck closed the prior (`checks.ts:583`; `adjudication.ts:255`).
**Disposition:** Correct (`checks.ts:583` reads only `location.uri`). Settled with HIGH-001: no coverage is recorded any
more, and a result whose location carries any `uriBaseId` is flagged `unresolved-reference`, because nothing binds a
base to the repaired repository root in Phase 4 (binding is a DF-9 entry criterion).
**Locked change:** as P4-CODE5-HIGH-001.
**Validation:** `checks.test.ts` › "sarif references resolve to one finding or are flagged, never dropped" (the review's
`FOREIGN` probe is flagged and kept); "a scanner log claiming a SARIF finding gone does not close it".

### P4-CODE5-HIGH-003 — The path scanner read its own failure as clean — ACCEPTED
**Concern:** grep ran inside an `if`, so an invalid ERE or a grep that could not run gave exit 0 in `--scan-paths`;
file names were not preceded by `--` (`scripts/check-publication.sh:62`, `:68`, `:157`).
**Disposition:** Correct: `:68` is `if grep -nE -e "$pat" "$file" …; then`, so status 2 reads as no hit, and `:62`
skips a path that is not a regular file. The review's shell probe table (`[` and a 127 status exit 0) agrees.
**Locked change:** plan §7.5 "The path scanner fails closed"; exit I13; threat T4-29. Code: read grep's status as 0, 1
or other; exit 2 on any other status, on a pattern that fails when run once on empty input, on an unreadable input file
and on no input file; `--` before file names.
**Validation:** exit I13 (`collect.test.ts` › "the publication path scanner fails closed": the review's probe table as
cases); shellcheck through Docker reports no new warning (lane report).

### P4-CODE5-MED-001 — The pattern list was exempt from the full scan as a whole file — ACCEPTED
**Concern:** the full gate exempted `scripts/lib/publication-leak-patterns.txt`, so a concrete private path in one of
its comments would pass (`scripts/check-publication.sh:55`, `:56`, `:171`).
**Disposition:** Correct: `:56` lists the file in `EXEMPT_REGEX`, and the list does not match itself (the review's grep
returned 1), so the exemption bought nothing. The same step enumerated files with line-based `git ls-files` (`:173`),
which drops a name Git quotes (inherited; R32 fixes it here).
**Locked change:** plan §7.5; exit I13. Code: remove the list from `EXEMPT_REGEX`; enumerate with `git ls-files -z`.
**Validation:** exit I13 (`collect.test.ts` › "the publication path scanner fails closed": a private path in a comment of
the list fails the tracked-file scan; a tracked name with a quote-worthy character is scanned).

### P4-CODE5-LOW-001 — `includedBytes` of a rejected packet was not its stored size — ACCEPTED
**Concern:** `includedBytes` was measured on the candidate carrying `overBudget: false`, while a rejected packet is
stored with `true`, one byte shorter; the slot doc called it the final bytes (`packet.ts:309`, `:313`;
`phase-04-plan.md:1319`).
**Disposition:** Correct (`packet.ts:309-313` re-read). R32: measure after the flag is set, accepted and rejected alike.
**Locked change:** plan §8; the block's `BuildReviewPacketOutput` docs; RLC-06's budget invariant (accepted:
`includedBytes ≤ cap`; rejected: a diff over its limit or `includedBytes + 1 > cap`); architecture §8; data model §2.3;
exit D7.
**Validation:** exit D7 (`packet.test.ts` › "included bytes are the stored packet's final size", oracle on the returned
packet object for accepted and rejected packets).

### Surviving mutation: SARIF exempt from the severity maximum — ACCEPTED
**Concern:** `const severity = f.source === 'sarif' ? f.severity : …` at `adjudication.ts:499` left 67/67 pure-core tests
green; the downgrade fixtures were model findings only.
**Disposition:** Correct.
**Validation:** `adjudication.test.ts` › "a SARIF re-raise never downgrades a prior that still blocks" (HIGH→MEDIUM,
CRITICAL→LOW); the mutation is re-run in the commit report.

### Blocking-order mutant declared equivalent in `dec419b` — ACCEPTED
**Concern:** restoring the joined order key changes the order of blocking records when reviewer ids contain LF and `/`
(`["a\nz", "a/z"]`), and no test noticed (`adjudication.ts:523`).
**Disposition:** Correct; the v4 lane report was wrong to call this mutant equivalent: the record's order is
observable even when the outcome is not. The other three (dedupe key, merge key, `persistedIdentity`) are confirmed
equivalent by the review.
**Validation:** `adjudication.test.ts` › "blocking records are in canonical tuple order"; restoring the joined key must
fail (commit report).

### `result.rule.toolComponent` was not fail-closed — ACCEPTED
**Concern:** the v4 lane report said every `toolComponent` reference fails closed; `result.rule.toolComponent` was
ignored (`checks.ts:633`).
**Disposition:** Correct; the claim covered overrides and notifications only. Superseded by the R32 ingestion rules:
every `toolComponent` reference flags the result.
**Validation:** `checks.test.ts` › "sarif references resolve to one finding or are flagged, never dropped".

### `providerCalls` typed as any number — ACKNOWLEDGED, no change
**Concern:** `CompletedReviewerOutput.providerCalls` is `number`, so the type admits 0 (`phase-04-plan.md:1386`).
**Disposition:** TypeScript has no plain integer-range type; RLC-06 checks `providerCalls ≥ 1` at runtime on every
output, as the review notes (`:1973`). R28 asked for the status/reference combinations in the type, which hold.

### R31 note — recorded
`PROCEED` does not prove a remote publication reconciled; R31's identity predicate binds Lane A after the outcome.
Nothing in the slot decides publication, so the block is unchanged; SR-A1 maps outcomes only.

### R32 applied

| Item | Applied as | Where |
|---|---|---|
| R29 exception wording | store unreadable or unwritable after retries; `attempt-state-unknown`; idempotency key; gap report | block docs; plan §18.2, SR-A3, SR-A14; exits H4, J6 |
| Late grant | `lease-granted`, typed non-retryable, R29 recovery, RLC-18 | block; plan §18.2, SR-A14, activity policy; exits E12, H4 |
| Atomicity mandatory | fixture union; stateless only for disabled, not-configured, scripted | block kit; plan §18.2; exit E12 |
| Registration before effect | RLC-19 for Lane A's workflow | block kit; plan §18.2, SR-A11 |
| Scanner-recheck closure deferred | human-only SARIF closure; DF-9 entry criteria | plan §5.3, §13; architecture §11; data model §2.4, §3.1; exit E6 |
| Ingestion never loses a finding | reference resolution; `unresolved-reference` flag; never linked to a prior | plan §12, §14; architecture §11; data model §2.1, §2.8, §3.1; exit F3 |
| SARIF severity | HIGH→MEDIUM, CRITICAL→LOW tests | exit E4 |
| Blocking order | LF and `/` reviewer ids; canonical order | exit E4 |
| `check-publication.sh` fails closed | grep 0/1/other, ERE validation, unreadable input, no files, `--`, no list exemption, `git ls-files -z` | plan §7.5; exit I13; threat T4-29 |
| `includedBytes` | the stored packet's final size | plan §8; block; architecture §8; data model §2.3; exit D7 |
| Plan wording | verification mode, not `excerpt-only` | plan §7.5 |

### Slot block type-check and helper execution (v6)

The block was extracted from plan §18 with
`awk '/^### Review-loop slot contract \(verbatim for S0\)/{f=1} f&&/^```typescript$/{inb=1;next} inb&&/^```$/{exit} inb{print}'`
into a scratch directory outside the repository (892 lines, sha256
`023f16dc7135ec32cdddffead29ad2bfd6ac3daee2918138d8b469a37943a04d`; `cmp` against a second extraction: identical) and
compiled as one module with TypeScript 7.0.2 and the v5 options (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, declaration emit, `types: ["node"]`, `NodeNext`), with `@asep/contracts` and `@asep/ports`
mapped to this branch's built declarations (rebuilt by `pnpm -s typecheck`, exit 0) and `AdmissionResult` re-exported
from `packages/application/dist/risk-admission.js`. `tsc -p tsconfig.json`: exit 0. The control project over the same
block: the fifteen v5 controls plus C16 (a `StatefulConformanceFixture` with `failNextCommit: null`), C17 (a
`StatelessConformanceFixture` with a `persistedAttemptBytes` hook) and C18 (an `attempt-bound-effect` step without an
`attemptId`), each expected to fail, and two positive lines (`new ReviewLoopContractError('lease-granted', …)`; a list
holding one fixture of each kind) expected to compile. `tsc -p tsconfig.control.json`: exit 1 with exactly 18 errors,
one per control line (TS2741 ×2, TS2322 ×12, TS2554, TS2345, TS2353 ×2), none on the positive lines.

The envelope helper was executed from the block text with Node 24.6.0's type stripping
(`node --disable-warning=ExperimentalWarning probe.mjs ./src/review-loop/slot-block.ts`) and again from the `tsc` emit
(`node probe.mjs ./dist/review-loop/slot-block.js`): the same 27 rejections and 8 acceptances as v5, 65 536 bytes
accepted and 65 537 rejected with `invalid-payload`, `'é'` 4 bytes, exit 0 both ways and identical output. The
review's own `stripTypeScriptTypes` probe over the plan text, run from the repository root, printed `negative 27/27
positive 9/9`, `65536 ACCEPT`, `65537 ReviewLoopContractError invalid-payload`, and, extended by one line,
`lease-granted ReviewLoopContractError lease-granted true false` (the code constructs from the block text, the error is
an `Error` and not an `AssuranceFencedError`); exit 0. Not verified: compilation as three separate files inside
`packages/application` (they do not exist until S0), and the kit's runtime behaviour (its functions are declarations
until S0).

### DDL re-validation (v6)

The §3.1–§3.3 blocks and the §3.6 rollback were extracted again and applied on PGlite `0.5.4` after the twelve Phase 2
migrations in a fresh scratch directory outside the repository: all applied. The v5 probe was re-run with one changed
expectation and five additions, all as expected (35 of 35): a harness `RESOLUTION_VERIFIED` by
`harness-rule:scanner-recheck` on a `sarif:` finding is now rejected by `finding_dispositions_harness_verify_ck`, and a
human's (no fence, as `finding_dispositions_fence_ck` requires) accepted; a `sarif` finding with `unresolved_reference`
and no prior is accepted; one linked to a prior, a `model` finding with the flag and a `deterministic` finding with the
flag are rejected by `review_findings_unresolved_ck`; an unflagged `sarif` finding linked to a prior is accepted.

### Freeze gate (v6)

Every numbered finding of the review is dispositioned (9 accepted, 0 rejected) and R32 is applied in the documents,
consistent with R29 and R31. Remaining before the corpus freeze and before Lane A receives the block: the controller's
re-check of the v6 block and of the code fixes at the lane head, and confirmation of v6.

## Review v6 (Codex `gpt-6.1-sol`, snapshot `d0907b9`)

> Raw review: `phase-04-review-codex-v6.md` (verbatim copy with provenance). Verdict: REQUEST_CHANGES, confidence
> 0.98, **`HAND-OFF: READY`**. Controller decision applied alongside: `reconciliation-v1.md` R37 (final decisions for
> this re-check; applied as written), with R36 (Lane B's turn-8 notes), which R37 supersedes for SARIF ingestion. Each
> finding's cited text was re-read at `d0907b9` before deciding; line numbers below refer to `d0907b9`. The
> controller's gate run at that snapshot, on a clean detached worktree: `pnpm verify:all` exit 0, 625 pass, 0 fail,
> 0 skipped, 60 files, 37 required suites.

### Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| HIGH — code (P4-CODE6) | 2 | 2 | 0 | 0 |
| MEDIUM — code (P4-CODE6) | 2 | 2 | 0 | 0 |
| LOW — plan (P4-PLAN6) | 1 | 1 | 0 | 0 |
| LOW — slot block (P4-SLOT6) | 1 | 1 | 0 | 0 |
| **Total numbered** | **6** | **6** | **0** | **0** |
| Unnumbered: surviving mutation (non-object `rule`); history-secret scan conflates "no match" and failure; `--scan-paths --` | 3 | 3 | 0 | 0 |

The re-check confirmed every v5 plan and slot finding FOLDED, the block (892 lines, sha256 `023f16dc…3a04d`) as
type-checking with 0 diagnostics and 18/18 controls, its helper as rejecting 27/27 hostile payloads, and P4-CODE5-HIGH-002,
HIGH-003, MED-001, LOW-001, both v5 mutations, P4-CODE4-HIGH-002 and v3 P4-CODE-HIGH-005 as RESOLVED. P4-CODE5-HIGH-001
stayed PARTIAL; R37 settles it with the new SARIF findings by not parsing SARIF in Phase 4.

The plan and slot-block changes land in the docs-only commit that carries this section; each code finding lands in its
own commit with a failing-first test and a mutation check, reported in the lane report.

### P4-CODE6-HIGH-001 — A `message.id` result turned a SARIF log into a self-closing deterministic diagnostic — ACCEPTED
**Concern:** a valid result with `message: { "id": "M" }` (SARIF §3.11) failed the `message.text` requirement and the
log-level catch replaced every result with one deterministic `sarif-malformed` finding, which a clean later round then
closed by `deterministic-recheck` (`checks.ts:573`, `:632`; `adjudication.ts:275`).
**Disposition:** Correct: `checks.ts:573` reads only `message.text`, `:632` catches for the whole log, and
`adjudication.ts:275` verifies a deterministic prior that no longer fires. SARIF §3.11.2 allows `id` in place of `text`
(research register). R37: SARIF is not parsed in Phase 4.
**Locked change:** plan §5.3 DF-10 (with §3.11 message references and per-result failure isolation among its entry
criteria), §14 item 6 (one `sarif-unparsed` finding per log, source `sarif`, never a deterministic finding), §12, §13;
architecture §11; data model §2.1, §2.8, `review_findings_sarif_ck`; exit F3; threat T4-28; risk PR4-44. Code: remove
the parser and the `sarif-malformed` rule.
**Validation:** exit F3 (`checks.test.ts` › "a SARIF log is one blocking finding a human must close, never parsed": the
review's `message.id` log yields exactly one blocking `sarif-unparsed` finding); exit E6 (`adjudication.test.ts` › "a
SARIF finding blocks until a human closes it": a later round without the log, or a deterministic re-check, changes
nothing).

### P4-CODE6-HIGH-002 — An omitted `level` ignored the rule's configured level — ACCEPTED
**Concern:** a result without `level` became `warning` (MEDIUM) although its rule's `defaultConfiguration.level` was
`error`; the round returned `PROCEED` (`checks.ts:575`, `:619`).
**Disposition:** Correct: `checks.ts:575` falls back to `'warning'` directly; SARIF §3.27.10 derives an absent level
from the rule's configuration (research register). R37: not parsed; the one finding per log is HIGH and blocks whatever
the severity policy says.
**Locked change:** as HIGH-001; plan §12 (`B` holds every SARIF finding of the round at any severity); DF-10 lists
§3.27.10 effective level.
**Validation:** exit F3 (the review's omitted-level log yields the one blocking finding); exit E4 (`adjudication.test.ts`
› "a SARIF finding blocks whatever the severity policy says").

### P4-CODE6-MED-001 — The harness could refute an ungrounded SARIF finding — ACCEPTED
**Concern:** `harness-rule:citation-unresolvable` with `REJECTED_WITH_EVIDENCE` moved a SARIF aggregate with
`grounded: false` to `REFUTED`, so human-only closure was not enforced for every non-blocking transition
(`packages/domain/src/assurance.ts:226`; `phase-04-data-model.md:475`).
**Disposition:** Correct: `assurance.ts:226-228` checks the rule and `grounded` only, not the source. The review notes
no production path calls it today (check findings are grounded, `adjudication.ts:364`); the domain must refuse it
anyway. R37: refuse every non-human transition out of `OPEN` for source `sarif`, whatever `grounded` says.
**Locked change:** plan §13 (the domain refuses verify, refute, waive, accept and claim by any non-human actor on a SARIF
finding; only a harness reopen of an expired waiver remains); data model `finding_dispositions_sarif_ck`; exit E6;
threat T4-28.
**Validation:** exit E6 (`assurance.test.ts` › "only a human disposes of a SARIF finding": one negative test per
transition and actor, the review's `grounded: false` probe included, and the waiver-expiry reopen still accepted); DDL
re-validation below.

### P4-CODE6-MED-002 — `rule: null` was read as an absent rule — ACCEPTED (moot under R37)
**Concern:** `result.rule ?? {}` turned `null` into an empty reference, so the result was not flagged and could inherit a
waived prior's shield (`checks.ts:493`, `:494`; `checks.test.ts:495`).
**Disposition:** Correct: `?? {}` maps `null` to `{}` at `:493`. R37 removes the parser and its reference resolution,
so no reference is read; R36's non-object-rule rule moves to DF-10's entry criteria.
**Locked change:** plan §5.3 DF-10; §14 item 6. Code: the resolver is removed with the parser.
**Validation:** exit F3: a SARIF log's bytes are never decoded, so no reference form can relabel or drop a result.

### P4-PLAN6-LOW-001 — The R36 ingestion rules were not written into the plan — ACCEPTED (superseded by R37)
**Concern:** R36 accepted hierarchical rule IDs and the extra unresolved cases; the plan did not list them and the
architecture still said the IDs must be equal (`phase-04-plan.md:1001`; `phase-04-architecture.md:448`).
**Disposition:** Correct at `d0907b9` (both lines re-read). R37 removes SARIF parsing, so the ingestion text is moot; as
the controller asked, it is replaced by the DF-10 pointer, and R36's rules are recorded as DF-10 entry criteria.
**Locked change:** plan §5.3 DF-10, §12 ("SARIF identity"), §14 item 6; architecture §11.
**Validation:** wording; `grep -n "unresolved-reference\|ruleIndex" docs/implementation/phases/phase-04-plan.md` finds
the terms only in the version history (the v6 status paragraph and the v6 and v7 change tables).

### P4-SLOT6-LOW-001 — `not-configured` was listed among the stateless slots — ACCEPTED
**Concern:** the stateless list named `not-configured`, but Lane A's `NotConfiguredAssuranceSlot` persists outcome
events and must use the stateful fixture (`phase-04-plan.md:1939`, `:2034`, `:2072`).
**Disposition:** Correct (all three lines re-read). R37: wording only, no TypeScript change.
**Locked change:** the block's `StatelessConformanceFixture` doc comment (block lines 805–807 become 805–809); §18.2 default
slots and the conformance preamble; risk PR4-41. Nothing else in the block changes (below).
**Validation:** the block diff below shows only the comment; the comment-free emit of the block is identical before and
after.

### Surviving mutation: non-object `rule` unflagged — ACCEPTED (moot under R37)
`if (!isRecord(rule)) return fail(...)` → `return null` left 71/71 tests green (`checks.ts:494`). The resolver is
removed with the parser; nothing is left to mutate.

### History-secret scan conflates "no match" and failure — ACCEPTED
`check_history_secrets` wraps `git grep … | grep -vE … || true` in one assignment, so a `git grep` that fails reads as
clean (`scripts/check-publication.sh:182`). R37: distinguish 0, 1 and ≥2 and fail closed. Locked change: plan §7.5,
exit I13, threat T4-29. Validation: `collect.test.ts` › "the publication history scan fails closed".

### `--scan-paths --` read `--` as a file name — ACCEPTED
`--scan-paths -- clean.txt` scanned a file named `--` (`scripts/check-publication.sh:213`). R37 leaves the choice;
`--scan-paths` now takes one leading `--` as the end of its options, like `grep`. Locked change: plan §7.5, exit I13.
Validation: `collect.test.ts` › "the path scanner takes -- as the end of its options".

### R37 applied

| Item | Applied as | Where |
|---|---|---|
| SARIF parsing deferred | DF-10 with DF-9's criteria, §3.27.10, §3.11, per-result isolation, R36's rules and the v4–v6 probes | plan §5.3 |
| `sarif-unparsed` | one finding per log: source `sarif`, raiser `sarif:unparsed`, HIGH, `EVIDENCE_INTEGRITY`, grounded to the log, no location, identity per check and log digest | plan §12, §14; architecture §11; data model §2.1, §2.8, `review_findings_sarif_ck`; exit F3 |
| Blocking | every SARIF finding blocks whatever the severity policy says | plan §12; exit E4 |
| Human-only closure | domain refuses verify, refute, waive, accept and claim by a non-human actor on a SARIF finding; DDL `finding_dispositions_sarif_ck` | plan §13; data model §3.1; exit E6 |
| Parser removed | the parser, reference resolution, `sarif-malformed` and the `unresolvedReference` flag go away | code commit; data model DDL |
| Default slot fixture | stateful for `NotConfiguredAssuranceSlot`; wording only | block doc comment; plan §18.2; risk PR4-41 |
| Publication scanner | history scan 0/1/≥2 fail closed; `--` ends `--scan-paths` options | plan §7.5; exit I13; threat T4-29 |

### Slot block (v7)

The block was extracted from plan §18 with the same `awk` as in v6 before and after the edit. Before: 892 lines,
sha256 `023f16dc7135ec32cdddffead29ad2bfd6ac3daee2918138d8b469a37943a04d` (equal to the hand-off sha). After: 894
lines, sha256 `9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a` — **not** equal to `023f16dc…`, and the
only difference is the SLOT6-LOW-001 wording. `diff` of the two extractions:

```text
805,807c805,809
<  * The fixture of an implementation that persists nothing. Only the disabled, not-configured
<  * and scripted slots declare it (R32); the fencing, pre-lease, atomicity, persistence and
<  * "no state change" parts of the cases then report not-applicable.
---
>  * The fixture of an implementation that persists nothing: the disabled and scripted slots
>  * (R32, R37). A slot that persists anything presents a StatefulConformanceFixture, Lane A's
>  * NotConfiguredAssuranceSlot included because it persists outcome events. With this fixture the
>  * fencing, pre-lease, atomicity, persistence and "no state change" parts of the cases report
>  * not-applicable.
```

In the v6 scratch project (TypeScript 7.0.2, the same options and aliases): `tsc -p tsconfig.json` on the new block,
exit 0; `tsc -p tsconfig.control.json`, exit 1 with exactly 18 errors, one per control line; both blocks emitted with
`--removeComments` give identical `.js` and `.d.ts` files (`diff -r`, no output), so no TypeScript changed. The helper,
run from the new block text and from its emit (`probe.mjs`), gives the same 27 rejections and 8 acceptances, 65 536 bytes
accepted and 65 537 rejected, identical output both ways; the review's own `stripTypeScriptTypes` probe over the new
plan text prints `HELPER 27/27 9/9`, `65536 ACCEPT`, `65537 ReviewLoopContractError invalid-payload`, and
`lease-granted ReviewLoopContractError lease-granted`; exit 0.

### DDL re-validation (v7)

The §3.1–§3.3 blocks and the §3.6 rollback were extracted again and applied on PGlite `0.5.4` after the twelve Phase 2
migrations in a fresh scratch directory outside the repository: all applied, and the rollback applied. The v6 probe was
re-run without its `unresolved_reference` probes and with the R37 probes added; 50 of 50 as expected. New: a
`sarif-unparsed` finding and its re-raise linked to a prior are accepted; another raiser, another rule, no rule, MEDIUM,
another category, a file and a line are rejected by `review_findings_sarif_ck` (an ungrounded row trips
`review_findings_grounded_ck` first); on a `sarif:` finding a harness refutation of an ungrounded row and a reviewer
`RESOLUTION_CLAIMED` are rejected by `finding_dispositions_sarif_ck`, a harness verification by
`finding_dispositions_harness_verify_ck`; a harness `REOPENED` and a human verification, refutation and waiver are
accepted; a harness refutation of an ungrounded deterministic finding is still accepted. With the constraint that fires
first dropped, `finding_dispositions_sarif_ck` rejects the harness verification and `review_findings_sarif_ck` the
ungrounded SARIF row on their own.

### Freeze gate (v7)

Every finding of the review is dispositioned (6 numbered and 3 unnumbered accepted, 0 rejected) and R37 is applied in
the documents. Remaining: the controller's diff check of the block against `023f16dc…` (G-LB), the controller's check
of the code fixes at the lane head, and confirmation of v7.

## Review v7 (Codex `gpt-6.1-sol`, snapshot `287ed0f`)

> Raw review: `phase-04-review-codex-v7.md` (verbatim copy with provenance). Verdict: ACCEPT_WITH_CHANGES, confidence
> 0.96. Controller decisions applied alongside: `reconciliation-v1.md` R39 (G-LB released: the slot block at `287ed0f`,
> sha256 `9cc21c98…`, is the S0 copy and does not change) and R40 (final decisions for this re-check; applied as
> written). Each finding's cited code was re-read at `287ed0f` before deciding; line numbers below refer to `287ed0f`.
> The controller's checks at that snapshot, on a clean detached worktree: `pnpm verify:all` exit 0, 625 pass, 0 fail,
> 0 skipped, 60 files, 37 required suites; shellcheck through Docker on `scripts/check-publication.sh`, exit 0, no
> warning.

### Summary

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| MEDIUM — code (P4-CODE7) | 1 | 1 | 0 | 0 |
| LOW — code (P4-CODE7) | 3 | 3 | 0 | 0 |
| **Total numbered** | **4** | **4** | **0** | **0** |
| Unnumbered: two surviving mutations (domain guard limited to `OPEN`; comparator removed from the SARIF input sort); the lane's wrong "equivalent" claim for the unanchored history filter; the hydration boundary of the domain | 4 | 4 | 0 | 0 |

The re-check found every v6 finding RESOLVED or MOOT under R37, no path that closes a SARIF finding by itself, and a
check-report parser that refuses 11/11 tampered reports. It raised no plan finding (no `P4-PLAN7` ID) and did not
re-check the slot block, which R39 released. The review also confirmed the lane's other equivalence claim, the domain
mutant `disposition !== 'REOPENED'`: the same states and error codes over 672 cases, with six different diagnostic
messages, so it is equivalent in behaviour, not in bytes.

The plan text below lands in the docs-only commit that carries this section; each code finding lands in its own commit
with a failing-first test and a mutation check, reported in the lane report. Nothing here changes the slot block.

### P4-CODE7-MED-001 — The check summary counted a SARIF finding by severity only — ACCEPTED
**Concern:** `checkReportSummary` counts a finding as blocking only when its severity is in the plan's blocking
severities, so a valid `[CRITICAL]` policy reports `{total: 1, blocking: 0}` for a SARIF log while adjudication returns
`REPAIR` (`check-report.ts:81`; `adjudication.ts:348`; `checks.test.ts:575`).
**Disposition:** Correct: `check-report.ts:81` filters by `blocking.has(f.severity)` alone, while `adjudication.ts:348`
blocks every SARIF finding whatever the policy says (R37); the only summary assertion (`checks.test.ts:575`) passes a
policy that contains HIGH. R40: count a SARIF finding as blocking whatever the severity policy, like adjudication.
**Locked change:** plan §14 item 6 (the check summary counts every SARIF finding as blocking); architecture §11
("SARIF findings in Phase 4"); exit F3.
**Validation:** exit F3 (`checks.test.ts` › "the check summary counts a SARIF finding as blocking whatever the severity
policy says": a policy without HIGH counts the SARIF finding, and a policy with HIGH counts it once).

### P4-CODE7-LOW-001 — Two logs of one check could be listed in either order — ACCEPTED
**Concern:** the report sorts `sarifInputs` by check id only, so two logs of the same check with different bytes keep
their arrival order and the same findings give two report digests (`check-report.ts:65`, `:67`; the review's probe
`SAME_NAME_REPORT_ORDER`, `2577185c…` and `95fc1622…`).
**Disposition:** Correct: the comparator at `check-report.ts:67` compares `checkId` alone and `Array.prototype.sort` is
stable, so equal check ids keep the input order. R40: sort by a total key, check id then digest.
**Locked change:** data model §2.8 (`sarifInputs` ordered by check id, then sha256); exit F3.
**Validation:** exit F3 (`checks.test.ts` › "the check report lists SARIF logs in one order whatever order they arrive
in": two logs of one check, both orders, identical report bytes); the comparator-removal mutant must fail (lane
report).

### P4-CODE7-LOW-002 — The domain's SARIF matrix ran from `OPEN` only — ACCEPTED
**Concern:** the negative matrix for source `sarif` builds every aggregate in `OPEN`; a guard limited to `OPEN` keeps
69/69 tests green, and the review's sequence (an ungrounded SARIF finding, a human `ACCEPTED` to `ACKNOWLEDGED`, then a
harness `citation-unresolvable` refutation to `REFUTED`) is accepted by that mutant (`assurance.test.ts:273`, `:281`;
`assurance.ts:214`).
**Disposition:** Correct: `assurance.test.ts:281` calls `sarifFinding({ grounded })`, always `OPEN`; the guard at
`assurance.ts:214` does not read the state, so HEAD refuses the sequence, but no test would see it go. R40: cover
`ACKNOWLEDGED` and `FIXED` as well as `OPEN`.
**Locked change:** plan §13 ("SARIF findings": the refusal holds from every state a disposition may leave); exit E6.
**Validation:** exit E6 (`assurance.test.ts` › "only a human disposes of a SARIF finding": every machine disposition from
every state the lifecycle allows it to leave — `OPEN`, `ACKNOWLEDGED`, `FIXED`, and `REFUTED` and `ADJUDICATED` for
`ACCEPTED` — is refused, the review's sequence included; a human records each); the review's `state === 'OPEN'` mutant
must fail (lane report).

### P4-CODE7-LOW-003 — No fixture put the exemption string in a path — ACCEPTED
**Concern:** the history-scan test puts `:scripts/check-publication.sh:` only in the content of `notes.txt`, which
`git grep -c` never prints, so no test can see a path smuggle the exemption; the lane's claim that the unanchored filter
is equivalent under `-c` is wrong (`collect.test.ts:484`; `check-publication.sh:178`).
**Disposition:** Correct: `collect.test.ts:484` writes the string into the file's content only, and the count line
`<commit>:<path>:<count>` still carries the path; see the correction below. R40: add a fixture whose path contains
`:scripts/check-publication.sh:`.
**Locked change:** plan §7.5 (the exemption matches a whole count line naming one of the scanner's own files); exit I13.
**Validation:** exit I13 (`collect.test.ts` › "the publication history scan fails closed": a key committed under
`docs/:scripts/check-publication.sh:note.txt` is reported by that path); the unanchored-filter mutant must fail (lane
report).

### Surviving mutation: domain guard limited to `OPEN` — ACCEPTED
`finding.source === 'sarif' && finding.state === 'OPEN' && …` kept 69/69 tests green (`assurance.ts:214`). Closed by
LOW-002's matrix.

### Surviving mutation: comparator removed from the SARIF input sort — ACCEPTED
`.sort()` without its comparator kept 69/69 tests green (`check-report.ts:67`). Closed by LOW-001's permutation test.

### Correction: the unanchored history filter is not equivalent — ACCEPTED
The lane report for `287ed0f` called the mutant that reverts the history exemption to the unanchored
`':(scripts/secret-scan\.sh|scripts/check-publication\.sh|scripts/lib/secret-patterns\.sh):'` equivalent under
`git grep -c`, because a count line carries no matched text. That was wrong: the count line still carries the path,
and a path may contain the exemption string. The review's counterexample,
`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:docs/:scripts/check-publication.sh:note:1`, is kept by the anchored filter
(`check-publication.sh:178`) and dropped by the unanchored one. The claim is withdrawn; LOW-003's fixture makes the
mutant fail.

### Hydration boundary for S8 and S12 — recorded (R40)
The domain decides on the aggregate it is given: `applyFindingDisposition` and the adjudication read a prior's
`lifecycleState` and `waiverExpiresAt` as hydrated, and an aggregate built directly can already claim `CLOSED` or
`WAIVED` (`assurance.ts:47`; `adjudication.ts:202`, `:246`). The pure core cannot prove how a state was reached, so
persistence and replay must hydrate only states reached through recorded dispositions. This is an acceptance check of
S8 and S12 (plan §13, §21) and exit H3; the pure core accepted here does not certify those paths.

### R40 applied

| Item | Applied as | Where |
|---|---|---|
| MED-001 | the check summary counts every SARIF finding as blocking whatever the severity policy | plan §14; architecture §11; exit F3; code commit |
| LOW-001 | `sarifInputs` ordered by check id, then sha256; permutation test with two logs of one check | data model §2.8; exit F3; code commit |
| LOW-002 | the SARIF refusal proven from `OPEN`, `ACKNOWLEDGED` and `FIXED` (and the `ACCEPTED` source states) | plan §13; exit E6; code commit |
| LOW-003 | a key committed under a path that contains `:scripts/check-publication.sh:`; the equivalence claim corrected | plan §7.5; exit I13; test commit |
| Hydration boundary | persistence and replay hydrate only states reached through recorded dispositions | plan §13, §21 (S8, S12); exit H3 |
| G-LB (R39) | the slot block stays at sha256 `9cc21c98…` (894 lines) | not touched |

### Freeze gate (v7 re-check)

Every finding of the re-check is dispositioned (4 numbered and 4 unnumbered accepted, 0 rejected) and R40 is applied in
the documents. Remaining: the controller's check of the code fixes at the lane head; then the controller confirms the v7
lock and releases the S19 freeze and the S20 pure core (integration parts still wait for G-P2 and Lane A's S0/S1).

---

## Controller confirmation of v7 (R41, 2026-10-30)

Lane B closed R40 at `27927d9`. The controller's check at that head: `verify:all` exit 0, 627 pass, 0 fail, 0 skipped,
60 files, 37 required suites; the only production change since `287ed0f` is `check-report.ts` (diff read); the review's
"guard limited to `OPEN`" mutant, applied by the controller, fails 1 of 7 domain tests; the slot block is still sha256
`9cc21c98…`. The pre-S0 pure core (the pure parts of S3–S7, S19 provenance and excerpts) is accepted and plan v7 is
LOCKED. R41 releases exactly two things: the S19 freeze (plan §7.5, §7.8: packet-dependent eligibility, the
`no-location` rule, `corpusSha256`, the manifest) and the S20 pure core (matcher, category table, post-fix mapping,
Wilson intervals, floors, the corpus builder variant with `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }`,
the golden historical item). Everything staged after S0/S1 or G-P2 stays blocked, SR-X8 (evals project references)
and the preregistration capture included. Bundle mode stays off: the controller has not supplied the bundle path.

---

## Disposition template

```text
### <FINDING-ID> — <title> — <ACCEPTED | PARTIALLY_ACCEPTED | REJECTED_WITH_EVIDENCE>
**Concern:** <reviewer's claim, with file:line>
**Disposition:** <decision and why; for a rejection, the verification source>
**Locked change:** <exact change folded into which canonical document/section>
**Validation:** <executable proof that will show the change holds>
```

## Freeze gate

Every finding is dispositioned; no CRITICAL/HIGH is unresolved; D-1…D-7, U-1 and U-2 are resolved by the controller
or the user; R1–R14 are applied. Remaining before implementation: the controller confirms this lock, Lane A copies
the slot text verbatim into S0, and Phase 2 is accepted (for shared-surface and fencing slices).

v2 record: **LOCKED v2** (confirmed for pre-S0 slices S3–S7 on 2026-10-29; controller-approved amendment recorded above).

v3 record: **LOCKED v3 (pending controller confirmation)**, superseded by v4 before confirmation.

v4 record: **LOCKED v4 (pending controller confirmation)**, superseded by v5 before confirmation.

v5 record: **LOCKED v5 (pending controller confirmation)**, superseded by v6 before confirmation.

v6 record: **LOCKED v6 (pending controller confirmation)**, superseded by v7 before confirmation; its slot block was
found `HAND-OFF: READY`.

v7 re-check record: ACCEPT_WITH_CHANGES 0.96 at `287ed0f`; R39 released G-LB with the block at sha256 `9cc21c98…`;
R40 applied ("Review v7"); the controller checked the R40 fixes at `27927d9` and confirmed the lock (R41).

**PLAN_STATUS: LOCKED v7 (controller-confirmed, R41)**
