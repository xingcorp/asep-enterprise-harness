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

import { createHash } from 'node:crypto';
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
  CommandProvenance,
  SandboxProvider,
  WorkspaceMount,
  WorkspaceCapability,
  GitCommitter,
  ForgeProvider,
  PullRequestRef,
  GitChangeObservation,
  EvidenceStore,
  EvidenceDraft,
  SideEffectLog,
  SideEffectRecord,
  PullRequestResultRef,
  PullRequestFacts,
} from '@asep/ports';
import {
  parseSideEffectResultRef, SideEffectResultRefError, evidenceBundleFrom, pullRequestContent,
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
  // Where the runner ran it; absent when the runner could not say.
  readonly provenance?: CommandProvenance;
}

export interface VerifyStepInput {
  readonly runner: CommandRunner;
  readonly sandbox: SandboxProvider;
  readonly mount: WorkspaceMount;
  readonly planId: string;
  readonly risk: RiskLevel;
  readonly checks: readonly VerificationCheckSpec[];
  // OS-enforced sandbox isolation is MANDATORY (exit E8). There is no input
  // that relaxes it: a sandbox whose handle does not claim `isolationEnforced:
  // true` is refused before any command runs.
  // Per-command observability (disp. P2-FINAL-MED-003, exit J1). Each
  // verification command is a privileged boundary: it executes an argv inside the
  // sandbox and its raw output becomes evidence. `command.execute` was one of the
  // seven declared spans that never fired, so a run left no per-command trace at
  // all. Injected (not built here) because this module is pure — see
  // ObserveBoundary. Absent → the loop runs exactly as before.
  readonly observe?: ObserveBoundary;
}

// Isolation is mandatory, but the started sandbox does not enforce it. Thrown
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

