// Claude coding provider (exit criteria G1–G6, disp. P2-PLAN-HIGH-002). Behind
// the CodingAgentProvider port. It launches a PINNED Claude CLI executable that
// speaks stream-JSON, feeds it the harness-owned request (attemptId, immutable
// work-order/context-pack refs, budget, tool policy), captures the full raw
// event stream to an immutable artifact BEFORE parsing, parses it fail-closed,
// and returns ONLY an untrusted AgentAttemptObservation.
//
// Guarantees enforced here:
//   G1  model + CLI version are pinned config (recorded, not discovered).
//   G2  stream-JSON parsed structurally; malformed/partial → fail closed.
//   G3  max turns / timeout / cancellation (AbortSignal) / explicit tool policy /
//       sanitized env allowlist; no "dangerous permission bypass" flag exists.
//   G4  work-order + context-pack refs (with sha) recorded; events → artifact.
//   G5  the adapter holds NO GitHub credential (env allowlist excludes them) and
//       returns no attemptId/resultSha/changedFiles; each execute() call keeps
//       its own local state so concurrent attempts cannot cross over.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TenantScope, ArtifactRef } from '@asep/contracts';
import type {
  CodingAgentProvider, AgentExecuteRequest, AgentAttemptObservation,
  ArtifactStore,
} from '@asep/ports';
import { parseStream, MalformedEventError } from './event-parser.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Optional hardened-sandbox descriptor (disp. P2-FINAL-HIGH-002). When present,
// the agent CLI is executed INSIDE a digest-pinned container via
// `docker run <runFlags> -w <workdir> -e <allowlisted env…> <image> <exe> <args…>`
// — OS-enforced network/rootfs/caps isolation applies to the agent itself, not
// just to a prefix we throw away. The allowlisted ASEP_* / PATH / HOME / LANG
// env is injected with explicit `-e` flags and the docker process runs with a
// CLEAN host env, so NO host credential (GITHUB_TOKEN, *_TOKEN, AWS_*) can leak
// into the container even if it is present in the harness process (G3/G5). When
// absent, the CLI is spawned directly on the host (pilot-only / unit-test path).
export interface AgentSandboxConfig {
  readonly image: string;                 // digest-pinned image ref
  readonly runFlags: readonly string[];   // hardened `docker run` flags (no image)
  readonly workdir: string;               // -w working dir inside the container
}

export interface ClaudeProviderConfig {
  // PINNED executable + model + CLI version (G1). Recorded on every observation
  // artifact so a run's provenance is unambiguous.
  readonly executable: string;         // absolute path to the Claude CLI
  readonly model: string;              // e.g. 'claude-sonnet-4-20250514'
  readonly cliVersion: string;         // pinned, asserted against `--version` in live mode
  readonly maxTurns: number;
  // When set, the agent runs in-container (see AgentSandboxConfig). Optional so
  // the fake-CLI contract suite keeps exercising the real spawn/stdout boundary
  // on the host; the live in-container proof lives in *.itest.ts.
  readonly sandbox?: AgentSandboxConfig;
}

// The adapter needs a scope + artifact store to persist the raw event stream.
// Constructed per attempt; execute() holds all mutable state in locals so one
// instance can drive concurrent attempts with no crossover (G5).
export class ClaudeCodingProvider implements CodingAgentProvider {
  readonly providerId: string;

  constructor(
    private readonly cfg: ClaudeProviderConfig,
    private readonly scope: TenantScope,
    private readonly artifacts: ArtifactStore,
  ) {
    this.providerId = `claude:${cfg.model}@cli-${cfg.cliVersion}`;
  }

  // Env allowlist (G3/G5): a minimal, vetted environment. NO GITHUB_TOKEN,
  // GH_TOKEN, or any *_TOKEN / credential var is ever forwarded — the coding
  // agent is credential-free by construction.
  private agentEnv(req: AgentExecuteRequest): Record<string, string> {
    return {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/tmp',
      LANG: 'C',
      // Tool/network policy passed as explicit, structured env — never a
      // "bypass permissions" flag (which does not exist in this adapter).
      ASEP_ALLOWED_TOOLS: req.toolPolicy.allowedTools.join(','),
      ASEP_DISALLOWED_TOOLS: req.toolPolicy.disallowedTools.join(','),
      ASEP_NETWORK_PROFILE: req.toolPolicy.networkProfile,
      ASEP_MAX_TURNS: String(this.cfg.maxTurns),
    };
  }

  async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
    if (req.signal.aborted) {
      return this.aborted('cancelled before start');
    }

    // CLI argv (shell:false). The model + turn budget are pinned; the work-order
    // and context-pack are passed BY REFERENCE (immutable artifact id + sha), so
    // the agent reads them from the store, and we record exactly which bytes.
    const cliArgs = [
      '--model', this.cfg.model,
      '--output-format', 'stream-json',
      '--max-turns', String(this.cfg.maxTurns),
      '--work-order-ref', req.workOrderRef.artifactId,
      '--work-order-sha', req.workOrderRef.sha256,
      '--context-pack-ref', req.contextPackRef.artifactId,
      '--context-pack-sha', req.contextPackRef.sha256,
      '--workspace', req.workspace.workspaceId,
    ];

    const agentEnv = this.agentEnv(req);

