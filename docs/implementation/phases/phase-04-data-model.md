# Phase 4 — Data Model (LOCKED v7, pending controller confirmation)

> Companion to `phase-04-plan.md`. PostgreSQL 17 (digest-pinned in `compose.yaml`). Base `00a6889`; v1 reviewed at
> `a2a7b8a`; v2 lock-checked at `3201335`; v3 reviewed at `9e3a1c3` (v4: §2.1 identity, §2.3 budget, §2.4 closure
> rules, §2.8 scanner runs, `review_findings` identity, disposition actor rules, §7.1 vocabulary); v4 re-checked at
`7cc20f4` (v5: §2.1 identity encoding, §2.3 budget outside the hashed packet, §2.4 adjudication id, §2.8 effective
scanner runs, `review_rounds.packet_included_bytes`, `prompt-over-budget` and integer micro-USD cost in
`review_records`, money in events); v5 re-checked at `fb2e432` (v6, R32: §2.1 and `review_findings` unresolved-reference
flag, §2.3 `includedBytes` as the stored size, §2.4 and `finding_dispositions_harness_verify_ck` without scanner-recheck
closure, §2.8 without scanner runs); v6 re-checked at `d0907b9` (v7, R37: §2.1 and `review_findings` without the
unresolved-reference flag and with `review_findings_sarif_ck`, §2.8 one `sarif-unparsed` finding per SARIF log,
`finding_dispositions_sarif_ck`: no machine disposition of a SARIF finding but a harness reopen). Conventions inherited from `phase-02-data-model.md` §1: ULID `char(26)` ids, `timestamptz` UTC,
> optimistic `version` columns on mutable aggregates, `TenantScope` first on every repository method, composite
> foreign keys onto `(id, organization_id, project_id)`, append-only checksummed migrations
> (`adapters/persistence/src/migrator.ts`: strictly ascending ids, checksum per applied id). v2 writes the full DDL
> with constraint names, indexes, trigger functions and rollback SQL (P4-PLAN-MED-003).

## 1. Contract inventory after Phase 4 (Lane B additions only; no cross-lane total, R7)

| Contract | Version | Change | Request |
|---|---|---|---|
| `review-finding` | **new 1.0.0** (`…/review-finding/v1`) | canonical finding with source, raiser, fingerprint, grounding, lifecycle | SR-C2 |
| `review-record` | **new 1.0.0** (`…/review-record/v1`) | canonical, harness-produced review record with provenance and closure claims | SR-C1 |
| `review-packet` | **new 1.0.0** | reviewer input incl. execution manifest | SR-C4 |
| `adjudication-record` | **new 1.0.0** | deterministic decision record | SR-C4 |
| `repair-order` | **new 1.0.0** | repair instruction for the next attempt (drill only in Phase 4) | SR-C4 |
| `architecture-invariant` | 1.0.0 → **1.1.0** | optional machine-checkable `check` | SR-C6 |
| `run-event` | 1.1.0 → **1.2.0** | Lane B's part of the S0 superset (plan §18.4) | SR-S0-3 |
| `review-report`, `finding` | **unchanged 1.0.0** | legacy; no producer in Phase 4 | — |

Lane B adds five schema files; the compat-gate count and `COMPATIBILITY.md` are updated for those only.
`packages/contracts/src/validate.ts` gains the five `ContractName` values.

## 2. Schemas (JSON Schema draft 2020-12, `additionalProperties: false` everywhere)

### 2.1 `review-finding/v1`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | yes | record-local key |
| `source` | enum `model, deterministic, sarif` | yes | |
| `raisedBy` | string | yes | `reviewerConfigId`, `deterministic:<ruleId>`, or `sarif:unparsed` (the only SARIF raiser in Phase 4, R37) |
| `fingerprint` | string, 64 hex | yes | sha256(category, normalized path, line bucket, ruleId) |
| `severity` | enum `INFO, LOW, MEDIUM, HIGH, CRITICAL` | yes | |
| `category` | enum `SPEC, ARCHITECTURE, CORRECTNESS, SECURITY, PERFORMANCE, TEST_QUALITY, MAINTAINABILITY, EVIDENCE_INTEGRITY` | yes | |
| `evidence`, `requiredFix` | string, 1–8192 chars | yes | |
| `grounded` | boolean | yes | set by the harness, never by a model |
| `groundingReason` | string | no | required when `grounded` is false |
| `lifecycleState` | enum `OPEN, ACKNOWLEDGED, FIXED, VERIFIED, CLOSED, REFUTED, ADJUDICATED, WAIVED` | yes | `docs/architecture/04-state-machines.md:40-48` |
| `requirementId`, `file`, `lineStart`, `lineEnd`, `ruleId`, `priorFindingId` | | no | `file` a normalized repo path (plan §10.1); `priorFindingId` links a re-raised finding to the prior it matched (plan §12) |

Identity within a round (plan §12): `(raisedBy, fingerprint, requirementId, finding key)`; findings are never merged
across requirement ids or keys, and a merge keeps grounded and the highest severity. Identity across rounds, for
reconciliation with prior findings: `(raisedBy, fingerprint, requirementId)`. Every such tuple, and the fingerprint
itself (`[category, file|null, lineBucket|null, ruleId|null]`), is encoded as a canonical JSON array before it is
hashed or compared, never as a joined string, so `null` and `""` differ and a separator inside a field cannot make
two tuples equal (R28). A re-raise linked to a prior it does not shield blocks at the highest severity of the pair
(plan §12). A SARIF finding is the `sarif-unparsed` finding of one log (R37, plan §14 item 6): `ruleId`
`sarif-unparsed`, severity `HIGH`, category `EVIDENCE_INTEGRITY`, no `file` or lines, `grounded: true`, and the
fingerprint `[EVIDENCE_INTEGRITY, subject, null, "sarif-unparsed"]` with `subject` the canonical JSON text of
`["sarif-log", checkId, sha256]`, so each log, and each new log of the same check, is its own finding.

### 2.2 `review-record/v1`

Required: `reviewId` (64 hex), `roundKey`, `attemptId`, `round` (≥ 1), `reviewKind` (`fresh, re-review`),
`reviewerConfigId`, `reviewerConfigSha256`, `reviewerRole` (`primary, comparator`), `requestedModel`,
`resolvedFamily`, `servedModel`, `packetSha256`, `promptSha256`, `rawRequestArtifactId`, `rawResponseArtifactId`,
`validity` (`VALID, INVALID`), `verdict` (`APPROVE, REQUEST_CHANGES, ESCALATE`, null when invalid), `findings`
(`review-finding/v1[]`), `priorFindingClaims` (`[{priorFindingId, status: RESOLVED|PARTIAL|OPEN, evidence,
resolutionFile|null, resolutionLine|null}]`, empty for fresh), `usage` (`{inputTokens, cachedInputTokens,
outputTokens, reasoningTokens, wallClockMs, transportAttempts}`), `providerCalls` (≥ 1), `gatewayAlteration` (`{status: altered|unaltered|unknown, appendedBytes|null, appendedSha256|null, appendixArtifactId|null, toolsAttributed|null, attributedFields[]}`). Optional: `confidence`
(0..1), `packetCoverage` (`complete, partial`). Produced by the harness from validated model output only.

### 2.3 `review-packet/v1`

| Field | Notes |
|---|---|
| `packetVersion` | const `review-packet/v1` |
| `identity` | `{organizationId, projectId, repositoryBindingId, runId, taskId, attemptId, round, roundKey}` |
| `risk`, `reviewKind` | |
| `workOrder` | `{objective, requirementIds, requirements?[{id, statement, priority}], allowedPaths, forbiddenChanges, architectureInvariants, acceptanceCheckIds}` |
| `change` | `{taskBaseSha, resultSha, repairBaseSha|null, cumulativeDiff: ArtifactRef, repairDelta: ArtifactRef|null, files: [{path, status, binary, postImage: ArtifactRef|null, lineCount, omittedReason|null}]}`; `omittedReason` ∈ `binary, too-large, deleted, submodule, non-utf8, unsafe-path` (`unsafe-path`: a path that is not normalizable, kept so the push guard blocks on it, never read) |
| `execution` | `{verdict: PASS|FAIL|ERROR|NOT_RECORDED, environment: {imageDigest, lockfileHash, nodeVersion|null}|null, checks: [{id, category, command, exitCode, durationMs, stdout: {artifactId, sha256, bytes, excerptTail}|null, stderr: (same)|null, testSummary: {runner, tests, pass, fail, skipped, todo}|null}]}`; `NOT_RECORDED` (with `environment: null`, `checks: []`) is used only by corpus packets (plan §7.8), never at runtime |
| `priorFindings` | `review-finding/v1[]` (re-review only, adjudicated, with ids and lifecycle state) |
| `budget` | `{maxBytes, overBudget, omissions: [{path, reason}]}`. The packet does not carry its own measured size (R28): `includedBytes` = UTF-8 length of the **stored** canonical packet bytes, measured after `overBudget` is set, plus the bytes of the cumulative diff, the repair delta and every post-image the prompt embeds, for accepted and rejected packets alike (R32), recorded alongside (`BuildReviewPacketOutput.includedBytes`, `review_rounds.packet_included_bytes`); `overBudget` = the packet as it would be sent (carrying `false`) plus those parts exceeds `maxBytes`, or a diff over its reader limit, so an accepted packet's `includedBytes` is at most `maxBytes` and a rejected packet's stored `true` is one byte shorter than the `false` it was measured with; the rendered prompt is measured separately against `maxBytes` (plan §8); the slot step returns only the omission count (`omittedFiles`), the list stays here |

