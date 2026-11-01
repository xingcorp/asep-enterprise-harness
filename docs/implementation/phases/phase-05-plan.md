# Phase 5 — Skill and Context Platform — Plan (DRAFT v2)

> Status: **DRAFT v2**, folding the first Codex review (`auto-review-afd32fa.md`, REQUEST_CHANGES) and the
> controller's decisions of R68; dispositions in `phase-05-review-log.md`. Lane `phase-05` wrote it in its planning
> steps (docs only). No code, test, migration or configuration is part of these steps.
> Scope source: `docs/implementation/90-day-plan.md:42-49` (Days 61–75).
> Binding inputs: the lane contract with every addendum, and reconciliation R1–R5, R7, R10, R11, R51, R54–R59, R68
> (`~/.openclaw/lanes/reconciliation-v1.md`). Where they and this plan disagree, they win.

```text
BASE_SHA:       f613c7fd86e49317bb439b57575518e2ff48c641  (accepted Phase 2 with its CI fixes, R51, R59)
BRANCH:         phase/05-skill-context-platform
OTHER LANES:    Phase 3 plan read at phase/03-durable-orchestration (S1 at 5cc8eaf); Phase 4 plan read at
                phase/04-independent-assurance; Phase 6 plan (DRAFT) read at phase/06-brownfield-hardening
                @ bd9c9be (boundary in §18.1)
IMPLEMENTATION: starts only after the plan locks and the controller says "implement" (R58 item 4)
```

Companion documents: `phase-05-architecture.md`, `phase-05-data-model.md`, `phase-05-exit-criteria.md`,
`phase-05-risk-register.md`, `phase-05-research-register.md`, `phase-05-threat-model-delta.md`,
`phase-05-review-log.md`.

---

## 0. Execution model and pace

| Step | Who | Output |
|---|---|---|
| 1 | `phase-05` (this step) | the Phase 5 document set, one docs commit |
| 2 | Controller | Codex plan review (read-only) → `auto-review-afd32fa.md` (REQUEST_CHANGES, one HIGH) |
| 3 | `phase-05` | every finding adjudicated in `phase-05-review-log.md`, folded into the canonical docs (DRAFT v2) |
| 3a | Controller | at most one more review round (R58: at most two rounds before lock) |
| 4 | `phase-05`, `phase-05-c2`, `phase-05-c3` | one slice per commit (§11), each lane only its own slices (§13) |
| 5 | Controller | CI runs on the pushed heads; pipelined Codex reviews; only CRIT/HIGH block (R58) |
| 6 | Controller | merges |

Gates follow the R58 addendum: focused tests and `pnpm typecheck` after each commit; one
`~/.openclaw/lanes/gate.sh <lane> pnpm verify:all` at the end of each slice, plus `pnpm test:integration` when the
slice adds or changes an itest.

---

## 1. Current-state audit (read at `f613c7f`)

### 1.1 What exists

| Asset | Evidence |
|---|---|
| `context-pack/v1` 1.0.0: closed object; `skills` items are `{id, version}` only; `hash` is a free string with no defined recipe | `packages/contracts/schema/context-pack.schema.json:4`, `:8`, `:19-31`, `:34` |
| `skill-manifest/v1` 1.0.0 with activation, role, permissions, compatibility and a free `signature` string; no caller | `packages/contracts/schema/skill-manifest.schema.json:8`, `:13`, `:24-71` |
| `WorkOrder.requiredSkills` carries `{id, version}` refs; nothing resolves them | `packages/contracts/schema/work-order.schema.json:20-32` |
| Tool policy denies public skill installs | `policies/tool-policy.yaml:7` |
| One internal example skill | `skills/examples/systematic-debugging/SKILL.md` |
| Phase 1 eval runner with a table-driven `skill-routing` grader over one synthetic fixture | `evals/runner/graders.ts:96-117`, `evals/fixtures/04-skill-routing.json` |
| Deterministic JSON for eval output | `evals/runner/run.ts:95` (`stableStringify`) |
| The agent receives the context pack as a read-only file, re-hashed against its `ArtifactRef` before the mount | `adapters/agent-claude/src/claude-provider.ts:694-700`; prompt `:291-306` |
| Attempts bind the context pack by scoped FK with kind and checksum | `adapters/persistence/src/migrations.ts:944-951`; registry row `:1071` |
| Hardened `runGit` (sanitized env, hooks off, protocol allowlist) exported by `@asep/git-worktree` | `adapters/git-worktree/src/git-exec.ts:35-63`, `:78`; `index.ts:10-11` |
| Base SHA must already be in the binding's mirror; the adapter does not fetch | `adapters/git-worktree/src/worktree-manager.ts:117-121` |
| Ed25519 over a domain-separated payload with `node:crypto`, private key out of tree, public key committed | `scripts/lib/acceptance-crypto.mjs:1-48` |
| TypeScript 7.0.2 (native) pinned in the lockfile; its `unstable/sync` API is already used by the fitness guard | `node_modules/typescript/package.json`; `scripts/lib/ts-guard.mjs:51-52` |

### 1.2 Gaps the phase closes

| # | Gap (observed) | Evidence | Consequence |
|---|---|---|---|
| G1 | The context pack is a free `Record<string, unknown>` from the caller, serialized with `JSON.stringify` and stored as is. Nothing builds it, nothing validates it against `context-pack/v1`. | `packages/application/src/vertical-slice-workflow.ts:228-231`, `:369-376`; default `{ relevantFiles: ['feature.txt'] }` at `apps/control-plane-api/src/vertical-slice.ts:381` | No harness-built context; key order decides the bytes; no provenance. |
| G2 | The pack's `hash` field has no recipe. Phase 4's repair pack "recomputes" it. | schema `:34`; `phase-04-plan.md` §13 (`git show phase/04-independent-assurance:…`, lines 1002-1005) | Two lanes can compute two different hashes for the same pack. |
| G3 | No skill ever reaches the agent. `requiredSkills` and `ContextPack.skills` are ids only. | `claude-provider.ts:291-306` mounts only the work order and the pack | Skills are documentation, not delivered procedure. |
| G4 | No registry, no signature verification, no trust root. `signature` is a free string. | `skill-manifest.schema.json:13` | ADR 0007 is not implemented. |
| G5 | No repository index. | no lexical, AST, LSP, dependency or test-map code under `packages/`, `adapters/` | Context is whatever the caller types. |
| G6 | No evaluation of context or routing. The Phase 1 grader checks a static table. | `evals/runner/graders.ts:96-117` | Routing and context changes are anecdotal: the exit criterion fails. |
| G7 | Phase 3 takes the pack from the client and validates and stores it. | `phase-03-plan.md` §10 (lines 334-337), §11 `storeAttemptInputs` (line 383); `task-workflow-input.schema.json` `contextPackRef` | Without a seam, Phase 5's composer never runs in the durable path. |

