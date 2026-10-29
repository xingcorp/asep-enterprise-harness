// GitHubAppForgeProvider — least-privilege PR delivery (exit criteria
// H1–H7, disp. P2-PLAN-CRIT-001, HIGH-007, MED-005). This is the ONLY place a
// forge credential is ever used, and it is used JIT: a token is minted for the
// exact repository right before each bounded operation and discarded after.
//
// Non-bypassable safety enforced here BY CONSTRUCTION:
//   H3/CRIT-001  every push ref is produced by safeRefspecFor(); a caller can
//                never supply a raw ref, so a push to main/master/HEAD/tag/
//                option-like/force target is impossible. Only the exact
//                `refs/heads/asep/<run>/<task>/<attempt>` create/update refspec
//                is ever handed to git.
//   H7/HIGH-007  the remote URL is CONSTRUCTED from a validated forge identity
//                (buildCloneUrl), never accepted raw. The JIT token is injected
//                via the URL userinfo only for the single push child process and
//                is scrubbed from every error/log string.
//   H1/H2        the token is opaque, minted per op, never persisted; the app
//                private key stays in the credential provider.
//   H4           pushBranch is called only after verification (the driver's
//                responsibility); upsertPullRequest is idempotent
//                (find-by-head-branch → update, else create).
//   H5           NO merge method is wired anywhere in this adapter.

import { runGit as defaultRunGit, buildCloneUrl, safeRefspecFor } from '@asep/git-worktree';
import type { ForgeIdentity } from '@asep/git-worktree';
import type { GitHubAppCredentialProvider } from './credential-provider.js';

