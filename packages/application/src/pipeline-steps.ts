// Remaining vertical-slice step use cases (disp. P2-PLAN-MED-003, exit criteria
// I1/D8/C7). These continue the pipeline started in ./execute-task.ts
// (admission → agent → inspect) through the governed task-to-pull-request
// sequence (§11):
//
//   runVerification → (preallocate evidence id) → commit → buildEvidence →
//   push → upsertPr → setReview(WAITING_FOR_HUMAN_REVIEW)
//
// Every step is:
//   - framework-free (composes only @asep/ports interfaces + pure policy/
//     domain logic — NO Fastify/pg/Octokit/Docker/provider SDK import, exit B3),
//   - individually idempotent + resumable (a Temporal-shaped workflow can drive
//     them at activity granularity; a crash between steps resumes without
//     replaying a completed side effect),
//   - a pure orchestration over ports (no hidden state).
//
// Trust rules enforced here:
//   - resultSha = the FINAL harness commit SHA, derived by the trusted
//     GitCommitter — never the provider (exit D8);
//   - the evidence artifact id is PREALLOCATED (non-content-derived) before the
//     commit, embedded in the commit's ASEP-Evidence trailer, and the bundle is
//     stored AFTER commit but BEFORE push (breaks the commit↔content-address
//     cycle, exit D8);
//   - external effects (push, PR upsert) are wrapped by the two-phase
//     SideEffectLog: begin(PENDING) → external call → complete(COMPLETED),
//     keyed by a tenant-scoped semantic key with a request fingerprint and a
//     fencing token so a crash on either side converges to one ref / one PR
//     (exit C7);
//   - the pipeline STOPS at WAITING_FOR_HUMAN_REVIEW — it never advances a Task
//     to ACCEPTED/DONE (domain invariant I2).

import type {
  TenantScope,
  AttemptId,
  TaskId,
  ArtifactId,
  ArtifactRef,
  RepositoryBindingId,
  RiskLevel,
  VerificationResult,
  CheckResult,
  EvidenceBundle,
  TaskStatus,
} from '@asep/contracts';
import type {
  CommandRunner,
  CommandSpec,
  SandboxProvider,
  WorkspaceMount,
  WorkspaceCapability,
  GitCommitter,
  ForgeProvider,
  PullRequestRef,
  GitChangeObservation,
  EvidenceStore,
  SideEffectLog,
} from '@asep/ports';
import { requiredLevels, type AssuranceLevel } from '@asep/policy';
import { transitionTask, type TaskAggregate } from '@asep/domain';
import type { StepStatus } from './execute-task.js';

// ---------------------------------------------------------------------------
// Step 4 — trusted verification (sandbox, no network).
//
// Runs the mandatory verification commands for the risk in a no-network
// sandbox, capturing raw stdout/stderr straight to immutable artifacts (the
// CommandRunner returns artifact refs — a reducer never receives uncaptured
// output). Fails CLOSED: a command that timed out or whose complete raw output
// could not be persisted (truncated) yields an ERROR check, and any mandatory
// ERROR/FAIL check makes the overall verdict non-PASS.
// ---------------------------------------------------------------------------

// One verification check to execute: the assurance level + category it
// satisfies, whether it is mandatory, and the exact command to run. The caller
// (composition root) builds these from the VerificationPlan; the step stays
// pure and testable.
export interface VerificationCheckSpec {
  readonly id: string;
  readonly level: AssuranceLevel;
  // Narrower CheckResult category (assignable into both VerificationResult and
  // the wider EvidenceBundle check category).
  readonly category: CheckResult['category'];
  readonly mandatory: boolean;
  readonly command: CommandSpec;
}

// Full per-check execution detail — richer than the contract CheckResult so the
// evidence bundle can be built from the same source (command + exit code + raw
// artifact refs) without a second run.
export interface VerificationCheckExecution {
  readonly id: string;
  readonly category: CheckResult['category'];
  readonly mandatory: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly verdict: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  readonly stdoutArtifactId?: ArtifactId;
  readonly stderrArtifactId?: ArtifactId;
  readonly message?: string;
}

