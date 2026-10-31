# Phase 6 — Brownfield and Production Hardening — Plan (DRAFT v1)

> Status: **DRAFT v1**, written by lane `phase-06` in workflow step 1 (plan only). Nothing in this plan is
> implemented. The controller runs the independent Codex plan review next; the plan locks after at most two review
> rounds (R58).
> Scope source: `docs/implementation/90-day-plan.md:51-59` (Days 76–90).
> Binding inputs: the lane contract and its addenda, and reconciliation v1 (R1–R5, R10, R51, R54–R59). Where this plan
> and the reconciliation disagree, the reconciliation wins.
> Companion documents: `phase-06-architecture.md`, `phase-06-data-model.md`, `phase-06-exit-criteria.md`,
> `phase-06-risk-register.md`, `phase-06-research-register.md`, `phase-06-threat-model-delta.md`,
> `phase-06-review-log.md`.

```text
BASE_SHA:        f613c7f  (head of phase/02-single-agent-vertical-slice with its CI fixes; Phase 2 accepted at
                 8e71ed7, IMPLEMENTATION_COMPLETE_PILOT_PENDING, R51)
PLAN_BRANCH:     phase/06-brownfield-hardening (lane phase-06, docs only until the plan locks)
READ_THROUGH_GIT phase/03-durable-orchestration @ 2c63fbd (plan LOCKED v8), phase/04-independent-assurance @ e750d4c
                 (plan LOCKED v7); phase/05-skill-context-platform @ f613c7f carries no Phase 5 plan yet (§23)
IMPLEMENTATION:  only after the plan locks, the controller reconciles §19 with the other lanes, and the lane
                 branches are rebased onto a Phase 3 head that carries S1 (5cc8eaf or later) (R58 item 4)
MIGRATIONS:      0400–0499 (lane contract addendum R58); per-lane sub-ranges in §21
```

---

## 0. Execution model

| Step | Who | Output |
|---|---|---|
| 1 | lane `phase-06` (this step) | the Phase 6 document set, committed on `phase/06-brownfield-hardening` |
| 2 | controller | Codex read-only plan review → `phase-06-plan-review-codex-v1.md` |
| 3 | lane `phase-06` | every finding adjudicated in `phase-06-review-log.md` and folded in; at most one more review round (R58 item 3); plan LOCKED |
| 3a | controller | reconciles §19 with Lanes A, B, the Phase 5 lane and Lane R; opens the Phase 6 sub-lanes of §18 |
| 4 | Phase 6 lanes, after "implement" | one slice per commit (§17), each lane on its own branch and directories (§22) |
| 5 | controller | two green CI runs per pushed head (R58 item 2) plus the Codex final review; only CRIT/HIGH block (R58 item 3) |
| 6 | controller | merges on ACCEPT; the order with Phases 3–5 is the controller's |

Per-commit and per-slice gates follow the lane-contract addendum of 2026-10-31 (evening): focused tests and
`pnpm typecheck` per commit, one `~/.openclaw/lanes/gate.sh <lane> pnpm verify:all` per slice, plus
`pnpm test:integration` when the slice touches an itest.

---

## 1. Current-state audit

Line numbers are at `f613c7f` unless a branch is named. Phase 3 and Phase 4 facts are read from their committed
plans, not their worktrees.

### 1.1 What earlier phases give Phase 6

| Asset | Evidence | Phase 6 use |
|---|---|---|
| Framework-free step use cases, risk admission before any side effect | `packages/application/src/execute-task.ts:124-139`; Phase 2 plan §8.1, §23 | onboarding stages and submission checks follow the same pattern |
| Verification sandbox with OS-enforced `--network none` and a frozen flag builder | `adapters/command-runner/src/sandbox.ts:164-194` | baseline runs; the network-policy parity test pins it |
| Agent containment: internal network, isolated gateway, model-API egress proxy | `adapters/agent-claude/src/claude-provider.ts:316` (`buildAgentRunArgs`), `:366` (`buildProxyRunArgs`); proxy lifetime constants `:178-211` | network-policy parity test; kill switch reaps proxies by label |
| GitHub App tokens minted per operation with a fixed permission set | `adapters/github-app/src/credential-provider.ts:30-34` (`MINIMUM_PERMISSIONS`) | credential-policy parity test |
| Model credential read per attempt from a mode-600 file | `adapters/agent-claude/src/model-credentials.ts:25-27`, `:59` | kill-switch decorator |
| Tenant-prefixed, content-addressed, create-only artifact store | `adapters/persistence/src/artifact-store.ts:69`, `:123`, `:138`; data model `phase-02-data-model.md` §3 artifacts | retention decorator and tombstones |
| Composite tenant FKs on every operational table | `phase-02-data-model.md` §1, §3 | row security keys on the same columns |
| Two-phase side-effect log, fenced takeover, traceability chain PR → evidence → attempt → task → run | `phase-02-data-model.md` §3 | invariant checks for the zero-tolerance SLOs |
| Pilot runbook, alert thresholds and stop conditions | `phase-02-pilot-runbook.md` §1–§3 | the production runbook builds on it |
| Temporal task/run workflows, controls (pause, resume, cancel, seal), drain-only deploys, janitor schedule | Phase 3 plan §10, §11, §17; architecture §4.3, §6.6 (`phase/03-durable-orchestration`) | onboarding and operations workflows; rollback drains; demotion and rollback cancel tasks |
| `WorkflowEngine` v2, principal resolver with capabilities | Phase 3 plan CR-09, CR-17 | submission policy seam; human-only decisions |
| Production-shaped Temporal on PostgreSQL (`temporalio/server` + `admin-tools`) | Phase 3 plan S12, CR-14 | the pilot deployment recipe |
| `run_events` (append-only) and `RunEventSink` | Phase 3 data model §3.7 | source of SLIs and guardrail signals |
| Dictionary-driven metric evaluator, append-only `metric_snapshots`, Grafana provisioning loaded in the gate | Phase 4 plan §15, S17, S18; data model §3.2 | ratio SLIs reuse the evaluator; SLO dashboards and alert rules extend the provisioning |

### 1.2 Gaps Phase 6 closes

| # | Gap (observed) | Evidence | Slice |
|---|---|---|---|
| H1 | No baseline: a red check cannot be told apart as pre-existing, flaky or introduced | no baseline table in `adapters/persistence/src/migrations.ts:1109-1127`; `docs/engineering/brownfield-onboarding.md` describes it only | S1, S3 |
| H2 | No dependency materialization: verification runs with `--network none`, so a brownfield build that needs packages cannot run | `adapters/command-runner/src/sandbox.ts:171-175` | S5, S4 |
| H3 | No readiness score, no module autonomy map, nothing consults autonomy before a task starts | ADR 0011; `brownfield-onboarding.md` only | S2, S3 |
| H4 | Network rules live in code only, in two builders; no declared profile, no project overlay, no registry profile | `sandbox.ts:164-194`; `claude-provider.ts:316`, `:366` | S5 |
| H5 | No credential inventory, no kill switch | `docs/operations/security-threat-model.md` lists the controls only | S6 |
| H6 | The application connects as the table owner and migrates with the same connection, so it can disable the append-only triggers it is meant to be held to | `apps/control-plane-api/src/pilot-main.ts:255` (`migrate(client)` on the runtime client); `server-main.ts:42` | S8 |
| H7 | No row security; tenant isolation is application code plus composite FKs only | no `ROW LEVEL SECURITY` in `migrations.ts` | S8 |
| H8 | No retention mechanism; privacy classes exist only for metrics | `docs/platform/metrics-dictionary.yaml:22-46` | S7 |
| H9 | No harness release identity; nothing ties an attempt to a versioned set of images, model, CLI and policies; no canary | Phase 2 records pins per attempt only (`phase-02-pilot-runbook.md` §0.2) | S9, S11 |
| H10 | No SLO evaluation, burn-rate alerting or deadman; the OTel collector exports metrics to `debug` only and Prometheus scrapes only itself | `deploy/otel/collector.yaml` (metrics pipeline exporters `[debug]`); `deploy/prometheus/prometheus.yml` | S10, S12 |
| H11 | Incident response is a list of principles; no incident record, no evidence hold, no scope report, no drill | `docs/operations/incident-response.md` | S13, S14, S16 |
| H12 | No production-shaped pilot deployment, backup or restore | `compose.yaml` header: "Local development only" | S15 |

### 1.3 Lessons applied (`phase-02-final-review-codex-v1.md`, `phase-02-final-rereview-codex-v5.md`)

