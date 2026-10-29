# Phase 4 — Data Model (DRAFT v1)

> Companion to `phase-04-plan.md`. PostgreSQL 17 (digest-pinned in `compose.yaml`). Base `00a6889`.
> Conventions inherited from `phase-02-data-model.md` §1: ULID `char(26)` ids, `timestamptz` UTC, optimistic
> `version` columns on mutable aggregates, `TenantScope` first parameter on every repository method, composite
> foreign keys onto `(id, organization_id, project_id)`, append-only checksummed migrations.

## 1. Contract inventory after Phase 4

| Contract | Version | Change | Shared-surface id |
|---|---|---|---|
| `review-report` | 1.0.0 → **2.0.0** (`/v2`) | provenance + re-review closure fields | SR-C1 |
| `finding` | 1.0.0 → **2.0.0** (`/v2`) | `source`, `fingerprint`, grounding, `EVIDENCE_INTEGRITY` category | SR-C2 |
| `review-packet` | **new 1.0.0** | reviewer input | SR-C4 |
| `adjudication-record` | **new 1.0.0** | deterministic decision record | SR-C4 |
| `repair-order` | **new 1.0.0** | repair instruction for the next attempt | SR-C4 |
| `run-event` | 1.1.0 → **1.2.0** | optional assurance fields | SR-C5 |
| `architecture-invariant` | 1.0.0 → **1.1.0** | optional machine-checkable `check` | SR-C6 |

`snapshots/v1/review-report.schema.json` and `snapshots/v1/finding.schema.json` stay byte-identical; v2 copies
are frozen under `snapshots/v2/` and the compat gate selects the snapshot directory by the live `$id` major
(SR-C3). Contract count: 13 → 16.

## 2. Schemas (field-level; JSON Schema draft 2020-12, `additionalProperties: false` everywhere)

### 2.1 `finding/v2`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | yes | report-local key |
| `source` | enum `model, deterministic, sarif` | yes | |
| `fingerprint` | string (64 hex) | yes | sha256(category, normalized path, line bucket, ruleId) — dedup across reviewers in one round |
| `severity` | enum `INFO, LOW, MEDIUM, HIGH, CRITICAL` | yes | unchanged |
| `category` | enum v1 values + `EVIDENCE_INTEGRITY` | yes | |
| `evidence`, `requiredFix` | string, minLength 1 | yes | unchanged |
| `requirementId`, `file`, `lineStart`, `lineEnd` | as v1 | no | |
| `ruleId` | string | no | deterministic/SARIF rule id |
| `grounded` | boolean | no | set by the harness, never by the model |
| `groundingReason` | string | no | |
| `priorFindingId` | string | no | re-review linkage |

### 2.2 `review-report/v2`

Required: `reviewId`, `attemptId`, `round` (int ≥ 1), `reviewKind` (`fresh, re-review`), `packetSha256`,
`reviewerConfigId`, `reviewerConfigSha256`, `requestedModel`, `servedModel`, `rawResponseArtifactId`,
`verdict` (`APPROVE, REQUEST_CHANGES, ESCALATE`), `findings` (`finding/v2[]`), `priorFindingStatuses`
(`[{priorFindingId, status: RESOLVED|PARTIAL|OPEN, evidence, resolutionFile?, resolutionLine?}]`, empty for
fresh). Optional: `confidence` (0..1), `packetCoverage` (`complete, partial`). The canonical report is
produced by the harness from validated model output; the model never writes it directly.

### 2.3 `review-packet/v1`

| Field | Notes |
|---|---|
| `packetVersion` | const `review-packet/v1` |
| `identity` | `{organizationId, projectId, repositoryBindingId, runId, taskId, attemptId, round}` |
| `risk`, `reviewKind` | |
| `workOrder` | `{objective, requirementIds, requirements?[{id, statement, priority}], allowedPaths, forbiddenChanges, architectureInvariants, acceptanceCheckIds}` |
| `change` | `{taskBaseSha, baseSha, resultSha, cumulativeDiff: ArtifactRef, repairDelta: ArtifactRef|null, files: [{path, status, postImage: ArtifactRef|null, lineCount, omittedReason|null}]}` |
| `verification` | `{verdict, checks: [{id, category, verdict}]}` — no raw output |
| `priorFindings` | `finding/v2[]` (re-review only, adjudicated, with ids) |
| `budget` | `{maxBytes, includedBytes, overBudget, omissions: [{path, reason}]}` |

