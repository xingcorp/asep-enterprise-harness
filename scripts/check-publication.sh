#!/usr/bin/env bash
# Publication readiness gate for the ASEP repository.
#
# Executable (not prose) gate that must be green BEFORE any public push:
#   1. LICENSE present and Apache-2.0.
#   2. Absolute-path / internal-path leak scan over tracked files (with self-test).
#   3. Secret scan (delegates to secret-scan.sh, which self-tests).
#   4. Large-file scan (delegates to large-file-scan.sh, which self-tests).
#   5. Dependency-license presence note.
#
# All scanners self-test on a seeded canary so a broken scanner fails loudly
# rather than passing silently (P1-CHANGE-006).
#
# Usage:
#   scripts/check-publication.sh             # run full publication gate
#   scripts/check-publication.sh --self-test # prove abs-path scanner catches canary
#   scripts/check-publication.sh --scan-paths FILE...
#                                            # abs-path scan of FILEs only: exit 0 clean,
#                                            # 1 with hits, 2 when it cannot scan
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Internal/leak path patterns that must never appear in a public tree. The
# worker runs inside ~/.openclaw/runs/... and /Users/<name>/... — those absolute
# paths leaking into tracked files would expose the build environment. The
# patterns live in one list, also read by the review-corpus collector: one ERE
# per line; empty lines and '#' lines are ignored; a pattern line may not start
# or end with whitespace. A list that cannot be read this way stops the gate.
LEAK_PATTERNS_FILE="$REPO_ROOT/scripts/lib/publication-leak-patterns.txt"
LEAK_PATTERNS=()
load_leak_patterns() {
  local line n=0
  if [ ! -r "$LEAK_PATTERNS_FILE" ]; then
    echo "check-publication: cannot read the leak pattern list" >&2
    exit 2
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in '' | '#'*) continue ;; esac
    if [[ "$line" =~ ^[[:space:]] || "$line" =~ [[:space:]]$ ]]; then
      echo "check-publication: leak pattern on line $n starts or ends with whitespace" >&2
      exit 2
    fi
    LEAK_PATTERNS+=("$line")
  done < "$LEAK_PATTERNS_FILE"
  if [ "${#LEAK_PATTERNS[@]}" -eq 0 ]; then
    echo "check-publication: the leak pattern list has no pattern" >&2
    exit 2
  fi
}
load_leak_patterns

# The scanner, its pattern list and the report doc legitimately name these patterns; exempt them.
EXEMPT_REGEX='^(scripts/check-publication\.sh|scripts/lib/publication-leak-patterns\.txt|docs/implementation/phases/phase-01-publication-checklist\.md|docs/implementation/phases/phase-01-report\.md|docs/implementation/phases/phase-01-blockers\.md|artifacts/phase-01/.*)$'

scan_leaks() {
  # Args: files. Prints hits. Returns 0 if any hit, 1 if clean.
  local found=1 file
  for file in "$@"; do
    [ -f "$file" ] || continue
    for pat in "${LEAK_PATTERNS[@]}"; do
      # -e for the same reason as scripts/secret-scan.sh: a pattern starting
      # with '-' would otherwise be parsed as options and the scan would exit 2,
      # which this `if` reads as "clean". No LEAK_PATTERNS entry begins with a
      # dash today; this keeps adding one from silently disabling the scanner.
      if grep -nE -e "$pat" "$file" >/tmp/asep-leak-hit.$$ 2>/dev/null; then
        while IFS= read -r line; do
          echo "  ${file}:${line}"
        done < /tmp/asep-leak-hit.$$
        found=0
      fi
    done
  done
  rm -f /tmp/asep-leak-hit.$$
  return $found
}

self_test() {
  local tmp rc
  tmp="$(mktemp -d)"
  printf 'path = /Users/example/secret/workspace\n' > "$tmp/canary.txt"
  if scan_leaks "$tmp/canary.txt" >/dev/null 2>&1; then
    echo "self-test: PASS (abs-path canary caught)"
    rc=0
  else
    echo "self-test: FAIL (abs-path scanner did not catch seeded canary)" >&2
    rc=1
  fi
  rm -rf "$tmp"
  return $rc
}

check_license() {
  if [ ! -f LICENSE ]; then
    echo "  LICENSE: MISSING" >&2
    return 1
  fi
  if ! grep -q "Apache License" LICENSE; then
    echo "  LICENSE: present but not Apache-2.0" >&2
    return 1
  fi
  echo "  LICENSE: present (Apache-2.0)"
}

