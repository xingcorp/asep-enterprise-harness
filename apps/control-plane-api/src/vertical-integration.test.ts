// Full vertical integration test (exit criterion K1). This is NOT a mocked
// pipeline: it wires the REAL adapters end to end —
//   - real PostgreSQL engine (in-process PGlite: genuine DDL, composite FKs,
//     transactions);
//   - real temp Git: a bare MIRROR seeded with a base commit + a real linked
//     WORKTREE checked out at the pinned base SHA;
//   - real content-addressed artifact store (PGlite metadata + filesystem bytes);
//   - real preallocated-id EvidenceStore + real two-phase SideEffectLog;
//   - real TrustedCommandRunner executing an actual `git status` verification
//     command as argv (shell:false) into immutable artifacts;
//   - real harness GitCommitter creating the commit with ASEP trailers;
//   - a fake Claude that genuinely MUTATES the worktree (writes a file), and a
//     fake GitHub that performs a REAL `git push` to a local bare remote and
//     tracks PRs in memory (the two opt-in-live boundaries, per K1: "fake Claude
//     + fake GitHub").
//
// It drives the governed sequence admission → agent → inspect → verify → commit
// → evidence → push → PR → WAITING_FOR_HUMAN_REVIEW and asserts the trust
// invariants hold on real state: resultSha == the harness commit SHA (D8), the
// pushed ref in the remote points at that exact commit, the evidence bundle
// round-trips, the commit carries the preallocated evidence id in its
// ASEP-Evidence trailer, and the full PR → evidence → attempt → task → run
// traceability chain resolves (K3).
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  PgliteClient, migrate,
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository, SqlWorkspaceLeaseRepository,
  ContentAddressedArtifactStore, FilesystemObjectStore,
  ContentAddressedEvidenceStore, SqlSideEffectLog, PullRequestRepository,
} from '@asep/persistence';
import {
  GitWorktreeManager, runGit, attemptBranch, safeRefspecFor, safeCommitRefspecFor, pushLeaseFor,
} from '@asep/git-worktree';
import {
  TrustedCommandRunner, DockerSandboxProvider, LocalUnsandboxedProvider, SandboxHandleNotProvenError,
  type SandboxHandleEx,
} from '@asep/command-runner';
import {
  admissionStep, agentStep, inspectStep, completeToReview, SandboxIsolationRequiredError,
  type VerificationCheckSpec,
} from '@asep/application';
import type {
  ArtifactStore, ForgeProvider, PullRequestRef, CodingAgentProvider,
  AgentExecuteRequest, AgentAttemptObservation, CommandSpec, SandboxProvider,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, AttemptId,
} from '@asep/contracts';
import type { TaskAggregate } from '@asep/domain';
import { runVerticalSlice } from './vertical-slice.js';

console.log('SUITE-ID: asep-suite:vertical-integration');

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

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Seed a REAL bare mirror with a base commit; return { mirror, baseSha }.
async function seedMirror(dir: string): Promise<{ mirror: string; baseSha: string }> {
  const upstream = join(dir, 'upstream');
  await mkdir(upstream, { recursive: true });
  await runGit(['-C', upstream, 'init', '-q', '-b', 'main']);
  await writeFile(join(upstream, 'README.md'), '# seed\n');
  await runGit(['-C', upstream, 'add', '-A']);
  await runGit(['-C', upstream, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com',
    'commit', '-m', 'seed']);
  const baseSha = (await runGit(['-C', upstream, 'rev-parse', 'HEAD'])).stdout.trim();
  const mirror = join(dir, 'mirror.git');
  await runGit(['clone', '--bare', '-q', upstream, mirror]);
  return { mirror, baseSha };
}

// Fake Claude: genuinely mutates the worktree (writes a file), then returns an
// UNTRUSTED self-report only. The harness derives the real facts afterward.
class FileWritingAgent implements CodingAgentProvider {
  readonly providerId = 'fake-claude';
  constructor(private readonly worktreePath: string) {}
  async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
    await writeFile(join(this.worktreePath, 'feature.txt'), 'implemented by the agent\n');
    return {
      status: 'AGENT_DONE',
      summary: `wrote feature.txt for ${req.workOrderRef.artifactId}`,
      knownLimitations: [],
      providerSessionId: `fake-session-${req.attemptId}`,
      usage: { inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1 },
      eventArtifactRefs: [],
    };
  }
}

