# Phase 4 — Exit Criteria (LOCKED v3 pending controller confirmation, machine-checkable)

> Phase 4 reaches a verdict only from a clean checkout. Base `00a6889`; v1 reviewed at `a2a7b8a`; v2 lock-checked at
> `3201335` (v3 folds it: E1, E9, E12–E14, G8, H6, H7, I10, I12, I13, L3).
> `[ ]` unmet · `[x]` met with evidence in `artifacts/phase-04/` or a committed scorecard.
> Verdicts (`phase-04-plan.md` §23): **IMPLEMENTATION_COMPLETE_DESCRIPTIVE_SELF_HISTORY_ONLY_UNVALIDATED** (every MUST)
> · **IMPLEMENTATION_COMPLETE_ASSURANCE_ONLY_LOOP_DESCRIPTIVE_SELF_HISTORY_ONLY_UNVALIDATED** (all but N1) ·
> **IMPLEMENTATION_COMPLETE_MEASUREMENT_PENDING_UNVALIDATED** (all but I1); suffix `_UNREVIEWED` until the
> controller's independent final review. `COMPLETE` is not reachable in Phase 4.

## How MUSTs map to tests

Every MUST names the executable proof. Proof kinds:

- `unit` — a `*.test.ts` file registered in `REQUIRED_SUITES` and run by `pnpm verify:all`;
- `itest` — a `*.itest.ts` file registered in `REQUIRED_ITEST_SUITES`, run by `pnpm test:integration` against real
  digest-pinned PostgreSQL, object storage, Docker and (from S18) Grafana;
- `gate` — a step of `scripts/verify-all.sh` or the integration gate;
- `live` — needs the reviewer gateway credential (SR-G2); its output is committed and re-scored by a `unit` proof;
- `review` — judged by the controller's independent review (listed explicitly, kept minimal).

Gate adequacy (P4-PLAN-MED-001), three layers:

1. `packages/application/src/assurance/exit-criteria-coverage.test.ts` parses the tables below and fails if a
   `unit`/`itest` row names a file that does not exist, is not registered under the stated suite id, or does not
   print `SUITE-ID: <id>`.
2. **Proof manifest** (SR-T3) over **both runners**: the canonical runner and the integration runner each write a
   JUnit report and run the registered post-run proof check, which fails the gate if any `unit` test name (canonical
   report) or `itest` test name (integration report) mapped below is absent, skipped, todo or failed (L3). A
   conditional proof names its condition; the only one is G8's live round trip.
3. **Mutation proofs**: for the key MUSTs (marked †), `scripts/assurance-mutation-proofs.json` holds a seeded
   mutation of the guarding code; the suite applies each in a temporary copy of the tree and requires the mapped test
   to fail, with an unmutated control run passing (L4).

Test names are planned names (stable behaviour descriptions, no phase or finding codes).

## A. Baseline and build integrity

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| A1 | `pnpm install --frozen-lockfile` then `pnpm verify:all` green from a clean writable checkout; exit code, test count, required-suite count and exact HEAD recorded by the controller | gate | `scripts/verify-all.sh` | — |
| A2 | `pnpm test:integration` green, including every new required itest suite | gate | `scripts/integration/run-integration.mjs` | — |
| A3 | `review-report/v1` and `finding/v1` schema files and all `schema/snapshots/v1/*` byte-identical to `00a6889` | unit | `packages/contracts/src/compat-gate.test.ts` › "legacy review contracts and v1 snapshots keep their recorded digests" | `asep-suite:compat-gate` |
| A4 | Working tree clean after the full gate | gate | `verify-all.sh` clean-tree step | — |
| A5 | No Lane B path imports `@temporalio/*`; domain/application call no global `fetch`/`WebSocket`; production entry points never import `assurance/drill`; each rule has a seeded self-check | unit | `scripts/forbidden-imports.test.ts` (or its AST successor) › "assurance code imports no orchestration engine", "pure layers make no network call through globals", "production entry points never reach drill compositions" | `asep-suite:forbidden-imports` |

## B. Contracts and versioning

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| B1 | `review-record/v1`, `review-finding/v1`, `review-packet/v1`, `adjudication-record/v1`, `repair-order/v1` exist with valid and invalid fixtures; the validator knows each name and accepts/rejects each fixture | unit | `packages/contracts/src/validate.test.ts` › existing "every valid fixture is accepted", "every invalid fixture is rejected with a real error", "every contract has at least one valid and one invalid fixture" (file gains a suite marker) | `asep-suite:contract-fixtures` |
| B2 | Compat gate: `architecture-invariant` 1.1.0 classified MINOR; the five new schemas have frozen snapshots; drift guard green | unit | `compat-gate.test.ts` › "assurance contract additions are additive" | `asep-suite:compat-gate` |
| B3 | `run-event` 1.2.0 (S0) carries every Lane B field and enum value of plan §18.4; every new dictionary operand resolves | unit | `packages/observability/src/metric-eval.test.ts` › "dictionary operands resolve against run-event 1.2.0" | `asep-suite:metric-eval` |
| B4 | The model-facing output schema is strict-compatible and maps deterministically to `review-record/v1` | unit | `adapters/reviewer-openai/src/reviewer-openai.test.ts` › "model-facing schema is strict-compatible and maps to the canonical record" | `asep-suite:reviewer-openai` |

