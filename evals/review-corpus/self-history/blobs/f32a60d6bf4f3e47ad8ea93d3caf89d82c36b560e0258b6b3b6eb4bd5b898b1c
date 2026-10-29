// Migration set (data-model §5). Append-only, numbered, checksummed. Each entry
// is a pure SQL string embedded in the bundle (no filesystem read at runtime, so
// the checksum covers exactly what ships). The runner (./migrator.ts) applies
// them in order under an advisory lock, records a sha256 checksum per applied
// id, and fails closed if an already-applied migration's text changes.
//
// PostgreSQL specifics we lean on for the locked guarantees:
//   - composite UNIQUE (id, organization_id, project_id) on every parent, with
//     children composite-FK onto it → hierarchy consistency is DB-enforced
//     (C2b), not a row filter;
//   - partial UNIQUE index `where state = 'ACTIVE'` → one active writer per
//     (repository_binding_id, branch) (C3);
//   - `version int` optimistic-concurrency column on every mutable aggregate (C4).

export interface Migration {
  readonly id: string; // zero-padded, lexicographically ordered (0001_…)
  readonly sql: string;
}

// ---------------------------------------------------------------------------
// 0001 — tenancy: organizations, projects, repository_bindings.
// ---------------------------------------------------------------------------
const M0001 = `
create table organizations (
  id          char(26) primary key,
  name        text not null,
  created_at  timestamptz not null default now(),
  version     integer not null default 0
);

create table projects (
  id              char(26) primary key,
  organization_id char(26) not null references organizations(id),
  name            text not null,
  default_branch  text not null,
  created_at      timestamptz not null default now(),
  version         integer not null default 0,
  unique (organization_id, name),
  unique (id, organization_id)
);

create table repository_bindings (
  id                     char(26) primary key,
  organization_id        char(26) not null,
  project_id             char(26) not null,
  forge                  text not null check (forge in ('github')),
  github_host            text not null,
  github_owner           text not null,
  github_repo            text not null,
  github_installation_id bigint,
  github_repository_id    bigint,
  default_base_branch    text not null,
  created_at             timestamptz not null default now(),
  version                integer not null default 0,
  foreign key (project_id, organization_id)
    references projects (id, organization_id),
  unique (project_id, github_host, github_owner, github_repo),
  unique (id, organization_id, project_id)
);
`;

// ---------------------------------------------------------------------------
// 0002 — runs, tasks, attempts + state check constraints.
// ---------------------------------------------------------------------------
const M0002 = `
create table runs (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  status                text not null,
  product_spec_ref      jsonb,
  risk                  text not null check (risk in ('R0','R1','R2','R3','R4')),
  created_at            timestamptz not null default now(),
  version               integer not null default 0,
  foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id),
  unique (id, organization_id, project_id)
);

create table tasks (
  id                        char(26) primary key,
  organization_id           char(26) not null,
  project_id                char(26) not null,
  run_id                    char(26) not null,
  repository_binding_id     char(26) not null,
  status                    text not null check (status in
    ('PENDING','READY','EXECUTING','VERIFYING','WAITING_FOR_HUMAN_REVIEW','FAILED','BLOCKED','CANCELLED')),
  risk                      text not null check (risk in ('R0','R1','R2','R3','R4')),
  work_order_ref            jsonb,
  work_order_schema_version text,
  base_sha                  text,
  created_at                timestamptz not null default now(),
  version                   integer not null default 0,
  foreign key (run_id, organization_id, project_id)
    references runs (id, organization_id, project_id),
  unique (id, organization_id, project_id)
);

create table attempts (
  id                  char(26) primary key,
  organization_id     char(26) not null,
  project_id          char(26) not null,
  task_id             char(26) not null,
  repository_binding_id char(26) not null,
  status              text not null check (status in
    ('STARTED','AGENT_RUNNING','AGENT_DONE','INSPECTING','VERIFYING','EVIDENCE_BUILT',
     'COMMITTED','PUSHED','PR_OPEN','SUCCEEDED','FAILED','BLOCKED','BUDGET_EXHAUSTED','CANCELLED')),
  base_sha            text,
  result_sha          text,
  agent_provider_id   text,
  agent_model         text,
  context_pack_ref    jsonb,
  evidence_bundle_ref jsonb,
  failure_class       text,
  usage               jsonb,
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  version             integer not null default 0,
  foreign key (task_id, organization_id, project_id)
    references tasks (id, organization_id, project_id),
  unique (id, organization_id, project_id)
);
create index attempts_task_started on attempts (task_id, started_at);
`;

