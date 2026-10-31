# Phase 6 — Brownfield and Production Hardening — Data Model (DRAFT v1)

> Companion to `phase-06-plan.md`. PostgreSQL 17 (the digest-pinned image of `scripts/integration/images.mjs`).
> Base `f613c7f`. Migration range **`0400`–`0499`** (lane contract addendum R58), split by lane in plan §21.
> Conventions are Phase 2's (`phase-02-data-model.md` §1) and Phase 3's (`phase-03-data-model.md` header): `char(26)`
> ULID keys, `timestamptz` UTC, a `version` column on mutable rows, composite FKs onto `(id, organization_id,
> project_id)`, scoped artifact references as `<name>_artifact_id` + `<name>_sha256` + generated `<name>_kind` bound
> to `artifacts (id, organization_id, project_id, sha256, kind)` and listed in `artifact_reference_columns`
> (migration 0019), and `TenantScope` as the first parameter of every repository method. Append-only tables carry a
> trigger that rejects `UPDATE` and `DELETE` (the `run_events` pattern, Phase 3 data model §3.7).

## 1. What lives where

| Fact | Store | Authority |
|---|---|---|
| Baseline runs, classifications | `baseline_command_runs`, `baseline_classifications` + `brownfield-baseline/v1` artifact | PostgreSQL rows; the artifact is their canonical export |
| Readiness evidence and score | `readiness_reports` + `readiness-report/v1` artifact; `human_attestations` | PostgreSQL |
| Module autonomy | `autonomy_map_versions` (append-only) + `autonomy-map/v1` artifact per version | PostgreSQL; the latest version wins |
| Per-task submission decisions | `task_autonomy_decisions`, `task_release_assignments` | PostgreSQL, set once per task |
| Harness releases and their life cycle | `harness_releases` (manifest JSON + sha256), `release_transitions` (append-only) | PostgreSQL |
| SLO state and invariant violations | `slo_evaluations`, `invariant_violations` (append-only) | PostgreSQL; Grafana only reads |
| Incidents | `incidents`, `incident_scopes`, `incident_actions` (append-only) | PostgreSQL |
| Holds, sweeps, purges | `retention_holds`, `retention_sweeps`, `artifact_purges` | PostgreSQL; purged bytes are gone, their hash stays |
| Kill switches | `credential_kill_switches` | PostgreSQL, read on every use |
| Roles, grants, row security | `0490` + `reader_role_scopes`, `table_access_classes` | PostgreSQL catalog |

The composed submission decision is not a row of its own: each half records its decision (`task_autonomy_decisions`,
`task_release_assignments`), the composer's `decisionSha256` is the hash of both, and refusals are audited
(`submission.refused`, architecture §16). Cross-lane foreign keys point only from a higher migration to a lower one
that lands first; where landing order and id order disagree, the reference is checked by the repository instead.

## 2. New logical contracts (JSON Schema draft 2020-12; `additionalProperties: false` at every level)

Every string carries a `pattern`, `enum` or `format`. ULIDs `^[0-9A-HJKMNP-TV-Z]{26}$`; SHA-1 commits `^[0-9a-f]{40}$`;
sha256 `^[0-9a-f]{64}$`; image references `^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$`; `ArtifactRef` is Phase 1's.

### 2.1 `harness-release/v1` (`$id https://asep.dev/schema/harness-release/v1`, 1.0.0)

```text
schemaVersion        "1.0.0"
releaseName          ^[a-z0-9][a-z0-9.-]{0,62}$          informational label
createdAt            date-time
agent                { imageDigest, cliVersion (semver), model (^[a-z0-9][a-z0-9.:-]{2,100}$, a full id, no alias),
                       executable (^/[A-Za-z0-9._/-]{1,200}$) }
egressProxy          { imageDigest }
verification         { imageDigest }
dependencyFetch      { imageDigest, ecosystems: [pnpm | npm] (unique, 1..2) } | null
policies             { verificationMatrixSha256, toolPolicySha256, networkPolicySha256, credentialPolicySha256,
                       reviewPolicySha256 | null, orchestrationPolicySha256 | null }
workerBuildSha       40-hex                               the harness commit the pool runs
reviewerConfigSha256 sha256 | null                        Phase 4 reviewer configuration, when bound
contextPolicySha256  sha256 | null                        Phase 5 context policy, once its context root is bound
skillRegistry        { registry (^[a-z0-9][a-z0-9-]{0,63}$), sequence integer ≥ 1, sourceSha256, trustRootSha256 }
                     | null                               the facts Phase 5's context-provenance/v1 records
```

