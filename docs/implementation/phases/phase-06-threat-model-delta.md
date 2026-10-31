# Phase 6 — Threat Model Delta (DRAFT v1)

> Delta over `docs/operations/security-threat-model.md`, `phase-02-threat-model-delta.md` and the Phase 3 and 4
> deltas (read through Git on their lane branches). Phase 6 adds brownfield repositories as a new untrusted input, a
> dependency-fetch egress path, policies that decide what an agent may change, harness releases that change what
> runs, retention that deletes bytes, kill switches, an alerting path to a human and backups. Every earlier mitigation
> stays in force. Base `f613c7f`.

## 1. New trust boundaries

```text
[brownfield repository at a pinned SHA]  untrusted content: code, tests, lockfiles, .npmrc, committed credentials
        │ trusted Git reads blobs (no checkout hooks, no repository code at read time)
        ▼
[onboarding activities]  trusted harness code
        │ secret-pattern scan (reads only) ── findings stop the run
        │ fetch container ──internal network──▶ [registry proxy] ──▶ allowlisted registry:443   (new egress path)
        │ verification sandbox, --network none  (repository commands run here and only here)
        ▼
[PostgreSQL: baselines, readiness, autonomy map, releases, SLOs, incidents, holds, tombstones]
        ▲ migrator role (DDL)   ▲ runtime role (no DDL, append-only rows insert-only)   ▲ reader roles (tenant rows)
        │                                                                                │
[control plane + worker pools pinned to one release each]                     [Grafana]──alert──▶ [contact point]
        │ human decisions: promotion, release promotion, sweep approval, kill-switch release, incident resolution
        ▼
[operator]  the only principal class that can raise autonomy, promote a release or approve a purge

[backups]  host directory, mode 600: a full copy of the database and the object store
```

## 2. Assets (additions)

Autonomy map versions and promotion decisions; baselines (they decide which commands gate); release manifests and
pool pins; retention policy, holds and tombstones; kill-switch state; SLO evaluations and invariant violations (the
evidence that something went wrong); incident records and their held evidence; role credentials (migrator, runtime,
readers); Grafana admin credential and contact-point configuration; backup files.

