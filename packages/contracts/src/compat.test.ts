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

// --- P1-FINAL-HIGH-002 (re-review): constraint tightening is BREAKING --------
//
// Codex's bypass: `minLength 1 -> 10` and `additionalProperties true -> false`
// were classified as non-breaking (ok=true, requiredBump=none), so a schema
// that newly rejects previously-valid data slipped through with no major bump.
// The classifier now treats every tightening as MAJOR and every loosening as
// MINOR. Each case below proves: (a) the tightening requires a major bump, and
// (b) under-bumping it FAILS the checker while a proper major bump PASSES.

// A minimal v1 base schema we can tighten in isolated ways.
function tightenBase(): MutableSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://asep.dev/schema/thing/v1',
    version: '1.0.0',
    title: 'Thing',
    type: 'object',
    additionalProperties: true,
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      score: { type: 'number', minimum: 0, maximum: 100 },
      code: { type: 'string' },
    },
  } as unknown as MutableSchema;
}

// Apply a mutation, assert it needs a major bump, then assert under-bump FAILS
// and a major bump PASSES.
function assertTighteningIsBreaking(
  label: string,
  mutate: (next: MutableSchema) => void,
): void {
  const base = tightenBase() as unknown as SchemaNode;

  // requiredBump must be major.
  const tightened = JSON.parse(JSON.stringify(base)) as MutableSchema;
  mutate(tightened);
  const changes = compareSchemas(base, tightened as unknown as SchemaNode);
  assert.equal(
    requiredBump(changes),
    'major',
    `${label}: tightening must require a MAJOR bump, got ${requiredBump(changes)} (changes: ${JSON.stringify(changes)})`,
  );

  // Under-bump (minor) must FAIL the checker.
  const underBumped = JSON.parse(JSON.stringify(base)) as MutableSchema;
  mutate(underBumped);
  underBumped.version = '1.1.0';
  const bad = checkCompatibility(base, underBumped as unknown as SchemaNode);
  assert.equal(bad.ok, false, `${label}: under-bumped tightening must FAIL`);
  assert.equal(bad.requiredBump, 'major', `${label}: requiredBump should be major`);

  // Proper major bump must PASS.
  const properlyBumped = JSON.parse(JSON.stringify(base)) as MutableSchema;
  mutate(properlyBumped);
  properlyBumped.version = '2.0.0';
  const good = checkCompatibility(base, properlyBumped as unknown as SchemaNode);
  assert.equal(good.ok, true, `${label}: major-bumped tightening must PASS — ${good.message}`);
}

test('BYPASS: minLength 1 -> 10 is BREAKING (Codex case)', () => {
  assertTighteningIsBreaking('minLength up', (n) => {
    (n.properties!['name'] as { minLength?: number }).minLength = 10;
  });
});

test('BYPASS: additionalProperties true -> false is BREAKING (Codex case)', () => {
  assertTighteningIsBreaking('additionalProperties closed', (n) => {
    n['additionalProperties'] = false;
  });
});

test('BYPASS: maxLength lowered is BREAKING', () => {
  assertTighteningIsBreaking('maxLength down', (n) => {
    (n.properties!['name'] as { maxLength?: number }).maxLength = 5;
  });
});

test('BYPASS: maxItems lowered is BREAKING', () => {
  assertTighteningIsBreaking('maxItems down', (n) => {
    (n.properties!['tags'] as { maxItems?: number }).maxItems = 3;
  });
});

test('BYPASS: minItems raised is BREAKING', () => {
  assertTighteningIsBreaking('minItems up', (n) => {
    (n.properties!['tags'] as { minItems?: number }).minItems = 2;
  });
});

test('BYPASS: minimum raised is BREAKING', () => {
  assertTighteningIsBreaking('minimum up', (n) => {
    (n.properties!['score'] as { minimum?: number }).minimum = 10;
  });
});

test('BYPASS: maximum lowered is BREAKING', () => {
  assertTighteningIsBreaking('maximum down', (n) => {
    (n.properties!['score'] as { maximum?: number }).maximum = 50;
  });
});

test('BYPASS: adding a pattern is BREAKING', () => {
  assertTighteningIsBreaking('pattern added', (n) => {
    (n.properties!['code'] as { pattern?: string }).pattern = '^[A-Z]{3}$';
  });
});

test('BYPASS: adding a format is BREAKING', () => {
  assertTighteningIsBreaking('format added', (n) => {
    (n.properties!['code'] as { format?: string }).format = 'uuid';
  });
});

