#!/usr/bin/env node
// Acceptance-marker cryptography (P1-REREVIEW-CRIT-001).
//
// The acceptance marker (artifacts/phase-01/acceptance.json) is a working-tree
// file, so the worker CAN write it. Gitignoring it does not make it "unavailable
// to the worker" — the worker still controls the bytes on disk. The only way to
// make acceptance unforgeable by the party that can write the tree is to require
// a cryptographic signature over the binding payload, produced with a private
// key the worker does NOT possess and verified against a tracked reviewer public
// key (artifacts/phase-01/reviewer-pubkey.pem).
//
// Trust model:
//   - The controller/reviewer holds the Ed25519 PRIVATE key OUT OF TREE. It is
//     never committed and never present in the worktree.
//   - Only the PUBLIC key is committed. Anyone can verify; nobody in the tree
//     can sign.
//   - A valid acceptance marker therefore proves the controller signed THIS
//     (reviewed_head, base, evidence_index_sha256, verdict) tuple. The worker
//     cannot mint one, cannot transplant a signature to a new HEAD (the head is
//     inside the signed payload), and cannot flip the verdict.
//
// Canonical payload: a deterministic, newline-joined string over the four
// binding fields, domain-separated by a version tag so a signature for one
// scheme can never be replayed under another.
//
// CLI:
//   acceptance-crypto.mjs keygen <priv.pem> <pub.pem>
//   acceptance-crypto.mjs sign <priv.pem> <reviewed_head> <base> <ev_sha> <verdict> <reviewer>
//       -> prints acceptance.json to stdout
//   acceptance-crypto.mjs verify <marker.json> <pub.pem> <head> <base> <ev_sha>
//       -> exit 0 if the marker is validly signed AND binds the triple; else exit 1
import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const DOMAIN = "asep-acceptance-v1";

// Deterministic canonical payload over the binding fields. Field order and the
// domain tag are fixed; any change to head/base/evidence/verdict changes the
// bytes and therefore invalidates a signature.
export function canonicalPayload({ reviewed_head, base, evidence_index_sha256, verdict }) {
  return [
    DOMAIN,
    `reviewed_head:${reviewed_head}`,
    `base:${base}`,
    `evidence_index_sha256:${evidence_index_sha256}`,
    `verdict:${verdict}`,
  ].join("\n");
}

// Verify a parsed marker object against an expected (head, base, ev_sha) triple
// and a public key. Returns { ok, problems: string[] }. This is the single
// authority both the CLI and any test uses, so the rules cannot drift.
export function verifyMarker(marker, pubKeyPem, expected) {
  const problems = [];
  const fields = ["reviewed_head", "base", "evidence_index_sha256", "verdict", "signature"];
  for (const f of fields) {
    if (marker[f] === undefined || marker[f] === null || marker[f] === "") {
      problems.push(`marker missing required field "${f}"`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  if (marker.reviewed_head !== expected.head) {
    problems.push(`reviewed_head ${marker.reviewed_head} != current HEAD ${expected.head} (marker stale; HEAD moved)`);
  }
  if (marker.base !== expected.base) {
    problems.push(`base ${marker.base} != merge-base ${expected.base}`);
  }
  if (marker.evidence_index_sha256 !== expected.ev_sha) {
    problems.push(`evidence_index_sha256 ${marker.evidence_index_sha256} != actual ${expected.ev_sha} (evidence changed)`);
  }
  if (marker.verdict !== "ACCEPT") {
    problems.push(`verdict is "${marker.verdict}", not ACCEPT`);
  }

  // Signature check is over the marker's OWN claimed fields. Combined with the
  // equality checks above, a signature can only validate when it was produced by
  // the controller's key for exactly this HEAD/base/evidence/verdict tuple.
  let pubKey;
  try {
    pubKey = createPublicKey(pubKeyPem);
  } catch (e) {
    problems.push(`could not load reviewer public key: ${e.message}`);
    return { ok: false, problems };
  }
  const payload = Buffer.from(canonicalPayload(marker), "utf8");
  let sigOk = false;
  try {
    sigOk = edVerify(null, payload, pubKey, Buffer.from(marker.signature, "base64"));
  } catch (e) {
    problems.push(`signature verification errored: ${e.message}`);
  }
  if (!sigOk) {
    problems.push("signature does not verify against the reviewer public key (not controller-signed)");
  }

  return { ok: problems.length === 0, problems };
}

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "keygen") {
    const [privPath, pubPath] = rest;
    if (!privPath || !pubPath) die("usage: keygen <priv.pem> <pub.pem>");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
    process.stderr.write(`wrote private key -> ${privPath}\nwrote public key  -> ${pubPath}\n`);
    return;
  }

  if (cmd === "sign") {
    const [privPath, reviewed_head, base, ev_sha, verdict, reviewer] = rest;
    if (!privPath || !reviewed_head || !base || !ev_sha || !verdict) {
      die("usage: sign <priv.pem> <reviewed_head> <base> <ev_sha> <verdict> [reviewer]");
    }
    const privKey = createPrivateKey(readFileSync(privPath, "utf8"));
    const marker = {
      reviewed_head,
      base,
      evidence_index_sha256: ev_sha,
      verdict,
      reviewer: reviewer || "controller",
    };
    const sig = edSign(null, Buffer.from(canonicalPayload(marker), "utf8"), privKey);
    marker.signature = sig.toString("base64");
    process.stdout.write(JSON.stringify(marker, null, 2) + "\n");
    return;
  }

  if (cmd === "verify") {
    const [markerPath, pubPath, head, base, ev_sha] = rest;
    if (!markerPath || !pubPath || !head || !base || !ev_sha) {
      die("usage: verify <marker.json> <pub.pem> <head> <base> <ev_sha>");
    }
    let marker;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch (e) {
      die(`could not read/parse marker ${markerPath}: ${e.message}`);
    }
    const pubKeyPem = readFileSync(pubPath, "utf8");
    const { ok, problems } = verifyMarker(marker, pubKeyPem, { head, base, ev_sha });
    if (ok) {
      process.stdout.write("acceptance-crypto: marker valid (controller-signed, binds HEAD/base/evidence)\n");
      process.exit(0);
    }
    for (const p of problems) process.stderr.write(`  acceptance: FAIL — ${p}\n`);
    process.exit(1);
  }

  die(`unknown command "${cmd}". Commands: keygen | sign | verify`);
}

// Only run the CLI when invoked directly, not when imported by a test.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