## C. Reviewer independence (ADR 0010)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| C1 † | Canary strings planted in the coder's summary, limitations, event artifacts and ContextPack never appear in the packet, prompt or raw request bytes | unit | `packages/application/src/assurance/packet.test.ts` › "coder self-report never reaches the reviewer" | `asep-suite:review-packet` |
| C2 | The packet schema has no field for coder self-report, ContextPack, commit message, PR body or another reviewer's output | unit | `packet.test.ts` › "packet schema whitelists trusted sources only" | `asep-suite:review-packet` |
| C3 | A reviewer's policy-resolved family differs from the implementer's; the comparator's differs from the primary's; unknown family fails closed | unit | `packages/policy/src/review.test.ts` › "independence requires different resolved model families" | `asep-suite:review-policy` |
| C4 | Every reviewer request as sent by the harness has `store:false`, no `previous_response_id`/`conversation`, no tools, `tool_choice:"none"`, `truncation:"disabled"` | unit | `reviewer-openai.test.ts` › "request body is stateless and tool-free" | `asep-suite:reviewer-openai` |
| C5 | The reviewer credential is injected by the composition root; adapter source reads no `process.env`; the value never reaches the coder container env, an artifact, a log line, an error text or a DB row; expiry refresh and one-shot rotation on 401 work | unit + itest | `adapters/reviewer-openai/src/credential.test.ts` › "credential is refreshed before expiry and rotated once on rejection"; `adapters/agent-claude/src/reviewer-credential-isolation.test.ts` › "agent env allowlist cannot carry the reviewer credential"; `apps/control-plane-api/src/assurance/assurance-loop.itest.ts` › "credential canary absent from artifacts, logs and rows"; `forbidden-imports.test.ts` › "reviewer adapters read no process environment" | `asep-suite:reviewer-credential`, `asep-suite:reviewer-credential-isolation`, `asep-suite:assurance-loop-real`, `asep-suite:forbidden-imports` |
| C6 | Reviewers in one round are blind to each other | unit | `packages/application/src/assurance/steps.test.ts` › "parallel reviewers receive identical packets without peer output" | `asep-suite:assurance-steps` |

## D. Egress and prompt-injection resistance

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| D1 † | Zero provider calls (fake provider call counter = 0) for: push-guard BLOCK, `STOP_SECRET`, `STOP_CLASSIFIED` (deny glob and project not opted in), `STOP_UNSCANNABLE`, and a secret appearing only in the final request bytes | unit | `packages/application/src/assurance/egress.test.ts` › "no reviewer request leaves the harness unless egress is clear" | `asep-suite:assurance-egress` |
| D2 † | The same five cases through `assurance-root` and the real adapter against a local fake HTTP gateway: request counter = 0, and the round is recorded `EGRESS_STOPPED`/`SKIPPED_PUSH_GUARD` | itest | `assurance-loop.itest.ts` › "egress stops send zero requests on the production path" | `asep-suite:assurance-loop-real` |
| D3 | Untrusted content appears only in the user input, delimited with the packet-derived nonce and datamarked per line; the rubric contains no untrusted byte | unit | `packages/application/src/assurance/prompt.test.ts` › "untrusted content is spotlighted outside the instructions" | `asep-suite:review-prompt` |
| D4 | A model verdict never clears a deterministic failure; malformed output, tool calls, refusals and `incomplete` fail closed; citations outside the packet are refuted | unit | `adjudication.test.ts` › "model verdict cannot override findings or deterministic failures"; `reviewer-openai.test.ts` › "malformed provider output fails closed"; `grounding.test.ts` › "citations outside the packet are refuted" | `asep-suite:adjudication`, `asep-suite:reviewer-openai`, `asep-suite:review-grounding` |
| D5 | Bidirectional and zero-width Unicode in added lines produces a deterministic SECURITY finding | unit | `packages/application/src/assurance/checks.test.ts` › "invisible and bidirectional characters are flagged" | `asep-suite:assurance-checks` |
| D6 | Injection suite: deterministic harness invariants pass (injected text cannot change authority, add tool calls or forge the nonce); model degradation is measured against the pre-registered floor with a positive control; the result is one of `MEETS_FLOOR`, `BELOW_FLOOR`, `INVALID_CONTROL`, and zero detection on controls yields `INVALID_CONTROL`, never a pass | unit | `evals/review-benchmark/injection-suite.test.ts` › "injection invariants hold and degradation is classified against the floor" | `asep-suite:review-injection-suite` |
| D7 | No silent truncation: over-budget packets are flagged without calling the reviewer; a provider context overflow is classified | unit | `packet.test.ts` › "over-budget packet is flagged, never cut"; `adjudication.test.ts` › "over-budget and context overflow escalate in gating and are recorded in shadow" | `asep-suite:review-packet`, `asep-suite:adjudication` |

