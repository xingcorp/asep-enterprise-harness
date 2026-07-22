// Schema compatibility checker (Codex P1-CHANGE-003).
//
// Compares two versions of a JSON Schema and classifies the change as a semver
// bump level, then checks that the declared `version` field was bumped at least
// that far. This lets CI fail a PR that removes/renames a field (a breaking
// change) without a major bump, or adds a required field without a major bump.
//
// Classification rules (conservative — when unsure, escalate to a higher bump):
//   MAJOR (breaking): a property was removed; an optional property became
//     required; an enum value was removed; a property's type changed; OR any
//     validation constraint was TIGHTENED so that data valid under the old
//     schema can be rejected by the new one (P1-FINAL-HIGH-002):
//       - minLength increased / maxLength decreased
//       - minItems increased / maxItems decreased
//       - minimum increased / maximum decreased (incl. exclusive* forms)
//       - additionalProperties true -> false (or an object constraint appearing)
//       - a `pattern` added or changed
//       - a `format` added or changed
//       - a `required` list gained a member (also covered per-property)
//       - `enum` narrowed (values removed)
//       - `multipleOf` added or made stricter
//   MINOR (additive): a new optional property was added; a new enum value was
//     added; a required property was relaxed to optional; a constraint was
//     LOOSENED (minLength down, maxLength up, additionalProperties false->true,
//     a pattern/format removed).
//   PATCH/NONE: description/example/annotation-only changes, or no change.

export type BumpLevel = 'none' | 'patch' | 'minor' | 'major';

export interface SchemaNode {
  readonly type?: string | string[];
  readonly enum?: readonly unknown[];
  readonly properties?: Record<string, SchemaNode>;
  readonly required?: readonly string[];
  readonly items?: SchemaNode;
  readonly version?: string;
  // Validation constraints whose tightening is breaking (P1-FINAL-HIGH-002).
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number | boolean;
  readonly exclusiveMaximum?: number | boolean;
  readonly multipleOf?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly additionalProperties?: boolean | SchemaNode;
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

  // Validation-constraint tightening (P1-FINAL-HIGH-002). A constraint change
  // that can newly REJECT data valid under the old schema is breaking (MAJOR);
  // a loosening is additive (MINOR).
  diffConstraints(prev, next, path, out);

  // Recurse into array items.
  if (prev.items && next.items) {
    diffNode(prev.items, next.items, `${path}[]`, out);
  }
}

// Numeric lower bound of a node, accounting for the JSON-Schema draft-4 boolean
// exclusiveMinimum form as well as the draft-6+ numeric form.
function lowerBound(n: SchemaNode): number | undefined {
  if (typeof n.exclusiveMinimum === 'number') return n.exclusiveMinimum;
  if (typeof n.minimum === 'number') return n.minimum;
  return undefined;
}
function upperBound(n: SchemaNode): number | undefined {
  if (typeof n.exclusiveMaximum === 'number') return n.exclusiveMaximum;
  if (typeof n.maximum === 'number') return n.maximum;
  return undefined;
}

// `additionalProperties` is "open" when it is true or absent (default true),
// and "closed" when it is false or an object subschema constraining extras.
function additionalPropsOpen(n: SchemaNode): boolean {
  const ap = n.additionalProperties;
  if (ap === undefined) return true;
  if (ap === true) return true;
  return false; // false or a subschema both restrict what was previously allowed
}

