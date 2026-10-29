# Phase 3 — Data Model (LOCKED v4, pending controller confirmation)

> Companion to `phase-03-plan.md`. PostgreSQL 17 (same digest-pinned image as Phase 2). Base `00a6889`; v1 of
> this document is at `80bb76a`, v2 at `98e92cf`, v3 at `7cbf5d3`. v2 folded in the Codex plan review; v3 folds in
> the Codex lock-check of v2 and the controller's reconciliation R15–R19; v4 folds in the Codex review of v3 and
> reconciliation R21 (`phase-03-review-log.md`, section "Review v3"). The reconciliation wins
> where it and this document disagree.
> Lane A migration range: **`0100`–`0199`** (lane contract). Migrations are append-only, checksummed and applied
> in strictly ascending id order by the Phase 2 migrator, which allows gaps (`adapters/persistence/src/migrator.ts:45-51`).
> Phase 2's `0001`–`0012` (`adapters/persistence/src/migrations.ts:425-438`) and the Phase 2 repairs in
> `0013`–`0099` apply first. Lane B's `0200`+ apply after. Every table follows the Phase 2 conventions
> (`phase-02-data-model.md` §1): `char(26)` ULID keys, `timestamptz` UTC, `version` optimistic column on mutable
> rows, composite FKs onto `(id, organization_id, project_id)`, and `TenantScope` as the first parameter of every
> repository method.

## 1. What lives where

| Fact | Store | Authority |
|---|---|---|
| Which phase a task/run is in, timers, pending approvals, paused flag, budget arithmetic | Temporal history | **Temporal** |
| Projected task/attempt/run status (for queries and humans) | PostgreSQL `tasks`/`attempts`/`runs` columns | projection (rebuildable from workflow history plus the records below) |
| Attempt identity and ordinal, workspace registry | PostgreSQL (Lane A) | PostgreSQL (idempotency truth that activities need across worker deaths) |
| Leases, fencing identity, side-effect records and their typed result binding | PostgreSQL (**Phase 2 primitive**, R1/R2) | PostgreSQL. Lane A consumes the accepted Phase 2 schema after the rebase and adds no parallel table or column. |
| Approval requests, human decisions, decision delivery outbox | PostgreSQL | PostgreSQL is the **evidence** of who decided what. Temporal decides **when to act** on a verified decision. |
| Budget ledger entries | PostgreSQL | PostgreSQL ledger (append-only). The workflow keeps the running total, and the two are reconciled in tests. |
| Run events | PostgreSQL `run_events` (Lane A owns the table; both lanes append through `RunEventSink`) | append-only telemetry |

## 2. Migration set (Lane A; CR-11)

```text
0100_orchestration_task_status     tasks.status CHECK += PAUSED, WAITING_FOR_APPROVAL, BUDGET_EXHAUSTED
                                    (Lane A owns this constraint; Lane B owns attempts.status in 02xx, R6)
0101_workflow_bindings_projection  tasks/runs/attempts: workflow_id, projection_seq, projection_updated_at
0102_attempt_ordinal               attempts: attempt_number, attempt_kind, parent_attempt_id,
                                    repair_order_artifact_id; unique (task_id, attempt_number)
0103                               intentionally unused: side-effect fencing and result binding are the Phase 2
                                    primitive (R1, R2); v1's 0103_side_effect_epochs is withdrawn
0104_workspaces                    workspaces registry (rehydration after worker restart)
0105_approvals                     approval_requests, approval_decisions, approval_decision_deliveries (outbox)
0106_budget_ledger                 budget_ledger; runs: budget + governance columns
0107_run_events                    run_events, unified DDL of both lanes (R4)   [lands in S0]
```

All are `ALTER`/`CREATE` only, except the one `DROP CONSTRAINT … ADD CONSTRAINT` in `0100`. No Phase 2 migration
text changes, so recorded checksums stay valid. Each runs in a transaction under the advisory lock. Each is
forward-tested on a clean database and re-applied as a no-op (Phase 2 rules, `phase-02-data-model.md` §5).

