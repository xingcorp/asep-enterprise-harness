#!/usr/bin/env bash
# Secret scanner for the ASEP repository.
#
# Scans git-tracked text files for high-signal secret patterns. Exits non-zero
# when a candidate secret is found. Includes a self-test (P1-CHANGE-006): a
# seeded canary secret MUST be caught, proving the scanner actually detects.
#
# Usage:
#   scripts/secret-scan.sh            # scan tracked files
#   scripts/secret-scan.sh --self-test # prove the scanner catches a canary
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# High-signal secret patterns come from the single shared source so the
# working-tree scan and the git-history scan (check-publication.sh) can never
# diverge (P1-FINAL-HIGH-003).
# shellcheck source=scripts/lib/secret-patterns.sh
source "$REPO_ROOT/scripts/lib/secret-patterns.sh"
PATTERNS=("${SECRET_PATTERNS[@]}")

# Files intentionally exempt: this scanner itself and its self-tests define the
# patterns above and must not trip on their own regexes.
EXEMPT_REGEX='^(scripts/secret-scan\.sh|scripts/check-publication\.sh|scripts/lib/secret-patterns\.sh)$'

scan_paths() {
  # Args: list of files. Prints "path:line:match" for each hit. Returns 0 if any
  # hit was printed, 1 if clean.
  local found=1
  local file
  for file in "$@"; do
    [ -f "$file" ] || continue
    for pat in "${PATTERNS[@]}"; do
      if grep -nE "$pat" "$file" >/tmp/asep-secret-hit.$$ 2>/dev/null; then
        while IFS= read -r line; do
          echo "  ${file}:${line}"
        done < /tmp/asep-secret-hit.$$
        found=0
      fi
    done
  done
  rm -f /tmp/asep-secret-hit.$$
  return $found
}

self_test() {
  local tmp rc
  tmp="$(mktemp -d)"
  # Seed a canary that matches the AWS access-key-id pattern (AKIA + 16 chars).
  # Uses AWS's own documented non-functional example key id.
  printf 'aws_key = AKIA%s\n' 'IOSFODNN7EXAMPLE' > "$tmp/canary.txt"
  if scan_paths "$tmp/canary.txt" >/dev/null 2>&1; then
    echo "self-test: PASS (canary secret caught)"
    rc=0
  else
    echo "self-test: FAIL (scanner did not catch seeded canary)" >&2
    rc=1
  fi
  rm -rf "$tmp"
  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
  fi

  # Gather tracked, non-exempt files. Use git so untracked/ignored paths and
  # node_modules are never scanned.
  local files=()
  while IFS= read -r f; do
    [[ "$f" =~ $EXEMPT_REGEX ]] && continue
    files+=("$f")
  done < <(git ls-files)

  echo "secret-scan: scanning ${#files[@]} tracked files"
  if scan_paths "${files[@]}" > /tmp/asep-secret-report.$$ 2>/dev/null; then
    echo "secret-scan: FAIL — candidate secrets found:" >&2
    cat /tmp/asep-secret-report.$$ >&2
    rm -f /tmp/asep-secret-report.$$
    return 1
  fi
  rm -f /tmp/asep-secret-report.$$

  # Prove the scanner is live on every real run, not just when asked.
  self_test >/dev/null
  echo "secret-scan: PASS (no secrets; self-test green)"
}

main "$@"
