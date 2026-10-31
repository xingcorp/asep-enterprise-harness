# shellcheck shell=bash
# Single source of truth for secret detection patterns (P1-FINAL-HIGH-003).
#
# Both the working-tree scanner (scripts/secret-scan.sh) and the git-history
# scanner (scripts/check-publication.sh) source THIS file, so a pattern added
# here is enforced by both. Previously the two carried divergent copies and the
# history scan was missing sk-[A-Za-z0-9]{20,} (a live OpenAI-style key removed
# from HEAD but reachable in history would have leaked).
#
# The `sk-` keys must stand on their own: a key starts a token, so the pattern
# requires the start of a line or a character that cannot be part of a word
# before it. Without that boundary the `sk-` at the tail of every
# `asep-task-<ULID>` workflow id ("task-" then 26 letters and digits) read as a
# key. Anthropic keys are base64url after `sk-ant-`, so `_` is part of them.
# scripts/secret-patterns.test.ts runs the controls through both scans.
#
# Usage:
#   source "$(dirname "$0")/lib/secret-patterns.sh"
#   for pat in "${SECRET_PATTERNS[@]}"; do grep -nE -e "$pat" file; done
#   grep -nE -e "$SECRET_PATTERNS_ALT" file     # single alternation string
#
# ALWAYS pass the pattern with `-e`. The PEM entry below begins with '-', so a
# bare `grep -nE "$pat"` parses it as a bundle of short options and exits 2 —
# which a plain `if grep ...` reads as "no match". Iterating this array without
# -e silently skips every PEM private key while still reporting a clean scan.

# shellcheck disable=SC2034
SECRET_PATTERNS=(
  'AKIA[0-9A-Z]{16}'                                   # AWS access key id
  'ASIA[0-9A-Z]{16}'                                   # AWS temp access key id
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                 # PEM private key
  'ghp_[A-Za-z0-9]{36}'                                # GitHub personal token
  'gho_[A-Za-z0-9]{36}'                                # GitHub OAuth token
  'github_pat_[A-Za-z0-9_]{22,}'                       # GitHub fine-grained PAT
  'xox[baprs]-[A-Za-z0-9-]{10,}'                       # Slack token
  '(^|[^A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{20,}'         # Anthropic-style key
  '(^|[^A-Za-z0-9_])sk-[A-Za-z0-9]{20,}'               # OpenAI-style secret key
  'AIza[0-9A-Za-z_-]{35}'                              # Google API key
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' # JWT
  'glpat-[A-Za-z0-9_-]{20}'                            # GitLab PAT
)

# Single ERE alternation built from the array above, for tools (git grep) that
# take one pattern string. Kept in lockstep automatically — never hand-edit.
build_secret_alternation() {
  local IFS='|'
  printf '%s' "${SECRET_PATTERNS[*]}"
}
SECRET_PATTERNS_ALT="$(build_secret_alternation)"
