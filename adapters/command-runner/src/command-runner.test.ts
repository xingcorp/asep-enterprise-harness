// Command runner + sandbox suite (exit criteria F1–F6, D5). The runner is
// exercised for real (spawned child processes on this host); the Docker sandbox
// is exercised for its construction/validation invariants without requiring a
// Docker daemon, and the honest local fallback documents the no-isolation case.
//
// Machine-readable suite marker (K4) so a dropped/renamed/crashed runner suite
// turns the gate RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore } from '@asep/persistence';
import type { SqlClient } from '@asep/persistence';
import { TrustedCommandRunner } from './command-runner.js';
import { BoundedCapture, TRUNCATION_MARKER } from './bounded-capture.js';
import { resolveEnvironment, UnknownEnvironmentProfileError } from './environment-profiles.js';
import {
  DockerSandboxProvider, LocalUnsandboxedProvider, SandboxUnavailableError,
  buildSandboxRunFlags, isDigestPinned,
  type SandboxHandleEx,
} from './sandbox.js';
import { SandboxTeardownError } from './container-teardown.js';
import { SandboxHandleNotProvenError } from './command-runner.js';
import { spawn } from 'node:child_process';
import type { CommandSpec, SandboxHandle } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:command-runner');

const OUTPUT_POLICY = { maxEvidenceBytes: 1_000_000, displayHeadBytes: 4096, displayTailBytes: 4096 };

// The honest local handle: the one handle the runner runs on the host, because
// the provider that made it claims no isolation.
function hostHandle(): Promise<SandboxHandle> {
  return new LocalUnsandboxedProvider().start('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [],
  });
}

async function harness(): Promise<{
  client: SqlClient; store: ContentAddressedArtifactStore; scope: TenantScope; dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'asep-cr-'));
  const client = await PgliteClient.create();
  await migrate(client);
  // Seed a real org/project so scoped artifact writes satisfy the FK.
  const { rows: orgRows } = await client.query(
    `insert into organizations (id, name) values ($1, $2) returning id`,
    ['C'.repeat(26), 'Acme'],
  );
  const organizationId = orgRows[0]!['id'] as OrganizationId;
  const { rows: projRows } = await client.query(
    `insert into projects (id, organization_id, name, default_branch) values ($1, $2, $3, $4) returning id`,
    ['D'.repeat(26), organizationId, 'web', 'main'],
  );
  const projectId = projRows[0]!['id'] as ProjectId;
  const scope: TenantScope = { organizationId, projectId };
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  const store = new ContentAddressedArtifactStore(client, objects);
  return { client, store, scope, dir };
}

function spec(overrides: Partial<CommandSpec>): CommandSpec {
  return {
    executable: 'node', args: ['-e', 'process.exit(0)'], cwd: process.cwd(),
    environmentProfile: 'verification-no-network', timeoutMs: 10_000,
    outputPolicy: OUTPUT_POLICY, ...overrides,
  };
}

// --------------------------------------------------------------------------
// F2 — exact exit code and signal preserved.
// --------------------------------------------------------------------------

