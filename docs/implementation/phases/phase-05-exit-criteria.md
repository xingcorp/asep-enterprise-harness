# Phase 5 — Exit Criteria (DRAFT v2; machine-checkable)

> Phase 5 meets a MUST only when its named test passes from a clean checkout of the phase branch, as run by the
> controller (CI on the pushed head, R58). Base `f613c7f`. Files marked *(new)* are created by the slice named in
> `phase-05-plan.md` §11. Unit suites run in `pnpm test`; `*.itest.ts` suites run in `pnpm test:integration`
> against real PostgreSQL, MinIO and Git. The index MUSTs run the real TypeScript 7.0.2 parser and the real
> `tsc --lsp --stdio` server on real Git repositories; a regex "AST", a mocked LSP or a hand-written index never
> satisfies them. Verdicts: plan §19.

## A. Baseline

- [ ] A1. `pnpm verify:all` exits 0 from a clean checkout, and `pnpm test:integration` exits 0
      (`scripts/verify-all.sh`; `scripts/integration/run-integration.mjs`).
- [ ] A2. `pnpm install --frozen-lockfile` is clean. No new third-party package; `adapters/repo-index` depends on
      `typescript` at exactly `7.0.2`, with no range operator (manifest assertion in
      `adapters/repo-index/src/indexer.test.ts` *(new)*, `asep-suite:repo-index`).
- [ ] A3. The compat gate classifies `context-pack` 1.0.0 → 1.1.0 as MINOR, accepts the four new contracts at
      1.0.0, and every other schema and snapshot byte is unchanged by Phase 5; `COMPATIBILITY.md` rises by exactly
      these four (R7). The generated `ContextPack['skills'][number]` has the optional `bundleSha256`, `role` and
      `instructions` (a type-level assertion compiled by `tsc -b`), while `WorkOrder['requiredSkills'][number]` stays
      `SkillRef` (`packages/contracts/src/compat-gate.test.ts`, `asep-suite:compat-gate`;
      `packages/contracts/src/context-contracts.test.ts` *(new)*, `asep-suite:context-contracts`;
      `packages/contracts/src/base-parity.test.ts`).
- [ ] A4. Migrations `0300`, `0301` and `0302` apply forward on a clean database and on one at the merged base,
      re-apply as a no-op, are refused when edited, and lie in `0300`–`0399`
      (`adapters/persistence/src/context/context-stores.itest.ts` *(new)*, `asep-suite:pg-context-stores`).
- [ ] A5. No required suite present at the base is removed, skipped or weakened
      (`scripts/run-canonical-tests.test.ts`, `asep-suite:canonical-runner`).

## R. Skill registry

- [ ] R1. A registry index signed by `scripts/skills/registry.mjs sign` with a key generated in the test verifies with
      only the committed-format trust root: the DSSE PAE bytes equal the spec's example vector
      (`DSSEv1 29 http://example.com/HelloWorld 11 hello world`), the signature is Ed25519 over PAE, and `keyId`
      is the sha256 of the SPKI DER (`adapters/skill-registry/src/registry.test.ts` *(new)*, `asep-suite:skill-registry`;
      `scripts/skills/registry.test.ts` *(new)*, `asep-suite:skill-registry-cli`).
- [ ] R2. Each refusal of architecture §5.3 is a test that loads nothing and throws its code: malformed trust root,
      recomputed `keyId` mismatch, envelope with two signatures or another `payloadType`, unknown `keyid`, one flipped
      signature bit, predicate invalid, subjects ≠ releases, `issuedAt` outside the key window, expired index,
      `sequence` below the minimum, an extra file in a release directory, a changed byte in `SKILL.md`, a changed
      byte in `skill.json`, a manifest whose id differs, a frontmatter `name` ≠ directory
      (`asep-suite:skill-registry`).
- [ ] R3. A production reader returns only `promoted` releases; `deprecated` and `revoked` releases are absent from
      what it returns. A production composer refuses an evaluation registry with `evaluation-registry-refused`
      before any write. No file under `apps/**` or `workers/**` imports `createEvaluationSkillRegistry`, and
      `adapters/skill-registry` contains no network API (fitness rules with seeded violations)
      (`asep-suite:skill-registry`; `asep-suite:context-core`; `scripts/forbidden-imports.test.ts` /
      `scripts/ts-guard.test.ts`, `asep-suite:forbidden-imports` / `asep-suite:ts-guard`).
