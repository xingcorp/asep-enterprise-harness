# Phase 4 — Research Register (LOCKED v7, pending controller confirmation)

> Research for the independent reviewer, its independence, egress and injection resistance, replayable measurement,
> and dashboards. All web sources were retrieved on **2026-10-29** in a Lane B session unless marked
> "bibliographic (not fetched)". Node 24.6.0, pnpm 10.31.0, TypeScript 7.0.2 per `phase-02-report.md` `versions`;
> `./node_modules/.bin/tsc --version` printed `Version 7.0.2` in this session. Root `package.json` requires
> Node ≥ 24.

## 1. Reviewer API: OpenAI Responses API (behind the reviewer port)

Source: OpenAI API reference, "Create a model response",
`https://developers.openai.com/api/reference/resources/responses/methods/create` (through Context7 library
`/websites/developers_openai_api_reference`). REST API version reported by the `openai-version` response header:
`2020-10-01` (OpenAI API reference, "Debugging requests").

| Item | What the documentation says | Plan consequence |
|---|---|---|
| Endpoint | `POST /v1/responses` | adapter calls `{baseUrl}/responses` |
| `store` | "Defaults to true when omitted. If set to true, response data will be stored for at least 30 days" | always send `store: false`; no remote state to reconcile (plan §16 I4) |
| `truncation` | `disabled` (default): input over the context window fails with a 400 error | send `disabled`; classify the 400 as `CONTEXT_OVERFLOW` |
| `reasoning.effort` | `none, minimal, low, medium, high, xhigh, max`; not every model supports every value | pinned per reviewer config; comparator value kept only if the probe accepts it |
| `temperature` / `top_p` | model guidance: "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`" (`https://developers.openai.com/api/docs/guides/model-guidance`) | not sent; determinism unavailable → record/replay |
| seed | not found in the Responses create reference | not used |
| `service_tier` | `auto, default, flex, scale, priority, fast, ultrafast`; "This tier is currently available for `gpt-5.6-sol`" | pinned when configured; served tier recorded |
| `text.format` | `json_schema` with `strict: true` enables Structured Outputs | strict schema for the model-facing output |
| `previous_response_id`, `conversation` | carry prior context | never sent |
| response `status` | `completed, failed, in_progress, cancelled, queued, incomplete` | only `completed` can be `COMPLETED` |
| `incomplete_details.reason` | `max_output_tokens, max_messages, content_filter, steered` | → `INCOMPLETE`, fail closed |
| `usage` | input, cached input, output, reasoning, total tokens | mapped to `ReviewerUsage` |
| `model` (response) | the model used | recorded as `servedModel`; drift fails the review |

Structured Outputs (`https://developers.openai.com/api/docs/guides/structured-outputs`): strict mode adheres to the
schema, but refusals appear as a `refusal` content item and incomplete output may not validate; strict mode supports
a subset of JSON Schema with all properties required and `additionalProperties: false`. The harness re-validates
with AJV and grounds every citation; provider adherence is never trusted alone.

Rate limits (`https://developers.openai.com/api/docs/guides/rate-limits`): `Retry-After` may be present on 429 and
503; otherwise exponential backoff with jitter, bounded attempts and time, no nested retry loops, no retry of
quota/billing errors; log `x-request-id`.

**Gateway.** The environment provides an OpenAI-compatible gateway (kiro-proxy, operated by the controller on a private
network; its address is deliberately not recorded in the repository) serving `gpt-6.1-sol` (the controller's current Codex review model and Phase 4's primary candidate),
`gpt-5.6-sol` (the corpus labeller), `deepseek-v4-pro`, `qwen3.8-max` and `grok-4.6` (controller statement).

**Verified gateway behaviour (controller, 2026-10-29; Lane B did not contact the gateway):** on every request, for
both `/v1/responses` and `/v1/chat/completions`, the gateway appends roughly 330 tokens of extra instructions (a
terse "caveman" writing style) to the request's `instructions` and adds roughly 300 tokens of tools. Evidence is in
the response: the returned `instructions` field contains the caller's instructions followed by the injected text,
and `usage.attribution.request_fields` reports `tools` and `instructions` token counts the caller never sent.
Consequences: the served prompt is not the harness prompt; replay determinism and independence claims hold only "via
this gateway"; the adapter detects and records alteration per call from those two response fields (exit G10); the
measurement verdict names the gateway (plan §23).

