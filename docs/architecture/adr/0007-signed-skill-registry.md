# ADR 0007 — Use a signed internal skill registry

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

External skill repositories are discovery/vendor sources; production workers never install them directly.

## Consequences

Reduces semantic supply-chain and reproducibility risks.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