- [ ] R4. The bytes a release is built from are the bytes verified: a test that rewrites `SKILL.md` on disk after
      `load()` returns gets the verified instructions in the composed pack, and `load()` opens each file once
      (`asep-suite:skill-registry`).
- [ ] R5. A revocation cannot be rolled back (architecture §5.3a). With test keys and one high-water store:
      (a) load index sequence 1 (skill X promoted), then sequence 2 (X revoked); (b) build a new reader on the same
      store, as after a restart, and put the sequence-1 file back: `load()` throws `sequence-rolled-back`, returns
      nothing and leaves the mark at 2; (c) another statement signed with sequence 2 throws `sequence-reused`;
      (d) reloading the identical sequence-2 file succeeds; (e) with no mark yet, an index below `minimumSequence`
      throws `sequence-below-minimum` and writes no mark, and the first accepted load writes it; (f) a load that
      fails a later step (`bundle-mismatch`) leaves the mark unchanged; (g) two concurrent loads of sequences 2 and 3
      end with the mark at 3 (`asep-suite:skill-registry`, in-memory store). On real PostgreSQL the mark survives a
      new connection pool, `advance` never lowers it under 20 concurrent callers, and the trigger refuses a direct
      lowering update and a delete (`asep-suite:pg-context-stores`).

## V. Vendored skills

- [ ] V1. Each of the five vendored `SKILL.md` files hashes (`git hash-object`) to the upstream git blob SHA pinned
      in `quarantine.json` and in research register §2, with the pinned byte size; each `LICENSE` likewise. The
      sha256 of each of the seven fetched files, recorded at the one authorized fetch (plan §18), equals the sha256
      of the committed bytes (`scripts/skills/vendored-skills.test.ts` *(new)*, `asep-suite:vendored-skills`).
- [ ] V2. Each candidate records upstream repository, commit, tag (where one exists), path, fetch URL, fetch date,
      sha256, SPDX license `MIT` and the sha256 of its source's `LICENSE`, in `quarantine.json` and in its
      `skill.json` provenance; research register §2 lists the same URL, sha256, SPDX id and date; and
      `skills/vendor/NOTICE.md` names each source with its copyright line (`asep-suite:vendored-skills`).
- [ ] V3. Static validation passes for each candidate and is recorded in `quarantine.json`: frontmatter per the
      Agent Skills specification (name 1–64 chars, lower-case alphanumerics and single hyphens, equal to the
      directory; description 1–1024 chars), body within the policy cap, outbound references listed, no
      executable file and no file other than `SKILL.md` and `skill.json` in the directory. Every candidate's status
      is quarantined: no committed signed index promotes it (`asep-suite:vendored-skills`).
- [ ] V4. Each `skill.json` validates `skill-manifest/v1` with `provenance.source: vendored`, the upstream URL and
      commit, `permissions.network: none`, `permissions.productionAccess: forbidden`; the bundle digest in
      `quarantine.json` equals the digest `adapters/skill-registry` computes (`asep-suite:vendored-skills`;
      `apps/control-plane-api/src/context-root.test.ts` *(new)*, `asep-suite:context-root`).

## I. Repository index

- [ ] I1. An index is built from Git objects at a pinned commit of a real temporary repository, with no worktree
      and no checkout: regular blobs only; symlinks and submodules are listed as skipped; a commit absent from the
      mirror throws `RepositoryIndexUnavailableError('base-sha-missing')`
      (`adapters/repo-index/src/indexer.test.ts` *(new)*, `asep-suite:repo-index`).
- [ ] I2. On a fixture repository the symbol map lists each top-level declaration with its kind, export flag and
      line, and the dependency map holds exactly the fixture's resolved in-repo imports; the index records
      `typescriptVersion` `7.0.2` read from the binary (`asep-suite:repo-index`).
- [ ] I3. References come from a real `tsc --lsp --stdio` process whose `serverInfo` is `typescript-go 7.0.2`; on a
      fixture workspace with two packages, a reference from package B to an export of package A through a
      workspace dependency is found, and the same fixture without the workspace link misses it (the control)
      (`adapters/repo-index/src/lsp.test.ts` *(new)*, `asep-suite:repo-index-lsp`).
