// workflow-worker — COMPOSITION ROOT ONLY (exit criteria B2, B4).
//
// Phase 1 shipped the whole execution kernel here. That coupling is removed:
// the execution pipeline now lives in @asep/application (exit criterion B1) so
// the SAME use case is callable from the CLI, this worker, and a future
// Temporal activity with no worker-only coupling (exit criterion B4).
//
// This module is a THIN caller: it wires concrete adapters (ports) to the
// provider-neutral application use case and forwards the request. It performs
// NO domain decision, NO persistence query, NO provider call of its own beyond
// handing the injected adapters to the use case, and NO workflow sequencing —
// all of that is the application layer's job (exit criterion B5).

import { executeTask, type ExecuteTaskInput, type ExecuteTaskResult } from '@asep/application';

// The worker's only responsibility: forward a fully-composed request to the
// application use case. A Temporal activity (Phase 3) would call executeTask()
// with the exact same input shape — this function has no privileged behaviour
// the activity would lack, which is what exit criterion B4 demands.
export async function runExecuteTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
  return executeTask(input);
}

// Re-export the application seam so a composition root importing the worker sees
// the same use-case surface, never a worker-local reimplementation.
export { executeTask } from '@asep/application';
export type { ExecuteTaskInput, ExecuteTaskResult } from '@asep/application';
