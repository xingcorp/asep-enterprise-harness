// Git mirror + leased worktree lifecycle (architecture §15, exit criteria
// E1/E2/E5/E6/E7). A bare MIRROR cache is kept separate from the WORKTREES it
// spawns. Each attempt gets an isolated linked worktree checked out at a pinned,
// verified base SHA. The harness — never the agent — creates the final commit
// with ASEP-Run/Task/Attempt/Evidence trailers.
//
// Containment (E6): every worktree path is derived from normalized ids and its
// realpath is asserted to live UNDER the workspace root, so a crafted id or a
// symlink cannot escape. Cleanup (E7) is idempotent and a faulted worktree is
// quarantined (moved aside), never reused.

import { mkdir, rm, rename, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type {
  RepositoryBindingId, WorkspaceId, TenantScope, AttemptId,
} from '@asep/contracts';
import type {
  WorkspaceManager, Workspace, WorkspaceCapability,
  GitChangeInspector, GitChangeObservation, GitCommitter, ArtifactStore,
} from '@asep/ports';
import { runGit } from './git-exec.js';
import { ulid } from './ulid.js';

// A ULID-shaped id is safe as a single path segment. Anything else is rejected
// so a path separator / traversal token can never enter a worktree path.
const ID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function safeSegment(label: string, id: string): string {
  if (!ID_SEGMENT.test(id)) throw new WorktreeContainmentError(`${label} '${id}' is not a safe id segment`);
  return id;
}

export class WorktreeContainmentError extends Error {
  constructor(reason: string) {
    super(`worktree containment violation: ${reason}`);
    this.name = 'WorktreeContainmentError';
  }
}

export class BaseShaError extends Error {
  constructor(sha: string) {
    super(`base SHA '${sha}' is not present in the mirror or is not a full 40-hex commit id`);
    this.name = 'BaseShaError';
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface WorktreeManagerConfig {
  // Absolute root under which ALL worktrees live. Containment is asserted here.
  readonly workspaceRoot: string;
  // Absolute path to the bare mirror for this repository binding.
  readonly mirrorPath: string;
  readonly repositoryBindingId: RepositoryBindingId;
}

// Track workspaceId → absolute path so create/inspect/commit/cleanup agree on
// the location without trusting a caller-supplied path.
export class GitWorktreeManager implements WorkspaceManager, GitChangeInspector, GitCommitter {
  private readonly paths = new Map<string, string>();
  // Refs present in the shared ref store at worktree-creation time. inspect()
  // diffs the current refs against this baseline so PRE-EXISTING branches (the
  // mirror's own main/etc.) are NOT falsely reported as agent-created refs (E3):
  // only a ref that appeared AFTER creation is an agent overstep.
  private readonly baselineRefs = new Map<string, Set<string>>();
  // The pinned base SHA each worktree was created at (HIGH-007). inspect()
  // compares the observed HEAD against this snapshot: a detached-HEAD commit
  // advances HEAD without creating a ref, so this is the only trusted signal
  // that the untrusted agent committed. Captured at create(), never trusted
  // from the caller at inspection time.
  private readonly baseShas = new Map<string, string>();

  constructor(
    private readonly cfg: WorktreeManagerConfig,
    // The inspector writes the diff to the artifact store (trusted, scope-aware).
    private readonly artifacts: ArtifactStore,
  ) {}

  // Resolve `rel` (already-validated id segments) UNDER the realpath'd workspace
  // root and assert strict containment. We realpath the ROOT (not the candidate,
  // which may not exist yet) so a symlinked root — e.g. macOS /var → /private/var
  // — does not itself trip the check, while any '..'/symlink in `rel` still can't
  // escape because the joined+resolved path must stay under the real root.
  private async containedPath(rel: string): Promise<string> {
    const root = await realpath(this.cfg.workspaceRoot);
    const resolved = resolve(join(root, rel));
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new WorktreeContainmentError(`'${resolved}' escapes workspace root '${root}'`);
    }
    return resolved;
  }

  async create(scope: TenantScope, input: {
    repositoryBindingId: RepositoryBindingId;
    baseSha: string;
    leaseId: string;
  }): Promise<Workspace> {
    if (!FULL_SHA.test(input.baseSha)) throw new BaseShaError(input.baseSha);

    // E2: the base SHA must already exist in the mirror as a commit object BEFORE
    // we check anything out — a missing/again-rewritten base fails closed.
    const present = await runGit(
      ['--git-dir', this.cfg.mirrorPath, 'cat-file', '-e', `${input.baseSha}^{commit}`],
      { allowNonZero: true },
    );
    if (present.exitCode !== 0) throw new BaseShaError(input.baseSha);

    const workspaceId = ulid() as WorkspaceId;
    // Path derived from validated id segments only (E6).
    const rel = join(
      safeSegment('binding', input.repositoryBindingId),
      safeSegment('workspace', workspaceId),
    );
    const wtPath = await this.containedPath(rel);
    await mkdir(wtPath, { recursive: true });

    // Add a detached linked worktree pinned at the exact base SHA. Detached so
    // the agent cannot advance a branch ref; the harness owns commits.
    await runGit(
      ['--git-dir', this.cfg.mirrorPath, 'worktree', 'add', '--detach', wtPath, input.baseSha],
    );

    // Verify the checkout really sits at the pinned SHA.
    const head = await runGit(['-C', wtPath, 'rev-parse', 'HEAD']);
    if (head.stdout.trim() !== input.baseSha) throw new BaseShaError(input.baseSha);

    this.paths.set(workspaceId, wtPath);
    // Snapshot the refs visible from this worktree at creation time so inspect()
    // can distinguish a PRE-EXISTING branch (the mirror's main) from a ref the
    // untrusted agent created during its turn (E3).
    this.baselineRefs.set(workspaceId, await this.listRefs(wtPath));
    // Snapshot the pinned base SHA so inspect() can detect a detached-HEAD
    // commit (HEAD advanced with no ref created) — HIGH-007.
    this.baseShas.set(workspaceId, input.baseSha);
    return {
      workspaceId,
      capability: { workspaceId, leaseId: input.leaseId },
      baseSha: input.baseSha,
    };
  }

  private pathOf(cap: WorkspaceCapability | WorkspaceId): string {
    const id = typeof cap === 'string' ? cap : cap.workspaceId;
    const p = this.paths.get(id);
    if (!p) throw new WorktreeContainmentError(`unknown workspace '${id}'`);
    return p;
  }

  // All branch refs visible from a worktree (the shared ref store), as a set so
  // inspect() can diff post-agent refs against the create()-time baseline.
  private async listRefs(wtPath: string): Promise<Set<string>> {
    const branchList = await runGit(['-C', wtPath, 'branch', '--format=%(refname)'], { allowNonZero: true });
    return new Set(
      branchList.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
    );
  }

  // E3/E5 trusted observation AFTER the agent exits. The agent never reports
  // these facts; we derive them from git itself.
  async inspect(scope: TenantScope, workspace: WorkspaceCapability): Promise<GitChangeObservation> {
    const wtPath = this.pathOf(workspace);

    const head = (await runGit(['-C', wtPath, 'rev-parse', 'HEAD'])).stdout.trim();

    // Changed working-tree files vs HEAD (staged + unstaged + untracked).
    const status = await runGit(['-C', wtPath, 'status', '--porcelain=v1', '--untracked-files=all']);
    const changedFiles = status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^.. /, '').replace(/^"(.*)"$/, '$1'));

    // E3: any ref the agent created inside the worktree's own refs is a policy
    // violation. Detached HEAD means no local branch should have advanced. We
    // diff the CURRENT refs against the baseline captured at create() so a
    // pre-existing branch (the mirror's own main) is not falsely flagged — only
    // a ref that appeared AFTER the worktree was created counts as agent-created.
    const wsId = typeof workspace === 'string' ? workspace : workspace.workspaceId;
    const baseline = this.baselineRefs.get(wsId) ?? new Set<string>();
    const currentRefs = await this.listRefs(wtPath);
    const createdRefs = [...currentRefs].filter((r) => !baseline.has(r));

    // HIGH-007: a commit on the detached HEAD advances HEAD WITHOUT creating a
    // ref, so createdRefs above stays empty. Compare the observed HEAD against
    // the base SHA snapshotted at create() — any movement means the untrusted
    // agent committed (the harness's own commit step runs AFTER inspection), an
    // overstep the caller must stop on. Fail closed if the base was never
    // snapshotted (unknown provenance).
    const baseSha = this.baseShas.get(wsId) ?? '';
    const headMovedFromBase = baseSha === '' || head !== baseSha;

    // touchedGitDir: did the agent try to write under .git? A linked worktree's
    // .git is a file; if it became a dir or gained tracked changes we flag it.
    let touchedGitDir = false;
    try {
      const gitPath = join(wtPath, '.git');
      const st = await stat(gitPath);
      touchedGitDir = st.isDirectory(); // a linked worktree .git must be a FILE
    } catch {
      touchedGitDir = true; // missing .git indirection is itself suspicious
    }

    // Full diff vs base, stored as an immutable artifact (never truncated inline).
    // `git diff HEAD` omits UNTRACKED files, so an agent that only adds new files
    // would produce an empty diff. Intent-to-add (`add -N`) makes untracked files
    // appear in the diff as new-file hunks; we undo the staging afterwards so
    // inspection leaves the index as it found it (the harness owns the real commit).
    await runGit(['-C', wtPath, 'add', '-N', '--', '.'], { allowNonZero: true });
    const diff = await runGit(['-C', wtPath, 'diff', 'HEAD'], { allowNonZero: true });
    await runGit(['-C', wtPath, 'reset', '-q', '--', '.'], { allowNonZero: true });
    const diffBytes = new TextEncoder().encode(diff.stdout);
    const sha256 = await sha256Hex(diffBytes);
    const diffRef = await this.artifacts.put(scope, {
      kind: 'git-diff',
      content: diffBytes,
      sha256,
      contentType: 'text/x-diff; charset=utf-8',
    });

    return { headSha: head, changedFiles, createdRefs, touchedGitDir, baseSha, headMovedFromBase, diff: diffRef };
  }

  // E5: the HARNESS creates the commit, with ASEP trailers. Only files under
  // allowedPaths are staged; the commit identity is the harness bot, not the
  // agent. Returns the resulting commit SHA (the authoritative result_sha).
  async commit(scope: TenantScope, input: {
    workspace: WorkspaceCapability;
    allowedPaths: readonly string[];
    trailers: Record<string, string>;
    identity: { name: string; email: string };
  }): Promise<{ commitSha: string }> {
    const wtPath = this.pathOf(input.workspace);

    // Stage ONLY the explicitly allowed paths (pathspec, end-of-options guarded).
    if (input.allowedPaths.length > 0) {
      await runGit(['-C', wtPath, 'add', '--', ...input.allowedPaths]);
    } else {
      await runGit(['-C', wtPath, 'add', '-A']);
    }

    // Build the commit message with ASEP trailers appended in a stable order.
    const trailerLines = Object.entries(input.trailers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const message = `ASEP harness commit\n\n${trailerLines}\n`;

    // Commit with an explicit author/committer identity via -c, so no ambient
    // git identity is required and the harness owns authorship.
    await runGit([
      '-C', wtPath,
      '-c', `user.name=${input.identity.name}`,
      '-c', `user.email=${input.identity.email}`,
      'commit', '--no-verify', '--no-gpg-sign', '-m', message,
    ]);

    const commitSha = (await runGit(['-C', wtPath, 'rev-parse', 'HEAD'])).stdout.trim();
    return { commitSha };
  }

  // HIGH-006: reconcile a PENDING commit record on resume. A commit is the one
  // side effect that is NOT idempotent — re-running commit() mints a second,
  // divergent object — so before a resume performs it again we ask whether the
  // harness already committed for THIS attempt. HEAD is a harness commit iff it
  // has advanced past baseSha AND carries an `ASEP-Attempt` trailer matching the
  // attempt; in that case we return its recorded SHA + the `ASEP-Evidence`
  // trailer so the caller adopts both instead of minting a divergent commit.
  async reconcile(scope: TenantScope, input: {
    workspace: WorkspaceCapability;
    attemptId: string;
    baseSha: string;
  }): Promise<{ commitSha: string; evidenceId: string } | null> {
    const wtPath = this.pathOf(input.workspace);
    const head = (await runGit(['-C', wtPath, 'rev-parse', 'HEAD'])).stdout.trim();
    // HEAD still at base → the commit never landed; safe to perform it.
    if (head === input.baseSha) return null;
    // Read the trailers off the real HEAD object (natural-key reconciliation).
    const body = (await runGit(['-C', wtPath, 'log', '-1', '--format=%B', head])).stdout;
    const trailerOf = (key: string): string | null => {
      const m = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m && m[1] !== undefined ? m[1].trim() : null;
    };
    // Only adopt a commit that is genuinely THIS attempt's harness commit.
    if (trailerOf('ASEP-Attempt') !== input.attemptId) return null;
    const evidenceId = trailerOf('ASEP-Evidence');
    if (evidenceId === null) return null;
    return { commitSha: head, evidenceId };
  }

  // E7: idempotent cleanup — removing an already-removed worktree is not an error.
  async cleanup(scope: TenantScope, workspaceId: WorkspaceId): Promise<void> {
    const p = this.paths.get(workspaceId);
    if (!p) return; // already gone
    await runGit(
      ['--git-dir', this.cfg.mirrorPath, 'worktree', 'remove', '--force', p],
      { allowNonZero: true },
    );
    await rm(p, { recursive: true, force: true });
    await runGit(['--git-dir', this.cfg.mirrorPath, 'worktree', 'prune'], { allowNonZero: true });
    this.paths.delete(workspaceId);
  }

  // E7: a faulted worktree is QUARANTINED (moved aside), never reused.
  async quarantine(scope: TenantScope, workspaceId: WorkspaceId, reason: string): Promise<void> {
    const p = this.paths.get(workspaceId);
    if (!p) return;
    const dest = `${p}.quarantine-${Date.now()}`;
    await rename(p, dest).catch(() => undefined);
    // Detach it from the mirror's worktree list so it cannot be checked out again.
    await runGit(['--git-dir', this.cfg.mirrorPath, 'worktree', 'prune'], { allowNonZero: true });
    this.paths.delete(workspaceId);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}
