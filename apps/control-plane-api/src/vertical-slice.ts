// K1 vertical-slice COMPOSITION ROOT (disp. P2-FINAL-HIGH-002 / HIGH-008 /
// MED-004).
//
// This file is a composition root and NOTHING else. It constructs concrete
// adapters (repositories, artifact/evidence stores, the side-effect log, the Git
// worktree manager, the tracer + audit sink) and hands them to the APPLICATION
// use case `runVerticalSliceWorkflow`, which owns the entire governed sequence.
//
// The MED-004 regression was that an earlier revision of this file held the
// sequencing itself AND called persistence repositories directly
// (runs.create(), tasks.create(), attempts.attachEvidence(), prs.upsert(), …)
// from apps/* — a B2/B5 violation. All of that orchestration now lives in
// packages/application/src/vertical-slice-workflow.ts. What remains here is
// wiring: `new X(...)`, then one call to the use case, then a result mapping.
//
// Both proofs drive this same root, so the governed sequence cannot drift:
//
//   apps/control-plane-api/src/vertical-integration.test.ts   (fast seam test:
//       in-process PGlite + an explicitly-labelled unsandboxed TEST DOUBLE)
//   apps/control-plane-api/src/vertical-slice.itest.ts        (AUTHORITATIVE
//       proof under the integration gate: real digest-pinned PostgreSQL via
//       pg.Pool + a real DockerSandboxProvider with OS-enforced isolation)

import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository, SqlWorkspaceLeaseRepository,
  ContentAddressedArtifactStore, FilesystemObjectStore,
  ContentAddressedEvidenceStore, SqlSideEffectLog, PullRequestRepository,
  SqlAuditSink,
  type SqlClient,
} from '@asep/persistence';
import {
  SpanTracer, CapturingTelemetrySink, type CapturedEvent,
} from '@asep/observability';
import {
  GitWorktreeManager, runGit, attemptBranch, safeRefspecFor,
} from '@asep/git-worktree';
import { TrustedCommandRunner } from '@asep/command-runner';
import {
  runVerticalSliceWorkflow, type SliceWorkspaceBackend,
} from '@asep/application';
import type {
  ForgeProvider, PullRequestRef, CodingAgentProvider, SandboxProvider,
  AgentExecuteRequest, AgentAttemptObservation, CommandSpec,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, AttemptId, TaskId, RunId, ArtifactId,
  WorkspaceId,
} from '@asep/contracts';