**Removed from v1.** `attempts.fencing_epoch` and the whole `AttemptFence` epoch counter are withdrawn. An
attempt-scoped epoch let a zombie that had lost its lease claim a fresh epoch (P3-PLAN-CRIT-001). Fencing
identity now comes only from the Phase 2 lease-bound primitive (plan §30, CR-05).

## 3. Tables and columns

### 3.0 `tasks.status` (0100)

The Phase 2 constraint is the inline, unnamed check at `adapters/persistence/src/migrations.ts:87-88`, which
PostgreSQL names `tasks_status_check`.

```sql
alter table tasks
  drop constraint tasks_status_check,
  add constraint tasks_status_check check (status in
    ('PENDING','READY','EXECUTING','VERIFYING','WAITING_FOR_HUMAN_REVIEW','FAILED','BLOCKED','CANCELLED',
     'PAUSED','WAITING_FOR_APPROVAL','BUDGET_EXHAUSTED'));
```

There is no `IF EXISTS`. If the generated name ever differs, the migration fails instead of leaving two
constraints. Lane A never touches `attempts.status`. Lane B owns that constraint in `02xx` (R6).

### 3.1 `tasks`, `runs`, `attempts` — workflow binding and projection (0101)

```sql
alter table tasks    add column workflow_id text unique,
                     add column projection_seq bigint not null default 0,
                     add column projection_updated_at timestamptz;
alter table runs     add column workflow_id text unique,
                     add column projection_seq bigint not null default 0,
                     add column projection_updated_at timestamptz;
alter table attempts add column projection_seq bigint not null default 0,
                     add column projection_updated_at timestamptz;
```

Projection write rule (architecture §13): the update applies only when `projection_seq < $seq` and
`workflow_id` is null or equal. `workflow_id` is set once. `tasks.workflow_id` uniqueness plus the
deterministic workflow ID `asep-task-<taskId>` give one workflow per task. In Phase 3 the attempt projection
writes only Phase 2 `AttemptStatus` values. The Phase 4 values (`UNDER_REVIEW`, `CHANGES_REQUESTED`) are
projected only once Lane B's constraint and domain edges are merged (plan §30, CR-10).

### 3.2 `attempts` — ordinal, kind, repair input (0102)

```sql
alter table attempts
  add column attempt_number integer,
  add column attempt_kind text check (attempt_kind in ('initial','retry','repair')),
  add column parent_attempt_id char(26),
  add column repair_order_artifact_id char(26),
  add constraint attempts_parent_scoped_fk foreign key (parent_attempt_id, organization_id, project_id)
    references attempts (id, organization_id, project_id),
  add constraint attempts_repair_order_scoped_fk foreign key (repair_order_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  -- Attempt kind and repair lineage are separate (R17): a repair attempt always carries a lineage, a retry
  -- carries the lineage of the attempt it replaces (if any), and an initial attempt carries none.
  add constraint attempts_lineage_shape check (
    (repair_order_artifact_id is null) = (parent_attempt_id is null)
    and (attempt_kind <> 'repair'  or repair_order_artifact_id is not null)
    and (attempt_kind <> 'initial' or repair_order_artifact_id is null));
-- backfill Phase 2 rows: attempt_number = row_number() over (partition by task_id order by started_at, id),
--                        attempt_kind = 'initial'
alter table attempts alter column attempt_number set not null,
                     alter column attempt_kind set not null;
create unique index attempts_task_ordinal on attempts (task_id, attempt_number);
```

- `ensureAttempt(scope, {taskId, attemptNumber, kind, parentAttemptId?, repairOrderRef?, baseSha})` inserts or
  returns the existing row for `(task_id, attempt_number)`. A mismatched `kind`, parent, repair order or base on
  an existing ordinal raises `AttemptIdentityConflictError` (non-retryable). The natural key closes the
  engine-retry duplicate-row hazard; luck plays no part.
