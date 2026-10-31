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

// ---------------------------------------------------------------------------
// 0014 — fenced lease takeover.
//
// A side-effect record was owned by a free-text `owner_token`, and finishing it
// required the caller's token to equal that text. When the owning executor
// crashed between begin and complete, its successor held a NEW lease, so it
// could neither finish the PENDING record nor replace its owner: recovery
// wedged. And nothing tied the token to a lease at all, so "the owner" was
// whatever string a caller passed.
//
// This migration makes ownership a lease, and lease succession a total order the
// database maintains:
//   - every lease gets a `fencing_epoch`, strictly increasing per (binding,
//     branch) and unique, plus the `ttl_ms` a heartbeat renews. A lease's epoch
//     never changes, and a lease that left ACTIVE can never return to it;
//   - a record is owned by `owner_lease_id` + `owner_epoch`, FK-bound to a lease
//     of the SAME tenant, binding and attempt with exactly that epoch. The text
//     `owner_token` column is dropped;
//   - a trigger is the last line of the protocol. A record can only be written
//     under a live owner lease; it can only move to a different owner when the
//     old one is no longer live, the new one holds the same branch and its
//     epoch is strictly greater; its identity never changes; and once
//     COMPLETED it is immutable.
//
// Existing records are mapped to the lease their token named. A record whose
// token names no lease of its own attempt has no recoverable owner, and the
// migration fails rather than guess one. Append-only: earlier migrations are
// untouched.
// ---------------------------------------------------------------------------
const M0014 = `
alter table workspace_leases add column fencing_epoch bigint;
alter table workspace_leases add column ttl_ms integer;

update workspace_leases l
  set fencing_epoch = n.epoch
  from (
    select id, row_number() over (
      partition by repository_binding_id, branch order by acquired_at, id) as epoch
    from workspace_leases) n
  where n.id = l.id;

update workspace_leases
  set ttl_ms = greatest(1, (extract(epoch from (expires_at - acquired_at)) * 1000)::integer);

alter table workspace_leases
  alter column fencing_epoch set not null,
  alter column ttl_ms set not null;

alter table workspace_leases
  add constraint workspace_lease_epoch_positive check (fencing_epoch > 0);
alter table workspace_leases
  add constraint workspace_lease_ttl_positive check (ttl_ms > 0);
alter table workspace_leases
  add constraint workspace_lease_epoch_uq unique (repository_binding_id, branch, fencing_epoch);
alter table workspace_leases
  add constraint workspace_lease_owner_uq
  unique (id, organization_id, project_id, repository_binding_id, attempt_id, fencing_epoch);

create function asep_workspace_lease_guard() returns trigger
language plpgsql
as $fn$
begin
  if new.fencing_epoch <> old.fencing_epoch then
    raise exception 'workspace lease % fencing epoch is immutable', old.id
      using errcode = '23514';
  end if;
  if old.state <> 'ACTIVE' and new.state = 'ACTIVE' then
    raise exception 'workspace lease % is % and can never become ACTIVE again', old.id, old.state
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

create trigger workspace_lease_guard
  before update on workspace_leases
  for each row execute function asep_workspace_lease_guard();

alter table side_effect_records add column owner_lease_id char(26);
alter table side_effect_records add column owner_epoch bigint;

update side_effect_records r
  set owner_lease_id = l.id, owner_epoch = l.fencing_epoch
  from workspace_leases l
  where l.id = r.owner_token
    and l.organization_id = r.organization_id
    and l.project_id = r.project_id
    and l.repository_binding_id = r.repository_binding_id
    and l.attempt_id = r.attempt_id;

do $chk$
declare orphans bigint;
begin
  select count(*) into orphans from side_effect_records where owner_lease_id is null;
  if orphans > 0 then
    raise exception 'side_effect_records: % row(s) are owned by a token that is not a lease of their attempt; refusing to guess an owner', orphans;
  end if;
end
$chk$;

alter table side_effect_records
  alter column owner_lease_id set not null,
  alter column owner_epoch set not null;

alter table side_effect_records
  add constraint side_effect_owner_lease_fk
  foreign key (owner_lease_id, organization_id, project_id, repository_binding_id, attempt_id, owner_epoch)
  references workspace_leases (id, organization_id, project_id, repository_binding_id, attempt_id, fencing_epoch);

alter table side_effect_records drop column owner_token;

create function asep_lease_is_live(lease char(26)) returns boolean
language sql
stable
as $fn$
  select exists (
    select 1 from workspace_leases
    where id = lease and state = 'ACTIVE' and expires_at > now())
$fn$;

create function asep_side_effect_guard() returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'INSERT' then
    if not asep_lease_is_live(new.owner_lease_id) then
      raise exception 'side-effect record cannot be created under lease %, which is not live', new.owner_lease_id
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.state = 'COMPLETED' then
    raise exception 'side-effect record % is COMPLETED and immutable', old.id
      using errcode = '23514';
  end if;
  if (new.organization_id, new.project_id, new.repository_binding_id, new.attempt_id,
      new.operation, new.request_fingerprint)
     is distinct from
     (old.organization_id, old.project_id, old.repository_binding_id, old.attempt_id,
      old.operation, old.request_fingerprint) then
    raise exception 'side-effect record % identity is immutable', old.id
      using errcode = '23514';
  end if;
  if new.owner_lease_id <> old.owner_lease_id then
    if asep_lease_is_live(old.owner_lease_id) then
      raise exception 'side-effect record % is owned by live lease %; takeover refused',
        old.id, old.owner_lease_id
        using errcode = '23514';
    end if;
    if (select branch from workspace_leases where id = new.owner_lease_id)
       is distinct from
       (select branch from workspace_leases where id = old.owner_lease_id) then
      raise exception 'side-effect record % can only be taken over by a lease on the same branch', old.id
        using errcode = '23514';
    end if;
    if new.owner_epoch <= old.owner_epoch then
      raise exception 'side-effect record % cannot move from epoch % to epoch %: the new owner must be strictly newer',
        old.id, old.owner_epoch, new.owner_epoch
        using errcode = '23514';
    end if;
  elsif new.owner_epoch <> old.owner_epoch then
    raise exception 'side-effect record % owner epoch is immutable for the same owner', old.id
      using errcode = '23514';
  end if;
  if not asep_lease_is_live(new.owner_lease_id) then
    raise exception 'side-effect record % cannot be written under lease %, which is not live',
      old.id, new.owner_lease_id
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

create trigger side_effect_guard
  before insert or update on side_effect_records
  for each row execute function asep_side_effect_guard();
`;

