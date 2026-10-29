// Control Plane API + CLI suite (exit criteria B2/B5, C2, plan §10). Drives the
// REAL Fastify app via inject() against a pglite-backed store (genuine PG DDL,
// composite FKs, scope filters) — never a mocked repository — so the tenancy /
// IDOR fail-closed behaviour is exercised for real. The CLI seam is driven with
// an in-test fake provider, proving the composition root forwards to the shared
// application use case without reimplementing the pipeline.
//
// Machine-readable suite marker (exit criterion K4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PgliteClient, migrate,
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
} from '@asep/persistence';
import type { CodingAgentProvider, AgentExecuteRequest, AgentAttemptObservation, GitChangeInspector, GitChangeObservation } from '@asep/ports';
import type { ArtifactRef } from '@asep/contracts';
import { createOrganization, projectBelongsToOrganization } from '@asep/application';
import { buildApp, type Repositories } from './app.js';
import { PROJECT_HEADER, CAP_CREATE_ORGANIZATION } from './auth.js';
import { RepositoryPrincipalResolver } from './principal-resolver.js';
import { parseArgs, runExecute, formatResult, localDeps, CliUsageError } from './cli.js';

console.log('SUITE-ID: asep-suite:control-plane');

async function buildStore(): Promise<{
  repos: Repositories; db: PgliteClient; principals: RepositoryPrincipalResolver;
}> {
  const db = await PgliteClient.create();
  await migrate(db);
  const repos: Repositories = {
    organizations: new OrganizationRepository(db),
    projects: new ProjectRepository(db),
    bindings: new RepositoryBindingRepository(db),
    runs: new RunRepository(db),
    tasks: new TaskRepository(db),
    attempts: new AttemptRepository(db),
  };
  // The authenticated-principal resolver (HIGH-004): the org scope is bound to a
  // verified bearer token, never a client header. Tests bind a token per org.
  const principals = new RepositoryPrincipalResolver(repos.projects);
  return { repos, db, principals };
}

// A PLATFORM-OPERATOR credential holding organizations:create (HIGH-004). Org
// creation sits above the tenancy tree, so it is authorised by this capability
// rather than by a TenantScope. Server state — never mintable over HTTP.
const OPERATOR_TOKEN = 'op-token-with-create-capability';
function operatorAuth(principals: RepositoryPrincipalResolver): string {
  principals.bindOperator(OPERATOR_TOKEN, 'operator-1', [CAP_CREATE_ORGANIZATION]);
  return `Bearer ${OPERATOR_TOKEN}`;
}

