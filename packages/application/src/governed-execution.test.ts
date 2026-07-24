// governed-execution tests (disp. P2-FINAL-HIGH-003; exit criteria BR1/BR2/I4).
//
// The review found admission could run AFTER a lease + worktree already existed.
// This suite proves the top-level governed use case owns the ordering: for every
// DEFERRED risk (R2..R4) admission stops the sequence BEFORE any irreversible
// side effect — provable with SPIES on the lease repo, workspace manager, agent
// provider and inspector: each spy's call count must be exactly zero. For the
// admitted risks (R0, R1) the spies fire in the mandated order (lease → workspace
// → agent → inspect), and a lease denial stops before the workspace is created.
//
// Machine-readable suite marker (K4) so a dropped/renamed suite turns the gate RED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  TenantScope,
  AttemptId,
  ArtifactRef,
  Budget,
  OrganizationId,
  ProjectId,
  RepositoryBindingId,
  WorkspaceId,
} from '@asep/contracts';
import type {
  CodingAgentProvider,
  AgentExecuteRequest,
  AgentAttemptObservation,
  GitChangeInspector,
  GitChangeObservation,
  WorkspaceCapability,
  ToolPolicyProfile,
  WorkspaceLeaseRepository,
  WorkspaceManager,
  Workspace,
  Lease,
  LeaseDenied,
} from '@asep/ports';
import { governedExecution } from './governed-execution.js';

console.log('SUITE-ID: asep-suite:governed-execution');

const scope: TenantScope = {
  organizationId: 'org-1' as OrganizationId,
  projectId: 'proj-1' as ProjectId,
};
const repositoryBindingId = 'bind-1' as RepositoryBindingId;
const attemptId = 'attempt-1' as AttemptId;
const branch = 'asep/run/task/attempt';
const baseSha = 'a'.repeat(40);

const budget: Budget = { maxTurns: 10, maxToolCalls: 100, maxCostUsd: 5, maxWallClockMinutes: 15 };
const toolPolicy: ToolPolicyProfile = {
  allowedTools: ['read', 'write'], disallowedTools: ['network'], networkProfile: 'no-network',
};
const workOrderRef: ArtifactRef = { artifactId: 'art-wo' as never, sha256: 'a'.repeat(64), kind: 'work-order' };
const contextPackRef: ArtifactRef = { artifactId: 'art-cp' as never, sha256: 'b'.repeat(64), kind: 'context-pack' };

const okObservation: AgentAttemptObservation = {
  status: 'AGENT_DONE',
  summary: 'done',
  knownLimitations: [],
  usage: { inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1 },
  eventArtifactRefs: [],
};

const cleanChange: GitChangeObservation = {
  headSha: 'c'.repeat(40),
  changedFiles: ['src/foo.ts'],
  createdRefs: [],
  touchedGitDir: false,
  baseSha: 'c'.repeat(40),
  headMovedFromBase: false,
  diff: { artifactId: 'art-diff' as never, sha256: 'd'.repeat(64), kind: 'git-diff' },
};

// --- spies: every port records how many times it was actually driven ---------

interface Spies {
  leaseCalls: number;
  workspaceCalls: number;
  agentCalls: number;
  inspectCalls: number;
}

