// GitHub App credential provider (exit criteria H1/H2, disp. P2-PLAN-MED-005,
// P2-PLAN-MED-008). INTERNAL to the github-app adapter — application code never
// sees it, depending only on ForgeProvider.
//
// Guarantees enforced here:
//   H1  the App private key is held here (constructor config), NEVER written to
//       a workspace, log, or artifact. It is used only to sign the app JWT that
//       exchanges for an installation token.
//   H2  the installation token is minted JIT per bounded operation, scoped to
//       the EXACT repository + minimum permissions (Metadata:read,
//       Contents:read/write, Pull requests:read/write), treated as OPAQUE (no
//       length assumption), and NEVER persisted. An expiry is returned alongside
//       so callers can detect an expired token and re-mint without replay.
//
// createAppAuth signs a short-lived app JWT with the private key and exchanges
// it for an installation access token. We request `repositoryIds` +
// `permissions` so the minted token cannot act outside the one pilot repo.

import { createAppAuth } from '@octokit/auth-app';

export interface GitHubAppConfig {
  readonly appId: number;
  // PEM private key. Held in memory only; never serialized into any artifact.
  readonly privateKey: string;
  readonly installationId: number;
}

// Least-privilege permission set minted onto every token (H2). No `administration`,
// no `workflows`, and crucially nothing that can merge or alter branch protection.
export const MINIMUM_PERMISSIONS = Object.freeze({
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
} as const);

// An opaque token paired with its provider-reported expiry. Callers treat
// `token` as an opaque string (GitHub token format is not fixed-length).
export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string; // ISO 8601 from GitHub
}

// Minimal shape of the auth strategy we depend on, so the adapter can be driven
// against a fake in tests without a live GitHub (H6/H2 fake-clock coverage).
export interface InstallationAuth {
  (opts: {
    type: 'installation';
    installationId: number;
    repositoryIds?: readonly number[];
    permissions?: Record<string, string>;
    // Bypass the strategy's installation-token cache. @octokit/auth-app caches
    // tokens per (installation, repositories, permissions), so without this a
    // re-mint after a revocation hands back the same dead token.
    refresh?: boolean;
  }): Promise<{ token: string; expiresAt: string }>;
}

export class GitHubAppCredentialProvider {
  private readonly auth: InstallationAuth;

  // The real strategy is built from the App id + private key. A test may inject
  // a fake `authOverride` to exercise minting/expiry/rotation deterministically.
  constructor(
    private readonly cfg: GitHubAppConfig,
    authOverride?: InstallationAuth,
  ) {
    this.auth = authOverride ?? (createAppAuth({
      appId: cfg.appId,
      privateKey: cfg.privateKey,
      installationId: cfg.installationId,
    }) as unknown as InstallationAuth);
  }

  // Mint a fresh installation token scoped to EXACTLY `repositoryId` with the
  // minimum permission set. Called JIT for each bounded forge op; the result is
  // never cached or persisted by this provider. `refresh` forces a new token
  // past the auth strategy's own cache — required for every re-mint, because a
  // cached token is exactly the one that just expired or was revoked.
  async mintForRepository(
    repositoryId: number,
    opts: { readonly refresh?: boolean } = {},
  ): Promise<InstallationToken> {
    const res = await this.auth({
      type: 'installation',
      installationId: this.cfg.installationId,
      repositoryIds: [repositoryId],
      permissions: { ...MINIMUM_PERMISSIONS },
      ...(opts.refresh === true ? { refresh: true } : {}),
    });
    if (typeof res.token !== 'string' || res.token.length === 0) {
      throw new Error('github-app: installation auth returned no token');
    }
    return { token: res.token, expiresAt: res.expiresAt };
  }
}

// True when `expiresAt` is at or before `now` (with an optional safety skew in
// ms) — the signal to re-mint rather than reuse. Kept pure for fake-clock tests.
export function isExpired(expiresAt: string, now: number, skewMs = 0): boolean {
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return true; // unparseable expiry => treat as expired
  return exp - skewMs <= now;
}
