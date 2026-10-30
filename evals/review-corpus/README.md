# Self-history review corpus

Labelled defects from this repository's own Phase 1 and Phase 2 reviews, collected for the descriptive rediscovery
measurement of `docs/implementation/phases/phase-04-plan.md` §7. The committed manifest is a **provenance-stage
freeze** (R44): the final freeze — packet eligibility (`not-in-packet`, `egress-stopped`), the full packet sources, the
packet-dependent synthetic fields and the final `corpusSha256` — is S19 integration, after S0 and SR-X8. Nothing may
bind to the provenance-stage `corpusSha256`, and nothing here is the frozen corpus.

## Collection

- `collect.ts` reads the review documents, git and the local object store and writes the items and excerpts.
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

## Provenance-stage freeze

- `freeze.ts` reads the items, `self-history/annotations.json` and git, and writes `self-history/manifest.json` and
  `self-history/mapping/<sha256>`. Regenerate with `pnpm exec tsx evals/review-corpus/freeze.ts --write`. A second
  run on the same tree writes the same bytes (`freeze.test.ts`).
- Exclusions apply in the protocol's order (plan §7.8), the first that applies wins: collection's provenance rules
  (`plan-defect`, `reviewed-tree-unknown`, `excerpt-unpublishable`), the freeze rule `no-location`, and
  `leakage-filtered` (every cited file is removed by rule P's leakage filter). `not-in-packet` and `egress-stopped`
  need the runtime packet builder and egress decision: the final freeze applies them after S0 and SR-X8. The
  manifest names them as pending and never counts them.
- Each included item lists its `uses`: `rediscovery` (a first occurrence, rule P), `residual-status` (a residual,
  rule C) and `post-fix-negative` (resolved at the next re-review with a known post-fix tree). Fix commits are
  provenance only and never decide a use; an item that names no fix commit (15 included residuals) is used for its
  residual status only and is never described as fixed.
- `annotations.json` holds, per finding id of an included item, Lane B's gold category (category table
  `corpus-categories/v1`), its one-line rationale and the defect class. The freeze refuses a missing, stray or
  invalid annotation.
- `mapping/<sha256>` holds, for every negative candidate (an included item resolved at the next re-review whose
  post-fix tree is known), each cited file's section of the rule-P diff between the reviewed and the post-fix
  tree; the post-fix location mapping reads them. Each passes the publication gates before it is stored.
- `manifest.json` carries `stage: "provenance"` and a note saying what the final freeze adds. It lists every item with the sha256 of its file, its set, label source and quality, the exclusion
  that applies and the gold annotation; the review cycles; the counts the report needs; and the blob and diff
  indexes. `corpusSha256` is the sha256 of the manifest body's canonical JSON (keys sorted, no whitespace), so it
  covers every item byte, every annotation and every stored excerpt.
- `corpus-verifier.test.ts` verifies the manifest, every hash, the exclusion counts, the diff sections against git,
  that no ref names a pre-rewrite commit, and that every excerpt and diff section passes the publication gates.
  Bundle mode runs only when the controller supplies the bundle path.

No ref to a pre-rewrite commit is ever created.
