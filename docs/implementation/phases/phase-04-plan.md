# Phase 4 — Independent Assurance — Plan (DRAFT v1)

> Status: **DRAFT — awaiting the controller's independent Codex plan review.** Not locked. No implementation
> code, tests, migrations or configuration are part of this step.
> Lane: **B** (parallel to Lane A / Phase 3 durable orchestration). Planner: Claude (Lane B session, plan-only).
> Companion documents: `phase-04-architecture.md`, `phase-04-data-model.md`, `phase-04-exit-criteria.md`,
> `phase-04-risk-register.md`, `phase-04-research-register.md`, `phase-04-threat-model-delta.md`,
> `phase-04-review-log.md` (empty skeleton).

```text
BASE_SHA:        00a68895d205122767167942326e2e0466571059   (head of phase/02-single-agent-vertical-slice; Phase 2 NOT yet accepted)
TARGET_BRANCH:   phase/04-independent-assurance
SCOPE SOURCE:    docs/implementation/90-day-plan.md:33-40 (Days 46–60)
EXIT CRITERION:  "reviewer performance measured on historical defects" (90-day-plan.md:40)
```

---

## 0. Execution model

The lane contract governs this phase. Lane B plans, the controller runs a read-only Codex plan review, Lane B
adjudicates every finding into the canonical documents and records dispositions in `phase-04-review-log.md`,
the plan locks, and implementation starts only when the controller says "implement". Implementation is one
slice per commit (§19). The controller runs the gate independently and commissions the Codex final audit;
Lane B repairs; the controller merges on ACCEPT. Lane B never skips a step on its own.

Lane B is **orchestration-agnostic**. Every review, repair, re-review and adjudication behaviour is a
framework-free step use case behind ports, proven by a thin sequential driver and a durable-shaped fake that
uses no orchestration SDK (§16). Lane B never imports the Temporal SDK or anything Lane A adds.

---

## 1. Current-state audit (file-level evidence at `00a6889`)

Every citation below was read in this session. Phase 2 is not accepted and may still change (lane contract:
"A plan must not assume any Phase 2 line number stays fixed"), so the plan binds to symbols; line numbers
describe `00a6889` only.

### 1.1 Review contracts exist but carry no provenance

- `packages/contracts/schema/review-report.schema.json:8-14` — `ReviewReport/v1` requires only
  `reviewerProvider, reviewerModel, verdict, findings, confidence`. No review id, no attempt/evidence binding,
  no packet hash, no raw-response reference, no round, no re-review closure statuses.
- `packages/contracts/schema/finding.schema.json:8-18` — `Finding/v1` requires `id, severity, category,
  evidence, requiredFix`; `file`/`lineStart`/`lineEnd` optional; no source (model vs deterministic), no
  grounding result, no fingerprint, no lifecycle state.
- `packages/contracts/schema/architecture-invariant.schema.json:8-13` — prose only (`id, statement, category,
  rationale`); nothing machine-checkable.
- `packages/contracts/COMPATIBILITY.md:31-33` — a MAJOR change must mint a new `$id` major (`/v2`).
- `packages/contracts/src/compat-gate.ts:184-187` — the gate compares live schemas only against
  `schema/snapshots/v1`. A schema that moves to `/v2` would be compared against its v1 snapshot forever, so
  later edits to the v2 schema would no longer be guarded. This is a latent gate gap that Phase 4 must close
  before it publishes any v2 contract (§17, SR-C3).

### 1.2 The Phase 1 reviewer port is unsafe as-is

- `packages/ports/src/index.ts:68-77` — `ReviewProvider.review({ order, context, diffArtifactId, verification,
  implementerProviderId })` returns a `ReviewReport` directly. It hands the reviewer the coder's
  `ContextPack` (shared context, contrary to ADR 0010 "fresh context is mandatory"), has no `AbortSignal`, no
  budget, no raw-output capture and treats the provider's report as trusted. A grep over `packages`,
  `adapters`, `apps`, `workers`, `scripts`, `evals`, `policies` finds no runtime caller — only the port
  declaration and generated types.
- The Phase 2 precedent is the same situation for the coder: `CodingAgentProvider` was redesigned to a
  request/result-scoped, untrusted-observation port (`packages/ports/src/index.ts:39-62`). Phase 4 does the
  same for the reviewer (§17, SR-P1).

### 1.3 Policy demands review that nothing provides

- `policies/approval-matrix.yaml:32-34` R1 needs 1 independent reviewer; `:41-43` R2 needs 1 independent
  reviewer of a **different model family** plus human merge; `:50-51` R3/R4 need 2.
- `policies/verification-matrix.yaml:23` R2 mandates L4 (architecture) and L8 (independent review);
  `:24` L5 (security) is mandatory only from R3.
- `packages/application/src/risk-admission.ts:48-50,127-134` — R2–R4 are `DEFERRED` wholesale; R1 is admitted
  only with a separately recorded human review.
- `packages/application/src/governed-execution.ts:169-178` — admission is evaluated first and is hard-wired to
  `admitRisk`; there is no injection point for an assurance-aware admission.

### 1.4 The pipeline has no review slot

- `packages/application/src/pipeline-steps.ts:889-1026` — `completeToReview` runs verify → preallocate
  evidence id → commit → evidence → **push** (`:965-979`) → PR → set-review. There is no point between the
  persisted evidence and the push where an independent review could run.
- `packages/domain/src/operational.ts:28-39` — task transitions; `VERIFYING → WAITING_FOR_HUMAN_REVIEW |
  FAILED | BLOCKED | CANCELLED`. `:82-97` — attempt happy path `… EVIDENCE_BUILT → COMMITTED → PUSHED → PR_OPEN
  → SUCCEEDED`; there is no under-review or changes-requested attempt state.
- `packages/contracts/src/base.ts:42-45` — `AttemptStatus` union (persisted with a check constraint in
  `adapters/persistence/src/migrations.ts:100-123`).

### 1.5 Measurement is defined but never computed

- `docs/platform/metrics-dictionary.yaml` defines `false_completion_rate` (`:222-242`), `review_finding_yield`
  (`:276-294`), `review_false_positive_rate` (`:296-314`), `escaped_defect_rate` (`:316-333`),
  `workflow_recovery_rate` (`:355-372`) and `cost_per_accepted_task` (`:375-393`).
- `packages/observability/src/metrics.ts:74,219` — the dictionary is loaded and validated; nothing evaluates a
  metric.
- No runtime code emits or persists a `RunEvent`: a grep for `RunEvent`/`run_events`/`eventType:` outside
  `generated.ts` and tests hits only the catalog (`packages/contracts/src/run-event-catalog.ts`) and the
  dictionary validator. `adapters/persistence/src/migrations.ts:426-437` lists twelve migrations; none creates
  an event table.
- `compose.yaml:93-96` runs Grafana 12.0.2 with a data volume only: no data source, no dashboard provisioning.
- Lesson carried from Phase 2 (`phase-02-final-review-codex-v1.md`, P2-FINAL-MED-003): a span vocabulary
  without runtime emission was reported as "observability". A Phase 4 dashboard without emitted events would
  repeat that defect. §14 makes runtime emission and real-backend computation part of the MUSTs.

### 1.6 Architecture/security checks today

- `scripts/forbidden-imports.test.ts:51-66` forbids provider SDKs and HTTP client libraries in domain and
  application packages by **import specifier** (`:80` `IMPORT_RE`). A call to the global `fetch` is not an
  import and is not detected.
- No diff-level secret, invisible-Unicode or forbidden-path check runs on an agent's change before push (grep
  over `packages/application/src` for `secret|bidi|forbiddenChanges` finds only `allowedPaths` passed to the
  committer, `pipeline-steps.ts:299,406`). Repository-wide scanners (`scripts/secret-scan.sh`,
  `scripts/pii-scan.sh`) protect *this* repository, not a pilot repository's diff.
