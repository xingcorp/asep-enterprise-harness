# Incident Response

## Immediate actions

1. pause affected workflows/provider/skill/harness version;
2. revoke workspace credentials and network access;
3. preserve Temporal history, Run Ledger, context pack, tool events, raw output, diff and artifacts;
4. identify affected tenants/projects/commits/releases;
5. rollback or contain production change;
6. communicate with explicit evidence and uncertainty.

## Root-cause dimensions

- product/spec ambiguity;
- task decomposition;
- context/retrieval;
- model/provider;
- skill;
- tool interface;
- sandbox/infra;
- verification gap;
- reviewer gap;
- policy/approval;
- integration/release;
- runtime observability.

## Mandatory learning output

Every material incident creates a regression test/eval, updates the failure taxonomy, links the responsible run/attempt/config versions, and identifies the sensor/policy that should have prevented or detected it. Harness changes follow shadow/canary rollout.
