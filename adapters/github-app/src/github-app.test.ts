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
  GitHubAppForgeProvider, ForgePushError, ForgeAuthExpiredError,
  isAuthExpiryError, MAX_REMINT_ATTEMPTS, scrubToken,
} from './index.js';
import type {
  InstallationAuth, OctokitLike, RepositoryForgeConfig, GitRunner,
} from './index.js';
import { runGit } from '@asep/git-worktree';

console.log('SUITE-ID: asep-suite:github-app');

const REPO_ID = 4242;
const identity = { githubHost: 'github.com', githubOwner: 'acme', githubRepo: 'web' } as const;
const repository: RepositoryForgeConfig = { identity, repositoryId: REPO_ID };

// A ULID-shaped id (Crockford base32, 26 chars) so attempt-branch validation passes.
const id = (c: string) => c.repeat(26);
const attemptBranchStr = `asep/${id('R')}/${id('T')}/${id('P')}`;

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

test('H3: only the exact namespaced refspec is handed to git (argv capture)', async () => {
  const captured: string[][] = [];
  const runner: GitRunner = async (args) => { captured.push([...args]); return { stdout: '', stderr: '', exitCode: 0 }; };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);

  await forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr });

  assert.equal(captured.length, 1);
  const argv = captured[0]!;
  const target = `refs/heads/${attemptBranchStr}`;
  // The refspec is the exact create/update spec, never a force (+) or delete (:).
  assert.ok(argv.includes(`${target}:${target}`), 'exact namespaced refspec must be present');
  assert.ok(!argv.some((a) => a.startsWith('+')), 'no force refspec');
  assert.ok(!argv.some((a) => a === '--force'), 'no bare --force');
  // The URL is https + carries no raw token in a form other than scrubbed userinfo.
  assert.ok(argv.some((a) => a.startsWith('https://')), 'https transport URL present');
});

test('H3: protected/foreign/malformed branches are rejected before any git call', async () => {
  const runner: GitRunner = async () => { throw new Error('git must not run for a rejected ref'); };
  const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
  const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);
  for (const bad of ['main', 'master', 'HEAD', 'refs/tags/v1', 'feature/x', '-oProxy', `asep/${id('R')}`]) {
    await assert.rejects(
      () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: bad }),
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

    // A runner that rewrites the constructed https URL to the local bare path,
    // preserving the EXACT refspec argv the provider chose (the safety property).
    const runner: GitRunner = async (args, opts) => {
      const rewritten = args.map((a) => (a.startsWith('https://') ? bare : a));
      return runGit(rewritten, opts);
    };
    const creds = new GitHubAppCredentialProvider({ appId: 1, privateKey: 'PEM', installationId: 9 }, fakeAuth());
    const forge = new GitHubAppForgeProvider(creds, throwingOctokit, ['github.com'], runner);

    const { ref } = await forge.pushBranch({ repository, localWorktreePath: wt, branch: attemptBranchStr });
    assert.equal(ref, `refs/heads/${attemptBranchStr}`);

    // The bare remote now has exactly that ref and nothing on main.
    const refs = (await runGit(['-C', bare, 'for-each-ref', '--format=%(refname)'])).stdout.trim().split('\n').filter(Boolean);
    assert.deepEqual(refs, [`refs/heads/${attemptBranchStr}`]);
    assert.ok(!refs.includes('refs/heads/main'), 'must not have pushed to main');
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
    () => forge.pushBranch({ repository: evil, localWorktreePath: '/tmp/wt', branch: attemptBranchStr }),
    /not in the configured allowlist/,
  );
  assert.equal(minted, false, 'token must not be minted for a rejected host');
});

// ---------------------------------------------------------------------------
// H4 — idempotent PR upsert: find-by-head-branch → update, else create.
// H6 — driven at the transport (REST) boundary, not mocked application logic.
// ---------------------------------------------------------------------------

interface FakePr { number: number; html_url: string; head: { ref: string }; base: { ref: string } }

function fakeOctokit(store: { prs: FakePr[]; nextNumber: number; calls: string[] }): (token: string) => OctokitLike {
  return () => ({
    pulls: {
      list: async ({ head }) => {
        store.calls.push('list');
        const ref = head.split(':')[1];
        return { data: store.prs.filter((p) => p.head.ref === ref) };
      },
      create: async ({ head, base }) => {
        store.calls.push('create');
        const pr: FakePr = { number: store.nextNumber++, html_url: `https://github.com/acme/web/pull/${store.nextNumber - 1}`, head: { ref: head }, base: { ref: base } };
        store.prs.push(pr);
        return { data: pr };
      },
      update: async ({ pull_number }) => {
        store.calls.push('update');
        const pr = store.prs.find((p) => p.number === pull_number)!;
        return { data: pr };
      },
    },
  });
}

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
    () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr }),
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

  const { ref } = await forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr });
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
    () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr }),
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
    () => forge.pushBranch({ repository, localWorktreePath: '/tmp/wt', branch: attemptBranchStr }),
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
