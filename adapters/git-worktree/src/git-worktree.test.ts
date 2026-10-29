// Git worktree + mirror + ref-safety suite (exit criteria E1–E9, H3). Runs
// against a REAL temporary Git repository — a bare mirror plus linked worktrees
// checked out at pinned base SHAs — never a mock (E1). A content-addressed
// artifact store (pglite + filesystem objects) receives the trusted diff, so
// the inspector path is exercised end to end.
//
// Machine-readable suite marker (exit criterion K4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitWorktreeManager, WorktreeContainmentError, BaseShaError, HarnessCommitError,
  buildCloneUrl, rejectRawRemoteUrl, RemoteIdentityError,
  attemptBranch, safeRefspecFor, RefSafetyError,
  runGit,
} from './index.js';
import {
  PgliteClient, migrate, ContentAddressedArtifactStore, FilesystemObjectStore,
} from '@asep/persistence';
import type { ArtifactStore } from '@asep/ports';
import type {
  OrganizationId, ProjectId, RepositoryBindingId, TenantScope, WorkspaceId,
  RunId, TaskId, AttemptId,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:git-worktree');

const scope: TenantScope = {
  organizationId: 'A'.repeat(26) as OrganizationId,
  projectId: 'B'.repeat(26) as ProjectId,
};
const bindingId = 'C'.repeat(26) as RepositoryBindingId;
const ATTEMPT = 'P'.repeat(26);
const OTHER_ATTEMPT = 'Q'.repeat(26);

// Build a real bare mirror seeded with one commit; return { mirror, baseSha }.
async function seedMirror(dir: string): Promise<{ mirror: string; baseSha: string }> {
  const upstream = join(dir, 'upstream');
  await mkdir(upstream, { recursive: true });
  await runGit(['-C', upstream, 'init', '-q', '-b', 'main']);
  await runGit(['-C', upstream, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com',
    'commit', '--allow-empty', '-m', 'seed']);
  await writeFile(join(upstream, 'README.md'), '# seed\n');
  await runGit(['-C', upstream, 'add', '-A']);
  await runGit(['-C', upstream, '-c', 'user.name=seed', '-c', 'user.email=seed@example.com',
    'commit', '-m', 'add readme']);
  const baseSha = (await runGit(['-C', upstream, 'rev-parse', 'HEAD'])).stdout.trim();
  const mirror = join(dir, 'mirror.git');
  await runGit(['clone', '--bare', '-q', upstream, mirror]);
  return { mirror, baseSha };
}

async function artifactStore(dir: string): Promise<ArtifactStore> {
  const db = await PgliteClient.create();
  await migrate(db);
  // Seed org/project/binding rows so the artifacts FK (attempt_id optional) and
  // scope columns are satisfiable; the store itself only needs scope for keys.
  await db.query('insert into organizations (id, name) values ($1, $2)', [scope.organizationId, 'Acme']);
  await db.query('insert into projects (id, organization_id, name, default_branch) values ($1,$2,$3,$4)',
    [scope.projectId, scope.organizationId, 'web', 'main']);
  const objects = new FilesystemObjectStore(join(dir, 'objects'));
  return new ContentAddressedArtifactStore(db, objects);
}

// --------------------------------------------------------------------------
// E9 / H7 — clone URL is constructed from validated identity; hostile transports rejected.
// --------------------------------------------------------------------------

test('E9: buildCloneUrl accepts only the configured GitHub HTTPS identity', () => {
  assert.equal(
    buildCloneUrl({ githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web' }),
    'https://github.com/acme/web.git',
  );
  // A trailing .git on the repo is tolerated (normalized).
  assert.equal(
    buildCloneUrl({ githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web.git' }),
    'https://github.com/acme/web.git',
  );
});

test('E9: hostile transports / injections are rejected', () => {
  const hostile: Array<{ githubHost: string; githubOwner: string; githubRepo: string }> = [
    { githubHost: 'evil.com', githubOwner: 'a', githubRepo: 'b' },            // host not allowlisted
    { githubHost: 'github.com', githubOwner: '../etc', githubRepo: 'b' },     // traversal
    { githubHost: 'github.com', githubOwner: '-oProxyCommand', githubRepo: 'b' }, // option injection
    { githubHost: 'github.com', githubOwner: 'a\nb', githubRepo: 'c' },        // newline
    { githubHost: 'github.com', githubOwner: 'user@host', githubRepo: 'b' },   // userinfo
    { githubHost: 'github.com', githubOwner: 'a', githubRepo: 'b c' },         // whitespace
  ];
  for (const h of hostile) {
    assert.throws(() => buildCloneUrl(h), RemoteIdentityError, `should reject ${JSON.stringify(h)}`);
  }
  // file:// / ext:: / ssh would arrive as a raw URL — which is never accepted.
  assert.throws(() => rejectRawRemoteUrl('file:///etc/passwd'), RemoteIdentityError);
  assert.throws(() => rejectRawRemoteUrl('ext::sh -c whoami'), RemoteIdentityError);
});

// --------------------------------------------------------------------------
// H3 / CRIT-001 — RefSafetyPolicy is non-bypassable.
// --------------------------------------------------------------------------

test('H3: attemptBranch generates only an ASEP-namespaced ref from ULID ids', () => {
  const id = (c: string) => c.repeat(26);
  const branch = attemptBranch({
    runId: id('R') as RunId, taskId: id('T') as TaskId, attemptId: id('P') as AttemptId,
  });
  assert.match(branch, /^asep\/R{26}\/T{26}\/P{26}$/);
  const spec = safeRefspecFor(branch);
  assert.equal(spec.refspec, `refs/heads/${branch}:refs/heads/${branch}`);
  assert.ok(!spec.refspec.startsWith('+'), 'refspec must not be a force push');
});

test('H3: protected/malformed/foreign refs are rejected', () => {
  for (const bad of ['main', 'master', 'HEAD', 'refs/tags/v1', 'asep/x', '-oProxy', 'feature/foo']) {
    assert.throws(() => safeRefspecFor(bad), RefSafetyError, `should reject '${bad}'`);
  }
});

// --------------------------------------------------------------------------
// E1/E2 — real worktree isolation at a pinned, verified base SHA.
// --------------------------------------------------------------------------

test('E1/E2: create checks out a real worktree pinned at the verified base SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'lease-1' });
    assert.equal(ws.baseSha, baseSha);
    // The worktree really exists and HEAD is the pinned SHA.
    const head = (await runGit(['-C', mgr['paths'].get(ws.workspaceId)!, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(head, baseSha);
    await mgr.cleanup(scope, ws.workspaceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('E2: a base SHA absent from the mirror fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    await assert.rejects(
      () => mgr.create(scope, {
        repositoryBindingId: bindingId, baseSha: '0'.repeat(40), leaseId: 'l',
      }),
      BaseShaError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// E3/E5 — agent-created ref is observed; harness owns the commit + trailers.
// --------------------------------------------------------------------------

test('E3/E5: inspector derives change from git; harness commit carries ASEP trailers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l' });
    const wtPath = mgr['paths'].get(ws.workspaceId)!;

    // Simulate the agent editing a working-tree file (no commit — harness owns that).
    await writeFile(join(wtPath, 'feature.txt'), 'agent change\n');

    const obs = await mgr.inspect(scope, ws.capability);
    assert.ok(obs.changedFiles.includes('feature.txt'), 'inspector sees the changed file');
    assert.equal(obs.diff.kind, 'git-diff');
    // The diff was actually stored + is retrievable and intact.
    const back = await store.get(scope, obs.diff);
    assert.ok(new TextDecoder().decode(back.content).includes('agent change'));

    // Harness commit with trailers.
    const { commitSha } = await mgr.commit(scope, {
      workspace: ws.capability,
      attemptId: ATTEMPT,
      baseSha,
      allowedPaths: ['feature.txt'],
      trailers: { 'ASEP-Run': 'R', 'ASEP-Task': 'T', 'ASEP-Attempt': ATTEMPT, 'ASEP-Evidence': 'E' },
      identity: { name: 'asep-harness', email: 'harness@asep.dev' },
    });
    assert.match(commitSha, /^[0-9a-f]{40}$/);
    const body = (await runGit(['-C', wtPath, 'log', '-1', '--format=%B'])).stdout;
    for (const t of ['ASEP-Run: R', 'ASEP-Task: T', `ASEP-Attempt: ${ATTEMPT}`, 'ASEP-Evidence: E']) {
      assert.ok(body.includes(t), `commit message carries trailer ${t}`);
    }
    // The committer identity is the harness bot, not the agent.
    const committer = (await runGit(['-C', wtPath, 'log', '-1', '--format=%cn <%ce>'])).stdout.trim();
    assert.equal(committer, 'asep-harness <harness@asep.dev>');
    await mgr.cleanup(scope, ws.workspaceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// E3 — a PRE-EXISTING mirror branch (main) must NOT be reported as an
// agent-created ref. inspect() diffs current refs against the create()-time
// baseline, so only a ref that appeared during the agent's turn counts as an
// overstep. Without the baseline, every worktree spawned from a mirror with a
// `main` branch would falsely report createdRefs=[refs/heads/main] and STOP the
// pipeline at inspection for ALL real runs.
// --------------------------------------------------------------------------

test('E3: a pre-existing mirror branch is NOT flagged as an agent-created ref', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l' });
    const wtPath = mgr['paths'].get(ws.workspaceId)!;
    await writeFile(join(wtPath, 'feature.txt'), 'agent change\n');

    const obs = await mgr.inspect(scope, ws.capability);
    // The mirror's own `refs/heads/main` exists at creation → NOT agent-created.
    assert.deepEqual(obs.createdRefs, [], 'pre-existing mirror branch must not count as agent-created');
    assert.equal(obs.touchedGitDir, false);
    assert.ok(obs.changedFiles.includes('feature.txt'));
    await mgr.cleanup(scope, ws.workspaceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('E3: a ref the agent creates AFTER worktree creation IS flagged as an overstep', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l' });
    const wtPath = mgr['paths'].get(ws.workspaceId)!;
    // Simulate an overstepping agent creating a branch ref during its turn.
    await runGit(['-C', wtPath, 'branch', 'agent-made-this']);

    const obs = await mgr.inspect(scope, ws.capability);
    assert.ok(
      obs.createdRefs.includes('refs/heads/agent-made-this'),
      'a ref created after the baseline must be reported as an overstep',
    );
    await mgr.cleanup(scope, ws.workspaceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// HIGH-007 — an agent commit on the DETACHED HEAD advances HEAD WITHOUT
// creating any ref, so createdRefs stays empty and the pre-existing detection
// misses it. This test really invokes `git commit` (not agent prose) on the
// detached worktree and asserts inspect() reports headMovedFromBase=true and a
// headSha != baseSha, the only trusted signal that the untrusted agent
// committed. The clean case (no commit) must report headMovedFromBase=false.
// --------------------------------------------------------------------------

test('HIGH-007: a real detached-HEAD agent commit is detected via headMovedFromBase (no ref created)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l' });
    const wtPath = mgr['paths'].get(ws.workspaceId)!;

    // A clean tree (no commit) must NOT be flagged as HEAD movement.
    const before = await mgr.inspect(scope, ws.capability);
    assert.equal(before.headMovedFromBase, false, 'no commit → HEAD still at base');
    assert.equal(before.headSha, baseSha);
    assert.deepEqual(before.createdRefs, [], 'no ref created by the harness');

    // The untrusted agent commits on the DETACHED HEAD. This advances HEAD but
    // creates NO ref — the exact bypass HIGH-007 closes.
    await writeFile(join(wtPath, 'agent.txt'), 'sneaky agent commit\n');
    await runGit(['-C', wtPath, 'add', '--', 'agent.txt']);
    await runGit([
      '-C', wtPath,
      '-c', 'user.name=Sneaky Agent',
      '-c', 'user.email=agent@untrusted.invalid',
      'commit', '--no-verify', '--no-gpg-sign', '-m', 'agent-authored commit on detached HEAD',
    ]);

    const after = await mgr.inspect(scope, ws.capability);
    assert.equal(after.headMovedFromBase, true, 'detached-HEAD commit MUST be detected');
    assert.notEqual(after.headSha, baseSha, 'HEAD advanced past the pinned base');
    assert.equal(after.baseSha, baseSha, 'the snapshotted base SHA is reported');
    // No ref was created — proving createdRefs alone would have missed this.
    assert.deepEqual(after.createdRefs, [], 'a detached-HEAD commit creates no ref');
    await mgr.cleanup(scope, ws.workspaceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// E6 — path/symlink containment under workspace root.
// --------------------------------------------------------------------------

test('E6: a non-ULID id segment cannot escape the workspace root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    // A binding id containing traversal is rejected before any git runs.
    await assert.rejects(
      () => mgr.create(scope, {
        repositoryBindingId: '../../../etc' as RepositoryBindingId, baseSha, leaseId: 'l',
      }),
      WorktreeContainmentError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// E7 — idempotent cleanup; quarantine moves a faulted worktree aside.
// --------------------------------------------------------------------------

test('E7: cleanup is idempotent and quarantine never reuses a worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha } = await seedMirror(dir);
    const store = await artifactStore(dir);
    const root = join(dir, 'wt');
    await mkdir(root, { recursive: true });
    const mgr = new GitWorktreeManager(
      { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
    );
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l' });
    const wtPath = mgr['paths'].get(ws.workspaceId)!;
    // First cleanup removes it; a second cleanup is a no-op (idempotent).
    await mgr.cleanup(scope, ws.workspaceId);
    await mgr.cleanup(scope, ws.workspaceId); // must not throw
    // Path is gone.
    await assert.rejects(() => stat(wtPath));

    // Quarantine on a fresh worktree moves it aside (the dir no longer exists at the original path).
    const ws2 = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l2' });
    const p2 = mgr['paths'].get(ws2.workspaceId)!;
    await mgr.quarantine(scope, ws2.workspaceId, 'faulted');
    await assert.rejects(() => stat(p2), 'quarantined worktree no longer at original path');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// The commit is the one side effect that is NOT idempotent: running commit()
// twice mints two divergent objects. So an attempt's commit is recorded,
// create-only, under a ref keyed by the attempt in the shared mirror before the
// worktree HEAD moves, and reconcile() — what a resume calls on a PENDING commit
// record — reads that ref. These run on REAL git.
// --------------------------------------------------------------------------

async function commitFixture(dir: string) {
  const { mirror, baseSha } = await seedMirror(dir);
  const store = await artifactStore(dir);
  const root = join(dir, 'wt');
  await mkdir(root, { recursive: true });
  const mgr = new GitWorktreeManager(
    { workspaceRoot: root, mirrorPath: mirror, repositoryBindingId: bindingId }, store,
  );
  const workspace = async () => {
    const ws = await mgr.create(scope, { repositoryBindingId: bindingId, baseSha, leaseId: 'l' });
    return { ws, wtPath: mgr['paths'].get(ws.workspaceId)! };
  };
  const commit = (ws: { capability: { workspaceId: WorkspaceId; leaseId: string } }, attemptId: string, evidenceId: string) =>
    mgr.commit(scope, {
      workspace: ws.capability, attemptId, baseSha,
      allowedPaths: ['feature.txt'],
      trailers: { 'ASEP-Attempt': attemptId, 'ASEP-Evidence': evidenceId },
      identity: { name: 'asep-harness', email: 'harness@asep.dev' },
    });
  return { mirror, baseSha, mgr, workspace, commit };
}

test('reconcile adopts the attempt\'s recorded commit and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { baseSha, mgr, workspace, commit } = await commitFixture(dir);
    const { ws, wtPath } = await workspace();

    // Before any harness commit there is nothing to adopt: the resume may commit.
    assert.equal(await mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha }), null);

    await writeFile(join(wtPath, 'feature.txt'), 'harness change\n');
    const { commitSha } = await commit(ws, ATTEMPT, 'ev-xyz');
    assert.equal((await runGit(['-C', wtPath, 'rev-parse', 'HEAD'])).stdout.trim(), commitSha,
      'the workspace HEAD is the commit');
    assert.equal((await runGit(['-C', wtPath, 'status', '--porcelain'])).stdout.trim(), '',
      'the committed change is clean in the workspace');

    // Crash after the commit, before its record completed: the resume adopts the
    // exact SHA and the evidence id in its trailer — never a second commit.
    const adopted = await mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha });
    assert.deepEqual(adopted, { commitSha, evidenceId: 'ev-xyz' });

    // Another attempt has no commit of its own here.
    assert.equal(await mgr.reconcile(scope, { attemptId: OTHER_ATTEMPT, baseSha }), null);
    await mgr.cleanup(scope, ws.workspaceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successor without the dead executor\'s worktree still finds the attempt\'s commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha, mgr, workspace, commit } = await commitFixture(dir);
    const { ws, wtPath } = await workspace();
    await writeFile(join(wtPath, 'feature.txt'), 'harness change\n');
    const { commitSha } = await commit(ws, ATTEMPT, 'ev-xyz');
    // The worktree is gone (quarantined, cleaned up, or on another host) and the
    // successor is a fresh manager over the same mirror.
    await mgr.quarantine(scope, ws.workspaceId, 'executor crashed');
    const successor = new GitWorktreeManager(
      { workspaceRoot: join(dir, 'wt'), mirrorPath: mirror, repositoryBindingId: bindingId },
      await artifactStore(join(dir, 'other')),
    );
    assert.deepEqual(await successor.reconcile(scope, { attemptId: ATTEMPT, baseSha }), {
      commitSha, evidenceId: 'ev-xyz',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an attempt gets one harness commit: a second commit for it is refused and moves nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { baseSha, mgr, workspace, commit } = await commitFixture(dir);
    const first = await workspace();
    await writeFile(join(first.wtPath, 'feature.txt'), 'one\n');
    const { commitSha } = await commit(first.ws, ATTEMPT, 'ev-1');

    // A zombie of the same attempt in another worktree tries to commit again.
    const second = await workspace();
    await writeFile(join(second.wtPath, 'feature.txt'), 'two\n');
    await assert.rejects(() => commit(second.ws, ATTEMPT, 'ev-2'), HarnessCommitError);
    assert.equal((await runGit(['-C', second.wtPath, 'rev-parse', 'HEAD'])).stdout.trim(), baseSha,
      'the refused commit did not move the workspace');
    assert.deepEqual(await mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha }), {
      commitSha, evidenceId: 'ev-1',
    }, 'the attempt still names its first commit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a recorded attempt commit that is not that attempt\'s harness commit on the base is never adopted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { mirror, baseSha, mgr, workspace, commit } = await commitFixture(dir);
    const { ws, wtPath } = await workspace();
    await writeFile(join(wtPath, 'feature.txt'), 'change\n');
    const { commitSha } = await commit(ws, OTHER_ATTEMPT, 'ev-other');
    const ref = (attemptId: string) => `refs/asep/attempts/${attemptId}`;
    // The ref for ATTEMPT points at another attempt's commit…
    await runGit(['--git-dir', mirror, 'update-ref', ref(ATTEMPT), commitSha]);
    await assert.rejects(() => mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha }), HarnessCommitError);
    // …or at the base itself, which is no harness commit.
    await runGit(['--git-dir', mirror, 'update-ref', ref(ATTEMPT), baseSha]);
    await assert.rejects(() => mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha }), HarnessCommitError);
    // A commit on another base is not this attempt's either.
    await assert.rejects(
      () => mgr.reconcile(scope, { attemptId: OTHER_ATTEMPT, baseSha: commitSha }), HarnessCommitError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a commit whose attempt trailer names another attempt is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { baseSha, mgr, workspace } = await commitFixture(dir);
    const { ws, wtPath } = await workspace();
    await writeFile(join(wtPath, 'feature.txt'), 'change\n');
    await assert.rejects(() => mgr.commit(scope, {
      workspace: ws.capability, attemptId: ATTEMPT, baseSha, allowedPaths: ['feature.txt'],
      trailers: { 'ASEP-Attempt': OTHER_ATTEMPT, 'ASEP-Evidence': 'ev-1' },
      identity: { name: 'asep-harness', email: 'harness@asep.dev' },
    }), HarnessCommitError);
    assert.equal(await mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a harness commit of nothing is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-gw-'));
  try {
    const { baseSha, mgr, workspace } = await commitFixture(dir);
    const { ws, wtPath } = await workspace();
    // An allowed path that exists but did not change: the tree is the base's.
    await assert.rejects(() => mgr.commit(scope, {
      workspace: ws.capability, attemptId: ATTEMPT, baseSha, allowedPaths: ['README.md'],
      trailers: { 'ASEP-Attempt': ATTEMPT, 'ASEP-Evidence': 'ev-1' },
      identity: { name: 'asep-harness', email: 'harness@asep.dev' },
    }), HarnessCommitError);
    assert.equal((await runGit(['-C', wtPath, 'rev-parse', 'HEAD'])).stdout.trim(), baseSha);
    assert.equal(await mgr.reconcile(scope, { attemptId: ATTEMPT, baseSha }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
