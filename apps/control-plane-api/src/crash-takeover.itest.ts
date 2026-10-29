// AUTHORITATIVE crash-recovery proof: a real crash, a real lease expiry, a real
// takeover — on the integration gate's digest-pinned PostgreSQL.
//
// The executor runs in a CHILD PROCESS that drives the full governed slice
// (real pg.Pool, real Docker sandbox, real git mirror/worktree/remote) and is
// killed with SIGKILL the instant a forge effect lands — no finally block, no
// lease release, no heartbeat, exactly like a node dying. The parent then plays
// the successor:
//
//   1. while the dead executor's lease is still live, the resume is DENIED and
//      touches nothing (it might only be slow);
//   2. once that lease has EXPIRED, the resume acquires the next fencing epoch,
//      takes the unfinished side-effect record over, reconciles it against the
//      remote and converges on exactly one commit, one remote ref and one PR;
//   3. the dead executor's lease can never act again.
//
// The same file is the child: when ASEP_CRASH_EXECUTOR is set it runs the
// crashing executor instead of registering tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  PgPoolClient, migrate, SqlSideEffectLog, SqlWorkspaceLeaseRepository,
} from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit, attemptBranch } from '@asep/git-worktree';
import { seedMirror, createBareRemote, LocalBareForgeProvider } from '@asep/local-doubles';
import {
  SideEffectFencingError, LeaseLostError,
  type CommandSpec, type ForgeProvider, type PullRequestRef,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, RunId, TaskId, AttemptId, OrganizationId, ProjectId,
} from '@asep/contracts';
import { runVerticalSlice, resumeVerticalSlice } from './vertical-slice.js';

// alpine 3.20, digest-pinned (same discipline as scripts/integration/images.mjs).
const ALPINE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

// Short enough that the test waits seconds, long enough to cover the longest
// stretch without a heartbeat (the agent run + the sandbox probe). The use case
// refuses a TTL that does not outlive the agent budget, so the budget is tiny.
const LEASE_TTL_MS = 10_000;
const AGENT_BUDGET = { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 0.05 };

type CrashPoint = 'after-push' | 'after-pr';

interface ChildConfig {
  readonly dir: string;
  readonly organizationName: string;
  readonly crashAt: CrashPoint;
}

function requirePgUrl(): string {
  const url = process.env['ASEP_PG_URL'];
  if (!url || url.trim() === '') {
    throw new Error(
      'ASEP_PG_URL is not set — this suite requires a REAL PostgreSQL backend and must run ' +
        'under the integration gate (scripts/integration/run-integration.mjs). Failing closed.',
    );
  }
  return url;
}

function checkCommand(wtPath: string): CommandSpec {
  return {
    executable: 'sh',
    args: ['-c', `test -f ${wtPath}/feature.txt`],
    cwd: wtPath,
    environmentProfile: 'verification-no-network',
    timeoutMs: 60_000,
    outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
  };
}

// --- the child: an executor that dies the moment its forge effect lands -------

async function runCrashingExecutor(cfg: ChildConfig): Promise<never> {
  const pool = new Pool({ connectionString: requirePgUrl(), max: 4 });
  const client = PgPoolClient.fromPool(pool);
  const seeded = await seedMirror(join(cfg.dir, 'seed'));
  const inner = new LocalBareForgeProvider(join(cfg.dir, 'forge.git'));
  const die = (): never => {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  };
  const forge: ForgeProvider = {
    async pushBranch(scope, input) {
      await inner.pushBranch(scope, input);
      if (cfg.crashAt === 'after-push') die();
    },
    async upsertPullRequest(scope, input): Promise<PullRequestRef> {
      const pr = await inner.upsertPullRequest(scope, input);
      if (cfg.crashAt === 'after-pr') die();
      return pr;
    },
    resolveRef: (scope, input) => inner.resolveRef(scope, input),
    findPullRequest: (scope, input) => inner.findPullRequest(scope, input),
  };
  await runVerticalSlice({
    client,
    sandbox: new DockerSandboxProvider({ imageDigest: ALPINE }),
    dir: join(cfg.dir, 'run'),
    checkCommand,
    repository: {
      organizationName: cfg.organizationName,
      projectName: 'web',
      defaultBranch: 'main',
      binding: {
        githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
        defaultBaseBranch: 'main', githubRepositoryId: 1,
      },
      mirrorPath: seeded.mirror,
      baseSha: seeded.baseSha,
    },
    forge,
    onWorkspaceCreated: (p) => inner.setWorktree(p),
    budget: AGENT_BUDGET,
    leaseTtlMs: LEASE_TTL_MS,
  });
  // Reaching here means the crash point was never hit — the parent treats any
  // ordinary exit as a failure of the scenario.
  await client.close();
  process.exit(3);
}

