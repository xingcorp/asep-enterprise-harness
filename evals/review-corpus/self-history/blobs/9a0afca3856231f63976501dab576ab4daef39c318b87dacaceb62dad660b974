// Architecture fitness test (P1-FINAL-HIGH-004).
//
// The domain packages (@asep/contracts, @asep/policy, @asep/domain,
// @asep/ports, @asep/observability) MUST stay free of two classes of
// dependency, per the locked plan:
//
//   1. Provider SDKs (anthropic, openai, google-generativeai, bedrock, ...) —
//      domain contracts and deterministic policy must never bind to a model
//      vendor. Risk rules must be deterministic and never call a model.
//   2. Live network / non-deterministic I/O (node:http(s), node:net, fetch,
//      undici, axios, ...) — Phase 1 is deterministic and offline; a network
//      import in the domain layer is a determinism/leak hazard.
//
// This is a real fitness test: it walks the committed source of each domain
// package, parses every import/require specifier, and fails the build if any
// forbidden specifier appears. A self-check fixture proves the matcher is live
// (it would catch a seeded violation), so the test cannot silently pass by
// matching nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Machine-readable suite marker (P1-CYCLE4-MED-001): the canonical runner
// asserts this line is present so the fitness suite cannot be silently dropped.
console.log('SUITE-ID: asep-suite:forbidden-imports');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// Domain packages whose source must stay clean.
const DOMAIN_PACKAGES = [
  'contracts',
  'policy',
  'domain',
  'ports',
  'observability',
] as const;

// The application layer (exit criterion B3) must also stay free of provider
// SDKs AND all infrastructure bindings (Fastify, pg, Octokit, AWS, Docker):
// the execution use case composes only against @asep/ports interfaces, so a
// concrete infra import here is a layering violation.
const APPLICATION_PACKAGES = ['application'] as const;

// Forbidden import specifiers. Each entry is matched against the *module
// specifier* of an import/require (the string in quotes), not arbitrary code,
// to avoid false positives on comments or identifiers.
const FORBIDDEN: ReadonlyArray<{ label: string; test: (spec: string) => boolean }> = [
  // Provider / model-vendor SDKs.
  { label: 'anthropic SDK', test: (s) => /^@anthropic-ai\/|(^|\/)anthropic($|\/)/.test(s) },
  { label: 'openai SDK', test: (s) => /^openai($|\/)/.test(s) },
  { label: 'google genai SDK', test: (s) => /^@google\/(generative-ai|genai)|google-generativeai/.test(s) },
  { label: 'aws bedrock SDK', test: (s) => /^@aws-sdk\/client-bedrock/.test(s) },
  { label: 'cohere SDK', test: (s) => /^cohere-ai($|\/)/.test(s) },
  { label: 'mistral SDK', test: (s) => /^@mistralai\//.test(s) },
  { label: 'langchain', test: (s) => /^(langchain|@langchain\/)/.test(s) },
  // Live network / non-deterministic I/O.
  { label: 'node http', test: (s) => /^(node:)?https?$/.test(s) },
  { label: 'node net/dgram/tls', test: (s) => /^(node:)?(net|dgram|tls)$/.test(s) },
  { label: 'http client lib', test: (s) => /^(axios|undici|got|node-fetch|superagent|request)($|\/)/.test(s) },
];

// Infrastructure bindings additionally banned from the domain + application
// layers (exit criterion B3). These are legitimate in adapters/* and the
// composition roots (apps/*, workers/*) but never in pure layers.
const FORBIDDEN_INFRA: ReadonlyArray<{ label: string; test: (spec: string) => boolean }> = [
  { label: 'Fastify', test: (s) => /^fastify($|\/)/.test(s) },
  { label: 'PostgreSQL driver', test: (s) => /^(pg|pg-pool|postgres|slonik|drizzle-orm|typeorm|knex)($|\/)/.test(s) },
  { label: 'Octokit / GitHub SDK', test: (s) => /^(@octokit\/|octokit$)/.test(s) },
  { label: 'AWS SDK', test: (s) => /^(aws-sdk|@aws-sdk\/)/.test(s) },
  { label: 'Docker SDK', test: (s) => /^(dockerode|@docker\/)/.test(s) },
  { label: 'child_process (shell/git)', test: (s) => /^(node:)?child_process$/.test(s) },
];

// Match ESM import ... from '<spec>' , bare import '<spec>' , dynamic import('<spec>')
// and CommonJS require('<spec>'). Captures the specifier in group 1|2|3|4.
const IMPORT_RE =
  /(?:import\s[^'"]*?from\s*['"]([^'"]+)['"])|(?:import\s*['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

function specifiersOf(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) specs.push(spec);
  }
  return specs;
}

