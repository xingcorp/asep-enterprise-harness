#!/usr/bin/env bash
# PII scanner for the ASEP repository (P1-FINAL-HIGH-003).
#
# Scans git-tracked text files for high-signal PII that must never ship in a
# public reference repo: real email addresses, phone numbers, and US SSNs.
# Exits non-zero when a candidate is found. Self-tests on seeded canaries so a
# broken scanner fails loudly instead of passing silently (P1-CHANGE-006).
#
# Deliberately conservative to avoid false positives on a public repo:
#   - emails at example.com / example.org / asep.dev and noreply addresses are
#     treated as safe placeholders (allowlisted), everything else is flagged.
#
# Usage:
#   scripts/pii-scan.sh             # scan tracked files
#   scripts/pii-scan.sh --self-test # prove the scanner catches canaries
set -euo pipefail

# Force a byte-wise locale: macOS/BSD grep aborts (Abort trap: 6) on invalid
# multibyte sequences under a UTF-8 locale. C locale + grep -a keeps matching
# deterministic and crash-free across binary-ish tracked files.
export LC_ALL=C LANG=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# High-signal PII patterns.
# shellcheck disable=SC2016
PII_PATTERNS=(
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'                 # email
  '\b(\+?1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-][2-9][0-9]{2}[ .-][0-9]{4}\b' # US phone
  '\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b'                                 # US SSN
)

# Placeholder emails/domains that are safe in docs/examples/config.
# shellcheck disable=SC2016
EMAIL_ALLOW='@(example\.(com|org|net)|asep\.dev|localhost|.*\.invalid)|noreply@'

# Files that legitimately contain these patterns (the scanner itself, and the
# scanner test that seeds canaries).
EXEMPT_REGEX='^(scripts/pii-scan\.sh|scripts/pii-scan\.test\.ts|scripts/check-publication\.sh)$'

scan_paths() {
  # Args: files. Prints "  path:line:match". Returns 0 if any hit, 1 if clean.
  #
  # The email allowlist is applied PER MATCH, never per line (P1-FINAL-HIGH-003).
  # A line like `user@example.com real=jane.doe@gmail.com` mixes a placeholder
  # with a real address; extracting each email individually and allowlisting
  # only the placeholder tokens ensures the real gmail is still caught instead
  # of the whole line being skipped because it happened to contain a placeholder.
  local found=1 file idx pat lineno matchtext
  for file in "$@"; do
    [ -f "$file" ] || continue
    for idx in "${!PII_PATTERNS[@]}"; do
      pat="${PII_PATTERNS[$idx]}"
      # grep -o extracts EACH match separately (one per output line); -n keeps
      # the source line number as `lineno:match`. We then decide per match.
      while IFS= read -r rawmatch; do
        lineno="${rawmatch%%:*}"
        matchtext="${rawmatch#*:}"
        # The email pattern (index 0) is the only one with an allowlist, and it
        # is applied to the extracted email TOKEN, not the surrounding line.
        if [ "$idx" -eq 0 ]; then
          if printf '%s' "$matchtext" | grep -qiE "$EMAIL_ALLOW"; then
            continue
          fi
        fi
        echo "  ${file}:${lineno}:${matchtext}"
        found=0
      done < <(grep -anoE "$pat" "$file" 2>/dev/null || true)
    done
  done
  return $found
}

self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"

  # 1. Real-looking email (not a placeholder) must be caught.
  printf 'contact: jane.doe@gmail.com\n' > "$tmp/email.txt"
  if scan_paths "$tmp/email.txt" >/dev/null 2>&1; then
    echo "self-test: PASS (real email caught)"
  else
    echo "self-test: FAIL (real email not caught)" >&2; rc=1
  fi

  # 2. Placeholder email must NOT be caught.
  printf 'contact: user@example.com and noreply@asep.dev\n' > "$tmp/ok.txt"
  if scan_paths "$tmp/ok.txt" >/dev/null 2>&1; then
    echo "self-test: FAIL (placeholder email wrongly flagged)" >&2; rc=1
  else
    echo "self-test: PASS (placeholder email allowlisted)"
  fi

  # 2b. BYPASS (P1-FINAL-HIGH-003): a line mixing a placeholder AND a real email
  #     must still catch the real one. The old per-line allowlist skipped the
  #     WHOLE line whenever any placeholder appeared, letting the gmail leak.
  printf 'user@example.com real=jane.doe@gmail.com\n' > "$tmp/mixed.txt"
  if scan_paths "$tmp/mixed.txt" 2>/dev/null | grep -q 'jane.doe@gmail.com'; then
    echo "self-test: PASS (real email on a placeholder line is caught)"
  else
    echo "self-test: FAIL (real email hidden behind placeholder on same line)" >&2; rc=1
  fi
  # And the placeholder on that same mixed line must NOT be reported.
  if scan_paths "$tmp/mixed.txt" 2>/dev/null | grep -q 'user@example.com'; then
    echo "self-test: FAIL (placeholder on mixed line wrongly flagged)" >&2; rc=1
  else
    echo "self-test: PASS (placeholder on mixed line still allowlisted)"
  fi

  # 3. US SSN canary must be caught.
  printf 'ssn = 123-45-6789\n' > "$tmp/ssn.txt"
  if scan_paths "$tmp/ssn.txt" >/dev/null 2>&1; then
    echo "self-test: PASS (SSN canary caught)"
  else
    echo "self-test: FAIL (SSN canary not caught)" >&2; rc=1
  fi

  # 4. US phone canary must be caught.
  printf 'call 415-555-2671 now\n' > "$tmp/phone.txt"
  if scan_paths "$tmp/phone.txt" >/dev/null 2>&1; then
    echo "self-test: PASS (phone canary caught)"
  else
    echo "self-test: FAIL (phone canary not caught)" >&2; rc=1
  fi

  rm -rf "$tmp"
  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
  fi

  local files=()
  while IFS= read -r f; do
    [[ "$f" =~ $EXEMPT_REGEX ]] && continue
    files+=("$f")
  done < <(git ls-files)

  echo "pii-scan: scanning ${#files[@]} tracked files"
  if scan_paths "${files[@]}" > /tmp/asep-pii-report.$$ 2>/dev/null; then
    echo "pii-scan: FAIL — candidate PII found:" >&2
    cat /tmp/asep-pii-report.$$ >&2
    rm -f /tmp/asep-pii-report.$$
    return 1
  fi
  rm -f /tmp/asep-pii-report.$$

  self_test >/dev/null
  echo "pii-scan: PASS (no PII; self-test green)"
}

main "$@"