test('BYPASS: narrowing a nested enum is BREAKING', () => {
  // enum narrowing was already covered at top level; prove it also fires nested
  // and through the tightening classifier's major requirement.
  const base = tightenBase() as unknown as SchemaNode;
  const withEnum = JSON.parse(JSON.stringify(base)) as MutableSchema;
  (withEnum.properties!['code'] as { enum?: string[] }).enum = ['A', 'B', 'C'];
  const src = withEnum as unknown as SchemaNode;
  const narrowed = JSON.parse(JSON.stringify(withEnum)) as MutableSchema;
  (narrowed.properties!['code'] as { enum?: string[] }).enum = ['A'];
  const changes = compareSchemas(src, narrowed as unknown as SchemaNode);
  assert.equal(requiredBump(changes), 'major');
});

test('BYPASS: adding multipleOf is BREAKING', () => {
  assertTighteningIsBreaking('multipleOf added', (n) => {
    (n.properties!['score'] as { multipleOf?: number }).multipleOf = 5;
  });
});

test('LOOSENING: additionalProperties false -> true is MINOR (not breaking)', () => {
  const base = tightenBase() as unknown as SchemaNode;
  const closed = JSON.parse(JSON.stringify(base)) as MutableSchema;
  closed['additionalProperties'] = false;
  const src = closed as unknown as SchemaNode;
  const opened = JSON.parse(JSON.stringify(closed)) as MutableSchema;
  opened['additionalProperties'] = true;
  const changes = compareSchemas(src, opened as unknown as SchemaNode);
  assert.equal(requiredBump(changes), 'minor');
});

test('LOOSENING: minLength lowered is MINOR (not breaking)', () => {
  const base = tightenBase() as unknown as SchemaNode;
  const next = JSON.parse(JSON.stringify(base)) as MutableSchema;
  (next.properties!['name'] as { minLength?: number }).minLength = 0;
  next.version = '1.1.0';
  const verdict = checkCompatibility(base, next as unknown as SchemaNode);
  assert.equal(verdict.requiredBump, 'minor');
  assert.equal(verdict.ok, true, verdict.message);
});

// P1-CYCLE3-HIGH-001: a version DOWNGRADE must never satisfy a required bump.
// Codex bypass: remove a required property (a MAJOR break) while changing
// version 1.0.0 -> 0.0.0. actualBump() classified ANY major inequality as
// "major", so the breaking change sailed through as if it had been bumped.
test('BYPASS: version DOWNGRADE does not satisfy a required major bump (Codex cycle-3)', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  // Remove a required property => MAJOR break required.
  const req = (base.required as readonly string[]).slice();
  assert.ok(req.length > 0, 'finding schema must have at least one required prop');
  const dropped = req[0]!;
  next.required = req.filter((r) => r !== dropped);
  delete (next.properties as Record<string, SchemaNode>)[dropped];
  // Downgrade the version instead of bumping it.
  next.version = '0.0.0';

  const verdict = checkCompatibility(base, next as unknown as SchemaNode);
  assert.equal(verdict.requiredBump, 'major', 'removing a required prop requires major');
  assert.equal(
    verdict.ok,
    false,
    `a version downgrade (1.x -> 0.0.0) must NOT satisfy a required bump — got ${verdict.message}`,
  );
});

// A proper forward major bump for the same break must still PASS.
test('removing a required property WITH a forward major bump passes', () => {
  const base = loadSchema('finding');
  const next = clone(base);
  const req = (base.required as readonly string[]).slice();
  const dropped = req[0]!;
  next.required = req.filter((r) => r !== dropped);
  delete (next.properties as Record<string, SchemaNode>)[dropped];
  next.version = '2.0.0';

  const verdict = checkCompatibility(base, next as unknown as SchemaNode);
  assert.equal(verdict.requiredBump, 'major');
  assert.equal(verdict.ok, true, `forward major bump must pass — ${verdict.message}`);
});

// actualBump must only report "major" when the major segment INCREASES, never
// when it decreases (a downgrade) or merely differs.
test('actualBump reports a DOWNGRADE as none/decrease, not a major bump', () => {
  assert.equal(actualBump('1.0.0', '0.0.0'), 'none', 'major downgrade is not a forward bump');
  assert.equal(actualBump('2.5.0', '1.0.0'), 'none', 'any downgrade is not a forward bump');
  assert.equal(actualBump('1.0.0', '2.0.0'), 'major', 'forward major bump');
  assert.equal(actualBump('1.0.0', '1.1.0'), 'minor');
  assert.equal(actualBump('1.0.0', '1.0.1'), 'patch');
});
