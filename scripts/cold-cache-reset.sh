#!/usr/bin/env bash
# Cold-cache reset for the canonical gate (called by verify-all.sh BEFORE
# typecheck).
#
# `tsc -b` emits (the base config is composite), and pnpm symlinks every
# workspace package into node_modules. Once a `dist/` exists, TypeScript can
# resolve a cross-package import through that symlink even when the importing
# project declares no reference for it, so a warm tree passes where a clean CI
# checkout fails. This step removes every `dist` and `*.tsbuildinfo` outside
# node_modules so the next step is the cold build.
#
# FAIL-CLOSED. A reset that cannot remove an artifact must not report success:
# a surviving `dist/` is exactly the stale output the step exists to destroy.
# So every removal's exit status is checked, and afterwards the tree is scanned
# again; any survivor fails the step and is named. Nothing here swallows errors.
#
# Usage:
#   scripts/cold-cache-reset.sh [root]   # default root: the repository root
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# Every build artifact outside node_modules, NUL-separated: anything NAMED
# `dist` (directory, file or symlink — a symlinked dist feeds stale output just
# the same) and any `*.tsbuildinfo`. node_modules is pruned at every depth, and
# a matched dist is pruned so its own contents are not listed twice.
list_artifacts() {
  find . -name node_modules -prune -o \
    \( -name dist -o -name '*.tsbuildinfo' \) -print0 -prune
}

failed=0
while IFS= read -r -d '' artifact; do
  if ! rm -rf -- "$artifact"; then
    echo "cold-cache reset: could not remove ${artifact#./}" >&2
    failed=1
  fi
done < <(list_artifacts)

survivors=()
while IFS= read -r -d '' artifact; do
  survivors+=("${artifact#./}")
done < <(list_artifacts)

if [ "${#survivors[@]}" -gt 0 ]; then
  echo "cold-cache reset: FAIL — build artifacts survived the reset:" >&2
  printf '  %s\n' "${survivors[@]}" >&2
  exit 1
fi
if [ "$failed" -ne 0 ]; then
  echo "cold-cache reset: FAIL — a removal reported an error" >&2
  exit 1
fi
echo "cold-cache reset: PASS (no dist/ or *.tsbuildinfo outside node_modules; next step is a cold tsc -b)"
