# Phase 3 — Threat Model Delta (LOCKED v3, pending controller confirmation)

> Delta over `docs/operations/security-threat-model.md` and `phase-02-threat-model-delta.md`. Phase 3 adds a
> durable orchestrator (Temporal server + worker pool), human control and approval channels, and recovery paths
> that act on state left behind by dead or paused processes. Every Phase 2 mitigation (T2-01 … T2-15) stays in
> force. Base `00a6889`; v1 at `80bb76a`, v2 at `98e92cf`. v2 folded in the Codex plan review and reconciliation
> R1–R14; v3 folds in the Codex lock-check of v2 and reconciliation R15–R19 (`phase-03-review-log.md`, section
> "Lock-check v2").

## 1. New trust boundaries

```text
[HTTP client] ──authn (bearer → tenant principal: id, class, capabilities) + capability──▶ [Control Plane API]  trusted
                                  │ WorkflowEngine port (client credential A)    │ decision + outbox row (one txn)
                                  ▼                                              ▼
                      [Temporal frontend]  trusted infra; host loopback in the gate;   [PostgreSQL]
                      MUST NOT be reachable by agents, sandboxes or tenants
                                  ▲ worker credential B (separate from A)
                                  │
                      [Workflow code]  trusted, deterministic, refs-only constrained payloads
                                  │ activity tasks
                                  ▼
                     [Worker pool, single host]  trusted harness processes; any one may be dead or PAUSED (zombie)
                          │                 │                      │
                          ▼                 ▼                      ▼
                 [Agent container]   [Verify container]     [PostgreSQL / MinIO / Git / forge double]
                 UNTRUSTED output     trusted invoker
```

Two new facts shape this delta:

1. **The history is a data store.** Everything a workflow receives or returns is persisted in Temporal history
   and readable by anyone with namespace access.
2. **A worker can be wrong about whether it is still the owner.** A paused process resumes believing it holds
   the activity. Authority must be re-checked at the point of action, against the lease, in the same
   transaction (R1).

## 2. Assets (additions)

Workflow history; the approval decision record (human accountability evidence, ADR 0014) and its delivery
outbox; budget ledger; the Phase 2 fencing state Lane A relies on; the workspace registry; run events;
control-plane capability grants (`executions:*`, `approvals:*`, `runs:govern`); tenant principal identities and
classes.

