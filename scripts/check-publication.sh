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
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Internal/leak path patterns that must never appear in a public tree. The
# worker runs inside ~/.openclaw/runs/... and /Users/<name>/... — those absolute
# paths leaking into tracked files would expose the build environment.
# shellcheck disable=SC2016
LEAK_PATTERNS=(
  '/Users/[A-Za-z0-9._-]+'          # macOS home absolute path
  '/home/[A-Za-z0-9._-]+'           # linux home absolute path
  '\.openclaw/runs/[0-9]'           # concrete worker run dir (placeholder <id> allowed)
  '/root/[A-Za-z0-9._-]'            # container root home content
)

# The scanner and the report doc legitimately name these patterns; exempt them.
EXEMPT_REGEX='^(scripts/check-publication\.sh|docs/implementation/phases/phase-01-publication-checklist\.md|docs/implementation/phases/phase-01-report\.md|docs/implementation/phases/phase-01-blockers\.md|artifacts/phase-01/.*)$'

scan_leaks() {
  # Args: files. Prints hits. Returns 0 if any hit, 1 if clean.
  local found=1 file
  for file in "$@"; do
    [ -f "$file" ] || continue
    for pat in "${LEAK_PATTERNS[@]}"; do
      if grep -nE "$pat" "$file" >/tmp/asep-leak-hit.$$ 2>/dev/null; then
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
  # Scan the full git history (all blobs across all commits) for the same
  # high-signal secret patterns the working-tree scanner uses. A secret removed
  # from HEAD but still reachable in history would leak on a public push.
  local grep_pat
  grep_pat='AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  grep_pat="$grep_pat|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}"
  grep_pat="$grep_pat|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}"
  grep_pat="$grep_pat|glpat-[A-Za-z0-9_-]{20}"
  # git grep across every commit object. Exempt the scanner scripts themselves.
  local hits
  if hits="$(git grep -nE "$grep_pat" $(git rev-list --all) 2>/dev/null \
      | grep -vE ':(scripts/secret-scan\.sh|scripts/check-publication\.sh):' || true)"; then
    if [ -n "$hits" ]; then
      echo "  git-history: FAIL — secret material found in history:" >&2
      echo "$hits" | head -n 20 >&2
      return 1
    fi
  fi
  echo "  git-history: clean (no secret material across all commits)"
}

check_dep_licenses() {
  # Phase 1 has zero third-party runtime deps in domain packages; devDeps are
  # permissively licensed (MIT/Apache/ISC). Record that a dependency-license
  # review artifact exists; deep SCA is a pre-public human step.
  if [ -f docs/implementation/phases/phase-01-publication-checklist.md ]; then
    echo "  dependency-license: checklist present (see publication checklist)"
    return 0
  fi
  echo "  dependency-license: publication checklist missing" >&2
  return 1
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
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

  echo "check-publication: abs-path scanner self-test"
  self_test >/dev/null || fail=1

  if [ "$fail" -ne 0 ]; then
    echo "check-publication: FAIL" >&2
    return 1
  fi
  echo "check-publication: PASS (all publication gates green)"
}

main "$@"