### 1.3 Lessons from Phase 2 applied

From `phase-02-final-review-codex-v1.md` and `phase-02-final-rereview-codex-v5.md`:

1. **Green gates that skipped the MUSTs.** Every MUST in `phase-05-exit-criteria.md` names one executable test and
   its SUITE-ID. The evaluation gate recomputes the scorecard on every run and fails on a mismatch; a seeded change
   of one ranking weight proves it goes red (E4).
2. **Faked backends.** The index is built by the real TypeScript 7 parser and the real `tsc --lsp --stdio` server.
   There is no regex "AST" and no fallback; the index records the server's own identity (I2, I3). The evaluation
   runs the production composer and the production indexer, and a test checks the function identity (E2).
3. **False status claims.** The report quotes gate output and log paths; anything not run is "not verified". The
   verdict has qualifiers for what an operator or another lane must still do (§19).

---

## 2. Probes run in this step (evidence, 2026-10-31, this host)

| Probe | Result |
|---|---|
| `tsc --lsp --help` (pinned 7.0.2 native binary) | `-stdio`, `-pipe`, `-socket` modes exist |
| LSP over stdio on the live checkout: `initialize`, `textDocument/references` on `admitRisk` | serverInfo `typescript-go 7.0.2`; `referencesProvider` and `documentSymbolProvider` true; 9 references in 6 files, incl. `apps/control-plane-api/src/pilot-verifier.test.ts`; 0.6 s end to end |
| Same, on a `git archive f613c7f` snapshot with no `node_modules` | 8 references in 5 files: the cross-package reference through `@asep/application` is missing |
| Same snapshot with one pnpm-style relative link `apps/control-plane-api/node_modules/@asep/application → ../../../../packages/application`, root given by its real path | 9 references in 6 files, the same set as the live checkout |
| `git grep -n -I -F -i -e readiness 6f825cc -- '*.ts'` (search a commit without a checkout) | 0.05 s |
| Corpus candidates from `git log f613c7f` (rule in §9.1) | qualifying commits: fix 69, feat 39, refactor 3, test 20; with the cap of 10 per type, 33 items |
| Tools present: git 2.55.0, ripgrep 14.1.1, Node 24.6.0 | observed; ripgrep is not used (§3, D5-6) |

The probe scripts lived in `/tmp` and were removed. They are research, not repository code.

---

## 3. Decisions

| ID | Decision | Why | Rejected |
|---|---|---|---|
| D5-1 | **Signing: DSSE v1.0.2 envelope over an in-toto Statement v1, Ed25519 with `node:crypto`.** Trust root of public keys committed in the repository; signing key held by the operator, out of tree. | Offline, self-hosted, no new dependency, same primitive the repo already uses (`acceptance-crypto.mjs`), and a standard envelope that other tools can read. | cosign 3.1.4: its key-based verify still expects a transparency log or a bundle, and it adds a Go binary. minisign 0.12: an extra binary and no attestation format. Sigstore keyless: needs Fulcio and Rekor online. |
| D5-2 | **The registry is a directory of files, verified at load, with a persisted high-water mark.** A signed registry index lists each release's files and digests; the reader verifies the trust root, the signature, expiry, a minimum sequence and every byte before anything is used, and then refuses any sequence below the highest it has accepted for that registry (architecture §5.3a). The mark lives in PostgreSQL, outside the registry directory. | ADR 0007 needs signing and pinning, not a server. Rollback and freeze protection follow TUF's version and expiry rules (research register): a reader that does not remember the highest version lets an old, still-valid index undo a revocation. | A registry service: no use case in a single-operator pilot. Full TUF roles: four roles for one signer. |
| D5-3 | **Skills reach the agent inside the pack.** `context-pack` 1.1.0 (MINOR) adds optional `bundleSha256`, `role` and `instructions` to `skills[]` items. The agent adapter is unchanged: it already mounts the pack. | No change to the Phase 2 agent runtime; the instructions are covered by the pack's hash. | A separate skill-bundle mount: changes the Phase 2 adapter and its sandbox proofs. |
| D5-4 | **Only `SKILL.md` bodies are delivered.** Scripts, references and assets are not vendored or delivered. | Executable content needs a permission review and a sandbox story; the procedures are in the bodies. | Vendoring whole skill directories. |
| D5-5 | **The harness composes the pack, and provenance is a separate artifact plus a DB row.** The provenance record names the pack's hash and every input; the row binds pack → provenance → index snapshot → task by FK. | A pack cannot carry its own provenance digest; a row lets a reader find the provenance of any attached pack, and the database refuses a mismatch. | Provenance inside the pack (a hash cycle); provenance only in an artifact (unfindable from the attempt). |
| D5-6 | **Index engines: TypeScript 7.0.2 for the AST and import resolution, `tsc --lsp --stdio` for references, Git objects for files and a token index for lexical search.** | All pinned and already on the machine; probes in §2. The lexical map is an inverted token index built from blob bytes, so composition is a pure function of stored inputs and replays without Git or LSP. | tree-sitter (new native or WASM dependency, grammar pinning; deferred, §4). `git grep` or ripgrep at compose time (composition would not be pure). dependency-cruiser (a new dependency for what TS resolution gives). |
| D5-7 | **Snapshots are materialized from Git objects as regular files only**, with pnpm-style relative workspace links so cross-package references resolve (§2). Symlinks and submodules are skipped and recorded. No repository code runs. | The probe shows the links are needed; skipping symlinks removes the path-escape class. | `git archive` (writes symlinks); a worktree with `pnpm install` (network, runs scripts). |
| D5-8 | **Ranking and routing are deterministic integer arithmetic over the index.** No embeddings, no model call. | Reproducible scorecards; no cost; the evaluation decides whether semantic retrieval is ever needed. | Embedding retrieval now. |
| D5-9 | **"Routing" in the exit criterion is skill routing.** Model routing (`docs/platform/model-routing.md`) needs live runs and is deferred to the pilot. | The phase is the skill and context platform; offline evaluation cannot score model choice without outcomes. | — (flagged for the controller in the status block) |
| D5-10 | **The evaluation corpus is this repository's own history, pre-registered and split.** Gold = files a historical commit modified that existed at its parent; objective = the sanitized subject; routing label = a fixed rule from the conventional type. A holdout split is reported apart. | No pilot task history exists yet; commits give real gold sets; pre-registration before any result prevents tuning to the test. | Phase 4's review corpus (its final freeze is not landed; a different question). Hand-written labels (no human labeller available; R54 item 5). |
| D5-11 | **No new third-party dependency.** `typescript` 7.0.2 becomes an exact dependency of the indexer package (already in the store); `yaml` 2.9.0 is already pinned. | Lane addendum 2026-10-30 (no downloads); supply-chain surface. | — |
| D5-12 | **D-1 applies (R7).** New logical contracts instead of MAJOR bumps; `context-pack` gets one MINOR. | Validator keyed by logical name. | MAJOR `context-pack/v2`. |

