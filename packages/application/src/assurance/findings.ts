// Deterministic findings: the rule table, the finding shape the checks produce, and
// the fingerprint used to de-duplicate findings per raiser.

import type { FindingSeverity } from '@asep/domain';
import { isNormalizedRepoPath } from '@asep/policy';
import { sha256Hex } from './canonical-json.js';
import type { FindingCategory } from './local-types.js';

export type CheckRuleId =
  | 'secret-in-diff'
  | 'forbidden-path'
  | 'unscannable-sensitive-change'
  | 'trojan-source'
  | 'exit-code-verdict-mismatch'
  | 'required-check-missing'
  | 'zero-tests-executed'
  | 'skipped-tests-introduced'
  | 'test-file-deleted'
  | 'dependency-manifest-changed'
  | 'lockfile-changed'
  | 'forbidden-import'
  | 'invariant-check-invalid'
  | 'sarif-malformed';

export const CHECK_RULES: Readonly<
  Record<CheckRuleId, { readonly severity: FindingSeverity; readonly category: FindingCategory; readonly summary: string }>
> = Object.freeze({
  // Push guard: these block the round in every mode.
  'secret-in-diff': { severity: 'CRITICAL', category: 'SECURITY', summary: 'an added line matches a secret pattern' },
  'forbidden-path': { severity: 'CRITICAL', category: 'ARCHITECTURE', summary: 'a change touches a forbidden or out-of-scope path' },
  'unscannable-sensitive-change': {
    severity: 'CRITICAL',
    category: 'SECURITY',
    summary: 'content that cannot be scanned changed at a sensitive path',
  },
  'trojan-source': { severity: 'HIGH', category: 'SECURITY', summary: 'an added line contains invisible or bidirectional characters' },
  // False-green evidence: reported in every mode, blocking only where gating applies.
  'exit-code-verdict-mismatch': {
    severity: 'HIGH',
    category: 'EVIDENCE_INTEGRITY',
    summary: 'a check is recorded as passing while its raw exit code is non-zero',
  },
  'required-check-missing': {
    severity: 'HIGH',
    category: 'EVIDENCE_INTEGRITY',
    summary: 'an acceptance check of the work order is missing from the evidence',
  },
  'zero-tests-executed': { severity: 'HIGH', category: 'EVIDENCE_INTEGRITY', summary: 'a test check exited 0 having run zero tests' },
  'skipped-tests-introduced': { severity: 'HIGH', category: 'EVIDENCE_INTEGRITY', summary: 'the change adds a test skip marker' },
  'test-file-deleted': { severity: 'MEDIUM', category: 'EVIDENCE_INTEGRITY', summary: 'the change deletes a test file' },
  // Informational flags for the human reviewer.
  'dependency-manifest-changed': { severity: 'INFO', category: 'SECURITY', summary: 'a dependency manifest changed' },
  'lockfile-changed': { severity: 'INFO', category: 'SECURITY', summary: 'a dependency lockfile changed' },
  // Architecture invariants with a machine check.
  'forbidden-import': { severity: 'HIGH', category: 'ARCHITECTURE', summary: 'an added import violates an architecture invariant' },
  'invariant-check-invalid': {
    severity: 'HIGH',
    category: 'ARCHITECTURE',
    summary: 'an architecture invariant check cannot be evaluated',
  },
  'sarif-malformed': { severity: 'HIGH', category: 'EVIDENCE_INTEGRITY', summary: 'tool output in SARIF cannot be read' },
});

export interface CheckFinding {
  readonly source: 'deterministic' | 'sarif';
  /** `deterministic:<ruleId>` or `sarif:<tool>`. */
  readonly raisedBy: string;
  /** A CheckRuleId, `forbidden-import:<invariantId>`, or the SARIF rule id (null when absent). */
  readonly ruleId: string | null;
  readonly severity: FindingSeverity;
  readonly category: FindingCategory;
  readonly file: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  /** Never contains a secret value. */
  readonly evidence: string;
  readonly requiredFix: string;
  readonly fingerprint: string;
}

const LINE_BUCKET = 10;

