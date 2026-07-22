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

// Canonical schema identity (P1-CYCLE4-HIGH-001, hardened P1-CYCLE5-HIGH-001).
//
// Every canonical schema MUST carry an $id of the exact shape
//   https://asep.dev/schema/<name>/v<major>
// parsed as a real URL — NOT by substring/regex sniffing, which Codex bypassed
// by smuggling a "/v2" inside a query string. The name segment is the schema's
// stable logical identity within a major line; the trailing /v<major> segment is
// the ONLY place a version major may be encoded. A query, fragment, wrong host,
// wrong scheme, missing/empty value, or a path that does not match the canonical
// grammar all fail closed.
//
// P1-CYCLE5-HIGH-001 — two residual holes closed here:
//
//   (1) PRECISION COLLAPSE. The major was coerced with Number(), so two
//       TEXTUALLY DISTINCT majors above Number.MAX_SAFE_INTEGER collapse to the
//       same IEEE-754 float (e.g. v9007199254740993 and v9007199254740992 both
//       become 9007199254740992). The coherence check then saw a false match.
//       The major is now carried as its CANONICAL DECIMAL STRING and compared by
//       string equality, and any major above MAX_SAFE_INTEGER is rejected as out
//       of the supported range. Numeric tokens are strict: no leading zeros.
//
//   (2) NONCANONICAL URL ALIASES. The parser only checked host/search/hash, so
//       userinfo (user@), an explicit default port (:443, silently dropped by
//       the URL parser), an uppercase scheme/host, a trailing slash, and a
//       leading-zero major (/v01) all slipped through. Canonicality is now
//       enforced EXACTLY: after structural validation the identity is
//       re-serialised into the one canonical string and compared byte-for-byte
//       against the original input. Any deviation fails closed.
export interface CanonicalId {
  readonly name: string;
  /**
   * The version major as its canonical decimal string (e.g. "1", "42"). Kept as
   * a string — never a JS Number — so two distinct large majors can never
   * collapse into one value (P1-CYCLE5-HIGH-001). Values above
   * Number.MAX_SAFE_INTEGER are rejected at parse time, so this string always
   * denotes an exactly-representable, leading-zero-free integer.
   */
  readonly major: string;
}

const CANONICAL_HOST = 'asep.dev';
const CANONICAL_SCHEME = 'https:';
// Strict numeric token: a single 0, or a non-zero digit followed by more digits.
// No leading zeros (rejects /v01), no sign, no separators.
const NUM = '(?:0|[1-9][0-9]*)';
const CANONICAL_PATH = new RegExp(`^/schema/([a-z][a-z0-9-]*)/v(${NUM})$`);
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})$`);

/**
 * Reject a decimal-string integer that exceeds Number.MAX_SAFE_INTEGER
 * (9007199254740991). Above that bound distinct integers are no longer
 * distinguishable once coerced to a JS Number, which is exactly the collapse
 * Codex exploited. We keep the value as a string but still bound its magnitude
 * so downstream consumers that DO coerce cannot be surprised.
 */
function isSafeInteger(decimal: string): boolean {
  // Cheap magnitude guard first (MAX_SAFE_INTEGER has 16 digits), then exact.
  if (decimal.length > 16) return false;
  return Number(decimal) <= Number.MAX_SAFE_INTEGER;
}

/**
 * Parse an $id against the single canonical naming rule. Returns the parsed
 * identity, or an `error` string explaining exactly why it is not canonical.
 * There is no substring fallback: the path is taken from a parsed URL so a
 * query/fragment can never be mistaken for a version segment, and the whole
 * identity is re-serialised and compared byte-for-byte so no noncanonical
 * spelling (userinfo, explicit port, uppercase, trailing slash) is accepted.
 */
export function parseCanonicalId(id: unknown): CanonicalId | { error: string } {
  if (typeof id !== 'string') return { error: '$id is missing or not a string' };
  if (id.length === 0) return { error: '$id is an empty string' };
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return { error: `$id is not a parseable URL (${id})` };
  }
  if (url.protocol !== CANONICAL_SCHEME) return { error: `$id must use the https scheme (${id})` };
  if (url.hostname !== CANONICAL_HOST) return { error: `$id host must be ${CANONICAL_HOST} (${id})` };
  if (url.username !== '' || url.password !== '') {
    return { error: `$id must not carry userinfo/credentials (${id})` };
  }
  if (url.port !== '') return { error: `$id must not carry an explicit port (${id})` };
  if (url.search !== '') return { error: `$id must not carry a query string (${id})` };
  if (url.hash !== '') return { error: `$id must not carry a fragment (${id})` };
  const m = CANONICAL_PATH.exec(url.pathname);
  if (!m) {
    return { error: `$id path must be /schema/<name>/v<major> with a leading-zero-free major (${id})` };
  }
  const name = m[1]!;
  const major = m[2]!;
  if (!isSafeInteger(major)) {
    return { error: `$id major v${major} exceeds the supported range (> Number.MAX_SAFE_INTEGER) (${id})` };
  }
  // EXACT canonical serialization: reconstruct the one legal spelling and require
  // the ORIGINAL input to equal it byte-for-byte. This is the single source of
  // truth for canonicality — it rejects an uppercase scheme/host, a default port
  // the URL parser would drop, a trailing slash, or any other alias, without
  // enumerating every variant.
  const canonical = `${CANONICAL_SCHEME}//${CANONICAL_HOST}/schema/${name}/v${major}`;
  if (id !== canonical) {
    return { error: `$id is not in exact canonical form; expected ${canonical} (${id})` };
  }
  return { name, major };
}

