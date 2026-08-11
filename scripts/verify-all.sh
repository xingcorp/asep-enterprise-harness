#!/usr/bin/env bash
# Canonical full-gate entry point for the ASEP repository (P1-FINAL-MED-004).
#
# THE single source of truth for "is this tree acceptable". Both the developer
# (`pnpm verify:all`) and CI invoke this exact script, so the local gate and the
# CI gate can never silently diverge: adding a step here adds it to both. The
# previous split — a thin local `verify` (format+typecheck+test only) alongside
# a CI workflow that hand-chained eleven separate steps — let checks drift out
# of the developer's reach and made "green locally, red in CI" routine.
#
# Ordering is cheapest-first so a fast failure (formatting) short-circuits before
# an expensive one (full test matrix, git-history secret scan). Every step is a
# self-testing gate that fails RED on any problem (P1-CHANGE-009); nothing here
# is advisory.
#
# Steps (in order):
#   1.  format:check                — whitespace/newline/CRLF/tab structural lint
#   2.  typecheck                   — tsc -b --strict across the whole build graph
#   3.  test                        — full workspace test matrix (tsx --test)
#   4.  contracts test              — schema + fixture validation (@asep/contracts)
#   5.  policy test                 — parity + taxonomy tests (@asep/policy)
#   6.  contracts compat:gate       — live schemas vs frozen v1 snapshots
#   7.  forbidden-imports fitness   — no provider SDK / live-network in domain pkgs
#   8.  scan:secret                 — working-tree secret scan (self-testing)
#   9.  scan:large-file             — oversized-blob scan (self-testing)
#   10. scan:pii                    — PII scan (self-testing)
#   11. check:publication           — license, abs-path, git-history, dep-license
#   12. clean-tree assertion        — no generated/untracked files after the run
#
# The acceptance-marker gate (scripts/check-acceptance.sh) is intentionally NOT
# part of verify:all: it binds a reviewed HEAD and is checked separately at the
# acceptance step, because a valid marker cannot exist until AFTER verify:all is
# green and the independent review has run. Running it here would make the gate
# fail on every in-progress commit by construction.
#
# Usage:
#   scripts/verify-all.sh            # run the full gate
#   pnpm verify:all                  # same, via the npm alias
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Run a named step, printing a banner. `set -e` aborts the script on the first
# non-zero step, so the first failing gate is the one the developer sees.
step() {
  local label="$1"; shift
  echo ""
  echo "=== verify:all [$label] ==="
  "$@"
}

step "format:check"        pnpm format:check

# Cold-cache reset, and it must run BEFORE typecheck.
#
# `pnpm typecheck` is `tsc -b`, which walks the project-reference graph AND emits
# (the base config is composite, so a typecheck populates dist/). pnpm also
# symlinks every workspace package into node_modules, so once dist/ exists TS can
# resolve a cross-package import through that symlink even when the importing
# project declares no reference for it. The two resolution paths mask each other:
#
#   warm tree (dist/ present) -> resolves via node_modules      -> PASS
#   clean checkout (no dist/) -> tsc -b mis-orders the build     -> TS2307
#
# CI checks out fresh, so a gate that only ever ran warm was certifying a
# condition CI does not have. Wiping dist/ and *.tsbuildinfo here makes the very
# next step the cold build — the condition CI actually runs under. The output that
# cold compile emits is reused by the later test steps, so this costs one cold
# compile rather than an extra pass. `scripts/project-references.test.ts` is the
# companion guard that names the offending project instead of only failing.
step "cold-cache reset"
find . -path ./node_modules -prune -o -name dist -type d -print 2>/dev/null \
  | grep -v node_modules | xargs rm -rf 2>/dev/null || true
find . -path ./node_modules -prune -o -name '*.tsbuildinfo' -print 2>/dev/null \
  | grep -v node_modules | xargs rm -f 2>/dev/null || true
echo "cold-cache reset: PASS (dist/ + *.tsbuildinfo removed; next step is a cold tsc -b)"

step "typecheck"           pnpm typecheck
step "test"                pnpm test
step "contracts test"      pnpm --filter @asep/contracts test
step "policy test"         pnpm --filter @asep/policy test
step "contracts compat"    pnpm --filter @asep/contracts compat:gate
step "forbidden-imports"   pnpm exec tsx --test scripts/forbidden-imports.test.ts
step "project-references"  pnpm exec tsx --test scripts/project-references.test.ts
step "scan:secret"         pnpm scan:secret
step "scan:large-file"     pnpm scan:large-file
step "scan:pii"            pnpm scan:pii
step "check:publication"   pnpm check:publication

# Clean-tree assertion: verify:all must not leave generated/untracked files
# behind. A dirty tree after the gate means a step wrote into the worktree
# (generated types, build output escaping dist/, a stray temp file) — that is a
# reproducibility bug and fails the gate (mirrors the CI clean-tree step).
step "clean-tree"
if [ -n "$(git status --porcelain)" ]; then
  echo "clean-tree: FAIL — working tree is dirty after verify:all:" >&2
  git status --porcelain >&2
  exit 1
fi
echo "clean-tree: PASS"

echo ""
echo "=== verify:all: PASS (all gates green) ==="
