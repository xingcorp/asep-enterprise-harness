// Real in-container agent-execution suite (disp. P2-FINAL-HIGH-002, exit
// criteria G3/G5, F4/F5). Drives the REAL ClaudeCodingProvider with a sandbox
// config so the agent CLI executes INSIDE a digest-pinned container via
// `docker run <hardened flags> -e <allowlist…> <image> <fake-cli> <args…>` —
// not on the host. This is the proof the review demanded: the agent, like the
// verification runner, runs under OS-enforced isolation, and the ONLY env it
// sees is the explicit allowlist (no host GITHUB_TOKEN / *_TOKEN can leak in).
//
// It is *.itest.ts so it runs ONLY under the integration gate
// (scripts/integration/run-integration.mjs), which guarantees a working docker
// binary. It fails closed (throws) if docker is unavailable — never a silent
// skip, unlike the fake-CLI unit suite's host-spawn path.
//
//   G5  the agent process runs in-container: a POSIX-sh fake CLI is interpreted
//       by the container's /bin/sh and its stream-JSON is captured + parsed.
//   G3  env allowlist is OS-real: the harness process is poisoned with
//       GITHUB_TOKEN / GH_TOKEN / AWS_SECRET_ACCESS_KEY, yet the container sees
//       leak=no because docker forwards ONLY the explicit `-e` allowlist.
//   F4  a network egress attempt from the agent FAILS under --network none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ClaudeCodingProvider, type AgentSandboxConfig } from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import type { ArtifactStore, AgentExecuteRequest } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope, WorkspaceId, AttemptId, ArtifactRef,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:agent-sandbox');

// alpine 3.20, digest-pinned (matches scripts/integration/images.mjs discipline).
const ALPINE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

const scope: TenantScope = {
  organizationId: 'A'.repeat(26) as OrganizationId,
  projectId: 'B'.repeat(26) as ProjectId,
};

function dockerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err) => resolve(!err));
  });
}

async function buildStore(dir: string): Promise<{ store: ArtifactStore; close: () => Promise<void> }> {
  const db = await PgliteClient.create();
  await migrate(db);
  await db.query('insert into organizations (id, name) values ($1, $2)', [scope.organizationId, 'Acme']);
  await db.query('insert into projects (id, organization_id, name, default_branch) values ($1,$2,$3,$4)',
    [scope.projectId, scope.organizationId, 'web', 'main']);
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  return { store: new ContentAddressedArtifactStore(db, objects), close: () => db.close() };
}

// Hardened `docker run` flags (no image) mirroring DockerSandboxProvider, with
// the working tree bind-mounted rw so the fake CLI script is visible in-container.
function runFlags(dir: string): string[] {
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '512m',
    '-v', `${dir}:${dir}:rw`,
  ];
}

// A POSIX-sh fake Claude CLI. It ignores the --model/--work-order-ref/etc argv
// the provider passes, reports whether any forbidden host credential leaked into
// the container env, echoes the allowlisted network profile, and emits a valid
// stream-JSON result. Optionally attempts a network egress first (canary).
function fakeCliBody(withCanary: boolean): string {
  const canary = withCanary
    ? 'wget -T 3 -q -O- http://1.1.1.1 >/dev/null 2>&1 && NET=up || NET=down\n'
    : 'NET=skip\n';
  return `#!/bin/sh
printf '%s\\n' '{"type":"system","sessionId":"sess-itest"}'
LEAK=no
if [ -n "$GITHUB_TOKEN" ] || [ -n "$GH_TOKEN" ] || [ -n "$AWS_SECRET_ACCESS_KEY" ]; then LEAK=yes; fi
${canary}printf '{"type":"result","status":"AGENT_DONE","summary":"leak=%s net=%s profile=%s","usage":{"inputTokens":0,"outputTokens":0,"modelCostUsd":0,"toolCalls":0,"wallClockMs":1},"knownLimitations":[]}\\n' "$LEAK" "$NET" "$ASEP_NETWORK_PROFILE"
`;
}

