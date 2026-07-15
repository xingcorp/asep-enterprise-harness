// Compatibility GATE (P1-FINAL-HIGH-002).
//
// The in-package compat.ts classifies a diff between two schema snapshots; the
// compat.test.ts unit tests exercise that classifier on synthetic mutations.
// Neither of those actually compares the LIVE, on-disk schemas against a frozen
// prior-version snapshot — so a real breaking edit to a committed schema, made
// without a version bump, would sail through. This module is the real gate.
//
// It compares every current schema in schema/*.schema.json against its frozen
// counterpart under schema/snapshots/v<major>/ and fails if EITHER:
//   1. the structural change requires a larger semver bump than `version`
//      actually received (delegated to checkCompatibility), OR
//   2. the change is breaking (MAJOR) but the schema's $id still carries the
//      same /v<major> path segment — a breaking change MUST rev the $id major
//      too, not just the semver field.
//
// A NEW schema (no snapshot) is allowed (it is a v1 addition). A snapshot with
// no live schema is a removal and fails (contracts are append-only within a
// major line unless the operator intentionally re-snapshots a new major).
//
// Usage:
//   tsx src/compat-gate.ts            # gate: compare live schemas vs snapshots
//   tsx src/compat-gate.ts --self-test  # prove the gate catches an under-bumped break

import {
  readFileSync, readdirSync, existsSync,
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkCompatibility, type SchemaNode } from './compat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schema');
const SNAPSHOT_ROOT = join(SCHEMA_DIR, 'snapshots');

export interface GateResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly checked: number;
}

function majorOfId($id: string | undefined): string | null {
  if (typeof $id !== 'string') return null;
  const m = /\/v(\d+)(?:$|\/)/.exec($id);
  return m ? m[1]! : null;
}

function listSchemas(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
}

function load(path: string): SchemaNode {
  return JSON.parse(readFileSync(path, 'utf8')) as SchemaNode;
}

/**
 * Compare live schemas against the frozen snapshot for a major line.
 * `liveDir`/`snapshotDir` are overridable so the self-test can point them at
 * synthetic fixtures without touching the committed tree.
 */
export function runCompatGate(
  liveDir: string = SCHEMA_DIR,
  snapshotDir: string = join(SNAPSHOT_ROOT, 'v1'),
): GateResult {
  const problems: string[] = [];
  const live = listSchemas(liveDir);
  const snap = new Set(listSchemas(snapshotDir));
  let checked = 0;

  // Removals: a snapshot with no live counterpart is a breaking deletion.
  for (const file of snap) {
    if (!live.includes(file)) {
      problems.push(`${file}: present in snapshot v1 but removed from live schema/ (breaking deletion)`);
    }
  }

  for (const file of live) {
    if (!snap.has(file)) {
      // New schema in this major line — allowed as an additive v1 contract.
      continue;
    }
    checked++;
    const prev = load(join(snapshotDir, file));
    const next = load(join(liveDir, file));
    const verdict = checkCompatibility(prev, next);
    if (!verdict.ok) {
      problems.push(`${file}: ${verdict.message}`);
    }
    // A MAJOR structural change must also rev the $id major segment.
    if (verdict.requiredBump === 'major') {
      const prevMajor = majorOfId(prev.$id as string | undefined);
      const nextMajor = majorOfId(next.$id as string | undefined);
      if (prevMajor !== null && nextMajor !== null && prevMajor === nextMajor) {
        problems.push(
          `${file}: breaking (MAJOR) change but $id major segment did not change (still /v${nextMajor}); a breaking change must publish a new $id major`,
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, checked };
}

function selfTest(): number {
  // Build synthetic live+snapshot dirs in a temp area, seed one breaking change
  // with no bump, and assert the gate rejects it; then fix the bump+$id and
  // assert it passes.
  const tmp = mkdtempSync(join(tmpdir(), 'asep-compat-'));
  const snapDir = join(tmp, 'snap');
  const liveDir = join(tmp, 'live');
  mkdirSync(snapDir);
  mkdirSync(liveDir);

  const v1 = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://asep.dev/schema/thing/v1',
    version: '1.0.0',
    title: 'Thing',
    type: 'object',
    additionalProperties: false,
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'string' } },
  };
  writeFileSync(join(snapDir, 'thing.schema.json'), JSON.stringify(v1));

  let rc = 0;

  // Case 1: remove field `b`, keep version 1.0.0 and $id v1 => must FAIL.
  const broken = JSON.parse(JSON.stringify(v1));
  delete broken.properties.b;
  broken.required = ['a'];
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(broken));
  const r1 = runCompatGate(liveDir, snapDir);
  if (r1.ok) {
    console.error('self-test: FAIL (under-bumped breaking removal was accepted)');
    rc = 1;
  } else {
    console.log('self-test: PASS (breaking removal without bump rejected)');
  }

  // Case 2: same removal but bump version to 2.0.0 AND $id to /v2 => must PASS.
  const fixed = JSON.parse(JSON.stringify(broken));
  fixed.version = '2.0.0';
  fixed.$id = 'https://asep.dev/schema/thing/v2';
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(fixed));
  const r2 = runCompatGate(liveDir, snapDir);
  if (!r2.ok) {
    console.error(`self-test: FAIL (properly-bumped major break rejected: ${r2.problems.join('; ')})`);
    rc = 1;
  } else {
    console.log('self-test: PASS (major break with version+$id bump accepted)');
  }

  // Case 3: major bump on version but $id major NOT changed => must FAIL.
  const halfFixed = JSON.parse(JSON.stringify(broken));
  halfFixed.version = '2.0.0';
  // $id still /v1
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(halfFixed));
  const r3 = runCompatGate(liveDir, snapDir);
  if (r3.ok) {
    console.error('self-test: FAIL (major break with stale $id major was accepted)');
    rc = 1;
  } else {
    console.log('self-test: PASS (major break requires $id major rev too)');
  }

  rmSync(tmp, { recursive: true, force: true });
  return rc;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  }
  const result = runCompatGate();
  if (!result.ok) {
    console.error(`compat-gate: FAIL — ${result.problems.length} problem(s):`);
    for (const p of result.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`compat-gate: PASS (${result.checked} schema(s) compatible with snapshot v1)`);
}