- A repair-lineage attempt's existing `attempts.base_sha` column (`migrations.ts:109`) holds `repairBaseSha`: the
  parent attempt's harness commit, as returned in the `REPAIR` outcome. Its evidence is honest about its own base.
  The task's original base stays on `tasks.base_sha` and is passed to the assurance round as `taskBaseSha`.
- A `retry` that replaces a repair-lineage attempt has the same `parent_attempt_id`, `repair_order_artifact_id`
  and `base_sha` as the attempt it replaces. The round and prior adjudication of the lineage travel in the
  workflow state and in the next assurance request; they are not columns.

### 3.3 (withdrawn)

v1's `side_effect_records` epoch columns are withdrawn (R1). Lane A adds nothing to `side_effect_records` or
`workspace_leases`. If the accepted Phase 2 primitive lacks an invariant Lane A needs (plan §30, CR-05), Lane A
files a change request against the Phase 2 primitive and does not design a parallel one.

### 3.4 `workspaces` — durable registry (0104)

```sql
create table workspaces (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  attempt_id            char(26) not null unique,
  lease_id              char(26) not null,
  host_id               text not null,          -- worker host owning the files (single-host guard)
  path_rel              text not null,          -- binding/<id>/workspace/<id>; validated segments only
  base_sha              text not null check (base_sha ~ '^[0-9a-f]{40}$'),   -- task base, or repairBaseSha
  baseline_refs         jsonb not null,         -- array of ref names at creation (non-secret)
  state                 text not null check (state in ('CREATING','ACTIVE','CLEANED','QUARANTINED')),
  state_reason          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 0,
  foreign key (attempt_id, organization_id, project_id) references attempts (id, organization_id, project_id),
  foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id),
  unique (id, organization_id, project_id)
);
```

- `prepareWorkspace` writes `CREATING` **before** `git worktree add`, and `ACTIVE` after HEAD is verified at
  `base_sha`. A retry that finds `CREATING` checks the path. If the worktree is present at `base_sha` with no
  extra refs, it is promoted to `ACTIVE`. Otherwise it is `QUARANTINED`, and the attempt is abandoned (it is
  still pre-agent, so no external effect exists).
- A repair workspace is created at `repairBaseSha`. That commit exists in the shared mirror object store,
  because the parent attempt's worktree shares it (`adapters/git-worktree/src/worktree-manager.ts:119-121`).
  `prepareWorkspace` verifies the object exists before `git worktree add` and fails non-retryably if it does not.
- `path_rel` is the Phase 2 containment-checked relative path (`worktree-manager.ts:110-114`). Absolute paths
  are never stored.
- `workspace_leases.workspace_id` (Phase 2, minted independently at `lease-repository.ts:43`) is linked to the
  registry row through `workspaces.lease_id`. The registry does not rewrite the Phase 2 lease row. If the
  accepted Phase 2 primitive reshapes leases, the link follows its key after the rebase.

### 3.5 `approval_requests`, `approval_decisions`, `approval_decision_deliveries` (0105)

