// Gate test (P1-FINAL-HIGH-002): the live schemas MUST stay compatible with the
// frozen v1 snapshots, and the gate itself must catch an under-bumped break.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runCompatGate } from './compat-gate.js';

// Machine-readable suite marker (P1-CYCLE4-MED-001): the canonical test runner
// asserts this line appears in captured output, so this suite cannot be silently
// dropped from the canonical command without turning the gate RED.
console.log('SUITE-ID: asep-suite:compat-gate');

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'compat-gate.ts');

// 1. The committed tree must be green: every live schema is compatible with its
//    frozen snapshot. This is the real regression guard, not a synthetic clone.
test('live schemas are compatible with the frozen v1 snapshots', () => {
  const result = runCompatGate();
  assert.ok(
    result.ok,
    `compat gate found breaking drift vs snapshot v1:\n${result.problems.join('\n')}`,
  );
  assert.ok(result.checked >= 12, `expected >=12 schemas checked, got ${result.checked}`);
});

// 2. Removing a field from a snapshotted schema without a major bump/$id rev must
//    make the gate FAIL (proves the gate has teeth against the real tree shape).
test('MUTATION: under-bumped breaking removal is rejected by the gate', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'asep-compat-gate-'));
  const snapDir = join(tmp, 'snap');
  const liveDir = join(tmp, 'live');
  mkdirSync(snapDir);
  mkdirSync(liveDir);

  const v1 = {
    $id: 'https://asep.dev/schema/thing/v1',
    version: '1.0.0',
    title: 'Thing',
    type: 'object',
    additionalProperties: false,
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'string' } },
  };
  writeFileSync(join(snapDir, 'thing.schema.json'), JSON.stringify(v1));

  const broken = JSON.parse(JSON.stringify(v1));
  delete broken.properties.b;
  broken.required = ['a'];
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(broken));

  const result = runCompatGate(liveDir, snapDir);
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.ok, false, 'removing a field with no bump must fail the gate');
});

// 3. The gate CLI --self-test must pass (proves reject + accept + $id-major paths).
test('compat-gate --self-test proves reject/accept/$id-major behaviour', () => {
  let code = 0;
  let out = '';
  try {
    out = execFileSync('pnpm', ['exec', 'tsx', GATE, '--self-test'], {
      encoding: 'utf8',
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    code = err.status ?? 1;
    out = (err.stdout ?? '') + (err.stderr ?? '');
  }
  assert.equal(code, 0, `self-test should exit 0\n${out}`);
  assert.match(out, /breaking removal without bump rejected/);
  assert.match(out, /major break with version\+\$id bump accepted/);
  assert.match(out, /major break requires \$id major rev too/);
});

// ---------------------------------------------------------------------------
// P1-CYCLE4 HIGH-001 (partial): canonical schema identity + version coherence.
//
// Codex bypassed the cycle-3 fix by exploiting that the $id-major checks were
// only applied when majorOfId() returned non-null. A breaking removal combined
// with version=2.0.0 and a DELETED or UNVERSIONED $id sailed through because
// both coherence guards short-circuited on a null major. The repair makes a
// canonical, versioned $id MANDATORY and enforces $id-major == version-major
// for every live schema, so a missing/malformed/unversioned/mismatched $id
// fails closed.
//
// These tests reconstruct each bypass shape (RED before the fix) using synthetic
// live+snapshot dirs so they never touch the committed tree.

interface Schema {
  [k: string]: unknown;
}

function withSyntheticDirs(fn: (snapDir: string, liveDir: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), 'asep-compat-identity-'));
  const snapDir = join(tmp, 'snap');
  const liveDir = join(tmp, 'live');
  mkdirSync(snapDir);
  mkdirSync(liveDir);
  try {
    fn(snapDir, liveDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const BASE_V1: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://asep.dev/schema/thing/v1',
  version: '1.0.0',
  title: 'Thing',
  type: 'object',
  additionalProperties: false,
  required: ['a', 'b'],
  properties: { a: { type: 'string' }, b: { type: 'string' } },
};

function writeSchema(dir: string, name: string, schema: Schema): void {
  writeFileSync(join(dir, name), JSON.stringify(schema));
}

function seedSnapshot(snapDir: string): void {
  writeSchema(snapDir, 'thing.schema.json', BASE_V1);
}

// The exact Codex breaking mutation: remove required property `b`.
function breakingRemoval(base: Schema): Schema {
  const next = JSON.parse(JSON.stringify(base)) as Schema;
  const props = next.properties as Record<string, unknown>;
  delete props.b;
  next.required = ['a'];
  return next;
}

test('HIGH-001 bypass A: breaking change + version 2.0.0 + DELETED $id is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    delete next.$id; // the exact bypass: no $id at all
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'a schema with no $id must fail the gate');
    assert.ok(
      r.problems.some((p) => /\$id/.test(p)),
      `expected an $id problem, got: ${r.problems.join('; ')}`,
    );
  });
});

