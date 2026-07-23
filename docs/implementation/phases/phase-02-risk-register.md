# Phase 2 — Risk Register (LOCKED)

> Delivery and design risks for the single-agent vertical slice. Base `e046885`. Severity = Impact × Likelihood.
> Locked after Codex plan review (`phase-02-review-log.md`). New rows PR2-17..PR2-22 capture the accepted CRITICAL/HIGH security findings.

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
| PR2-10 | Docker/PG/MinIO unavailable → required suites silently skip and CI passes green (disp. P2-PLAN-HIGH-009) | HIGH | A **mandatory Phase 2 integration gate** in `verify-all` + CI provisions digest-pinned PostgreSQL, object storage and the verification sandbox, waits for health, and **fails (not skips)** if absent. Machine-readable suite IDs registered for tenancy/migration/artifact/git/sandbox suites. Only live Claude/GitHub tests stay opt-in. | CI config test asserts each suite marker enforced; deliberately-unavailable backend makes the required job red |
| PR2-11 | Long agent job inside HTTP request | MED | Control Plane only registers/validates/queries; execution runs in CLI/worker process | Arch test: no provider invoke in route handler |
| PR2-12 | Git operations in route handlers | MED | Git only in `git-worktree` adapter, invoked by application use case from worker/CLI | Arch/forbidden-import test |
| PR2-13 | Migration applied then edited (checksum drift) | MED | Append-only migrations + checksums; clean-DB forward test | Migration test on fresh PG |
| PR2-14 | Transaction split across pool clients | MED | Single checked-out client per transaction (node-postgres pooling rule) | Transaction helper enforces; concurrency test |
| PR2-15 | Live Claude/GitHub cost or flakiness in CI | LOW | Live tests opt-in via env flag; default suite uses fakes; live pilot human-authorized | CI runs fakes only |
| PR2-16 | Repair loop churn from Codex review | LOW | Max two normal repair cycles before adjudication; findings need reproduce+regression test | Cycle counter in report |
| PR2-17 | Harness pushes to default/protected branch, bypassing PR-only boundary (disp. P2-PLAN-CRIT-001) | CRITICAL | Non-bypassable `RefSafetyPolicy` in forge adapter: ASEP-owned branch namespace, reject default/protected/tag refs, `git check-ref-format`, exact create/update refspec only, no delete/force (force-with-lease vs recorded SHA), pilot ruleset denies default-branch writes + App merges | Bare-remote tests reject main/master/HEAD/tag/deletion/malformed/force; transport test proves only namespaced ref sent |
| PR2-18 | Cross-project IDOR via duplicated scope columns with single-column FKs (disp. P2-PLAN-HIGH-003) | HIGH | Server-derived `TenantScope`/`AuthContext` required by every use case + repository method; composite FKs enforce org/project/parent consistency at the DB boundary | Migration tests attempt every mismatched org/project/parent combo and fail at DB; app-level IDOR read/write rejected |
| PR2-19 | Crash between external side effect and DB record → duplicate commit/push/PR on replay (disp. P2-PLAN-HIGH-005) | HIGH | Crash-safe side-effect protocol: tenant-scoped semantic keys, request fingerprint, PENDING/COMPLETED/FAILED state, fencing, remote reconciliation by natural key | Fault-injection kills executor before/after each Git/object/GitHub call and DB write; restart converges to one commit/ref/PR |
| PR2-20 | Untrusted agent writes `.git`/mirror metadata (containment vs detection) (disp. P2-PLAN-HIGH-006) | HIGH | Agent runs in a separate sandboxed process (never in-harness); `.git` indirection, mirror, refs, objects, config, hooks mounted read-only or omitted; trusted `GitChangeInspector` exposes safe observations | OS-level sandbox tests fail all `.git`/mirror writes; host snapshot byte-identical after corruption attempt, via real Claude adapter |
| PR2-21 | Malicious `remote_url`/repo config → file/ext/ssh/SSRF/cred-leak without a shell (disp. P2-PLAN-HIGH-007) | HIGH | Build clone/fetch URLs from validated forge identity; allow only configured GitHub HTTPS host, reject userinfo/non-HTTPS/local/ext/ssh, terminate option parsing, sanitize `GIT_CONFIG*`/SSH/askpass/proxy env, disable unapproved protocols/hooks, fail-closed submodule policy | Real Git tests reject `file://`/`ext::`/ssh/local/userinfo/newline-option-injection/malicious insteadOf/hostile submodule |
| PR2-22 | Higher-risk task pushed while Phase-1-mandated assurance (R1 reviewer, R2+ L8) cannot be satisfied (disp. P2-PLAN-HIGH-001) | HIGH | Explicit Phase 2 **risk-admission matrix**: fail closed before agent invocation for any risk whose mandatory gates can't be met; automated pilot ≤ R0, R1 needs recorded human independent-review, R2–R4 deferred (no silent policy weakening) | Table-driven R0–R4 tests stop unsupported risk before workspace/agent/push; policy parity tests unchanged |

## Blocking dependencies carried from Phase 1

- **PP1/PP2**: real pilot repository + genuine tasks. Without these, Phase 2 can reach `IMPLEMENTATION_COMPLETE_PILOT_PENDING` but not `COMPLETE`. This is the single most likely reason Phase 2 stops short of full completion.

## Rollback

Per-slice commits on `phase/02-single-agent-vertical-slice`; `main` untouched until human merge. Any slice revertable. No production side effects, so rollback is purely git-level.
