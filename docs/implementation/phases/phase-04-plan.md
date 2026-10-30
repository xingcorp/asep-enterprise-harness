# Phase 4 — Independent Assurance — Plan (LOCKED v7, pending controller confirmation)

> Status: **LOCKED v7 (pending controller confirmation).** v6, its slot block and the code fixes at `d0907b9` received
> an independent re-check (`phase-04-review-codex-v6.md`, Codex `gpt-6.1-sol`, REQUEST_CHANGES 0.98, **`HAND-OFF:
> READY`**: every v5 plan and slot finding folded, the block type-checks with 18/18 controls and its helper rejects 27/27
> hostile payloads, every v5 code finding resolved except SARIF ingestion; new 1 plan LOW, 1 slot LOW, 2 code HIGH and
> 2 code MEDIUM, one surviving mutation). Every finding is dispositioned in `phase-04-review-log.md` ("Review v6") and
> the controller's decision R37 is applied as written. v7 defers SARIF parsing out of Phase 4 (§5.3 DF-10): a SARIF log
> is never parsed and yields exactly one `sarif-unparsed` finding, HIGH, blocking and closable only by an authorized
> human (§12, §13, §14); the domain and the database refuse every non-human disposition of a SARIF finding but a
> harness reopen (§13); the slot block's only change is the wording of the stateless fixture, so Lane A's
> `NotConfiguredAssuranceSlot` runs the kit with a stateful fixture (§18, §18.2); and the publication gate's
> history-secret scan fails closed while `--scan-paths` takes a leading `--` as the end of its options (§7.5). The code
> fixes land as separate commits (§0 "What v7 changes").
>
> v7 re-check: v7 and its code at `287ed0f` received an independent re-check (`phase-04-review-codex-v7.md`, Codex
> `gpt-6.1-sol`, ACCEPT_WITH_CHANGES 0.96: every v6 finding resolved or moot, no self-closing SARIF path; 1 code MEDIUM,
> 3 code LOW and two surviving mutations). The controller released G-LB (R39: the slot block at sha256 `9cc21c98…` is
> the S0 copy and does not change) and decided R40, applied as written within v7: the check summary counts every SARIF
> finding as blocking and SARIF inputs are listed in a total order (§14), the SARIF refusal is proven from every state
> (§13), the history exemption is proven against a path that contains it (§7.5), and persistence and replay hydrate
> only states reached through recorded dispositions (§13; S8 and S12 in §21). Dispositions are in
> `phase-04-review-log.md` ("Review v7").
>
> v6 status, kept for the record: **LOCKED v6 (pending controller confirmation)**, superseded by v7 before it was
> confirmed. v5, its slot block and the code fixes at `fb2e432` received
> an independent re-check (`phase-04-review-codex-v5.md`, Codex `gpt-6.1-sol`, REQUEST_CHANGES 0.99, `HAND-OFF:
> NOT_READY`: the v4 severity, identity, budget and pattern fixes resolved; new 1 plan MEDIUM and 1 plan LOW, 1 slot HIGH
> and 1 slot MEDIUM, 3 code HIGH, 1 code MEDIUM and 1 code LOW, one surviving mutation and one mutant wrongly declared
> equivalent). Every finding is dispositioned in `phase-04-review-log.md` ("Review v5") and the controller's decision
> R32 is applied as written, consistent with R29 and R31. v6 gives a late lease grant its own contract code
> `lease-granted` with the R29 recovery (RLC-16, RLC-18), makes the atomicity proof mandatory for every stateful slot,
> adds the registration-before-effect ordering case (RLC-19), states the single R29 exception to "every terminal is
> recorded" with its gap report (SR-A3, SR-A14, exits H4 and J6), defers scanner-recheck closure out of Phase 4 (§5.3
> DF-9; §13: a SARIF finding closes only by an authorized human), keeps every SARIF result through reference resolution
> or an `unresolved-reference` flag (§14), makes `includedBytes` the stored packet's final size (§8) and makes the
> publication path scanner fail closed (§7.5); the code fixes land as separate commits (§0 "What v6 changes").
>
> v5 status, kept for the record: **LOCKED v5 (pending controller confirmation)**, superseded by v6 before it was
> confirmed. v4, its slot block and the code fixes at `7cc20f4` received
> an independent re-check (`phase-04-review-codex-v4.md`, Codex `gpt-6.1-sol`, REQUEST_CHANGES 0.99, `HAND-OFF:
> NOT_READY`: every v3 plan and slot finding folded; seven code items resolved and four partial; new 1 plan HIGH, 2 plan
> MEDIUM, 2 slot MEDIUM, 3 code HIGH and 2 code MEDIUM, one surviving mutation). Every finding is dispositioned in
> `phase-04-review-log.md` ("Review v4") and the controller's decisions R26 and R28 are applied as written. v5 makes
> money at the seam integer micro-USD, records pre-lease terminals with `fence: null` under eight obligations
> (RLC-16, RLC-17), turns the reviewer-output and outcome types into discriminated unions (§18), requires effective
> scanner execution and coverage for a SARIF recheck (§13), measures the packet budget on the final bytes with the
> size recorded outside the hashed packet (§8), keeps a re-raise from downgrading an open prior and hashes every
> identity as a canonical JSON array (§12), persists `prompt-over-budget` (data model §3.1) and gives the path-leak
> patterns one source (§7.5); the code fixes land as separate commits (§0 "What v5 changes").
>
> v4 status, kept for the record: **LOCKED v4 (pending controller confirmation)**, superseded by v5 before it was
> confirmed. v3 and the pre-S0 code at `9e3a1c3` received an
> independent review (`phase-04-review-codex-v3.md`, Codex `gpt-6.1-sol`, REQUEST_CHANGES 0.99: every v2 lock-check
> finding confirmed folded; 3 plan MEDIUM, 3 slot-block MEDIUM, 6 code HIGH, 3 code MEDIUM, 1 code LOW, one surviving
> mutation). Every finding is dispositioned in `phase-04-review-log.md` ("Review v3") and the controller's decisions
> R22 (corpus) and R23 (contract and code) are applied as written. v4 fixes the slot block (JSON-only outputs, a
> validating envelope helper, fenced writing helpers with coded redelivery conflicts, RLC-14/15; §18), writes the
> changed-line closure predicate (§13), aligns the corpus vocabulary with R22 (§7.5, §7.8) and keeps one corpus
> execution shape (§7.8, §21.1); the code fixes land as separate commits (§0 "What v4 changes").
>
> v3 status, kept for the record: **LOCKED v3 (pending controller confirmation)**, superseded by v4 before it was
> confirmed. v2 (`3201335`) received an independent lock-check
> (`phase-04-plan-review-codex-v2.md`, Codex `gpt-6.1-sol`, REQUEST_CHANGES 0.97: 14 of 15 v1 findings folded, v1
> MED-001 partial, 2 new HIGH and 8 new MEDIUM). Every finding is dispositioned in `phase-04-review-log.md` and
> folded into this plan and its companions; the controller's decisions R18 (and the assurance-failure rule of R19)
> are applied. v3 fixes the slot block (§18: workspace resolver, fixed logical time with a byte-comparing
> redelivery case, `ArtifactRef` envelope with a boundary case, shadow fields only on `PROCEED`, two default slots),
> restages every pre-S0 slice into a pure-core and an integration part with named owners (§21.1–§21.2, §22), locks
> the corpus packet recipe and matcher before any freeze (§7.8), gives late dispositions cohort semantics with
> append-only snapshot versions (§15) and extends the proof manifest to both runners (§19.7).
>
> v2 status, kept for the record: **LOCKED v2.** Confirmed by the controller on 2026-10-29 for the pre-S0 slices
> (S3, S4 domain file, S5, S6, S7); later slices are released step by step.
> **Controller-approved amendment (2026-10-29, after `3201335`):** (a) gateway prompt injection is **verified** —
> the kiro-proxy gateway appends instructions and tools to every request (PR4-30, §11); (b) `gpt-6.1-sol` is the
> **primary candidate reviewer**, distinct from the corpus labeller `gpt-5.6-sol` (§3 U-4, §7.2); (c) reconciliation
> R15 is applied: `run_events` keeps its FK onto `runs`, benchmark/replay/corpus measurement never writes there,
> Lane B has no run-event sink, and `AssuranceStepContext.now()` is one fixed logical time per activity execution
> (§15, §18). No design decision of v2 is reversed.
>
> v1 (`a2a7b8a`) received an independent Codex plan
> review (`phase-04-plan-review-codex-v1.md`, REQUEST_CHANGES 0.99: 1 CRITICAL, 8 HIGH, 5 MEDIUM, 1 LOW). Every
> finding is dispositioned in `phase-04-review-log.md` and folded into this plan, the architecture, the data model,
> the exit criteria and the slice that proves it. The controller's shared-surface reconciliation
> (`reconciliation-v1.md`, R1–R14) is applied; where it and v1 disagreed, it won. User decisions D-2, shadow-only
> gating and the corpus scope are recorded in §3. No implementation code, tests, migrations or configuration are
> part of this step.
> Lane: **B** (parallel to Lane A / Phase 3 durable orchestration). Planner: Claude (Lane B session).
> Companion documents: `phase-04-architecture.md`, `phase-04-data-model.md`, `phase-04-exit-criteria.md`,
> `phase-04-risk-register.md`, `phase-04-research-register.md`, `phase-04-threat-model-delta.md`,
> `phase-04-review-log.md`, `phase-04-plan-review-codex-v1.md`, `phase-04-plan-review-codex-v2.md`,
> `phase-04-review-codex-v3.md`, `phase-04-review-codex-v4.md`, `phase-04-review-codex-v5.md`,
> `phase-04-review-codex-v6.md`.

```text
BASE_SHA:        00a68895d205122767167942326e2e0466571059   (head of phase/02-single-agent-vertical-slice; Phase 2 NOT yet accepted)
REVIEWED_V1:     a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f
REVIEWED_V2:     32013356e0845354f40ac6f63925f928637d6fb3   (lock-check, REQUEST_CHANGES 0.97)
REVIEWED_V3:     9e3a1c32e869193e981a867e8bb9fbd1abaec9c8   (plan, slot block and pre-S0 code, REQUEST_CHANGES 0.99)
REVIEWED_V4:     7cc20f474ef0d53532ff386777eae7d5d07dae24   (plan v4, slot block and code fixes, REQUEST_CHANGES 0.99)
REVIEWED_V5:     fb2e4323a61e128553043b08157f02c70a1684c9   (plan v5, slot block and code fixes, REQUEST_CHANGES 0.99)
REVIEWED_V6:     d0907b9afecd4c8e3527874e8b9ddd435978a8dc   (plan v6, slot block and code fixes, REQUEST_CHANGES 0.98, HAND-OFF READY)
TARGET_BRANCH:   phase/04-independent-assurance
SCOPE SOURCE:    docs/implementation/90-day-plan.md:33-40 (Days 46–60)
EXIT CRITERION:  "reviewer performance measured on historical defects" (90-day-plan.md:40)
PHASE 4 READING: descriptive rediscovery on self-labelled history plus a mandatory different-family comparator;
                 never a production-valid measurement (user decision, §3)
```

---

## 0. Execution model and what changed in v2

The lane contract governs this phase. Implementation starts only when the controller says "implement", one slice
per commit (§21). Ordering follows reconciliation §"Ordering and gating": Phase 2 lands first; Lane A then lands
the shared foundation commit **S0**, whose review-loop slot text is §18 of this plan; Lane B rebases onto S0
before any Lane B slice that touches a shared surface. Lane B slices that touch only Lane B-owned directories may
run before S0. Since v3 every such slice has a **pure-core part** (Lane B paths only, built on frozen local DTOs)
and an **integration part** (contract and port binding, package exports, suite registries, `evals` project
references), and only the pure-core part may land before S0 (§21.1, R18).

Lane B is **orchestration-agnostic**. Every review, repair, re-review and adjudication behaviour is a
framework-free step use case behind ports, proven by a thin sequential driver and a durable-shaped fake that
uses no orchestration SDK. Lane B never imports the Temporal SDK or anything Lane A adds.

| Area | v1 | v2 |
|---|---|---|
| Reviewer authority | shadow/gating; R2 admitted after signed promotion | **shadow only** in Phase 4; gating, promotion, thresholds and R2 admission deferred (§5.3) |
| Order of checks | packet → checks ∥ reviewer → adjudicate (a secret could reach the gateway) | packet → **deterministic checks and egress decision** → reviewer only on `CLEAR`; zero requests otherwise (§8, §10) |
| Review-record concurrency | `PENDING` claim, re-call allowed, no takeover | reviewer call claimed through the **Phase 2 fenced-takeover primitive**; every decision write fence-checked in-transaction (§16) |
| Closure of findings | reviewer `RESOLVED` + touched location | raiser can only **claim** a fix; closure needs a different eligible reviewer, a human, or a deterministic re-check (§13) |
| Review metrics | from `review.completed` at round close | yield and false positives from **human dispositions**, latest per finding (§15) |
| Contracts | MAJOR `review-report/v2`, `finding/v2`, per-major compat gate | **new logical contracts**; v1 untouched; per-major gate withdrawn (R7) |
| Packet | verdicts only | adds a bounded **execution manifest** (commands, exit codes, environment digest, raw-output refs and scanned excerpts) and false-green checks (§9, §14) |
| Measurement | "test split", promotion candidate | **descriptive rediscovery on self-labelled history**; comparator mandatory; post-fix negatives; controller-approved preregistration; pre-registered floors reported, never used for promotion (§7) |
| Events/table | Lane B `0201_run_events` | withdrawn; Lane A's `0107_run_events` through the shared `RunEventSink` (R4) |
| Credential | read from env at call time inside the adapter | injected by a credential source at the composition root; bounded lifetime; rotation (§10, R13) |
| Dashboards | structural JSON test; Grafana load optional | digest-pinned Grafana loads the provisioning inside the required integration gate and is queried by API (R14 D-6) |
| Full loop | could pass with a fake coder | the real-coder loop is a separate MUST blocked by the Phase 2 agent-runtime repair; until then the loop proof is called **assurance-only** (§21 S22) |
| Gate adequacy | structural coverage guard | proof manifest from the test reporter plus seeded **mutation proofs** for the key MUSTs (§21 S23) |
| Slices | S11–S13 bundled | split into S12–S18 with independent acceptance checks and rollback |

What v3 changes (lock-check `phase-04-plan-review-codex-v2.md`, controller decisions R18, R19):

| Area | v2 | v3 |
|---|---|---|
| Pre-S0 staging | whole slices marked pre-S0 | each slice split into pure core and integration; owners for every shared Lane B file; DAG edges policy → packet/checks → adjudication and runtime grounding → scorer (§21.1, §21.2, §22) |
| Workspace for trusted reads | not reachable from the slot input | `AssuranceWorkspaceResolver.resolve(scope, { attemptId, leaseId, fencingEpoch })` in the slot block; Lane A implements it over the lease table; refusals fail closed (§16, §18) |
| Clock | `now()` doc comment only | R15 invariant in the block header; content-addressed artifacts carry no timestamp; conformance case RLC-11 compares persisted record and event bytes after a redelivery (§11, §18.2) |
| Envelope | 64 KiB stated; `ContextPack` and omission lists inline | ContextPack, PR sections and growing lists travel by `ArtifactRef`; `assertWithinReviewLoopEnvelope` with a boundary case at 65 536 bytes (§18) |
| Shadow fields | `shadow` non-null iff mode shadow, for every kind | `shadow` only on `PROCEED`; `BLOCK` never carries one, matching the DDL; case RLC-12 (§12, §18.2) |
| Default slots | Lane A composes the disabled slot until integration | Lane A's `NotConfiguredAssuranceSlot` is the default binding; Lane B's `createDisabledAssuranceSlot` is the literal opt-out; Lane B's terminal vocabulary (§18.2) |
| Assurance-activity failure | unspecified | audited `assurance-unavailable`; shadow → `PROCEED`, gating → `ESCALATE`, never `FAILED`; `recordAttemptOutcome` carries `assuranceUnavailable` (R19, §18.3) |
| Late dispositions | counted in the window of the disposition | counted in the cohort of the disposed round; recompute writes a new append-only snapshot version; disposition latency reported (§15) |
| Corpus protocol | rule names only | P/C/post-fix recipe, synthetic fields, exclusion order, category table, strict/lenient matcher, cardinality, post-fix location mapping and a golden historical item, locked before any freeze (§7.8) |
| Proof manifest | canonical runner only | canonical and integration runners; live reviewer optionality is a policy test, never a runner skip (§19.7, exit G8, L3) |

What v4 changes (review `phase-04-review-codex-v3.md`, controller decisions R22, R23):

| Area | v3 | v4 |
|---|---|---|
| Slot outputs | `recordAttemptOutcome` returned `Promise<void>` | every method returns JSON; `recordAttemptOutcome` resolves `null` (§18) |
| Envelope helper | `JSON.stringify` only, so `undefined`, `Infinity`, `Date`, `Map` passed lossily | recursive plain-JSON check before measuring; RLC-01 negative fixtures (§18, §18.2) |
| Writing helpers | `AttemptOutcomeInput` and `RepairContextInput` had no caller identity | both carry the caller's `AssuranceFence`, checked in the write's transaction; terminal recorded before lease release; identical redelivery a no-op, conflicting redelivery `conflicting-redelivery`; RLC-14, RLC-15; coded `ReviewLoopContractError` (§18, §18.2, §18.3) |
| Paths | a path with LF passed normalization and dodged `**` globs | control, DEL, C1, U+2028/U+2029 and leading `"` are not normalizable: push guard `BLOCK`, egress `STOP_CLASSIFIED`, zero sender calls; globs match every code point (§10.1, §14) |
| Egress paths | old paths only from the cumulative diff | both sides of every entry of both diffs, copies included (§10.1) |
| Finding identity | first finding per fingerprint, before grounding | ground first; identity keeps requirement id and key apart; conservative merge; permutation-invariant (§12) |
| Closure | a citation anywhere in a repair-delta hunk closed a finding | changed-line predicate: a `+` line, or for a deletion-only change the finding's own cited lines among the `-` lines; context never qualifies (§13) |
| SARIF findings | a SARIF prior stopped blocking once the round's checks no longer reported it | blocks until a human closes it or a scanner recheck proves the same scanner, version and rule completed cleanly (§13) |
| Repeated findings | a re-raised finding opened a new blocking entry even under a live waiver | reconciled with persisted identity and disposition before blocking; regressions link to the closed prior (§12) |
| Packet budget | diffs, post-images and excerpts only | the canonical packet's own bytes plus every embedded content part, and separately the rendered prompt bytes (§8, data model §2.3) |
| False green | `tests === 0` only | executed = tests − skipped − todo; executed 0, and a recorded PASS with failures, are findings (§14) |
| Corpus | `tree-unavailable`, `object-store-only`, `derived-from-fix`; scanner failure ignored | R22 vocabulary, bundle-dependent count, `no-location` freeze rule; a scanner that does not complete aborts collection (§7.5, §7.8) |
| Corpus execution | two shapes named | one: `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }` (§7.8, §21.1) |

What v5 changes (re-check `phase-04-review-codex-v4.md`, controller decisions R26, R28):

| Area | v4 | v5 |
|---|---|---|
| Money at the seam | `costUsd`, `reviewCostUsd`, `modelCostUsd`, `computeCostUsd` as floating `number` | `*MicroUsd`: integer micro-USD, `null` unknown; converted once in the adapter with ceiling; the envelope helper rejects anything else; RLC-01 fixtures (§18, §18.2, SR-A13) |
| Pre-lease terminals | an attempt that ended before any lease was not recorded (PR4-37) | recorded with `fence: null` under eight obligations (never-leased durable history, allowlist `cancelled`/`infrastructure-failed`, lease acquisition refuses a terminal attempt under the same lock, atomic write); RLC-16 race, RLC-17; SR-A3 and H4: every terminal is recorded (§18, §18.2, §18.3) |
| Slot types | comments stated record, mode and shadow invariants | discriminated unions for `RunReviewerOutput` and the outcomes; type-level negative controls and RLC-06 runtime fixtures (§18, §18.2) |
| SARIF recheck | same tool, version and declared rule, invocations successful | effective execution and coverage: rule enabled in the effective configuration, no notification about it, file among the scanned artifacts (§13, §14) |
| Packet budget | the packet measured with its budget figures zeroed | the final canonical bytes; `includedBytes` recorded beside the packet, not inside it; independent oracle at cap and cap + 1 (§8, data model §2.3) |
| Re-raised findings | a LOW re-raise could take an `OPEN` HIGH prior out of `B` | effective severity is the highest of the pair; an open prior keeps blocking authority until an authorized closure (§12) |
| Identity encoding | tuples joined with separators | canonical JSON arrays for every identity, fingerprint and dedupe key; `null` ≠ `""` (§12) |
| `prompt-over-budget` | a failure reason the DDL rejected | in `review_records_failure_ck`; S8 adds the persistence regression (data model §3.1) |
| Path-leak patterns | parsed out of `check-publication.sh` (an appended pattern was missed) | one data file read by the script and the collector; executable parity test; the collector never replaces the full gate (§7.5) |

