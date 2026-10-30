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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore } from '@asep/persistence';
import type { SqlClient } from '@asep/persistence';
import { TrustedCommandRunner, COMMAND_REMOVAL_BOUND_MS, type CommandLifecycleEvent, type SpawnClient } from './command-runner.js';
import { BoundedCapture, TRUNCATION_MARKER } from './bounded-capture.js';
import { resolveEnvironment, UnknownEnvironmentProfileError } from './environment-profiles.js';
import {
  DockerSandboxProvider, LocalUnsandboxedProvider, SandboxUnavailableError,
  buildSandboxRunFlags, isDigestPinned, executionOf, sandboxLabels,
  type SandboxHandleEx,
} from './sandbox.js';
import {
  SandboxTeardownError, removeLabelledContainers, removeContainerShownGone, monotonicNow, dockerCaller,
  describeDockerCall, type DockerCall, type DockerResult, type TeardownClock,
} from './container-teardown.js';
import { SandboxHandleNotProvenError } from './command-runner.js';
import { spawn } from 'node:child_process';
import type { CommandSpec, SandboxHandle } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope,
} from '@asep/contracts';
import {
  registryShimLine, removeFakeDockerFixture,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/testing/fake-docker-fixture.mjs';

console.log('SUITE-ID: asep-suite:command-runner');

const OUTPUT_POLICY = { maxEvidenceBytes: 1_000_000, displayHeadBytes: 4096, displayTailBytes: 4096 };

// The bound on a command in a test that is not about timeouts. Under host load
// (load average 56 on 8 CPUs, with other gates running) a one-line `node -e`
// once took over 10 s end to end; the earlier 10 s bound fired, the run came
// back timed out with no output, and the test failed on the output instead.
// Two minutes is far above anything observed, and a hang still ends the test.
// Tests about timeouts set their own, short bound.
const COMMAND_BOUND_MS = 120_000;

// A run that hit its bound has no output; say that, rather than fail on it.
function finished(res: { timedOut: boolean }): void {
  assert.equal(res.timedOut, false, `the command did not finish within ${COMMAND_BOUND_MS} ms`);
}

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
    environmentProfile: 'verification-no-network', timeoutMs: COMMAND_BOUND_MS,
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
    await removeFakeDockerFixture(dir);
  }
});