## E. Review, adjudication, repair and fencing

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| E1 | Every step input/output survives a JSON round trip and stays within the 64 KiB envelope (`assertWithinReviewLoopEnvelope` accepts 65 536 bytes, rejects 65 537); ids derive from inputs | unit | `steps.test.ts` › "step contracts are serializable, within the envelope, and ids are input-derived" | `asep-suite:assurance-steps` |
| E2 † | Fencing per the Phase 2 primitive: after a lease handoff the new owner completes the reviewer call and the old owner is fenced; concurrent claims yield one winner; a holder with an expired lease cannot claim; a reopened `FAILED` call adopts an existing raw response instead of calling; every decision write is fence-checked in its transaction | unit + itest | `steps.test.ts` › "a lease handoff hands the review to the new owner and fences the old one"; `adapters/persistence/src/assurance/assurance-persistence.itest.ts` › "fenced review writes survive a lease handoff on real PostgreSQL" | `asep-suite:assurance-steps`, `asep-suite:assurance-persistence-real` |
| E3 | Adjudication is pure with a recorded rule, policy version and input hashes; every rule A1–A11 × {gating, shadow} is covered | unit | `adjudication.test.ts` › "rule table is total and deterministic" | `asep-suite:adjudication` |
| E4 | Deterministic findings outrank model review; findings are unioned and de-duplicated by fingerprint per raiser | unit | `adjudication.test.ts` › "deterministic evidence outranks model review" | `asep-suite:adjudication` |
| E5 | A repair order carries only grounded blocking findings (plus capped informational), `repairBaseSha` = prior harness commit, bounded sizes | unit | `packages/application/src/assurance/repair.test.ts` › "repair order is bounded and anchored to the prior commit" | `asep-suite:repair-order` |
| E6 † | Closure authority: the raiser's `RESOLVED` only moves a finding to `FIXED` (still blocking); a different eligible reviewer with a grounded resolution in the repair delta, a human, or (deterministic findings) a clean re-check moves it to `VERIFIED`; a claim citing an untouched file stays `OPEN`; the database rejects a raiser's verification | unit + itest | `packages/domain/src/assurance.test.ts` › "only an independent reviewer, a human or a deterministic re-check verifies a fix"; `adjudication.test.ts` › "closure without change keeps the finding open"; `assurance-persistence.itest.ts` › "disposition actor rules are enforced by the database" | `asep-suite:finding-lifecycle`, `asep-suite:adjudication`, `asep-suite:assurance-persistence-real` |
| E7 | `maxRounds` reached → ESCALATE (drill); the loop never exceeds the bound | unit | `packages/application/src/assurance/driver.test.ts` › "repair loop is bounded by policy" | `asep-suite:assurance-driver` |
| E8 | Reviewer failure (provider error, malformed, refused, budget, served-model drift) never yields PROCEED in gating | unit | `adjudication.test.ts` › "reviewer failure escalates in gating mode" | `asep-suite:adjudication` |
| E9 † | Shadow mode returns only PROCEED or BLOCK, records `shadow.wouldBe` on PROCEED only, and changes no workflow decision except the push guard; a shadow BLOCK carries no shadow verdict (outcome and `would_be_outcome`); the `adjudications` table rejects a shadow `REPAIR`/`ESCALATE` | unit + itest | `driver.test.ts` › "shadow mode records but does not decide"; `adjudication.test.ts` › "a shadow round blocked by the push guard carries no shadow verdict"; `assurance-persistence.itest.ts` › "shadow rounds cannot persist a gating outcome" | `asep-suite:assurance-driver`, `asep-suite:adjudication`, `asep-suite:assurance-persistence-real` |
| E10 | Assurance-only loop on real PostgreSQL + Git + sandbox with the real adapter against a local fake gateway: shadow PROCEED; push-guard BLOCK with zero gateway requests and zero forge calls; drill REPAIR → re-review closed by the other reviewer → PROCEED; drill raiser-only closure → ESCALATE at max rounds | itest | `assurance-loop.itest.ts` › "assurance round reaches each outcome on real backends" | `asep-suite:assurance-loop-real` |
| E11 | A durable-shaped fake (no orchestration SDK) drives each slot step as an activity with failures, retries, cancellation and a lease handoff, and converges | unit | `driver.test.ts` › "activity-granular composition converges under retries and handoff" | `asep-suite:assurance-driver` |
| E12 | Conformance kit RLC-01…RLC-13 passes for `createAssuranceSlot` on PGlite and on real PostgreSQL, and for the disabled and scripted slots | unit + itest | `packages/application/src/assurance/slot.test.ts` › "assurance slot satisfies the review-loop contract"; `assurance-loop.itest.ts` › "assurance slot satisfies the review-loop contract on real PostgreSQL" | `asep-suite:assurance-slot`, `asep-suite:assurance-loop-real` |
| E13 | Workspace seam (R18): steps read repository content only through `AssuranceWorkspaceResolver`; a wrong tenant → `ReviewLoopContractError`, a wrong lease, a stale epoch or an ended lease → `AssuranceFencedError`, each before any repository read; the resolver kit WRC-01…05 passes on Lane B's fake (Lane A runs it on the real lease table) | unit | `steps.test.ts` › "workspace refusals stop the packet step before any read"; `slot.test.ts` › "workspace resolver fake satisfies the resolver contract" | `asep-suite:assurance-steps`, `asep-suite:assurance-slot` |
| E14 | Fixed logical time (R15): a round interrupted at each step boundary and redelivered with the same logical time persists byte-identical records and events to an uninterrupted round (RLC-11); content-addressed artifacts carry no timestamp; adjudication judges waiver expiry at the round's opening time | unit | `slot.test.ts` › "a redelivered round writes byte-identical records and events"; `adjudication.test.ts` › "waiver expiry is judged at the round's opening time" | `asep-suite:assurance-slot`, `asep-suite:adjudication` |

