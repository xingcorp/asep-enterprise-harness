# 2. Bounded Contexts

ASEP starts as a modular monolith for the control plane and separates compute-heavy workers. Boundaries are enforced through packages, schemas and architecture tests before being split into services.

## Contexts

### Project Governance
Owns tenant, project, repository binding, autonomy level, risk policy, model/tool allowlists, ownership and compliance profile.

### Specification
Owns versioned product intent: objectives, scope, requirements, acceptance scenarios, NFRs, assumptions and Definition of Done. Imports from Spec Kit, BMAD or GSD are normalized here.

### Planning
Owns milestone DAGs, task dependencies, blast radius, required skills, risk classification and verification plans.

### Execution
Owns attempt lifecycle, context pack, provider session, workspace lease, tool invocations, budget and change set.

### Verification
Owns mandatory checks and immutable evidence. Agents may suggest checks but cannot remove mandatory checks.

### Review
Owns reviewers, findings, adjudication and re-review. Review does not mutate implementation worktrees.

### Integration and Release
Owns merge queue, contract compatibility, preview deployments, canary, rollback rehearsal and observation windows.

### Skill Governance
Owns skill packages, manifests, permissions, provenance, signatures, evaluation and promotion status.

### Knowledge and Memory
Owns derived indexes and non-authoritative memories. Canonical data remains in Git, ProductSpec, ADR, event history and artifacts.

### Evaluation and Experimentation
Owns benchmark sets, historical regressions, shadow runs, A/B tests, harness releases and scorecards.

## Dependency rule

```text
Domain → Contracts only
Application services → Domain + Ports
Adapters → Ports + provider SDKs
Workflow definitions → Application ports/contracts
UI/API → Application services
```

Provider SDK objects are forbidden in ProductSpec, WorkOrder, ReviewReport, database domain tables and Temporal workflow input/output.
