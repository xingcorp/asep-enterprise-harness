// Self-history corpus freeze (docs/implementation/phases/phase-04-plan.md §7.5, §7.8; data model §7.1).
//
// The freeze reads the collected items, Lane B's gold annotations and git, and writes the
// manifest with `corpusSha256`. This is a provenance-stage freeze: the final freeze (packet
// eligibility, the full packet sources, the packet-dependent synthetic fields and the final
// `corpusSha256`) needs the runtime packet builder and egress decision, so it comes once the
// evals package is bound to the runtime packet code, and nothing may bind to the hash written
// here; the manifest says so in its stage fields. It applies the freeze rule `no-location`
// and the one packet-level rule that needs no packet, `leakage-filtered`, after collection's
// provenance rules, in the protocol's order, and counts every reason. The two packet-level
// rules that need a packet, `not-in-packet` and `egress-stopped`, are named as pending and
// never counted. The freeze
// also stores, content-addressed, the rule-P diff section of every cited file of a negative
// candidate (an item resolved at the next re-review), from which the post-fix location
// mapping is computed.
//
// Regenerate the committed manifest from the repository root:
//
//   pnpm exec tsx evals/review-corpus/freeze.ts --write
//
// The freeze is deterministic: a second run on the same tree writes the same bytes. It reads
// the working tree, git and the local object store only, never creates a ref and never reads
// the controller's bundle. Every stored diff passes the publication gates first.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BLOBS_DIR,
  CORPUS_DIR,
  CYCLES,
  GitReader,
  ITEMS_DIR,
  PROVENANCE_EXCLUSIONS,
  failingExcerpts,
  runGateProcess,
  sha256Hex,
  type CorpusItem,
  type GateRunner,
  type PublicationGate,
} from './collect.js';
import { CORPUS_EXECUTION, labelledId, phaseTitle, syntheticId, syntheticWorkOrder, type LabelledId, type SyntheticRecord } from './synthetic.js';

export const MANIFEST_FILE = `${CORPUS_DIR}/manifest.json`;
export const ANNOTATIONS_FILE = `${CORPUS_DIR}/annotations.json`;
export const MAPPING_DIR = `${CORPUS_DIR}/mapping`;

export const MANIFEST_VERSION = 'self-history-manifest/v1';

/** The stage of the committed manifest, and what the final freeze adds. */
export const MANIFEST_STAGE = 'provenance';
export const MANIFEST_STAGE_NOTE =
  'A provenance-stage freeze. The final freeze (packet eligibility with not-in-packet and egress-stopped, the full packet sources, the packet-dependent synthetic fields and the final corpusSha256) is made once the evals package is bound to the runtime packet code. Nothing may bind to this corpusSha256.';
export const ANNOTATIONS_VERSION = 'self-history-annotations/v1';
export const CATEGORY_TABLE = 'corpus-categories/v1';

/** The gold categories of category table `corpus-categories/v1` (plan §7.8). */
export const GOLD_CATEGORIES = [
  'CORRECTNESS',
  'SECURITY',
  'ARCHITECTURE',
  'SPEC',
  'TEST_QUALITY',
  'EVIDENCE_INTEGRITY',
  'PERFORMANCE',
  'MAINTAINABILITY',
] as const;
export type GoldCategory = (typeof GOLD_CATEGORIES)[number];

/** Defect classes (plan §7.2 item 8). */
export const DEFECT_CLASSES = ['code', 'test-adequacy', 'gate-config', 'claim-integrity', 'build'] as const;
export type DefectClass = (typeof DEFECT_CLASSES)[number];

/** Every exclusion reason, in the order the first that applies wins (plan §7.8). */
export const EXCLUSION_ORDER = [
  'plan-defect',
  'reviewed-tree-unknown',
  'excerpt-unpublishable',
  'no-location',
  'leakage-filtered',
  'not-in-packet',
  'egress-stopped',
] as const;
export type ExclusionReason = (typeof EXCLUSION_ORDER)[number];

