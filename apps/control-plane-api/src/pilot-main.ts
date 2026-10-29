// `asep pilot run` — the PRODUCTION entrypoint for a governed task→PR attempt
// (disp. P2-FINAL-HIGH-008, exit criteria B2/B5/K2).
//
// THE FINDING. Codex cycle 4: "`productionSeams` dựng đúng adapter thật, nhưng
// không entrypoint nào gọi nó: CLI vẫn mock, `runVerticalSlice` vẫn default sang
// local doubles." Building the real adapters is necessary but not sufficient —
// with no caller, "supply credentials and it runs live" stayed unfalsifiable.
//
// This file is that caller, and nothing else. It:
//   1. reads configuration from the environment and FAILS CLOSED on anything
//      missing (no silent downgrade to a test double — that is the whole point);
//   2. builds the real Claude + GitHub App adapters via `productionSeams`;
//   3. builds a REAL digest-pinned Docker sandbox provider (isolation is not
//      optional on this path — HIGH-002/E8);
//   4. hands all three to `runVerticalSlice`, the same driver both K1 proofs
//      exercise, so the governed sequence cannot drift between pilot and proof;
//   5. prints the resulting PR + evidence identifiers.
//
// It performs NO domain decision, NO persistence query and NO workflow
// sequencing of its own: `runVerticalSlice` wires adapters and the application
// use case owns the sequence (B2/B5).

import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Pool } from 'pg';
import { PgPoolClient, migrate } from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import {
  FileModelCredentialProvider, parseModelBaseUrl, DEFAULT_MODEL_BASE_URL,
} from '@asep/agent-claude';
import type { CommandSpec, ToolPolicyProfile } from '@asep/ports';
import {
  productionSeams, ProductionConfigError, type ProductionSeamConfig,
} from './production-root.js';
import { runVerticalSlice } from './vertical-slice.js';

// Every knob this entrypoint needs. Kept as one list so a missing value is a
// single, clear startup error rather than a failure deep inside an attempt.
//
// EXPORTED so the fail-closed behaviour is testable. The finding this file
// answers was "no entrypoint calls productionSeams", and a claim like that is
// only closed if a test can drive the wiring — which means the config reader and
// the seam builder must be importable, and `main()` must NOT run on import.
export interface PilotEnv {
  readonly pgUrl: string;
  readonly claudeExecutable: string;
  readonly claudeModel: string;
  readonly claudeCliVersion: string;
  readonly claudeMaxTurns: number;
  readonly agentImageDigest: string;
  readonly verifyImageDigest: string;
  // The agent's only route out is a per-attempt egress proxy (this image runs
  // it) to the model API at `anthropicBaseUrl`. The model credential is read
  // from `anthropicApiKeyFile` per attempt and handed to that proxy only.
  readonly egressProxyImageDigest: string;
  readonly anthropicApiKeyFile: string;
  readonly anthropicBaseUrl: string;
  readonly githubAppId: number;
  readonly githubPrivateKeyPath: string;
  readonly githubInstallationId: number;
  // Where artifact and evidence bytes are kept. Durable on purpose: the pilot
  // verifier fetches and re-hashes the evidence from here afterwards.
  readonly objectStoreDir: string;

  // --- the REAL repository this attempt targets (HIGH-008/K2) ---------------
  // Without these the driver fell back to a synthetic seeded mirror registered
  // as the literal `acme/web`, so a run with real credentials would have pushed
  // a seed commit to a repository that does not exist — and the forge resolver
  // would have refused the binding first, because `github_repository_id` was
  // never persisted. Every value is REQUIRED: a pilot that half-configures its
  // target must fail at startup, not halfway through a governed attempt.
  readonly organizationName: string;
  readonly projectName: string;
  readonly githubHost: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubRepositoryId: number;
  readonly baseBranch: string;
  // A bare mirror of that remote, and a base commit that exists inside it.
  readonly mirrorPath: string;
  readonly baseSha: string;

