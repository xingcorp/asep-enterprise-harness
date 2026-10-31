// Self-history defect corpus: provenance collection, not freezing.
//
// Collects every labelled defect instance of Phase 1 and Phase 2 from this repository's
// own review documents and git history: the finding id and the document line that labels
// it, the reviewed and base SHAs and where each came from, reachability, fix commits, whether
// the item depends on the controller's private bundle, the next review cycle's confirmation,
// the cited locations, and content-addressed excerpts of the cited files at the reviewed and
// post-fix trees. It records only provenance-level exclusions (plan-defect,
// reviewed-tree-unknown, excerpt-unpublishable). The freeze rules, the manifest and
// corpusSha256 are freeze.ts's (docs/implementation/phases/phase-04-plan.md §7.5, §7.8;
// data model §7.1).
//
// Regenerate the committed data from the repository root:
//
//   pnpm exec tsx evals/review-corpus/collect.ts --write
//
// The collector reads git and the local object store, and the review documents at one fixed
// commit (CORPUS_SOURCE_COMMIT), never their working-tree copies. It never
// creates a ref, never reads the controller's bundle, and never prints excerpt content: the
// publication gates run over candidate excerpts in a temporary repository and only the
// names of failing excerpts are kept. A gate or a git command that does not complete within
// its documented exit codes aborts the whole collection before anything is written.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CORPUS_DIR = 'evals/review-corpus/self-history';
export const ITEMS_DIR = `${CORPUS_DIR}/items`;
export const BLOBS_DIR = `${CORPUS_DIR}/blobs`;

const PHASES = 'docs/implementation/phases';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type LabelStatus = 'RESOLVED' | 'PARTIAL' | 'REGRESSED' | 'OPEN';
export type ReviewKind = 'final' | 'rereview' | 'self-found' | 'plan';
export type ShaSource = 'recorded-in-review' | 'derived' | 'inferred-parent-of-fix' | 'unknown';
/**
 * `private-bundle-only`: present only in history the rewrite removed. The local object store
 * holds it, a clean public clone does not, and the controller's private bundle does.
 */
export type Reachability = 'reachable' | 'private-bundle-only' | 'unavailable';
export type ExclusionReason = 'plan-defect' | 'reviewed-tree-unknown' | 'excerpt-unpublishable';

/** The exclusions collection may record, in the order they apply (plan §7.8 rules 1–3). */
export const PROVENANCE_EXCLUSIONS: readonly ExclusionReason[] = ['plan-defect', 'reviewed-tree-unknown', 'excerpt-unpublishable'];

/**
 * The repository gates an excerpt must pass to be committed: four repository scripts, and the
 * path-leak scan of `scripts/check-publication.sh`, with its pattern list, run on the excerpts
 * alone. They never replace the full publication gate, which still runs before any public push.
 */
export const PUBLICATION_GATES = ['format-check', 'secret-scan', 'pii-scan', 'large-file-scan', 'path-leak-scan'] as const;
export type PublicationGate = (typeof PUBLICATION_GATES)[number];

