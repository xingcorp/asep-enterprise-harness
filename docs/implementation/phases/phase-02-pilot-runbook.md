# Phase 2 — Pilot Runbook (exit criteria M1/M2/M3)

> Operational procedures for running the single-agent vertical slice against a
> real pilot repository. Covers the dashboard + alert thresholds and explicit
> stop/rollback conditions (M1), outage-recovery for the artifact store, DB and
> GitHub plus stale-lease recovery and retention/cleanup (M2), and points to the
> preserved rehearsal that proves the runbook leads to the documented decisions
> (M3). Every metric named here exists in `docs/platform/metrics-dictionary.yaml`;
> every recovery step maps to a real mechanism in the shipped code.

## 0. Scope & preconditions

- Automated pilot completion is restricted to **R0** tasks; **R1** requires a
  separately recorded human independent-review step; **R2–R4 are deferred**
  (risk-admission matrix, exit BR1/BR2/I4). Do not attempt a pilot task above R0
  without the recorded human review.
- The verification sandbox must enforce OS-level isolation (exit E8/F6). The
  governed slice probes it and refuses, before any commit, push or PR, a sandbox
  whose handle does not claim `isolationEnforced: true`; there is no waiver and
  no input that relaxes it. A host without a working Docker daemon cannot run a
  pilot task.
- Preconditions before any pilot task:
  - `pnpm verify:all` green from a clean checkout (exit A1/A4).
  - PostgreSQL, object store (MinIO) and the sandbox provisioned and healthy
    (exit K4) — the integration gate fails rather than skips if any is down.
  - The control-plane database created **fresh** at the current schema
    (migrations through 0019). Migrations 0017, 0018 and 0019 refuse rows that
    predate them (references without a matching artifact, evidence without a
    reservation, command output without a checksum), so they are not a
    compatible upgrade of a database that holds data. Moving older data
    forward needs a separate, reviewed data procedure; Phase 2 has none.
  - GitHub App installed on the pilot repo with the default branch protected so
    the installation token cannot update or merge it (exit H3).
  - The agent images, model credential and live proofs of §0.1 in place, and
    `pnpm test:live:claude` passing with the pilot's own configuration.

### 0.1 Agent containment and the model credential

The Claude provider has no host-execution mode. Every attempt runs like this
(`adapters/agent-claude/src/claude-provider.ts`):

1. An **internal** Docker network is created for the attempt with an
   **isolated** gateway (`-o com.docker.network.bridge.gateway_mode_ipv4=isolated`
   and `…_ipv6=isolated`). `--internal` removes the route out and external DNS
   but still gives the host an address on the network's bridge, where any host
   service listening on a wildcard address answers; the isolated mode gives the
   bridge no address. Before anything is attached the provider reads the
   network back from the daemon (`docker network inspect`) and fails the attempt
   unless it is internal, both gateway modes are `isolated` and no subnet has a
   gateway address. The daemon must support the isolated gateway mode, which
   Docker Engine added in 28.0.0 and accepts only for internal networks; an
   older daemon fails every attempt closed. The proof below ran on Docker
   Engine 29.6.1 (Docker Desktop).

   What is proven, by the real-daemon canary in
   `adapters/agent-claude/src/agent-sandbox.itest.ts`, from inside the agent
   container: a public IPv4 address, the model API's own address and a public
   IPv6 address are unreachable; DNS for a public name fails through the
   embedded resolver and when a public resolver is asked directly; the agent
   holds no IPv6 address; and a service listening on the wildcard address of
   the daemon's host network namespace — plus the integration gate's PostgreSQL
   and MinIO ports — is unreachable at the would-be bridge gateway, the default
   bridge gateway (`172.17.0.1`), Docker Desktop's host address
   (`192.168.65.254`) and `host.docker.internal`. The same test shows a
   container on a plain `--internal` network DOES reach that service through
   its gateway. Not proven: reachability of other networks' containers by
   address (they are on other subnets with no route), and anything the egress
   proxy itself can reach (it is trusted harness code on the egress network).
2. An **egress proxy** container (`adapters/agent-claude/assets/egress-proxy.mjs`)
   starts on the egress network and is attached to the internal one. It forwards
   only `POST /v1/messages` and `POST /v1/messages/count_tokens`, only to the
   configured model API origin; absolute-form requests, `CONNECT` tunnels,
   upgrades and every other path get 403. The model key reaches it on **stdin**
   and it substitutes the key into each forwarded request. Its access log
   (method, path, status — never headers or bodies) is stored as the
   `claude-egress-log` artifact.