test('F2: raw stdout is captured to an immutable artifact and round-trips', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const runner = new TrustedCommandRunner(scope, store);
    const res = await runner.run(spec({ args: ['-e', 'process.stdout.write("hello-evidence")'] }), await hostHandle());
    finished(res);
    assert.equal(res.exitCode, 0);
    const back = await store.get(scope, res.stdout);
    assert.equal(new TextDecoder().decode(back.content), 'hello-evidence');
    assert.equal(res.stdoutBytes, 'hello-evidence'.length);
  } finally {
    await client.close();
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
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
    finished(res);
    const back = await store.get(scope, res.stdout);
    const text = new TextDecoder().decode(back.content);
    assert.equal(text, payload);
    assert.ok(!text.includes('INJECTED\n'), 'no shell interpretation occurred');
  } finally {
    await client.close();
    await removeFakeDockerFixture(dir);
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
    finished(res);
    const back = await store.get(scope, res.stdout);
    assert.equal(new TextDecoder().decode(back.content), 'undefined');
  } finally {
    delete process.env['ASEP_SECRET_CANARY'];
    await client.close();
    await removeFakeDockerFixture(dir);
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

// The probe a sandbox makes before it starts is a docker call like the others:
// it gets only the client environment, and a daemon that does not answer is
// refused with how the call ended.
test('F5: the docker probe gets only the client environment, and an unreachable daemon is refused with how it ended', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-docker-probe-'));
  const before = process.env['ASEP_PROBE_CANARY'];
  process.env['ASEP_PROBE_CANARY'] = 'must-not-reach-docker';
  try {
    const seen = join(dir, 'env');
    const docker = join(dir, 'docker');
    await writeFile(docker, `#!/bin/sh\nenv > "${seen}"\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n`, { mode: 0o755 });
    const provider = new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: docker });
    await assert.rejects(
      provider.start('verification-no-network', {
        workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [dir], attemptId: ATTEMPT as never,
      }),
      (err: Error) => err instanceof SandboxUnavailableError
        && /docker CLI or daemon not reachable: Cannot connect to the Docker daemon \(version --format at \+0ms: exit 1 after \d+ms \(pid \d+, spawn \d+ms, bound 30000ms\)\)$/
          .test(err.message),
    );
    const env = readFileSync(seen, 'utf8');
    assert.doesNotMatch(env, /ASEP_PROBE_CANARY/, 'the probe got the client environment only');
    assert.match(env, /^PATH=/m);
  } finally {
    if (before === undefined) delete process.env['ASEP_PROBE_CANARY'];
    else process.env['ASEP_PROBE_CANARY'] = before;
    await removeFakeDockerFixture(dir);
  }
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
    await writeFile(docker, `#!/bin/sh\n${registryShimLine()}\nexec "${process.execPath}" "${fake}" --state "${state}" "$@"\n`, { mode: 0o755 });
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const provider = new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: docker });
    const handle = await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [wt],
    });
    assert.equal((handle as SandboxHandleEx).dockerBinary, docker);
    const r = await new TrustedCommandRunner(scope, store).run({
      executable: 'node', args: ['-e', 'process.stdout.write("in the container")'], cwd: wt,
      environmentProfile: 'verification-no-network', timeoutMs: COMMAND_BOUND_MS,
      outputPolicy: { maxEvidenceBytes: 4096, displayHeadBytes: 100, displayTailBytes: 100 },
    }, handle);
    finished(r);
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
    await removeFakeDockerFixture(dir);
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
// cannot stop or remove a container; `hangPs` makes every `docker ps` hang, as
// a daemon that never says what is left.
async function fakeDaemon(dir: string, refuseRm = false, hangPs = false, psErr?: string): Promise<FakeDaemon> {
  const state = join(dir, 'docker-state');
  const docker = join(dir, 'docker');
  const pids = join(dir, 'client-pids');
  await writeFile(docker, [
    '#!/bin/sh',
    registryShimLine(),
    `echo "$$ $1" >> "${pids}"`,
    ...(refuseRm ? ['case "$1" in rm|kill) echo "Error response from daemon: removal refused" >&2; exit 1;; esac'] : []),
    ...(hangPs ? ['case "$1" in ps) exec sleep 600;; esac'] : []),
    // A `ps` the daemon cannot answer: an error on stderr, nothing listed.
    ...(psErr !== undefined ? [`case "$1" in ps) echo '${psErr}' >&2; exit 1;; esac`] : []),
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

// How long a test waits for a container it started to appear. Under load
// average 60–120 on 8 CPUs the fake daemon's containers started within 2.4 s;
// the bound only matters when one never comes, so it is generous.
const START_WAIT_MS = 60_000;

async function until(what: string, ok: () => boolean, ms = START_WAIT_MS): Promise<void> {
  const end = monotonicNow() + ms;
  while (!ok()) {
    if (monotonicNow() > end) throw new Error(`timed out waiting for ${what}`);
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
    finished(r);
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
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
  }
});

test('the runner tells each moment of a timed-out run in order, and an observer that throws changes nothing', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const handle = await dockerHandle(d);
    const seen: CommandLifecycleEvent[] = [];
    const r = await new TrustedCommandRunner(scope, store, undefined, (e) => { seen.push(e); })
      .run(spec({ ...LONG, cwd: d.wt, timeoutMs: 1_000 }), handle);
    assert.equal(r.timedOut, true);
    // The client may end before the kill call returns, or after it.
    assert.deepEqual(seen.slice(0, 2).map((e) => [e.phase, e.reason]), [['spawned', undefined], ['stop', 'timeout']]);
    assert.deepEqual(seen.slice(2, 4).map((e) => e.phase).sort(), ['exited', 'killed']);
    assert.deepEqual(seen.slice(4).map((e) => e.phase), ['removed']);
    assert.ok(seen.every((e, i) => i === 0 || e.at >= seen[i - 1]!.at), 'in the order they happened');
    // At the timeout, not before it, and not later than a loaded host's
    // scheduling allows.
    const late = seen[1]!.at - seen[0]!.at - 1_000;
    assert.ok(late >= -50 && late <= 2_000, `the stop came ${late} ms off the timeout`);

    let calls = 0;
    const again = await new TrustedCommandRunner(scope, store, undefined, () => { calls++; throw new Error('observer failure'); })
      .run(spec({ ...LONG, cwd: d.wt, timeoutMs: 1_000 }), handle);
    assert.equal(again.timedOut, true);
    assert.equal(calls, 5, 'it was told every moment all the same');
    assert.deepEqual(d.containers(), []);
  } finally {
    await client.close();
    await removeFakeDockerFixture(dir);
  }
});

