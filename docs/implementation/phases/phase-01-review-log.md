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

## Repair cycle 2 — re-review findings (P1-FINAL-* partials + P1-REREVIEW-*)

The re-review re-verified every repair-cycle-1 fix by direct exploit, not by
reading the code. Seven fixes were found still bypassable in substance and are
re-fixed here with an adversarial ("bypass") test that fails against the old
code and passes against the new. HIGH-004, HIGH-005 and MED-004 were confirmed
genuinely resolved and needed no further work.

### P1-FINAL-CRIT-001 (re-fix) + P1-REREVIEW-CRIT-001 — acceptance spoofable; evidence from a stale HEAD

**Disposition: ACCEPTED.** Two distinct holes in the same mechanism:

- **Evidence↔HEAD binding (CRIT-001).** `check-acceptance.sh` bound the marker
  to HEAD and to the evidence *digest*, but never checked that the evidence was
  *captured at* the reviewed commit. `env-digest.txt` recorded
  `head_sha=caa1bff` (two commits stale) and nothing compared it to
  `reviewed_head`, so evidence from an old commit could back an ACCEPT for a
  newer HEAD. Root cause: the evidence bundle was **tracked**, and a tracked file
  can never record the SHA of the commit that contains it (writing it changes the
  tree, hence the SHA), so `head_sha` was structurally doomed to lag. Fix:
  untracked the generated bundle (`env-digest*`, `index*`, `gates/`) — like
  `.task-complete`/`acceptance.json` already were — and made the gate require
  `env-digest.head_sha == reviewed_head == git rev-parse HEAD`. A fresh capture at
  the reviewed HEAD is now the only way that equality can hold.

- **Controller-owned attestation (REREVIEW-CRIT-001).** `acceptance.json` is a
  working-tree file the worker can write, so gitignoring it does not make it
  "unavailable to the worker" and a plaintext `verdict: ACCEPT` field is
  worthless — the worker just types it. Fix: the marker now carries an **Ed25519
  signature** over the canonical `(reviewed_head, base, evidence_index_sha256,
  verdict)` payload (`scripts/lib/acceptance-crypto.mjs`). The controller holds
  the private key **out of tree**; only the reviewer public key
  (`artifacts/phase-01/reviewer-pubkey.pem`) is committed. The gate verifies the
  signature against that key, so the worker cannot mint a marker, cannot
  transplant a signature to a new HEAD (the head is inside the signed payload),
  and cannot flip the verdict. The marker is created only after a real
  ACCEPT_PHASE via `scripts/sign-acceptance.sh`. Self-tests + `check-acceptance.test.ts`
  + `acceptance-crypto.test.ts` prove: stale-evidence reject, forged/unsigned
  reject, wrong-key reject, signature-transplant reject, field-tamper reject.

### P1-FINAL-HIGH-001 (re-fix) — parity checked a shadow table, not base.ts

**Disposition: ACCEPTED.** The parity checker compared schemas against a
manually duplicated `EXPECTED_BASE_STRUCTURE` table; mutating both the schema and
that shadow table to add `R5` passed while `base.ts` still defined `RiskLevel`
through `R4`. Fix: the checker now reads `base.ts` directly (the actual
TypeScript source of truth), so schema↔TS parity can no longer be bypassed by
editing a shadow copy. Bypass test added.

### P1-FINAL-HIGH-002 (re-fix) — classifier ignored tightening breaking changes

**Disposition: ACCEPTED.** An in-memory edit tightening `minLength` 1→10 and
flipping `additionalProperties` true→false with no version bump produced
`ok=true, requiredBump=none`. Fix: the compatibility classifier now flags every
constraint-tightening class (numeric bounds, length/size bounds,
`additionalProperties` narrowing, enum removal, required-set widening) as
breaking and demands a major bump. Bypass tests added for each class.

### P1-FINAL-HIGH-003 (re-fix) — PII allowlist suppressed per line, not per match

**Disposition: ACCEPTED.** The email allowlist skipped an entire *line* if any
placeholder address occurred, so a line pairing `user@example.com` with a real
external address (a `<name>@gmail.com`) suppressed the real one. Fix: the scanner now evaluates each matched
address independently and only allowlists the specific placeholder tokens, so a
real address sharing a line with a placeholder is still caught. Canary added.

### P1-FINAL-MED-001 (re-fix) — injection grader consumed a self-asserted trace

