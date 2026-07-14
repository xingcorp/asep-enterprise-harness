# Phase 1 — Evaluation and Contracts Foundation — Plan (LOCKED)

> Status: **LOCKED** — canonical plan for Phase 1 implementation.
> Supersedes `phase-01-plan-v1.md`. Adjudication of the Codex review is in `phase-01-review-log.md`.
> Planner: Claude Opus 4.8 (controller session). Reviewer: codex gpt-5.6-sol (read-only).

```text
BASE_SHA: 83ba33db16072f05fb27f00f34cebd6774cb771a   (main — "chore: import ASEP reference starter baseline")
```

---

## 0. Execution model

Executed with the on-machine `long-task-stack` system, not a simulated multi-agent pipeline.

| Step | Role | Runner |
|---|---|---|
| PROMPT 1 | Planner (Opus 4.8) | controller session, read+plan only |
| PROMPT 2 | Plan reviewer | `codex` CLI, fresh read-only |
| PROMPT 3 | Plan lock | controller session + one docs commit on `main` |
| PROMPT 4 | Implementer | detached Claude Code worker via `stack spawn`, isolated worktree, branch `phase/01-evaluation-contracts`, commit-per-slice, `.task-complete` at end |
| PROMPT 6 | Dispatcher | controller session monitors sentinel + commit progress, resumes on interruption |
| PROMPT 5 | Final reviewer | `codex` CLI, fresh read-only, verifies repo+evidence not transcripts |
| Publish | human-gated | end of session: `git push` + `gh pr create` after publication gate green |

Load-bearing constraints:
- 9router `:20128` is **UP** — both `--engine claude` (own auth) and `--engine hermes` (via 9router) are usable. Engine choice confirmed with owner at the spawn boundary.
- COMPLETE asserted only by sentinel FILE `.task-complete` + exit 0, never by log grep.
- `git add -A` forbidden; stage selectively after `git status` + size/secret scan.
- Public-repo creation deferred to end of session, human-gated. **Phase 1 completes OFFLINE** (per P1-CHANGE-007 accepted).

## 1. Current-state audit

Verified on `main` @ `83ba33d`: Node 24.6.0, pnpm 10.31.0, TS 7.0.2, `tsx` runner. `pnpm install` clean; `pnpm typecheck` passes; `pnpm test` = 4/4 pass. No pre-existing failures, no `node_modules`/`dist` in tree. Workspace, docs (15 ADRs, all platform docs), policy fragment (`gatePolicy` R0–R4), YAML templates, single eval example, repo governance files all present. **Confirmed contract-representation drift**: templates use `apiVersion/kind/metadata/spec` envelope (e.g. `WorkOrder.spec.repository.baseSha`) while `packages/contracts/src/index.ts` is flat (`WorkOrder.baseSha`).

## 2–4. Present / Missing / Pre-public

Present: TS domain types, deterministic R0–R4 gate policy + tests, policy YAML, contract templates, complete docs, passing kernel, governance files.

Missing (Phase 1 scope): JSON Schema for 12 contracts; `$id`+semver+compat policy+fixtures+validators+drift guard; full 13-category risk taxonomy + verification matrix + approval matrix; 17-class failure taxonomy + classifier; machine-readable measurement dictionary; eval runner + labelled fixtures incl. negatives; `artifacts/phase-01/`; GitHub meta (LICENSE, CODEOWNERS, PR/issue templates, CI, publication checklist).

Pre-public: add `LICENSE` (Apache-2.0); complete `.gitignore` (+`.task-complete`, coverage, tsbuildinfo); secret scan; large-file scan; abs-path/PII scan; CI red on any gate; no push until secret+license gates pass.

## 5. Scope

Deliverables A–G: repo public-readiness; canonical versioned contracts (schema+types+validators+fixtures+tests); risk/verification/approval/failure taxonomy with tests; deterministic eval dataset+runner incl. negatives; machine-readable measurement dictionary + evidence bundle generation; phase artifact docs.

Exit criterion (per 90-day plan): *historical tasks can be represented and graded deterministically* — proven on **labelled synthetic fixtures**, with real historical-task collection recorded as a **blocking production-pilot dependency** (see review-log P1-CRIT-001 disposition).