export interface VerifyStepInput {
  readonly runner: CommandRunner;
  readonly sandbox: SandboxProvider;
  readonly mount: WorkspaceMount;
  readonly planId: string;
  readonly risk: RiskLevel;
  readonly checks: readonly VerificationCheckSpec[];
  // Is OS-enforced sandbox isolation MANDATORY for this execution (disp.
  // P2-FINAL-HIGH-002, exit E8)? Resolved by the composition root from the
  // deployment environment and passed in, because the requirement is a
  // deployment fact and this layer may not read process.env (exit B3).
  //
  // FAIL-CLOSED DEFAULT: an ABSENT value means 'required'. The review's finding
  // was that nothing refused an unsandboxed provider; making the safe value the
  // default means a caller must explicitly opt into the pilot waiver, and any
  // new call site is protected without being edited.
  readonly sandboxRequirement?: SandboxRequirement;
}

// The two deployment postures for sandbox isolation. Declared HERE (application
// layer) rather than imported from the command-runner adapter so the use case
// carries no adapter dependency (exit B3); the adapter's resolver returns the
// same two tokens.
export type SandboxRequirement = 'required' | 'waived-pilot-only';

// Isolation was mandatory but the started sandbox does not enforce it. Thrown
// rather than returned so no verification result can ever be produced from an
// unsandboxed execution — there is no path where a caller reads a verdict and
// ignores the breach.
export class SandboxIsolationRequiredError extends Error {
  constructor(sandboxId: string, profile: string) {
    super(
      `sandbox isolation is required but sandbox '${sandboxId}' (profile '${profile}') ` +
        'does not enforce it — refusing to run verification commands unsandboxed',
    );
    this.name = 'SandboxIsolationRequiredError';
  }
}

export interface VerifyStepResult {
  readonly step: 'verify';
  readonly status: StepStatus;
  readonly result: VerificationResult;
  // Kept for the evidence step (carries command + exitCode not on CheckResult).
  readonly executions: readonly VerificationCheckExecution[];
}

// Render a command spec back to a display string for the evidence record.
function commandText(spec: CommandSpec): string {
  return [spec.executable, ...spec.args].join(' ');
}

