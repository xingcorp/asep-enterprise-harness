# Brownfield Onboarding

## Principle

A legacy repository must earn write autonomy. The first problem is evidence and understanding, not generation.

## Pipeline

```text
Intake → clean-build attempt → baseline registry → runtime/dependency inventory
→ domain/ownership map → characterization tests → risk map
→ Agent Readiness Score → progressive autonomy
```

## Baseline registry

Capture pinned SHA, build status, known failures, flaky tests, security findings, architecture violations, performance baselines, runtime dependencies and environment assumptions. All later verification classifies failures as pre-existing, introduced, flaky or infrastructure.

## Knowledge Fabric

Combine source symbols/references, build dependencies, database schemas, runtime traces, logs, Git history/change coupling, incidents, tickets, docs and ownership. Semantic memory is supplemental; current code/runtime evidence wins.

## Safe modernization patterns

- Strangler Fig at system boundaries.
- Branch by Abstraction for deep components.
- Anti-Corruption Layer between old/new domains.
- Dual-run/shadow comparison before traffic cutover.
- Expand/contract and reversible migrations.

No big-bang rewrite.

## Autonomy map

Autonomy is keyed by repository + module + task type + risk, not repository alone.

```text
docs/**                   L4 low-risk automation
tests/**                  L3 agent PR
auth/**                   L1/L2 draft or tightly reviewed
legacy/billing/**         L1 read-only/draft
production-infra/**       L1 human-controlled
```

## Agent Readiness Score

Dimensions: build reproducibility, test strength, architecture clarity, documentation, observability, deployment safety, isolation, ownership, task modularity and historical stability.

- 0–30 read-only;
- 31–50 draft patch;
- 51–70 agent PR;
- 71–85 selected low-risk auto-merge;
- 86–100 bounded autonomous delivery.
