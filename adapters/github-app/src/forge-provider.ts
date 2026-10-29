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

import {
  runGit as defaultRunGit, buildCloneUrl, safeRefspecFor, safeCommitRefspecFor,
} from '@asep/git-worktree';
import type { ForgeIdentity } from '@asep/git-worktree';
import type { GitHubAppCredentialProvider } from './credential-provider.js';
import { isExpired } from './credential-provider.js';

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

// A forge auth credential expired/was revoked mid-operation and a bounded
// re-mint could not recover (MED-002). Distinct from ForgePushError so a caller
// can tell "the push itself failed" from "we could not obtain a usable
// credential" — the latter is a reconcile-then-retry signal, not a dead end.
export class ForgeAuthExpiredError extends Error {
  constructor(op: string, attempts: number) {
    super(`forge ${op} could not obtain a valid credential after ${attempts} re-mint attempt(s) — token expired/revoked (fail closed)`);
    this.name = 'ForgeAuthExpiredError';
  }
}

// A read-only reconciliation probe (resolveRef) failed for a reason OTHER than
// credential expiry — the remote is unreachable, the repository is gone, git
// itself failed. Kept distinct from ForgePushError: nothing was being pushed,
// and a caller deciding retry-vs-adopt must not read a failed probe as a failed
// publish. The message is token-scrubbed like every other forge error.
export class ForgeReconcileError extends Error {
  constructor(reason: string) {
    super(`forge reconciliation probe failed: ${reason}`);
    this.name = 'ForgeReconcileError';
  }
}

// The operations that spend a JIT credential. Named so an exhausted budget says
// which one could not recover.
export type ForgeOperation = 'push' | 'resolve-ref' | 'pr-upsert' | 'pr-find';

// Bound on JIT-credential re-mints per operation (MED-002). A token that
// expires or is revoked BETWEEN mint and use is recoverable by minting a fresh
// one, but only a bounded number of times — an unbounded loop against a
// permanently-revoked installation would hang. One initial mint + this many
// re-mints.
export const MAX_REMINT_ATTEMPTS = 2;

// Recognise a transport error that means "this credential is no longer valid"
// (expiry, revocation, rotation invalidating the old token).
//
// THE FIX (disp. P2-FINAL-MED-002). The previous version returned true for ANY
// 401/403, but GitHub answers 403 for three unrelated situations:
//
//   - credential no longer valid      → re-minting a fresh token DOES help
//   - secondary rate limit / abuse    → re-minting does NOT help (same limit)
//   - permission not granted          → re-minting does NOT help (same perms)
//
// Treating the last two as expiry burned the whole re-mint budget on errors a
// fresh token can never fix, and then reported ForgeAuthExpiredError — a
// misleading diagnosis that hides a real rate-limit or a missing App permission.
// So 401 (always an auth failure) stays unconditional, while 403 is classified by
// its message: rate-limit / permission wording is explicitly NOT expiry.
export function isAuthExpiryError(err: unknown): boolean {
  // Extract the message from BOTH shapes we actually receive. Octokit rejects
  // with plain objects carrying `status` + `message`, and `String(obj)` yields
  // '[object Object]' — which would silently discard the wording the 403 rule
  // depends on. Read `.message` off any object before falling back to String().
  const rawMessage = err instanceof Error
    ? err.message
    : (typeof (err as { message?: unknown })?.message === 'string'
      ? (err as { message: string }).message
      : String(err));
  const msg = rawMessage.toLowerCase();
  const status = (err as { status?: unknown })?.status;

  // Rate limiting and authorization-scope failures are NOT credential expiry,
  // whatever status they arrive with. Checked first so they can never be
  // misread as recoverable-by-re-mint.
  if (
    /rate limit/.test(msg) ||
    /secondary rate/.test(msg) ||
    /abuse detection/.test(msg) ||
    /retry-after/.test(msg) ||
    /resource not accessible by integration/.test(msg) ||
    /not (have|granted) (the )?permission/.test(msg) ||
    /must have admin rights/.test(msg) ||
    /forbidden: insufficient/.test(msg)
  ) {
    return false;
  }

  // 401 is always "this credential is not usable".
  if (status === 401) return true;

  // A 403 (or a message-only error) counts as expiry ONLY with credential wording.
  // Git over HTTPS never says "bad credentials". An expired or revoked
  // installation token in the push/ls-remote URL comes back as one of these, so
  // without them a mid-operation expiry on the two git-based operations was
  // reported as an ordinary push failure and never re-minted. A git 403 is a
  // ruleset/permission refusal and deliberately stays out.
  if (
    /authentication failed for/.test(msg) ||
    /invalid username or (password|token)/.test(msg) ||
    /requested url returned error: 401/.test(msg)
  ) {
    return true;
  }

  const credentialWording =
    /bad credentials/.test(msg) ||
    /token (has )?expired/.test(msg) ||
    /credentials? (have )?expired/.test(msg) ||
    /requires authentication/.test(msg) ||
    /token (was )?revoked/.test(msg) ||
    /installation (has been )?(suspended|deleted)/.test(msg);
  if (status === 403) return credentialWording;
  return credentialWording;
}

