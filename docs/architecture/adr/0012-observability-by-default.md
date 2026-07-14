# ADR 0012 — Telemetry and evaluation are product capabilities

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Every run/task/attempt/tool/artifact is correlated; full source/prompt capture is opt-in.

## Consequences

Enables quality/cost/recovery learning while protecting data.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
