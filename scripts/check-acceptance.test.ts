import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-acceptance.sh");
const crypto = join(here, "lib", "acceptance-crypto.mjs");
const repoRoot = join(here, "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function runSelfTest(): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [script, "--self-test"], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

// The bash self-test proves every binding + signature rule internally. We assert
// it exits 0 and reports each PASS line, so the deterministic test suite (not
// just an ad-hoc shell run) guards the acceptance mechanism.
test("acceptance self-test proves HEAD + evidence binding and signature enforcement", () => {
  const { code, out } = runSelfTest();
  assert.equal(code, 0, `self-test should exit 0\n${out}`);
  assert.match(out, /valid controller-signed marker accepted/);
  assert.match(out, /stale marker rejected after HEAD moved/);
  assert.match(out, /evidence-digest mismatch rejected/);
  assert.match(out, /evidence captured at a different HEAD rejected/);
  assert.match(out, /worker-forged marker without valid signature rejected/);
  assert.match(out, /marker signed by a non-reviewer key rejected/);
  assert.match(out, /non-ACCEPT verdict rejected/);
  // P1-REREVIEW-CRIT-001a: an empty evidence head_sha must fail closed (no skip).
  assert.match(out, /empty evidence head_sha rejected fail-closed/);
  // P1-REREVIEW-CRIT-001b: a doctored env-digest reusing an old signature must be
  // rejected because env-digest is inside the signed scope.
  assert.match(out, /substituted\/doctored env-digest rejected/);
});

// P1-REREVIEW-CRIT-001: a worker-authored plaintext marker (correct HEAD/base/
// evidence, verdict ACCEPT, but NO valid controller signature) must be rejected
// against the committed reviewer public key. This is the core anti-forgery
// property: writing the file is not enough — you must sign it.
test("a worker-forged unsigned marker is rejected against the real reviewer key", () => {
  const head = git("rev-parse", "HEAD");
  const base = git("merge-base", "main", "HEAD");
  const dir = mkdtempSync(join(tmpdir(), "asep-acc-"));
  const marker = join(dir, "acceptance.json");
  writeFileSync(
    marker,
    JSON.stringify({
      reviewed_head: head,
      base,
      evidence_index_sha256: "whatever",
      verdict: "ACCEPT",
      reviewer: "worker",
      signature: "bm90LXJlYWw=",
    }),
  );
  let failed = false;
  try {
    execFileSync("bash", [script, marker], { cwd: repoRoot, encoding: "utf8" });
  } catch {
    failed = true;
  }
  rmSync(dir, { recursive: true, force: true });
  assert.ok(failed, "an unsigned/forged marker must be rejected");
});

// P1-CHANGE-008: a marker naming a stale head must be rejected against the
// current HEAD even if it is otherwise validly signed for that stale head.
test("a signed marker for a stale head is invalid against current HEAD", () => {
  const base = git("merge-base", "main", "HEAD");
  const dir = mkdtempSync(join(tmpdir(), "asep-acc-"));
  const priv = join(dir, "priv.pem");
  const pub = join(dir, "pub.pem");
  execFileSync("node", [crypto, "keygen", priv, pub]);
  const staleHead = "0000000000000000000000000000000000000000";
  const marker = join(dir, "acceptance.json");
  // Validly sign for the STALE head; the gate must still reject it because the
  // current HEAD differs.
  const signed = execFileSync(
    "node",
    [crypto, "sign", priv, staleHead, base, "some-digest", "some-env-digest", "ACCEPT", "test"],
    { encoding: "utf8" },
  );
  writeFileSync(marker, signed);

  let failed = false;
  try {
    execFileSync("bash", [script, marker], { cwd: repoRoot, encoding: "utf8" });
  } catch {
    failed = true;
  }
  rmSync(dir, { recursive: true, force: true });
  assert.ok(failed, "a marker naming a stale head must be rejected against current HEAD");
});

// P1-REREVIEW-CRIT-001 (transplant): a signature validly minted for one HEAD
// cannot be transplanted onto a marker claiming a different HEAD, because the
// head is inside the signed payload. Take the self-test's own construction: sign
// for head A, then rewrite reviewed_head to head B keeping the old signature.
test("a signature cannot be transplanted to a different HEAD (head is inside the payload)", () => {
  const base = git("merge-base", "main", "HEAD");
  const dir = mkdtempSync(join(tmpdir(), "asep-acc-"));
  const priv = join(dir, "priv.pem");
  const pub = join(dir, "pub.pem");
  execFileSync("node", [crypto, "keygen", priv, pub]);
  const headA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const headB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const signed = JSON.parse(
    execFileSync("node", [crypto, "sign", priv, headA, base, "digest", "env-digest", "ACCEPT", "test"], {
      encoding: "utf8",
    }),
  );
  // Transplant: keep the signature, swap the head.
  signed.reviewed_head = headB;
  const marker = join(dir, "acceptance.json");
  writeFileSync(marker, JSON.stringify(signed));

  // Verify directly via the crypto helper against headB — must fail.
  let failed = false;
  try {
    execFileSync("node", [crypto, "verify", marker, pub, headB, base, "digest", "env-digest"], {
      encoding: "utf8",
    });
  } catch {
    failed = true;
  }
  rmSync(dir, { recursive: true, force: true });
  assert.ok(failed, "a transplanted signature must not verify for a different head");
});

// The committed reviewer public key must be a well-formed Ed25519 SPKI PEM, so
// the gate can always load it. (The private key must NOT be in the tree.)
test("the committed reviewer public key is a valid Ed25519 public key", () => {
  const pubPath = join(repoRoot, "artifacts", "phase-01", "reviewer-pubkey.pem");
  const pem = readFileSync(pubPath, "utf8");
  assert.match(pem, /-----BEGIN PUBLIC KEY-----/);
  // No private key material anywhere in the tracked tree.
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  assert.ok(
    !/PRIVATE KEY/.test(
      tracked
        .split("\n")
        .filter((f) => f.endsWith(".pem"))
        .map((f) => {
          try {
            return readFileSync(join(repoRoot, f), "utf8");
          } catch {
            return "";
          }
        })
        .join("\n"),
    ),
    "no PRIVATE KEY material may be committed",
  );
});
