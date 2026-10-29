// GitHub App forge adapter suite (exit criteria H1–H7, disp. P2-PLAN-CRIT-001,
// HIGH-007, MED-005). The transport boundary (git push + Octokit REST) is driven
// by fakes so the adapter's OWN logic runs — never mocked application logic (H6).
// The H3 push test drives a REAL local bare remote to prove that only the exact
// ASEP-namespaced refspec is ever handed to git and that a real push lands there.
//
// Machine-readable suite marker (exit criterion K4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitHubAppCredentialProvider, MINIMUM_PERMISSIONS, isExpired,
  GitHubAppForgeProvider, ForgePushError, ForgeAuthExpiredError, ForgeReconcileError,
  isAuthExpiryError, MAX_REMINT_ATTEMPTS, scrubToken,
} from './index.js';
import type {
  InstallationAuth, OctokitLike, RepositoryForgeConfig, GitRunner,
} from './index.js';
import { runGit } from '@asep/git-worktree';
import { pullRequestContent } from '@asep/ports';

console.log('SUITE-ID: asep-suite:github-app');

const REPO_ID = 4242;
const identity = { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web' } as const;
const repository: RepositoryForgeConfig = { identity, repositoryId: REPO_ID };

// A ULID-shaped id (Crockford base32, 26 chars) so attempt-branch validation passes.
const id = (c: string) => c.repeat(26);
const attemptBranchStr = `asep/${id('R')}/${id('T')}/${id('P')}`;
// The attempt's commit, as a push names it, and another full SHA.
const COMMIT = 'c'.repeat(40);
const SHA = 'a'.repeat(40);
const firstPush = { commitSha: COMMIT, expectedRemoteSha: null };

// ---------------------------------------------------------------------------
// H1/H2 — JIT token minting: opaque, scoped to the exact repo + minimum perms,
// never persisted; fake-clock expiry/re-mint.
// ---------------------------------------------------------------------------

test('H2: token is minted JIT scoped to the exact repository + minimum permissions', async () => {
  const calls: Array<{ installationId: number; repositoryIds?: readonly number[] | undefined; permissions?: Record<string, string> | undefined }> = [];
  const auth: InstallationAuth = async (opts) => {
    calls.push(opts);
    return { token: 'ghs_opaqueJIT', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  };
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 99 }, auth,
  );
  const tok = await creds.mintForRepository(REPO_ID);
  assert.equal(tok.token, 'ghs_opaqueJIT');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.repositoryIds, [REPO_ID]);
  assert.deepEqual(calls[0]!.permissions, { ...MINIMUM_PERMISSIONS });
  // minimum permissions grant nothing that could merge or alter branch protection.
  assert.equal((MINIMUM_PERMISSIONS as Record<string, string>)['administration'], undefined);
  assert.equal((MINIMUM_PERMISSIONS as Record<string, string>)['workflows'], undefined);
});

test('H2: an empty token from the auth strategy fails closed', async () => {
  const auth: InstallationAuth = async () => ({ token: '', expiresAt: new Date().toISOString() });
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 99 }, auth);
  await assert.rejects(() => creds.mintForRepository(REPO_ID), /no token/);
});

test('H2: fake-clock expiry drives a re-mint without reusing a stale token', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const expiresAt = new Date(base + 3600_000).toISOString();
  // Not expired well before expiry.
  assert.equal(isExpired(expiresAt, base), false);
  // Expired at/after expiry.
  assert.equal(isExpired(expiresAt, base + 3600_000), true);
  // Safety skew forces an earlier re-mint.
  assert.equal(isExpired(expiresAt, base + 3540_000, 120_000), true);
  // An unparseable expiry is treated as expired (fail closed).
  assert.equal(isExpired('not-a-date', base), true);
});

// ---------------------------------------------------------------------------
// H3 / CRIT-001 — only the exact ASEP-namespaced refspec is ever sent to git,
// and a real local bare push lands exactly there. Non-namespaced/protected
// targets are rejected before any git call.
// ---------------------------------------------------------------------------

