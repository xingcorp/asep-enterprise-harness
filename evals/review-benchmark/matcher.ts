// Deterministic corpus matcher (docs/implementation/phases/phase-04-plan.md §7.8).
//
// Pairs gold items with a reviewer's validated and grounded findings of one (cycle, side, run).
// No model takes part. A location matches when the finding's file equals a gold location's
// path and the ranges are within T = 10 lines; a gold location without lines matches any
// finding in its file; a file-less finding never matches. Strict needs a location match and a
// compatible category (table corpus-categories/v1); lenient needs only the path. Matching is
// one-to-one: candidate pairs are ordered by line distance (0 when the ranges overlap, else the
// gap), then gold item id, then finding fingerprint, with the chunk as the last key only, and
// assigned greedily; a multi-location gold item matches through its nearest location. An
// unmatched finding that had a candidate is a `duplicate`; any other is `unlabelled`, never a
// false positive. Ungrounded findings never match and are listed apart.
//
// A finding's identity is the pair `(chunk, fingerprint)`, pooled over a cycle's chunks; the
// runtime grounding and fingerprint that produce it are bound once the evals package is bound
// to the runtime code.

import type { GoldCategory } from '../review-corpus/freeze.js';

export type FindingCategory = GoldCategory;
export type MatchVariant = 'strict' | 'lenient';

export const MATCH_TOLERANCE = 10;

/** Category table `corpus-categories/v1`: the finding categories compatible with each gold category. */
export const CATEGORY_TABLE: Readonly<Record<GoldCategory, readonly FindingCategory[]>> = {
  CORRECTNESS: ['CORRECTNESS', 'SECURITY'],
  SECURITY: ['SECURITY', 'CORRECTNESS'],
  ARCHITECTURE: ['ARCHITECTURE', 'MAINTAINABILITY', 'SPEC'],
  SPEC: ['SPEC', 'CORRECTNESS', 'ARCHITECTURE'],
  TEST_QUALITY: ['TEST_QUALITY', 'EVIDENCE_INTEGRITY'],
  EVIDENCE_INTEGRITY: ['EVIDENCE_INTEGRITY', 'TEST_QUALITY', 'SPEC'],
  PERFORMANCE: ['PERFORMANCE', 'CORRECTNESS'],
  MAINTAINABILITY: ['MAINTAINABILITY', 'ARCHITECTURE'],
};

export interface GoldLocation {
  readonly file: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

export interface GoldItem {
  readonly id: string;
  readonly goldCategory: GoldCategory;
  readonly locations: readonly GoldLocation[];
}

/** A finding's pooled identity: the chunk that showed it and its fingerprint. */
export interface FindingRef {
  readonly chunk: string;
  readonly fingerprint: string;
}

export interface MatchableFinding extends FindingRef {
  readonly grounded: boolean;
  readonly category: FindingCategory;
  readonly file: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
}

export interface Match extends FindingRef {
  readonly goldId: string;
  readonly distance: number;
}

export interface MatchResult {
  /** In assignment order. */
  readonly matches: readonly Match[];
  readonly duplicate: readonly FindingRef[];
  readonly unlabelled: readonly FindingRef[];
  readonly ungrounded: readonly FindingRef[];
  readonly unmatchedGold: readonly string[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byRef = (a: FindingRef, b: FindingRef): number => byText(a.fingerprint, b.fingerprint) || byText(a.chunk, b.chunk);
const refOf = (f: FindingRef): FindingRef => ({ chunk: f.chunk, fingerprint: f.fingerprint });
/** One key per identity; a JSON pair, so no separator inside a field can join two identities. */
const keyOf = (f: FindingRef): string => JSON.stringify([f.chunk, f.fingerprint]);

/** The line distance of a finding to a gold location, or null when the location does not match. */
function locationDistance(location: GoldLocation, f: MatchableFinding, variant: MatchVariant): number | null {
  if (f.file === null || f.file !== location.file) return null;
  if (location.lineStart === null || location.lineEnd === null) return 0;
  if (f.lineStart === null) return variant === 'lenient' ? 0 : null;
  const [fs, fe] = [f.lineStart, f.lineEnd ?? f.lineStart];
  const [gs, ge] = [location.lineStart, location.lineEnd];
  const gap = fs > ge ? fs - ge : gs > fe ? gs - fe : 0;
  if (variant === 'strict' && !(fs <= ge + MATCH_TOLERANCE && fe >= gs - MATCH_TOLERANCE)) return null;
  return gap;
}

function pairDistance(g: GoldItem, f: MatchableFinding, variant: MatchVariant): number | null {
  if (!f.grounded) return null;
  if (variant === 'strict' && !CATEGORY_TABLE[g.goldCategory].includes(f.category)) return null;
  let best: number | null = null;
  for (const location of g.locations) {
    const d = locationDistance(location, f, variant);
    if (d !== null && (best === null || d < best)) best = d;
  }
  return best;
}

/** Match gold items with findings under one variant. Independent of the order of either list. */
export function matchFindings(gold: readonly GoldItem[], findings: readonly MatchableFinding[], variant: MatchVariant): MatchResult {
  for (const [what, ids] of [
    ['gold item', gold.map((g) => g.id)],
    ['finding', findings.map(keyOf)],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`corpus matcher: ${what} ${id} appears twice`);
      seen.add(id);
    }
  }
  const candidates: Match[] = [];
  for (const g of gold) {
    for (const f of findings) {
      const distance = pairDistance(g, f, variant);
      if (distance !== null) candidates.push({ goldId: g.id, chunk: f.chunk, fingerprint: f.fingerprint, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || byText(a.goldId, b.goldId) || byRef(a, b));

  const matches: Match[] = [];
  const goldUsed = new Set<string>();
  const findingUsed = new Set<string>();
  for (const c of candidates) {
    if (goldUsed.has(c.goldId) || findingUsed.has(keyOf(c))) continue;
    matches.push(c);
    goldUsed.add(c.goldId);
    findingUsed.add(keyOf(c));
  }
  const hadCandidate = new Set(candidates.map(keyOf));
  const rest = findings.filter((f) => !findingUsed.has(keyOf(f)));
  return {
    matches,
    duplicate: rest.filter((f) => f.grounded && hadCandidate.has(keyOf(f))).map(refOf).sort(byRef),
    unlabelled: rest.filter((f) => f.grounded && !hadCandidate.has(keyOf(f))).map(refOf).sort(byRef),
    ungrounded: rest.filter((f) => !f.grounded).map(refOf).sort(byRef),
    unmatchedGold: gold.filter((g) => !goldUsed.has(g.id)).map((g) => g.id).sort(byText),
  };
}