test('a wall clock set back during a run does not move the moments the runner reports', async () => {
  const { client, store, scope, dir } = await harness();
  const wall = Date.now;
  try {
    const d = await fakeDaemon(dir);
    const seen: CommandLifecycleEvent[] = [];
    // Set back a minute as soon as the client is spawned, as an NTP step can.
    const r = await new TrustedCommandRunner(scope, store, undefined, (e) => {
      seen.push(e);
      if (e.phase === 'spawned') Date.now = () => wall() - 60_000;
    }).run(spec({ ...LONG, cwd: d.wt, timeoutMs: 1_000 }), await dockerHandle(d));
    assert.equal(r.timedOut, true);
    const late = seen[1]!.at - seen[0]!.at - 1_000;
    assert.ok(late >= -50 && late <= 2_000, `the stop came ${late} ms off the timeout`);
    assert.ok(seen.every((e, i) => i === 0 || e.at >= seen[i - 1]!.at), 'in the order they happened');
  } finally {
    Date.now = wall;
    await client.close();
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
  }
});

test('a container that cannot be removed fails the run closed, and is never reported removed', async () => {
  const { client, store, scope, dir } = await harness();
  let leftover: number | undefined;
  try {
    const d = await fakeDaemon(dir, true);
    const seen: CommandLifecycleEvent[] = [];
    const running = new TrustedCommandRunner(scope, store, undefined, (e) => { seen.push(e); })
      .run(spec({ ...LONG, cwd: d.wt, timeoutMs: 1_000 }), await dockerHandle(d));
    await until('the container to start', () => d.containers().length === 1);
    leftover = d.containers()[0]!['pid'] as number;
    await assert.rejects(running, (err: Error) =>
      err instanceof SandboxTeardownError && /could not be removed .*removal refused/.test(err.message));
    assert.deepEqual(seen.filter((e) => e.phase === 'removed'), [], 'not shown gone, not reported removed');
  } finally {
    if (leftover !== undefined) try { process.kill(-leftover, 'SIGKILL'); } catch { /* gone */ }
    await client.close();
    await removeFakeDockerFixture(dir);
  }
});

test('a container the daemon cannot show gone within the removal bound fails the run at the bound', { timeout: 120_000 }, async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir, false, true);
    const seen: CommandLifecycleEvent[] = [];
    let message = '';
    await assert.rejects(
      new TrustedCommandRunner(scope, store, undefined, (e) => { seen.push(e); })
        .run(spec({ cwd: d.wt }), await dockerHandle(d)),
      (err: Error) => {
        message = err.message;
        return err instanceof SandboxTeardownError && /could not be shown removed in time/.test(err.message);
      },
    );
    // The error says what each removal call did: here the one `ps`, killed by
    // its caller at its bound, and how the command's client went before it.
    assert.match(message, new RegExp('docker ps failed: killed by SIGKILL at its bound; calls: '
      + 'ps -aq at \\+0ms: signal SIGKILL after \\d+ms \\(pid \\d+, spawn \\d+ms, bound \\d+ms, cut at \\d+ms\\)'));
    assert.match(message, /; its client \(pid \d+\) ended with exit 0 after \d+ms, and the removal began \d+ms later$/);
    const exited = seen.find((e) => e.phase === 'exited')!;
    const gaveUp = monotonicNow() - exited.at;
    assert.ok(gaveUp >= COMMAND_REMOVAL_BOUND_MS - 50 && gaveUp <= COMMAND_REMOVAL_BOUND_MS + 5_000,
      `the run failed ${gaveUp} ms after its client ended, not at the ${COMMAND_REMOVAL_BOUND_MS} ms bound`);
    assert.deepEqual(seen.filter((e) => e.phase === 'removed'), []);
  } finally {
    await client.close();
    await removeFakeDockerFixture(dir);
  }
});

