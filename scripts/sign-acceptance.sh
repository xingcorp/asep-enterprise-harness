#!/usr/bin/env bash
# Controller-side acceptance signer (P1-REREVIEW-CRIT-001).
#
# This is the ONLY way a valid acceptance marker is created. It is run by the
# controller/reviewer — NOT the worker — AFTER an independent review returns
# ACCEPT_PHASE. It requires the Ed25519 PRIVATE key, which lives OUT OF TREE and
# is never available to the worker, so the worker cannot invoke this to mint its
# own acceptance.
#
# What it does:
#   1. Recomputes the binding triple from the CURRENT working tree:
#        reviewed_head = git rev-parse HEAD
#        base          = git merge-base main HEAD
#        ev_sha        = sha256(artifacts/phase-01/index.tsv)
#   2. Refuses to sign unless the evidence bundle was captured at THIS HEAD
#      (env-digest.head_sha == reviewed_head) — you cannot sign over stale
#      evidence (P1-FINAL-CRIT-001).
#   3. Signs (reviewed_head, base, ev_sha, verdict) with the private key and
#      writes artifacts/phase-01/acceptance.json.
#   4. Verifies the freshly written marker with scripts/check-acceptance.sh so a
#      bad marker is never left behind.
#
# Usage:
#   ASEP_REVIEWER_KEY=/path/to/priv.pem scripts/sign-acceptance.sh [ACCEPT|REQUEST_REPAIR] [reviewer-name]
#
# The default verdict is ACCEPT. Signing a REQUEST_REPAIR is supported so the
# controller can record a rejection that the gate will (correctly) refuse to
# treat as completion.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CRYPTO="$REPO_ROOT/scripts/lib/acceptance-crypto.mjs"
OUT_DIR="artifacts/phase-01"
EVIDENCE_INDEX="$OUT_DIR/index.tsv"
ENV_DIGEST="$OUT_DIR/env-digest.txt"
MARKER="$OUT_DIR/acceptance.json"

VERDICT="${1:-ACCEPT}"
REVIEWER="${2:-controller}"

if [ -z "${ASEP_REVIEWER_KEY:-}" ]; then
  echo "sign-acceptance: FAIL — set ASEP_REVIEWER_KEY to the controller private key path" >&2
  echo "  (the private key lives OUT of tree; the worker does not have it)" >&2
  exit 1
fi
if [ ! -f "$ASEP_REVIEWER_KEY" ]; then
  echo "sign-acceptance: FAIL — private key $ASEP_REVIEWER_KEY not found" >&2
  exit 1
fi
if [ ! -f "$EVIDENCE_INDEX" ] || [ ! -f "$ENV_DIGEST" ]; then
  echo "sign-acceptance: FAIL — evidence bundle missing; run scripts/capture-evidence.sh first" >&2
  exit 1
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

HEAD_SHA="$(git rev-parse HEAD)"
BASE_SHA="$(git merge-base main HEAD 2>/dev/null || echo NO_MERGE_BASE)"
EV_SHA="$(sha256_of "$EVIDENCE_INDEX")"
ENV_SHA="$(sha256_of "$ENV_DIGEST")"

# The env-digest must carry EXACTLY ONE head_sha line (missing => nothing to
# bind, fail-closed; duplicate => doctored bundle). Reject before reading it.
HEAD_LINES="$(grep -c '^head_sha:' "$ENV_DIGEST" 2>/dev/null || echo 0)"
if [ "$HEAD_LINES" -ne 1 ]; then
  echo "sign-acceptance: FAIL — env-digest $ENV_DIGEST must contain exactly one head_sha line (found $HEAD_LINES)" >&2
  exit 1
fi
EV_HEAD="$(awk -F': ' '/^head_sha:/ {print $2; exit}' "$ENV_DIGEST")"

# Refuse to sign over stale evidence (P1-FINAL-CRIT-001) or an empty head.
if [ -z "$EV_HEAD" ]; then
  echo "sign-acceptance: FAIL — evidence head_sha is empty/missing in $ENV_DIGEST" >&2
  exit 1
fi
if [ "$EV_HEAD" != "$HEAD_SHA" ]; then
  echo "sign-acceptance: FAIL — evidence head_sha $EV_HEAD != current HEAD $HEAD_SHA" >&2
  echo "  Re-run scripts/capture-evidence.sh at the reviewed HEAD before signing." >&2
  exit 1
fi

# Sign over BOTH the evidence-index digest AND the env-digest digest
# (P1-REREVIEW-CRIT-001b) so a doctored env-digest breaks the signature.
echo "sign-acceptance: signing $VERDICT for HEAD=$HEAD_SHA base=$BASE_SHA evidence-index=$EV_SHA env-digest=$ENV_SHA"
node "$CRYPTO" sign "$ASEP_REVIEWER_KEY" "$HEAD_SHA" "$BASE_SHA" "$EV_SHA" "$ENV_SHA" "$VERDICT" "$REVIEWER" > "$MARKER"
echo "sign-acceptance: wrote $MARKER"

# Verify the freshly written marker end-to-end so we never leave a bad one.
echo "sign-acceptance: verifying the freshly signed marker"
scripts/check-acceptance.sh "$MARKER"
