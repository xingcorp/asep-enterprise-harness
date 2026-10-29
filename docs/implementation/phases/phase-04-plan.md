# Phase 4 — Independent Assurance — Plan (LOCKED v2 (pending controller confirmation))

> Status: **LOCKED v2 (pending controller confirmation).** v1 (`a2a7b8a`) received an independent Codex plan
> review (`phase-04-plan-review-codex-v1.md`, REQUEST_CHANGES 0.99: 1 CRITICAL, 8 HIGH, 5 MEDIUM, 1 LOW). Every
> finding is dispositioned in `phase-04-review-log.md` and folded into this plan, the architecture, the data model,
> the exit criteria and the slice that proves it. The controller's shared-surface reconciliation
> (`reconciliation-v1.md`, R1–R14) is applied; where it and v1 disagreed, it won. User decisions D-2, shadow-only
> gating and the corpus scope are recorded in §3. No implementation code, tests, migrations or configuration are
> part of this step.
> Lane: **B** (parallel to Lane A / Phase 3 durable orchestration). Planner: Claude (Lane B session).
> Companion documents: `phase-04-architecture.md`, `phase-04-data-model.md`, `phase-04-exit-criteria.md`,
> `phase-04-risk-register.md`, `phase-04-research-register.md`, `phase-04-threat-model-delta.md`,
> `phase-04-review-log.md`, `phase-04-plan-review-codex-v1.md`.

```text
BASE_SHA:        00a68895d205122767167942326e2e0466571059   (head of phase/02-single-agent-vertical-slice; Phase 2 NOT yet accepted)
REVIEWED_V1:     a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f
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
run before S0 (§21 marks each slice).

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
architecture checks plus a SARIF subset; deterministic adjudication with closure authority; repair orders and
re-review **implemented and proven in drill compositions** (not active in production in Phase 4); the
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
2. **The labeller is the primary reviewer's model.** Almost every label came from Codex on `gpt-5.6-sol`, the
   proposed primary reviewer. Primary recall is partly circular; any other reviewer is penalised for real defects
   `gpt-5.6-sol` would not find. *Handling:* the mandatory different-family comparator (§7.6) runs on every item
   under the same protocol; recall is also reported on the **labeller-miss subset**; non-model baselines are
   reported; the circularity statement is a required scorecard field.
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

### 7.3 Guards against a dishonest measurement

| Dishonest move | Guard |
|---|---|
| Answer-key leakage (review documents, logs, fix-commit messages, or a tree containing the cycle's review doc — e.g. `3ea0293` adds the Phase 2 final review on top of reviewed tree `2e61f24`) | packets built from the reviewed SHA only; review artifacts and git metadata excluded by rule; leakage test (exit I2) |
| Tuning on reported items | protocol, matcher, floors, corpus manifest hash and both reviewer configuration hashes frozen in a **controller-approved preregistration** before any capture; capture refuses mismatches (exit I4) |
| Lenient or model-judged matching | deterministic matcher, strict and lenient variants, no model in scoring (exit I5) |
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
  consistency of the excerpts (bytes hash to their names; manifest hash), and items from unreachable trees are
  marked `provenance: excerpt-only`. The verifier takes the bundle path from an explicit argument supplied by the
  controller; Lane B never reads it on its own.

### 7.6 Comparator choice (D-4)

The gateway also serves `deepseek-v4-pro`, `qwen3.8-max` and `grok-4.6`. **Choice: `deepseek-v4-pro`.**

- Required property, met by all three: its family differs from both the implementer (`anthropic-claude`) and the
  labeller/primary (`openai-gpt`), so it can expose labeller bias rather than reproduce it.
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

---

## 8. Assurance round sequence

```text
[attempt N evidence persisted; resultSha = harness commit]                 (Phase 2 steps / Lane A workflow)
  → planAssurance             pure: risk + policy + registry → mode, reviewers (primary [+ comparator]), limits
  → buildReviewPacket         trusted sources only; canonical bytes; byte budget; never truncates silently
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

---

## 9. Independence model (ADR 0010)

1. **Packet-only input.** The reviewer receives one immutable `ReviewPacket`. The schema has no field for the
   coder's summary, limitations, session, events, ContextPack, PR body or commit messages. Allowed sources:
   EvidenceBundle (diff, **execution manifest**: per-check command, exit code, duration, environment digest, raw
   stdout/stderr artifact refs with bounded, scanned excerpts, parsed test summaries), WorkOrder, trusted range
   diffs and post-images, and — in re-review only — prior adjudicated findings in structured form.
2. **Different model family**, resolved from a policy registry by model id. A reviewer must differ from the
   implementer's family; the comparator must also differ from the primary's family; unknown family fails closed.
3. **Fresh request.** `store: false`, no `previous_response_id`, no `conversation`, no tools,
   `tool_choice: "none"`.
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
    `.env*`, key and certificate files, `secrets/`, credential files), or the project has not opted in to
    reviewer egress;
  - `STOP_UNSCANNABLE` — content that cannot be scanned (binary, non-UTF-8, over the per-file limit) at a path
    that is sensitive by classification; unscannable content elsewhere is omitted from the packet, never sent,
    and recorded as an omission;
  - `CLEAR` otherwise.
