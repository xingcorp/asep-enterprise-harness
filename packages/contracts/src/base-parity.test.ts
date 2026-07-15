// P1-FINAL-HIGH-001: structural parity guard for x-tsType overrides.
//
// The byte-identical drift guard (drift.test.ts) does NOT catch drift behind an
// x-tsType override, because generated.ts only names the base type. These tests
// close that hole: every override in every committed schema must structurally
// match its base.ts descriptor, and deliberate mutations (RiskLevel enum change,
// Budget gaining a required field) MUST be rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  collectOverrides,
  checkOverride,
  type SubSchema,
} from './base-parity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schema');

interface Loaded {
  file: string;
  schema: SubSchema & { $id?: string; title?: string };
}

function loadSchemas(): Loaded[] {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
    .map((file) => ({
      file,
      schema: JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')),
    }));
}

function refTitleIndex(schemas: Loaded[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const { schema } of schemas) {
    if (schema.$id && schema.title) idx.set(schema.$id, schema.title);
  }
  return idx;
}

test('every committed schema x-tsType override structurally matches base.ts', () => {
  const schemas = loadSchemas();
  const refTitles = refTitleIndex(schemas);
  const errors: string[] = [];
  for (const { file, schema } of schemas) {
    for (const site of collectOverrides(schema)) {
      const err = checkOverride(site, refTitles);
      if (err) errors.push(`${file} ${err}`);
    }
  }
  assert.equal(
    errors.length,
    0,
    `x-tsType structural drift detected:\n${errors.join('\n')}`,
  );
});

test('at least one override of each base kind is exercised by real schemas', () => {
  const schemas = loadSchemas();
  const seen = new Set<string>();
  for (const { schema } of schemas) {
    for (const site of collectOverrides(schema)) seen.add(site.typeName);
  }
  // These are the value objects most at risk of silent drift.
  for (const name of ['RiskLevel', 'SkillRef', 'Budget', 'TaskId']) {
    assert.ok(seen.has(name), `expected some schema to override x-tsType "${name}"`);
  }
});

// --- Mutation tests: deliberate drift MUST be rejected -----------------------

test('MUTATION: RiskLevel enum change is rejected until base.ts is updated', () => {
  const refTitles = new Map<string, string>();
  const mutated: SubSchema = {
    type: 'object',
    properties: {
      // R5 added — schema now disagrees with base.ts RiskLevel union.
      risk: { type: 'string', enum: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'], 'x-tsType': 'RiskLevel' },
    },
  };
  const sites = collectOverrides(mutated);
  const err = sites.map((s) => checkOverride(s, refTitles)).find(Boolean);
  assert.ok(err, 'a RiskLevel enum mutation must produce a parity error');
  assert.match(err!, /RiskLevel.*enum drift/);
});

test('MUTATION: adding a required field to Budget is rejected', () => {
  const refTitles = new Map<string, string>();
  const mutated: SubSchema = {
    type: 'object',
    properties: {
      budget: {
        type: 'object',
        required: ['maxTurns', 'maxToolCalls', 'maxCostUsd', 'maxWallClockMinutes', 'maxRetries'],
        properties: {
          maxTurns: { type: 'integer' },
          maxToolCalls: { type: 'integer' },
          maxCostUsd: { type: 'number' },
          maxWallClockMinutes: { type: 'number' },
          maxRetries: { type: 'integer' }, // NEW field not in base.ts Budget
        },
        'x-tsType': 'Budget',
      },
    },
  };
  const sites = collectOverrides(mutated);
  const err = sites.map((s) => checkOverride(s, refTitles)).find(Boolean);
  assert.ok(err, 'adding a Budget field must produce a parity error');
  assert.match(err!, /Budget.*(property-set drift|required-set drift)/);
});

test('MUTATION: a branded id override on a non-string schema is rejected', () => {
  const refTitles = new Map<string, string>();
  const mutated: SubSchema = {
    type: 'object',
    properties: {
      id: { type: 'integer', 'x-tsType': 'TaskId' }, // TaskId brands string, not number
    },
  };
  const sites = collectOverrides(mutated);
  const err = sites.map((s) => checkOverride(s, refTitles)).find(Boolean);
  assert.ok(err, 'a branded-id override on a non-string must be rejected');
  assert.match(err!, /TaskId.*expects schema type "string"/);
});

test('MUTATION: an x-tsType naming an unknown type with no $ref is rejected', () => {
  const refTitles = new Map<string, string>();
  const mutated: SubSchema = {
    type: 'object',
    properties: {
      thing: { type: 'string', 'x-tsType': 'MysteryType' },
    },
  };
  const sites = collectOverrides(mutated);
  const err = sites.map((s) => checkOverride(s, refTitles)).find(Boolean);
  assert.ok(err, 'an unchecked override must be rejected');
  assert.match(err!, /unchecked override/);
});

test('$ref-backed override is valid when x-tsType equals the referenced title', () => {
  const refTitles = new Map<string, string>([
    ['https://asep.dev/schema/finding/v1', 'Finding'],
  ]);
  const node: SubSchema = {
    type: 'array',
    items: { $ref: 'https://asep.dev/schema/finding/v1', 'x-tsType': 'Finding' },
  };
  const sites = collectOverrides(node);
  const errs = sites.map((s) => checkOverride(s, refTitles)).filter(Boolean);
  assert.equal(errs.length, 0, `expected no error, got: ${errs.join('; ')}`);
});
