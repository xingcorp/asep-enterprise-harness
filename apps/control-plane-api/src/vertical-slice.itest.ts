// AUTHORITATIVE K1 vertical-slice proof (disp. P2-FINAL-HIGH-002 / HIGH-008).
//
// The review found two defects in the K1 evidence:
//   HIGH-002  the slice ran its verification commands through
//             LocalUnsandboxedProvider — straight on the host — so the
//             end-to-end proof never exercised a real sandbox at all.
//   HIGH-008  the K1 test hand-assembled a private path instead of driving a
//             real application driver, and the PR lived only in memory.
//
// This suite closes both against REAL backends:
//   * PostgreSQL — the digest-pinned container the integration gate provisions,
//     reached through pg.Pool (PgPoolClient), NOT in-process PGlite. Every
//     authoritative transition (attempt.result_sha, the scoped evidence
//     attachment, task status, the PR row) is asserted by reading real rows back
//     out of that database.
//   * Docker sandbox — a real DockerSandboxProvider on a digest-pinned image, so
//     the mandatory R0 verification commands execute INSIDE a container with
//     OS-enforced --network none / read-only rootfs, and the handle reports
//     isolationEnforced === true.
//
// Both this suite and the fast seam test (vertical-integration.test.ts) drive the
// SAME exported driver, runVerticalSlice(), so the governed sequence cannot drift
// between the fast and the authoritative proof.
//
// It is *.itest.ts, so it runs ONLY under the integration gate, which guarantees
// a real database and a real docker daemon. It fails CLOSED — requirePgUrl()
// throws when the backend env is absent and the docker preflight asserts rather
// than skips.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { Pool } from 'pg';
import { PgPoolClient, migrate } from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit } from '@asep/git-worktree';
import type { CommandSpec } from '@asep/ports';
import { runVerticalSlice } from './vertical-slice.js';

console.log('SUITE-ID: asep-suite:vertical-slice-real');

// alpine 3.20, digest-pinned (same discipline as scripts/integration/images.mjs).
const ALPINE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

// FAIL-CLOSED: the integration gate sets this. Bare runs must abort, never skip.
function requirePgUrl(): string {
  const url = process.env['ASEP_PG_URL'];
  if (!url || url.trim() === '') {
    throw new Error(
      'ASEP_PG_URL is not set — this suite requires a REAL PostgreSQL backend and ' +
        'must run under the integration gate (scripts/integration/run-integration.mjs). ' +
        'Failing closed rather than skipping (P2-FINAL-HIGH-001/002).',
    );
  }
  return url;
}

function dockerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err) => resolve(!err));
  });
}

test('HIGH-002 preflight: docker is reachable (fail closed, never skip)', async () => {
  assert.equal(await dockerReachable(), true, 'the integration gate must provide a working docker');
});

test('K1 (REAL backends): full governed slice on pg.Pool PostgreSQL + a real Docker sandbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-vslice-real-'));
  // A real multi-connection pool against the gate's digest-pinned PostgreSQL.
  const pool = new Pool({ connectionString: requirePgUrl(), max: 4 });
  const client = PgPoolClient.fromPool(pool);
  try {
    await migrate(client);

    // A REAL Docker sandbox: the verification commands run in-container under
    // OS-enforced isolation, not on the host.
    const sandbox = new DockerSandboxProvider({ imageDigest: ALPINE });

    // The mandatory R0 checks must be runnable INSIDE the minimal container, so
    // they assert on the mounted working tree rather than invoking host git.
    // `test -f <wt>/feature.txt` genuinely passes only because the agent's write
    // landed in the writable working-tree mount.
    const checkCommand = (wtPath: string): CommandSpec => ({
      executable: 'sh',
      args: ['-c', `test -f ${wtPath}/feature.txt`],
      cwd: wtPath,
      environmentProfile: 'verification-no-network',
      timeoutMs: 60_000,
      outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
    });

    const r = await runVerticalSlice({ client, sandbox, dir, checkCommand });

    // --- the sandbox was REAL, and OS-enforced ------------------------------
    assert.equal(r.sandboxIsolationEnforced, true,
      'the slice ran under a sandbox that actually enforces isolation (HIGH-002)');

    // --- the slice reached the harness ceiling ------------------------------
    assert.equal(r.stoppedAt, 'complete', 'the pipeline reached the review gate');
    assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW', 'harness ceiling (I1/I2)');
    assert.match(r.commitSha, /^[0-9a-f]{40}$/, 'a real harness commit SHA');

    // --- the commit is real Git state, carrying the evidence trailer --------
    const commitMsg = (await runGit(['-C', r.wtPath, 'log', '-1', '--format=%B'])).stdout;
    assert.ok(commitMsg.includes('ASEP-Attempt:'), 'commit carries the attempt trailer');
    assert.ok(commitMsg.includes(`ASEP-Evidence: ${r.evidenceArtifactId}`),
      'commit embeds the preallocated evidence id');

    // The agent's file is really in the tree the commit was made from.
    assert.equal(
      await readFile(join(r.wtPath, 'feature.txt'), 'utf8'),
      'implemented by the agent\n',
    );

    // --- exactly one push, landing on the exact commit in the real remote ---
    assert.equal(r.pushes, 1, 'exactly one push');
    const remoteSha = (await runGit(
      ['-C', r.remoteBare, 'rev-parse', `refs/heads/${r.branch}`],
    )).stdout.trim();
    assert.equal(remoteSha, r.commitSha, 'the remote ref points at the harness commit');

    // --- HIGH-008: authoritative transitions PERSISTED in real PostgreSQL ---
    // Re-read every row from the live database, not from the driver's return.
    const attemptRow = await r.repos.attempts.getScoped(r.scope, r.attemptId);
    assert.equal(attemptRow.resultSha, r.commitSha,
      'attempt.result_sha == harness commit SHA (D8, persisted in PostgreSQL)');
    assert.equal(attemptRow.evidenceArtifactId, r.evidenceArtifactId,
      'attempt → evidence artifact (persisted)');
    assert.equal(attemptRow.evidenceSha256, r.evidenceSha256,
      'attempt evidence sha256 pinned (persisted)');

    const taskRow = await r.repos.tasks.getScoped(r.scope, r.taskId);
    assert.equal(taskRow.status, 'WAITING_FOR_HUMAN_REVIEW',
      'task.status persisted at the harness ceiling');
    assert.equal(taskRow.runId, r.runId, 'task → run (persisted)');

    const runRow = await r.repos.runs.getScoped(r.scope, r.runId);
    assert.equal(runRow.repositoryBindingId, r.repositoryBindingId,
      'run → repository binding (persisted)');

    const prBack = await r.repos.prs.getByBranch(r.scope, r.repositoryBindingId, r.branch);
    assert.equal(prBack.number, r.prNumber, 'PR number persisted');
    assert.equal(prBack.attemptId, r.attemptId, 'PR → attempt (persisted)');
    assert.equal(prBack.evidenceArtifactId, r.evidenceArtifactId,
      'PR → evidence artifact (persisted)');

    // --- K3: the evidence bundle round-trips out of real storage ------------
    const evidenceBack = await r.repos.evidenceStore.getEvidence(r.scope, r.evidenceArtifactId);
    assert.equal(evidenceBack.attemptId, r.attemptId, 'evidence → attempt');
    assert.equal(evidenceBack.taskId, r.taskId, 'evidence → task');
    assert.equal(evidenceBack.resultSha, r.commitSha,
      'D8: evidence resultSha is the harness commit SHA');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
