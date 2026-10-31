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

// Authenticated but NOT permitted (disp. P2-FINAL-HIGH-004). Distinct from
// AuthError so the transport maps it to 403 rather than 401: the credential is
// genuine, the capability is missing. Collapsing the two would make an
// authorisation hole indistinguishable from an authentication one.
export class ForbiddenError extends Error {
  constructor(reason: string) {
    super(`forbidden: ${reason}`);
    this.name = 'ForbiddenError';
  }
}

// A platform-level (non-tenant) principal. Organization creation is the scope
// ROOT — there is no organization to scope it to yet — so it cannot be
// authorised by a TenantScope. It is instead authorised by an operator
// credential holding an explicit capability. This keeps C2's rule intact ("every
// use case receives a server-derived AuthContext") for the one endpoint that
// sits above the tenancy tree, rather than exempting it.
export interface OperatorPrincipal {
  readonly principalId: string;
  readonly capabilities: readonly string[];
}

// The capability required to create an organization. Named as a constant so the
// route, the resolver and the tests agree on one string.
export const CAP_CREATE_ORGANIZATION = 'organizations:create';

// A tenant principal: who acts inside an organization, and what they may do.
// Orchestration routes authorise each control and approval decision by
// capability and record the principal's id, which is server state (a ULID) and
// the only identity that enters workflow history. Only a human principal may
// decide an approval; an agent principal never controls a workflow.
export type TenantPrincipalClass = 'human' | 'service' | 'agent';

export interface TenantPrincipal {
  readonly principalId: string;
  readonly principalClass: TenantPrincipalClass;
  readonly organizationId: OrganizationId;
  readonly capabilities: readonly string[];
}

// The tenant capabilities of durable orchestration.
export const CAP_EXECUTIONS_START = 'executions:start';
export const CAP_EXECUTIONS_CONTROL = 'executions:control';
export const CAP_APPROVALS_READ = 'approvals:read';
export const CAP_APPROVALS_DECIDE = 'approvals:decide';
export const CAP_RUNS_GOVERN = 'runs:govern';

// Resolves a verified credential to the organization it is bound to. The org
// principal is SERVER state — it can never be chosen by the caller. Returns
// undefined for an unknown/invalid token so the caller fails closed with 401.
// `projectBelongsToOrg` is the authoritative check that a selected project sits
// under the authenticated org (server-side lookup, not a client assertion).
export interface PrincipalResolver {
  organizationForToken(token: string): Promise<OrganizationId | undefined>;
  projectBelongsToOrg(org: OrganizationId, project: ProjectId): Promise<boolean>;
  // Resolve a bearer credential to a PLATFORM-level operator principal (disp.
  // P2-FINAL-HIGH-004). Returns undefined when the token is unknown or is only
  // an org-scoped tenant credential, so the caller fails closed. Separate from
  // organizationForToken because these are different principal classes: a
  // tenant token must NOT be able to mint new organizations.
  operatorForToken(token: string): Promise<OperatorPrincipal | undefined>;
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

// Derive the PLATFORM operator principal for organization creation (HIGH-004).
// Fails closed in three distinct ways:
//   - no/malformed bearer credential            → AuthError    (401)
//   - credential resolves to no operator        → AuthError    (401)
//   - operator lacks organizations:create       → ForbiddenError (403)
// An org-scoped tenant token resolves to no operator, so a tenant credential can
// never mint an organization.
export async function operatorContext(
  req: FastifyRequest,
  resolver: PrincipalResolver,
  capability: string = CAP_CREATE_ORGANIZATION,
): Promise<OperatorPrincipal> {
  const token = bearerToken(req);
  const operator = await resolver.operatorForToken(token);
  if (!operator) throw new AuthError('credential is not a platform operator');
  if (!operator.capabilities.includes(capability)) {
    throw new ForbiddenError(`principal lacks capability '${capability}'`);
  }
  return operator;
}

export { PROJECT_HEADER, AUTH_HEADER, ULID as ULID_PATTERN };
