// Faults 3 and 5 of the pilot rehearsal, injected into the governed pipeline.
//
// The persistence rehearsal suite (adapters/persistence/src/pilot-rehearsal.test.ts)
// exercises the database-restart and stale-lease faults against the real
// persistence mechanisms. The object-store outage (fault 3) and GitHub rate
// limiting (fault 5) are injected here into a real run of the vertical slice —
// runVerticalSlice, the governed workflow, the real artifact and evidence
// stores, side-effect log and lease repository, real git — and the runbook's
// decision is followed on the state the run leaves behind.
//
//   Fault 3: the object store disappears once verification has stored its
//   outputs, so the evidence write fails. The attempt stops before the push
//   with nothing published. After the store is restored, the artifacts already
//   written still verify by checksum, and the attempt is NOT resumed: the
//   harness never re-derives evidence it did not persist, so the task is re-run
//   as a new attempt.
//
//   Fault 5: GitHub answers the PR creation with a 403 rate limit, through the
//   real GitHub App adapter — credential handling, the forge port, and the
//   production binding resolver over the registered binding. (Pushes go to a
//   local bare remote: git transport to github.com is not reachable here.) The
//   run stops with the push recorded and the PR upsert pending; after back-off
//   the resume adopts the push, finds no PR, and opens exactly one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore, RepositoryBindingRepository,
  type SqlClient,
} from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit, attemptBranch } from '@asep/git-worktree';
import { createBareRemote, LocalBareForgeProvider } from '@asep/local-doubles';
import {
  GitHubAppCredentialProvider, GitHubAppForgeProvider, GitHubAppForgePort, SqlForgeBindingResolver,
  type OctokitLike,
} from '@asep/github-app';
import type { CommandSpec, ForgeProvider, SandboxProvider } from '@asep/ports';
import type {
  ArtifactId, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId, TenantScope,
} from '@asep/contracts';
import { runVerticalSlice, resumeVerticalSlice, seedMirror } from './vertical-slice.js';

console.log('SUITE-ID: asep-suite:pilot-faults');

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

interface Attempt {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly branch: string;
}