// Minimal Octokit REST surface this adapter depends on, so it can be driven by
// a transport-level fake (H6: mock the SDK/HTTP boundary, not application logic).
export interface PullsApi {
  list(params: {
    owner: string;
    repo: string;
    head: string;          // `owner:branch`
    state: 'open' | 'closed' | 'all';
  }): Promise<{ data: ReadonlyArray<{ number: number; html_url: string; head: { ref: string; sha?: string }; base: { ref: string } }> }>;
  create(params: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ data: { number: number; html_url: string; head: { ref: string; sha?: string }; base: { ref: string } } }>;
  update(params: {
    owner: string;
    repo: string;
    pull_number: number;
    title: string;
    body: string;
  }): Promise<{ data: { number: number; html_url: string; head: { ref: string; sha?: string }; base: { ref: string } } }>;
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
  // The EXACT harness commit to publish (disp. P2-FINAL-HIGH-008). When present
  // the refspec pushes this immutable object id to the safe namespaced ref, so
  // the bytes landing on the remote are exactly the commit verification and
  // evidence were bound to — and a detached worktree (which has no local branch
  // of that name) can still be pushed. Omitted → legacy local-branch refspec.
  readonly commitSha?: string;
}

export interface PullRequestResult {
  readonly number: number;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  // The commit GitHub reports the PR head at, when it reports one.
  readonly headSha?: string;
}