```sql
create table approval_requests (
  id              text primary key,             -- deterministic: '<workflowId>:<gateSeq>'
  organization_id char(26) not null,
  project_id      char(26) not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  workflow_id     text not null,
  kind            text not null check (kind in ('budget-extension','publish-change')),
  requested_by    text not null,                -- principal id, or 'harness'
  payload         jsonb not null,               -- closed per-kind shape; ids/numbers/refs only
  status          text not null check (status in ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 0,
  foreign key (run_id, organization_id, project_id) references runs (id, organization_id, project_id),
  foreign key (task_id, organization_id, project_id) references tasks (id, organization_id, project_id),
  foreign key (attempt_id, organization_id, project_id) references attempts (id, organization_id, project_id),
  unique (id, organization_id, project_id)
);
create table approval_decisions (
  id              char(26) primary key,         -- decisionId; also the Temporal updateId
  organization_id char(26) not null,
  project_id      char(26) not null,
  request_id      text not null unique,         -- at most one decision per request
  decision        text not null check (decision in ('approve','reject')),
  decided_by      char(26) not null,            -- authenticated human principal id (opaque ULID)
  rationale       text not null check (length(rationale) between 1 and 4000),   -- stays in PostgreSQL only
  extension_usd   numeric check (extension_usd is null or extension_usd > 0),
  decided_at      timestamptz not null default now(),
  foreign key (request_id, organization_id, project_id)
    references approval_requests (id, organization_id, project_id),  -- scope-coherent, as in Phase 2
  unique (id, organization_id, project_id)
);
-- Transactional outbox: written in the SAME transaction as the decision, so a crash between the
-- decision commit and the Temporal Update can never strand a decided gate.
create table approval_decision_deliveries (
  decision_id     char(26) primary key,
  organization_id char(26) not null,
  project_id      char(26) not null,
  workflow_id     text not null,
  update_id       char(26) not null,            -- = decision_id
  status          text not null check (status in ('PENDING','DELIVERED','TARGET_CLOSED')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,                         -- closed code, never a message body
  delivered_at    timestamptz,
  version         integer not null default 0,
  check (update_id = decision_id),
  foreign key (decision_id, organization_id, project_id)
    references approval_decisions (id, organization_id, project_id)
);
create index approval_deliveries_due on approval_decision_deliveries (status, next_attempt_at);
```

- The `review-adjudication` kind and the `request-repair` decision of v1 are withdrawn. Under the reconciled
  Phase 4 semantics (R3), `ESCALATE` publishes a flagged PR for human review instead of waiting on an approval
  gate (`phase-04-plan.md` §7 at `a2a7b8a`).
- `requested_by <> decided_by` is enforced in the application use case (the API) and asserted by test I2. It is
  not a DB check, because `requested_by` may be `'harness'`. `decided_by` is a principal ULID, so the literal
  `'harness'` cannot be stored there (`char(26)`).
- `approval_decisions.request_id` is unique, so a second decision insert fails at the database. The API maps
  that to 409 unless the body is identical to the stored decision. An identical retry returns the original
  receipt **and** marks the delivery row due again, so a retry always re-delivers the Update idempotently.
- Delivery relay (architecture §11): every API process runs it at startup and on an interval. It sends Update
  `control` with `updateId = decision_id`, which the server deduplicates per run. Each delivery attempt
  increments `attempts` with backoff. A closed target workflow ends the row in `TARGET_CLOSED` and is audited.
  Several relays may run at once, and that is safe because delivery is idempotent.

### 3.6 `budget_ledger`, run governance (0106)

```sql
create table budget_ledger (
  id              char(26) primary key,
  organization_id char(26) not null,
  project_id      char(26) not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  entry_kind      text not null check (entry_kind in ('attempt-usage','extension-granted','overrun')),
  cost_usd        numeric not null check (cost_usd >= 0),
  input_tokens    bigint, output_tokens bigint, tool_calls integer, wall_clock_ms bigint,
  source          text not null check (source in ('provider-reported','harness-measured','human-granted')),
  idempotency_key text not null,                -- e.g. '<attemptId>:attempt-usage', '<approvalRequestId>:extension'
  created_at      timestamptz not null default now(),
  unique (organization_id, project_id, idempotency_key),
  foreign key (run_id, organization_id, project_id) references runs (id, organization_id, project_id),
  foreign key (task_id, organization_id, project_id) references tasks (id, organization_id, project_id),
  foreign key (attempt_id, organization_id, project_id) references attempts (id, organization_id, project_id)
);
alter table runs
  add column budget_max_cost_usd  numeric check (budget_max_cost_usd is null or budget_max_cost_usd > 0),
  add column budget_soft_cost_usd numeric,
  add column budget_max_tasks     integer,
  add column publication_approval_required boolean not null default false,
  add column created_by           char(26);
```

### 3.7 `run_events` (0107; S0; unified DDL of both lanes, R4)

Union of Lane A v1 (`80bb76a`) and Lane B's withdrawn `0201_run_events` (`phase-04-data-model.md` at `a2a7b8a`):
composite tenant key, payload hash with conflict on different bytes, append-only trigger, and the scoped run FK.

