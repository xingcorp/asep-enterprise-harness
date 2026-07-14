# ADR 0004 — One writer lease per worktree

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Parallel writers require separate worktrees/branches and locked contracts.

## Consequences

Prevents hidden races and incoherent shared state.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