What v6 changes (re-check `phase-04-review-codex-v5.md`, controller decision R32, consistent with R29 and R31):

| Area | v5 | v6 |
|---|---|---|
| Late lease grant | a `fence: null` write refused because a lease now exists raised `AssuranceFencedError`, which the activity policy reads as supersession | `ReviewLoopContractError` code `lease-granted`, a typed non-retryable result; the workflow looks the lease up and records the terminal with its fence, at most two lookups (R29); RLC-16 race and RLC-18 (§18, §18.2, SR-A14) |
| Atomicity proof | not-applicable whenever the fixture could not inject a commit failure | mandatory for every stateful slot: the fixture is a union, and only a slot declaring `stateless: true` (disabled, not-configured, scripted) reports the stateful cases not-applicable (§18, §18.2) |
| Registration before effect | proved only by refusing an unregistered attempt id | RLC-19, a workflow-level ordering case Lane A runs: no attempt-bound effect before the attempt's registration is reconciled (§18, §18.2, SR-A11) |
| Unrecorded terminals | "every terminal is recorded", stated without exception | the single R29 exception — the store cannot be read or written after the retry policy — ends `FAILED` / `attempt-state-unknown` with the attempt's idempotency key in the audit entry, and telemetry completeness reports the gap with that key (SR-A3, SR-A14, exits H4, J6) |
| SARIF closure | a scanner recheck proving effective execution and coverage verified a SARIF finding | deferred out of Phase 4 (DF-9): only an authorized human closes a SARIF finding; model output and scanner output never do, and a log that no longer reports it changes nothing (§13) |
| SARIF ingestion | `ruleIndex`, `rule` and `artifactLocation.index` ignored; an artifact under a foreign `uriBaseId` counted | rule and artifact references resolve to the driver's rules and `run.artifacts`; a reference that cannot be resolved keeps the result as a finding flagged `unresolved-reference`, never dropped and never linked to a prior (§12, §14) |
| `includedBytes` | measured with `overBudget: false` for every packet | the stored packet's final size, measured after the flag is set, for accepted and rejected packets alike; the accepted-packet invariant is unchanged (§8) |
| Publication path scanner | a grep error, an invalid pattern or no input file read as clean; the pattern list exempt from its own scan | each is exit 2; `--` before file names; the list is scanned like any other file; tracked files enumerated with `git ls-files -z` (§7.5) |
| Corpus wording | `provenance: excerpt-only` next to the R22 vocabulary | the verification mode is described; no extra provenance value (§7.5) |

What v7 changes (re-check `phase-04-review-codex-v6.md`, controller decision R37):

| Area | v6 | v7 |
|---|---|---|
| SARIF ingestion | a parser resolved reference forms and flagged the rest; a `message.id` result turned the whole log into a self-closing deterministic diagnostic, and an omitted `level` ignored the rule's configured level | not parsed in Phase 4 (DF-10): each SARIF log yields exactly one `sarif-unparsed` finding, source `sarif`, HIGH, grounded to the log, blocking whatever the severity policy says, closable only by an authorized human; a later round without the log changes nothing; the parser, its reference resolution and the `unresolved-reference` flag are removed (§12, §13, §14) |
| SARIF dispositions | no harness rule verified a SARIF finding, but the harness could refute one marked ungrounded | the domain and the database refuse every non-human disposition of a SARIF finding — verify, refute, waive, accept, claim — whatever `grounded` says; only a harness reopen (an expired waiver) remains (§13, data model §3.1) |
| Stateless fixture | the disabled, not-configured and scripted slots could declare `stateless: true` | only a slot that persists nothing (the disabled and scripted slots); Lane A's `NotConfiguredAssuranceSlot` persists outcome events and presents a stateful fixture; wording only, no TypeScript change (§18, §18.2) |
| Publication gate | the history-secret scan read a `git grep` failure as clean; `--scan-paths --` read `--` as a file name | the history scan reads `git grep` status 0, 1 or anything else and fails closed; `--scan-paths` takes a leading `--` as the end of its options (§7.5) |

R40 additions within v7 (re-check `phase-04-review-codex-v7.md`; no slot-block change):

| Area | At `287ed0f` | After R40 |
|---|---|---|
| Check summary | counted a finding as blocking by severity only, so a policy without HIGH reported a SARIF log as non-blocking | counts every SARIF finding as blocking whatever the severity policy says, like adjudication (§14) |
| SARIF input order | `sarifInputs` sorted by check id only, so two logs of one check kept their arrival order | sorted by check id, then sha256; one report for every order (§14, data model §2.8) |
| SARIF refusal | proven from `OPEN` only | proven from every state a disposition may leave (§13) |
| History exemption | anchored, but no fixture put the exemption string in a path | a key committed under a path containing `:scripts/check-publication.sh:` is still reported (§7.5) |
| Hydration | not stated | the domain trusts the aggregate it is given; S8 and S12 hydrate only states reached through recorded dispositions (§13, §21) |

---

## 1. Current-state audit (file-level evidence at `00a6889`)

Every citation below was read in a Lane B session. Phase 2 is not accepted and may still change, so the plan binds
to symbols and invariants; line numbers describe `00a6889` only.

### 1.1 Review contracts exist but carry no provenance

- `packages/contracts/schema/review-report.schema.json:8-14` — `ReviewReport/v1` requires only
  `reviewerProvider, reviewerModel, verdict, findings, confidence`: no review id, attempt binding, packet hash,
  raw-response reference, round or closure status.
- `packages/contracts/schema/finding.schema.json:8-18` — `Finding/v1` requires `id, severity, category,
  evidence, requiredFix`; no source, grounding result, fingerprint or lifecycle.
- `packages/contracts/src/validate.ts:48-62` — `ContractName` is a closed union of 13 logical names, and
  `:76-92` keys every compiled schema by the logical name taken from the `$id` path. The runtime validator cannot
  hold two majors of one contract, so v1's MAJOR-bump route would have replaced the live v1 validator. Phase 4
  therefore adds new logical contracts (R7, D-1 = b).
- `packages/contracts/schema/architecture-invariant.schema.json:8-13` — prose only.

### 1.2 The Phase 1 reviewer port is unsafe as-is

- `packages/ports/src/index.ts:68-77` — `ReviewProvider.review({ order, context, … })` hands the reviewer the
  coder's `ContextPack` and returns a trusted `ReviewReport`. No runtime caller exists (the Codex review re-checked
  this with `rg`). Phase 4 adds a packet-only, untrusted-observation reviewer port, as Phase 2 did for the coder
  (`packages/ports/src/index.ts:39-62`).

### 1.3 Policy demands review that nothing provides

- `policies/approval-matrix.yaml:32-40` — R1: 1 independent reviewer, `allowAutoMerge: true`,
  `requireHumanMerge: false`. `:41-49` — R2: 1 independent reviewer of a different model family plus human merge.
- `packages/application/src/risk-admission.ts:106-116` — R1 is admitted only with a separately recorded human
  review; `:127-134` — R2–R4 are `DEFERRED` wholesale.
- `packages/application/src/governed-execution.ts:169-178` — admission is hard-wired to `admitRisk`.

### 1.4 The pipeline has no review slot

- `packages/application/src/pipeline-steps.ts:889-1026` — `completeToReview` runs verify → evidence → commit →
  **push** → PR → set-review with no point between persisted evidence and push.
- `packages/domain/src/operational.ts:82-97` — no under-review attempt state. `packages/contracts/src/base.ts:42-45`
  — `AttemptStatus`; persisted with an unnamed column check in `adapters/persistence/src/migrations.ts:106-108`
  (PostgreSQL's default name for it is `attempts_status_check`; S8's migration asserts the name before replacing it).

### 1.5 Measurement is defined but never computed

- `docs/platform/metrics-dictionary.yaml:222-242` (`false_completion_rate`), `:276-294`
  (`review_finding_yield`), `:296-314` (`review_false_positive_rate`), `:355-372` (`workflow_recovery_rate`),
  `:375-393` (`cost_per_accepted_task`). `review_finding_yield` sums `review.completed.reviewFindingsValid`, a
  value that is only known after a human disposition — after the immutable event was written (P4-PLAN-HIGH-004).
- `packages/observability/src/metrics.ts:34` — aggregations are `count | sum | mean`; nothing evaluates a metric.
- No runtime code emits a `RunEvent`; no migration creates an event table (`migrations.ts:425-438`).
- `compose.yaml:93-96` — Grafana `12.0.2` by tag (not digest), data volume only, no provisioning.

### 1.6 Architecture/security checks today

- `scripts/forbidden-imports.test.ts:51-66,80` — fitness rules match import specifiers only. Lane R is replacing
  this with an AST check (Phase 2 HIGH-002, reconciliation R8); Lane B's rules are written against whatever lands.
- No diff-level secret, invisible-Unicode or forbidden-path check runs on an agent's change before push.

### 1.7 Raw evidence available to a reviewer

- `packages/contracts/schema/evidence-bundle.schema.json:16-22` — `environment {imageDigest, lockfileHash,
  nodeVersion}`; `:35-47` — per check `command`, `exitCode`, `durationMs`, `stdoutArtifactId`, `stderrArtifactId`.
- `docs/platform/verification-and-review.md:37-39` — exit code, stdout/stderr, machine output, environment digest
  and command are captured by the trusted runner. v1's packet carried verdicts only, so a reviewer could not see a
  skipped test or a zero-test run (P4-PLAN-HIGH-008).

### 1.8 The coder runtime cannot yet run a real repair loop

- `apps/control-plane-api/src/pilot-main.ts:153-181` — the agent container runs `--network none` (`:156`).
- `adapters/agent-claude/src/claude-provider.ts:131-142` — the agent env allowlist forwards no model credential;
  `:153-162` — the CLI is called with harness-specific flags (`--work-order-ref`, `--context-pack-ref`, …).
- A green repair loop with a scripted coder therefore says nothing about a real coder (P4-PLAN-HIGH-007). The
  Phase 2 agent-runtime repair (Lane R, named HIGH-008 by the reviewer and the reconciliation; its exact scope is
  not verified by Lane B) is a blocker of the full-loop MUST (§21 S22, exit N1).

### 1.9 Concurrency primitives available

- `adapters/persistence/src/side-effect-log.ts:15-17,174-181` — `complete()`/`fail()` are fenced by `owner_token`.
  `adapters/persistence/src/side-effect-log.test.ts:255-273` proves only that a reassigned lease is *rejected*; no
  takeover exists at `00a6889`. `migrations.ts:131-149` — `workspace_leases` has no epoch column. Lane R's Phase 2
  HIGH-006 repair is adding lease-bound fenced takeover; reconciliation R1 makes it the platform primitive.
- `packages/ports/src/index.ts:364` — `SideEffectOperation = 'commit' | 'push' | 'pr-upsert'`; `:382-396` — the
  closed `SideEffectResultRef` union; `:487-503` — semantic key inputs `(attemptId, operation)`.

### 1.10 Patterns to follow

- `adapters/agent-claude/src/claude-provider.ts:80,122-124` — isolation by default, explicit literal waiver.
- `apps/control-plane-api/src/production-root.ts:101-171` — fail-closed config; credentials are constructor
  inputs held in memory; adapters built only in the composition root.
- `scripts/run-canonical-tests.mjs:68-75,95-114` — one `node --test` child with the default reporter; required
  suites proven by `SUITE-ID` markers in output. `scripts/integration/lib.mjs:31-50` — required itest suites.

---

## 2. Baseline gate (observed by Lane B)

```text
at 00a6889 (session 1):  pnpm install --frozen-lockfile → exit 0; pnpm verify:all → exit 0
at a2a7b8a (session 2, clean tree, before any v2 edit):
  pnpm verify:all → exit 0, "verify:all: PASS (all gates green)"
  canonical tests: tests 548, pass 548, fail 0, skipped 0; "50 test file(s), 28 required suite(s) verified"
  contracts compat: "13 schema(s) compatible with snapshot v1"
```

These are lane observations. The Codex reviewer could not reproduce them in its read-only sandbox (`EPERM` on
temp creation, P4-PLAN-LOW-001); an independent controller rerun from a clean writable checkout remains the
authoritative confirmation (exit A1 records exit code, test count, required-suite count and exact HEAD).

Phase 2 is **not accepted**. Phase 4 builds on Phase 2's port contracts and step use cases, not on its
acceptance. After the rebase onto accepted Phase 2 and S0, every dependency named here is re-checked and any
change is re-adjudicated in `phase-04-review-log.md` before the affected slice starts.

---

## 3. Decisions

