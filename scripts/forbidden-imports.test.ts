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
