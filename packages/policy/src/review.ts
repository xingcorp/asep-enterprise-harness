// Review policy: reviewer independence, egress classification and review modes.
//
// Loaded from the canonical policies/review-policy.yaml. The loader is a strict
// projection of that file: unknown keys, unknown model families and any `gating`
// mode are rejected, so a composition built from the committed policy can only
// run shadow reviews. Gating exists only in in-memory drill policies that never
// pass through this loader.
//
// Policy evaluation is DETERMINISTIC: pure file read + parse + lookup. No model
// call, no network.

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { RiskLevel } from '@asep/contracts';
import { approvalFor } from './approval.js';
import { readPolicyFile } from './policy-source.js';
import { RISK_ORDER } from './risk.js';

export const REVIEW_POLICY_FILE = 'review-policy.yaml';

export const REVIEW_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Modes a committed review policy may declare. `gating` is deliberately absent. */
export const POLICY_REVIEW_MODES = ['not-required', 'shadow', 'deferred'] as const;
export type PolicyReviewMode = (typeof POLICY_REVIEW_MODES)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const INDEPENDENT_REVIEWER_KINDS = ['human', 'promoted-model'] as const;
export type IndependentReviewerKind = (typeof INDEPENDENT_REVIEWER_KINDS)[number];

export type ReviewerPolicyRole = 'primary' | 'comparator';

export interface ModelFamilyRule {
  readonly family: string;
  /** Lowercase model-id prefixes; the longest matching prefix decides. */
  readonly prefixes: readonly string[];
}

export interface ReviewerPricing {
  readonly inputUsdPerMillionTokens: number;
  readonly cachedInputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  /** Where the price was published. */
  readonly source: string;
  /** YYYY-MM-DD the price was read. */
  readonly asOf: string;
}

export interface ReviewerConfig {
  readonly id: string;
  readonly role: ReviewerPolicyRole;
  readonly providerId: 'openai-responses';
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxOutputTokens: number;
  readonly packetBudgetBytes: number;
  /** Null when no published price is configured; cost is then reported as uncovered, never estimated. */
  readonly pricing: ReviewerPricing | null;
}

export interface ReviewPolicy {
  readonly apiVersion: 'asep.policy/v1';
  readonly kind: 'ReviewPolicy';
  readonly version: string;
  readonly modelFamilies: readonly ModelFamilyRule[];
  readonly reviewers: readonly ReviewerConfig[];
  readonly runtime: { readonly comparatorInShadowRounds: boolean };
  readonly modes: Readonly<Record<RiskLevel, PolicyReviewMode>>;
  readonly independentReviewSatisfiedBy: Readonly<Partial<Record<RiskLevel, readonly IndependentReviewerKind[]>>>;
  readonly maxRounds: Readonly<Partial<Record<RiskLevel, number>>>;
  readonly blockingSeverities: Readonly<Partial<Record<RiskLevel, readonly ReviewSeverity[]>>>;
  readonly groundingMinChars: { readonly evidence: number; readonly requiredFix: number };
  readonly repairOrderLimits: { readonly perFieldBytes: number; readonly totalBytes: number };
  readonly egress: {
    /** Explicit per-project opt-in; empty means no reviewer request is ever sent. */
    readonly enabledProjects: readonly string[];
    readonly denyPathGlobs: readonly string[];
    readonly excerptBytesPerStream: number;
    readonly excerptBytesTotal: number;
  };
  readonly credential: { readonly maxCredentialAgeMs: number };
  /** sha256 of the policy source bytes, 64 lowercase hex. */
  readonly sha256: string;
}

export class ReviewPolicyError extends Error {
  constructor(message: string) {
    super(`review-policy: ${message}`);
    this.name = 'ReviewPolicyError';
  }
}

// --- strict reading helpers ------------------------------------------------------

type Doc = Record<string, unknown>;

function fail(message: string): never {
  throw new ReviewPolicyError(message);
}

