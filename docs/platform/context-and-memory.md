# Context, Memory and Knowledge Fabric

## Five layers

1. **Authoritative:** Git, ProductSpec, ADR, Temporal/Run Ledger, evidence artifacts.
2. **Working state:** current task objective, hypotheses, changed files, failing checks, next action.
3. **Repository knowledge:** symbols, references, dependency graph, tests, ownership, runtime maps.
4. **Episodic memory:** prior attempts, failure signatures and debugging experiments.
5. **Skills:** reusable procedures.

## Context composer

A ContextPack is immutable and hashed. It contains only the specification excerpt, invariants, relevant files/symbols, current evidence, selected skills, policy and remaining budget. It does not include the full chat history or entire repository.

Retrieval should combine:

- lexical search (`ripgrep`);
- AST/Tree-sitter;
- LSP references/types;
- build/dependency graph;
- test-to-code map;
- Git history/change coupling;
- semantic retrieval for prose;
- runtime traces and incident links for brownfield.

## Mem0 decision

Mem0 is an optional `MemoryProvider` for episodic/preference/failure-pattern memory. It is never authoritative for requirements, workflow state, architecture, approval or evidence. Every record requires tenant/project scope, provenance, TTL and deletion controls. The workflow must continue if Mem0 is unavailable.

## Graphiti decision

Graphiti is an optional temporal relationship layer for brownfield Knowledge Fabric. Canonical symbol/call/dependency graphs still come from parsers, LSP, build systems and runtime data. Graph facts require provenance and retention/salience policies.

## Contradiction handling

Retrieved memories are candidates, not facts. The context engine:

1. checks provenance freshness against current SHA/spec;
2. detects contradictory candidates;
3. prefers canonical sources;
4. excludes unverified memory from R3/R4 decisions;
5. records whether memory changed the trajectory.