test('F2: a non-zero exit code is preserved exactly (no 1 -> 0 coercion)', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const runner = new TrustedCommandRunner(scope, store);
    const res = await runner.run(spec({ args: ['-e', 'process.exit(7)'] }), await hostHandle());
    assert.equal(res.exitCode, 7);
    assert.equal(res.signal, null);
    assert.equal(res.timedOut, false);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F2: raw stdout is captured to an immutable artifact and round-trips', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const runner = new TrustedCommandRunner(scope, store);
    const res = await runner.run(spec({ args: ['-e', 'process.stdout.write("hello-evidence")'] }), await hostHandle());
    assert.equal(res.exitCode, 0);
    const back = await store.get(scope, res.stdout);
    assert.equal(new TextDecoder().decode(back.content), 'hello-evidence');
    assert.equal(res.stdoutBytes, 'hello-evidence'.length);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// F3 — timeout kills the process group; AbortSignal cancels.
// --------------------------------------------------------------------------

test('F3: a command exceeding its timeout is killed and flagged timedOut', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const runner = new TrustedCommandRunner(scope, store);
    // Sleeps far longer than the timeout; must be killed.
    const res = await runner.run(
      spec({ args: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 300 }),
      await hostHandle(),
    );
    assert.equal(res.timedOut, true);
    // Killed by signal → exitCode null, signal set (SIGKILL).
    assert.equal(res.exitCode, null);
    assert.equal(res.signal, 'SIGKILL');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F3: an already-aborted signal kills the command promptly', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const ac = new AbortController();
    ac.abort();
    const runner = new TrustedCommandRunner(scope, store, ac.signal);
    const res = await runner.run(
      spec({ args: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 60_000 }),
      await hostHandle(),
    );
    // Cancelled → killed by signal, not a clean exit.
    assert.equal(res.exitCode, null);
    assert.ok(res.signal === 'SIGKILL' || res.signal === 'SIGTERM');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// F1 — argv only (shell:false). A shell metacharacter is a literal argument,
// never interpreted, so it cannot spawn a subshell.
// --------------------------------------------------------------------------

test('F1: shell metacharacters are inert (no shell interpretation)', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const runner = new TrustedCommandRunner(scope, store);
    // If this ran under a shell, `; echo INJECTED` would print INJECTED. With
    // shell:false the whole thing is a single argv value echoed verbatim.
    const payload = 'safe; echo INJECTED';
    const res = await runner.run(
      spec({ args: ['-e', 'process.stdout.write(process.argv[1])', payload] }),
      await hostHandle(),
    );
    const back = await store.get(scope, res.stdout);
    const text = new TextDecoder().decode(back.content);
    assert.equal(text, payload);
    assert.ok(!text.includes('INJECTED\n'), 'no shell interpretation occurred');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// F1/G3 — environment profile allowlist; unknown profile fails closed.
// --------------------------------------------------------------------------

test('F1: a verification command runs with a sanitized allowlisted env only', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    // Seed a secret into the harness env; it must NOT be visible to the command.
    process.env['ASEP_SECRET_CANARY'] = 'super-secret';
    const runner = new TrustedCommandRunner(scope, store);
    const res = await runner.run(
      spec({ args: ['-e', 'process.stdout.write(String(process.env.ASEP_SECRET_CANARY))'] }),
      await hostHandle(),
    );
    const back = await store.get(scope, res.stdout);
    assert.equal(new TextDecoder().decode(back.content), 'undefined');
  } finally {
    delete process.env['ASEP_SECRET_CANARY'];
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown environment profile fails closed', () => {
  assert.throws(() => resolveEnvironment('no-such-profile'), UnknownEnvironmentProfileError);
});

// --------------------------------------------------------------------------
// D5 — bounded capture truncates with a marker and keeps an honest byte count.
// --------------------------------------------------------------------------

test('D5: BoundedCapture truncates past the cap, marks it, keeps true total', () => {
  const cap = new BoundedCapture(10);
  cap.push(new TextEncoder().encode('0123456789'));   // exactly fills cap
  cap.push(new TextEncoder().encode('ABCDEFGHIJ'));    // all dropped
  const r = cap.result();
  assert.equal(r.truncated, true);
  assert.equal(r.totalBytes, 20, 'true total includes dropped bytes');
  const text = new TextDecoder().decode(r.bytes);
  assert.ok(text.startsWith('0123456789'));
  assert.ok(text.includes(TRUNCATION_MARKER.trim()));
});

test('D5: BoundedCapture under the cap is not truncated', () => {
  const cap = new BoundedCapture(100);
  cap.push(new TextEncoder().encode('short'));
  const r = cap.result();
  assert.equal(r.truncated, false);
  assert.equal(r.totalBytes, 5);
  assert.equal(new TextDecoder().decode(r.bytes), 'short');
});

// --------------------------------------------------------------------------
// F5/F6 — Docker sandbox invariants + honest local fallback.
// --------------------------------------------------------------------------

test('F5: a non-digest-pinned image is rejected at construction', () => {
  assert.throws(
    () => new DockerSandboxProvider({ imageDigest: 'node:20' }),
    SandboxUnavailableError,
  );
});

// The hardening invariants are asserted on the PURE flag builder (disp.
// P2-FINAL-HIGH-002). The previous shape wrapped provider.start() in
// try/catch and treated SandboxUnavailableError as acceptable evidence — on any
// host without a docker daemon it therefore asserted NOTHING while still
// reporting a pass (always-green). buildSandboxRunFlags is the exact function
// DockerSandboxProvider.start() uses, so these assertions are deterministic on
// every host and cannot be satisfied by an absent daemon.
//
// The live proof that the OS actually ENFORCES these flags is
// sandbox-exec.itest.ts (network canary, read-only rootfs, exit-code fidelity),
// which runs under the integration gate against a real daemon and fails closed.
test('F5: the sandbox run flags carry every hardening invariant (no docker needed)', () => {
  const flags = buildSandboxRunFlags('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: [], writablePaths: [],
  });
  const p = flags.join(' ');
  assert.ok(p.includes('--network none'), 'no network');
  assert.ok(p.includes('--read-only'), 'read-only rootfs');
  assert.ok(p.includes('--cap-drop ALL'), 'caps dropped');
  assert.ok(p.includes('--security-opt no-new-privileges'), 'no-new-privileges');
  assert.ok(p.includes('--pids-limit'), 'pid limit');
  assert.ok(p.includes('--cpus'), 'cpu limit');
  assert.ok(p.includes('--memory'), 'memory limit');
  assert.ok(!p.includes('docker.sock'), 'no docker socket mounted');
  assert.ok(!p.includes('--privileged'), 'never privileged');
});

test('F4: the agent profile is ALSO network-isolated at the OS level', () => {
  const flags = buildSandboxRunFlags('agent-restricted-egress', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: [], writablePaths: [],
  });
  // Phase 2 grants no agent egress: this must be OS-enforced `--network none`,
  // not a policy-advisory allowlist the agent could ignore.
  assert.ok(flags.join(' ').includes('--network none'), 'agent profile has no network');
});

