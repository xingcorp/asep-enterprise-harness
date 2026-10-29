#!/usr/bin/env node
// Production authority resolver for the pilot-manifest gate (disp.
// P2-FINAL-HIGH-009).
//
// THE defect this closes: `verifyManifestAgainstAuthority()` existed, but the
// real CLI called `verifyManifestFile() → verifyManifest()`, which reads only
// the manifest's own self-declared fields. A COMPLETE manifest with ten entirely
// invented tasks exited 0 and printed "pilot manifest OK". There was no
// production resolver to wire, so the cross-check was unreachable code.
//
// This module is that resolver. It answers each of the verifier's questions
// from AUTHORITATIVE state:
//
//   resolveAttempt            → the `attempts` row (base and result sha,
//                               provider, attached evidence and context pack)
//                               with its task's state, risk and work order
//   resolveEvidence           → the `artifacts` row (authoritative sha256) AND
//                               the stored bytes it points at, fetched from the
//                               object store and re-hashed here, with the whole
//                               bundle they hold
//   resolveArtifact           → any artifact of the tenant by id (the work
//                               order, the context pack, the diff, raw check
//                               output): its kind, recorded sha256 and the hash
//                               of its stored bytes
//   resolveVerification       → the harness's records of where the attempt's
//                               verification checks ran, re-hashed and parsed
//   resolvePullRequest        → the `pull_requests` row (url, owning attempt)
//   resolveLivePullRequest    → the PR as the FORGE reports it now, through the
//                               forge port, including the commit its head is at
//   resolveAgentRun           → the artifacts the real Claude adapter recorded
//                               for the attempt (invocation manifest, CLI event
//                               stream, egress-proxy log), fetched, re-hashed and
//                               parsed for what they say about the run
//   pinnedAgent               → the pilot's pinned Claude configuration, which
//                               those artifacts are checked against
//   resolveHumanAuthorization → the `human_authorizations` row, WITH its ed25519
//                               signature verified against the reviewer public
//                               key (migration 0010). `signatureValid` is the
//                               result of real crypto, never a stored boolean —
//                               a forged or edited row cannot report true.
//
// Every query is tenant-scoped by (organization_id, project_id) taken from the
// manifest trace and every value is bound as a parameter ($1,$2,…), never
// interpolated: a manifest field cannot become SQL. Resolution returns null on
// absence (the verifier turns that into a fail-closed reason).
//
// It talks to a minimal `{ query(text, params) }` executor, so the CLI can hand
// it a real `pg` pool while a test hands it a PGlite client — same code path
// under both, which is what keeps the tested behaviour the shipped behaviour.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { verifyAuthorizationSignature } from './human-authorization-crypto.mjs';

// Environment contract for the production gate. Both are REQUIRED to honour a
// COMPLETE verdict; a missing one is a hard error, never a downgrade to the
// self-declared path (that downgrade WAS the HIGH-009 defect).
export const PG_URL_ENV = 'ASEP_PG_URL';
export const REVIEWER_KEY_ENV = 'ASEP_REVIEWER_PUBLIC_KEY';
// Where the pilot's object store keeps artifact bytes (the pilot entrypoint
// writes there; see the runbook), and the GitHub App the forge lookups use —
// the same variables the pilot entrypoint reads.
export const OBJECT_STORE_DIR_ENV = 'ASEP_OBJECT_STORE_DIR';
export const GITHUB_APP_ID_ENV = 'ASEP_GITHUB_APP_ID';
export const GITHUB_PRIVATE_KEY_ENV = 'ASEP_GITHUB_PRIVATE_KEY_PATH';
export const GITHUB_INSTALLATION_ENV = 'ASEP_GITHUB_INSTALLATION_ID';
// The pilot's pinned Claude configuration — the same variables the pilot
// entrypoint reads — so an agent run is accepted only for what the pilot pinned.
export const CLAUDE_MODEL_ENV = 'ASEP_CLAUDE_MODEL';
export const CLAUDE_CLI_VERSION_ENV = 'ASEP_CLAUDE_CLI_VERSION';
export const AGENT_IMAGE_ENV = 'ASEP_AGENT_IMAGE_DIGEST';
export const PROXY_IMAGE_ENV = 'ASEP_EGRESS_PROXY_IMAGE_DIGEST';
export const MODEL_BASE_URL_ENV = 'ASEP_ANTHROPIC_BASE_URL';
export const DEFAULT_MODEL_BASE_URL = 'https://api.anthropic.com';
// The image the pilot's verification sandbox runs checks in.
export const VERIFY_IMAGE_ENV = 'ASEP_VERIFY_IMAGE_DIGEST';

