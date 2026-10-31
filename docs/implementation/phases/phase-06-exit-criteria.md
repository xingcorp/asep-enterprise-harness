# Phase 6 — Exit Criteria (DRAFT v1, machine-checkable)

> Phase 6 reaches a verdict only from a clean checkout. Base `f613c7f`; the lane branches are rebased onto a Phase 3
> head carrying S1 before implementation (`phase-06-plan.md` §16, G-BASE).
> `[ ]` unmet · `[x]` met with evidence in `artifacts/phase-06/` or a committed report. Every row below is `[ ]`: this
> is a plan, nothing is implemented.
> Two kinds of exit evidence are kept apart (`phase-06-plan.md` §4): **code MUSTs** (A–I, proven by tests and gates)
> and **operating evidence** (OP1–OP6, proven only by a running pilot). Neither substitutes for the other.

## Verdicts

| Verdict | Condition |
|---|---|
| `COMPLETE` | every code MUST and every OP item |
| `IMPLEMENTATION_COMPLETE_OPERATING_EVIDENCE_PENDING` | every code MUST; the verdict names each OP id still pending |
| `INCOMPLETE` | any code MUST unmet; the verdict names them |

Each verdict carries `_UNREVIEWED` until the controller's independent final review accepts it. No verdict and no report
sentence says "production-ready". A MUST whose proof depends on another phase's slice (Gate column of plan §17) stays
`[ ]` until that slice is on the base; it is never met by a stub.

## How MUSTs map to tests

Proof kinds, as in Phases 3 and 4:

- `unit` — a `*.test.ts` file registered in `REQUIRED_SUITES` and run by `pnpm verify:all`;
- `itest` — a `*.itest.ts` file registered in `REQUIRED_ITEST_SUITES`, run by `pnpm test:integration` against real
  digest-pinned PostgreSQL, MinIO, Docker, Temporal (from G-P3S8) and Grafana (from G-P4S18);
- `gate` — a step of `scripts/verify-all.sh` or the integration gate;
- `review` — judged by the controller's independent review (kept to the completion protocol).

Gate adequacy, three layers:

1. `packages/application/src/hardening/exit-criteria-coverage.test.ts` parses the tables below and fails if a
   `unit`/`itest` row names a file that does not exist, is not registered under the stated suite id, or does not print
   `SUITE-ID: <id>`.
