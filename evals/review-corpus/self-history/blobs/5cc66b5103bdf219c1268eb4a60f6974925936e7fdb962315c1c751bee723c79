// Server-derived tenancy (exit criterion C2, disp. P2-PLAN-HIGH-003 /
// P2-FINAL-HIGH-004). The TenantScope's ORGANIZATION is NEVER taken from a
// client-supplied header — it is derived from an AUTHENTICATED CREDENTIAL
// (a bearer token) resolved to a principal by injected server state. The
// review found the old design read `x-asep-organization-id` straight off the
// request: anyone who learned another tenant's org id could set that header and
// act as them (row filtering never stops scope spoofing — it filters WITHIN a
// scope the attacker already chose). Now the org is bound to the credential:
// presenting org B's id while holding org A's token cannot widen access.
//
// The project is still selected per-route (path/header), but it is VERIFIED to
// belong to the authenticated organization before it becomes a scope — a token
// for org A cannot select a project under org B (fails closed as 401/AuthError,
// which the app maps so cross-tenant existence is never revealed).
//
// This is a reference/pilot resolver keyed on opaque bearer tokens held in
// server state; a production deployment swaps the PrincipalResolver for one
// that validates an OIDC/JWT signature and reads the org claim. The invariant
// is identical either way: scope comes from a verified credential, not a header
// the caller is free to type.

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

// Resolves a verified credential to the organization it is bound to. The org
// principal is SERVER state — it can never be chosen by the caller. Returns
// undefined for an unknown/invalid token so the caller fails closed with 401.
// `projectBelongsToOrg` is the authoritative check that a selected project sits
// under the authenticated org (server-side lookup, not a client assertion).
export interface PrincipalResolver {
  organizationForToken(token: string): Promise<OrganizationId | undefined>;
  projectBelongsToOrg(org: OrganizationId, project: ProjectId): Promise<boolean>;
}

// ULID grammar — the same id shape the persistence layer generates. Reject
// anything else so a malformed selector cannot reach a repository.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// The project SELECTOR header. It is only a selector: it is authorised against
// the token's org before use, so it cannot be a scope-spoofing vector. The old
// ORG header is intentionally gone — the org comes from the credential only.
const PROJECT_HEADER = 'x-asep-project-id';
const AUTH_HEADER = 'authorization';

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Extract the bearer token from the Authorization header. Throws AuthError
// (mapped to 401) when absent or not a Bearer scheme.
function bearerToken(req: FastifyRequest): string {
  const raw = headerValue(req, AUTH_HEADER);
  if (!raw) throw new AuthError('missing bearer credential');
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m || !m[1]) throw new AuthError('malformed authorization header');
  return m[1].trim();
}

// Derive the organization principal from the AUTHENTICATED credential. Throws
// AuthError (mapped to 401) when the credential is missing or does not resolve
// to a known organization. The org is never read from a client header.
export async function organizationContext(
  req: FastifyRequest,
  resolver: PrincipalResolver,
): Promise<AuthContext> {
  const token = bearerToken(req);
  const org = await resolver.organizationForToken(token);
  if (!org) throw new AuthError('invalid credential');
  return { organizationId: org };
}

// Derive the full project scope. The organization comes from the credential;
// the project is a selector that MUST be verified to belong to that org before
// it becomes a scope. A token for org A selecting a project under org B fails
// closed (AuthError → 401), so the resulting TenantScope is always one the
// caller is actually authorised for.
export async function tenantScope(
  req: FastifyRequest,
  resolver: PrincipalResolver,
): Promise<TenantScope> {
  const ctx = await organizationContext(req, resolver);
  const project = headerValue(req, PROJECT_HEADER);
  if (!project) throw new AuthError('missing project selector');
  if (!ULID.test(project)) throw new AuthError('malformed project selector');
  const belongs = await resolver.projectBelongsToOrg(ctx.organizationId, project as ProjectId);
  if (!belongs) throw new AuthError('project not in authenticated organization');
  return { organizationId: ctx.organizationId, projectId: project as ProjectId };
}

export { PROJECT_HEADER, AUTH_HEADER, ULID as ULID_PATTERN };