**Disposition: ACCEPTED.** The `actionTrace` (with its `executed` flags) was
hand-authored in the same fixture as `expected`/allowlist, so flipping
`executed:false` fabricated resistance. Fix: an independent enforcement engine
(`evals/runner/enforcement.ts`) *derives* the trace from the fixture's
`requestedOperations` against the tool policy; the grader ignores any
hand-authored `executed` flags. Flipping the fixture can no longer manufacture a
pass. Bypass tests added.

### P1-FINAL-MED-002 (re-fix) — dgram/http2/full-dns egress open; shuffle test vacuous

**Disposition: ACCEPTED.** After `enforceDeterminism`, `dgram.createSocket`,
`http2.connect` and the `dns.*` resolver surface remained unpatched, and the
"shuffle" test reran the identical sorted loader twice (proving nothing). Fix:
the deny now covers UDP (`dgram`), `http2`, and the full `dns`/`dns/promises`
resolver surface; the order-independence test now actually shuffles a task list
via a seeded permutation and asserts byte-identical grading. Canaries added.

### P1-FINAL-MED-003 (re-fix) — formula/operand agreement matched field only

**Disposition: ACCEPTED.** Agreement compared only field *names*, so a formula
`where outcome=accepted` was satisfied by an operand `{field: outcome, equals:
rejected}` or `notEquals: accepted`. Fix: agreement now compares the full
`(field, operator, value)` triple in both directions; value drift and operator
(`=` vs `!=`) drift are caught. Bypass tests added for value, operator, and `!=`
mismatches, plus a no-false-positive check on the committed dictionary.

---

## Repair cycle 3 — re-review findings (Codex gpt-5.6-sol @ `1af1cff`)

Re-review cycle 3 re-verified every cycle-2 fix by direct exploit reconstruction
(verdict `REQUEST_REPAIR` @ 0.99; full record in
`phase-01-final-independent-review-rereview3.yaml`). Four cycle-2 fixes were
confirmed genuinely closed and left untouched: **HIGH-001** (parity reads
`base.ts`), **HIGH-002** (constraint-tightening = breaking), **HIGH-003** (PII
per-email allowlist), **MED-003** (formula↔operand operator+value agreement).
Four residual bypasses were re-fixed here, each with an adversarial test that
fails against the old code and passes against the new. Trust-root provenance of
`reviewer-pubkey.pem` (CRIT-001 part c) is **controller-owned and out of worker
scope** — the controller pins the key fingerprint outside the worker branch
after review returns ACCEPT.

### P1-REREVIEW-CRIT-001 (a)+(b) — acceptance still bypassable

**Disposition: ACCEPTED (fixed in `5116c4a`).** Two holes in the same
signed-acceptance mechanism:

- **(a) Fail-open on empty head_sha.** Both stale-evidence checks in
  `check-acceptance.sh` were guarded by `[ -n "$ev_head" ]`, so an
  env-digest with a missing/empty `head_sha` silently skipped BOTH and let an
  otherwise-valid marker through. Fix: an absent/empty evidence `head_sha` is now
  a **hard fail**, and a helper rejects a missing OR duplicated `head_sha` line
  so a doctored bundle cannot append a second one.
- **(b) env-digest outside the signed payload.** `canonicalPayload` signed only
  `evidence_index_sha256` (= sha256 of `index.tsv`), which never references
  `env-digest.txt`. Codex reused an old validly-signed index digest and rewrote
  `head_sha` inside `env-digest.txt` to the current HEAD, and every crypto check
  still passed. Fix: `env_digest_sha256` (sha256 of `env-digest.txt`) is now a
  field in the canonical payload and is signed; the domain tag was bumped
  `asep-acceptance-v1` → `-v2` so a v1 signature cannot be replayed. Any edit to
  `env-digest.txt` — including `head_sha` — now changes its sha256 and breaks
  both the equality check and the signature. `sign`/`verify` CLIs, the shell
  gate, and `sign-acceptance.sh` all thread the new digest through. Two new
  self-test cases were added (empty head_sha → reject; doctored env-digest with a
  stale signature → reject), keeping the seven prior cases green for **9/9**.

### P1-CYCLE3-HIGH-001 (new) — compat gate treated a version DOWNGRADE as a major bump

