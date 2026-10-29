// GitHubAppForgePort conformance suite (disp. P2-FINAL-HIGH-008).
//
// THE FINDING this suite locks down: the application's `ForgeProvider` port and
// the GitHub App adapter had incompatible signatures, so the real adapter could
// never be wired into the real driver — "the GitHub App adapter is wired" was
// unfalsifiable. GitHubAppForgePort closes the gap; these tests prove it does so
// WITHOUT introducing a second, weaker safety policy of its own.
//
// What is proven here, against a REAL local bare remote (no HTTP fake for the
// push path — the argv and the resulting remote ref are the evidence):
//   1. the port shape is satisfied (compile-time `implements` + runtime call);
//   2. the EXACT harness commit lands on the remote under the ASEP ref, pushed
//      from a DETACHED worktree that has no local branch of that name — the case
//      the old branch:branch refspec structurally could not express;
//   3. ref safety is still enforced THROUGH the port (protected/foreign refs
//      rejected before any git process runs, and before any token is minted);
//   4. tenant scoping is enforced at the resolver: a binding from another
//      org/project never reaches forge coordinates;
//   5. no merge capability is reachable through the port.
//
// Machine-readable suite marker (exit criterion K4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitHubAppCredentialProvider, GitHubAppForgeProvider, GitHubAppForgePort,
  SqlForgeBindingResolver, ForgeBindingIncompleteError,
} from './index.js';
import type {
  InstallationAuth, OctokitLike, RepositoryForgeConfig, GitRunner,
  ForgeBindingResolver,
} from './index.js';
import { runGit } from '@asep/git-worktree';
import type { ForgeProvider } from '@asep/ports';
import type { TenantScope, RepositoryBindingId } from '@asep/contracts';
// @asep/persistence is a devDependency of this package, so it is available to
// this test but NOT to production source (see binding-resolver.ts). Driving the
// REAL repositories here is the point: the cross-tenant refusal below is the
// database's own predicate, not a fake's `if`.
import {
  PgliteClient, migrate, ScopeViolationError,
  OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
} from '@asep/persistence';

console.log('SUITE-ID: asep-suite:forge-port-adapter');

