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
// its effect landed, or an evidence write that throws after the harness commit,
// so the in-process run ends and releases its lease — the revocation path. The authoritative proof, crash-takeover.itest.ts, kills a
// real child process with SIGKILL against real PostgreSQL so the lease has to
// EXPIRE instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PgliteClient, migrate, SqlSideEffectLog, SqlWorkspaceLeaseRepository, FilesystemObjectStore,
  ContentAddressedEvidenceStore, RepositoryBindingRepository, type SqlClient, type SqlExecutor, type ObjectStore,
} from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit, attemptBranch } from '@asep/git-worktree';
import { createBareRemote, seedMirror, LocalBareForgeProvider } from '@asep/local-doubles';
import {
  GitHubAppCredentialProvider, GitHubAppForgeProvider, GitHubAppForgePort, SqlForgeBindingResolver,
  type OctokitLike,
} from '@asep/github-app';
import {
  SideEffectFencingError, LeaseLostError, evidenceBundleFrom, pullRequestContent,
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

// The run's own object store, in which the executor "dies" at the first write
// of an evidence bundle — after the harness commit, before its evidence.
function crashingAtEvidence(root: string): ObjectStore {
  const inner = new FilesystemObjectStore(root);
  return {
    async putIfAbsent(key, bytes) {
      if (key.includes('/evidence/')) throw new SimulatedCrash('executor died between the commit and its evidence');
      return inner.putIfAbsent(key, bytes);
    },
    get: (key) => inner.get(key),
    exists: (key) => inner.exists(key),
  };
}

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

// The run's database connection, through which the executor "dies" as it is
// about to record its harness commit — after the commit landed in git.
function crashingAtCommitRecord(client: SqlClient): SqlClient {
  const guard = (db: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      if (/update side_effect_records\s+set state/.test(text)
        && params?.includes('commit') && params.includes('COMPLETED')) {
        return Promise.reject(new SimulatedCrash('executor died between the commit and its record'));
      }
      return db.query(text, params);
    },
  });
  return {
    query: (text, params) => guard(client).query(text, params),
    transaction: (fn) => client.transaction((tx) => fn(guard(tx))),
    ping: () => client.ping(),
    close: () => client.close(),
  };
}

