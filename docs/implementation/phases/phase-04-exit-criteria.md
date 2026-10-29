# Phase 4 — Exit Criteria (DRAFT v1, machine-checkable)

> Phase 4 reaches a verdict only from a clean checkout. Base `00a6889`. Draft for the controller's Codex plan
> review; not locked.
> `[ ]` unmet · `[x]` met with evidence in `artifacts/phase-04/` or a committed scorecard.
> Verdicts (`phase-04-plan.md` §21): **COMPLETE** (every MUST incl. I6 + I8) ·
> **IMPLEMENTATION_COMPLETE_MEASURED_ON_SELF_HISTORY** (all but I8) ·
> **IMPLEMENTATION_COMPLETE_MEASUREMENT_PENDING** (all but I6 + I8); suffix `_UNREVIEWED` until the
> controller's independent final review.

## How MUSTs map to tests

Every MUST names the executable proof that will demonstrate it. Proof kinds:

- `unit` — a `*.test.ts` file registered in `REQUIRED_SUITES` (`scripts/lib/canonical-tests.mjs`) and run by
  `pnpm verify:all`;
- `itest` — a `*.itest.ts` file registered in `REQUIRED_ITEST_SUITES` (`scripts/integration/lib.mjs`) and
  run by `pnpm test:integration` against real digest-pinned PostgreSQL, object storage and Docker;
- `gate` — a step of `scripts/verify-all.sh` or the integration gate itself;
- `live` — an opt-in run that needs the reviewer gateway credential (SR-G2); its *output* is committed and its
  *re-scoring* is a `unit` proof;
- `review` — judged by the controller's independent review (kept to the minimum; listed explicitly).

`packages/application/src/assurance/exit-criteria-coverage.test.ts` parses the table below and fails if a
`unit`/`itest` row names a file that does not exist, is not registered under the stated suite id, or does not
print `SUITE-ID: <id>` at module load. This is the structural guard against a green gate that never exercised
a MUST. Test names are planned names (stable behaviour descriptions, no phase or finding codes).

## A. Baseline and build integrity

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| A1 | `pnpm install --frozen-lockfile` then `pnpm verify:all` green from a clean checkout | gate | `scripts/verify-all.sh` | — |
| A2 | `pnpm test:integration` green, including the three new required itest suites | gate | `scripts/integration/run-integration.mjs` | — |
| A3 | `schema/snapshots/v1/*` byte-identical to `00a6889` (no silent v1 edit) | unit | `packages/contracts/src/compat-gate.test.ts` › "frozen v1 snapshots keep their recorded digests" | `asep-suite:compat-gate` |
| A4 | Working tree clean after the full gate | gate | `verify-all.sh` clean-tree step | — |
| A5 | No Lane B path imports `@temporalio/*` or any Lane A package; domain/application source calls no global `fetch`/`WebSocket` | unit | `scripts/forbidden-imports.test.ts` › "assurance code imports no orchestration engine" and "pure layers make no network call through globals" (+ seeded self-checks) | `asep-suite:forbidden-imports` |

## B. Contracts and versioning

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| B1 | `review-report/v2` and `finding/v2` carry required provenance; `$id` major is 2; `snapshots/v2` frozen | unit | `packages/contracts/src/compat-gate.test.ts` › "a live v2 schema is compared against its frozen v2 snapshot" | `asep-suite:compat-gate` |
| B2 | Compat gate: an edit to a v2 schema without a v3 bump fails; a live v2 schema with no v2 snapshot fails; deleting the v1 snapshot of a v2 schema fails | unit | `compat-gate.test.ts` › "per-major snapshot selection rejects an unguarded v2 edit" | `asep-suite:compat-gate` |
| B3 | `review-packet/v1`, `adjudication-record/v1`, `repair-order/v1` exist with valid and invalid fixtures; the validator accepts/rejects each | unit | `packages/contracts/src/validate.test.ts` › existing tests "every valid fixture is accepted", "every invalid fixture is rejected with a real error", "every contract has at least one valid and one invalid fixture" (file gains a suite marker) | `asep-suite:contract-fixtures` |
| B4 | `run-event` 1.2.0 is additive only (compat gate MINOR); every new dictionary operand exists on `RunEvent` | unit | `packages/observability/src/metric-eval.test.ts` › "dictionary operands resolve against run-event 1.2.0" | `asep-suite:metric-eval` |
| B5 | The model-facing output schema is strict-compatible (every property required, optional values nullable, no unsupported keywords) and maps deterministically to `review-report/v2` | unit | `adapters/reviewer-openai/src/reviewer-openai.test.ts` › "model-facing schema is strict-compatible and maps to the canonical report" | `asep-suite:reviewer-openai` |

