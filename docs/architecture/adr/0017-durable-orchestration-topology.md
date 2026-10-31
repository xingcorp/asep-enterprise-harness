# ADR 0017 — Durable orchestration topology: pure workflow core, retry-safe activities, lease-bound fencing

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

ADR 0001 gives run, milestone and task durability, retries, timers, approvals and recovery to Temporal, and ADR
0013 allows exactly one durable orchestrator. Phase 2 left a sequential driver that composes framework-free,
individually idempotent step use cases (`packages/application/src/pipeline-steps.ts`), a lease-bound fencing
primitive for side effects, and a forge contract that tolerates a stale owner (compare-and-set push, PR content
that is a pure function of the attempt's facts, reconciliation before any terminal state). Phase 3 must make that
pipeline survive worker crashes, restarts, duplicate deliveries and pauses without a duplicate side effect, and
without letting PostgreSQL or the Temporal SDK become a second place where decisions are made.

## Decision

The orchestration has three layers, each with one job:

- **A pure decision core** (`packages/orchestration`). Given its input and the results of the steps so far, it
  returns the next step or the terminal outcome. It does no I/O, reads no clock and imports nothing but the
  contract types; a fitness rule holds it to that. Every routing rule (retries, replacement attempts, budgets,
  approvals, pause, assurance outcomes, publication reconciliation) lives here and is tested without an engine.
- **Retry-safe activities** (`packages/application/src/orchestration-activities`). Each activity wraps a Phase 2
  step use case behind the engine-neutral `ActivityExecutionContext` port: one delivery count, an abort signal, the
  last progress checkpoint, a logical `now` fixed for the execution, and a heartbeat. An activity may be delivered
  more than once; it is idempotent by natural key, and every durable side effect is recorded under the Phase 2
  workspace lease (`{ leaseId, fencingEpoch }`), so a superseded holder can never complete, fail or reopen a record.
  Verification commands reach the activity as approved command ids, resolved by a trusted catalog; no command string
  enters workflow history.
- **A thin Temporal adapter** (`adapters/temporal`). Workflows interpret the core's decisions, schedule the
  activities with explicit options, and carry only identifiers, references, closed enums and numbers in their
  inputs and messages (`task-workflow-input`, `run-workflow-input`, `workflow-control`, version 1.0.0). It is the
  only package that imports `@temporalio/*`. The API and CLI dispatch through the `WorkflowEngine` port.

Temporal history is authoritative for what runs next. PostgreSQL holds identity, leases, side-effect records,
approvals evidence, the budget ledger, audit and run events, and is a projection of the workflow's progress; no
activity reads a projected status to decide the next step. The harness never moves a task past
`WAITING_FOR_HUMAN_REVIEW`: `PAUSED`, `WAITING_FOR_APPROVAL` and `BUDGET_EXHAUSTED` join the task lifecycle, and no
machine transition reaches an accepted state.

## Consequences

A crash, a restart or a redelivery replays the core over recorded results and repeats only idempotent activities;
the lease fence and the forge contract keep a stale worker from producing a second effect. The core is testable
exhaustively without Temporal, and the SDK stays replaceable behind one adapter. The cost is discipline: workflow
code must stay deterministic and versioned, every activity needs a natural key and an explicit retry policy, and
the Temporal server becomes an operational dependency with its own retention, transport and credential settings.

## Revisit when

A second orchestrator is proposed, the lease primitive or the forge contract changes its guarantees, or measured
recovery evidence (the chaos matrix) shows a duplicate side effect or a lost terminal that this layering does not
prevent.
