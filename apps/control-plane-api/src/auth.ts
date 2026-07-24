// Server-derived tenancy (exit criterion C2, disp. P2-PLAN-HIGH-003). The
// TenantScope is NEVER taken from a request body — it is derived here from
// authenticated server state. This reference/pilot implementation reads the
// organization/project from signed request headers set by an upstream auth
// layer; a production deployment would derive the same AuthContext from an
// OIDC token. The critical property preserved either way: a handler cannot let
// a client choose which project it acts on by putting an id in the body.

import type { FastifyRequest } from 'fastify';
import type {
  OrganizationId, ProjectId, TenantScope,
} from '@asep/contracts';

// The authenticated principal. `projectId` is present only for project-scoped
// routes; organization-only routes (create a project) carry just the org.
export interface AuthContext {
  readonly organizationId: OrganizationId;
  readonly projectId?: ProjectId;
}

export class AuthError extends Error {
  constructor(reason: string) {
    super(`auth: ${reason}`);
    this.name = 'AuthError';
  }
}

// ULID grammar — the same id shape the persistence layer generates. Reject
// anything else so a malformed header cannot reach a repository.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ORG_HEADER = 'x-asep-organization-id';
const PROJECT_HEADER = 'x-asep-project-id';

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Derive the organization principal from the authenticated request. Throws
// AuthError (mapped to 401) when absent or malformed.
export function organizationContext(req: FastifyRequest): AuthContext {
  const org = headerValue(req, ORG_HEADER);
  if (!org) throw new AuthError('missing organization credential');
  if (!ULID.test(org)) throw new AuthError('malformed organization credential');
  return { organizationId: org as OrganizationId };
}

// Derive the full project scope. Both organization and project must be present
// and well-formed; the repositories then enforce that the two actually relate
// (a cross-project row resolves to zero rows and fails closed).
export function tenantScope(req: FastifyRequest): TenantScope {
  const ctx = organizationContext(req);
  const project = headerValue(req, PROJECT_HEADER);
  if (!project) throw new AuthError('missing project credential');
  if (!ULID.test(project)) throw new AuthError('malformed project credential');
  return { organizationId: ctx.organizationId, projectId: project as ProjectId };
}

export { ORG_HEADER, PROJECT_HEADER, ULID as ULID_PATTERN };
