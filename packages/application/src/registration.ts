// Registration + query use cases (exit criteria B2/B5, disp. P2-FINAL-MED-004).
//
// The control-plane HTTP handlers MUST NOT call persistence repositories
// directly — a composition root parses transport, calls an application use
// case, and maps the response. These use cases own the small orchestration each
// endpoint needs (e.g. "a run may only be created against a binding visible in
// this scope", "a task only against a run in this scope") so that policy lives
// in the application layer, not in a Fastify handler.
//
// They compose only against repository PORTS named here structurally — the
// application layer states the SHAPE it needs, never the concrete
// @asep/persistence class (exit B3). The concrete repositories satisfy these
// interfaces by structural typing, so the composition root passes them in
// unchanged.

import type {
  OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId,
  TenantScope, RiskLevel, TaskStatus,
} from '@asep/contracts';

// --- repository ports (structural; concrete repos satisfy them) --------------

export interface OrganizationCreatePort {
  create(input: { name: string }): Promise<{ id: OrganizationId; name: string }>;
}

export interface ProjectCreatePort {
  create(input: { organizationId: OrganizationId; name: string; defaultBranch: string }):
    Promise<{ id: ProjectId; organizationId: OrganizationId; name: string; defaultBranch: string }>;
}

export interface BindingPort {
  create(scope: TenantScope, input: {
    githubHost: string; githubOwner: string; githubRepo: string; defaultBaseBranch: string;
  }): Promise<{
    id: RepositoryBindingId; githubHost: string; githubOwner: string;
    githubRepo: string; defaultBaseBranch: string;
  }>;
  // Scoped existence check; throws (ScopeViolation) when not visible in scope.
  getScoped(scope: TenantScope, id: RepositoryBindingId): Promise<unknown>;
}

export interface RunPort {
  create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId; status: string; risk: RiskLevel;
  }): Promise<{ id: RunId; status: string; risk: RiskLevel }>;
  getScoped(scope: TenantScope, id: RunId): Promise<unknown>;
}

export interface TaskPort {
  create(scope: TenantScope, input: {
    runId: RunId; repositoryBindingId: RepositoryBindingId; risk: RiskLevel; baseSha?: string;
  }): Promise<{ id: TaskId; status: TaskStatus; risk: RiskLevel }>;
  getScoped(scope: TenantScope, id: TaskId): Promise<{
    id: TaskId; runId: RunId; repositoryBindingId: RepositoryBindingId;
    status: TaskStatus; risk: RiskLevel; baseSha: string | null; resultSha?: string | null;
  }>;
}

// The repository bundle the use cases drive. The composition root builds the
// concrete repositories and hands them in — this bundle names only the ports.
export interface RegistrationRepositories {
  readonly organizations: OrganizationCreatePort;
  readonly projects: ProjectCreatePort;
  readonly bindings: BindingPort;
  readonly runs: RunPort;
  readonly tasks: TaskPort;
}

// --- use cases ---------------------------------------------------------------

// The capability an operator principal must hold to create an organization.
// Declared in the APPLICATION layer (not only at the transport edge) so the rule
// is enforced by the use case itself — a second, non-HTTP caller cannot bypass
// it by wiring a different route (disp. P2-FINAL-HIGH-004).
export const CAP_CREATE_ORGANIZATION = 'organizations:create';

// Thrown when an authenticated principal lacks the required capability. The
// composition root maps it to 403; distinct from an authentication failure.
export class CapabilityError extends Error {
  constructor(capability: string) {
    super(`principal lacks capability '${capability}'`);
    this.name = 'CapabilityError';
  }
}

// A server-derived PLATFORM principal. Organization creation is the scope ROOT,
// so no TenantScope exists yet to authorise it — C2's "every use case receives a
// server-derived AuthContext" is satisfied by this platform-level context
// instead of exempting the endpoint.
export interface PlatformAuthContext {
  readonly principalId: string;
  readonly capabilities: readonly string[];
}

export async function createOrganization(
  repos: RegistrationRepositories,
  auth: PlatformAuthContext,
  input: { name: string },
): Promise<{ id: OrganizationId; name: string }> {
  // Fail closed INSIDE the use case: an unauthorised principal never reaches
  // persistence, regardless of which caller (HTTP, CLI, worker) invoked it.
  if (!auth.capabilities.includes(CAP_CREATE_ORGANIZATION)) {
    throw new CapabilityError(CAP_CREATE_ORGANIZATION);
  }
  return repos.organizations.create({ name: input.name });
}

export async function createProject(
  repos: RegistrationRepositories,
  organizationId: OrganizationId,
  input: { name: string; defaultBranch: string },
): Promise<{ id: ProjectId; organizationId: OrganizationId; name: string; defaultBranch: string }> {
  return repos.projects.create({
    organizationId, name: input.name, defaultBranch: input.defaultBranch,
  });
}

export async function createRepositoryBinding(
  repos: RegistrationRepositories,
  scope: TenantScope,
  input: { githubHost: string; githubOwner: string; githubRepo: string; defaultBaseBranch: string },
): Promise<{
  id: RepositoryBindingId; githubHost: string; githubOwner: string;
  githubRepo: string; defaultBaseBranch: string;
}> {
  return repos.bindings.create(scope, input);
}

export async function createRun(
  repos: RegistrationRepositories,
  scope: TenantScope,
  input: { repositoryBindingId: RepositoryBindingId; risk: RiskLevel },
): Promise<{ id: RunId; status: string; risk: RiskLevel }> {
  // The binding must be visible in this scope before a run is created against
  // it (fails closed with ScopeViolation → 404 at the transport edge).
  await repos.bindings.getScoped(scope, input.repositoryBindingId);
  return repos.runs.create(scope, {
    repositoryBindingId: input.repositoryBindingId, status: 'READY', risk: input.risk,
  });
}

export async function createTask(
  repos: RegistrationRepositories,
  scope: TenantScope,
  runId: RunId,
  input: { repositoryBindingId: RepositoryBindingId; risk: RiskLevel; baseSha?: string },
): Promise<{ id: TaskId; status: TaskStatus; risk: RiskLevel }> {
  // The run must be visible in this scope before a task is created under it.
  await repos.runs.getScoped(scope, runId);
  return repos.tasks.create(scope, {
    runId,
    repositoryBindingId: input.repositoryBindingId,
    risk: input.risk,
    ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
  });
}

export async function getTask(
  repos: RegistrationRepositories,
  scope: TenantScope,
  taskId: TaskId,
): Promise<{
  id: TaskId; runId: RunId; repositoryBindingId: RepositoryBindingId;
  status: TaskStatus; risk: RiskLevel; baseSha: string | null; resultSha?: string | null;
}> {
  return repos.tasks.getScoped(scope, taskId);
}
