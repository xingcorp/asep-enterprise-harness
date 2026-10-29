# Phase 4 — Threat Model Delta (LOCKED v2 (pending controller confirmation))

> Delta over `docs/operations/security-threat-model.md` and `phase-02-threat-model-delta.md`. Phase 4 adds the
> first **external model call made by the trusted harness about untrusted content**, a second credential class,
> persisted review records and a measurement corpus. Base `00a6889`; v1 reviewed at `a2a7b8a`. v2 closes the
> egress-before-block hole (P4-PLAN-CRIT-001), moves the credential to the composition root (R13), adds fencing
> and closure-authority threats, and retires promotion threats with the deferral of promotion.

## 1. Trust boundaries

```text
[Trusted harness]
   │ builds packet (whitelist) → deterministic checks → egress decision
   │        push guard BLOCK or egress not CLEAR  ⇒  zero requests
   ├────────────── request (scanned data) ─▶ [Reviewer gateway (external), OpenAI-compatible, HTTPS]
   │◀───────────── response (untrusted) ───
   │ validate → ground → adjudicate (pure) → fenced writes
   ├──▶ review tables / run_events (Lane A) / metric_snapshots
   ├──▶ RepairOrder → next coder attempt (drill only in Phase 4)
   └──▶ PR assurance section → human reviewer
[Composition root] credential source ─▶ reviewer adapter (in-process, never the agent container)
[Benchmark tooling] corpus excerpts → packets → recorded responses → scorecards (offline scoring)
```

The diff, repository content, coder output, reviewer output, recorded responses and corpus excerpts are
**untrusted data**. Authority — push, PR, admission, acceptance, waiver, finding closure — never derives from them.
In Phase 4 production the reviewer is shadow-only, so model output cannot change the workflow at all.

## 2. Assets

Source code and any secret it contains, the reviewer credential, review records and dispositions, the corpus labels
and excerpts, recorded responses and scorecards, metric snapshots, human reviewer attention.

## 3. Threats and mitigations

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T4-01 | Injection in the diff makes the reviewer approve a defect | Shadow-only production: the verdict changes nothing; in any mode adjudication derives from grounded findings and deterministic checks; deterministic checks outrank; spotlighting + strict output as secondary layers | EC E9, K3, D4, D6 |
| T4-02 | Injection floods humans with findings or escalations | Shadow records only; ungrounded findings machine-refuted; bounded rounds in drill | EC D4, E7 |
| T4-03 | Output smuggling (tool calls, extra fields, multiple messages, fake terminators) | `tool_choice: "none"`, no tools; one `output_text`; AJV with `additionalProperties: false` | EC C4, D4, G3 |
| T4-04 | Reviewer credential leaks (artifact, log, DB, coder sandbox, error text) | Injected at the composition root; no `process.env` in adapter code; header-only; bounded lifetime and rotation; scrubbed errors; agent env allowlist; canary scan | EC C5 |
| T4-05 | **Secret or classified content sent to the gateway before a BLOCK** (v1 ordering) | Push guard and egress decision run before any reviewer call; only `CLEAR` permits a request; the exact request bytes are re-scanned; per-project opt-in; deny-path classification; unscannable sensitive content stops; zero-request tests on the unit and production paths | EC D1, D2, F2 |
| T4-06 | Source-code egress without tenant consent / residency breach | Per-project `egress.enabledProjects` opt-in (empty by default → reviewer never called); `store: false`; documented as a tenant decision | EC D1, D2 |
| T4-07 | SSRF / credential exfiltration via `baseUrl` or redirect | `https:` only; host allowlist; `redirect: "error"`; loopback only by explicit test literal | EC G6 |
| T4-08 | Gateway substitutes a different model | `servedModel` recorded; mismatch fails the review in every mode; config hashes pinned | EC G1, C3 |
| T4-09 | Gateway alters prompts in transit (style injection suspected, not verified) | Recorded request bytes are what the harness sent; measurement bounded to "via this gateway"; gateway host in scorecards | PR4-30, EC I9 |
| T4-10 | Shared context between coder and reviewer | Packet whitelist; no `previous_response_id`/`conversation`; family registry; blind parallel reviewers | EC C1, C2, C3, C6 |
| T4-11 | Finding text forwarded to a coder carries injected instructions | Drill only in Phase 4; repair order structured, cited, size-bounded; coder sandboxed; output re-verified and re-reviewed | EC E5 |
| T4-12 | Trojan Source hides logic | Deterministic SECURITY finding on added lines | EC D5 |
| T4-13 | A secret in the agent's diff is pushed | Push guard BLOCKs before the gateway and before push for every admitted risk (D-5) | EC F1, F2 |
| T4-14 | Model waives, refutes or self-verifies a finding | DB constraints: only humans waive (with expiry + signature); only humans reject grounded findings; the raiser cannot verify; reviewers can only claim or verify others' findings | EC K6, E6, H3 |
| T4-15 | **Zombie executor** after a lease handoff calls the reviewer again or writes a different decision | Reviewer call claimed through the Phase 2 fenced primitive; every decision write fence-checked in its transaction; append-only/final-record triggers | EC E2, H3 |
| T4-16 | **Production composition silently enables gating** | Loader rejects `gating`; `assurance-root` refuses; drill factories unreachable from entry points; DB rejects shadow gating outcomes | EC K3, E9, A5 |
| T4-17 | Tampered recordings or corpus excerpts inflate a scorecard | sha256 manifests verified before replay/scoring; excerpt bytes hash to their names; preregistration binds hashes; committed and scanned | EC I4, I5, I10, G9 |
| T4-18 | **Pre-rewrite history re-published** (credential-shaped fixture) to rebuild the corpus | No tags/refs for pre-rewrite SHAs (R12); content-addressed excerpts only; publication gates over excerpts; private bundle stays with the controller | EC I10 |
| T4-19 | False-green evidence (zero tests, added skips, reduction bugs) passes as verified | Execution manifest in the packet; deterministic false-green checks; reviewer detection measured | EC F5, F6 |
| T4-20 | Agent influences its own metrics | Events emitted only by harness steps through `RunEventSink`; event-type ownership (SR-A6); agent has no DB access | EC H4, H5 |
| T4-21 | Cost DoS (huge diffs × retries × two reviewers × effort) | Packet budget; `max_output_tokens`; task `budgetRemaining`; bounded transport attempts; capture budget stop | EC D7, G4, G5 |
| T4-22 | Corpus leakage turns measurement into recall of the answer key | Reviewed-SHA packets only; review artifacts and git metadata excluded | EC I2 |
| T4-23 | Cross-tenant review data access | Composite tenant FKs on every review table; IDOR tests | EC H2 |

## 4. Non-issues (documented, not fixed in Phase 4)

- **Provider-side retention beyond `store: false`** is a contractual matter for the gateway operator.
- **Model weights or provider compromise** is out of scope; correlated-error research is why deterministic checks
  and humans keep authority.
- **Grafana authentication** in the integration gate is local and ephemeral; production dashboards need a read-only
  role and SSO, out of scope.
- **Promotion forgery** (v1 T4-13) no longer applies: promotion is deferred (DF-2).

## 5. Residual risk statement

Model review is an additional, measured signal, not a security boundary, and in Phase 4 production it changes
nothing. Its worst case under injection is a missed or spurious advisory finding at `WAITING_FOR_HUMAN_REVIEW`, with
deterministic checks applied and no content sent unless it passed the egress decision. The measurement corpus is
small, single-codebase, labelled mostly by the primary reviewer's own model, and visible to the prompt author; any
number it produces is a description of that corpus, not a validation of the reviewer.
