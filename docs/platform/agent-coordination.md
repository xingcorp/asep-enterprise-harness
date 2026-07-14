# Agent Coordination

## Default topology

ASEP uses a supervisor DAG, not a free-form group chat.

```text
Specification Agent
→ Architecture Agent + independent critic
→ Planner
→ [read-only Explorer, Test Designer, Risk Analyst] in parallel
→ single Implementer writer
→ deterministic Verifier
→ independent Reviewer
→ specialist reviewers by risk
→ Integrator
→ Release Agent
```

## Communication contract

Agents exchange typed artifacts only:

- `WorkOrder`
- `ContextPack`
- `ExplorationReport`
- `TestDesign`
- `ChangeSet`
- `VerificationResult`
- `ReviewReport`
- `RepairOrder`
- `DecisionRecord`

No agent should infer completion or ownership from conversational statements.

## Writer rule

One worktree has exactly one writer lease. Explorers and reviewers are read-only. Parallel implementation uses separate worktrees and locked contracts. Merge occurs only through an integration branch/queue.

## Cross-model review

Recommended high-risk pattern:

```text
Claude implement → deterministic verification → Codex blind review
→ Claude repair → verification rerun → Codex re-review
```

or the reverse. The actual providers are selected from historical performance and availability; the architecture never hardcodes Claude as implementer.

Independence dimensions:

- fresh context;
- different model family/provider when policy requires;
- different objective and rubric;
- hidden acceptance cases;
- separate workspace permissions.

## Adjudication

1. Reviewer emits evidence-based finding.
2. Implementer may accept or refute with machine evidence.
3. Verifier runs the discriminating check.
4. A fresh adjudicator decides unresolved ambiguity.
5. Human owns critical ambiguity.

Maximum default: two repair cycles and one adjudication. Infinite agent debate is forbidden.

## When multi-agent helps

Use parallel agents for bounded, independent read-heavy work: repository maps, threat models, test design, dependency research. Avoid parallel writers on shared contracts, migrations, schemas and shared domain models.
