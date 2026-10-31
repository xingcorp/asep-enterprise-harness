# Phase 5 — Threat Model Delta (DRAFT v1)

> Delta over `docs/operations/security-threat-model.md` and `phase-02-threat-model-delta.md`. Base `f613c7f`.
> Phase 5 adds three inputs that cross a trust boundary: repository content parsed by the indexer, third-party
> skill text placed in the agent's context, and a signing key that decides which skill text is allowed.

## 1. New trust boundaries

```text
UNTRUSTED                                   TRUSTED (harness)                          OPERATOR (out of band)
repository blobs, tsconfig, package.json ─▶ indexer (parse only, regular files,        registry signing key
  identifiers                                 caps, minimal env, no network)              (never on the harness
vendored skill text ───────────────────────▶ registry reader (every byte checked        checkout; only public
                                              against a signed index)                     keys are committed)
WorkOrder (human-authorized) ──────────────▶ composer (pure, deterministic, records why)
                                              │
                                              ▼
                                            ContextPack artifact ──▶ agent sandbox (Phase 2, unchanged)
```

Skill text and repository-derived names are **data** in the pack. They grant no tool, path, network or credential:
authority still comes only from policy and the sandbox (T2-13).

## 2. Assets

The registry signing key; the trust root; the integrity of vendored skill bytes; the index and pack artifacts (their
bytes decide what the agent is told); the evaluation corpus and scorecard (they decide whether a change is
accepted); host files outside a repository snapshot.

## 3. Threats and mitigations (delta)

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T5-01 | Prompt injection in a vendored skill ("ignore the work order", "push to main", "print the key") | Quarantine until a human reviews and the operator signs; only `SKILL.md` bodies, no scripts (D5-4); the pack is read by a sandboxed agent with no forge credential, restricted egress and no `.git` write (Phase 2 T2-01, T2-02); skills cannot widen permissions (permission filter, architecture §6.2); revocation by a higher-sequence index | V3, R3, C8; Phase 2 sandbox suites unchanged |
| T5-02 | Tampered registry files on disk (a changed `SKILL.md`, an added file, a swapped manifest) | Every file of a promoted release checked against the signed index (sha256, size, file set, bundle digest) before use; one read per file, verified bytes used (no TOCTOU) | R2, R4, C9 (tamper after signing) |
| T5-03 | Forged index signed by an unknown or expired key; algorithm confusion | Ed25519 only; `keyid` must name a trust-root key with the `registry-index` role; `issuedAt` within the key's window; exact DSSE shape with one signature; PAE prevents type confusion | R1, R2 |
| T5-04 | Rollback or freeze: an old, validly signed index that still promotes a revoked skill | `sequence` ≥ the configured `minimumSequence`; `expiresAt` checked at load (TUF's rules, research register §3); provenance records the sequence used | R2; C2 |
| T5-05 | Signing-key compromise or misuse | Private key out of tree, read from a path given to the operator CLI only; the lane never holds it (R54 item 5); trust-root changes are reviewed commits; rotation and removal in the runbook; key validity windows | runbook (D2); R1 uses in-test keys only; no private key file in the tree (secret scan) |
| T5-06 | Path escape through repository content: symlinks to host files, `..` path names, `tsconfig.json` `extends` outside the root | Snapshot from Git objects as regular files only; symlinks and submodules skipped; invalid paths skipped; the only symlinks are the harness's relative workspace links inside the root; LSP and TS results outside the real root dropped. Residual: the TypeScript parser may read a file an `extends` names outside the snapshot; nothing it reads outside the root enters the index | I1, I6 |
| T5-07 | Code execution through repository content (package scripts, TS plugins, build tools) | No install, no build, no test run; TypeScript parses only; the LSP child runs with `PATH` and a temporary `HOME` only and no network need; containerized indexing stays deferred (plan §4; Phase 6 does not take it while the indexer runs nothing from the repository) | I7 (canary scripts and plugin never run) |
| T5-08 | Resource exhaustion by a hostile repository (huge files, many files, pathological types, a hung LSP request) | Caps on files, bytes per file, reference queries, request and build time; a cap reached marks the map `partial`; the child is killed on timeout or abort; `maxIndexBytes` fails the build instead of storing a partial index | I6 |
| T5-09 | Secrets or personal data from a repository copied into a pack or index | The index stores paths, blob ids, tokens (3–64 lower-case alphanumerics), symbol names and line numbers, never file content; the pack carries paths and `path#symbol` refs; full source capture stays off by default (ADR 0012). Residual: a token or identifier can itself be sensitive, and a credential committed to the repository is copied into the index as tokens; the index is tenant-scoped (T5-12). Phase 6's onboarding secret scan keeps such a binding `onboarding-incomplete` until a human acknowledges the finding, and its submission policy runs before composition (plan §18.1) | data-model §1.2 patterns; C1/C2 schemas |
| T5-10 | Provenance that does not describe the pack (forged or stale) | Provenance written by the composer only, bound to the pack by FK and unique per pack and task; replay from the recorded inputs must reproduce both byte for byte | C3, C4 |
| T5-11 | Evaluation gaming: tuning to the corpus, editing the corpus to fit, or a gate that reads results instead of recomputing them | Pre-registration committed before any result (E1 checks the order); holdout reported apart; corpus manifest re-derived from Git; the gate recomputes with production code and compares bytes; a seeded weight change must turn it red; regressions need a named approver | E1–E6 |
| T5-12 | Cross-tenant leakage through a shared index or composition cache | Snapshot and provenance keyed by organization and project; scoped artifact FKs; no cross-tenant dedup, even for one repository and commit | C4; data-model §3.1 |
| T5-13 | License violation by vendoring | MIT sources only, upstream `LICENSE` verbatim, `NOTICE.md` attribution, SPDX id per release; public catalogs stay discovery-only (ADR 0007) | V2 |
| T5-14 | Supply-chain substitution at import (a changed upstream file) | Pinned commit and git blob SHA per file; the import tool refuses other bytes; no live fetch by workers | V1 |

## 4. Non-issues (documented, not fixed)

- **Confidentiality of skill text.** Vendored skills are public MIT text; the threat is integrity, not secrecy.
- **Model-side behaviour of skills.** Whether a skill makes the agent better is an outcome question for the pilot
  (plan §4); the platform's guarantee is that only reviewed, signed text is delivered.

## 5. Residual risk

The indexer parses hostile repositories on the trusted host, without a container. It executes no repository code,
writes only regular files under a fresh directory, and is capped, but a parser vulnerability in TypeScript 7.0.2
would run with the worker's privileges. Containerized indexing stays deferred past Day 90: Phase 6 declines it while
the indexer runs nothing from the repository (plan §4, §18.1). Until an operator signs a
registry index, production packs carry no skills (`skills: none`), which removes T5-01 from the production path
and leaves it only in the offline evaluation.