// Classify every constraint delta on a single node.
function diffConstraints(
  prev: SchemaNode,
  next: SchemaNode,
  path: string,
  out: CompatChange[],
): void {
  const p = path || '(root)';

  // minLength: increasing rejects previously-valid short strings (breaking).
  const pMinLen = prev.minLength ?? 0;
  const nMinLen = next.minLength ?? 0;
  if (nMinLen > pMinLen) {
    out.push({ level: 'major', path: p, reason: `minLength tightened ${pMinLen} -> ${nMinLen}` });
  } else if (nMinLen < pMinLen) {
    out.push({ level: 'minor', path: p, reason: `minLength relaxed ${pMinLen} -> ${nMinLen}` });
  }

  // maxLength: decreasing rejects previously-valid long strings (breaking).
  if (prev.maxLength !== undefined || next.maxLength !== undefined) {
    const pMax = prev.maxLength ?? Infinity;
    const nMax = next.maxLength ?? Infinity;
    if (nMax < pMax) {
      out.push({ level: 'major', path: p, reason: `maxLength tightened ${prev.maxLength ?? '∞'} -> ${next.maxLength ?? '∞'}` });
    } else if (nMax > pMax) {
      out.push({ level: 'minor', path: p, reason: `maxLength relaxed ${prev.maxLength ?? '∞'} -> ${next.maxLength ?? '∞'}` });
    }
  }

  // minItems: increasing rejects previously-valid short arrays (breaking).
  const pMinItems = prev.minItems ?? 0;
  const nMinItems = next.minItems ?? 0;
  if (nMinItems > pMinItems) {
    out.push({ level: 'major', path: p, reason: `minItems tightened ${pMinItems} -> ${nMinItems}` });
  } else if (nMinItems < pMinItems) {
    out.push({ level: 'minor', path: p, reason: `minItems relaxed ${pMinItems} -> ${nMinItems}` });
  }

  // maxItems: decreasing rejects previously-valid long arrays (breaking).
  if (prev.maxItems !== undefined || next.maxItems !== undefined) {
    const pMax = prev.maxItems ?? Infinity;
    const nMax = next.maxItems ?? Infinity;
    if (nMax < pMax) {
      out.push({ level: 'major', path: p, reason: `maxItems tightened ${prev.maxItems ?? '∞'} -> ${next.maxItems ?? '∞'}` });
    } else if (nMax > pMax) {
      out.push({ level: 'minor', path: p, reason: `maxItems relaxed ${prev.maxItems ?? '∞'} -> ${next.maxItems ?? '∞'}` });
    }
  }

  // minimum / exclusiveMinimum: raising the floor rejects previously-valid
  // smaller numbers (breaking); lowering it is additive.
  const pLo = lowerBound(prev);
  const nLo = lowerBound(next);
  if (pLo !== undefined || nLo !== undefined) {
    const pv = pLo ?? -Infinity;
    const nv = nLo ?? -Infinity;
    if (nv > pv) {
      out.push({ level: 'major', path: p, reason: `minimum tightened ${pLo ?? '-∞'} -> ${nLo ?? '-∞'}` });
    } else if (nv < pv) {
      out.push({ level: 'minor', path: p, reason: `minimum relaxed ${pLo ?? '-∞'} -> ${nLo ?? '-∞'}` });
    }
  }

  // maximum / exclusiveMaximum: lowering the ceiling rejects previously-valid
  // larger numbers (breaking); raising it is additive.
  const pHi = upperBound(prev);
  const nHi = upperBound(next);
  if (pHi !== undefined || nHi !== undefined) {
    const pv = pHi ?? Infinity;
    const nv = nHi ?? Infinity;
    if (nv < pv) {
      out.push({ level: 'major', path: p, reason: `maximum tightened ${pHi ?? '∞'} -> ${nHi ?? '∞'}` });
    } else if (nv > pv) {
      out.push({ level: 'minor', path: p, reason: `maximum relaxed ${pHi ?? '∞'} -> ${nHi ?? '∞'}` });
    }
  }

  // multipleOf: adding it, or increasing it (a coarser grid), rejects
  // previously-valid values (breaking). Removing/decreasing it is additive.
  if (prev.multipleOf !== next.multipleOf) {
    const had = typeof prev.multipleOf === 'number';
    const has = typeof next.multipleOf === 'number';
    if (has && !had) {
      out.push({ level: 'major', path: p, reason: `multipleOf added (${next.multipleOf})` });
    } else if (has && had && next.multipleOf! > prev.multipleOf!) {
      out.push({ level: 'major', path: p, reason: `multipleOf tightened ${prev.multipleOf} -> ${next.multipleOf}` });
    } else if (!has && had) {
      out.push({ level: 'minor', path: p, reason: `multipleOf removed (was ${prev.multipleOf})` });
    } else {
      out.push({ level: 'minor', path: p, reason: `multipleOf relaxed ${prev.multipleOf} -> ${next.multipleOf}` });
    }
  }

  // pattern: adding or changing a regex can reject previously-valid strings
  // (breaking). Removing it is additive.
  if ((prev.pattern ?? '') !== (next.pattern ?? '')) {
    if (next.pattern && !prev.pattern) {
      out.push({ level: 'major', path: p, reason: `pattern added (${next.pattern})` });
    } else if (next.pattern && prev.pattern) {
      out.push({ level: 'major', path: p, reason: `pattern changed ${prev.pattern} -> ${next.pattern}` });
    } else {
      out.push({ level: 'minor', path: p, reason: `pattern removed (was ${prev.pattern})` });
    }
  }

  // format: adding or changing a format assertion can reject previously-valid
  // strings (breaking). Removing it is additive.
  if ((prev.format ?? '') !== (next.format ?? '')) {
    if (next.format && !prev.format) {
      out.push({ level: 'major', path: p, reason: `format added (${next.format})` });
    } else if (next.format && prev.format) {
      out.push({ level: 'major', path: p, reason: `format changed ${prev.format} -> ${next.format}` });
    } else {
      out.push({ level: 'minor', path: p, reason: `format removed (was ${prev.format})` });
    }
  }

  // additionalProperties: open -> closed rejects previously-valid objects that
  // carried extra keys (breaking). closed -> open is additive.
  const pOpen = additionalPropsOpen(prev);
  const nOpen = additionalPropsOpen(next);
  if (pOpen && !nOpen) {
    out.push({ level: 'major', path: p, reason: 'additionalProperties tightened (open -> closed)' });
  } else if (!pOpen && nOpen) {
    out.push({ level: 'minor', path: p, reason: 'additionalProperties relaxed (closed -> open)' });
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

/** Ordered comparison of two semvers: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareSemver(prev: string, next: string): number {
  const a = parseSemver(prev);
  const b = parseSemver(next);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * The actual FORWARD bump between two semvers (major > minor > patch > none).
 *
 * A bump must move the version UP. A downgrade (next < prev at any segment) or
 * no change is `none` — it never satisfies a required bump (P1-CYCLE3-HIGH-001).
 * The earlier version returned `major` for ANY major inequality, so a breaking
 * change could pass by DOWNGRADING 1.0.0 -> 0.0.0: the classifier saw a "major
 * difference" and treated it as a major bump.
 */
export function actualBump(prev: string, next: string): BumpLevel {
  // Non-increasing version = no forward bump at all.
  if (compareSemver(prev, next) >= 0) return 'none';
  const a = parseSemver(prev);
  const b = parseSemver(next);
  if (b.major > a.major) return 'major';
  if (b.minor > a.minor) return 'minor';
  return 'patch';
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
  const cmp = compareSemver(prevV, nextV);

  // A change that requires ANY bump must be accompanied by a strictly-increasing
  // version. A non-increasing version (downgrade or unchanged) can never satisfy
  // a required bump (P1-CYCLE3-HIGH-001): the earlier code let a breaking change
  // pass by DOWNGRADING 1.0.0 -> 0.0.0 because a "major difference" was read as a
  // major bump. We reject that explicitly with a dedicated message so the reason
  // is unambiguous, then fall back to the bump-magnitude comparison.
  if (required !== 'none' && cmp >= 0) {
    return {
      ok: false,
      requiredBump: required,
      actualBump: actual,
      changes,
      message:
        `INCOMPATIBLE: changes require a ${required} bump but version was NOT increased ` +
        `(${prevV} -> ${nextV}); a downgrade or unchanged version cannot satisfy a required bump`,
    };
  }

  const ok = ORDER[actual] >= ORDER[required];
  const message = ok
    ? `compatible: changes require ${required}, version bump was ${actual}`
    : `INCOMPATIBLE: changes require a ${required} bump but version went ${prevV} -> ${nextV} (${actual})`;
  return { ok, requiredBump: required, actualBump: actual, changes, message };
}