    // Resolve the ACTUAL process to spawn + the env it runs under. In sandbox
    // mode the agent executes INSIDE the container: the allowlisted env is
    // injected via explicit `-e KEY=VALUE` docker flags and the docker process
    // itself runs with a CLEAN environment ({}), so no host credential can leak
    // into the container even if present in the harness (G3/G5). In host mode
    // (fake-CLI unit path) we spawn the CLI directly with the allowlisted env.
    let exe: string;
    let args: string[];
    let spawnEnv: Record<string, string>;
    if (this.cfg.sandbox) {
      const sb = this.cfg.sandbox;
      const envFlags = Object.entries(agentEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      exe = 'docker';
      args = [
        ...sb.runFlags,
        '-w', sb.workdir,
        ...envFlags,
        sb.image,
        this.cfg.executable,
        ...cliArgs,
      ];
      // The docker CLI process only needs PATH to locate the `docker` binary.
      // Docker forwards ONLY the explicit `-e` vars into the container, so the
      // host env of this process can never leak host credentials INTO the agent
      // — the container env is exactly the allowlist injected above (G3/G5).
      spawnEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
    } else {
      exe = this.cfg.executable;
      args = cliArgs;
      spawnEnv = agentEnv;
    }

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    // G3 wall-clock timeout: the budget's maxWallClockMinutes is an ENFORCED
    // deadline, not advice. Without a timer a hung/silent agent pins the attempt
    // forever — AbortSignal only helps when something else notices. On expiry the
    // child is SIGKILLed and the attempt reports TIMED_OUT, so the caller fails
    // closed with the raw stream captured up to that point.
    const timeoutMs = Math.max(1, Math.round(req.budget.maxWallClockMinutes * 60_000));
    const outcome = await new Promise<
      | { kind: 'exit'; code: number | null }
      | { kind: 'error'; err: Error }
      | { kind: 'timeout' }
    >((resolve) => {
      const child = spawn(exe, args, {
        env: spawnEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let timer: NodeJS.Timeout | undefined;
      const clear = () => { if (timer !== undefined) clearTimeout(timer); };
      const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        // Kill the whole process (SIGKILL, not SIGTERM: a wedged agent may ignore
        // a polite signal) and resolve as a timeout regardless of the exit event.
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        req.signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'timeout' });
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => {
        clear();
        req.signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'error', err });
      });
      child.on('close', (code) => {
        clear();
        req.signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'exit', code });
      });
    });

    // G4: persist the RAW event stream as an immutable artifact BEFORE parsing,
    // so evidence of what the provider actually emitted exists even if parsing
    // fails closed below.
    const streamBytes = new TextEncoder().encode(stdout);
    let eventRef: ArtifactRef | undefined;
    try {
      eventRef = await this.artifacts.put(this.scope, {
        kind: 'claude-event-stream',
        content: streamBytes,
        sha256: sha256Hex(streamBytes),
        contentType: 'application/x-ndjson; charset=utf-8',
      });
    } catch {
      // If even evidence persistence fails we still fail closed below.
    }

    if (req.signal.aborted) return this.aborted('cancelled during execution', eventRef);

    if (outcome.kind === 'timeout') {
      // G3: the wall-clock budget was exhausted and the child was SIGKILLed. This
      // is BUDGET_EXHAUSTED, not FAILED: the attempt did not fail on its merits,
      // it ran out of its allotted time. The raw stream captured up to the kill is
      // already persisted above, so evidence of the partial run survives.
      return {
        status: 'BUDGET_EXHAUSTED',
        summary: `Claude attempt exceeded its wall-clock budget of ${req.budget.maxWallClockMinutes} minute(s) and was terminated.`,
        knownLimitations: [`wall-clock timeout after ${timeoutMs}ms (SIGKILL)`],
        usage: {
          inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0,
          wallClockMs: Date.now() - started,
        },
        eventArtifactRefs: eventRef ? [eventRef] : [],
      };
    }

    if (outcome.kind === 'error') {
      return this.failed(`provider process error: ${outcome.err.message}`, eventRef);
    }
    if (outcome.code !== 0) {
      // A non-zero CLI exit is a hard failure (quota, permission denial, crash).
      // stderr often carries the reason; surface it as a limitation, fail closed.
      return this.failed(`provider exited ${outcome.code}: ${stderr.trim().slice(0, 300)}`, eventRef);
    }

    // G2: parse the stream structurally; malformed/partial → fail closed.
    try {
      const parsed = parseStream(stdout);
      const wallClockMs = parsed.result.usage.wallClockMs || (Date.now() - started);
      const base: AgentAttemptObservation = {
        status: parsed.result.status,
        summary: parsed.result.summary,
        knownLimitations: parsed.result.knownLimitations,
        usage: { ...parsed.result.usage, wallClockMs },
        eventArtifactRefs: eventRef ? [eventRef] : [],
      };
      return parsed.sessionId === undefined ? base : { ...base, providerSessionId: parsed.sessionId };
    } catch (err) {
      if (err instanceof MalformedEventError) {
        return this.failed(`malformed provider stream: ${err.message}`, eventRef);
      }
      throw err;
    }
  }

  private aborted(reason: string, eventRef?: ArtifactRef): AgentAttemptObservation {
    return {
      status: 'BLOCKED',
      summary: `Claude attempt ${reason}.`,
      knownLimitations: [reason],
      usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 0 },
      eventArtifactRefs: eventRef ? [eventRef] : [],
    };
  }

  private failed(reason: string, eventRef?: ArtifactRef): AgentAttemptObservation {
    return {
      status: 'FAILED',
      summary: 'Claude attempt failed.',
      knownLimitations: [reason],
      usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 0 },
      eventArtifactRefs: eventRef ? [eventRef] : [],
    };
  }
}