1. **A green gate that skipped the MUSTs.** Every Phase 6 MUST maps to a named test file and SUITE-ID, and every
   real-backend MUST runs in `pnpm test:integration`, which fails rather than skips when a backend is missing
   (`.github/workflows/ci.yml` integration job; `scripts/integration/run-integration.mjs`). Row security and roles
   are proven only on real PostgreSQL: PGlite runs as a single privileged session and cannot show a role being
   refused (risk P6R-05).
2. **Faked backends.** Rehearsals prove mechanisms; they never stand in for operating evidence. Operating evidence
   (§4) is a separate list with its own verdict line. A drill that runs in CI is a test, not an incident drill.
3. **False status claims.** The report quotes gate summary lines and log paths, cites `file:line`, and writes "not
   verified" for anything not run (exit I1–I4). A criterion that needs operating time is never reported as met by
   code.

### 1.4 Found while planning; reported to the controller

1. **Verification may run on edits the commit leaves out.** The harness verifies the working tree
   (`packages/application/src/vertical-slice-workflow.ts:471-477`: the writable mount is the whole worktree), and the
   commit stages only `allowedPaths` (`adapters/git-worktree/src/worktree-manager.ts:273-278`). Inspection stops only
   on `.git` writes, created refs or a moved HEAD (`execute-task.ts:124-139`). `git grep scopeViolation` finds the
   field only in `packages/contracts/src/generated.ts:131`, so nothing emits it. I found no check that the verified
   tree equals the committed tree. A change outside `allowedPaths` could therefore make verification pass and then
   be left out of the commit. This is read from the code, **not reproduced**. Phase 6 needs the check for
   characterization tasks (B3) and files it as CR-X1 (§19.6). It may bear on Phase 2 exit claims; the controller
   decides.
2. **MinIO's community repository is archived** (archived 2026-04-25, source-only, AGPLv3; research register §8).
   The pinned image `RELEASE.2025-04-22` still resolves by digest, but receives no fixes. Phase 6 keeps it for the
   gate only and makes no store-enforced isolation claim on it (§9.3, risk P6R-08).
3. **The metrics pipeline goes nowhere.** `deploy/otel/collector.yaml` exports metrics to `debug`; no SLO can be
   built on OTel metrics today. Phase 6 builds SLOs on PostgreSQL events and Phase 4's snapshots (§11) and leaves
   the OTel metrics path unchanged.

---

## 2. Baseline gate

Observed in this step on the docs commit through `~/.openclaw/lanes/gate.sh phase-06 pnpm verify:all`; the result
and the sampler line are in the step's status report and the review log ("Step 1"). The diff from `f613c7f` is
documentation only.

---

## 3. Scope

### 3.1 In scope (90-day plan Days 76–90)

1. **Brownfield onboarding pipeline:** dependency materialization under a registry profile, a baseline of the
   operator-approved verification commands at a pinned SHA, run K times; classification of each command as
   `stable-pass`, `known-failing`, `flaky` or `infrastructure-error`; baseline-aware verification plans;
   characterization tasks as a tests-only task kind.
2. **Readiness score and module autonomy map:** a deterministic, evidence-citing score per module; a versioned
   autonomy map that task submission enforces before any workflow starts; promotion by a named human only;
   automatic demotion.
3. **Network and credential policies:** declared network profiles pinned against the code that applies them, a
   registry egress profile, OS-level canaries; a credential inventory pinned against the code, a leak suite over
   every surface, kill switches.
4. **Tenant boundaries and retention:** separate migrator, runtime and reader roles; row security on every tenant
   table; retention policy as data, tombstoned artifact purges with holds and human approval.
5. **Canary harness release process:** a content-addressed harness release manifest; worker pools pinned to one
   release; deterministic cohort assignment at submission; automatic rollback on guardrail breach; human-only
   promotion; rollback rehearsals.
6. **Production pilot hardening for the exit criterion:** SLO catalog, evaluator, invariant checks, Grafana SLO
   dashboards and alert rules with a deadman; incident record, holds, history export, scope report and drills; the
   production runbook; a production-shaped pilot deployment with backup and restore.

### 3.2 Optional

- **Spec Kit importer trial** (S18): reads `specs/NNN-feature/{spec,plan,tasks}.md` of a Spec Kit project into a
  **draft** ProductSpec that a human must approve. No runtime dependency, no CLI install. It is off the critical
  path and has no MUST; a lane takes it only when idle.
- **OpenHands adapter trial: recommended deferral.** Reasons: it needs a Python 3.12 runtime and images in the agent
  path (no package downloads are allowed now, lane-contract addendum 2026-10-30); its agent server keeps its own
  conversation state, which must be fenced as a bounded activity (ADR 0013); a provider integration needs the full
  provider DoD of `definition-of-done.md:17` (malformed output, rate limit, cancellation, budget, event order,
  permission, artifact capture) and its own egress-proxy canaries; it adds nothing to the exit criterion. The
  registry metadata is also inconsistent (research register §2). It goes to the P2 backlog with these preconditions.

### 3.3 Deferred, with reasons

| Item | Why deferred | Precondition to pick up |
|---|---|---|
| Row security on the **runtime** role's sessions | Needs every repository of four lanes to run inside a tenant-scoped transaction (`adapters/persistence/src/sql.ts:27-34` has no per-call scope); a cross-lane rewrite during parallel work is the collision the lane contract forbids. Phase 6 enforces row security for every other role and takes DDL and trigger control away from the runtime role (§9.1). | Phases 3–5 merged; one persistence-wide change behind a reconciliation |
| Store-enforced object isolation (per-tenant S3 credentials) | The pilot is single-tenant on a filesystem store (`phase-02-pilot-runbook.md` §0.2); the gate's MinIO is archived (§1.4) | a maintained S3-compatible target and a second tenant |
| Per-test baseline granularity (JUnit-level quarantine) | Needs a trusted report parser per framework and changes the exit-code verdict rule Phase 2 relies on | a parser shared with Phase 4's false-green checks |
| Purge of append-only tables (`audit_events`, `run_events`, `metric_snapshots`) | Needs changes to other lanes' append-only triggers; no row reaches its retention age during the pilot (operational class 730 days, `metrics-dictionary.yaml:29-34`) | a reconciliation of the triggers |
| Canary of workflow code | Workflow code ships drain-only or patched (Phase 3 architecture §6.6); only activity-side releases are canaried | Temporal Worker Versioning (Phase 3 deferral) |
| Statistical canary gating | Pilot volumes are a handful of tasks; comparisons are reported with intervals, never auto-promote | volume enough for the pre-registered thresholds |
| Readiness score calibration | Weights and bands are policy, not a validated predictor; calibration needs outcomes over time | outcome history per module |
| Temporal mTLS and namespace authorization; Grafana SSO | Single-host pilot on loopback (Phase 3 threat T3-01 stays open) | a multi-host deployment |
| Automatic promotion of autonomy or releases | Never planned: promotion stays human (ADR 0011, ADR 0014) | — |

---

## 4. What code can prove and what needs operating time

The exit criterion — "production pilot has rollback, incident runbook and SLO dashboards" — has a code part and an
operating part. Code and tests prove that the mechanisms exist and behave; only a running pilot proves that they
were used. The two are tracked separately and never substituted for each other.

| Need | Proven by code and tests (exit criteria) | Operating evidence (smallest real evidence that counts, and how long it takes) |
|---|---|---|
| SLO dashboards | catalog, evaluator, invariant checks, dashboards and alert rules load in a digest-pinned Grafana in the gate; a seeded breach fires and reaches a webhook; the deadman fires (G1–G5) | **OP2**: the dashboards and alerts live on the pilot deployment for a continuous observation window of at least **7 days** (3 days is the floor, the longest alert window, if the user chooses speed) containing at least 10 genuine pilot tasks (Phase 2 K5 definition), with a daily export of `slo_evaluations` and the alert history. It takes the window itself plus the time for a human to authorize the tasks |
| Rollback | release rollback, worker-build drain, schema N−1 and backup/restore rehearsed on real backends (F2, F4) | **OP4**: one real candidate release through canary on the pilot with ≥3 genuine tasks in each cohort and a recorded human promote or rollback decision, plus one deliberate rollback executed on the deployment; it runs inside the OP2 window. **OP6**: the pilot's own backup restored into a scratch environment with equal traceability results; one session |
| Incident runbook | runbook coverage test (every alert links an existing runbook section), incident tooling, executable drills for each incident class (H1–H3) | **OP3**: one game-day on the pilot deployment run by the human operator end to end — alert, incident opened, containment, evidence held, scope report, recovery, a learning item (a regression test) — recorded with timestamps; one scheduled session |
| Brownfield onboarding | baseline, classification, scoring, autonomy enforcement, characterization on fixture repositories and the agent double (B1–B3, C1–C3) | **OP5**: a real brownfield repository onboarded read-only at a pinned SHA (baseline, readiness report, autonomy map v1 with every module L0) — hours; and one genuine characterization task to `WAITING_FOR_HUMAN_REVIEW` with a human disposition — needs the live pilot prerequisites |
| Deployment | the recipe, role bootstrap and gates (S15) | **OP1**: the hardened deployment up on the pilot host with a test notification received by the operator; hours after the code is complete |