// ---------------------------------------------------------------------------
// 0015 — a lease belongs to a real attempt.
//
// workspace_leases.attempt_id was free text: a lease could name an attempt that
// never existed, or an attempt of another tenant or another repository
// binding, and every side-effect record owned by that lease (0014) inherited
// the dangling identity. A composite foreign key onto attempts (id,
// organization_id, project_id, repository_binding_id) — the key 0013 added
// for side-effect records — makes the lease's attempt one of its own tenant
// and binding.
//
// A lease that already names no such attempt has no recoverable owner, and the
// migration fails rather than delete or re-point it. Append-only: earlier
// migrations are untouched.
// ---------------------------------------------------------------------------
const M0015 = `
do $chk$
declare orphans bigint;
begin
  select count(*) into orphans
  from workspace_leases l
  where not exists (
    select 1 from attempts a
    where a.id = l.attempt_id
      and a.organization_id = l.organization_id
      and a.project_id = l.project_id
      and a.repository_binding_id = l.repository_binding_id);
  if orphans > 0 then
    raise exception 'workspace_leases: % lease(s) name no attempt of their own tenant and binding; refusing to guess one', orphans;
  end if;
end
$chk$;

alter table workspace_leases
  add constraint workspace_lease_attempt_fk
  foreign key (attempt_id, organization_id, project_id, repository_binding_id)
  references attempts (id, organization_id, project_id, repository_binding_id);
`;

// ---------------------------------------------------------------------------
// 0016 — lease liveness by the database clock at the moment of the decision.
//
// 0014's asep_lease_is_live compared expires_at with now(), which PostgreSQL
// fixes at the start of the transaction. A transaction opened while a lease was
// live therefore went on seeing it live after it expired, and could finish
// that lease's side-effect record after a successor had been granted. The
// check now reads clock_timestamp(), the clock at the statement that asks, and
// takes a share lock on the lease row as the adapter does, so a sweep, release
// or heartbeat of that lease waits for the decision's transaction to end
// rather than change the answer under it. Append-only: 0014 is untouched; this
// replaces the function its trigger calls.
// ---------------------------------------------------------------------------
const M0016 = `
create or replace function asep_lease_is_live(lease char(26)) returns boolean
language plpgsql
volatile
as $fn$
declare
  live boolean;
begin
  select (state = 'ACTIVE' and expires_at > clock_timestamp()) into live
    from workspace_leases
    where id = lease
    for share;
  return coalesce(live, false);
end
$fn$;
`;