test('F5/G3: only the working tree is writable; .git metadata is never mounted rw', () => {
  const flags = buildSandboxRunFlags('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: ['/ro/dep'],
    writablePaths: ['/wt/tree'],
  });
  const p = flags.join(' ');
  assert.ok(p.includes('-v /wt/tree:/wt/tree:rw'), 'the working tree is writable');
  assert.ok(p.includes('-v /ro/dep:/ro/dep:ro'), 'declared read-only paths are ro');
  assert.ok(!/\.git\S*:rw/.test(p), 'no .git path is ever mounted writable');
});

// The review's HIGH-002 finding: excluding `.git` from writablePaths did NOT
// protect it, because a linked worktree's `.git` lives INSIDE the working tree
// and `-v <wt>:<wt>:rw` made it writable through the parent mount. The fix is a
// NESTED read-only bind layered over the writable parent, so the guarantee is
// OS-enforced. These assertions pin the flag shape; the live proof that the
// kernel actually refuses the write is sandbox-exec.itest.ts.
test('HIGH-002: a nested .git overlay is bound read-only OVER the writable parent', () => {
  const flags = buildSandboxRunFlags('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: [],
    writablePaths: ['/wt/tree'],
    readOnlyOverlayPaths: ['/wt/tree/.git'],
  });
  const p = flags.join(' ');
  assert.ok(p.includes('-v /wt/tree:/wt/tree:rw'), 'the working tree stays writable');
  assert.ok(
    p.includes('-v /wt/tree/.git:/wt/tree/.git:ro'),
    'the nested .git path is bound read-only over the writable parent',
  );
  // The nested bind must come AFTER the parent in argv order, mirroring the
  // deepest-destination-last layering the daemon applies.
  assert.ok(
    p.indexOf('/wt/tree/.git:/wt/tree/.git:ro') > p.indexOf('/wt/tree:/wt/tree:rw'),
    'the read-only overlay is layered after the writable parent',
  );
  assert.ok(!/\.git\S*:rw/.test(p), 'the .git path is never rw');
});