// What a daemon that cannot answer says, none of it an answer about the
// container: no access to its socket, no daemon at all, an error of its own.
const DAEMON_ERRORS = [
  ['permission denied', 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: permission denied'],
  ['daemon unreachable', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'],
  ['an unrelated error', 'Error response from daemon: i/o timeout'],
] as const;

// The runner shows its container gone only by a `docker ps -a` that lists none
// with its label. A `ps` that fails — whatever its error says — lists nothing,
// and is no answer: the run fails, and nothing is reported removed.
for (const [name, said] of DAEMON_ERRORS) {
  test(`a removal whose docker ps fails with ${name} is no proof: the run fails and nothing is reported removed`, { timeout: 120_000 }, async () => {
    const { client, store, scope, dir } = await harness();
    try {
      const d = await fakeDaemon(dir, false, false, said);
      const seen: CommandLifecycleEvent[] = [];
      let message = '';
      await assert.rejects(
        new TrustedCommandRunner(scope, store, undefined, (e) => { seen.push(e); })
          .run(spec({ cwd: d.wt }), await dockerHandle(d)),
        (err: Error) => { message = err.message; return err instanceof SandboxTeardownError; },
      );
      assert.ok(message.includes(`docker ps failed: ${said}; calls: ps -aq at +0ms: exit 1 after `), message);
      assert.deepEqual(seen.filter((e) => e.phase === 'removed'), [], 'not shown gone, not reported removed');
    } finally {
      await client.close();
      await removeFakeDockerFixture(dir);
    }
  });
}

// A client that fails after it started may have left its container: the
// container is removed and shown gone, and the client's own error is what the
// run throws. A client that never started made nothing, and nothing is asked.
test('a client that errs after it started has its container removed and shown gone, and its error is thrown', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const seen: CommandLifecycleEvent[] = [];
    const lost = new Error('read EIO');
    // The real client, which starts the container; once the container runs, the
    // client reports an error and dies, as a client whose pipe broke would.
    const failing: SpawnClient = (command, args, options) => {
      const child = spawn(command, args, options);
      void until('the container to start', () => d.containers().length === 1).then(() => {
        child.emit('error', lost);
        child.kill('SIGKILL');
      });
      return child;
    };
    const running = new TrustedCommandRunner(scope, store, undefined, (e) => { seen.push(e); }, failing)
      .run(spec({ ...LONG, cwd: d.wt }), await dockerHandle(d));
    await assert.rejects(running, (err: unknown) => err === lost);
    assert.deepEqual(d.containers(), [], 'the container is gone');
    assert.deepEqual(seen.filter((e) => e.phase === 'removed').length, 1, 'and reported removed once shown gone');
    assert.deepEqual(d.invocations().map((a) => a[0]), ['version', 'run', 'ps', 'rm', 'ps'],
      'the sandbox probe, the run, then the removal: listed, removed, listed none');

    // Never started: nothing to remove, nothing asked, the error as it was.
    const neverStarts: SpawnClient = (_command, args, options) => spawn(join(dir, 'no-such-docker'), args, options);
    const handle = await dockerHandle(d);
    const before = d.invocations().length;
    const seen2: CommandLifecycleEvent[] = [];
    await assert.rejects(
      new TrustedCommandRunner(scope, store, undefined, (e) => { seen2.push(e); }, neverStarts)
        .run(spec({ cwd: d.wt }), handle),
      (err: unknown) => (err as { code?: string }).code === 'ENOENT',
    );
    assert.equal(d.invocations().length, before, 'no docker call was made for it');
    assert.deepEqual(seen2.filter((e) => e.phase === 'removed'), []);
  } finally {
    await client.close();
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
  }
});

