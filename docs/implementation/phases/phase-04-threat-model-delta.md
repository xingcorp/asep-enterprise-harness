# Phase 4 — Threat Model Delta (DRAFT v1)

> Delta over `docs/operations/security-threat-model.md` and `phase-02-threat-model-delta.md`. Phase 4 adds
> the first **external model call made by the trusted harness about untrusted content**, a second credential
> class, persisted review authority and a measurement corpus. Base `00a6889`. Draft; not locked.

## 1. New trust boundaries

```text
[Trusted harness]
   │ builds packet (whitelist)            ┌──────────────────────────────┐
   ├────────────── request (data) ───────▶│ Reviewer gateway (external)  │
   │◀───────────── response (untrusted) ──│ OpenAI-compatible, HTTPS     │
   │                                      └──────────────────────────────┘
   │ validate → ground → adjudicate (pure, deterministic)
   ├──▶ review tables / run_events / metric_snapshots (PostgreSQL, operational projection)
   ├──▶ RepairOrder → next coder attempt (untrusted again)
   └──▶ PR review section → human reviewer
[Benchmark tooling] reads git history → packets → recorded responses → scorecard (offline)
```

The diff, the repository content, the coder's output, the reviewer's output and recorded responses on disk
are **untrusted data**. Authority — push, PR, admission, acceptance, waiver, promotion — never derives from
them.

## 2. Assets

Source code sent to the reviewer, the reviewer credential, review authority (adjudication outcomes,
dispositions, promotions), the corpus labels, recorded responses and scorecards, metric snapshots, human
reviewer attention.

## 3. Threats and mitigations

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T4-01 | Injection in the diff makes the reviewer approve a defect | Model verdict advisory; adjudication from grounded findings + deterministic checks; deterministic checks outrank; R2 still needs human merge; spotlighting + strict output as secondary layers | EC D1, D2, D5 |
| T4-02 | Injection floods humans with escalations or junk findings | Ungrounded findings machine-refuted; bounded rounds; escalation-rate metric and runbook threshold | EC D3, E7; `review_escalation_rate` |
| T4-03 | Output smuggling: tool-call items, extra fields, multiple messages, fake JSON terminators | `tool_choice: "none"`, no tools; one `output_text` required; AJV validation with `additionalProperties: false`; any deviation `MALFORMED` | EC C4, D3, G3 |
| T4-04 | Reviewer credential leaks (artifact, log, DB, coder sandbox, error text) | Adapter-internal credential source; header-only use; canonical request excludes headers; scrubbed errors; agent env allowlist; canary scan in real-backend itest | EC C5 |
| T4-05 | Source-code egress to a third party without consent / residency breach | Reviewer enabled per project in policy; disabled ⇒ R2 `DEFERRED`, R0/R1 unaffected; `store: false`; endpoint allowlist; documented as a tenant decision | EC K1, K8, C4, G6 |
| T4-06 | SSRF / credential exfiltration via a configured `baseUrl` or redirect | `https:` only; host allowlist; `redirect: "error"`; loopback only by explicit test literal | EC G6 |
| T4-07 | Gateway substitutes a different model (cheaper, same family as coder) | `servedModel` recorded; mismatch fails gating; family resolved from the requested pin and checked against the served id; promotion bound to config hash | EC G1, C3 |
| T4-08 | Shared context between coder and reviewer (correlated assumptions, self-preference) | Packet whitelist; no `previous_response_id`/`conversation`; different family for R2; blind parallel reviewers | EC C1, C2, C3, C6 |
| T4-09 | Finding text forwarded to the coder carries injected instructions | Repair order structured, cited, size-bounded; coder remains untrusted and sandboxed; its output re-verified and re-reviewed | EC E5 |
| T4-10 | Trojan Source (bidirectional/invisible Unicode) hides logic from model and human reviewers | Deterministic SECURITY finding on added lines | EC D4 |
| T4-11 | A secret in the agent's diff is pushed to the forge | Deterministic secret check BLOCKs before push for every admitted risk (D-5) | EC F1, F2 |
| T4-12 | Model waives or refutes a real HIGH/CRITICAL finding | DB check constraints on disposition actor; domain rule; only humans waive, with expiry + signature | EC K5, H4 |
| T4-13 | Forged or replayed promotion unlocks R2 | Promotion signed (ed25519, same scheme as `human_authorizations`), unexpired, config hash equal; revocation column | EC K1 |
| T4-14 | Tampered recorded responses or corpus labels inflate a scorecard | sha256 manifests verified before replay/scoring; corpus manifest hash frozen before test runs; scorecards bind all hashes; recordings and corpus are committed and scanned | EC I1, I3, I4, G8 |
| T4-15 | Agent influences its own metrics (e.g. emits events) | Events emitted only by harness steps through `RunEventSink`; agent has no DB access (Phase 2 sandbox) | EC H5; Phase 2 E8 |
| T4-16 | Cost DoS: huge diffs × retries × reasoning effort | Packet byte budget; `max_output_tokens`; bounded transport attempts and wall clock; budget stop in capture CLI | EC D6, G4, G5 |
| T4-17 | Corpus leakage turns measurement into recall of the answer key | Reviewed-SHA packets only; review artifacts and git metadata excluded | EC I2 |
| T4-18 | Cross-tenant review data access | Composite tenant FKs on every review table; IDOR tests | EC H2 |

## 4. Non-issues (documented, not fixed in Phase 4)

- **Provider-side retention beyond `store: false`** (abuse-monitoring logs, zero-data-retention contracts) is
  a contractual matter for the gateway operator; recorded as a deployment prerequisite, not code.
- **Model weights or provider compromise** is out of scope; correlated-error research (research register §3)
  is the reason deterministic checks and humans keep authority.
- **Grafana authentication** is local-dev only in Phase 4 (decision D-6); production dashboards need a
  read-only role and SSO, out of scope.

## 5. Residual risk statement

Model review is an additional, measured signal, not a security boundary. Its worst-case failure under
injection is a missed defect that still reaches a human at `WAITING_FOR_HUMAN_REVIEW` with deterministic
checks applied. The measurement corpus is small, single-codebase and labelled mostly by the candidate
reviewer's own model; any number it produces is a property of that corpus, not of the reviewer in general.
