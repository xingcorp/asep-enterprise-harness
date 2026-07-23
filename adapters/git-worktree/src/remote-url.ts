// Clone/fetch URL construction from validated forge identity (architecture §15,
// exit criteria E9/H7, disp. P2-PLAN-HIGH-007). The system NEVER accepts a raw
// remote_url. A repository binding carries only (host, owner, repo); the URL is
// CONSTRUCTED here and every component is validated so no hostile transport can
// be smuggled in:
//   - file://, ext::, ssh://, git://, local paths, userinfo, non-HTTPS → rejected
//   - newline / option-injection / control chars in any component → rejected
//   - host must be an allowlisted GitHub HTTPS host (github.com or a configured
//     GitHub Enterprise host); anything else → rejected
//
// The result is always `https://<host>/<owner>/<repo>.git` with each segment
// drawn from a validated character class, so it cannot express any other
// transport or inject a git option.

export class RemoteIdentityError extends Error {
  constructor(reason: string) {
    super(`invalid forge identity: ${reason}`);
    this.name = 'RemoteIdentityError';
  }
}

// GitHub owner/repo grammar: ASCII letters, digits, '-', '_', '.'; no leading
// '-' (would look like an option), no '..', bounded length. Deliberately
// stricter than GitHub itself — we only need to accept legitimate identities.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Host: DNS labels separated by dots, optional :port. No userinfo, no path.
const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)+[A-Za-z]{2,63}(:\d{1,5})?$/;

export interface ForgeIdentity {
  readonly githubHost: string;   // e.g. 'github.com' or a configured GHES host
  readonly githubOwner: string;
  readonly githubRepo: string;
}

// Detect option/control/injection hazards common to all components.
function assertClean(label: string, value: string): void {
  if (value.length === 0) throw new RemoteIdentityError(`${label} is empty`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new RemoteIdentityError(`${label} contains a control character`);
  if (/\s/.test(value)) throw new RemoteIdentityError(`${label} contains whitespace`);
  if (value.startsWith('-')) throw new RemoteIdentityError(`${label} starts with '-' (option-injection)`);
  if (value.includes('..')) throw new RemoteIdentityError(`${label} contains '..'`);
  if (value.includes('@')) throw new RemoteIdentityError(`${label} contains userinfo '@'`);
  if (value.includes('/') && label !== 'host') throw new RemoteIdentityError(`${label} contains '/'`);
}

/**
 * Build the ONLY allowed transport URL for a forge identity, against an
 * allowlist of GitHub HTTPS hosts. Throws RemoteIdentityError on anything that
 * is not exactly `https://<allowed-host>/<owner>/<repo>.git`.
 */
export function buildCloneUrl(
  identity: ForgeIdentity,
  allowedHosts: readonly string[] = ['github.com'],
): string {
  assertClean('host', identity.githubHost);
  assertClean('owner', identity.githubOwner);
  assertClean('repo', identity.githubRepo);

  if (!HOST.test(identity.githubHost)) {
    throw new RemoteIdentityError(`host '${identity.githubHost}' is not a valid DNS host`);
  }
  if (!allowedHosts.includes(identity.githubHost)) {
    throw new RemoteIdentityError(`host '${identity.githubHost}' is not in the configured allowlist`);
  }
  if (!SEGMENT.test(identity.githubOwner)) {
    throw new RemoteIdentityError(`owner '${identity.githubOwner}' is not a valid GitHub owner`);
  }
  // A trailing '.git' on the repo is stripped so we don't double it.
  const repo = identity.githubRepo.replace(/\.git$/, '');
  if (!SEGMENT.test(repo)) {
    throw new RemoteIdentityError(`repo '${identity.githubRepo}' is not a valid GitHub repo`);
  }
  return `https://${identity.githubHost}/${identity.githubOwner}/${repo}.git`;
}

// Reject a raw string that some caller might try to pass as a remote URL. This
// exists so a future code path that *thinks* it has a URL is forced through
// identity construction instead. Any use of this returns the failure reason.
export function rejectRawRemoteUrl(_raw: string): never {
  throw new RemoteIdentityError(
    'a raw remote URL is never accepted; construct from (host, owner, repo) via buildCloneUrl',
  );
}