function firstForbidden(spec: string): string | null {
  for (const rule of FORBIDDEN) {
    if (rule.test(spec)) return rule.label;
  }
  return null;
}

// Domain rules PLUS infra bindings — applied to the application layer.
function firstForbiddenAppLayer(spec: string): string | null {
  const base = firstForbidden(spec);
  if (base) return base;
  for (const rule of FORBIDDEN_INFRA) {
    if (rule.test(spec)) return rule.label;
  }
  return null;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('domain packages import no provider SDK or live-network module', () => {
  const violations: string[] = [];
  let filesScanned = 0;
  for (const pkg of DOMAIN_PACKAGES) {
    const srcDir = join(REPO_ROOT, 'packages', pkg, 'src');
    for (const file of walkTs(srcDir)) {
      filesScanned++;
      const source = readFileSync(file, 'utf8');
      for (const spec of specifiersOf(source)) {
        const bad = firstForbidden(spec);
        if (bad) {
          violations.push(`${file}: imports '${spec}' (${bad})`);
        }
      }
    }
  }
  // Guard against the matcher silently scanning nothing.
  assert.ok(filesScanned > 0, 'fitness test scanned zero files — glob is broken');
  assert.deepEqual(
    violations,
    [],
    `forbidden imports found in domain layer:\n${violations.join('\n')}`,
  );
});

test('self-check: the forbidden matcher actually catches a seeded violation', () => {
  // Prove the rules are live — a synthetic source with each forbidden class
  // must be flagged, so a passing suite means "no violations", not "matcher dead".
  const seeded = [
    `import Anthropic from '@anthropic-ai/sdk';`,
    `import OpenAI from 'openai';`,
    `import https from 'node:https';`,
    `const axios = require('axios');`,
    `import { x } from '@langchain/core';`,
  ].join('\n');
  const specs = specifiersOf(seeded);
  const flagged = specs.filter((s) => firstForbidden(s) !== null);
  assert.equal(flagged.length, 5, `expected all 5 seeded violations flagged, got ${flagged.length}`);
});

test('self-check: legitimate domain imports are NOT flagged', () => {
  const ok = [
    `import Ajv from 'ajv';`,
    `import addFormats from 'ajv-formats';`,
    `import { parse } from 'yaml';`,
    `import { WorkOrder } from '@asep/contracts';`,
    `import { readFileSync } from 'node:fs';`,
    `import { join } from 'node:path';`,
  ].join('\n');
  const specs = specifiersOf(ok);
  const flagged = specs.filter((s) => firstForbidden(s) !== null);
  assert.deepEqual(flagged, [], `legitimate imports wrongly flagged: ${flagged.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Application-layer layering (exit criterion B3). The execution use case in
// @asep/application composes ONLY against @asep/ports interfaces + pure policy/
// domain logic — never a provider SDK and never a concrete infra binding
// (Fastify, pg, Octokit, AWS, Docker, child_process). It may import @asep/*
// workspace packages freely.
// ---------------------------------------------------------------------------

test('application layer imports no provider SDK or infrastructure binding', () => {
  const violations: string[] = [];
  let filesScanned = 0;
  for (const pkg of APPLICATION_PACKAGES) {
    const srcDir = join(REPO_ROOT, 'packages', pkg, 'src');
    for (const file of walkTs(srcDir)) {
      filesScanned++;
      const source = readFileSync(file, 'utf8');
      for (const spec of specifiersOf(source)) {
        const bad = firstForbiddenAppLayer(spec);
        if (bad) violations.push(`${file}: imports '${spec}' (${bad})`);
      }
    }
  }
  assert.ok(filesScanned > 0, 'application fitness scanned zero files — glob is broken');
  assert.deepEqual(
    violations,
    [],
    `forbidden imports found in application layer:\n${violations.join('\n')}`,
  );
});

test('self-check: application infra matcher catches seeded infra + provider imports', () => {
  const seeded = [
    `import Fastify from 'fastify';`,
    `import { Pool } from 'pg';`,
    `import { Octokit } from '@octokit/rest';`,
    `import { S3Client } from '@aws-sdk/client-s3';`,
    `import Docker from 'dockerode';`,
    `import { spawn } from 'node:child_process';`,
    `import Anthropic from '@anthropic-ai/sdk';`,
  ].join('\n');
  const specs = specifiersOf(seeded);
  const flagged = specs.filter((s) => firstForbiddenAppLayer(s) !== null);
  assert.equal(flagged.length, 7, `expected all 7 seeded app-layer violations flagged, got ${flagged.length}`);
});

test('self-check: legitimate application imports (ports/policy/domain) are NOT flagged', () => {
  const ok = [
    `import type { CodingAgentProvider } from '@asep/ports';`,
    `import { approvalFor } from '@asep/policy';`,
    `import { transitionTask } from '@asep/domain';`,
    `import type { RiskLevel } from '@asep/contracts';`,
  ].join('\n');
  const specs = specifiersOf(ok);
  const flagged = specs.filter((s) => firstForbiddenAppLayer(s) !== null);
  assert.deepEqual(flagged, [], `legitimate app imports wrongly flagged: ${flagged.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Composition-root discipline (exit criteria B2 + B5). apps/* and workers/*
// wire adapters to the application use case and forward requests. They must
// contain NO domain decision, persistence query, provider call or workflow
// sequencing of their own. This is defined negatively: a handler/root may parse
// transport, validate, call the use case and map the response, but a raw SQL
// query, a git/child_process spawn, a provider-SDK instantiation or a direct
// policy-decision call inside a root is a layering violation (disp.
// P2-PLAN-LOW-001). The mutation self-test proves the detector rejects each
// seeded violation and accepts a thin route.
// ---------------------------------------------------------------------------

const ROOT_PACKAGES: ReadonlyArray<{ base: string; names: readonly string[] }> = [
  { base: 'apps', names: ['control-plane-api'] },
  { base: 'workers', names: ['workflow-worker'] },
];

// Patterns that must never appear in composition-root source. Matched against
// raw source (not just import specifiers) because the violation is the *use*,
// not the import.
const ROOT_FORBIDDEN: ReadonlyArray<{ label: string; test: (src: string) => boolean }> = [
  { label: 'raw SQL query', test: (s) => /\b(SELECT|INSERT|UPDATE|DELETE)\s+[\s\S]*?\bFROM\b|\.query\s*\(/i.test(s) },
  { label: 'git / child_process spawn', test: (s) => /\b(spawn|spawnSync|execFile|execFileSync|exec)\s*\(\s*['"`]?git\b/.test(s) || /child_process/.test(s) },
  { label: 'provider SDK instantiation', test: (s) => /new\s+(Anthropic|OpenAI)\s*\(/.test(s) || /@anthropic-ai\/|(^|[^a-z])openai($|\/)/.test(s) },
  { label: 'direct policy decision', test: (s) => /\b(admitRisk|gatePolicy|classifyRisk|approvalFor|requiredLevels|classifyFailure)\s*\(/.test(s) },
  // Direct persistence-repository call (disp. P2-FINAL-MED-004). B2/B5 require a
  // handler to forward to an application use case, never to invoke a repository
  // method itself. A call of the shape `repos.<name>.<method>(` or
  // `repositories.<name>.<method>(` is a repository invocation inside the root —
  // the handler bypassing the application layer. Passing the bundle AS AN
  // ARGUMENT to a use case (`createRun(repos, ...)`) is fine: that is not a
  // `repos.x.y(` call, so it does not match.
  { label: 'direct repository call', test: (s) => /\brepos(itories)?\.\w+\.\w+\s*\(/.test(s) },
];

// Strip line + block comments before scanning, so the detector matches actual
// CODE, not documentation — a doc comment describing "spawns git/child_process"
// is not a composition-root violation, an executed spawn/query is. String
// literals are deliberately KEPT: an import specifier ('node:child_process') or
// a call argument ('git') lives in a string and is exactly the code-use we must
// still catch. This keeps the guard precise without a full parser.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (not URL '://')
}

function rootViolations(source: string): string[] {
  const code = stripComments(source);
  return ROOT_FORBIDDEN.filter((r) => r.test(code)).map((r) => r.label);
}

// Test suites are exempt from composition-root discipline: a test legitimately
// constructs fakes/spies, drives repositories directly to assert on real rows,
// and spawns real git/docker to prove behaviour against real backends. That is
// the POINT of an integration proof, not a layering violation.
//
// Both suffixes are listed deliberately. The exemption originally covered only
// `.test.ts`; when the real-backend integration suites (`*.itest.ts`) were added
// they fell OUTSIDE it and were scanned as if they were shipped production code,
// so the K1 real-backend proof (which must read repository rows and run a docker
// preflight) tripped the detector. Exempting them applies the pre-existing
// rationale to the integration variant — it does NOT relax any pattern: every
// ROOT_FORBIDDEN rule still applies in full to all non-test root source.
function isTestSuite(file: string): boolean {
  return file.endsWith('.test.ts') || file.endsWith('.itest.ts');
}

test('composition roots (apps/*, workers/*) contain no domain/persistence/provider/policy logic', () => {
  const violations: string[] = [];
  let filesScanned = 0;
  for (const { base, names } of ROOT_PACKAGES) {
    for (const name of names) {
      const srcDir = join(REPO_ROOT, base, name, 'src');
      for (const file of walkTs(srcDir)) {
        if (isTestSuite(file)) continue; // tests may construct fakes/spies
        filesScanned++;
        const source = readFileSync(file, 'utf8');
        for (const bad of rootViolations(source)) {
          violations.push(`${file}: contains ${bad}`);
        }
      }
    }
  }
  assert.ok(filesScanned > 0, 'composition-root arch test scanned zero files — glob is broken');
  assert.deepEqual(
    violations,
    [],
    `composition-root discipline violated:\n${violations.join('\n')}`,
  );
});

test('arch mutation self-test: a seeded SQL/Git/provider/policy call in a handler is REJECTED', () => {
  const seededSql = `app.get('/x', async () => { const r = await pool.query('SELECT * FROM tasks'); return r; });`;
  const seededGit = `import { spawn } from 'node:child_process'; spawn('git', ['status']);`;
  const seededProvider = `const a = new Anthropic({ apiKey: k }); await a.messages.create({});`;
  const seededPolicy = `app.post('/run', () => { const d = admitRisk(body.risk); return d; });`;
  assert.ok(rootViolations(seededSql).includes('raw SQL query'), 'seeded SQL not detected');
  assert.ok(rootViolations(seededGit).includes('git / child_process spawn'), 'seeded git not detected');
  assert.ok(rootViolations(seededProvider).includes('provider SDK instantiation'), 'seeded provider not detected');
  assert.ok(rootViolations(seededPolicy).includes('direct policy decision'), 'seeded policy call not detected');
  // A handler that calls a repository method directly bypasses the application
  // layer (B2/B5) and must be rejected.
  const seededRepoCall = `app.post('/run', async () => { const r = await repos.runs.create(scope, {}); return r; });`;
  const seededReposLong = `app.get('/t/:id', async () => repositories.tasks.getScoped(scope, id));`;
  assert.ok(rootViolations(seededRepoCall).includes('direct repository call'), 'seeded repos.x.y() call not detected');
  assert.ok(rootViolations(seededReposLong).includes('direct repository call'), 'seeded repositories.x.y() call not detected');
});

// The test-suite exemption must cover EXACTLY the test suffixes and nothing
// else. If it ever widened to production source, a real handler could smuggle in
// a repository call or a git spawn and the composition-root gate would go quiet.
test('arch self-test: the test-suite exemption covers *.test.ts / *.itest.ts ONLY', () => {
  // Exempt: unit and integration suites legitimately hold fakes + real backends.
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/app.test.ts'), true);
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/vertical-slice.itest.ts'), true);
  // NOT exempt: shipped composition-root source stays fully governed.
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/app.ts'), false);
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/vertical-slice.ts'), false);
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/cli-main.ts'), false);
  // A filename merely CONTAINING 'test' is not a suite and must stay governed.
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/test-helpers.ts'), false);
  assert.equal(isTestSuite('/repo/apps/control-plane-api/src/latest.ts'), false);
});

test('arch mutation self-test: a thin route that only parses + forwards to the use case is ACCEPTED', () => {
  const thinRoute = [
    `import { runExecuteTask } from '@asep/workflow-worker';`,
    `app.post('/v1/tasks/:id/execute', async (req, reply) => {`,
    `  const scope = req.tenantScope;             // from auth hook`,
    `  const input = parseExecuteRequest(req.body); // transport parsing`,
    `  const result = await runExecuteTask({ ...input, scope });`,
    `  return reply.code(200).send(mapResult(result)); // response mapping`,
    `});`,
  ].join('\n');
  assert.deepEqual(
    rootViolations(thinRoute),
    [],
    'a thin forwarding route was wrongly flagged as a composition-root violation',
  );
});
