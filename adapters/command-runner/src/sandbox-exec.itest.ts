// Real in-container execution suite (disp. P2-FINAL-HIGH-002, exit criteria
// F4/F5/G3/G5). Runs the TrustedCommandRunner against a REAL DockerSandboxProvider
// so the verification command executes INSIDE a digest-pinned container — not on
// the host, and not merely as an argv we build and throw away. This is the proof
// the review demanded: OS-enforced no-network + read-only rootfs + writable-only
// working tree, exercised by live commands.
//
// It is *.itest.ts so it runs ONLY under the integration gate
// (scripts/integration/run-integration.mjs), which guarantees a working docker
// binary on PATH. It fails closed (throws) if docker is unavailable — never a
// silent skip, unlike the unit suite's try/catch-SandboxUnavailableError shape.
//
//   F4  a command that attempts network egress FAILS under `--network none`
//       (the network canary) — OS-enforced, not policy-advisory.
//   F5  the container root filesystem is read-only: writing outside the mounted
//       working tree fails; writing INTO the writable working-tree mount works
//       and the bytes are visible on the host afterwards (containment proof).
//   G5  exact exit code from the in-container process is preserved (no coercion).
//   F3  a container never outlives the run that started it: its docker client
//       SIGKILLed mid-run, a timeout, a cancellation and a normal exit all leave
//       no container carrying the sandbox's label.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore } from '@asep/persistence';
import type { SqlClient } from '@asep/persistence';
import {
  TrustedCommandRunner, COMMAND_STOP_BOUND_MS, COMMAND_REMOVAL_BOUND_MS, type CommandLifecycleEvent,
} from './command-runner.js';
import { DockerSandboxProvider, type SandboxHandleEx } from './sandbox.js';
import { monotonicNow } from './container-teardown.js';
import type { CommandSpec } from '@asep/ports';
import type { OrganizationId, ProjectId, TenantScope, WorkspaceId } from '@asep/contracts';

console.log('SUITE-ID: asep-suite:sandbox-exec');

// alpine 3.20, digest-pinned (matches scripts/integration/images.mjs discipline).
const ALPINE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';
const OUTPUT_POLICY = { maxEvidenceBytes: 1_000_000, displayHeadBytes: 4096, displayTailBytes: 4096 };

function dockerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err) => resolve(!err));
  });
}

async function harness(): Promise<{
  client: SqlClient; store: ContentAddressedArtifactStore; scope: TenantScope; dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'asep-sbx-'));
  const client = await PgliteClient.create();
  await migrate(client);
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
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  const store = new ContentAddressedArtifactStore(client, objects);
  return { client, store, scope: { organizationId, projectId }, dir };
}

function spec(cwd: string, overrides: Partial<CommandSpec>): CommandSpec {
  return {
    executable: 'sh', args: ['-c', 'true'], cwd,
    environmentProfile: 'verification-no-network', timeoutMs: 30_000,
    outputPolicy: OUTPUT_POLICY, ...overrides,
  };
}

// The integration gate guarantees docker; fail CLOSED (never skip) if it is not
// reachable, matching HIGH-001/002's no-silent-skip contract.
test('HIGH-002 preflight: docker is reachable (fail closed, never skip)', async () => {
  assert.equal(await dockerReachable(), true, 'the integration gate must provide a working docker');
});

// ---------------------------------------------------------------------------
// F4 — network canary: egress is OS-blocked under --network none.
// ---------------------------------------------------------------------------

test('F4 (in-container): a network egress attempt FAILS under --network none', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const provider = new DockerSandboxProvider({ imageDigest: ALPINE });
    const handle = (await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as WorkspaceId,
      readOnlyPaths: [],
      writablePaths: [dir],
    })) as SandboxHandleEx;
    assert.equal(handle.isolationEnforced, true);

    const runner = new TrustedCommandRunner(scope, store);
    // BusyBox wget against a routable host. With no network device the DNS/
    // connect must fail → non-zero exit. A pass here would mean egress leaked.
    // Propagate wget's exit code as the sh exit code (a trailing `echo` would
    // otherwise mask it with its own exit 0). Both the stdout marker and the
    // preserved exit code must show failure.
    const res = await runner.run(
      spec(dir, {
        executable: 'sh',
        args: ['-c', 'wget -T 3 -q -O- http://1.1.1.1 2>&1; RC=$?; echo "EXIT=$RC"; exit $RC'],
      }),
      handle,
    );
    const out = new TextDecoder().decode((await store.get(scope, res.stdout)).content);
    assert.ok(!out.includes('EXIT=0'), `network egress must fail under --network none; got: ${out}`);
    assert.notEqual(res.exitCode, 0, 'the canary command reports a non-zero result');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F5 — read-only rootfs + writable-only working tree (containment proof).
