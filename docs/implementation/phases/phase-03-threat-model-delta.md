# Phase 3 — Threat Model Delta (DRAFT, pending plan review)

> Delta over `docs/operations/security-threat-model.md` and `phase-02-threat-model-delta.md`. Phase 3 adds a
> durable orchestrator (Temporal server + worker pool), human control and approval channels, and recovery paths
> that act on state left behind by dead or paused processes. Every Phase 2 mitigation (T2-01 … T2-15) stays in
> force. Base `00a6889`.

## 1. New trust boundaries

```text
[HTTP client] ──authn (bearer → principal) + capability──▶ [Control Plane API]  trusted
                                                              │ WorkflowEngine port (only Temporal client holder)
                                                              ▼
                                                  [Temporal frontend]  trusted infra; MUST NOT be reachable
                                                              │             by agents, sandboxes or tenants
                                                              ▼
                                       [Workflow code]  trusted, deterministic, refs-only payloads
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
   the activity. Authority must be re-checked at the point of action.

## 2. Assets (additions)

Workflow history; the approval decision record (human accountability evidence, ADR 0014); budget ledger;
fencing epochs; the workspace registry; control-plane capability grants (`executions:*`, `approvals:*`,
`runs:govern`).

## 3. Threats and mitigations (delta)

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T3-01 | Direct access to the Temporal frontend (gRPC 7233) lets an attacker start, signal, update, cancel or terminate workflows, bypassing API authz | Only the control plane holds a client. The gate binds the server to `127.0.0.1`. Agent and verification sandboxes have no route to it: verification runs `--network none` (Phase 2 T2-02), and the agent profile is restricted-egress or pilot-only. Approvals cannot be released by Temporal messages alone (T3-02). **Residual:** frontend mTLS / API key / namespace authorization is not implemented in Phase 3. It is a pre-production dependency, recorded honestly and not claimed. | I3; sandbox canaries (Phase 2 suites); report wording |
| T3-02 | Forged approval (an Update sent with a fabricated principal) releases a gate | A decision is first written by the API as an `approval_decisions` row (authenticated principal, capability, requester ≠ approver, unique per request). The workflow acts only after `verifyApprovalDecision` re-reads that row and checks request, decision and principal class. An Update without a matching row is refused and audited. | I2, I3 |
| T3-03 | Self-approval or agent approval of its own work (ADR 0014; system invariant 8) | Agent and service principals never hold `approvals:decide`. `decided_by ≠ requested_by`. `decided_by <> 'harness'` is a DB check. | I2 |
| T3-04 | Replay of an old approval or control message | Update ID = decision/request ID (server dedup per run). Workflow-side dedup set survives continue-as-new. The validator rejects decisions for non-pending or expired requests. A late decision → 409. | I4, I5, F11 |
| T3-05 | Secrets, source, prompts or command strings land in workflow history | Canonical refs-only payload schemas. Verification is referenced by check id and resolved to commands only inside the activity, from approved project config. A secret/PII scan runs over every committed history. A 64 KB payload budget. | B6 |
| T3-06 | Zombie worker completes a side effect after takeover, producing a duplicate commit, push or PR | Epoch fencing with atomic takeover. Fence + abort checks just before each external call. HEAD compare-and-swap for commits. Exact-ref push and head-keyed PR upsert converge. The forge call log is asserted. | F7, E5, E7, E11 |
| T3-07 | Orphaned agent container keeps mutating a quarantined worktree or keeps spending after its worker died | Deterministic names + labels; reaper before retry/replacement, on cancel and from the janitor; replacement attempts use a fresh worktree and never the quarantined one | E8, F2, G6 |
| T3-08 | Tenant confusion in workflow input (a start with another tenant's IDs) | Workflow inputs are built only by the API from server-derived `TenantScope`. The first activity re-validates the input against the schema and the composite-FK hierarchy (`tasks`/`runs` in scope). Phase 2 composite FKs make cross-scope writes fail at the DB. | D1, D2; Phase 2 IDOR suites |
| T3-09 | The janitor races a live recovery and quarantines a workspace that a recovering workflow still needs | The janitor acts only when `WorkflowEngine.isClosed(workflowId)` is true. Live workflows clean up after themselves. | D10 |
| T3-10 | A crafted pause or cancel storm (repeated controls) is used for denial of service | Capability required. Controls are idempotent per `requestId`. Pause has a bounded timeout. Every accepted control is audited with the principal. Rate limiting is deferred with the rest of API hardening and noted as residual. | G1, G4, G9 |
| T3-11 | A chaos `FaultInjector` reaches production | Constructed only by the chaos worker entry. It can only block or exit, never skip or fake. Fitness forbids it in production entries. | B9 |
| T3-12 | PostgreSQL status tampering steers orchestration (a second orchestrator by the back door) | No activity reads a projected status to sequence work. Projection writes are seq- and ownership-guarded. The tamper test proves it. | F13, D11 |
| T3-13 | Budget bypass through under-reported provider cost | Reservation per attempt cap; provider-enforced caps; harness-measured wall-clock; overrun events. **Residual** stated in PR3-16. | H1, H8 |
| T3-14 | Human approval channel used to override failed mandatory verification | The allowed decision set for `review-adjudication` on `VERIFICATION_FAILED` excludes approve. The core rejects it as a contract violation. ADR 0010: deterministic evidence is stronger than review. | I6, J3 |

## 4. Non-issues and residuals (documented, not fixed in Phase 3)

- **Temporal frontend authentication** (mTLS, API keys, namespace authorizer): pre-production dependency (T3-01).
- **Temporal payload encryption codec**: not needed while payloads are refs-only (T3-05). Revisit if any
  sensitive field ever has to enter history.
- **Multi-host worker isolation**: out of scope. Single-host pool with a host-id guard (PR3-25).
- **API rate limiting**: residual (T3-10).

## 5. Residual risk statement

The orchestrator itself is trusted infrastructure in Phase 3, and its network exposure is the main residual: an
attacker who reaches the Temporal frontend could disrupt workflows, although they cannot forge an approval or
publish outside the ASEP namespace (Phase 2 RefSafetyPolicy still holds). Recovery correctness depends on three
independent fences (record epochs, local CAS, remote natural keys). The chaos matrix proves the combination
against real process death and real zombie pauses, not against simulated ones.