// A durable evidence bundle was found at the committed evidence id, but its
// HARNESS-OWNED identity disagrees with the attempt now resuming (disp.
// P2-REREVIEW HIGH-006, exit D8).
//
// Thrown rather than returned: an adopted bundle flows straight on to push, PR
// and WAITING_FOR_HUMAN_REVIEW, so a mismatched one would put a human in front
// of evidence describing a DIFFERENT commit. There is no safe way to continue.
export class EvidenceIdentityMismatchError extends Error {
  constructor(evidenceId: string, field: string, persisted: string, expected: string) {
    super(
      `evidence ${evidenceId} cannot be adopted: persisted ${field} '${persisted}' ` +
        `!= this attempt's '${expected}' — refusing to attach evidence for another commit`,
    );
    this.name = 'EvidenceIdentityMismatchError';
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
  // E8: refuse a STARTED handle that does not claim isolation BEFORE any
  // command runs. The check reads the port's own `isolationEnforced` flag
  // (declared on SandboxHandle, so no adapter type is imported) and treats an
  // ABSENT flag as NOT enforced — unknown isolation is never a permission. On
  // breach the sandbox is stopped and the step throws. The flag is only a
  // claim: a handle that makes it falsely is refused by the trusted runner,
  // which runs a command only for a handle its own sandbox provider made.
  if (handle.isolationEnforced !== true) {
    await input.sandbox.stop(handle);
    throw new SandboxIsolationRequiredError(handle.sandboxId, handle.profile);
  }
  const executions: VerificationCheckExecution[] = [];
  // Absent observer → run directly, so every existing caller is unchanged.
  const observe: ObserveBoundary = input.observe ?? ((_b, fn) => fn());
  try {
    for (const check of input.checks) {
      // Each verification command is a privileged boundary (J1 `command.execute`).
      // It was declared but never emitted: an operator could see that a check ran
      // only by reading the evidence bundle afterwards, with no span for the
      // execution itself.
      const r = await observe(
        {
          span: 'command.execute',
          action: 'command.execute',
          detail: { checkId: check.id, level: check.level, command: commandText(check.command) },
        },
        () => input.runner.run(check.command, handle),
      );
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
        ...(r.provenance ? { provenance: r.provenance } : {}),
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

// What verification ran, where and with what outcome: the harness's record of
// a verification, kept beside the evidence so a reader (the pilot verifier) can
// check each evidence check ran in the pinned sandbox and that every check the
// plan made mandatory passed. The evidence bundle's closed schema has no room
// for either, so the record is its own artifact of the attempt.
export interface VerificationProvenance {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly planId: string;
  readonly risk: RiskLevel;
  readonly verdict: VerificationResult['verdict'];
  readonly checks: readonly {
    readonly id: string;
    readonly level: AssuranceLevel | null;
    readonly mandatory: boolean;
    readonly verdict: VerificationCheckExecution['verdict'];
    readonly command: string;
    readonly exitCode: number;
    readonly stdoutArtifactId: ArtifactId | null;
    readonly stderrArtifactId: ArtifactId | null;
    readonly provenance: CommandProvenance | null;
  }[];
}

/** The provenance record of a verification, check for check in its order. */
export function verificationProvenance(input: {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly planId: string;
  readonly risk: RiskLevel;
  readonly checks: readonly VerificationCheckSpec[];
  readonly verify: VerifyStepResult;
}): VerificationProvenance {
  return {
    taskId: input.taskId,
    attemptId: input.attemptId,
    planId: input.planId,
    risk: input.risk,
    verdict: input.verify.result.verdict,
    checks: input.verify.executions.map((e) => ({
      id: e.id,
      level: input.checks.find((c) => c.id === e.id)?.level ?? null,
      mandatory: e.mandatory,
      verdict: e.verdict,
      command: e.command,
      exitCode: e.exitCode,
      stdoutArtifactId: e.stdoutArtifactId ?? null,
      stderrArtifactId: e.stderrArtifactId ?? null,
      provenance: e.provenance ?? null,
    })),
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
  readonly baseSha: string;              // the commit's parent; reconciliation key with the attempt
  readonly evidenceId: ArtifactId;       // reserved, embedded in trailer
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

export async function commitStep(input: CommitStepInput): Promise<CommitStepResult> {
  const begun = await input.log.begin(input.scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    requestFingerprint: commitFingerprint(input.attemptId),
    ownerToken: input.leaseId,
  });
  const settled = await settleCommit(begun, input);
  if (settled !== null) return settled;
  // No commit landed for this attempt — safe to mint it now under the PENDING
  // record (complete() below transitions it to COMPLETED). The committer
  // records it create-only under the attempt, so this is the attempt's only
  // commit even if a stale executor tries again.
  const trailers: Record<string, string> = {
    'ASEP-Attempt': input.attemptId,
    'ASEP-Evidence': input.evidenceId,
    ...(input.extraTrailers ?? {}),
  };
  // Still the owner, with a live lease, at the moment of committing.
  await input.log.confirmOwner(input.scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
  });
  const { commitSha } = await input.committer.commit(input.scope, {
    workspace: input.workspace,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    allowedPaths: input.allowedPaths,
    trailers,
    identity: input.identity,
  });
  // Persist the commit SHA + the evidence id it embeds so a resume adopts BOTH.
  await input.log.complete(input.scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
    resultRef: { kind: 'commit', commitSha, evidenceId: input.evidenceId },
  });
  return { step: 'commit', status: 'OK', commitSha, evidenceId: input.evidenceId, adopted: false };
}

// An existing commit record, settled without committing: a COMPLETED record is
// adopted as a fact; a PENDING one (the executor died after `begin`, maybe after
// the commit itself) is reconciled against the attempt's recorded commit and,
// when one landed, completed with it. Null when no commit landed.
async function settleCommit(
  begun: SideEffectRecord,
  input: {
    readonly committer: Pick<GitCommitter, 'reconcile'>;
    readonly log: SideEffectLog;
    readonly scope: TenantScope;
    readonly repositoryBindingId: RepositoryBindingId;
    readonly attemptId: AttemptId;
    readonly baseSha: string;
    readonly leaseId: string;
  },
): Promise<CommitStepResult | null> {
  // Already COMPLETED for this attempt → adopt the recorded commit SHA + the
  // evidence id embedded in that commit; do NOT mint a second commit.
  if (begun.existed && begun.state === 'COMPLETED' && begun.resultRef) {
    // VALIDATED read (disp. P2-REVIEW HIGH-005). This was a blind `as` cast, so a
    // truncated/foreign JSONB row surfaced as undefined fields deep inside the
    // pipeline — the adopted commit SHA could be `undefined` and get pushed as a
    // ref. The parser pins the expected shape and throws instead.
    const rec = parseSideEffectResultRef(begun.resultRef, 'commit');
    return {
      step: 'commit',
      status: 'OK',
      commitSha: rec.commitSha,
      evidenceId: rec.evidenceId as ArtifactId,
      adopted: true,
    };
  }
  // Crash-after-commit-before-complete: the record exists but is still
  // PENDING, so the completion write never landed. Naively committing would
  // mint a SECOND, divergent commit. Instead ask for the attempt's recorded
  // commit; when there is one, adopt it + the evidence id in its ASEP-Evidence
  // trailer and finish the record.
  if (begun.existed && begun.state === 'PENDING') {
    const found = await input.committer.reconcile(input.scope, {
      attemptId: input.attemptId,
      baseSha: input.baseSha,
    });
    if (found) {
      await input.log.complete(input.scope, {
        operation: 'commit',
        repositoryBindingId: input.repositoryBindingId,
        attemptId: input.attemptId,
        ownerToken: input.leaseId,
        resultRef: { kind: 'commit', commitSha: found.commitSha, evidenceId: found.evidenceId },
      });
      return {
        step: 'commit',
        status: 'OK',
        commitSha: found.commitSha,
        evidenceId: found.evidenceId as ArtifactId,
        adopted: true,
      };
    }
  }
  return null;
}

// The resume's commit step: it holds no workspace, so it can only settle the
// commit an executor already began — take the record over under the resume's
// lease, then adopt or reconcile it. Null when no commit landed (the attempt
// has to be re-executed; nothing left the harness before the commit).
export async function settleCommitStep(input: {
  readonly committer: Pick<GitCommitter, 'reconcile'>;
  readonly log: SideEffectLog;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly leaseId: string;
}): Promise<CommitStepResult | null> {
  const begun = await input.log.begin(input.scope, {
    operation: 'commit',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    requestFingerprint: commitFingerprint(input.attemptId),
    ownerToken: input.leaseId,
  });
  return settleCommit(begun, input);
}

// ---------------------------------------------------------------------------
// Step 6 — persist the EvidenceBundle at the reserved id.
//
// The evidence is fixed BEFORE the commit: the driver reserves the evidence id
// with its draft (everything but resultSha), and the commit names that id. This
// step completes the reserved draft with resultSha = the harness commit SHA
// (exit D8) and stores it AFTER the commit but BEFORE the push. It never
// re-derives evidence, so a crash between commit and evidence persistence — in
// this process or a successor — recovers to the same bytes without a second
// commit.
// ---------------------------------------------------------------------------

export interface EvidenceStepInput {
  readonly store: EvidenceStore;
  readonly scope: TenantScope;
  readonly evidenceId: ArtifactId;       // the reservation the commit names
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly resultSha: string;            // == commit SHA
}

/** The evidence draft for a verified change: the bundle minus resultSha. */
export function evidenceDraft(input: {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly baseSha: string;
  readonly change: GitChangeObservation;
  readonly environment: EvidenceBundle['environment'];
  readonly executions: readonly VerificationCheckExecution[];
  readonly createdAt: string;
}): EvidenceDraft {
  return {
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    createdAt: input.createdAt,
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
}

export interface EvidenceStepResult {
  readonly step: 'evidence';
  readonly status: StepStatus;
  readonly bundle: EvidenceBundle;
  readonly ref: ArtifactRef;
  // True when a bundle already existed at the preallocated id and was adopted
  // rather than re-derived (disp. P2-REREVIEW HIGH-006). Lets a caller assert
  // crash-resume behaviour instead of inferring it.
  readonly adopted: boolean;
}

// Does this error mean "no evidence bundle is stored at that id yet"?
//
// The application layer must not import a persistence class (exit B3), so the
// absent case is recognised structurally: the store's not-found error carries
// that name. Matched on `name` (and a conservative message fallback) so any
// EvidenceStore implementation can signal absence without this module depending
// on the adapter. Everything else — integrity failure, scope violation — is NOT
// absence and is rethrown by the caller.
export function isEvidenceAbsent(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  if (name === 'EvidenceNotFoundError') return true;
  const msg = err instanceof Error ? err.message : '';
  return /evidence (bundle )?not found/i.test(msg);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Adopt an evidence bundle already stored at `expected.evidenceId`, but only if
 * it describes THIS attempt's commit: task, attempt, base SHA and result SHA
 * must all match the harness-owned values. Throws EvidenceIdentityMismatchError
 * otherwise. Shared by the evidence step and by a resume, which both adopt a
 * bundle someone else wrote.
 */
export function adoptVerifiedEvidence(
  existing: EvidenceBundle,
  expected: {
    readonly evidenceId: ArtifactId;
    readonly taskId: TaskId;
    readonly attemptId: AttemptId;
    readonly baseSha: string;
    readonly resultSha: string;
  },
): EvidenceStepResult {
  const fields: readonly (readonly [string, string, string])[] = [
    ['taskId', String(existing.taskId), String(expected.taskId)],
    ['attemptId', String(existing.attemptId), String(expected.attemptId)],
    ['baseSha', String(existing.baseSha), String(expected.baseSha)],
    ['resultSha', String(existing.resultSha), String(expected.resultSha)],
  ];
  const first = fields.find(([, persisted, want]) => persisted !== want);
  if (first !== undefined) {
    throw new EvidenceIdentityMismatchError(
      String(expected.evidenceId), first[0], first[1], first[2],
    );
  }
  return {
    step: 'evidence',
    status: 'OK',
    bundle: existing,
    // The ref is reconstructed from the adopted bundle's own bytes, so the
    // caller receives the same (id, sha256) pair the first write recorded.
    ref: {
      artifactId: expected.evidenceId,
      sha256: sha256Hex(new TextEncoder().encode(JSON.stringify(existing))),
      kind: 'evidence-bundle',
    },
    adopted: true,
  };
}

export async function evidenceStep(input: EvidenceStepInput): Promise<EvidenceStepResult> {
  // Crash-recovery reconciliation for the evidence write (exit D8).
  //
  // The evidence for a commit is fixed BEFORE the commit: the draft (diff,
  // checks, environment, clock) is reserved with the evidence id the commit's
  // trailer names, and the bundle is that draft plus the commit SHA. So the
  // step never derives evidence; it either adopts what is stored at the id or
  // completes the reservation, and any writer — the first run or a resume
  // after a crash between commit and evidence — produces the same bytes.
  //
  // Ask the authoritative store first. Any error other than "not found"
  // propagates — a corrupt or cross-scope read must fail closed, never be
  // papered over by writing.
  try {
    const existing = await input.store.getEvidence(input.scope, input.evidenceId);

    // VERIFY BEFORE ADOPTING (disp. P2-REREVIEW HIGH-006).
    //
    // Finding the id resolvable is not the same as it describing THIS attempt.
    // The id comes from the resumed commit's ASEP-Evidence trailer, and the
    // adopted bundle is returned as this attempt's evidence — it then flows into
    // push, the PR body and WAITING_FOR_HUMAN_REVIEW. So an unchecked adoption
    // puts a reviewer in front of evidence for a different commit while every
    // downstream step reports success.
    //
    // All four fields compared here are HARNESS-OWNED: taskId/attemptId are
    // pre-created by the harness, baseSha is the pinned checkout, and resultSha
    // is the commit SHA read back by trusted inspection. None is
    // provider-reported, so this cannot be satisfied by anything the agent says.
    // The rest of the bundle needs no comparison here: the store only accepts,
    // at a reserved id, that reservation's draft completed by a resultSha.
    return adoptVerifiedEvidence(existing, input);
  } catch (err) {
    // An identity mismatch is a REAL fault, not an absence. Re-throw before the
    // absence check below so it can never be mistaken for "safe to write".
    if (err instanceof EvidenceIdentityMismatchError) throw err;
    // Only an ABSENT bundle means "safe to write". The store signals that with a
    // not-found error; anything else (integrity failure, scope violation) is a
    // real fault and must not be swallowed.
    if (!isEvidenceAbsent(err)) throw err;
  }

  const { draft } = await input.store.getReservation(input.scope, input.evidenceId);
  // The draft's harness-owned identity must be this attempt's, or the commit
  // names evidence reserved for something else.
  const fields: readonly (readonly [string, string, string])[] = [
    ['taskId', String(draft.taskId), String(input.taskId)],
    ['attemptId', String(draft.attemptId), String(input.attemptId)],
    ['baseSha', String(draft.baseSha), String(input.baseSha)],
  ];
  const first = fields.find(([, reserved, want]) => reserved !== want);
  if (first !== undefined) {
    throw new EvidenceIdentityMismatchError(String(input.evidenceId), first[0], first[1], first[2]);
  }
  const bundle = evidenceBundleFrom(draft, input.resultSha);
  const ref = await input.store.putEvidence(input.scope, input.evidenceId, bundle);
  return { step: 'evidence', status: 'OK', bundle, ref, adopted: false };
}

// ---------------------------------------------------------------------------
// Step 7 — push the exact namespaced ref, wrapped by the two-phase side-effect
// protocol (exit C7). begin(PENDING) → ForgeProvider.pushBranch → complete.
// The semantic key is (repositoryBindingId, attemptId, 'push'); the fencing
// token is the lease id; the natural key is the branch ref for reconciliation.
// If a prior record already COMPLETED this exact effect, the push is adopted,
// not replayed.
//
// The push itself is compare-and-set: it expects the attempt branch to be
// absent, and writes the attempt's one commit. A late push by a stale owner of
// that same commit changes nothing; a push of anything else over it is refused
// by the remote.
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
}

// The attempt branch holds a commit that is not the attempt's. Nothing the
// harness writes puts it there, so the push step refuses to publish over it;
// a takeover repairs it from the facts (reconcileBranchStep), on record.
export class RemoteBranchDivergedError extends Error {
  constructor(branch: string, found: string, commitSha: string) {
    super(`attempt branch ${branch} holds ${found}, not the attempt's commit ${commitSha} — refusing to publish over it`);
    this.name = 'RemoteBranchDivergedError';
  }
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
  // Already COMPLETED for this exact fingerprint → adopt, do not replay. The
  // recorded outcome is parsed, not assumed: a record naming another branch or
  // commit is not this push, whatever its fingerprint says.
  if (begun.existed && begun.state === 'COMPLETED') {
    const rec = parseSideEffectResultRef(begun.resultRef, 'push');
    if (rec.branch !== input.branch || rec.commitSha !== input.commitSha) {
      throw new SideEffectResultRefError(
        'push',
        `recorded ${rec.branch}@${rec.commitSha} is not ${input.branch}@${input.commitSha}`,
      );
    }
    return { step: 'push', status: 'OK', pushed: false, adopted: true };
  }
  // Crash-after-push-before-complete (HIGH-006): the record is still PENDING, so
  // we cannot tell from the log alone whether the ref reached the remote. Ask the
  // REMOTE (natural key = the branch) before re-pushing. When the ref already
  // points at exactly this commit the push landed, so adopt it and finish the
  // record instead of re-calling the forge.
  if (begun.existed && begun.state === 'PENDING') {
    const remoteSha = await input.forge.resolveRef(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      branch: input.branch,
    });
    if (remoteSha === input.commitSha) {
      await input.log.complete(input.scope, {
        operation: 'push',
        repositoryBindingId: input.repositoryBindingId,
        attemptId: input.attemptId,
        ownerToken: input.leaseId,
        naturalKey: input.branch,
        resultRef: { kind: 'push', branch: input.branch, commitSha: input.commitSha },
      });
      return { step: 'push', status: 'OK', pushed: false, adopted: true };
    }
    // Pointing elsewhere → not this attempt's push; refuse rather than publish
    // over it. Absent → the push for THIS commit did not land; performing it
    // below is safe (pushBranch still enforces ref safety and the lease).
    if (remoteSha !== null) throw new RemoteBranchDivergedError(input.branch, remoteSha, input.commitSha);
  }
  // Ownership is confirmed just before the call: an executor whose record was
  // taken over while it was paused before this point is refused here. One that
  // stalls inside the call is held by the lease: the branch must still be
  // absent, or already hold this very commit.
  await input.log.confirmOwner(input.scope, {
    operation: 'push',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
  });
  await input.forge.pushBranch(input.scope, {
    repositoryBindingId: input.repositoryBindingId,
    branch: input.branch,
    commitSha: input.commitSha,
    expectedRemoteSha: null,
  });
  await input.log.complete(input.scope, {
    operation: 'push',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
    naturalKey: input.branch,
    resultRef: { kind: 'push', branch: input.branch, commitSha: input.commitSha },
  });
  return { step: 'push', status: 'OK', pushed: true, adopted: false };
}

// ---------------------------------------------------------------------------
// Step 8 — create/update the PR idempotently (never merge), wrapped by the same
// two-phase protocol (exit C7). Semantic key (repositoryBindingId, attemptId,
// 'pr-upsert'); natural key the head branch. On adoption the recorded PR ref is
// returned rather than opening a duplicate.
//
// The PR's title and body are pullRequestContent of the attempt's immutable
// facts — never caller-supplied text — so every owner of the attempt writes
// the same PR, and a stale owner's late write changes nothing.
// ---------------------------------------------------------------------------

export interface UpsertPrStepInput {
  readonly forge: ForgeProvider;
  readonly log: SideEffectLog;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly headBranch: string;
  readonly base: string;
  // The verified harness commit and the evidence id its trailer names.
  readonly commitSha: string;
  readonly evidenceId: string;
  readonly leaseId: string;
}

/** The facts an attempt's pull request presents. */
export function pullRequestFactsOf(input: {
  readonly taskId: TaskId; readonly attemptId: AttemptId; readonly commitSha: string;
  readonly evidenceId: string; readonly base: string;
}): PullRequestFacts {
  return {
    taskId: input.taskId, attemptId: input.attemptId, commitSha: input.commitSha,
    evidenceId: input.evidenceId, base: input.base,
  };
}

/**
 * Why a PR is not the attempt's reviewable publication, or undefined when it
 * is: open, unmerged and on the attempt's base, as the forge reported them. A
 * state the forge did not report is not taken as open. A closed or merged PR
 * was closed by a human and is never reopened; a PR on another base shows the
 * change against something the attempt was not verified against.
 */
export function pullRequestGap(pr: PullRequestRef, facts: PullRequestFacts): string | undefined {
  const which = `PR #${pr.number}`;
  if (pr.merged === true) return `${which} is merged`;
  if (pr.state === 'closed') return `${which} is closed`;
  if (pr.state !== 'open') return `${which}: the forge did not report it open`;
  if (pr.merged !== false) return `${which}: the forge did not report it unmerged`;
  if (pr.baseBranch !== facts.base) return `${which} targets ${pr.baseBranch}, not the attempt's base ${facts.base}`;
  return undefined;
}

/** What a PR was found to be, for the audit record of a publication that failed. */
export function pullRequestFound(pr: PullRequestRef): Readonly<Record<string, unknown>> {
  return {
    number: pr.number, url: pr.url, headBranch: pr.headBranch, baseBranch: pr.baseBranch,
    state: pr.state ?? null, merged: pr.merged ?? null,
  };
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

// The closed record of a PR upsert. Built field by field rather than spreading
// the forge's answer, so whatever else a forge returns (head SHA, state, …)
// never leaks into the authoritative row.
function prResult(pr: PullRequestRef): PullRequestResultRef {
  return {
    kind: 'pr-upsert',
    number: pr.number,
    url: pr.url,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
  };
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
    // PARSE, never cast (disp. P2-REREVIEW HIGH-005, exit D6).
    //
    // THE DEFECT. This was `begun.resultRef as PullRequestRef` — a compile-time
    // assertion over a JSONB column, which checks nothing at runtime. Verified
    // empirically, the cast adopted every one of these: a payload with `number`
    // missing entirely, `number` as the STRING "42", a truncated row with no
    // `url`, and — worst — a COMMIT result ref (`{kind:'commit',commitSha,…}`)
    // adopted as though it were a pull request.
    //
    // That is not cosmetic. The adopted `pr` flows straight into
    // `pullRequests.upsert({ number: pr.number, … })` and into the slice's
    // `prNumber` result, so a foreign or truncated row becomes a persisted PR
    // row claiming `number: undefined` while every step still reports OK.
    //
    // The parser already exists and already handles 'pr-upsert'; the commit path
    // adopted it and this one did not. It pins the discriminator and validates
    // every field (positive integer number, non-empty url/branches), so a
    // mismatched payload throws instead of being coerced.
    const rec = parseSideEffectResultRef(begun.resultRef, 'pr-upsert');
    return {
      step: 'upsert-pr',
      status: 'OK',
      pr: {
        number: rec.number,
        url: rec.url,
        headBranch: rec.headBranch,
        baseBranch: rec.baseBranch,
      },
      adopted: true,
    };
  }
  // Crash-after-upsert-before-complete (HIGH-006): a PENDING record cannot tell
  // us whether the PR was already opened. Ask the FORGE by natural key (the head
  // branch) before calling upsert again, and adopt an existing PR so a resume
  // converges on ONE pull request.
  if (begun.existed && begun.state === 'PENDING') {
    const existing = await input.forge.findPullRequest(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      headBranch: input.headBranch,
    });
    if (existing) {
      await input.log.complete(input.scope, {
        operation: 'pr-upsert',
        repositoryBindingId: input.repositoryBindingId,
        attemptId: input.attemptId,
        ownerToken: input.leaseId,
        resultRef: prResult(existing),
        naturalKey: input.headBranch,
      });
      return { step: 'upsert-pr', status: 'OK', pr: existing, adopted: true };
    }
    // No PR for this head branch → the upsert did not land; safe to perform.
  }
  // Ownership is confirmed just before the call. GitHub has no compare-and-set
  // for a PR, so an owner that stalls inside the call can still write after a
  // takeover — the same content, because the content is the facts'.
  await input.log.confirmOwner(input.scope, {
    operation: 'pr-upsert',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
  });
  const { title, body } = pullRequestContent(pullRequestFactsOf(input));
  const pr = await input.forge.upsertPullRequest(input.scope, {
    repositoryBindingId: input.repositoryBindingId,
    headBranch: input.headBranch,
    base: input.base,
    title,
    body,
  });
  await input.log.complete(input.scope, {
    operation: 'pr-upsert',
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    ownerToken: input.leaseId,
    resultRef: prResult(pr),
    naturalKey: input.headBranch,
  });
  return { step: 'upsert-pr', status: 'OK', pr, adopted: false };
}

// ---------------------------------------------------------------------------
// Reconciliation after a takeover. A stale owner may still reach the forge, so
// before any terminal state the successor reads the attempt branch and its PR
// and makes them what the attempt's facts say: the branch at the attempt's
// commit, the PR open on it with pullRequestContent of the facts and the base.
// Each repair is a privileged effect of its own ('forge.reconcile'), recorded
// with what was found. The branch is repaired with a compare-and-set on the
// value found, so a writer racing the repair is refused, not overwritten.
// ---------------------------------------------------------------------------

export interface ReconcileRemoteInput {
  readonly forge: ForgeProvider;
  readonly scope: TenantScope;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly branch: string;
  readonly facts: PullRequestFacts;
  readonly observe: ObserveBoundary;
}

export interface ReconcileBranchResult {
  readonly found: string | null;
  readonly repaired: boolean;
}

/**
 * Put the attempt branch back on the attempt's commit when it holds another
 * one. `absent` says what an absent branch means: 'repair' publishes the
 * commit; 'leave' leaves it to the push step, whose record it is.
 */
export async function reconcileBranchStep(
  input: ReconcileRemoteInput, absent: 'repair' | 'leave',
): Promise<ReconcileBranchResult> {
  const found = await input.forge.resolveRef(input.scope, {
    repositoryBindingId: input.repositoryBindingId, branch: input.branch,
  });
  if (found === input.facts.commitSha || (found === null && absent === 'leave')) {
    return { found, repaired: false };
  }
  await input.observe(
    {
      span: 'forge.push', action: 'forge.reconcile',
      detail: { target: 'branch', branch: input.branch, found, commitSha: input.facts.commitSha },
    },
    () => input.forge.pushBranch(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      branch: input.branch,
      commitSha: input.facts.commitSha,
      expectedRemoteSha: found,
    }),
  );
  return { found, repaired: true };
}

export interface ReconcilePullRequestResult {
  readonly pr: PullRequestRef;
  readonly repaired: boolean;
  // Set when the PR is not the attempt's reviewable publication
  // (pullRequestGap): the caller must not complete to review.
  readonly gap?: string;
}

/**
 * Make the attempt's PR exist with the facts' content, and say whether it is
 * a reviewable publication. Only an open, unmerged PR on the attempt's base is
 * ever written: a closed or merged one is a human's decision and a PR on
 * another base is not the attempt's, so either is reported as a gap, as found.
 */
export async function reconcilePullRequestStep(input: ReconcileRemoteInput): Promise<ReconcilePullRequestResult> {
  const content = pullRequestContent(input.facts);
  const found = await input.forge.findPullRequest(input.scope, {
    repositoryBindingId: input.repositoryBindingId, headBranch: input.branch,
  });
  if (found !== null) {
    const gap = pullRequestGap(found, input.facts);
    if (gap !== undefined) return { pr: found, repaired: false, gap };
    if (found.title === content.title && found.body === content.body) return { pr: found, repaired: false };
  }
  const pr = await input.observe(
    {
      span: 'forge.pull_request', action: 'forge.reconcile',
      detail: {
        target: 'pull-request', headBranch: input.branch, base: input.facts.base,
        found: found === null ? null : {
          number: found.number, baseBranch: found.baseBranch,
          titleMatches: found.title === content.title, bodyMatches: found.body === content.body,
        },
      },
    },
    () => input.forge.upsertPullRequest(input.scope, {
      repositoryBindingId: input.repositoryBindingId,
      headBranch: input.branch,
      base: input.facts.base,
      title: content.title,
      body: content.body,
    }),
  );
  const gap = pullRequestGap(pr, input.facts);
  return { pr, repaired: true, ...(gap !== undefined ? { gap } : {}) };
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
  readonly leaseId: string;
  // Task to advance on success.
  readonly task: TaskAggregate;
  // Keeps the record of where a PASSED verification ran (see
  // VerificationProvenance), before the evidence is reserved: no evidence of
  // this attempt exists without it. Absent → nothing is recorded.
  readonly recordVerification?: (record: VerificationProvenance) => Promise<void>;

  // --- OBSERVABILITY (disp. P2-FINAL-MED-003, exit J1/J4) --------------------
  //
  // THE FINDING. Ten span names are declared in SPAN_NAMES, but only three were
  // ever emitted at runtime — workspace.lease, workspace.create and agent.invoke,
  // all of them in governedExecution. This driver, which owns every remaining
  // privileged boundary (the harness commit, the evidence write, the push, the
  // PR upsert and each verification command), had no tracer or audit parameter at
  // all. So J1/J4 were satisfied by the EXISTENCE of instrumentation code rather
  // than by real emission, and an operator auditing a run would find no record of
  // the four effects that actually touch the outside world.
  //
  // `observe` is injected rather than built here because this module is pure: it
  // must not know about SpanTracer, AuditSink or a clock. The workflow supplies a
  // wrapper that emits the paired span + audit row and then runs the effect;
  // omitting it leaves every step byte-for-byte unchanged, so all existing
  // callers and both K1 proofs are unaffected.
  readonly observe?: ObserveBoundary;
}

// One privileged boundary: emit its span + audit row, then run it. The span and
// action names are supplied by the caller because the closed sets live in
// @asep/observability, which this pure module deliberately does not import.
export type ObserveBoundary = <T>(
  boundary: {
    readonly span: string;
    readonly action: string;
    readonly detail: Readonly<Record<string, unknown>>;
  },
  fn: () => Promise<T>,
) => Promise<T>;

export interface CompleteToReviewResult {
  readonly stoppedAt: CompletionStop;
  // Why the driver stopped where it did, when a step said.
  readonly reason?: string;
  // Set when the PR is not a reviewable publication (pullRequestGap): what was
  // found instead. The caller fails the task; it never completes it to review.
  readonly gap?: string;
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
  // Absent `observe` → a transparent pass-through, so every existing caller and
  // both K1 proofs behave exactly as before. Present → the workflow's wrapper
  // emits the paired span + audit row around the effect.
  const observe: ObserveBoundary = input.observe ?? ((_b, fn) => fn());