## C. Reviewer independence (ADR 0010)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| C1 | Unique canary strings planted in the coder's summary, known limitations, event artifacts and ContextPack never appear in the packet, the prompt or the raw request bytes | unit | `packages/application/src/assurance/packet.test.ts` › "coder self-report never reaches the reviewer" | `asep-suite:review-packet` |
| C2 | The packet schema has no field that can carry coder self-report, ContextPack, commit message, PR body or another reviewer's output | unit | `packet.test.ts` › "packet schema whitelists trusted sources only" | `asep-suite:review-packet` |
| C3 | R2 requires a reviewer whose policy-resolved family differs from the implementer's; same family and unknown family fail closed | unit | `packages/policy/src/review.test.ts` › "independence requires a different resolved model family" | `asep-suite:review-policy` |
| C4 | Every reviewer request has `store:false`, no `previous_response_id`/`conversation`, no tools, `tool_choice:"none"`, `truncation:"disabled"` | unit | `reviewer-openai.test.ts` › "request body is stateless and tool-free" | `asep-suite:reviewer-openai` |
| C5 | The reviewer credential never reaches the coder container env, an artifact, a log line or a DB row | unit + itest | `adapters/agent-claude/src/reviewer-credential-isolation.test.ts` › "agent env allowlist cannot carry the reviewer credential"; `apps/control-plane-api/src/assurance/assurance-loop.itest.ts` › "credential canary absent from artifacts, logs and rows" | `asep-suite:reviewer-credential-isolation`, `asep-suite:assurance-loop-real` |
| C6 | Reviewers in one round are blind to each other | unit | `packages/application/src/assurance/steps.test.ts` › "parallel reviewers receive identical packets without peer output" | `asep-suite:assurance-steps` |

## D. Prompt-injection resistance

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| D1 | Untrusted content appears only in the user input, delimited with the packet-derived nonce and datamarked per line; the rubric contains no untrusted byte | unit | `packages/application/src/assurance/prompt.test.ts` › "untrusted content is spotlighted outside the instructions" | `asep-suite:review-prompt` |
| D2 | A model verdict never clears a deterministic failure; `APPROVE` with a grounded blocking finding still blocks; injected verdict text has no effect beyond findings | unit | `packages/application/src/assurance/adjudication.test.ts` › "model verdict cannot override findings or deterministic failures" | `asep-suite:adjudication` |
| D3 | Unknown fields, tool-call items, refusals, `incomplete` responses and citations outside the packet fail closed (never PROCEED in gating mode) | unit | `reviewer-openai.test.ts` › "malformed provider output fails closed"; `grounding.test.ts` › "citations outside the packet are refuted" | `asep-suite:reviewer-openai`, `asep-suite:review-grounding` |
| D4 | Bidirectional and zero-width Unicode in added lines produces a deterministic SECURITY finding | unit | `packages/application/src/assurance/checks.test.ts` › "invisible and bidirectional characters are flagged" | `asep-suite:assurance-checks` |
| D5 | The synthetic injection suite runs through the scorer and reports detection with and without injection (a reported measurement, not a pass threshold) | unit | `evals/review-benchmark/injection-suite.test.ts` › "injection suite executes and reports paired deltas" | `asep-suite:review-injection-suite` |
| D6 | No silent truncation: an over-budget packet escalates (gating) without calling the reviewer; a provider context overflow is classified and escalates | unit | `packet.test.ts` › "over-budget packet is flagged, never cut"; `adjudication.test.ts` › "over-budget and context overflow escalate" | `asep-suite:review-packet`, `asep-suite:adjudication` |

