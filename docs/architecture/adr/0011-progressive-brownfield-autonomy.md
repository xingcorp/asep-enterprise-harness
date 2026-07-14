# ADR 0011 — Brownfield autonomy is module/task/risk specific

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Repositories begin read-only/baseline and earn write/merge rights through readiness score and outcomes.

## Consequences

Prevents unsafe repository-wide autonomy.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
