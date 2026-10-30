// Local test doubles for the vertical-slice driver (disp. P2-FINAL-MED-004,
// exit B2/B5).
//
// THE FINDING. These three lived in apps/control-plane-api/src/vertical-slice.ts,
// so a COMPOSITION ROOT held eight direct `runGit(...)` invocations plus two
// full port implementations. B2/B5 say a root wires adapters and forwards to one
// application use case — it does not implement ports and does not drive git. The
// fitness function missed it because its git rule only matched
// `spawn('git', ...)` / `child_process`, never the repo's own `runGit()` helper,
// so the violation was invisible to the gate rather than absent from the tree.
//
// A port implementation belongs in adapters/*, exactly like the pre-existing
// @asep/agent-mock. Moving them here (verbatim — no behaviour change) makes the
// root a root again, and lets the widened fitness rule hold with no exemption.
//
// These are DOUBLES, but honest ones: FileWritingAgent really mutates the
// worktree, and LocalBareForgeProvider really runs `git push` / `git ls-remote`
// against a local bare repo. Nothing here fakes a harness-owned fact.

import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit, safeCommitRefspecFor, pushLeaseFor } from '@asep/git-worktree';
import type {
  CodingAgentProvider, AgentExecuteRequest, AgentAttemptObservation,
  ForgeProvider, PullRequestRef,
} from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId,
} from '@asep/contracts';

/** Seed a REAL bare mirror with a base commit; return { mirror, baseSha }. */
export async function seedMirror(dir: string): Promise<{ mirror: string; baseSha: string }> {
  const upstream = join(dir, 'upstream');
  await mkdir(upstream, { recursive: true });
  await runGit(['-C', upstream, 'init', '-q', '-b', 'main']);
  await writeFile(join(upstream, 'README.md'), '# seed\n');
  await runGit(['-C', upstream, 'add', '-A']);
  await runGit(['-C', upstream, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com',
    'commit', '-m', 'seed']);
  const baseSha = (await runGit(['-C', upstream, 'rev-parse', 'HEAD'])).stdout.trim();
  const mirror = join(dir, 'mirror.git');
  await runGit(['clone', '--bare', '-q', upstream, mirror]);
  return { mirror, baseSha };
}

/**
 * Create the bare repository the LocalBareForgeProvider pushes into.
 *
 * Lives here rather than in the composition root because it is a `git init`
 * invocation, and a composition root that spawns git is doing adapter work
 * (B2/B5, disp. P2-FINAL-MED-004). A real forge pushes to the actual remote, so
 * nothing on the production path needs this.
 */
export async function createBareRemote(path: string): Promise<string> {
  await runGit(['init', '--bare', '-q', path]);
  return path;
}

/**
 * Fake Claude: genuinely MUTATES the worktree (writes a file), then returns an
 * UNTRUSTED self-report only. The harness derives every real fact afterwards via
 * trusted inspection. The worktree path is discovered lazily so the agent can be
 * constructed before the workspace exists (the workflow creates the workspace).
 */
export class FileWritingAgent implements CodingAgentProvider {
  readonly providerId = 'fake-claude';
  private worktreePath: string | null = null;
  setWorktree(path: string): void { this.worktreePath = path; }
  async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
    if (this.worktreePath === null) throw new Error('worktree path not wired');
    await writeFile(join(this.worktreePath, 'feature.txt'), 'implemented by the agent\n');
    return {
      status: 'AGENT_DONE',
      summary: `wrote feature.txt for ${req.workOrderRef.artifactId}`,
      knownLimitations: [],
      providerSessionId: `fake-session-${req.attemptId}`,
      usage: { inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1 },
      eventArtifactRefs: [],
    };
  }
}

/**
 * Fake GitHub: a REAL `git push` to a local bare remote (pushing the exact
 * commit SHA to the safe ASEP-namespaced ref — a detached worktree has no local
 * branch to push) + an idempotent PR upsert. NO merge capability exists on the
 * port, so a merge is unrepresentable.
 *
 * The PRs live NEXT TO the bare remote (a JSON file inside it), not in this
 * object's memory. A forge is outside the harness: a PR it opened survives the
 * harness process dying, and a crash-recovery proof is only honest if the
 * successor process sees what its predecessor really left behind.
 *
 * Like the GitHub adapter, a push is compare-and-set (a real
 * `--force-with-lease` the bare remote enforces), an upsert opens the PR on
 * the base it is given and writes exactly the title and body it is given, and
 * a PR read closed, merged (`closePullRequest`) or retargeted
 * (`retargetPullRequest`) is not written by an upsert; an update by number
 * writes that PR's title and body only, in whatever state it is. Nothing ever
 * reopens or retargets a PR.
 */
export interface LocalPullRequest extends PullRequestRef {
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
}

export class LocalBareForgeProvider implements ForgeProvider {
  pushes = 0;
  private worktreePath: string | null = null;
  constructor(private readonly remoteBarePath: string) {}
  setWorktree(path: string): void { this.worktreePath = path; }

