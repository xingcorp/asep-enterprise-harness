<!--
ASEP pull request template.
An agent cannot approve its own work; completion requires machine evidence and
independent review according to risk (see docs/platform/verification-and-review.md).
-->

## Summary

<!-- What changed and why. Link the WorkOrder / issue. -->

## Risk level

<!-- R0-R4 per policies/risk-policy.yaml. Justify the classification. -->

- [ ] Risk level assessed and stated: `R_`

## Verification evidence

<!-- Paste the canonical verify result or link the evidence bundle. Raw agent
     summaries are not evidence. -->

- [ ] `pnpm verify` passes locally
- [ ] Evidence captured (command, exit code, output/checksum)

## Independent review

- [ ] Reviewer is a different model family / independent human where risk requires
- [ ] All findings cite requirement, file/range, evidence, severity, required fix

## Scope and safety

- [ ] Change stays inside declared `allowedPaths`
- [ ] No provider/model SDK imported into domain contracts
- [ ] No secrets, credentials, or PII added
- [ ] No Phase 2+ scope added (Temporal runtime, real providers, memory, UI)

## Checklist

- [ ] Tests added or updated (no skipped/masked failures)
- [ ] Docs updated where behavior or contracts changed