// Fake GitHub: a REAL compare-and-set push to a local bare remote (pushing the
// exact commit SHA to the safe ASEP-namespaced ref — a detached worktree has no
// local branch to push) + an in-memory idempotent PR upsert that keeps what it
// is given. NO merge capability exists.
class LocalBareForgeProvider implements ForgeProvider {
  pushes = 0;
  private readonly prs = new Map<string, PullRequestRef>();
  private prCounter = 0;
  constructor(
    private readonly worktreePath: string,
    private readonly remoteBarePath: string,
  ) {}

  async pushBranch(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha: string | null;
  }): Promise<void> {
    // Validate the branch through the same non-bypassable ref-safety policy the
    // real adapter uses — a protected/malformed target is unrepresentable.
    const safe = safeCommitRefspecFor(input.commitSha, input.branch);
    // Push the EXACT commit SHA to the remote branch (works from detached HEAD),
    // only over the value the branch is expected to hold.
    await runGit(['-C', this.worktreePath, 'push', pushLeaseFor(safe.branch, input.expectedRemoteSha),
      this.remoteBarePath, safe.refspec]);
    this.pushes++;
  }

  async upsertPullRequest(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    // Idempotent: the one PR for the head branch is updated, never duplicated.
    const existing = this.prs.get(input.headBranch);
    const pr: PullRequestRef = {
      number: existing?.number ?? ++this.prCounter,
      url: existing?.url ?? `https://local.forge/pr/${this.prCounter}`,
      headBranch: input.headBranch,
      baseBranch: input.base,
      title: input.title,
      body: input.body,
    };
    this.prs.set(input.headBranch, pr);
    return pr;
  }

  // Crash-recovery reconciliation (HIGH-006): read-only lookups against the REAL
  // bare remote / the in-memory PR table, so the pipeline can tell "the effect
  // landed" from "it never ran" without re-pushing or re-opening.
  async resolveRef(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
  }): Promise<string | null> {
    const safe = safeRefspecFor(input.branch);
    const res = await runGit(
      ['ls-remote', '--', this.remoteBarePath, `refs/heads/${safe.branch}`],
      { allowNonZero: true },
    );
    const line = res.stdout.trim();
    if (line === '') return null;
    const sha = line.split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async findPullRequest(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
  }): Promise<PullRequestRef | null> {
    return this.prs.get(input.headBranch) ?? null;
  }
}

async function artifactStoreFor(client: PgliteClient, objectsDir: string): Promise<ArtifactStore> {
  const objects = new FilesystemObjectStore(objectsDir);
  return new ContentAddressedArtifactStore(client, objects);
}