  // --- the task to perform --------------------------------------------------
  // `expectChangedFile` is load-bearing: the workflow fails closed when trusted
  // inspection does not observe it, so a live agent doing real work against a
  // hard-coded 'feature.txt' expectation could only ever be a failed attempt.
  readonly objective: string;
  readonly expectChangedFile: string;
  readonly allowedPaths: readonly string[];

  // Provenance stamped into the evidence bundle. The image digest is the AGENT
  // image (what actually produced the change); the lockfile hash pins the
  // dependency set. Placeholders here would make real evidence attest to an
  // environment that never ran.
  readonly lockfileHash: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ProductionConfigError(`environment variable ${name}`);
  }
  return v;
}

function requireIntEnv(name: string): number {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ProductionConfigError(`${name} (must be an integer)`);
  return n;
}

// A 40-hex commit SHA. The base SHA is not merely config: the workflow diffs
// against it, so a short/abbreviated value would produce a wrong diff rather
// than an error.
const SHA40 = /^[0-9a-f]{40}$/;

// Comma-separated allowlist. Empty entries are dropped so a trailing comma is
// not read as a path the agent may touch.
function requireListEnv(name: string): readonly string[] {
  const parts = requireEnv(name).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) throw new ProductionConfigError(`${name} (must list at least one path)`);
  return parts;
}

// The model API origin. Optional (the public API by default), but a live
// credential is only ever sent over TLS: an http:// origin is refused here.
function modelBaseUrlEnv(): string {
  const raw = process.env['ASEP_ANTHROPIC_BASE_URL'];
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_MODEL_BASE_URL : raw.trim();
  let url: string;
  try {
    url = parseModelBaseUrl(value);
  } catch (err) {
    throw new ProductionConfigError(`ASEP_ANTHROPIC_BASE_URL (${(err as Error).message})`);
  }
  if (!url.startsWith('https://')) {
    throw new ProductionConfigError('ASEP_ANTHROPIC_BASE_URL (must be https://)');
  }
  return url;
}

export function readEnv(): PilotEnv {
  const baseSha = requireEnv('ASEP_BASE_SHA');
  if (!SHA40.test(baseSha)) {
    throw new ProductionConfigError('ASEP_BASE_SHA (must be a full 40-hex commit SHA)');
  }
  return {
    pgUrl: requireEnv('ASEP_PG_URL'),
    claudeExecutable: requireEnv('ASEP_CLAUDE_EXECUTABLE'),
    claudeModel: requireEnv('ASEP_CLAUDE_MODEL'),
    claudeCliVersion: requireEnv('ASEP_CLAUDE_CLI_VERSION'),
    claudeMaxTurns: requireIntEnv('ASEP_CLAUDE_MAX_TURNS'),
    agentImageDigest: requireEnv('ASEP_AGENT_IMAGE_DIGEST'),
    verifyImageDigest: requireEnv('ASEP_VERIFY_IMAGE_DIGEST'),
    egressProxyImageDigest: requireEnv('ASEP_EGRESS_PROXY_IMAGE_DIGEST'),
    anthropicApiKeyFile: requireEnv('ASEP_ANTHROPIC_API_KEY_FILE'),
    anthropicBaseUrl: modelBaseUrlEnv(),
    githubAppId: requireIntEnv('ASEP_GITHUB_APP_ID'),
    githubPrivateKeyPath: requireEnv('ASEP_GITHUB_PRIVATE_KEY_PATH'),
    githubInstallationId: requireIntEnv('ASEP_GITHUB_INSTALLATION_ID'),
    objectStoreDir: requireEnv('ASEP_OBJECT_STORE_DIR'),

    organizationName: requireEnv('ASEP_ORGANIZATION_NAME'),
    projectName: requireEnv('ASEP_PROJECT_NAME'),
    githubHost: requireEnv('ASEP_GITHUB_HOST'),
    githubOwner: requireEnv('ASEP_GITHUB_OWNER'),
    githubRepo: requireEnv('ASEP_GITHUB_REPO'),
    githubRepositoryId: requireIntEnv('ASEP_GITHUB_REPOSITORY_ID'),
    baseBranch: requireEnv('ASEP_BASE_BRANCH'),
    mirrorPath: requireEnv('ASEP_MIRROR_PATH'),
    baseSha,

    objective: requireEnv('ASEP_OBJECTIVE'),
    expectChangedFile: requireEnv('ASEP_EXPECT_CHANGED_FILE'),
    allowedPaths: requireListEnv('ASEP_ALLOWED_PATHS'),

    lockfileHash: requireEnv('ASEP_LOCKFILE_HASH'),
  };
}