- `runReviewer` refuses to call unless the check report carries `CLEAR` for this packet's sha256, and then
  re-scans the **exact request body bytes** (instructions + rendered input) immediately before the provider call;
  a hit records `EGRESS_STOPPED` with zero requests.
- The push guard is separate and also runs before the gateway: a secret in **added** lines, a forbidden-path
  change, or an unscannable change at a sensitive path is `BLOCK` (D-5) and no reviewer is called.
- Proof: a fake gateway (unit) and a local fake HTTP server driven through the real adapter and composition (itest)
  receive **exactly 0 requests** for each stop kind (exit D1, D2).
- In shadow mode an egress stop is recorded (`reviewerFailed`, `egressStopped`) and the round proceeds; in drill
  gating it escalates `egress-stopped`.

### 10.2 Credential (R13, P4-PLAN-MED-004)

The reviewer adapter runs in the harness process, never in the agent container. `assurance-root.ts` (composition
root) builds a `ReviewerCredentialSource` from controller-supplied configuration and injects it; adapter code reads
no process environment (fitness rule, exit C5). The source returns `{ value, expiresAt, version }`; the adapter
re-fetches before `expiresAt` minus skew and never holds a value longer than `maxCredentialAgeMs` (policy, proposal
15 minutes) even when the source reports no expiry; on HTTP 401 it invalidates, re-fetches once and retries once
(rotation), then fails `AUTH_ERROR`. The value appears only in the `Authorization` header and never in an artifact,
log, error text or row (canary test). The controller supplies base URL and credential only for the opt-in live run;
when it sets `ASEP_REQUIRE_LIVE_REVIEWER=1`, the live production-path test is required and its absence fails.

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
measured with k runs. A gateway that alters prompts in transit would break the equality "recorded request = model
input"; the controller's notes suggest the gateway injects a style instruction (not verified by Lane B), so every
measurement claim is bounded to "via this gateway" (risk PR4-30).

---

## 12. Adjudication rules (deterministic, versioned)

Evaluated in order; the first matching rule decides. `B` is the blocking set: deterministic findings with a
blocking disposition plus grounded model findings whose severity is in `blockingSeverities[risk]` and whose
lifecycle state is still blocking (§13). Production compositions can only produce the **Shadow** column.

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
`docs/platform/verification-and-review.md:31`) and counted as a verdict/finding mismatch; findings are unioned
and de-duplicated by fingerprint per raiser; a model can never waive or refute a grounded HIGH/CRITICAL finding
(`docs/architecture/04-state-machines.md:48`); only an ungrounded finding can be machine-refuted (reason
`citation-unresolvable`). The persisted `adjudications` row enforces "shadow ⇒ PROCEED or BLOCK" with a check
constraint (data model §3).

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
    family against the implementer, reporting `RESOLVED` with a grounded resolution citation inside the repair
    delta; (b) a named human disposition; (c) for deterministic findings only, the same deterministic check no
    longer firing on the new tree.
  - A `RESOLVED` claim whose cited file was not touched by the repair delta stays `OPEN`
    (`closure-without-change`).
  - Deterministic red→green proof for model findings is deferred (DF-7).
- `maxRounds` per risk = 2 (D-7; matches Phase 2 practice, `phase-02-risk-register.md:23` PR2-16).
- In Phase 4 production none of this runs: mode is never gating. It is proven by unit tests, the conformance kit,
  the drill itest (S16) and measured offline on residual-instance corpus items (rule C).

---

## 14. Architecture, security and false-green checks

1. **Push guard (pure):** secret patterns over added lines (parity with `scripts/lib/secret-patterns.sh`);
   changes to `forbiddenChanges` or outside `allowedPaths`; unscannable change at a sensitive path. `BLOCK`.
2. **Egress decision:** §10.1.
3. **False-green checks (P4-PLAN-HIGH-008):** `exit-code-verdict-mismatch` (a check recorded passing while its
   raw exit code is non-zero — an evidence-reduction defect; `EVIDENCE_INTEGRITY`, HIGH); `required-check-missing`
   (an acceptance check id of the WorkOrder absent from the evidence); `zero-tests-executed` (a unit/integration/
   acceptance check exits 0 while its parsed test summary reports 0 tests; parsers for node:test, TAP, Vitest and
   Jest summaries; an unparsed format is recorded `testSummary: null`, not guessed); `skipped-tests-introduced`
   (added `.skip(`, `xit(`, `describe.skip`, `test.skip`, `@Disabled`, `pytest.mark.skip`, `t.Skip(` in test
   files); `test-file-deleted`. In Phase 4 these are reported findings (PR section, metrics), blocking only in
   drill gating.
4. **Trojan Source:** bidirectional and zero-width Unicode in added lines → SECURITY finding.
5. **Dependency and invariant checks:** manifest/lockfile changes flagged; `ArchitectureInvariant` 1.1.0
   `forbidden-import` rules over added import specifiers.