```sql
create table run_events (
  organization_id char(26) not null,
  project_id      char(26) not null,
  event_id        text not null,                -- deterministic per producer (Lane A: '<workflowId>:<seq>')
  event_type      text not null,
  schema_version  text not null,                -- e.g. '1.2.0'
  occurred_at     timestamptz not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  payload         jsonb not null,               -- the full RunEvent, validated against the schema BEFORE insert
  payload_sha256  text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),   -- sha256 of canonical bytes
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
```

`RunEventSink.append(scope, event)` (S0 port; SR-P2 shape) works in four steps:

1. Validate `event` against its declared `run-event` version.
2. Canonicalize it (sorted keys, no insignificant whitespace) and take the SHA-256.
3. `insert … on conflict (organization_id, project_id, event_id) do nothing`.
4. On no insert, read the stored `payload_sha256`. Equal → `{ appended: false }`. Different →
   `RunEventConflictError`.

It never updates a row. The adapter lives in `adapters/persistence/src/run-events/**` (Lane A, S0), and both
lanes inject it.

**Storage boundary (R15, P3-PLAN2-MED-007).** `run_events` holds operational events of real runs only; the scoped
run FK stays. Benchmark, replay and corpus measurement never write into `run_events`, never create a `runs` row
to satisfy the FK, and never ask for the FK to be dropped. Their outputs go to Lane B's measurement storage
(`metric_snapshots` or eval artifacts). The sink conformance (exit O2) includes an event whose run does not exist
in the tenant, and it must be rejected.

Rollback of `0107` is a forward migration that drops the trigger, function and table. It is written only if the
controller orders a rollback; no down-migration is run automatically (Phase 2 migrator rule).

## 4. Contract changes (shared; CR-01 … CR-03)

### 4.1 `TaskStatus` (hand-authored in `packages/contracts/src/base.ts:38-40`)

Add `PAUSED`, `WAITING_FOR_APPROVAL`, `BUDGET_EXHAUSTED`. Transition table changes in
`packages/domain/src/operational.ts:28-39`:

```text
READY / EXECUTING / VERIFYING  → PAUSED, WAITING_FOR_APPROVAL      (in addition to Phase 2 edges)
PAUSED                         → READY, EXECUTING, VERIFYING, WAITING_FOR_APPROVAL, BLOCKED, BUDGET_EXHAUSTED,
                                 CANCELLED
WAITING_FOR_APPROVAL           → READY, EXECUTING, VERIFYING, PAUSED, BLOCKED, BUDGET_EXHAUSTED, CANCELLED
READY / EXECUTING / VERIFYING  → BUDGET_EXHAUSTED
BUDGET_EXHAUSTED               → (terminal)
WAITING_FOR_HUMAN_REVIEW       → (terminal for the harness; unchanged; still no ACCEPTED/DONE)
```

`VERIFYING → BUDGET_EXHAUSTED` is needed when a replacement attempt is refused for budget after the task already
reached verification (for example an exhausted repair attempt whose retry fails its reservation). The S2 decision
core emits it, and S1 adds it to the domain table (R19).

`WAITING_FOR_APPROVAL → PAUSED`, `PAUSED → WAITING_FOR_APPROVAL` and `PAUSED → BUDGET_EXHAUSTED` are needed because a
pause during an approval wait applies at once, resume returns to the wait, and a budget-extension request can
expire or be rejected while the task is paused (R21, architecture §9). The S2 core emits them, and S1 adds them to
the domain table.

The task stays `VERIFYING` across assurance and repair rounds, as Phase 4 requires (`phase-04-plan.md` §7 at
`a2a7b8a`). No review-specific task status exists. `isTaskTerminal` gains `BUDGET_EXHAUSTED`. The Phase 2 table
test (`packages/domain/src/operational.test.ts`) is extended, not weakened. The invariant test that no machine
transition reaches an accepted state stays byte-identical. `AttemptStatus` is Lane B's (R6).

### 4.2 New canonical schemas (CR-02)