The release id is `hr-` + the first 16 hex characters of the sha256 of the manifest's canonical bytes (sorted keys, no
insignificant whitespace); `harness_releases` stores the full sha256 and refuses a second manifest with the same
16-character prefix.

### 2.2 `brownfield-baseline/v1` (1.0.0)

```text
schemaVersion, organizationId, projectId, repositoryBindingId (ULIDs), onboardingRunId (ULID)
pinnedSha            40-hex
onboardingPolicySha256  sha256
runsPerCommand       integer 3..10
secretScan           { patternSetSha256: sha256, findings: integer ≥ 0,
                       acknowledgement { by ULID, at date-time } | null }   (findings > 0 needs an acknowledgement)
dependency           { source: none | vendored | registry, ecosystem: pnpm | npm | null, lockfileSha256: sha256 | null }
commands[]           { commandId (^[a-z0-9][a-z0-9._-]{0,62}$), moduleIds[] (^[a-z0-9][a-z0-9-]{0,62}$),
                       level L0..L9, category (evidence-bundle check category enum),
                       runs[] { index 1..10, materialization { outcome: materialized | skipped | failed,
                                stdout ArtifactRef | null, stderr ArtifactRef | null, egressLog ArtifactRef | null },
                                exitCode integer | null, signal ^[A-Z0-9]{2,12}$ | null, timedOut boolean,
                                durationMs integer ≥ 0, stdout ArtifactRef, stderr ArtifactRef,
                                profileId: verification-no-network },
                       classification: stable-pass | known-failing | flaky | infrastructure-error }
createdAt            date-time (workflow time; retry-identical bytes)
```

### 2.3 `readiness-report/v1` (1.0.0)

```text
schemaVersion, organizationId, projectId, repositoryBindingId, onboardingRunId, pinnedSha
baselineRef          ArtifactRef (kind brownfield-baseline)
scoringPolicySha256, evaluatorVersion (^[0-9]+\.[0-9]+\.[0-9]+$)
modules[]            { moduleId, paths[] (Git pathspecs, ^[^\s:][^\n]{0,200}$), total 0..100 (number, 2 decimals),
                       band: read-only | draft | agent-pr | above-harness-ceiling,
                       recommendedLevel: L0 | L1 | L2, ceilingNote: harness-has-no-auto-merge | null,
                       measuredPoints 0..100, attestedPoints 0..100,
                       dimensions[10] { dimension (enum of the ten), weight 0..10, score 0..10,
                         checks[] { checkId, outcome: pass | fail | not-evidenced | attested, points 0..10,
                                    evidence[] (ArtifactRef | { attestationId ULID }) } } }
createdAt            date-time
```

### 2.4 `autonomy-map/v1` (1.0.0)

```text
schemaVersion, organizationId, projectId, repositoryBindingId
version              integer ≥ 1;  supersedesVersion integer ≥ 1 | null (null only for version 1)
modules[]            { moduleId, paths[] (pathspecs), testPaths[] (pathspecs), owner (^[A-Za-z0-9@/._-]{1,100}$),
                       level: L0 | L1 | L2 }
unmappedPathLevel    const L0
decision             { kind: initial | promotion | demotion,
                       readinessReportRef ArtifactRef | null      (required for promotion),
                       decidedBy ULID, decidedByClass: human | harness,
                       reason: onboarding-complete | readiness-reviewed | false-completion | policy-violation |
                               scope-violation | operator-request,
                       triggeringEventId (^[A-Za-z0-9:._-]{1,200}$) | null }
createdAt            date-time
```

Schema-level rules (a `oneOf`/`if-then` in the schema and the loader): `promotion` needs `decidedByClass: human` and a
readiness report; `demotion` by `harness` needs a triggering event id; no module's level rises in a `demotion`; no
module's level falls in a `promotion`.