- L4/L5 commands from an approved project configuration already run through the trusted runner in the
  no-network sandbox (`verifyStep`, `pipeline-steps.ts:181`); a red check stops before commit. Phase 4 reuses
  that mechanism instead of duplicating it.

### 1.7 Adapter and composition patterns to follow

- `adapters/agent-claude/src/claude-provider.ts:1-16,251` — pinned config, raw provider output persisted as an
  immutable artifact **before** parsing, fail-closed parsing, untrusted observation only; isolation is the
  default and its absence needs an explicit literal waiver (`:80`).
- `apps/control-plane-api/src/production-root.ts:101-171` — fail-closed configuration; credentials are
  constructor inputs held in memory; adapters are built in the composition root only.
- `packages/application/src/registration.ts` — repository ports are declared structurally inside the
  application layer, so a new use case does not need a shared-port change for its own persistence.
- `scripts/lib/canonical-tests.mjs:91-185` (`REQUIRED_SUITES`) and `scripts/integration/lib.mjs:31-50`
  (`REQUIRED_ITEST_SUITES`) make a dropped suite turn the gate red.

---

## 2. Baseline gate (observed in this session at `00a6889`)

```text
pnpm install --frozen-lockfile → exit 0
pnpm verify:all                → exit 0, "verify:all: PASS (all gates green)"
  canonical tests: 548 tests, 50 files, 28 required suites verified
  contracts compat: 13 schemas compatible with snapshot v1
  forbidden-imports 16 tests, project-references 5 tests, scans + publication + clean-tree PASS
```

Phase 2 itself is **not accepted** (`phase-02-report.md:12`, verdict
`IMPLEMENTATION_COMPLETE_PILOT_PENDING_UNREVIEWED`; cycle-6 re-review still running per the lane contract).
Phase 4 builds on Phase 2's port contracts and step use cases, not on its acceptance. If Phase 2 repairs
change a port or step signature that this plan depends on, the dependency is re-adjudicated in
`phase-04-review-log.md` before implementation.

---

## 3. Gap analysis

| Capability | At `00a6889` | Phase 4 needs | Slice |
|---|---|---|---|
| Review contract | `ReviewReport/v1`, `Finding/v1` without provenance | `review-report/v2`, `finding/v2`, `review-packet/v1`, `adjudication-record/v1`, `repair-order/v1`; compat gate per major | S1 |
| Reviewer port | Phase 1 `ReviewProvider` (shared context, trusted output) | packet-only `ReviewerProvider`, untrusted observation, raw capture | S2 |
| Independence policy | `requireDifferentModelFamily` flag only | model-family registry, reviewer registry, blocking severities, repair-round limits as data | S3 |
| Finding/round lifecycle | reference doc only (`docs/architecture/04-state-machines.md:40-48`) | executable state machines; attempt `UNDER_REVIEW`/`CHANGES_REQUESTED` | S4 |
| Packet + prompt | none | immutable packet, spotlighted prompt, independence checks | S5 |
| Deterministic checks + adjudication | none | diff checks, SARIF subset, grounding, adjudication, repair order | S6 |
| Persistence + events | no event store | review tables, append-only `run_events`, `metric_snapshots` | S7 |
| Trusted review source | per-attempt diff only | range diff + post-image blobs from the leased workspace | S8 |
| Second-family reviewer | none | OpenAI-compatible Responses adapter | S9 |
| Replay | none | recorded-response reviewer + scripted fake | S10 |
| Step use cases + slot | none | idempotent steps, slot composite, thin driver, durable-shaped fake | S11 |
| Composition + real-backend loop | none | `assuranceSeams()`, real PG + Git + sandbox loop proof, CLI | S12 |
| Dashboards | dictionary only | evaluator, snapshots, CLI report, Grafana provisioning | S13 |
| Historical-defect corpus | none (Phase 1 deferred real tasks) | curated review-history corpus with git-verified provenance | S14 |
| Reviewer measurement | none | pre-registered protocol, deterministic scorer, scorecard | S15 |
| Live measurement | none | recorded live run on the frozen corpus + report | S16 |
| Operational readiness | none | runbook + executable fault rehearsal | S17 |

---

## 4. Scope

**In scope:** a second model/provider reviewer of a different family than the coder, behind a provider port;
versioned review contracts; review packet assembly with strict independence; prompt-injection-resistant
prompt construction; deterministic architecture/security diff checks and a SARIF subset for project tools;
deterministic adjudication; repair orders and re-review; shadow/gating reviewer modes with human-signed
promotion; risk-admission extension so R2 can be admitted once a gating reviewer is promoted; persisted review
records, findings, dispositions and an append-only `RunEvent` store; metric evaluation and dashboards for
false completion, review yield, cost and recovery; a labelled historical-defect corpus built from this
repository's review history; a deterministic reviewer scorecard; one live measurement run; runbook and
rehearsal.

**Out of scope:** workflow composition and the durable engine (Lane A); auto-merge; R3/R4 admission
(specialist review, rollback plans and two reviewers are not delivered); tool-using ("agentic") reviewers that
browse the repository; inbound forge webhooks; production deployment of Grafana; managed secret broker;
claims about reviewer performance beyond the measured corpus; any "historical tasks" dataset for the Phase 1
production-pilot dependency (that remains PP2, `phase-01-exit-criteria.md:81`).

---

## 5. Architecture summary

Full detail in `phase-04-architecture.md`. One paragraph:

After an attempt's evidence is persisted (resultSha = harness commit) and before push, an **assurance slot**
runs. It builds an immutable **ReviewPacket** from trusted sources only (evidence, WorkOrder, trusted Git
diffs and post-images); runs **deterministic diff checks**; asks each required **reviewer** for a structured
review through a packet-only port; validates and **grounds** every finding against the packet;
**adjudicates** deterministically; and returns `PROCEED`, `REPAIR`, `ESCALATE` or `BLOCK`. `REPAIR` produces
a **RepairOrder**; the orchestrator starts a repair attempt at the previous harness commit, and the next
round runs as a **re-review** with structured closure statuses for the prior blocking findings. The harness
ceiling stays `WAITING_FOR_HUMAN_REVIEW`; nothing in Phase 4 merges.

---

## 6. The historical-defect question

The exit criterion asks for reviewer performance "measured on historical defects". Phase 1 deferred a real
historical-task dataset to the production pilot (`README.md:59`; `evals/README.md:62`; `phase-01-risk-
register.md:9` RR-03 forbids fabricating it). This section assesses the one corpus that exists today — this
repository's own review history — and states what it can and cannot support.

### 6.1 What exists (counted in this session)

Counts come from a grep of finding-ID patterns over `docs/implementation/phases/*` at `00a6889`; the exact
item set is an S14 deliverable and will be machine-verified.

| Source | Distinct IDs | Nature |
|---|---|---|
| `phase-01-plan-review-codex-v1.md` | 49 | plan/document defects (no code existed) |
| `phase-02-plan-review-codex-v1.md` | 20 | plan/document defects |
| Phase 1 final + re-reviews (dispositioned in `phase-01-review-log.md`) | 15 top-level (`P1-FINAL-*` 10, `P1-REREVIEW-CRIT-001` with parts a/b/c, `P1-CYCLE3-HIGH-001`, `P1-CYCLE4-MED-001/002`, `P1-CYCLE5-HIGH-001`) | code/test/gate defects with `file:line` evidence |
| Phase 2 final + re-reviews (`phase-02-final-review-codex-v1.md`, `-rereview-codex-v2..v5.md`) | 15 `P2-FINAL-*` + 2 `P2-REREVIEW-MED-NEW-*` | code/test/gate/claim defects with `file:line` evidence |
| Implementer self-found | 1 (`P2-CYCLE6-HIGH-001`, cold-build `tsc -b` failure) | a defect the reviewer missed |