/** The reasons the freeze applies: collection's provenance rules, then these two. */
export const FREEZE_EXCLUSIONS: readonly ExclusionReason[] = ['no-location', 'leakage-filtered'];

/** The packet-level reasons that need the runtime packet builder and egress decision. */
export const PACKET_PLAN_EXCLUSIONS: readonly ExclusionReason[] = ['not-in-packet', 'egress-stopped'];

/** Rule P step 2: files removed from every corpus packet (plan §7.8). */
export const LEAKAGE_FILTER = ['docs/implementation/phases/*review*', 'docs/implementation/phases/*-report.md', 'artifacts/**', '**/*.log'] as const;

/** Rule P step 1 diff flags (plan §7.8), also used for the post-fix mapping. */
export const RULE_P_DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3'] as const;

const EXCLUSION_LEVEL: Readonly<Record<ExclusionReason, 'provenance' | 'freeze' | 'packet'>> = {
  'plan-defect': 'provenance',
  'reviewed-tree-unknown': 'provenance',
  'excerpt-unpublishable': 'provenance',
  'no-location': 'freeze',
  'leakage-filtered': 'packet',
  'not-in-packet': 'packet',
  'egress-stopped': 'packet',
};

function fail(message: string): never {
  throw new Error(`review-corpus freeze: ${message}`);
}

// --- leakage filter ---------------------------------------------------------------------------

function globRegex(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (glob.startsWith('**/', i)) {
      source += '(?:[^/]+/)*';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

const LEAKAGE_REGEXES = LEAKAGE_FILTER.map(globRegex);

/**
 * Whether rule P's leakage filter removes `path`. A single star matches within one path
 * segment, a double star across segments, and a double-star segment followed by a slash
 * matches zero or more directories.
 */
export function isLeakagePath(path: string): boolean {
  return LEAKAGE_REGEXES.some((r) => r.test(path));
}

// --- post-fix mapping diffs ---------------------------------------------------------------------

/** One cited file's rule-P diff section between the reviewed and the post-fix tree. */
export interface MappingSection {
  readonly path: string;
  /** The file's path at the post-fix tree: the same path, a rename's new path, or null when deleted. */
  readonly newPath: string | null;
  /** The section's bytes, from its `diff --git` line; null when the file did not change. */
  readonly bytes: Uint8Array | null;
}

function unquoted(path: string, line: string): string {
  if (path.startsWith('"')) fail(`a quoted path in the diff is not supported: ${line}`);
  return path;
}

/**
 * The section of a whole-tree rule-P diff that holds `path` at its old side, following a
 * rename to its new path and a deletion to null. A path the diff does not name is unchanged.
 */
export function mappingSection(diff: Uint8Array, path: string): MappingSection {
  // latin1 maps every byte to one code unit, so the section's bytes come back unchanged.
  const text = Buffer.from(diff).toString('latin1');
  const starts: number[] = [];
  const header = /^diff --git /gm;
  for (let m = header.exec(text); m !== null; m = header.exec(text)) starts.push(m.index);
  if (starts.length === 0 && text !== '') fail('the diff has no file section');
  let found: MappingSection | null = null;
  for (const [k, start] of starts.entries()) {
    const section = text.slice(start, starts[k + 1] ?? text.length);
    const lines = section.split('\n');
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0]!) ?? fail(`unparseable diff header: ${lines[0]}`);
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let deleted = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@') || line.startsWith('Binary files ')) break;
      if (line.startsWith('rename from ')) oldPath = unquoted(line.slice('rename from '.length), line);
      else if (line.startsWith('rename to ')) newPath = unquoted(line.slice('rename to '.length), line);
      else if (line.startsWith('deleted file mode ')) deleted = true;
      else if (line.startsWith('--- a/')) oldPath ??= unquoted(line.slice('--- a/'.length), line);
      else if (line.startsWith('+++ b/')) newPath ??= unquoted(line.slice('+++ b/'.length), line);
    }
    oldPath ??= unquoted(head[1]!, lines[0]!);
    if (!deleted) newPath ??= unquoted(head[2]!, lines[0]!);
    if (oldPath !== path) continue;
    if (found !== null) fail(`the diff names ${path} twice`);
    found = { path, newPath: deleted ? null : newPath, bytes: new Uint8Array(Buffer.from(section, 'latin1')) };
  }
  return found ?? { path, newPath: path, bytes: null };
}