// The artifacts the real Claude adapter writes for an attempt that reached the
// agent container (adapters/agent-claude/src/claude-provider.ts).
export const AGENT_RUN_KINDS = Object.freeze({
  invocation: 'claude-invocation', events: 'claude-event-stream', egress: 'claude-egress-log',
});
// The record the harness writes of where each verification check of an attempt
// ran (packages/application/src/vertical-slice-workflow.ts).
export const VERIFICATION_PROVENANCE_KIND = 'verification-provenance';
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;
// An egress-proxy log line for a model call it forwarded and the model answered.
const FORWARDED_MODEL_CALL = /^\S+ POST \/v1\/messages -> 2\d\d$/;

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The model origin exactly as the Claude adapter records it (no trailing slash). */
export function normalizeModelBaseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`model base URL must be http(s), got '${url.protocol}'`);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('model base URL must not carry userinfo, a query or a fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Validate the pinned configuration a resolver checks runs against: the Claude
 * agent's model, CLI, images and model origin, and the verification image.
 */
export function pinnedAgentConfig(agent) {
  const out = {};
  for (const k of ['model', 'cliVersion', 'agentImage', 'proxyImage', 'modelBaseUrl', 'verifyImage']) {
    const v = agent?.[k];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`the pinned Claude configuration lacks ${k} — refusing to accept an agent run without knowing what the real one is`);
    }
    out[k] = v.trim();
  }
  for (const k of ['agentImage', 'proxyImage', 'verifyImage']) {
    if (!DIGEST_PINNED.test(out[k])) throw new Error(`the pinned ${k} '${out[k]}' is not digest-pinned (…@sha256:<64hex>)`);
  }
  out.modelBaseUrl = normalizeModelBaseUrl(out.modelBaseUrl);
  return Object.freeze(out);
}

