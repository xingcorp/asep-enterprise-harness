// Shared K1 vertical-slice driver (disp. P2-FINAL-HIGH-002 / HIGH-008).
//
// ONE code path for the full governed slice, driven by BOTH proofs:
//
//   apps/control-plane-api/src/vertical-integration.test.ts   (fast seam test:
//       in-process PGlite + an explicitly-labelled unsandboxed TEST DOUBLE)
//   apps/control-plane-api/src/vertical-slice.itest.ts        (AUTHORITATIVE
//       proof under the integration gate: real digest-pinned PostgreSQL via
//       pg.Pool + a real DockerSandboxProvider with OS-enforced isolation)
//
// The review's HIGH-002 finding was that the K1 slice ran the verification
// commands through LocalUnsandboxedProvider — i.e. straight on the host — so the
// end-to-end proof never exercised a real sandbox. HIGH-008 added that the K1
// test hand-assembled its own private path instead of calling a real driver.
// Extracting the slice here fixes both: the sandbox provider and the SQL client
// are injected, so the SAME driver that the fast test exercises is the one proven
// against a real container + real PostgreSQL. Nothing about the sequence can
// drift between the two.
//
// The driver owns the whole governed sequence on real state:
//   admission (BEFORE any side effect) → lease → worktree → agent → trusted
//   inspection → verify → commit → evidence → push → PR → WAITING_FOR_HUMAN_REVIEW
// then PERSISTS the authoritative transitions (attempt.result_sha, the scoped
// evidence attachment, task status, the PR row) so I1/K3 are asserted on DB rows
// rather than transient objects.

import { createHash } from 'node:crypto';
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
  governedExecution, completeToReview, type VerificationCheckSpec,
} from '@asep/application';
import type {
  ForgeProvider, PullRequestRef, CodingAgentProvider, SandboxProvider,
  AgentExecuteRequest, AgentAttemptObservation, CommandSpec,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, AttemptId, TaskId, RunId, ArtifactId,
} from '@asep/contracts';
import type { TaskAggregate } from '@asep/domain';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

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
 * constructed before the workspace exists (the driver creates the workspace).
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
  // Temp directory the driver builds the mirror / worktrees / objects under.
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
  // MED-003: the spans this run ACTUALLY emitted through the tracer, and the
  // audit sink the rows were written to. Exposed so a caller asserts on real
  // emission (and on real `audit_events` rows in PostgreSQL) rather than on the
  // mere existence of instrumentation code.
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
 * Drive the FULL governed vertical slice on real state and persist every
 * authoritative transition. Throws if any step stops short of the review gate,
 * so a caller's assertions run only on a slice that genuinely completed.
 */
