// Unified diff reader for git diffs: per file, the added and removed lines with their
// line numbers and the hunk ranges. Malformed hunks throw; a diff that cannot be read
// is never treated as clean.

export interface DiffLine {
  /** Post-image line number for added lines, pre-image line number for removed lines. */
  readonly line: number;
  readonly text: string;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface DiffFileChange {
  /** Post-image path (pre-image path for a deletion). */
  readonly path: string;
  /** Pre-image path when it differs from `path`: the source of a rename or a copy; null otherwise. */
  readonly oldPath: string | null;
  /** `C`: a copy, reported only when git detects copies. */
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C';
  readonly binary: boolean;
  readonly added: readonly DiffLine[];
  readonly removed: readonly DiffLine[];
  readonly hunks: readonly DiffHunk[];
}

export class DiffParseError extends Error {
  constructor(message: string) {
    super(`diff: ${message}`);
    this.name = 'DiffParseError';
  }
}

/** Undo git's C-style path quoting ("a/caf\303\251.ts"). */
function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"') || raw.length < 2) throw new DiffParseError(`bad quoted path ${raw}`);
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else {
      throw new DiffParseError(`bad escape in ${raw}`);
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}

/** `a/x` → `x`; `/dev/null` → null. */
function sidePath(raw: string, prefix: 'a/' | 'b/'): string | null {
  const path = unquote(raw.trim());
  if (path === '/dev/null') return null;
  if (!path.startsWith(prefix)) throw new DiffParseError(`expected ${prefix} path, got ${path}`);
  return path.slice(prefix.length);
}

/** Paths from `diff --git a/X b/Y` when they are unambiguous. */
function headerPaths(rest: string): { a: string; b: string } | null {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(rest);
    if (m === null) return null;
    return { a: sidePath(m[1]!, 'a/')!, b: sidePath(m[2]!, 'b/')! };
  }
  // Unquoted: identical halves `a/P b/P` are unambiguous even with spaces.
  if (rest.startsWith('a/') && (rest.length - 5) % 2 === 0) {
    const length = (rest.length - 5) / 2;
    const p = rest.slice(2, 2 + length);
    if (rest === `a/${p} b/${p}`) return { a: p, b: p };
  }
  const m = /^a\/(\S+) b\/(\S+)$/.exec(rest);
  return m === null ? null : { a: m[1]!, b: m[2]! };
}

interface Building {
  path: string | null;
  oldPath: string | null;
  aPath: string | null;
  bPath: string | null;
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  binary: boolean;
  added: DiffLine[];
  removed: DiffLine[];
  hunks: DiffHunk[];
}

/** Parse a git unified diff. Throws DiffParseError on anything it cannot account for. */
export function parseUnifiedDiff(text: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  let current: Building | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const finish = (): void => {
    if (current === null) return;
    if (oldLeft !== 0 || newLeft !== 0) throw new DiffParseError(`hunk of ${current.path ?? '?'} ends early`);
    const path = current.status === 'D' ? (current.aPath ?? current.path) : (current.bPath ?? current.path);
    if (path === null || path === '') throw new DiffParseError('file without a path');
    // Whatever the headers call it, a pre-image path other than the post-image path is kept.
    const before = current.status === 'R' || current.status === 'C' ? current.oldPath : current.aPath;
    files.push({
      path,
      oldPath: current.status === 'A' || current.status === 'D' || before === null || before === path ? null : before,
      status: current.status,
      binary: current.binary,
      added: current.added,
      removed: current.removed,
      hunks: current.hunks,
    });
    current = null;
  };

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (current !== null && (oldLeft > 0 || newLeft > 0)) {
      const tag = line[0];
      const body = line.slice(1);
      if (tag === '+') {
        if (newLeft === 0) throw new DiffParseError(`extra added line in ${current.path}`);
        current.added.push({ line: newLine, text: body });
        newLine += 1;
        newLeft -= 1;
      } else if (tag === '-') {
        if (oldLeft === 0) throw new DiffParseError(`extra removed line in ${current.path}`);
        current.removed.push({ line: oldLine, text: body });
        oldLine += 1;
        oldLeft -= 1;
      } else if (tag === ' ' || line === '') {
        if (oldLeft === 0 || newLeft === 0) throw new DiffParseError(`extra context line in ${current.path}`);
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else if (tag === '\\') {
        // "\ No newline at end of file"
      } else {
        throw new DiffParseError(`unexpected line inside a hunk of ${current.path}`);
      }
      continue;
    }

    if (line.startsWith('diff --git ')) {
      finish();
      const paths = headerPaths(line.slice('diff --git '.length));
      current = {
        path: paths?.b ?? null,
        oldPath: paths?.a ?? null,
        aPath: paths?.a ?? null,
        bPath: paths?.b ?? null,
        status: 'M',
        binary: false,
        added: [],
        removed: [],
        hunks: [],
      };
      continue;
    }
    if (current === null) {
      if (line.trim() === '') continue;
      throw new DiffParseError('content before the first file header');
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new DiffParseError(`bad hunk header in ${current.path}`);
      const hunk: DiffHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      newLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      continue;
    }
    if (current.hunks.length > 0) {
      if (line.startsWith('\\')) continue;
      throw new DiffParseError(`unexpected line after the hunks of ${current.path}`);
    }
    // Extended header lines.
    if (line.startsWith('new file mode')) current.status = 'A';
    else if (line.startsWith('deleted file mode')) current.status = 'D';
    else if (line.startsWith('rename from ')) {
      current.status = 'R';
      current.oldPath = unquote(line.slice('rename from '.length));
      current.aPath = current.oldPath;
    } else if (line.startsWith('rename to ')) {
      current.status = 'R';
      current.path = unquote(line.slice('rename to '.length));
      current.bPath = current.path;
    } else if (line.startsWith('copy from ')) {
      current.status = 'C';
      current.oldPath = unquote(line.slice('copy from '.length));
      current.aPath = current.oldPath;
    } else if (line.startsWith('copy to ')) {
      current.status = 'C';
      current.path = unquote(line.slice('copy to '.length));
      current.bPath = current.path;
    } else if (line.startsWith('--- ')) {
      current.aPath = sidePath(line.slice(4), 'a/') ?? current.aPath;
      if (line.slice(4).trim() === '/dev/null') current.status = 'A';
    } else if (line.startsWith('+++ ')) {
      const b = sidePath(line.slice(4), 'b/');
      if (b === null) current.status = 'D';
      else current.bPath = b;
    } else if (line.startsWith('Binary files ')) {
      current.binary = true;
    }
    // Other extended headers (index, mode, similarity) carry no content.
  }
  finish();
  return files;
}
