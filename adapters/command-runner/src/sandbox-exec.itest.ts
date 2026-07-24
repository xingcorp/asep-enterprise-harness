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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore } from '@asep/persistence';
import type { SqlClient } from '@asep/persistence';
import { TrustedCommandRunner } from './command-runner.js';
import { DockerSandboxProvider, type SandboxHandleEx } from './sandbox.js';
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
