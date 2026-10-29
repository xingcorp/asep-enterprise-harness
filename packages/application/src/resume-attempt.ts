// Resume an attempt whose executor died, under a NEW lease (fenced takeover).
//
// THE GAP. The two-phase side-effect log made every external effect
// reconcilable, but a record's owner was the crashed executor's lease. Its
// successor necessarily holds a different lease, so it could neither finish the
// PENDING record nor take it over: recovery wedged on exactly the crash the
// protocol exists for.
//
// THE MODEL.
//   1. The successor acquires the attempt's branch lease. While the dead
//      executor's lease is still live (it may not be dead — only slow) the
//      one-active-writer index denies this, and the resume stops having done
//      nothing. Once that lease expired or was released, the acquire sweeps it
//      and the new lease gets the next fencing epoch.
//   2. Every side-effect begin() made under the new lease takes an unfinished
//      record over (the log checks the old lease is dead and the epoch is
//      newer) and the step then RECONCILES against the outside world before
//      acting: the remote ref for a push, the forge's PR for an upsert. A record
//      that already COMPLETED is adopted as a fact.
//   3. The dead owner is refused from then on: its lease can never be revived,
//      and the log only lets the current, live owner finish a record.
//
// ADMISSION FIRST. A resume publishes (push, PR) just as a fresh run does, so
// it is gated the same way: the task's risk is read from the authoritative task
// row and admitted BEFORE the lease is taken. A deferred risk (R2–R4) stops the
// resume having touched nothing but that read.
//
// WHAT IS RESUMED. Attempts whose harness commit is durable. The commit was
// minted in the dead executor's worktree, which is quarantined, never reused.
// Its evidence is adopted when it was stored; when the executor died between
// the commit and the evidence write, the evidence is completed from the draft
// reserved for it BEFORE the commit — the verified tree's diff, checks and
// environment — plus the SHA the commit record holds. Evidence is never
// re-derived under a new workspace: an unreadable draft stops the resume with
// nothing published, and an attempt whose commit is not durable is reported
// `not-resumable` and must be re-executed as a new attempt. Nothing had left the
// harness at that point: the push runs after the evidence is stored.

import type {
  TenantScope, ArtifactId, ArtifactRef, RepositoryBindingId, RunId, TaskId, AttemptId,
  TaskStatus, RiskLevel,
} from '@asep/contracts';
import type {
  EvidenceStore, ForgeProvider, GitCommitter, SideEffectLog, WorkspaceLeaseRepository, Lease,
} from '@asep/ports';
import type { SpanTracer, AuditSink } from '@asep/observability';
import { completionObserver, fencedBy } from './completion-observer.js';
import { admitRisk } from './risk-admission.js';
import { pushStep, upsertPrStep, evidenceStep, settleCommitStep } from './pipeline-steps.js';
import type { SlicePullRequestPort } from './vertical-slice-workflow.js';

// --- repository ports (structural; the concrete repositories satisfy them) ----

export interface ResumeAttemptPort {
  getScoped(scope: TenantScope, id: AttemptId): Promise<{
    readonly version: number;
    readonly resultSha: string | null;
    readonly evidenceArtifactId: ArtifactId | null;
  }>;
  setResultSha(
    scope: TenantScope, id: AttemptId, expectedVersion: number, resultSha: string,
  ): Promise<number>;
  attachEvidence(
    scope: TenantScope, id: AttemptId, expectedVersion: number, ref: ArtifactRef,
  ): Promise<number>;
}

export interface ResumeTaskPort {
  getScoped(scope: TenantScope, id: TaskId): Promise<{
    readonly version: number;
    readonly status: TaskStatus;
    readonly risk: RiskLevel;
  }>;
  updateStatus(
    scope: TenantScope, id: TaskId, expectedVersion: number, status: TaskStatus,
  ): Promise<number>;
}

export interface ResumeAttemptRepositories {
  readonly attempts: ResumeAttemptPort;
  readonly tasks: ResumeTaskPort;
  readonly pullRequests: SlicePullRequestPort;
}

export interface ResumeAttemptInput {
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  // No agent runs under this lease, so it only has to outlive the forge calls.
  readonly leaseTtlMs: number;

