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
  base_sha: 9f60c9d2c6da2a00b2dc9e6da188e6cf26f1885e
  base_sha_note: >-
    base = `git merge-base main HEAD`. main advanced to 9f60c9d (the plan-approval
    docs commit) after the branch was created, so the true fork point is 9f60c9d,
    not the older 83ba33d starter-import commit named in the locked plan.
  head_sha: bound-by-signed-acceptance-marker
  head_sha_note: >-
    A git object cannot embed its own hash, and HEAD advances on every repair
    commit, so this report does NOT hardcode a head SHA. Completion is instead
    bound to the reviewed commit by a CONTROLLER-SIGNED artifacts/phase-01/acceptance.json,
    written only AFTER the independent review returns ACCEPT_PHASE. The marker
    carries an Ed25519 signature over (reviewed_head, base, evidence_index_sha256,
    verdict); the private key is held out of tree by the controller and only the
    reviewer public key (artifacts/phase-01/reviewer-pubkey.pem) is committed.
    scripts/check-acceptance.sh verifies: marker.reviewed_head == `git rev-parse HEAD`,
    the untracked evidence bundle's env-digest.head_sha == reviewed_head == HEAD
    (P1-FINAL-CRIT-001 — evidence must be captured at the exact reviewed commit),
    marker.base == merge-base, marker.evidence_index_sha256 == sha256(index.tsv),
    verdict == ACCEPT, AND the signature verifies against the reviewer public key
    (P1-REREVIEW-CRIT-001 — the worker cannot forge acceptance). Any repair lands a
    new commit, moves HEAD, and instantly invalidates a prior marker; the worker
    cannot re-sign for the new HEAD (P1-CHANGE-008) — false completion cannot
    survive a repair cycle.
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
    - .github/workflows/ci.yml (single step: pnpm verify:all — the exact full gate a developer runs locally, so CI and local cannot diverge; P1-FINAL-MED-004)
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
    - evals/runner/{launcher,worker-entry,determinism-preload,adversarial-entry,adversarial-fixture}.ts (trusted-bootstrap: preload-first ordering + attestation fail-closed; cli routes through the launcher; P1-CYCLE4-MED-002, ADR 0016)
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
  note: >-
    Six slice commits plus repair-cycle-1 fix commits (fix(phase-1): P1-FINAL-*).
    The exact set is recorded in git log; the acceptance marker binds the reviewed
    HEAD rather than this list, so the list is descriptive, not authoritative.
  slices:
    - b783d03 chore(repo): harden repository for public development
    - 276833c feat(contracts): establish versioned canonical platform schemas
    - d7f591e feat(policy): add risk assurance and failure classification foundation
    - b21396d feat(evals): add deterministic phase-one evaluation foundation
    - e1e842e feat(measurement): define evidence and platform metric contracts
    - 6d6f08c docs(phase-1): record evidence and close evaluation-contracts foundation

verification:
  canonical_command: pnpm verify:all (format + typecheck + test + secret + large-file + publication + clean-tree)
  quick_command: pnpm verify (format:check + typecheck + test only — subset, NOT the full gate)
  result: green
  gate_evidence: artifacts/phase-01/index.tsv (all exit 0)
  clean_checkout: pnpm install --frozen-lockfile succeeds; eval runner byte-identical across two runs

