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

// ---------------------------------------------------------------------------
// 0008 — composite FK for repository_binding_id on tasks + attempts (C2b).
//
// Disp. P2-FINAL-HIGH-005: 0002 gave tasks/attempts a composite FK onto their
// *parent* (run/task) but left `repository_binding_id` as a bare column — a
// task or attempt could name a binding that belongs to a DIFFERENT project than
// the row's own (organization_id, project_id). We add the missing composite FKs
// so the DB enforces "the binding I point at is in MY tenant scope", not a
// row-filter in application code. Append-only: 0002's text is unchanged (its
// recorded checksum stays valid); this migration ALTERs the shipped tables.
// ---------------------------------------------------------------------------
const M0008 = `
alter table tasks
  add constraint tasks_binding_scoped_fk
  foreign key (repository_binding_id, organization_id, project_id)
  references repository_bindings (id, organization_id, project_id);

alter table attempts
  add constraint attempts_binding_scoped_fk
  foreign key (repository_binding_id, organization_id, project_id)
  references repository_bindings (id, organization_id, project_id);
`;

// ---------------------------------------------------------------------------
// 0009 — scoped evidence-artifact FK + expected checksum on attempts +
// pull_requests (C2b/D6, disp. P2-FINAL-HIGH-005).
//
// 0002/0006 carried `evidence_bundle_ref jsonb` — an unconstrained blob that
// could name any artifact id (or none), in any scope, with no expected
// checksum. An authoritative evidence link must be a SCOPED artifact reference:
// the artifact row it points at has to exist AND sit in the SAME tenant scope,
// and the link must pin the expected sha256 so a swapped-bytes artifact is
// detectable. We drop the JSONB (it has no writer yet — safe) and add:
//   - evidence_artifact_id char(26) — composite FK (id, org, project) → artifacts
//   - evidence_sha256      text     — the expected content hash of that artifact
// The composite FK makes "the evidence I attach is in MY scope" a DB invariant.
// Append-only: earlier migrations' text is unchanged (checksums stay valid).
// ---------------------------------------------------------------------------
const M0009 = `
alter table attempts drop column evidence_bundle_ref;
alter table attempts add column evidence_artifact_id char(26);
alter table attempts add column evidence_sha256 text;
alter table attempts
  add constraint attempts_evidence_scoped_fk
  foreign key (evidence_artifact_id, organization_id, project_id)
  references artifacts (id, organization_id, project_id);

alter table pull_requests drop column evidence_bundle_ref;
alter table pull_requests add column evidence_artifact_id char(26);
alter table pull_requests add column evidence_sha256 text;
alter table pull_requests
  add constraint pull_requests_evidence_scoped_fk
  foreign key (evidence_artifact_id, organization_id, project_id)
  references artifacts (id, organization_id, project_id);
`;

// ---------------------------------------------------------------------------
// 0010 — human_authorizations: the AUTHORITATIVE record of a signed human
// review handoff (disp. P2-FINAL-HIGH-009, risk PR2-08).
//
// The pilot manifest declared `humanDisposition` per task and nothing anywhere
// persisted a human decision, so the COMPLETE gate had no truth to check the
// claim against — a fabricated manifest could assert ten reviewed tasks. This
// table is that truth: one row per (task) carrying WHO decided, WHAT they
// decided, and a detached cryptographic signature over the exact decision
// payload. The verifier resolves the manifest against this table and verifies
// the signature with the reviewer public key, so a disposition cannot be
// self-declared and a row cannot be forged by whoever can write the DB.
//
// Scoping mirrors the rest of the model: composite FKs onto (id, org, project)
// for task and attempt, so an authorization can never reference another
// tenant's task. `signature` is a base64 ed25519 signature over the canonical
// payload (see scripts/pilot/human-authorization-crypto.mjs) — it is NOT a
// secret, it is public verification material.
// ---------------------------------------------------------------------------
const M0010 = `
create table human_authorizations (
  id                  char(26) primary key,
  organization_id     char(26) not null,
  project_id          char(26) not null,
  task_id             char(26) not null,
  attempt_id          char(26) not null,
  pull_request_id     char(26) not null,
  disposition         text not null check (disposition in
    ('ACCEPTED','REJECTED','CHANGES_REQUESTED','PENDING')),
  reviewed_result_sha text not null,
  signed_by           text not null,
  signature           text not null,
  signed_at           timestamptz not null default now(),
  foreign key (task_id, organization_id, project_id)
    references tasks (id, organization_id, project_id),
  foreign key (attempt_id, organization_id, project_id)
    references attempts (id, organization_id, project_id),
  unique (organization_id, project_id, task_id)
);
`;