---

## 4. Scope

**In scope:** signed internal skill registry (verification library, trust root, operator CLI); five vendored skills
in quarantine with provenance and license; repository index (files, lexical, AST symbols, import graph, LSP
references, static test map) at a pinned SHA; harness-composed, canonical, immutable ContextPack 1.1.0 with a
provenance record and DB binding; deterministic skill router; offline evaluation corpus, scorer and gate; the
`ContextComposer` port and `context-root.ts` for integration; runbook.

**Deferred, with the reason and the precondition for pickup:**

| Deferred | Why | Pick up when |
|---|---|---|
| Model routing evaluation | needs live outcomes per model (D5-9) | pilot runs exist (Phase 2 K5) |
| Outcome-level skill evaluation (pass-rate and false-completion deltas), shadow and canary | needs live agent runs | pilot; the offline scorecard becomes the pre-filter |
| tree-sitter / non-TypeScript AST and references | new dependency; the pilot and this repo are TypeScript | a non-TypeScript brownfield repository whose readiness gap matters to the user, behind the indexer's capability flags. Phase 6 does not take it (its §23); it stays deferred past Day 90 |
| Embedding or semantic retrieval | model calls, non-determinism; no evidence of need | the scorecard shows a recall gap lexical signals cannot close |
| Git change-coupling signal for ranking | not in the 90-day scope | the scorecard shows a gap; it is then one measured change. Phase 6 computes change coupling from trusted `git log` for readiness only (its §23); a ranking signal would reuse that computation, not add a second one |
| Coverage-based (dynamic) test map | runs repository tests | a sandboxed index run can reuse Phase 6's onboarding sandbox; Phase 6 does not take it (its §23) |
| Containerized indexing | the indexer only parses (no repository code runs) | the indexer runs anything from the repository; Phase 6 does not take it and records the indexer as a host process with no network of its own (its §23) |
| Skill scripts, references, assets | executable content (D5-4) | a permission review procedure |
| Production run events for context and skills (`skill_routing_precision`) | needs a `run-event` bump; R5 freezes it during Phases 3–4 | a new reconciliation after Phase 4 merges |
| Provenance rows for Phase 4's repair packs | Phase 4's slot is locked | integration follow-up (CR-P5-11) |
| ProductSpec text in `specificationExcerpt` | no persisted spec content on the execution path | a spec-ingest path |
| Registry service, multi-signer threshold, Sigstore transparency | no use case for one operator | multi-org registry |
| Public catalog discovery and automated quarantine | ADR 0007: discovery only | after the manual import path is exercised |

---

## 5. Architecture summary

`phase-05-architecture.md`. New code:

```text
packages/application/src/context/     NEW  pure core (canonical pack, hash, ranking, router, budgets, provenance)
                                           + composeContextPack use case over ports
packages/policy/src/context-policy.ts NEW  loader for policies/context-policy.yaml (weights, caps, budgets)
adapters/repo-index/                  NEW  index builder: Git snapshot, token index, TS AST + imports, LSP refs, tests
adapters/skill-registry/              NEW  DSSE/Ed25519 verification, trust root, signed index, bundle digests
adapters/persistence/src/context/     NEW  index-snapshot, provenance and registry high-water stores, migrations 0300–0302
skills/vendor/, skills/registry/      NEW  vendored skills (quarantine), trust root, quarantine record
scripts/skills/                       NEW  import (pinned blob check) and operator registry CLI (keygen, sign, verify)
evals/context-corpus/, evals/context-eval/  NEW  corpus, pre-registration, runner, scorer, scorecard, gate
apps/control-plane-api/src/context-root.ts  NEW  composition of the ContextComposer (sibling of production-root, R10)
```

Dependency direction is unchanged (`phase-02-plan.md` §7): `adapters/repo-index` and `adapters/skill-registry` →
`@asep/ports`, `@asep/contracts` (+ `@asep/git-worktree` for `runGit`, + `typescript` for the indexer);
`packages/application` never imports an adapter; `context-root.ts` wires them.

---

## 6. Compose sequence

```text
ContextComposer.compose(scope, input)                        (application use case; idempotent by task)
  provenance row for (scope, taskId)?  → same request digest → return its refs (reused)
                                       → other request digest → ContextCompositionError conflicting-input
  read + validate the WorkOrder artifact (work-order/v1); its baseSha must equal input.baseSha
  registry ← SkillRegistryReader.load()      (verified, high-water mark checked and advanced; production mode only
                                              unless the eval runner allows)
  required skills: exact id + version, promoted, pass phase and permission filters, or unknown-skill (no write yet)
  index    ← RepositoryIndexStore.find(key)  or  RepositoryIndexer.build → ArtifactStore.put → record
  pack, provenance ← composePure(workOrder, index, registry, policy, toolPolicy, generatedAt)   (pure)
      language filter on required skills (needs the index), rank files and symbols, route skills, fit budgets,
      render the pack, hash it, build provenance
  ArtifactStore.put(context-policy bytes), put(skill-registry-snapshot), put(context-pack), put(context-provenance)
                                                               (content-addressed, create-only)
  ContextProvenanceStore.record(...)                          (create-once per task; last write)
      → this row created               → return { contextPackRef, provenanceRef, reused: false }
      → a concurrent call's row exists → same request digest → its refs, reused: true; else conflicting-input
```