No field exists for coder self-report, ContextPack, events, commit messages or other reviewers' output.

### 2.4 `adjudication-record/v1`

`adjudicationId`, `roundKey`, `reviewRoundId`, `attemptId`, `round`, `mode`, `outcome` (`PROCEED, REPAIR, ESCALATE,
BLOCK`), `reason` (escalation/block reason or null), `ruleFired` (`A1`…`A11`, plan §12), `shadow`
(`{wouldBe, reason, blockingFindings}` or null), `pushGuard` (`PASS`/`BLOCK` + reason), `egressDecision`,
`blocking` (`[{findingId, source, raisedBy, severity, reason}]`), `grounding` (`[{findingId, grounded, reason}]`),
`verdictMismatches` (`[{reviewId, verdict, groundedBlockingCount}]`), `closureDecisions` (`[{priorFindingId,
raisedBy, claims: [{by, status}], effectiveState, rule: deterministic-recheck|human|independent-reviewer|raiser-claim|closure-without-change|regression|unchanged}]`;
`regression` names a prior that a finding of this round re-raised after it was verified or closed; there is no
scanner-recheck rule in Phase 4: a SARIF finding closes only by a human disposition, R32, R37, plans DF-9 and DF-10),
`policyVersion`, `inputs` (`{packetSha256, checkReportSha256, reviewRecordSha256s[]}`), `fence` (`{leaseId,
fencingEpoch}`). `adjudicationId` = sha256 of the canonical JSON array `[roundKey, policyVersion, packetSha256,
checkReportSha256, sorted reviewRecordSha256s]` (R28). No timestamp field: the decision time lives in the `adjudications.decided_at` column only (plan §11).

### 2.5 `repair-order/v1`