### 2.5 `task-workflow-input/v1` 1.0.0 → 1.1.0 (Lane A's schema, CR-L2)

Two optional fields: `harnessReleaseId` (`^hr-[0-9a-f]{16}$`) and `activityTaskQueue`
(`^asep-activities(-[0-9a-f]{16})?$`). Absent means the default queue; behaviour is unchanged.

## 3. Tables

### 3.1 `0400_incidents` (lead)

```sql
create table incidents (
  id            char(26) primary key,
  severity      text not null check (severity in ('S1','S2','S3','S4')),
  status        text not null check (status in ('OPEN','CONTAINED','RESOLVED')),
  trigger_kind  text not null check (trigger_kind in ('alert','manual','drill')),
  trigger_ref   text check (trigger_ref ~ '^[A-Za-z0-9:._-]{1,200}$'),   -- alert rule uid or null
  opened_by     char(26) not null,                                      -- human principal id
  opened_at     timestamptz not null,
  contained_at  timestamptz,
  resolved_at   timestamptz,
  window_start  timestamptz not null,
  window_end    timestamptz not null check (window_end >= window_start),
  release_id    text check (release_id ~ '^hr-[0-9a-f]{16}$'),          -- scope by release, optional
  version       integer not null default 0,
  constraint incidents_order_ck check (
    (status = 'OPEN') or (status = 'CONTAINED' and contained_at is not null)
    or (status = 'RESOLVED' and resolved_at is not null))
);
create table incident_scopes (
  incident_id      char(26) not null references incidents (id),
  organization_id  char(26) not null,
  project_id       char(26) not null,
  scope_report_artifact_id char(26), scope_report_sha256 text,
  scope_report_kind text generated always as ('incident-scope-report') stored,
  primary key (incident_id, organization_id, project_id),
  constraint incident_scopes_project_fk foreign key (project_id, organization_id) references projects (id, organization_id),
  constraint incident_scopes_report_fk foreign key
    (scope_report_artifact_id, organization_id, project_id, scope_report_sha256, scope_report_kind)
    references artifacts (id, organization_id, project_id, sha256, kind),
  constraint incident_scopes_report_pair_ck check ((scope_report_artifact_id is null) = (scope_report_sha256 is null))
);
create table incident_actions (                         -- append-only
  id            char(26) primary key,
  incident_id   char(26) not null references incidents (id),
  action        text not null check (action in ('open','hold','export-history','pause','cancel','rollback-release',
                                                'engage-kill-switch','reap','contain','resolve','note')),
  actor         char(26) not null,
  actor_class   text not null check (actor_class in ('human','harness')),
  occurred_at   timestamptz not null,
  result        text not null check (result in ('applied','already-applied','failed')),
  detail        jsonb not null                          -- ids and counts only; validated by the repository
);
```

`incidents` is a platform table (no `organization_id`); its tenant facts live in `incident_scopes`. `resolve` needs a
human actor (repository check and trigger).

### 3.2 `0410_brownfield_baselines` (h2)

