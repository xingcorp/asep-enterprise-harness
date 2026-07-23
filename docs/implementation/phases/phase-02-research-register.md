# Phase 2 — Research Register (LOCKED)

> Dependency and design research for Phase 2. Versions verified against the npm registry on **2026-07-23**.
> Node 24, TypeScript 7, pnpm 10.31.0, ESM (NodeNext). Final pins confirmed by the LOCKED plan; §5 records
> the Prompt-3 dispositions of the open questions. Every new dependency has an ADR-level justification here.
> Supersedes `phase-02-research-register-v1.md`.

## 1. Version snapshot (verified 2026-07-23 via `npm view <pkg> version`)

| Package | Latest | Proposed pin | Purpose | Layer (allowed only in) |
|---|---|---|---|---|
| `fastify` | 5.10.0 | exact `5.10.0` | Control-plane HTTP transport, plugin encapsulation | `apps/control-plane-api` |
| `pg` | 8.22.0 | exact `8.22.0` | PostgreSQL client + pool | `adapters/postgres` |
| `@types/pg` | 8.20.0 | exact `8.20.0` (dev) | Types for `pg` | `adapters/postgres` |
| `@aws-sdk/client-s3` | 3.1093.0 | exact `3.1093.0` | S3/MinIO object storage | `adapters/artifact-s3` |
| `@octokit/auth-app` | 8.2.0 | exact `8.2.0` | GitHub App installation-token auth | `adapters/github-app` |
| `@octokit/rest` | 22.0.1 | exact `22.0.1` | GitHub REST (PR create/update) | `adapters/github-app` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.218 | exact `0.3.218` | Claude coding provider | `adapters/agent-claude` |
| `@opentelemetry/api` | 1.9.1 | exact `1.9.1` | OTel tracing API | `packages/observability`, adapters, apps |
| `@opentelemetry/sdk-node` | 0.221.0 | exact `0.221.0` | OTel SDK wiring | `apps/*`, `workers/*` (composition roots) |
| `ajv` | 8.20.0 | (already in Phase 1) | Reused for env/config validation | existing |

> **Pinning policy (disp. P2-PLAN-MED-008): pin EXACT for every direct dependency** — no caret. The Phase 1 risk
> register and repo convention require exact pins; carets are inconsistent with that and weaken supply-chain
> reproducibility. `--frozen-lockfile` from a clean checkout is asserted in CI, and a manifest test asserts no
> `^`/`~` range on any direct Phase 2 dependency. Claude Agent SDK is `0.x` and moves fast (0.3.216 → 0.3.218 within
> days) — exact pin + a fake-executable contract test gate upgrades. AWS SDK publishes multiple times/day but is pinned
> exact too; upgrades are deliberate, not implicit.

## 2. Per-dependency justification (why needed; why stdlib/existing insufficient)

### fastify 5.10.0 — Control-plane transport
- **Why:** replace raw `node:http` router in `apps/control-plane-api/src/index.ts`. Need typed routes, schema
  validation hooks, plugin encapsulation for modular boundaries, lifecycle hooks for auth/audit.
- **Why not stdlib:** `node:http` gives no routing, validation, or encapsulation; hand-rolling these is more code and
  less tested than a mature framework. Fastify's plugin model maps to the modular-monolith module boundaries and lets
  Phase-later extraction into services happen without domain coupling.
- **Compatibility:** Node 24 supported; TS types first-class. **Confined to the control-plane app only** (forbidden-imports fitness).
- **License:** MIT (permissive; matches Phase 1 allowlist Apache-2.0/BSD-3-Clause/ISC/MIT).

### pg 8.22.0 — PostgreSQL client
- **Why:** operational state (organizations…idempotency_records). Need pool + explicit transaction control.
- **Why not stdlib/ORM:** Node has no PG client. An ORM would leak DB objects into domain and obscure migrations —
  the plan forbids ORM without an ADR. `pg` is the minimal authoritative driver; SQL stays explicit and reviewable.
- **Transaction rule (verified):** one checked-out client from `BEGIN`→`COMMIT/ROLLBACK`; never issue transaction
  statements through separate `pool.query` calls (node-postgres pooling guidance).
- **License:** MIT.

### @aws-sdk/client-s3 3.1093.0 — Object storage
- **Why:** immutable content-addressed artifacts to MinIO (local) and S3 (prod parity). `PutObjectCommand`,
  `GetObjectCommand`, `HeadObjectCommand`; supports `AbortSignal` cancellation and streaming.
