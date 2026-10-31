// The orchestration activities' test harness: the activities composed over the
// accepted pipeline primitives on a real database (PGlite) — the side-effect log,
// the lease repository, the evidence and artifact stores, the run-event sink and
// the attempt-terminal store under the default review-loop slot — and over
// in-memory doubles for what later slices provide (the attempt registry, the
// workspace registry, the ledger, approvals, projection, the forge reads).
//
// Every external call the doubles receive is appended to `calls`, so a test can
// assert the order of a fence check, an abort check and the call it guards. The
// forge double holds real branch and pull-request state, refuses a push whose
// expected value does not match (compare-and-set), and lets a test pause a call
// inside the transport to interleave a second owner.
//
// Test support only: imported by the orchestration activity suites.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactId, ArtifactRef, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId, TenantScope,
  WorkspaceId,
} from '@asep/contracts';
import type {
  ActivityExecutionContext, ActivityProgress, AgentAttemptObservation, CodingAgentProvider, CommandRunner,
  CommandSpec, ExecutionReaper, ForgeProvider, GitChangeInspector, GitCommitter, PullRequestRef, SandboxProvider,
  SideEffectLog, VerificationCommandCatalog, WorkspaceManager, WorkspaceRecord, WorkspaceRegistry,
} from '@asep/ports';
import { UnknownVerificationCommandError } from '@asep/ports';
import {
  ContentAddressedArtifactStore, ContentAddressedEvidenceStore, FilesystemObjectStore, PgliteClient,
  SqlAttemptTerminalStore, SqlRunEventSink, SqlSideEffectLog, SqlWorkspaceLeaseRepository, migrate,
} from '@asep/persistence';
import type { SqlClient, SqlExecutor } from '@asep/persistence';
import { CapturingTelemetrySink, SpanTracer, type AuditEvent } from '@asep/observability';
import type { ReviewLoopSlot } from '../review-loop/slot.js';
import { NotConfiguredAssuranceSlot } from './not-configured-slot.js';
import type { OrchestrationActivityDeps } from './deps.js';
import { createOrchestrationActivities, type OrchestrationActivities } from './activities.js';
import type { AttemptActivityIdentity, LeasedAttemptIdentity, TaskActivityIdentity } from './identity.js';
import type {
  ApprovalDecisionRecord, ApprovalRequestRecord, ApprovalStore, AttemptFactKind, AttemptFactStore,
  AttemptRegistration, AttemptRegistry, BudgetLedger, ForgeRepositoryRef, LedgerEntry, ListedPullRequest,
  OrchestrationAuditLog, ProjectionWriter, PublicationReader,
} from './ports.js';
import { AttemptIdentityConflictError, ProjectionOwnershipError } from './ports.js';

export const IDS = {
  organizationId: '01K00000000000000000000001' as OrganizationId,
  projectId: '01K00000000000000000000002' as ProjectId,
  bindingId: '01K00000000000000000000003' as RepositoryBindingId,
  runId: '01K00000000000000000000004' as RunId,
  taskId: '01K00000000000000000000005' as TaskId,
};
export const SCOPE: TenantScope = { organizationId: IDS.organizationId, projectId: IDS.projectId };
export const TASK_BASE = 'b'.repeat(40);
export const REPOSITORY: ForgeRepositoryRef = { id: 4242, owner: 'acme', name: 'web' };
export const WORKFLOW_ID = `asep-task-${IDS.taskId}`;
export const LOGICAL_NOW = '2026-10-31T12:00:00.000Z';

export const TASK: TaskActivityIdentity = {
  scope: SCOPE, repositoryBindingId: IDS.bindingId, runId: IDS.runId, taskId: IDS.taskId, risk: 'R0', workflowId: WORKFLOW_ID,
};

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const sha40 = (seed: string): string => sha256(seed).slice(0, 40);

let ulidCounter = 0;
/** A fresh ULID-shaped id for the doubles' rows. */
export function nextUlid(): string {
  ulidCounter += 1;
  return `01K${String(ulidCounter).padStart(23, '0')}`;
}

