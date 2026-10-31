#!/usr/bin/env bash
# Capture per-gate evidence into artifacts/phase-01/ (Phase 1 exit criterion G2).
#
# For each gate it records: the command, exit code, wall-clock duration, a
# sha256 checksum of combined stdout+stderr, and (once) a tool-version + env
# digest. Raw combined output is written next to the record so a reviewer can
# inspect it; checksums make tampering detectable. This script is deterministic
# in structure (not in durations) — durations are recorded for information only
# and are NOT part of any pass/fail gate.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/lib/main-base.sh
source "$REPO_ROOT/scripts/lib/main-base.sh"

OUT_DIR="artifacts/phase-01"
GATES_DIR="$OUT_DIR/gates"
mkdir -p "$GATES_DIR"

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

# Environment digest (tool versions + platform), written once.
{
  echo "captured_utc: $(TZ=UTC date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "node: $(node --version)"
  echo "pnpm: $(pnpm --version)"
  echo "tsc: $(pnpm exec tsc --version 2>/dev/null || echo unknown)"
  echo "os: $(uname -srm)"
  echo "base_sha: $(main_merge_base || echo unknown)"
  echo "head_sha: $(git rev-parse HEAD)"
} > "$OUT_DIR/env-digest.txt"

# env digest checksum
sha256 "$OUT_DIR/env-digest.txt" > "$OUT_DIR/env-digest.sha256"

INDEX="$OUT_DIR/index.tsv"
printf 'gate\tcommand\texit_code\tduration_s\toutput_sha256\n' > "$INDEX"

# Redact machine-specific absolute paths so committed logs carry no internal
# filesystem paths (keeps the publication abs-path scan green). The repo root
# becomes <REPO>, the home dir becomes <HOME>, and any leftover openclaw run dir
# is collapsed to <RUNDIR>.
sanitize() {
  local home_esc repo_esc
  repo_esc=$(printf '%s' "$REPO_ROOT" | sed 's/[.[\*^$/]/\\&/g')
  home_esc=$(printf '%s' "$HOME" | sed 's/[.[\*^$/]/\\&/g')
  sed -e "s/${repo_esc}/<REPO>/g" \
      -e "s/${home_esc}/<HOME>/g" \
      -e 's#/[^ ]*/\.openclaw/runs/[0-9][^/ ]*#<RUNDIR>#g'
}

run_gate() {
  local name="$1"; shift
  local cmd="$*"
  local raw="$GATES_DIR/$name.log"
  local start end dur code
  start=$(date +%s)
  # shellcheck disable=SC2086
  bash -c "$cmd" 2>&1 | sanitize > "$raw"
  code=${PIPESTATUS[0]}
  end=$(date +%s)
  dur=$((end - start))
  local csum
  csum=$(sha256 "$raw")
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$cmd" "$code" "$dur" "$csum" >> "$INDEX"
  # per-gate record
  {
    echo "gate: $name"
    echo "command: $cmd"
    echo "exit_code: $code"
    echo "duration_s: $dur"
    echo "output_sha256: $csum"
    echo "output_file: gates/$name.log"
  } > "$GATES_DIR/$name.record.txt"
  echo "  [$name] exit=$code dur=${dur}s sha=${csum:0:12}"
  return $code
}

echo "capture-evidence: recording gate evidence into $OUT_DIR"

fail=0
run_gate "install-frozen"     "pnpm install --frozen-lockfile" || fail=1
run_gate "format-check"       "pnpm format:check" || fail=1
run_gate "typecheck"          "pnpm typecheck" || fail=1
run_gate "test"               "pnpm test" || fail=1
run_gate "contracts-test"     "pnpm --filter @asep/contracts test" || fail=1
run_gate "policy-test"        "pnpm --filter @asep/policy test" || fail=1
run_gate "contracts-compat"   "pnpm --filter @asep/contracts compat:gate" || fail=1
run_gate "forbidden-imports"  "pnpm exec node --no-wasm-code-gc --import tsx --test scripts/forbidden-imports.test.ts" || fail=1
run_gate "secret-scan"        "bash scripts/secret-scan.sh" || fail=1
run_gate "large-file-scan"    "bash scripts/large-file-scan.sh" || fail=1
run_gate "pii-scan"           "bash scripts/pii-scan.sh" || fail=1
run_gate "check-publication"  "bash scripts/check-publication.sh" || fail=1
run_gate "eval-determinism"   "pnpm --filter @asep/evals eval > /tmp/asep-eval-a.json && pnpm --filter @asep/evals eval > /tmp/asep-eval-b.json && diff -q /tmp/asep-eval-a.json /tmp/asep-eval-b.json && echo BYTE-IDENTICAL" || fail=1
# NOTE: the composite `pnpm verify:all` is deliberately NOT captured here. It
# ends in a clean-tree assertion, but capture-evidence writes into tracked
# artifacts/phase-01/ by design, so running verify:all mid-capture would fail on
# a dirty tree by construction. The individual gates above ARE every step
# verify:all runs (minus that clean-tree assertion); CI runs verify:all directly.

sha256 "$INDEX" > "$OUT_DIR/index.sha256"

if [ "$fail" -ne 0 ]; then
  echo "capture-evidence: at least one gate FAILED (see records)" >&2
  exit 1
fi
echo "capture-evidence: all gates green; evidence written to $OUT_DIR"
