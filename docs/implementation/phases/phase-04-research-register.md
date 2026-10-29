# Phase 4 — Research Register (DRAFT v1)

> Research for the independent reviewer, its independence and injection resistance, replayable measurement,
> and dashboards. All web sources below were retrieved on **2026-10-29** in this session unless marked
> "bibliographic (not fetched)". Node 24.6.0, pnpm 10.31.0, TypeScript 7.0.2 per `phase-02-report.md`
> `versions`; root `package.json` requires Node ≥ 24.

## 1. Reviewer API: OpenAI Responses API (behind the reviewer port)

Source: OpenAI API reference, "Create a model response", `https://developers.openai.com/api/reference/resources/responses/methods/create`
(retrieved through Context7 library `/websites/developers_openai_api_reference`, 2026-10-29). REST API version
reported by the `openai-version` response header: `2020-10-01` (OpenAI API reference, "Debugging requests",
`https://developers.openai.com/api/docs/api-reference/administration`).

| Item | What the documentation says | Plan consequence |
|---|---|---|
| Endpoint | `POST /v1/responses` | adapter calls `{baseUrl}/responses` |
| `store` | "Defaults to true when omitted. If set to true, response data will be stored for at least 30 days" | always send `store: false` (no provider-side retention, no shared state) |
| `truncation` | `disabled` (default): input over the context window fails with a 400 error; `auto` drops items from the beginning | send `disabled` explicitly; classify the 400 as `CONTEXT_OVERFLOW` → ESCALATE |
| `reasoning.effort` | `none, minimal, low, medium, high, xhigh, max`; not every model supports every value | pinned per reviewer config |
| `temperature` / `top_p` | exist on create; model guidance: "When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`" (`https://developers.openai.com/api/docs/guides/model-guidance`) | not sent; determinism is not available → record/replay (§3) |
| seed | appears in Evals/grader sampling parameters; **not** found in the Responses create reference | not used; plan does not rely on a seed |
| `service_tier` | `auto, default, flex, scale, priority, fast, ultrafast`; "This tier is currently available for `gpt-5.6-sol`"; the response reports the tier actually used | pinned when configured; served tier recorded |
| `text.format` | `json_schema` with `strict: true` enables Structured Outputs | strict schema for the model-facing output |
| `previous_response_id`, `conversation` | carry prior context into a response | never sent (fresh context, ADR 0010) |
| `background` | default `false` | not used |
| `include: reasoning.encrypted_content` | needed only for stateless multi-turn reasoning | not used (single turn) |
| response `status` | `completed, failed, in_progress, cancelled, queued, incomplete` | only `completed` can be `COMPLETED` |
| `incomplete_details.reason` | `max_output_tokens, max_messages, content_filter, steered` | → `INCOMPLETE`, fail closed |
| `error.code` | includes `server_error`, `rate_limit_exceeded`, `invalid_prompt`, … | classified; bounded detail recorded |
| `usage` | `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens` | mapped to `ReviewerUsage` |
| `model` (response) | the model used | recorded as `servedModel`; drift detected |

Structured Outputs (`https://developers.openai.com/api/docs/guides/structured-outputs`): strict mode
"ensures the model will always generate responses that adhere to your supplied JSON Schema", but the model
"might not generate a valid response" on refusal or incomplete output; refusals appear as a `refusal` content
item; only a subset of JSON Schema is supported in strict mode and every example lists all properties as
required with `additionalProperties: false`, using nullable types for optional values. Consequence: the
model-facing schema follows that shape, and the harness re-validates with AJV and its own grounding rules —
provider-side adherence is never trusted on its own.

Rate limits (`https://developers.openai.com/api/docs/guides/rate-limits`): `Retry-After` may be present on
429 (temporary rate limit) and 503 (temporary overload); otherwise back off exponentially with jitter, limit
attempts and total time, avoid nested retry loops, and do not retry quota/billing errors. `x-ratelimit-*`
headers report remaining requests/tokens. OpenAI recommends logging `x-request-id`. Consequence: adapter retry
policy (EC G4); no SDK-level retries layered on top.

**Gateway.** The environment provides an OpenAI-compatible gateway serving `gpt-5.6-sol` over the Responses
API (task statement). It was **not probed** in this session (no credential read, lane hard rules). Whether it
honours `store`, `truncation`, strict `text.format`, `reasoning.effort`, `service_tier` and returns `usage`,
`model` and `x-request-id` is **not verified**; the S9 opt-in live smoke records the answer. If the gateway
rejects or ignores a parameter, the adapter fails closed and the gap is adjudicated in the review log — a
parameter is never dropped silently.

## 2. Prompt-injection resistance

| Source | Date | Use in the plan |
|---|---|---|
| OWASP Top 10 for LLM Applications, LLM01:2025 Prompt Injection, `https://genai.owasp.org/llmrisk/llm01-prompt-injection/` | 2025 edition | direct vs indirect injection; mitigations: constrain behaviour, "define and validate expected output formats", "least privilege", "require human approval for high-risk actions", "segregate and identify external content", adversarial testing |
| OpenAI, "Agent builder safety", `https://developers.openai.com/api/docs/guides/agent-builder-safety` | retrieved 2026-10-29 | do not put untrusted variables in developer messages; structured outputs between nodes remove free-form channels; isolation "greatly reduce[s], but don't fully remove" the risk |
| Hines et al., "Defending Against Indirect Prompt Injection Attacks With Spotlighting", arXiv:2403.14720 | 2024-03-20 | delimiting, datamarking, encoding; reported attack success falling from above 50% to below 2% in their GPT-family experiments — evidence that spotlighting helps, not a guarantee for our model or data |
| Wallace et al., "The Instruction Hierarchy", arXiv:2404.13208 | 2024-04-19 | models trained to prefer privileged instructions over lower-privileged content; supports keeping the rubric in `instructions` and data in user input |
| Boucher & Anderson, "Trojan Source: Invisible Vulnerabilities", arXiv:2111.00169 (USENIX Security 2023) | v1 2021-10-30 | bidirectional/invisible Unicode makes reviewers misread code; recommends scanning in repositories and build pipelines → deterministic check (EC D4) |