Re-review cycles also mark findings `PARTIAL`/`REGRESSED` (cycle 2: "6 HIGH partial + 1 regression + 2 new
MED", commit `e1c3c68`; cycle 3: "5 HIGH still partial", commit `7b7a2f5`) and explicitly **merge newly
observed defects into existing IDs** (`phase-02-final-rereview-codex-v3.md` and `-v4.md`,
"Finding mới" sections). Fix commits carry the finding ID in their subject (e.g. `3815620 … (HIGH-007)`,
`0a136e7 fix(contracts): P1-CYCLE5-HIGH-001 …`), which links each defect to a pre-fix tree and a post-fix
tree.

### 6.2 Is it a valid labelled defect corpus?

**Partly.** It is a real, labelled, small corpus of defects in real code, with severity, `file:line`
evidence, a required fix, an independent second confirmation (re-review status `RESOLVED`/`PARTIAL`) and a
git-reachable before/after pair for most items. That is enough to *measure* a reviewer on this repository,
which is what the exit criterion literally asks. It is not enough to *validate* a reviewer for production use,
and it is not the Phase 1 historical-task dataset.

Validity problems found, each with its handling:

1. **One codebase.** TypeScript/Node, one harness, one author pair. Results do not transfer to the pilot
   repository. *Handling:* every scorecard carries `scope: "self-history"`; the report must not generalise;
   COMPLETE requires a second, independent corpus (§6.4).
2. **One labeller model, and it is the candidate reviewer.** Almost every label was produced by Codex running
   `gpt-5.6-sol`, the same model this plan proposes as the runtime reviewer. The corpus is therefore "defects
   `gpt-5.6-sol` found". Measuring `gpt-5.6-sol` on it is partly circular and biases recall upward; measuring
   any other reviewer on it penalises defects `gpt-5.6-sol` would not find. *Handling:* report recall
   separately on the **labeller-miss subset** (defects found later at a tree an earlier cycle already
   reviewed, plus the self-found `P2-CYCLE6-HIGH-001`); include non-model baselines; state the circularity in
   the scorecard; optional different-family comparator (decision D-4).
3. **Different reviewer harness.** The labeller ran a tool-using CLI with the whole repository, the plan and
   exit criteria. The runtime reviewer is packet-only (§8). A low score can mean "packet too narrow", not
   "model weak". *Handling:* the scorecard records the packet rule; items whose cited file the packet rule
   cannot include are excluded with reason `not-in-packet`, counted, and reported.
4. **Self-selection.** Defects nobody found are absent; precision cannot be estimated from labels alone,
   because Phase 2 plan dispositions accepted 20 of 20 findings (`phase-02-review-log.md:12-18`) and every
   Phase 2 final-review finding was fixed rather than rejected (`phase-02-report.md:321-322`). *Handling:*
   precision is reported only over reviewer findings that a named human or the controller adjudicated;
   unadjudicated findings are counted, never assumed false.
5. **Labels are second-hand for one cycle.** The first Phase 1 final review document was never committed and
   was deleted as stale (`phase-02-plan.md:37-39`); `P1-FINAL-*` descriptions survive only as controller
   paraphrase in `phase-01-review-log.md:149-239`, and the reviewed SHA is not recorded. *Handling:* those
   items carry `labelQuality: "secondhand"` and a best-effort reviewed SHA; they are reported separately.
6. **IDs are not defects.** Re-reviews fold new defects into existing IDs, and one ID spans several repair
   rounds. *Handling:* the unit is a **defect instance** `(findingId, reviewedSha, location set)`; primary
   metrics use first-occurrence instances only, residual instances are reported separately, and confidence
   intervals are computed on first-occurrence instances so repeated instances of one ID are not counted as
   independent samples.
7. **Defect classes differ.** Many items are gate-adequacy or claim-integrity defects ("green gate that did
   not exercise the MUST", "report overclaims") rather than code bugs. *Handling:* every item carries
   `defectClass ∈ {code, test-adequacy, gate-config, claim-integrity, build}`; metrics are reported per class.
8. **Unreachable or missing trees.** Some reviewed or cited SHAs are not reachable from `HEAD`: cycle-5's
   reviewed head `bb11d00` and `89a745b` are present in the local object store but unreachable (probably a
   consequence of the Phase 2 history rewrite; not verified), `7e5a911` does not exist, and Phase 1's
   `7345b76` was a reviewer-made test commit. A clean clone cannot rebuild those trees. *Handling:*
   reachability is checked against advertised refs, not `git cat-file`; unreachable items are excluded with
   reason `tree-unreachable`. The controller must also keep the Phase 1/2 history reachable after merging
   (SR-G1), or the corpus becomes irreproducible.
9. **Tiny n.** About 33 top-level code-level IDs exist across both phases; per-class and per-severity cells
   will hold single digits. A Wilson 95% interval at 20/33 spans roughly 0.44–0.75. *Handling:* every
   proportion is reported with n and a Wilson interval; cells with n < 20 are labelled "descriptive only";
   no comparison is called a difference when intervals overlap.

### 6.3 What would make the measurement dishonest (and the guard for each)

| Dishonest move | Guard |
|---|---|
| Showing the reviewer the answer key: review documents, review logs, fix-commit messages, or a tree that already contains the review document of the cycle under test. Example: the parent of the first Phase 2 fix commit is `3ea0293`, which **adds** `phase-02-final-review-codex-v1.md`; the reviewed tree is `2e61f24`. | Packets are built from the **reviewed SHA**, never "parent of fix"; review artifacts (`*review*`, review logs) and all git metadata are excluded; a leakage test fails if any packet contains a review-artifact file (EC I2). |
| Tuning prompts on the items that are then reported. | Dev split = Phase 1 items, test split = Phase 2 items; protocol, matcher parameters, corpus manifest hash and reviewer configuration hash are frozen before the first test-split run; a test-split scorecard produced under any other configuration hash is rejected (EC I3). |
| Lenient or model-judged matching of findings to gold defects. | Deterministic matcher (path equality + line overlap within a pinned tolerance + category compatibility); strict and lenient numbers both reported; no model in the scoring path (EC I4/I5). |
| Treating every unmatched reviewer finding as a false positive, or as a true positive. | Unmatched findings go to an `unlabelled` bucket; precision only over adjudicated findings (EC I5). |
| One lucky sample of a non-deterministic model. | k ≥ 3 runs per test item; stability reported; raw responses recorded and re-scorable offline byte-identically (EC I4/I6). |
| Quietly dropping hard items. | Exclusions are rule-based, enumerated in the manifest with a reason, and reported in the scorecard denominator table (EC I1/I5). |
| Scoring fake or scripted reviewer output as a measurement. | The scorer refuses to emit a `self-history` scorecard from a recording whose descriptor is a scripted/fake provider (EC I6). |
| Calling this the Phase 1 historical-task dataset or a production validation. | Scorecard `scope` field; report verdict vocabulary (§21); EC I7. |

### 6.4 What else is needed

1. **An independent corpus from the pilot repository** (bug-fix commits and PR review findings with human
   labels, Defects4J-style before/after pairs — research register §4). This depends on the same pilot
   repository Phase 1 PP1/PP2 and Phase 2 K2/K6 are still waiting for. It is required for `COMPLETE`; without
   it the honest verdict is `IMPLEMENTATION_COMPLETE_MEASURED_ON_SELF_HISTORY` (§21).
2. **Human label verification.** A named human spot-checks every HIGH/CRITICAL item and a random sample of the
   rest; agreement is recorded in the manifest. Until then labels are `controller-adjudicated`.
3. **Revert-injected variants** (optional, reported separately): re-apply a fixed hunk's pre-fix form onto a
   later tree where it applies cleanly, labelled `source: revert-injected`. Increases n; never pooled with
   historical items.
4. **An adversarial injection suite** (synthetic, labelled) to measure how injection in a diff changes
   detection (EC D5). Reported separately; it is not historical.

**Decision for the plan:** build the self-history corpus (S14) with these guards, measure on it (S15/S16),
and report the verdict honestly. Do not claim a dataset that does not exist.

### 6.5 Corpus packet rules (proposal; frozen in the S15 protocol before any test-split run)

The runtime packet is built from a task's diff. Corpus items have no task, and a whole-phase diff (Phase 2
base `fc0df57` to a reviewed SHA) is far larger than any packet budget. Two pre-registered rules, applied by
item kind and reported separately:

- **Rule P (first occurrence, `fresh` mode):** files changed between the phase base (Phase 1 `9f60c9d`,
  Phase 2 `fc0df57`) and the reviewed SHA, restricted to the top-level module directories (`<root>/<name>/`)
  that contain at least one cited file, plus that phase's exit-criteria document and report at the reviewed
  SHA as the requirements/claims under review; review artifacts excluded; budget-capped by path order. This
  discloses module-level localization, which raises recall; the baselines receive the same packets.
- **Rule C (residual, `re-review` mode):** the diff between the previous reviewed SHA and this reviewed SHA
  (what the re-reviewer checked), plus the prior cycle's findings in structured form, mirroring the runtime
  re-review packet.

An item whose cited file falls outside its rule's packet is excluded with reason `not-in-packet` and counted.

---

## 7. Review-loop sequence

```text
[attempt N evidence persisted; resultSha = harness commit]            (Phase 2 steps / Lane A workflow)
  → planAssurance             pure: risk + policy + reviewer registry + promotions → mode + reviewers + limits
  → buildReviewPacket         trusted sources only; canonical bytes; byte budget; never truncates silently
  → runDeterministicChecks    diff checks (secrets, invisible Unicode, forbidden paths, dependency/lockfile
                              changes, machine-checkable architecture invariants) + parsed SARIF from L4/L5
  → runReviewer × reviewers   packet-only, blind to each other, raw request/response captured first
  → adjudicateRound           pure decision + persisted AdjudicationRecord + RunEvents
      PROCEED  → push → PR (review section in body) → WAITING_FOR_HUMAN_REVIEW
      REPAIR   → RepairOrder; orchestrator starts attempt N+1 at repairBaseSha; next round = re-review
      ESCALATE → push → PR flagged "assurance not satisfied" → WAITING_FOR_HUMAN_REVIEW; acceptance refused
                 until a human re-runs review or records a waiver
      BLOCK    → no push; task BLOCKED (e.g. secret in diff)
```

Task status stays `VERIFYING` across repair rounds (L8 is a verification level); round state lives in Lane
B's `review_rounds`. Attempt N ends `CHANGES_REQUESTED` on `REPAIR`. This avoids a task-state change on a shared
surface.

---

## 8. Independence model (ADR 0010)

1. **Packet-only input.** The reviewer receives exactly one immutable `ReviewPacket`. Its schema has no field
   that can carry the coder's summary, known limitations, provider session, event stream, ContextPack, PR
   body or commit message (`additionalProperties: false`). Allowed sources: EvidenceBundle (diff and check
   verdicts), WorkOrder (objective, requirement ids/statements, allowed paths, forbidden changes, invariants,
   acceptance check ids), trusted range diffs and post-image blobs, and — in re-review only — the prior
   round's adjudicated findings in structured form.
2. **Different model family.** Family is resolved from a policy registry by model id, never self-declared.
   R2 requires `familyOf(reviewer) ≠ familyOf(implementer)`; an unknown family fails closed.
3. **Fresh request.** Each review is one stateless request: `store: false`, no `previous_response_id`, no
   `conversation`, no tools, `tool_choice: "none"` (research register §1).
4. **Blind parallel reviewers.** Reviewers in one round never see each other's output.
5. **Separate credentials.** The reviewer credential is held by the reviewer adapter only; the coder's
   container env allowlist cannot carry it.
6. **Deterministic evidence outranks model review.** Adjudication never lets a model verdict clear a
   deterministic failure.

---

## 9. Prompt-injection model

The diff is attacker-controlled data (the coder is untrusted and repository content is untrusted;
`docs/operations/security-threat-model.md` "All repository and web text is untrusted data, not policy").
Defences, in order of strength:

1. **Authority never flows from content.** The model's free-text verdict is advisory. Adjudication derives the
   outcome from grounded findings and deterministic checks. A successful injection can therefore at most
   *suppress* model findings (a false negative that still lands at human review) or *add* findings (which
   escalate toward humans). It cannot push, merge, waive or approve past a deterministic failure.
2. **Instruction/data separation.** The rubric lives in `instructions`; all untrusted content goes in the user
   input, never in the developer message (OpenAI agent-builder safety guidance, research register §2).
3. **Spotlighting.** Untrusted content is delimited with a per-packet nonce and datamarked per line. The nonce
   is derived from the packet hash, so it is replayable yet cannot be embedded by the content it encloses (the
   content would have to contain the hash of a packet that contains it). Encoding (base64) is evaluated as an
   alternative in the injection suite rather than assumed.
4. **Strict structured output.** `text.format` JSON Schema with `strict: true`, then independent AJV validation
   on our side; unknown fields, tool calls, refusals, `incomplete` responses and citations outside the packet
   fail closed.
5. **Deterministic hazards are findings.** Bidirectional/invisible Unicode (Trojan Source) is a SECURITY
   finding from the deterministic checks.
6. **No silent truncation.** An over-budget packet escalates; a provider context overflow (truncation
   `disabled` returns 400) is classified and escalates.
7. **Measured, not asserted.** The injection suite reports detection with and without injection.

Second-order risk: reviewer finding text reaches the coder through the RepairOrder. It is rendered as bounded,
structured, cited data; the coder remains untrusted and sandboxed and its output is verified again.

---

## 10. Determinism and replayability

The reviewer is not deterministic and cannot be made so: with reasoning effort above `none`, `temperature`
and `top_p` are unsupported, and the Responses create endpoint exposes no seed (research register §1).
Replayability is therefore achieved by **record and replay**:

- packets and prompts are canonical bytes (sorted keys, no timestamps), so their SHA-256 identifies a request;
- the adapter stores the canonical request body (no credential) and the exact response bytes before parsing;
- a replay reviewer returns the recorded response for a request hash and fails closed on a miss;
- adjudication and scoring are pure functions of recorded inputs, so re-running them is byte-identical;
- the reviewer descriptor pins model id, reasoning effort, service tier, prompt-template hash and output-schema
  hash; the served model reported by the provider is recorded, and a mismatch fails the review (gating) or
  flags it (shadow);
- variance is measured (k runs), not hidden.

---

## 11. Adjudication rules (deterministic, versioned)

Evaluated in order; the first matching rule decides. `B` is the blocking set: deterministic findings with a
blocking disposition plus grounded model findings whose severity is in `blockingSeverities[risk]` and that no
human has refuted or waived.

| # | Condition | Gating | Shadow |
|---|---|---|---|
| 1 | Deterministic check with disposition `block` (secret in diff, forbidden path) | BLOCK | BLOCK (decision D-5) |
| 2 | Packet over budget | ESCALATE `packet-over-budget` | PROCEED (would-be recorded) |
| 3 | Mode `not-required` | PROCEED (deterministic findings carried to PR) | — |
| 4 | No eligible independent reviewer | ESCALATE `independence-unsatisfiable` | PROCEED (recorded) |
| 5 | A required review not `COMPLETED` and valid after bounded retries | ESCALATE `reviewer-unavailable` | PROCEED (recorded) |
| 6 | `B` empty and any reviewer verdict `ESCALATE` | ESCALATE `reviewer-escalated` | PROCEED (recorded) |
| 7 | `B` empty | PROCEED | PROCEED |
| 8 | `B` non-empty and `round ≥ maxRounds[risk]` | ESCALATE `max-repair-rounds` | PROCEED (recorded) |
| 9 | `B` non-empty | REPAIR | PROCEED (recorded) |

Further rules: a model `APPROVE` with a grounded blocking finding is decided by the finding; a
`REQUEST_CHANGES` with no grounded blocking finding is non-blocking ("generic comments do not block",
`docs/platform/verification-and-review.md:29-31`) and is counted as a verdict/finding mismatch; reviewer
findings are unioned and de-duplicated by fingerprint; in re-review a prior blocking finding marked `RESOLVED`
whose cited file (or cited resolution location) was not touched by the repair delta stays blocking with reason
`closure-without-change`; a model can never waive or refute a grounded HIGH/CRITICAL finding
(`docs/architecture/04-state-machines.md:48`); only an ungrounded finding can be machine-refuted, and only
with reason `citation-unresolvable`.

---

## 12. Repair and re-review

- `RepairOrder/v1` carries: task/attempt identity, round, `repairBaseSha` (= prior attempt's harness commit),
  `taskBaseSha`, the blocking findings (structured, cited, length-bounded), non-blocking findings for
  information, and the adjudication id.
- `buildRepairContextPack(original, repairOrder)` is a pure function that derives the repair attempt's
  ContextPack without changing the `context-pack` schema.
- The repair attempt's workspace is created at `repairBaseSha` (the harness commit exists in the shared object
  store); its evidence is honest about its own base.
- Round N+1 is a **re-review**: the packet carries the cumulative diff (`taskBaseSha..resultSha`), the repair
  delta (`repairBaseSha..resultSha`) and the prior findings with ids; the reviewer must return a closure status
  per prior blocking finding plus any new findings.
- `maxRounds` per risk is policy data (proposal: 2, matching the Phase 2 practice in
  `phase-02-risk-register.md:23` PR2-16); reaching it escalates.

---

## 13. Architecture and security checks

1. **Diff checks (pure, built-in):** secret patterns over **added** lines (parity-tested against
   `scripts/lib/secret-patterns.sh`), bidirectional/zero-width Unicode, changes to `forbiddenChanges` or outside
   `allowedPaths`, dependency manifest and lockfile changes (flagged for review, not blocked), and
   machine-checkable `ArchitectureInvariant` rules (`check.kind = "forbidden-import"`) over added import
   specifiers.
2. **Project tools via SARIF:** L4/L5 commands from approved project configuration already run in the
   no-network sandbox; Phase 4 parses a SARIF 2.1.0 subset from their artifacts into findings (`source:
   "sarif"`), fail-closed on malformed SARIF. No new third-party tool is added to the harness.
3. **Model rubric:** the reviewer rubric has explicit architecture and security sections that reference the
   WorkOrder invariants.
4. Raw check output is stored before any reduction (ADR 0009).

---

## 14. Measurement and dashboards

- **Runtime events.** Lane B's steps emit `attempt.declared_complete`, `attempt.completed`, `review.completed`,
  `repair.started`, `task.completed` and `human.intervention` through a `RunEventSink` into an append-only
  `run_events` table. `workflow.recovered` is an orchestration event that Lane A emits; until it does, the
  recovery panel reports `null` with reason "no source events" — never 0.
- **Evaluator.** A dictionary-driven evaluator computes each metric from events using the dictionary's own
  numerator/denominator/filter/zero-denominator policy and privacy class; results are written to
  `metric_snapshots`. Grafana panels read snapshots only, so formulas live in one place.
- **Dashboards.** Four provisioned dashboards: false completion, review yield (yield, false positives,
  adjudication coverage, repair success, reviewer failure, shadow would-block), cost (per accepted task,
  per review, cost coverage), recovery (workflow recovery rate, step adoption counts).
- **Telemetry completeness.** A panel compares terminal attempts in operational tables with emitted
  `attempt.completed` events, so a missing emission point is visible rather than silently shrinking a
  denominator.
- **Cost honesty.** Reviewer cost = recorded tokens × a configured price table with source and date; no price
  configured → `reviewCostUsd` omitted and cost coverage shows the gap. No price is invented.
- **Reviewer benchmark.** Capture (live, opt-in, network) and scoring (offline, deterministic) are separate
  stages (§10, `phase-04-architecture.md` §11). The pre-registered protocol is a committed document frozen
  before the first test-split run (S15).

---

## 15. Phase 2 lessons → structural countermeasures

| Lesson (Phase 2 reviews) | Countermeasure in this plan |
|---|---|
| A green gate that did not exercise the MUSTs | Every MUST maps to a named test in a **required** suite; an `exit-criteria-coverage` test parses the exit-criteria table and fails if a mapped file is missing, unregistered, or does not print its SUITE-ID. |
| Backends faked where real ones were required | Real PostgreSQL + real Git + real sandbox itests registered as required integration suites; the reviewer is faked only at the HTTP boundary with the real adapter code; the live reviewer is opt-in and its scorecard must come from recorded live responses. |
| Vocabulary without runtime emission | Dashboards are proven by a real-backend itest in which the driver emits events and the evaluator computes the expected values. |
| False implementer status claims | Report fields are generated from machine sources (scorecard JSON, gate logs, `git rev-parse`); counts are never hand-typed; anything not observed is written "not verified". |
| Green-by-absence for live dependencies | Missing gateway credential → live tests skip *with a recorded skip reason* and the verdict cannot reach the measured state. |

---

## 16. Lane A integration: the review-loop slot

Lane A owns workflow composition and defines the slot. Lane B delivers the functions below in
`packages/application/src/assurance/` (exported from `@asep/application`). All are framework-free; inputs and
outputs are JSON-serializable (proven by a round-trip test); identifiers are derived deterministically from
inputs so an activity retry converges; side effects go through ports. Full type definitions are in
`phase-04-architecture.md` §7.

```typescript
// Context the driver supplies (sequential driver or a durable engine's activity wrapper).
export interface AssuranceStepContext {
  readonly signal: AbortSignal;
  readonly now: () => string;                        // ISO-8601; steps never read the wall clock
  readonly heartbeat?: (progress: string) => void;
}

export interface AssuranceSlotInput {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly risk: RiskLevel;
  readonly round: number;                            // 1 = first attempt; +1 per repair attempt
  readonly evidenceId: ArtifactId;                   // persisted EvidenceBundle; resultSha = harness commit
  readonly workOrderRef: ArtifactRef;
  readonly taskBaseSha: string;                      // 40-hex; origin of the cumulative diff
  readonly implementer: { readonly providerId: string; readonly model: string };
  readonly declaredComplete: boolean;                // AgentAttemptObservation.status === 'AGENT_DONE'
  readonly priorAdjudicationId: string | null;       // non-null iff round > 1
}

export type AssuranceOutcome =
  | { readonly kind: 'PROCEED'; readonly adjudicationId: string; readonly mode: ReviewMode;
      readonly prBodySectionRef: ArtifactRef }
  | { readonly kind: 'REPAIR'; readonly adjudicationId: string; readonly repairOrderRef: ArtifactRef;
      readonly nextRound: number; readonly repairBaseSha: string }
  | { readonly kind: 'ESCALATE'; readonly adjudicationId: string; readonly reason: EscalationReason;
      readonly prBodySectionRef: ArtifactRef }
  | { readonly kind: 'BLOCK'; readonly adjudicationId: string; readonly reason: BlockReason };

// Composite: one call per round (Lane A may wrap it as a single activity) …
export function runAssuranceRound(
  deps: AssuranceDeps, input: AssuranceSlotInput, ctx: AssuranceStepContext,
): Promise<AssuranceOutcome>;

// … or the individual steps (Lane A may wrap each as its own activity).
export function planAssurance(input: AssuranceSlotInput, policy: ReviewPolicySnapshot,
  registry: ReviewerRegistrySnapshot): AssurancePlan;                                    // pure
export function buildReviewPacket(deps: BuildReviewPacketDeps, input: BuildReviewPacketInput,
  ctx: AssuranceStepContext): Promise<BuildReviewPacketOutput>;
export function runDeterministicChecks(deps: DeterministicCheckDeps, input: DeterministicCheckInput,
  ctx: AssuranceStepContext): Promise<DeterministicCheckOutput>;
export function runReviewer(deps: RunReviewerDeps, input: RunReviewerInput,
  ctx: AssuranceStepContext): Promise<RunReviewerOutput>;                                 // one reviewer
export function adjudicateRound(deps: AdjudicateDeps, input: AdjudicateInput,
  ctx: AssuranceStepContext): Promise<AssuranceOutcome>;

// Called at EVERY attempt terminal (including a verification stop), so false completion is complete.
export function recordAttemptOutcome(deps: { readonly events: RunEventSink }, input: AttemptOutcomeInput,
  ctx: AssuranceStepContext): Promise<void>;

// Pure helpers the workflow needs for the repair attempt and admission.
export function buildRepairContextPack(original: ContextPack, repair: RepairOrder): ContextPack;
export function admitWithAssurance(risk: RiskLevel, capability: AssuranceCapability): AdmissionResult;
```

**Contract Lane A's slot must honour** (also listed as SR-A1…A5 in §17): call the slot after evidence
persistence and before push; act on all four outcome kinds as in §7; create the repair attempt's workspace at
`repairBaseSha` and its context with `buildRepairContextPack`; call `recordAttemptOutcome` at every attempt
terminal; pass `admitWithAssurance` into admission. Lane B proves the same calls with its own thin sequential
driver (`runAssuredTask`, test/proof only) and a durable-shaped fake that retries each step at activity
granularity with no orchestration SDK.

---

## 17. Shared-surface change requests

Lane B edits **none** of these during planning. The controller reconciles them with Lane A's requests before
implementation. Full TypeScript for every new port is in `phase-04-architecture.md` §6; full DDL in
`phase-04-data-model.md` §3.

### 17.1 `packages/ports/src/index.ts`

| ID | Change | Compatibility |
|---|---|---|
| SR-P1 | Add `ReviewerProvider`, `ReviewerDescriptor`, `ReviewerBudget`, `ReviewerExecuteRequest`, `ReviewerUsage`, `ReviewerObservationStatus`, `ReviewerObservation` | additive |
| SR-P2 | Add `RunEventSink { append(scope, event: RunEvent): Promise<{ appended: boolean }> }` + `RunEventConflictError`; idempotent on `eventId`. Proposed as a **shared** port so Lane A can emit `workflow.recovered` through the same sink. | additive |
| SR-P3 | Add `ReviewSourceReader { diffRange(...); readBlobs(...) }` (trusted range diff + post-image blobs from a leased workspace) | additive |
| SR-P4 | Mark legacy `ReviewProvider` `@deprecated` (superseded by `ReviewerProvider`); no removal | none |

### 17.2 `packages/contracts/**`

| ID | Change | semver / compat |
|---|---|---|
| SR-C1 | `review-report.schema.json` → `2.0.0`, `$id …/review-report/v2`: required `reviewId, attemptId, round, packetSha256, reviewerConfigId, reviewerConfigSha256, requestedModel, servedModel, rawResponseArtifactId, verdict, findings, priorFindingStatuses`; optional `confidence` | MAJOR (new `$id` major); `snapshots/v1` copy unchanged |
| SR-C2 | `finding.schema.json` → `2.0.0`, `$id …/finding/v2`: adds required `source`, `fingerprint`; optional `grounded`, `groundingReason`, `ruleId`, `priorFindingId`; category enum adds `EVIDENCE_INTEGRITY` | MAJOR; `snapshots/v1` unchanged |
| SR-C3 | `src/compat-gate.ts`: resolve the comparison snapshot by the live `$id` major (`snapshots/v<major>/`); a live v2 schema without a v2 snapshot fails; the prior major's snapshot must still exist; self-test cases for both | gate behaviour tightened (no schema effect) |
| SR-C4 | New schemas `review-packet/v1`, `adjudication-record/v1`, `repair-order/v1` with fixtures (valid + invalid) and `snapshots/v1` entries | additive (new contracts) |
| SR-C5 | `run-event.schema.json` → `1.2.0`: optional `reviewRound`, `reviewerConfigId`, `reviewMode` (enum `not-required, shadow, gating`), `assuranceOutcome` (enum `PROCEED, REPAIR, ESCALATE, BLOCK`), `reviewFindingsAdjudicated`, `reviewFindingsBlocking`, `repairRound`, `repairClosedAllBlocking`, `reviewerFailed`, `shadowWouldBlock`; no new `eventType` | MINOR. If Lane A also bumps `run-event`, the controller merges both into one `1.2.0`. |
| SR-C6 | `architecture-invariant.schema.json` → `1.1.0`: optional `check { kind: "forbidden-import", fromGlobs, specifierPattern }` | MINOR |
| SR-C7 | `src/base.ts` `AttemptStatus` += `UNDER_REVIEW`, `CHANGES_REQUESTED` | additive union; persisted check constraint changed by SR-M4 |
| SR-C8 | Regenerated `src/generated.ts`; `snapshots/v2/{review-report,finding}.schema.json`; `templates/review-report.yaml` moved to v2 shape; `COMPATIBILITY.md` documents the per-major snapshot rule and the new contract count (16) | follows SR-C1…C6 |

### 17.3 Migrations (`adapters/persistence/src/migrations.ts`, Lane B range `0200`–`0299`)

| ID | Migration | Content |
|---|---|---|
| SR-M1 | `0200_assurance_reviews` | `review_rounds`, `review_records`, `review_findings`, `finding_dispositions`, `adjudications`, `reviewer_promotions` with composite tenant FKs |
| SR-M2 | `0201_run_events` | append-only `run_events` (update/delete rejected by trigger), unique `(organization_id, project_id, event_id)` |
| SR-M3 | `0202_metric_snapshots` | `metric_snapshots` |
| SR-M4 | `0203_attempt_review_states` | recreate the `attempts.status` check constraint with `UNDER_REVIEW`, `CHANGES_REQUESTED`. **Conflict risk:** if Lane A's `01xx` also recreates this constraint, whichever runs last wins and drops the other's values. The controller must merge both value sets into one migration. |

Also: one export line per new repository in `adapters/persistence/src/index.ts`.

### 17.4 Composition root

`apps/control-plane-api/src/production-root.ts`: **no change requested.** Lane B adds a sibling
`assurance-root.ts` (`assuranceSeams(...)`, fail-closed config; reviewer disabled only by an explicit literal,
mirroring `HOST_EXECUTION_WAIVER`). Lane A's composition imports it at integration time.

### 17.5 Required suites and gates

- `scripts/lib/canonical-tests.mjs` `REQUIRED_SUITES` += the 25 unit suite IDs listed in
  `phase-04-exit-criteria.md` §"Suite registry" (one of them, `asep-suite:contract-fixtures`, adds a marker
  line to the existing `packages/contracts/src/validate.test.ts`).
- `scripts/integration/lib.mjs` `REQUIRED_ITEST_SUITES` += `asep-suite:assurance-persistence-real`,
  `asep-suite:assurance-loop-real`, `asep-suite:assurance-dashboards-real`.
- `scripts/verify-all.sh`: **no change requested** (all new proofs run inside the canonical test runner).
- `scripts/integration/**` beyond `lib.mjs`: no change requested.
- `.github/workflows/**`: **no change requested.** The live benchmark never runs in CI.

### 17.6 Root build files and dependencies

- **No new third-party dependency.** The reviewer adapter uses Node's built-in `fetch` (stable since Node
  v21.0.0; the repo requires Node ≥ 24, root `package.json` `engines`); validation reuses `ajv` 8.20.0 already
  pinned in `@asep/contracts`.