async function writeFakeCli(dir: string, withCanary: boolean): Promise<string> {
  const path = join(dir, 'fake-claude-cli.sh');
  await writeFile(path, fakeCliBody(withCanary), 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function setupRefs(store: ArtifactStore): Promise<{ workRef: ArtifactRef; ctxRef: ArtifactRef }> {
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const wr = new TextEncoder().encode('work order body');
  const cr = new TextEncoder().encode('context pack body');
  const workRef = await store.put(scope, { kind: 'work-order', content: wr, sha256: sha(wr), contentType: 'text/plain' });
  const ctxRef = await store.put(scope, { kind: 'context-pack', content: cr, sha256: sha(cr), contentType: 'text/plain' });
  return { workRef, ctxRef };
}

function baseRequest(workRef: ArtifactRef, ctxRef: ArtifactRef): AgentExecuteRequest {
  const ac = new AbortController();
  return {
    attemptId: 'D'.repeat(26) as AttemptId,
    workOrderRef: workRef,
    contextPackRef: ctxRef,
    workspace: { workspaceId: 'W'.repeat(26) as WorkspaceId, leaseId: 'lease-1' },
    budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 },
    toolPolicy: { allowedTools: ['edit_file'], disallowedTools: ['run_command'], networkProfile: 'no-network' },
    signal: ac.signal,
  };
}

// The integration gate guarantees docker; fail CLOSED (never skip) if not.
test('HIGH-002 preflight: docker is reachable (fail closed, never skip)', async () => {
  assert.equal(await dockerReachable(), true, 'the integration gate must provide a working docker');
});

// ---------------------------------------------------------------------------
// G5 — the agent CLI runs IN-CONTAINER and its stream-JSON is captured/parsed.
// G3 — the env allowlist is OS-real: no poisoned host credential leaks in.
// ---------------------------------------------------------------------------

test('G3/G5 (in-container): agent runs in the sandbox and NO host credential leaks into it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-sbx-'));
  const { store, close } = await buildStore(dir);
  // Poison the harness process env with credentials the agent must NEVER see.
  process.env.GITHUB_TOKEN = 'ghp_must_not_leak';
  process.env.GH_TOKEN = 'gho_must_not_leak';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws_must_not_leak';
  try {
    const { workRef, ctxRef } = await setupRefs(store);
    const cli = await writeFakeCli(dir, false);
    const sandbox: AgentSandboxConfig = { image: ALPINE, runFlags: runFlags(dir), workdir: dir };
    const provider = new ClaudeCodingProvider(
      { executable: cli, model: 'claude-test', cliVersion: '0.0.0-test', maxTurns: 5, sandbox },
      scope, store,
    );
    const obs = await provider.execute(baseRequest(workRef, ctxRef));
    assert.equal(obs.status, 'AGENT_DONE', `agent should complete in-container; got ${obs.summary}`);
    assert.match(obs.summary, /leak=no/, 'no host credential may leak into the container env');
    assert.match(obs.summary, /profile=no-network/, 'the allowlisted ASEP_NETWORK_PROFILE must reach the agent');
    // The raw event stream was captured to an immutable artifact (G4).
    assert.equal(obs.eventArtifactRefs.length, 1);
  } finally {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F4 — network canary: the agent's egress attempt fails under --network none.
// ---------------------------------------------------------------------------

test('F4 (in-container): an agent network egress attempt FAILS under --network none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-net-'));
  const { store, close } = await buildStore(dir);
  try {
    const { workRef, ctxRef } = await setupRefs(store);
    const cli = await writeFakeCli(dir, true);
    const sandbox: AgentSandboxConfig = { image: ALPINE, runFlags: runFlags(dir), workdir: dir };
    const provider = new ClaudeCodingProvider(
      { executable: cli, model: 'claude-test', cliVersion: '0.0.0-test', maxTurns: 5, sandbox },
      scope, store,
    );
    const obs = await provider.execute(baseRequest(workRef, ctxRef));
    assert.equal(obs.status, 'AGENT_DONE');
    assert.match(obs.summary, /net=down/, 'network egress must fail under --network none (canary)');
    assert.doesNotMatch(obs.summary, /net=up/, 'a reachable network would mean egress leaked');
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