  readonly leases: WorkspaceLeaseRepository;
  readonly sideEffects: SideEffectLog;
  readonly evidence: EvidenceStore;
  readonly forge: ForgeProvider;
  // Finds the attempt's recorded harness commit without its workspace.
  readonly committer: Pick<GitCommitter, 'reconcile'>;
  readonly repositories: ResumeAttemptRepositories;

  readonly tracer?: SpanTracer;
  readonly audit?: AuditSink;
  readonly actor?: string;
}

export type ResumeStop = 'complete' | 'admission' | 'lease-denied' | 'not-resumable';

export interface ResumeAttemptResult {
  readonly stoppedAt: ResumeStop;
  readonly reason?: string;
  // Set once admission has run: whether the resumed task still needs a
  // separately recorded human independent review (R1).
  readonly requiresHumanIndependentReview?: boolean;
  readonly leaseId?: string;
  readonly fencingEpoch?: number;
  readonly commitSha?: string;
  readonly evidenceArtifactId?: ArtifactId;
  readonly evidenceSha256?: string;
  readonly prNumber?: number;
  readonly prHeadBranch?: string;
  readonly prBaseBranch?: string;
  // Whether the push / PR was found already done (reconciled) rather than
  // performed by this resume.
  readonly pushAdopted?: boolean;
  readonly prAdopted?: boolean;
  readonly taskStatus?: TaskStatus;
}

// A task in one of these states is closed; resuming it would reopen it.
const CLOSED_TASK: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['FAILED', 'CANCELLED']);

function isLease(v: Lease | { readonly reason: string }): v is Lease {
  return 'leaseId' in v;
}

/**
 * Resume a crashed attempt from its durable state under a fresh lease. Returns
 * `admission` when the task's risk is not admitted (nothing was touched),
 * `lease-denied` when the previous holder's lease is still live, `not-resumable`
 * when the attempt has to be re-executed, and `complete` once the push, the PR
 * and the authoritative transitions all converged.
 */
export async function resumeAttemptToReview(
  input: ResumeAttemptInput,
): Promise<ResumeAttemptResult> {
  const { scope } = input;

  // --- GATE: admission from the authoritative task risk, before ANY effect ----
  const task = await input.repositories.tasks.getScoped(scope, input.taskId);
  const admission = admitRisk(task.risk);
  if (!admission.admitted) {
    return { stoppedAt: 'admission', reason: `${task.risk}: ${admission.reason}` };
  }
  const admitted = { requiresHumanIndependentReview: admission.requiresHumanIndependentReview };

  const lease = await input.leases.acquire(scope, {
    repositoryBindingId: input.repositoryBindingId,
    branch: input.branch,
    attemptId: input.attemptId,
    ttlMs: input.leaseTtlMs,
  });
  if (!isLease(lease)) {
    return { ...admitted, stoppedAt: 'lease-denied', reason: lease.reason };
  }
  const held = { ...admitted, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch };

  let finished = false;
  try {
    const outcome = await resumeUnderLease(input, lease);
    finished = true;
    return { ...held, ...outcome };
  } finally {
    const released = input.leases.release(scope, lease.leaseId);
    // A failed release must not mask the error that ended the resume.
    if (finished) await released;
    else await released.catch(() => undefined);
  }
}

