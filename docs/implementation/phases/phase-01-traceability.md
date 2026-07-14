# Phase 1 — Traceability Matrix (P1-OPT-001)

> Maps every exit criterion in `phase-01-exit-criteria.md` to its implementation,
> the test that proves it, and the evidence that records it. Evidence gates live
> in `artifacts/phase-01/` (see `index.tsv`); test evidence is the `pnpm verify`
> run captured in `artifacts/phase-01/gates/test.log`.

## A. Repository / build integrity

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| A1 | `pnpm install --frozen-lockfile` from clean checkout | `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `install-frozen` gate | `artifacts/phase-01/gates/install-frozen.*` |
| A2 | Canonical verify passes (format+lint+typecheck+test) | `package.json` `verify` script | `pnpm verify` | `gates/{format-check,typecheck,test}.*` |
| A3 | Working tree clean after verify | `.gitignore` (`*.tsbuildinfo`, `dist/`, coverage) | clean-tree assertion in `ci.yml` | `gates/*` + `git status` |
| A4 | No build artifacts tracked | `.gitignore` | `large-file-scan` + manual `git ls-files` | `gates/large-file-scan.*` |
| A5 | Baseline tests still pass (no masking) | policy/domain/worker tests retained | `pnpm test` = 83 pass | `gates/test.log` |

## B. Canonical contracts

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| B1 | 12 schemas with `$id` + semver | `packages/contracts/schema/*.schema.json` | `validate.test.ts` (contract count) | `gates/test.log` |
| B2 | Schema single-authority; types generated/asserted | `src/gen/generate-types.ts`, `src/generated.ts`, `src/validate.ts` | `drift.test.ts` | `gates/test.log` |
| B3 | Regeneration-diff drift guard | `src/gen/generate-types.ts` | `drift.test.ts` (byte-identical) | `gates/test.log` |
| B4 | Each contract ≥1 valid (accepted) + ≥1 invalid (rejected) | `fixtures/{valid,invalid}/*` | `validate.test.ts` (accept/reject asserted) | `gates/test.log` |
| B5 | Templates validate against schema | `templates/*.yaml` | `templates.test.ts` | `gates/test.log` |
| B6 | COMPATIBILITY.md + executable checker; breaking mutation fails | `COMPATIBILITY.md`, `src/compat.ts` | `compat.test.ts` (mutation fixtures) | `gates/test.log` |
| B7 | No provider/model SDK in domain contracts | `schema/*`, `src/base.ts` | grep gate in `ci.yml` | `ci.yml` |

## C. Risk / verification / approval / failure

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| C1 | 13 change categories → R0-R4 | `policies/risk-taxonomy.yaml`, `src/risk.ts` | `risk.test.ts`, `parity.test.ts` | `gates/test.log` |
| C2 | Mandatory verification matrix | `policies/verification-matrix.yaml`, `src/verification.ts` | `verification.test.ts` (table-driven) | `gates/test.log` |
| C3 | Approval matrix | `policies/approval-matrix.yaml`, `src/approval.ts` | `approval.test.ts` | `gates/test.log` |
| C4 | Risk rules deterministic; gatePolicy compatible | `src/risk.ts`, `src/index.ts` (derived gatePolicy) | `parity.test.ts`, `index.test.ts` | `gates/test.log` |
| C5 | YAML ↔ TS parity | `src/policy-source.ts` | `parity.test.ts` | `gates/test.log` |
| C6 | 17-class failure taxonomy + classifier | `policies/failure-taxonomy.yaml`, `src/failure.ts` | `failure.test.ts` (17 classes) | `gates/test.log` |

## D. Evaluation foundation

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| D1 | Eval dataset + task-ingest schema | `evals/schema/eval-task.schema.json` | `eval.test.ts` (schema validation) | `gates/test.log` |
| D2 | Deterministic runner; byte-identical twice | `evals/runner/{env,run}.ts` | `eval.test.ts` + `eval-determinism` gate | `gates/eval-determinism.*` |
| D3 | Fixtures cover 9 categories | `evals/fixtures/*.json` | `eval.test.ts` (coverage) | `gates/test.log` |
| D4 | ≤10 synthetic seeds, labelled | `evals/fixtures/*.json` | `eval.test.ts` (count + source) | `gates/test.log` |
| D5 | Negatives graded to expected verdicts | `evals/runner/graders.ts` | `eval.test.ts` (negative cases pass) | `gates/test.log` |

## E. Measurement / evidence

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| E1 | Machine-readable dictionary; full metric fields | `docs/platform/metrics-dictionary.yaml` | `metrics.test.ts` | `gates/test.log` |
| E2 | Covers all mandated families incl. cost-per-accepted-task, false-completion | `metrics-dictionary.yaml` (20 metrics) | `metrics.test.ts` (family coverage) | `gates/test.log` |
| E3 | Operands validate against RunEvent catalog; zero-denom policy | `src/metrics.ts`, `run-event-catalog.ts` | `metrics.test.ts` (referential integrity) | `gates/test.log` |
| E4 | Privacy closed enum with rules | `metrics-dictionary.yaml` `privacyClasses` | `metrics.test.ts` (privacy rules) | `gates/test.log` |
| E5 | Evidence-bundle generator produces schema-valid bundle | `packages/observability/src/evidence.ts` | `evidence.test.ts` | `gates/test.log` |

## F. Security / publication

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| F1 | LICENSE (Apache-2.0) | `LICENSE` | `check-publication.sh` license step | `gates/check-publication.*` |
| F2 | Secret scan + self-test | `scripts/secret-scan.sh` | scanner self-test on seeded canary | `gates/secret-scan.*` |
| F3 | Large-file + abs-path/PII scan | `scripts/{large-file-scan,check-publication}.sh` | scanner self-tests | `gates/{large-file-scan,check-publication}.*` |
| F4 | Dependency-license + provenance | `phase-01-publication-checklist.md` | publication gate step | `gates/check-publication.*` |
| F5 | Git-history secret scan | `scripts/check-publication.sh` | history scan step | `gates/check-publication.*` |
| F6 | Publication checklist all-green (executable) | `scripts/check-publication.sh` | full gate exit 0 | `gates/check-publication.*` |

## G. Phase artifacts / governance

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| G1 | Report with base + head SHA | `phase-01-report.md` | SHA matches `git log` | this file + report |
| G2 | Per-gate evidence | `scripts/capture-evidence.sh` | `artifacts/phase-01/index.tsv` | `artifacts/phase-01/**` |
| G3 | Traceability matrix (SHOULD) | this file | — | this file |
| G4 | ADR/technology-radar approval manifest (SHOULD) | `phase-01-approval-manifest.md` | — | that file |
| G5 | `.task-complete` created last | dispatcher protocol | created after report+evidence | session log |

## H. Completion protocol

| # | Criterion | Implementation | Test / proof | Evidence |
|---|-----------|----------------|--------------|----------|
| H1 | No unresolved CRITICAL/HIGH (or recorded disposition) | `phase-01-review-log.md`, report `codex_review` | final review pending human dispatch | report |
| H2 | Marker bound to HEAD/evidence | commit-per-slice; marker after green gates | evidence checksums | `artifacts/phase-01/**` |
| H3 | No Phase 2+ implementation | scope adherence | no Temporal/provider/memory/UI code added | `git diff --stat` |
