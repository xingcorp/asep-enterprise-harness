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
#   scripts/check-publication.sh --scan-paths [--] FILE...
#                                            # abs-path scan of FILEs only: exit 0 clean,
#                                            # 1 with hits, 2 when it cannot scan; one
#                                            # leading -- ends the options
#   scripts/check-publication.sh --scan-tracked
#                                            # abs-path scan of the tracked files only,
#                                            # with the same exit codes
#   scripts/check-publication.sh --scan-history
#                                            # secret scan of every commit only, with the
#                                            # same exit codes
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Internal/leak path patterns that must never appear in a public tree. The
# worker runs inside ~/.openclaw/runs/... and /Users/<name>/... — those absolute
# paths leaking into tracked files would expose the build environment. The
# patterns live in one list, also read by the review-corpus collector: one ERE
# per line; empty lines and '#' lines are ignored; a pattern line may not start
# or end with whitespace. A list that cannot be read this way, or a pattern grep
# cannot run, stops the gate.
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
  # Run every pattern once on empty input: no match is status 1; anything else
  # means grep cannot run it, and no scan with it can be trusted.
  local pat rc
  for pat in "${LEAK_PATTERNS[@]}"; do
    rc=0
    grep -E -e "$pat" -- /dev/null >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 1 ]; then
      echo "check-publication: grep cannot run the leak pattern '$pat' (status $rc)" >&2
      exit 2
    fi
  done
}
load_leak_patterns

# The scanner and the phase 1 report docs legitimately name these patterns; exempt them.
EXEMPT_REGEX='^(scripts/check-publication\.sh|docs/implementation/phases/phase-01-publication-checklist\.md|docs/implementation/phases/phase-01-report\.md|docs/implementation/phases/phase-01-blockers\.md|artifacts/phase-01/.*)$'

scan_leaks() {
  # Args: files. Prints `  <file>:<line>:<text>` per hit. Returns 0 if any hit,
  # 1 if every file was scanned clean, and 2 when the scan cannot be trusted: no
  # file, a file that is not a readable regular file, or grep failing on a file.
  local found=1 file pat rc hits line
  if [ "$#" -eq 0 ]; then
    echo "check-publication: no file to scan" >&2
    return 2
  fi
  hits="$(mktemp "${TMPDIR:-/tmp}/asep-leak-hit.XXXXXX")" || return 2
  for file in "$@"; do
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      echo "check-publication: cannot read $file" >&2
      rm -f "$hits"
      return 2
    fi
    for pat in "${LEAK_PATTERNS[@]}"; do
      # -e and -- so neither a pattern nor a file name starting with '-' is
      # parsed as an option.
      rc=0
      grep -nE -e "$pat" -- "$file" >"$hits" 2>/dev/null || rc=$?
      case "$rc" in
        0)
          while IFS= read -r line; do
            echo "  ${file}:${line}"
          done <"$hits"
          found=0
          ;;
        1) ;;
        *)
          echo "check-publication: grep failed (status $rc) on $file" >&2
          rm -f "$hits"
          return 2
          ;;
      esac
    done
  done
  rm -f "$hits"
  return "$found"
}

scan_tracked() {
  # Scan every tracked file outside EXEMPT_REGEX, with scan_leaks' return codes.
  # Names are read NUL-separated, so a name Git would quote is scanned as it is.
  local listing f rc=0
  local files=()
  listing="$(mktemp "${TMPDIR:-/tmp}/asep-tracked.XXXXXX")" || return 2
  if ! git ls-files -z >"$listing"; then
    echo "check-publication: cannot list the tracked files" >&2
    rm -f "$listing"
    return 2
  fi
  while IFS= read -r -d '' f; do
    [[ "$f" =~ $EXEMPT_REGEX ]] && continue
    files+=("$f")
  done <"$listing"
  rm -f "$listing"
  scan_leaks ${files[@]+"${files[@]}"} || rc=$?
  return "$rc"
}

# The exit code of a scan-only mode for a scan's return code: 0 clean, 1 with
# hits, 2 when it cannot scan.
scan_exit_code() {
  case "$1" in
    0) echo 1 ;;
    1) echo 0 ;;
    *) echo 2 ;;
  esac
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

# The scanner scripts and the shared pattern lib contain the secret patterns by
# definition, so a history hit in one of them is exempt. Matched against a whole
# `<commit>:<path>:<count>` line of `git grep -c`.
HISTORY_EXEMPT_REGEX='^[0-9a-f]+:(scripts/secret-scan\.sh|scripts/check-publication\.sh|scripts/lib/secret-patterns\.sh):[0-9]+$'