Every refusal happens before the first artifact write, with one exception: a refusal that needs the index (a
required skill excluded by language, an over-budget pack) leaves the index snapshot it built, a cache entry keyed by
commit and indexer digest that no pack references (architecture §6.3, C6). A crash between an artifact write and
the row leaves orphan artifacts that a retry either reuses (same bytes) or leaves orphaned (registry or index
changed in between); the row is the only authority. The policy and registry-snapshot artifacts make a composition
replayable after the policy file or the registry changes (C3).

---

## 7. Skill registry and vendoring

Lifecycle (`docs/platform/skill-system.md:9-21`) mapped to Phase 5:

| Stage | Phase 5 mechanism | Who |
|---|---|---|
| external source → quarantine | one authorized fetch (R68; §18) of the seven pinned URLs of research register §2, run by the lane in S4 at implementation time and not before. Each fetched file must hash to its pinned git blob SHA and size; the lane records its URL, sha256, SPDX license and fetch date in research register §2, `quarantine.json` and the skill's `skill.json` provenance. A license that does not permit redistribution stops the fetch for that item: it is not committed, and the plan records it. `scripts/skills/import-skill.mjs` then fetches nothing itself: it takes the fetched files, checks each again against its pin, and writes `skills/vendor/<source>/<skill>/` plus a quarantine record entry | lane (after G-NET) |
| license and provenance scan | upstream repo, commit, tag, path, blob SHA, SPDX id; upstream LICENSE text kept; NOTICE entry | lane |
| prompt-injection and tool-permission review | static validation (frontmatter per the Agent Skills spec, size caps, outbound references listed, no executable file); manifest permissions limited to `network: none`, `productionAccess: forbidden` | lane (static); human (review) |
| static validation | `vendored-skills` suite | lane |
| sandbox behavioral eval | the offline routing evaluation in evaluation mode (§9); outcome evaluation deferred (§4) | lane |
| human approval → signing and pinning → internal registry | operator signs a registry index with the registry key (`scripts/skills/registry.mjs sign`). The operator is the user; the key ceremony and every signing follow the runbook (S10) | **operator (the user) only** |
| canary → promoted / deprecated / revoked | `status` in the signed index; revocation = a new index with a higher sequence, plus raising the deployment's `minimumSequence` to it; every reader refuses a sequence below its persisted high-water mark, so restoring the old index file does not undo the revocation (architecture §5.3a, R5) | operator |

Selected skills (research register §2 has commits, blob SHAs, sizes and licenses):

| Registry id | Upstream | Role | Routing label (§9.1) |
|---|---|---|---|
| `vendor.superpowers.systematic-debugging` | obra/superpowers v7.0.1 `skills/systematic-debugging/SKILL.md` | primary | `fix` |
| `vendor.superpowers.test-driven-development` | obra/superpowers v7.0.1 `skills/test-driven-development/SKILL.md` | primary | `test` |
| `vendor.superpowers.verification-before-completion` | obra/superpowers v7.0.1 `skills/verification-before-completion/SKILL.md` | adjunct, the verification bundle | — |
| `vendor.addy.incremental-implementation` | addyosmani/agent-skills `8bfcc1f` `skills/incremental-implementation/SKILL.md` | primary | `feat` |
| `vendor.addy.code-simplification` | addyosmani/agent-skills `8bfcc1f` `skills/code-simplification/SKILL.md` | primary | `refactor` |

Excluded on purpose: Superpowers' subagent and worktree skills (they assume tools the harness does not grant,
`docs/platform/framework-support-matrix.md:15`), and the supporting files of `systematic-debugging`
(`find-polluter.sh` is executable; the pressure-test files are its authoring tests). The existing internal example
`skills/examples/systematic-debugging` stays an example and is not registered.

---

## 8. Repository index

Maps built at one commit of one binding (architecture §4):

| Map | Source | Stored as |
|---|---|---|
| files | `git ls-tree -r <sha>` + `git cat-file --batch`, regular blobs only | path, blob SHA, size, language, role (source/test/other), skip reason |
| lexical | tokens of each text blob (identifier split, lower case, length ≥ 3, policy stopwords) | token → [(file, count)] |
| AST symbols | TS 7 `unstable/sync` API, top-level and exported declarations | name, kind, file, line, exported |
| dependency | TS module resolution of each import, in-repo targets only | (from file, to file) edges |
| references | `tsc --lsp --stdio` `textDocument/references` for each exported top-level declaration of a source file | symbol → [(file, count)] |
| tests | files matching the policy's test patterns → their transitive in-repo imports | test file → [source files] |

Caps (files, bytes per file, reference queries, LSP request timeout, total build time) come from the policy and
are recorded; a cap reached makes that map `partial`, never silently complete.

---

## 9. Evaluation design (the exit criterion)

### 9.1 Corpus (pre-registered before any composer exists)

`evals/context-corpus/preregistration.json` fixes, and its sha256 is pinned in the manifest:

1. Source: commits reachable from `sourceHead = f613c7fd86e49317bb439b57575518e2ff48c641`, non-merge, one parent.
2. Subject matches `^(fix|feat|refactor|test)(\([^)]*\))?!?: `.
3. Gold: paths with status `M` or `D` in `git diff --name-status --no-renames <parent> <commit>`, matching
   `\.(ts|mts|cts|mjs|js)$`, not under `docs/`, not `packages/contracts/src/generated.ts`, not under `snapshots/`.
   Added files are excluded (they cannot be retrieved at the parent).
4. Keep commits with 1 to 5 gold files; per type, the 10 most recent in `git rev-list --topo-order` order.
5. Objective: the subject with its `type(scope)!: ` prefix removed and every parenthesized group holding a review
   code (`[A-Z][A-Z0-9]*-[A-Z0-9-]*\d{3}` or `R\d+`) removed; whitespace collapsed. Bodies and trailers are never used.
6. Split: `holdout` when the commit SHA's first hex digit is `8`–`f`, else `dev`.
7. Leak flag: the objective contains, case-insensitively, the extension-less basename or the parent directory name
   of any gold file. Metrics are reported for all items and for non-leaking items.
8. Routing label from the type: `fix` → `vendor.superpowers.systematic-debugging`, `feat` →
   `vendor.addy.incremental-implementation`, `refactor` → `vendor.addy.code-simplification`, `test` →
   `vendor.superpowers.test-driven-development`.

