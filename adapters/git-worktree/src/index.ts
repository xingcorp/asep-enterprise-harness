// @asep/git-worktree — isolated leased Git worktree lifecycle (S4).
//
// PUBLIC SURFACE. A trusted, credential-free Git adapter: a bare mirror cache,
// isolated linked worktrees pinned at a verified base SHA, trusted change
// inspection after the untrusted agent exits, and harness-owned commits with
// ASEP trailers. Clone URLs are constructed from validated forge identity
// (never a raw remote_url) and every push ref is forced through a
// non-bypassable RefSafetyPolicy.

export type { GitResult, RunGitOptions } from './git-exec.js';
export { runGit, endOfOptions, GitCommandError } from './git-exec.js';

export type { ForgeIdentity } from './remote-url.js';
export { buildCloneUrl, rejectRawRemoteUrl, RemoteIdentityError } from './remote-url.js';

export type { AttemptRefIdentity, SafeRefspec } from './ref-safety.js';
export { attemptBranch, safeRefspecFor, RefSafetyError, PROTECTED_REFS } from './ref-safety.js';

export type { WorktreeManagerConfig } from './worktree-manager.js';
export {
  GitWorktreeManager, WorktreeContainmentError, BaseShaError,
} from './worktree-manager.js';

export { ulid, isUlid } from './ulid.js';