function fakeAuth(token = 'ghs_pushtok'): InstallationAuth {
  return async () => ({ token, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
}
// Octokit is unused by pushBranch; a throwing stub proves push never touches REST.
const throwingOctokit = (): OctokitLike => ({
  pulls: {
    list: () => { throw new Error('push must not call REST'); },
    create: () => { throw new Error('push must not call REST'); },
    update: () => { throw new Error('push must not call REST'); },
  },
});

test('H3: only the exact commit, onto the exact namespaced ref, under a lease, is handed to git (argv capture)', async () => {
  const captured: string[][] = [];
  const runner: GitRunner = async (args) => { captured.push([...args]); return { stdout: '', stderr: '', exitCode: 0 }; };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);

  await forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush });
  await forge.pushBranch({
    repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, commitSha: COMMIT, expectedRemoteSha: SHA,
  });

  assert.equal(captured.length, 2);
  const target = `refs/heads/${attemptBranchStr}`;
  for (const [argv, expected] of [[captured[0]!, ''], [captured[1]!, SHA]] as const) {
    // The refspec is the exact commit onto the exact ref, never a force (+) or delete (:).
    assert.ok(argv.includes(`${COMMIT}:${target}`), 'exact commit and namespaced ref must be present');
    // Compare-and-set: the remote takes it only while the ref holds `expected`
    // (empty: absent).
    assert.deepEqual(argv.filter((a) => a.startsWith('--force-with-lease')), [`--force-with-lease=${target}:${expected}`]);
    assert.ok(!argv.some((a) => a.startsWith('+')), 'no force refspec');
    assert.ok(!argv.some((a) => a === '--force' || a === '-f'), 'no bare --force');
    // The URL is https + carries no raw token in a form other than scrubbed userinfo.
    assert.ok(argv.some((a) => a.startsWith('https://')), 'https transport URL present');
  }
});

test('H3: an abbreviated commit or lease value is refused before any git call', async () => {
  const runner: GitRunner = async () => { throw new Error('git must not run for an ambiguous value'); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  for (const [commitSha, expectedRemoteSha] of [['abc1234', null], [COMMIT, 'abc1234'], [COMMIT, '']] as const) {
    await assert.rejects(
      () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, commitSha, expectedRemoteSha }),
      /not a full 40-hex commit SHA/,
    );
  }
});

test('H3: protected/foreign/malformed branches are rejected before any git call', async () => {
  const runner: GitRunner = async () => { throw new Error('git must not run for a rejected ref'); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  for (const bad of ['main', 'master', 'HEAD', 'refs/tags/v1', 'feature/x', '-oProxy', `asep/${id('R')}`]) {
    await assert.rejects(
      () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: bad, ...firstPush }),
      `should reject push to '${bad}'`,
    );
  }
});

