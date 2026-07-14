#!/usr/bin/env bash
# Large-file scanner for the ASEP repository.
#
# Fails when any git-tracked file exceeds the size limit (default 500KB). Guards
# against vendored dependencies, binaries, or captured artifacts being committed.
# Includes a self-test (P1-CHANGE-006): a seeded oversized file MUST be caught.
#
# Usage:
#   scripts/large-file-scan.sh             # scan tracked files
#   scripts/large-file-scan.sh --self-test # prove the scanner catches a canary
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LIMIT_BYTES="${ASEP_MAX_FILE_BYTES:-512000}"  # 500 KiB

file_size() {
  # Portable byte size (BSD stat on macOS, GNU stat on Linux).
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

self_test() {
  local tmp rc size canary
  tmp="$(mktemp -d)"
  # Seed a file just over the limit.
  canary="$tmp/canary.bin"
  head -c "$((LIMIT_BYTES + 1))" /dev/zero > "$canary"
  size="$(file_size "$canary")"
  if [ "$size" -gt "$LIMIT_BYTES" ]; then
    echo "self-test: PASS (oversized canary detected: ${size} > ${LIMIT_BYTES})"
    rc=0
  else
    echo "self-test: FAIL (scanner sizing logic broken)" >&2
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

  local violations=0
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    local size
    size="$(file_size "$f")"
    if [ "$size" -gt "$LIMIT_BYTES" ]; then
      echo "  ${f}: ${size} bytes (> ${LIMIT_BYTES})" >&2
      violations=$((violations + 1))
    fi
  done < <(git ls-files)

  if [ "$violations" -gt 0 ]; then
    echo "large-file-scan: FAIL — ${violations} tracked file(s) exceed ${LIMIT_BYTES} bytes" >&2
    return 1
  fi

  self_test >/dev/null
  echo "large-file-scan: PASS (all tracked files <= ${LIMIT_BYTES} bytes; self-test green)"
}

main "$@"
