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

**PLAN_STATUS: LOCKED v3 (pending controller confirmation)**