3. The agent container runs on the internal network only, as the harness user,
   with a read-only root filesystem, all capabilities dropped,
   `no-new-privileges`, PID/CPU/memory limits and no Docker socket. The leased
   worktree is its one writable bind; the worktree's `.git` indirection, the work
   order and the context pack are read-only binds, and the mirror is not mounted.
   It holds a placeholder API key and `ANTHROPIC_BASE_URL` pointing at the proxy.
4. Containers and network are removed when the attempt ends, whatever happened
   — including when a `docker run` client dies mid-run, which does not stop its
   container. Each container carries `asep.attempt=<attemptId>`,
   `asep.role=agent|egress-proxy` and `asep.container=<name>`; the provider
   removes each by name, then removes everything labelled with the attempt and
   confirms with `docker ps -a` / `docker network ls` that nothing is left. If
   it cannot, the attempt fails closed. Verification containers work the same
   way (`asep.role=verification`, `asep.sandbox=<id>`, `asep.workspace=<id>` and
   `asep.attempt=<id>`): stopped by name on a timeout or a cancellation, removed
   by name when their client ends, and swept by sandbox when the sandbox stops;
   a container that cannot be shown gone fails the verification step.

Configuration (`apps/control-plane-api/src/pilot-main.ts`, all required unless
marked):

| Variable | Meaning |
|---|---|
| `ASEP_AGENT_IMAGE_DIGEST` | `image@sha256:…` with the pinned Claude CLI installed, e.g. built `FROM` the pinned node image with `npm install -g @anthropic-ai/claude-code@<version>`. |
| `ASEP_CLAUDE_EXECUTABLE` | The CLI's path inside that image. |
| `ASEP_CLAUDE_CLI_VERSION` | The CLI version baked into the image. The attempt fails closed if `system/init` reports anything else. |
| `ASEP_CLAUDE_MODEL` | A full model id (not an alias). The attempt fails closed if `system/init` reports another model, or the CLI announces a model fallback. |
| `ASEP_EGRESS_PROXY_IMAGE_DIGEST` | `image@sha256:…` with `node` on `PATH` (the pinned node image in `scripts/integration/images.mjs` works). |
| `ASEP_ANTHROPIC_API_KEY_FILE` | A file holding the model key, mode `600` (a group/other-readable file is refused). Use a key scoped to the pilot (its own workspace and spend limit). It is read per attempt, so rotation needs no restart. |
| `ASEP_ANTHROPIC_BASE_URL` (optional) | The model API origin, `https://` only. Defaults to `https://api.anthropic.com`. |

Orphan sweep after a harness crash. The harness removes what it started only
while it is alive; if its own process dies, its containers keep running until
swept (nothing else is ever labelled this way):

```sh
docker rm -f $(docker ps -aq --filter label=asep.role)
docker network rm $(docker network ls -q --filter label=asep.attempt)
```

**Live proofs (opt-in, never part of the gate).** `pnpm test:live:claude` runs
`adapters/agent-claude/src/claude-live.live.ts`. Without configuration both tests
skip and print why.

- *LIVE* (`ASEP_LIVE_CLAUDE=1` plus the variables above): the real CLI in the
  agent image, under real Docker, through the real proxy, against the real model
  API — asked for one checkable change in a throwaway worktree. This is the
  model half of K2; run it before the first pilot task and keep its output.
- *CONFORMANCE* (`ASEP_CLAUDE_CONFORMANCE_CLI=<claude binary>`): the real CLI on
  the operator's host, driven by the real provider through the fake docker
  client, the real proxy and a fake model API. No credential and no network. It
  checks that the CLI accepts the provider's exact argv and stdin prompt and
  that its stream parses.

### 0.2 Evidence storage and the pilot verifier

`ASEP_OBJECT_STORE_DIR` (required) is the directory the pilot writes artifact
and evidence bytes to. Keep it for the life of the pilot: the verifier reads the
evidence back from it.

A COMPLETE verdict is gated by `scripts/pilot/verify-pilot-manifest.mjs`. Run
`pnpm build` first (it loads the built GitHub App adapter, policy package and
command runner), then:

```sh
ASEP_PG_URL=… ASEP_REVIEWER_PUBLIC_KEY=<reviewer public key PEM> \
ASEP_OBJECT_STORE_DIR=<the pilot's object store> \
ASEP_GITHUB_APP_ID=… ASEP_GITHUB_PRIVATE_KEY_PATH=… ASEP_GITHUB_INSTALLATION_ID=… \
ASEP_CLAUDE_MODEL=… ASEP_CLAUDE_CLI_VERSION=… \
ASEP_AGENT_IMAGE_DIGEST=… ASEP_EGRESS_PROXY_IMAGE_DIGEST=… ASEP_VERIFY_IMAGE_DIGEST=… \
ASEP_VERIFICATION_MATRIX_SHA256=<sha256 of policies/verification-matrix.yaml> \
[ASEP_ANTHROPIC_BASE_URL=…] \
  node scripts/pilot/verify-pilot-manifest.mjs <manifest.json>
```

Every variable is required except `ASEP_ANTHROPIC_BASE_URL` (the public API by
default, https only); a missing one is a rejection, not a downgrade. The Claude
and image variables must hold the values the pilot ran with.
`ASEP_VERIFICATION_MATRIX_SHA256` pins the mandatory verification matrix the
pilot ran under: record `shasum -a 256 policies/verification-matrix.yaml` at the
start of the pilot. The verifier reads the repository's copy only if it still
hashes to the pin, and refuses to run otherwise. For each task the verifier,
besides matching the manifest against the database rows:

- reads the task from the database: it must be `WAITING_FOR_HUMAN_REVIEW`, at a
  risk Phase-2 admission admits (`R0` or `R1`; the manifest's `risk` must be
  the task's — note that the pilot workflow plans checks for `L0` and `L1`
  only, which covers `R0`; an `R1` task stops at verification for its missing
  mandatory `L2`, so pilot tasks are `R0`), and the manifest's `baseSha` and `workOrderSha256` must be the
  attempt's base and the work order the task carries. The work order and the
  attempt's context pack must be artifacts of their kind whose stored bytes
  still hash to what is recorded, and the agent's invocation manifest must name
  exactly those two as its inputs;

- accepts the agent only if the attempt records exactly the provider id the real
  Claude adapter produces for the pinned model and CLI version
  (`claude:<model>@cli-<version>`), the manifest claims the same id, and the
  attempt carries the evidence that adapter writes and a double cannot: one
  invocation manifest naming that id, the pinned images and the pinned model
  origin; one event stream whose CLI init event reports the pinned version and
  model and the manifest's `providerSessionId`, and which ends in success; and
  one egress-proxy log with at least one forwarded `POST /v1/messages` the model
  answered 2xx. Each is re-hashed from the object store. A run through a local
  agent double records none of these and is refused;

- fetches the evidence bytes from the object store, requires them to hash to
  the sha256 the artifact row records and the attempt to carry that evidence,
  and checks the bundle they hold against the canonical evidence-bundle shape,
  closed at every level: it names the task, the attempt, the attempt's result
  commit and the manifest's base; its environment image is the pinned agent
  image; its diff is an intact `git-diff` artifact with the recorded checksum;
  and it has at least one check, each with a known category, an integer exit
  code and intact `command-stdout` / `command-stderr` artifacts;
- requires one intact `verification-provenance` artifact of the attempt — the
  harness's record of where each check ran — for this task, attempt and risk,
  with a `PASS` verdict, matching the bundle check for check (id, command, exit
  code, raw output), every check recorded at a level the matrix has and of
  that level's kind (`L0` workspace, `L1` static, `L2` unit, …), and run in a
  container of the pinned verification image (`ASEP_VERIFY_IMAGE_DIGEST`)
  under exactly the verification sandbox profile — the flags the command
  runner's `buildSandboxRunFlags` gives the profile, then the attempt's working
  tree as the one writable mount with its `.git` read-only over it, then the
  sandbox's labels for this attempt — compared whole after normalizing
  `--flag=value` and alias spellings (`--net`, `-v`, `-l`), so any added,
  dropped or changed flag is refused. Coverage is read from the pinned matrix
  for the task's own risk: every mandatory level must have a check recorded as
  mandatory (a check at a mandatory level recorded advisory is refused), and
  every mandatory check must have passed;