- **Why not stdlib:** no native S3 client. MinIO speaks the S3 API, so one adapter covers both.
- **Confined to** `adapters/artifact-s3`; filesystem adapter (no dep) is default for tests.
- **License:** Apache-2.0.

### @octokit/auth-app 8.2.0 + @octokit/rest 22.0.1 — GitHub App
- **Why:** GitHub App installation-token auth (`createAppAuth`) + REST for branch push/PR upsert. Installation tokens
  expire ~1h, scope to a repo, and support least-privilege permission subsetting at mint time.
- **Why not raw fetch:** token minting (JWT signing with the app private key, installation-token exchange, refresh)
  and rate-limit handling are non-trivial and security-sensitive; the official libraries are the safer path.
- **Security:** private key held by controller/credential provider, never in the workspace/log/artifact; token treated
  as **opaque** (GitHub token format is not fixed-length). Confined to `adapters/github-app`.
- **License:** MIT.

### @anthropic-ai/claude-agent-sdk 0.3.218 — Claude coding provider
- **Why:** one real implementer behind `CodingAgentProvider`. Provides structured JSON/stream events, allowed/disallowed
  tools, max turns, permission mode, cancellation, session resume — the primitives the plan requires instead of parsing
  terminal prose. (Claude Code CLI is the fallback integration if the SDK proves unsuitable; decide in LOCKED plan.)
- **Why not raw API (`@anthropic-ai/sdk`):** the low-level API client would require reimplementing the agent loop,
  tool orchestration, and permission gating. The Agent SDK encapsulates that. Note these are **different packages** —
  do not confuse `@anthropic-ai/claude-agent-sdk` with `@anthropic-ai/sdk`.
- **Confined to** `adapters/agent-claude`; a **fake executable/provider** drives all CI tests; live test opt-in only.
- **License:** verify at pin time (Anthropic SDKs historically MIT) — record in license inventory before adopting.

### @opentelemetry/api 1.9.1 + @opentelemetry/sdk-node 0.221.0 — Observability
- **Why:** the required spans (task.execute…forge.pull_request) with org/project/run/task/attempt attributes.
- **Why not console sink:** Phase 1's `ConsoleTelemetrySink` is fine as a fallback, but Phase 2 needs real spans and the
  existing compose stack already runs an OTel collector + Jaeger. API vs SDK split: domain/observability may depend on
  the **API** only; the **SDK** (exporters, wiring) lives in composition roots.
- **GenAI content caution (verified):** OTel GenAI semconv warns event content can contain source/PII/secrets; full
  content capture is **off by default**, opt-in with redaction.
- **License:** Apache-2.0.

## 3. Open research questions for the LOCKED plan

1. **Claude integration surface:** Agent SDK (`@anthropic-ai/claude-agent-sdk`) vs Claude Code CLI subprocess. SDK gives
   typed events in-process; CLI gives strong process isolation and an easy fake-executable test seam. Recommendation:
   decide by which gives a cleaner `shell:false`, cancellable, sanitized-env boundary. Record decision as an ADR.
2. **ID strategy:** UUIDv7 vs ULID for primary keys (both time-ordered). Pick one, document, apply everywhere.
3. **Migration tooling:** hand-rolled SQL runner with checksums (no dep) vs a minimal library. Prefer no-dep to keep the
   forbidden-imports surface small unless a library earns its place.
4. **Sandbox enforcement on the pilot host:** confirm rootless Docker + `--network none` is actually enforceable in the
   target dev/pilot environment; if not, label the adapter pilot-only and record the gap (no false isolation claim).
5. **Webhook scope:** whether Phase 2 implements inbound GitHub webhooks (HMAC + dedup) or defers them; if deferred,
   remove H3 from exit MUST and record the deferral.

## 4. Sources (verified 2026-07-23)

- Fastify TypeScript / plugin encapsulation — https://fastify.dev/docs/latest/Reference/TypeScript/ ; version https://www.npmjs.com/package/fastify
- node-postgres pooling & transactions — https://node-postgres.com/features/pooling
- AWS SDK v3 S3 examples — https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html
- GitHub App installation tokens — https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- GitHub App best practices — https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
- git worktree — https://git-scm.com/docs/git-worktree.html
- Node child_process (execFile/spawn, timeout, AbortSignal) — https://nodejs.org/api/child_process.html
- Docker rootless / network none / limits — https://docs.docker.com/engine/security/rootless/
- Claude Code CLI usage — https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Claude Agent SDK releases — https://github.com/anthropics/claude-agent-sdk-typescript/releases
- OTel GenAI semconv (content redaction) — https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
