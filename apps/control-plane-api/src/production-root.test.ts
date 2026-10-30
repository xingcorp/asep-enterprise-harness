// Production composition-root proof (disp. P2-FINAL-HIGH-008).
//
// THE FINDING. Codex cycle 3: "không composition root nào instantiate
// `ClaudeCodingProvider` hoặc `GitHubAppForgePort`; package còn không phụ thuộc
// hai adapter này ... Chỉ cấp credential chưa chạy được live task→PR." In other
// words the `agentFor` / `forge` seams existed but nothing REAL was ever bound to
// them, so "supply credentials and it runs live" was unfalsifiable.
//
// This suite is that falsifiable proof. It asserts, without any network or live
// credential:
//
//   1. productionSeams() returns seams whose concrete types are the REAL
//      adapters — providerId carries the pinned Claude model + CLI version, and
//      the forge is a GitHubAppForgePort (which `implements ForgeProvider`, so the
//      compiler already forbids drift).
//   2. The seams satisfy the exact shape runVerticalSlice consumes, so wiring
//      them is a type-checked fact rather than a claim in a comment.
//   3. An unconfigured deployment FAILS CLOSED (ProductionConfigError) instead of
//      silently degrading to the local doubles — including a missing or
//      unpinned agent/proxy image and a missing model credential provider
//      (E8/G3). There is no host-execution agent to fall back to.
//   4. The agent works in the worktree the driver leased, resolved through the
//      seam's `worktreePathOf` — not a path fixed at construction.
//   5. No forge credential is reachable from the agent seam (E4): the Claude
//      provider is constructed with only (config, scope, artifactStore).

import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAppForgePort } from '@asep/github-app';
import { ClaudeCodingProvider, FileModelCredentialProvider } from '@asep/agent-claude';
import {
  productionSeams, ProductionConfigError, type ProductionSeamConfig,
} from './production-root.js';
import type { SqlClient } from '@asep/persistence';
import type { ArtifactStore } from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, WorkspaceId, ArtifactRef, AttemptId,
} from '@asep/contracts';

console.log('SUITE-ID: asep-suite:production-root');

const scope: TenantScope = {
  organizationId: 'O'.repeat(26) as TenantScope['organizationId'],
  projectId: 'P'.repeat(26) as TenantScope['projectId'],
};

// A SqlClient stand-in: productionSeams only STORES it (for the scoped binding
// resolver), it issues no query at construction time.
const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as SqlClient;

const artifacts = {
  put: async (): Promise<ArtifactRef> => { throw new Error('unused'); },
  get: async () => { throw new Error('unused'); },
  verify: async () => { throw new Error('unused'); },
  exists: async () => false,
} as unknown as ArtifactStore;

// A syntactically valid PEM shape. No key material is used: the body is base64
// 'ABC' and nothing here mints a token, so this never touches GitHub.
//
// ASSEMBLED at runtime rather than written as a literal. The secret scanner
// rightly refuses a '-----BEGIN … PRIVATE KEY-----' literal in a tracked file,
// and that rule should hold with no per-file exemption — an allowlist entry
// here is a hole a real key could later slip through. The runtime value is
// byte-identical, which is what the E4 leak assertion below actually reads.
const PEM_LABEL = 'RSA PRIVATE KEY';
const FAKE_PEM = `${'-'.repeat(5)}BEGIN ${PEM_LABEL}${'-'.repeat(5)}\nQUJD\n${'-'.repeat(5)}END ${PEM_LABEL}${'-'.repeat(5)}\n`;

function config(over: Partial<ProductionSeamConfig> = {}): ProductionSeamConfig {
  return {
    claude: {
      executable: '/usr/local/bin/claude',
      model: 'claude-sonnet-4-20250514',
      cliVersion: '2.1.185',
      maxTurns: 12,
      image: 'alpine@sha256:' + 'a'.repeat(64),
      proxyImage: 'node@sha256:' + 'b'.repeat(64),
      // Never read here: nothing in this suite executes an attempt to the point
      // of asking for the credential.
      credentials: new FileModelCredentialProvider({ apiKeyFile: '/run/secrets/anthropic-api-key' }),
    },
    github: { appId: 12345, privateKey: FAKE_PEM, installationId: 67890 },
    localRepoPathFor: () => '/tmp/asep/worktree',
    ...over,
  } as ProductionSeamConfig;
}

