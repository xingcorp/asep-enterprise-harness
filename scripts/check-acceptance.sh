#!/usr/bin/env bash
# Acceptance-marker gate (P1-FINAL-CRIT-001 + P1-REREVIEW-CRIT-001).
#
# Completion of Phase 1 is bound to a specific reviewed commit AND to evidence
# captured at that exact commit, and it is attested by a signature the worker
# cannot forge. A git object cannot embed its own hash and HEAD advances with
# every repair commit, so the report never hardcodes a head SHA. Instead the
# controller signs artifacts/phase-01/acceptance.json AFTER the independent
# review passes, and this gate verifies that marker still binds the CURRENT HEAD,
# the evidence, and carries a valid controller signature.
#
# Two properties this gate enforces that the earlier version did not:
#
#   1. EVIDENCE<->HEAD binding (P1-FINAL-CRIT-001). The evidence bundle records
#      the head_sha it was captured at (env-digest.txt). This gate requires
#          env-digest.head_sha == marker.reviewed_head == `git rev-parse HEAD`.
#      Previously nothing compared the CAPTURED head with the reviewed head, so
#      stale evidence (captured at an older commit) could back an ACCEPT for a
#      newer HEAD. Because the evidence bundle is now an untracked working-tree
#      artifact (a tracked file can never record the SHA of the commit that
#      contains it), a fresh capture at the reviewed HEAD is the ONLY way this
#      equality can hold.
#
#   2. CONTROLLER-OWNED attestation (P1-REREVIEW-CRIT-001). The marker is a
#      working-tree file the worker CAN write, so a plaintext `verdict: ACCEPT`
#      field is worthless — the worker just types it. Instead the marker must
#      carry an Ed25519 signature over (reviewed_head, base, evidence digest,
#      verdict), produced with a private key held OUT OF TREE by the controller
#      and verified here against the tracked reviewer public key
#      (artifacts/phase-01/reviewer-pubkey.pem). The worker has no private key,
#      so it cannot mint a marker, cannot move a signature to a new HEAD (the
#      head is inside the signed payload), and cannot flip the verdict.
#
# The marker is INVALID (this script exits non-zero) if any of:
#   - the marker file is absent (review has not accepted this state yet)
#   - marker.reviewed_head          != `git rev-parse HEAD`   (HEAD moved => stale)
#   - env-digest head_sha           != marker.reviewed_head    (stale evidence)
#   - marker.base                   != `git merge-base main HEAD`
#   - marker.evidence_index_sha256  != sha256(artifacts/phase-01/index.tsv)
#   - marker.verdict                != ACCEPT
#   - marker.signature does not verify against the reviewer public key
#
# A REQUEST_REPAIR (which lands new commits, moving HEAD) instantly invalidates
# any previously-signed acceptance marker: false completion cannot survive a
# repair, and the worker cannot re-sign for the new HEAD.
#
# Usage:
#   scripts/check-acceptance.sh                  # verify the committed marker binds HEAD
#   scripts/check-acceptance.sh <marker.json>    # verify a specific marker file
#   scripts/check-acceptance.sh --self-test      # prove the binding+signature logic
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MARKER_DEFAULT="artifacts/phase-01/acceptance.json"
EVIDENCE_INDEX="artifacts/phase-01/index.tsv"
ENV_DIGEST="artifacts/phase-01/env-digest.txt"
PUBKEY_DEFAULT="artifacts/phase-01/reviewer-pubkey.pem"
CRYPTO="$REPO_ROOT/scripts/lib/acceptance-crypto.mjs"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

# Read a top-level string field from a flat JSON object using node.
json_field() {
  local file="$1" key="$2"
  node -e '
    const fs = require("fs");
    const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = o[process.argv[2]];
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$file" "$key"
}

# Count head_sha lines in the env-digest so a missing OR duplicated head_sha is
# a hard failure (a doctored bundle could otherwise append a second head_sha).
env_digest_head_count() {
  local file="$1"
  grep -c '^head_sha:' "$file" 2>/dev/null || echo 0
}