```sql
create table onboarding_runs (
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null, repository_binding_id char(26) not null,
  pinned_sha text not null check (pinned_sha ~ '^[0-9a-f]{40}$'),
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  runs_per_command integer not null check (runs_per_command between 3 and 10),
  status text not null check (status in ('REGISTERED','SCAN_BLOCKED','RUNNING','CLASSIFIED','SCORED','FAILED')),
  secret_pattern_set_sha256 text check (secret_pattern_set_sha256 ~ '^[0-9a-f]{64}$'),
  secret_findings integer check (secret_findings >= 0),
  secrets_acknowledged_by char(26), secrets_acknowledged_at timestamptz,
  workflow_id text check (workflow_id ~ '^asep-onboarding-[0-9A-HJKMNP-TV-Z]{26}$'),
  baseline_artifact_id char(26), baseline_sha256 text,
  baseline_kind text generated always as ('brownfield-baseline') stored,
  created_at timestamptz not null, version integer not null default 0,
  constraint onboarding_runs_ack_pair_ck check ((secrets_acknowledged_by is null) = (secrets_acknowledged_at is null)),
  constraint onboarding_runs_scan_gate_ck check (status in ('REGISTERED','SCAN_BLOCKED','FAILED')
    or (secret_findings is not null and (secret_findings = 0 or secrets_acknowledged_by is not null))),
  constraint onboarding_runs_natural_uq unique (repository_binding_id, pinned_sha, policy_sha256),
  constraint onboarding_runs_scope_uq unique (id, organization_id, project_id),
  constraint onboarding_runs_binding_fk foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id),
  constraint onboarding_runs_baseline_fk foreign key
    (baseline_artifact_id, organization_id, project_id, baseline_sha256, baseline_kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
create table onboarding_secret_findings (               -- append-only; never the matched text
  onboarding_run_id char(26) not null, organization_id char(26) not null, project_id char(26) not null,
  path text not null check (length(path) between 1 and 1024),
  blob_sha text not null check (blob_sha ~ '^[0-9a-f]{40}$'),
  pattern_id text not null check (pattern_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  line integer not null check (line >= 1),
  primary key (onboarding_run_id, path, pattern_id, line),
  constraint osf_run_fk foreign key (onboarding_run_id, organization_id, project_id)
    references onboarding_runs (id, organization_id, project_id)
);
create table baseline_command_runs (                    -- append-only
  onboarding_run_id char(26) not null, organization_id char(26) not null, project_id char(26) not null,
  command_id text not null check (command_id ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  run_index integer not null check (run_index between 1 and 10),
  exit_code integer, signal text, timed_out boolean not null, duration_ms integer not null check (duration_ms >= 0),
  stdout_artifact_id char(26) not null, stdout_sha256 text not null,
  stdout_kind text generated always as ('command-stdout') stored,
  stderr_artifact_id char(26) not null, stderr_sha256 text not null,
  stderr_kind text generated always as ('command-stderr') stored,
  materialization text not null check (materialization in ('materialized','skipped','failed')),
  recorded_at timestamptz not null,
  primary key (onboarding_run_id, command_id, run_index),
  constraint bcr_run_fk foreign key (onboarding_run_id, organization_id, project_id)
    references onboarding_runs (id, organization_id, project_id),
  constraint bcr_stdout_fk foreign key (stdout_artifact_id, organization_id, project_id, stdout_sha256, stdout_kind)
    references artifacts (id, organization_id, project_id, sha256, kind),
  constraint bcr_stderr_fk foreign key (stderr_artifact_id, organization_id, project_id, stderr_sha256, stderr_kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
create table baseline_classifications (                 -- append-only, one row per command per run
  onboarding_run_id char(26) not null, organization_id char(26) not null, project_id char(26) not null,
  command_id text not null,
  classification text not null check (classification in ('stable-pass','known-failing','flaky','infrastructure-error')),
  primary key (onboarding_run_id, command_id),
  constraint bc_run_fk foreign key (onboarding_run_id, organization_id, project_id)
    references onboarding_runs (id, organization_id, project_id)
);
```

A trigger refuses a classification row before all `runs_per_command` runs of that command exist, and refuses a
classification that does not follow from the runs (the rule of architecture §5), so the database holds the rule too.
The `stdout`/`stderr` references join `artifact_reference_columns`. `onboarding_runs_scan_gate_ck` makes the secret
stop a database rule: no run reaches `RUNNING` with an unacknowledged finding. Pattern ids are stable names given to
the entries of `scripts/lib/secret-patterns.sh` by the loader; the pattern-set hash covers the file's bytes.

### 3.3 `0411_readiness_autonomy` (h2)

