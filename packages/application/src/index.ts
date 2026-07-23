// Public surface of @asep/application.
//
// The Phase-2 execution use case lives HERE (exit criterion B1), not in
// workers/* or apps/*. It composes only against @asep/ports interfaces plus the
// pure @asep/policy / @asep/domain logic — no provider SDK, Fastify, pg,
// Octokit, AWS or Docker import (exit criterion B3, enforced by the extended
// forbidden-imports fitness). The same use case is callable from the CLI, the
// worker and a future Temporal activity (exit criterion B4).

export {
  admitRisk,
  isAdmitted,
  type AdmissionDecision,
  type AdmissionResult,
} from './risk-admission.js';

export {
  admissionStep,
  agentStep,
  inspectStep,
  executeTask,
  type StepStatus,
  type AdmissionStepResult,
  type AgentStepResult,
  type AgentStepInput,
  type InspectStepResult,
  type InspectStepInput,
  type ExecuteTaskInput,
  type ExecuteTaskResult,
} from './execute-task.js';