// --- one connection, serialized ---------------------------------------------------

/** PGlite has one connection: every query and transaction runs after the one before it ends. */
class SerialClient implements SqlClient {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: SqlClient) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
  query(text: string, params?: Parameters<SqlExecutor['query']>[1]) {
    return this.serial(() => this.db.query(text, params));
  }
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serial(() => this.db.transaction(fn));
  }
  ping(): Promise<boolean> {
    return this.db.ping();
  }
  close(): Promise<void> {
    return this.db.close();
  }
}

// --- the doubles ----------------------------------------------------------------------

/** The attempt registry over the attempts table, keyed in memory by (task, number), as the attempt ordinal columns will be. */
export class TableAttemptRegistry implements AttemptRegistry {
  readonly byKey = new Map<string, { readonly attemptId: AttemptId; readonly registration: AttemptRegistration }>();
  failNextEnsureAfterInsert = false;
  constructor(private readonly db: SqlClient) {}

  async ensure(scope: TenantScope, r: AttemptRegistration): Promise<{ readonly attemptId: AttemptId }> {
    const key = `${r.taskId}:${r.attemptNumber}`;
    const found = this.byKey.get(key);
    if (found !== undefined) {
      for (const field of ['kind', 'baseSha', 'parentAttemptNumber'] as const) {
        if (found.registration[field] !== r[field]) throw new AttemptIdentityConflictError(r.taskId, r.attemptNumber, field);
      }
      if (JSON.stringify(found.registration.repairOrderRef) !== JSON.stringify(r.repairOrderRef)) {
        throw new AttemptIdentityConflictError(r.taskId, r.attemptNumber, 'repairOrderRef');
      }
      return { attemptId: found.attemptId };
    }
    const attemptId = nextUlid() as AttemptId;
    await this.db.query(
      `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status, base_sha)
       values ($1, $2, $3, $4, $5, 'STARTED', $6)`,
      [attemptId, scope.organizationId, scope.projectId, r.taskId, r.repositoryBindingId, r.baseSha],
    );
    this.byKey.set(key, { attemptId, registration: r });
    if (this.failNextEnsureAfterInsert) {
      this.failNextEnsureAfterInsert = false;
      throw new Error('injected failure after the attempt row was inserted');
    }
    return { attemptId };
  }

  async find(_scope: TenantScope, key: { readonly taskId: TaskId; readonly attemptNumber: number }): Promise<AttemptId | null> {
    return this.byKey.get(`${key.taskId}:${key.attemptNumber}`)?.attemptId ?? null;
  }
}

export class MemoryFactStore implements AttemptFactStore {
  readonly facts = new Map<string, unknown>();
  async putOnce(_s: TenantScope, input: { readonly attemptId: AttemptId; readonly kind: AttemptFactKind; readonly value: unknown }) {
    const key = `${input.attemptId}:${input.kind}`;
    if (this.facts.has(key)) return { value: structuredClone(this.facts.get(key)), created: false };
    this.facts.set(key, structuredClone(input.value));
    return { value: structuredClone(input.value), created: true };
  }
  async get(_s: TenantScope, input: { readonly attemptId: AttemptId; readonly kind: AttemptFactKind }): Promise<unknown> {
    const key = `${input.attemptId}:${input.kind}`;
    return this.facts.has(key) ? structuredClone(this.facts.get(key)) : null;
  }
}

export class MemoryWorkspaces implements WorkspaceRegistry, WorkspaceManager {
  readonly records = new Map<string, WorkspaceRecord>();
  constructor(private readonly hostId: string, private readonly calls: string[]) {}