6. **Project tools via SARIF 2.1.0 subset** from L4/L5 artifacts; malformed SARIF fails closed.
7. Raw check output is stored before any reduction (ADR 0009).

---

## 15. Measurement and dashboards

- **Event ownership** (§18.4): Lane B emits `attempt.declared_complete`, `attempt.completed`, `review.completed`
  (one per review source per round: each model reviewer record and one deterministic record),
  `review.finding_dispositioned` and `repair.started`, through the shared `RunEventSink` into Lane A's
  `run_events` (R4). Lane A emits `workflow.recovered`, `task.*`, `run.*` and control events.
- **Authoritative review metrics (P4-PLAN-HIGH-004).** `review_finding_yield` and `review_false_positive_rate`
  take their numerators from `review.finding_dispositioned` events by a **named human**, keeping only the latest
  disposition per `findingId`; denominators stay `sum(review.completed.reviewFindingsTotal)`. A human accepting or
  rejecting a finding after the round changes the next snapshot; a later reversal changes it again. Harness-rule
  refutations of ungrounded findings are reported separately (`review_ungrounded_rate`). This needs one new
  dictionary aggregation option (`dedupeLatestBy`, SR-D2) and a dictionary version bump.
- **Evaluator** computes every metric from events with the dictionary's own filters, zero-denominator policy and
  privacy class; snapshots are recomputed idempotently into `metric_snapshots`; panels read snapshots only.
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
complete; the two helper files are given as signatures (`declare`) with their behaviour specified in §18.2.

Location: Lane A's v1 plan put the port and kit in `packages/ports` (CR-10). The slot returns `AdmissionResult`,
which lives in `@asep/application` (`packages/application/src/risk-admission.ts:30-36`), and ports must not depend
on application; the orchestration workflow already depends on `@asep/application` for the Phase 2 step use cases.
So the slot, the disabled slot and the kit live in `packages/application/src/review-loop/`. Lane A's
`ReviewLoopPort`, `ReviewLoopRequest`, `ReviewLoopDecision`, `ReviewLoopTrigger` and `ReviewLoopUnavailableError`
are superseded by this contract (R3).

