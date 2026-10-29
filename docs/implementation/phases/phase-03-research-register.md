# Phase 3 — Research Register (LOCKED v6, pending controller confirmation)

> Dependency and design research for Phase 3 "Durable orchestration" (90-day plan, Days 31–45).
> Every external fact below was observed on **2026-10-29**: in workflow step 1 unless a row says otherwise, and
> re-observed in step 3 where marked. Sources are listed in §9. Anything not observed directly is marked **not
> verified** and has a decision rule that resolves it during implementation. v1 of this register is at
> `80bb76a`. v2 adds the step-3 observations (P3-PLAN-LOW-001) and the reconciliation's decisions (R1, R14).
> v3 adds the retention-flag observation made while folding the lock-check of v2 (Q9, P3-PLAN-MED-003).
> v4 adds the TypeScript compiler API observation behind the AST-based purity check (Q11, P3-S2-MED-002).
> v5 adds the checker observation behind the checker-based purity check (Q11, R24).
> v6 adds the checker observation behind the allowlist of deterministic globals (Q11, R27).
> Environment observed: Node **24.6.0**, pnpm **10.31.0**, TypeScript **7.0.2**, Docker server **29.6.1**
> (Docker re-observed in step 3).

## 1. Version snapshot (npm registry, queried 2026-10-29)

| Package | Latest on registry | Latest release date | Proposed pin | License | Allowed only in |
|---|---|---|---|---|---|
| `@temporalio/workflow` | 1.25.0 | 2026-10-27 | exact `1.24.0` | MIT | `adapters/temporal/src/workflows/**` |
| `@temporalio/activity` | 1.25.0 | 2026-10-27 | exact `1.24.0` | MIT | `adapters/temporal/src/activity-bridge/**` |
| `@temporalio/worker` | 1.25.0 | 2026-10-27 | exact `1.24.0` | MIT | `adapters/temporal/src/worker/**` |
| `@temporalio/client` | 1.25.0 | 2026-10-27 | exact `1.24.0` | MIT | `adapters/temporal/src/client/**` |
| `@temporalio/common` | 1.25.0 | 2026-10-27 | exact `1.24.0` | MIT | `adapters/temporal/**` |
| `@temporalio/testing` | 1.25.0 | 2026-10-27 | exact `1.24.0` (dev) | MIT | `adapters/temporal/**/*.test.ts` only (`MockActivityEnvironment`) |

`1.24.0` was published 2026-09-15 (registry `time` field). The Temporal SDK packages are released in lockstep;
mixing versions is not supported, so all six move together.

**Why `1.24.0` and not `1.25.0`.** `1.25.0` was published two days before this plan. Its release notes add
`protobufjs` (`^8.7.1`) and `long` (`^5.3.2`) as **peer dependencies** of the SDK packages (observed:
`npm view @temporalio/client@1.25.0 peerDependencies`), which would add two more direct dependencies, and it
changes Nexus update semantics. `1.24.0` has no peer dependencies (observed: empty `peerDependencies`) and has
six weeks of release bake time. Durable orchestration is the component whose upgrade breaks in-flight
histories, so the plan prefers the older, settled release. An upgrade to `1.25.x` is a separate, deliberate
change gated by the replay corpus (§5) and recorded here.

**Pinning policy.** Exact versions, no `^`/`~` (Phase 2 policy, `phase-02-research-register.md` §1). The
lockfile is frozen in CI. Transitive ranges inside the SDK (`webpack`, `@swc/core`, `@grpc/grpc-js`, `memfs`,
`unionfs`, `rxjs`, `heap-js`, `nexus-rpc`) are fixed by `pnpm-lock.yaml`.

### 1.1 Transitive license check (observed 2026-10-29)