// The adapter's result for a PR as GitHub returned it.
function prResult(pr: {
  number: number; html_url: string; head: { ref: string; sha?: string }; base: { ref: string };
}): PullRequestResult {
  return {
    number: pr.number,
    url: pr.html_url,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    ...(typeof pr.head.sha === 'string' && /^[0-9a-f]{40}$/.test(pr.head.sha) ? { headSha: pr.head.sha } : {}),
  };
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
    // Clock seam for expiry checks (MED-002). Injected so a fake-clock test can
    // drive "minted but already expired" deterministically.
    private readonly now: () => number = () => Date.now(),
    // Safety skew: a token expiring within this window is treated as unusable,
    // because it would very likely expire mid-operation.
    private readonly expirySkewMs: number = 5_000,
  ) {}

  // Mint a JIT token AND assert it is actually usable before handing it to an
  // operation (MED-002). `isExpired()` existed but was never called, so a token
  // that was already expired at mint time (clock skew, a stale cached auth
  // strategy, a revoked installation replaying an old value) was used anyway and
  // failed deep inside the transport. Checking here turns that into a bounded
  // re-mint at the call site, or a clean ForgeAuthExpiredError.
  private async mintUsable(repositoryId: number, refresh: boolean): Promise<string | null> {
    const { token, expiresAt } = await this.credentials.mintForRepository(
      repositoryId, refresh ? { refresh: true } : {},
    );
    if (typeof expiresAt === 'string' && expiresAt !== '') {
      if (isExpired(expiresAt, this.now(), this.expirySkewMs)) return null;
    }
    return token;
  }

  // The ONE credential-recovery loop every token-spending operation goes
  // through. Each attempt mints a fresh token — bypassing the auth strategy's
  // cache on every re-mint — skips a token that is already expired at use time,
  // and retries only when the failure is credential expiry/revocation. Anything
  // else propagates unchanged on the first occurrence. Exhausting the bound is a
  // ForgeAuthExpiredError naming the operation, never a push or probe failure.
  //
  // Before this, the loop was hand-copied into three operations and the fourth
  // (resolveRef, the probe crash recovery depends on) minted once and wrapped an
  // expired credential as ForgePushError. Routing all four through one function
  // makes "this operation recovers from expiry" a property of the class rather
  // than of whichever method remembered to.
  private async withCredential<T>(
    op: ForgeOperation,
    repositoryId: number,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_REMINT_ATTEMPTS; attempt++) {
      const token = await this.mintUsable(repositoryId, attempt > 0);
      if (token === null) continue;
      try {
        return await fn(token);
      } catch (err) {
        if (isAuthExpiryError(err)) continue;
        throw err;
      }
    }
    throw new ForgeAuthExpiredError(op, MAX_REMINT_ATTEMPTS + 1);
  }

  // Push the harness commit to the EXACT ASEP-namespaced ref. The refspec is
  // produced by safeRefspecFor so no other target is representable (H3). The
  // token is minted JIT, injected only into this one git child, and scrubbed
  // from any error text (H1/H2/H7).
  async pushBranch(input: PushInput): Promise<{ ref: string }> {
    // (1) Build the ONLY safe refspec. Throws on any protected/malformed target.
    // Done ONCE, before any mint, so a bad ref never mints a token (H3).
    // With an explicit commitSha the source is that immutable object id; the
    // DESTINATION is validated by the same single authority either way.
    const safe = input.commitSha
      ? safeCommitRefspecFor(input.commitSha, input.branch, input.expectedRemoteSha)
      : safeRefspecFor(input.branch, input.expectedRemoteSha);

    // (2) Construct the transport URL from validated identity (never raw).
    const baseUrl = buildCloneUrl(input.repository.identity, this.allowedHosts);

    // (3) Build the push argv. --force-with-lease ONLY when an expected SHA was
    // recorded; otherwise a plain, non-force create/update. Never a bare --force.
    const pushArgsTemplate = ['push'];
    if (safe.forceWithLeaseExpectedSha) {
      pushArgsTemplate.push(`--force-with-lease=${safe.branch}:${safe.forceWithLeaseExpectedSha}`);
    }

    // One bounded recovery loop; the token is injected only into this
    // one git child. A credential failure is rethrown raw so the loop re-mints;
    // any other failure is a genuine push error, scrubbed, and fails fast.
    return this.withCredential('push', input.repository.repositoryId, async (token) => {
      const authedUrl = baseUrl.replace(
        /^https:\/\//,
        'https://x-access-token:' + token + '@',
      );
      const pushArgs = [...pushArgsTemplate, '--', authedUrl, safe.refspec];
      try {
        await this.runGit(pushArgs, { cwd: input.localWorktreePath, timeoutMs: 120_000 });
        return { ref: `refs/heads/${safe.branch}` };
      } catch (err) {
        if (isAuthExpiryError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ForgePushError(scrub(msg, token));
      }
    });
  }

  // Idempotent PR upsert: find an open PR by head branch and UPDATE it, else
  // CREATE (H4). No merge is ever attempted (H5). Token minted JIT, opaque.
  async upsertPullRequest(input: UpsertPrInput): Promise<PullRequestResult> {
    const { identity, repositoryId } = input.repository;
    const owner = identity.githubOwner;
    const repo = identity.githubRepo.replace(/\.git$/, '');

    // MED-002: the upsert is a find-or-create against REST; a credential that
    // expired/was revoked between mint and call is recovered by the bounded
    // re-mint loop. The upsert is idempotent (find-by-head-branch → update, else
    // create) so a retry after a partial auth failure cannot open a duplicate.
    return this.withCredential('pr-upsert', repositoryId, async (token) => {
      const octokit = this.octokitFor(token);
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
        return prResult(updated.data);
      }

      const created = await octokit.pulls.create({
        owner,
        repo,
        head: input.headBranch,
        base: input.base,
        title: input.title,
        body: input.body,
      });
      return prResult(created.data);
    });
  }

  // --- crash-recovery reconciliation (disp. P2-FINAL-HIGH-006, exit C7) ------
  //
  // Ask the REMOTE what is actually there, so a resume that finds a PENDING
  // record can distinguish "the effect landed before the crash" from "it never
  // ran" instead of blindly re-calling. Both are READ-ONLY: they publish
  // nothing, so running them on a resume is always safe.

  // The commit SHA the remote ref currently points at, or null when absent.
  // `ls-remote` is a read; the ref name is still passed through the single
  // ref-safety authority so a malformed/protected target cannot be probed.
  async resolveRef(input: {
    repository: RepositoryForgeConfig;
    branch: string;
  }): Promise<string | null> {
    const safe = safeRefspecFor(input.branch);
    const baseUrl = buildCloneUrl(input.repository.identity, this.allowedHosts);
    // The same bounded recovery as every other operation. A resume that
    // finds a PENDING push calls this first, so a probe that died on an expired
    // token wedged the whole recovery path.
    return this.withCredential('resolve-ref', input.repository.repositoryId, async (token) => {
      const authedUrl = baseUrl.replace(/^https:\/\//, 'https://x-access-token:' + token + '@');
      try {
        const res = await this.runGit(
          ['ls-remote', '--', authedUrl, `refs/heads/${safe.branch}`],
          { timeoutMs: 60_000 },
        );
        const line = res.stdout.trim();
        if (line === '') return null;                    // ref does not exist yet
        const sha = line.split(/\s+/)[0] ?? '';
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      } catch (err) {
        if (isAuthExpiryError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ForgeReconcileError(scrub(msg, token));
      }
    });
  }

  // The PR whose head is `headBranch`, or null when none exists. Reuses the same
  // find-by-head-branch query the idempotent upsert uses, so reconciliation and
  // upsert agree on what "already there" means.
  async findPullRequest(input: {
    repository: RepositoryForgeConfig;
    headBranch: string;
  }): Promise<PullRequestResult | null> {
    const { identity, repositoryId } = input.repository;
    const owner = identity.githubOwner;
    const repo = identity.githubRepo.replace(/\.git$/, '');
    return this.withCredential('pr-find', repositoryId, async (token) => {
      const octokit = this.octokitFor(token);
      const existing = await octokit.pulls.list({
        owner, repo, head: `${owner}:${input.headBranch}`, state: 'all',
      });
      const match = existing.data.find((pr) => pr.head.ref === input.headBranch);
      return match ? prResult(match) : null;
    });
  }
}

export { scrub as scrubToken };
