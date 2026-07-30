// Vertical-slice WORKFLOW use case (disp. P2-FINAL-MED-004, exit criteria
// B1/B2/B5).
//
// The HIGH-008 repair introduced apps/control-plane-api/src/vertical-slice.ts,
// which held the whole governed sequence AND called persistence repositories
// (runs.create(), tasks.create(), attempts.attachEvidence(), prs.upsert(), …)
// directly from a composition root. That regressed MED-004: orchestration and
// workflow sequencing belong to the APPLICATION layer; apps/* may only wire
// concrete adapters and call a use case.
//
// This module is that use case. It owns the full K1 sequence on injected PORTS:
//
//   register tenancy (org → project → binding) → run → task → attempt
//   → store work-order + context-pack artifacts
//   → governedExecution  (admission FIRST, then lease → workspace → agent →
//                         trusted inspection)
//   → sandbox isolation probe
//   → completeToReview   (verify → commit → evidence → push → PR → review gate)
//   → persist the AUTHORITATIVE transitions (attempt.result_sha, the scoped
//     evidence attachment, task status, the PR row)
//
// It composes ONLY against structural ports declared here plus the @asep/ports
// interfaces (exit B3): no @asep/persistence class, no Fastify/pg/Octokit/Docker
// import. Host-shaped facts a pure use case cannot know are injected instead of
// being computed here:
//
//   branchFor()        — the attempt branch naming rule (a Git adapter concern)
//   workspaceBackend() — resolves the workspace manager/inspector/committer for
//                        the binding this slice registered, plus the on-disk path
//                        of a created workspace (needed for the verification
//                        mount + command). It is a FACTORY because the concrete
//                        Git backend is per-repository-binding, and the binding
//                        id only exists once this workflow has registered it —
//                        so the composition root cannot build it up front.
//
// All are supplied by the composition root, so the workflow stays free of path
// and Git knowledge while still driving the real sequence end to end.

import { createHash } from 'node:crypto';
import type {
  TenantScope, RiskLevel, TaskStatus, ArtifactRef, ArtifactId, Budget,
  OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId, AttemptId,
  WorkspaceId, EvidenceBundle,
} from '@asep/contracts';
import type {
  ArtifactStore, EvidenceStore, SideEffectLog, WorkspaceLeaseRepository,
  WorkspaceManager, CodingAgentProvider, GitChangeInspector, GitCommitter,
  CommandRunner, CommandSpec, SandboxProvider, ForgeProvider, ToolPolicyProfile,
} from '@asep/ports';
import type { SpanTracer, AuditSink } from '@asep/observability';
import { governedExecution } from './governed-execution.js';
import {
  completeToReview, SandboxIsolationRequiredError,
  type VerificationCheckSpec, type SandboxRequirement,
} from './pipeline-steps.js';

// --- repository ports (structural; the concrete repositories satisfy them) ----
//
// Declared as the SHAPE the workflow needs, exactly like registration.ts, so the
// application layer never names a @asep/persistence class.

export interface SliceOrganizationPort {
  create(input: { name: string }): Promise<{ id: OrganizationId }>;
}

export interface SliceProjectPort {
  create(input: { organizationId: OrganizationId; name: string; defaultBranch: string }):
    Promise<{ id: ProjectId }>;
}

export interface SliceBindingPort {
  create(scope: TenantScope, input: {
    githubHost: string; githubOwner: string; githubRepo: string; defaultBaseBranch: string;
  }): Promise<{ id: RepositoryBindingId }>;
}

export interface SliceRunPort {
  create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; status: string; risk: RiskLevel;
  }): Promise<{ id: RunId }>;
}

export interface SliceTaskPort {
  create(scope: TenantScope, input: {
    runId: RunId; repositoryBindingId: RepositoryBindingId; risk: RiskLevel; baseSha?: string;
  }): Promise<{ id: TaskId; version: number }>;
  updateStatus(
    scope: TenantScope, id: TaskId, expectedVersion: number, status: TaskStatus,
  ): Promise<number>;
}

