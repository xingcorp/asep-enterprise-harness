# Phase 6 — Research Register (DRAFT v1)

> Every external fact the Phase 6 plan relies on, with its source, the exact version where one exists, and the date it
> was observed. All entries were observed on **2026-10-31** by lane `phase-06` with `WebFetch` (page text or the
> GitHub, npm and PyPI JSON APIs). The `WebSearch` tool returned `API Error: 400` for every query in this step, so
> sources were fetched by URL; a fact that could not be fetched is marked **not verified**. Nothing was downloaded or
> installed (lane-contract addendum 2026-10-30). Some pages allow paraphrase only; those entries paraphrase and say so.

## 1. Spec Kit (optional importer, plan §14)

| Fact | Source | Observed |
|---|---|---|
| Latest release `v1.2.5` ("Spec Kit - 1.2.5"), published 2026-10-28T19:27:43Z | `https://api.github.com/repos/github/spec-kit/releases/latest` | 2026-10-31 |
| `specify init` creates `.specify/` (constitution, templates, extension state) and one `specs/NNN-feature-name/` folder per feature holding `spec.md`, `plan.md`, `tasks.md` and other files; the README does not list every file | `https://github.com/github/spec-kit/blob/main/README.md` | 2026-10-31 |
| Commands are agent slash commands with hyphens (`/speckit-constitution`, `/speckit-specify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`, …), not dotted names | same README | 2026-10-31 |

Use: the importer reads `specs/*/spec.md`, `plan.md`, `tasks.md` as untrusted text into a draft ProductSpec. It runs no
Spec Kit command and needs no install. The full file list of a feature folder is **not verified**; the importer
ignores unknown files and records them.

## 2. OpenHands (deferred, plan §3.2)

| Fact | Source | Observed |
|---|---|---|
| GitHub latest release `v1.34.0`, published 2026-10-27T14:35:23Z | `https://api.github.com/repos/OpenHands/OpenHands/releases/latest` | 2026-10-31 |
| PyPI `openhands-ai` `info.version` `1.11.0`; `requires_python` `<3.14,>=3.12`; `license_expression` `MIT`; project URLs point to `github.com/OpenHands/OpenHands` | `https://pypi.org/pypi/openhands-ai/json` | 2026-10-31 |

The GitHub release line (`1.34.0`) and the PyPI package version (`1.11.0`) do not match, so "which version is the
adapter pinned to" has no single answer from the registries; the upload time of PyPI `1.11.0` is **not verified**
(truncated response). With the Python 3.12 runtime and the no-download rule this supports the deferral.

## 3. Alerting on SLOs (plan §11, architecture §13)

Source: Google SRE Workbook, "Alerting on SLOs", `https://sre.google/workbook/alerting-on-slos/`, observed 2026-10-31.
The page allows paraphrase only.

| Alert | Budget consumed | Long window | Short window | Burn rate |
|---|---|---|---|---|
| page | 2% | 1 h | 5 min | 14.4 |
| page | 5% | 6 h | 30 min | 6 |
| ticket | 10% | 3 days | 6 h | 1 |

- The short window is about one twelfth of the long one; it confirms the burn is still happening and lets the alert
  reset soon after errors stop.
- Low-traffic services make single failures look like huge burn rates. The chapter's remedies: synthetic traffic,
  combining services, client retries, or a lower SLO or a longer window. Phase 6 applies the last two: a minimum
  event count below which a bad event yields `ticket`, and zero-tolerance SLOs as invariant checks instead of ratios.

## 4. Canarying releases (plan §10)

Source: Google SRE Workbook, "Canarying Releases", `https://sre.google/workbook/canarying-releases/`, observed
2026-10-31. Paraphrase only.

- A canary deploys the change to a subset of production; the rest is the control. It is in effect an A/B test.
- Compare canary against control, not against the whole population: aggregate metrics hide a canary's errors (the
  page's example: a 20% error rate on a 5% canary shows as about 1% overall).
- Size and duration must be representative; for non-interactive systems the canary must span at least one unit of
  work; run one canary at a time; metric intervals no longer than the canary.
- When canary and control diverge, stop and roll back or escalate to a human.