export async function verifyStep(input: VerifyStepInput): Promise<VerifyStepResult> {
  // Fail closed if the plan omits a mandatory assurance level for the risk: a
  // missing mandatory level is a policy hole, not an implicit pass.
  const mandatoryLevels = new Set<AssuranceLevel>(requiredLevels(input.risk));
  const coveredMandatory = new Set<AssuranceLevel>(
    input.checks.filter((c) => c.mandatory).map((c) => c.level),
  );
  const missing = [...mandatoryLevels].filter((l) => !coveredMandatory.has(l));

  const handle = await input.sandbox.start('verification-no-network', input.mount);
  // E8/HIGH-002: assert the STARTED handle actually enforces isolation when the
  // deployment requires it, BEFORE any command runs. The check reads the port's
  // own `isolationEnforced` flag (declared on SandboxHandle, so no adapter type
  // is imported) and treats an ABSENT flag as NOT enforced — unknown isolation is
  // never a permission. On breach the sandbox is stopped and the step throws, so
  // an unsandboxed provider substituted anywhere below the port can never produce
  // a verification verdict.
  const requirement: SandboxRequirement = input.sandboxRequirement ?? 'required';
  if (requirement === 'required' && handle.isolationEnforced !== true) {
    await input.sandbox.stop(handle);
    throw new SandboxIsolationRequiredError(handle.sandboxId, handle.profile);
  }
  const executions: VerificationCheckExecution[] = [];
  try {
    for (const check of input.checks) {
      const r = await input.runner.run(check.command, handle);
      // Map the raw command outcome to a verdict, failing closed on any
      // non-zero exit, timeout, or evidence-truncation.
      let verdict: VerificationCheckExecution['verdict'];
      let message: string | undefined;
      if (r.timedOut) {
        verdict = 'ERROR';
        message = 'command timed out';
      } else if (r.truncated) {
        // Complete raw evidence could not be persisted → fail closed.
        verdict = 'ERROR';
        message = 'raw output truncated — evidence incomplete';
      } else if (r.exitCode === 0) {
        verdict = 'PASS';
      } else {
        verdict = 'FAIL';
        message = `exit code ${r.exitCode ?? 'null'}`;
      }
      executions.push({
        id: check.id,
        category: check.category,
        mandatory: check.mandatory,
        command: commandText(check.command),
        exitCode: r.exitCode ?? -1,
        durationMs: 0,
        verdict,
        ...(r.stdout.artifactId ? { stdoutArtifactId: r.stdout.artifactId } : {}),
        ...(r.stderr.artifactId ? { stderrArtifactId: r.stderr.artifactId } : {}),
        ...(message ? { message } : {}),
      });
    }
  } finally {
    await input.sandbox.stop(handle);
  }

  const mandatoryFailed = executions.some((e) => e.mandatory && e.verdict !== 'PASS');
  const anyError = executions.some((e) => e.verdict === 'ERROR');
  const verdict: VerificationResult['verdict'] =
    missing.length > 0 || anyError ? 'ERROR' : mandatoryFailed ? 'FAIL' : 'PASS';

  const result: VerificationResult = {
    planId: input.planId,
    verdict,
    checks: executions.map((e) => ({
      id: e.id,
      category: e.category,
      verdict: e.verdict,
      durationMs: e.durationMs,
      ...(e.stdoutArtifactId ? { artifactId: e.stdoutArtifactId } : {}),
      ...(e.message ? { message: e.message } : {}),
    })),
    evidenceArtifactIds: executions.flatMap((e) =>
      [e.stdoutArtifactId, e.stderrArtifactId].filter((x): x is ArtifactId => !!x),
    ),
  };

  return {
    step: 'verify',
    // A non-PASS mandatory verdict STOPS the pipeline (no commit/push on a
    // failed verification unless policy allows a failed draft — not in scope).
    status: verdict === 'PASS' ? 'OK' : 'STOP',
    result,
    executions,
  };
}

// ---------------------------------------------------------------------------
// Step 5 — harness-owned commit (bot identity + ASEP trailers incl. the
// preallocated evidence id). The commit SHA it returns becomes resultSha.
//
// The evidence id is preallocated by the caller BEFORE this step and passed in,
// so the commit can embed it in the ASEP-Evidence trailer (exit D8). The commit
// is a trusted harness operation over allowed paths only — the agent never
// commits.
// ---------------------------------------------------------------------------

export interface CommitStepInput {
  readonly committer: GitCommitter;
  readonly scope: TenantScope;
  readonly workspace: WorkspaceCapability;
  readonly allowedPaths: readonly string[];
  readonly attemptId: AttemptId;
  readonly baseSha: string;              // reconciliation: HEAD==base ⇒ no commit landed
  readonly evidenceId: ArtifactId;       // preallocated, embedded in trailer
  readonly identity: { readonly name: string; readonly email: string };
  readonly extraTrailers?: Record<string, string>;
  // Two-phase side-effect protocol (HIGH-006). The commit is a durable,
  // externally-observable effect (it mints a git object) and MUST be wrapped
  // like push/PR: begin(PENDING) → commit → complete(COMPLETED), keyed by a
  // fingerprint STABLE across re-runs so a crash after the commit but before
  // downstream persistence ADOPTS the recorded SHA + evidence id rather than
  // minting a second, divergent commit with a fresh evidence id.
  readonly log: SideEffectLog;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly leaseId: string;              // fencing token
}

export interface CommitStepResult {
  readonly step: 'commit';
  readonly status: StepStatus;
  readonly commitSha: string;
  // The evidence id ACTUALLY bound to this commit. On a fresh commit this is
  // the caller's preallocated id; on adoption it is the id recorded at first
  // commit (which the caller MUST use downstream so evidence lands at the id
  // embedded in the already-pushed commit's trailer, not a fresh one).
  readonly evidenceId: ArtifactId;
  readonly adopted: boolean;
}