  // Step 4 — verification. A non-PASS verdict STOPS before any side effect.
  const verify = await verifyStep({
    runner: input.runner,
    sandbox: input.sandbox,
    mount: input.mount,
    planId: input.planId,
    risk: input.risk,
    checks: input.checks,
    // Forwarded so each verification command emits its own command.execute span
    // (MED-003). Absent → verifyStep runs commands directly, unchanged.
    ...(input.observe ? { observe: input.observe } : {}),
  });
  if (verify.status === 'STOP') {
    return { stoppedAt: 'verify', verify };
  }
  if (input.recordVerification) {
    const record = verificationProvenance({
      taskId: input.taskId, attemptId: input.attemptId, planId: input.planId, risk: input.risk,
      checks: input.checks, verify,
    });
    await observe(
      { span: 'artifact.put', action: 'artifact.put', detail: { kind: 'verification-provenance' } },
      () => input.recordVerification!(record),
    );
  }

  // Reserve the non-content-derived evidence id BEFORE the commit so it can be
  // embedded in the ASEP-Evidence trailer (exit D8). The reservation is durable
  // and holds the draft — what was verified, against which change and where —
  // so the evidence for the commit is fixed before the commit exists.
  const evidenceId = await input.store.reserveEvidence(input.scope, {
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    draft: evidenceDraft({
      taskId: input.taskId,
      attemptId: input.attemptId,
      baseSha: input.baseSha,
      change: input.change,
      environment: input.environment,
      executions: verify.executions,
      createdAt: (input.now ?? (() => new Date().toISOString()))(),
    }),
  });

