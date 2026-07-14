# 90-Day Implementation Plan

## Days 1–15 — Evaluation and contracts

- choose one pilot repository and 30–50 historical tasks;
- approve ProductSpec, WorkOrder, ContextPack, Evidence and Review schemas;
- implement risk taxonomy and mandatory verification matrix;
- establish baseline metrics and failure taxonomy;
- accept ADRs and source/technology radar.

Exit: historical tasks can be represented and graded deterministically.

## Days 16–30 — Single-agent vertical slice

- control-plane modular monolith;
- GitHub/forge integration;
- worktree/sandbox manager;
- one coding adapter;
- trusted command runner and artifact store;
- create PR with evidence; no automatic merge.

Exit: at least ten pilot tasks complete with full traceability.

## Days 31–45 — Durable orchestration

- Temporal workflows/activities;
- pause/resume/cancel, heartbeats, retries and idempotency;
- worker-kill and duplicate-callback chaos tests;
- budgets and approvals.

Exit: workflows recover without duplicate side effects.

## Days 46–60 — Independent assurance

- second model/provider reviewer;
- review schema, repair/re-review and adjudication;
- architecture/security checks;
- dashboards for false completion, review yield, cost and recovery.

Exit: reviewer performance measured on historical defects.

## Days 61–75 — Skill and context platform

- signed internal registry;
- vendor selected Agent Skills/Superpowers workflows;
- repository index with lexical/AST/LSP/dependency/test maps;
- immutable ContextPack and provenance.

Exit: routing and context changes are evaluated, not anecdotal.

## Days 76–90 — Brownfield and production hardening

- baseline/characterization/onboarding pipeline;
- module autonomy map and readiness score;
- network/credential policies, tenant boundaries and retention;
- canary harness release process;
- optional OpenHands/Spec Kit adapter trial.

Exit: production pilot has rollback, incident runbook and SLO dashboards.