## 3. Threats and mitigations (delta)

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T3-01 | Direct access to the Temporal frontend (gRPC 7233) lets an attacker start, signal, update, cancel or terminate workflows, bypassing API authz | Only the control plane (client) and the worker pool (worker) connect, each with its own connection settings. The gate publishes the frontend on host loopback only (`-p 127.0.0.1:<port>:7233`); in-container `--ip 0.0.0.0` is only for Docker's port mapping. Both processes refuse a plaintext connection to a non-loopback address. Agent and verification sandboxes have no route to it: verification runs `--network none` (Phase 2 T2-02), and the agent profile is restricted-egress or pilot-only. Approvals cannot be released by Temporal messages alone (T3-02). **Residual:** frontend mTLS / API key / namespace authorization is not implemented in Phase 3. It is a pre-production dependency, recorded honestly and not claimed. | C7, C8, I3; sandbox canaries (Phase 2 suites); report wording |
| T3-02 | Forged approval (an Update sent with a fabricated principal) releases a gate | The API first writes the decision as an `approval_decisions` row: authenticated human principal, capability checked, requester ≠ approver, unique per request. Its delivery row is written in the same transaction. The workflow acts only after `verifyApprovalDecision` re-reads that row and checks request, decision and principal class. An Update without a matching row is refused and audited. | I2, I3 |
| T3-03 | Self-approval or agent approval of its own work (ADR 0014; system invariant 8) | The principal class is server state (`human`/`service`/`agent`, CR-17). Only `human` principals may hold `approvals:decide`. `decided_by ≠ requested_by`. `decided_by` is a principal ULID, so the `harness` literal cannot be stored. | I2, K7 |
| T3-04 | Replay of an old approval or control message | Update ID = decision/request ID (server dedup per run). The workflow-side dedup set survives continue-as-new. The validator rejects decisions for non-pending or expired requests. A late decision → 409. Duplicate deliveries at the gRPC boundary are tested (CX-36). | I4, I5, F11, F17 |
| T3-05 | Secrets, source, prompts, command strings or personal data land in workflow history | Canonical refs-only payload schemas. Every string is constrained by a `pattern`, `enum` or `format`. Control messages carry no free text. Principals appear only as opaque ULIDs, and rationale text stays in PostgreSQL. Verification is referenced by check id and resolved inside the activity through `VerificationCommandCatalog`. A secret/PII scan runs over every committed history. A 64 KB payload budget. A payload codec becomes mandatory before any unclassified field is added. Namespace retention is set explicitly (`--retention 24h` in the gate, read back by the gate; production retention read back by the pre-deployment smoke). | B6, C9, C10 |
| T3-06 | Zombie worker completes a side effect after takeover, producing a duplicate commit, push or PR | The Phase 2 lease-bound fenced takeover under invariants F1–F5 (lease `ACTIVE`, held, current epoch, checked in the same transaction; zombies can never claim, complete, fail or reopen). Fence + abort checks just before each external call. HEAD compare-and-swap for commits. Exact-ref push and head-keyed PR upsert with create-conflict reconciliation converge. The forge call log is asserted. | E4, E5, F7, E7, E11, E12 |
| T3-07 | Orphaned agent or verification container keeps mutating a quarantined worktree or keeps spending after its worker died or the activity was cancelled | Deterministic names + labels; reaper before retry/replacement, after an aborted command, on cancel and from the janitor; per-call runner cancellation; replacement attempts use a fresh worktree and never the quarantined one | E8, E14, F2, G6, G10 |
| T3-08 | Tenant confusion in workflow input (a start with another tenant's IDs) | Workflow inputs are built only by the API from server-derived `TenantScope`. The first activity re-validates the input against the schema and the composite-FK hierarchy (`tasks`/`runs` in scope). Phase 2 composite FKs make cross-scope writes fail at the DB, including the new `run_events` scoped run FK. | D1, D2, O3; Phase 2 IDOR suites |
| T3-09 | The janitor races a live recovery and quarantines a workspace that a recovering workflow still needs | The janitor acts only when `WorkflowEngine.isClosed(workflowId)` is true. Live workflows clean up after themselves. | D10 |
| T3-10 | A crafted pause or cancel storm (repeated controls) is used for denial of service | Capability required. Controls are idempotent per `requestId`. Pause has a bounded timeout. The workflow audits every accepted control with the principal. Rate limiting is deferred with the rest of API hardening and noted as residual. | G1, G4, G9 |
| T3-11 | A chaos `FaultInjector` reaches production | Constructed only by the chaos entries (worker and API). It can only block or exit, never skip or fake. Fitness forbids it in production entries. | B9 |
| T3-12 | PostgreSQL status tampering steers orchestration (a second orchestrator by the back door) | No activity reads a projected status to sequence work. Projection writes are seq- and ownership-guarded. The tamper test proves it. | F13, D11 |
| T3-13 | Budget bypass through under-reported provider cost, or through caps the adapter ignores | Reservation per attempt cap plus a separate verification reserve; per-request caps enforced by the rebased adapter from the event stream; an unsupported cap fails closed before start; harness-measured wall-clock; reported usage above a cap is an overrun: recorded, audited, never verified or published, and it ends the task `BUDGET_EXHAUSTED`; budget-extension approval only for the task cap and only while `maxBudgetExtensionUsd` is set. **Residual** stated in PR3-16. | H1, H3, H8, H9, H10 |
| T3-14 | Human approval channel used to override failed mandatory verification | A verification stop ends the task. No approval kind is reachable after it (`budget-extension` and `publish-change` only). ADR 0010: deterministic evidence is stronger than review. | I6, J1 |
| T3-15 | A decided approval is lost between the PostgreSQL commit and the Temporal Update, leaving a gate stuck until expiry | Transactional outbox; a delivery relay in every API process; identical retries re-deliver; delivery is idempotent by `updateId = decisionId`; a closed target is recorded and audited | I3, F19 |
| T3-16 | A duplicate or late activity completion callback (e.g. from a zombie, or a replayed task token) is accepted as a second result | The server accepts one completion per scheduled activity attempt. The test re-sends completions for recorded task tokens after completion and after a superseding retry, and asserts rejection and one completion event. | F16 |
| T3-17 | Run events are rewritten or deleted to hide an incident or skew metrics | `run_events` is append-only by trigger (UPDATE and DELETE rejected). A same-id event with different bytes raises `RunEventConflictError`. Both lanes write only through `RunEventSink`. Benchmark, replay and corpus measurement never write operational `run_events`; their outputs go to Lane B's measurement storage, and the sink rejects an event whose run does not exist in the tenant (R15). | O2, O3, L3 |
| T3-18 | An assurance-infrastructure failure (reviewer gateway down, slot error) is used to publish work without an independent review | Shadow mode only, where assurance never gates a merge: the failure is audited as `assurance-unavailable`, the PR states that assurance was unavailable, and the human PR review that every task ends in stays the gate; the harness never merges or accepts. In gating mode the failure routes to `ESCALATE`, a flagged PR. It is never silently `PROCEED` in gating mode and never `FAILED` (R19). | J10; PR3-35 |
| T3-19 | A cancel is used to strand half-published state, or is delayed indefinitely by a long non-cancellable section | Critical units are only the three reconciling operations (commit plus evidence binding, push, PR upsert), each short and bounded by its activity timeout; assurance, repair planning and approval waits are cancellable at once; once a push has started the PR upsert completes, so the remote never holds an ASEP branch without its PR (R17). | G7, G11, G12 |

## 4. Non-issues and residuals (documented, not fixed in Phase 3)

- **Temporal frontend authentication** (mTLS, API keys, namespace authorizer): pre-production dependency (T3-01).
- **Temporal payload encryption codec**: not needed while every payload field is classified as an id, hash,
  ref, number or closed enum (T3-05). It becomes mandatory before any unclassified field is added.
- **Production Temporal persistence**: exercised only by the pre-deployment smoke (C9), not by the per-commit
  gate. No production-readiness claim without it (N5).
- **Multi-host worker isolation**: out of scope. Single-host pool with a host-id guard (PR3-25).
- **API rate limiting**: residual (T3-10).
- **Gate backends published on all host interfaces.** The Phase 2 gate publishes PostgreSQL and MinIO with
  `-p <port>:<port>` (`scripts/integration/run-integration.mjs:135,147`; `lib.mjs:138`). They hold test data and
  test credentials only. Lane A publishes Temporal on loopback (C7) and reports the existing pattern to the
  controller instead of changing Phase 2's gate.

## 5. Residual risk statement

The orchestrator itself is trusted infrastructure in Phase 3, and its network exposure is the main residual: an
attacker who reaches the Temporal frontend could disrupt workflows, although they cannot forge an approval or
publish outside the ASEP namespace (Phase 2 RefSafetyPolicy still holds). Recovery correctness depends on three
independent fences: the Phase 2 lease-bound record fencing, local CAS, and remote natural keys with
create-conflict reconciliation. The chaos matrix proves their combination against real process death, real
zombie pauses and duplicated callbacks at the transport, not against simulated ones.
