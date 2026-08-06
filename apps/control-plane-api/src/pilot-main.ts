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
import type { CommandSpec } from '@asep/ports';
import { productionSeams, ProductionConfigError } from './production-root.js';
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
  readonly githubAppId: number;
  readonly githubPrivateKeyPath: string;
  readonly githubInstallationId: number;

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
    githubAppId: requireIntEnv('ASEP_GITHUB_APP_ID'),
    githubPrivateKeyPath: requireEnv('ASEP_GITHUB_PRIVATE_KEY_PATH'),
    githubInstallationId: requireIntEnv('ASEP_GITHUB_INSTALLATION_ID'),

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

// Hardened `docker run` flags for the AGENT container. Mirrors the verification
// profile: no network, read-only root, dropped caps, no new privileges, and no
// docker socket. The working tree is bind-mounted rw by the driver's mount spec;
// the `.git` indirection nested inside it is pinned read-only there.
export function agentRunFlags(worktreePath: string): readonly string[] {
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '2g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    // ONLY the leased worktree is writable.
    //
    // THE FINDING (cycle 5, HIGH-002/E8/F5): this used to mount the pilot's temp
    // ROOT rw. That root is where the driver keeps `objects/` — the filesystem
    // bytes of the artifact + evidence stores — plus `mirror.git` and
    // `remote.git`. So the agent, the one component the whole trust model treats
    // as untrusted, had write access to the audit record that is supposed to
    // attest to what it did, and to the Git mirror the harness commits from.
    // Narrowing the bind is the fix: the agent gets the working tree and nothing
    // else in the pilot's state directory is reachable from inside the container.
    '-v', `${worktreePath}:${worktreePath}:rw`,
    // The `.git` indirection of a linked worktree lives INSIDE the tree, so the
    // rw bind above would make it writable and let the agent repoint the gitdir
    // from within the sandbox. A nested `:ro` bind is applied over the writable
    // parent (docker orders binds by destination depth) and the kernel refuses
    // the write with EROFS — OS-enforced, matching what the verification
    // container already does via readOnlyOverlayPaths.
    '-v', `${worktreePath}/.git:${worktreePath}/.git:ro`,
  ];
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
  // to a double.
  const seams = productionSeams(client, {
    claude: {
      executable: env.claudeExecutable,
      model: env.claudeModel,
      cliVersion: env.claudeCliVersion,
      maxTurns: env.claudeMaxTurns,
      // Isolation is REQUIRED on this path: no waiver is passed anywhere here.
      //
      // The mount is the LEASED WORKTREE, resolved lazily. It does not exist at
      // this point — the workflow creates it after registering the tenancy and
      // acquiring the lease — so these are thunks the adapter calls at
      // execute() time. Passing `dir` eagerly (what this did before) mounted the
      // pilot's whole state directory rw, including `objects/`: the artifact and
      // evidence bytes the agent must never be able to rewrite.
      sandbox: {
        image: env.agentImageDigest,
        runFlags: () => agentRunFlags(requireWorktree()),
        workdir: () => requireWorktree(),
      },
    },
    github: {
      appId: env.githubAppId,
      privateKey,
      installationId: env.githubInstallationId,
    },
    // The harness commit lives in the LEASED WORKTREE, not the temp root. The
    // driver publishes that path the moment it creates the workspace.
    localRepoPathFor: () => requireWorktree(),
  });

  // A REAL digest-pinned Docker sandbox for verification. Constructing it throws
  // when the image is not digest-pinned, and `start()` throws when the daemon is
  // unreachable — never a silent degrade (F4/F5).
  const sandbox = new DockerSandboxProvider({ imageDigest: env.verifyImageDigest });

  try {
    const result = await runVerticalSlice({
      client,
      sandbox,
      dir,
      checkCommand: checkCommandFor,
      // The two production seams. Passing them is what makes this a LIVE run:
      // `runVerticalSlice` only falls back to local doubles when they are absent.
      agentFor: seams.agentFor,
      forge: seams.forge,
      // NOTE: no sandboxRequirement override — absent means 'required', so the
      // slice refuses to proceed if OS isolation is not actually enforced.

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
        prTitle: `ASEP: ${env.objective}`,
        prBody: 'Automated ASEP attempt reaching human review.',
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
