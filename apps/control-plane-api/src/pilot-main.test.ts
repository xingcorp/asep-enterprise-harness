// Pilot entrypoint proof (disp. P2-FINAL-HIGH-008, exit criteria B2/B5/E8).
//
// THE FINDING. Codex cycle 4: "`productionSeams` dựng đúng adapter thật, nhưng
// không entrypoint nào gọi nó: CLI vẫn mock". Building the real adapters was
// necessary but not sufficient — with no caller, "supply credentials and it runs
// live" stayed unfalsifiable.
//
// This suite pins the entrypoint's CONTRACT without any network, live credential
// or Docker daemon:
//
//   1. the module is importable WITHOUT running an attempt (the entry is guarded),
//      which is what makes it testable at all;
//   2. readEnv() FAILS CLOSED on every missing knob — an unconfigured deployment
//      cannot fall through to a local double;
//   3. the agent container flags are hardened: --network none, read-only root,
//      dropped caps, no-new-privileges, and NO docker socket mount (E8/F4/F5);
//   4. the verification command is CONFIG, never a model-generated string (F1):
//      an executable plus argv, shell-free.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, agentRunFlags, checkCommandFor } from './pilot-main.js';
import { ProductionConfigError } from './production-root.js';

console.log('SUITE-ID: asep-suite:pilot-main');

// Every variable readEnv() requires, with values shaped like the real thing.
const COMPLETE_ENV: Record<string, string> = {
  ASEP_PG_URL: 'postgres://u:p@127.0.0.1:5432/asep',
  ASEP_CLAUDE_EXECUTABLE: '/usr/local/bin/claude',
  ASEP_CLAUDE_MODEL: 'claude-sonnet-4-20250514',
  ASEP_CLAUDE_CLI_VERSION: '2.1.185',
  ASEP_CLAUDE_MAX_TURNS: '8',
  ASEP_AGENT_IMAGE_DIGEST: 'alpine@sha256:' + 'a'.repeat(64),
  ASEP_VERIFY_IMAGE_DIGEST: 'alpine@sha256:' + 'b'.repeat(64),
  ASEP_GITHUB_APP_ID: '12345',
  ASEP_GITHUB_PRIVATE_KEY_PATH: '/run/secrets/github-app.pem',
  ASEP_GITHUB_INSTALLATION_ID: '67890',
};

// Run `fn` with exactly `vars` present, restoring the ambient env afterwards so
// suites never leak configuration into one another.
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(COMPLETE_ENV)) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('HIGH-008: a fully-configured environment yields the pilot configuration', () => {
  const env = withEnv(COMPLETE_ENV, () => readEnv());
  assert.equal(env.claudeModel, 'claude-sonnet-4-20250514');
  assert.equal(env.claudeCliVersion, '2.1.185');
  assert.equal(env.claudeMaxTurns, 8);
  assert.equal(env.githubAppId, 12345);
  assert.equal(env.githubInstallationId, 67890);
  assert.match(env.agentImageDigest, /@sha256:[0-9a-f]{64}$/);
  assert.match(env.verifyImageDigest, /@sha256:[0-9a-f]{64}$/);
});

test('HIGH-008: EVERY missing variable fails closed (no silent downgrade to a double)', () => {
  for (const missing of Object.keys(COMPLETE_ENV)) {
    const partial = { ...COMPLETE_ENV };
    delete partial[missing];
    assert.throws(
      () => withEnv(partial, () => readEnv()),
      ProductionConfigError,
      `omitting ${missing} must fail closed`,
    );
  }
});

test('HIGH-008: a blank variable is treated as absent, not as an empty value', () => {
  assert.throws(
    () => withEnv({ ...COMPLETE_ENV, ASEP_CLAUDE_MODEL: '   ' }, () => readEnv()),
    ProductionConfigError,
  );
});

test('HIGH-008: a non-integer numeric variable fails closed', () => {
  assert.throws(
    () => withEnv({ ...COMPLETE_ENV, ASEP_GITHUB_APP_ID: 'not-a-number' }, () => readEnv()),
    ProductionConfigError,
  );
  assert.throws(
    () => withEnv({ ...COMPLETE_ENV, ASEP_CLAUDE_MAX_TURNS: '3.5' }, () => readEnv()),
    ProductionConfigError,
  );
});

test('E8/F4/F5: the agent container flags are hardened and expose no docker socket', () => {
  const flags = agentRunFlags('/tmp/asep-pilot-x').join(' ');
  assert.match(flags, /--network none/, 'agent container must have NO network');
  assert.match(flags, /--read-only/, 'container root fs must be read-only');
  assert.match(flags, /--cap-drop ALL/, 'all capabilities must be dropped');
  assert.match(flags, /--security-opt no-new-privileges/);
  assert.match(flags, /--pids-limit/, 'a PID limit must bound fork bombs');
  assert.match(flags, /--memory/, 'a memory limit must be set');
  // The single most dangerous mount: handing the daemon socket to the agent
  // would make every other restriction cosmetic.
  assert.doesNotMatch(flags, /docker\.sock/, 'the docker socket must NEVER be mounted');
  assert.doesNotMatch(flags, /--privileged/, 'the container must never be privileged');
});

test('F1: the verification command is executable + argv, never a shell string', () => {
  const spec = checkCommandFor('/tmp/wt');
  assert.equal(spec.executable, 'git');
  assert.ok(Array.isArray(spec.args), 'args must be an argv array');
  // A shell metacharacter anywhere in the command would mean the runner could be
  // driven through a shell; the runner is shell:false and the spec must match.
  const joined = [spec.executable, ...spec.args].join(' ');
  assert.doesNotMatch(joined, /[;&|`$><]/, 'no shell metacharacters in the command');
  assert.ok(spec.timeoutMs > 0, 'a timeout must bound the command');
  assert.ok(spec.outputPolicy.maxEvidenceBytes > 0, 'raw output must be retained as evidence');
});
