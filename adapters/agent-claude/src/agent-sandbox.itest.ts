// AUTHORITATIVE containment proof for the Claude provider, against the REAL
// Docker daemon (exit criteria E4, E8, F4/F5, G3, G5). Runs only under the
// integration gate, which guarantees docker; it fails closed — never skips —
// when docker is unavailable.
//
// The real ClaudeCodingProvider runs a canary agent (the strict fake CLI in
// its `canary` scenario) inside the digest-pinned node image, exactly as it
// would run the real CLI. A fake model API runs in its own container on an
// INTERNAL upstream network, so the proxy's upstream is hermetic: the test
// never needs the internet, and only a containment failure could reach it.
//
// What the canary proves from INSIDE the agent container:
//   * no route out: a direct TCP connection to a public address fails, a
//     direct connection to the model API's own address fails, DNS for a public
//     name fails, through the embedded resolver or asked of a public one;
//   * no way to the host: a service listening on the wildcard address of the
//     daemon's host network namespace, and the gate's PostgreSQL and MinIO
//     ports, are unreachable at the would-be bridge gateway, the default
//     bridge's gateway, Docker Desktop's host address and host.docker.internal
//     — while a container on a plain `--internal` network DOES reach that
//     service through its gateway, so the refusal is the isolation, not a
//     probe that cannot connect;
//   * no IPv6: the container holds no IPv6 address but loopback, and a public
//     IPv6 address is unreachable;
//   * the proxy is not a general proxy: absolute-form and CONNECT requests and
//     an unlisted API path are refused 403;
//   * the model API IS reachable through the proxy, and the upstream sees the
//     real key while the agent only ever held the placeholder;
//   * only the worktree is writable: the `.git` indirection, the inputs and the
//     root filesystem refuse writes and chmod with EROFS, and the mirror the
//     indirection names is not visible at all;
//   * the inputs it reads hash to what the prompt says.
// And from outside: no secret in any docker argv or client environment, in any
// stored artifact, or in the observation; nothing left running; the host
// mirror byte-identical.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ClaudeCodingProvider, FileModelCredentialProvider, MODEL_KEY_PLACEHOLDER,
} from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import type { AgentExecuteRequest } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope, WorkspaceId, AttemptId, ArtifactRef,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:agent-sandbox');

// node:20-alpine, digest-pinned (IMAGES.node in scripts/integration/images.mjs).
// It is both the agent image (it runs the fake CLI) and the proxy image (it runs
// the proxy).
const NODE = 'node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TESTING = join(REPO, 'scripts', 'testing');
const MODEL = 'claude-test-model';
const CLI_VERSION = '2.1.286';

const scope: TenantScope = {
  organizationId: 'A'.repeat(26) as OrganizationId,
  projectId: 'B'.repeat(26) as ProjectId,
};

