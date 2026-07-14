# ADR 0005 — All agent/model frameworks stay behind ports

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

No Claude/Codex/ADK/OpenHands SDK type enters domain contracts.

## Consequences

Model/runtime replacement and compatibility testing become possible.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