The builder writes `manifest.json` (items with SHA, parent, type, split, leak flag, gold, label; the preregistration
digest; `corpusSha256` over the canonical body). A second build writes the same bytes. Expected size from the §2
probe: 33 items. The builder's count is authoritative.

### 9.2 Metrics (integers only; no floating point in the scorecard)

Per item and variant: the rank of each gold file in `relevantFiles` (or null), the selected primary skill, pack
bytes. Per variant and split: `hit@1`, `hit@5` (items with a gold file in the top 1 or 5), micro `recall@5`,
`recall@10`, `recall@K` (gold files found / gold files), routing `correct / items`, per-label confusion counts,
mean pack bytes as `sum / items`.

### 9.3 Variants (same composer, policy overrides)

`default`; `lexical-only`; `no-references`; `no-test-map`; `path-order` (policy `ranking.mode: path-order`: the
first `K` source and test files in path order, ignoring every signal; the trivial baseline). Ablations make each
map's contribution visible. Every variant composes with `generatedAt` = the item commit's committer date, so the
pack bytes depend on Git alone.

### 9.4 The gate

`evals/context-eval/eval-gate.test.ts` (`asep-suite:context-eval-gate`), in `pnpm test`:

1. Recompute the scorecard from the corpus with the production indexer, the production composer and the vendored
   skills in evaluation mode. It must equal the committed `scorecard.json` byte for byte. Any change to the
   composer, router, index or policy that changes an output therefore fails until its new scorecard is committed,
   and the diff of `scorecard.json` and the generated `report.md` is the evaluation.
2. The committed scorecard meets `floors.json` against the previous committed baseline (`baseline.json`): micro
   `recall@10` may not drop by more than 3 gold files, `hit@5` and routing `correct` by more than 1 item, on the full
   corpus or on the holdout. A drop beyond a floor needs an entry in `accepted-regressions.json` naming the
   scorecard digest, an approver and a rationale. A lane may write the entry; the controller's review decides.
3. Sanity: `default` micro `recall@10` exceeds `path-order`'s.
4. Seeded mutation: the suite runs the gate function on the committed corpus with one weight in a copy of the
   policy changed and requires the gate to report a mismatch.

Runtime budget: 180 s on this host for the full corpus, measured in S8. Over budget → CR-P5-13 (a parallel CI job)
instead of cutting the corpus silently.

### 9.5 Change procedure (runbook)

A change to `policies/context-policy.yaml`, `packages/application/src/context/**` or `adapters/repo-index/**`
regenerates `scorecard.json` and `report.md` with `pnpm --filter @asep/evals eval:context --write`, moves the old
scorecard to `baseline.json`, and commits all three with the change. The report shows the per-item rank diffs.

---

## 10. Testing pyramid and gates

| Layer | What | Runs in |
|---|---|---|
| Contracts | fixtures accept/reject, compat MINOR for `context-pack`, drift guard | `pnpm test` |
| Pure core | pack canonical bytes and hash, ranking tables, router tables, budget fitting, provenance shape, replay | `pnpm test` |
| Registry | DSSE PAE vectors, refusal matrix, TOCTOU, CLI round trip with in-test keys | `pnpm test` |
| Indexer | real Git fixture repos, real TS parser, real LSP server; determinism; golden fixture index; hostile inputs; no-execution canary | `pnpm test` |
| Persistence | migrations 0300–0302, create-once and converging inserts, FKs, tenancy, append-only, the monotonic high-water mark | `pnpm test` (PGlite) + `pnpm test:integration` (real PG) |
| End to end | compose on real PG + MinIO + a real Git mirror; attach to an attempt; replay | `pnpm test:integration` |
| Evaluation | the gate of §9.4 | `pnpm test` |

Tests that spawn `tsc` or `git` use the process registry's `spawnRecorded` and time waits on the monotonic clock
(the Phase 2 fitness rules, `scripts/lib/process-registry.mjs`).

---

## 11. Slices (one commit each)

| Slice | Deliverable | Commit | Gate | Acceptance checks (exit criteria) |
|---|---|---|---|---|
| S1 | Contracts and ports: `context-pack` 1.1.0; new `repository-index/v1`, `context-provenance/v1`, `skill-registry-index/v1`, `skill-trust-root/v1` with fixtures, snapshots, generated types, validator names, `COMPATIBILITY.md`; `ContextPackSkill` in `base.ts` and the context-pack items' `x-tsType` pointed at it (data model §1.1); the ports of CR-P5-02 | `feat(contracts): add repository index, context provenance and skill registry contracts` | G-P3S1 (Phase 3 through S1 merged into this branch by the controller) | A3, C1 (schema part) |
| S2 | `policies/context-policy.yaml` + loader; `packages/application/src/context/**`: canonical pack and `contextPackHash`, ranking, router, budgets, provenance, `composeContextPack` over the S1 ports with in-memory fakes; replay function | `feat(context): compose canonical context packs with provenance` | S1 | C1, C2, C3, C5, C6, C7, C8 |
| S3 | `adapters/skill-registry/**`: PAE, Ed25519 verify, trust root, signed index (sequence, expiry, minimum sequence), the high-water check over the `SkillRegistryHighWaterStore` port with an in-memory store (architecture §5.3a), bundle digests read once, status filter, evaluation reader for quarantine; `scripts/skills/registry.mjs` (keygen, sign, verify) | `feat(skills): verify a signed skill registry offline` | S1 | R1, R2, R3, R4, R5 (in-memory part) |
| S4 | Five vendored skills under `skills/vendor/**`, their `skill.json` manifests, upstream LICENSE files, `NOTICE.md`, `skills/registry/quarantine.json`, `skills/registry/trust-root.json` (no keys yet), `scripts/skills/import-skill.mjs` and the vendored-skills suite; the one authorized fetch of the seven pinned URLs, with URL, sha256, SPDX id and date recorded (§7, §18) | `feat(skills): vendor selected engineering skills into quarantine` | S1 (G-NET authorized by R68) | V1, V2, V3, V4 |
| S5 | `adapters/repo-index/**`: snapshot from Git objects with workspace links, token index, TS AST + imports on the file-system jail (its canary first), LSP client and references gated on the jail, test map, canonical bytes, capabilities, caps; golden fixture; hostile-input and no-execution tests | `feat(index): index a repository commit with lexical, AST, LSP, dependency and test maps` | S1 | I1–I7 |
| S6 | Migrations `0300_repository_index_snapshots`, `0301_context_provenance`, `0302_skill_registry_high_water`; `adapters/persistence/src/context/**` stores (index snapshots, provenance with converging `record`, registry high-water mark); PGlite suite and real-PG itest | `feat(persistence): record index snapshots, context provenance and the registry high-water mark` | S1 | A4, C4, R5 (PostgreSQL part) |
| S7 | `evals/context-corpus/**`: `preregistration.json`, builder, `manifest.json`, verifier suite, README | `feat(evals): pre-register a context corpus from repository history` | plan lock only (before any composer result exists) | E1 |
| S8 | `evals/context-eval/**`: runner over the production composer and indexer, scorer, variants, `scorecard.json`, `baseline.json` (= the first scorecard), `floors.json`, `accepted-regressions.json` (empty), `report.md`, gate suite with the seeded mutation | `feat(evals): gate context and skill-routing changes on a recomputed scorecard` | S2, S3, S4, S5, S7 | E2–E6 |
| S9 | `apps/control-plane-api/src/context-root.ts` (+ test); `apps/control-plane-api/src/context/compose-e2e.itest.ts`; fitness rules of CR-P5-09; S4 ↔ S3 bundle-digest parity | `feat(control-plane): compose context packs on real backends behind the composer port` | S2, S3, S4, S5, S6 | C9, R3 (fitness part), A1, A5 |
| S10 | ADR `0019` ("Signed skill registry and context provenance"), `phase-05-runbook.md` (key ceremony by the operator, trust-root changes, signing, promotion, revocation with the floor raise, rotation, evaluation change procedure), updates to `docs/platform/skill-system.md`, `context-and-memory.md`, `framework-support-matrix.md`, `phase-05-report.md`; `evals/context-eval/docs-consistency.test.ts` | `docs(context-platform): record the skill and context platform evidence, runbook and their checks` | all | D1, D2, D3 |