function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function mapping(value: unknown, path: string): Doc {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path === '' ? 'document' : path} must be a mapping`);
  }
  return value as Doc;
}

/** A mapping with exactly the given keys, all required. */
function record(value: unknown, path: string, keys: readonly string[]): Doc {
  const doc = mapping(value, path);
  onlyKeys(doc, path, keys);
  for (const key of keys) {
    if (!(key in doc)) fail(`${at(path, key)} is required`);
  }
  return doc;
}

function onlyKeys(doc: Doc, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(doc)) {
    if (!keys.includes(key)) fail(`${path === '' ? 'document' : path}: unknown key "${key}"`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function positiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${path} must be a positive integer`);
  }
  return value;
}

function price(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${path} must be a non-negative number`);
  }
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`${path} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function list(value: unknown, path: string, nonEmpty: boolean): readonly unknown[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail(`${path} must be a ${nonEmpty ? 'non-empty ' : ''}list`);
  }
  return value;
}

function uniqueTexts(value: unknown, path: string, nonEmpty: boolean): readonly string[] {
  const items = list(value, path, nonEmpty).map((item, i) => text(item, `${path}[${i}]`));
  if (new Set(items).size !== items.length) fail(`${path} must not repeat an entry`);
  return items;
}

function uniqueOneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): readonly T[] {
  const items = list(value, path, true).map((item, i) => oneOf(item, `${path}[${i}]`, allowed));
  if (new Set(items).size !== items.length) fail(`${path} must not repeat an entry`);
  return items;
}