```typescript
// ===========================================================================
// packages/application/src/review-loop/slot.ts                     (S0; review-loop/v1)
// ===========================================================================
// The review-loop slot: one assurance round after evidence is persisted and before
// push. Framework-free: no orchestration SDK, no wall-clock reads, no process
// environment. Every input and output is plain JSON (no functions, class instances,
// Dates, bigint or undefined-valued keys) and at most 64 KiB when serialized; large
// data travels by ArtifactRef. The assurance service implements ReviewLoopSlot; the
// orchestration workflow composes it and wraps each call as an activity. Changing
// this file after S0 needs a new controller reconciliation.

import type {
  ArtifactRef,
  AttemptId,
  ContextPack,
  RepositoryBindingId,
  RiskLevel,
  RunId,
  TaskId,
  TenantScope,
} from '@asep/contracts';
import type { AdmissionResult } from '../risk-admission.js';

export const REVIEW_LOOP_SLOT_VERSION = 'review-loop/v1' as const;
export type ReviewLoopSlotVersion = typeof REVIEW_LOOP_SLOT_VERSION;

/** Explicit literal a composition must pass to run without independent assurance (Phase 2 behaviour). */
export const REVIEW_LOOP_DISABLED = 'review-loop-disabled-phase2-behaviour' as const;

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
 * it from its own activity context; the sequential driver builds it from an
 * AbortController and an injected clock.
 */
export interface AssuranceStepContext {
  readonly signal: AbortSignal;
  /** ISO-8601 UTC timestamp. Steps never read the wall clock themselves. */
  now(): string;
  /** Called at least every 30 seconds while a step is working. */
  heartbeat(details: AssuranceHeartbeat): void;
}

// --- caller identity and fencing ----------------------------------------------

/**
 * The caller's workspace-lease identity. Every claim, completion and decision write the
 * implementation makes checks, in the same transaction, that this lease is ACTIVE, is
 * held by `leaseId`, and is at epoch `leaseEpoch` (the Phase 2 fenced-takeover
 * invariant). A caller whose lease was taken over gets AssuranceFencedError and changes
 * nothing.
 */
export interface AssuranceFence {
  readonly leaseId: string;
  /** Integer >= 1: the epoch the accepted Phase 2 primitive assigned to this lease holder. */
  readonly leaseEpoch: number;
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

export type PacketOmissionReason = 'binary' | 'too-large' | 'deleted' | 'submodule' | 'non-utf8';

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
  /** Remaining task budget; reviewer calls stop (budget-exhausted) rather than exceed it. */
  readonly budgetRemaining: { readonly costUsd: number | null; readonly wallClockMs: number };
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
  /** Canonical review-packet/v1 bytes. */
  readonly packetRef: ArtifactRef;
  readonly packetSha256: string;
  /** True: the packet holds metadata only; content is never cut silently. */
  readonly overBudget: boolean;
  readonly omissions: readonly { readonly path: string; readonly reason: PacketOmissionReason }[];
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
  /** Provider error, refusal, incomplete output, budget, cancellation or served-model drift. */
  | 'FAILED'
  /** No request was sent: the egress decision was not CLEAR or the request bytes failed the re-scan. */
  | 'EGRESS_STOPPED'
  /** No request was sent: the push guard blocked the round. */
  | 'SKIPPED_PUSH_GUARD';

export interface RunReviewerOutput {
  /** sha256(attemptId | round | reviewerConfigId | packetSha256), 64 lowercase hex. */
  readonly reviewId: string;
  readonly status: ReviewRecordStatus;
  /** Canonical review-record/v1 when the status is COMPLETED_*. */
  readonly reviewRecordRef: ArtifactRef | null;
  /** Provider requests sent for this reviewId across all deliveries; 0 when none was sent. */
  readonly providerCalls: number;
  /** True when a terminal record from an earlier delivery was adopted instead of calling again. */
  readonly adopted: boolean;
}

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
  /** Null when any call in the round has no configured price; never estimated. */
  readonly reviewCostUsd: number | null;
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
  /** 64 lowercase hex, derived from the round's inputs. */
  readonly adjudicationId: string;
  readonly mode: ReviewMode;
  readonly usage: AssuranceUsage;
}

export interface ProceedOutcome extends AssuranceOutcomeBase {
  readonly kind: 'PROCEED';
  /** Non-null iff mode is 'shadow'. */
  readonly shadow: ShadowVerdict | null;
  /** Assurance section for the PR body; null when there is nothing to show. */
  readonly prBodySectionRef: ArtifactRef | null;
}

/** Gating mode only. The orchestrator starts a repair attempt with a fresh workspace at repairBaseSha. */
export interface RepairOutcome extends AssuranceOutcomeBase {
  readonly kind: 'REPAIR';
  readonly repairOrderRef: ArtifactRef;
  /** Equals input.round + 1. */
  readonly nextRound: number;
  /** Equals input.resultSha. */
  readonly repairBaseSha: string;
}

/** Gating mode only. The orchestrator pushes, opens the PR flagged, and stops at human review. */
export interface EscalateOutcome extends AssuranceOutcomeBase {
  readonly kind: 'ESCALATE';
  readonly reason: EscalationReason;
  readonly prBodySectionRef: ArtifactRef;
}

/** Any mode: the deterministic push guard. The orchestrator does not push; the task ends BLOCKED. */
export interface BlockOutcome extends AssuranceOutcomeBase {
  readonly kind: 'BLOCK';
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

export interface AttemptOutcomeInput {
  readonly slotVersion: ReviewLoopSlotVersion;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly risk: RiskLevel;
  readonly round: number;
  readonly declaredComplete: boolean;
  readonly terminal: AttemptTerminal;
  /** Null when verification never ran. */
  readonly verificationVerdict: 'PASS' | 'FAIL' | 'ERROR' | null;
  /** Null when no assurance round ran for this attempt. */
  readonly adjudicationId: string | null;
  /** Failure taxonomy class id (for example 'artifact-loss'); null on success. */
  readonly failureClass: string | null;
  readonly cost: {
    readonly modelCostUsd: number | null;
    readonly computeCostUsd: number | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
  } | null;
}

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
  readonly original: ContextPack;
  readonly repairOrderRef: ArtifactRef;
}

export interface RepairContextOutput {
  /** context-pack/v1 with its hash recomputed. */
  readonly contextPack: ContextPack;
  /** Persisted before return. */
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

  /** Called at every attempt terminal, verification stops included. Idempotent per attempt. */
  recordAttemptOutcome(input: AttemptOutcomeInput, ctx: AssuranceStepContext): Promise<void>;

  /** Admission through the optional `admit` hook on GovernedExecutionInput. Pure. */
  admitWithAssurance(risk: RiskLevel, capability: AssuranceCapability): AdmissionResult;

  /** ContextPack for a repair attempt whose workspace is created at the REPAIR outcome's repairBaseSha. */
  buildRepairContextPack(input: RepairContextInput, ctx: AssuranceStepContext): Promise<RepairContextOutput>;
}

// --- errors -----------------------------------------------------------------------------------
// Any other thrown error is transient and safe to retry with the same input.

/** Malformed input or an outcome that violates this contract. Non-retryable. */
export class ReviewLoopContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewLoopContractError';
  }
}

/** The caller's lease is no longer current at the given epoch. Non-retryable for this delivery. */
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

// ===========================================================================
// packages/application/src/review-loop/disabled-slot.ts            (S0; signature)
// ===========================================================================

/**
 * Phase 2 behaviour: every round returns PROCEED with mode 'not-required' and no
 * reviewer call; recordAttemptOutcome records nothing; admitWithAssurance equals
 * admitRisk; buildRepairContextPack throws ReviewLoopContractError. Constructible only
 * with the explicit literal.
 */
export declare function createDisabledReviewLoopSlot(ack: typeof REVIEW_LOOP_DISABLED): ReviewLoopSlot;

// ===========================================================================
// packages/application/src/review-loop/review-loop-contract.ts     (S0 conformance kit; signatures)
// ===========================================================================

export interface ReviewLoopConformanceFixture {
  /** A valid round-1 input that the implementation's backing store accepts. */
  readonly input: AssuranceSlotInput;
  /**
   * Simulates a lease handoff in the backing store and returns the new holder's fence;
   * null for a stateless implementation (fencing cases then report not-applicable).
   */
  readonly rotateFence: (() => Promise<AssuranceFence>) | null;
}

export interface ReviewLoopConformanceResult {
  readonly caseId: string;
  readonly status: 'passed' | 'failed' | 'not-applicable';
  readonly detail: string;
}

/** Runs cases RLC-01…RLC-10 against any implementation. Framework-free; callers assert on the result. */
export declare function runReviewLoopContract(
  slot: ReviewLoopSlot,
  fixture: ReviewLoopConformanceFixture,
  makeCtx: () => AssuranceStepContext,
): Promise<readonly ReviewLoopConformanceResult[]>;

export interface ScriptedReviewLoopScript {
  readonly mode: ReviewMode;
  /** Outcome kind returned for each round number; validated against this contract like a real implementation. */
  readonly outcomesByRound: Readonly<Record<number, AssuranceOutcome['kind']>>;
}

/** Scripted slot for orchestration tests; enforces every input and output invariant of this contract. */
export declare function createScriptedReviewLoopSlot(script: ScriptedReviewLoopScript): ReviewLoopSlot;
```

