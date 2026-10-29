// Sandbox providers (exit criteria F4–F6). Two implementations behind the
// SandboxProvider port:
//
//   DockerSandboxProvider — the intended production-parity sandbox. Builds a
//     rootless `docker run` invocation with `--network none` (F4), NO docker
//     socket mounted, a digest-pinned image, read-only root fs, tmpfs /tmp,
//     dropped capabilities, --security-opt no-new-privileges, and CPU/mem/PID
//     limits (F5). It refuses to start if the docker CLI/daemon is unavailable
//     rather than silently degrading.
//
//   LocalUnsandboxedProvider — an HONEST fallback for hosts without Docker
//     (F6). It provides NO isolation and says so, in code and in its handle
//     (`isolationEnforced: false`, profile suffixed `-PILOT-ONLY`). It exists so
//     the command runner can be exercised end-to-end on a Docker-less host
//     WITHOUT ever pretending to be a production sandbox.
//
// The command runner treats a SandboxHandle as an opaque execution context; the
// no-network / resource guarantees are the sandbox's responsibility, so a real
// Docker handle enforces them and the local handle transparently does not.

import { execFile } from 'node:child_process';
import type {
  SandboxProvider, SandboxHandle, WorkspaceMount,
} from '@asep/ports';

export interface SandboxHandleEx extends SandboxHandle {
  // Honesty flag (F6): true only when the OS/container actually enforces the
  // profile's isolation. The report and any "production sandbox" claim must key
  // off this, never off the mere existence of a handle.
  readonly isolationEnforced: boolean;
  // For Docker, the argv that WOULD run a command in the sandbox (the runner or
  // an integration test can use it); for local, undefined.
  readonly dockerRunPrefix?: readonly string[];
}

function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err) => {
      resolve(!err);
    });
  });
}

export interface DockerSandboxConfig {
  // Image pinned BY DIGEST (F5): e.g. 'node@sha256:...'. A tag is rejected.
  readonly imageDigest: string;
  readonly cpus?: string;      // e.g. '1'
  readonly memory?: string;    // e.g. '512m'
  readonly pids?: number;      // e.g. 256
}

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`docker sandbox unavailable: ${reason}`);
    this.name = 'SandboxUnavailableError';
  }
}

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

export class DockerSandboxProvider implements SandboxProvider {
  constructor(private readonly cfg: DockerSandboxConfig) {
    if (!DIGEST_PINNED.test(cfg.imageDigest)) {
      throw new SandboxUnavailableError(
        `image '${cfg.imageDigest}' is not digest-pinned (must end @sha256:<64hex>)`,
      );
    }
  }

  async start(
    profile: 'verification-no-network' | 'agent-restricted-egress',
    mount: WorkspaceMount,
  ): Promise<SandboxHandleEx> {
    if (!(await dockerAvailable())) {
      // FAIL rather than skip / degrade (F5, disp. P2-PLAN-HIGH-009).
      throw new SandboxUnavailableError('docker CLI or daemon not reachable');
    }
    // Build the hardened run prefix. --network none gives OS-enforced no network
    // for the verification profile (F4). No -v of the docker socket anywhere.
    const network = profile === 'verification-no-network' ? 'none' : 'none';
    const prefix = [
      'docker', 'run', '--rm',
      '--network', network,
      '--read-only',
      '--tmpfs', '/tmp',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(this.cfg.pids ?? 256),
      '--cpus', this.cfg.cpus ?? '1',
      '--memory', this.cfg.memory ?? '512m',
      ...mount.writablePaths.flatMap((p) => ['-v', `${p}:${p}:rw`]),
      ...mount.readOnlyPaths.flatMap((p) => ['-v', `${p}:${p}:ro`]),
      this.cfg.imageDigest,
    ];
    return {
      sandboxId: `docker-${mount.workspaceId}-${Date.now()}`,
      profile,
      isolationEnforced: true,
      dockerRunPrefix: prefix,
    };
  }

  async stop(_handle: SandboxHandle): Promise<void> {
    // --rm containers self-remove on exit; nothing persistent to tear down.
  }
}

// Honest no-isolation fallback (F6). NEVER claims to be a production sandbox.
export class LocalUnsandboxedProvider implements SandboxProvider {
  async start(
    profile: 'verification-no-network' | 'agent-restricted-egress',
    mount: WorkspaceMount,
  ): Promise<SandboxHandleEx> {
    return {
      sandboxId: `local-unsandboxed-${mount.workspaceId}`,
      // The profile name carries the pilot-only warning so it is visible in any
      // log, artifact or report that records the handle.
      profile: `${profile}-PILOT-ONLY-NO-ISOLATION`,
      isolationEnforced: false,
    };
  }

  async stop(_handle: SandboxHandle): Promise<void> { /* nothing to tear down */ }
}