// ---------------------------------------------------------------------------
// 0017 — every authoritative reference is DB-coherent.
//
// Two classes of hole remained after 0013–0015:
//   - pull_requests carried attempt_id and repository_binding_id under two
//     independent FKs, so a PR row could name an attempt of one binding and a
//     binding of another;
//   - the run's product spec, the task's work order and the attempt's context
//     pack were free JSONB, and the evidence links of 0009 pinned a checksum
//     the FK did not check: any artifact of the tenant, of any kind, with any
//     claimed sha256, was accepted.
//
// So: a composite FK binds a PR to an attempt OF ITS BINDING; artifacts gain a
// key that carries checksum and kind; and every reference becomes
// `<name>_artifact_id` + `<name>_sha256` (both or neither) plus a generated
// `<name>_kind`, FK-bound to (id, organization, project, sha256, kind). The
// database then refuses another tenant's artifact, the right artifact with the
// wrong checksum, and an artifact of the wrong kind.
//
// Existing JSONB references are carried over when they name such an artifact;
// a row whose reference does not makes the migration FAIL rather than drop it.
// Append-only: earlier migrations are untouched.
// ---------------------------------------------------------------------------
const M0017 = `
do $chk$
declare bad bigint;
begin
  select count(*) into bad from pull_requests p
  where not exists (
    select 1 from attempts a
    where a.id = p.attempt_id and a.organization_id = p.organization_id
      and a.project_id = p.project_id and a.repository_binding_id = p.repository_binding_id);
  if bad > 0 then
    raise exception 'pull_requests: % row(s) name an attempt of another binding; refusing to guess which is right', bad;
  end if;
end
$chk$;
alter table pull_requests
  add constraint pull_requests_attempt_binding_fk
  foreign key (attempt_id, organization_id, project_id, repository_binding_id)
  references attempts (id, organization_id, project_id, repository_binding_id);

alter table artifacts
  add constraint artifacts_scoped_ref_uq unique (id, organization_id, project_id, sha256, kind);

alter table runs add column product_spec_artifact_id char(26);
alter table runs add column product_spec_sha256 text;
update runs
  set product_spec_artifact_id = product_spec_ref->>'artifactId',
      product_spec_sha256 = product_spec_ref->>'sha256'
  where product_spec_ref is not null;
do $chk$
declare bad bigint;
begin
  select count(*) into bad from runs t
  where t.product_spec_ref is not null and not exists (
    select 1 from artifacts a
    where a.id = t.product_spec_artifact_id and a.organization_id = t.organization_id
      and a.project_id = t.project_id and a.sha256 = t.product_spec_sha256 and a.kind = 'product-spec');
  if bad > 0 then
    raise exception 'runs: % product spec reference(s) name no product-spec artifact of their own tenant with that checksum; refusing to drop them', bad;
  end if;
end
$chk$;
alter table runs drop column product_spec_ref;
alter table tasks add column work_order_artifact_id char(26);
alter table tasks add column work_order_sha256 text;
update tasks
  set work_order_artifact_id = work_order_ref->>'artifactId',
      work_order_sha256 = work_order_ref->>'sha256'
  where work_order_ref is not null;
do $chk$
declare bad bigint;
begin
  select count(*) into bad from tasks t
  where t.work_order_ref is not null and not exists (
    select 1 from artifacts a
    where a.id = t.work_order_artifact_id and a.organization_id = t.organization_id
      and a.project_id = t.project_id and a.sha256 = t.work_order_sha256 and a.kind = 'work-order');
  if bad > 0 then
    raise exception 'tasks: % work order reference(s) name no work-order artifact of their own tenant with that checksum; refusing to drop them', bad;
  end if;
end
$chk$;
alter table tasks drop column work_order_ref;
alter table attempts add column context_pack_artifact_id char(26);
alter table attempts add column context_pack_sha256 text;
update attempts
  set context_pack_artifact_id = context_pack_ref->>'artifactId',
      context_pack_sha256 = context_pack_ref->>'sha256'
  where context_pack_ref is not null;
do $chk$
declare bad bigint;
begin
  select count(*) into bad from attempts t
  where t.context_pack_ref is not null and not exists (
    select 1 from artifacts a
    where a.id = t.context_pack_artifact_id and a.organization_id = t.organization_id
      and a.project_id = t.project_id and a.sha256 = t.context_pack_sha256 and a.kind = 'context-pack');
  if bad > 0 then
    raise exception 'attempts: % context pack reference(s) name no context-pack artifact of their own tenant with that checksum; refusing to drop them', bad;
  end if;
end
$chk$;
alter table attempts drop column context_pack_ref;

do $chk$
declare bad bigint;
begin
  select count(*) into bad from attempts t
  where (t.evidence_artifact_id is null) <> (t.evidence_sha256 is null)
     or (t.evidence_artifact_id is not null and not exists (
       select 1 from artifacts a
       where a.id = t.evidence_artifact_id and a.organization_id = t.organization_id
         and a.project_id = t.project_id and a.sha256 = t.evidence_sha256 and a.kind = 'evidence-bundle'));
  if bad > 0 then
    raise exception 'attempts: % evidence reference(s) do not match an evidence bundle of their own tenant with that checksum; refusing to guess', bad;
  end if;
end
$chk$;
alter table attempts drop constraint attempts_evidence_scoped_fk;
do $chk$
declare bad bigint;
begin
  select count(*) into bad from pull_requests t
  where (t.evidence_artifact_id is null) <> (t.evidence_sha256 is null)
     or (t.evidence_artifact_id is not null and not exists (
       select 1 from artifacts a
       where a.id = t.evidence_artifact_id and a.organization_id = t.organization_id
         and a.project_id = t.project_id and a.sha256 = t.evidence_sha256 and a.kind = 'evidence-bundle'));
  if bad > 0 then
    raise exception 'pull_requests: % evidence reference(s) do not match an evidence bundle of their own tenant with that checksum; refusing to guess', bad;
  end if;
end
$chk$;
alter table pull_requests drop constraint pull_requests_evidence_scoped_fk;

alter table runs add column product_spec_kind text
  generated always as (case when product_spec_artifact_id is null then null else 'product-spec' end) stored;
alter table runs add constraint runs_product_spec_ref_paired
  check ((product_spec_artifact_id is null) = (product_spec_sha256 is null));
alter table runs add constraint runs_product_spec_ref_fk
  foreign key (product_spec_artifact_id, organization_id, project_id, product_spec_sha256, product_spec_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
alter table tasks add column work_order_kind text
  generated always as (case when work_order_artifact_id is null then null else 'work-order' end) stored;
alter table tasks add constraint tasks_work_order_ref_paired
  check ((work_order_artifact_id is null) = (work_order_sha256 is null));
alter table tasks add constraint tasks_work_order_ref_fk
  foreign key (work_order_artifact_id, organization_id, project_id, work_order_sha256, work_order_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
alter table attempts add column context_pack_kind text
  generated always as (case when context_pack_artifact_id is null then null else 'context-pack' end) stored;
alter table attempts add constraint attempts_context_pack_ref_paired
  check ((context_pack_artifact_id is null) = (context_pack_sha256 is null));
alter table attempts add constraint attempts_context_pack_ref_fk
  foreign key (context_pack_artifact_id, organization_id, project_id, context_pack_sha256, context_pack_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
alter table attempts add column evidence_kind text
  generated always as (case when evidence_artifact_id is null then null else 'evidence-bundle' end) stored;
alter table attempts add constraint attempts_evidence_ref_paired
  check ((evidence_artifact_id is null) = (evidence_sha256 is null));
alter table attempts add constraint attempts_evidence_ref_fk
  foreign key (evidence_artifact_id, organization_id, project_id, evidence_sha256, evidence_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
alter table pull_requests add column evidence_kind text
  generated always as (case when evidence_artifact_id is null then null else 'evidence-bundle' end) stored;
alter table pull_requests add constraint pull_requests_evidence_ref_paired
  check ((evidence_artifact_id is null) = (evidence_sha256 is null));
alter table pull_requests add constraint pull_requests_evidence_ref_fk
  foreign key (evidence_artifact_id, organization_id, project_id, evidence_sha256, evidence_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
`;

