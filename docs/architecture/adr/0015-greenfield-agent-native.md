# ADR 0015 — Greenfield repositories use golden paths and fitness functions

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

ASEP must operate for long periods, across model/provider changes, crashes and high-risk software changes. The decision must remain auditable and reversible.

## Decision

Generators, short documentation indexes, architecture tests, feature flags and preview environments are bootstrap requirements.

## Consequences

Makes correct implementation easier and agent output maintainable.

## Revisit when

Measured production evidence invalidates the assumptions, or a replacement passes compatibility, recovery, security and cost/quality evaluation.