## F. Architecture, security and false-green checks

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| F1 | Diff checks each catch a seeded violation; secret patterns match `scripts/lib/secret-patterns.sh` | unit | `checks.test.ts` › "each diff check catches its seeded violation", "secret patterns match the repository scanner" | `asep-suite:assurance-checks` |
| F2 † | A secret in added lines BLOCKs before the gateway and before any push, for every admitted risk | itest | `assurance-loop.itest.ts` › "secret in diff blocks with zero gateway requests and zero forge calls" | `asep-suite:assurance-loop-real` |
| F3 | SARIF 2.1.0 subset parses into `source:"sarif"` findings; malformed SARIF fails closed | unit | `checks.test.ts` › "sarif results become findings and malformed sarif fails closed" | `asep-suite:assurance-checks` |
| F4 | Raw check outputs are stored as artifacts before any reduction | unit | `steps.test.ts` › "check report is persisted before adjudication reads it" | `asep-suite:assurance-steps` |
| F5 † | The packet carries the execution manifest (command, exit code, duration, environment digest, raw-output refs, scanned bounded excerpts, parsed test summary); seeded false-green cases are caught deterministically: zero tests executed with exit 0, an added skip marker, a passing record with a non-zero exit code, a missing required check | unit | `checks.test.ts` › "seeded false-green evidence is caught"; `packet.test.ts` › "packet carries a bounded execution manifest" | `asep-suite:assurance-checks`, `asep-suite:review-packet` |
| F6 | The synthetic false-green suite measures whether each reviewer flags the seeded cases (reported, separate scope) | unit | `evals/review-benchmark/false-green-suite.test.ts` › "false-green suite executes and reports per-reviewer detection" | `asep-suite:review-false-green-suite` |

## G. Reviewer adapter (provider DoD)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| G1 | Pinned model and config hash recorded; served model recorded; drift fails the review in every mode | unit | `reviewer-openai.test.ts` › "served-model drift fails the review" | `asep-suite:reviewer-openai` |
| G2 | Canonical request (no credential) and exact response bytes persisted before parsing; the prompt artifact hash is re-checked before sending | unit | `reviewer-openai.test.ts` › "raw request and response are captured before parsing" | `asep-suite:reviewer-openai` |
| G3 | Malformed JSON, partial body, refusal, `incomplete`, `failed`, tool-call items and multiple text items classify correctly and fail closed | unit | `reviewer-openai.test.ts` › "every malformed shape is classified" | `asep-suite:reviewer-openai` |
| G4 | 429/503 honour `Retry-After`, else bounded exponential backoff with jitter; quota errors are not retried; fake clock | unit | `reviewer-openai.test.ts` › "retries are bounded and policy-correct" | `asep-suite:reviewer-openai` |
| G5 | `AbortSignal` cancels in flight; wall-clock budget enforced; `max_output_tokens` sent | unit | `reviewer-openai.test.ts` › "cancellation and budgets are enforced" | `asep-suite:reviewer-openai` |
| G6 | `baseUrl` must be https and allowlisted; redirects are refused | unit | `reviewer-openai.test.ts` › "endpoint is allowlisted and redirects are refused" | `asep-suite:reviewer-openai` |
| G7 | The production composition (`assurance-root` with a fake credential source) drives the real adapter against a local fake gateway end to end | unit | `apps/control-plane-api/src/assurance-root.test.ts` › "production composition reaches the gateway through the injected credential source" | `asep-suite:assurance-root` |
| G8 | The live reviewer requirement is a policy decision with an always-running unit test, never a runner skip: flag unset and no credential → `not-configured` with a recorded reason; `ASEP_REQUIRE_LIVE_REVIEWER=1` without a credential → fails closed; with a credential the live round trip runs and any failure is red; the credential is never printed | unit (+ live when flagged) | `reviewer-openai.test.ts` › "live reviewer requirement is a policy decision that fails closed when required"; `adapters/reviewer-openai/src/reviewer-openai.live.test.ts` › "live reviewer round trip" (conditional proof: required when `ASEP_REQUIRE_LIVE_REVIEWER=1`; registered only when a credential is configured) | `asep-suite:reviewer-openai`, `asep-suite:reviewer-live` |
| G9 | Replay returns recorded bytes for a request hash, fails closed on a miss or manifest mismatch; the scripted provider is marked fake | unit | `adapters/reviewer-replay/src/reviewer-replay.test.ts` › "replay is exact and fails closed" | `asep-suite:reviewer-replay` |
| G10 | Gateway request alteration is detected per call: against a fake gateway that appends text to the returned `instructions` and reports unsent `tools`/`instructions` in `usage.attribution.request_fields`, the observation records `altered` with appended size, hash, appendix artifact and attributed fields; a response without those fields records `unknown`, never `unaltered` | unit | `reviewer-openai.test.ts` › "gateway request alteration is detected and recorded" | `asep-suite:reviewer-openai` |

