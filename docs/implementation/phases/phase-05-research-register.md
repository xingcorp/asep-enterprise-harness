# Phase 5 — Research Register (DRAFT v1)

> Sources read for the Phase 5 plan, with the versions and dates observed. Web pages were read on **2026-10-31**
> with the session's fetch tool; no package was downloaded. Local observations were made on this host
> (macOS, arm64) at `f613c7f`. "Not verified" marks what this session did not check.

## 1. Local toolchain (observed)

| Tool | Version | How observed | Use |
|---|---|---|---|
| Node | v24.6.0 | `node --version` (Phase 2 report) | runtime; `node:crypto` Ed25519 |
| TypeScript (native, `typescript-go`) | 7.0.2 | `node_modules/typescript/bin/tsc --version`; LSP `serverInfo` `{"name":"typescript-go","version":"7.0.2"}` | AST and module resolution (`typescript/unstable/sync`), references (`tsc --lsp --stdio`) |
| git | 2.55.0 | `git --version` | snapshot from objects (`ls-tree`, `cat-file --batch`); corpus builder |
| ripgrep | 14.1.1 | `rg --version` | not used (D5-6); not assumed on CI |
| pnpm | 10.31.0 | `package.json` `packageManager` | — |

TypeScript 7.0.2's package exposes `./unstable/sync`, `./unstable/async` and `./unstable/ast`
(`node_modules/typescript/package.json` `exports`); the native binary's `--lsp` mode accepts `-stdio`, `-pipe` and
`-socket`. The LSP probes are summarized in plan §2. Not verified: the same probes on Linux x64 (the CI runner).

## 2. Vendoring sources

Read through the GitHub REST API (`/repos/<o>/<r>/commits/<ref>`, `/contents/<path>?ref=<sha>`, `/tags`) and raw
files. Blob SHAs are Git SHA-1 blob ids as the API reports them; V1 checks the committed bytes against them with
`git hash-object`.

### 2.1 obra/superpowers

| Field | Value |
|---|---|
| Commit | `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`, tag `v7.0.1`, committed 2026-10-21T21:00:49Z ("Release v7.0.1: brainstorming retune, …") |
| License | MIT, "Copyright (c) 2025 Jesse Vincent" (raw `LICENSE`); `LICENSE` blob `abf0390320aa14406af7a520b9b0739fdda9bf08`, 1070 bytes |
| Skills in the tree | 15: brainstorming, diagnosing-superpowers, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers, verification-before-completion, writing-plans, writing-skills |

| Vendored file | Blob SHA | Bytes | Raw URL |
|---|---|---|---|
| `skills/systematic-debugging/SKILL.md` | `62fc752aaef59a8bbed5d305f4cadc60f8ae07ed` | 9530 | `https://raw.githubusercontent.com/obra/superpowers/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/systematic-debugging/SKILL.md` |
| `skills/test-driven-development/SKILL.md` | `46838cc9e893c06259e3bdad0fc2425b36242f15` | 9578 | `…/skills/test-driven-development/SKILL.md` (same prefix) |
| `skills/verification-before-completion/SKILL.md` | `7d45333cc4a49c57a80df6c1fe2fa777a207afbc` | 3646 | `…/skills/verification-before-completion/SKILL.md` |
| `LICENSE` | `abf0390320aa14406af7a520b9b0739fdda9bf08` | 1070 | `…/LICENSE` |

Not vendored from `systematic-debugging/`: `find-polluter.sh` (executable), `condition-based-waiting-example.ts`,
`CREATION-LOG.md`, `test-academic.md`, `test-pressure-{1,2,3}.md`, `condition-based-waiting.md`,
`defense-in-depth.md`, `root-cause-tracing.md` (D5-4). Not vendored from `test-driven-development/`:
`writing-good-tests.md`. `verification-before-completion`'s frontmatter, read verbatim, has `name` and
`description` only, and its body names no other skill or tool.

### 2.2 addyosmani/agent-skills

| Field | Value |
|---|---|
| Commit | `8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e`, committed 2026-10-31T06:40:28Z ("chore(release): bump plugin manifests to 0.6.15"); the repository has no tags |
| License | MIT, "Copyright (c) 2025 Addy Osmani" (raw `LICENSE`); `LICENSE` blob `d67778ada6b9cda6227e9130da182c13e73c8b2e`, 1068 bytes |
| Skills in the tree | 25 directories under `skills/` (api-and-interface-design … using-agent-skills) |

| Vendored file | Blob SHA | Bytes |
|---|---|---|
| `skills/incremental-implementation/SKILL.md` | `9c4f49bc841adb3c0f98baaa9eabd435a5b64ef9` | 9629 |
| `skills/code-simplification/SKILL.md` | `c4f794aa3fc63ea041989b30be7a3887c79c53ed` | 13719 |
| `LICENSE` | `d67778ada6b9cda6227e9130da182c13e73c8b2e` | 1068 |

Raw URLs: `https://raw.githubusercontent.com/addyosmani/agent-skills/8bfcc1f9916f2eea55494d8c1fa7f4bde867dd9e/<path>`.
`incremental-implementation` refers to `../../references/definition-of-done.md` and to the skills
`git-workflow-and-versioning` and `test-driven-development` of the same repository; none is vendored, so V3 lists
them as outbound references. `code-simplification` names `CLAUDE.md` and `git blame`; no other skill.

### 2.3 Agent Skills specification

