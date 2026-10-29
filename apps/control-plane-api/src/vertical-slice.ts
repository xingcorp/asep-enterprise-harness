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
import { GitWorktreeManager, attemptBranch } from '@asep/git-worktree';
// The local doubles (fake Claude / fake GitHub / synthetic mirror) live in an
// ADAPTER package, not here: they are port implementations that spawn git, and a
// composition root that does that is doing adapter work (B2/B5, disp.
// P2-FINAL-MED-004). This root only wires them.
import {
  seedMirror, createBareRemote, FileWritingAgent, LocalBareForgeProvider,
} from '@asep/local-doubles';
import { TrustedCommandRunner } from '@asep/command-runner';
import {
  runVerticalSliceWorkflow, resumeAttemptToReview, leaseTtlForBudget,
  type SliceWorkspaceBackend, type ResumeAttemptResult,
} from '@asep/application';
import type {
  ForgeProvider, PullRequestRef, CodingAgentProvider, SandboxProvider,
  AgentExecuteRequest, AgentAttemptObservation, CommandSpec, ArtifactStore, ToolPolicyProfile,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, AttemptId, TaskId, RunId, ArtifactId,
  WorkspaceId, Budget,
} from '@asep/contracts';

// The local doubles (seedMirror / FileWritingAgent / LocalBareForgeProvider) now
// live in @asep/local-doubles. They are PORT IMPLEMENTATIONS and they drive git,
// neither of which belongs in a composition root (B2/B5, disp. P2-FINAL-MED-004).
// `seedMirror` is re-exported because both K1 proofs import it from this module.
export { seedMirror, FileWritingAgent, LocalBareForgeProvider } from '@asep/local-doubles';


export interface VerticalSliceInput {
  readonly client: SqlClient;
  // Injected sandbox. It must enforce OS isolation: the use case refuses, before
  // any side effect, a provider whose handle does not claim it (exit E8). There
  // is no override.
  readonly sandbox: SandboxProvider;
  // Temp directory the root builds the mirror / worktrees / objects under.
  readonly dir: string;
  // Builds the two mandatory R0 verification commands for the worktree path.
  // Injected because the command must be runnable in whatever execution context
  // the sandbox provides (host git vs. a minimal container image).
  readonly checkCommand: (wtPath: string) => CommandSpec;

  // --- PRODUCTION SEAMS (disp. P2-FINAL-HIGH-008) ---------------------------
  // The review's finding: this driver hard-coded FileWritingAgent and
  // LocalBareForgeProvider, so supplying real credentials could never produce a
  // live task-to-PR run — the real Claude / GitHub App adapters were unreachable
  // from the only driver that exists. These two seams close that: a production
  // root injects the real adapters, and the governed sequence above is byte-for-
  // byte the same one the two K1 proofs exercise.
  //
  // agentFor is a FACTORY over the registered TenantScope because the Claude
  // adapter is scope-bound (it writes its raw event stream as a scoped
  // artifact), and the scope does not exist until the workflow has registered
  // the org + project. It also receives the artifact store the slice built, so
  // the adapter persists into the SAME store the evidence chain resolves
  // against.
  readonly agentFor?: (ctx: {
    scope: TenantScope;
    artifacts: ArtifactStore;
    worktreePathOf: (workspaceId: WorkspaceId) => string;
  }) => CodingAgentProvider;
  // A real ForgeProvider (e.g. GitHubAppForgePort). Omitted → the local bare-repo
  // double, which performs a REAL git push to a local remote.
  readonly forge?: ForgeProvider;

  // --- REAL REPOSITORY TARGET (disp. P2-FINAL-HIGH-008, exit K2) -------------
  // The residual finding after the entrypoint landed: injecting the real Claude
  // and GitHub App adapters was still not enough to produce a LIVE task→PR run,
  // because this driver always called `seedMirror(dir)` and always registered the
  // binding as the literal `acme/web` on `github.com`. So a pilot with real
  // credentials would push a synthetic seed commit to a repository that does not
  // exist, and `SqlForgeBindingResolver` would in any case refuse the binding:
  // the workflow never persisted `github_repository_id`, so every resolve threw
  // ForgeBindingIncompleteError before the first API call.
  //
  // ABSENT keeps the synthetic behaviour byte-for-byte, so both K1 proofs are
  // unchanged. PRESENT means: register THIS tenancy + THIS GitHub repository
  // (including the numeric id the forge adapter requires) and attempt against a
  // mirror the caller already cloned, at a base SHA that really exists there.
  readonly repository?: {
    readonly organizationName: string;
    readonly projectName: string;
    readonly defaultBranch: string;
    readonly binding: {
      readonly githubHost: string;
      readonly githubOwner: string;
      readonly githubRepo: string;
      readonly defaultBaseBranch: string;
      // REQUIRED here (optional on the repository row) precisely because the
      // forge resolver fails closed without it.
      readonly githubRepositoryId: number;
    };
    // A bare mirror of the real remote, and a base commit that exists in it.
    readonly mirrorPath: string;
    readonly baseSha: string;
  };