2. The named tests must appear as passed in the JUnit proof manifest of their runner (Lane B's post-run proof check,
   SR-T3, extended with Phase 6's rows by CR-B4). A missing, skipped, todo or failed mapped test fails the gate.
3. Mutation proofs for the rows marked †: `packages/application/src/hardening/mutation-proofs.json` holds one seeded
   mutation of the guarding code per row; the suite applies each in a temporary copy of the tree and requires the
   mapped test to fail, with an unmutated control run passing.

Test names are planned names: stable behaviour descriptions, no phase numbers or finding codes.

## A. Build integrity, contracts and migrations

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| A1 | `pnpm install --frozen-lockfile` then `pnpm verify:all` green from a clean checkout through `gate.sh`; exit code, test count, required-suite count, sampler line and exact HEAD recorded | gate | `scripts/verify-all.sh` | — |
| A2 | `pnpm test:integration` green, including every new required itest suite below | gate | `scripts/integration/run-integration.mjs` | — |
| A3 | `harness-release/v1`, `brownfield-baseline/v1`, `readiness-report/v1`, `autonomy-map/v1` exist with valid and invalid fixtures and frozen snapshots; the validator knows each name; every pre-existing schema and snapshot is byte-identical to the base except `task-workflow-input` 1.1.0 (Lane A, MINOR); the release id is `hr-` + 16 hex of the canonical manifest hash | unit | `packages/contracts/src/hardening-contracts.test.ts` › "hardening contracts accept their valid fixtures and reject their invalid ones", "a harness release id is derived from its canonical bytes"; `compat-gate.test.ts` (existing loops) | `asep-suite:hardening-contracts`, `asep-suite:compat-gate` |
| A4 | Migrations `0400`–`0499` apply on a fresh database and on a database at the newest earlier migration; re-apply is a no-op; an edited migration is refused by checksum; the landing orders of plan §16 (`0430` before `0400`; `0490` last) converge to the same catalog | itest | `adapters/persistence/src/tenancy/tenancy.itest.ts` › "every hardening migration applies, re-applies and converges in each landing order" | `asep-suite:tenancy-real` |

## B. Brownfield onboarding

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| B1 | A fixture repository with a passing, a failing, an alternating and a hanging command is baselined K = 3 times at a pinned SHA, each run in a fresh leased worktree and the no-network sandbox; the four commands classify `stable-pass`, `known-failing`, `flaky`, `infrastructure-error`; a re-run with the same inputs adopts the recorded baseline; nothing is pushed. Registry materialization (S4) runs through the durable `onboardingWorkflow` | unit + itest | `packages/application/src/brownfield/classify.test.ts` › "classification is a pure function of the recorded runs"; `apps/control-plane-api/src/brownfield/onboarding.itest.ts` › "a pinned commit is baselined and classified on real backends", "onboarding with registry materialization runs as a durable workflow" | `asep-suite:baseline-classification`, `asep-suite:onboarding-real` |
| B2 † | For a task at the baseline's SHA, every mandatory level of its risk is planned from `stable-pass` commands only; `known-failing` and `flaky` commands run as labelled advisory checks; a mandatory level without a `stable-pass` command refuses with `baseline-insufficient`; another SHA refuses with `baseline-stale`; no path makes a mandatory level advisory | unit | `packages/application/src/brownfield/plan.test.ts` › "only stable-pass commands gate", "a mandatory level is refused, never downgraded", "a task at another commit is refused as stale" | `asep-suite:baseline-plan` |
| B3 | A characterization task (tests-only scope) on an L0 module is admitted with publication approval, repeats the module's test command K times, and ends `WAITING_FOR_HUMAN_REVIEW` on real Temporal with the agent double; the same task whose agent also edits a production file outside `allowedPaths` ends FAILED with `scopeViolation` before verification (needs CR-X1) | itest | `apps/control-plane-api/src/brownfield/brownfield-e2e.itest.ts` › "a characterization task reaches human review", "an edit outside the allowed paths fails before verification" | `asep-suite:brownfield-e2e-real` |
| B4 | A fixture repository holding a seeded canary credential stops at `SCAN_BLOCKED`: no command runs, no baseline, no index, and submission refuses `onboarding-incomplete`; finding rows and audit rows never contain the canary text; a named human's acknowledgement resumes the run; the TypeScript pattern loader matches `scripts/lib/secret-patterns.sh` exactly | unit + itest | `packages/application/src/brownfield/secret-scan.test.ts` › "the loaded pattern set equals the shared pattern file", "a finding records location and pattern, never the text"; `onboarding.itest.ts` › "a committed credential stops onboarding until a human acknowledges it" | `asep-suite:onboarding-secret-scan`, `asep-suite:onboarding-real` |

## C. Readiness score and autonomy

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| C1 | The scorer is a pure function of (evidence, policy): golden reports are byte-identical across runs; every check cites an artifact or a named attestation; a check without evidence and an expired attestation score `not-evidenced` = 0; measured and attested points are reported apart; the recommendation never exceeds L2 and says why | unit | `packages/application/src/brownfield/score.test.ts` › "golden readiness reports are reproduced byte for byte", "unevidenced and expired checks score zero", "the recommendation is capped at the harness ceiling"; `packages/policy/src/readiness-scoring.test.ts` › "weights sum to ten and every check is cited" | `asep-suite:readiness-score`, `asep-suite:readiness-policy` |
| C2 † | A task's level is the lowest level among the modules its `allowedPaths` touch (unmapped path L0; empty list touches every module); L0 refuses non-tests-only scope with `module-read-only`; L1 sets publication approval; the composer keeps the most restrictive verdict and never removes a mandatory check; a refused task starts no workflow, gets 409 and an audit row; a second `decide` for the same task returns the recorded decision | unit + itest | `packages/application/src/hardening/submission.test.ts` › "the most restrictive verdict wins and checks are never weakened"; `packages/application/src/brownfield/admission.test.ts` › "the lowest touched module decides the level"; `brownfield-e2e.itest.ts` › "a refused submission starts no workflow" | `asep-suite:submission-policy`, `asep-suite:autonomy-admission`, `asep-suite:brownfield-e2e-real` |
| C3 † | A promotion needs a human principal with `autonomy:decide` and a readiness report (use case, database check and a test that no harness-class code path writes one); an attributed false completion, policy violation or scope violation demotes the module to L0 automatically, cancels its open tasks through `WorkflowEngine.cancel`, and is audited | unit + itest | `admission.test.ts` › "no code path promotes without a human decision"; `brownfield-persistence.test.ts` › "the database refuses a promotion without a human and a report"; `brownfield-e2e.itest.ts` › "a false completion demotes the module and cancels its open tasks" | `asep-suite:autonomy-admission`, `asep-suite:brownfield-persistence`, `asep-suite:brownfield-e2e-real` |

## D. Network and credential policies

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| D1 | `policies/network-policy.yaml` equals what `buildSandboxRunFlags`, `buildAgentRunArgs`, `buildProxyRunArgs` and the egress proxy constants do, in both directions; an overlay may only narrow a profile; a widening is refused at load | unit | `packages/policy/src/network-policy.test.ts` › "declared profiles match the sandbox builders in both directions", "a project overlay can only narrow a profile" | `asep-suite:network-policy` |
| D2 | On the real Docker daemon the registry proxy allows `CONNECT` to an allowlisted host on 443 and refuses an IP literal, another port, plain HTTP, absolute-form requests, other hosts and an allowlisted name resolving to a loopback, link-local, private or metadata address; the fetch container has no other route; install scripts stay off; a repository `.npmrc` with a key outside the allowlist fails the step closed; the egress log holds host, port, decision and bytes only | unit + itest | `adapters/network-policy/src/registry-proxy.test.ts` › "the proxy admits only allowlisted CONNECT targets"; `adapters/network-policy/src/registry-profile.itest.ts` › "the fetch container reaches only allowlisted registries" | `asep-suite:registry-proxy`, `asep-suite:registry-profile-real` |
| D3 † | `policies/credential-policy.yaml` matches `MINIMUM_PERMISSIONS` and the proxy lifetime constants; a canary value per credential class is found zero times in stored artifact bytes, audit rows, run events, exported workflow histories, gate logs and the argv and environment of every untrusted container; an engaged kill switch makes the model-credential and forge decorators refuse, stops new installation-token mints and reaps in-scope egress proxies by label | unit + itest | `packages/policy/src/credential-policy.test.ts` › "declared credential classes match the code"; `packages/application/src/credentials/kill-switch.test.ts` › "an engaged switch refuses every use in scope"; `apps/control-plane-api/src/security/credential-leak.itest.ts` › "no canary credential reaches any stored or logged surface", "a kill switch reaps the proxies in scope" | `asep-suite:credential-policy`, `asep-suite:kill-switch`, `asep-suite:credential-leak-real` |

## E. Tenant boundaries and retention

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| E1 | On real PostgreSQL the runtime role owns no table, cannot run DDL, cannot `UPDATE`/`DELETE` append-only tables, cannot `TRUNCATE` or disable triggers; no application role has `SUPERUSER` or `BYPASSRLS`; a production root without a migrator URL fails at startup | itest + unit | `tenancy.itest.ts` › "the runtime role cannot change schema or append-only history"; `apps/control-plane-api/src/hardening-root.test.ts` › "production mode refuses to start without a migrator URL" | `asep-suite:tenancy-real`, `asep-suite:hardening-root` |
| E2 | Every table with `organization_id` (Phases 2–6, including Phase 5's two tables) has row security enabled and forced and a policy for each role, checked against the catalog in both directions; a reader login role for organization A sees zero rows of organization B in every table and view | itest | `tenancy.itest.ts` › "every tenant table forces row security", "a tenant reader sees only its own organization" | `asep-suite:tenancy-real` |
| E3 † | A dry-run sweep is deterministic; an executed sweep needs a human approval naming that dry run; a held, non-terminal or under-review artifact is never purged; the tombstone is written before bytes are deleted; a read of a purged artifact raises `ArtifactPurgedError`; the artifact row and every earlier FK stay valid; on PostgreSQL with MinIO and with the filesystem store | unit + itest | `packages/application/src/retention/sweep.test.ts` › "held and active artifacts are never eligible"; `adapters/persistence/src/retention/retention.itest.ts` › "an approved sweep tombstones then deletes bytes on each store" | `asep-suite:retention-sweep`, `asep-suite:retention-real` |

## F. Canary harness releases and rollback

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| F1 | A manifest registers once per canonical hash; a worker pool refuses to start when any pinned field differs from its effective configuration; cohort assignment is a deterministic function of the recorded rule, written once per task and kept by retries and repairs; with two pools on real Temporal the candidate cohort's attempt activities run only on the candidate's queue | unit + itest | `packages/application/src/release/worker-pin.test.ts` › "a pool refuses to start on any pin difference"; `packages/application/src/release/assignment.test.ts` › "assignment is deterministic and set once"; `apps/control-plane-api/src/release/release-canary.itest.ts` › "candidate tasks run only on the candidate pool" | `asep-suite:worker-release-pin`, `asep-suite:release-assignment`, `asep-suite:release-canary-real` |
| F2 † | An injected false completion in the candidate cohort moves the release to `ROLLED_BACK` within one evaluation interval: new assignments stop, the cohort's open tasks of the safety classes are cancelled, others finish, the transition and evidence are recorded; relative cohort comparisons are reported and never decide | unit + itest | `packages/application/src/release/guardrails.test.ts` › "any absolute guardrail breach rolls the candidate back", "relative comparisons never decide"; `release-canary.itest.ts` › "a false completion in the canary rolls the release back" | `asep-suite:release-guardrails`, `asep-suite:release-canary-real` |
| F3 | Promotion to `ACTIVE` needs a human with `releases:promote` (use case, database check, and a test that no other code path promotes); at most one `CANARY` and one `ACTIVE` release; transitions outside the state machine are refused | unit | `adapters/persistence/src/release/release-persistence.test.ts` › "only a human promotes and illegal transitions are refused"; `assignment.test.ts` › "no code path promotes a release automatically" | `asep-suite:release-persistence`, `asep-suite:release-assignment` |
| F4 | Each rollback path is rehearsed on real backends: release rollback, a drain-only worker build rollback (Phase 3 procedure), schema N−1 (the previous build's smoke task passes on the migrated schema) and backup and restore (the traceability queries return equal results on the restored database) | itest | `apps/control-plane-api/src/hardening/drills.itest.ts` › "release, worker build and schema rollbacks complete"; `apps/control-plane-api/src/hardening/backup-restore.itest.ts` › "a restored database answers the traceability queries equally" | `asep-suite:hardening-drills-real`, `asep-suite:backup-restore-real` |

## G. SLOs, dashboards and alerting

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| G1 | `docs/platform/slo-catalog.yaml` loads with referential integrity to the metrics dictionary and the invariant-check registry; every SLO has an objective, a window, a state for missing data and its alert thresholds | unit | `packages/observability/src/slo/catalog.test.ts` › "every SLO resolves its metric or invariant check" | `asep-suite:slo-catalog` |
| G2 † | Golden event streams give the expected states: multiwindow burn-rate page and ticket for ratio SLOs (research register §3), page on the first violation of a zero-tolerance SLO, `unknown` (never `ok`) when data is missing; evaluation is deterministic | unit | `packages/observability/src/slo/burn-rate.test.ts` › "burn-rate states match the golden streams", "missing data is unknown, never ok" | `asep-suite:slo-burn-rate` |
| G3 | Each invariant check (duplicate side effect, untraceable pull request, secret exposure, orphan workspace, privileged audit coverage, unexpected egress, release pin drift, stuck task, unclassified artifact kind) finds its seeded violation on real PostgreSQL and finds nothing on the clean fixture | itest | `adapters/persistence/src/operations/invariants.itest.ts` › "each invariant check finds its seeded violation and nothing else" | `asep-suite:invariants-real` |
| G4 | In the gate's digest-pinned Grafana the SLO dashboards and alert rules are provisioned (read back through the API); a seeded breach fires and is delivered to the webhook receiver; the payload carries ids and states only | itest | `apps/control-plane-api/src/operations/slo-alerting.itest.ts` › "a seeded breach reaches the receiver with ids only" | `asep-suite:slo-alerting-real` |
| G5 | When SLO evaluations stop for more than 5 minutes, the deadman alert fires | itest | `slo-alerting.itest.ts` › "stopped evaluations fire the deadman" | `asep-suite:slo-alerting-real` |

## H. Incident response

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| H1 | Every provisioned alert rule links a heading that exists in `docs/operations/production-pilot-runbook.md`, and every incident class of plan §12 has a section | unit | `packages/observability/src/slo/runbook-coverage.test.ts` › "every alert links an existing runbook section" | `asep-suite:runbook-coverage` |
| H2 | An incident opened for a scope places holds, exports the affected workflow histories into held artifacts, writes a deterministic scope report, records every action idempotently, and resolves only by a human | unit + itest | `packages/application/src/hardening/incidents.test.ts` › "incident actions are idempotent and resolution is human"; `apps/control-plane-api/src/hardening/incidents.itest.ts` › "an incident holds its evidence and reports its scope" | `asep-suite:incidents`, `asep-suite:incidents-real` |
| H3 | A drill per incident class of plan §12 reaches its documented containment on real backends: false completion in a canary → rollback; credential exposure → kill switch; unexpected egress → proxy stop and hold; duplicate side effect → incident with holds; Temporal outage with stuck tasks → recovery, then reap of orphans; evidence-store outage → attempts fail closed and nothing is published | itest | `drills.itest.ts` › "each incident class reaches its documented containment" | `asep-suite:hardening-drills-real` |

## I. Completion protocol

| ID | MUST | Kind | Proof | Suite |
|---|---|---|---|---|
| I1 | `phase-06-report.md` and `phase-06-operating-evidence.md` present; machine fields from gate logs and `git rev-parse`; a completion sentinel written last carries `git rev-parse HEAD` | review + gate | controller compares the sentinel SHA with `git rev-parse HEAD` | — |
| I2 | Zero unresolved CRITICAL or HIGH findings from the Codex final audit; accepted dispositions are fixed, not-applicable with evidence, or an explicit user-accepted risk | review | `phase-06-review-log.md` | — |
| I3 | Every `unit`/`itest` row is registered, prints its suite id, and its named tests pass in its runner's proof manifest | unit + gate | `exit-criteria-coverage.test.ts` › "every mapped proof is a registered suite"; the proof-manifest check (CR-B4) | `asep-suite:hardening-exit-coverage` |
| I4 | Each mutation in `mutation-proofs.json` (one per † row: B2, C2, C3, D3, E3, F2, G2) turns its mapped test red in a temporary copy; the control passes; a mutation whose search text does not match exactly once fails the suite | unit | `packages/application/src/hardening/mutation-proofs.test.ts` › "every seeded guard mutation is caught" | `asep-suite:hardening-mutation-proofs` |

## Operating evidence (not code MUSTs)

Every item needs a running pilot. Each depends on Phase 2's pilot prerequisites PP1–PP4 (`phase-02-report.md:363-367`)
except OP6 and the read-only half of OP5. Recorded in `phase-06-operating-evidence.md` with timestamps, ids and the
operator's name; never inferred from a test.

| ID | Smallest real evidence that counts | Duration |
|---|---|---|
| OP1 | The hardened deployment (plan §13) runs on the pilot host with separated roles, forced row security and the operations schedule; a test notification reaches the operator's contact point | hours, after the code is complete |
| OP2 | Dashboards and alerts live on the pilot for a continuous window of at least 7 days (3 days is the floor if the user chooses speed), with at least 10 genuine pilot tasks (Phase 2 K5 definition); a daily export of `slo_evaluations` and of the alert history | the window, plus human time to authorize tasks |
| OP3 | One game-day run by the human operator: alert, incident opened, containment, evidence held, scope report, recovery, and one learning item landed as a regression test; timestamps recorded | one scheduled session |
| OP4 | One real candidate release through canary with at least 3 genuine tasks per cohort and a recorded human promote or rollback decision, plus one deliberate rollback on the deployment; inside the OP2 window | inside OP2 |
| OP5 | A real brownfield repository onboarded read-only at a pinned SHA (secret scan, baseline, readiness report, autonomy map v1 with every module L0); and one genuine characterization task to `WAITING_FOR_HUMAN_REVIEW` with a human disposition | hours for the first half; the second needs PP1–PP4 |
| OP6 | The pilot's own backup restored into a scratch environment, with equal traceability query results | one session |

## Suite registry

New `REQUIRED_SUITES` (25), each registered by the slice that adds its file (CR-G1, append-only):

```text
asep-suite:hardening-contracts          packages/contracts/src/hardening-contracts.test.ts
asep-suite:submission-policy            packages/application/src/hardening/submission.test.ts
asep-suite:incidents                    packages/application/src/hardening/incidents.test.ts
asep-suite:hardening-exit-coverage      packages/application/src/hardening/exit-criteria-coverage.test.ts
asep-suite:hardening-mutation-proofs    packages/application/src/hardening/mutation-proofs.test.ts
asep-suite:hardening-root               apps/control-plane-api/src/hardening-root.test.ts
asep-suite:baseline-classification      packages/application/src/brownfield/classify.test.ts
asep-suite:baseline-plan                packages/application/src/brownfield/plan.test.ts
asep-suite:onboarding-secret-scan       packages/application/src/brownfield/secret-scan.test.ts
asep-suite:readiness-score              packages/application/src/brownfield/score.test.ts
asep-suite:autonomy-admission           packages/application/src/brownfield/admission.test.ts
asep-suite:readiness-policy             packages/policy/src/readiness-scoring.test.ts
asep-suite:brownfield-persistence       adapters/persistence/src/brownfield/brownfield-persistence.test.ts
asep-suite:network-policy               packages/policy/src/network-policy.test.ts
asep-suite:registry-proxy               adapters/network-policy/src/registry-proxy.test.ts
asep-suite:credential-policy            packages/policy/src/credential-policy.test.ts
asep-suite:kill-switch                  packages/application/src/credentials/kill-switch.test.ts
asep-suite:retention-sweep              packages/application/src/retention/sweep.test.ts
asep-suite:release-assignment           packages/application/src/release/assignment.test.ts
asep-suite:release-guardrails           packages/application/src/release/guardrails.test.ts
asep-suite:worker-release-pin           packages/application/src/release/worker-pin.test.ts
asep-suite:release-persistence          adapters/persistence/src/release/release-persistence.test.ts
asep-suite:slo-catalog                  packages/observability/src/slo/catalog.test.ts
asep-suite:slo-burn-rate                packages/observability/src/slo/burn-rate.test.ts
asep-suite:runbook-coverage             packages/observability/src/slo/runbook-coverage.test.ts
```

New `REQUIRED_ITEST_SUITES` (12):

```text
asep-suite:onboarding-real              apps/control-plane-api/src/brownfield/onboarding.itest.ts
asep-suite:brownfield-e2e-real          apps/control-plane-api/src/brownfield/brownfield-e2e.itest.ts
asep-suite:registry-profile-real        adapters/network-policy/src/registry-profile.itest.ts
asep-suite:credential-leak-real         apps/control-plane-api/src/security/credential-leak.itest.ts
asep-suite:retention-real               adapters/persistence/src/retention/retention.itest.ts
asep-suite:tenancy-real                 adapters/persistence/src/tenancy/tenancy.itest.ts
asep-suite:release-canary-real          apps/control-plane-api/src/release/release-canary.itest.ts
asep-suite:invariants-real              adapters/persistence/src/operations/invariants.itest.ts
asep-suite:slo-alerting-real            apps/control-plane-api/src/operations/slo-alerting.itest.ts
asep-suite:incidents-real               apps/control-plane-api/src/hardening/incidents.itest.ts
asep-suite:hardening-drills-real        apps/control-plane-api/src/hardening/drills.itest.ts
asep-suite:backup-restore-real          apps/control-plane-api/src/hardening/backup-restore.itest.ts
```

Existing suites relied on without edit: `asep-suite:compat-gate` and the contract fixture loops cover the four new
schemas generically. Every file above lies in a directory plan §22 gives to the slice's lane.

## Not Phase 6 exit (deferred, plan §3.3)

Row security on the runtime role's sessions; store-enforced object isolation; per-test baseline granularity; purge
of append-only tables; canary of workflow code; statistical canary gating; readiness score calibration; Temporal mTLS
and Grafana SSO; any automatic promotion; non-TypeScript, coverage-based or containerized indexing; the OpenHands
adapter. The Spec Kit importer (S18) is optional and has no MUST.