`https://agentskills.io/specification`: a skill is a directory with `SKILL.md` (YAML frontmatter + Markdown);
`name` 1–64 chars, lower-case alphanumerics and hyphens, no leading, trailing or double hyphen, equal to the
directory name; `description` 1–1024 chars; optional `license`, `compatibility` (≤ 500 chars), `metadata`
(string map), `allowed-tools` (experimental); optional `scripts/`, `references/`, `assets/`; progressive
disclosure: metadata at start-up, the body on activation (< 5000 tokens recommended), resources on demand. The page
carries no version number or date. V3 applies these rules. The `skills-ref` validator the page names is not used
(a new dependency).

## 3. Signing and registry trust

| Source | Version / date | What it fixes for Phase 5 | Decision |
|---|---|---|---|
| DSSE envelope, `github.com/secure-systems-lab/dsse/blob/master/envelope.md` | 1.0.2, 2024-05-10 | fields `payload` (base64), `payloadType`, `signatures[] {keyid?, sig}`; unknown fields ignored by consumers | adopted (D5-1); the reader still refuses extra fields (architecture §5.3 step 2) |
| DSSE protocol, `…/protocol.md` | 1.0.2, 2024-05-10 | `PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body`, `LEN` ASCII decimal, no leading zeros; example `DSSEv1 29 http://example.com/HelloWorld 11 hello world` | adopted; the example is R1's test vector |
| in-toto Statement v1, `github.com/in-toto/attestation/blob/main/spec/v1/statement.md` | v1 | `_type` = `https://in-toto.io/Statement/v1`; `subject[]` with `digest` maps; `predicateType` URI; `predicate` optional | adopted, custom predicate type |
| in-toto envelope, `…/spec/v1/envelope.md` | v1 | DSSE `payloadType` must be `application/vnd.in-toto+json` or `application/vnd.in-toto.<predicate>+json` | `application/vnd.in-toto+json` |
| SLSA provenance, `https://slsa.dev/spec/v1.1/provenance` | page states v1.2 is current; predicate `https://slsa.dev/provenance/v1` with `buildDefinition`, `runDetails` | build provenance shape | not used: vendoring is a copy, not a build; revisit if skills are ever built |
| TUF, `https://theupdateframework.github.io/specification/latest/` | 1.0.37, last modified 2026-10-08 | rollback: refuse metadata with a version lower than trusted; freeze: refuse expired metadata | `sequence` + `minimumSequence`, `expiresAt` (architecture §5.3 steps 7–8); TUF's four roles not adopted (D5-2) |
| Sigstore cosign, `github.com/sigstore/cosign/releases/latest`, `docs.sigstore.dev/cosign/verifying/verify/` | v3.1.4, published 2026-10-20 | key-based `verify --key` exists; the docs show no offline flag; the log check is part of verification unless a bundle is used | rejected (D5-1). Not verified: the exact `--insecure-ignore-tlog` behaviour of 3.1.4 |
| minisign, `github.com/jedisct1/minisign/releases/latest` | 0.12 (page shows 15 January, year not shown) | a standalone signer | rejected: extra binary, no attestation format |
| Node `node:crypto` Ed25519 | Node 24 | `generateKeyPairSync('ed25519')`, `sign(null, data, key)`, `verify(null, data, key, sig)` | adopted; same primitive as `scripts/lib/acceptance-crypto.mjs` |

## 4. Repository indexing

| Option | Version (npm registry `…/latest`, 2026-10-31) | License | Decision |
|---|---|---|---|
| TypeScript 7 API + `tsc --lsp` | 7.0.2 (lockfile) | Apache-2.0 | adopted (D5-6) |
| `web-tree-sitter` | 0.27.1 | MIT | deferred: a new dependency plus grammar WASM files to pin; only TypeScript is needed now |
| `tree-sitter-typescript` | 0.23.2 | MIT | deferred: its `install` script is `node-gyp-build` (native build at install) |
| `dependency-cruiser` | 18.7.0 | MIT | rejected: TypeScript module resolution already gives the import graph |
| ripgrep | 14.1.1 (local) | MIT/Unlicense | not used: composition must be a pure function of stored inputs; a token index replaces it |

Snapshot design evidence (plan §2): references on a source snapshot need pnpm-style relative workspace links and the
real path of the root.

## 5. Offline evaluation of context and routing

| Source | Date | Relevance |
|---|---|---|
| Agentless, arXiv 2407.01489 (Xia, Deng, Dunn, Zhang) | v1 2024-07-01, v2 2024-10-29 | treats localization as its own stage before repair and validation, so it can be evaluated apart |
| LocAgent, arXiv 2503.09089 (Chen, Tang, …) | v1 2025-03-12, v2 2025-04-29 | reports file-level localization accuracy as a separate measure |

Choices drawn from them: score retrieval at file level against the files a real fix changed; report `hit@k` and
micro `recall@k`; keep the corpus frozen and pre-registered. Not verified: the papers' exact metric definitions (only
the abstracts were read). With 33 items no statistical significance is claimed; the scorecard holds counts, and a
change is judged by per-item rank movement and the floors.

## 6. Not verified in this session

- The LSP and TypeScript API probes on Linux x64.
- The evaluation gate's runtime (measured in S8).
- The bytes of the five `SKILL.md` files beyond their API metadata and the frontmatter of three of them; V1 checks
  them at import.
- cosign 3.1.4's offline verification flags.
