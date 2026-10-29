// SqlForgeBindingResolver — the PRODUCTION ForgeBindingResolver (disp.
// P2-FINAL-HIGH-008).
//
// GitHubAppForgePort translates the tenant-first `ForgeProvider` port into the
// GitHub App adapter's concrete inputs, but it needs someone to answer:
//
//     (TenantScope, RepositoryBindingId) -> (forge coordinates, local repo path)
//
// This class answers it from the AUTHORITATIVE store rather than from anything
// the caller supplied. Two properties make it safe:
//
//   1. TENANT SCOPING IS DELEGATED TO THE DB. It calls the binding reader's
//      getScoped(scope, id), whose WHERE clause matches organization_id AND
//      project_id and which throws ScopeViolationError on zero rows. A binding
//      belonging to another org/project therefore cannot be resolved into forge
//      coordinates, so a cross-tenant push is impossible even if a caller
//      guesses a valid id.
//
//   2. IT FAILS CLOSED ON A MISSING NUMERIC FORGE ID. JIT token minting scopes
//      the token to `repositoryIds: [githubRepositoryId]` (H2, least
//      privilege). If the binding has no numeric id recorded, minting would
//      have to fall back to an installation-wide token — strictly broader than
//      the operation needs. Rather than silently widen the credential, this
//      throws.
//
// The local repository path is derived from the injected workspace layout, NOT
// accepted from the caller, so a request cannot point the push at an arbitrary
// filesystem location.
//
// NOTE ON THE READER TYPE. This declares the minimal STRUCTURAL shape it needs
// rather than importing RepositoryBindingRepository from @asep/persistence.
// @asep/persistence is a devDependency of this package, so importing it in
// production source would either be an undeclared runtime dependency or force
// adapter→adapter coupling. `SqlForgeBindingResolver` is satisfied by the real
// RepositoryBindingRepository without either package knowing about the other.

import type { TenantScope, RepositoryBindingId } from '@asep/contracts';
import type { ForgeBindingResolver } from './port-adapter.js';
import type { RepositoryForgeConfig } from './forge-provider.js';

/**
 * The minimal read surface this resolver needs from the binding store. The real
 * `RepositoryBindingRepository` from @asep/persistence conforms structurally.
 *
 * Implementations MUST enforce tenant scoping inside `getScoped` and throw when
 * the binding is not in scope — this resolver relies on that, it does not
 * re-check scoping itself (one authority, not two divergent ones).
 */
export interface ForgeBindingReader {
  getScoped(scope: TenantScope, id: RepositoryBindingId): Promise<{
    readonly githubHost: string;
    readonly githubOwner: string;
    readonly githubRepo: string;
    readonly githubRepositoryId?: number | undefined;
  }>;
}

/**
 * Resolves the on-disk repository that holds the harness commit for an attempt.
 * Injected so this resolver never trusts a caller-supplied path.
 */
export interface LocalRepoLocator {
  /** Absolute path of the local repo/worktree for this binding's attempt. */
  localRepoPathFor(scope: TenantScope, repositoryBindingId: RepositoryBindingId): string;
}

/** A binding exists and is in scope, but cannot be used for a least-privilege push. */
export class ForgeBindingIncompleteError extends Error {
  constructor(id: string, missing: string) {
    super(
      `repository binding ${id} cannot be used for a scoped forge operation: ` +
      `${missing} is not recorded (fail closed rather than mint a broader token)`,
    );
    this.name = 'ForgeBindingIncompleteError';
  }
}

export class SqlForgeBindingResolver implements ForgeBindingResolver {
  constructor(
    private readonly bindings: ForgeBindingReader,
    private readonly locator: LocalRepoLocator,
  ) {}

  async resolve(scope: TenantScope, repositoryBindingId: RepositoryBindingId): Promise<{
    readonly repository: RepositoryForgeConfig;
    readonly localRepoPath: string;
  }> {
    // Throws ScopeViolationError when the binding is not inside `scope`.
    const row = await this.bindings.getScoped(scope, repositoryBindingId);

    if (row.githubRepositoryId === undefined || row.githubRepositoryId === null) {
      throw new ForgeBindingIncompleteError(repositoryBindingId, 'github_repository_id');
    }

    const repository: RepositoryForgeConfig = {
      identity: {
        githubHost: row.githubHost,
        githubOwner: row.githubOwner,
        githubRepo: row.githubRepo,
      },
      repositoryId: row.githubRepositoryId,
    };

    return {
      repository,
      localRepoPath: this.locator.localRepoPathFor(scope, repositoryBindingId),
    };
  }
}