## 6. Out-of-scope (Phase 2+)

Temporal runtime/activities; real Claude/Codex/OpenHands/ADK providers; Mem0/Graphiti/RTK/Caveman; Web Console/UI; forge integration beyond repo meta; worktree/sandbox manager service; PostgreSQL projections; auto-merge; production side effects; model calls inside deterministic risk rules; remote publication + PR (moved out of Phase 1 completion per P1-CHANGE-007).

## 7. Task DAG (acyclic)

```text
S1 repo-readiness ──┐
                    ├─> S6 integration+docs ─> codex-final-review ─> (gated) publish
S2 contracts ───────┤
S3 risk/failure ────┤   (S3 depends on S2 for RiskLevel/types)
S4 evals ───────────┤   (S4 depends on S2 contracts + S3 taxonomy)
S5 measurement ─────┘   (S5 depends on S2 EvidenceBundle/RunEvent)
```

## 8. Slice decomposition + commit messages

- **S1 Repo public-readiness** → `chore(repo): harden repository for public development`
- **S2 Canonical contract schemas** → `feat(contracts): establish versioned canonical platform schemas`
- **S3 Risk/verification/failure taxonomy** → `feat(policy): add risk assurance and failure classification foundation`
- **S4 Evaluation foundation** → `feat(evals): add deterministic phase-one evaluation foundation`
- **S5 Measurement + evidence** → `feat(measurement): define evidence and platform metric contracts`
- **S6 Integration + docs** → `docs(phase-1): record evidence and close evaluation-contracts foundation`

Each slice: read exit criteria → test-first where sensible → smallest change → run slice gate → review diff → commit → write evidence.

## 9. File-level change map

- **S1**: `LICENSE` (Apache-2.0), `.gitignore` (+`.task-complete`/coverage/tsbuildinfo), `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/*`, `.github/workflows/ci.yml`, `docs/implementation/phases/phase-01-publication-checklist.md`, `README.md` (public description), `scripts/{secret-scan,large-file-scan,check-publication}.sh`.
- **S2**: `packages/contracts/schema/*.schema.json` (12), align `packages/contracts/src/index.ts`, `packages/contracts/src/validate.ts`, `*.test.ts`, `packages/contracts/fixtures/{valid,invalid}/*`, `packages/contracts/COMPATIBILITY.md`, drift-guard test, **align `templates/*.yaml` to authoritative schema** (P1-CHANGE-002).
- **S3**: `packages/policy/src/{risk,verification,approval,failure}.ts` + tests; extend `policies/*.yaml`; parity test YAML↔TS (P1-CHANGE-004); keep `gatePolicy` compatible.
- **S4**: `evals/{schema,runner}`, `evals/fixtures/**` (labelled synthetic), `evals/*.test.ts`; pinned locale/tz/seed/ordering (P1-OPT-002).
- **S5**: `packages/observability/src/metrics-dictionary.ts` (or `docs/platform/metrics-dictionary.yaml`), `packages/contracts/schema/{run-event,evidence-bundle}.schema.json`, evidence-bundle generator + test; metric operands validated against RunEvent catalog (P1-METRIC-002); privacy enum (P1-METRIC-003).
- **S6**: `START-HERE.md`, `docs/implementation/phases/phase-01-report.md`, `artifacts/phase-01/**`, traceability matrix (P1-OPT-001).

## 10. Contract / versioning strategy (P1-CHANGE-002, -003 accepted)

**JSON Schema is the single authoritative representation.** TS types and runtime validators are **generated from** the schema (or asserted against it by a regeneration-diff gate), so they cannot diverge silently. `$id` = `https://asep.dev/schema/<name>/v1`; semver `version` field; additive-only within a major (new optional = minor, breaking = new major `$id`). `COMPATIBILITY.md` + an **executable compatibility checker** with mutation fixtures (a breaking change must fail the checker). Templates validated against the schema in CI. No provider SDK types in domain contracts.

## 11. Test strategy

