# Platform Definition of Done

A capability is done only when:

- domain behavior and API contract are versioned;
- authorization, tenant isolation and audit are implemented;
- unit/integration/contract/architecture tests pass;
- failure, retry, timeout, cancellation and idempotency behavior are tested;
- telemetry, metrics and dashboards exist;
- runbook and rollback exist;
- security/threat model is updated;
- documentation and examples are current;
- compatibility matrix and version policy exist;
- relevant evals pass with no unacceptable regression;
- production rollout has observation/rollback thresholds.

A provider integration additionally needs malformed-output, rate-limit, cancellation, budget, event-order, permission and artifact-capture tests.