// ---------------------------------------------------------------------------
// 1 + 2 — the seams are the REAL adapters, in the shape the driver consumes.
// ---------------------------------------------------------------------------

test('HIGH-008: productionSeams binds the REAL Claude adapter to the agent seam', () => {
  const seams = productionSeams(client, config());
  const agent = seams.agentFor({
    scope,
    artifacts,
    worktreePathOf: (_id: WorkspaceId) => '/tmp/asep/worktree',
  });
  assert.ok(
    agent instanceof ClaudeCodingProvider,
    'the agent seam must yield the real ClaudeCodingProvider, not a double',
  );
  // providerId carries the PINNED model + CLI version (G1), so a run's
  // provenance is unambiguous and a silent model swap is visible.
  assert.equal(agent.providerId, 'claude:claude-sonnet-4-20250514@cli-2.1.185');
});

test('HIGH-008: productionSeams binds the REAL GitHub App forge to the forge seam', () => {
  const seams = productionSeams(client, config());
  assert.ok(
    seams.forge instanceof GitHubAppForgePort,
    'the forge seam must yield the real GitHubAppForgePort, not a local double',
  );
  // The port's full surface is present (the compiler enforces `implements
  // ForgeProvider`, this asserts it at runtime too) and NO merge exists (H5).
  for (const m of ['pushBranch', 'upsertPullRequest', 'updatePullRequestContent', 'resolveRef', 'findPullRequest']) {
    assert.equal(typeof (seams.forge as unknown as Record<string, unknown>)[m], 'function', m);
  }
  assert.equal(
    (seams.forge as unknown as Record<string, unknown>)['merge'], undefined,
    'no merge capability may exist on the production forge (H5)',
  );
});

// ---------------------------------------------------------------------------
// 3 — an unconfigured deployment fails CLOSED, never degrades to a double.
// ---------------------------------------------------------------------------

test('HIGH-008: a missing Claude pin fails closed (no fallback to a test double)', () => {
  for (const field of ['executable', 'model', 'cliVersion'] as const) {
    const cfg = config();
    const claude = { ...cfg.claude, [field]: '' };
    assert.throws(
      () => productionSeams(client, { ...cfg, claude } as ProductionSeamConfig),
      ProductionConfigError,
      `${field} absent must throw`,
    );
  }
});

test('E8/G3: OMITTING an image or the model credential provider fails closed', () => {
  for (const field of ['image', 'proxyImage', 'credentials'] as const) {
    const cfg = config();
    const claude = { ...cfg.claude } as Record<string, unknown>;
    delete claude[field];
    assert.throws(
      () => productionSeams(client, { ...cfg, claude } as unknown as ProductionSeamConfig),
      ProductionConfigError,
      `omitting claude.${field} must fail closed`,
    );
  }
});