// What the pilot agent may do: read and edit files in its worktree. No shell,
// and no network tool — its only route out is the model API through the
// egress proxy, which is what 'restricted-egress' means for the Claude
// provider.
export const PILOT_TOOL_POLICY: ToolPolicyProfile = {
  allowedTools: ['read', 'write'],
  disallowedTools: ['bash', 'network'],
  networkProfile: 'restricted-egress',
};

// The production seam configuration for this pilot. Pure, so the wiring is
// testable without credentials: the agent's images, model pins and credential
// provider come from the environment; its container flags, networks and mounts
// are the adapter's own, and its working directory is the leased worktree the
// driver resolves per attempt.
export function pilotSeamConfig(
  env: PilotEnv,
  privateKey: string,
  localRepoPathFor: ProductionSeamConfig['localRepoPathFor'],
): ProductionSeamConfig {
  return {
    claude: {
      executable: env.claudeExecutable,
      model: env.claudeModel,
      cliVersion: env.claudeCliVersion,
      maxTurns: env.claudeMaxTurns,
      image: env.agentImageDigest,
      proxyImage: env.egressProxyImageDigest,
      credentials: new FileModelCredentialProvider({
        apiKeyFile: env.anthropicApiKeyFile, baseUrl: env.anthropicBaseUrl,
      }),
    },
    github: {
      appId: env.githubAppId,
      privateKey,
      installationId: env.githubInstallationId,
    },
    localRepoPathFor,
  };
}

// The mandatory R0 verification command, run INSIDE the sandbox against the
// mounted working tree. Injected into the driver so the command is config, never
// a model-generated string (F1).
export function checkCommandFor(wtPath: string): CommandSpec {
  return {
    executable: 'git',
    args: ['-C', wtPath, 'status', '--porcelain'],
    cwd: wtPath,
    // MUST be a profile the runner's registry actually knows. 'verification' was
    // not one: ENVIRONMENT_PROFILES holds 'verification-no-network' and
    // 'agent-restricted-egress' only, and resolveEnvironment() throws
    // UnknownEnvironmentProfileError on anything else. So every live pilot run
    // would have died at the verify step — after the agent had already run and
    // mutated the worktree. Fail-closed behaviour, but on a typo rather than a
    // policy decision, and unreachable until an entrypoint test drove it.
    environmentProfile: 'verification-no-network',
    timeoutMs: 120_000,
    outputPolicy: { maxEvidenceBytes: 1_048_576, displayHeadBytes: 4096, displayTailBytes: 4096 },
  };
}