/**
 * Parse a strict semver X.Y.Z. Each segment is leading-zero-free and the major
 * must be within Number.MAX_SAFE_INTEGER; the major is returned as its canonical
 * decimal STRING so it can be compared against the $id major without an
 * IEEE-754 collapse (P1-CYCLE5-HIGH-001).
 */
export function parseVersionMajor(version: unknown): { major: string } | { error: string } {
  if (typeof version !== 'string') return { error: 'version is missing or not a string' };
  const m = SEMVER.exec(version);
  if (!m) return { error: `version is not a valid semver X.Y.Z (${version})` };
  const major = m[1]!;
  if (!isSafeInteger(major)) {
    return { error: `version major ${major} exceeds the supported range (> Number.MAX_SAFE_INTEGER) (${version})` };
  }
  return { major };
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

  // Every live schema's canonical $id must be unique across the registry: two
  // schemas advertising the same identity is an ambiguous contract. We record
  // (canonical-id -> file) as we validate and flag any collision.
  const seenIds = new Map<string, string>();

  for (const file of live) {
    const next = load(join(liveDir, file));

    // ---- MANDATORY canonical identity + version (P1-CYCLE4-HIGH-001) --------
    //
    // Fail closed BEFORE any compat classification. A missing, empty, malformed,
    // unversioned, wrong-host, or query/fragment-smuggled $id is rejected here,
    // as is a non-semver `version`, and any disagreement between the $id major
    // and the version major. The cycle-4 bypass (breaking change + version 2.0.0
    // + deleted/unversioned $id) short-circuited because the old majorOfId()
    // returned null and every coherence check was gated on non-null; the checks
    // are now UNCONDITIONAL for every live schema.
    const idParsed = parseCanonicalId(next.$id);
    const verParsed = parseVersionMajor(next.version);
    let idMajor: string | null = null;
    let idName: string | null = null;
    if ('error' in idParsed) {
      problems.push(`${file}: ${idParsed.error}`);
    } else {
      idMajor = idParsed.major;
      idName = idParsed.name;
      const canonical = `https://${CANONICAL_HOST}/schema/${idParsed.name}/v${idParsed.major}`;
      const prior = seenIds.get(canonical);
      if (prior !== undefined) {
        problems.push(`${file}: duplicate $id ${canonical} (already declared by ${prior})`);
      } else {
        seenIds.set(canonical, file);
      }
    }
    if ('error' in verParsed) {
      problems.push(`${file}: ${verParsed.error}`);
    }
    if (idMajor !== null && !('error' in verParsed) && idMajor !== verParsed.major) {
      problems.push(
        `${file}: $id major /v${idMajor} disagrees with declared version major ${verParsed.major} ` +
          `(version ${String(next.version)}); the $id major must equal the semantic-version major`,
      );
    }

    if (!snap.has(file)) {
      // New schema in this major line — allowed as an additive contract, but it
      // still had to pass the identity/version validation above.
      continue;
    }
    checked++;
    const prev = load(join(snapshotDir, file));

    // Logical-identity stability: the snapshot and live $id must name the SAME
    // logical contract (same /schema/<name>/). A silent swap from /thing/ to
    // /other/ substitutes one contract for another and is rejected.
    const prevParsed = parseCanonicalId(prev.$id);
    if (idName !== null && !('error' in prevParsed) && prevParsed.name !== idName) {
      problems.push(
        `${file}: logical identity changed from /${prevParsed.name}/ to /${idName}/ ` +
          `(a schema file must keep its logical identity; publish a new file for a new contract)`,
      );
    }

    // Only run the structural compat classifier when BOTH versions are valid
    // semver. checkCompatibility throws on a non-semver version; that defect is
    // already recorded above (verParsed error), so skipping here avoids masking
    // the clear "not semver" problem with an opaque parse throw. The classifier
    // is still wrapped defensively so a malformed snapshot cannot crash the gate.
    const prevVerOk = !('error' in parseVersionMajor(prev.version));
    if (!('error' in verParsed) && prevVerOk) {
      let verdict;
      try {
        verdict = checkCompatibility(prev, next);
      } catch (e) {
        problems.push(`${file}: compat classification failed: ${(e as Error).message}`);
        continue;
      }
      if (!verdict.ok) {
        problems.push(`${file}: ${verdict.message}`);
      }
      // A MAJOR structural change must also rev the $id major segment.
      if (verdict.requiredBump === 'major') {
        const prevMajor = 'error' in prevParsed ? null : prevParsed.major;
        if (prevMajor !== null && idMajor !== null && prevMajor === idMajor) {
          problems.push(
            `${file}: breaking (MAJOR) change but $id major segment did not change (still /v${idMajor}); a breaking change must publish a new $id major`,
          );
        }
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

  // Case 4 (P1-CYCLE3-HIGH-001): the Codex downgrade bypass. Remove a required
  // property (a MAJOR break) while DOWNGRADING both the version (1.0.0 -> 0.0.0)
  // and the $id (/v1 -> /v0). The two move together, so the "major differs"
  // check is satisfied, but the version went BACKWARDS. Must FAIL.
  const downgraded = JSON.parse(JSON.stringify(broken));
  downgraded.version = '0.0.0';
  downgraded.$id = 'https://asep.dev/schema/thing/v0';
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(downgraded));
  const r4 = runCompatGate(liveDir, snapDir);
  if (r4.ok) {
    console.error('self-test: FAIL (breaking change with a version+$id DOWNGRADE was accepted — HIGH-001 regression)');
    rc = 1;
  } else {
    console.log('self-test: PASS (breaking change via version+$id downgrade rejected — P1-CYCLE3-HIGH-001)');
  }

  // Case 5: $id major must agree with the declared version major. Bump version
  // to 2.0.0 but leave $id at /v1 already covered by Case 3; here we do the
  // inverse — $id /v2 but version stays 1.x — which must also FAIL.
  const mismatched = JSON.parse(JSON.stringify(broken));
  mismatched.version = '1.0.0';
  mismatched.$id = 'https://asep.dev/schema/thing/v2';
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(mismatched));
  const r5 = runCompatGate(liveDir, snapDir);
  if (r5.ok) {
    console.error('self-test: FAIL ($id major /v2 with version 1.x was accepted — HIGH-001 regression)');
    rc = 1;
  } else {
    console.log('self-test: PASS ($id-major/version-major disagreement rejected — P1-CYCLE3-HIGH-001)');
  }

  // Case 6 (P1-CYCLE4-HIGH-001): breaking removal + version 2.0.0 + DELETED $id.
  // The exact cycle-4 bypass. A missing $id short-circuited the old coherence
  // checks; now a canonical versioned $id is MANDATORY, so this must FAIL.
  const noId = JSON.parse(JSON.stringify(broken));
  noId.version = '2.0.0';
  delete noId.$id;
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(noId));
  const r6 = runCompatGate(liveDir, snapDir);
  if (r6.ok) {
    console.error('self-test: FAIL (breaking change with a DELETED $id was accepted — CYCLE4-HIGH-001)');
    rc = 1;
  } else {
    console.log('self-test: PASS (missing $id rejected — P1-CYCLE4-HIGH-001)');
  }

  // Case 7 (P1-CYCLE4-HIGH-001): breaking removal + version 2.0.0 + UNVERSIONED
  // $id (no /vN segment). Also short-circuited the old checks; must FAIL.
  const unversioned = JSON.parse(JSON.stringify(broken));
  unversioned.version = '2.0.0';
  unversioned.$id = 'https://asep.dev/schema/thing/not-versioned';
  writeFileSync(join(liveDir, 'thing.schema.json'), JSON.stringify(unversioned));
  const r7 = runCompatGate(liveDir, snapDir);
  if (r7.ok) {
    console.error('self-test: FAIL (breaking change with an UNVERSIONED $id was accepted — CYCLE4-HIGH-001)');
    rc = 1;
  } else {
    console.log('self-test: PASS (unversioned $id rejected — P1-CYCLE4-HIGH-001)');
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
