// OPT-IN live proofs for the Claude provider. NOT part of any gate: they need a
// real CLI and (for the first) a real model credential, so they skip cleanly —
// with the reason printed — when those are not configured (exit G6).
//
//   pnpm test:live:claude
//
// 1. LIVE (K2 prerequisite): the real pinned CLI, baked into a digest-pinned
//    agent image, run by the real provider under real Docker, through the real
//    egress proxy, against the real model API with a real key. The agent is
//    asked for one small, checkable change in a throwaway worktree.
//    Requires:
//      ASEP_LIVE_CLAUDE=1
//      ASEP_ANTHROPIC_API_KEY_FILE     a file holding the key (mode 600)
//      ASEP_AGENT_IMAGE_DIGEST         image@sha256:… containing the CLI
//      ASEP_EGRESS_PROXY_IMAGE_DIGEST  image@sha256:… with node on PATH
//      ASEP_CLAUDE_EXECUTABLE          the CLI's path inside the agent image
//      ASEP_CLAUDE_CLI_VERSION         e.g. 2.1.286 (checked against system/init)
//      ASEP_CLAUDE_MODEL               a full model id (checked against system/init)
//    Optional: ASEP_ANTHROPIC_BASE_URL (default https://api.anthropic.com).
//
// 2. CLI CONFORMANCE: the real CLI binary on THIS host, driven by the real
//    provider through the fake docker client (so the CLI runs as a host process,
//    uncontained), the real egress proxy and a fake model API. No credential
//    and no network. It proves the provider's exact argv, its prompt channel and
//    the real CLI's stream-json against the real parser — the facts the strict
//    fake CLI stands in for in the gate.
//    Requires: ASEP_CLAUDE_CONFORMANCE_CLI=<path to a claude binary>.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCodingProvider, FileModelCredentialProvider } from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import type { AgentAttemptObservation, AgentExecuteRequest } from '@asep/ports';
import type {
  OrganizationId, ProjectId, TenantScope, WorkspaceId, AttemptId, ArtifactRef,
} from '@asep/contracts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TESTING = join(REPO, 'scripts', 'testing');
const scope: TenantScope = {
  organizationId: 'A'.repeat(26) as OrganizationId,
  projectId: 'B'.repeat(26) as ProjectId,
};

const LIVE_VARS = [
  'ASEP_ANTHROPIC_API_KEY_FILE', 'ASEP_AGENT_IMAGE_DIGEST', 'ASEP_EGRESS_PROXY_IMAGE_DIGEST',
  'ASEP_CLAUDE_EXECUTABLE', 'ASEP_CLAUDE_CLI_VERSION', 'ASEP_CLAUDE_MODEL',
];
const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};
const liveSkip = env('ASEP_LIVE_CLAUDE') !== '1'
  ? 'set ASEP_LIVE_CLAUDE=1 (and the variables listed in this file) to run the live Claude proof'
  : LIVE_VARS.filter((k) => env(k) === undefined).length > 0
    ? `missing ${LIVE_VARS.filter((k) => env(k) === undefined).join(', ')}`
    : false;
const conformanceSkip = env('ASEP_CLAUDE_CONFORMANCE_CLI') === undefined
  ? 'set ASEP_CLAUDE_CONFORMANCE_CLI=<path to a claude binary> to run the CLI conformance proof'
  : false;

async function workspace(dir: string): Promise<string> {
  const seed = join(dir, 'seed');
  const mirror = join(dir, 'mirror.git');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), '# live pilot scratch repository\n');
  const git = (...a: string[]) => execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
  execFileSync('git', ['clone', '-q', '--bare', seed, mirror]);
  const wt = join(dir, 'wt');
  execFileSync('git', ['--git-dir', mirror, 'worktree', 'add', '-q', '--detach', wt, 'main']);
  return wt;
}