```sql
create table human_attestations (
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null, repository_binding_id char(26) not null,
  module_id text not null, dimension text not null, check_id text not null,
  outcome text not null check (outcome in ('pass','fail')),
  attested_by char(26) not null, attested_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > attested_at),
  rationale text not null check (length(rationale) between 1 and 2000),   -- PostgreSQL only; never in history
  constraint ha_binding_fk foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id)
);
create table readiness_reports (
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null, onboarding_run_id char(26) not null,
  scoring_policy_sha256 text not null, evaluator_version text not null,
  report_artifact_id char(26) not null, report_sha256 text not null,
  report_kind text generated always as ('readiness-report') stored,
  created_at timestamptz not null,
  constraint rr_natural_uq unique (onboarding_run_id, scoring_policy_sha256, evaluator_version),
  constraint rr_scope_uq unique (id, organization_id, project_id),
  constraint rr_run_fk foreign key (onboarding_run_id, organization_id, project_id)
    references onboarding_runs (id, organization_id, project_id),
  constraint rr_artifact_fk foreign key (report_artifact_id, organization_id, project_id, report_sha256, report_kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
create table autonomy_map_versions (                    -- append-only
  organization_id char(26) not null, project_id char(26) not null, repository_binding_id char(26) not null,
  version integer not null check (version >= 1),
  map_artifact_id char(26) not null, map_sha256 text not null,
  map_kind text generated always as ('autonomy-map') stored,
  decision_kind text not null check (decision_kind in ('initial','promotion','demotion')),
  decided_by char(26) not null, decided_by_class text not null check (decided_by_class in ('human','harness')),
  readiness_report_id char(26),
  triggering_event_id text,
  created_at timestamptz not null,
  primary key (repository_binding_id, version),
  constraint amv_promotion_ck check (decision_kind <> 'promotion'
    or (decided_by_class = 'human' and readiness_report_id is not null)),
  constraint amv_demotion_ck check (decision_kind <> 'demotion' or decided_by_class = 'human'
    or triggering_event_id is not null),
  constraint amv_binding_fk foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id),
  constraint amv_report_fk foreign key (readiness_report_id, organization_id, project_id)
    references readiness_reports (id, organization_id, project_id),
  constraint amv_artifact_fk foreign key (map_artifact_id, organization_id, project_id, map_sha256, map_kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
create table task_autonomy_decisions (                  -- set once per task
  task_id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null,
  verdict text not null check (verdict in ('ADMIT','ADMIT_WITH_PUBLICATION_APPROVAL','REFUSE')),
  refusal text check (refusal in ('module-read-only','baseline-missing','baseline-stale','baseline-insufficient',
                                  'onboarding-incomplete')),
  map_version integer, repository_binding_id char(26) not null,
  module_ids text[] not null,
  tests_only boolean not null,
  onboarding_run_id char(26),                            -- the baseline the plan used, if any
  plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz not null,
  constraint tad_refusal_ck check ((verdict = 'REFUSE') = (refusal is not null)),
  constraint tad_task_fk foreign key (task_id, organization_id, project_id) references tasks (id, organization_id, project_id),
  constraint tad_map_fk foreign key (repository_binding_id, map_version) references autonomy_map_versions (repository_binding_id, version)
);
```

A trigger on `autonomy_map_versions` refuses a version that is not the previous version plus one.

### 3.4 `0430_retention` (h3)

```sql
create table retention_holds (
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null,
  target_kind text not null check (target_kind in ('artifact','attempt','task','run','release-cohort')),
  target_id text not null check (target_id ~ '^[A-Za-z0-9-]{1,40}$'),
  reason text not null check (reason in ('incident','pilot-evidence','legal','review')),
  incident_id char(26),                                  -- no FK: 0430 may land before 0400 (see below)
  placed_by char(26) not null, placed_at timestamptz not null,
  released_by char(26), released_at timestamptz,
  constraint rh_incident_ck check ((reason = 'incident') = (incident_id is not null)),
  constraint rh_release_pair_ck check ((released_by is null) = (released_at is null)),
  constraint rh_project_fk foreign key (project_id, organization_id) references projects (id, organization_id)
);
create table retention_sweeps (
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null,
  policy_sha256 text not null, as_of timestamptz not null,
  mode text not null check (mode in ('dry-run','execute')),
  report_artifact_id char(26) not null, report_sha256 text not null,
  report_kind text generated always as ('retention-sweep-report') stored,
  approved_by char(26), approved_at timestamptz,         -- required for execute
  dry_run_id char(26) references retention_sweeps (id),  -- execute names the dry run it approved
  status text not null check (status in ('REPORTED','APPROVED','EXECUTED','FAILED')),
  constraint rs_execute_ck check (mode <> 'execute' or (approved_by is not null and dry_run_id is not null)),
  constraint rs_report_fk foreign key (report_artifact_id, organization_id, project_id, report_sha256, report_kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
create table artifact_purges (                          -- append-only tombstones
  artifact_id char(26) not null, organization_id char(26) not null, project_id char(26) not null,
  sha256 text not null, kind text not null, size_bytes bigint not null,
  purged_at timestamptz not null, sweep_id char(26) not null references retention_sweeps (id),
  retention_class text not null,
  primary key (artifact_id),
  constraint ap_artifact_fk foreign key (artifact_id, organization_id, project_id, sha256, kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
```