// --- annotations --------------------------------------------------------------------------------

export interface Annotation {
  readonly goldCategory: GoldCategory;
  readonly rationale: string;
  readonly defectClass: DefectClass;
}

export interface Annotations {
  readonly annotationsVersion: string;
  readonly categoryTable: string;
  /** Gold category, its one-line rationale and the defect class, per finding id; assigned by Lane B, never by a model. */
  readonly findings: Readonly<Record<string, Annotation>>;
}

function checkAnnotations(annotations: Annotations, annotated: ReadonlySet<string>): void {
  if (annotations.annotationsVersion !== ANNOTATIONS_VERSION) fail(`annotations version must be ${ANNOTATIONS_VERSION}`);
  if (annotations.categoryTable !== CATEGORY_TABLE) fail(`annotations must use ${CATEGORY_TABLE}`);
  for (const [findingId, a] of Object.entries(annotations.findings)) {
    if (!annotated.has(findingId)) fail(`${findingId} is annotated but no included item carries it`);
    const keys = Object.keys(a).sort().join(',');
    if (keys !== 'defectClass,goldCategory,rationale') fail(`${findingId}: an annotation has exactly goldCategory, rationale and defectClass`);
    if (!(GOLD_CATEGORIES as readonly string[]).includes(a.goldCategory)) fail(`${findingId}: ${a.goldCategory} is not in ${CATEGORY_TABLE}`);
    if (!(DEFECT_CLASSES as readonly string[]).includes(a.defectClass)) fail(`${findingId}: unknown defect class ${a.defectClass}`);
    if (typeof a.rationale !== 'string' || a.rationale.trim() === '' || a.rationale !== a.rationale.trim() || /[\r\n]/.test(a.rationale)) {
      fail(`${findingId}: the rationale is one non-empty line`);
    }
  }
  for (const findingId of annotated) {
    if (annotations.findings[findingId] === undefined) fail(`${findingId} carries an included item but has no annotation`);
  }
}

// --- synthetic fields ---------------------------------------------------------------------------

/**
 * The synthetic fields of a corpus packet that only the runtime packet code can fill. The final
 * freeze adds them; the provenance-stage manifest lists them.
 */
export const PENDING_PACKET_FIELDS = [
  'identity.attemptId and roundKey: the chunk id of each packet',
  'priorFindings: the chunk filter on the prior candidates (a prior is shown when its file is in the chunk)',
  'priorFindings[].fingerprint: the runtime finding code',
  'priorFindings[].evidence and requiredFix: the label text, split and masked',
  'the masks applied to each packet part',
  'the packet sources: chunk diffs, repair-delta sections and post-images',
] as const;

/** A review-finding record rule C shows as a prior finding, before the chunk filter. */
export interface PriorCandidate {
  readonly itemId: string;
  /** The synthetic id of `corpus:finding:<findingId>`. */
  readonly id: string;
  readonly source: 'model';
  readonly raisedBy: string;
  readonly severity: CorpusItem['severity'];
  readonly category: GoldCategory;
  /** The first location at the previous cycle's reviewed tree. */
  readonly file: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly grounded: true;
  readonly lifecycleState: 'OPEN';
}

