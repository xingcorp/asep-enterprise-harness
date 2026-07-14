// Schema compatibility checker (Codex P1-CHANGE-003).
//
// Compares two versions of a JSON Schema and classifies the change as a semver
// bump level, then checks that the declared `version` field was bumped at least
// that far. This lets CI fail a PR that removes/renames a field (a breaking
// change) without a major bump, or adds a required field without a major bump.
//
// Classification rules (conservative — when unsure, escalate to a higher bump):
//   MAJOR (breaking): a property was removed; an optional property became
//     required; an enum value was removed; a property's type changed.
//   MINOR (additive): a new optional property was added; a new enum value was
//     added; a required property was relaxed to optional.
//   PATCH/NONE: description/example/annotation-only changes, or no change.

export type BumpLevel = 'none' | 'patch' | 'minor' | 'major';

export interface SchemaNode {
  readonly type?: string | string[];
  readonly enum?: readonly unknown[];
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: readonly string[];
  readonly items?: SchemaNode;
  readonly version?: string;
  readonly [k: string]: unknown;
}

export interface CompatChange {
  readonly level: BumpLevel;
  readonly path: string;
  readonly reason: string;
}

const ORDER: Record<BumpLevel, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export function maxLevel(a: BumpLevel, b: BumpLevel): BumpLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

function typeOf(n: SchemaNode | undefined): string {
  if (!n) return 'undefined';
  if (Array.isArray(n.type)) return [...n.type].sort().join('|');
  return n.type ?? (n.enum ? 'enum' : 'unknown');
}

function diffNode(
  prev: SchemaNode,
  next: SchemaNode,
  path: string,
  out: CompatChange[],
): void {
  // Type change on this node = breaking.
  const pt = typeOf(prev);
  const nt = typeOf(next);
  if (pt !== nt && pt !== 'unknown' && nt !== 'unknown') {
    out.push({ level: 'major', path, reason: `type changed ${pt} -> ${nt}` });
  }

  // Enum value diffs.
  if (prev.enum || next.enum) {
    const pe = new Set((prev.enum ?? []).map((v) => JSON.stringify(v)));
    const ne = new Set((next.enum ?? []).map((v) => JSON.stringify(v)));
    for (const v of pe) {
      if (!ne.has(v)) out.push({ level: 'major', path, reason: `enum value removed ${v}` });
    }
    for (const v of ne) {
      if (!pe.has(v)) out.push({ level: 'minor', path, reason: `enum value added ${v}` });
    }
  }

  // Property-level diffs.
  const prevProps = prev.properties ?? {};
  const nextProps = next.properties ?? {};
  const prevReq = new Set(prev.required ?? []);
  const nextReq = new Set(next.required ?? []);

  for (const key of Object.keys(prevProps)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in nextProps)) {
      out.push({ level: 'major', path: childPath, reason: 'property removed' });
      continue;
    }
    // required -> still required or relaxed?
    if (prevReq.has(key) && !nextReq.has(key)) {
      out.push({ level: 'minor', path: childPath, reason: 'required relaxed to optional' });
    }
    if (!prevReq.has(key) && nextReq.has(key)) {
      out.push({ level: 'major', path: childPath, reason: 'optional tightened to required' });
    }
    diffNode(prevProps[key]!, nextProps[key]!, childPath, out);
  }

  for (const key of Object.keys(nextProps)) {
    if (key in prevProps) continue;
    const childPath = path ? `${path}.${key}` : key;
    if (nextReq.has(key)) {
      out.push({ level: 'major', path: childPath, reason: 'new required property added' });
    } else {
      out.push({ level: 'minor', path: childPath, reason: 'new optional property added' });
    }
  }

  // Recurse into array items.
  if (prev.items && next.items) {
    diffNode(prev.items, next.items, `${path}[]`, out);
  }
}

/** All classified changes between two schema versions, most-significant first. */
export function compareSchemas(prev: SchemaNode, next: SchemaNode): CompatChange[] {
  const out: CompatChange[] = [];
  diffNode(prev, next, '', out);
  return out.sort((a, b) => ORDER[b.level] - ORDER[a.level]);
}

/** The single required semver bump implied by a set of changes. */
export function requiredBump(changes: readonly CompatChange[]): BumpLevel {
  return changes.reduce<BumpLevel>((acc, c) => maxLevel(acc, c.level), 'none');
}

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseSemver(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`compat: invalid semver "${v}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** The actual bump between two semvers (major > minor > patch > none). */
export function actualBump(prev: string, next: string): BumpLevel {
  const a = parseSemver(prev);
  const b = parseSemver(next);
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  if (b.patch !== a.patch) return 'patch';
  return 'none';
}

export interface CompatVerdict {
  readonly ok: boolean;
  readonly requiredBump: BumpLevel;
  readonly actualBump: BumpLevel;
  readonly changes: readonly CompatChange[];
  readonly message: string;
}

/**
 * Verify that the version bump between two schema snapshots is at least as large
 * as the structural change requires. `ok:false` means the version was
 * under-bumped for the changes made.
 */
export function checkCompatibility(prev: SchemaNode, next: SchemaNode): CompatVerdict {
  const changes = compareSchemas(prev, next);
  const required = requiredBump(changes);
  const prevV = prev.version;
  const nextV = next.version;
  if (typeof prevV !== 'string' || typeof nextV !== 'string') {
    throw new Error('compat: both schemas must declare a string `version`');
  }
  const actual = actualBump(prevV, nextV);
  const ok = ORDER[actual] >= ORDER[required];
  const message = ok
    ? `compatible: changes require ${required}, version bump was ${actual}`
    : `INCOMPATIBLE: changes require a ${required} bump but version went ${prevV} -> ${nextV} (${actual})`;
  return { ok, requiredBump: required, actualBump: actual, changes, message };
}