const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function parseJsonObject(bytes) {
  try {
    const v = JSON.parse(utf8(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// What the adapter's invocation manifest says it ran, and what it handed the
// agent (by artifact id and checksum; the host paths are not evidence).
function invocationFacts(bytes) {
  const m = parseJsonObject(bytes);
  if (!m) return null;
  return {
    providerId: m.providerId, model: m.model, cliVersion: m.cliVersion,
    image: m.image, proxyImage: m.proxyImage,
    upstream: m.network && typeof m.network === 'object' ? m.network.upstream : undefined,
    inputs: Array.isArray(m.inputs)
      ? m.inputs.map((x) => (x && typeof x === 'object'
        ? { name: x.name, artifactId: x.artifactId, sha256: x.sha256 }
        : null))
      : undefined,
  };
}

// The CLI's first init event and last result event, from its stream-json output.
function eventFacts(bytes) {
  let text;
  try {
    text = utf8(bytes);
  } catch {
    return { init: null, result: null };
  }
  let init = null;
  let result = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (init === null && ev.type === 'system' && ev.subtype === 'init') {
      init = { sessionId: ev.session_id, model: ev.model, cliVersion: ev.claude_code_version };
    } else if (ev.type === 'result') {
      result = { sessionId: ev.session_id, subtype: ev.subtype, isError: ev.is_error };
    }
  }
  return { init, result };
}

// How many model calls the egress proxy forwarded and the model answered 2xx.
function egressFacts(bytes) {
  let text;
  try {
    text = utf8(bytes);
  } catch {
    return { modelCalls: 0 };
  }
  return { modelCalls: text.split('\n').filter((l) => FORWARDED_MODEL_CALL.test(l.trim())).length };
}

/**
 * Read artifact bytes from a filesystem object store rooted at `root` — the
 * layout FilesystemObjectStore writes. A key comes from the database, so it is
 * still checked: relative, no `..`, no backslash or NUL, never empty.
 */
export function filesystemObjectReader(root) {
  return {
    async get(key) {
      const parts = typeof key === 'string' ? key.split('/') : [];
      if (parts.length === 0 || key === '' || isAbsolute(key) || /[\\\0]/.test(key) ||
        parts.some((p) => p === '' || p === '.' || p === '..')) {
        throw new Error(`refusing evidence key ${JSON.stringify(key)}: not a relative object key`);
      }
      return new Uint8Array(await readFile(join(root, ...parts)));
    },
  };
}

/**
 * The forge binding reader the GitHub App port needs, over the same SQL
 * executor: tenant-scoped, parameter-bound, and throwing when the binding is not
 * visible in the scope (the contract SqlForgeBindingResolver relies on).
 */
export function sqlBindingReader(db) {
  return {
    async getScoped(scope, id) {
      const r = await db.query(
        `select github_host, github_owner, github_repo, github_repository_id
         from repository_bindings
         where id = $1 and organization_id = $2 and project_id = $3`,
        [id ?? '', scope?.organizationId ?? '', scope?.projectId ?? ''],
      );
      if (r.rowCount === 0) throw new Error(`repository binding ${id} is not visible in this scope`);
      const row = r.rows[0];
      const repoId = row['github_repository_id'];
      return {
        githubHost: row['github_host'],
        githubOwner: row['github_owner'],
        githubRepo: row['github_repo'],
        githubRepositoryId: repoId === null || repoId === undefined ? undefined : Number(repoId),
      };
    },
  };
}

/**
 * Build an authority resolver over a SQL executor.
 *
 * @param {{ query(text: string, params?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[], rowCount: number }> }} db
 * @param {{
 *   reviewerPublicKeyPem: string,
 *   objects: { get(key: string): Promise<Uint8Array> },
 *   forge: { findPullRequest(scope: object, input: { repositoryBindingId: string, headBranch: string }): Promise<object | null> },
 * }} opts
 *   reviewerPublicKeyPem — reviewer ed25519 public key (SPKI PEM) used to verify
 *     human-authorization signatures;
 *   objects — reads artifact bytes by storage key, so evidence is re-hashed
 *     rather than taken from its metadata row;
 *   forge — the forge port's PR lookup, so a PR is checked as it is now;
 *   agent — the pilot's pinned configuration { model, cliVersion, agentImage,
 *     proxyImage, modelBaseUrl, verifyImage }, so only a run of the real
 *     adapter under those pins, verified in that image, is accepted.
 *   All REQUIRED: without any one of them a check would silently not run, so
 *   the factory refuses to build.
 */
export function createSqlAuthorityResolver(db, opts) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('createSqlAuthorityResolver requires a SQL executor with .query()');
  }
  const pubKeyPem = opts?.reviewerPublicKeyPem;
  if (typeof pubKeyPem !== 'string' || pubKeyPem.trim().length === 0) {
    // Fail closed at construction: a resolver that cannot verify signatures
    // would silently downgrade the PR2-08 human-handoff proof to "a row exists".
    throw new Error(
      'createSqlAuthorityResolver requires a reviewer public key — refusing to ' +
      'resolve human authorizations without signature verification (HIGH-009)',
    );
  }
  const objects = opts?.objects;
  if (!objects || typeof objects.get !== 'function') {
    throw new Error('createSqlAuthorityResolver requires an evidence object reader — refusing to trust evidence metadata without its bytes');
  }
  const forge = opts?.forge;
  if (!forge || typeof forge.findPullRequest !== 'function') {
    throw new Error('createSqlAuthorityResolver requires the forge port — refusing to trust a PR record without its live state');
  }
  const agent = pinnedAgentConfig(opts?.agent);

  // Scope every lookup by the trace's tenant pair. A manifest that names another
  // tenant's attempt resolves to zero rows and fails closed.
  const scopeOf = (trace) => [trace?.organizationId ?? '', trace?.projectId ?? ''];

  // Fetch and re-hash one artifact's bytes; null when they cannot be read.
  const bytesOf = async (key) => {
    try {
      return await objects.get(key);
    } catch {
      return null;
    }
  };

  return {
    pinnedAgent() {
      return agent;
    },

    // The artifacts the real adapter recorded for this attempt, each re-hashed
    // from its bytes and parsed. Every recorded artifact of a kind is returned,
    // so the verifier can refuse an attempt with none or with several.
    async resolveAgentRun(trace) {
      const r = await db.query(
        `select kind, sha256, storage_key
         from artifacts
         where attempt_id = $1 and organization_id = $2 and project_id = $3
           and kind in ($4, $5, $6)
         order by created_at, id`,
        [trace?.attemptId ?? '', ...scopeOf(trace),
          AGENT_RUN_KINDS.invocation, AGENT_RUN_KINDS.events, AGENT_RUN_KINDS.egress],
      );
      const run = { invocation: [], events: [], egress: [] };
      for (const row of r.rows) {
        const bytes = await bytesOf(row['storage_key']);
        const base = { sha256: row['sha256'], bytesSha256: bytes === null ? null : sha256Hex(bytes) };
        if (row['kind'] === AGENT_RUN_KINDS.invocation) {
          run.invocation.push({ ...base, manifest: bytes === null ? null : invocationFacts(bytes) });
        } else if (row['kind'] === AGENT_RUN_KINDS.events) {
          run.events.push({ ...base, ...(bytes === null ? { init: null, result: null } : eventFacts(bytes)) });
        } else if (row['kind'] === AGENT_RUN_KINDS.egress) {
          run.egress.push({ ...base, modelCalls: bytes === null ? 0 : egressFacts(bytes).modelCalls });
        }
      }
      return run;
    },

    async resolveAttempt(trace) {
      // `run_id` lives on TASKS, not on attempts (see the attempts DDL: it
      // carries task_id + repository_binding_id and reaches its run THROUGH the
      // task). This query used to select `attempts.run_id`, which does not
      // exist, so every call threw `column "run_id" does not exist` — verified
      // empirically against a migrated database.
      //
      // That made the whole authority check unreachable: verify-pilot-manifest
      // compares `attempt.runId` against `trace.runId` to catch a manifest
      // claiming a trace hierarchy the database does not agree with. A throw
      // before the first comparison means the strongest anti-forgery check in
      // the COMPLETE gate never ran. The resolver suite missed it because it
      // drives a `fakeDb` stub that returns canned rows without ever parsing
      // the SQL against real DDL.
      //
      // The join is INNER and scoped on the composite key, so an attempt whose
      // task lies outside the trace's tenant resolves to zero rows and fails
      // closed exactly as a missing attempt does.
      //
      // The task's state, risk and work order come from the same row: they are
      // the database's, never the manifest's.
      const r = await db.query(
        `select a.id, a.task_id, t.run_id, a.repository_binding_id, a.base_sha, a.result_sha,
                a.agent_provider_id, a.evidence_artifact_id, a.evidence_sha256,
                a.context_pack_artifact_id, a.context_pack_sha256,
                t.status as task_status, t.risk as task_risk,
                t.work_order_artifact_id, t.work_order_sha256
         from attempts a
         join tasks t
           on t.id = a.task_id
          and t.organization_id = a.organization_id
          and t.project_id = a.project_id
         where a.id = $1 and a.organization_id = $2 and a.project_id = $3`,
        [trace?.attemptId ?? '', ...scopeOf(trace)],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      return {
        attemptId: row['id'],
        taskId: row['task_id'],
        runId: row['run_id'],
        repositoryBindingId: row['repository_binding_id'],
        baseSha: row['base_sha'],
        resultSha: row['result_sha'],
        providerId: row['agent_provider_id'],
        evidenceArtifactId: row['evidence_artifact_id'],
        evidenceSha256: row['evidence_sha256'],
        contextPackArtifactId: row['context_pack_artifact_id'],
        contextPackSha256: row['context_pack_sha256'],
        taskStatus: row['task_status'],
        taskRisk: row['task_risk'],
        workOrderArtifactId: row['work_order_artifact_id'],
        workOrderSha256: row['work_order_sha256'],
      };
    },

    // The row says what the evidence should hash to; the bytes are fetched and
    // hashed here, and the bundle they hold is parsed whole, so the verifier
    // checks every field of it, not a chosen few. Bytes that cannot be read
    // report a null hash, and bytes that are not a JSON object a null bundle —
    // the verifier refuses both.
    async resolveEvidence(trace, evidenceArtifactId) {
      const r = await db.query(
        `select id, kind, sha256, storage_key
         from artifacts
         where id = $1 and organization_id = $2 and project_id = $3`,
        [evidenceArtifactId ?? '', ...scopeOf(trace)],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      const bytes = await bytesOf(row['storage_key']);
      return {
        sha256: row['sha256'],
        kind: row['kind'],
        bytesSha256: bytes === null ? null : sha256Hex(bytes),
        bundle: bytes === null ? null : parseJsonObject(bytes),
      };
    },

    // Any artifact of the tenant by id: what kind the row says it is, what it
    // should hash to, and what its stored bytes hash to (null when they cannot
    // be read).
    async resolveArtifact(trace, artifactId) {
      const r = await db.query(
        `select id, kind, sha256, storage_key
         from artifacts
         where id = $1 and organization_id = $2 and project_id = $3`,
        [artifactId ?? '', ...scopeOf(trace)],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      const bytes = await bytesOf(row['storage_key']);
      return { kind: row['kind'], sha256: row['sha256'], bytesSha256: bytes === null ? null : sha256Hex(bytes) };
    },

    // The harness's records of where this attempt's verification checks ran.
    // Every one recorded is returned, so the verifier can refuse none or
    // several.
    async resolveVerification(trace) {
      const r = await db.query(
        `select sha256, storage_key
         from artifacts
         where attempt_id = $1 and organization_id = $2 and project_id = $3 and kind = $4
         order by created_at, id`,
        [trace?.attemptId ?? '', ...scopeOf(trace), VERIFICATION_PROVENANCE_KIND],
      );
      const out = [];
      for (const row of r.rows) {
        const bytes = await bytesOf(row['storage_key']);
        out.push({
          sha256: row['sha256'],
          bytesSha256: bytes === null ? null : sha256Hex(bytes),
          record: bytes === null ? null : parseJsonObject(bytes),
        });
      }
      return out;
    },

    async resolvePullRequest(trace, pullRequestId) {
      const r = await db.query(
        `select id, number, url, head_branch, attempt_id
         from pull_requests
         where id = $1 and organization_id = $2 and project_id = $3`,
        [pullRequestId ?? '', ...scopeOf(trace)],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      return {
        number: row['number'] === null ? null : Number(row['number']),
        url: row['url'],
        headBranch: row['head_branch'],
        attemptId: row['attempt_id'],
      };
    },

    // The PR as the forge reports it NOW, through the forge port, in the
    // trace's tenant scope.
    async resolveLivePullRequest(trace, { repositoryBindingId, headBranch }) {
      const [organizationId, projectId] = scopeOf(trace);
      const pr = await forge.findPullRequest({ organizationId, projectId }, { repositoryBindingId, headBranch });
      if (!pr) return null;
      return { number: pr.number, url: pr.url, headBranch: pr.headBranch, headSha: pr.headSha };
    },

    // The human handoff. Note the deliberate shape: we return `signatureValid`
    // computed by verifying the row's detached ed25519 signature over the row's
    // OWN canonical payload. A row inserted by anyone who can write the DB, or a
    // row whose disposition was edited after signing, yields false here.
    async resolveHumanAuthorization(taskId, trace) {
      const r = await db.query(
        `select task_id, attempt_id, pull_request_id, disposition,
                reviewed_result_sha, signed_by, signature
         from human_authorizations
         where task_id = $1 and organization_id = $2 and project_id = $3`,
        [taskId ?? '', ...scopeOf(trace)],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      const record = {
        task_id: row['task_id'],
        attempt_id: row['attempt_id'],
        pull_request_id: row['pull_request_id'],
        disposition: row['disposition'],
        reviewed_result_sha: row['reviewed_result_sha'],
        signed_by: row['signed_by'],
        signature: row['signature'],
      };
      const { ok } = verifyAuthorizationSignature(record, pubKeyPem);
      return {
        disposition: record.disposition,
        signedBy: record.signed_by,
        signatureValid: ok,
        reviewedResultSha: record.reviewed_result_sha,
        attemptId: record.attempt_id,
        pullRequestId: record.pull_request_id,
      };
    },
  };
}

/**
 * Build the PRODUCTION resolver from the environment, opening a real PostgreSQL
 * connection. Returns { resolver, close }.
 *
 * Fail-closed by construction: a missing ASEP_PG_URL, a missing/unreadable
 * ASEP_REVIEWER_PUBLIC_KEY, a missing object-store directory, missing GitHub
 * App settings or missing Claude pins THROW before any connection is opened. The CLI turns that into a
 * non-zero exit with the reason, so an operator who forgets to point the gate at
 * the authoritative state gets a REJECTED verdict — never an accidental "OK"
 * computed from the manifest's own claims.
 *
 * The forge is the real GitHub App adapter behind the ForgeProvider port
 * (GitHubAppForgePort), loaded from the built @asep/github-app package, so the
 * live PR lookup takes the same credential, scoping and host checks as the
 * pilot's own forge calls. `pg` and the adapter are imported dynamically so this
 * module stays importable (and unit testable) without either.
 */
export async function createResolverFromEnv(env = process.env) {
  const pgUrl = (env[PG_URL_ENV] ?? '').trim();
  if (pgUrl.length === 0) {
    throw new Error(
      `${PG_URL_ENV} is not set — the pilot gate must resolve the manifest against the ` +
      'AUTHORITATIVE database; refusing to verify a self-declared manifest (HIGH-009)',
    );
  }
  const keyPath = (env[REVIEWER_KEY_ENV] ?? '').trim();
  if (keyPath.length === 0) {
    throw new Error(
      `${REVIEWER_KEY_ENV} is not set — it must point at the reviewer ed25519 public-key ` +
      'PEM used to verify signed human authorizations (PR2-08)',
    );
  }
  let reviewerPublicKeyPem;
  try {
    reviewerPublicKeyPem = readFileSync(keyPath, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${REVIEWER_KEY_ENV} at "${keyPath}": ${e.message}`);
  }
  const objectDir = (env[OBJECT_STORE_DIR_ENV] ?? '').trim();
  if (objectDir.length === 0) {
    throw new Error(
      `${OBJECT_STORE_DIR_ENV} is not set — it must point at the object store the pilot wrote ` +
      'its evidence bytes to; evidence is re-hashed from those bytes, not taken from metadata',
    );
  }
  let isDir = false;
  try {
    isDir = statSync(objectDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`${OBJECT_STORE_DIR_ENV} "${objectDir}" is not a directory`);
  const github = githubAppFromEnv(env);
  const agent = agentPinsFromEnv(env);

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: pgUrl });
  const db = {
    async query(text, params = []) {
      const r = await pool.query(text, params);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? (r.rows ?? []).length };
    },
  };
  try {
    const forge = await createGitHubForgePort(db, github);
    return {
      resolver: createSqlAuthorityResolver(db, {
        reviewerPublicKeyPem, objects: filesystemObjectReader(objectDir), forge, agent,
      }),
      close: () => pool.end(),
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}

// The pilot's Claude and verification-image pins from the same variables the
// pilot entrypoint reads. The model origin defaults to the public API and, as
// for the pilot, must be https.
function agentPinsFromEnv(env) {
  const need = (name) => {
    const v = (env[name] ?? '').trim();
    if (v.length === 0) {
      throw new Error(`${name} is not set — the verifier accepts only runs of the real Claude adapter under the pilot's pins`);
    }
    return v;
  };
  const rawBase = (env[MODEL_BASE_URL_ENV] ?? '').trim() || DEFAULT_MODEL_BASE_URL;
  let modelBaseUrl;
  try {
    modelBaseUrl = normalizeModelBaseUrl(rawBase);
  } catch (e) {
    throw new Error(`${MODEL_BASE_URL_ENV} is not a usable model origin: ${e.message}`);
  }
  if (!modelBaseUrl.startsWith('https://')) throw new Error(`${MODEL_BASE_URL_ENV} must be https://`);
  return pinnedAgentConfig({
    model: need(CLAUDE_MODEL_ENV),
    cliVersion: need(CLAUDE_CLI_VERSION_ENV),
    agentImage: need(AGENT_IMAGE_ENV),
    proxyImage: need(PROXY_IMAGE_ENV),
    modelBaseUrl,
    verifyImage: need(VERIFY_IMAGE_ENV),
  });
}

function positiveIntEnv(env, name) {
  const raw = (env[name] ?? '').trim();
  if (raw.length === 0) throw new Error(`${name} is not set — the live pull-request check needs the pilot's GitHub App`);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

function githubAppFromEnv(env) {
  const appId = positiveIntEnv(env, GITHUB_APP_ID_ENV);
  const keyPath = (env[GITHUB_PRIVATE_KEY_ENV] ?? '').trim();
  if (keyPath.length === 0) {
    throw new Error(`${GITHUB_PRIVATE_KEY_ENV} is not set — the live pull-request check needs the pilot's GitHub App`);
  }
  const installationId = positiveIntEnv(env, GITHUB_INSTALLATION_ENV);
  let privateKey;
  try {
    privateKey = readFileSync(keyPath, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${GITHUB_PRIVATE_KEY_ENV} at "${keyPath}": ${e.message}`);
  }
  return { appId, privateKey, installationId };
}

/**
 * The real GitHub App forge behind the ForgeProvider port, as the verifier uses
 * it: the built @asep/github-app adapter, JIT installation tokens scoped to the
 * binding's repository, and the binding resolved from the database in the
 * caller's tenant scope. The verifier only LOOKS UP pull requests; it never
 * pushes, so the local repository locator refuses.
 *
 * `overrides` replaces the GitHub transport (`octokitFor`) and the token
 * minting (`auth`) — for tests only; production passes neither.
 */
export async function createGitHubForgePort(db, { appId, privateKey, installationId }, overrides = {}) {
  const adapterUrl = new URL('../../adapters/github-app/dist/index.js', import.meta.url);
  let adapter;
  try {
    adapter = await import(adapterUrl.href);
  } catch (e) {
    throw new Error(`cannot load the GitHub App adapter (${adapterUrl.pathname}) — run \`pnpm build\` first: ${e.message}`);
  }
  let octokitFor = overrides.octokitFor;
  if (!octokitFor) {
    const { Octokit } = await import('@octokit/rest');
    octokitFor = (token) => new Octokit({ auth: token });
  }
  const credentials = new adapter.GitHubAppCredentialProvider({ appId, privateKey, installationId }, overrides.auth);
  const inner = new adapter.GitHubAppForgeProvider(credentials, octokitFor, ['github.com']);
  const bindings = new adapter.SqlForgeBindingResolver(sqlBindingReader(db), {
    localRepoPathFor: () => {
      throw new Error('the pilot verifier never pushes; it has no local repository');
    },
  });
  return new adapter.GitHubAppForgePort(inner, bindings);
}