test('H3/E1: a real local bare push lands exactly on the namespaced ref', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-forge-'));
  try {
    // Build a real bare remote + a local worktree with a commit to push.
    const bare = join(dir, 'remote.git');
    await runGit(['init', '--bare', '-q', '-b', 'main', bare]);
    const wt = join(dir, 'wt');
    await mkdir(wt, { recursive: true });
    await runGit(['-C', wt, 'init', '-q', '-b', attemptBranchStr]);
    await writeFile(join(wt, 'f.txt'), 'hello\n');
    await runGit(['-C', wt, 'add', '-A']);
    await runGit(['-C', wt, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit', '-m', 'work']);
    const commitSha = (await runGit(['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim();

    // A runner that rewrites the constructed https URL to the local bare path,
    // preserving the EXACT refspec argv the provider chose (the safety property).
    const runner: GitRunner = async (args, opts) => {
      const rewritten = args.map((a) => (a.startsWith('https://') ? bare : a));
      return runGit(rewritten, opts);
    };
    const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
    const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);

    const { ref } = await forge.pushBranch({
      repository, localWorktreePath: wt, branch: attemptBranchStr, commitSha, expectedRemoteSha: null,
    });
    assert.equal(ref, `refs/heads/${attemptBranchStr}`);

    // The bare remote now has exactly that ref and nothing on main.
    const refs = (await runGit(['-C', bare, 'for-each-ref', '--format=%(refname)'])).stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(refs, [`refs/heads/${attemptBranchStr}`]);
    assert.ok(!refs.includes('refs/heads/main'), 'must not have pushed to main');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A stale owner may still reach the forge after a takeover; the push is what
// holds it. Driven against a REAL bare remote, so the remote, not this adapter,
// applies the compare-and-set.
test('a push is compare-and-set at the remote: a late push of the same commit changes nothing, of another is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asep-forge-cas-'));
  try {
    const bare = join(dir, 'remote.git');
    await runGit(['init', '--bare', '-q', '-b', 'main', bare]);
    const wt = join(dir, 'wt');
    await mkdir(wt, { recursive: true });
    await runGit(['-C', wt, 'init', '-q', '-b', 'work']);
    const commit = async (file: string): Promise<string> => {
      await writeFile(join(wt, file), `${file}\n`);
      await runGit(['-C', wt, 'add', '-A']);
      await runGit(['-C', wt, '-c', 'user.name=harness', '-c', 'user.email=harness@example.com', 'commit', '-q', '-m', file]);
      return (await runGit(['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim();
    };
    const attempt = await commit('attempt.txt');
    const other = await commit('other.txt');
    const runner: GitRunner = async (args, opts) => runGit(args.map((a) => (a.startsWith('https://') ? bare : a)), opts);
    const forge = new GitHubAppForgeProvider(
      new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()),
      throwingOctokit, ['github.com'], runner,
    );
    const push = (commitSha: string, expectedRemoteSha: string | null) => forge.pushBranch({
      repository, localWorktreePath: wt, branch: attemptBranchStr, commitSha, expectedRemoteSha,
    });
    const tip = async () => (await runGit(
      ['-C', bare, 'rev-parse', '--verify', '-q', `refs/heads/${attemptBranchStr}`], { allowNonZero: true },
    )).stdout.trim();

    // The successor publishes the attempt's commit over an absent branch.
    await push(attempt, null);
    assert.equal(await tip(), attempt);
    // The stale owner's late push of that same commit, expecting absent: a no-op.
    await push(attempt, null);
    assert.equal(await tip(), attempt);
    // A late push of any other commit, expecting absent: refused by the remote.
    await assert.rejects(() => push(other, null), (err: unknown) => {
      assert.ok(err instanceof ForgePushError, String(err));
      assert.match(err.message, /stale info/);
      return true;
    });
    // …and expecting a value the branch never held: refused too.
    await assert.rejects(() => push(other, 'e'.repeat(40)), /stale info/);
    assert.equal(await tip(), attempt, 'the branch still holds the attempt\'s commit');
    // A repair names what it found, so it lands only over that.
    await push(other, attempt);
    assert.equal(await tip(), other);
    await assert.rejects(() => push(attempt, null), /stale info/);
    assert.equal(await tip(), other);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H7 / HIGH-007 — the remote URL is constructed from validated identity; a host
// outside the allowlist is rejected before any token mint or git call.
// ---------------------------------------------------------------------------

test('H7: a host outside the allowlist is rejected before minting or pushing', async () => {
  let minted = false;
  const auth: InstallationAuth = async () => { minted = true; return { token: 't', expiresAt: new Date().toISOString() }; };
  const runner: GitRunner = async () => { throw new Error('git must not run'); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, auth);
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  const evil: RepositoryForgeConfig = {
    identity: { githubHost: 'evil.example.com', githubOwner: 'acme', githubRepo: 'web' },
    repositoryId: REPO_ID,
  };
  await assert.rejects(
    () => forge.pushBranch({ repository: evil, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush }),
    /not in the configured allowlist/,
  );
  assert.equal(minted, false, 'token must not be minted for a rejected host');
});

// ---------------------------------------------------------------------------
// H4 — idempotent PR upsert: find-by-head-branch → update, else create.
// H6 — driven at the transport (REST) boundary, not mocked application logic.
// ---------------------------------------------------------------------------

interface FakePr {
  number: number; html_url: string; head: { ref: string }; base: { ref: string }; title?: string; body?: string;
  state: 'open' | 'closed'; merged_at: string | null;
}

// An in-memory GitHub pulls API. Reads hand back copies, newest first, as the
// REST API lists them (a listed PR says it was merged by `merged_at`); a create
// for a head that already has an open PR is refused, as GitHub refuses it.
function fakeOctokit(store: { prs: FakePr[]; nextNumber: number; calls: string[] }): (token: string) => OctokitLike {
  const copy = (pr: FakePr): FakePr => structuredClone(pr);
  return () => ({
    pulls: {
      list: async ({ head }) => {
        store.calls.push('list');
        const ref = head.split(':')[1];
        return { data: store.prs.filter((p) => p.head.ref === ref).map(copy).reverse() };
      },
      create: async ({ head, base, title, body }) => {
        store.calls.push('create');
        if (store.prs.some((p) => p.head.ref === head && p.state === 'open')) {
          throw { status: 422, message: `Validation Failed: A pull request already exists for acme:${head}.` };
        }
        const pr: FakePr = {
          number: store.nextNumber++, html_url: `https://github.com/acme/web/pull/${store.nextNumber - 1}`,
          head: { ref: head }, base: { ref: base }, title, body, state: 'open', merged_at: null,
        };
        store.prs.push(pr);
        return { data: { ...copy(pr), merged: false } };
      },
      update: async (params) => {
        store.calls.push('update');
        const pr = store.prs.find((p) => p.number === params.pull_number)!;
        // GitHub retargets a PR only when it is asked to.
        const base = (params as { base?: string }).base;
        Object.assign(pr, { title: params.title, body: params.body, ...(base !== undefined ? { base: { ref: base } } : {}) });
        return { data: { ...copy(pr), merged: pr.merged_at !== null } };
      },
    },
  });
}

// A human closes the PR on GitHub, or merges it.
function closeOnForge(store: { prs: FakePr[] }, number: number, merged: boolean): void {
  Object.assign(store.prs.find((p) => p.number === number)!, {
    state: 'closed', merged_at: merged ? '2026-10-30T00:00:00Z' : null,
  });
}

test('a lookup reports whether the PR is open and whether it was merged', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
  const forge = new GitHubAppForgeProvider(
    new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()), fakeOctokit(store), ['github.com'],
  );
  const opened = await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T', body: 'B' });
  assert.deepEqual([opened.state, opened.merged], ['open', false]);
  const found = async () => {
    const pr = await forge.findPullRequest({ repository, headBranch: attemptBranchStr });
    return [pr?.state, pr?.merged];
  };
  assert.deepEqual(await found(), ['open', false]);
  closeOnForge(store, 7, false);
  assert.deepEqual(await found(), ['closed', false]);
  closeOnForge(store, 7, true);
  assert.deepEqual(await found(), ['closed', true]);
});

test('an upsert never reopens, edits or duplicates a PR a human closed or merged', async () => {
  for (const merged of [false, true]) {
    const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
    const forge = new GitHubAppForgeProvider(
      new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()), fakeOctokit(store), ['github.com'],
    );
    await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T', body: 'B' });
    closeOnForge(store, 7, merged);
    const before = JSON.stringify(store.prs);
    store.calls.length = 0;
    const again = await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'release', title: 'T2', body: 'B2' });
    assert.deepEqual(store.calls, ['list'], 'read only: no update, no create');
    assert.equal(JSON.stringify(store.prs), before, 'the closed PR is exactly as the human left it');
    assert.deepEqual([again.number, again.state, again.merged], [7, 'closed', merged]);
  }
});

test('the open PR for a head wins over an older closed one', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
  const forge = new GitHubAppForgeProvider(
    new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()), fakeOctokit(store), ['github.com'],
  );
  store.prs.push({
    number: 9, html_url: 'https://github.com/acme/web/pull/9', head: { ref: attemptBranchStr }, base: { ref: 'main' },
    state: 'open', merged_at: null,
  }, {
    number: 3, html_url: 'https://github.com/acme/web/pull/3', head: { ref: attemptBranchStr }, base: { ref: 'main' },
    state: 'closed', merged_at: null,
  });
  assert.equal((await forge.findPullRequest({ repository, headBranch: attemptBranchStr }))?.number, 9);
});

test('H4/H6: PR upsert creates on first call and updates on the second (idempotent)', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, fakeOctokit(store), ['github.com']);

  const first = await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T1', body: 'B1' });
  assert.equal(first.number, 7);
  assert.equal(first.headBranch, attemptBranchStr);

  const second = await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T2', body: 'B2' });
  assert.equal(second.number, 7, 'same PR — no duplicate created');
  assert.equal(store.prs.length, 1, 'exactly one PR exists');
  assert.deepEqual(store.calls, ['list', 'create', 'list', 'update']);
  // Exactly what it was given, and nothing of its own.
  assert.deepEqual(
    { title: store.prs[0]!.title, body: store.prs[0]!.body, base: store.prs[0]!.base.ref },
    { title: 'T2', body: 'B2', base: 'main' },
  );
});