### 18.2 Helper behaviour and conformance cases (S0)

`createDisabledReviewLoopSlot` is what Lane A composes until Lane B's implementation is integrated; it reproduces
Phase 2 exactly (no review, push after evidence) and needs the explicit literal, mirroring `HOST_EXECUTION_WAIVER`.
`createScriptedReviewLoopSlot` lets Lane A drive its workflow through all four outcome kinds.

`runReviewLoopContract` cases, run by both lanes (Lane A against the scripted and disabled slots, Lane B against
`createAssuranceSlot` on PGlite and on real PostgreSQL):

| Case | Assertion |
|---|---|
| RLC-01 | every input and output of every method JSON-round-trips deep-equal and serializes to ≤ 64 KiB |
| RLC-02 | `runAssuranceRound` twice with the same input → deep-equal outcomes; the second call sends no provider request |
| RLC-03 | `slotVersion` other than `review-loop/v1` → `ReviewLoopContractError` |
| RLC-04 | round 1 with a `priorAdjudicationId`, or round > 1 without one → `ReviewLoopContractError` |
| RLC-05 | after `rotateFence()`, a call with the old fence → `AssuranceFencedError` and no state change; the new fence completes and converges to RLC-02's outcome |
| RLC-06 | outcome invariants: `roundKey = idempotencyKey`; mode `shadow` or `not-required` ⇒ kind ∈ {PROCEED, BLOCK}; `shadow` non-null iff mode `shadow`; REPAIR ⇒ `nextRound = round + 1` and `repairBaseSha = resultSha` |
| RLC-07 | an aborted signal → `AssuranceCancelledError`; a later call with a live signal converges to RLC-02's outcome |
| RLC-08 | `recordAttemptOutcome` twice with the same input resolves both times and records once |
| RLC-09 | `admitWithAssurance` with `promotedReviewerConfigIds: []` equals `admitRisk` for R0–R4; R3/R4 are `DEFERRED` for every capability |
| RLC-10 | running the individual steps in order yields the same outcome as `runAssuranceRound` |

### 18.3 Obligations of the orchestration composition (SR-A1…SR-A7)

| ID | Obligation |
|---|---|
| SR-A1 | Call the slot after evidence persistence and before push; never at a verification stop. Map outcomes: PROCEED → push, PR with `prBodySectionRef` content, `WAITING_FOR_HUMAN_REVIEW`; REPAIR → new attempt; ESCALATE → push, PR flagged "assurance not satisfied", `WAITING_FOR_HUMAN_REVIEW`; BLOCK → no push, task `BLOCKED`. |
| SR-A2 | A repair attempt gets a fresh workspace at `repairBaseSha` and the ContextPack from `buildRepairContextPack` (the "task baseSha + apply diff" design is withdrawn, R3). |
| SR-A3 | Call `recordAttemptOutcome` at every attempt terminal, verification stops included. |
| SR-A4 | Pass `(risk) => slot.admitWithAssurance(risk, capability)` through the optional `admit` hook (SR-X1). |
| SR-A5 | Emit `workflow.recovered` through the shared `RunEventSink`. |
| SR-A6 | Do not emit `attempt.declared_complete`, `attempt.completed`, `review.completed`, `review.finding_dispositioned` or `repair.started`; Lane B's slot owns them, so no event is double-counted. |
| SR-A7 | Emit `task.completed` (with `outcome` and `repairCycles`) at task terminal; Lane B does not. |
| — | Activity policy: heartbeat timeout ≥ 60 s; retry transient errors; never retry `ReviewLoopContractError` or `AssuranceFencedError` within the same delivery; on `AssuranceFencedError` the attempt is superseded under Lane A's lease-takeover semantics. |

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

