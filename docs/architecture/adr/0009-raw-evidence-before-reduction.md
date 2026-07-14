# ADR 0009 — Capture raw output before any compression

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Trusted runner owns exit code/stdout/stderr and immutable artifacts; RTK/Caveman never sit on verifier path.

## Consequences

Prevents false success and lost diagnostics.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
