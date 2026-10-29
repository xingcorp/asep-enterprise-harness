// Deterministic checks over a built review packet: the push guard, false-green
// evidence, Trojan Source characters, dependency flags, forbidden imports declared by
// architecture invariants, and SARIF results. Together with the egress decision they
// form the round's check result.
//
// Pure: callers resolve artifacts and pass bytes in. A diff that cannot be read never
// passes the push guard. Finding text never repeats a secret value.

import type { ArtifactRef } from '@asep/contracts';
import { isNormalizedRepoPath, isSensitivePath, matchesPathGlob, type ReviewPolicy } from '@asep/policy';
import type { FindingSeverity } from '@asep/domain';
import { sha256Hex } from './canonical-json.js';
import { parseUnifiedDiff, type DiffFileChange } from './diff.js';
import { decideEgress, type EgressResult } from './egress.js';
import {
  CHECK_RULES,
  dedupeFindings,
  displayPath,
  findingFingerprint,
  mergeRuleHits,
  ruleFinding,
  type CheckFinding,
  type RuleHit,
} from './findings.js';
import type { ArchitectureInvariantRecord, BlockReason, FindingCategory, ReviewPacket } from './local-types.js';
import type { BuiltPacket } from './packet.js';
import { findSecrets } from './secret-patterns.js';

export interface RecordedCheckVerdict {
  readonly checkId: string;
  readonly verdict: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
}

export interface SarifInput {
  /** The check whose raw output this SARIF log is. */
  readonly checkId: string;
  readonly content: Uint8Array;
}

export interface DeterministicCheckSources {
  readonly policy: ReviewPolicy;
  readonly built: Pick<BuiltPacket, 'packet' | 'bytes' | 'sha256'>;
  /** Artifact contents by id: the diffs and post-images the packet references. */
  readonly contents: ReadonlyMap<string, Uint8Array>;
  /** Verdicts the verification step recorded per check. */
  readonly recordedVerdicts: readonly RecordedCheckVerdict[];
  readonly invariants: readonly ArchitectureInvariantRecord[];
  readonly sarif: readonly SarifInput[];
}

export type PushGuardResult = { readonly decision: 'PASS' } | { readonly decision: 'BLOCK'; readonly reason: BlockReason };

export interface DeterministicCheckResult {
  readonly pushGuard: PushGuardResult;
  readonly egress: EgressResult;
  readonly findings: readonly CheckFinding[];
}

// --- path classes ------------------------------------------------------------------------

const TEST_PATH =
  /(^|\/)(__tests__|tests?|spec|itest)\/|\.(test|spec|itest)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|(Test|Tests|IT)\.(java|kt)$/;

/** Whether a repo path is a test file by common naming conventions. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

const MANIFESTS = new Set([
  'package.json',
  'go.mod',
  'Cargo.toml',
  'requirements.txt',
  'Pipfile',
  'pyproject.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
]);

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'go.sum',
  'Cargo.lock',
  'Pipfile.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// --- diff ------------------------------------------------------------------------------------

/** The parsed cumulative diff, or null when it cannot be read, verified, decoded or parsed. */
function readDiff(packet: ReviewPacket, contents: ReadonlyMap<string, Uint8Array>): DiffFileChange[] | null {
  const ref = packet.change.cumulativeDiff;
  const files = parseArtifact(ref, contents);
  if (files === null) return null;
  const diffPaths = files.map((f) => f.path).sort();
  const packetPaths = packet.change.files.map((f) => f.path).sort();
  return diffPaths.join('\n') === packetPaths.join('\n') ? files : null;
}