- New workspace packages `adapters/reviewer-openai`, `adapters/reviewer-replay` → root `tsconfig.json`
  `references` += both; `pnpm-lock.yaml` importer entries for workspace links only. `pnpm-workspace.yaml`
  unchanged (`adapters/*` glob).
- `evals/package.json` dependencies += `@asep/application`, `@asep/reviewer-openai`, `@asep/reviewer-replay`
  (workspace); scripts `review-bench:capture`, `review-bench:score`; `evals/tsconfig.json` include/references.

### 17.7 `docs/platform/metrics-dictionary.yaml`

Add `review_adjudication_coverage`, `repair_success_rate`, `reviewer_failure_rate`,
`shadow_would_block_rate`, `review_escalation_rate`, `mean_review_cost_usd` (definitions in
`phase-04-data-model.md` §5). Existing metrics unchanged. Depends on SR-C5.

### 17.8 Other existing modules Lane A may also touch

| ID | File | Change |
|---|---|---|
| SR-X1 | `packages/application/src/governed-execution.ts` | optional `admit?: (risk: RiskLevel) => AdmissionResult` in `GovernedExecutionInput`, default `admitRisk` (byte-identical behaviour when absent) |
| SR-X2 | `packages/domain/src/operational.ts` | attempt edges `COMMITTED → UNDER_REVIEW → PUSHED`, `UNDER_REVIEW → CHANGES_REQUESTED` (terminal); existing `COMMITTED → PUSHED` kept |
| SR-X3 | `packages/application/src/index.ts`, `packages/policy/src/index.ts`, `packages/observability/src/index.ts`, `adapters/git-worktree/src/index.ts` | one export line each for Lane B's new modules |
| SR-X4 | `scripts/forbidden-imports.test.ts` | forbid `@temporalio/*` in Lane B paths; forbid global `fetch(`/`WebSocket` use in domain/application source (call pattern, not import); allow `fetch` in `adapters/reviewer-openai` |
| SR-X5 | `compose.yaml` | mount `deploy/grafana/provisioning` read-only into the Grafana service; dev-only data-source env |