export interface CorpusLocation {
  readonly file: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

export interface CorpusExcerpt {
  readonly side: 'reviewed' | 'post-fix';
  readonly path: string;
  readonly sha256: string;
}

export interface FixCommit {
  readonly sha: string;
  readonly reachability: Exclude<Reachability, 'unavailable'>;
}

export interface WithheldExcerpt {
  readonly side: 'reviewed' | 'post-fix';
  readonly path: string;
  readonly gates: readonly PublicationGate[];
}

export interface CorpusItem {
  readonly id: string;
  readonly findingId: string;
  readonly phase: 1 | 2;
  readonly cycle: number;
  readonly reviewKind: ReviewKind;
  readonly instanceKind: 'first-occurrence' | 'residual';
  /** The status a residual instance carries in its own cycle's document; null for a first occurrence. */
  readonly labelStatus: LabelStatus | null;
  readonly severity: Severity | null;
  readonly reviewedSha: string | null;
  readonly reviewedShaSource: ShaSource;
  readonly baseSha: string | null;
  readonly baseShaSource: 'phase-plan' | null;
  readonly reachability: Reachability;
  /** The next review cycle's reviewed SHA, when that cycle re-reviews this one and its tree is known. */
  readonly postFixSha: string | null;
  readonly fixCommits: readonly FixCommit[];
  /** True when the reviewed, base or post-fix tree, or a fix commit, is private-bundle-only. */
  readonly dependsOnPrivateBundle: boolean;
  readonly locations: readonly CorpusLocation[];
  readonly excerpts: readonly CorpusExcerpt[];
  readonly excerptsWithheld: readonly WithheldExcerpt[];
  readonly provenance: {
    readonly doc: string;
    readonly line: number;
    /** The document line that names the reviewed SHA (recorded) or the fix commit (inferred-parent-of-fix). */
    readonly shaEvidence: { readonly doc: string; readonly line: number } | null;
    readonly excerptSource: 'git' | 'object-store' | null;
    readonly excerptOnly: boolean;
  };
  readonly confirmation: { readonly doc: string; readonly line: number | null; readonly status: LabelStatus | null } | null;
  readonly excluded: { readonly reason: ExclusionReason; readonly detail: string } | null;
}

// --- review cycles --------------------------------------------------------------------------------

type DocFormat = 'yaml-list' | 'log-headings' | 'id-list' | 'status-table' | 'paragraph';

type ReviewedShaRule =
  | { readonly kind: 'recorded'; readonly pattern: RegExp }
  | { readonly kind: 'derived' }
  | { readonly kind: 'inferred-parent-of-fix'; readonly pattern: RegExp }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface CycleSource {
  readonly key: string;
  readonly phase: 1 | 2;
  /** Order within the phase; plan reviews are cycle 0 and take part in no chain. */
  readonly cycle: number;
  readonly reviewKind: ReviewKind;
  readonly doc: string;
  readonly format: DocFormat;
  /** log-headings: the section holding the labels. paragraph: the line that opens the label. */
  readonly start?: RegExp;
  readonly reviewedSha: ReviewedShaRule;
}

const HEAD_VERIFIED = /^\s*head_verified: ([0-9a-f]{40})\s*$/;

export const CYCLES: readonly CycleSource[] = [
  { key: 'p1-plan', phase: 1, cycle: 0, reviewKind: 'plan', doc: `${PHASES}/phase-01-plan-review-codex-v1.md`, format: 'yaml-list', reviewedSha: { kind: 'derived' } },
  {
    key: 'p1-final',
    phase: 1,
    cycle: 1,
    reviewKind: 'final',
    doc: `${PHASES}/phase-01-review-log.md`,
    format: 'log-headings',
    start: /^## Repair cycle 1 /,
    reviewedSha: {
      kind: 'unknown',
      reason:
        'the first final review was never committed and was deleted as stale (phase-02-plan.md §1.1); its labels survive only as the paraphrase in the review log',
    },
  },
  {
    key: 'p1-rereview-2',
    phase: 1,
    cycle: 2,
    reviewKind: 'rereview',
    doc: `${PHASES}/phase-01-final-independent-review-rereview.md`,
    format: 'yaml-list',
    reviewedSha: { kind: 'recorded', pattern: /HEAD=([0-9a-f]{40})/ },
  },
  ...[3, 4, 5, 6].map(
    (cycle): CycleSource => ({
      key: `p1-rereview-${cycle}`,
      phase: 1,
      cycle,
      reviewKind: 'rereview',
      doc: `${PHASES}/phase-01-final-independent-review-rereview${cycle}.yaml`,
      format: 'yaml-list',
      reviewedSha: { kind: 'recorded', pattern: HEAD_VERIFIED },
    }),
  ),
  { key: 'p2-plan', phase: 2, cycle: 0, reviewKind: 'plan', doc: `${PHASES}/phase-02-plan-review-codex-v1.md`, format: 'yaml-list', reviewedSha: { kind: 'derived' } },
  { key: 'p2-final', phase: 2, cycle: 1, reviewKind: 'final', doc: `${PHASES}/phase-02-final-review-codex-v1.md`, format: 'id-list', reviewedSha: { kind: 'derived' } },
  ...[2, 3, 4].map(
    (cycle): CycleSource => ({
      key: `p2-rereview-${cycle}`,
      phase: 2,
      cycle,
      reviewKind: 'rereview',
      doc: `${PHASES}/phase-02-final-rereview-codex-v${cycle}.md`,
      format: 'status-table',
      reviewedSha: { kind: 'derived' },
    }),
  ),
  {
    key: 'p2-rereview-5',
    phase: 2,
    cycle: 5,
    reviewKind: 'rereview',
    doc: `${PHASES}/phase-02-final-rereview-codex-v5.md`,
    format: 'status-table',
    reviewedSha: { kind: 'recorded', pattern: /HEAD quan sát là `([0-9a-f]{7,40})`/ },
  },
  {
    key: 'p2-self-6',
    phase: 2,
    cycle: 6,
    reviewKind: 'self-found',
    doc: `${PHASES}/phase-02-report.md`,
    format: 'paragraph',
    start: /^(P2-CYCLE6-HIGH-001) exposed /,
    reviewedSha: { kind: 'inferred-parent-of-fix', pattern: /^\s*implementation_head_sha: ([0-9a-f]{40})\s*$/ },
  },
];

const PHASE_PLANS: Readonly<Record<1 | 2, string>> = {
  1: `${PHASES}/phase-01-plan.md`,
  2: `${PHASES}/phase-02-plan.md`,
};

// --- labels ---------------------------------------------------------------------------------------

export interface Label {
  readonly findingId: string;
  /** 1-based line of the document that carries the label. */
  readonly line: number;
  readonly kind: 'finding' | 'status';
  readonly status: LabelStatus | null;
  /** A severity the label states explicitly; the id's own token is checked against it. */
  readonly severity: Severity | null;
  readonly text: string;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function fail(message: string): never {
  throw new Error(`review-corpus collect: ${message}`);
}

const SEVERITY_WORDS: Readonly<Record<string, Severity>> = {
  CRIT: 'CRITICAL',
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MED: 'MEDIUM',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

/** The severity named by a finding id's own token (`P2-FINAL-HIGH-003` → HIGH); null when it names none. */
export function severityFromId(findingId: string): Severity | null {
  const m = /-(CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-/.exec(findingId);
  return m === null ? null : SEVERITY_WORDS[m[1]!]!;
}

/** Phase 2 re-review tables cite final-review ids in short form (`HIGH-007`, `MED-NEW-001`). */
export function longFindingId(raw: string): string {
  if (/^P[0-9]+-/.test(raw)) return raw;
  if (/^MED-NEW-[0-9]{3}$/.test(raw)) return `P2-REREVIEW-${raw}`;
  return `P2-FINAL-${raw}`;
}

/** The forms a document or commit subject may use for a finding id. Short forms exist only in Phase 2. */
export function findingIdForms(findingId: string): readonly string[] {
  const short = /^P2-(?:FINAL|REREVIEW)-(.+)$/.exec(findingId);
  return short === null ? [findingId] : [findingId, short[1]!];
}

/** True when `text` names the finding id (or its short form) as a whole token. */
export function namesFinding(text: string, findingId: string): boolean {
  return findingIdForms(findingId).some((form) =>
    new RegExp(`(?<![A-Za-z0-9-])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(text),
  );
}

const STATUS_WORDS: Readonly<Record<string, LabelStatus>> = { true: 'RESOLVED', partial: 'PARTIAL', false: 'OPEN' };

function yamlListLabels(lines: readonly string[]): Label[] {
  const labels: Label[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- id: "?([A-Za-z0-9-]+)"?\s*$/.exec(lines[i]!);
    if (m === null) continue;
    const indent = m[1]!.length;
    let end = i + 1;
    while (end < lines.length && (lines[end]!.trim() === '' || indentOf(lines[end]!) > indent)) end++;
    const block = lines.slice(i, end);
    let parent: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j]!;
      if (line.trim() === '' || indentOf(line) >= indent) continue;
      parent = /^\s*([a-z_]+):\s*$/.exec(line)?.[1] ?? null;
      break;
    }
    const kind = parent === 'findings_status' ? 'status' : 'finding';
    const statusWord = block.map((l) => /^\s*(?:resolved|now_closed): (true|partial|false)\s*$/.exec(l)?.[1]).find((w) => w !== undefined);
    if (kind === 'status' && statusWord === undefined) fail(`status row ${m[2]} at line ${i + 1} has no status`);
    const severityWord = block.map((l) => /^\s*severity: "?(CRITICAL|HIGH|MEDIUM|LOW)"?\s*$/.exec(l)?.[1]).find((w) => w !== undefined);
    labels.push({
      findingId: m[2]!,
      line: i + 1,
      kind,
      status: kind === 'status' ? STATUS_WORDS[statusWord!]! : null,
      severity: severityWord === undefined ? null : SEVERITY_WORDS[severityWord]!,
      text: block.join('\n'),
    });
  }
  return labels;
}

/** Lines from `i` up to the next non-indented, non-blank line. */
function indentedBlock(lines: readonly string[], i: number): string {
  let end = i + 1;
  while (end < lines.length && !/^\S/.test(lines[end]!)) end++;
  return lines.slice(i, end).join('\n');
}

function idListLabels(lines: readonly string[]): Label[] {
  const labels: Label[] = [];
  lines.forEach((line, i) => {
    const m = /^- ID: (P[0-9]+-[A-Z0-9-]+)\s*$/.exec(line);
    if (m === null) return;
    const text = indentedBlock(lines, i);
    const severityWord = /^\s*- Severity: (CRITICAL|HIGH|MEDIUM|LOW)\b/m.exec(text)?.[1];
    labels.push({ findingId: m[1]!, line: i + 1, kind: 'finding', status: null, severity: severityWord === undefined ? null : SEVERITY_WORDS[severityWord]!, text });
  });
  return labels;
}

function statusTableLabels(lines: readonly string[]): Label[] {
  const labels: Label[] = [];
  lines.forEach((line, i) => {
    const row = /^\| ([A-Z0-9-]+) \| (RESOLVED|PARTIAL|REGRESSED) \|/.exec(line);
    if (row !== null) {
      labels.push({ findingId: longFindingId(row[1]!), line: i + 1, kind: 'status', status: row[2] as LabelStatus, severity: null, text: line });
      return;
    }
    const added = /^- `(P[0-9]+-[A-Z0-9-]+)` — /.exec(line);
    if (added !== null) labels.push({ findingId: added[1]!, line: i + 1, kind: 'finding', status: null, severity: null, text: indentedBlock(lines, i) });
  });
  return labels;
}

function logHeadingLabels(lines: readonly string[], start: RegExp): Label[] {
  const from = lines.findIndex((l) => start.test(l));
  if (from < 0) fail(`section ${String(start)} not found`);
  let to = from + 1;
  while (to < lines.length && !/^## /.test(lines[to]!)) to++;
  const labels: Label[] = [];
  for (let i = from + 1; i < to; i++) {
    const m = /^### (P[0-9]+-[A-Z0-9-]+) — /.exec(lines[i]!);
    if (m === null) continue;
    let end = i + 1;
    while (end < to && !/^###? /.test(lines[end]!)) end++;
    labels.push({ findingId: m[1]!, line: i + 1, kind: 'finding', status: null, severity: null, text: lines.slice(i, end).join('\n') });
  }
  return labels;
}

function paragraphLabels(lines: readonly string[], start: RegExp): Label[] {
  const labels: Label[] = [];
  lines.forEach((line, i) => {
    const m = start.exec(line);
    if (m === null) return;
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== '') end++;
    labels.push({ findingId: m[1]!, line: i + 1, kind: 'finding', status: null, severity: null, text: lines.slice(i, end).join('\n') });
  });
  return labels;
}

/** Every label a cycle's document carries, in document order. */
export function cycleLabels(cycle: CycleSource, docText: string): Label[] {
  const lines = docText.split('\n');
  switch (cycle.format) {
    case 'yaml-list':
      return yamlListLabels(lines);
    case 'id-list':
      return idListLabels(lines);
    case 'status-table':
      return statusTableLabels(lines);
    case 'log-headings':
      return logHeadingLabels(lines, cycle.start ?? fail(`${cycle.key} has no section`));
    case 'paragraph':
      return paragraphLabels(lines, cycle.start ?? fail(`${cycle.key} has no label line`));
  }
}

// --- locations ------------------------------------------------------------------------------------

const PATH_TOKEN =
  /(?<![A-Za-z0-9_./@-])((?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_@.-]*\.[A-Za-z0-9]+)(?::([0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*))?/g;

/**
 * Locations a label cites: path tokens, each optionally followed by `:a-b,c` line ranges, kept
 * only when `isFile(path)` holds at the reviewed tree. A file cited with lines drops its
 * line-less mention. The result is de-duplicated and sorted by file, then first line.
 */
export function extractLocations(text: string, isFile: (path: string) => boolean): CorpusLocation[] {
  const found = new Map<string, CorpusLocation>();
  for (const m of text.matchAll(PATH_TOKEN)) {
    const file = m[1]!;
    if (!isFile(file)) continue;
    const ranges = m[2] === undefined ? [null] : m[2].split(',');
    for (const range of ranges) {
      let location: CorpusLocation;
      if (range === null) {
        location = { file, lineStart: null, lineEnd: null };
      } else {
        const [a, b] = range.split('-').map(Number) as [number, number | undefined];
        location = { file, lineStart: Math.min(a, b ?? a), lineEnd: Math.max(a, b ?? a) };
      }
      found.set(`${location.file}\n${location.lineStart}\n${location.lineEnd}`, location);
    }
  }
  const withLines = new Set([...found.values()].filter((l) => l.lineStart !== null).map((l) => l.file));
  return [...found.values()]
    .filter((l) => l.lineStart !== null || !withLines.has(l.file))
    .sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : (x.lineStart ?? 0) - (y.lineStart ?? 0)));
}

// --- git ------------------------------------------------------------------------------------------

/** One git invocation's outcome. */
export interface GitResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
  readonly stdout: Buffer;
}

export type GitExec = (args: readonly string[], cwd: string) => GitResult;

const execGit: GitExec = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, signal: r.signal, error: r.error ?? null, stdout: r.stdout ?? Buffer.alloc(0) };
};

/**
 * Read-only access to the repository and its local object store. Only an existence probe's own
 * non-zero status means "not there"; a spawn error, a signal, or any other failing command
 * aborts, so a broken git is never read as a missing object.
 */
export class GitReader {
  private readonly memo = new Map<string, Buffer | null>();

  constructor(
    readonly root: string,
    private readonly exec: GitExec = execGit,
  ) {}

  private spawn(args: readonly string[]): GitResult {
    const r = this.exec(args, this.root);
    if (r.error !== null) fail(`git ${args[0]} could not run: ${r.error.message}`);
    if (r.signal !== null) fail(`git ${args[0]} was killed by ${r.signal}`);
    return r;
  }

  /** stdout of a command that succeeds, or null when it exits non-zero (an existence probe). */
  private probe(args: readonly string[]): Buffer | null {
    const key = args.join('\0');
    if (this.memo.has(key)) return this.memo.get(key)!;
    const r = this.spawn(args);
    const out = r.status === 0 ? r.stdout : null;
    this.memo.set(key, out);
    return out;
  }

  /** stdout of a query that must succeed. */
  private text(args: readonly string[]): string {
    const out = this.probe(args);
    if (out === null) fail(`git ${args[0]} failed`);
    return out.toString('utf8');
  }

  /** The full SHA of a commit present in the object store, or null. */
  commit(ref: string): string | null {
    return this.probe(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.toString('utf8').trim() || null;
  }

  parent(sha: string): string | null {
    return this.commit(`${sha}^1`);
  }

  /** The bytes of `path` at `sha`, or null when it is not a file there. */
  blob(sha: string, path: string): Uint8Array | null {
    const bytes = this.probe(['cat-file', 'blob', `${sha}:${path}`]);
    return bytes === null ? null : new Uint8Array(bytes);
  }

  /** Reachable from HEAD or an advertised ref (branches, remote branches, tags). */
  reachable(sha: string): boolean {
    if (this.isAncestor(sha, 'HEAD')) return true;
    const refs = this.text(['for-each-ref', `--contains=${sha}`, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    return refs.trim() !== '';
  }

  reachability(sha: string | null): Reachability {
    if (sha === null || this.commit(sha) === null) return 'unavailable';
    return this.reachable(sha) ? 'reachable' : 'private-bundle-only';
  }

  /** The oldest commit on the current history that added `path`. */
  addedBy(path: string): string | null {
    const lines = this.text(['log', '--diff-filter=A', '--format=%H', '--', path]).trim().split('\n').filter(Boolean);
    return lines.at(-1) ?? null;
  }

  filesAddedBy(commit: string): readonly string[] {
    return this.text(['show', '--diff-filter=A', '--name-only', '--format=', commit]).trim().split('\n').filter(Boolean);
  }

  subject(sha: string): string {
    return this.text(['log', '-1', '--format=%s', sha]).replace(/\n$/, '');
  }

  /** Exit 0 is yes and 1 is no; anything else aborts. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const { status } = this.spawn(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (status === 0) return true;
    if (status === 1) return false;
    return fail(`git merge-base --is-ancestor exited ${status}`);
  }

  /** Commits reachable from `to` and not from `from`, oldest first, with author date and subject. */
  commitsBetween(from: string, to: string): readonly { readonly sha: string; readonly key: string; readonly subject: string }[] {
    const out = this.text(['log', '--reverse', '--format=%H%x09%aI%x09%s', `${from}..${to}`]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...subject] = line.split('\t');
        return { sha: sha!, key: `${date}\t${subject.join('\t')}`, subject: subject.join('\t') };
      });
  }

  /** Author date and subject of every commit in `sha`'s history, to recognise rewritten copies. */
  historyKeys(sha: string): ReadonlySet<string> {
    const out = this.text(['log', '--format=%aI%x09%s', sha]);
    return new Set(out.split('\n').filter(Boolean));
  }

  /** The bytes of `git diff <flags> from to` over every file; the command must succeed. */
  diff(flags: readonly string[], from: string, to: string): Uint8Array {
    const out = this.probe(['diff', ...flags, from, to]);
    if (out === null) fail(`git diff ${from.slice(0, 7)} ${to.slice(0, 7)} failed`);
    return new Uint8Array(out);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The commit every corpus source document is read at: the tree the corpus was collected from. A source is
 * content-addressed, so it needs one fixed read. A living document, such as the phase report, is rewritten after
 * the review it records; a review document reads the same here as in any later tree.
 */
export const CORPUS_SOURCE_COMMIT = '00a68895d205122767167942326e2e0466571059';

/** The text of a corpus source document at CORPUS_SOURCE_COMMIT; never the working tree's copy. */
export function sourceDocument(git: GitReader, doc: string): string {
  const bytes = git.blob(CORPUS_SOURCE_COMMIT, doc) ?? fail(`${doc} is not a file at ${CORPUS_SOURCE_COMMIT.slice(0, 7)}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** B_c: the first `BASE_SHA:` line of the phase plan at the reviewed tree. */
export function baseShaAt(git: GitReader, phase: 1 | 2, reviewedSha: string): string | null {
  const plan = git.blob(reviewedSha, PHASE_PLANS[phase]);
  if (plan === null) return null;
  return /^BASE_SHA:\s+([0-9a-f]{40})\b/m.exec(new TextDecoder().decode(plan))?.[1] ?? null;
}

// --- reviewed SHAs ----------------------------------------------------------------------------

export interface ResolvedCycle {
  readonly source: CycleSource;
  readonly reviewedSha: string | null;
  readonly reviewedShaSource: ShaSource;
  readonly shaEvidence: { readonly doc: string; readonly line: number } | null;
  readonly unknownReason: string | null;
}

function lineMatching(docText: string, pattern: RegExp): { readonly line: number; readonly value: string } | null {
  const lines = docText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = pattern.exec(lines[i]!);
    if (m !== null) return { line: i + 1, value: m[1]! };
  }
  return null;
}

/**
 * The reviewed SHA of a cycle: named by its document (recorded), the parent of the commit that
 * added the document (derived), or the parent of the fix commit the document names
 * (inferred-parent-of-fix). A derived SHA is unknown when the adding commit also added a later
 * cycle's document of the same phase: the parent then postdates that later review.
 */
export function resolveCycle(git: GitReader, source: CycleSource): ResolvedCycle {
  const unknown = (reason: string): ResolvedCycle => ({ source, reviewedSha: null, reviewedShaSource: 'unknown', shaEvidence: null, unknownReason: reason });
  const rule = source.reviewedSha;
  if (rule.kind === 'unknown') return unknown(rule.reason);
  const docText = sourceDocument(git, source.doc);
  if (rule.kind === 'recorded' || rule.kind === 'inferred-parent-of-fix') {
    const hit = lineMatching(docText, rule.pattern) ?? fail(`${source.key}: the document names no SHA`);
    const named = git.commit(hit.value) ?? fail(`${source.key}: ${hit.value} is not in the object store`);
    const reviewedSha = rule.kind === 'recorded' ? named : (git.parent(named) ?? fail(`${source.key}: ${named} has no parent`));
    return {
      source,
      reviewedSha,
      reviewedShaSource: rule.kind === 'recorded' ? 'recorded-in-review' : 'inferred-parent-of-fix',
      shaEvidence: { doc: source.doc, line: hit.line },
      unknownReason: null,
    };
  }
  const added = git.addedBy(source.doc) ?? fail(`${source.key}: no commit adds ${source.doc}`);
  const later = CYCLES.filter((c) => c.phase === source.phase && c.cycle > source.cycle && c.cycle > 0).map((c) => c.doc);
  const sharing = git.filesAddedBy(added).filter((f) => later.includes(f));
  if (sharing.length > 0) {
    return unknown(`${source.doc} was added by ${added.slice(0, 7)} together with ${sharing.join(', ')}, a later cycle's document`);
  }
  return { source, reviewedSha: git.parent(added) ?? fail(`${added} has no parent`), reviewedShaSource: 'derived', shaEvidence: null, unknownReason: null };
}

// --- publication gates ------------------------------------------------------------------------

export const GATE_SCRIPTS = ['scripts/format-check.sh', 'scripts/secret-scan.sh', 'scripts/pii-scan.sh', 'scripts/large-file-scan.sh', 'scripts/lib/secret-patterns.sh'];

/** One gate invocation's outcome; `output` is stdout and stderr, inspected for excerpt names only and never printed. */
export interface GateRun {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
  readonly output: string;
}

export type GateRunner = (command: string, args: readonly string[], cwd: string) => GateRun;

export const runGateProcess: GateRunner = (command, args, cwd) => {
  const r = spawnSync(command, args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return {
    status: r.status,
    signal: r.signal,
    error: r.error ?? null,
    output: `${r.stdout?.toString('utf8') ?? ''}\n${r.stderr?.toString('utf8') ?? ''}`,
  };
};

/** The path-leak pattern list, shared with `scripts/check-publication.sh` so the two cannot diverge. */
export const LEAK_PATTERNS_FILE = 'scripts/lib/publication-leak-patterns.txt';

/**
 * The patterns of the path-leak list, read the way `scripts/check-publication.sh` reads it: one
 * ERE per line; empty lines and lines starting with `#` are ignored; a pattern line that starts
 * or ends with whitespace, or a list without a pattern, is refused.
 */
export function leakPatterns(list: string): string[] {
  const patterns = list.split('\n').flatMap((line, i) => {
    if (line === '' || line.startsWith('#')) return [];
    if (/^[ \t\v\f\r]|[ \t\v\f\r]$/.test(line)) fail(`leak pattern on line ${i + 1} starts or ends with whitespace`);
    return [line];
  });
  if (patterns.length === 0) fail('the leak pattern list has no pattern');
  return patterns;
}

/**
 * Run the repository's publication gates over candidate excerpts, laid out where they would be
 * committed, in a temporary repository where only the excerpts are tracked. Returns the gates
 * each failing excerpt trips. A gate is accepted only on its documented codes: the four scripts
 * exit 0 clean and 1 with findings; the path-leak scan (`grep -lE` with the patterns of
 * `LEAK_PATTERNS_FILE`) exits 1 clean and 0 with findings. A spawn error, a signal, any
 * other code, or a findings code whose output names no excerpt aborts. Gate output is
 * inspected for excerpt names only and is never printed. The temporary repository is created
 * under `scratchParent` and removed whatever the outcome.
 */
export function failingExcerpts(
  root: string,
  candidates: ReadonlyMap<string, Uint8Array>,
  run: GateRunner = runGateProcess,
  scratchParent: string = tmpdir(),
): Map<string, PublicationGate[]> {
  const failing = new Map<string, PublicationGate[]>();
  if (candidates.size === 0) return failing;
  const patterns = leakPatterns(readFileSync(join(root, LEAK_PATTERNS_FILE), 'utf8'));
  const dir = mkdtempSync(join(scratchParent, 'asep-corpus-gates-'));
  try {
    for (const file of GATE_SCRIPTS) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(root, file), join(dir, file));
    }
    mkdirSync(join(dir, BLOBS_DIR), { recursive: true });
    for (const [sha, bytes] of candidates) writeFileSync(join(dir, BLOBS_DIR, sha), bytes);
    const files = [...candidates.keys()].map((sha) => `${BLOBS_DIR}/${sha}`).sort();
    const git = (args: readonly string[]) => spawnSync('git', args, { cwd: dir });
    if (git(['init', '-q']).status !== 0) fail('cannot create the temporary repository');
    // The scripts scan tracked files; only the excerpts are tracked.
    writeFileSync(join(dir, '.git', 'info', 'exclude'), 'scripts/\n');
    if (git(['add', '-A']).status !== 0) fail('cannot stage candidate excerpts');
    const tracked = git(['ls-files']);
    if (tracked.status !== 0 || tracked.stdout.toString('utf8').trim().split('\n').sort().join('\n') !== files.join('\n')) {
      fail('the temporary repository tracks more than the candidate excerpts');
    }

    const script = (name: string) => ({ command: 'bash', args: [`scripts/${name}.sh`], clean: 0, findings: 1 });
    const commands: Readonly<Record<PublicationGate, { command: string; args: readonly string[]; clean: number; findings: number }>> = {
      'format-check': script('format-check'),
      'secret-scan': script('secret-scan'),
      'pii-scan': script('pii-scan'),
      'large-file-scan': script('large-file-scan'),
      'path-leak-scan': { command: 'grep', args: ['-lE', ...patterns.flatMap((p) => ['-e', p]), '--', ...files], clean: 1, findings: 0 },
    };
    for (const gate of PUBLICATION_GATES) {
      const { command, args, clean, findings } = commands[gate];
      const r = run(command, args, dir);
      if (r.error !== null) fail(`publication gate ${gate} could not run: ${r.error.message}`);
      if (r.signal !== null) fail(`publication gate ${gate} was killed by ${r.signal}`);
      if (r.status === clean) continue;
      if (r.status !== findings) {
        fail(`publication gate ${gate} exited ${r.status}, outside its documented codes (${clean} clean, ${findings} findings)`);
      }
      const named = [...candidates.keys()].filter((sha) => r.output.includes(`${BLOBS_DIR}/${sha}`));
      if (named.length === 0) fail(`publication gate ${gate} reported findings but named no excerpt`);
      for (const sha of named) failing.set(sha, [...(failing.get(sha) ?? []), gate]);
    }
    return failing;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- collection -------------------------------------------------------------------------------

export interface CollectedCorpus {
  readonly items: readonly CorpusItem[];
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

interface Draft {
  readonly item: Omit<CorpusItem, 'excerpts' | 'excerptsWithheld' | 'excluded'>;
  readonly excluded: CorpusItem['excluded'];
  readonly wanted: readonly { readonly side: 'reviewed' | 'post-fix'; readonly path: string; readonly bytes: Uint8Array }[];
}

export function itemId(findingId: string, reviewedSha: string | null): string {
  return `${findingId}@${reviewedSha === null ? 'unknown' : reviewedSha.slice(0, 7)}`;
}

/** Collect every labelled instance and the excerpts its cited files need. */
export function collectSelfHistory(root: string, git = new GitReader(root), runGate: GateRunner = runGateProcess): CollectedCorpus {
  const resolved = CYCLES.map((c) => resolveCycle(git, c));
  const labels = new Map(resolved.map((r) => [r.source.key, cycleLabels(r.source, sourceDocument(git, r.source.doc))]));
  const later = (r: ResolvedCycle) =>
    resolved.filter((o) => o.source.phase === r.source.phase && o.source.cycle > r.source.cycle && r.source.cycle > 0).sort((a, b) => a.source.cycle - b.source.cycle);

  const drafts: Draft[] = [];
  for (const cycle of resolved) {
    const { source } = cycle;
    const next = later(cycle)[0] ?? null;
    const reReview = next !== null && next.source.reviewKind === 'rereview' ? next : null;
    const rangeEnd = later(cycle).find((o) => o.reviewedSha !== null)?.reviewedSha ?? null;
    const postFixSha = reReview?.reviewedSha ?? null;
    const reviewedSha = cycle.reviewedSha;
    const reachability = git.reachability(reviewedSha);
    const present = reachability !== 'unavailable' ? reviewedSha : null;
    const baseSha = present === null ? null : baseShaAt(git, source.phase, present);
    const ancestry = present === null ? null : git.historyKeys(present);

    for (const label of labels.get(source.key)!) {
      if (label.kind === 'status' && label.status === 'RESOLVED') continue;
      const fromId = severityFromId(label.findingId);
      if (label.severity !== null && fromId !== null && label.severity !== fromId) {
        fail(`${label.findingId} states ${label.severity} but its id names ${fromId}`);
      }
      const locations = present === null || source.reviewKind === 'plan' ? [] : extractLocations(label.text, (p) => git.blob(present, p) !== null);
      const fixCommits =
        present === null || rangeEnd === null || source.reviewKind === 'plan'
          ? []
          : git
              .commitsBetween(present, rangeEnd)
              .filter((c) => !ancestry!.has(c.key) && namesFinding(c.subject, label.findingId))
              .map((c): FixCommit => ({ sha: c.sha, reachability: git.reachable(c.sha) ? 'reachable' : 'private-bundle-only' }));
      const dependsOnPrivateBundle = [reachability, git.reachability(baseSha), git.reachability(postFixSha), ...fixCommits.map((f) => f.reachability)].includes(
        'private-bundle-only',
      );
      const confirmationLabel = reReview === null ? null : (labels.get(reReview.source.key)!.find((l) => l.kind === 'status' && l.findingId === label.findingId) ?? null);

      let excluded: CorpusItem['excluded'] = null;
      if (source.reviewKind === 'plan') {
        excluded = { reason: 'plan-defect', detail: 'labels a plan review; no code tree was reviewed' };
      } else if (present === null) {
        excluded = { reason: 'reviewed-tree-unknown', detail: cycle.unknownReason ?? `the reviewed tree ${reviewedSha} is in no available source` };
      } else if (baseSha === null || git.commit(baseSha) === null) {
        excluded = { reason: 'reviewed-tree-unknown', detail: `the base tree named by ${PHASE_PLANS[source.phase]} at ${present.slice(0, 7)} is unavailable` };
      }

      const wanted: Draft['wanted'][number][] = [];
      if (excluded === null) {
        const files = [...new Set(locations.map((l) => l.file))];
        for (const path of files) wanted.push({ side: 'reviewed', path, bytes: git.blob(present!, path)! });
        if (postFixSha !== null && git.commit(postFixSha) !== null) {
          for (const path of files) {
            const bytes = git.blob(postFixSha, path);
            if (bytes !== null) wanted.push({ side: 'post-fix', path, bytes });
          }
        }
      }

      drafts.push({
        item: {
          id: itemId(label.findingId, reviewedSha),
          findingId: label.findingId,
          phase: source.phase,
          cycle: source.cycle,
          reviewKind: source.reviewKind,
          instanceKind: label.kind === 'finding' ? 'first-occurrence' : 'residual',
          labelStatus: label.status,
          severity: label.severity ?? fromId,
          reviewedSha,
          reviewedShaSource: cycle.reviewedShaSource,
          baseSha,
          baseShaSource: baseSha === null ? null : 'phase-plan',
          reachability,
          postFixSha,
          fixCommits,
          dependsOnPrivateBundle,
          locations,
          provenance: {
            doc: source.doc,
            line: label.line,
            shaEvidence: cycle.shaEvidence,
            excerptSource: present === null ? null : reachability === 'reachable' ? 'git' : 'object-store',
            excerptOnly: reachability !== 'reachable',
          },
          confirmation:
            reReview === null ? null : { doc: reReview.source.doc, line: confirmationLabel?.line ?? null, status: confirmationLabel?.status ?? null },
        },
        excluded,
        wanted,
      });
    }
  }

  const candidates = new Map<string, Uint8Array>();
  for (const d of drafts) for (const w of d.wanted) candidates.set(sha256Hex(w.bytes), w.bytes);
  const failing = failingExcerpts(root, candidates, runGate);

  const blobs = new Map<string, Uint8Array>();
  const items = drafts.map((d): CorpusItem => {
    const withheld = d.wanted
      .map((w) => ({ side: w.side, path: w.path, gates: failing.get(sha256Hex(w.bytes)) ?? [] }))
      .filter((w) => w.gates.length > 0);
    const blocked = withheld.filter((w) => w.side === 'reviewed');
    const excluded: CorpusItem['excluded'] =
      d.excluded ??
      (blocked.length > 0
        ? { reason: 'excerpt-unpublishable', detail: blocked.map((w) => `${w.path} fails ${w.gates.join(', ')}`).join('; ') }
        : null);
    const excerpts =
      excluded !== null
        ? []
        : d.wanted.filter((w) => !failing.has(sha256Hex(w.bytes))).map((w) => ({ side: w.side, path: w.path, sha256: sha256Hex(w.bytes) }));
    for (const w of d.wanted) if (excluded === null && !failing.has(sha256Hex(w.bytes))) blobs.set(sha256Hex(w.bytes), w.bytes);
    return { ...d.item, excerpts, excerptsWithheld: excluded === null ? withheld : [], excluded };
  });

  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) fail(`duplicate item id ${item.id}`);
    ids.add(item.id);
  }
  return { items: [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), blobs };
}

/** Field order of the committed item files. */
function serializeItem(item: CorpusItem): string {
  const ordered: CorpusItem = {
    id: item.id,
    findingId: item.findingId,
    phase: item.phase,
    cycle: item.cycle,
    reviewKind: item.reviewKind,
    instanceKind: item.instanceKind,
    labelStatus: item.labelStatus,
    severity: item.severity,
    reviewedSha: item.reviewedSha,
    reviewedShaSource: item.reviewedShaSource,
    baseSha: item.baseSha,
    baseShaSource: item.baseShaSource,
    reachability: item.reachability,
    postFixSha: item.postFixSha,
    fixCommits: item.fixCommits,
    dependsOnPrivateBundle: item.dependsOnPrivateBundle,
    locations: item.locations,
    excerpts: item.excerpts,
    excerptsWithheld: item.excerptsWithheld,
    provenance: item.provenance,
    confirmation: item.confirmation,
    excluded: item.excluded,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Replace the committed items and blobs with a fresh collection. */
export function writeSelfHistory(root: string, corpus: CollectedCorpus): void {
  rmSync(join(root, ITEMS_DIR), { recursive: true, force: true });
  rmSync(join(root, BLOBS_DIR), { recursive: true, force: true });
  mkdirSync(join(root, ITEMS_DIR), { recursive: true });
  mkdirSync(join(root, BLOBS_DIR), { recursive: true });
  for (const item of corpus.items) writeFileSync(join(root, ITEMS_DIR, `${item.id}.json`), serializeItem(item));
  for (const [sha, bytes] of corpus.blobs) writeFileSync(join(root, BLOBS_DIR, sha), bytes);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const corpus = collectSelfHistory(root);
  const counts = new Map<string, number>();
  for (const item of corpus.items) counts.set(item.excluded?.reason ?? 'included', (counts.get(item.excluded?.reason ?? 'included') ?? 0) + 1);
  if (process.argv.includes('--write')) writeSelfHistory(root, corpus);
  console.log(`review-corpus collect: ${corpus.items.length} items (${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}), ${corpus.blobs.size} excerpts`);
}