check_history_secrets() {
  # Scan the full git history (all blobs across all commits) for the SAME
  # high-signal secret patterns the working-tree scanner uses. The pattern set
  # is sourced from the single shared lib so HEAD and history can never diverge
  # (P1-FINAL-HIGH-003 — previously history was missing sk-[A-Za-z0-9]{20,}).
  # shellcheck source=scripts/lib/secret-patterns.sh
  source "$REPO_ROOT/scripts/lib/secret-patterns.sh"
  local grep_pat="$SECRET_PATTERNS_ALT"
  # git grep across every commit object. Exempt the scanner scripts and the
  # shared pattern lib themselves (they contain the patterns by definition).
  local hits
  if hits="$(git grep -nE "$grep_pat" $(git rev-list --all) 2>/dev/null \
      | grep -vE ':(scripts/secret-scan\.sh|scripts/check-publication\.sh|scripts/lib/secret-patterns\.sh):' || true)"; then
    if [ -n "$hits" ]; then
      echo "  git-history: FAIL — secret material found in history:" >&2
      echo "$hits" | head -n 20 >&2
      return 1
    fi
  fi
  echo "  git-history: clean (no secret material across all commits)"
}

check_dep_licenses() {
  # Real dependency-license inventory (direct + transitive) against an allowlist,
  # not a checklist-presence stub (P1-FINAL-HIGH-003). Delegates to
  # license-inventory.sh, which fails closed on any non-permissive/unknown license.
  if bash scripts/license-inventory.sh > /tmp/asep-lic-deleg.$$ 2>&1; then
    sed 's/^/  /' /tmp/asep-lic-deleg.$$
    rm -f /tmp/asep-lic-deleg.$$
    return 0
  fi
  sed 's/^/  /' /tmp/asep-lic-deleg.$$ >&2
  rm -f /tmp/asep-lic-deleg.$$
  return 1
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
  fi
  if [ "${1:-}" = "--scan-paths" ]; then
    shift
    local f
    for f in "$@"; do
      if [ ! -f "$f" ]; then
        echo "check-publication: not a file: $f" >&2
        return 2
      fi
    done
    if scan_leaks "$@"; then
      return 1
    fi
    return 0
  fi

  local fail=0

  echo "check-publication: license"
  check_license || fail=1

  echo "check-publication: absolute-path / internal-path leak scan"
  local files=()
  while IFS= read -r f; do
    [[ "$f" =~ $EXEMPT_REGEX ]] && continue
    files+=("$f")
  done < <(git ls-files)
  if scan_leaks "${files[@]}" > /tmp/asep-leak-report.$$ 2>/dev/null; then
    echo "check-publication: FAIL — internal path leaks found:" >&2
    cat /tmp/asep-leak-report.$$ >&2
    rm -f /tmp/asep-leak-report.$$
    fail=1
  else
    echo "  abs-path scan: clean"
  fi
  rm -f /tmp/asep-leak-report.$$

  echo "check-publication: git-history secret scan"
  check_history_secrets || fail=1

  echo "check-publication: dependency-license"
  check_dep_licenses || fail=1

  echo "check-publication: secret scan (delegated)"
  if bash scripts/secret-scan.sh > /tmp/asep-secret-deleg.$$ 2>&1; then
    sed 's/^/  /' /tmp/asep-secret-deleg.$$
  else
    sed 's/^/  /' /tmp/asep-secret-deleg.$$ >&2
    fail=1
  fi
  rm -f /tmp/asep-secret-deleg.$$

  echo "check-publication: large-file scan (delegated)"
  if bash scripts/large-file-scan.sh > /tmp/asep-large-deleg.$$ 2>&1; then
    sed 's/^/  /' /tmp/asep-large-deleg.$$
  else
    sed 's/^/  /' /tmp/asep-large-deleg.$$ >&2
    fail=1
  fi
  rm -f /tmp/asep-large-deleg.$$

  echo "check-publication: PII scan (delegated)"
  if bash scripts/pii-scan.sh > /tmp/asep-pii-deleg.$$ 2>&1; then
    sed 's/^/  /' /tmp/asep-pii-deleg.$$
  else
    sed 's/^/  /' /tmp/asep-pii-deleg.$$ >&2
    fail=1
  fi
  rm -f /tmp/asep-pii-deleg.$$

  echo "check-publication: abs-path scanner self-test"
  self_test >/dev/null || fail=1

  if [ "$fail" -ne 0 ]; then
    echo "check-publication: FAIL" >&2
    return 1
  fi
  echo "check-publication: PASS (all publication gates green)"
}

main "$@"
