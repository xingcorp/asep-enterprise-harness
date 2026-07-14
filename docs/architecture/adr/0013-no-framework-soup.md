# ADR 0013 — One owner per architectural responsibility

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

One durable orchestrator and one canonical state model; optional agent runtimes cannot duplicate ownership.

## Consequences

Controls operational complexity and ambiguous recovery.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
