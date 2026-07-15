# Phase 1 — Plan Review Adjudication Log

Adjudication of `phase-01-plan-review-codex-v1.md` (Codex gpt-5.6-sol, verdict
REQUEST_CHANGES @ 0.98) against the repository and the governing prompt pack.

Each finding is dispositioned `ACCEPTED`, `PARTIALLY_ACCEPTED`, or
`REJECTED_WITH_EVIDENCE`. Rejections cite a verification source per
`.claude/rules/review-audit-self-decision.md`.

Governing precedence when docs conflict: the **task prompt pack** (explicit user
instruction) > `docs/implementation/90-day-plan.md` (repo aspiration). Both were
read in full.

---

## P1-CRIT-001 — "Include 30–50 genuine historical tasks in Phase 1"

**Disposition: REJECTED_WITH_EVIDENCE (underlying rigor concern PARTIALLY_ACCEPTED).**

Codex is correct that `90-day-plan.md` Days 1–15 lists "choose one pilot
repository and 30–50 historical tasks" and exits on "historical tasks can be
represented and graded deterministically."

Rejected as a Phase 1 deliverable because:

1. **The prompt pack explicitly forbids it.** PROMPT 1 §F: *"Không được bịa
   30–50 historical tasks. Nếu chưa có task lịch sử thật: … tạo tối đa 10
   synthetic seed fixtures; đánh dấu rõ synthetic; ghi việc thu thập 30–50
   historical tasks là exit dependency trước production pilot."*
2. **No real source exists.** The repository was imported as a single baseline
   commit (`83ba33d`); it has no historical bug/PR/incident history to mine.
   Producing 30–50 "genuine historical tasks" here would require fabrication,
   which the pack and `.claude/rules/development-rules.md` ("no fake data")
   both forbid.
3. Codex's proposed fix ("ingest 30–50 genuine historical tasks") is therefore
   **not executable** in this environment without violating a higher rule.

Underlying concern accepted by strengthening determinism proof:

- The **task-ingestion schema** and **deterministic grader** are Phase 1
  deliverables and MUST be proven byte-identical across two clean-checkout runs
  on labeled synthetic fixtures (see P1-OPT-002).
- The **30–50 genuine historical task** collection is recorded as a **blocking
  production-pilot dependency** in `phase-01-exit-criteria.md`
  (production-pilot gate, NOT a Phase 1 exit gate) and in the phase report.

Consequence acknowledged: Phase 1 does not claim empirical grading on the target
task distribution. The exit criterion is reworded to "grader is deterministic on
labeled fixtures", not "historical tasks graded".

---

## P1-HIGH-001 — Contract representations already drift (templates vs TS)

**Disposition: ACCEPTED.** Verified: `templates/*.yaml` use
`apiVersion/kind/metadata/spec` envelopes with nested shapes
(`WorkOrder.spec.repository.baseSha`, `ContextPack.spec.policy.allowedTools`)
while `packages/contracts/src/index.ts` is flat. Resolution folded into
P1-CHANGE-002: one authoritative JSON Schema source; TS types + validators
generated or drift-tested; templates validated against schemas in CI.

## P1-CHANGE-002 — Single authoritative contract source

**Disposition: ACCEPTED.** JSON Schema is canonical (has `$id` + version).
TypeScript types are generated from schema OR a checked-in mapping is asserted by
a regeneration-diff test that fails on drift. One runtime validator
implementation (Ajv). Templates and fixtures validate against the same schemas.

## P1-CHANGE-003 — Executable compatibility checker

**Disposition: ACCEPTED.** Add per-schema version snapshots and an automated
compatibility checker with mutation fixtures (breaking change must fail a minor
bump). Backward/forward policy is codified, not prose.

## P1-CHANGE-004 — Consolidate policy authority (YAML vs TS)

**Disposition: ACCEPTED.** `policies/risk-policy.yaml` and
`packages/policy` originally duplicated risk rules. Resolution: the canonical
risk authority is `policies/risk-taxonomy.yaml` (categories → R0–R4) plus
`policies/approval-matrix.yaml` (per-risk approval requirements), loaded by
`packages/policy/src/policy-source.ts`; the TS surface is a projection asserted
by parity tests. The legacy divergent `policies/risk-policy.yaml` (nested
envelope, missing a R4 field) loaded by no code was **removed**
(P1-FINAL-HIGH-005), and a guard test fails if it reappears. Deterministic risk
rules stay code-only (no model calls) per prompt pack §C.

