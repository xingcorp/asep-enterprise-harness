#!/usr/bin/env bash
# Dependency-license inventory gate (P1-FINAL-HIGH-003).
#
# Replaces the previous checklist-presence stub. Enumerates the REAL installed
# dependency tree (direct + transitive) via `pnpm licenses list --json` and
# fails if any package carries a license outside the allowlist. A copyleft or
# unknown license blocks a public push.
#
# Usage:
#   scripts/license-inventory.sh            # audit the installed tree
#   scripts/license-inventory.sh --self-test  # prove a forbidden license is rejected
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# SPDX identifiers permitted for redistribution under Apache-2.0. Permissive
# only — no GPL/AGPL/LGPL/MPL/CDDL/EPL copyleft.
ALLOWLIST=(
  "Apache-2.0"
  "MIT"
  "ISC"
  "BSD-2-Clause"
  "BSD-3-Clause"
  "0BSD"
  "CC0-1.0"
  "Unlicense"
  "BlueOak-1.0.0"
  "Python-2.0"
)

is_allowed() {
  local lic="$1" allowed
  for allowed in "${ALLOWLIST[@]}"; do
    [ "$lic" = "$allowed" ] && return 0
  done
  return 1
}

# Extract "name<TAB>license" rows from `pnpm licenses list --json`. The JSON is
# keyed by license string -> array of package objects. We use node (always
# present) to flatten it deterministically.
inventory_rows() {
  pnpm licenses list --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let data;
      try { data = JSON.parse(raw); } catch { process.exit(0); }
      const rows = [];
      // Shape: { "MIT": [ {name, ...}, ... ], ... }
      for (const [license, pkgs] of Object.entries(data)) {
        if (!Array.isArray(pkgs)) continue;
        for (const p of pkgs) {
          rows.push(`${p.name || "<unknown>"}\t${license}`);
        }
      }
      rows.sort();
      process.stdout.write(rows.join("\n") + (rows.length ? "\n" : ""));
    });
  '
}

audit_rows() {
  # Reads name<TAB>license rows on stdin. Prints violations. Returns 1 if any.
  local violations=0 name lic
  while IFS=$'\t' read -r name lic; do
    [ -z "$name" ] && continue
    if ! is_allowed "$lic"; then
      echo "  FORBIDDEN: $name -> $lic (not in allowlist)" >&2
      violations=1
    fi
  done
  return $violations
}

self_test() {
  local rc=0
  # A synthetic tree containing a GPL package MUST be rejected.
  if printf 'good-pkg\tMIT\nbad-pkg\tGPL-3.0-only\n' | audit_rows >/dev/null 2>&1; then
    echo "self-test: FAIL (GPL dependency was accepted)" >&2
    rc=1
  else
    echo "self-test: PASS (GPL dependency rejected)"
  fi
  # An all-permissive tree MUST pass.
  if printf 'a\tMIT\nb\tApache-2.0\nc\tISC\n' | audit_rows >/dev/null 2>&1; then
    echo "self-test: PASS (all-permissive tree accepted)"
  else
    echo "self-test: FAIL (permissive tree rejected)" >&2
    rc=1
  fi
  # An unknown/empty license MUST be rejected (fail-closed).
  if printf 'x\tUNKNOWN\n' | audit_rows >/dev/null 2>&1; then
    echo "self-test: FAIL (UNKNOWN license accepted)" >&2
    rc=1
  else
    echo "self-test: PASS (unknown license rejected — fail-closed)"
  fi
  return $rc
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return
  fi

  local rows
  rows="$(inventory_rows)"
  if [ -z "$rows" ]; then
    echo "license-inventory: FAIL — could not read dependency license data (pnpm licenses list)" >&2
    return 1
  fi

  local count
  count="$(printf '%s\n' "$rows" | grep -c . || true)"
  echo "license-inventory: auditing $count installed package(s) (direct + transitive)"

  if ! printf '%s\n' "$rows" | audit_rows; then
    echo "license-inventory: FAIL — non-permissive license(s) present" >&2
    return 1
  fi

  # Prove the auditor is live on every real run.
  self_test >/dev/null

  local licenses
  licenses="$(printf '%s\n' "$rows" | cut -f2 | sort -u | paste -sd', ' -)"
  echo "license-inventory: PASS (all permissive: $licenses; self-test green)"
}

main "$@"
