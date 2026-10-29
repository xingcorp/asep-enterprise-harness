// Claude coding provider (exit criteria E8, G1–G6). Behind the
// CodingAgentProvider port. One execute() call is one contained attempt:
//
//   1. the tool policy is translated into an exact Claude tool grant (a word
//      outside the closed vocabulary, or a network profile the agent cannot run
//      under, is refused before anything starts);
//   2. the work order and context pack are fetched from the artifact store,
//      re-hashed against their refs, and written to a per-attempt directory that
//      is mounted READ-ONLY into the agent container;
//   3. a model credential is requested for this attempt from the credential
//      provider;
//   4. an INTERNAL Docker network is created (no gateway, no route out, no
//      external DNS), and an egress proxy container is started on the egress
//      network and attached to it. The credential is written to the proxy's
//      STDIN — it is never in an argv, an environment variable or a file;
//   5. the agent runs in a hardened, digest-pinned container on the internal
//      network, with the real `claude` CLI flags, a placeholder API key and
//      ANTHROPIC_BASE_URL pointing at the proxy. Only the leased worktree is
//      writable; its `.git` indirection and the inputs are read-only binds. The
//      instruction goes in on stdin — the CLI's real prompt channel;
//   6. stdout is parsed AS IT ARRIVES (stream-json): the init event is checked
//      against the pins and the grant, and the tool-call budget is enforced
//      while the agent runs. A timeout, a cancellation or a violation removes
//      the container;
//   7. the containers and the network are torn down in `finally`, the raw event
//      stream, an invocation manifest and the proxy's access log are stored as
//      artifacts (with any credential material redacted — and its presence
//      fails the attempt), and ONLY an untrusted AgentAttemptObservation is
//      returned.
//
// The provider never holds a GitHub credential, never commits or pushes, and
// returns no attemptId / resultSha / changedFiles: those are harness facts.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TenantScope, ArtifactRef, WorkspaceId } from '@asep/contracts';
import type {
  CodingAgentProvider, AgentExecuteRequest, AgentAttemptObservation, ArtifactStore,
} from '@asep/ports';
import {
  isDigestPinned, dockerCaller, dockerClientEnv, removeLabelledContainers, type DockerCall,
} from '@asep/command-runner';
import {
  ClaudeStreamParser, MalformedEventError, type ClaudeInit, type ParsedStream,
} from './event-parser.js';
import { claudeToolGrant, ToolPolicyError, type ClaudeToolGrant } from './tool-policy.js';
import {
  redactSecrets, parseModelBaseUrl, ModelCredentialError,
  type ModelCredential, type ModelCredentialProvider,
} from './model-credentials.js';

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- configuration -----------------------------------------------------------

export interface AgentSandboxConfig {
  // Digest-pinned image that contains the pinned Claude CLI.
  readonly image: string;
  // Digest-pinned image with `node` on PATH, used to run the egress proxy.
  readonly proxyImage: string;
  // The host path of a leased worktree. Called at execute() time: the worktree
  // does not exist when a composition root builds the provider.
  readonly workdirFor: (workspaceId: WorkspaceId) => string;
  // Host directory under which per-attempt input directories are created.
  // Defaults to the OS temp directory. Must be shareable with the Docker daemon.
  readonly inputRoot?: string;
  // The network the proxy reaches the model API through. Defaults to `bridge`.
  readonly egressNetwork?: string;
  // Extra host paths bind-mounted READ-ONLY at the same path, for a CLI that is
  // not baked into the image (test installs). Production passes none.
  readonly toolMounts?: readonly string[];
  readonly limits?: { readonly cpus?: string; readonly memory?: string; readonly pids?: number };
  // The docker client binary. Defaults to `docker` on PATH.
  readonly dockerBinary?: string;
}

export interface ClaudeProviderConfig {
  // PINNED executable (its path inside the agent image), model and CLI version
  // (G1). The init event must report exactly this version and model.
  readonly executable: string;
  readonly model: string;
  readonly cliVersion: string;
  readonly maxTurns: number;
  // E8/G3: always contained. There is no host-execution mode.
  readonly sandbox: AgentSandboxConfig;
  readonly credentials: ModelCredentialProvider;
}

export class AgentConfigError extends Error {
  constructor(reason: string) {
    super(`ClaudeCodingProvider misconfigured: ${reason}`);
    this.name = 'AgentConfigError';
  }
}

// --- the fixed parts of the contained run --------------------------------------

