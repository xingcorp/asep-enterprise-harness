# Phase 4 — Risk Register (DRAFT v1)

> Delivery, design and measurement risks for independent assurance. Base `00a6889`. Severity = impact ×
> likelihood. Draft for the controller's Codex plan review; not locked.

| ID | Risk | Sev | Mitigation | Trigger / owner action |
|----|------|-----|-----------|------------------------|
| PR4-01 | **Circular measurement**: the corpus labels come from `gpt-5.6-sol`, the proposed runtime reviewer, so its recall is inflated and other reviewers are penalised for different-but-real findings | HIGH | Report the labeller-miss subset separately; non-model baselines; circularity stated in every scorecard; optional different-family comparator (D-4); no generalisation beyond `scope` | Scorecard lacks the subset or the statement → scorer test fails (EC I5) |
| PR4-02 | **Answer-key leakage**: packets built at the parent of a fix commit or including review documents/commit messages (e.g. `3ea0293` adds the Phase 2 final review on top of reviewed tree `2e61f24`) | HIGH | Packets only at the reviewed SHA; review artifacts and git metadata excluded by rule; leakage test | EC I2 fails |
| PR4-03 | **Prompt overfitting**: rubric tuned on the items later reported | HIGH | Dev/test split by phase; protocol, matcher, corpus and config hashes frozen before the first test-split run; scorer rejects mismatches | EC I3 fails |
| PR4-04 | **Small n** (≈33 top-level code IDs) read as precise numbers | HIGH | n + Wilson 95% interval everywhere; cells with n < 20 descriptive-only; no "difference" claimed on overlapping intervals | EC I5 |
| PR4-05 | **Label errors** in the hand-curated corpus (transcription, merged IDs, second-hand Phase 1 cycle-1 labels) | MED | Git-verified claims; `labelQuality` and `instanceKind` fields; human spot-check of all HIGH/CRITICAL; first-occurrence vs residual reported separately | EC I1; `humanVerified` coverage in the report |
| PR4-06 | **Corpus becomes irreproducible** after the controller rebases/squashes Phase 2, or because reviewed SHAs are already unreachable (`bb11d00`, `89a745b`) | HIGH | Reachability checked against advertised refs; unreachable items excluded with reason; SR-G1 asks the controller to keep history or tag reviewed SHAs | Verifier reports newly unreachable items |
| PR4-07 | **Green gate that does not exercise the MUSTs** (Phase 2 P2-FINAL-HIGH-001 lesson) | HIGH | Every MUST mapped to a registered suite; `exit-criteria-coverage` test parses the mapping | EC L3 fails |
| PR4-08 | **Faked backends where real ones are required** (Phase 2 lesson) | HIGH | Real PG + Git + sandbox itests required; reviewer faked only at HTTP with the real adapter; measurement only from live recordings | EC E10, I6 |
| PR4-09 | **Dashboards as vocabulary only**: panels exist but no runtime events (P2-FINAL-MED-003 lesson) | HIGH | `RunEventSink` emission inside the steps; real-backend evaluator itest; telemetry-completeness panel | EC J4, J5 |
| PR4-10 | **False completion of the phase itself**: implementer status claims not backed by observation | HIGH | Report fields generated from machine sources; "not verified" vocabulary; sentinel binds HEAD | Controller re-runs gates independently |
| PR4-11 | **Injection → false APPROVE** lets a defect reach human review unflagged | MED | Model verdict advisory; deterministic checks outrank; human merge still required for R2; injection suite measured | EC D2, D5 |
| PR4-12 | **Injection → escalation flood** (adversarial findings or ESCALATE verdicts) burns human time | LOW | Ungrounded findings auto-refuted; escalation rate metric; repair rounds bounded | `review_escalation_rate` alert in runbook |
| PR4-13 | **Reviewer gateway unavailable / rate limited** (Phase 2 cycle 6 hit provider 429/503) | MED | Bounded retries honouring `Retry-After`; ESCALATE in gating (never PROCEED); resumable capture runs with bounded concurrency; schedule measurement away from controller review runs | `reviewer_failure_rate`; rehearsal M2 |
| PR4-14 | **Model drift**: the gateway serves a different model snapshot than pinned | MED | Record `servedModel`; mismatch fails gating reviews; promotion bound to config hash | EC G1; runbook |
| PR4-15 | **Cost blow-up** from large packets × k runs × high reasoning effort | MED | Packet byte budget; `max_output_tokens`; k bounded by protocol; tokens always recorded; cost only from a configured price | `mean_review_cost_usd`; budget stop in capture CLI |
| PR4-16 | **Credential leak** of the reviewer key into artifacts, logs, DB or the coder sandbox | HIGH | Adapter-internal credential source; header-only use; scrubbed errors; env allowlist test; canary scan in the real-backend itest | EC C5 |
| PR4-17 | **Source-code egress** to a third-party reviewer without tenant consent | MED | Per-project reviewer enablement in policy; disabled reviewer ⇒ R2 `DEFERRED`; documented in threat model | Admission table EC K1/K8 |
| PR4-18 | **Shared-surface conflicts with Lane A**: concurrent `run-event` minor bumps, migration ordering, the `attempts.status` check constraint recreated by two migrations, edits to `governed-execution.ts`/`operational.ts`/forbidden-imports | HIGH | All listed in plan §17 with exact content; controller reconciles before implementation; Lane B edits none during planning | Controller reconciliation record |
| PR4-19 | **Phase 2 not accepted**: cycle-6 repairs change ports or step signatures this plan composes | MED | Plan binds to symbols; re-adjudicate in the review log on rebase; slices S11/S12 start after the controller rebases | Rebase diff touches `pipeline-steps.ts`, `ports/index.ts`, `governed-execution.ts` |
| PR4-20 | **Compat gate gap**: a v2 schema compared only against v1 snapshots stops being guarded | HIGH | SR-C3 per-major snapshot selection with self-tests before any v2 contract lands | EC B2 |
| PR4-21 | **Grafana not actually exercised** in the required gate (D-6) | LOW | Snapshots + evaluator are the authoritative proof; structural dashboard test; opt-in Grafana smoke; limitation stated in the report | Decision D-6 |
| PR4-22 | **Scope creep** into an agentic, tool-using reviewer or into orchestration | MED | Out-of-scope list; packet-only port; Lane A owns composition | Review gate |
| PR4-23 | **Packet too narrow** for gate-adequacy and claim-integrity defects that need the spec or the report | MED | Packet includes WorkOrder requirements and, for corpus items, the phase exit-criteria and report at the reviewed SHA (review artifacts excluded); `not-in-packet` exclusions counted | Exclusion table in scorecard |
| PR4-24 | **Non-determinism mistaken for regression** between reruns | MED | Record/replay; k-run stability metric; variance reported, not hidden | EC I4, I5 |
| PR4-25 | **Recorded responses trip publication gates** (secret-like or PII-like strings echoed from code) or exceed 500 KiB | LOW | One file per item/run; scanners run on recordings; a recording that cannot pass is excluded with reason rather than allowlisted | `verify:all` scans |

## Blocking dependencies carried forward

- **Reviewer gateway credential** for the live run (plan §24, SR-G2). Without it the verdict is
  `IMPLEMENTATION_COMPLETE_MEASUREMENT_PENDING`.
- **Pilot repository** (Phase 1 PP1/PP2, Phase 2 K2/K6). Without it the verdict cannot exceed
  `IMPLEMENTATION_COMPLETE_MEASURED_ON_SELF_HISTORY`.

## Rollback

Per-slice commits on `phase/04-independent-assurance`; `main` untouched until the controller merges. The slot
is inert until Lane A wires it; R2 stays `DEFERRED` without a promotion record; reverting any Lane B slice
restores Phase 2 behaviour. Migrations are additive (SR-M4 widens a constraint; rollback is a forward
migration).