// ---------------------------------------------------------------------------
// 0018 — evidence ids are reservations of their own attempt.
//
// A commit record's outcome named its evidence id as a bare string: the CHECK
// of 0013 only asked that it look like a ULID. Nothing tied it to the tenant,
// to the attempt that committed, or to anything that existed, and the evidence
// for the commit was fixed nowhere until after the commit — so a crash between
// commit and evidence left nothing to recover the evidence from.
//
// Now the id is RESERVED before the commit, and the reservation carries the
// evidence DRAFT (the bundle minus the commit SHA) as an 'evidence-draft'
// artifact of the same tenant, FK-bound with checksum and kind. The commit
// record's evidence id (a generated column over its result_ref), the
// attempt's evidence and the PR's evidence must each be a reservation of the
// very attempt and binding the row belongs to.
//
// A database that already holds a completed commit, or attached evidence,
// without a reservation has no draft to reserve, and the migration fails
// rather than invent one. Append-only: earlier migrations are untouched.
// ---------------------------------------------------------------------------
const M0018 = `
alter table artifacts
  add constraint artifacts_attempt_scoped_ref_uq unique (id, organization_id, project_id, sha256, kind, attempt_id);

create table evidence_reservations (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  attempt_id            char(26) not null,
  draft_artifact_id     char(26) not null,
  draft_sha256          text not null,
  draft_kind            text not null generated always as ('evidence-draft') stored,
  created_at            timestamptz not null default now(),
  foreign key (attempt_id, organization_id, project_id, repository_binding_id)
    references attempts (id, organization_id, project_id, repository_binding_id),
  foreign key (draft_artifact_id, organization_id, project_id, draft_sha256, draft_kind, attempt_id)
    references artifacts (id, organization_id, project_id, sha256, kind, attempt_id),
  unique (id, organization_id, project_id, repository_binding_id, attempt_id)
);

do $chk$
declare commits bigint; attached bigint;
begin
  select count(*) into commits from side_effect_records
    where operation = 'commit' and result_ref is not null;
  select (select count(*) from attempts where evidence_artifact_id is not null)
       + (select count(*) from pull_requests where evidence_artifact_id is not null) into attached;
  if commits > 0 or attached > 0 then
    raise exception 'evidence: % completed commit(s) and % attached evidence reference(s) predate evidence reservations and have no draft; refusing to invent one', commits, attached;
  end if;
end
$chk$;

alter table side_effect_records add column commit_evidence_id char(26)
  generated always as (case when operation = 'commit' then (result_ref->>'evidenceId')::char(26) end) stored;
alter table side_effect_records
  add constraint side_effect_commit_evidence_fk
  foreign key (commit_evidence_id, organization_id, project_id, repository_binding_id, attempt_id)
  references evidence_reservations (id, organization_id, project_id, repository_binding_id, attempt_id);

alter table attempts
  add constraint attempts_evidence_reserved_fk
  foreign key (evidence_artifact_id, organization_id, project_id, repository_binding_id, id)
  references evidence_reservations (id, organization_id, project_id, repository_binding_id, attempt_id);

alter table pull_requests
  add constraint pull_requests_evidence_reserved_fk
  foreign key (evidence_artifact_id, organization_id, project_id, repository_binding_id, attempt_id)
  references evidence_reservations (id, organization_id, project_id, repository_binding_id, attempt_id);
`;

// ---------------------------------------------------------------------------
// 0019 — command output references are scoped, and references are registered.
//
// 0017 made every reference a row relies on a scoped key with checksum and
// kind, but command_executions.stdout_artifact_id and stderr_artifact_id were
// left bare char(26) columns: any id, of any tenant, existing or not, was
// accepted. They now follow the same rule as the others: `<name>_sha256` (both
// or neither) and a generated `<name>_kind` ('command-stdout' /
// 'command-stderr', the kinds the command runner stores), FK-bound to
// artifacts (id, organization_id, project_id, sha256, kind).
//
// The references themselves are now registered in artifact_reference_columns,
// which every migration that adds or removes one must keep current. The
// persistence suite finds the references by the column naming convention, by
// this registry and by the foreign keys into artifacts, and requires all three
// to agree — so a reference cannot be added without being declared and
// enforced.
//
// A row that already names command output carries no checksum to bind, and
// the migration fails rather than invent one. Append-only: earlier migrations
// are untouched.
// ---------------------------------------------------------------------------
const M0019 = `
create table artifact_reference_columns (
  table_name     text not null,
  reference_name text not null,
  kind           text not null,
  primary key (table_name, reference_name)
);
insert into artifact_reference_columns (table_name, reference_name, kind) values
  ('runs', 'product_spec', 'product-spec'),
  ('tasks', 'work_order', 'work-order'),
  ('attempts', 'context_pack', 'context-pack'),
  ('attempts', 'evidence', 'evidence-bundle'),
  ('pull_requests', 'evidence', 'evidence-bundle'),
  ('evidence_reservations', 'draft', 'evidence-draft'),
  ('command_executions', 'stdout', 'command-stdout'),
  ('command_executions', 'stderr', 'command-stderr');

do $chk$
declare bad bigint;
begin
  select count(*) into bad from command_executions
    where stdout_artifact_id is not null or stderr_artifact_id is not null;
  if bad > 0 then
    raise exception 'command_executions: % row(s) name command output without a checksum; refusing to invent one', bad;
  end if;
end
$chk$;

alter table command_executions add column stdout_sha256 text;
alter table command_executions add column stdout_kind text
  generated always as (case when stdout_artifact_id is null then null else 'command-stdout' end) stored;
alter table command_executions add constraint command_executions_stdout_ref_paired
  check ((stdout_artifact_id is null) = (stdout_sha256 is null));
alter table command_executions add constraint command_executions_stdout_ref_fk
  foreign key (stdout_artifact_id, organization_id, project_id, stdout_sha256, stdout_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
alter table command_executions add column stderr_sha256 text;
alter table command_executions add column stderr_kind text
  generated always as (case when stderr_artifact_id is null then null else 'command-stderr' end) stored;
alter table command_executions add constraint command_executions_stderr_ref_paired
  check ((stderr_artifact_id is null) = (stderr_sha256 is null));
alter table command_executions add constraint command_executions_stderr_ref_fk
  foreign key (stderr_artifact_id, organization_id, project_id, stderr_sha256, stderr_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);
`;