The repository refuses a tombstone for an artifact that is held, referenced by a non-terminal or under-review task, or
not in the approved dry-run report. The artifact row itself is never deleted, so every composite FK of earlier
phases stays valid. `retention_holds.incident_id` has no foreign key because S7 (`0430`) lands before S14 (`0400`)
and a database may hold `0430` without `0400` for a while; the incident use case checks the id when it places a hold,
and records the hold ids in `incident_actions.detail`, so the link is checked from the incident side.

### 3.5 `0431_credential_kill_switches` (h3)

```sql
create table credential_kill_switches (
  id char(26) primary key,
  level text not null check (level in ('platform','organization','project')),
  organization_id char(26), project_id char(26),
  credential_class text not null check (credential_class in ('model-api-key','github-app-private-key',
    'github-installation-token','reviewer-gateway-key','object-store-key','database-role','grafana-admin')),
  engaged_by char(26) not null, engaged_at timestamptz not null,
  released_by char(26), released_at timestamptz,
  constraint cks_scope_ck check ((level = 'platform' and organization_id is null and project_id is null)
    or (level = 'organization' and organization_id is not null and project_id is null)
    or (level = 'project' and organization_id is not null and project_id is not null)),
  constraint cks_release_pair_ck check ((released_by is null) = (released_at is null))
);
create unique index cks_one_engaged on credential_kill_switches
  (level, coalesce(organization_id, ''), coalesce(project_id, ''), credential_class) where released_at is null;
```

### 3.6 `0450_harness_releases` (h4)

```sql
create table harness_releases (
  id text primary key check (id ~ '^hr-[0-9a-f]{16}$'),
  manifest jsonb not null,                               -- harness-release/v1, validated before insert
  manifest_sha256 text not null unique check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('REGISTERED','CANARY','ACTIVE','RETIRED','ROLLED_BACK')),
  canary_rule jsonb,                                     -- { kind: first-n, n } | { kind: percent, percent }; set at CANARY
  registered_by char(26) not null, registered_at timestamptz not null,
  version integer not null default 0,
  constraint hr_id_matches_manifest_ck check (substr(manifest_sha256, 1, 16) = substr(id, 4, 16))
);
create unique index hr_one_active on harness_releases ((true)) where state = 'ACTIVE';
create unique index hr_one_canary on harness_releases ((true)) where state = 'CANARY';
create table release_transitions (                      -- append-only
  id char(26) primary key,
  release_id text not null references harness_releases (id),
  from_state text not null, to_state text not null,
  actor char(26) not null, actor_class text not null check (actor_class in ('human','guardrail')),
  reason text not null check (reason in ('registered','canary-started','promoted','guardrail-breach',
                                         'operator-rollback','superseded')),
  evidence jsonb not null,                               -- ids and counts only
  occurred_at timestamptz not null,
  constraint rt_promotion_ck check (to_state <> 'ACTIVE' or actor_class = 'human'),
  constraint rt_guardrail_ck check (actor_class <> 'guardrail' or to_state = 'ROLLED_BACK')
);
create table task_release_assignments (                 -- set once per task
  task_id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null,
  release_id text not null references harness_releases (id),
  cohort text not null check (cohort in ('active','canary')),
  rule_sha256 text not null check (rule_sha256 ~ '^[0-9a-f]{64}$'),
  assigned_at timestamptz not null,
  constraint tra_task_fk foreign key (task_id, organization_id, project_id) references tasks (id, organization_id, project_id)
);
create table release_guardrail_evaluations (            -- append-only
  id char(26) primary key,
  release_id text not null references harness_releases (id),
  evaluated_at timestamptz not null, window_start timestamptz not null,
  breaches jsonb not null,                               -- [{ guardrail, count, firstEventId }]
  comparison jsonb not null,                             -- per cohort: n, rate, wilson95 lower/upper; reported only
  decision text not null check (decision in ('none','rollback')),
  evaluator_version text not null
);
```

