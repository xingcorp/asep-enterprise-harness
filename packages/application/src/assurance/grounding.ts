// Grounding: whether a model finding or resolution claim cites something the reviewer
// was actually shown. An ungrounded finding never blocks; the harness refutes it with
// rule `citation-unresolvable`. Grounding is decided by the harness from the packet and
// the trusted diffs, never by the model.

import { isNormalizedRepoPath } from '@asep/policy';
import type { DiffFileChange } from './diff.js';
import type { ReviewPacket } from './local-types.js';
import type { ModelFindingOutput, PriorFindingClaimOutput } from './prompt.js';

export interface GroundingContext {
  readonly packet: ReviewPacket;
  /** The parsed cumulative diff. */
  readonly diff: readonly DiffFileChange[];
  /** The parsed repair delta on a re-review; null on a fresh review. */
  readonly repairDelta: readonly DiffFileChange[] | null;
  readonly minChars: { readonly evidence: number; readonly requiredFix: number };
}

export type GroundingFailure =
  | 'evidence-too-short'
  | 'required-fix-too-short'
  | 'citation-not-in-packet'
  | 'citation-missing'
  | 'lines-without-file'
  | 'path-not-normalized'
  | 'path-not-in-packet'
  | 'line-range-invalid'
  | 'lines-outside-file'
  | 'content-not-in-packet'
  | 'not-a-resolution';

export interface GroundingResult {
  readonly grounded: boolean;
  readonly reason: GroundingFailure | null;
}

export interface ResolutionGrounding extends GroundingResult {
  /** The cited file is changed by the repair delta. */
  readonly fileInRepairDelta: boolean;
  /**
   * The citation satisfies the changed-line predicate: the cited line is an added line of
   * the repair delta's entry for the cited file, or that entry only deletes lines and every
   * line the prior finding cites is among them. A context line never qualifies.
   */
  readonly changedLine: boolean;
}

/** The location a prior finding cites. */
export interface PriorCitation {
  readonly file?: string | null | undefined;
  readonly lineStart?: number | null | undefined;
  readonly lineEnd?: number | null | undefined;
}

const GROUNDED: GroundingResult = { grounded: true, reason: null };

function refute(reason: GroundingFailure): GroundingResult {
  return { grounded: false, reason };
}

/** Categories that may cite a requirement or check id instead of a file range. */
const CITE_BY_ID = new Set(['SPEC', 'EVIDENCE_INTEGRITY']);

function citableIds(packet: ReviewPacket): Set<string> {
  return new Set([
    ...packet.workOrder.requirementIds,
    ...packet.workOrder.acceptanceCheckIds,
    ...packet.execution.checks.map((c) => c.id),
  ]);
}

function diffEntry(diff: readonly DiffFileChange[] | null, path: string): DiffFileChange | undefined {
  return diff?.find((f) => f.path === path);
}

/** A file range that is inside the post-image, or inside a removed region of the diff. */
function groundRange(ctx: GroundingContext, file: string, lineStart: number | null, lineEnd: number | null): GroundingResult {
  if (!isNormalizedRepoPath(file)) return refute('path-not-normalized');
  const entry = ctx.packet.change.files.find((f) => f.path === file);
  if (entry === undefined) return refute('path-not-in-packet');
  const end = lineEnd ?? lineStart;
  if (lineStart === null || end === null || !Number.isInteger(lineStart) || !Number.isInteger(end) || lineStart < 1 || end < lineStart) {
    return refute('line-range-invalid');
  }
  if (entry.postImage !== null && end <= entry.lineCount) return GROUNDED;
  const removed = diffEntry(ctx.diff, file)?.hunks.some(
    (h) => h.oldLines > 0 && lineStart >= h.oldStart && end <= h.oldStart + h.oldLines - 1,
  );
  if (removed === true) return GROUNDED;
  return refute(entry.postImage === null ? 'content-not-in-packet' : 'lines-outside-file');
}

/** Ground one model finding against the packet. */
export function groundFinding(ctx: GroundingContext, finding: ModelFindingOutput): GroundingResult {
  if (finding.evidence.trim().length < ctx.minChars.evidence) return refute('evidence-too-short');
  if (finding.requiredFix.trim().length < ctx.minChars.requiredFix) return refute('required-fix-too-short');
  if (finding.requirementId !== null && !citableIds(ctx.packet).has(finding.requirementId)) return refute('citation-not-in-packet');
  if (finding.file === null) {
    if (finding.lineStart !== null || finding.lineEnd !== null) return refute('lines-without-file');
    return CITE_BY_ID.has(finding.category) && finding.requirementId !== null ? GROUNDED : refute('citation-missing');
  }
  return groundRange(ctx, finding.file, finding.lineStart, finding.lineEnd);
}

/** The changed-line predicate for one delta entry; see `ResolutionGrounding.changedLine`. */
function isChangedLine(entry: DiffFileChange, file: string, line: number | null, prior: PriorCitation): boolean {
  if (entry.added.length > 0) return line !== null && entry.added.some((l) => l.line === line);
  const start = prior.lineStart ?? null;
  const end = prior.lineEnd ?? start;
  if (prior.file !== file || start === null || end === null || end < start) return false;
  const removed = new Set(entry.removed.map((l) => l.line));
  for (let n = start; n <= end; n += 1) if (!removed.has(n)) return false;
  return true;
}

/** Ground a RESOLVED claim against `prior` and locate its citation in the repair delta. */
export function groundResolution(ctx: GroundingContext, claim: PriorFindingClaimOutput, prior: PriorCitation): ResolutionGrounding {
  const outside = { fileInRepairDelta: false, changedLine: false };
  if (claim.status !== 'RESOLVED') return { ...refute('not-a-resolution'), ...outside };
  if (claim.evidence.trim().length < ctx.minChars.evidence) return { ...refute('evidence-too-short'), ...outside };
  if (claim.resolutionFile === null) return { ...refute('citation-missing'), ...outside };
  const range = groundRange(ctx, claim.resolutionFile, claim.resolutionLine, claim.resolutionLine);
  const entry = diffEntry(ctx.repairDelta, claim.resolutionFile);
  const changedLine = entry !== undefined && isChangedLine(entry, claim.resolutionFile, claim.resolutionLine, prior);
  return { ...range, fileInRepairDelta: entry !== undefined, changedLine: range.grounded && changedLine };
}
