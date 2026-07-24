#!/usr/bin/env node
// Pilot-manifest verifier (exit criteria K5/K6).
//
// A Phase-2 COMPLETE verdict is only honest if the platform actually executed
// ten genuine, human-authorized tasks end to end against REAL adapters (real
// Claude, real sandbox, real GitHub App, real persistence) and each reached a
// human-review handoff with a resolvable PR + evidence chain. This verifier is
// the machine gate on that claim. It is deliberately adversarial: it assumes a
// manifest may be padded, deduplicated-away, wired to fakes, or carry a broken
// trace, and it fails CLOSED on every one of those.
//
// It performs two layers of checking:
//   1. STRUCTURAL — ajv (2020-12) against pilot-manifest.schema.json. This
//      enforces field presence, id/sha/url shapes, and the closed enums.
//   2. SEMANTIC — the cross-field invariants a schema cannot express:
//        - a COMPLETE verdict requires at least MIN_PILOT_TASKS distinct tasks;
//        - taskIds are unique (no duplicate task counted twice — K5 count);
//        - workOrderSha256 are unique (no single work order replayed to pad the
//          count — RETRY / REPLAY INFLATION);
//        - the provider is REAL, not a fake/mock/stub/fixture adapter (K6);
//        - baseSha != resultSha (the agent actually produced a change);
//        - the trace chain is internally consistent (trace.taskId == taskId)
//          and end-to-end resolvable (every hierarchy id present — K3).
//
// Usage:
//   node scripts/pilot/verify-pilot-manifest.mjs <manifest.json>
// Exit 0 = manifest backs its verdict; non-zero + reasons on stderr otherwise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A COMPLETE verdict must be backed by at least this many genuine pilot tasks
// (exit K5: "ten genuine tasks"). Fewer means the verdict must fall back to
// IMPLEMENTATION_COMPLETE_PILOT_PENDING.
export const MIN_PILOT_TASKS = 10;

// providerId prefixes that mark a NON-real adapter. A COMPLETE verdict wired to
// any of these is a fake pilot and is rejected (exit K6: real Claude).
const FAKE_PROVIDER_PREFIXES = ['fake:', 'mock:', 'stub:', 'fixture:', 'test:', 'inmemory:'];

// Structural rules, kept dependency-free (the repo favours a minimal root
// dependency tree; ajv lives only under packages/contracts). These mirror
// pilot-manifest.schema.json exactly — that file is the human/machine-readable
// spec, this is the runnable projection. Any change to one must change the other.
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const EVIDENCE_CHECKSUM = /^sha256:[a-f0-9]{64}$/;
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[0-9]+$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const VERDICTS = new Set(['COMPLETE', 'IMPLEMENTATION_COMPLETE_PILOT_PENDING']);
const RISKS = new Set(['R0', 'R1', 'R2', 'R3', 'R4']);
const DISPOSITIONS = new Set(['ACCEPTED', 'REJECTED', 'CHANGES_REQUESTED', 'PENDING']);
const TRACE_IDS = [
  'pullRequestId', 'evidenceArtifactId', 'attemptId', 'taskId',
  'runId', 'projectId', 'organizationId', 'repositoryBindingId',
];

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Dependency-free structural validation mirroring the JSON Schema. Pushes a
// `schema: ...` reason for every violation so the gate fails closed on any
// malformed shape, exactly as ajv would.
function structuralErrors(m) {
  const errs = [];
  const bad = (path, msg) => errs.push(`schema: ${path} ${msg}`);
  if (!isObject(m)) {
    bad('(root)', 'must be an object');
    return errs;
  }
  if (typeof m.manifestVersion !== 'string' || !SEMVER.test(m.manifestVersion)) {
    bad('/manifestVersion', 'must match semver');
  }
  if (typeof m.verdict !== 'string' || !VERDICTS.has(m.verdict)) {
    bad('/verdict', 'must be one of the allowed verdicts');
  }
  if (typeof m.generatedAt !== 'string' || !ISO_DATETIME.test(m.generatedAt)) {
    bad('/generatedAt', 'must be an ISO-8601 date-time');
  }
  if (!Array.isArray(m.tasks)) {
    bad('/tasks', 'must be an array');
    return errs;
  }
  m.tasks.forEach((t, i) => {
    const p = `/tasks/${i}`;
    if (!isObject(t)) {
      bad(p, 'must be an object');
      return;
    }
    if (typeof t.taskId !== 'string' || t.taskId.length < 1) bad(`${p}/taskId`, 'required non-empty string');
    if (typeof t.objective !== 'string' || t.objective.length < 1) bad(`${p}/objective`, 'required non-empty string');
    if (typeof t.risk !== 'string' || !RISKS.has(t.risk)) bad(`${p}/risk`, 'must be R0-R4');
    if (typeof t.workOrderSha256 !== 'string' || !SHA256.test(t.workOrderSha256)) bad(`${p}/workOrderSha256`, 'must be a sha256 hex');
    if (typeof t.baseSha !== 'string' || !SHA1.test(t.baseSha)) bad(`${p}/baseSha`, 'must be a 40-hex git sha');
    if (typeof t.resultSha !== 'string' || !SHA1.test(t.resultSha)) bad(`${p}/resultSha`, 'must be a 40-hex git sha');
    if (typeof t.providerSessionId !== 'string' || t.providerSessionId.length < 1) bad(`${p}/providerSessionId`, 'required non-empty string');
    if (typeof t.providerId !== 'string' || t.providerId.length < 1) bad(`${p}/providerId`, 'required non-empty string');
    if (typeof t.pullRequestUrl !== 'string' || !PR_URL.test(t.pullRequestUrl)) bad(`${p}/pullRequestUrl`, 'must be a github PR url');
    if (typeof t.evidenceChecksum !== 'string' || !EVIDENCE_CHECKSUM.test(t.evidenceChecksum)) bad(`${p}/evidenceChecksum`, 'must be sha256:<hex>');
    if (typeof t.humanDisposition !== 'string' || !DISPOSITIONS.has(t.humanDisposition)) bad(`${p}/humanDisposition`, 'must be a known disposition');
    if (!isObject(t.trace)) {
      bad(`${p}/trace`, 'required object');
    } else {
      for (const id of TRACE_IDS) {
        if (typeof t.trace[id] !== 'string' || t.trace[id].length < 1) {
          bad(`${p}/trace/${id}`, 'required non-empty string');
        }
      }
    }
  });
  return errs;
}