function docker(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function mustDocker(args: readonly string[]): Promise<string> {
  const r = await docker(args);
  assert.equal(r.code, 0, `docker ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function treeDigest(root: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      h.update(p.slice(root.length));
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) h.update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest('hex');
}

interface World {
  readonly dir: string;
  readonly wt: string;
  readonly mirror: string;
  readonly upstreamNet: string;
  readonly modelName: string;
  readonly modelIp: string;
  readonly modelLog: string;
  readonly dockerLog: string;
  readonly dockerWrapper: string;
  readonly shimDir: string;
  readonly secret: string;
  readonly keyFile: string;
  runClientPid(role: 'agent' | 'egress-proxy'): number;
  shim(scenario: string): Promise<string>;
  teardown(): Promise<void>;
}

async function world(): Promise<World> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-sbx-')));
  const id = randomUUID().slice(0, 8);

  // A real bare mirror and a linked worktree, as the workspace manager makes.
  const mirror = join(dir, 'mirror.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'seed']);
  execFileSync('git', ['clone', '-q', '--bare', seed, mirror]);
  const wt = join(dir, 'wt');
  execFileSync('git', ['--git-dir', mirror, 'worktree', 'add', '-q', '--detach', wt, 'main']);

  // The fake model API, alone on an INTERNAL network: hermetic either way.
  const upstreamNet = `asep-itest-upstream-${id}`;
  const modelName = `asep-itest-model-${id}`;
  const logs = join(dir, 'model-log');
  await mkdir(logs);
  const modelLog = join(logs, 'requests.jsonl');
  await mustDocker(['network', 'create', '--internal', upstreamNet]);
  const uid = `${process.getuid!()}:${process.getgid!()}`;
  await mustDocker([
    'run', '-d', '--rm', '--name', modelName, '--network', upstreamNet, '--user', uid,
    '--mount', `type=bind,src=${TESTING},dst=${TESTING},readonly`,
    '--mount', `type=bind,src=${logs},dst=${logs}`,
    NODE, 'node', join(TESTING, 'fake-model-api.mjs'), '--listen', '0.0.0.0:8080', '--log', modelLog,
  ]);
  for (let i = 0; i < 100 && !(existsSync(modelLog) && readFileSync(modelLog, 'utf8').includes('listening')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(readFileSync(modelLog, 'utf8').includes('listening'), 'the fake model API came up');
  const modelIp = await mustDocker([
    'inspect', '-f', `{{(index .NetworkSettings.Networks "${upstreamNet}").IPAddress}}`, modelName,
  ]);

  // Every docker invocation the provider makes is logged — argv and client
  // environment — then handed to the real client with exec (signals intact).
  const dockerLog = join(dir, 'docker-invocations.log');
  const dockerWrapper = join(dir, 'docker');
  const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  await writeFile(dockerWrapper, [
    '#!/bin/sh',
    `{ printf 'ARGV'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; env | sed 's/^/ENV /'; } >> '${dockerLog}'`,
    `echo "$$ $*" >> '${join(dir, 'client-pids')}'`,
    `exec '${realDocker}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  const shimDir = join(dir, 'cli');
  await mkdir(shimDir);
  const secret = `asep-test-model-key-${randomUUID()}`;
  const keyFile = join(dir, 'model-key');
  await writeFile(keyFile, `${secret}\n`, { mode: 0o600 });

  return {
    dir, wt, mirror, upstreamNet, modelName, modelIp, modelLog, dockerLog, dockerWrapper, shimDir, secret, keyFile,
    runClientPid(role) {
      const line = readFileSync(join(dir, 'client-pids'), 'utf8').split('\n')
        .find((l) => l.split(' ')[1] === 'run' && l.includes(`asep.role=${role}`));
      assert.ok(line, `a ${role} client was started`);
      return Number(line.split(' ')[0]);
    },
    async shim(scenario) {
      const path = join(shimDir, `claude-${scenario}`);
      await writeFile(path, [
        '#!/usr/bin/env node',
        `process.env.FAKE_CLAUDE_SCENARIO = ${JSON.stringify(scenario)};`,
        `import(${JSON.stringify(pathToFileURL(join(TESTING, 'fake-claude-cli.mjs')).href)});`,
        '',
      ].join('\n'), { mode: 0o755 });
      return path;
    },
    async teardown() {
      await docker(['rm', '-f', modelName]);
      await docker(['network', 'rm', upstreamNet]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function store(dir: string) {
  const db = await PgliteClient.create();
  await migrate(db);
  await db.query('insert into organizations (id, name) values ($1, $2)', [scope.organizationId, 'Acme']);
  await db.query('insert into projects (id, organization_id, name, default_branch) values ($1,$2,$3,$4)',
    [scope.projectId, scope.organizationId, 'web', 'main']);
  await db.query(`insert into repository_bindings
    (id, organization_id, project_id, forge, github_host, github_owner, github_repo, default_base_branch)
    values ($1, $2, $3, 'github', 'github.com', 'acme', 'web', 'main')`, [BINDING, scope.organizationId, scope.projectId]);
  return { db, store: new ContentAddressedArtifactStore(db, new FilesystemObjectStore(join(dir, 'objects'))) };
}

const BINDING = 'E'.repeat(26);

// The attempt a request names, so the artifacts the provider links to it have
// a row to reference.
async function seedAttempt(db: PgliteClient, attemptId: string): Promise<void> {
  const run = `R${attemptId.slice(1)}`;
  const task = `T${attemptId.slice(1)}`;
  await db.query(`insert into runs (id, organization_id, project_id, repository_binding_id, status, risk)
    values ($1, $2, $3, $4, 'EXECUTING', 'R0')`, [run, scope.organizationId, scope.projectId, BINDING]);
  await db.query(`insert into tasks (id, organization_id, project_id, run_id, repository_binding_id, status, risk)
    values ($1, $2, $3, $4, $5, 'EXECUTING', 'R0')`, [task, scope.organizationId, scope.projectId, run, BINDING]);
  await db.query(`insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status)
    values ($1, $2, $3, $4, $5, 'AGENT_RUNNING')`, [attemptId, scope.organizationId, scope.projectId, task, BINDING]);
}

async function put(s: ContentAddressedArtifactStore, kind: string, value: unknown): Promise<ArtifactRef> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return s.put(scope, {
    kind, content: bytes, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'application/json',
  });
}

async function provider(w: World, s: ContentAddressedArtifactStore, scenario: string): Promise<ClaudeCodingProvider> {
  return new ClaudeCodingProvider(
    {
      executable: await w.shim(scenario), model: MODEL, cliVersion: CLI_VERSION, maxTurns: 5,
      sandbox: {
        image: NODE, proxyImage: NODE, workdirFor: () => w.wt, inputRoot: w.dir,
        egressNetwork: w.upstreamNet, toolMounts: [w.shimDir, TESTING], dockerBinary: w.dockerWrapper,
      },
      credentials: new FileModelCredentialProvider({
        apiKeyFile: w.keyFile, baseUrl: `http://${w.modelName}:8080`,
      }),
    },
    scope, s,
  );
}

function request(workOrderRef: ArtifactRef, contextPackRef: ArtifactRef, over: Partial<AgentExecuteRequest> = {}): AgentExecuteRequest {
  return {
    attemptId: `D${randomUUID().replace(/-/g, '').slice(0, 25).toUpperCase()}` as AttemptId,
    workOrderRef, contextPackRef,
    workspace: { workspaceId: 'W'.repeat(26) as WorkspaceId, leaseId: 'lease-1' },
    budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 2 },
    toolPolicy: { allowedTools: ['read', 'write'], disallowedTools: ['bash'], networkProfile: 'restricted-egress' },
    signal: new AbortController().signal,
    ...over,
  };
}

// A service on the wildcard address of the daemon's host network namespace —
// the host itself on a native daemon, the VM on Docker Desktop: what a bridge
// address on the host would expose to a container.
async function hostService(): Promise<{ port: number; stop(): Promise<void> }> {
  const name = `asep-itest-hostsvc-${randomUUID().slice(0, 8)}`;
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  await mustDocker([
    'run', '-d', '--rm', '--name', name, '--network', 'host', NODE, 'node', '-e',
    // A client that drops the connection must not take the service down.
    `require('net').createServer((s) => { s.on('error', () => {}); s.end('host\\n'); })` +
      `.listen(${port}, '0.0.0.0', () => console.log('listening'))`,
  ]);
  for (let i = 0; i < 100; i++) {
    if ((await docker(['logs', name])).stdout.includes('listening')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match((await docker(['logs', name])).stdout, /listening/, 'the host service came up');
  return { port, stop: async () => { await docker(['rm', '-f', name]); } };
}

// Whether a container on a network made with `flags` reaches the host service
// through that network's gateway.
async function reachesHostThroughGateway(flags: readonly string[], port: number): Promise<string> {
  const net = `asep-itest-ctl-${randomUUID().slice(0, 8)}`;
  await mustDocker(['network', 'create', ...flags, net]);
  try {
    const shown = JSON.parse(await mustDocker(['network', 'inspect', '--format', '{{json .}}', net]));
    const gateway = (shown.IPAM?.Config ?? []).map((c: { Gateway?: string }) => c.Gateway).find(Boolean);
    if (!gateway) return 'no-gateway';
    const r = await docker(['run', '--rm', '--network', net, NODE, 'node', '-e',
      `const s = require('net').connect(${port}, '${gateway}'); s.setTimeout(3000, () => { console.log('timeout'); process.exit(); });` +
      ` s.on('connect', () => { console.log('connected'); process.exit(); }); s.on('error', (e) => { console.log('error:' + e.code); process.exit(); });`]);
    return r.stdout.trim();
  } finally {
    await docker(['network', 'rm', net]);
  }
}

function portOf(url: string | undefined): number[] {
  if (!url) return [];
  const p = Number(new URL(url).port);
  return Number.isInteger(p) && p > 0 ? [p] : [];
}

async function leftovers(attemptId: string): Promise<string> {
  const c = await mustDocker(['ps', '-aq', '--filter', `label=asep.attempt=${attemptId}`]);
  const n = await mustDocker(['network', 'ls', '-q', '--filter', `label=asep.attempt=${attemptId}`]);
  return `${c}${n}`;
}

test('preflight: docker is reachable (fail closed, never skip)', async () => {
  const r = await docker(['version', '--format', '{{.Server.Version}}']);
  assert.equal(r.code, 0, `the integration gate must provide a working docker: ${r.stderr}`);
  if ((await docker(['image', 'inspect', NODE])).code !== 0) await mustDocker(['pull', NODE]);
});

test('the agent container has no route out, reaches the model only through the proxy, and can write only the worktree', async () => {
  const w = await world();
  const { db, store: s } = await store(w.dir);
  const host = await hostService();
  process.env['GITHUB_TOKEN'] = 'ghp_must_not_reach_the_agent';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'aws_must_not_reach_the_agent';
  try {
    // The control: a plain internal network leaves the host an address on its
    // bridge, and the host service answers there.
    assert.equal(await reachesHostThroughGateway(['--internal'], host.port), 'connected',
      'a plain internal network reaches the host service through its gateway');
    const hostPorts = [host.port, ...portOf(process.env['ASEP_PG_URL']), ...portOf(process.env['ASEP_S3_ENDPOINT'])];
    const mirrorBefore = treeDigest(w.mirror);
    const workOrderRef = await put(s, 'work-order', {
      objective: 'canary',
      canary: {
        upstreamIp: w.modelIp, upstreamPort: 8080,
        hostAddresses: ['172.17.0.1', '192.168.65.254', 'host.docker.internal'],
        hostPorts,
      },
    });
    const contextPackRef = await put(s, 'context-pack', { relevantFiles: [] });
    const req = request(workOrderRef, contextPackRef);
    await seedAttempt(db, req.attemptId);
    const obs = await (await provider(w, s, 'canary')).execute(req);
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    const r = JSON.parse(obs.summary) as Record<string, any>;
    // Kept in the gate's log as evidence of what the canary observed.
    console.log('canary report:', JSON.stringify({ ...r, env: Object.keys(r['env'] ?? {}).sort() }));

    // No route out.
    assert.notEqual(r['direct'], 'connected', `direct egress must fail: ${r['direct']}`);
    assert.notEqual(r['upstreamDirect'], 'connected', `the model API is reachable only through the proxy: ${r['upstreamDirect']}`);
    assert.match(r['dns'], /^error:/, `public DNS must fail: ${r['dns']}`);
    assert.match(r['dnsDirect'], /^error:/, `a public resolver must be unreachable: ${r['dnsDirect']}`);
    // No way to the host or its services, on any address it could hold.
    const reach = r['hostReach'] as Record<string, string>;
    assert.ok(r['gateway'], 'the canary computed the would-be gateway');
    for (const port of hostPorts) {
      assert.ok(`${r['gateway']}:${port}` in reach, `the would-be gateway was probed on ${port}`);
    }
    for (const [target, result] of Object.entries(reach)) {
      assert.notEqual(result, 'connected', `the host is reachable from the agent at ${target}`);
    }
    // No IPv6.
    assert.deepEqual(r['ipv6'].addresses, [], 'the agent holds no IPv6 address');
    assert.notEqual(r['ipv6'].publicProbe, 'connected', 'IPv6 egress must fail');
    // The proxy is not a general proxy.
    assert.match(r['proxyAbsoluteForm'], /^HTTP\/1\.1 403/);
    assert.match(r['proxyConnect'], /^HTTP\/1\.1 403/);
    assert.equal(r['proxyOtherPath'], 403);
    // The model API is reachable through it — with the real key upstream.
    assert.equal(r['model'].status, 200, JSON.stringify(r['model']));
    assert.equal(JSON.parse(r['model'].body).sawKeySha256, createHash('sha256').update(w.secret).digest('hex'),
      'the upstream saw the real key');
    const upstream = readFileSync(w.modelLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((e: Record<string, unknown>) => e['method'] !== undefined);
    assert.deepEqual(upstream.map((e: Record<string, unknown>) => `${e['method']} ${e['path']}`), ['POST /v1/messages?beta=true'],
      'exactly the one allowlisted call reached the upstream');
    assert.ok(upstream.every((e: Record<string, unknown>) => e['apiKey'] === w.secret && e['authorization'] === null));

    // Only the worktree is writable.
    assert.equal(r['worktree'].writeFile, 'written');
    assert.equal(readFileSync(join(w.wt, 'agent-wrote.txt'), 'utf8'), 'x', 'the write landed in the leased worktree');
    assert.equal(r['worktree'].writeGitIndirection, 'error:EROFS');
    assert.equal(r['worktree'].chmodGitIndirection, 'error:EROFS');
    assert.equal(r['worktree'].gitdirVisible, 'absent', 'the mirror is not mounted');
    assert.equal(r['inputs'].chmodWorkOrder, 'error:EROFS', 'the inputs are a read-only bind');
    assert.match(r['inputs'].writeWorkOrder, /^error:(EROFS|EACCES)$/);
    assert.match(r['inputs'].writeInputDir, /^error:(EROFS|EACCES)$/);
    assert.match(r['rootfs'], /^error:(EROFS|EACCES)$/);
    assert.equal(r['inputs'].workOrderSha256Matches, true);
    assert.equal(r['inputs'].contextPackSha256Matches, true);
    assert.equal(r['uid'], process.getuid!(), 'the agent runs as the harness user, not root');
    assert.equal(treeDigest(w.mirror), mirrorBefore, 'the host mirror is byte-identical');

    // The agent's environment: the placeholder, no host credential.
    const env = r['env'] as Record<string, string>;
    assert.equal(env['ANTHROPIC_API_KEY'], MODEL_KEY_PLACEHOLDER);
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) assert.equal(env[k], undefined, k);
    for (const v of Object.values(env)) assert.ok(!v.includes(w.secret));

    // The leak test, from outside.
    const invocations = readFileSync(w.dockerLog, 'utf8');
    assert.match(invocations,
      /ARGV network create --internal -o com\.docker\.network\.bridge\.gateway_mode_ipv4=isolated -o com\.docker\.network\.bridge\.gateway_mode_ipv6=isolated /);
    assert.ok(!invocations.includes(w.secret), 'no docker argv or client environment carries the key');
    assert.ok(!invocations.includes('ghp_must_not'), 'the docker client environment is the allowlist');
    const objects = readdirSync(join(w.dir, 'objects'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.ok(objects.length >= 4);
    for (const f of objects) {
      assert.ok(!readFileSync(join(f.parentPath, f.name), 'utf8').includes(w.secret), `${f.name} holds no key`);
    }
    assert.ok(!JSON.stringify(obs).includes(w.secret));
    assert.deepEqual(obs.eventArtifactRefs.map((x) => x.kind).sort(),
      ['claude-egress-log', 'claude-event-stream', 'claude-invocation']);

    assert.equal(await leftovers(req.attemptId), '', 'no container or network outlives the attempt');
    // The host service was up all along: the agent's refusals were the network's.
    assert.equal(await reachesHostThroughGateway(['--internal'], host.port), 'connected',
      'the host service still answers through a plain internal network');
  } finally {
    await host.stop();
    delete process.env['GITHUB_TOKEN'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    await db.close();
    await w.teardown();
  }
});

test('a hung agent is removed by the wall-clock budget, and so is everything else', async () => {
  const w = await world();
  const { db, store: s } = await store(w.dir);
  try {
    const workOrderRef = await put(s, 'work-order', { objective: 'hang' });
    const contextPackRef = await put(s, 'context-pack', {});
    const req = request(workOrderRef, contextPackRef, {
      budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 0.15 },
    });
    await seedAttempt(db, req.attemptId);
    const started = Date.now();
    const obs = await (await provider(w, s, 'hang')).execute(req);
    assert.equal(obs.status, 'BUDGET_EXHAUSTED', obs.knownLimitations.join('; '));
    assert.match(obs.knownLimitations.join(' '), /wall-clock/);
    assert.ok(Date.now() - started < 60_000);
    assert.equal(await leftovers(req.attemptId), '', 'the container was removed, not merely abandoned');
  } finally {
    await db.close();
    await w.teardown();
  }
});

async function running(attemptId: string, role: string): Promise<boolean> {
  const ids = await mustDocker([
    'ps', '-q', '--filter', `label=asep.attempt=${attemptId}`, '--filter', `label=asep.role=${role}`, '--filter', 'status=running',
  ]);
  return ids !== '';
}

async function until(what: string, ok: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// A killed `docker run` client does not stop its container: the provider must
// remove the agent and the proxy by their identity when their clients die.
test('SIGKILLing the agent and proxy docker clients mid-run leaves no container or network behind', async () => {
  const w = await world();
  const { db, store: s } = await store(w.dir);
  try {
    const workOrderRef = await put(s, 'work-order', { objective: 'hang' });
    const contextPackRef = await put(s, 'context-pack', {});
    const req = request(workOrderRef, contextPackRef);
    await seedAttempt(db, req.attemptId);
    const started = Date.now();
    const execution = (await provider(w, s, 'hang')).execute(req);
    await until('the agent container to be running', () => running(req.attemptId, 'agent'));
    assert.equal(await running(req.attemptId, 'egress-proxy'), true);
    process.kill(w.runClientPid('agent'), 'SIGKILL');
    process.kill(w.runClientPid('egress-proxy'), 'SIGKILL');
    const obs = await execution;
    assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
    assert.ok(Date.now() - started < 90_000, 'the attempt ended with its clients, not at its wall-clock budget');
    assert.equal(await leftovers(req.attemptId), '', 'the containers and the network were removed, not abandoned');
  } finally {
    await db.close();
    await w.teardown();
  }
});

test('a cancelled attempt leaves no container or network behind', async () => {
  const w = await world();
  const { db, store: s } = await store(w.dir);
  try {
    const workOrderRef = await put(s, 'work-order', { objective: 'hang' });
    const contextPackRef = await put(s, 'context-pack', {});
    const ac = new AbortController();
    const req = request(workOrderRef, contextPackRef, { signal: ac.signal });
    await seedAttempt(db, req.attemptId);
    const execution = (await provider(w, s, 'hang')).execute(req);
    await until('the agent container to be running', () => running(req.attemptId, 'agent'));
    ac.abort();
    const obs = await execution;
    assert.equal(obs.status, 'BLOCKED', obs.knownLimitations.join('; '));
    assert.equal(await leftovers(req.attemptId), '', 'cancelled: nothing left');
  } finally {
    await db.close();
    await w.teardown();
  }
});