// ---------------------------------------------------------------------------
// 0011 — hierarchy binding coherence (disp. P2-FINAL-HIGH-005).
//
// 0008 made a task/attempt's `repository_binding_id` point at a binding in the
// SAME tenant scope, but NOT necessarily the same binding as its parent: within
// one project a task could name binding X while its run named binding Y, and an
// attempt could diverge from its task. The whole chain must resolve to exactly
// ONE binding. We add a composite unique key carrying the binding on each parent
// and a composite FK from the child that includes `repository_binding_id`, so
// "my binding equals my parent's binding" is a DB invariant, not a row filter.
// Append-only: earlier migrations' text is unchanged (their checksums stay
// valid); this ALTERs the shipped tables.
// ---------------------------------------------------------------------------
const M0011 = `
alter table runs
  add constraint runs_id_scope_binding_uq
  unique (id, organization_id, project_id, repository_binding_id);

alter table tasks
  add constraint tasks_run_binding_coherent_fk
  foreign key (run_id, organization_id, project_id, repository_binding_id)
  references runs (id, organization_id, project_id, repository_binding_id);

alter table tasks
  add constraint tasks_id_scope_binding_uq
  unique (id, organization_id, project_id, repository_binding_id);

alter table attempts
  add constraint attempts_task_binding_coherent_fk
  foreign key (task_id, organization_id, project_id, repository_binding_id)
  references tasks (id, organization_id, project_id, repository_binding_id);
`;

// ---------------------------------------------------------------------------
// 0012 — side-effect records reference their repository binding by a SCOPED FK
// (disp. P2-REREVIEW HIGH-005, exit C2b).
//
// 0007 stored the effect's target as `scope text` — a bare string that happened
// to hold a repository_binding_id with nothing enforcing that it names a real
// binding, let alone one inside the row's own (organization_id, project_id). A
// crash-recovery record that points at another tenant's binding, or at a binding
// that no longer exists, is exactly the kind of dangling authority reference the
// composite-FK discipline exists to prevent.
//
// We add a typed, FK-backed column alongside it and backfill from the existing
// text, then constrain. `scope` itself is left in place because the UNIQUE key
// (organization_id, project_id, scope, semantic_key) is load-bearing for the
// two-phase protocol's collision semantics; the new column is what makes the
// reference authoritative. Append-only: earlier migrations are untouched.
// ---------------------------------------------------------------------------
const M0012 = `
alter table side_effect_records
  add column repository_binding_id char(26);

update side_effect_records
  set repository_binding_id = scope
  where repository_binding_id is null;

alter table side_effect_records
  add constraint side_effect_binding_scoped_fk
  foreign key (repository_binding_id, organization_id, project_id)
  references repository_bindings (id, organization_id, project_id);
`;