// What the runner executes is its own frozen copy of the provider's execution
// record: the arrays the handle and the result expose are separate frozen
// copies, so nothing reachable from them can change the next docker argv.
test('the flags a handle and a result expose are frozen copies, never the ones the runner executes', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await fakeDaemon(dir);
    const handle = await dockerHandle(d);
    const record = executionOf(handle);
    assert.equal(record?.kind, 'container');
    if (record?.kind !== 'container') return;
    const flags = handle.runFlags as string[];
    const prefix = handle.dockerRunPrefix as string[];
    // The reviewer's probe printed `true false true`: handle frozen, its flags
    // not, and the same array as the record the runner executes.
    assert.deepEqual([Object.isFrozen(handle), Object.isFrozen(flags), flags === record.runFlags], [true, true, false]);
    assert.ok(Object.isFrozen(record), 'the runner\'s record is frozen');
    assert.notEqual(flags, record.runFlags, 'the handle does not share the runner\'s array');
    for (const [what, arr] of [['handle flags', flags], ['handle prefix', prefix], ['runner flags', record.runFlags]] as const) {
      assert.ok(Object.isFrozen(arr), `${what} are frozen`);
    }
    const at = flags.indexOf('--network');
    // The reviewer's probe, and its relatives: none of them may land.
    assert.throws(() => { flags.splice(at + 1, 1, 'host'); }, TypeError);
    assert.throws(() => { flags.push('--privileged', '-v', '/var/run/docker.sock:/var/run/docker.sock'); }, TypeError);
    assert.throws(() => { flags[at + 1] = 'host'; }, TypeError);
    assert.throws(() => { prefix.push('--privileged'); }, TypeError);

    const runner = new TrustedCommandRunner(scope, store);
    const first = await runner.run(spec({ cwd: d.wt }), handle);
    finished(first);
    const where = first.provenance;
    assert.equal(where?.where, 'container');
    if (where?.where !== 'container') return;
    assert.notEqual(where.runFlags, record.runFlags, 'the result does not share the runner\'s array');
    assert.ok(Object.isFrozen(where.runFlags));
    assert.throws(() => { (where.runFlags as string[]).push('--privileged'); }, TypeError);
    assert.throws(() => { (where.runFlags as string[])[at + 1] = 'host'; }, TypeError);

    // The next run still executes exactly the provider's profile.
    const second = await runner.run(spec({ cwd: d.wt }), handle);
    finished(second);
    const runs = d.invocations().filter((a) => a[0] === 'run');
    assert.equal(runs.length, 2);
    for (const [n, run] of runs.entries()) {
      const name = `${handle.sandboxId}-${n + 1}`;
      assert.deepEqual(run, [
        ...buildSandboxRunFlags('verification-no-network', {
          workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [d.wt], attemptId: ATTEMPT as never,
        }),
        ...sandboxLabels(handle.sandboxId, 'verification-no-network', {
          workspaceId: 'W'.repeat(26) as never, readOnlyPaths: [], writablePaths: [d.wt], attemptId: ATTEMPT as never,
        }).flatMap((l) => ['--label', l]),
        '--name', name, '--label', `asep.container=${name}`,
        '-w', d.wt, `alpine@sha256:${'a'.repeat(64)}`, 'node', '-e', 'process.exit(0)',
      ], `docker run ${n + 1} is the provider's profile, byte for byte`);
    }
  } finally {
    await client.close();
    await removeFakeDockerFixture(dir);
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
    await removeFakeDockerFixture(dir);
  }
});

