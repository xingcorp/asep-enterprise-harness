// Input rules applied before a workflow starts: the orchestration policy loader
// and the workflow-input mapping reject an input that breaks them. The core
// enforces the rules that matter for safety on its own as well, so a rejected
// input is never silently corrected.

import { FAILURE_CLASSES, NEVER_REPLACEABLE_FAILURE_CLASSES } from './defaults.js';
import type { OrchestrationPolicy } from './types.js';

/** Why the policy is invalid, or an empty list. */
export function orchestrationPolicyErrors(policy: OrchestrationPolicy): string[] {
  const errors: string[] = [];
  for (const failureClass of policy.replaceableFailureClasses) {
    if (!FAILURE_CLASSES.includes(failureClass)) {
      errors.push(`replaceableFailureClasses: unknown failure class ${failureClass}`);
    } else if (NEVER_REPLACEABLE_FAILURE_CLASSES.includes(failureClass)) {
      errors.push(`replaceableFailureClasses: ${failureClass} is never replaceable`);
    }
  }
  return errors;
}
