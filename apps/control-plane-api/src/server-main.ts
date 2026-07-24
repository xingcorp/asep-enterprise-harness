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

  // Readiness = the DB answers its own trivial probe. The composition root does
  // not author raw SQL; it forwards to the seam's ping() (arch discipline).
  const app = buildApp({
    repositories,
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