// How late a timer may fire on a loaded host, and how long a client killed with
// SIGKILL may take to be seen closed: the allowances of the cut's upper bounds
// below. The stop path, measured against the real daemon at load average up to
// 112, acted at most 4 ms after its timer was due.
const TIMER_LATENESS_MS = 500;
const KILL_TO_CLOSE_MS = 400;

// Every docker client call reports how it ended and how long it took against
// its bound: the signal that ended its client, when one did, whether its
// caller killed it at that bound — no earlier and not much later — and the
// client's process id.
test('a docker call records the signal that ended its client, its duration and the bound it was cut at', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-docker-call-'));
  try {
    const hangs = join(dir, 'hangs');
    await writeFile(hangs, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const exits = join(dir, 'exits');
    await writeFile(exits, '#!/bin/sh\necho "refused" >&2\nexit 3\n', { mode: 0o755 });

    const cut = await dockerCaller(hangs, { PATH: '/usr/bin:/bin' })(['ps', '-aq', '--filter', 'label=x'], { timeoutMs: 300 });
    assert.equal(cut.code, null);
    assert.equal(cut.signal, 'SIGKILL');
    assert.equal(cut.call?.argv, 'ps -aq');
    assert.equal(cut.call?.cutMs, 300);
    assert.equal(cut.call?.spawned, true);
    const cutAfter = cut.call?.cutAfterMs ?? NaN;
    assert.ok(cutAfter >= 299 && cutAfter <= 300 + TIMER_LATENESS_MS, `killed at ${cutAfter} ms against its 300 ms bound`);
    const duration = cut.call?.durationMs ?? NaN;
    assert.ok(duration >= cutAfter && duration <= 300 + TIMER_LATENESS_MS + KILL_TO_CLOSE_MS,
      `the cut call took ${duration} ms, killed at ${cutAfter} ms`);
    assert.ok(Number.isSafeInteger(cut.call?.pid) && cut.call!.pid! > 0, `the client's pid is recorded: ${cut.call?.pid}`);
    assert.match(describeDockerCall(['ps', '-aq'], cut, cut.call!.startedAt),
      new RegExp(`^ps -aq at \\+0ms: signal SIGKILL after \\d+ms \\(pid ${cut.call!.pid}, spawn \\d+ms, bound 300ms, cut at \\d+ms\\)$`));

    const exited = await dockerCaller(exits, { PATH: '/usr/bin:/bin' }, 20_000)(['rm', '-f', 'c-1']);
    assert.deepEqual([exited.code, exited.signal, exited.stderr], [3, null, 'refused\n']);
    assert.equal(exited.call?.cutMs, 20_000);
    assert.equal(exited.call?.cutAfterMs, undefined, 'not cut');
    assert.ok((exited.call?.durationMs ?? Infinity) < 20_000);

    const missing = await dockerCaller(join(dir, 'missing'), { PATH: '/usr/bin:/bin' })(['ps', '-aq']);
    assert.equal(missing.code, -1);
    assert.equal(missing.call?.spawned, false);
    assert.equal(missing.call?.pid, undefined, 'a client that never started has no pid');
  } finally {
    await removeFakeDockerFixture(dir);
  }
});