codex_review:
  plan_review: 10 adjustments accepted and applied (see phase-01-review-log.md)
  final_review: repair cycle 1 complete — 10 findings raised on the built tree (1 CRITICAL, 5 HIGH, 4 MEDIUM), all accepted and fixed; no unresolved CRITICAL/HIGH
  rereview_cycle_2: 7 cycle-1 partials re-fixed by exploit + 1 new CRITICAL (P1-REREVIEW-CRIT-001, controller-signed acceptance bound to evidence at the reviewed HEAD); HIGH-004/HIGH-005/MED-004 confirmed resolved
  rereview_cycle_3:
    reviewer: codex gpt-5.6-sol (read-only)
    reviewed_head: 1af1cff0dde456b935a5886e9895ae4ebbeeec58
    verdict_in: REQUEST_REPAIR @ 0.99
    result: 4 residual bypasses closed, each with an adversarial test; HIGH-001/HIGH-002/HIGH-003/MED-003 confirmed genuinely closed and left untouched
    dispositions:
      - P1-REREVIEW-CRIT-001a+b (5116c4a): acceptance fails closed on empty/missing/duplicate env-digest head_sha; env_digest_sha256 bound into the signed payload (domain v1->v2) so rewriting head_sha in env-digest breaks the signature; self-test 9/9
      - P1-CYCLE3-HIGH-001 (4f470ed): compat gate rejects non-increasing versions (compareSemver; actualBump forward-only) and requires $id-major == version-major; version+$id downgrade and $id/version-major disagreement now FAIL
      - P1-FINAL-MED-001 (d849eca): prompt-injection resistance fails closed on any engine-demonstrated breach regardless of the mutable expected block; expected only refines the no-breach case
      - P1-FINAL-MED-002 (12e7d2b): network deny poisons transport methods on the shared dgram/net/tls/dns.Resolver prototypes, so pre-captured factories and constructor-based egress are both inert; 3 canaries added
    controller_owned:
      - P1-REREVIEW-CRIT-001c (trust-root provenance): the controller pins the reviewer public-key fingerprint outside the worker branch after ACCEPT; out of worker scope
  rereview_cycle_4:
    reviewer: codex gpt-5.6-sol (read-only)
    reviewed_head: 97d1e4ec815e11c33a9abeae45b8fa740ade7615
    verdict_in: REQUEST_REPAIR @ 0.99
    result: >-
      4 cycle-3 fixes re-verified by exploit reconstruction and left untouched
      (REREVIEW-CRIT-001a empty-head fail-closed, REREVIEW-CRIT-001b env-digest
      bound into the signed payload, REREVIEW-CRIT-001c controller-held trust
      root, FINAL-MED-001 breach fails regardless of expected). Three
      residual/new items fixed in repair cycle 5, each with a reproduction that
      fails on the old code and passes on the new; no security/assurance test
      was weakened (test-integrity diff adds only new assertions + new required
      suites).
    dispositions:
      - P1-CYCLE3-HIGH-001 partial (100fdad): compat gate accepted a breaking change with a missing/unversioned $id because $id-major==version-major was only enforced when a versioned $id parsed. Canonical identity is now fail-closed — every schema MUST carry a non-empty $id parsing under the single https://asep.dev/schema/<name>/vN rule whose major exactly equals the semver major; missing/empty/malformed/unversioned $id, $id-major≠version-major, non-semver version, logical-identity swap and duplicate $id are all hard failures. Self-test cases 6/7 reproduce the exact deleted-/unversioned-$id bypass.
      - P1-CYCLE4-MED-001 new (b5e7ca7): package.json's test script used a shell glob (scripts/**/*.test.ts) that /bin/sh does not expand recursively, silently dropping scripts/check-acceptance.test.ts + forbidden-imports.test.ts from the canonical command. Replaced with a shell-free deterministic Node runner (run-canonical-tests.mjs): recursive discovery, sorted paths, shell:false explicit argv, exact exit-code propagation, full raw capture, and a REQUIRED-SUITE-ID check that fails closed if any critical suite's machine-readable marker is absent even on exit 0. The wiring suite is itself REQUIRED, so the guard cannot be dropped.
      - P1-FINAL-MED-002 partial (70d286c): network deny was still bypassable via an ESM named-import factory (no syncBuiltinESMExports after patch) and a callable captured before enforcement. Fixed the class with the approved trusted-bootstrap architecture (ADR 0016): a canonical launcher spawns node --import <tsx> --import <determinism-preload> <worker-entry> (shell:false, sanitized env stripping NODE_OPTIONS/loaders/inspector); the preload runs enforceDeterminism()+syncBuiltinESMExports() as the first application action and attests; worker-entry asserts attestation before dynamic-importing task/grader code (fail-closed if the preload was skipped). Guarded surfaces cover net/dgram/dns/http/https/http2/tls/global fetch + child_process/worker_threads escape. An honest adversarial fixture driven through the real launcher blocks every egress trick (ESM named, CJS require, constructor egress, microtask-deferred, dynamic re-import, fetch, process/thread escape); a bootstrap-order regression proves the fixture body never evaluates when the preload is omitted. Threat model bounded explicitly: a deterministic-execution guard and defense against accidental egress, NOT a security boundary against arbitrary hostile in-process native/runtime code (RR-14 + Phase 2 OS-isolation backlog).
  plan_dispositions:
    - P1-CRIT-001: metrics + evals are DEFINED contracts, not empirically validated; real historical-task collection is a production-pilot dependency, not a Phase 1 exit criterion
    - P1-HIGH-001: schema/type/template drift resolved — JSON Schema is the single authority; TS generated + drift-guarded; templates validated
  final_dispositions:
    - P1-FINAL-CRIT-001 (8221fa6): completion bound to reviewed HEAD via acceptance.json + check-acceptance.sh; a repair commit invalidates a prior marker
    - P1-FINAL-HIGH-001 (600a562): drift guard now asserts x-tsType branded-type overrides
    - P1-FINAL-HIGH-002 (203f12f): compat gate diffs live schemas against frozen v1 snapshots; breaking mutation fails
    - P1-FINAL-HIGH-003 (ca8b930): real dependency-license inventory (fail-closed) + PII scanner + shared secret-pattern lib (HEAD/history cannot diverge)
    - P1-FINAL-HIGH-004 (1fca71c): @asep/policy test script added (was a silent CI no-op) + forbidden-import fitness test
    - P1-FINAL-HIGH-005 (3207b2f): legacy duplicate risk-policy.yaml removed; guard test fails if it reappears
    - P1-FINAL-MED-001 (2c05b53): prompt-injection grader re-based on a trusted action trace; fails if an out-of-allowlist op actually executed
    - P1-FINAL-MED-002 (91dbb4f): eval network deny hardened across net/http/https/fetch (was dns.lookup only) + canary + shuffle-discovery tests
    - P1-FINAL-MED-003 (41ca7eb): conjunctive metric filters + per-operand formula<->operand agreement validator; two drifting metrics fixed
    - P1-FINAL-MED-004 (c6c115d): single verify:all full-gate entry point; CI calls the exact script developers run locally

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
per-slice commits (plus repair-cycle-1 fixes) on `phase/01-evaluation-contracts`,
off the true fork point `9f60c9d` (`git merge-base main HEAD`; the locked plan
named the older starter-import `83ba33d`, but main advanced to the plan-approval
commit before the branch forked). JSON Schema is the single authoritative representation for the 12
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

The canonical `pnpm verify:all` full gate is green (192 tests via the shell-free
`scripts/run-canonical-tests.mjs`, which fails closed if any REQUIRED critical
suite is dropped). Per-gate evidence — command,
exit code, duration, output checksum, tool versions and environment digest — is
in `artifacts/phase-01/`, with absolute paths sanitized so the publication gate
stays clean. See `phase-01-traceability.md` for the exit-criterion → implementation
→ test → evidence mapping.