Unit (validators, taxonomy tables), contract tests (valid accepted, invalid **actually rejected** — assert non-swallowed), drift-guard/regeneration-diff, compatibility-mutation, eval-runner, risk-routing tables, verification-matrix, YAML↔TS parity. Narrowest-first, then full canonical verify command.

## 12. CI strategy (P1-CHANGE-009 accepted)

One **canonical verification command** (`pnpm verify` extended, mirrored by CI). `.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → format check → lint → typecheck → test → schema validation → fixture accept/reject → template validation → compatibility check → secret scan → large-file scan → license/publication check → **clean-tree assertion**. `*.tsbuildinfo` ignored. Fails red on any.

## 13. Security / publication gates (P1-CHANGE-005, -006 accepted)

Raw eval/evidence artifacts that could contain sensitive data go to an **ignored/external path**; only **sanitized manifests** are committed. Publication gate is executable and **self-tests** (seeded secret/path canary must be caught): secret scan, large-file scan, abs-path/PII scan, license present + dependency-license check + provenance/attribution, git-history secret scan. Documented license-approval record. Public push human-gated at end of session.

## 14. Measurement strategy

Machine-readable dictionary: product outcome, DORA, agent task performance, trajectory quality, review effectiveness, harness reliability, cost (incl. cost-per-accepted-task), human intervention, **false-completion rate**. Each metric: name/purpose/formula/num/denom/dimensions/source-events/owner/sampling/alert/privacy. Operands + source-event names validated against the RunEvent field catalog (P1-METRIC-002); privacy is a closed enum with capture/redaction/retention/access rules (P1-METRIC-003). Metrics are **defined contracts**, not empirically validated (no real runs) — report states this explicitly.

## 15. Eval strategy

Dataset schema + deterministic runner (pinned ordering/seed/locale/tz, default-deny network). Fixtures: contract validation, risk routing, verification-plan generation, skill routing, reviewer finding quality, malformed provider output, prompt injection, scope violation, false completion. ≤10 synthetic seeds, each `source: synthetic`. Deterministic grading proven by running the runner twice from clean checkout → identical output. Collecting 30–50 real historical tasks + one pilot repo = **blocking production-pilot dependency**, documented, not fabricated now.

## 16. Risks and mitigations

Schema/type drift → schema-authoritative + regeneration-diff (S2). False completion → sentinel FILE + independent codex review + false-completion eval + controller gate re-run. Fabricated eval data → synthetic label enforced by schema; historical collection deferred+documented. Phase 2 creep → out-of-scope list + codex final check. `git add -A` disaster → forbidden + selective staging + scans. Public leak → self-testing publication gate + human-gated push. Marker staleness → marker bound to HEAD/evidence, final acceptance only after review (P1-CHANGE-008).

## 17. Rollback strategy

Per-slice commits on throwaway branch off `main`; any slice revertable. `main` untouched until human merge. Worktree removable without touching `main`. Autosave/distress commits reset-soft before merge.

## 18. Evidence plan

`artifacts/phase-01/` holds per-gate records: command, exit code, duration, stdout/stderr (or checksum), tool version, env digest — raw before any reducer, **sanitized** for commit (raw kept in ignored path). Worker run dir `~/.openclaw/runs/<id>/` is corroborating.

## 19. Commit plan

Six slice commits (S1–S6, exact messages §8) + `fix(phase-1): address <finding-id> …` for repairs. No `git add -A`. Docs-lock commit on `main` at PROMPT 3.

## 20. Exit criteria

Machine-checkable list in `phase-01-exit-criteria.md`. Phase 1 completes **offline**; remote push/PR is a separate human-gated step, not an exit criterion.

## 21. Phase 2 inputs

Locked contracts+validators as the vertical-slice interface; risk/verification matrix → assurance ladder; failure taxonomy → classifier; measurement dictionary → telemetry; eval runner+fixtures → regression harness. Blocking dependency: 30–50 real historical tasks + one pilot repo.

## 22. Open questions

1. **Engine** (claude vs hermes): 9router UP → both usable. Confirmed with owner at spawn boundary.
2. **GitHub owner/repo name**: needed only at publish step; deferred.
