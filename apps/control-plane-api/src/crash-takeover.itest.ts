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
// The executor is killed at three points: after its push landed, after its PR
// was opened, and after its harness commit landed in git but before the commit
// was recorded — where the successor must adopt that commit, never mint a
// second one.
//
// The same file is the child: when ASEP_CRASH_EXECUTOR is set it runs the
// crashing executor instead of registering tests.
//
// It also proves the IN-FLIGHT race on the same PostgreSQL: an executor that is
// not dead but paused — between begin() and its forge call, or inside the call
// — while its lease lapses and a successor takes its records over. Paused
// before its call, it is refused at its confirmation. Paused inside it, it
// still reaches the forge — nothing recalls a call in flight, and GitHub has no
// compare-and-set for a PR update — so what holds is what it can write: its PR
// update writes the content of the attempt's facts, byte-identical to the
// successor's; its late push of the attempt's commit changes nothing, and a
// late push of any other commit is refused by the push's compare-and-set. It
// can never record any of it.

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
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
  type SqlClient, type SqlExecutor,
} from '@asep/persistence';
import { pushStep, upsertPrStep, pullRequestFactsOf } from '@asep/application';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit, attemptBranch } from '@asep/git-worktree';
import { seedMirror, createBareRemote, LocalBareForgeProvider } from '@asep/local-doubles';
import {
  SideEffectFencingError, LeaseLostError, pullRequestContent,
  type CommandSpec, type ForgeProvider, type PullRequestRef, type SideEffectLog, type Lease,
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

type CrashPoint = 'after-push' | 'after-pr' | 'at-commit-record';

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

// The executor's database connection, through which it dies as it is about to
// record its harness commit — the commit has already landed in git.
function dyingAtCommitRecord(client: SqlClient, die: () => never): SqlClient {
  const guard = (db: SqlExecutor): SqlExecutor => ({
    query: (text, params) => {
      if (/update side_effect_records\s+set state/.test(text)
        && params?.includes('commit') && params.includes('COMPLETED')) die();
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

async function runCrashingExecutor(cfg: ChildConfig): Promise<never> {
  const pool = new Pool({ connectionString: requirePgUrl(), max: 4 });
  const die = (): never => {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  };
  const pooled = PgPoolClient.fromPool(pool);
  const client = cfg.crashAt === 'at-commit-record' ? dyingAtCommitRecord(pooled, die) : pooled;
  const seeded = await seedMirror(join(cfg.dir, 'seed'));
  const inner = new LocalBareForgeProvider(join(cfg.dir, 'forge.git'));
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
    updatePullRequestContent: (scope, input) => inner.updatePullRequestContent(scope, input),
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

  for (const crashAt of ['after-push', 'after-pr', 'at-commit-record'] as const) {
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

        const pending = crashAt === 'after-push' ? 'push' : crashAt === 'after-pr' ? 'pr-upsert' : 'commit';
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

        // The harness commit is in git, recorded under the attempt, whatever the
        // record says.
        const mirror = join(dir, 'seed', 'mirror.git');
        const landed = (await runGit(['--git-dir', mirror, 'rev-parse', `refs/asep/attempts/${c.attemptId}`]))
          .stdout.trim();
        assert.match(landed, /^[0-9a-f]{40}$/);

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
        assert.equal(r.commitSha, landed, 'the commit that landed is the one recorded and published');
        if (crashAt === 'at-commit-record') {
          assert.equal(r.pushes, 1, 'nothing had been pushed; the successor pushed once');
          assert.equal(r.pushAdopted, false);
        } else {
          assert.equal(r.pushes, 0, 'the push had landed; the successor never re-pushed');
          assert.equal(r.pushAdopted, true);
        }
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

  // Bounded: a regression that never reaches a pause point must fail, not hang.
  test('a paused executor cannot act after a successor took its records over (in-flight race)', { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asep-inflight-'));
    const pool = new Pool({ connectionString: requirePgUrl(), max: 6 });
    const client = PgPoolClient.fromPool(pool);
    try {
      await migrate(client);
      const seeded = await seedMirror(join(dir, 'seed'));
      const remote = await createBareRemote(join(dir, 'forge.git'));
      const forge = new LocalBareForgeProvider(remote);
      forge.setWorktree(seeded.mirror);

      // Attempts as the governed path registers them, one per scenario.
      const org = await new OrganizationRepository(client).create({ name: `inflight-${randomUUID()}` });
      const project = await new ProjectRepository(client).create({
        organizationId: org.id, name: 'web', defaultBranch: 'main',
      });
      const scope: TenantScope = { organizationId: org.id, projectId: project.id };
      const binding = await new RepositoryBindingRepository(client).create(scope, {
        githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
      });
      const run = await new RunRepository(client).create(scope, {
        repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
      });
      const commitSha = seeded.baseSha;
      const log = new SqlSideEffectLog(client);
      const leases = new SqlWorkspaceLeaseRepository(client);
      const TTL = 1_500;
      const freshAttempt = async () => {
        const task = await new TaskRepository(client).create(scope, {
          runId: run.id, repositoryBindingId: binding.id, risk: 'R0',
        });
        const attempt = await new AttemptRepository(client).create(scope, {
          taskId: task.id, repositoryBindingId: binding.id,
        });
        const branch = attemptBranch({ runId: run.id, taskId: task.id, attemptId: attempt.id });
        const lease = async (): Promise<Lease> => {
          const l = await leases.acquire(scope, {
            repositoryBindingId: binding.id, branch, attemptId: attempt.id, ttlMs: TTL,
          });
          if ('denied' in l) throw new Error(`lease denied: ${l.reason}`);
          return l;
        };
        return {
          branch, lease, taskId: task.id,
          common: { scope, repositoryBindingId: binding.id, attemptId: attempt.id },
        };
      };
      const waitOut = async (leaseId: string) => {
        for (const deadline = Date.now() + TTL + 10_000; ;) {
          const r = await client.query(
            'select expires_at <= clock_timestamp() as expired from workspace_leases where id = $1', [leaseId]);
          if (r.rows[0]!['expired'] === true) return;
          assert.ok(Date.now() < deadline, 'the paused executor\'s lease never lapsed');
          await new Promise((res) => setTimeout(res, 100));
        }
      };
      const gate = () => {
        let open!: () => void;
        const opened = new Promise<void>((res) => { open = res; });
        return { open, opened };
      };
      let zombieForgeCalls = 0;
      const countingForge: ForgeProvider = {
        pushBranch: async (sc, i) => { zombieForgeCalls += 1; return forge.pushBranch(sc, i); },
        upsertPullRequest: async (sc, i) => { zombieForgeCalls += 1; return forge.upsertPullRequest(sc, i); },
        updatePullRequestContent: async (sc, i) => { zombieForgeCalls += 1; return forge.updatePullRequestContent(sc, i); },
        resolveRef: (sc, i) => forge.resolveRef(sc, i),
        findPullRequest: (sc, i) => forge.findPullRequest(sc, i),
      };

      // --- 1. paused between begin() and its push: refused at the confirmation.
      {
        const a = await freshAttempt();
        const zombie = await a.lease();
        const resume = gate();
        const paused = gate();
        const pausedLog: SideEffectLog = {
          begin: (sc, i) => log.begin(sc, i),
          complete: (sc, i) => log.complete(sc, i),
          fail: (sc, i) => log.fail(sc, i),
          find: (sc, k) => log.find(sc, k),
          confirmOwner: async (sc, i) => { paused.open(); await resume.opened; return log.confirmOwner(sc, i); },
        };
        const zombiePush = pushStep({
          ...a.common, forge: countingForge, log: pausedLog, branch: a.branch, commitSha, leaseId: zombie.leaseId,
        });
        await paused.opened;
        await waitOut(zombie.leaseId);
        const successor = await a.lease();
        assert.equal(successor.fencingEpoch, zombie.fencingEpoch + 1);
        const pushed = await pushStep({ ...a.common, forge, log, branch: a.branch, commitSha, leaseId: successor.leaseId });
        assert.equal(pushed.pushed, true, 'the successor pushed');
        resume.open();
        await assert.rejects(zombiePush, SideEffectFencingError);
        assert.equal(zombieForgeCalls, 0, 'the paused executor never reached the forge');
      }

      // --- 2. paused INSIDE its PR call, past its renewed lease: it still writes
      // the PR after the successor, and what it writes is the successor's PR,
      // byte for byte, because both write the content of the attempt's facts.
      {
        const a = await freshAttempt();
        const zombie = await a.lease();
        const resume = gate();
        const paused = gate();
        const pr = {
          taskId: a.taskId, headBranch: a.branch, base: 'main', commitSha, evidenceId: 'E'.repeat(26),
        };
        const zombiePr = upsertPrStep({
          ...a.common, ...pr, log, leaseId: zombie.leaseId,
          forge: {
            ...countingForge,
            upsertPullRequest: async (sc, i) => {
              paused.open();
              await resume.opened;
              zombieForgeCalls += 1;
              return forge.upsertPullRequest(sc, i);
            },
          },
        });
        await paused.opened;
        await waitOut(zombie.leaseId);
        const successor = await a.lease();
        const opened = await upsertPrStep({ ...a.common, ...pr, forge, log, leaseId: successor.leaseId });
        assert.equal(opened.adopted, false, 'nothing had reached the forge; the successor opened the PR');
        const ofBranch = async () => (await forge.listPullRequests()).filter((p) => p.headBranch === a.branch);
        const successors = JSON.stringify(await ofBranch());
        const calls = zombieForgeCalls;
        resume.open();
        await assert.rejects(zombiePr, SideEffectFencingError, 'the late executor cannot record its PR');
        assert.equal(zombieForgeCalls, calls + 1, 'the late executor did reach the forge');
        const prs = await ofBranch();
        assert.equal(JSON.stringify(prs), successors, 'its late write left the successor\'s PR byte for byte');
        assert.equal(prs.length, 1, 'one PR');
        const content = pullRequestContent(pullRequestFactsOf({ ...a.common, ...pr }));
        assert.equal(prs[0]!.title, content.title);
        assert.equal(prs[0]!.body, content.body);
        const record = await log.find(scope, { operation: 'pr-upsert', ...a.common });
        assert.equal(record?.ownerToken, successor.leaseId);
      }

      // --- 3. paused INSIDE its push call, past its renewed lease: a late push
      // of the attempt's commit changes nothing, and its record stays the
      // successor's.
      type PushCall = Parameters<ForgeProvider['pushBranch']>[1];
      const pausedPush = async (late: (i: PushCall) => PushCall) => {
        const a = await freshAttempt();
        const zombie = await a.lease();
        const resume = gate();
        const paused = gate();
        const zombiePush = pushStep({
          ...a.common, log, branch: a.branch, commitSha, leaseId: zombie.leaseId,
          forge: {
            ...countingForge,
            pushBranch: async (sc, i) => { paused.open(); await resume.opened; return forge.pushBranch(sc, late(i)); },
          },
        });
        await paused.opened;
        await waitOut(zombie.leaseId);
        const successor = await a.lease();
        await pushStep({ ...a.common, forge, log, branch: a.branch, commitSha, leaseId: successor.leaseId });
        resume.open();
        const tip = async () => (await runGit(['-C', remote, 'rev-parse', `refs/heads/${a.branch}`])).stdout.trim();
        return { a, successor, zombiePush, tip };
      };
      {
        const { a, successor, zombiePush, tip } = await pausedPush((i) => i);
        await assert.rejects(zombiePush, SideEffectFencingError, 'the late executor cannot record its push');
        assert.equal(await tip(), commitSha, 'the branch still holds the attempt\'s one commit');
        const record = await log.find(scope, { operation: 'push', ...a.common });
        assert.equal(record?.state, 'COMPLETED');
        assert.equal(record?.ownerToken, successor.leaseId);
      }

      // --- 4. the same, but the late push carries another commit: the remote
      // refuses it, because the branch no longer holds what the push expects.
      {
        const other = (await runGit([
          '--git-dir', seeded.mirror, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit-tree', `${commitSha}^{tree}`, '-m', 'not the attempt\'s',
        ])).stdout.trim();
        assert.match(other, /^[0-9a-f]{40}$/);
        const { a, successor, zombiePush, tip } = await pausedPush((i) => ({ ...i, commitSha: other }));
        await assert.rejects(zombiePush, /stale info/, 'the remote refuses the late push');
        assert.equal(await tip(), commitSha, 'the branch still holds the attempt\'s one commit');
        const record = await log.find(scope, { operation: 'push', ...a.common });
        assert.equal(record?.state, 'COMPLETED');
        assert.equal(record?.ownerToken, successor.leaseId);
      }
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