| Transitive package | License (registry) | Status |
|---|---|---|
| `@temporalio/core-bridge` 1.24.x/1.25.0 | MIT | allowed |
| `@grpc/grpc-js` | Apache-2.0 | allowed |
| `@swc/core` | Apache-2.0 | allowed |
| `webpack`, `swc-loader`, `source-map-loader`, `supports-color`, `uuid`, `nexus-rpc` | MIT | allowed |
| `memfs`, `rxjs` | Apache-2.0 | allowed |
| `heap-js` | BSD-3-Clause | allowed |
| `unionfs` 4.6.0 | **no `license` field in registry metadata** | **risk** — upstream README states Unlicense (allowlisted), but `pnpm licenses list` may report it as unknown |

Decision rule for `unionfs` (risk PR3-10): after `pnpm install`, run `bash scripts/license-inventory.sh`. If it
reports `unionfs` as unknown, the fix is a reviewed, single-package license override that cites the upstream
LICENSE file. The allowlist itself is never widened, and the license gate is never skipped.

### 1.2 Install-time facts to re-verify at S7 (not verified yet)

- `@temporalio/core-bridge` ships prebuilt native binaries (registry unpacked size of 1.25.0 is about 154 MB).
  pnpm 10 blocks dependency lifecycle scripts by default. This repo already shows
  `Ignored build scripts: esbuild@0.28.1` on install. **Not verified:** whether `core-bridge` or `@swc/core`
  need an install script on this platform. Decision rule: if the worker fails to load the native module, add an
  explicit `onlyBuiltDependencies` entry for that one package (root `package.json`, shared surface). Never
  allow all scripts.
- Node support: the SDK README states it "is officially supported on Node 20, 22, and 24". The engines field
  is `node >= 20.3.0`. Node 24.6.0 is used here.

## 2. Temporal server and dev-server images (Docker Hub, observed 2026-10-29)

| Image | Tag | Index digest (observed with `docker buildx imagetools inspect`) | Notes |
|---|---|---|---|
| `temporalio/temporal` (Temporal CLI) | `1.9.1` | `sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e` | Entrypoint `temporal`. CLI 1.9.1 bundles OSS server **1.32.0**. Runs `temporal server start-dev`. |
| `temporalio/server` | `1.32.1` | `sha256:acecbab5b0b8ae9cf4012b508866ca97feda3709577bf157b537239f40029049` | Production-shape server. Needs a separately provisioned and schema-migrated database. |
| `temporalio/admin-tools` | `1.32.1` | `sha256:9ef0dc5b063bf4ffd5c1512de72e0e73e225bd2c7006a18ce69bd592a8862a83` | Schema tooling for `temporalio/server`. |
| `temporalio/ui` | `2.54.1` | `sha256:ff0943fe532b8e33c46cd28b29e81e0ce0b6f55b9ee50a38ef1b437cc4de3fa5` | Optional; not used by the gate. |
| `temporalio/auto-setup` | `1.31.0` | **tag not found** | Used by `compose.yaml:27-28`. Docker Hub lists `1.29.7` (2026-06-12) as the newest `1.29`, and `1.31.0`/`1.32.x` do not exist. |

**Finding (observed).** `compose.yaml:28` references `temporalio/auto-setup:1.31.0`, which does not exist on
Docker Hub (`docker buildx imagetools inspect` returns `not found`). `pnpm infra:up` therefore cannot pull the
Temporal service on a clean host. The tag is also mutable and not digest-pinned. Phase 3 replaces it (change
request CR-15).

**Step 3 re-observation (2026-10-29, P3-PLAN-LOW-001).** The Codex reviewer could not reach the Docker API from
its sandbox, so Lane A re-ran the checks on the implementation host. Docker server `29.6.1`.