export interface SliceAttemptPort {
  create(scope: TenantScope, input: {
    taskId: TaskId; repositoryBindingId: RepositoryBindingId; baseSha?: string;
  }): Promise<{ id: AttemptId; version: number }>;
  setResultSha(
    scope: TenantScope, id: AttemptId, expectedVersion: number, resultSha: string,
  ): Promise<number>;
  attachEvidence(
    scope: TenantScope, id: AttemptId, expectedVersion: number, ref: ArtifactRef,
  ): Promise<number>;
}

export interface SlicePullRequestPort {
  upsert(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; attemptId: AttemptId; forge: string;
    number: number; headBranch: string; baseBranch: string; url: string; state: string;
    evidenceRef: ArtifactRef;
  }): Promise<unknown>;
}

export interface VerticalSliceRepositories {
  readonly organizations: SliceOrganizationPort;
  readonly projects: SliceProjectPort;
  readonly bindings: SliceBindingPort;
  readonly runs: SliceRunPort;
  readonly tasks: SliceTaskPort;
  readonly attempts: SliceAttemptPort;
  readonly pullRequests: SlicePullRequestPort;
}

// The Git-side ports for ONE repository binding, plus the path resolver for a
// workspace that binding's manager created. Bundled because a real Git backend
// is configured per binding (mirror path + workspace root), and the binding id
// only exists after this workflow registers it — so the composition root hands
// in a FACTORY, not a prebuilt instance. The workflow never learns what a mirror
// or a filesystem path is; it just asks for the backend of the binding it made.
export interface SliceWorkspaceBackend {
  readonly workspaces: WorkspaceManager;
  readonly inspector: GitChangeInspector;
  readonly committer: GitCommitter;
  // Absolute path of a workspace this backend created. Injected because path
  // layout is an adapter concern (exit B3) but the verification mount needs it.
  readonly pathOf: (workspaceId: WorkspaceId) => Promise<string> | string;
}

// --- workflow input / output -------------------------------------------------

export interface VerticalSliceWorkflowInput {
  // Tenancy to register for this slice.
  readonly organizationName: string;
  readonly projectName: string;
  readonly defaultBranch: string;
  readonly binding: {
    readonly githubHost: string;
    readonly githubOwner: string;
    readonly githubRepo: string;
    readonly defaultBaseBranch: string;
  };

  // Execution identity + governance inputs.
  readonly risk: RiskLevel;
  readonly baseSha: string;
  readonly leaseTtlMs: number;
  readonly budget: Budget;
  readonly toolPolicy: ToolPolicyProfile;
  readonly signal: AbortSignal;

  // Ports.
  readonly repositories: VerticalSliceRepositories;
  readonly artifacts: ArtifactStore;
  readonly evidence: EvidenceStore;
  readonly sideEffects: SideEffectLog;
  readonly leases: WorkspaceLeaseRepository;
  // The coding agent. Two injection shapes, exactly one of which must be given:
  //
  //   provider     — a prebuilt agent (test doubles, and any adapter that needs
  //                  no tenant scope to construct).
  //   providerFor  — a FACTORY taking the registered TenantScope (disp.
  //                  P2-FINAL-HIGH-008). The REAL Claude adapter is
  //                  scope-bound: it persists its raw event stream as a scoped
  //                  artifact, and the scope does not exist until this workflow
  //                  has registered the organization + project. Without this
  //                  seam a production root could only ever hand in a
  //                  placeholder-scoped provider, which is why the real adapter
  //                  was previously unreachable from the driver.
  //
  // `providerFor` wins when both are present.
  readonly provider?: CodingAgentProvider;
  readonly providerFor?: (input: { scope: TenantScope }) => CodingAgentProvider;
  // A CommandRunner is scope-aware (it stores stdout/stderr as scoped
  // artifacts), and the tenant scope only exists once this workflow has
  // registered the organization + project — so the root injects a FACTORY
  // rather than a prebuilt runner bound to a placeholder scope.
  readonly runnerFor: (input: { scope: TenantScope }) => CommandRunner;
  readonly sandbox: SandboxProvider;
  // Sandbox posture (disp. P2-FINAL-HIGH-002, exit E8). ABSENT means 'required',
  // so the slice refuses to run verification under a provider that does not
  // enforce OS isolation unless the caller explicitly passes the pilot waiver.
  readonly sandboxRequirement?: SandboxRequirement;
  readonly forge: ForgeProvider;