`run_events` (Lane A `0107`, R4 union): composite key `(organization_id, project_id, event_id)`, `payload_sha256`
with conflict on different bytes, append-only trigger rejecting UPDATE and DELETE, and an index
`(organization_id, project_id, event_type, occurred_at)`. Lane B adds nothing to that table.

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

All additive (COMPATIBILITY.md: optional property and enum value → MINOR).

---

## 19. Shared-surface change requests

Lane B edits none of these during planning. S0 items are authored here and landed by Lane A (§18). Every other
request lands in a Lane B slice after the rebase onto S0, unless noted.

### 19.1 S0 (Lane A lands; content from this plan)

| ID | Item |
|---|---|
| SR-S0-1 | `packages/application/src/review-loop/{slot.ts, disabled-slot.ts, review-loop-contract.ts}` + export lines (§18 "Review-loop slot contract (verbatim for S0)" and §18.2) |
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
  §"Suite registry" (append-only, R10).
- SR-T2 `scripts/integration/lib.mjs` `REQUIRED_ITEST_SUITES` += the itest suite ids there.
- SR-T3 `scripts/run-canonical-tests.mjs` (+ `canonical-tests.mjs`): add a JUnit reporter to a temp file next to
  the existing stdout reporter (`--test-reporter` / `--test-reporter-destination` pairs, research register §5),
  and a registered post-run proof-check list; Lane B registers the exit-criteria proof check, which fails the run
  if any MUST-mapped test name is missing, skipped, todo or failed. Generic; Lane A may register its own.
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
  `repair_success_rate` and `review_escalation_rate` (both `null` in Phase 4 production: no gating). Definitions
  in data model §5.
- SR-D2 `review_finding_yield` and `review_false_positive_rate` numerators move to
  `review.finding_dispositioned` (human actor, latest per `findingId`); denominators unchanged; dictionary
  `version` 1.0.0 → 1.1.0. Nothing computes these metrics today, so no consumer breaks.
- SR-X6 `packages/observability/src/metrics.ts`: accept and validate the optional operand key
  `dedupeLatestBy: <RunEvent field>`; coordinate with Lane A's dictionary-validator change (CR-19).

### 19.10 Other existing modules

