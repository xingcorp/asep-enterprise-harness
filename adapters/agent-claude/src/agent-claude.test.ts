// Claude coding provider contract suite (exit criteria E8, G1–G6).
//
// Drives the REAL ClaudeCodingProvider through its whole docker choreography,
// with two strict stand-ins on the far side of real process boundaries:
//
//   * scripts/testing/fake-docker.mjs — a `docker` client that runs each
//     container's command as a host process and records every argv, env and
//     stdin it was given. It enforces what the daemon would refuse (unknown
//     flags, unpinned images, missing bind sources, unknown networks, removing a
//     network that still has containers), but isolates nothing: the OS-enforced
//     properties are proven against the real daemon by agent-sandbox.itest.ts.
//   * scripts/testing/fake-claude-cli.mjs — the pinned CLI's flags, arity and
//     error wording, emitting the real stream-json shapes. It fails on any flag
//     the real CLI would reject.
//
// The egress proxy is the REAL asset (adapters/agent-claude/assets), run by the
// fake docker as a host process in front of a fake model API, so the credential
// path — stdin to the proxy, substituted per request — is exercised for real.
// A real content-addressed artifact store (PGlite + filesystem objects) receives
// the evidence, so G4 capture is checked end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ClaudeCodingProvider, FileModelCredentialProvider, AgentConfigError, MODEL_KEY_PLACEHOLDER,
  claudeToolGrant, ToolPolicyError, buildClaudeArgs, parseModelBaseUrl, ModelCredentialError,
  parseStream, MalformedEventError, redactSecrets,
  type AgentSandboxConfig, type ModelCredentialProvider,
} from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import type { ArtifactStore, AgentExecuteRequest, ToolPolicyProfile } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope, WorkspaceId, AttemptId, ArtifactRef,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:agent-claude');

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE_DOCKER = join(REPO, 'scripts', 'testing', 'fake-docker.mjs');
const FAKE_CLAUDE = join(REPO, 'scripts', 'testing', 'fake-claude-cli.mjs');
const PROXY_ASSET = join(REPO, 'adapters', 'agent-claude', 'assets', 'egress-proxy.mjs');
const AGENT_IMAGE = `asep-agent@sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `node@sha256:${'b'.repeat(64)}`;
const MODEL = 'claude-test-model';
const CLI_VERSION = '2.1.286';

const scope: TenantScope = {
  organizationId: 'A'.repeat(26) as OrganizationId,
  projectId: 'B'.repeat(26) as ProjectId,
};
const POLICY: ToolPolicyProfile = {
  allowedTools: ['read', 'write'], disallowedTools: ['bash'], networkProfile: 'restricted-egress',
};
const BUDGET = { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 1 };

// --- the fake model API -----------------------------------------------------------

interface Upstream {
  readonly url: string;
  readonly seen: { method: string; path: string; apiKey: string | undefined; authorization: string | undefined }[];
  close(): Promise<void>;
}

async function fakeModelApi(opts: { echoKey?: boolean } = {}): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const apiKey = req.headers['x-api-key'] as string | undefined;
      seen.push({
        method: req.method ?? '', path: req.url ?? '', apiKey,
        authorization: req.headers['authorization'] as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(opts.echoKey ? { type: 'message', echoed: apiKey } : { type: 'message', ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

// --- one database for the suite, one isolated harness per test ----------------------

// A single PGlite instance and object directory for the whole file (the store
// is content-addressed, so the two belong together); tenancy rows are created
// once. Dozens of PGlite instances in one process made V8 abort while freeing
// wasm code.
let shared: Promise<{ db: PgliteClient; objects: string }> | undefined;
function database(): Promise<{ db: PgliteClient; objects: string }> {
  shared ??= (async () => {
    const db = await PgliteClient.create();
    await migrate(db);
    await db.query('insert into organizations (id, name) values ($1, $2)', [scope.organizationId, 'Acme']);
    await db.query('insert into projects (id, organization_id, name, default_branch) values ($1,$2,$3,$4)',
      [scope.projectId, scope.organizationId, 'web', 'main']);
    return { db, objects: await mkdtemp(join(tmpdir(), 'claude-provider-objects-')) };
  })();
  return shared;
}
test.after(async () => {
  if (!shared) return;
  const { db, objects } = await shared;
  await db.close();
  await rm(objects, { recursive: true, force: true });
});

interface Harness {
  readonly dir: string;
  readonly state: string;
  readonly docker: string;
  readonly wt: string;
  readonly secret: string;
  readonly keyFile: string;
  readonly store: ArtifactStore;
  readonly objects: string;
  readonly upstream: Upstream;
  workRef: ArtifactRef;
  ctxRef: ArtifactRef;
  cli(scenario: string, env?: Record<string, string>): Promise<string>;
  provider(scenario: string, over?: Partial<AgentSandboxConfig>, credentials?: ModelCredentialProvider): Promise<ClaudeCodingProvider>;
  invocations(): Record<string, unknown>[];
  close(): Promise<void>;
}

async function harness(opts: { echoKey?: boolean; workOrder?: unknown } = {}): Promise<Harness> {
  // Real paths: the provider resolves the worktree with realpath(3).
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-provider-')));
  const state = join(dir, 'docker-state');
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const docker = join(bin, 'docker');
  await writeFile(docker, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" --state "${state}" "$@"\n`, { mode: 0o755 });
  const wt = join(dir, 'wt');
  await mkdir(wt, { recursive: true });
  await writeFile(join(wt, '.git'), 'gitdir: /nowhere/worktrees/wt\n');
  // Generated per run and never committed: a leak test must look for a value
  // that cannot already be sitting in the repository.
  const secret = `asep-test-model-key-${randomUUID()}`;
  const keyFile = join(dir, 'model-key');
  await writeFile(keyFile, `${secret}\n`, { mode: 0o600 });

  const { db, objects } = await database();
  const store = new ContentAddressedArtifactStore(db, new FilesystemObjectStore(objects));
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const wo = new TextEncoder().encode(JSON.stringify(opts.workOrder ?? { objective: 'add feature.txt' }));
  const cp = new TextEncoder().encode(JSON.stringify({ relevantFiles: ['feature.txt'] }));
  const upstream = await fakeModelApi(opts);

  const h: Harness = {
    dir, state, docker, wt, secret, keyFile, store, objects, upstream,
    workRef: await store.put(scope, { kind: 'work-order', content: wo, sha256: sha(wo), contentType: 'application/json' }),
    ctxRef: await store.put(scope, { kind: 'context-pack', content: cp, sha256: sha(cp), contentType: 'application/json' }),
    async cli(scenario, env = {}) {
      // A node shim (no shell, so no PWD/SHLVL) that picks the scenario inside
      // the "container" and hands over to the strict fake.
      const path = join(bin, `claude-${scenario}`);
      const vars = Object.entries({ FAKE_CLAUDE_SCENARIO: scenario, ...env })
        .map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join(' ');
      await writeFile(path, `#!${process.execPath}\n${vars} import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});\n`,
        { mode: 0o755 });
      return path;
    },
    async provider(scenario, over = {}, credentials) {
      return new ClaudeCodingProvider(
        {
          executable: await h.cli(scenario), model: MODEL, cliVersion: CLI_VERSION, maxTurns: 5,
          sandbox: {
            image: AGENT_IMAGE, proxyImage: PROXY_IMAGE, workdirFor: () => wt,
            dockerBinary: docker, inputRoot: dir, ...over,
          },
          credentials: credentials ?? new FileModelCredentialProvider({ apiKeyFile: keyFile, baseUrl: upstream.url }),
        },
        scope, store,
      );
    },
    invocations() {
      const p = join(state, 'invocations.jsonl');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    async close() {
      await upstream.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return h;
}

function request(h: Harness, over: Partial<AgentExecuteRequest> = {}): AgentExecuteRequest {
  return {
    attemptId: 'D'.repeat(26) as AttemptId,
    workOrderRef: h.workRef,
    contextPackRef: h.ctxRef,
    workspace: { workspaceId: 'W'.repeat(26) as WorkspaceId, leaseId: 'lease-1' },
    budget: BUDGET,
    toolPolicy: POLICY,
    signal: new AbortController().signal,
    ...over,
  };
}

const argvOf = (inv: Record<string, unknown>[]) =>
  inv.filter((i) => Array.isArray(i['argv'])).map((i) => i['argv'] as string[]);
const verbs = (inv: Record<string, unknown>[]) =>
  argvOf(inv).map((a) => (a[0] === 'network' ? `network ${a[1]}` : a[0]!));

// Nothing a run started may outlive it.
function assertTornDown(h: Harness): void {
  const entries = (d: string) => (existsSync(join(h.state, d)) ? readdirSync(join(h.state, d)) : []);
  assert.deepEqual(entries('containers'), [], 'no container is left running');
  assert.deepEqual(entries('networks'), [], 'no network is left behind');
  assert.deepEqual(readdirSync(h.dir).filter((f) => f.startsWith('asep-agent-inputs-')), [],
    'the per-attempt input directory is removed');
}

async function eventStream(h: Harness, refs: readonly ArtifactRef[]): Promise<string> {
  const ref = refs.find((r) => r.kind === 'claude-event-stream');
  assert.ok(ref, 'the raw event stream is recorded');
  return new TextDecoder().decode((await h.store.get(scope, ref)).content);
}

// --- the happy path ------------------------------------------------------------------

test('a contained attempt: internal network, proxy, agent, teardown — and an untrusted observation', async () => {
  const h = await harness();
  try {
    const provider = await h.provider('ok');
    assert.equal(provider.providerId, `claude:${MODEL}@cli-${CLI_VERSION}`);
    const obs = await provider.execute(request(h));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    assert.equal(obs.summary, 'did the thing');
    assert.ok(obs.providerSessionId);
    // Usage comes from the result event (cache tokens count as input) and the
    // tool calls are counted from the assistant events.
    assert.deepEqual(
      { ...obs.usage, wallClockMs: 0 },
      { inputTokens: 25, outputTokens: 7, modelCostUsd: 0.0123, toolCalls: 2, wallClockMs: 0 },
    );
    assert.equal(readFileSync(join(h.wt, 'feature.txt'), 'utf8'), 'written by the fake claude CLI\n');

    // The docker choreography, in order.
    assert.deepEqual(verbs(h.invocations()), [
      'network create', 'run', 'network connect', 'run', 'rm', 'rm', 'network rm',
    ]);
    const [create, proxy, connect, agent] = argvOf(h.invocations());
    assert.ok(create!.includes('--internal'), 'the agent network is internal: no gateway, no route out');
    const netName = create!.at(-1)!;
    assert.equal(proxy![proxy!.indexOf('--network') + 1], 'bridge', 'the proxy alone sits on the egress network');
    assert.deepEqual(connect, ['network', 'connect', netName, proxy![proxy!.indexOf('--name') + 1]]);
    assert.equal(agent![agent!.indexOf('--network') + 1], netName, 'the agent sits on the internal network only');
    for (const flag of [['--read-only'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges']]) {
      const at = agent!.indexOf(flag[0]!);
      assert.ok(at >= 0 && (flag.length === 1 || agent![at + 1] === flag[1]), `agent run has ${flag.join(' ')}`);
    }
    assert.ok(!agent!.join(' ').includes('docker.sock'), 'no docker socket is ever mounted');
    assert.ok(agent!.includes(AGENT_IMAGE) && proxy!.includes(PROXY_IMAGE), 'both images are the pinned digests');
    const mounts = agent!.flatMap((a, i) => (a === '--mount' ? [agent![i + 1]!] : []));
    assert.ok(mounts.some((m) => m.startsWith(`type=bind,src=${h.wt},`) && !m.endsWith(',readonly')),
      'the worktree is the one writable bind');
    assert.ok(mounts.includes(`type=bind,src=${h.wt}/.git,dst=${h.wt}/.git,readonly`),
      'the .git indirection is re-bound read-only');
    assert.ok(mounts.some((m) => /asep-agent-inputs-.*,readonly$/.test(m)), 'the inputs are a read-only bind');
    assert.equal(mounts.filter((m) => !m.endsWith(',readonly')).length, 1, 'exactly one writable bind');

    // G4: the raw stream, the invocation manifest; nothing was asked of the
    // model in this scenario, so the proxy logged nothing.
    assert.deepEqual(obs.eventArtifactRefs.map((r) => r.kind), ['claude-event-stream', 'claude-invocation']);
    assert.match(await eventStream(h, obs.eventArtifactRefs), /"type":"result"/);
    const manifestRef = obs.eventArtifactRefs.find((r) => r.kind === 'claude-invocation')!;
    const manifest = JSON.parse(new TextDecoder().decode((await h.store.get(scope, manifestRef)).content));
    assert.deepEqual(manifest.inputs.map((i: { sha256: string }) => i.sha256), [h.workRef.sha256, h.ctxRef.sha256],
      'the manifest records the hashes of the inputs the agent was given');
    assert.deepEqual(manifest.teardown, []);
    // G5: no harness-owned fact comes from the provider.
    for (const k of ['attemptId', 'resultSha', 'changedFiles']) {
      assert.equal((obs as unknown as Record<string, unknown>)[k], undefined);
    }
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('the CLI receives the real flags, the instruction on stdin, and only the allowlisted environment', async () => {
  const h = await harness();
  process.env['GITHUB_TOKEN'] = 'ghp_must_not_reach_the_agent';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'aws_must_not_reach_the_agent';
  try {
    const obs = await (await h.provider('echo')).execute(request(h));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    const seen = JSON.parse(obs.summary) as {
      argv: string[]; promptChannel: string; prompt: string; envKeys: string[]; env: Record<string, string>;
    };
    const inputDir = seen.argv[seen.argv.indexOf('--add-dir') + 1]!;
    assert.deepEqual(seen.argv, buildClaudeArgs({
      model: MODEL, maxTurns: 5, maxBudgetUsd: 1, grant: claudeToolGrant(POLICY), inputDir,
    }));
    assert.equal(seen.promptChannel, 'stdin', 'the instruction goes through the prompt channel, not argv');
    assert.ok(!seen.argv.some((a) => a.includes('work order')), 'no prompt text in argv');
    assert.match(seen.prompt, new RegExp(`work order is ${inputDir}/work-order\\.json \\(sha256 ${h.workRef.sha256}\\)`));
    assert.match(seen.prompt, new RegExp(`context pack is ${inputDir}/context-pack\\.json \\(sha256 ${h.ctxRef.sha256}\\)`));
    // The container environment is exactly the allowlist. PATH is the image's;
    // FAKE_CLAUDE_SCENARIO is set by the test's CLI shim inside the container,
    // and macOS adds __CF_USER_TEXT_ENCODING to every process it launches.
    const hostArtifacts = new Set(['FAKE_CLAUDE_SCENARIO', '__CF_USER_TEXT_ENCODING']);
    assert.deepEqual(seen.envKeys.filter((k) => !hostArtifacts.has(k)), [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'HOME', 'LANG', 'PATH',
    ]);
    assert.equal(seen.env['ANTHROPIC_API_KEY'], MODEL_KEY_PLACEHOLDER, 'the agent holds a placeholder, not the key');
    const agentRun = argvOf(h.invocations()).filter((a) => a[0] === 'run')[1]!;
    const proxyName = argvOf(h.invocations()).filter((a) => a[0] === 'run')[0]![
      argvOf(h.invocations()).filter((a) => a[0] === 'run')[0]!.indexOf('--name') + 1];
    assert.ok(agentRun.includes(`ANTHROPIC_BASE_URL=http://${proxyName}:8080`), 'the base URL is the proxy');
    for (const v of Object.values(seen.env)) {
      assert.doesNotMatch(v, /ghp_|aws_must|asep-test-model-key/, 'no host credential reaches the agent');
    }
  } finally {
    delete process.env['GITHUB_TOKEN'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    await h.close();
  }
});

test('the fake CLI is strict: an invented flag, stream-json without --verbose, or no prompt fail like the real CLI', async () => {
  const run = (args: string[], input = 'do it') => spawnSync(process.execPath, [FAKE_CLAUDE, ...args], {
    input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', FAKE_CLAUDE_SCENARIO: 'ok' },
  });
  const invented = run(['-p', '--verbose', '--output-format', 'stream-json', '--work-order-ref', 'x']);
  assert.equal(invented.status, 1);
  assert.equal(invented.stderr.trim(), "error: unknown option '--work-order-ref'");
  const quiet = run(['-p', '--output-format', 'stream-json']);
  assert.equal(quiet.status, 1);
  assert.match(quiet.stderr, /stream-json requires --verbose/);
  const empty = run(['-p', '--verbose', '--output-format', 'stream-json'], '');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Input must be provided either through stdin or as a prompt argument/);
  const badMode = run(['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'yolo']);
  assert.equal(badMode.status, 1);
  assert.match(badMode.stderr, /argument 'yolo' is invalid/);
});

// --- the credential ----------------------------------------------------------------

test('the model credential reaches only the proxy, on stdin — never argv, env, artifacts or the observation', async () => {
  const h = await harness();
  try {
    const obs = await (await h.provider('model-call')).execute(request(h));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    assert.equal(JSON.parse(obs.summary).status, 200, 'the agent reached the model API through the proxy');
    // The upstream saw the real key, and nothing else the agent could set.
    assert.equal(h.upstream.seen.length, 1);
    assert.equal(h.upstream.seen[0]!.apiKey, h.secret, 'the proxy substituted the real key');
    assert.equal(h.upstream.seen[0]!.authorization, undefined);

    const inv = h.invocations();
    const blob = JSON.stringify(inv.filter((i) => Array.isArray(i['argv'])));
    assert.ok(!blob.includes(h.secret), 'no docker argv or docker client env carries the key');
    const proxyStdin = inv.find((i) => typeof i['container'] === 'string' && String(i['container']).startsWith('asep-egress-'));
    assert.equal(proxyStdin?.['stdinSha256'], createHash('sha256').update(`${h.secret}\n`).digest('hex'),
      'the key went to the proxy on stdin');
    const agentStdin = inv.find((i) => typeof i['container'] === 'string' && String(i['container']).startsWith('asep-agent-'));
    assert.notEqual(agentStdin?.['stdinSha256'], proxyStdin?.['stdinSha256']);

    // Every byte any attempt in this suite persisted, and the observation itself.
    const files = readdirSync(h.objects, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.ok(files.length >= 3);
    for (const f of files) {
      assert.ok(!readFileSync(join(f.parentPath, f.name), 'utf8').includes(h.secret), `${f.name} holds no key`);
    }
    assert.ok(!JSON.stringify(obs).includes(h.secret));
    // The proxy's access log is evidence too: method, path, status — no headers.
    const egressRef = obs.eventArtifactRefs.find((r) => r.kind === 'claude-egress-log');
    assert.ok(egressRef, 'the egress access log is recorded');
    const egress = new TextDecoder().decode((await h.store.get(scope, egressRef)).content);
    assert.match(egress, /POST \/v1\/messages -> 200/);
    assert.doesNotMatch(egress, /x-api-key|anthropic-version/i);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('credential material in the provider output is redacted and fails the attempt closed', async () => {
  const h = await harness({ echoKey: true });
  try {
    const obs = await (await h.provider('model-call')).execute(request(h));
    assert.equal(obs.status, 'FAILED');
    assert.match(obs.knownLimitations.join(' '), /model credential appeared in the event stream and was redacted/);
    const stream = await eventStream(h, obs.eventArtifactRefs);
    assert.ok(!stream.includes(h.secret), 'the stored stream is redacted');
    assert.match(stream, /REDACTED-MODEL-CREDENTIAL/);
    assert.ok(!JSON.stringify(obs).includes(h.secret));
  } finally {
    await h.close();
  }
});

test('an unusable credential fails closed before any container starts', async () => {
  const h = await harness();
  try {
    await chmod(h.keyFile, 0o644);
    const loose = await (await h.provider('ok')).execute(request(h));
    assert.equal(loose.status, 'FAILED');
    assert.match(loose.knownLimitations.join(' '), /accessible to group\/other/);
    assert.deepEqual(h.invocations(), [], 'docker was never asked to do anything');

    const empty: ModelCredentialProvider = { credentialFor: async () => ({ apiKey: '  ', baseUrl: h.upstream.url }) };
    const none = await (await h.provider('ok', {}, empty)).execute(request(h));
    assert.equal(none.status, 'FAILED');
    assert.match(none.knownLimitations.join(' '), /no usable key/);
    const badUrl: ModelCredentialProvider = { credentialFor: async () => ({ apiKey: 'k', baseUrl: 'file:///etc' }) };
    assert.equal((await (await h.provider('ok', {}, badUrl)).execute(request(h))).status, 'FAILED');
    assert.deepEqual(h.invocations(), []);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('model base URLs are validated, and the file provider never echoes the key', async () => {
  assert.equal(parseModelBaseUrl('https://api.anthropic.com/'), 'https://api.anthropic.com');
  assert.equal(parseModelBaseUrl('http://gateway.internal:8080/anthropic'), 'http://gateway.internal:8080/anthropic');
  for (const bad of ['ftp://x', 'https://user:pw@x', 'https://x/?q=1', 'https://x/#f', 'not a url']) {
    assert.throws(() => parseModelBaseUrl(bad), ModelCredentialError, bad);
  }
  const dir = await mkdtemp(join(tmpdir(), 'claude-cred-'));
  try {
    const key = join(dir, 'k');
    await writeFile(key, 'two words\n', { mode: 0o600 });
    await assert.rejects(new FileModelCredentialProvider({ apiKeyFile: key }).credentialFor(), (e: Error) =>
      e instanceof ModelCredentialError && !e.message.includes('two words'));
    await assert.rejects(new FileModelCredentialProvider({ apiKeyFile: join(dir, 'missing') }).credentialFor(),
      ModelCredentialError);
    assert.deepEqual(redactSecrets('a SECRET b SECRET', ['SECRET']),
      { text: 'a [REDACTED-MODEL-CREDENTIAL] b [REDACTED-MODEL-CREDENTIAL]', redacted: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the egress proxy ------------------------------------------------------------------

async function startProxy(upstream: string, key: string): Promise<{ port: number; log: () => string; stop: () => void }> {
  const child = spawn(process.execPath, [PROXY_ASSET, '--listen', '127.0.0.1:0', '--upstream', upstream], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d: Buffer) => { log += d.toString('utf8'); });
  child.stdin.end(`${key}\n`);
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const m = /listening (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('close', (code) => reject(new Error(`proxy exited ${code}: ${log}`)));
  });
  return { port, log: () => log, stop: () => child.kill('SIGKILL') };
}

function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(text));
    let out = '';
    s.on('data', (d) => { out += d.toString('utf8'); });
    s.on('close', () => resolve(out.split('\r\n')[0] ?? ''));
  });
}

test('the egress proxy forwards only the model API, swaps in the key, and refuses everything else', async () => {
  const up = await fakeModelApi();
  const key = `asep-test-model-key-${randomUUID()}`;
  const proxy = await startProxy(up.url, key);
  try {
    const call = (method: string, path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: proxy.port, method, path, headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.end(method === 'POST' ? '{}' : undefined);
      });
    assert.equal(await call('POST', '/v1/messages?beta=true', { 'x-api-key': 'agent-supplied', authorization: 'Bearer agent' }), 200);
    assert.equal(await call('POST', '/v1/messages/count_tokens'), 200);
    assert.equal(up.seen.length, 2);
    assert.ok(up.seen.every((s) => s.apiKey === key && s.authorization === undefined),
      'the agent-supplied credentials are replaced, never forwarded');
    assert.equal(up.seen[0]!.path, '/v1/messages?beta=true');

    assert.equal(await call('GET', '/v1/models'), 403, 'an unlisted path is refused');
    assert.equal(await call('GET', '/v1/messages'), 403, 'an unlisted method is refused');
    assert.equal(await call('HEAD', '/api/hello'), 403);
    assert.match(await raw(proxy.port, 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
      / 403 /, 'absolute-form (forward proxying) is refused');
    // Absolute-form even for an allowlisted path: the proxy is never a forward
    // proxy, whatever host the request names.
    assert.match(await raw(proxy.port,
      'POST http://evil.example/v1/messages HTTP/1.1\r\nHost: evil.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'),
    / 403 /, 'an absolute-form request for an allowlisted path is refused too');
    assert.match(await raw(proxy.port, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'),
      / 403 /, 'CONNECT tunnels are refused');
    assert.equal(up.seen.length, 2, 'nothing refused reached the upstream');
    const log = proxy.log();
    assert.ok(!log.includes(key) && !log.includes('agent-supplied'), 'the access log carries no credential');
    assert.match(log, /POST \/v1\/messages -> 200/);
    assert.match(log, /GET \/v1\/models -> 403/);
  } finally {
    proxy.stop();
    await up.close();
  }
});

test('the egress proxy refuses to start without a credential', async () => {
  const child = spawnSync(process.execPath, [PROXY_ASSET, '--listen', '127.0.0.1:0', '--upstream', 'http://127.0.0.1:9'], {
    input: '\n', encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /no credential on stdin/);
});

// --- fail-closed outcomes (G2, G3, G6) ---------------------------------------------------

const failClosed: readonly { scenario: string; status: string; match: RegExp }[] = [
  { scenario: 'malformed', status: 'FAILED', match: /malformed.*unknown event type 'bogus'/ },
  { scenario: 'notjson', status: 'FAILED', match: /malformed.*not valid JSON/ },
  { scenario: 'partial', status: 'FAILED', match: /no result event/ },
  { scenario: 'truncated', status: 'FAILED', match: /truncated final line/ },
  { scenario: 'nonzero', status: 'FAILED', match: /exited 1: API Error: 401/ },
  { scenario: 'quota', status: 'FAILED', match: /is_error: API Error: 429.*rate_limit_error/ },
  { scenario: 'max-turns', status: 'BUDGET_EXHAUSTED', match: /error_max_turns/ },
  { scenario: 'max-budget', status: 'BUDGET_EXHAUSTED', match: /error_max_budget_usd/ },
  { scenario: 'costly', status: 'BUDGET_EXHAUSTED', match: /cost 5 USD over the budget of 1 USD/ },
  { scenario: 'version-drift', status: 'FAILED', match: /version 9\.9\.9, not the pinned 2\.1\.286/ },
  { scenario: 'model-fallback', status: 'FAILED', match: /fell back from the pinned model/ },
  { scenario: 'extra-tool', status: 'FAILED', match: /tools that were not granted: Bash/ },
  { scenario: 'mcp', status: 'FAILED', match: /MCP servers: smuggled/ },
  { scenario: 'wrong-cwd', status: 'FAILED', match: /not the leased worktree/ },
  { scenario: 'after-result', status: 'FAILED', match: /event after the result event/ },
  { scenario: 'session-mismatch', status: 'FAILED', match: /session 'someone-else'/ },
];

for (const c of failClosed) {
  test(`fail closed: ${c.scenario} → ${c.status}, evidence kept, everything torn down`, async () => {
    const h = await harness();
    try {
      const started = Date.now();
      const obs = await (await h.provider(c.scenario)).execute(request(h));
      assert.equal(obs.status, c.status, obs.knownLimitations.join('; '));
      assert.match(obs.knownLimitations.join(' '), c.match);
      // A violation stops the agent at once; nothing waits for the hang.
      assert.ok(Date.now() - started < 15_000, `returned after ${Date.now() - started}ms`);
      if (c.scenario !== 'nonzero') await eventStream(h, obs.eventArtifactRefs);
      assertTornDown(h);
    } finally {
      await h.close();
    }
  });
}

test('G6: a permission denial is reported, an API retry is noted, an agent claiming a commit injects nothing', async () => {
  const h = await harness();
  try {
    const denied = await (await h.provider('denied')).execute(request(h));
    assert.equal(denied.status, 'AGENT_DONE');
    assert.ok(denied.knownLimitations.includes('permission denied: Bash'));
    const notices = await (await h.provider('notices')).execute(request(h));
    assert.equal(notices.status, 'AGENT_DONE', notices.knownLimitations.join('; '));
    assert.ok(notices.knownLimitations.includes('model API retried 1 time(s)'));
    const claims = await (await h.provider('claims-commit')).execute(request(h));
    assert.equal(claims.status, 'AGENT_DONE');
    assert.equal(claims.summary, 'I committed abcdef and pushed to main', 'kept only as advisory text');
    for (const k of ['attemptId', 'resultSha', 'changedFiles']) {
      assert.equal((claims as unknown as Record<string, unknown>)[k], undefined);
    }
  } finally {
    await h.close();
  }
});

test('G3: the tool-call budget is enforced while the agent runs', async () => {
  const h = await harness();
  try {
    const started = Date.now();
    const obs = await (await h.provider('tool-flood')).execute(
      request(h, { budget: { ...BUDGET, maxToolCalls: 3 } }),
    );
    assert.equal(obs.status, 'BUDGET_EXHAUSTED');
    assert.match(obs.knownLimitations.join(' '), /tool-call budget of 3 exceeded/);
    assert.equal(obs.usage.toolCalls, 4, 'stopped at the first call over the budget');
    assert.ok(Date.now() - started < 15_000);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('G3: a hung agent is removed by the wall-clock budget, with no external abort', async () => {
  const h = await harness();
  try {
    const started = Date.now();
    const obs = await (await h.provider('hang')).execute(
      request(h, { budget: { ...BUDGET, maxWallClockMinutes: 0.03 } }),
    );
    assert.equal(obs.status, 'BUDGET_EXHAUSTED');
    assert.match(obs.knownLimitations.join(' '), /wall-clock/);
    assert.ok(Date.now() - started < 15_000);
    assert.ok(argvOf(h.invocations()).some((a) => a[0] === 'rm' && a[2]!.startsWith('asep-agent-')),
      'the container itself is removed, not just its client');
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('G3: cancellation stops a running agent promptly; an already-aborted signal starts nothing', async () => {
  const h = await harness();
  try {
    const ac = new AbortController();
    const started = Date.now();
    const p = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 1500);
    const obs = await p;
    assert.equal(obs.status, 'BLOCKED');
    assert.match(obs.knownLimitations.join(' '), /cancelled during execution/);
    assert.ok(Date.now() - started < 15_000);
    assertTornDown(h);

    const before = h.invocations().length;
    const pre = new AbortController();
    pre.abort();
    const blocked = await (await h.provider('hang')).execute(request(h, { signal: pre.signal }));
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(h.invocations().length, before, 'nothing was started');
  } finally {
    await h.close();
  }
});

test('G5: concurrent attempts through one provider stay apart', async () => {
  const h = await harness();
  try {
    const wtA = join(h.dir, 'wt-a');
    const wtB = join(h.dir, 'wt-b');
    await mkdir(wtA);
    await mkdir(wtB);
    const wsA = `WA${'a'.repeat(24)}` as WorkspaceId;
    const wsB = `WB${'b'.repeat(24)}` as WorkspaceId;
    const provider = await h.provider('tagged', { workdirFor: (ws) => (ws === wsA ? wtA : wtB) });
    const [a, b] = await Promise.all([
      provider.execute(request(h, { workspace: { workspaceId: wsA, leaseId: 'lease-A' } })),
      provider.execute(request(h, { workspace: { workspaceId: wsB, leaseId: 'lease-B' } })),
    ]);
    assert.equal(a.summary, 'tag=wt-a');
    assert.equal(b.summary, 'tag=wt-b');
    assert.equal(a.providerSessionId, 'sess-wt-a');
    assert.equal(b.providerSessionId, 'sess-wt-b');
    const nets = argvOf(h.invocations()).filter((x) => x[0] === 'network' && x[1] === 'create');
    assert.equal(new Set(nets.map((n) => n.at(-1))).size, 2, 'each attempt has its own network');
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

// --- what is refused before anything starts --------------------------------------------------

test('a tool policy outside the vocabulary, or one the agent cannot run under, is refused before docker', async () => {
  const h = await harness();
  try {
    for (const toolPolicy of [
      { ...POLICY, allowedTools: ['read', 'edit_file'] },
      { ...POLICY, disallowedTools: ['run_command'] },
      { ...POLICY, allowedTools: ['read', 'network'] },
      { ...POLICY, networkProfile: 'no-network' as const },
    ]) {
      const obs = await (await h.provider('ok')).execute(request(h, { toolPolicy }));
      assert.equal(obs.status, 'BLOCKED', JSON.stringify(toolPolicy));
      assert.match(obs.knownLimitations.join(' '), /tool policy refused/);
    }
    assert.deepEqual(h.invocations(), []);
  } finally {
    await h.close();
  }
});

test('the tool grant: a closed vocabulary, denial wins, network tools always denied', () => {
  assert.deepEqual(claudeToolGrant(POLICY), {
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    disallowed: ['Bash', 'WebFetch', 'WebSearch'],
  });
  assert.deepEqual(claudeToolGrant({ ...POLICY, allowedTools: ['read', 'bash'], disallowedTools: ['bash'] }), {
    tools: ['Read', 'Glob', 'Grep'],
    disallowed: ['Bash', 'WebFetch', 'WebSearch'],
  });
  assert.throws(() => claudeToolGrant({ ...POLICY, allowedTools: ['Read'] }), ToolPolicyError);
  assert.throws(() => claudeToolGrant({ ...POLICY, allowedTools: ['__proto__'] }), ToolPolicyError);
});

test('inputs whose bytes do not match their refs are never mounted', async () => {
  const h = await harness();
  try {
    const tampered: ArtifactStore = {
      ...h.store,
      put: (s, i) => h.store.put(s, i),
      get: async (s, ref) => {
        const got = await h.store.get(s, ref);
        return ref.kind === 'work-order' ? { ...got, content: new TextEncoder().encode('{"objective":"rm -rf"}') } : got;
      },
    } as ArtifactStore;
    const provider = new ClaudeCodingProvider(
      {
        executable: await h.cli('ok'), model: MODEL, cliVersion: CLI_VERSION, maxTurns: 5,
        sandbox: { image: AGENT_IMAGE, proxyImage: PROXY_IMAGE, workdirFor: () => h.wt, dockerBinary: h.docker, inputRoot: h.dir },
        credentials: new FileModelCredentialProvider({ apiKeyFile: h.keyFile, baseUrl: h.upstream.url }),
      },
      scope, tampered,
    );
    const obs = await provider.execute(request(h));
    assert.equal(obs.status, 'FAILED');
    assert.match(obs.knownLimitations.join(' '), new RegExp(`hashes to [0-9a-f]{64}, not the referenced ${h.workRef.sha256}`));
    assert.deepEqual(h.invocations(), []);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('docker trouble fails closed and still tears down what was started', async () => {
  const h = await harness();
  try {
    const noDocker = await (await h.provider('ok', { dockerBinary: join(h.dir, 'no-such-docker') })).execute(request(h));
    assert.equal(noDocker.status, 'FAILED');
    assert.match(noDocker.knownLimitations.join(' '), /docker network create failed/);

    const noEgress = await (await h.provider('ok', { egressNetwork: 'no-such-network' })).execute(request(h));
    assert.equal(noEgress.status, 'FAILED');
    assert.match(noEgress.knownLimitations.join(' '), /egress proxy exited 125 before it was ready/);
    assertTornDown(h);

    const noWorktree = await (await h.provider('ok', { workdirFor: () => join(h.dir, 'missing') })).execute(request(h));
    assert.equal(noWorktree.status, 'FAILED');
    assert.match(noWorktree.knownLimitations.join(' '), /leased worktree unavailable/);
  } finally {
    await h.close();
  }
});

test('E8/G1: the provider cannot be built without a pinned sandbox and a credential provider', async () => {
  const h = await harness();
  try {
    const credentials = new FileModelCredentialProvider({ apiKeyFile: h.keyFile });
    const sandbox: AgentSandboxConfig = { image: AGENT_IMAGE, proxyImage: PROXY_IMAGE, workdirFor: () => h.wt };
    const base = { executable: '/usr/local/bin/claude', model: MODEL, cliVersion: CLI_VERSION, maxTurns: 5 };
    assert.ok(new ClaudeCodingProvider({ ...base, sandbox, credentials }, scope, h.store));
    const bad: unknown[] = [
      { ...base, credentials },
      { ...base, sandbox },
      { ...base, credentials, sandbox: { ...sandbox, image: 'claude-agent:latest' } },
      { ...base, credentials, sandbox: { ...sandbox, proxyImage: 'node:24' } },
      { ...base, credentials, sandbox: { ...sandbox, toolMounts: ['relative/path'] } },
      { ...base, model: '', sandbox, credentials },
      { ...base, maxTurns: 0, sandbox, credentials },
    ];
    for (const cfg of bad) {
      assert.throws(() => new ClaudeCodingProvider(cfg as never, scope, h.store), AgentConfigError, JSON.stringify(cfg));
    }
  } finally {
    await h.close();
  }
});

// --- the parser on its own (G2) -------------------------------------------------------------

test('G2: the stream parser accepts the real shapes and rejects everything else', async () => {
  const init = JSON.stringify({
    type: 'system', subtype: 'init', cwd: '/w', session_id: 's', tools: ['Read'], mcp_servers: [],
    model: 'm', permissionMode: 'acceptEdits', claude_code_version: '2.1.286',
  });
  const res = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 3, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], result: 'ok', session_id: 's',
  });
  const parsed = parseStream(`${init}\n${res}\n`);
  assert.equal(parsed.sessionId, 's');
  assert.equal(parsed.result.text, 'ok');
  for (const [bad, why] of [
    [`${res}\n`, /does not start with system\/init/],
    [`${init}\n${init}\n${res}\n`, /more than one init/],
    [`${init}\n${res}\n${res}\n`, /event after the result/],
    [`${init}\n${res}`, /truncated final line/],
    [`${init}\n`, /no result event/],
    [`${init}\n${JSON.stringify({ type: 'stream_event', session_id: 's' })}\n${res}\n`, /unknown event type 'stream_event'/],
    [`${init}\n${JSON.stringify({ type: 'assistant', session_id: 's', message: { content: [{ type: 'image' }] } })}\n${res}\n`,
      /unknown assistant content block 'image'/],
    [`${init}\n${res.replace('"success"', '"done"')}\n`, /unknown result subtype 'done'/],
    [`${init}\n${res.replace('"total_cost_usd":0', '"total_cost_usd":"0"')}\n`, /total_cost_usd/],
  ] as const) {
    assert.throws(() => parseStream(bad), (e: Error) => e instanceof MalformedEventError && why.test(e.message), String(why));
  }
});

// The input directory is made read-only on the host as well.
test('the per-attempt inputs are written read-only', async () => {
  const h = await harness();
  try {
    const modes: string[] = [];
    const watching: ModelCredentialProvider = {
      credentialFor: async () => {
        const dirs = readdirSync(h.dir).filter((f) => f.startsWith('asep-agent-inputs-'));
        for (const d of dirs) {
          for (const f of readdirSync(join(h.dir, d))) {
            modes.push(`${f}:${(statSync(join(h.dir, d, f)).mode & 0o777).toString(8)}`);
          }
        }
        return { apiKey: h.secret, baseUrl: h.upstream.url };
      },
    };
    const obs = await (await h.provider('ok', {}, watching)).execute(request(h));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    assert.deepEqual(modes.sort(), ['context-pack.json:444', 'work-order.json:444']);
    assert.equal(await readFile(join(h.wt, 'feature.txt'), 'utf8'), 'written by the fake claude CLI\n');
  } finally {
    await h.close();
  }
});