// A removal that cannot show the container gone says what it asked the daemon,
// call by call: when each started, how it ended, how long it took against its
// bound, and whether its caller cut it there.
test('a removal that fails names each docker call it made, with its timing, end and bound', async () => {
  let now = 0;
  const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const timed = (argv: readonly string[], cutMs: number, durationMs: number, r: Omit<DockerResult, 'call'>): DockerResult => {
    const startedAt = 1_000_000 + now;
    now += durationMs;
    return {
      ...r,
      call: {
        argv: argv.slice(0, 2).join(' '), startedAt, spawnMs: 2, durationMs, cutMs,
        ...(r.signal ? { cutAfterMs: cutMs } : {}), spawned: true,
      },
    };
  };
  // `ps` hangs and is cut at what is left of the deadline.
  const hung: DockerCall = async (argv, opts = {}) =>
    timed(argv, opts.timeoutMs ?? 30_000, opts.timeoutMs ?? 30_000, { code: null, signal: 'SIGKILL', stdout: '', stderr: '' });
  const byLabel = await removeLabelledContainers(hung, 'asep.container=c-1', { until: 30_000, clock });
  assert.equal(byLabel, 'container(s) labelled asep.container=c-1 could not be shown removed in time: '
    + 'docker ps failed: killed by SIGKILL at its bound; '
    + 'calls: ps -aq at +0ms: signal SIGKILL after 30000ms (spawn 2ms, bound 30000ms, cut at 30000ms)');
  // `rm` is answered, `inspect` keeps showing the container.
  now = 0;
  const shown: DockerCall = async (argv, opts = {}) => (argv[0] === 'rm'
    ? timed(argv, opts.timeoutMs ?? 0, 40, { code: 0, signal: null, stdout: 'c-1\n', stderr: '' })
    : timed(argv, opts.timeoutMs ?? 0, 60, { code: 0, signal: null, stdout: 'f'.repeat(64), stderr: '' }));
  const byName = await removeContainerShownGone(shown, 'c-1', 1_000, { clock, attempts: 2, intervalMs: 100 });
  assert.equal(byName, 'container c-1 could not be shown removed in time: docker inspect still shows it; calls: '
    + 'rm -f at +0ms: exit 0 after 40ms (spawn 2ms, bound 1000ms); '
    + 'inspect --type at +40ms: exit 0 after 60ms (spawn 2ms, bound 960ms); '
    + 'rm -f at +200ms: exit 0 after 40ms (spawn 2ms, bound 800ms); '
    + 'inspect --type at +240ms: exit 0 after 60ms (spawn 2ms, bound 760ms)');
});

// Only "no such container" from inspect shows a container gone. An inspect
// that fails with anything else on stderr — the daemon's socket refused, no
// daemon, an error of its own — is no answer about the container, after an rm
// that succeeded or one that failed alike; nor is a `ps` that fails.
test('an inspect or ps that fails with any other error is never taken for absence', async () => {
  for (const [name, said] of DAEMON_ERRORS) {
    for (const rmCode of [0, 1]) {
      let now = 0;
      const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
      const inspectFails: DockerCall = async (argv) => {
        now += 10;
        if (argv[0] === 'rm') return { code: rmCode, stdout: rmCode === 0 ? 'c-1\n' : '', stderr: rmCode === 0 ? '' : said };
        return { code: 1, stdout: '', stderr: `${said}\n` };
      };
      const byName = await removeContainerShownGone(inspectFails, 'c-1', 2_000, { clock, attempts: 3 });
      assert.ok((byName ?? '').includes(`could not be shown removed in time: docker inspect failed: ${said}`),
        `${name}, rm exit ${rmCode}: ${byName}`);
    }
    let now = 0;
    const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
    const psFails: DockerCall = async () => { now += 10; return { code: 1, stdout: '', stderr: said }; };
    const byLabel = await removeLabelledContainers(psFails, 'asep.container=c-1', { until: 2_000, clock, attempts: 3 });
    assert.ok((byLabel ?? '').includes(`docker ps failed: ${said}`), `${name}: ${byLabel}`);
  }
});

