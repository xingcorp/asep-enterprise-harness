// Post-inspection pipeline step tests (§11 steps 4-9, exit criteria I1/D8/C7).
//
// Uses in-test fakes for CommandRunner/SandboxProvider/GitCommitter/
// ForgeProvider/EvidenceStore/SideEffectLog — the steps compose only against
// @asep/ports, so no real adapter (pg/Octokit/Docker) is needed. Proves:
//   - verification fails CLOSED on a non-zero/timed-out/truncated command and
//     on a missing mandatory assurance level, STOPPING before any side effect;
//   - the evidence id is PREALLOCATED before the commit and embedded in the
//     ASEP-Evidence trailer; resultSha == the trusted harness commit SHA (D8);
//   - push/PR are wrapped by the two-phase SideEffectLog (begin → call →
//     complete) and ADOPTED (not replayed) when a COMPLETED record exists (C7);
//   - the driver reaches WAITING_FOR_HUMAN_REVIEW and never past it (I1/I2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  TenantScope,
  AttemptId,
  TaskId,
  ArtifactId,
  ArtifactRef,
  EvidenceBundle,
  OrganizationId,
  ProjectId,
  WorkspaceId,
  RepositoryBindingId,
} from '@asep/contracts';
import type {
  CommandRunner,
  CommandSpec,
  CommandResult,
  SandboxProvider,
  SandboxHandle,
  WorkspaceMount,
  WorkspaceCapability,
  GitCommitter,
  ForgeProvider,
  PullRequestRef,
  GitChangeObservation,
  EvidenceStore,
  SideEffectLog,
  SideEffectRecord,
  SideEffectBeginInput,
  SideEffectCompleteInput,
} from '@asep/ports';
import type { TaskAggregate } from '@asep/domain';
import {
  verifyStep,
  commitStep,
  evidenceStep,
  pushStep,
  upsertPrStep,
  setReviewStep,
  completeToReview,
  type VerificationCheckSpec,
} from './pipeline-steps.js';

// --- shared fixtures --------------------------------------------------------

const scope: TenantScope = {
  organizationId: 'org-1' as OrganizationId,
  projectId: 'proj-1' as ProjectId,
};
const workspace: WorkspaceCapability = {
  workspaceId: 'ws-1' as WorkspaceId,
  leaseId: 'lease-1',
};
const mount: WorkspaceMount = {
  workspaceId: 'ws-1' as WorkspaceId,
  readOnlyPaths: [],
  writablePaths: ['/ws'],
};
const attemptId = 'attempt-1' as AttemptId;
const taskId = 'task-1' as TaskId;
const bindingId = 'bind-1' as RepositoryBindingId;

function artifactRef(id: string, kind: string): ArtifactRef {
  return { artifactId: id as ArtifactId, sha256: 'a'.repeat(64), kind: kind as never };
}

const cleanChange: GitChangeObservation = {
  headSha: 'c'.repeat(40),
  changedFiles: ['src/foo.ts'],
  createdRefs: [],
  touchedGitDir: false,
  diff: artifactRef('art-diff', 'git-diff'),
};

const environment: EvidenceBundle['environment'] = {
  imageDigest: 'sha256:' + 'e'.repeat(64),
  lockfileHash: 'f'.repeat(64),
  nodeVersion: '20.0.0',
};

function cmd(executable: string): CommandSpec {
  return {
    executable,
    args: [],
    cwd: '.',
    environmentProfile: 'verification',
    timeoutMs: 60_000,
    outputPolicy: { maxEvidenceBytes: 1024, displayHeadBytes: 256, displayTailBytes: 256 },
  };
}

// A CommandRunner whose result is keyed by executable name.
function fakeRunner(results: Record<string, Partial<CommandResult>>): CommandRunner {
  return {
    async run(spec: CommandSpec): Promise<CommandResult> {
      const r = results[spec.executable] ?? { exitCode: 0 };
      return {
        exitCode: r.exitCode ?? 0,
        signal: r.signal ?? null,
        timedOut: r.timedOut ?? false,
        stdout: r.stdout ?? artifactRef(`out-${spec.executable}`, 'command-output'),
        stderr: r.stderr ?? artifactRef(`err-${spec.executable}`, 'command-output'),
        stdoutBytes: r.stdoutBytes ?? 10,
        stderrBytes: r.stderrBytes ?? 0,
        truncated: r.truncated ?? false,
      };
    },
  };
}