// The commit's identity is the ATTEMPT — a single attempt commits at most once.
// The fingerprint is intentionally independent of the evidence id: a re-run
// preallocates a fresh evidence id, but that must NOT rebind the same attempt's
// commit to different inputs (which would fail the fingerprint guard). The
// committed evidence id is carried in the completion resultRef instead.
function commitFingerprint(attemptId: AttemptId): string {
  return `commit:${attemptId}`;
}

interface CommitResultRef {
  readonly commitSha: string;
  readonly evidenceId: string;
}

export async function commitStep(input: CommitStepInput): Promise<CommitStepResult> {
  const begun = await input.log.begin(input.scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    requestFingerprint: commitFingerprint(input.attemptId),
    ownerToken: input.leaseId,
  });
  // Already COMPLETED for this attempt → adopt the recorded commit SHA + the
  // evidence id embedded in that commit; do NOT mint a second commit.
  if (begun.existed && begun.state === 'COMPLETED' && begun.resultRef) {
    const rec = begun.resultRef as CommitResultRef;
    return {
      step: 'commit',
      status: 'OK',
      commitSha: rec.commitSha,
      evidenceId: rec.evidenceId as ArtifactId,
      adopted: true,
    };
  }
  // Crash-after-commit-before-complete (HIGH-006): the record exists but is
  // still PENDING, so the completion write never landed. Naively falling through
  // would mint a SECOND, divergent commit. Instead reconcile against the
  // worktree: if HEAD already carries this attempt's harness commit (ASEP-Attempt
  // trailer matches and HEAD advanced past base), adopt that commit + the
  // evidence id embedded in its ASEP-Evidence trailer and finish the record.
  if (begun.existed && begun.state === 'PENDING') {
    const found = await input.committer.reconcile(input.scope, {
      workspace: input.workspace,
      attemptId: input.attemptId,
      baseSha: input.baseSha,
    });
    if (found) {
      await input.log.complete(input.scope, {
        operation: 'commit',
        repositoryBindingId: input.repositoryBindingId,
        attemptId: input.attemptId,
        ownerToken: input.leaseId,
        resultRef: { commitSha: found.commitSha, evidenceId: found.evidenceId },
      });
      return {
        step: 'commit',
        status: 'OK',
        commitSha: found.commitSha,
        evidenceId: found.evidenceId as ArtifactId,
        adopted: true,
      };
    }
    // No commit landed before the crash — safe to mint it now under the same
    // PENDING record (complete() below transitions it to COMPLETED).
  }
  const trailers: Record<string, string> = {
    'ASEP-Attempt': input.attemptId,
    'ASEP-Evidence': input.evidenceId,
    ...(input.extraTrailers ?? {}),
  };
  const { commitSha } = await input.committer.commit(input.scope, {
    workspace: input.workspace,
    allowedPaths: input.allowedPaths,
    trailers,
    identity: input.identity,
  });
  // Persist the commit SHA + the evidence id it embeds so a resume adopts BOTH.
  const resultRef: CommitResultRef = { commitSha, evidenceId: input.evidenceId };
  await input.log.complete(input.scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
    resultRef,
  });
  return { step: 'commit', status: 'OK', commitSha, evidenceId: input.evidenceId, adopted: false };
}

// ---------------------------------------------------------------------------
// Step 6 — build + persist the EvidenceBundle at the preallocated id.
//
// resultSha = the harness commit SHA from the commit step (exit D8). The bundle
// is stored AFTER the commit but BEFORE the push; putEvidence is idempotent, so
// a crash between commit and evidence persistence recovers without a second
// commit (re-store of identical bytes is a no-op success).
// ---------------------------------------------------------------------------

export interface EvidenceStepInput {
  readonly store: EvidenceStore;
  readonly scope: TenantScope;
  readonly evidenceId: ArtifactId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly resultSha: string;            // == commit SHA
  readonly change: GitChangeObservation; // diff artifact ref
  readonly environment: EvidenceBundle['environment'];
  readonly executions: readonly VerificationCheckExecution[];
  readonly now?: () => string;           // injectable clock (deterministic tests)
}