// ---------------------------------------------------------------------------

test('F5 (in-container): the container root fs is read-only outside the mount', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const provider = new DockerSandboxProvider({ imageDigest: ALPINE });
    const handle = (await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as WorkspaceId,
      readOnlyPaths: [],
      writablePaths: [dir],
    })) as SandboxHandleEx;
    const runner = new TrustedCommandRunner(scope, store);
    // /etc is on the read-only root fs (not a mount) → the write must fail.
    const res = await runner.run(
      spec(dir, { executable: 'sh', args: ['-c', 'echo x > /etc/asep-probe 2>&1; echo "EXIT=$?"'] }),
      handle,
    );
    const out = new TextDecoder().decode((await store.get(scope, res.stdout)).content);
    assert.ok(!out.includes('EXIT=0'), `writing to read-only rootfs must fail; got: ${out}`);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F5 (in-container): writes INTO the writable working-tree mount persist to the host', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const provider = new DockerSandboxProvider({ imageDigest: ALPINE });
    const handle = (await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as WorkspaceId,
      readOnlyPaths: [],
      writablePaths: [dir],
    })) as SandboxHandleEx;
    const runner = new TrustedCommandRunner(scope, store);
    const marker = `asep-${Date.now()}`;
    const res = await runner.run(
      spec(dir, { executable: 'sh', args: ['-c', `printf '%s' "${marker}" > ${dir}/out.txt`] }),
      handle,
    );
    assert.equal(res.exitCode, 0, 'writing into the mounted working tree succeeds');
    // The bytes written inside the container are visible on the host mount.
    const host = await readFile(join(dir, 'out.txt'), 'utf8');
    assert.equal(host, marker, 'container write is visible on the host working tree');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HIGH-002 — the nested `.git` overlay is READ-ONLY through the writable parent.
//
// The review's exact finding: the slice mounted the whole worktree `rw`, and a
// linked worktree's `.git` indirection lives INSIDE that tree, so `.git` was
// writable through the parent mount. The unit suite only asserted that no mount
// spec literally said `.git:rw`, which a parent `rw` bind satisfies vacuously.
// This test ATTEMPTS THE WRITE for real and requires the kernel to refuse it.
// ---------------------------------------------------------------------------

test('HIGH-002 (in-container): rewriting .git through the writable parent mount FAILS', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    // A linked-worktree-shaped layout: `.git` is a FILE nested in the tree.
    await writeFile(join(dir, '.git'), 'gitdir: /somewhere/real/.git/worktrees/w\n');
    const before = await readFile(join(dir, '.git'), 'utf8');

    const provider = new DockerSandboxProvider({ imageDigest: ALPINE });
    const handle = (await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as WorkspaceId,
      readOnlyPaths: [],
      writablePaths: [dir],
      readOnlyOverlayPaths: [join(dir, '.git')],
    })) as SandboxHandleEx;
    assert.equal(handle.isolationEnforced, true);

    const runner = new TrustedCommandRunner(scope, store);
    // Repoint the gitdir from inside the sandbox. Under the nested :ro bind the
    // write must fail with EROFS; the exit code is propagated deliberately.
    const res = await runner.run(
      spec(dir, {
        executable: 'sh',
        args: ['-c', `printf 'gitdir: /pwned\\n' > ${dir}/.git 2>&1; RC=$?; echo "EXIT=$RC"; exit $RC`],
      }),
      handle,
    );
    const out = new TextDecoder().decode((await store.get(scope, res.stdout)).content);
    assert.ok(!out.includes('EXIT=0'), `writing .git must fail under the ro overlay; got: ${out}`);
    assert.notEqual(res.exitCode, 0, 'the .git write attempt reports a non-zero result');

    // And the host bytes are untouched: the guarantee is real, not cosmetic.
    assert.equal(await readFile(join(dir, '.git'), 'utf8'), before, '.git bytes are unchanged on the host');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HIGH-002 (in-container): the working tree AROUND .git stays writable', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    await writeFile(join(dir, '.git'), 'gitdir: /somewhere/real/.git/worktrees/w\n');
    const provider = new DockerSandboxProvider({ imageDigest: ALPINE });
    const handle = (await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as WorkspaceId,
      readOnlyPaths: [],
      writablePaths: [dir],
      readOnlyOverlayPaths: [join(dir, '.git')],
    })) as SandboxHandleEx;
    const runner = new TrustedCommandRunner(scope, store);
    // The overlay must pin ONLY .git — the agent still needs to edit source.
    const res = await runner.run(
      spec(dir, { executable: 'sh', args: ['-c', `printf 'src' > ${dir}/feature.txt`] }),
      handle,
    );
    assert.equal(res.exitCode, 0, 'source files in the working tree remain writable');
    assert.equal(await readFile(join(dir, 'feature.txt'), 'utf8'), 'src');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G5 — exact in-container exit code preserved (no 1 -> 0 coercion).
