import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-acceptance.sh");

function runSelfTest(): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [script, "--self-test"], {
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

// The bash self-test proves the four binding rules internally. We assert it
// exits 0 and reports all four PASS lines, so the deterministic test suite
// (not just an ad-hoc shell run) guards the acceptance mechanism.
test("acceptance script self-test proves HEAD-binding (P1-CHANGE-008)", () => {
  const { code, out } = runSelfTest();
  assert.equal(code, 0, `self-test should exit 0\n${out}`);
  assert.match(out, /valid marker accepted/);
  assert.match(out, /stale marker rejected after HEAD moved/);
  assert.match(out, /evidence-digest mismatch rejected/);
  assert.match(out, /non-ACCEPT verdict rejected/);
});

// Directly simulate a REQUEST_REPAIR: a marker that names a stale head must be
// rejected by the real gate against the current HEAD.
test("stale marker (REQUEST_REPAIR moved HEAD) is invalid against current HEAD", () => {
  const repoRoot = join(here, "..");
  const currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const base = execFileSync("git", ["merge-base", "main", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  const dir = mkdtempSync(join(tmpdir(), "asep-acc-"));
  const marker = join(dir, "acceptance.json");
  // Marker names a DIFFERENT (stale) head — the situation right after a repair
  // commit lands and HEAD advances past the reviewed commit.
  writeFileSync(
    marker,
    JSON.stringify({
      reviewed_head: "0000000000000000000000000000000000000000",
      base,
      evidence_index_sha256: "unused-because-head-check-fails-first",
      verdict: "ACCEPT",
    }),
  );

  let failed = false;
  try {
    execFileSync("bash", [script, marker], { cwd: repoRoot, encoding: "utf8" });
  } catch {
    failed = true;
  }
  rmSync(dir, { recursive: true, force: true });
  assert.ok(
    failed,
    `a marker naming stale head must be rejected against current HEAD ${currentHead}`,
  );
});