/** A diff artifact parsed, or null when it is unavailable, off its digest, not UTF-8 or unparseable. */
function parseArtifact(ref: ArtifactRef, contents: ReadonlyMap<string, Uint8Array>): DiffFileChange[] | null {
  const bytes = contents.get(ref.artifactId);
  if (bytes === undefined || sha256Hex(bytes) !== ref.sha256) return null;
  try {
    return parseUnifiedDiff(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

// --- push guard --------------------------------------------------------------------------------

const UNSCANNABLE_OMISSIONS = new Set(['binary', 'too-large', 'non-utf8', 'submodule']);

/** Every path the packet and its diffs name, each side of each entry, sorted and distinct. */
function namedPaths(packet: ReviewPacket, diffs: readonly (readonly DiffFileChange[] | null)[]): string[] {
  const paths = new Set(packet.change.files.map((f) => f.path));
  for (const diff of diffs) {
    for (const file of diff ?? []) {
      paths.add(file.path);
      if (file.oldPath !== null) paths.add(file.oldPath);
    }
  }
  return [...paths].sort();
}

function pushGuardFindings(
  packet: ReviewPacket,
  diff: DiffFileChange[] | null,
  repairDelta: DiffFileChange[] | null,
  policy: ReviewPolicy,
): CheckFinding[] {
  // A path that is not normalizable blocks wherever it appears: it can hide from the
  // path globs below, so no glob is asked about it.
  const unsafe = namedPaths(packet, [diff, repairDelta]).filter((path) => !isNormalizedRepoPath(path));
  const unsafeFindings = unsafe.map((path) =>
    ruleFinding(
      'forbidden-path',
      { file: null, lineStart: null, subject: `path:${JSON.stringify(path)}` },
      `the changed path ${JSON.stringify(path)} is not a normalized repository path (a control or line-separator character, or an unresolved quoted form)`,
      'Rename the file to a plain repository path',
    ),
  );
  if (diff === null) {
    return [
      ...unsafeFindings,
      ruleFinding(
        'unscannable-sensitive-change',
        { file: null, lineStart: null, subject: 'diff' },
        'the cumulative diff cannot be read, verified or parsed, so no added line could be scanned',
        'Regenerate the change so its diff can be scanned',
      ),
    ];
  }
  const findings: CheckFinding[] = [...unsafeFindings];

  const secretHits: RuleHit[] = [];
  for (const file of diff) {
    for (const added of file.added) {
      const labels = [...new Set(findSecrets(added.text).map((h) => h.label))];
      if (labels.length > 0) secretHits.push({ file: file.path, line: added.line, detail: labels.join(', ') });
    }
  }
  findings.push(...mergeRuleHits('secret-in-diff', secretHits, 'Remove the secret from the change and rotate it'));

  const { allowedPaths, forbiddenChanges } = packet.workOrder;
  const touched = new Set(packet.change.files.map((f) => f.path));
  for (const file of diff) if (file.oldPath !== null) touched.add(file.oldPath);
  for (const path of [...touched].sort()) {
    if (!isNormalizedRepoPath(path)) continue;
    const forbiddenBy = forbiddenChanges.find((glob) => matchesPathGlob(glob, path));
    const allowed = allowedPaths.some((glob) => matchesPathGlob(glob, path, { caseSensitive: true }));
    if (forbiddenBy !== undefined || !allowed) {
      findings.push(
        ruleFinding(
          'forbidden-path',
          { file: path, lineStart: null },
          forbiddenBy !== undefined
            ? `${path} matches the forbidden change ${forbiddenBy}`
            : `${path} is outside the work order's allowed paths`,
          'Revert the change to this path or amend the work order through review',
        ),
      );
    }
  }

  for (const file of packet.change.files) {
    if (file.omittedReason !== null && UNSCANNABLE_OMISSIONS.has(file.omittedReason) && isSensitivePath(policy, file.path)) {
      findings.push(
        ruleFinding(
          'unscannable-sensitive-change',
          { file: file.path, lineStart: null },
          `${displayPath(file.path)} changed at a sensitive path and its content cannot be scanned (${file.omittedReason})`,
          'Remove the file from the change or replace it with scannable content',
        ),
      );
    }
  }
  return findings;
}

const BLOCK_ORDER: readonly BlockReason[] = ['secret-in-diff', 'forbidden-path', 'unscannable-sensitive-change'];

/** The push-guard decision a set of findings implies: the first block reason, in order, that a finding carries. */
export function pushGuardDecision(findings: readonly CheckFinding[]): PushGuardResult {
  for (const reason of BLOCK_ORDER) {
    if (findings.some((f) => f.ruleId === reason)) return { decision: 'BLOCK', reason };
  }
  return { decision: 'PASS' };
}

// --- false-green evidence ----------------------------------------------------------------------

const TEST_CATEGORIES = new Set(['unit', 'integration', 'acceptance']);

const SKIP_MARKERS: readonly RegExp[] = [
  /\.skip\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/,
  /\bdescribe\.skip\b/,
  /\btest\.skip\b/,
  /@Disabled\b/,
  /\bpytest\.mark\.skip/,
  /\bt\.Skip\s*\(/,
];

function falseGreenFindings(
  packet: ReviewPacket,
  recorded: readonly RecordedCheckVerdict[],
  diff: DiffFileChange[] | null,
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const checks = new Map(packet.execution.checks.map((c) => [c.id, c] as const));

  for (const { checkId, verdict } of recorded) {
    const check = checks.get(checkId);
    if (verdict === 'PASS' && check !== undefined && check.exitCode !== 0) {
      findings.push(
        ruleFinding(
          'exit-code-verdict-mismatch',
          { file: null, lineStart: null, subject: `check:${checkId}` },
          `check "${checkId}" (${check.command}) is recorded PASS but its raw exit code is ${check.exitCode}`,
          'Fix the evidence reduction so the recorded verdict follows the raw exit code',
        ),
      );
    }
  }

  for (const checkId of packet.workOrder.acceptanceCheckIds) {
    if (!checks.has(checkId)) {
      findings.push(
        ruleFinding(
          'required-check-missing',
          { file: null, lineStart: null, subject: `check:${checkId}` },
          `acceptance check "${checkId}" of the work order has no execution record in the evidence`,
          'Run the missing acceptance check and record its raw output',
        ),
      );
    }
  }

  for (const check of packet.execution.checks) {
    if (TEST_CATEGORIES.has(check.category) && check.exitCode === 0 && check.testSummary !== null && check.testSummary.tests === 0) {
      findings.push(
        ruleFinding(
          'zero-tests-executed',
          { file: null, lineStart: null, subject: `check:${check.id}` },
          `check "${check.id}" (${check.command}) exited 0 but its ${check.testSummary.runner} summary reports 0 tests`,
          'Make the check execute the tests it is meant to run',
        ),
      );
    }
  }

  if (diff !== null) {
    const hits: RuleHit[] = [];
    for (const file of diff) {
      if (!isTestPath(file.path)) continue;
      for (const added of file.added) {
        const marker = SKIP_MARKERS.find((re) => re.test(added.text));
        if (marker !== undefined) hits.push({ file: file.path, line: added.line, detail: `matches ${marker.source}` });
      }
    }
    findings.push(...mergeRuleHits('skipped-tests-introduced', hits, 'Remove the skip marker or justify it in review'));
  }

  for (const file of packet.change.files) {
    if (file.status === 'D' && isTestPath(file.path)) {
      findings.push(
        ruleFinding(
          'test-file-deleted',
          { file: file.path, lineStart: null },
          `test file ${displayPath(file.path)} is deleted by the change`,
          'Keep the test or show which test now covers its behaviour',
        ),
      );
    }
  }
  return findings;
}

// --- Trojan Source -----------------------------------------------------------------------------

// Bidirectional controls and invisible characters (Trojan Source, CVE-2021-42574).
const HIDDEN = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\u2060\uFEFF]/g;

function trojanSourceFindings(diff: DiffFileChange[] | null): CheckFinding[] {
  if (diff === null) return [];
  const hits: RuleHit[] = [];
  for (const file of diff) {
    for (const added of file.added) {
      // A byte-order mark that opens a file is an encoding marker, not hidden logic.
      const text = added.line === 1 && added.text.startsWith('\uFEFF') ? added.text.slice(1) : added.text;
      const points = [...new Set([...text.matchAll(HIDDEN)].map((m) => m[0].codePointAt(0)!))];
      if (points.length > 0) {
        const detail = points.map((p) => `U+${p.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
        hits.push({ file: file.path, line: added.line, detail });
      }
    }
  }
  return mergeRuleHits('trojan-source', hits, 'Remove the invisible or bidirectional characters');
}

// --- dependencies and invariants ---------------------------------------------------------------

function dependencyFindings(packet: ReviewPacket): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const file of packet.change.files) {
    const name = basename(file.path);
    if (MANIFESTS.has(name)) {
      findings.push(
        ruleFinding(
          'dependency-manifest-changed',
          { file: file.path, lineStart: null },
          `dependency manifest ${displayPath(file.path)} changed`,
          'Review the dependency change',
        ),
      );
    }
    if (LOCKFILES.has(name)) {
      findings.push(
        ruleFinding('lockfile-changed', { file: file.path, lineStart: null }, `lockfile ${displayPath(file.path)} changed`, 'Review the resolved versions'),
      );
    }
  }
  return findings;
}

const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function forbiddenImportFindings(diff: DiffFileChange[] | null, invariants: readonly ArchitectureInvariantRecord[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const invariant of invariants) {
    const check = invariant.check;
    if (check === undefined) continue;
    let pattern: RegExp | null = null;
    try {
      pattern = new RegExp(check.specifierPattern);
    } catch {
      pattern = null;
    }
    if (check.kind !== 'forbidden-import' || check.fromGlobs.length === 0 || pattern === null) {
      findings.push(
        ruleFinding(
          'invariant-check-invalid',
          { file: null, lineStart: null, subject: `invariant:${invariant.id}` },
          `the machine check of architecture invariant ${invariant.id} cannot be evaluated`,
          'Fix the invariant check definition',
        ),
      );
      continue;
    }
    if (diff === null) continue;
    const hits: RuleHit[] = [];
    for (const file of diff) {
      if (!check.fromGlobs.some((glob) => matchesPathGlob(glob, file.path, { caseSensitive: true }))) continue;
      for (const added of file.added) {
        for (const m of added.text.matchAll(SPECIFIER)) {
          const specifier = m[1] ?? m[2] ?? m[3]!;
          if (pattern.test(specifier)) hits.push({ file: file.path, line: added.line, detail: `imports '${specifier}'` });
        }
      }
    }
    findings.push(
      ...mergeRuleHits('forbidden-import', hits, `Remove the import; invariant ${invariant.id}: ${invariant.statement}`, invariant.id),
    );
  }
  return findings;
}

// --- SARIF 2.1.0 subset --------------------------------------------------------------------------

class SarifError extends Error {}

const LEVEL_SEVERITY: Readonly<Record<string, FindingSeverity>> = {
  error: 'HIGH',
  warning: 'MEDIUM',
  note: 'LOW',
  none: 'INFO',
};

const EVIDENCE_LIMIT = 4000;

function obj(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SarifError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new SarifError(`${what} must be a list`);
  return value;
}

function line(value: unknown, what: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new SarifError(`${what} must be a positive integer`);
  return value;
}

function repoPath(uri: string): string | null {
  let path = uri;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  while (path.startsWith('./')) path = path.slice(2);
  return isNormalizedRepoPath(path) ? path : null;
}

function clip(text: string): string {
  return text.length <= EVIDENCE_LIMIT ? text : `${text.slice(0, EVIDENCE_LIMIT)} [truncated]`;
}

/** Findings from one SARIF log. A log that is not a readable 2.1.0 subset yields one sarif-malformed finding. */
export function sarifFindings(input: SarifInput): CheckFinding[] {
  try {
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.content));
    } catch {
      throw new SarifError('not UTF-8 JSON');
    }
    const root = obj(doc, 'log');
    if (root['version'] !== '2.1.0') throw new SarifError('version must be 2.1.0');
    const findings: CheckFinding[] = [];
    arr(root['runs'], 'runs').forEach((runValue, r) => {
      const run = obj(runValue, `runs[${r}]`);
      const name = obj(obj(run['tool'], 'tool')['driver'], 'tool.driver')['name'];
      if (typeof name !== 'string' || name.trim() === '') throw new SarifError(`runs[${r}].tool.driver.name is required`);
      const tool = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      arr(run['results'], `runs[${r}].results`).forEach((resultValue, i) => {
        const where = `runs[${r}].results[${i}]`;
        const result = obj(resultValue, where);
        const text = obj(result['message'], `${where}.message`)['text'];
        if (typeof text !== 'string' || text === '') throw new SarifError(`${where}.message.text is required`);
        const level = result['level'] ?? 'warning';
        if (typeof level !== 'string' || !(level in LEVEL_SEVERITY)) throw new SarifError(`${where}.level is not a SARIF level`);
        const ruleId = result['ruleId'] === undefined ? null : String(result['ruleId']);
        const tags = obj(result['properties'] ?? {}, `${where}.properties`)['tags'];
        const category: FindingCategory =
          Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'security') ? 'SECURITY' : 'CORRECTNESS';

        let file: string | null = null;
        let lineStart: number | null = null;
        let lineEnd: number | null = null;
        if (result['locations'] !== undefined) {
          const first = arr(result['locations'], `${where}.locations`)[0];
          if (first !== undefined) {
            const physical = obj(obj(first, `${where}.locations[0]`)['physicalLocation'] ?? {}, `${where}.physicalLocation`);
            const artifact = physical['artifactLocation'];
            const uri = artifact === undefined ? undefined : obj(artifact, `${where}.artifactLocation`)['uri'];
            const region = physical['region'] === undefined ? {} : obj(physical['region'], `${where}.region`);
            lineStart = line(region['startLine'], `${where}.region.startLine`);
            lineEnd = line(region['endLine'], `${where}.region.endLine`) ?? lineStart;
            if (lineStart !== null && lineEnd !== null && lineEnd < lineStart) throw new SarifError(`${where}.region ends before it starts`);
            file = typeof uri === 'string' ? repoPath(uri) : null;
            if (file === null) {
              lineStart = null;
              lineEnd = null;
            }
          }
        }
        findings.push({
          source: 'sarif',
          raisedBy: `sarif:${tool}`,
          ruleId,
          severity: LEVEL_SEVERITY[level]!,
          category,
          file,
          lineStart,
          lineEnd,
          evidence: clip(`[${ruleId ?? 'result'}] ${text}`),
          requiredFix: `Resolve the ${name.trim()} result ${ruleId ?? ''} reported by check ${input.checkId}`.replace(/\s+/g, ' '),
          fingerprint: findingFingerprint({ category, file: file ?? `check:${input.checkId}`, lineStart, ruleId }),
        });
      });
    });
    return findings;
  } catch (err) {
    if (!(err instanceof SarifError)) throw err;
    return [
      ruleFinding(
        'sarif-malformed',
        { file: null, lineStart: null, subject: `check:${input.checkId}` },
        `the SARIF output of check "${input.checkId}" cannot be read: ${err.message}`,
        'Produce a valid SARIF 2.1.0 log for the check',
      ),
    ];
  }
}

// --- the round's deterministic checks -----------------------------------------------------------

/** Run every deterministic rule and the egress decision over a built packet. */
export function runDeterministicCheckRules(sources: DeterministicCheckSources): DeterministicCheckResult {
  const { packet } = sources.built;
  const diff = readDiff(packet, sources.contents);
  const repairDelta = packet.change.repairDelta === null ? null : parseArtifact(packet.change.repairDelta, sources.contents);
  const guard = pushGuardFindings(packet, diff, repairDelta, sources.policy);
  const findings = dedupeFindings([
    ...guard,
    ...falseGreenFindings(packet, sources.recordedVerdicts, diff),
    ...trojanSourceFindings(diff),
    ...dependencyFindings(packet),
    ...forbiddenImportFindings(diff, sources.invariants),
    ...sources.sarif.flatMap((s) => sarifFindings(s)),
  ]);
  return {
    pushGuard: pushGuardDecision(guard),
    egress: decideEgress(sources.policy, sources.built, sources.contents),
    findings,
  };
}

export { CHECK_RULES };
