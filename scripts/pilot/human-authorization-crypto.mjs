#!/usr/bin/env node
// Human-authorization signing/verification (disp. P2-FINAL-HIGH-009, risk PR2-08).
//
// A Phase-2 COMPLETE verdict claims ten tasks reached a GENUINE human review
// handoff. Before this module the only record of that was the manifest's own
// `humanDisposition` string — self-declared, unverifiable, forgeable by whoever
// wrote the manifest. Worse, "read it from the database instead" is only a
// partial fix: whoever can write the DB could insert an ACCEPTED row.
//
// So a human authorization is a DETACHED SIGNATURE over the exact decision
// payload, produced with the reviewer's private key (which the harness never
// holds) and verified against the reviewer PUBLIC key at gate time. The DB row
// carries the signature; the gate recomputes the canonical payload from the
// row's OWN fields and verifies it. Consequences:
//
//   * a fabricated row fails verification (no valid signature exists for it);
//   * an EDITED row fails verification (disposition/result_sha are inside the
//     signed payload, so flipping PENDING → ACCEPTED invalidates it);
//   * a signature cannot be transplanted between tasks (task/attempt/PR ids are
//     in the payload), nor to a different reviewed commit (reviewed_result_sha
//     is in the payload).
//
// This mirrors scripts/lib/acceptance-crypto.mjs (the acceptance-marker gate) on
// purpose: same ed25519 + domain-separated canonical payload discipline, so the
// two trust anchors in this repo behave identically and neither invents its own
// crypto conventions.
//
// Usage (operator, out of band — the harness never runs `sign`):
//   node scripts/pilot/human-authorization-crypto.mjs keygen <priv.pem> <pub.pem>
//   node scripts/pilot/human-authorization-crypto.mjs sign <priv.pem> <decision.json>
//   node scripts/pilot/human-authorization-crypto.mjs verify <pub.pem> <authorization.json>

import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as edSign, verify as edVerify,
} from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Domain separation tag. A signature produced for one payload version can never
// validate under another — bump the tag whenever the field set changes so an old
// signature (which never covered the new field) cannot be replayed forward.
const DOMAIN = 'asep-human-authorization-v1';

// The fields that MUST be inside the signature. Every one of them is something
// an attacker would want to change: who reviewed, what they decided, which task
// and attempt it applies to, and exactly which commit was reviewed.
export const SIGNED_FIELDS = Object.freeze([
  'task_id',
  'attempt_id',
  'pull_request_id',
  'disposition',
  'reviewed_result_sha',
  'signed_by',
]);

/**
 * Canonical, newline-joined signing payload. Deterministic and order-fixed: the
 * bytes depend only on the field VALUES, never on JSON key order or whitespace,
 * so a re-serialised row still verifies while any value change breaks it.
 */
export function canonicalAuthorizationPayload(record) {
  const lines = [DOMAIN];
  for (const field of SIGNED_FIELDS) {
    lines.push(`${field}:${record[field] ?? ''}`);
  }
  return lines.join('\n');
}

/**
 * Verify a decision record's detached signature against a reviewer public key.
 * Returns { ok, problems } — never throws, so a malformed key or a corrupt
 * base64 signature is a fail-closed REASON rather than a crash that a caller
 * might catch and treat as "unknown, carry on".
 */
export function verifyAuthorizationSignature(record, pubKeyPem) {
  const problems = [];
  if (!record || typeof record !== 'object') {
    return { ok: false, problems: ['authorization record is not an object'] };
  }
  for (const field of SIGNED_FIELDS) {
    const v = record[field];
    if (typeof v !== 'string' || v.length === 0) {
      problems.push(`authorization is missing signed field "${field}"`);
    }
  }
  if (typeof record.signature !== 'string' || record.signature.length === 0) {
    problems.push('authorization has no signature');
  }
  if (problems.length > 0) return { ok: false, problems };

  let pubKey;
  try {
    pubKey = createPublicKey(pubKeyPem);
  } catch (e) {
    return { ok: false, problems: [`could not load reviewer public key: ${e.message}`] };
  }

  const payload = Buffer.from(canonicalAuthorizationPayload(record), 'utf8');
  let sigOk = false;
  try {
    sigOk = edVerify(null, payload, pubKey, Buffer.from(record.signature, 'base64'));
  } catch (e) {
    return { ok: false, problems: [`signature verification errored: ${e.message}`] };
  }
  if (!sigOk) {
    problems.push('signature does not verify against the reviewer public key (not human-signed)');
  }
  return { ok: problems.length === 0, problems };
}

/** Sign a decision record, returning it with `signature` attached (base64). */
export function signAuthorization(record, privKeyPem) {
  const privKey = createPrivateKey(privKeyPem);
  const payload = Buffer.from(canonicalAuthorizationPayload(record), 'utf8');
  const signature = edSign(null, payload, privKey).toString('base64');
  return { ...record, signature };
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'keygen') {
    const [privPath, pubPath] = rest;
    if (!privPath || !pubPath) die('usage: keygen <priv.pem> <pub.pem>');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    process.stdout.write(`wrote ${privPath} (keep private) and ${pubPath}\n`);
    return;
  }
  if (cmd === 'sign') {
    const [privPath, decisionPath] = rest;
    if (!privPath || !decisionPath) die('usage: sign <priv.pem> <decision.json>');
    const record = JSON.parse(readFileSync(decisionPath, 'utf8'));
    const signed = signAuthorization(record, readFileSync(privPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }
  if (cmd === 'verify') {
    const [pubPath, authPath] = rest;
    if (!pubPath || !authPath) die('usage: verify <pub.pem> <authorization.json>');
    const record = JSON.parse(readFileSync(authPath, 'utf8'));
    const { ok, problems } = verifyAuthorizationSignature(record, readFileSync(pubPath, 'utf8'));
    if (ok) {
      process.stdout.write('human authorization signature OK\n');
      return;
    }
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  die('usage: human-authorization-crypto.mjs <keygen|sign|verify> ...');
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main(process.argv.slice(2));