## E. Review, adjudication and repair loop

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| E1 | Every step input/output survives a JSON round trip; ids are derived deterministically from inputs | unit | `steps.test.ts` › "step contracts are serializable and ids are input-derived" | `asep-suite:assurance-steps` |
| E2 | A crash at each step boundary resumes to one review record per `reviewId`, one adjudication per round; duplicate model calls are counted | unit + itest | `steps.test.ts` › "resume after a crash at every step boundary converges"; `adapters/persistence/src/assurance/assurance-persistence.itest.ts` › "concurrent claims on one review id yield one winner" | `asep-suite:assurance-steps`, `asep-suite:assurance-persistence-real` |
| E3 | Adjudication is a pure function with a recorded rule, policy version and input hashes; every rule row × mode is covered | unit | `adjudication.test.ts` › "rule table is total and deterministic" | `asep-suite:adjudication` |
| E4 | Deterministic findings outrank model review; findings from all reviewers are unioned and de-duplicated by fingerprint | unit | `adjudication.test.ts` › "deterministic evidence outranks model review" | `asep-suite:adjudication` |
| E5 | A repair order carries only grounded blocking findings (plus capped informational ones), `repairBaseSha` = prior harness commit, bounded sizes; the next round is a re-review with closure statuses | unit | `packages/application/src/assurance/repair.test.ts` › "repair order is bounded and anchored to the prior commit" | `asep-suite:repair-order` |
| E6 | A prior blocking finding reported `RESOLVED` without a change at the cited or resolution location stays blocking (`closure-without-change`) | unit | `adjudication.test.ts` › "closure without change keeps the finding open" | `asep-suite:adjudication` |
| E7 | `maxRounds` reached → ESCALATE; the loop never exceeds the policy bound | unit | `packages/application/src/assurance/driver.test.ts` › "repair loop is bounded by policy" | `asep-suite:assurance-driver` |
| E8 | Reviewer failure (provider error, malformed, refused, budget, served-model drift) never yields PROCEED in gating mode | unit | `adjudication.test.ts` › "reviewer failure escalates in gating mode" | `asep-suite:adjudication` |
| E9 | Shadow mode changes no task/attempt state and no push decision except rule 1; the would-be outcome is recorded | unit | `driver.test.ts` › "shadow mode records but does not decide" | `asep-suite:assurance-driver` |
| E10 | The thin driver runs the full loop on real PostgreSQL + real Git worktree + real sandbox, with the real reviewer adapter against a local fake HTTP server: PROCEED; REPAIR → re-review → PROCEED; ESCALATE; BLOCK with zero pushes | itest | `assurance-loop.itest.ts` › "assured task reaches each outcome on real backends" | `asep-suite:assurance-loop-real` |
| E11 | A durable-shaped fake (no orchestration SDK) drives each step as an activity with injected failures, retries and cancellation and converges to the same outcomes | unit | `driver.test.ts` › "activity-granular composition converges under retries" | `asep-suite:assurance-driver` |