  async begin(_s: TenantScope, rec: Omit<WorkspaceRecord, 'state' | 'baselineRefs'>): Promise<WorkspaceRecord> {
    const existing = [...this.records.values()].find((r) => r.attemptId === rec.attemptId);
    if (existing !== undefined) return existing;
    const created: WorkspaceRecord = { ...rec, state: 'CREATING', baselineRefs: [] };
    this.records.set(rec.workspaceId, created);
    return created;
  }
  async activate(_s: TenantScope, input: { readonly workspaceId: WorkspaceId; readonly baselineRefs: readonly string[] }) {
    const r = this.records.get(input.workspaceId)!;
    const active: WorkspaceRecord = { ...r, state: 'ACTIVE', baselineRefs: input.baselineRefs };
    this.records.set(input.workspaceId, active);
    return active;
  }
  async findByAttempt(_s: TenantScope, attemptId: AttemptId) {
    return [...this.records.values()].find((r) => r.attemptId === attemptId) ?? null;
  }
  async findById(_s: TenantScope, workspaceId: WorkspaceId) {
    return this.records.get(workspaceId) ?? null;
  }
  async markState(_s: TenantScope, input: { readonly workspaceId: WorkspaceId; readonly state: 'CLEANED' | 'QUARANTINED' }) {
    const r = this.records.get(input.workspaceId)!;
    this.records.set(input.workspaceId, { ...r, state: input.state });
  }

  // The manager: create-or-adopt keyed by the attempt, registered on this host.
  async create(scope: TenantScope, input: { repositoryBindingId: RepositoryBindingId; baseSha: string; leaseId: string; attemptId: AttemptId }) {
    this.calls.push('workspaces.create');
    const found = await this.findByAttempt(scope, input.attemptId);
    const rec = found ?? await this.begin(scope, {
      workspaceId: nextUlid() as WorkspaceId, repositoryBindingId: input.repositoryBindingId, attemptId: input.attemptId,
      leaseId: input.leaseId, hostId: this.hostId, pathRel: `ws/${input.attemptId}`, baseSha: input.baseSha,
    });
    const active = rec.state === 'ACTIVE' ? rec : await this.activate(scope, { workspaceId: rec.workspaceId, baselineRefs: [] });
    return { workspaceId: active.workspaceId, capability: { workspaceId: active.workspaceId, leaseId: active.leaseId }, baseSha: active.baseSha };
  }
  async cleanup(scope: TenantScope, workspaceId: WorkspaceId) {
    this.calls.push('workspaces.cleanup');
    await this.markState(scope, { workspaceId, state: 'CLEANED' });
  }
  async quarantine(scope: TenantScope, workspaceId: WorkspaceId) {
    this.calls.push('workspaces.quarantine');
    await this.markState(scope, { workspaceId, state: 'QUARANTINED' });
  }
}

/** The harness commit: one per attempt, recorded before HEAD moves, and found again by the attempt. */
export class MemoryCommitter implements GitCommitter {
  readonly commits = new Map<string, { readonly commitSha: string; readonly evidenceId: string; readonly baseSha: string }>();
  constructor(private readonly calls: string[]) {}
  async commit(_s: TenantScope, input: { attemptId: string; baseSha: string; trailers: Record<string, string> }) {
    this.calls.push('committer.commit');
    const existing = this.commits.get(input.attemptId);
    if (existing !== undefined) return { commitSha: existing.commitSha };
    const commitSha = sha40(`commit:${input.attemptId}`);
    this.commits.set(input.attemptId, { commitSha, evidenceId: input.trailers['ASEP-Evidence']!, baseSha: input.baseSha });
    return { commitSha };
  }
  async reconcile(_s: TenantScope, input: { attemptId: string; baseSha: string }) {
    const c = this.commits.get(input.attemptId);
    return c === undefined ? null : { commitSha: c.commitSha, evidenceId: c.evidenceId };
  }
}

export interface MemoryPullRequest {
  number: number;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRepository: ForgeRepositoryRef;
  baseRepository: ForgeRepositoryRef;
}

/**
 * The forge: branches and pull requests with GitHub's rules as the port states them. A push is compare-and-set;
 * an upsert updates the open PR on the base, returns any other PR for the head as found, or creates one. `pause`
 * holds a call inside the transport (after its read, before its write) until the test releases it.
 */