test('an upsert never retargets or edits an open PR that is on another base', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
  const forge = new GitHubAppForgeProvider(
    new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()), fakeOctokit(store), ['github.com'],
  );
  await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T', body: 'B' });
  const before = JSON.stringify(store.prs);
  store.calls.length = 0;
  const again = await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'release', title: 'T2', body: 'B2' });
  assert.deepEqual(store.calls, ['list'], 'read only: no update, no create');
  assert.equal(JSON.stringify(store.prs), before);
  assert.deepEqual([again.number, again.baseBranch, again.state], [7, 'main', 'open']);
});

// GitHub has no compare-and-set for a PR update, so an owner paused inside the
// transport — between reading the PR and writing it — still writes after a
// newer owner. What makes that harmless is that both write the content of the
// attempt's facts. This is the reviewer's interleaving, held exactly between
// pulls.list() and the write.
const facts = { taskId: id('T'), attemptId: id('P'), commitSha: COMMIT, evidenceId: id('E'), base: 'main' };

// Owner 1's transport, held after its read until `release`; owner 2 shares the store.
function heldAfterRead(store: { prs: FakePr[]; nextNumber: number; calls: string[] }) {
  let release!: () => void;
  const released = new Promise<void>((res) => { release = res; });
  let read!: () => void;
  const hasRead = new Promise<void>((res) => { read = res; });
  const inner = fakeOctokit(store);
  const octokit = (token: string): OctokitLike => {
    const real = inner(token);
    return {
      pulls: {
        list: async (params) => { const r = await real.pulls.list(params); read(); await released; return r; },
        create: real.pulls.create,
        update: real.pulls.update,
      },
    };
  };
  return { octokit, hasRead, release };
}