### 17.9 Requests to Lane A (slot contract) and to the controller

| ID | Owner | Request |
|---|---|---|
| SR-A1 | Lane A | Slot between evidence persistence and push; act on `PROCEED/REPAIR/ESCALATE/BLOCK` as in §7 |
| SR-A2 | Lane A | Repair attempt: workspace at `repairBaseSha`; ContextPack via `buildRepairContextPack` |
| SR-A3 | Lane A | Call `recordAttemptOutcome` at every attempt terminal, including verification stops |
| SR-A4 | Lane A | Use `admitWithAssurance` through SR-X1 |
| SR-A5 | Lane A | Emit `workflow.recovered` through `RunEventSink` (SR-P2) |
| SR-G1 | Controller | Keep Phase 1/2 history reachable after merge (no squash), or tag every reviewed SHA the corpus cites, so the corpus stays reproducible from a clean clone |
| SR-G2 | Controller | Supply the reviewer gateway base URL and credential as environment variables for the live run (S16) and the opt-in smoke; the lane never reads secret files |

---

## 18. Directory ownership (Lane B, exclusive)

New directories and files Lane B owns. None overlaps an expected Lane A path (Temporal workers, workflow
packages, orchestration adapters). Existing modules Lane B must touch are listed in §17 instead.

```text
packages/application/src/assurance/**                    step use cases, pure core, slot, driver, tests
packages/domain/src/assurance.ts, assurance.test.ts      finding lifecycle + review-round state machines
packages/policy/src/review.ts, review.test.ts            review policy loader + parity tests
packages/observability/src/metric-eval.ts, metric-eval.test.ts, dashboards.test.ts
policies/review-policy.yaml                              reviewer registry, model families, severities, rounds
adapters/reviewer-openai/**                              OpenAI-compatible Responses reviewer (new package)
adapters/reviewer-replay/**                              recorded-response + scripted reviewer (new package)
adapters/persistence/src/assurance/**                    repositories, run-event sink, snapshot store, itests
adapters/git-worktree/src/review-source.ts, review-source.test.ts
adapters/agent-claude/src/reviewer-credential-isolation.test.ts
apps/control-plane-api/src/assurance-root.ts, assurance-root.test.ts
apps/control-plane-api/src/assurance/**                  CLI, real-backend loop + dashboard itests
evals/review-corpus/**                                   corpus manifest, items, verifier
evals/review-benchmark/**                                capture, scorer, protocol fixtures, recorded runs, scorecards
deploy/grafana/**                                        provisioning + dashboard JSON
docs/implementation/phases/phase-04-*.md
```

