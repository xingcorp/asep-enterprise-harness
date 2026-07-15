#!/usr/bin/env bash
# Acceptance-marker gate (P1-FINAL-CRIT-001 / P1-CHANGE-008).
#
# Completion of Phase 1 is bound to a specific reviewed commit. A git object
# cannot embed its own hash and HEAD advances with every repair commit, so the
# report never hardcodes a head SHA. Instead the controller writes
# artifacts/phase-01/acceptance.json AFTER the independent review passes, and
# this gate verifies that marker still binds the CURRENT HEAD and evidence.
#
# The marker is INVALID (this script exits non-zero) if any of:
#   - the marker file is absent (review has not accepted this state yet)
#   - marker.reviewed_head  != `git rev-parse HEAD`   (HEAD moved => stale)
#   - marker.base           != `git merge-base main HEAD`
#   - marker.evidence_index_sha256 != sha256(artifacts/phase-01/index.tsv)
#   - marker.verdict        != ACCEPT
#
# This means a REQUEST_REPAIR (which lands new commits, moving HEAD) instantly
# invalidates any previously-written acceptance marker: false completion cannot
# survive a repair.
#
# Usage:
#   scripts/check-acceptance.sh                  # verify the committed marker binds HEAD
#   scripts/check-acceptance.sh <marker.json>    # verify a specific marker file
#   scripts/check-acceptance.sh --self-test      # prove the binding logic (no marker needed)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MARKER_DEFAULT="artifacts/phase-01/acceptance.json"
EVIDENCE_INDEX="artifacts/phase-01/index.tsv"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

# Read a top-level string field from a flat JSON object using node (always
# present here). Prints the value or empty string.
json_field() {
  local file="$1" key="$2"
  node -e '
    const fs = require("fs");
    const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = o[process.argv[2]];
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$file" "$key"
}

# Verify one marker file against a supplied (head, base, evidence-digest) triple.
# Returns 0 if the marker validly binds that triple with an ACCEPT verdict.
verify_marker() {
  local marker="$1" head="$2" base="$3" evidence_sha="$4"
  local rc=0

  if [ ! -f "$marker" ]; then
    echo "  acceptance: FAIL — marker $marker absent (review has not accepted this state)" >&2
    return 1
  fi

  local m_head m_base m_ev m_verdict
  m_head="$(json_field "$marker" reviewed_head)"
  m_base="$(json_field "$marker" base)"
  m_ev="$(json_field "$marker" evidence_index_sha256)"
  m_verdict="$(json_field "$marker" verdict)"

  if [ "$m_head" != "$head" ]; then
    echo "  acceptance: FAIL — reviewed_head $m_head != current HEAD $head (marker stale; HEAD moved)" >&2
    rc=1
  fi
  if [ "$m_base" != "$base" ]; then
    echo "  acceptance: FAIL — base $m_base != merge-base $base" >&2
    rc=1
  fi
  if [ "$m_ev" != "$evidence_sha" ]; then
    echo "  acceptance: FAIL — evidence_index_sha256 $m_ev != actual $evidence_sha (evidence changed)" >&2
    rc=1
  fi
  if [ "$m_verdict" != "ACCEPT" ]; then
    echo "  acceptance: FAIL — verdict is \"$m_verdict\", not ACCEPT" >&2
    rc=1
  fi

  if [ "$rc" -eq 0 ]; then
    echo "  acceptance: valid — marker binds HEAD $head, base $base, evidence $evidence_sha"
  fi
  return $rc
}

self_test() {
  local tmp head base ev rc=0
  tmp="$(mktemp -d)"
  head="$(git rev-parse HEAD)"
  base="$(git merge-base main HEAD 2>/dev/null || git rev-parse HEAD)"
  # Use a fixed synthetic evidence digest for the self-test.
  ev="deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000"

  # 1. A marker that binds the real HEAD/base/evidence with ACCEPT must be valid.
  cat > "$tmp/good.json" <<EOF
{
  "reviewed_head": "$head",
  "base": "$base",
  "evidence_index_sha256": "$ev",
  "verdict": "ACCEPT",
  "reviewer": "self-test"
}
EOF
  if verify_marker "$tmp/good.json" "$head" "$base" "$ev" >/dev/null 2>&1; then
    echo "self-test: PASS (valid marker accepted)"
  else
    echo "self-test: FAIL (valid marker was rejected)" >&2
    rc=1
  fi

  # 2. Simulate REQUEST_REPAIR: HEAD moves to a new SHA, marker still names the old one.
  local moved_head="0000000000000000000000000000000000000000"
  if verify_marker "$tmp/good.json" "$moved_head" "$base" "$ev" >/dev/null 2>&1; then
    echo "self-test: FAIL (stale marker accepted after HEAD moved)" >&2
    rc=1
  else
    echo "self-test: PASS (stale marker rejected after HEAD moved — P1-CHANGE-008)"
  fi

  # 3. Tampered evidence digest must be rejected.
  if verify_marker "$tmp/good.json" "$head" "$base" "different-digest" >/dev/null 2>&1; then
    echo "self-test: FAIL (marker accepted with mismatched evidence digest)" >&2
    rc=1
  else
    echo "self-test: PASS (evidence-digest mismatch rejected)"
  fi

  # 4. Non-ACCEPT verdict must be rejected.
  cat > "$tmp/repair.json" <<EOF
{
  "reviewed_head": "$head",
  "base": "$base",
  "evidence_index_sha256": "$ev",
  "verdict": "REQUEST_REPAIR",
  "reviewer": "self-test"
}
EOF
  if verify_marker "$tmp/repair.json" "$head" "$base" "$ev" >/dev/null 2>&1; then
    echo "self-test: FAIL (REQUEST_REPAIR verdict accepted)" >&2
    rc=1
  else
    echo "self-test: PASS (non-ACCEPT verdict rejected)"
  fi

  rm -rf "$tmp"
  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
  fi

  local marker="${1:-$MARKER_DEFAULT}"
  local head base evidence_sha
  head="$(git rev-parse HEAD)"
  base="$(git merge-base main HEAD 2>/dev/null || echo NO_MERGE_BASE)"
  if [ ! -f "$EVIDENCE_INDEX" ]; then
    echo "check-acceptance: FAIL — evidence index $EVIDENCE_INDEX missing" >&2
    return 1
  fi
  evidence_sha="$(sha256_of "$EVIDENCE_INDEX")"

  echo "check-acceptance: verifying $marker binds HEAD=$head base=$base"
  if verify_marker "$marker" "$head" "$base" "$evidence_sha"; then
    echo "check-acceptance: PASS (acceptance marker binds current HEAD and evidence)"
  else
    echo "check-acceptance: FAIL (no valid acceptance marker for this HEAD)" >&2
    return 1
  fi
}

main "$@"