// ---------------------------------------------------------------------------
// 0003 — workspace_leases + one-active-writer partial unique index.
// ---------------------------------------------------------------------------
const M0003 = `
create table workspace_leases (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  branch                text not null,
  attempt_id            char(26) not null,
  workspace_id          text not null,
  state                 text not null check (state in ('ACTIVE','RELEASED','EXPIRED','QUARANTINED')),
  acquired_at           timestamptz not null default now(),
  heartbeat_at          timestamptz not null default now(),
  expires_at            timestamptz not null,
  version               integer not null default 0,
  foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id)
);
create unique index one_active_writer
  on workspace_leases (repository_binding_id, branch)
  where state = 'ACTIVE';
`;

// ---------------------------------------------------------------------------
// 0004 — artifacts + tenant-scoped sha256 unique.
// ---------------------------------------------------------------------------
const M0004 = `
create table artifacts (
  id              char(26) primary key,
  organization_id char(26) not null,
  project_id      char(26) not null,
  attempt_id      char(26),
  kind            text not null,
  sha256          text not null,
  size_bytes      bigint not null,
  storage_key     text not null,
  content_type    text not null,
  created_at      timestamptz not null default now(),
  foreign key (attempt_id, organization_id, project_id)
    references attempts (id, organization_id, project_id),
  unique (organization_id, project_id, sha256, kind),
  unique (id, organization_id, project_id)
);
`;

// ---------------------------------------------------------------------------
// 0005 — command_executions.
// ---------------------------------------------------------------------------
const M0005 = `
create table command_executions (
  id                  char(26) primary key,
  organization_id     char(26) not null,
  project_id          char(26) not null,
  attempt_id          char(26) not null,
  command_id          text not null,
  executable          text not null,
  args                jsonb not null,
  exit_code           integer,
  signal              text,
  timed_out           boolean not null default false,
  duration_ms         numeric,
  stdout_artifact_id  char(26),
  stderr_artifact_id  char(26),
  environment_profile text not null,
  executable_version  text,
  created_at          timestamptz not null default now(),
  foreign key (attempt_id, organization_id, project_id)
    references attempts (id, organization_id, project_id)
);
`;

// ---------------------------------------------------------------------------
// 0006 — pull_requests + head_branch unique (idempotent upsert).
// ---------------------------------------------------------------------------
const M0006 = `
create table pull_requests (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  attempt_id            char(26) not null,
  forge                 text not null,
  number                integer,
  head_branch           text not null,
  base_branch           text not null,
  url                   text,
  state                 text not null,
  evidence_bundle_ref   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 0,
  foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id),
  foreign key (attempt_id, organization_id, project_id)
    references attempts (id, organization_id, project_id),
  unique (repository_binding_id, head_branch)
);
`;

// ---------------------------------------------------------------------------
// 0007 — audit_events + side_effect_records (crash-safe side-effect protocol).
// ---------------------------------------------------------------------------
const M0007 = `
create table audit_events (
  id              char(26) primary key,
  organization_id char(26) not null,
  project_id      char(26) not null,
  run_id          char(26),
  task_id         char(26),
  attempt_id      char(26),
  actor           text not null,
  action          text not null,
  occurred_at     timestamptz not null default now(),
  detail          jsonb
);

create table side_effect_records (
  id                  char(26) primary key,
  organization_id     char(26) not null,
  project_id          char(26) not null,
  scope               text not null,
  semantic_key        text not null,
  request_fingerprint text not null,
  state               text not null check (state in ('PENDING','COMPLETED','FAILED')),
  owner_token         text,
  result_ref          jsonb,
  natural_key         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 0,
  unique (organization_id, project_id, scope, semantic_key)
);
`;

// Ordered, immutable migration set. Order is by id; the runner asserts it.
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { id: '0001_init_tenancy', sql: M0001 },
  { id: '0002_runs_tasks_attempts', sql: M0002 },
  { id: '0003_workspace_leases', sql: M0003 },
  { id: '0004_artifacts', sql: M0004 },
  { id: '0005_command_executions', sql: M0005 },
  { id: '0006_pull_requests', sql: M0006 },
  { id: '0007_audit_side_effects', sql: M0007 },
]);