  // Published the moment the workflow creates the leased worktree. The forge
  // adapter locates the harness commit through `localRepoPathFor`, which a
  // production root must wire to the REAL worktree — a path that does not exist
  // until this driver has run. Without this seam the pilot could only pass the
  // temp root, and `git push` would run in a directory holding no commit.
  readonly onWorkspaceCreated?: (workspacePath: string) => void;

  // The task to actually perform. ABSENT keeps the synthetic 'add feature.txt'
  // work order (both K1 proofs). PRESENT matters for a live run because the
  // workflow FAILS CLOSED when trusted inspection does not observe
  // `expectChangedFile` — so a real agent doing real work against a hard-coded
  // 'feature.txt' expectation could only ever be reported as a failed attempt.
  readonly work?: {
    readonly objective: string;
    readonly contextPack: Readonly<Record<string, unknown>>;
    readonly allowedPaths: readonly string[];
    readonly expectChangedFile: string;
    readonly prTitle: string;
    readonly prBody: string;
  };

  // Provenance recorded in the evidence bundle. ABSENT uses the synthetic
  // placeholder digests the proofs assert on. A live run MUST pass its real
  // digests: the bundle is the audit record, and baking 'sha256:eee…' into it
  // would make evidence from a real attempt claim an image that never ran.
  readonly environment?: {
    readonly imageDigest: string;
    readonly lockfileHash: string;
    readonly nodeVersion: string;
  };

  // The agent budget, and the lease TTL derived from it. ABSENT keeps the
  // defaults below. A crash-recovery proof passes a tiny budget so the lease it
  // abandons expires in seconds rather than minutes; the use case refuses any
  // TTL that would not outlive the agent's wall clock.
  readonly budget?: Budget;
  readonly leaseTtlMs?: number;

  // What the agent may do. ABSENT keeps the local double's policy. A live run
  // passes the Claude provider's policy: that provider runs only under
  // 'restricted-egress' (the model API through its egress proxy) and refuses a
  // policy it cannot honour before anything starts.
  readonly toolPolicy?: ToolPolicyProfile;
}