| ID | Decision | Resolution | By |
|---|---|---|---|
| D-1 | Contract evolution | **(b)** new logical contracts `review-record/v1`, `review-finding/v1` (plus `review-packet/v1`, `adjudication-record/v1`, `repair-order/v1`); `review-report/v1` and `finding/v1` untouched; per-major compat gate withdrawn | controller (R7) |
| D-2 | Does a *promoted* model reviewer count as R1's "1 independent reviewer"? | **Yes — user-accepted policy, against the reviewer's recommendation.** The reviewer argued no, because R1 allows auto-merge (`policies/approval-matrix.yaml:32-40`). The rule is designed and tested as a policy rule (`packages/policy/src/review.ts`) but is **inactive in Phase 4**: promotion is deferred, no reviewer is promoted, every Phase 4 composition passes `promotedReviewerConfigIds: []`, so **R1 keeps human independent review in practice**. | user |
| D-3 | Promotion thresholds | **Deferred** out of Phase 4 with promotion itself (§5.3). Precondition for pickup: pre-registered numeric floors on an independent corpus. | user |
| D-4 | Different-family comparator | **Mandatory** for measurement. Choice: `deepseek-v4-pro` (reason in §7.6); not yet probed. | user |
| D-5 | Deterministic push guard for every admitted risk | **Yes**; it runs before the gateway call as well as before push | controller (R14) |
| D-6 | Grafana in the required gate | **Yes**; digest-pinned Grafana loads the provisioning inside the required integration gate and is queried through its HTTP API | controller (R14) |
| D-7 | Policy values | **Accepted as experimental starting values**, stored as data; the `n < 20` rule labels results descriptive only and is never a promotion threshold | controller (R14) |
| U-1 | Reviewer authority in Phase 4 | **Shadow mode only**: the reviewer records findings and metrics and never blocks a merge. Model-derived `REPAIR`/`ESCALATE` exist only in drill compositions used by tests and the conformance kit; production compositions cannot select gating (§12, exit K3). Deterministic push-guard `BLOCK` (D-5) is not model review and stays active. | user |
| U-2 | Measurement scope | **Descriptive rediscovery on self-labelled history**, plus the mandatory comparator. The verdict vocabulary says descriptive self-history only, never production-valid (§23). Real measurement moves to a pilot-repository corpus later. | user |
| U-3 | Gateway behaviour | **Verified prompt injection** (controller, 2026-10-29): the kiro-proxy gateway appends about 330 tokens of style instructions to the request's `instructions` and about 300 tokens of tools, on every request, for `/v1/responses` and `/v1/chat/completions`. Evidence: the returned `instructions` field holds the caller's instructions followed by the injected text, and `usage.attribution.request_fields` reports `tools` and `instructions` token counts the caller never sent. Consequences in §9, §11, §23. | controller |
| U-4 | Primary candidate reviewer | **`gpt-6.1-sol`** (the controller's current Codex review model). Reason: it differs from the corpus labeller `gpt-5.6-sol`; same vendor, so circularity is reduced, not removed. The different-family comparator stays mandatory. Neither is probed by the lane yet. | controller |

---

## 4. Gap analysis

| Capability | At `00a6889` | Phase 4 delivers | Slice |
|---|---|---|---|
| Slot contract | none | `review-loop/v1` slot, disabled slot, conformance kit (text in §18; landed by Lane A in S0) | S0 (Lane A) |
| Review contracts | `ReviewReport/v1`, `Finding/v1` without provenance | 5 new logical contracts; `architecture-invariant` 1.1.0 | S1 |
| Reviewer port | Phase 1 `ReviewProvider` | packet-only `ReviewerProvider`, `ReviewSourceReader` | S2 |
| Policy | flags only | families, reviewers (primary + comparator), egress classification, shadow-only loader, D-2 rule (inactive) | S3 |
| Finding lifecycle | reference doc | executable lifecycle with closure authority; attempt review states | S4 |
| Packet + prompt | none | whitelist packet incl. execution manifest; spotlighted prompt | S5 |
| Checks + egress | none | push guard, egress decision, false-green, Trojan Source, SARIF | S6 |
| Adjudication | none | grounding, rule table, closure authority, repair order | S7 |
| Persistence | none | review tables, fenced decision writes, snapshot store | S8 |
| Trusted source | per-attempt diff | range diff + post-images | S9 |
| Reviewer adapter | none | Responses adapter, credential source, egress re-check | S10 |
| Replay | none | recorded + scripted reviewers | S11 |
| Step use cases | none | idempotent steps with fakes | S12 |
| Slot implementation | none | `createAssuranceSlot`, events, admission, repair context | S13 |
| Drivers | none | sequential driver, durable-shaped fake | S14 |
| Composition | none | `assurance-root.ts`, CLI | S15 |
| Assurance-only loop proof | none | real PG + Git + sandbox + adapter vs local fake gateway | S16 |
| Metrics | dictionary only | evaluator incl. disposition-based metrics | S17 |
| Dashboards | unprovisioned Grafana | provisioning + Grafana in the integration gate | S18 |
| Corpus | none | content-addressed self-history corpus | S19 |
| Scoring | none | protocol, preregistration, scorer, floors, suites | S20 |
| Live measurement | none | primary + comparator recordings, scorecards, report | S21 |
| Real-coder loop | none | one real coder attempt through a shadow round | S22 (blocked) |
| Gate adequacy | marker-based | proof manifest + mutation proofs | S23 |
| Operations | none | runbook + rehearsal | S24 |

---

## 5. Scope

### 5.1 In scope

A second model/provider reviewer of a different family than the coder, behind a packet-only port; a mandatory
different-family comparator reviewer for measurement; new logical review contracts; packet assembly with strict
independence and a bounded execution manifest; a pre-gateway egress decision with a zero-request guarantee;
prompt-injection-resistant prompt construction; deterministic push guard, false-green, Trojan Source and
architecture checks plus one human-only finding per SARIF log (parsing deferred, DF-10); deterministic adjudication
with closure authority; repair orders and re-review **implemented and proven in drill compositions** (not active in production in Phase 4); the
`review-loop/v1` slot contract and its conformance kit; persisted review records, findings and dispositions;
attempt-terminal and review events through the shared `RunEventSink`; metric evaluation and Grafana dashboards
for false completion, review yield, cost and recovery; a content-addressed self-history corpus; a pre-registered,
controller-approved protocol; descriptive measurement of the primary reviewer and the comparator; a real-coder
shadow round once the Phase 2 runtime allows it; proof manifest and mutation proofs; runbook and rehearsal.

### 5.2 Out of scope

Workflow composition and the durable engine (Lane A); auto-merge; R3/R4 admission; tool-using reviewers;
inbound forge webhooks; production deployment of Grafana; a managed secret broker; any production-valid claim
about reviewer quality; the Phase 1 historical-task dataset (PP2, `phase-01-exit-criteria.md:81`).

### 5.3 Deferred items (with preconditions for pickup)

| ID | Deferred item | Preconditions before it may be planned |
|---|---|---|
| DF-1 | Gating mode in production (model-derived `REPAIR`/`ESCALATE` change the workflow) | DF-6 corpus measured; pre-registered numeric floors (recall, injection degradation, malformed rate, stability, stale-flag rate) met on it; named human approval (ADR 0014); DF-2 in place |
| DF-2 | Signed reviewer promotion records (ed25519, expiry, config-hash binding, revocation) | DF-1's measurement; a key-custody decision; a demotion runbook |
| DF-3 | Promotion thresholds (D-3) | numeric floors pre-registered and controller-approved **before** the independent-corpus capture; humans decide only among configurations meeting every floor |
| DF-4 | R2 admission through a promoted reviewer | DF-1…DF-3; human merge for R2 stays (`approval-matrix.yaml:41-49`) |
| DF-5 | Activation of the D-2 rule (promoted reviewer satisfies R1) | DF-2 |
| DF-6 | Production-valid measurement on an independent, human-labelled pilot-repository corpus | the pilot repository (Phase 1 PP1/PP2, Phase 2 K2/K6) |
| DF-7 | Deterministic red→green closure proof for model findings | a sandboxed rerun of named regression checks on the pre-repair tree |
| DF-8 | Independent blind human relabel of the self-history corpus | a named human labeller; optional — not a Phase 4 MUST by user decision U-2 |
| DF-9 | Scanner-recheck closure of SARIF findings (R32: three review rounds found new ways a log could falsely prove a fix, and no real scanner is wired in Phase 4) | real CodeQL and semgrep SARIF log fixtures; SARIF 2.1.0 `reportingDescriptorReference` resolution including `tool.extensions`; artifact index and `uriBaseId` binding to the repaired tree; effective configuration and notifications; the probes of `phase-04-review-codex-v4.md` and `phase-04-review-codex-v5.md` as tests |
| DF-10 | Parsing SARIF logs into per-result findings (R37: a fourth round found new ingestion faults — a valid `message.id` turned a log into a self-closing deterministic diagnostic, an omitted `level` ignored the rule's configured level — and no SARIF producer runs in Phase 4: SARIF comes from L4/L5 and the pilot runs R0/R1, L0–L2) | DF-9's entry criteria; SARIF 2.1.0 §3.27.10 effective level (`result.level`, then the rule's configuration, then the default); §3.11 message references (`message.id` resolved through `messageStrings`); per-result failure isolation, so one unreadable result never replaces or drops the others; the rule-ID and reference rules accepted by R36 (hierarchical IDs, non-text IDs, non-object `rule`, driver rules without an ID, nested and location-less artifacts); every SARIF probe of `phase-04-review-codex-v4.md`, `-v5.md` and `-v6.md` as tests; until then each SARIF log is one `sarif-unparsed` finding (§14 item 6) |

---

## 6. Architecture summary

Full detail in `phase-04-architecture.md`. After an attempt's evidence is persisted (resultSha = harness commit)
and before push, the slot runs one **assurance round**: plan (pure) → build an immutable **ReviewPacket** from
trusted sources only (evidence incl. execution manifest, WorkOrder, trusted Git diffs and post-images) →
**deterministic checks**, which produce the **push guard** decision and the **egress decision** over the exact
packet bytes → only on `CLEAR`, each planned **reviewer** is called through a packet-only port, claimed through
the Phase 2 fenced primitive, with the exact request bytes re-scanned immediately before the call → findings are
validated and **grounded** → **adjudication** is deterministic. In Phase 4 production, mode is `shadow` (or
`not-required`): the outcome is `PROCEED` with a recorded `shadow.wouldBe`, or `BLOCK` from the deterministic push
guard. The harness ceiling stays `WAITING_FOR_HUMAN_REVIEW`; nothing in Phase 4 merges.

---

## 7. The historical-defect question

The exit criterion asks for reviewer performance "measured on historical defects". Phase 1 deferred a real
historical-task dataset to the production pilot (`README.md:59`; `evals/README.md:62`;
`phase-01-risk-register.md:9` RR-03 forbids fabricating it). This section assesses the one corpus that exists —
this repository's own review history — and states what it supports.

### 7.1 What exists (counted by Lane B; the reviewer re-verified the counts with `rg … | sort -u | wc -l`)

| Source | Distinct IDs | Nature |
|---|---|---|
| `phase-01-plan-review-codex-v1.md` | 49 | plan/document defects (no code existed) |
| `phase-02-plan-review-codex-v1.md` | 20 | plan/document defects |
| Phase 1 final + re-reviews (`phase-01-review-log.md`) | 15 top-level | code/test/gate defects with `file:line` evidence |
| Phase 2 final + re-reviews (`phase-02-final-review-codex-v1.md`, `-rereview-codex-v2..v5.md`) | 15 `P2-FINAL-*` + 2 `P2-REREVIEW-MED-NEW-*` | code/test/gate/claim defects |
| Implementer self-found | 1 (`P2-CYCLE6-HIGH-001`, cold-build `tsc -b` failure) | a defect the reviewer missed |

Re-review cycles mark findings `PARTIAL`/`REGRESSED` (commit `e1c3c68`: "6 HIGH partial + 1 regression + 2 new
MED"; `7b7a2f5`: "5 HIGH still partial") and fold new defects into existing IDs. Fix commits carry the finding ID
in their subject, linking each defect to a pre-fix and post-fix tree.

### 7.2 What it can support: descriptive rediscovery only

It is a real, small, labelled set of defects in real code. It supports a **descriptive rediscovery** measurement:
"how many of the defects that the history labels did reviewer X rediscover from a packet built at the reviewed
tree, and how often did it re-flag them after the fix". It does not support validation, comparison claims beyond
the corpus, or promotion. Validity problems and their handling:

1. **One codebase.** Every scorecard carries `scope: "self-history"` and the constant
   `eligibleForPromotion: false`; the scorer refuses any other value for this scope (exit I3).
2. **The labeller is a sibling of the primary reviewer.** Almost every label came from Codex on `gpt-5.6-sol`.
   The primary candidate reviewer is `gpt-6.1-sol` (U-4): a different model from the same vendor, so primary recall
   is still partly circular (shared lineage and training practices), only less than if the labeller itself were
   measured; any reviewer is penalised for real defects `gpt-5.6-sol` would not find. *Handling:* the mandatory
   different-family comparator (§7.6) runs on every item under the same protocol; recall is also reported on the
   **labeller-miss subset**; non-model baselines are reported; the circularity statement (naming labeller and
   reviewer models) is a required scorecard field.
3. **Labels were visible to the prompt author.** The planner of this phase read every label while writing the
   plan; a "test split" would not be blind (P4-PLAN-HIGH-003). *Handling:* the v1 dev/test split is replaced by a
   `prompt-development` set (Phase 1 items, used to iterate the rubric) and a `reporting` set (Phase 2 items). The
   scorecard states that reporting-set labels were visible to the prompt author, so it is **not a blind
   holdout**. Freezing hashes before capture prevents later tuning; it does not create blindness, and the plan
   does not claim it does.
4. **Different reviewer harness.** The labeller ran a tool-using CLI with the whole repository. The runtime
   reviewer is packet-only. Items whose cited file the packet rule cannot include are excluded `not-in-packet`
   and counted.
5. **Self-selection.** Phase 2 plan dispositions accepted 20 of 20 findings (`phase-02-review-log.md:12-18`) and
   every Phase 2 final-review finding was fixed (`phase-02-report.md:321`). *Handling:* precision is reported
   only over findings a **named human** adjudicated; unadjudicated findings are counted, never assumed false.
   (The controller is an AI session; its adjudications are recorded as `labelSource: controller-ai`, not as
   human labels.)
6. **Second-hand labels.** The first Phase 1 final review was deleted as stale (`phase-02-plan.md:38`);
   `P1-FINAL-*` survive only as controller paraphrase (`phase-01-review-log.md:149-239`). Those items carry
   `labelQuality: "secondhand"` and are reported separately.
7. **IDs are not defects.** The unit is a defect instance `(findingId, reviewedSha, location set)`; primary
   metrics use first-occurrence instances; residual instances are reported separately.
8. **Defect classes differ.** `defectClass ∈ {code, test-adequacy, gate-config, claim-integrity, build}`, per
   class reporting.
9. **Unreachable trees.** `bb11d00` and `89a745b` exist in the local object store but are unreachable; `7e5a911`
   does not exist (re-verified by the reviewer with `git cat-file -e`). Handling per R12 in §7.5.
10. **Tiny n.** About 33 top-level code-level IDs; a Wilson 95% interval at 20/33 spans roughly 0.44–0.75. Every
    proportion carries n and a Wilson interval; cells with n < 20 are labelled descriptive-only (D-7); no
    difference is claimed on overlapping intervals.
11. **Served prompts differ from sent prompts.** The gateway appends instructions and tools to every request (U-3).
    Every reviewer is measured on "harness prompt + gateway additions", not on the harness prompt alone; the
    injected terse style may also shorten `evidence`/`requiredFix` text and so interact with grounding minimums.
    *Handling:* per-call alteration evidence is recorded (§11); the scorecard and the verdict name the gateway; no
    claim is made about any model outside this gateway; grounding failures are reported by reason so a style effect
    is visible.

### 7.3 Guards against a dishonest measurement

| Dishonest move | Guard |
|---|---|
| Answer-key leakage (review documents, logs, fix-commit messages, or a tree containing the cycle's review doc — e.g. `3ea0293` adds the Phase 2 final review on top of reviewed tree `2e61f24`) | packets built from the reviewed SHA only; review artifacts and git metadata excluded by rule; leakage test (exit I2) |
| Tuning on reported items | protocol, matcher, floors, corpus manifest hash and both reviewer configuration hashes frozen in a **controller-approved preregistration** before any capture; capture refuses mismatches (exit I4) |
| Lenient or model-judged matching | deterministic matcher, strict and lenient variants, no model in scoring; protocol, category table and cardinality locked in §7.8 (exit I5, I12) |
| Counting unmatched findings as right or wrong | `unlabelled` bucket; precision only over human-adjudicated findings |
| One lucky sample | k = 3 runs per reporting item for both reviewers; stability reported (exit I6) |
| Dropping hard items | rule-based exclusions enumerated in the manifest and the scorecard denominator table |
| Scoring scripted output | the scorer refuses recordings whose descriptor is scripted/fake (exit I7) |
| Re-flagging after the fix counted as success | **post-fix negative pairs**: the same packet rule at the post-fix SHA; a match there is a stale flag (exit I8) |
| Presenting it as validation or using it for promotion | `scope` + `eligibleForPromotion: false`; verdict vocabulary §23; report claims checked against the scorecard (exit I9) |

### 7.4 Pre-registered floors (proposals; frozen at preregistration; reported, not gating)

Floors make the measurement falsifiable; failing one does not fail the phase, because the phase exit is
"measured", not "good". Each scorecard reports `floorsMet` per floor and the report must state every result.

| Floor | Proposed value | Notes |
|---|---|---|
| Invalid-output rate (malformed + refused + incomplete + invalid), per reviewer | ≤ 5% of calls | operational property, label-independent |
| k-run stability (mean pairwise Jaccard of matched gold sets over k = 3) | ≥ 0.6 | |
| Injection degradation (recall without injection − recall with injection), synthetic suite | ≤ 0.15 absolute | valid only if positive-control recall ≥ 0.5; else the suite result is `INVALID_CONTROL` |
| Rediscovery recall (strict, first-occurrence) | strictly above the best non-model baseline on the same items | relative floor; the absolute value is descriptive |
| Stale-flag rate on post-fix negatives | ≤ 0.25 | |

### 7.5 Corpus reproducibility (R12)

- No tag or ref is created for any pre-rewrite Phase 2 commit (`check-publication` scans `git rev-list --all`, and
  those commits carry the old credential-shaped PEM fixture).
- The corpus stores the file snapshots each packet needs as **content-addressed excerpts** inside the corpus
  (`evals/review-corpus/self-history/blobs/<sha256>`; the manifest maps `(item, side, path)` → sha256). Excerpts
  pass the repository secret, PII, path-leak and large-file gates like any tracked file; a file that cannot pass
  (for example the credential-shaped fixture) is excluded with reason `excerpt-unpublishable` and counted.
- Excerpts for reachable SHAs are verified against `git show <sha>:<path>`. Excerpts for unreachable SHAs are
  built from the local object store where the object still exists, or from the controller's private bundle.
- **Full re-derivation from git needs the private bundle** `~/.openclaw/archive/asep-pre-rewrite-history.bundle`
  (held by the controller outside the repository). Without it, a clean clone can verify only the internal
  consistency of the excerpts (bytes hash to their names; manifest hash): for an item whose reachability is
  `private-bundle-only`, that internal check is the only verification a clean clone can run, and checking its
  excerpts against git needs the bundle. This is a verification mode, not a provenance value. The verifier takes the
  bundle path from an explicit argument supplied by the controller; Lane B never reads it on its own.
- **Provenance vocabulary (R22).** A reviewed tree that cannot be identified — Phase 1 cycle 1, whose review
  document was never committed, and Phase 2 re-review v4, whose document `5c5471b` added together with v5's — is
  never guessed: its items are excluded `reviewed-tree-unknown`. A tree or fix commit that exists only before the
  history rewrite (Phase 2 v5 at `bb11d00` and the pre-rewrite fix commits) is kept with reachability
  `private-bundle-only`; its excerpts are content-addressed in the corpus, each item records whether it depends on
  the bundle (`dependsOnPrivateBundle`), and the scorecard reports that count. A clean public clone verifies every
  other item. The self-found item's reviewed SHA is the parent of its named fix commit (`inferred-parent-of-fix`).
- **Collection is not freezing (R18).** S19's pure core collects label provenance (review document and line,
  derived reviewed SHAs, fix commits, reachability) and content-addressed excerpts with their hashes. It records only
  provenance-level exclusions (`plan-defect`, `reviewed-tree-unknown`, `excerpt-unpublishable`). Packet-dependent
  eligibility (`leakage-filtered`, `not-in-packet`, `egress-stopped`), the freeze rule `no-location`, the manifest's
  `corpusSha256` and the preregistration are frozen only after the controller confirms the protocol of §7.8.
- **Publication gates fail closed (R23).** Collection runs each gate and accepts only its documented codes: the
  four repository scripts exit 0 when clean and 1 with findings; the path-leak scan (`grep -lE` over the excerpts
  with the path-leak patterns) exits 1 when clean and 0 with findings. A spawn error, a missing executable, a signal,
  any other exit code, or a findings code whose output names no excerpt aborts the whole collection with no output
  written. Only a findings code with an excerpt named in its output withholds that excerpt.
- **One source for the path-leak patterns (R28).** The patterns live in `scripts/lib/publication-leak-patterns.txt`,
  one ERE per line (blank lines and lines starting with `#` are ignored; an empty list fails closed in both readers).
  `scripts/check-publication.sh` and the collector both read that file, so neither can run a list the other does not
  see. A parity test runs the real script's path scanner and the collector's scan over the same fixtures and
  requires the same hits, including after a pattern is appended to a copy of the file. The collector checks excerpts
  only: it **never replaces the full publication gate** (LICENSE, the git-history secret scan, the dependency-license
  inventory, the scanners' self-tests), which still runs over the whole repository before any public push.
- **The path scanner fails closed (R32).** In `scripts/check-publication.sh` grep's status is read as 0 (a hit),
  1 (clean) or anything else (the scan failed); a failed scan, a pattern that is not a valid ERE (each pattern is run
  once on empty input when the list is read), an input file that cannot be read, or no input file at all makes the
  scan exit 2, never clean. File names follow `--`. The pattern list is scanned like any other tracked file (it does
  not match itself; a private path in one of its comments fails the gate), and the full gate enumerates tracked files
  with `git ls-files -z`, so a name Git would quote is still scanned.
- **The history-secret scan fails closed too (R37).** It lists every commit with `git rev-list --all` and reads
  `git grep`'s status as 0 (a hit, then filtered for the scanner's own files), 1 (clean) or anything else (the scan
  failed); a listing or a filter that fails, or a `git grep` that fails, fails the gate. `--scan-paths` takes one
  leading `--` as the end of its options, so `--scan-paths -- --` scans a file named `--`; `--scan-history` runs the
  history scan alone with the `--scan-paths` exit codes. The scan runs `git grep -c`, so it reports
  `<commit>:<path>:<count>` and never the matched text, and the exemption matches only a whole such line that names one
  of the scanner's own files: a path that merely contains `:scripts/check-publication.sh:` is still a hit (R40).

### 7.6 Comparator choice (D-4)

The primary candidate is `gpt-6.1-sol` (U-4, family `openai-gpt`). The gateway also serves `deepseek-v4-pro`,
`qwen3.8-max` and `grok-4.6`. **Comparator choice: `deepseek-v4-pro`.**

- Required property, met by all three: its family differs from both the implementer (`anthropic-claude`) and the
  labeller and primary (`openai-gpt`), so it can expose labeller bias rather than reproduce it.
- Deciding property: DeepSeek has historically published open weights for its flagship line, which leaves a path
  to re-run the comparator outside this gateway if the gateway's snapshot changes. That history is general
  knowledge; whether `deepseek-v4-pro` specifically has published weights is **not verified**.
- **Not yet probed.** Whether the gateway serves it over the Responses API with strict structured outputs,
  `store: false`, reasoning effort and usage reporting is unknown. S10's probe records the answer. If it fails,
  the fallback order is `qwen3.8-max`, then `grok-4.6`; the switch is recorded in the review log with the probe
  output, never made silently. If none works over the Responses API, exit I1 is unmet and the controller decides
  between a chat-completions mode for the adapter and a capped verdict.

### 7.7 What else is needed (deferred)

DF-6 (independent pilot corpus) is the only route to a production-valid measurement. DF-8 (blind human relabel)
would quantify label error. Neither is a Phase 4 MUST.

### 7.8 Corpus protocol: packet recipe and matcher (locked before any freeze; P4-PLAN2-HIGH-002, R18)

Corpus packets go through the runtime path: the same `buildReviewPacket`, `renderReviewPrompt`, egress decision,
output validation and grounding. Only the sources are historical. This section, the category table and the
constants below are hashed into the preregistration's `protocolSha256`; nothing here changes after it is approved.

**Units.** A *review cycle* `c` is one labelled review: Phase 1 final review and re-reviews, Phase 2 final review
v1 and re-reviews v2–v5, and the self-found cycle-6 item. Each cycle has a reviewed SHA `R_c` and a base `B_c`.
`R_c` is the parent of the commit that added the cycle's review document, unless the document names its reviewed
HEAD (`reviewedShaSource: recorded-in-review | derived`); the self-found cycle's `R_c` is the parent of its named
fix commit (`inferred-parent-of-fix`), and a cycle whose tree cannot be identified has `unknown` (§7.5). `B_c` is the
`BASE_SHA` line of the phase plan read at `R_c`. A defect instance is `(findingId, R_c, location set)`. Packets are
built per cycle, never per item, so no packet depends on a label.

**Rule P — first occurrence, fresh review.** For every cycle with first-occurrence items, and for the next cycle's
reviewed tree as a post-fix negative:

1. Diff: `git diff --no-color --no-ext-diff --no-textconv --find-renames --unified=3 B_c R_c`, stored as an excerpt
   (S9's runtime reader uses the same flags).
2. Leakage filter, applied before building: files matching `docs/implementation/phases/*review*`,
   `docs/implementation/phases/*-report.md`, `artifacts/**` or `**/*.log` are removed from the diff and post-images
   (each recorded `leakage-filtered`). Every finding-ID token in every remaining text part (regexes
   `\bP[0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b` and `\b(?:CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-[0-9]{3}\b`) is
   replaced by `X` repeated to the token's length, so line numbers and byte offsets do not move; the count per part
   is recorded. Commit messages never enter a packet (no field exists).
3. Post-images: every changed, non-deleted file at `R_c`, each limited to `maxPostImageBytesPerFile = 65536`;
   binary, non-UTF-8, submodule and over-limit files become omissions with the runtime reasons.
4. Chunking: if the whole-cycle packet exceeds the reviewer's `packetBudgetBytes`, the changed files, sorted by
   path in byte order, are packed greedily into consecutive chunks, each packet within budget. A chunk's diff is the
   per-file sections of the cycle diff, byte for byte. A file whose own packet exceeds the budget is an omission
   `too-large`. Chunk ids are `<cycle>/<side>/<k>`.
5. Synthetic fields (recorded in every corpus item and in the protocol, never presented as history):

   | Field | Value |
   |---|---|
   | `identity` ids | 26-character Crockford base32 of the first 16 bytes of `sha256(label)`, labels `corpus:org`, `corpus:project`, `corpus:binding`, `corpus:run`, `corpus:task:<cycle>`, `corpus:attempt:<chunk id>` |
   | `risk`, `round`, `reviewKind` | `R1`, `1`, `fresh` |
   | `workOrder.objective` | `Phase <N> (<title from docs/implementation/90-day-plan.md>) at the reviewed commit. The phase plan, exit criteria and code are part of the change; review the change against them.` |
   | `workOrder` lists | `requirementIds`, `requirements`, `forbiddenChanges`, `architectureInvariants`, `acceptanceCheckIds` empty; `allowedPaths: ['**']` |
   | `execution` | `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }` — the only corpus execution shape (R23); runtime packets never use `NOT_RECORDED`, and the prompt states that no execution evidence exists for the tree. The golden fixture round-trips it through the packet validator and the prompt renderer |
   | `priorFindings` | empty |
6. Egress: the decision of §10.1 with the committed policy and the corpus project opted in. A chunk that is not
   `CLEAR` is never sent; its items are excluded `egress-stopped`.

**Rule C — residual, re-review.** For an item labelled at cycle `c` and marked `PARTIAL` or `REGRESSED` at cycle
`c+1`: the rule-P recipe at `R_{c+1}` with `round = 2`, `reviewKind = re-review`, `repairBaseSha = R_c`, a repair
delta `R_c..R_{c+1}` (same flags; per chunk, the delta sections of the chunk's files) and `priorFindings` = every
item labelled at `c` whose file is in the chunk (not only the residual ones, so the packet does not single any
out). Each prior finding is a `review-finding/v1` with `id` from `corpus:finding:<findingId>`, `source: model`,
`raisedBy: labeller:<labelSource>`, the gold severity and `goldCategory`, the first location at `R_c`, `evidence` and
`requiredFix` taken verbatim from the label (ID tokens masked), `grounded: true`, `lifecycleState: OPEN`. Gold is the
status at `c+1`; a reviewer's `priorFindingClaims` entry matches when `RESOLVED ↔ RESOLVED` or
`PARTIAL | REGRESSED ↔ PARTIAL | OPEN`.

**Post-fix negatives.** An item whose status at `c+1` is `RESOLVED` is negative-eligible. Its negative is the
rule-P packet set at `R_{c+1}` (base `B_c`, fresh). A reviewer finding there that matches the *mapped* gold
location is a stale flag. Items fixed only by implementer commits and never re-reviewed have no negative.

**Post-fix location mapping.** A gold location `(path, s, e)` at `R_c` maps to `R_{c+1}` through
`git diff --find-renames R_c R_{c+1} -- <path>` (stored as an excerpt): a rename follows the new path; a deleted
file has no mapped location; a line outside every hunk shifts by the sum of `newLines − oldLines` over the hunks that
end before it; a line inside a hunk's old range maps to that hunk's whole new range; the mapped range spans the
mapped `s` and `e`. An item without any mapped location is not negative-eligible.

**Matcher (deterministic, no model).** Per `(cycle, side, run)`, the validated and grounded model findings of all
chunks are pooled (identity `(chunk, fingerprint)`); ungrounded findings never match. Gold items carry one
`goldCategory`, assigned by Lane B at collection with a one-line written rationale (reviewable, never model-assigned).
Category table `corpus-categories/v1`:

| `goldCategory` | Compatible finding categories (strict) |
|---|---|
| CORRECTNESS | CORRECTNESS, SECURITY |
| SECURITY | SECURITY, CORRECTNESS |
| ARCHITECTURE | ARCHITECTURE, MAINTAINABILITY, SPEC |
| SPEC | SPEC, CORRECTNESS, ARCHITECTURE |
| TEST_QUALITY | TEST_QUALITY, EVIDENCE_INTEGRITY |
| EVIDENCE_INTEGRITY | EVIDENCE_INTEGRITY, TEST_QUALITY, SPEC |
| PERFORMANCE | PERFORMANCE, CORRECTNESS |
| MAINTAINABILITY | MAINTAINABILITY, ARCHITECTURE |

- **Location match:** the finding's `file` equals a gold location's path, and the ranges are within tolerance
  `T = 10` lines (`fs ≤ ge + T` and `fe ≥ gs − T`); a gold location without lines matches any finding in that file;
  a file-less finding never matches.
- **Strict:** a location match and a compatible category. **Lenient:** the same path, any lines, any category.
  Severity is not part of either; agreement is reported separately.
- **Cardinality: one-to-one.** Candidate pairs that satisfy the variant are ordered by line distance (0 when the
  ranges overlap, else the gap), then gold item id, then finding fingerprint, and assigned greedily; each gold item
  and each finding is used at most once; a multi-location gold item matches through its nearest location. A finding
  that satisfied the predicate only with an already-matched gold item is `duplicate`; any other unmatched finding is
  `unlabelled` (never counted as a false positive).
- Recall = matched / eligible gold items; stale-flag rate = matched negatives / negative-eligible items.

**Exclusion rules, in order (the first that applies wins; each is counted in the scorecard's denominator table):**

| # | Reason | Applies when | Level |
|---|---|---|---|
| 1 | `plan-defect` | the item labels a plan or document review (no code tree) | provenance |
| 2 | `reviewed-tree-unknown` | `R_c` cannot be identified (§7.5), or `R_c` or `B_c` is in no source (reachable git, local object store, controller bundle) | provenance |
| 3 | `excerpt-unpublishable` | a cited file at `R_c` cannot pass the publication gates | provenance |
| 4 | `no-location` | the item cites no file location (R22: such Phase 1 items drop out; the count is reported) | freeze |
| 5 | `leakage-filtered` | every cited file is removed by the leakage filter | packet |
| 6 | `not-in-packet` | no cited location lies in any chunk's packet content | packet |
| 7 | `egress-stopped` | every chunk holding a cited file is not `CLEAR` | packet |

Second-hand labels are not excluded; they are reported separately (`labelQuality`). S19 may record rules 1–3 now;
rules 4–7 are frozen only after the controller confirms this protocol. A `private-bundle-only` item is not excluded:
it is counted (`dependsOnPrivateBundle`) and verified by its excerpts' hashes, or against the bundle in bundle mode.

**Golden fixtures (one historical item, both sides).** Item `P2-FINAL-HIGH-003@2e61f24` (risk admission after
workspace creation; Phase 2 final review v1, cited `packages/application/src/execute-task.ts:143-148` among others;
`R_c = 2e61f2447f6812f9ed795a5195a25861ada1c50b`, derived as the parent of `3ea0293`; `RESOLVED` at re-review v2,
whose derived `R_{c+1}` is `061ec236dacb985c77afa29205bf8bc0a185a49e`). Files under
`evals/review-benchmark/golden/P2-FINAL-HIGH-003/`:

- `item.json` — the corpus item (provenance, gold locations, `goldCategory`, synthetic-field record);
- `reviewed/` and `post-fix/` — `packet-sources.sha256`, `packet.sha256` and `prompt.sha256` of the chunk that
  holds the first cited file, plus `chunks.json` (chunk ids and their file lists); `post-fix/mapped-locations.json`;
- `outputs/reviewed/` and `outputs/post-fix/` — scripted review outputs placed relative to that side's gold location
  (reviewed) or mapped location (post-fix): `exact`, `near` (shifted by 10 lines), `far` (shifted by 11 lines),
  `wrong-category` and `other-file`;
- `expected-matches.json` — for each output and side, the strict and lenient result: `exact` and `near` match
  strictly on the reviewed side and are stale flags on the post-fix side; `far` and `wrong-category` match only
  leniently; `other-file` is `unlabelled`.

The S20 test "golden historical item reconstructs identical packets and matches as specified on both sides"
rebuilds both sides from the committed excerpts and requires every digest and every expected match. The same test
passes each rebuilt packet, with its corpus execution shape, through the packet validator (`assertPacketWhitelist`)
and the prompt renderer, so the one shape of rule P item 5 is the shape both accept.

---

## 8. Assurance round sequence

```text
[attempt N evidence persisted; resultSha = harness commit]                 (Phase 2 steps / Lane A workflow)
  → planAssurance             pure: risk + policy + registry → mode, reviewers (primary [+ comparator]), limits
  → buildReviewPacket         trusted sources only, read through the workspace the resolver returns for the
                              caller's fence (§16 I6); canonical bytes; byte budget; never truncates silently
  → runDeterministicChecks    push guard (secret in added lines, forbidden path, unscannable change at a sensitive
                              path); egress decision over the exact packet bytes; false-green, Trojan Source,
                              dependency, invariant checks; SARIF from L4/L5
      push guard BLOCK  → reviewers SKIPPED (zero requests) → adjudicateRound → BLOCK
      egress not CLEAR  → reviewers EGRESS_STOPPED (zero requests) → adjudicateRound
  → runReviewer × reviewers   only on CLEAR; Phase 2 fenced claim; exact request bytes re-scanned; packet-only;
                              blind to each other; raw request/response captured first
  → adjudicateRound           pure decision + fenced persisted AdjudicationRecord + events
      production (shadow | not-required): PROCEED (shadow.wouldBe recorded) or BLOCK
      drill (gating, tests only):        PROCEED | REPAIR | ESCALATE | BLOCK
```

A verification stop does **not** run a round; the orchestrator calls `recordAttemptOutcome` at every attempt
terminal, verification stops included (R3). Task status stays `VERIFYING` across rounds; attempt states
`UNDER_REVIEW` and `CHANGES_REQUESTED` are added (SR-C7).

**Byte budget (R23, R28).** Two measurements, each against the reviewer's `packetBudgetBytes`, carried in the packet
as `budget.maxBytes`:

- **Packet**, at build, before rendering. The decision: the packet is over budget when the UTF-8 length of the
  canonical packet as it would be sent (carrying `overBudget: false`) plus the byte length of every content part the
  prompt embeds (cumulative diff, repair delta, each post-image) exceeds `maxBytes`, or a diff did not fit its reader
  limit. Every content-bearing field — the objective, requirement statements, paths, commands, excerpts, prior
  findings — is inside the canonical packet and so is counted. `budget.overBudget` records that decision; it is a
  decision, not a size. The record (R32): `includedBytes` is the **stored** packet's final size — the UTF-8 length of
  the exact canonical bytes that are hashed and stored, measured after the flag is set, plus the embedded parts — for
  accepted and rejected packets alike. For an accepted packet it is the size the decision measured; a rejected
  packet's stored `true` is one byte shorter than the `false` it was measured with. The packet does not carry its own
  measured size: `includedBytes` is recorded alongside it (the builder's result, `BuildReviewPacketOutput.includedBytes`,
  the round row's `packet_included_bytes`), never inside the hashed packet. **Invariant:** an accepted packet's
  canonical serialized byte length, plus its embedded parts, is at most its cap — checked by an independent oracle
  (`Buffer.byteLength` of the canonical JSON of the final packet object) at the cap and at cap + 1.
- **Rendered prompt**, before sending: the canonical prompt bytes (instructions, the datamarked input and the output
  schema). A prompt larger than `maxBytes` is refused with a distinct over-budget error and is never sent; the
  review is recorded `FAILED` with reason `prompt-over-budget`, which rule A3 treats like an over-budget packet.

Nothing is ever truncated to fit: over budget means not sent, recorded as over-budget.

---

## 9. Independence model (ADR 0010)

1. **Packet-only input.** The reviewer receives one immutable `ReviewPacket`. The schema has no field for the
   coder's summary, limitations, session, events, ContextPack, PR body or commit messages. Allowed sources:
   EvidenceBundle (diff, **execution manifest**: per-check command, exit code, duration, environment digest, raw
   stdout/stderr artifact refs with bounded, scanned excerpts, parsed test summaries), WorkOrder, trusted range
   diffs and post-images, and — in re-review only — prior adjudicated findings in structured form.
2. **Different model family**, resolved from a policy registry by model id. A reviewer must differ from the
   implementer's family; the comparator must also differ from the primary's family; unknown family fails closed.
3. **Fresh request.** As sent by the harness: `store: false`, no `previous_response_id`, no `conversation`, no
   tools, `tool_choice: "none"`. The gateway adds instructions and tools in transit (U-3), so the request the model
   is served is **not** tool-free and does not carry only the harness rubric. Independence (no shared context with
   the coder) still holds for everything the harness controls; the gateway's additions are the same for every
   caller and carry no coder context, but this is a property of the gateway, recorded per call (§11), not
   something the harness can enforce. Any tool-call item in a response remains `MALFORMED`.
4. **Blind parallel reviewers** within one round.
5. **Separate credentials**, held by the harness process only (§10).
6. **Deterministic evidence outranks model review.**

---

## 10. Egress, credential and prompt-injection model

### 10.1 Pre-gateway egress decision (P4-PLAN-CRIT-001, R13)

No byte leaves the harness for a reviewer gateway unless it has been scanned and classified.

- `runDeterministicChecks` computes `egress.decision` over the canonical packet content before rendering:
  - `STOP_SECRET` — any secret pattern (parity with `scripts/lib/secret-patterns.sh`) anywhere in the packet:
    diff, post-images, execution-manifest excerpts, WorkOrder text;
  - `STOP_CLASSIFIED` — any packet path matches the project's `egress.denyPathGlobs` (policy data; defaults cover
    `.env*`, key and certificate files, `secrets/`, credential files), any path is not normalizable (below), or the
    project has not opted in to reviewer egress. The paths classified are both sides — pre-image and post-image
    path — of every file entry of the cumulative diff **and** of the repair delta: renames, copies, deletions and
    files that only the repair delta touches (R23). A repair delta that cannot be parsed is `STOP_UNSCANNABLE`;
  - a path is **not normalizable** when it is empty, absolute, has an empty, `.` or `..` segment, a backslash, any
    C0 control character (U+0000–U+001F), DEL (U+007F), any C1 control character (U+0080–U+009F), U+2028 or
    U+2029, or starts with `"` (an unresolved Git C-quoted form). Such a path is never read, never matched against a
    glob as if it were ordinary, and always sensitive. Glob matching itself covers every code point (`.` spans line
    terminators; `?` and `*` count code points), as defence in depth;
  - `STOP_UNSCANNABLE` — content that cannot be scanned (binary, non-UTF-8, over the per-file limit) at a path
    that is sensitive by classification; unscannable content elsewhere is omitted from the packet, never sent,
    and recorded as an omission;
  - `CLEAR` otherwise.
- `runReviewer` refuses to call unless the check report carries `CLEAR` for this packet's sha256, and then
  re-scans the **exact request body bytes** (instructions + rendered input) immediately before the provider call;
  a hit records `EGRESS_STOPPED` with zero requests.
- The push guard is separate and also runs before the gateway: a secret in **added** lines, a forbidden-path
  change, a path that is not normalizable anywhere in the packet or either diff, or an unscannable change at a
  sensitive path is `BLOCK` (D-5) and no reviewer is called. The packet builder keeps a non-normalizable changed
  path (omitted with reason `unsafe-path`, never read) so that the push guard can block on it; it never throws on
  one, because a build failure would leave the round without a push-guard decision.
- Proof: a fake gateway (unit) and a local fake HTTP server driven through the real adapter and composition (itest)
  receive **exactly 0 requests** for each stop kind (exit D1, D2), including a control-character path, a Git
  C-quoted path and a sensitive pre-image that only the repair delta names.
- In shadow mode an egress stop is recorded (`reviewerFailed`, `egressStopped`) and the round proceeds; in drill
  gating it escalates `egress-stopped`.

### 10.2 Credential (R13, P4-PLAN-MED-004)

The reviewer adapter runs in the harness process, never in the agent container. `assurance-root.ts` (composition
root) builds a `ReviewerCredentialSource` from controller-supplied configuration and injects it; adapter code reads
no process environment (fitness rule, exit C5). The source returns `{ value, expiresAt, version }`; the adapter
re-fetches before `expiresAt` minus skew and never holds a value longer than `maxCredentialAgeMs` (policy, proposal
15 minutes) even when the source reports no expiry; on HTTP 401 it invalidates, re-fetches once and retries once
(rotation), then fails `AUTH_ERROR`. The value appears only in the `Authorization` header and never in an artifact,
log, error text or row (canary test). The controller supplies base URL and credential only for the opt-in live run.
Whether the live operation runs is a **policy decision with its own unit test, never a test-runner skip**
(P4-PLAN2-MED-003, R18): `liveReviewerRequirement({ requireFlag, credentialConfigured })` returns `run`,
`not-configured` (flag unset, no credential: the live test records the reason and the proof manifest sees the policy
test pass) or `fail-closed` (flag `ASEP_REQUIRE_LIVE_REVIEWER=1` without a credential). With the flag set, the live
round trip runs and any failure is red (exit G8).

### 10.3 Prompt injection

Defences, strongest first: (1) authority never flows from content — model output is advisory, and in Phase 4
production it cannot change the workflow at all; (2) instruction/data separation — the rubric is in
`instructions`, untrusted content only in the user input; (3) spotlighting with a packet-derived nonce and
per-line datamarking; base64 encoding evaluated as an alternative in the injection suite; (4) strict structured
output plus independent AJV validation and grounding; (5) deterministic hazards (Trojan Source) are findings;
(6) no silent truncation; (7) measured: the injection suite has deterministic harness invariants (pass/fail) and a
model-degradation measurement compared against the pre-registered floor with a positive control (exit D6).
Second-order risk: finding text reaches a repair coder only in drill compositions, bounded and structured.

---

## 11. Determinism and replayability

The reviewer is not deterministic: with reasoning effort above `none`, `temperature`/`top_p` are unsupported and
the Responses create endpoint exposes no seed (research register §1). Replayability is record and replay:
canonical packet and prompt bytes; canonical request (no credential) and exact response bytes stored before
parsing; a replay reviewer keyed by request hash that fails closed on a miss; pure adjudication and scoring;
pinned descriptor (model, effort, tier, template hash, schema hash); served model recorded and checked; variance
measured with k runs.

**The gateway alters requests (verified, U-3; risk PR4-30).** What the served model saw is not what the harness
sent: the gateway appends roughly 330 tokens of instructions and roughly 300 tokens of tools to every request.
Consequences:

- Replay determinism holds for the harness side only: replaying a recorded response by request hash reproduces the
  harness's decisions byte for byte, but re-sending the same request bytes reproduces the served prompt only if the
  gateway's additions are unchanged. Replay and independence claims are stated "via this gateway".
- **Per-call detection** (adapter, S10): the adapter compares the response's returned `instructions` with the
  `instructions` it sent and reads `usage.attribution.request_fields` (when present) for fields the harness never
  sent (`tools`, extra `instructions` tokens). It records `gatewayAlteration: { instructionsAltered, appendedBytes,
  appendedSha256, toolsAttributed, attributedFields[] }` on the review record; an absent comparison field is
  recorded as `unknown`, never as "unaltered". The appended text itself is stored as an artifact (it is
  gateway-controlled, not harness content) so its drift over time is visible.
- The S10 probe confirms detection on the live gateway for both reviewers before any capture.
- Every measurement scorecard and the verdict block name the gateway and its alteration status (§23).

No wall-clock time is read in the assurance steps (R15): timestamps come from `AssuranceStepContext.now()`, which is
one fixed logical time per activity execution and identical on every retry, so a retried step writes byte-identical
records and events. Content-addressed artifacts (packet, check report, review record, adjudication record, repair
order) carry **no timestamp at all**: their ids and the round's outcome are the same whichever execution produced
them, and only row columns and run events carry `now()`. The one exception is the repair ContextPack, whose
`context-pack/v1` schema requires `generatedAt`: it takes the `decided_at` of the persisted REPAIR adjudication, a
value fixed once by an append-only row, so every execution derives the same bytes. Likewise, adjudication evaluates
waiver expiry at the round's opening time (`review_rounds.opened_at`, written once when the round opens), not at the
adjudicating execution's `now()`, so the decision is the same whichever execution makes it. Durations and retry
back-off belong to adapters with injected clocks; they are recorded as usage and kept out of the bytes that
identify a record. The slot block states this invariant itself, and conformance case RLC-11 compares the persisted record and
event bytes of an interrupted-then-redelivered round with an uninterrupted one (§18.2).

---

## 12. Adjudication rules (deterministic, versioned)

Evaluated in order; the first matching rule decides. `B` is the blocking set: deterministic findings at a blocking
severity, every SARIF finding of this round (each is the `sarif-unparsed` finding of one log, §14 item 6; it blocks
whatever `blockingSeverities[risk]` says, R37), grounded model findings whose severity is in `blockingSeverities[risk]`, and prior findings at a
blocking severity whose lifecycle state is still blocking after closure authority (§13) — model, deterministic and
SARIF priors alike, a SARIF prior at any severity — except where this round's finding carries the decision for the same identity (below).
Production compositions can only produce the **Shadow** column.

| # | Condition | Gating (drill only in Phase 4) | Shadow (production) |
|---|---|---|---|
| A1 | Push guard `BLOCK` | BLOCK | BLOCK |
| A2 | Mode `not-required` | PROCEED (deterministic findings in PR section) | — |
| A3 | Packet over budget | ESCALATE `packet-over-budget` | PROCEED, wouldBe ESCALATE |
| A4 | Egress not `CLEAR` | ESCALATE `egress-stopped` | PROCEED, wouldBe ESCALATE |
| A5 | No eligible independent reviewer | ESCALATE `independence-unsatisfiable` | PROCEED, wouldBe ESCALATE |
| A6 | Task budget insufficient for the planned calls | ESCALATE `budget-exhausted` | PROCEED, wouldBe ESCALATE |
| A7 | A planned review not `COMPLETED_VALID` after bounded retries (incl. served-model drift) | ESCALATE `reviewer-unavailable` | PROCEED, wouldBe ESCALATE |
| A8 | `B` empty and any reviewer verdict `ESCALATE` | ESCALATE `reviewer-escalated` | PROCEED, wouldBe ESCALATE |
| A9 | `B` empty | PROCEED | PROCEED, wouldBe PROCEED |
| A10 | `B` non-empty and `round ≥ maxRounds[risk]` | ESCALATE `max-repair-rounds` | PROCEED, wouldBe ESCALATE |
| A11 | `B` non-empty | REPAIR | PROCEED, wouldBe REPAIR |

Further rules: a model `APPROVE` with a grounded blocking finding is decided by the finding; a `REQUEST_CHANGES`
with no grounded blocking finding is non-blocking ("generic comments do not block",
`docs/platform/verification-and-review.md:31`) and counted as a verdict/finding mismatch; a model can never waive or
refute a grounded HIGH/CRITICAL finding (`docs/architecture/04-state-machines.md:48`); only an ungrounded finding can
be machine-refuted (reason `citation-unresolvable`). `A3` also fires when a planned review failed with reason
`context-overflow` or `prompt-over-budget` (§8).

**Finding identity and merging (R23).** Every model finding is grounded first, on its own. Its identity is
`(raisedBy, fingerprint, requirementId, key)`; findings are never merged across different requirement ids or finding
keys. Within one identity the merge is conservative and order-free: the result is grounded if any member is, takes
the highest severity among the grounded members (among all members when none is grounded), and its text and lines
come from the first member by a fixed order (grounded first, then severity, then line, then evidence). Check
findings merge the same way per `(raisedBy, fingerprint)`. The outcome, the blocking set and the record bytes are
invariant under every permutation of a reviewer's finding list (tested over all orders of a four-element set).

**Reconciling with prior findings (R23).** Before blocking is computed, each finding of this round is matched to the
round's prior findings by `(raisedBy, fingerprint, requirementId)` — the persisted identity; a finding key is local
to one review output and does not carry across rounds. A match links the current finding to the prior
(`priorFindingId`) and the prior's authoritative disposition decides: an unexpired `WAIVED` prior, or a `REFUTED` or
`ADJUDICATED` prior that was grounded (only a human refutes a grounded finding), makes the current finding
non-blocking (it carries the prior's state); a waiver that has expired at the round's opening time blocks; a
`VERIFIED` or `CLOSED` prior makes the current finding a **regression**: it is `OPEN`, blocking at a blocking
severity, and linked to the prior. A prior the harness refuted as ungrounded (`citation-unresolvable`) does not
shield a grounded re-raise (interpretation confirmed by R28). **A re-raise never downgrades (R28):** when the current
finding links to a prior it does not shield, its effective severity is the highest of its own and every such
prior's, and a prior that is still blocking keeps its blocking authority until an authorized closure — a LOW re-raise
of an `OPEN` HIGH prior blocks at HIGH. The linked pair is counted once in `B`, at that effective severity.

**Identity encoding (R28).** Every identity, fingerprint and dedupe key is the sha256 (or, for an in-memory key, the
text) of a canonical JSON array of its fields, never a joined string: separators inside a field cannot make two tuples
equal, and `null` and `""` stay distinct. This covers the finding fingerprint, the within-round identity, the
cross-round identity, the check-finding merge and dedupe keys, the adjudication id, the review id, the ordering keys
of the record and the reviewer-list comparison.

**SARIF identity (R37).** The identity of a `sarif-unparsed` finding is its check id and the sha256 of the log's
bytes (§14 item 6): a later log of the same check is a new finding, so a human disposition of one log never shields
another. Its re-raise — the same log again — is reconciled with its prior like any other finding.

The persisted `adjudications` row enforces "shadow ⇒ PROCEED or BLOCK" with a check
constraint (data model §3). A shadow `BLOCK` (A1) carries **no shadow verdict**, neither in `BlockOutcome` nor in
the row (`adjudications_shadow_ck` sets `would_be_outcome` only for a shadow `PROCEED`): the push guard is not a
gating decision, so there is no would-be outcome to record (P4-PLAN2-MED-005; conformance case RLC-12).

---

## 13. Repair, re-review and closure authority (drill compositions in Phase 4)

- `repair-order/v1`: task/attempt identity, round, `repairBaseSha` (= prior harness commit), `taskBaseSha`, the
  blocking findings (structured, cited, bounded), capped informational findings, the adjudication id.
- `buildRepairContextPack` derives the repair attempt's ContextPack without changing the `context-pack` schema:
  the objective gains a bounded repair directive, `specificationExcerpt` gains the rendered repair order (size
  capped by policy), `priorEvidenceIds` gains the prior evidence id, `hash` is recomputed, and the result is
  persisted before return.
- The repair attempt's workspace is created at `repairBaseSha`. Round N+1 is a re-review: cumulative diff, repair
  delta and prior findings with ids; reviewers return a closure claim per prior blocking finding.
- **Closure authority** (P4-PLAN-HIGH-002). Lifecycle per `docs/architecture/04-state-machines.md:40-48`:
  `OPEN → ACKNOWLEDGED → FIXED → VERIFIED → CLOSED`. A finding is blocking while `OPEN`, `ACKNOWLEDGED` or
  `FIXED`.
  - The reviewer configuration that raised a finding can only move it to `FIXED` (a **claim**); it can never make
    it non-blocking. The DB rejects a `RESOLUTION_VERIFIED` disposition whose actor equals the raiser.
  - `FIXED → VERIFIED` (non-blocking) requires one of: (a) a **different** reviewer configuration, eligible by
    family against the implementer, reporting `RESOLVED` with a grounded resolution citation that satisfies the
    **changed-line predicate** below; (b) a named human disposition; (c) for deterministic findings only, the same
    deterministic check no longer firing on the new tree. A SARIF finding is verified only by (b) (below).
  - **Changed-line predicate (R23; identical in architecture §11).** A resolution citation `(file, line)` closes a
    prior finding `F` only if, in the repair delta's entry for `file`:
    - `line` is an **added** (`+`) line of that entry's post-image; or
    - the entry changes `F`'s file by deletion only (it adds no line to it) and every line `F` cites
      (`F.lineStart…F.lineEnd`, pre-image numbering of the repair delta) is among that entry's **removed** (`-`)
      lines. A deletion-only closure must cite `F`'s own file; a deleted file closes `F` this way only when `F`'s
      cited lines were in it.

    Context lines — lines a hunk shows unchanged, even directly next to an edited line — never qualify, and neither
    does a line outside every hunk. A citation that is grounded but fails the predicate is a claim at most (`FIXED`,
    by the raiser) and never a verification. The golden test cites the unchanged context line directly above an
    added line and requires the finding to stay blocking.
  - **SARIF findings (R23, R32, R37).** A SARIF finding stays blocking until an authorized human disposition closes
    it. Model output never closes it, and neither does scanner output: a later round without the log, or with another
    log, changes nothing. Scanner-recheck closure is deferred out of Phase 4 (DF-9) and so is SARIF parsing (DF-10).
    The domain refuses every disposition of a SARIF finding by a non-human actor — verify, refute, waive, accept and
    claim — whatever `grounded` says and from every state the disposition may leave (`OPEN`, `ACKNOWLEDGED`, `FIXED`,
    and `REFUTED` or `ADJUDICATED` for an acceptance; R40); only a harness rule's reopen (an expired waiver) remains,
    which makes the finding blocking again. The database refuses the same rows (`finding_dispositions_sarif_ck`, data
    model §3.1).
  - **Hydration boundary (R40).** The domain decides on the aggregate it is given: it does not prove how a finding
    reached its stored state, and an aggregate built directly can already claim `CLOSED` or `WAIVED`. Persistence (S8)
    and the step use cases that hand priors to adjudication (S12) therefore hydrate only states reached through the
    finding's recorded dispositions, and refuse a stored state that no recorded disposition chain reaches.
  - A `RESOLVED` claim whose cited file was not touched by the repair delta stays `OPEN`
    (`closure-without-change`).
  - A finding of this round that matches a `VERIFIED` or `CLOSED` prior is a regression linked to that prior (§12).
  - Deterministic red→green proof for model findings is deferred (DF-7).
- `maxRounds` per risk = 2 (D-7; matches Phase 2 practice, `phase-02-risk-register.md:23` PR2-16).
- In Phase 4 production none of this runs: mode is never gating. It is proven by unit tests, the conformance kit,
  the drill itest (S16) and measured offline on residual-instance corpus items (rule C).

---

## 14. Architecture, security and false-green checks

1. **Push guard (pure):** secret patterns over added lines (parity with `scripts/lib/secret-patterns.sh`);
   changes to `forbiddenChanges` or outside `allowedPaths`; any path that is not normalizable (§10.1) in the packet,
   on either side of a cumulative-diff entry or of a repair-delta entry (`forbidden-path`); unscannable change at a
   sensitive path. `BLOCK`.
2. **Egress decision:** §10.1.
3. **False-green checks (P4-PLAN-HIGH-008, R23):** `exit-code-verdict-mismatch` (a check recorded passing while its
   raw exit code is non-zero — an evidence-reduction defect; `EVIDENCE_INTEGRITY`, HIGH); `failed-tests-recorded-pass`
   (a check recorded passing while its parsed test summary reports `fail > 0`; `EVIDENCE_INTEGRITY`, HIGH);
   `required-check-missing` (an acceptance check id of the WorkOrder absent from the evidence);
   `zero-tests-executed` (a unit/integration/acceptance check whose parsed summary has executed = tests − skipped −
   todo ≤ 0, whatever its exit code; parsers for node:test, TAP, Vitest and Jest summaries; an unparsed format is
   recorded `testSummary: null`, not guessed, and raises nothing); `skipped-tests-introduced`
   (added `.skip(`, `xit(`, `describe.skip`, `test.skip`, `@Disabled`, `pytest.mark.skip`, `t.Skip(` in test
   files); `test-file-deleted`. In Phase 4 these are reported findings (PR section, metrics), blocking only in
   drill gating.
4. **Trojan Source:** bidirectional and zero-width Unicode in added lines → SECURITY finding.
5. **Dependency and invariant checks:** manifest/lockfile changes flagged; `ArchitectureInvariant` 1.1.0
   `forbidden-import` rules over added import specifiers.
6. **Project tools via SARIF 2.1.0** from L4/L5 artifacts: **not parsed in Phase 4 (R37, DF-10).** No SARIF
   producer runs in Phase 4 (the pilot runs R0/R1, L0–L2), and four review rounds found ingestion faults. Each SARIF
   log the round's checks receive yields exactly one finding: source `sarif`, raiser `sarif:unparsed`, rule
   `sarif-unparsed`, severity HIGH, category `EVIDENCE_INTEGRITY`, no file or line, grounded to the log artifact (the
   evidence names the check id, the sha256 and the size of the bytes the check report lists under `sarifInputs`). It
   blocks whatever the severity policy says (§12), only an authorized human closes it (§13), and a later round without
   the log changes nothing. Its fingerprint is the canonical tuple `[category, subject, null, "sarif-unparsed"]`, where
   the subject is the canonical JSON text of `["sarif-log", checkId, sha256]`, so two logs are two findings and a new
   log of the same check is a new finding. The bytes are
   never decoded: a log that is not even JSON yields the same one finding. The check report's parser requires
   exactly these findings for its listed logs, lists the logs by check id and then sha256, so every arrival order gives
   one report, and the check summary counts each SARIF finding as blocking whatever the severity policy says (R40). The rules of SARIF reference resolution (rule-ID forms, hierarchical
   IDs, artifact indexes, `uriBaseId`) are DF-10's entry criteria (§5.3).
7. Raw check output is stored before any reduction (ADR 0009).

---

## 15. Measurement and dashboards

- **Event ownership** (§18.4): Lane B emits `attempt.declared_complete`, `attempt.completed`, `review.completed`
  (one per review source per round: each model reviewer record and one deterministic record),
  `review.finding_dispositioned` and `repair.started`, through the shared `RunEventSink` into Lane A's
  `run_events` (R4). Lane A emits `workflow.recovered`, `task.*`, `run.*` and control events. Only operational runs
  emit there: `run_events` keeps its FK onto `runs`, and benchmark, replay and corpus measurement never write to it;
  their outputs go to eval artifacts (`evals/review-benchmark/**`) or `metric_snapshots` (R15). Lane B owns no
  run-event sink; the only sink is Lane A's `adapters/persistence/src/run-events/**`.
- **Authoritative review metrics (P4-PLAN-HIGH-004).** `review_finding_yield` and `review_false_positive_rate`
  take their numerators from `review.finding_dispositioned` events by a **named human**, keeping only the latest
  disposition per `findingId`; denominators stay `sum(review.completed.reviewFindingsTotal)`. A human accepting or
  rejecting a finding after the round changes the next snapshot; a later reversal changes it again. Harness-rule
  refutations of ungrounded findings are reported separately (`review_ungrounded_rate`). This needs one new
  dictionary aggregation option (`dedupeLatestBy`, SR-D2) and a dictionary version bump.
- **Cohort semantics for late dispositions (P4-PLAN2-MED-006, R18).** A disposition counts in the **cohort of the
  review round it disposes** — the window in which that round's `review.completed` occurred — never in the window in
  which the disposition arrived. Each `review.finding_dispositioned` event carries `reviewRoundCompletedAt` (the
  `occurredAt` of the disposed round's `review.completed`), and the numerator operands select by it (dictionary
  operand option `cohortBy: reviewRoundCompletedAt`, SR-X6). A late disposition makes the evaluator recompute that
  cohort's snapshots and write them as a **new snapshot version**; earlier versions are append-only and retained, and
  panels read the latest version. Disposition latency (`dispositionLatencyMs` = disposition `occurredAt` −
  `reviewRoundCompletedAt`) is reported as `review_disposition_latency_ms`, per cohort. Test (exit H6): one finding
  reviewed on day 1, accepted on day 2 and rejected on day 3 gives the day-1 cohort's yield snapshot versions 1–3
  (`0`, `1`, `0`) and its false-positive snapshot versions 1–2 (`0`, `1`), with every earlier version still readable,
  while the day-2 and day-3 windows count no disposition of that round.
- **Evaluator** computes every metric from events with the dictionary's own filters, zero-denominator policy and
  privacy class; a recompute is idempotent (an unchanged value writes nothing) and a changed value appends a new
  version to `metric_snapshots`; panels read the latest version only.
- **Dashboards:** false completion, review yield (yield, false positives, adjudication coverage, ungrounded rate,
  reviewer failure, egress stops, shadow would-block), cost (per accepted task, per review, cost coverage),
  recovery (`workflow_recovery_rate` from Lane A's events; `null` with reason until they exist — never 0).
- **Grafana in the required gate (D-6):** the integration gate starts a digest-pinned Grafana with the committed
  provisioning and asserts through its HTTP API that the data source, every dashboard and every panel query load
  and return the snapshot values the evaluator wrote (exit J4).
- **Cost honesty:** reviewer cost = recorded tokens × configured price with source and date; no price →
  `reviewCostUsd` omitted, `reviewCostPriced=false`, coverage panel shows the gap.

---

## 16. Concurrency and fencing (R1, P4-PLAN-HIGH-001)

Phase 4 does not invent a fencing scheme. It depends on the accepted Phase 2 fenced-takeover primitive and states
the dependency by invariant until Phase 2 is accepted:

- **I1** A claim succeeds only if, in the same transaction, the claimant's workspace lease is `ACTIVE`, is held by
  the claimant's `leaseId`, and is at the current lease epoch. A zombie that lost its lease can never claim or
  complete.
- **I2** At most one live claim exists per reviewer call (per `reviewId`).
- **I3** Takeover of a pending claim is possible only after the prior holder's lease is no longer `ACTIVE` at its
  epoch (expiry or handoff); the new holder completes; the old holder's completion is rejected.
- **I4** A `FAILED` call is reopened only by a newer claim and only after reconciliation: for a reviewer call, if a
  raw response artifact for the same request hash already exists (responses are persisted before parsing), it is
  adopted instead of calling again. `store: false` means there is no remote state to query.
- **I5** Every Lane B write that records a decision — review-round open/close, review-record terminal state,
  adjudication, repair order, harness disposition — performs the fence check of I1 in its own transaction.
- **I6** (P4-PLAN2-MED-001, R18) Steps read repository content only through a workspace obtained from
  `AssuranceWorkspaceResolver.resolve(scope, { attemptId, leaseId, fencingEpoch })` (slot block, §18) for the
  caller's fence. The resolver checks tenant, an `ACTIVE` lease held by that lease id and the current epoch, and
  fails closed; a refusal stops the step before any read (`not-in-scope` → `ReviewLoopContractError`, every other
  refusal → `AssuranceFencedError`). Lane A implements it over the lease table; no workspace comes from
  activity-local memory. Tests: wrong tenant, wrong lease, stale epoch and ended lease, through the framework-free
  resolver kit (WRC-01…05) on Lane A's implementation and on Lane B's fake, plus slot-level refusal tests (exit E13).

**Change request CR-F1 against the Phase 2 primitive** (exact signature decided after Phase 2 acceptance):
(a) a reviewer call is claimed as a side-effect operation whose semantic key is qualified by the `reviewId` (one
claim per reviewer per round, not per attempt), with a closed result shape
`{ kind: 'reviewer.call'; reviewId; rawResponseArtifactId; rawResponseSha256; observationStatus }`; and (b) the
fence check of I1 is callable inside another repository's transaction. If the accepted primitive already offers
(b) generically, (a) alone is requested. Tests (exit E2): the new owner completes after a lease handoff; the old
owner is fenced after the handoff; concurrent claims yield one winner; a zombie with an expired lease cannot claim;
a reopened `FAILED` call adopts an existing raw response instead of calling.

---

## 17. Phase 2 lessons → structural countermeasures

| Lesson | Countermeasure |
|---|---|
| A green gate that did not exercise the MUSTs | proof manifest from the test reporter: every MUST-mapped test name must appear as **passed** (not skipped/todo); seeded mutations of the key guards must turn their tests red (S23) |
| Fake backends where real ones were required | real PG + Git + sandbox itests; reviewer faked only at HTTP behind the real adapter; real-coder loop is its own MUST; measurement only from live recordings |
| Vocabulary without runtime emission | dashboards proven from events the loop actually emitted, loaded in a real Grafana |
| Fencing that rejects but never takes over (Phase 2 HIGH-006) | takeover tests, not only rejection tests (§16) |
| Findings fixed in name only | each accepted finding names its design change, exit criterion, slice and (for key ones) a mutation proof (`phase-04-review-log.md`) |
| False implementer status claims | report fields generated from machine sources; "not verified" vocabulary |

---

## 18. Lane A integration: the review-loop slot

### Review-loop slot contract (verbatim for S0)

Lane A copies the block below verbatim into its plan and lands it in S0 as three files under
`packages/application/src/review-loop/` (re-exported from `packages/application/src/index.ts`). The types file is
complete, including the envelope helper; the two helper files are given as signatures (`declare`) with their
behaviour specified in §18.2. This is the **v6 block** (R18, R23, R28, R29, R32): it replaces the v2–v5 texts, none
of which Lane A has received, and goes to Lane A only after the controller's focused check (R23 hand-off rule). v4
changes against v3: every output is JSON (`recordAttemptOutcome` resolves `null`); the envelope helper validates
plain JSON recursively before it measures; both writing helpers carry the caller's fence; a recorded attempt's
redelivery is a no-op when identical and a coded conflict otherwise; `ReviewLoopContractError` carries a code;
`PacketOmissionReason` gains `unsafe-path`; the kit gains RLC-14 and RLC-15 and RLC-01's negative fixtures. v5
changes against v4 (R28, binding on both lanes): money at the seam is integer micro-USD (`*MicroUsd` fields, checked by
the envelope helper); `AttemptOutcomeInput` is a union whose `fence` is `null` only for an attempt that never held a
lease, with the eight pre-lease obligations written into the block and the kit gaining RLC-16 and RLC-17;
`RunReviewerOutput` and the outcome types are discriminated unions, so the record reference, the provider-call count,
the mode and the shadow verdict are consistent in the type; `BuildReviewPacketOutput` reports `includedBytes`, which
the hashed packet no longer carries; `reviewId` hashes a canonical JSON array. v6 changes against v5 (R32, consistent
with R29): a `fence: null` write refused because the attempt's history now shows a lease raises the new code
`lease-granted`, never `AssuranceFencedError`, and the kit gains RLC-18 for the R29 recovery; the conformance fixture is
a union, so a stateful implementation must supply every hook (the atomicity case included) and only a slot declaring
`stateless: true` reports the stateful cases not-applicable; `runRegistrationOrderingContract` (RLC-19) lets Lane A prove
registration before any attempt-bound effect; the pre-lease doc states the single R29 exception to "every terminal is
recorded"; `includedBytes` is the stored packet's final size.

Location: Lane A's v1 plan put the port and kit in `packages/ports` (CR-10). The slot returns `AdmissionResult`,
which lives in `@asep/application` (`packages/application/src/risk-admission.ts:30-36`), and ports must not depend
on application; the orchestration workflow already depends on `@asep/application` for the Phase 2 step use cases.
So the slot, the disabled slot, the workspace resolver port and the kit live in
`packages/application/src/review-loop/`. Lane A's `ReviewLoopPort`, `ReviewLoopRequest`, `ReviewLoopDecision`,
`ReviewLoopTrigger` and `ReviewLoopUnavailableError` are superseded by this contract (R3).

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

### 18.2 Default slots, helper behaviour and conformance cases (S0)

**Two default slots coexist with distinct jobs** (P4-PLAN2-MED-007, R18):

- Lane A's `NotConfiguredAssuranceSlot` (Lane A's plan) is the **default binding** when no assurance is configured.
  It fails closed for any risk that requires review and emits the attempt-outcome events. Lane A composes it until
  Lane B's implementation is integrated, and it passes the conformance kit with a `StatefulConformanceFixture`:
  it persists outcome events, so the atomicity case applies to it (R37).
- Lane B's `createDisabledAssuranceSlot(REVIEW_LOOP_DISABLED)` is the **explicit, literal opt-out**, mirroring
  `HOST_EXECUTION_WAIVER`: `PROCEED` without events. It is never a default.

`createScriptedReviewLoopSlot` lets Lane A drive its workflow through all four outcome kinds.

**Terminal vocabulary.** `AttemptTerminal` above is the vocabulary of `recordAttemptOutcome`. A verification stop is
`verification-stopped`; the agent's own failure or overstep is `agent-failed`; worker death, an activity failure
outside assurance and other infrastructure stops are `infrastructure-failed`; budget exhaustion is
`budget-exhausted`; cancellation and a pause timeout are `cancelled`. Lane A updates its prose, its terminal table
and exit J2 to this vocabulary at hand-off (R18). **Every terminal is recorded** (R28): a leased attempt with its caller
fence before the lease is released, an attempt that never held a lease with `fence: null`, and only with a terminal in
`PRE_LEASE_ATTEMPT_TERMINALS` (`cancelled`, `infrastructure-failed`). Lane A confirms that list against its core: it
lists every path on which an attempt is registered and never leased, with the terminal it emits, and returns any
terminal outside the list to the controller. A `fence: null` write refused with `lease-granted` is recovered by looking
the lease up (SR-A14). **The single exception (R29, R32):** when the store cannot be read or written after the retry
policy — a failed lookup, or a failed pre-lease terminal write — the task ends `FAILED` / `attempt-state-unknown`, the
audit entry carries the attempt's idempotency key, the terminal is not recorded, and telemetry completeness (exit J6)
reports the attempt as a gap with that key; it is never hidden. `attempt-state-unknown` is a task outcome, not a
pre-lease terminal.

**Pre-lease terminals (R28).** The eight obligations written on `PreLeaseAttemptOutcomeInput` in the block, with the
party that carries each and the case that proves it:

| # | Obligation | Carried by | Proved by |
|---|---|---|---|
| 1 | the attempt is registered before any attempt-bound effect | composition (Lane A) | RLC-16 (an unregistered attempt id → `not-in-scope`); RLC-19 (no attempt-bound effect before the registration is reconciled) |
| 2 | the write transaction checks the tenant and locks the attempt row that lease acquisition locks | slot implementation and composition | RLC-16 (foreign scope → `not-in-scope`; the race) |
| 3 | `fence: null` only when durable history shows the attempt never had a lease; otherwise `lease-granted` | slot implementation | RLC-16 race; RLC-17 (refused after release and after takeover); RLC-18 (the R29 recovery) |
| 4 | the terminal is `cancelled` or `infrastructure-failed` | slot implementation (and the type) | RLC-16 (`proceeded` with `fence: null` → `invalid-input`) |
| 5 | lease acquisition refuses an attempt that already has a terminal, under the same lock | composition (Lane A) | RLC-16 (`acquireLease()` after the terminal → refused; the race) |
| 6 | terminal, idempotency record and events commit atomically | slot implementation | RLC-16 (a commit failure changes nothing; the retry records; mandatory for every stateful subject) |
| 7 | an attempt that ever held a lease presents its caller fence | slot implementation (and the type) | RLC-17 |
| 8 | `buildRepairContextPack` always requires a fence | slot implementation (and the type) | RLC-17 (`fence: null` → `invalid-input`) |

`runReviewLoopContract` cases, run by both lanes (Lane A against the scripted, disabled and not-configured slots;
Lane B against `createAssuranceSlot` on PGlite and on real PostgreSQL). Every case starts from a fresh subject. Only
a slot that persists nothing — the disabled and scripted slots — may present a `StatelessConformanceFixture`; any
other subject, Lane A's `NotConfiguredAssuranceSlot` included because it persists outcome events, is stateful,
supplies every hook, and a stateful case it cannot pass fails (R32, R37):

| Case | Assertion |
|---|---|
| RLC-01 | every input and output of every method JSON-round-trips deep-equal and `reviewLoopPayloadBytes` ≤ 65 536; `assertWithinReviewLoopEnvelope` accepts a payload of exactly 65 536 bytes and rejects one of 65 537 with `ReviewLoopContractError` code `invalid-payload`; an input padded past the envelope (in `implementer.providerId`) → `invalid-payload` and no state change. Negative fixtures, each rejected by `reviewLoopPayloadBytes` with `invalid-payload`: `{ x: undefined }`, `{ x: Infinity }`, `{ x: -Infinity }`, `{ x: NaN }`, `{ x: -0 }`, `{ x: new Date(0) }`, `{ x: new Map() }`, `{ x: new Set() }`, `{ x: new (class Point {})() }`, `[1, , 3]`, a cycle, a `bigint`, a function and an `undefined` root; money (R28), each rejected the same way: a `*MicroUsd` value that is fractional (`5000000.4`, the R21 boundary `5.0000004` USD before the adapter's ceiling), negative, `2 ** 53`, a string, a boolean or an object, at any depth including inside an array element; positive controls `null`, `{}`, `[]`, `Object.create(null)`, a shared (non-cyclic) reference and `*MicroUsd` values `null`, `0` and `Number.MAX_SAFE_INTEGER` are accepted. `fixture.input` with `budgetRemaining.costMicroUsd` set to `undefined`, to `1.5` and to `-1`, and with `budgetRemaining.wallClockMs` set to `NaN`, → `invalid-payload` and no state change; `fixture.attemptOutcome` with `cost.modelCostMicroUsd` set to `0.5` → `invalid-payload` and no state change |
| RLC-02 | `runAssuranceRound` twice with the same input → deep-equal outcomes; the second call sends no provider request |
| RLC-03 | `slotVersion` other than `review-loop/v1` → `ReviewLoopContractError` code `invalid-input` |
| RLC-04 | round 1 with a `priorAdjudicationId`, or round > 1 without one → `ReviewLoopContractError` code `invalid-input` |
| RLC-05 | after `rotateFence()`, a call with the old fence → `AssuranceFencedError` and no state change; the new fence completes and converges to RLC-02's outcome |
| RLC-06 | outcome invariants, checked at runtime on every output the subject returns (the types state them too, R28): `roundKey = idempotencyKey`; mode `shadow` or `not-required` ⇒ kind ∈ {PROCEED, BLOCK}; only `PROCEED` has a `shadow` key, and it is non-null iff mode `shadow`; REPAIR and ESCALATE have mode `gating`; REPAIR ⇒ `nextRound = round + 1` and `repairBaseSha = resultSha`; every `runReviewer` output with status `COMPLETED_VALID` or `COMPLETED_INVALID` has a non-null `reviewRecordRef` and `providerCalls ≥ 1`, `FAILED` has a null one, and `EGRESS_STOPPED` or `SKIPPED_PUSH_GUARD` has a null one and `providerCalls = 0`; `buildReviewPacket` with `overBudget: false` has `includedBytes ≤ plan.packetBudgetBytes` and no diff over its reader limit, and with `overBudget: true` has a diff over its reader limit or `includedBytes + 1 > plan.packetBudgetBytes` (the stored `true` is one byte shorter than the `false` the size was decided on). Negative fixtures: the scripted slot, told to return each violating shape, fails the case |
| RLC-07 | an aborted signal → `AssuranceCancelledError`; a later call with a live signal converges to RLC-02's outcome |
| RLC-08 | `recordAttemptOutcome(attemptOutcome)` resolves exactly `null` (never `undefined`) and changes `persistedAttemptBytes` of the attempt (the terminal is recorded) |
| RLC-09 | `admitWithAssurance` with `promotedReviewerConfigIds: []` equals `admitRisk` for R0–R4; R3/R4 are `DEFERRED` for every capability |
| RLC-10 | running the individual steps in order yields the same outcome as `runAssuranceRound` |
| RLC-11 | fixed logical time (R15): for each boundary after `plan`, `packet`, `checks`, each reviewer and `adjudicate`, a fresh subject runs the steps up to the boundary at logical time T and is interrupted; a redelivery of `runAssuranceRound` with the same input and T returns the outcome of an uninterrupted run at T on another fresh subject, and `persistedRoundBytes` of both are byte-identical; a further redelivery at a later logical time changes no persisted byte and returns the same outcome |
| RLC-12 | shadow `BLOCK`: `pushGuardInput` → kind `BLOCK` with a `BlockReason`, no `shadow` key, `usage.providerCalls = 0` (not-applicable when `pushGuardInput` is null) |
| RLC-13 | an input whose `scope` is another tenant's → `ReviewLoopContractError` code `not-in-scope` and no state change (not-applicable for a stateless implementation) |
| RLC-14 | helper fencing (R23), for `recordAttemptOutcome` (with `attemptOutcome`) and `buildRepairContextPack` (with `prepareRepair()`'s input), each on a fresh subject: the fence with `fencingEpoch` one below or one above, or with another `leaseId`, → `AssuranceFencedError` and `persistedAttemptBytes` unchanged; after the matching `rotateFence()`, the old fence → `AssuranceFencedError` and unchanged, and the new holder's fence succeeds; after `endLease()`, `recordAttemptOutcome` with the fence that held the lease → `AssuranceFencedError` and unchanged (a terminal is recorded before release) |
| RLC-15 | helper redelivery (R23), for both helpers, each on a fresh subject after one successful call: the identical input → the same output (`null`; the same `contextPackRef` bytes) and `persistedAttemptBytes` unchanged; the identical input under the holder's new fence after `rotateFence()` → the same output and unchanged; an input that differs in one field (`terminal` or `failureClass`; `repairOrderRef` or `originalContextPackRef`) → `ReviewLoopContractError` code `conflicting-redelivery` and unchanged; with a stale fence, a conflicting input → `AssuranceFencedError` (the fence is checked first) |
| RLC-16 | pre-lease terminal (R28 obligations 1–6), each on a fresh subject with `preLeaseAttempt()`: its `attemptOutcome` (`fence: null`) resolves `null` and changes `persistedAttemptBytes` (terminal, idempotency record and events), and a later `acquireLease()` resolves `null` (refused) with the bytes unchanged; an identical redelivery → `null` and unchanged; the same outcome with terminal `proceeded` → `ReviewLoopContractError` `invalid-input` and unchanged; under another tenant's scope, or for an attempt id the store never registered, → `not-in-scope` and unchanged; after `failNextCommit()` the call fails and the bytes are unchanged, and the retry records it (mandatory for a stateful subject; not-applicable only for a `StatelessConformanceFixture`, R32); **race**, on each of 20 fresh subjects: `recordAttemptOutcome(attemptOutcome)` and `acquireLease()` started together → exactly one wins: either the outcome is recorded and `acquireLease()` resolves `null`, or `acquireLease()` resolves a fence and `recordAttemptOutcome` throws `ReviewLoopContractError` `lease-granted` (never `AssuranceFencedError`) with the terminal unrecorded, after which the same outcome with that fence (the R29 recovery) resolves `null` and records it |
| RLC-17 | `fence: null` is refused once a lease ever existed (R28 obligations 3, 7, 8; R32): `fixture.attemptOutcome` with `fence: null` and terminal `cancelled` → `ReviewLoopContractError` `lease-granted` (never `AssuranceFencedError`) and `persistedAttemptBytes` unchanged while the lease is held, again after `rotateFence()`, and again after `endLease()` (durable history, not the current lease state); for a `preLeaseAttempt()` whose `acquireLease()` succeeded, its `attemptOutcome` → `lease-granted` and unchanged, also after its `endLease()`; `buildRepairContextPack` with `prepareRepair()`'s input and `fence: null` → `ReviewLoopContractError` `invalid-input` and unchanged |
| RLC-18 | late grant (R29, R32), on a fresh subject with `preLeaseAttempt()`: `acquireLease()` resolves a fence `F` (the grant committed before the terminal write); `attemptOutcome` (`fence: null`) → `ReviewLoopContractError` `lease-granted`, never `AssuranceFencedError`, and `persistedAttemptBytes` unchanged; the same outcome with `fence: F` — the workflow's recovery after its lookup finds the lease — resolves `null` and records the terminal; its identical redelivery → `null` and unchanged; a later `fence: null` delivery → `lease-granted` and unchanged |
| RLC-19 | registration before effect (R28 obligation 1, R32), run by Lane A through `runRegistrationOrderingContract` against its workflow with at least these scenarios: a first attempt, a repair attempt, a cancellation before any lease, an `acquireLease` that fails or is aborted (the R29 path) and a worker crash followed by redelivery. In every scenario each `attempt-bound-effect` of an attempt comes after that attempt's `registration-reconciled` step. Negative fixture: the kit's own trace whose first step is an effect must be refused, or the case fails |

The two writing helpers check, in order: the envelope (`invalid-payload`, money included), the input rules
(`invalid-input`: slot version, lineage, a `fence: null` with a terminal outside `PRE_LEASE_ATTEMPT_TERMINALS`, a
`fence: null` for `buildRepairContextPack`), the scope (`not-in-scope`, also for an attempt the store never
registered), the caller's fence — or, for `fence: null`, the attempt's durable lease history under the attempt-row lock
(`ReviewLoopContractError` `lease-granted` if a lease ever existed: a late grant, not a supersession) — then the
recorded input for the attempt (identical: return the
stored output; different: `conflicting-redelivery`). The fence or history check, the comparison and the write share one
transaction, which also writes the idempotency record and the events; every refusal changes nothing. "Identical" means
deep-equal after removing `fence`, so the current holder after a takeover may redeliver the same facts.

`runWorkspaceResolverContract` cases, run by Lane A against its implementation over the lease table on real
PostgreSQL and by Lane B against its fake (exit E13):

| Case | Assertion |
|---|---|
| WRC-01 | the current holder `(attemptId, fence.leaseId, fence.fencingEpoch)` resolves to a workspace whose `leaseId` equals `fence.leaseId` |
| WRC-02 | the same query under `foreignScope` → `refused` / `not-in-scope` |
| WRC-03 | another lease id → `refused` / `lease-not-held` |
| WRC-04 | `fencingEpoch` one below or one above the current epoch → `refused` / `stale-epoch` |
| WRC-05 | after `endLease()` → `refused` / `lease-not-active` |

### 18.3 Obligations of the orchestration composition (SR-A1…SR-A14)

| ID | Obligation |
|---|---|
| SR-A1 | Call the slot after evidence persistence and before push; never at a verification stop. Map outcomes: PROCEED → push, PR with `prBodySectionRef` content, `WAITING_FOR_HUMAN_REVIEW`; REPAIR → new attempt; ESCALATE → push, PR flagged "assurance not satisfied", `WAITING_FOR_HUMAN_REVIEW`; BLOCK → no push, task `BLOCKED`. |
| SR-A2 | A repair attempt gets a fresh workspace at `repairBaseSha`; the orchestrator acquires that attempt's workspace lease, calls `buildRepairContextPack` with that lease's fence, and starts the agent with the ContextPack its `contextPackRef` references (the "task baseSha + apply diff" design is withdrawn, R3). |
| SR-A3 | Call `recordAttemptOutcome` at every attempt terminal, verification stops included: **every terminal is recorded** (R28), with the single exception below (R29, R32). An attempt that holds its lease is recorded with the fence of that lease as the caller holds it, **before** releasing the lease (R23); an `AssuranceFencedError` means the lease was taken over or ended, and the current holder records the terminal. An attempt that never held a lease is recorded with `fence: null` and a terminal in `PRE_LEASE_ATTEMPT_TERMINALS`; a `lease-granted` refusal is recovered under SR-A14. **Exception:** when the store cannot be read or written after the retry policy (a failed `findAttempt` or `findLease` lookup, or a failed pre-lease terminal write), the task ends `FAILED` with reason `attempt-state-unknown`, the audit entry carries the attempt's idempotency key, the terminal is not recorded, and telemetry completeness (exit J6) reports the attempt as a gap with that idempotency key. |
| SR-A4 | Pass `(risk) => slot.admitWithAssurance(risk, capability)` through the optional `admit` hook (SR-X1). |
| SR-A5 | Emit `workflow.recovered` through the shared `RunEventSink`. |
| SR-A6 | Do not emit `attempt.declared_complete`, `attempt.completed`, `review.completed`, `review.finding_dispositioned` or `repair.started`; Lane B's slot owns them, so no event is double-counted. |
| SR-A7 | Emit `task.completed` (with `outcome` and `repairCycles`) at task terminal; Lane B does not. |
| SR-A8 | Implement `AssuranceWorkspaceResolver` over the workspace-lease table and pass `runWorkspaceResolverContract` on real PostgreSQL (R18). |
| SR-A9 | Carry the activity's logical time (the workflow time at scheduling) in the activity input; the context adapter's `now()` returns it on every redelivery of that execution (R15). |
| SR-A10 | When the assurance activity fails after its retry policy, or non-retryably: audit `assurance-unavailable`; shadow mode → continue as PROCEED with no section; gating mode → ESCALATE; never `FAILED`; call `recordAttemptOutcome` with `assuranceUnavailable: true` and `adjudicationId: null` (R19). |
| SR-A11 | Pre-lease obligations of the composition (R28 1, 2, 5): register the attempt before any attempt-bound effect; acquire a workspace lease under the lock on the attempt row that `recordAttemptOutcome` also takes, and refuse acquisition for an attempt that already has a terminal. Pass RLC-16, RLC-17 and RLC-18 with a fixture whose `acquireLease` is the composition's own acquisition, and RLC-19 (`runRegistrationOrderingContract`) against the workflow. |
| SR-A12 | Before hand-off, list every path on which an attempt is registered and never leased, with the terminal it emits; any terminal outside `PRE_LEASE_ATTEMPT_TERMINALS` goes back to the controller (R28). |
| SR-A13 | Money at the seam is integer micro-USD (R28): `budgetRemaining.costMicroUsd` from the workflow's integer ledger, `cost.modelCostMicroUsd` and `cost.computeCostMicroUsd` as the adapter converted them (once, with ceiling); never a floating USD value. |
| SR-A14 | Late grant (R29, R32). When `acquireLease` fails or is aborted the grant may have committed: run the non-cancellable `findLease(attemptId)` lookup. Found: record the terminal with that lease's fence, then release. Not found: record it with `fence: null`; if that write raises `ReviewLoopContractError` `lease-granted` (a grant committed between the lookup and the write), look up again and record with the fence found — at most two lookups, because a recorded terminal refuses any later grant and a lease in history never disappears. A lookup that fails after its retry policy, or a pre-lease terminal write that fails after it, ends the task under SR-A3's exception. |
| — | Activity policy: heartbeat timeout ≥ 60 s; retry transient errors; never retry `ReviewLoopContractError` (any code) or `AssuranceFencedError` within the same delivery; code `conflicting-redelivery` maps to a non-retryable activity failure (R23); code `lease-granted` maps to a typed non-retryable result that the workflow handles under SR-A14, never to supersession (R32); on `AssuranceFencedError` the attempt is superseded under Lane A's lease-takeover semantics. |

### 18.4 Other S0 items Lane B depends on (R4, R5)

```typescript
// packages/ports/src/index.ts (S0, R4) — shared append-only event sink.
import type { RunEvent, TenantScope } from '@asep/contracts';

export interface RunEventSink {
  /**
   * Idempotent on event.eventId within the scope: the same id with identical canonical
   * bytes returns { appended: false }; the same id with different bytes throws
   * RunEventConflictError. The event is validated against run-event 1.2.0 before insert.
   */
  append(scope: TenantScope, event: RunEvent): Promise<{ readonly appended: boolean }>;
}

export class RunEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunEventConflictError';
  }
}
```

`run_events` (Lane A `0107`, R4 union, R15): composite key `(organization_id, project_id, event_id)`, composite FK
onto `runs`, `payload_sha256` with conflict on different bytes, append-only trigger rejecting UPDATE and DELETE, and
an index `(organization_id, project_id, event_type, occurred_at)`. Lane B adds nothing to that table and writes only
operational-run events to it. The only sink is Lane A's `adapters/persistence/src/run-events/**` (R15); Lane B owns
none, and benchmark, replay and corpus measurement never write to `run_events`.

Changes to the verbatim slot block since `3201335` (v3; P4-PLAN2-MED-001/002/004/005/007, R18, R19):

| Change | Why |
|---|---|
| file header states the envelope and the fixed-logical-time invariant; content-addressed artifacts carry no timestamp | R15 inside the block (MED-002) |
| `REVIEW_LOOP_MAX_PAYLOAD_BYTES`, `reviewLoopPayloadBytes`, `assertWithinReviewLoopEnvelope` | deterministic envelope error and a boundary case (MED-004) |
| `AssuranceFence.leaseEpoch` → `fencingEpoch` | one name for the value the resolver checks (R18) |
| `AssuranceWorkspaceResolver`, `AssuranceWorkspaceQuery`, `AssuranceWorkspaceResolution`, `AssuranceWorkspaceRefusal` | workspace seam (MED-001) |
| `BuildReviewPacketOutput.omissions` → `omittedFiles` (the list stays in the packet artifact) | a list that grows with the change no longer travels inline (MED-004) |
| `RepairContextInput.original: ContextPack` → `originalContextPackRef`; `RepairContextOutput.contextPack` removed | ContextPack by `ArtifactRef` only (MED-004) |
| `ProceedOutcome.shadow` and `BlockOutcome` doc: only PROCEED carries a shadow verdict | matches the DDL (MED-005) |
| `AttemptOutcomeInput.assuranceUnavailable` | assurance-activity failure is visible in telemetry (R19) |
| `createDisabledReviewLoopSlot` → `createDisabledAssuranceSlot`, documented as the literal opt-out, never a default | two default slots (MED-007) |
| conformance kit: fresh subject per case, `makeCtx(logicalTime)`, `pushGuardInput`, `persistedRoundBytes`, RLC-11…13; resolver kit WRC-01…05 | byte-comparing redelivery, shadow BLOCK, workspace refusals (MED-001/002/005) |

Each block version is extracted from this plan and type-checked as one module in a scratch directory outside the
repository with TypeScript 7.0.2 and the repository's base compiler options (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, declaration emit, `types: ["node"]`), **against the real built declarations** of
`@asep/contracts` and `@asep/ports` and the real `AdmissionResult` of `@asep/application` from this branch's
`tsc -b` output, with seeded negative controls that must fail, and its envelope helper is executed from the block
text on the RLC-01 fixtures. The v6 commands and results are in the review log ("Review v5", "Slot block type-check
and helper execution (v6)"); earlier versions' results are in the sections before it.

`run-event` 1.2.0 (R5), Lane B's part of the superset — one new `eventType` and optional fields:

| Addition | Type | Used by |
|---|---|---|
| eventType `review.finding_dispositioned` | enum value | authoritative yield / false-positive metrics |
| `reviewRound` | integer ≥ 1 | review, attempt and repair events |
| `reviewerConfigId` | string | dimension |
| `reviewerRole` | enum `primary, comparator, deterministic` | filter / dimension |
| `reviewMode` | enum `not-required, shadow, gating` | filter |
| `assuranceOutcome` | enum `PROCEED, REPAIR, ESCALATE, BLOCK` | `attempt.completed` |
| `shadowWouldBlock` | boolean | `attempt.completed` |
| `reviewFindingsUngrounded` | integer ≥ 0 | `review.completed` |
| `reviewFindingsBlocking` | integer ≥ 0 | `review.completed` |
| `reviewerFailed` | boolean | `review.completed` |
| `egressStopped` | boolean | `review.completed` |
| `reviewCostPriced` | boolean | cost coverage |
| `repairRound` | boolean | `attempt.completed` |
| `repairClosedAllBlocking` | boolean | `attempt.completed` |
| `findingId` | string | `review.finding_dispositioned` (dedupe key) |
| `findingValid` | boolean | `review.finding_dispositioned` |
| `findingDisposition` | enum `ACCEPTED, REJECTED, WAIVED` | `review.finding_dispositioned` |
| `dispositionActorKind` | enum `human, harness-rule` | `review.finding_dispositioned` |
| `findingSource` | enum `model, deterministic, sarif` | dimension |
| `findingSeverity` | enum `INFO, LOW, MEDIUM, HIGH, CRITICAL` | dimension |
| `reviewRoundCompletedAt` | string, `date-time` | `review.finding_dispositioned`: the cohort key (the disposed round's `review.completed` `occurredAt`) |
| `dispositionLatencyMs` | integer ≥ 0 | `review.finding_dispositioned` (disposition latency) |
| `assuranceUnavailable` | boolean | `attempt.completed` (R19) |

All additive (COMPATIBILITY.md: optional property and enum value → MINOR).

---

## 19. Shared-surface change requests

Lane B edits none of these during planning. S0 items are authored here and landed by Lane A (§18). Every other
request lands in a Lane B slice after the rebase onto S0, unless noted.

### 19.1 S0 (Lane A lands; content from this plan)

| ID | Item |
|---|---|
| SR-S0-1 | `packages/application/src/review-loop/{slot.ts, disabled-slot.ts, review-loop-contract.ts}` + export lines (§18 "Review-loop slot contract (verbatim for S0)" v6 and §18.2): the slot, the envelope helper, the workspace resolver port, the disabled slot, the slot kit (RLC-01…18), the registration-ordering kit (RLC-19), the resolver kit (WRC-01…05) and the scripted slot |
| SR-S0-2 | `RunEventSink`, `RunEventConflictError` in `packages/ports/src/index.ts` (§18.4) |
| SR-S0-3 | Lane B's `run-event` 1.2.0 additions (§18.4) inside the single superset bump |
| SR-S0-4 | `run_events` DDL union in Lane A's `0107` (§18.4); Lane B's `0201_run_events` is withdrawn |

### 19.2 `packages/ports/src/index.ts` (Lane B slice S2)

| ID | Change | Compatibility |
|---|---|---|
| SR-P1 | `ReviewerProvider`, `ReviewerDescriptor`, `ReviewerBudget`, `ReviewerExecuteRequest`, `ReviewerUsage`, `ReviewerObservationStatus`, `ReviewerObservation` (full TS: architecture §6) | additive |
| SR-P3 | `ReviewSourceReader`, `ReviewBlob` | additive |
| SR-P4 | `@deprecated` on the Phase 1 `ReviewProvider`; no removal | none |

(SR-P2 moved to S0 as SR-S0-2.)

### 19.3 `packages/contracts/**` (S1)

| ID | Change | semver / compat |
|---|---|---|
| SR-C1 | New `review-record.schema.json` (`$id …/review-record/v1`, 1.0.0) — fields in data model §2.2 | new logical contract |
| SR-C2 | New `review-finding.schema.json` (`…/review-finding/v1`) — data model §2.1 | new logical contract |
| SR-C4 | New `review-packet/v1`, `adjudication-record/v1`, `repair-order/v1` with valid + invalid fixtures, templates where the pattern needs them, `snapshots/v1` entries | new logical contracts |
| SR-C5 | `run-event` 1.2.0 — **moved to S0** (SR-S0-3) | MINOR |
| SR-C6 | `architecture-invariant` 1.1.0: optional `check { kind: "forbidden-import", fromGlobs, specifierPattern }` | MINOR |
| SR-C7 | `src/base.ts` `AttemptStatus` += `UNDER_REVIEW`, `CHANGES_REQUESTED` | additive union |
| SR-C8 | `src/validate.ts` `ContractName` += the five names; header comment count; regenerated `src/generated.ts`; `COMPATIBILITY.md` contract count for Lane B's additions only (no cross-lane total, R7) | follows SR-C1…C6 |
| — | SR-C3 (per-major compat-gate snapshots) **withdrawn** with D-1 (b); `review-report/v1` and `finding/v1` untouched | — |

### 19.4 Migrations (`adapters/persistence/src/migrations.ts`, Lane B range `0200`–`0299`, S8)

| ID | Migration | Content (full DDL in data model §3) |
|---|---|---|
| SR-M1 | `0200_assurance_reviews` | `review_rounds`, `review_records`, `review_findings`, `finding_dispositions`, `adjudications`; guard trigger functions; `attempts_id_task_scope_uq` |
| SR-M2 | `0201_run_events` | **withdrawn** (R4); id `0201` is reused below |
| SR-M3 | `0201_metric_snapshots` | `metric_snapshots` |
| SR-M4 | `0202_attempt_review_states` | replace `attempts_status_check` with the Phase 2 values plus `UNDER_REVIEW`, `CHANGES_REQUESTED` (Lane B owns this constraint, R6; Lane A owns `tasks.status`) |

`reviewer_promotions` is removed (deferred, DF-2). Rollback SQL for each migration is in data model §3.6.

### 19.5 Fencing primitive (Phase 2, Lane R) — CR-F1

§16: reviewer call as a qualified side-effect operation with a closed result shape, and an in-transaction fence
check usable by Lane B repositories. Stated by invariant until Phase 2 is accepted (R1).

### 19.6 Composition root

`apps/control-plane-api/src/production-root.ts`: **no change** (R10). Lane B adds the sibling `assurance-root.ts`;
Lane A imports it at integration time.

### 19.7 Required suites and gates

- SR-T1 `scripts/lib/canonical-tests.mjs` `REQUIRED_SUITES` += the unit suite ids in exit criteria
  §"Suite registry" (append-only, R10). Each slice's integration part appends its own ids (§21.2); the nine ids of
  S3–S7 were appended early, in the pure-core commits, and stay (recorded in the review log).
- SR-T2 `scripts/integration/lib.mjs` `REQUIRED_ITEST_SUITES` += the itest suite ids there.
- SR-T3 **Proof manifest over both runners** (v1 MED-001 partial, P4-PLAN2-MED-003, R18). `scripts/run-canonical-tests.mjs`
  (+ `canonical-tests.mjs`) **and** `scripts/integration/run-integration.mjs` (+ `lib.mjs`) each add a JUnit
  reporter to a temp file next to their existing stdout reporter (`--test-reporter` / `--test-reporter-destination`
  pairs, research register §5) and run one shared, registered post-run proof check
  (`scripts/lib/proof-manifest.mjs`, new). Lane B registers the exit-criteria proof check: every `unit` row's test
  names must appear as **passed** in the canonical runner's report and every `itest` row's in the integration
  runner's report; missing, skipped, todo or failed is red. A row whose proof is conditional names its condition
  (only G8's live round trip, required when `ASEP_REQUIRE_LIVE_REVIEWER=1`); the live reviewer's optionality is a
  policy test that always runs and passes or fails on its own, never a runner skip (exit G8). Generic; Lane A may
  register its own check.
- SR-T4 `scripts/integration/{images.mjs, lib.mjs, run-integration.mjs}`: a digest-pinned Grafana container with
  the committed provisioning mounted read-only, health-gated on `GET /api/health`, torn down in `finally`; its
  base URL exported to itests. Digest recorded in S18 (not verified in this session).
- SR-T5 `scripts/verify-all.sh`, `.github/workflows/**`: **no change**. Mutation proofs run as a required unit
  suite inside the canonical runner (S23). The live benchmark never runs in CI.

### 19.8 Root build files and dependencies

- **No new third-party dependency** (Node global `fetch`; `ajv` 8.20.0 already pinned in `@asep/contracts`).
- New workspace packages `adapters/reviewer-openai`, `adapters/reviewer-replay` → root `tsconfig.json`
  references; `pnpm-lock.yaml` workspace-link importers only; `pnpm-workspace.yaml` unchanged.
- `evals/package.json`: workspace deps on `@asep/application`, `@asep/reviewer-openai`, `@asep/reviewer-replay`;
  scripts `review-bench:capture`, `review-bench:score`.

### 19.9 `docs/platform/metrics-dictionary.yaml` and its loader

- SR-D1 new metrics: `review_adjudication_coverage`, `review_ungrounded_rate`, `reviewer_failure_rate`,
  `review_egress_stop_rate`, `shadow_would_block_rate`, `review_cost_coverage`, `mean_review_cost_usd`,
  `review_disposition_latency_ms`, `repair_success_rate` and `review_escalation_rate` (the last two `null` in
  Phase 4 production: no gating). Definitions in data model §5.
- SR-D2 `review_finding_yield` and `review_false_positive_rate` numerators move to
  `review.finding_dispositioned` (human actor, latest per `findingId`, cohort of the disposed round); denominators
  unchanged; dictionary `version` 1.0.0 → 1.1.0. Nothing computes these metrics today, so no consumer breaks.
- SR-X6 `packages/observability/src/metrics.ts`: accept and validate the optional operand keys
  `dedupeLatestBy: <RunEvent field>` and `cohortBy: <RunEvent date-time field>` (the operand's window filter uses
  that field instead of `occurredAt`, §15); coordinate with Lane A's dictionary-validator change (CR-19).

### 19.10 Other existing modules

| ID | File | Change |
|---|---|---|
| SR-X1 | `packages/application/src/governed-execution.ts` | optional `admit?: (risk: RiskLevel) => AdmissionResult` on `GovernedExecutionInput`; default `admitRisk`; byte-identical behaviour when absent (R3) |
| SR-X2 | `packages/domain/src/operational.ts` | attempt edges `COMMITTED → UNDER_REVIEW → PUSHED`, `UNDER_REVIEW → CHANGES_REQUESTED` (terminal), `UNDER_REVIEW → BLOCKED`; `COMMITTED → PUSHED` kept |
| SR-X3 | package `index.ts` files of application, policy, observability, git-worktree, persistence | append-only export lines (R10); owners in §21.2. The policy and domain lines were appended early, in `040ee5e` and `723b3f4` (recorded in the review log) |
| SR-X4 | `scripts/forbidden-imports.test.ts` (or its AST successor, R8) | no `@temporalio/*` in Lane B paths; no global `fetch`/`WebSocket` calls in domain/application; no `process.env` in `adapters/reviewer-*`; production entry points never import `assurance/drill`; each with a seeded self-check |
| SR-X5 | `compose.yaml` | mount `deploy/grafana/provisioning` read-only into the Grafana service (R9) |
| SR-X7 | `attempts` table (via Lane B's `0200` in `adapters/persistence/src/migrations.ts`) | add `attempts_id_task_scope_uq unique (id, task_id, organization_id, project_id)` so review rounds can prove attempt ∈ task at the DB; additive, no Phase 2 or Lane A column touched |
| SR-X8 | `evals/tsconfig.json` | `include` += `review-corpus/**/*.ts` (S19 pure core: no new dependency edge, the corpus code imports only `node:` builtins); `include` += `review-benchmark/**/*.ts` and `references` += application and the reviewer adapters (S20 integration, after S0/S1) |
| SR-X9 | `packages/policy/src/policy-source.ts` | `readPolicyFile(file): Buffer`, the raw bytes the review-policy loader hashes; `loadYaml` reads through it (behaviour unchanged). Landed early in `040ee5e` (recorded in the review log) |

### 19.11 Requests to the controller

| ID | Request |
|---|---|
| SR-G1 | (replaced by R12) No tags of pre-rewrite SHAs. The corpus carries content-addressed excerpts; full re-derivation needs the private bundle, whose path the controller passes to the verifier when it runs it. |
| SR-G2 | (per R13) For the live run only: reviewer gateway base URL and credential supplied to the composition root's credential source; `ASEP_REQUIRE_LIVE_REVIEWER=1` when the live test must be required. |
| SR-G3 | Approve the preregistration (`evals/review-benchmark/preregistration.json`: protocol, floors, matcher, corpus manifest hash, both reviewer configuration hashes) by committing it or recording its sha256 in the review log before any capture. The approval is procedural, not cryptographic; a lane cannot produce it. |

---

## 20. Directory ownership (Lane B, exclusive)

```text
packages/application/src/assurance/**                    step use cases, slot implementation, drivers, drill support, tests
packages/domain/src/assurance.ts, assurance.test.ts      finding lifecycle, closure authority, review-round machine
packages/policy/src/review.ts, review.test.ts            review policy loader, families, egress classification, D-2 rule
packages/observability/src/metric-eval.ts, metric-eval.test.ts, dashboards.test.ts
policies/review-policy.yaml
adapters/reviewer-openai/**                              Responses reviewer + credential source (new package)
adapters/reviewer-replay/**                              recorded + scripted reviewers (new package)
adapters/persistence/src/assurance/**                    repositories, snapshot store, itests (no run-event sink, R15)
adapters/git-worktree/src/review-source.ts, review-source.test.ts
adapters/agent-claude/src/reviewer-credential-isolation.test.ts
apps/control-plane-api/src/assurance-root.ts, assurance-root.test.ts
apps/control-plane-api/src/assurance/**                  CLI, loop + dashboard itests, rehearsal
evals/review-corpus/**                                   manifest, content-addressed excerpts, verifier
evals/review-benchmark/**                                protocol, preregistration, capture, scorer, suites, recordings, scorecards
deploy/grafana/**                                        provisioning + dashboard JSON
scripts/assurance-mutation-proofs.test.ts, scripts/assurance-mutation-proofs.json
docs/implementation/phases/phase-04-*.md
```

Not owned by either lane after S0: `packages/application/src/review-loop/**` (S0; changes need reconciliation).
Lane A's plan was read read-only from its committed tree at `80bb76a`; no path above appears in it.

---

## 21. Slices (one per future commit)

Each slice: read its exit criteria → tests first where sensible → smallest change → slice gate (`pnpm verify:all`;
plus `pnpm test:integration` when it adds or changes an itest) → review the diff → commit. "Pre-S0" slices touch
only Lane B-owned paths, and since v3 only their **pure-core part** lands before S0 (§21.1). "After P2" means after
the rebase onto accepted Phase 2. Every slice is independently revertible. Mutation-proof entries follow the owner
rule of §21.2.

| Slice | Deliverable | Acceptance checks (executable) | When | Commit |
|---|---|---|---|---|
| S1 | SR-C1/C2/C4/C6/C7/C8 | new fixtures accept/reject; compat gate classifies `architecture-invariant` as MINOR; `review-report/v1` and `finding/v1` schema and snapshot bytes unchanged (digest test); drift guard; templates validate | after S0 | `feat(contracts): add review record, finding, packet, adjudication and repair contracts` |
| S2 | SR-P1/P3/P4 | typecheck; structural compile test for the deprecated port | after S0 | `feat(ports): add packet-only reviewer and review-source ports` |
| S3 | `review-policy.yaml` + loader | YAML↔TS parity; unknown family fails closed; implementer-family reviewer rejected; comparator must differ from primary family; **loader rejects `gating`**; D-2 rule table (R1 + promoted → no human review required; R1 unpromoted → required; R2 promoted → still deferred); approval/verification matrices byte-unchanged | pure core pre-S0; integration after S0 (§21.1) | `feat(policy): declare reviewer independence, egress classification and shadow-only modes as data` |
| S4 | finding lifecycle + closure authority + review-round machine; SR-X2 | table-driven transitions; raiser cannot verify; model cannot waive/refute grounded HIGH/CRITICAL; waiver needs human + rationale + expiry; `closure-without-change` | pure core (domain file) pre-S0; SR-X2 and integration after S0 (§21.1) | `feat(domain): finding lifecycle with closure authority and review-round states` |
| S5 | packet builder (incl. execution manifest), prompt renderer, independence checks | canaries in coder self-report never reach packet, prompt or request bytes; identical bytes across builds; nonce derivation; over-budget flagged, never cut; manifest carries command, exit code, environment digest, raw refs, scanned bounded excerpts | pure core pre-S0 (frozen local DTOs); integration after S0/S1/S2 (§21.1) | `feat(assurance): build an independent review packet with an execution manifest` |
| S6 | push guard, egress decision, false-green checks, Trojan Source, dependency/invariant checks, SARIF | seeded violation per check; secret-pattern parity; each egress stop kind; seeded false-green cases (zero tests, added skip, exit-code mismatch, missing check) all caught; each SARIF log one blocking `sarif-unparsed` finding (R37) | pure core pre-S0; integration after S0/S1 (§21.1) | `feat(assurance): deterministic push guard, egress decision and false-green checks` |
| S7 | grounding, adjudication rule table, closure authority, repair order | every rule row × {gating, shadow}; shadow never yields REPAIR/ESCALATE; out-of-packet citations refuted; repair order bounded and anchored | pure core pre-S0; integration after S0/S1 (§21.1) | `feat(assurance): grounding, adjudication and closure authority` |
| S8 | SR-M1/M3/M4, repositories, fenced decision writes, snapshot store | PGlite + real PG: migrations apply once and stay in range; tenant IDOR rejected; append-only and final-record triggers; shadow check constraint; disposition actor constraints; a finding's state is hydrated only from its recorded dispositions, and a stored state no recorded disposition chain reaches is refused (R40); `metric_snapshots` versions append-only; fence: new owner completes after handoff, old owner fenced, concurrent claim one winner | after P2 + S0 | `feat(persistence): persist review rounds, findings, dispositions and adjudications under fencing` |
| S9 | `ReviewSourceReader` | real temp repos: exact range diff; binary/too-large/submodule/deleted/non-UTF-8 reported, never dropped; traversal rejected | after S0 | `feat(workspace): trusted range diffs and post-images for review` |
| S10 | `adapters/reviewer-openai` + credential source + request-byte egress re-check | fake HTTP server rows for every adapter MUST; exact request body asserted; credential canary absent; rotation on 401; expiry refresh; no `process.env` in adapter source; gateway-alteration detection (returned `instructions` vs sent, usage attribution) recorded per call against a fake gateway that mimics the injection; opt-in probe of primary (`gpt-6.1-sol`) and comparator records the gateway's behaviour and confirms detection live | after S0 | `feat(reviewer): OpenAI-compatible Responses reviewer with an injected credential source` |
| S11 | `adapters/reviewer-replay` | exact replay by request hash; miss and manifest mismatch fail closed; scripted provider marked fake | after S0 | `feat(reviewer): deterministic replay and scripted reviewers` |
| S12 | step use cases `planAssurance`, `buildReviewPacket`, `runDeterministicChecks`, `runReviewer`, `adjudicateRound` (application, against fakes) | JSON round trip within the envelope; zero provider calls on push-guard BLOCK and on every egress stop; crash at each step boundary converges with byte-identical records (fixed logical time); the workspace comes only from the resolver and every refusal stops the step before any read (E13); resolver kit WRC-01…05 on the fake; parallel reviewers blind; priors reach adjudication only as hydrated from their recorded dispositions (R40) | after S0 | `feat(assurance): idempotent assurance step use cases` |
| S13 | `createAssuranceSlot` (composite, `recordAttemptOutcome`, `admitWithAssurance`, `buildRepairContextPack`, event emission); SR-X1 | conformance kit RLC-01…18 on PGlite (helper fencing, redelivery, pre-lease terminals, the late grant and the atomicity case included); events per §15 with deterministic ids; repair ContextPack by `ArtifactRef` with `generatedAt` from the REPAIR decision; `admitWithAssurance` equals `admitRisk` for production capability; governed-execution suite unchanged | after S0 | `feat(assurance): implement the review-loop slot and attempt-outcome events` |
| S14 | `runAssuredTask` sequential driver + durable-shaped fake | shadow mode changes no workflow decision except BLOCK; drill gating loop bounded by `maxRounds`; activity-granular fake converges under retries, cancellation and a lease handoff | after S0 | `feat(assurance): sequential proof driver and activity-granular fake` |
| S15 | `assurance-root.ts` + CLI (`asep assurance report`, disposition entry for humans) | fail-closed config; gating unreachable from production composition (policy with `gating` refused); credential source injected; disabled-reviewer literal | after S0 | `feat(control-plane): compose the independent reviewer behind a fail-closed root` |
| S16 | **assurance-only** loop itest | real PG + Git + sandbox + real adapter vs local fake HTTP: shadow PROCEED with recorded wouldBe; push-guard BLOCK with zero gateway requests and zero forge calls; each egress stop with zero gateway requests; drill composition: REPAIR → re-review closed by the other reviewer → PROCEED, raiser-only closure → ESCALATE at max rounds; conformance kit on real PG | after P2 + S0 | `test(control-plane): assurance-only loop on real backends` |
| S17 | metric evaluator + versioned snapshot recompute (incl. `dedupeLatestBy`, `cohortBy`); SR-D1/D2, SR-X6 | golden values; review day 1, accept day 2, reject day 3: the day-1 cohort gains a new snapshot version each time, earlier versions retained, day-2/day-3 windows unaffected; disposition latency per cohort; harness refutations excluded from yield; nulls carry reasons | after S0 | `feat(observability): evaluate dictionary metrics from events and human dispositions` |
| S18 | Grafana provisioning + SR-T4 + SR-X5 | itest: Grafana `GET /api/health` ok; data source by uid loads; every dashboard by uid loads; every panel query via `POST /api/ds/query` returns the snapshot values the S16 run produced | after S0 | `feat(observability): provision assurance dashboards and load them in the integration gate` |
| S19 | `evals/review-corpus` manifest + content-addressed excerpts + verifier | every claim verified (reachable SHAs against git; excerpt hashes; fix-commit subjects; review-doc lines); exclusions enumerated; no pre-rewrite ref created; excerpts pass publication gates; bundle mode verified when the controller supplies the path | pure core (provenance, excerpts) pre-S0; freeze after §7.8 is confirmed; integration after S0 (§21.1) | `feat(evals): content-addressed self-history defect corpus` |
| S20 | protocol, preregistration file, matcher, scorer, baselines, injection and false-green suites, floor evaluation | rescoring is byte-identical; scorer refuses fake recordings and any `eligibleForPromotion` other than false for self-history; capture refuses a preregistration mismatch; Wilson intervals; suite `INVALID_CONTROL` state; golden historical item (§7.8) | pure core after §7.8 is confirmed; integration after S0/S1 (§21.1) | `feat(evals): pre-registered rediscovery protocol and deterministic scorer` |
| S21 | live capture (primary + comparator, k = 3 on reporting items), scorecards, `phase-04-report.md` | recordings and manifests committed; controller rescoring is byte-identical; report fields generated from scorecards and gate logs | after SR-G2/SR-G3 | `docs(phase-4): record descriptive reviewer measurement on self-history` |
| S22 | real-coder shadow round | one real `CodingAgentProvider` attempt (accepted Phase 2 runtime) through a shadow round on real backends; evidence committed | **blocked** until the Phase 2 agent-runtime repair is accepted | `test(control-plane): real coder attempt through a shadow assurance round` |
| S23 | SR-T3 proof check + mutation proofs | every MUST-mapped test passed per the JUnit manifests of the canonical and the integration runner; the live-reviewer policy test runs on every gate; each seeded mutation (data in `scripts/assurance-mutation-proofs.json`) turns its mapped test red in a temp copy; the unmutated control passes; a mutation whose search text does not match exactly once fails the suite | after S0 (both runners); entries per the owner rule of §21.2 | `test(assurance): proof manifest and seeded mutation proofs for key guards` |
| S24 | runbook + executable rehearsal | 429 storm, 503, malformed outputs, cost budget exceeded, served-model drift, credential expiry/rotation, egress stop and reviewer disabled each reach the documented decision on real mechanisms | after S15 | `docs(phase-4): assurance runbook and executable fault rehearsal` |

### 21.1 Pre-S0 staging: pure core and integration (P4-PLAN2-HIGH-001, R18)

A slice's **pure core** touches only Lane B-owned paths (§20), imports only packages it already depends on, and
types its boundary with the frozen stand-ins in `packages/application/src/assurance/local-types.ts` (copies of the
S0 slot vocabulary, the S1 contract shapes and the S2 port shapes as this plan specifies them). Its **integration
part** binds those stand-ins to the landed types, appends package exports and suite registrations, and wires
build references; it lands after S0 (and S1/S2 where named). A slice counts as accepted only when both parts have
landed and the integration part's checks pass.

| Slice | Pure core (pre-S0) | Integration (after S0; S1/S2 where named) |
|---|---|---|
| S3 | `policies/review-policy.yaml`; `packages/policy/src/review.ts` loader, family resolution, independence, shadow-only validation, D-2 rule; tests — `040ee5e` | `packages/policy/src/index.ts` export lines, `policy-source.ts` `readPolicyFile` (SR-X9) and the `review-policy` suite id: **landed early in `040ee5e`**, kept (append-only lines, no forbidden surface; recorded in the review log); config-hash freeze for preregistration (S20) |
| S4 | `packages/domain/src/assurance.ts`: lifecycle, closure authority, waivers, review-round and review-record machines; tests — `723b3f4` | `packages/domain/src/index.ts` export lines and the `finding-lifecycle` suite id: **landed early in `723b3f4`**, kept; SR-X2 attempt edges in `operational.ts`; `AttemptStatus` (S1); DB enforcement (S8) |
| S5 | canonical JSON, execution manifest (test-summary parsers, excerpt tails), whitelist packet builder, prompt renderer over local DTOs — `f6ca91d` | replace the packet, finding, blob and slot stand-ins in `local-types.ts` with `review-packet/v1`, `review-finding/v1` (S1), `ReviewBlob` (S2) and the S0 slot types, proven by a type-level assignability check and a fixture round trip through the S1 validator; the packet step reads through `ReviewSourceReader` with a workspace from `AssuranceWorkspaceResolver` (S12); suite ids **landed early** |
| S6 | secret patterns, diff parser, push guard, egress decision and `sendIfCleared`, false-green, Trojan Source, dependency and invariant checks, SARIF — `7bcec5e`; plus the **check report** (canonical bytes, sha256, structural parser, summary counts) | bind invariant checks to `architecture-invariant` 1.1.0 (S1); SR-X4 fitness rules on the accepted Phase 2 AST framework (R8); persistence of the check report and zero-request proofs on the composed path (S12, S16); suite ids **landed early** |
| S7 | grounding, the A1–A11 rule table, closure decisions, repair order — `b2096d3`; plus the fence field `fencingEpoch` and waiver expiry at the round's opening time (§11) | bind records to `adjudication-record/v1`, `repair-order/v1`, `review-finding/v1` (S1); dispositions and DB closure constraints (S8); drill loop proof (S16); suite ids **landed early** |
| S19 | provenance collection from the review documents and git (finding ids, document lines, derived reviewed SHAs, fix commits, reachability with the R22 vocabulary and the bundle-dependent flag) and content-addressed excerpts with hash verification; publication gates that fail closed; provenance-level exclusions only (§7.5, §7.8) | packet-dependent eligibility, the `no-location` freeze rule, `corpusSha256` freeze and manifest after §7.8 is confirmed; bundle mode when the controller supplies the path; `review-corpus` suite id |
| S20 | after §7.8 is confirmed: matcher, category table, post-fix mapping, Wilson intervals, floors, the corpus builder variant whose execution is `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }` (the packet whitelist accepts `environment: null` only with `NOT_RECORDED`), golden item | scorer through the runtime grounding and packet code; `evals/tsconfig.json` include + references and `evals/package.json` deps (SR-X8, lockfile workspace links); preregistration (SR-G3); suite ids |

Work that landed early in the pure-core commits and is, by this staging, integration work: the `policy` and
`domain` index export lines (`040ee5e`, `723b3f4`), `readPolicyFile` in `policy-source.ts` (`040ee5e`) and nine
`REQUIRED_SUITES` ids (`040ee5e`…`b2096d3`). None touches a surface the lane contract forbids, all are append-only,
and none is reverted; the review log records them. From v3 on, a new pure-core test file lands unregistered (the
canonical runner discovers and runs every `*.test.ts` under `TEST_ROOTS`, `scripts/lib/canonical-tests.mjs:26-33`)
and its slice's integration part registers it.

### 21.2 Owners of shared Lane B files

| File | Owner | Rule |
|---|---|---|
| `packages/application/src/assurance/local-types.ts` | S5 (created); S6 and S7 add | frozen copies of this plan's shapes; never edited to diverge; each stand-in is deleted by the integration part that binds the real type |
| `packages/application/src/assurance/ports.ts` (application-local repository ports, architecture §6) | S12 creates (after S2) | S13 and S17 append; every write method takes `AssuranceFence` |
| contract schema files, fixtures and `snapshots/v1` entries for the five new contracts and `architecture-invariant` 1.1.0 | S1 | later changes need a new MINOR and the compat gate |
| the internal check report | S6 (`check-report.ts`) | a TypeScript structural parser plus its sha256; no JSON Schema file and no new dependency (data model §2.8) |
| package `index.ts` export lines | application: S13; policy: S3; domain: S4; observability: S17; git-worktree: S9; persistence: S8 | append-only (R10) |
| `REQUIRED_SUITES` | each slice's integration part, for its own suite ids (the S3–S7 ids landed early) | append-only (R10) |
| `REQUIRED_ITEST_SUITES` | S8, S16, S18 (S22) | append-only |
| `evals/tsconfig.json` | `include` `review-corpus/**`: S19 pure core; `include` `review-benchmark/**` and `references`: S20 integration | append-only |
| `evals/package.json` dependencies and scripts | S20 integration | after S0 (lockfile workspace links) |
| root `tsconfig.json` references for the new adapter packages | S10, S11 | after S0 |
| `scripts/assurance-mutation-proofs.json` and its suite | S23 creates both, after S0 | pre-S0 slices record their seeded mutations in their commit reports and S23 transcribes them; later slices append one entry per † row in their own commit |
| `scripts/lib/proof-manifest.mjs` (both runners' proof check) | S23 | generic; Lane A may register its own check |

---

## 22. Task DAG

`c` = pure core (pre-S0, Lane B paths only), `i` = integration part (§21.1). An edge `X → Y` means Y needs X.

```text
Pure core, before S0:
  S3c ──> S5c ──> S6c ──> S7c ──> S20c          policy → packet/checks → adjudication; runtime grounding → scorer
   └─────────────> S6c                          checks read the policy's egress and deny rules
  S4c ──────────────────> S7c                   closure authority
  S19c (provenance, excerpts) ─> S19 freeze ─> S20c       (both only after §7.8 is confirmed)
  S5c ──────────────────────────> S19 freeze             eligibility needs the packet builder

Integration, after S0:
  S0 ─> S1 ─> S2
  S1 ─> S3i, S4i, S6i, S7i                       bind the stand-ins to the landed contracts
  S1 + S2 ─> S5i                                 packet DTOs, ReviewBlob, WorkspaceCapability
  S2 ─> S9, S10, S11
  S5i + S6i + S7i + S9 + S10 + S11 ─> S12 ─> S13 ─> S14 ─> S15 ─> S16
  Phase 2 accepted ─> S8 ─> S13
  S16 ─> S17 ─> S18;  S16 ─> S18;  S15 + S16 ─> S24
  S20c + S1 + S5i + S7i ─> S20i ─> S21 <─ S10 + S11 (+ SR-G2, SR-G3)
  Phase 2 agent runtime + S16 ─> S22
  S0 ─> S23 (both runners); mutation entries per §21.2; the suite closes after S21
```

Acyclic. S19/S20 depend on no persistence. The scorer reuses the runtime grounding (S7) and packet builder (S5)
rather than a copy, which is why S20's integration part follows S5i and S7i.

---

## 23. Exit criteria and verdict vocabulary

The numbered, test-mapped MUST list is `phase-04-exit-criteria.md`. Verdicts:

| Verdict | Condition |
|---|---|
| `IMPLEMENTATION_COMPLETE_DESCRIPTIVE_SELF_HISTORY_ONLY_UNVALIDATED` | every MUST, including I1 (live primary + comparator measurement) and N1 (real-coder shadow round) |
| `IMPLEMENTATION_COMPLETE_ASSURANCE_ONLY_LOOP_DESCRIPTIVE_SELF_HISTORY_ONLY_UNVALIDATED` | every MUST except N1 (Phase 2 agent runtime not available) |
| `IMPLEMENTATION_COMPLETE_MEASUREMENT_PENDING_UNVALIDATED` | every MUST except I1 (and N1 if also unmet, with the `ASSURANCE_ONLY_LOOP` qualifier) |

Each carries `_UNREVIEWED` until the controller's independent final review accepts it. `COMPLETE` is **not
reachable** in Phase 4: a production-valid measurement needs DF-6. No verdict may be described as production-valid,
and none unlocks gating.

Every verdict block in the report carries a mandatory line naming the gateway, generated from the scorecards, for
example `MEASURED_VIA: kiro-proxy gateway (base URL sha256 <hash>) — alters requests (instructions appended, tools added; per-call
evidence in review records)`. A verdict block without it fails exit I9.

---

## 24. Rollback

Per-slice commits on the lane branch; `main` untouched until the controller merges. The slot is inert until Lane A
wires Lane B's implementation (Lane A's not-configured default and Lane B's literal opt-out both keep Phase 2
behaviour). Production mode is shadow, so reverting a Lane B slice restores
Phase 2 behaviour. Migrations are forward-only; the documented rollback for each is a forward compensating
migration (data model §3.6).

---

## 25. Blocking dependencies

1. **Phase 2 acceptance** (R1, ordering): S8 and S16 need the accepted fencing primitive; every shared-surface
   slice needs the rebase.
2. **Lane A S0**: every slice marked "after S0".
3. **Gateway credential and preregistration** (SR-G2, SR-G3): S21. Without them the verdict is
   `…MEASUREMENT_PENDING…`. Neither `gpt-6.1-sol` nor the comparator has been probed by the lane (not verified); the gateway's request alteration is verified by the controller (U-3).
4. **Phase 2 agent-runtime repair**: S22. Without it the verdict carries `ASSURANCE_ONLY_LOOP`.
5. **Pilot repository**: DF-6 only.
6. **Controller confirmation of v7**: the S19 freeze and every S20 part wait for it; the slot block is `HAND-OFF: READY` and its release to Lane A (G-LB) follows the controller's diff check against `023f16dc…` (§7.8, R18, R23, R28, R32, R37).

None blocks plan lock.

---

## Output

```text
PLAN_STATUS: LOCKED v7 (pending controller confirmation)
BASE_SHA: 00a68895d205122767167942326e2e0466571059 (Phase 2 not accepted)
REVIEWED_V1: a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f — Codex REQUEST_CHANGES 0.99 (1 CRITICAL, 8 HIGH, 5 MEDIUM, 1 LOW), all dispositioned
REVIEWED_V2: 32013356e0845354f40ac6f63925f928637d6fb3 — Codex gpt-6.1-sol lock-check REQUEST_CHANGES 0.97 (14/15 v1 folded, v1 MED-001 partial; new 2 HIGH, 8 MEDIUM), all dispositioned
REVIEWED_V3: 9e3a1c32e869193e981a867e8bb9fbd1abaec9c8 — Codex gpt-6.1-sol review of plan, slot block and pre-S0 code REQUEST_CHANGES 0.99 (all v2 findings folded; new 6 MEDIUM plan/slot, 6 HIGH + 3 MEDIUM + 1 LOW code, 1 surviving mutation), all dispositioned
REVIEWED_V4: 7cc20f474ef0d53532ff386777eae7d5d07dae24 — Codex gpt-6.1-sol re-check of plan v4, slot block and code fixes REQUEST_CHANGES 0.99, HAND-OFF NOT_READY (all v3 plan/slot findings folded; 7 code items resolved, 4 partial; new 1 HIGH + 2 MEDIUM plan, 2 MEDIUM slot, 3 HIGH + 2 MEDIUM code, 1 surviving mutation), all dispositioned
REVIEWED_V5: fb2e4323a61e128553043b08157f02c70a1684c9 — Codex gpt-6.1-sol re-check of plan v5, slot block and code fixes REQUEST_CHANGES 0.99, HAND-OFF NOT_READY (v4 severity, identity, budget and pattern fixes resolved; new 1 MEDIUM + 1 LOW plan, 1 HIGH + 1 MEDIUM slot, 3 HIGH + 1 MEDIUM + 1 LOW code, 1 surviving mutation, 1 mutant wrongly declared equivalent), all dispositioned
REVIEWED_V6: d0907b9afecd4c8e3527874e8b9ddd435978a8dc — Codex gpt-6.1-sol re-check of plan v6, slot block and code fixes REQUEST_CHANGES 0.98, HAND-OFF READY (v5 plan and slot findings folded; v5 code findings resolved except SARIF ingestion; new 1 LOW plan, 1 LOW slot, 2 HIGH + 2 MEDIUM code, 1 surviving mutation), all dispositioned
BASELINE: lane-observed at a2a7b8a — verify:all exit 0; tests 548 pass 548; 50 files; 28 required suites; compat 13 schemas
PLAN_FILES:
  - docs/implementation/phases/phase-04-plan.md
  - docs/implementation/phases/phase-04-architecture.md
  - docs/implementation/phases/phase-04-data-model.md
  - docs/implementation/phases/phase-04-exit-criteria.md
  - docs/implementation/phases/phase-04-risk-register.md
  - docs/implementation/phases/phase-04-research-register.md
  - docs/implementation/phases/phase-04-threat-model-delta.md
  - docs/implementation/phases/phase-04-review-log.md
  - docs/implementation/phases/phase-04-plan-review-codex-v1.md
  - docs/implementation/phases/phase-04-plan-review-codex-v2.md
  - docs/implementation/phases/phase-04-review-codex-v3.md
  - docs/implementation/phases/phase-04-review-codex-v4.md
  - docs/implementation/phases/phase-04-review-codex-v5.md
  - docs/implementation/phases/phase-04-review-codex-v6.md
NEW_THIRD_PARTY_DEPENDENCIES: none
GATING: shadow only in Phase 4 (user decision); gating/promotion/thresholds/R2 admission deferred
SLOT_BLOCK: v7 (R18, R19, R23, R28, R29, R32, R37) — HAND-OFF READY at d0907b9 (sha256 023f16dc…3a04d); v7 changes only the wording of the StatelessConformanceFixture doc comment (sha256 recorded in the review log); type-checked against the real built @asep/contracts, @asep/ports and AdmissionResult with 18 negative controls; envelope helper executed from the block text on the RLC-01 fixtures, money included; release to Lane A (G-LB) after the controller's diff check
SHARED_SURFACE_REQUESTS: §19 (S0 4, ports 3, contracts 6 (+ SR-C3 withdrawn, SR-C5 moved to S0), migrations 3 (+ 0201_run_events withdrawn), fencing CR-F1, gates 4 (both runners), dictionary 2 + loader, other 8, controller 3)
READY_FOR_IMPLEMENTATION: pure-core parts of S3–S7 and S19 (provenance and excerpts) per §21.1; S19 freeze and S20 after v7 confirmation; integration parts after Phase 2 acceptance, Lane A S0 and per-step controller release
```
