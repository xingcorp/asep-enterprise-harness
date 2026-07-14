# Testing Strategy

## Pyramid plus architecture and product

- pure domain unit/property tests;
- contract tests for every port/adapter;
- integration tests with ephemeral dependencies;
- architecture fitness tests;
- product acceptance tests;
- security/adversarial tests;
- performance/resilience tests;
- end-to-end release rehearsals.

## Adapter contract tests

Every agent adapter must prove cancellation, timeout, budget accounting, event ordering, artifact capture, permission denial and version reporting. Memory adapters must prove tenant isolation, provenance, TTL and outage degradation. Output reducers must prove exit-code preservation and raw fallback.

## Harness chaos tests

- kill workflow worker mid-activity;
- restart sandbox manager;
- duplicate callback/message;
- object-store transient failure;
- stale workspace lease;
- provider timeout/rate limit;
- human approval expiry;
- model returns malformed structured output.

## Evaluation vs tests

Deterministic software behavior belongs in tests. Probabilistic agent behavior belongs in versioned evals with repeated runs and confidence intervals. Do not replace one with the other.
