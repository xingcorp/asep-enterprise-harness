// The pilot verifier over a real governed slice.
//
// Runs the vertical slice end to end — in-process PostgreSQL (PGlite), a real
// git mirror, worktree and bare remote, the real artifact and evidence stores
// writing bytes to disk, and the real DockerSandboxProvider driving the fake
// docker client — then records a signed human authorization and builds the
// manifest entry that run backs. The verifier, with the production resolver
// reading the same database, the same object root and the same forge, must
// accept it; and must refuse it once the PR head moves off the reviewed commit,
// the stored evidence bytes change, or the signature binds another commit.
//
// The forge is the local bare-remote double, reporting github.com-shaped PR
// links (the manifest schema accepts nothing else) and the live head of the PR
// branch on the remote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgliteClient, migrate } from '@asep/persistence';
import { DockerSandboxProvider } from '@asep/command-runner';
import { runGit } from '@asep/git-worktree';
import { createBareRemote, LocalBareForgeProvider } from '@asep/local-doubles';
import type {
  AgentAttemptObservation, AgentExecuteRequest, CodingAgentProvider, CommandSpec, ForgeProvider, PullRequestRef,
} from '@asep/ports';
import { runVerticalSlice } from './vertical-slice.js';
import {
  verifyManifestAgainstAuthority,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/verify-pilot-manifest.mjs';
import {
  createSqlAuthorityResolver, filesystemObjectReader,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/authority-resolver.mjs';
import {
  signAuthorization,
  // @ts-expect-error - .mjs has no type declarations; runtime import is fine under tsx.
} from '../../../scripts/pilot/human-authorization-crypto.mjs';

console.log('SUITE-ID: asep-suite:pilot-verifier');

const keys = generateKeyPairSync('ed25519');
const REVIEWER_PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const REVIEWER_PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const AGENT_ID = 'seam-test-agent';
const CHANGED_FILE = 'docs/pilot.md';

async function fakeDockerSandbox(dir: string): Promise<DockerSandboxProvider> {
  await mkdir(dir, { recursive: true });
  const docker = join(dir, 'fake-docker');
  const fake = fileURLToPath(new URL('../../../scripts/testing/fake-docker.mjs', import.meta.url));
  await writeFile(docker, `#!/bin/sh\nexec "${process.execPath}" "${fake}" --state "${join(dir, 'docker-state')}" "$@"\n`,
    { mode: 0o755 });
  return new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: docker });
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

function agentWriting(pathOf: () => string): CodingAgentProvider {
  return {
    providerId: AGENT_ID,
    async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
      const target = join(pathOf(), CHANGED_FILE);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'written by the agent\n');
      return {
        status: 'AGENT_DONE', summary: `wrote ${CHANGED_FILE}`, knownLimitations: [],
        providerSessionId: `session-${req.attemptId}`,
        usage: { inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1 },
        eventArtifactRefs: [],
      };
    },
  };
}

// The local double, with PR links in the github.com form the manifest requires.
function githubShaped(inner: LocalBareForgeProvider): ForgeProvider {
  const shaped = (pr: PullRequestRef): PullRequestRef => ({ ...pr, url: `https://github.com/acme/web/pull/${pr.number}` });
  return {
    pushBranch: (scope, input) => inner.pushBranch(scope, input),
    upsertPullRequest: async (scope, input) => shaped(await inner.upsertPullRequest(scope, input)),
    resolveRef: (scope, input) => inner.resolveRef(scope, input),
    findPullRequest: async (scope, input) => {
      const pr = await inner.findPullRequest(scope, input);
      return pr ? shaped(pr) : null;
    },
  };
}

