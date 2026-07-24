// @asep/control-plane-api — public surface (composition root package).
//
// The Fastify app factory + the CLI seam are exported so tests can drive them
// with injected fakes. The runnable entrypoints are server-main.ts (HTTP API)
// and cli-main.ts (`asep task execute`); both are thin composition roots.

export { buildApp, type Repositories, type AppOptions } from './app.js';
export {
  organizationContext, tenantScope, AuthError,
  PROJECT_HEADER, AUTH_HEADER, ULID_PATTERN,
  type AuthContext, type PrincipalResolver,
} from './auth.js';
export {
  RepositoryPrincipalResolver, type TokenBinding,
} from './principal-resolver.js';
export {
  parseCreateOrganization, parseCreateProject, parseCreateBinding,
  parseCreateRun, parseCreateTask,
  type Parsed, type ValidationFailure, type ValidationOk,
} from './request-schemas.js';
export {
  parseArgs, runExecute, formatResult, localDeps,
  CliUsageError, type CliArgs, type CliDeps,
} from './cli.js';
