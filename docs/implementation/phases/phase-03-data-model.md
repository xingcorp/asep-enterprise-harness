# Phase 3 — Data Model (DRAFT, pending plan review)

> Companion to `phase-03-plan.md`. PostgreSQL 17 (same digest-pinned image as Phase 2). Base `00a6889`.
> Lane A migration range: **`0100`–`0199`** (lane contract). Migrations are append-only, checksummed and applied
> in lexicographic order by the Phase 2 migrator (`adapters/persistence/src/migrator.ts`). Phase 2's `0001`–`0012`
> (`adapters/persistence/src/migrations.ts:425-438`) and any Phase 2 repairs in `0013`–`0099` apply first.
> Lane B's `0200`+ apply after. Every table follows the Phase 2 conventions (`phase-02-data-model.md` §1):
> `char(26)` ULID keys, `timestamptz` UTC, `version` optimistic column on mutable rows, composite FKs onto
> `(id, organization_id, project_id)`, and `TenantScope` as the first parameter of every repository method.

## 1. What lives where

| Fact | Store | Authority |
|---|---|---|
| Which phase a task/run is in, timers, pending approvals, paused flag, budget arithmetic | Temporal history | **Temporal** |
| Projected task/attempt/run status (for queries and humans) | PostgreSQL `tasks`/`attempts`/`runs` columns | projection (rebuildable from workflow history plus the records below) |
| Attempt identity and ordinal, lease, fencing epoch, side-effect records, workspace registry | PostgreSQL | PostgreSQL (idempotency and fencing truth that activities need across worker deaths) |
| Approval requests and human decisions | PostgreSQL | PostgreSQL is the **evidence** of who decided what. Temporal decides **when to act** on a verified decision. |
| Budget ledger entries | PostgreSQL | PostgreSQL ledger (append-only). The workflow keeps the running total, and the two are reconciled in tests. |
| Run events | PostgreSQL `run_events` | append-only telemetry |

## 2. Migration set (Lane A, proposed; CR-11)

```text
0100_orchestration_task_status     extend tasks.status CHECK with PAUSED, WAITING_FOR_APPROVAL,
                                    BUDGET_EXHAUSTED   (COORDINATE: Lane B may add REVIEWING/REPAIRING;
                                    controller should merge into ONE constraint migration, see §6)
0101_workflow_bindings_projection  tasks/runs/attempts: workflow_id, projection_seq, projection_updated_at
0102_attempt_ordinal_fencing       attempts: attempt_number, attempt_kind, parent_attempt_id,
                                    repair_order_artifact_id (+ sha256), fencing_epoch; unique (task_id, attempt_number)
0103_side_effect_epochs            side_effect_records: owner_epoch, taken_over_from, taken_over_at
0104_workspaces                    workspaces registry (rehydration after worker restart)
0105_approvals                     approval_requests, approval_decisions
0106_budget_ledger                 budget_ledger; runs: budget + governance columns
0107_run_events                    run_events (append-only, schema-validated before insert)
                                    (COORDINATE: Lane B dashboards consume it; Lane B must not create a second one)
```

All are `ALTER`/`CREATE` only. No Phase 2 migration text changes, so recorded checksums stay valid. Each runs in
a transaction under the advisory lock. Each is forward-tested on a clean database and re-applied as a no-op
(Phase 2 rules, `phase-02-data-model.md` §5).

## 3. Tables and columns

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
deterministic workflow ID `asep-task-<taskId>` give one workflow per task.

### 3.2 `attempts` — ordinal, kind, repair input, fencing (0102)

```sql
alter table attempts
  add column attempt_number integer,
  add column attempt_kind text check (attempt_kind in ('initial','retry','repair')),
  add column parent_attempt_id char(26),
  add column repair_order_artifact_id char(26),
  add column repair_order_sha256 text,
  add column fencing_epoch bigint not null default 0,
  add constraint attempts_parent_scoped_fk foreign key (parent_attempt_id, organization_id, project_id)
    references attempts (id, organization_id, project_id),
  add constraint attempts_repair_order_scoped_fk foreign key (repair_order_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id);
-- backfill Phase 2 rows: attempt_number = row_number() over (partition by task_id order by started_at, id),
--                        attempt_kind = 'initial'
alter table attempts alter column attempt_number set not null,
                     alter column attempt_kind set not null;
create unique index attempts_task_ordinal on attempts (task_id, attempt_number);
```

- `ensureAttempt(scope, {taskId, attemptNumber, kind, parentAttemptId?, repairOrderRef?})` inserts or returns
  the existing row for `(task_id, attempt_number)`. A mismatched `kind`, parent or repair order on an existing
  ordinal raises `AttemptIdentityConflictError` (non-retryable). The engine-retry duplicate-row hazard is closed
  by the natural key, not by luck.
