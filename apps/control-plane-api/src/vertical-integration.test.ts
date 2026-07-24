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
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PgliteClient, migrate,
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository, SqlWorkspaceLeaseRepository,
  ContentAddressedArtifactStore, FilesystemObjectStore,
  ContentAddressedEvidenceStore, SqlSideEffectLog,
} from '@asep/persistence';
import {
  GitWorktreeManager, runGit, attemptBranch, safeRefspecFor,
} from '@asep/git-worktree';
import { TrustedCommandRunner, LocalUnsandboxedProvider } from '@asep/command-runner';
import {
  admissionStep, agentStep, inspectStep, completeToReview,
  type VerificationCheckSpec,
} from '@asep/application';
import type {
  ArtifactStore, ForgeProvider, PullRequestRef, CodingAgentProvider,
  AgentExecuteRequest, AgentAttemptObservation, CommandSpec,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, AttemptId,
} from '@asep/contracts';
import type { TaskAggregate } from '@asep/domain';

console.log('SUITE-ID: asep-suite:vertical-integration');

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

// Fake GitHub: a REAL push to a local bare remote (pushing the exact commit SHA
// to the safe ASEP-namespaced ref — a detached worktree has no local branch to
// push) + an in-memory idempotent PR upsert. NO merge capability exists.
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
    expectedRemoteSha?: string;
  }): Promise<void> {
    // Validate the branch through the same non-bypassable ref-safety policy the
    // real adapter uses — a protected/malformed target is unrepresentable.
    const safe = safeRefspecFor(input.branch, input.expectedRemoteSha);
    // Push the EXACT commit SHA to the remote branch (works from detached HEAD).
    await runGit(['-C', this.worktreePath, 'push', this.remoteBarePath,
      `${input.commitSha}:refs/heads/${safe.branch}`]);
    this.pushes++;
  }

  async upsertPullRequest(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const existing = this.prs.get(input.headBranch);
    if (existing) return existing; // idempotent: no duplicate PR
    const pr: PullRequestRef = {
      number: ++this.prCounter,
      url: `https://local.forge/pr/${this.prCounter}`,
      headBranch: input.headBranch,
      baseBranch: input.base,
    };
    this.prs.set(input.headBranch, pr);
    return pr;
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
    const sandbox = new LocalUnsandboxedProvider();
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
      identity: { name: 'ASEP Bot', email: 'bot@asep.local' },
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
      title: 'ASEP: add feature.txt',
      body: 'Automated attempt reaching human review.',
      leaseId: lease.leaseId,
      task: taskAggregate,
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
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