| Command | Observed output (verbatim, trimmed to the relevant line) |
|---|---|
| `docker buildx imagetools inspect temporalio/temporal:1.9.1` | `Digest:    sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e` (exit 0) |
| `docker buildx imagetools inspect temporalio/auto-setup:1.31.0` | `ERROR: docker.io/temporalio/auto-setup:1.31.0: not found` (exit 1) |
| `docker buildx imagetools inspect temporalio/server:1.32.1` | `Digest:    sha256:acecbab5b0b8ae9cf4012b508866ca97feda3709577bf157b537239f40029049` (exit 0) |
| `docker buildx imagetools inspect temporalio/admin-tools:1.32.1` | `Digest:    sha256:9ef0dc5b063bf4ffd5c1512de72e0e73e225bd2c7006a18ce69bd592a8862a83` (exit 0) |
| `docker buildx imagetools inspect temporalio/ui:2.54.1` | `Digest:    sha256:ff0943fe532b8e33c46cd28b29e81e0ce0b6f55b9ee50a38ef1b437cc4de3fa5` (exit 0) |
| `docker run --rm temporalio/temporal@sha256:ad4c82c9… --version` | `temporal version 1.9.1 (Server 1.32.0, UI 2.54.1)` (exit 0; container removed) |
| `docker run --rm temporalio/temporal@sha256:ad4c82c9… server start-dev --help` | lists `--ip`, `--headless`, `-n, --namespace`, `-f, --db-filename`, `-p, --port`, `--http-port`, `--ui-ip`, `--ui-port`, `--sqlite-pragma` |
| `docker image inspect temporalio/temporal@sha256:ad4c82c9…` | entrypoint `["temporal"]`; size 155421701 bytes |
| `docker run --rm temporalio/temporal@sha256:ad4c82c9… operator namespace create --help` (v3) | lists `--retention duration   Time to preserve closed Workflows before deletion. (default 72h0m0s)` (exit 0; container removed) |
| `docker run --rm temporalio/temporal@sha256:ad4c82c9… options` (v3) | global `--output, -o string   Non-logging data output format. Accepted values: text, json, jsonl, none. (default text)`; `operator namespace describe --help` itself lists only `--namespace-id` and points to `temporal options` |

The `start-dev --help` output does not list a namespace-retention flag. Retention is set through
`temporal operator namespace create --retention <duration>` at gate setup (Q9, observed in v3): the gate uses
`--retention 24h`, and the namespace is read back with `temporal operator namespace describe --output json`
(exit C10). The JSON field that carries the retention is **not verified**, because it needs a running server; S8
pins it from the gate's first real run and the read-back test fails if the field is absent. These observations
are from a developer host, not CI. S8 makes the gate print the `--version` line into its log, and M3
preserves it, so the controller's CI run records the same evidence.

**Gate decision.** The mandatory integration gate provisions `temporalio/temporal@sha256:ad4c82c9…` and runs
`temporal server start-dev` in it. This is the **real Temporal server binary** (OSS server 1.32.0), with its
history persisted to a SQLite file on a container volume, so the server-restart chaos test can stop and start
it without losing history. It is not a test double. The two SDK test servers are rejected as gate evidence:

- `TestWorkflowEnvironment.createLocal()` downloads the latest CLI release at runtime and caches it. The docs
  say "the latest release of the CLI will be downloaded and cached to a temporary directory". That download is
  neither digest-pinned nor reproducible.
- `TestWorkflowEnvironment.createTimeSkipping()` uses a separate test-server implementation with time skipping.
  It is not the production server and cannot prove recovery behavior. It may appear in unit tests only, and
  only with a label. No MUST may be satisfied by it.

**Topology gap, stated honestly, and how it is closed (R14).** The per-commit gate's server persists to SQLite
and not to PostgreSQL. Temporal's PostgreSQL persistence (the production shape: `temporalio/server` plus
`admin-tools` schema setup) is exercised by a separate **production-shaped pre-deployment smoke** (exit C9). It
uses the two digests above and the repo's digest-pinned PostgreSQL, includes a real server restart, and runs
before any deployment rather than on every commit. The Phase 3 report claims production readiness only if that
smoke passed on the reported SHA (exit N5, risk PR3-26).

## 3. Workflow determinism vs this repo's fitness rules