const fakeSandbox: SandboxProvider = {
  async start(): Promise<SandboxHandle> {
    return { sandboxId: 'sbx-1', profile: 'verification-no-network' };
  },
  async stop(): Promise<void> {},
};

// R0's mandatory levels form the plan; a check per level keeps the plan valid.
function r0Checks(): VerificationCheckSpec[] {
  // R0 requires [L0, L1] per verification-matrix.yaml. The plan MAY add more
  // levels (an implementer can never skip a mandatory one, but may add checks),
  // so build a superset of passing checks to exercise the richer path.
  const levels: VerificationCheckSpec['level'][] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L8'];
  return levels.map((level, i) => ({
    id: `check-${level}`,
    level,
    category: (['workspace', 'static', 'unit', 'integration', 'security', 'nonfunctional', 'acceptance'] as const)[i]!,
    mandatory: true,
    command: cmd(`verify-${level}`),
  }));
}

// --- verifyStep -------------------------------------------------------------

test('verifyStep PASSES when every mandatory check is green', async () => {
  const res = await verifyStep({
    runner: fakeRunner({}),
    sandbox: fakeSandbox,
    mount,
    planId: 'plan-1',
    risk: 'R0',
    checks: r0Checks(),
  });
  assert.equal(res.status, 'OK');
  assert.equal(res.result.verdict, 'PASS');
  assert.equal(res.executions.length, 7);
});

test('verifyStep FAILS CLOSED on a non-zero mandatory check (STOPS the pipeline)', async () => {
  const res = await verifyStep({
    runner: fakeRunner({ 'verify-L2': { exitCode: 1 } }),
    sandbox: fakeSandbox,
    mount,
    planId: 'plan-1',
    risk: 'R0',
    checks: r0Checks(),
  });
  assert.equal(res.status, 'STOP');
  assert.equal(res.result.verdict, 'FAIL');
});

test('verifyStep FAILS CLOSED (ERROR) on a timed-out check', async () => {
  const res = await verifyStep({
    runner: fakeRunner({ 'verify-L1': { timedOut: true } }),
    sandbox: fakeSandbox,
    mount,
    planId: 'plan-1',
    risk: 'R0',
    checks: r0Checks(),
  });
  assert.equal(res.status, 'STOP');
  assert.equal(res.result.verdict, 'ERROR');
});

test('verifyStep FAILS CLOSED (ERROR) when raw output was truncated (evidence incomplete)', async () => {
  const res = await verifyStep({
    runner: fakeRunner({ 'verify-L0': { truncated: true } }),
    sandbox: fakeSandbox,
    mount,
    planId: 'plan-1',
    risk: 'R0',
    checks: r0Checks(),
  });
  assert.equal(res.status, 'STOP');
  assert.equal(res.result.verdict, 'ERROR');
});

test('verifyStep FAILS CLOSED when a mandatory assurance level is missing from the plan', async () => {
  // Drop L1 — a mandatory R0 level per verification-matrix.yaml — from the
  // plan. A missing mandatory level is a policy hole, never an implicit pass.
  const partial = r0Checks().filter((c) => c.level !== 'L1');
  const res = await verifyStep({
    runner: fakeRunner({}),
    sandbox: fakeSandbox,
    mount,
    planId: 'plan-1',
    risk: 'R0',
    checks: partial,
  });
  assert.equal(res.status, 'STOP');
  assert.equal(res.result.verdict, 'ERROR');
});

// --- commitStep + evidenceStep (D8) ----------------------------------------

test('commitStep embeds the preallocated evidence id in the ASEP-Evidence trailer', async () => {
  let captured: Record<string, string> = {};
  const committer: GitCommitter = {
    async commit(_scope, input) {
      captured = input.trailers;
      return { commitSha: 'd'.repeat(40) };
    },
  };
  const res = await commitStep({
    committer,
    scope,
    workspace,
    allowedPaths: ['src/'],
    attemptId,
    evidenceId: 'ev-123' as ArtifactId,
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    log: new MemorySideEffectLog(),
    repositoryBindingId: bindingId,
    leaseId: 'lease-1',
  });
  assert.equal(res.commitSha, 'd'.repeat(40));
  assert.equal(res.adopted, false);
  assert.equal(res.evidenceId, 'ev-123');
  assert.equal(captured['ASEP-Evidence'], 'ev-123');
  assert.equal(captured['ASEP-Attempt'], attemptId);
});