async function storeIn(dir: string) {
  const db = await PgliteClient.create();
  await migrate(db);
  await db.query('insert into organizations (id, name) values ($1, $2)', [scope.organizationId, 'Acme']);
  await db.query('insert into projects (id, organization_id, name, default_branch) values ($1,$2,$3,$4)',
    [scope.projectId, scope.organizationId, 'web', 'main']);
  // One attempt row: the provider links the artifacts it records to it.
  const ids = { binding: 'E'.repeat(26), run: 'F'.repeat(26), task: 'G'.repeat(26) };
  await db.query(`insert into repository_bindings
    (id, organization_id, project_id, forge, github_host, github_owner, github_repo, default_base_branch)
    values ($1, $2, $3, 'github', 'github.com', 'acme', 'web', 'main')`, [ids.binding, scope.organizationId, scope.projectId]);
  await db.query(`insert into runs (id, organization_id, project_id, repository_binding_id, status, risk)
    values ($1, $2, $3, $4, 'EXECUTING', 'R0')`, [ids.run, scope.organizationId, scope.projectId, ids.binding]);
  await db.query(`insert into tasks (id, organization_id, project_id, run_id, repository_binding_id, status, risk)
    values ($1, $2, $3, $4, $5, 'EXECUTING', 'R0')`, [ids.task, scope.organizationId, scope.projectId, ids.run, ids.binding]);
  await db.query(`insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status)
    values ($1, $2, $3, $4, $5, 'AGENT_RUNNING')`, [ATTEMPT, scope.organizationId, scope.projectId, ids.task, ids.binding]);
  const store = new ContentAddressedArtifactStore(db, new FilesystemObjectStore(join(dir, 'objects')));
  const put = async (kind: string, value: unknown): Promise<ArtifactRef> => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return store.put(scope, {
      kind, content: bytes, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'application/json',
    });
  };
  return { db, store, put };
}

const ATTEMPT = `L${randomUUID().replace(/-/g, '').slice(0, 25).toUpperCase()}` as AttemptId;

function request(workOrderRef: ArtifactRef, contextPackRef: ArtifactRef): AgentExecuteRequest {
  return {
    attemptId: ATTEMPT,
    workOrderRef, contextPackRef,
    workspace: { workspaceId: 'W'.repeat(26) as WorkspaceId, leaseId: 'lease-live' },
    budget: { maxTurns: 8, maxToolCalls: 20, maxCostUsd: 0.5, maxWallClockMinutes: 5 },
    toolPolicy: { allowedTools: ['read', 'write'], disallowedTools: ['bash'], networkProfile: 'restricted-egress' },
    signal: new AbortController().signal,
  };
}

async function egressLog(store: ContentAddressedArtifactStore, obs: AgentAttemptObservation): Promise<string> {
  const ref = obs.eventArtifactRefs.find((r) => r.kind === 'claude-egress-log');
  assert.ok(ref, 'the egress access log is recorded');
  return new TextDecoder().decode((await store.get(scope, ref)).content);
}

