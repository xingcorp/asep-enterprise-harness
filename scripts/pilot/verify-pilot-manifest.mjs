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
//        - the provider id has the real Claude adapter's shape (K6);
//        - baseSha != resultSha (the agent actually produced a change);
//        - the trace chain is internally consistent (trace.taskId == taskId)
//          and end-to-end resolvable (every hierarchy id present — K3).
//
// It performs a THIRD, decisive layer:
//   3. AUTHORITATIVE — every self-declared fact (resultSha, provider, evidence
//      checksum, PR url, human disposition) is resolved against the real
//      database and rejected on absence or disagreement. The CLI runs this by
//      DEFAULT (disp. P2-FINAL-HIGH-009): the previous entrypoint called only
//      layers 1-2, so a manifest of ten entirely invented tasks exited 0.
//      Rows alone are not enough, so this layer also:
//        - reads the task's state, risk, base and work order from the database:
//          the task must be WAITING_FOR_HUMAN_REVIEW at a risk Phase-2
//          automation admits (R0, R1), and the manifest's risk, base and work
//          order must be the task's; the work order and the attempt's context
//          pack must be intact artifacts of their kind, and the very ones the
//          agent was handed;
//        - fetches the evidence BYTES, re-hashes them against the recorded
//          sha256, and checks the bundle they hold field by field against the
//          canonical evidence-bundle shape: this task, this attempt, the
//          attempt's result commit and base, the pinned agent image, an intact
//          diff, and checks that link intact raw output;
//        - requires the harness's record of where each check ran to match the
//          evidence check for check: in a container of the pinned verification
//          image with no network, a read-only root and no capabilities, and
//          every mandatory check passed;
//        - asks the FORGE, through the forge port, which commit the PR's head
//          points at now, and requires it to be the attempt's result commit;
//        - accepts only the provider id the real Claude adapter produces for the
//          pilot's pinned model and CLI version, and only with the evidence
//          that adapter writes for the attempt and a double cannot: the
//          invocation manifest naming the pinned images and model origin, the
//          CLI's own init event reporting the pinned version, model and the
//          manifest's session, and the egress proxy's log of model calls it
//          forwarded;
//        - requires the signed human authorization to bind this attempt, this
//          result commit and this PR — a valid signature over another
//          attempt's decision proves nothing about this one.
//
// Usage:
//   ASEP_PG_URL=... ASEP_REVIEWER_PUBLIC_KEY=... \
//     node scripts/pilot/verify-pilot-manifest.mjs <manifest.json>
//   node scripts/pilot/verify-pilot-manifest.mjs <manifest.json> --self-check-only
// Exit 0 = manifest backs its verdict; non-zero + reasons on stderr otherwise.
// A COMPLETE verdict is REJECTED under --self-check-only by construction.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createResolverFromEnv, PG_URL_ENV, REVIEWER_KEY_ENV,
} from './authority-resolver.mjs';

// A COMPLETE verdict must be backed by at least this many genuine pilot tasks
// (exit K5: "ten genuine tasks"). Fewer means the verdict must fall back to
// IMPLEMENTATION_COMPLETE_PILOT_PENDING.
export const MIN_PILOT_TASKS = 10;

// The provider id the real Claude adapter reports: `claude:<model>@cli-<version>`
// (ClaudeCodingProvider). Anything else — a local double, a mock, an id with
// the right prefix but no version — is not the real adapter. The authority
// check below then requires the exact id for the pilot's pins.
const REAL_PROVIDER_SHAPE = /^claude:[^\s@]+@cli-[^\s@]+$/;

/** The provider id the real Claude adapter produces for these pins. */
export function realClaudeProviderId(pins) {
  return `claude:${pins.model}@cli-${pins.cliVersion}`;
}

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
const EVIDENCE_KIND = 'evidence-bundle';
const RESOLVER_METHODS = [
  'resolveAttempt', 'resolveEvidence', 'resolvePullRequest', 'resolveLivePullRequest', 'resolveHumanAuthorization',
  'pinnedAgent', 'resolveAgentRun', 'resolveArtifact', 'resolveVerification',
];
// A pilot task reaches the human-review handoff and stops there: the harness
// never moves a task past it.
const HANDOFF_STATUS = 'WAITING_FOR_HUMAN_REVIEW';
// The risks Phase-2 automation admits (packages/application/src/
// risk-admission.ts: R0 automated, R1 with a recorded human review; R2-R4
// deferred). A task at any other risk cannot have run, so it is no pilot task.
export const ADMISSIBLE_RISKS = Object.freeze(['R0', 'R1']);
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
    else if (!REAL_PROVIDER_SHAPE.test(t.providerId)) bad(`${p}/providerId`, 'must be a Claude adapter id (claude:<model>@cli-<version>)');
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

