# Phase 5 — Plan Review Disposition Log

> Lane `phase-05` adjudication of the independent Codex plan review(s) run by the controller. At most two review
> rounds before the plan locks (R58).
>
> Each finding is dispositioned `ACCEPTED`, `PARTIALLY_ACCEPTED` or `REJECTED_WITH_EVIDENCE`. Findings are not
> auto-accepted. A rejection states its verification source (`.claude/rules/review-audit-self-decision.md`). Every
> accepted finding names the design section, the exit criterion and the slice that will prove it.

## Reviewed versions

| Version | Commit | Review | Verdict |
|---|---|---|---|
| DRAFT v1 | `6a4391a`, `afd32fa` (Phase 6 boundary, plan §18.1) | `~/.openclaw/lanes/phase-05/auto-review-afd32fa.md` | REQUEST_CHANGES, confidence 0.93 |
| DRAFT v2 | the docs commit that adds this entry | second round (controller) | pending |

## Summary (review of `afd32fa`)

| Severity | Count | ACCEPTED | PARTIAL | REJECTED |
|---|---|---|---|---|
| CRITICAL | 0 | | | |
| HIGH | 1 | 1 | | |
| MEDIUM | 5 | 4 | 1 | |
| LOW | 2 | 2 | | |

Every finding is folded into DRAFT v2. None is left for a follow-up slice outside the slice that implements it.

## Findings

### AUTO-HIGH-001 — a revocation can be rolled back (HIGH, blocking)
- Disposition: ACCEPTED.
- Evidence checked: v1 architecture §5.3 step 8 checked only `sequence ≥ minimumSequence`, a static setting; v1
  plan §7 made revocation "a new index with a higher sequence". Nothing remembered the highest accepted sequence,
  so restoring an older, still-valid index file brought a revoked skill back without a key. The review's probe
  agrees with that reading.
- Locked change: a persisted high-water mark per registry in PostgreSQL (architecture §5.3 step 10, §5.3a; data
  model §3.3, migration `0302_skill_registry_high_water`; port `SkillRegistryHighWaterStore`, architecture §8).
  Lower sequence → `sequence-rolled-back`; equal sequence with another statement → `sequence-reused`; equal and
  identical → accepted, so a restart reloads the same index; higher → the mark rises atomically. The first load is
  bounded by the deployment floor `minimumSequence`, and the runbook raises that floor with every revocation, so a
  new or restored database still refuses the revoked index. The mark is advanced last, so a failed load never moves
  it. Plan D5-2, §7, §16, §18.1, §20; threat T5-04; risk PR5-19.
- Note on "refuse any lower or equal sequence" (controller wording): an equal sequence is refused unless it is the
  byte-identical statement that set the mark. Refusing the identical statement would fail every load after the
  first, including after a restart.
- Validation: R5 (restart replay of the old index, reuse, floor, failed-load, concurrency; in-memory in S3,
  PostgreSQL in S6), A4 (`0302`).

### AUTO-MED-001 — `stopwords` and `testPatterns` are not in `indexerDigest` (MEDIUM)
- Disposition: ACCEPTED.
- Evidence checked: v1 architecture §4.3 hashed `[kind, INDEXER_VERSION, typescriptVersion, limits]` only, while §4.2
  uses the policy's stopwords and test patterns.
- Locked change: `indexerDigest` adds `config { stopwords, testPatterns }`, which the index also records
  (architecture §4.3, data model §1.2, port comment in §8).
- Validation: I5 (a policy change with an old index stored builds a new index equal to a fresh build); S5, S2.

### AUTO-MED-002 — concurrent identical requests can end in `conflicting-input` (MEDIUM)
- Disposition: ACCEPTED.
- Evidence checked: v1 `ContextProvenanceStore.record` threw on a different record, and two concurrent composes
  differ in `generatedAt`, hence in refs.
- Locked change: `record` returns the existing row to the loser (`insert … on conflict do nothing` then read);
  the composer compares `requestDigest` and returns the winner's refs with `reused: true` (architecture §6.3, §8;
  data model §3.2; plan §6).
- Validation: C5 (two concurrent composes, in-memory), C4 (two PostgreSQL connections); S2, S6.

### AUTO-MED-003 — I6 forbids reads outside the snapshot, T5-06 allowed them (MEDIUM)
- Disposition: PARTIALLY_ACCEPTED.
- Evidence checked: v1 I6 and v1 T5-06 contradicted each other. TypeScript 7.0.2's API takes `fs` callbacks
  (`dist/api/options.d.ts:15`, `dist/api/fs.d.ts:5-21`; research register §1), so reads can be blocked, not only
  filtered.
