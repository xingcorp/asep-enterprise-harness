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
import type { SandboxHandleEx } from './sandbox.js';
import {
  dockerCaller, dockerClientEnv, removeLabelledContainers, SandboxTeardownError,
} from './container-teardown.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface CommandRunnerConfig {
  // Absolute workspace root; a spec.cwd is resolved under it (containment is the
  // worktree adapter's job, but we refuse an absolute cwd escaping obvious bounds).
  readonly workspaceRoot: string;
}

// The runner needs the scope to store artifacts. It is constructed per attempt
// with a scope + artifact store, then run() is called per command.
export class TrustedCommandRunner implements CommandRunner {
  // Numbers the containers this runner starts within one sandbox.
  private seq = 0;

  constructor(
    private readonly scope: TenantScope,
    private readonly artifacts: ArtifactStore,
    private readonly signal?: AbortSignal,
  ) {}

  async run(spec: CommandSpec, sandbox: SandboxHandle): Promise<CommandResult> {
    const env = resolveEnvironment(spec.environmentProfile);
    const stdoutCap = new BoundedCapture(spec.outputPolicy.maxEvidenceBytes);
    const stderrCap = new BoundedCapture(spec.outputPolicy.maxEvidenceBytes);

    // Resolve the ACTUAL executable + argv to spawn. When the sandbox enforces
    // isolation (a Docker handle carrying runFlags + image), the command runs
    // INSIDE the container: `docker run <flags> -w <cwd> <image> <exe> <args…>`
    // — OS-enforced no-network / read-only rootfs / dropped caps apply to the
    // verification command itself, not just to a prefix we throw away (disp.
    // P2-FINAL-HIGH-002). An honest local (unsandboxed) handle has no runFlags,
    // so we spawn directly on the host and the handle already advertises
    // isolationEnforced:false.
    const ex = sandbox as SandboxHandleEx;
    const inContainer = Array.isArray(ex.runFlags) && typeof ex.image === 'string';
    // The container's identity, so it can be removed by name however its
    // client ends.
    const container = inContainer ? `${ex.sandboxId}-${++this.seq}` : undefined;
    const [exe, argv] = inContainer
      ? [
          ex.dockerBinary ?? 'docker',
          [
            ...(ex.runFlags as readonly string[]),
            '--name', container as string,
            '--label', `asep.container=${container}`,
            '-w', spec.cwd,
            ex.image as string,
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
      ? () => removeLabelledContainers(docker, `asep.container=${container}`)
      : async () => undefined;
    // Stops the container at once. (`docker rm -f` on a `--rm` container whose
    // client is still attached can take seconds; `docker kill` does not.)
    const killContainer = container !== undefined
      ? async () => { await docker(['kill', container]); }
      : async () => undefined;

    const result = await new Promise<{
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

      let timedOut = false;
      let settled = false;

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
      const terminate = () => {
        void killContainer().finally(() => killGroup('SIGKILL'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, spec.timeoutMs);

      const onAbort = () => { terminate(); };
      if (this.signal) {
        if (this.signal.aborted) onAbort();
        else this.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (d: Buffer) => stdoutCap.push(new Uint8Array(d)));
      child.stderr.on('data', (d: Buffer) => stderrCap.push(new Uint8Array(d)));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code, sig) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener('abort', onAbort);
        // Preserve EXACTLY what the OS reported. No coercion of 1→0.
        resolve({ exitCode: code, signal: sig, timedOut });
      });
    });

    // However the client ended, the container goes with it: removed by name and
    // shown gone, or the run fails closed below.
    const left = await removeContainer();

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
    };
  }
}