async function crashRun(at: CrashPoint | 'at-verify' | 'at-evidence' | 'at-commit-record'): Promise<Crashed> {
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
      client: at === 'at-commit-record' ? crashingAtCommitRecord(client) : client,
      sandbox,
      dir,
      checkCommand: at === 'at-verify' ? failingCheck : checkCommandFor,
      forge: crashingForge(inner, at === 'after-pr' ? 'after-pr' : 'after-push'),
      ...(at === 'at-evidence' ? { objectStore: crashingAtEvidence(join(dir, 'objects')) } : {}),
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

// A stale owner may still reach the forge after the takeover — here, after the
// crash, something rewrote the attempt branch onto another commit and the PR
// with other text. The successor puts both back to what the attempt's facts
// say before the terminal state, and each repair is an audit row.
test('a successor rewrites a diverged branch and PR from the attempt\'s facts, each repair on record', async () => {
  const c = await crashRun('after-pr');
  try {
    const mirror = join(c.dir, 'mirror.git');
    const commitSha = (await runGit(['-C', c.forgeRemote, 'rev-parse', `refs/heads/${c.branch}`])).stdout.trim();
    const other = (await runGit([
      '--git-dir', mirror, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit-tree', `${commitSha}^{tree}`, '-p', commitSha, '-m', 'not the attempt\'s',
    ])).stdout.trim();
    await runGit(['--git-dir', mirror, 'push', '-q', '--force', c.forgeRemote, `${other}:refs/heads/${c.branch}`]);
    await c.forge.upsertPullRequest(c.scope, {
      repositoryBindingId: c.bindingId, headBranch: c.branch, base: 'main',
      title: 'rewritten by a stale writer', body: 'rewritten by a stale writer',
    });

    const r = await resume(c);
    assert.equal(r.stoppedAt, 'complete', r.reason);
    assert.equal(r.commitSha, commitSha);
    assert.equal(r.branchRepaired, true);
    assert.equal(r.prRepaired, true);
    assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    await assertConverged(c, commitSha);
    const content = pullRequestContent({
      taskId: c.taskId, attemptId: c.attemptId, commitSha, evidenceId: r.evidenceArtifactId!, base: 'main',
    });
    const [pr] = await c.forge.listPullRequests();
    assert.deepEqual({ title: pr!.title, body: pr!.body, base: pr!.baseBranch }, { ...content, base: 'main' });

    const repairs = await c.client.query(
      `select detail from audit_events where attempt_id = $1 and action = 'forge.reconcile' order by occurred_at, id`,
      [c.attemptId],
    );
    const details = repairs.rows.map((row) => row['detail'] as Record<string, unknown>);
    assert.deepEqual(details.map((d) => d['target']).sort(), ['branch', 'pull-request']);
    const branch = details.find((d) => d['target'] === 'branch')!;
    assert.deepEqual(branch, { target: 'branch', branch: c.branch, found: other, commitSha });
    const order = await c.client.query(
      `select bool_and(r.occurred_at <= t.occurred_at) as before
         from audit_events r, audit_events t
        where r.attempt_id = $1 and r.action = 'forge.reconcile'
          and t.attempt_id = $1 and t.action = 'task.status.transition' and t.detail->>'resumed' = 'true'`,
      [c.attemptId],
    );
    assert.equal(order.rows[0]!['before'], true, 'every repair is on record before the terminal transition');
  } finally {
    await cleanup(c);
  }
});

// The local forge double holds the push the way a real remote does: only over
// the value the branch is expected to hold.
test('the local bare forge takes a push only over the value the branch is expected to hold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-local-cas-'));
  try {
    const { mirror, baseSha } = await seedMirror(join(dir, 'seed'));
    const other = (await runGit([
      '--git-dir', mirror, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit-tree', `${baseSha}^{tree}`, '-p', baseSha, '-m', 'other',
    ])).stdout.trim();
    const remote = await createBareRemote(join(dir, 'forge.git'));
    const forge = new LocalBareForgeProvider(remote);
    forge.setWorktree(mirror);
    const branch = attemptBranch({ runId: 'R'.repeat(26) as RunId, taskId: 'T'.repeat(26) as TaskId, attemptId: 'A'.repeat(26) as AttemptId });
    const scope = { organizationId: 'O'.repeat(26) as OrganizationId, projectId: 'P'.repeat(26) as ProjectId };
    const push = (commitSha: string, expectedRemoteSha: string | null) => forge.pushBranch(scope, {
      repositoryBindingId: 'B'.repeat(26) as RepositoryBindingId, branch, commitSha, expectedRemoteSha,
    });
    const tip = async () => (await runGit(['-C', remote, 'rev-parse', `refs/heads/${branch}`])).stdout.trim();
    await push(baseSha, null);
    await push(baseSha, null);
    assert.equal(await tip(), baseSha, 'the same commit again changes nothing');
    await assert.rejects(() => push(other, null), /stale info/);
    assert.equal(await tip(), baseSha);
    await push(other, baseSha);
    assert.equal(await tip(), other);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// …and holds a PR the way the GitHub adapter does: a PR a human closed, merged
// or moved to another base is returned as found, never reopened or written.
test('the local bare forge never reopens, retargets or edits a PR a human closed or moved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-local-pr-'));
  try {
    const forge = new LocalBareForgeProvider(await createBareRemote(join(dir, 'forge.git')));
    const scope = { organizationId: 'O'.repeat(26) as OrganizationId, projectId: 'P'.repeat(26) as ProjectId };
    const upsert = (headBranch: string, base: string) => forge.upsertPullRequest(scope, {
      repositoryBindingId: 'B'.repeat(26) as RepositoryBindingId, headBranch, base, title: 'T2', body: 'B2',
    });
    for (const b of ['asep/closed', 'asep/merged', 'asep/moved']) {
      await forge.upsertPullRequest(scope, {
        repositoryBindingId: 'B'.repeat(26) as RepositoryBindingId, headBranch: b, base: 'main', title: 'T', body: 'B',
      });
    }
    await forge.closePullRequest('asep/closed', { merged: false });
    await forge.closePullRequest('asep/merged', { merged: true });
    await forge.retargetPullRequest('asep/moved', 'release/2');
    const before = await forge.listPullRequests();
    const found = [await upsert('asep/closed', 'main'), await upsert('asep/merged', 'main'), await upsert('asep/moved', 'main')];
    assert.deepEqual(await forge.listPullRequests(), before, 'nothing was written');
    assert.deepEqual(found.map((p) => [p.state, p.merged, p.baseBranch]), [
      ['closed', false, 'main'], ['closed', true, 'main'], ['open', false, 'release/2'],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
    assert.match(r.reason ?? '', /no harness commit was begun/);
    const refs = (await runGit(['-C', c.forgeRemote, 'for-each-ref', 'refs/heads/'])).stdout.trim();
    assert.equal(refs, '', 'nothing reached the remote');
    assert.equal((await c.forge.listPullRequests()).length, 0);
  } finally {
    await cleanup(c);
  }
});

