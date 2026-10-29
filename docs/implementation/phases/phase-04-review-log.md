# Phase 4 — Plan Review Disposition Log

> Lane B adjudication record for the independent Codex plan review of the Phase 4 plan.
> Planner: Claude (Lane B session). Reviewer: Codex `gpt-5.6-sol` via the kiro-proxy gateway, read-only,
> commissioned by the controller on 2026-10-29.
> Raw review: `phase-04-plan-review-codex-v1.md` (verbatim copy with provenance). Reviewed HEAD: `a2a7b8a`
> (`a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f`). Verdict: REQUEST_CHANGES, confidence 0.99.
> Binding inputs applied alongside: controller reconciliation `reconciliation-v1.md` (R1–R14) and the user
> decisions relayed by the controller on 2026-10-29.
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
| Slot lacks claim owner / fencing identity | `AssuranceFence` in every slot input; RLC-05 |
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

**PLAN_STATUS: LOCKED v2 (pending controller confirmation)**