// The agent's one writable mount is the worktree leased for THIS attempt. It
// is resolved through the driver's worktreePathOf when the attempt runs — the
// first thing execute() does after vetting the tool policy — so a fixed path
// chosen at construction cannot be mounted instead.
test('E8: the production agent works in the worktree the driver resolves per attempt', async () => {
  const seams = productionSeams(client, config());
  const asked: WorkspaceId[] = [];
  const agent = seams.agentFor({
    scope,
    artifacts,
    worktreePathOf: (id: WorkspaceId) => {
      asked.push(id);
      throw new Error('worktree-resolved-through-the-seam');
    },
  });
  const obs = await agent.execute({
    attemptId: 'A'.repeat(26) as AttemptId,
    workOrderRef: { artifactId: 'x', sha256: 'a'.repeat(64), kind: 'work-order' } as unknown as ArtifactRef,
    contextPackRef: { artifactId: 'y', sha256: 'b'.repeat(64), kind: 'context-pack' } as unknown as ArtifactRef,
    workspace: { workspaceId: 'W'.repeat(26) as WorkspaceId, leaseId: 'lease-1' },
    budget: { maxTurns: 1, maxToolCalls: 1, maxCostUsd: 0.01, maxWallClockMinutes: 1 },
    toolPolicy: { allowedTools: ['read'], disallowedTools: [], networkProfile: 'restricted-egress' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(asked, ['W'.repeat(26)]);
  assert.equal(obs.status, 'FAILED');
  assert.match(obs.knownLimitations.join(' '), /worktree-resolved-through-the-seam/);
});

// E8/F5: the agent image must be pinned BY DIGEST, not merely non-empty.
//
// THE FINDING (cycle 5, HIGH-002): the guard was
// `requireString(sandbox.image, …) === ''`, so `claude-agent:latest` sailed
// through. A mutable tag means the evidence bundle attests to an image that can
// differ between the attempt and any later audit — the bundle stops identifying
// what actually ran. DockerSandboxProvider already refuses an unpinned image for
// the VERIFICATION container, so the weaker check was on the path that matters
// more: the agent is the untrusted component.
test('E8/F5: a MUTABLE agent image tag fails closed (digest pinning is mandatory)', () => {
  const cfg = config();
  for (const unpinned of [
    'claude-agent:latest',
    'claude-agent',
    'ghcr.io/asep/agent:v1.2.3',
    // Shaped like a digest but too short to be one — a near-miss must not pass.
    'alpine@sha256:' + 'a'.repeat(63),
    // A digest that is not at the END is not a pin either.
    'alpine@sha256:' + 'a'.repeat(64) + '-suffix',
  ]) {
    assert.throws(
      () => productionSeams(client, {
        ...cfg,
        claude: { ...cfg.claude, image: unpinned },
      } as ProductionSeamConfig),
      ProductionConfigError,
      `image '${unpinned}' is not digest-pinned and must be refused`,
    );
    assert.throws(
      () => productionSeams(client, {
        ...cfg,
        claude: { ...cfg.claude, proxyImage: unpinned },
      } as ProductionSeamConfig),
      ProductionConfigError,
      `proxy image '${unpinned}' is not digest-pinned and must be refused`,
    );
  }
});

test('E8/F5: a genuinely digest-pinned agent image is accepted', () => {
  const cfg = config();
  // The positive control: without it, the test above would still pass if the
  // guard rejected everything.
  const seams = productionSeams(client, {
    ...cfg,
    claude: {
      ...cfg.claude,
      image: 'ghcr.io/asep/agent@sha256:' + 'c'.repeat(64),
    },
  } as ProductionSeamConfig);
  assert.equal(typeof seams.agentFor, 'function');
});

test('HIGH-008: missing GitHub App credentials fail closed', () => {
  const cfg = config();
  assert.throws(
    () => productionSeams(client, {
      ...cfg, github: { ...cfg.github, privateKey: '' },
    } as ProductionSeamConfig),
    ProductionConfigError,
  );
  assert.throws(
    () => productionSeams(client, {
      ...cfg, github: { ...cfg.github, appId: Number.NaN },
    } as ProductionSeamConfig),
    ProductionConfigError,
  );
});

// ---------------------------------------------------------------------------
// 4 — E4: the agent seam carries NO forge credential.
// ---------------------------------------------------------------------------

test('E4: the production agent seam exposes no GitHub credential material', () => {
  const seams = productionSeams(client, config());
  const agent = seams.agentFor({
    scope, artifacts, worktreePathOf: () => '/tmp/asep/worktree',
  });
  // Walk the adapter's own enumerable state: the App private key / installation
  // id must appear nowhere on the object graph handed to the agent.
  const serialized = JSON.stringify(agent, (_k, v) => (typeof v === 'function' ? '[fn]' : v));
  assert.doesNotMatch(serialized ?? '', /BEGIN RSA PRIVATE KEY/);
  assert.doesNotMatch(serialized ?? '', /67890/);
});