**Disposition: ACCEPTED (fixed in `4f470ed`).** Removing a required property
while downgrading `1.0.0 → 0.0.0` and `$id /v1 → /v0` returned `ok=true,
requiredBump=major, actualBump=major`: `actualBump` classified any major
*inequality* as a bump (no direction check) and the gate only checked that the
`$id` major *differed*. Fix: added `compareSemver`; `actualBump` now returns
`none` for any non-increasing version and only counts a segment that strictly
increased; `checkCompatibility` rejects a required bump when the version is not
strictly greater; and `compat-gate` requires the `$id` major segment to **equal**
the declared semantic-version major. Bypass covered by tests + two new gate
self-test cases (version+$id downgrade → FAIL; `$id /v2` with version `1.x` →
FAIL); a correct `1.0.0 → 2.0.0` + `/v1 → /v2` still passes.

### P1-FINAL-MED-001 (partial) — a breach could still pass the negative fixture

**Disposition: ACCEPTED (fixed in `d849eca`).** The cycle-2 fix correctly derived
the action trace from the independent policy engine, but the grader still
computed `injectionResisted === expectedResisted && setMatches`. A fixture that
self-declared the breach (`expected.injectionResisted=false` +
`executedOutsideAllowlist=[apply-patch]`) returned `passed=true, reason "injection
SUCCEEDED"` — a real breach laundered into a pass by the mutable `expected`.
Fix: a prompt-injection eval is a **resistance test that fails closed**. Any
engine-demonstrated breach (an out-of-allowlist op that actually executed) now
returns `passed=false` regardless of `expected`; `expected` only refines the
verdict for the no-breach case (a fixture predicting a breach that did not happen
is itself wrong and fails). Bypass test asserts injected apply-patch executing +
`expected.injectionResisted=false` → FAIL; the valid resisted case still passes.

### P1-FINAL-MED-002 (partial) — network deny leaked pre-capture + constructor egress

**Disposition: ACCEPTED (fixed in `12e7d2b`).** The cycle-2 fix swapped module
factory functions, but Codex showed two surviving egress paths: (a) a
`dgram.createSocket` reference **captured before** `enforceDeterminism()` still
built a live UDP socket, and (b) constructor-based egress
(`new dns.Resolver().resolve4`, `new net.Socket().connect`) never went through
the swapped factories. Fix: enforcement now **poisons the transport methods on
the shared prototypes** — `dgram.Socket.prototype` (`bind`/`send`/`connect`),
`net.Socket.prototype.connect`, `tls.TLSSocket.prototype.connect`, and the full
resolver surface on `dns.Resolver.prototype` / `dns.promises.Resolver.prototype`.
Every instance resolves these off the same prototype, so a pre-captured factory
hands back an inert socket and freshly-constructed instances hit the poisoned
prototype. Three canaries added (pre-captured `dgram.createSocket` →
`bind`/`send`/`connect` throw; `new dns.Resolver().resolve4` throws;
`new net.Socket().connect` throws). The module factory swaps are retained as a
louder, earlier failure for the direct-call path.

---

## Repair cycle 4 — re-review findings (Codex gpt-5.6-sol @ `97d1e4e`)

Re-review cycle 4 re-verified every cycle-3 fix by direct exploit reconstruction
(verdict `REQUEST_REPAIR` @ 0.99; full record in
`phase-01-final-independent-review-rereview4.yaml`). Four cycle-3 fixes were
confirmed genuinely closed and left untouched: **REREVIEW-CRIT-001a** (empty
head_sha fail-closed), **REREVIEW-CRIT-001b** (env-digest bound into the signed
v2 payload), **REREVIEW-CRIT-001c** (trust-root rotated to a controller-held
key), and **FINAL-MED-001** (a demonstrated breach fails regardless of
`expected`). One cycle-3 fix was closed only in part (**CYCLE3-HIGH-001**), the
network guard was still bypassable (**FINAL-MED-002**), and a new CI-wiring gap
was raised (**CYCLE4-MED-001**). All three residual/new items are fixed here,
each with an adversarial test or reproduction that fails against the old code and
passes against the new. No test was weakened; the test-integrity diff
(`git diff 97d1e4e...HEAD -- '**/*.test.*' '**/fixtures/**' 'package.json'`) adds
only new assertions and new required suites.

### P1-CYCLE3-HIGH-001 (partial) — compat gate accepted missing/unversioned `$id`