async function resumeUnderLease(
  input: ResumeAttemptInput,
  lease: Lease,
): Promise<ResumeAttemptResult> {
  const { scope } = input;
  const repos = input.repositories;
  const fence = (): Promise<void> => input.leases.heartbeat(scope, lease.leaseId);
  const observe = fencedBy(
    completionObserver({
      correlation: {
        traceId: `trace-${input.attemptId}`,
        tenantId: scope.organizationId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        repositoryBindingId: input.repositoryBindingId,
        runId: input.runId,
        taskId: input.taskId,
        attemptId: input.attemptId,
      },
      actor: input.actor ?? 'harness',
      ...(input.tracer ? { tracer: input.tracer } : {}),
      ...(input.audit ? { audit: input.audit } : {}),
    }),
    fence,
  );

  const task = await repos.tasks.getScoped(scope, input.taskId);
  if (CLOSED_TASK.has(task.status)) {
    return { stoppedAt: 'not-resumable', reason: `task is ${task.status}` };
  }

  // --- the harness commit: adopted when recorded, reconciled when the executor
  // died between the commit and its record --------------------------------------
  const begun = await input.sideEffects.find(scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
  });
  if (!begun) {
    return { stoppedAt: 'not-resumable', reason: 'no harness commit was begun — re-execute the attempt' };
  }
  if (begun.state !== 'COMPLETED' && begun.state !== 'PENDING') {
    return { stoppedAt: 'not-resumable', reason: `the harness commit is ${begun.state} — re-execute the attempt` };
  }
  const commit = await observe(
    { span: 'git.commit', action: 'git.commit', detail: { baseSha: input.baseSha, resumed: true } },
    () => settleCommitStep({
      committer: input.committer,
      log: input.sideEffects,
      scope,
      repositoryBindingId: input.repositoryBindingId,
      attemptId: input.attemptId,
      baseSha: input.baseSha,
      leaseId: lease.leaseId,
    }),
  );
  if (commit === null) {
    return {
      stoppedAt: 'not-resumable',
      reason: 'the harness commit never landed — re-execute the attempt (nothing left the harness)',
    };
  }
  const commitSha = commit.commitSha;
  const evidenceId = commit.evidenceId;

  // --- …and its evidence: adopted when stored, else completed from the draft
  // reserved for it before the commit (a crash between commit and evidence).
  // The evidence step never re-derives evidence, so the bytes are the ones the
  // dead executor would have written.
  const evidence = await observe(
    { span: 'artifact.put', action: 'evidence.put', detail: { evidenceId, resumed: true } },
    () => evidenceStep({
      store: input.evidence,
      scope,
      evidenceId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      baseSha: input.baseSha,
      resultSha: commitSha,
    }),
  );
  const evidenceRef: ArtifactRef = evidence.ref;

  // --- push + PR: take over, reconcile, then act only if needed ----------------
  const push = await observe(
    { span: 'forge.push', action: 'forge.push', detail: { branch: input.branch, commitSha } },
    () => pushStep({
      forge: input.forge,
      log: input.sideEffects,
      scope,
      repositoryBindingId: input.repositoryBindingId,
      attemptId: input.attemptId,
      branch: input.branch,
      commitSha,
      leaseId: lease.leaseId,
    }),
  );
  const upsert = await observe(
    {
      span: 'forge.pull_request', action: 'forge.pull_request.upsert',
      detail: { headBranch: input.branch, base: input.base },
    },
    () => upsertPrStep({
      forge: input.forge,
      log: input.sideEffects,
      scope,
      repositoryBindingId: input.repositoryBindingId,
      attemptId: input.attemptId,
      headBranch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      leaseId: lease.leaseId,
    }),
  );
  const pr = upsert.pr;

  // --- the authoritative transitions, idempotently ------------------------------
  let taskStatus: TaskStatus = task.status;
  await observe(
    {
      span: 'task.execute',
      action: 'task.status.transition',
      detail: { to: 'WAITING_FOR_HUMAN_REVIEW', commitSha, prNumber: pr.number, resumed: true },
    },
    async () => {
      const attempt = await repos.attempts.getScoped(scope, input.attemptId);
      let version = attempt.version;
      if (attempt.resultSha !== commitSha) {
        version = await repos.attempts.setResultSha(scope, input.attemptId, version, commitSha);
      }
      if (attempt.evidenceArtifactId !== evidenceRef.artifactId) {
        version = await repos.attempts.attachEvidence(scope, input.attemptId, version, evidenceRef);
      }
      if (task.status !== 'WAITING_FOR_HUMAN_REVIEW') {
        await repos.tasks.updateStatus(scope, input.taskId, task.version, 'WAITING_FOR_HUMAN_REVIEW');
      }
      taskStatus = 'WAITING_FOR_HUMAN_REVIEW';
      await repos.pullRequests.upsert(scope, {
        repositoryBindingId: input.repositoryBindingId,
        attemptId: input.attemptId,
        forge: 'github',
        number: pr.number,
        headBranch: pr.headBranch,
        baseBranch: pr.baseBranch,
        url: pr.url,
        state: 'OPEN',
        evidenceRef,
      });
    },
  );

  return {
    stoppedAt: 'complete',
    commitSha,
    evidenceArtifactId: evidenceRef.artifactId,
    evidenceSha256: evidenceRef.sha256,
    prNumber: pr.number,
    prHeadBranch: pr.headBranch,
    prBaseBranch: pr.baseBranch,
    pushAdopted: push.adopted,
    prAdopted: upsert.adopted,
    taskStatus,
  };
}