test('HIGH-002: a mount with no overlay paths emits no extra binds (back-compat)', () => {
  const withOut = buildSandboxRunFlags('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: [], writablePaths: ['/wt/tree'],
  });
  const withEmpty = buildSandboxRunFlags('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: [], writablePaths: ['/wt/tree'], readOnlyOverlayPaths: [],
  });
  assert.deepEqual(withOut, withEmpty, 'an absent and an empty overlay list agree');
});

test('F5: a digest-pinned image is accepted and a mutable tag is rejected (pure)', () => {
  assert.equal(isDigestPinned(`node@sha256:${'a'.repeat(64)}`), true);
  assert.equal(isDigestPinned('node:20'), false);
  assert.equal(isDigestPinned('node@sha256:short'), false);
  // And the constructor enforces it, so a tag never reaches a daemon.
  assert.throws(
    () => new DockerSandboxProvider({ imageDigest: 'postgres:17' }),
    SandboxUnavailableError,
  );
});

test('F6: the local fallback is honestly labelled pilot-only, no isolation', async () => {
  const provider = new LocalUnsandboxedProvider();
  const handle = await provider.start('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never,
    readOnlyPaths: [], writablePaths: [],
  }) as SandboxHandleEx;
  assert.equal(handle.isolationEnforced, false);
  assert.ok(handle.profile.includes('PILOT-ONLY'), 'profile name warns pilot-only');
  assert.ok(handle.profile.includes('NO-ISOLATION'));
});

// ---------------------------------------------------------------------------
// The sandbox is mandatory, and there is no way to waive it: the public surface
// carries no requirement resolver, no waiver token and no override. The governed
// path refuses any handle that does not claim isolation (application tests),
// and only DockerSandboxProvider may make that claim (ts-guard).
// ---------------------------------------------------------------------------

test('E8: the public surface offers no way to waive sandbox isolation', async () => {
  const surface = Object.keys(await import('./index.js'));
  for (const retired of [
    'resolveSandboxRequirement', 'assertSandboxSatisfiesRequirement', 'SandboxRequiredError',
  ]) {
    assert.ok(!surface.includes(retired), `${retired} must not be exported`);
  }
});