---

## 19. Slices (one per future commit)

Each slice: read the mapped exit criteria → tests first where sensible → smallest change → slice gate
(`pnpm verify:all`; plus `pnpm test:integration` when the slice adds or changes an itest) → review the diff →
commit. Shared-surface slices (S1, S2, S7 migrations, S11 SR-X1/X2) start only after the controller has
reconciled §17.

| Slice | Deliverable | Acceptance checks (all executable) | Commit |
|---|---|---|---|
| S1 | SR-C1…C8: v2 review/finding, new schemas, run-event 1.2.0, invariant 1.1.0, per-major compat gate | compat gate PASS; new self-test: an edit to a v2 schema without a v3 bump fails, a v2 schema without a v2 snapshot fails; v1 snapshots byte-identical (digest test); drift guard; fixtures accept/reject; template validates | `feat(contracts): version review, finding and adjudication contracts for independent assurance` |
| S2 | SR-P1…P4 ports | typecheck; a structural test that legacy `ReviewProvider` callers (none) still compile; port docs | `feat(ports): add packet-only reviewer, run-event sink and review-source ports` |
| S3 | `policies/review-policy.yaml` + loader | parity test YAML ↔ TS; unknown model family fails closed; same-family reviewer rejected for R2; matrices in `approval-matrix.yaml`/`verification-matrix.yaml` byte-unchanged | `feat(policy): declare reviewer independence, blocking severities and repair limits as data` |
| S4 | finding lifecycle + review-round machines; SR-X2 | table-driven transition tests; a model actor cannot waive HIGH/CRITICAL; waiver needs human + rationale + expiry | `feat(domain): finding lifecycle and review-round state machines` |
| S5 | packet builder, prompt renderer, independence checks | canary strings planted in coder summary/limitations/events/ContextPack never appear in packet, prompt or request bytes; packet bytes identical across two builds; nonce derivation test; over-budget → `overBudget=true`, never truncated | `feat(assurance): build an independent review packet and a spotlighted prompt` |
| S6 | diff checks, SARIF subset, grounding, adjudication, repair order | seeded-violation self-tests per check; secret-pattern parity with `scripts/lib/secret-patterns.sh`; adjudication table covers every rule row and both modes; grounding rejects out-of-packet citations | `feat(assurance): deterministic checks, grounding, adjudication and repair orders` |
| S7 | SR-M1…M4, repositories, run-event sink, snapshot store | PGlite fast suite + real-PG itest: tenant IDOR read/write rejected; append-only enforced by trigger; idempotent append; concurrent `PENDING` claim on one review id yields one winner | `feat(persistence): persist review rounds, findings, adjudications and run events` |
| S8 | `ReviewSourceReader` in git-worktree | real temp-repo tests: range diff exact; binary/too-large/submodule/deleted reported, never silently dropped; path traversal rejected | `feat(workspace): trusted range diffs and post-image blobs for review` |
| S9 | `adapters/reviewer-openai` | local fake HTTP server tests for every row of EC G1–G6; exact request body asserted (`store:false`, no tools, strict schema, no `previous_response_id`); credential canary never in artifacts/logs; opt-in live smoke skips with a recorded reason | `feat(reviewer): add an OpenAI-compatible Responses reviewer behind the reviewer port` |
| S10 | `adapters/reviewer-replay` | replay returns recorded bytes for a hash, fails closed on a miss; scripted provider is marked fake in its descriptor | `feat(reviewer): deterministic replay and scripted reviewers` |
| S11 | step use cases, slot composite, `admitWithAssurance`, events, `runAssuredTask`, durable-shaped fake; SR-X1 | JSON round-trip of every input/output; resume after a crash at each step boundary converges; shadow mode changes no task/attempt state; max rounds escalates; durable-shaped fake drives the steps with retries | `feat(assurance): idempotent review, adjudication and repair step use cases` |
| S12 | `assurance-root.ts`, CLI, real-backend loop itest | itest on real PG + real Git + real sandbox + real adapter against the fake HTTP server: PROCEED, REPAIR→re-review→PROCEED, ESCALATE, BLOCK (forge spy: zero pushes) | `feat(control-plane): compose the independent reviewer and its assurance loop` |
| S13 | evaluator, snapshots, CLI report, Grafana provisioning | golden tests on fixture events (labelled fixtures); real-backend itest: values computed from events the S12 loop emitted equal hand-derived expectations; nulls carry reasons; every panel ↔ dictionary metric; restricted metrics hidden unless opted in | `feat(observability): evaluate dictionary metrics and provision assurance dashboards` |
| S14 | `evals/review-corpus` manifest + verifier | verifier checks every item against git (advertised-ref reachability, cited file exists at reviewed SHA, line range inside file, fix-commit subject carries the id, id appears in the cited review doc); exclusions enumerated; manifest hash recorded | `feat(evals): curate the review-history defect corpus with git-verified provenance` |
| S15 | protocol doc, scorer, matcher, baselines, injection suite, rescore test | rescoring committed recordings twice is byte-identical; scorer refuses fake recordings for `self-history`; test-split guard; Wilson intervals unit-tested | `feat(evals): pre-registered protocol and deterministic reviewer scorecard` |
| S16 | live capture on the frozen corpus; scorecard; `phase-04-report.md` | recorded responses + manifest hashes committed; controller can rescore offline byte-identically; report fields generated from machine sources | `docs(phase-4): record reviewer measurement on the review-history corpus` |
| S17 | runbook + executable rehearsal | injected 429 storm, 503, malformed output, cost budget exceeded, served-model drift and reviewer disabled each reach the documented decision on real mechanisms | `docs(phase-4): assurance runbook and executable fault rehearsal` |