/** A mapping keyed by risk level, every key optional. */
function perRisk<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): Partial<Record<RiskLevel, T>> {
  const doc = mapping(value, path);
  onlyKeys(doc, path, RISK_ORDER);
  const out: Partial<Record<RiskLevel, T>> = {};
  for (const risk of RISK_ORDER) {
    if (risk in doc) out[risk] = read(doc[risk], at(path, risk));
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// --- sections --------------------------------------------------------------------------

const ROOT_KEYS = [
  'apiVersion',
  'kind',
  'version',
  'modelFamilies',
  'reviewers',
  'runtime',
  'modes',
  'independentReviewSatisfiedBy',
  'maxRounds',
  'blockingSeverities',
  'groundingMinChars',
  'repairOrderLimits',
  'egress',
  'credential',
] as const;

const REVIEWER_KEYS = [
  'id',
  'role',
  'providerId',
  'model',
  'reasoningEffort',
  'maxOutputTokens',
  'packetBudgetBytes',
  'pricing',
] as const;

const PRICING_KEYS = [
  'inputUsdPerMillionTokens',
  'cachedInputUsdPerMillionTokens',
  'outputUsdPerMillionTokens',
  'source',
  'asOf',
] as const;

function readModelFamilies(value: unknown): ModelFamilyRule[] {
  const families = new Set<string>();
  const prefixes = new Set<string>();
  return list(value, 'modelFamilies', true).map((item, i) => {
    const path = `modelFamilies[${i}]`;
    const doc = record(item, path, ['family', 'prefixes']);
    const family = text(doc['family'], `${path}.family`);
    if (families.has(family)) fail(`${path}: duplicate model family "${family}"`);
    families.add(family);
    const own = uniqueTexts(doc['prefixes'], `${path}.prefixes`, true);
    own.forEach((prefix, j) => {
      if (prefix !== prefix.toLowerCase()) fail(`${path}.prefixes[${j}] must be lowercase`);
      if (prefixes.has(prefix)) fail(`${path}.prefixes[${j}]: prefix "${prefix}" is declared twice`);
      prefixes.add(prefix);
    });
    return { family, prefixes: own };
  });
}

function readPricing(value: unknown, path: string): ReviewerPricing | null {
  if (value === null) return null;
  const doc = record(value, path, PRICING_KEYS);
  const asOf = text(doc['asOf'], `${path}.asOf`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail(`${path}.asOf must be a YYYY-MM-DD date`);
  return {
    inputUsdPerMillionTokens: price(doc['inputUsdPerMillionTokens'], `${path}.inputUsdPerMillionTokens`),
    cachedInputUsdPerMillionTokens: price(doc['cachedInputUsdPerMillionTokens'], `${path}.cachedInputUsdPerMillionTokens`),
    outputUsdPerMillionTokens: price(doc['outputUsdPerMillionTokens'], `${path}.outputUsdPerMillionTokens`),
    source: text(doc['source'], `${path}.source`),
    asOf,
  };
}

function readReviewers(value: unknown, modelFamilies: readonly ModelFamilyRule[]): ReviewerConfig[] {
  const ids = new Set<string>();
  const reviewers = list(value, 'reviewers', true).map((item, i): ReviewerConfig => {
    const path = `reviewers[${i}]`;
    const doc = record(item, path, REVIEWER_KEYS);
    const id = text(doc['id'], `${path}.id`);
    if (ids.has(id)) fail(`${path}: duplicate reviewer id "${id}"`);
    ids.add(id);
    if (doc['providerId'] !== 'openai-responses') fail(`${path}.providerId must be "openai-responses"`);
    const model = text(doc['model'], `${path}.model`);
    if (familyOf(modelFamilies, model) === null) fail(`${path}.model "${model}" has no known model family`);
    return {
      id,
      role: oneOf(doc['role'], `${path}.role`, ['primary', 'comparator'] as const),
      providerId: 'openai-responses',
      model,
      reasoningEffort: oneOf(doc['reasoningEffort'], `${path}.reasoningEffort`, REASONING_EFFORTS),
      maxOutputTokens: positiveInt(doc['maxOutputTokens'], `${path}.maxOutputTokens`),
      packetBudgetBytes: positiveInt(doc['packetBudgetBytes'], `${path}.packetBudgetBytes`),
      pricing: readPricing(doc['pricing'], `${path}.pricing`),
    };
  });

  const primaries = reviewers.filter((r) => r.role === 'primary');
  const comparators = reviewers.filter((r) => r.role === 'comparator');
  if (primaries.length !== 1) fail('reviewers must declare exactly one primary reviewer');
  if (comparators.length > 1) fail('reviewers must declare at most one comparator reviewer');
  const primaryFamily = familyOf(modelFamilies, primaries[0]!.model);
  for (const comparator of comparators) {
    if (familyOf(modelFamilies, comparator.model) === primaryFamily) {
      fail(
        `reviewers[${reviewers.indexOf(comparator)}]: comparator "${comparator.id}" resolves to the same model ` +
          `family as the primary (${primaryFamily})`,
      );
    }
  }
  return reviewers;
}

function readModes(value: unknown): Record<RiskLevel, PolicyReviewMode> {
  const doc = mapping(value, 'modes');
  onlyKeys(doc, 'modes', RISK_ORDER);
  const modes = {} as Record<RiskLevel, PolicyReviewMode>;
  for (const risk of RISK_ORDER) {
    const path = `modes.${risk}`;
    if (!(risk in doc)) fail(`${path} is required`);
    if (doc[risk] === 'gating') {
      fail(`${path}: gating is not permitted in a committed review policy (accepted: ${POLICY_REVIEW_MODES.join(', ')})`);
    }
    const mode = oneOf(doc[risk], path, POLICY_REVIEW_MODES);
    const required = approvalFor(risk).independentReviewers;
    if (mode === 'not-required' && required > 0) {
      fail(`${path} cannot be not-required: the approval matrix requires ${required} independent reviewer(s)`);
    }
    modes[risk] = mode;
  }
  return modes;
}

function readSatisfiedBy(value: unknown): Partial<Record<RiskLevel, readonly IndependentReviewerKind[]>> {
  return perRisk(value, 'independentReviewSatisfiedBy', (item, path) => {
    const kinds = uniqueOneOf(item, path, INDEPENDENT_REVIEWER_KINDS);
    if (!kinds.includes('human')) fail(`${path} must include human`);
    return kinds;
  });
}

/** Parse and validate review-policy YAML. Throws ReviewPolicyError on anything it does not accept. */
export function parseReviewPolicy(source: string | Uint8Array): ReviewPolicy {
  const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source);
  let raw: unknown;
  try {
    raw = parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (err) {
    fail(`source is not valid UTF-8 YAML (${err instanceof Error ? err.message : String(err)})`);
  }

  const doc = record(raw, '', ROOT_KEYS);
  if (doc['apiVersion'] !== 'asep.policy/v1') fail('apiVersion must be "asep.policy/v1"');
  if (doc['kind'] !== 'ReviewPolicy') fail('kind must be "ReviewPolicy"');
  const version = text(doc['version'], 'version');
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('version must be MAJOR.MINOR.PATCH');

  const modelFamilies = readModelFamilies(doc['modelFamilies']);
  const reviewers = readReviewers(doc['reviewers'], modelFamilies);
  const runtimeDoc = record(doc['runtime'], 'runtime', ['comparatorInShadowRounds']);
  const modes = readModes(doc['modes']);
  const independentReviewSatisfiedBy = readSatisfiedBy(doc['independentReviewSatisfiedBy']);
  const maxRounds = perRisk(doc['maxRounds'], 'maxRounds', positiveInt);
  const blockingSeverities = perRisk(doc['blockingSeverities'], 'blockingSeverities', (item, path) =>
    uniqueOneOf(item, path, REVIEW_SEVERITIES),
  );

  for (const risk of RISK_ORDER) {
    if (modes[risk] !== 'shadow') continue;
    if (independentReviewSatisfiedBy[risk] === undefined) {
      fail(`independentReviewSatisfiedBy.${risk} is required for a shadow risk`);
    }
    if (maxRounds[risk] === undefined) fail(`maxRounds.${risk} is required for a shadow risk`);
    if (blockingSeverities[risk] === undefined) fail(`blockingSeverities.${risk} is required for a shadow risk`);
  }

  const grounding = record(doc['groundingMinChars'], 'groundingMinChars', ['evidence', 'requiredFix']);
  const repair = record(doc['repairOrderLimits'], 'repairOrderLimits', ['perFieldBytes', 'totalBytes']);
  const perFieldBytes = positiveInt(repair['perFieldBytes'], 'repairOrderLimits.perFieldBytes');
  const totalBytes = positiveInt(repair['totalBytes'], 'repairOrderLimits.totalBytes');
  if (perFieldBytes > totalBytes) fail('repairOrderLimits.perFieldBytes must not exceed totalBytes');

  const egress = record(doc['egress'], 'egress', [
    'enabledProjects',
    'denyPathGlobs',
    'excerptBytesPerStream',
    'excerptBytesTotal',
  ]);
  const excerptBytesPerStream = positiveInt(egress['excerptBytesPerStream'], 'egress.excerptBytesPerStream');
  const excerptBytesTotal = positiveInt(egress['excerptBytesTotal'], 'egress.excerptBytesTotal');
  if (excerptBytesPerStream > excerptBytesTotal) {
    fail('egress.excerptBytesPerStream must not exceed excerptBytesTotal');
  }
  const credential = record(doc['credential'], 'credential', ['maxCredentialAgeMs']);

  return deepFreeze<ReviewPolicy>({
    apiVersion: 'asep.policy/v1',
    kind: 'ReviewPolicy',
    version,
    modelFamilies,
    reviewers,
    runtime: { comparatorInShadowRounds: flag(runtimeDoc['comparatorInShadowRounds'], 'runtime.comparatorInShadowRounds') },
    modes,
    independentReviewSatisfiedBy,
    maxRounds,
    blockingSeverities,
    groundingMinChars: {
      evidence: positiveInt(grounding['evidence'], 'groundingMinChars.evidence'),
      requiredFix: positiveInt(grounding['requiredFix'], 'groundingMinChars.requiredFix'),
    },
    repairOrderLimits: { perFieldBytes, totalBytes },
    egress: {
      enabledProjects: uniqueTexts(egress['enabledProjects'], 'egress.enabledProjects', false),
      denyPathGlobs: uniqueTexts(egress['denyPathGlobs'], 'egress.denyPathGlobs', true),
      excerptBytesPerStream,
      excerptBytesTotal,
    },
    credential: { maxCredentialAgeMs: positiveInt(credential['maxCredentialAgeMs'], 'credential.maxCredentialAgeMs') },
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

/** The committed review policy. */
export function loadReviewPolicy(): ReviewPolicy {
  return parseReviewPolicy(readPolicyFile(REVIEW_POLICY_FILE));
}

// --- reviewer independence ---------------------------------------------------------

function familyOf(rules: readonly ModelFamilyRule[], model: string): string | null {
  const id = model.toLowerCase();
  let best: { family: string; length: number } | null = null;
  for (const rule of rules) {
    for (const prefix of rule.prefixes) {
      if (id.startsWith(prefix) && (best === null || prefix.length > best.length)) {
        best = { family: rule.family, length: prefix.length };
      }
    }
  }
  return best?.family ?? null;
}

/** The family of a model id by longest-prefix match; null when unknown (callers fail closed). */
export function resolveModelFamily(policy: ReviewPolicy, model: string): string | null {
  return familyOf(policy.modelFamilies, model);
}

export type IndependenceFailure =
  | 'unknown-reviewer-family'
  | 'unknown-implementer-family'
  | 'unknown-primary-family'
  | 'same-family-as-implementer'
  | 'same-family-as-primary';

export type IndependenceVerdict =
  | { readonly eligible: true; readonly family: string }
  | { readonly eligible: false; readonly reason: IndependenceFailure };

/**
 * Whether a reviewer model is independent of the implementer and, for a comparator,
 * of the primary reviewer. Families come from the policy registry, never from a
 * provider's self-description; any unknown family is ineligible.
 */
export function reviewerIndependence(
  policy: ReviewPolicy,
  input: { readonly reviewerModel: string; readonly implementerModel: string; readonly primaryModel: string | null },
): IndependenceVerdict {
  const reviewer = resolveModelFamily(policy, input.reviewerModel);
  if (reviewer === null) return { eligible: false, reason: 'unknown-reviewer-family' };
  const implementer = resolveModelFamily(policy, input.implementerModel);
  if (implementer === null) return { eligible: false, reason: 'unknown-implementer-family' };
  if (reviewer === implementer) return { eligible: false, reason: 'same-family-as-implementer' };
  if (input.primaryModel !== null) {
    const primary = resolveModelFamily(policy, input.primaryModel);
    if (primary === null) return { eligible: false, reason: 'unknown-primary-family' };
    if (reviewer === primary) return { eligible: false, reason: 'same-family-as-primary' };
  }
  return { eligible: true, family: reviewer };
}

// --- who satisfies independent review ------------------------------------------------

export type IndependentReviewRequirement =
  | { readonly kind: 'not-required' }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'human' }
  | { readonly kind: 'promoted-model'; readonly reviewerConfigIds: readonly string[] };

/**
 * Who satisfies the approval matrix's independent review for a risk. A promoted model
 * reviewer counts only where the policy lists `promoted-model` and only for configured
 * reviewer ids; otherwise a human is required. Deferred risks stay deferred whatever
 * is promoted.
 */
export function independentReviewRequirement(
  policy: ReviewPolicy,
  risk: RiskLevel,
  promotedReviewerConfigIds: readonly string[],
): IndependentReviewRequirement {
  const mode = policy.modes[risk];
  if (mode === 'deferred') return { kind: 'deferred' };
  if (mode === 'not-required') return { kind: 'not-required' };
  const satisfiedBy = policy.independentReviewSatisfiedBy[risk] ?? ['human'];
  if (satisfiedBy.includes('promoted-model')) {
    const configured = new Set(policy.reviewers.map((r) => r.id));
    const promoted = [...new Set(promotedReviewerConfigIds)].filter((id) => configured.has(id)).sort();
    if (promoted.length > 0) return { kind: 'promoted-model', reviewerConfigIds: promoted };
  }
  return { kind: 'human' };
}

// --- egress classification --------------------------------------------------------------

/** Whether a project has opted in to sending review packets to a reviewer gateway. */
export function isEgressEnabled(policy: ReviewPolicy, projectId: string): boolean {
  return policy.egress.enabledProjects.includes(projectId);
}

function isNormalizedRepoPath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const GLOB_CACHE = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      source += '.*';
      i += 2;
    } else {
      const ch = glob[i]!;
      source += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Case-insensitive glob match over a repo-relative POSIX path: `**` spans directories
 * (`**\/` also matches zero of them); `*` and `?` stay within one segment.
 */
export function matchesPathGlob(glob: string, path: string): boolean {
  let re = GLOB_CACHE.get(glob);
  if (re === undefined) {
    re = globToRegExp(glob);
    GLOB_CACHE.set(glob, re);
  }
  return re.test(path);
}

/**
 * Whether a path is sensitive by the policy's classification. A path that is not a
 * normalized repo-relative path is treated as sensitive.
 */
export function isSensitivePath(policy: ReviewPolicy, path: string): boolean {
  if (!isNormalizedRepoPath(path)) return true;
  return policy.egress.denyPathGlobs.some((glob) => matchesPathGlob(glob, path));
}