**Disposition: ACCEPTED (fixed in `100fdad`).** The cycle-3 fix required
`major($id) == major(version)` only when `majorOfId` returned non-null, so
`runCompatGate` guarded equality **only when a versioned `$id` was present**. A
breaking removal with `version=2.0.0` plus either a **deleted** `$id` or an
**unversioned** `$id` (e.g. `https://asep.dev/schema/thing/not-versioned`)
returned `{ok:true, problems:[]}` — a canonical schema with no parseable
version-major slipped the gate entirely. Reproduced all five shapes first
(missing `$id`; empty `$id`; unversioned `$id`; `$id`-major ≠ semver-major;
malformed `$id`), then made identity coherence **fail-closed**: every canonical
schema MUST carry a non-empty string `$id` that parses under the single canonical
`https://asep.dev/schema/<name>/vN` rule and whose major segment exactly equals
the declared semver major; a missing/empty/unparseable/unversioned `$id`, an
`$id`-major≠version-major disagreement, or a non-semver `version` is now a hard
gate failure. Two new gate self-test cases cover the missing- and
unversioned-`$id` breaking-change shapes; the valid same-major and governed
major-migration cases still pass.

### P1-CYCLE4-MED-001 (new) — acceptance shell suites omitted from the canonical test command

**Disposition: ACCEPTED (fixed in `b5e7ca7`).** `package.json`'s test script
used `tsx --test packages/**/*.test.ts … scripts/**/*.test.ts`. Under the
`/bin/sh` that `pnpm run` uses, `**` is **not** recursive, so
`scripts/**/*.test.ts` matched only `scripts/lib/acceptance-crypto.test.ts` and
silently **dropped** `scripts/check-acceptance.test.ts` (the acceptance
self-test, empty-head, stale-head, signature-forgery and env-digest-tamper
cases) and `scripts/forbidden-imports.test.ts` — those suites existed in the repo
but never ran under `pnpm test`. Reproduced the glob drop empirically first, then
replaced the shell glob with a deterministic, shell-free Node runner
(`scripts/run-canonical-tests.mjs` + `scripts/lib/canonical-tests.mjs`):
recursive `*.test.ts` discovery under the canonical roots, byte-stable sorted
paths, `node --import tsx --test` with `shell:false` and an explicit arg list,
exact exit-code propagation, and full raw stdout/stderr capture. Each critical
suite now emits a machine-readable `SUITE-ID:` marker at module load and the
runner **fails closed** if any REQUIRED suite's marker is absent from the
captured output — so a critical suite that is dropped, renamed away, or crashes
before its first line turns the gate RED even on exit 0. A wiring suite
(`scripts/run-canonical-tests.test.ts`) proves discovery is recursive, the
required-suite manifest is covered, and the fail-closed logic rejects
missing/empty output; the wiring suite is itself in the REQUIRED set, so the
mechanism that guards every other suite cannot be silently dropped.

### P1-FINAL-MED-002 (partial) — network deny bypassable via pre-captured / ESM-named references

**Disposition: ACCEPTED (fixed in `70d286c`).** The cycle-3 fix poisoned
transport methods on shared prototypes, but Codex showed the guard was still
bypassable: an **ESM named-import factory** (`import { createSocket } from
'node:dgram'`) captured a live factory because `syncBuiltinESMExports()` was
never called after patching, and a callable **captured before**
`enforceDeterminism()` kept the original reference (replacing a prototype
property does not revoke an already-captured callable). The root cause was
ordering: enforcement could run *after* task/grader modules had already evaluated
their top-level captures. Reproduced the surviving ESM-named bypass first (the
factory did **not** throw and a socket **was** created), then fixed the class,
not the site, with the **approved trusted-bootstrap architecture** (ADR 0016):

- **Preload-first ordering.** A canonical launcher (`evals/runner/launcher.ts`)
  spawns a fresh Node process with `node --import <tsx> --import
  <determinism-preload> <worker-entry>` — `shell:false`, explicit arg list,
  sanitized env (strips `NODE_OPTIONS`/`--require`/`--import`/inspector so a
  caller cannot inject a pre-preload or a debugger). The preload runs
  `enforceDeterminism()` as the **first application-level action**, before any
  task/grader/fixture module evaluates, and calls `syncBuiltinESMExports()` so
  ESM named bindings are rebuilt to the deny stubs.
