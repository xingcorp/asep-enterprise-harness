// The round's check report: the canonical record of what the deterministic checks
// decided, written once and re-read by content address by every later step.
//
// It carries the packet it covers, the push-guard decision, the egress decision with
// its hits, every deterministic and SARIF finding, and the SARIF inputs the checks
// read. There is no timestamp in it, so its sha256 depends only on what was checked.
// The parser is strict: unknown keys, wrong types, a decision that does not follow from the
// report's own findings and hits, or a digest mismatch fail closed, because a reviewer request
// is cleared from this record.

import type { FindingSeverity } from '@asep/domain';
import { REVIEW_SEVERITIES } from '@asep/policy';
import { canonicalBytes, sha256Hex } from './canonical-json.js';
import { pushGuardDecision, type DeterministicCheckResult, type PushGuardResult, type SarifInput } from './checks.js';
import { egressDecisionFor, type EgressHit, type ReviewerClearance } from './egress.js';
import type { CheckFinding } from './findings.js';
import type { BlockReason, EgressDecision, FindingCategory } from './local-types.js';

export const CHECK_REPORT_VERSION = 'check-report/v1';

export interface CheckReport {
  readonly reportVersion: typeof CHECK_REPORT_VERSION;
  /** The packet the checks ran over; the egress decision covers the same packet. */
  readonly packetSha256: string;
  readonly pushGuard: PushGuardResult;
  readonly egress: { readonly decision: EgressDecision; readonly packetSha256: string; readonly hits: readonly EgressHit[] };
  readonly findings: readonly CheckFinding[];
  /** The SARIF logs the checks parsed, by check id, with the digest of the exact bytes read. */
  readonly sarifInputs: readonly { readonly checkId: string; readonly sha256: string; readonly bytes: number }[];
}

export interface BuiltCheckReport {
  readonly report: CheckReport;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export class CheckReportError extends Error {
  constructor(message: string) {
    super(`check report: ${message}`);
    this.name = 'CheckReportError';
  }
}

function reject(message: string): never {
  throw new CheckReportError(message);
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Build the canonical check report for one round's deterministic check result. */
export function buildCheckReport(
  result: DeterministicCheckResult,
  inputs: { readonly packetSha256: string; readonly sarif: readonly SarifInput[] },
): BuiltCheckReport {
  if (!SHA256.test(inputs.packetSha256)) reject('packetSha256 must be 64 lowercase hex');
  if (result.egress.packetSha256 !== inputs.packetSha256) reject('the egress decision covers another packet');
  const report: CheckReport = {
    reportVersion: CHECK_REPORT_VERSION,
    packetSha256: inputs.packetSha256,
    pushGuard: result.pushGuard,
    egress: { decision: result.egress.decision, packetSha256: result.egress.packetSha256, hits: result.egress.hits },
    findings: result.findings,
    sarifInputs: [...inputs.sarif]
      .map((s) => ({ checkId: s.checkId, sha256: sha256Hex(s.content), bytes: s.content.byteLength }))
      .sort((a, b) => (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0)),
  };
  // Round-trip through the parser so a report that could not be re-read is never written.
  const bytes = canonicalBytes(report);
  const sha256 = sha256Hex(bytes);
  return { report: parseCheckReport(bytes, sha256), bytes, sha256 };
}

/** The finding counts a check step reports for a plan's blocking severities. */
export function checkReportSummary(
  report: CheckReport,
  blockingSeverities: readonly FindingSeverity[],
): { readonly total: number; readonly blocking: number } {
  const blocking = new Set(blockingSeverities);
  return { total: report.findings.length, blocking: report.findings.filter((f) => blocking.has(f.severity)).length };
}

/** What a reviewer request is cleared against. */
export function reviewerClearance(report: CheckReport): ReviewerClearance {
  return { pushGuard: report.pushGuard, egress: { decision: report.egress.decision, packetSha256: report.egress.packetSha256 } };
}

// --- strict parser ------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const BLOCK_REASONS: ReadonlySet<string> = new Set<BlockReason>(['secret-in-diff', 'forbidden-path', 'unscannable-sensitive-change']);
const EGRESS_DECISIONS: ReadonlySet<string> = new Set<EgressDecision>(['CLEAR', 'STOP_SECRET', 'STOP_CLASSIFIED', 'STOP_UNSCANNABLE']);
const HIT_KINDS: ReadonlySet<string> = new Set<EgressHit['kind']>(['not-opted-in', 'deny-path', 'unscannable', 'secret']);
const SEVERITIES: ReadonlySet<string> = new Set<string>(REVIEW_SEVERITIES);
const CATEGORIES: ReadonlySet<string> = new Set<FindingCategory>([
  'SPEC',
  'ARCHITECTURE',
  'CORRECTNESS',
  'SECURITY',
  'PERFORMANCE',
  'TEST_QUALITY',
  'MAINTAINABILITY',
  'EVIDENCE_INTEGRITY',
]);

function object(value: unknown, at: string, keys: readonly string[]): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(`${at} must be an object`);
  const record = value as Json;
  const extra = Object.keys(record).filter((k) => !keys.includes(k));
  if (extra.length > 0) reject(`${at} has unknown keys: ${extra.sort().join(', ')}`);
  for (const key of keys) if (!(key in record)) reject(`${at}.${key} is required`);
  return record;
}

function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) reject(`${at} must be a list`);
  return value;
}

function text(value: unknown, at: string): string {
  if (typeof value !== 'string') reject(`${at} must be a string`);
  return value;
}

function nullableText(value: unknown, at: string): string | null {
  return value === null ? null : text(value, at);
}