const ownerForge = (octokit: (token: string) => OctokitLike) => new GitHubAppForgeProvider(
  new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()), octokit, ['github.com'],
);
const upsertFacts = (forge: GitHubAppForgeProvider) => forge.upsertPullRequest({
  repository, headBranch: attemptBranchStr, base: facts.base, ...pullRequestContent(facts),
});

test('owner 1 reads the PR, owner 2 updates it, owner 1 updates it: the PR is byte-identical to owner 2\'s', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
  // The PR as the attempt's first owner opened it.
  await upsertFacts(ownerForge(fakeOctokit(store)));
  const held = heldAfterRead(store);
  const owner1 = upsertFacts(ownerForge(held.octokit));
  await held.hasRead;
  await upsertFacts(ownerForge(fakeOctokit(store)));
  const afterOwner2 = JSON.stringify(store.prs);
  held.release();
  await owner1;
  assert.equal(JSON.stringify(store.prs), afterOwner2, 'owner 1\'s late write changed nothing');
  assert.deepEqual(store.calls, ['list', 'create', 'list', 'list', 'update', 'update']);
  assert.equal(store.prs[0]!.title, pullRequestContent(facts).title);
  assert.equal(store.prs[0]!.body, pullRequestContent(facts).body);
});

test('owner 1 reads no PR, owner 2 opens it, owner 1 tries to open it: still owner 2\'s one PR', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 7, calls: [] as string[] };
  const held = heldAfterRead(store);
  const owner1 = upsertFacts(ownerForge(held.octokit));
  await held.hasRead;
  await upsertFacts(ownerForge(fakeOctokit(store)));
  const afterOwner2 = JSON.stringify(store.prs);
  held.release();
  await assert.rejects(owner1, (err: unknown) => {
    assert.equal((err as { status?: number }).status, 422, 'GitHub refuses a second PR for the head');
    return true;
  });
  assert.equal(JSON.stringify(store.prs), afterOwner2);
  assert.equal(store.prs.length, 1);
});

// ---------------------------------------------------------------------------
// H5 — no merge capability exists anywhere in the adapter surface.
// ---------------------------------------------------------------------------

test('H5: the adapter exposes no merge capability', () => {
  const store = { prs: [] as FakePr[], nextNumber: 1, calls: [] as string[] };
  const octokit = fakeOctokit(store)('t');
  // The PullsApi shape wired into the adapter has no `merge` member.
  assert.equal((octokit.pulls as unknown as Record<string, unknown>)['merge'], undefined);
  const forge = new GitHubAppForgeProvider(
    new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth()),
    fakeOctokit(store), ['github.com'],
  );
  assert.equal((forge as unknown as Record<string, unknown>)['merge'], undefined);
  assert.equal((forge as unknown as Record<string, unknown>)['mergePullRequest'], undefined);
});

// ---------------------------------------------------------------------------
// H1/H7 — a token that leaks into a git error is scrubbed before it surfaces.
// ---------------------------------------------------------------------------

test('H1: a token appearing in a git failure is scrubbed from the thrown error', async () => {
  const token = 'ghs_secretLeak123';
  const runner: GitRunner = async () => { throw new Error(`fatal: auth for https://x-access-token:${token}@github.com/acme/web.git failed`); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(token));
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  await assert.rejects(
    () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush }),
    (err: unknown) => {
      assert.ok(err instanceof ForgePushError);
      assert.ok(!err.message.includes(token), 'token must be scrubbed from the error');
      assert.ok(err.message.includes('***'), 'scrubbed marker present');
      return true;
    },
  );
});

test('scrubToken redacts the token and any userinfo form', () => {
  const token = 'ghs_abc';
  const out = scrubToken(`url https://x-access-token:${token}@host.com and https://user@host`, token);
  assert.ok(!out.includes(token));
  assert.ok(!out.includes('user@host'));
  assert.ok(out.includes('***'));
});