// ---------------------------------------------------------------------------
// 0107 — run_events: the append-only store of operational run events.
//
// One row per event of a real run, keyed by the tenant and the producer's
// deterministic event id. The payload is the full RunEvent, validated against
// the run-event schema before insert, with the sha256 of its canonical bytes:
// a second write of the same id with the same bytes is a no-op, with other
// bytes a conflict (the sink compares the hashes; no row is ever updated). The
// scoped run FK keeps measurement and replay data, which has no runs row, out
// of this table. A trigger refuses every UPDATE and DELETE with SQLSTATE 55000.
// The id 0107 lies above the orchestration migrations 0100–0106 that land
// later; the migrator applies each missing id, so either order converges.
// ---------------------------------------------------------------------------
const M0107 = `
create table run_events (
  organization_id char(26) not null,
  project_id      char(26) not null,
  event_id        text not null,
  event_type      text not null,
  schema_version  text not null,
  occurred_at     timestamptz not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  payload         jsonb not null,
  payload_sha256  text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  inserted_at     timestamptz not null default now(),
  constraint run_events_pkey primary key (organization_id, project_id, event_id),
  constraint run_events_run_scoped_fk foreign key (run_id, organization_id, project_id)
    references runs (id, organization_id, project_id)
);
create index run_events_type_time on run_events (organization_id, project_id, event_type, occurred_at);
create index run_events_run on run_events (organization_id, project_id, run_id, occurred_at);

create function run_events_reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'run_events is append-only (% rejected)', tg_op using errcode = '55000';
end $$;
create trigger run_events_append_only
  before update or delete on run_events
  for each row execute function run_events_reject_mutation();
`;

// ---------------------------------------------------------------------------
// 0100 — the task statuses of durable orchestration.
//
// A task can now be paused, wait for a human approval, or end because its
// budget is spent. The constraint is the inline check of 0002, which
// PostgreSQL names tasks_status_check; it is replaced by name, with no
// IF EXISTS, so a database where the name differs fails here instead of
// keeping two checks. attempts.status is not touched here.
// ---------------------------------------------------------------------------
const M0100 = `
alter table tasks
  drop constraint tasks_status_check,
  add constraint tasks_status_check check (status in
    ('PENDING','READY','EXECUTING','VERIFYING','WAITING_FOR_HUMAN_REVIEW','FAILED','BLOCKED','CANCELLED',
     'PAUSED','WAITING_FOR_APPROVAL','BUDGET_EXHAUSTED'));
`;

// ---------------------------------------------------------------------------
// 0101 — tasks, runs and attempts are projections of their workflow.
//
// The workflow decides; these columns only show what it decided. Each row
// carries the sequence number of the last projection written to it, so a
// projection is applied only when its number is higher (an engine retry of an
// older write changes nothing), and a task or run is bound once to the one
// workflow that projects it (workflow_id, unique), so a second orchestrator's
// write is refused instead of interleaved.
// ---------------------------------------------------------------------------
const M0101 = `
alter table tasks
  add column workflow_id text,
  add column projection_seq bigint not null default 0,
  add column projection_updated_at timestamptz;
alter table tasks
  add constraint tasks_workflow_id_uq unique (workflow_id),
  add constraint tasks_workflow_id_shape check (workflow_id is null or length(workflow_id) between 1 and 255),
  add constraint tasks_projection_seq_nonnegative check (projection_seq >= 0);

alter table runs
  add column workflow_id text,
  add column projection_seq bigint not null default 0,
  add column projection_updated_at timestamptz;
alter table runs
  add constraint runs_workflow_id_uq unique (workflow_id),
  add constraint runs_workflow_id_shape check (workflow_id is null or length(workflow_id) between 1 and 255),
  add constraint runs_projection_seq_nonnegative check (projection_seq >= 0);

alter table attempts
  add column projection_seq bigint not null default 0,
  add column projection_updated_at timestamptz;
alter table attempts
  add constraint attempts_projection_seq_nonnegative check (projection_seq >= 0);
`;

