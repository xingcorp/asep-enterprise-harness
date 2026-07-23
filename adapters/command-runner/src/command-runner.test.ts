// Command runner + sandbox suite (exit criteria F1–F6, D5). The runner is
// exercised for real (spawned child processes on this host); the Docker sandbox
// is exercised for its construction/validation invariants without requiring a
// Docker daemon, and the honest local fallback documents the no-isolation case.
//
// Machine-readable suite marker (K4) so a dropped/renamed/crashed runner suite
// turns the gate RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore } from '@asep/persistence';
import type { SqlClient } from '@asep/persistence';
import { TrustedCommandRunner } from './command-runner.js';
import { BoundedCapture, TRUNCATION_MARKER } from './bounded-capture.js';
import { resolveEnvironment, UnknownEnvironmentProfileError } from './environment-profiles.js';
import {
  DockerSandboxProvider, LocalUnsandboxedProvider, SandboxUnavailableError,
  type SandboxHandleEx,
} from './sandbox.js';
import type { CommandSpec, SandboxHandle } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:command-runner');

const OUTPUT_POLICY = { maxEvidenceBytes: 1_000_000, displayHeadBytes: 4096, displayTailBytes: 4096 };

// A dummy sandbox handle — the runner treats it as an opaque execution context.
const HANDLE: SandboxHandle = { sandboxId: 'test', profile: 'verification-no-network' };

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
    const res = await runner.run(spec({ args: ['-e', 'process.exit(7)'] }), HANDLE);
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
    const res = await runner.run(spec({ args: ['-e', 'process.stdout.write("hello-evidence")'] }), HANDLE);
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
      HANDLE,
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
      HANDLE,
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
      HANDLE,
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
      HANDLE,
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

test('F5: a digest-pinned Docker sandbox builds a hardened run prefix', async () => {
  const provider = new DockerSandboxProvider({
    imageDigest: `node@sha256:${'a'.repeat(64)}`,
  });
  // If docker is unavailable this throws SandboxUnavailableError (fail-closed,
  // never a silent skip). If available, the prefix must carry every hardening
  // flag. Either outcome is acceptable evidence; we assert whichever occurs.
  try {
    const handle = await provider.start('verification-no-network', {
      workspaceId: 'W'.repeat(26) as never,
      readOnlyPaths: [], writablePaths: [],
    }) as SandboxHandleEx;
    assert.equal(handle.isolationEnforced, true);
    const p = handle.dockerRunPrefix!.join(' ');
    assert.ok(p.includes('--network none'), 'no network');
    assert.ok(p.includes('--read-only'), 'read-only rootfs');
    assert.ok(p.includes('--cap-drop ALL'), 'caps dropped');
    assert.ok(p.includes('--security-opt no-new-privileges'), 'no-new-privileges');
    assert.ok(p.includes('--pids-limit'), 'pid limit');
    assert.ok(!p.includes('docker.sock'), 'no docker socket mounted');
  } catch (err) {
    assert.ok(err instanceof SandboxUnavailableError, 'fails closed when docker absent');
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