No field exists for coder self-report, ContextPack, events, commit messages or other reviewers' output.

### 2.4 `adjudication-record/v1`

`adjudicationId`, `reviewRoundId`, `attemptId`, `round`, `mode`, `outcome` (`PROCEED, REPAIR, ESCALATE,
BLOCK`), `reason` (escalation/block reason or null), `ruleFired` (1–9, plan §11), `wouldBeOutcome` (shadow
only), `blocking` (`[{findingId, source, severity, reason}]`), `grounding` (`[{findingId, grounded, reason}]`),
`verdictMismatches` (`[{reviewId, verdict, groundedBlockingCount}]`), `closureChecks` (re-review:
`[{priorFindingId, reportedStatus, effectiveStatus, reason}]`), `policyVersion`, `inputs` (`{packetSha256,
checkReportSha256, reviewReportSha256s[]}`).

### 2.5 `repair-order/v1`

`repairOrderId`, `taskId`, `fromAttemptId`, `nextRound`, `taskBaseSha`, `repairBaseSha`, `adjudicationId`,
`blockingFindings` (`finding/v2[]`, each `evidence`/`requiredFix` ≤ 4 KiB, total ≤ 64 KiB — limits are policy
data), `informationalFindings` (same shape, capped), `workOrderRef`.

### 2.6 `run-event` 1.2.0 additions (all optional)

| Field | Type | Used by |
|---|---|---|
| `reviewRound` | integer ≥ 1 | `review.completed`, `repair.started` |
| `reviewerConfigId` | string | dimension |
| `reviewMode` | enum `not-required, shadow, gating` | dimension / filter |
| `assuranceOutcome` | enum `PROCEED, REPAIR, ESCALATE, BLOCK` | filter |
| `reviewFindingsAdjudicated` | integer ≥ 0 | adjudication coverage |
| `reviewFindingsBlocking` | integer ≥ 0 | |
| `repairRound` | boolean | repair success denominator |
| `repairClosedAllBlocking` | boolean | repair success numerator |
| `reviewerFailed` | boolean | reviewer failure rate |
| `shadowWouldBlock` | boolean | shadow would-block rate |

`run-event-catalog.ts` reads the schema, so the dictionary validator picks the fields up without code change.

### 2.7 `architecture-invariant` 1.1.0

Optional `check: { kind: "forbidden-import", fromGlobs: string[], specifierPattern: string }`. Invariants
without `check` are prose and go to the model rubric only.

## 3. Tables (migrations in Lane B range)

### 0200_assurance_reviews