Each slice: re-read its exit criteria → tests first where sensible → smallest change → focused tests + typecheck →
commit → slice-end gate. A slice that adds a suite appends its id to `REQUIRED_SUITES` or `REQUIRED_ITEST_SUITES`
in the same commit (R10).

---

## 12. DAG

```text
plan lock ────────────> S7 ──────────────┐
G-P3S1 ──> S1 ─┬─> S2 ───────────────────┼──> S8 ──┐
               ├─> S3 ───────────────────┤         │
               ├─> S4 ───────────────────┤         ├──> S10
               ├─> S5 ───────────────────┘         │
               └─> S6 ──────────────────────> S9 ──┘
                   S9 also needs S2, S3, S4 and S5
```

Edges: S8 ← S2, S3, S4, S5, S7. S9 ← S2, S3, S4, S5, S6. S10 ← all. Acyclic. S2, S3, S4, S5, S6 and S7 are
mutually independent and own disjoint paths (§15).

---

## 13. Lanes

Three lanes. More would add controller overhead without shortening the critical path (S1 → S2 → S8 → S9 → S10).

| Lane | Branch | Slices, in order | Estimate |
|---|---|---|---|
| `phase-05` | `phase/05-skill-context-platform` | S1, S2, S8, S9, S10 | ~4 days |
| `phase-05-c2` | `lane/context-index` (from the phase branch after S1; S7 itself needs only the plan lock) | S7 (first: frozen before any result), S5 | ~2 days |
| `phase-05-c3` | `lane/skill-registry` (from the phase branch after S1) | S3, S4, S6 | ~2 days |

S8 waits for the merges of S3, S4, S5 and S7; S9 for S3, S4, S5 and S6. The controller merges sub-lane work back
with merge commits (R58). If the controller prefers two lanes, `phase-05-c3`'s slices move to `phase-05-c2` after
S5 and the estimate grows by about two days. S3's high-water check uses the port with an in-memory store; its
PostgreSQL store and the persistence half of R5 land in S6 on the same lane.

---

## 14. Shared-surface change requests

Nothing below is edited before "implement". Every change is additive.

