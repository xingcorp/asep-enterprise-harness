#!/usr/bin/env bash
# Commit-message gate: a new commit carries no AI attribution and no finding
# code.
#
# The repository's history is kept as it is (the owner's decision): every
# commit reachable from the pinned historical heads below is tolerated,
# whatever its message says. Every other commit reachable from HEAD fails the
# gate when its message — subject, body or trailers — carries:
#   * AI attribution: a Co-Authored-By trailer naming Claude, Anthropic or
#     another AI, the address noreply@anthropic.com, or a "Generated with …"
#     line naming Claude;
#   * a finding code in the form this repository's reviews use: a token that
#     ends in CRIT, HIGH, MED or LOW and a three-digit number, with or without
#     the prefix before it.
#
# Scope: what this branch publishes, the history of HEAD. The PII scan reads
# every published ref, but in this shared repository those include the other
# lanes' branches, whose commits are theirs to keep or rework and are not
# pinned here. Each branch's gate checks its own history, and a branch that
# rebases onto this check adopts it.
#
# A pinned head missing from the clone vouches for nothing: its ancestors are
# scanned like any other commit, so the gate fails closed.
#
# Usage:
#   scripts/commit-message-scan.sh             # scan HEAD's history
#   scripts/commit-message-scan.sh --self-test # prove the rules on seeded commits
#   source scripts/commit-message-scan.sh      # scan_commit_messages, for tests
set -euo pipefail

PINNED_HISTORICAL_HEADS=(
  fc0df57df05b6745e190a53496bd5d90b7ae4bcb   # main
  e046885ad9f800f8d0c7a1fee965f9e670baee96   # the evaluation-contracts branch, origin/main
  00a68895d205122767167942326e2e0466571059   # the vertical-slice branch as first published
  d6ee68683ccd62fe72187e164387e2732cb85fa0   # the vertical-slice branch as accepted
  5b20589acdfb32597784e4bde5999b8adca67a55   # the durable-orchestration branch before it adopted this check
)

scan_commit_messages() {
  # Args: repo rev pinned_head... Prints one line per violation. Returns 0 if
  # any violation, 1 if clean (the convention of the other scanners).
  local repo="$1" rev="$2"; shift 2
  local exclude=() head
  for head in "$@"; do
    if git -C "$repo" cat-file -e "${head}^{commit}" 2>/dev/null; then
      exclude+=("^${head}")
    fi
  done

  # One git and one perl process for the whole range. Fields are separated by
  # US (0x1f) and records by RS (0x1e). The log is read whole before perl sees
  # it: in a pipeline a failed git log would end as perl's "clean".
  local log rc=0
  log="$(mktemp)"
  if ! git -C "$repo" log --format='%H%x1f%B%x1e' "$rev" ${exclude[@]+"${exclude[@]}"} -- > "$log" 2>/dev/null; then
    rm -f "$log"
    echo "  commit-message scanner failed (git log of $rev)"
    return 0
  fi
  perl -e '
        my $found = 0;
        local $/ = "\x1e";
        while (my $rec = <STDIN>) {
          chomp $rec;
          $rec =~ s/^\n+//;
          next if $rec eq "";
          my ($sha, $msg) = split /\x1f/, $rec, 2;
          my $short = substr($sha, 0, 12);
          for my $line (split /\n/, $msg // "") {
            my @why;
            push @why, "AI attribution trailer"
              if $line =~ /^\s*co-authored-by:.*\b(?:claude|anthropic|openai|chatgpt|gpt|copilot|codex|gemini|ai)\b/i;
            push @why, "AI attribution address" if $line =~ /noreply\@anthropic\.com/i;
            push @why, "AI attribution line" if $line =~ /\bgenerated\s+(?:with|by)\b.*\bclaude\b/i;
            push @why, "finding code" if $line =~ /\b(?:CRIT|HIGH|MED|LOW)-\d{3}\b/;
            for my $why (@why) {
              (my $shown = $line) =~ s/^\s+|\s+$//g;
              print "  commit $short: $why: " . substr($shown, 0, 120) . "\n";
              $found = 1;
            }
          }
        }
        exit($found ? 0 : 1);
      ' < "$log" || rc=$?
  rm -f "$log"
  # perl exits 0 on a hit and 1 when clean; anything else is a scanner fault,
  # which must read as a hit (fail closed), never as clean.
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) echo "  commit-message scanner failed (exit $rc)"; return 0 ;;
  esac
}

_cm_commit() {
  local repo="$1" msg="$2"
  GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid \
  GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid \
    git -C "$repo" -c core.hooksPath=/dev/null -c commit.gpgsign=false \
      commit -q --allow-empty -m "$msg"
}

self_test() {
  local tmp rc=0 pinned
  tmp="$(mktemp -d)"
  git init -q "$tmp/r"
  _cm_commit "$tmp/r" "$(printf 'docs: older work\n\nCo-Authored-By: %s <noreply@%s.com>' Claude anthropic)"
  pinned="$(git -C "$tmp/r" rev-parse HEAD)"
  _cm_commit "$tmp/r" 'fix(gate): a clean newer commit'
  if scan_commit_messages "$tmp/r" HEAD "$pinned" >/dev/null; then
    echo "self-test: FAIL (a pinned commit or a clean one was flagged)" >&2
    rc=1
  else
    echo "self-test: PASS (pinned history and a clean commit pass)"
  fi
  _cm_commit "$tmp/r" "$(printf 'fix(gate): newer work\n\nCo-Authored-By: %s <noreply@%s.com>' Claude anthropic)"
  if scan_commit_messages "$tmp/r" HEAD "$pinned" >/dev/null; then
    echo "self-test: PASS (a new AI attribution trailer caught)"
  else
    echo "self-test: FAIL (a new AI attribution trailer was not caught)" >&2
    rc=1
  fi
  rm -rf "$tmp"
  return $rc
}

main() {
  local repo
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
  fi
  echo "commit-message-scan: commits of HEAD not reachable from the ${#PINNED_HISTORICAL_HEADS[@]} pinned historical heads"
  if scan_commit_messages "$repo" HEAD "${PINNED_HISTORICAL_HEADS[@]}" > /tmp/asep-msg-report.$$; then
    echo "commit-message-scan: FAIL — AI attribution or finding codes in new commit messages:" >&2
    cat /tmp/asep-msg-report.$$ >&2
    rm -f /tmp/asep-msg-report.$$
    return 1
  fi
  rm -f /tmp/asep-msg-report.$$
  # Prove the scanner is live on every real run, not just when asked.
  if ! self_test >/dev/null; then
    echo "commit-message-scan: FAIL — the scanner's self-test failed" >&2
    return 1
  fi
  echo "commit-message-scan: PASS (no AI attribution or finding code in new commit messages; self-test green)"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