// Bind a fresh bearer token to an org and return the Authorization header value.
// Tokens are SERVER state — a caller can never mint one by sending a header.
function bearerFor(principals: RepositoryPrincipalResolver, organizationId: string): string {
  const token = `tok-${organizationId}`;
  principals.bindToken(token, organizationId as never);
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Registration flow — org → project → binding → run → task, then query.
// ---------------------------------------------------------------------------

test('full registration flow: org → project → binding → run → task → query', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const org = await app.inject({
      method: 'POST', url: '/v1/organizations',
      headers: { authorization: operatorAuth(principals) },
      payload: { name: 'Acme' },
    });
    assert.equal(org.statusCode, 201);
    const organizationId = org.json().organizationId as string;
    const auth = bearerFor(principals, organizationId);

    const project = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { authorization: auth },
      payload: { name: 'web', defaultBranch: 'main' },
    });
    assert.equal(project.statusCode, 201);
    const projectId = project.json().projectId as string;

    const scoped = { authorization: auth, [PROJECT_HEADER]: projectId };

    const binding = await app.inject({
      method: 'POST', url: `/v1/projects/${projectId}/repository-bindings`,
      headers: scoped,
      payload: { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', defaultBaseBranch: 'main' },
    });
    assert.equal(binding.statusCode, 201);
    const repositoryBindingId = binding.json().repositoryBindingId as string;

    const run = await app.inject({
      method: 'POST', url: `/v1/projects/${projectId}/runs`,
      headers: scoped,
      payload: { repositoryBindingId, risk: 'R0' },
    });
    assert.equal(run.statusCode, 201);
    const runId = run.json().runId as string;

    const task = await app.inject({
      method: 'POST', url: `/v1/runs/${runId}/tasks`,
      headers: scoped,
      payload: { repositoryBindingId, risk: 'R0' },
    });
    assert.equal(task.statusCode, 201);
    const taskId = task.json().taskId as string;

    const got = await app.inject({
      method: 'GET', url: `/v1/tasks/${taskId}`, headers: scoped,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().taskId, taskId);
    assert.equal(got.json().status, 'PENDING');
    assert.equal(got.json().risk, 'R0');
  } finally {
    await app.close();
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// C2 — cross-project (IDOR) read fails closed at the DB boundary (404, never
// reveals existence).
// ---------------------------------------------------------------------------

test('C2: a task from project A is NOT readable under project B scope (IDOR → 404)', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    // Two projects under one org.
    const org = await repos.organizations.create({ name: 'Acme' });
    const projA = await repos.projects.create({ organizationId: org.id, name: 'A', defaultBranch: 'main' });
    const projB = await repos.projects.create({ organizationId: org.id, name: 'B', defaultBranch: 'main' });
    const auth = bearerFor(principals, org.id);
    const scopeA = { organizationId: org.id, projectId: projA.id };
    const bindingA = await repos.bindings.create(scopeA, {
      githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'a', defaultBaseBranch: 'main',
    });
    const runA = await repos.runs.create(scopeA, { repositoryBindingId: bindingA.id, status: 'READY', risk: 'R0' });
    const taskA = await repos.tasks.create(scopeA, { runId: runA.id, repositoryBindingId: bindingA.id, risk: 'R0' });

    // Read task A under project B's scope — must fail closed as 404.
    const idor = await app.inject({
      method: 'GET', url: `/v1/tasks/${taskA.id}`,
      headers: { authorization: auth, [PROJECT_HEADER]: projB.id },
    });
    assert.equal(idor.statusCode, 404);

    // Sanity: the owning scope CAN read it.
    const owner = await app.inject({
      method: 'GET', url: `/v1/tasks/${taskA.id}`,
      headers: { authorization: auth, [PROJECT_HEADER]: projA.id },
    });
    assert.equal(owner.statusCode, 200);
  } finally {
    await app.close();
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// HIGH-004 — the org scope is bound to the CREDENTIAL, not a client header. A
// caller holding org A's token who selects a project under org B cannot widen
// access: the membership check fails closed (401), never revealing org B.
// ---------------------------------------------------------------------------

test('HIGH-004: a token for org A cannot act as org B by selecting org B\'s project (401)', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const orgA = await repos.organizations.create({ name: 'A-Corp' });
    const orgB = await repos.organizations.create({ name: 'B-Corp' });
    const projB = await repos.projects.create({ organizationId: orgB.id, name: 'B', defaultBranch: 'main' });
    // The attacker authenticates as org A but tries to select org B's project.
    const authA = bearerFor(principals, orgA.id);
    const res = await app.inject({
      method: 'POST', url: `/v1/projects/${projB.id}/repository-bindings`,
      headers: { authorization: authA, [PROJECT_HEADER]: projB.id },
      payload: { githubHost: 'github.com', githubOwner: 'b', githubRepo: 'b', defaultBaseBranch: 'main' },
    });
    // Fails closed at auth — the project is not in the authenticated org.
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
    await db.close();
  }
});

test('HIGH-004: an unknown/forged bearer token is 401 (org is never client-chosen)', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const org = await repos.organizations.create({ name: 'Acme' });
    const proj = await repos.projects.create({ organizationId: org.id, name: 'web', defaultBranch: 'main' });
    // A token that was never bound server-side — cannot resolve to any org.
    const res = await app.inject({
      method: 'POST', url: `/v1/projects/${proj.id}/repository-bindings`,
      headers: { authorization: 'Bearer forged-token', [PROJECT_HEADER]: proj.id },
      payload: { githubHost: 'github.com', githubOwner: 'a', githubRepo: 'b', defaultBaseBranch: 'main' },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// HIGH-004 (org creation) — POST /v1/organizations is NOT anonymous.
//
// The re-review found this route completely unauthenticated: anyone could mint
// an organization, contradicting C2's "a server-derived AuthContext is required
// by every application use case". Org creation is the scope ROOT so it cannot be
// authorised by a TenantScope; it now requires a PLATFORM-OPERATOR credential
// holding `organizations:create`. These tests prove each refusal path fails
// CLOSED *and* that no row was created — a 4xx that still wrote would be worse
// than useless.
// ---------------------------------------------------------------------------

// Count organizations through the repository seam so "no org was created" is
// asserted against real persisted state, not against the HTTP body.
async function orgCount(db: PgliteClient): Promise<number> {
  const r = await db.query('select count(*)::int as n from organizations', []);
  return (r.rows[0] as { n: number }).n;
}

test('HIGH-004: POST /v1/organizations with NO credential is 401 and creates NOTHING', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const before = await orgCount(db);
    const res = await app.inject({
      method: 'POST', url: '/v1/organizations',
      // deliberately no Authorization header
      payload: { name: 'Attacker Corp' },
    });
    assert.equal(res.statusCode, 401, 'an anonymous org creation must fail closed');
    assert.equal(await orgCount(db), before, 'no organization row may be created');
  } finally {
    await app.close();
    await db.close();
  }
});

test('HIGH-004: POST /v1/organizations with an unknown token is 401 and creates NOTHING', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const before = await orgCount(db);
    const res = await app.inject({
      method: 'POST', url: '/v1/organizations',
      headers: { authorization: 'Bearer never-bound-server-side' },
      payload: { name: 'Attacker Corp' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(await orgCount(db), before, 'no organization row may be created');
  } finally {
    await app.close();
    await db.close();
  }
});

test('HIGH-004: a TENANT token cannot mint an organization (403/401, creates NOTHING)', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    // A perfectly valid ORG-SCOPED tenant credential. Privilege escalation to
    // "create new organizations" must not follow from holding one.
    const existing = await repos.organizations.create({ name: 'Acme' });
    const tenantAuth = bearerFor(principals, existing.id);
    const before = await orgCount(db);
    const res = await app.inject({
      method: 'POST', url: '/v1/organizations',
      headers: { authorization: tenantAuth },
      payload: { name: 'Escalated Corp' },
    });
    assert.ok(
      res.statusCode === 401 || res.statusCode === 403,
      `a tenant credential must be refused, got ${res.statusCode}`,
    );
    assert.equal(await orgCount(db), before, 'no organization row may be created');
  } finally {
    await app.close();
    await db.close();
  }
});

test('HIGH-004: an operator WITHOUT organizations:create is 403 and creates NOTHING', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    // Authenticated as a real platform operator, but holding a different
    // capability — authenticated is not authorised.
    principals.bindOperator('op-readonly', 'operator-ro', ['organizations:read']);
    const before = await orgCount(db);
    const res = await app.inject({
      method: 'POST', url: '/v1/organizations',
      headers: { authorization: 'Bearer op-readonly' },
      payload: { name: 'No Capability Corp' },
    });
    assert.equal(res.statusCode, 403, 'authenticated-but-unauthorised is 403, not 401');
    assert.equal(await orgCount(db), before, 'no organization row may be created');
  } finally {
    await app.close();
    await db.close();
  }
});

