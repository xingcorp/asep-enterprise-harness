// Crash recovery through a fenced lease takeover — the fast proof.
//
// An executor dies part-way through the completion effects. Its successor must
// (a) wait while the dead executor's lease is still live, (b) then take its
// unfinished side-effect records over under a newer lease, (c) reconcile each
// against the forge, and (d) converge on exactly one commit, one remote ref and
// one pull request — while the dead executor is refused from then on.
//
// Real adapters throughout (in-process PostgreSQL via PGlite, real git mirror +
// worktree + bare remote, the real side-effect log and lease repository, the
// filesystem object store). The "crash" here is a forge call that throws after
// its effect landed, so the in-process run ends and releases its lease — the
// revocation path. The authoritative proof, crash-takeover.itest.ts, kills a
// real child process with SIGKILL against real PostgreSQL so the lease has to
// EXPIRE instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PgliteClient, migrate, SqlSideEffectLog, SqlWorkspaceLeaseRepository, type SqlClient,
} from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit, attemptBranch } from '@asep/git-worktree';
import { createBareRemote, LocalBareForgeProvider } from '@asep/local-doubles';
import {
  SideEffectFencingError, LeaseLostError,
  type CommandSpec, type ForgeProvider, type PullRequestRef,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, RunId, TaskId, AttemptId, OrganizationId, ProjectId,
} from '@asep/contracts';
import { runVerticalSlice, resumeVerticalSlice } from './vertical-slice.js';

console.log('SUITE-ID: asep-suite:crash-recovery');

// The verification sandbox: the real DockerSandboxProvider, driving the fake
// docker client (scripts/testing/fake-docker.mjs), which runs each container's
// command as a host process. The governed path accepts nothing but a handle
// that claims isolation; the OS-enforced proof is the integration suites.
async function fakeDockerSandbox(dir: string): Promise<DockerSandboxProvider> {
  await mkdir(dir, { recursive: true });
  const docker = join(dir, 'fake-docker');
  const fake = fileURLToPath(new URL('../../../scripts/testing/fake-docker.mjs', import.meta.url));
  await writeFile(docker, `#!/bin/sh\nexec "${process.execPath}" "${fake}" --state "${join(dir, 'docker-state')}" "$@"\n`,
    { mode: 0o755 });
  return new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: docker });
}

function checkCommandFor(wtPath: string): CommandSpec {
  return {
    executable: 'git',
    args: ['-C', wtPath, 'status', '--porcelain'],
    cwd: wtPath,
    environmentProfile: 'verification-no-network',
    timeoutMs: 60_000,
    outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
  };
}

class SimulatedCrash extends Error {}

type CrashPoint = 'after-push' | 'after-pr';

// A forge whose effect LANDS and then the executor "dies" before it can record
// the outcome — the window a naive retry would double.
function crashingForge(inner: LocalBareForgeProvider, at: CrashPoint): ForgeProvider {
  return {
    async pushBranch(scope, input) {
      await inner.pushBranch(scope, input);
      if (at === 'after-push') throw new SimulatedCrash('executor died after the push landed');
    },
    async upsertPullRequest(scope, input): Promise<PullRequestRef> {
      const pr = await inner.upsertPullRequest(scope, input);
      if (at === 'after-pr') throw new SimulatedCrash('executor died after the PR was opened');
      return pr;
    },
    resolveRef: (scope, input) => inner.resolveRef(scope, input),
    findPullRequest: (scope, input) => inner.findPullRequest(scope, input),
  };
}

interface Crashed {
  readonly client: SqlClient;
  readonly dir: string;
  readonly forgeRemote: string;
  readonly forge: LocalBareForgeProvider;
  readonly scope: TenantScope;
  readonly bindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly branch: string;
  readonly deadLease: string;
}

