# Phase 1 — Evaluation and Contracts Foundation — Report

> Machine-readable completion record for Phase 1. The YAML block below is the
> authoritative report; the prose after it is a human-readable companion.
> Evidence for every gate lives in `artifacts/phase-01/` (per-gate command,
> exit code, duration, output checksum, tool versions, env digest).

```yaml
apiVersion: asep.phase/v1
kind: PhaseReport
phase: 1
title: Evaluation and Contracts Foundation
verdict: complete

repository:
  branch: phase/01-evaluation-contracts
  base_sha: 83ba33db16072f05fb27f00f34cebd6774cb771a
  head_sha: 6d6f08c
  head_sha_note: >-
    6d6f08c is the S6 phase-close content commit (report + evidence + traceability +
    approval manifest). This administrative follow-up commit pins the resolved SHA
    into the report; a git object cannot embed its own hash, so head_sha names the
    immediately-preceding content commit that carries the full Phase 1 deliverable.
  worktree: isolated linked worktree; main untouched
  completion: offline (remote push + PR are a separate human-gated step, not a Phase 1 exit criterion)

models:
  planner: Claude Opus 4.8 (controller session)
  plan_reviewer: codex gpt-5.6-sol (read-only)
  implementer: detached coding worker in isolated worktree
  note: no model is called on any deterministic path (risk, verification, approval, failure, eval grading, metric validation)

versions:
  node: v24.6.0
  pnpm: 10.31.0
  typescript: 7.0.2
  test_runner: tsx --test

deliverables:
  A_repository_public_readiness:
    - LICENSE (Apache-2.0)
    - .gitignore hardened (.task-complete, *.tsbuildinfo, .coverage/, *.tmp)
    - .github/CODEOWNERS, pull_request_template, ISSUE_TEMPLATE/{bug_report,feature_request}
    - .github/workflows/ci.yml (install --frozen-lockfile -> format -> typecheck -> test -> schema validation -> fixture accept/reject -> template validation -> compat check -> secret scan -> large-file scan -> publication check -> clean-tree assertion)
    - scripts/{secret-scan,large-file-scan,check-publication,format-check,capture-evidence}.sh (scanners self-test on seeded canaries)
    - docs/implementation/phases/phase-01-publication-checklist.md
  B_canonical_contracts:
    - 12 JSON Schemas under packages/contracts/schema/*.schema.json ($id https://asep.dev/schema/<name>/v1 + semver version)
    - ajv-backed runtime validator (packages/contracts/src/validate.ts); ajv 8.20.0 + ajv-formats 3.0.1 (exact pins)
    - schema-authoritative TS types generated into src/generated.ts; drift-guard regeneration test
    - fixtures/{valid,invalid}/* with real rejection assertions
    - COMPATIBILITY.md + executable compatibility checker (src/compat.ts) with breaking-change mutation tests
    - templates/*.yaml aligned to the flat canonical schema and validated in test
  C_risk_verification_approval_failure:
    - policies/{risk-taxonomy,verification-matrix,approval-matrix,failure-taxonomy}.yaml (single canonical source)
    - packages/policy/src/{risk,verification,approval,failure,policy-source}.ts derived from YAML
    - 13 change categories -> R0-R4; mandatory verification matrix R->L0-L9; approval matrix; 17-class failure taxonomy + classifier
    - YAML<->TS parity tests; gatePolicy derived from approval matrix (single authority, back-compatible)
  D_evaluation_foundation:
    - evals/schema/eval-task.schema.json (task-ingest contract)
    - evals/runner/{env,graders,run,cli}.ts (deterministic: pinned ordering/seed/locale/tz, network default-deny)
    - evals/fixtures/*.json (10 labelled synthetic seeds covering all 9 grader families incl. negatives)
    - two clean runs produce byte-identical output
  E_measurement_and_evidence:
    - docs/platform/metrics-dictionary.yaml (20 metrics; machine-readable) + loader/validator
    - packages/contracts/src/run-event-catalog.ts (RunEvent field/event catalog)
    - referential-integrity validator (operands/events/dimensions must exist on RunEvent; zero-denominator policy required)
    - closed privacy enum with capture/redaction/retention/access rules
    - EvidenceBundle generator (raw output referenced by artifact id, never embedded/reduced) + schema-valid test
  F_phase_artifacts:
    - docs/implementation/phases/phase-01-report.md (this file)
    - artifacts/phase-01/** (per-gate evidence)
    - docs/implementation/phases/phase-01-traceability.md (exit-criterion -> impl + test + evidence)
    - docs/implementation/phases/phase-01-approval-manifest.md (ADR/technology-radar approval)

commits:
  - b783d03 chore(repo): harden repository for public development
  - 276833c feat(contracts): establish versioned canonical platform schemas
  - d7f591e feat(policy): add risk assurance and failure classification foundation
  - b21396d feat(evals): add deterministic phase-one evaluation foundation
  - e1e842e feat(measurement): define evidence and platform metric contracts
  - 6d6f08c docs(phase-1): record evidence and close evaluation-contracts foundation
  - "(+ administrative follow-up commit pinning head_sha into this report)"

verification:
  canonical_command: pnpm verify (format:check + typecheck + test)
  result: green
  test_count: 83 passing, 0 failing, 0 skipped
  gate_evidence: artifacts/phase-01/index.tsv (all exit 0)
  clean_checkout: pnpm install --frozen-lockfile succeeds; eval runner byte-identical across two runs

codex_review:
  plan_review: 10 adjustments accepted and applied (see phase-01-review-log.md)
  final_review: pending human-gated dispatch; no unresolved CRITICAL/HIGH known at close
  dispositions:
    - P1-CRIT-001: metrics + evals are DEFINED contracts, not empirically validated; real historical-task collection is a production-pilot dependency, not a Phase 1 exit criterion
    - P1-HIGH-001: schema/type/template drift resolved — JSON Schema is the single authority; TS generated + drift-guarded; templates validated

security:
  license: Apache-2.0 present
  secret_scan: pass (self-test green)
  git_history_secret_scan: pass
  large_file_scan: pass (no tracked file > 500KB)
  abs_path_pii_scan: pass (evidence logs sanitized: <REPO>/<HOME>/<RUNDIR>)
  dependency_license: recorded in publication checklist; new deps ajv/ajv-formats/yaml are permissive (MIT/ISC)
  publication_checklist: all-green, executable gate

metrics:
  status: defined-not-validated
  note: 20 metric contracts pass referential integrity against the RunEvent catalog; NO empirical baseline exists yet (no real runs)

deviations:
  - Used a bespoke deterministic schema->TS generator instead of json-schema-to-typescript, to keep the dependency tree minimal and make the regeneration-diff drift guard byte-deterministic.
  - Chose the FLAT contract shape as canonical (matching load-bearing runtime code and green tests); rewrote the nested-envelope templates/*.yaml to the flat shape. Recorded in the S2 commit.
  - Added a dependency-free format-check.sh as the format/lint gate rather than adding prettier/eslint to the kernel.
  - `corepack enable` fails with EACCES on this host; pnpm 10.31.0 already works, so corepack was skipped (does not affect any gate).

known_limitations:
  - Metrics and eval graders are deterministic contracts validated only against synthetic fixtures; no production data has exercised them.
  - The eval dataset is 10 synthetic seeds; it is a coverage skeleton, not a statistically meaningful benchmark.
  - No Phase 2 runtime (Temporal, real providers, memory, UI, DB projections, forge integration, auto-merge) is present by design.

production_pilot_dependencies:
  - PP1: select one real pilot repository
  - PP2: collect 30-50 genuine historical tasks with provenance + privacy review
  - PP3: produce a baseline scorecard by running the graders on the real dataset

phase_2_recommendation: >
  Proceed. The locked contracts + validators are the vertical-slice interface; the
  risk/verification matrix is the assurance ladder; the failure taxonomy is the
  classifier; the measurement dictionary is the telemetry contract; the eval
  runner + fixtures are the regression harness. The single blocking input before a
  production pilot is a real repository plus 30-50 historical tasks (PP1-PP3).
```

