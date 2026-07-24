// Control Plane API composition root (exit criteria B2/B5). This is the ONLY
// place concrete adapters are constructed and wired: it builds a SqlClient,
// applies migrations, constructs the project-scoped repositories, hands them to
// the pure app factory, and starts listening. It performs NO domain decision,
// NO route logic of its own — buildApp() owns the (thin) routes and the
// repositories own persistence. Swapping pglite for a pg.Pool here changes
// nothing above the SqlClient seam.

import {
  PgliteClient, migrate,
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository,
} from '@asep/persistence';
import { buildApp, type Repositories } from './app.js';
import { RepositoryPrincipalResolver, type TokenBinding } from './principal-resolver.js';

// Parse the reference token→org bindings from an env var (a JSON array of
// {token, organizationId}). Absent/blank means no bindings (every request then
// fails closed with 401 until real credentials are provisioned) — fail-closed
// by default, never fail-open. A malformed value is a hard startup error.
function parseTokenBindings(raw: string | undefined): TokenBinding[] {
  if (!raw || raw.trim() === '') return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('ASEP_TOKEN_BINDINGS must be a JSON array');
  return parsed.map((b): TokenBinding => {
    const rec = b as { token?: unknown; organizationId?: unknown };
    if (typeof rec.token !== 'string' || typeof rec.organizationId !== 'string') {
      throw new Error('ASEP_TOKEN_BINDINGS entries need string token + organizationId');
    }
    return { token: rec.token, organizationId: rec.organizationId as TokenBinding['organizationId'] };
  });
}

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8088);
  const host = process.env['HOST'] ?? '127.0.0.1';

  // Build the persistence backend and bring the schema forward. In CI/prod this
  // would construct a pg.Pool-backed SqlClient against a digest-pinned Postgres;
  // pglite gives the same DDL semantics for local/dev without a Docker daemon.
  const db = await PgliteClient.create(process.env['ASEP_PG_DATA_DIR']);
  await migrate(db);

  const repositories: Repositories = {
    organizations: new OrganizationRepository(db),
    projects: new ProjectRepository(db),
    bindings: new RepositoryBindingRepository(db),
    runs: new RunRepository(db),
    tasks: new TaskRepository(db),
    attempts: new AttemptRepository(db),
  };

  // Authenticated-principal resolver (HIGH-004): the org scope is bound to a
  // verified bearer token, NEVER a client header. Reference bindings are loaded
  // from ASEP_TOKEN_BINDINGS (a JSON array of {token, organizationId}); a
  // production deployment swaps this for an OIDC/JWT validator reading the org
  // claim, with the same invariant. Membership of a selected project under the
  // authenticated org is checked authoritatively against the DB seam.
  const principals = new RepositoryPrincipalResolver(repositories.projects, parseTokenBindings(process.env['ASEP_TOKEN_BINDINGS']));

  // Readiness = the DB answers its own trivial probe. The composition root does
  // not author raw SQL; it forwards to the seam's ping() (arch discipline).
  const app = buildApp({
    repositories,
    principals,
    readyCheck: () => db.ping(),
  });

  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`ASEP control-plane API listening on http://${host}:${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('control-plane API failed to start:', err);
  process.exitCode = 1;
});
