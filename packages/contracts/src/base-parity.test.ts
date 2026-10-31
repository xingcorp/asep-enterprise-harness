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
  parseBaseStructure,
  loadBaseStructure,
  type SubSchema,
  type BaseStructure,
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

test('MUTATION: an override inside a oneOf variant is checked like any other', () => {
  const refTitles = new Map<string, string>();
  const mutated: SubSchema = {
    oneOf: [
      { type: 'array', items: { type: 'integer', 'x-tsType': 'TaskId' } },
      { type: 'null' },
    ],
  };
  const sites = collectOverrides(mutated);
  assert.deepEqual(sites.map((s) => s.pointer), ['#/oneOf/0/items']);
  const err = sites.map((s) => checkOverride(s, refTitles)).find(Boolean);
  assert.match(err ?? '', /TaskId.*expects schema type "string"/);
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

// --- P1-FINAL-HIGH-001 (re-review): expected shape MUST come from base.ts -----
//
// Codex's bypass: mutate BOTH the schema AND a hand-copied EXPECTED_BASE_STRUCTURE
// table to add R5 — parity passed while base.ts still declared RiskLevel through
// R4 only. The fix derives the expected structure by PARSING base.ts source, so
// there is no shadow table to co-mutate. These tests prove that.

const BASE_TS_PATH = join(HERE, 'base.ts');

test('parseBaseStructure extracts RiskLevel/Budget/SkillRef/brands from base.ts source', () => {
  const struct = parseBaseStructure(readFileSync(BASE_TS_PATH, 'utf8'));
  // RiskLevel is a string-union enum R0..R4 in base.ts.
  assert.deepEqual(struct['RiskLevel'], {
    kind: 'enum',
    values: ['R0', 'R1', 'R2', 'R3', 'R4'],
  });
  // Budget is a scalar object with four required numeric fields.
  const budget = struct['Budget'];
  assert.equal(budget?.kind, 'object');
  if (budget?.kind === 'object') {
    assert.deepEqual(Object.keys(budget.properties).sort(), [
      'maxCostUsd',
      'maxToolCalls',
      'maxTurns',
      'maxWallClockMinutes',
    ]);
    assert.equal(budget.required.length, 4);
  }
  // SkillRef object; brands are string brands.
  assert.equal(struct['SkillRef']?.kind, 'object');
  assert.deepEqual(struct['TaskId'], { kind: 'brand', base: 'string' });
});

test('BYPASS: adding R5 to the schema but NOT to base.ts MUST fail parity', () => {
  // The committed base.ts declares RiskLevel = R0..R4. A schema that overrides
  // x-tsType RiskLevel but adds an R5 enum member is drift, because the expected
  // shape is parsed from the REAL base.ts on disk — there is no shadow table to
  // also edit.
  const structFromRealBase = loadBaseStructure(BASE_TS_PATH);
  const mutatedSchema: SubSchema = {
    type: 'object',
    properties: {
      risk: {
        type: 'string',
        enum: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'],
        'x-tsType': 'RiskLevel',
      },
    },
  };
  const sites = collectOverrides(mutatedSchema);
  const err = sites
    .map((s) => checkOverride(s, new Map(), structFromRealBase))
    .find(Boolean);
  assert.ok(err, 'adding R5 to schema without editing base.ts must fail parity');
  assert.match(err!, /RiskLevel.*enum drift/);
});

test('BYPASS closed: adding R5 to BOTH schema and base.ts passes parity', () => {
  // Simulate a base.ts where RiskLevel legitimately gained R5. Parsing THIS
  // source yields the R5 descriptor, so the matching schema passes. This proves
  // the expected values track base.ts source, not a duplicated constant.
  const mutatedBaseSource = readFileSync(BASE_TS_PATH, 'utf8').replace(
    /export type RiskLevel =[^;]+;/,
    "export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';",
  );
  const struct = parseBaseStructure(mutatedBaseSource);
  const riskLevel = struct['RiskLevel'];
  assert.equal(riskLevel?.kind, 'enum');
  const values = riskLevel?.kind === 'enum' ? [...riskLevel.values] : [];
  assert.deepEqual(values, ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  const mutatedSchema: SubSchema = {
    type: 'object',
    properties: {
      risk: {
        type: 'string',
        enum: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'],
        'x-tsType': 'RiskLevel',
      },
    },
  };
  const sites = collectOverrides(mutatedSchema);
  const errs = sites
    .map((s) => checkOverride(s, new Map(), struct))
    .filter(Boolean);
  assert.equal(errs.length, 0, `expected no drift, got: ${errs.join('; ')}`);
});

test('BYPASS: adding a Budget field only in the schema (not base.ts) fails parity', () => {
  const structFromRealBase = loadBaseStructure(BASE_TS_PATH);
  const mutatedSchema: SubSchema = {
    type: 'object',
    properties: {
      budget: {
        type: 'object',
        required: [
          'maxTurns',
          'maxToolCalls',
          'maxCostUsd',
          'maxWallClockMinutes',
          'maxRetries',
        ],
        properties: {
          maxTurns: { type: 'integer' },
          maxToolCalls: { type: 'integer' },
          maxCostUsd: { type: 'number' },
          maxWallClockMinutes: { type: 'number' },
          maxRetries: { type: 'integer' },
        },
        'x-tsType': 'Budget',
      },
    },
  };
  const sites = collectOverrides(mutatedSchema);
  const err = sites
    .map((s) => checkOverride(s, new Map(), structFromRealBase))
    .find(Boolean);
  assert.ok(err, 'a Budget field only in schema must fail parity');
  assert.match(err!, /Budget.*(property-set drift|required-set drift)/);
});