const childConfig = process.env['ASEP_CRASH_EXECUTOR'];
if (childConfig) {
  await runCrashingExecutor(JSON.parse(childConfig) as ChildConfig);
} else {
  registerTests();
}

// --- the parent: the successor -------------------------------------------------

function spawnExecutor(cfg: ChildConfig): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, ASEP_CRASH_EXECUTOR: JSON.stringify(cfg) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

interface Crashed {
  readonly scope: TenantScope;
  readonly bindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly branch: string;
  readonly deadLease: string;
}

function registerTests(): void {
  console.log('SUITE-ID: asep-suite:crash-takeover-real');

  for (const crashAt of ['after-push', 'after-pr'] as const) {
    test(`a SIGKILLed executor (${crashAt}): the successor waits out its lease, takes over and converges on one commit, one ref, one PR`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'asep-crash-takeover-'));
      const pool = new Pool({ connectionString: requirePgUrl(), max: 4 });
      const client = PgPoolClient.fromPool(pool);
      try {
        await migrate(client);
        await mkdir(join(dir, 'run'), { recursive: true });
        const forgeRemote = await createBareRemote(join(dir, 'forge.git'));
        const organizationName = `crash-${randomUUID()}`;

        // --- the crash -----------------------------------------------------
        const child = await spawnExecutor({ dir, organizationName, crashAt });
        assert.equal(child.signal, 'SIGKILL',
          `the executor must die at the crash point, not exit (code ${child.code}):\n${child.output}`);

        const found = await client.query(
          `select a.id, a.task_id, t.run_id, a.repository_binding_id, a.organization_id,
                  a.project_id, a.base_sha
             from attempts a
             join tasks t on t.id = a.task_id
             join organizations o on o.id = a.organization_id
            where o.name = $1`,
          [organizationName],
        );
        assert.equal(found.rows.length, 1, 'the crashed attempt is in the database');
        const row = found.rows[0]!;
        const runId = row['run_id'] as RunId;
        const taskId = row['task_id'] as TaskId;
        const attemptId = row['id'] as AttemptId;
        const lease = await client.query(
          `select id, fencing_epoch, state from workspace_leases where attempt_id = $1`, [attemptId],
        );
        assert.equal(lease.rows.length, 1);
        const c: Crashed = {
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
        assert.equal(lease.rows[0]!['state'], 'ACTIVE', 'a killed executor never released its lease');
        assert.equal(Number(lease.rows[0]!['fencing_epoch']), 1);

        const pending = crashAt === 'after-push' ? 'push' : 'pr-upsert';
        const recordsOf = async () => (await client.query(
          `select operation, state, owner_lease_id, owner_epoch
             from side_effect_records where attempt_id = $1 order by operation`,
          [attemptId],
        )).rows;
        const crashedRecord = (await recordsOf()).find((r) => r['operation'] === pending)!;
        assert.equal(crashedRecord['state'], 'PENDING', `the ${pending} outcome was never recorded`);
        assert.equal(crashedRecord['owner_lease_id'], c.deadLease);

        const resume = () => resumeVerticalSlice({
          client, dir: join(dir, 'run'), scope: c.scope,
          repositoryBindingId: c.bindingId, runId: c.runId, taskId: c.taskId,
          attemptId: c.attemptId, baseSha: c.baseSha, branch: c.branch,
          remoteBare: forgeRemote, pushFrom: join(dir, 'seed', 'mirror.git'),
        });

        // --- 1. the dead executor's lease is still live: no takeover --------
        const stillLive = await client.query(
          `select expires_at > now() as live from workspace_leases where id = $1`, [c.deadLease],
        );
        assert.equal(stillLive.rows[0]!['live'], true,
          'the test must reach the successor before the TTL lapses');
        const early = await resume();
        assert.equal(early.stoppedAt, 'lease-denied', 'a live lease is never taken over');
        const untouched = (await recordsOf()).find((r) => r['operation'] === pending)!;
        assert.equal(untouched['state'], 'PENDING');
        assert.equal(untouched['owner_lease_id'], c.deadLease);

        // --- 2. wait for the lease to expire, then take over ------------------
        const deadline = Date.now() + LEASE_TTL_MS + 15_000;
        for (;;) {
          const r = await client.query(
            `select expires_at <= now() as expired from workspace_leases where id = $1`, [c.deadLease],
          );
          if (r.rows[0]!['expired'] === true) break;
          assert.ok(Date.now() < deadline, 'the dead lease never expired');
          await new Promise((res) => setTimeout(res, 250));
        }
        const r = await resume();
        assert.equal(r.stoppedAt, 'complete', r.reason);
        assert.equal(r.fencingEpoch, 2, 'the successor holds the next epoch');
        assert.equal(r.pushes, 0, 'the push had landed; the successor never re-pushed');
        assert.equal(r.pushAdopted, true);
        assert.equal(r.prAdopted, crashAt === 'after-pr',
          'a PR that reached the forge is adopted; one that did not is opened once');
        assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');

        // Exactly one commit, one remote ref, one PR.
        const refs = (await runGit(['-C', forgeRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads/']))
          .stdout.split('\n').filter((l) => l.trim() !== '');
        assert.deepEqual(refs, [`refs/heads/${c.branch}`], 'exactly one remote ref');
        const tip = (await runGit(['-C', forgeRemote, 'rev-parse', `refs/heads/${c.branch}`])).stdout.trim();
        assert.equal(tip, r.commitSha, 'the ref points at the recorded harness commit');
        assert.equal(
          (await runGit(['-C', forgeRemote, 'rev-list', '--count', `${c.baseSha}..${tip}`])).stdout.trim(),
          '1', 'exactly one commit on top of the base',
        );
        const prs = await new LocalBareForgeProvider(forgeRemote).listPullRequests();
        assert.equal(prs.length, 1, 'exactly one pull request on the forge');
        const prRows = await client.query(
          `select number from pull_requests where attempt_id = $1`, [c.attemptId],
        );
        assert.equal(prRows.rows.length, 1, 'exactly one persisted PR row');
        assert.equal(Number(prRows.rows[0]!['number']), prs[0]!.number);

        const after = await recordsOf();
        assert.deepEqual(after.map((x) => [x['operation'], x['state']]), [
          ['commit', 'COMPLETED'], ['pr-upsert', 'COMPLETED'], ['push', 'COMPLETED'],
        ]);
        const takenOver = after.find((x) => x['operation'] === pending)!;
        assert.equal(takenOver['owner_lease_id'], r.leaseId, 'the record moved to the successor');
        assert.equal(Number(takenOver['owner_epoch']), 2);
        const attempt = await client.query(
          `select result_sha from attempts where id = $1`, [c.attemptId],
        );
        assert.equal(attempt.rows[0]!['result_sha'], r.commitSha);

        const leases = await client.query(
          `select id, state, fencing_epoch from workspace_leases where attempt_id = $1
            order by fencing_epoch`,
          [c.attemptId],
        );
        assert.deepEqual(
          leases.rows.map((l) => [l['state'], Number(l['fencing_epoch'])]),
          [['EXPIRED', 1], ['RELEASED', 2]],
          'the dead lease was swept; the successor released its own',
        );

        // --- 3. the dead executor is refused for good ------------------------
        await assert.rejects(
          () => new SqlSideEffectLog(client).complete(c.scope, {
            operation: 'push', repositoryBindingId: c.bindingId, attemptId: c.attemptId,
            ownerToken: c.deadLease,
            resultRef: { kind: 'push', branch: c.branch, commitSha: r.commitSha! },
          }),
          SideEffectFencingError,
        );
        await assert.rejects(
          () => new SqlWorkspaceLeaseRepository(client).heartbeat(c.scope, c.deadLease),
          LeaseLostError,
        );
      } finally {
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