const REPO_ID = 4242;
const identity = { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web' } as const;
const repository: RepositoryForgeConfig = { identity, repositoryId: REPO_ID };

const id = (c: string) => c.repeat(26);
const attemptBranchStr = `asep/${id('R')}/${id('T')}/${id('P')}`;
const BINDING = id('B') as RepositoryBindingId;

const scope: TenantScope = {
  organizationId: id('O') as TenantScope['organizationId'],
  projectId: id('J') as TenantScope['projectId'],
};
const otherScope: TenantScope = {
  organizationId: id('X') as TenantScope['organizationId'],
  projectId: id('Y') as TenantScope['projectId'],
};

function fakeAuth(token = 'ghs_pushtok'): InstallationAuth {
  return async () => ({ token, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
}

const throwingOctokit = (): OctokitLike => ({
  pulls: {
    list: () => { throw new Error('push must not call REST'); },
    create: () => { throw new Error('push must not call REST'); },
    update: () => { throw new Error('push must not call REST'); },
  },
});

// A resolver that only ever resolves BINDING within `scope`. Anything else
// throws — mirroring the persistence resolver's getScoped/ScopeViolationError.
function scopedResolver(localRepoPath: string): ForgeBindingResolver & { calls: number } {
  const r = {
    calls: 0,
    async resolve(s: TenantScope, bindingId: RepositoryBindingId) {
      r.calls++;
      const sameTenant = s.organizationId === scope.organizationId
        && s.projectId === scope.projectId;
      if (!sameTenant || bindingId !== BINDING) {
        throw new Error(`scope violation: repository_binding ${bindingId} not in scope`);
      }
      return { repository, localRepoPath };
    },
  };
  return r;
}

// ---------------------------------------------------------------------------
// 1 + 2 — the port is satisfied, and the EXACT commit lands on a real remote
// from a DETACHED worktree.
// ---------------------------------------------------------------------------

test('HIGH-008: the port pushes the EXACT harness commit from a detached worktree to a real bare remote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asep-forge-port-'));
  try {
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    await runGit(['init', '--bare', '--initial-branch=main', remote], {});
    await runGit(['init', '--initial-branch=main', work], {});
    await runGit(['config', 'user.email', 'bot@asep.invalid'], { cwd: work });
    await runGit(['config', 'user.name', 'ASEP Bot'], { cwd: work });
    await writeFile(join(work, 'a.txt'), 'hello\n', 'utf8');
    await runGit(['add', 'a.txt'], { cwd: work });
    await runGit(['commit', '-m', 'base'], { cwd: work });

    // Detach HEAD, then make the harness commit on the detached HEAD. There is
    // deliberately NO local branch named `asep/…` anywhere in this repo.
    const headSha = (await runGit(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim();
    await runGit(['checkout', '--detach', headSha], { cwd: work });
    await writeFile(join(work, 'b.txt'), 'harness change\n', 'utf8');
    await runGit(['add', 'b.txt'], { cwd: work });
    await runGit(['commit', '-m', 'harness commit'], { cwd: work });
    const commitSha = (await runGit(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim();

    // Confirm the premise: no local branch of the target name exists, so a
    // branch:branch refspec could not resolve.
    const branches = (await runGit(['branch', '--list', attemptBranchStr], { cwd: work })).stdout.trim();
    assert.equal(branches, '', 'precondition: no local branch named after the attempt ref');

    // Real git, but rewrite the authenticated https URL to the local bare path
    // (there is no network here). Everything else — refspec construction, ref
    // safety, JIT minting, scrubbing — is the adapter's real code path.
    const captured: string[][] = [];
    const localTransport: GitRunner = async (args, opts) => {
      captured.push([...args]);
      const rewritten = args.map((a) => (a.startsWith('https://') ? remote : a));
      return runGit(rewritten, opts);
    };

    const creds = new GitHubAppCredentialProvider(
      { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
    );
    const inner = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], localTransport);
    const resolver = scopedResolver(work);
    // Typed as the PORT: this assignment is itself the conformance proof.
    const port: ForgeProvider = new GitHubAppForgePort(inner, resolver);

    await port.pushBranch(scope, {
      repositoryBindingId: BINDING,
      branch: attemptBranchStr,
      commitSha,
    });

    // The resolver was consulted with the caller's scope.
    assert.equal(resolver.calls, 1);

    // The refspec pushed the immutable OBJECT ID, not a local branch name.
    const argv = captured[0]!;
    const expectedRefspec = `${commitSha}:refs/heads/${attemptBranchStr}`;
    assert.ok(argv.includes(expectedRefspec), `argv must carry ${expectedRefspec}, got ${JSON.stringify(argv)}`);
    assert.ok(!argv.some((a) => a.startsWith('+')), 'no force refspec');
    assert.ok(!argv.includes('--force'), 'no bare --force');

    // THE decisive assertion: the remote ref now points at exactly the harness
    // commit, and nothing else was created.
    const remoteSha = (await runGit(['rev-parse', `refs/heads/${attemptBranchStr}`], { cwd: remote })).stdout.trim();
    assert.equal(remoteSha, commitSha, 'remote ref must equal the exact harness commit');

    const allRefs = (await runGit(['for-each-ref', '--format=%(refname)'], { cwd: remote })).stdout
      .split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(allRefs, [`refs/heads/${attemptBranchStr}`],
      'exactly one ref, under the ASEP namespace');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3 — ref safety still holds THROUGH the port (and before any mint/git call).
// ---------------------------------------------------------------------------

test('HIGH-008: ref safety is enforced through the port — no git, no token mint', async () => {
  let minted = 0;
  const countingAuth: InstallationAuth = async () => {
    minted++;
    return { token: 'ghs_x', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  };
  const runner: GitRunner = async () => { throw new Error('git must not run for a rejected ref'); };
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, countingAuth,
  );
  const inner = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  const port: ForgeProvider = new GitHubAppForgePort(inner, scopedResolver('/tmp/nope'));

  const sha = 'a'.repeat(40);
  for (const bad of ['main', 'master', 'HEAD', 'refs/tags/v1', 'feature/x', '-oProxy', `asep/${id('R')}`]) {
    await assert.rejects(
      () => port.pushBranch(scope, { repositoryBindingId: BINDING, branch: bad, commitSha: sha }),
      `port must reject push to '${bad}'`,
    );
  }
  assert.equal(minted, 0, 'a rejected ref must never mint a credential');
});

test('HIGH-008: an abbreviated/malformed commit SHA is rejected (no ambiguous object push)', async () => {
  const runner: GitRunner = async () => { throw new Error('git must not run for a bad sha'); };
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
  );
  const inner = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  const port: ForgeProvider = new GitHubAppForgePort(inner, scopedResolver('/tmp/nope'));

  for (const badSha of ['abc1234', '', 'z'.repeat(40), 'A'.repeat(40), `${'a'.repeat(40)} --upload-pack=evil`]) {
    await assert.rejects(
      () => port.pushBranch(scope, {
        repositoryBindingId: BINDING, branch: attemptBranchStr, commitSha: badSha,
      }),
      `port must reject commit sha '${badSha}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4 — tenant scoping: a foreign binding never reaches forge coordinates.
// ---------------------------------------------------------------------------

test('HIGH-008: a binding outside the caller scope is rejected before any forge call', async () => {
  const runner: GitRunner = async () => { throw new Error('git must not run for a foreign binding'); };
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
  );
  const inner = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  const port: ForgeProvider = new GitHubAppForgePort(inner, scopedResolver('/tmp/nope'));

  const sha = 'a'.repeat(40);
  // Right binding id, WRONG tenant — the IDOR shape.
  await assert.rejects(
    () => port.pushBranch(otherScope, {
      repositoryBindingId: BINDING, branch: attemptBranchStr, commitSha: sha,
    }),
    /scope violation/,
  );
  // Foreign binding id inside a legitimate scope.
  await assert.rejects(
    () => port.pushBranch(scope, {
      repositoryBindingId: id('Z') as RepositoryBindingId, branch: attemptBranchStr, commitSha: sha,
    }),
    /scope violation/,
  );
  await assert.rejects(
    () => port.upsertPullRequest(otherScope, {
      repositoryBindingId: BINDING, headBranch: attemptBranchStr, base: 'main', title: 't', body: 'b',
    }),
    /scope violation/,
  );
});

// ---------------------------------------------------------------------------
// PR upsert through the port: idempotent, narrowed to the port's ref shape.
// ---------------------------------------------------------------------------

test('HIGH-008: PR upsert through the port is idempotent and returns the port ref shape', async () => {
  const store: Array<{ number: number; html_url: string; head: { ref: string }; base: { ref: string } }> = [];
  let creates = 0;
  const octokitFor = (): OctokitLike => ({
    pulls: {
      list: async ({ head }) => ({
        data: store.filter((pr) => head.endsWith(pr.head.ref)),
      }),
      create: async ({ head, base }) => {
        creates++;
        const pr = {
          number: store.length + 1,
          html_url: `https://github.com/acme/web/pull/${store.length + 1}`,
          head: { ref: head }, base: { ref: base },
        };
        store.push(pr);
        return { data: pr };
      },
      update: async ({ pull_number }) => ({ data: store.find((p) => p.number === pull_number)! }),
    },
  });

  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
  );
  const inner = new GitHubAppForgeProvider(creds, octokitFor, ['github.com']);
  const port: ForgeProvider = new GitHubAppForgePort(inner, scopedResolver('/tmp/wt'));

  const args = {
    repositoryBindingId: BINDING, headBranch: attemptBranchStr,
    base: 'main', title: 'Governed change', body: 'evidence',
  };
  const first = await port.upsertPullRequest(scope, args);
  const second = await port.upsertPullRequest(scope, args);

  assert.equal(creates, 1, 'a repeat upsert must NOT open a duplicate PR');
  assert.equal(first.number, second.number);
  assert.equal(first.headBranch, attemptBranchStr);
  assert.equal(first.baseBranch, 'main');
  assert.match(first.url, /^https:\/\/github\.com\/acme\/web\/pull\/1$/);
  // Exactly the port's canonical shape — no adapter-specific fields leak.
  assert.deepEqual(Object.keys(first).sort(), ['baseBranch', 'headBranch', 'number', 'url']);
});

// The pilot verifier asks the forge which commit a reviewed PR shows right now;
// the port carries the head commit GitHub reports, and nothing when it reports
// none.
test('a PR looked up through the port reports the commit its head points at', async () => {
  const headSha = 'c'.repeat(40);
  const prs = [{
    number: 7, html_url: 'https://github.com/acme/web/pull/7',
    head: { ref: attemptBranchStr, sha: headSha }, base: { ref: 'main' },
  }];
  const octokitFor = (): OctokitLike => ({
    pulls: {
      list: async ({ head }) => ({ data: prs.filter((pr) => head.endsWith(pr.head.ref)) }),
      create: async () => { throw new Error('a lookup must not create'); },
      update: async () => { throw new Error('a lookup must not update'); },
    },
  });
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
  );
  const port: ForgeProvider = new GitHubAppForgePort(
    new GitHubAppForgeProvider(creds, octokitFor, ['github.com']), scopedResolver('/tmp/wt'),
  );
  const found = await port.findPullRequest(scope, { repositoryBindingId: BINDING, headBranch: attemptBranchStr });
  assert.deepEqual(found, {
    number: 7, url: 'https://github.com/acme/web/pull/7', headBranch: attemptBranchStr, baseBranch: 'main', headSha,
  });

  delete (prs[0]!.head as { sha?: string }).sha;
  const unreported = await port.findPullRequest(scope, { repositoryBindingId: BINDING, headBranch: attemptBranchStr });
  assert.equal(unreported !== null && 'headSha' in unreported, false, 'an unreported head is absent, not invented');
});

