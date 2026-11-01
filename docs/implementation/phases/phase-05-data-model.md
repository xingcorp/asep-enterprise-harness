# Phase 5 — Data Model (DRAFT v2)

> Companion to `phase-05-plan.md`. PostgreSQL 17 as in Phase 2. Base `f613c7f`. Phase 5 migration range:
> **`0300`–`0399`** (lane contract, R58). Every table follows the Phase 2 conventions (`phase-02-data-model.md` §1):
> `char(26)` ULID keys, `timestamptz` UTC, composite FKs onto scoped parents, `TenantScope` first in every store
> method, and every artifact reference as `<name>_artifact_id` + `<name>_sha256` + generated `<name>_kind`,
> registered in `artifact_reference_columns` (`adapters/persistence/src/migrations.ts:1063-1071`).

## 1. Contracts (D-1, R7)

All new contracts are `1.0.0` with `$id https://asep.dev/schema/<name>/v1`, `additionalProperties: false` at every
level, and every string constrained by `pattern`, `enum` or `format`. Each gets valid and invalid fixtures, a
`snapshots/v1/` entry and a generated type.

### 1.1 `context-pack` 1.0.0 → 1.1.0 (MINOR)

| Change | Compat class (`COMPATIBILITY.md`) |
|---|---|
| `skills[].bundleSha256`: optional, `^[0-9a-f]{64}$` | add optional property → MINOR |
| `skills[].role`: optional, enum `primary`, `adjunct`, `verification` | add optional property → MINOR |
| `skills[].instructions`: optional string, `maxLength` 32 768 | add optional property → MINOR |
| `hash.description`: "`sha256:` + hex sha256 of the canonical JSON (keys sorted at every level, no whitespace, UTF-8) of the pack without `hash`" | annotation → NONE |
| `skills.items` `x-tsType`: `SkillRef` → `ContextPackSkill` | annotation; the generated type only (see below) |

