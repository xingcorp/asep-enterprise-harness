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