// ---------------------------------------------------------------------------
// 5 — H5: no merge capability is reachable through the port.
// ---------------------------------------------------------------------------

test('H5: the port exposes no merge capability', () => {
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
  );
  const inner = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com']);
  const port = new GitHubAppForgePort(inner, scopedResolver('/tmp/wt'));

  const names = new Set<string>();
  for (let p: object | null = port; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) names.add(k);
  }
  for (const forbidden of ['merge', 'mergePullRequest', 'squash', 'rebaseAndMerge']) {
    assert.equal(names.has(forbidden), false, `port must not expose '${forbidden}'`);
  }
  // The H5 claim is about reachable CAPABILITIES (callable methods), not about
  // injected collaborator fields: TypeScript `private readonly` constructor
  // parameter properties (inner, resolver) are ordinary own data fields, and
  // asserting on them would couple this test to the class's wiring style rather
  // than to its surface. So enumerate only the methods.
  const methods = [...names]
    .filter((n) => n !== 'constructor')
    .filter((n) => typeof (port as unknown as Record<string, unknown>)[n] === 'function')
    .sort();
  // The list is pinned EXACTLY (not a substring check) so any new capability has
  // to be added here deliberately and justified. The two reconcile methods are
  // READ-ONLY lookups the crash-recovery protocol needs (disp. P2-FINAL-HIGH-006):
  // `resolveRef` is an ls-remote and `findPullRequest` is a PR query — neither
  // publishes anything, and neither can merge. The two write capabilities remain
  // exactly push + PR upsert.
  assert.deepEqual(methods, [
    'findPullRequest', 'pushBranch', 'resolveRef', 'upsertPullRequest',
  ]);
});