## F. Architecture and security checks

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| F1 | Diff checks: secrets in added lines (pattern parity with `scripts/lib/secret-patterns.sh`), invisible Unicode, forbidden/out-of-scope paths, dependency/lockfile changes, `forbidden-import` invariants — each with a seeded-violation self-check | unit | `checks.test.ts` › "each diff check catches its seeded violation" and "secret patterns match the repository scanner" | `asep-suite:assurance-checks` |
| F2 | A secret in the diff BLOCKs before any push for every admitted risk (decision D-5) | itest | `assurance-loop.itest.ts` › "secret in diff blocks with zero forge calls" | `asep-suite:assurance-loop-real` |
| F3 | SARIF 2.1.0 subset from L4/L5 artifacts parses into `source:"sarif"` findings; malformed SARIF fails closed | unit | `checks.test.ts` › "sarif results become findings and malformed sarif fails closed" | `asep-suite:assurance-checks` |
| F4 | Check reports are stored as artifacts before any reduction | unit | `steps.test.ts` › "check report is persisted before adjudication reads it" | `asep-suite:assurance-steps` |

## G. Reviewer adapter (provider DoD: malformed output, rate limit, cancellation, budget, event order, permission, artifact capture)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| G1 | Pinned model and config hash recorded; served model recorded; drift fails the review in gating, flags it in shadow | unit | `reviewer-openai.test.ts` › "served-model drift is detected" | `asep-suite:reviewer-openai` |
| G2 | Canonical request (no credential) and exact response bytes are persisted before parsing | unit | `reviewer-openai.test.ts` › "raw request and response are captured before parsing" | `asep-suite:reviewer-openai` |
| G3 | Malformed JSON, partial body, refusal, `incomplete`, `failed`, tool-call items and multiple text items each classify correctly and fail closed | unit | `reviewer-openai.test.ts` › "every malformed shape is classified" | `asep-suite:reviewer-openai` |
| G4 | 429/503 honour `Retry-After`, else bounded exponential backoff with jitter; 401/403 and quota errors are not retried; fake clock | unit | `reviewer-openai.test.ts` › "retries are bounded and policy-correct" | `asep-suite:reviewer-openai` |
| G5 | `AbortSignal` cancels in flight; wall-clock budget enforced; `max_output_tokens` sent | unit | `reviewer-openai.test.ts` › "cancellation and budgets are enforced" | `asep-suite:reviewer-openai` |
| G6 | `baseUrl` must be https and allowlisted; redirects are refused | unit | `reviewer-openai.test.ts` › "endpoint is allowlisted and redirects are refused" | `asep-suite:reviewer-openai` |
| G7 | The live smoke is opt-in, skips with a recorded reason when the credential is absent, never prints the credential | unit | `reviewer-openai.test.ts` › "live smoke entry point skips cleanly without a credential" (drives the entry point used by the opt-in `reviewer-openai.live.test.ts`) | `asep-suite:reviewer-openai` |
| G8 | Replay returns recorded bytes for a request hash, fails closed on a miss or a manifest hash mismatch; the scripted provider is marked fake | unit | `adapters/reviewer-replay/src/reviewer-replay.test.ts` › "replay is exact and fails closed" | `asep-suite:reviewer-replay` |

## H. Persistence and events

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| H1 | Migrations `0200`–`0203` apply forward on a clean PostgreSQL, re-apply as a no-op, and stay within the Lane B id range | unit + itest | `adapters/persistence/src/assurance/assurance-persistence.test.ts` › "assurance migrations apply once and stay in range"; itest on real PG | `asep-suite:assurance-persistence`, `asep-suite:assurance-persistence-real` |
| H2 | Review rounds, records, findings, dispositions, adjudications and promotions are tenant-scoped; cross-project read and write fail at the DB boundary | itest | `assurance-persistence.itest.ts` › "cross-project review access fails closed" | `asep-suite:assurance-persistence-real` |
| H3 | `run_events` is append-only (UPDATE/DELETE rejected), idempotent on `eventId`, conflicting bytes rejected, every row validates against its declared version | itest | `assurance-persistence.itest.ts` › "run events are append-only and idempotent" | `asep-suite:assurance-persistence-real` |
| H4 | Disposition rules are DB-enforced: waiver needs human + expiry + signature; a reviewer actor can only set closure statuses | itest | `assurance-persistence.itest.ts` › "disposition actor rules are enforced by the database" | `asep-suite:assurance-persistence-real` |
| H5 | `recordAttemptOutcome` at every terminal produces `attempt.declared_complete` + `attempt.completed`, including verification stops | unit | `steps.test.ts` › "every attempt terminal emits its outcome events" | `asep-suite:assurance-steps` |