async function crashRun(at: CrashPoint | 'at-verify'): Promise<Crashed> {
  const dir = await mkdtemp(join(tmpdir(), 'asep-crash-recovery-'));
  const client = await PgliteClient.create();
  await migrate(client);
  const forgeRemote = await createBareRemote(join(dir, 'forge.git'));
  const inner = new LocalBareForgeProvider(forgeRemote);
  const failingCheck = (wtPath: string): CommandSpec => ({
    ...checkCommandFor(wtPath), args: ['-C', wtPath, 'no-such-subcommand'],
  });
  // The authoritative run under a real Docker sandbox is crash-takeover.itest.ts.
  const sandbox = await fakeDockerSandbox(join(dir, 'sandbox'));
  await assert.rejects(
    () => runVerticalSlice({
      client,
      sandbox,
      dir,
      checkCommand: at === 'at-verify' ? failingCheck : checkCommandFor,
      forge: crashingForge(inner, at === 'at-verify' ? 'after-push' : at),
      onWorkspaceCreated: (p) => inner.setWorktree(p),
    }),
    at === 'at-verify' ? /stopped early at 'verify'/ : SimulatedCrash,
  );
  const ids = await client.query(
    `select a.id, a.task_id, t.run_id, a.repository_binding_id, a.organization_id,
            a.project_id, a.base_sha
       from attempts a join tasks t on t.id = a.task_id`,
    [],
  );
  assert.equal(ids.rows.length, 1);
  const row = ids.rows[0]!;
  const runId = row['run_id'] as RunId;
  const taskId = row['task_id'] as TaskId;
  const attemptId = row['id'] as AttemptId;
  const lease = await client.query(
    `select id from workspace_leases where attempt_id = $1`, [attemptId],
  );
  return {
    client, dir, forgeRemote, forge: inner,
    scope: {
      organizationId: row['organization_id'] as OrganizationId,
      projectId: row['project_id'] as ProjectId,
    },
    bindingId: row['repository_binding_id'] as RepositoryBindingId,
    runId, taskId, attemptId,
    baseSha: row['base_sha'] as string,
    branch: attemptBranch({ runId, taskId, attemptId }),
    deadLease: lease.rows[0]!['id'] as string,
  };
}

function resume(c: Crashed) {
  return resumeVerticalSlice({
    client: c.client,
    dir: c.dir,
    scope: c.scope,
    repositoryBindingId: c.bindingId,
    runId: c.runId,
    taskId: c.taskId,
    attemptId: c.attemptId,
    baseSha: c.baseSha,
    branch: c.branch,
    remoteBare: c.forgeRemote,
    pushFrom: join(c.dir, 'mirror.git'),
  });
}

async function records(c: Crashed) {
  const r = await c.client.query(
    `select operation, state, owner_lease_id, owner_epoch, result_ref
       from side_effect_records where attempt_id = $1 order by operation`,
    [c.attemptId],
  );
  return r.rows;
}