/** The synthetic fields of one included item's packets that its provenance determines (plan §7.8). */
export interface ItemSynthetic {
  /** P: a fresh review of a first occurrence. C: a re-review of a residual's status. */
  readonly rule: 'P' | 'C';
  /** Collection's key of the item's cycle. */
  readonly cycle: string;
  readonly taskId: LabelledId;
  readonly round: 1 | 2;
  readonly reviewKind: 'fresh' | 're-review';
  readonly taskBaseSha: string;
  readonly resultSha: string;
  /** Rule C: the previous cycle's reviewed tree; null when it is unknown. */
  readonly repairBaseSha: string | null;
  readonly repairDelta: { readonly from: string; readonly to: string } | null;
  /** Rule C: every included item labelled at the previous cycle. */
  readonly priorCandidates: readonly PriorCandidate[];
  /** A post-fix negative's packet: a fresh review of the post-fix tree on the item's base. */
  readonly negative: { readonly taskBaseSha: string; readonly resultSha: string } | null;
  /** Set when a packet of the rule cannot be built from the provenance. */
  readonly blockedBy: 'previous-cycle-tree-unknown' | null;
}

/** The synthetic fields every corpus packet shares. */
export interface CorpusSynthetic {
  readonly identity: Readonly<Record<'organizationId' | 'projectId' | 'repositoryBindingId' | 'runId', LabelledId>>;
  readonly risk: 'R1';
  /** By phase. */
  readonly workOrders: Readonly<Record<string, SyntheticRecord['workOrder']>>;
  readonly execution: typeof CORPUS_EXECUTION;
  readonly pendingPacketFields: readonly string[];
}

function cycleKey(phase: number, cycle: number): string {
  return (CYCLES.find((c) => c.phase === phase && c.cycle === cycle) ?? fail(`no cycle ${phase}:${cycle}`)).key;
}

// --- manifest -----------------------------------------------------------------------------------

export interface ManifestMapping {
  readonly path: string;
  readonly newPath: string | null;
  /** sha256 of the stored diff section under `mapping/`; null when the file did not change. */
  readonly diffSha256: string | null;
  /** The gates a diff section failed; it is then not stored and the location does not map. */
  readonly withheldGates: readonly PublicationGate[];
}

/**
 * What an included item is scored for (plan §7.8): rule P's rediscovery of a first occurrence, rule C's status
 * of a residual, and the post-fix negative of an item resolved at the next re-review. Fix commits are provenance
 * only and never decide a use.
 */
export type ItemUse = 'rediscovery' | 'residual-status' | 'post-fix-negative';

export interface ManifestItem {
  readonly id: string;
  readonly itemSha256: string;
  readonly findingId: string;
  readonly phase: 1 | 2;
  readonly cycle: number;
  readonly instanceKind: CorpusItem['instanceKind'];
  readonly severity: CorpusItem['severity'];
  readonly set: 'prompt-development' | 'reporting';
  readonly labelSource: 'codex-gpt-5.6-sol' | 'implementer-self-found' | 'controller-ai-paraphrase';
  readonly labelQuality: 'primary' | 'secondhand';
  readonly labellerMiss: boolean;
  readonly reachability: CorpusItem['reachability'];
  readonly dependsOnPrivateBundle: boolean;
  readonly excluded: { readonly reason: ExclusionReason; readonly level: 'provenance' | 'freeze' | 'packet' } | null;
  readonly goldCategory: GoldCategory | null;
  readonly goldCategoryRationale: string | null;
  readonly defectClass: DefectClass | null;
  /** Null for an excluded item. */
  readonly uses: readonly ItemUse[] | null;
  /** Null for an excluded item. */
  readonly synthetic: ItemSynthetic | null;
  /** Negative candidates only: the item is resolved at the next re-review and its post-fix tree is known. */
  readonly mapping: readonly ManifestMapping[] | null;
}

export interface ManifestCycle {
  readonly phase: 1 | 2;
  readonly cycle: number;
  readonly reviewKind: CorpusItem['reviewKind'];
  readonly doc: string;
  readonly reviewedSha: string | null;
  readonly reviewedShaSource: CorpusItem['reviewedShaSource'];
  readonly baseSha: string | null;
  readonly postFixSha: string | null;
  readonly reachability: CorpusItem['reachability'];
  readonly items: number;
}