Every operating item depends on Phase 2's pending pilot prerequisites PP1–PP4 (`phase-02-report.md:363-367`; R54,
R56, R57), except OP6 and the read-only half of OP5. Under R58 the week's target will not include a 7-day window that
starts after the code is done; the honest verdict at the end of that week is at best
`IMPLEMENTATION_COMPLETE_OPERATING_EVIDENCE_PENDING`.

**Verdicts** (exit criteria, "Verdict"): `COMPLETE` needs every MUST and OP1–OP6;
`IMPLEMENTATION_COMPLETE_OPERATING_EVIDENCE_PENDING` names the pending OP ids; `INCOMPLETE` if any code MUST is unmet.
Each carries `_UNREVIEWED` until the controller's final review accepts it. No verdict says "production-ready".

---

## 5. Architecture summary

`phase-06-architecture.md` has the containers, the seams and the sequences. The load-bearing decisions:

1. **One seam into task submission.** A new port `TaskSubmissionPolicy` (§19.1) is consulted by Phase 3's
   `submitTask` use case before any workflow starts. It returns the verdict (admit, admit with publication approval,
   refuse), the verification checks and the harness release routing. Phase 3's default binding admits everything with
   today's plan, so behaviour is unchanged until Phase 6 binds it. Autonomy, baseline and canary all act through this
   one seam; no Phase 6 code runs inside the workflow decision core.
2. **Releases are worker pools.** A harness release is an immutable manifest; a worker pool is started with exactly
   one release and refuses to start if its configuration differs; a task's attempt-scoped activities are routed to
   its release's task queue. This follows the separate-pool advice of the SRE canarying chapter (research register §4)
   and needs no per-request provider configuration.
3. **SLOs live on authoritative data.** Ratio SLIs reuse Phase 4's evaluator over `run_events`; zero-tolerance SLOs
   come from invariant checks over authoritative tables. Evaluations are append-only rows; Grafana only displays and
   notifies. A deadman alert fires when evaluations stop.
4. **Policies are data, pinned against the code that applies them.** Network and credential policies declare what
   the Phase 2 builders and constants do; parity tests turn red on drift in either direction.
5. **Brownfield gating stays strict.** Only `stable-pass` commands may gate; the harness never reclassifies a failure
   of a gating command as pre-existing; a risk level whose mandatory levels no `stable-pass` command covers is refused,
   never downgraded.

---

## 6. Brownfield onboarding pipeline

```text
register onboarding (binding, pinned SHA, onboarding policy hash)              operator, capability onboarding:run
→ for k = 1..K (K from policy, 3..10, default 3):
    fresh leased worktree at the pinned SHA (namespace asep-onboarding/<runId>/<k>; never pushed)
    materialize dependencies   (source none | vendored | registry; registry → profile dependency-registry, §8.2)
    run every approved command  (verification-no-network sandbox, Phase 2 runner, raw evidence captured first)
→ classify each command over its K runs:
    stable-pass          exit 0 in all K runs
    known-failing        non-zero in all K runs
    flaky                mixed
    infrastructure-error any run ended by timeout, signal or a sandbox fault (Phase 2 failure taxonomy class tool)
→ write brownfield-baseline/v1 (artifact) + rows; idempotent on (binding, pinned SHA, policy hash)
→ collect readiness evidence (§7) → readiness-report/v1 → autonomy map v1 (every module L0)
```

- **Production path.** The stages are framework-free step use cases in `packages/application/src/brownfield/**`,
  proven by a thin sequential test driver, and dispatched in production only through `WorkflowEngine` by an
  `onboardingWorkflow` (§19.3 CR-L4). No production entrypoint runs the sequential driver (Phase 3 exit B8 rule).
- **Baseline-aware verification plan** (built at submission, §5 item 1). For a task on a baselined binding at the
  baseline's SHA, the mandatory checks are the `stable-pass` commands mapped to each mandatory level of the task's risk
  (`policies/verification-matrix.yaml`); `known-failing` and `flaky` commands run as **advisory** checks and are
  labelled in the provenance. A mandatory level with no `stable-pass` command makes the submission refuse
  (`baseline-insufficient`); it never makes the level advisory. A task at another SHA refuses with
  `baseline-stale` until a baseline at that SHA exists.
- **A gating failure is never relabelled.** A `stable-pass` command that fails fails the task. A fail-then-pass on a
  rerun is recorded as a flake signal; changing that command's class needs a new baseline or a named human's
  quarantine decision with an expiry.
- **Characterization tasks.** A task whose `allowedPaths` all fall under the module's declared test globs is a
  characterization task. Its plan repeats the module's test command K times on the change (stability) and the scope
  conformance check of CR-X1 must hold (the verified tree is the committed tree, so production code is unchanged).
  It ends at `WAITING_FOR_HUMAN_REVIEW` like every task. Phase 6 does not claim the tests are meaningful; the human
  review does (risk P6R-11).
- **Ecosystems.** Registry materialization supports `pnpm` and `npm` lockfiles only; any other ecosystem must declare
  `none` or `vendored`. Fetching runs with install scripts off; builds that need scripts run in the no-network sandbox
  afterwards (§8.2).

## 7. Readiness score and module autonomy map

- **Modules** are declared by the operator in the autonomy map (`autonomy-map/v1`): id, path globs, test globs,
  owner. A path in no module is L0. Matching uses Git pathspec semantics computed by trusted Git, the same semantics
  as the commit's `git add -- <allowedPaths>` (`worktree-manager.ts:274-275`), never a second glob dialect.
- **Score.** Ten dimensions from `brownfield-onboarding.md` (build reproducibility, test strength, architecture
  clarity, documentation, observability, deployment safety, isolation, ownership, task modularity, historical
  stability). Each dimension is 0–10 from named checks; each check cites an artifact ref (measured) or a human
  attestation (named, with expiry); a check without evidence scores 0 with reason `not-evidenced`. The module score is
  `Σ weight_d × score_d` with weights summing to 10, so 0–100, aggregated like OpenSSF Scorecard's risk-weighted
  average (research register §14). Measured checks come from the baseline (build, tests, isolation), the repository
  at the pinned SHA (CODEOWNERS, docs presence) and trusted `git log` over a bounded window (change coupling, revert
  ratio). Test-map checks use Phase 5's index when it is on the base (G-P5IDX); before that they are `not-evidenced`.
- **Bands** (`brownfield-onboarding.md`): 0–30 read-only, 31–50 draft, 51–70 agent PR, 71–85 and 86–100 are bands
  whose autonomy does not exist in this harness (no auto-merge, `phase-02-plan.md` §8.1), so the recommendation is
  capped at L2 and the report says so.