// ---------------------------------------------------------------------------
// 0013 — side-effect records are DB-coherent and their outcome is a closed
// shape.
//
// After 0012 the binding column existed but was NULLABLE, nothing tied it to the
// legacy `scope` text it duplicated, and both identity and lookups still ran on
// text (`scope`, `semantic_key`). `result_ref` was free JSONB. So the database
// would accept a crash-recovery record with no binding, one whose binding was
// not its attempt's binding, and an outcome of any shape at all.
//
// This migration makes the record's identity typed and coherent:
//   - attempt_id + operation become real columns (backfilled from the old
//     semantic key) and the record is FK-bound to its ATTEMPT, including the
//     attempt's binding, so a record can only name the binding its attempt
//     belongs to;
//   - repository_binding_id becomes NOT NULL;
//   - uniqueness is (organization, project, binding, attempt, operation);
//   - the text columns `scope` and `semantic_key` are dropped (their old unique
//     constraint goes with them), so nothing can key on text any more;
//   - result_ref must be NULL unless COMPLETED, and when COMPLETED must be the
//     exact closed shape for the operation (no extra keys), enforced by a CHECK.
//
// Existing COMPLETED rows written before the `kind` discriminator existed are
// backfilled first; push records gain their outcome from the request
// fingerprint (`push:<branch>@<sha>`), the only place it was recorded. A row
// that still does not fit makes the migration FAIL rather than be waved
// through. Append-only: earlier migrations are untouched.
// ---------------------------------------------------------------------------
const M0013 = `
alter table attempts
  add constraint attempts_id_scope_binding_uq
  unique (id, organization_id, project_id, repository_binding_id);

alter table side_effect_records add column attempt_id char(26);
alter table side_effect_records add column operation text;

update side_effect_records
  set attempt_id = split_part(semantic_key, ':', 1),
      operation  = split_part(semantic_key, ':', 2);

update side_effect_records
  set repository_binding_id = scope
  where repository_binding_id is null;

update side_effect_records
  set result_ref = result_ref || jsonb_build_object('kind', operation)
  where state = 'COMPLETED' and result_ref is not null
    and jsonb_typeof(result_ref) = 'object' and not (result_ref ? 'kind');

update side_effect_records
  set result_ref = jsonb_build_object(
    'kind', 'push',
    'branch', natural_key,
    'commitSha', split_part(request_fingerprint, '@', 2))
  where state = 'COMPLETED' and operation = 'push' and result_ref is null;

alter table side_effect_records
  alter column repository_binding_id set not null,
  alter column attempt_id set not null,
  alter column operation set not null;

alter table side_effect_records
  add constraint side_effect_operation_known
  check (operation in ('commit', 'push', 'pr-upsert'));

alter table side_effect_records
  add constraint side_effect_attempt_binding_fk
  foreign key (attempt_id, organization_id, project_id, repository_binding_id)
  references attempts (id, organization_id, project_id, repository_binding_id);

alter table side_effect_records
  add constraint side_effect_identity_uq
  unique (organization_id, project_id, repository_binding_id, attempt_id, operation);

alter table side_effect_records drop column scope;
alter table side_effect_records drop column semantic_key;

create function asep_side_effect_result_valid(op text, st text, ref jsonb)
returns boolean
language sql
immutable
as $fn$
  select coalesce(
    case
      when st <> 'COMPLETED' then ref is null
      when ref is null or jsonb_typeof(ref) <> 'object' then false
      when op = 'commit' then
        ref - 'kind' - 'commitSha' - 'evidenceId' = '{}'::jsonb
        and ref->>'kind' = 'commit'
        and jsonb_typeof(ref->'commitSha') = 'string'
        and ref->>'commitSha' ~ '^[0-9a-f]{40}$'
        and jsonb_typeof(ref->'evidenceId') = 'string'
        and ref->>'evidenceId' ~ '^[0-9A-HJKMNP-TV-Z]{26}$'
      when op = 'push' then
        ref - 'kind' - 'branch' - 'commitSha' = '{}'::jsonb
        and ref->>'kind' = 'push'
        and jsonb_typeof(ref->'branch') = 'string'
        and length(btrim(ref->>'branch')) > 0
        and jsonb_typeof(ref->'commitSha') = 'string'
        and ref->>'commitSha' ~ '^[0-9a-f]{40}$'
      when op = 'pr-upsert' then
        ref - 'kind' - 'number' - 'url' - 'headBranch' - 'baseBranch' = '{}'::jsonb
        and ref->>'kind' = 'pr-upsert'
        and jsonb_typeof(ref->'number') = 'number'
        and ref->>'number' ~ '^[1-9][0-9]*$'
        and jsonb_typeof(ref->'url') = 'string'
        and ref->>'url' ~ '^https?://'
        and jsonb_typeof(ref->'headBranch') = 'string'
        and length(btrim(ref->>'headBranch')) > 0
        and jsonb_typeof(ref->'baseBranch') = 'string'
        and length(btrim(ref->>'baseBranch')) > 0
      else false
    end,
    false)
$fn$;

alter table side_effect_records
  add constraint side_effect_result_closed
  check (asep_side_effect_result_valid(operation, state, result_ref));
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
  { id: '0008_binding_scoped_fks', sql: M0008 },
  { id: '0009_scoped_evidence_refs', sql: M0009 },
  { id: '0010_human_authorizations', sql: M0010 },
  { id: '0011_hierarchy_binding_coherence', sql: M0011 },
  { id: '0012_side_effect_binding_fk', sql: M0012 },
  { id: '0013_side_effect_records_closed', sql: M0013 },
]);