## I. Reviewer measurement on historical defects (the exit criterion)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| I1 | The self-history corpus manifest is frozen (sha256 recorded) and every item's claims are git-verified: reviewed SHA reachable from advertised refs (else excluded `tree-unreachable`), cited file exists at that SHA, cited lines inside the file, fix-commit subject carries the id, id present at the cited review-doc line; exclusions enumerated with reasons | unit | `evals/review-corpus/corpus-verifier.test.ts` › "every corpus claim is verified against git" | `asep-suite:review-corpus` |
| I2 | Leakage: no packet contains a review artifact (`*review*`, review logs), git metadata or a commit message; packets are built at the reviewed SHA, never at the parent of a fix commit | unit | `evals/review-benchmark/scorer.test.ts` › "packets exclude review artifacts and history" | `asep-suite:review-benchmark` |
| I3 | Split discipline: a test-split scorecard is rejected unless corpus, protocol and reviewer config hashes equal the values frozen before the first test-split run | unit | `scorer.test.ts` › "test split is scored only under the frozen configuration" | `asep-suite:review-benchmark` |
| I4 | Scoring is deterministic and offline: re-scoring every committed recording twice yields byte-identical scorecards; no model is called while scoring | unit | `scorer.test.ts` › "committed recordings rescore byte-identically" | `asep-suite:review-benchmark` |
| I5 | The scorecard reports n and Wilson 95% intervals for strict and lenient recall (all, first-occurrence, labeller-miss subset, per severity, per defect class), precision over adjudicated findings plus the unadjudicated count, stale-flag rate, k-run stability, failure rates, tokens, cost or null, and both baselines; cells with n < 20 are marked descriptive-only | unit | `scorer.test.ts` › "scorecard carries every required field with intervals" | `asep-suite:review-benchmark` |
| I6 | A live measurement run of the pinned reviewer on the frozen corpus exists: recordings and manifest committed, scorecard committed, the scorer refuses fake/scripted recordings for a `self-history` scorecard | live + unit | capture via `pnpm --filter @asep/evals review-bench:capture`; `scorer.test.ts` › "measurement scorecards come only from live recordings" | `asep-suite:review-benchmark` |
| I7 | The report states the corpus biases (§6.2 of the plan), uses the verdict vocabulary, and claims nothing beyond `scope` | review | controller review of `phase-04-report.md` against the scorecard `scope` field | — |
| I8 | An independent pilot-repository corpus (human-labelled) is measured with the same protocol | live + unit | as I6 with `scope: "pilot-history"` | `asep-suite:review-benchmark` |

## J. Dashboards (false completion, review yield, cost, recovery)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| J1 | The evaluator implements every dictionary aggregation, filter and zero-denominator policy; golden values on labelled fixture events | unit | `packages/observability/src/metric-eval.test.ts` › "evaluator matches golden values for every dashboard metric" | `asep-suite:metric-eval` |
| J2 | No source events → value `null` with the dictionary's reason, never 0 (covers `workflow_recovery_rate` until Lane A emits, `escaped_defect_rate`) | unit | `metric-eval.test.ts` › "missing source events yield null with a reason" | `asep-suite:metric-eval` |
| J3 | Every panel reads `metric_snapshots` for a metric that exists in the dictionary; every required metric has a panel; four dashboards exist | unit | `packages/observability/src/dashboards.test.ts` › "panels and dictionary metrics correspond one to one" | `asep-suite:assurance-dashboards` |
| J4 | On real PostgreSQL, snapshot values computed from the events the E10 loop emitted equal hand-derived expectations for that run | itest | `apps/control-plane-api/src/assurance/assurance-dashboards.itest.ts` › "snapshots computed from real emitted events" | `asep-suite:assurance-dashboards-real` |
| J5 | Telemetry completeness compares terminal attempts with emitted `attempt.completed` events and exposes the gap | itest | `assurance-dashboards.itest.ts` › "telemetry completeness exposes a missing emission" | `asep-suite:assurance-dashboards-real` |
| J6 | Reviewer cost = recorded tokens × configured price; no price → `reviewCostUsd` omitted and cost coverage shows the gap | unit | `metric-eval.test.ts` › "unpriced reviews are reported as uncovered, never zero" | `asep-suite:metric-eval` |
| J7 | Restricted-class metrics are computed only when capture is enabled for the project | unit | `metric-eval.test.ts` › "restricted metrics respect opt-in capture" | `asep-suite:metric-eval` |

