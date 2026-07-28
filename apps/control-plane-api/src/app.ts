// Control Plane API app factory (exit criteria B2/B5, plan §10). Fastify wires
// transport → auth hook → body validation → repository call → response mapping.
// A handler NEVER runs raw SQL, spawns git/child_process, instantiates a
// provider SDK, or makes a policy decision — those are the application/adapter
// layers' jobs. The repositories are INJECTED so this factory is driven against
// a pglite-backed store in tests and a pg.Pool-backed store in prod, unchanged.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
} from '@asep/persistence';
import { OptimisticConcurrencyError, ScopeViolationError } from '@asep/persistence';
import type {
  RepositoryBindingId, RunId, TaskId, RiskLevel,
} from '@asep/contracts';
import {
  createOrganization, createProject, createRepositoryBinding,
  createRun, createTask, getTask, CapabilityError,
  type RegistrationRepositories,
} from '@asep/application';
import {
  AuthError, ForbiddenError, CAP_CREATE_ORGANIZATION,
  organizationContext, operatorContext, tenantScope, type PrincipalResolver,
} from './auth.js';
import {
  parseCreateOrganization, parseCreateProject, parseCreateBinding,
  parseCreateRun, parseCreateTask, type Parsed,
} from './request-schemas.js';

// The set of repositories the routes forward to. Grouped so a composition root
// builds them once (against one SqlClient) and hands them in.
export interface Repositories {
  readonly organizations: OrganizationRepository;
  readonly projects: ProjectRepository;
  readonly bindings: RepositoryBindingRepository;
  readonly runs: RunRepository;
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;
}

export interface AppOptions {
  readonly repositories: Repositories;
  // The authenticated-principal resolver (HIGH-004). The org scope is derived
  // from a verified bearer credential via this port, NEVER from a client header,
  // so a caller cannot spoof which organization it acts as.
  readonly principals: PrincipalResolver;
  // Optional readiness probe (composition root injects a real DB ping). Defaults
  // to always-ready so the pure app can be tested without a live dependency.
  readonly readyCheck?: () => Promise<boolean>;
}

// Unwrap a Parsed<T> or send a 400 with the structural errors. Returns null when
// it already replied, so the handler just returns.
function bodyOrThrow<T>(parsed: Parsed<T>, reply: FastifyReply): T | null {
  if (parsed.ok) return parsed.value;
  reply.code(400).send({ error: 'invalid_request', details: parsed.errors });
  return null;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const repos = opts.repositories;
  const principals = opts.principals;
  const readyCheck = opts.readyCheck ?? (async () => true);

  // Map well-known domain/persistence errors to HTTP status codes centrally, so
  // handlers never branch on them (keeps handlers thin — B5). A ScopeViolation
  // is a 404 (never reveal cross-tenant existence); an auth failure is 401; an
  // optimistic-concurrency miss is 409.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    // Authenticated-but-not-permitted is 403, NOT 401 (disp. P2-FINAL-HIGH-004).
    // Both the transport guard (ForbiddenError) and the use case's own capability
    // check (CapabilityError) land here, so the answer is the same whichever
    // layer refused.
    if (err instanceof ForbiddenError || err instanceof CapabilityError) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    if (err instanceof ScopeViolationError) {
      reply.code(404).send({ error: 'not_found' });
      return;
    }
    if (err instanceof OptimisticConcurrencyError) {
      reply.code(409).send({ error: 'conflict' });
      return;
    }
    reply.code(500).send({ error: 'internal_error' });
  });

  // ----- health -----------------------------------------------------------
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const ready = await readyCheck();
    reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable' });
  });

  // ----- registration (mutating) ------------------------------------------

  // Create an organization (disp. P2-FINAL-HIGH-004). Org creation is the scope
  // ROOT, so there is no TenantScope to authorise it against — but C2 requires a
  // server-derived AuthContext for EVERY use case, so this route is authorised by
  // a PLATFORM-OPERATOR credential carrying an explicit `organizations:create`
  // capability. Authentication is enforced BEFORE the body is even parsed, so an
  // anonymous request can never reach the use case:
  //   missing/unknown credential → 401 · operator without the capability → 403
  // A tenant (org-scoped) token resolves to no operator, so it cannot mint orgs.
  app.post('/v1/organizations', async (req: FastifyRequest, reply: FastifyReply) => {
    const operator = await operatorContext(req, principals, CAP_CREATE_ORGANIZATION);
    const parsed = parseCreateOrganization(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    // The server-derived platform context is passed THROUGH to the use case,
    // which re-checks the capability itself (defence in depth: a future non-HTTP
    // caller cannot skip the check by not going through this route).
    const org = await createOrganization(
      repos,
      { principalId: operator.principalId, capabilities: operator.capabilities },
      { name: body.name },
    );
    reply.code(201).send({ organizationId: org.id, name: org.name });
  });

  app.post('/v1/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await organizationContext(req, principals); // 401 if missing/malformed
    const parsed = parseCreateProject(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const project = await createProject(repos, ctx.organizationId, {
      name: body.name,
      defaultBranch: body.defaultBranch,
    });
    reply.code(201).send({
      projectId: project.id,
      organizationId: project.organizationId,
      name: project.name,
      defaultBranch: project.defaultBranch,
    });
  });

  app.post('/v1/projects/:projectId/repository-bindings', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = await tenantScope(req, principals); // 401 if missing/malformed
    const parsed = parseCreateBinding(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const binding = await createRepositoryBinding(repos, scope, {
      githubHost: body.githubHost,
      githubOwner: body.githubOwner,
      githubRepo: body.githubRepo,
      defaultBaseBranch: body.defaultBaseBranch,
    });
    reply.code(201).send({
      repositoryBindingId: binding.id,
      githubHost: binding.githubHost,
      githubOwner: binding.githubOwner,
      githubRepo: binding.githubRepo,
      defaultBaseBranch: binding.defaultBaseBranch,
    });
  });

  app.post('/v1/projects/:projectId/runs', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = await tenantScope(req, principals);
    const parsed = parseCreateRun(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const run = await createRun(repos, scope, {
      repositoryBindingId: body.repositoryBindingId as RepositoryBindingId,
      risk: body.risk as RiskLevel,
    });
    reply.code(201).send({ runId: run.id, status: run.status, risk: run.risk });
  });

  app.post('/v1/runs/:runId/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = await tenantScope(req, principals);
    const runId = (req.params as { runId: string }).runId;
    const parsed = parseCreateTask(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const task = await createTask(repos, scope, runId as RunId, {
      repositoryBindingId: body.repositoryBindingId as RepositoryBindingId,
      risk: body.risk as RiskLevel,
      ...(body.baseSha === undefined ? {} : { baseSha: body.baseSha }),
    });
    reply.code(201).send({ taskId: task.id, status: task.status, risk: task.risk });
  });

  // ----- queries (read) ----------------------------------------------------

  app.get('/v1/tasks/:taskId', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = await tenantScope(req, principals);
    const taskId = (req.params as { taskId: string }).taskId;
    const task = await getTask(repos, scope, taskId as TaskId);
    reply.code(200).send({
      taskId: task.id,
      runId: task.runId,
      repositoryBindingId: task.repositoryBindingId,
      status: task.status,
      risk: task.risk,
      baseSha: task.baseSha,
      resultSha: task.resultSha ?? null,
    });
  });

  return app;
}
