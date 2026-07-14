# ASEP — Autonomous Software Engineering Platform

**Reference architecture and implementation starter**  
**Research cut-off:** 2026-07-14  
**Language:** Vietnamese-first documentation; code/contracts in English.

ASEP is not a “single AI agent that keeps coding forever.” It is an engineering control system that turns product intent into small, governed, observable, reversible software changes.

## What is included

- Enterprise architecture and C4/Mermaid diagrams.
- Greenfield and brownfield onboarding models.
- Durable orchestration and state-machine design.
- Multi-agent roles, handoff contracts and cross-model review.
- Skill registry, routing, quarantine and evaluation model.
- Canonical state, context engineering, memory and knowledge-fabric design.
- Verification, review, measurement, evaluation and learning flywheel.
- Security, tenancy, audit, incident response and release governance.
- Technology radar covering Temporal, Claude Code, Codex, OpenHands, ADK, DeerFlow, Spec Kit, Open Design, Mem0, Graphiti, RTK, Caveman and related projects.
- A small TypeScript reference kernel that can be run and extended.
- Local development Compose stack for PostgreSQL, Temporal, MinIO and observability components.
- 90-day plan, backlog, acceptance gates and ADRs.

## Start here

1. Read [`START-HERE.md`](START-HERE.md).
2. Review [`docs/architecture/01-system-overview.md`](docs/architecture/01-system-overview.md).
3. Accept or amend the ADRs in [`docs/architecture/adr`](docs/architecture/adr).
4. Run the reference kernel:

```bash
corepack enable
pnpm install
pnpm test
pnpm dev
```

5. Start optional local infrastructure:

```bash
cp .env.example .env
pnpm infra:up
```

## Architectural thesis

1. **Git, PostgreSQL, Temporal history and immutable artifacts are authoritative.** Model memory is not.
2. **Temporal owns long-lived workflow state.** ADK, OpenHands, DeerFlow or other agent runtimes are bounded execution providers.
3. **An agent cannot approve its own work.** Completion requires machine evidence and independent review according to risk.
4. **Only one writer owns a worktree.** Other agents are read-only or use separate branches/worktrees.
5. **Greenfield is designed agent-native. Brownfield earns autonomy progressively.**
6. **Every framework is behind a port.** No provider SDK enters domain code.
7. **Measurement is part of the product.** Cost, quality, review yield, false completion, recovery and production outcome are first-class data.

## Status

This repository is a **reference starter**, not a finished SaaS. The code intentionally implements the smallest deterministic kernel and contracts first. Provider adapters, full Temporal activities, Kubernetes isolation and production credential brokers are staged in the roadmap.