## K. Risk admission and human accountability

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| K1 | R2 is admitted only with a gating reviewer whose promotion record is valid (signed, unexpired, config hash equal); otherwise R2 stays `DEFERRED` exactly as in Phase 2; table over R0–R4 × {no reviewer, shadow, promoted, expired, config-changed} | unit | `packages/application/src/assurance/admission.test.ts` › "R2 admission requires a valid promotion" | `asep-suite:assurance-admission` |
| K2 | R3/R4 remain `DEFERRED` | unit | `admission.test.ts` › "R3 and R4 stay deferred" | `asep-suite:assurance-admission` |
| K3 | Without SR-X1's `admit` argument, `governedExecution` behaves byte-identically to Phase 2 (existing governed-execution suite unchanged and green) | unit | `packages/application/src/governed-execution.test.ts` (unchanged) | `asep-suite:governed-execution` |
| K4 | Phase 1 policy parity tests unchanged; `approval-matrix.yaml` and `verification-matrix.yaml` byte-identical | unit | `packages/policy/src/review.test.ts` › "phase-one matrices are unchanged" | `asep-suite:review-policy` |
| K5 | A model cannot waive or refute a grounded HIGH/CRITICAL finding; a waiver needs a named human, rationale, expiry and signature; an expired waiver reopens the finding | unit | `packages/domain/src/assurance.test.ts` › "only humans waive, and waivers expire" | `asep-suite:finding-lifecycle` |
| K6 | An R2 task with assurance not satisfied cannot be recorded `ACCEPTED` without a fresh passing review or a human waiver | unit | `admission.test.ts` › "acceptance is refused while assurance is unsatisfied" | `asep-suite:assurance-admission` |
| K7 | `WAITING_FOR_HUMAN_REVIEW` remains the machine ceiling; no merge capability is added | unit | `driver.test.ts` › "the assured path ends at human review and never merges" | `asep-suite:assurance-driver` |
| K8 | The assurance composition root fails closed: missing reviewer config throws unless the explicit disabled literal is given; a disabled reviewer makes R2 `DEFERRED` | unit | `apps/control-plane-api/src/assurance-root.test.ts` › "reviewer configuration fails closed" | `asep-suite:assurance-root` |

## L. Completion protocol

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| L1 | `phase-04-report.md` present; machine fields (counts, hashes, SHAs) generated from scorecards, gate logs and `git rev-parse`, never typed by hand; a completion sentinel written last carries `git rev-parse HEAD` (same protocol as Phase 2 L1) | review + gate | controller compares sentinel SHA with `git rev-parse HEAD` | — |
| L2 | No unresolved CRITICAL/HIGH from the Codex final audit (or a recorded disposition) | review | `phase-04-review-log.md` | — |
| L3 | Every `unit`/`itest` row above is registered and prints its suite id | unit | `packages/application/src/assurance/exit-criteria-coverage.test.ts` › "every mapped proof is a registered suite" | `asep-suite:exit-criteria-coverage` |