## H. Persistence and events

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| H1 | Migrations `0200`–`0202` apply forward on clean PGlite and PostgreSQL 17, re-apply as a no-op, stay in the Lane B range | unit + itest | `adapters/persistence/src/assurance/assurance-persistence.test.ts` › "assurance migrations apply once and stay in range"; itest on real PG | `asep-suite:assurance-persistence`, `asep-suite:assurance-persistence-real` |
| H2 | All review tables are tenant-scoped; cross-project read and write fail at the DB boundary | itest | `assurance-persistence.itest.ts` › "cross-project review access fails closed" | `asep-suite:assurance-persistence-real` |
| H3 | Append-only and finality triggers and the named check constraints of data model §3.1 behave as specified | itest | `assurance-persistence.itest.ts` › "review history is append-only and final records are immutable" | `asep-suite:assurance-persistence-real` |
| H4 | `recordAttemptOutcome` at every terminal (verification stops included) emits `attempt.declared_complete` + `attempt.completed` once through `RunEventSink`; re-delivery is a no-op | unit | `steps.test.ts` › "every attempt terminal emits its outcome events exactly once" | `asep-suite:assurance-steps` |
| H5 | `review.completed` is emitted once per review source per round; `review.finding_dispositioned` only by the human disposition use case | unit | `slot.test.ts` › "review events are emitted per source and dispositions only by humans" | `asep-suite:assurance-slot` |
| H6 † | Cohort semantics (R18): one finding reviewed on day 1, accepted on day 2 and rejected on day 3 gives the day-1 cohort's `review_finding_yield` snapshot versions 1–3 (`0`, `1`, `0`) and `review_false_positive_rate` versions 1–2 (`0`, `1`), latest disposition per finding, earlier versions still readable; the day-2 and day-3 windows count no disposition of that round; `review_disposition_latency_ms` is reported per cohort; harness refutations are excluded | unit | `metric-eval.test.ts` › "late human dispositions version their round's cohort snapshot" | `asep-suite:metric-eval` |
| H7 | `metric_snapshots` versions are append-only: an unchanged recompute writes nothing, a changed one appends the next version, update and delete are rejected, the latest-version view returns the newest | unit + itest | `adapters/persistence/src/assurance/assurance-persistence.test.ts` › "snapshot versions are append-only"; `assurance-persistence.itest.ts` › "snapshot versions are append-only on real PostgreSQL" | `asep-suite:assurance-persistence`, `asep-suite:assurance-persistence-real` |