- [ ] I4. The test map of the fixture maps each test file to exactly the source files it imports transitively
      (`asep-suite:repo-index`).
- [ ] I5. Two builds of the same commit produce identical bytes; the fixture's index equals the committed golden
      index byte for byte, and the golden's `indexerVersion` equals `INDEXER_VERSION`. Changing the policy's
      stopwords or test patterns changes `indexerDigest`; with an index for the old values already stored, the
      composer builds a new one whose bytes equal a fresh build under the new values (`asep-suite:repo-index`;
      the cache part in `asep-suite:context-core`).
- [ ] I6. Hostile inputs: a symlink to a file outside the repository, a `tsconfig.json` whose `extends` points outside
      the snapshot, a project `references` entry outside it, an import specifier that climbs out of the root, an
      absolute import, a file above `maxFileBytes`, more files than `maxFiles`, paths with a `..` segment or a
      newline, and a reference query that times out. The file-system jail answers every lookup outside the root as
      absent and records it (architecture §4.1a); an escape is a problem `outside-root-lookup`, and the LSP pass does
      not run for that build. Read detection uses a canary with a positive control: the outside base config turns on
      `allowJs`, and an inside `.js` file exports `outsideConfigWasRead`; with the jail the symbol is absent, and the
      same fixture loaded without the jail (a test-only switch the production factory cannot set) shows it, which
      proves the canary would catch a read. Nothing outside the snapshot appears in the index, nothing crashes the
      build, and each input is recorded as a skip, a problem or a `partial` capability
      (`adapters/repo-index/src/hostile-input.test.ts` *(new)*, `asep-suite:repo-index-hostile`).
- [ ] I7. No repository code runs: a fixture whose `package.json` has `preinstall`, `postinstall`, `prepare` and
      `test` scripts, and whose `tsconfig.json` names a plugin, each writing a canary file when run, leaves no canary
      after a build; the LSP child gets only `PATH` and a temporary `HOME` (`asep-suite:repo-index-hostile`).

## C. ContextPack and provenance

- [ ] C1. A composed pack validates `context-pack` 1.1.0; its `hash` equals `contextPackHash` of its body; its stored
      bytes equal `canonicalJson(pack)`; the artifact's sha256 is the sha256 of those bytes; a pack with one changed
      field fails the hash check (`packages/application/src/context/compose.test.ts` *(new)*,
      `asep-suite:context-core`).
- [ ] C2. The provenance validates `context-provenance/v1` and names the pack's id, hash, sha256 and size, the
      request and its digest, the policy sha256 and artifact, the index snapshot (id, sha256, indexer digest and
      version, capabilities), the registry mode, name, source sha256, sequence, trust-root sha256 and snapshot
      artifact, every ranked file with its per-signal scores, every selected skill with its bundle digest and
      reason, and every exclusion (`asep-suite:context-core`).
- [ ] C3. Replay: `replayContextPack` reads only the stored artifacts the provenance names (WorkOrder, index, policy,
      registry snapshot) and the recorded request, and yields byte-identical pack and provenance. The test composes,
      then changes `policies/context-policy.yaml` and the registry directory on disk (a new index, a revoked skill),
      and replays: still byte-identical. Changing any one stored input changes the pack or the provenance
      (`asep-suite:context-core`).
- [ ] C4. Exactly one `context_provenance` row per task and per pack; its FKs refuse another tenant's artifact, a
      wrong checksum, a wrong kind, another binding's task or index snapshot, for all five references; the tables
      refuse update and delete; every new reference passes the persistence suite's missing / other-tenant /
      wrong-checksum / wrong-kind matrix; two concurrent `record` calls for one task on two PostgreSQL connections
      leave one row and both return it (`adapters/persistence/src/context/context-stores.test.ts` *(new)*,
      `asep-suite:context-persistence`; `asep-suite:pg-context-stores`).