function oneOf(value: unknown, at: string, allowed: ReadonlySet<string>): string {
  const v = text(value, at);
  if (!allowed.has(v)) reject(`${at} has an unknown value`);
  return v;
}

function digest(value: unknown, at: string): string {
  const v = text(value, at);
  if (!SHA256.test(v)) reject(`${at} must be 64 lowercase hex`);
  return v;
}

function nullableLine(value: unknown, at: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) reject(`${at} must be a positive integer or null`);
  return value;
}

function pushGuard(value: unknown): PushGuardResult {
  const decision = (value as Json | null)?.['decision'];
  if (decision === 'PASS') {
    object(value, 'pushGuard', ['decision']);
    return { decision: 'PASS' };
  }
  if (decision === 'BLOCK') {
    const record = object(value, 'pushGuard', ['decision', 'reason']);
    return { decision: 'BLOCK', reason: oneOf(record['reason'], 'pushGuard.reason', BLOCK_REASONS) as BlockReason };
  }
  return reject('pushGuard.decision must be PASS or BLOCK');
}

const FINDING_KEYS = [
  'source',
  'raisedBy',
  'ruleId',
  'severity',
  'category',
  'file',
  'lineStart',
  'lineEnd',
  'evidence',
  'requiredFix',
  'fingerprint',
] as const;

function finding(value: unknown, at: string): CheckFinding {
  const f = object(value, at, FINDING_KEYS);
  const source = text(f['source'], `${at}.source`);
  if (source !== 'deterministic' && source !== 'sarif') reject(`${at}.source must be deterministic or sarif`);
  const raisedBy = text(f['raisedBy'], `${at}.raisedBy`);
  if (!raisedBy.startsWith(`${source}:`)) reject(`${at}.raisedBy must name its ${source} source`);
  const lineStart = nullableLine(f['lineStart'], `${at}.lineStart`);
  const lineEnd = nullableLine(f['lineEnd'], `${at}.lineEnd`);
  if (lineEnd !== null && (lineStart === null || lineEnd < lineStart)) reject(`${at} has an invalid line range`);
  return {
    source,
    raisedBy,
    ruleId: nullableText(f['ruleId'], `${at}.ruleId`),
    severity: oneOf(f['severity'], `${at}.severity`, SEVERITIES) as FindingSeverity,
    category: oneOf(f['category'], `${at}.category`, CATEGORIES) as FindingCategory,
    file: nullableText(f['file'], `${at}.file`),
    lineStart,
    lineEnd,
    evidence: text(f['evidence'], `${at}.evidence`),
    requiredFix: text(f['requiredFix'], `${at}.requiredFix`),
    fingerprint: digest(f['fingerprint'], `${at}.fingerprint`),
  };
}

/**
 * Parse check-report bytes that must hash to `expectedSha256`. Throws CheckReportError on a
 * digest mismatch, non-UTF-8 or non-JSON bytes, unknown or missing keys, wrong types, an egress
 * decision for another packet, or a push-guard or egress decision that does not follow from the
 * report's own findings and hits.
 */
export function parseCheckReport(bytes: Uint8Array, expectedSha256: string): CheckReport {
  if (sha256Hex(bytes) !== expectedSha256) reject('bytes do not match the expected sha256');
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return reject('bytes are not UTF-8 JSON');
  }
  const root = object(doc, 'report', ['reportVersion', 'packetSha256', 'pushGuard', 'egress', 'findings', 'sarifInputs']);
  if (root['reportVersion'] !== CHECK_REPORT_VERSION) reject(`reportVersion must be ${CHECK_REPORT_VERSION}`);
  const packetSha256 = digest(root['packetSha256'], 'packetSha256');
  const egress = object(root['egress'], 'egress', ['decision', 'packetSha256', 'hits']);
  const egressPacket = digest(egress['packetSha256'], 'egress.packetSha256');
  if (egressPacket !== packetSha256) reject('the egress decision covers another packet');
  const hits = list(egress['hits'], 'egress.hits').map((value, i) => {
    const hit = object(value, `egress.hits[${i}]`, ['kind', 'part', 'detail']);
    return {
      kind: oneOf(hit['kind'], `egress.hits[${i}].kind`, HIT_KINDS) as EgressHit['kind'],
      part: text(hit['part'], `egress.hits[${i}].part`),
      detail: text(hit['detail'], `egress.hits[${i}].detail`),
    };
  });
  const decision = oneOf(egress['decision'], 'egress.decision', EGRESS_DECISIONS) as EgressDecision;
  if (decision !== egressDecisionFor(hits)) reject('egress.decision does not follow from its hits');
  const findings = list(root['findings'], 'findings').map((value, i) => finding(value, `findings[${i}]`));
  const guard = pushGuard(root['pushGuard']);
  const implied = pushGuardDecision(findings);
  const reasonOf = (g: PushGuardResult) => (g.decision === 'BLOCK' ? g.reason : null);
  if (guard.decision !== implied.decision || reasonOf(guard) !== reasonOf(implied)) reject('pushGuard does not follow from the findings');
  return {
    reportVersion: CHECK_REPORT_VERSION,
    packetSha256,
    pushGuard: guard,
    egress: { decision, packetSha256: egressPacket, hits },
    findings,
    sarifInputs: list(root['sarifInputs'], 'sarifInputs').map((value, i) => {
      const s = object(value, `sarifInputs[${i}]`, ['checkId', 'sha256', 'bytes']);
      const size = s['bytes'];
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) reject(`sarifInputs[${i}].bytes must be a non-negative integer`);
      return { checkId: text(s['checkId'], `sarifInputs[${i}].checkId`), sha256: digest(s['sha256'], `sarifInputs[${i}].sha256`), bytes: size };
    }),
  };
}
