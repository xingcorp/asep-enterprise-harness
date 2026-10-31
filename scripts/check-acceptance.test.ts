import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Machine-readable suite marker (P1-CYCLE4-MED-001): the canonical runner
// asserts this line is present so the acceptance suite (self-test, empty-head,
// signature-forgery, env-digest-tamper) cannot be silently dropped again.
console.log("SUITE-ID: asep-suite:acceptance-marker");

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-acceptance.sh");
const crypto = join(here, "lib", "acceptance-crypto.mjs");
const mainBase = join(here, "lib", "main-base.sh");
const repoRoot = join(here, "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

// The base the gate itself binds a marker to (`check-acceptance.sh --base`).
// A test that builds a marker takes it from the gate, so its marker carries the
// base the gate would demand in whatever checkout the suite runs: a developer
// clone, a CI checkout of a branch or of a pull request's merge ref, or `main`.
function gateBase(): string {
  return execFileSync("bash", [script, "--base"], { cwd: repoRoot, encoding: "utf8" }).trim();
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
  const base = gateBase();
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
  const base = gateBase();
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
  const base = gateBase();
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

// The base is the merge base of HEAD with the main line, found the same way in
// every checkout the gate runs in. Each layout is built in a throwaway
// repository: commits A (main), B (the branch, on A), and C (main moved on).
function layout(): { repo: string; a: string; b: string; c: string; run: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), "asep-acc-base-"));
  const run = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    }).trim();
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "a");
  const a = run("rev-parse", "HEAD");
  run("checkout", "-q", "-b", "branch");
  run("commit", "-q", "--allow-empty", "-m", "b");
  const b = run("rev-parse", "HEAD");
  run("checkout", "-q", "main");
  run("commit", "-q", "--allow-empty", "-m", "c");
  const c = run("rev-parse", "HEAD");
  return { repo, a, b, c, run };
}

function baseIn(repo: string): { code: number; out: string } {
  try {
    const out = execFileSync("bash", ["-c", `. "${mainBase}"; main_merge_base`], { cwd: repo, encoding: "utf8" });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "").trim() };
  }
}

test("the base is the merge base with main, or with origin/main where a checkout has no local main", () => {
  const cases: [string, (l: ReturnType<typeof layout>) => string][] = [
    ["a developer clone: the branch checked out, a local main", (l) => {
      l.run("checkout", "-q", "branch");
      return l.a;
    }],
    ["a CI checkout of a branch push: only origin/main", (l) => {
      l.run("update-ref", "refs/remotes/origin/main", l.c);
      l.run("checkout", "-q", "branch");
      l.run("branch", "-q", "-D", "main");
      return l.a;
    }],
    ["a CI checkout of a pull request's merge ref: a detached merge commit, only origin/main", (l) => {
      l.run("update-ref", "refs/remotes/origin/main", l.c);
      l.run("checkout", "-q", "--detach", l.c);
      l.run("merge", "-q", "--no-ff", "--no-edit", l.b);
      l.run("branch", "-q", "-D", "main", "branch");
      return l.c;
    }],
    ["a checkout of main itself", (l) => {
      l.run("update-ref", "refs/remotes/origin/main", l.c);
      return l.c;
    }],
    ["a local main wins over origin/main, so a fetch does not move a developer's base", (l) => {
      // The branch has taken in C, so the two would give different bases.
      l.run("update-ref", "refs/remotes/origin/main", l.c);
      l.run("checkout", "-q", "branch");
      l.run("merge", "-q", "--no-ff", "--no-edit", l.c);
      l.run("branch", "-q", "-f", "main", l.a);
      return l.a;
    }],
  ];
  for (const [label, arrange] of cases) {
    const l = layout();
    try {
      const want = arrange(l);
      assert.deepEqual(baseIn(l.repo), { code: 0, out: want }, label);
    } finally {
      rmSync(l.repo, { recursive: true, force: true });
    }
  }
});

test("a checkout with no main line has no base, and the gate says so instead of binding another", () => {
  const l = layout();
  try {
    l.run("checkout", "-q", "branch");
    l.run("branch", "-q", "-D", "main");
    assert.deepEqual(baseIn(l.repo), { code: 1, out: "" });
    // The gate, run from inside that checkout, prints no base and names why.
    mkdirSync(join(l.repo, "scripts", "lib"), { recursive: true });
    copyFileSync(script, join(l.repo, "scripts", "check-acceptance.sh"));
    copyFileSync(mainBase, join(l.repo, "scripts", "lib", "main-base.sh"));
    const r = spawnSync("bash", [join(l.repo, "scripts", "check-acceptance.sh"), "--base"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /neither a local main nor origin\/main/);
  } finally {
    rmSync(l.repo, { recursive: true, force: true });
  }
});

// Every script that binds or records the base takes it from main_merge_base, so
// none of them can go back to a local main a CI checkout does not have.
test("no script takes the base from a local main alone", () => {
  const r = spawnSync("git", ["grep", "-nE", "merge-base[[:space:]]+main([[:space:]]|$)", "--", "scripts/*.sh", "scripts/lib/*.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // git grep exits 1 when nothing matches, and 0 with the lines it found.
  assert.equal(r.status, 1, `use main_merge_base from scripts/lib/main-base.sh:\n${r.stdout}${r.stderr}`);
});
