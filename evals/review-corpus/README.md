# Self-history review corpus

Labelled defects from this repository's own Phase 1 and Phase 2 reviews, collected for the descriptive
rediscovery measurement of `docs/implementation/phases/phase-04-plan.md` §7. This is collection only: packet
eligibility, the manifest and `corpusSha256` are frozen after the corpus protocol (§7.8) is confirmed.

- `collect.ts` reads the review documents, git and the local object store and writes the data below.
  Regenerate with `pnpm exec tsx evals/review-corpus/collect.ts --write` from the repository root.
- `self-history/items/<findingId>@<reviewedSha7>.json` — one labelled instance each (fields: data model §7.1).
- `self-history/blobs/<sha256>` — content-addressed excerpts of the cited files at the reviewed and post-fix
  trees. Each passes the repository's format, secret, PII, large-file and publication gates.
- `collect.test.ts` verifies every item and excerpt against the repository. Items from trees that only the
  local object store holds are marked excerpt-only; a clean clone verifies their excerpts by hash alone.

No ref to a pre-rewrite commit is ever created.
