# Phase 1 — ADR / Technology-Radar Approval Manifest

> Exit criterion G4. Records the architecture decisions and technology-radar
> entries this phase is built on, and confirms each is accepted (not draft) as
> of the Phase 1 head SHA. Approval here means: the decision is in force and the
> Phase 1 deliverables conform to it. Anything a future phase must revisit is
> called out explicitly.

## Architecture Decision Records (accepted)

All 15 ADRs under `docs/architecture/adr/` are accepted and load-bearing for the
contracts, policy, evaluation and measurement foundations delivered in Phase 1.

| ADR | Title | Phase 1 relevance |
|-----|-------|-------------------|
| 0001 | Durable orchestration | Phase 2 dependency; RunEvent contract anticipates it. Not implemented in Phase 1 (out of scope). |
| 0002 | Canonical state | JSON Schema contracts are the canonical representation; TS/validators derive from them. |
| 0003 | Modular monolith | Workspace package layout (`packages/*`, `evals`) follows it. |
| 0004 | One writer per worktree | Scope-violation grader + WorkOrder `allowedPaths` encode the boundary. |
| 0005 | Provider ports | No provider SDK types in domain contracts (B7 gate enforces it). |
| 0006 | Risk-based assurance | Directly realised by the risk taxonomy + verification matrix (S3). |
| 0007 | Signed skill registry | SkillManifest schema carries `signature` + provenance fields. |
| 0008 | Memory is derived | No memory implementation in Phase 1 (out of scope); not contradicted. |
| 0009 | Raw evidence before reduction | EvidenceBundle references raw artifacts by id; generator never embeds/reduces. |
| 0010 | Cross-model review | Approval matrix `requireDifferentModelFamily` from R2 upward. |
| 0011 | Progressive brownfield autonomy | Informs risk levels; no runtime autonomy in Phase 1. |
| 0012 | Observability by default | Measurement dictionary + RunEvent catalog define the telemetry contract. |
| 0013 | No framework soup | Minimal dependency tree: only `ajv`, `ajv-formats`, `yaml` added, all pinned exact. |
| 0014 | Human accountability | Approval matrix `requireHumanMerge`/`requireHumanRelease`; publication is human-gated. |
| 0015 | Greenfield agent-native | Overall framing; Phase 1 builds the agent-native contract/eval substrate. |

## Technology radar (accepted)

`docs/platform/technology-radar.md` is accepted. Phase 1 stays inside its
**adopt** ring and adds no new runtime technology beyond three pinned libraries:

| Dependency | Version (exact) | Ring | Rationale |
|------------|-----------------|------|-----------|
| ajv | 8.20.0 | adopt | Standard JSON Schema (2020-12) validator; single runtime validation path. |
| ajv-formats | 3.0.1 | adopt | Format assertions (date-time) for ajv. |
| yaml | 2.9.0 | adopt | Deterministic YAML parse for policy/metrics/template loading. |

No dependency was pulled from an experimental/hold ring. No provider SDK,
database driver, orchestration runtime or UI framework was introduced (all are
Phase 2+ per the out-of-scope list).

## Decisions recorded during Phase 1 implementation

These implementation choices were made autonomously by the worker (no human was
online) and are recorded here and in the corresponding commit messages:

1. **Canonical contract shape is FLAT** (not the nested `apiVersion/kind/spec`
   envelope the templates originally used). Rationale: the load-bearing runtime
   types and the four green baseline tests consume flat fields
   (`WorkOrder.baseSha`). JSON Schema was authored flat and the six templates
   were rewritten to match, resolving the drift (Codex P1-HIGH-001).
2. **Bespoke deterministic schema→TS generator** instead of
   `json-schema-to-typescript`. Rationale: keeps the dependency tree minimal and
   makes the regeneration-diff drift guard fully deterministic and reviewable.
3. **YAML under `policies/` is the single canonical policy source**; the TS
   engines load it and `gatePolicy` is derived from the approval matrix, so the
   legacy gate policy can never diverge (Codex P1-CHANGE-004).
4. **Dependency-free format/lint gate** (`scripts/format-check.sh`) rather than
   adding prettier/eslint, consistent with ADR 0013.

## Sign-off

- Approver: ASEP contributors (autonomous Phase 1 worker; no human online).
- As-of: Phase 1 head commit (see `phase-01-report.md`).
- Status: all referenced ADRs and radar entries **accepted**; Phase 1
  deliverables conform. No ADR requires amendment for Phase 1.