`task-workflow-input/v1` (`$id https://asep.dev/schema/task-workflow-input/v1`), required fields:

```text
schemaVersion: "1.0.0"
organizationId, projectId, repositoryBindingId, runId, taskId     (ULID pattern)
risk: R0..R4
baseSha: 40-hex
workOrderRef: ArtifactRef            (WorkOrder already stored and validated)
contextPackRef: ArtifactRef
attemptBudget: Budget                (must equal WorkOrder.budget; checked by the first activity)
taskBudget: { maxAttempts 1..10, maxCostUsd > 0, softCostUsd ≤ maxCostUsd, maxWallClockMinutes > 0 }
verificationReserve: { costUsd ≥ 0, wallClockMinutes ≥ 0 }   (reserved separately at each attempt start, R17;
                     wall-clock = the plan's check timeouts rounded up to minutes, cost from policy)
runRemaining: { costUsd ≥ 0 }
verification: { planId, checks: [{ id, level L0..L9, category, mandatory, commandId }] }   (no shell strings)
governance: { publicationApprovalRequired, approvalTtlSeconds 60..604800, maxPauseHours 1..168,
              assuranceMode: shadow|gating (shadow in Phases 3 and 4), requestedBy (ULID) }
policy: { replaceableFailureClasses: [failure class], maxBudgetExtensionUsd?: > 0, agentKillGraceSeconds: integer ≥ 0 }
        (resolved from `policies/orchestration-policy.yaml` at submit time; the workflow never reads policy files.
         An absent maxBudgetExtensionUsd makes budget-extension approval unavailable, R19.
         replaceableFailureClasses never lists policy-violation, false-completion or duplicate-side-effect: the
         loader and the input mapping reject such a policy, and the core ignores them anyway, R21.
         agentKillGraceSeconds is the agent adapter's stop-to-kill interval, the only tolerance on the wall-clock
         cap, R21.)
```

Every money amount (`attemptBudget.maxCostUsd`, `taskBudget.maxCostUsd`, `taskBudget.softCostUsd`,
`verificationReserve.costUsd`, `runRemaining.costUsd`, `policy.maxBudgetExtensionUsd`) must be exactly representable
in micro-USD and at most `100 000 000` USD. JSON Schema `multipleOf` is not used for this, because binary floating
point makes it unreliable; the S7 input mapping applies the core's exactness rule and rejects the input otherwise
(R21, architecture §10, exit H12).

`maxRepairCycles` from v1 is removed: the round limit belongs to Phase 4's review policy (`maxRounds`). Lane A
enforces only `taskBudget.maxAttempts` as a hard ceiling across retries and repairs.

`run-workflow-input/v1`: ids, risk, `runBudget {maxCostUsd, softCostUsd, maxTasks}`, `governance` defaults,
`requestedBy`, and `fixedTasks: [taskId (ULID)] | null`. When `fixedTasks` is set, the run is created sealed with
exactly those tasks, in order (unique, at most `maxTasks`); when it is null, tasks are submitted and the run is
sealed later by the `seal` control (R21, architecture §4.2).

`workflow-control/v1`: a `oneOf` discriminated by `kind`. It has **no free-text field** (P3-PLAN-MED-003):

```text
pause | resume      { kind, requestId (ULID), target: {scope: 'task'|'run', id (ULID)}, principalId (ULID) }
seal                { kind, requestId (ULID), target: {scope: 'run', id (ULID)}, principalId (ULID) }
approval-decision   { kind, requestId (= decisionId, ULID), approvalRequestId, decision: approve|reject,
                      extensionUsd: number | null, principalId (ULID) }
```

`extensionUsd` is non-null exactly for a `budget-extension` approve. It is positive, at most the policy bound and
exactly representable in micro-USD (checked by the mapping and by the workflow validator); every other decision
carries null (P3-PLAN3-MED-002, architecture §11).

Every string field in the three schemas is constrained by `pattern`, `enum` or `format`. The payload-hygiene
suite fails on any unconstrained string (exit B6). Rationale text, operator names and emails never enter
history; they stay in PostgreSQL. Cancel is not a message. It uses Temporal workflow cancellation, issued by the
API after authorization, and the workflow audits it.

