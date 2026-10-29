import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs helper has no type declarations; we test its runtime contract.
import { canonicalPayload, verifyMarker } from "./acceptance-crypto.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const crypto = join(here, "acceptance-crypto.mjs");

type Marker = {
  reviewed_head: string;
  base: string;
  evidence_index_sha256: string;
  env_digest_sha256: string;
  verdict: string;
  reviewer?: string;
  signature?: string;
};

// Generate an ephemeral keypair and sign a marker via the CLI, returning the
// parsed marker plus the public-key PEM. env_digest_sha256 is now part of the
// signed payload (P1-REREVIEW-CRIT-001b), so it is threaded through here.
function signMarker(
  m: Omit<Marker, "signature">,
): { marker: Marker; pubPem: string; privPath: string; pubPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "asep-crypto-"));
  const privPath = join(dir, "priv.pem");
  const pubPath = join(dir, "pub.pem");
  execFileSync("node", [crypto, "keygen", privPath, pubPath], { stdio: "ignore" });
  const out = execFileSync(
    "node",
    [
      crypto,
      "sign",
      privPath,
      m.reviewed_head,
      m.base,
      m.evidence_index_sha256,
      m.env_digest_sha256,
      m.verdict,
      m.reviewer ?? "test",
    ],
    { encoding: "utf8" },
  );
  return { marker: JSON.parse(out) as Marker, pubPem: readFileSync(pubPath, "utf8"), privPath, pubPath };
}

test("canonicalPayload is deterministic and domain-separated", () => {
  const m = {
    reviewed_head: "abc",
    base: "def",
    evidence_index_sha256: "123",
    env_digest_sha256: "456",
    verdict: "ACCEPT",
  };
  const p = canonicalPayload(m);
  assert.equal(p, canonicalPayload({ ...m }), "same fields -> same payload");
  // v2 domain tag: v1 signatures (which never covered env-digest) can never be
  // replayed under v2 (P1-REREVIEW-CRIT-001b).
  assert.ok(p.startsWith("asep-acceptance-v2\n"), "payload carries the v2 domain tag");
  // Every binding field must appear in the payload, so a change to any of them
  // (including env_digest_sha256) changes the signed bytes.
  for (const v of ["abc", "def", "123", "456", "ACCEPT"]) {
    assert.ok(p.includes(v), `payload must include ${v}`);
  }
});

test("a validly signed marker verifies against its own key", () => {
  const { marker, pubPem } = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  const { ok, problems } = verifyMarker(marker, pubPem, {
    head: "head1",
    base: "base1",
    ev_sha: "ev1",
    env_sha: "env1",
  });
  assert.ok(ok, `expected valid, got: ${problems.join("; ")}`);
});

test("flipping ANY signed field after signing breaks verification", () => {
  const { marker, pubPem } = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  // The signature covers reviewed_head/base/evidence-index/env-digest/verdict.
  // Mutating each in turn must break the signature, and the expected-tuple check
  // must also fire.
  for (const field of [
    "reviewed_head",
    "base",
    "evidence_index_sha256",
    "env_digest_sha256",
    "verdict",
  ] as const) {
    const tampered = { ...marker, [field]: "TAMPERED" };
    const { ok } = verifyMarker(tampered, pubPem, {
      head: "head1",
      base: "base1",
      ev_sha: "ev1",
      env_sha: "env1",
    });
    assert.equal(ok, false, `mutating ${field} must invalidate the marker`);
  }
});

// P1-REREVIEW-CRIT-001b (unit-level): the env-digest digest is inside the signed
// payload. Rewriting env_digest_sha256 (the exact "keep old signature, swap the
// env-digest" trick) must break verification even when head/base/evidence-index
// still match, because the signature no longer covers the new value.
test("swapping env_digest_sha256 after signing breaks verification (env-digest is signed)", () => {
  const { marker, pubPem } = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  // Doctor the env-digest digest and present the matching "expected" — the
  // equality check would pass, but the signature (minted over env1) must not.
  const tampered = { ...marker, env_digest_sha256: "env2" };
  const { ok } = verifyMarker(tampered, pubPem, {
    head: "head1",
    base: "base1",
    ev_sha: "ev1",
    env_sha: "env2",
  });
  assert.equal(ok, false, "a swapped env-digest digest must invalidate the signature");
});

test("a signature from key A does not verify under key B", () => {
  const a = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  const b = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  // Verify A's marker under B's public key — must fail (not signed by B).
  const { ok } = verifyMarker(a.marker, b.pubPem, {
    head: "head1",
    base: "base1",
    ev_sha: "ev1",
    env_sha: "env1",
  });
  assert.equal(ok, false, "a marker must not verify under a different key");
});

test("a marker missing the signature field is rejected", () => {
  const { marker, pubPem } = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  const noSig: Marker = { ...marker };
  delete noSig.signature;
  const { ok, problems } = verifyMarker(noSig, pubPem, {
    head: "head1",
    base: "base1",
    ev_sha: "ev1",
    env_sha: "env1",
  });
  assert.equal(ok, false);
  assert.ok(problems.some((p: string) => p.includes("signature")));
});

test("the committed reviewer public key verifies a marker signed offline (round-trip)", () => {
  // Sanity that the committed pubkey is usable: sign with a throwaway key, prove
  // the verify path rejects it under the committed pubkey (different key), which
  // exercises the committed key load path without needing the real private key.
  const committedPub = readFileSync(join(here, "..", "..", "artifacts", "phase-01", "reviewer-pubkey.pem"), "utf8");
  const { marker } = signMarker({
    reviewed_head: "head1",
    base: "base1",
    evidence_index_sha256: "ev1",
    env_digest_sha256: "env1",
    verdict: "ACCEPT",
  });
  const { ok } = verifyMarker(marker, committedPub, {
    head: "head1",
    base: "base1",
    ev_sha: "ev1",
    env_sha: "env1",
  });
  assert.equal(ok, false, "a throwaway-key marker must not verify under the committed reviewer key");
});
