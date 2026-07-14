# Verification and Review

## Assurance ladder

- L0 workspace integrity and scope.
- L1 format, lint, type, forbidden dependencies.
- L2 unit/property/mutation checks.
- L3 integration and contract tests.
- L4 architecture fitness functions.
- L5 security, secrets, SAST/SCA and threat-specific tests.
- L6 product acceptance and UI/browser/device flows.
- L7 performance, resilience, accessibility, backup/restore and migration safety.
- L8 independent review.
- L9 clean-build, preview, release and rollback rehearsal.

Risk policy selects mandatory levels. An implementer may add checks but cannot skip mandatory checks.

## Review stages

1. Product/spec review before implementation.
2. Architecture and testability review.
3. Continuous deterministic sensors during implementation.
4. Implementer self-review.
5. Blind independent review.
6. Specialist review based on risk.
7. Human approval at policy gates.
8. Post-merge runtime review during observation window.

## Reviewer rubric

Reviewers must cite requirement, file/range, evidence, severity and required fix. Generic comments do not block. Metrics optimize valid finding yield, escaped defect rate and false-positive rate—not number of comments.

## Hidden tests

For high-risk work, acceptance cases may be withheld from the implementer to reduce gaming. Hidden tests must still be versioned, audited and reproducible by the assurance service.

## Raw evidence rule

Test exit code, stdout/stderr, machine output, environment digest and command must be captured by the trusted runner. Agent summaries and RTK/Caveman output are never evidence.