export interface EvidenceStepResult {
  readonly step: 'evidence';
  readonly status: StepStatus;
  readonly bundle: EvidenceBundle;
  readonly ref: ArtifactRef;
}

export async function evidenceStep(input: EvidenceStepInput): Promise<EvidenceStepResult> {
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  const bundle: EvidenceBundle = {
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    resultSha: input.resultSha,
    createdAt,
    environment: input.environment,
    diff: {
      artifactId: input.change.diff.artifactId,
      sha256: input.change.diff.sha256,
    },
    checks: input.executions.map((e) => ({
      id: e.id,
      category: e.category,
      command: e.command,
      exitCode: e.exitCode,
      durationMs: e.durationMs,
      ...(e.stdoutArtifactId ? { stdoutArtifactId: e.stdoutArtifactId } : {}),
      ...(e.stderrArtifactId ? { stderrArtifactId: e.stderrArtifactId } : {}),
    })),
  };
  const ref = await input.store.putEvidence(input.scope, input.evidenceId, bundle);
  return { step: 'evidence', status: 'OK', bundle, ref };
}

// ---------------------------------------------------------------------------
// Step 7 — push the exact namespaced ref, wrapped by the two-phase side-effect
// protocol (exit C7). begin(PENDING) → ForgeProvider.pushBranch → complete.
// The semantic key is (repositoryBindingId, attemptId, 'push'); the fencing
// token is the lease id; the natural key is the branch ref for reconciliation.
// If a prior record already COMPLETED this exact effect, the push is adopted,
// not replayed.
// ---------------------------------------------------------------------------

export interface PushStepInput {
  readonly forge: ForgeProvider;
  readonly log: SideEffectLog;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly branch: string;
  readonly commitSha: string;
  readonly leaseId: string;              // fencing token
  readonly expectedRemoteSha?: string;
}

export interface PushStepResult {
  readonly step: 'push';
  readonly status: StepStatus;
  readonly pushed: boolean;              // false when adopted from a COMPLETED record
  readonly adopted: boolean;
}

// Fingerprint the exact inputs so reusing the key with different input fails
// closed inside the SideEffectLog.
function pushFingerprint(input: PushStepInput): string {
  return `push:${input.branch}@${input.commitSha}`;
}

export async function pushStep(input: PushStepInput): Promise<PushStepResult> {
  const begun = await input.log.begin(input.scope, {
    operation: 'push',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    requestFingerprint: pushFingerprint(input),
    ownerToken: input.leaseId,
    naturalKey: input.branch,
  });
  // Already COMPLETED for this exact fingerprint → adopt, do not replay.
  if (begun.existed && begun.state === 'COMPLETED') {
    return { step: 'push', status: 'OK', pushed: false, adopted: true };
  }
  await input.forge.pushBranch(input.scope, {
    repositoryBindingId: input.repositoryBindingId,
    branch: input.branch,
    commitSha: input.commitSha,
    ...(input.expectedRemoteSha ? { expectedRemoteSha: input.expectedRemoteSha } : {}),
  });
  await input.log.complete(input.scope, {
    operation: 'push',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
    naturalKey: input.branch,
  });
  return { step: 'push', status: 'OK', pushed: true, adopted: false };
}

// ---------------------------------------------------------------------------
// Step 8 — create/update the PR idempotently (never merge), wrapped by the same
// two-phase protocol (exit C7). Semantic key (repositoryBindingId, attemptId,
// 'pr-upsert'); natural key the head branch. On adoption the recorded PR ref is
// returned rather than opening a duplicate.
// ---------------------------------------------------------------------------

export interface UpsertPrStepInput {
  readonly forge: ForgeProvider;
  readonly log: SideEffectLog;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly headBranch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly leaseId: string;
}

export interface UpsertPrStepResult {
  readonly step: 'upsert-pr';
  readonly status: StepStatus;
  readonly pr: PullRequestRef;
  readonly adopted: boolean;
}

