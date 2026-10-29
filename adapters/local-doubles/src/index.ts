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
import { runGit, safeRefspecFor } from '@asep/git-worktree';
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
 */
export class LocalBareForgeProvider implements ForgeProvider {
  pushes = 0;
  private worktreePath: string | null = null;
  constructor(private readonly remoteBarePath: string) {}
  setWorktree(path: string): void { this.worktreePath = path; }

  private get prFile(): string {
    return join(this.remoteBarePath, 'asep-pull-requests.json');
  }

  private async readPrs(): Promise<PullRequestRef[]> {
    try {
      return JSON.parse(await readFile(this.prFile, 'utf8')) as PullRequestRef[];
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writePrs(prs: readonly PullRequestRef[]): Promise<void> {
    const tmp = `${this.prFile}.tmp`;
    await writeFile(tmp, JSON.stringify(prs));
    await rename(tmp, this.prFile);
  }

  /** Every PR the forge holds, in creation order. */
  async listPullRequests(): Promise<readonly PullRequestRef[]> {
    return this.readPrs();
  }

  async pushBranch(_scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    branch: string;
    commitSha: string;
    expectedRemoteSha?: string;
  }): Promise<void> {
    if (this.worktreePath === null) throw new Error('worktree path not wired');
    // Validate through the same non-bypassable ref-safety policy the real
    // adapter uses — a protected/malformed target is unrepresentable.
    const safe = safeRefspecFor(input.branch, input.expectedRemoteSha);
    await runGit(['-C', this.worktreePath, 'push', this.remoteBarePath,
      `${input.commitSha}:refs/heads/${safe.branch}`]);
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
    const existing = prs.find((p) => p.headBranch === input.headBranch);
    if (existing) return existing; // idempotent: no duplicate PR
    const number = prs.length + 1;
    const pr: PullRequestRef = {
      number,
      url: `https://local.forge/pr/${number}`,
      headBranch: input.headBranch,
      baseBranch: input.base,
    };
    await this.writePrs([...prs, pr]);
    return pr;
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

  // The PR plus the commit its head branch points at on the remote NOW, like a
  // forge that reports a PR's live head.
  async findPullRequest(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    headBranch: string;
  }): Promise<PullRequestRef | null> {
    const pr = (await this.readPrs()).find((p) => p.headBranch === input.headBranch);
    if (!pr) return null;
    const headSha = await this.resolveRef(scope, {
      repositoryBindingId: input.repositoryBindingId, branch: input.headBranch,
    });
    return headSha === null ? pr : { ...pr, headSha };
  }
}
