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
  OctokitLike, PullsApi, RepositoryForgeConfig, PushInput, UpsertPrInput,
  PullRequestResult, GitRunner,
} from './forge-provider.js';
export { GitHubAppForgeProvider, ForgePushError, scrubToken } from './forge-provider.js';
