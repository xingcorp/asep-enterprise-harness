# 1. System Overview

## Problem statement

Long-running coding agents fail when the transcript becomes the project manager, the memory store, the source of truth and the approval system at the same time. Context compaction loses detail; tools fail; workers restart; models change; multiple agents make incompatible assumptions; tests can be incomplete; a persuasive agent can declare success without product evidence.

ASEP separates those responsibilities.

## C4 Level 1 — System context

```mermaid
C4Context
  title ASEP System Context
  Person(product, "Product/Engineering Team", "Defines goals, constraints and approvals")
  System(asep, "ASEP", "Governed autonomous software engineering platform")
  System_Ext(git, "Source Control", "Repositories, branches, pull requests")
  System_Ext(ci, "CI/CD and Environments", "Build, preview, release, rollback")
  System_Ext(models, "Agent/Model Providers", "Claude Code, Codex, OpenHands and others")
  System_Ext(issues, "Issue/Product Systems", "Requirements and planning inputs")
  System_Ext(obs, "Observability/Security", "Metrics, traces, logs, SIEM")

  Rel(product, asep, "Creates specs, approves high-risk actions, reviews outcomes")
  Rel(asep, git, "Reads repositories; creates branches, commits and PRs")
  Rel(asep, ci, "Runs verification, preview, release rehearsal")
  Rel(asep, models, "Dispatches bounded work orders")
  Rel(asep, issues, "Imports requirements; updates state")
  Rel(asep, obs, "Exports telemetry and audit events")
```

## C4 Level 2 — Containers

```mermaid
flowchart TB
  UI[Web Console / CLI / IDE] --> API[Control Plane API]
  API --> PG[(PostgreSQL)]
  API --> TW[Temporal]
  TW --> WW[Workflow Workers]
  WW --> AR[Agent Runtime Workers]
  WW --> VW[Verification Workers]
  WW --> IW[Integration/Release Workers]
  AR --> SB[Sandbox Manager]
  SB --> WT[Ephemeral Worktrees]
  AR --> MR[Model Router]
  MR --> P1[Claude/Codex/OpenHands adapters]
  AR --> SK[Skill Registry]
  AR --> KE[Context & Knowledge Engine]
  VW --> CI[Build/Test/Scanner services]
  AR --> AS[(Object Storage)]
  VW --> AS
  IW --> GIT[Git Forge]
  API --> OTEL[OTel Collector]
  WW --> OTEL
  AR --> OTEL
  VW --> OTEL
```

## Core invariants

1. A run can be reconstructed without model transcripts.
2. Every accepted commit has a ProductSpec, WorkOrder, Attempt, VerificationResult and ReviewReport according to risk.
3. A model cannot write outside an isolated workspace or acquire permissions through prompt content.
4. One worktree has one writer lease.
5. Machine-readable raw evidence is captured before any output compression.
6. An experimental adapter cannot become critical-path by configuration accident.
7. Brownfield modules receive autonomy independently; repository-level autonomy is not assumed.
8. The same model may implement and self-review, but independent approval requires fresh context and policy-defined independence.

## Why two orchestration layers

- **Temporal/business orchestration:** survives days, crashes, approvals, retries and deployments.
- **Agent-session orchestration:** bounded reasoning, tools, subagents and context within a single activity/attempt.

ADK, LangGraph, DeerFlow or OpenHands may implement the second layer. They do not own canonical Run/Milestone state.