No property becomes required and no constraint tightens, so every 1.0.0 pack stays valid. The recipe is enforced in
code (`contextPackHash`, and a verifier in the composer's tests), not by a pattern on `hash`, which would be a MAJOR
tightening.

**Generated type.** The skills items carry `"x-tsType": "SkillRef"` (`context-pack.schema.json:29`), and the
generator returns an `x-tsType` name without looking at the properties (`packages/contracts/src/gen/generate-types.ts:89-92`).
Left as is, the generated `ContextPack` would keep `SkillRef` (`{id, version}`, `packages/contracts/src/base.ts:68`)
and hide the three new fields, and the drift guard would not notice. S1 therefore adds `ContextPackSkill` to
`base.ts` (`id`, `version`, optional `bundleSha256`, `role`, `instructions`), points the context-pack items at it,
and keeps `SkillRef` for `WorkOrder.requiredSkills`. The base-parity test (`packages/contracts/src/base-parity.test.ts:49`)
checks the new override against the schema, and `context-contracts.test.ts` asserts at type level that
`ContextPack['skills'][number]` has the three optional fields (A3). Not verified: how the compat gate classifies an
`x-tsType` change; S1 runs it before committing.

### 1.2 `repository-index/v1`

```text
schemaVersion        "1.0.0"
baseSha              ^[0-9a-f]{40}$
indexerVersion       semver
indexerDigest        ^[0-9a-f]{64}$
typescriptVersion    semver | null              null when no TypeScript map was built
limits               { maxFiles, maxFileBytes, maxReferenceQueries, lspRequestTimeoutMs, buildTimeoutMs }  integers ≥ 0
config               { stopwords[] ^[a-z0-9]{3,64}$ (sorted, unique), testPatterns[] (sorted, unique) }
                     the index-shaping policy values; hashed into indexerDigest (architecture §4.3)
capabilities         { files: complete|partial,
                       lexical, symbols, dependencies, references, tests: complete|partial|absent }
files[]              { path, blobSha ^[0-9a-f]{40}([0-9a-f]{24})?$, size ≥ 0,
                       language: typescript|javascript|json|markdown|yaml|other,
                       role: source|test|other,
                       skipped: null|oversize|binary|symlink|submodule|invalid-path|over-file-cap }
tokens[]             { token ^[a-z0-9]{3,64}$, postings[] { file ≥ 0, count ≥ 1 } }
symbols[]            { file ≥ 0, name ^[A-Za-z_$][A-Za-z0-9_$]{0,127}$,
                       kind: function|class|interface|type|enum|variable|namespace, exported: boolean, line ≥ 1 }
imports[]            { from ≥ 0, to ≥ 0 }
references[]         { symbol ≥ 0, files[] { file ≥ 0, count ≥ 1 } }
tests[]              { test ≥ 0, sources[] ≥ 0 }
problems[]           { kind: project-load|unresolved-import|lsp-timeout|lsp-crash|cap-reached|skipped-entry|
                             outside-root-lookup,
                       path: string|null, detail: string ≤ 512 }   maxItems 1000
```

`path` pattern: `^(?!/)(?!(?:.*/)?\.\.(?:/|$))[^\u0000-\u001f\u007f]{1,1024}$`. File, symbol and test references
are indexes into `files[]` and `symbols[]`; a reader checks every index is in range (the schema cannot), and
fails closed otherwise.

### 1.3 `context-provenance/v1`

```text
schemaVersion        "1.0.0"
composerVersion      semver
contextPack          { id ^ctx-[0-9a-f]{32}$, hash ^sha256:[0-9a-f]{64}$, sha256 ^[0-9a-f]{64}$, bytes ≥ 0 }
request              { repositoryBindingId ULID, taskId ULID, baseSha 40-hex,
                       workOrder { artifactId ULID, sha256 64-hex },
                       toolPolicy { allowedTools[], disallowedTools[] }   tool names ^[A-Za-z][A-Za-z0-9_.:-]{0,127}$
                       generatedAt date-time }
requestDigest        64-hex
inputs               { policy { version semver, sha256 64-hex, artifactId ULID },
                       repositoryIndex { snapshotId ULID, sha256 64-hex, indexerDigest 64-hex, indexerVersion semver,
                                         capabilities (as in 1.2) },
                       skillRegistry { mode production|evaluation|none, registry (pattern of 1.4)|null,
                                       sourceSha256 64-hex|null, sequence ≥ 1 | null, trustRootSha256 64-hex|null,
                                       snapshot { artifactId ULID, sha256 64-hex } } }
inputDigest          64-hex
query                { tokens[] ^[a-z0-9]{3,64}$ }
files[]              { path, rank ≥ 1, score ≥ 0,
                       signals { lexical, symbol, reference, dependency, test } integers ≥ 0, inAllowedPaths boolean }
symbols[]            { ref ^.{1,1024}#[A-Za-z_$][A-Za-z0-9_$]{0,127}$, rank ≥ 1, score ≥ 0 }
skills[]             { skillId, version semver, bundleSha256 64-hex, role primary|adjunct|verification,
                       reason required|ranked|verification, score ≥ 0, instructionsBytes ≥ 0 }
excluded[]           { kind skill|file, id, reason permission-network|permission-production|permission-tools|
                       phase|language|conflict|budget|below-threshold|over-k }
budget               { maxPackBytes, packBytes, maxSkillBytes, skillBytes }   integers ≥ 0
```

`skillId` pattern (also in 1.4): `^[a-z0-9]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$`. Scores are integers (architecture §6.2),
so a provenance record carries no floating point.

### 1.4 `skill-registry-index/v1` (the predicate of the signed statement)

```text
schemaVersion        "1.0.0"
registry             ^[a-z0-9][a-z0-9-]{0,63}$
sequence             integer ≥ 1
issuedAt, expiresAt  date-time                    reader also checks issuedAt < expiresAt
releases[]           { skillId, version semver, status promoted|deprecated|revoked,
                       path (registry-relative directory, path pattern of 1.2),
                       files[] { path, sha256 64-hex, size ≥ 0 }   minItems 2 (SKILL.md, skill.json)
                       bundleSha256 64-hex, manifestSha256 64-hex,
                       provenance { source internal|vendored,
                                    upstream { repository ^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ | null,
                                               commit 40-hex | null, tag ^[A-Za-z0-9._-]{1,64}$ | null,
                                               path | null },
                                    license (SPDX id, ^[A-Za-z0-9.+-]{1,64}$), licenseFileSha256 64-hex | null },
                       approval { approvedBy ULID (operator principal id; never a personal name),
                                  approvedAt date-time, evaluationScorecardSha256 64-hex | null } }
```

### 1.5 `skill-trust-root/v1`

```text
schemaVersion        "1.0.0"
threshold            enum [1]                     more signers later is a MINOR (add enum values)
keys[]               { keyId 64-hex (sha256 of SPKI DER), algorithm enum [ed25519],
                       publicKeySpki base64 ^[A-Za-z0-9+/]{40,}={0,2}$, roles[] enum [registry-index],
                       validFrom, validUntil date-time }          minItems 0
```

## 2. Files outside the database

| File | Format | Owner |
|---|---|---|
| `skills/vendor/<source>/<skill>/SKILL.md` | upstream bytes, verbatim | S4 |
| `skills/vendor/<source>/<skill>/skill.json` | `skill-manifest/v1`, `provenance.source: vendored`, `upstream`, `commit` | S4 |
| `skills/vendor/<source>/LICENSE`, `skills/vendor/NOTICE.md` | upstream text verbatim; attribution list | S4 |
| `skills/registry/trust-root.json` | `skill-trust-root/v1`, `keys: []` until the operator adds one | S4 (file), operator (keys) |
| `skills/registry/quarantine.json` | internal: `{schemaVersion, candidates[] {skillId, version, path, files[], bundleSha256, manifestSha256, provenance, upstreamBlobs[] {path, gitBlobSha1, size, url}, validation {frontmatter, bodyBytes, outboundReferences[], executableFiles[]}}}`, parsed by a structural parser in `adapters/skill-registry` | S4 |
| `skills/registry/index.dsse.json` | DSSE envelope (architecture §5.2) | operator |
| `policies/context-policy.yaml` | weights, `K`, `M`, `L`, thresholds, budgets, caps, tokenizer stopwords, test patterns, `verificationSkill`; loader returns the object and the sha256 of the raw bytes | S2 |
| `evals/context-corpus/preregistration.json` | the rules of plan §9.1, verbatim, with `sourceHead` | S7 |
| `evals/context-corpus/manifest.json` | `{schemaVersion, preregistrationSha256, sourceHead, items[] {id, sha, parent, type, split, leak, objective, gold[], label}, counts, corpusSha256}` | S7 |
| `evals/context-eval/scorecard.json`, `baseline.json` | canonical JSON `{schemaVersion, corpusSha256, preregistrationSha256, composerVersion, indexerVersion, variants {name: {policySha256, items[] {id, goldRanks[], primarySkill, packBytes}, aggregates {all, dev, holdout, nonLeaking}}}}` | S8 |
| `evals/context-eval/floors.json`, `accepted-regressions.json` | floors of plan §9.4; entries `{scorecardSha256, metric, approver, rationale}` | S8 |

## 3. Migrations

### 3.1 `0300_repository_index_snapshots`

```sql
create table repository_index_snapshots (
  id                    char(26) primary key,
  organization_id       char(26) not null,
  project_id            char(26) not null,
  repository_binding_id char(26) not null,
  base_sha              text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  indexer_digest        text not null check (indexer_digest ~ '^[0-9a-f]{64}$'),
  index_artifact_id     char(26) not null,
  index_sha256          text not null,
  index_kind            text generated always as ('repository-index') stored,
  created_at            timestamptz not null default now(),
  unique (organization_id, project_id, repository_binding_id, base_sha, indexer_digest),
  unique (id, organization_id, project_id, repository_binding_id),
  foreign key (repository_binding_id, organization_id, project_id)
    references repository_bindings (id, organization_id, project_id),
  foreign key (index_artifact_id, organization_id, project_id, index_sha256, index_kind)
    references artifacts (id, organization_id, project_id, sha256, kind)
);
-- append-only: a trigger refuses update and delete
insert into artifact_reference_columns (table_name, reference_name, kind)
  values ('repository_index_snapshots', 'index', 'repository-index');
```

The key includes the tenant: two projects on the same repository and commit get two snapshots (threat T5-12).

### 3.2 `0301_context_provenance`

```sql
create table context_provenance (
  id                        char(26) primary key,
  organization_id           char(26) not null,
  project_id                char(26) not null,
  repository_binding_id     char(26) not null,
  task_id                   char(26) not null,
  context_pack_artifact_id  char(26) not null,
  context_pack_sha256       text not null,
  context_pack_kind         text generated always as ('context-pack') stored,
  provenance_artifact_id    char(26) not null,
  provenance_sha256         text not null,
  provenance_kind           text generated always as ('context-provenance') stored,
  policy_artifact_id        char(26) not null,
  policy_sha256             text not null,
  policy_kind               text generated always as ('context-policy') stored,
  registry_snapshot_artifact_id char(26) not null,
  registry_snapshot_sha256  text not null,
  registry_snapshot_kind    text generated always as ('skill-registry-snapshot') stored,
  index_snapshot_id         char(26) not null,
  request_digest            text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  created_at                timestamptz not null default now(),
  unique (organization_id, project_id, task_id),
  unique (organization_id, project_id, context_pack_artifact_id),
  foreign key (task_id, organization_id, project_id, repository_binding_id)
    references tasks (id, organization_id, project_id, repository_binding_id),
  foreign key (context_pack_artifact_id, organization_id, project_id, context_pack_sha256, context_pack_kind)
    references artifacts (id, organization_id, project_id, sha256, kind),
  foreign key (provenance_artifact_id, organization_id, project_id, provenance_sha256, provenance_kind)
    references artifacts (id, organization_id, project_id, sha256, kind),
  foreign key (policy_artifact_id, organization_id, project_id, policy_sha256, policy_kind)
    references artifacts (id, organization_id, project_id, sha256, kind),
  foreign key (registry_snapshot_artifact_id, organization_id, project_id, registry_snapshot_sha256,
               registry_snapshot_kind)
    references artifacts (id, organization_id, project_id, sha256, kind),
  foreign key (index_snapshot_id, organization_id, project_id, repository_binding_id)
    references repository_index_snapshots (id, organization_id, project_id, repository_binding_id)
);
-- append-only: a trigger refuses update and delete
insert into artifact_reference_columns (table_name, reference_name, kind) values
  ('context_provenance', 'context_pack', 'context-pack'),
  ('context_provenance', 'provenance', 'context-provenance'),
  ('context_provenance', 'policy', 'context-policy'),
  ('context_provenance', 'registry_snapshot', 'skill-registry-snapshot');
```

- The task FK targets `tasks_id_scope_binding_uq` (`migrations.ts:384-385`), so the provenance's binding is its
  task's binding, and the index snapshot's binding is the same one.
- One composition per task, one provenance per pack. An attempt whose `context_pack_artifact_id` has no
  `context_provenance` row was not composed by the harness (a Phase 2 or pre-wiring Phase 3 pack, or a Phase 4
  repair pack); `findByPack` returns null for it.
- The insert is `insert … on conflict (organization_id, project_id, task_id) do nothing`, followed by a read of the
  task's row in the same transaction; the store returns that row with `created` = whether this insert made it.
  Two concurrent composes of one task therefore converge on one row (architecture §6.3).
- `artifacts.kind` is free text (`migrations.ts:161`), so the two new kinds need no change to the artifacts table.

### 3.3 `0302_skill_registry_high_water`

```sql
create table skill_registry_high_water (
  registry           text primary key check (registry ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  sequence           bigint not null check (sequence >= 1),
  statement_sha256   text not null check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  trust_root_sha256  text not null check (trust_root_sha256 ~ '^[0-9a-f]{64}$'),
  advanced_at        timestamptz not null default now()
);
-- a trigger refuses delete, and any update whose new sequence is not greater than the old one
```

`advance` is one statement:

```sql
insert into skill_registry_high_water (registry, sequence, statement_sha256, trust_root_sha256)
values ($1, $2, $3, $4)
on conflict (registry) do update
  set sequence = excluded.sequence, statement_sha256 = excluded.statement_sha256,
      trust_root_sha256 = excluded.trust_root_sha256, advanced_at = now()
  where skill_registry_high_water.sequence < excluded.sequence;
select registry, sequence, statement_sha256, trust_root_sha256 from skill_registry_high_water where registry = $1;
```

The table holds deployment state, not tenant data: one registry serves every project of the deployment, so it has
no `organization_id` and no artifact reference. Phase 6's access-class registry classifies it as deployment-wide
(plan §18.1).

### 3.4 Rules

- The three migrations create new tables only; no Phase 2, 3 or 4 table, column or constraint changes.
- The persistence suite's three-way reference check (naming convention, registry, FKs; `phase-02-data-model.md`
  §3) covers the five new references without change, and its missing / other-tenant / wrong-checksum /
  wrong-kind matrix runs over them (C4).
- Rollback is a forward migration dropping `context_provenance`, then `repository_index_snapshots`, and their
  registry rows. Nothing else references them. `skill_registry_high_water` is never dropped by a rollback: losing it
  re-opens the rollback window down to the configured floor.

## 4. Artifact kinds

| Kind | Content type | Written by | Bound by |
|---|---|---|---|
| `repository-index` | `application/json` (canonical) | composer, from the indexer's bytes | `repository_index_snapshots.index_*` |
| `context-pack` | `application/json` (canonical) | composer | `context_provenance.context_pack_*`, `attempts.context_pack_*` (Phase 2) |
| `context-provenance` | `application/json` (canonical) | composer | `context_provenance.provenance_*` |
| `context-policy` | `application/yaml` (the raw bytes as loaded) | composer | `context_provenance.policy_*` |
| `skill-registry-snapshot` | `application/json` (canonical, architecture §7) | composer | `context_provenance.registry_snapshot_*` |
