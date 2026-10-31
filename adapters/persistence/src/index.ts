// @asep/persistence — project-scoped PostgreSQL persistence (S2).
//
// PUBLIC SURFACE. Everything the application/composition roots need to talk to
// operational state, behind the SqlExecutor/SqlClient seam so the concrete
// driver (pglite in tests/no-Docker dev, node-postgres pg.Pool in CI/prod) is
// swappable without touching a single consumer.

export type {
  SqlParam, SqlRow, SqlResult, SqlExecutor, SqlClient,
} from './sql.js';
export { OptimisticConcurrencyError, ScopeViolationError } from './sql.js';

export { PgliteClient } from './pglite-client.js';
export { PgPoolClient } from './pg-pool-client.js';

export { ulid, isUlid } from './ulid.js';

export type { Migration } from './migrations.js';
export { MIGRATIONS } from './migrations.js';
export { migrate, MigrationChecksumError } from './migrator.js';

export {
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository, AttemptRepository, PullRequestRepository,
  scopeMatches,
} from './repositories.js';
export type {
  OrganizationRow, ProjectRow, RepositoryBindingRow, RunRow, TaskRow,
  AttemptRow, PullRequestRow,
} from './repositories.js';

export { SqlWorkspaceLeaseRepository } from './lease-repository.js';

// Content-addressed immutable artifact store (S3).
export type { ObjectStore } from './object-store.js';
export {
  FilesystemObjectStore, S3ObjectStore, ObjectExistsError, ObjectNotFoundError,
} from './object-store.js';
export {
  ContentAddressedArtifactStore, ArtifactChecksumError, ArtifactNotFoundError,
  ArtifactRefMismatchError,
} from './artifact-store.js';

// Preallocated-id evidence store (S9, exit D8) + two-phase crash-safe
// side-effect log (S9, exit C7).
export {
  ContentAddressedEvidenceStore, EvidenceImmutabilityError, EvidenceNotFoundError,
} from './evidence-store.js';
export { SqlSideEffectLog } from './side-effect-log.js';

// PostgreSQL-backed AuditSink (exit J4, disp. P2-FINAL-MED-003). Persists the
// pure @asep/observability AuditEvent to the audit_events table.
export { SqlAuditSink } from './audit-sink.js';

// Run events (data model §3.7): the one RunEventSink both lanes inject, and the
// default assurance slot's fenced attempt-terminal writes on it, with the lease
// acquisition that refuses an attempt once its terminal is recorded.
export { SqlRunEventSink, RunEventValidationError } from './run-events/run-event-sink.js';
export { SqlAttemptTerminalStore } from './run-events/attempt-terminal-store.js';
