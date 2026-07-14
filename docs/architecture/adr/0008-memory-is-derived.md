# ADR 0008 — Mem0/Graphiti are optional derived knowledge

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Mem0 stores episodic candidates; Graphiti stores temporal relationships; neither decides workflow/approval.

## Consequences

Improves retrieval without making probabilistic memory authoritative.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