/** sha256 over category, normalized path, line bucket (10 lines) and rule id. */
export function findingFingerprint(input: {
  readonly category: FindingCategory;
  readonly file: string | null;
  readonly lineStart: number | null;
  readonly ruleId: string | null;
}): string {
  const bucket = input.lineStart === null ? '' : String(Math.floor(input.lineStart / LINE_BUCKET));
  return sha256Hex([input.category, input.file ?? '', bucket, input.ruleId ?? ''].join('\n'));
}

/** A path as finding text shows it: verbatim when normalized, JSON-quoted otherwise. */
export function displayPath(path: string): string {
  return isNormalizedRepoPath(path) ? path : JSON.stringify(path);
}

/**
 * A finding of a deterministic rule, fingerprinted. A finding without a file (for
 * example a missing check) passes `subject`, which stands in for the path in its
 * fingerprint so distinct subjects stay distinct. A file that is not a normalized path
 * is never recorded as the finding's file: it becomes the quoted subject instead.
 */
export function ruleFinding(
  ruleId: CheckRuleId,
  at: {
    readonly file: string | null;
    readonly lineStart: number | null;
    readonly lineEnd?: number | null;
    readonly subject?: string;
  },
  evidence: string,
  requiredFix: string,
  qualifier?: string,
): CheckFinding {
  const rule = CHECK_RULES[ruleId];
  const qualified = qualifier === undefined ? ruleId : `${ruleId}:${qualifier}`;
  const unsafe = at.file !== null && !isNormalizedRepoPath(at.file);
  const file = unsafe ? null : at.file;
  const lineStart = unsafe ? null : at.lineStart;
  return {
    source: 'deterministic',
    raisedBy: `deterministic:${qualified}`,
    ruleId: qualified,
    severity: rule.severity,
    category: rule.category,
    file,
    lineStart,
    lineEnd: unsafe ? null : (at.lineEnd ?? at.lineStart),
    evidence,
    requiredFix,
    fingerprint: findingFingerprint({
      category: rule.category,
      file: unsafe ? `path:${JSON.stringify(at.file)}` : (file ?? at.subject ?? null),
      lineStart,
      ruleId: qualified,
    }),
  };
}

export interface RuleHit {
  readonly file: string;
  readonly line: number;
  /** What matched; never a secret value. */
  readonly detail: string;
}

/**
 * One finding per file and line bucket: hits that would share a fingerprint are merged
 * into a single finding spanning their lines, with each hit listed in the evidence.
 */
export function mergeRuleHits(
  ruleId: CheckRuleId,
  hits: readonly RuleHit[],
  requiredFix: string,
  qualifier?: string,
): CheckFinding[] {
  const groups = new Map<string, RuleHit[]>();
  for (const hit of [...hits].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))) {
    const key = `${hit.file}\n${Math.floor(hit.line / LINE_BUCKET)}`;
    groups.set(key, [...(groups.get(key) ?? []), hit]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const evidence = `${CHECK_RULES[ruleId].summary}: ${displayPath(first.file)} ${group.map((h) => `line ${h.line} (${h.detail})`).join('; ')}`;
    return ruleFinding(ruleId, { file: first.file, lineStart: first.line, lineEnd: last.line }, evidence, requiredFix, qualifier);
  });
}

/** Keep the first finding per (raiser, fingerprint) and order the result deterministically. */
export function dedupeFindings(findings: readonly CheckFinding[]): CheckFinding[] {
  const key = (f: CheckFinding) => `${f.raisedBy}\n${f.fingerprint}`;
  const order = (a: CheckFinding, b: CheckFinding): number => {
    const fields = [
      [a.raisedBy, b.raisedBy],
      [a.file ?? '', b.file ?? ''],
    ] as const;
    for (const [x, y] of fields) if (x !== y) return x < y ? -1 : 1;
    if ((a.lineStart ?? 0) !== (b.lineStart ?? 0)) return (a.lineStart ?? 0) - (b.lineStart ?? 0);
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  };
  const seen = new Set<string>();
  const out: CheckFinding[] = [];
  for (const finding of [...findings].sort(order)) {
    if (seen.has(key(finding))) continue;
    seen.add(key(finding));
    out.push(finding);
  }
  return out;
}
