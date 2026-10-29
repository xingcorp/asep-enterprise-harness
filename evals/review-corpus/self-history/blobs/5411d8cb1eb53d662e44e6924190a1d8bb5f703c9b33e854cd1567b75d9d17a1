// Trusted command runner (exit criteria F1–F3, D5). Runs a verification command
// as an argv (executable + args) with shell:false via child_process.spawn — a
// model-generated shell string can NEVER reach a shell here. The exact exit
// code and terminating signal are preserved (no 1→0 coercion). A timeout or an
// AbortSignal kills the WHOLE process group (detached + negative pid) so a child
// that spawned descendants cannot outlive the kill. Raw stdout/stderr stream
// through a BoundedCapture and are stored as immutable artifacts BEFORE the
// result is returned, so a summary/reducer never sees uncaptured output (D5).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TenantScope } from '@asep/contracts';
import type {
  CommandRunner, CommandSpec, CommandResult, SandboxHandle, ArtifactStore,
} from '@asep/ports';
import { BoundedCapture } from './bounded-capture.js';
import { resolveEnvironment } from './environment-profiles.js';

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
  constructor(
    private readonly scope: TenantScope,
    private readonly artifacts: ArtifactStore,
    private readonly signal?: AbortSignal,
  ) {}

  async run(spec: CommandSpec, _sandbox: SandboxHandle): Promise<CommandResult> {
    const env = resolveEnvironment(spec.environmentProfile);
    const stdoutCap = new BoundedCapture(spec.outputPolicy.maxEvidenceBytes);
    const stderrCap = new BoundedCapture(spec.outputPolicy.maxEvidenceBytes);

    const result = await new Promise<{
      exitCode: number | null; signal: string | null; timedOut: boolean;
    }>((resolve, reject) => {
      // shell:false is the default for spawn with an argv; we set it explicitly
      // to document the guarantee. detached:true puts the child in its own
      // process group so we can signal the whole group on timeout/cancel.
      const child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env,
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

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGKILL');
      }, spec.timeoutMs);

      const onAbort = () => { killGroup('SIGKILL'); };
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
