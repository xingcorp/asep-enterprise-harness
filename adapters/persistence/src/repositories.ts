// Project-scoped repositories (data-model §1, disp. P2-PLAN-HIGH-003). Every
// method takes a server-derived TenantScope as its FIRST parameter and filters
// on (organization_id, project_id) — a cross-project (IDOR) read or write
// resolves to zero rows and fails closed via ScopeViolationError. Mutable
// aggregates use optimistic concurrency: an update is `WHERE id=$ AND version=$`
// and bumps version; a stale version matches zero rows → OptimisticConcurrencyError.
//
// The registration repos (organizations/projects/repository_bindings/runs/tasks)
// and the AttemptRepository live here; the WorkspaceLeaseRepository port impl is
// in ./lease-repository.ts. None of these import a concrete driver — they talk
// only to the SqlExecutor seam, so pglite (tests) and pg.Pool (CI/prod) are
// interchangeable.

import type {
  OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId, AttemptId,
  TenantScope, RiskLevel, TaskStatus, AttemptStatus, ArtifactRef, ArtifactId,
  PullRequestId,
} from '@asep/contracts';
import type { SqlExecutor, SqlRow } from './sql.js';
import { OptimisticConcurrencyError, ScopeViolationError } from './sql.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Row shapes (the load-bearing columns; JSONB refs decoded as ArtifactRef).
// ---------------------------------------------------------------------------

export interface OrganizationRow {
  readonly id: OrganizationId;
  readonly name: string;
  readonly version: number;
}

export interface ProjectRow {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly defaultBranch: string;
  readonly version: number;
}

export interface RepositoryBindingRow {
  readonly id: RepositoryBindingId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly githubHost: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly defaultBaseBranch: string;
  readonly version: number;
}

export interface RunRow {
  readonly id: RunId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly status: string;
  readonly risk: RiskLevel;
  readonly version: number;
}

export interface TaskRow {
  readonly id: TaskId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly status: TaskStatus;
  readonly risk: RiskLevel;
  readonly workOrderRef: ArtifactRef | null;
  readonly baseSha: string | null;
  readonly version: number;
}

export interface AttemptRow {
  readonly id: AttemptId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly status: AttemptStatus;
  readonly baseSha: string | null;
  readonly resultSha: string | null;
  readonly agentProviderId: string | null;
  // Scoped evidence link (HIGH-005): the artifact id is composite-FK-bound to
  // this attempt's (org, project) → artifacts, and the expected sha256 is
  // pinned so a swapped-bytes artifact is detectable. Null until evidence is
  // attached (post-commit, pre-push in the pipeline).
  readonly evidenceArtifactId: ArtifactId | null;
  readonly evidenceSha256: string | null;
  readonly version: number;
}

export interface PullRequestRow {
  readonly id: PullRequestId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly repositoryBindingId: RepositoryBindingId;
  readonly attemptId: AttemptId;
  readonly forge: string;
  readonly number: number | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly url: string | null;
  readonly state: string;
  // Scoped evidence link (HIGH-005/008): composite-FK-bound to this PR's
  // (org, project) → artifacts, with the expected sha256 pinned.
  readonly evidenceArtifactId: ArtifactId | null;
  readonly evidenceSha256: string | null;
  readonly version: number;
}

function scopeMatches(scope: TenantScope, row: { organizationId: unknown; projectId: unknown }): boolean {
  return row.organizationId === scope.organizationId && row.projectId === scope.projectId;
}

// ---------------------------------------------------------------------------
// Organizations (top of the hierarchy — no scope filter on create; reads are
// by id only since an org is the scope root).
// ---------------------------------------------------------------------------

export class OrganizationRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(input: { name: string }): Promise<OrganizationRow> {
    const id = ulid() as OrganizationId;
    await this.db.query(
      'insert into organizations (id, name) values ($1, $2)',
      [id, input.name],
    );
    return { id, name: input.name, version: 0 };
  }

  async getById(id: OrganizationId): Promise<OrganizationRow | null> {
    const r = await this.db.query(
      'select id, name, version from organizations where id = $1',
      [id],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0]!;
    return { id: row['id'] as OrganizationId, name: row['name'] as string, version: row['version'] as number };
  }
}

