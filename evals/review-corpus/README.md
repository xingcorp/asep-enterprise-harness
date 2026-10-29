# Self-history review corpus

Labelled defects from this repository's own Phase 1 and Phase 2 reviews, collected for the descriptive
rediscovery measurement of `docs/implementation/phases/phase-04-plan.md` §7. This is collection only: packet
eligibility, the manifest and `corpusSha256` are frozen after the corpus protocol (§7.8) is confirmed.

- `collect.ts` reads the review documents, git and the local object store and writes the data below.
  Regenerate with `pnpm exec tsx evals/review-corpus/collect.ts --write` from the repository root.
- `self-history/items/<findingId>@<reviewedSha7>.json` — one labelled instance each (fields: data model §7.1).
- `self-history/blobs/<sha256>` — content-addressed excerpts of the cited files at the reviewed and post-fix
  trees. Each passes the repository's format, secret, PII and large-file scripts and the path-leak scan of
  `scripts/check-publication.sh`, run in a temporary repository that tracks only the excerpts. A gate that does not
  finish with its documented exit code, or a git command that fails, aborts collection before anything is written.
- `collect.test.ts` verifies every item and excerpt against the repository. A tree or fix commit that exists only
  in history the rewrite removed has reachability `private-bundle-only`: the local object store and the controller's
  private bundle hold it, a clean public clone does not. Such items are excerpt-only and carry
  `dependsOnPrivateBundle: true`; a clean clone verifies their excerpts by hash alone. A reviewed tree that cannot be
  identified is never guessed: its items are excluded `reviewed-tree-unknown`.

No ref to a pre-rewrite commit is ever created.