test('E8: a Docker handle runs commands through its configured docker client, inside the container', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const state = join(dir, 'docker-state');
    const docker = join(dir, 'docker');
    const fake = fileURLToPath(new URL('../../../scripts/testing/fake-docker.mjs', import.meta.url));
    await writeFile(docker, `#!/bin/sh\nexec "${process.execPath}" "${fake}" --state "${state}" "$@"\n`, { mode: 0o755 });
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const provider = new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: docker });
    const handle = await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [wt],
    });
    assert.equal((handle as SandboxHandleEx).dockerBinary, docker);
    const r = await new TrustedCommandRunner(scope, store).run({
      executable: 'node', args: ['-e', 'process.stdout.write("in the container")'], cwd: wt,
      environmentProfile: 'verification-no-network', timeoutMs: 30_000,
      outputPolicy: { maxEvidenceBytes: 4096, displayHeadBytes: 100, displayTailBytes: 100 },
    }, handle);
    assert.equal(r.exitCode, 0);
    assert.equal(new TextDecoder().decode((await store.get(scope, r.stdout)).content), 'in the container');
    const runs = readFileSync(join(state, 'invocations.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { argv?: string[] }).filter((i) => i.argv?.[0] === 'run');
    assert.equal(runs.length, 1, 'the command ran through docker, not on the host');
    const argv = runs[0]!.argv!;
    for (const flag of ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '-w', wt]) {
      assert.ok(argv.includes(flag), `docker run carries ${flag}`);
    }
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A killed `docker run` client does not stop its container. Each verification
// container is named and labelled for its sandbox, workspace and attempt, and
// removed by that identity however its client ends. The fake docker client
// models the daemon here: its "containers" are detached host processes that
// outlive a killed client, exactly as real containers do. The real-daemon proof
// is sandbox-exec.itest.ts.
// ---------------------------------------------------------------------------

const FAKE_DOCKER = fileURLToPath(new URL('../../../scripts/testing/fake-docker.mjs', import.meta.url));
const ATTEMPT = 'A'.repeat(26);

interface FakeDaemon {
  readonly docker: string;
  readonly state: string;
  readonly wt: string;
  containers(): Record<string, unknown>[];
  runClientPid(): number;
  invocations(): string[][];
}

// A fake docker client shim that records the pid of each client it starts.
// `refuseRm` makes every `docker rm` and `docker kill` fail, as a daemon that
// cannot stop or remove a container.
async function fakeDaemon(dir: string, refuseRm = false): Promise<FakeDaemon> {
  const state = join(dir, 'docker-state');
  const docker = join(dir, 'docker');
  const pids = join(dir, 'client-pids');
  await writeFile(docker, [
    '#!/bin/sh',
    `echo "$$ $1" >> "${pids}"`,
    ...(refuseRm ? ['case "$1" in rm|kill) echo "Error response from daemon: removal refused" >&2; exit 1;; esac'] : []),
    `exec "${process.execPath}" "${FAKE_DOCKER}" --state "${state}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const wt = join(dir, 'wt');
  await mkdir(wt);
  return {
    docker, state, wt,
    containers() {
      const d = join(state, 'containers');
      return existsSync(d) ? readdirSync(d).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Record<string, unknown>) : [];
    },
    runClientPid() {
      const line = readFileSync(pids, 'utf8').trim().split('\n').find((l) => l.endsWith(' run'));
      assert.ok(line, 'a docker run client was started');
      return Number(line.split(' ')[0]);
    },
    invocations() {
      const p = join(state, 'invocations.jsonl');
      return existsSync(p)
        ? readFileSync(p, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { argv?: string[] }).argv ?? []).filter((a) => a.length > 0)
        : [];
    },
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const LONG = { executable: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'] };

async function dockerHandle(d: FakeDaemon): Promise<SandboxHandleEx> {
  const provider = new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: d.docker });
  return await provider.start('verification-no-network', {
    workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [d.wt], attemptId: ATTEMPT as never,
  }) as SandboxHandleEx;
}

test('a verification container is named and labelled for its sandbox, workspace and attempt', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const handle = await dockerHandle(d);
    const r = await new TrustedCommandRunner(scope, store).run(spec({ cwd: d.wt }), handle);
    assert.equal(r.exitCode, 0);
    const run = d.invocations().find((a) => a[0] === 'run')!;
    const name = run[run.indexOf('--name') + 1];
    assert.equal(name, `${handle.sandboxId}-1`);
    const labels = run.flatMap((a, i) => (a === '--label' ? [run[i + 1]] : []));
    assert.deepEqual(labels.sort(), [
      `asep.attempt=${ATTEMPT}`, `asep.container=${name}`, 'asep.role=verification',
      `asep.sandbox=${handle.sandboxId}`, `asep.workspace=${'W'.repeat(26)}`,
    ]);
    // After a normal exit the runner still confirms, by that label, that it is gone.
    assert.ok(d.invocations().some((a) => a[0] === 'ps' && a.includes(`label=asep.container=${name}`)));
    assert.deepEqual(d.containers(), []);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('killing the docker client mid-run does not leave its container running', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const running = new TrustedCommandRunner(scope, store).run(spec({ ...LONG, cwd: d.wt, timeoutMs: 60_000 }), await dockerHandle(d));
    await until('the container to start', () => d.containers().length === 1);
    const containerPid = d.containers()[0]!['pid'] as number;
    assert.ok(alive(containerPid));
    process.kill(d.runClientPid(), 'SIGKILL');
    const r = await running;
    assert.equal(r.signal, 'SIGKILL', 'the client died of the signal');
    assert.equal(r.timedOut, false);
    assert.deepEqual(d.containers(), [], 'the container was removed by its name');
    await until('the container process to end', () => !alive(containerPid), 5_000);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a timed-out command has its container removed, not merely its client killed', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const handle = await dockerHandle(d);
    const r = await new TrustedCommandRunner(scope, store).run(spec({ ...LONG, cwd: d.wt, timeoutMs: 1_500 }), handle);
    assert.equal(r.timedOut, true);
    assert.deepEqual(d.containers(), []);
    assert.ok(d.invocations().some((a) => a[0] === 'kill' && a.includes(`${handle.sandboxId}-1`)),
      'the container itself was stopped, by its name');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a cancelled command has its container removed', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const ac = new AbortController();
    const running = new TrustedCommandRunner(scope, store, ac.signal)
      .run(spec({ ...LONG, cwd: d.wt, timeoutMs: 60_000 }), await dockerHandle(d));
    await until('the container to start', () => d.containers().length === 1);
    const containerPid = d.containers()[0]!['pid'] as number;
    ac.abort();
    const r = await running;
    assert.equal(r.exitCode === 0, false);
    assert.deepEqual(d.containers(), []);
    await until('the container process to end', () => !alive(containerPid), 5_000);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a container that cannot be removed fails the run closed', async () => {
  const { client, store, scope, dir } = await harness();
  let leftover: number | undefined;
  try {
    const d = await fakeDaemon(dir, true);
    const running = new TrustedCommandRunner(scope, store).run(spec({ ...LONG, cwd: d.wt, timeoutMs: 1_000 }), await dockerHandle(d));
    await until('the container to start', () => d.containers().length === 1);
    leftover = d.containers()[0]!['pid'] as number;
    await assert.rejects(running, (err: Error) =>
      err instanceof SandboxTeardownError && /could not be removed .*removal refused/.test(err.message));
  } finally {
    if (leftover !== undefined) try { process.kill(-leftover, 'SIGKILL'); } catch { /* gone */ }
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopping a sandbox removes any container still carrying its id, and fails when it cannot', async () => {
  const { client, dir } = await harness();
  const leftovers: number[] = [];
  try {
    for (const refuseRm of [false, true]) {
      const sub = join(dir, refuseRm ? 'refusing' : 'removing');
      await mkdir(sub);
      const d = await fakeDaemon(sub, refuseRm);
      const provider = new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: d.docker });
      const handle = await provider.start('verification-no-network', {
        workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [d.wt], attemptId: ATTEMPT as never,
      }) as SandboxHandleEx;
      // A container of this sandbox whose client died before anyone removed it.
      const orphan = spawn(d.docker, [...handle.runFlags!, '--name', `${handle.sandboxId}-9`, handle.image!, LONG.executable, ...LONG.args],
        { stdio: 'ignore', detached: true });
      await until('the orphan to start', () => d.containers().length === 1);
      leftovers.push(d.containers()[0]!['pid'] as number);
      orphan.kill('SIGKILL');
      if (refuseRm) {
        await assert.rejects(() => provider.stop(handle), SandboxTeardownError);
        assert.equal(d.containers().length, 1);
      } else {
        await provider.stop(handle);
        assert.deepEqual(d.containers(), [], 'stop removed the orphan by the sandbox label');
      }
    }
  } finally {
    for (const pid of leftovers) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The runner runs a command only for a handle a sandbox provider of this
// package made, and only where that provider put it: in its container, or —
// for the honest local handle, which claims no isolation — on the host. A
// handle the runner cannot trace to a provider (built by hand, copied, or
// destructured, whatever it claims) or whose sandbox has stopped is refused
// before anything is spawned. A boolean on the handle decides nothing.
// ---------------------------------------------------------------------------

function canary(path: string): Partial<CommandSpec> {
  return { executable: 'node', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'ran')`] };
}

test('a handle no sandbox provider made is refused and runs nothing, on the host or in a container', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const docker = new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: d.docker });
    const mount = { workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [d.wt] };
    const genuine = await docker.start('verification-no-network', mount) as SandboxHandleEx;
    const host = await hostHandle();
    // The reviewer's probe: keep the claim, drop what would put the command in a container.
    const { runFlags: _flags, image: _image, ...rest } = genuine;
    const stopped = await docker.start('verification-no-network', mount);
    await docker.stop(stopped);
    const local = new LocalUnsandboxedProvider();
    const stoppedHost = await local.start('verification-no-network', mount);
    await local.stop(stoppedHost);
    const refused: ReadonlyArray<readonly [string, SandboxHandle]> = [
      ['an object rest of a Docker handle without its run flags and image', rest],
      ['a spread copy of a Docker handle', { ...genuine }],
      ['a hand-built handle that claims isolation', { sandboxId: 'x', profile: 'verification-no-network', isolationEnforced: true }],
      ['a hand-built handle that claims nothing', { sandboxId: 'x', profile: 'verification-no-network' }],
      ['a spread copy of the host handle', { ...host }],
      ['a spread copy of the host handle that claims isolation', { ...host, isolationEnforced: true }],
      ['a Docker handle whose sandbox has stopped', stopped],
      ['a host handle whose sandbox has stopped', stoppedHost],
    ];
    const runner = new TrustedCommandRunner(scope, store);
    for (const [i, [what, handle]] of refused.entries()) {
      const marker = join(dir, `canary-${i}`);
      await assert.rejects(runner.run(spec({ ...canary(marker), cwd: d.wt }), handle), SandboxHandleNotProvenError, what);
      assert.equal(existsSync(marker), false, `${what}: the command ran`);
    }
    assert.deepEqual(d.invocations().filter((a) => a[0] === 'run'), [], 'no container was started');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a handle a provider made cannot be altered after the fact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-frozen-'));
  try {
    const d = await fakeDaemon(dir);
    for (const handle of [await dockerHandle(d), await hostHandle()]) {
      assert.ok(Object.isFrozen(handle), `${handle.sandboxId} is frozen`);
      assert.throws(() => { (handle as { isolationEnforced?: boolean }).isolationEnforced = true; }, TypeError);
      assert.throws(() => { delete (handle as { sandboxId?: string }).sandboxId; }, TypeError);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a genuine handle still runs where its provider put it', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const runner = new TrustedCommandRunner(scope, store);
    const onHost = join(dir, 'on-host');
    const hosted = await runner.run(spec({ ...canary(onHost), cwd: d.wt }), await hostHandle());
    assert.equal(hosted.exitCode, 0);
    assert.equal(existsSync(onHost), true, 'the local handle runs on the host');
    assert.deepEqual(d.invocations().filter((a) => a[0] === 'run'), []);
    assert.deepEqual(hosted.provenance, { where: 'host' }, 'the result says it ran on the host');
    const inContainer = join(dir, 'in-container');
    const handle = await dockerHandle(d);
    const contained = await runner.run(spec({ ...canary(inContainer), cwd: d.wt }), handle);
    assert.equal(contained.exitCode, 0);
    const runs = d.invocations().filter((a) => a[0] === 'run');
    assert.equal(runs.length, 1, 'the Docker handle runs through docker');
    // The result says where it ran: the provider's image and flags, and the
    // container the runner named — exactly what the docker client was given.
    const where = contained.provenance;
    assert.equal(where?.where, 'container');
    if (where?.where !== 'container') return;
    assert.equal(where.image, (handle as SandboxHandleEx).image);
    assert.deepEqual(where.runFlags, (handle as SandboxHandleEx).runFlags);
    assert.equal(runs[0]![runs[0]!.indexOf('--name') + 1], where.container);
    assert.ok(runs[0]!.includes(where.image));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