# Extract head_sha from the env-digest (lines are "key: value"). Only meaningful
# when exactly one head_sha line exists; callers validate the count first.
env_digest_head() {
  local file="$1"
  awk -F': ' '/^head_sha:/ {print $2; exit}' "$file"
}

# Verify one marker file against a supplied (head, base, evidence-index-digest,
# env-digest-digest) tuple plus the evidence head, and a public key. Enforces
# HEAD binding, evidence<->HEAD binding, digest integrity, ACCEPT verdict, and a
# valid controller signature. Returns 0 only if all hold.
verify_marker() {
  local marker="$1" head="$2" base="$3" evidence_sha="$4" ev_head="$5" pubkey="$6" env_sha="$7"
  local rc=0

  if [ ! -f "$marker" ]; then
    echo "  acceptance: FAIL — marker $marker absent (review has not accepted this state)" >&2
    return 1
  fi

  local m_head
  m_head="$(json_field "$marker" reviewed_head)"

  # Evidence<->HEAD binding (P1-FINAL-CRIT-001 + P1-REREVIEW-CRIT-001a). The
  # evidence must have been captured at the SAME commit the marker reviews. A
  # MISSING/EMPTY evidence head_sha is a HARD FAIL, never a skip: the earlier
  # version guarded both stale-checks with `[ -n "$ev_head" ]`, so an empty
  # head_sha silently bypassed BOTH and let stale evidence back an ACCEPT
  # (fail-open). We now fail closed the moment the head is absent.
  if [ -z "$ev_head" ]; then
    echo "  acceptance: FAIL — evidence head_sha is empty/missing (env-digest has no usable head_sha; fail-closed)" >&2
    rc=1
  else
    if [ "$ev_head" != "$m_head" ]; then
      echo "  acceptance: FAIL — evidence head_sha $ev_head != reviewed_head $m_head (evidence captured at a different commit)" >&2
      rc=1
    fi
    if [ "$ev_head" != "$head" ]; then
      echo "  acceptance: FAIL — evidence head_sha $ev_head != current HEAD $head (stale evidence bundle)" >&2
      rc=1
    fi
  fi

  # Signature + field binding is delegated to the crypto helper, the single
  # authority for the rules. It checks reviewed_head/base/evidence-index/
  # env-digest/verdict and the Ed25519 signature over that tuple. Binding
  # env_digest_sha256 (P1-REREVIEW-CRIT-001b) means a doctored env-digest.txt —
  # e.g. head_sha rewritten to the current HEAD while reusing an old signed
  # index digest — changes the env-digest sha256 and breaks both the equality
  # check and the signature.
  if ! node "$CRYPTO" verify "$marker" "$pubkey" "$head" "$base" "$evidence_sha" "$env_sha"; then
    rc=1
  fi

  if [ "$rc" -eq 0 ]; then
    echo "  acceptance: valid — marker binds HEAD $head, base $base, evidence-index $evidence_sha, env-digest $env_sha (controller-signed)"
  fi
  return $rc
}