```sql
create table review_rounds (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  task_id               char(26) not null,
  attempt_id            char(26) not null,
  round                 integer not null check (round >= 1),
  review_kind           text not null check (review_kind in ('fresh','re-review')),
  review_mode           text not null check (review_mode in ('not-required','shadow','gating')),
  packet_artifact_id    char(26),
  packet_sha256         text,
  over_budget           boolean not null default false,
  check_report_artifact_id char(26),
  state                 text not null check (state in ('OPEN','ADJUDICATED','SUPERSEDED')),
  prior_round_id        char(26) references review_rounds(id),
  created_at            timestamptz not null default now(),
  version               integer not null default 0,
  foreign key (attempt_id, organization_id, project_id) references attempts (id, organization_id, project_id),
  foreign key (task_id, organization_id, project_id)    references tasks (id, organization_id, project_id),
  unique (task_id, round),
  unique (attempt_id),
  unique (id, organization_id, project_id)
);

create table review_records (
  id                      char(26) primary key,
  organization_id         char(26) not null,
  project_id              char(26) not null,
  review_round_id         char(26) not null,
  review_id               text not null,                       -- deterministic hash id
  reviewer_config_id      text not null,
  reviewer_config_sha256  text not null,
  requested_model         text not null,
  served_model            text,
  state                   text not null check (state in ('PENDING','COMPLETED','FAILED')),
  observation_status      text,
  validity                text check (validity in ('VALID','INVALID')),
  prompt_artifact_id      char(26),
  raw_request_artifact_id char(26),
  raw_response_artifact_id char(26),
  report_artifact_id      char(26),
  provider_request_id     text,
  input_tokens            integer, cached_input_tokens integer, output_tokens integer, reasoning_tokens integer,
  wall_clock_ms           integer, transport_attempts integer,
  duplicate_calls         integer not null default 0,
  cost_usd                numeric,                              -- null when no price is configured
  started_at              timestamptz not null default now(),
  completed_at            timestamptz,
  version                 integer not null default 0,
  foreign key (review_round_id, organization_id, project_id) references review_rounds (id, organization_id, project_id),
  unique (organization_id, project_id, review_id),
  unique (id, organization_id, project_id)
);

create table review_findings (
  id                char(26) primary key,
  organization_id   char(26) not null,
  project_id        char(26) not null,
  review_round_id   char(26) not null,
  review_record_id  char(26),                                   -- null for deterministic/SARIF findings
  source            text not null check (source in ('model','deterministic','sarif')),
  finding_key       text not null,
  fingerprint       text not null,
  severity          text not null check (severity in ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  category          text not null,
  file              text, line_start integer, line_end integer, requirement_id text, rule_id text,
  evidence          text not null,
  required_fix      text not null,
  grounded          boolean not null,
  grounding_reason  text,
  blocking          boolean not null,
  prior_finding_id  char(26) references review_findings(id),
  lifecycle_state   text not null check (lifecycle_state in
    ('OPEN','ACKNOWLEDGED','FIXED','VERIFIED','CLOSED','REFUTED','ADJUDICATED','WAIVED')),
  created_at        timestamptz not null default now(),
  version           integer not null default 0,
  foreign key (review_round_id, organization_id, project_id) references review_rounds (id, organization_id, project_id),
  foreign key (review_record_id, organization_id, project_id) references review_records (id, organization_id, project_id),
  unique (id, organization_id, project_id)
);

create table finding_dispositions (                              -- append-only
  id               char(26) primary key,
  organization_id  char(26) not null,
  project_id       char(26) not null,
  finding_id       char(26) not null,
  disposition      text not null check (disposition in
    ('ACCEPTED','REJECTED_WITH_EVIDENCE','WAIVED','RESOLVED','PARTIAL','OPEN')),
  actor_kind       text not null check (actor_kind in ('human','harness-rule','reviewer')),
  actor            text not null,                               -- named human, rule id, or reviewerConfigId
  finding_severity text not null,                               -- denormalized so the waiver rule is a CHECK
  rationale        text not null,
  evidence_artifact_id char(26),
  expires_at       timestamptz,
  signature        text,                                        -- ed25519, same scheme as human_authorizations
  created_at       timestamptz not null default now(),
  check (disposition <> 'WAIVED' or (actor_kind = 'human' and expires_at is not null and signature is not null)),
  check (actor_kind <> 'reviewer' or disposition in ('RESOLVED','PARTIAL','OPEN')),
  check (actor_kind <> 'harness-rule' or disposition = 'REJECTED_WITH_EVIDENCE'),
  foreign key (finding_id, organization_id, project_id) references review_findings (id, organization_id, project_id)
);

create table adjudications (
  id                   char(26) primary key,
  organization_id      char(26) not null,
  project_id           char(26) not null,
  review_round_id      char(26) not null unique,
  adjudication_id      text not null,                            -- deterministic hash id
  outcome              text not null check (outcome in ('PROCEED','REPAIR','ESCALATE','BLOCK')),
  reason               text,
  rule_fired           integer not null check (rule_fired between 1 and 9),
  would_be_outcome     text,
  review_mode          text not null,
  blocking_count       integer not null,
  policy_version       text not null,
  record_artifact_id   char(26) not null,
  record_sha256        text not null,
  repair_order_artifact_id char(26),
  created_at           timestamptz not null default now(),
  foreign key (review_round_id, organization_id, project_id) references review_rounds (id, organization_id, project_id),
  unique (organization_id, project_id, adjudication_id)
);

create table reviewer_promotions (
  id                     char(26) primary key,
  organization_id        char(26) not null,
  project_id             char(26) not null,
  reviewer_config_id     text not null,
  reviewer_config_sha256 text not null,                         -- any config change invalidates the promotion
  mode                   text not null check (mode = 'gating'),
  scorecard_sha256       text not null,
  scorecard_ref          text not null,                         -- repo path of the committed scorecard
  approved_by            text not null,
  rationale              text not null,
  approved_at            timestamptz not null default now(),
  expires_at             timestamptz not null,
  signature              text not null,
  revoked_at             timestamptz,
  foreign key (project_id, organization_id) references projects (id, organization_id)
);
```