## M. Operational readiness

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| M1 | Runbook covers reviewer outage, rate limiting, cost overrun, served-model drift, credential rotation, kill switch (reviewer disabled → R2 `DEFERRED`), promotion and demotion | review | `phase-04-assurance-runbook.md` (S17) | — |
| M2 | Executable rehearsal: 429 storm, 503, malformed outputs, cost budget exceeded, served-model drift and reviewer disabled each reach the documented decision on real mechanisms | unit | `apps/control-plane-api/src/assurance/assurance-rehearsal.test.ts` › "each injected reviewer fault reaches its documented decision" | `asep-suite:assurance-rehearsal` |

## Suite registry (shared-surface request SR §17.5)

New `REQUIRED_SUITES` (25):

```text
asep-suite:contract-fixtures             packages/contracts/src/validate.test.ts   (existing file; marker added)
asep-suite:review-policy                 packages/policy/src/review.test.ts
asep-suite:finding-lifecycle             packages/domain/src/assurance.test.ts
asep-suite:review-packet                 packages/application/src/assurance/packet.test.ts
asep-suite:review-prompt                 packages/application/src/assurance/prompt.test.ts
asep-suite:review-grounding              packages/application/src/assurance/grounding.test.ts
asep-suite:assurance-checks              packages/application/src/assurance/checks.test.ts
asep-suite:adjudication                  packages/application/src/assurance/adjudication.test.ts
asep-suite:repair-order                  packages/application/src/assurance/repair.test.ts
asep-suite:assurance-steps               packages/application/src/assurance/steps.test.ts
asep-suite:assurance-driver              packages/application/src/assurance/driver.test.ts
asep-suite:assurance-admission           packages/application/src/assurance/admission.test.ts
asep-suite:exit-criteria-coverage        packages/application/src/assurance/exit-criteria-coverage.test.ts
asep-suite:metric-eval                   packages/observability/src/metric-eval.test.ts
asep-suite:assurance-dashboards          packages/observability/src/dashboards.test.ts
asep-suite:reviewer-openai               adapters/reviewer-openai/src/reviewer-openai.test.ts
asep-suite:reviewer-replay               adapters/reviewer-replay/src/reviewer-replay.test.ts
asep-suite:assurance-persistence         adapters/persistence/src/assurance/assurance-persistence.test.ts
asep-suite:review-source                 adapters/git-worktree/src/review-source.test.ts
asep-suite:reviewer-credential-isolation adapters/agent-claude/src/reviewer-credential-isolation.test.ts
asep-suite:review-corpus                 evals/review-corpus/corpus-verifier.test.ts
asep-suite:review-benchmark              evals/review-benchmark/scorer.test.ts
asep-suite:review-injection-suite        evals/review-benchmark/injection-suite.test.ts
asep-suite:assurance-root                apps/control-plane-api/src/assurance-root.test.ts
asep-suite:assurance-rehearsal           apps/control-plane-api/src/assurance/assurance-rehearsal.test.ts
```

New `REQUIRED_ITEST_SUITES` (3):

```text
asep-suite:assurance-persistence-real    adapters/persistence/src/assurance/assurance-persistence.itest.ts
asep-suite:assurance-loop-real           apps/control-plane-api/src/assurance/assurance-loop.itest.ts
asep-suite:assurance-dashboards-real     apps/control-plane-api/src/assurance/assurance-dashboards.itest.ts
```

`asep-suite:review-source` is exercised by real temporary Git repositories, as `asep-suite:git-worktree` is
today. Existing suites extended (no new id): `asep-suite:compat-gate`, `asep-suite:forbidden-imports`,
`asep-suite:governed-execution` (unchanged by design).

## Not Phase 4 exit

Durable orchestration (Lane A), gating promotion of a reviewer (a human decision after the phase), R3/R4
admission, auto-merge, tool-using reviewers, production Grafana, escaped-defect measurement from production
incidents, the Phase 1 historical-task dataset (PP2).
