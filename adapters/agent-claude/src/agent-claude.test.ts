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
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ClaudeCodingProvider, FileModelCredentialProvider, AgentConfigError, MODEL_KEY_PLACEHOLDER,
  claudeToolGrant, ToolPolicyError, buildClaudeArgs, parseModelBaseUrl, ModelCredentialError,
  parseStream, MalformedEventError, redactSecrets, agentNetworkIsolationGap, AGENT_STOP_BOUND_MS,
  AGENT_REMOVAL_BOUND_MS, agentRemovalDeadline, PROXY_EXPIRY_GRACE_MS, PROXY_EXIT_BOUND_MS, PROXY_MAX_LIFETIME_MS,
  PROXY_START_TIMEOUT_MS, PROXY_CREDENTIAL_WINDOW_MS, proxyHandshake,
  type AgentSandboxConfig, type ModelCredentialProvider, type AgentLifecycleEvent, type AgentLifecyclePhase,
} from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import {
  DOCKER_CALL_TIMEOUT_MS, removeContainerShownGone, monotonicNow, type DockerCall, type TeardownClock,
} from '@asep/command-runner';
import type { ArtifactStore, AgentAttemptObservation, AgentExecuteRequest, ToolPolicyProfile } from '@asep/ports';
import {
  REGISTRY_ENV, TOKEN_ENV, endProcess, identityOf, nestRegistry, register, shownGone, spawnRecorded, stillRunning, unregister,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/lib/process-registry.mjs';
import {
  registryShimLine, removeFakeDockerFixture,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/testing/fake-docker-fixture.mjs';
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
// The wall-clock budget of an attempt in a test that is not about it. Under
// host load (load average 56 on 8 CPUs, other gates running) one ordinary
// attempt took 53.8 s, close enough to a 1-minute budget for it to fire in a
// test about something else. Five minutes is far above anything observed and
// still well below the fake CLI's 10-minute hang.
const BUDGET = { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 };
// The budget of the test that is about the wall clock: it must outlast the
// setup before the agent starts, which took at most 2.4 s at load average 120
// on 8 CPUs, or the deadline fires while the proxy is still starting.
const SHORT_WALL_CLOCK_MINUTES = 0.2;
// How late, on a loaded host, the provider may act on a deadline or a
// cancellation it was handed, and a docker client end after its call's
// timeout: the scheduling allowance of every timing assertion below. It is
// added to the product's own bounds, never in place of them. Against the real
// daemon at load average 37–106 (CPU burners and docker churn) the stop came
// at most 4 ms after its deadline.
const SCHEDULING_ALLOWANCE_MS = 2_000;
// How late a timer of this process may fire under load.
const TIMER_LATENESS_MS = 500;
const ATTEMPT = 'D'.repeat(26) as AttemptId;
const BINDING = 'E'.repeat(26);

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
    // The attempt the requests name: the provider links its artifacts to it.
    await db.query(`insert into repository_bindings
      (id, organization_id, project_id, forge, github_host, github_owner, github_repo, default_base_branch)
      values ($1, $2, $3, 'github', 'github.com', 'acme', 'web', 'main')`, [BINDING, scope.organizationId, scope.projectId]);
    await db.query(`insert into runs (id, organization_id, project_id, repository_binding_id, status, risk)
      values ($1, $2, $3, $4, 'EXECUTING', 'R0')`, ['F'.repeat(26), scope.organizationId, scope.projectId, BINDING]);
    await db.query(`insert into tasks (id, organization_id, project_id, run_id, repository_binding_id, status, risk)
      values ($1, $2, $3, $4, $5, 'EXECUTING', 'R0')`, ['G'.repeat(26), scope.organizationId, scope.projectId, 'F'.repeat(26), BINDING]);
    await db.query(`insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status)
      values ($1, $2, $3, $4, $5, 'AGENT_RUNNING')`, [ATTEMPT, scope.organizationId, scope.projectId, 'G'.repeat(26), BINDING]);
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
  // Every lifecycle moment of every attempt this harness's providers ran.
  readonly lifecycle: AgentLifecycleEvent[];
  cli(scenario: string, env?: Record<string, string>): Promise<string>;
  provider(
    scenario: string, over?: Partial<AgentSandboxConfig>, credentials?: ModelCredentialProvider,
    observe?: (e: AgentLifecycleEvent) => void,
  ): Promise<ClaudeCodingProvider>;
  invocations(): Record<string, unknown>[];
  close(): Promise<void>;
}

async function harness(opts: {
  echoKey?: boolean; workOrder?: unknown; refuseRemoval?: boolean; hangKill?: boolean;
  keepAgent?: boolean; agentRmErrs?: boolean; hangInspect?: boolean;
  netCreate?: 'hangs-after' | 'errs-after' | 'refused'; proxyHangs?: boolean; inspectErr?: string;
  slowNetworkInspectS?: number;
} = {}): Promise<Harness> {
  // Real paths: the provider resolves the worktree with realpath(3).
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-provider-')));
  const state = join(dir, 'docker-state');
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const docker = join(bin, 'docker');
  // Records each client's pid and argv, so a test can kill one; with
  // `refuseRemoval` it stands for a daemon that cannot stop or remove anything,
  // with `hangKill` for one whose `docker kill` of the agent never answers,
  // with `keepAgent` for one that cannot stop the agent and answers its
  // removal with success while keeping it, and with `agentRmErrs` for one that
  // removes the agent but answers its removal with an error, with
  // `hangInspect` for one that never answers whether a container exists, and
  // with `netCreate` for one that creates the agent network and then never
  // answers ('hangs-after') or answers with an error ('errs-after'), or
  // refuses to create it ('refused'), with `proxyHangs` for one whose proxy
  // client never starts its container (it keeps whatever reaches its stdin in
  // `proxy-stdin`), with `inspectErr` for one whose
  // inspect fails with that error, and with `slowNetworkInspectS` for one that
  // takes that many seconds to describe a network.
  const fake = `"${process.execPath}" "${FAKE_DOCKER}" --state "${state}" "$@"`;
  await writeFile(docker, [
    '#!/bin/sh',
    registryShimLine(),
    `echo "$$ $*" >> "${join(dir, 'client-pids')}"`,
    ...(opts.refuseRemoval ? ['case "$1" in rm|kill) echo "Error response from daemon: removal refused" >&2; exit 1;; esac'] : []),
    ...(opts.hangKill ? ['case "$1 $2" in "kill asep-agent-"*) exec sleep 600;; esac'] : []),
    ...(opts.keepAgent ? [
      'case "$1 $2" in "kill asep-agent-"*) echo "Error response from daemon: cannot kill" >&2; exit 1;; esac',
      'case "$1 $2 $3" in "rm -f asep-agent-"*) echo "$3"; exit 0;; esac',
    ] : []),
    ...(opts.agentRmErrs ? [
      `case "$1 $2 $3" in "rm -f asep-agent-"*) ${fake} >/dev/null; echo "Error response from daemon: lost the answer" >&2; exit 1;; esac`,
    ] : []),
    ...(opts.hangInspect ? ['case "$1" in inspect) exec sleep 600;; esac'] : []),
    ...(opts.proxyHangs
      ? [`case "$1 $*" in "run "*asep.role=egress-proxy*) exec cat > "${join(dir, 'proxy-stdin')}";; esac`] : []),
    ...(opts.inspectErr !== undefined ? [`case "$1" in inspect) echo '${opts.inspectErr}' >&2; exit 1;; esac`] : []),
    ...(opts.slowNetworkInspectS !== undefined
      ? [`case "$1 $2" in "network inspect") sleep ${opts.slowNetworkInspectS};; esac`] : []),
    ...(opts.netCreate === 'hangs-after' ? [`case "$1 $2" in "network create") ${fake} >/dev/null; exec sleep 600;; esac`] : []),
    ...(opts.netCreate === 'errs-after' ? [
      `case "$1 $2" in "network create") ${fake} >/dev/null; echo "Error response from daemon: lost the answer" >&2; exit 1;; esac`,
    ] : []),
    ...(opts.netCreate === 'refused' ? [
      'case "$1 $2" in "network create") echo "Error response from daemon: refused" >&2; exit 1;; esac',
    ] : []),
    `exec ${fake}`,
    '',
  ].join('\n'), { mode: 0o755 });
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
  const lifecycle: AgentLifecycleEvent[] = [];

  const h: Harness = {
    dir, state, docker, wt, secret, keyFile, store, objects, upstream, lifecycle,
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
    async provider(scenario, over = {}, credentials, observe) {
      return new ClaudeCodingProvider(
        {
          executable: await h.cli(scenario), model: MODEL, cliVersion: CLI_VERSION, maxTurns: 5,
          sandbox: {
            image: AGENT_IMAGE, proxyImage: PROXY_IMAGE, workdirFor: () => wt,
            dockerBinary: docker, inputRoot: dir, ...over,
          },
          credentials: credentials ?? new FileModelCredentialProvider({ apiKeyFile: keyFile, baseUrl: upstream.url }),
          observeLifecycle: observe ?? ((e) => { lifecycle.push(e); }),
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
      await removeFakeDockerFixture(dir);
    },
  };
  return h;
}

function request(h: Harness, over: Partial<AgentExecuteRequest> = {}): AgentExecuteRequest {
  return {
    attemptId: ATTEMPT,
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

// --- timing what the provider bounds: the stop, not the setup ----------------------

type Timeline = readonly AgentLifecycleEvent[];

// The attempt as it happened, relative to its start: what a failed timing
// assertion prints.
function showTimeline(t: Timeline): string {
  const t0 = t[0]?.at ?? 0;
  return t.map((e) => `  +${e.at - t0} ms ${e.phase}${e.reason !== undefined ? ` (${e.reason})` : ''}`
    + `${e.deadline !== undefined ? `, deadline at +${e.deadline - t0} ms` : ''}`).join('\n');
}

// What a failed status assertion prints: the observation's own account of the
// attempt and, when given, its moments.
function showObservation(obs: AgentAttemptObservation, t: Timeline = []): string {
  const why = obs.knownLimitations.length > 0 ? obs.knownLimitations.join('; ') : '(no known limitations)';
  return `status ${obs.status}: ${obs.summary}\n  ${why}${t.length > 0 ? `\n${showTimeline(t)}` : ''}`;
}

function phaseOf(t: Timeline, phase: AgentLifecyclePhase): AgentLifecycleEvent {
  const found = t.filter((e) => e.phase === phase);
  assert.equal(found.length, 1, `exactly one '${phase}' moment:\n${showTimeline(t)}`);
  return found[0]!;
}

// When the wall clock's stop was due: at the deadline, or as soon as the agent
// started if the setup outlasted the deadline.
function wallClockDue(t: Timeline): number {
  return Math.max(phaseOf(t, 'started').deadline!, phaseOf(t, 'agent-started').at);
}

// The stop was for `reason`; when `due` is given it was acted on no earlier
// than that (timers and the lifecycle clock may disagree by a few ms) and no later than
// the scheduling allowance after it; and the agent container was removed
// within the product's stop bound after the stop.
function assertStoppedInTime(t: Timeline, reason: 'timeout' | 'aborted' | 'violation', due?: number): void {
  const stop = phaseOf(t, 'stop');
  assert.equal(stop.reason, reason, showTimeline(t));
  if (due !== undefined) {
    assert.ok(stop.at - due >= -50, `stopped ${due - stop.at} ms before it was due:\n${showTimeline(t)}`);
    assert.ok(stop.at - due <= SCHEDULING_ALLOWANCE_MS,
      `stopped ${stop.at - due} ms after it was due (allowance ${SCHEDULING_ALLOWANCE_MS} ms):\n${showTimeline(t)}`);
  }
  const removed = phaseOf(t, 'agent-removed');
  assert.ok(removed.at - stop.at <= AGENT_STOP_BOUND_MS + SCHEDULING_ALLOWANCE_MS,
    `the agent container was removed ${removed.at - stop.at} ms after the stop; the bound is `
      + `${AGENT_STOP_BOUND_MS} ms + ${SCHEDULING_ALLOWANCE_MS} ms:\n${showTimeline(t)}`);
}

// The agent ended on its own — nothing stopped it, least of all the wall
// clock — and its container was shown gone within the removal bound of its end.
function assertExitedAndRemoved(t: Timeline): void {
  assert.deepEqual(t.filter((e) => e.phase === 'stop'), [], `nothing stopped the agent:\n${showTimeline(t)}`);
  const exited = phaseOf(t, 'agent-exited');
  const removed = phaseOf(t, 'agent-removed');
  assert.ok(removed.at - exited.at <= AGENT_REMOVAL_BOUND_MS + SCHEDULING_ALLOWANCE_MS,
    `the agent container was removed ${removed.at - exited.at} ms after its client ended:\n${showTimeline(t)}`);
}

async function eventStream(h: Harness, refs: readonly ArtifactRef[]): Promise<string> {
  const ref = refs.find((r) => r.kind === 'claude-event-stream');
  assert.ok(ref, 'the raw event stream is recorded');
  return new TextDecoder().decode((await h.store.get(scope, ref)).content);
}

// --- the happy path ------------------------------------------------------------------

test('closing a harness ends every container still recorded in its docker state before that state goes', async () => {
  const h = await harness();
  // A container whose client died: only its record finds its process.
  const client = spawn(h.docker, ['run', '--name', 'left-behind', AGENT_IMAGE, process.execPath, '-e', 'setInterval(() => {}, 1e9)'],
    { stdio: 'ignore' });
  const record = join(h.state, 'containers', 'left-behind.json');
  await within((async () => {
    while (!existsSync(record)) await new Promise((r) => setTimeout(r, 20));
  })(), 30_000, 'the container starting');
  const pid = (JSON.parse(readFileSync(record, 'utf8')) as { pid: number }).pid;
  client.kill('SIGKILL');
  await new Promise((r) => client.once('exit', r));
  assert.equal(stillRunning(pid, true), true, 'its client is gone, the container is not');
  await h.close();
  assert.equal(stillRunning(pid, true), false, 'the container was ended');
  assert.equal(existsSync(h.dir), false, 'and then the harness state was removed');
});

test('the lifecycle observer sees each moment of an attempt in order, and one that throws changes nothing', async () => {
  const h = await harness();
  try {
    const obs = await (await h.provider('ok')).execute(request(h));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    assert.deepEqual(h.lifecycle.map((e) => e.phase), [
      'started', 'network-ready', 'proxy-ready', 'agent-started', 'agent-exited', 'agent-removed', 'torn-down',
    ]);
    assert.ok(h.lifecycle.every((e) => e.attemptId === ATTEMPT));
    assert.ok(h.lifecycle.every((e, i) => i === 0 || e.at >= h.lifecycle[i - 1]!.at), 'in the order they happened');
    // The deadline is the budget from the start of execute(), which the first
    // moment is reported just after.
    const sinceDeadlineSet = h.lifecycle[0]!.at + BUDGET.maxWallClockMinutes * 60_000 - h.lifecycle[0]!.deadline!;
    assert.ok(sinceDeadlineSet >= 0 && sinceDeadlineSet <= 50, `deadline off by ${sinceDeadlineSet} ms`);

    let calls = 0;
    const throwing = await h.provider('ok', {}, undefined, () => { calls++; throw new Error('observer failure'); });
    const again = await throwing.execute(request(h));
    assert.equal(again.status, 'AGENT_DONE', again.knownLimitations.join('; '));
    assert.equal(again.summary, obs.summary);
    assert.equal(calls, 7, 'it was told every moment all the same');
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('a contained attempt: internal network, proxy, agent, teardown — and an untrusted observation', async () => {
  const h = await harness();
  try {
    const provider = await h.provider('ok');
    assert.equal(provider.providerId, `claude:${MODEL}@cli-${CLI_VERSION}`);
    const before = performance.now();
    const obs = await provider.execute(request(h));
    const after = performance.now();
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

    // The docker choreography, in order: the agent is removed by name and shown
    // gone, the proxy stopped then removed by name, then everything labelled
    // with the attempt is shown gone before and after the network goes.
    assert.deepEqual(verbs(h.invocations()), [
      'network create', 'network inspect', 'run', 'network connect', 'run', 'rm', 'inspect', 'kill', 'rm', 'ps',
      'network rm', 'network ls',
    ]);
    const sweeps = argvOf(h.invocations()).filter((a) => a[0] === 'ps' || (a[0] === 'network' && a[1] === 'ls'));
    for (const a of sweeps) assert.ok(a.includes(`label=asep.attempt=${ATTEMPT}`), `${a.join(' ')} sweeps by the attempt label`);
    const [create, inspect, proxy, connect, agent] = argvOf(h.invocations());
    assert.ok(create!.includes('--internal'), 'the agent network is internal: no route out');
    for (const family of ['ipv4', 'ipv6']) {
      const opt = `com.docker.network.bridge.gateway_mode_${family}=isolated`;
      assert.equal(create![create!.indexOf(opt) - 1], '-o', `the host gets no ${family} address on the agent bridge`);
    }
    const netName = create!.at(-1)!;
    assert.deepEqual(inspect, ['network', 'inspect', '--format', '{{json .}}', netName],
      'the isolation is confirmed from the daemon before anything is attached');
    assert.equal(proxy![proxy!.indexOf('--network') + 1], 'bridge', 'the proxy alone sits on the egress network');
    // The proxy's own lifetime, relative, which it counts on its own clock: what
    // was left of the budget when it was started, plus the grace — whatever
    // becomes of the process that started it.
    assert.ok(!proxy!.includes('--expires-at'), 'no wall-clock moment is handed over');
    const lifetime = Number(proxy![proxy!.indexOf('--lifetime-ms') + 1]);
    const full = BUDGET.maxWallClockMinutes * 60_000 + PROXY_EXPIRY_GRACE_MS;
    assert.ok(Number.isSafeInteger(lifetime) && lifetime <= full && lifetime >= full - (after - before),
      `the proxy lives ${lifetime} ms, not what was left of the ${full} ms (attempt took ${after - before} ms)`);
    // And the window it waits for its credential: the proxy's own maximum, and
    // longer than the readiness bound after which the credential is never sent.
    assert.equal(proxy![proxy!.indexOf('--credential-window-ms') + 1], String(PROXY_CREDENTIAL_WINDOW_MS));
    assert.equal(PROXY_CREDENTIAL_WINDOW_MS, (await proxyModule()).CREDENTIAL_WINDOW_MS);
    assert.ok(PROXY_CREDENTIAL_WINDOW_MS > PROXY_START_TIMEOUT_MS);
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
    // Every artifact is linked to the attempt it was produced for.
    const { db } = await database();
    const linked = await db.query('select id from artifacts where attempt_id = $1', [ATTEMPT]);
    const linkedIds = new Set(linked.rows.map((r) => r['id']));
    for (const ref of obs.eventArtifactRefs) assert.ok(linkedIds.has(ref.artifactId), `${ref.kind} is linked to the attempt`);
    // G5: no harness-owned fact comes from the provider.
    for (const k of ['attemptId', 'resultSha', 'changedFiles']) {
      assert.equal((obs as unknown as Record<string, unknown>)[k], undefined);
    }
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

// The lifetime handed to the proxy, from the docker argv of one attempt.
async function proxyLifetimeOf(h: Harness, maxWallClockMinutes: number): Promise<number> {
  const obs = await (await h.provider('ok')).execute(request(h, { budget: { ...BUDGET, maxWallClockMinutes } }));
  assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
  assertTornDown(h);
  const proxy = argvOf(h.invocations()).find((a) => a[0] === 'run' && a.includes('asep.role=egress-proxy'))!;
  return Number(proxy[proxy.indexOf('--lifetime-ms') + 1]);
}

test('the proxy lifetime is what is left of the budget when the proxy is started, plus the grace, at most the maximum', async () => {
  // Counted when the proxy is started, not before the setup: a slow network
  // setup comes off it, so the proxy's own start is the only time it adds.
  const slow = await harness({ slowNetworkInspectS: 2 });
  try {
    const lifetime = await proxyLifetimeOf(slow, BUDGET.maxWallClockMinutes);
    const full = BUDGET.maxWallClockMinutes * 60_000 + PROXY_EXPIRY_GRACE_MS;
    assert.ok(lifetime <= full - 2_000, `the proxy lives ${lifetime} ms: the 2 s setup did not come off ${full} ms`);
  } finally {
    await slow.close();
  }
  // The longest budget the proxy can outlive gets close to the maximum, which
  // the proxy accepts.
  const long = await harness();
  try {
    const lifetime = await proxyLifetimeOf(long, (PROXY_MAX_LIFETIME_MS - PROXY_EXPIRY_GRACE_MS) / 60_000);
    assert.ok(lifetime <= PROXY_MAX_LIFETIME_MS && lifetime > PROXY_MAX_LIFETIME_MS - 10_000, `the proxy lives ${lifetime} ms`);
    assert.equal(PROXY_MAX_LIFETIME_MS, (await proxyModule()).MAX_LIFETIME_MS,
      "the provider's maximum is the proxy's own");
  } finally {
    await long.close();
  }
});

test('a budget the egress proxy cannot outlive is refused before anything is done for it', async () => {
  const h = await harness();
  try {
    let asked = 0;
    const credentials: ModelCredentialProvider = {
      credentialFor: async () => {
        asked += 1;
        return { apiKey: `asep-test-model-key-${randomUUID()}`, baseUrl: h.upstream.url };
      },
    };
    const longest = (PROXY_MAX_LIFETIME_MS - PROXY_EXPIRY_GRACE_MS) / 60_000;
    for (const minutes of [24 * 60, longest + 1 / 60_000, Number.NaN]) {
      const obs = await (await h.provider('ok', {}, credentials))
        .execute(request(h, { budget: { ...BUDGET, maxWallClockMinutes: minutes } }));
      assert.equal(obs.status, 'BLOCKED', `${minutes} minute(s): ${showObservation(obs)}`);
      assert.match(obs.knownLimitations.join(' '),
        new RegExp(`budget of ${minutes} minute\\(s\\) and the egress proxy's ${PROXY_EXPIRY_GRACE_MS} ms grace exceed `
          + `its maximum lifetime of ${PROXY_MAX_LIFETIME_MS} ms`));
    }
    assert.equal(asked, 0, 'its credential was never asked for');
    assert.deepEqual(h.invocations(), [], 'docker was never asked to do anything');
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
    // the fake docker gives every container the token that identifies its
    // process in the test registry, and macOS adds __CF_USER_TEXT_ENCODING to
    // every process it launches.
    const hostArtifacts = new Set(['FAKE_CLAUDE_SCENARIO', TOKEN_ENV, '__CF_USER_TEXT_ENCODING']);
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
    const proxyStdin = inv.findLast((i) => typeof i['container'] === 'string'
      && String(i['container']).startsWith('asep-egress-') && 'stdinSha256' in i);
    assert.equal(proxyStdin?.['stdinSha256'], createHash('sha256').update(`${h.secret}\n`).digest('hex'),
      'the key went to the proxy on stdin');
    // Only after the proxy said it listens: nothing reached its stdin before.
    const ofProxy = inv.filter((i) => i['container'] === proxyStdin?.['container']);
    assert.ok(ofProxy.length >= 2 && 'listening' in ofProxy[0]!,
      `the proxy reported ready before anything reached its stdin: ${JSON.stringify(ofProxy.map((i) => Object.keys(i)))}`);
    // And stdin then stayed open: it is the proxy's link to the provider.
    assert.deepEqual(inv.filter((i) => i['container'] === proxyStdin?.['container'] && i['stdinEnded'] === true), [],
      "the provider never ended the proxy's stdin");
    const agentStdin = inv.findLast((i) => typeof i['container'] === 'string'
      && String(i['container']).startsWith('asep-agent-') && 'stdinSha256' in i);
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
    assert.equal(obs.status, 'FAILED', showObservation(obs));
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
    assert.equal(loose.status, 'FAILED', showObservation(loose));
    assert.match(loose.knownLimitations.join(' '), /accessible to group\/other/);
    assert.deepEqual(h.invocations(), [], 'docker was never asked to do anything');

    const empty: ModelCredentialProvider = { credentialFor: async () => ({ apiKey: '  ', baseUrl: h.upstream.url }) };
    const none = await (await h.provider('ok', {}, empty)).execute(request(h));
    assert.equal(none.status, 'FAILED', showObservation(none));
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

// `p`, or a failure naming `what` once `ms` have passed.
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

interface StartedProxy {
  readonly pid: number;
  readonly port: number;
  // performance.now() in this process just before it was spawned, and once
  // it said it was listening.
  readonly spawnedAt: number;
  readonly readyAt: number;
  log(): string;
  // Kills it, and resolves once it has exited.
  stop(): Promise<void>;
  // When this process saw it exit (performance.now()), and how.
  readonly exited: Promise<{ at: number; code: number | null }>;
}

// The real proxy as a host process, started as the provider starts it: once
// it reports ready, the credential is written on its stdin (none when `key` is
// null), which then stays open as its link to this process — if this process
// dies, the proxy exits; then it confirms it serves. It is also recorded in
// the run's process registry until it is shown gone. One that does not report
// ready, and confirm its credential, within `readyWithinMs` is killed.
// `nodeArgs` go to node ahead of the asset.
async function startProxy(upstream: string, key: string | null, o: {
  lifetimeMs?: number; credentialWindowMs?: number; readyWithinMs?: number; nodeArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
} = {}): Promise<StartedProxy> {
  const readyWithinMs = o.readyWithinMs ?? 30_000;
  const spawnedAt = performance.now();
  const { child } = spawnRecorded(process.execPath, [
    ...(o.nodeArgs ?? []), PROXY_ASSET, '--listen', '127.0.0.1:0', '--upstream', upstream,
    '--lifetime-ms', String(o.lifetimeMs ?? 10 * 60_000),
    ...(o.credentialWindowMs !== undefined ? ['--credential-window-ms', String(o.credentialWindowMs)] : []),
  ], { stdio: ['pipe', 'pipe', 'pipe'], ...(o.env !== undefined ? { env: o.env } : {}) }) as {
    child: ChildProcessWithoutNullStreams;
  };
  const pid = child.pid!;
  let log = '';
  child.stderr.on('data', (d: Buffer) => { log += d.toString('utf8'); });
  const exited = new Promise<{ at: number; code: number | null }>((resolve) => {
    child.on('exit', (code) => resolve({ at: performance.now(), code }));
  });
  const stop = async () => {
    child.kill('SIGKILL');
    await exited;
    unregister(pid);
  };
  child.stdin.on('error', () => undefined);
  try {
    let readyAt = 0;
    const port = await within(new Promise<number>((resolve, reject) => {
      let out = '';
      let port: number | undefined;
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
        const m = /listening (\d+)/.exec(out);
        if (m && port === undefined) {
          port = Number(m[1]);
          readyAt = performance.now();
          if (key === null) resolve(port);
          else child.stdin.write(`${key}\n`);
        }
        if (port !== undefined && /asep-egress-proxy serving/.test(out)) resolve(port);
      });
      child.on('close', (code) => reject(new Error(`proxy (pid ${pid}) exited ${code}: ${log}`)));
    }), readyWithinMs, `the proxy (pid ${pid}) becoming ready`);
    return { pid, port, spawnedAt, readyAt, log: () => log, stop, exited };
  } catch (err) {
    await stop();
    throw err;
  }
}

// One request to a proxy, on a connection of its own: its status and body.
function proxyRequest(
  port: number, method: string, path: string, headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
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
  const proxy = await startProxy(up.url, key).catch(closing(up));
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
    await proxy.stop();
    await up.close();
  }
});

test('a test proxy that is not ready in time is killed, and leaves the process registry only once gone', async () => {
  const up = await fakeModelApi();
  const registry = await mkdtemp(join(tmpdir(), 'asep-registry-'));
  // A registry of its own, beside the run's.
  const restore = nestRegistry(registry) as () => void;
  try {
    let message = '';
    await assert.rejects(startProxy(up.url, `asep-test-model-key-${randomUUID()}`, { readyWithinMs: 1 }), (err: Error) => {
      message = err.message;
      return /becoming ready: not within 1 ms/.test(err.message);
    });
    const pid = Number(/\(pid (\d+)\)/.exec(message)?.[1]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0, message);
    assert.equal(stillRunning(pid), false, 'it was killed and has exited');
    assert.deepEqual(readdirSync(registry), [], 'and only then left the registry');

    const proxy = await startProxy(up.url, `asep-test-model-key-${randomUUID()}`);
    assert.deepEqual(readdirSync(registry), [`${proxy.pid}.json`], 'a running proxy is in the registry');
    await proxy.stop();
    assert.equal(stillRunning(proxy.pid), false);
    assert.deepEqual(readdirSync(registry), []);
  } finally {
    restore();
    await up.close();
    await rm(registry, { recursive: true, force: true });
  }
});

// The proxy module's own surface: its request handling, without its process.
interface EgressProxyModule {
  readonly MAX_LIFETIME_MS: number;
  readonly CREDENTIAL_WINDOW_MS: number;
  egressProxy(o: {
    upstream: string; deadline: number; credentialBy?: number; now?: () => number;
    schedule?: (fn: () => void, ms: number) => () => void;
    log?: (method: string, path: string, status: number) => void;
    onExpired?: (why: string) => void;
  }): ProxyServer;
}

type ProxyServer = http.Server & { provideCredential(key: string): boolean };

async function proxyModule(): Promise<EgressProxyModule> {
  return (await import(pathToFileURL(PROXY_ASSET).href)) as EgressProxyModule;
}

test('the egress proxy refuses to start without a lifetime and a credential window within their maxima, refuses to serve without a credential, and stops when its stdin ends', async () => {
  const { MAX_LIFETIME_MS, CREDENTIAL_WINDOW_MS } = await proxyModule();
  const run = (args: string[], input: string) => spawnSync(process.execPath, [
    PROXY_ASSET, '--listen', '127.0.0.1:0', '--upstream', 'http://127.0.0.1:9', ...args,
  ], { input, encoding: 'utf8', timeout: 10_000 });
  const tenMinutes = String(10 * 60_000);
  const notWhole = /--lifetime-ms must be a whole number of milliseconds, at least 1/;
  const beyond = new RegExp(`--lifetime-ms \\d+ is beyond the maximum lifetime of ${MAX_LIFETIME_MS} ms — refusing to start`);
  const badWindow = new RegExp(
    `--credential-window-ms must be a whole number of milliseconds from 1 to ${CREDENTIAL_WINDOW_MS} — refusing to start`);
  const refusals: readonly [readonly string[], string, RegExp][] = [
    [[], 'k\n', /missing --lifetime-ms/],
    [['--lifetime-ms', 'soon'], 'k\n', notWhole],
    [['--lifetime-ms', '0'], 'k\n', notWhole],
    [['--lifetime-ms', '1.5'], 'k\n', notWhole],
    [['--lifetime-ms', String(MAX_LIFETIME_MS + 1)], 'k\n', beyond],
    [['--lifetime-ms', String(Number.MAX_SAFE_INTEGER)], 'k\n', beyond],
    ...['soon', '0', '1.5', String(CREDENTIAL_WINDOW_MS + 1)].map((w): [readonly string[], string, RegExp] =>
      [['--lifetime-ms', tenMinutes, '--credential-window-ms', w], 'k\n', badWindow]),
    [['--lifetime-ms', tenMinutes], '', /stdin closed before a credential arrived — refusing to serve/],
    [['--lifetime-ms', tenMinutes], '\n', /no credential on stdin — refusing to serve/],
  ];
  for (const [args, input, why] of refusals) {
    const r = run([...args], input);
    assert.equal(r.status, 2, `${args.join(' ') || '(no lifetime)'} with ${JSON.stringify(input)}: ${r.stderr}`);
    assert.match(r.stderr, why);
  }
  // A starter that hands over the credential and then ends stdin has let go:
  // the proxy reported ready, took the credential, said it serves, and stops.
  // A lifetime and a credential window of exactly their maxima are accepted.
  for (const args of [[tenMinutes], [String(MAX_LIFETIME_MS)], [tenMinutes, '--credential-window-ms', String(CREDENTIAL_WINDOW_MS)]]) {
    const ended = run(['--lifetime-ms', ...args], 'k\n');
    assert.equal(ended.status, 0, `${args.join(' ')}: ${ended.stderr}`);
    assert.match(ended.stdout, /^asep-egress-proxy listening \d+\nasep-egress-proxy serving\n$/);
    assert.match(ended.stderr, /asep-egress-proxy: stopping: its parent link closed/);
  }
  // Its lifetime counts from its own start, which was more than 1 ms ago: it
  // ends at once, credential or not.
  const brief = run(['--lifetime-ms', '1'], 'k\n');
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stderr, /asep-egress-proxy: stopping: its lifetime ended/);
  assert.doesNotMatch(brief.stdout, /serving/);
});

// Virtual time for the proxy module: a clock the test moves, and the proxy's
// timer, which runs only when the test fires it.
interface VirtualTime {
  now(): number;
  set(to: number): void;
  schedule(fn: () => void, ms: number): () => void;
  // Runs the timer the proxy set, if one is set.
  fire(): void;
  // Every moment the proxy set its timer for, in order.
  readonly scheduled: number[];
}

function virtualTime(): VirtualTime {
  let t = 0;
  let pending: { fn: () => void } | undefined;
  const scheduled: number[] = [];
  return {
    now: () => t,
    set: (to) => { t = to; },
    schedule: (fn, ms) => {
      const entry = { fn };
      pending = entry;
      scheduled.push(t + ms);
      return () => {
        if (pending === entry) pending = undefined;
      };
    },
    fire: () => {
      const p = pending;
      pending = undefined;
      p?.fn();
    },
    scheduled,
  };
}

interface ModuleProxy {
  readonly server: ProxyServer;
  readonly port: number;
  // The refusals it logged, as `METHOD path`.
  readonly refused: string[];
  // Resolves once it called onExpired; how often it did, and why.
  readonly expired: Promise<void>;
  expiredCalls(): number;
  readonly reasons: string[];
  close(): void;
}

// For a proxy that failed to start: closes the upstream it was given, so that
// a failing test leaves nothing listening, and passes the failure on.
const closing = (up: { close(): Promise<void> }) => async (err: unknown): Promise<never> => {
  await up.close();
  throw err;
};

// The proxy module in this process, on virtual time, ending at `deadline` and
// waiting for its credential until `credentialBy`. It is given `key` once it
// listens, unless `withholdKey`.
async function moduleProxy(upstream: string, key: string, time: VirtualTime, deadline: number, o: {
  credentialBy?: number; withholdKey?: boolean;
} = {}): Promise<ModuleProxy> {
  const { egressProxy } = await proxyModule();
  const refused: string[] = [];
  const reasons: string[] = [];
  let expiredNow!: () => void;
  const expired = new Promise<void>((r) => { expiredNow = r; });
  const server = egressProxy({
    upstream, deadline, now: time.now, schedule: time.schedule,
    ...(o.credentialBy !== undefined ? { credentialBy: o.credentialBy } : {}),
    log: (method, path, status) => {
      if (status === 403) refused.push(`${method} ${path}`);
    },
    onExpired: (why) => {
      reasons.push(why);
      expiredNow();
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  if (!o.withholdKey) assert.equal(server.provideCredential(key), true, 'the credential is taken');
  return {
    server, port, refused, expired, expiredCalls: () => reasons.length, reasons,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

interface StreamingUpstream {
  readonly url: string;
  // The body of every streamed request, chunk by chunk as it arrived.
  readonly body: string[];
  // Writes `text` on every response still open; ends every one.
  push(text: string): void;
  finish(): void;
  // With `holdHeaders`: starts every response held so far.
  release(): void;
  // Resolves once a streamed request's connection closed.
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

// A model API whose `POST /v1/messages` answers stream and stay open: the
// headers and `chunk-1;` at once (with `holdHeaders`, once released), then
// whatever the test pushes. A count_tokens call is answered whole.
async function streamingModelApi(o: { holdHeaders?: boolean } = {}): Promise<StreamingUpstream> {
  const body: string[] = [];
  const open = new Set<http.ServerResponse>();
  const held: (() => void)[] = [];
  let closedNow!: () => void;
  const closed = new Promise<void>((r) => { closedNow = r; });
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/v1/messages/count_tokens')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1}');
      });
      return;
    }
    req.on('data', (d: Buffer) => body.push(d.toString('utf8')));
    const start = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('chunk-1;');
    };
    if (o.holdHeaders) held.push(start);
    else start();
    open.add(res);
    res.on('close', () => {
      open.delete(res);
      closedNow();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, body, closed,
    push: (text) => {
      for (const res of open) res.write(text);
    },
    finish: () => {
      for (const res of open) res.end();
    },
    release: () => {
      for (const start of held.splice(0)) start();
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

interface StreamingRequest {
  // Writes more of the request body; ends it.
  send(text: string): void;
  end(): void;
  // The response's status, once its status line has arrived.
  status(): number | undefined;
  // What has arrived of the response.
  text(): string;
  // Resolves when its connection closed (performance.now()), with whether the
  // response had arrived whole.
  readonly closed: Promise<{ at: number; whole: boolean }>;
}

// A `POST /v1/messages` to a proxy whose body and response both stream: it
// sends `part-1;` and keeps the body open.
function streamingRequest(port: number): StreamingRequest {
  let text = '';
  let status: number | undefined;
  const req = http.request({
    host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', agent: false,
    headers: { 'content-type': 'application/json' },
  });
  const closed = new Promise<{ at: number; whole: boolean }>((resolve) => {
    req.on('response', (res) => {
      status = res.statusCode;
      res.on('data', (d: Buffer) => { text += d.toString('utf8'); });
      res.on('close', () => resolve({ at: performance.now(), whole: res.complete }));
    });
    req.on('error', () => resolve({ at: performance.now(), whole: false }));
  });
  req.write('part-1;');
  return {
    send: (t) => {
      if (!req.destroyed) req.write(t);
    },
    end: () => {
      if (!req.destroyed) req.end();
    },
    status: () => status,
    text: () => text,
    closed,
  };
}

test('the egress proxy serves until its deadline and refuses from it on, on a kept-alive connection too, and then ends', async () => {
  const up = await fakeModelApi();
  const key = `asep-test-model-key-${randomUUID()}`;
  const time = virtualTime();
  const p = await moduleProxy(up.url, key, time, 60_000, { credentialBy: 30_000 }).catch(closing(up));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let connections = 0;
  p.server.on('connection', () => { connections += 1; });
  // A request on the one kept-alive connection.
  const post = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path, agent }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
  try {
    assert.deepEqual(time.scheduled, [30_000, 60_000],
      'its timer is set for the end of its credential window, then, holding its credential, for its deadline');
    assert.equal((await post('/v1/messages')).status, 200);
    // A timer that fires early does not end it: it is set again for the deadline.
    time.set(59_999);
    time.fire();
    assert.deepEqual(time.scheduled, [30_000, 60_000, 60_000]);
    assert.equal((await post('/v1/messages')).status, 200, 'it serves until its deadline');
    // At the deadline, its timer not yet fired: the next request on the same
    // connection is refused, and then the proxy ends.
    time.set(60_000);
    const late = await post('/v1/messages/count_tokens');
    assert.equal(late.status, 403, 'from its deadline on, a request on a kept-alive connection is refused');
    assert.match(late.body, /no longer serving: its lifetime ended/);
    assert.equal(connections, 1, 'the three requests came on one kept-alive connection');
    await within(p.expired, 5_000, 'the proxy ending once it refused');
    assert.equal(p.server.listening, false, 'it no longer listens');
    await assert.rejects(proxyRequest(p.port, 'POST', '/v1/messages'), { code: 'ECONNREFUSED' });
    // Ended is ended: its timer firing, or its clock going back, changes nothing.
    time.fire();
    time.set(30_000);
    await assert.rejects(proxyRequest(p.port, 'POST', '/v1/messages'), { code: 'ECONNREFUSED' });
    assert.deepEqual(p.reasons, ['its lifetime ended']);
    assert.equal(up.seen.length, 2, 'nothing refused reached the upstream');
    assert.ok(up.seen.every((s) => s.apiKey === key));
    assert.deepEqual(p.refused, ['POST /v1/messages/count_tokens']);
  } finally {
    agent.destroy();
    p.close();
    await up.close();
  }
});

// The ways the proxy can first see its deadline reached while a request and
// its response are streaming through it.
const DEADLINE_SEEN_BY: readonly (readonly [string, (o: {
  time: VirtualTime; stream: StreamingRequest; up: StreamingUpstream; port: number;
}) => Promise<void>])[] = [
  ['its timer firing', async ({ time }) => time.fire()],
  ['more of the response arriving', async ({ up }) => up.push('chunk-2;')],
  ['the end of the response arriving', async ({ up }) => up.finish()],
  ['more of the request arriving', async ({ stream }) => stream.send('part-2;')],
  ['the end of the request arriving', async ({ stream }) => stream.end()],
  ['a new request arriving', async ({ port }) => {
    assert.equal((await proxyRequest(port, 'POST', '/v1/messages/count_tokens')).status, 403);
  }],
];

test('a request and its response in flight at the deadline are cut there, whatever sees it first, and nothing more of them is forwarded', async () => {
  for (const [seenBy, reach] of DEADLINE_SEEN_BY) {
    const up = await streamingModelApi();
    const time = virtualTime();
    const p = await moduleProxy(up.url, `asep-test-model-key-${randomUUID()}`, time, 60_000).catch(closing(up));
    try {
      const stream = streamingRequest(p.port);
      await until(`${seenBy}: the stream under way`,
        () => stream.text() === 'chunk-1;' && up.body.join('') === 'part-1;', 5_000);
      time.set(60_000);
      await reach({ time, stream, up, port: p.port });
      await within(p.expired, 5_000, `${seenBy}: the proxy ending`);
      // Whatever either side sends from now on goes nowhere.
      up.push('chunk-3;');
      stream.send('part-3;');
      const cut = await within(stream.closed, 5_000, `${seenBy}: the response being cut`);
      await within(up.closed, 5_000, `${seenBy}: the request to the upstream being cut`);
      assert.equal(cut.whole, false, `${seenBy}: the response was cut, not finished`);
      assert.equal(stream.text(), 'chunk-1;', `${seenBy}: nothing of the response past the deadline reached the agent`);
      assert.equal(up.body.join(''), 'part-1;', `${seenBy}: nothing of the request past the deadline reached the upstream`);
      assert.equal(p.expiredCalls(), 1, seenBy);
      assert.equal(p.server.listening, false, seenBy);
    } finally {
      p.close();
      await up.close();
    }
  }
});

test('a response that begins only after the deadline reaches the agent not at all', async () => {
  const up = await streamingModelApi({ holdHeaders: true });
  const time = virtualTime();
  const p = await moduleProxy(up.url, `asep-test-model-key-${randomUUID()}`, time, 60_000).catch(closing(up));
  try {
    const stream = streamingRequest(p.port);
    stream.end();
    await until('the request at the upstream', () => up.body.join('') === 'part-1;', 5_000);
    time.set(60_000);
    up.release();
    await within(p.expired, 5_000, 'the proxy ending');
    const cut = await within(stream.closed, 5_000, 'the request being cut');
    assert.equal(cut.whole, false);
    assert.equal(stream.status(), undefined, 'not even its status line reached the agent');
    assert.equal(stream.text(), '', 'nothing of the response reached the agent');
    assert.equal(p.expiredCalls(), 1);
  } finally {
    p.close();
    await up.close();
  }
});

test('the egress proxy serves nothing until it holds its credential, takes it only within its credential window, and ends at that window without one', async () => {
  const up = await fakeModelApi();
  const key = `asep-test-model-key-${randomUUID()}`;
  const opened: ModuleProxy[] = [];
  const start = async (time: VirtualTime) => {
    const p = await moduleProxy(up.url, key, time, 600_000, { credentialBy: 60_000, withholdKey: true });
    opened.push(p);
    return p;
  };
  try {
    // Before its credential: every request refused, nothing forwarded.
    const t1 = virtualTime();
    const waiting = await start(t1);
    assert.deepEqual(t1.scheduled, [60_000], 'its timer is set for the end of its credential window');
    const early = await proxyRequest(waiting.port, 'POST', '/v1/messages');
    assert.equal(early.status, 403);
    assert.match(early.body, /not serving yet: it holds no credential/);
    assert.equal(waiting.server.provideCredential(''), false, 'an empty credential is not one');
    // Within its window it takes the credential, once, and serves.
    t1.set(59_999);
    assert.equal(waiting.server.provideCredential(key), true);
    assert.equal(waiting.server.provideCredential(`${key}-another`), false, 'a second credential is refused');
    assert.deepEqual(t1.scheduled, [60_000, 600_000], 'holding its credential, it is timed by its deadline alone');
    assert.equal((await proxyRequest(waiting.port, 'POST', '/v1/messages')).status, 200);
    assert.deepEqual(up.seen.map((x) => x.apiKey), [key], 'only the request after the credential reached the upstream');
    assert.equal(waiting.expiredCalls(), 0);

    // No credential by the end of its window: its timer ends it.
    const t2 = virtualTime();
    const never = await start(t2);
    t2.set(60_000);
    t2.fire();
    await within(never.expired, 5_000, 'the proxy ending at its credential window');
    assert.deepEqual(never.reasons, ['no credential arrived within its credential window']);
    assert.equal(never.server.listening, false);
    assert.equal(never.server.provideCredential(key), false, 'and an ended proxy takes no credential');

    // A credential that arrives after its window — its timer late — is refused,
    // and ends it.
    const t3 = virtualTime();
    const late = await start(t3);
    t3.set(60_000);
    assert.equal(late.server.provideCredential(key), false);
    await within(late.expired, 5_000, 'the proxy ending at a late credential');
    assert.deepEqual(late.reasons, ['a credential arrived after its credential window']);
    await assert.rejects(proxyRequest(late.port, 'POST', '/v1/messages'), { code: 'ECONNREFUSED' });

    // A request after its window — its timer late — is refused, and ends it.
    const t4 = virtualTime();
    const lateRequest = await start(t4);
    t4.set(60_001);
    const refused = await proxyRequest(lateRequest.port, 'POST', '/v1/messages');
    assert.equal(refused.status, 403);
    assert.match(refused.body, /no longer serving: no credential arrived within its credential window/);
    await within(lateRequest.expired, 5_000, 'the proxy ending once it refused');
    assert.deepEqual(lateRequest.reasons, ['no credential arrived within its credential window']);
    assert.equal(up.seen.length, 1, 'nothing else reached the upstream');
  } finally {
    for (const p of opened) p.close();
    await up.close();
  }
});

// The reviewer's late-start model: 60 s of budget left at the spawn, so a 90 s
// lifetime; a 30 s readiness bound; the worker dies 1 s after the spawn, before
// the proxy reported ready, so it never sends the credential; the proxy starts
// 180 s after the spawn, its stdin still held open by its docker client, and
// the agent asks it 10 s later.
test('a proxy that starts after its starter died before it was ready never holds the credential: it forwards nothing and ends at its credential window', async () => {
  const { CREDENTIAL_WINDOW_MS } = await proxyModule();
  const up = await fakeModelApi();
  const time = virtualTime();
  // Its clock starts at its own start, 180 s after the spawn.
  const p = await moduleProxy(up.url, `asep-test-model-key-${randomUUID()}`, time, 90_000, {
    credentialBy: CREDENTIAL_WINDOW_MS, withholdKey: true,
  }).catch(closing(up));
  try {
    time.set(10_000);
    const asked = await proxyRequest(p.port, 'POST', '/v1/messages');
    assert.equal(asked.status, 403, 'the agent is refused');
    assert.match(asked.body, /it holds no credential/);
    time.set(CREDENTIAL_WINDOW_MS);
    time.fire();
    await within(p.expired, 5_000, 'the proxy ending at its credential window');
    assert.deepEqual(p.reasons, ['no credential arrived within its credential window']);
    assert.equal(up.seen.length, 0, 'nothing was ever forwarded');
  } finally {
    p.close();
    await up.close();
  }
});

// A docker client double for the provider's side of the proxy's start: its
// stdout is what the proxy says, its stdin what the provider writes.
function proxyClient(): { child: ChildProcess; say(text: string): void; written(): string } {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let written = '';
  stdin.on('data', (d: Buffer) => { written += d.toString('utf8'); });
  const child = Object.assign(new EventEmitter(), { pid: 4711, stdout, stdin }) as unknown as ChildProcess;
  return { child, say: (text) => stdout.write(text), written: () => written };
}

// Lets the streams deliver what was written to them.
const settle = () => new Promise((r) => setImmediate(r));

// The proxy's ready line as its docker client passes it on.
const READY = 'asep-egress-proxy listening 8080\n';

test('the provider sends the credential only on a ready line within its bound, checked when it arrives, and takes the start only on a serving line within it', async () => {
  // Its bound ends 3 s after the moment just before the spawn, on virtual time.
  const run = (client: ReturnType<typeof proxyClient>, time: VirtualTime, o: { readyBy?: number; spawnMs?: number } = {}) => {
    let result: string | undefined | null = null;
    // Settled within 5 s of real time, or the test fails rather than hangs.
    const done = within(proxyHandshake(client.child, {
      apiKey: 'the-key', readyBy: o.readyBy ?? 3_000, startedAt: 0, spawnMs: o.spawnMs ?? 2,
      now: time.now, schedule: time.schedule,
    }), 5_000, 'the handshake settling').then((r) => { result = r; });
    return { done, result: () => result };
  };
  // Never ready: its timer is set for its bound; at it, it fails, and nothing
  // was written.
  {
    const c = proxyClient();
    const t = virtualTime();
    const h = run(c, t);
    assert.deepEqual(t.scheduled, [3_000], 'its timer is set for its bound');
    t.set(3_000);
    t.fire();
    await h.done;
    assert.equal(h.result(), 'egress proxy did not become ready in time: waited 3000ms of its 3000ms bound '
      + '(pid 4711, spawn 2ms), with nothing on its stdout');
    c.say(READY);
    await settle();
    assert.equal(c.written(), '', 'no credential to a proxy that was not ready within its bound');
  }
  // Ready within its bound: the credential, once, and only on the whole line;
  // done once it confirms.
  {
    const c = proxyClient();
    const t = virtualTime();
    const h = run(c, t);
    t.set(1_200);
    c.say('asep-egress-proxy listening 80');
    await settle();
    assert.equal(c.written(), '', 'nothing on a partial line');
    c.say('80\n');
    await settle();
    assert.equal(c.written(), 'the-key\n');
    assert.equal(h.result(), null, 'not done before it confirms');
    c.say('asep-egress-proxy serving\n');
    await h.done;
    assert.equal(h.result(), undefined);
    assert.equal(c.written(), 'the-key\n', 'sent once');
  }
  // Ready 1 ms past its bound, and the reviewer's ready at 180 s, its timer
  // not yet fired either time: no credential, and the start fails.
  for (const at of [3_001, 180_000]) {
    const c = proxyClient();
    const t = virtualTime();
    const h = run(c, t);
    t.set(at);
    c.say(READY);
    await h.done;
    assert.equal(c.written(), '', `ready at ${at} ms: no credential`);
    assert.equal(h.result(), `egress proxy did not become ready in time: waited ${at}ms of its 3000ms bound `
      + '(pid 4711, spawn 2ms), with 33 bytes on its stdout');
  }
  // A spawn that took part of the bound leaves the timer what is left of it.
  {
    const c = proxyClient();
    const t = virtualTime();
    t.set(2_000);
    const h = run(c, t, { spawnMs: 2_000 });
    assert.deepEqual(t.scheduled, [3_000], 'its timer is set for what is left of its bound');
    t.set(3_000);
    t.fire();
    await h.done;
    assert.match(String(h.result()), /^egress proxy did not become ready in time: waited 3000ms of its 3000ms bound/);
  }
  // The reviewer's spawn of 45 s against a 30 s bound: the handshake starts
  // past its bound, its timer set for no time left, and a ready line then gets
  // nothing.
  {
    const c = proxyClient();
    const t = virtualTime();
    t.set(45_000);
    const h = run(c, t, { readyBy: 30_000, spawnMs: 45_000 });
    assert.deepEqual(t.scheduled, [45_000], 'no time left');
    c.say(READY);
    await h.done;
    assert.equal(c.written(), '', 'no credential after a spawn longer than the bound');
    assert.equal(h.result(), 'egress proxy did not become ready in time: waited 45000ms of its 30000ms bound '
      + '(pid 4711, spawn 45000ms), with 33 bytes on its stdout');
  }
  // Ready in time, but its confirmation 1 ms past its bound, the timer not yet
  // fired: the start fails, saying when the credential was sent.
  {
    const c = proxyClient();
    const t = virtualTime();
    const h = run(c, t);
    t.set(2_900);
    c.say(READY);
    await settle();
    assert.equal(c.written(), 'the-key\n');
    t.set(3_001);
    c.say('asep-egress-proxy serving\n');
    await h.done;
    assert.equal(h.result(), 'egress proxy did not confirm its credential in time: waited 3001ms of its 3000ms bound '
      + '(pid 4711, spawn 2ms), its credential sent at +2900ms');
  }
  // Ready, but no confirmation by its bound: its timer fails it.
  {
    const c = proxyClient();
    const t = virtualTime();
    const h = run(c, t);
    t.set(500);
    c.say(READY);
    await settle();
    t.set(3_000);
    t.fire();
    await h.done;
    assert.equal(h.result(), 'egress proxy did not confirm its credential in time: waited 3000ms of its 3000ms bound '
      + '(pid 4711, spawn 2ms), its credential sent at +500ms');
  }
  // Anything but its two lines, whole and in their order, fails the start: a
  // line that only holds the ready line, another port, serving before ready,
  // ready again, a line that only begins with serving.
  const ready = JSON.stringify(READY.trim());
  const serving = '"asep-egress-proxy serving"';
  for (const [said, written, why] of [
    ['note: asep-egress-proxy listening 8080\n', '', `"note: asep-egress-proxy listening 8080" before it was ready, not ${ready}`],
    ['asep-egress-proxy listening 9999\n', '', `"asep-egress-proxy listening 9999" before it was ready, not ${ready}`],
    ['asep-egress-proxy serving\n', '', `${serving} before it was ready, not ${ready}`],
    [`${READY}${READY}`, 'the-key\n', `${ready} before it confirmed its credential, not ${serving}`],
    [`${READY}asep-egress-proxy serving soon\n`, 'the-key\n',
      `"asep-egress-proxy serving soon" before it confirmed its credential, not ${serving}`],
  ] as const) {
    const c = proxyClient();
    const h = run(c, virtualTime());
    c.say(said);
    await h.done;
    assert.equal(h.result(), `egress proxy said ${why}`, JSON.stringify(said));
    assert.equal(c.written(), written, JSON.stringify(said));
  }
  // Its client gone before it is ready, or before it confirms.
  {
    const c = proxyClient();
    const h = run(c, virtualTime());
    c.child.emit('close', 1);
    await h.done;
    assert.equal(h.result(), 'egress proxy exited 1 before it was ready');
    assert.equal(c.written(), '');
    const d = proxyClient();
    const g = run(d, virtualTime());
    d.say(READY);
    await settle();
    d.child.emit('close', 0);
    await g.done;
    assert.equal(g.result(), 'egress proxy exited 0 before it confirmed its credential');
    const e = proxyClient();
    const f = run(e, virtualTime());
    e.child.emit('error', new Error('spawn docker ENOENT'));
    await f.done;
    assert.equal(f.result(), 'egress proxy could not start: spawn docker ENOENT');
  }
});

test('a proxy that reports ready past its bound never holds the credential, so the window after worker death holds from the spawn', async () => {
  // The reviewer's model: 600 s of budget left at the spawn, so a 630 s
  // lifetime; a 30 s bound. Two clocks: the provider's, from just before the
  // spawn, and the proxy's own, from its start. What the provider writes on the
  // client's stdin reaches the proxy as its credential.
  const { CREDENTIAL_WINDOW_MS } = await proxyModule();
  const up = await fakeModelApi();
  const key = `asep-test-model-key-${randomUUID()}`;
  const opened: ModuleProxy[] = [];
  const attempt = async (startsAt: number) => {
    const provider = virtualTime();
    const proxy = virtualTime();
    const p = await moduleProxy(up.url, key, proxy, 630_000, { credentialBy: CREDENTIAL_WINDOW_MS, withholdKey: true });
    opened.push(p);
    const c = proxyClient();
    const taken: boolean[] = [];
    c.child.stdin!.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n')) if (line !== '') taken.push(p.server.provideCredential(line));
    });
    const started = proxyHandshake(c.child, {
      apiKey: key, readyBy: 30_000, startedAt: 0, spawnMs: 2, now: provider.now, schedule: provider.schedule,
    });
    // The proxy starts, and says it is ready, at `startsAt`, the provider's
    // timer not yet fired.
    provider.set(startsAt);
    c.say(READY);
    await settle();
    return { p, c, proxy, taken, started, say: (text: string) => c.say(text) };
  };
  try {
    // Ready at 180 s: no credential is written, the start fails; the worker
    // dies at 200 s. At 190 s and at 700 s from the spawn the agent asks: the
    // proxy holds nothing, forwards nothing, and ends at its credential window.
    const late = await attempt(180_000);
    assert.match(String(await within(late.started, 5_000, 'the start failing')),
      /^egress proxy did not become ready in time: waited 180000ms of its 30000ms bound/);
    assert.deepEqual(late.taken, [], 'no credential reached the proxy');
    late.proxy.set(10_000);
    const at190 = await proxyRequest(late.p.port, 'POST', '/v1/messages');
    assert.equal(at190.status, 403);
    assert.match(at190.body, /it holds no credential/);
    late.proxy.set(CREDENTIAL_WINDOW_MS);
    late.proxy.fire();
    await within(late.p.expired, 5_000, 'the proxy ending at its credential window');
    assert.deepEqual(late.p.reasons, ['no credential arrived within its credential window']);
    late.proxy.set(520_000);
    await assert.rejects(proxyRequest(late.p.port, 'POST', '/v1/messages'), { code: 'ECONNREFUSED' }, 'nothing answers at 700 s');

    // Ready at 29 s, within its bound: the credential, and the proxy serves
    // until its own lifetime ends at 29 s + 630 s = 659 s from the spawn, within
    // the published min(remaining budget + grace, maximum) + bound = 660 s.
    const inTime = await attempt(29_000);
    assert.deepEqual(inTime.taken, [true], 'the credential reached the proxy');
    inTime.say('asep-egress-proxy serving\n');
    assert.equal(await within(inTime.started, 5_000, 'the start completing'), undefined);
    inTime.proxy.set(630_000 - 1);
    assert.equal((await proxyRequest(inTime.p.port, 'POST', '/v1/messages')).status, 200, 'served at 659 s less 1 ms');
    inTime.proxy.set(630_000);
    assert.equal((await proxyRequest(inTime.p.port, 'POST', '/v1/messages')).status, 403, 'refused at 659 s');
    await within(inTime.p.expired, 5_000, 'the proxy ending at its lifetime');
    assert.equal(up.seen.length, 1, 'only the request within its lifetime was forwarded');
  } finally {
    for (const p of opened) p.close();
    await up.close();
  }
});

test('a proxy process given no credential reports ready, refuses every request, and exits at its credential window', async () => {
  // As when its starter died before it was ready while something — its docker
  // client — still holds its stdin open: the credential never comes.
  const up = await fakeModelApi();
  const windowMs = 3_000;
  const proxy = await startProxy(up.url, null, { credentialWindowMs: windowMs, readyWithinMs: windowMs }).catch(closing(up));
  try {
    const refused = await proxyRequest(proxy.port, 'POST', '/v1/messages');
    assert.equal(refused.status, 403);
    assert.match(refused.body, /not serving yet: it holds no credential/);
    const bound = PROXY_EXIT_BOUND_MS + SCHEDULING_ALLOWANCE_MS;
    const exited = await within(proxy.exited, Math.max(1, proxy.readyAt + windowMs + bound + 5_000 - performance.now()),
      'the proxy exiting at its credential window');
    assert.ok(exited.at >= proxy.spawnedAt + windowMs,
      `it exited ${Math.round(proxy.spawnedAt + windowMs - exited.at)} ms before its credential window ended`);
    const late = Math.round(exited.at - proxy.readyAt - windowMs);
    assert.ok(late <= bound, `it exited up to ${late} ms after its credential window; the bound is ${bound} ms`);
    assert.equal(exited.code, 0);
    assert.match(proxy.log(), /asep-egress-proxy: stopping: no credential arrived within its credential window/);
    assert.equal(up.seen.length, 0, 'nothing was forwarded');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

// How long the proxies in the process lifetime test live: long enough to start
// and serve on a loaded host, short enough to wait out.
const PROXY_TEST_LIFETIME_MS = 8_000;
// How far the clock double below moves a proxy's wall clock, and how soon
// after it is loaded.
const CLOCK_MOVE_MS = 60 * 60_000;
const CLOCK_MOVES_AFTER_MS = 200;

// Loaded into a proxy process with --import. From ASEP_TEST_CLOCK_MOVES_AFTER_MS
// after it is loaded, the process's wall clock — Date.now() and new Date() —
// reads ASEP_TEST_CLOCK_MOVE_MS off, as it would were the system clock set
// then. The monotonic clock is left alone, as setting the system clock leaves
// it.
const CLOCK_MOVE = `
const RealDate = Date;
const move = Number(process.env.ASEP_TEST_CLOCK_MOVE_MS);
const after = Number(process.env.ASEP_TEST_CLOCK_MOVES_AFTER_MS);
const loaded = RealDate.now();
const wall = () => {
  const t = RealDate.now();
  return t - loaded >= after ? t + move : t;
};
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(wall());
    else super(...a);
  }
  static now() {
    return wall();
  }
};
`;

test('the egress proxy process ends at its lifetime on its own clock, cutting what is open, whichever way the wall clock is set', async () => {
  const up = await streamingModelApi();
  const dir = await mkdtemp(join(tmpdir(), 'egress-proxy-clock-'));
  const clockMove = join(dir, 'clock-move.mjs');
  await writeFile(clockMove, CLOCK_MOVE);
  const bound = PROXY_EXIT_BOUND_MS + SCHEDULING_ALLOWANCE_MS;
  try {
    await Promise.all([-CLOCK_MOVE_MS, CLOCK_MOVE_MS].map(async (move) => {
      const way = move < 0 ? 'set back' : 'set forward';
      const proxy = await startProxy(up.url, `asep-test-model-key-${randomUUID()}`, {
        lifetimeMs: PROXY_TEST_LIFETIME_MS, readyWithinMs: PROXY_TEST_LIFETIME_MS,
        nodeArgs: ['--import', pathToFileURL(clockMove).href],
        env: {
          ...process.env,
          ASEP_TEST_CLOCK_MOVE_MS: String(move), ASEP_TEST_CLOCK_MOVES_AFTER_MS: String(CLOCK_MOVES_AFTER_MS),
        },
      });
      try {
        // Once its wall clock has moved it still serves, and its access log
        // shows the moved clock.
        await new Promise((r) => setTimeout(r, Math.max(0, proxy.readyAt + CLOCK_MOVES_AFTER_MS - performance.now())));
        assert.equal((await proxyRequest(proxy.port, 'POST', '/v1/messages/count_tokens')).status, 200,
          `clock ${way}: it serves before its lifetime ends`);
        const served = /(\S+) POST \/v1\/messages\/count_tokens -> 200/;
        await until(`clock ${way}: the request in its access log`, () => served.test(proxy.log()), 5_000);
        const logged = served.exec(proxy.log())?.[1];
        assert.ok(logged !== undefined && Math.abs(Date.parse(logged) - (Date.now() + move)) < 60_000,
          `clock ${way}: the proxy's wall clock moved (it logged ${logged})`);
        // A stream under way when its lifetime ends.
        const stream = streamingRequest(proxy.port);
        await until(`clock ${way}: the stream under way`, () => stream.text() === 'chunk-1;', 5_000);
        const exited = await within(proxy.exited,
          Math.max(1, proxy.readyAt + PROXY_TEST_LIFETIME_MS + bound + 5_000 - performance.now()),
          `clock ${way}: the proxy exiting at the end of its lifetime`);
        const cut = await within(stream.closed, bound, `clock ${way}: the stream being cut`);
        assert.ok(exited.at >= proxy.spawnedAt + PROXY_TEST_LIFETIME_MS,
          `clock ${way}: it exited ${Math.round(proxy.spawnedAt + PROXY_TEST_LIFETIME_MS - exited.at)} ms before its lifetime ended`);
        const late = Math.round(exited.at - proxy.readyAt - PROXY_TEST_LIFETIME_MS);
        assert.ok(late <= bound,
          `clock ${way}: it exited up to ${late} ms after its lifetime ended; the bound is ${PROXY_EXIT_BOUND_MS} ms + ${SCHEDULING_ALLOWANCE_MS} ms`);
        assert.equal(exited.code, 0);
        assert.match(proxy.log(), /asep-egress-proxy: stopping: its lifetime ended/);
        assert.equal(cut.whole, false, `clock ${way}: the stream was cut, not finished`);
        assert.ok(cut.at <= proxy.readyAt + PROXY_TEST_LIFETIME_MS + bound, `clock ${way}: the stream was cut late`);
        assert.equal(stream.text(), 'chunk-1;');
        await assert.rejects(proxyRequest(proxy.port, 'POST', '/v1/messages'), { code: 'ECONNREFUSED' },
          `clock ${way}: nothing answers on its port any more`);
      } finally {
        await proxy.stop();
      }
    }));
  } finally {
    await up.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A starter for the proxy, as a process of its own: once the proxy reports
// ready it hands it the credential and keeps its stdin open, sends the proxy's
// stderr to a file, prints the proxy's pid and port once it serves, and runs
// until it is killed or its own stdin — its link to the test — closes.
const PROXY_STARTER = `
const { spawn } = require('node:child_process');
const { openSync } = require('node:fs');
const [asset, upstream, lifetimeMs, logPath] = process.argv.slice(2);
const proxy = spawn(process.execPath, [asset, '--listen', '127.0.0.1:0', '--upstream', upstream, '--lifetime-ms', lifetimeMs], {
  stdio: ['pipe', 'pipe', openSync(logPath, 'a')],
  env: { PATH: process.env.PATH, ASEP_PROCESS_TOKEN: process.env.ASEP_TEST_PROXY_TOKEN },
});
let out = '';
let sent = false;
proxy.stdout.on('data', (d) => {
  out += d;
  const m = /listening (\\d+)/.exec(out);
  if (m && !sent) {
    sent = true;
    proxy.stdin.write(process.env.ASEP_TEST_PROXY_KEY + '\\n');
  }
  if (m && /serving/.test(out)) process.stdout.write(JSON.stringify({ pid: proxy.pid, port: Number(m[1]) }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

// When the process `pid` — not a child of this one — was first seen gone,
// looking every 10 ms for at most `ms`; undefined if it was still there.
async function goneWithin(pid: number, ms: number): Promise<number | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return Date.now();
      throw err;
    }
    if (Date.now() > end) return undefined;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the egress proxy stops serving and exits once the process that started it is killed', async () => {
  const up = await fakeModelApi();
  const dir = await mkdtemp(join(tmpdir(), 'egress-proxy-starter-'));
  const logPath = join(dir, 'proxy.log');
  const starterPath = join(dir, 'starter.cjs');
  await writeFile(starterPath, PROXY_STARTER);
  // The proxy's own token, which its starter hands it, so that it can be
  // recorded too.
  const proxyToken = randomUUID();
  const { child: starter, entry: starterEntry } = spawnRecorded(process.execPath, [
    starterPath, PROXY_ASSET, up.url, String(10 * 60_000), logPath,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '', ASEP_TEST_PROXY_KEY: `asep-test-model-key-${randomUUID()}`,
      ASEP_TEST_PROXY_TOKEN: proxyToken,
    },
  }) as { child: ChildProcessWithoutNullStreams; entry: { pid: number } | undefined };
  let proxyEntry: { pid: number } | undefined;
  try {
    const started = await within(new Promise<{ pid: number; port: number }>((resolve, reject) => {
      let out = '';
      let err = '';
      starter.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
      starter.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
        const line = out.split('\n').find((l) => l.startsWith('{') && l.endsWith('}'));
        if (line !== undefined) resolve(JSON.parse(line) as { pid: number; port: number });
      });
      starter.on('close', (code) => reject(new Error(`the starter exited ${code}: ${err}`)));
    }), 30_000, 'the proxy becoming ready under its starter');
    proxyEntry = identityOf(started.pid, { token: proxyToken });
    register(proxyEntry);
    assert.equal((await proxyRequest(started.port, 'POST', '/v1/messages')).status, 200, 'it serves while its starter lives');

    const killedAt = Date.now();
    starter.kill('SIGKILL');
    const bound = PROXY_EXIT_BOUND_MS + SCHEDULING_ALLOWANCE_MS;
    const goneAt = await goneWithin(started.pid, bound + 5_000);
    assert.ok(goneAt !== undefined && goneAt - killedAt <= bound,
      `the proxy ${goneAt === undefined ? 'was still running' : `exited ${goneAt - killedAt} ms`} after its starter `
      + `was killed; the bound is ${PROXY_EXIT_BOUND_MS} ms + ${SCHEDULING_ALLOWANCE_MS} ms`);
    assert.match(readFileSync(logPath, 'utf8'), /asep-egress-proxy: stopping: its parent link closed/);
    await assert.rejects(proxyRequest(started.port, 'POST', '/v1/messages'), { code: 'ECONNREFUSED' },
      'nothing answers on its port any more');
    assert.equal(up.seen.length, 1);
  } finally {
    for (const entry of [starterEntry, proxyEntry]) {
      if (entry !== undefined && shownGone(endProcess(entry))) unregister(entry.pid);
    }
    await up.close();
    await rm(dir, { recursive: true, force: true });
  }
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
      const obs = await (await h.provider(c.scenario)).execute(request(h));
      assert.equal(obs.status, c.status, obs.knownLimitations.join('; '));
      assert.match(obs.knownLimitations.join(' '), c.match);
      // A violation the stream shows stops the agent at once; anything else is
      // judged once the agent exited on its own. Either way nothing waited for
      // the wall clock, and the container went within the product's bound.
      if (h.lifecycle.some((e) => e.phase === 'stop')) assertStoppedInTime(h.lifecycle, 'violation');
      else assertExitedAndRemoved(h.lifecycle);
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
    assert.equal(denied.status, 'AGENT_DONE', showObservation(denied));
    assert.ok(denied.knownLimitations.includes('permission denied: Bash'));
    const notices = await (await h.provider('notices')).execute(request(h));
    assert.equal(notices.status, 'AGENT_DONE', notices.knownLimitations.join('; '));
    assert.ok(notices.knownLimitations.includes('model API retried 1 time(s)'));
    const claims = await (await h.provider('claims-commit')).execute(request(h));
    assert.equal(claims.status, 'AGENT_DONE', showObservation(claims));
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
    const obs = await (await h.provider('tool-flood')).execute(
      request(h, { budget: { ...BUDGET, maxToolCalls: 3 } }),
    );
    assert.equal(obs.status, 'BUDGET_EXHAUSTED', showObservation(obs, h.lifecycle));
    assert.match(obs.knownLimitations.join(' '), /tool-call budget of 3 exceeded/);
    assert.equal(obs.usage.toolCalls, 4, 'stopped at the first call over the budget');
    // Stopped by the tool-call budget, not the wall clock, and removed in time.
    assertStoppedInTime(h.lifecycle, 'violation');
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('G3: a hung agent is removed by the wall-clock budget, with no external abort', async () => {
  const h = await harness();
  try {
    const obs = await (await h.provider('hang')).execute(
      request(h, { budget: { ...BUDGET, maxWallClockMinutes: SHORT_WALL_CLOCK_MINUTES } }),
    );
    assert.equal(obs.status, 'BUDGET_EXHAUSTED', obs.knownLimitations.join('; '));
    assert.match(obs.knownLimitations.join(' '), /wall-clock/);
    // Stopped at its deadline — measured from the deadline, not from a start
    // that includes the setup — and removed within the product's stop bound.
    assertStoppedInTime(h.lifecycle, 'timeout', wallClockDue(h.lifecycle));
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
    const p = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
    // Cancelled once the agent runs, so the setup before it is not measured.
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    const cancelledAt = monotonicNow();
    ac.abort();
    const obs = await p;
    assert.equal(obs.status, 'BLOCKED', showObservation(obs));
    assert.match(obs.knownLimitations.join(' '), /cancelled during execution/);
    // Stopped when the cancellation was delivered, and removed in time.
    assertStoppedInTime(h.lifecycle, 'aborted', cancelledAt);
    assertTornDown(h);

    const before = h.invocations().length;
    const pre = new AbortController();
    pre.abort();
    const blocked = await (await h.provider('hang')).execute(request(h, { signal: pre.signal }));
    assert.equal(blocked.status, 'BLOCKED', showObservation(blocked));
    assert.equal(h.invocations().length, before, 'nothing was started');
  } finally {
    await h.close();
  }
});

// The provider's moments are read from a monotonic clock: a wall clock set
// back while an attempt runs (as an NTP correction can) moves Date.now() but
// none of the intervals the provider's timers bound.
test('G3: a wall clock set back during an attempt does not move its timed moments', async () => {
  const h = await harness();
  const wall = Date.now;
  try {
    const ac = new AbortController();
    const p = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    Date.now = () => wall() - 60_000;
    const cancelledAt = monotonicNow();
    ac.abort();
    const obs = await p;
    assert.equal(obs.status, 'BLOCKED', obs.knownLimitations.join('; '));
    assertStoppedInTime(h.lifecycle, 'aborted', cancelledAt);
    assert.ok(h.lifecycle.every((e, i) => i === 0 || e.at >= h.lifecycle[i - 1]!.at), showTimeline(h.lifecycle));
    assertTornDown(h);
  } finally {
    Date.now = wall;
    await h.close();
  }
});

// The stop path's bound is the product's own: a `docker kill` that never
// answers is cut at the docker-call timeout, the client is killed and the
// container removed by name — all within AGENT_STOP_BOUND_MS of the stop.
test('G3: a docker kill that never answers is cut at its bound, and the agent is still removed in time', async () => {
  const h = await harness({ hangKill: true });
  try {
    const ac = new AbortController();
    const p = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    const cancelledAt = monotonicNow();
    ac.abort();
    const obs = await p;
    assert.equal(obs.status, 'BLOCKED', obs.knownLimitations.join('; '));
    assertStoppedInTime(h.lifecycle, 'aborted', cancelledAt);
    const killedAfter = phaseOf(h.lifecycle, 'agent-killed').at - phaseOf(h.lifecycle, 'stop').at;
    assert.ok(killedAfter >= DOCKER_CALL_TIMEOUT_MS - 50 && killedAfter <= DOCKER_CALL_TIMEOUT_MS + SCHEDULING_ALLOWANCE_MS,
      `the hung kill was cut ${killedAfter} ms after the stop, not at its ${DOCKER_CALL_TIMEOUT_MS} ms bound:\n${showTimeline(h.lifecycle)}`);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

// A killed `docker run` client does not stop its container. The fake docker
// client models that: its containers are detached host processes that outlive a
// killed client. The real-daemon proof is agent-sandbox.itest.ts.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function containerRecords(h: Harness): Record<string, unknown>[] {
  const d = join(h.state, 'containers');
  return existsSync(d) ? readdirSync(d).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Record<string, unknown>) : [];
}

function runClientPid(h: Harness, role: string): number {
  const line = readFileSync(join(h.dir, 'client-pids'), 'utf8').split('\n')
    .find((l) => / run /.test(` ${l.split(' ').slice(1).join(' ')} `) && l.includes(`asep.role=${role}`));
  assert.ok(line, `a ${role} client was started`);
  return Number(line.split(' ')[0]);
}

// How long a test waits for a container it started to appear. Under load
// average 60–120 on 8 CPUs the agent container started within 2.4 s; the bound
// only matters when one never comes, so it is generous.
const START_WAIT_MS = 60_000;

async function until(what: string, ok: () => boolean, ms = START_WAIT_MS): Promise<void> {
  const end = monotonicNow() + ms;
  while (!ok()) {
    if (monotonicNow() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('G3: killing the agent and proxy docker clients mid-run leaves no container or network behind', async () => {
  const h = await harness();
  try {
    const running = (await h.provider('hang')).execute(request(h));
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    const pids = containerRecords(h).map((c) => c['pid'] as number);
    assert.equal(pids.length, 2, 'the proxy and the agent are running');
    process.kill(runClientPid(h, 'agent'), 'SIGKILL');
    process.kill(runClientPid(h, 'egress-proxy'), 'SIGKILL');
    const obs = await running;
    assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
    assertTornDown(h);
    await until('every container process to end', () => pids.every((p) => !alive(p)), 5_000);
  } finally {
    await h.close();
  }
});

test('G3: an attempt whose containers cannot be shown removed fails closed', async () => {
  const h = await harness({ refuseRemoval: true });
  const records: Record<string, unknown>[] = [];
  // Stopped by a cancellation once it runs, so the test does not depend on how
  // long the setup before the agent takes.
  const ac = new AbortController();
  const running = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
  try {
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    records.push(...containerRecords(h));
    ac.abort();
    const obs = await running;
    assert.equal(obs.status, 'FAILED', 'not BLOCKED: a container may still be running beside the worktree');
    assert.match(obs.summary, /could not be shown removed/);
    assert.match(obs.knownLimitations.join(' '), /labelled asep\.attempt=.* could not be shown removed/);
    // What the daemon answered to the proxy's kill is kept, with the call.
    assert.match(obs.knownLimitations.join(' '), new RegExp('teardown: egress proxy asep-egress-\\S+ not killed: '
      + 'Error response from daemon: removal refused \\(kill asep-egress-\\S+ at \\+0ms: exit 1 after \\d+ms '
      + '\\(pid \\d+, spawn \\d+ms, bound 30000ms\\)\\)'));
  } finally {
    ac.abort();
    // The attempt's own teardown restores its input directory; let it finish
    // before the harness removes the directory under it.
    await running.catch(() => undefined);
    // By what identifies each, never by a pid alone.
    for (const c of records) endProcess(c);
    await h.close();
  }
});

// The removal is reported only once the daemon shows the container gone:
// `docker inspect` answers that no such container exists.

test('G3: the agent is reported removed only once docker inspect shows it gone', async () => {
  const h = await harness();
  try {
    // What the fake docker had been asked when the removal was reported: read
    // at that moment, so the order needs no clock shared between processes.
    let askedByThen: string[][] = [];
    const observe = (e: AgentLifecycleEvent): void => {
      h.lifecycle.push(e);
      if (e.phase === 'agent-removed') askedByThen = argvOf(h.invocations());
    };
    const obs = await (await h.provider('ok', {}, undefined, observe)).execute(request(h));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    const agentCalls = askedByThen.filter((a) => String(a.at(-1)).startsWith('asep-agent-'));
    const rmAt = agentCalls.findIndex((a) => a[0] === 'rm');
    const shown = agentCalls.slice(rmAt + 1).find((a) => a[0] === 'inspect');
    assert.ok(rmAt >= 0 && shown !== undefined, 'by the time it was reported removed, the rm was followed by an inspect');
    assert.deepEqual(shown, ['inspect', '--type', 'container', '--format', '{{.Id}}', agentCalls[rmAt]![2]]);
    assertExitedAndRemoved(h.lifecycle);
  } finally {
    await h.close();
  }
});

test('G3: an agent removal that fails yet leaves the container gone is shown gone, and the attempt stands', async () => {
  const h = await harness({ agentRmErrs: true });
  try {
    const ac = new AbortController();
    const running = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    // The client dies, so the container outlives it until it is removed.
    process.kill(runClientPid(h, 'agent'), 'SIGKILL');
    const obs = await running;
    assert.doesNotMatch(obs.knownLimitations.join(' '), /could not be shown removed/);
    assertExitedAndRemoved(h.lifecycle);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('G3: an agent the daemon keeps while answering its removal with success is never reported removed', async () => {
  const h = await harness({ keepAgent: true });
  const records: Record<string, unknown>[] = [];
  const ac = new AbortController();
  const running = (await h.provider('hang')).execute(request(h, { signal: ac.signal }));
  try {
    await until('the agent container to start', () => containerRecords(h).some((c) => String(c['name']).startsWith('asep-agent-')));
    records.push(...containerRecords(h));
    ac.abort();
    const obs = await running;
    assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
    assert.match(obs.knownLimitations.join(' '),
      /container asep-agent-\S+ could not be shown removed in time: docker inspect still shows it/);
    // The stop's own kill failed, and what the daemon said is kept.
    assert.match(obs.knownLimitations.join(' '), new RegExp('teardown: agent asep-agent-\\S+ not killed at its stop: '
      + 'Error response from daemon: cannot kill \\(kill asep-agent-\\S+ at \\+0ms: exit 1 after \\d+ms '
      + '\\(pid \\d+, spawn \\d+ms, bound 30000ms\\)\\)'));
    assert.deepEqual(h.lifecycle.filter((e) => e.phase === 'agent-removed'), [], showTimeline(h.lifecycle));
    assert.throws(() => assertStoppedInTime(h.lifecycle, 'aborted'), /exactly one 'agent-removed' moment/);
  } finally {
    ac.abort();
    await running.catch(() => undefined);
    // By what identifies each, never by a pid alone.
    for (const c of records) endProcess(c);
    await h.close();
  }
});

// The removal path on virtual time, as the provider composes it: the removal
// deadline (agentRemovalDeadline), the removal shown by inspect
// (removeContainerShownGone), and the 'agent-removed' moment reported only
// when it was shown. The daemon answers each removal at once with "already in
// progress", or slowly, while inspect shows the container until `goneAt`.
async function removalOnVirtualTime(goneAt: number, rmMs: number): Promise<Timeline> {
  let now = 0;
  const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const docker: DockerCall = async (argv, opts = {}) => {
    const cost = argv[0] === 'rm' ? rmMs : 20;
    const cut = opts.timeoutMs ?? DOCKER_CALL_TIMEOUT_MS;
    if (cost > cut) {
      now += cut;
      return { code: null, stdout: '', stderr: '' };
    }
    now += cost;
    if (argv[0] === 'rm') {
      return { code: 1, stdout: '', stderr: 'Error response from daemon: removal of container x is already in progress' };
    }
    return now >= goneAt
      ? { code: 1, stdout: '', stderr: `Error response from daemon: No such container: ${String(argv.at(-1))}` }
      : { code: 0, stdout: 'f'.repeat(64), stderr: '' };
  };
  const moment = (phase: AgentLifecyclePhase, at: number, extra: Partial<AgentLifecycleEvent> = {}): AgentLifecycleEvent =>
    ({ phase, attemptId: ATTEMPT, at, ...extra });
  // Stopped at 0; the kill was cut at its bound and the client SIGKILLed then.
  const lifecycle: AgentLifecycleEvent[] = [
    moment('started', -5_000, { deadline: 0 }), moment('agent-started', -4_000),
    moment('stop', 0, { reason: 'timeout' }), moment('agent-killed', DOCKER_CALL_TIMEOUT_MS),
    moment('agent-exited', DOCKER_CALL_TIMEOUT_MS),
  ];
  now = DOCKER_CALL_TIMEOUT_MS;
  const until = agentRemovalDeadline({ stoppedAt: 0, exitedAt: DOCKER_CALL_TIMEOUT_MS });
  const left = await removeContainerShownGone(docker, 'asep-agent-x', until, { clock, attempts: 1_000 });
  assert.ok(now <= until, `no removal call outlives the deadline: at ${now} ms, deadline ${until} ms`);
  if (left === undefined) lifecycle.push(moment('agent-removed', now));
  lifecycle.push(moment('torn-down', now + 10));
  return lifecycle;
}

test('G3: an agent removal the daemon cannot show within its bound fails the attempt at the bound', { timeout: 120_000 }, async () => {
  const h = await harness({ hangInspect: true });
  try {
    const obs = await (await h.provider('ok')).execute(request(h));
    assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
    assert.match(obs.knownLimitations.join(' '), /container asep-agent-\S+ could not be shown removed in time/);
    // Call by call: the rm answered (the container went with its client), the
    // inspect was killed by its caller at its bound.
    assert.match(obs.knownLimitations.join(' '), new RegExp('docker inspect failed: killed by SIGKILL at its bound; '
      + 'calls: rm -f at \\+0ms: exit \\d+ after \\d+ms \\(pid \\d+, spawn \\d+ms, bound \\d+ms\\); '
      + 'inspect --type at \\+\\d+ms: signal SIGKILL after \\d+ms \\(pid \\d+, spawn \\d+ms, bound \\d+ms, cut at \\d+ms\\)'));
    assert.deepEqual(h.lifecycle.filter((e) => e.phase === 'agent-removed'), [], showTimeline(h.lifecycle));
    // The removal was given its whole bound. The teardown after it (proxy,
    // label sweeps, network) is not bounded by the product and slows with
    // host load, so "no more than its bound" is held by this test's own
    // timeout here, and exactly by the deadline and virtual-time tests below.
    const gaveUp = phaseOf(h.lifecycle, 'torn-down').at - phaseOf(h.lifecycle, 'agent-exited').at;
    assert.ok(gaveUp >= AGENT_REMOVAL_BOUND_MS - 50,
      `torn down ${gaveUp} ms after the agent's client ended:\n${showTimeline(h.lifecycle)}`);
  } finally {
    await h.close();
  }
});

// Only "no such container" from inspect shows the agent gone. An inspect that
// fails with another error — the daemon's socket refused, no daemon, an error
// of its own — says nothing about the container: the attempt fails and the
// agent is never reported removed.
const INSPECT_ERRORS = [
  ['permission denied', 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: permission denied'],
  ['daemon unreachable', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'],
  ['an unrelated error', 'Error response from daemon: i/o timeout'],
] as const;
for (const [name, said] of INSPECT_ERRORS) {
  test(`G3: an agent whose inspect fails with ${name} is never reported removed, and the attempt fails`, { timeout: 120_000 }, async () => {
    const h = await harness({ inspectErr: said });
    try {
      const obs = await (await h.provider('ok')).execute(request(h));
      assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
      assert.ok(obs.knownLimitations.join(' ').includes(`could not be shown removed in time: docker inspect failed: ${said}`),
        obs.knownLimitations.join('; '));
      assert.deepEqual(h.lifecycle.filter((e) => e.phase === 'agent-removed'), [], showTimeline(h.lifecycle));
    } finally {
      await h.close();
    }
  });
}

// A create the client cannot confirm may still have been made: the network is
// named and labelled before it is asked for and swept by both whatever the
// answer.
const netCreateCases = {
  'errs-after': 'errs after the daemon made the network',
  'hangs-after': 'times out after the daemon made the network',
  refused: 'the daemon refused',
} as const;
for (const netCreate of ['errs-after', 'hangs-after', 'refused'] as const) {
  test(`a network create that ${netCreateCases[netCreate]} leaves nothing behind and no false teardown note`, { timeout: 120_000 }, async () => {
    const h = await harness({ netCreate });
    try {
      const obs = await (await h.provider('ok')).execute(request(h));
      assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
      assert.match(obs.summary, /did not start: docker network create failed/);
      // How the call ended and how long it took, against its bound.
      assert.match(obs.summary, {
        'hangs-after': /its client was cut at the docker-call timeout: network create at \+0ms: signal SIGKILL after \d+ms \(pid \d+, spawn \d+ms, bound 30000ms, cut at \d+ms\)/,
        'errs-after': /lost the answer \(network create at \+0ms: exit 1 after \d+ms \(pid \d+, spawn \d+ms, bound 30000ms\)\)/,
        refused: /refused \(network create at \+0ms: exit 1 after \d+ms \(pid \d+, spawn \d+ms, bound 30000ms\)\)/,
      }[netCreate]);
      assert.deepEqual(h.lifecycle.map((e) => e.phase), ['started', 'torn-down'], 'nothing past the network was started');
      // The client's own log: the refusing daemon answers before the fake records the call.
      const asked = readFileSync(join(h.dir, 'client-pids'), 'utf8').split('\n')
        .find((l) => / network create /.test(` ${l.split(' ').slice(1).join(' ')} `))!;
      const net = asked.trim().split(' ').at(-1)!;
      assert.match(net, /^asep-agent-net-/);
      assert.ok(argvOf(h.invocations()).some((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === net), 'removed by its name');
      assert.ok(argvOf(h.invocations()).some((a) => a[0] === 'network' && a[1] === 'ls' && a.includes(`label=asep.attempt=${ATTEMPT}`)),
        'and swept by its label');
      assert.doesNotMatch(obs.knownLimitations.join(' '), /could not be shown removed|not removed/);
      assertTornDown(h);
    } finally {
      await h.close();
    }
  });
}

// A proxy that never becomes ready fails the attempt at its bound, saying how
// long it was waited for against that bound and what its client had written.
test('an egress proxy that never becomes ready fails the attempt, with how long it was waited for', { timeout: 120_000 }, async () => {
  const h = await harness({ proxyHangs: true });
  try {
    const obs = await (await h.provider('ok')).execute(request(h, { budget: { ...BUDGET, maxWallClockMinutes: 0.05 } }));
    assert.equal(obs.status, 'FAILED', obs.knownLimitations.join('; '));
    const m = /egress proxy did not become ready in time: waited (\d+)ms of its (\d+)ms bound \(pid \d+, spawn \d+ms\), with nothing on its stdout/
      .exec(obs.summary);
    assert.ok(m, obs.summary);
    // Its bound is what was left of the 3 s budget, and it was waited out —
    // and no longer than a timer's lateness past it.
    assert.ok(Number(m[2]) >= 1 && Number(m[2]) <= 3_000, obs.summary);
    assert.ok(Number(m[1]) >= Number(m[2]) - 1 && Number(m[1]) <= Number(m[2]) + TIMER_LATENESS_MS, obs.summary);
    // A proxy that was never ready was never sent the credential.
    assert.equal(readFileSync(join(h.dir, 'proxy-stdin'), 'utf8'), '', 'nothing reached its stdin');
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('G3: the agent removal deadline is its bound after the client ended, never past the stop bound', () => {
  assert.equal(agentRemovalDeadline({ exitedAt: 1_000 }), 1_000 + AGENT_REMOVAL_BOUND_MS);
  assert.equal(agentRemovalDeadline({ stoppedAt: 0, exitedAt: 1_000 }), 1_000 + AGENT_REMOVAL_BOUND_MS);
  assert.equal(agentRemovalDeadline({ stoppedAt: 0, exitedAt: 45_000 }), AGENT_STOP_BOUND_MS);
});

test('G3: a removal that lands 91 s after the stop turns the stop-bound assertion red', async () => {
  // Slow retries: each removal takes 5 s, the container is gone only at 91 s.
  const late = await removalOnVirtualTime(91_000, 5_000);
  assert.deepEqual(late.filter((e) => e.phase === 'agent-removed'), [], 'not shown gone within the bound');
  assert.throws(() => assertStoppedInTime(late, 'timeout', 0), /exactly one 'agent-removed' moment/);
  // Fast answers, the same late removal.
  const fast = await removalOnVirtualTime(91_000, 10);
  assert.throws(() => assertStoppedInTime(fast, 'timeout', 0), /exactly one 'agent-removed' moment/);
  // Were a removal reported when it landed, at 91 s, the assertion is red too.
  const reportedLate = [...late.slice(0, -1), { phase: 'agent-removed' as const, attemptId: ATTEMPT, at: 91_000 }];
  assert.throws(() => assertStoppedInTime(reportedLate, 'timeout', 0), /removed 91000 ms after the stop/);
  // Gone within the bound: shown, reported, and green.
  const inTime = await removalOnVirtualTime(45_000, 5_000);
  const removed = phaseOf(inTime, 'agent-removed');
  assert.ok(removed.at >= 45_000 && removed.at <= AGENT_STOP_BOUND_MS, showTimeline(inTime));
  assertStoppedInTime(inTime, 'timeout', 0);
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
    assert.equal(obs.status, 'FAILED', showObservation(obs));
    assert.match(obs.knownLimitations.join(' '), new RegExp(`hashes to [0-9a-f]{64}, not the referenced ${h.workRef.sha256}`));
    assert.deepEqual(h.invocations(), []);
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('a daemon that does not isolate the agent network from the host fails the attempt before anything starts', async () => {
  const h = await harness();
  try {
    // A daemon that accepts the gateway mode and ignores it: the bridge gets
    // an address on the host.
    await mkdir(h.state, { recursive: true });
    await writeFile(join(h.state, 'daemon-ignores-gateway-mode'), '');
    const obs = await (await h.provider('ok')).execute(request(h));
    assert.equal(obs.status, 'FAILED', showObservation(obs));
    assert.match(obs.knownLimitations.join(' '), /agent network is not isolated from the host/);
    assert.ok(!verbs(h.invocations()).includes('run'), 'no proxy or agent ever started');
    assert.equal(readFileSync(join(h.wt, 'feature.txt'), { encoding: 'utf8', flag: 'a+' }), '', 'the agent did nothing');
    assertTornDown(h);
  } finally {
    await h.close();
  }
});

test('the agent network counts as isolated only as the daemon describes an isolated one', () => {
  const isolated = {
    Internal: true,
    Options: {
      'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
      'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
    },
    IPAM: { Config: [{ Subnet: '172.26.0.0/16' }] },
  };
  assert.equal(agentNetworkIsolationGap(isolated), undefined);
  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    ['not internal', { ...isolated, Internal: false }, /not internal/],
    ['ipv4 gateway mode unset', { ...isolated, Options: { 'com.docker.network.bridge.gateway_mode_ipv6': 'isolated' } }, /ipv4 gateway mode is unset/],
    ['ipv6 gateway mode nat', { ...isolated, Options: { ...isolated.Options, 'com.docker.network.bridge.gateway_mode_ipv6': 'nat' } }, /ipv6 gateway mode is nat/],
    ['a gateway address on the bridge', { ...isolated, IPAM: { Config: [{ Subnet: '172.26.0.0/16', Gateway: '172.26.0.1' }] } }, /holds 172\.26\.0\.1/],
    ['no address configuration', { ...isolated, IPAM: {} }, /no address configuration/],
    ['nothing at all', null, /did not describe/],
  ];
  for (const [label, shown, why] of cases) {
    assert.match(agentNetworkIsolationGap(shown) ?? 'isolated', why, label);
  }
});

test('docker trouble fails closed and still tears down what was started', async () => {
  const h = await harness();
  try {
    const noDocker = await (await h.provider('ok', { dockerBinary: join(h.dir, 'no-such-docker') })).execute(request(h));
    assert.equal(noDocker.status, 'FAILED', showObservation(noDocker));
    assert.match(noDocker.knownLimitations.join(' '), /docker network create failed/);

    const noEgress = await (await h.provider('ok', { egressNetwork: 'no-such-network' })).execute(request(h));
    assert.equal(noEgress.status, 'FAILED', showObservation(noEgress));
    assert.match(noEgress.knownLimitations.join(' '), /egress proxy exited 125 before it was ready/);
    assertTornDown(h);

    const noWorktree = await (await h.provider('ok', { workdirFor: () => join(h.dir, 'missing') })).execute(request(h));
    assert.equal(noWorktree.status, 'FAILED', showObservation(noWorktree));
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
