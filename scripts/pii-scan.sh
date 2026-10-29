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

# ---------------------------------------------------------------------------
# Git metadata scan.
#
# Tracked files are not the only thing a public push publishes: every commit
# carries an author and a committer email, and both ship with the history. The
# file scan above never saw them, so commits made under a personal address
# passed the gate.
#
# Policy (decided by the repository owner): published history is KEPT, and the
# one personal address already in it is tolerated ONLY on commits that are
# ancestors of (or equal to) the pinned historical heads below. Any newer commit
# carrying it, and any other personal address anywhere, fails the gate. The
# address itself is never written here; it is matched by the sha256 of its
# lowercased form.
#
# Scope: every commit reachable from the refs a remote would advertise
# (refs/heads, refs/tags, refs/remotes). Private refs such as refs/stash are not
# published and are not scanned. For commits newer than the pinned heads the
# commit message is scanned too, so a personal address in a trailer
# (Co-Authored-By, Signed-off-by) is caught as well.
LEGACY_IDENTITY_SHA256='0c89ea2db95789cd19471121ac38267055cae3adf997f349e71737eae9c60b53'
PINNED_HISTORICAL_HEADS=(
  fc0df57df05b6745e190a53496bd5d90b7ae4bcb   # main
  e046885ad9f800f8d0c7a1fee965f9e670baee96   # phase/01-evaluation-contracts
  00a68895d205122767167942326e2e0466571059   # phase/02-single-agent-vertical-slice
)

# Identity emails that are never personal: reserved/special-use domains
# (RFC 2606/6761/6762), the project's own domain, GitHub's privacy-preserving
# noreply addresses, and noreply@ service identities. Anchored, unlike the
# file-scan allowlist, so a lookalike such as jane@localhost.example.net or
# xnoreply@gmail.com is not waved through.
# shellcheck disable=SC2016
METADATA_ALLOW='^[^@]+@(example\.(com|org|net)|asep\.dev|localhost|local|[A-Za-z0-9.-]+\.(invalid|test|example)|users\.noreply\.github\.com)$|^noreply@[A-Za-z0-9.-]+$'

scan_git_metadata() {
  # Args: repo legacy_sha256 pinned_head... Prints one line per violation.
  # Returns 0 if any violation, 1 if clean (same convention as scan_paths).
  local repo="$1" legacy="$2"; shift 2
  local pinned=() head
  for head in "$@"; do
    # A pinned head missing from this clone cannot vouch for anything: its
    # ancestors simply lose the legacy allowance, so the scan fails closed.
    if git -C "$repo" cat-file -e "${head}^{commit}" 2>/dev/null; then
      pinned+=("$head")
    fi
  done

  local refs
  refs="$(git -C "$repo" for-each-ref --format='%(objectname)' refs/heads refs/tags refs/remotes)"
  [ -n "$refs" ] || return 1

  local pinned_file rc=0
  pinned_file="$(mktemp)"
  if [ "${#pinned[@]}" -gt 0 ]; then
    git -C "$repo" rev-list "${pinned[@]}" > "$pinned_file"
  fi

  # One git process and one perl process for the whole history. Fields are
  # separated by US (0x1f) and records by RS (0x1e), which cannot occur in an
  # email and are vanishingly rare in a commit message.
  # shellcheck disable=SC2086
  git -C "$repo" log --format='%H%x1f%ae%x1f%ce%x1f%B%x1e' $refs \
    | PII_EMAIL="${PII_PATTERNS[0]}" \
      PII_META_ALLOW="$METADATA_ALLOW" \
      PII_LEGACY="$legacy" \
      PII_PINNED="$pinned_file" \
      perl -e '
        use Digest::SHA qw(sha256_hex);
        my ($email, $allow, $legacy, $pinned_file) =
          @ENV{qw(PII_EMAIL PII_META_ALLOW PII_LEGACY PII_PINNED)};
        my %pinned;
        open(my $pf, "<", $pinned_file) or die "cannot read pinned list";
        while (my $l = <$pf>) { chomp $l; $pinned{$l} = 1; }
        close($pf);
        sub redact { my $a = shift; $a =~ s/^(.)[^@]*(@.*)$/$1***$2/; return $a; }
        my $found = 0;
        local $/ = "\x1e";
        while (my $rec = <STDIN>) {
          chomp $rec;
          $rec =~ s/^\n+//;
          next if $rec eq "";
          my ($sha, $ae, $ce, $body) = split /\x1f/, $rec, 4;
          my $short = substr($sha, 0, 12);
          my $published = exists $pinned{$sha};
          for my $pair (["author", $ae], ["committer", $ce]) {
            my ($field, $addr) = @$pair;
            next if !defined $addr || $addr eq "";
            next if $addr =~ /$allow/i;
            next if $published && sha256_hex(lc $addr) eq $legacy;
            print "  commit $short: $field email " . redact($addr) . "\n";
            $found = 1;
          }
          next if $published;
          $body = "" unless defined $body;
          while ($body =~ /$email/g) {
            my $m = $&;
            next if $m =~ /$allow/i;
            print "  commit $short: message email " . redact($m) . "\n";
            $found = 1;
          }
        }
        exit($found ? 0 : 1);
      ' || rc=$?
  rm -f "$pinned_file"
  # perl exits 0 on a hit and 1 when clean; anything else is a scanner fault,
  # which must read as a hit (fail closed), never as clean.
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) echo "  git metadata scanner failed (exit $rc)"; return 0 ;;
  esac
}

