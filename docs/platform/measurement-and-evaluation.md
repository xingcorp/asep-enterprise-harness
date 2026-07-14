# Measurement and Evaluation

## Three control loops

### Inner attempt loop
Measures context quality, tool trajectory, scope, loops, cost and fast verification.

### Delivery loop
Measures requirement acceptance, review/repair efficiency, integration, lead time and change failure.

### Product loop
Measures runtime reliability, customer defects, business KPI effects and incidents.

## Metric families

### Product
Requirement acceptance, user-journey success, product KPI delta, customer defects and time-to-value.

### Delivery
DORA metrics, PR/change size, deployment rework and rollback.

### Agent
Resolution, first-attempt pass, false completion, repair cycles, scope violations, unnecessary changes and abandonment.

### Trajectory
Expected/forbidden tool use, repeated calls, read-before-write, test-after-change, checkpoint compliance and skill routing precision.

### Quality
Architecture violations, duplication/complexity delta, dependency cycles, mutation score, test quality, API compatibility and documentation freshness.

### Review
Valid finding yield, false positives, duplicate findings, escaped findings, repair success, override rate, cost and latency.

### Harness reliability
Recovery success, duplicate side effects, orphan workspaces, artifact loss, stuck runs, sandbox failures and replay errors.

### Economics
Cost per accepted task, human minutes, rework cost, escaped-defect cost and cost per production-proven outcome.

## Key formulas

```text
False completion rate = agent-declared-complete attempts failing required assurance / declared-complete attempts
Accepted-task cost = all model + compute + review + human allocation / accepted tasks
Review yield = confirmed actionable findings / total findings
Escape rate = post-merge defects that mapped review should catch / mapped defects
```

## Evaluation hierarchy

1. synthetic unit tasks;
2. repository fixtures;
3. historical bugs;
4. historical PRs;
5. production incidents;
6. adversarial/security tasks;
7. long-horizon simulations.

## Harness changes

Every model, prompt, skill, tool description, context algorithm or reducer change goes through offline replay, shadow execution, canary and rollback thresholds. Public benchmarks inform discovery; internal tasks decide promotion.

## Telemetry privacy

Trace identifiers and usage metadata are captured by default. Full prompts/source/tool content are opt-in, redacted and governed by retention/access policies. Large artifacts are referenced, not embedded in spans.
