# ADR 0006 — Use R0–R4 risk-based gates

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Verification, independent review, human approval and release rules are selected deterministically from risk.

## Consequences

Avoids both unsafe uniform autonomy and excessive review for mechanical changes.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