A trigger keeps `harness_releases.state` and the latest `release_transitions` row consistent and refuses transitions
outside the state machine of architecture §12.

### 3.7 `0451_slo_evaluations` (h4)

```sql
create table slo_evaluations (                          -- append-only
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null,
  slo_name text not null check (slo_name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  catalog_version text not null, evaluator_version text not null,
  evaluated_at timestamptz not null,
  windows jsonb not null,                                -- [{ window, good, bad, total, burnRate | null }]
  state text not null check (state in ('ok','ticket','page','unknown')),
  budget_remaining numeric,                              -- null for zero-tolerance and unknown
  null_reason text,
  evaluation_seq bigint not null,
  constraint se_unknown_ck check ((state = 'unknown') = (null_reason is not null)),
  constraint se_seq_uq unique (organization_id, project_id, slo_name, evaluation_seq),
  constraint se_project_fk foreign key (project_id, organization_id) references projects (id, organization_id)
);
create index se_latest on slo_evaluations (organization_id, project_id, slo_name, evaluated_at desc);
create view slo_evaluations_latest as
  select distinct on (organization_id, project_id, slo_name) * from slo_evaluations
   order by organization_id, project_id, slo_name, evaluated_at desc;
create table invariant_violations (                     -- append-only, deduplicated per check and subject
  id char(26) primary key,
  organization_id char(26) not null, project_id char(26) not null,
  check_name text not null check (check_name in ('duplicate-side-effect','untraceable-pull-request','secret-exposure',
    'orphan-workspace','privileged-audit-coverage','unexpected-egress','release-pin-drift','stuck-task',
    'unclassified-artifact-kind')),
  subject_kind text not null, subject_id text not null,
  detected_at timestamptz not null, detail jsonb not null, checker_version text not null,
  constraint iv_dedupe_uq unique (organization_id, project_id, check_name, subject_kind, subject_id),
  constraint iv_project_fk foreign key (project_id, organization_id) references projects (id, organization_id)
);
```

### 3.8 `0490_roles_row_security` (h3, last)

```sql
create table table_access_classes (
  table_name text primary key,
  access_class text not null check (access_class in ('mutable','append-only','reference','platform'))
);
create table reader_role_scopes (
  role_name text not null check (role_name ~ '^asep_reader_[a-z0-9_]{1,40}$'),
  organization_id char(26) not null,
  primary key (role_name, organization_id)
);
-- then, in one DO block over pg_class/pg_attribute: for every table in the public schema with an organization_id column,
-- ENABLE + FORCE ROW LEVEL SECURITY and the three policies of architecture §10; grants per table_access_classes.
-- The block raises (and the migration rolls back) when a role is missing, a tenant table has no access class, or an
-- application role has SUPERUSER or BYPASSRLS.
```