// ---------------------------------------------------------------------------
// 0102 — an attempt is identified by its task and its ordinal.
//
// An attempt row got a fresh id on every insert, so an engine retry of "create
// attempt" after a lost response inserted a second attempt. Now every attempt
// has an attempt_number, unique per task: the orchestrator registers attempt n
// of a task by that natural key, and a retry finds the row it already wrote.
//
// Each attempt also records its kind and its repair lineage, which are separate
// facts: a repair attempt names the attempt whose assurance round asked for the
// repair (parent_attempt_id, an earlier attempt of the same task) and the
// repair order that round produced; a retry carries the lineage of the attempt
// it replaces, if that one had any; an initial attempt has none. The repair
// order is a scoped artifact reference with checksum and kind, like every other
// reference (0017, 0019), and is registered.
//
// Existing attempts are numbered in the order they started (ties by id) and
// are initial attempts. A writer that names no ordinal (the Phase 2 attempt
// repository) gets the next one of its task, under a lock on the task row, so
// Phase 2 call sites keep working unchanged. Append-only: earlier migrations
// are untouched.
// ---------------------------------------------------------------------------
const M0102 = `
alter table attempts
  add constraint attempts_id_scope_task_uq unique (id, organization_id, project_id, task_id);

alter table attempts
  add column attempt_number integer,
  add column attempt_kind text not null default 'initial',
  add column parent_attempt_id char(26),
  add column repair_order_artifact_id char(26),
  add column repair_order_sha256 text;

update attempts a
  set attempt_number = n.ordinal
  from (
    select id, row_number() over (partition by task_id order by started_at, id) as ordinal
    from attempts) n
  where n.id = a.id;

alter table attempts alter column attempt_number set not null;

alter table attempts
  add constraint attempts_attempt_number_positive check (attempt_number > 0),
  add constraint attempts_attempt_kind_known check (attempt_kind in ('initial','retry','repair')),
  add constraint attempts_parent_not_self check (parent_attempt_id <> id),
  add constraint attempts_parent_same_task_fk
    foreign key (parent_attempt_id, organization_id, project_id, task_id)
    references attempts (id, organization_id, project_id, task_id);

alter table attempts add column repair_order_kind text
  generated always as (case when repair_order_artifact_id is null then null else 'repair-order' end) stored;
alter table attempts add constraint attempts_repair_order_ref_paired
  check ((repair_order_artifact_id is null) = (repair_order_sha256 is null));
alter table attempts add constraint attempts_repair_order_ref_fk
  foreign key (repair_order_artifact_id, organization_id, project_id, repair_order_sha256, repair_order_kind)
  references artifacts (id, organization_id, project_id, sha256, kind);

alter table attempts add constraint attempts_lineage_shape check (
  (repair_order_artifact_id is null) = (parent_attempt_id is null)
  and (attempt_kind <> 'repair' or repair_order_artifact_id is not null)
  and (attempt_kind <> 'initial' or repair_order_artifact_id is null));

create unique index attempts_task_ordinal on attempts (task_id, attempt_number);

insert into artifact_reference_columns (table_name, reference_name, kind) values
  ('attempts', 'repair_order', 'repair-order');

create function asep_attempt_ordinal() returns trigger
language plpgsql
as $fn$
declare
  parent_number integer;
begin
  if new.attempt_number is null then
    perform 1 from tasks where id = new.task_id for no key update;
    select coalesce(max(attempt_number), 0) + 1 into new.attempt_number
      from attempts where task_id = new.task_id;
  end if;
  if new.parent_attempt_id is not null then
    select attempt_number into parent_number from attempts where id = new.parent_attempt_id;
    if parent_number is null or parent_number >= new.attempt_number then
      raise exception 'attempt %: the parent of its repair lineage must be an earlier attempt of its task', new.id
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$fn$;

create trigger attempt_ordinal
  before insert or update of attempt_number, parent_attempt_id on attempts
  for each row execute function asep_attempt_ordinal();
`;

// ---------------------------------------------------------------------------
// 0104 — the durable workspace registry.
//
// The worktree manager kept a workspace's path, base and baseline refs in
// process memory, so after a worker restart nobody could inspect, commit,
// reconcile or clean that workspace up. One row per attempt now records which
// worktree serves it, on which host, at which base, created under which lease
// (bound by a composite key to that very lease of the same tenant, binding and
// attempt, with its epoch), and in which state.
//
// A trigger keeps what identifies a workspace immutable and lets its state only
// move forward: CREATING → ACTIVE, CREATING or ACTIVE → CLEANED or QUARANTINED,
// QUARANTINED → CLEANED. Baseline refs are fixed once the workspace is active,
// and a reason is recorded exactly when it is cleaned or quarantined. Paths are
// relative, made of plain segments, never absolute and never '.' or '..'.
// workspace_leases is not touched.
// ---------------------------------------------------------------------------
const M0104 = `
create table workspaces (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  attempt_id            char(26) not null,
  lease_id              char(26) not null,
  lease_epoch           bigint not null,
  host_id               text not null check (host_id ~ '^[A-Za-z0-9._-]{1,255}$'),
  path_rel              text not null check (
    length(path_rel) <= 1024
    and path_rel ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
    and path_rel !~ '(^|/)[.]{1,2}(/|$)'),
  base_sha              text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  baseline_refs         jsonb not null default '[]'::jsonb check (jsonb_typeof(baseline_refs) = 'array'),
  state                 text not null check (state in ('CREATING','ACTIVE','CLEANED','QUARANTINED')),
  state_reason          text check (state_reason is null or length(state_reason) between 1 and 1000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 0,
  constraint workspaces_attempt_uq unique (attempt_id),
  constraint workspaces_scoped_uq unique (id, organization_id, project_id),
  constraint workspaces_attempt_fk foreign key (attempt_id, organization_id, project_id, repository_binding_id)
    references attempts (id, organization_id, project_id, repository_binding_id),
  constraint workspaces_lease_fk
    foreign key (lease_id, organization_id, project_id, repository_binding_id, attempt_id, lease_epoch)
    references workspace_leases (id, organization_id, project_id, repository_binding_id, attempt_id, fencing_epoch),
  constraint workspaces_reason_when_ended check ((state in ('CLEANED','QUARANTINED')) = (state_reason is not null))
);

create function asep_workspace_guard() returns trigger
language plpgsql
as $fn$
begin
  if (new.id, new.organization_id, new.project_id, new.repository_binding_id, new.attempt_id,
      new.lease_id, new.lease_epoch, new.host_id, new.path_rel, new.base_sha)
     is distinct from
     (old.id, old.organization_id, old.project_id, old.repository_binding_id, old.attempt_id,
      old.lease_id, old.lease_epoch, old.host_id, old.path_rel, old.base_sha) then
    raise exception 'workspace % identity is immutable', old.id
      using errcode = '23514';
  end if;
  if new.state <> old.state and not (
       (old.state = 'CREATING' and new.state in ('ACTIVE', 'CLEANED', 'QUARANTINED'))
    or (old.state = 'ACTIVE' and new.state in ('CLEANED', 'QUARANTINED'))
    or (old.state = 'QUARANTINED' and new.state = 'CLEANED')) then
    raise exception 'workspace % cannot move from % to %', old.id, old.state, new.state
      using errcode = '23514';
  end if;
  if new.state = old.state and new.state_reason is distinct from old.state_reason then
    raise exception 'workspace % keeps the reason it was % for', old.id, lower(old.state)
      using errcode = '23514';
  end if;
  if new.baseline_refs is distinct from old.baseline_refs and old.state <> 'CREATING' then
    raise exception 'workspace % baseline refs are fixed once it is %', old.id, lower(old.state)
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

create trigger workspace_guard
  before update on workspaces
  for each row execute function asep_workspace_guard();
`;