export class MemoryForge implements ForgeProvider, PublicationReader {
  readonly branches = new Map<string, string>();
  readonly prs: MemoryPullRequest[] = [];
  readonly writes: string[] = [];
  pause: { readonly call: 'pushBranch' | 'upsertPullRequest'; readonly reached: () => void; readonly release: Promise<void> } | null = null;
  failNext: { readonly call: string; readonly error: Error; readonly afterWrite: boolean } | null = null;
  constructor(private readonly calls: string[], readonly repository: ForgeRepositoryRef = REPOSITORY) {}

  private async inTransport(call: 'pushBranch' | 'upsertPullRequest'): Promise<void> {
    const p = this.pause;
    if (p !== null && p.call === call) {
      this.pause = null;
      p.reached();
      await p.release;
    }
  }
  private failBefore(call: string): void {
    const f = this.failNext;
    if (f !== null && f.call === call && !f.afterWrite) {
      this.failNext = null;
      throw f.error;
    }
  }
  private failAfter(call: string): void {
    const f = this.failNext;
    if (f !== null && f.call === call && f.afterWrite) {
      this.failNext = null;
      throw f.error;
    }
  }

  async pushBranch(_s: TenantScope, input: { branch: string; commitSha: string; expectedRemoteSha: string | null }): Promise<void> {
    this.calls.push('forge.pushBranch');
    this.failBefore('pushBranch');
    await this.inTransport('pushBranch');
    const current = this.branches.get(input.branch) ?? null;
    if (current === input.commitSha) return;
    if (current !== input.expectedRemoteSha) {
      throw new Error(`push refused: ${input.branch} holds ${current ?? 'nothing'}, not ${input.expectedRemoteSha ?? 'nothing'}`);
    }
    this.branches.set(input.branch, input.commitSha);
    this.writes.push(`push ${input.branch}@${input.commitSha}`);
    this.failAfter('pushBranch');
  }

  private ref(pr: MemoryPullRequest): PullRequestRef {
    const headSha = this.branches.get(pr.headBranch);
    return {
      number: pr.number, url: `https://github.test/acme/web/pull/${pr.number}`, headBranch: pr.headBranch,
      baseBranch: pr.baseBranch, ...(headSha !== undefined ? { headSha } : {}), title: pr.title, body: pr.body,
      state: pr.state, merged: pr.merged,
    };
  }

  async upsertPullRequest(_s: TenantScope, input: { headBranch: string; base: string; title: string; body: string }): Promise<PullRequestRef> {
    this.calls.push('forge.upsertPullRequest');
    this.failBefore('upsertPullRequest');
    const found = this.prs.find((p) => p.headBranch === input.headBranch);
    await this.inTransport('upsertPullRequest');
    let pr: MemoryPullRequest;
    if (found !== undefined) {
      pr = found;
      if (found.state === 'open' && !found.merged && found.baseBranch === input.base) {
        found.title = input.title;
        found.body = input.body;
        this.writes.push(`update #${found.number}`);
      }
    } else {
      pr = {
        number: this.prs.length + 1, headBranch: input.headBranch, baseBranch: input.base, title: input.title,
        body: input.body, state: 'open', merged: false, headRepository: this.repository, baseRepository: this.repository,
      };
      this.prs.push(pr);
      this.writes.push(`create #${pr.number}`);
    }
    this.failAfter('upsertPullRequest');
    return this.ref(pr);
  }

  async updatePullRequestContent(_s: TenantScope, input: { number: number; title: string; body: string }): Promise<PullRequestRef> {
    this.calls.push('forge.updatePullRequestContent');
    const pr = this.prs.find((p) => p.number === input.number);
    if (pr === undefined) throw new Error(`no pull request #${input.number}`);
    pr.title = input.title;
    pr.body = input.body;
    this.writes.push(`content #${pr.number}`);
    return this.ref(pr);
  }

  async resolveRef(_s: TenantScope, input: { branch: string }): Promise<string | null> {
    this.calls.push('forge.resolveRef');
    return this.branches.get(input.branch) ?? null;
  }

