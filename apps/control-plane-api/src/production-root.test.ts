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
//      silently degrading to the local doubles — including the case where the
//      agent sandbox is omitted, which would otherwise hand back a
//      host-execution agent (E8/G3).
//   4. No forge credential is reachable from the agent seam (E4): the Claude
//      provider is constructed with only (config, scope, artifactStore).

import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAppForgePort } from '@asep/github-app';
import { ClaudeCodingProvider } from '@asep/agent-claude';
import {
  productionSeams, ProductionConfigError, type ProductionSeamConfig,
} from './production-root.js';
import type { SqlClient } from '@asep/persistence';
import type { ArtifactStore } from '@asep/ports';
import type {
  TenantScope, RepositoryBindingId, WorkspaceId, ArtifactRef,
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

// A syntactically valid PEM shape. No key material is used: nothing here mints a
// token, so this never touches GitHub.
const PEM_LABEL = 'RSA PRIVATE KEY';
const FAKE_PEM = `${'-'.repeat(5)}BEGIN ${PEM_LABEL}${'-'.repeat(5)}\nQUJD\n${'-'.repeat(5)}END ${PEM_LABEL}${'-'.repeat(5)}\n`;

function config(over: Partial<ProductionSeamConfig> = {}): ProductionSeamConfig {
  return {
    claude: {
      executable: '/usr/local/bin/claude',
      model: 'claude-sonnet-4-20250514',
      cliVersion: '2.1.185',
      maxTurns: 12,
      sandbox: {
        image: 'alpine@sha256:' + 'a'.repeat(64),
        runFlags: ['--network', 'none', '--read-only'],
        workdir: '/workspace',
      },
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
  for (const m of ['pushBranch', 'upsertPullRequest', 'resolveRef', 'findPullRequest']) {
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

test('E8/G3: OMITTING the agent sandbox fails closed (no host-execution agent)', () => {
  const cfg = config();
  const claude = { ...cfg.claude } as Record<string, unknown>;
  delete claude['sandbox'];
  assert.throws(
    () => productionSeams(client, { ...cfg, claude } as unknown as ProductionSeamConfig),
    ProductionConfigError,
    'a production root must not be able to obtain a non-sandboxed agent',
  );
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