(Artifact columns additionally carry composite FKs onto `artifacts (id, organization_id, project_id)`, as
`0009_scoped_evidence_refs` does; omitted above for brevity, required in the migration.)

### 0201_run_events

```sql
create table run_events (
  organization_id  char(26) not null,
  project_id       char(26) not null,
  event_id         text not null,
  event_type       text not null,
  schema_version   text not null,
  occurred_at      timestamptz not null,
  run_id           text not null,
  task_id          text, attempt_id text,
  payload          jsonb not null,          -- the full validated RunEvent
  payload_sha256   text not null,
  inserted_at      timestamptz not null default now(),
  primary key (organization_id, project_id, event_id)
);
create index run_events_type_time on run_events (organization_id, project_id, event_type, occurred_at);
-- append-only: a trigger raises on UPDATE or DELETE
```

### 0202_metric_snapshots

```sql
create table metric_snapshots (
  id                 char(26) primary key,
  organization_id    char(26) not null,
  project_id         char(26) not null,
  metric_name        text not null,
  dictionary_version text not null,
  evaluator_version  text not null,
  window_start       timestamptz not null,
  window_end         timestamptz not null,
  dimensions         jsonb not null,           -- canonical, sorted keys
  dimensions_sha256  text not null,
  value              numeric,                  -- null when the zero-denominator policy says so
  numerator          numeric,
  denominator        numeric,
  null_reason        text,
  privacy_class      text not null,
  source_event_count integer not null,
  computed_at        timestamptz not null,
  unique (organization_id, project_id, metric_name, window_start, window_end, dimensions_sha256, dictionary_version)
);
```

Retention follows the dictionary privacy class (`retentionDays`); `restricted` metrics are computed only when
capture is enabled for the project.

### 0203_attempt_review_states

Drops and recreates the `attempts.status` check constraint with the Phase 2 values plus `UNDER_REVIEW` and
`CHANGES_REQUESTED`. The constraint name is read from `pg_constraint` at implementation time, not assumed.
Must be reconciled with any Lane A change to the same constraint (plan §17.3, SR-M4).

## 4. State machines

### Review round

```text
OPEN → ADJUDICATED → SUPERSEDED (when the next round for the task opens)
```

### Review record

```text
PENDING → COMPLETED (validity VALID | INVALID) | FAILED
PENDING → PENDING   (resume re-call; duplicate_calls += 1)
```

### Finding lifecycle (from `docs/architecture/04-state-machines.md:40-48`, made executable)

```text
OPEN → ACKNOWLEDGED → FIXED → VERIFIED → CLOSED
OPEN → REFUTED → ADJUDICATED
OPEN → WAIVED          (human only, rationale + expiry + signature)
```