// Removal on virtual time: what the removal helpers do with their deadline.
// The daemon answers each call after `costMs`, cut at the timeout it is
// given as the docker client's is, and shows the container until `goneAt`.
function virtualDaemon(goneAt: number, costMs: number) {
  let now = 0;
  const calls: { at: number; argv: readonly string[]; cut: number | undefined }[] = [];
  const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const docker: DockerCall = async (argv, opts = {}) => {
    calls.push({ at: now, argv, cut: opts.timeoutMs });
    const cut = opts.timeoutMs ?? Infinity;
    if (costMs > cut) {
      now += cut;
      return { code: null, stdout: '', stderr: '' };
    }
    now += costMs;
    const there = now < goneAt;
    if (argv[0] === 'ps') return { code: 0, stdout: there ? 'c-1\n' : '', stderr: '' };
    if (argv[0] === 'inspect') {
      return there ? { code: 0, stdout: 'f'.repeat(64), stderr: '' }
        : { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: c-1' };
    }
    return { code: 0, stdout: 'c-1\n', stderr: '' };
  };
  return { clock, docker, calls, at: (t: number) => { now = t; }, now: () => now };
}

// An answer is evidence only for the moment it arrives. A docker client that
// overruns the cut it was given — a stalled caller, a timer that fired late —
// may still answer that the container is gone, but if that answer arrives after
// the deadline it shows nothing about the deadline: neither helper takes it.
test('absence that arrives after the deadline is refused by both removal helpers', async () => {
  // The deadline is at 1 s; the daemon's answer, that nothing is there, arrives at 5 s.
  const lateAbsence = () => {
    let now = 0;
    const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
    const docker: DockerCall = async (argv) => {
      now += 5_000;
      if (argv[0] === 'ps') return { code: 0, stdout: '', stderr: '' };
      if (argv[0] === 'inspect') return { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: c-1' };
      return { code: 0, stdout: 'c-1\n', stderr: '' };
    };
    return { clock, docker };
  };
  const byLabel = lateAbsence();
  const runner = await removeLabelledContainers(byLabel.docker, 'asep.container=c-1', { until: 1_000, clock: byLabel.clock });
  assert.equal(runner?.split('; calls: ')[0], 'container(s) labelled asep.container=c-1 could not be shown removed in time: '
    + 'docker ps listed none only 4000ms after the deadline');
  const byName = lateAbsence();
  const agent = await removeContainerShownGone(byName.docker, 'c-1', 1_000, { clock: byName.clock });
  assert.equal(agent?.split('; calls: ')[0], 'container c-1 could not be shown removed in time: '
    + 'docker rm returned 4000ms after the deadline, leaving no time to show it gone');

  // The rm answers in time, the inspect's answer of absence comes late.
  let now = 0;
  const clock: TeardownClock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const lateInspect: DockerCall = async (argv) => {
    if (argv[0] === 'rm') { now += 100; return { code: 0, stdout: 'c-1\n', stderr: '' }; }
    now += 5_000;
    return { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: c-1' };
  };
  const late = await removeContainerShownGone(lateInspect, 'c-1', 1_000, { clock });
  assert.equal(late?.split('; calls: ')[0], 'container c-1 could not be shown removed in time: '
    + 'docker inspect showed it gone only 4100ms after the deadline');
});

test('a removal is shown gone only by the daemon, and never past its deadline', async () => {
  for (const [name, remove] of [
    ['by label', (v: ReturnType<typeof virtualDaemon>, until: number) =>
      removeLabelledContainers(v.docker, 'asep.container=c-1', { until, clock: v.clock, attempts: 1_000 })],
    ['by name', (v: ReturnType<typeof virtualDaemon>, until: number) =>
      removeContainerShownGone(v.docker, 'c-1', until, { clock: v.clock, attempts: 1_000 })],
  ] as const) {
    // Gone at 91 s; the deadline is 30 s after the client ended at 30 s.
    const late = virtualDaemon(91_000, 5_000);
    late.at(30_000);
    const left = await remove(late, 60_000);
    assert.match(left ?? '', /could not be shown removed in time/, name);
    assert.ok(late.now() <= 60_000, `${name}: the removal ended at ${late.now()} ms, past its deadline`);
    assert.ok(late.calls.every((c) => c.cut !== undefined && c.at + c.cut <= 60_000), `${name}: every call is cut at the deadline`);
    // Gone at 45 s: shown, within the deadline.
    const inTime = virtualDaemon(45_000, 5_000);
    inTime.at(30_000);
    assert.equal(await remove(inTime, 60_000), undefined, name);
    assert.ok(inTime.now() >= 45_000 && inTime.now() <= 60_000, name);
  }
});