Design conclusion: no single technique is sufficient; the plan's primary defence is architectural (model
verdict is advisory; deterministic checks and humans hold authority), with spotlighting and strict outputs as
measured secondary layers (EC D5).

## 3. Independence, correlation and determinism

| Source | Date | Use |
|---|---|---|
| Kim, Garg, Peng, Garg, "Correlated Errors in Large Language Models", arXiv:2506.07962 | 2025-06-09 | models "agree 60% of the time when both models err" on one leaderboard dataset; shared providers/architectures raise correlation, and larger accurate models correlate even across providers → a different family reduces but does not remove correlated misses; measure, do not assume |
| Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations", arXiv:2404.13076 | 2024-04-15 | self-preference bias → reviewer must not share family with the coder for R2, and same-model labels bias measurement (plan §6.2 item 2) |

Determinism: not available from the provider for reasoning models (§1). Replayability is achieved by
canonical request bytes + recorded response bytes + pure scoring (plan §10).

## 4. Measurement methodology

| Source | Date | Use |
|---|---|---|
| Defects4J, `https://github.com/rjust/defects4j`; Just, Jalali, Ernst, "Defects4J: A Database of Existing Faults to Enable Controlled Testing Studies for Java Programs", ISSTA 2014 | README retrieved 2026-10-29 | real bugs as buggy/fixed version pairs isolated from one fix commit with minimised diffs → corpus items pair a reviewed tree with its fix commits; our fixes are not minimised, which the item records |
| Brown, Cai, DasGupta, "Interval Estimation for a Binomial Proportion", Statistical Science 16(2), 2001 | bibliographic (not fetched) | Wilson score interval for small-n proportions (EC I5) |

Protocol choices (pre-registered in S15, proposals here): unit = defect instance; primary metrics on
first-occurrence instances; deterministic matcher (path equality, line overlap within ±10 lines, category
compatibility table) with strict and lenient variants; k = 3 on the test split; precision only over
adjudicated findings; descriptive-only below n = 20 (decision D-7).

## 5. Tooling

| Item | Source | Fact | Decision |
|---|---|---|---|
| Node global `fetch` | `https://nodejs.org/api/globals.html` (retrieved 2026-10-29) | added v17.5.0/v16.15.0; flag removed v18.0.0; "No longer experimental" v21.0.0 | use built-in `fetch` in the adapter; no HTTP client dependency |
| SARIF 2.1.0 | `https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html` — "SARIF Version 2.1.0 Plus Errata 01", OASIS Standard incorporating Approved Errata, 2023-08-28 | `runs[].results[]` with `ruleId` (§3.27.5), `level` (§3.27.10), `message` (§3.27.11), `locations[].physicalLocation.region.startLine/endLine` (§3.29.4, §3.30.5, §3.30.7) | parse this subset only; anything else ignored; malformed → fail closed |
| Grafana provisioning | `https://grafana.com/docs/grafana/latest/administration/provisioning/` (documents 12.x) | data sources in `provisioning/datasources` (`type: postgres`, `jsonData.sslmode`, `secureJsonData.password`); dashboards via `providers` with `options.path`, `foldersFromFilesStructure`, `allowUiUpdates` | provision from `deploy/grafana/provisioning`; compose runs `grafana/grafana:12.0.2` (`compose.yaml:94`) |

## 6. Dependency decisions

**No new third-party dependency.**

- **Why not the `openai` npm SDK in the adapter:** the adapter must persist the exact canonical request and
  response bytes before parsing (ADR 0009), control retries itself without nested SDK retries (rate-limit
  guidance, §1), and talk to an OpenAI-*compatible* gateway whose feature coverage is unverified. A thin
  `fetch` client gives byte-level control with no transitive supply-chain surface. The SDK version was not
  evaluated in this session; if the controller prefers the SDK, it must be pinned exactly (Phase 2
  `phase-02-research-register.md` §1 pinning policy) and confined to `adapters/reviewer-openai`.
- **Validation:** reuse `ajv` 8.20.0 / `ajv-formats` 3.0.1 already pinned in `packages/contracts/package.json`.
- **YAML policy loading:** reuse `yaml` 2.9.0 already used by `@asep/contracts` and `@asep/evals`.
- **Test HTTP server:** `node:http` inside adapter test files only (adapters may use Node networking; the
  fitness rules forbid it only in domain/application).

## 7. Open research questions (resolved at plan lock or by the S9 live smoke)

1. Does the gateway honour `store: false`, strict `text.format`, `truncation: "disabled"`,
   `reasoning.effort`, `service_tier`, and return `usage`, `model`, `x-request-id`? (S9 live smoke)
2. What is the effective context window and output limit of `gpt-5.6-sol` behind the gateway? Determines the
   default `packetBudgetBytes` (proposal 400 000 bytes) and `maxOutputTokens`. Not verified.
3. Published price for `gpt-5.6-sol` on the gateway — required for cost; until configured with source and
   date, cost is reported as uncovered (EC J6). Not verified.
4. Datamarking vs base64 encoding for diffs: comprehension cost vs injection resistance — measured by the
   injection suite (EC D5), not decided a priori.
5. Whether a different-family comparator (D-4) is worth its cost for quantifying labeller bias.
