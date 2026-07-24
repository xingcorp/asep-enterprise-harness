// `asep task execute` CLI (plan §10, exit criteria B2/B4). This is a COMPOSITION
// ROOT: it parses argv, wires concrete adapters (a coding provider + a git
// change inspector) to the provider-neutral application use case, forwards the
// request, and prints the result. It performs NO domain decision, NO
// persistence query, NO provider call of its own beyond handing injected
// adapters to the use case, and NO workflow sequencing — exactly the same seam
// a Phase-3 Temporal activity would call (exit criterion B4).
//
// Long execution lives OFF the HTTP request path (plan §10): the API registers
// and queries; this CLI/worker drives the actual attempt.

import { executeTask, type ExecuteTaskResult } from '@asep/application';
import type {
  CodingAgentProvider, GitChangeInspector,
} from '@asep/ports';
import type {
  TenantScope, AttemptId, ArtifactRef, Budget, RiskLevel,
  OrganizationId, ProjectId, WorkspaceId,
} from '@asep/contracts';
import type { ToolPolicyProfile, WorkspaceCapability } from '@asep/ports';

// ---------------------------------------------------------------------------
// argv parsing (transport-level only — no business logic).
// ---------------------------------------------------------------------------

export interface CliArgs {
  readonly command: 'task';
  readonly subcommand: 'execute';
  readonly taskId: string;
  readonly risk: RiskLevel;
}

export class CliUsageError extends Error {
  constructor(reason: string) {
    super(`usage: ${reason}`);
    this.name = 'CliUsageError';
  }
}

const RISKS = new Set<RiskLevel>(['R0', 'R1', 'R2', 'R3', 'R4']);

// Parse `asep task execute --task-id <id> [--risk R0]`. Defaults risk to R0
// (the only automated-pilot-eligible level, disp. P2-PLAN-HIGH-001).
export function parseArgs(argv: readonly string[]): CliArgs {
  const [command, subcommand, ...rest] = argv;
  if (command !== 'task' || subcommand !== 'execute') {
    throw new CliUsageError('asep task execute --task-id <id> [--risk R0]');
  }
  let taskId: string | undefined;
  let risk: RiskLevel = 'R0';
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--task-id') {
      taskId = rest[++i];
    } else if (flag === '--risk') {
      const v = rest[++i];
      if (!v || !RISKS.has(v as RiskLevel)) throw new CliUsageError('--risk must be one of R0..R4');
      risk = v as RiskLevel;
    } else {
      throw new CliUsageError(`unknown flag '${flag}'`);
    }
  }
  if (!taskId) throw new CliUsageError('--task-id is required');
  return { command: 'task', subcommand: 'execute', taskId, risk };
}

// ---------------------------------------------------------------------------
// The execution dependencies a composition root injects. Grouped so the CLI is
// testable with fakes and the real `main()` wires concrete adapters.
// ---------------------------------------------------------------------------

export interface CliDeps {
  readonly scope: TenantScope;
  readonly provider: CodingAgentProvider;
  readonly inspector: GitChangeInspector;
  readonly attemptId: AttemptId;
  readonly workspace: WorkspaceCapability;
  readonly workOrderRef: ArtifactRef;
  readonly contextPackRef: ArtifactRef;
  readonly budget: Budget;
  readonly toolPolicy: ToolPolicyProfile;
  readonly signal: AbortSignal;
}

// Forward a fully-composed request to the application use case. The CLI never
// reimplements the pipeline — it only wires and forwards (exit criterion B5).
export async function runExecute(args: CliArgs, deps: CliDeps): Promise<ExecuteTaskResult> {
  return executeTask({
    scope: deps.scope,
    risk: args.risk,
    agent: {
      provider: deps.provider,
      attemptId: deps.attemptId,
      workOrderRef: deps.workOrderRef,
      contextPackRef: deps.contextPackRef,
      workspace: deps.workspace,
      budget: deps.budget,
      toolPolicy: deps.toolPolicy,
      signal: deps.signal,
    },
    inspector: deps.inspector,
  });
}

// A compact, human-readable rendering of the result for the terminal.
export function formatResult(taskId: string, result: ExecuteTaskResult): string {
  const lines = [
    `task:        ${taskId}`,
    `admitted:    ${result.admitted}`,
    `stopped at:  ${result.stoppedAt}`,
    `inspected:   ${result.reachedInspection}`,
    `human review required: ${result.requiresHumanIndependentReview}`,
  ];
  if (result.change) {
    lines.push(`result sha:  ${result.change.headSha}`);
    lines.push(`changed:     ${result.change.changedFiles.length} file(s)`);
  }
  return lines.join('\n');
}

// Placeholder ids/refs used only for the default (mock-provider) local run so
// the CLI is exercisable end-to-end without a live PG/GitHub. A production wire
// would resolve these from the scoped task row + freshly built artifacts.
const ULID_ZERO = '0'.repeat(26);

// Build the default dependency set from a coding provider + git inspector. The
// scope/ids here are placeholders for the local mock run; a real deployment
// derives scope from auth and the attempt/workspace from the leased worktree.
export function localDeps(
  provider: CodingAgentProvider,
  inspector: GitChangeInspector,
): CliDeps {
  return {
    scope: {
      organizationId: ('A'.repeat(26)) as OrganizationId,
      projectId: ('B'.repeat(26)) as ProjectId,
    },
    provider,
    inspector,
    attemptId: ULID_ZERO as AttemptId,
    workspace: { workspaceId: ULID_ZERO as WorkspaceId, leaseId: ULID_ZERO },
    workOrderRef: { artifactId: (ULID_ZERO as unknown as ArtifactRef['artifactId']), sha256: '0'.repeat(64), kind: 'work-order' },
    contextPackRef: { artifactId: (ULID_ZERO as unknown as ArtifactRef['artifactId']), sha256: '0'.repeat(64), kind: 'context-pack' },
    budget: { maxTurns: 10, maxToolCalls: 100, maxCostUsd: 5, maxWallClockMinutes: 15 },
    toolPolicy: { allowedTools: ['read', 'write', 'bash'], disallowedTools: ['network'], networkProfile: 'no-network' },
    signal: new AbortController().signal,
  };
}