self_test() {
  local tmp head base ev_sha env_sha rc=0
  tmp="$(mktemp -d)"
  head="$(git rev-parse HEAD)"
  base="$(git merge-base main HEAD 2>/dev/null || git rev-parse HEAD)"
  # Synthetic evidence-index digest for the self-test.
  ev_sha="deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000"

  # A real env-digest whose head_sha == HEAD. Its sha256 is bound into the signed
  # payload, so editing head_sha later changes this sha and breaks the marker
  # (P1-REREVIEW-CRIT-001b). We compute env_sha from the actual bytes on disk.
  cat > "$tmp/env-digest.txt" <<EOF
captured_utc: 2026-01-01T00:00:00Z
node: self-test
base_sha: $base
head_sha: $head
EOF
  env_sha="$(sha256_of "$tmp/env-digest.txt")"

  # A throwaway controller keypair for the self-test only. In production the
  # private key lives OUT of tree; here we generate an ephemeral one so the test
  # is self-contained and never touches the real key.
  node "$CRYPTO" keygen "$tmp/priv.pem" "$tmp/pub.pem" 2>/dev/null

  # A validly signed marker for the real HEAD/base/evidence-index/env-digest.
  node "$CRYPTO" sign "$tmp/priv.pem" "$head" "$base" "$ev_sha" "$env_sha" "ACCEPT" "self-test" > "$tmp/good.json"

  # 1. Valid signed marker + matching evidence head must pass.
  if verify_marker "$tmp/good.json" "$head" "$base" "$ev_sha" "$head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: PASS (valid controller-signed marker accepted)"
  else
    echo "self-test: FAIL (valid marker was rejected)" >&2
    rc=1
  fi

  # 2. REQUEST_REPAIR moved HEAD: marker names old head, current HEAD differs.
  local moved_head="0000000000000000000000000000000000000000"
  if verify_marker "$tmp/good.json" "$moved_head" "$base" "$ev_sha" "$moved_head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (stale marker accepted after HEAD moved)" >&2
    rc=1
  else
    echo "self-test: PASS (stale marker rejected after HEAD moved — P1-CHANGE-008)"
  fi

  # 3. Tampered evidence-index digest must be rejected (signature won't cover it).
  if verify_marker "$tmp/good.json" "$head" "$base" "different-digest" "$head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (marker accepted with mismatched evidence digest)" >&2
    rc=1
  else
    echo "self-test: PASS (evidence-digest mismatch rejected)"
  fi

  # 4. STALE EVIDENCE (P1-FINAL-CRIT-001): valid signature + correct HEAD, but the
  # evidence bundle was captured at a DIFFERENT commit. Must be rejected.
  local other_head="1111111111111111111111111111111111111111"
  if verify_marker "$tmp/good.json" "$head" "$base" "$ev_sha" "$other_head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (stale evidence bundle accepted — CRIT-001 regression)" >&2
    rc=1
  else
    echo "self-test: PASS (evidence captured at a different HEAD rejected — P1-FINAL-CRIT-001)"
  fi

  # 5. FORGERY (P1-REREVIEW-CRIT-001): the worker mints a plaintext ACCEPT marker
  # with NO valid signature (or self-signs with a different key). Must be rejected
  # against the real reviewer public key.
  cat > "$tmp/forged.json" <<EOF
{
  "reviewed_head": "$head",
  "base": "$base",
  "evidence_index_sha256": "$ev_sha",
  "env_digest_sha256": "$env_sha",
  "verdict": "ACCEPT",
  "reviewer": "worker-pretending-to-be-controller",
  "signature": "bm90LWEtcmVhbC1zaWduYXR1cmU="
}
EOF
  if verify_marker "$tmp/forged.json" "$head" "$base" "$ev_sha" "$head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (forged/unsigned marker accepted — REREVIEW-CRIT-001 regression)" >&2
    rc=1
  else
    echo "self-test: PASS (worker-forged marker without valid signature rejected — P1-REREVIEW-CRIT-001)"
  fi

  # 6. A marker signed by the WRONG key (not the committed reviewer pubkey) fails.
  node "$CRYPTO" keygen "$tmp/attacker-priv.pem" "$tmp/attacker-pub.pem" 2>/dev/null
  node "$CRYPTO" sign "$tmp/attacker-priv.pem" "$head" "$base" "$ev_sha" "$env_sha" "ACCEPT" "attacker" > "$tmp/wrongkey.json"
  if verify_marker "$tmp/wrongkey.json" "$head" "$base" "$ev_sha" "$head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (marker signed by wrong key accepted)" >&2
    rc=1
  else
    echo "self-test: PASS (marker signed by a non-reviewer key rejected)"
  fi

  # 7. Non-ACCEPT verdict, even validly signed, must be rejected.
  node "$CRYPTO" sign "$tmp/priv.pem" "$head" "$base" "$ev_sha" "$env_sha" "REQUEST_REPAIR" "self-test" > "$tmp/repair.json"
  if verify_marker "$tmp/repair.json" "$head" "$base" "$ev_sha" "$head" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (REQUEST_REPAIR verdict accepted)" >&2
    rc=1
  else
    echo "self-test: PASS (non-ACCEPT verdict rejected)"
  fi

  # 8. EMPTY head_sha (P1-REREVIEW-CRIT-001a): the previous version guarded both
  # stale-checks with `[ -n "$ev_head" ]`, so a MISSING/EMPTY head_sha silently
  # skipped BOTH and let an otherwise-valid marker through (fail-open). An empty
  # evidence head must now be a HARD FAIL. We pass a validly-signed marker so the
  # ONLY reason it can fail is the empty head — proving the check fails closed.
  if verify_marker "$tmp/good.json" "$head" "$base" "$ev_sha" "" "$tmp/pub.pem" "$env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (empty evidence head_sha accepted — REREVIEW-CRIT-001a fail-open regression)" >&2
    rc=1
  else
    echo "self-test: PASS (empty evidence head_sha rejected fail-closed — P1-REREVIEW-CRIT-001a)"
  fi

  # 9. ENV-DIGEST SUBSTITUTION (P1-REREVIEW-CRIT-001b): reuse the marker signed
  # over the ORIGINAL env-digest, but present a DOCTORED env-digest — head_sha
  # rewritten to the current HEAD (the exact caa1bff-style trick) while keeping
  # the old signature. Its sha256 differs from the signed env_digest_sha256, so
  # verify_marker must reject it: the env-digest is inside the signed scope, so
  # editing head_sha breaks both the digest-equality check and the signature.
  cat > "$tmp/env-digest-doctored.txt" <<EOF
captured_utc: 2026-01-01T00:00:00Z
node: self-test
base_sha: $base
head_sha: $head
extra_tamper_marker: injected
EOF
  local doctored_env_sha
  doctored_env_sha="$(sha256_of "$tmp/env-digest-doctored.txt")"
  if verify_marker "$tmp/good.json" "$head" "$base" "$ev_sha" "$head" "$tmp/pub.pem" "$doctored_env_sha" >/dev/null 2>&1; then
    echo "self-test: FAIL (doctored env-digest accepted with stale signature — REREVIEW-CRIT-001b regression)" >&2
    rc=1
  else
    echo "self-test: PASS (substituted/doctored env-digest rejected — P1-REREVIEW-CRIT-001b)"
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
  local head base evidence_sha ev_head
  head="$(git rev-parse HEAD)"
  base="$(git merge-base main HEAD 2>/dev/null || echo NO_MERGE_BASE)"

  if [ ! -f "$EVIDENCE_INDEX" ]; then
    echo "check-acceptance: FAIL — evidence index $EVIDENCE_INDEX missing (run scripts/capture-evidence.sh at the reviewed HEAD)" >&2
    return 1
  fi
  if [ ! -f "$ENV_DIGEST" ]; then
    echo "check-acceptance: FAIL — env digest $ENV_DIGEST missing (run scripts/capture-evidence.sh at the reviewed HEAD)" >&2
    return 1
  fi
  if [ ! -f "$PUBKEY_DEFAULT" ]; then
    echo "check-acceptance: FAIL — reviewer public key $PUBKEY_DEFAULT missing" >&2
    return 1
  fi
  evidence_sha="$(sha256_of "$EVIDENCE_INDEX")"
  env_sha="$(sha256_of "$ENV_DIGEST")"

  # A well-formed env-digest carries EXACTLY ONE head_sha line. Zero => nothing
  # to bind against (fail-closed, P1-REREVIEW-CRIT-001a). More than one => a
  # doctored bundle trying to smuggle a second head; reject before we ever read
  # a value.
  local head_lines
  head_lines="$(env_digest_head_count "$ENV_DIGEST")"
  if [ "$head_lines" -ne 1 ]; then
    echo "check-acceptance: FAIL — env-digest $ENV_DIGEST must contain exactly one head_sha line (found $head_lines)" >&2
    return 1
  fi
  ev_head="$(env_digest_head "$ENV_DIGEST")"

  echo "check-acceptance: verifying $marker binds HEAD=$head base=$base (evidence head=$ev_head)"
  if verify_marker "$marker" "$head" "$base" "$evidence_sha" "$ev_head" "$PUBKEY_DEFAULT" "$env_sha"; then
    echo "check-acceptance: PASS (acceptance marker binds current HEAD, evidence, and is controller-signed)"
  else
    echo "check-acceptance: FAIL (no valid acceptance marker for this HEAD)" >&2
    return 1
  fi
}

main "$@"
