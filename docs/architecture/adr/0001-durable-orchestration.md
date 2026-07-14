# ADR 0001 — Use Temporal for long-lived business workflows

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Temporal owns run/milestone/task durability, retries, timers, approvals and recovery. Agent runtimes execute bounded activities only.

## Consequences

Avoids transcript/RAM state and duplicate side effects. Requires deterministic workflow code, idempotent activities and operational expertise.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