function assertNoSecret(dir: string, obs: AgentAttemptObservation, secret: string): void {
  const files = readdirSync(join(dir, 'objects'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  for (const f of files) {
    assert.ok(!readFileSync(join(f.parentPath, f.name), 'utf8').includes(secret), `${f.name} holds no key`);
  }
  assert.ok(!JSON.stringify(obs).includes(secret));
}

test('LIVE: the real Claude CLI, contained, makes one real change through the egress proxy', { skip: liveSkip }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-live-')));
  const { db, store, put } = await storeIn(dir);
  try {
    const wt = await workspace(dir);
    const line = `hello from the ASEP live pilot ${randomUUID().slice(0, 8)}`;
    const workOrderRef = await put('work-order', {
      objective: `Create a file named HELLO.md at the repository root containing exactly one line: ${line}`,
      constraints: ['Change nothing else.', 'Do not run any command.'],
    });
    const contextPackRef = await put('context-pack', { relevantFiles: ['README.md'] });
    const keyFile = env('ASEP_ANTHROPIC_API_KEY_FILE')!;
    const provider = new ClaudeCodingProvider(
      {
        executable: env('ASEP_CLAUDE_EXECUTABLE')!,
        model: env('ASEP_CLAUDE_MODEL')!,
        cliVersion: env('ASEP_CLAUDE_CLI_VERSION')!,
        maxTurns: 8,
        sandbox: {
          image: env('ASEP_AGENT_IMAGE_DIGEST')!,
          proxyImage: env('ASEP_EGRESS_PROXY_IMAGE_DIGEST')!,
          workdirFor: () => wt,
          inputRoot: dir,
        },
        credentials: new FileModelCredentialProvider({
          apiKeyFile: keyFile,
          ...(env('ASEP_ANTHROPIC_BASE_URL') ? { baseUrl: env('ASEP_ANTHROPIC_BASE_URL')! } : {}),
        }),
      },
      scope, store,
    );
    const obs = await provider.execute(request(workOrderRef, contextPackRef));
    console.log('live observation:', JSON.stringify({ ...obs, eventArtifactRefs: obs.eventArtifactRefs.map((r) => r.kind) }));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    assert.ok(obs.providerSessionId);
    assert.ok(obs.usage.modelCostUsd > 0 && obs.usage.outputTokens > 0, 'a real model was billed');
    assert.ok(existsSync(join(wt, 'HELLO.md')), 'the agent made the change in its worktree');
    assert.match(readFileSync(join(wt, 'HELLO.md'), 'utf8'), new RegExp(line));
    const egress = await egressLog(store, obs);
    for (const l of egress.trim().split('\n')) {
      assert.match(l, /(POST \/v1\/messages(\/count_tokens)? -> \d+|-> 403)$/, `unexpected egress: ${l}`);
    }
    assertNoSecret(dir, obs, readFileSync(keyFile, 'utf8').trim());
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('CONFORMANCE: the real CLI accepts the provider\'s argv and prompt channel, and its stream parses', { skip: conformanceSkip }, async () => {
  const cli = env('ASEP_CLAUDE_CONFORMANCE_CLI')!;
  const version = /^(\S+)/.exec(execFileSync(cli, ['--version'], { encoding: 'utf8' }))![1]!;
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-conformance-')));
  const { db, store, put } = await storeIn(dir);
  const modelLog = join(dir, 'model-requests.jsonl');
  const api = spawn(process.execPath, [join(TESTING, 'fake-model-api.mjs'), '--listen', '127.0.0.1:0', '--log', modelLog], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      api.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
        const m = /listening (\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      api.on('close', (code) => reject(new Error(`fake model API exited ${code}`)));
    });
    const wt = await workspace(dir);
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const docker = join(bin, 'docker');
    await writeFile(docker, `#!/bin/sh\nexec "${process.execPath}" "${join(TESTING, 'fake-docker.mjs')}" --state "${join(dir, 'docker-state')}" "$@"\n`,
      { mode: 0o755 });
    const secret = `asep-test-model-key-${randomUUID()}`;
    const keyFile = join(dir, 'model-key');
    await writeFile(keyFile, `${secret}\n`, { mode: 0o600 });
    const workOrderRef = await put('work-order', { objective: 'read the work order and stop' });
    const contextPackRef = await put('context-pack', { relevantFiles: [] });
    const provider = new ClaudeCodingProvider(
      {
        executable: cli, model: 'claude-sonnet-4-5', cliVersion: version, maxTurns: 4,
        sandbox: {
          image: `asep-agent@sha256:${'a'.repeat(64)}`, proxyImage: `node@sha256:${'b'.repeat(64)}`,
          workdirFor: () => wt, inputRoot: dir, dockerBinary: docker,
        },
        credentials: new FileModelCredentialProvider({ apiKeyFile: keyFile, baseUrl: `http://127.0.0.1:${port}` }),
      },
      scope, store,
    );
    const obs = await provider.execute(request(workOrderRef, contextPackRef));
    console.log('conformance observation:', JSON.stringify({ ...obs, eventArtifactRefs: obs.eventArtifactRefs.map((r) => r.kind) }));
    assert.equal(obs.status, 'AGENT_DONE', obs.knownLimitations.join('; '));
    assert.equal(obs.summary, 'done');
    assert.equal(obs.usage.toolCalls, 1, 'the CLI read the mounted work order (--add-dir)');
    const requests = readFileSync(modelLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((r: Record<string, unknown>) => r['method'] !== undefined);
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((r: Record<string, unknown>) => r['apiKey'] === secret && r['path'] === '/v1/messages?beta=true'),
      'every upstream request carried the proxy-held key on the allowlisted path');
    const egress = await egressLog(store, obs);
    assert.match(egress, /POST \/v1\/messages -> 200/);
    assertNoSecret(dir, obs, secret);
  } finally {
    api.kill('SIGTERM');
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