export async function runVerticalSlice(input: VerticalSliceInput): Promise<VerticalSliceResult> {
  const { client, dir } = input;

  // --- real Git: bare mirror + a base commit --------------------------------
  const { mirror, baseSha } = await seedMirror(dir);
  const remoteBare = join(dir, 'remote.git');
  await runGit(['init', '--bare', '-q', remoteBare]);

  // --- real persistence: full tenancy + run/task/attempt chain --------------
  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);
  const runs = new RunRepository(client);
  const tasks = new TaskRepository(client);
  const attempts = new AttemptRepository(client);
  const leases = new SqlWorkspaceLeaseRepository(client);

  const org = await orgs.create({ name: 'Acme' });
  const proj = await projects.create({
    organizationId: org.id, name: 'web', defaultBranch: 'main',
  });
  const scope: TenantScope = { organizationId: org.id, projectId: proj.id };
  const binding = await bindings.create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main',
  });
  const run = await runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0',
  });
  const task = await tasks.create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: 'R0', baseSha,
  });
  const attempt = await attempts.create(scope, {
    taskId: task.id, repositoryBindingId: binding.id, baseSha,
  });

  // --- MED-003: REAL observability on the real path -------------------------
  // The finding was that instrumentation existed but nothing on the runnable
  // path emitted it: governedExecution was called with no tracer/audit, so the
  // J1/J2/J4 claims rested on unit fakes only. Wire both here, against the SAME
  // SqlClient the slice persists to, so spans are genuinely emitted and audit
  // rows land in the `audit_events` table of the real database.
  const telemetry = new CapturingTelemetrySink();
  const tracer = new SpanTracer(telemetry);
  const auditSink = new SqlAuditSink(client);

  // --- real artifact store + evidence store + side-effect log ---------------
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  const artifacts = new ContentAddressedArtifactStore(client, objects);
  const evidenceStore = new ContentAddressedEvidenceStore(client, objects);
  const sideEffectLog = new SqlSideEffectLog(client);

  // --- real worktree manager ------------------------------------------------
  const workspaceRoot = join(dir, 'wt');
  await mkdir(workspaceRoot, { recursive: true });
  const manager = new GitWorktreeManager(
    { workspaceRoot, mirrorPath: mirror, repositoryBindingId: binding.id },
    artifacts,
  );
  const branch = attemptBranch({ runId: run.id, taskId: task.id, attemptId: attempt.id });

  // --- store a real work-order + context-pack artifact ----------------------
  const woBytes = new TextEncoder().encode(JSON.stringify({ objective: 'add feature.txt' }));
  const workOrderRef = await artifacts.put(scope, {
    kind: 'work-order', content: woBytes, sha256: sha256Hex(woBytes),
    contentType: 'application/json',
  });
  const cpBytes = new TextEncoder().encode(JSON.stringify({ relevantFiles: ['feature.txt'] }));
  const contextPackRef = await artifacts.put(scope, {
    kind: 'context-pack', content: cpBytes, sha256: sha256Hex(cpBytes),
    contentType: 'application/json',
  });

  // The agent and forge need the worktree path, which only exists after the
  // driver's governed step creates it. They resolve it through a setter that the
  // real path is written into below — the agent still runs BEFORE inspection, so
  // the trust ordering is unchanged.
  const agent = new FileWritingAgent();
  const forge = new LocalBareForgeProvider(remoteBare);

  // The workspace path is deterministic from the manager's containment rule, so
  // wire it as soon as the manager hands back a workspace id. governedExecution
  // owns lease + workspace creation, so we hook the inspector to capture it.
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const wrappedInspector = {
    inspect: async (s: TenantScope, cap: { workspaceId: string; leaseId: string }) => {
      const p = resolve(join(realWorkspaceRoot, binding.id, cap.workspaceId));
      agent.setWorktree(p);
      forge.setWorktree(p);
      return manager.inspect(s, cap as never);
    },
  };
  // The agent must see the path BEFORE it runs; governedExecution invokes the
  // agent before the inspector, so wire the path through the workspace manager
  // instead — wrapping create() is the honest hook point.
  let wtPath = '';
  const wrappedManager = {
    create: async (s: TenantScope, i: {
      repositoryBindingId: RepositoryBindingId; baseSha: string; leaseId: string;
    }) => {
      const ws = await manager.create(s, i);
      wtPath = resolve(join(realWorkspaceRoot, binding.id, ws.workspaceId));
      agent.setWorktree(wtPath);
      forge.setWorktree(wtPath);
      return ws;
    },
    cleanup: (s: TenantScope, id: never) => manager.cleanup(s, id),
    quarantine: (s: TenantScope, id: never, reason: string) => manager.quarantine(s, id, reason),
  };

  // --- STEPS 1-3: admission (FIRST) → lease → workspace → agent → inspect ---
  // governedExecution is the TOP-LEVEL use case: admission runs before any
  // lease/workspace/agent side effect (BR1/BR2/I4, HIGH-003).
  const governed = await governedExecution({
    scope,
    risk: 'R0',
    repositoryBindingId: binding.id,
    attemptId: attempt.id,
    baseSha,
    branch,
    leaseTtlMs: 60_000,
    leases,
    workspaces: wrappedManager as never,
    provider: agent,
    inspector: wrappedInspector as never,
    workOrderRef,
    contextPackRef,
    budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 },
    toolPolicy: {
      allowedTools: ['write'], disallowedTools: ['network'], networkProfile: 'no-network',
    },
    signal: new AbortController().signal,
    runId: run.id,
    taskId: task.id,
    // MED-003: real emission on the real path (J1/J2/J4).
    tracer,
    audit: auditSink,
    traceId: `trace-${attempt.id}`,
    actor: 'harness',
  });
  if (governed.stoppedAt !== 'ready-for-completion') {
    throw new Error(`governed execution stopped early at '${governed.stoppedAt}'`);
  }
  const change = governed.change;
  const leaseId = governed.leaseId;
  if (!change || !leaseId) throw new Error('governed execution produced no change/lease');
  if (!change.changedFiles.includes('feature.txt')) {
    throw new Error(`trusted inspection did not observe the agent write: ${change.changedFiles}`);
  }

  // --- STEPS 4-9: verify → commit → evidence → push → PR → review ----------
  const runner = new TrustedCommandRunner(scope, artifacts);
  const check = input.checkCommand(wtPath);
  // R0 mandates [L0, L1]; one real passing command per mandatory level.
  const checks: VerificationCheckSpec[] = [
    { id: 'L0-workspace', level: 'L0', category: 'workspace', mandatory: true, command: check },
    { id: 'L1-static', level: 'L1', category: 'static', mandatory: true, command: check },
  ];
  const taskAggregate: TaskAggregate = {
    id: task.id, status: 'VERIFYING', version: task.version,
  };
  const sandboxHandle = await input.sandbox.start('verification-no-network', {
    workspaceId: governed.workspaceId!, readOnlyPaths: [], writablePaths: [wtPath],
  });
  const isolationEnforced =
    (sandboxHandle as { isolationEnforced?: boolean }).isolationEnforced === true;
  await input.sandbox.stop(sandboxHandle);

  const result = await completeToReview({
    change,
    baseSha,
    runner,
    sandbox: input.sandbox,
    mount: { workspaceId: governed.workspaceId!, readOnlyPaths: [], writablePaths: [wtPath] },
    planId: 'plan-R0',
    risk: 'R0',
    checks,
    committer: manager,
    scope,
    workspace: governed.workspace!.capability,
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
    title: 'ASEP: add feature.txt',
    body: 'Automated attempt reaching human review.',
    leaseId,
    task: taskAggregate,
  });
  if (result.stoppedAt !== 'complete') {
    throw new Error(`completion stopped early at '${result.stoppedAt}'`);
  }

  // --- persist the AUTHORITATIVE transitions (HIGH-008) --------------------
  const prs = new PullRequestRepository(client);
  let attemptVersion = attempt.version;
  attemptVersion = await attempts.setResultSha(scope, attempt.id, attemptVersion, result.commitSha!);
  attemptVersion = await attempts.attachEvidence(
    scope, attempt.id, attemptVersion, result.evidence!.ref,
  );
  await tasks.updateStatus(scope, task.id, task.version, 'WAITING_FOR_HUMAN_REVIEW');
  await prs.upsert(scope, {
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

  return {
    scope,
    repositoryBindingId: binding.id,
    runId: run.id,
    taskId: task.id,
    attemptId: attempt.id,
    branch,
    baseSha,
    wtPath,
    remoteBare,
    commitSha: result.commitSha!,
    evidenceArtifactId: result.evidence!.ref.artifactId,
    evidenceSha256: result.evidence!.ref.sha256,
    prNumber: result.pr!.number,
    prHeadBranch: result.pr!.headBranch,
    prBaseBranch: result.pr!.baseBranch,
    pushes: forge.pushes,
    stoppedAt: result.stoppedAt,
    taskStatus: result.task!.status,
    sandboxIsolationEnforced: isolationEnforced,
    emittedSpans: telemetry.events,
    repos: { runs, tasks, attempts, prs, evidenceStore },
  };
}
