# Phase 1 — Evaluation and Contracts Foundation — Plan v1

> Status: DRAFT (v1) — awaiting independent Codex review before lock.
> Planner: Claude Opus 4.8 (controller session).
> Mode: planning + docs only. No source code changed by this document.

```text
BASE_SHA: 83ba33db16072f05fb27f00f34cebd6774cb771a   (main — "chore: import ASEP reference starter baseline")
```

---

## 0. Execution model (how this phase is actually run)

This phase is executed with the on-machine `long-task-stack` system, not a simulated 6-agent pipeline.

- **Planner (this doc, PROMPT 1)** — controller Claude session (Opus 4.8), read + plan only.
- **Plan reviewer (PROMPT 2)** — `codex` CLI, fresh read-only session.
- **Plan lock (PROMPT 3)** — controller session, produces canonical locked docs + one docs commit on `main`.
- **Implementer (PROMPT 4)** — a detached Claude Code worker spawned via `stack spawn --engine claude` into an isolated git worktree on branch `phase/01-evaluation-contracts`. One writer per worktree. Commits per slice. Touches `.task-complete` only when genuinely done.
- **Final reviewer (PROMPT 5)** — `codex` CLI, fresh read-only session, verifies against repo + evidence, not transcripts.
- **Dispatcher (PROMPT 6)** — controller session monitors sentinel + commit progress, resumes on interruption, never trusts self-report.

Constraints from the handoff that are load-bearing here:
- `--engine claude` uses Claude Code's own auth, independent of 9router (which is currently **down** at `:20128`). `--engine hermes` is therefore **not usable** this session.
- COMPLETE is asserted only by the sentinel FILE `.task-complete` + exit 0, never by log grep.
- `git add -A` is forbidden; stage selectively after `git status` + size/secret scan.
- Public-repo creation is deferred to end of session, human-gated.

---

## 1. Current-state audit

Verified by reading the tree and running the baseline gates on `main` @ `83ba33d`:

- Node 24.6.0, pnpm 10.31.0, TypeScript 7.0.2, `tsx` test runner. `pnpm install` clean; `pnpm typecheck` passes; `pnpm test` = **4/4 pass** (`packages/domain`, `packages/policy`, `workers/workflow-worker`). No pre-existing failures. No `node_modules`/`dist` in tree.
- Workspace: `apps/control-plane-api`, `workers/workflow-worker`, `packages/{contracts,domain,policy,ports,observability}`, `adapters/{agent-mock,memory-inmemory}`.
- Docs complete: `START-HERE.md`, `README.md`, `VALIDATION.md`, 5 architecture docs, 15 ADRs (`0001`–`0015`), platform docs (verification-and-review, measurement-and-evaluation, skill-system, context-and-memory, agent-coordination, model-routing, framework-support-matrix, technology-radar, experimental-tools), `docs/implementation/{90-day-plan,backlog,definition-of-done,cost-model,team-and-ownership}`.
- Policy: `packages/policy/src/index.ts` has `gatePolicy(R0..R4)` + `canUseExperimentalOutputReducer`, table-driven-ish tests. `policies/{risk-policy,tool-policy,output-reducer-policy}.yaml` exist.
- Templates (YAML) exist for product-spec, work-order, context-pack, evidence-bundle, review-report, skill-manifest, adr, incident-report.
- Evals: only `evals/examples/skill-routing.yaml` (single example, no runner, no negative cases).
- Repo meta: `LICENSE-POLICY.md` (Apache-2.0 chosen by owner, but **no LICENSE file yet**), `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `MANIFEST.sha256`, `VERSION`, `.gitignore` (covers node_modules/dist/.env/.workspaces/.artifacts), CI scripts `scripts/{bootstrap,verify}.sh`.

## 2. What the starter already has

Versioned TS domain types (`packages/contracts`), a deterministic R0–R4 gate policy with tests, risk/tool/output-reducer policy YAML, contract templates, one eval example, complete architecture/ADR/platform documentation, a passing local kernel, and repo governance files (SECURITY/CONTRIBUTING/gitignore).

## 3. What the starter is missing (Phase 1 scope)

- **JSON Schema** for the 12 canonical contracts (only TS types exist → silent drift risk). Missing types entirely at contract level: AcceptanceScenario, ArchitectureInvariant, Finding, VerificationPlan, RunEvent, SkillManifest (some exist only as templates or nested TS).
- Schema `$id` + semver + forward/backward compatibility policy + valid/invalid fixtures + runtime validators + contract tests + a **schema↔type drift guard**.
- **Full risk taxonomy**: 13 change categories → risk mapping, mandatory verification matrix, approval matrix (current `gatePolicy` is a fragment).
- **Failure taxonomy** (17 classes) as data + classifier + tests.
- **Measurement dictionary** machine-readable (name, purpose, formula, num/denom, dimensions, source events, owner, sampling, alert relevance, privacy class) — docs describe families but not a dictionary.
- **Evaluation runner** + labelled synthetic fixtures incl. negative cases (prompt-injection, scope-violation, false-completion).
- `docs/implementation/phases/` (created) and `artifacts/phase-01/` (missing).
- GitHub meta: `LICENSE` (Apache-2.0), CODEOWNERS, PR/issue templates, `.github/workflows` CI, publication checklist.

## 4. What must be fixed before public

- Add `LICENSE` (Apache-2.0) + confirm no upstream-licensed code copied wholesale.
- `.gitignore` complete (already covers the dangerous dirs; add `.task-complete`, coverage, tmp).
- Secret scan (gitleaks-style grep) — currently only `.env.example` with dev placeholders; must stay clean.
- Large-file scan (>500KB) — none currently.
- Local absolute path / username / email / machine-specific data scan.
- CI that fails red on typecheck/test/schema/fixtures/secret/large-file/license.
- No public push until secret + license gates pass.

## 5. Phase 1 scope

Deliverables A–G from the prompt pack: repo public-readiness, canonical versioned contracts (schema+types+validators+fixtures+tests), risk/verification/approval/failure taxonomy with tests, deterministic eval dataset+runner incl. negatives, machine-readable measurement dictionary + evidence bundle generation, and phase artifact docs. Exit criterion (per 90-day plan): *historical tasks can be represented and graded deterministically* — with the honest caveat that historical tasks are collected later (synthetic seeds now).

## 6. Explicit out-of-scope (defer to Phase 2+)

Temporal runtime/activities; real Claude/Codex/OpenHands/ADK providers; Mem0/Graphiti/RTK/Caveman; Web Console/UI; GitHub/forge integration beyond repo meta; worktree/sandbox manager as a service; DB/PostgreSQL projections; auto-merge; any production side effect; model calls inside deterministic risk rules.

## 7. Task DAG (acyclic)

```text
S1 repo-readiness ──┐
                    ├─> S6 integration+docs ─> codex-final-review ─> (gated) publish