  async findPullRequest(_s: TenantScope, input: { headBranch: string }): Promise<PullRequestRef | null> {
    this.calls.push('forge.findPullRequest');
    const pr = this.prs.find((p) => p.headBranch === input.headBranch);
    return pr === undefined ? null : this.ref(pr);
  }

  // The publication reads, repositories by numeric id.
  async readBranch(_s: TenantScope, input: { readonly branch: string }) {
    this.calls.push('reader.readBranch');
    const headSha = this.branches.get(input.branch);
    return headSha === undefined ? null : { repository: this.repository, headSha };
  }

  async listPullRequests(_s: TenantScope, input: { readonly headBranch: string }): Promise<readonly ListedPullRequest[]> {
    this.calls.push('reader.listPullRequests');
    return this.prs.filter((p) => p.headBranch === input.headBranch).map((p) => ({
      number: p.number, headRepository: p.headRepository, headBranch: p.headBranch,
      headSha: this.branches.get(p.headBranch) ?? '0'.repeat(40), baseRepository: p.baseRepository,
      baseBranch: p.baseBranch, state: p.state, merged: p.merged, title: p.title, body: p.body,
    }));
  }
}

export class MemoryLedger implements BudgetLedger {
  readonly entries = new Map<string, LedgerEntry>();
  async append(_s: TenantScope, entry: LedgerEntry) {
    if (this.entries.has(entry.idempotencyKey)) return { appended: false };
    this.entries.set(entry.idempotencyKey, entry);
    return { appended: true };
  }
}

export class MemoryApprovals implements ApprovalStore {
  readonly requests = new Map<string, ApprovalRequestRecord & { status: string }>();
  readonly decisions = new Map<string, ApprovalDecisionRecord>();
  async open(_s: TenantScope, request: ApprovalRequestRecord) {
    if (this.requests.has(request.approvalRequestId)) return { opened: false };
    this.requests.set(request.approvalRequestId, { ...request, status: 'PENDING' });
    return { opened: true };
  }
  async findDecision(_s: TenantScope, key: { readonly approvalRequestId: string; readonly decisionId: string }) {
    const d = this.decisions.get(key.decisionId);
    return d !== undefined && d.approvalRequestId === key.approvalRequestId ? d : null;
  }
  async close(_s: TenantScope, input: { readonly approvalRequestId: string; readonly status: 'EXPIRED' | 'CANCELLED' }) {
    const r = this.requests.get(input.approvalRequestId);
    if (r === undefined || r.status !== 'PENDING') return { closed: false };
    r.status = input.status;
    return { closed: true };
  }
}

export class MemoryProjection implements ProjectionWriter {
  readonly tasks = new Map<string, { workflowId: string; projectionSeq: number; status: string }>();
  async projectTask(_s: TenantScope, input: { readonly taskId: TaskId; readonly workflowId: string; readonly projectionSeq: number; readonly status: string }) {
    const row = this.tasks.get(input.taskId);
    if (row !== undefined && row.workflowId !== input.workflowId) throw new ProjectionOwnershipError(`task ${input.taskId}`, input.workflowId);
    if (row !== undefined && row.projectionSeq >= input.projectionSeq) return { applied: false };
    this.tasks.set(input.taskId, { workflowId: input.workflowId, projectionSeq: input.projectionSeq, status: input.status });
    return { applied: true };
  }
}

export class MemoryAuditLog implements OrchestrationAuditLog {
  readonly rows = new Map<string, AuditEvent>();
  async record(_s: TenantScope, entry: { readonly key: string; readonly event: AuditEvent }) {
    if (this.rows.has(entry.key)) return { recorded: false };
    this.rows.set(entry.key, entry.event);
    return { recorded: true };
  }
}

// --- the harness ----------------------------------------------------------------------

export interface AgentScript {
  observation: AgentAttemptObservation;
  /** Called while the agent runs, with its signal. */
  during?: (signal: AbortSignal) => Promise<void>;
}

