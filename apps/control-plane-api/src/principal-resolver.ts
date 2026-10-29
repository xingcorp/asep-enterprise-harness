// Concrete PrincipalResolver (disp. P2-FINAL-HIGH-004). Binds an opaque bearer
// token to the ORGANIZATION it authenticates as (server truth), and answers
// whether a selected project actually sits under that organization via the
// authoritative persistence seam — never a client assertion.
//
// The token→org map is server-held state: a caller cannot mint or alter a
// binding by sending a header. Presenting org B's id while holding org A's
// token resolves to org A (the header org selector is gone entirely); selecting
// a project under org B while authenticated as org A fails the membership check
// and the request fails closed (AuthError → 401). A production deployment swaps
// this for an OIDC/JWT validator reading the org claim; the invariant is the
// same — scope is derived from a verified credential, not a typed-in header.
//
// Composition-root discipline (arch guard): this file neither authors SQL nor
// invokes the persistence adapter. The membership check is the application use
// case projectBelongsToOrganization, driven against a structural port that the
// concrete project repository satisfies.

import type { OrganizationId, ProjectId } from '@asep/contracts';
import { projectBelongsToOrganization, type ProjectMembershipPort } from '@asep/application';
import type { OperatorPrincipal, PrincipalResolver } from './auth.js';

// A single credential binding: an opaque token authenticates as exactly one
// organization. Kept minimal on purpose — the reference resolver holds these in
// memory; a real IdP would carry the same (token → org) relation in its claims.
export interface TokenBinding {
  readonly token: string;
  readonly organizationId: OrganizationId;
}

// A PLATFORM-operator credential (disp. P2-FINAL-HIGH-004). Organization
// creation sits ABOVE the tenancy tree, so it cannot be authorised by a
// TenantScope; it is authorised by an operator credential carrying an explicit
// capability. Held as server state exactly like the tenant bindings.
export interface OperatorBinding {
  readonly token: string;
  readonly principalId: string;
  readonly capabilities: readonly string[];
}

export class RepositoryPrincipalResolver implements PrincipalResolver {
  private readonly tokens: Map<string, OrganizationId>;
  private readonly operators: Map<string, OperatorPrincipal>;

  constructor(
    private readonly projects: ProjectMembershipPort,
    bindings: readonly TokenBinding[] = [],
    operators: readonly OperatorBinding[] = [],
  ) {
    this.tokens = new Map(bindings.map((b) => [b.token, b.organizationId]));
    this.operators = new Map(
      operators.map((o) => [
        o.token,
        { principalId: o.principalId, capabilities: [...o.capabilities] },
      ]),
    );
  }

  // Register/replace a credential binding. Server-side only — there is no HTTP
  // path that lets a caller create a binding for an org it does not control.
  bindToken(token: string, organizationId: OrganizationId): void {
    this.tokens.set(token, organizationId);
  }

  // Register/replace a PLATFORM-operator credential. Server-side only, for the
  // same reason: no HTTP path grants a capability.
  bindOperator(token: string, principalId: string, capabilities: readonly string[]): void {
    this.operators.set(token, { principalId, capabilities: [...capabilities] });
  }

  async organizationForToken(token: string): Promise<OrganizationId | undefined> {
    return this.tokens.get(token);
  }

  // Tenant tokens and operator tokens are DISJOINT principal classes: this map
  // is consulted alone, so an org-scoped tenant credential never resolves to an
  // operator and therefore can never create an organization.
  async operatorForToken(token: string): Promise<OperatorPrincipal | undefined> {
    return this.operators.get(token);
  }

  // Authoritative membership check through the application use case: a token
  // for org A cannot select a project under org B (fails closed to false → 401).
  async projectBelongsToOrg(org: OrganizationId, project: ProjectId): Promise<boolean> {
    return projectBelongsToOrganization(this.projects, { organizationId: org, projectId: project });
  }
}
