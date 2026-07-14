# SLO and Alerting

## Platform SLOs

- workflow recovery success ≥ 99.9%;
- accepted artifact loss = 0;
- duplicate irreversible side effect = 0;
- untraceable accepted commit = 0;
- production secret exposed to model context = 0;
- orphan workspace older than lease grace = 0;
- audit event coverage for privileged actions = 100%.

## Alerts

Page/security alert:
- duplicate release/merge/deletion side effect;
- secret/DLP finding;
- tenant boundary breach;
- audit pipeline loss;
- unsigned skill execution.

Operational alert:
- stuck-run rate;
- workflow retry storm;
- sandbox capacity/startup failures;
- artifact-store errors;
- provider error/cost spike;
- false-completion regression;
- reviewer escape/false-positive regression.

## Error budget policy

When reliability or quality error budgets are exhausted, freeze autonomy promotions and harness/model upgrades; shift capacity to recovery, eval and guardrail improvements.
