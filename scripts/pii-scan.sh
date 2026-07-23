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

# Force a byte-wise locale for deterministic, encoding-independent matching.
#
# NOTE (macOS): BSD `grep -o` under bash 3.2 aborts intermittently with
# "Abort trap: 6" (SIGABRT) — a heap bug in the system grep that fires
# nondeterministically (~25% of runs) regardless of the LC_ALL=C mitigation.
# Match extraction is therefore delegated to perl (see extract_matches), which
# is crash-free and produces byte-identical `lineno:match` output. LC_ALL=C is
# still exported so perl treats input as raw bytes, matching the old semantics.
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
  # SINGLE-PROCESS SCAN (macOS SIGABRT fix). The previous implementation spawned
  # one match-extractor per (file × pattern) plus a `grep -qiE` per email match —
  # ~888+ fork/exec for a full repo scan. Under bash 3.2 + the macOS system
  # allocator that fork volume intermittently aborts the shell with
  # "Abort trap: 6" (SIGABRT, ~25% of runs). The entire scan is therefore done in
  # ONE perl invocation: perl walks every file, applies all three patterns, and
  # applies the email allowlist PER MATCH internally — no per-file/per-match
  # subprocesses at all.
  #
  # The email allowlist is applied PER MATCH, never per line (P1-FINAL-HIGH-003).
  # A line like `user@example.com real=jane.doe@gmail.com` mixes a placeholder
  # with a real address; matching each email individually and allowlisting only
  # the placeholder tokens ensures the real gmail is still caught instead of the
  # whole line being skipped because it happened to contain a placeholder.
  #
  # Patterns/allowlist are passed via the environment so shell quoting never
  # mangles the regexes. Output is byte-identical to the old `grep -anoE` path
  # (verified against all three patterns). Returns 0 if any hit, 1 if clean.
  PII_EMAIL="${PII_PATTERNS[0]}" \
  PII_PHONE="${PII_PATTERNS[1]}" \
  PII_SSN="${PII_PATTERNS[2]}" \
  PII_ALLOW="$EMAIL_ALLOW" \
  perl -e '
    my ($email, $phone, $ssn, $allow) =
      @ENV{qw(PII_EMAIL PII_PHONE PII_SSN PII_ALLOW)};
    my $found = 0;
    for my $file (@ARGV) {
      next unless -f $file;
      open(my $fh, "<", $file) or next;
      my $ln = 0;
      while (my $line = <$fh>) {
        $ln++;
        # Email (index 0): allowlist applied to the extracted TOKEN, not the line.
        while ($line =~ /$email/g) {
          my $m = $&;
          next if $m =~ /$allow/i;
          print "  $file:$ln:$m\n";
          $found = 1;
        }
        while ($line =~ /$phone/g) { print "  $file:$ln:$&\n"; $found = 1; }
        while ($line =~ /$ssn/g)   { print "  $file:$ln:$&\n"; $found = 1; }
      }
      close($fh);
    }
    exit($found ? 0 : 1);
  ' "$@"
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