// The remote holds exactly one branch, pointing at exactly one commit on top of
// the base — and the PR store holds exactly one PR for it.
async function assertConverged(c: Crashed, commitSha: string) {
  const refs = (await runGit(['-C', c.forgeRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads/']))
    .stdout.split('\n').filter((l) => l.trim() !== '');
  assert.deepEqual(refs, [`refs/heads/${c.branch}`], 'exactly one remote ref');
  const tip = (await runGit(['-C', c.forgeRemote, 'rev-parse', `refs/heads/${c.branch}`])).stdout.trim();
  assert.equal(tip, commitSha, 'the ref points at the recorded harness commit');
  const count = (await runGit(['-C', c.forgeRemote, 'rev-list', '--count', `${c.baseSha}..${tip}`]))
    .stdout.trim();
  assert.equal(count, '1', 'exactly one commit on top of the base');
  const prs = await c.forge.listPullRequests();
  assert.equal(prs.length, 1, 'exactly one pull request');
  assert.equal(prs[0]!.headBranch, c.branch);
  const rows = await c.client.query(
    `select count(*)::int as n from pull_requests where attempt_id = $1`, [c.attemptId],
  );
  assert.equal(rows.rows[0]!['n'], 1, 'exactly one persisted PR row');
}

async function cleanup(c: Crashed) {
  await c.client.close();
  await rm(c.dir, { recursive: true, force: true });
}

test('a crash after the push landed: the successor takes the push over, reconciles it, and opens the one PR', async () => {
  const c = await crashRun('after-push');
  try {
    const before = await records(c);
    assert.deepEqual(before.map((r) => [r['operation'], r['state']]), [
      ['commit', 'COMPLETED'], ['push', 'PENDING'],
    ]);
    assert.equal(before[1]!['owner_lease_id'], c.deadLease);

    const r = await resume(c);
    assert.equal(r.stoppedAt, 'complete', r.reason);
    assert.equal(r.fencingEpoch, 2, 'the successor holds the next epoch');
    assert.equal(r.pushAdopted, true, 'the landed push was reconciled, not repeated');
    assert.equal(r.pushes, 0, 'the successor pushed nothing');
    assert.equal(r.prAdopted, false, 'the PR did not exist yet, so the successor opened it');
    assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    await assertConverged(c, r.commitSha!);

    const after = await records(c);
    assert.deepEqual(after.map((x) => [x['operation'], x['state']]), [
      ['commit', 'COMPLETED'], ['pr-upsert', 'COMPLETED'], ['push', 'COMPLETED'],
    ]);
    const push = after.find((x) => x['operation'] === 'push')!;
    assert.equal(push['owner_lease_id'], r.leaseId, 'the record moved to the successor lease');
    assert.equal(Number(push['owner_epoch']), 2);

    const attempt = await c.client.query(
      `select result_sha, evidence_artifact_id from attempts where id = $1`, [c.attemptId],
    );
    assert.equal(attempt.rows[0]!['result_sha'], r.commitSha);
    assert.equal(attempt.rows[0]!['evidence_artifact_id'], r.evidenceArtifactId);

    // The dead executor is refused for good.
    const log = new SqlSideEffectLog(c.client);
    await assert.rejects(
      () => log.complete(c.scope, {
        operation: 'push', repositoryBindingId: c.bindingId, attemptId: c.attemptId,
        ownerToken: c.deadLease,
        resultRef: { kind: 'push', branch: c.branch, commitSha: r.commitSha! },
      }),
      SideEffectFencingError,
    );
    await assert.rejects(
      () => new SqlWorkspaceLeaseRepository(c.client).heartbeat(c.scope, c.deadLease),
      LeaseLostError,
    );

    // A second resume is a no-op that converges on the same state.
    const again = await resume(c);
    assert.equal(again.stoppedAt, 'complete');
    assert.equal(again.pushAdopted, true);
    assert.equal(again.prAdopted, true);
    assert.equal(again.pushes, 0);
    await assertConverged(c, r.commitSha!);
  } finally {
    await cleanup(c);
  }
});

test('a crash after the PR was opened: the successor adopts that PR instead of opening a second', async () => {
  const c = await crashRun('after-pr');
  try {
    const before = await records(c);
    assert.deepEqual(before.map((r) => [r['operation'], r['state']]), [
      ['commit', 'COMPLETED'], ['pr-upsert', 'PENDING'], ['push', 'COMPLETED'],
    ]);
    assert.equal((await c.forge.listPullRequests()).length, 1, 'the PR reached the forge');

    const r = await resume(c);
    assert.equal(r.stoppedAt, 'complete', r.reason);
    assert.equal(r.pushAdopted, true);
    assert.equal(r.prAdopted, true, 'the existing PR was found by its head branch');
    assert.equal(r.prNumber, 1);
    await assertConverged(c, r.commitSha!);
  } finally {
    await cleanup(c);
  }
});

test('while another executor holds a live lease on the branch, the resume does nothing', async () => {
  const c = await crashRun('after-push');
  try {
    const leases = new SqlWorkspaceLeaseRepository(c.client);
    const live = await leases.acquire(c.scope, {
      repositoryBindingId: c.bindingId, branch: c.branch, attemptId: c.attemptId, ttlMs: 60_000,
    });
    assert.ok('leaseId' in live);
    const r = await resume(c);
    assert.equal(r.stoppedAt, 'lease-denied');
    const push = (await records(c)).find((x) => x['operation'] === 'push')!;
    assert.equal(push['state'], 'PENDING', 'nothing was taken over');
    assert.equal(push['owner_lease_id'], c.deadLease);
    assert.equal((await c.forge.listPullRequests()).length, 0, 'no PR was opened');
  } finally {
    await cleanup(c);
  }
});

test('an attempt whose commit never became durable is reported for re-execution, untouched', async () => {
  const c = await crashRun('at-verify');
  try {
    assert.deepEqual(await records(c), [], 'nothing was recorded before verification failed');
    const r = await resume(c);
    assert.equal(r.stoppedAt, 'not-resumable');
    assert.match(r.reason ?? '', /no harness commit was recorded/);
    const refs = (await runGit(['-C', c.forgeRemote, 'for-each-ref', 'refs/heads/'])).stdout.trim();
    assert.equal(refs, '', 'nothing reached the remote');
    assert.equal((await c.forge.listPullRequests()).length, 0);
  } finally {
    await cleanup(c);
  }
});

test('an attempt whose evidence is missing is not resumed: evidence for an unverified tree is never invented', async () => {
  const c = await crashRun('after-push');
  try {
    const commit = (await records(c)).find((x) => x['operation'] === 'commit')!;
    const ref = typeof commit['result_ref'] === 'string'
      ? JSON.parse(commit['result_ref'] as string) as { evidenceId: string }
      : commit['result_ref'] as { evidenceId: string };
    await c.client.query(`delete from artifacts where id = $1`, [ref.evidenceId]);
    const r = await resume(c);
    assert.equal(r.stoppedAt, 'not-resumable');
    assert.match(r.reason ?? '', /no evidence bundle/);
    assert.equal((await c.forge.listPullRequests()).length, 0, 'no PR was opened');
  } finally {
    await cleanup(c);
  }
});

// A resume publishes, so it is admitted like a fresh run: from the task row's
// own risk, before the lease. Here the authoritative row says R4, a deferred
// risk, so the resume must take no lease and touch no record, ref or PR.
test('a resume of a task whose authoritative risk is deferred stops at admission and touches nothing', async () => {
  const c = await crashRun('after-push');
  try {
    await c.client.query(`update tasks set risk = 'R4' where id = $1`, [c.taskId]);
    const leasesBefore = (await c.client.query(
      `select count(*)::int as n from workspace_leases where attempt_id = $1`, [c.attemptId],
    )).rows[0]!['n'];
    const r = await resume(c);
    assert.equal(r.stoppedAt, 'admission');
    assert.match(r.reason ?? '', /R4/);
    assert.equal((await c.client.query(
      `select count(*)::int as n from workspace_leases where attempt_id = $1`, [c.attemptId],
    )).rows[0]!['n'], leasesBefore, 'no lease was taken');
    const push = (await records(c)).find((x) => x['operation'] === 'push')!;
    assert.equal(push['state'], 'PENDING', 'nothing was taken over');
    assert.equal(push['owner_lease_id'], c.deadLease);
    assert.equal((await c.forge.listPullRequests()).length, 0, 'no PR was opened');
    const task = await c.client.query(`select status from tasks where id = $1`, [c.taskId]);
    assert.notEqual(task.rows[0]!['status'], 'WAITING_FOR_HUMAN_REVIEW');
  } finally {
    await cleanup(c);
  }
});