export interface ManifestCounts {
  readonly items: number;
  /** Items no rule applied by the freeze excludes; the packet plan's rules still apply to them. */
  readonly included: number;
  readonly excluded: Readonly<Record<string, number>>;
  readonly noLocationByPhase: Readonly<Record<string, number>>;
  readonly includedBySet: Readonly<Record<string, number>>;
  readonly includedByInstanceKind: Readonly<Record<string, number>>;
  readonly includedPrivateBundleOnly: number;
  readonly includedDependsOnPrivateBundle: number;
  readonly includedSecondhand: number;
  readonly includedLabellerMiss: number;
  readonly negativeCandidates: number;
}

export interface ManifestBody {
  readonly manifestVersion: string;
  readonly stage: typeof MANIFEST_STAGE;
  readonly stageNote: string;
  readonly protocol: {
    readonly plan: string;
    readonly categoryTable: string;
    readonly ruleDiffFlags: readonly string[];
    readonly leakageFilter: readonly string[];
    readonly exclusionOrder: readonly ExclusionReason[];
    readonly appliedAtFreeze: readonly ExclusionReason[];
    readonly appliedByPacketPlan: readonly ExclusionReason[];
  };
  readonly annotationsSha256: string;
  readonly synthetic: CorpusSynthetic;
  readonly cycles: readonly ManifestCycle[];
  readonly items: readonly ManifestItem[];
  readonly counts: ManifestCounts;
  readonly blobs: readonly string[];
  readonly mappingDiffs: readonly string[];
}

export interface FrozenCorpus {
  readonly body: ManifestBody;
  readonly corpusSha256: string;
  /** The manifest file: the body and its `corpusSha256`, keys sorted, two-space indented. */
  readonly bytes: Uint8Array;
  readonly mappingBlobs: ReadonlyMap<string, Uint8Array>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}

/** sha256 of the body's canonical JSON (keys sorted, no whitespace). */
export function corpusSha256Of(body: ManifestBody): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(sortKeys(body))));
}