test('a crash after the commit landed but before it was recorded: the successor adopts that commit, never a second', async () => {
  const c = await crashRun('at-commit-record');
  try {
    const before = await records(c);
    assert.deepEqual(before.map((r) => [r['operation'], r['state']]), [['commit', 'PENDING']]);
    const landed = (await runGit(['-C', join(c.dir, 'mirror.git'), 'rev-parse', `refs/asep/attempts/${c.attemptId}`]))
      .stdout.trim();
    assert.match(landed, /^[0-9a-f]{40}$/, 'the commit landed in git');
    assert.equal((await c.forge.listPullRequests()).length, 0, 'nothing was published');

    const r = await resume(c);
    assert.equal(r.stoppedAt, 'complete', r.reason);
    assert.equal(r.commitSha, landed, 'the landed commit is adopted');
    assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    await assertConverged(c, landed);

    const after = await records(c);
    const commit = after.find((x) => x['operation'] === 'commit')!;
    assert.equal(commit['state'], 'COMPLETED');
    assert.equal(commit['owner_lease_id'], r.leaseId, 'the successor took the record over to finish it');
    const evidence = new ContentAddressedEvidenceStore(c.client, new FilesystemObjectStore(join(c.dir, 'objects')));
    const reservation = await evidence.getReservation(c.scope, r.evidenceArtifactId!);
    assert.deepEqual(
      await evidence.getEvidence(c.scope, r.evidenceArtifactId!),
      evidenceBundleFrom(reservation.draft, landed),
      'the evidence the commit names, completed with that commit',
    );
    const attempts = await c.client.query(
      `select count(*)::int as n from attempts where task_id = $1`, [c.taskId]);
    assert.equal(attempts.rows[0]!['n'], 1, 'the same attempt was resumed; none was started');
  } finally {
    await cleanup(c);
  }
});

test('a crash between the commit and its evidence: the successor completes the reserved evidence and publishes once', async () => {
  const c = await crashRun('at-evidence');
  try {
    const before = await records(c);
    assert.deepEqual(before.map((r) => [r['operation'], r['state']]), [['commit', 'COMPLETED']]);
    const evidenceId = (typeof before[0]!['result_ref'] === 'string'
      ? JSON.parse(before[0]!['result_ref'] as string)
      : before[0]!['result_ref']) as { evidenceId: string };
    const stored = await c.client.query(
      `select count(*)::int as n from artifacts where id = $1`, [evidenceId.evidenceId]);
    assert.equal(stored.rows[0]!['n'], 0, 'the evidence bundle was never written');
    assert.equal((await c.forge.listPullRequests()).length, 0, 'nothing was published');

    const r = await resume(c);
    assert.equal(r.stoppedAt, 'complete', r.reason);
    assert.equal(r.evidenceArtifactId, evidenceId.evidenceId, 'the evidence lands at the id the commit names');
    assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    await assertConverged(c, r.commitSha!);

    // The evidence is the draft the dead executor reserved before it committed,
    // completed with that commit — nothing was re-derived.
    const evidence = new ContentAddressedEvidenceStore(c.client, new FilesystemObjectStore(join(c.dir, 'objects')));
    const reservation = await evidence.getReservation(c.scope, r.evidenceArtifactId!);
    assert.deepEqual(
      await evidence.getEvidence(c.scope, r.evidenceArtifactId!),
      evidenceBundleFrom(reservation.draft, r.commitSha!),
    );
    const attempts = await c.client.query(
      `select count(*)::int as n from attempts where task_id = $1`, [c.taskId]);
    assert.equal(attempts.rows[0]!['n'], 1, 'the same attempt was resumed; none was started');
  } finally {
    await cleanup(c);
  }
});