// ---------------------------------------------------------------------------
// MED-002 — token expiry / revocation / rotation recovery. A credential that
// expires or is revoked BETWEEN mint and use is recovered by a bounded re-mint
// (a fresh token per attempt, never a stale one). A persistently-invalid
// credential fails closed after the bound; a non-auth failure fails fast.
// ---------------------------------------------------------------------------

test('MED-002: isAuthExpiryError recognises expiry/revocation signals and ignores unrelated errors', () => {
  // Credential wording => recoverable by a fresh mint.
  assert.equal(isAuthExpiryError(new Error('Bad credentials')), true);
  assert.equal(isAuthExpiryError(new Error('token expired')), true);
  assert.equal(isAuthExpiryError(new Error('requires authentication')), true);
  assert.equal(isAuthExpiryError(new Error('token was revoked')), true);
  assert.equal(isAuthExpiryError(new Error('installation has been suspended')), true);
  // 401 is unconditionally "this credential is not usable".
  assert.equal(isAuthExpiryError({ status: 401, message: 'x' }), true);
  // A 403 WITH credential wording is expiry.
  assert.equal(isAuthExpiryError({ status: 403, message: 'Bad credentials' }), true);

  // A bare 403 is NOT expiry (disp. P2-REREVIEW MED-002). GitHub answers 403 for
  // rate limiting and for permission scope too; re-minting cannot fix either, and
  // treating them as expiry burns the re-mint budget and then reports the wrong
  // failure class. Only credential wording promotes a 403 to expiry.
  assert.equal(isAuthExpiryError({ status: 403, message: 'x' }), false);
  assert.equal(
    isAuthExpiryError({ status: 403, message: 'API rate limit exceeded' }), false,
    'rate limiting is not credential expiry',
  );
  assert.equal(
    isAuthExpiryError({ status: 403, message: 'You have exceeded a secondary rate limit' }), false,
  );
  assert.equal(
    isAuthExpiryError({ status: 403, message: 'Resource not accessible by integration' }), false,
    'a permission-scope failure is not credential expiry',
  );
  // Rate-limit wording wins even when a credential word appears alongside it, so
  // a throttled response can never be mistaken for a token problem.
  assert.equal(
    isAuthExpiryError({ status: 403, message: 'rate limit exceeded; bad credentials' }), false,
  );
  // Unrelated failures are NOT treated as recoverable auth expiry.
  assert.equal(isAuthExpiryError(new Error('connection reset')), false);
  assert.equal(isAuthExpiryError(new Error('merge conflict')), false);
});

test('MED-002: push re-mints a fresh token when the first is revoked mid-operation, then succeeds', async () => {
  // The first minted token is rejected by git as revoked; the second works.
  const minted: string[] = [];
  let n = 0;
  const auth: InstallationAuth = async () => {
    const token = `ghs_tok_${n++}`;
    minted.push(token);
    return { token, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  };
  let gitCalls = 0;
  const runner: GitRunner = async () => {
    gitCalls++;
    if (gitCalls === 1) throw new Error('fatal: could not read Username: Bad credentials (401)');
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, auth);
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);

  const { ref } = await forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush });
  assert.equal(ref, `refs/heads/${attemptBranchStr}`);
  assert.equal(gitCalls, 2, 'the push was retried once after the revoked token');
  assert.equal(minted.length, 2, 'a FRESH token was minted for the retry');
  assert.notEqual(minted[0], minted[1], 'the stale token was never reused');
});

test('MED-002: push fails closed with ForgeAuthExpiredError after the re-mint budget is exhausted', async () => {
  const auth: InstallationAuth = async () => ({ token: 'ghs_dead', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  let gitCalls = 0;
  const runner: GitRunner = async () => { gitCalls++; throw new Error('401 Bad credentials'); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, auth);
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  await assert.rejects(
    () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush }),
    ForgeAuthExpiredError,
  );
  // Initial attempt + MAX_REMINT_ATTEMPTS retries.
  assert.equal(gitCalls, MAX_REMINT_ATTEMPTS + 1, 'exactly the bounded number of attempts were made');
});

test('MED-002: a NON-auth push failure fails fast without re-minting', async () => {
  const minted: string[] = [];
  const auth: InstallationAuth = async () => { const t = `ghs_${minted.length}`; minted.push(t); return { token: t, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; };
  let gitCalls = 0;
  const runner: GitRunner = async () => { gitCalls++; throw new Error('fatal: remote rejected — non-fast-forward'); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, auth);
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  await assert.rejects(
    () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush }),
    ForgePushError,
  );
  assert.equal(gitCalls, 1, 'a non-auth failure is not retried');
  assert.equal(minted.length, 1, 'no re-mint on a non-auth failure');
});

