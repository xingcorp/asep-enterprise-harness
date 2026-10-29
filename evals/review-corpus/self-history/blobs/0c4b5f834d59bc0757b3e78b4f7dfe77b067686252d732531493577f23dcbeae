// Claude coding provider contract suite (exit criteria G1–G6, disp.
// P2-PLAN-HIGH-002). Drives the REAL ClaudeCodingProvider against REAL fake CLI
// executables (small node scripts written to temp files) over the actual
// spawn/stdout boundary — never a mocked child process. Each scenario gets its
// OWN dedicated fake script (the provider sanitizes the child env down to
// PATH/HOME/LANG/ASEP_* tool-policy vars, so scenario selection can NOT be
// passed through env — that stripping is itself the G3/G5 property under test).
//
// A real content-addressed artifact store (pglite + filesystem objects) receives
// the raw event stream, so G4 evidence capture is exercised end to end.
//
// Machine-readable suite marker (exit criterion K4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodingProvider } from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import type { ArtifactStore, AgentExecuteRequest } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope, WorkspaceId, AttemptId, ArtifactRef,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:agent-claude');

const scope: TenantScope = {
  organizationId: 'A'.repeat(26) as OrganizationId,
  projectId: 'B'.repeat(26) as ProjectId,
};

async function buildStore(dir: string): Promise<ArtifactStore> {
  const db = await PgliteClient.create();
  await migrate(db);
  // Seed org/project rows so the artifact scope columns are satisfiable.
  await db.query('insert into organizations (id, name) values ($1, $2)', [scope.organizationId, 'Acme']);
  await db.query('insert into projects (id, organization_id, name, default_branch) values ($1,$2,$3,$4)',
    [scope.projectId, scope.organizationId, 'web', 'main']);
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  return new ContentAddressedArtifactStore(db, objects);
}

// Emit-helpers reused inside the fake scripts (kept as source strings).
const HELPERS = `
const good = {
  system: JSON.stringify({ type: 'system', sessionId: 'sess-abc' }),
  tool: JSON.stringify({ type: 'tool_use', name: 'edit_file' }),
  result: JSON.stringify({
    type: 'result', status: 'AGENT_DONE', summary: 'did the thing',
    usage: { inputTokens: 10, outputTokens: 20, modelCostUsd: 0.01, toolCalls: 1, wallClockMs: 5 },
    knownLimitations: ['none'],
  }),
};
function emit(lines) { process.stdout.write(lines.join('\\n') + '\\n'); }
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
`;

// Per-scenario fake CLI bodies. Each is a complete node script (shebang added by
// the writer). They speak stream-JSON on stdout exactly like the real Claude CLI.
const FAKES: Record<string, string> = {
  ok: `emit([good.system, good.tool, good.result]);`,
  malformed: `emit([good.system, '{"type":"bogus","x":1}']);`,
  notjson: `emit([good.system, 'this is not json at all']);`,
  partial: `emit([good.system, good.tool]);`,
  nonzero: `process.stderr.write('quota exceeded: 429\\n'); process.exit(7);`,
  hang: `setInterval(() => {}, 1000);`,
  echoEnv: `emit([good.system, JSON.stringify({
    type: 'result', status: 'AGENT_DONE',
    summary: 'env=' + Object.keys(process.env).sort().join(','),
    usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 1 },
    knownLimitations: [],
  })]);`,
  attemptCommit: `emit([good.system, JSON.stringify({
    type: 'result', status: 'AGENT_DONE',
    summary: 'I committed abcdef and pushed to main',
    usage: { inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1 },
    knownLimitations: [],
  })]);`,
  // Reads its identity from the --workspace argv the provider passes, sleeps so
  // concurrent runs overlap, then stamps that tag into the session id + summary.
  tagged: `const ws = argOf('--workspace') || 'none';
    setTimeout(() => emit([
      JSON.stringify({ type: 'system', sessionId: ws }),
      JSON.stringify({
        type: 'result', status: 'AGENT_DONE', summary: 'tag=' + ws,
        usage: { inputTokens: 0, outputTokens: 0, modelCostUsd: 0, toolCalls: 0, wallClockMs: 1 },
        knownLimitations: [],
      }),
    ]), 60);`,
};