  private get prFile(): string {
    return join(this.remoteBarePath, 'asep-pull-requests.json');
  }

  private async readPrs(): Promise<LocalPullRequest[]> {
    try {
      return JSON.parse(await readFile(this.prFile, 'utf8')) as LocalPullRequest[];
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writePrs(prs: readonly LocalPullRequest[]): Promise<void> {
    const tmp = `${this.prFile}.tmp`;
    await writeFile(tmp, JSON.stringify(prs));
    await rename(tmp, this.prFile);
  }

  /** Every PR the forge holds, in creation order. */
  async listPullRequests(): Promise<readonly LocalPullRequest[]> {
    return this.readPrs();
  }

  /** What a human does on the forge: close the head branch's PR, or merge it. */
  async closePullRequest(headBranch: string, opts: { readonly merged: boolean }): Promise<void> {
    const prs = await this.readPrs();
    if (!prs.some((p) => p.headBranch === headBranch)) throw new Error(`no pull request for ${headBranch}`);
    await this.writePrs(prs.map((p) => (p.headBranch === headBranch
      ? { ...p, state: 'closed' as const, merged: opts.merged } : p)));
  }

  /** What a human does on the forge: move the head branch's PR to another base. */
  async retargetPullRequest(headBranch: string, base: string): Promise<void> {
    const prs = await this.readPrs();
    if (!prs.some((p) => p.headBranch === headBranch)) throw new Error(`no pull request for ${headBranch}`);
    await this.writePrs(prs.map((p) => (p.headBranch === headBranch ? { ...p, baseBranch: base } : p)));
  }

  // Compare-and-set, as the port requires: the remote takes the commit only
  // while the branch holds the expected value (absent for null).
  async pushBranch(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha: string | null;
  }): Promise<void> {
    if (this.worktreePath === null) throw new Error('worktree path not wired');
    // Validate through the same non-bypassable ref-safety policy the real
    // adapter uses — a protected/malformed target is unrepresentable.
    const safe = safeCommitRefspecFor(input.commitSha, input.branch);
    await runGit(['-C', this.worktreePath, 'push', pushLeaseFor(safe.branch, input.expectedRemoteSha),
      this.remoteBarePath, safe.refspec]);
    this.pushes++;
  }

  async upsertPullRequest(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const prs = await this.readPrs();
    const at = prs.findIndex((p) => p.headBranch === input.headBranch);
    if (at >= 0) {
      // Idempotent: the one PR for the head branch is updated, never duplicated
      // — and not written once read closed or on another base.
      const existing = prs[at]!;
      if (existing.state !== 'open' || existing.baseBranch !== input.base) return refOf(existing);
      const updated: LocalPullRequest = { ...existing, title: input.title, body: input.body };
      await this.writePrs(prs.map((p, i) => (i === at ? updated : p)));
      return refOf(updated);
    }
    const number = prs.length + 1;
    const pr: LocalPullRequest = {
      number,
      url: `https://local.forge/pr/${number}`,
      headBranch: input.headBranch,
      baseBranch: input.base,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
    };
    await this.writePrs([...prs, pr]);
    return refOf(pr);
  }

  // The title and body of the PR numbered `number`, as GitHub's update by
  // number writes them: that PR only, whatever state a human left it in. An
  // unknown number is an error, never a create.
  async updatePullRequestContent(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    number: number;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const prs = await this.readPrs();
    const at = prs.findIndex((p) => p.number === input.number);
    if (at < 0) throw new Error(`no pull request #${input.number}`);
    const updated: LocalPullRequest = { ...prs[at]!, title: input.title, body: input.body };
    await this.writePrs(prs.map((p, i) => (i === at ? updated : p)));
    return refOf(updated);
  }

  // --- crash-recovery reconciliation (HIGH-006) ------------------------------
  // A REAL `ls-remote` against the bare remote: the resume asks what the remote
  // actually holds instead of blindly re-pushing.
  async resolveRef(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
  }): Promise<string | null> {
    const r = await runGit(
      ['ls-remote', this.remoteBarePath, `refs/heads/${input.branch}`],
      { allowNonZero: true },
    );
    const line = r.stdout.split('\n').find((l) => l.trim() !== '');
    if (!line) return null;
    const sha = line.split(/\s+/)[0];
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  // The PR, its title, body and state, and the commit its head branch points
  // at on the remote NOW, like a forge that reports a PR's live state.
  async findPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
  }): Promise<PullRequestRef | null> {
    const pr = (await this.readPrs()).find((p) => p.headBranch === input.headBranch);
    if (!pr) return null;
    const headSha = await this.resolveRef(scope, {
      repositoryBindingId: input.repositoryBindingId, branch: input.headBranch,
    });
    const shown = { ...refOf(pr), title: pr.title, body: pr.body };
    return headSha === null ? shown : { ...shown, headSha };
  }
}

function refOf(pr: LocalPullRequest): PullRequestRef {
  return {
    number: pr.number, url: pr.url, headBranch: pr.headBranch, baseBranch: pr.baseBranch,
    state: pr.state, merged: pr.merged,
  };
}