const DEFAULT_BUDGET: Budget = { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 };

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

  // --- Git target: the caller's REAL mirror, or a synthetic seed -------------
  // With `repository` absent this is byte-for-byte the previous behaviour (both
  // K1 proofs), so the seeded mirror stays the default. With it present the
  // attempt runs against a mirror of the real remote at a base SHA that exists
  // there — the difference between a rehearsal and a live run (HIGH-008/K2).
  const target = input.repository
    ? { mirror: input.repository.mirrorPath, baseSha: input.repository.baseSha }
    : await seedMirror(dir);
  const { mirror, baseSha } = target;
  // Only meaningful for the local double. A real forge pushes to the actual
  // remote, so this bare repo is created but never used on that path.
  const remoteBare = await createBareRemote(join(dir, 'remote.git'));

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

  // The local doubles are the DEFAULT, not the only option (HIGH-008). When a
  // production root injects `agentFor` / `forge`, the real adapters run through
  // the identical governed sequence below.
  const localAgent = new FileWritingAgent();
  const localForge = new LocalBareForgeProvider(remoteBare);
  const forge: ForgeProvider = input.forge ?? localForge;
  const usingLocalAgent = input.agentFor === undefined;
  const usingLocalForge = input.forge === undefined;

  const workspaceRoot = join(dir, 'wt');
  await mkdir(workspaceRoot, { recursive: true });
  const realWorkspaceRoot = await realpath(workspaceRoot);

  // The workflow creates the workspace; capture its path here so a production
  // agent factory (agentFor) can resolve it via worktreePathOf. The local
  // doubles instead receive it through their setWorktree seam (a path the ports
  // deliberately do not carry). Exactly one mechanism is active per run.
  let createdWorktreePath: string | null = null;
  const worktreePathOf = (_workspaceId: WorkspaceId): string => {
    if (createdWorktreePath === null) throw new Error('worktree not created yet');
    return createdWorktreePath;
  };

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
        // Publish the real path: production adapters resolve it via
        // worktreePathOf; the local doubles need it pushed in (their ports do
        // not carry a filesystem path). Guarded so a real ForgeProvider — which
        // has no setWorktree — is never called with a method it does not declare.
        createdWorktreePath = p;
        if (usingLocalAgent) localAgent.setWorktree(p);
        if (usingLocalForge) localForge.setWorktree(p);
        // A real forge adapter has no setWorktree: it locates the harness commit
        // through its own localRepoPathFor. That resolver needs the leased
        // worktree path, which does not exist until this moment — so publish it.
        input.onWorkspaceCreated?.(p);
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
    // Tenancy + the repository this attempt targets. The literals are the
    // SYNTHETIC default (both K1 proofs); a pilot passes `repository` and the
    // attempt registers the real owner/repo plus the numeric id the forge
    // resolver requires (HIGH-008/K2).
    organizationName: input.repository?.organizationName ?? 'Acme',
    projectName: input.repository?.projectName ?? 'web',
    defaultBranch: input.repository?.defaultBranch ?? 'main',
    binding: input.repository?.binding ?? {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
      defaultBaseBranch: 'main',
    },
    risk: 'R0',
    baseSha,
    leaseTtlMs: input.leaseTtlMs ?? leaseTtlForBudget(input.budget ?? DEFAULT_BUDGET),
    budget: input.budget ?? DEFAULT_BUDGET,
    toolPolicy: input.toolPolicy ?? {
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
    // Agent injection (HIGH-008): a production root passes `agentFor`, resolved
    // here into the workflow's scope-bound `providerFor` factory so the real
    // Claude adapter is constructed with the registered scope + artifact store +
    // the created worktree path. Absent it, the local double drives the sequence.
    ...(input.agentFor
      ? {
          providerFor: ({ scope }: { scope: TenantScope }): CodingAgentProvider =>
            input.agentFor!({ scope, artifacts, worktreePathOf }),
        }
      : { provider: localAgent }),
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
    // The work order. Synthetic by default (both K1 proofs assert on
    // 'feature.txt'); a pilot passes `work` so the attempt describes the real
    // objective AND the post-hoc trusted-inspection check expects the file the
    // real agent was actually asked to touch.
    workOrder: { objective: input.work?.objective ?? 'add feature.txt' },
    contextPack: input.work?.contextPack ?? { relevantFiles: ['feature.txt'] },
    allowedPaths: input.work?.allowedPaths ?? ['feature.txt'],
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    // Placeholder digests are fine for a proof asserting on fixed bytes, but a
    // live attempt must record what really ran — the bundle is the audit record.
    environment: input.environment ?? {
      imageDigest: 'sha256:' + 'e'.repeat(64),
      lockfileHash: 'f'.repeat(64),
      nodeVersion: process.version,
    },
    prTitle: input.work?.prTitle ?? 'ASEP: add feature.txt',
    prBody: input.work?.prBody ?? 'Automated attempt reaching human review.',
    expectChangedFile: input.work?.expectChangedFile ?? 'feature.txt',
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
    // The local double counts pushes for the seam test's idempotency assertion;
    // a real ForgeProvider does not expose a counter through the port.
    pushes: usingLocalForge ? localForge.pushes : 0,
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

// ---------------------------------------------------------------------------
// Crash recovery: resume an attempt under a NEW lease.
//
// Same discipline as runVerticalSlice — construct the adapters, call ONE
// application use case, map the result. The use case takes the attempt's lease
// (denied while the crashed executor's lease is still live), takes over its
// unfinished side-effect records, reconciles each against the forge and
// performs only what did not land.
// ---------------------------------------------------------------------------

export interface ResumeVerticalSliceInput {
  readonly client: SqlClient;
  // The directory the crashed run used: its object store holds the evidence.
  readonly dir: string;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly branch: string;
  readonly base?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly leaseTtlMs?: number;
  // A real ForgeProvider, or — absent — the local bare-repo double pushing from
  // `pushFrom` (the bare mirror the crashed run's worktrees shared, which holds
  // the harness commit object) into `remoteBare`.
  readonly forge?: ForgeProvider;
  readonly remoteBare?: string;
  readonly pushFrom?: string;
}

export interface ResumeVerticalSliceResult extends ResumeAttemptResult {
  readonly pushes: number;
}

export async function resumeVerticalSlice(
  input: ResumeVerticalSliceInput,
): Promise<ResumeVerticalSliceResult> {
  const { client } = input;
  const objects = new FilesystemObjectStore(join(input.dir, 'objects'));
  const evidenceStore = new ContentAddressedEvidenceStore(client, objects);

  let localForge: LocalBareForgeProvider | null = null;
  let forge: ForgeProvider;
  if (input.forge) {
    forge = input.forge;
  } else {
    if (!input.remoteBare || !input.pushFrom) {
      throw new Error('resumeVerticalSlice: pass a forge, or remoteBare + pushFrom for the local double');
    }
    localForge = new LocalBareForgeProvider(input.remoteBare);
    localForge.setWorktree(input.pushFrom);
    forge = localForge;
  }

  const outcome = await resumeAttemptToReview({
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    branch: input.branch,
    base: input.base ?? 'main',
    title: input.prTitle ?? 'ASEP: add feature.txt',
    body: input.prBody ?? 'Automated attempt reaching human review.',
    leaseTtlMs: input.leaseTtlMs ?? 60_000,
    leases: new SqlWorkspaceLeaseRepository(client),
    sideEffects: new SqlSideEffectLog(client),
    evidence: evidenceStore,
    forge,
    repositories: {
      attempts: new AttemptRepository(client),
      tasks: new TaskRepository(client),
      pullRequests: new PullRequestRepository(client),
    },
    audit: new SqlAuditSink(client),
    actor: 'harness',
  });
  return { ...outcome, pushes: localForge ? localForge.pushes : 0 };
}