test('MED-002: PR upsert re-mints on a revoked credential and does NOT open a duplicate', async () => {
  const store = { prs: [] as FakePr[], nextNumber: 5, calls: [] as string[] };
  const base = fakeOctokit(store);
  let listCalls = 0;
  // First list() call is rejected as revoked; subsequent calls use the real fake.
  const octokitFor = (token: string): OctokitLike => {
    const real = base(token);
    return {
      pulls: {
        list: async (params) => {
          listCalls++;
          if (listCalls === 1) throw new Error('403 Bad credentials');
          return real.pulls.list(params);
        },
        create: real.pulls.create,
        update: real.pulls.update,
      },
    };
  };
  const minted: string[] = [];
  const auth: InstallationAuth = async () => { const t = `ghs_${minted.length}`; minted.push(t); return { token: t, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, auth);
  const forge = new GitHubAppForgeProvider(creds, octokitFor, ['github.com']);

  const pr = await forge.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T', body: 'B' });
  assert.equal(pr.number, 5, 'the PR was created after the credential recovery');
  assert.equal(store.prs.length, 1, 'exactly one PR exists — no duplicate from the retry');
  assert.ok(minted.length >= 2, 'a fresh token was minted for the retry');
});

// ---------------------------------------------------------------------------
// The credential-recovery rule is one invariant over EVERY
// operation that mints a JIT token: reject an already-expired mint, re-mint on
// expiry/revocation within the bound (bypassing the auth strategy's token
// cache), and surface exhaustion as ForgeAuthExpiredError — never as a push
// failure. resolveRef, the read the crash-recovery path depends on, minted once
// and wrapped expiry as ForgePushError.
// ---------------------------------------------------------------------------

// Real git wording for a rejected HTTPS credential. Git does not say "bad
// credentials"; this is what an expired or revoked installation token produces.
const GIT_AUTH_FAILURE =
  "remote: Invalid username or token. Password authentication is not supported for Git operations.\n" +
  "fatal: Authentication failed for 'https://github.com/acme/web.git/'";

interface MintLog { tokens: string[]; refresh: boolean[] }

// Each mint returns a fresh token and records whether the cache was bypassed.
// `expiredFirst` makes the FIRST mint already expired at use time.
function recordingAuth(log: MintLog, opts: { expiredFirst?: boolean } = {}): InstallationAuth {
  return async (o) => {
    const n = log.tokens.length;
    const token = `ghs_mint_${n}`;
    log.tokens.push(token);
    log.refresh.push((o as { refresh?: boolean }).refresh === true);
    const expired = opts.expiredFirst === true && n === 0;
    return { token, expiresAt: new Date(Date.now() + (expired ? -60_000 : 3600_000)).toISOString() };
  };
}


test('git HTTPS authentication failures are recognised as credential expiry', () => {
  assert.equal(isAuthExpiryError(new Error(GIT_AUTH_FAILURE)), true);
  assert.equal(isAuthExpiryError(new Error("fatal: Authentication failed for 'https://github.com/a/b/'")), true);
  assert.equal(isAuthExpiryError(new Error('remote: Invalid username or password.')), true);
  assert.equal(isAuthExpiryError(new Error('fatal: unable to access: The requested URL returned error: 401')), true);
  // A 403 from git is a permission/ruleset refusal, not an expired token.
  assert.equal(isAuthExpiryError(new Error('fatal: unable to access: The requested URL returned error: 403')), false);
});

test('resolveRef re-mints after a revoked credential and returns the remote SHA', async () => {
  const log: MintLog = { tokens: [], refresh: [] };
  let calls = 0;
  const runner: GitRunner = async () => {
    calls++;
    if (calls === 1) throw new Error(GIT_AUTH_FAILURE);
    return { stdout: `${SHA}\trefs/heads/${attemptBranchStr}\n`, stderr: '', exitCode: 0 };
  };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, recordingAuth(log));
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  assert.equal(await forge.resolveRef({ repository, branch: attemptBranchStr }), SHA);
  assert.equal(calls, 2, 'the probe was retried once after the revoked token');
  assert.equal(log.tokens.length, 2, 'a fresh token was minted for the retry');
});

