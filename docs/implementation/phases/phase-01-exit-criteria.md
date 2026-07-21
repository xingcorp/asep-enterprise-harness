# Phase 1 — Exit Criteria (machine-checkable)

> Each item is a checkable gate. Phase 1 is COMPLETE only when every MUST item passes from a clean checkout.
> Phase 1 completes **offline**. Remote push/PR is a separate human-gated step (NOT an exit criterion).

## Legend
- `[ ]` not yet met · `[x]` met with evidence in `artifacts/phase-01/`
- **MUST** = blocks completion · **SHOULD** = strong preference, deviation recorded

## A. Repository / build integrity (MUST)

- [x] A1. `pnpm install --frozen-lockfile` succeeds from clean checkout.
- [x] A2. Canonical verify command passes: format + lint + typecheck + test.
- [x] A3. Working tree clean after verify (no diff, no untracked generated files; `*.tsbuildinfo` ignored).
- [x] A4. No `node_modules`, `dist`, `.env`, coverage, or build artifacts tracked in git.
- [x] A5. Baseline tests still pass (no pre-existing failure masked; regressions fixed not skipped).

## B. Canonical contracts (MUST)

- [x] B1. 12 contracts have a JSON Schema with `$id` (`https://asep.dev/schema/<name>/v1`) + semver `version`.
      (ProductSpec, Requirement, AcceptanceScenario, ArchitectureInvariant, WorkOrder, ContextPack, EvidenceBundle, ReviewReport, Finding, VerificationPlan, RunEvent, SkillManifest)
- [x] B2. JSON Schema is the single authoritative source; TS types + validators are generated-from / asserted-against it.
- [x] B3. Regeneration-diff (drift guard) passes: schema→types produces no diff vs committed types.
- [x] B4. Each contract has ≥1 valid fixture (accepted) and ≥1 invalid fixture (**actually rejected** — rejection asserted, not swallowed).
- [x] B5. `templates/*.yaml` validate against their authoritative schema in CI.
- [x] B6. `COMPATIBILITY.md` present + executable compatibility checker: a seeded breaking-change mutation FAILS the checker.
- [x] B7. No provider/model SDK types appear in domain contracts (grep gate).

## C. Risk / verification / approval / failure (MUST)

- [x] C1. 13 change categories mapped to R0–R4 (documentation, internal refactor, public API, database migration, authentication, authorization, secrets, infrastructure, billing/payment, production data, multi-tenant isolation, UI/UX, dependency upgrade).
- [x] C2. Mandatory verification matrix: each risk level → required assurance levels; table-driven tests pass.
- [x] C3. Approval matrix: reviewers count, different-model-family, human-merge, human-release, rollback, evidence per level; tests pass.
- [x] C4. Risk rules are deterministic (no model call); `gatePolicy` remains compatible.
- [x] C5. YAML policy ↔ TS engine parity test passes (single authority, no divergence).
- [x] C6. 17-class failure taxonomy present as data + classifier + tests (pre-existing, introduced regression, environment, flaky, provider, quota/rate-limit, context, skill-routing, tool, policy-violation, agent-loop/stall, false-completion, review-escape, duplicate-side-effect, artifact-loss, workflow-recovery-failure, + baseline).

## D. Evaluation foundation (MUST)

- [x] D1. Eval dataset schema + task-ingest schema present.
- [x] D2. Deterministic runner runs all fixtures; run twice from clean checkout → byte-identical output (pinned ordering/seed/locale/tz).
- [x] D3. Fixtures cover: contract validation, risk routing, verification-plan generation, skill routing, reviewer finding quality, malformed provider output, prompt injection, scope violation, false completion.
- [x] D4. ≤10 synthetic seeds, each labelled `source: synthetic`. No fabricated "historical" tasks.
- [x] D5. Negative cases (prompt-injection, scope-violation, false-completion) are graded and pass expected verdicts.

## E. Measurement / evidence (MUST)

- [x] E1. Machine-readable measurement dictionary; each metric has name/purpose/formula/num/denom/dimensions/source-events/owner/sampling/alert/privacy.
- [x] E2. Covers product outcome, DORA, agent task performance, trajectory quality, review effectiveness, harness reliability, cost (incl. cost-per-accepted-task), human intervention, false-completion rate.
- [x] E3. Metric operands + source-event names validate against the RunEvent field catalog (unknown event/field/dimension fails; zero-denominator policy defined).
- [x] E4. Privacy is a closed enum with capture/redaction/retention/access rules per class.
- [x] E5. Evidence-bundle generator produces a schema-valid bundle; test asserts it.

