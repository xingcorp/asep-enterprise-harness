# Phase 2 — Pilot Rehearsal (exit criterion M3)

> The rehearsal of the five injected faults the runbook must handle: provider
> timeout, DB restart, object-store outage, stale lease, and GitHub rate
> limiting. Every fault is injected by an automated test that runs in the
> canonical gate (`pnpm test`); the object-store outage and the rate limit are
> injected into a real run of the governed pipeline (`runVerticalSlice`). For
> each fault this records the injection, the behaviour the test asserts, the
> runbook section it exercises, and the decision the runbook leads to.
>
> What this is not: a live run. No test here talks to the real model API or to
> github.com — that is K2, opt-in. Where a test stands in for an external
> system it says which part is real and which is not.

Preconditions per runbook §0: `pnpm verify:all` green, PG + object store +
sandbox healthy, GitHub App scoped to the pilot repo with the default branch
protected. Verdict context: R0-only automated completion.

---

## Fault 1 — Provider (Claude) timeout

- **Injected:** the real `ClaudeCodingProvider`, driving the fake CLI's `hang`
  scenario inside the fake docker client, overruns its wall-clock budget; a
  second case aborts a running attempt through its `AbortSignal`.
- **Asserted behaviour:** the hung agent container is removed by the wall-clock
  budget with no external abort, and the attempt reports `BUDGET_EXHAUSTED`;
  cancellation stops a running agent promptly and an already-aborted signal
  starts nothing. Containers and the attempt network are torn down either way.
  The real-Docker suite repeats the wall-clock removal against the daemon.
- **Tests:** `adapters/agent-claude/src/agent-claude.test.ts` — "a hung agent is
  removed by the wall-clock budget, with no external abort", "cancellation stops
  a running agent promptly; an already-aborted signal starts nothing";
  `adapters/agent-claude/src/agent-sandbox.itest.ts` (integration gate).
- **Not injected:** the provider inside a full pipeline run. A failed agent
  stops the workflow before verification, so no commit, push or PR follows.
- **Runbook section:** §1 threshold (provider timeout > 10% observe / > 30%
  page), §0 preconditions.
- **Decision:** a single timeout fails the attempt; retry is a **new attempt
  under the same task** (it does not inflate the task count — exit K5). If the
  provider-timeout rate crosses 30% or quota is exhausted, **observe → pause
  dispatch** (§1). Not a §2 hard stop: no false completion or divergent side
  effect occurred.

## Fault 2 — Database restart mid-attempt

- **Injected:** a `PENDING` side-effect row is written, the PGlite database is
  closed (the process dies), and a second client opens the same on-disk data
  directory (the restart).
- **Asserted behaviour:** the row survives the restart still `PENDING`; a
  repeat with the same fingerprint adopts it, a different fingerprint on the
  same key fails closed. In the pipeline, a successor resuming a crashed
  attempt takes its `PENDING` records over under a newer lease epoch, asks the
  forge what landed, and converges on one commit, one ref and one PR while the
  dead executor is refused.
- **Tests:** `adapters/persistence/src/pilot-rehearsal.test.ts` (Fault 2);
  `apps/control-plane-api/src/crash-recovery.test.ts`; the integration gate's
  `crash-takeover.itest.ts` kills a real child process against real PostgreSQL.
- **Runbook section:** §3.2 (DB outage / restart).
- **Decision:** **recover, do not re-run blindly.** Reconcile every in-flight
  `PENDING` row, confirm migration checksums, then resume.
  `workflow_recovery_rate` must read 100%; if a second commit/PR appears,
  escalate to §2 stop condition 2.

## Fault 3 — Object-store outage during evidence persist

- **Injected:** into a real `runVerticalSlice` run. Once verification has run
  and stored its outputs, the object store's root directory is replaced by a
  plain file, so the evidence write fails as it would with the store gone.
- **Asserted behaviour:** the run fails at the evidence write. The harness
  commit exists locally and is the only side-effect record; nothing reaches the
  remote, no PR is opened, no evidence row exists, and the task does not reach
  `WAITING_FOR_HUMAN_REVIEW`. After the store is restored, every artifact
  written before the outage still verifies by checksum. Resuming the attempt
  reports it **not resumable** ("no evidence bundle … re-execute the attempt"):
  the harness never re-derives evidence it did not persist, and nothing is
  pushed.