Rules: a model actor may only report `RESOLVED/PARTIAL/OPEN` closure statuses, which move a finding to
`VERIFIED` or keep it `OPEN`; `REFUTED` by `harness-rule` only for ungrounded findings; a model can never waive
or refute a grounded HIGH/CRITICAL finding; an expired waiver returns the finding to `OPEN`.

### Attempt (delta, SR-C7/SR-X2)

```text
COMMITTED → UNDER_REVIEW → PUSHED        (PROCEED / ESCALATE)
UNDER_REVIEW → CHANGES_REQUESTED         (REPAIR; terminal for this attempt)
UNDER_REVIEW → BLOCKED                   (BLOCK; existing interrupt state)
COMMITTED → PUSHED                       (kept: pipelines without the slot)
```

Task status is unchanged: it stays `VERIFYING` across repair rounds and ends `WAITING_FOR_HUMAN_REVIEW`,
`BLOCKED` or `FAILED` as in Phase 2.

## 5. Metrics dictionary additions (SR-C5, plan §17.7)

| Metric | Formula | Zero-denominator policy | Privacy |
|---|---|---|---|
| `review_adjudication_coverage` | `sum(review.completed.reviewFindingsAdjudicated) / sum(review.completed.reviewFindingsTotal)` | `report-null-when-no-findings` | operational |
| `repair_success_rate` | `count(review.completed where repairRound=true and repairClosedAllBlocking=true) / count(review.completed where repairRound=true)` | `report-null-when-no-repairs` | operational |
| `reviewer_failure_rate` | `count(review.completed where reviewerFailed=true) / count(review.completed)` | `report-null-when-no-reviews` | operational |
| `shadow_would_block_rate` | `count(review.completed where reviewMode=shadow and shadowWouldBlock=true) / count(review.completed where reviewMode=shadow)` | `report-null-when-no-shadow-reviews` | operational |
| `review_escalation_rate` | `count(review.completed where assuranceOutcome=ESCALATE) / count(review.completed)` | `report-null-when-no-reviews` | operational |
| `mean_review_cost_usd` | `mean(review.completed.reviewCostUsd)` | — | restricted |

Existing metrics consumed unchanged: `false_completion_rate`, `review_finding_yield`,
`review_false_positive_rate`, `escaped_defect_rate` (null until post-merge defect mapping exists),
`cost_per_accepted_task`, `workflow_recovery_rate`, `repair_cycles_per_task`, `first_attempt_pass_rate`,
`human_intervention_rate`.

Event emission points (Lane B steps):

| Event | Emitted by | Key fields |
|---|---|---|
| `attempt.declared_complete` | `recordAttemptOutcome` | `declaredComplete`, `passedRequiredAssurance` = verification PASS ∧ outcome ∈ {PROCEED} (gating) or ∉ {BLOCK} (not-required/shadow) |
| `attempt.completed` | `recordAttemptOutcome` | `outcome`, `failureClass`, `modelCostUsd` (coder), `reviewCostUsd` (sum for the attempt, omitted when unpriced) |
| `review.completed` | `adjudicateRound` (round close) | totals, `reviewFindingsValid` (accepted dispositions), `reviewFindingsFalsePositive` (rejected), `reviewFindingsAdjudicated`, round/mode/outcome fields |
| `repair.started` | `adjudicateRound` on REPAIR | `reviewRound` = next round |
| `task.completed`, `human.intervention` | `recordTaskDisposition`, `recordFindingDisposition` (human) | `outcome`, `repairCycles` |

Because `RunEvent`s are immutable, `review.completed` is emitted when the round closes; later human
dispositions update the operational tables and are reflected in the next round's or the task's events, never
by rewriting an event. Adjudication coverage makes the unadjudicated remainder visible.

## 6. Policy data (`policies/review-policy.yaml`)