// The git invocation seam. Defaults to the hardened runGit from @asep/git-worktree.
// A test injects a fake to capture the EXACT argv handed to git (proving only the
// safe namespaced refspec is ever sent — H3) or to drive a real local bare push.
export type GitRunner = (
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export class ForgePushError extends Error {
  constructor(reason: string) {
    super(`forge push failed: ${reason}`);
    this.name = 'ForgePushError';
  }
}

// Minimal Octokit REST surface this adapter depends on, so it can be driven by
// a transport-level fake (H6: mock the SDK/HTTP boundary, not application logic).
export interface PullsApi {
  list(params: {
    owner: string;
    repo: string;
    head: string;          // `owner:branch`
    state: 'open' | 'closed' | 'all';
  }): Promise<{ data: ReadonlyArray<{ number: number; html_url: string; head: { ref: string }; base: { ref: string } }> }>;
  create(params: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ data: { number: number; html_url: string; head: { ref: string }; base: { ref: string } } }>;
  update(params: {
    owner: string;
    repo: string;
    pull_number: number;
    title: string;
    body: string;
  }): Promise<{ data: { number: number; html_url: string; head: { ref: string }; base: { ref: string } } }>;
  // NOTE: deliberately NO `merge` method — H5, no merge capability exists.
}

export interface OctokitLike {
  readonly pulls: PullsApi;
}

// A repository's forge coordinates: identity for URL construction + the numeric
// repositoryId used to scope the minted token, and the numeric octokit needs.
export interface RepositoryForgeConfig {
  readonly identity: ForgeIdentity;   // host + owner + repo (validated)
  readonly repositoryId: number;      // GitHub numeric id — token scoping
}

export interface PushInput {
  readonly repository: RepositoryForgeConfig;
  readonly localWorktreePath: string; // where the harness commit lives
  readonly branch: string;            // MUST be an ASEP attempt branch
  readonly expectedRemoteSha?: string;// enables --force-with-lease, never plain force
}

export interface PullRequestResult {
  readonly number: number;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface UpsertPrInput {
  readonly repository: RepositoryForgeConfig;
  readonly headBranch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

// Scrub anything that looks like the JIT token or userinfo from a string before
// it can reach a log/artifact/error. Defense in depth on top of never logging.
function scrub(text: string, token: string): string {
  let out = text;
  if (token) out = out.split(token).join('***');
  // x-access-token:<...>@ userinfo form.
  out = out.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
  out = out.replace(/https:\/\/[^@\s/]+@/g, 'https://***@');
  return out;
}

export class GitHubAppForgeProvider {
  constructor(
    private readonly credentials: GitHubAppCredentialProvider,
    // Build a transport-scoped Octokit from a freshly minted token. Injected so
    // tests drive a fake transport (H6). In production this wraps `new Octokit`.
    private readonly octokitFor: (token: string) => OctokitLike,
    private readonly allowedHosts: readonly string[] = ['github.com'],
    // Git invocation seam. Defaults to the hardened runGit; a test injects a
    // fake to capture the exact argv or drive a real local bare push (H3/H6).
    private readonly runGit: GitRunner = defaultRunGit,
  ) {}

  // Push the harness commit to the EXACT ASEP-namespaced ref. The refspec is
  // produced by safeRefspecFor so no other target is representable (H3). The
  // token is minted JIT, injected only into this one git child, and scrubbed
  // from any error text (H1/H2/H7).
  async pushBranch(input: PushInput): Promise<{ ref: string }> {
    // (1) Build the ONLY safe refspec. Throws on any protected/malformed target.
    const safe = safeRefspecFor(input.branch, input.expectedRemoteSha);

    // (2) Construct the transport URL from validated identity (never raw).
    const baseUrl = buildCloneUrl(input.repository.identity, this.allowedHosts);

    // (3) Mint a JIT token scoped to exactly this repository.
    const { token } = await this.credentials.mintForRepository(input.repository.repositoryId);

    // (4) Inject the token as userinfo for THIS push only. Never written to disk.
    const authedUrl = baseUrl.replace(
      /^https:\/\//,
      `https://x-access-token:${token}@`,
    );

    // (5) Build the push argv. --force-with-lease ONLY when an expected SHA was
    // recorded; otherwise a plain, non-force create/update. Never a bare --force.
    const pushArgs = ['push'];
    if (safe.forceWithLeaseExpectedSha) {
      pushArgs.push(`--force-with-lease=${safe.branch}:${safe.forceWithLeaseExpectedSha}`);
    }
    pushArgs.push('--', authedUrl, safe.refspec);

    try {
      await this.runGit(pushArgs, { cwd: input.localWorktreePath, timeoutMs: 120_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ForgePushError(scrub(msg, token));
    }
    return { ref: `refs/heads/${safe.branch}` };
  }

  // Idempotent PR upsert: find an open PR by head branch and UPDATE it, else
  // CREATE (H4). No merge is ever attempted (H5). Token minted JIT, opaque.
  async upsertPullRequest(input: UpsertPrInput): Promise<PullRequestResult> {
    const { identity, repositoryId } = input.repository;
    const { token } = await this.credentials.mintForRepository(repositoryId);
    const octokit = this.octokitFor(token);
    const owner = identity.githubOwner;
    const repo = identity.githubRepo.replace(/\.git$/, '');

    // find-by-head-branch: GitHub's head filter is `owner:branch`.
    const existing = await octokit.pulls.list({
      owner,
      repo,
      head: `${owner}:${input.headBranch}`,
      state: 'all',
    });
    const match = existing.data.find((pr) => pr.head.ref === input.headBranch);

    if (match) {
      const updated = await octokit.pulls.update({
        owner,
        repo,
        pull_number: match.number,
        title: input.title,
        body: input.body,
      });
      return {
        number: updated.data.number,
        url: updated.data.html_url,
        headBranch: updated.data.head.ref,
        baseBranch: updated.data.base.ref,
      };
    }

    const created = await octokit.pulls.create({
      owner,
      repo,
      head: input.headBranch,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return {
      number: created.data.number,
      url: created.data.html_url,
      headBranch: created.data.head.ref,
      baseBranch: created.data.base.ref,
    };
  }
}

export { scrub as scrubToken };