/** The manifest file bytes for a body. */
export function manifestBytes(body: ManifestBody): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortKeys({ ...body, corpusSha256: corpusSha256Of(body) }), null, 2)}\n`);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tally(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...keys].sort(byText)) out[k] = (out[k] ?? 0) + 1;
  return out;
}

function labelOrigin(item: CorpusItem): Pick<ManifestItem, 'labelSource' | 'labelQuality'> {
  if (item.reviewKind === 'self-found') return { labelSource: 'implementer-self-found', labelQuality: 'primary' };
  const cycle = CYCLES.find((c) => c.doc === item.provenance.doc && c.phase === item.phase && c.cycle === item.cycle) ?? fail(`${item.id}: no cycle has its document`);
  // The first Phase 1 final review survives only as the controller's paraphrase (plan §7.2 item 6).
  if (cycle.reviewedSha.kind === 'unknown' && cycle.reviewKind === 'final') return { labelSource: 'controller-ai-paraphrase', labelQuality: 'secondhand' };
  return { labelSource: 'codex-gpt-5.6-sol', labelQuality: 'primary' };
}

/** The first freeze rule that excludes a collected item, after collection's own exclusion. */
export function freezeExclusion(item: CorpusItem): ManifestItem['excluded'] {
  if (item.excluded !== null) {
    if (!PROVENANCE_EXCLUSIONS.includes(item.excluded.reason)) fail(`${item.id}: collection recorded ${item.excluded.reason}`);
    return { reason: item.excluded.reason, level: EXCLUSION_LEVEL[item.excluded.reason] };
  }
  if (item.locations.length === 0) return { reason: 'no-location', level: EXCLUSION_LEVEL['no-location'] };
  if (item.locations.every((l) => isLeakagePath(l.file))) return { reason: 'leakage-filtered', level: EXCLUSION_LEVEL['leakage-filtered'] };
  return null;
}

/** The inputs of a freeze, as read from the tree. */
export interface FreezeInputs {
  /** Each committed item file's bytes, by file name. */
  readonly itemFiles: ReadonlyMap<string, Uint8Array>;
  readonly annotationsBytes: Uint8Array;
  readonly blobNames: readonly string[];
  /** docs/implementation/90-day-plan.md, which names each phase. */
  readonly ninetyDayPlan: string;
  /** The whole-tree rule-P diff between two commits. */
  readonly diff: (from: string, to: string) => Uint8Array;
  /** The gates each candidate diff section fails, by its sha256. */
  readonly gates: (candidates: ReadonlyMap<string, Uint8Array>) => ReadonlyMap<string, readonly PublicationGate[]>;
}

/** Freeze the collected corpus. Deterministic in its inputs. */
export function freezeCorpus(inputs: FreezeInputs): FrozenCorpus {
  const items = [...inputs.itemFiles]
    .sort(([a], [b]) => byText(a, b))
    .map(([name, bytes]) => {
      const item = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as CorpusItem;
      if (name !== `${item.id}.json`) fail(`${name} holds item ${item.id}`);
      return { item, sha256: sha256Hex(bytes) };
    });
  const annotations = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inputs.annotationsBytes)) as Annotations;

  const decided = items.map(({ item, sha256 }) => ({ item, sha256, excluded: freezeExclusion(item) }));
  checkAnnotations(annotations, new Set(decided.filter((d) => d.excluded === null).map((d) => d.item.findingId)));

  // Negative candidates: the cited files' diff sections between the reviewed and post-fix trees.
  const sections = new Map<string, MappingSection[]>();
  const diffs = new Map<string, Uint8Array>();
  for (const { item, excluded } of decided) {
    if (excluded !== null || item.confirmation?.status !== 'RESOLVED' || item.postFixSha === null) continue;
    const key = `${item.reviewedSha}..${item.postFixSha}`;
    if (!diffs.has(key)) diffs.set(key, inputs.diff(item.reviewedSha!, item.postFixSha));
    const files = [...new Set(item.locations.map((l) => l.file))].sort(byText);
    sections.set(
      item.id,
      files.map((path) => mappingSection(diffs.get(key)!, path)),
    );
  }
  const candidates = new Map<string, Uint8Array>();
  for (const list of sections.values()) for (const s of list) if (s.bytes !== null) candidates.set(sha256Hex(s.bytes), s.bytes);
  const failing = inputs.gates(candidates);
  const mappingBlobs = new Map([...candidates].filter(([sha]) => (failing.get(sha) ?? []).length === 0));

  const cycles = new Map<string, ManifestCycle>();
  for (const { item } of decided) {
    const key = `${item.phase}:${String(item.cycle).padStart(3, '0')}`;
    const record: ManifestCycle = {
      phase: item.phase,
      cycle: item.cycle,
      reviewKind: item.reviewKind,
      doc: item.provenance.doc,
      reviewedSha: item.reviewedSha,
      reviewedShaSource: item.reviewedShaSource,
      baseSha: item.baseSha,
      postFixSha: item.postFixSha,
      reachability: item.reachability,
      items: (cycles.get(key)?.items ?? 0) + 1,
    };
    const seen = cycles.get(key);
    if (seen !== undefined && JSON.stringify({ ...seen, items: 0 }) !== JSON.stringify({ ...record, items: 0 })) fail(`${item.id} disagrees with its cycle's trees`);
    cycles.set(key, record);
  }

  // Rule C's prior candidates: the included items labelled at each cycle, with the record a re-review shows.
  const priorsByCycle = new Map<string, PriorCandidate[]>();
  for (const { item, excluded } of decided) {
    if (excluded !== null) continue;
    const first = item.locations[0]!;
    const key = `${item.phase}:${item.cycle}`;
    priorsByCycle.set(key, [
      ...(priorsByCycle.get(key) ?? []),
      {
        itemId: item.id,
        id: syntheticId(`corpus:finding:${item.findingId}`),
        source: 'model',
        raisedBy: `labeller:${labelOrigin(item).labelSource}`,
        severity: item.severity,
        category: annotations.findings[item.findingId]!.goldCategory,
        file: first.file,
        lineStart: first.lineStart,
        lineEnd: first.lineEnd,
        grounded: true,
        lifecycleState: 'OPEN',
      },
    ]);
  }

  const itemSynthetic = (item: CorpusItem, negative: boolean): ItemSynthetic => {
    const cycle = cycleKey(item.phase, item.cycle);
    const common = {
      cycle,
      taskId: labelledId(`corpus:task:${cycle}`),
      taskBaseSha: item.baseSha!,
      resultSha: item.reviewedSha!,
      negative: negative ? { taskBaseSha: item.baseSha!, resultSha: item.postFixSha! } : null,
    };
    if (item.instanceKind === 'first-occurrence') {
      return { rule: 'P', ...common, round: 1, reviewKind: 'fresh', repairBaseSha: null, repairDelta: null, priorCandidates: [], blockedBy: null };
    }
    // Rule C re-reviews the residual's own tree against the cycle it re-reviews, the one before it.
    const previous = Math.max(...CYCLES.filter((c) => c.phase === item.phase && c.cycle > 0 && c.cycle < item.cycle).map((c) => c.cycle));
    const record = cycles.get(`${item.phase}:${String(previous).padStart(3, '0')}`) ?? fail(`${item.id}: no item records cycle ${item.phase}:${previous}`);
    const repairBaseSha = record.reviewedSha;
    return {
      rule: 'C',
      ...common,
      round: 2,
      reviewKind: 're-review',
      repairBaseSha,
      repairDelta: repairBaseSha === null ? null : { from: repairBaseSha, to: item.reviewedSha! },
      // A cycle whose tree is unknown has every item excluded, so it has no candidates.
      priorCandidates: [...(priorsByCycle.get(`${item.phase}:${previous}`) ?? [])],
      blockedBy: repairBaseSha === null ? 'previous-cycle-tree-unknown' : null,
    };
  };

  const manifestItems = decided.map(({ item, sha256, excluded }): ManifestItem => {
    const a = excluded === null ? annotations.findings[item.findingId]! : null;
    const mapping =
      sections.get(item.id)?.map((s): ManifestMapping => {
        const sha = s.bytes === null ? null : sha256Hex(s.bytes);
        const withheldGates = sha === null ? [] : [...(failing.get(sha) ?? [])];
        return { path: s.path, newPath: s.newPath, diffSha256: withheldGates.length > 0 ? null : sha, withheldGates };
      }) ?? null;
    return {
      id: item.id,
      itemSha256: sha256,
      findingId: item.findingId,
      phase: item.phase,
      cycle: item.cycle,
      instanceKind: item.instanceKind,
      severity: item.severity,
      set: item.phase === 1 ? 'prompt-development' : 'reporting',
      ...labelOrigin(item),
      labellerMiss: item.reviewKind === 'self-found',
      reachability: item.reachability,
      dependsOnPrivateBundle: item.dependsOnPrivateBundle,
      excluded,
      goldCategory: a?.goldCategory ?? null,
      goldCategoryRationale: a?.rationale ?? null,
      defectClass: a?.defectClass ?? null,
      uses: excluded !== null ? null : [item.instanceKind === 'first-occurrence' ? 'rediscovery' : 'residual-status', ...(mapping === null ? [] : ['post-fix-negative' as const])],
      synthetic: excluded !== null ? null : itemSynthetic(item, mapping !== null),
      mapping,
    };
  });

  const included = manifestItems.filter((i) => i.excluded === null);
  const body: ManifestBody = {
    manifestVersion: MANIFEST_VERSION,
    stage: MANIFEST_STAGE,
    stageNote: MANIFEST_STAGE_NOTE,
    protocol: {
      plan: 'docs/implementation/phases/phase-04-plan.md §7.8',
      categoryTable: CATEGORY_TABLE,
      ruleDiffFlags: [...RULE_P_DIFF_FLAGS],
      leakageFilter: [...LEAKAGE_FILTER],
      exclusionOrder: [...EXCLUSION_ORDER],
      appliedAtFreeze: [...PROVENANCE_EXCLUSIONS, ...FREEZE_EXCLUSIONS],
      appliedByPacketPlan: [...PACKET_PLAN_EXCLUSIONS],
    },
    annotationsSha256: sha256Hex(inputs.annotationsBytes),
    synthetic: {
      identity: {
        organizationId: labelledId('corpus:org'),
        projectId: labelledId('corpus:project'),
        repositoryBindingId: labelledId('corpus:binding'),
        runId: labelledId('corpus:run'),
      },
      risk: 'R1',
      workOrders: Object.fromEntries(
        [...new Set(decided.map((d) => d.item.phase))].sort().map((phase) => [String(phase), syntheticWorkOrder(phase, phaseTitle(inputs.ninetyDayPlan, phase))]),
      ),
      execution: CORPUS_EXECUTION,
      pendingPacketFields: [...PENDING_PACKET_FIELDS],
    },
    cycles: [...cycles].sort(([a], [b]) => byText(a, b)).map(([, c]) => c),
    items: manifestItems,
    counts: {
      items: manifestItems.length,
      included: included.length,
      excluded: tally(manifestItems.flatMap((i) => (i.excluded === null ? [] : [i.excluded.reason]))),
      noLocationByPhase: tally(manifestItems.filter((i) => i.excluded?.reason === 'no-location').map((i) => String(i.phase))),
      includedBySet: tally(included.map((i) => i.set)),
      includedByInstanceKind: tally(included.map((i) => i.instanceKind)),
      includedPrivateBundleOnly: included.filter((i) => i.reachability === 'private-bundle-only').length,
      includedDependsOnPrivateBundle: included.filter((i) => i.dependsOnPrivateBundle).length,
      includedSecondhand: included.filter((i) => i.labelQuality === 'secondhand').length,
      includedLabellerMiss: included.filter((i) => i.labellerMiss).length,
      negativeCandidates: included.filter((i) => i.mapping !== null).length,
    },
    blobs: [...inputs.blobNames].sort(byText),
    mappingDiffs: [...mappingBlobs.keys()].sort(byText),
  };
  return { body, corpusSha256: corpusSha256Of(body), bytes: manifestBytes(body), mappingBlobs };
}