**Still not probed by the lane** (no credential; lane rules), for both reviewers: support for the Responses API,
`store`, `truncation`, strict `text.format`, `reasoning.effort`, `service_tier`, and whether `usage`, `model` and
`x-request-id` are returned. The S10 probe records the answers and confirms alteration detection live. A parameter
the gateway rejects or ignores is never dropped silently; the adapter fails closed and the gap is adjudicated.

## 2. Prompt-injection resistance

| Source | Date | Use in the plan |
|---|---|---|
| OWASP Top 10 for LLM Applications, LLM01:2025 Prompt Injection, `https://genai.owasp.org/llmrisk/llm01-prompt-injection/` | 2025 edition | constrain behaviour, validate output formats, least privilege, human approval for high-risk actions, segregate external content, adversarial testing |
| OpenAI, "Agent builder safety", `https://developers.openai.com/api/docs/guides/agent-builder-safety` | retrieved 2026-10-29 | no untrusted variables in developer messages; structured outputs between nodes; isolation reduces but does not remove the risk |
| Hines et al., "Defending Against Indirect Prompt Injection Attacks With Spotlighting", arXiv:2403.14720 | 2024-03-20 | delimiting, datamarking, encoding; reported attack success falling from above 50% to below 2% in their experiments — evidence, not a guarantee |
| Wallace et al., "The Instruction Hierarchy", arXiv:2404.13208 | 2024-04-19 | rubric in `instructions`, data in user input |
| Boucher & Anderson, "Trojan Source: Invisible Vulnerabilities", arXiv:2111.00169 | v1 2021-10-30 | deterministic bidi/invisible-Unicode check |

Design conclusion: the primary defence is architectural — in Phase 4 production the model cannot change the
workflow at all (shadow), and in any mode deterministic checks and humans hold authority. Spotlighting and strict
outputs are measured secondary layers (exit D6).

## 3. Independence, correlation and determinism

| Source | Date | Use |
|---|---|---|
| Kim, Garg, Peng, Garg, "Correlated Errors in Large Language Models", arXiv:2506.07962 | 2025-06-09 | models "agree 60% of the time when both models err" on one leaderboard dataset (retrieved in the planning session); shared providers/architectures raise correlation → a different-family comparator reduces but does not remove correlated misses; measure, do not assume |
| Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations", arXiv:2404.13076 | 2024-04-15 | self-preference → reviewer family ≠ implementer family; same-model labels bias measurement (plan §7.2 item 2) |

Determinism: unavailable from the provider for reasoning models (§1). Replayability = canonical request bytes +
recorded response bytes + pure scoring.

## 4. Measurement methodology

| Source | Date | Use |
|---|---|---|
| Defects4J, `https://github.com/rjust/defects4j`; Just, Jalali, Ernst, ISSTA 2014 | README retrieved 2026-10-29 | buggy/fixed version pairs → corpus items pair a reviewed tree with a post-fix tree (post-fix negatives); our fixes are not minimised, which the item records |
| Brown, Cai, DasGupta, "Interval Estimation for a Binomial Proportion", Statistical Science 16(2), 2001 | bibliographic (not fetched) | Wilson score interval for small-n proportions |

Protocol choices (frozen in the controller-approved preregistration): unit = defect instance; primary metrics on
first-occurrence instances; deterministic matcher (path equality, line overlap within ±10 lines, category
compatibility table) with strict and lenient variants; k = 3 on reporting items for both reviewers; precision only
over human-adjudicated findings; descriptive-only below n = 20 (D-7); floors in plan §7.4, reported not gating.

## 5. Tooling