// HIGH-006: the commit is wrapped in the two-phase protocol. A crash after the
// commit but before downstream persistence must ADOPT the recorded commit SHA
// AND the evidence id embedded in that commit — never mint a second commit or a
// divergent evidence id (which would strand evidence at an unreferenced id).
test('commitStep ADOPTS the recorded commit SHA + evidence id on a resume (HIGH-006)', async () => {
  const log = new MemorySideEffectLog();
  let commits = 0;
  const committer: GitCommitter = {
    async commit() {
      commits += 1;
      return { commitSha: 'd'.repeat(40) };
    },
  };
  const first = await commitStep({
    committer, scope, workspace, allowedPaths: ['src/'], attemptId,
    evidenceId: 'ev-first' as ArtifactId,
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    log, repositoryBindingId: bindingId, leaseId: 'lease-1',
  });
  assert.equal(first.adopted, false);
  assert.equal(commits, 1);
  // Resume with a FRESH preallocated evidence id (as the driver would) — the
  // commit must be adopted and report the ORIGINAL committed evidence id.
  const resume = await commitStep({
    committer, scope, workspace, allowedPaths: ['src/'], attemptId,
    evidenceId: 'ev-second' as ArtifactId,
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    log, repositoryBindingId: bindingId, leaseId: 'lease-1',
  });
  assert.equal(resume.adopted, true);
  assert.equal(commits, 1, 'exactly one commit across both runs');
  assert.equal(resume.commitSha, 'd'.repeat(40));
  assert.equal(resume.evidenceId, 'ev-first', 'adopts the id embedded in the original commit');
});

