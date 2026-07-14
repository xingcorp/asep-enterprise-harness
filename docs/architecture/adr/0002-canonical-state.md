# ADR 0002 — Canonical state is Git + PostgreSQL + Temporal history + immutable artifacts

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Memory/vector/agent transcripts are derived and non-authoritative.

## Consequences

Enables replay, audit and compliance; adds explicit schemas and artifact retention.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