// ---------------------------------------------------------------------------
// 0105 — approval requests, human decisions and the decision outbox.
//
// A workflow that needs a human's yes opens a request whose id it derives
// itself (<workflow id>:<gate number>), so a retried open finds its row. The
// request's payload is a closed shape per kind: a budget extension states the
// shortfall in integer micro-USD and nothing else, a publication approval
// carries nothing (its attempt is the subject). A request belongs to its run,
// its task to that run and its attempt to that task, by composite keys.
//
// A human decision is the evidence of who decided what: at most one per
// request, with the deciding principal, the rationale (which stays here and
// never enters workflow history), and an extension amount in exact micro-USD
// only on an approve. Its delivery row is written in the same transaction, so a
// crash between the decision and its delivery to the workflow leaves a row the
// relay finds, never a decided gate the workflow does not hear about.
// Append-only: earlier migrations are untouched.
// ---------------------------------------------------------------------------
const M0105 = `
alter table tasks
  add constraint tasks_id_scope_run_uq unique (id, organization_id, project_id, run_id);

create function asep_approval_payload_valid(kind text, payload jsonb)
returns boolean
language sql
immutable
as $fn$
  select coalesce(
    case
      when payload is null or jsonb_typeof(payload) <> 'object' then false
      when kind = 'budget-extension' then
        payload - 'shortfallMicroUsd' = '{}'::jsonb
        and jsonb_typeof(payload->'shortfallMicroUsd') = 'number'
        and payload->>'shortfallMicroUsd' ~ '^[1-9][0-9]{0,15}$'
      when kind = 'publish-change' then payload = '{}'::jsonb
      else false
    end,
    false)
$fn$;

create table approval_requests (
  id              text primary key,
  organization_id char(26) not null,
  project_id      char(26) not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  workflow_id     text not null check (length(workflow_id) between 1 and 255),
  kind            text not null check (kind in ('budget-extension','publish-change')),
  requested_by    text not null check (requested_by = 'harness' or requested_by ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  payload         jsonb not null,
  status          text not null default 'PENDING'
                  check (status in ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 0,
  constraint approval_requests_id_from_workflow check (
    left(id, length(workflow_id) + 1) = workflow_id || ':'
    and substr(id, length(workflow_id) + 2) ~ '^[0-9]{1,18}$'),
  constraint approval_requests_payload_closed check (asep_approval_payload_valid(kind, payload)),
  constraint approval_requests_attempt_needs_task check (attempt_id is null or task_id is not null),
  constraint approval_requests_kind_subject check (
    (kind <> 'budget-extension' or task_id is not null)
    and (kind <> 'publish-change' or attempt_id is not null)),
  constraint approval_requests_run_fk foreign key (run_id, organization_id, project_id)
    references runs (id, organization_id, project_id),
  constraint approval_requests_task_fk foreign key (task_id, organization_id, project_id, run_id)
    references tasks (id, organization_id, project_id, run_id),
  constraint approval_requests_attempt_fk foreign key (attempt_id, organization_id, project_id, task_id)
    references attempts (id, organization_id, project_id, task_id),
  constraint approval_requests_scoped_uq unique (id, organization_id, project_id)
);

create table approval_decisions (
  id              char(26) primary key check (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  organization_id char(26) not null,
  project_id      char(26) not null,
  request_id      text not null,
  decision        text not null check (decision in ('approve','reject')),
  decided_by      char(26) not null check (decided_by ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  rationale       text not null check (length(rationale) between 1 and 4000),
  extension_usd   numeric check (extension_usd is null or (extension_usd > 0 and extension_usd = round(extension_usd, 6))),
  decided_at      timestamptz not null default now(),
  constraint approval_decisions_one_per_request unique (request_id),
  constraint approval_decisions_extension_on_approve check (extension_usd is null or decision = 'approve'),
  constraint approval_decisions_request_fk foreign key (request_id, organization_id, project_id)
    references approval_requests (id, organization_id, project_id),
  constraint approval_decisions_scoped_uq unique (id, organization_id, project_id)
);

create table approval_decision_deliveries (
  decision_id     char(26) primary key,
  organization_id char(26) not null,
  project_id      char(26) not null,
  workflow_id     text not null check (length(workflow_id) between 1 and 255),
  update_id       char(26) not null,
  status          text not null default 'PENDING' check (status in ('PENDING','DELIVERED','TARGET_CLOSED')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  delivered_at    timestamptz,
  version         integer not null default 0,
  constraint approval_deliveries_update_is_decision check (update_id = decision_id),
  constraint approval_deliveries_decision_fk foreign key (decision_id, organization_id, project_id)
    references approval_decisions (id, organization_id, project_id)
);
create index approval_deliveries_due on approval_decision_deliveries (status, next_attempt_at);
`;