| ID | Surface | Change | Compat | Slice |
|---|---|---|---|---|
| CR-P5-01 | `packages/contracts/**` | `context-pack` 1.0.0 → 1.1.0 (optional `skills[].bundleSha256`, `skills[].role`, `skills[].instructions`; the `hash` recipe stated in its description; the items' `x-tsType` → `ContextPackSkill`, added to `src/base.ts`, with `SkillRef` kept for `WorkOrder.requiredSkills`); new `repository-index.schema.json`, `context-provenance.schema.json`, `skill-registry-index.schema.json`, `skill-trust-root.schema.json` (each 1.0.0, `$id …/<name>/v1`); fixtures valid + invalid; `snapshots/v1/` entries; `src/generated.ts`; `src/validate.ts` `ContractName` += 4 names; `COMPATIBILITY.md` count for these four only (R7) | MINOR + 4 new logical contracts | S1 |
| CR-P5-02 | `packages/ports/src/index.ts` | appended section, full text in architecture §8 | additive | S1 |
| CR-P5-03 | `packages/application/src/index.ts` | one line `export * from './context/index.js'` | append-only (R10) | S2 |
| CR-P5-04 | `packages/policy/src/index.ts` | one export line for `context-policy.ts` | append-only | S2 |
| CR-P5-05 | `adapters/persistence/src/migrations.ts`, `src/index.ts` | one import of `./context/migrations.js` and three entries `0300_repository_index_snapshots`, `0301_context_provenance`, `0302_skill_registry_high_water`; one export line | append-only; range 0300–0399 | S6 |
| CR-P5-06 | `scripts/lib/canonical-tests.mjs` `REQUIRED_SUITES` | += the unit ids in exit criteria §"Suite registry" | append-only | each slice |
| CR-P5-07 | `scripts/integration/lib.mjs` `REQUIRED_ITEST_SUITES` | += `asep-suite:pg-context-stores`, `asep-suite:context-e2e` | append-only | S6, S9 |
| CR-P5-08 | root `tsconfig.json`; `pnpm-lock.yaml` | references += `adapters/repo-index`, `adapters/skill-registry`; lockfile importers for the two packages, `typescript` 7.0.2 exact in `adapters/repo-index` (no download: in the store) | additive | S3, S5 |
| CR-P5-09 | `scripts/forbidden-imports.test.ts` / `scripts/lib/ts-guard.mjs` (R8 framework) | rules, each with a seeded self-check: `typescript` and LSP spawn only in `adapters/repo-index`; no `fetch`/`node:http(s)`/`node:net` in `adapters/repo-index`, `adapters/skill-registry`; the evaluation registry factory not imported by `apps/**` or `workers/**` | append-only | S9 |
| CR-P5-10 | `evals/package.json`, `evals/tsconfig.json` | deps `@asep/application`, `@asep/repo-index`, `@asep/skill-registry`, `@asep/policy`; script `eval:context`; include `context-corpus/**`, `context-eval/**`; union with Phase 4's SR-X8 | append-only | S7, S8 |
| CR-P5-11 | Phase 4 (Lane B), `buildRepairContextPack` | compute `hash` with `contextPackHash` from `@asep/application`; carry the 1.1.0 skill fields over unchanged; a parity test that a repair pack's `hash` equals `contextPackHash` of its body. Optional later: a provenance row with `derivation: repair` | no schema change | Lane B S13 or integration |
| CR-P5-12 | Phase 3 (Lane A), the submit use case and `storeAttemptInputs` | an optional `contextComposer?: ContextComposer` dependency. When bound: the use case calls `compose` with the task's binding, base SHA, stored work-order ref, tool policy and its logical time, puts the returned `contextPackRef` into `task-workflow-input`, and refuses a body-supplied `contextPack` with 400. `storeAttemptInputs` attaches that ref as is and never re-serializes the pack. When unbound: behaviour byte-identical to today. A `ContextCompositionError` with `retryable: false` maps to a non-retryable activity failure. When Phase 6's `TaskSubmissionPolicy` is also bound, its `decide` runs first: a refused task composes no pack and writes no provenance row (Phase 6 CR-P5X1) | additive; no schema change (`contextPackRef` already exists) | Lane A S9 or integration |
| CR-P5-13 | `.github/workflows/ci.yml`, `scripts/verify-all.sh` | **only if** S8 measures the gate above 180 s: a parallel `context-eval` job running the gate suite, and the suite moved out of `REQUIRED_SUITES` into that job's required list | conditional | S8 |

No change to `apps/control-plane-api/src/production-root.ts` (R10: sibling `context-root.ts`), to
`docs/platform/metrics-dictionary.yaml` (no new run-event metric, §4), to `run-event` (R5), or to the agent adapter.

---

## 15. Directory ownership

Exclusive to Phase 5. No path overlaps Phase 3 §31 or Phase 4 §20.

```text
packages/application/src/context/**                      phase-05     S2
packages/policy/src/context-policy.ts, context-policy.test.ts           phase-05  S2
policies/context-policy.yaml                              phase-05     S2
adapters/repo-index/**                                    phase-05-c2  S5
evals/context-corpus/**                                   phase-05-c2  S7
adapters/skill-registry/**                                phase-05-c3  S3
scripts/skills/**                                         phase-05-c3  S3, S4
skills/vendor/**, skills/registry/**                      phase-05-c3  S4
adapters/persistence/src/context/**                       phase-05-c3  S6
packages/contracts/schema/{repository-index,context-provenance,skill-registry-index,skill-trust-root}.schema.json
  + their fixtures and snapshots                          phase-05     S1
packages/contracts/src/context-contracts.test.ts          phase-05     S1
evals/context-eval/**                                     phase-05     S8, S10
apps/control-plane-api/src/context-root.ts, context-root.test.ts        phase-05  S9
apps/control-plane-api/src/context/**                     phase-05     S9
docs/implementation/phases/phase-05-*                     phase-05
docs/architecture/adr/0019-*                              phase-05     S10   (number assigned by R68)
```

Existing files touched are listed in §14, plus in S10 the three platform docs named there.

---

## 16. Migrations (range 0300–0399)

`0300_repository_index_snapshots`, `0301_context_provenance` and `0302_skill_registry_high_water`, full DDL in
`phase-05-data-model.md` §3. The first two are append-only tables with scoped composite FKs and rows in
`artifact_reference_columns`; the third holds one deployment-wide row per registry whose `sequence` a trigger only
lets rise (architecture §5.3a). No Phase 2, 3 or 4 table or constraint is altered. `0303`–`0399` stay free.

---

## 17. New logical contracts (D-1)

| Contract | Version | Purpose |
|---|---|---|
| `repository-index/v1` | 1.0.0 | the stored index snapshot (internal to the context engine, validated on read) |
| `context-provenance/v1` | 1.0.0 | what a composed pack was made from and why each file and skill is in it |
| `skill-registry-index/v1` | 1.0.0 | the predicate of the signed registry statement: releases, status, digests, sequence, expiry |
| `skill-trust-root/v1` | 1.0.0 | the public keys a reader trusts, with validity windows and roles |
| `context-pack/v1` | 1.0.0 → 1.1.0 | MINOR: optional skill delivery fields |

Field lists: `phase-05-data-model.md` §1.

---

## 18. Controller requests and decisions (R68)

| ID | Request | Decision (R68, 2026-11-01) |
|---|---|---|
| G-P3S1 | Merge `phase/03-durable-orchestration` through S1 (`5cc8eaf`, or its later accepted head) into `phase/05-skill-context-platform` before S1 starts, as R58 item 4 requires ("S1 ports on their base"). | Accepted. The controller merges Phase 3 through S1 once Phase 3's S1 compat-gate fix lands; S1 here waits for it. |
| G-NET | One network fetch for S4: the five `SKILL.md` files and two `LICENSE` files at the commits and blob SHAs of research register §2. | Authorized: one fetch of the seven pinned URLs, at implementation time in S4, not now. Each URL, its sha256, its SPDX license and the fetch date go into research register §2 and the vendored manifests (`quarantine.json`, `skill.json`). A license that does not permit redistribution stops the fetch for that item. Any byte whose git blob SHA or size differs from the pin is refused and not committed. |
| ADR | An ADR number. | `0019` for Phase 5 ("Signed skill registry and context provenance"); `0020` is Phase 6's, `0018` is reserved for Phase 4, `0017` is Phase 3's. |
| KEY | For `COMPLETE` only: a key ceremony and one signed registry index promoting at least one vendored skill. | The operator is the user. S10's runbook plans the ceremony as an operator step; the lane never holds or uses the registry key (R54 item 5). Dev and test keys exist only in test fixtures, generated at run time; none is committed and the committed trust root lists none. `COMPLETE` stays gated on the real ceremony. |
| ROUTING | "Routing" in the exit criterion means skill routing (D5-9). | Accepted; model routing is deferred (§4). |
| EVAL-BUDGET | The gate's 180 s budget is unmeasured. | Accepted: S8 measures it; CR-P5-13 applies only if it is exceeded. |
| PH6 | Phase 6 reads this plan for the brownfield boundary. | Read back at `bd9c9be` (Phase 6 DRAFT); the result is §18.1. The controller re-checks §18.1 when either plan locks. |

### 18.1 Phase 6 boundary (read from `phase-06-plan.md` §19.7 and §23 at `bd9c9be`)

- **Ownership.** Disjoint: Phase 6 builds no index and changes no context code; no path of its §22 overlaps §15
  here. Migrations: 0300–0302 here, 0400–0499 there; no shared table. ADRs: `0019` here, `0020` there.
- **Phase 6 reads the index.** Its "test strength" readiness check reads the static test map through
  `RepositoryIndexStore.find` and the `repository-index/v1` artifact (its G-P5IDX = S1, S5 and S6 here). The port of
  architecture §8 and the `files[]`, `tests[]` and `capabilities.tests` fields of data model §1.2 are therefore a
  cross-phase contract from S1 on; a change after S1 is a change request to Phase 6. A non-TypeScript module has no
  map and Phase 6 scores it `not-evidenced`.
- **Submit seam order.** Phase 6's `TaskSubmissionPolicy.decide` runs before `compose` (CR-P5-12 above). A binding
  Phase 6 keeps `onboarding-incomplete` (for example after its secret scan finds a committed credential) refuses
  submission, so no index or pack is built for it. This is the mitigation Phase 6 adds to T5-09.
- **Shared append-only files.** Union at merge, no reordering (Phase 6 CR-P5X2): ports, `ContractName`,
  `COMPATIBILITY.md`, suite registries, `migrations.ts`, root `tsconfig.json`, lockfile importers, package export
  lines, forbidden-imports rules.
- **Row security.** Phase 6's last migration (`0490`) forces row security on every table with `organization_id`,
  which includes `repository_index_snapshots` and `context_provenance`. Phase 5's stores already filter by tenant
  scope (data model §3), so they need no change; Phase 6's catalog itest covers both tables. The third table,
  `skill_registry_high_water`, has no `organization_id`: it is deployment state (one registry for every project),
  and Phase 6's table access-class registry must classify it as such, with the runtime role allowed to insert and
  raise it and no role allowed to delete it.
- **Release pins and retention.** Phase 6's harness release manifest carries the context-policy hash and the skill
  registry pin (registry, sequence, source and trust-root hashes) as optional fields; provenance records the same
  facts (data model §1.3). Phase 6 assigns retention classes to the artifact kinds `repository-index`,
  `context-pack` and `context-provenance`, and now also `context-policy` and `skill-registry-snapshot`: purging
  either of the last two breaks replay (C3) of every pack that names it, so they need the retention of the packs
  they explain. Phase 6 sees these two kinds for the first time in this version.
- **Deferrals.** Phase 6 declines non-TypeScript indexing, the coverage test map and containerized indexing; §4
  records them as deferred past Day 90 with Phase 6's pickup conditions.

---

## 19. Exit criteria and verdicts

`phase-05-exit-criteria.md`: numbered MUSTs, each mapped to a test file and SUITE-ID.

| Verdict | Condition |
|---|---|
| `COMPLETE` | every MUST, CR-P5-12 landed and its joint itest green, and an operator-signed index promoting ≥ 1 vendored skill verified by `context-root` |
| `IMPLEMENTATION_COMPLETE_PROMOTION_PENDING` | every MUST; no operator-signed index yet (production packs carry no skills) |
| `…_WIRING_PENDING` (suffix) | CR-P5-12 not landed: the durable path still stores client packs |

Each carries `_UNREVIEWED` until the controller's final review accepts it.

---

## 20. Rollback

Per-slice commits. The composer is inert until `context-root.ts` is bound into Phase 3's submit path; unbinding it
restores today's behaviour (CR-P5-12). Migrations are forward-only; rollback is a forward migration that drops the
two composition tables (nothing else references them) and keeps `skill_registry_high_water`. `context-pack` 1.1.0 is additive: 1.0.0 packs stay valid. A bad
registry index is replaced by a higher-sequence index; a compromised key is removed from the trust root by a
reviewed commit. The high-water mark is never rolled back: lowering it re-opens a revoked skill, so a mistaken
sequence is corrected by signing the next sequence, not by editing the row (the trigger refuses it).

---

## 21. Assumptions and open questions

1. The controller merges Phase 3's S1 before S1 (G-P3S1, accepted in R68, after Phase 3's S1 compat-gate fix). If
   Phase 4's S1 (`ContractName` additions) also lands first, the union is mechanical.