## Summary

Phase 1 delivers the evaluation and contracts foundation as six reviewed,
per-slice commits on `phase/01-evaluation-contracts`, off the locked base
`83ba33d`. JSON Schema is the single authoritative representation for the 12
platform contracts; TypeScript types are generated from the schemas and guarded
against drift, and an ajv-backed validator is the runtime projection of the same
source. Risk, verification, approval and failure policy are all derived from
canonical YAML with parity tests, so there is exactly one authority per policy
and no model is ever consulted on a deterministic path. The evaluation runner is
deterministic (pinned ordering/seed/locale/timezone, network default-deny) and
produces byte-identical output across runs. The measurement dictionary is
machine-readable and its operands are checked for referential integrity against
the RunEvent field catalog.

Metrics and evals are **defined contracts, not empirically validated**: no real
production run has exercised them. Collecting a real pilot repository and 30-50
historical tasks is recorded as a blocking production-pilot dependency, not a
Phase 1 exit criterion.

The canonical `pnpm verify` is green (83 tests). Per-gate evidence — command,
exit code, duration, output checksum, tool versions and environment digest — is
in `artifacts/phase-01/`, with absolute paths sanitized so the publication gate
stays clean. See `phase-01-traceability.md` for the exit-criterion → implementation
→ test → evidence mapping.