// ---------------------------------------------------------------------------
// HIGH-009 — authoritative cross-check. The pure verifyManifest above proves a
// manifest is internally consistent, but EVERY field it reads is self-declared:
// a forged manifest with a real-looking providerId, a plausible PR url, an
// invented evidence checksum and a fabricated trace passes it. That is exactly
// the K5/PR2-08 hole. This layer resolves each task's claims against the
// AUTHORITATIVE persistence (the same DB/object-store/forge state the harness
// wrote) via an injected resolver and fails closed on any absence or mismatch.
// The resolver is injected (real DB-backed in production, a fake in tests) so
// this file stays dependency-free.
//
// The resolver contract (all methods async except pinnedAgent, all return null
// when not found):
//   pinnedAgent() -> { model, cliVersion, agentImage, proxyImage, modelBaseUrl, verifyImage }
//     the pilot's pinned Claude and verification configuration (the pilot
//     entrypoint's own settings), against which every attempt's agent run and
//     verification are checked;
//   resolveAttempt(trace) -> {
//     attemptId, taskId, runId, repositoryBindingId,
//     baseSha, resultSha, evidenceArtifactId, evidenceSha256, providerId,
//     contextPackArtifactId, contextPackSha256,
//     taskStatus, taskRisk, workOrderArtifactId, workOrderSha256
//   } | null
//   resolveEvidence(scopeTrace, evidenceArtifactId) -> {
//     sha256,          the recorded sha256 of the artifact row
//     kind,
//     bytesSha256,     sha256 of the bytes actually fetched (null if unreadable)
//     bundle,          the JSON object those bytes hold, whole, or null when
//                      they hold none
//   } | null
//   resolveArtifact(scopeTrace, artifactId) -> { kind, sha256, bytesSha256 } | null
//   resolveVerification(scopeTrace) -> [{ sha256, bytesSha256, record }]
//     every record the harness wrote of where the attempt's checks ran
//     (record: the parsed JSON object, or null);
//   resolvePullRequest(scopeTrace, pullRequestId) -> { number, url, headBranch, attemptId } | null
//   resolveLivePullRequest(scopeTrace, { repositoryBindingId, headBranch }) ->
//     { number, url, headBranch, headSha } | null      (from the forge, now)
//   resolveAgentRun(scopeTrace) -> {     the attempt's agent artifacts, by kind
//     invocation: [{ sha256, bytesSha256, manifest: { providerId, model, cliVersion,
//                    image, proxyImage, upstream,
//                    inputs: [{ name, artifactId, sha256 }] } | null }],
//     events:     [{ sha256, bytesSha256, init: { sessionId, model, cliVersion } | null,
//                    result: { sessionId, subtype, isError } | null }],
//     egress:     [{ sha256, bytesSha256, modelCalls }],   forwarded 2xx model calls
//   }
//   resolveHumanAuthorization(taskId, scopeTrace) -> {
//     disposition, signedBy, signatureValid, attemptId, reviewedResultSha, pullRequestId
//   } | null
//     NOTE the scopeTrace second argument: like every other resolver here, the
//     lookup is TENANT-SCOPED. Omitting it makes the resolver query with an
//     empty (org, project) pair, which matches zero rows for every task — the
//     gate would then reject even a genuine signed handoff.
//
// A manifest claim is honoured only when the authoritative record exists AND
// agrees with it. The manifest is a claim; persistence is the truth.
// ---------------------------------------------------------------------------

/**
 * Cross-check a manifest against authoritative persistence via `resolver`.
 * Runs the pure structural+semantic gate first (so a malformed manifest never
 * reaches the resolver), then verifies every self-declared fact against the
 * persisted record. Async; returns { ok, reasons }. Never throws on bad data —
 * a resolver error for one task becomes a reason, not a crash.
 */