async function writeFake(dir: string, name: string): Promise<string> {
  const path = join(dir, `fake-${name}.mjs`);
  await writeFile(path, `#!/usr/bin/env node\n${HELPERS}\n${FAKES[name]}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

let workRef: ArtifactRef;
let ctxRef: ArtifactRef;

function baseRequest(overrides: Partial<AgentExecuteRequest> = {}): AgentExecuteRequest {
  const ac = new AbortController();
  return {
    attemptId: 'D'.repeat(26) as AttemptId,
    workOrderRef: workRef,
    contextPackRef: ctxRef,
    workspace: { workspaceId: 'W'.repeat(26) as WorkspaceId, leaseId: 'lease-1' },
    budget: { maxTurns: 5, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMinutes: 5 },
    toolPolicy: { allowedTools: ['edit_file'], disallowedTools: ['run_command'], networkProfile: 'no-network' },
    signal: ac.signal,
    ...overrides,
  };
}

async function setupRefs(store: ArtifactStore): Promise<void> {
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const wr = new TextEncoder().encode('work order body');
  const cr = new TextEncoder().encode('context pack body');
  workRef = await store.put(scope, { kind: 'work-order', content: wr, sha256: sha(wr), contentType: 'text/plain' });
  ctxRef = await store.put(scope, { kind: 'context-pack', content: cr, sha256: sha(cr), contentType: 'text/plain' });
}

function makeProvider(cli: string, store: ArtifactStore): ClaudeCodingProvider {
  return new ClaudeCodingProvider(
    { executable: cli, model: 'claude-test', cliVersion: '0.0.0-test', maxTurns: 5 },
    scope, store,
  );
}

test('G1/G2/G4: a well-formed stream yields an untrusted observation with pinned provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-ok-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const cli = await writeFake(dir, 'ok');
    const provider = makeProvider(cli, store);
    assert.equal(provider.providerId, 'claude:claude-test@cli-0.0.0-test');
    const obs = await provider.execute(baseRequest());
    assert.equal(obs.status, 'AGENT_DONE');
    assert.equal(obs.summary, 'did the thing');
    assert.equal(obs.providerSessionId, 'sess-abc');
    assert.equal(obs.usage.toolCalls, 1);
    // G4: the raw event stream was captured to an immutable artifact.
    assert.equal(obs.eventArtifactRefs.length, 1);
    const back = await store.get(scope, obs.eventArtifactRefs[0]!);
    assert.match(new TextDecoder().decode(back.content), /"type":"result"/);
    // G5: no harness-owned facts leak from the provider.
    assert.equal((obs as unknown as Record<string, unknown>)['attemptId'], undefined);
    assert.equal((obs as unknown as Record<string, unknown>)['resultSha'], undefined);
    assert.equal((obs as unknown as Record<string, unknown>)['changedFiles'], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G2: an unknown event type fails closed (FAILED, not AGENT_DONE)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-malformed-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const obs = await makeProvider(await writeFake(dir, 'malformed'), store).execute(baseRequest());
    assert.equal(obs.status, 'FAILED');
    assert.match(obs.knownLimitations.join(' '), /malformed/i);
    // Evidence is still captured even on a fail-closed parse.
    assert.equal(obs.eventArtifactRefs.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G2: a non-JSON line mid-stream fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-notjson-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const obs = await makeProvider(await writeFake(dir, 'notjson'), store).execute(baseRequest());
    assert.equal(obs.status, 'FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G2: a partial stream with no result event fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-partial-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const obs = await makeProvider(await writeFake(dir, 'partial'), store).execute(baseRequest());
    assert.equal(obs.status, 'FAILED');
    assert.match(obs.knownLimitations.join(' '), /truncated|partial|no result/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G3/G6: a non-zero exit (quota/permission) fails closed and surfaces stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-nonzero-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const obs = await makeProvider(await writeFake(dir, 'nonzero'), store).execute(baseRequest());
    assert.equal(obs.status, 'FAILED');
    assert.match(obs.knownLimitations.join(' '), /exited 7|quota/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G3: an already-aborted signal blocks before start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-preabort-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const ac = new AbortController();
    ac.abort();
    const obs = await makeProvider(await writeFake(dir, 'hang'), store)
      .execute(baseRequest({ signal: ac.signal }));
    assert.equal(obs.status, 'BLOCKED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G3: cancellation during a hung run kills the child and fails closed promptly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-cancel-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const ac = new AbortController();
    const started = Date.now();
    const p = makeProvider(await writeFake(dir, 'hang'), store)
      .execute(baseRequest({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    const obs = await p;
    assert.equal(obs.status, 'BLOCKED');
    assert.ok(Date.now() - started < 5000, 'cancellation should return promptly');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G3/G5: no GitHub credential or *_TOKEN reaches the child env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-env-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    // Poison the parent env with credentials the agent must NEVER see.
    process.env.GITHUB_TOKEN = 'ghp_supersecret';
    process.env.GH_TOKEN = 'gho_secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret';
    const obs = await makeProvider(await writeFake(dir, 'echoEnv'), store).execute(baseRequest());
    assert.equal(obs.status, 'AGENT_DONE');
    const envKeys = obs.summary.replace(/^env=/, '');
    assert.doesNotMatch(envKeys, /GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY/,
      'credential vars must be stripped from the agent environment');
  } finally {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('G5: an agent CLAIMING it committed/pushed cannot inject harness-owned facts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-commit-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const obs = await makeProvider(await writeFake(dir, 'attemptCommit'), store).execute(baseRequest());
    // The claim is preserved only as advisory summary text; the observation
    // shape carries NO resultSha/changedFiles the harness could ever trust.
    assert.equal(obs.status, 'AGENT_DONE');
    assert.equal((obs as unknown as Record<string, unknown>)['resultSha'], undefined);
    assert.equal((obs as unknown as Record<string, unknown>)['changedFiles'], undefined);
    assert.equal((obs as unknown as Record<string, unknown>)['attemptId'], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G5: concurrent attempts through one adapter show no state crossover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-concurrent-'));
  try {
    const store = await buildStore(dir);
    await setupRefs(store);
    const provider = makeProvider(await writeFake(dir, 'tagged'), store);
    // Each request carries a DISTINCT workspaceId; the fake echoes it via argv
    // (not shared env), so a crossover of any per-call mutable state would show
    // as a swapped tag. Both fakes sleep 60ms so the runs genuinely overlap.
    const wsA = ('WA' + 'a'.repeat(24)) as unknown as WorkspaceId;
    const wsB = ('WB' + 'b'.repeat(24)) as unknown as WorkspaceId;
    const reqA = baseRequest({ workspace: { workspaceId: wsA, leaseId: 'lease-A' } });
    const reqB = baseRequest({ workspace: { workspaceId: wsB, leaseId: 'lease-B' } });
    const [obsA, obsB] = await Promise.all([provider.execute(reqA), provider.execute(reqB)]);
    assert.equal(obsA.status, 'AGENT_DONE');
    assert.equal(obsB.status, 'AGENT_DONE');
    assert.equal(obsA.summary, `tag=${wsA}`);
    assert.equal(obsB.summary, `tag=${wsB}`);
    assert.equal(obsA.providerSessionId, wsA);
    assert.equal(obsB.providerSessionId, wsB);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