scan_history() {
  # Scan every blob of every commit for the SAME high-signal secret patterns the
  # working-tree scanner uses, sourced from the single shared lib so HEAD and
  # history can never diverge. Prints `  <commit>:<path>:<count>` per file with a
  # hit, never the matched text. Returns scan_leaks' codes: 0 if any hit, 1 if
  # the history is clean, and 2 when the scan cannot be trusted: listing the
  # commits, grepping them or filtering the exemptions failed.
  # shellcheck source=scripts/lib/secret-patterns.sh
  source "$REPO_ROOT/scripts/lib/secret-patterns.sh"
  local listing matches kept rev rc=0
  local revs=()
  listing="$(mktemp "${TMPDIR:-/tmp}/asep-history-revs.XXXXXX")" || return 2
  if ! git rev-list --all >"$listing"; then
    echo "check-publication: cannot list the commits" >&2
    rm -f "$listing"
    return 2
  fi
  while IFS= read -r rev; do
    revs+=("$rev")
  done <"$listing"
  rm -f "$listing"
  # No commit is no history; git grep without a commit would read the work tree.
  if [ "${#revs[@]}" -eq 0 ]; then
    return 1
  fi
  matches="$(mktemp "${TMPDIR:-/tmp}/asep-history-hit.XXXXXX")" || return 2
  git grep -c -E -e "$SECRET_PATTERNS_ALT" "${revs[@]}" -- >"$matches" 2>/dev/null || rc=$?
  case "$rc" in
    0) ;;
    1)
      rm -f "$matches"
      return 1
      ;;
    *)
      echo "check-publication: git grep failed (status $rc) on the history" >&2
      rm -f "$matches"
      return 2
      ;;
  esac
  kept="$(mktemp "${TMPDIR:-/tmp}/asep-history-kept.XXXXXX")" || {
    rm -f "$matches"
    return 2
  }
  rc=0
  grep -v -E -e "$HISTORY_EXEMPT_REGEX" -- "$matches" >"$kept" 2>/dev/null || rc=$?
  rm -f "$matches"
  case "$rc" in
    0)
      while IFS= read -r rev; do
        echo "  ${rev}"
      done <"$kept"
      rm -f "$kept"
      return 0
      ;;
    1)
      rm -f "$kept"
      return 1
      ;;
    *)
      echo "check-publication: filtering the history hits failed (status $rc)" >&2
      rm -f "$kept"
      return 2
      ;;
  esac
}

check_history_secrets() {
  local report rc=0
  report="$(mktemp "${TMPDIR:-/tmp}/asep-history-report.XXXXXX")" || {
    echo "  git-history: FAIL — the history scan could not complete" >&2
    return 1
  }
  scan_history >"$report" || rc=$?
  case "$rc" in
    0)
      echo "  git-history: FAIL — secret material found in history:" >&2
      head -n 20 "$report" >&2
      rm -f "$report"
      return 1
      ;;
    1) echo "  git-history: clean (no secret material across all commits)" ;;
    *)
      echo "  git-history: FAIL — the history scan could not complete" >&2
      rm -f "$report"
      return 1
      ;;
  esac
  rm -f "$report"
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
  local rc=0
  if [ "${1:-}" = "--scan-paths" ]; then
    shift
    # One leading -- ends the options, so a file named like an option can follow it.
    if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
      shift
    fi
    scan_leaks "$@" || rc=$?
    return "$(scan_exit_code "$rc")"
  fi
  if [ "${1:-}" = "--scan-tracked" ]; then
    scan_tracked || rc=$?
    return "$(scan_exit_code "$rc")"
  fi
  if [ "${1:-}" = "--scan-history" ]; then
    scan_history || rc=$?
    return "$(scan_exit_code "$rc")"
  fi

  local fail=0

  echo "check-publication: license"
  check_license || fail=1

  echo "check-publication: absolute-path / internal-path leak scan"
  scan_tracked > /tmp/asep-leak-report.$$ || rc=$?
  case "$rc" in
    0)
      echo "check-publication: FAIL — internal path leaks found:" >&2
      cat /tmp/asep-leak-report.$$ >&2
      fail=1
      ;;
    1) echo "  abs-path scan: clean" ;;
    *)
      echo "check-publication: FAIL — the abs-path scan could not complete" >&2
      fail=1
      ;;
  esac
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