---

## 20. Task DAG

```text
S1 ──┬─> S2 ──┬─> S5 ──> S6 ──┐
     │        ├─> S8 ─────────┤
     │        ├─> S9 ─────────┼─> S11 ──> S12 ──> S13
     │        └─> S10 ────────┤                     │
     ├─> S3 ──┘               │                     │
     ├─> S4 ──────────────────┤                     │
     └─> S7 ──────────────────┘                     │
S5 + S6 + S10 ──> S14 ──> S15 ──> S16 <── S9         │
S12 + S13 + S16 ─────────────────> S17 <────────────┘
```

Acyclic. S14/S15 do not depend on persistence; S16 needs the live adapter and a credential (SR-G2).

---

## 21. Exit criteria and verdict vocabulary

The numbered, test-mapped MUST list is `phase-04-exit-criteria.md`. Verdicts:

| Verdict | Condition |
|---|---|
| `COMPLETE` | every MUST, including I6 (live measurement on the self-history corpus) and I8 (measurement on an independent pilot-repository corpus) |
| `IMPLEMENTATION_COMPLETE_MEASURED_ON_SELF_HISTORY` | every MUST except I8 |
| `IMPLEMENTATION_COMPLETE_MEASUREMENT_PENDING` | every MUST except I6 and I8 (e.g. no gateway credential) |