test('HIGH-004: an operator WITH organizations:create succeeds (201) — the gate is not blanket-deny', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const before = await orgCount(db);
    const res = await app.inject({
      method: 'POST', url: '/v1/organizations',
      headers: { authorization: operatorAuth(principals) },
      payload: { name: 'Legit Corp' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(await orgCount(db), before + 1, 'exactly one organization created');
  } finally {
    await app.close();
    await db.close();
  }
});

// The use case itself must refuse, not merely the route: a second (non-HTTP)
// caller wiring its own transport cannot bypass the capability check.
test('HIGH-004: createOrganization USE CASE fails closed without the capability', async () => {
  const { repos, db } = await buildStore();
  try {
    const before = await orgCount(db);
    await assert.rejects(
      () => createOrganization(repos, { principalId: 'p', capabilities: [] }, { name: 'X' }),
      (e: Error) => e.name === 'CapabilityError',
      'the application use case must enforce the capability itself',
    );
    assert.equal(await orgCount(db), before, 'no organization row may be created');
  } finally {
    await db.close();
  }
});

// Project membership is an application use case answered from the persisted
// project row; the principal resolver forwards to it rather than to persistence.
test('projectBelongsToOrganization answers from the persisted row, and the resolver forwards to it', async () => {
  const { repos, db, principals } = await buildStore();
  try {
    const a = await repos.organizations.create({ name: 'A' });
    const b = await repos.organizations.create({ name: 'B' });
    const pa = await repos.projects.create({ organizationId: a.id, name: 'pa', defaultBranch: 'main' });
    const unknown = '01HZZZZZZZZZZZZZZZZZZZZZZZ' as typeof pa.id;
    assert.equal(await projectBelongsToOrganization(repos.projects, { organizationId: a.id, projectId: pa.id }), true);
    assert.equal(await projectBelongsToOrganization(repos.projects, { organizationId: b.id, projectId: pa.id }), false);
    assert.equal(await projectBelongsToOrganization(repos.projects, { organizationId: a.id, projectId: unknown }), false);

    const asked: Array<[string, string]> = [];
    const spy = new RepositoryPrincipalResolver({
      belongsToOrg: async (org, project) => { asked.push([org, project]); return org === a.id; },
    });
    assert.equal(await spy.projectBelongsToOrg(a.id, pa.id), true);
    assert.equal(await spy.projectBelongsToOrg(b.id, pa.id), false);
    assert.deepEqual(asked, [[a.id, pa.id], [b.id, pa.id]], 'the resolver asks the membership port, once per check');
    assert.equal(await principals.projectBelongsToOrg(b.id, pa.id), false);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Auth + validation — missing credential is 401; malformed body is 400.
// ---------------------------------------------------------------------------

test('a project route without a tenant credential is 401', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const res = await app.inject({
      method: 'POST', url: '/v1/projects/ABCDEFGHJKMNPQRSTVWXYZ0123/repository-bindings',
      // no headers
      payload: { githubHost: 'github.com', githubOwner: 'a', githubRepo: 'b', defaultBaseBranch: 'main' },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
    await db.close();
  }
});

test('a malformed body is 400 with structural errors (no persistence touched)', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const org = await repos.organizations.create({ name: 'Acme' });
    const res = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { authorization: bearerFor(principals, org.id) },
      payload: { name: '' }, // empty name + missing defaultBranch
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_request');
    assert.ok(Array.isArray(res.json().details));
  } finally {
    await app.close();
    await db.close();
  }
});

test('a run referencing a binding from another scope fails closed (404)', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals });
  try {
    const org = await repos.organizations.create({ name: 'Acme' });
    const projA = await repos.projects.create({ organizationId: org.id, name: 'A', defaultBranch: 'main' });
    const projB = await repos.projects.create({ organizationId: org.id, name: 'B', defaultBranch: 'main' });
    const bindingA = await repos.bindings.create(
      { organizationId: org.id, projectId: projA.id },
      { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'a', defaultBaseBranch: 'main' },
    );
    // Try to create a run under project B referencing project A's binding.
    const res = await app.inject({
      method: 'POST', url: `/v1/projects/${projB.id}/runs`,
      headers: { authorization: bearerFor(principals, org.id), [PROJECT_HEADER]: projB.id },
      payload: { repositoryBindingId: bindingA.id, risk: 'R0' },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Health endpoints.
// ---------------------------------------------------------------------------

test('health/live is always ok; health/ready reflects the injected probe', async () => {
  const { repos, db, principals } = await buildStore();
  const app = buildApp({ repositories: repos, principals, readyCheck: async () => false });
  try {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().status, 'ok');
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
  } finally {
    await app.close();
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// CLI seam — argv parsing + forwarding to the shared application use case.
// ---------------------------------------------------------------------------

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
  diff: { artifactId: ('0'.repeat(26) as unknown as ArtifactRef['artifactId']), sha256: 'd'.repeat(64), kind: 'git-diff' },
};

function fakeProvider(obs: AgentAttemptObservation): CodingAgentProvider & { calls: AgentExecuteRequest[] } {
  const calls: AgentExecuteRequest[] = [];
  return {
    providerId: 'fake', calls,
    async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> { calls.push(req); return obs; },
  };
}
function fakeInspector(change: GitChangeObservation): GitChangeInspector {
  return { async inspect(): Promise<GitChangeObservation> { return change; } };
}

test('parseArgs accepts `task execute --task-id X` and defaults risk to R0', () => {
  const args = parseArgs(['task', 'execute', '--task-id', 'T1']);
  assert.equal(args.command, 'task');
  assert.equal(args.subcommand, 'execute');
  assert.equal(args.taskId, 'T1');
  assert.equal(args.risk, 'R0');
});

test('parseArgs rejects a missing --task-id and a bad --risk', () => {
  assert.throws(() => parseArgs(['task', 'execute']), CliUsageError);
  assert.throws(() => parseArgs(['task', 'execute', '--task-id', 'T', '--risk', 'R9']), CliUsageError);
  assert.throws(() => parseArgs(['status']), CliUsageError);
});

test('runExecute forwards an R0 task to the use case and reaches inspection', async () => {
  const provider = fakeProvider(okObservation);
  const deps = { ...localDeps(provider, fakeInspector(cleanChange)) };
  const result = await runExecute(
    { command: 'task', subcommand: 'execute', taskId: 'T1', risk: 'R0' }, deps,
  );
  assert.equal(result.admitted, true);
  assert.equal(result.stoppedAt, 'complete');
  assert.equal(provider.calls.length, 1);
  // resultSha comes from the trusted inspector, not the provider.
  assert.equal(result.change?.headSha, cleanChange.headSha);
});

test('runExecute stops a DEFERRED (R3) task at admission — provider NEVER invoked', async () => {
  const provider = fakeProvider(okObservation);
  const deps = { ...localDeps(provider, fakeInspector(cleanChange)) };
  const result = await runExecute(
    { command: 'task', subcommand: 'execute', taskId: 'T1', risk: 'R3' }, deps,
  );
  assert.equal(result.admitted, false);
  assert.equal(result.stoppedAt, 'admission');
  assert.equal(provider.calls.length, 0);
});

test('formatResult renders a compact human summary', () => {
  const out = formatResult('T1', {
    admitted: true, reachedInspection: true,
    admission: { admitted: true, decision: 'ADMITTED_AUTOMATED', risk: 'R0', requiresHumanIndependentReview: false, reason: 'ok' },
    observation: okObservation, change: cleanChange,
    stoppedAt: 'complete', requiresHumanIndependentReview: false,
  });
  assert.match(out, /task:\s+T1/);
  assert.match(out, /stopped at:\s+complete/);
  assert.match(out, /result sha:/);
});
