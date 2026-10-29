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
//   3. the seam configuration it builds carries the agent's pins, both images
//      and a model credential provider — and NO container flags or mounts of its
//      own: the adapter owns the containment, and the agent's one writable mount
//      is the worktree the driver leases (E8/F4/F5, G3);
//   4. the agent's tool policy is the one the Claude provider runs under
//      ('restricted-egress': the model API through its egress proxy, no shell,
//      no network tool), and a live credential only ever goes to an https origin;
//   5. the verification command is CONFIG, never a model-generated string (F1):
//      an executable plus argv, shell-free.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FileModelCredentialProvider, claudeToolGrant } from '@asep/agent-claude';
import { readEnv, pilotSeamConfig, PILOT_TOOL_POLICY, checkCommandFor } from './pilot-main.js';
import { ProductionConfigError } from './production-root.js';

console.log('SUITE-ID: asep-suite:pilot-main');

// Every variable readEnv() requires, with values shaped like the real thing.
//
// The second block is the LIVE TARGET (HIGH-008/K2). Before it existed the
// driver seeded a synthetic mirror and registered the literal `acme/web`, so a
// pilot holding real credentials would have pushed a seed commit to a repository
// that does not exist — and `SqlForgeBindingResolver` would have refused the
// binding first, because `github_repository_id` was never persisted. Each value
// below is therefore REQUIRED, and the fail-closed loop covers all of them
// automatically: it iterates the keys of this object.
const COMPLETE_ENV: Record<string, string> = {
  ASEP_PG_URL: 'postgres://u:p@127.0.0.1:5432/asep',
  ASEP_CLAUDE_EXECUTABLE: '/usr/local/bin/claude',
  ASEP_CLAUDE_MODEL: 'claude-sonnet-4-20250514',
  ASEP_CLAUDE_CLI_VERSION: '2.1.185',
  ASEP_CLAUDE_MAX_TURNS: '8',
  ASEP_AGENT_IMAGE_DIGEST: 'alpine@sha256:' + 'a'.repeat(64),
  ASEP_VERIFY_IMAGE_DIGEST: 'alpine@sha256:' + 'b'.repeat(64),
  ASEP_EGRESS_PROXY_IMAGE_DIGEST: 'node@sha256:' + 'e'.repeat(64),
  ASEP_ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic-api-key',
  ASEP_GITHUB_APP_ID: '12345',
  ASEP_GITHUB_PRIVATE_KEY_PATH: '/run/secrets/github-app.pem',
  ASEP_GITHUB_INSTALLATION_ID: '67890',
  ASEP_OBJECT_STORE_DIR: '/var/lib/asep/objects',

  // --- the real repository this attempt targets -----------------------------
  ASEP_ORGANIZATION_NAME: 'Acme Inc',
  ASEP_PROJECT_NAME: 'web-platform',
  ASEP_GITHUB_HOST: 'github.com',
  ASEP_GITHUB_OWNER: 'acme-inc',
  ASEP_GITHUB_REPO: 'web-platform',
  ASEP_GITHUB_REPOSITORY_ID: '987654321',
  ASEP_BASE_BRANCH: 'main',
  ASEP_MIRROR_PATH: '/var/lib/asep/mirrors/acme-inc-web-platform.git',
  ASEP_BASE_SHA: 'c'.repeat(40),

  // --- the task to perform --------------------------------------------------
  ASEP_OBJECTIVE: 'add a health endpoint',
  ASEP_EXPECT_CHANGED_FILE: 'src/health.ts',
  ASEP_ALLOWED_PATHS: 'src/health.ts,src/routes.ts',

  ASEP_LOCKFILE_HASH: 'd'.repeat(64),
};