async function main(): Promise<void> {
  const env = readEnv();

  // The GitHub App private key is read from disk here and held in memory only —
  // never persisted into an artifact or a DB row (H1).
  const privateKey = readFileSync(env.githubPrivateKeyPath, 'utf8');

  const pool = new Pool({ connectionString: env.pgUrl, max: 8 });
  const client = PgPoolClient.fromPool(pool);
  await migrate(client);

  const dir = await mkdtemp(join(tmpdir(), 'asep-pilot-'));

  // The leased worktree the driver creates. It does not exist yet — the workflow
  // creates it after registering the tenancy — so the forge adapter resolves it
  // through this holder, populated by the driver's onWorkspaceCreated seam.
  //
  // THE BUG THIS FIXES: this entrypoint previously passed `localRepoPathFor:
  // () => dir`, the bare temp ROOT. The GitHub App adapter runs `git push` with
  // that as cwd, and the root holds no repository at all — so a live push could
  // only ever fail. Reading it before creation is a defect, not a fallback, so
  // it throws rather than silently handing back a pathless directory.
  let worktreePath: string | null = null;
  const requireWorktree = (): string => {
    if (worktreePath === null) {
      throw new Error('forge asked for the worktree before the workspace was created');
    }
    return worktreePath;
  };

  // REAL Claude + GitHub App adapters. Throws ProductionConfigError when any pin
  // or credential is absent, so an unconfigured deployment cannot fall through
  // to a double. No waiver exists anywhere on this path: the agent is always
  // contained, and its one writable mount is the leased worktree.
  //
  // The harness commit lives in the LEASED WORKTREE, not the temp root; the
  // driver publishes that path the moment it creates the workspace.
  const seams = productionSeams(client, pilotSeamConfig(env, privateKey, () => requireWorktree()));

  // A REAL digest-pinned Docker sandbox for verification. Constructing it throws
  // when the image is not digest-pinned, and `start()` throws when the daemon is
  // unreachable — never a silent degrade (F4/F5).
  const sandbox = new DockerSandboxProvider({ imageDigest: env.verifyImageDigest });

  try {
    const result = await runVerticalSlice({
      client,
      sandbox,
      dir,
      // Evidence bytes go to the durable store the pilot verifier reads.
      objectStoreDir: env.objectStoreDir,
      checkCommand: checkCommandFor,
      // The two production seams. Passing them is what makes this a LIVE run:
      // `runVerticalSlice` only falls back to local doubles when they are absent.
      agentFor: seams.agentFor,
      forge: seams.forge,
      toolPolicy: PILOT_TOOL_POLICY,
      // NOTE: the slice refuses a verification sandbox that does not enforce OS
      // isolation, before any side effect; there is no override.

      // The REAL target. Without this the driver seeds a synthetic mirror and
      // registers the literal `acme/web`, so real credentials would push a seed
      // commit to a repository that does not exist — and the forge resolver
      // would refuse the binding first for a missing github_repository_id.
      repository: {
        organizationName: env.organizationName,
        projectName: env.projectName,
        defaultBranch: env.baseBranch,
        binding: {
          githubHost: env.githubHost,
          githubOwner: env.githubOwner,
          githubRepo: env.githubRepo,
          defaultBaseBranch: env.baseBranch,
          githubRepositoryId: env.githubRepositoryId,
        },
        mirrorPath: env.mirrorPath,
        baseSha: env.baseSha,
      },
      // Publishes the leased worktree so the forge adapter's localRepoPathFor
      // resolves to the directory that actually holds the harness commit.
      onWorkspaceCreated: (p) => { worktreePath = p; },
      // The real task. `expectChangedFile` is load-bearing: the workflow fails
      // closed when trusted inspection does not observe it, so leaving the
      // synthetic 'feature.txt' default would report every live attempt failed.
      work: {
        objective: env.objective,
        contextPack: { relevantFiles: env.allowedPaths },
        allowedPaths: env.allowedPaths,
        expectChangedFile: env.expectChangedFile,
      },
      // Real provenance in the evidence bundle: the AGENT image that produced
      // the change, not the driver's placeholder digest.
      environment: {
        imageDigest: env.agentImageDigest,
        lockfileHash: env.lockfileHash,
        nodeVersion: process.version,
      },
    });

    // eslint-disable-next-line no-console
    console.log([
      `task:            ${result.taskId}`,
      `attempt:         ${result.attemptId}`,
      `status:          ${result.taskStatus}`,
      `commit:          ${result.commitSha}`,
      `pull request:    #${result.prNumber} (${result.prHeadBranch} -> ${result.prBaseBranch})`,
      `evidence:        ${result.evidenceArtifactId} sha256=${result.evidenceSha256}`,
      `sandbox enforced: ${result.sandboxIsolationEnforced}`,
    ].join('\n'));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// Run ONLY when invoked as a program, never on import. Without this guard the
// module could not be unit-tested at all: importing it to exercise readEnv() /
// checkCommandFor() would immediately attempt a live attempt (and fail closed on
// missing credentials), so the pure helpers were unreachable from a test.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    if (err instanceof ProductionConfigError) {
      console.error(err.message);
    } else {
      console.error('asep pilot run failed:', err);
    }
    process.exitCode = 1;
  });
}