| Fact (Temporal TS SDK) | Source | Consequence for ASEP |
|---|---|---|
| The workflow bundler allows only the builtins `assert`, `url` and `util`. Every other Node builtin is disallowed, as are `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/testing`, `@temporalio/core-bridge` and `@temporalio/common/lib/internal-non-workflow`. | `packages/worker/src/workflow/bundler.ts` | Workflow code cannot import `@asep/application` (it imports `node:crypto`, `pipeline-steps.ts:32`) or `@asep/policy` (it imports `node:fs`, `policy-source.ts:12-15`). A **separate pure package** (`@asep/orchestration`) is required. Policy evaluation (admission, failure classification) runs in activities. |
| On a disallowed import the bundler fails with "These modules can't be used in workflow context as they might break determinism", and suggests `import type`. | same | A real `bundleWorkflowCode()` test is the authoritative check. It must run with **no** `ignoreModules`. A seeded fixture that imports `node:fs` proves that the test turns red. |
| `Math.random`, `Date.now`, `WeakRef` and `FinalizationRegistry` are overridden in the workflow sandbox (`overrideGlobals()`). Non-deterministic operations throw `DeterminismViolationError`. | `packages/workflow/src/global-overrides.ts` | The sandbox catches some misuse at runtime. The repo fitness rule adds a static ban, so misuse fails before runtime: no `Date`, `Math.random`, timers, `process`, `crypto`, `require`, dynamic `import()` or non-type imports in `packages/orchestration/src/**` and `adapters/temporal/src/workflows/**`. |
| `Worker.runReplayHistories()` replays recorded histories against current workflow code and yields a `DeterminismViolationError` on divergence. | `packages/worker/src/worker.ts` | A committed **replay corpus**, replayed offline in `pnpm test`, is the versioning guard (§5). |

The repo's existing fitness rules (`scripts/forbidden-imports.test.ts:34-46,69-76,261`) already ban provider SDKs
and infrastructure from `packages/{contracts,policy,domain,ports,observability,application}` and orchestration
calls from composition roots. Phase 3 extends them (CR-12) instead of creating a second mechanism.

## 4. Activities: heartbeats, cancellation, retries and timeouts

| Fact | Source | Consequence |
|---|---|---|
| Activity heartbeat `details` from the last heartbeat are available to the next retry as `Info.heartbeatDetails`. | `packages/activity/src/index.ts` (heartbeat JSDoc) | `ActivityExecutionContext.lastProgress` exposes the checkpoint. It is used only for non-authoritative progress. Authoritative recovery state lives in PostgreSQL and on the remote (side-effect log, workspace registry). |
| When no heartbeat arrives within `heartbeatTimeout`, the server fails the attempt. The in-flight activity is cancelled with `CancelledFailure('TIMED_OUT')` once the worker can learn of it. | `packages/activity/src/index.ts`; `packages/worker/src/activity.ts` | Worker death is detected within `heartbeatTimeout`. A *paused* (zombie) worker learns of the cancellation only when it resumes. Lease-bound record fencing (architecture §7.1, the Phase 2 primitive) is therefore required. Cancellation alone is not a fence. |
| `cancellationSignal` is an `AbortSignal` aborted with the `CancelledFailure`. | `packages/worker/src/activity.ts` | It is bridged into `ActivityExecutionContext.signal` and from there into the existing `AgentExecuteRequest.signal`. The Claude adapter already kills its child on abort (`claude-provider.ts:225-227`). |
| `ActivityCancellationType` defaults to `WAIT_CANCELLATION_COMPLETED`. The activity counts as cancelled only after it throws `CancelledFailure`. | `packages/common/src/activity-options.ts`; `packages/worker/src/worker.ts` | Workflow cleanup waits for the agent container to be confirmed stopped before it quarantines the workspace. |
| `startToCloseTimeout` or `scheduleToCloseTimeout` is required. Long activities must set `heartbeatTimeout` and heartbeat. | `packages/common/src/activity-options.ts` | Every activity has explicit timeouts (architecture §5 table). |
| The default activity retry policy is: initial interval 1 s, backoff 2.0, maximum interval 100 × initial, **maximum attempts 0 (unlimited)**, no non-retryable errors. Workflows do not retry by default. | docs.temporal.io/encyclopedia/retry-policies | Defaults are never relied upon. Every activity declares an explicit `RetryPolicy`, and a unit test fails if any activity option set omits `retry.maximumAttempts`, `startToCloseTimeout` or (for long activities) `heartbeatTimeout`. The agent activity uses `maximumAttempts: 1`. |
| Payload limit is 2 MB per request. History hard limits are 51,200 events and 50 MB, with warnings at 10,240 events and 10 MB. | docs.temporal.io/cloud/limits (Cloud defaults; OSS server defaults not verified) | Workflow payloads carry IDs, hashes and `ArtifactRef`s only, never bytes. The run workflow uses continue-as-new on `continueAsNewSuggested`. |
| The client package exposes an async-completion client that completes or fails an activity by task token. **Not verified:** that 1.24.0 rejects a completion for a token whose attempt already completed or was superseded, and which error it raises. | `@temporalio/client` (`AsyncCompletionClient`); to be confirmed at S10 | CX-35 uses it to inject duplicate completion callbacks at the transport. The assertion is on history (one completion event per scheduled activity) and on the call being rejected, not on a specific error class (Q10). |