- **Levels and admission** (policy table, `policies/autonomy-policy.yaml`):

  | Level | Admitted at submission | Publication |
  |---|---|---|
  | L0 read-only | only characterization tasks (tests-only scope) | publication approval required |
  | L1 draft | tasks whose risk Phase 2/4 admission admits | publication approval required |
  | L2 agent PR | tasks whose risk Phase 2/4 admission admits | no extra approval |

  A task's level is the **lowest** level among every module its `allowedPaths` touch; an empty `allowedPaths` touches
  every module. Admission by risk (`risk-admission.ts`; Phase 4's `admitWithAssurance`) still applies on top.
- **Promotion and demotion.** A promotion is a new map version decided by a named human principal (capability
  `autonomy:decide`, class `human`) citing a readiness report. A demotion to L0 is automatic when a confirmed false
  completion, a policy violation or a scope violation is attributed to an attempt touching the module; it cancels the
  module's open tasks through `WorkflowEngine.cancel` and is audited. No code path promotes automatically.

## 8. Network and credential policies

### 8.1 Profiles as data

`policies/network-policy.yaml` declares the platform's profiles and their maximum allowlists:

| Profile | Applied by | Egress |
|---|---|---|
| `verification-no-network` | `adapters/command-runner/src/sandbox.ts:164-194` | none (`--network none`) |
| `agent-model-egress` | `adapters/agent-claude/src/claude-provider.ts:316`, `:366`, `assets/egress-proxy.mjs` | internal network; egress proxy to the configured model origin, `POST /v1/messages` and `/v1/messages/count_tokens` only |
| `dependency-registry` | new `adapters/network-policy/**` | internal network; registry proxy allowing `CONNECT <host>:443` to allowlisted hosts only |

A parity test reads the policy and the builders' outputs and fails on any drift in either direction. A project overlay
may only narrow a profile (intersection with the platform maximum); a widening is refused at load. Every container the
harness starts records its profile id in provenance.

### 8.2 The registry profile

The registry proxy (Node built-ins only) accepts `CONNECT host:443` for allowlisted host names, refuses IP literals,
other ports, plain HTTP and absolute-form requests, and logs `host, port, decision, bytes` (never headers or bodies) as
a `dependency-egress-log` artifact. The fetch container has no other route (internal network, isolated gateway, as
Phase 2's agent network). The package manager runs with install scripts disabled; a repository `.npmrc` with keys
outside an allowlist fails the step closed; tarball hosts in the lockfile must be allowlisted. OS-level canaries
prove the denials on the real daemon.

### 8.3 Credentials

`policies/credential-policy.yaml` lists every credential class — model API key, GitHub App private key, installation
token, reviewer gateway key (Phase 4), database roles, object-store keys, Grafana admin — with holder, scope, maximum
lifetime, rotation, revocation and the surfaces it must never reach. Parity tests pin the declared values to the code
(`MINIMUM_PERMISSIONS`; the proxy lifetime constants). A leak suite plants a canary value for each class and searches
every surface: stored artifact bytes, audit rows, run events, exported workflow histories, gate logs, and the argv and
environment of every untrusted container. **Kill switches** per class and scope (platform, organization, project) are
engaged by a human or platform operator; while engaged, the model credential decorator refuses, the forge port
decorator refuses, and open attempts in scope have their egress proxies reaped by label. Installation tokens already
expire after one hour (research register §11); the switch also stops new mints.

## 9. Tenant boundaries and retention

### 9.1 Roles and row security

| Role | Owns | May | May not |
|---|---|---|---|
| `asep_migrator` | every table | DDL, migrations | serve requests |
| `asep_runtime` | nothing | `SELECT, INSERT, UPDATE` on mutable tables; `SELECT, INSERT` on append-only tables | `DELETE`/`UPDATE` on append-only tables, `TRUNCATE`, DDL, disable triggers |
| `asep_reader` (group) and one login role per tenant | nothing | `SELECT` on named views, row-filtered to its tenant | anything else |

Row security is enabled **and forced** on every table with an `organization_id` column. The reader policy filters by
a `reader_role_scopes` mapping of login role to organization, so a per-tenant Grafana data source sees only its rows.
The runtime role's policy is permissive in Phase 6 (§3.3); its isolation stays the Phase 2 application scope plus
composite FKs, and what changes for it is that it no longer owns the schema. The migration runs last (`0490`) and a
catalog test over `pg_class`/`pg_policies` fails on any tenant table without forced row security and a policy, which
also catches later tables. Roles are created by the deployment bootstrap (superuser), not by a migration; the
migration fails closed when they are missing. Composition roots take a migrator URL and a runtime URL (CR-L5).
Foreign-key checks bypass row security (research register §5); the covert channel is recorded (threat T6-07).

### 9.2 Retention

`policies/retention-policy.yaml` assigns every artifact kind and every tenant table a class with a retention period
and a deletion method. Proposed defaults, which are **user decisions** (compliance choices): evidence-core kinds 730
days, raw-output kinds 180 days, unknown kinds kept with no purge and a `ticket` alert. A retention sweep computes
eligible artifacts deterministically, writes a dry-run report artifact, and deletes bytes only after a human approval
record. A purged artifact keeps its metadata row (id, sha256, size, kind) plus a tombstone; reads raise
`ArtifactPurgedError`, never a corruption or loss error. Holds — a non-terminal or under-review task, an incident, the
pilot evidence set — block purges. Table rows are not purged in Phase 6 (§3.3).

### 9.3 Object storage and other stores

The pilot uses the filesystem store; the gate uses the pinned MinIO. Phase 6 keeps Phase 2's tenant-prefixed keys and
scoped store API (`phase-02-threat-model-delta.md` T2-04) and adds no store-enforced claim (§3.3). Temporal history is
refs-only (Phase 3 architecture §16) and keeps its 720-hour namespace retention; incident tooling exports affected
histories into held artifacts before that retention removes them.

## 10. Canary harness release and rollback

- **Release manifest** (`harness-release/v1`): agent image digest, CLI version, model id, egress-proxy and verification
  image digests, dependency-fetch image digest, the sha256 of each policy file the attempt path reads, the worker
  build's Git SHA, and optional Phase 4 reviewer configuration hash and Phase 5 skill-registry snapshot id. Its id is
  derived from its canonical bytes.
- **Pools.** A worker pool reads its manifest at start and refuses to start unless its effective configuration equals
  it (CR-L3). It polls the task queue `asep-activities-<release-id prefix>`. An audit check compares every attempt's
  recorded invocation pins with its task's release; a difference is an invariant violation (page).
- **Assignment.** At submission the release policy assigns the task to the active release or, while a canary runs, to
  the candidate by a deterministic rule recorded with the assignment: `first-n` (the next N eligible submissions) or
  `percent` (hash of task id and release id). Retries and repairs keep the task's assignment. One candidate at a
  time.
- **Guardrails** (absolute; any one in the candidate cohort triggers automatic rollback): a false completion, a
  policy or scope violation, a credential redaction, an unexpected egress line, a duplicate side effect, a release pin
  drift, a sandbox isolation failure. Rollback stops new assignments to the candidate within one evaluation interval
  (1 minute), cancels the candidate's open tasks for the safety classes, lets other open tasks finish, records the
  transition, and the operator drains and stops the candidate pool. Relative comparisons (verification pass rate,
  cost per accepted task, duration) are reported per cohort with Wilson intervals and never decide.
- **Promotion** to active is a named human decision (`releases:promote`, class `human`). No automatic promotion path
  exists; a fitness test refuses one.
- **Rollback scope in this harness.** Nothing is merged by the harness, so there is no product rollback; rollback
  means the harness itself: the release (above), the worker and API build (Phase 3's drain-only procedure), the schema
  (Phase 6 migrations are additive; the previous code runs on the migrated schema) and the data (backup and restore,
  §13). A task's own rollback stays "close its PR and delete its branch" (`phase-02-pilot-runbook.md` §2).

## 11. SLOs, dashboards and alerting

- **Catalog** (`docs/platform/slo-catalog.yaml`, new; loader with referential integrity to the metrics dictionary and
  the invariant-check registry):

  | SLO | Kind | Objective | SLI source |
  |---|---|---|---|
  | `workflow-recovery` | ratio | 99.9% over 30 days | metric `workflow_recovery_rate` (Lane A events) |
  | `false-completion` | zero-tolerance | 0 | metric `false_completion_rate` numerator |
  | `duplicate-side-effect` | zero-tolerance | 0 | invariant `duplicate-side-effect`; metric `duplicate_side_effect_incidents` (Phase 3 CR-19) |
  | `artifact-loss` | zero-tolerance | 0 | metric `artifact_loss_rate` numerator |
  | `untraceable-pull-request` | zero-tolerance | 0 | invariant: PR → evidence → attempt → task → run → project chain |
  | `secret-exposure` | zero-tolerance | 0 | invariant: credential redaction failures |
  | `orphan-workspace` | zero-tolerance | 0 | invariant: workspace or labelled container older than lease grace |
  | `privileged-audit-coverage` | zero-tolerance | 100% | invariant: every completed side effect, control and decision has its audit row |
  | `unexpected-egress` | zero-tolerance | 0 | invariant: an egress or dependency log line outside the allowlist |
  | `release-pin-drift` | zero-tolerance | 0 | invariant (§10) |
  | `stuck-task` | ticket only | 0 | invariant: a non-terminal task with no event for longer than policy |
  | `telemetry-freshness` | deadman | latest evaluation newer than 5 minutes | the evaluator's own rows |

- **Burn-rate rules** for ratio SLOs follow the SRE workbook table for a 99.9% / 30-day SLO: page at 14.4× over 1 h
  and 5 min, page at 6× over 6 h and 30 min, ticket at 1× over 3 days and 6 h (research register §3). Below a
  minimum event count in the long window a bad event raises a ticket, as the workbook advises for low traffic; at
  pilot volume the ratio rules mostly degenerate to that, which the dashboard states. Zero-tolerance SLOs page on the
  first bad event. No data is `unknown`, never `ok`.
- **Evaluation** runs every minute under a Temporal Schedule (`operationsWorkflow`, CR-L4): Phase 4's metric recompute,
  the invariant checks, the SLO evaluation, the release guardrails. Results are append-only `slo_evaluations` and
  `invariant_violations` rows.
- **Grafana** (Phase 4's pinned image and data source): an SLO dashboard (state, budget remaining, burn rates per
  window, invariant violations, release cohorts, telemetry freshness) and Grafana-managed alert rules from
  `provisioning/alerting` (file-provisioned, apiVersion 1; research register §6). Every alert rule carries a
  `runbook_url` annotation to a section of the production runbook. The contact point in the gate is a local webhook
  receiver; on the pilot it is the operator's channel (a user decision).

## 12. Incident response

- **Incident record** (`incidents`, `incident_scopes`, `incident_actions`; data model §3.1) opened by a human, from an
  alert or by hand, with a severity S1–S4.
- **Opening an incident** places retention holds on the affected scope, exports the affected workflows' histories into
  held artifacts, and writes a deterministic scope report artifact: tenants, projects, runs, tasks, attempts, PRs and
  releases in the window or release named.
- **Containment actions** are the runbook's machine steps: pause or cancel workflows (Phase 3 controls), roll back the
  release (§10), engage kill switches (§8.3), reap labelled containers (Phase 3 `ExecutionReaper`). Each action is an
  `incident_actions` row and an audit row.
- **Learning output** (`incident-response.md`): every material incident closes with a regression test or eval, a
  failure-taxonomy check and the sensor that should have caught it; the record links them.
- **Drills.** Executable drills (S16) inject each incident class on real backends and check that the machine steps
  reach the documented containment state: false completion, credential exposure, unexpected egress, duplicate side
  effect, Temporal outage with stuck tasks, evidence-store outage. They prove the tooling; OP3 is the human drill.

## 13. Production pilot deployment

`deploy/pilot/` holds a production-shaped, single-host recipe: digest-pinned PostgreSQL, Temporal server on PostgreSQL
with `admin-tools` schema setup (Phase 3 S12 images), Grafana (Phase 4 pin), the API, a baseline worker pool and an
optional candidate pool; every port on 127.0.0.1; secrets as files (Compose file secrets, mounted at
`/run/secrets/<name>`, never environment values; research register §17); a role bootstrap SQL; persistent volumes;
backups (`pg_dump` from the pinned PostgreSQL image, a copy of the object-store directory) to a host directory with mode
600 files. A restore script restores into a fresh environment, and the traceability check and the pilot verifier's
database checks must give byte-identical reports before and after. It is a single-operator, single-host pilot: no high
availability, and alerting stops if the host stops (risk P6R-13).

## 14. Optional trials

- **Spec Kit importer (S18, optional).** Spec Kit 1.2.5 writes `specs/NNN-feature/spec.md`, `plan.md`, `tasks.md`
  and `.specify/` (research register §1). The importer maps headings and requirement lines to a draft
  `product-spec` artifact marked `draft`, preserves unmapped sections as notes, and never becomes operational state
  (framework support matrix: "Spec Kit | Importer | … | sole operational state" not allowed). SHOULD-level checks only:
  a fixture project imports to a schema-valid draft; requirement ids are stable across two imports.
- **OpenHands.** Deferred (§3.2).

---

## 15. Testing and the mandatory gates

| Layer | What | Where |
|---|---|---|
| Pure cores | classification, scoring, autonomy admission, cohort assignment, guardrail decision, burn-rate evaluation, retention eligibility, policy loaders and overlays | `pnpm test` |
| Parity | network and credential policies against the Phase 2 builders and constants | `pnpm test` |
| Persistence | 04xx migrations apply, re-apply as no-ops, refuse edits, run under the advisory lock; repositories | `pnpm test` (PGlite) + `pnpm test:integration` (real PostgreSQL) |
| Roles and row security | grants, forced row security, reader isolation, catalog coverage | `pnpm test:integration` only (real PostgreSQL) |
| Sandboxes | baseline runs, registry proxy canaries, kill-switch reaping | `pnpm test:integration` (real Docker) |
| Workflows | onboarding and operations workflows, canary routing with two pools, demotion and rollback cancels | `pnpm test:integration` (real Temporal, from G-P3S8) |
| Dashboards | SLO dashboards and alert rules in Grafana, webhook delivery, deadman | `pnpm test:integration` (Phase 4's Grafana container) |
| Rehearsals | incident drills, rollback rehearsals, backup/restore equivalence | `pnpm test:integration` |

New SUITE-IDs join `REQUIRED_SUITES` and `REQUIRED_ITEST_SUITES` append-only (R10); exit criteria list them. Live Claude
and live GitHub stay opt-in as in Phase 2; the agent is the Phase 2 fake executable in the real sandbox.

## 16. Task DAG and gates

```text
G-LOCK + G-BASE ──▶ S0 ──┬─▶ S1 ─▶ S2 ─┬─────────────▶ S3* ─▶ S4* ─────────────┐
                         │             │                                       │
                         ├─▶ S5 ───────┼──────────────────────▶ (S4 registry)  │
                         ├─▶ S6 ───────┤                                       │
                         ├─▶ S7 ───────┤                                       ├─▶ S8 (roles + row security, last migration)
                         ├─▶ S9 ─▶ S10 ┴─▶ S11* ─────────────────────────────────┤
                         │          └──────▶ S12* (needs S13 headings)          │
                         ├─▶ S13 (runbook, early) ──▶ S14 ─▶ S15 ─▶ S16 ─▶ S17 ┘
                         └─▶ S18 (optional)
* = also gated on another phase (Gate column)
```

| Gate | Meaning |
|---|---|
| G-LOCK | plan locked; the controller has reconciled §19 with the other lanes |
| G-BASE | the lane branch rebased onto a Phase 3 head carrying S1 (`5cc8eaf` or later) |
| G-P3S8, G-P3S9, G-P3S12 | that Phase 3 slice accepted on the base (Temporal in the gate; API, `submitTask` and engine wiring; production-shaped Temporal images) |
| G-P4S17, G-P4S18 | that Phase 4 slice accepted on the base (metric evaluator; Grafana provisioning in the gate) |
| G-P5IDX | Phase 5's repository-index read port on the base (optional; only index-backed readiness checks) |
| G-CRx | change request x of §19 landed by its owner |
| G-PILOT | Phase 2 pilot prerequisites PP1–PP4 met (operating evidence only) |

Acyclic. S1, S2, S5, S6, S7, S9, S10, S13 can start in parallel right after S0. S8 waits for every other Phase 6
migration so that its catalog test covers them.

## 17. Slices (one commit each) with acceptance checks

| Slice | Lane | Deliverable | Gate | Acceptance (exit criteria) | Commit |
|---|---|---|---|---|---|
| S0 | phase-06 | Contracts `harness-release/v1`, `brownfield-baseline/v1`, `readiness-report/v1`, `autonomy-map/v1` (schemas, valid and invalid fixtures, `snapshots/v1` entries, generated types, `ContractName` entries, `COMPATIBILITY.md` for these four only, R7); the `packages/ports` additions of §19.1 exactly as reconciled; `packages/application/src/hardening/submission.ts`: the policy composer (most restrictive verdict wins) and the `AdmitAllSubmissionPolicy` default, with tests | G-LOCK, G-BASE | A3, and the composer half of C2 | `feat(contracts): add harness release, baseline, readiness and autonomy contracts` |
| S1 | phase-06-h2 | Baseline step use cases (register, run K, classify, write baseline), `dependencySource: none \| vendored`; migration `0410`; repositories; sequential test driver; itest with a fixture repository holding one passing, one failing and one alternating command on real Docker, Git and PostgreSQL | S0 | B1 (none/vendored) | `feat(brownfield): record a classified baseline of approved commands at a pinned commit` |
| S2 | phase-06-h2 | Scoring policy and loader, pure scorer, Git-history checks through trusted Git, attestations, autonomy map versions; migration `0411`; golden reports | S1 | C1, C3 (recording) | `feat(brownfield): score module readiness from cited evidence and version the autonomy map` |
| S3 | phase-06-h2 | The brownfield half of `TaskSubmissionPolicy`: baseline-aware plan, autonomy admission, test-only scope detection, automatic demotion with task cancellation; real-Temporal e2e with the agent double | S2, G-P3S9, G-CR-L1, G-CR-X1 | B2, B3, C2, C3 | `feat(brownfield): admit tasks by module autonomy with baseline-aware verification plans` |
| S4 | phase-06-h2 | `onboardingWorkflow` in the carve-out (CR-L4); registry materialization through S5's materializer; production dispatch through the engine; e2e on real Temporal | S1, S5, G-P3S8, G-CR-L4 | B1 (registry, durable) | `feat(brownfield): run onboarding as a durable workflow` |
| S5 | phase-06-h3 | `policies/network-policy.yaml` and loader with overlay intersection; parity tests against the Phase 2 builders; `adapters/network-policy` (registry proxy, `DependencyMaterializer` on Docker); OS-level canaries | S0 | D1, D2 | `feat(network-policy): declare egress profiles and enforce a registry-only fetch profile` |
| S6 | phase-06-h3 | `policies/credential-policy.yaml`, loader, parity tests; kill switches (migration `0431`) with the model-credential and forge decorators and proxy reaping; the leak suite | S0; its history surface G-P3S8 | D3, and the kill-switch part of H3 | `feat(credentials): inventory credential classes, hunt leaks on every surface and add kill switches` |
| S7 | phase-06-h3 | `policies/retention-policy.yaml`, loader; holds, purges and sweeps (migration `0430`); `RetentionAwareArtifactStore`; `ArtifactPurgedError`; dry-run and approved sweeps; itests on PostgreSQL, MinIO and the filesystem store | S0 | E3 | `feat(retention): purge expired artifact bytes behind holds, approval and tombstones` |
| S8 | phase-06-h3 | Migration `0490` (grants, forced row security, reader mapping), the table access-class registry, catalog coverage itest, role creation in the integration gate (CR-G2), migrator and runtime URLs in the roots (CR-L5); the migration upgrade-path itest over the full 04xx set | every other 04xx migration landed (S1, S2, S6, S7, S9, S10, S14); G-CR-L5, G-CR-G2 | A4, E1, E2 | `feat(persistence): separate the migrator, runtime and reader roles under forced row security` |
| S9 | phase-06-h4 | `policies/release-policy.yaml`, loader; `harness_releases`, transitions, assignments (migration `0450`); `assertWorkerMatchesRelease`; deterministic assignment; human promotion use case | S0 | F1 (core), F3 | `feat(release): pin worker pools to content-addressed harness releases` |
| S10 | phase-06-h4 | `docs/platform/slo-catalog.yaml` and loader; burn-rate evaluator; invariant checks; `slo_evaluations`, `invariant_violations` (migration `0451`); golden streams; ratio SLIs through Phase 4's evaluator | S9 (pin-drift check); G-P4S17 for ratio SLIs | G1, G2, G3 | `feat(observability): evaluate SLOs and invariants from authoritative data` |
| S11 | phase-06-h4 | Release half of `TaskSubmissionPolicy` (routing); guardrail evaluation; automatic rollback with cancels; two-pool real-Temporal e2e with an injected false completion | S9, S10, G-P3S9, G-CR-L1, G-CR-L2, G-CR-L3 | F1 (e2e), F2 | `feat(release): canary harness releases and roll back on guardrail breach` |
| S12 | phase-06-h4 | Grafana SLO dashboard and alert rules in the carve-out (CR-B1); `operationsWorkflow` schedule (CR-L4); webhook receiver itest; deadman; runbook-link test | S10, S13, G-P4S18, G-P3S8, G-CR-B1, G-CR-B2, G-CR-L4 | G4, G5, H1 | `feat(observability): provision SLO dashboards, burn-rate alerts and a deadman` |
| S13 | phase-06 | `docs/operations/production-pilot-runbook.md` (procedures from §8–§13, one section per alert); edits to `incident-response.md`, `slo-and-alerting.md`, `release-management.md`, `multi-tenancy.md`, `brownfield-onboarding.md` | S0 | H1 (document part) | `docs(operations): write the production pilot runbook` |
| S14 | phase-06 | Incident record (migration `0400`), use cases (open, scope report, holds through S7, history export through the carve-out), CLI and routes; itest | S7, G-P3S8 | H2 | `feat(incidents): open incidents with evidence holds, history export and a scope report` |
| S15 | phase-06 | `deploy/pilot/**` recipe and role bootstrap; `hardening-root.ts` wiring every Phase 6 policy and decorator; backup and restore scripts with the equivalence itest | S3, S6, S7, S8, S11, G-P3S12, G-CR-L5 | F4 (backup/restore), OP1 readiness | `feat(deploy): add a production-shaped pilot deployment with backup and restore` |
| S16 | phase-06 | Executable incident drills and rollback rehearsals (release, drain, schema N−1) on real backends | S11, S14, S15 | H3, F4 | `test(operations): rehearse incident containment and every rollback path on real backends` |
| S17 | phase-06 | `phase-06-report.md`, `phase-06-operating-evidence.md` (OP1–OP6 ledger), preserved gate logs | last | I1–I4 | `docs(hardening): record the hardening evidence and what still needs operating time` |
| S18 | phase-06 (optional) | Spec Kit importer trial | S0 | SHOULD only | `feat(importers): import Spec Kit feature specs as draft product specs` |

Every slice: re-read its exit criteria; tests first where sensible; the smallest change; focused tests and
`pnpm typecheck` per commit; one `verify:all` through `gate.sh` per slice (+ `test:integration` when it adds or
changes an itest); review the diff; commit. No `git add -A`.

## 18. Proposed parallel lanes

| Lane | Branch (proposed) | Slices | Directories (§22) | Migrations |
|---|---|---|---|---|
| `phase-06` (lead) | `phase/06-brownfield-hardening` | S0, S13, S14, S15, S16, S17, S18 (optional) | contracts additions, `hardening/**`, incidents, deploy/pilot, docs | `0400`–`0409` |
| `phase-06-h2` | `lane/brownfield-autonomy` | S1, S2, S3, S4 | `brownfield/**`, readiness and autonomy policy | `0410`–`0429` |
| `phase-06-h3` | `lane/policy-boundaries` | S5, S6, S7, S8 | network-policy adapter, credential, retention, tenancy | `0430`–`0449`, `0490`–`0499` |
| `phase-06-h4` | `lane/release-slo` | S9, S10, S11, S12 | `release/**`, `operations/**`, SLO catalog, Grafana SLO carve-out | `0450`–`0479` |

`0480`–`0489` stay reserved. Sub-lanes branch from the lead branch after S0, as R58 does for Phases 3 and 4. What can
run at once after S0: S1, S5, S6, S7, S9, S13 (and S10's pure core). What waits on other phases: S3 and S11 (G-P3S9),
S4 and S12 (G-P3S8), S10's ratio SLIs (G-P4S17), S12 (G-P4S18), S15 (G-P3S12). Those gates are the critical path; if
they slip, the Phase 6 code verdict slips with them (risk P6R-01).

## 19. Shared-surface change requests

Nothing below is edited before the controller reconciles it. "Owner" is the lane that lands the change. All changes
are additive unless marked.

### 19.1 `packages/ports/src/index.ts` (owner phase-06, S0)

```typescript
// Decided once per task, before any workflow starts. Phase 3's submitTask use case consults it;
// its default binding admits every task with the submitter's plan and no routing (byte-identical
// behaviour). Implementations read authoritative state and write only their own decision record,
// idempotent on taskId: a second call for the same task returns the recorded decision.
export type TaskSubmissionVerdict = 'ADMIT' | 'ADMIT_WITH_PUBLICATION_APPROVAL' | 'REFUSE';

export type TaskSubmissionRefusal =
  | 'module-read-only'            // a touched module is L0 and the task is not tests-only
  | 'baseline-missing'            // the binding is baselined but has no baseline at this SHA's policy
  | 'baseline-stale'              // the task's baseSha differs from the baseline's pinned SHA
  | 'baseline-insufficient'       // a mandatory level of the task's risk has no stable-pass command
  | 'onboarding-incomplete'       // the binding is registered for onboarding and has no autonomy map yet
  | 'release-unavailable';        // the assigned release has no running pool or was rolled back

export type VerificationLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9';

export interface PlannedCheck {                // the shape of task-workflow-input/v1 verification.checks[]
  readonly id: string;
  readonly level: VerificationLevel;
  readonly category: string;                   // the evidence-bundle check category enum
  readonly mandatory: boolean;
  readonly commandId: string;                  // resolved by Phase 3's VerificationCommandCatalog
}

export interface TaskSubmissionPolicyInput {
  readonly taskId: TaskId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly risk: RiskLevel;
  readonly baseSha: string;                    // 40-hex
  readonly allowedPaths: readonly string[];    // from the stored, validated WorkOrder
  readonly requestedChecks: readonly PlannedCheck[];   // the plan the submitter named, resolved
}

export interface TaskSubmissionDecision {
  readonly verdict: TaskSubmissionVerdict;
  readonly refusal: TaskSubmissionRefusal | null;      // non-null exactly when verdict is REFUSE
  readonly checks: readonly PlannedCheck[];            // the plan the workflow input carries
  readonly harnessReleaseId: string | null;            // null: no release routing
  readonly activityTaskQueue: string | null;           // null: the default activity queue
  readonly decisionSha256: string;                     // sha256 of the canonical decision record
}

export interface TaskSubmissionPolicy {
  decide(scope: TenantScope, input: TaskSubmissionPolicyInput): Promise<TaskSubmissionDecision>;
}

// A purged artifact: its bytes were deleted under the retention policy; its metadata and hash remain.
// Distinct from integrity failure and from loss. Readers treat it as "not available", never as corruption.
export class ArtifactPurgedError extends Error {
  constructor(readonly artifactId: ArtifactId, readonly purgedAt: string) {
    super(`artifact ${artifactId} was purged at ${purgedAt} under the retention policy`);
    this.name = 'ArtifactPurgedError';
  }
}
```

`PlannedCheck` must be assignable to and from Lane A's generated type for `task-workflow-input/v1`
`verification.checks[]`; S0 adds a type-level test once that type is on the base, and if Lane A's type already
exports a name for it, the reconciliation may replace `PlannedCheck` with that name.

Every other Phase 6 port (`DependencyMaterializer`, `CredentialKillSwitch`, `WorkflowHistoryExporter`, the
repositories) is application-local under Phase 6 directories (architecture §6), as Lane B does in
`packages/application/src/assurance/ports.ts`.

### 19.2 `packages/contracts/**` (owner phase-06, S0)

| Contract | Version | Compat impact |
|---|---|---|
| `harness-release/v1` | 1.0.0 | new logical contract (D-1 option b, R7) |
| `brownfield-baseline/v1` | 1.0.0 | new logical contract |
| `readiness-report/v1` | 1.0.0 | new logical contract |
| `autonomy-map/v1` | 1.0.0 | new logical contract |
| `task-workflow-input/v1` | 1.0.0 → 1.1.0 (MINOR) | optional `harnessReleaseId` (pattern `^hr-[0-9a-f]{16}$`) and `activityTaskQueue` (pattern `^asep-activities(-[0-9a-f]{16})?$`); **owner Lane A** (its schema), CR-L2 |

`run-event` is **not** changed (R5): canary cohorts are joined from `task_release_assignments`, and Phase 6's events
are rows in its own tables, not run events, because `run_events` keeps its FK onto `runs` (R15). The metrics
dictionary is **not** changed: zero-tolerance SLIs are invariant rows, not dictionary metrics (as Phase 4 treats
telemetry completeness, Phase 4 architecture §13).

### 19.3 Lane A (Phase 3) modules

| CR | Change | Why |
|---|---|---|
| CR-L1 | `submitTask` (Phase 3 S9) calls `TaskSubmissionPolicy.decide` after validating the work order and before `WorkflowEngine.submitTask`. `REFUSE` → 409 with the refusal, audited, no workflow; `ADMIT_WITH_PUBLICATION_APPROVAL` → the task input's `governance.publicationApprovalRequired` is true (OR with the run's); `checks` and routing go into the input. Default binding `AdmitAllSubmissionPolicy` from S0 | the single seam (§5) |
| CR-L2 | `task-workflow-input/v1` 1.1.0 (§19.2); the task workflow schedules attempt-scoped activities (prepare workspace through cleanup, agent, verification, commit, publication) on `activityTaskQueue` when set; task-level activities stay on the default queue | release pools (§10) |
| CR-L3 | `workers/temporal-worker/src/main.ts`: when `ASEP_HARNESS_RELEASE_MANIFEST` is set, call Phase 6's `assertWorkerMatchesRelease(manifest, effectiveConfig)` before `createWorker()` and poll that release's activity queue; fail at startup on mismatch | pool pinning |
| CR-L4 | Carve-outs inside `adapters/temporal/**`, owned by Phase 6 and bound by Lane A's fitness rules (Temporal confinement, workflow purity, explicit activity options): `src/workflows/onboarding/**` (h2), `src/workflows/operations/**` and the operations schedule (h4), `src/operations/history-exporter.ts` (phase-06); one append-only registration line each in Lane A's workflow index | onboarding and operations need Temporal; only this package may import it |
| CR-L5 | Composition roots (`production-root.ts`, the worker main, `pilot-main.ts`, `server-main.ts`) migrate with `ASEP_PG_MIGRATOR_URL` and serve with `ASEP_PG_URL`; a missing migrator URL fails at startup in production mode; they import `hardening-root.ts` (sibling root, R10) | role separation (§9.1) |
| CR-L6 | Capability constants appended to the principal resolver: `onboarding:run`, `autonomy:decide`, `releases:manage`, `releases:promote`, `incidents:manage`, `retention:approve`, `credentials:kill`; `autonomy:decide`, `releases:promote` and `retention:approve` require class `human` | human-only decisions |
| CR-L7 | One registration line in `apps/control-plane-api/src/app.ts` for Phase 6's operator routes | routes live in Phase 6 directories |

### 19.4 Lane B (Phase 4) modules

| CR | Change |
|---|---|
| CR-B1 | Carve-out inside `deploy/grafana/**` for Phase 6: `provisioning/dashboards/slo/**`, `provisioning/alerting/**` and one dashboard-provider file; Phase 6 reuses Lane B's data source uid. After `0490` the data source connects as a reader login role |
| CR-B2 | In the integration gate's Grafana container (SR-T4): a reachable webhook receiver for alert delivery (a container on the gate network or a host-gateway route), and alert evaluation enabled |
| CR-B3 | Phase 4's evaluator API is imported, not copied (Phase 4 architecture §13: one place for formulas); Phase 6 needs a call that evaluates one dictionary metric over an explicit window |

### 19.5 Gates, registries and build files

| CR | Change |
|---|---|
| CR-G1 | `REQUIRED_SUITES` and `REQUIRED_ITEST_SUITES` append-only entries (exit criteria, "Suite registry") |
| CR-G2 | `scripts/integration/**`: the gate creates `asep_migrator`, `asep_runtime`, `asep_reader` and two tenant reader login roles before the suites run, and exports their URLs to itests |
| CR-G3 | Root `tsconfig.json` references and `pnpm-lock.yaml` workspace link for the one new package `adapters/network-policy` |
| CR-G4 | `adapters/persistence/src/migrations.ts`: append-only entries `0400`–`0499` (union at merge) |
| CR-G5 | No new third-party npm dependency. No new image: the registry proxy and the dependency fetcher use the node image already pinned in `scripts/integration/images.mjs`; Grafana is Phase 4's pin; backups use the pinned PostgreSQL image |
| CR-G6 | `.github/workflows/**`: none expected; a `timeout-minutes` raise only if measured |
| CR-G7 | Package `index.ts` export lines (application, policy, observability, persistence) append-only (R10) |
| CR-G8 | ADR numbers from the controller (R11 pattern): "Progressive brownfield autonomy enforced at submission" and "Harness releases as pinned worker pools with guardrail rollback" |

### 19.6 Phase 2 code (owner chosen by the controller)

| CR | Change |
|---|---|
| CR-X1 | **Scope conformance before verification.** After the agent exits and before verification, every changed path in the trusted inspection must match the work order's `allowedPaths` under Git pathspec semantics (computed by Git, e.g. comparing `git status --porcelain` with and without the pathspecs); otherwise the attempt stops as `policy-violation` with `scopeViolation: true`, before any verification or commit. A test where the agent edits a file outside `allowedPaths` that makes verification pass must end FAILED. Phase 6 S3 depends on it (§1.4 item 1) |

### 19.7 Phase 5

None filed: no Phase 5 plan exists on its branch (§23). Phase 6 only reads Phase 5's ports.

## 20. New logical contracts (D-1)

Full field lists are in `phase-06-data-model.md` §2. All are JSON Schema draft 2020-12 with `additionalProperties:
false` at every level, every string constrained by `pattern`, `enum` or `format`, and valid and invalid fixtures.

## 21. Migrations 0400–0499

| Id | Lane | Content |
|---|---|---|
| `0400_incidents` | phase-06 | `incidents`, `incident_scopes`, `incident_actions` |
| `0410_brownfield_baselines` | h2 | `onboarding_runs`, `baseline_command_runs`, `baseline_classifications` |
| `0411_readiness_autonomy` | h2 | `readiness_reports`, `human_attestations`, `autonomy_map_versions`, `task_autonomy_decisions` |
| `0430_retention` | h3 | `retention_holds`, `retention_sweeps`, `artifact_purges` |
| `0431_credential_kill_switches` | h3 | `credential_kill_switches` |
| `0450_harness_releases` | h4 | `harness_releases`, `release_transitions`, `task_release_assignments`, `release_guardrail_evaluations` |
| `0451_slo_evaluations` | h4 | `slo_evaluations`, `invariant_violations` |
| `0490_roles_row_security` | h3 | grants, forced row security, `reader_role_scopes`, `table_access_classes` |

Rules: append-only, checksummed, ascending application with gaps allowed (Phase 2 migrator; Phase 3 data model §2);
`ALTER`/`CREATE` only; no edit of any earlier migration; a lower id applied after a higher one must still converge
(Phase 3 exit A5 pattern), and the S8 upgrade-path itest proves it for Phase 6. `0490` must be the last Phase 6
migration applied in a fresh database; a later table-adding migration carries its own row security, which the catalog
test enforces.

## 22. Directory ownership

Each lane owns exactly these new paths. They overlap with no Lane A, Lane B or Phase 2 path as listed in their plans
(Phase 3 plan §31, Phase 4 plan §20); carve-outs inside other lanes' directories are CRs (§19.3 CR-L4, §19.4 CR-B1).

```text
phase-06 (lead)
  packages/contracts/schema/{harness-release,brownfield-baseline,readiness-report,autonomy-map}.schema.json
  packages/contracts/fixtures/{valid,invalid}/ entries for those four   (S0; later changes via the compat gate)
  packages/application/src/hardening/**                (submission composer, default policy, incidents)
  packages/application/src/importers/spec-kit/**        (optional S18)
  adapters/persistence/src/incidents/**
  adapters/temporal/src/operations/history-exporter.ts (+ test)          (carve-out, CR-L4)
  apps/control-plane-api/src/hardening-root.ts, hardening-root.test.ts
  apps/control-plane-api/src/hardening/**               (incident routes and CLI, drills, backup/restore itest)
  deploy/pilot/**
  docs/implementation/phases/phase-06-*
  docs/operations/production-pilot-runbook.md; edits to docs/operations/{incident-response,slo-and-alerting,
    release-management,multi-tenancy}.md and docs/engineering/brownfield-onboarding.md
  docs/architecture/adr/<numbers from the controller>-*.md

phase-06-h2 (brownfield and autonomy)
  packages/application/src/brownfield/**
  packages/policy/src/{readiness-scoring,autonomy-policy}.ts (+ tests)
  policies/{readiness-scoring,autonomy-policy,onboarding-policy}.yaml
  adapters/persistence/src/brownfield/**
  apps/control-plane-api/src/brownfield/**
  adapters/temporal/src/workflows/onboarding/**                           (carve-out, CR-L4)

phase-06-h3 (policy boundaries)
  adapters/network-policy/**                                              (new package)
  packages/policy/src/{network-policy,credential-policy,retention-policy}.ts (+ tests)
  policies/{network-policy,credential-policy,retention-policy}.yaml
  packages/application/src/{credentials,retention}/**
  adapters/persistence/src/{tenancy,retention}/**
  apps/control-plane-api/src/security/**

phase-06-h4 (release and SLO)
  packages/application/src/{release,operations}/**
  packages/observability/src/slo/**
  packages/policy/src/release-policy.ts (+ test); policies/release-policy.yaml
  docs/platform/slo-catalog.yaml
  adapters/persistence/src/{release,operations}/**
  apps/control-plane-api/src/{release,operations}/**
  adapters/temporal/src/workflows/operations/**                           (carve-out, CR-L4)
  deploy/grafana/provisioning/{dashboards/slo,alerting}/**, one dashboard-provider file   (carve-out, CR-B1)
```

Existing modules Phase 6 touches are only the CRs of §19. Within Phase 6, `hardening-root.ts` is the lead's; each
sub-lane exports a factory from its own directory and the lead wires them in S15.

## 23. Phase 5 boundary

No Phase 5 plan is on `phase/05-skill-context-platform` (`git ls-tree` at `f613c7f`, checked in this step). Until it
exists, the boundary is stated by assumption and re-checked before the plan locks:

- Phase 5 owns the repository index (lexical, AST, LSP, dependency and test maps), the signed skill registry and
  ContextPack provenance (`90-day-plan.md:42-49`). Phase 6 builds no index of its own.
- Phase 6 reads the index's test map for the "test strength" readiness checks (G-P5IDX). Without it those checks are
  `not-evidenced`, which lowers the score and never raises it.
- Phase 6 computes change coupling and revert ratio from trusted `git log` itself. If Phase 5's index provides Git
  history maps, Phase 6 uses them instead; the controller settles it at reconciliation.
- The harness release manifest has an optional `skillRegistrySnapshotId`; it is filled once Phase 5's registry
  exposes snapshot ids.
- Migrations: Phase 5 `0300`–`0399`, Phase 6 `0400`–`0499`; no shared table.

## 24. Rollback of Phase 6 itself

Per-slice commits on lane branches; `main` is untouched until the controller merges. Migrations are additive; the
documented rollback for each is a forward compensating migration written only when the controller orders it. Runtime
feature-off: bind `AdmitAllSubmissionPolicy`, start pools without a manifest, and leave the operations schedule
unregistered; behaviour is then Phase 3/4 behaviour. Rolling back `0490` needs care: it is the one migration that
changes privileges, and its compensating migration restores owner-only grants and disables row security.

## 25. Exit criteria

`phase-06-exit-criteria.md`: numbered MUSTs mapped to a test file and SUITE-ID, a separate list of operating evidence
OP1–OP6 with the smallest real evidence and its duration, and the verdict vocabulary.

## 26. Assumptions and blocking questions

Nothing blocks the plan. Decisions the user owns, asked without stopping work (R58 process lesson):

1. **Observation window for OP2:** 7 days (recommended) or the 3-day floor.
2. **Retention periods** (§9.2): the proposed defaults are compliance choices.
3. **Brownfield target for OP5:** which real repository. Options: seed `xingcorp/asep-pilot` with a pinned snapshot
   of a license-compatible legacy project with tests (the App is installed only there, R56), or install the App on
   another repository. Read-only onboarding of a private repository needs the App installed on it.
4. **Alert contact point** on the pilot (email, chat, other): an external service publishes alert payloads; they
   carry ids only (threat T6-16).
5. **CR-X1 owner** (§19.6), and whether §1.4 item 1 needs a Phase 2 follow-up.

## Output

```text
PLAN_STATUS: DRAFT v1 (plan only; awaiting the controller's Codex plan review)
BASE_SHA: f613c7f
SCOPE: 90-day plan Days 76–90; exit "production pilot has rollback, incident runbook and SLO dashboards"
MUSTS: 30 code MUSTs (A1–A4, B1–B3, C1–C3, D1–D3, E1–E3, F1–F4, G1–G5, H1–H3, I1–I4) + operating evidence OP1–OP6
SLICES: S0–S17 (+ S18 optional) across 4 proposed lanes (§18)
MIGRATIONS: 0400, 0410, 0411, 0430, 0431, 0450, 0451, 0490
NEW_CONTRACTS: harness-release/v1, brownfield-baseline/v1, readiness-report/v1, autonomy-map/v1 (+ Lane A's
  task-workflow-input 1.1.0 by CR-L2)
NEW_THIRD_PARTY_DEPENDENCIES: none; NEW_IMAGES: none
OPTIONAL: Spec Kit importer (S18); OpenHands deferred
REPORTED_TO_CONTROLLER: verification may run on edits outside allowedPaths that the commit leaves out (§1.4, CR-X1;
  read, not reproduced); MinIO archived; OTel metrics exported to debug only
```