// Run `fn` with exactly `vars` present, restoring the ambient env afterwards so
// suites never leak configuration into one another.
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of [...Object.keys(COMPLETE_ENV), 'ASEP_ANTHROPIC_BASE_URL']) {
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
  assert.match(env.egressProxyImageDigest, /@sha256:[0-9a-f]{64}$/);
  assert.equal(env.anthropicApiKeyFile, '/run/secrets/anthropic-api-key');
  assert.equal(env.anthropicBaseUrl, 'https://api.anthropic.com', 'the public API unless configured');
  assert.equal(env.objectStoreDir, '/var/lib/asep/objects', 'evidence goes to the durable store the verifier reads');

  // The live target: a real owner/repo, the NUMERIC id the forge resolver needs,
  // and a real mirror + base SHA. None of this was configurable before, which is
  // exactly why "supply credentials and it runs live" was not yet true.
  assert.equal(env.githubOwner, 'acme-inc');
  assert.equal(env.githubRepo, 'web-platform');
  assert.equal(env.githubRepositoryId, 987654321,
    'the numeric repository id must be a number — the resolver fails closed without it');
  assert.equal(env.mirrorPath, '/var/lib/asep/mirrors/acme-inc-web-platform.git');
  assert.equal(env.baseSha, 'c'.repeat(40));

  // The work order. expectChangedFile is load-bearing: the workflow fails closed
  // when trusted inspection does not observe it.
  assert.equal(env.objective, 'add a health endpoint');
  assert.equal(env.expectChangedFile, 'src/health.ts');
  assert.deepEqual(env.allowedPaths, ['src/health.ts', 'src/routes.ts'],
    'a comma-separated list must parse into discrete paths');
});

test('HIGH-008: a base SHA that is not a full 40-hex commit fails closed', () => {
  // An abbreviated SHA is the realistic mistake (people paste `git log --oneline`
  // output). The mirror would resolve it, but the evidence bundle and the
  // remote-reconciliation comparison both key on full SHAs, so accepting a short
  // one would silently produce evidence that cannot be matched against the remote.
  for (const bad of ['c'.repeat(7), 'c'.repeat(39), 'C'.repeat(40), 'z'.repeat(40)]) {
    assert.throws(
      () => withEnv({ ...COMPLETE_ENV, ASEP_BASE_SHA: bad }, () => readEnv()),
      ProductionConfigError,
      `base SHA '${bad}' must be rejected`,
    );
  }
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

test('G3: a configured model API origin is used, and only over https', () => {
  const env = withEnv({ ...COMPLETE_ENV, ASEP_ANTHROPIC_BASE_URL: 'https://llm-gateway.example.com/anthropic/' },
    () => readEnv());
  assert.equal(env.anthropicBaseUrl, 'https://llm-gateway.example.com/anthropic');
  // Assembled, so the userinfo form is not mistaken for an address by the PII scan.
  const withUserinfo = ['https://u:p', 'llm-gateway.example.com'].join('@');
  for (const bad of ['http://llm-gateway.example.com', withUserinfo, 'not a url']) {
    assert.throws(
      () => withEnv({ ...COMPLETE_ENV, ASEP_ANTHROPIC_BASE_URL: bad }, () => readEnv()),
      ProductionConfigError,
      `model API origin '${bad}' must be refused`,
    );
  }
});

test('E8/G3: the pilot seam config carries pins, images and a credential provider — no flags or mounts', () => {
  const env = withEnv(COMPLETE_ENV, () => readEnv());
  const cfg = pilotSeamConfig(env, 'pem', () => '/tmp/asep-pilot-x/wt/binding-1/ws-1');
  assert.equal(cfg.claude.image, COMPLETE_ENV['ASEP_AGENT_IMAGE_DIGEST']);
  assert.equal(cfg.claude.proxyImage, COMPLETE_ENV['ASEP_EGRESS_PROXY_IMAGE_DIGEST']);
  assert.equal(cfg.claude.model, 'claude-sonnet-4-20250514');
  assert.ok(cfg.claude.credentials instanceof FileModelCredentialProvider,
    'the model credential comes from the key file, per attempt');
  // The containment is the adapter's: a root that could hand in docker flags or
  // a mount list could hand in the state root (objects/, mirror.git) as well.
  const keys = Object.keys(cfg.claude).sort();
  assert.deepEqual(keys, ['cliVersion', 'credentials', 'executable', 'image', 'maxTurns', 'model', 'proxyImage']);
  assert.ok(!JSON.stringify(cfg.claude).includes('/tmp/asep-pilot-x'),
    'no path of the pilot state directory is part of the agent configuration');
});

test('G3: the pilot agent policy is one the Claude provider runs under: read + write, no shell, no network', () => {
  assert.equal(PILOT_TOOL_POLICY.networkProfile, 'restricted-egress');
  const grant = claudeToolGrant(PILOT_TOOL_POLICY);
  assert.deepEqual(grant.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
  for (const t of ['Bash', 'WebFetch', 'WebSearch']) assert.ok(grant.disallowed.includes(t), t);
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