`repairOrderId`, `taskId`, `fromAttemptId`, `nextRound`, `taskBaseSha`, `repairBaseSha`, `adjudicationId`,
`blockingFindings` (`review-finding/v1[]`, each `evidence`/`requiredFix` ≤ 4 KiB, total ≤ 64 KiB — policy data),
`informationalFindings` (same shape, capped), `closureRule` (const text: "a fix is verified only by a different
eligible reviewer, a human, or a deterministic re-check"), `workOrderRef`.

### 2.6 `architecture-invariant` 1.1.0

Optional `check: { kind: "forbidden-import", fromGlobs: string[], specifierPattern: string }`.

### 2.7 `run-event` 1.2.0 (Lane B part of the S0 superset)

Plan §18.4 lists the one new `eventType` (`review.finding_dispositioned`) and the optional fields.
`run-event-catalog.ts` reads the schema, so the dictionary validator sees the new fields without code change.

### 2.8 Internal artifacts (not canonical contracts)

`check-report` (canonical JSON, `check-report/v1`, built and parsed by `packages/application/src/assurance/check-report.ts`,
S6): the packet sha256, push-guard decision, egress decision with its hits (`{kind, part, detail}`, where `detail` is
a path, a pattern label or a fixed reason — never the matched text), every deterministic finding and the one
`sarif-unparsed` finding of each SARIF log (R37, plan §14 item 6), and the sha256 and size of each SARIF log the
checks read, ordered by check id and then sha256 (R40; the raw outputs themselves are artifacts the check step stores,
S12). SARIF logs are not parsed (plan
DF-10) and no scanner run is recorded. There is no timestamp in it. There is no JSON Schema file: the harness writes it and re-reads it by content
address, and a strict structural parser guards every read (v3; replaces the v2 schema file, which would have needed
a new `ajv` dependency in `@asep/application`). Unknown or missing keys, wrong types, a sha256 mismatch, an egress
decision for another packet, a push-guard or egress decision that does not follow from the report's own findings
and hits, and SARIF findings other than exactly one `sarif-unparsed` finding per listed log fail closed.
`review-prompt`: instructions, rendered input, output schema, template hash.
`gateway-appendix`: the text the gateway appended to the sent `instructions`, as returned in the response (gateway-controlled; stored so its drift is visible).

No assurance step reads the wall clock: every timestamp column below is written from `AssuranceStepContext.now()`, one fixed logical time per activity execution (R15), so a retried step writes identical rows.

## 3. Tables (migrations in Lane B range; withdrawn `0201_run_events`, R4)

### 3.1 `0200_assurance_reviews`

```sql
-- Review rounds must prove "attempt belongs to task" at the database.
alter table attempts
  add constraint attempts_id_task_scope_uq unique (id, task_id, organization_id, project_id);

create function assurance_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name
    using errcode = '55000';
end;
$$;

create table review_rounds (
  id                       char(26)    primary key,
  organization_id          char(26)    not null,
  project_id               char(26)    not null,
  repository_binding_id    char(26)    not null,
  task_id                  char(26)    not null,
  attempt_id               char(26)    not null,
  round                    integer     not null,
  round_key                text        not null,
  review_kind              text        not null,
  review_mode              text        not null,
  policy_version           text        not null,
  packet_artifact_id       char(26),
  packet_sha256            text,
  packet_included_bytes    integer,
  over_budget              boolean     not null default false,
  check_report_artifact_id char(26),
  push_guard               text,
  egress_decision          text,
  state                    text        not null,
  prior_round_id           char(26),
  opened_at                timestamptz not null,
  adjudicated_at           timestamptz,
  version                  integer     not null default 0,
  constraint review_rounds_round_ck       check (round >= 1),
  constraint review_rounds_kind_ck        check (review_kind in ('fresh','re-review')),
  constraint review_rounds_mode_ck        check (review_mode in ('not-required','shadow','gating')),
  constraint review_rounds_state_ck       check (state in ('OPEN','ADJUDICATED','SUPERSEDED')),
  constraint review_rounds_push_guard_ck  check (push_guard is null or push_guard in ('PASS','BLOCK')),
  constraint review_rounds_egress_ck      check (egress_decision is null or egress_decision in
                                            ('CLEAR','STOP_SECRET','STOP_CLASSIFIED','STOP_UNSCANNABLE')),
  constraint review_rounds_packet_sha_ck  check (packet_sha256 is null or packet_sha256 ~ '^[0-9a-f]{64}$'),
  -- the packet's measured size lives beside it, never inside the hashed packet
  constraint review_rounds_packet_size_ck check ((packet_sha256 is null) = (packet_included_bytes is null)
                                            and (packet_included_bytes is null or packet_included_bytes >= 0)),
  constraint review_rounds_first_ck       check ((round = 1) = (prior_round_id is null)),
  constraint review_rounds_kind_round_ck  check ((review_kind = 'fresh') = (round = 1)),
  constraint review_rounds_adjudicated_ck check ((state = 'OPEN') = (adjudicated_at is null)),
  constraint review_rounds_scope_uq       unique (id, organization_id, project_id),
  constraint review_rounds_round_key_uq   unique (organization_id, project_id, round_key),
  constraint review_rounds_task_round_uq  unique (organization_id, project_id, task_id, round),
  constraint review_rounds_attempt_uq     unique (organization_id, project_id, attempt_id),
  constraint review_rounds_task_binding_fk foreign key (task_id, organization_id, project_id, repository_binding_id)
    references tasks (id, organization_id, project_id, repository_binding_id),
  constraint review_rounds_attempt_task_fk foreign key (attempt_id, task_id, organization_id, project_id)
    references attempts (id, task_id, organization_id, project_id),
  constraint review_rounds_packet_fk       foreign key (packet_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint review_rounds_check_report_fk foreign key (check_report_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint review_rounds_prior_fk        foreign key (prior_round_id, organization_id, project_id)
    references review_rounds (id, organization_id, project_id)
);
create index review_rounds_task_idx on review_rounds (organization_id, project_id, task_id, round);

create function assurance_review_round_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'review_rounds rows are never deleted' using errcode = '55000';
  end if;
  if (new.id, new.organization_id, new.project_id, new.repository_binding_id, new.task_id, new.attempt_id,
      new.round, new.round_key, new.review_kind, new.review_mode, new.policy_version, new.prior_round_id,
      new.opened_at)
     is distinct from
     (old.id, old.organization_id, old.project_id, old.repository_binding_id, old.task_id, old.attempt_id,
      old.round, old.round_key, old.review_kind, old.review_mode, old.policy_version, old.prior_round_id,
      old.opened_at) then
    raise exception 'review round % identity is immutable', old.id using errcode = '55000';
  end if;
  if old.packet_sha256 is not null and (new.packet_sha256, new.packet_included_bytes, new.over_budget)
                                         is distinct from (old.packet_sha256, old.packet_included_bytes, old.over_budget) then
    raise exception 'review round % packet is immutable once set', old.id using errcode = '55000';
  end if;
  if old.state = 'SUPERSEDED'
     or (old.state = 'ADJUDICATED' and new.state not in ('ADJUDICATED','SUPERSEDED')) then
    raise exception 'review round % cannot move from % to %', old.id, old.state, new.state
      using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger review_rounds_guard before update or delete on review_rounds
  for each row execute function assurance_review_round_guard();

create table review_records (
  id                       char(26)    primary key,
  organization_id          char(26)    not null,
  project_id               char(26)    not null,
  review_round_id          char(26)    not null,
  review_id                text        not null,
  reviewer_config_id       text        not null,
  reviewer_config_sha256   text        not null,
  reviewer_role            text        not null,
  requested_model          text        not null,
  resolved_family          text        not null,
  served_model             text,
  terminal_state           text        not null,
  failure_reason           text,
  observation_status       text,
  validity                 text,
  verdict                  text,
  prompt_artifact_id       char(26),
  raw_request_artifact_id  char(26),
  raw_response_artifact_id char(26),
  record_artifact_id       char(26),
  provider_request_id      text,
  gateway_alteration       text,
  gateway_appendix_artifact_id char(26),
  input_tokens             integer,
  cached_input_tokens      integer,
  output_tokens            integer,
  reasoning_tokens         integer,
  wall_clock_ms            integer,
  transport_attempts       integer,
  provider_calls           integer     not null,
  call_generation          integer     not null default 1,
  cost_micro_usd           bigint,
  price_source             text,
  claim_semantic_key       text        not null,   -- the Phase 2 fenced claim that authorized the call
  fence_lease_id           text        not null,
  fence_lease_epoch        integer     not null,
  recorded_at              timestamptz not null,
  constraint review_records_review_id_ck  check (review_id ~ '^[0-9a-f]{64}$'),
  constraint review_records_config_sha_ck check (reviewer_config_sha256 ~ '^[0-9a-f]{64}$'),
  constraint review_records_role_ck       check (reviewer_role in ('primary','comparator')),
  constraint review_records_state_ck      check (terminal_state in
                                            ('COMPLETED','FAILED','EGRESS_STOPPED','SKIPPED_PUSH_GUARD')),
  constraint review_records_failure_ck    check (failure_reason is null or failure_reason in
                                            ('served-model-drift','refused','incomplete','malformed','rate-limited',
                                             'provider-error','auth-error','context-overflow','budget-exhausted',
                                             'cancelled','egress-secret','egress-classified','egress-unscannable',
                                             'egress-request-rescan','push-guard','prompt-over-budget')),
  constraint review_records_failure_state_ck check ((terminal_state = 'COMPLETED') = (failure_reason is null)),
  constraint review_records_observation_ck check (observation_status is null or observation_status in
                                            ('COMPLETED','REFUSED','INCOMPLETE','MALFORMED','RATE_LIMITED',
                                             'PROVIDER_ERROR','AUTH_ERROR','CONTEXT_OVERFLOW','BUDGET_EXHAUSTED',
                                             'CANCELLED')),
  constraint review_records_validity_ck   check (validity is null or validity in ('VALID','INVALID')),
  constraint review_records_verdict_ck    check (verdict is null or verdict in ('APPROVE','REQUEST_CHANGES','ESCALATE')),
  constraint review_records_completed_ck  check (terminal_state <> 'COMPLETED'
                                            or (raw_response_artifact_id is not null and validity is not null
                                                and record_artifact_id is not null and provider_calls >= 1)),
  constraint review_records_valid_ck      check (validity is distinct from 'VALID'
                                            or (record_artifact_id is not null and verdict is not null)),
  constraint review_records_no_request_ck check (terminal_state not in ('EGRESS_STOPPED','SKIPPED_PUSH_GUARD')
                                            or (provider_calls = 0 and raw_request_artifact_id is null
                                                and raw_response_artifact_id is null)),
  constraint review_records_counts_ck     check (provider_calls >= 0 and call_generation >= 1 and fence_lease_epoch >= 1),
  -- money is integer micro-USD, as at the slot seam (R28)
  constraint review_records_cost_ck       check ((cost_micro_usd is null) = (price_source is null)
                                            and (cost_micro_usd is null or cost_micro_usd >= 0)),
  constraint review_records_gateway_ck    check (gateway_alteration is null or gateway_alteration in
                                            ('altered','unaltered','unknown')),
  constraint review_records_gateway_presence_ck check ((provider_calls = 0) = (gateway_alteration is null)),
  constraint review_records_review_uq     unique (organization_id, project_id, review_id),
  constraint review_records_scope_uq      unique (id, organization_id, project_id),
  constraint review_records_round_fk      foreign key (review_round_id, organization_id, project_id)
    references review_rounds (id, organization_id, project_id),
  constraint review_records_prompt_fk     foreign key (prompt_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint review_records_raw_request_fk  foreign key (raw_request_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint review_records_raw_response_fk foreign key (raw_response_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint review_records_record_fk     foreign key (record_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint review_records_appendix_fk   foreign key (gateway_appendix_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id)
);
create index review_records_round_idx on review_records (organization_id, project_id, review_round_id);

create function assurance_review_record_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'review_records rows are never deleted' using errcode = '55000';
  end if;
  if old.terminal_state <> 'FAILED' then
    raise exception 'review record % is final (%)', old.review_id, old.terminal_state using errcode = '55000';
  end if;
  if (new.organization_id, new.project_id, new.review_round_id, new.review_id, new.reviewer_config_id,
      new.reviewer_config_sha256, new.reviewer_role, new.requested_model, new.resolved_family)
     is distinct from
     (old.organization_id, old.project_id, old.review_round_id, old.review_id, old.reviewer_config_id,
      old.reviewer_config_sha256, old.reviewer_role, old.requested_model, old.resolved_family) then
    raise exception 'review record % identity is immutable', old.review_id using errcode = '55000';
  end if;
  if new.call_generation <= old.call_generation or new.provider_calls < old.provider_calls then
    raise exception 'review record % must advance its call generation', old.review_id using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger review_records_guard before update or delete on review_records
  for each row execute function assurance_review_record_guard();

create table review_findings (
  id               char(26)    primary key,
  organization_id  char(26)    not null,
  project_id       char(26)    not null,
  review_round_id  char(26)    not null,
  review_record_id char(26),
  source           text        not null,
  raised_by        text        not null,
  finding_key      text        not null,
  fingerprint      text        not null,
  severity         text        not null,
  category         text        not null,
  file             text,
  line_start       integer,
  line_end         integer,
  requirement_id   text,
  rule_id          text,
  evidence         text        not null,
  required_fix     text        not null,
  grounded         boolean     not null,
  grounding_reason text,
  blocking         boolean     not null,
  prior_finding_id char(26),
  lifecycle_state  text        not null,
  created_at       timestamptz not null,
  version          integer     not null default 0,
  constraint review_findings_source_ck      check (source in ('model','deterministic','sarif')),
  -- a SARIF log is not parsed in Phase 4: its one finding is sarif-unparsed, HIGH, grounded, with no location (R37)
  constraint review_findings_sarif_ck       check (source <> 'sarif'
                                              or (raised_by = 'sarif:unparsed' and coalesce(rule_id, '') = 'sarif-unparsed'
                                                  and severity = 'HIGH' and category = 'EVIDENCE_INTEGRITY'
                                                  and grounded and file is null and line_start is null
                                                  and line_end is null)),
  constraint review_findings_record_ck      check ((source = 'model') = (review_record_id is not null)),
  constraint review_findings_raiser_ck      check ((source = 'model') = (raised_by !~ '^(deterministic|sarif):')),
  constraint review_findings_fingerprint_ck check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint review_findings_severity_ck    check (severity in ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  constraint review_findings_category_ck    check (category in ('SPEC','ARCHITECTURE','CORRECTNESS','SECURITY',
                                              'PERFORMANCE','TEST_QUALITY','MAINTAINABILITY','EVIDENCE_INTEGRITY')),
  constraint review_findings_lines_ck       check ((line_start is null or line_start >= 1)
                                              and (line_end is null or (line_start is not null and line_end >= line_start))),
  constraint review_findings_text_ck        check (length(evidence) between 1 and 8192
                                              and length(required_fix) between 1 and 8192),
  constraint review_findings_file_ck        check (file is null or (file !~ '^/' and file !~ '(^|/)\.\.(/|$)'
                                              and file !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\\]' and file !~ '^"')),
  constraint review_findings_lifecycle_ck   check (lifecycle_state in ('OPEN','ACKNOWLEDGED','FIXED','VERIFIED',
                                              'CLOSED','REFUTED','ADJUDICATED','WAIVED')),
  constraint review_findings_grounded_ck    check (grounded or not blocking),
  constraint review_findings_reason_ck      check (grounded or grounding_reason is not null),
  -- one row per finding identity in a round (plan §12): never merged across requirement ids or finding keys
  constraint review_findings_dedupe_uq      unique nulls not distinct (organization_id, project_id, review_round_id,
                                              raised_by, fingerprint, requirement_id, finding_key),
  constraint review_findings_scope_uq       unique (id, organization_id, project_id),
  constraint review_findings_denorm_uq      unique (id, organization_id, project_id, severity, raised_by, grounded),
  constraint review_findings_round_fk       foreign key (review_round_id, organization_id, project_id)
    references review_rounds (id, organization_id, project_id),
  constraint review_findings_record_fk      foreign key (review_record_id, organization_id, project_id)
    references review_records (id, organization_id, project_id),
  constraint review_findings_prior_fk       foreign key (prior_finding_id, organization_id, project_id)
    references review_findings (id, organization_id, project_id)
);
create index review_findings_round_idx on review_findings (organization_id, project_id, review_round_id);

create function assurance_review_finding_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'review_findings rows are never deleted' using errcode = '55000';
  end if;
  if (new.id, new.organization_id, new.project_id, new.review_round_id, new.review_record_id, new.source,
      new.raised_by, new.finding_key, new.fingerprint, new.severity, new.category, new.file, new.line_start,
      new.line_end, new.requirement_id, new.rule_id, new.evidence, new.required_fix, new.grounded,
      new.grounding_reason, new.prior_finding_id, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.project_id, old.review_round_id, old.review_record_id, old.source,
      old.raised_by, old.finding_key, old.fingerprint, old.severity, old.category, old.file, old.line_start,
      old.line_end, old.requirement_id, old.rule_id, old.evidence, old.required_fix, old.grounded,
      old.grounding_reason, old.prior_finding_id, old.created_at) then
    raise exception 'review finding % content is immutable', old.id using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger review_findings_guard before update or delete on review_findings
  for each row execute function assurance_review_finding_guard();

create table finding_dispositions (
  id                   char(26)    primary key,
  organization_id      char(26)    not null,
  project_id           char(26)    not null,
  finding_id           char(26)    not null,
  disposition          text        not null,
  actor_kind           text        not null,
  actor                text        not null,
  finding_severity     text        not null,
  finding_raised_by    text        not null,
  finding_grounded     boolean     not null,
  rationale            text        not null,
  evidence_artifact_id char(26),
  expires_at           timestamptz,
  signature            text,
  fence_lease_id       text,
  fence_lease_epoch    integer,
  recorded_at          timestamptz not null,
  constraint finding_dispositions_disposition_ck check (disposition in ('ACCEPTED','REJECTED_WITH_EVIDENCE','WAIVED',
                                                   'RESOLUTION_CLAIMED','RESOLUTION_VERIFIED','REOPENED')),
  constraint finding_dispositions_actor_kind_ck  check (actor_kind in ('human','harness-rule','reviewer')),
  constraint finding_dispositions_rationale_ck   check (length(rationale) between 1 and 4000),
  -- only a named human waives, always with an expiry and a signature
  constraint finding_dispositions_waiver_ck      check (disposition <> 'WAIVED'
                                                   or (actor_kind = 'human' and expires_at is not null
                                                       and signature is not null)),
  -- a reviewer can only claim a resolution, or verify one it did not raise
  constraint finding_dispositions_reviewer_ck    check (actor_kind <> 'reviewer'
                                                   or disposition in ('RESOLUTION_CLAIMED','RESOLUTION_VERIFIED')),
  -- the raiser of a finding can never verify its resolution
  constraint finding_dispositions_raiser_ck      check (disposition <> 'RESOLUTION_VERIFIED' or actor <> finding_raised_by),
  -- harness rules refute ungrounded findings, verify deterministic re-checks, and reopen; no harness rule
  -- verifies a SARIF finding in Phase 4 (R32)
  constraint finding_dispositions_harness_ck     check (actor_kind <> 'harness-rule'
                                                   or disposition in ('REJECTED_WITH_EVIDENCE','RESOLUTION_VERIFIED','REOPENED')),
  constraint finding_dispositions_harness_verify_ck check (not (actor_kind = 'harness-rule'
                                                   and disposition = 'RESOLUTION_VERIFIED')
                                                   or (finding_raised_by like 'deterministic:%'
                                                       and actor = 'harness-rule:deterministic-recheck')),
  -- model output never closes a deterministic or SARIF finding
  constraint finding_dispositions_reviewer_verify_ck check (not (actor_kind = 'reviewer'
                                                   and disposition = 'RESOLUTION_VERIFIED')
                                                   or finding_raised_by !~ '^(deterministic|sarif):'),
  -- only a human disposes of a SARIF finding; a harness rule may only reopen it (an expired waiver) (R37)
  constraint finding_dispositions_sarif_ck       check (finding_raised_by !~ '^sarif:' or actor_kind = 'human'
                                                   or (actor_kind = 'harness-rule' and disposition = 'REOPENED')),
  -- only a human can reject a grounded finding
  constraint finding_dispositions_refute_ck      check (disposition <> 'REJECTED_WITH_EVIDENCE'
                                                   or actor_kind = 'human' or not finding_grounded),
  -- validity decisions (accept/reject) are human, except harness refutation of ungrounded findings
  constraint finding_dispositions_accept_ck      check (disposition <> 'ACCEPTED' or actor_kind = 'human'),
  -- machine-written rows carry the fence that authorized them; human rows do not
  constraint finding_dispositions_fence_ck       check ((actor_kind = 'human')
                                                   = (fence_lease_id is null and fence_lease_epoch is null)),
  constraint finding_dispositions_scope_uq       unique (id, organization_id, project_id),
  constraint finding_dispositions_finding_fk     foreign key (finding_id, organization_id, project_id,
                                                   finding_severity, finding_raised_by, finding_grounded)
    references review_findings (id, organization_id, project_id, severity, raised_by, grounded),
  constraint finding_dispositions_evidence_fk    foreign key (evidence_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id)
);
create index finding_dispositions_finding_idx
  on finding_dispositions (organization_id, project_id, finding_id, recorded_at);
create trigger finding_dispositions_append_only before update or delete on finding_dispositions
  for each row execute function assurance_reject_mutation();

create table adjudications (
  id                       char(26)    primary key,
  organization_id          char(26)    not null,
  project_id               char(26)    not null,
  review_round_id          char(26)    not null,
  adjudication_id          text        not null,
  outcome                  text        not null,
  reason                   text,
  rule_fired               text        not null,
  review_mode              text        not null,
  would_be_outcome         text,
  would_be_reason          text,
  blocking_count           integer     not null,
  policy_version           text        not null,
  record_artifact_id       char(26)    not null,
  record_sha256            text        not null,
  repair_order_artifact_id char(26),
  fence_lease_id           text        not null,
  fence_lease_epoch        integer     not null,
  decided_at               timestamptz not null,
  constraint adjudications_id_ck          check (adjudication_id ~ '^[0-9a-f]{64}$'),
  constraint adjudications_sha_ck         check (record_sha256 ~ '^[0-9a-f]{64}$'),
  constraint adjudications_outcome_ck     check (outcome in ('PROCEED','REPAIR','ESCALATE','BLOCK')),
  constraint adjudications_mode_ck        check (review_mode in ('not-required','shadow','gating')),
  constraint adjudications_rule_ck        check (rule_fired ~ '^A([1-9]|1[01])$'),
  constraint adjudications_reason_ck      check (reason is null or reason in ('packet-over-budget','egress-stopped',
                                            'independence-unsatisfiable','reviewer-unavailable','reviewer-escalated',
                                            'max-repair-rounds','budget-exhausted','secret-in-diff','forbidden-path',
                                            'unscannable-sensitive-change')),
  constraint adjudications_reason_present_ck check ((outcome in ('ESCALATE','BLOCK')) = (reason is not null)),
  -- shadow and not-required never change the workflow beyond the deterministic push guard
  constraint adjudications_non_gating_ck  check (review_mode = 'gating' or outcome in ('PROCEED','BLOCK')),
  constraint adjudications_shadow_ck      check ((review_mode = 'shadow' and outcome = 'PROCEED')
                                            = (would_be_outcome is not null)),
  constraint adjudications_would_be_ck    check (would_be_outcome is null or would_be_outcome in ('PROCEED','REPAIR','ESCALATE')),
  constraint adjudications_repair_ck      check ((outcome = 'REPAIR') = (repair_order_artifact_id is not null)),
  constraint adjudications_counts_ck      check (blocking_count >= 0 and fence_lease_epoch >= 1),
  constraint adjudications_round_uq       unique (organization_id, project_id, review_round_id),
  constraint adjudications_adjudication_uq unique (organization_id, project_id, adjudication_id),
  constraint adjudications_scope_uq       unique (id, organization_id, project_id),
  constraint adjudications_round_fk       foreign key (review_round_id, organization_id, project_id)
    references review_rounds (id, organization_id, project_id),
  constraint adjudications_record_fk      foreign key (record_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id),
  constraint adjudications_repair_fk      foreign key (repair_order_artifact_id, organization_id, project_id)
    references artifacts (id, organization_id, project_id)
);
create trigger adjudications_append_only before update or delete on adjudications
  for each row execute function assurance_reject_mutation();
```

Write rules (application, plan §16 I5): every insert/update above made by the harness runs in a transaction that
first performs the Phase 2 fence check for `(fence_lease_id, fence_lease_epoch)`; human dispositions are written by
the disposition use case (CLI/API) after authenticating the human and verifying the ed25519 signature with the
scheme used for `human_authorizations` (`migrations.ts` `0010`).

### 3.2 `0201_metric_snapshots`

Snapshots are **append-only versions** (P4-PLAN2-MED-006, R18): a recompute that changes nothing writes nothing; a
changed value appends the next version; earlier versions are never updated or deleted, so a cohort's history stays
readable. Panels read the latest version through `metric_snapshots_latest`.

```sql
create table metric_snapshots (
  id                 char(26)    primary key,
  organization_id    char(26)    not null,
  project_id         char(26)    not null,
  metric_name        text        not null,
  dictionary_version text        not null,
  evaluator_version  text        not null,
  window_start       timestamptz not null,
  window_end         timestamptz not null,
  dimensions         jsonb       not null,   -- canonical, sorted keys
  dimensions_sha256  text        not null,
  snapshot_version   integer     not null,
  value              numeric,
  numerator          numeric,
  denominator        numeric,
  null_reason        text,
  privacy_class      text        not null,
  source_event_count integer     not null,
  source_watermark   timestamptz,           -- max inserted_at of the events read
  computed_at        timestamptz not null,
  constraint metric_snapshots_window_ck   check (window_end > window_start),
  constraint metric_snapshots_null_ck     check ((value is null) = (null_reason is not null)),
  constraint metric_snapshots_privacy_ck  check (privacy_class in ('public','operational','sensitive','restricted')),
  constraint metric_snapshots_dims_sha_ck check (dimensions_sha256 ~ '^[0-9a-f]{64}$'),
  constraint metric_snapshots_counts_ck   check (source_event_count >= 0 and snapshot_version >= 1),
  constraint metric_snapshots_version_uq  unique (organization_id, project_id, metric_name, dictionary_version,
                                            window_start, window_end, dimensions_sha256, snapshot_version),
  constraint metric_snapshots_project_fk  foreign key (project_id, organization_id)
    references projects (id, organization_id)
);
create index metric_snapshots_lookup_idx on metric_snapshots (organization_id, project_id, metric_name, window_end);

-- versions are contiguous from 1, and a new version must change the value
create function assurance_metric_snapshot_version() returns trigger
language plpgsql as $$
declare
  prev metric_snapshots%rowtype;
begin
  select * into prev from metric_snapshots
   where organization_id = new.organization_id and project_id = new.project_id
     and metric_name = new.metric_name and dictionary_version = new.dictionary_version
     and window_start = new.window_start and window_end = new.window_end
     and dimensions_sha256 = new.dimensions_sha256
   order by snapshot_version desc
   limit 1;
  if not found then
    if new.snapshot_version <> 1 then
      raise exception 'first snapshot version must be 1, got %', new.snapshot_version using errcode = '55000';
    end if;
  elsif new.snapshot_version <> prev.snapshot_version + 1 then
    raise exception 'snapshot version must be %, got %', prev.snapshot_version + 1, new.snapshot_version
      using errcode = '55000';
  elsif (new.value, new.numerator, new.denominator, new.null_reason)
        is not distinct from (prev.value, prev.numerator, prev.denominator, prev.null_reason) then
    raise exception 'snapshot version % repeats version %', new.snapshot_version, prev.snapshot_version
      using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger metric_snapshots_version_guard before insert on metric_snapshots
  for each row execute function assurance_metric_snapshot_version();
create trigger metric_snapshots_append_only before update or delete on metric_snapshots
  for each row execute function assurance_reject_mutation();

create view metric_snapshots_latest as
  select distinct on (organization_id, project_id, metric_name, dictionary_version, window_start, window_end,
                      dimensions_sha256) *
    from metric_snapshots
   order by organization_id, project_id, metric_name, dictionary_version, window_start, window_end,
            dimensions_sha256, snapshot_version desc;
```

A recompute reads the latest version for the key and inserts version `n + 1` only when numerator, denominator,
value or null reason changed; two concurrent recomputes cannot both insert `n + 1` (`metric_snapshots_version_uq`),
and the loser re-reads and retries. A late human disposition therefore appends a version to the cohort of the
round it disposes (plan §15; exit H6, H7). Retention follows the dictionary privacy class; `restricted` metrics are
computed only when capture is enabled.

### 3.3 `0202_attempt_review_states`

```sql
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'attempts'::regclass and conname = 'attempts_status_check') then
    raise exception 'expected constraint attempts_status_check on attempts';
  end if;
end;
$$;
alter table attempts drop constraint attempts_status_check;
alter table attempts add constraint attempts_status_check check (status in
  ('STARTED','AGENT_RUNNING','AGENT_DONE','INSPECTING','VERIFYING','EVIDENCE_BUILT',
   'COMMITTED','UNDER_REVIEW','CHANGES_REQUESTED','PUSHED','PR_OPEN','SUCCEEDED',
   'FAILED','BLOCKED','BUDGET_EXHAUSTED','CANCELLED'));
```

`attempts_status_check` is PostgreSQL's default name for the unnamed column check in `0002`
(`migrations.ts:106-108`); the guard fails closed if a Phase 2 repair renamed or replaced it, and the value list is
re-derived from accepted Phase 2 at rebase. Lane B owns this constraint; Lane A owns `tasks.status` (R6).

### 3.4 Withdrawn

`0201_run_events` (v1) is withdrawn; events go to Lane A's `0107_run_events` (R4). `reviewer_promotions` (v1) is
removed; promotion is deferred (DF-2).

### 3.5 Validation evidence (Lane B scratch run, PGlite)

The fast suites run the same migrations on PGlite. In a scratch directory outside the repository (deleted
afterwards), Lane B applied the twelve Phase 2 migrations from `adapters/persistence/src/migrations.ts` and then the
SQL blocks of §3.1–§3.3 verbatim on PGlite `0.5.4` (the version installed under `adapters/persistence`): all applied,
so `plpgsql` trigger functions work there; the pre-existing check is named `attempts_status_check`; the §3.6 rollback
applied cleanly and restored the Phase 2 constraint. A probe with a valid row chain then confirmed: a final review
record and finding content cannot be updated; a lifecycle move is allowed; a raiser cannot verify its own finding
while another reviewer can; a mismatched denormalized severity is rejected by the composite FK; a harness rule cannot
reject a grounded finding; a reviewer cannot waive; dispositions and adjudications are append-only; a shadow round
cannot record `REPAIR` but can record `PROCEED` with a would-be `REPAIR`; a round cannot regress from `ADJUDICATED`
to `OPEN`; round identity is immutable. Not isolated by the probe: the `review_rounds_attempt_task_fk` path (the
probe tripped `review_rounds_attempt_uq` first). This is design validation, not the S8 acceptance suite; S8 repeats
every check on PGlite and on real PostgreSQL 17. After the 2026-10-29 amendment added the `gateway_alteration`
columns and constraints to `review_records`, the §3.1–§3.3 blocks and the §3.6 rollback were applied again on PGlite
`0.5.4` in a fresh scratch directory: all applied, and the three new constraints exist. After v3 replaced
`metric_snapshots` with append-only versions, the §3.1–§3.3 blocks and the §3.6 rollback were extracted from this
document and applied again on PGlite `0.5.4` after the twelve Phase 2 migrations, in a fresh scratch directory
outside the repository: all applied. A probe on one snapshot key confirmed that a first version other than 1, a
version gap, a version repeating the previous value, an update and a delete are rejected; versions 1, 2 and 3 with
values `0`, `1`, `0` are accepted; `metric_snapshots_latest` returns version 3; and the rollback removes the tables.
For v4 the §3.1–§3.3 blocks and the §3.6 rollback were extracted again and applied on PGlite `0.5.4` after the twelve
Phase 2 migrations in a fresh scratch directory outside the repository: all applied. With foreign keys and triggers
disabled (`session_replication_role = replica`, so only check and unique constraints act), a probe confirmed: a second
finding with the same round, raiser, fingerprint, null requirement id and key is rejected by
`review_findings_dedupe_uq` (nulls not distinct), while another requirement id or another key is accepted; a `file`
with LF, U+2028, U+0085, a backslash or a leading `"` is rejected and `src/café.ts` is accepted; a harness
`RESOLUTION_VERIFIED` is accepted only as `harness-rule:scanner-recheck` on a `sarif:` finding or
`harness-rule:deterministic-recheck` on a `deterministic:` finding; a reviewer's `RESOLUTION_VERIFIED` on a `sarif:` or
`deterministic:` finding is rejected and on another raiser's model finding accepted.
For v5 the blocks were extracted and applied again in the same way (fresh scratch directory outside the repository,
PGlite `0.5.4`, the twelve Phase 2 migrations first; all applied, and the §3.6 rollback applied), and the v4 probe was
re-run with these additions, all as expected (29 of 29): a round with a packet digest but no
`packet_included_bytes`, with a size but no packet, or with a negative size is rejected by
`review_rounds_packet_size_ck`, and a round with both or neither is accepted; a `FAILED` record with reason
`prompt-over-budget` and no request is accepted and an unknown reason rejected; a `COMPLETED` record without a review
record artifact is rejected by `review_records_completed_ck`; an integer `cost_micro_usd` with a price source is
accepted, and a negative one or one without a price source rejected by `review_records_cost_ck`.
For v6 (R32) the blocks were extracted and applied again in the same way, the earlier probes re-run, and these probes
added; results are recorded in the review log ("Review v5", "DDL re-validation (v6)"): a harness `RESOLUTION_VERIFIED`
by `harness-rule:scanner-recheck` on a `sarif:` finding is now rejected by `finding_dispositions_harness_verify_ck`,
while `harness-rule:deterministic-recheck` on a `deterministic:` finding and a human `RESOLUTION_VERIFIED` on a
`sarif:` finding are accepted; a `sarif` finding with `unresolved_reference` and no prior is accepted, and one linked to
a prior, or a `model` or `deterministic` finding with the flag, is rejected by `review_findings_unresolved_ck`.
For v7 (R37) the blocks were extracted and applied again in the same way and the probe re-run with the
`unresolved_reference` probes removed (the column and `review_findings_unresolved_ck` are gone) and these added;
results are recorded in the review log ("Review v6", "DDL re-validation (v7)"): a `sarif:unparsed` finding with rule
`sarif-unparsed`, `HIGH`, `EVIDENCE_INTEGRITY`, grounded and without a location is accepted, and one with another
raiser, another rule, another severity, `grounded` false or a file is rejected by `review_findings_sarif_ck`; on a
`sarif:` finding, a harness `REJECTED_WITH_EVIDENCE` (on an ungrounded row, foreign keys off), a harness
`RESOLUTION_VERIFIED` and a reviewer `RESOLUTION_CLAIMED` are rejected by `finding_dispositions_sarif_ck`, while a
harness `REOPENED` and a human `RESOLUTION_VERIFIED`, `REJECTED_WITH_EVIDENCE` and `WAIVED` are accepted; on a
`deterministic:` finding a harness `REJECTED_WITH_EVIDENCE` of an ungrounded row is still accepted. With the constraint
that fires first dropped (`finding_dispositions_harness_verify_ck`, `review_findings_grounded_ck`), the two SARIF
constraints reject a harness verification and an ungrounded SARIF row on their own.

### 3.6 Rollback (forward compensating migrations; applied only by operator decision, never by editing `02xx`)

```sql
-- undo 0202 (refuses while any attempt uses the review states)
do $$
begin
  if exists (select 1 from attempts where status in ('UNDER_REVIEW','CHANGES_REQUESTED')) then
    raise exception 'rollback refused: attempts use UNDER_REVIEW or CHANGES_REQUESTED';
  end if;
end;
$$;
alter table attempts drop constraint attempts_status_check;
alter table attempts add constraint attempts_status_check check (status in
  ('STARTED','AGENT_RUNNING','AGENT_DONE','INSPECTING','VERIFYING','EVIDENCE_BUILT',
   'COMMITTED','PUSHED','PR_OPEN','SUCCEEDED','FAILED','BLOCKED','BUDGET_EXHAUSTED','CANCELLED'));

-- undo 0201
drop view metric_snapshots_latest;
drop table metric_snapshots;
drop function assurance_metric_snapshot_version();

-- undo 0200 (destroys review history: export first)
drop table adjudications;
drop table finding_dispositions;
drop table review_findings;
drop table review_records;
drop table review_rounds;
drop function assurance_review_finding_guard();
drop function assurance_review_record_guard();
drop function assurance_review_round_guard();
drop function assurance_reject_mutation();
alter table attempts drop constraint attempts_id_task_scope_uq;
```

## 4. State machines

### Review round

```text
OPEN → ADJUDICATED → SUPERSEDED (when the task's next round opens)
```

### Review record (projection of the fenced reviewer call)

```text
(claimed through the Phase 2 primitive; no row yet)
→ COMPLETED | EGRESS_STOPPED | SKIPPED_PUSH_GUARD     (final)
→ FAILED → FAILED | COMPLETED                         (only via a newer claim; call_generation advances)
```

### Finding lifecycle (closure authority, plan §13)

```text
OPEN → ACKNOWLEDGED → FIXED → VERIFIED → CLOSED
OPEN → REFUTED → ADJUDICATED       (harness-rule only for ungrounded findings; human otherwise)
OPEN → WAIVED                      (named human, rationale, expiry, signature)
FIXED → OPEN                       (closure-without-change; expired waiver also reopens)
```

Blocking while `OPEN`, `ACKNOWLEDGED`, `FIXED`. `FIXED` = a resolution claim (raiser or coder). `VERIFIED` only via a
different eligible reviewer, a human, or (deterministic findings) the same rule no longer firing.

### Attempt (delta, SR-C7 / SR-X2)

```text
COMMITTED → UNDER_REVIEW → PUSHED        (PROCEED; ESCALATE in drill)
UNDER_REVIEW → CHANGES_REQUESTED         (REPAIR in drill; terminal for this attempt)
UNDER_REVIEW → BLOCKED                   (push guard)
COMMITTED → PUSHED                       (kept: compositions without Lane B's slot — the not-configured default or the disabled opt-out)
```

## 5. Metrics dictionary changes (SR-D1, SR-D2; dictionary 1.0.0 → 1.1.0)

New operand options (SR-X6):

- `dedupeLatestBy: <RunEvent field>` — group events by that field and keep the latest by `(occurredAt, eventId)`
  before filtering and aggregating.
- `cohortBy: <RunEvent date-time field>` — the operand's window filter uses that field instead of `occurredAt`, so a
  disposition counts in the cohort of the round it disposes (plan §15, R18). Dedupe runs before the window filter,
  so a later reversal replaces the earlier disposition inside the same cohort.

| Metric | Numerator | Denominator | Zero-denominator policy | Privacy |
|---|---|---|---|---|
| `review_finding_yield` (changed) | `count(review.finding_dispositioned where findingValid=true and dispositionActorKind=human)`, `dedupeLatestBy: findingId`, `cohortBy: reviewRoundCompletedAt` | `sum(review.completed.reviewFindingsTotal)` | `report-null-when-no-findings` | operational |
| `review_false_positive_rate` (changed) | same with `findingValid=false` | same | `report-null-when-no-findings` | operational |
| `review_adjudication_coverage` | `count(review.finding_dispositioned where dispositionActorKind=human)`, `dedupeLatestBy: findingId`, `cohortBy: reviewRoundCompletedAt` | `sum(review.completed.reviewFindingsTotal)` | `report-null-when-no-findings` | operational |
| `review_ungrounded_rate` | `sum(review.completed.reviewFindingsUngrounded)` | `sum(review.completed.reviewFindingsTotal)` | `report-null-when-no-findings` | operational |
| `reviewer_failure_rate` | `count(review.completed where reviewerFailed=true and reviewerRole!=deterministic)` | `count(review.completed where reviewerRole!=deterministic)` | `report-null-when-no-reviews` | operational |
| `review_egress_stop_rate` | `count(review.completed where egressStopped=true and reviewerRole!=deterministic)` | `count(review.completed where reviewerRole!=deterministic)` | `report-null-when-no-reviews` | operational |
| `shadow_would_block_rate` | `count(attempt.completed where reviewMode=shadow and shadowWouldBlock=true)` | `count(attempt.completed where reviewMode=shadow)` | `report-null-when-no-shadow-rounds` | operational |
| `review_cost_coverage` | `count(review.completed where reviewCostPriced=true and reviewerRole!=deterministic)` | `count(review.completed where reviewerRole!=deterministic)` | `report-null-when-no-reviews` | operational |
| `mean_review_cost_usd` | `mean(review.completed.reviewCostUsd)` | — | — | restricted |
| `review_disposition_latency_ms` | `mean(review.finding_dispositioned.dispositionLatencyMs where dispositionActorKind=human)`, `cohortBy: reviewRoundCompletedAt` | — | — | operational |
| `repair_success_rate` | `count(attempt.completed where repairRound=true and repairClosedAllBlocking=true)` | `count(attempt.completed where repairRound=true)` | `report-null-when-no-repairs` (always null in Phase 4 production) | operational |
| `review_escalation_rate` | `count(attempt.completed where assuranceOutcome=ESCALATE)` | `count(attempt.completed where reviewMode=gating)` | `report-null-when-no-gating-rounds` (always null in Phase 4 production) | operational |

Existing metrics consumed unchanged: `false_completion_rate`, `escaped_defect_rate` (null until post-merge defect
mapping exists), `cost_per_accepted_task`, `workflow_recovery_rate`, `repair_cycles_per_task`,
`human_intervention_rate`, `artifact_loss_rate`.

### Event emission (Lane B; ownership in plan §18.3 SR-A6)

| Event | Emitted by | Key fields |
|---|---|---|
| `attempt.declared_complete` | `recordAttemptOutcome` | `declaredComplete`; `passedRequiredAssurance` = verification PASS ∧ outcome ≠ BLOCK (shadow/not-required) or outcome = PROCEED (drill gating) |
| `attempt.completed` | `recordAttemptOutcome` | `outcome`, `failureClass`, `modelCostUsd`, `computeCostUsd`, `reviewCostUsd` (round sum, omitted when any call is unpriced), `reviewRound`, `reviewMode`, `assuranceOutcome`, `shadowWouldBlock`, `repairRound`, `repairClosedAllBlocking`, `assuranceUnavailable` (R19) |
| `review.completed` | `adjudicateRound`, one per review source (each model reviewer record + one `deterministic`) | `reviewerConfigId`, `reviewerRole`, `reviewRound`, `reviewMode`, `reviewFindingsTotal`, `reviewFindingsUngrounded`, `reviewFindingsBlocking`, `reviewerFailed`, `egressStopped`, `reviewCostUsd`/`reviewCostPriced`, tokens, `durationMs` |
| `review.finding_dispositioned` | disposition use case (human) | `findingId`, `findingValid`, `findingDisposition`, `dispositionActorKind=human`, `findingSource`, `findingSeverity`, `reviewerConfigId` (raiser), `reviewRound`, `reviewRoundCompletedAt` (cohort key), `dispositionLatencyMs` |
| `repair.started` | `adjudicateRound` on REPAIR (drill only) | `reviewRound` = next round |

**Money in events (R28).** The slot carries money only as integer micro-USD. The existing `run-event` v1 fields
`modelCostUsd`, `computeCostUsd` and `reviewCostUsd` are written from those integers once, as `microUsd / 1 000 000`
(the JSON number then reads back as the same decimal for every amount below 10^15 micro-USD, a billion USD, which is
above R24's `MAX_USD`, because a double round-trips 15 significant digits), for telemetry and display only; nothing reads them back
into budget arithmetic, and `mean_review_cost_usd` is a reporting value. No event field is added for this.

Event ids are input-derived (architecture §7), so a retried emission is a no-op through `RunEventSink`.

## 6. Policy data (`policies/review-policy.yaml`)

```yaml
apiVersion: asep.policy/v1
kind: ReviewPolicy
version: 1.0.0
modelFamilies:                 # longest-prefix match on the pinned model id; unknown → fail closed
  - { family: anthropic-claude, prefixes: [claude-] }
  - { family: openai-gpt,       prefixes: [gpt-] }
  - { family: deepseek,         prefixes: [deepseek-] }
  - { family: alibaba-qwen,     prefixes: [qwen] }
  - { family: xai-grok,         prefixes: [grok-] }
reviewers:                     # pinned configurations; no secret appears here
  - id: primary-gpt-6.1-sol    # primary candidate (controller); labeller was mostly gpt-5.6-sol; not yet probed
    role: primary
    providerId: openai-responses
    model: gpt-6.1-sol
    reasoningEffort: high
    maxOutputTokens: 16000
    packetBudgetBytes: 400000
    pricing: null              # set from a published price with source + date, or leave null
  - id: comparator-deepseek-v4-pro
    role: comparator
    providerId: openai-responses
    model: deepseek-v4-pro
    reasoningEffort: high      # kept only if the S10 probe shows the gateway accepts it for this model
    maxOutputTokens: 16000
    packetBudgetBytes: 400000
    pricing: null
runtime:
  comparatorInShadowRounds: false
modes:                         # the Phase 4 loader accepts only not-required | shadow | deferred
  R0: not-required
  R1: shadow
  R2: deferred                 # admission keeps R2 DEFERRED (Phase 2), so it is never reached
  R3: deferred
  R4: deferred
independentReviewSatisfiedBy:  # D-2 (user decision); inactive until promotion exists (DF-2, DF-5)
  R1: [human, promoted-model]
  R2: [human]
maxRounds:          { R1: 2, R2: 2 }
blockingSeverities: { R1: [CRITICAL, HIGH], R2: [CRITICAL, HIGH, MEDIUM] }
groundingMinChars:  { evidence: 40, requiredFix: 20 }
repairOrderLimits:  { perFieldBytes: 4096, totalBytes: 65536 }
egress:
  enabledProjects: []          # explicit per-project opt-in; empty → reviewer never called
  denyPathGlobs: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
                  '**/id_rsa*', '**/id_ed25519*', '**/secrets/**', '**/*credential*']
  excerptBytesPerStream: 4096
  excerptBytesTotal: 65536
credential:
  maxCredentialAgeMs: 900000
```

Values are experimental starting values (D-7). Parity test: the TypeScript loader and this file agree; the loader
rejects `gating`; `approval-matrix.yaml` and `verification-matrix.yaml` stay byte-identical.

## 7. Corpus, preregistration and scorecard data (Lane B owned, `evals/`)

### 7.1 Corpus item (`evals/review-corpus/self-history/items/<id>.json`)

Fields marked *(S19 now)* are collected by S19's pure core (`evals/review-corpus/collect.ts`, regenerated with
`pnpm exec tsx evals/review-corpus/collect.ts --write`); the others are filled when the protocol of plan §7.8 is
confirmed and the corpus is frozen. Every labelled instance is an item: each finding a review document raises
(`first-occurrence`) and each re-review status row that does not resolve its finding (`residual`). Plan-review labels
are items too, excluded `plan-defect`. Excerpts live in `evals/review-corpus/self-history/blobs/<sha256>`.

| Field | Notes |
|---|---|
| `id` | `<findingId>@<reviewedSha7>`; `<findingId>@unknown` when the reviewed SHA is unknown |
| `findingId`, `phase`, `cycle`, `reviewKind` (`final, rereview, self-found, plan`) | *(S19 now)*; `cycle` orders a phase's reviews (plan reviews are cycle 0) |
| `instanceKind` (`first-occurrence, residual`), `labelStatus` | *(S19 now)*; `labelStatus` is a residual's own status in its cycle (`PARTIAL, REGRESSED, OPEN`), null for a first occurrence |
| `reviewedSha`, `reviewedShaSource` (`recorded-in-review, derived, inferred-parent-of-fix, unknown`) | *(S19 now)* full 40-hex; `recorded-in-review` = named by the document; `derived` = parent of the commit that added the review document; `inferred-parent-of-fix` = parent of the fix commit the document names (the self-found item, R22); `unknown` when the document was never committed, or when the commit that added it also added a later cycle's document (its parent would postdate that later review) |
| `baseSha`, `baseShaSource` | *(S19 now)* `B_c`: the phase plan's first `BASE_SHA` line read at `reviewedSha`; `phase-plan` |
| `reachability` | *(S19 now)* `reachable` (from HEAD or an advertised ref) / `private-bundle-only` (present only in history the rewrite removed: the local object store holds it, a clean public clone does not, the controller's private bundle does; R22) / `unavailable` |
| `dependsOnPrivateBundle` | *(S19 now)* true when `reviewedSha`, `baseSha`, `postFixSha` or a fix commit is `private-bundle-only`: a clean public clone verifies the item only by its excerpts' hashes; the scorecard reports the count (R22) |
| `fixCommits[]` | *(S19 now)* `[{sha, reachability}]`, `reachability` ∈ `reachable, private-bundle-only`: commits after `reviewedSha` up to the next cycle with a known reviewed SHA whose subject names the finding id as a whole token (long form; Phase 2 also the short form its re-reviews use, e.g. `HIGH-005`); a rewritten copy of a commit already in the reviewed tree (same author date and subject) is not a fix |
| `postFixSha` | *(S19 now)* `R_{c+1}`: the reviewed SHA of the next cycle when that cycle re-reviews this one and its tree is known; else null |
| `negativeEligible` | eligible iff the item is `RESOLVED` at `c+1` and at least one location maps (plan §7.8) |
| `excerpts` | *(S19 now, cited files)* `[{side: reviewed|post-fix, path, sha256}]` → `blobs/<sha256>`; the post-fix side reads the same path at `postFixSha` (renames are followed by the mapping at the freeze); chunk diffs and post-images are added at the freeze |
| `excerptsWithheld` | *(S19 now)* `[{side, path, gates}]`: post-fix excerpts that fail a publication gate (a reviewed-side failure excludes the item instead) |
| `provenance` | *(S19 now)* `{doc, line}` for the label; `shaEvidence: {doc, line}` naming the reviewed SHA or the fix commit, null when derived; `excerptSource: git|object-store` (null without a tree); `excerptOnly` flag (true unless reachable) |
| `confirmation` | *(S19 now)* `{doc, line, status: RESOLVED|PARTIAL|REGRESSED|OPEN|null}` from the next cycle's document when that cycle is a re-review (line and status null when it has no row for the finding); null when no re-review follows |
| `severity`, `goldCategory`, `goldCategoryRationale`, `defectClass` | severity *(S19 now)* from the label, checked against the id's own token; `goldCategory` (category table `corpus-categories/v1`) and its one-line rationale assigned by Lane B |
| `locations[]` | *(S19 now)* `{file, lineStart, lineEnd}` at `reviewedSha`: every path token of the label, with its `:a-b,c` ranges, that is a file at `reviewedSha` (a file cited with lines drops its bare mention); empty without a tree |
| `mappedLocations[]` | `{file, lineStart, lineEnd}` at `postFixSha` (plan §7.8 mapping) |
| `labelSource` | `codex-gpt-5.6-sol`, `implementer-self-found`, `controller-ai-paraphrase` |
| `labelQuality` | `primary`, `secondhand` |
| `labellerMiss` | |
| `set` | `prompt-development` (Phase 1) / `reporting` (Phase 2); reporting labels were visible to the prompt author |
| `excluded` | null or `{reason, detail}` with the reasons and order of plan §7.8; S19 records only `plan-defect`, `reviewed-tree-unknown` (R22: the reviewed tree cannot be identified, or a needed tree is in no source) and `excerpt-unpublishable` (a cited file at `reviewedSha` fails a gate the repository runs over tracked files: format, secret, PII, large-file or the publication path-leak scan); `no-location` and the packet-level reasons are applied at the freeze. A gate that does not complete within its documented codes aborts collection (plan §7.5) |
| `synthetic` | the synthetic-field record of plan §7.8 (identity labels, objective text, `NOT_RECORDED`, masks applied) |
| `humanVerified` | null (DF-8) or `{by, at, agrees}` |

`manifest.json`: item ids, cycle records (`R_c`, `B_c`, sources, chunk ids and file lists), packet rule versions,
exclusion table, set counts, blob index, `corpusSha256`. The manifest and `corpusSha256` are written only at the
freeze.

### 7.2 Preregistration (`evals/review-benchmark/preregistration.json`, committed or hash-recorded by the controller)

`protocolSha256` (plan §7.8 text, category table `corpus-categories/v1`, the constants `T = 10`,
`maxPostImageBytesPerFile = 65536` and the git diff flags), `matcher` (`{tolerance: 10, categoryTable:
"corpus-categories/v1", strict: "location+category", lenient: "path", cardinality: "one-to-one-greedy"}`), `floors`
(plan §7.4), `k`, `sets`, `corpusSha256`, `reviewers: [{reviewerConfigId, configSha256}]` for primary and
comparator, `goldenItem` (`P2-FINAL-HIGH-003@2e61f24` and the sha256 of its fixture directory listing), `approvedBy`
(controller), `approvalRef` (commit SHA or review-log entry).

### 7.3 Recorded run (`evals/review-benchmark/recorded/<runId>/`)

`run.json` (descriptor, preregistration sha, corpus sha, set, k, gateway label and base-URL sha256, timestamps) plus one file per
(item, side, run index) with the observation and raw response bytes (base64) under a `manifest.sha256`. Each file
stays under the 500 KiB large-file limit and passes the secret and PII gates; one that cannot is excluded with
reason, never allowlisted.

### 7.4 Scorecard (`evals/review-benchmark/scorecards/<runId>.json`)

`scope` (`self-history`, `synthetic-injection`, `synthetic-false-green`), `eligibleForPromotion` (const `false` for
these scopes), `circularityStatement` (names the labeller model and every measured reviewer model), `gateway` (`{label, baseUrlSha256, altersRequests, alteredCallShare, unknownCallShare, appendixSha256s[]}`; required; the raw address is never written), `blindHoldout` (const `false` for self-history), hashes (corpus,
preregistration, descriptor, recordings, gateway label and base-URL sha256), denominators (eligible, excluded by reason), per reviewer and
per metric `{value, n, wilson95: [lo, hi], descriptiveOnly}` for: rediscovery recall strict/lenient (all,
first-occurrence, labeller-miss subset, per severity, per defect class); stale-flag rate on post-fix negatives;
precision over human-adjudicated findings plus the unadjudicated count; k-run stability; invalid-output rate;
tokens; cost or null; latency; baselines (`null-reviewer`, `deterministic-only`); primary-vs-comparator overlap;
`floorsMet` per floor; injection suite result (`MEETS_FLOOR | BELOW_FLOOR | INVALID_CONTROL`). Keys sorted; no
wall-clock fields inside the scored section.