/** The freeze inputs of a repository tree. */
export function treeInputs(root: string, git = new GitReader(root), runGate: GateRunner = runGateProcess): FreezeInputs {
  return {
    itemFiles: new Map(readdirSync(join(root, ITEMS_DIR)).map((name) => [name, new Uint8Array(readFileSync(join(root, ITEMS_DIR, name)))])),
    annotationsBytes: new Uint8Array(readFileSync(join(root, ANNOTATIONS_FILE))),
    blobNames: readdirSync(join(root, BLOBS_DIR)),
    ninetyDayPlan: readFileSync(join(root, 'docs/implementation/90-day-plan.md'), 'utf8'),
    diff: (from, to) => git.diff(RULE_P_DIFF_FLAGS, from, to),
    gates: (candidates) => failingExcerpts(root, candidates, runGate),
  };
}

/** Replace the committed manifest and mapping diffs with a fresh freeze. */
export function writeFrozenCorpus(root: string, frozen: FrozenCorpus): void {
  rmSync(join(root, MAPPING_DIR), { recursive: true, force: true });
  mkdirSync(join(root, MAPPING_DIR), { recursive: true });
  for (const [sha, bytes] of frozen.mappingBlobs) writeFileSync(join(root, MAPPING_DIR, sha), bytes);
  writeFileSync(join(root, MANIFEST_FILE), frozen.bytes);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const frozen = freezeCorpus(treeInputs(root));
  if (process.argv.includes('--write')) writeFrozenCorpus(root, frozen);
  const { counts } = frozen.body;
  console.log(
    `review-corpus freeze: ${counts.items} items, ${counts.included} included (${Object.entries(counts.excluded)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}), corpusSha256 ${frozen.corpusSha256}`,
  );
}