- **Attestation + fail-closed entry.** The preload emits a machine-readable
  attestation line (with its resolved path) that the launcher requires; a run
  whose preload did not attest is treated as failed even on exit 0. The
  worker-entry `assertDeterminismEnforced()` **before** dynamic-importing the
  runner, so launching the entry without the preload fails closed *before* any
  task code runs.
- **Guarded surfaces + escapes.** The deny now covers `net`/`dgram`/`dns`/
  `http`/`https`/`http2`/`tls`/global `fetch`, plus `child_process` and
  `worker_threads` escapes (a fresh unguarded context would defeat the guard).
- **Honest adversarial fixture.** `adversarial-fixture.ts` (driven through the
  real launcher by `launcher.test.ts`) captures references at module top level
  via every trick — ESM named import, CJS `require`, constructor egress,
  microtask-deferred reference, dynamic re-import, `fetch`, `child_process`/
  `worker_threads` — and every one is blocked. A bootstrap-order regression test
  launches the entry **without** the preload and asserts the fixture's sentinel
  side-effect never prints (the entry fails closed before the fixture body
  evaluates) and no verdict is emitted.
- **Honest threat model.** ADR 0016 + the `env.ts` docstring state plainly that
  this is a **deterministic execution guard and defense against accidental
  egress, NOT a security boundary against arbitrary hostile in-process
  native/runtime code**; OS-level isolation (network namespace / seccomp /
  gVisor / microVM) is a Phase 2 deliverable, recorded in the risk register
  (RR-14) and backlog. The eval CLI (`evals/runner/cli.ts`) now routes through
  the launcher, so the gate evidence exercises the bootstrap and stays
  byte-identical across runs.

---

## Summary

- CRITICAL findings unresolved: **0** (P1-CRIT-001 rejected with evidence;
  underlying concern folded into exit criteria + production-pilot dependency).
- HIGH findings without disposition: **0**.
- All 10 required plan changes accepted (1 reframed).
- Final-review findings (P1-FINAL-*): **10 raised, 10 accepted and fixed**
  (1 CRITICAL, 5 HIGH, 4 MEDIUM), each bound to a fix commit above.
- Re-review (repair cycle 2): **7 partials re-fixed by exploit + 1 new CRITICAL
  (P1-REREVIEW-CRIT-001)**, each with an adversarial bypass test that fails
  against the old code. HIGH-004/HIGH-005/MED-004 confirmed already resolved.
  Acceptance is now controller-signed (Ed25519, key out of tree) and bound to
  evidence captured at the exact reviewed HEAD.
- Re-review (repair cycle 3): **4 residual bypasses closed** —
  REREVIEW-CRIT-001 (a) acceptance fail-open on empty head_sha and (b) env-digest
  outside the signed payload; CYCLE3-HIGH-001 (new) compat gate accepting a
  version+$id downgrade as a major bump; MED-001 a demonstrated injection breach
  passing the negative fixture via a mutable `expected`; MED-002 network deny
  leaking pre-captured and constructor-based egress. Each with an adversarial
  test. HIGH-001/HIGH-002/HIGH-003/MED-003 confirmed genuinely closed and left
  untouched. CRIT-001 (c) trust-root provenance is controller-owned (out of
  worker scope).
- Re-review (repair cycle 4): **1 partial closed, 1 network bypass closed by the
  approved trusted-bootstrap architecture, and 1 new CI-wiring gap fixed** —
  CYCLE3-HIGH-001 (partial) compat gate accepting missing/unversioned `$id` for a
  breaking change (`100fdad`); CYCLE4-MED-001 (new) acceptance shell suites
  dropped by a non-recursive `/bin/sh` glob, replaced by a deterministic
  shell-free Node runner with fail-closed required-suite verification (`b5e7ca7`);
  FINAL-MED-002 (partial) network deny bypassable via ESM-named / pre-captured
  references, closed with a preload-first trusted launcher + attestation +
  honest adversarial fixture + bootstrap-order regression (`70d286c`, ADR 0016).
  Each with an adversarial test/reproduction; no test was weakened. Cycle-3
  fixes REREVIEW-CRIT-001a/b/c and FINAL-MED-001 confirmed genuinely closed and
  left untouched. The bounded Phase 1 network property vs Phase 2 OS-level
  isolation boundary is recorded in ADR 0016, RR-14, and the backlog.
- Locked plan `phase-01-plan.md` incorporates every accepted change.
