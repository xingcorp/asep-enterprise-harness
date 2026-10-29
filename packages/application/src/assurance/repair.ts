// Repair order: what a repair attempt is told after a gating REPAIR decision.
//
// It carries only grounded blocking findings (structured, cited, size-bounded) plus a
// capped set of informational findings, and anchors the repair to the reviewed
// attempt's commit. Blocking findings are never dropped to fit: an order that cannot
// hold them all is refused. Text over the per-field limit is clipped with an explicit
// marker; informational findings past the total budget are counted, not hidden.

import type { ArtifactRef } from '@asep/contracts';
import type { FindingSeverity } from '@asep/domain';
import type { Adjudication } from './adjudication.js';
import { canonicalBytes, sha256Hex, tupleSha256 } from './canonical-json.js';
import type { ReviewFindingRecord } from './local-types.js';
import { pickFindingRecord } from './packet.js';

export const REPAIR_CLOSURE_RULE =
  'a fix is verified only by a different eligible reviewer, a human, or a deterministic re-check';

export interface RepairOrderInput {
  readonly taskId: string;
  /** The attempt whose round decided REPAIR. */
  readonly fromAttemptId: string;
  readonly round: number;
  readonly taskBaseSha: string;
  /** The reviewed attempt's harness commit; the repair starts here. */
  readonly resultSha: string;
  readonly adjudication: Adjudication;
  readonly workOrderRef: ArtifactRef;
  readonly limits: { readonly perFieldBytes: number; readonly totalBytes: number };
}

export interface RepairOrder {
  /** sha256(adjudicationId|nextRound). */
  readonly repairOrderId: string;
  readonly taskId: string;
  readonly fromAttemptId: string;
  readonly nextRound: number;
  readonly taskBaseSha: string;
  readonly repairBaseSha: string;
  readonly adjudicationId: string;
  readonly blockingFindings: readonly ReviewFindingRecord[];
  readonly informationalFindings: readonly ReviewFindingRecord[];
  /** Informational findings left out because the total budget was reached. */
  readonly informationalOmitted: number;
  readonly closureRule: string;
  readonly workOrderRef: ArtifactRef;
}

export class RepairOrderError extends Error {
  constructor(message: string) {
    super(`repair order: ${message}`);
    this.name = 'RepairOrderError';
  }
}

function refuse(message: string): never {
  throw new RepairOrderError(message);
}

const SHA1 = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();
const OPEN_STATES = new Set(['OPEN', 'ACKNOWLEDGED', 'FIXED']);
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

/** Clip text to `limit` UTF-8 bytes, ending with an explicit marker when anything was cut. */
function clip(text: string, limit: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limit) return text;
  const reserve = ` [truncated ${bytes.byteLength} bytes]`.length;
  if (limit <= reserve) refuse(`perFieldBytes ${limit} cannot hold a truncation marker`);
  let keep = limit - reserve;
  while (keep > 0 && (bytes[keep]! & 0xc0) === 0x80) keep -= 1;
  const kept = new TextDecoder().decode(bytes.subarray(0, keep));
  return `${kept} [truncated ${bytes.byteLength - keep} bytes]`;
}

function bounded(record: ReviewFindingRecord, perFieldBytes: number): ReviewFindingRecord {
  const picked = pickFindingRecord(record);
  return { ...picked, evidence: clip(picked.evidence, perFieldBytes), requiredFix: clip(picked.requiredFix, perFieldBytes) };
}

/** Build the canonical repair order for a gating REPAIR adjudication. */
export function buildRepairOrder(input: RepairOrderInput): { readonly order: RepairOrder; readonly bytes: Uint8Array; readonly sha256: string } {
  const { record, findings } = input.adjudication;
  if (record.mode !== 'gating' || record.outcome !== 'REPAIR') refuse('only a gating REPAIR decision produces a repair order');
  if (input.round !== record.round || input.fromAttemptId !== record.attemptId) refuse('the adjudication belongs to another round');
  if (!SHA1.test(input.resultSha) || !SHA1.test(input.taskBaseSha)) refuse('commit ids must be 40 lowercase hex');
  const { perFieldBytes, totalBytes } = input.limits;
  if (!Number.isInteger(perFieldBytes) || perFieldBytes < 1 || !Number.isInteger(totalBytes) || totalBytes < 1) {
    refuse('limits must be positive integers');
  }

  const ordered = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  let used = 0;
  const blockingFindings: ReviewFindingRecord[] = [];
  for (const finding of ordered.filter((f) => f.blocking)) {
    if (!finding.grounded) refuse(`blocking finding ${finding.ref} is not grounded`);
    const item = bounded(finding, perFieldBytes);
    used += canonicalBytes(item).byteLength;
    blockingFindings.push(item);
  }
  if (used > totalBytes) refuse(`blocking findings need ${used} bytes; the order allows ${totalBytes}`);

  const informationalFindings: ReviewFindingRecord[] = [];
  let informationalOmitted = 0;
  for (const finding of ordered.filter((f) => !f.blocking && f.grounded && OPEN_STATES.has(f.lifecycleState))) {
    const item = bounded(finding, perFieldBytes);
    const size = canonicalBytes(item).byteLength;
    if (used + size > totalBytes) {
      informationalOmitted += 1;
      continue;
    }
    used += size;
    informationalFindings.push(item);
  }

  const nextRound = record.round + 1;
  const order: RepairOrder = {
    repairOrderId: tupleSha256([record.adjudicationId, nextRound]),
    taskId: input.taskId,
    fromAttemptId: input.fromAttemptId,
    nextRound,
    taskBaseSha: input.taskBaseSha,
    repairBaseSha: input.resultSha,
    adjudicationId: record.adjudicationId,
    blockingFindings,
    informationalFindings,
    informationalOmitted,
    closureRule: REPAIR_CLOSURE_RULE,
    workOrderRef: { artifactId: input.workOrderRef.artifactId, sha256: input.workOrderRef.sha256, kind: input.workOrderRef.kind },
  };
  const bytes = canonicalBytes(order);
  return { order, bytes, sha256: sha256Hex(bytes) };
}