## 5. Signals, updates, queries, versioning

| Fact | Source | Consequence |
|---|---|---|
| Update IDs are deduplicated by the server **per workflow run**. The ID defaults to a UUID and may be set by the caller. With continue-as-new, deduplication must be done in workflow code. | docs.temporal.io/handling-messages | The API sets `updateId` = the request's idempotency key. The run workflow carries its own dedup set across continue-as-new. |
| Signals are **not** deduplicated by the server. The docs advise "a custom idempotency key … implementing the deduplication in your Workflow code". | same | Signals are used only for idempotent flag messages (pause and resume propagation to children). Every control message carries a `requestId`, and the workflow ignores repeats. Approvals use Updates. |
| A rejected Update (validator throws) leaves no trace in history. Accepted Updates are recorded. | same | Approval validators reject stale, duplicate-conflicting, expired or wrong-request decisions **without** mutating workflow state. |
| `condition(fn, timeout)` returns `false` on timeout. | `packages/workflow/src/workflow.ts` | Approval expiry and pause timeout are durable workflow timers. |
| `patched(patchId)` returns false when replaying a history produced without that patch. | `packages/workflow/src/workflow.ts` | Workflow code changes after the first release are guarded with `patched()`. The committed replay corpus proves old histories still replay. |
| Temporal server 1.32.0 notes that deprecated Worker Versioning APIs are removed in 1.33. | github.com/temporalio/temporal/releases | Phase 3 does **not** adopt build-ID or worker-deployment versioning. It uses `patched()` plus a manifest-gated replay corpus, and deploys workflow-code changes only drain-only or fully patched (architecture §6.6). Revisit once deployment-based versioning is needed for rolling upgrades. |
| `WorkflowIdConflictPolicy.USE_EXISTING` and `WorkflowIdReusePolicy.REJECT_DUPLICATE` exist. | `packages/common/src/workflow-options.ts` | Starts are idempotent: workflow ID `asep-task-<taskId>` / `asep-run-<runId>` with `USE_EXISTING`. A finished task workflow is never re-run under the same ID (`REJECT_DUPLICATE`). |

## 6. Docker behavior relied upon (to be verified empirically)

| Claim | Status | Verification |
|---|---|---|
| Killing the `docker run` **client** with SIGKILL does not stop the container. The client cannot catch SIGKILL, so `--sig-proxy` cannot forward it. | **not verified** in this session | The orphan-container itest (`asep-suite:temporal-orphan-containers`, S4) kills the client and asserts the container is still running *before* reaping. If the claim is false, the reaper is still required for worker-host death and the test records the observed behavior. |
| `--name` uniqueness means a second `docker run` with the same name fails while the first container exists. | not verified | Same suite. |
| `-p 127.0.0.1:<host>:<container>` publishes a port on host loopback only, and `docker inspect` reports `HostIp` `127.0.0.1`. | not verified in this session | Gate test C7 asserts it on the running Temporal container. |

