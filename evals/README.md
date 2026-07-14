# ASEP Evaluation Foundation (Phase 1)

Deterministic, offline evaluation of the platform's core decision logic:
contract validation, risk routing, verification-plan generation, skill routing,
reviewer finding quality, and the adversarial/negative cases (malformed provider
output, prompt injection, scope violation, false completion).

## What this is

- `schema/eval-task.schema.json` — the **task-ingest contract**. Every fixture
  validates against it. Real historical tasks reuse the same shape.
- `runner/` — a **deterministic** runner and pure graders. No model calls, no
  network, no clock, no randomness. Given the same fixtures it emits
  byte-identical JSON (see determinism guarantees below).
- `fixtures/` — labelled **synthetic** seeds (≤10), each `source: synthetic`
  with a `provenance` record so nothing can masquerade as real history.

## Running

```bash
pnpm --filter @asep/evals eval      # print the deterministic report to stdout
pnpm --filter @asep/evals test      # run the eval test suite
```

## Determinism guarantees

`runner/env.ts` pins the environment before any work:

- timezone pinned to UTC, locale pinned to `C`
- outbound network is default-**deny** (DNS lookup throws)
- a fixed seed is exposed for any future pseudo-random need (none today)

`runner/run.ts` then:

- loads fixtures in a fixed lexicographic order, sorted by `id`
- serializes JSON with recursively sorted keys and a trailing newline
- emits **no** timestamps, durations, hostnames, or absolute paths

Result: running the runner twice from a clean checkout produces byte-identical
output. This is asserted by the test suite (`D2`) and can be checked by hand:

```bash
pnpm --filter @asep/evals eval > a.json
pnpm --filter @asep/evals eval > b.json
diff a.json b.json   # empty
```

## Grader coverage (Phase 1 exit criterion D3)

| Grader | What it checks | Positive/negative |
|--------|----------------|-------------------|
| `contract-validation` | schema accept/reject | both |
| `risk-routing` | change categories → R0–R4 (max across) | positive |
| `verification-plan` | risk → mandatory assurance levels | positive |
| `skill-routing` | task type → selected skill, no forbidden skill | positive |
| `reviewer-finding-quality` | a finding must cite evidence + required fix | positive |
| `malformed-provider-output` | non-conforming provider output is rejected | negative |
| `prompt-injection` | injected out-of-allowlist operations are denied | negative |
| `scope-violation` | changed paths outside `allowedPaths` are caught | negative |
| `false-completion` | declared-complete-with-red-gates → `false-completion` | negative |

## Production-pilot dependency (NOT a Phase 1 exit criterion)

Phase 1 proves the platform can **represent and grade** tasks deterministically
using labelled synthetic fixtures. It does **not** claim any empirical result on
real work. Before a production pilot, the following must be completed and is a
**blocking pre-pilot gate** (recorded here per review-log disposition
P1-CRIT-001):

1. Select one real pilot repository.
2. Collect **30–50 genuine historical tasks** with provenance and a privacy
   review. These use the same `eval-task` schema with `source: historical` and a
   full `provenance` record (author, `collectedAt`, `originalRef`, `reviewedBy`).
3. Produce a baseline scorecard by running the graders on the real dataset.

Fabricating "historical" tasks to satisfy an exit criterion is explicitly
forbidden (risk RR-03). The synthetic seeds here are clearly labelled and exist
only to exercise the grading machinery.