| ID | File | Change |
|---|---|---|
| SR-X1 | `packages/application/src/governed-execution.ts` | optional `admit?: (risk: RiskLevel) => AdmissionResult` on `GovernedExecutionInput`; default `admitRisk`; byte-identical behaviour when absent (R3) |
| SR-X2 | `packages/domain/src/operational.ts` | attempt edges `COMMITTED → UNDER_REVIEW → PUSHED`, `UNDER_REVIEW → CHANGES_REQUESTED` (terminal), `UNDER_REVIEW → BLOCKED`; `COMMITTED → PUSHED` kept |
| SR-X3 | package `index.ts` files of application, policy, observability, git-worktree, persistence | append-only export lines (R10) |
| SR-X4 | `scripts/forbidden-imports.test.ts` (or its AST successor, R8) | no `@temporalio/*` in Lane B paths; no global `fetch`/`WebSocket` calls in domain/application; no `process.env` in `adapters/reviewer-*`; production entry points never import `assurance/drill`; each with a seeded self-check |
| SR-X5 | `compose.yaml` | mount `deploy/grafana/provisioning` read-only into the Grafana service (R9) |
| SR-X7 | `attempts` table (via Lane B's `0200` in `adapters/persistence/src/migrations.ts`) | add `attempts_id_task_scope_uq unique (id, task_id, organization_id, project_id)` so review rounds can prove attempt ∈ task at the DB; additive, no Phase 2 or Lane A column touched |

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
adapters/persistence/src/assurance/**                    repositories, snapshot store, itests
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
only Lane B-owned paths. "After P2" means after the rebase onto accepted Phase 2. Every slice is independently
revertible; a slice that adds a mutation-proof entry adds it in the same commit.

| Slice | Deliverable | Acceptance checks (executable) | When | Commit |
|---|---|---|---|---|
| S1 | SR-C1/C2/C4/C6/C7/C8 | new fixtures accept/reject; compat gate classifies `architecture-invariant` as MINOR; `review-report/v1` and `finding/v1` schema and snapshot bytes unchanged (digest test); drift guard; templates validate | after S0 | `feat(contracts): add review record, finding, packet, adjudication and repair contracts` |
| S2 | SR-P1/P3/P4 | typecheck; structural compile test for the deprecated port | after S0 | `feat(ports): add packet-only reviewer and review-source ports` |
| S3 | `review-policy.yaml` + loader | YAML↔TS parity; unknown family fails closed; implementer-family reviewer rejected; comparator must differ from primary family; **loader rejects `gating`**; D-2 rule table (R1 + promoted → no human review required; R1 unpromoted → required; R2 promoted → still deferred); approval/verification matrices byte-unchanged | pre-S0 | `feat(policy): declare reviewer independence, egress classification and shadow-only modes as data` |
| S4 | finding lifecycle + closure authority + review-round machine; SR-X2 | table-driven transitions; raiser cannot verify; model cannot waive/refute grounded HIGH/CRITICAL; waiver needs human + rationale + expiry; `closure-without-change` | domain file pre-S0; SR-X2 after S0 | `feat(domain): finding lifecycle with closure authority and review-round states` |
| S5 | packet builder (incl. execution manifest), prompt renderer, independence checks | canaries in coder self-report never reach packet, prompt or request bytes; identical bytes across builds; nonce derivation; over-budget flagged, never cut; manifest carries command, exit code, environment digest, raw refs, scanned bounded excerpts | pre-S0 (fakes) | `feat(assurance): build an independent review packet with an execution manifest` |
| S6 | push guard, egress decision, false-green checks, Trojan Source, dependency/invariant checks, SARIF | seeded violation per check; secret-pattern parity; each egress stop kind; seeded false-green cases (zero tests, added skip, exit-code mismatch, missing check) all caught | pre-S0 | `feat(assurance): deterministic push guard, egress decision and false-green checks` |
| S7 | grounding, adjudication rule table, closure authority, repair order | every rule row × {gating, shadow}; shadow never yields REPAIR/ESCALATE; out-of-packet citations refuted; repair order bounded and anchored | pre-S0 | `feat(assurance): grounding, adjudication and closure authority` |
| S8 | SR-M1/M3/M4, repositories, fenced decision writes, snapshot store | PGlite + real PG: migrations apply once and stay in range; tenant IDOR rejected; append-only and final-record triggers; shadow check constraint; disposition actor constraints; fence: new owner completes after handoff, old owner fenced, concurrent claim one winner | after P2 + S0 | `feat(persistence): persist review rounds, findings, dispositions and adjudications under fencing` |
| S9 | `ReviewSourceReader` | real temp repos: exact range diff; binary/too-large/submodule/deleted/non-UTF-8 reported, never dropped; traversal rejected | after S0 | `feat(workspace): trusted range diffs and post-images for review` |
| S10 | `adapters/reviewer-openai` + credential source + request-byte egress re-check | fake HTTP server rows for every adapter MUST; exact request body asserted; credential canary absent; rotation on 401; expiry refresh; no `process.env` in adapter source; opt-in probe of primary and comparator records the gateway's behaviour | after S0 | `feat(reviewer): OpenAI-compatible Responses reviewer with an injected credential source` |
| S11 | `adapters/reviewer-replay` | exact replay by request hash; miss and manifest mismatch fail closed; scripted provider marked fake | after S0 | `feat(reviewer): deterministic replay and scripted reviewers` |
| S12 | step use cases `planAssurance`, `buildReviewPacket`, `runDeterministicChecks`, `runReviewer`, `adjudicateRound` (application, against fakes) | JSON round trip; zero provider calls on push-guard BLOCK and on every egress stop; crash at each step boundary converges; parallel reviewers blind | after S0 | `feat(assurance): idempotent assurance step use cases` |
| S13 | `createAssuranceSlot` (composite, `recordAttemptOutcome`, `admitWithAssurance`, `buildRepairContextPack`, event emission); SR-X1 | conformance kit RLC-01…10 on PGlite; events per §15 with deterministic ids; `admitWithAssurance` equals `admitRisk` for production capability; governed-execution suite unchanged | after S0 | `feat(assurance): implement the review-loop slot and attempt-outcome events` |
| S14 | `runAssuredTask` sequential driver + durable-shaped fake | shadow mode changes no workflow decision except BLOCK; drill gating loop bounded by `maxRounds`; activity-granular fake converges under retries, cancellation and a lease handoff | after S0 | `feat(assurance): sequential proof driver and activity-granular fake` |
| S15 | `assurance-root.ts` + CLI (`asep assurance report`, disposition entry for humans) | fail-closed config; gating unreachable from production composition (policy with `gating` refused); credential source injected; disabled-reviewer literal | after S0 | `feat(control-plane): compose the independent reviewer behind a fail-closed root` |
| S16 | **assurance-only** loop itest | real PG + Git + sandbox + real adapter vs local fake HTTP: shadow PROCEED with recorded wouldBe; push-guard BLOCK with zero gateway requests and zero forge calls; each egress stop with zero gateway requests; drill composition: REPAIR → re-review closed by the other reviewer → PROCEED, raiser-only closure → ESCALATE at max rounds; conformance kit on real PG | after P2 + S0 | `test(control-plane): assurance-only loop on real backends` |
| S17 | metric evaluator + snapshot recompute (incl. `dedupeLatestBy`); SR-D1/D2, SR-X6 | golden values; a human accept then reject after the round changes the next snapshot each time; harness refutations excluded from yield; nulls carry reasons | after S0 | `feat(observability): evaluate dictionary metrics from events and human dispositions` |
| S18 | Grafana provisioning + SR-T4 + SR-X5 | itest: Grafana `GET /api/health` ok; data source by uid loads; every dashboard by uid loads; every panel query via `POST /api/ds/query` returns the snapshot values the S16 run produced | after S0 | `feat(observability): provision assurance dashboards and load them in the integration gate` |
| S19 | `evals/review-corpus` manifest + content-addressed excerpts + verifier | every claim verified (reachable SHAs against git; excerpt hashes; fix-commit subjects; review-doc lines); exclusions enumerated; no pre-rewrite ref created; excerpts pass publication gates; bundle mode verified when the controller supplies the path | pre-S0 | `feat(evals): content-addressed self-history defect corpus` |
| S20 | protocol, preregistration file, matcher, scorer, baselines, injection and false-green suites, floor evaluation | rescoring is byte-identical; scorer refuses fake recordings and any `eligibleForPromotion` other than false for self-history; capture refuses a preregistration mismatch; Wilson intervals; suite `INVALID_CONTROL` state | pre-S0 | `feat(evals): pre-registered rediscovery protocol and deterministic scorer` |
| S21 | live capture (primary + comparator, k = 3 on reporting items), scorecards, `phase-04-report.md` | recordings and manifests committed; controller rescoring is byte-identical; report fields generated from scorecards and gate logs | after SR-G2/SR-G3 | `docs(phase-4): record descriptive reviewer measurement on self-history` |
| S22 | real-coder shadow round | one real `CodingAgentProvider` attempt (accepted Phase 2 runtime) through a shadow round on real backends; evidence committed | **blocked** until the Phase 2 agent-runtime repair is accepted | `test(control-plane): real coder attempt through a shadow assurance round` |
| S23 | SR-T3 proof check + mutation proofs | every MUST-mapped test passed per the JUnit manifest; each seeded mutation (data in `scripts/assurance-mutation-proofs.json`) turns its mapped test red in a temp copy; the unmutated control passes; a mutation whose search text does not match exactly once fails the suite | after S0 (runner change); entries accrue per slice | `test(assurance): proof manifest and seeded mutation proofs for key guards` |
| S24 | runbook + executable rehearsal | 429 storm, 503, malformed outputs, cost budget exceeded, served-model drift, credential expiry/rotation, egress stop and reviewer disabled each reach the documented decision on real mechanisms | after S15 | `docs(phase-4): assurance runbook and executable fault rehearsal` |

---

## 22. Task DAG

```text
S0 (Lane A) ─┬─> S1 ─> S2 ─┬─> S9 ──┐
             │             ├─> S10 ─┼─> S12 ─> S13 ─> S14 ─> S15 ─> S16 ─┬─> S18
             │             └─> S11 ─┤                                    ├─> S17 ─> S18
S3, S4, S5, S6, S7 (pre-S0) ────────┘                                    └─> S24
Phase 2 accepted ─> S8 ─> S13
S19 ─> S20 ─> S21 <─ S10 + S11 (+ SR-G2, SR-G3)
Phase 2 agent runtime ─> S22 <─ S16
S23 runner change after S0; mutation entries accrue with S5–S20; the suite closes after S21
```

Acyclic. S19/S20 depend on no persistence.

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

---

## 24. Rollback

Per-slice commits on the lane branch; `main` untouched until the controller merges. The slot is inert until Lane A
wires it (the disabled slot reproduces Phase 2). Production mode is shadow, so reverting a Lane B slice restores
Phase 2 behaviour. Migrations are forward-only; the documented rollback for each is a forward compensating
migration (data model §3.6).

---

## 25. Blocking dependencies

1. **Phase 2 acceptance** (R1, ordering): S8 and S16 need the accepted fencing primitive; every shared-surface
   slice needs the rebase.
2. **Lane A S0**: every slice marked "after S0".
3. **Gateway credential and preregistration** (SR-G2, SR-G3): S21. Without them the verdict is
   `…MEASUREMENT_PENDING…`. Neither gateway model was probed in this session (not verified).
4. **Phase 2 agent-runtime repair**: S22. Without it the verdict carries `ASSURANCE_ONLY_LOOP`.
5. **Pilot repository**: DF-6 only.

None blocks plan lock.

---

## Output

```text
PLAN_STATUS: LOCKED v2 (pending controller confirmation)
BASE_SHA: 00a68895d205122767167942326e2e0466571059 (Phase 2 not accepted)
REVIEWED_V1: a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f — Codex REQUEST_CHANGES 0.99 (1 CRITICAL, 8 HIGH, 5 MEDIUM, 1 LOW), all dispositioned
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
NEW_THIRD_PARTY_DEPENDENCIES: none
GATING: shadow only in Phase 4 (user decision); gating/promotion/thresholds/R2 admission deferred
SHARED_SURFACE_REQUESTS: §19 (S0 4, ports 3, contracts 6 (+ SR-C3 withdrawn, SR-C5 moved to S0), migrations 3 (+ 0201_run_events withdrawn), fencing CR-F1, gates 4, dictionary 2 + loader, other 6, controller 3)
READY_FOR_IMPLEMENTATION: after controller confirmation, Phase 2 acceptance and Lane A S0 (pre-S0 slices excepted)
```