function prFingerprint(input: UpsertPrStepInput): string {
  return `pr:${input.headBranch}->${input.base}`;
}

export async function upsertPrStep(input: UpsertPrStepInput): Promise<UpsertPrStepResult> {
  const begun = await input.log.begin(input.scope, {
    operation: 'pr-upsert',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    requestFingerprint: prFingerprint(input),
    ownerToken: input.leaseId,
    naturalKey: input.headBranch,
  });
  if (begun.existed && begun.state === 'COMPLETED' && begun.resultRef) {
    return {
      step: 'upsert-pr',
      status: 'OK',
      pr: begun.resultRef as PullRequestRef,
      adopted: true,
    };
  }
  const pr = await input.forge.upsertPullRequest(input.scope, {
    repositoryBindingId: input.repositoryBindingId,
    headBranch: input.headBranch,
    base: input.base,
    title: input.title,
    body: input.body,
  });
  await input.log.complete(input.scope, {
    operation: 'pr-upsert',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
    resultRef: pr,
    naturalKey: input.headBranch,
  });
  return { step: 'upsert-pr', status: 'OK', pr, adopted: false };
}

// ---------------------------------------------------------------------------
// Step 9 — set the task to WAITING_FOR_HUMAN_REVIEW (exit I1). This is the
// harness ceiling: the domain machine has NO transition past it (invariant I2),
// so this step can never advance a task to ACCEPTED/DONE — a human does that
// outside the automation. Pure domain transition; the caller persists it.
// ---------------------------------------------------------------------------

export interface SetReviewStepResult {
  readonly step: 'set-review';
  readonly status: StepStatus;
  readonly task: TaskAggregate;
}

export function setReviewStep(task: TaskAggregate): SetReviewStepResult {
  // VERIFYING → WAITING_FOR_HUMAN_REVIEW. transitionTask throws on any illegal
  // source state, so a task not in VERIFYING fails loudly rather than skipping
  // the review gate.
  const next: TaskStatus = 'WAITING_FOR_HUMAN_REVIEW';
  const advanced = transitionTask(task, next);
  return { step: 'set-review', status: 'OK', task: advanced };
}

// ---------------------------------------------------------------------------
// Post-inspection sequential driver (§11 steps 4-9). Composes the remaining
// steps in order — verify → preallocate → commit → evidence → push → upsert-pr
// → set-review — stopping at the FIRST non-OK step. It is a thin, framework-free
// orchestration: a durable (Temporal-shaped) workflow can drive the SAME steps
// at activity granularity instead. Verification failure STOPS before any commit
// or push (no side effect on a red gate). The terminal success state is always
// WAITING_FOR_HUMAN_REVIEW — never ACCEPTED/DONE (invariant I2).
// ---------------------------------------------------------------------------

export type CompletionStop =
  | 'verify' | 'commit' | 'evidence' | 'push' | 'upsert-pr' | 'complete';

export interface CompleteToReviewInput {
  // Trusted facts from the inspection step (step 3).
  readonly change: GitChangeObservation;
  readonly baseSha: string;
  // Verification.
  readonly runner: CommandRunner;
  readonly sandbox: SandboxProvider;
  readonly mount: WorkspaceMount;
  readonly planId: string;
  readonly risk: RiskLevel;
  readonly checks: readonly VerificationCheckSpec[];
  // Sandbox posture (E8). Forwarded to verifyStep, where an ABSENT value means
  // 'required' — so this driver is fail-closed by default too.
  readonly sandboxRequirement?: SandboxRequirement;
  // Commit.
  readonly committer: GitCommitter;
  readonly scope: TenantScope;
  readonly workspace: WorkspaceCapability;
  readonly allowedPaths: readonly string[];
  readonly identity: { readonly name: string; readonly email: string };
  readonly extraTrailers?: Record<string, string>;
  // Evidence.
  readonly store: EvidenceStore;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly environment: EvidenceBundle['environment'];
  readonly now?: () => string;
  // Push + PR.
  readonly forge: ForgeProvider;
  readonly log: SideEffectLog;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly leaseId: string;
  readonly expectedRemoteSha?: string;
  // Task to advance on success.
  readonly task: TaskAggregate;
}