  // Observability (MED-003): real emission on the real path when wired.
  readonly tracer?: SpanTracer;
  readonly audit?: AuditSink;
  readonly actor?: string;

  // Host-shaped seams the pure workflow must not compute itself.
  readonly branchFor: (ids: {
    runId: RunId; taskId: TaskId; attemptId: AttemptId;
  }) => string;
  // Resolve the Git backend for the binding this workflow just registered. Called
  // ONCE, after registration, so a real adapter can be configured with the real
  // binding id (mirror path / workspace root) without the workflow knowing any of
  // those concepts.
  readonly workspaceBackend: (input: {
    scope: TenantScope; repositoryBindingId: RepositoryBindingId;
  }) => Promise<SliceWorkspaceBackend> | SliceWorkspaceBackend;
  readonly checkCommand: (workspacePath: string) => CommandSpec;

  // Work-order / context-pack payloads (stored as immutable artifacts here, so
  // the composition root never calls artifacts.put itself).
  readonly workOrder: Readonly<Record<string, unknown>>;
  readonly contextPack: Readonly<Record<string, unknown>>;

  // Commit + evidence details.
  readonly allowedPaths: readonly string[];
  readonly identity: { readonly name: string; readonly email: string };
  readonly environment: EvidenceBundle['environment'];
  readonly prTitle: string;
  readonly prBody: string;

  // The file trusted inspection MUST observe as changed. The agent's own report
  // is untrusted, so the workflow fails closed when the harness-derived change
  // set does not contain it.
  readonly expectChangedFile: string;
}