- Locked change: the symbol and import pass runs on a file-system jail that answers every path outside the root as
  absent and records it; escapes (`extends`, `references`, imports leaving the root, absolute paths) are problems
  `outside-root-lookup`; the LSP pass, which has no hook, runs only when the jail saw no escape and the real
  ancestors hold none of the probed names (architecture §4.1a; data model §1.2; T5-06).
- Not accepted as stated: "block every read before the LSP loads config". The LSP has no file-system hook, so the
  plan gates it instead and records the residual (an LSP lookup the jailed pass did not make) in T5-06; only
  containerized indexing, still deferred, removes it. Risk PR5-20 covers a jail that turns out incomplete.
- Validation: I6 (canary with a positive control: an outside base config enabling `allowJs` shows its symbol only
  without the jail); S5, first task.

### AUTO-MED-004 — `x-tsType: SkillRef` hides the new skill fields (MEDIUM)
- Disposition: ACCEPTED.
- Evidence checked: `packages/contracts/schema/context-pack.schema.json:29`; the generator returns the override
  name without the properties (`packages/contracts/src/gen/generate-types.ts:89-92`); `SkillRef` is `{id, version}`
  (`packages/contracts/src/base.ts:68`).
- Locked change: `ContextPackSkill` in `base.ts`; the context-pack items point at it; `SkillRef` stays for
  `WorkOrder.requiredSkills` (data model §1.1; CR-P5-01; S1 row).
- Validation: A3 (type-level assertion on the generated type, base-parity test); S1.

### AUTO-MED-005 — provenance keeps only hashes of policy and registry, so replay cannot fetch them (MEDIUM)
- Disposition: ACCEPTED.
- Evidence checked: v1 data model §1.3 `inputs.policy {version, sha256}`, registry digests only; C3 needed the
  bytes.
- Locked change: two new artifact kinds, `context-policy` (raw bytes) and `skill-registry-snapshot` (what the
  router saw), written with the pack, named in the provenance and bound by scoped FKs on the provenance row;
  `replayContextPack` reads only stored artifacts (architecture §6.1, §7, §8; data model §1.3, §3.2, §4; plan §6,
  §18.1 retention note for Phase 6).
- Validation: C3 (replay after changing the policy file and the registry on disk), C2, C4; S2, S6.

### AUTO-LOW-001 — index written before the required-skill check, against C6 (LOW)
- Disposition: ACCEPTED.
- Locked change: required skills are checked against id, version, status, phase and permissions before the index is
  read or built; only the language filter waits for the index. C6 states the one exception (a refusal that needs the
  index may leave the index snapshot, nothing else) and tests with an empty index cache (architecture §6.3; plan
  §6).
- Validation: C6; S2.

### AUTO-LOW-002 — D1–D3 have no executable test (LOW)
- Disposition: ACCEPTED.
- Locked change: `evals/context-eval/docs-consistency.test.ts`, `asep-suite:context-docs`, checks the executable part
  of each D-MUST (gate summary lines and SHAs, every MUST id with a status, runbook headings, CLI subcommands,
  refusal codes, ADR `0019` file, schema fields named in the platform docs); the prose stays a reader's judgement in
  the controller's final review (exit criteria §D; plan S10, §15).
- Validation: D1–D3; S10.

### Uncaught mutation reported by the review
The review notes that the existing drift guard passes when the three fields are added but the `x-tsType` override is
kept. A3's type-level assertion is the test that catches it (AUTO-MED-004).

## Controller decisions applied (R68)

| Decision | Changed |
|---|---|
| G-NET: one fetch of the seven pinned URLs, in S4 at implementation time; URL, sha256, SPDX id and date recorded; a non-redistributable license stops that item | plan §7, §11 (S4), §18, §21.3; exit V1, V2; research register §2; risk PR5-09 |
| ADR numbers: `0019` Phase 5, `0020` Phase 6, `0018` reserved for Phase 4, `0017` Phase 3 | plan §15, §18, §18.1, S10; exit D3 |
| Key ceremony: an operator (user) step with a runbook; dev and test keys only in test fixtures; `COMPLETE` gated on the real ceremony | plan §7, §18; architecture §5.5; exit D2 |
| "Routing" = skill routing; model routing deferred | plan §18, §21.2; risk PR5-18 |
| The 180 s evaluation budget is measured in S8 | plan §18 |
| G-P3S1: the controller merges Phase 3 through S1 after its S1 compat-gate fix | plan §18, §21.1 |

## Lock record

<!-- Plan version, commit, date, and the controller's confirmation. -->