// ---------------------------------------------------------------------------
// 0106 — the budget ledger and the run's governance.
//
// What a run spends is appended to a ledger, one row per fact: an attempt's
// usage, a recorded overrun, an extension a human granted. Each row carries an
// idempotency key unique in its tenant, so a retried write finds its row. Money
// is exact to the micro-USD, the source says who measured it (a human only
// grants), usage and overruns belong to an attempt, and an extension to a task;
// the attempt belongs to the task and the task to the run, by composite keys.
//
// A run gains its budget and its governance: the caps, whether a publication
// needs a human approval, and the principal who set them. They are set once,
// when created_by is first written; a trigger refuses any later change, so
// publicationApprovalRequired cannot change after the run starts. Phase 2 runs
// keep them unset. Append-only: earlier migrations are untouched.
// ---------------------------------------------------------------------------
const M0106 = `
create table budget_ledger (
  id                 char(26) primary key,
  organization_id    char(26) not null,
  project_id         char(26) not null,
  run_id             char(26) not null,
  task_id            char(26),
  attempt_id         char(26),
  entry_kind         text not null check (entry_kind in ('attempt-usage','extension-granted','overrun')),
  cost_usd           numeric not null check (cost_usd >= 0 and cost_usd = round(cost_usd, 6)),
  usage_out_of_bound boolean not null default false check (entry_kind = 'overrun' or not usage_out_of_bound),
  input_tokens       bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens      bigint check (output_tokens is null or output_tokens >= 0),
  tool_calls         integer check (tool_calls is null or tool_calls >= 0),
  wall_clock_ms      bigint check (wall_clock_ms is null or wall_clock_ms >= 0),
  source             text not null check (source in ('provider-reported','harness-measured','human-granted')),
  idempotency_key    text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,255}$'),
  created_at         timestamptz not null default now(),
  constraint budget_ledger_key_uq unique (organization_id, project_id, idempotency_key),
  constraint budget_ledger_granted_by_human check ((entry_kind = 'extension-granted') = (source = 'human-granted')),
  constraint budget_ledger_usage_of_attempt check (entry_kind = 'extension-granted' or attempt_id is not null),
  constraint budget_ledger_extension_of_task check (entry_kind <> 'extension-granted' or task_id is not null),
  constraint budget_ledger_attempt_needs_task check (attempt_id is null or task_id is not null),
  constraint budget_ledger_run_fk foreign key (run_id, organization_id, project_id)
    references runs (id, organization_id, project_id),
  constraint budget_ledger_task_fk foreign key (task_id, organization_id, project_id, run_id)
    references tasks (id, organization_id, project_id, run_id),
  constraint budget_ledger_attempt_fk foreign key (attempt_id, organization_id, project_id, task_id)
    references attempts (id, organization_id, project_id, task_id)
);
create index budget_ledger_run on budget_ledger (organization_id, project_id, run_id, task_id);

alter table runs
  add column budget_max_cost_usd numeric,
  add column budget_soft_cost_usd numeric,
  add column budget_max_tasks integer,
  add column publication_approval_required boolean not null default false,
  add column created_by char(26);
alter table runs
  add constraint runs_budget_max_cost check (
    budget_max_cost_usd is null or (budget_max_cost_usd > 0 and budget_max_cost_usd = round(budget_max_cost_usd, 6))),
  add constraint runs_budget_soft_cost check (
    budget_soft_cost_usd is null
    or (budget_max_cost_usd is not null and budget_soft_cost_usd >= 0
        and budget_soft_cost_usd <= budget_max_cost_usd and budget_soft_cost_usd = round(budget_soft_cost_usd, 6))),
  add constraint runs_budget_max_tasks check (budget_max_tasks is null or budget_max_tasks > 0),
  add constraint runs_created_by_shape check (created_by is null or created_by ~ '^[0-9A-HJKMNP-TV-Z]{26}$');

create function asep_run_governance_guard() returns trigger
language plpgsql
as $fn$
begin
  if old.created_by is not null
     and (new.budget_max_cost_usd, new.budget_soft_cost_usd, new.budget_max_tasks,
          new.publication_approval_required, new.created_by)
         is distinct from
         (old.budget_max_cost_usd, old.budget_soft_cost_usd, old.budget_max_tasks,
          old.publication_approval_required, old.created_by) then
    raise exception 'run % governance is fixed once it is set', old.id
      using errcode = '23514';
  end if;
  return new;
end
$fn$;

create trigger run_governance_guard
  before update on runs
  for each row execute function asep_run_governance_guard();
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
  { id: '0014_fenced_lease_takeover', sql: M0014 },
  { id: '0015_lease_attempt_fk', sql: M0015 },
  { id: '0016_lease_liveness_clock', sql: M0016 },
  { id: '0017_scoped_artifact_references', sql: M0017 },
  { id: '0018_evidence_reservations', sql: M0018 },
  { id: '0019_command_output_references', sql: M0019 },
  { id: '0100_orchestration_task_status', sql: M0100 },
  { id: '0101_workflow_bindings_projection', sql: M0101 },
  { id: '0102_attempt_ordinal', sql: M0102 },
  { id: '0104_workspaces', sql: M0104 },
  { id: '0105_approvals', sql: M0105 },
  { id: '0106_budget_ledger', sql: M0106 },
  { id: '0107_run_events', sql: M0107 },
]);