## I. Reviewer measurement on historical defects (descriptive, self-history)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| I1 | Live descriptive measurement of the primary reviewer **and** the comparator on the frozen corpus (k = 3 on reporting items): recordings, manifests and scorecards committed | live + unit | capture via `pnpm --filter @asep/evals review-bench:capture`; `evals/review-benchmark/scorer.test.ts` › "committed live recordings rescore to the committed scorecards" | `asep-suite:review-benchmark` |
| I2 | Leakage: no packet contains a review artifact, git metadata or a commit message; packets are built at the reviewed SHA, never at the parent of a fix | unit | `scorer.test.ts` › "packets exclude review artifacts and history" | `asep-suite:review-benchmark` |
| I3 † | Every self-history scorecard has `scope: self-history`, `eligibleForPromotion: false`, `blindHoldout: false`, a circularity statement naming the labeller and reviewer models, and a `gateway` block (label, base-URL hash, alteration status and shares); the scorer rejects anything else | unit | `scorer.test.ts` › "self-history scorecards are descriptive and never promotion-eligible" | `asep-suite:review-benchmark` |
| I4 | Capture refuses to run unless the preregistration's protocol, floors, matcher, corpus and both reviewer config hashes match and its controller approval reference is present | unit | `scorer.test.ts` › "capture refuses a mismatched or unapproved preregistration" | `asep-suite:review-benchmark` |
| I5 | Scoring is deterministic and offline (strict and lenient matcher, no model); rescoring twice is byte-identical | unit | `scorer.test.ts` › "committed recordings rescore byte-identically" | `asep-suite:review-benchmark` |
| I6 | Scorecards report n and Wilson 95% intervals (cells with n < 20 descriptive-only), k-run stability, invalid-output rates, tokens, cost or null, baselines, labeller-miss subset and primary-vs-comparator overlap | unit | `scorer.test.ts` › "scorecard carries every required field with intervals" | `asep-suite:review-benchmark` |
| I7 † | The scorer refuses scripted or fake recordings for any measurement scorecard | unit | `scorer.test.ts` › "measurement scorecards come only from live recordings" | `asep-suite:review-benchmark` |
| I8 | Post-fix negative pairs are scored and the stale-flag rate is reported | unit | `scorer.test.ts` › "post-fix negatives yield a stale-flag rate" | `asep-suite:review-benchmark` |
| I9 | The report states the corpus biases (plan §7.2), uses the verdict vocabulary with its mandatory `MEASURED_VIA` gateway line (plan §23), and claims nothing beyond the scorecard `scope` and gateway; no sentence calls the result production-valid | review | controller review of `phase-04-report.md` against the scorecards | — |
| I10 | Corpus verifier (after the freeze): every claim git-verified for reachable SHAs; every excerpt's bytes hash to its name; exclusions enumerated; no ref to a pre-rewrite commit exists; excerpts pass the publication gates; bundle mode verifies object-store-only items when the controller supplies the bundle path | unit | `evals/review-corpus/corpus-verifier.test.ts` › "every corpus claim and excerpt is verified" | `asep-suite:review-corpus` |
| I11 | Each scorecard evaluates every pre-registered floor per reviewer (`floorsMet`), and the report states each result | unit | `scorer.test.ts` › "every pre-registered floor is evaluated and reported" | `asep-suite:review-benchmark` |
| I12 | The corpus protocol (plan §7.8) holds as specified: the golden historical item rebuilds byte-identical packet, packet-source and prompt digests on the reviewed and post-fix sides, the post-fix location mapping gives the committed mapped locations, and every expected strict, lenient, duplicate and unlabelled result holds; the category table and cardinality rule are part of `protocolSha256` | unit | `scorer.test.ts` › "golden historical item reconstructs identical packets and matches as specified on both sides" | `asep-suite:review-benchmark` |
| I13 | Provenance collection (S19 pure core): every collected finding id appears on its recorded document line; every derived reviewed SHA is the parent of the commit that added its review document; reachability is classified from the repository; every excerpt's bytes hash to its name and, for reachable SHAs, equal `git show <sha>:<path>`; only provenance-level exclusions are recorded | unit | `evals/review-corpus/collect.test.ts` › "collected provenance and excerpts verify against the repository" | `asep-suite:review-corpus-collect` |

## J. Dashboards (false completion, review yield, cost, recovery)

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| J1 | The evaluator implements every dictionary aggregation, filter, `dedupeLatestBy` and zero-denominator policy; golden values on labelled fixture events | unit | `metric-eval.test.ts` › "evaluator matches golden values for every dashboard metric" | `asep-suite:metric-eval` |
| J2 | No source events → `null` with the dictionary's reason, never 0 (`workflow_recovery_rate` until Lane A emits; gating-only metrics in Phase 4) | unit | `metric-eval.test.ts` › "missing source events yield null with a reason" | `asep-suite:metric-eval` |
| J3 | Every panel reads `metric_snapshots` for a dictionary metric; every required metric has a panel; four dashboards exist | unit | `packages/observability/src/dashboards.test.ts` › "panels and dictionary metrics correspond one to one" | `asep-suite:assurance-dashboards` |
| J4 | A digest-pinned Grafana loads the committed provisioning in the integration gate: `GET /api/health` ok; the data source loads by uid; every dashboard loads by uid; every panel query (`POST /api/ds/query`) returns the snapshot values written for the E10 run | itest | `apps/control-plane-api/src/assurance/assurance-dashboards.itest.ts` › "grafana loads the provisioned dashboards and panels return snapshot values" | `asep-suite:assurance-dashboards-real` |
| J5 | Snapshot values computed on real PostgreSQL from the events the E10 loop emitted equal hand-derived expectations | itest | `assurance-dashboards.itest.ts` › "snapshots computed from real emitted events" | `asep-suite:assurance-dashboards-real` |
| J6 | Telemetry completeness compares terminal attempts with emitted `attempt.completed` events and exposes a gap | itest | `assurance-dashboards.itest.ts` › "telemetry completeness exposes a missing emission" | `asep-suite:assurance-dashboards-real` |
| J7 | Reviewer cost = recorded tokens × configured price; no price → `reviewCostUsd` omitted and cost coverage shows the gap | unit | `metric-eval.test.ts` › "unpriced reviews are reported as uncovered, never zero" | `asep-suite:metric-eval` |
| J8 | Restricted-class metrics are computed only when capture is enabled | unit | `metric-eval.test.ts` › "restricted metrics respect opt-in capture" | `asep-suite:metric-eval` |

