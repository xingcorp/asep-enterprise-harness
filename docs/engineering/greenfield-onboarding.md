# Greenfield Onboarding

## Goal

Create an agent-native repository where the correct path is easier than a creative shortcut.

## Bootstrap gates before feature work

- product and architecture constitutions;
- modular boundaries and ownership;
- clean reproducible build;
- lint/type/test/architecture checks;
- telemetry/logging conventions;
- security baseline and dependency policy;
- migration/rollback rules;
- feature flags and preview environments;
- short `AGENTS.md` index pointing to versioned docs;
- generators/golden paths for services, endpoints, migrations and workers.

## Recommended initial architecture

Use a modular monolith unless independently scalable reliability/ownership boundaries are already proven. Every module exposes contracts and is protected by architecture tests.

## Autonomy progression

1. agent creates patch;
2. agent creates PR;
3. agent repairs deterministic/reviewer findings;
4. R0/R1 auto-merge after evidence;
5. bounded canary/release automation.

Autonomy is revoked automatically when change-failure, false-completion, policy violation or escaped-defect thresholds regress.

## Definition of agent-ready

- task can be described with stable acceptance criteria;
- expected path has templates/tools;
- test and preview feedback is fast;
- repository docs are discoverable and current;
- failure/rollback is cheap;
- secrets and network are isolated.
