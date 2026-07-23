# Phase 2 — Risk Register (v1, DRAFT)

> Delivery and design risks for the single-agent vertical slice. Base `e046885`. Severity = Impact × Likelihood.

| ID | Risk | Sev | Mitigation | Trigger / owner action |
|----|------|-----|-----------|------------------------|
| PR2-01 | Application logic left inside worker (Phase 3 must copy it) | HIGH | Slice 1 extracts `packages/application`; arch test forbids business logic in `workers/*`/`apps/*` | Fitness test fails if use case imports from worker |
| PR2-02 | Provider SDK type leaks into domain/application/DB record | HIGH | `forbidden-imports` fitness extended: Claude/AWS/pg/Octokit/Fastify only in their adapter packages | CI red on leak; mutation self-test |
| PR2-03 | Breaking canonical WorkOrder to add infra IDs | HIGH | Add separate versioned `ExecutionEnvelope`; WorkOrder untouched; compat gate still guards schema | Any WorkOrder schema edit triggers compat gate |
| PR2-04 | Fake durability (in-memory state called "persistent") | HIGH | PostgreSQL authoritative; restart test proves state survives; no in-memory authoritative store | Restart integration test |
| PR2-05 | "End-to-end" test that is fully mocked | MED | Full integration uses real PG + real Git + real artifact + real runner; only Claude/GitHub faked at process/transport boundary | Review: fake-provider only at edges |
| PR2-06 | Sandbox isolation described but not enforced | HIGH | No-network canary must actually fail network; if env can't enforce, mark pilot-only, don't claim secure | Canary test; honesty check in report |
| PR2-07 | Scheduler / Temporal scope creep | MED | Explicit out-of-scope list; CLI/worker executes one task; Codex final review confirms no Phase 3 impl | Review gate |
| PR2-08 | Ten-task pilot faked with synthetic fixtures | HIGH | `COMPLETE` requires 10 genuine tasks; else `IMPLEMENTATION_COMPLETE_PILOT_PENDING` | Report verdict honesty; pilot evidence trace |
| PR2-09 | Dependency supply-chain (new deps) | MED | Pin exact versions from research register; license-inventory gate (Phase 1) covers transitive; compat test per provider | `pnpm install --frozen-lockfile`; license gate |
| PR2-10 | Docker unavailable in dev/CI environment | MED | `SandboxProvider` port stable; filesystem/no-docker path for unit tests; Docker adapter integration opt-in and skipped cleanly | Skip-clean test when Docker absent |
| PR2-11 | Long agent job inside HTTP request | MED | Control Plane only registers/validates/queries; execution runs in CLI/worker process | Arch test: no provider invoke in route handler |
| PR2-12 | Git operations in route handlers | MED | Git only in `git-worktree` adapter, invoked by application use case from worker/CLI | Arch/forbidden-import test |
| PR2-13 | Migration applied then edited (checksum drift) | MED | Append-only migrations + checksums; clean-DB forward test | Migration test on fresh PG |
| PR2-14 | Transaction split across pool clients | MED | Single checked-out client per transaction (node-postgres pooling rule) | Transaction helper enforces; concurrency test |
| PR2-15 | Live Claude/GitHub cost or flakiness in CI | LOW | Live tests opt-in via env flag; default suite uses fakes; live pilot human-authorized | CI runs fakes only |
| PR2-16 | Repair loop churn from Codex review | LOW | Max two normal repair cycles before adjudication; findings need reproduce+regression test | Cycle counter in report |

## Blocking dependencies carried from Phase 1

- **PP1/PP2**: real pilot repository + genuine tasks. Without these, Phase 2 can reach `IMPLEMENTATION_COMPLETE_PILOT_PENDING` but not `COMPLETE`. This is the single most likely reason Phase 2 stops short of full completion.

## Rollback

Per-slice commits on `phase/02-single-agent-vertical-slice`; `main` untouched until human merge. Any slice revertable. No production side effects, so rollback is purely git-level.