Relevance: `ClaudeCodingProvider` spawns the `docker` CLI and kills it with SIGKILL on timeout or abort
(`claude-provider.ts:183-190,225-235`). Neither it nor the verification sandbox sets `--name` or `--label`
(`git grep` found none under `adapters/` or `apps/`; the sandbox uses `'run', '--rm'` at
`adapters/command-runner/src/sandbox.ts:94`). If the claim holds, a timed-out or killed agent can keep running
in its container. That would also affect the Phase 2 G3 timeout claim. It is reported to the controller in
`phase-03-plan.md` §1.

## 7. ESM + TypeScript 7 + Temporal bundler (not verified, decided at S7)

The repo is ESM (`"type": "module"` in every package) and compiles with TypeScript 7 (`tsc -b`). The Temporal
bundler uses webpack + `swc-loader`, not `tsc`. **Not verified:** that `workflowsPath` can point at ESM `.ts`
sources under `tsx`, and that it can point at compiled ESM `dist/**/*.js`. Decision rule: the S7 bundler test
bundles from the compiled `dist/` output, which is produced by the canonical cold `tsc -b`. If ESM output
fails to bundle, `adapters/temporal` emits its workflow entry through a dedicated `tsconfig` with
`module: NodeNext`, and the decision is recorded here. Mocking the bundler is never a fallback.

## 8. Open questions and their decision rules

| # | Question | Decision rule / owner |
|---|---|---|
| Q1 | Is Temporal PostgreSQL persistence needed in Phase 3? | **Decided by the controller (R14):** not in the per-commit gate; yes as a production-shaped pre-deployment smoke (exit C9). The report claims production readiness only if it passed (N5, PR3-26). |
| Q2 | SDK `1.24.0` vs `1.25.0`? | `1.24.0` (§1). Upgrade is a separate change gated by the replay corpus. |
| Q3 | Does `unionfs` pass the license gate? | Verify at S7 install. Single-package reviewed override if needed (§1.1). |
| Q4 | Do native modules need pnpm build approval? | Verify at S7. Single-package `onlyBuiltDependencies` if needed (§1.2). |
| Q5 | ESM bundling path? | Verify at S7 (§7). |
| Q6 | Does SIGKILL of the docker client orphan the container? | Verify at S4 (§6). |
| Q7 | Will Phase 2 repairs change `SideEffectLog` fencing (the lease-handoff wedge)? | **Resolved by the controller (R1):** yes. Phase 2 HIGH-006 lands the lease-bound fenced takeover. Lane A withdrew CR-05/CR-06 as designs and states invariants instead (plan §30 CR-05). |
| Q8 | What exactly does GitHub return when a PR already exists for a head? | Not verified (no live credentials). The adapter keys on HTTP `422` plus a re-list by head, never on message text (CR-27). The HTTP double returns `422` for a duplicate create. |
| Q9 | Which `temporal operator namespace` flag sets retention on the dev server? | **Resolved (v3, observed 2026-10-29 on the pinned image):** `temporal operator namespace create --retention <duration>` (default `72h0m0s`). The gate uses `24h` and reads it back (C10); production uses `720h` unless the pre-deployment review decides otherwise (architecture §16). The JSON field of the read-back is not verified; S8 pins it from a real run. |
| Q10 | How does `AsyncCompletionClient` in 1.24.0 report a completion for a completed or superseded attempt? | Verify at S10. CX-35 asserts rejection and the history count, not an error class. |
| Q11 | Which parser can the package-local purity check use without a new dependency? | **Resolved (v4, observed 2026-10-29 in this worktree):** the repo's TypeScript is 7.0.2 (root `package.json` `"typescript": "^7.0.2"`), the native port. It has no classic `createSourceFile`; its exports are `typescript/unstable/sync` (an `API` class over the bundled native binary), `typescript/unstable/fs` (`createVirtualFileSystem`) and `typescript/unstable/ast` (`SyntaxKind`). A probe parsed an in-memory project and exposed import clauses (`isTypeOnly`), specifiers (`isTypeOnly`), `ElementAccessExpression`, import-equals, dynamic `import()` and decoded identifier text (`\u0044ate` → `Date`) in under 200 ms. The API is marked unstable; the lockfile pins it, and the check fails red if it changes (PR3-42). The only other parser in the tree is `esbuild`, which exposes no AST. **v5 (observed 2026-10-29 in this worktree):** opening the package's own `packages/orchestration/tsconfig.json` with an in-memory overlay for seeded files, `checker.getSymbolAtLocation(moduleSpecifier)` returns the resolved module's source file (`./task-core.js` → `task-core.ts`) and `undefined` for an unresolvable specifier (`./x.mjs` without `allowJs`, `./%74est-support/…`, `./decide.test.ts?cache`), and `checker.getTypeAtLocation(key)` gives a literal type for `"constructor"` and `"constructor" as const`, a union of literals for a key typed `'a' \| 'b'`, and a non-literal type for `string`, `number` and `"constr" + "uctor"`; the whole project loads in about 0.4 s. The Phase 2 fitness guard (`scripts/lib/ts-guard.mjs` on the Phase 2 branch) uses the same calls. **v6 (observed 2026-10-29 in this worktree):** every declaration a symbol carries reports the lower-cased path of its file, so a global is told from a local by where it is declared: `Number`, `String`, `Math` and `JSON` resolve to `lib.es5.d.ts`, `navigator` and `structuredClone` to ambient declarations (the package's `types: ["node"]`), `undefined` to a symbol with no declaration, and a module-level name or an import binding to the file itself. `checker.getShorthandAssignmentValueSymbol` and `checker.getExportSpecifierLocalTargetSymbol` give the value behind a shorthand property and a local re-export, and `isTypeNode` from `typescript/unstable/ast` marks the type positions to skip. |