// ---------------------------------------------------------------------------
// 6 — the PRODUCTION resolver against a REAL migrated database.
//
// The tests above use a hand-written resolver, which proves the port seam but
// NOT that the shipped SqlForgeBindingResolver enforces anything. These drive
// the real class against a real schema so the scoping claim is evidence rather
// than assertion: the tenant check is the DB's WHERE clause, not our fake's `if`.
// ---------------------------------------------------------------------------

test('HIGH-008: the production resolver resolves only in-scope bindings (real DB)', async () => {
  const client = await PgliteClient.create();
  await migrate(client);

  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);

  // Tenant A, with the numeric forge id recorded.
  const orgA = await orgs.create({ name: 'org-a' });
  const projA = await projects.create({
    organizationId: orgA.id, name: 'proj-a', defaultBranch: 'main',
  });
  const scopeA: TenantScope = { organizationId: orgA.id, projectId: projA.id };
  const bindingA = await bindings.create(scopeA, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
    defaultBaseBranch: 'main', githubRepositoryId: REPO_ID,
  });

  // Tenant B — a different org entirely.
  const orgB = await orgs.create({ name: 'org-b' });
  const projB = await projects.create({
    organizationId: orgB.id, name: 'proj-b', defaultBranch: 'main',
  });
  const scopeB: TenantScope = { organizationId: orgB.id, projectId: projB.id };

  const resolver = new SqlForgeBindingResolver(bindings, {
    localRepoPathFor: () => '/tmp/wt',
  });

  // In scope: resolves to the recorded coordinates, including the numeric id
  // that makes least-privilege token minting possible.
  const resolved = await resolver.resolve(scopeA, bindingA.id);
  assert.deepEqual(resolved.repository, {
    identity: { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web' },
    repositoryId: REPO_ID,
  });

  // Cross-tenant: tenant B naming tenant A's REAL binding id is refused by the
  // DB predicate. This is the IDOR case — a valid id is not authorization.
  await assert.rejects(
    () => resolver.resolve(scopeB, bindingA.id),
    ScopeViolationError,
    'a binding from another org must not resolve into forge coordinates',
  );
});

