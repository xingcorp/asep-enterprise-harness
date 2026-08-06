// PRODUCTION composition root for the governed vertical slice (disp.
// P2-FINAL-HIGH-008, exit K2 readiness).
//
// THE FINDING. Cycle 2 added `agentFor` / `forge` seams to runVerticalSlice, but
// NO composition root ever instantiated `ClaudeCodingProvider` or
// `GitHubAppForgePort` — `apps/control-plane-api` did not even depend on those
// two adapter packages. So "supply credentials and it runs live" was
// unfalsifiable: the only reachable driver still used the local test doubles.
//
// This module closes that gap. It is the ONE place that builds the REAL agent and
// the REAL forge from configuration, and it exists so the claim is checkable by
// the compiler and by a test: `productionSeams()` returns exactly the two seam
// shapes `runVerticalSlice` consumes, wired to the real adapters.
//
// It is a composition root and nothing else: `new X(...)`, then hand the objects
// to the application use case. No domain decision, no persistence query, no
// workflow sequencing lives here (B2/B5).
//
// FAIL-CLOSED CONFIG. Every credential/pin is REQUIRED. A missing Anthropic CLI
// path, model pin, GitHub App id, private key or installation id throws at
// construction — never a silent downgrade to a stand-in. That is what makes the
// pilot honest: with credentials the real adapters run; without them the root
// refuses to build rather than pretending.

import {
  RepositoryBindingRepository, type SqlClient,
} from '@asep/persistence';
import { ClaudeCodingProvider, type AgentSandboxConfig } from '@asep/agent-claude';
import { isDigestPinned } from '@asep/command-runner';
import {
  GitHubAppCredentialProvider, GitHubAppForgeProvider, GitHubAppForgePort,
  SqlForgeBindingResolver, type LocalRepoLocator,
} from '@asep/github-app';
import { Octokit } from '@octokit/rest';
import type { ArtifactStore, CodingAgentProvider, ForgeProvider } from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, WorkspaceId,
} from '@asep/contracts';

/** Everything the real adapters need, all of it mandatory. */
export interface ProductionSeamConfig {
  // --- Claude coding agent (G1: pinned executable + model + CLI version) -----
  readonly claude: {
    readonly executable: string;
    readonly model: string;
    readonly cliVersion: string;
    readonly maxTurns: number;
    // E8/G3: the agent runs IN a container. Required here — a production root
    // must not be able to obtain a host-execution agent by omitting config.
    readonly sandbox: AgentSandboxConfig;
  };
  // --- GitHub App (H1: private key held in memory, never serialized) --------
  readonly github: {
    readonly appId: number;
    readonly privateKey: string;
    readonly installationId: number;
    readonly allowedHosts?: readonly string[];
  };
  // Resolves the on-disk worktree that holds the harness commit for a binding.
  // Injected because path layout is a workspace concern, not a forge one.
  readonly localRepoPathFor: (
    scope: TenantScope, repositoryBindingId: RepositoryBindingId,
  ) => string;
}

export class ProductionConfigError extends Error {
  constructor(missing: string) {
    super(
      `production composition root cannot be built: ${missing} is not configured — ` +
      `refusing to fall back to a test double (disp. P2-FINAL-HIGH-008)`,
    );
    this.name = 'ProductionConfigError';
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ProductionConfigError(name);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProductionConfigError(name);
  return value;
}

/** The two seams `runVerticalSlice` accepts, bound to the REAL adapters. */
export interface ProductionSeams {
  readonly agentFor: (ctx: {
    scope: TenantScope;
    artifacts: ArtifactStore;
    worktreePathOf: (workspaceId: WorkspaceId) => string;
  }) => CodingAgentProvider;
  readonly forge: ForgeProvider;
}

/**
 * Build the real Claude + GitHub App adapters as the seams the vertical-slice
 * driver consumes. Throws ProductionConfigError when any credential or pin is
 * absent, so an unconfigured deployment fails loudly instead of running a double.
 */
export function productionSeams(
  client: SqlClient,
  cfg: ProductionSeamConfig,
): ProductionSeams {
  // --- validate every required field up front (fail closed before any wiring)
  const executable = requireString(cfg.claude?.executable, 'claude.executable');
  const model = requireString(cfg.claude?.model, 'claude.model');
  const cliVersion = requireString(cfg.claude?.cliVersion, 'claude.cliVersion');
  const maxTurns = requireNumber(cfg.claude?.maxTurns, 'claude.maxTurns');
  const sandbox = cfg.claude?.sandbox;
  if (!sandbox || requireString(sandbox.image, 'claude.sandbox.image') === '') {
    throw new ProductionConfigError('claude.sandbox');
  }
  // The agent image must be pinned BY DIGEST, not merely non-empty (exit F5).
  //
  // THE FINDING (cycle 5, HIGH-002): this check accepted any non-empty string,
  // so `claude-agent:latest` passed. A mutable tag means the thing that actually
  // produced a change is not identified by the evidence bundle that attests to
  // it — the image behind the tag can differ between the attempt and any later
  // audit. DockerSandboxProvider already refuses an unpinned image for the
  // VERIFICATION container; the agent container had no equivalent guard, so the
  // stricter of the two paths was the one that mattered least.
  //
  // Same predicate as the sandbox provider, imported rather than re-implemented,
  // so the two paths cannot drift.
  if (!isDigestPinned(sandbox.image)) {
    throw new ProductionConfigError(
      `claude.sandbox.image must be digest-pinned (…@sha256:<64hex>), got '${sandbox.image}'`,
    );
  }
  const appId = requireNumber(cfg.github?.appId, 'github.appId');
  const privateKey = requireString(cfg.github?.privateKey, 'github.privateKey');
  const installationId = requireNumber(cfg.github?.installationId, 'github.installationId');
  if (typeof cfg.localRepoPathFor !== 'function') {
    throw new ProductionConfigError('localRepoPathFor');
  }

  // --- REAL Claude agent, scope-bound per attempt --------------------------
  // The adapter persists its raw event stream as a SCOPED artifact, so it is
  // constructed with the tenant scope the workflow registered (that is why the
  // driver takes a factory rather than a prebuilt instance).
  const agentFor = (ctx: {
    scope: TenantScope;
    artifacts: ArtifactStore;
    worktreePathOf: (workspaceId: WorkspaceId) => string;
  }): CodingAgentProvider => new ClaudeCodingProvider(
    { executable, model, cliVersion, maxTurns, sandbox },
    ctx.scope,
    ctx.artifacts,
  );

  // --- REAL GitHub App forge ----------------------------------------------
  // JIT installation tokens, minimum permissions, non-bypassable ref safety and
  // no merge capability all live inside the adapter; this root only supplies
  // credentials and the binding resolver.
  const credentials = new GitHubAppCredentialProvider({ appId, privateKey, installationId });
  const inner = new GitHubAppForgeProvider(
    credentials,
    (token: string) => new Octokit({ auth: token }),
    cfg.github.allowedHosts ?? ['github.com'],
  );
  const locator: LocalRepoLocator = {
    localRepoPathFor: (scope, bindingId) => cfg.localRepoPathFor(scope, bindingId),
  };
  const resolver = new SqlForgeBindingResolver(
    new RepositoryBindingRepository(client),
    locator,
  );
  const forge: ForgeProvider = new GitHubAppForgePort(inner, resolver);

  return { agentFor, forge };
}