/**
 * Verify a parsed manifest object. Pure: returns { ok, reasons } and never
 * throws on bad data and never touches the filesystem. `reasons` is the ordered
 * list of every failure found (not just the first), so a caller sees the full
 * picture.
 */
export function verifyManifest(manifest) {
  const reasons = [];

  // (1) Structural gate.
  const structural = structuralErrors(manifest);
  if (structural.length > 0) {
    // Structure is the floor; if it fails, semantic checks would read garbage.
    return { ok: false, reasons: structural };
  }

  const tasks = manifest.tasks;
  const complete = manifest.verdict === 'COMPLETE';

  // (2) Semantic gates.

  // COMPLETE requires the full genuine task count.
  if (complete && tasks.length < MIN_PILOT_TASKS) {
    reasons.push(
      `verdict COMPLETE requires >= ${MIN_PILOT_TASKS} genuine tasks, found ${tasks.length}`,
    );
  }

  // Uniqueness: no duplicate taskId, no replayed work order (retry inflation).
  const seenTaskIds = new Set();
  const seenWorkOrders = new Set();
  const seenSessions = new Set();
  for (const t of tasks) {
    if (seenTaskIds.has(t.taskId)) {
      reasons.push(`duplicate taskId "${t.taskId}" — a task may be counted only once`);
    }
    seenTaskIds.add(t.taskId);

    if (seenWorkOrders.has(t.workOrderSha256)) {
      reasons.push(
        `replayed workOrderSha256 for task "${t.taskId}" — one work order counted twice (retry/replay inflation)`,
      );
    }
    seenWorkOrders.add(t.workOrderSha256);

    if (seenSessions.has(t.providerSessionId)) {
      reasons.push(
        `reused providerSessionId "${t.providerSessionId}" for task "${t.taskId}" — one agent session cannot back two distinct tasks`,
      );
    }
    seenSessions.add(t.providerSessionId);

    // Real adapter, not a fake.
    const lowerProvider = String(t.providerId).toLowerCase();
    for (const prefix of FAKE_PROVIDER_PREFIXES) {
      if (lowerProvider.startsWith(prefix)) {
        reasons.push(
          `task "${t.taskId}" used non-real provider "${t.providerId}" — a COMPLETE pilot must use real Claude (exit K6)`,
        );
        break;
      }
    }

    // The agent must have actually produced a change.
    if (t.baseSha === t.resultSha) {
      reasons.push(
        `task "${t.taskId}" has baseSha == resultSha — no change was produced`,
      );
    }

    // Trace internally consistent + end-to-end resolvable.
    if (t.trace.taskId !== t.taskId) {
      reasons.push(
        `task "${t.taskId}" trace.taskId "${t.trace.taskId}" does not match — broken traceability chain (exit K3)`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** Load, JSON-parse and verify a manifest file. Returns { ok, reasons }. */
export function verifyManifestFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reasons: [`cannot read manifest "${path}": ${e.message}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reasons: [`manifest "${path}" is not valid JSON: ${e.message}`] };
  }
  return verifyManifest(parsed);
}

// CLI entry: run only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: verify-pilot-manifest.mjs <manifest.json>\n');
    process.exit(2);
  }
  const { ok, reasons } = verifyManifestFile(path);
  if (ok) {
    process.stdout.write(`pilot manifest OK: ${path}\n`);
    process.exit(0);
  }
  process.stderr.write(`pilot manifest REJECTED: ${path}\n`);
  for (const r of reasons) process.stderr.write(`  - ${r}\n`);
  process.exit(1);
}