const PROXY_PORT = 8080;
const PROXY_ASSET = fileURLToPath(new URL('../assets/egress-proxy.mjs', import.meta.url));
const PROXY_ASSET_IN_CONTAINER = '/opt/asep/egress-proxy.mjs';
const PROXY_READY = /asep-egress-proxy listening (\d+)/;
const PROXY_START_TIMEOUT_MS = 30_000;
// What the agent holds instead of the credential. The proxy discards it.
export const MODEL_KEY_PLACEHOLDER = 'asep-placeholder-the-egress-proxy-holds-the-real-key';
// The only paths the proxy forwards (mirrors assets/egress-proxy.mjs).
export const EGRESS_ALLOWLIST: readonly string[] = ['POST /v1/messages', 'POST /v1/messages/count_tokens'];

const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_SUMMARY_CHARS = 4000;

// The docker CLI process gets only what it needs to find its daemon
// (dockerClientEnv). None of it reaches a container: container env is exactly
// the `-e` list below.

/** The agent's flags, exactly as the pinned CLI accepts them. */
export function buildClaudeArgs(p: {
  readonly model: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly grant: ClaudeToolGrant;
  readonly inputDir: string;
}): string[] {
  return [
    '-p', '--bare', '--verbose',
    '--output-format', 'stream-json',
    '--model', p.model,
    '--max-turns', String(p.maxTurns),
    '--max-budget-usd', String(p.maxBudgetUsd),
    // Edits inside the working directory need no prompt; anything that WOULD
    // prompt is denied, because nobody is there to answer.
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--tools', p.grant.tools.join(','),
    ...(p.grant.tools.length > 0 ? ['--allowedTools', p.grant.tools.join(',')] : []),
    '--disallowedTools', p.grant.disallowed.join(','),
    '--add-dir', p.inputDir,
    // No user/project settings, MCP servers, slash commands or saved sessions:
    // the session is exactly what these flags say.
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

/** The instruction, sent on stdin (the CLI's prompt channel), never in argv. */
export function buildPrompt(p: {
  readonly workdir: string;
  readonly workOrder: { readonly path: string; readonly sha256: string };
  readonly contextPack: { readonly path: string; readonly sha256: string };
}): string {
  return [
    `You are working in the repository checked out at ${p.workdir}.`,
    `Your work order is ${p.workOrder.path} (sha256 ${p.workOrder.sha256}).`,
    `Your context pack is ${p.contextPack.path} (sha256 ${p.contextPack.sha256}).`,
    'Both files are read-only. Read both before you change anything.',
    `Make the change the work order asks for, editing files only inside ${p.workdir}.`,
    'Do not run git, do not commit and do not push: the harness inspects and commits your changes after you exit.',
    'When you are done, reply with a short summary of what you changed.',
    '',
  ].join('\n');
}

function bindMount(src: string, readonly: boolean): string[] {
  // `--mount` refuses a missing source instead of creating it (unlike `-v`), and
  // its comma-separated syntax cannot carry a path with a comma in it.
  if (/[,=]/.test(src)) throw new AgentConfigError(`cannot bind-mount '${src}' (',' or '=' in path)`);
  return ['--mount', `type=bind,src=${src},dst=${src}${readonly ? ',readonly' : ''}`];
}

/** Hardened `docker run` argv for the agent container. */
export function buildAgentRunArgs(p: {
  readonly name: string;
  readonly network: string;
  readonly attemptId: string;
  readonly workdir: string;
  readonly gitIndirection?: string;
  readonly inputDir: string;
  readonly toolMounts: readonly string[];
  readonly limits: { readonly cpus?: string; readonly memory?: string; readonly pids?: number };
  readonly user?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly executable: string;
  readonly cliArgs: readonly string[];
}): string[] {
  return [
    'run', '--rm', '-i',
    '--name', p.name,
    '--network', p.network,
    '--label', `asep.attempt=${p.attemptId}`,
    '--label', 'asep.role=agent',
    '--label', `asep.container=${p.name}`,
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(p.limits.pids ?? 256),
    '--cpus', p.limits.cpus ?? '2',
    '--memory', p.limits.memory ?? '2g',
    ...(p.user !== undefined ? ['--user', p.user] : []),
    // The leased worktree is the only writable bind. Its `.git` indirection is
    // re-bound read-only on top (deeper destinations mount after their parent),
    // so the agent cannot repoint the gitdir; the mirror is not mounted at all.
    ...bindMount(p.workdir, false),
    ...(p.gitIndirection !== undefined ? bindMount(p.gitIndirection, true) : []),
    ...bindMount(p.inputDir, true),
    ...p.toolMounts.flatMap((m) => bindMount(m, true)),
    '-w', p.workdir,
    ...Object.entries(p.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    p.image,
    p.executable,
    ...p.cliArgs,
  ];
}

/** Hardened `docker run` argv for the egress proxy container. */
export function buildProxyRunArgs(p: {
  readonly name: string;
  readonly egressNetwork: string;
  readonly attemptId: string;
  readonly image: string;
  readonly upstream: string;
}): string[] {
  return [
    'run', '--rm', '-i',
    '--name', p.name,
    '--network', p.egressNetwork,
    '--label', `asep.attempt=${p.attemptId}`,
    '--label', 'asep.role=egress-proxy',
    '--label', `asep.container=${p.name}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--cpus', '0.5',
    '--memory', '256m',
    '--user', '65534:65534',
    '--mount', `type=bind,src=${PROXY_ASSET},dst=${PROXY_ASSET_IN_CONTAINER},readonly`,
    p.image,
    'node', PROXY_ASSET_IN_CONTAINER,
    '--listen', `0.0.0.0:${PROXY_PORT}`,
    '--upstream', p.upstream,
  ];
}

// --- small process helpers -----------------------------------------------------

interface Captured {
  text: string;
  bytes: number;
}

function appendBounded(c: Captured, chunk: Buffer, max: number): void {
  if (c.bytes >= max) return;
  const room = max - c.bytes;
  const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
  c.text += part.toString('utf8');
  c.bytes += part.byteLength;
}

function runDocker(
  bin: string, args: readonly string[], timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: dockerClientEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Captured = { text: '', bytes: 0 };
    const err: Captured = { text: '', bytes: 0 };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => appendBounded(out, d, MAX_STDERR_BYTES));
    child.stderr.on('data', (d: Buffer) => appendBounded(err, d, MAX_STDERR_BYTES));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out.text, stderr: err.text }); });
  });
}

// Remove every network carrying `label` and confirm none is left; undefined when
// gone, else why not. (Its containers must already be gone.)
async function removeLabelledNetworks(docker: DockerCall, label: string): Promise<string | undefined> {
  let last = 'not checked';
  for (let i = 0; i < 5; i++) {
    if (i > 1) await new Promise((r) => setTimeout(r, 250));
    const ls = await docker(['network', 'ls', '-q', '--filter', `label=${label}`]);
    if (ls.code !== 0) {
      last = `docker network ls failed: ${ls.stderr.trim().slice(0, 200) || `exit ${ls.code}`}`;
      continue;
    }
    const ids = ls.stdout.split(/\s+/).filter((x) => x !== '');
    if (ids.length === 0) return undefined;
    const rm = await docker(['network', 'rm', ...ids]);
    last = rm.code === 0 ? `${ids.join(', ')} still listed` : `docker network rm failed: ${rm.stderr.trim().slice(0, 200)}`;
  }
  return `network(s) labelled ${label} could not be shown removed: ${last}`;
}

// --- the attempt ---------------------------------------------------------------

type AgentEnd =
  | { readonly kind: 'exit'; readonly code: number | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'stopped'; readonly status: 'FAILED' | 'BUDGET_EXHAUSTED'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

interface InputFile {
  readonly name: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly path: string;
}

interface RunRecord {
  // Set when the attempt never reached the agent container.
  setup?: { readonly status: 'FAILED' | 'BLOCKED'; readonly reason: string };
  end?: AgentEnd;
  stdout: Captured;
  stderr: Captured;
  egressLog: Captured;
  parser: ClaudeStreamParser;
  parsed?: ParsedStream;
  parseError?: string;
  inputs: InputFile[];
  inputsIntact?: boolean;
  invocation?: Record<string, unknown>;
  teardown: string[];
  // Containers or networks of the attempt that could not be shown removed.
  leftovers: string[];
  secrets: string[];
}

export class ClaudeCodingProvider implements CodingAgentProvider {
  readonly providerId: string;
  private readonly docker: string;

  constructor(
    private readonly cfg: ClaudeProviderConfig,
    private readonly scope: TenantScope,
    private readonly artifacts: ArtifactStore,
  ) {
    for (const k of ['executable', 'model', 'cliVersion'] as const) {
      if (typeof cfg[k] !== 'string' || cfg[k].trim() === '') throw new AgentConfigError(`${k} is required`);
    }
    if (!Number.isInteger(cfg.maxTurns) || cfg.maxTurns < 1) {
      throw new AgentConfigError('maxTurns must be a positive integer');
    }
    const sb = cfg.sandbox;
    if (sb === undefined || sb === null) throw new AgentConfigError('sandbox is required');
    if (!isDigestPinned(sb.image)) {
      throw new AgentConfigError(`sandbox.image must be digest-pinned (…@sha256:<64hex>), got '${sb.image}'`);
    }
    if (!isDigestPinned(sb.proxyImage)) {
      throw new AgentConfigError(
        `sandbox.proxyImage must be digest-pinned (…@sha256:<64hex>), got '${sb.proxyImage}'`,
      );
    }
    if (typeof sb.workdirFor !== 'function') throw new AgentConfigError('sandbox.workdirFor is required');
    for (const m of sb.toolMounts ?? []) {
      if (!isAbsolute(m)) throw new AgentConfigError(`tool mount '${m}' is not an absolute path`);
    }
    if (cfg.credentials === undefined || typeof cfg.credentials.credentialFor !== 'function') {
      throw new AgentConfigError('credentials (a ModelCredentialProvider) are required');
    }
    this.docker = sb.dockerBinary ?? 'docker';
    this.providerId = `claude:${cfg.model}@cli-${cfg.cliVersion}`;
  }

  async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
    const started = Date.now();
    if (req.signal.aborted) return this.observation('BLOCKED', 'cancelled before start', started);

    let grant: ClaudeToolGrant;
    try {
      grant = claudeToolGrant(req.toolPolicy);
    } catch (err) {
      if (err instanceof ToolPolicyError) return this.observation('BLOCKED', err.message, started);
      throw err;
    }

    const rec: RunRecord = {
      stdout: { text: '', bytes: 0 },
      stderr: { text: '', bytes: 0 },
      egressLog: { text: '', bytes: 0 },
      parser: new ClaudeStreamParser(),
      inputs: [],
      teardown: [],
      leftovers: [],
      secrets: [],
    };
    await this.contained(req, grant, started, rec);
    return this.conclude(req, started, rec);
  }

  // Everything that touches docker. Never throws: every failure lands in `rec`.
  private async contained(
    req: AgentExecuteRequest, grant: ClaudeToolGrant, started: number, rec: RunRecord,
  ): Promise<void> {
    const sb = this.cfg.sandbox;
    const deadline = started + Math.max(1, Math.round(req.budget.maxWallClockMinutes * 60_000));
    const suffix = `${req.attemptId.slice(-8).toLowerCase()}-${randomBytes(4).toString('hex')}`;
    const network = `asep-agent-net-${suffix}`;
    const proxyName = `asep-egress-${suffix}`;
    const agentName = `asep-agent-${suffix}`;
    const created = { network: false, proxy: false, agent: false };
    let proxyChild: ReturnType<typeof spawn> | undefined;
    let proxyClosed: Promise<void> = Promise.resolve();
    let inputDir: string | undefined;

    const setup = (status: 'FAILED' | 'BLOCKED', reason: string): void => {
      rec.setup = { status, reason };
    };

    try {
      // --- the leased worktree --------------------------------------------
      let workdir: string;
      try {
        const raw = sb.workdirFor(req.workspace.workspaceId);
        if (!isAbsolute(raw)) throw new Error(`'${raw}' is not absolute`);
        workdir = await realpath(raw);
        if (!(await stat(workdir)).isDirectory()) throw new Error(`'${workdir}' is not a directory`);
      } catch (err) {
        setup('FAILED', `leased worktree unavailable: ${(err as Error).message}`);
        return;
      }
      let gitIndirection: string | undefined = join(workdir, '.git');
      try {
        await stat(gitIndirection);
      } catch {
        gitIndirection = undefined;
      }

      // --- the inputs: fetched, re-hashed, written read-only ----------------
      inputDir = await realpath(await mkdtemp(join(sb.inputRoot ?? tmpdir(), 'asep-agent-inputs-')));
      for (const [name, ref] of [
        ['work-order', req.workOrderRef], ['context-pack', req.contextPackRef],
      ] as const) {
        let bytes: Uint8Array;
        let contentType: string;
        try {
          const got = await this.artifacts.get(this.scope, ref);
          bytes = got.content;
          contentType = got.contentType;
        } catch (err) {
          setup('FAILED', `${name} ${ref.artifactId} could not be read: ${(err as Error).message}`);
          return;
        }
        const actual = sha256Hex(bytes);
        if (actual !== ref.sha256) {
          setup('FAILED', `${name} ${ref.artifactId} hashes to ${actual}, not the referenced ${ref.sha256}`);
          return;
        }
        const path = join(inputDir, `${name}${contentType.startsWith('application/json') ? '.json' : '.txt'}`);
        await writeFile(path, bytes, { mode: 0o444 });
        rec.inputs.push({ name, artifactId: ref.artifactId, sha256: actual, path });
      }
      await chmod(inputDir, 0o555);

      // --- the credential (for this attempt; held only in memory) ----------
      let credential: ModelCredential;
      try {
        credential = await this.cfg.credentials.credentialFor({ scope: this.scope, attemptId: req.attemptId });
      } catch (err) {
        setup('FAILED', err instanceof ModelCredentialError ? err.message : 'model credential unavailable');
        return;
      }
      if (typeof credential.apiKey !== 'string' || credential.apiKey.trim() === '' || /\s/.test(credential.apiKey)) {
        setup('FAILED', 'model credential unavailable: the credential provider returned no usable key');
        return;
      }
      let upstream: string;
      try {
        upstream = parseModelBaseUrl(credential.baseUrl);
      } catch (err) {
        setup('FAILED', (err as Error).message);
        return;
      }
      rec.secrets.push(credential.apiKey);

      const workOrder = rec.inputs[0]!;
      const contextPack = rec.inputs[1]!;
      const env: Record<string, string> = {
        HOME: '/tmp',
        LANG: 'C.UTF-8',
        ANTHROPIC_BASE_URL: `http://${proxyName}:${PROXY_PORT}`,
        ANTHROPIC_API_KEY: MODEL_KEY_PLACEHOLDER,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      };
      const cliArgs = buildClaudeArgs({
        model: this.cfg.model,
        maxTurns: Math.min(this.cfg.maxTurns, req.budget.maxTurns),
        maxBudgetUsd: req.budget.maxCostUsd,
        grant,
        inputDir,
      });
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
      let agentArgs: string[];
      try {
        agentArgs = buildAgentRunArgs({
          name: agentName,
          network,
          attemptId: req.attemptId,
          workdir,
          ...(gitIndirection !== undefined ? { gitIndirection } : {}),
          inputDir,
          toolMounts: sb.toolMounts ?? [],
          limits: sb.limits ?? {},
          ...(uid !== undefined && gid !== undefined ? { user: `${uid}:${gid}` } : {}),
          env,
          image: sb.image,
          executable: this.cfg.executable,
          cliArgs,
        });
      } catch (err) {
        setup('FAILED', (err as Error).message);
        return;
      }
      const prompt = buildPrompt({
        workdir,
        workOrder: { path: workOrder.path, sha256: workOrder.sha256 },
        contextPack: { path: contextPack.path, sha256: contextPack.sha256 },
      });
      const egressNetwork = sb.egressNetwork ?? 'bridge';
      const proxyArgs = buildProxyRunArgs({
        name: proxyName, egressNetwork, attemptId: req.attemptId,
        image: sb.proxyImage, upstream,
      });
      rec.invocation = {
        providerId: this.providerId,
        model: this.cfg.model,
        cliVersion: this.cfg.cliVersion,
        image: sb.image,
        proxyImage: sb.proxyImage,
        network: { internal: network, egress: egressNetwork, upstream },
        egressAllowlist: EGRESS_ALLOWLIST,
        toolGrant: grant,
        inputs: rec.inputs.map(({ name, artifactId, sha256, path }) => ({ name, artifactId, sha256, path })),
        promptSha256: sha256Hex(prompt),
        agentDockerArgs: agentArgs,
        proxyDockerArgs: proxyArgs,
      };

      if (req.signal.aborted) {
        setup('BLOCKED', 'cancelled before start');
        return;
      }

      // --- the internal network --------------------------------------------
      const net = await runDocker(this.docker, [
        'network', 'create', '--internal', '--label', `asep.attempt=${req.attemptId}`, network,
      ]);
      if (net.code !== 0) {
        setup('FAILED', `docker network create failed: ${net.stderr.trim().slice(0, 300)}`);
        return;
      }
      created.network = true;

      // --- the egress proxy, credential on stdin ----------------------------
      const proxyReady = await new Promise<string | undefined>((resolve) => {
        const child = spawn(this.docker, proxyArgs, {
          env: dockerClientEnv(), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        });
        proxyChild = child;
        created.proxy = true;
        let out = '';
        let settled = false;
        const finish = (v: string | undefined): void => {
          if (!settled) { settled = true; clearTimeout(timer); resolve(v); }
        };
        const timer = setTimeout(
          () => finish('egress proxy did not become ready in time'),
          Math.min(PROXY_START_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
        proxyClosed = new Promise<void>((done) => child.on('close', () => done()));
        child.stdout!.on('data', (d: Buffer) => {
          out += d.toString('utf8');
          if (PROXY_READY.test(out)) finish(undefined);
        });
        child.stderr!.on('data', (d: Buffer) => appendBounded(rec.egressLog, d, MAX_STDERR_BYTES));
        child.on('error', (e) => finish(`egress proxy could not start: ${e.message}`));
        child.on('close', (code) => finish(`egress proxy exited ${code} before it was ready`));
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(`${credential.apiKey}\n`);
      });
      if (proxyReady !== undefined) {
        setup('FAILED', `${proxyReady}: ${redactSecrets(rec.egressLog.text, rec.secrets).text.trim().slice(0, 300)}`);
        return;
      }
      const connect = await runDocker(this.docker, ['network', 'connect', network, proxyName]);
      if (connect.code !== 0) {
        setup('FAILED', `docker network connect failed: ${connect.stderr.trim().slice(0, 300)}`);
        return;
      }

      // --- the agent ----------------------------------------------------------
      created.agent = true;
      rec.end = await this.runAgent(req, agentArgs, agentName, prompt, deadline, workdir, grant, rec);

      // The inputs were read-only binds; prove they are byte-identical still.
      let intact = true;
      for (const f of rec.inputs) {
        try {
          if (sha256Hex(await readFile(f.path)) !== f.sha256) intact = false;
        } catch {
          intact = false;
        }
      }
      rec.inputsIntact = intact;
    } catch (err) {
      if (rec.setup === undefined && rec.end === undefined) {
        setup('FAILED', `contained run failed: ${(err as Error).message}`);
      }
    } finally {
      // Teardown is unconditional. Each container is removed by name — the
      // proxy's is stopped first, while its client is still attached — then
      // everything labelled with this attempt is removed and shown gone. What
      // cannot be shown gone fails the attempt (see conclude).
      const docker = dockerCaller(this.docker, dockerClientEnv());
      if (created.agent) await this.remove(agentName, rec);
      if (created.proxy) {
        await docker(['kill', proxyName]);
        proxyChild?.kill('SIGKILL');
        await Promise.race([proxyClosed, new Promise((r) => setTimeout(r, 5_000))]);
        await this.remove(proxyName, rec);
      }
      if (created.network || created.proxy || created.agent) {
        const left = await removeLabelledContainers(docker, `asep.attempt=${req.attemptId}`);
        if (left !== undefined) rec.leftovers.push(left);
      }
      if (created.network) {
        const r = await runDocker(this.docker, ['network', 'rm', network]);
        if (r.code !== 0) rec.teardown.push(`network ${network} not removed: ${r.stderr.trim().slice(0, 200)}`);
        const left = await removeLabelledNetworks(docker, `asep.attempt=${req.attemptId}`);
        if (left !== undefined) rec.leftovers.push(left);
      }
      if (inputDir !== undefined) {
        await chmod(inputDir, 0o755).catch(() => undefined);
        await rm(inputDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async remove(name: string, rec: RunRecord): Promise<void> {
    const r = await runDocker(this.docker, ['rm', '-f', name]);
    if (r.code !== 0 && !/no such container|already in progress/i.test(r.stderr)) {
      rec.teardown.push(`container ${name} not removed: ${r.stderr.trim().slice(0, 200)}`);
    }
  }

  private runAgent(
    req: AgentExecuteRequest,
    args: readonly string[],
    name: string,
    prompt: string,
    deadline: number,
    workdir: string,
    grant: ClaudeToolGrant,
    rec: RunRecord,
  ): Promise<AgentEnd> {
    return new Promise<AgentEnd>((resolve) => {
      const child = spawn(this.docker, args, {
        env: dockerClientEnv(), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let ended: AgentEnd | undefined;
      let pending = '';
      // The first reason to stop wins; the container itself is stopped (not
      // merely its docker client killed), so nothing keeps running inside. It
      // is removed by name once the client has ended.
      const stop = (end: AgentEnd): void => {
        if (ended !== undefined) return;
        ended = end;
        void runDocker(this.docker, ['kill', name]).finally(() => child.kill('SIGKILL'));
      };
      const timer = setTimeout(() => stop({ kind: 'timeout' }), Math.max(1, deadline - Date.now()));
      const onAbort = (): void => stop({ kind: 'aborted' });
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });

      const onLine = (line: string): void => {
        try {
          const ev = rec.parser.push(line);
          if (ev?.type === 'init') {
            const why = initViolation(ev.init, this.cfg, grant, workdir);
            if (why !== undefined) stop({ kind: 'stopped', status: 'FAILED', reason: why });
          }
        } catch (err) {
          if (err instanceof MalformedEventError) {
            rec.parseError = err.message;
            stop({ kind: 'stopped', status: 'FAILED', reason: `malformed provider stream: ${err.message}` });
            return;
          }
          throw err;
        }
        if (rec.parser.toolCallCount > req.budget.maxToolCalls) {
          stop({
            kind: 'stopped', status: 'BUDGET_EXHAUSTED',
            reason: `tool-call budget of ${req.budget.maxToolCalls} exceeded`,
          });
        }
      };

      child.stdout.on('data', (d: Buffer) => {
        if (rec.stdout.bytes + d.byteLength > MAX_STDOUT_BYTES) {
          stop({ kind: 'stopped', status: 'FAILED', reason: `provider output exceeded ${MAX_STDOUT_BYTES} bytes` });
          return;
        }
        appendBounded(rec.stdout, d, MAX_STDOUT_BYTES);
        pending += d.toString('utf8');
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (ended === undefined) onLine(line);
        }
      });
      child.stderr.on('data', (d: Buffer) => appendBounded(rec.stderr, d, MAX_STDERR_BYTES));
      const settle = (fallback: AgentEnd): void => {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        if (ended === undefined) {
          ended = fallback;
          if (fallback.kind === 'exit') {
            try {
              if (pending.trim() !== '') throw new MalformedEventError('truncated final line', pending);
              rec.parsed = rec.parser.finish(rec.stdout.text.slice(-200));
            } catch (err) {
              if (!(err instanceof MalformedEventError)) throw err;
              rec.parseError = err.message;
            }
          }
        }
        resolve(ended);
      };
      child.on('error', (e) => settle({ kind: 'error', message: e.message }));
      child.on('close', (code) => settle({ kind: 'exit', code }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(prompt);
    });
  }

  // Persist the evidence and turn the record into the untrusted observation.
  private async conclude(
    req: AgentExecuteRequest, started: number, rec: RunRecord,
  ): Promise<AgentAttemptObservation> {
    const stdout = redactSecrets(rec.stdout.text, rec.secrets);
    const stderr = redactSecrets(rec.stderr.text, rec.secrets);
    const egress = redactSecrets(rec.egressLog.text, rec.secrets);
    const leaked = stdout.redacted || stderr.redacted || egress.redacted;

    const refs: ArtifactRef[] = [];
    let eventsStored = true;
    // Linked to the attempt, so the pilot verifier can find what the real
    // adapter recorded for it; a double records nothing of the kind.
    const put = async (kind: string, text: string, contentType: string): Promise<boolean> => {
      const bytes = new TextEncoder().encode(text);
      try {
        refs.push(await this.artifacts.put(this.scope, {
          kind, content: bytes, sha256: sha256Hex(bytes), contentType, attemptId: req.attemptId,
        }));
        return true;
      } catch {
        return false;
      }
    };
    // G4: the raw event stream is recorded whatever happened — before mapping —
    // so evidence of what the provider emitted survives a fail-closed parse.
    if (rec.end !== undefined) {
      eventsStored = await put('claude-event-stream', stdout.text, 'application/x-ndjson; charset=utf-8');
    }
    if (rec.invocation !== undefined) {
      const manifest = redactSecrets(JSON.stringify({ ...rec.invocation, teardown: rec.teardown }, null, 2), rec.secrets);
      await put('claude-invocation', `${manifest.text}\n`, 'application/json');
    }
    if (rec.egressLog.bytes > 0) await put('claude-egress-log', egress.text, 'text/plain; charset=utf-8');

    const limitations: string[] = [
      ...rec.teardown.map((t) => `teardown: ${t}`),
      ...rec.leftovers.map((t) => `teardown: ${t}`),
    ];
    const init = rec.parser.finishedInit();
    const usageFrom = (parsed?: ParsedStream) => ({
      inputTokens: parsed?.result.inputTokens ?? 0,
      outputTokens: parsed?.result.outputTokens ?? 0,
      modelCostUsd: parsed?.result.totalCostUsd ?? 0,
      toolCalls: rec.parser.toolCallCount,
      wallClockMs: parsed?.result.durationMs || (Date.now() - started),
    });
    const build = (
      status: AgentAttemptObservation['status'], summary: string, extra: readonly string[],
    ): AgentAttemptObservation => {
      const base: AgentAttemptObservation = {
        status,
        summary: redactSecrets(summary, rec.secrets).text.slice(0, MAX_SUMMARY_CHARS),
        knownLimitations: [...extra, ...limitations].map((l) => redactSecrets(l, rec.secrets).text),
        usage: usageFrom(rec.parsed),
        eventArtifactRefs: refs,
      };
      return init === undefined ? base : { ...base, providerSessionId: init.sessionId };
    };

    // Nothing the attempt started may outlive it: a container or network that
    // cannot be shown removed could still be running beside the worktree.
    if (rec.leftovers.length > 0) {
      return build('FAILED', 'Claude attempt failed closed: its containers or network could not be shown removed.', []);
    }
    if (rec.setup !== undefined) {
      return build(rec.setup.status, `Claude attempt did not start: ${rec.setup.reason}.`, [rec.setup.reason]);
    }
    const end = rec.end!;
    if (leaked) {
      const where = [stdout.redacted && 'event stream', stderr.redacted && 'stderr', egress.redacted && 'egress log']
        .filter(Boolean).join(', ');
      return build('FAILED', 'Claude attempt failed closed: model credential material appeared in provider output.',
        [`model credential appeared in the ${where} and was redacted`]);
    }
    if (!eventsStored) {
      return build('FAILED', 'Claude attempt failed closed: its event stream could not be recorded.',
        ['event stream artifact could not be stored']);
    }
    if (rec.inputsIntact === false) {
      return build('FAILED', 'Claude attempt failed closed: its read-only inputs changed during the run.',
        ['work order / context pack bytes changed during the run']);
    }
    switch (end.kind) {
      case 'aborted':
        return build('BLOCKED', 'Claude attempt cancelled during execution.', ['cancelled during execution']);
      case 'timeout':
        return build('BUDGET_EXHAUSTED',
          `Claude attempt exceeded its wall-clock budget of ${req.budget.maxWallClockMinutes} minute(s) and was terminated.`,
          [`wall-clock timeout after ${Math.round(req.budget.maxWallClockMinutes * 60_000)}ms (container removed)`]);
      case 'stopped':
        return build(end.status, `Claude attempt stopped: ${end.reason}.`, [end.reason]);
      case 'error':
        return build('FAILED', 'Claude attempt failed.', [`provider process error: ${end.message}`]);
      case 'exit':
        break;
    }
    const code = end.code;
    const parsed = rec.parsed;
    if (parsed === undefined) {
      const why = code !== 0
        ? `provider exited ${code}: ${stderr.text.trim().slice(0, 300)}`
        : `malformed provider stream: ${rec.parseError ?? 'no result'}`;
      return build('FAILED', 'Claude attempt failed.', [why]);
    }
    const r = parsed.result;
    const notes = [
      ...r.permissionDenials.map((t) => `permission denied: ${t}`),
      ...(parsed.notices.includes('system/api_retry')
        ? [`model API retried ${parsed.notices.filter((n) => n === 'system/api_retry').length} time(s)`]
        : []),
    ];
    if (r.subtype === 'error_max_turns' || r.subtype === 'error_max_budget_usd') {
      return build('BUDGET_EXHAUSTED', `Claude attempt exhausted its budget (${r.subtype}).`, [r.subtype, ...notes]);
    }
    if (r.subtype !== 'success' || r.isError) {
      // An API failure (quota, auth, overload) arrives as an error result whose
      // text carries the API's message.
      const detail = r.text !== undefined ? `: ${r.text.slice(0, 300)}` : '';
      return build('FAILED', `Claude attempt failed (${r.subtype}${r.isError ? ', is_error' : ''}).`,
        [`result ${r.subtype}${r.isError ? ' is_error' : ''}${detail}`, ...notes]);
    }
    if (code !== 0) {
      return build('FAILED', 'Claude attempt failed.', [`provider exited ${code} after a success result`, ...notes]);
    }
    if (r.totalCostUsd > req.budget.maxCostUsd) {
      return build('BUDGET_EXHAUSTED', 'Claude attempt exceeded its cost budget.',
        [`cost ${r.totalCostUsd} USD over the budget of ${req.budget.maxCostUsd} USD`, ...notes]);
    }
    return build('AGENT_DONE', r.text ?? '', notes);
  }

  private observation(
    status: AgentAttemptObservation['status'], reason: string, started: number,
  ): AgentAttemptObservation {
    return {
      status,
      summary: `Claude attempt ${reason}.`,
      knownLimitations: [reason],
      usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: Date.now() - started },
      eventArtifactRefs: [],
    };
  }
}

/** Why an init event contradicts the pins, the grant or the workspace — or undefined. */
export function initViolation(
  init: ClaudeInit,
  pins: { readonly cliVersion: string; readonly model: string },
  grant: ClaudeToolGrant,
  workdir: string,
): string | undefined {
  if (init.cliVersion !== pins.cliVersion) {
    return `CLI reports version ${init.cliVersion}, not the pinned ${pins.cliVersion}`;
  }
  if (init.model !== pins.model) return `CLI reports model ${init.model}, not the pinned ${pins.model}`;
  if (init.permissionMode !== 'acceptEdits') {
    return `CLI runs in permission mode ${init.permissionMode}, not acceptEdits`;
  }
  const granted = new Set(grant.tools);
  const extra = init.tools.filter((t) => !granted.has(t));
  if (extra.length > 0) return `CLI exposes tools that were not granted: ${extra.join(', ')}`;
  if (init.mcpServers.length > 0) return `CLI loaded MCP servers: ${init.mcpServers.join(', ')}`;
  if (init.cwd !== workdir) return `CLI runs in ${init.cwd}, not the leased worktree ${workdir}`;
  return undefined;
}
