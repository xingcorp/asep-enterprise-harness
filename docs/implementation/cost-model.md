# Cost Model

Track model input/output, provider charges, sandbox compute, build/test infrastructure, artifact/telemetry storage, reviewer cost, human time and rework/escaped-defect cost.

Primary economic metric:

```text
(total attempt + review + compute + allocated human + rework cost)
/ production-proven accepted outcomes
```

Budgets exist at tenant, project, run, milestone, task and attempt levels. Crossing a soft threshold triggers routing/compaction review; hard thresholds pause or escalate. Never reduce verification to meet model budget.
