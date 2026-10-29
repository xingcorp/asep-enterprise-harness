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
// Where a command runs is not read off the handle. Each provider records, for
// the handle object it returns, how commands for it are executed — in a
// container with these flags, image and client, or on the host — and freezes
// the handle. The runner looks that record up by the handle's identity. A handle
// with no record (built by hand, copied, spread or destructured, whatever it
// claims) or whose sandbox has stopped runs nothing: `isolationEnforced` is a
// description of a handle, never a key to the host.
//
// Every container a Docker handle runs is labelled with the handle's sandbox
// id, its workspace and its attempt. The runner removes each one by name when
// its client ends; stop() then removes anything still carrying the sandbox id
// and fails if it cannot show none is left.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type {
  SandboxProvider, SandboxHandle, WorkspaceMount,
} from '@asep/ports';
import {
  dockerCaller, dockerClientEnv, removeLabelledContainers, SandboxTeardownError,
} from './container-teardown.js';

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

/** How commands for a handle are executed, as the provider that made it says. */
export type SandboxExecution =
  | {
    readonly kind: 'container';
    readonly runFlags: readonly string[];
    readonly image: string;
    readonly dockerBinary: string;
  }
  | { readonly kind: 'host' };

// Keyed by the handle object a provider returned. Module-private: only the two
// providers below write it; the runner only reads it.
const EXECUTIONS = new WeakMap<SandboxHandle, SandboxExecution>();

function issue(handle: SandboxHandleEx, execution: SandboxExecution): SandboxHandleEx {
  const frozen: SandboxHandleEx = Object.freeze(handle);
  EXECUTIONS.set(frozen, Object.freeze(execution));
  return frozen;
}

/**
 * How a command for this handle runs, or undefined when no provider of this
 * module made this very object or its sandbox has stopped.
 */
export function executionOf(handle: SandboxHandle): SandboxExecution | undefined {
  return EXECUTIONS.get(handle);
}

/** The labels every container of a Docker sandbox carries. */
export function sandboxLabels(
  sandboxId: string,
  profile: 'verification-no-network' | 'agent-restricted-egress',
  mount: WorkspaceMount,
): readonly string[] {
  return [
    `asep.role=${profile === 'verification-no-network' ? 'verification' : 'agent-sandbox'}`,
    `asep.sandbox=${sandboxId}`,
    `asep.workspace=${mount.workspaceId}`,
    ...(mount.attemptId !== undefined ? [`asep.attempt=${mount.attemptId}`] : []),
  ];
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
    // One id per started sandbox, usable as a container-name prefix. Every
    // container run in it is labelled with it, its workspace and its attempt.
    const sandboxId = `asep-verify-${String(mount.workspaceId).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}-` +
      `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const labelled = [...runFlags, ...sandboxLabels(sandboxId, profile, mount).flatMap((l) => ['--label', l])];
    // Back-compat prefix (flags + image) for the existing hardening assertions.
    const prefix = [dockerBinary, ...labelled, this.cfg.imageDigest];
    return issue({
      sandboxId,
      profile,
      isolationEnforced: true,
      dockerRunPrefix: prefix,
      runFlags: labelled,
      image: this.cfg.imageDigest,
      dockerBinary,
    }, { kind: 'container', runFlags: labelled, image: this.cfg.imageDigest, dockerBinary });
  }

  // The runner removes each container when its client ends; this removes
  // anything that still carries the sandbox's id, and refuses to report the
  // sandbox stopped while it cannot show none is left. The handle runs nothing
  // from here on, whether or not the sweep succeeds.
  async stop(handle: SandboxHandle): Promise<void> {
    const execution = executionOf(handle);
    EXECUTIONS.delete(handle);
    const binary = execution?.kind === 'container' ? execution.dockerBinary : this.cfg.dockerBinary ?? 'docker';
    const docker = dockerCaller(binary, dockerClientEnv());
    const left = await removeLabelledContainers(docker, `asep.sandbox=${handle.sandboxId}`);
    if (left !== undefined) throw new SandboxTeardownError(`sandbox ${handle.sandboxId}`, left);
  }
}

// Honest no-isolation fallback (F6). NEVER claims to be a production sandbox.
export class LocalUnsandboxedProvider implements SandboxProvider {
  async start(
    profile: 'verification-no-network' | 'agent-restricted-egress',
    mount: WorkspaceMount,
  ): Promise<SandboxHandleEx> {
    return issue({
      sandboxId: `local-unsandboxed-${mount.workspaceId}`,
      // The profile name carries the pilot-only warning so it is visible in any
      // log, artifact or report that records the handle.
      profile: `${profile}-PILOT-ONLY-NO-ISOLATION`,
      isolationEnforced: false,
    }, { kind: 'host' });
  }

  // Nothing to tear down; the handle runs nothing from here on.
  async stop(handle: SandboxHandle): Promise<void> {
    EXECUTIONS.delete(handle);
  }
}