| Item | Source | Fact | Decision |
|---|---|---|---|
| Node global `fetch` | `https://nodejs.org/api/globals.html` | stable ("No longer experimental") since v21.0.0 | built-in `fetch` in the adapter; no HTTP client dependency |
| Node test reporters | `https://nodejs.org/api/test.html` ("Test reporters") | built-ins `spec, tap, dot, junit, lcov`; "The `--test-reporter` flag can be specified multiple times … it is required to specify a destination for each reporter using `--test-reporter-destination` … Reporters and destinations are paired according to the order they were specified." The version that added `junit` was not shown in the fetched excerpt (not verified) | SR-T3: keep the stdout reporter, add `junit` to a temp file, pair destinations in order — in both the canonical runner and the integration runner, which also spawns `node --import tsx --test <files>` (`scripts/integration/run-integration.mjs:166`) |
| SARIF 2.1.0 | `https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html` — Plus Errata 01, OASIS Standard, 2023-08-28 | `runs[].results[]` with `ruleId`, `level`, `message`, `locations[].physicalLocation.region` | v7 (R37): not parsed in Phase 4; each log is one `sarif-unparsed` finding (DF-10) |
| SARIF 2.1.0 effective execution (R28; v6: input to DF-9 only, scanner-recheck closure deferred by R32) | `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`, retrieved **2026-10-30** (the HTML specification page was truncated by the fetch tool, so the schema's property descriptions are the source) | `reportingConfiguration.enabled`: "Specifies whether the report may be produced during the scan.", default `true`; `reportingDescriptor.defaultConfiguration`; `invocation.ruleConfigurationOverrides[]` of `configurationOverride` (`descriptor`: a `reportingDescriptorReference`; `configuration`: "how the rule or notification was configured during the scan"); `invocation.toolExecutionNotifications[]` ("runtime conditions detected by the tool during the analysis") and `toolConfigurationNotifications[]`, each `notification` with `associatedRule` and `level` (`none`, `note`, `warning`, `error`; default `warning`); `invocation.executionSuccessful` is required; `run.artifacts[]` with `location` and `roles` (enum includes `analysisTarget`); `reportingDescriptorReference` has `id`, `index` (default `-1`), `guid`, `toolComponent`; `toolComponent.version` and `semanticVersion` | a declared rule proves nothing: the rule counts as run only when its default and every override leave it enabled and no notification is associated with it; a reference into another tool component, or an `error` notification that names no rule, leaves no rule proven; coverage is the finding's file among the artifacts whose `roles`, when present, include `analysisTarget`; a structural error (a non-boolean `enabled`, an index out of range) is malformed and fails closed |
| SARIF 2.1.0 effective level and message references (R37, input to DF-10 only) | `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html`, retrieved **2026-10-30** with `curl` into a scratch directory and read as text (the fetch tool truncates the page) | §3.11.2: "At least one of the text (§3.11.8) or id (§3.11.10) properties SHALL be present."; §3.27.10: "If kind has the value "fail" and level is absent, then level SHALL be determined by the following procedure" (the rule's configuration overrides, then its default configuration), and for any other `kind` an absent level "SHALL default to "none""; §3.27.5: `ruleId` is "a hierarchical string … whose leading components specify the stable identifier of the rule", and "If ruleId and rule.id are both present, they SHALL be equal." | a result may carry `message.id` instead of `message.text`, and an omitted `level` is not `warning`; both are DF-10 entry criteria, which is why v7 does not parse SARIF |
| SARIF 2.1.0 references (R32; v7: input to DF-10 only) | `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`, retrieved **2026-10-30** | `result.ruleId`: "The stable, unique identifier of the rule, if any, to which this result is relevant."; `result.ruleIndex`: "The index within the tool component rules array of the rule object associated with this result.", default `-1`, minimum `-1`; `result.rule`: "A reference used to locate the rule descriptor relevant to this result." (a `reportingDescriptorReference`: `id`, `index`, `guid`, `toolComponent`); `artifactLocation.uriBaseId`: "indirectly specifies the absolute URI with respect to which a relative URI in the \"uri\" property is interpreted"; `artifactLocation.index`: "The index within the run artifacts array of the artifact object associated with the artifact location.", default `-1`; `run.originalUriBaseIds`: "The artifact location specified by each uriBaseId symbol on the machine where the tool originally ran."; `tool.extensions`: "Tool extensions that contributed to or reconfigured the analysis tool that was run." | an index of `-1` means absent; the rule of a result is the one id every present form names against `tool.driver.rules`, and its file the repository path of the location's `uri` or of `run.artifacts[index].location`; a `toolComponent` reference (it may point into `tool.extensions`), a guid-only rule, an index outside its array, disagreeing forms, any `uriBaseId` (no base is bound to the repaired tree in Phase 4) and a non-repository URI flag the result `unresolved-reference` instead of dropping it |
| Grafana provisioning | `https://grafana.com/docs/grafana/latest/administration/provisioning/` (12.x content) | data sources and dashboard providers from `provisioning/` | provision from `deploy/grafana/provisioning` |
| Grafana HTTP API | `https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/other/`; `…/api-legacy/data_source/` | `GET /api/health` (response fields `commit`, `database`, `version`); `GET /api/datasources/uid/:uid`; `POST /api/ds/query` with `queries[]` (`datasource.uid`, `refId`), `from`, `to`. The index page notes the docs now describe Grafana 13 and that `/api` moves to `/apis` starting in Grafana 13 | exit J4 uses these on the pinned 12.x image; the dashboard-by-uid (`/api/dashboards/uid/:uid`) and search (`/api/search`) paths were **not fetched** and are confirmed against the 12.x reference in S18 |
| Grafana image | `compose.yaml:94` | `grafana/grafana:12.0.2` by tag, not digest | S18 pins a digest and records pull/inspect output; digest **not verified** in this session |
| PGlite | `adapters/persistence/node_modules/@electric-sql/pglite/package.json` | version `0.5.4`; Lane B scratch run applied the §3 DDL incl. `plpgsql` triggers (data model §3.5) | fast suites run the same migrations |

## 6. Dependency decisions

**No new third-party dependency.**

- **Not the `openai` npm SDK:** the adapter must persist exact request/response bytes before parsing (ADR 0009),
  control retries itself, and talk to an OpenAI-compatible gateway with unverified feature coverage. A thin `fetch`
  client gives byte-level control without transitive supply-chain surface. If the controller prefers the SDK, it
  must be pinned exactly and confined to `adapters/reviewer-openai`.
- **Validation:** `ajv` 8.20.0 / `ajv-formats` 3.0.1 already pinned in `packages/contracts/package.json`.
- **YAML:** `yaml` 2.9.0 already used by `@asep/contracts` and `@asep/evals`.
- **Test HTTP server:** `node:http` in adapter tests only.

## 7. Comparator selection (D-4, user decision: mandatory)

| Candidate | Family | Differs from implementer (`anthropic-claude`), labeller `gpt-5.6-sol` and primary candidate `gpt-6.1-sol` (all `openai-gpt`) | Re-runnable outside the gateway | Probed |
|---|---|---|---|---|
| `deepseek-v4-pro` | deepseek | yes | DeepSeek has historically published open weights for its flagship line; for this model **not verified** | no |
| `qwen3.8-max` | alibaba-qwen | yes | "max" tiers have historically been API-only; **not verified** | no |
| `grok-4.6` | xai-grok | yes | not known to have open weights; **not verified** | no |

Choice: `deepseek-v4-pro`, fallback order `qwen3.8-max`, `grok-4.6` (plan §7.6). The model-capability statements
above are general history, not facts about these specific versions.

## 8. Open questions (answered by S10 probe, S18 or the controller)

1. Gateway behaviour for both reviewers (§1). (S10)
2. Effective context window and output limit behind the gateway → default `packetBudgetBytes` (proposal 400 000)
   and `maxOutputTokens`. Not verified.
3. Published prices for both models on the gateway; until configured with source and date, cost is reported as
   uncovered. Not verified.
4. Datamarking vs base64 encoding for diffs — measured by the injection suite.
5. ~~Whether the gateway alters prompts~~ — answered: it does (controller-verified, §1); open is only whether the appended text changes over time, which the per-call appendix hash tracks.
6. The Grafana 12.x image digest and the dashboard-by-uid path on 12.x. (S18)