- [ ] C5. `compose` twice with the same request returns the same refs with `reused: true` and writes nothing; with a
      different work order, base SHA or tool policy for the same task it throws `conflicting-input` and writes
      nothing; with a later `generatedAt` it returns the first composition. Two concurrent `compose` calls with the
      same request and different `generatedAt` both return the refs of the one row that exists afterwards; two
      concurrent calls with different requests give one result and one `conflicting-input`
      (`asep-suite:context-core`).
- [ ] C6. Fail closed. An unknown or unpromoted required skill (`unknown-skill`), a registry that fails verification
      (`registry-unverifiable`), a WorkOrder that fails `work-order/v1`, and a base SHA that differs from the
      WorkOrder's each leave the artifact store, the index store and the provenance store unchanged, tested with an
      empty index cache (spy assertions). A missing commit (`index-unavailable`, retryable) writes nothing either.
      The one exception: a refusal that needs the index (a required skill excluded by the language filter,
      `over-budget`) may leave the index snapshot it built (artifact and row), and nothing else; the test asserts
      exactly that set (`asep-suite:context-core`).
- [ ] C7. Budgets: skills over `maxSkillBytes` are dropped in the documented order and listed as `budget`
      exclusions; required skills over budget give `over-budget`; no pack exceeds `maxPackBytes`; instructions in a
      pack are byte-equal to the verified `SKILL.md` body (never truncated)
      (`packages/application/src/context/router.test.ts` *(new)*, `asep-suite:skill-routing`).
- [ ] C8. Router tables: phase and language filters; the permission filter (`network`, `productionAccess`, tools
      against allowed and disallowed tools), each exclusion recorded with its reason; required skills honoured
      exactly by id and version; at most one primary, at most two adjuncts, one verification skill; a
      `conflictsWith` pair keeps the higher score; ties broken by id (`asep-suite:skill-routing`;
      ranking tables in `packages/application/src/context/ranking.test.ts` *(new)*, `asep-suite:context-ranking`).
- [ ] C9. End to end on real PostgreSQL, MinIO and a real bare Git mirror: `context-root.ts`'s composer composes a
      pack for a registered task; the pack and provenance are artifacts and the row exists; Phase 2's
      `attachContextPack` binds the same ref to an attempt; reading the ref back gives bytes whose sha256 equals the
      ref; `findByPack` finds the provenance; a registry file tampered after signing makes `compose` refuse with
      nothing written (`apps/control-plane-api/src/context/compose-e2e.itest.ts` *(new)*, `asep-suite:context-e2e`).

## E. Evaluation (the exit criterion: routing and context changes are evaluated, not anecdotal)

- [ ] E1. The corpus builder writes the committed `manifest.json` byte for byte from `preregistration.json` and the
      repository's history at `sourceHead`; every item's commit, parent, type, gold set, split, leak flag and label
      re-derive from Git; `preregistrationSha256` matches; the preregistration commit precedes the first scorecard
      commit in history (`evals/context-corpus/corpus.test.ts` *(new)*, `asep-suite:context-corpus`).
- [ ] E2. The runner composes with the function `@asep/application` exports, the production `RepositoryIndexer`
      class and the production registry verification (evaluation mode); a test asserts the identities, and the
      runner holds no ranking or routing code of its own (`evals/context-eval/eval-gate.test.ts` *(new)*,
      `asep-suite:context-eval-gate`).
- [ ] E3. Two runs give identical scorecard bytes (`asep-suite:context-eval-gate`).
- [ ] E4. The recomputed scorecard equals the committed `scorecard.json`; the seeded mutation (one weight changed in a
      copy of the policy) makes the gate report a mismatch with the differing item ids
      (`asep-suite:context-eval-gate`).
- [ ] E5. The committed scorecard meets `floors.json` against `baseline.json` on the full corpus and the holdout, or
      every breach has an `accepted-regressions.json` entry for that scorecard digest; and `default`'s micro
      `recall@10` exceeds `path-order`'s (`asep-suite:context-eval-gate`).
- [ ] E6. `report.md` is generated from the scorecard (the gate regenerates and compares it) and shows every variant
      on all items, dev, holdout and non-leaking items, the routing confusion counts and the per-item rank changes
      against the baseline (`asep-suite:context-eval-gate`).

## D. Documentation and report

Each D-MUST has an executable part in `evals/context-eval/docs-consistency.test.ts` *(new, S10)*,
`asep-suite:context-docs`, and a part that only a reader can judge, which the controller's final review covers.

