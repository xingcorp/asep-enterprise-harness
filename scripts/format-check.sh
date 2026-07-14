#!/usr/bin/env bash
# Dependency-free format + structural lint gate for the ASEP repository.
#
# This repo intentionally keeps a minimal dependency tree (no prettier/eslint in
# the kernel). tsc --strict + this script together provide the format/lint gate:
#   - no trailing whitespace in code files (.ts/.json/.yaml/.yml/.sh)
#   - no hard tabs in .ts/.json/.yaml/.yml (two-space indentation is the norm)
#   - every text file ends with a newline
#   - no CRLF line endings anywhere
#
# Markdown (.md) is exempt from trailing-whitespace (two-space = hard line break)
# but still checked for CRLF and final newline.
#
# Usage: scripts/format-check.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail=0

is_code() { [[ "$1" =~ \.(ts|json|yaml|yml|sh)$ ]]; }
is_tabsensitive() { [[ "$1" =~ \.(ts|json|yaml|yml)$ ]]; }

while IFS= read -r f; do
  [ -f "$f" ] || continue

  # CRLF check (all text files). Detect a carriage return byte portably.
  if LC_ALL=C grep -q $'\r' "$f" 2>/dev/null; then
    echo "  CRLF line endings: $f" >&2
    fail=1
  fi

  # Final-newline check (all non-empty text files).
  if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then
    echo "  missing final newline: $f" >&2
    fail=1
  fi

  # Trailing whitespace (code files only; .md uses it for line breaks).
  if is_code "$f" && grep -nE ' +$' "$f" >/dev/null 2>&1; then
    echo "  trailing whitespace: $f" >&2
    fail=1
  fi

  # Hard tabs (indentation-sensitive code files). Match a literal tab byte.
  if is_tabsensitive "$f" && LC_ALL=C grep -q "$(printf '\t')" "$f" 2>/dev/null; then
    echo "  hard tab: $f" >&2
    fail=1
  fi
done < <(git ls-files)

if [ "$fail" -ne 0 ]; then
  echo "format-check: FAIL" >&2
  exit 1
fi
echo "format-check: PASS"
