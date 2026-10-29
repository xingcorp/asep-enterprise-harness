// Pre-gateway egress decision and the single choke point for reviewer requests.
//
// No byte leaves the harness for a reviewer gateway unless it has been scanned and
// classified. `decideEgress` is a pure function over the exact packet bytes and every
// content part the prompt would carry; `sendIfCleared` is the only way a reviewer
// request is sent: it refuses on a push-guard BLOCK or any decision other than CLEAR,
// and re-scans the exact request bytes immediately before sending.

import { isEgressEnabled, isSensitivePath, type ReviewPolicy } from '@asep/policy';
import type { ArtifactRef } from '@asep/contracts';
import { sha256Hex } from './canonical-json.js';
import { parseUnifiedDiff } from './diff.js';
import type { BlockReason, EgressDecision } from './local-types.js';
import type { BuiltPacket } from './packet.js';
import { findSecrets } from './secret-patterns.js';

export interface EgressHit {
  readonly kind: 'not-opted-in' | 'deny-path' | 'unscannable' | 'secret';
  /** Prompt part the hit is in: `packet`, `diff`, `repair-delta` or `file-N`. */
  readonly part: string;
  /** Path, pattern label or reason; never a secret value. */
  readonly detail: string;
}

export interface EgressResult {
  readonly decision: EgressDecision;
  /** The packet this decision covers. */
  readonly packetSha256: string;
  readonly hits: readonly EgressHit[];
}

interface ContentPart {
  readonly part: string;
  readonly ref: ArtifactRef;
}

function contentParts(built: Pick<BuiltPacket, 'packet'>): ContentPart[] {
  const { change } = built.packet;
  const parts: ContentPart[] = [{ part: 'diff', ref: change.cumulativeDiff }];
  if (change.repairDelta !== null) parts.push({ part: 'repair-delta', ref: change.repairDelta });
  change.files.forEach((file, i) => {
    if (file.postImage !== null) parts.push({ part: `file-${i}`, ref: file.postImage });
  });
  return parts;
}

const fatal = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return fatal.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Classify a built packet for reviewer egress. Precedence: the project has not opted in
 * or a path is classified (STOP_CLASSIFIED), then any part that cannot be read, verified
 * or decoded (STOP_UNSCANNABLE), then any secret-pattern match (STOP_SECRET), else CLEAR.
 * Unscannable content at a sensitive path is already classified by its path.
 */
export function decideEgress(
  policy: ReviewPolicy,
  built: Pick<BuiltPacket, 'packet' | 'bytes' | 'sha256'>,
  contents: ReadonlyMap<string, Uint8Array>,
): EgressResult {
  const hits: EgressHit[] = [];
  const { packet } = built;
  if (!isEgressEnabled(policy, packet.identity.projectId)) {
    hits.push({ kind: 'not-opted-in', part: 'packet', detail: 'the project has not opted in to reviewer egress' });
  }

  const paths = new Set(packet.change.files.map((f) => f.path));
  const scanned = new Map<string, string>();
  const packetText = decode(built.bytes);
  if (packetText === null || sha256Hex(built.bytes) !== built.sha256) {
    hits.push({ kind: 'unscannable', part: 'packet', detail: 'packet bytes do not verify' });
  } else {
    scanned.set('packet', packetText);
  }
  for (const { part, ref } of contentParts(built)) {
    const bytes = contents.get(ref.artifactId);
    if (bytes === undefined) {
      hits.push({ kind: 'unscannable', part, detail: 'content is unavailable' });
      continue;
    }
    if (sha256Hex(bytes) !== ref.sha256) {
      hits.push({ kind: 'unscannable', part, detail: 'content does not match its digest' });
      continue;
    }
    const text = decode(bytes);
    if (text === null) {
      hits.push({ kind: 'unscannable', part, detail: 'content is not UTF-8' });
      continue;
    }
    scanned.set(part, text);
  }

  // Renames carry their pre-image path only in the diff.
  const diffText = scanned.get('diff');
  if (diffText !== undefined) {
    try {
      for (const file of parseUnifiedDiff(diffText)) if (file.oldPath !== null) paths.add(file.oldPath);
    } catch {
      hits.push({ kind: 'unscannable', part: 'diff', detail: 'the diff cannot be parsed for renamed paths' });
    }
  }
  for (const path of [...paths].sort()) {
    if (isSensitivePath(policy, path)) hits.push({ kind: 'deny-path', part: 'packet', detail: path });
  }

  for (const [part, text] of scanned) {
    const labels = [...new Set(findSecrets(text).map((h) => h.label))];
    for (const label of labels) hits.push({ kind: 'secret', part, detail: label });
  }

  const has = (kind: EgressHit['kind']) => hits.some((h) => h.kind === kind);
  const decision: EgressDecision =
    has('not-opted-in') || has('deny-path')
      ? 'STOP_CLASSIFIED'
      : has('unscannable')
        ? 'STOP_UNSCANNABLE'
        : has('secret')
          ? 'STOP_SECRET'
          : 'CLEAR';
  return { decision, packetSha256: built.sha256, hits };
}

/** Re-scan the exact request body bytes immediately before a provider call. */
export function rescanRequestBytes(bytes: Uint8Array): 'CLEAR' | 'STOP_SECRET' | 'STOP_UNSCANNABLE' {
  const text = decode(bytes);
  if (text === null) return 'STOP_UNSCANNABLE';
  return findSecrets(text).length > 0 ? 'STOP_SECRET' : 'CLEAR';
}

export type EgressStopReason = 'push-guard' | 'egress-secret' | 'egress-classified' | 'egress-unscannable' | 'egress-request-rescan';

export interface ReviewerClearance {
  readonly pushGuard: { readonly decision: 'PASS' } | { readonly decision: 'BLOCK'; readonly reason: BlockReason };
  readonly egress: { readonly decision: EgressDecision; readonly packetSha256: string };
}

export class EgressClearanceError extends Error {
  constructor(message: string) {
    super(`egress: ${message}`);
    this.name = 'EgressClearanceError';
  }
}

const STOP_FOR: Readonly<Record<Exclude<EgressDecision, 'CLEAR'>, EgressStopReason>> = {
  STOP_SECRET: 'egress-secret',
  STOP_CLASSIFIED: 'egress-classified',
  STOP_UNSCANNABLE: 'egress-unscannable',
};

/**
 * Send a reviewer request only when the round's push guard passed, its egress decision
 * for this exact packet is CLEAR, and the exact request bytes re-scan clean. Otherwise
 * `send` is never called. A decision for a different packet is a caller error.
 */
export async function sendIfCleared<T>(
  clearance: ReviewerClearance,
  request: { readonly packetSha256: string; readonly requestBytes: Uint8Array },
  send: () => Promise<T>,
): Promise<{ readonly sent: true; readonly result: T } | { readonly sent: false; readonly stop: EgressStopReason }> {
  if (clearance.pushGuard.decision !== 'PASS') return { sent: false, stop: 'push-guard' };
  if (clearance.egress.packetSha256 !== request.packetSha256) {
    throw new EgressClearanceError('the egress decision covers a different packet');
  }
  if (clearance.egress.decision !== 'CLEAR') return { sent: false, stop: STOP_FOR[clearance.egress.decision] };
  if (rescanRequestBytes(request.requestBytes) !== 'CLEAR') return { sent: false, stop: 'egress-request-rescan' };
  return { sent: true, result: await send() };
}