## 9. Sources (accessed 2026-10-29)

- npm registry metadata: `npm view @temporalio/{workflow,activity,worker,client,common,testing,core-bridge} version time license dependencies peerDependencies engines`; `npm view unionfs license`.
- Temporal TypeScript SDK source (via Context7 library `/temporalio/sdk-typescript`, indexed version v1.24.0): `packages/worker/src/workflow/bundler.ts`, `packages/workflow/src/global-overrides.ts`, `packages/workflow/src/workflow.ts`, `packages/activity/src/index.ts`, `packages/worker/src/activity.ts`, `packages/worker/src/worker.ts`, `packages/common/src/activity-options.ts`, `packages/common/src/workflow-options.ts`, `packages/testing/src/testing-workflow-environment.ts`, `packages/testing/src/ephemeral-server.ts`.
- SDK README (Node support): https://github.com/temporalio/sdk-typescript
- SDK releases (1.24.0, 1.25.0 notes): https://github.com/temporalio/sdk-typescript/releases
- Server releases (1.32.0 breaking changes, 1.32.1 latest): https://github.com/temporalio/temporal/releases
- CLI releases (1.9.1 bundles server 1.32.0): https://github.com/temporalio/cli/releases
- Message handling (Update dedup, signal dedup, validators): https://docs.temporal.io/handling-messages
- Retry policy defaults: https://docs.temporal.io/encyclopedia/retry-policies
- Limits: https://docs.temporal.io/cloud/limits
- Docker Hub tags: `https://hub.docker.com/v2/repositories/temporalio/{auto-setup,temporal}/tags`; digests via `docker buildx imagetools inspect`.
- Step 3 re-observation (2026-10-29, implementation host): `docker buildx imagetools inspect` for the five refs in §2; `docker run --rm` of the pinned `temporalio/temporal` image with `--version` and `server start-dev --help`; `docker image inspect`; `docker version --format '{{.Server.Version}}'` → `29.6.1`.
- unionfs license statement: https://github.com/streamich/unionfs (README: "Unlicense - public domain").
