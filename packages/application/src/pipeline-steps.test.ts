// Post-inspection pipeline step tests (§11 steps 4-9, exit criteria I1/D8/C7).
//
// Uses in-test fakes for CommandRunner/SandboxProvider/GitCommitter/
// ForgeProvider/EvidenceStore/SideEffectLog — the steps compose only against
// @asep/ports, so no real adapter (pg/Octokit/Docker) is needed. Proves:
//   - verification fails CLOSED on a non-zero/timed-out/truncated command and
//     on a missing mandatory assurance level, STOPPING before any side effect;
//   - the evidence id is RESERVED, with its draft, before the commit and
//     embedded in the ASEP-Evidence trailer; resultSha == the trusted harness
//     commit SHA, and the stored bundle is that draft plus it (D8);
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
  EvidenceDraft,
  SideEffectLog,
  SideEffectRecord,
  SideEffectResultRef,
  SideEffectKey,
  SideEffectBeginInput,
  SideEffectCompleteInput,
} from '@asep/ports';
import { SideEffectFencingError } from '@asep/ports';
import type { TaskAggregate } from '@asep/domain';
import {
  verifyStep,
  commitStep,
  evidenceStep,
  evidenceDraft,
  pushStep,
  upsertPrStep,
  setReviewStep,
  completeToReview,
  EvidenceIdentityMismatchError,
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

// The ABSENCE signal the real ContentAddressedEvidenceStore raises when no bundle
// exists at a preallocated id. evidenceStep treats ONLY this as "safe to write";
// any other error propagates, so doubles must speak the same dialect as the real
// store rather than throwing a generic Error (disp. P2-REREVIEW HIGH-006).
function evidenceAbsent(): Error {
  const err = new Error('evidence bundle not found');
  err.name = 'EvidenceNotFoundError';
  return err;
}

// An in-memory EvidenceStore with the real reservation contract: reserve() keeps
// the draft under a fresh id, getReservation() returns it, and putEvidence()
// accepts only that draft plus a resultSha. `stored` seeds bundles already
// present (a resume); `put` overrides the write (a fault).
function memoryEvidence(opts: {
  readonly stored?: Readonly<Record<string, EvidenceBundle>>;
  readonly reserved?: Readonly<Record<string, EvidenceDraft>>;
  readonly put?: (id: ArtifactId, bundle: EvidenceBundle) => Promise<ArtifactRef>;
  readonly get?: (id: ArtifactId) => Promise<EvidenceBundle>;
} = {}): EvidenceStore & {
  readonly drafts: Map<string, EvidenceDraft>;
  readonly puts: Array<{ id: ArtifactId; bundle: EvidenceBundle }>;
  readonly calls: string[];
} {
  const drafts = new Map<string, EvidenceDraft>(Object.entries(opts.reserved ?? {}));
  const stored = new Map<string, EvidenceBundle>(Object.entries(opts.stored ?? {}));
  const puts: Array<{ id: ArtifactId; bundle: EvidenceBundle }> = [];
  const calls: string[] = [];
  let next = 0;
  return {
    drafts, puts, calls,
    async reserveEvidence(_s, input) {
      const id = `ev-reserved-${++next}`;
      calls.push(`reserve:${id}`);
      drafts.set(id, input.draft);
      return id as ArtifactId;
    },
    async getReservation(_s, id) {
      const draft = drafts.get(id);
      if (draft === undefined) throw new Error(`evidence id ${id} is not reserved`);
      return { evidenceId: id, repositoryBindingId: bindingId, attemptId: draft.attemptId, draft };
    },
    async putEvidence(_s, id, bundle) {
      calls.push(`put:${id}`);
      const { resultSha: _r, ...rest } = bundle;
      if (JSON.stringify(rest) !== JSON.stringify(drafts.get(id))) throw new Error(`evidence for ${id} is not its draft`);
      if (opts.put) return opts.put(id, bundle);
      puts.push({ id, bundle });
      stored.set(id, bundle);
      return artifactRef(id, 'evidence-bundle');
    },
    async getEvidence(_s, id) {
      if (opts.get) return opts.get(id);
      const b = stored.get(id);
      if (b === undefined) throw evidenceAbsent();
      return b;
    },
  };
}

const cleanChange: GitChangeObservation = {
  headSha: 'c'.repeat(40),
  changedFiles: ['src/foo.ts'],
  createdRefs: [],
  touchedGitDir: false,
  baseSha: 'c'.repeat(40),
  headMovedFromBase: false,
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

// A sandbox that DOES enforce OS isolation — the shape every production
// provider must report (exit E8). It declares `isolationEnforced: true`, because
// verifyStep now refuses to run commands under a handle that cannot prove
// isolation (disp. P2-FINAL-HIGH-002).
const fakeSandbox: SandboxProvider = {
  async start(): Promise<SandboxHandle> {
    return { sandboxId: 'sbx-1', profile: 'verification-no-network', isolationEnforced: true };
  },
  async stop(): Promise<void> {},
};

// A sandbox that does NOT enforce isolation (the honest pilot/no-isolation
// shape), plus a stop() counter so a test can prove the refusal still releases
// the sandbox rather than leaking it.
function unsandboxedProvider(): SandboxProvider & { stops: () => number } {
  let stops = 0;
  return {
    async start(): Promise<SandboxHandle> {
      return {
        sandboxId: 'local-1',
        profile: 'verification-no-network (PILOT-ONLY, NO-ISOLATION)',
        isolationEnforced: false,
      };
    },
    async stop(): Promise<void> { stops++; },
    stops: () => stops,
  };
}

// A sandbox whose handle never declares the flag at all — a third-party provider
// that is silent about isolation. Unknown isolation is never a permission.
const silentSandbox: SandboxProvider = {
  async start(): Promise<SandboxHandle> {
    return { sandboxId: 'mystery-1', profile: 'verification-no-network' };
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

// --- E8 / HIGH-002: the sandbox is MANDATORY, not merely labelled ------------
//
// The review's finding was that an unsandboxed provider was honestly LABELLED
// but never REFUSED, so the governed path could run verification commands
// straight on the host. verifyStep now asserts the STARTED handle enforces
// isolation before the first command, and no input relaxes that — so a new
// call site is protected without being edited.

test('E8: verifyStep REFUSES an unsandboxed provider', async () => {
  const provider = unsandboxedProvider();
  let ran = 0;
  const inner = fakeRunner({});
  const countingRunner: CommandRunner = {
    async run(spec: CommandSpec, handle: SandboxHandle): Promise<CommandResult> {
      ran++;
      return inner.run(spec, handle);
    },
  };
  await assert.rejects(
    () => verifyStep({
      runner: countingRunner,
      sandbox: provider,
      mount,
      planId: 'plan-1',
      risk: 'R0',
      checks: r0Checks(),
    }),
    /sandbox isolation is required/,
    'an unsandboxed provider must be refused',
  );
  // The refusal happens BEFORE any command runs — not after collecting output.
  assert.equal(ran, 0, 'no verification command may execute unsandboxed');
  // …and the sandbox is still released, so the refusal does not leak it.
  assert.equal(provider.stops(), 1, 'the refused sandbox must still be stopped');
});

test('E8: verifyStep REFUSES a handle that is silent about isolation', async () => {
  await assert.rejects(
    () => verifyStep({
      runner: fakeRunner({}),
      sandbox: silentSandbox,
      mount,
      planId: 'plan-1',
      risk: 'R0',
      checks: r0Checks(),
    }),
    /sandbox isolation is required/,
    'an absent isolationEnforced flag is not a permission',
  );
});

// The old waiver was an input field. Smuggling it back in through an untyped
// object must change nothing: no input relaxes the requirement.
test('E8: no input waives isolation — a smuggled legacy waiver field is ignored', async () => {
  const provider = unsandboxedProvider();
  const input = {
    runner: fakeRunner({}),
    sandbox: provider,
    mount,
    planId: 'plan-1',
    risk: 'R0' as const,
    checks: r0Checks(),
    sandboxRequirement: 'waived-pilot-only',
  };
  await assert.rejects(() => verifyStep(input), /sandbox isolation is required/);
  assert.equal(provider.stops(), 1);
});

test('E8: completeToReview REFUSES an unsandboxed provider before ANY side effect', async () => {
  // The driver must throw out of verification, so no commit/push/PR is attempted.
  let commits = 0;
  const committer: GitCommitter = {
    async commit() { commits += 1; return { commitSha: 'd'.repeat(40) }; },
    async reconcile() { return null; },
  };
  const forge = fakeForge(prRef);
  await assert.rejects(
    () => completeToReview(driverInput({
      sandbox: unsandboxedProvider(),
      committer,
      forge,
    })),
    /sandbox isolation is required/,
  );
  assert.equal(commits, 0, 'no commit may be created unsandboxed');
  assert.equal(forge.pushes, 0, 'no push may occur unsandboxed');
  assert.equal(forge.upserts, 0, 'no PR may be opened unsandboxed');
});

// --- commitStep + evidenceStep (D8) ----------------------------------------

test('commitStep embeds the preallocated evidence id in the ASEP-Evidence trailer', async () => {
  let captured: Record<string, string> = {};
  const committer: GitCommitter = {
    async commit(_scope, input) {
      captured = input.trailers;
      return { commitSha: 'd'.repeat(40) };
    },
    async reconcile() { return null; },
  };
  const res = await commitStep({
    committer,
    scope,
    workspace,
    allowedPaths: ['src/'],
    attemptId,
    baseSha: '0'.repeat(40),
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
    async reconcile() { return null; },
  };
  const first = await commitStep({
    committer, scope, workspace, allowedPaths: ['src/'], attemptId,
    baseSha: '0'.repeat(40),
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
    baseSha: '0'.repeat(40),
  });
  assert.equal(resume.adopted, true);
  assert.equal(commits, 1, 'exactly one commit across both runs');
  assert.equal(resume.commitSha, 'd'.repeat(40));
  assert.equal(resume.evidenceId, 'ev-first', 'adopts the id embedded in the original commit');
});

// The executor died after the commit landed but before its record completed:
// the record is PENDING. The step asks for the attempt's recorded commit and
// completes the record with it — it never commits again.
test('commitStep completes a PENDING record with the attempt\'s recorded commit instead of committing again', async () => {
  const log = new MemorySideEffectLog();
  await log.begin(scope, {
    operation: 'commit', repositoryBindingId: bindingId, attemptId,
    requestFingerprint: `commit:${attemptId}`, ownerToken: 'lease-1',
  });
  let commits = 0;
  const asked: unknown[] = [];
  const committer: GitCommitter = {
    async commit() { commits += 1; return { commitSha: 'e'.repeat(40) }; },
    async reconcile(_s, input) { asked.push(input); return { commitSha: 'd'.repeat(40), evidenceId: 'ev-landed' }; },
  };
  const res = await commitStep({
    committer, scope, workspace, allowedPaths: ['src/'], attemptId,
    baseSha: '0'.repeat(40), evidenceId: 'ev-fresh' as ArtifactId,
    identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    log, repositoryBindingId: bindingId, leaseId: 'lease-1',
  });
  assert.equal(commits, 0, 'no second commit');
  assert.deepEqual(asked, [{ attemptId, baseSha: '0'.repeat(40) }]);
  assert.equal(res.adopted, true);
  assert.equal(res.commitSha, 'd'.repeat(40));
  assert.equal(res.evidenceId, 'ev-landed', 'the evidence id the landed commit carries');
  const rec = await log.find(scope, { operation: 'commit', repositoryBindingId: bindingId, attemptId });
  assert.equal(rec?.state, 'COMPLETED');
  assert.deepEqual(rec?.resultRef, { kind: 'commit', commitSha: 'd'.repeat(40), evidenceId: 'ev-landed' });
});

test('evidenceStep stores the reserved draft completed by the harness commit SHA (D8)', async () => {
  const draft = evidenceDraft({
    taskId, attemptId, baseSha: '0'.repeat(40), change: cleanChange, environment,
    executions: [{
      id: 'check-L0', category: 'unit', mandatory: true, command: 'verify-L0', exitCode: 0,
      durationMs: 5, verdict: 'PASS', stdoutArtifactId: 'out-L0' as ArtifactId,
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const store = memoryEvidence({ reserved: { 'ev-reserved': draft } });
  const res = await evidenceStep({
    store, scope, evidenceId: 'ev-reserved' as ArtifactId, taskId, attemptId,
    baseSha: '0'.repeat(40), resultSha: 'd'.repeat(40),
  });
  assert.equal(res.bundle.resultSha, 'd'.repeat(40));
  assert.equal(res.bundle.baseSha, '0'.repeat(40));
  assert.equal(res.bundle.createdAt, '2026-01-01T00:00:00.000Z', "the draft's clock, not this step's");
  assert.equal(store.puts.length, 1);
  assert.equal(store.puts[0]!.id, 'ev-reserved');
  assert.equal(res.bundle.checks[0]!.command, 'verify-L0');
});

test('evidenceStep refuses a reservation whose draft is for another task, attempt or base', async () => {
  for (const [field, over] of [
    ['taskId', { taskId: 'task-OTHER' as TaskId }],
    ['attemptId', { attemptId: 'att-OTHER' as AttemptId }],
    ['baseSha', { baseSha: '1'.repeat(40) }],
  ] as const) {
    const draft = { ...evidenceDraft({
      taskId, attemptId, baseSha: '0'.repeat(40), change: cleanChange, environment, executions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    }), ...over };
    const store = memoryEvidence({ reserved: { 'ev-r': draft } });
    await assert.rejects(
      () => evidenceStep({
        store, scope, evidenceId: 'ev-r' as ArtifactId, taskId, attemptId,
        baseSha: '0'.repeat(40), resultSha: 'd'.repeat(40),
      }),
      EvidenceIdentityMismatchError, field,
    );
    assert.equal(store.puts.length, 0);
  }
});

// --- SideEffectLog fake + push/PR (C7) -------------------------------------

// An in-memory two-phase side-effect log keyed by (scope, operation, binding,
// attempt). Fails closed on a fingerprint mismatch; enforces owner fencing.
class MemorySideEffectLog implements SideEffectLog {
  readonly rows = new Map<string, {
    operation: string; state: 'PENDING' | 'COMPLETED' | 'FAILED';
    fingerprint: string; owner: string; naturalKey?: string; resultRef?: SideEffectResultRef;
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

  // Every confirmation, in order; `epoch` is what the owner holds, and
  // `takenOver` simulates a successor having taken the records over.
  readonly confirmed: string[] = [];
  epoch = 3;
  takenOver = false;

  async confirmOwner(_scope: TenantScope, input: SideEffectKey & { ownerToken: string }): Promise<{ fencingEpoch: number }> {
    const row = this.rows.get(this.key(input.operation, input.repositoryBindingId, input.attemptId));
    if (!row || row.state !== 'PENDING') throw new SideEffectFencingError('nothing PENDING to act for');
    if (this.takenOver || row.owner !== input.ownerToken) throw new SideEffectFencingError('stale owner');
    this.confirmed.push(input.operation);
    return { fencingEpoch: this.epoch };
  }

  async fail(_scope: TenantScope, input: { operation: 'commit' | 'push' | 'pr-upsert'; repositoryBindingId: RepositoryBindingId; attemptId: AttemptId; ownerToken: string }): Promise<SideEffectRecord> {
    const k = this.key(input.operation, input.repositoryBindingId, input.attemptId);
    const row = this.rows.get(k)!;
    row.state = 'FAILED';
    return {
      operation: input.operation,
      state: 'FAILED',
      requestFingerprint: row.fingerprint,
      existed: true,
    };
  }

  async find(_scope: TenantScope, key: SideEffectKey): Promise<SideEffectRecord | null> {
    const row = this.rows.get(this.key(key.operation, key.repositoryBindingId, key.attemptId));
    if (!row) return null;
    return {
      operation: key.operation,
      state: row.state,
      requestFingerprint: row.fingerprint,
      ownerToken: row.owner,
      ...(row.naturalKey ? { naturalKey: row.naturalKey } : {}),
      ...(row.resultRef !== undefined ? { resultRef: row.resultRef } : {}),
      existed: true,
    };
  }
}

// A transport-level forge double. `remote` models what is ALREADY on the forge,
// so a test can exercise the HIGH-006 reconciliation paths: with an empty remote
// the reconcile lookups answer null (the effect never landed → perform it), and
// a seeded remote makes them answer with the real ref/PR (→ adopt, never
// re-call). Counting pushes/upserts is what proves no duplicate side effect.
function fakeForge(
  pr: PullRequestRef,
  remote: { ref?: string | null; pr?: PullRequestRef | null } = {},
): ForgeProvider & { pushes: number; upserts: number; epochs: number[] } {
  let pushes = 0;
  let upserts = 0;
  const epochs: number[] = [];
  return {
    get pushes() { return pushes; },
    get upserts() { return upserts; },
    epochs,
    async pushBranch(_s: TenantScope, i: { fencingEpoch: number }) { pushes += 1; epochs.push(i.fencingEpoch); },
    async upsertPullRequest(_s: TenantScope, i: { fencingEpoch: number }) { upserts += 1; epochs.push(i.fencingEpoch); return pr; },
    async resolveRef() { return remote.ref ?? null; },
    async findPullRequest() { return remote.pr ?? null; },
  } as ForgeProvider & { pushes: number; upserts: number; epochs: number[] };
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

test('push and PR are confirmed at the call and carry the owner\'s fencing epoch', async () => {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef);
  const common = { forge, log, scope, repositoryBindingId: bindingId, attemptId, leaseId: 'lease-1' };
  await pushStep({ ...common, branch: 'asep/attempt-1', commitSha: 'd'.repeat(40) });
  await upsertPrStep({ ...common, headBranch: 'asep/attempt-1', base: 'main', title: 't', body: 'b' });
  assert.deepEqual(log.confirmed, ['push', 'pr-upsert']);
  assert.deepEqual(forge.epochs, [3, 3], 'each forge call carries the confirmed epoch');
});

test('an executor whose records were taken over never reaches the forge or commits', async () => {
  const log = new MemorySideEffectLog();
  log.takenOver = true;
  const forge = fakeForge(prRef);
  const common = { forge, log, scope, repositoryBindingId: bindingId, attemptId, leaseId: 'lease-1' };
  await assert.rejects(() => pushStep({ ...common, branch: 'asep/attempt-1', commitSha: 'd'.repeat(40) }),
    SideEffectFencingError);
  await assert.rejects(
    () => upsertPrStep({ ...common, headBranch: 'asep/attempt-1', base: 'main', title: 't', body: 'b' }),
    SideEffectFencingError);
  assert.equal(forge.pushes + forge.upserts, 0, 'nothing reached the forge');
  let commits = 0;
  await assert.rejects(() => commitStep({
    committer: { async commit() { commits += 1; return { commitSha: 'd'.repeat(40) }; }, async reconcile() { return null; } },
    scope, workspace, allowedPaths: ['src/'], attemptId, baseSha: '0'.repeat(40),
    evidenceId: 'ev-1' as ArtifactId, identity: { name: 'ASEP Bot', email: 'bot@asep.invalid' },
    log, repositoryBindingId: bindingId, leaseId: 'lease-1',
  }), SideEffectFencingError);
  assert.equal(commits, 0, 'nothing was committed');
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

// HIGH-006 (cycle 3): a crash AFTER the forge call but BEFORE complete() leaves
// the record PENDING. The log alone cannot say whether the effect landed, so the
// step must ask the REMOTE by natural key before re-calling. These four tests
// pin both directions for push and PR: effect present on the remote → adopt
// without re-calling; effect absent → perform it.

test('pushStep RECONCILES a PENDING record against the remote and adopts a landed push (HIGH-006)', async () => {
  const log = new MemorySideEffectLog();
  // The remote already carries this exact commit on the branch: the push landed
  // before the crash, even though the record never reached COMPLETED.
  const forge = fakeForge(prRef, { ref: 'd'.repeat(40) });
  const input = {
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    branch: 'asep/attempt-1', commitSha: 'd'.repeat(40), leaseId: 'lease-1',
  };
  // Leave a PENDING row exactly as a crash between push and complete would.
  await log.begin(scope, {
    operation: 'push', repositoryBindingId: bindingId, attemptId,
    requestFingerprint: `push:${input.branch}@${input.commitSha}`,
    ownerToken: 'lease-1', naturalKey: input.branch,
  });
  const res = await pushStep(input);
  assert.equal(res.adopted, true, 'a landed push must be adopted, not replayed');
  assert.equal(res.pushed, false);
  assert.equal(forge.pushes, 0, 'the forge must NOT be called again');
  assert.equal([...log.rows.values()][0]!.state, 'COMPLETED', 'the record is finished');
});

test('pushStep PERFORMS the push when a PENDING record has no matching remote ref (HIGH-006)', async () => {
  const log = new MemorySideEffectLog();
  // Remote has nothing: the crash happened BEFORE the push reached the forge.
  const forge = fakeForge(prRef, { ref: null });
  const input = {
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    branch: 'asep/attempt-1', commitSha: 'd'.repeat(40), leaseId: 'lease-1',
  };
  await log.begin(scope, {
    operation: 'push', repositoryBindingId: bindingId, attemptId,
    requestFingerprint: `push:${input.branch}@${input.commitSha}`,
    ownerToken: 'lease-1', naturalKey: input.branch,
  });
  const res = await pushStep(input);
  assert.equal(res.pushed, true, 'an un-landed push must actually be performed');
  assert.equal(forge.pushes, 1);
  assert.equal([...log.rows.values()][0]!.state, 'COMPLETED');
});

test('upsertPrStep RECONCILES a PENDING record and adopts an existing PR (HIGH-006)', async () => {
  const log = new MemorySideEffectLog();
  // The PR already exists on the forge for this head branch.
  const forge = fakeForge(prRef, { pr: prRef });
  const input = {
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    headBranch: 'asep/attempt-1', base: 'main', title: 't', body: 'b', leaseId: 'lease-1',
  };
  await log.begin(scope, {
    operation: 'pr-upsert', repositoryBindingId: bindingId, attemptId,
    requestFingerprint: `pr:${input.headBranch}->${input.base}`,
    ownerToken: 'lease-1', naturalKey: input.headBranch,
  });
  const res = await upsertPrStep(input);
  assert.equal(res.adopted, true, 'an existing PR must be adopted, not re-upserted');
  assert.equal(res.pr.number, 7);
  assert.equal(forge.upserts, 0, 'the forge must NOT be called again');
  assert.equal([...log.rows.values()][0]!.state, 'COMPLETED');
});

test('upsertPrStep PERFORMS the upsert when a PENDING record has no remote PR (HIGH-006)', async () => {
  const log = new MemorySideEffectLog();
  const forge = fakeForge(prRef, { pr: null });
  const input = {
    forge, log, scope, repositoryBindingId: bindingId, attemptId,
    headBranch: 'asep/attempt-1', base: 'main', title: 't', body: 'b', leaseId: 'lease-1',
  };
  await log.begin(scope, {
    operation: 'pr-upsert', repositoryBindingId: bindingId, attemptId,
    requestFingerprint: `pr:${input.headBranch}->${input.base}`,
    ownerToken: 'lease-1', naturalKey: input.headBranch,
  });
  const res = await upsertPrStep(input);
  assert.equal(res.adopted, false, 'a missing PR must actually be created');
  assert.equal(forge.upserts, 1);
  assert.equal([...log.rows.values()][0]!.state, 'COMPLETED');
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
  // No bundle exists yet in the driver's default fixture, so the evidence
  // step's reconcile probe observes ABSENCE (the real store's
  // EvidenceNotFoundError) and goes on to write the reserved draft.
  const store = memoryEvidence();
  const committer: GitCommitter = {
    async commit() { store.calls.push('commit'); return { commitSha: 'd'.repeat(40) }; },
    async reconcile() { return null; },
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
  const input = driverInput();
  const res = await completeToReview(input);
  assert.equal(res.stoppedAt, 'complete');
  const store = input.store as ReturnType<typeof memoryEvidence>;
  assert.deepEqual(store.calls, ['reserve:ev-reserved-1', 'commit', 'put:ev-reserved-1'],
    'the evidence draft is reserved BEFORE the commit, and stored after it');
  assert.equal(res.evidence?.bundle.createdAt, '2026-01-01T00:00:00.000Z');
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

// HIGH-006 (cycle-4 residue): the evidence write is the ONE durable step that
// cannot be replayed, because `createdAt` comes from the clock. A resume that
// ADOPTED an existing commit reuses the evidence id embedded in that commit's
// trailer — so re-deriving the bundle would produce byte-different content at an
// immutable id and the store would (correctly) fail closed, wedging the attempt
// forever. These two tests pin the reconcile: an existing bundle is ADOPTED with
// no second write, and an absent one is written exactly once.
test('HIGH-006: evidenceStep ADOPTS an existing bundle instead of re-deriving it with a new clock', async () => {
  const durable: EvidenceBundle = {
    taskId,
    attemptId,
    baseSha: '0'.repeat(40),
    resultSha: 'd'.repeat(40),
    createdAt: '2026-01-01T00:00:00.000Z',   // the FIRST run's timestamp
    environment,
    diff: { artifactId: cleanChange.diff.artifactId, sha256: cleanChange.diff.sha256 },
    checks: [],
  };
  const store = memoryEvidence({ stored: { 'ev-adopt': durable } });
  const res = await evidenceStep({
    store, scope, evidenceId: 'ev-adopt' as ArtifactId, taskId, attemptId,
    baseSha: '0'.repeat(40), resultSha: 'd'.repeat(40),
  });

  assert.equal(res.adopted, true, 'an existing bundle must be adopted');
  assert.equal(store.puts.length, 0, 'adoption must not write evidence a second time');
  assert.equal(res.bundle.createdAt, '2026-01-01T00:00:00.000Z',
    'the ORIGINAL timestamp survives — the resume clock must not leak in');
  assert.equal(res.ref.artifactId, 'ev-adopt');
});

test('HIGH-006: a genuine integrity error from getEvidence is NOT swallowed (fail closed)', async () => {
  const store = memoryEvidence({
    async get() {
      // A mutated byte on read: the store re-hashes and rejects. This is NOT
      // "absent", so evidenceStep must propagate rather than write fresh bytes
      // over a corrupt record.
      const e = new Error('evidence id ev-corrupt already holds different bytes');
      e.name = 'EvidenceImmutabilityError';
      throw e;
    },
  });
  await assert.rejects(
    () => evidenceStep({
      store, scope, evidenceId: 'ev-corrupt' as ArtifactId, taskId, attemptId,
      baseSha: '0'.repeat(40), resultSha: 'd'.repeat(40),
    }),
    /already holds different bytes/,
  );
});

// HIGH-006 (cycle-5 residue): adoption must VERIFY the bundle it adopts.
//
// THE DEFECT. evidenceStep returned the persisted bundle unchecked. The id it
// reads comes from the resumed commit's ASEP-Evidence trailer, and the adopted
// bundle becomes this attempt's evidence — flowing into push, the PR body and
// WAITING_FOR_HUMAN_REVIEW. So a trailer pointing at another commit's evidence
// (a stale/reused id, a mis-parsed trailer) put a human reviewer in front of
// evidence for a DIFFERENT commit while every downstream step reported success.
//
// The four compared fields are all harness-owned — taskId/attemptId are
// pre-created, baseSha is the pinned checkout, resultSha is read back by trusted
// inspection — so the check cannot be satisfied by anything the agent reports.
function adoptingStore(persisted: EvidenceBundle): EvidenceStore {
  return memoryEvidence({
    stored: { 'ev-x': persisted },
    async put(id) { throw new Error(`putEvidence must not run when a bundle exists at ${id}`); },
  });
}

const adoptBase = {
  scope,
  evidenceId: 'ev-x' as ArtifactId,
  taskId,
  attemptId,
  baseSha: '0'.repeat(40),
  resultSha: 'd'.repeat(40),
} as const;

// The bundle the harness would legitimately find on a resume: same identity,
// earlier clock.
function persistedFor(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    taskId,
    attemptId,
    baseSha: '0'.repeat(40),
    resultSha: 'd'.repeat(40),
    createdAt: '2026-01-01T00:00:00.000Z',
    environment,
    diff: { artifactId: cleanChange.diff.artifactId, sha256: cleanChange.diff.sha256 },
    checks: [],
    ...over,
  };
}

test('HIGH-006: adoption is IDENTITY-GATED — a bundle for another commit fails closed', async () => {
  // Each case mutates exactly ONE harness-owned fact, so a regression that drops
  // any single comparison is caught rather than masked by the others.
  const cases: readonly (readonly [string, Partial<EvidenceBundle>])[] = [
    ['resultSha', { resultSha: '9'.repeat(40) }],
    ['baseSha', { baseSha: '1'.repeat(40) }],
    ['taskId', { taskId: 'task-OTHER' as TaskId }],
    ['attemptId', { attemptId: 'att-OTHER' as AttemptId }],
  ];
  for (const [field, over] of cases) {
    await assert.rejects(
      () => evidenceStep({ ...adoptBase, store: adoptingStore(persistedFor(over)) }),
      EvidenceIdentityMismatchError,
      `a persisted bundle disagreeing on ${field} must NOT be adopted`,
    );
  }
});

test('HIGH-006: a matching bundle whose clock differs IS still adopted (gate is not blanket-deny)', async () => {
  // The benign case adoption exists for: identical identity, earlier timestamp.
  // If this failed, the wedge the reconcile was built to prevent would return.
  const res = await evidenceStep({
    ...adoptBase,
    store: adoptingStore(persistedFor()),
  });
  assert.equal(res.adopted, true, 'identity matches, so the bundle is adopted');
  assert.equal(res.bundle.createdAt, '2026-01-01T00:00:00.000Z',
    'the ORIGINAL timestamp survives — the resume clock must not leak in');
});

// ---------------------------------------------------------------------------
// HIGH-005 (cycle-5 residue): a COMPLETED pr-upsert record is adopted through
// the SAME strict parser the commit path uses, not a blind cast.
//
// THE DEFECT. `pr: begun.resultRef as PullRequestRef` asserted a shape at the
// type level and checked nothing at runtime. `resultRef` is a JSONB column
// typed `unknown`, so a truncated, foreign or hand-edited row was adopted
// verbatim — and the adopted `pr.number` flows straight into the
// `pull_requests` row and the run outcome. Verified empirically before the fix:
// a record missing `number`, one carrying `number` as a STRING, one with a
// dropped `url`, and even a COMMIT ref were all adopted with no error.
// ---------------------------------------------------------------------------

// A log whose COMPLETED pr-upsert record returns exactly `ref`, so a test can
// hand the adoption path an arbitrary persisted payload.
function completedPrLog(ref: unknown): SideEffectLog {
  return {
    async begin() {
      return {
        recordId: 'rec-pr', existed: true, state: 'COMPLETED',
        resultRef: ref,
      } as unknown as SideEffectRecord;
    },
    async complete() { throw new Error('must not re-complete an adopted PR'); },
    async fail() { throw new Error('unused'); },
  } as unknown as SideEffectLog;
}

function prStepWith(log: SideEffectLog) {
  return upsertPrStep({
    forge: {
      async pushBranch() { throw new Error('unused'); },
      async upsertPullRequest() { throw new Error('a COMPLETED record must not re-upsert'); },
      async resolveRef() { return null; },
      async findPullRequest() { return null; },
    } as unknown as ForgeProvider,
    log,
    scope,
    repositoryBindingId: bindingId,
    attemptId,
    headBranch: 'asep/attempt/a1',
    base: 'main',
    title: 't',
    body: 'b',
    leaseId: 'lease-1',
  });
}

test('HIGH-005: a MALFORMED persisted pr-upsert result_ref fails closed (no blind cast)', async () => {
  // Each of these was silently adopted before the fix.
  const malformed: readonly (readonly [string, unknown])[] = [
    ['number missing', { url: 'u', headBranch: 'h', baseBranch: 'b' }],
    ['number as string', { number: '42', url: 'u', headBranch: 'h', baseBranch: 'b' }],
    ['number zero', { number: 0, url: 'u', headBranch: 'h', baseBranch: 'b' }],
    ['url dropped by a truncated row', { number: 7, headBranch: 'h', baseBranch: 'b' }],
    ['empty headBranch', { number: 7, url: 'u', headBranch: '', baseBranch: 'b' }],
    // The most serious one: a commit ref adopted AS a pull request.
    ['a commit ref, not a PR', { kind: 'commit', commitSha: 'a'.repeat(40), evidenceId: 'ev' }],
    ['not an object at all', 'pr-42'],
  ];
  for (const [label, ref] of malformed) {
    await assert.rejects(
      () => prStepWith(completedPrLog(ref)),
      (err: unknown) => (err as { name?: string })?.name === 'SideEffectResultRefError',
      `${label}: a malformed persisted PR ref must NOT be adopted`,
    );
  }
});

test('HIGH-005: a WELL-FORMED persisted pr-upsert record is still adopted (not blanket-deny)', async () => {
  const res = await prStepWith(completedPrLog({
    kind: 'pr-upsert', number: 42, url: 'https://forge/pr/42',
    headBranch: 'asep/attempt/a1', baseBranch: 'main',
  }));
  assert.equal(res.adopted, true, 'a valid COMPLETED record is adopted, never re-upserted');
  assert.equal(res.pr.number, 42);
  assert.equal(res.pr.url, 'https://forge/pr/42');
  assert.equal(res.pr.baseBranch, 'main');
});

test('a record with NO kind discriminator is refused (closed shape)', async () => {
  // The outcome is a CLOSED shape: `kind` is required and must match the
  // operation. Migration 0013 backfills `kind` on every pre-union row and its
  // CHECK refuses a row without one, so a kind-less payload can only come from
  // something that bypassed the store — exactly what must not be adopted.
  await assert.rejects(
    () => prStepWith(completedPrLog({
      number: 9, url: 'https://forge/pr/9', headBranch: 'asep/attempt/a1', baseBranch: 'main',
    })),
    (err: unknown) => (err as { name?: string })?.name === 'SideEffectResultRefError',
  );
  // An extra, unvalidated key is refused as well.
  await assert.rejects(
    () => prStepWith(completedPrLog({
      kind: 'pr-upsert', number: 9, url: 'https://forge/pr/9',
      headBranch: 'asep/attempt/a1', baseBranch: 'main', merged: true,
    })),
    (err: unknown) => (err as { name?: string })?.name === 'SideEffectResultRefError',
  );
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MED-003 — the spans this driver owns actually FIRE (exit J1/J4).
//
// THE FINDING. Ten span names are declared in SPAN_NAMES but only three were
// ever emitted at runtime (workspace.lease, workspace.create, agent.invoke — all
// in governedExecution). completeToReview owns four more privileged effects and
// had no tracer/audit parameter at all, so J1/J4 rested on instrumentation code
// EXISTING rather than on an operator being able to audit the effects that touch
// the outside world.
//
// This pins emission through the injected `observe` seam: the four boundaries
// fire, in order, each paired with its declared PrivilegedAction. The remaining
// six spans belong to the workflow/governed layers and are asserted on the real
// run in vertical-slice.itest.ts, where a live tracer and a live audit table are
// available.
// ---------------------------------------------------------------------------

test('MED-003: completeToReview EMITS its four privileged boundaries through observe', async () => {
  const seen: { span: string; action: string }[] = [];
  const res = await completeToReview(driverInput({
    observe: async (b, fn) => {
      seen.push({ span: b.span, action: b.action });
      return fn();
    },
  }));
  assert.equal(res.stoppedAt, 'complete', 'the driver still completes with an observer wired');

  // The four effects this driver owns, in the order the governed sequence runs
  // them. `command.execute` fires once per verification check inside verifyStep,
  // so it is asserted separately below.
  const boundaries = seen.filter((s) => s.span !== 'command.execute');
  assert.deepEqual(boundaries, [
    { span: 'git.commit', action: 'git.commit' },
    { span: 'artifact.put', action: 'evidence.put' },
    { span: 'forge.push', action: 'forge.push' },
    { span: 'forge.pull_request', action: 'forge.pull_request.upsert' },
  ], 'each privileged effect emits its declared span paired with its audit action');

  // Every verification command is its own boundary, so an operator can see which
  // check ran rather than only that verification happened.
  const commandSpans = seen.filter((s) => s.span === 'command.execute');
  assert.ok(commandSpans.length > 0, 'each verification command emits command.execute');
  for (const c of commandSpans) {
    assert.equal(c.action, 'command.execute',
      'a command boundary is audited as a command execution, not mislabelled as '
      + 'an artifact write');
  }
});

test('MED-003: an ABSENT observer leaves the driver byte-for-byte unchanged', async () => {
  // The seam must be optional: both K1 proofs and every existing caller pass no
  // observer, so a missing one is a transparent pass-through, never a stop.
  const withOut = await completeToReview(driverInput());
  assert.equal(withOut.stoppedAt, 'complete');
  assert.equal(withOut.commitSha, 'd'.repeat(40));
  assert.equal(withOut.pr?.number, 7);
});

test('MED-003: an UNDECLARED span/action name fails closed (no unnamed span)', async () => {
  // The workflow's real wrapper validates against the closed sets. A typo must
  // throw rather than emit an unnamed span, so this pins that the seam propagates
  // the error instead of swallowing it.
  await assert.rejects(
    () => completeToReview(driverInput({
      observe: async (b) => {
        throw new Error(`unknown span/action pair '${b.span}'/'${b.action}'`);
      },
    })),
    /unknown span\/action pair/,
  );
});

// ---------------------------------------------------------------------------
// M3 — pilot-rehearsal faults injected into the REAL PIPELINE (disp.
// P2-REREVIEW MED-006).
//
// THE FINDING. The rehearsal suite (adapters/persistence/pilot-rehearsal.test.ts)
// injects its faults at the ADAPTER boundary: it proves the object store refuses
// an absent key and that the side-effect log adopts a COMPLETED row. Both are
// true and neither answers the question the runbook actually asks — "does the
// PIPELINE stop, and does it stop BEFORE the next side effect?" A store that
// fails closed is worthless if the driver ignores the throw and pushes anyway.
//
// These two tests inject the same faults through completeToReview, so the
// assertion is on pipeline behaviour: the failure propagates, and the effects
// downstream of it never happen.
// ---------------------------------------------------------------------------

test('M3/Fault3 (pipeline): an object-store outage at the evidence step STOPS before push/PR', async () => {
  const forge = fakeForge(prRef);
  // The outage: the evidence write throws the way a real store does when the
  // object backend is unreachable. Note this is NOT a not-found — evidenceStep
  // must not mistake an outage for "safe to write".
  const store = memoryEvidence({
    async put() {
      const e = new Error('object store unreachable: connect ECONNREFUSED');
      e.name = 'ObjectStoreUnavailableError';
      throw e;
    },
  });

  await assert.rejects(
    () => completeToReview(driverInput({ store, forge })),
    /object store unreachable/,
    'an evidence-persist outage must PROPAGATE, not be swallowed into a pass',
  );

  // The decision the runbook documents: the task does not advance to review with
  // partial evidence. Concretely — no push, no PR.
  assert.equal(forge.pushes, 0, 'F3: no push may follow a failed evidence write');
  assert.equal(forge.upserts, 0, 'F3: no PR may follow a failed evidence write');
});

test('M3/Fault5 (pipeline): a forge rate-limit STOPS the pipeline and opens NO pull request', async () => {
  // The injected fault: GitHub answers 403 rate-limit on the push. MED-002 pins
  // that this is NOT treated as credential expiry; here we pin the pipeline
  // consequence — it stops, and the PR step never runs.
  let upserts = 0;
  const rateLimited: ForgeProvider = {
    async pushBranch() {
      const e = new Error('API rate limit exceeded');
      (e as unknown as { status: number }).status = 403;
      throw e;
    },
    async upsertPullRequest() {
      upserts += 1;
      return prRef;
    },
    async resolveRef() { return null; },
    async findPullRequest() { return null; },
  };

  await assert.rejects(
    () => completeToReview(driverInput({ forge: rateLimited })),
    /rate limit exceeded/,
    'a rate-limited push must propagate so dispatch can back off',
  );
  assert.equal(upserts, 0, 'F5: a failed push must not be followed by a PR upsert');
});