## P1-CHANGE-005 — Raw evidence external/ignored; commit sanitized manifests

**Disposition: ACCEPTED.** Aligns with ADR-0009 (raw evidence before reduction)
and public-repo safety. Raw stdout/stderr live under an ignored
`artifacts/phase-01/raw/` (git-ignored); only sanitized, checksummed manifests
are committed. Secret/path canaries must never enter tracked files.

## P1-CHANGE-006 — Executable publication gates + scanner self-test

**Disposition: ACCEPTED.** License (Apache-2.0, user-approved), provenance,
dependency-license, git-history secret scan, and a scanner self-test (must fail
on a seeded canary) become executable checks. Publication blocked on any failure
or missing approval.

## P1-CHANGE-007 — Remove public push + PR from Phase 1 completion

**Disposition: ACCEPTED.** Phase 1 completes **offline**: local branch +
all gates + evidence + Codex final review, working tree clean. Public repo
creation, push, and PR become a **separate post-Phase-1 step**, already chosen by
the user to run at end of session. This also matches the earlier gating of the
irreversible publish action.

## P1-CHANGE-008 — Completion marker bound to HEAD/evidence, after review

**Disposition: ACCEPTED.** `.task-complete` (implementer sentinel per the
long-task harness) records HEAD SHA; a separate **final acceptance** marker is
created only after Codex final review returns no critical/high. A
reviewer-rejection simulation must not leave a valid acceptance marker.

## P1-CHANGE-009 — Canonical verify command, ignore generated metadata, clean tree

**Disposition: ACCEPTED.** Ignore `*.tsbuildinfo`/`dist/`. Define one canonical
`verify` command that is the full local gate and mirrors CI. Assert `git status`
clean after verify (no generated/untracked files).

## P1-CHANGE-010 — ADR/radar approval manifest + architecture dependency gates

**Disposition: ACCEPTED.** Add an approval manifest (ADRs 0001–0015 + technology
radar accepted) checked at exit, and an architecture fitness test that fails on
forbidden imports (no provider/model SDK in domain contracts).

## P1-METRIC-001/002/003 — Event catalog, referential integrity, privacy enum

**Disposition: ACCEPTED.** Metric dictionary is machine-readable; every
numerator/denominator/dimension/cost operand references a name in a versioned
RunEvent catalog (validation fails on unknown event/field or zero-denominator
without policy). Privacy is an enum with capture/redaction/retention/access
rules per class.

## P1-OPT-001 — Traceability matrix

**Disposition: ACCEPTED.** Generate a machine-readable matrix mapping each Phase
1 requirement/exit-criterion → implementation → test → evidence.

## P1-OPT-002 — Pin evaluation determinism knobs

**Disposition: ACCEPTED.** Pin input ordering, seed, locale, timezone,
dependency versions, default-deny network. Prove byte-identical output across two
clean runs with shuffled discovery order.

---

## Repair cycle 1 — final-implementation review findings (P1-FINAL-*)

Codex's final implementation review (against the built tree, not the plan)
raised ten findings on the delivered code. All ten were **ACCEPTED** and fixed;
each cites the fix commit. These are code-level defects where an earlier gate was
present in form but hollow in substance (a check that could not actually fail),
or where a structured artifact silently disagreed with its own prose.

### P1-FINAL-CRIT-001 — completion not bound to the reviewed commit

**Disposition: ACCEPTED (fixed in `8221fa6`).** The report hardcoded no head SHA
but nothing bound completion to the reviewed state either. Added
`artifacts/phase-01/acceptance.json` + `scripts/check-acceptance.sh`: the marker
records `reviewed_head`/`base`/`evidence_index_sha256`/`verdict`, and the gate
fails unless the marker binds the current HEAD, merge-base and evidence digest
with an ACCEPT verdict. A repair commit moves HEAD and instantly invalidates a
prior marker, so false completion cannot survive a repair (P1-CHANGE-008).

### P1-FINAL-HIGH-001 — TS-type parity guard blind to x-tsType overrides

**Disposition: ACCEPTED (fixed in `600a562`).** The schema→TS drift guard did not
assert the `x-tsType` branded-type overrides, so a hand-edit to a generated brand
would pass. Added a structural parity guard over every `x-tsType` override.