  // Step 5 — harness commit, wrapped in the two-phase protocol (HIGH-006). On a
  // resume the commit is ADOPTED: the recorded SHA AND the evidence id embedded
  // in that already-minted commit come back, so we never mint a second commit
  // or a divergent evidence id.
  const commit = await observe(
    { span: 'git.commit', action: 'git.commit', detail: { baseSha: input.baseSha } },
    () => commitStep({
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
    }),
  );
  if (commit.status === 'STOP') {
    return { stoppedAt: 'commit', verify, commitSha: commit.commitSha };
  }
  // Downstream evidence MUST land at the id actually embedded in the commit
  // trailer — the adopted id on a resume, the fresh id on first commit.
  const committedEvidenceId = commit.evidenceId;

  // Step 6 — persist evidence at the committed id: the draft reserved for it,
  // completed by the trusted harness commit SHA (never provider-reported).
  const evidence = await observe(
    { span: 'artifact.put', action: 'evidence.put', detail: { evidenceId: committedEvidenceId } },
    () => evidenceStep({
    store: input.store,
    scope: input.scope,
    evidenceId: committedEvidenceId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    resultSha: commit.commitSha,
    }),
  );

  // Step 7 — push the exact namespaced ref (two-phase side-effect protocol).
  const push = await observe(
    { span: 'forge.push', action: 'forge.push', detail: { branch: input.branch, commitSha: commit.commitSha } },
    () => pushStep({
    forge: input.forge,
    log: input.log,
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    attemptId: input.attemptId,
    branch: input.branch,
    commitSha: commit.commitSha,
    leaseId: input.leaseId,
    }),
  );
  if (push.status === 'STOP') {
    return { stoppedAt: 'push', verify, commitSha: commit.commitSha, evidence, push };
  }