test('resolveRef skips an already-expired mint instead of failing on it', async () => {
  const log: MintLog = { tokens: [], refresh: [] };
  const used: string[] = [];
  const runner: GitRunner = async (args) => {
    used.push(args.join(' '));
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const creds = new GitHubAppCredentialProvider(
    { appId: 1, privateKey: 'PEM', installationId: 9 }, recordingAuth(log, { expiredFirst: true }),
  );
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  assert.equal(await forge.resolveRef({ repository, branch: attemptBranchStr }), null);
  assert.equal(log.tokens.length, 2);
  assert.equal(used.length, 1, 'the expired token never reached git');
  assert.ok(!used[0]!.includes(log.tokens[0]!), 'the expired token was not used');
});

test('resolveRef fails closed with ForgeAuthExpiredError, not ForgePushError, when the budget runs out', async () => {
  let calls = 0;
  const runner: GitRunner = async () => { calls++; throw new Error(GIT_AUTH_FAILURE); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  await assert.rejects(
    () => forge.resolveRef({ repository, branch: attemptBranchStr }),
    (err: unknown) => {
      assert.ok(err instanceof ForgeAuthExpiredError, `expected ForgeAuthExpiredError, got ${String(err)}`);
      assert.ok(!(err instanceof ForgePushError));
      return true;
    },
  );
  assert.equal(calls, MAX_REMINT_ATTEMPTS + 1);
});

test('a non-auth resolveRef failure is not retried and never leaks the token', async () => {
  const token = 'ghs_probeLeak42';
  let calls = 0;
  const runner: GitRunner = async () => {
    calls++;
    throw new Error(`fatal: unable to access 'https://x-access-token:${token}@github.com/acme/web.git/': Could not resolve host`);
  };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth(token));
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  await assert.rejects(
    () => forge.resolveRef({ repository, branch: attemptBranchStr }),
    (err: unknown) => {
      // A failed read-only probe is a reconciliation failure: nothing was being
      // pushed, so it must not masquerade as a push error either.
      assert.ok(err instanceof ForgeReconcileError, `expected ForgeReconcileError, got ${String(err)}`);
      assert.ok(!(err instanceof ForgePushError));
      assert.ok(!err.message.includes(token), 'token must be scrubbed');
      return true;
    },
  );
  assert.equal(calls, 1);
});

// The same invariant, table-driven over all four token-using operations, so a
// fifth operation added later without the shared recovery path has a template
// to fail against.
test('every forge operation re-mints once on expiry and bypasses the token cache', async () => {
  const pr = { number: 3, html_url: 'https://github.com/acme/web/pull/3', head: { ref: attemptBranchStr, sha: SHA }, base: { ref: 'main' }, state: 'open' };
  const flakyOctokit = (failures: { left: number }) => (): OctokitLike => {
    const once = async <T>(v: T): Promise<T> => {
      if (failures.left-- > 0) throw { status: 401, message: 'Bad credentials' };
      return v;
    };
    return {
      pulls: {
        list: () => once({ data: [pr] }),
        create: () => once({ data: pr }),
        update: () => once({ data: pr }),
      },
    };
  };
  const ops: ReadonlyArray<{
    name: string;
    run: (f: GitHubAppForgeProvider) => Promise<unknown>;
    git: boolean;
  }> = [
    { name: 'pushBranch', git: true, run: (f) => f.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr, ...firstPush }) },
    { name: 'resolveRef', git: true, run: (f) => f.resolveRef({ repository, branch: attemptBranchStr }) },
    { name: 'upsertPullRequest', git: false, run: (f) => f.upsertPullRequest({ repository, headBranch: attemptBranchStr, base: 'main', title: 'T', body: 'B' }) },
    { name: 'findPullRequest', git: false, run: (f) => f.findPullRequest({ repository, headBranch: attemptBranchStr }) },
  ];
  for (const op of ops) {
    const log: MintLog = { tokens: [], refresh: [] };
    let gitCalls = 0;
    const runner: GitRunner = async () => {
      gitCalls++;
      if (gitCalls === 1) throw new Error(GIT_AUTH_FAILURE);
      return { stdout: `${SHA}\trefs/heads/${attemptBranchStr}\n`, stderr: '', exitCode: 0 };
    };
    const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, recordingAuth(log));
    const forge = new GitHubAppForgeProvider(
      creds, op.git ? throwingOctokit : flakyOctokit({ left: 1 }), ['github.com'], runner,
    );
    await op.run(forge);
    assert.equal(log.tokens.length, 2, `${op.name}: expected exactly one re-mint`);
    // The octokit auth strategy caches installation tokens; a re-mint that does
    // not ask for a refresh hands back the same revoked token.
    assert.deepEqual(log.refresh, [false, true], `${op.name}: the re-mint must bypass the token cache`);
  }
});
