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
// Composition-root discipline (arch guard): this file authors NO raw SQL. The
// membership check delegates to ProjectRepository.belongsToOrg — the query
// lives behind the persistence seam where it belongs.

import type { OrganizationId, ProjectId } from '@asep/contracts';
import type { ProjectRepository } from '@asep/persistence';
import type { PrincipalResolver } from './auth.js';

// A single credential binding: an opaque token authenticates as exactly one
// organization. Kept minimal on purpose — the reference resolver holds these in
// memory; a real IdP would carry the same (token → org) relation in its claims.
export interface TokenBinding {
  readonly token: string;
  readonly organizationId: OrganizationId;
}

export class RepositoryPrincipalResolver implements PrincipalResolver {
  private readonly tokens: Map<string, OrganizationId>;

  constructor(private readonly projects: ProjectRepository, bindings: readonly TokenBinding[] = []) {
    this.tokens = new Map(bindings.map((b) => [b.token, b.organizationId]));
  }

  // Register/replace a credential binding. Server-side only — there is no HTTP
  // path that lets a caller create a binding for an org it does not control.
  bindToken(token: string, organizationId: OrganizationId): void {
    this.tokens.set(token, organizationId);
  }

  async organizationForToken(token: string): Promise<OrganizationId | undefined> {
    return this.tokens.get(token);
  }

  // Authoritative membership check via the persistence seam: a token for org A
  // cannot select a project under org B (fails closed to false → 401).
  async projectBelongsToOrg(org: OrganizationId, project: ProjectId): Promise<boolean> {
    return this.projects.belongsToOrg(org, project);
  }
}