/** Seed a REAL bare mirror with a base commit; return { mirror, baseSha }. */
export async function seedMirror(dir: string): Promise<{ mirror: string; baseSha: string }> {
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

/**
 * Fake Claude: genuinely MUTATES the worktree (writes a file), then returns an
 * UNTRUSTED self-report only. The harness derives every real fact afterwards via
 * trusted inspection. The worktree path is discovered lazily so the agent can be
 * constructed before the workspace exists (the workflow creates the workspace).
 */
export class FileWritingAgent implements CodingAgentProvider {
  readonly providerId = 'fake-claude';
  private worktreePath: string | null = null;
  setWorktree(path: string): void { this.worktreePath = path; }
  async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
    if (this.worktreePath === null) throw new Error('worktree path not wired');
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

/**
 * Fake GitHub: a REAL `git push` to a local bare remote (pushing the exact
 * commit SHA to the safe ASEP-namespaced ref — a detached worktree has no local
 * branch to push) + an in-memory idempotent PR upsert. NO merge capability
 * exists on the port, so a merge is unrepresentable.
 */
export class LocalBareForgeProvider implements ForgeProvider {
  pushes = 0;
  private readonly prs = new Map<string, PullRequestRef>();
  private prCounter = 0;
  private worktreePath: string | null = null;
  constructor(private readonly remoteBarePath: string) {}
  setWorktree(path: string): void { this.worktreePath = path; }

  async pushBranch(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha?: string;
  }): Promise<void> {
    if (this.worktreePath === null) throw new Error('worktree path not wired');
    // Validate through the same non-bypassable ref-safety policy the real
    // adapter uses — a protected/malformed target is unrepresentable.
    const safe = safeRefspecFor(input.branch, input.expectedRemoteSha);
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

export interface VerticalSliceInput {
  readonly client: SqlClient;
  // Injected sandbox: a real DockerSandboxProvider under the integration gate,
  // an explicitly-labelled unsandboxed double in the fast seam test.
  readonly sandbox: SandboxProvider;
  // Temp directory the root builds the mirror / worktrees / objects under.
  readonly dir: string;
  // Builds the two mandatory R0 verification commands for the worktree path.
  // Injected because the command must be runnable in whatever execution context
  // the sandbox provides (host git vs. a minimal container image).
  readonly checkCommand: (wtPath: string) => CommandSpec;
}

export interface VerticalSliceResult {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly branch: string;
  readonly baseSha: string;
  readonly wtPath: string;
  readonly remoteBare: string;
  readonly commitSha: string;
  // Branded, so a caller can pass it straight to a scoped store lookup
  // (evidenceStore.getEvidence) without an unsafe cast at the call site.
  readonly evidenceArtifactId: ArtifactId;
  readonly evidenceSha256: string;
  readonly prNumber: number;
  readonly prHeadBranch: string;
  readonly prBaseBranch: string;
  readonly pushes: number;
  readonly stoppedAt: string;
  readonly taskStatus: string;
  readonly sandboxIsolationEnforced: boolean;
  // MED-003: the spans this run ACTUALLY emitted through the tracer. Exposed so
  // a caller asserts on real emission (and on real `audit_events` rows in
  // PostgreSQL) rather than on the mere existence of instrumentation code.
  readonly emittedSpans: readonly CapturedEvent[];
  // Live handles so a caller can assert on real persisted rows afterwards.
  readonly repos: {
    readonly runs: RunRepository;
    readonly tasks: TaskRepository;
    readonly attempts: AttemptRepository;
    readonly prs: PullRequestRepository;
    readonly evidenceStore: ContentAddressedEvidenceStore;
  };
}

/**
 * Wire the concrete adapters and run the vertical-slice WORKFLOW use case. The
 * governed sequence itself lives in @asep/application — this function performs
 * no domain decision and no persistence call of its own.
 */
export async function runVerticalSlice(input: VerticalSliceInput): Promise<VerticalSliceResult> {
  const { client, dir } = input;

  // --- real Git: bare mirror + a base commit --------------------------------
  const { mirror, baseSha } = await seedMirror(dir);
  const remoteBare = join(dir, 'remote.git');
  await runGit(['init', '--bare', '-q', remoteBare]);

  // --- concrete adapters (construction only) --------------------------------
  const runsRepo = new RunRepository(client);
  const tasksRepo = new TaskRepository(client);
  const attemptsRepo = new AttemptRepository(client);
  const prsRepo = new PullRequestRepository(client);
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  const artifacts = new ContentAddressedArtifactStore(client, objects);
  const evidenceStore = new ContentAddressedEvidenceStore(client, objects);

  const telemetry = new CapturingTelemetrySink();
  const tracer = new SpanTracer(telemetry);

  const agent = new FileWritingAgent();
  const forge = new LocalBareForgeProvider(remoteBare);

  const workspaceRoot = join(dir, 'wt');
  await mkdir(workspaceRoot, { recursive: true });
  const realWorkspaceRoot = await realpath(workspaceRoot);

  // The Git backend is per repository binding, and the binding id only exists
  // once the use case has registered it — so the root supplies a FACTORY. The
  // create() wrapper publishes the real worktree path to the agent + forge
  // doubles, which need a filesystem path the ports deliberately do not carry.
  const workspaceBackend = (ctx: {
    scope: TenantScope; repositoryBindingId: RepositoryBindingId;
  }): SliceWorkspaceBackend => {
    const manager = new GitWorktreeManager(
      {
        workspaceRoot,
        mirrorPath: mirror,
        repositoryBindingId: ctx.repositoryBindingId,
      },
      artifacts,
    );
    const pathOf = (workspaceId: WorkspaceId): string =>
      resolve(join(realWorkspaceRoot, ctx.repositoryBindingId, workspaceId));
    const workspaces = {
      create: async (s: TenantScope, i: {
        repositoryBindingId: RepositoryBindingId; baseSha: string; leaseId: string;
      }) => {
        const ws = await manager.create(s, i);
        const p = pathOf(ws.workspaceId);
        agent.setWorktree(p);
        forge.setWorktree(p);
        return ws;
      },
      cleanup: (s: TenantScope, id: WorkspaceId) => manager.cleanup(s, id),
      quarantine: (s: TenantScope, id: WorkspaceId, reason: string) =>
        manager.quarantine(s, id, reason),
    };
    return { workspaces, inspector: manager, committer: manager, pathOf };
  };

  // --- one call to the APPLICATION use case ---------------------------------
  const outcome = await runVerticalSliceWorkflow({
    organizationName: 'Acme',
    projectName: 'web',
    defaultBranch: 'main',
    binding: {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
      defaultBaseBranch: 'main',
    },
    risk: 'R0',
    baseSha,
    leaseTtlMs: 60_000,
    budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 },
    toolPolicy: {
      allowedTools: ['write'], disallowedTools: ['network'], networkProfile: 'no-network',
    },
    signal: new AbortController().signal,
    repositories: {
      organizations: new OrganizationRepository(client),
      projects: new ProjectRepository(client),
      bindings: new RepositoryBindingRepository(client),
      runs: runsRepo,
      tasks: tasksRepo,
      attempts: attemptsRepo,
      pullRequests: prsRepo,
    },
    artifacts,
    evidence: evidenceStore,
    sideEffects: new SqlSideEffectLog(client),
    leases: new SqlWorkspaceLeaseRepository(client),
    provider: agent,
    // Scope-aware adapter: built with the REAL tenant scope the use case
    // registered, never a placeholder.
    runnerFor: ({ scope }) => new TrustedCommandRunner(scope, artifacts),
    sandbox: input.sandbox,
    forge,
    tracer,
    audit: new SqlAuditSink(client),
    actor: 'harness',
    branchFor: attemptBranch,
    workspaceBackend,
    checkCommand: input.checkCommand,
    workOrder: { objective: 'add feature.txt' },
    contextPack: { relevantFiles: ['feature.txt'] },
    allowedPaths: ['feature.txt'],
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    environment: {
      imageDigest: 'sha256:' + 'e'.repeat(64),
      lockfileHash: 'f'.repeat(64),
      nodeVersion: process.version,
    },
    prTitle: 'ASEP: add feature.txt',
    prBody: 'Automated attempt reaching human review.',
    expectChangedFile: 'feature.txt',
  });

  return {
    scope: outcome.scope,
    repositoryBindingId: outcome.repositoryBindingId,
    runId: outcome.runId,
    taskId: outcome.taskId,
    attemptId: outcome.attemptId,
    branch: outcome.branch,
    baseSha: outcome.baseSha,
    wtPath: outcome.workspacePath,
    remoteBare,
    commitSha: outcome.commitSha,
    evidenceArtifactId: outcome.evidenceArtifactId,
    evidenceSha256: outcome.evidenceSha256,
    prNumber: outcome.prNumber,
    prHeadBranch: outcome.prHeadBranch,
    prBaseBranch: outcome.prBaseBranch,
    pushes: forge.pushes,
    stoppedAt: outcome.stoppedAt,
    taskStatus: outcome.taskStatus,
    sandboxIsolationEnforced: outcome.sandboxIsolationEnforced,
    emittedSpans: telemetry.events,
    repos: {
      runs: runsRepo,
      tasks: tasksRepo,
      attempts: attemptsRepo,
      prs: prsRepo,
      evidenceStore,
    },
  };
}
