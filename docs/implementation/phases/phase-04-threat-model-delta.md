# Phase 4 — Threat Model Delta (LOCKED v5, pending controller confirmation)

> Delta over `docs/operations/security-threat-model.md` and `phase-02-threat-model-delta.md`. Phase 4 adds the
> first **external model call made by the trusted harness about untrusted content**, a second credential class,
> persisted review records and a measurement corpus. Base `00a6889`; v1 reviewed at `a2a7b8a`. v2 closes the
> egress-before-block hole (P4-PLAN-CRIT-001), moves the credential to the composition root (R13), adds fencing
> and closure-authority threats, and retires promotion threats with the deferral of promotion. v3 (lock-check of
> `3201335`) adds the workspace seam (T4-24) and corpus answer-key leakage through history (T4-25). v4 (review of `9e3a1c3`)
> adds path smuggling (T4-26), sensitive paths only the repair delta names (T4-27), hidden blocking findings
> (T4-28) and a corpus gate that fails open (T4-29). v5 (re-check of `7cc20f4`, R28) extends T4-28 with severity
> downgrade by re-raise, identity collisions and a scanner run that proves nothing, extends T4-29 with pattern drift
> between the gate and the collector, and adds a zombie caller dropping its fence (T4-30).

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
| T4-03 | Output smuggling (tool calls, extra fields, multiple messages, fake terminators) | `tool_choice: "none"`, no tools sent by the harness; the gateway is verified to attribute tools the harness never sent (T4-09), so any tool-call output item is still `MALFORMED`, whatever the request carried; one `output_text`; AJV with `additionalProperties: false` | EC C4, D4, G3 |
| T4-04 | Reviewer credential leaks (artifact, log, DB, coder sandbox, error text) | Injected at the composition root; no `process.env` in adapter code; header-only; bounded lifetime and rotation; scrubbed errors; agent env allowlist; canary scan | EC C5 |
| T4-05 | **Secret or classified content sent to the gateway before a BLOCK** (v1 ordering) | Push guard and egress decision run before any reviewer call; only `CLEAR` permits a request; the exact request bytes are re-scanned; per-project opt-in; deny-path classification; unscannable sensitive content stops; zero-request tests on the unit and production paths | EC D1, D2, F2 |
| T4-06 | Source-code egress without tenant consent / residency breach | Per-project `egress.enabledProjects` opt-in (empty by default → reviewer never called); `store: false`; documented as a tenant decision | EC D1, D2 |
| T4-07 | SSRF / credential exfiltration via `baseUrl` or redirect | `https:` only; host allowlist; `redirect: "error"`; loopback only by explicit test literal | EC G6 |
| T4-08 | Gateway substitutes a different model | `servedModel` recorded; mismatch fails the review in every mode; config hashes pinned | EC G1, C3 |
| T4-09 | Gateway alters prompts in transit — **verified**: the kiro-proxy gateway appends a terse-style instruction block (~330 tokens) to `instructions` and attributes ~300 tokens of tools to every request, on `/v1/responses` and `/v1/chat/completions` | Served ≠ sent: recorded request bytes are only what the harness sent; every call compares the returned `instructions` with the sent ones and reads `usage` attribution, recording `gatewayAlteration` and the appended block as an artifact; replay, independence and measurement claims hold only "via this gateway"; every scorecard and verdict names the gateway (`MEASURED_VIA`) | PR4-30, EC G10, I3, I9 |
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
| T4-24 | A step reads repository content through another tenant's workspace, or a superseded holder keeps reading after a lease takeover | `AssuranceWorkspaceResolver` (S0 block) checks tenant, an `ACTIVE` lease, the holder's lease id and the current epoch in one read; every refusal stops the step before any read; a workspace never comes from activity-local memory; the resolver kit runs on Lane A's lease table and Lane B's fake | EC E13; PR4-34 |
| T4-25 | Historical trees leak the answer key into corpus packets (finding ids in code comments, review documents, per-item packets that point at the defect) | Packets per cycle in label-independent chunks; leakage path filter; finding-id tokens masked to the same length; commit messages have no packet field; leakage test | EC I2, I12 |
| T4-26 | **Path smuggling**: a changed path with LF, CR, U+2028/U+2029 or another control character, or an unresolved Git C-quoted form, slips past the deny-path globs and the allowed-path check, and its content reaches the gateway (reproduced by the v3 review with a fake sender) | Such a path is not normalizable: always sensitive, push guard `BLOCK` (`forbidden-path`), egress `STOP_CLASSIFIED`, never read; the packet builder keeps it (`unsafe-path`) instead of failing the round; globs match every code point as defence in depth; zero-request tests | EC D1 |
| T4-27 | A sensitive pre-image path that only the repair delta names (a rename out of `secrets/`, a copy, a deletion) leaves in a re-review packet | Egress classifies both sides of every entry of the cumulative diff and the repair delta; an unparseable delta stops as unscannable; zero-request tests for rename, copy, delete and delta-only files | EC D1 |
| T4-28 | A blocking finding is hidden: by its position in the reviewer's list, by an ungrounded or lower-severity duplicate, by a resolution citing unchanged context, by a re-raise under a live waiver, by a lower-severity re-raise of an open prior, by two identities made equal through a separator inside a field, or by a SARIF result simply no longer being reported (a disabled rule, a failed rule or an unscanned file reports nothing) | Ground before merge; identity keeps requirement ids and keys apart; every identity is a canonical JSON tuple with collision fixtures; conservative merge; permutation test; changed-line predicate for closure; reconciliation with prior dispositions, and a re-raise never downgrades (the pair blocks at the highest severity); SARIF closure only by a recheck that proves effective execution and coverage, or a human, and a DB constraint against reviewer verification of non-model findings | EC E4, E6 |
| T4-29 | The corpus publication gate fails open: a scanner that crashes, cannot start or errors without naming an excerpt lets unscanned excerpts into the committed corpus; or the collector's copy of the path-leak patterns drifts from the gate's | Documented exit codes per gate; anything else, or a findings code without a named excerpt, aborts collection before anything is written; one pattern file, `scripts/lib/publication-leak-patterns.txt`, read by both, with an executable parity test that catches an appended pattern; the collector never replaces the full publication gate, which still runs before any public push | EC I13 |
| T4-30 | A zombie caller whose lease was taken over or ended drops its fence and records a terminal with `fence: null`, or a pre-lease terminal and a lease acquisition race so both succeed | `fence: null` only for an attempt whose durable history shows no lease (R28 obligations 3, 7); the terminal write and lease acquisition take the same attempt-row lock and each refuses after the other (obligations 2, 5); conformance RLC-16 (race) and RLC-17 (refusal after a lease) | EC E12, H4 |

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