test('when the reserved evidence draft is unreadable the resume publishes nothing: evidence is never invented', async () => {
  const c = await crashRun('at-evidence');
  try {
    const draft = await c.client.query(
      `select a.storage_key from evidence_reservations r join artifacts a on a.id = r.draft_artifact_id
        where r.attempt_id = $1`,
      [c.attemptId],
    );
    assert.equal(draft.rows.length, 1);
    await rm(join(c.dir, 'objects', draft.rows[0]!['storage_key'] as string));
    await assert.rejects(() => resume(c));
    const refs = (await runGit(['-C', c.forgeRemote, 'for-each-ref', 'refs/heads/'])).stdout.trim();
    assert.equal(refs, '', 'nothing reached the remote');
    assert.equal((await c.forge.listPullRequests()).length, 0, 'no PR was opened');
    const task = await c.client.query(`select status from tasks where id = $1`, [c.taskId]);
    assert.notEqual(task.rows[0]!['status'], 'WAITING_FOR_HUMAN_REVIEW');
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

// A PR a human closed or merged, or moved to another base, is not a publication
// under review. The successor finds it, writes nothing to it, records no PR row
// and fails the task, on record with what it found.

async function failedOnRecord(client: SqlClient, taskId: TaskId, attemptId: AttemptId) {
  const task = await client.query(`select status from tasks where id = $1`, [taskId]);
  const rows = await client.query(`select count(*)::int as n from pull_requests where attempt_id = $1`, [attemptId]);
  const audit = await client.query(
    `select detail from audit_events
      where attempt_id = $1 and action = 'task.status.transition' and detail->>'to' = 'FAILED'`,
    [attemptId],
  );
  return {
    status: task.rows[0]!['status'],
    prRows: rows.rows[0]!['n'],
    failures: audit.rows.map((row) => row['detail'] as Record<string, unknown>),
  };
}

const humanActs = [
  {
    name: 'closed', act: (f: LocalBareForgeProvider, b: string) => f.closePullRequest(b, { merged: false }),
    found: { baseBranch: 'main', state: 'closed', merged: false }, reason: /PR #1 is closed/,
  },
  {
    name: 'merged', act: (f: LocalBareForgeProvider, b: string) => f.closePullRequest(b, { merged: true }),
    found: { baseBranch: 'main', state: 'closed', merged: true }, reason: /PR #1 is merged/,
  },
  {
    name: 'moved to another base', act: (f: LocalBareForgeProvider, b: string) => f.retargetPullRequest(b, 'release/2'),
    found: { baseBranch: 'release/2', state: 'open', merged: false },
    reason: /PR #1 targets release\/2, not the attempt's base main/,
  },
];

for (const h of humanActs) {
  test(`a successor over a PR a human ${h.name} fails the task on record and leaves the PR as it found it`, async () => {
    const c = await crashRun('after-pr');
    try {
      await h.act(c.forge, c.branch);
      const before = await c.forge.listPullRequests();
      const r = await resume(c);
      assert.equal(r.stoppedAt, 'publication-incomplete', r.reason);
      assert.match(r.reason ?? '', h.reason);
      assert.equal(r.taskStatus, 'FAILED');
      assert.equal(r.prAdopted, true, 'the PR was found by its head branch, not opened again');
      assert.deepEqual(await c.forge.listPullRequests(), before, 'never reopened, retargeted or edited');
      const f = await failedOnRecord(c.client, c.taskId, c.attemptId);
      assert.equal(f.status, 'FAILED');
      assert.equal(f.prRows, 0, 'no PR row is recorded');
      assert.deepEqual(f.failures, [{
        to: 'FAILED', outcome: 'publication-incomplete', reason: r.reason!.replace('publication incomplete: ', ''),
        found: { number: 1, url: 'https://local.forge/pr/1', headBranch: c.branch, ...h.found },
        expectedBase: 'main', commitSha: r.commitSha, resumed: true,
      }]);
      // The task is closed: a further resume does nothing.
      const again = await resume(c);
      assert.equal(again.stoppedAt, 'not-resumable');
      assert.deepEqual(await c.forge.listPullRequests(), before);
    } finally {
      await cleanup(c);
    }
  });
}

// The reviewer's probe, end to end through the GitHub adapter and its port: the
// pulls API reports the attempt's PR closed — merged or not — after the
// executor died with the PR opened but unrecorded.
interface StoredPr {
  number: number; html_url: string; head: { ref: string }; base: { ref: string };
  title?: string; body?: string; state: 'open' | 'closed'; merged_at: string | null;
}

function githubPulls(opts: { closedBeforeRun?: { merged: boolean } } = {}) {
  const prs: StoredPr[] = [];
  const writes: string[] = [];
  const copy = (pr: StoredPr): StoredPr => structuredClone(pr);
  const octokitFor = (): OctokitLike => ({
    pulls: {
      list: async ({ head }) => {
        const ref = head.replace(/^acme:/, '');
        // A PR for the head that a human closed before this run reached it.
        if (opts.closedBeforeRun && !prs.some((p) => p.head.ref === ref)) {
          prs.push({
            number: prs.length + 1, html_url: `https://github.com/acme/web/pull/${prs.length + 1}`,
            head: { ref }, base: { ref: 'main' }, state: 'closed',
            merged_at: opts.closedBeforeRun.merged ? '2026-10-30T00:00:00Z' : null,
          });
        }
        return { data: prs.filter((p) => p.head.ref === ref).map(copy).reverse() };
      },
      create: async ({ head, base, title, body }) => {
        writes.push('create');
        const pr: StoredPr = {
          number: prs.length + 1, html_url: `https://github.com/acme/web/pull/${prs.length + 1}`,
          head: { ref: head }, base: { ref: base }, title, body, state: 'open', merged_at: null,
        };
        prs.push(pr);
        return { data: { ...copy(pr), merged: false } };
      },
      update: async ({ pull_number, title, body }) => {
        writes.push('update');
        const pr = prs.find((p) => p.number === pull_number)!;
        Object.assign(pr, { title, body });
        return { data: { ...copy(pr), merged: pr.merged_at !== null } };
      },
    },
  });
  return { prs, writes, octokitFor };
}

function githubForge(
  client: SqlClient, local: LocalBareForgeProvider, pulls: ReturnType<typeof githubPulls>, crashAfterPr: boolean,
): ForgeProvider {
  const credentials = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'unused', installationId: 9 },
    async () => ({ token: 'ghs_rehearsal', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  const github = new GitHubAppForgePort(
    new GitHubAppForgeProvider(credentials, pulls.octokitFor, ['github.com']),
    new SqlForgeBindingResolver(new RepositoryBindingRepository(client), {
      localRepoPathFor: () => { throw new Error('PR operations need no local repository'); },
    }),
  );
  let crashPending = crashAfterPr;
  return {
    pushBranch: (scope, input) => local.pushBranch(scope, input),
    resolveRef: (scope, input) => local.resolveRef(scope, input),
    upsertPullRequest: async (scope, input) => {
      const pr = await github.upsertPullRequest(scope, input);
      if (crashPending) {
        crashPending = false;
        throw new SimulatedCrash('executor died after the PR was opened');
      }
      return pr;
    },
    findPullRequest: (scope, input) => github.findPullRequest(scope, input),
  };
}

// The pushes go to a local bare remote; the PRs to the GitHub adapter. The
// binding carries the numeric repository id the forge resolver requires.
async function onGitHub(dir: string) {
  const { mirror, baseSha } = await seedMirror(join(dir, 'seed'));
  const local = new LocalBareForgeProvider(await createBareRemote(join(dir, 'forge.git')));
  const repository = {
    organizationName: 'Acme', projectName: 'web', defaultBranch: 'main',
    binding: {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
      defaultBaseBranch: 'main', githubRepositoryId: 4242,
    },
    mirrorPath: mirror, baseSha,
  };
  return { mirror, local, repository };
}

async function theAttempt(client: SqlClient) {
  const ids = await client.query(
    `select a.id, a.task_id, t.run_id, a.repository_binding_id, a.organization_id, a.project_id, a.base_sha
       from attempts a join tasks t on t.id = a.task_id`,
    [],
  );
  assert.equal(ids.rows.length, 1);
  const row = ids.rows[0]!;
  const runId = row['run_id'] as RunId;
  const taskId = row['task_id'] as TaskId;
  const attemptId = row['id'] as AttemptId;
  return {
    scope: { organizationId: row['organization_id'] as OrganizationId, projectId: row['project_id'] as ProjectId },
    repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
    runId, taskId, attemptId,
    baseSha: row['base_sha'] as string,
    branch: attemptBranch({ runId, taskId, attemptId }),
  };
}

for (const merged of [false, true]) {
  test(`through the GitHub adapter and port, a successor over a PR a human ${merged ? 'merged' : 'closed'} fails the task and writes nothing`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asep-closed-pr-'));
    const client = await PgliteClient.create();
    try {
      await migrate(client);
      const pulls = githubPulls();
      const gh = await onGitHub(dir);
      const sandbox = await fakeDockerSandbox(join(dir, 'sandbox'));
      await assert.rejects(
        () => runVerticalSlice({
          client, sandbox, dir: join(dir, 'run'), checkCommand: checkCommandFor,
          forge: githubForge(client, gh.local, pulls, true),
          onWorkspaceCreated: (p) => gh.local.setWorktree(p),
          repository: gh.repository,
        }),
        SimulatedCrash,
      );
      assert.deepEqual(pulls.writes, ['create'], 'the PR reached GitHub before the executor died');
      // A human closes the PR on GitHub, or merges it.
      Object.assign(pulls.prs[0]!, { state: 'closed', merged_at: merged ? '2026-10-30T00:00:00Z' : null });
      const asLeft = structuredClone(pulls.prs);

      const a = await theAttempt(client);
      const r = await resumeVerticalSlice({
        client, dir: join(dir, 'run'), mirrorPath: gh.mirror, ...a,
        forge: githubForge(client, gh.local, pulls, false),
      });
      assert.equal(r.stoppedAt, 'publication-incomplete', r.reason);
      assert.match(r.reason ?? '', merged ? /PR #1 is merged/ : /PR #1 is closed/);
      assert.equal(r.taskStatus, 'FAILED');
      assert.equal(r.prAdopted, true);
      assert.deepEqual(pulls.writes, ['create'], 'the resume wrote nothing to GitHub');
      assert.deepEqual(pulls.prs, asLeft, 'the PR is exactly as the human left it');
      const f = await failedOnRecord(client, a.taskId, a.attemptId);
      assert.equal(f.status, 'FAILED');
      assert.equal(f.prRows, 0, 'never persisted OPEN');
      assert.equal(f.failures.length, 1);
      assert.deepEqual(f.failures[0]!['found'], {
        number: 1, url: 'https://github.com/acme/web/pull/1', headBranch: a.branch, baseBranch: 'main',
        state: 'closed', merged,
      });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// A fresh run is held to the same rule: when the attempt's head already has a
// PR a human closed, the upsert leaves it closed and the run fails the task.
test('a run whose head branch already has a closed PR fails the task on record and opens nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-closed-pr-run-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const pulls = githubPulls({ closedBeforeRun: { merged: false } });
    const gh = await onGitHub(dir);
    const sandbox = await fakeDockerSandbox(join(dir, 'sandbox'));
    await assert.rejects(
      () => runVerticalSlice({
        client, sandbox, dir: join(dir, 'run'), checkCommand: checkCommandFor,
        forge: githubForge(client, gh.local, pulls, false),
        onWorkspaceCreated: (p) => gh.local.setWorktree(p),
        repository: gh.repository,
      }),
      /completion stopped early at 'upsert-pr': publication incomplete: PR #1 is closed/,
    );
    assert.deepEqual(pulls.writes, [], 'nothing was written to GitHub: no reopen, no edit, no second PR');
    const a = await theAttempt(client);
    const f = await failedOnRecord(client, a.taskId, a.attemptId);
    assert.equal(f.status, 'FAILED');
    assert.equal(f.prRows, 0);
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0]!['outcome'], 'publication-incomplete');
    assert.deepEqual(f.failures[0]!['found'], {
      number: 1, url: 'https://github.com/acme/web/pull/1', headBranch: a.branch, baseBranch: 'main',
      state: 'closed', merged: false,
    });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
