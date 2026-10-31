// The pilot verifier over a real governed slice.
//
// Runs the vertical slice end to end — in-process PostgreSQL (PGlite), a real
// git mirror, worktree and bare remote, the real artifact and evidence stores
// writing bytes to disk, and the real DockerSandboxProvider driving the fake
// docker client — then records a signed human authorization and builds the
// manifest entry that run backs.
//
// The agent is the REAL ClaudeCodingProvider: its whole container choreography
// runs through the fake docker client, the real egress-proxy asset forwards to
// a fake model API with the credential it received on stdin, and the strict
// fake CLI plays the pinned `claude` binary. The verifier, with the production
// resolver reading the same database, the same object root and the same forge,
// must accept that run under its pins — its task state and risk, the work order
// the task carries and the agent was handed, the canonical evidence and the
// record of where each check ran all read back from what the harness wrote —
// and must refuse it once the task leaves human review, the manifest claims
// another risk or work order, the PR head moves off the reviewed commit, the
// stored evidence, work order, agent evidence or verification record bytes
// change, the signature binds another commit, or the pins are not the ones the
// run used. A run through the local agent double is refused, whatever the
// manifest claims about it.
//
// The forge is the local bare-remote double, reporting github.com-shaped PR
// links (the manifest schema accepts nothing else) and the live head of the PR
// branch on the remote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PgliteClient, migrate } from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { ClaudeCodingProvider, FileModelCredentialProvider } from '@asep/agent-claude';
import { runGit } from '@asep/git-worktree';
import { createBareRemote, LocalBareForgeProvider } from '@asep/local-doubles';
import type { CommandSpec, ForgeProvider, PullRequestRef, ToolPolicyProfile } from '@asep/ports';
import { admitRisk } from '@asep/application';
import { runVerticalSlice, type VerticalSliceResult } from './vertical-slice.js';
import {
  verifyManifestAgainstAuthority, realClaudeProviderId, ADMISSIBLE_RISKS,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/verify-pilot-manifest.mjs';
import {
  createSqlAuthorityResolver, filesystemObjectReader, loadVerificationPolicy, VERIFICATION_MATRIX_FILE,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/authority-resolver.mjs';
import {
  signAuthorization,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/human-authorization-crypto.mjs';
import {
  makeFixtureDir, registryShimLine, removeFakeDockerFixture,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/testing/fake-docker-fixture.mjs';

console.log('SUITE-ID: asep-suite:pilot-verifier');

const keys = generateKeyPairSync('ed25519');
const REVIEWER_PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const REVIEWER_PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CHANGED_FILE = 'feature.txt';
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE_DOCKER = join(REPO, 'scripts', 'testing', 'fake-docker.mjs');
const FAKE_CLAUDE = join(REPO, 'scripts', 'testing', 'fake-claude-cli.mjs');
const MODEL = 'claude-test-model';
const CLI_VERSION = '2.1.286';
const AGENT_IMAGE = `asep-agent@sha256:${'a'.repeat(64)}`;
const PROXY_IMAGE = `node@sha256:${'b'.repeat(64)}`;
// The image the verification sandbox runs checks in.
const VERIFY_IMAGE = `alpine@sha256:${'c'.repeat(64)}`;
// The repository's verification matrix, pinned by its hash, and the policy the
// resolver loads for that pin.
const MATRIX_SHA = createHash('sha256').update(await readFile(VERIFICATION_MATRIX_FILE)).digest('hex');
const POLICY = await loadVerificationPolicy(MATRIX_SHA);
// The pilot's tool policy: the Claude provider runs only under restricted egress.
const PILOT_POLICY: ToolPolicyProfile = {
  allowedTools: ['read', 'write'], disallowedTools: ['bash', 'network'], networkProfile: 'restricted-egress',
};

interface Rig {
  readonly dir: string;
  readonly docker: string;
  readonly objectRoot: string;
  readonly remote: string;
  readonly inner: LocalBareForgeProvider;
  readonly forge: ForgeProvider;
  readonly modelUrl: string;
  readonly keyFile: string;
  readonly cli: string;
  close(): Promise<void>;
}

// A fake model API answering every call 200, as the egress proxy's upstream.
async function fakeModelApi(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

async function rig(): Promise<Rig> {
  // Outside /tmp: the fake CLI stands in for the agent image, which the agent
  // container's tmpfs on /tmp would hide.
  const dir = await makeFixtureDir('asep-pilot-verifier-');
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const docker = join(bin, 'docker');
  await writeFile(docker, `#!/bin/sh\n${registryShimLine()}\nexec "${process.execPath}" "${FAKE_DOCKER}" --state "${join(dir, 'docker-state')}" "$@"\n`,
    { mode: 0o755 });
  // The pinned CLI, played by the strict fake: asks the model, then edits.
  const cli = join(bin, 'claude');
  await writeFile(cli, `#!${process.execPath}\nprocess.env.FAKE_CLAUDE_SCENARIO = 'ok-model'; ` +
    `import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});\n`, { mode: 0o755 });
  const keyFile = join(dir, 'model-key');
  await writeFile(keyFile, `asep-test-model-key-${randomUUID()}\n`, { mode: 0o600 });
  const model = await fakeModelApi();
  const remote = await createBareRemote(join(dir, 'forge.git'));
  const inner = new LocalBareForgeProvider(remote);
  return {
    dir, docker, objectRoot: join(dir, 'objects'), remote, inner, forge: githubShaped(inner),
    modelUrl: model.url, keyFile, cli,
    async close() {
      await model.close();
      await removeFakeDockerFixture(dir);
    },
  };
}

function checkCommandFor(wtPath: string): CommandSpec {
  return {
    executable: 'git',
    args: ['-C', wtPath, 'status', '--porcelain'],
    cwd: wtPath,
    environmentProfile: 'verification-no-network',
    timeoutMs: 60_000,
    outputPolicy: { maxEvidenceBytes: 65_536, displayHeadBytes: 4096, displayTailBytes: 4096 },
  };
}

// The local double, with PR links in the github.com form the manifest requires.
function githubShaped(inner: LocalBareForgeProvider): ForgeProvider {
  const shaped = (pr: PullRequestRef): PullRequestRef => ({ ...pr, url: `https://github.com/acme/web/pull/${pr.number}` });
  return {
    pushBranch: (scope, input) => inner.pushBranch(scope, input),
    upsertPullRequest: async (scope, input) => shaped(await inner.upsertPullRequest(scope, input)),
    updatePullRequestContent: async (scope, input) => shaped(await inner.updatePullRequestContent(scope, input)),
    resolveRef: (scope, input) => inner.resolveRef(scope, input),
    findPullRequest: async (scope, input) => {
      const pr = await inner.findPullRequest(scope, input);
      return pr ? shaped(pr) : null;
    },
  };
}

// Run one governed slice; `realAgent` selects the real Claude adapter over the
// local agent double.
async function slice(client: PgliteClient, r: Rig, realAgent: boolean): Promise<VerticalSliceResult> {
  const sandbox = new DockerSandboxProvider({ imageDigest: VERIFY_IMAGE, dockerBinary: r.docker });
  const result = await runVerticalSlice({
    client,
    sandbox,
    dir: join(r.dir, 'run'),
    objectStoreDir: r.objectRoot,
    checkCommand: checkCommandFor,
    forge: r.forge,
    onWorkspaceCreated: (p) => r.inner.setWorktree(p),
    ...(realAgent
      ? {
          toolPolicy: PILOT_POLICY,
          // As the pilot records it: the agent image produced the change.
          environment: { imageDigest: AGENT_IMAGE, lockfileHash: 'f'.repeat(64), nodeVersion: process.version },
          agentFor: ({ scope, artifacts, worktreePathOf }) => new ClaudeCodingProvider(
            {
              executable: r.cli, model: MODEL, cliVersion: CLI_VERSION, maxTurns: 5,
              sandbox: {
                image: AGENT_IMAGE, proxyImage: PROXY_IMAGE, workdirFor: worktreePathOf,
                dockerBinary: r.docker, inputRoot: r.dir,
              },
              credentials: new FileModelCredentialProvider({ apiKeyFile: r.keyFile, baseUrl: r.modelUrl }),
            },
            scope, artifacts,
          ),
        }
      : {}),
    work: {
      objective: `add ${CHANGED_FILE}`,
      contextPack: { relevantFiles: [CHANGED_FILE] },
      allowedPaths: [CHANGED_FILE],
      expectChangedFile: CHANGED_FILE,
    },
  });
  assert.equal(result.taskStatus, 'WAITING_FOR_HUMAN_REVIEW', result.stoppedAt);
  return result;
}

// The reviewer's signed decision, recorded as the operator would.
async function authorize(client: PgliteClient, result: VerticalSliceResult, prId: string, reviewedResultSha: string) {
  const signed = signAuthorization({
    task_id: result.taskId, attempt_id: result.attemptId, pull_request_id: prId,
    disposition: 'ACCEPTED', reviewed_result_sha: reviewedResultSha, signed_by: 'reviewer@acme',
  }, REVIEWER_PRIV);
  await client.query('delete from human_authorizations where task_id = $1', [result.taskId]);
  await client.query(
    `insert into human_authorizations
       (id, organization_id, project_id, task_id, attempt_id, pull_request_id,
        disposition, reviewed_result_sha, signed_by, signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [`H${result.attemptId.slice(1)}`, result.scope.organizationId, result.scope.projectId, result.taskId, result.attemptId,
      prId, signed.disposition, signed.reviewed_result_sha, signed.signed_by, signed.signature],
  );
}

function manifestFor(
  result: VerticalSliceResult, prId: string, providerId: string, providerSessionId: string, workOrderSha256: string,
) {
  return {
    manifestVersion: '1.0.0',
    verdict: 'IMPLEMENTATION_COMPLETE_PILOT_PENDING',
    generatedAt: '2026-10-29T00:00:00.000Z',
    tasks: [{
      taskId: result.taskId,
      objective: `add ${CHANGED_FILE}`,
      risk: 'R0',
      workOrderSha256,
      baseSha: result.baseSha,
      resultSha: result.commitSha,
      providerSessionId,
      providerId,
      pullRequestUrl: `https://github.com/acme/web/pull/${result.prNumber}`,
      evidenceChecksum: `sha256:${result.evidenceSha256}`,
      humanDisposition: 'ACCEPTED',
      trace: {
        pullRequestId: prId,
        evidenceArtifactId: result.evidenceArtifactId,
        attemptId: result.attemptId,
        taskId: result.taskId,
        runId: result.runId,
        projectId: result.scope.projectId,
        organizationId: result.scope.organizationId,
        repositoryBindingId: result.repositoryBindingId,
      },
    }],
  };
}

async function storageKey(client: PgliteClient, sql: string, params: string[]): Promise<string> {
  return (await client.query(sql, params)).rows[0]!['storage_key'] as string;
}

// The work order the task carries, as the database records it.
async function workOrderOf(client: PgliteClient, taskId: string): Promise<{ sha256: string; key: string }> {
  const row = (await client.query(
    `select t.work_order_sha256, a.storage_key
     from tasks t join artifacts a on a.id = t.work_order_artifact_id
     where t.id = $1`, [taskId],
  )).rows[0]!;
  return { sha256: row['work_order_sha256'] as string, key: row['storage_key'] as string };
}

test('the verifier admits exactly the risks Phase-2 admission admits', () => {
  for (const risk of ['R0', 'R1', 'R2', 'R3', 'R4'] as const) {
    assert.equal((ADMISSIBLE_RISKS as readonly string[]).includes(risk), admitRisk(risk).admitted, risk);
  }
});

test('the verifier accepts a run of the real Claude adapter under its pins, and refuses a moved head, edited evidence, a signature for another commit, or other pins', async () => {
  const r = await rig();
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const result = await slice(client, r, true);
    const pins = {
      model: MODEL, cliVersion: CLI_VERSION, agentImage: AGENT_IMAGE, proxyImage: PROXY_IMAGE, modelBaseUrl: r.modelUrl,
      verifyImage: VERIFY_IMAGE, verificationMatrixSha256: MATRIX_SHA,
    };
    const realId = realClaudeProviderId(pins) as string;
    const attempt = (await client.query('select agent_provider_id from attempts where id = $1', [result.attemptId])).rows[0]!;
    assert.equal(attempt['agent_provider_id'], realId, 'the workflow recorded the real adapter id');

    const prId = (await client.query('select id from pull_requests where attempt_id = $1', [result.attemptId]))
      .rows[0]!['id'] as string;
    const evidenceKey = await storageKey(client, 'select storage_key from artifacts where id = $1', [result.evidenceArtifactId]);
    const eventsKey = await storageKey(client,
      `select storage_key from artifacts where attempt_id = $1 and kind = 'claude-event-stream'`, [result.attemptId]);
    const egressKey = await storageKey(client,
      `select storage_key from artifacts where attempt_id = $1 and kind = 'claude-egress-log'`, [result.attemptId]);
    const provenanceKey = await storageKey(client,
      `select storage_key from artifacts where attempt_id = $1 and kind = 'verification-provenance'`, [result.attemptId]);
    const workOrder = await workOrderOf(client, result.taskId);
    // The session is the CLI's own, read from the event stream it emitted.
    const init = (await readFile(join(r.objectRoot, eventsKey), 'utf8')).split('\n')
      .map((l) => (l.trim() === '' ? undefined : JSON.parse(l) as Record<string, unknown>))
      .find((e) => e?.['type'] === 'system' && e['subtype'] === 'init')!;
    await authorize(client, result, prId, result.commitSha);

    const manifest = manifestFor(result, prId, realId, init['session_id'] as string, workOrder.sha256);
    const resolverWith = (p: typeof pins) => createSqlAuthorityResolver(client, {
      reviewerPublicKeyPem: REVIEWER_PUB, objects: filesystemObjectReader(r.objectRoot), forge: r.forge, agent: p,
      verificationPolicy: POLICY,
    });
    const verify = async (p = pins, m: Record<string, unknown> = manifest) =>
      verifyManifestAgainstAuthority(m, resolverWith(p)) as Promise<{ ok: boolean; reasons: string[] }>;
    const refused = async (why: RegExp, p = pins, m: Record<string, unknown> = manifest) => {
      const res = await verify(p, m);
      assert.equal(res.ok, false, `expected a refusal matching ${why}`);
      assert.ok(res.reasons.some((x) => why.test(x)), `${why} not among:\n${res.reasons.join('\n')}`);
    };
    const claiming = (over: Record<string, unknown>) => ({ ...manifest, tasks: [{ ...manifest.tasks[0]!, ...over }] });

    const genuine = await verify();
    assert.equal(genuine.ok, true, genuine.reasons.join('\n'));

    // What the harness recorded of where the checks ran: the pinned sandbox.
    const provenance = JSON.parse(await readFile(join(r.objectRoot, provenanceKey), 'utf8')) as {
      verdict: string; checks: Array<{ provenance: { where: string; image: string; runFlags: string[] } }>;
    };
    assert.equal(provenance.verdict, 'PASS');
    for (const c of provenance.checks) {
      assert.equal(c.provenance.where, 'container');
      assert.equal(c.provenance.image, VERIFY_IMAGE);
      assert.deepEqual(c.provenance.runFlags.slice(0, POLICY.sandboxFlags.length), [...POLICY.sandboxFlags],
        'the checks ran under the sandbox profile the verifier compares with');
    }

    // The same run at R1: the matrix asks for L2 as well, which a run planned
    // for R0 did not cover.
    await client.query(`update tasks set risk = 'R1' where id = $1`, [result.taskId]);
    await refused(/no check covers L2, which the verification matrix makes mandatory at R1/, pins, claiming({ risk: 'R1' }));
    await client.query(`update tasks set risk = 'R0' where id = $1`, [result.taskId]);

    // The task leaves human review.
    await client.query(`update tasks set status = 'FAILED' where id = $1`, [result.taskId]);
    await refused(/the task is "FAILED", which is not waiting for human review/);
    await client.query(`update tasks set status = 'WAITING_FOR_HUMAN_REVIEW' where id = $1`, [result.taskId]);

    // The manifest claims another risk or another work order than the task's.
    await refused(/manifest risk "R1" != the task's risk "R0"/, pins, claiming({ risk: 'R1' }));
    await refused(/manifest workOrderSha256 .* != the task's work order/, pins, claiming({ workOrderSha256: 'f'.repeat(64) }));

    // The stored work order is rewritten after the run.
    const workOrderBytes = await readFile(join(r.objectRoot, workOrder.key));
    await writeFile(join(r.objectRoot, workOrder.key), Buffer.from('{"objective":"something else"}'));
    await refused(/stored work order bytes hash to/);
    await writeFile(join(r.objectRoot, workOrder.key), workOrderBytes);

    // The record of where the checks ran is rewritten to claim another image.
    const provenanceBytes = await readFile(join(r.objectRoot, provenanceKey));
    await writeFile(join(r.objectRoot, provenanceKey),
      provenanceBytes.toString('utf8').replaceAll(VERIFY_IMAGE, `alpine@sha256:${'d'.repeat(64)}`));
    await refused(/stored verification provenance record bytes hash to/);
    await writeFile(join(r.objectRoot, provenanceKey), provenanceBytes);

    // The same run, judged against a verification image it did not use.
    await refused(/ran in image .* not the pinned verification image/, { ...pins, verifyImage: `alpine@sha256:${'d'.repeat(64)}` });

    // The PR branch moves off the reviewed commit on the remote.
    await runGit(['-C', r.remote, 'update-ref', `refs/heads/${result.branch}`, result.baseSha]);
    await refused(/live PR head .* != the attempt result/);
    await runGit(['-C', r.remote, 'update-ref', `refs/heads/${result.branch}`, result.commitSha]);

    // The stored evidence bytes are edited in place; the metadata row is untouched.
    const original = await readFile(join(r.objectRoot, evidenceKey));
    const edited = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
    await writeFile(join(r.objectRoot, evidenceKey), JSON.stringify({ ...edited, checks: [] }));
    await refused(/stored evidence bytes hash to/);
    await writeFile(join(r.objectRoot, evidenceKey), original);

    // The egress proxy's log is rewritten after the fact.
    const egress = await readFile(join(r.objectRoot, egressKey));
    assert.match(egress.toString('utf8'), /POST \/v1\/messages -> 200/, 'the proxy forwarded the CLI\'s model call');
    await writeFile(join(r.objectRoot, egressKey), Buffer.concat([egress, Buffer.from('later POST /v1/messages -> 200\n')]));
    await refused(/stored egress log bytes hash to/);
    await writeFile(join(r.objectRoot, egressKey), egress);

    // A genuinely signed decision — about another commit.
    await authorize(client, result, prId, result.baseSha);
    await refused(/authorization was signed for result/);
    await authorize(client, result, prId, result.commitSha);

    // The same run, judged against pins it did not run under.
    await refused(/is not the real Claude adapter for the pinned model and CLI/, { ...pins, cliVersion: '2.1.287' });
    await refused(/CLI reported version "2\.1\.286", not the pinned "2\.1\.287"/, { ...pins, cliVersion: '2.1.287' });
    await refused(/invocation manifest records upstream/, { ...pins, modelBaseUrl: 'https://api.anthropic.com' });
    await refused(/invocation manifest records image/, { ...pins, agentImage: `asep-agent@sha256:${'d'.repeat(64)}` });

    const restored = await verify();
    assert.equal(restored.ok, true, restored.reasons.join('\n'));
  } finally {
    await client.close();
    await r.close();
  }
});

test('a run through the local agent double is refused, whatever the manifest claims about it', async () => {
  const r = await rig();
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const result = await slice(client, r, false);
    const pins = {
      model: MODEL, cliVersion: CLI_VERSION, agentImage: AGENT_IMAGE, proxyImage: PROXY_IMAGE, modelBaseUrl: r.modelUrl,
      verifyImage: VERIFY_IMAGE, verificationMatrixSha256: MATRIX_SHA,
    };
    const attempt = (await client.query('select agent_provider_id from attempts where id = $1', [result.attemptId])).rows[0]!;
    const workOrder = await workOrderOf(client, result.taskId);
    assert.equal(attempt['agent_provider_id'], 'fake-claude', 'the local double ran');
    const prId = (await client.query('select id from pull_requests where attempt_id = $1', [result.attemptId]))
      .rows[0]!['id'] as string;
    await authorize(client, result, prId, result.commitSha);
    const resolver = createSqlAuthorityResolver(client, {
      reviewerPublicKeyPem: REVIEWER_PUB, objects: filesystemObjectReader(r.objectRoot), forge: r.forge, agent: pins,
      verificationPolicy: POLICY,
    });

    // Claimed as the real adapter: everything else about the run checks out,
    // but the persisted provider and the missing agent evidence refuse it.
    const claimed = await verifyManifestAgainstAuthority(
      manifestFor(result, prId, realClaudeProviderId(pins), `fake-session-${result.attemptId}`, workOrder.sha256), resolver,
    ) as { ok: boolean; reasons: string[] };
    assert.equal(claimed.ok, false);
    for (const why of [
      /persisted provider "fake-claude" is not the real Claude adapter/,
      /manifest providerId .* != persisted provider "fake-claude"/,
      /no invocation manifest recorded/, /no event stream recorded/, /no egress log recorded/,
    ]) {
      assert.ok(claimed.reasons.some((x) => why.test(x)), `${why} not among:\n${claimed.reasons.join('\n')}`);
    }
    // Nothing else is wrong with it: the refusal is about the agent alone.
    assert.ok(!claimed.reasons.some((x) => /evidence bytes hash|live PR|authorization was signed/.test(x)),
      claimed.reasons.join('\n'));

    // Declared honestly, it is not even a well-formed pilot task.
    const honest = await verifyManifestAgainstAuthority(
      manifestFor(result, prId, 'fake-claude', `fake-session-${result.attemptId}`, workOrder.sha256), resolver,
    ) as { ok: boolean; reasons: string[] };
    assert.equal(honest.ok, false);
    assert.ok(honest.reasons.some((x) => /providerId must be a Claude adapter id/.test(x)), honest.reasons.join('\n'));
  } finally {
    await client.close();
    await r.close();
  }
});
