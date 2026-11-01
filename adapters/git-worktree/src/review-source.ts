// Trusted review source (ReviewSourceReader). The review packet reads the
// reviewed change from the workspace's object store through this reader, never
// from the agent's report:
//   - diffRange: the exact bytes of `git diff` between two commits with the
//     pinned flags the corpus packets use (no colour, no external diff, no
//     textconv, renames found, three lines of context), stored whole as an
//     artifact. A diff over maxBytes is still stored whole and flagged, never cut.
//   - readBlobs: the post-image (or pre-image) of each named path at one commit.
//     A path is always answered: a file that is binary, larger than the limit, a
//     submodule, absent at that commit or not UTF-8 comes back with its omission
//     reason and no blob, and a path that is not normalizable (traversal, an
//     absolute path, a control character) is refused as `unsafe-path` and never
//     read.
//
// Commits must be full 40-hex SHAs that exist in the workspace; nothing resolves
// a ref name. Every git call goes through the adapter's hardened runner.

import { createHash } from 'node:crypto';
import type { ArtifactRef, TenantScope } from '@asep/contracts';
import type { ArtifactStore, ReviewBlob, ReviewSourceReader, WorkspaceCapability } from '@asep/ports';
import { runGit, runGitBytes } from './git-exec.js';

/** The diff flags every review diff uses (the corpus packets use the same). */
export const REVIEW_DIFF_FLAGS: readonly string[] = Object.freeze([
  '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3',
]);

export class ReviewSourceError extends Error {
  override readonly name = 'ReviewSourceError';
}

