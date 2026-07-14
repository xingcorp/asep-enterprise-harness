# ADR 0003 — Start the control plane as a modular monolith

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Bounded contexts are packages/modules; workers scale separately. Split services only from measured bottlenecks or trust boundaries.

## Consequences

Reduces distributed complexity while preserving future extraction.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