test('HIGH-001 bypass B: breaking change + version 2.0.0 + UNVERSIONED $id is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    next.$id = 'https://asep.dev/schema/thing/not-versioned'; // no /vN segment
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'an unversioned $id must fail the gate');
    assert.ok(r.problems.some((p) => /\$id/.test(p)));
  });
});

test('HIGH-001: an EMPTY $id string is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    next.$id = '';
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'an empty $id must fail the gate');
    assert.ok(r.problems.some((p) => /\$id/.test(p)));
  });
});

test('HIGH-001: a MALFORMED $id (wrong namespace) is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    next.$id = 'urn:evil:thing:v2'; // not the canonical https://asep.dev/schema/<name>/vN
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'a malformed $id must fail the gate');
    assert.ok(r.problems.some((p) => /\$id/.test(p)));
  });
});

test('HIGH-001: $id /v1 with declared version 2.0.0 is rejected (major mismatch)', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    next.$id = 'https://asep.dev/schema/thing/v1'; // stale major
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, '$id-major must equal version-major');
    assert.ok(r.problems.some((p) => /major/.test(p)));
  });
});

test('HIGH-001: $id /v2 with declared version 1.9.0 is rejected (major mismatch)', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    // Additive-only change so the compat classifier does not itself object; the
    // ONLY defect is the $id-major/version-major disagreement.
    const next = JSON.parse(JSON.stringify(BASE_V1)) as Schema;
    next.version = '1.9.0';
    next.$id = 'https://asep.dev/schema/thing/v2';
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, '$id /v2 with version 1.x must be rejected');
    assert.ok(r.problems.some((p) => /major/.test(p)));
  });
});

test('HIGH-001: a misleading query/fragment cannot smuggle a fake version', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    // Looks like it contains /v2 but only inside a query string; the canonical
    // path is still /v1, so the real major is 1 and disagrees with version 2.
    next.$id = 'https://asep.dev/schema/thing/v1?shadow=/v2';
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'a query-string /v2 must not launder the version');
    assert.ok(r.problems.some((p) => /\$id/.test(p)));
  });
});

test('HIGH-001: an identity SWAP (name segment changed) is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    // Same file, same major, valid semver — but the logical identity changed
    // from /thing/ to /other/. That is a silent contract substitution.
    const next = JSON.parse(JSON.stringify(BASE_V1)) as Schema;
    next.$id = 'https://asep.dev/schema/other/v1';
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'changing the logical identity must be rejected');
    assert.ok(r.problems.some((p) => /identity/.test(p)));
  });
});

test('HIGH-001: DUPLICATE $id across two live schemas is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    // No snapshots needed; two NEW live schemas collide on $id.
    const a = JSON.parse(JSON.stringify(BASE_V1)) as Schema;
    const b = JSON.parse(JSON.stringify(BASE_V1)) as Schema;
    a.$id = 'https://asep.dev/schema/dup/v1';
    b.$id = 'https://asep.dev/schema/dup/v1';
    writeSchema(liveDir, 'a.schema.json', a);
    writeSchema(liveDir, 'b.schema.json', b);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'two schemas sharing an $id must be rejected');
    assert.ok(r.problems.some((p) => /duplicate/i.test(p)));
  });
});

test('HIGH-001: a non-semver version string is rejected', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = JSON.parse(JSON.stringify(BASE_V1)) as Schema;
    next.version = 'v1'; // not X.Y.Z
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, false, 'a non-semver version must be rejected');
    assert.ok(r.problems.some((p) => /semver|version/i.test(p)));
  });
});

test('HIGH-001 POSITIVE: a valid same-major additive upgrade is accepted', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    // Add an optional property, bump minor, keep $id /v1. Must PASS.
    const next = JSON.parse(JSON.stringify(BASE_V1)) as Schema;
    next.version = '1.1.0';
    (next.properties as Record<string, unknown>).c = { type: 'string' };
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, true, `valid additive upgrade must pass: ${r.problems.join('; ')}`);
  });
});

test('HIGH-001 POSITIVE: a governed major migration (version 2.0.0 + $id /v2) is accepted', () => {
  withSyntheticDirs((snapDir, liveDir) => {
    seedSnapshot(snapDir);
    const next = breakingRemoval(BASE_V1);
    next.version = '2.0.0';
    next.$id = 'https://asep.dev/schema/thing/v2';
    writeSchema(liveDir, 'thing.schema.json', next);
    const r = runCompatGate(liveDir, snapDir);
    assert.equal(r.ok, true, `governed major migration must pass: ${r.problems.join('; ')}`);
  });
});