// The one attempt a failed run left behind, read back from the database.
async function theAttempt(client: SqlClient): Promise<Attempt> {
  const r = await client.query(
    `select a.id, a.task_id, t.run_id, a.repository_binding_id, a.organization_id, a.project_id, a.base_sha
       from attempts a join tasks t on t.id = a.task_id`,
    [],
  );
  assert.equal(r.rows.length, 1);
  const row = r.rows[0]!;
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

async function records(client: SqlClient, attemptId: AttemptId): Promise<Array<[string, string]>> {
  const r = await client.query(
    'select operation, state from side_effect_records where attempt_id = $1 order by operation', [attemptId],
  );
  return r.rows.map((row) => [row['operation'] as string, row['state'] as string]);
}

async function count(client: SqlClient, sql: string, params: unknown[]): Promise<number> {
  return (await client.query(sql, params as never[])).rows[0]!['n'] as number;
}

async function remoteRefs(remote: string): Promise<string[]> {
  return (await runGit(['-C', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'])).stdout
    .split('\n').filter((l) => l.trim() !== '');
}

test('fault 3: an object-store outage at the evidence write stops the attempt before anything is published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-fault-objects-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const remote = await createBareRemote(join(dir, 'forge.git'));
    const forge = new LocalBareForgeProvider(remote);
    const objectRoot = join(dir, 'objects');

    // The store goes away right after verification: the governed path stops
    // its verification sandbox twice — once after the isolation probe, once
    // after the checks have run and stored their outputs. The outage replaces
    // the store's root with a plain file, which no write or read gets past.
    const docker = await fakeDockerSandbox(join(dir, 'sandbox'));
    let stops = 0;
    let outage = false;
    const sandbox: SandboxProvider = {
      start: (profile, mount) => docker.start(profile, mount),
      stop: async (handle) => {
        await docker.stop(handle);
        stops += 1;
        if (stops === 2) {
          await rename(objectRoot, `${objectRoot}.down`);
          await writeFile(objectRoot, 'object store unavailable\n');
          outage = true;
        }
      },
    };

    await assert.rejects(
      () => runVerticalSlice({
        client, sandbox, dir: join(dir, 'run'), objectStoreDir: objectRoot, checkCommand: checkCommandFor,
        forge, onWorkspaceCreated: (p) => forge.setWorktree(p),
      }),
      /ENOTDIR|not a directory/,
    );
    assert.equal(outage, true, 'the outage hit after verification, as injected');

    // Nothing was published and the task did not reach review.
    const a = await theAttempt(client);
    assert.deepEqual(await records(client, a.attemptId), [['commit', 'COMPLETED']], 'the commit is local; no push or PR was begun');
    assert.deepEqual(await remoteRefs(remote), [], 'nothing reached the remote');
    assert.equal((await forge.listPullRequests()).length, 0);
    assert.equal(await count(client, 'select count(*)::int as n from pull_requests', []), 0);
    assert.equal(await count(client, `select count(*)::int as n from artifacts where kind = 'evidence-bundle'`, []), 0);
    const task = await client.query('select status from tasks where id = $1', [a.taskId]);
    assert.notEqual(task.rows[0]!['status'], 'WAITING_FOR_HUMAN_REVIEW');

    // Runbook §3.1: restore the store, re-verify what was written by checksum.
    await rm(objectRoot);
    await rename(`${objectRoot}.down`, objectRoot);
    const store = new ContentAddressedArtifactStore(client, new FilesystemObjectStore(objectRoot));
    const written = await client.query(
      'select id, sha256, kind from artifacts where organization_id = $1 and project_id = $2',
      [a.scope.organizationId, a.scope.projectId],
    );
    assert.ok(written.rows.length > 0, 'verification had stored its outputs before the outage');
    for (const row of written.rows) {
      const v = await store.verify(a.scope, {
        artifactId: row['id'] as ArtifactId, sha256: row['sha256'] as string, kind: row['kind'] as string,
      } as never);
      assert.equal(v.ok, true, `artifact ${row['id']} still verifies`);
    }

    // …and the attempt is not resumed: its evidence was never persisted.
    const resumed = await resumeVerticalSlice({
      client, dir: join(dir, 'run'), objectStoreDir: objectRoot, ...a, forge,
    });
    assert.equal(resumed.stoppedAt, 'not-resumable');
    assert.match(resumed.reason ?? '', /no evidence bundle .* re-execute the attempt/);
    assert.deepEqual(await remoteRefs(remote), [], 'still nothing on the remote');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fault 5: a GitHub rate limit on the PR stops the run; after back-off the resume converges on one PR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-fault-ratelimit-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const { mirror, baseSha } = await seedMirror(join(dir, 'seed'));
    const remote = await createBareRemote(join(dir, 'forge.git'));
    const local = new LocalBareForgeProvider(remote);

    // GitHub's PR endpoint, rate-limited until `limited` is cleared.
    const prs: Array<{ number: number; html_url: string; head: { ref: string }; base: { ref: string } }> = [];
    let limited = true;
    let creates = 0;
    const octokitFor = (): OctokitLike => ({
      pulls: {
        list: async ({ head }) => ({ data: prs.filter((pr) => head === `acme:${pr.head.ref}`) }),
        create: async ({ head, base }) => {
          creates += 1;
          if (limited) {
            throw Object.assign(new Error('API rate limit exceeded for installation ID 9.'), {
              status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } },
            });
          }
          const pr = {
            number: prs.length + 1, html_url: `https://github.com/acme/web/pull/${prs.length + 1}`,
            head: { ref: head }, base: { ref: base },
          };
          prs.push(pr);
          return { data: pr };
        },
        update: async ({ pull_number }) => ({ data: prs.find((p) => p.number === pull_number)! }),
      },
    });
    const credentials = new GitHubAppCredentialProvider(
      { appId: 1, privateKey: 'unused', installationId: 9 },
      async () => ({ token: 'ghs_rehearsal', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const github = new GitHubAppForgePort(
      new GitHubAppForgeProvider(credentials, octokitFor, ['github.com']),
      new SqlForgeBindingResolver(new RepositoryBindingRepository(client), {
        localRepoPathFor: () => { throw new Error('PR operations need no local repository'); },
      }),
    );
    const forge: ForgeProvider = {
      pushBranch: (scope, input) => local.pushBranch(scope, input),
      resolveRef: (scope, input) => local.resolveRef(scope, input),
      upsertPullRequest: (scope, input) => github.upsertPullRequest(scope, input),
      findPullRequest: (scope, input) => github.findPullRequest(scope, input),
    };

    const sandbox = await fakeDockerSandbox(join(dir, 'sandbox'));
    await assert.rejects(
      () => runVerticalSlice({
        client,
        sandbox,
        dir: join(dir, 'run'),
        checkCommand: checkCommandFor,
        forge,
        onWorkspaceCreated: (p) => local.setWorktree(p),
        repository: {
          organizationName: 'Acme', projectName: 'web', defaultBranch: 'main',
          binding: {
            githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
            defaultBaseBranch: 'main', githubRepositoryId: 4242,
          },
          mirrorPath: mirror, baseSha,
        },
      }),
      /rate limit/,
    );

    const a = await theAttempt(client);
    assert.equal(creates, 1, 'one PR creation was attempted and refused');
    assert.deepEqual(await records(client, a.attemptId), [
      ['commit', 'COMPLETED'], ['pr-upsert', 'PENDING'], ['push', 'COMPLETED'],
    ]);
    assert.deepEqual(await remoteRefs(remote), [`refs/heads/${a.branch}`], 'the push landed');
    assert.equal(prs.length, 0);
    assert.equal(await count(client, 'select count(*)::int as n from pull_requests', []), 0);

    // Runbook §3.3: back off, then let the idempotent retry converge.
    limited = false;
    const resumed = await resumeVerticalSlice({ client, dir: join(dir, 'run'), ...a, forge });
    assert.equal(resumed.stoppedAt, 'complete', resumed.reason);
    assert.equal(resumed.pushAdopted, true, 'the recorded push was adopted, not repeated');
    assert.equal(resumed.prAdopted, false, 'no PR existed, so the resume opened it');
    assert.equal(resumed.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    assert.equal(local.pushes, 1, 'exactly one push in total');
    assert.equal(creates, 2);
    assert.equal(prs.length, 1, 'exactly one pull request');
    assert.equal(await count(client, 'select count(*)::int as n from pull_requests where attempt_id = $1', [a.attemptId]), 1);
    assert.deepEqual(await records(client, a.attemptId), [
      ['commit', 'COMPLETED'], ['pr-upsert', 'COMPLETED'], ['push', 'COMPLETED'],
    ]);

    // A late duplicate retry adopts the recorded PR.
    const again = await resumeVerticalSlice({ client, dir: join(dir, 'run'), ...a, forge });
    assert.equal(again.stoppedAt, 'complete');
    assert.equal(again.prAdopted, true);
    assert.equal(creates, 2, 'no further creation');
    assert.equal(prs.length, 1);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
