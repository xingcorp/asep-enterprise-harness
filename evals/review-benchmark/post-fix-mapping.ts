// Post-fix location mapping (docs/implementation/phases/phase-04-plan.md §7.8).
//
// A gold location `(path, s, e)` at the reviewed tree maps to the post-fix tree through the
// cited file's section of the rule-P diff between the two trees: a rename follows the new path;
// a deleted file has no mapped location; a line outside every hunk shifts by the sum of
// `newLines − oldLines` over the hunks that end before it; a line inside a hunk's old range maps
// to that hunk's whole new range; the mapped range spans the mapped `s` and `e`. A hunk that
// only inserts ends at the line it follows; a hunk that only removes maps its old range to the
// line it followed in the new file (at least 1). Pure: the caller passes the section text.

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface GoldLocation {
  readonly file: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

/** One cited file's diff section: its path at the post-fix tree (null when deleted) and the section text, null when unchanged. */
export interface PostFixSection {
  readonly newPath: string | null;
  readonly diff: string | null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunk headers of a diff section, in order. A header that does not parse is refused. */
export function parseHunks(section: string): Hunk[] {
  return section
    .split('\n')
    .filter((line) => line.startsWith('@@'))
    .map((line) => {
      const m = HUNK.exec(line);
      if (m === null) throw new Error(`post-fix mapping: unparseable hunk header: ${line}`);
      return { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]) };
    });
}

/** The new-file range a reviewed line maps to. */
function mapLine(hunks: readonly Hunk[], line: number): readonly [number, number] {
  let shift = 0;
  for (const h of hunks) {
    const end = h.oldLines === 0 ? h.oldStart : h.oldStart + h.oldLines - 1;
    if (h.oldLines > 0 && line >= h.oldStart && line <= end) {
      if (h.newLines === 0) return [Math.max(h.newStart, 1), Math.max(h.newStart, 1)];
      return [h.newStart, h.newStart + h.newLines - 1];
    }
    if (end < line) shift += h.newLines - h.oldLines;
  }
  return [line + shift, line + shift];
}

/** The location at the post-fix tree, or null when the file is gone or its lines cannot be followed. */
export function mapLocation(location: GoldLocation, section: PostFixSection): GoldLocation | null {
  if (section.newPath === null) return null;
  if (location.lineStart === null || location.lineEnd === null) return { file: section.newPath, lineStart: null, lineEnd: null };
  if (section.diff !== null && /^Binary files /m.test(section.diff)) return null;
  const hunks = section.diff === null ? [] : parseHunks(section.diff);
  const [start] = mapLine(hunks, location.lineStart);
  const [, end] = mapLine(hunks, location.lineEnd);
  return { file: section.newPath, lineStart: start, lineEnd: end };
}
