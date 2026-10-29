// Deterministic checks over a built review packet: the push guard, false-green
// evidence, Trojan Source characters, dependency flags, forbidden imports declared by
// architecture invariants, and one finding per SARIF log, which is not parsed. Together
// with the egress decision they form the round's check result.
//
// Pure: callers resolve artifacts and pass bytes in. A diff that cannot be read never
// passes the push guard. Finding text never repeats a secret value.

import type { ArtifactRef } from '@asep/contracts';
import { isNormalizedRepoPath, isSensitivePath, matchesPathGlob, type ReviewPolicy } from '@asep/policy';
import { sha256Hex, tupleKey } from './canonical-json.js';
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
  return tupleKey(diffPaths) === tupleKey(packetPaths) ? files : null;
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
  // A rename changes its source path; a copy leaves its source as it was.
  for (const file of diff) if (file.status === 'R' && file.oldPath !== null) touched.add(file.oldPath);
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
    if (verdict !== 'PASS' || check === undefined) continue;
    if (check.exitCode !== 0) {
      findings.push(
        ruleFinding(
          'exit-code-verdict-mismatch',
          { file: null, lineStart: null, subject: `check:${checkId}` },
          `check "${checkId}" (${check.command}) is recorded PASS but its raw exit code is ${check.exitCode}`,
          'Fix the evidence reduction so the recorded verdict follows the raw exit code',
        ),
      );
    }
    if (check.testSummary !== null && check.testSummary.fail > 0) {
      findings.push(
        ruleFinding(
          'failed-tests-recorded-pass',
          { file: null, lineStart: null, subject: `check:${checkId}` },
          `check "${checkId}" (${check.command}) is recorded PASS but its ${check.testSummary.runner} summary reports ${check.testSummary.fail} failed`,
          'Fix the evidence reduction so a run with failing tests is never recorded as passing',
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

  // Executed tests are the summary's tests less those skipped or left todo. A run that
  // executed none proves nothing, whatever its exit code. An unparsed format raises nothing.
  for (const check of packet.execution.checks) {
    const summary = check.testSummary;
    if (!TEST_CATEGORIES.has(check.category) || summary === null) continue;
    const executed = summary.tests - summary.skipped - summary.todo;
    if (executed <= 0) {
      findings.push(
        ruleFinding(
          'zero-tests-executed',
          { file: null, lineStart: null, subject: `check:${check.id}` },
          `check "${check.id}" (${check.command}) exited ${check.exitCode} but its ${summary.runner} summary reports ${summary.tests} tests, ` +
            `${summary.skipped} skipped and ${summary.todo} todo: none executed`,
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

// --- SARIF logs (not parsed in this phase) ---------------------------------------------------------

/** The rule of the one finding a SARIF log yields: logs are not parsed in this phase. */
export const SARIF_UNPARSED_RULE = 'sarif-unparsed';

/**
 * The one finding of a SARIF log, built from the identity the check report records for the
 * log: its check and the sha256 and size of its bytes. The log is never decoded, so nothing it
 * holds can drop, downgrade or relabel a result, and only a human who reads it can close the
 * finding. A new log of the same check is a new finding, so no disposition covers bytes it did
 * not see.
 */
export function sarifLogFinding(log: { readonly checkId: string; readonly sha256: string; readonly bytes: number }): CheckFinding {
  const category: FindingCategory = 'EVIDENCE_INTEGRITY';
  return {
    source: 'sarif',
    raisedBy: 'sarif:unparsed',
    ruleId: SARIF_UNPARSED_RULE,
    severity: 'HIGH',
    category,
    file: null,
    lineStart: null,
    lineEnd: null,
    evidence: `the SARIF log of check ${JSON.stringify(log.checkId)} (sha256 ${log.sha256}, ${log.bytes} bytes) is not parsed in this phase, so its results are unread`,
    requiredFix: 'A human reads the SARIF log and records a disposition for this finding',
    fingerprint: findingFingerprint({ category, file: tupleKey(['sarif-log', log.checkId, log.sha256]), lineStart: null, ruleId: SARIF_UNPARSED_RULE }),
  };
}

/** The findings of one SARIF log: exactly one, whatever its bytes hold. */
export function sarifFindings(input: SarifInput): CheckFinding[] {
  return [sarifLogFinding({ checkId: input.checkId, sha256: sha256Hex(input.content), bytes: input.content.byteLength })];
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