Use: separate pools per release, per-cohort reporting, one candidate at a time, absolute guardrails that roll back,
relative comparisons reported only (the pilot's volume is far below a representative canary).

## 5. PostgreSQL row security (plan §9.1, architecture §10)

Source: PostgreSQL 17 documentation, "Row Security Policies", `https://www.postgresql.org/docs/17/ddl-rowsecurity.html`,
observed 2026-10-31. Quoted:

- "Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system when accessing a table."
- "Table owners normally bypass row security as well, though a table owner can choose to be subject to row security
  with ALTER TABLE ... FORCE ROW LEVEL SECURITY."
- "Referential integrity checks, such as unique or primary key constraints and foreign key references, always bypass
  row security to ensure that data integrity is maintained. Care must be taken when developing schemas and row level
  policies to avoid "covert channel" leaks of information through such referential integrity checks."
- "If no policy exists for the table, a default-deny policy is used, meaning that no rows are visible or can be
  modified."

Use: forced row security on every tenant table, no application role with `SUPERUSER` or `BYPASSRLS`, the runtime role
owns nothing, the reader role writes nothing (so the covert channel needs a writer; threat T6-07). The gate's image
is `postgres:17` by digest (`scripts/integration/images.mjs:13-15`).

## 6. Grafana alerting, provisioning and versions (plan §11, risk P6R-12)

| Fact | Source | Observed |
|---|---|---|
| Alerting resources are file-provisioned from `provisioning/alerting`; every example uses `apiVersion: 1`; alert rules, contact points, notification policies, notification templates and mute timings can be provisioned; provisioned resources cannot be edited in the UI | `https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/` (the page shows no version) | 2026-10-31 |
| Latest Grafana release `v13.3.0`, published 2026-10-27T11:08:50Z | `https://api.github.com/repos/grafana/grafana/releases/latest` | 2026-10-31 |
| The repository's compose file runs `grafana/grafana:12.0.2` by tag (`compose.yaml:98`); Phase 4 pins a digest in its S18 and notes that the docs now describe Grafana 13 and that `/api` moves to `/apis` from Grafana 13 | `phase-04-research-register.md` on `phase/04-independent-assurance` (lines 105–107), read through Git | 2026-10-31 |

Use: Phase 6 provisions only through files in Lane B's carve-out and reads back through the API of the image Lane B
pins. The 12.x alerting file format was not fetched separately from the "latest" page; S12 confirms it against the
pinned image before relying on it (**not verified** for 12.0.2 here).

## 7. Prometheus (considered, not adopted)

| Fact | Source | Observed |
|---|---|---|
| Latest release `v3.15.1`, published 2026-10-21T16:15:57Z | `https://api.github.com/repos/prometheus/prometheus/releases/latest` | 2026-10-31 |
| The repository's compose file runs `prom/prometheus:v3.5.0` (`compose.yaml:91`); the OTel collector exports metrics to `debug` only (`deploy/otel/collector.yaml`) | repository | 2026-10-31 |

Decision: SLOs are evaluated from PostgreSQL (authoritative tables and Phase 4's snapshots), not from Prometheus
recording rules, because no metric reaches Prometheus today and a second copy of the formulas is what Phase 4's
"one place for formulas" rule forbids.

## 8. MinIO (gate object store, risk P6R-08)

| Fact | Source | Observed |
|---|---|---|
| `minio/minio`: `archived: true`; `pushed_at` 2026-04-24T17:54:39Z; licence `AGPL-3.0` | `https://api.github.com/repos/minio/minio` | 2026-10-31 |
| The gate pins `RELEASE.2025-04-22T22-12-26Z` by digest | `compose.yaml:52-54`, `scripts/integration/images.mjs:16-18` | 2026-10-31 |

The GitHub API does not expose the archive date; the last push is the closest observed fact. Whether the pinned digest
stays pullable was **not verified** (no pull in this step).

## 9. S3 Object Lock (considered for retention; not adopted)

Source: `https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html`, observed 2026-10-31.

- Object Lock is WORM per object version, with retention periods (fixed or variable with an event hold) and legal
  holds; a legal hold has no expiry and stays until removed.
- Compliance mode: no user, including the root user, can overwrite or delete a protected version or shorten its
  retention. Governance mode: users with `s3:BypassGovernanceRetention` and the bypass header can.
- Object Lock works only in buckets with S3 Versioning enabled; a simple `DELETE` on a protected object adds a delete
  marker, a versioned `DELETE` gets `403`.

Decision: not used. The pilot's store is a filesystem directory, the gate's MinIO is archived, and Phase 6's holds and
tombstones are database rules that work on both stores. Object Lock is the store-enforced form to adopt with a
maintained S3 target (plan §3.3).

## 10. S3 prefix-scoped policies (considered; deferred)

Source: `https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html`, observed 2026-10-31
(first part of the page only; the response was too long to read whole). Bucket policies grant or deny on object ARNs
with wildcards, so access can be limited to a key prefix. Use: the shape of per-tenant store credentials when
store-enforced isolation is picked up (plan §3.3); Phase 6 adds no such claim.

## 11. GitHub App installation tokens (plan §8.3)

Source: `https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app`,
observed 2026-10-31. Quoted: "The installation access token will expire after 1 hour." The request may narrow
`repositories`/`repository_ids` (up to 500) and `permissions`; a token never exceeds the App's grants.

Use: the credential policy records the one-hour lifetime; the kill switch stops new mints and cannot revoke a token
already minted before it expires, which the runbook states. The code requests `metadata: read`, `contents: write`,
`pull_requests: write` (`adapters/github-app/src/credential-provider.ts:30-34`).

## 12. Vault leases (considered; not adopted)

Source: `https://developer.hashicorp.com/vault/docs/concepts/lease`, observed 2026-10-31 (paraphrase). Dynamic secrets
carry a lease with an id and a TTL; leases are renewed or revoked; revoking a token revokes its child leases;
`vault lease revoke -prefix <path>` revokes everything under a path, intended for intrusions; KV secrets have no
leases.

Decision: not adopted (a new service and a new dependency). Prefix revocation is the model for the scoped kill switch
(platform, organization, project).

## 13. Anthropic sandbox-runtime (considered for the fetch sandbox; not adopted)

| Fact | Source | Observed |
|---|---|---|
| npm `@anthropic-ai/sandbox-runtime` `0.0.81`, licence `Apache-2.0`, repository `github.com/anthropics/sandbox-runtime` | `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/latest` | 2026-10-31 |
| macOS uses a generated `sandbox-exec` profile; Linux uses bubblewrap with the network namespace removed and traffic through host proxies; network is default-deny with `allowedDomains`/`deniedDomains`; an allowed host name that resolves to a loopback, link-local, metadata or private address is refused; it is a beta research preview | `https://github.com/anthropics/sandbox-runtime` (README) | 2026-10-31 |

Decision: not adopted (a new dependency, a beta, and Phase 2 already isolates with Docker). Phase 6's registry proxy
takes over its resolved-address check (plan §8.2).

## 14. OpenSSF Scorecard (scoring model, plan §7)

| Fact | Source | Observed |
|---|---|---|
| Latest release `v5.6.0`, published 2026-10-12T00:21:01Z | `https://api.github.com/repos/ossf/scorecard/releases/latest` | 2026-10-31 |
| Each check scores 0–10; the aggregate is a risk-weighted average with weights Critical 10, High 7.5, Medium 5, Low 2.5 | `https://github.com/ossf/scorecard/blob/main/README.md` ("Scoring") | 2026-10-31 |

Use: the readiness score copies the shape (per-check 0–10, weighted average) and says, as Scorecard does not need to,
that the weights are uncalibrated policy for this harness.

## 15. Characterization tests (plan §6)

Source: `https://en.wikipedia.org/wiki/Characterization_test`, observed 2026-10-31. A characterization test records
what existing code does so that a later change in that behaviour is detected; the term is Michael Feathers', from
*Working Effectively with Legacy Code* (2004). Use: the characterization task kind; Phase 6 claims stability (K
repeats) and scope, not that the recorded behaviour is correct (risk P6R-11).

## 16. Factory "agent readiness" (comparison for the readiness dimensions)

Source: `https://docs.factory.com/web/agent-readiness/overview` (redirected from `docs.factory.ai`), observed
2026-10-31. Nine pillars (style and validation, build system, testing, documentation, development environment,
debugging and observability, security, task discovery, product and experimentation) and five levels (functional,
documented, standardized, optimized, autonomous); a level unlocks at 80% of the previous level's criteria;
repository-scope and application-scope criteria.

Use: a cross-check, not a source of weights. Phase 6's ten dimensions come from `brownfield-onboarding.md`. Most
Factory pillars map to one of them (build system, testing, documentation, observability; CODEOWNERS under ownership);
"task discovery" and "product and experimentation" have no counterpart, and Phase 6 adds neither because they do not
bear on whether an agent's change can be verified.

## 17. Compose secrets (pilot deployment, plan §13)

Source: `https://docs.docker.com/compose/how-tos/use-secrets/`, observed 2026-10-31. Secrets are mounted as files at
`/run/secrets/<secret_name>`, not as environment variables; images that support it read a `*_FILE` variable naming
the file. The top-level `secrets` element takes `file:` (bind-mounted host file) or `environment:` (host variable;
the page shows it for build secrets).

Use: the pilot recipe passes every credential as a `file:` secret and never as an environment value.

## Open questions and decision rules

| Question | Decision rule |
|---|---|
| Does Grafana 12.0.2 accept the alerting file format of the "latest" docs? | S12 provisions on the image Lane B pins and reads the rules back; if the format differs, follow the pinned version's docs and record them here |
| Should the gate move off the archived MinIO? | Not in Phase 6 (it is Phase 2's gate backend). If a pull of the pinned digest fails, the controller decides on a replacement; Phase 6's retention itest then runs on whatever S3 target the gate uses |
| OpenHands version to pin, if the trial is ever picked up | Pin by PyPI version and wheel hash, and record the GitHub tag it corresponds to; a mismatch blocks the pin |
| Do readiness weights predict outcomes? | Unknown; calibration needs outcome history (plan §3.3) |