function makeSpies(opts: {
  leaseOutcome?: Lease | LeaseDenied;
  observation?: AgentAttemptObservation;
  change?: GitChangeObservation;
} = {}): {
  spies: Spies;
  leases: WorkspaceLeaseRepository;
  workspaces: WorkspaceManager;
  provider: CodingAgentProvider;
  inspector: GitChangeInspector;
} {
  const spies: Spies = { leaseCalls: 0, workspaceCalls: 0, agentCalls: 0, inspectCalls: 0 };
  const grantedLease: Lease = {
    leaseId: 'lease-1', repositoryBindingId, branch, attemptId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const workspace: Workspace = {
    workspaceId: 'ws-1' as WorkspaceId,
    capability: { workspaceId: 'ws-1' as WorkspaceId, leaseId: 'lease-1' } as WorkspaceCapability,
    baseSha,
  };
  const leases: WorkspaceLeaseRepository = {
    async acquire(): Promise<Lease | LeaseDenied> {
      spies.leaseCalls++;
      return opts.leaseOutcome ?? grantedLease;
    },
    async heartbeat(): Promise<void> {},
    async release(): Promise<void> {},
  };
  const workspaces: WorkspaceManager = {
    async create(): Promise<Workspace> {
      spies.workspaceCalls++;
      return workspace;
    },
    async cleanup(): Promise<void> {},
    async quarantine(): Promise<void> {},
  };
  const provider: CodingAgentProvider = {
    providerId: 'spy',
    async execute(_req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
      spies.agentCalls++;
      return opts.observation ?? okObservation;
    },
  };
  const inspector: GitChangeInspector = {
    async inspect(): Promise<GitChangeObservation> {
      spies.inspectCalls++;
      return opts.change ?? cleanChange;
    },
  };
  return { spies, leases, workspaces, provider, inspector };
}

function inputWith(risk: 'R0' | 'R1' | 'R2' | 'R3' | 'R4', h: ReturnType<typeof makeSpies>) {
  return {
    scope,
    risk,
    repositoryBindingId,
    attemptId,
    baseSha,
    branch,
    leaseTtlMs: 60_000,
    leases: h.leases,
    workspaces: h.workspaces,
    provider: h.provider,
    inspector: h.inspector,
    workOrderRef,
    contextPackRef,
    budget,
    toolPolicy,
    signal: new AbortController().signal,
  };
}

// --- R2..R4: DEFERRED — nothing irreversible may happen ----------------------

for (const risk of ['R2', 'R3', 'R4'] as const) {
  test(`${risk} is DEFERRED at admission — NO lease/workspace/agent/inspect side effect`, async () => {
    const h = makeSpies();
    const result = await governedExecution(inputWith(risk, h));
    assert.equal(result.admitted, false, `${risk} must not be admitted`);
    assert.equal(result.stoppedAt, 'admission', `${risk} must stop at admission`);
    // The core HIGH-003 property: every downstream port is untouched.
    assert.equal(h.spies.leaseCalls, 0, 'no lease acquired for a deferred risk');
    assert.equal(h.spies.workspaceCalls, 0, 'no workspace created for a deferred risk');
    assert.equal(h.spies.agentCalls, 0, 'agent NEVER invoked for a deferred risk');
    assert.equal(h.spies.inspectCalls, 0, 'no inspection for a deferred risk');
    // No workspace/lease handles leaked into the result.
    assert.equal(result.leaseId, undefined);
    assert.equal(result.workspaceId, undefined);
  });
}

// --- R0: admitted — the ordered sequence runs exactly once each --------------

test('R0 admitted: lease → workspace → agent → inspect run once, in order', async () => {
  const h = makeSpies();
  const result = await governedExecution(inputWith('R0', h));
  assert.equal(result.admitted, true);
  assert.equal(result.stoppedAt, 'ready-for-completion');
  assert.equal(h.spies.leaseCalls, 1);
  assert.equal(h.spies.workspaceCalls, 1);
  assert.equal(h.spies.agentCalls, 1);
  assert.equal(h.spies.inspectCalls, 1);
  assert.equal(result.leaseId, 'lease-1');
  assert.equal(result.workspaceId, 'ws-1');
  // resultSha/changedFiles are the INSPECTOR's, never the provider's.
  assert.equal(result.change?.headSha, cleanChange.headSha);
  assert.equal(result.requiresHumanIndependentReview, false);
});

// --- R1: admitted but flags mandatory human independent review ---------------

test('R1 admitted: sequence runs and a human independent review is required', async () => {
  const h = makeSpies();
  const result = await governedExecution(inputWith('R1', h));
  assert.equal(result.admitted, true);
  assert.equal(result.stoppedAt, 'ready-for-completion');
  assert.equal(result.requiresHumanIndependentReview, true);
  assert.equal(h.spies.agentCalls, 1);
});

// --- lease denial: stops BEFORE the workspace is created ---------------------

test('a lease denial stops before workspace creation (no workspace/agent side effect)', async () => {
  const h = makeSpies({ leaseOutcome: { denied: true, reason: 'held by another attempt' } });
  const result = await governedExecution(inputWith('R0', h));
  assert.equal(result.admitted, true, 'admission passed');
  assert.equal(result.stoppedAt, 'lease-denied');
  assert.equal(h.spies.leaseCalls, 1, 'a lease acquisition was attempted');
  assert.equal(h.spies.workspaceCalls, 0, 'NO workspace created when the lease is denied');
  assert.equal(h.spies.agentCalls, 0, 'agent NEVER invoked when the lease is denied');
  assert.equal(h.spies.inspectCalls, 0);
});

// --- a non-AGENT_DONE observation stops before inspection --------------------

test('a non-AGENT_DONE agent observation stops before inspection', async () => {
  const h = makeSpies({ observation: { ...okObservation, status: 'BUDGET_EXHAUSTED' } });
  const result = await governedExecution(inputWith('R0', h));
  assert.equal(result.stoppedAt, 'agent');
  assert.equal(h.spies.agentCalls, 1);
  assert.equal(h.spies.inspectCalls, 0, 'no inspection after a stopped agent');
});

// --- an agent that oversteps (touched .git / created a ref) stops at inspect --

test('an agent that created a ref is stopped at inspect (harness owns commit identity)', async () => {
  const dirty: GitChangeObservation = { ...cleanChange, createdRefs: ['refs/heads/agent-made-this'] };
  const h = makeSpies({ change: dirty });
  const result = await governedExecution(inputWith('R0', h));
  assert.equal(result.stoppedAt, 'inspect');
  assert.equal(h.spies.inspectCalls, 1);
});