test('HIGH-008: a binding with no numeric forge id fails closed (no broader token)', async () => {
  const client = await PgliteClient.create();
  await migrate(client);

  const orgs = new OrganizationRepository(client);
  const projects = new ProjectRepository(client);
  const bindings = new RepositoryBindingRepository(client);

  const org = await orgs.create({ name: 'org-c' });
  const proj = await projects.create({
    organizationId: org.id, name: 'proj-c', defaultBranch: 'main',
  });
  const s: TenantScope = { organizationId: org.id, projectId: proj.id };

  // Registered WITHOUT githubRepositoryId — the legacy/partial case.
  const binding = await bindings.create(s, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web',
    defaultBaseBranch: 'main',
  });

  const resolver = new SqlForgeBindingResolver(bindings, {
    localRepoPathFor: () => '/tmp/wt',
  });

  // Minting would have to fall back to an installation-wide token, which is
  // strictly broader than the operation needs (H2). Refuse instead of widening.
  await assert.rejects(
    () => resolver.resolve(s, binding.id),
    ForgeBindingIncompleteError,
    'a missing numeric forge id must fail closed, never mint an unscoped token',
  );
});

// Only a push needs the local repository. A PR lookup or a remote-ref probe
// through the production resolver must work when no worktree can be located —
// a resume in a fresh process, or the pilot verifier, which never pushes.
test('PR and ref lookups through the production resolver never ask for the local repository', async () => {
  let located = 0;
  const reader = {
    getScoped: async (s: TenantScope, bindingId: RepositoryBindingId) => {
      assert.deepEqual(s, scope);
      assert.equal(bindingId, BINDING);
      return { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web', githubRepositoryId: REPO_ID };
    },
  };
  const resolver = new SqlForgeBindingResolver(reader, {
    localRepoPathFor: () => { located++; throw new Error('no local repository here'); },
  });
  const octokitFor = (): OctokitLike => ({
    pulls: {
      list: async () => ({ data: [] }),
      create: async () => { throw new Error('a lookup must not create'); },
      update: async () => { throw new Error('a lookup must not update'); },
    },
  });
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(),
  );
  const port = new GitHubAppForgePort(new GitHubAppForgeProvider(creds, octokitFor, ['github.com']), resolver);

  assert.equal(await port.findPullRequest(scope, { repositoryBindingId: BINDING, headBranch: attemptBranchStr }), null);
  assert.equal(located, 0, 'the lookup never located a repository');
  await assert.rejects(
    () => port.pushBranch(scope, { repositoryBindingId: BINDING, branch: attemptBranchStr, commitSha: 'a'.repeat(40) }),
    /no local repository here/,
    'a push still needs it, and fails closed without it',
  );
  assert.equal(located, 1);
});