// ---------------------------------------------------------------------------

test('G5 (in-container): a non-zero exit code from the container is preserved exactly', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const provider = new DockerSandboxProvider({ imageDigest: ALPINE });
    const handle = (await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as WorkspaceId,
      readOnlyPaths: [],
      writablePaths: [dir],
    })) as SandboxHandleEx;
    const runner = new TrustedCommandRunner(scope, store);
    const res = await runner.run(spec(dir, { executable: 'sh', args: ['-c', 'exit 7'] }), handle);
    assert.equal(res.exitCode, 7, 'the container process exit code is preserved exactly');
    assert.equal(res.timedOut, false);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F3/G3 — a container never outlives its run. Killing a `docker run` client does
// not stop its container; the runner must remove it by its identity. The
// docker client here is a wrapper that records each client's pid and then
// execs the real one, so the test can SIGKILL exactly the client of the run.
// ---------------------------------------------------------------------------

async function pidRecordingDocker(dir: string): Promise<{ docker: string; runClientPid(): number }> {
  const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  const pids = join(dir, 'client-pids');
  const docker = join(dir, 'docker');
  await writeFile(docker, `#!/bin/sh\necho "$$ $1" >> '${pids}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return {
    docker,
    runClientPid() {
      return Number(readFileSync(pids, 'utf8').trim().split('\n').find((l) => l.endsWith(' run'))!.split(' ')[0]);
    },
  };
}

function containersLabelled(label: string, runningOnly = false): Promise<string[]> {
  const args = ['ps', '-aq', '--filter', `label=${label}`, ...(runningOnly ? ['--filter', 'status=running'] : [])];
  return new Promise((resolve, reject) => {
    execFile('docker', args, (err, stdout) => (err ? reject(err) : resolve(String(stdout).split(/\s+/).filter(Boolean))));
  });
}

async function until(what: string, ok: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = monotonicNow() + ms;
  while (!(await ok())) {
    if (monotonicNow() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function labelledSandbox(dir: string, docker: string): Promise<{ provider: DockerSandboxProvider; handle: SandboxHandleEx }> {
  const provider = new DockerSandboxProvider({ imageDigest: ALPINE, dockerBinary: docker });
  const handle = (await provider.start('verification-no-network', {
    workspaceId: 'W'.repeat(26) as WorkspaceId,
    readOnlyPaths: [],
    writablePaths: [dir],
    attemptId: 'A'.repeat(26) as never,
  })) as SandboxHandleEx;
  return { provider, handle };
}

test('F3 (in-container): SIGKILLing the docker client mid-run leaves no container behind', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await pidRecordingDocker(dir);
    const { provider, handle } = await labelledSandbox(dir, d.docker);
    const label = `asep.sandbox=${handle.sandboxId}`;
    const running = new TrustedCommandRunner(scope, store)
      .run(spec(dir, { executable: 'sleep', args: ['120'], timeoutMs: 120_000 }), handle);
    await until('the container to be running', async () => (await containersLabelled(label, true)).length === 1);
    process.kill(d.runClientPid(), 'SIGKILL');
    const res = await running;
    assert.equal(res.signal, 'SIGKILL', 'the client died of the signal, not the command');
    assert.deepEqual(await containersLabelled(label), [], 'the container was removed, not left running');
    await provider.stop(handle);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// How late, on a loaded host, the runner may act on its timeout, and a docker
// client end after its call's timeout: the allowance added to the runner's
// own bounds.
const SCHEDULING_ALLOWANCE_MS = 2_000;

test('F3 (in-container): a timeout removes the container itself', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await pidRecordingDocker(dir);
    const { provider, handle } = await labelledSandbox(dir, d.docker);
    const lifecycle: CommandLifecycleEvent[] = [];
    const timeoutMs = 3_000;
    const res = await new TrustedCommandRunner(scope, store, undefined, (e) => { lifecycle.push(e); })
      .run(spec(dir, { executable: 'sleep', args: ['120'], timeoutMs }), handle);
    const t0 = lifecycle[0]?.at ?? 0;
    const shown = lifecycle.map((e) => `+${e.at - t0}ms ${e.phase}${e.reason !== undefined ? `(${e.reason})` : ''}`).join(' ');
    console.log('timed-out command timeline:', shown);
    assert.equal(res.timedOut, true);
    const at = (phase: CommandLifecycleEvent['phase']): CommandLifecycleEvent => {
      const found = lifecycle.filter((e) => e.phase === phase);
      assert.equal(found.length, 1, `exactly one '${phase}' moment: ${shown}`);
      return found[0]!;
    };
    // Measured from the runner's own timer and its own stop, never from a start
    // that includes the container's: the timeout fired when it was due, the
    // command was stopped within one docker call of it, and the container was
    // shown gone within the removal bound of its client's end — 'removed' is
    // reported only once `docker ps -a` lists none, so a removal not shown in
    // time fails here on its absence.
    const stop = at('stop');
    assert.equal(stop.reason, 'timeout', shown);
    const late = stop.at - at('spawned').at - timeoutMs;
    assert.ok(late >= -50 && late <= SCHEDULING_ALLOWANCE_MS, `the timeout fired ${late} ms off its due time: ${shown}`);
    assert.ok(at('exited').at - stop.at <= COMMAND_STOP_BOUND_MS + SCHEDULING_ALLOWANCE_MS,
      `the command ended ${at('exited').at - stop.at} ms after its stop: ${shown}`);
    const removedAfter = at('removed').at - at('exited').at;
    assert.ok(removedAfter >= 0 && removedAfter <= COMMAND_REMOVAL_BOUND_MS + SCHEDULING_ALLOWANCE_MS,
      `the container was shown gone ${removedAfter} ms after its client ended; the bound is `
        + `${COMMAND_REMOVAL_BOUND_MS} ms + ${SCHEDULING_ALLOWANCE_MS} ms: ${shown}`);
    assert.ok(at('removed').at - stop.at <= COMMAND_STOP_BOUND_MS + COMMAND_REMOVAL_BOUND_MS + SCHEDULING_ALLOWANCE_MS,
      `the container was shown gone ${at('removed').at - stop.at} ms after its stop: ${shown}`);
    assert.deepEqual(await containersLabelled(`asep.sandbox=${handle.sandboxId}`), []);
    await provider.stop(handle);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F3 (in-container): a cancellation removes the container, and a normal exit leaves none', async () => {
  const { client, store, scope, dir } = await harness();
  try {
    const d = await pidRecordingDocker(dir);
    const { provider, handle } = await labelledSandbox(dir, d.docker);
    const label = `asep.sandbox=${handle.sandboxId}`;
    const ac = new AbortController();
    const runner = new TrustedCommandRunner(scope, store, ac.signal);
    const running = runner.run(spec(dir, { executable: 'sleep', args: ['120'], timeoutMs: 120_000 }), handle);
    await until('the container to be running', async () => (await containersLabelled(label, true)).length === 1);
    ac.abort();
    await running;
    assert.deepEqual(await containersLabelled(label), [], 'cancelled: removed');

    const done = await new TrustedCommandRunner(scope, store)
      .run(spec(dir, { executable: 'sh', args: ['-c', 'exit 3'] }), handle);
    assert.equal(done.exitCode, 3);
    assert.deepEqual(await containersLabelled(label), [], 'exited: nothing left');
    await provider.stop(handle);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
