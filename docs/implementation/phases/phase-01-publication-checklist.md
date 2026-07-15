# Phase 1 — Publication Checklist (executable gate)

> This checklist is backed by executable scanners under `scripts/`. Prose here
> documents intent; the gate that actually blocks a public push is
> `bash scripts/check-publication.sh` (which delegates to the secret and
> large-file scanners, each self-testing on a seeded canary — P1-CHANGE-006).
>
> **Public push is human-gated and happens at the end of session, not during
> Phase 1** (P1-CHANGE-007). Every item below MUST be green before that push.

## Executable gates (must pass)

| # | Gate | Command | Self-test |
|---|------|---------|-----------|
| 1 | License present + Apache-2.0 | `scripts/check-publication.sh` | n/a (presence check) |
| 2 | Secret scan clean | `scripts/secret-scan.sh` | seeded AWS-key canary must be caught |
| 3 | Large-file scan (no tracked file > 500KB) | `scripts/large-file-scan.sh` | seeded oversized canary must be caught |
| 4 | Absolute-path / internal-path leak scan | `scripts/check-publication.sh` | seeded `/Users/...` canary must be caught |
| 5 | Git-history secret scan | `scripts/check-publication.sh` | shared pattern lib — same set as HEAD scan (P1-FINAL-HIGH-003) |
| 6 | Dependency-license inventory (direct + transitive) | `scripts/license-inventory.sh` | GPL / unknown-license canary must be rejected (fail-closed) |
| 7 | PII scan (email / phone / SSN) | `scripts/pii-scan.sh` | seeded real-email / SSN / phone canary must be caught; placeholders allowlisted |

All of gates 2–7 are wired into `scripts/check-publication.sh` (the single
publication entry point) and into CI. The working-tree secret scan and the
git-history secret scan both `source scripts/lib/secret-patterns.sh`, so their
pattern sets can never diverge (P1-FINAL-HIGH-003).

## License approval record

- **License chosen:** Apache-2.0.
- **Approved by:** project owner (confirmed at plan-lock; recorded in
  `phase-01-plan.md` §13 and `phase-01-review-log.md` P1-CHANGE-006).
- **Provenance / attribution:** ASEP is a reference starter authored for this
  project. Copyright line reads `ASEP contributors`. Imported skills, templates
  and adapters (if any) must retain upstream license obligations per
  `LICENSE-POLICY.md`; none are vendored wholesale in Phase 1.

## Dependency-license review

Phase 1 domain packages have **zero third-party runtime dependencies**. The only
production dependency introduced is **AJV** (JSON Schema validator) in
`@asep/contracts`, which is **MIT-licensed**. Dev dependencies (`typescript`,
`tsx`, `@types/node`) are Apache-2.0 / MIT / MIT respectively. All are
permissive and compatible with Apache-2.0 redistribution.

- [x] No copyleft (GPL/AGPL) dependency in the tree.
- [x] AJV pinned to an exact version (no floating range).
- [x] Dev-dependency licenses are permissive.

Deep SCA (full transitive license audit + SBOM) is a **pre-public human step**
and is recorded as a production-pilot dependency, not a Phase 1 blocker.

## Git-history secret scan

Run before public push (history is short — single baseline commit plus the
Phase 1 slice commits):

```bash
git rev-list --all | while read -r sha; do
  git grep -nE 'AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}' "$sha" && exit 1
  true
done
```

- [ ] History scan returns no hits (verified at pre-publish step).

## Completion protocol

- [x] Publication gate is executable, not prose.
- [x] All scanners self-test on a seeded canary.
- [ ] Public push performed only after human approval at end of session
      (out of Phase 1 scope — P1-CHANGE-007).