### P1-FINAL-HIGH-002 — compat gate did not compare against frozen snapshots

**Disposition: ACCEPTED (fixed in `203f12f`).** The compatibility checker ran but
never diffed live schemas against the frozen v1 snapshots, so a breaking change
could pass. Wired the gate to the committed `schema/snapshots/v1/*` and proved a
breaking mutation fails.

### P1-FINAL-HIGH-003 — publication scanners were presence stubs

**Disposition: ACCEPTED (fixed in `ca8b930`).** The dependency-license check was a
checklist note, there was no PII scanner, and the git-history secret scan used a
different pattern set than the HEAD scan. Added a real license inventory
(fail-closed on non-permissive/unknown), a self-testing PII scanner, and a shared
`scripts/lib/secret-patterns.sh` so HEAD and history scans cannot diverge.

### P1-FINAL-HIGH-004 — policy CI step ran zero tests

**Disposition: ACCEPTED (fixed in `1fca71c`).** `@asep/policy` had no `test`
script, so CI's `pnpm --filter @asep/policy test` was a silent no-op. Added the
real test script (34 tests) and a forbidden-import fitness test (no provider SDK
or live-network module in domain packages), wired into CI.

### P1-FINAL-HIGH-005 — legacy duplicate risk authority

**Disposition: ACCEPTED (fixed in `3207b2f`).** See P1-CHANGE-004 above:
`policies/risk-policy.yaml` was a dead duplicate risk authority loaded by no code.
Removed it and its MANIFEST entry; a guard test fails if it reappears.

### P1-FINAL-MED-001 — prompt-injection grader trusted a pre-labeled list

**Disposition: ACCEPTED (fixed in `2c05b53`).** The grader did set-arithmetic on a
pre-labeled `injectedOperations` list and never inspected what the agent actually
did, so it could not detect a real breach. Re-based it on a **trusted action
trace** (recorded execution outcomes): the verdict fails if any operation outside
the allowlist was actually executed. Added grader self-tests proving an executed
out-of-allowlist op flips the verdict.

### P1-FINAL-MED-002 — eval network deny only covered dns.lookup

**Disposition: ACCEPTED (fixed in `91dbb4f`).** The determinism harness overrode
only `dns.lookup`; `net.connect`, `http`/`https` and global `fetch` stayed open.
Hardened the deny across every egress path and added network-deny canary tests
plus a shuffle-discovery test proving order-independence (P1-OPT-002).

### P1-FINAL-MED-003 — metric formula/operand silent disagreement

**Disposition: ACCEPTED (fixed in `41ca7eb`).** Operand filters supported only a
single `{field, equals}`, so a formula's `where A=x and B=y` could not be encoded
and silently disagreed with the structured operand (e.g. `first_attempt_pass_rate`
formula named `outcome=accepted and repairCycles=0` but the operand encoded only
`repairCycles=0`). Added conjunctive `filters` support and a per-operand
formula↔operand agreement validator (attributes each `where` clause to its own
operand via top-level `/` split, so a numerator/denominator swap is caught too),
then fixed the two drifting metrics.

### P1-FINAL-MED-004 — no single full-gate entry point; CI hand-chained steps

**Disposition: ACCEPTED (fixed in `c6c115d`).** Local `verify` ran only
format+typecheck+test while CI hand-chained eleven separate steps, so the two
could silently diverge. Added `scripts/verify-all.sh` (`pnpm verify:all`) as the
single full gate — format, typecheck, full test matrix, filter tests, compat
gate, forbidden-import fitness, secret/large-file/PII scans, publication gate,
clean-tree assertion — and refactored CI to call that exact script. Adding a
check in one place now adds it to both.

---

## Summary

- CRITICAL findings unresolved: **0** (P1-CRIT-001 rejected with evidence;
  underlying concern folded into exit criteria + production-pilot dependency).
- HIGH findings without disposition: **0**.
- All 10 required plan changes accepted (1 reframed).
- Final-review findings (P1-FINAL-*): **10 raised, 10 accepted and fixed**
  (1 CRITICAL, 5 HIGH, 4 MEDIUM), each bound to a fix commit above.
- Locked plan `phase-01-plan.md` incorporates every accepted change.
