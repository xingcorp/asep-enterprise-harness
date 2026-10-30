// Synthetic fields of a corpus packet (docs/implementation/phases/phase-04-plan.md §7.8, rule P
// items 2 and 5).
//
// A historical change has no harness identity, work order or recorded execution, so a corpus
// packet carries synthetic ones. They are recorded in every corpus item and in the protocol,
// and never presented as history: identity ids are the 26-character Crockford base32 of the
// first 16 bytes of sha256 of a fixed label, the work order is the phase's objective with empty
// lists, and the execution manifest is NOT_RECORDED. Every finding-id token in a text part is
// masked to `X`s of its own length, so no label leaks and no line or byte offset moves. Pure.
//
// The record here is the fresh-review one (rule P). The re-review record of a residual item
// (round 2, its repair base and prior findings) and the chunk ids that name each attempt come
// with the packet plan, once the evals package is bound to the runtime packet code.

import { createHash } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 bytes as a 128-bit big-endian number in 26 Crockford base32 digits (the top digit holds 3 bits). */
export function crockford128(bytes: Uint8Array): string {
  if (bytes.byteLength !== 16) throw new Error('synthetic: an id encodes exactly 16 bytes');
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

export function syntheticId(label: string): string {
  return crockford128(createHash('sha256').update(label, 'utf8').digest().subarray(0, 16));
}

export interface LabelledId {
  readonly label: string;
  readonly id: string;
}

const labelled = (label: string): LabelledId => ({ label, id: syntheticId(label) });

/** The attempt identity of one chunk's packet, `corpus:attempt:<chunk id>`. */
export function attemptIdentity(chunkId: string): LabelledId {
  return labelled(`corpus:attempt:${chunkId}`);
}

// Matching is leftmost, so a long-form id is one token from its first character, never a long form
// around a masked short one.
const FINDING_ID = /\bP[0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{3}\b|\b(?:CRIT|CRITICAL|HIGH|MED|MEDIUM|LOW)-[0-9]{3}\b/g;

/** Mask every finding-id token of a text part; the bytes keep their length. */
export function maskFindingIds(bytes: Uint8Array): { readonly bytes: Uint8Array; readonly masked: number } {
  // latin1 maps every byte to one code unit, so bytes outside the (ASCII) tokens come back unchanged.
  let masked = 0;
  const text = Buffer.from(bytes)
    .toString('latin1')
    .replace(FINDING_ID, (token) => {
      masked += 1;
      return 'X'.repeat(token.length);
    });
  return { bytes: new Uint8Array(Buffer.from(text, 'latin1')), masked };
}

/** The execution manifest of every corpus packet. */
export const CORPUS_EXECUTION = { verdict: 'NOT_RECORDED', environment: null, checks: [] } as const;

/** The title of phase `phase`: its heading in docs/implementation/90-day-plan.md, in order. */
export function phaseTitle(plan: string, phase: number): string {
  const titles = [...plan.matchAll(/^## Days [0-9]+–[0-9]+ — (.+)$/gm)].map((m) => m[1]!);
  return titles[phase - 1] ?? fail(`the 90-day plan has no heading for phase ${phase}`);
}

function fail(message: string): never {
  throw new Error(`synthetic: ${message}`);
}

export function corpusObjective(phase: number, title: string): string {
  return `Phase ${phase} (${title}) at the reviewed commit. The phase plan, exit criteria and code are part of the change; review the change against them.`;
}

export interface SyntheticRecord {
  /** Collection's key of the cycle the packets replay. */
  readonly cycle: string;
  readonly identity: {
    readonly organizationId: LabelledId;
    readonly projectId: LabelledId;
    readonly repositoryBindingId: LabelledId;
    readonly runId: LabelledId;
    readonly taskId: LabelledId;
  };
  readonly risk: 'R1';
  readonly round: 1;
  readonly reviewKind: 'fresh';
  readonly workOrder: {
    readonly objective: string;
    readonly requirementIds: readonly string[];
    readonly requirements: readonly never[];
    readonly allowedPaths: readonly string[];
    readonly forbiddenChanges: readonly string[];
    readonly architectureInvariants: readonly string[];
    readonly acceptanceCheckIds: readonly string[];
  };
  readonly execution: typeof CORPUS_EXECUTION;
  readonly priorFindings: readonly never[];
}

/** The synthetic fields of a fresh review of one cycle of phase `phase`. */
export function syntheticRecord(cycle: string, phase: number, title: string): SyntheticRecord {
  return {
    cycle,
    identity: {
      organizationId: labelled('corpus:org'),
      projectId: labelled('corpus:project'),
      repositoryBindingId: labelled('corpus:binding'),
      runId: labelled('corpus:run'),
      taskId: labelled(`corpus:task:${cycle}`),
    },
    risk: 'R1',
    round: 1,
    reviewKind: 'fresh',
    workOrder: {
      objective: corpusObjective(phase, title),
      requirementIds: [],
      requirements: [],
      allowedPaths: ['**'],
      forbiddenChanges: [],
      architectureInvariants: [],
      acceptanceCheckIds: [],
    },
    execution: CORPUS_EXECUTION,
    priorFindings: [],
  };
}