// ---------------------------------------------------------------------------
// Projects.
// ---------------------------------------------------------------------------

export class ProjectRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(input: { organizationId: OrganizationId; name: string; defaultBranch: string }): Promise<ProjectRow> {
    const id = ulid() as ProjectId;
    await this.db.query(
      'insert into projects (id, organization_id, name, default_branch) values ($1, $2, $3, $4)',
      [id, input.organizationId, input.name, input.defaultBranch],
    );
    return { id, organizationId: input.organizationId, name: input.name, defaultBranch: input.defaultBranch, version: 0 };
  }

  // Authoritative membership check (HIGH-004): does this project row exist AND
  // belong to the given organization? Parameterized ($1,$2), never
  // interpolated. Used by the authenticated-principal resolver to verify a
  // client-selected project actually sits under the token's org before it
  // becomes a TenantScope — a token for org A cannot select org B's project.
  async belongsToOrg(organizationId: OrganizationId, id: ProjectId): Promise<boolean> {
    const r = await this.db.query(
      'select 1 from projects where id = $1 and organization_id = $2',
      [id, organizationId],
    );
    return r.rowCount > 0;
  }

  // Scoped read: the row must be visible in this scope or we fail closed.
  async getScoped(scope: TenantScope, id: ProjectId): Promise<ProjectRow> {
    const r = await this.db.query(
      'select id, organization_id, name, default_branch, version from projects where id = $1 and organization_id = $2',
      [id, scope.organizationId],
    );
    if (r.rowCount === 0 || id !== scope.projectId) throw new ScopeViolationError('project', id);
    const row = r.rows[0]!;
    return {
      id: row['id'] as ProjectId,
      organizationId: row['organization_id'] as OrganizationId,
      name: row['name'] as string,
      defaultBranch: row['default_branch'] as string,
      version: row['version'] as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Repository bindings. No token/remote_url column (disp. P2-PLAN-HIGH-007):
// clone URLs are constructed from the validated (host, owner, repo) identity.
// ---------------------------------------------------------------------------

export class RepositoryBindingRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(scope: TenantScope, input: {
    githubHost: string; githubOwner: string; githubRepo: string; defaultBaseBranch: string;
  }): Promise<RepositoryBindingRow> {
    const id = ulid() as RepositoryBindingId;
    await this.db.query(
      `insert into repository_bindings
        (id, organization_id, project_id, forge, github_host, github_owner, github_repo, default_base_branch)
       values ($1, $2, $3, 'github', $4, $5, $6, $7)`,
      [id, scope.organizationId, scope.projectId, input.githubHost, input.githubOwner, input.githubRepo, input.defaultBaseBranch],
    );
    return {
      id, organizationId: scope.organizationId, projectId: scope.projectId,
      githubHost: input.githubHost, githubOwner: input.githubOwner,
      githubRepo: input.githubRepo, defaultBaseBranch: input.defaultBaseBranch, version: 0,
    };
  }

  async getScoped(scope: TenantScope, id: RepositoryBindingId): Promise<RepositoryBindingRow> {
    const r = await this.db.query(
      `select id, organization_id, project_id, github_host, github_owner, github_repo, default_base_branch, version
       from repository_bindings where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new ScopeViolationError('repository_binding', id);
    const row = r.rows[0]!;
    return {
      id: row['id'] as RepositoryBindingId,
      organizationId: row['organization_id'] as OrganizationId,
      projectId: row['project_id'] as ProjectId,
      githubHost: row['github_host'] as string,
      githubOwner: row['github_owner'] as string,
      githubRepo: row['github_repo'] as string,
      defaultBaseBranch: row['default_base_branch'] as string,
      version: row['version'] as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Runs.
// ---------------------------------------------------------------------------

export class RunRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; status: string; risk: RiskLevel;
  }): Promise<RunRow> {
    const id = ulid() as RunId;
    await this.db.query(
      `insert into runs (id, organization_id, project_id, repository_binding_id, status, risk)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, scope.organizationId, scope.projectId, input.repositoryBindingId, input.status, input.risk],
    );
    return {
      id, organizationId: scope.organizationId, projectId: scope.projectId,
      repositoryBindingId: input.repositoryBindingId, status: input.status, risk: input.risk, version: 0,
    };
  }

  async getScoped(scope: TenantScope, id: RunId): Promise<RunRow> {
    const r = await this.db.query(
      `select id, organization_id, project_id, repository_binding_id, status, risk, version
       from runs where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new ScopeViolationError('run', id);
    const row = r.rows[0]!;
    return {
      id: row['id'] as RunId,
      organizationId: row['organization_id'] as OrganizationId,
      projectId: row['project_id'] as ProjectId,
      repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
      status: row['status'] as string,
      risk: row['risk'] as RiskLevel,
      version: row['version'] as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Tasks. Explicit status transition guarded by optimistic concurrency.
// ---------------------------------------------------------------------------

export class TaskRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(scope: TenantScope, input: {
    runId: RunId; repositoryBindingId: RepositoryBindingId; risk: RiskLevel;
    workOrderRef?: ArtifactRef; baseSha?: string;
  }): Promise<TaskRow> {
    const id = ulid() as TaskId;
    await this.db.query(
      `insert into tasks (id, organization_id, project_id, run_id, repository_binding_id, status, risk, work_order_ref, base_sha)
       values ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)`,
      [
        id, scope.organizationId, scope.projectId, input.runId, input.repositoryBindingId, input.risk,
        input.workOrderRef ? JSON.stringify(input.workOrderRef) : null,
        input.baseSha ?? null,
      ],
    );
    return {
      id, organizationId: scope.organizationId, projectId: scope.projectId,
      runId: input.runId, repositoryBindingId: input.repositoryBindingId,
      status: 'PENDING', risk: input.risk,
      workOrderRef: input.workOrderRef ?? null, baseSha: input.baseSha ?? null, version: 0,
    };
  }

  async getScoped(scope: TenantScope, id: TaskId): Promise<TaskRow> {
    const r = await this.db.query(
      `select id, organization_id, project_id, run_id, repository_binding_id, status, risk, work_order_ref, base_sha, version
       from tasks where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new ScopeViolationError('task', id);
    return this.decode(r.rows[0]!);
  }

  // Optimistic-concurrency status update. Returns the new version; throws
  // OptimisticConcurrencyError if the expected version no longer matches.
  async updateStatus(scope: TenantScope, id: TaskId, expectedVersion: number, status: TaskStatus): Promise<number> {
    const r = await this.db.query(
      `update tasks set status = $4, version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3 and version = $5`,
      [id, scope.organizationId, scope.projectId, status, expectedVersion],
    );
    if (r.rowCount === 0) throw new OptimisticConcurrencyError('task', id, expectedVersion);
    return expectedVersion + 1;
  }

  private decode(row: SqlRow): TaskRow {
    return {
      id: row['id'] as TaskId,
      organizationId: row['organization_id'] as OrganizationId,
      projectId: row['project_id'] as ProjectId,
      runId: row['run_id'] as RunId,
      repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
      status: row['status'] as TaskStatus,
      risk: row['risk'] as RiskLevel,
      workOrderRef: row['work_order_ref'] ? (row['work_order_ref'] as ArtifactRef) : null,
      baseSha: (row['base_sha'] as string | null) ?? null,
      version: row['version'] as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Attempts.
// ---------------------------------------------------------------------------

export class AttemptRepository {
  constructor(private readonly db: SqlExecutor) {}

  async create(scope: TenantScope, input: {
    taskId: TaskId; repositoryBindingId: RepositoryBindingId; baseSha?: string; agentProviderId?: string;
  }): Promise<AttemptRow> {
    const id = ulid() as AttemptId;
    await this.db.query(
      `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status, base_sha, agent_provider_id)
       values ($1, $2, $3, $4, $5, 'STARTED', $6, $7)`,
      [id, scope.organizationId, scope.projectId, input.taskId, input.repositoryBindingId, input.baseSha ?? null, input.agentProviderId ?? null],
    );
    return {
      id, organizationId: scope.organizationId, projectId: scope.projectId,
      taskId: input.taskId, repositoryBindingId: input.repositoryBindingId,
      status: 'STARTED', baseSha: input.baseSha ?? null, resultSha: null,
      agentProviderId: input.agentProviderId ?? null,
      evidenceArtifactId: null, evidenceSha256: null, version: 0,
    };
  }

  async getScoped(scope: TenantScope, id: AttemptId): Promise<AttemptRow> {
    const r = await this.db.query(
      `select id, organization_id, project_id, task_id, repository_binding_id, status, base_sha, result_sha, agent_provider_id,
              evidence_artifact_id, evidence_sha256, version
       from attempts where id = $1 and organization_id = $2 and project_id = $3`,
      [id, scope.organizationId, scope.projectId],
    );
    if (r.rowCount === 0) throw new ScopeViolationError('attempt', id);
    return this.decode(r.rows[0]!);
  }

  async updateStatus(scope: TenantScope, id: AttemptId, expectedVersion: number, status: AttemptStatus): Promise<number> {
    const r = await this.db.query(
      `update attempts set status = $4, version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3 and version = $5`,
      [id, scope.organizationId, scope.projectId, status, expectedVersion],
    );
    if (r.rowCount === 0) throw new OptimisticConcurrencyError('attempt', id, expectedVersion);
    return expectedVersion + 1;
  }

  // result_sha is the FINAL harness-owned commit SHA (disp. P2-PLAN-HIGH-008):
  // written only once a harness commit exists, never a provider-supplied value.
  async setResultSha(scope: TenantScope, id: AttemptId, expectedVersion: number, resultSha: string): Promise<number> {
    const r = await this.db.query(
      `update attempts set result_sha = $4, version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3 and version = $5`,
      [id, scope.organizationId, scope.projectId, resultSha, expectedVersion],
    );
    if (r.rowCount === 0) throw new OptimisticConcurrencyError('attempt', id, expectedVersion);
    return expectedVersion + 1;
  }

  // Attach the SCOPED evidence reference (HIGH-005): the artifact id is
  // composite-FK-bound to this attempt's (org, project) → artifacts, so the DB
  // rejects an evidence artifact from another scope. The expected sha256 is
  // pinned alongside so a later swapped-bytes artifact is detectable. Called
  // post-commit, pre-push, once a real evidence artifact row exists.
  async attachEvidence(
    scope: TenantScope, id: AttemptId, expectedVersion: number, ref: ArtifactRef,
  ): Promise<number> {
    const r = await this.db.query(
      `update attempts set evidence_artifact_id = $4, evidence_sha256 = $5, version = version + 1
       where id = $1 and organization_id = $2 and project_id = $3 and version = $6`,
      [id, scope.organizationId, scope.projectId, ref.artifactId, ref.sha256, expectedVersion],
    );
    if (r.rowCount === 0) throw new OptimisticConcurrencyError('attempt', id, expectedVersion);
    return expectedVersion + 1;
  }

  private decode(row: SqlRow): AttemptRow {
    return {
      id: row['id'] as AttemptId,
      organizationId: row['organization_id'] as OrganizationId,
      projectId: row['project_id'] as ProjectId,
      taskId: row['task_id'] as TaskId,
      repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
      status: row['status'] as AttemptStatus,
      baseSha: (row['base_sha'] as string | null) ?? null,
      resultSha: (row['result_sha'] as string | null) ?? null,
      agentProviderId: (row['agent_provider_id'] as string | null) ?? null,
      evidenceArtifactId: (row['evidence_artifact_id'] as ArtifactId | null) ?? null,
      evidenceSha256: (row['evidence_sha256'] as string | null) ?? null,
      version: row['version'] as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Pull requests (HIGH-008). Persists the authoritative PR row so the K1
// traceability chain (PR → evidence → attempt → task → run) resolves on real
// state, not a transient object. The upsert is idempotent on
// (repository_binding_id, head_branch) — migration 0006's unique constraint —
// so a crash-retry updates the existing row rather than opening a duplicate.
// The evidence link is a SCOPED artifact reference (migration 0009): the
// composite FK (evidence_artifact_id, org, project) → artifacts makes "the
// evidence attached to this PR is in MY scope" a DB invariant.
// ---------------------------------------------------------------------------

export class PullRequestRepository {
  constructor(private readonly db: SqlExecutor) {}

  // Idempotent upsert keyed on (binding, head_branch). On conflict the existing
  // row is UPDATEd (number/url/state/evidence) rather than duplicated, so a
  // resume after the forge upsert but before persistence converges to one row.
  async upsert(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    attemptId: AttemptId;
    forge: string;
    number: number | null;
    headBranch: string;
    baseBranch: string;
    url: string | null;
    state: string;
    evidenceRef?: ArtifactRef;
  }): Promise<PullRequestRow> {
    const id = ulid() as PullRequestId;
    const evId = input.evidenceRef?.artifactId ?? null;
    const evSha = input.evidenceRef?.sha256 ?? null;
    const r = await this.db.query(
      `insert into pull_requests
         (id, organization_id, project_id, repository_binding_id, attempt_id, forge,
          number, head_branch, base_branch, url, state, evidence_artifact_id, evidence_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (repository_binding_id, head_branch) do update set
         attempt_id = excluded.attempt_id,
         number = excluded.number,
         url = excluded.url,
         state = excluded.state,
         evidence_artifact_id = excluded.evidence_artifact_id,
         evidence_sha256 = excluded.evidence_sha256,
         updated_at = now(),
         version = pull_requests.version + 1
       returning id, organization_id, project_id, repository_binding_id, attempt_id, forge,
                 number, head_branch, base_branch, url, state,
                 evidence_artifact_id, evidence_sha256, version`,
      [
        id, scope.organizationId, scope.projectId, input.repositoryBindingId, input.attemptId,
        input.forge, input.number, input.headBranch, input.baseBranch, input.url, input.state,
        evId, evSha,
      ],
    );
    return this.decode(r.rows[0]!);
  }

  async getByBranch(scope: TenantScope, repositoryBindingId: RepositoryBindingId, headBranch: string): Promise<PullRequestRow> {
    const r = await this.db.query(
      `select id, organization_id, project_id, repository_binding_id, attempt_id, forge,
              number, head_branch, base_branch, url, state, evidence_artifact_id, evidence_sha256, version
       from pull_requests
       where organization_id = $1 and project_id = $2 and repository_binding_id = $3 and head_branch = $4`,
      [scope.organizationId, scope.projectId, repositoryBindingId, headBranch],
    );
    if (r.rowCount === 0) throw new ScopeViolationError('pull_request', headBranch);
    return this.decode(r.rows[0]!);
  }

  private decode(row: SqlRow): PullRequestRow {
    return {
      id: row['id'] as PullRequestId,
      organizationId: row['organization_id'] as OrganizationId,
      projectId: row['project_id'] as ProjectId,
      repositoryBindingId: row['repository_binding_id'] as RepositoryBindingId,
      attemptId: row['attempt_id'] as AttemptId,
      forge: row['forge'] as string,
      number: (row['number'] as number | null) ?? null,
      headBranch: row['head_branch'] as string,
      baseBranch: row['base_branch'] as string,
      url: (row['url'] as string | null) ?? null,
      state: row['state'] as string,
      evidenceArtifactId: (row['evidence_artifact_id'] as ArtifactId | null) ?? null,
      evidenceSha256: (row['evidence_sha256'] as string | null) ?? null,
      version: row['version'] as number,
    };
  }
}

export { scopeMatches };
