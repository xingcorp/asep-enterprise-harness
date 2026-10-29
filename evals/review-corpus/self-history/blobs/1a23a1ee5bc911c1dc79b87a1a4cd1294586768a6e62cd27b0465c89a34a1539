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
  OrganizationId, ProjectId, RepositoryBindingId, RunId, TaskId, RiskLevel,
} from '@asep/contracts';
import { AuthError, organizationContext, tenantScope } from './auth.js';
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

  // Create an organization. Org creation is the scope root, so it needs no
  // TenantScope — but the caller must still be an authenticated principal whose
  // org header matches the row it creates (a client cannot mint an arbitrary org
  // id: the id is server-generated).
  app.post('/v1/organizations', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseCreateOrganization(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const org = await repos.organizations.create({ name: body.name });
    reply.code(201).send({ organizationId: org.id, name: org.name });
  });

  app.post('/v1/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = organizationContext(req); // 401 if missing/malformed
    const parsed = parseCreateProject(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const project = await repos.projects.create({
      organizationId: ctx.organizationId,
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
    const scope = tenantScope(req); // 401 if missing/malformed
    const parsed = parseCreateBinding(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    const binding = await repos.bindings.create(scope, {
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
    const scope = tenantScope(req);
    const parsed = parseCreateRun(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    // Verify the binding is visible in this scope before creating the run
    // (fails closed with 404 via ScopeViolationError in the error handler).
    await repos.bindings.getScoped(scope, body.repositoryBindingId as RepositoryBindingId);
    const run = await repos.runs.create(scope, {
      repositoryBindingId: body.repositoryBindingId as RepositoryBindingId,
      status: 'READY',
      risk: body.risk as RiskLevel,
    });
    reply.code(201).send({ runId: run.id, status: run.status, risk: run.risk });
  });

  app.post('/v1/runs/:runId/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = tenantScope(req);
    const runId = (req.params as { runId: string }).runId;
    const parsed = parseCreateTask(req.body);
    const body = bodyOrThrow(parsed, reply);
    if (!body) return;
    await repos.runs.getScoped(scope, runId as RunId); // 404 if not in scope
    const task = await repos.tasks.create(scope, {
      runId: runId as RunId,
      repositoryBindingId: body.repositoryBindingId as RepositoryBindingId,
      risk: body.risk as RiskLevel,
      ...(body.baseSha === undefined ? {} : { baseSha: body.baseSha }),
    });
    reply.code(201).send({ taskId: task.id, status: task.status, risk: task.risk });
  });

  // ----- queries (read) ----------------------------------------------------

  app.get('/v1/tasks/:taskId', async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = tenantScope(req);
    const taskId = (req.params as { taskId: string }).taskId;
    const task = await repos.tasks.getScoped(scope, taskId as TaskId);
    reply.code(200).send({
      taskId: task.id,
      runId: task.runId,
      repositoryBindingId: task.repositoryBindingId,
      status: task.status,
      risk: task.risk,
      baseSha: task.baseSha,
      resultSha: null,
    });
  });

  return app;
}