2. "Routing" means skill routing (D5-9, accepted in R68).
3. Vendoring uses the one fetch R68 authorized. If a fetched file's license does not permit redistribution, that
   item is not vendored; with no vendored item at all, the routing evaluation has no candidates and E3–E6 hold for
   context only, and the verdict names it.
4. The corpus is self-history written largely by agents; results describe this repository, not other code (risk
   PR5-03).
5. No blocker for locking the plan.

---

## Output

```text
PLAN_STATUS: DRAFT v2 (first review folded; for the controller's second and last review round)
BASE_SHA: f613c7fd86e49317bb439b57575518e2ff48c641
SLICES: S1–S10 (§11); lanes: phase-05 (S1, S2, S8, S9, S10), phase-05-c2 (S7, S5), phase-05-c3 (S3, S4, S6)
MIGRATIONS: 0300_repository_index_snapshots, 0301_context_provenance, 0302_skill_registry_high_water
NEW_CONTRACTS: repository-index/v1, context-provenance/v1, skill-registry-index/v1, skill-trust-root/v1;
  context-pack 1.1.0 (MINOR)
NEW_ARTIFACT_KINDS: repository-index, context-pack (existing), context-provenance, context-policy,
  skill-registry-snapshot
NEW_DEPENDENCIES: none third-party (typescript 7.0.2 exact in adapters/repo-index, already in the store)
DECISIONS (R68): G-P3S1 accepted; G-NET one pinned fetch in S4; ADR 0019; KEY = operator (user) ceremony;
  routing = skill routing; eval budget measured in S8. PH6 boundary read at bd9c9be (§18.1)
DEFERRED_WITH_REASON: §4
```
