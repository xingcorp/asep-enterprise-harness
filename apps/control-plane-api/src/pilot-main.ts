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

export function readEnv(): PilotEnv {
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
  };
}

// Hardened `docker run` flags for the AGENT container. Mirrors the verification
// profile: no network, read-only root, dropped caps, no new privileges, and no
// docker socket. The working tree is bind-mounted rw by the driver's mount spec;
// the `.git` indirection nested inside it is pinned read-only there.
export function agentRunFlags(workdir: string): readonly string[] {
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '2g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '-v', `${workdir}:${workdir}:rw`,
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
    environmentProfile: 'verification',
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
      sandbox: {
        image: env.agentImageDigest,
        runFlags: agentRunFlags(dir),
        workdir: dir,
      },
    },
    github: {
      appId: env.githubAppId,
      privateKey,
      installationId: env.githubInstallationId,
    },
    // The harness commit lives in the leased worktree the driver creates under
    // `dir`; the forge resolver asks for it by binding.
    localRepoPathFor: () => dir,
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
