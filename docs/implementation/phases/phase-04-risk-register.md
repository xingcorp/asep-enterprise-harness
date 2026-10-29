# Phase 4 — Risk Register (LOCKED v2 (pending controller confirmation))

> Delivery, design and measurement risks for independent assurance. Base `00a6889`; v1 reviewed at `a2a7b8a`.
> Severity = impact × likelihood. v2 adds the risks surfaced by the Codex plan review and the reconciliation, and
> retires the promotion risks with the deferral of promotion.

| ID | Risk | Sev | Mitigation | Trigger / owner action |
|----|------|-----|-----------|------------------------|
| PR4-01 | **Circular measurement**: labels come from `gpt-5.6-sol`, the primary reviewer, so its recall is inflated and other reviewers are penalised for different-but-real findings | HIGH | Mandatory different-family comparator; labeller-miss subset; non-model baselines; circularity statement required; `eligibleForPromotion: false`; no generalisation beyond `scope` | Scorecard missing any of these → scorer test fails (exit I3, I6) |
| PR4-02 | **Answer-key leakage** (packets at the parent of a fix, or containing review documents or commit messages; e.g. `3ea0293` adds the Phase 2 final review on top of reviewed tree `2e61f24`) | HIGH | Packets only at the reviewed SHA from excerpts; review artifacts and git metadata excluded by rule; leakage test | Exit I2 fails |
| PR4-03 | **Not a blind holdout**: the prompt author saw every label | HIGH | Called `prompt-development`/`reporting`, never "test split"; `blindHoldout: false`; hashes frozen in a controller-approved preregistration before capture; the plan does not claim blindness | Report claims a holdout → controller review (exit I9) |
| PR4-04 | **Small n** read as precise numbers | HIGH | n + Wilson 95% interval everywhere; n < 20 descriptive-only (D-7); no difference claimed on overlapping intervals | Exit I6 |
| PR4-05 | **Label errors** (transcription, merged IDs, second-hand Phase 1 labels, AI-controller paraphrase) | MED | Git-verified claims; `labelQuality`, `labelSource` incl. `controller-ai-paraphrase`; first-occurrence vs residual reported separately; blind human relabel available as DF-8 | Exit I10 |
| PR4-06 | **Corpus irreproducible**: pre-rewrite reviewed trees are unreachable and must not be tagged (R12) | HIGH | Content-addressed excerpts in the corpus; verifier in bundle mode when the controller supplies the private bundle path; plan states plainly that full re-derivation needs that bundle | Verifier reports items without a verifiable source |
| PR4-07 | **Green gate that does not exercise the MUSTs** (Phase 2 lesson) | HIGH | Coverage guard + JUnit proof manifest (passed, not skipped) + seeded mutation proofs for key guards | Exit L3, L4 |
| PR4-08 | **Faked backends where real ones are required** | HIGH | Real PG + Git + sandbox itests; reviewer faked only at HTTP behind the real adapter and composition; measurement only from live recordings; real-coder loop is its own MUST | Exit E10, I7, N1 |
| PR4-09 | **Dashboards as vocabulary only** | HIGH | Emission inside the slot; evaluator itest from real emitted events; digest-pinned Grafana loads and queries the provisioning in the integration gate | Exit J4, J5 |
| PR4-10 | **False completion of the phase itself** | HIGH | Report fields from machine sources; "not verified" vocabulary; sentinel binds HEAD | Controller reruns gates |
| PR4-11 | **Injection → false APPROVE** | LOW | In Phase 4 production the model cannot change the workflow (shadow); deterministic checks outrank; injection suite classifies degradation against a floor with a positive control | Exit D4, D6 |
| PR4-12 | **Injection → escalation flood** | LOW | Shadow: escalations are recorded only; drill: ungrounded findings auto-refuted, bounded rounds | `shadow_would_block_rate` trend |
| PR4-13 | **Gateway unavailable / rate limited** | MED | Bounded retries honouring `Retry-After`; shadow records failure and proceeds; resumable capture with bounded concurrency; schedule capture away from controller review runs | `reviewer_failure_rate`; rehearsal M2 |
| PR4-14 | **Model drift** (gateway serves another snapshot) | MED | `servedModel` recorded; mismatch fails the review in every mode; configs bound to hashes | Exit G1 |
| PR4-15 | **Cost blow-up** (packets × k × two reviewers × reasoning effort) | MED | Packet byte budget; `max_output_tokens`; task `budgetRemaining` stops calls; capture budget stop; tokens always recorded; cost only from a configured price | `mean_review_cost_usd`; capture budget stop |
| PR4-16 | **Credential leak** of the reviewer key | HIGH | Injected at the composition root; no `process.env` in adapter; header-only; bounded lifetime; scrubbed errors; agent env allowlist test; canary scan in the itest | Exit C5 |
| PR4-17 | **Source-code or secret egress** to a third-party reviewer (P4-PLAN-CRIT-001) | HIGH | Per-project opt-in; pre-gateway egress decision over exact packet bytes; request-byte re-scan; push guard before the gateway; zero-request tests on unit and production paths | Exit D1, D2, F2 |
| PR4-18 | **Shared-surface conflicts with Lane A** | HIGH | Reconciliation R1–R14 applied; S0 carries the slot, sink, run-event superset and `run_events` union; append-only registries; Lane B edits nothing shared during planning | Controller confirms the S0 text |
| PR4-19 | **Phase 2 not accepted**: cycle-7 repairs change ports, fencing, result binding or step signatures | MED | Plan binds to invariants (R1); shared-surface and fencing slices start only after the rebase; re-adjudicate on rebase | Rebase diff touches `ports/index.ts`, `side-effect-log.ts`, `pipeline-steps.ts`, `governed-execution.ts` |
| PR4-20 | **Phase 2 fencing primitive shape does not fit a reviewer call** (keyed by attempt + operation) | MED | CR-F1 asks for a reviewId-qualified operation and an in-transaction fence check; no parallel scheme | Controller reconciles CR-F1 with Lane R |
| PR4-21 | **Grafana digest unknown / image pull fails in the gate** | MED | Digest pinned and recorded in S18 with pull/inspect output; gate fails closed (never skips) when Grafana is unhealthy | Integration gate red |
| PR4-22 | **Scope creep** into gating, promotion, agentic reviewers or orchestration | MED | User decision U-1 and deferred list DF-1…DF-8; loader rejects gating; Lane A owns composition | Review gate |
| PR4-23 | **Packet too narrow** for gate-adequacy and claim-integrity defects | MED | Execution manifest; WorkOrder requirements; for corpus items, exit criteria and report at the reviewed SHA; `not-in-packet` exclusions counted | Exclusion table in scorecard |
| PR4-24 | **Non-determinism mistaken for regression** | MED | Record/replay; k-run stability; variance reported | Exit I5, I6 |
| PR4-25 | **Recordings or excerpts trip publication gates** (secret- or PII-like strings, credential-shaped fixture in pre-rewrite trees, > 500 KiB) | MED | One file per item/run; scanners run on all committed files; unpublishable content excluded with reason, never allowlisted | `verify:all` scans; exit I10 |
| PR4-26 | **Comparator not served over the Responses API** (or without strict structured outputs) through the gateway | MED | S10 probe; fallback order `qwen3.8-max` → `grok-4.6`, recorded in the review log; if none works, controller decides on a chat-completions mode or a capped verdict | Exit I1 unmet |
| PR4-27 | **Real coder unavailable**: the agent runs `--network none` without a model credential (`pilot-main.ts:156`, `claude-provider.ts:131-142`) | HIGH | Full-loop MUST N1 separated and blocked on the Phase 2 agent-runtime repair; verdict carries `ASSURANCE_ONLY_LOOP` until then | S22 stays blocked |
| PR4-28 | **Late human dispositions ignored by metrics** (P4-PLAN-HIGH-004) | MED | `review.finding_dispositioned` + `dedupeLatestBy`; snapshot recompute; test that accept-then-reject changes snapshots | Exit H6 |
| PR4-29 | **Mutation proofs flaky or slow** (temporary tree copies, symlinked `node_modules`) | LOW | ≤ 12 mutations, each running one test file; exact-match search text; control run; failure messages name the mutation | Suite runtime tracked in the gate log |
| PR4-30 | **Gateway alters prompts in transit** (controller notes suggest a style instruction is injected; not verified by Lane B) | MED | Recorded request bytes are what the harness sent; measurement claims bounded to "via this gateway"; gateway host recorded in scorecards; S10 probe records any visible effect | Report wording checked (exit I9) |
| PR4-31 | **Drill-only repair loop rots** because production never exercises it | LOW | Conformance kit and drill itest run in every gate; residual-instance corpus items exercise re-review packets | Exit E10, E12 |

Retired from v1: promotion forgery/expiry risks (promotion deferred, DF-2); per-major compat-gate gap (D-1 = b,
SR-C3 withdrawn); Grafana-not-exercised (D-6 = yes).

## Blocking dependencies carried forward

- **Phase 2 acceptance and rebase** (fencing primitive, ports): S8, S16 and every shared-surface slice.
- **Lane A S0**: slices marked "after S0".
- **Reviewer gateway credential and controller-approved preregistration** (SR-G2, SR-G3): S21. Without them the
  verdict is `…MEASUREMENT_PENDING…`.
- **Phase 2 agent-runtime repair**: S22. Without it the verdict carries `ASSURANCE_ONLY_LOOP`.
- **Pilot repository**: DF-6 only.

## Rollback

Per-slice commits on `phase/04-independent-assurance`; `main` untouched until the controller merges. The disabled
slot reproduces Phase 2; production mode is shadow; reverting any Lane B slice restores Phase 2 behaviour.
Migrations are forward-only; data model §3.6 holds the compensating SQL.