export interface CompleteToReviewResult {
  readonly stoppedAt: CompletionStop;
  readonly verify: VerifyStepResult;
  readonly commitSha?: string;
  readonly evidence?: EvidenceStepResult;
  readonly push?: PushStepResult;
  readonly pr?: PullRequestRef;
  readonly task?: TaskAggregate;
}

export async function completeToReview(
  input: CompleteToReviewInput,
): Promise<CompleteToReviewResult> {
  // Step 4 — verification. A non-PASS verdict STOPS before any side effect.
  const verify = await verifyStep({
    runner: input.runner,
    sandbox: input.sandbox,
    mount: input.mount,
    planId: input.planId,
    risk: input.risk,
    checks: input.checks,
    ...(input.sandboxRequirement ? { sandboxRequirement: input.sandboxRequirement } : {}),
  });
  if (verify.status === 'STOP') {
    return { stoppedAt: 'verify', verify };
  }

  // Preallocate the non-content-derived evidence id BEFORE the commit so it can
  // be embedded in the ASEP-Evidence trailer (exit D8).
  const evidenceId = input.store.allocateEvidenceId();

  // Step 5 — harness commit, wrapped in the two-phase protocol (HIGH-006). On a
  // resume the commit is ADOPTED: the recorded SHA AND the evidence id embedded
  // in that already-minted commit come back, so we never mint a second commit
  // or a divergent evidence id.
  const commit = await commitStep({
    committer: input.committer,
    scope: input.scope,
    workspace: input.workspace,
    allowedPaths: input.allowedPaths,
    attemptId: input.attemptId,
    evidenceId,
    baseSha: input.baseSha,
    identity: input.identity,
    log: input.log,
    repositoryBindingId: input.repositoryBindingId,
    leaseId: input.leaseId,
    ...(input.extraTrailers ? { extraTrailers: input.extraTrailers } : {}),
  });
  if (commit.status === 'STOP') {
    return { stoppedAt: 'commit', verify, commitSha: commit.commitSha };
  }
  // Downstream evidence MUST land at the id actually embedded in the commit
  // trailer — the adopted id on a resume, the fresh id on first commit.
  const committedEvidenceId = commit.evidenceId;

  // Step 6 — build + persist evidence at the committed id. resultSha is the
  // trusted harness commit SHA (never provider-reported).
  const evidence = await evidenceStep({
    store: input.store,
    scope: input.scope,
    evidenceId: committedEvidenceId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    resultSha: commit.commitSha,
    change: input.change,
    environment: input.environment,
    executions: verify.executions,
    ...(input.now ? { now: input.now } : {}),
  });

  // Step 7 — push the exact namespaced ref (two-phase side-effect protocol).
  const push = await pushStep({
    forge: input.forge,
    log: input.log,
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    branch: input.branch,
    commitSha: commit.commitSha,
    leaseId: input.leaseId,
    ...(input.expectedRemoteSha ? { expectedRemoteSha: input.expectedRemoteSha } : {}),
  });
  if (push.status === 'STOP') {
    return { stoppedAt: 'push', verify, commitSha: commit.commitSha, evidence, push };
  }

  // Step 8 — idempotent PR upsert (never merge).
  const upsert = await upsertPrStep({
    forge: input.forge,
    log: input.log,
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    headBranch: input.branch,
    base: input.base,
    title: input.title,
    body: input.body,
    leaseId: input.leaseId,
  });
  if (upsert.status === 'STOP') {
    return {
      stoppedAt: 'upsert-pr',
      verify,
      commitSha: commit.commitSha,
      evidence,
      push,
      pr: upsert.pr,
    };
  }

  // Step 9 — set the task to WAITING_FOR_HUMAN_REVIEW (harness ceiling).
  const review = setReviewStep(input.task);

  return {
    stoppedAt: 'complete',
    verify,
    commitSha: commit.commitSha,
    evidence,
    push,
    pr: upsert.pr,
    task: review.task,
  };
}