- [ ] D1. `phase-05-report.md` quotes each gate's summary line and log path, names the SHA every result was observed
      at, and marks anything not run "not verified". *Executable:* every gate entry carries a line matching
      `samples=\d+ max_node_launch_ms=\d+ stalls_ge_10s=\d+` and a 40-hex SHA; every MUST id of this file appears
      in the report with a status and either its SUITE-ID or the words "not verified".
- [ ] D2. `phase-05-runbook.md` covers the key ceremony, trust-root changes, signing and promotion (with the
      scorecard digest in `approval`), deprecation, revocation (with raising `minimumSequence` and checking the
      high-water mark) and rotation, the minimum-sequence setting, and the change procedure of plan §9.5.
      *Executable:* the runbook has one heading per procedure in that list; every `scripts/skills/registry.mjs`
      subcommand and flag it shows exists in the CLI's command table; every refusal code it names is a member of
      `SkillRegistryRefusal`.
- [ ] D3. The threat model delta, ADR `0019` and `docs/platform/skill-system.md`, `context-and-memory.md`,
      `framework-support-matrix.md` match the delivered behaviour. *Executable:* the ADR file
      `docs/architecture/adr/0019-*.md` exists with a status line; the refusal codes listed in the threat model and
      architecture equal the exported `SkillRegistryRefusal` and `ContextCompositionRefusal` members; the
      `context-pack` fields named in `context-and-memory.md` exist in the 1.1.0 schema. *Reader:* the prose of these
      documents.

## Suite registry

| SUITE-ID | File | Runner | Slice |
|---|---|---|---|
| `asep-suite:context-contracts` | `packages/contracts/src/context-contracts.test.ts` | unit | S1 |
| `asep-suite:context-policy` | `packages/policy/src/context-policy.test.ts` | unit | S2 |
| `asep-suite:context-core` | `packages/application/src/context/compose.test.ts` | unit | S2 |
| `asep-suite:context-ranking` | `packages/application/src/context/ranking.test.ts` | unit | S2 |
| `asep-suite:skill-routing` | `packages/application/src/context/router.test.ts` | unit | S2 |
| `asep-suite:skill-registry` | `adapters/skill-registry/src/registry.test.ts` | unit | S3 |
| `asep-suite:skill-registry-cli` | `scripts/skills/registry.test.ts` | unit | S3 |
| `asep-suite:vendored-skills` | `scripts/skills/vendored-skills.test.ts` | unit | S4 |
| `asep-suite:repo-index` | `adapters/repo-index/src/indexer.test.ts` | unit | S5 |
| `asep-suite:repo-index-lsp` | `adapters/repo-index/src/lsp.test.ts` | unit | S5 |
| `asep-suite:repo-index-hostile` | `adapters/repo-index/src/hostile-input.test.ts` | unit | S5 |
| `asep-suite:context-persistence` | `adapters/persistence/src/context/context-stores.test.ts` | unit (PGlite) | S6 |
| `asep-suite:pg-context-stores` | `adapters/persistence/src/context/context-stores.itest.ts` | itest | S6 |
| `asep-suite:context-corpus` | `evals/context-corpus/corpus.test.ts` | unit | S7 |
| `asep-suite:context-eval-gate` | `evals/context-eval/eval-gate.test.ts` | unit (CR-P5-13 if over budget) | S8 |
| `asep-suite:context-root` | `apps/control-plane-api/src/context-root.test.ts` | unit | S9 |
| `asep-suite:context-e2e` | `apps/control-plane-api/src/context/compose-e2e.itest.ts` | itest | S9 |
| `asep-suite:context-docs` | `evals/context-eval/docs-consistency.test.ts` | unit | S10 |

The fitness rules of CR-P5-09 extend the existing `asep-suite:forbidden-imports` and `asep-suite:ts-guard`.

## Not Phase 5 exit (deferred, plan §4)

Model routing evaluation; outcome-level skill evaluation, shadow and canary; non-TypeScript indexing; semantic
retrieval; change coupling; dynamic test maps; containerized indexing; delivery of skill scripts and references;
production run events for context and skills; repair-pack provenance; a registry service.
