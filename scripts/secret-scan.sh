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

# High-signal secret patterns. Kept conservative to avoid false positives on a
# public reference repo while still catching real credential material.
# shellcheck disable=SC2016
PATTERNS=(
  'AKIA[0-9A-Z]{16}'                                   # AWS access key id
  'ASIA[0-9A-Z]{16}'                                   # AWS temp access key id
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                 # PEM private key
  'ghp_[A-Za-z0-9]{36}'                                # GitHub personal token
  'gho_[A-Za-z0-9]{36}'                                # GitHub OAuth token
  'github_pat_[A-Za-z0-9_]{22,}'                       # GitHub fine-grained PAT
  'xox[baprs]-[A-Za-z0-9-]{10,}'                       # Slack token
  'sk-[A-Za-z0-9]{20,}'                                # OpenAI-style secret key
  'sk-ant-[A-Za-z0-9-]{20,}'                           # Anthropic-style key
  'AIza[0-9A-Za-z_-]{35}'                              # Google API key
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' # JWT
  'glpat-[A-Za-z0-9_-]{20}'                            # GitLab PAT
)

# Files intentionally exempt: this scanner itself and its self-tests define the
# patterns above and must not trip on their own regexes.
EXEMPT_REGEX='^(scripts/secret-scan\.sh|scripts/check-publication\.sh)$'

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
