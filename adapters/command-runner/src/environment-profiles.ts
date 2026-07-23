// Environment profiles for verification commands (exit criterion F1/G3). A
// verification command runs with a SANITIZED, allowlisted environment — never
// the harness's full process environment — so an inherited secret, proxy var,
// or transport-redirection var cannot leak into a verification tool. Profiles
// are named and looked up by the CommandSpec.environmentProfile string; an
// unknown profile fails closed rather than silently inheriting everything.

export class UnknownEnvironmentProfileError extends Error {
  constructor(profile: string) {
    super(`unknown environment profile '${profile}' — refusing to run with an unvetted environment`);
    this.name = 'UnknownEnvironmentProfileError';
  }
}

// Build a minimal base environment from a PATH the host actually has.
function baseEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

// A profile is a pure function producing the exact env a command sees. No
// profile inherits the ambient environment wholesale.
export const ENVIRONMENT_PROFILES: Record<string, () => Record<string, string>> = {
  // Deterministic verification: minimal env, no network hints, CI flag set so
  // tools pick non-interactive defaults.
  'verification-no-network': () => ({
    ...baseEnv(),
    CI: '1',
    // Explicitly blank common proxy vars so nothing inherited can redirect I/O.
    HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*',
    npm_config_offline: 'true',
  }),
  // Agent-restricted egress (pilot only — see sandbox). Same minimal base; the
  // network restriction is enforced by the sandbox layer, not env alone.
  'agent-restricted-egress': () => ({
    ...baseEnv(),
    CI: '1',
  }),
};

export function resolveEnvironment(profile: string): Record<string, string> {
  const build = ENVIRONMENT_PROFILES[profile];
  if (!build) throw new UnknownEnvironmentProfileError(profile);
  return build();
}
