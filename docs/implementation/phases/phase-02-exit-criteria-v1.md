# Phase 2 — Exit Criteria (v1, DRAFT, machine-checkable)

> Phase 2 is COMPLETE only when every MUST passes from a clean checkout. Base `e046885`.
> `[ ]` unmet · `[x]` met with evidence in `artifacts/phase-02/`.
> Two verdicts: **COMPLETE** (all incl. 10 genuine pilot tasks) · **IMPLEMENTATION_COMPLETE_PILOT_PENDING** (all except real pilot).

## A. Baseline & build integrity (MUST)

- [ ] A1. Phase 1 full gate still passes: `pnpm verify:all` green from clean checkout.
- [ ] A2. `pnpm install --frozen-lockfile` clean.
- [ ] A3. No canonical Phase 1 schema compatibility regression (compat gate green; no WorkOrder break).
- [ ] A4. Working tree clean after full gate; no tracked build artifacts.

## B. Layering & Phase 3 compatibility (MUST)

- [ ] B1. `packages/application` exists; execution use case lives there, not in `workers/*`.
- [ ] B2. `apps/*` and `workers/*` are composition roots only (arch test).
- [ ] B3. Domain/application contain no provider SDK, Fastify, pg, Octokit, AWS, Docker imports (extended forbidden-imports fitness + mutation self-test).
- [ ] B4. The same application use case is callable from CLI/worker and would be callable from a Temporal activity (no worker-only coupling; demonstrated by a second thin caller in tests).

## C. Persistence & project isolation (MUST)

- [ ] C1. PostgreSQL state survives process restart (integration test).
- [ ] C2. Every repository query is scoped by organization + project; a cross-project (IDOR) read test fails closed.
- [ ] C3. Unique active writer/branch lease enforced; concurrent lease attempt fails.
- [ ] C4. State transitions explicit + optimistic-concurrency guarded (conflicting version update rejected).
- [ ] C5. Migrations append-only with checksums; forward migration on clean PG passes.
- [ ] C6. No provider token or private key stored in plaintext.

## D. Artifacts (MUST)

- [ ] D1. `artifact-placeholder` removed from all runtime code.
- [ ] D2. Artifacts content-addressed by SHA-256; key not user-supplied path.
- [ ] D3. Read verification detects byte mutation/corruption.
- [ ] D4. Identical bytes deduplicate; object-write failure does not create accepted metadata; metadata failure does not claim success.
- [ ] D5. Raw stdout/stderr stored before any summary/reducer.
- [ ] D6. Cross-project artifact read rejected.

## E. Workspace / Git (MUST)

- [ ] E1. Real temporary Git worktree isolation tested (not mocked).
- [ ] E2. Base SHA pinned and verified before agent runs.
- [ ] E3. Agent-created commit/ref rejected by harness inspection.
- [ ] E4. Agent receives no GitHub credential (env assertion test).
- [ ] E5. Harness owns the commit; ASEP-Run/Task/Attempt/Evidence trailers present.
- [ ] E6. Path/symlink traversal outside workspace root rejected (`realpath` containment).
- [ ] E7. Cleanup idempotent; failed worktree quarantined, not reused.

## F. Command runner & sandbox (MUST)

- [ ] F1. Verification commands are executable+argv with `shell:false`; no model-generated shell string.
- [ ] F2. Exact exit code/signal preserved (no swallowing 1→success).
- [ ] F3. Timeout kills the whole process group; cancellation via AbortSignal works.
- [ ] F4. `verification-no-network` profile has OS-enforced no network (canary test attempts and fails).
- [ ] F5. No Docker socket mounted; image pinned by digest; CPU/mem/PID limits + cap drop + no-new-privileges set.
- [ ] F6. If the environment cannot enforce isolation, the adapter is labelled pilot-only in code and report (no false "production sandbox" claim).

## G. Claude adapter (MUST)

- [ ] G1. Behind `CodingAgentProvider`; model + SDK/CLI version pinned.
- [ ] G2. Structured JSON/stream events parsed (no prose scraping); malformed/partial events fail closed.
- [ ] G3. Max turns, timeout, cancellation, explicit tool permission profile, sanitized env allowlist; no dangerous permission bypass.
- [ ] G4. Context-pack + work-order hashes recorded; provider events captured as artifacts.
- [ ] G5. Adapter cannot commit, push, self-approve, or hold a GitHub credential.
- [ ] G6. Fake-executable contract tests in CI (malformed JSON, partial stream, timeout, cancel, non-zero exit, quota error, permission denial, attempted commit/push). Live test opt-in, skips cleanly without credentials.

## H. Forge / GitHub App (MUST)

- [ ] H1. GitHub App used, not PAT; private key held by controller/credential provider, never in workspace/log/artifact.
- [ ] H2. Installation token scoped to the exact repository + minimum permissions; token treated as opaque (no length assumption).
- [ ] H3. Webhook HMAC signature verified; delivery IDs deduplicated (if webhooks implemented this phase).
- [ ] H4. Branch push only after verification; PR create/update idempotent.
- [ ] H5. No merge capability exists in Phase 2.
- [ ] H6. Adapter tested against mock HTTP / SDK transport boundary (not mocked application logic).

## I. Review state (MUST)

- [ ] I1. After verification + PR, task → `WAITING_FOR_HUMAN_REVIEW`.
- [ ] I2. Machine verification cannot transition directly to ACCEPTED when human review is required.
- [ ] I3. No second-model runtime reviewer implemented (Phase 4 scope); Codex confirms.

## J. Observability & audit (MUST)

- [ ] J1. Spans present: task.execute, context.build, workspace.lease, workspace.create, agent.invoke, command.execute, artifact.put, git.commit, forge.push, forge.pull_request.
- [ ] J2. Every span/event carries org/project/repository/run/task/attempt IDs.
- [ ] J3. Full source/prompt/raw tool output off by default (opt-in + redaction documented).
- [ ] J4. Privileged operations audited.

## K. Integration & pilot (MUST)

- [ ] K1. Full vertical integration test: real PG + real temp Git + real worktree + real artifact + real runner + fake Claude + fake GitHub — passes.
- [ ] K2. ≥1 opt-in live pilot task succeeds (real Claude + real GitHub App, one real PR, no merge) before claiming live integration.
- [ ] K3. Full traceability: PR → evidence → attempt → task → run → project → repository.
- [ ] K4. Ten genuine low-risk pilot tasks for `COMPLETE`; if unavailable → `IMPLEMENTATION_COMPLETE_PILOT_PENDING`, not `COMPLETE`.

## L. Completion protocol (MUST)

- [ ] L1. `phase-02-report.md` present; report head SHA == `git rev-parse HEAD`.
- [ ] L2. No unresolved CRITICAL/HIGH from Codex final review (or recorded disposition).
- [ ] L3. `.task-complete` created last, only after report + evidence + green gate + clean tree + honest verdict.
- [ ] L4. `IMPLEMENTATION_COMPLETE_PILOT_PENDING` may create `.phase-02-implementation-complete` but NOT the final phase sentinel.

## Not Phase 2 exit (carried to later phases)

- Temporal durability, distributed scheduling, second-model reviewer runtime, Web Console, memory systems, auto-merge, production deploy, K8s/gVisor, full enterprise OIDC.
