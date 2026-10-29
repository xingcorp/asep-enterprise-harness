// The pilot's REAL-TARGET seams (disp. P2-FINAL-HIGH-008, exit K2).
//
// THE FINDING THIS CLOSES. Landing an entrypoint that calls `productionSeams`
// answered "no caller exists", but NOT "supply credentials and it runs live".
// Two defects stood between those two claims, and neither was reachable by any
// existing test:
//
//   1. `runVerticalSlice` ALWAYS called seedMirror(dir) and always registered
//      the binding as the literal `acme/web` on `github.com`, with no numeric
//      `github_repository_id`. SqlForgeBindingResolver fails closed without that
//      id (ForgeBindingIncompleteError), so a live run could not reach even the
//      first GitHub API call — and if it had, it would have pushed a synthetic
//      seed commit to a repository nobody owns.
//
//   2. `pilot-main` passed `localRepoPathFor: () => dir`, the bare TEMP ROOT.
//      The GitHub App adapter runs `git push` with that as cwd, and the temp
//      root holds no repository at all, so a live push could only ever fail.
//      The harness commit lives in the LEASED WORKTREE, which does not exist
//      until the workflow creates it.
//
// This suite runs on in-process PGlite with a real local mirror: no Docker, no
// network, no credential. It asserts the seams on real persisted rows, and pins
// that omitting them leaves both K1 proofs byte-for-byte unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PgliteClient, migrate, RepositoryBindingRepository,
} from '@asep/persistence';
import { runGit } from '@asep/git-worktree';
import { DockerSandboxProvider } from '@asep/command-runner';
import type {
  CommandSpec, CodingAgentProvider, AgentExecuteRequest, AgentAttemptObservation,
} from '@asep/ports';
import { runVerticalSlice, seedMirror } from './vertical-slice.js';

console.log('SUITE-ID: asep-suite:pilot-target');

// The verification sandbox: the real DockerSandboxProvider, driving the fake
// docker client (scripts/testing/fake-docker.mjs), which runs each container's
// command as a host process. The governed path accepts nothing but a handle
// that claims isolation; the OS-enforced proof is the integration suites.
async function fakeDockerSandbox(dir: string): Promise<DockerSandboxProvider> {
  await mkdir(dir, { recursive: true });
  const docker = join(dir, 'fake-docker');
  const fake = fileURLToPath(new URL('../../../scripts/testing/fake-docker.mjs', import.meta.url));
  await writeFile(docker, `#!/bin/sh\nexec "${process.execPath}" "${fake}" --state "${join(dir, 'docker-state')}" "$@"\n`,
    { mode: 0o755 });
  return new DockerSandboxProvider({ imageDigest: `alpine@sha256:${'a'.repeat(64)}`, dockerBinary: docker });
}

// A file that ONLY the caller-supplied mirror carries. Its presence in the leased
// worktree is what proves the driver honoured `repository.mirrorPath` instead of
// seeding its own (see seedMarkedMirror for why a SHA comparison cannot).
const MIRROR_MARKER = 'UPSTREAM-ONLY.txt';

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

// A mirror whose content is UNIQUE to this test.
//
// Why not the driver's own seedMirror(): it is deterministic. Same README bytes,
// same hard-coded committer identity, and git's commit timestamp has 1-second
// resolution — so two independent seeds in the same second produce the IDENTICAL
// commit SHA (verified empirically). An assertion that `result.baseSha` equals
// the seeded SHA therefore could not distinguish "attempted against the mirror I
// supplied" from "re-seeded its own and coincidentally matched", which is exactly
// the pre-fix behaviour. Pinning by CONTENT closes that: a marker file that only
// this mirror carries must be present in the leased worktree.
async function seedMarkedMirror(dir: string, marker: string): Promise<{
  mirror: string; baseSha: string;
}> {
  const upstream = join(dir, 'upstream');
  await mkdir(upstream, { recursive: true });
  await runGit(['-C', upstream, 'init', '-q', '-b', 'trunk']);
  await writeFile(join(upstream, marker), 'only the caller-supplied mirror has this\n');
  await runGit(['-C', upstream, 'add', '-A']);
  await runGit(['-C', upstream, '-c', 'user.name=upstream', '-c', 'user.email=up@example.com',
    'commit', '-m', `seed ${marker}`]);
  const baseSha = (await runGit(['-C', upstream, 'rev-parse', 'HEAD'])).stdout.trim();
  const mirror = join(dir, 'mirror.git');
  await runGit(['clone', '--bare', '-q', upstream, mirror]);
  return { mirror, baseSha };
}