test('evidenceStep sets resultSha to the harness commit SHA and stores at the preallocated id (D8)', async () => {
  const puts: Array<{ id: ArtifactId; bundle: EvidenceBundle }> = [];
  const store: EvidenceStore = {
    allocateEvidenceId: () => 'ev-alloc' as ArtifactId,
    async putEvidence(_scope, id, bundle) {
      puts.push({ id, bundle });
      return artifactRef(id, 'evidence-bundle');
    },
    async getEvidence() {
      throw new Error('not used');
    },
  };
  const res = await evidenceStep({
    store,
    scope,
    evidenceId: 'ev-alloc' as ArtifactId,
    taskId,
    attemptId,
    baseSha: '0'.repeat(40),
    resultSha: 'd'.repeat(40),
    change: cleanChange,
    environment,
    executions: [
      {
        id: 'check-L0',
        category: 'unit',
        mandatory: true,
        command: 'verify-L0',
        exitCode: 0,
        durationMs: 5,
        verdict: 'PASS',
        stdoutArtifactId: 'out-L0' as ArtifactId,
      },
    ],
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(res.bundle.resultSha, 'd'.repeat(40));
  assert.equal(res.bundle.baseSha, '0'.repeat(40));
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.id, 'ev-alloc');
  assert.equal(res.bundle.checks[0]!.command, 'verify-L0');
});

// --- SideEffectLog fake + push/PR (C7) -------------------------------------

// An in-memory two-phase side-effect log keyed by (scope, operation, binding,
// attempt). Fails closed on a fingerprint mismatch; enforces owner fencing.
class MemorySideEffectLog implements SideEffectLog {
  readonly rows = new Map<string, {
    operation: string; state: 'PENDING' | 'COMPLETED' | 'FAILED';
    fingerprint: string; owner: string; naturalKey?: string; resultRef?: unknown;
  }>();

  private key(op: string, binding: string, attempt: string) {
    return `${op}:${binding}:${attempt}`;
  }

  async begin(_scope: TenantScope, input: SideEffectBeginInput): Promise<SideEffectRecord> {
    const k = this.key(input.operation, input.repositoryBindingId, input.attemptId);
    const existing = this.rows.get(k);
    if (existing) {
      if (existing.fingerprint !== input.requestFingerprint) {
        throw new Error('side-effect fingerprint mismatch');
      }
      return {
        operation: input.operation,
        state: existing.state,
        requestFingerprint: existing.fingerprint,
        ownerToken: existing.owner,
        ...(existing.naturalKey ? { naturalKey: existing.naturalKey } : {}),
        ...(existing.resultRef !== undefined ? { resultRef: existing.resultRef } : {}),
        existed: true,
      };
    }
    this.rows.set(k, {
      operation: input.operation,
      state: 'PENDING',
      fingerprint: input.requestFingerprint,
      owner: input.ownerToken,
      ...(input.naturalKey ? { naturalKey: input.naturalKey } : {}),
    });
    return {
      operation: input.operation,
      state: 'PENDING',
      requestFingerprint: input.requestFingerprint,
      ownerToken: input.ownerToken,
      ...(input.naturalKey ? { naturalKey: input.naturalKey } : {}),
      existed: false,
    };
  }

  async complete(_scope: TenantScope, input: SideEffectCompleteInput): Promise<SideEffectRecord> {
    const k = this.key(input.operation, input.repositoryBindingId, input.attemptId);
    const row = this.rows.get(k);
    if (!row) throw new Error('complete before begin');
    if (row.owner !== input.ownerToken) throw new Error('fencing: stale owner token');
    row.state = 'COMPLETED';
    if (input.resultRef !== undefined) row.resultRef = input.resultRef;
    if (input.naturalKey) row.naturalKey = input.naturalKey;
    return {
      operation: input.operation,
      state: 'COMPLETED',
      requestFingerprint: row.fingerprint,
      ownerToken: row.owner,
      ...(row.naturalKey ? { naturalKey: row.naturalKey } : {}),
      ...(row.resultRef !== undefined ? { resultRef: row.resultRef } : {}),
      existed: true,
    };
  }

  async fail(_scope: TenantScope, input: { operation: 'commit' | 'push' | 'pr-upsert'; repositoryBindingId: RepositoryBindingId; attemptId: AttemptId; ownerToken: string }): Promise<SideEffectRecord> {
    const k = this.key(input.operation, input.repositoryBindingId, input.attemptId);
    const row = this.rows.get(k)!;
    row.state = 'FAILED';
    return {
      operation: input.operation,
      state: 'FAILED',
      requestFingerprint: row.fingerprint,
      ownerToken: row.owner,
      existed: true,
    };
  }
}

function fakeForge(pr: PullRequestRef): ForgeProvider & { pushes: number; upserts: number } {
  let pushes = 0;
  let upserts = 0;
  return {
    get pushes() { return pushes; },
    get upserts() { return upserts; },
    async pushBranch() { pushes += 1; },
    async upsertPullRequest() { upserts += 1; return pr; },
  } as ForgeProvider & { pushes: number; upserts: number };
}

const prRef: PullRequestRef = {
  number: 7,
  url: 'https://forge.invalid/pr/7',
  headBranch: 'asep/attempt-1',
  baseBranch: 'main',
};

test('pushStep wraps the push in the two-phase protocol (begin → push → complete)', async () => {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef);
  const res = await pushStep({
    forge,
    log,
    scope,
    repositoryBindingId: bindingId,
    attemptId,
    branch: 'asep/attempt-1',
    commitSha: 'd'.repeat(40),
    leaseId: 'lease-1',
  });
  assert.equal(res.pushed, true);
  assert.equal(res.adopted, false);
  assert.equal(forge.pushes, 1);
  // The record is COMPLETED after the push.
  const row = [...log.rows.values()][0]!;
  assert.equal(row.state, 'COMPLETED');
});

test('pushStep ADOPTS a COMPLETED record instead of replaying the push (C7 idempotency)', async () => {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef);
  const input = {
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    branch: 'asep/attempt-1', commitSha: 'd'.repeat(40), leaseId: 'lease-1',
  };
  await pushStep(input);
  const again = await pushStep(input);   // simulate a crash-and-retry
  assert.equal(again.pushed, false);
  assert.equal(again.adopted, true);
  assert.equal(forge.pushes, 1, 'push must NOT be replayed once COMPLETED');
});

test('upsertPrStep ADOPTS the recorded PR ref on retry (no duplicate PR)', async () => {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef);
  const input = {
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    headBranch: 'asep/attempt-1', base: 'main', title: 't', body: 'b', leaseId: 'lease-1',
  };
  const first = await upsertPrStep(input);
  assert.equal(first.adopted, false);
  assert.equal(first.pr.number, 7);
  const retry = await upsertPrStep(input);
  assert.equal(retry.adopted, true);
  assert.equal(retry.pr.number, 7);
  assert.equal(forge.upserts, 1, 'PR upsert must NOT be replayed once COMPLETED');
});