- `fencing_epoch` is advanced only by `AttemptFence.claim`:
  `update attempts set fencing_epoch = fencing_epoch + 1 where … returning fencing_epoch`.

### 3.3 `side_effect_records` — epochs (0103)

```sql
alter table side_effect_records
  add column owner_epoch bigint not null default 0,
  add column taken_over_from text,
  add column taken_over_at timestamptz;
```

Semantics are in architecture §7. A takeover is one `UPDATE … WHERE state = 'PENDING' AND owner_epoch < $e AND version = $v`
and is audited (`side-effect.takeover`). Phase 2 rows default to epoch 0, so a Phase 3 executor (epoch ≥ 1) can
take over a stranded Phase 2 `PENDING` row and reconcile it by natural key.

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
  base_sha              text not null check (base_sha ~ '^[0-9a-f]{40}$'),
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
- `path_rel` is the Phase 2 containment-checked relative path (`worktree-manager.ts:110-114`). Absolute paths
  are never stored.
- `workspace_leases.workspace_id` (Phase 2, minted independently at `lease-repository.ts:43`) is now set from
  the registry: `prepareWorkspace` updates the lease row to point at `workspaces.id`, which resolves the
  two-ID mismatch.

### 3.5 `approval_requests`, `approval_decisions` (0105)

```sql
create table approval_requests (
  id              text primary key,             -- deterministic: '<workflowId>:<gateSeq>'
  organization_id char(26) not null,
  project_id      char(26) not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  workflow_id     text not null,
  kind            text not null check (kind in ('budget-extension','publish-change','review-adjudication')),
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
  decision        text not null check (decision in ('approve','reject','request-repair')),
  decided_by      text not null,                -- authenticated human principal id
  rationale       text not null check (length(rationale) between 1 and 4000),
  extension_usd   numeric check (extension_usd is null or extension_usd > 0),
  decided_at      timestamptz not null default now(),
  check (decided_by <> 'harness'),
  foreign key (request_id, organization_id, project_id)
    references approval_requests (id, organization_id, project_id)   -- scope-coherent, as in Phase 2
);
```

- `requested_by <> decided_by` is enforced in the application use case (the API) and asserted by test I4. It is
  not a DB check, because `requested_by` may be `'harness'`.
- `approval_decisions.request_id` is unique, so a second decision insert fails at the database. The API maps
  that to 409 unless the body is byte-identical to the stored one, which returns the original receipt
  (idempotent retry).

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
  add column created_by           text;
```

### 3.7 `run_events` (0107)

```sql
create table run_events (
  event_id        text primary key,             -- '<workflowId>:<seq>' (deterministic, so a retried insert is a no-op)
  organization_id char(26) not null,
  project_id      char(26) not null,
  run_id          char(26) not null,
  task_id         char(26),
  attempt_id      char(26),
  event_type      text not null,
  schema_version  text not null,                -- 'run-event/1.2.0'
  occurred_at     timestamptz not null,
  body            jsonb not null,               -- the full RunEvent, validated against the schema BEFORE insert
  foreign key (run_id, organization_id, project_id) references runs (id, organization_id, project_id)
);
create index run_events_type_time on run_events (organization_id, project_id, event_type, occurred_at);
```

## 4. Contract changes (shared; CR-01 … CR-03)

### 4.1 `TaskStatus` (hand-authored in `packages/contracts/src/base.ts:38-40`)

Add `PAUSED`, `WAITING_FOR_APPROVAL`, `BUDGET_EXHAUSTED`. Transition table changes in
`packages/domain/src/operational.ts:28-39`:

```text
READY / EXECUTING / VERIFYING  → PAUSED, WAITING_FOR_APPROVAL      (in addition to Phase 2 edges)
PAUSED                         → READY, EXECUTING, VERIFYING, BLOCKED, CANCELLED
WAITING_FOR_APPROVAL           → READY, EXECUTING, VERIFYING, BLOCKED, BUDGET_EXHAUSTED, CANCELLED
READY / EXECUTING              → BUDGET_EXHAUSTED
BUDGET_EXHAUSTED               → (terminal)
WAITING_FOR_HUMAN_REVIEW       → (terminal for the harness; unchanged; still no ACCEPTED/DONE)
```

`isTaskTerminal` gains `BUDGET_EXHAUSTED`. The Phase 2 table test (`packages/domain/src/operational.test.ts`) is
extended, not weakened. The invariant test that no machine transition reaches an accepted state stays
byte-identical.

### 4.2 New canonical schemas (CR-02)

`task-workflow-input/v1` (`$id https://asep.dev/schema/task-workflow-input/v1`), required fields:

```text
schemaVersion: "1.0.0"
organizationId, projectId, repositoryBindingId, runId, taskId     (ids)
risk: R0..R4
baseSha: 40-hex
workOrderRef: ArtifactRef            (WorkOrder already stored and validated)
contextPackRef: ArtifactRef
attemptBudget: Budget                (must equal WorkOrder.budget; checked by the first activity)
taskBudget: { maxAttempts 1..10, maxCostUsd > 0, softCostUsd ≤ maxCostUsd, maxWallClockMinutes > 0 }
runRemaining: { costUsd ≥ 0 }
verification: { planId, checks: [{ id, level L0..L9, category, mandatory, commandId }] }   (no shell strings)
governance: { publicationApprovalRequired, approvalTtlSeconds 60..604800, maxRepairCycles 0..5,
              maxPauseHours 1..168, requestedBy }
```

`run-workflow-input/v1`: ids, risk, `runBudget {maxCostUsd, softCostUsd, maxTasks}`, `governance` defaults and
`requestedBy`.

`workflow-control/v1`: a `oneOf` discriminated by `kind`:

```text
pause | resume  { kind, requestId, target: {scope: 'task'|'run', id}, principalId, reason }
approval-decision { kind, requestId (= decisionId), approvalRequestId, decision, principalId }
```

Cancel is not a message. It uses Temporal workflow cancellation, issued by the API after authorization and audited.

### 4.3 `run-event` 1.1.0 → 1.2.0 (MINOR; CR-03)

New `eventType` values: `approval.requested`, `approval.expired`, `budget.threshold_crossed`. New optional fields:
`interventionKind` (`pause|resume|cancel|approval-approve|approval-reject|approval-request-repair`),
`recoveryKind` (`activity-retry|side-effect-reconciled|fencing-takeover|attempt-replaced|workspace-rehydrated`),
`approvalKind`, `budgetScope` (`attempt|task|run`), `thresholdKind` (`soft|hard`), `workflowId`. All of these
are additive, so `snapshots/v1` is kept and the compat gate must classify the change as MINOR. The
metrics-dictionary referential-integrity check is updated in lockstep (CR-19).

## 5. Idempotency key catalog (every durable write Phase 3 adds)

| Write | Key | Duplicate behavior |
|---|---|---|
| attempt row | `(task_id, attempt_number)` | return existing; conflicting identity → non-retryable error |
| lease | ACTIVE `(binding, branch)` + `attempt_id` | adopt if same attempt; deny if another attempt |
| workspace | `attempts.attempt_id` unique | adopt or quarantine (see §3.4) |
| side effects | `(org, project, scope, attemptId:operation)` (Phase 2) + `owner_epoch` | adopt / take over / fence |
| evidence | preallocated id in commit trailer (Phase 2) | adopt after identity check |
| approval request | `'<workflowId>:<gateSeq>'` | `insert … on conflict do nothing`, then read back |
| approval decision | `request_id` unique; `id = decisionId` | identical → original receipt; different → 409 |
| ledger entry | `(org, project, idempotency_key)` | no-op |
| run event | `event_id = '<workflowId>:<seq>'` | no-op |
| projection | `projection_seq` | no-op on equal or older seq |
| Temporal start | workflow ID `asep-task-<taskId>` / `asep-run-<runId>`, `USE_EXISTING` | existing handle |
| Temporal update | `updateId` = request/decision ID (server dedup per run) + workflow-side set | original result |

## 6. Shared-constraint hazard (raised for the controller)

`tasks.status` has one CHECK constraint (`migrations.ts:87-88`). If Lane A's `0100` and a Lane B `02xx` each
`DROP` and `ADD` that constraint with their own value set, the later migration silently removes the earlier
lane's values. Lane A asks the controller to own a **single** status-extension migration that contains the
union of both lanes' values, numbered in whichever range the controller chooses. `0100` is then withdrawn or
reduced to Lane A's non-status changes. The same applies to `TaskStatus` in `base.ts`.

## 7. Mapping to Phase 2 contracts

- `ExecutionEnvelope/v1` is unchanged. The task workflow builds one per attempt inside `storeAttemptInputs`.
- `WorkOrder`, `ContextPack` and `EvidenceBundle` are unchanged and referenced by `ArtifactRef` only.
- `RunEvent` gets the 1.2.0 minor bump (§4.3).
- No provider SDK type and no Temporal SDK type is persisted. Temporal identifiers are stored as plain text
  (`workflow_id`).