export interface Harness {
  readonly db: SqlClient;
  readonly calls: string[];
  readonly activities: OrchestrationActivities;
  readonly deps: OrchestrationActivityDeps;
  readonly attempts: TableAttemptRegistry;
  readonly facts: MemoryFactStore;
  readonly workspaces: MemoryWorkspaces;
  readonly committer: MemoryCommitter;
  readonly forge: MemoryForge;
  readonly ledger: MemoryLedger;
  readonly approvals: MemoryApprovals;
  readonly projection: MemoryProjection;
  readonly audit: MemoryAuditLog;
  readonly telemetry: CapturingTelemetrySink;
  readonly terminals: SqlAttemptTerminalStore;
  readonly leases: SqlWorkspaceLeaseRepository;
  readonly artifacts: ContentAddressedArtifactStore;
  readonly sideEffects: SideEffectLog;
  /** Called after every spied call is noted, with its name: lets a test act between a check and the call it guards. */
  readonly hooks: { afterCall: ((name: string) => void) | null };
  agent: AgentScript;
  /** Exit codes by command id; absent means 0. */
  exitCodes: Map<string, number>;
  ctx(overrides?: Partial<ActivityExecutionContext> & { readonly heartbeats?: ActivityProgress[] }): ActivityExecutionContext;
  /** Registers attempt n and acquires its lease: the identity an attempt-bound activity is called with. */
  leasedAttempt(attemptNumber: number): Promise<LeasedAttemptIdentity>;
  registered(attemptNumber: number): Promise<AttemptActivityIdentity>;
  workOrderRef: ArtifactRef;
  contextPackRef: ArtifactRef;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * The verification sandbox. A suite passes its own: only the Docker sandbox provider may claim isolation in
   * shipped source, and test support is shipped source.
   */
  readonly sandbox: SandboxProvider;
  readonly slot?: (store: SqlAttemptTerminalStore) => ReviewLoopSlot;
  readonly tracer?: boolean;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const raw = await PgliteClient.create();
  await migrate(raw);
  const db = new SerialClient(raw);
  const q = (sql: string, params: unknown[]) => db.query(sql, params as never);
  await q('insert into organizations (id, name) values ($1, $2)', [IDS.organizationId, 'acme']);
  await q(`insert into projects (id, organization_id, name, default_branch) values ($1, $2, 'web', 'main')`, [IDS.projectId, IDS.organizationId]);
  await q(
    `insert into repository_bindings (id, organization_id, project_id, forge, github_host, github_owner, github_repo, default_base_branch)
     values ($1, $2, $3, 'github', 'github.com', 'acme', 'web', 'main')`,
    [IDS.bindingId, IDS.organizationId, IDS.projectId],
  );
  await q(`insert into runs (id, organization_id, project_id, repository_binding_id, status, risk) values ($1, $2, $3, $4, 'EXECUTING', 'R0')`,
    [IDS.runId, IDS.organizationId, IDS.projectId, IDS.bindingId]);
  await q(`insert into tasks (id, organization_id, project_id, run_id, repository_binding_id, status, risk) values ($1, $2, $3, $4, $5, 'EXECUTING', 'R0')`,
    [IDS.taskId, IDS.organizationId, IDS.projectId, IDS.runId, IDS.bindingId]);

