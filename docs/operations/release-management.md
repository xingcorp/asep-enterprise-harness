# Release Management

## Release candidate contents

- accepted task SHAs and dependency order;
- ProductSpec/ADR versions;
- build and environment manifests;
- verification/review evidence;
- migration and rollback plans;
- risk approvals;
- observability and alert readiness;
- known limitations.

## Rehearsal

Clean checkout, deterministic build, ephemeral deployment, migration forward/backward where supported, smoke and acceptance tests, restart/recovery, load/resilience checks and rollback.

## Progressive delivery

Preview → internal/canary → percentage rollout → full rollout. Observation windows and automatic rollback thresholds depend on risk. R3/R4 require human release approval.

## Post-release

Link runtime signals, incidents and product KPI changes back to run/task/attempt. Completion means the observation window passed, not merely merge success.