- **Tests:** `apps/control-plane-api/src/pilot-faults.test.ts` (fault 3), with
  the real artifact and evidence stores, side-effect log, lease repository, git
  mirror/worktree/remote and the DockerSandboxProvider (through the fake docker
  client). `adapters/persistence/src/pilot-rehearsal.test.ts` (Fault 3) covers
  the store's own fail-closed read and create-only write.
- **Runbook section:** §3.1 (artifact-store outage).
- **Decision:** **stop dispatch, restore the store, reconcile orphans,
  re-verify recent artifacts by checksum**, then run the stopped task again as a
  **new attempt** (§3.1 step 5). Evidence failed closed, so there is no false
  completion — a recovery path, not a §2 hard stop, unless confirmed artifact
  loss or corruption is found (§2 condition 4).

## Fault 4 — Stale lease from a dead worker

- **Injected:** a writer lease on `(binding, branch)` is taken with a 1 ms TTL
  and left to expire, as a dead worker's would.
- **Asserted behaviour:** the next acquire on the same `(binding, branch)`
  sweeps the expired lease and wins; a concurrent live acquire is denied. In the
  pipeline, a resume is refused while another executor's lease is live and does
  nothing.
- **Tests:** `adapters/persistence/src/pilot-rehearsal.test.ts` (Fault 4);
  `apps/control-plane-api/src/crash-recovery.test.ts` ("while another executor
  holds a live lease on the branch, the resume does nothing").
- **Runbook section:** §3.4 (stale-lease recovery).
- **Decision:** **let TTL + sweep recover automatically**; force the sweep
  helper only if needed. Do not hand-delete lease rows while a worker may be
  alive. A quarantined worktree is not reused.

## Fault 5 — GitHub rate limiting during the PR step

- **Injected:** into a real `runVerticalSlice` run. The PR operations go
  through the real GitHub App adapter — JIT token handling, the forge port and
  the production binding resolver over the registered binding — down to the
  GitHub REST transport, which answers the PR creation with `403 API rate limit
  exceeded`. (Pushes go to a local bare remote; git transport to github.com is
  not reachable from the gate.)
- **Asserted behaviour:** the adapter does not mistake the rate limit for token
  expiry, so it neither re-mints nor retries; the run stops with the commit and
  push recorded `COMPLETED` and the PR upsert `PENDING`, and no PR exists. After
  the limit lifts, resuming the attempt adopts the recorded push (one push in
  total), finds no PR for the head branch, opens exactly one, and the task
  reaches `WAITING_FOR_HUMAN_REVIEW`. A further retry adopts the recorded PR and
  creates nothing.
- **Tests:** `apps/control-plane-api/src/pilot-faults.test.ts` (fault 5);
  `adapters/github-app` suites for bounded re-mint on genuine expiry and for
  rate-limit classification; `adapters/persistence/src/pilot-rehearsal.test.ts`
  (Fault 5) for the log-level adoption of a completed PR record.
- **Runbook section:** §3.3 (GitHub outage / rate limiting / token expiry), §1
  threshold.
- **Decision:** **back off and pause dispatch, then resume** the stopped attempt
  and let the idempotent retry converge; if 403s persist, treat it as a
  permission or branch-protection problem (§3.3) and investigate scope — do
  **not** widen permissions. Escalate to a §2 security incident only if a
  protected-ref push or merge is actually observed.

---

## Rehearsal outcome

For all five faults the runbook leads to an explicit decision that matches what
the tests assert: fail-closed + retry as a new attempt (F1), reconcile then
resume (F2), stop, restore, re-verify and re-run as a new attempt (F3), TTL
sweep (F4), and back-off then a converging resume (F5). None produced a false
completion or a divergent side effect, so none triggered a §2 hard stop. The
tests run in every `pnpm test`; a change to the side-effect log, lease
repository, artifact or evidence store, forge adapter or workflow that breaks a
recovery path turns them red.