export interface GitReviewSourceReaderConfig {
  readonly artifacts: ArtifactStore;
  /** The worktree path of a leased workspace; the composition binds it to the workspace manager. */
  readonly workspacePath: (workspace: WorkspaceCapability) => string;
  readonly timeoutMs?: number;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

type ChangedFile = { readonly path: string; readonly status: 'A' | 'M' | 'D' | 'R'; readonly binary: boolean };

/** Whether a repository-relative path is one the reader may look up. */
export function isNormalizableReviewPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

// git's own binary heuristic: a NUL byte in the first 8000 bytes.
function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export class GitReviewSourceReader implements ReviewSourceReader {
  constructor(private readonly config: GitReviewSourceReaderConfig) {}

  private async requireCommit(cwd: string, sha: string, label: string): Promise<void> {
    if (!FULL_SHA.test(sha)) throw new ReviewSourceError(`${label} ${JSON.stringify(sha)} is not a full 40-hex SHA`);
    const r = await runGit(['cat-file', '-t', sha], { cwd, allowNonZero: true, timeoutMs: this.timeout });
    if (r.exitCode !== 0 || r.stdout.trim() !== 'commit') {
      throw new ReviewSourceError(`${label} ${sha} is not a commit in the workspace`);
    }
  }

  private get timeout(): number {
    return this.config.timeoutMs ?? 60_000;
  }

  private async put(scope: TenantScope, kind: string, content: Uint8Array, contentType: string): Promise<ArtifactRef> {
    return this.config.artifacts.put(scope, { kind, content, sha256: sha256(content), contentType });
  }

  async diffRange(scope: TenantScope, input: {
    readonly workspace: WorkspaceCapability;
    readonly fromSha: string;
    readonly toSha: string;
    readonly maxBytes: number;
  }): Promise<{ readonly diff: ArtifactRef; readonly bytes: number; readonly overLimit: boolean; readonly changedFiles: readonly ChangedFile[] }> {
    if (!Number.isInteger(input.maxBytes) || input.maxBytes < 0) {
      throw new ReviewSourceError(`maxBytes ${input.maxBytes} is not a non-negative integer`);
    }
    const cwd = this.config.workspacePath(input.workspace);
    await this.requireCommit(cwd, input.fromSha, 'fromSha');
    await this.requireCommit(cwd, input.toSha, 'toSha');
    const range = [input.fromSha, input.toSha];
    const diff = await runGitBytes(['diff', ...REVIEW_DIFF_FLAGS, '--end-of-options', ...range], { cwd, timeoutMs: this.timeout });
    const changedFiles = await this.changedFiles(cwd, range);
    const ref = await this.put(scope, 'review-diff', diff, 'text/x-diff');
    return { diff: ref, bytes: diff.length, overLimit: diff.length > input.maxBytes, changedFiles };
  }

  // name-status and numstat over the same flags, NUL-separated so no path is
  // quoted or split.
  private async changedFiles(cwd: string, range: readonly string[]): Promise<readonly ChangedFile[]> {
    const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-z'];
    const status = (await runGitBytes([...common, '--name-status', '--end-of-options', ...range], { cwd, timeoutMs: this.timeout }))
      .toString('utf8').split('\0');
    const numstat = (await runGitBytes([...common, '--numstat', '--end-of-options', ...range], { cwd, timeoutMs: this.timeout }))
      .toString('utf8').split('\0');

    const binary = new Map<string, boolean>();
    for (let i = 0; i < numstat.length; i += 1) {
      const head = numstat[i]!;
      if (head === '') continue;
      const [added, deleted, path] = head.split('\t');
      const isBinary = added === '-' && deleted === '-';
      if (path === '') {
        // a rename: the next two fields are the old and new path
        i += 2;
        binary.set(numstat[i]!, isBinary);
      } else {
        binary.set(path!, isBinary);
      }
    }

    const out: ChangedFile[] = [];
    for (let i = 0; i < status.length; i += 1) {
      const code = status[i]!;
      if (code === '') continue;
      const letter = code[0]!;
      let path: string;
      let kind: ChangedFile['status'];
      if (letter === 'R') {
        i += 2;
        path = status[i]!;
        kind = 'R';
      } else {
        i += 1;
        path = status[i]!;
        if (letter === 'A' || letter === 'M' || letter === 'D') kind = letter;
        else if (letter === 'T') kind = 'M';
        else throw new ReviewSourceError(`git reported change status ${JSON.stringify(code)} for ${JSON.stringify(path)}, which the reader does not map`);
      }
      const isBinary = binary.get(path);
      if (isBinary === undefined) throw new ReviewSourceError(`git's numstat has no entry for ${JSON.stringify(path)}`);
      out.push({ path, status: kind, binary: isBinary });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async readBlobs(scope: TenantScope, input: {
    readonly workspace: WorkspaceCapability;
    readonly sha: string;
    readonly paths: readonly string[];
    readonly maxBytesPerFile: number;
  }): Promise<readonly ReviewBlob[]> {
    if (!Number.isInteger(input.maxBytesPerFile) || input.maxBytesPerFile < 0) {
      throw new ReviewSourceError(`maxBytesPerFile ${input.maxBytesPerFile} is not a non-negative integer`);
    }
    if (!FULL_SHA.test(input.sha)) throw new ReviewSourceError(`sha ${JSON.stringify(input.sha)} is not a full 40-hex SHA`);
    const cwd = this.config.workspacePath(input.workspace);
    await this.requireCommit(cwd, input.sha, 'sha');
    const out: ReviewBlob[] = [];
    for (const path of input.paths) out.push(await this.readBlob(scope, cwd, input.sha, path, input.maxBytesPerFile));
    return out;
  }

  private async readBlob(scope: TenantScope, cwd: string, sha: string, path: string, max: number): Promise<ReviewBlob> {
    const omitted = (reason: NonNullable<ReviewBlob['omittedReason']>, bytes = 0): ReviewBlob =>
      ({ path, blob: null, bytes, lineCount: 0, omittedReason: reason });
    if (!isNormalizableReviewPath(path)) return omitted('unsafe-path');

    // `ls-tree -z <sha> -- <path>` names the entry exactly, or nothing when the
    // path is absent at that commit.
    const entry = (await runGitBytes(['ls-tree', '-z', '--full-tree', sha, '--', path], { cwd, timeoutMs: this.timeout }))
      .toString('utf8').split('\0').filter(Boolean);
    const match = entry.map((e) => /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(e)).find((m) => m?.[4] === path);
    if (!match) return omitted('deleted');
    const [, mode, type, oid] = match;
    if (mode === '160000' || type === 'commit') return omitted('submodule');
    if (type !== 'blob') return omitted('deleted');

    const size = Number((await runGit(['cat-file', '-s', oid!], { cwd, timeoutMs: this.timeout })).stdout.trim());
    if (!Number.isInteger(size) || size < 0) throw new ReviewSourceError(`git reported no size for ${path} at ${sha}`);
    if (size > max) return omitted('too-large', size);
    const bytes = await runGitBytes(['cat-file', 'blob', oid!], { cwd, timeoutMs: this.timeout });
    if (bytes.length !== size) throw new ReviewSourceError(`${path} at ${sha} read ${bytes.length} bytes, git reported ${size}`);
    if (looksBinary(bytes)) return omitted('binary', size);
    const text = decodeUtf8(bytes);
    if (text === null) return omitted('non-utf8', size);
    const blob = await this.put(scope, 'review-post-image', bytes, 'text/plain; charset=utf-8');
    return { path, blob, bytes: size, lineCount: countLines(text), omittedReason: null };
  }
}

