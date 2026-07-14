# Phase 1 — Exit Criteria (machine-checkable)

> Each item is a checkable gate. Phase 1 is COMPLETE only when every MUST item passes from a clean checkout.
> Phase 1 completes **offline**. Remote push/PR is a separate human-gated step (NOT an exit criterion).

## Legend
- `[ ]` not yet met · `[x]` met with evidence in `artifacts/phase-01/`
- **MUST** = blocks completion · **SHOULD** = strong preference, deviation recorded

## A. Repository / build integrity (MUST)

- [ ] A1. `pnpm install --frozen-lockfile` succeeds from clean checkout.
- [ ] A2. Canonical verify command passes: format + lint + typecheck + test.
- [ ] A3. Working tree clean after verify (no diff, no untracked generated files; `*.tsbuildinfo` ignored).
- [ ] A4. No `node_modules`, `dist`, `.env`, coverage, or build artifacts tracked in git.
- [ ] A5. Baseline tests still pass (no pre-existing failure masked; regressions fixed not skipped).

## B. Canonical contracts (MUST)

- [ ] B1. 12 contracts have a JSON Schema with `$id` (`https://asep.dev/schema/<name>/v1`) + semver `version`.
      (ProductSpec, Requirement, AcceptanceScenario, ArchitectureInvariant, WorkOrder, ContextPack, EvidenceBundle, ReviewReport, Finding, VerificationPlan, RunEvent, SkillManifest)
- [ ] B2. JSON Schema is the single authoritative source; TS types + validators are generated-from / asserted-against it.
- [ ] B3. Regeneration-diff (drift guard) passes: schema→types produces no diff vs committed types.
- [ ] B4. Each contract has ≥1 valid fixture (accepted) and ≥1 invalid fixture (**actually rejected** — rejection asserted, not swallowed).
- [ ] B5. `templates/*.yaml` validate against their authoritative schema in CI.
- [ ] B6. `COMPATIBILITY.md` present + executable compatibility checker: a seeded breaking-change mutation FAILS the checker.
- [ ] B7. No provider/model SDK types appear in domain contracts (grep gate).

## C. Risk / verification / approval / failure (MUST)

- [ ] C1. 13 change categories mapped to R0–R4 (documentation, internal refactor, public API, database migration, authentication, authorization, secrets, infrastructure, billing/payment, production data, multi-tenant isolation, UI/UX, dependency upgrade).
- [ ] C2. Mandatory verification matrix: each risk level → required assurance levels; table-driven tests pass.
- [ ] C3. Approval matrix: reviewers count, different-model-family, human-merge, human-release, rollback, evidence per level; tests pass.
- [ ] C4. Risk rules are deterministic (no model call); `gatePolicy` remains compatible.
- [ ] C5. YAML policy ↔ TS engine parity test passes (single authority, no divergence).
- [ ] C6. 17-class failure taxonomy present as data + classifier + tests (pre-existing, introduced regression, environment, flaky, provider, quota/rate-limit, context, skill-routing, tool, policy-violation, agent-loop/stall, false-completion, review-escape, duplicate-side-effect, artifact-loss, workflow-recovery-failure, + baseline).

## D. Evaluation foundation (MUST)

- [ ] D1. Eval dataset schema + task-ingest schema present.
- [ ] D2. Deterministic runner runs all fixtures; run twice from clean checkout → byte-identical output (pinned ordering/seed/locale/tz).
- [ ] D3. Fixtures cover: contract validation, risk routing, verification-plan generation, skill routing, reviewer finding quality, malformed provider output, prompt injection, scope violation, false completion.
- [ ] D4. ≤10 synthetic seeds, each labelled `source: synthetic`. No fabricated "historical" tasks.
- [ ] D5. Negative cases (prompt-injection, scope-violation, false-completion) are graded and pass expected verdicts.

## E. Measurement / evidence (MUST)

- [ ] E1. Machine-readable measurement dictionary; each metric has name/purpose/formula/num/denom/dimensions/source-events/owner/sampling/alert/privacy.
- [ ] E2. Covers product outcome, DORA, agent task performance, trajectory quality, review effectiveness, harness reliability, cost (incl. cost-per-accepted-task), human intervention, false-completion rate.
- [ ] E3. Metric operands + source-event names validate against the RunEvent field catalog (unknown event/field/dimension fails; zero-denominator policy defined).
- [ ] E4. Privacy is a closed enum with capture/redaction/retention/access rules per class.
- [ ] E5. Evidence-bundle generator produces a schema-valid bundle; test asserts it.

## F. Security / publication (MUST)

- [ ] F1. `LICENSE` present (Apache-2.0).
- [ ] F2. Secret scan passes; self-test: a seeded fake secret IS caught.
- [ ] F3. Large-file scan passes (no >500KB tracked); abs-path/PII scan passes.
- [ ] F4. Dependency-license check + provenance/attribution recorded.
- [ ] F5. Git-history secret scan clean.
- [ ] F6. Publication checklist all-green (gate is executable, not prose).

## G. Phase artifacts / governance (MUST unless noted)

- [ ] G1. `phase-01-report.md` present with base + head SHA matching git.
- [ ] G2. `artifacts/phase-01/` holds per-gate command evidence (command, exit code, duration, output/checksum, tool version, env).
- [ ] G3. Traceability matrix maps every exit criterion → implementation + test + evidence (SHOULD).
- [ ] G4. ADR/technology-radar approval manifest present (SHOULD).
- [ ] G5. `.task-complete` created **last**, only after report + evidence written.

## H. Completion protocol (MUST)

- [ ] H1. No unresolved CRITICAL or HIGH finding from codex final review (or explicitly recorded disposition).
- [ ] H2. Completion marker bound to HEAD/evidence; a simulated reviewer-rejection cannot leave a valid marker (P1-CHANGE-008).
- [ ] H3. No Phase 2+ implementation present (Temporal runtime, real providers, memory, UI) — codex final review confirms.

## Production-pilot dependencies (NOT Phase 1 exit — recorded for gate before pilot)

- [ ] PP1. One real pilot repository selected.
- [ ] PP2. 30–50 genuine historical tasks collected with provenance + privacy review.
- [ ] PP3. Baseline scorecard produced by running the graders on the real dataset.