### 4.3 `run-event` 1.1.0 → 1.2.0 (MINOR; one superset bump in S0, R5)

Lane A part: new `eventType` values `approval.requested`, `approval.expired`, `budget.threshold_crossed`. New
optional fields `interventionKind` (`pause|resume|cancel|seal|approval-approve|approval-reject`), `recoveryKind`
(`activity-retry|side-effect-reconciled|fencing-takeover|attempt-replaced|workspace-rehydrated|decision-redelivered`),
`approvalKind` (`budget-extension|publish-change`), `budgetScope` (`attempt|task|run`), `thresholdKind`
(`soft|hard`), `workflowId`.

Lane B part: the SR-C5 fields exactly as locked in Lane B's plan (at `a2a7b8a`: optional `reviewRound`,
`reviewerConfigId`, `reviewMode`, `assuranceOutcome`, `reviewFindingsAdjudicated`, `reviewFindingsBlocking`,
`repairRound`, `repairClosedAllBlocking`, `reviewerFailed`, `shadowWouldBlock`; no new `eventType`). If Lane B's
lock changes SR-C5, S0 takes the locked list.

All of these are additive, so `snapshots/v1` is kept and the compat gate must classify the change as MINOR.
Neither lane bumps `run-event` again in Phase 3/4 without a new reconciliation (R5). The metrics-dictionary
referential-integrity check is updated in lockstep (CR-19).

## 5. Idempotency key catalog (every durable write Phase 3 adds or relies on)

| Write | Key | Duplicate behavior |
|---|---|---|
| attempt row | `(task_id, attempt_number)` | return existing; conflicting identity → non-retryable error |
| lease, fencing, side-effect record + result | the accepted Phase 2 primitive (R1, R2) | per the invariants in plan §30 CR-05 |
| workspace | `workspaces.attempt_id` unique | adopt or quarantine (see §3.4) |
| evidence | preallocated id in commit trailer (Phase 2) | adopt after identity check (`evidence-store.ts:101-135`) |
| approval request | `'<workflowId>:<gateSeq>'` | `insert … on conflict do nothing`, then read back |
| approval decision | `request_id` unique; `id = decisionId` | identical → original receipt + re-delivery; different → 409 |
| decision delivery | `decision_id` (outbox) | relay re-sends; server dedups by `updateId` |
| ledger entry | `(org, project, idempotency_key)` | no-op |
| run event | `(org, project, event_id)` + `payload_sha256` | same bytes → no-op; different bytes → `RunEventConflictError` |
| projection | `projection_seq` | no-op on equal or older seq |
| Temporal start | workflow ID `asep-task-<taskId>` / `asep-run-<runId>`, `USE_EXISTING` | existing handle |
| Temporal update | `updateId` = request/decision ID (server dedup per run) + workflow-side set | original result |

## 6. Shared-constraint hazard (resolved by R6)

v1 asked for a single cross-lane status migration. The controller decided instead (R6): Lane A owns the
`tasks.status` constraint (`0100`), and Lane B owns the `attempts.status` constraint (`02xx`). The two
constraints are independent, and neither lane touches the other's. v1's prediction of Lane B task statuses is
withdrawn: Lane B extends `AttemptStatus`, not `TaskStatus` (P3-PLAN-MED-006).

## 7. Mapping to Phase 2 contracts

- `ExecutionEnvelope/v1` is unchanged. The task workflow builds one per attempt inside `storeAttemptInputs`.
- `WorkOrder`, `ContextPack` and `EvidenceBundle` are unchanged and referenced by `ArtifactRef` only. A repair
  attempt's ContextPack comes from `buildRepairContextPack()` (Lane B) and is stored like any other ContextPack.
- `RunEvent` gets the 1.2.0 minor bump (§4.3).
- No provider SDK type and no Temporal SDK type is persisted. Temporal identifiers are stored as plain text
  (`workflow_id`).