test('reusing a side-effect key with a DIFFERENT fingerprint fails closed', async () => {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef);
  await pushStep({
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    branch: 'asep/attempt-1', commitSha: 'd'.repeat(40), leaseId: 'lease-1',
  });
  // Same op/binding/attempt but a different commit → different fingerprint.
  await assert.rejects(() => pushStep({
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    branch: 'asep/attempt-1', commitSha: '9'.repeat(40), leaseId: 'lease-1',
  }), /fingerprint mismatch/);
});

// --- setReviewStep (I1/I2) --------------------------------------------------

test('setReviewStep advances VERIFYING -> WAITING_FOR_HUMAN_REVIEW (harness ceiling)', () => {
  const task: TaskAggregate = { id: taskId, status: 'VERIFYING', version: 3 };
  const res = setReviewStep(task);
  assert.equal(res.task.status, 'WAITING_FOR_HUMAN_REVIEW');
  assert.equal(res.task.version, 4);
});

test('setReviewStep throws from a non-VERIFYING state (never skips the review gate)', () => {
  const task: TaskAggregate = { id: taskId, status: 'READY', version: 1 };
  assert.throws(() => setReviewStep(task), /Invalid task transition/);
});

// --- completeToReview driver (full §11 tail) --------------------------------

function driverInput(overrides: Partial<Parameters<typeof completeToReview>[0]> = {}) {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef);
  const store: EvidenceStore = {
    allocateEvidenceId: () => 'ev-alloc' as ArtifactId,
    async putEvidence(_s, id, bundle) { return artifactRef(id, 'evidence-bundle'); },
    async getEvidence() { throw new Error('unused'); },
  };
  const committer: GitCommitter = {
    async commit() { return { commitSha: 'd'.repeat(40) }; },
  };
  return {
    change: cleanChange,
    baseSha: '0'.repeat(40),
    runner: fakeRunner({}),
    sandbox: fakeSandbox,
    mount,
    planId: 'plan-1',
    risk: 'R0' as const,
    checks: r0Checks(),
    committer,
    scope,
    workspace,
    allowedPaths: ['src/'],
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    store,
    taskId,
    attemptId,
    environment,
    now: () => '2026-01-01T00:00:00.000Z',
    forge,
    log,
    repositoryBindingId: bindingId,
    branch: 'asep/attempt-1',
    base: 'main',
    title: 't',
    body: 'b',
    leaseId: 'lease-1',
    task: { id: taskId, status: 'VERIFYING', version: 3 } as TaskAggregate,
    ...overrides,
  };
}

test('completeToReview drives verify -> commit -> evidence -> push -> PR -> WAITING_FOR_HUMAN_REVIEW', async () => {
  const res = await completeToReview(driverInput());
  assert.equal(res.stoppedAt, 'complete');
  assert.equal(res.commitSha, 'd'.repeat(40));
  assert.equal(res.evidence?.bundle.resultSha, 'd'.repeat(40));
  assert.equal(res.pr?.number, 7);
  assert.equal(res.task?.status, 'WAITING_FOR_HUMAN_REVIEW');
});

test('completeToReview STOPS at verify on a red gate — NO commit, NO push, NO PR', async () => {
  const forge = fakeForge(prRef);
  const res = await completeToReview(driverInput({
    forge,
    runner: fakeRunner({ 'verify-L2': { exitCode: 1 } }),
  }));
  assert.equal(res.stoppedAt, 'verify');
  assert.equal(res.commitSha, undefined);
  assert.equal(res.pr, undefined);
  assert.equal(forge.pushes, 0, 'a red gate must produce NO push side effect');
  assert.equal(forge.upserts, 0, 'a red gate must produce NO PR side effect');
});

test('completeToReview is crash-safe: a full re-run adopts the push+PR (single ref, single PR)', async () => {
  const shared = driverInput();
  const first = await completeToReview(shared);
  assert.equal(first.stoppedAt, 'complete');
  // Re-drive with the SAME log/forge (simulating a resume after the terminal
  // transition was not yet persisted). The side effects must be adopted.
  const second = await completeToReview(shared);
  assert.equal(second.stoppedAt, 'complete');
  const forge = shared.forge as ForgeProvider & { pushes: number; upserts: number };
  assert.equal(forge.pushes, 1, 'exactly one push across both runs');
  assert.equal(forge.upserts, 1, 'exactly one PR upsert across both runs');
});