test('K1: full vertical slice reaches WAITING_FOR_HUMAN_REVIEW with a real PR + evidence chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-vertical-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);

    // --- real Git: bare mirror + a base commit ------------------------------
    const { mirror, baseSha } = await seedMirror(dir);
    const remoteBare = join(dir, 'remote.git');
    await runGit(['init', '--bare', '-q', remoteBare]);

    // --- real persistence: full tenancy + run/task/attempt chain ------------
    const orgs = new OrganizationRepository(client);
    const projects = new ProjectRepository(client);
    const bindings = new RepositoryBindingRepository(client);
    const runs = new RunRepository(client);
    const tasks = new TaskRepository(client);
    const attempts = new AttemptRepository(client);
    const leases = new SqlWorkspaceLeaseRepository(client);

    const org = await orgs.create({ name: 'Acme' });
    const proj = await projects.create({ organizationId: org.id, name: 'web', defaultBranch: 'main' });
    const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
    const binding = await bindings.create(scope, {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
    });
    const run = await runs.create(scope, { repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0' });
    const task = await tasks.create(scope, { runId: run.id, repositoryBindingId: binding.id, risk: 'R0', baseSha });
    const attempt = await attempts.create(scope, { taskId: task.id, repositoryBindingId: binding.id, baseSha });

    // --- real artifact store + the S9 evidence store + side-effect log ------
    const artifacts = await artifactStoreFor(client, join(dir, 'objects'));
    const objects = new FilesystemObjectStore(join(dir, 'objects'));
    const evidenceStore = new ContentAddressedEvidenceStore(client, objects);
    const sideEffectLog = new SqlSideEffectLog(client);

    // --- real worktree manager: create a worktree pinned at the base SHA ----
    const workspaceRoot = join(dir, 'wt');
    await mkdir(workspaceRoot, { recursive: true });
    const manager = new GitWorktreeManager(
      { workspaceRoot, mirrorPath: mirror, repositoryBindingId: binding.id },
      artifacts,
    );
    const branch = attemptBranch({ runId: run.id, taskId: task.id, attemptId: attempt.id });
    const lease = await leases.acquire(scope, {
      repositoryBindingId: binding.id, branch, attemptId: attempt.id, ttlMs: 60_000,
    });
    assert.ok('leaseId' in lease, 'lease must be granted');
    const ws = await manager.create(scope, {
      repositoryBindingId: binding.id, baseSha, leaseId: lease.leaseId,
    });
    // Reconstruct the contained worktree path (the fake agent/forge need it).
    const wtPath = resolve(join(await realpath(workspaceRoot), binding.id, ws.workspaceId));

    // --- store a real work-order + context-pack artifact --------------------
    const woBytes = new TextEncoder().encode(JSON.stringify({ objective: 'add feature.txt' }));
    const workOrderRef = await artifacts.put(scope, {
      kind: 'work-order', content: woBytes, sha256: sha256Hex(woBytes), contentType: 'application/json',
    });
    const cpBytes = new TextEncoder().encode(JSON.stringify({ relevantFiles: ['feature.txt'] }));
    const contextPackRef = await artifacts.put(scope, {
      kind: 'context-pack', content: cpBytes, sha256: sha256Hex(cpBytes), contentType: 'application/json',
    });

    // --- STEP 1: admission (R0 is admitted for automation) ------------------
    const admission = admissionStep('R0');
    assert.equal(admission.status, 'OK');

    // --- STEP 2: agent (real workspace mutation, untrusted self-report) -----
    const agent = await agentStep({
      provider: new FileWritingAgent(wtPath),
      attemptId: attempt.id,
      workOrderRef,
      contextPackRef,
      workspace: ws.capability,
      budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 },
      toolPolicy: { allowedTools: ['write'], disallowedTools: ['network'], networkProfile: 'no-network' },
      signal: new AbortController().signal,
    });
    assert.equal(agent.status, 'OK');

    // --- STEP 3: trusted inspection (harness-derived facts) -----------------
    const inspect = await inspectStep({ inspector: manager, scope, workspace: ws.capability });
    assert.equal(inspect.status, 'OK', 'clean worktree, agent did not overstep');
    assert.ok(inspect.change.changedFiles.includes('feature.txt'), 'the agent-written file is observed');

    // --- STEPS 4-9: verify → commit → evidence → push → PR → review ---------
    const runner = new TrustedCommandRunner(scope, artifacts);
    const sandbox = await fakeDockerSandbox(join(dir, 'sandbox'));
    const forge = new LocalBareForgeProvider(wtPath, remoteBare);

    const statusCheck = (id: string): CommandSpec => ({
      executable: 'git',
      args: ['status', '--porcelain'],
      cwd: wtPath,
      environmentProfile: 'verification-no-network',
      timeoutMs: 60_000,
      outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
    });
    // R0 mandates [L0, L1]; one real passing command per mandatory level.
    const checks: VerificationCheckSpec[] = [
      { id: 'L0-workspace', level: 'L0', category: 'workspace', mandatory: true, command: statusCheck('L0') },
      { id: 'L1-static', level: 'L1', category: 'static', mandatory: true, command: statusCheck('L1') },
    ];

    const taskAggregate: TaskAggregate = { id: task.id, status: 'VERIFYING', version: task.version };

    const result = await completeToReview({
      change: inspect.change,
      baseSha,
      runner,
      sandbox,
      mount: { workspaceId: ws.workspaceId, readOnlyPaths: [], writablePaths: [wtPath] },
      planId: 'plan-R0',
      risk: 'R0',
      checks,
      committer: manager,
      scope,
      workspace: ws.capability,
      allowedPaths: ['feature.txt'],
      identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
      store: evidenceStore,
      taskId: task.id,
      attemptId: attempt.id,
      environment: {
        imageDigest: 'sha256:' + 'e'.repeat(64),
        lockfileHash: 'f'.repeat(64),
        nodeVersion: process.version,
      },
      forge,
      log: sideEffectLog,
      repositoryBindingId: binding.id,
      branch,
      base: 'main',
      leaseId: lease.leaseId,
      task: taskAggregate,
    });

    // --- persist the AUTHORITATIVE transitions (HIGH-008) -------------------
    // The driver produced the trusted facts; now persist them so I1/K3 are
    // asserted on real DB rows, not transient objects. resultSha is the harness
    // commit SHA; the evidence ref is attached to the attempt via the scoped
    // composite FK; the task advances to the harness ceiling; the PR row is
    // upserted carrying the scoped evidence ref.
    const prs = new PullRequestRepository(client);
    let attemptVersion = attempt.version;
    attemptVersion = await attempts.setResultSha(scope, attempt.id, attemptVersion, result.commitSha!);
    attemptVersion = await attempts.attachEvidence(scope, attempt.id, attemptVersion, result.evidence!.ref);
    await tasks.updateStatus(scope, task.id, task.version, 'WAITING_FOR_HUMAN_REVIEW');
    const prRow = await prs.upsert(scope, {
      repositoryBindingId: binding.id,
      attemptId: attempt.id,
      forge: 'github',
      number: result.pr!.number,
      headBranch: result.pr!.headBranch,
      baseBranch: result.pr!.baseBranch,
      url: result.pr!.url,
      state: 'OPEN',
      evidenceRef: result.evidence!.ref,
    });

    // --- assert the whole slice landed on real state ------------------------
    assert.equal(result.stoppedAt, 'complete', 'the pipeline reached the review gate');
    assert.equal(result.task?.status, 'WAITING_FOR_HUMAN_REVIEW', 'harness ceiling (I1/I2)');
    assert.match(result.commitSha ?? '', /^[0-9a-f]{40}$/, 'a real harness commit SHA');

    // D8: resultSha == the harness commit SHA (never provider-reported).
    assert.equal(result.evidence?.bundle.resultSha, result.commitSha, 'D8: resultSha is the commit SHA');

    // The commit carries the preallocated evidence id in its ASEP-Evidence trailer.
    const commitMsg = (await runGit(['-C', wtPath, 'log', '-1', '--format=%B'])).stdout;
    assert.ok(commitMsg.includes('ASEP-Attempt:'), 'commit carries the attempt trailer');
    assert.ok(commitMsg.includes(`ASEP-Evidence: ${result.evidence?.ref.artifactId}`),
      'commit embeds the preallocated evidence id');

    // The push produced exactly one ref in the REAL remote, pointing at the commit.
    assert.equal(forge.pushes, 1, 'exactly one push');
    const remoteSha = (await runGit(['-C', remoteBare, 'rev-parse', `refs/heads/${branch}`])).stdout.trim();
    assert.equal(remoteSha, result.commitSha, 'the remote ref points at the harness commit');

    // A real PR exists (no merge was ever attempted — the port has no merge method).
    assert.ok((result.pr?.number ?? 0) >= 1, 'a PR was opened');
    assert.equal(result.pr?.headBranch, branch);
    assert.equal(result.pr?.baseBranch, 'main');

    // K3: full traceability PR → evidence → attempt → task → run resolves on
    // real persisted state.
    const evidenceBack = await evidenceStore.getEvidence(scope, result.evidence!.ref.artifactId);
    assert.equal(evidenceBack.attemptId, attempt.id, 'evidence → attempt');
    assert.equal(evidenceBack.taskId, task.id, 'evidence → task');
    const attemptRow = await attempts.getScoped(scope, attempt.id as AttemptId);
    assert.equal(attemptRow.taskId, task.id, 'attempt → task');
    const taskRow = await tasks.getScoped(scope, task.id);
    assert.equal(taskRow.runId, run.id, 'task → run');
    const runRow = await runs.getScoped(scope, run.id);
    assert.equal(runRow.repositoryBindingId, binding.id, 'run → repository binding');

    // HIGH-008: the authoritative transitions are PERSISTED, not transient.
    // result_sha is the harness commit SHA on the attempt row.
    assert.equal(attemptRow.resultSha, result.commitSha, 'attempt.result_sha == harness commit SHA (D8, persisted)');
    // The attempt's evidence link resolves to the real evidence artifact, in scope.
    assert.equal(attemptRow.evidenceArtifactId, result.evidence!.ref.artifactId, 'attempt → evidence artifact (persisted)');
    assert.equal(attemptRow.evidenceSha256, result.evidence!.ref.sha256, 'attempt evidence sha256 pinned (persisted)');
    // The task landed on the harness ceiling in the DB (I1/I2).
    assert.equal(taskRow.status, 'WAITING_FOR_HUMAN_REVIEW', 'task.status persisted at the harness ceiling');
    // The PR row persists PR → evidence and PR → attempt on real state.
    const prBack = await prs.getByBranch(scope, binding.id, branch);
    assert.equal(prBack.id, prRow.id, 'the PR row round-trips');
    assert.equal(prBack.number, result.pr!.number, 'PR number persisted');
    assert.equal(prBack.attemptId, attempt.id, 'PR → attempt (persisted)');
    assert.equal(prBack.evidenceArtifactId, result.evidence!.ref.artifactId, 'PR → evidence artifact (persisted)');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The governed driver refuses a sandbox that does not claim OS isolation BEFORE
// its first side effect: nothing is committed, recorded, pushed or opened. Two
// shapes: the honest host provider (claims `false`) and a handle that says
// nothing at all. No input to the driver relaxes this.
const unclaimedSandboxes: ReadonlyArray<readonly [string, () => SandboxProvider]> = [
  ['the honest host provider', () => new LocalUnsandboxedProvider()],
  ['a provider whose handle is silent about isolation', () => ({
    start: async (profile) => ({ sandboxId: 'silent', profile }),
    stop: async () => undefined,
  })],
];

for (const [label, make] of unclaimedSandboxes) {
  test(`the vertical slice refuses ${label} before any side effect`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asep-unclaimed-sandbox-'));
    const client = await PgliteClient.create();
    try {
      await migrate(client);
      const inner = make();
      const starts: string[] = [];
      const sandbox: SandboxProvider = {
        start: async (profile, mount) => { starts.push(profile); return inner.start(profile, mount); },
        stop: (h) => inner.stop(h),
      };
      const forgeCalls: string[] = [];
      const forge: ForgeProvider = {
        pushBranch: async () => { forgeCalls.push('push'); },
        upsertPullRequest: async () => { forgeCalls.push('pr'); throw new Error('must not be reached'); },
        resolveRef: async () => { forgeCalls.push('resolve'); return null; },
        findPullRequest: async () => { forgeCalls.push('find'); return null; },
      };
      await assert.rejects(
        () => runVerticalSlice({
          client,
          sandbox,
          dir: join(dir, 'run'),
          checkCommand: (wtPath) => ({
            executable: 'git', args: ['-C', wtPath, 'status', '--porcelain'], cwd: wtPath,
            environmentProfile: 'verification-no-network', timeoutMs: 60_000,
            outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
          }),
          forge,
        }),
        SandboxIsolationRequiredError,
      );
      assert.deepEqual(starts, ['verification-no-network'],
        'refused at the first probe, before any verification command is started');
      assert.deepEqual(forgeCalls, [], 'the forge was never called');
      const count = async (sql: string) => (await client.query(sql, [])).rows[0]!['n'];
      assert.equal(await count('select count(*)::int as n from side_effect_records'), 0, 'no side effect was recorded');
      assert.equal(await count('select count(*)::int as n from pull_requests'), 0, 'no pull request row');
      assert.equal(await count('select count(*)::int as n from attempts where result_sha is not null'), 0,
        'no attempt carries a result commit');
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// A provider that hands the governed path an object rest of a genuine Docker
// handle keeps `isolationEnforced: true` but drops what puts a command in a
// container. The claim gets it past the use case's refusal; the runner then
// refuses the copy, because it was not made by a sandbox provider, so the
// check never runs — not on the host, not anywhere — and nothing is committed,
// recorded, pushed or opened.
test('the vertical slice refuses a handle stripped down to its isolation claim, and runs nothing on the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-stripped-handle-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const docker = await fakeDockerSandbox(join(dir, 'sandbox'));
    const sandbox: SandboxProvider = {
      start: async (profile, mount) => {
        const { runFlags: _flags, image: _image, ...handle } = (await docker.start(profile, mount)) as SandboxHandleEx;
        return handle;
      },
      stop: (h) => docker.stop(h),
    };
    const marker = join(dir, 'host-canary');
    const forgeCalls: string[] = [];
    const forge: ForgeProvider = {
      pushBranch: async () => { forgeCalls.push('push'); },
      upsertPullRequest: async () => { forgeCalls.push('pr'); throw new Error('must not be reached'); },
      resolveRef: async () => { forgeCalls.push('resolve'); return null; },
      findPullRequest: async () => { forgeCalls.push('find'); return null; },
    };
    await assert.rejects(
      () => runVerticalSlice({
        client,
        sandbox,
        dir: join(dir, 'run'),
        checkCommand: (wtPath) => ({
          executable: 'node',
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'HOST_EXECUTION')`],
          cwd: wtPath,
          environmentProfile: 'verification-no-network', timeoutMs: 60_000,
          outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
        }),
        forge,
      }),
      SandboxHandleNotProvenError,
    );
    assert.equal(existsSync(marker), false, 'the verification command ran on the host');
    const invocations = existsSync(join(dir, 'sandbox', 'docker-state', 'invocations.jsonl'))
      ? (await readFile(join(dir, 'sandbox', 'docker-state', 'invocations.jsonl'), 'utf8')).trim().split('\n')
        .map((l) => (JSON.parse(l) as { argv?: string[] }).argv ?? [])
      : [];
    assert.deepEqual(invocations.filter((a) => a[0] === 'run'), [], 'and no container was started for it either');
    assert.deepEqual(forgeCalls, [], 'the forge was never called');
    const count = async (sql: string) => (await client.query(sql, [])).rows[0]!['n'];
    assert.equal(await count('select count(*)::int as n from side_effect_records'), 0, 'no side effect was recorded');
    assert.equal(await count('select count(*)::int as n from pull_requests'), 0, 'no pull request row');
    assert.equal(await count('select count(*)::int as n from attempts where result_sha is not null'), 0,
      'no attempt carries a result commit');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The run's authoritative rows name the work order and context pack the agent
// was actually handed: the task carries its WorkOrder and the attempt its
// context pack, each as a scoped artifact reference whose checksum and kind the
// database checked against the artifact the workflow wrote.
test('the vertical slice attaches the WorkOrder to its task and the context pack to its attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-attached-inputs-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const r = await runVerticalSlice({
      client,
      sandbox: await fakeDockerSandbox(join(dir, 'sandbox')),
      dir: join(dir, 'run'),
      checkCommand: (wtPath) => ({
        executable: 'git', args: ['-C', wtPath, 'status', '--porcelain'], cwd: wtPath,
        environmentProfile: 'verification-no-network', timeoutMs: 60_000,
        outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
      }),
    });
    assert.equal(r.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    const task = await client.query(
      `select t.work_order_artifact_id, t.work_order_sha256, a.kind, a.sha256
         from tasks t join artifacts a on a.id = t.work_order_artifact_id where t.id = $1`, [r.taskId]);
    assert.equal(task.rowCount, 1, 'the task names its work order');
    assert.equal(task.rows[0]!['kind'], 'work-order');
    assert.equal(task.rows[0]!['work_order_sha256'], task.rows[0]!['sha256']);
    const attempt = await client.query(
      `select a.kind, a.sha256, t.context_pack_sha256
         from attempts t join artifacts a on a.id = t.context_pack_artifact_id where t.id = $1`, [r.attemptId]);
    assert.equal(attempt.rowCount, 1, 'the attempt names its context pack');
    assert.equal(attempt.rows[0]!['kind'], 'context-pack');
    assert.equal(attempt.rows[0]!['context_pack_sha256'], attempt.rows[0]!['sha256']);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