## K. Admission, gating and human accountability

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| K1 | With the production capability (`promotedReviewerConfigIds: []`), `admitWithAssurance` equals `admitRisk` for R0–R4; R3/R4 are `DEFERRED` for every capability | unit | `packages/application/src/assurance/admission.test.ts` › "assurance admission equals Phase 2 admission without promotion" | `asep-suite:assurance-admission` |
| K2 | D-2 (user decision) as a policy rule: R1 with a promoted reviewer needs no separate human independent review; R1 without one does; R2 stays deferred; no production code path supplies a non-empty promoted list | unit | `review.test.ts` › "a promoted reviewer satisfies R1 only"; `assurance-root.test.ts` › "production composition never supplies promoted reviewers" | `asep-suite:review-policy`, `asep-suite:assurance-root` |
| K3 † | Gating is unreachable in production: the policy loader rejects `gating`; `assurance-root` refuses such a policy; drill factories are not reachable from entry points (A5); the DB rejects shadow gating outcomes (E9) | unit | `review.test.ts` › "committed policy accepts only shadow and not-required modes"; `assurance-root.test.ts` › "a gating policy is refused at composition" | `asep-suite:review-policy`, `asep-suite:assurance-root` |
| K4 | Without SR-X1's `admit` argument, `governedExecution` behaves byte-identically (existing suite unchanged and green) | unit | `packages/application/src/governed-execution.test.ts` (unchanged) | `asep-suite:governed-execution` |
| K5 | `approval-matrix.yaml` and `verification-matrix.yaml` byte-identical; Phase 1 policy parity tests unchanged | unit | `review.test.ts` › "approval and verification matrices are unchanged" | `asep-suite:review-policy` |
| K6 | A model cannot waive or refute a grounded finding; a waiver needs a named human, rationale, expiry and signature; an expired waiver reopens the finding | unit | `assurance.test.ts` › "only humans waive, and waivers expire" | `asep-suite:finding-lifecycle` |
| K7 | `WAITING_FOR_HUMAN_REVIEW` remains the machine ceiling; no merge capability is added | unit | `driver.test.ts` › "the assured path ends at human review and never merges" | `asep-suite:assurance-driver` |
| K8 | `assurance-root` fails closed: missing reviewer config throws unless the explicit disabled literal is given | unit | `assurance-root.test.ts` › "reviewer configuration fails closed" | `asep-suite:assurance-root` |

## L. Completion protocol

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| L1 | `phase-04-report.md` present; machine fields generated from scorecards, gate logs and `git rev-parse`; a completion sentinel written last carries `git rev-parse HEAD` | review + gate | controller compares sentinel SHA with `git rev-parse HEAD` | — |
| L2 | Zero unresolved CRITICAL/HIGH from the Codex final audit; the only accepted dispositions are fixed, not-applicable with evidence, or an explicit user-accepted risk | review | `phase-04-review-log.md` | — |
| L3 | Every `unit`/`itest` row above is registered, prints its suite id, and its named tests appear as passed in the JUnit proof manifest of its runner (canonical for `unit`, integration for `itest`) | unit + gate | `exit-criteria-coverage.test.ts` › "every mapped proof is a registered suite"; `scripts/lib/proof-manifest.test.ts` › "a missing, skipped, todo or failed mapped test fails either runner"; both runners' post-run proof check (SR-T3) | `asep-suite:exit-criteria-coverage`, `asep-suite:proof-manifest` |
| L4 | Each mutation in `scripts/assurance-mutation-proofs.json` (one per † row: C1, D1, D2, E2, E6, E9, F2, F5, H6, I3, I7, K3) turns its mapped test red in a temporary copy; the unmutated control passes; a mutation whose search text does not match exactly once fails the suite | unit | `scripts/assurance-mutation-proofs.test.ts` › "every seeded guard mutation is caught" | `asep-suite:assurance-mutation-proofs` |

## M. Operational readiness

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| M1 | Runbook covers reviewer outage, rate limiting, cost overrun, served-model drift, credential expiry and rotation, egress stops, kill switch (reviewer disabled) | review | `phase-04-assurance-runbook.md` (S24) | — |
| M2 | Executable rehearsal: 429 storm, 503, malformed outputs, cost budget exceeded, served-model drift, credential expiry/rotation, egress stop and reviewer disabled each reach the documented decision on real mechanisms | unit | `apps/control-plane-api/src/assurance/assurance-rehearsal.test.ts` › "each injected reviewer fault reaches its documented decision" | `asep-suite:assurance-rehearsal` |