S2 contracts ───────┤
S3 risk/failure ────┤   (S3 depends on S2 for RiskLevel/types)
S4 evals ───────────┤   (S4 depends on S2 contracts + S3 taxonomy)
S5 measurement ─────┘   (S5 depends on S2 EvidenceBundle/RunEvent)
```
S1 independent. S2 before S3/S4/S5. S6 after S2–S5. No cycles.

## 8. Slice decomposition

- **S1 Repo public-readiness** → commit `chore(repo): harden repository for public development`
- **S2 Canonical contract schemas** → `feat(contracts): establish versioned canonical platform schemas`
- **S3 Risk/verification/failure taxonomy** → `feat(policy): add risk assurance and failure classification foundation`
- **S4 Evaluation foundation** → `feat(evals): add deterministic phase-one evaluation foundation`
- **S5 Measurement + evidence** → `feat(measurement): define evidence and platform metric contracts`
- **S6 Integration + docs** → `docs(phase-1): record evidence and close evaluation-contracts foundation`

Each slice: read exit criteria → test-first where sensible → smallest change → run slice gate → review diff → commit → write evidence.

## 9. File-level change map

- S1: `LICENSE` (new), `.gitignore` (+`.task-complete`/coverage), `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/*`, `.github/workflows/ci.yml`, `docs/implementation/phases/phase-01-publication-checklist.md`, `README.md` (public description), `scripts/{secret-scan,large-file-scan,check-publication}.sh`.
- S2: `packages/contracts/schema/*.schema.json` (12), `packages/contracts/src/index.ts` (align types), `packages/contracts/src/validate.ts` (ajv or hand runtime), `packages/contracts/src/*.test.ts`, `packages/contracts/fixtures/{valid,invalid}/*`, `packages/contracts/COMPATIBILITY.md`, drift-guard test.
- S3: `packages/policy/src/{risk,verification,approval,failure}.ts` + tests; extend `policies/*.yaml`; keep `gatePolicy` compatible.
- S4: `evals/{schema,runner}`, `evals/fixtures/**` (labelled synthetic), `evals/*.test.ts`.
- S5: `packages/observability/src/metrics-dictionary.ts` (or `docs/platform/metrics-dictionary.yaml`), `packages/contracts/schema/{run-event,evidence-bundle}.schema.json`, evidence-bundle generator + test.
- S6: `START-HERE.md`, `docs/implementation/phases/phase-01-report.md`, `artifacts/phase-01/**`.

## 10. Contract / versioning strategy

Each schema: `$id` = `https://asep.dev/schema/<name>/v1`, `version` semver field, additive-only within a major (new optional fields = minor, breaking = new major `$id`). Drift guard: a test that derives/asserts TS ⇄ JSON Schema parity (generate types from schema, or assert a checked-in mapping) so they cannot diverge silently. No provider SDK types in domain contracts.

## 11. Test strategy

Unit (validators, taxonomy tables), contract tests (valid fixtures accepted, invalid rejected — assert rejection is real, not swallowed), drift-guard, eval-runner tests, risk-routing table tests, verification-matrix tests. Narrowest-first, then full `pnpm verify`.

## 12. CI strategy

`.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → format check → typecheck → test → schema validation → fixture accept/reject → secret scan → large-file scan → license check. Fails red on any. Mirrors local gates so CI and evidence match.

## 13. Security / publication gates

Secret scan, large-file scan, absolute-path/PII scan, license present, `.env` never staged, no `node_modules`/artifacts. Publication checklist must be green before any public push. Public push is human-gated at end of session.

## 14. Measurement strategy

Machine-readable dictionary covering product outcome, DORA, agent task performance, trajectory quality, review effectiveness, harness reliability, cost (incl. cost-per-accepted-task), human intervention, and **false-completion rate**. Each metric: name/purpose/formula/num/denom/dimensions/source-events/owner/sampling/alert/privacy. Metrics are *defined contracts* in Phase 1, not empirically validated (no real runs yet) — report must say so.

## 15. Eval strategy

Dataset schema + deterministic runner. Fixtures for contract validation, risk routing, verification-plan generation, skill routing, reviewer finding quality, malformed provider output, prompt injection, scope violation, false completion. ≤10 synthetic seeds, each explicitly `source: synthetic`. Collecting 30–50 real historical tasks recorded as an **exit dependency before production pilot**, not fabricated now.

## 16. Risks and mitigations

- *Schema/type drift* → drift-guard test (S2).
- *False completion by worker* → sentinel FILE + independent codex review + explicit false-completion eval + gate re-run by controller.
- *Fabricated eval data* → synthetic label enforced by schema; historical-task collection deferred and documented.
- *Accidental Phase 2 creep* → out-of-scope list; codex final review checks for it.
- *9router down* → use `--engine claude` (independent auth).
- *`git add -A` disaster* → forbidden; selective staging + scans (already burned once per handoff).
- *Public leak* → publication gate, human-gated push.

## 17. Rollback strategy

Per-slice commits on a throwaway branch off `main`; any slice revertable via `git revert`/branch reset. `main` untouched until human merge. Worktree removable without touching `main`. Autosave/distress commits (if any) reset-soft before merge (handoff §5.2).

## 18. Evidence plan

`artifacts/phase-01/` holds per-gate command records: command, exit code, duration, stdout/stderr (or checksum), tool version, env digest. Raw output stored before any reducer. Worker run dir under `~/.openclaw/runs/<id>/` (run.meta, trace.log, worker.log/err, worker.exit, status) is corroborating evidence.

## 19. Commit plan

Six slice commits (S1–S6) with the exact messages in §8, plus `fix(phase-1): address <finding-id> …` for any repair. No `git add -A`. Docs-lock commit `docs(phase-1): approve evaluation and contracts implementation plan` on `main` at PROMPT 3.

## 20. Exit criteria (machine-checkable — full list in phase-01-exit-criteria.md)

Clean-checkout bootstrap passes; full gates pass; 12 schemas have `$id`+version+valid/invalid fixtures with real rejection; drift-guard passes; risk routing + verification matrix tests pass; eval runner runs all fixtures incl. negatives; measurement dictionary machine-readable with formulas+source events+privacy; evidence bundle generated; no secret/large-file/artifact in tree; LICENSE present; branch + (gated) PR exist; report has base/head SHA; tree clean; `.task-complete` last.

## 21. Proposed Phase 2 inputs

Locked contracts + validators as the interface for the single-agent vertical slice; risk/verification matrix to drive the assurance ladder; failure taxonomy for the classifier; measurement dictionary for telemetry wiring; eval runner + synthetic fixtures as the regression harness; exit dependency: collect 30–50 real historical tasks + one pilot repo.

## 22. Open questions (only genuinely blocking)

1. **Engine**: 9router is down → `--engine hermes` unavailable. Plan assumes `--engine claude`. Blocking only if owner requires hermes (then bring 9router up first). *Non-blocking default chosen: claude.*
2. **GitHub owner/repo name** for the eventual public repo — needed only at end-of-session publish step, not before. Deferred.

Everything else resolved with safe defaults (Apache-2.0 confirmed; public repo end-of-session confirmed; codex CLI reviewer confirmed).

---

```text
PLAN_STATUS: READY_FOR_CODEX_REVIEW
PLAN_FILE: docs/implementation/phases/phase-01-plan-v1.md
BASE_SHA: 83ba33db16072f05fb27f00f34cebd6774cb771a
FILES_READ: START-HERE.md, README.md, VALIDATION.md, LICENSE-POLICY.md, docs/architecture/01..04, docs/platform/{verification-and-review,measurement-and-evaluation,skill-system,context-and-memory}.md, docs/implementation/{90-day-plan,definition-of-done}.md, packages/contracts/src/index.ts, packages/policy/src/index.ts, policies/risk-policy.yaml, scripts/{bootstrap,verify}.sh, package.json, .gitignore, .env.example, ~/long-task-stack/{long-task-system-handoff.md,task-template.md}, ~/.openclaw/bin/spawn-coder.sh, ~/.local/bin/stack
CRITICAL_GAPS: no JSON Schema (drift risk), no full risk/failure taxonomy, no eval runner, no machine-readable measurement dictionary, no phase artifacts
PUBLICATION_BLOCKERS: LICENSE file missing; CI/publication gates not yet present (both scheduled in S1)
OPEN_QUESTIONS: engine=claude (9router down); GitHub owner/repo name (deferred to publish step)
```