Each verdict carries the suffix `_UNREVIEWED` until the controller's independent final review accepts it. A
gating promotion of the reviewer (which unlocks R2) is **not** an exit criterion; it is a human decision made
from the scorecard after the phase.

---

## 22. Rollback

Per-slice commits on the lane branch; `main` untouched until the controller merges. The assurance slot is
inert until Lane A wires it, and R2 stays `DEFERRED` unless a promotion record exists, so reverting any Lane B
slice restores Phase 2 behaviour. Migrations are append-only; tables are additive; SR-M4 widens a check
constraint (rollback = a forward migration that narrows it after no row uses the new values).

---

## 23. Open decisions (controller/user)

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-1 | How to evolve the review contracts | (a) MAJOR `review-report/v2` + `finding/v2` with the per-major compat gate (SR-C1–C3); (b) leave v1 frozen and add new logical contracts (`review-record/v1`, `review-finding/v1`) with no gate change | (a): it is the documented route (`COMPATIBILITY.md:31-33`) and it closes a latent gate gap; (b) has less churn but leaves a dead v1 contract beside the live one |
| D-2 | Does a promoted model reviewer satisfy R1's "1 independent reviewer"? | yes (R1 and R2) / no (R2 only; R1 keeps the Phase 2 human review) | yes for R1 and R2, only in gating mode with a valid promotion; R2 still needs human merge |
| D-3 | Promotion threshold for gating mode | numeric threshold pre-committed now / human decision from the scorecard | human decision (ADR 0014) with the scorecard attached; no number is invented in the plan |
| D-4 | Different-family comparator reviewer for measurement only | none / add one comparator configuration | optional; it would quantify the labeller bias in §6.2(2) at extra cost |
| D-5 | Run the deterministic push guard (secret in diff, forbidden path) for every admitted risk, including R0 | yes / only where L5 is mandatory (R3+) | yes: it only adds a fail-closed stop before an irreversible push; it does not change `verification-matrix.yaml` |
| D-6 | Must Grafana actually load the provisioning inside the required integration gate? | yes (adds a digest-pinned Grafana container to the gate) / no (structural tests + evaluator itest required; Grafana load is an opt-in smoke) | no for Phase 4, recorded as a known limitation; the evaluator and snapshots are the authoritative proof |
| D-7 | Proposed policy values: `maxRounds` R1/R2 = 2; `blockingSeverities` R1 = {CRITICAL, HIGH}, R2 = {CRITICAL, HIGH, MEDIUM}; minimum descriptive-only sample size 20 | accept / amend | accept as starting values; they are data in `review-policy.yaml` and the protocol |

---

## 24. Blocking questions

1. **Gateway credential for measurement (SR-G2).** Implementation and every non-live gate need no
   credential. The live run (S16, EC I6) needs the gateway base URL and a credential supplied as environment
   variables by the controller. If unavailable, the honest verdict is
   `IMPLEMENTATION_COMPLETE_MEASUREMENT_PENDING`. The gateway was not probed in this session (not verified).
2. **Pilot repository (EC I8).** Same dependency as Phase 1 PP1/PP2 and Phase 2 K2/K6. Not needed for
   implementation.

Neither blocks planning.

---

## Output

```text
PLAN_STATUS: DRAFT v1 — awaiting controller Codex plan review
BASE_SHA: 00a68895d205122767167942326e2e0466571059 (Phase 2 not accepted)
BASELINE: pnpm install --frozen-lockfile exit 0; pnpm verify:all PASS (548 tests / 50 files / 28 required suites)
PLAN_FILES:
  - docs/implementation/phases/phase-04-plan.md
  - docs/implementation/phases/phase-04-architecture.md
  - docs/implementation/phases/phase-04-data-model.md
  - docs/implementation/phases/phase-04-exit-criteria.md
  - docs/implementation/phases/phase-04-risk-register.md
  - docs/implementation/phases/phase-04-research-register.md
  - docs/implementation/phases/phase-04-threat-model-delta.md
  - docs/implementation/phases/phase-04-review-log.md (empty skeleton)
NEW_THIRD_PARTY_DEPENDENCIES: none
SHARED_SURFACE_REQUESTS: §17 (ports 4, contracts 8, migrations 4, suites 28, root build 3, dictionary 1, other 5, Lane A 5, controller 2)
OPEN_DECISIONS: D-1 … D-7
READY_FOR_IMPLEMENTATION: no — plan review, adjudication and §17 reconciliation first
```
