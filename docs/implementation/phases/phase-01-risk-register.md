# Phase 1 — Risk Register

> Risks to executing Phase 1 itself (not the R0–R4 taxonomy the phase builds). Ordered by severity.

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|----|------|-----------|--------|------------|-------|
| RR-01 | **Schema ↔ type ↔ template drift** — 3 representations already diverge (flat TS vs `apiVersion/kind/spec` templates) | High | High | JSON Schema is single authority; generate/assert TS + validators; drift-guard regeneration-diff test; validate templates in CI (P1-CHANGE-002) | worker/S2 |
| RR-02 | **False completion by worker** — sentinel touched while gates red or before review | Medium | High | Sentinel FILE only + exit 0; controller re-runs full gate independently; codex final review; marker bound to HEAD, invalidated on repair (P1-CHANGE-008); explicit false-completion eval | dispatcher |
| RR-03 | **Fabricated eval data** — inventing 30–50 "historical" tasks to satisfy exit | Medium | High | Synthetic label enforced by schema; ≤10 seeds; real-task collection is a production-pilot gate, not Phase 1 exit (P1-CRIT-001 disposition) | worker/S4 |
| RR-04 | **Accidental Phase 2 creep** — Temporal/provider/memory/UI code sneaks in | Medium | Medium | Out-of-scope list in scope doc; codex final review checks explicitly (H3) | worker/reviewer |
| RR-05 | **Public leak** — secret/PII/large file pushed | Low | Critical | Executable secret+PII+large-file+history scans with self-test; publication checklist green; push human-gated end-of-session | dispatcher/human |
| RR-06 | **`git add -A` disaster** — vendored deps/artifacts staged (burned once per handoff §6) | Medium | High | `git add -A` forbidden; selective staging after `git status` + size/secret scan every commit | worker |
| RR-07 | **Silent single-turn death** (`chat -q`) mid-slice — engine hermes | Medium | Medium | spawn-coder re-invoke loop + sentinel; per-slice commits preserve work; `--engine claude` avoids this path entirely | dispatcher |
| RR-08 | **Provider/quota flap** (9router / model) interrupts marathon | Medium | Low | Outage-aware backoff in spawn-coder; commits preserve progress; manual resume `--resume` (handoff §5.2); report PARTIAL honestly | dispatcher |
| RR-09 | **Policy YAML vs TS divergence** — two mutable sources | Medium | Medium | Single authority + parity test (P1-CHANGE-004 / C5) | worker/S3 |
| RR-10 | **Non-reproducible evals** — ordering/locale/tz/seed unpinned | Medium | Medium | Pin ordering, seed, locale, tz, deny network by default; two-run byte-identical check (D2, P1-OPT-002) | worker/S4 |
| RR-11 | **Raw evidence committed** — sensitive generated output enters git | Low | High | External/ignored raw storage + sanitized committed manifests; secret/path canaries stay outside tracked files (P1-CHANGE-005) | worker/S5 |
| RR-12 | **CI/local drift** — CI green but local red or vice versa | Medium | Medium | One canonical verify command shared by CI + local; clean-tree assertion (P1-CHANGE-009) | worker/S1 |
| RR-13 | **Unlawful publication** — dependency license / missing legal approval | Low | High | License present + dependency-license check + provenance + documented approval gate (P1-CHANGE-006) | worker/human |
| RR-14 | **Eval network guard mistaken for a security sandbox** — the in-process determinism guard is a deterministic-execution bootstrap, not isolation against arbitrary hostile native/runtime code (FFI/WASI/native addon/V8-internals can bypass any in-process monkey-patch) | Medium | High | Phase 1 bounds the claim explicitly (ADR 0016; threat-model note in `evals/runner/env.ts`): code loaded through the canonical launcher cannot capture unguarded supported-network references before the preload runs. Phase 2 MUST enforce network denial OUTSIDE the evaluated process (network namespace, seccomp, gVisor, microVM, or equivalent) — tracked in the P1 backlog "security/network/secret broker" + a new P2 "OS-level eval isolation" item | worker/reviewer (Phase 1) → platform (Phase 2) |

## Rollback

Per-slice commits on `phase/01-evaluation-contracts` off `main`. Any slice revertable via `git revert`/branch reset. `main` untouched until human merge. Worktree removable without touching `main`. Autosave/distress commits reset-soft before merge (handoff §5.2).