- requires the attempt's PR row to be recorded `OPEN`, then asks GitHub,
  through the same GitHub App and forge port the pilot uses, for the PR on the
  attempt's branch, and requires its number and URL to match the record, its
  base to be the recorded base, GitHub to report it open and not merged, and
  its head to be the attempt's result commit — a PR closed, merged or moved to
  another base, or whose branch has moved since review, is refused;
- requires a human authorization whose ed25519 signature verifies against the
  reviewer key and which was signed for this attempt, this result commit and
  this PR.

Recording a human decision: write the decision as JSON with `task_id`,
`attempt_id`, `pull_request_id`, `disposition`, `reviewed_result_sha` (the
attempt's result commit, which is the PR head being reviewed) and `signed_by`;
sign it out of band with
`node scripts/pilot/human-authorization-crypto.mjs sign <private key> <decision.json>`;
and insert the signed fields into `human_authorizations`. The harness never
holds the reviewer's private key.

## 1. Dashboard & metrics requirements (M1)

The pilot dashboard MUST display these metrics (all defined in the metrics
dictionary). Group them into three panels:

**Correctness / safety**
- `first_attempt_pass_rate`, `task_pass_rate` — did the harness produce a
  verifiable change.
- `false_completion_rate` — the load-bearing safety metric: a task marked done
  whose evidence does not support completion. Target **0**.
- `scope_violation_rate` — agent changed files outside the work order scope.
- `escaped_defect_rate`, `artifact_loss_rate` — post-hoc integrity signals.

**Recovery / reliability**
- `workflow_recovery_rate` — crash-safe side-effect convergence after a fault
  (commit/push/PR converge to one commit, one ref, one PR).
- `mean_time_to_restore_ms`, `change_failure_rate` — outage impact.

**Cost / human load**
- `cost_per_accepted_task`, `tool_calls_per_task`, `repair_cycles_per_task`.
- `human_intervention_rate`, `human_minutes_per_task`.

Every span/event on the dashboard MUST carry the full correlation identity
(org/project/repository/run/task/attempt — exit J1/J2). Filter and drill down by
those IDs; a panel that cannot resolve a data point to one attempt is a bug.

### Alert / observation thresholds

| Signal | Observe (warn) | Alert (page) |
|---|---|---|
| `false_completion_rate` | > 0 over any window | any single confirmed false completion |
| `scope_violation_rate` | > 5% | > 15% or any R1 violation |
| `workflow_recovery_rate` | < 100% | < 99% (a fault did not converge) |
| `artifact_loss_rate` | > 0 | any confirmed loss |
| `first_attempt_pass_rate` | < 40% | < 20% (agent adding no value) |
| `cost_per_accepted_task` | > 1.5× baseline | > 3× baseline |
| provider timeout / quota errors | > 10% of attempts | > 30% or sustained quota exhaustion |
| GitHub 403/rate-limit | any | sustained (token/permission problem, see §2.3) |
| `publication-incomplete` from a PR head GitHub had not caught up with (§3.4) | record every one | — (a Phase 2 limit; the count is the measurement) |

Thresholds are pilot heuristics; record actuals during rehearsal and tune before
scaling task volume.

## 2. Stop / rollback conditions (M1)

Halt the pilot (stop dispatching new tasks) immediately on any of:

1. **Any confirmed false completion** (`false_completion_rate` > 0 with a real
   example). This is the one non-negotiable stop condition — the harness claimed
   done without supporting evidence. Do not resume until root-caused.
2. **A side effect that did not converge** (`workflow_recovery_rate` < 100%): a
   second commit, a second PR, or an unexpected remote ref after a crash/restart.
3. **Any push to a protected ref** or an attempted merge (should be impossible —
   exit H3/H5 — but if observed, stop and treat as a security incident).
4. **Confirmed artifact loss or corruption** that read-verification did not
   catch before use.
5. **Sandbox isolation failure**: a write from inside the sandbox reaches `.git`
   internals, refs, config, hooks, or the host mirror (exit E8).
6. **Unexpected egress**: a `claude-egress-log` line other than an allowlisted
   `POST /v1/messages…` or a 403 refusal.
7. **Credential exposure**: an attempt failed with "model credential appeared in
   … and was redacted". Rotate the model key before resuming.

Rollback for a single task is inherently safe by design: the harness only ever
pushes to an ASEP-namespaced branch and opens a PR — **there is no merge
capability in Phase 2** (exit H5). To roll back a task, close its PR and delete
its ASEP branch; the default branch is never touched. No production rollback of
merged code is possible because nothing is auto-merged.

## 3. Outage-recovery procedures (M2)

### 3.1 Artifact store (object storage) outage

- **Symptom:** `artifact.put`/`get`/`verify` failures; rising `artifact_loss_rate`.
- **Guarantees in code:** writes are conditional create-only and size+checksum
  are verified before the metadata commit; an object-write failure does **not**
  create accepted metadata, and a metadata failure does **not** claim success
  (exit D4/D7). Raw stdout/stderr is captured and stored **before** any reducer
  runs, and a required check fails closed if complete evidence cannot be
  persisted (exit D5).
- **Recovery:**
  1. Stop dispatching new tasks; in-flight tasks fail closed at the evidence
     step rather than proceeding with partial evidence.
  2. Restore the object store; verify health.
  3. Run orphan reconciliation: an object written without its committed metadata
     is an orphan (defined in D7) — reconcile/delete orphans; metadata rows
     without a verifiable object are quarantined, not served.
  4. Re-verify a sample of recent artifacts by checksum before resuming.
  5. Resume an attempt that stopped at the evidence step. Its commit is local
     only (nothing was pushed) and its evidence was fixed before the commit as
     a reserved draft, so the resume stores that draft completed with the
     recorded commit SHA and publishes exactly one ref and one PR. Evidence is
     never re-derived: if the draft itself is unreadable the resume publishes
     nothing, and the task is run again as a new attempt.

### 3.2 Database (PostgreSQL) outage / restart

- **Symptom:** repository calls fail; use cases fail closed (every use case and
  repository method requires a server-derived `TenantScope`/`AuthContext`).
- **Guarantees in code:** state survives process restart (exit C1); state
  transitions are optimistic-concurrency guarded (conflicting version update
  rejected — exit C4); migrations are append-only with checksums and a migration
  lock serializes concurrent migrators; mid-migration failure recovers and an
  edited applied migration fails before later migrations run (exit C5).
- **Recovery:**
  1. On restart, do **not** re-run tasks blindly. The two-phase side-effect log
     (`PENDING → COMPLETED/FAILED`, per-tenant semantic key + request
     fingerprint + fencing) is the source of truth for what already happened
     (exit C7).
  2. For each in-flight attempt, reconcile the `PENDING` side-effect row against
     the outside world before deciding retry-vs-adopt: if the commit (recorded
     in the mirror under the attempt), push or PR already landed, adopt it (do
     not repeat); if not, retry with the same semantic key. Reusing a key with a
     **different** request fingerprint fails closed. A resume holds no
     workspace, so an attempt whose harness commit never landed is run again as
     a new attempt — nothing had left the harness.
  3. Confirm migration checksums match before serving traffic.

### 3.3 GitHub outage / rate limiting / token expiry

- **Symptom:** 5xx from GitHub, 403 rate-limit, or auth-expiry mid push/PR.
- **Guarantees in code:** a GitHub **App** installation token is minted
  just-in-time per bounded operation, scoped to the exact repo with minimum
  permissions, treated as opaque, and never persisted (exit H1/H2). Auth-expiry
  re-mint reconciles **without replaying a completed side effect**. PR
  create/update is idempotent (find-by-head-branch upsert — exit H4).
- **Recovery:**
  1. On rate-limit, back off and pause dispatch; do not hammer. A rate limit is
     not treated as token expiry, so the adapter does not re-mint and retry; the
     run stops with whatever already landed recorded. After back-off, resume the
     attempt: a recorded push is adopted, the forge is asked for the PR by head
     branch, and at most one PR is opened (exit C7/H4).
  2. On token expiry during a push/PR, the adapter re-mints and reconciles; a
     completed push/PR is adopted, not replayed.
  3. If 403s persist, treat as a permission/branch-protection problem: verify the
     installation still scopes only the pilot repo and cannot touch the default
     branch (exit H3). Do not widen permissions to "fix" it.

### 3.4 Stale-lease recovery

- **Mechanism in code:** a unique active writer/branch lease is enforced; an
  `ACTIVE` lease past `expires_at` is swept to `EXPIRED` on the next acquire on
  the same `(binding, branch)`, so a dead holder cannot block a fresh acquire
  forever (`lease-repository.ts`, exit C3). A concurrent live acquire is denied
  with `active_writer_lease_held`.
- **Recovery:** if a worker died holding a lease, the next acquire on that
  branch sweeps the expired lease automatically. To force it, run the sweep
  helper (expire stale `ACTIVE` leases past `expires_at`). Never delete lease
  rows by hand while a worker may still be alive — rely on TTL + heartbeat.
- **After a takeover:** the forge is not fenced. An executor that was inside a
  forge call when its lease lapsed may still have pushed or written the PR
  after the successor took over (GitHub has no compare-and-set for a PR
  update). The push's lease conditions only on the branch's current value, not
  on what is pushed. What makes the push the attempt's own commit is that the
  harness only ever pushes the attempt's pinned commit; once the branch
  exists, the lease refuses a stale push that still expects it absent,
  whatever that push carries. Its PR text is the same function of the
  attempt's facts. The resume reconciles the branch and the recorded PR with
  those facts before the task reaches review; the PR is written only by its
  recorded number, never one chosen again by branch, and none is created.
  Each repair is an `audit_events` row with action `forge.reconcile` naming
  what it found; review them for the attempt before the human review. An open
  PR edited by hand afterwards is repaired only by another resume.
- **A PR closed, merged or retargeted by a human:** the harness never reopens
  or retargets a PR, and does not write to one it reads closed, merged or on
  another base. A human may still close, merge or retarget the PR between the
  adapter's read and its title/body write, or between the check and a repair's
  write by the recorded number; that write then lands on the attempt's own PR
  as the human left it, possibly one that just closed (a residual read/write
  race: GitHub has no compare-and-set for a PR update, R30). It never lands on
  another PR a human opened on the branch. A run or resume then reads the PR
  again, finds it not reviewable and fails the task: an `audit_events` row
  with action `task.status.transition` whose detail has `to: FAILED`,
  `outcome: publication-incomplete`, the reason, the PR found (number, url,
  head, base, head commit, state, merged) and the recorded PR, and no
  `pull_requests` row.
  FAILED is terminal: to publish the change again, run its work order as a new
  task. A PR closed after its task reached review leaves the task there; the
  pilot verifier rejects it.
- **A PR head GitHub has not caught up with yet (a Phase 2 limit, R43):**
  completion binds the PR's head commit to the attempt's commit, and GitHub
  may go on reporting the PR's previous head for a while after a push. A read
  in that window fails the task closed rather than completing it. Symptom: a
  `publication-incomplete` failure as above whose reason contains
  `PR #<n> shows <sha>, not the attempt's commit <sha>`, while the PR on
  GitHub shows the attempt's commit when looked at afterwards. Recovery: as
  for any FAILED task, run its work order as a new task. Record each
  occurrence (task, PR, the two SHAs, the time between the push and the
  failure) under its row in §1's observation table: the pilot measures how
  often it happens.
- **Worktree hygiene:** cleanup is idempotent and a failed worktree is
  **quarantined, not reused** (exit E7). Do not manually re-point a quarantined
  worktree at a new attempt.

### 3.5 Retention & cleanup

- Evidence bundles and raw provider events are content-addressed artifacts;
  retention follows the privacy classes in the metrics dictionary. Full
  source/prompt/raw tool output is **off by default** (opt-in + documented
  redaction — exit J3); do not enable raw capture for a pilot without a recorded
  privacy review.
- Periodically: expire `EXPIRED`/`RELEASED` leases, reconcile artifact orphans
  (§3.1), and prune ASEP branches whose PRs are closed/merged by a human.
- Never prune a side-effect-log row for an in-flight or unreconciled attempt —
  it is the crash-recovery source of truth.

## 4. Pilot rehearsal (M3)

The preserved rehearsal in `phase-02-pilot-rehearsal.md` walks five injected
faults — provider timeout, DB restart, object-store outage, stale lease, and
GitHub rate limiting — and shows, for each, that following this runbook reaches
the documented stop or recovery decision. Re-run the rehearsal after any change
to the recovery mechanics referenced above.
