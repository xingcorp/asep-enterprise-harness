# Phase 2 — Pilot Rehearsal (exit criterion M3)

> A preserved tabletop rehearsal of the five injected faults the runbook must
> handle: provider timeout, DB restart, object-store outage, stale lease, and
> GitHub rate limiting. For each fault this records the injected condition, the
> observed system behaviour (tied to a real mechanism in code + its test), the
> runbook section consulted, and the decision the runbook leads to. This is a
> paper rehearsal against the shipped mechanisms — it does NOT claim a live
> Claude/GitHub run (that is K2, opt-in).

Preconditions per runbook §0: `pnpm verify:all` green, PG + object store +
sandbox healthy, GitHub App scoped to the pilot repo with the default branch
protected. Verdict context: R0-only automated completion.

---

## Fault 1 — Provider (Claude) timeout

- **Injected:** the coding provider exceeds its configured timeout mid-attempt.
- **Observed behaviour:** `execute()` is bounded by timeout + AbortSignal; on
  cancel it fails closed and returns no observation (exit G3/G5). No commit,
  push or PR is attempted because verification never runs. `tool_calls_per_task`
  and provider-timeout rate rise on the dashboard.
- **Mechanism / proof:** `adapters/agent-claude` fake-executable contract tests
  cover timeout + cancel (exit G6); the agent cannot commit/push/hold a
  credential (exit G5).
- **Runbook section:** §1 threshold (provider timeout > 10% observe / > 30%
  page), §0 preconditions.
- **Decision:** single timeout → the attempt fails closed; retry is a **new
  attempt under the same task** (does not inflate the task count — exit K5). If
  provider-timeout rate crosses 30% or quota is exhausted, **observe → pause
  dispatch** (§1); this is not a §2 hard-stop because no false completion or
  divergent side effect occurred.

## Fault 2 — Database restart mid-attempt

- **Injected:** PostgreSQL is killed immediately after a `PENDING` side-effect
  row is written but before the external call completes, then restarted.
- **Observed behaviour:** state survives restart (exit C1). On recovery the
  two-phase side-effect log is the source of truth: the `PENDING` row is
  reconciled against the remote before retry-vs-adopt (exit C7). If the
  commit/push/PR already landed it is adopted; otherwise it retries with the
  same semantic key. A different request fingerprint on the same key fails
  closed.
- **Mechanism / proof:** `adapters/persistence/src/side-effect-log.ts`
  (`PENDING → COMPLETED/FAILED`, fingerprint + fencing) and the S9 crash-safety
  suite; optimistic-concurrency guard rejects a conflicting version update
  (exit C4).
- **Runbook section:** §3.2 (DB outage / restart).
- **Decision:** **recover, do not re-run blindly.** Reconcile every in-flight
  `PENDING` row, confirm migration checksums, then resume. `workflow_recovery_rate`
  must read 100%; if a second commit/PR appears, escalate to §2 stop condition 2.

## Fault 3 — Object-store (artifact) outage during evidence persist

- **Injected:** the object store becomes unavailable at the evidence-write step.
- **Observed behaviour:** raw stdout/stderr is captured and stored **before** any
  reducer runs; the required evidence check fails closed if complete evidence
  cannot be persisted, so the task does **not** advance to review with partial
  evidence (exit D5). An object-write failure creates no accepted metadata; a
  metadata failure claims no success (exit D4/D7).
- **Mechanism / proof:** `adapters/persistence` evidence-store + artifact-store
  suites; `EvidenceBundle.resultSha` equals the final commit SHA with a
  preallocated evidence id in the `ASEP-Evidence` trailer (exit D8).
- **Runbook section:** §3.1 (artifact-store outage).
- **Decision:** **stop dispatch, restore store, run orphan reconciliation**
  (§3.1), re-verify recent artifacts by checksum, then resume. Because evidence
  failed closed, there is no false completion — this is a recovery path, not a
  §2 hard stop, unless confirmed artifact loss/corruption is found (§2 cond. 4).

## Fault 4 — Stale lease from a dead worker

- **Injected:** a worker holding an `ACTIVE` writer lease on `(binding, branch)`
  dies without releasing; its lease passes `expires_at`.
- **Observed behaviour:** the next acquire on the same `(binding, branch)` sweeps
  the expired `ACTIVE` lease to `EXPIRED` and proceeds, so a dead holder cannot
  block forever (exit C3). A concurrent **live** acquire is denied with
  `active_writer_lease_held`.
- **Mechanism / proof:** `adapters/persistence/src/lease-repository.ts` sweep +
  insert, and the git-worktree quarantine (failed worktree quarantined, not
  reused — exit E7).
- **Runbook section:** §3.4 (stale-lease recovery).
- **Decision:** **let TTL + sweep recover automatically**; force the sweep helper
  only if needed. Do not hand-delete lease rows while a worker may be alive.
  Quarantined worktree is not reused.

## Fault 5 — GitHub rate limiting during push/PR

- **Injected:** GitHub returns 403 rate-limit (and, in a variant, token expiry)
  during the push/PR step.
- **Observed behaviour:** the installation token is minted JIT per bounded
  operation and re-mint on expiry reconciles **without replaying a completed
  side effect** (exit H2). PR create/update is idempotent (find-by-head-branch
  upsert — exit H4), so a delayed retry converges to one PR. Only the
  ASEP-namespaced ref is ever sent; the default branch cannot be updated or
  merged (exit H3/H5).
- **Mechanism / proof:** `adapters/github-app` transport-boundary tests +
  fake-clock expiry/revocation/rotation cases (exit H2/H6).
- **Runbook section:** §3.3 (GitHub outage / rate limiting / token expiry), §1
  threshold.
- **Decision:** **back off and pause dispatch**, let idempotent retry converge;
  if 403s persist, treat as a permission/branch-protection problem (§3.3) and
  investigate scope — do **not** widen permissions. Escalate to §2 security
  incident only if a protected-ref push or merge is actually observed.

---

## Rehearsal outcome

For all five faults the runbook leads to an explicit, documented decision that
matches the shipped mechanism and its test: fail-closed + retry-as-new-attempt
(F1), reconcile-then-resume (F2), stop/reconcile/re-verify (F3), TTL-sweep
auto-recovery (F4), and idempotent back-off convergence (F5). None of the five
produced a false completion or a divergent side effect, so none triggered a §2
hard stop in the rehearsed conditions. Re-run this rehearsal after any change to
the side-effect log, lease repository, artifact store, or forge adapter.
