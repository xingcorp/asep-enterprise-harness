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
//     the command runner itself can be exercised on a Docker-less host; the
//     governed path refuses it, because nothing there runs without a handle that
//     claims isolation, and there is no override.
//
// DockerSandboxProvider is the ONLY place a handle may claim
// `isolationEnforced: true`; the TypeScript fitness guard
// (scripts/lib/ts-guard.mjs) fails the build on a claim made anywhere else.
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
  // an integration test can use it); for local, undefined. Retained for the
  // existing hardening-flag assertions; the runner uses runFlags + image below.
  readonly dockerRunPrefix?: readonly string[];
  // The hardened `docker run …` flags WITHOUT the image, so the command runner
  // can insert `-w <cwd>` and append `<image> <executable> <args…>` to actually
  // EXECUTE inside the container (disp. P2-FINAL-HIGH-002). undefined for local.
  readonly runFlags?: readonly string[];
  // The digest-pinned image the runner appends after its flags. undefined local.
  readonly image?: string;
  // The docker client the runner invokes. undefined for local.
  readonly dockerBinary?: string;
}

function dockerAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, ['version', '--format', '{{.Server.Version}}'], (err) => {
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
  // The docker client binary. Defaults to `docker` on PATH. Tests point it at
  // scripts/testing/fake-docker.mjs; the isolation claim is only as good as
  // the client, so production leaves it unset.
  readonly dockerBinary?: string;
}

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`docker sandbox unavailable: ${reason}`);
    this.name = 'SandboxUnavailableError';
  }
}

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

/**
 * PURE builder for the hardened `docker run` flags (disp. P2-FINAL-HIGH-002).
 *
 * Extracted from DockerSandboxProvider.start() so the hardening invariants
 * (--network none, --read-only, --cap-drop ALL, no-new-privileges, pid/cpu/mem
 * limits, never a docker socket) can be asserted DETERMINISTICALLY by the unit
 * suite on every host, with no docker daemon and therefore no
 * "catch SandboxUnavailableError → pass" escape hatch. The review flagged that
 * escape hatch as always-green: on a Docker-less host it asserted nothing while
 * still reporting a pass.
 *
 * The live proof that these flags are actually ENFORCED by the OS (network
 * canary, read-only rootfs, exit-code fidelity) is the in-container integration
 * suite adapters/command-runner/src/sandbox-exec.itest.ts, which runs under the
 * integration gate against a real daemon and fails closed when docker is absent.
 */
export function buildSandboxRunFlags(
  profile: 'verification-no-network' | 'agent-restricted-egress',
  mount: WorkspaceMount,
  cfg: Omit<DockerSandboxConfig, 'imageDigest'> = {},
): readonly string[] {
  // Both profiles are network-isolated at the OS level in Phase 2: the harness
  // never grants an agent egress, so 'agent-restricted-egress' also resolves to
  // `--network none` rather than a policy-advisory allowlist.
  const network = profile === 'verification-no-network' ? 'none' : 'none';
  return [
    'run', '--rm',
    '--network', network,
    '--read-only',
    '--tmpfs', '/tmp',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(cfg.pids ?? 256),
    '--cpus', cfg.cpus ?? '1',
    '--memory', cfg.memory ?? '512m',
    // Writable mounts are the working tree ONLY.
    ...mount.writablePaths.flatMap((p) => ['-v', `${p}:${p}:rw`]),
    ...mount.readOnlyPaths.flatMap((p) => ['-v', `${p}:${p}:ro`]),
    // NESTED read-only binds layered OVER a writable parent (disp.
    // P2-FINAL-HIGH-002). Merely *excluding* `.git` from writablePaths was not
    // enough: a linked worktree's `.git` indirection lives INSIDE the working
    // tree, so `-v <wt>:<wt>:rw` made it writable through the parent mount and
    // an agent could repoint the gitdir from inside the sandbox. Docker orders
    // bind mounts by destination depth, so a `:ro` bind on the nested path is
    // applied after (on top of) the writable parent and the kernel rejects the
    // write with EROFS. This is OS-enforced, not advisory.
    ...(mount.readOnlyOverlayPaths ?? []).flatMap((p) => ['-v', `${p}:${p}:ro`]),
  ];
}

/** PURE digest-pin check, so a mutable tag is rejected before any provisioning. */
export function isDigestPinned(imageRef: string): boolean {
  return DIGEST_PINNED.test(imageRef);
}

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
    const dockerBinary = this.cfg.dockerBinary ?? 'docker';
    if (!(await dockerAvailable(dockerBinary))) {
      // FAIL rather than skip / degrade (F5, disp. P2-PLAN-HIGH-009).
      throw new SandboxUnavailableError('docker CLI or daemon not reachable');
    }
    // Build the hardened run flags via the PURE builder above, so the unit suite
    // asserts the exact same flag set this code path uses (one authority, no
    // drift) and --network none gives OS-enforced no network for verification
    // (F4). No -v of the docker socket anywhere.
    const runFlags = buildSandboxRunFlags(profile, mount, {
      ...(this.cfg.cpus !== undefined ? { cpus: this.cfg.cpus } : {}),
      ...(this.cfg.memory !== undefined ? { memory: this.cfg.memory } : {}),
      ...(this.cfg.pids !== undefined ? { pids: this.cfg.pids } : {}),
    });
    // Back-compat prefix (flags + image) for the existing hardening assertions.
    const prefix = [dockerBinary, ...runFlags, this.cfg.imageDigest];
    return {
      sandboxId: `docker-${mount.workspaceId}-${Date.now()}`,
      profile,
      isolationEnforced: true,
      dockerRunPrefix: prefix,
      runFlags,
      image: this.cfg.imageDigest,
      dockerBinary,
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
