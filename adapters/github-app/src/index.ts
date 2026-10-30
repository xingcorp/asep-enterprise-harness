// @asep/github-app — least-privilege GitHub App forge adapter (S7).
//
// PUBLIC SURFACE. PR delivery via a GitHub App installation token, minted JIT
// per bounded operation and scoped to the exact repository with minimum
// permissions. Every push ref is forced through the non-bypassable
// RefSafetyPolicy (re-exported from @asep/git-worktree), the remote URL is
// constructed from validated forge identity, and NO merge capability exists.

export type { GitHubAppConfig, InstallationToken, InstallationAuth } from './credential-provider.js';
export {
  GitHubAppCredentialProvider, MINIMUM_PERMISSIONS, isExpired,
} from './credential-provider.js';

export type {
  OctokitLike, PullsApi, RepositoryForgeConfig, PushInput, UpsertPrInput, UpdatePrContentInput,
  PullRequestResult, GitRunner, ForgeOperation,
} from './forge-provider.js';
export {
  GitHubAppForgeProvider, ForgePushError, ForgeAuthExpiredError, ForgeReconcileError,
  isAuthExpiryError, MAX_REMINT_ATTEMPTS, scrubToken,
} from './forge-provider.js';

// Port conformance seam (disp. P2-FINAL-HIGH-008): the ONLY type that both
// `implements ForgeProvider` and drives the GitHub App adapter, so the compiler
// fails if the port and the adapter ever drift apart again.
export type { ForgeBindingResolver } from './port-adapter.js';
export { GitHubAppForgePort } from './port-adapter.js';

// Production resolver for that seam: answers (scope, bindingId) -> (forge
// coordinates, local repo path) from the authoritative store, delegating tenant
// scoping to the DB and failing closed when the numeric forge id is absent.
export type { ForgeBindingReader, LocalRepoLocator } from './binding-resolver.js';
export {
  SqlForgeBindingResolver, ForgeBindingIncompleteError,
} from './binding-resolver.js';
