# Phase 1 — Scope (locked)

> Locked at PROMPT 3 after Codex review (REQUEST_CHANGES @ 0.98). See `phase-01-review-log.md` for finding dispositions.
> Base: `main` @ `83ba33db16072f05fb27f00f34cebd6774cb771a`.

## In scope (deliverables A–G)

- **A. Repository public-readiness** — `LICENSE` (Apache-2.0), `.gitignore` completion (+`.task-complete`, `*.tsbuildinfo`, coverage/tmp), CODEOWNERS, PR/issue templates, `SECURITY` (present), CI workflow, publication checklist + executable gates (secret scan with self-test, large-file scan, absolute-path/PII scan, license presence, dependency-license note, history-secret scan). [P1-CHANGE-006, P1-CHANGE-009]
- **B. Canonical contracts** — one authoritative representation (JSON Schema as source of truth) for the 12 contracts, generated/aligned TS types, one runtime validator path (AJV), valid + invalid fixtures with asserted real rejection, `COMPATIBILITY.md` + executable compatibility checker (version snapshots + mutation fixtures), drift guard (schema ⇄ types ⇄ templates all validated against the one source). [P1-CHANGE-002, P1-CHANGE-003]
- **C. Risk & assurance** — R0–R4 taxonomy, 13 change categories → risk mapping, mandatory verification matrix, approval matrix, all derived from **one versioned policy model** with parity tests against the existing `gatePolicy` / YAML. [P1-CHANGE-004]
- **D. Failure taxonomy** — 17 classes as data + classifier + table-driven tests.
- **E. Measurement dictionary** — machine-readable; every metric has name/purpose/formula/numerator/denominator/dimensions/source-events/owner/sampling/alert/privacy-class; operands + source events validated against a RunEvent catalog (referential integrity); privacy is a closed enum with capture/redaction/retention/access/publication rules. [P1-METRIC-002, P1-METRIC-003]
- **F. Evaluation foundation** — dataset schema + deterministic runner (pinned ordering/seed/locale/timezone, default-deny network); labelled synthetic fixtures (≤10 seeds, `source: synthetic`) covering contract validation, risk routing, verification-plan generation, skill routing, reviewer finding quality, malformed provider output, prompt injection, scope violation, false completion. [P1-OPT-002]
- **G. Phase artifacts** — the `phase-01-*.md` docs + `artifacts/phase-01/` evidence (raw, ignored) with a sanitized committed manifest. [P1-CHANGE-005]

## Out of scope (defer to Phase 2+)

Temporal runtime/activities; real Claude/Codex/OpenHands/ADK providers; Mem0/Graphiti/RTK/Caveman; Web Console/UI; **remote publication + PR creation as a Phase-1 completion requirement** (Phase 1 completes offline — publish is a separate human-gated step) [P1-CHANGE-007]; worktree/sandbox manager as a service; PostgreSQL projections; auto-merge; any production side effect; model calls inside deterministic risk rules.

## Historical tasks (P1-CRIT-001 disposition: REJECTED_WITH_EVIDENCE)

Collecting 30–50 genuine historical tasks is **not** a Phase-1 exit criterion. There is no real pilot repo with task history in this starter (one baseline commit), and both the prompt pack and project rules forbid fabricating them. Phase 1 instead proves the graders are deterministic on labelled synthetic fixtures. Real-task collection + a pilot repo are recorded as a **blocking production-pilot gate** in the risk register and Phase 2 inputs.