// An agent that writes a CALLER-CHOSEN file, so the test can prove the work-order
// seam actually reaches trusted inspection. It resolves its worktree through
// `worktreePathOf` — the same mechanism a production agent factory uses — rather
// than the setWorktree back-channel the local double relies on.
function agentWriting(file: string, pathOf: () => string): CodingAgentProvider {
  return {
    providerId: 'seam-test-agent',
    async execute(req: AgentExecuteRequest): Promise<AgentAttemptObservation> {
      // The caller-chosen path may be nested (that is the point: a real objective
      // touches e.g. docs/pilot.md), so create the parent before writing.
      const target = join(pathOf(), file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'written by the injected agent\n');
      return {
        status: 'AGENT_DONE',
        summary: `wrote ${file}`,
        knownLimitations: [],
        providerSessionId: `seam-${req.attemptId}`,
        usage: {
          inputTokens: 1, outputTokens: 1, modelCostUsd: 0, toolCalls: 1, wallClockMs: 1,
        },
        eventArtifactRefs: [],
      };
    },
  };
}

test('HIGH-008/K2: a pilot target registers the REAL repository, including the numeric id the forge resolver requires', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-pilot-target-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);

    // A mirror standing in for one the pilot cloned from the real remote. The
    // driver must attempt against THIS, not a mirror it seeds itself. Its
    // content is unique (see seedMarkedMirror) so "used my mirror" is provable
    // by content rather than by a SHA that a re-seed would reproduce.
    const seeded = await seedMarkedMirror(join(dir, 'real'), MIRROR_MARKER);

    // Captures what the driver publishes when it creates the leased worktree.
    // Defect 2 is exactly that this path was never surfaced, leaving the pilot
    // to pass the temp root to the forge adapter.
    let published: string | null = null;

    const result = await runVerticalSlice({
      client,
      // This suite is about the target seams; the authoritative isolation proof
      // is vertical-slice.itest.ts under real Docker.
      sandbox: await fakeDockerSandbox(join(dir, 'sandbox')),
      dir: join(dir, 'run'),
      checkCommand: checkCommandFor,
      repository: {
        organizationName: 'Northwind',
        projectName: 'platform',
        defaultBranch: 'trunk',
        binding: {
          githubHost: 'github.example',
          githubOwner: 'northwind',
          githubRepo: 'platform',
          defaultBaseBranch: 'trunk',
          githubRepositoryId: 987654,
        },
        mirrorPath: seeded.mirror,
        baseSha: seeded.baseSha,
      },
      onWorkspaceCreated: (p) => { published = p; },
      work: {
        objective: 'add docs/pilot.md',
        contextPack: { relevantFiles: ['docs/pilot.md'] },
        allowedPaths: ['docs/pilot.md'],
        expectChangedFile: 'docs/pilot.md',
      },
      environment: {
        imageDigest: 'ghcr.io/asep/agent@sha256:' + '1'.repeat(64),
        lockfileHash: '2'.repeat(64),
        nodeVersion: process.version,
      },
      agentFor: ({ worktreePathOf }) => agentWriting(
        'docs/pilot.md',
        // The workflow creates the workspace before invoking the agent, so by
        // the time execute() runs this resolves. Deferred, not eager.
        () => worktreePathOf('unused' as never),
      ),
    });

    // --- the attempt ran against the CALLER'S mirror, not a fresh seed -------
    // Pinned by CONTENT, not by SHA. seedMirror() is deterministic (fixed bytes,
    // fixed committer, 1-second timestamp resolution), so a SHA comparison passes
    // even when the driver ignores `mirrorPath` and re-seeds — the exact pre-fix
    // behaviour. The marker file exists ONLY in the mirror this test supplied, so
    // finding it in the leased worktree cannot be satisfied by re-seeding.
    assert.equal(result.baseSha, seeded.baseSha,
      'the attempt is based on the commit that exists in the caller-supplied mirror');
    const tracked = (await runGit(
      ['-C', result.wtPath, 'ls-tree', '-r', '--name-only', result.baseSha],
    )).stdout;
    assert.ok(tracked.includes(MIRROR_MARKER),
      `the leased worktree must carry ${MIRROR_MARKER} from the supplied mirror; ` +
      `a driver that re-seeded its own mirror would show only README.md (got: ${tracked.trim()})`);

    // --- the binding row carries the real identity AND the numeric id --------
    // This is the blocker: without github_repository_id every forge resolve threw
    // ForgeBindingIncompleteError before the first API call.
    const bindings = new RepositoryBindingRepository(client);
    const row = await bindings.getScoped(result.scope, result.repositoryBindingId);
    assert.equal(row.githubOwner, 'northwind');
    assert.equal(row.githubRepo, 'platform');
    assert.equal(row.githubHost, 'github.example');
    assert.equal(row.defaultBaseBranch, 'trunk');
    assert.equal(row.githubRepositoryId, 987654,
      'the numeric repository id MUST persist — the forge resolver fails closed without it');

    // --- the work order reached trusted inspection ---------------------------
    // The workflow fails closed when inspection does not observe
    // expectChangedFile, so reaching the review gate with a non-default file
    // proves the seam is honoured end to end.
    assert.equal(result.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
    assert.equal(result.stoppedAt, 'complete');

    // --- the attempt records which agent ran it ------------------------------
    // The pilot verifier certifies the agent from this column, never from the
    // manifest; left empty, no genuine run could ever pass it.
    const attemptRow = await result.repos.attempts.getScoped(result.scope, result.attemptId);
    assert.equal(attemptRow.agentProviderId, 'seam-test-agent');

    // --- the leased worktree path was published (defect 2) -------------------
    const publishedPath = published as string | null;
    assert.ok(publishedPath !== null, 'the driver must publish the leased worktree path');
    assert.equal(publishedPath, result.wtPath,
      'the published path is the leased worktree the commit was made from');
    assert.notEqual(publishedPath, join(dir, 'run'),
      'it must NOT be the temp root — the root holds no repository, so a push there cannot work');
    // It really is a Git working tree: the harness commit is reachable from it.
    const head = (await runGit(['-C', publishedPath, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(head, result.commitSha,
      'the published path is a real worktree whose HEAD is the harness commit');

    // --- real provenance landed in the evidence bundle -----------------------
    const bundle = await result.repos.evidenceStore.getEvidence(
      result.scope, result.evidenceArtifactId,
    );
    assert.equal(bundle.environment.imageDigest, 'ghcr.io/asep/agent@sha256:' + '1'.repeat(64),
      'the bundle attests the image that actually ran, not a placeholder');
    assert.equal(bundle.environment.lockfileHash, '2'.repeat(64));
  } finally {
    await client.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HIGH-008/K2: omitting the target keeps the SYNTHETIC default (both K1 proofs unchanged)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-pilot-default-'));
  const client = await PgliteClient.create();
  try {
    await migrate(client);

    const result = await runVerticalSlice({
      client,
      sandbox: await fakeDockerSandbox(join(dir, 'sandbox')),
      dir: join(dir, 'run'),
      checkCommand: checkCommandFor,
      // No repository / work / environment: the pre-existing behaviour.
    });

    const bindings = new RepositoryBindingRepository(client);
    const row = await bindings.getScoped(result.scope, result.repositoryBindingId);
    assert.equal(row.githubOwner, 'acme', 'the synthetic default is unchanged');
    assert.equal(row.githubRepo, 'web');
    assert.equal(row.githubHost, 'github.com');
    assert.equal(row.githubRepositoryId, undefined,
      'the synthetic binding still carries no numeric id — only a real target supplies one');
    assert.equal(result.taskStatus, 'WAITING_FOR_HUMAN_REVIEW');
  } finally {
    await client.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