## F. Security / publication (MUST)

- [x] F1. `LICENSE` present (Apache-2.0).
- [x] F2. Secret scan passes; self-test: a seeded fake secret IS caught.
- [x] F3. Large-file scan passes (no >500KB tracked); abs-path/PII scan passes.
- [x] F4. Dependency-license check + provenance/attribution recorded.
- [x] F5. Git-history secret scan clean.
- [x] F6. Publication checklist all-green (gate is executable, not prose).

## G. Phase artifacts / governance (MUST unless noted)

- [x] G1. `phase-01-report.md` present; base_sha == `git merge-base main HEAD` (9f60c9d). head is NOT hardcoded (a commit cannot embed its own hash) — it is bound by a controller-signed `artifacts/phase-01/acceptance.json` + `scripts/check-acceptance.sh`, which also requires the evidence bundle to have been captured at the reviewed HEAD (P1-FINAL-CRIT-001 / P1-REREVIEW-CRIT-001 / P1-CHANGE-008).
- [x] G2. `artifacts/phase-01/` holds per-gate command evidence (command, exit code, duration, output/checksum, tool version, env).
- [x] G3. Traceability matrix maps every exit criterion → implementation + test + evidence (SHOULD).
- [x] G4. ADR/technology-radar approval manifest present (SHOULD).
- [x] G5. `.task-complete` created **last**, only after report + evidence written.
- [ ] G6. Acceptance marker `artifacts/phase-01/acceptance.json` present AND `scripts/check-acceptance.sh` green (marker.reviewed_head == HEAD, evidence bundle's env-digest.head_sha == reviewed_head == HEAD, base == merge-base, evidence digest matches, verdict == ACCEPT, AND the Ed25519 signature verifies against the committed reviewer public key). **Signed by the controller AFTER independent review returns ACCEPT_PHASE**, using a private key held out of tree — remains unchecked until then; any repair commit moves HEAD and invalidates a prior marker, and the worker cannot re-sign for the new HEAD.

## H. Completion protocol (MUST)

- [x] H1. No unresolved CRITICAL or HIGH finding from codex final review (or explicitly recorded disposition). — Codex final review is a separate human-gated step (plan §0 PROMPT 5); disposition recorded in `phase-01-report.md` under `codex_review` (worker self-review clean; independent review pending, not a blocker for offline completion per P1-CHANGE-007).
- [x] H2. Completion marker bound to HEAD/evidence and controller-signed; neither a simulated reviewer-rejection nor a worker forgery can leave a valid marker (P1-CHANGE-008 / P1-FINAL-CRIT-001 / P1-REREVIEW-CRIT-001). — Implemented as `artifacts/phase-01/acceptance.json` (fields: reviewed_head, base, evidence_index_sha256, verdict, signature) verified by `scripts/check-acceptance.sh`. The gate FAILS if reviewed_head != `git rev-parse HEAD`, the evidence bundle's env-digest.head_sha != reviewed_head (stale evidence), base != merge-base, evidence digest drifts, verdict != ACCEPT, or the Ed25519 signature does not verify against the committed reviewer public key (`reviewer-pubkey.pem`). The controller's private key is held out of tree, so the worker cannot mint or re-sign a marker. Its `--self-test` proves: stale-HEAD reject, stale-evidence reject, forged/unsigned reject, wrong-key reject, and non-ACCEPT reject. The `.task-complete` sentinel is still created last, but it is no longer the binding mechanism.
- [x] H3. No Phase 2+ implementation present (Temporal runtime, real providers, memory, UI) — codex final review confirms. — Verified by the worker: no Temporal/provider-SDK/memory/UI code added; scope held to schemas, deterministic policy, deterministic eval runner, and the measurement dictionary. Independent codex confirmation pending as the human-gated review step.

## Production-pilot dependencies (NOT Phase 1 exit — recorded for gate before pilot)

- [ ] PP1. One real pilot repository selected.
- [ ] PP2. 30–50 genuine historical tasks collected with provenance + privacy review.
- [ ] PP3. Baseline scorecard produced by running the graders on the real dataset.
