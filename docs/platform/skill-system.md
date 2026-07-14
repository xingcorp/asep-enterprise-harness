# Skill System

## Role of a skill

A skill is versioned procedural knowledge, not an agent, tool, permission or workflow engine. A skill may contain instructions, checklists, scripts, references, templates and expected evidence.

## Governance lifecycle

```text
External source
→ quarantine
→ license/provenance scan
→ prompt-injection and tool-permission review
→ static validation
→ sandbox behavioral eval
→ human approval
→ signing and pinning
→ internal registry
→ canary
→ promoted/deprecated/revoked
```

Production agents never install public skills directly.

## Routing

1. deterministic filter by phase, task type, risk, language, tool availability and compatibility;
2. semantic ranking;
3. conflict/deduplication resolution;
4. permission intersection with project policy;
5. budget enforcement;
6. progressive loading.

Default surface per attempt:

- one primary process skill;
- zero to two adjunct specialist skills;
- one verification bundle.

## Sources and support level

- Addy Osmani Agent Skills: import selected engineering skills; preserve provenance; run internal evals.
- Superpowers: import planning, TDD, debugging, verification-before-completion and independent review patterns.
- Spec Kit: importer for specification artifacts and governance presets.
- BMAD: discovery/workshop input, not execution control.
- Open GSD Core: methodology reference and optional importer, not canonical state.
- Agentic Awesome Skills: discovery only; zero-trust quarantine.

## Skill metrics

- trigger precision/recall;
- task pass-rate delta;
- false-completion delta;
- token/tool overhead;
- policy violations;
- model portability;
- finding yield;
- regression rate.

A skill is removed when it does not improve accepted-task cost or quality on the target distribution.