  const dir = mkdtempSync(join(tmpdir(), 'asep-activities-'));
  const objects = new FilesystemObjectStore(dir);
  const artifacts = new ContentAddressedArtifactStore(db, objects);
  const hooks: { afterCall: ((name: string) => void) | null } = { afterCall: null };
  const calls: string[] = [];
  const push = calls.push.bind(calls);
  calls.push = (...names: string[]): number => {
    const n = push(...names);
    for (const name of names) hooks.afterCall?.(name);
    return n;
  };
  const terminals = new SqlAttemptTerminalStore(db);
  const leases = new SqlWorkspaceLeaseRepository(db);
  const attempts = new TableAttemptRegistry(db);
  const facts = new MemoryFactStore();
  const workspaces = new MemoryWorkspaces('host-a', calls);
  const committer = new MemoryCommitter(calls);
  const forge = new MemoryForge(calls);
  const ledger = new MemoryLedger();
  const approvals = new MemoryApprovals();
  const projection = new MemoryProjection();
  const audit = new MemoryAuditLog();
  const telemetry = new CapturingTelemetrySink();
  const log = new SqlSideEffectLog(db);
  const sideEffects: SideEffectLog = {
    begin: async (s, i) => { calls.push(`log.begin ${i.operation}`); return log.begin(s, i); },
    confirmOwner: async (s, i) => { calls.push(`log.confirmOwner ${i.operation}`); return log.confirmOwner(s, i); },
    complete: async (s, i) => { calls.push(`log.complete ${i.operation}`); return log.complete(s, i); },
    fail: (s, i) => log.fail(s, i),
    find: (s, k) => log.find(s, k),
  };

  const put = async (kind: string, value: unknown): Promise<ArtifactRef> => {
    const content = new TextEncoder().encode(JSON.stringify(value));
    return artifacts.put(SCOPE, { kind, content, sha256: sha256(content), contentType: 'application/json' });
  };
  const workOrderRef = await put('work-order', { id: IDS.taskId, allowedPaths: ['src/'] });
  const contextPackRef = await put('context-pack', { task: IDS.taskId });
  const diffRef = await put('diff', { diff: 'src/a.ts' });

  const inspector: GitChangeInspector = {
    async inspect() {
      calls.push('inspector.inspect');
      return {
        headSha: TASK_BASE, changedFiles: ['src/a.ts'], createdRefs: [], touchedGitDir: false,
        baseSha: TASK_BASE, headMovedFromBase: false, diff: diffRef,
      };
    },
  };
  const reaper: ExecutionReaper = {
    async reap(_s, input) {
      calls.push(`reaper.reap ${input.role ?? 'all'}`);
      return { removed: 0 };
    },
  };
  const catalog: VerificationCommandCatalog = {
    async resolve(_s, input) {
      if (!input.commandId.startsWith('cmd-')) throw new UnknownVerificationCommandError(input.repositoryBindingId, input.commandId);
      const spec: CommandSpec = {
        executable: 'node', args: ['--test', input.commandId], cwd: '.', environmentProfile: 'verification',
        timeoutMs: 60_000, outputPolicy: { maxEvidenceBytes: 1 << 20, displayHeadBytes: 100, displayTailBytes: 100 },
      };
      return spec;
    },
  };
  const outputRef = await put('command-output', { out: 'ok' });
  const harness: Partial<Harness> & { agent: AgentScript; exitCodes: Map<string, number> } = {
    agent: {
      observation: {
        status: 'AGENT_DONE', summary: 'done', knownLimitations: [],
        usage: { inputTokens: 100, outputTokens: 50, modelCostUsd: 0.25, toolCalls: 7, wallClockMs: 1000 },
        eventArtifactRefs: [],
      },
    },
    exitCodes: new Map(),
  };
  const runner: CommandRunner = {
    async run(spec, _handle, options) {
      calls.push(`runner.run ${spec.args[1] ?? ''}`);
      if (options?.signal?.aborted === true) {
        return { exitCode: null, signal: 'SIGKILL', timedOut: false, stdout: outputRef, stderr: outputRef, stdoutBytes: 0, stderrBytes: 0, truncated: false };
      }
      return {
        exitCode: harness.exitCodes.get(spec.args[1] ?? '') ?? 0, signal: null, timedOut: false,
        stdout: outputRef, stderr: outputRef, stdoutBytes: 2, stderrBytes: 2, truncated: false,
      };
    },
  };
  const provider: CodingAgentProvider = {
    providerId: 'scripted-agent',
    async execute(req) {
      calls.push('agent.execute');
      if (harness.agent.during !== undefined) await harness.agent.during(req.signal);
      return harness.agent.observation;
    },
  };