`table_access_classes` is filled by `0490` for every table that exists in a fresh database at that point (Phases 2–6,
including Phase 5's `repository_index_snapshots` and `context_provenance`, both append-only), from a list in the
migration text; the catalog itest compares the list with the catalog in both directions.

## 4. State machines

```text
onboarding run   REGISTERED → RUNNING → CLASSIFIED → SCORED;  REGISTERED → SCAN_BLOCKED → RUNNING (human acknowledgement);
                 any → FAILED (classified reason; re-run = new policy hash)
release          REGISTERED → CANARY → ACTIVE → RETIRED;  CANARY → ROLLED_BACK;  REGISTERED → ACTIVE (first release only, human)
incident         OPEN → CONTAINED → RESOLVED;  OPEN → RESOLVED (human)
retention sweep  REPORTED (dry run) → APPROVED (human) → EXECUTED | FAILED
kill switch      engaged → released (human)
hold             placed → released (human)
autonomy map     version n → n + 1 only (initial | promotion by human | demotion)
```

## 5. Idempotency key catalog

| Write | Key | On replay |
|---|---|---|
| onboarding registration | `(repository_binding_id, pinned_sha, policy_sha256)` | returns the existing run |
| baseline run | `(onboarding_run_id, command_id, run_index)` | identical row is a no-op; a different row is refused |
| classification | `(onboarding_run_id, command_id)` | recomputed from the rows; equal or refused |
| readiness report | `(onboarding_run_id, scoring_policy_sha256, evaluator_version)` | identical bytes adopted |
| autonomy map version | `(repository_binding_id, version)` | identical artifact adopted; different refused |
| submission decisions | `task_id` | the recorded decision is returned |
| release registration | `manifest_sha256` | returns the existing release |
| release transition | `(release_id, from_state, to_state, reason)` within one evaluation | one transition |
| SLO evaluation | `(organization_id, project_id, slo_name, evaluation_seq)` | one row per sequence |
| invariant violation | `(organization_id, project_id, check_name, subject_kind, subject_id)` | first detection kept |
| kill switch | partial unique `cks_one_engaged` | an engaged switch is reported as already engaged |
| purge | `artifact_id` | already purged is a no-op |
| incident action | `(incident_id, action, detail.target)` per call | `already-applied` |

## 6. Retention classes (proposed defaults; user decisions)

| Class | Kinds (initial; the policy file is authoritative) | Retention | Purge method |
|---|---|---|---|
| `evidence-core` | `work-order`, `context-pack`, `context-provenance`, `evidence-bundle`, `evidence-draft`, `verification-provenance`, `git-diff`, `product-spec`, `claude-invocation`, Phase 4's review kinds (named when its lane lands), `brownfield-baseline`, `readiness-report`, `autonomy-map` | 730 days | tombstone + delete bytes |
| `raw-output` | `command-stdout`, `command-stderr`, `claude-event-stream`, `claude-egress-log`, `dependency-egress-log`, `repository-index` (rebuildable from Git at its SHA) | 180 days | tombstone + delete bytes |
| `operations` | `incident-scope-report`, `retention-sweep-report`, exported workflow histories | 730 days | tombstone + delete bytes |
| `default` | any kind not listed | never purged; `unclassified-artifact-kind` ticket | — |
| tables | every tenant table | kept for the pilot; purge deferred (plan §3.3) | — |

Holds override every class. Metric snapshots keep the dictionary's privacy-class retention (`metrics-dictionary.yaml:22-46`)
as a declared value; their deletion is deferred with the table purge.

## 7. Mapping to earlier contracts

- `PlannedCheck` (plan §19.1) is `task-workflow-input/v1` `verification.checks[]` (Phase 3 data model §4.2).
- Baseline runs reuse Phase 2's `command-stdout` and `command-stderr` artifact kinds and the verification sandbox
  profile; a baseline is never an `evidence-bundle` (it proves no change).
- Guardrails read `attempt.declared_complete` (`declaredComplete`, `passedRequiredAssurance`) and `attempt.completed`
  (`failureClass`) from `run_events`. The fields exist since `run-event` 1.1.0
  (`packages/contracts/schema/run-event.schema.json:43-45`); Phase 3's 1.2.0 keeps them. Phase 6 adds no field.
- Artifact kinds named here are the ones the code writes today: `claude-invocation`, `claude-event-stream`,
  `claude-egress-log` (`adapters/agent-claude/src/agent-sandbox.itest.ts:504`), `git-diff`
  (`adapters/git-worktree/src/worktree-manager.ts:231`), `verification-provenance`, and the kinds registered in
  `artifact_reference_columns` (`adapters/persistence/src/migrations.ts:1068-1075`).
- The release manifest's agent fields are the same values Phase 2's pilot verifier pins (`phase-02-pilot-runbook.md`
  §0.2), so the verifier and the pool check compare one set of pins.