## N. Real coder

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| N1 | One real `CodingAgentProvider` attempt (accepted Phase 2 agent runtime) produces a diff and passes through a shadow assurance round on real backends; evidence committed. **Blocked** until the Phase 2 agent-runtime repair is accepted; until then the verdict carries `ASSURANCE_ONLY_LOOP` | itest | `apps/control-plane-api/src/assurance/real-coder-shadow.itest.ts` › "a real coder attempt passes through a shadow assurance round" (registered when S22 lands) | `asep-suite:real-coder-shadow` |

## Suite registry (SR-T1, SR-T2)

New `REQUIRED_SUITES` (33; each registered by its slice's integration part, except the nine S3–S7 ids that landed early):

```text
asep-suite:contract-fixtures             packages/contracts/src/validate.test.ts   (existing file; marker added)
asep-suite:review-policy                 packages/policy/src/review.test.ts
asep-suite:finding-lifecycle             packages/domain/src/assurance.test.ts
asep-suite:review-packet                 packages/application/src/assurance/packet.test.ts
asep-suite:review-prompt                 packages/application/src/assurance/prompt.test.ts
asep-suite:review-grounding              packages/application/src/assurance/grounding.test.ts
asep-suite:assurance-egress              packages/application/src/assurance/egress.test.ts
asep-suite:assurance-checks              packages/application/src/assurance/checks.test.ts
asep-suite:adjudication                  packages/application/src/assurance/adjudication.test.ts
asep-suite:repair-order                  packages/application/src/assurance/repair.test.ts
asep-suite:assurance-steps               packages/application/src/assurance/steps.test.ts
asep-suite:assurance-slot                packages/application/src/assurance/slot.test.ts
asep-suite:assurance-driver              packages/application/src/assurance/driver.test.ts
asep-suite:assurance-admission           packages/application/src/assurance/admission.test.ts
asep-suite:exit-criteria-coverage        packages/application/src/assurance/exit-criteria-coverage.test.ts
asep-suite:metric-eval                   packages/observability/src/metric-eval.test.ts
asep-suite:assurance-dashboards          packages/observability/src/dashboards.test.ts
asep-suite:reviewer-openai               adapters/reviewer-openai/src/reviewer-openai.test.ts
asep-suite:reviewer-credential           adapters/reviewer-openai/src/credential.test.ts
asep-suite:reviewer-live                 adapters/reviewer-openai/src/reviewer-openai.live.test.ts
asep-suite:reviewer-replay               adapters/reviewer-replay/src/reviewer-replay.test.ts
asep-suite:assurance-persistence         adapters/persistence/src/assurance/assurance-persistence.test.ts
asep-suite:review-source                 adapters/git-worktree/src/review-source.test.ts
asep-suite:reviewer-credential-isolation adapters/agent-claude/src/reviewer-credential-isolation.test.ts
asep-suite:review-corpus                 evals/review-corpus/corpus-verifier.test.ts
asep-suite:review-corpus-collect         evals/review-corpus/collect.test.ts
asep-suite:review-benchmark              evals/review-benchmark/scorer.test.ts
asep-suite:review-injection-suite        evals/review-benchmark/injection-suite.test.ts
asep-suite:review-false-green-suite      evals/review-benchmark/false-green-suite.test.ts
asep-suite:assurance-root                apps/control-plane-api/src/assurance-root.test.ts
asep-suite:assurance-rehearsal           apps/control-plane-api/src/assurance/assurance-rehearsal.test.ts
asep-suite:assurance-mutation-proofs     scripts/assurance-mutation-proofs.test.ts
asep-suite:proof-manifest                scripts/lib/proof-manifest.test.ts
```

New `REQUIRED_ITEST_SUITES` (3 now, 4 after S22):

```text
asep-suite:assurance-persistence-real    adapters/persistence/src/assurance/assurance-persistence.itest.ts
asep-suite:assurance-loop-real           apps/control-plane-api/src/assurance/assurance-loop.itest.ts
asep-suite:assurance-dashboards-real     apps/control-plane-api/src/assurance/assurance-dashboards.itest.ts
asep-suite:real-coder-shadow             apps/control-plane-api/src/assurance/real-coder-shadow.itest.ts   (S22)
```

Existing suites extended (no new id): `asep-suite:compat-gate`, `asep-suite:forbidden-imports`,
`asep-suite:governed-execution` (unchanged by design).

## Not Phase 4 exit (deferred, plan §5.3)

Gating mode in production (DF-1), signed promotion (DF-2), promotion thresholds (DF-3), R2 admission through a
reviewer (DF-4), activation of the D-2 rule (DF-5), production-valid measurement on a pilot corpus (DF-6),
red→green closure proof for model findings (DF-7), blind human relabel (DF-8); durable orchestration (Lane A); R3/R4
admission; auto-merge; tool-using reviewers; production Grafana; the Phase 1 historical-task dataset (PP2).