# Build a throwaway repo commit with explicit author/committer identities.
# Hooks and signing are disabled so a developer's global git config cannot
# change what the self-test exercises.
_mt_commit() {
  local repo="$1" author="$2" committer="$3" msg="$4"
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL="$author" \
  GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL="$committer" \
    git -C "$repo" -c core.hooksPath=/dev/null -c commit.gpgsign=false \
      commit -q --allow-empty -m "$msg"
}

_mt_repo() {
  local repo="$1"
  git init -q "$repo"
  git -C "$repo" symbolic-ref HEAD refs/heads/main
}

metadata_self_test() {
  local tmp rc=0 legacy_mail other_mail legacy_hash pinned
  tmp="$(mktemp -d)"
  # Canary identities, NOT real people. The legacy canary's hash stands in for
  # the real legacy hash so the allowance logic is exercised end to end.
  legacy_mail='legacy.person@gmail.com'
  other_mail='other.person@gmail.com'
  legacy_hash="$(printf '%s' "$legacy_mail" | perl -MDigest::SHA=sha256_hex -e 'print sha256_hex(lc <STDIN>)')"

  # (a) the legacy address on published history is tolerated.
  _mt_repo "$tmp/a"
  _mt_commit "$tmp/a" "$legacy_mail" "$legacy_mail" 'published'
  pinned="$(git -C "$tmp/a" rev-parse HEAD)"
  if scan_git_metadata "$tmp/a" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: FAIL (legacy address on published history wrongly flagged)" >&2; rc=1
  else
    echo "self-test: PASS (legacy address tolerated on pinned history)"
  fi

  # (b) the legacy address on a commit NEWER than the pinned head is caught.
  _mt_commit "$tmp/a" "$legacy_mail" 'noreply@asep.dev' 'newer'
  if scan_git_metadata "$tmp/a" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: PASS (legacy address on a newer commit caught)"
  else
    echo "self-test: FAIL (legacy address on a newer commit not caught)" >&2; rc=1
  fi

  # (c) a committer-only leak is caught (author is clean).
  _mt_repo "$tmp/c"
  _mt_commit "$tmp/c" 'noreply@asep.dev' 'noreply@asep.dev' 'base'
  pinned="$(git -C "$tmp/c" rev-parse HEAD)"
  _mt_commit "$tmp/c" '1+bot@users.noreply.github.com' "$legacy_mail" 'committer leak'
  if scan_git_metadata "$tmp/c" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: PASS (committer-only personal address caught)"
  else
    echo "self-test: FAIL (committer-only personal address not caught)" >&2; rc=1
  fi

  # (d) any OTHER personal address is caught, even on published history.
  _mt_repo "$tmp/d"
  _mt_commit "$tmp/d" "$other_mail" "$other_mail" 'published by someone else'
  pinned="$(git -C "$tmp/d" rev-parse HEAD)"
  if scan_git_metadata "$tmp/d" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: PASS (other personal address on pinned history caught)"
  else
    echo "self-test: FAIL (other personal address on pinned history not caught)" >&2; rc=1
  fi

  # (e) a personal address in a newer commit's message trailer is caught.
  _mt_repo "$tmp/e"
  _mt_commit "$tmp/e" 'noreply@asep.dev' 'noreply@asep.dev' 'base'
  pinned="$(git -C "$tmp/e" rev-parse HEAD)"
  _mt_commit "$tmp/e" 'noreply@asep.dev' 'noreply@asep.dev' \
    "$(printf 'feat: x\n\nCo-Authored-By: Someone <%s>' "$other_mail")"
  if scan_git_metadata "$tmp/e" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: PASS (personal address in a commit trailer caught)"
  else
    echo "self-test: FAIL (personal address in a commit trailer not caught)" >&2; rc=1
  fi

  # (f) noreply and placeholder identities stay clean.
  _mt_repo "$tmp/f"
  _mt_commit "$tmp/f" 'noreply@asep.dev' 'noreply@asep.dev' 'base'
  pinned="$(git -C "$tmp/f" rev-parse HEAD)"
  _mt_commit "$tmp/f" '345+someone@users.noreply.github.com' 'bot@asep.invalid' \
    "$(printf 'fix: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>')"
  if scan_git_metadata "$tmp/f" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: FAIL (noreply/placeholder identities wrongly flagged)" >&2; rc=1
  else
    echo "self-test: PASS (noreply/placeholder identities allowlisted)"
  fi

  # (g) a commit reachable ONLY from a tag is still scanned.
  _mt_repo "$tmp/g"
  _mt_commit "$tmp/g" 'noreply@asep.dev' 'noreply@asep.dev' 'base'
  pinned="$(git -C "$tmp/g" rev-parse HEAD)"
  git -C "$tmp/g" checkout -q --detach
  _mt_commit "$tmp/g" "$other_mail" "$other_mail" 'tag-only'
  git -C "$tmp/g" tag tag-only-commit
  git -C "$tmp/g" checkout -q main
  if scan_git_metadata "$tmp/g" "$legacy_hash" "$pinned" >/dev/null 2>&1; then
    echo "self-test: PASS (tag-only commit scanned)"
  else
    echo "self-test: FAIL (tag-only commit not scanned)" >&2; rc=1
  fi

  # (h) a pinned head absent from the clone cannot vouch for anything.
  _mt_repo "$tmp/h"
  _mt_commit "$tmp/h" "$legacy_mail" "$legacy_mail" 'published'
  if scan_git_metadata "$tmp/h" "$legacy_hash" 0000000000000000000000000000000000000001 >/dev/null 2>&1; then
    echo "self-test: PASS (missing pinned head fails closed)"
  else
    echo "self-test: FAIL (missing pinned head silently allowed the legacy address)" >&2; rc=1
  fi

  rm -rf "$tmp"
  return $rc
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

  # 5. Git author/committer/trailer metadata.
  metadata_self_test || rc=1
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
  # Guarded: under bash 3.2 `set -u` an EMPTY array expansion is an "unbound
  # variable" error, which aborted the scan before the metadata check ran.
  if [ "${#files[@]}" -gt 0 ] && scan_paths "${files[@]}" > /tmp/asep-pii-report.$$ 2>/dev/null; then
    echo "pii-scan: FAIL — candidate PII found:" >&2
    cat /tmp/asep-pii-report.$$ >&2
    rm -f /tmp/asep-pii-report.$$
    return 1
  fi
  rm -f /tmp/asep-pii-report.$$

  echo "pii-scan: scanning git author/committer metadata reachable from advertised refs"
  local meta_report
  meta_report="$(mktemp)"
  if scan_git_metadata "$REPO_ROOT" "$LEGACY_IDENTITY_SHA256" "${PINNED_HISTORICAL_HEADS[@]}" \
      > "$meta_report" 2>&1; then
    echo "pii-scan: FAIL — personal email in git metadata (addresses redacted):" >&2
    cat "$meta_report" >&2
    rm -f "$meta_report"
    return 1
  fi
  rm -f "$meta_report"

  self_test >/dev/null
  echo "pii-scan: PASS (no PII in tracked files or git metadata; self-test green)"
}

main "$@"