  let clock = 0;
  const deps: OrchestrationActivityDeps = {
    attempts,
    leases: {
      acquire: (s, input) => { calls.push('leases.acquire'); return terminals.acquireLease(s, input); },
      findByAttempt: (s, attempt) => { calls.push('leases.findByAttempt'); return terminals.findLease(s, attempt); },
      heartbeat: (s, leaseId) => { calls.push('leases.heartbeat'); return leases.heartbeat(s, leaseId); },
      release: (s, leaseId) => { calls.push('leases.release'); return leases.release(s, leaseId); },
    },
    leaseTtlMs: 3_600_000,
    facts,
    branchFor: ({ attemptId }) => `asep/attempt-${attemptId}`,
    workspaceRegistry: workspaces,
    hostId: 'host-a',
    gitBackend: () => ({ workspaces, inspector, committer, pathOf: (id) => `/ws/${id}` }),
    reaper,
    providerFor: () => provider,
    toolPolicy: { allowedTools: [], disallowedTools: [], networkProfile: 'restricted-egress' },
    monotonicMs: () => { clock += 1500; return clock; },
    heartbeatEveryMs: 10_000,
    leaseRenewEveryMs: 60_000,
    catalog,
    runnerFor: () => runner,
    sandbox: options.sandbox,
    artifacts,
    evidence: new ContentAddressedEvidenceStore(db, objects),
    environment: { imageDigest: `sha256:${'d'.repeat(64)}`, lockfileHash: 'e'.repeat(64) },
    commitIdentity: { name: 'asep-bot', email: 'bot@asep.test' },
    sideEffects,
    forge,
    publicationReader: forge,
    slot: options.slot !== undefined ? options.slot(terminals) : new NotConfiguredAssuranceSlot(terminals),
    implementer: { providerId: 'scripted-agent', model: 'model-1' },
    projection,
    ledger,
    approvals,
    runEvents: new SqlRunEventSink(db),
    audit,
    ...(options.tracer === true ? { tracer: new SpanTracer(telemetry, () => 0) } : {}),
    actor: 'harness:test',
  };

  const registered = async (n: number): Promise<AttemptActivityIdentity> => {
    const r = await createOrchestrationActivities(deps).ensureAttempt({
      ...TASK, attemptNumber: n, attemptKind: n === 1 ? 'initial' : 'retry', baseSha: TASK_BASE, parentAttemptNumber: null, repairOrderRef: null,
    }, ctxOf());
    return { ...TASK, attemptNumber: n, attemptId: r.attemptId, branch: r.branch };
  };
  const ctxOf = (overrides: Partial<ActivityExecutionContext> & { readonly heartbeats?: ActivityProgress[] } = {}): ActivityExecutionContext => ({
    engineAttempt: overrides.engineAttempt ?? 1,
    signal: overrides.signal ?? new AbortController().signal,
    lastProgress: null,
    logicalNow: overrides.logicalNow ?? LOGICAL_NOW,
    heartbeat: overrides.heartbeat ?? ((p: ActivityProgress) => { overrides.heartbeats?.push(p); }),
  });

  Object.assign(harness, {
    db, calls, activities: createOrchestrationActivities(deps), deps, attempts, facts, workspaces, committer, forge,
    ledger, approvals, projection, audit, telemetry, terminals, leases, artifacts, sideEffects, hooks, workOrderRef,
    contextPackRef,
    ctx: ctxOf,
    registered,
    async leasedAttempt(n: number): Promise<LeasedAttemptIdentity> {
      const attempt = await registered(n);
      const { fence } = await createOrchestrationActivities(deps).acquireLease(attempt, ctxOf());
      return { ...attempt, fence };
    },
    async close() {
      await raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
  return harness as Harness;
}

/** An artifact id the doubles can use where only the shape matters. */
export const fakeArtifactId = (n: number): ArtifactId => `01K0000000000000000000F${String(n).padStart(3, '0')}` as ArtifactId;
