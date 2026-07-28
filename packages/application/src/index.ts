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

export {
  governedExecution,
  type GovernedStop,
  type GovernedExecutionInput,
  type GovernedExecutionResult,
} from './governed-execution.js';

export {
  createOrganization,
  createProject,
  createRepositoryBinding,
  createRun,
  createTask,
  getTask,
  CapabilityError,
  CAP_CREATE_ORGANIZATION,
  type PlatformAuthContext,
  type RegistrationRepositories,
  type OrganizationCreatePort,
  type ProjectCreatePort,
  type BindingPort,
  type RunPort,
  type TaskPort,
} from './registration.js';

export {
  runVerticalSliceWorkflow,
  type VerticalSliceWorkflowInput,
  type VerticalSliceWorkflowResult,
  type VerticalSliceRepositories,
  type SliceWorkspaceBackend,
  type SliceOrganizationPort,
  type SliceProjectPort,
  type SliceBindingPort,
  type SliceRunPort,
  type SliceTaskPort,
  type SliceAttemptPort,
  type SlicePullRequestPort,
} from './vertical-slice-workflow.js';

export {
  verifyStep,
  commitStep,
  evidenceStep,
  pushStep,
  upsertPrStep,
  setReviewStep,
  completeToReview,
  type VerificationCheckSpec,
  type VerificationCheckExecution,
  type VerifyStepInput,
  type VerifyStepResult,
  type CommitStepInput,
  type CommitStepResult,
  type EvidenceStepInput,
  type EvidenceStepResult,
  type PushStepInput,
  type PushStepResult,
  type UpsertPrStepInput,
  type UpsertPrStepResult,
  type SetReviewStepResult,
  type CompletionStop,
  type CompleteToReviewInput,
  type CompleteToReviewResult,
} from './pipeline-steps.js';