## 3. Threats and mitigations (delta)

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T6-01 | **Dependency fetch as an attack path**: a malicious lockfile or `.npmrc` points the package manager at an attacker host, or a package runs install scripts | Fetch container on an internal network whose only route is the registry proxy; `CONNECT` to allowlisted hosts on 443 only; IP literals refused; allowlisted names resolving to loopback, link-local, private or metadata addresses refused; install scripts off; lockfile tarball hosts must be allowlisted; `.npmrc` keys outside an allowlist fail closed; builds that need scripts run later with no network; egress log per run. **Residual:** a malicious package from an allowlisted registry still lands in the tree and runs in the no-network sandbox | D2; invariant `unexpected-egress` (G3) |
| T6-02 | **Baseline poisoning**: a repository makes a gating command pass during onboarding and lose meaning later (for example a test that always exits 0), so the baseline marks it `stable-pass` | Commands are operator-approved, not discovered; the baseline proves stability, not strength, and says so; test strength is a separate readiness dimension with its own evidence; autonomy starts at L0 for every module | B1, C1; review of the approved command list (runbook) |
| T6-03 | **Readiness score gaming**: a repository adds files that tick checks (an empty `CODEOWNERS`, a stub README) | Checks cite evidence and are deterministic, so the gaming is visible in the report; the score only recommends; promotion is a human decision citing the report; the cap at L2 limits what any score can unlock | C1, C3 |
| T6-04 | **Autonomy bypass through scope**: a task names narrow `allowedPaths` to pass admission and the agent edits elsewhere | Admission uses the stored, validated work order; scope conformance before verification (CR-X1) fails any change outside `allowedPaths`; an empty list touches every module; demotion to L0 on a scope violation | B3, C2, C3 |
| T6-05 | **Release tampering**: a worker pool runs code or pins that differ from the release it claims | Manifests are content-addressed; a pool refuses to start on any pin difference; an invariant compares every attempt's recorded pins with its task's release and pages on drift; promotion is human-only | F1, F3, G3 |
| T6-06 | **Canary blast radius**: a bad candidate release harms more tasks than intended | One candidate at a time; deterministic small cohorts; absolute guardrails roll back within one evaluation interval and cancel the cohort's safety-class tasks; nothing the harness does merges code | F2 |
| T6-07 | **Covert channel and reader leakage**: foreign-key and unique checks bypass row security (research register §5); a reader role sees another tenant's rows | Reader roles write nothing, so they cannot probe constraints; row security is forced on every tenant table with a reader policy through `reader_role_scopes`; the catalog test covers every table both ways. **Residual:** the runtime role can still probe constraints across tenants; its isolation stays application-level in Phase 6 (plan §3.3) | E2; risk P6R-06 |
| T6-08 | **Retention deletes evidence**: a sweep purges bytes an incident, a review or an audit still needs | Holds block purges (incident, pilot evidence, legal, review); non-terminal and under-review tasks block purges; execution needs a human approval naming the dry run; tombstones keep id, hash, size and kind; append-only tables are never purged in Phase 6 | E3 |
| T6-09 | **Retention silently fails**: bytes outlive their period, or an unknown kind is kept forever without notice | Unknown kinds are kept and raise the `unclassified-artifact-kind` ticket; sweeps write a report artifact per run; a failed sweep is a recorded state | E3, G3 |
| T6-10 | **Kill-switch abuse or failure**: a switch is released by the wrong principal, or does not stop a credential in use | Engage needs `credentials:kill`; release needs a human; while engaged the model-credential and forge decorators refuse and in-scope egress proxies are reaped. **Residual:** an installation token already minted stays valid until it expires (1 hour, research register §11); the runbook says so | D3, H3 |
| T6-11 | **Alerting silenced**: evaluations stop, Grafana stops, or a rule is edited away | Deadman on stale evaluations; alert rules are file-provisioned and cannot be edited in the UI (research register §6); the runbook-coverage test ties every rule to a runbook section. **Residual:** a host outage stops the deadman too (single host, P6R-13) | G4, G5, H1 |
| T6-12 | **Leaks through new surfaces**: credentials reach baseline outputs, readiness reports, incident exports, egress logs or alert payloads | The leak suite plants a canary per credential class and searches every stored and logged surface, including the new ones; egress logs hold host, port, decision and bytes only; alert payloads carry ids only | D3 |
| T6-13 | **Incident export leaks**: exported workflow histories or scope reports reach someone outside the tenant | Exports are artifacts under the tenant's prefix, held, and readable through the scoped store only; histories are refs-only (Phase 3); scope reports list ids and counts | H2, D3 |
| T6-14 | **Backups as a copy of everything**: a backup file is read by someone who has no database access | Backups are written to a host directory with mode 600 files; the runbook names who may hold them; they are never copied off-host by the harness. **Residual:** backups are not encrypted by the harness in Phase 6 | F4; runbook |
| T6-15 | **Grafana admin or anonymous access** exposes dashboards across tenants or lets alert rules be changed | Grafana listens on 127.0.0.1; anonymous access off; the admin password is a file secret; data sources connect as reader roles after `0490`; provisioned rules are read-only in the UI. **Residual:** no SSO (plan §3.3) | G4; deployment recipe review |
| T6-16 | **Alert payloads published externally**: the contact point is an external service, so alert text leaves the host | Annotations and labels carry SLO name, state, counts and ids only; no repository content, paths, prompts or credentials; the contact point is a user decision (plan §26) | G4 |
| T6-17 | **Spec Kit content as prompt injection** (optional importer): imported specs carry instructions aimed at the agent | Imported specs are untrusted text in a draft ProductSpec that a human must approve; the importer runs no Spec Kit command; nothing imported reaches the agent before approval | S18 SHOULD checks only |
| T6-18 | **Credentials committed to a brownfield repository** are copied into baselines, readiness evidence and Phase 5's lexical index | Secret-pattern scan of the pinned tree before anything runs, using the repository's shared pattern list; findings record path, blob, pattern id and line, never the text; the run stops at `SCAN_BLOCKED` and submission refuses until a human acknowledges. **Residual:** the agent still sees the repository it works on, as in Phase 2; the scan finds only known patterns | B4 |

## 4. Non-issues and residuals (documented, not fixed in Phase 6)

- **Runtime-role row security** stays permissive (T6-07; plan §3.3). The runtime role loses DDL, trigger control and
  append-only write rights; tenant isolation for it stays the Phase 2 scoped repositories and composite FKs.
- **Store-enforced object isolation** (per-tenant store credentials, Object Lock) is not claimed (research register
  §9–§10).
- **Temporal frontend authentication** stays open (Phase 3 T3-01).
- **Backups are unencrypted** and single-host (T6-14).
- **Malicious packages from allowlisted registries** are contained by the no-network sandbox, not prevented (T6-01).
- **Already-minted installation tokens** outlive a kill switch by up to an hour (T6-10).

## 5. Residual risk statement

Phase 6 narrows what an agent may change (autonomy at submission, scope conformance, strict baselines), what runs
(pinned releases with guardrail rollback), what the database lets each role do (separated roles, forced row
security for every role except the runtime role) and what leaves the host (registry proxy, ids-only alerts). It does
not make the pilot multi-tenant safe at the store or runtime-session level, and it does not prove any mechanism in
operation; that is the operating evidence OP1–OP6.