```yaml
apiVersion: asep.policy/v1
kind: ReviewPolicy
version: 1.0.0
modelFamilies:              # longest-prefix match on the pinned model id; unknown → fail closed
  - { family: anthropic-claude, prefixes: [claude-] }
  - { family: openai-gpt,       prefixes: [gpt-] }
reviewers:                  # pinned configurations; secrets never appear here
  - id: openai-responses-primary
    providerId: openai-responses
    model: gpt-5.6-sol
    reasoningEffort: high
    maxOutputTokens: 16000
    packetBudgetBytes: 400000
    pricing: null           # set from the provider's published price list with source + date, or leave null
modes:                      # per risk; gating requires a valid promotion record, else the risk is DEFERRED
  R0: not-required
  R1: shadow
  R2: gating
  R3: deferred
  R4: deferred
maxRounds:          { R1: 2, R2: 2 }
blockingSeverities: { R1: [CRITICAL, HIGH], R2: [CRITICAL, HIGH, MEDIUM] }
groundingMinChars:  { evidence: 40, requiredFix: 20 }
repairOrderLimits:  { perFieldBytes: 4096, totalBytes: 65536 }
```

All numeric values are proposals pending decision D-7. A parity test asserts the TypeScript loader and this
file agree, and that `approval-matrix.yaml`/`verification-matrix.yaml` are unchanged.

## 7. Corpus and scorecard data (Lane B owned, `evals/`)

### 7.1 Corpus item (`evals/review-corpus/self-history/items/<id>.json`)

| Field | Notes |
|---|---|
| `id` | `<findingId>@<reviewedSha7>` |
| `findingId`, `phase`, `cycle`, `reviewKind` (`final, rereview`) | |
| `reviewedSha` | full 40-hex; `reviewedShaSource` (`recorded-in-review`, `derived`, `unknown`) |
| `reachable` | from advertised refs at freeze time |
| `fixCommits[]`, `postFixSha` | commits whose subject carries the id |
| `confirmation` | `{doc, status: RESOLVED|PARTIAL|REGRESSED|null}` from the later re-review |
| `severity`, `category`, `defectClass` (`code, test-adequacy, gate-config, claim-integrity, build`) | |
| `locations[]` | `{file, lineStart, lineEnd}` as cited at `reviewedSha` |
| `labelSource` | `codex-gpt-5.6-sol`, `implementer-self-found`, `controller-paraphrase` |
| `labelQuality` | `primary`, `secondhand` |
| `labellerMiss` | true when found later at a tree an earlier cycle reviewed, or self-found |
| `instanceKind` | `first-occurrence`, `residual` |
| `split` | `dev` (Phase 1), `test` (Phase 2) |
| `provenance` | `{doc, line}` for the label text |
| `excluded` | null or `{reason: tree-unreachable | not-in-packet | plan-defect | ...}` |
| `humanVerified` | null or `{by, at, agrees}` |

The manifest (`manifest.json`) lists item ids, the packet rule version, matcher parameters, split counts, the
exclusion table and `corpusSha256`.

### 7.2 Recorded run (`evals/review-benchmark/recorded/<runId>/`)

`run.json` (descriptor, protocol sha, corpus sha, split, k, started/finished timestamps) plus one file per
(item, run index) holding the observation and raw response bytes (base64) with a `manifest.sha256`. Each file
stays under the 500 KiB large-file limit (`scripts/large-file-scan.sh:16`); the recording is scanned by the
secret and PII gates like any tracked file.

### 7.3 Scorecard (`evals/review-benchmark/scorecards/<runId>.json`)

`scope` (`self-history`, `pilot-history`, `synthetic-injection`), hashes (corpus, protocol, descriptor,
recordings), denominators (eligible, excluded by reason), per metric `{value, n, wilson95: [lo, hi]}` for:
recall strict/lenient (all, first-occurrence, labeller-miss subset, per severity, per defect class), precision
over adjudicated findings + unadjudicated count, stale-flag rate on post-fix trees, k-run stability, malformed
/refusal/failure rates, tokens, cost (or null), latency; baselines (`null-reviewer`, `deterministic-only`);
injection-suite deltas (separate scope). Keys sorted; no wall-clock fields inside the scored section.