  // Step 8 — idempotent PR upsert (never merge).
  const upsert = await observe(
    {
      span: 'forge.pull_request', action: 'forge.pull_request.upsert',
      detail: { headBranch: input.branch, base: input.base },
    },
    () => upsertPrStep({
    forge: input.forge,
    log: input.log,
    scope: input.scope,
    repositoryBindingId: input.repositoryBindingId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    headBranch: input.branch,
    base: input.base,
    commitSha: commit.commitSha,
    evidenceId: committedEvidenceId,
    leaseId: input.leaseId,
    }),
  );
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
  // Only an open, unmerged PR on the attempt's base is a publication to review.
  // A PR adopted from its record carries no state, so the forge is asked.
  const shown = upsert.pr.state !== undefined
    ? upsert.pr
    : await input.forge.findPullRequest(input.scope, {
      repositoryBindingId: input.repositoryBindingId, headBranch: input.branch,
    });
  const facts = pullRequestFactsOf({
    taskId: input.taskId, attemptId: input.attemptId, commitSha: commit.commitSha,
    evidenceId: committedEvidenceId, base: input.base,
  });
  const gap = shown === null ? `no pull request for ${input.branch} on the forge` : pullRequestGap(shown, facts);
  if (gap !== undefined) {
    return {
      stoppedAt: 'upsert-pr',
      reason: `publication incomplete: ${gap}`,
      gap,
      verify,
      commitSha: commit.commitSha,
      evidence,
      push,
      pr: shown ?? upsert.pr,
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
