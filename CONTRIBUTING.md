# Contributing

1. Start from an approved issue/ProductSpec/WorkOrder.
2. Keep changes within one bounded context where possible.
3. Add or update deterministic tests and relevant eval cases.
4. Update ADRs when changing a cross-cutting architectural decision.
5. Include evidence: commands, exit codes, environment and affected risks.
6. Do not add a framework dependency directly to domain packages.
7. Do not install external skills or use mutable images in production paths.
8. Run `pnpm verify` before review.
