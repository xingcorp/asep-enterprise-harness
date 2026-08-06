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
// This module is that resolver. It answers each of the verifier's four questions
// from AUTHORITATIVE state:
//
//   resolveAttempt            → the `attempts` row (result_sha, provider, scope)
//   resolveEvidence           → the `artifacts` row (authoritative sha256)
//   resolvePullRequest        → the `pull_requests` row (url, owning attempt)
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

import { readFileSync } from 'node:fs';
import { verifyAuthorizationSignature } from './human-authorization-crypto.mjs';

// Environment contract for the production gate. Both are REQUIRED to honour a
// COMPLETE verdict; a missing one is a hard error, never a downgrade to the
// self-declared path (that downgrade WAS the HIGH-009 defect).
export const PG_URL_ENV = 'ASEP_PG_URL';
export const REVIEWER_KEY_ENV = 'ASEP_REVIEWER_PUBLIC_KEY';

/**
 * Build an authority resolver over a SQL executor.
 *
 * @param {{ query(text: string, params?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[], rowCount: number }> }} db
 * @param {{ reviewerPublicKeyPem: string }} opts reviewer ed25519 public key
 *   (SPKI PEM) used to verify human-authorization signatures. REQUIRED: without
 *   it no disposition can be trusted, so the factory refuses to build.
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

  // Scope every lookup by the trace's tenant pair. A manifest that names another
  // tenant's attempt resolves to zero rows and fails closed.
  const scopeOf = (trace) => [trace?.organizationId ?? '', trace?.projectId ?? ''];

  return {
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
      const r = await db.query(
        `select a.id, a.task_id, t.run_id, a.repository_binding_id, a.result_sha,
                a.agent_provider_id, a.evidence_artifact_id, a.evidence_sha256
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
        resultSha: row['result_sha'],
        providerId: row['agent_provider_id'],
        evidenceArtifactId: row['evidence_artifact_id'],
        evidenceSha256: row['evidence_sha256'],
      };
    },

    async resolveEvidence(trace, evidenceArtifactId) {
      const r = await db.query(
        `select id, kind, sha256
         from artifacts
         where id = $1 and organization_id = $2 and project_id = $3`,
        [evidenceArtifactId ?? '', ...scopeOf(trace)],
      );
      if (r.rowCount === 0) return null;
      const row = r.rows[0];
      return { sha256: row['sha256'], kind: row['kind'] };
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
      };
    },
  };
}

/**
 * Build the PRODUCTION resolver from the environment, opening a real PostgreSQL
 * connection. Returns { resolver, close }.
 *
 * Fail-closed by construction: a missing ASEP_PG_URL or a missing/unreadable
 * ASEP_REVIEWER_PUBLIC_KEY THROWS. The CLI turns that into a non-zero exit with
 * the reason, so an operator who forgets to point the gate at the authoritative
 * database gets a REJECTED verdict — never an accidental "OK" computed from the
 * manifest's own claims.
 *
 * `pg` is imported dynamically so this module stays importable (and unit
 * testable) in environments without the driver: only the production path that
 * actually needs a connection pays for it.
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

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: pgUrl });
  const db = {
    async query(text, params = []) {
      const r = await pool.query(text, params);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? (r.rows ?? []).length };
    },
  };
  return {
    resolver: createSqlAuthorityResolver(db, { reviewerPublicKeyPem }),
    close: () => pool.end(),
  };
}
