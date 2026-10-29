// Approval kinds and the workflow-side decision validator.
//
// The validator runs before any state change. Accepting a decision only starts
// verification against PostgreSQL: a workflow message alone never releases a gate.

import type { ApprovalDecisionValue, ApprovalKind, ControlReceipt, OpenApproval, TaskMessage } from './types.js';

export const ALLOWED_DECISIONS: Readonly<Record<ApprovalKind, readonly ApprovalDecisionValue[]>> = {
  'budget-extension': ['approve', 'reject'],
  'publish-change': ['approve', 'reject'],
};

export const APPROVAL_KINDS: readonly ApprovalKind[] = Object.keys(ALLOWED_DECISIONS) as ApprovalKind[];

export function approvalRequestId(workflowId: string, gateSeq: number): string {
  return `${workflowId}:${gateSeq}`;
}

/** Without a policy bound (null) no extension amount is valid. */
export function isValidExtension(extensionUsd: number | null, maxExtensionUsd: number | null): boolean {
  if (maxExtensionUsd === null) return false;
  return typeof extensionUsd === 'number' && Number.isFinite(extensionUsd) && extensionUsd > 0 && extensionUsd <= maxExtensionUsd;
}

/** A budget-extension approve carries an amount within policy; every other decision carries none. */
export function isWellFormedDecision(
  kind: ApprovalKind,
  decision: ApprovalDecisionValue,
  extensionUsd: number | null,
  maxExtensionUsd: number | null,
): boolean {
  if (kind === 'budget-extension' && decision === 'approve') return isValidExtension(extensionUsd, maxExtensionUsd);
  return extensionUsd === null;
}

const ACCEPTED: ControlReceipt = { accepted: true, duplicate: false, reason: null };
const DUPLICATE: ControlReceipt = { accepted: true, duplicate: true, reason: null };

function rejected(reason: NonNullable<ControlReceipt['reason']>): ControlReceipt {
  return { accepted: false, duplicate: false, reason };
}

/**
 * `open` is the opened approval the workflow is waiting on, or null. A repeated
 * delivery of a known decision id returns the original receipt.
 */
export function validateApprovalDecision(
  open: Pick<OpenApproval, 'approvalRequestId' | 'kind' | 'pendingDecisionId'> | null,
  knownDecisionIds: readonly string[],
  message: Extract<TaskMessage, { type: 'approvalDecisionReceived' }>,
  maxExtensionUsd: number | null,
): ControlReceipt {
  if (knownDecisionIds.includes(message.decisionId)) return DUPLICATE;
  if (open === null || open.approvalRequestId !== message.approvalRequestId) return rejected('unknown-approval');
  if (!ALLOWED_DECISIONS[open.kind].includes(message.decision)) return rejected('decision-not-allowed');
  if (!isWellFormedDecision(open.kind, message.decision, message.extensionUsd, maxExtensionUsd)) {
    return rejected('extension-out-of-bounds');
  }
  if (open.pendingDecisionId !== null) return rejected('decision-conflict');
  return ACCEPTED;
}
