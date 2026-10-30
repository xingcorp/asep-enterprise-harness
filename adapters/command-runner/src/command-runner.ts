// Trusted command runner (exit criteria F1–F3, D5). Runs a verification command
// as an argv (executable + args) with shell:false via child_process.spawn — a
// model-generated shell string can NEVER reach a shell here. The exact exit
// code and terminating signal are preserved (no 1→0 coercion). A timeout or an
// AbortSignal kills the WHOLE process group (detached + negative pid) so a child
// that spawned descendants cannot outlive the kill. Raw stdout/stderr stream
// through a BoundedCapture and are stored as immutable artifacts BEFORE the
// result is returned, so a summary/reducer never sees uncaptured output (D5).
//
// In a Docker sandbox the process is a `docker run` client, and killing it does
// not stop its container. So each container is named and labelled, killed by
// that name first on a timeout or a cancellation, removed by it whenever the
// client ends (on its own, killed, or killed by someone else), and run() throws
// SandboxTeardownError rather than return beside a container it cannot show
// gone.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TenantScope } from '@asep/contracts';
import type {
  CommandRunner, CommandSpec, CommandResult, SandboxHandle, ArtifactStore,
} from '@asep/ports';
import { BoundedCapture } from './bounded-capture.js';
import { resolveEnvironment } from './environment-profiles.js';
import { executionOf } from './sandbox.js';
import {
  dockerCaller, dockerClientEnv, removeLabelledContainers, SandboxTeardownError, DOCKER_CALL_TIMEOUT_MS,
  monotonicNow,
} from './container-teardown.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface CommandRunnerConfig {
  // Absolute workspace root; a spec.cwd is resolved under it (containment is the
  // worktree adapter's job, but we refuse an absolute cwd escaping obvious bounds).
  readonly workspaceRoot: string;
}

// The handle is not one a sandbox provider of this package made, or its sandbox
// has stopped: the runner cannot tell where a command would run, so it runs
// nothing.
export class SandboxHandleNotProvenError extends Error {
  constructor(sandboxId: string) {
    super(
      `sandbox handle '${sandboxId}' was not made by a sandbox provider of this runner, or its sandbox ` +
        'has stopped — refusing to run a command for it, on the host or anywhere else',
    );
    this.name = 'SandboxHandleNotProvenError';
  }
}

/** A moment of one run() as the runner lives it. */
export type CommandLifecyclePhase =
  | 'spawned'   // the command's process (or its docker client) was spawned
  | 'stop'      // the timeout fired or the cancellation was acted on: `reason`
  | 'killed'    // the container was killed by name (in a container) and the process group signalled
  | 'exited'    // the process (or docker client) ended
  | 'removed';  // in a container: `docker ps -a` lists no container with its label

export interface CommandLifecycleEvent {
  readonly phase: CommandLifecyclePhase;
  // monotonicNow() when the runner reached the phase.
  readonly at: number;
  readonly reason?: 'timeout' | 'aborted';
}

/**
 * The longest a verification container's command can keep running after the
 * decision to stop it (the `stop` phase): the container is killed by name — a
 * docker call bounded by DOCKER_CALL_TIMEOUT_MS — and its client's process
 * group is SIGKILLed as soon as that call returns.
 */
export const COMMAND_STOP_BOUND_MS = DOCKER_CALL_TIMEOUT_MS;

/**
 * The longest a verification container can outlive its docker client before
 * it is shown gone (the `removed` phase): its removal by label, and the
 * listing that shows none left, run within this, each call cut at what is left
 * of it. A container not shown gone within it fails the run.
 */
export const COMMAND_REMOVAL_BOUND_MS = DOCKER_CALL_TIMEOUT_MS;

// The runner needs the scope to store artifacts. It is constructed per attempt
// with a scope + artifact store, then run() is called per command.
export class TrustedCommandRunner implements CommandRunner {
  // Numbers the containers this runner starts within one sandbox.
  private seq = 0;

  constructor(
    private readonly scope: TenantScope,
    private readonly artifacts: ArtifactStore,
    private readonly signal?: AbortSignal,
    // Told each moment of a run as the runner reaches it, so a caller can time
    // the stop apart from the start. Whatever it does or throws changes nothing
    // about the run. Production passes none.
    private readonly observeLifecycle?: (event: CommandLifecycleEvent) => void,
  ) {}

  private mark(phase: CommandLifecyclePhase, reason?: 'timeout' | 'aborted'): void {
    if (this.observeLifecycle === undefined) return;
    try {
      this.observeLifecycle({ phase, at: monotonicNow(), ...(reason !== undefined ? { reason } : {}) });
    } catch {
      // An observer never changes the run.
    }
  }

