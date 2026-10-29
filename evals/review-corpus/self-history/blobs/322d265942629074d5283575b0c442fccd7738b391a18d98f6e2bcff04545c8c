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
  GitWorktreeManager, WorktreeContainmentError, BaseShaError,
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
      allowedPaths: ['feature.txt'],
      trailers: { 'ASEP-Run': 'R', 'ASEP-Task': 'T', 'ASEP-Attempt': 'P', 'ASEP-Evidence': 'E' },
      identity: { name: 'asep-harness', email: 'harness@asep.dev' },
    });
    assert.match(commitSha, /^[0-9a-f]{40}$/);
    const body = (await runGit(['-C', wtPath, 'log', '-1', '--format=%B'])).stdout;
    for (const t of ['ASEP-Run: R', 'ASEP-Task: T', 'ASEP-Attempt: P', 'ASEP-Evidence: E']) {
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
