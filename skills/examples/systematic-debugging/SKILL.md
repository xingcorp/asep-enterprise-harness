---
name: systematic-debugging
description: Use when a reproducible failure must be diagnosed before changing implementation. Requires evidence, hypotheses and discriminating tests.
---

# Procedure

1. Reproduce and classify baseline vs introduced vs flaky vs infrastructure.
2. Capture the smallest trusted failure artifact.
3. Build a dependency/control-flow map.
4. List competing hypotheses with predicted observations.
5. Run the cheapest discriminating check.
6. Change one causal variable at a time.
7. Add a regression test before or with the fix.
8. Rerun affected and mandatory checks.
9. Record rejected hypotheses and evidence.

# Stop conditions

Stop and escalate when reproduction is impossible, permissions/evidence are missing, budget is exhausted, or two repair cycles make no causal progress.