  async run(spec: CommandSpec, sandbox: SandboxHandle): Promise<CommandResult> {
    const env = resolveEnvironment(spec.environmentProfile);
    const stdoutCap = new BoundedCapture(spec.outputPolicy.maxEvidenceBytes);
    const stderrCap = new BoundedCapture(spec.outputPolicy.maxEvidenceBytes);

    // Where the command runs is what the provider that made this handle
    // recorded for it — never what the handle's fields say. A Docker handle runs
    // INSIDE its container: `docker run <flags> -w <cwd> <image> <exe> <args…>`,
    // so OS-enforced no-network / read-only rootfs / dropped caps apply to the
    // verification command itself (disp. P2-FINAL-HIGH-002). Only the honest
    // local handle, which claims no isolation, runs on the host. Anything else —
    // a copied, rebuilt or destructured handle, or one whose sandbox stopped —
    // has no record and runs nothing.
    const execution = executionOf(sandbox);
    if (execution === undefined || (execution.kind === 'host' && sandbox.isolationEnforced !== false)) {
      throw new SandboxHandleNotProvenError(sandbox.sandboxId);
    }
    const inContainer = execution.kind === 'container';
    // The container's identity, so it can be removed by name however its
    // client ends.
    const container = inContainer ? `${sandbox.sandboxId}-${++this.seq}` : undefined;
    const [exe, argv] = execution.kind === 'container'
      ? [
          execution.dockerBinary,
          [
            ...execution.runFlags,
            '--name', container as string,
            '--label', `asep.container=${container}`,
            '-w', spec.cwd,
            execution.image,
            spec.executable,
            ...spec.args,
          ],
        ]
      : [spec.executable, [...spec.args]];
    // A docker client needs only what finds its daemon; the container's own
    // environment is the image's. Every client call of the sandbox uses the
    // same, so the removal reaches the daemon the run did.
    const clientEnv = inContainer ? dockerClientEnv() : env;
    const docker = dockerCaller(exe, clientEnv);
    const removeContainer = container !== undefined
      ? () => removeLabelledContainers(docker, `asep.container=${container}`, {
        until: monotonicNow() + COMMAND_REMOVAL_BOUND_MS,
      })
      : async () => undefined;
    // Stops the container at once. (`docker rm -f` on a `--rm` container whose
    // client is still attached can take seconds; `docker kill` does not.)
    const killContainer = container !== undefined
      ? async () => { await docker(['kill', container]); }
      : async () => undefined;

    // Whether a client process was started at all: a client that failed to
    // spawn made no container; one that started may have, however it ends.
    let spawned = false;
    const ran = new Promise<{
      exitCode: number | null; signal: string | null; timedOut: boolean;
    }>((resolve, reject) => {
      // shell:false is the default for spawn with an argv; we set it explicitly
      // to document the guarantee. detached:true puts the child in its own
      // process group so we can signal the whole group on timeout/cancel. When
      // running in-container the cwd is irrelevant to docker itself (it uses
      // -w), so we only set cwd for the host-spawn path.
      const child = spawn(exe, argv, {
        cwd: inContainer ? undefined : spec.cwd,
        env: clientEnv,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawned = child.pid !== undefined;
      this.mark('spawned');

      let timedOut = false;
      let settled = false;
      let stopped = false;

      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          // Negative pid → the whole process group (detached child is a leader).
          process.kill(-child.pid, sig);
        } catch {
          try { child.kill(sig); } catch { /* already gone */ }
        }
      };

      // Stop the container first: killing only its client would leave it
      // running. The client is killed afterwards in case it has not exited, and
      // the container is removed once the client has ended (below).
      const terminate = (reason: 'timeout' | 'aborted') => {
        if (stopped) return;
        stopped = true;
        this.mark('stop', reason);
        void killContainer().finally(() => {
          killGroup('SIGKILL');
          this.mark('killed');
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate('timeout');
      }, spec.timeoutMs);

      const onAbort = () => { terminate('aborted'); };
      if (this.signal) {
        if (this.signal.aborted) onAbort();
        else this.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (d: Buffer) => stdoutCap.push(new Uint8Array(d)));
      child.stderr.on('data', (d: Buffer) => stderrCap.push(new Uint8Array(d)));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        this.mark('exited');
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code, sig) => {
        if (settled) return;
        settled = true;
        this.mark('exited');
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener('abort', onAbort);
        // Preserve EXACTLY what the OS reported. No coercion of 1→0.
        resolve({ exitCode: code, signal: sig, timedOut });
      });
    });

    let result: Awaited<typeof ran>;
    let clientError: { readonly error: unknown } | undefined;
    try {
      result = await ran;
    } catch (error) {
      clientError = { error };
      result = { exitCode: null, signal: null, timedOut: false };
    }

    // However the client ended — on its own, killed, or with an error once it
    // had started — the container goes with it: removed by label and shown
    // gone within its bound, or the run fails closed below. Only a container
    // shown gone is reported removed.
    const left = spawned ? await removeContainer() : undefined;
    if (container !== undefined && spawned && left === undefined) this.mark('removed');
    if (clientError !== undefined) {
      if (left !== undefined) throw new SandboxTeardownError(`verification container ${container}`, left);
      throw clientError.error;
    }

    // Store raw output as immutable artifacts BEFORE returning (D5). This
    // happens for every run, success or fail, so evidence exists before any
    // summary/reducer runs.
    const out = stdoutCap.result();
    const err = stderrCap.result();
    const stdoutRef = await this.artifacts.put(this.scope, {
      kind: 'command-stdout',
      content: out.bytes,
      sha256: sha256Hex(out.bytes),
      contentType: 'application/octet-stream',
    });
    const stderrRef = await this.artifacts.put(this.scope, {
      kind: 'command-stderr',
      content: err.bytes,
      sha256: sha256Hex(err.bytes),
      contentType: 'application/octet-stream',
    });
    if (left !== undefined) throw new SandboxTeardownError(`verification container ${container}`, left);

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: stdoutRef,
      stderr: stderrRef,
      stdoutBytes: out.totalBytes,
      stderrBytes: err.totalBytes,
      truncated: out.truncated || err.truncated,
      // Where it ran is the provider's record of the handle — the same record
      // the argv above was built from. The result gets its own frozen copy of
      // the flags, never the array the runner executes.
      provenance: execution.kind === 'container'
        ? {
            where: 'container', image: execution.image, container: container as string,
            runFlags: Object.freeze([...execution.runFlags]),
          }
        : { where: 'host' },
    };
  }
}
