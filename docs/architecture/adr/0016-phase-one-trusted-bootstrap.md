# ADR 0016 — Phase-1 determinism guard is a trusted bootstrap, not a sandbox

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

The eval runner enforces determinism by denying network egress and
process/thread escape from inside the Node process (`evals/runner/env.ts`,
`enforceDeterminism()`). A cycle-4 review (P1-CYCLE4-MED-002) showed the guard
could be bypassed: a task/grader/fixture module that ran BEFORE enforcement — or
captured an ESM named-import binding at its own module top level — kept a live,
un-poisoned reference to a builtin factory (e.g. `import { createSocket } from
'node:dgram'`). Poisoning `module.exports` after the fact did not rebind those
already-resolved ESM named bindings, so the pre-captured factory still opened
sockets. This was reproduced empirically before the fix.

Two distinct problems were conflated in prior loops:

1. **Ordering.** Enforcement must run before ANY task-authored module body is
   evaluated, or top-level captures win.
2. **ESM binding semantics.** Even with correct ordering, patching CommonJS
   exports does not update ESM named bindings unless `syncBuiltinESMExports()`
   is called after the patch.

## Decision

Phase 1 ships a **trusted deterministic bootstrap**, explicitly NOT an OS-level
sandbox:

- **Preload-first ordering.** The canonical launcher
  (`evals/runner/launcher.ts`) spawns a fresh Node process as
  `node --import <tsx> --import <determinism-preload> <worker-entry>` with
  `shell:false` and an explicit arg list. Node evaluates `--import` modules
  before the main entry, so `enforceDeterminism()` in
  `determinism-preload.ts` is the first application-level action — before any
  fixture body.
- **ESM rebinding.** `enforceDeterminism()` calls `syncBuiltinESMExports()`
  after poisoning, so ESM named bindings (the cycle-4 bypass) resolve to the
  deny stubs at capture time.
- **Escape closure.** `child_process` and `worker_threads` entry points are
  also denied, so a task cannot spawn a fresh un-guarded process/thread.
- **Attestation, fail-closed.** The preload emits a machine-readable
  attestation line; the launcher treats a run whose preload did not attest as a
  failure even on exit 0. The worker-entry asserts attestation BEFORE
  dynamic-importing task/grader code, so a launch that skipped the preload fails
  closed before task code evaluates.
- **Sanitized child env.** `NODE_OPTIONS` and other pre-main injection vectors
  are stripped so a caller cannot inject an alternate preload/loader/inspector
  that would run before ours.

## Consequences

- The exact cycle-4 bypass (and CJS require, constructor egress,
  microtask-deferred references, dynamic re-import, `fetch`, http/https/http2,
  dgram, DNS, and process/thread escape) is blocked. This is proven by an honest
  adversarial fixture driven through the real launcher
  (`evals/runner/launcher.test.ts`, `adversarial-fixture.ts`), plus a
  bootstrap-order regression that asserts the fixture body never evaluates when
  the preload is omitted.
- This is **in-process defense-in-depth, not isolation.** A sufficiently
  determined in-process adversary with native addons, V8 internals, or a
  Node/V8 vulnerability is out of scope for Phase 1. The guard raises the cost
  of accidental and casual-adversarial egress to "must defeat the Node module
  system before our preload runs," which the launcher's env sanitization and
  preload-first ordering make hard from userland JS.
- True containment (network namespaces, seccomp, containerized/VM isolation) is
  a **Phase 2 deliverable** and is deliberately not claimed here.

## Revisit when

Phase 2 introduces OS-level isolation, or measured evidence shows an in-process
egress path the guard does not cover, or a replacement bootstrap passes
compatibility, recovery, security and cost/quality evaluation.