test('the verifier accepts what a real slice backs, and refuses a moved head, edited evidence or a signature for another commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-pilot-verifier-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);
    const remote = await createBareRemote(join(dir, 'forge.git'));
    const inner = new LocalBareForgeProvider(remote);
    const forge = githubShaped(inner);
    const objectRoot = join(dir, 'objects');

    const result = await runVerticalSlice({
      client,
      sandbox: await fakeDockerSandbox(join(dir, 'sandbox')),
      dir: join(dir, 'run'),
      objectStoreDir: objectRoot,
      checkCommand: checkCommandFor,
      forge,
      onWorkspaceCreated: (p) => inner.setWorktree(p),
      agentFor: ({ worktreePathOf }) => agentWriting(() => worktreePathOf('unused' as never)),
      work: {
        objective: `add ${CHANGED_FILE}`,
        contextPack: { relevantFiles: [CHANGED_FILE] },
        allowedPaths: [CHANGED_FILE],
        expectChangedFile: CHANGED_FILE,
        prTitle: `ASEP: add ${CHANGED_FILE}`,
        prBody: 'Automated attempt.',
      },
    });
    assert.equal(result.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');

    const prId = (await client.query('select id from pull_requests where attempt_id = $1', [result.attemptId]))
      .rows[0]!['id'] as string;
    const evidenceKey = (await client.query('select storage_key from artifacts where id = $1', [result.evidenceArtifactId]))
      .rows[0]!['storage_key'] as string;

    // The reviewer's signed decision, recorded as the operator would.
    const authorize = async (reviewedResultSha: string) => {
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
        ['H'.repeat(26), result.scope.organizationId, result.scope.projectId, result.taskId, result.attemptId,
          prId, signed.disposition, signed.reviewed_result_sha, signed.signed_by, signed.signature],
      );
    };
    await authorize(result.commitSha);

    const manifest = {
      manifestVersion: '1.0.0',
      verdict: 'IMPLEMENTATION_COMPLETE_PILOT_PENDING',
      generatedAt: '2026-10-29T00:00:00.000Z',
      tasks: [{
        taskId: result.taskId,
        objective: `add ${CHANGED_FILE}`,
        risk: 'R0',
        workOrderSha256: '1'.repeat(64),
        baseSha: result.baseSha,
        resultSha: result.commitSha,
        providerSessionId: `session-${result.attemptId}`,
        providerId: AGENT_ID,
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
    const resolver = createSqlAuthorityResolver(client, {
      reviewerPublicKeyPem: REVIEWER_PUB, objects: filesystemObjectReader(objectRoot), forge,
    });
    const verify = async () => verifyManifestAgainstAuthority(manifest, resolver) as Promise<{ ok: boolean; reasons: string[] }>;

    const genuine = await verify();
    assert.equal(genuine.ok, true, genuine.reasons.join('\n'));

    // The PR branch moves off the reviewed commit on the remote.
    await runGit(['-C', remote, 'update-ref', `refs/heads/${result.branch}`, result.baseSha]);
    const moved = await verify();
    assert.equal(moved.ok, false);
    assert.ok(moved.reasons.some((r) => /live PR head .* != the attempt result/.test(r)), moved.reasons.join('\n'));
    await runGit(['-C', remote, 'update-ref', `refs/heads/${result.branch}`, result.commitSha]);

    // The stored evidence bytes are edited in place; the metadata row is untouched.
    const original = await readFile(join(objectRoot, evidenceKey));
    const edited = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
    await writeFile(join(objectRoot, evidenceKey), JSON.stringify({ ...edited, checks: [] }));
    const tampered = await verify();
    assert.equal(tampered.ok, false);
    assert.ok(tampered.reasons.some((r) => /stored evidence bytes hash to/.test(r)), tampered.reasons.join('\n'));
    await writeFile(join(objectRoot, evidenceKey), original);

    // A genuinely signed decision — about another commit.
    await authorize(result.baseSha);
    const otherCommit = await verify();
    assert.equal(otherCommit.ok, false);
    assert.ok(otherCommit.reasons.some((r) => /authorization was signed for result/.test(r)), otherCommit.reasons.join('\n'));
    await authorize(result.commitSha);

    const restored = await verify();
    assert.equal(restored.ok, true, restored.reasons.join('\n'));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