export interface VerticalSliceWorkflowResult {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly branch: string;
  readonly baseSha: string;
  readonly workspaceId: WorkspaceId;
  readonly workspacePath: string;
  readonly commitSha: string;
  readonly evidenceArtifactId: ArtifactId;
  readonly evidenceSha256: string;
  readonly prNumber: number;
  readonly prHeadBranch: string;
  readonly prBaseBranch: string;
  readonly stoppedAt: string;
  readonly taskStatus: string;
  readonly sandboxIsolationEnforced: boolean;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Drive the FULL governed vertical slice over injected ports and persist every
 * authoritative transition. Throws when any step stops short of the human-review
 * gate, so a caller's assertions only ever run on a slice that genuinely
 * completed.
 */
export async function runVerticalSliceWorkflow(
  input: VerticalSliceWorkflowInput,
): Promise<VerticalSliceWorkflowResult> {
  const repos = input.repositories;

  // --- register tenancy + the run/task/attempt chain -------------------------
  const org = await repos.organizations.create({ name: input.organizationName });
  const project = await repos.projects.create({
    organizationId: org.id, name: input.projectName, defaultBranch: input.defaultBranch,
  });
  const scope: TenantScope = { organizationId: org.id, projectId: project.id };
  const binding = await repos.bindings.create(scope, input.binding);
  const run = await repos.runs.create(scope, {
    repositoryBindingId: binding.id, status: 'EXECUTING', risk: input.risk,
  });
  const task = await repos.tasks.create(scope, {
    runId: run.id, repositoryBindingId: binding.id, risk: input.risk, baseSha: input.baseSha,
  });
  const attempt = await repos.attempts.create(scope, {
    taskId: task.id, repositoryBindingId: binding.id, baseSha: input.baseSha,
  });
  const branch = input.branchFor({ runId: run.id, taskId: task.id, attemptId: attempt.id });

  // The Git backend is resolved only NOW: it is configured per repository
  // binding, and the binding id did not exist until the step above.
  const git = await input.workspaceBackend({ scope, repositoryBindingId: binding.id });

  // Resolve the coding agent with the REAL registered scope (HIGH-008). The
  // factory form is what makes the production Claude adapter reachable: it is
  // constructed with the scope it will store its event-stream artifact under, so
  // a root no longer has to hard-code a scope-free stand-in. Fail closed when a
  // caller wires neither shape rather than proceeding agent-less.
  const provider = input.providerFor
    ? input.providerFor({ scope })
    : input.provider;
  if (!provider) {
    throw new Error(
      'vertical slice requires a coding agent: pass providerFor (scope-bound, e.g. the ' +
      'real Claude adapter) or provider (a prebuilt instance)',
    );
  }

  // --- immutable agent inputs ----------------------------------------------
  const woBytes = jsonBytes(input.workOrder);
  const workOrderRef = await input.artifacts.put(scope, {
    kind: 'work-order', content: woBytes, sha256: sha256Hex(woBytes),
    contentType: 'application/json',
  });
  const cpBytes = jsonBytes(input.contextPack);
  const contextPackRef = await input.artifacts.put(scope, {
    kind: 'context-pack', content: cpBytes, sha256: sha256Hex(cpBytes),
    contentType: 'application/json',
  });

  // --- admission FIRST → lease → workspace → agent → trusted inspection -----
  const governed = await governedExecution({
    scope,
    risk: input.risk,
    repositoryBindingId: binding.id,
    attemptId: attempt.id,
    baseSha: input.baseSha,
    branch,
    leaseTtlMs: input.leaseTtlMs,
    leases: input.leases,
    workspaces: git.workspaces,
    provider,
    inspector: git.inspector,
    workOrderRef,
    contextPackRef,
    budget: input.budget,
    toolPolicy: input.toolPolicy,
    signal: input.signal,
    runId: run.id,
    taskId: task.id,
    ...(input.tracer ? { tracer: input.tracer } : {}),
    ...(input.audit ? { audit: input.audit } : {}),
    traceId: `trace-${attempt.id}`,
    actor: input.actor ?? 'harness',
  });
  if (governed.stoppedAt !== 'ready-for-completion') {
    throw new Error(`governed execution stopped early at '${governed.stoppedAt}'`);
  }
  const change = governed.change;
  const leaseId = governed.leaseId;
  const workspace = governed.workspace;
  const workspaceId = governed.workspaceId;
  if (!change || !leaseId || !workspace || !workspaceId) {
    throw new Error('governed execution produced no change/lease/workspace');
  }
  if (!change.changedFiles.includes(input.expectChangedFile)) {
    throw new Error(
      `trusted inspection did not observe '${input.expectChangedFile}': ${change.changedFiles}`,
    );
  }

  // --- verification context: the real workspace path ------------------------
  const wtPath = await git.pathOf(workspaceId);
  const check = input.checkCommand(wtPath);
  // R0 mandates [L0, L1]; one real passing command per mandatory level.
  const checks: VerificationCheckSpec[] = [
    { id: 'L0-workspace', level: 'L0', category: 'workspace', mandatory: true, command: check },
    { id: 'L1-static', level: 'L1', category: 'static', mandatory: true, command: check },
  ];
  // The working tree is writable, but the `.git` indirection NESTED inside it is
  // pinned read-only through the parent mount (disp. P2-FINAL-HIGH-002). Leaving
  // it merely absent from writablePaths was insufficient: the rw parent bind made
  // it writable anyway. The separator is spelled literally rather than via
  // node:path so this use case stays free of host-path machinery (exit B3); the
  // adapter turns it into an OS-enforced nested read-only bind.
  const mount = {
    workspaceId,
    readOnlyPaths: [],
    writablePaths: [wtPath],
    readOnlyOverlayPaths: [`${wtPath}/.git`],
  };

  // Probe the sandbox the verification commands will run in, so the caller can
  // assert OS-enforced isolation was genuinely in effect (HIGH-002).
  const sandboxRequirement: SandboxRequirement = input.sandboxRequirement ?? 'required';
  const probe = await input.sandbox.start('verification-no-network', mount);
  const sandboxIsolationEnforced =
    (probe as { isolationEnforced?: boolean }).isolationEnforced === true;
  await input.sandbox.stop(probe);
  // E8: refuse the whole slice BEFORE the first side effect when isolation is
  // mandatory but absent. Doing it here (not only inside verifyStep) means the
  // run stops before any commit/push/PR, so an unsandboxed provider can never
  // reach the forge. verifyStep re-asserts it on the handle it actually uses, so
  // neither layer trusts the other's check.
  if (sandboxRequirement === 'required' && !sandboxIsolationEnforced) {
    throw new SandboxIsolationRequiredError(probe.sandboxId, probe.profile);
  }

  // --- verify → commit → evidence → push → PR → review gate ----------------
  const result = await completeToReview({
    change,
    baseSha: input.baseSha,
    runner: input.runnerFor({ scope }),
    sandbox: input.sandbox,
    mount,
    planId: `plan-${input.risk}`,
    risk: input.risk,
    checks,
    sandboxRequirement,
    committer: git.committer,
    scope,
    workspace: workspace.capability,
    allowedPaths: input.allowedPaths,
    identity: input.identity,
    store: input.evidence,
    taskId: task.id,
    attemptId: attempt.id,
    environment: input.environment,
    forge: input.forge,
    log: input.sideEffects,
    repositoryBindingId: binding.id,
    branch,
    base: input.binding.defaultBaseBranch,
    title: input.prTitle,
    body: input.prBody,
    leaseId,
    task: { id: task.id, status: 'VERIFYING', version: task.version },
  });
  if (result.stoppedAt !== 'complete') {
    throw new Error(`completion stopped early at '${result.stoppedAt}'`);
  }
  const commitSha = result.commitSha;
  const evidence = result.evidence;
  const pr = result.pr;
  const finalTask = result.task;
  if (!commitSha || !evidence || !pr || !finalTask) {
    throw new Error('completion reported success without commit/evidence/PR/task');
  }

  // --- persist the AUTHORITATIVE transitions -------------------------------
  let attemptVersion = attempt.version;
  attemptVersion = await repos.attempts.setResultSha(
    scope, attempt.id, attemptVersion, commitSha,
  );
  attemptVersion = await repos.attempts.attachEvidence(
    scope, attempt.id, attemptVersion, evidence.ref,
  );
  await repos.tasks.updateStatus(scope, task.id, task.version, 'WAITING_FOR_HUMAN_REVIEW');
  await repos.pullRequests.upsert(scope, {
    repositoryBindingId: binding.id,
    attemptId: attempt.id,
    forge: 'github',
    number: pr.number,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    url: pr.url,
    state: 'OPEN',
    evidenceRef: evidence.ref,
  });

  return {
    scope,
    repositoryBindingId: binding.id,
    runId: run.id,
    taskId: task.id,
    attemptId: attempt.id,
    branch,
    baseSha: input.baseSha,
    workspaceId,
    workspacePath: wtPath,
    commitSha,
    evidenceArtifactId: evidence.ref.artifactId,
    evidenceSha256: evidence.ref.sha256,
    prNumber: pr.number,
    prHeadBranch: pr.headBranch,
    prBaseBranch: pr.baseBranch,
    stoppedAt: result.stoppedAt,
    taskStatus: finalTask.status,
    sandboxIsolationEnforced,
  };
}