export async function verifyManifestAgainstAuthority(manifest, resolver) {
  // (0) The self-consistency floor MUST pass first.
  const base = verifyManifest(manifest);
  const reasons = [...base.reasons];

  if (!resolver || typeof resolver.resolveAttempt !== 'function') {
    reasons.push('authoritative cross-check requires a resolver — refusing to honour a self-declared manifest (HIGH-009)');
    return { ok: false, reasons };
  }
  // A resolver missing any lookup would silently skip that check.
  const missing = RESOLVER_METHODS.filter((m) => typeof resolver[m] !== 'function');
  if (missing.length > 0) {
    for (const m of missing) {
      reasons.push(m === 'resolveLivePullRequest'
        ? 'the resolver cannot look the pull request up on the forge — refusing to trust a PR record without its live state'
        : `the resolver lacks ${m} — refusing an incomplete authority cross-check`);
    }
    return { ok: false, reasons };
  }
  // If the structural gate failed, the tasks array may be garbage; do not feed
  // it to the resolver. Fail closed on the structural reasons alone.
  if (base.reasons.some((r) => r.startsWith('schema:'))) {
    return { ok: false, reasons };
  }
  // The real agent is defined by the pilot's pins, not by the manifest.
  let pins;
  try {
    pins = resolver.pinnedAgent();
  } catch (e) {
    pins = undefined;
    reasons.push(`the resolver cannot report the pinned Claude configuration — fail closed (${e && e.message ? e.message : e})`);
  }
  const pinProblem = pinsProblem(pins);
  if (pinProblem !== undefined) {
    if (pins !== undefined) reasons.push(`the pinned Claude configuration is unusable: ${pinProblem}`);
    return { ok: false, reasons };
  }
  const realProviderId = realClaudeProviderId(pins);

  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  for (const t of tasks) {
    const trace = t.trace ?? {};
    const label = `task "${t.taskId}"`;

    let attempt;
    try {
      attempt = await resolver.resolveAttempt(trace);
    } catch (e) {
      reasons.push(`${label}: resolver failed to resolve attempt — fail closed (${e && e.message ? e.message : e})`);
      continue;
    }
    if (!attempt) {
      reasons.push(`${label}: no authoritative attempt for trace.attemptId "${trace.attemptId}" — manifest is not backed by persistence (HIGH-009)`);
      continue;
    }

    // The trace hierarchy must MATCH the persisted attempt, not merely be present.
    if (attempt.taskId !== trace.taskId) {
      reasons.push(`${label}: persisted attempt.taskId "${attempt.taskId}" != trace.taskId "${trace.taskId}"`);
    }
    if (attempt.runId !== trace.runId) {
      reasons.push(`${label}: persisted attempt.runId "${attempt.runId}" != trace.runId "${trace.runId}"`);
    }
    if (attempt.repositoryBindingId !== trace.repositoryBindingId) {
      reasons.push(`${label}: persisted attempt.repositoryBindingId "${attempt.repositoryBindingId}" != trace.repositoryBindingId "${trace.repositoryBindingId}"`);
    }

    // The task: what state it reached, at what risk, from which base and for
    // which work order are the database's to say. The manifest only claims.
    reasons.push(...taskReasons(label, t, attempt));
    if (attempt.workOrderArtifactId) {
      reasons.push(...await artifactReasons(resolver, label, trace,
        'work order', attempt.workOrderArtifactId, 'work-order', attempt.workOrderSha256));
    }
    if (attempt.contextPackArtifactId) {
      reasons.push(...await artifactReasons(resolver, label, trace,
        'context pack', attempt.contextPackArtifactId, 'context-pack', attempt.contextPackSha256));
    }

    // resultSha is harness-owned truth; the manifest cannot claim a different one.
    if (attempt.resultSha !== t.resultSha) {
      reasons.push(`${label}: manifest resultSha "${t.resultSha}" != persisted attempt.result_sha "${attempt.resultSha}" — forged result (HIGH-009)`);
    }

    // The provider is read from the PERSISTED attempt, not the manifest's own
    // providerId — a manifest cannot self-certify it used real Claude. Only the
    // id the real adapter produces for the pinned model and CLI is accepted…
    if (typeof attempt.providerId !== 'string' || attempt.providerId.length === 0) {
      reasons.push(`${label}: persisted attempt has no providerId — cannot certify a real agent ran`);
    } else if (attempt.providerId !== realProviderId) {
      reasons.push(`${label}: persisted provider "${attempt.providerId}" is not the real Claude adapter for the pinned model and CLI ("${realProviderId}") (exit K6, authoritative)`);
    }
    if (t.providerId !== attempt.providerId) {
      reasons.push(`${label}: manifest providerId "${t.providerId}" != persisted provider "${attempt.providerId}"`);
    }
    // …and only with the evidence that adapter writes and a double cannot.
    let run;
    try {
      run = await resolver.resolveAgentRun(trace);
    } catch (e) {
      run = undefined;
      reasons.push(`${label}: resolver failed to resolve the agent run — fail closed (${e && e.message ? e.message : e})`);
    }
    if (run !== undefined) reasons.push(...agentRunReasons(label, t, pins, realProviderId, run, attempt));

    // Evidence: the artifact named in the trace must EXIST in the store and its
    // authoritative sha256 must match the manifest's declared evidenceChecksum
    // AND the sha256 pinned on the attempt row (the scoped evidence link).
    const declaredEvidenceSha = String(t.evidenceChecksum ?? '').replace(/^sha256:/, '');
    let evidence;
    try {
      evidence = await resolver.resolveEvidence(trace, trace.evidenceArtifactId);
    } catch (e) {
      evidence = null;
      reasons.push(`${label}: resolver failed to resolve evidence — fail closed (${e && e.message ? e.message : e})`);
    }
    if (!evidence) {
      reasons.push(`${label}: no authoritative evidence artifact for trace.evidenceArtifactId "${trace.evidenceArtifactId}" (HIGH-009)`);
    } else {
      if (evidence.kind !== EVIDENCE_KIND) {
        reasons.push(`${label}: artifact "${trace.evidenceArtifactId}" is not an evidence bundle (kind "${evidence.kind}")`);
      }
      if (evidence.sha256 !== declaredEvidenceSha) {
        reasons.push(`${label}: manifest evidenceChecksum "${declaredEvidenceSha}" != authoritative artifact sha256 "${evidence.sha256}" — forged evidence`);
      }
      // The row is metadata; the bytes are the evidence. They must hash to what
      // the row records.
      if (evidence.bytesSha256 !== evidence.sha256) {
        const got = evidence.bytesSha256 ? `"${evidence.bytesSha256}"` : 'nothing (they could not be read)';
        reasons.push(`${label}: stored evidence bytes hash to ${got}, not the recorded sha256 "${evidence.sha256}" — tampered or missing evidence`);
      }
      // …and the bundle they hold must be the one for THIS attempt's commit,
      // in the canonical shape, with every artifact it names intact.
      const bundle = evidence.bundle;
      if (!isObject(bundle)) {
        reasons.push(`${label}: the stored evidence bytes are not an evidence bundle`);
      } else {
        if (bundle.taskId !== trace.taskId) {
          reasons.push(`${label}: the evidence bundle names task "${bundle.taskId}", not "${trace.taskId}"`);
        }
        if (bundle.attemptId !== trace.attemptId) {
          reasons.push(`${label}: the evidence bundle names attempt "${bundle.attemptId}", not "${trace.attemptId}"`);
        }
        if (bundle.resultSha !== attempt.resultSha) {
          reasons.push(`${label}: the evidence bundle records result "${bundle.resultSha}", not the attempt result "${attempt.resultSha}"`);
        }
        if (bundle.baseSha !== t.baseSha) {
          reasons.push(`${label}: the evidence bundle records base "${bundle.baseSha}", not the manifest base "${t.baseSha}"`);
        }
        reasons.push(...bundleShapeReasons(label, bundle, pins));
        reasons.push(...await bundleArtifactReasons(resolver, label, trace, bundle));
      }
      // The attempt must carry this very evidence: a genuine run always
      // attaches it, so an attempt with none attached is not one.
      if (attempt.evidenceSha256 !== evidence.sha256) {
        reasons.push(`${label}: attempt.evidence_sha256 "${attempt.evidenceSha256}" != authoritative artifact sha256 "${evidence.sha256}"`);
      }
      if (attempt.evidenceArtifactId !== trace.evidenceArtifactId) {
        reasons.push(`${label}: attempt.evidence_artifact_id "${attempt.evidenceArtifactId}" != trace.evidenceArtifactId "${trace.evidenceArtifactId}"`);
      }
    }

    // Where the checks ran: the harness's own record, which must match the
    // evidence check for check.
    reasons.push(...await provenanceReasons(resolver, label, trace, attempt, pins, evidence ? evidence.bundle : null));

    // Pull request: the PR named in the trace must EXIST, point at the SAME
    // attempt, and carry the SAME url the manifest declares.
    let pr;
    try {
      pr = await resolver.resolvePullRequest(trace, trace.pullRequestId);
    } catch (e) {
      pr = null;
      reasons.push(`${label}: resolver failed to resolve pull request — fail closed (${e && e.message ? e.message : e})`);
    }
    if (!pr) {
      reasons.push(`${label}: no authoritative pull request for trace.pullRequestId "${trace.pullRequestId}" (HIGH-009)`);
    } else {
      if (pr.url !== t.pullRequestUrl) {
        reasons.push(`${label}: manifest pullRequestUrl "${t.pullRequestUrl}" != authoritative PR url "${pr.url}" — forged PR link`);
      }
      if (pr.attemptId !== trace.attemptId) {
        reasons.push(`${label}: authoritative PR belongs to attempt "${pr.attemptId}" != trace.attemptId "${trace.attemptId}"`);
      }

      // The row says what the PR was; the forge says what it is. Its head must
      // still be the commit verification, evidence and review were bound to.
      let live;
      try {
        live = await resolver.resolveLivePullRequest(trace, {
          repositoryBindingId: attempt.repositoryBindingId, headBranch: pr.headBranch,
        });
      } catch (e) {
        live = undefined;
        reasons.push(`${label}: the forge lookup of the pull request failed — fail closed (${e && e.message ? e.message : e})`);
      }
      if (live === null) {
        reasons.push(`${label}: the forge has no pull request for head branch "${pr.headBranch}"`);
      } else if (live) {
        if (live.number !== pr.number) {
          reasons.push(`${label}: live PR number ${live.number} != recorded PR number ${pr.number}`);
        }
        if (live.url !== pr.url) {
          reasons.push(`${label}: live PR url "${live.url}" != recorded PR url "${pr.url}"`);
        }
        if (typeof live.headSha !== 'string' || live.headSha.length === 0) {
          reasons.push(`${label}: the forge did not report the PR head commit — cannot confirm the PR shows the reviewed commit`);
        } else if (live.headSha !== attempt.resultSha) {
          reasons.push(`${label}: live PR head "${live.headSha}" != the attempt result "${attempt.resultSha}" — the PR no longer shows the commit evidence and review were bound to`);
        }
      }
    }

    // Human authorization: the disposition must come from a SIGNED authoritative
    // record, not the manifest's self-declared humanDisposition. A COMPLETE
    // pilot task requires a genuine, signature-verified human handoff (PR2-08).
    let auth;
    try {
      // Pass the trace so the lookup is tenant-scoped. Without it the resolver
      // queries an empty (org, project) pair and finds nothing for ANY task, so
      // a real signed handoff would be rejected as missing.
      auth = await resolver.resolveHumanAuthorization(trace.taskId, trace);
    } catch (e) {
      auth = null;
      reasons.push(`${label}: resolver failed to resolve human authorization — fail closed (${e && e.message ? e.message : e})`);
    }
    if (!auth) {
      reasons.push(`${label}: no authoritative human authorization for task "${trace.taskId}" — a COMPLETE pilot needs a signed human handoff (PR2-08)`);
    } else {
      if (auth.signatureValid !== true) {
        reasons.push(`${label}: human authorization signature is not valid — refusing to trust an unsigned handoff`);
      }
      if (auth.disposition !== t.humanDisposition) {
        reasons.push(`${label}: manifest humanDisposition "${t.humanDisposition}" != authoritative disposition "${auth.disposition}" — self-declared disposition`);
      }
      // The signature covers attempt, reviewed commit and PR; they must be this
      // task's, or the decision was about something else.
      if (auth.attemptId !== trace.attemptId) {
        reasons.push(`${label}: the human authorization was signed for attempt "${auth.attemptId}", not "${trace.attemptId}"`);
      }
      if (auth.reviewedResultSha !== attempt.resultSha) {
        reasons.push(`${label}: the human authorization was signed for result "${auth.reviewedResultSha}", not the attempt result "${attempt.resultSha}"`);
      }
      if (auth.pullRequestId !== trace.pullRequestId) {
        reasons.push(`${label}: the human authorization was signed for pull request "${auth.pullRequestId}", not "${trace.pullRequestId}"`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

const PIN_FIELDS = ['model', 'cliVersion', 'agentImage', 'proxyImage', 'modelBaseUrl', 'verifyImage'];

function pinsProblem(pins) {
  if (!isObject(pins)) return 'no pins';
  const missing = PIN_FIELDS.filter((k) => typeof pins[k] !== 'string' || pins[k].trim() === '');
  return missing.length > 0 ? `missing ${missing.join(', ')}` : undefined;
}

// One artifact of each kind, whose stored bytes still hash to what was
// recorded. Returns the artifact, or undefined after recording why not.
function soleIntact(label, what, list, reasons, absent = 'not a run of the real Claude adapter', evidence = 'agent evidence') {
  if (!Array.isArray(list) || list.length === 0) {
    reasons.push(`${label}: no ${what} recorded for the attempt — ${absent}`);
    return undefined;
  }
  if (list.length > 1) {
    reasons.push(`${label}: ${list.length} ${what} artifacts recorded for one attempt — ambiguous ${evidence}`);
    return undefined;
  }
  const a = list[0];
  if (!isObject(a) || a.bytesSha256 !== a.sha256) {
    const got = isObject(a) && a.bytesSha256 ? `"${a.bytesSha256}"` : 'nothing (they could not be read)';
    reasons.push(`${label}: the stored ${what} bytes hash to ${got}, not the recorded sha256 — tampered or missing ${evidence}`);
    return undefined;
  }
  return a;
}

const errText = (e) => (e && e.message ? e.message : String(e));
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/**
 * The task as the database records it: it reached the human-review handoff, at
 * a risk Phase-2 automation admits, and the manifest's risk, base and work
 * order are the task's own.
 */
function taskReasons(label, t, attempt) {
  const reasons = [];
  if (attempt.taskStatus !== HANDOFF_STATUS) {
    reasons.push(`${label}: the task is ${JSON.stringify(attempt.taskStatus ?? null)}, which is not waiting for human review — it never reached the handoff a pilot task reaches`);
  }
  if (attempt.taskRisk !== t.risk) {
    reasons.push(`${label}: manifest risk "${t.risk}" != the task's risk "${attempt.taskRisk}" — self-declared risk`);
  }
  if (!ADMISSIBLE_RISKS.includes(attempt.taskRisk)) {
    reasons.push(`${label}: the task's risk "${attempt.taskRisk}" is not admissible to Phase-2 automation (only ${ADMISSIBLE_RISKS.join(', ')}) — no genuine pilot task runs at it`);
  }
  if (attempt.baseSha !== t.baseSha) {
    reasons.push(`${label}: manifest baseSha "${t.baseSha}" != the attempt's base "${attempt.baseSha}"`);
  }
  if (!nonEmpty(attempt.workOrderArtifactId) || !nonEmpty(attempt.workOrderSha256)) {
    reasons.push(`${label}: the task has no work order attached — nothing records what the agent was asked to do`);
  } else if (attempt.workOrderSha256 !== t.workOrderSha256) {
    reasons.push(`${label}: manifest workOrderSha256 "${t.workOrderSha256}" != the task's work order "${attempt.workOrderSha256}" — self-declared work order`);
  }
  if (!nonEmpty(attempt.contextPackArtifactId) || !nonEmpty(attempt.contextPackSha256)) {
    reasons.push(`${label}: the attempt has no context pack attached — nothing records what the agent was given`);
  }
  return reasons;
}

/**
 * One artifact a task, attempt or bundle names: it is an artifact of this
 * tenant, of the expected kind, with the expected checksum (when one is
 * expected), and its stored bytes still hash to what its row records.
 */
async function artifactReasons(resolver, label, trace, what, id, kind, sha256) {
  let a;
  try {
    a = await resolver.resolveArtifact(trace, id);
  } catch (e) {
    return [`${label}: resolver failed to resolve the ${what} ${id} — fail closed (${errText(e)})`];
  }
  if (!isObject(a)) return [`${label}: the ${what} ${id} is not an artifact of this tenant`];
  const reasons = [];
  if (a.kind !== kind) reasons.push(`${label}: the ${what} ${id} is a "${a.kind}" artifact, not "${kind}"`);
  if (sha256 !== undefined && a.sha256 !== sha256) {
    reasons.push(`${label}: the ${what} ${id} records sha256 "${a.sha256}", not "${sha256}"`);
  }
  if (a.bytesSha256 !== a.sha256) {
    const got = a.bytesSha256 ? `"${a.bytesSha256}"` : 'nothing (they could not be read)';
    reasons.push(`${label}: the stored ${what} bytes hash to ${got}, not the recorded sha256 "${a.sha256}" — tampered or missing`);
  }
  return reasons;
}

// The canonical evidence bundle (packages/contracts/schema/evidence-bundle.
// schema.json), closed at every level. A pilot check must link its raw output,
// which the schema leaves optional.
const BUNDLE_FIELDS = Object.freeze({
  required: ['taskId', 'attemptId', 'baseSha', 'resultSha', 'createdAt', 'environment', 'diff', 'checks'], optional: [],
});
const ENVIRONMENT_FIELDS = Object.freeze({ required: ['imageDigest', 'lockfileHash'], optional: ['nodeVersion'] });
const DIFF_FIELDS = Object.freeze({ required: ['artifactId', 'sha256'], optional: [] });
const CHECK_FIELDS = Object.freeze({
  required: ['id', 'category', 'command', 'exitCode', 'durationMs', 'stdoutArtifactId', 'stderrArtifactId'], optional: [],
});
const CHECK_CATEGORIES = new Set([
  'workspace', 'static', 'unit', 'integration', 'architecture', 'security', 'acceptance', 'nonfunctional', 'review', 'release',
]);

function closedReasons(label, what, obj, fields) {
  const reasons = [];
  for (const k of fields.required) {
    if (!Object.hasOwn(obj, k) || obj[k] === undefined) reasons.push(`${label}: ${what} lacks ${k}`);
  }
  for (const k of Object.keys(obj)) {
    if (!fields.required.includes(k) && !fields.optional.includes(k)) {
      reasons.push(`${label}: ${what} carries "${k}", which the canonical evidence bundle does not have`);
    }
  }
  return reasons;
}

/** The bundle against the canonical shape, and its environment against the pins. */
function bundleShapeReasons(label, bundle, pins) {
  const reasons = closedReasons(label, 'the evidence bundle', bundle, BUNDLE_FIELDS);
  if (Object.hasOwn(bundle, 'createdAt') && (typeof bundle.createdAt !== 'string' || !ISO_DATETIME.test(bundle.createdAt))) {
    reasons.push(`${label}: the evidence bundle createdAt ${JSON.stringify(bundle.createdAt)} is not an ISO-8601 time`);
  }
  const env = bundle.environment;
  if (Object.hasOwn(bundle, 'environment')) {
    if (!isObject(env)) {
      reasons.push(`${label}: the evidence bundle environment is not an object`);
    } else {
      reasons.push(...closedReasons(label, 'the evidence bundle environment', env, ENVIRONMENT_FIELDS));
      if (Object.hasOwn(env, 'lockfileHash') && !nonEmpty(env.lockfileHash)) {
        reasons.push(`${label}: the evidence bundle environment lockfileHash is empty`);
      }
      if (Object.hasOwn(env, 'nodeVersion') && typeof env.nodeVersion !== 'string') {
        reasons.push(`${label}: the evidence bundle environment nodeVersion is not a string`);
      }
      // The change was produced in the pinned agent image (the pilot records
      // that image as the bundle's environment).
      if (env.imageDigest !== pins.agentImage) {
        reasons.push(`${label}: the evidence bundle records environment image ${JSON.stringify(env.imageDigest)}, not the pinned agent image "${pins.agentImage}"`);
      }
    }
  }
  if (Object.hasOwn(bundle, 'diff')) {
    if (!isObject(bundle.diff)) {
      reasons.push(`${label}: the evidence bundle diff is not an object`);
    } else {
      reasons.push(...closedReasons(label, 'the evidence bundle diff', bundle.diff, DIFF_FIELDS));
      for (const k of DIFF_FIELDS.required) {
        if (Object.hasOwn(bundle.diff, k) && !nonEmpty(bundle.diff[k])) reasons.push(`${label}: the evidence bundle diff ${k} is empty`);
      }
    }
  }
  if (!Array.isArray(bundle.checks) || bundle.checks.length === 0) {
    reasons.push(`${label}: the evidence bundle records no verification check`);
    return reasons;
  }
  const seen = new Set();
  bundle.checks.forEach((c, k) => {
    if (!isObject(c)) {
      reasons.push(`${label}: evidence check ${k} is not a check`);
      return;
    }
    const name = `the evidence bundle check ${nonEmpty(c.id) ? `"${c.id}"` : k}`;
    reasons.push(...closedReasons(label, name, c, CHECK_FIELDS));
    if (!nonEmpty(c.id)) reasons.push(`${label}: ${name} has no id`);
    else if (seen.has(c.id)) reasons.push(`${label}: the evidence bundle check id "${c.id}" appears twice`);
    seen.add(c.id);
    if (!CHECK_CATEGORIES.has(c.category)) reasons.push(`${label}: ${name} has category ${JSON.stringify(c.category)}`);
    if (!nonEmpty(c.command)) reasons.push(`${label}: ${name} has no command`);
    if (!Number.isInteger(c.exitCode)) reasons.push(`${label}: ${name} has exit code ${JSON.stringify(c.exitCode)}, not an integer`);
    if (typeof c.durationMs !== 'number' || !Number.isFinite(c.durationMs) || c.durationMs < 0) {
      reasons.push(`${label}: ${name} has duration ${JSON.stringify(c.durationMs)}, not a non-negative number`);
    }
  });
  return reasons;
}

/** The diff and every check's raw output, as intact artifacts of their kind. */
async function bundleArtifactReasons(resolver, label, trace, bundle) {
  const reasons = [];
  if (isObject(bundle.diff) && nonEmpty(bundle.diff.artifactId)) {
    reasons.push(...await artifactReasons(resolver, label, trace, 'diff', bundle.diff.artifactId, 'git-diff', bundle.diff.sha256));
  }
  for (const c of Array.isArray(bundle.checks) ? bundle.checks : []) {
    if (!isObject(c)) continue;
    for (const [field, stream, kind] of [
      ['stdoutArtifactId', 'stdout', 'command-stdout'], ['stderrArtifactId', 'stderr', 'command-stderr'],
    ]) {
      if (nonEmpty(c[field])) {
        reasons.push(...await artifactReasons(resolver, label, trace, `${stream} of check "${c.id}"`, c[field], kind, undefined));
      }
    }
  }
  return reasons;
}

// The isolation every verification container runs under (the Docker sandbox's
// own flags, adapters/command-runner/src/sandbox.ts).
const REQUIRED_SANDBOX_FLAGS = Object.freeze([
  ['--network', 'none'], ['--read-only'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'],
]);

function sandboxFlagReasons(label, name, runFlags) {
  const flags = Array.isArray(runFlags) && runFlags.every((x) => typeof x === 'string') ? runFlags : [];
  const has = (seq) => flags.some((_, k) => seq.every((s, j) => flags[k + j] === s));
  const reasons = [];
  for (const seq of REQUIRED_SANDBOX_FLAGS) {
    if (!has(seq)) reasons.push(`${label}: ${name} ran without ${seq.join(' ')}`);
  }
  flags.forEach((x, k) => {
    if ((x === '--network' || x === '--net') && flags[k + 1] !== 'none') {
      reasons.push(`${label}: ${name} ran with ${x} ${flags[k + 1]}`);
    } else if (/^--net(work)?=/.test(x) && x.slice(x.indexOf('=') + 1) !== 'none') {
      reasons.push(`${label}: ${name} ran with ${x}`);
    } else if (/^--(privileged|cap-add)(=|$)/.test(x)) {
      reasons.push(`${label}: ${name} ran with ${x}`);
    }
  });
  return reasons;
}

/**
 * The harness's record of where the attempt's checks ran: one, intact, for
 * this task, attempt and risk, of a verification that passed, matching the
 * evidence check for check; every check in a container of the pinned
 * verification image under the sandbox's isolation; and at least one
 * mandatory check, every one of which passed.
 */
async function provenanceReasons(resolver, label, trace, attempt, pins, bundle) {
  let list;
  try {
    list = await resolver.resolveVerification(trace);
  } catch (e) {
    return [`${label}: resolver failed to resolve the verification provenance — fail closed (${errText(e)})`];
  }
  const reasons = [];
  const p = soleIntact(label, 'verification provenance record', list, reasons,
    'nothing shows where its checks ran', 'verification evidence');
  if (!p) return reasons;
  const r = p.record;
  if (!isObject(r)) {
    reasons.push(`${label}: the verification provenance record is not one the harness writes`);
    return reasons;
  }
  if (r.taskId !== trace.taskId) reasons.push(`${label}: the verification provenance record names task "${r.taskId}", not "${trace.taskId}"`);
  if (r.attemptId !== trace.attemptId) reasons.push(`${label}: the verification provenance record names attempt "${r.attemptId}", not "${trace.attemptId}"`);
  if (r.risk !== attempt.taskRisk) reasons.push(`${label}: the checks were verified at risk "${r.risk}", not the task's "${attempt.taskRisk}"`);
  if (r.verdict !== 'PASS') reasons.push(`${label}: the verification verdict was "${r.verdict}", not PASS`);
  if (!Array.isArray(r.checks) || r.checks.length === 0) {
    reasons.push(`${label}: the verification provenance record records no checks`);
    return reasons;
  }
  const evidenceChecks = isObject(bundle) && Array.isArray(bundle.checks) ? bundle.checks : null;
  if (evidenceChecks && evidenceChecks.length !== r.checks.length) {
    reasons.push(`${label}: the verification provenance record records ${r.checks.length} checks, the evidence bundle ${evidenceChecks.length}`);
  }
  let mandatory = 0;
  r.checks.forEach((c, k) => {
    if (!isObject(c)) {
      reasons.push(`${label}: provenance check ${k} is not a check record`);
      return;
    }
    const e = evidenceChecks ? evidenceChecks[k] : undefined;
    if (isObject(e)) {
      for (const f of ['id', 'command', 'exitCode', 'stdoutArtifactId', 'stderrArtifactId']) {
        if (c[f] !== e[f]) {
          reasons.push(`${label}: provenance check ${k} records ${f} ${JSON.stringify(c[f])}, not the evidence check's ${JSON.stringify(e[f])}`);
        }
      }
    }
    const name = `check "${c.id}"`;
    const where = c.provenance;
    if (!isObject(where)) {
      reasons.push(`${label}: ${name} has no record of where it ran`);
    } else if (where.where !== 'container') {
      reasons.push(`${label}: ${name} ran on the ${where.where === 'host' ? 'host' : JSON.stringify(where.where)}, not in the verification sandbox`);
    } else {
      if (where.image !== pins.verifyImage) {
        reasons.push(`${label}: ${name} ran in image ${JSON.stringify(where.image)}, not the pinned verification image "${pins.verifyImage}"`);
      }
      reasons.push(...sandboxFlagReasons(label, name, where.runFlags));
    }
    if (c.mandatory === true) {
      mandatory += 1;
      if (c.verdict !== 'PASS' || c.exitCode !== 0) {
        reasons.push(`${label}: mandatory ${name} did not pass (verdict ${JSON.stringify(c.verdict)}, exit code ${JSON.stringify(c.exitCode)})`);
      }
    }
  });
  if (mandatory === 0) {
    reasons.push(`${label}: the verification provenance record records no mandatory check — nothing the plan required was verified`);
  }
  return reasons;
}

/**
 * The agent evidence a real Claude run leaves behind, checked against the pins:
 *   - the adapter's invocation manifest names the expected provider id, model,
 *     CLI version, both pinned images and the pinned model origin;
 *   - the CLI's own init event reports the pinned version and model, and its
 *     session is the manifest's providerSessionId; the run ended in success;
 *   - the egress proxy forwarded at least one model call that succeeded.
 * A local double writes none of these; a run through the real adapter against
 * another model origin, image or CLI version fails the comparison.
 */
function agentRunReasons(label, t, pins, realProviderId, run, attempt) {
  const reasons = [];
  if (!isObject(run)) {
    reasons.push(`${label}: no agent artifacts recorded for the attempt — not a run of the real Claude adapter`);
    return reasons;
  }
  const invocation = soleIntact(label, 'invocation manifest', run.invocation, reasons);
  if (invocation) {
    const m = invocation.manifest;
    if (!isObject(m)) {
      reasons.push(`${label}: the invocation manifest is not the Claude adapter's manifest`);
    } else {
      const expect = [
        ['providerId', realProviderId], ['model', pins.model], ['cliVersion', pins.cliVersion],
        ['image', pins.agentImage], ['proxyImage', pins.proxyImage], ['upstream', pins.modelBaseUrl],
      ];
      for (const [k, want] of expect) {
        if (m[k] !== want) reasons.push(`${label}: the invocation manifest records ${k} "${m[k]}", not the pinned "${want}"`);
      }
      // What the agent was handed must be the task's work order and the
      // attempt's context pack, by artifact id and checksum, and nothing else.
      const inputs = Array.isArray(m.inputs) ? m.inputs : [];
      for (const [name, what, owner, id, sha] of [
        ['work-order', 'work order', 'the task', attempt.workOrderArtifactId, attempt.workOrderSha256],
        ['context-pack', 'context pack', 'the attempt', attempt.contextPackArtifactId, attempt.contextPackSha256],
      ]) {
        const given = inputs.filter((x) => isObject(x) && x.name === name);
        if (given.length !== 1 || given[0].artifactId !== id || given[0].sha256 !== sha) {
          const named = given.length === 0 ? 'none' : given.map((x) => `${x.artifactId} (${x.sha256})`).join(', ');
          reasons.push(`${label}: the agent was not handed the ${what} ${owner} carries — the invocation manifest names ${named}, not ${id} (${sha})`);
        }
      }
      const others = inputs.filter((x) => !isObject(x) || (x.name !== 'work-order' && x.name !== 'context-pack'));
      if (others.length > 0) {
        reasons.push(`${label}: the agent was handed inputs the harness does not give: ${others.map((x) => JSON.stringify(isObject(x) ? x.name : x)).join(', ')}`);
      }
    }
  }
  const events = soleIntact(label, 'event stream', run.events, reasons);
  if (events) {
    const init = events.init;
    if (!isObject(init)) {
      reasons.push(`${label}: the event stream holds no init event from the CLI`);
    } else {
      if (init.cliVersion !== pins.cliVersion) {
        reasons.push(`${label}: the CLI reported version "${init.cliVersion}", not the pinned "${pins.cliVersion}"`);
      }
      if (init.model !== pins.model) {
        reasons.push(`${label}: the CLI reported model "${init.model}", not the pinned "${pins.model}"`);
      }
      if (init.sessionId !== t.providerSessionId) {
        reasons.push(`${label}: the CLI session is "${init.sessionId}", not the manifest providerSessionId "${t.providerSessionId}"`);
      }
    }
    const result = events.result;
    if (!isObject(result)) {
      reasons.push(`${label}: the event stream holds no result event — the agent run did not finish`);
    } else if (result.subtype !== 'success' || result.isError !== false) {
      reasons.push(`${label}: the agent run ended with result "${result.subtype}"${result.isError ? ' (is_error)' : ''}, not success`);
    } else if (isObject(init) && result.sessionId !== init.sessionId) {
      reasons.push(`${label}: the result event belongs to session "${result.sessionId}", not "${init.sessionId}"`);
    }
  }
  const egress = soleIntact(label, 'egress log', run.egress, reasons);
  if (egress && !(Number.isInteger(egress.modelCalls) && egress.modelCalls > 0)) {
    reasons.push(`${label}: the egress proxy forwarded no successful model call — no evidence the model was ever reached`);
  }
  return reasons;
}

/** Read + JSON-parse a manifest file. Returns { parsed } or { reasons }. */
function loadManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { reasons: [`cannot read manifest "${path}": ${e.message}`] };
  }
  try {
    return { parsed: JSON.parse(raw) };
  } catch (e) {
    return { reasons: [`manifest "${path}" is not valid JSON: ${e.message}`] };
  }
}

/**
 * SELF-CONSISTENCY ONLY. Load and run the pure structural+semantic gate.
 *
 * DANGER (disp. P2-FINAL-HIGH-009): every fact this checks is self-declared by
 * the manifest. Passing here does NOT mean the pilot happened — that was exactly
 * the defect (the CLI called this and printed "OK" for ten invented tasks). It
 * remains exported because it is the floor the authority cross-check runs first,
 * and it is legitimately useful for authoring/linting a manifest. It must NEVER
 * be the gate on a COMPLETE verdict; `assertVerdictAllowedWithoutAuthority`
 * below enforces that at the CLI boundary.
 */
export function verifyManifestFile(path) {
  const loaded = loadManifest(path);
  if (loaded.reasons) return { ok: false, reasons: loaded.reasons };
  return verifyManifest(loaded.parsed);
}

/**
 * THE PRODUCTION GATE. Load a manifest and verify it against authoritative
 * persistence via `resolver`. This is what the CLI runs.
 */
export async function verifyManifestFileAgainstAuthority(path, resolver) {
  const loaded = loadManifest(path);
  if (loaded.reasons) return { ok: false, reasons: loaded.reasons };
  return verifyManifestAgainstAuthority(loaded.parsed, resolver);
}

/**
 * A COMPLETE verdict may NEVER be honoured from self-declared data. When the
 * caller asked to skip the authority cross-check, only the explicitly
 * pilot-pending verdict can pass. Returns a reason string, or null when allowed.
 */
export function assertVerdictAllowedWithoutAuthority(manifest) {
  if (manifest && manifest.verdict === 'COMPLETE') {
    return (
      'a COMPLETE verdict cannot be verified without the authoritative cross-check ' +
      '(--self-check-only checks only self-declared fields; see HIGH-009). Re-run ' +
      `with ${PG_URL_ENV} + ${REVIEWER_KEY_ENV} pointing at the authoritative database.`
    );
  }
  return null;
}

const USAGE =
  'usage: verify-pilot-manifest.mjs <manifest.json> [--self-check-only]\n' +
  '\n' +
  'By default the manifest is cross-checked against AUTHORITATIVE persistence:\n' +
  `  ${PG_URL_ENV}              postgres connection string (required)\n` +
  `  ${REVIEWER_KEY_ENV}  path to the reviewer ed25519 public-key PEM (required)\n` +
  '  ASEP_OBJECT_STORE_DIR, the GitHub App settings and the Claude pins the pilot\n' +
  '  ran with (ASEP_CLAUDE_MODEL, ASEP_CLAUDE_CLI_VERSION, ASEP_AGENT_IMAGE_DIGEST,\n' +
  '  ASEP_EGRESS_PROXY_IMAGE_DIGEST, ASEP_VERIFY_IMAGE_DIGEST, optional\n' +
  '  ASEP_ANTHROPIC_BASE_URL) — see the runbook\n' +
  '\n' +
  '--self-check-only skips that cross-check and validates ONLY self-declared\n' +
  'fields. A COMPLETE verdict is REJECTED in that mode by design.\n';

// CLI entry: run only when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const selfCheckOnly = argv.includes('--self-check-only');
  const path = argv.find((a) => !a.startsWith('--'));
  if (!path) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const reject = (reasons) => {
    process.stderr.write(`pilot manifest REJECTED: ${path}\n`);
    for (const r of reasons) process.stderr.write(`  - ${r}\n`);
    process.exit(1);
  };

  if (selfCheckOnly) {
    const loaded = loadManifest(path);
    if (loaded.reasons) reject(loaded.reasons);
    // A COMPLETE verdict is never honoured from self-declared data.
    const blocked = assertVerdictAllowedWithoutAuthority(loaded.parsed);
    if (blocked) reject([blocked]);
    const { ok, reasons } = verifyManifest(loaded.parsed);
    if (!ok) reject(reasons);
    process.stdout.write(
      `pilot manifest self-consistent (NOT authority-checked): ${path}\n`,
    );
    process.exit(0);
  }

  // Production path: resolve against the authoritative database. Any failure to
  // BUILD the resolver (missing env, unreadable key, no driver) is a rejection —
  // never a silent fallback to the self-declared check.
  let handle;
  try {
    handle = await createResolverFromEnv(process.env);
  } catch (e) {
    reject([e && e.message ? e.message : String(e)]);
  }
  try {
    const { ok, reasons } = await verifyManifestFileAgainstAuthority(path, handle.resolver);
    if (!ok) reject(reasons);
    process.stdout.write(`pilot manifest OK (authority-checked): ${path}\n`);
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing the pool must never change the verdict.
    }
  }
  process.exit(0);
}
