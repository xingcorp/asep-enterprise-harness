// GitHubAppForgePort — the conformance seam between the application's
// `ForgeProvider` PORT and the GitHub App adapter (disp. P2-FINAL-HIGH-008).
//
// THE FINDING. The audit observed that `ForgeProvider` (packages/ports) and
// `GitHubAppForgeProvider` (this package) had incompatible shapes, so the real
// adapter could not be wired into the real driver at all:
//
//   port    pushBranch(scope, { repositoryBindingId, branch, commitSha, … }): void
//   adapter pushBranch({ repository: {identity, repositoryId}, localWorktreePath, … }): {ref}
//
//   port    upsertPullRequest(scope, {repositoryBindingId, …}): PullRequestRef
//   adapter upsertPullRequest({repository, …}): PullRequestResult
//
// Nothing in the build forced them to agree, so "the GitHub App adapter is
// wired" was unfalsifiable — production could only ever have run a hand-written
// local stand-in. This class closes that gap and, crucially, `implements
// ForgeProvider`, so the compiler now FAILS if the two drift again.
//
// WHY A RESOLVER. The port is deliberately tenant-first and infrastructure-free:
// it speaks `(TenantScope, RepositoryBindingId)` — a governed identity — not
// GitHub numeric ids or filesystem paths, which are adapter concerns the
// application layer must not know (exit B1/B3, forbidden-imports fitness). The
// mapping binding-id → (forge coordinates, local repo path) is therefore
// injected. Every resolve is SCOPED: the resolver receives the caller's
// TenantScope, so a binding belonging to another org/project cannot be resolved
// into forge coordinates (the persistence resolver enforces this at the DB
// boundary via getScoped, which throws ScopeViolationError).

import type {
  ForgeProvider, PullRequestRef,
} from '@asep/ports';
import type { TenantScope, RepositoryBindingId } from '@asep/contracts';
import type { GitHubAppForgeProvider, PullRequestResult, RepositoryForgeConfig } from './forge-provider.js';

/**
 * Resolves a governed repository-binding identity into the concrete forge
 * coordinates + the local repository that holds the harness commit.
 *
 * Implementations MUST enforce tenant scoping: a binding id that does not belong
 * to `scope` must throw rather than resolve.
 */
export interface ForgeBindingResolver {
  resolve(scope: TenantScope, repositoryBindingId: RepositoryBindingId): Promise<{
    /** host+owner+repo (validated) and the GitHub numeric id for token scoping. */
    readonly repository: RepositoryForgeConfig;
    /** Local repo/worktree containing the commit object being published. */
    readonly localRepoPath: string;
  }>;
}

/**
 * Adapts GitHubAppForgeProvider to the ForgeProvider port.
 *
 * This class holds NO safety logic of its own — that would create a second,
 * divergent policy. Ref safety, JIT token minting, token scrubbing, bounded
 * re-mint and PR idempotency all remain inside GitHubAppForgeProvider, which
 * this class simply calls with resolved coordinates. It is a translation layer,
 * on purpose.
 */
// The state and merged flag of a PR, when GitHub reported them.
function stateOf(pr: PullRequestResult): Pick<PullRequestRef, 'state' | 'merged'> {
  return {
    ...(pr.state !== undefined ? { state: pr.state } : {}),
    ...(pr.merged !== undefined ? { merged: pr.merged } : {}),
  };
}

export class GitHubAppForgePort implements ForgeProvider {
  constructor(
    private readonly inner: GitHubAppForgeProvider,
    private readonly resolver: ForgeBindingResolver,
  ) {}

  // Compare-and-set (see the port): the adapter pushes with a lease on the
  // value the branch is expected to hold.
  async pushBranch(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha: string | null;
  }): Promise<void> {
    const { repository, localRepoPath } = await this.resolver.resolve(
      scope, input.repositoryBindingId,
    );
    // Forward the EXACT commit id: the adapter then builds a
    // `<sha>:refs/heads/asep/…` refspec, so the object published is precisely
    // the one verification and evidence were bound to (and a detached harness
    // worktree, which has no local branch of that name, is still pushable).
    await this.inner.pushBranch({
      repository,
      localWorktreePath: localRepoPath,
      branch: input.branch,
      commitSha: input.commitSha,
      expectedRemoteSha: input.expectedRemoteSha,
    });
    // The port returns void: the caller's SideEffectLog already records the
    // branch as the natural key, so there is no ref for this layer to invent.
  }

  async upsertPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const { repository } = await this.resolver.resolve(scope, input.repositoryBindingId);
    const pr = await this.inner.upsertPullRequest({
      repository,
      headBranch: input.headBranch,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    // Narrow the adapter's result to the port's canonical ref shape, with the
    // state GitHub reports, so the caller can tell a reviewable PR from one a
    // human closed.
    return {
      number: pr.number,
      url: pr.url,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      ...stateOf(pr),
    };
  }

  // The recorded PR's title and body, by its number (see the port): the
  // adapter's one update naming that PR, narrowed to the port's ref shape.
  async updatePullRequestContent(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    number: number;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const { repository } = await this.resolver.resolve(scope, input.repositoryBindingId);
    const pr = await this.inner.updatePullRequestContent({
      repository,
      number: input.number,
      title: input.title,
      body: input.body,
    });
    return {
      number: pr.number,
      url: pr.url,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      ...stateOf(pr),
    };
  }

  // --- crash-recovery reconciliation (disp. P2-FINAL-HIGH-006) --------------
  //
  // Read-only lookups the application uses to decide retry-vs-adopt when it
  // resumes onto a PENDING push/PR record. Both translate governed identity into
  // resolved coordinates exactly like the write paths above, so a binding from
  // another tenant cannot be reconciled either.

  async resolveRef(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
  }): Promise<string | null> {
    // No local repo path: `ls-remote` reads the remote directly, so this probe
    // needs no working tree (and must not depend on one existing on a resume).
    const { repository } = await this.resolver.resolve(scope, input.repositoryBindingId);
    return this.inner.resolveRef({
      repository,
      branch: input.branch,
    });
  }

  async findPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
  }): Promise<PullRequestRef | null> {
    const { repository } = await this.resolver.resolve(scope, input.repositoryBindingId);
    const pr = await this.inner.findPullRequest({
      repository,
      headBranch: input.headBranch,
    });
    if (!pr) return null;
    // A lookup carries the head commit, title, body and state GitHub reports,
    // so a reader can check what the PR shows now and whether it is open.
    return {
      number: pr.number,
      url: pr.url,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      ...(pr.headSha !== undefined ? { headSha: pr.headSha } : {}),
      ...(pr.title !== undefined ? { title: pr.title } : {}),
      ...(pr.body !== undefined ? { body: pr.body } : {}),
      ...stateOf(pr),
    };
  }

  // NOTE: no merge method — H5. The port does not declare one and this class
  // adds nothing beyond the port, so no merge capability is reachable.
}
