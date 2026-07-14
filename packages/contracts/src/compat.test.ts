import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkCompatibility,
  compareSchemas,
  requiredBump,
  actualBump,
  type SchemaNode,
} from './compat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schema');

function loadSchema(name: string): SchemaNode {
  return JSON.parse(
    readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'),
  ) as SchemaNode;
}

// A mutable projection of SchemaNode used only to build mutation fixtures.
type MutableSchema = {
  version?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  [k: string]: unknown;
};

// Deep clone so mutation fixtures never touch the on-disk schema. Returns a
// mutable view because the fixtures below intentionally rewrite version/required.
function clone(v: SchemaNode): MutableSchema {
  return JSON.parse(JSON.stringify(v)) as MutableSchema;
}

test('adding an optional field is a MINOR change and passes with a minor bump', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  next.version = '1.1.0';
  (next.properties as Record<string, SchemaNode>)['notes'] = { type: 'string' };

  const changes = compareSchemas(base, next);
  assert.equal(requiredBump(changes), 'minor');

  const verdict = checkCompatibility(base, next);
  assert.equal(verdict.ok, true, verdict.message);
});

test('adding an optional field but only a PATCH bump FAILS the checker', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  next.version = '1.0.1'; // under-bumped
  (next.properties as Record<string, SchemaNode>)['notes'] = { type: 'string' };

  const verdict = checkCompatibility(base, next);
  assert.equal(verdict.ok, false, 'patch bump must be rejected for an additive change');
  assert.equal(verdict.requiredBump, 'minor');
  assert.equal(verdict.actualBump, 'patch');
});

test('removing a field is a MAJOR change and requires a major bump', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  next.version = '1.1.0'; // minor is NOT enough for a removal
  delete (next.properties as Record<string, SchemaNode>)['requiredFix'];
  next.required = (next.required ?? []).filter((r) => r !== 'requiredFix');

  const changes = compareSchemas(base, next);
  assert.equal(requiredBump(changes), 'major');

  const verdict = checkCompatibility(base, next);
  assert.equal(verdict.ok, false, 'field removal must require a major bump');
});

test('removing a field WITH a major bump passes', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  next.version = '2.0.0';
  delete (next.properties as Record<string, SchemaNode>)['requiredFix'];
  next.required = (next.required ?? []).filter((r) => r !== 'requiredFix');

  const verdict = checkCompatibility(base, next);
  assert.equal(verdict.ok, true, verdict.message);
});

test('changing a property type is a MAJOR change', () => {
  const base = loadSchema('work-order');
  const next = clone(base);
  next.version = '2.0.0';
  (next.properties as Record<string, SchemaNode>)['objective'] = { type: 'integer' };

  const changes = compareSchemas(base, next);
  assert.equal(requiredBump(changes), 'major');
  assert.ok(changes.some((c) => c.reason.includes('type changed')));
});

test('removing an enum value is a MAJOR change', () => {
  const base = loadSchema('work-order');
  const next = clone(base);
  next.version = '2.0.0';
  const risk = (next.properties as Record<string, SchemaNode>)['risk']!;
  (risk as { enum?: unknown[] }).enum = ['R0', 'R1', 'R2', 'R3']; // dropped R4

  const changes = compareSchemas(base, next);
  assert.equal(requiredBump(changes), 'major');
  assert.ok(changes.some((c) => c.reason.includes('enum value removed')));
});

test('adding an enum value is a MINOR change', () => {
  const base = loadSchema('work-order');
  const next = clone(base);
  next.version = '1.1.0';
  const risk = (next.properties as Record<string, SchemaNode>)['risk']!;
  (risk as { enum?: unknown[] }).enum = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];

  const verdict = checkCompatibility(base, next);
  assert.equal(verdict.requiredBump, 'minor');
  assert.equal(verdict.ok, true, verdict.message);
});

test('an identical schema is a no-op (none)', () => {
  const base = loadSchema('run-event');
  const next = clone(base);
  const changes = compareSchemas(base, next);
  assert.equal(changes.length, 0);
  assert.equal(requiredBump(changes), 'none');
});

test('tightening an optional field to required is MAJOR', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  next.version = '2.0.0';
  next.required = [...(next.required ?? []), 'file'];

  const changes = compareSchemas(base, next);
  assert.equal(requiredBump(changes), 'major');
});

test('actualBump helper classifies version deltas', () => {
  assert.equal(actualBump('1.0.0', '2.0.0'), 'major');
  assert.equal(actualBump('1.0.0', '1.1.0'), 'minor');
  assert.equal(actualBump('1.0.0', '1.0.1'), 'patch');
  assert.equal(actualBump('1.0.0', '1.0.0'), 'none');
});
