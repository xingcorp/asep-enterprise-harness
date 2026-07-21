// Structural parity guard for x-tsType overrides (P1-FINAL-HIGH-001).
//
// The generator (gen/generate-types.ts) emits an `x-tsType` override verbatim as
// a named import from ./base.ts. That means a value-object override (RiskLevel,
// SkillRef, Budget) or a branded id (TaskId, RunId, ...) bypasses the structural
// generation path entirely: the JSON Schema could drift away from the
// hand-authored base.ts type and the byte-identical drift guard would NOT catch
// it, because generated.ts only ever names the base type.
//
// This module closes that hole. The expected structure of every base export
// that may back an x-tsType is EXTRACTED DIRECTLY FROM base.ts at check time
// (parseBaseStructure) — there is no hand-maintained shadow table to keep in
// sync. A checker then asserts each schema subschema carrying an override still
// matches the type as it is actually declared in base.ts. The parity check
// fails if:
//   - a schema mutates an enum/object that an x-tsType names (RiskLevel enum
//     changes, Budget gains/loses a required field, SkillRef property type
//     changes) WITHOUT the same change landing in base.ts, OR
//   - an x-tsType override names something with no descriptor in base.ts and no
//     matching $ref (unchecked override — forbidden).
//
// Because the expected shape is derived from base.ts source, adding (say) an R5
// enum member to a schema WITHOUT also editing base.ts is caught; the two are
// locked together through the source of truth, not a manually duplicated copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type BaseKind =
  | { readonly kind: 'brand'; readonly base: 'string' | 'number' | 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | {
      readonly kind: 'object';
      readonly properties: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
      readonly required: readonly string[];
    };

export type BaseStructure = Readonly<Record<string, BaseKind>>;

// --- base.ts source extraction (P1-FINAL-HIGH-001) ---------------------------
//
// We parse the small, controlled subset of TypeScript that base.ts uses to
// declare the value objects an x-tsType override can name:
//   - branded ids:  export type ProjectId = Brand<string, 'ProjectId'>;
//   - string-union enums:  export type RiskLevel = 'R0' | 'R1' | ...;
//   - scalar interfaces:  export interface Budget { readonly maxTurns: number; ... }
// This is not a general TypeScript parser — it deliberately only recognises the
// shapes base.ts actually uses, and skips anything it cannot classify as a
// scalar value object (e.g. AgentAttemptResult, which is never an x-tsType
// target). Skipping a type simply means "no descriptor": an x-tsType naming it
// without a $ref backing is then reported as an unchecked override.

function stripComments(src: string): string {
  // Remove block comments then line comments. base.ts contains no strings that
  // embed `//` or `/*`, so this is safe for this controlled input.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function scalarOf(tsType: string): 'string' | 'number' | 'boolean' | null {
  const t = tsType.trim();
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return null;
}

/**
 * Parse the value-object descriptors out of base.ts SOURCE. This is the single
 * source of truth for the parity guard: it reads the same TypeScript the
 * runtime imports, so a schema change that is not mirrored in base.ts is
 * detected as drift.
 */
export function parseBaseStructure(source: string): BaseStructure {
  const src = stripComments(source);
  const out: Record<string, BaseKind> = {};

  // 1. Type aliases: `export type NAME = BODY;` (NAME has no generic params, so
  //    the generic `Brand<T, Name>` definition itself is skipped).
  const typeRe = /export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?);/g;
  let tm: RegExpExecArray | null;
  while ((tm = typeRe.exec(src)) !== null) {
    const name = tm[1]!;
    const body = tm[2]!.trim();

    // Branded id:  Brand<string, 'Name'>
    const brand = /^Brand<\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*['"][^'"]+['"]\s*>$/.exec(body);
    if (brand) {
      const base = scalarOf(brand[1]!);
      if (base) out[name] = { kind: 'brand', base };
      continue;
    }

    // String-union enum:  'A' | 'B' | 'C'  (every member a string literal).
    const parts = body.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => /^['"][^'"]*['"]$/.test(p))) {
      const values = parts.map((p) => p.slice(1, -1));
      out[name] = { kind: 'enum', values };
      continue;
    }
    // Anything else (object-literal alias, intersection, etc.) is not a guarded
    // value object — skip it.
  }

  // 2. Interfaces: `export interface NAME { BODY }` with only scalar members.
  const ifaceRe = /export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
  let im: RegExpExecArray | null;
  while ((im = ifaceRe.exec(src)) !== null) {
    const name = im[1]!;
    const body = im[2]!;
    const properties: Record<string, 'string' | 'number' | 'boolean'> = {};
    const required: string[] = [];
    let allScalar = true;

    // members: `readonly? name?: type;`
    const memberRe = /(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\??)\s*:\s*([^;]+);/g;
    let mm: RegExpExecArray | null;
    let memberCount = 0;
    while ((mm = memberRe.exec(body)) !== null) {
      memberCount++;
      const prop = mm[1]!;
      const optional = mm[2] === '?';
      const scalar = scalarOf(mm[3]!);
      if (!scalar) {
        allScalar = false;
        break;
      }
      properties[prop] = scalar;
      if (!optional) required.push(prop);
    }

    // Only register interfaces that are pure scalar value objects; others
    // (AgentAttemptResult, VerificationResult, ...) are never x-tsType targets.
    if (allScalar && memberCount > 0) {
      out[name] = { kind: 'object', properties, required };
    }
  }

  return out;
}

function defaultBaseTsPath(): string {
  // base.ts sits next to this module.
  return join(dirname(fileURLToPath(import.meta.url)), 'base.ts');
}

let cached: BaseStructure | null = null;

/**
 * Load and cache the base-structure descriptors extracted from base.ts on disk.
 * Pass an explicit path to read a different source (used by tests that feed a
 * mutated base.ts to prove the expected values come from source, not a table).
 */
export function loadBaseStructure(baseTsPath?: string): BaseStructure {
  if (baseTsPath) {
    return parseBaseStructure(readFileSync(baseTsPath, 'utf8'));
  }
  if (!cached) {
    cached = parseBaseStructure(readFileSync(defaultBaseTsPath(), 'utf8'));
  }
  return cached;
}

export interface OverrideSite {
  readonly typeName: string;
  readonly pointer: string; // JSON-pointer-ish location for diagnostics
  readonly node: SubSchema;
}

export interface SubSchema {
  type?: string | string[];
  enum?: readonly unknown[];
  properties?: Record<string, SubSchema>;
  required?: readonly string[];
  items?: SubSchema;
  $ref?: string;
  'x-tsType'?: string;
  [k: string]: unknown;
}

// Recursively collect every subschema that carries an x-tsType override.
export function collectOverrides(schema: SubSchema, base = '#'): OverrideSite[] {
  const out: OverrideSite[] = [];
  const walk = (node: SubSchema | undefined, pointer: string): void => {
    if (!node || typeof node !== 'object') return;
    const xt = node['x-tsType'];
    if (typeof xt === 'string') {
      out.push({ typeName: xt, pointer, node });
    }
    if (node.properties) {
      for (const [k, v] of Object.entries(node.properties)) {
        walk(v, `${pointer}/properties/${k}`);
      }
    }
    if (node.items) walk(node.items, `${pointer}/items`);
  };
  walk(schema, base);
  return out;
}

function scalarType(node: SubSchema): string | undefined {
  const t = node.type;
  if (t === 'integer') return 'number';
  if (typeof t === 'string') return t;
  return undefined;
}

// Check one override site against the base-structure registry derived from
// base.ts. `refTitles` maps $id -> title so a $ref+x-tsType override (naming a
// generated contract type) can be validated to actually equal the referenced
// schema title. `structure` defaults to the descriptors parsed from base.ts on
// disk. Returns null if the site is valid, or an error message describing drift.
export function checkOverride(
  site: OverrideSite,
  refTitles: ReadonlyMap<string, string>,
  structure: BaseStructure = loadBaseStructure(),
): string | null {
  const { typeName, pointer, node } = site;
  const expected = structure[typeName];

  if (!expected) {
    // Not a base value object. It must be a $ref override whose name matches the
    // referenced contract title — otherwise it is an unchecked override.
    if (node.$ref) {
      const title = refTitles.get(node.$ref);
      if (title === typeName) return null;
      return `${pointer}: x-tsType "${typeName}" does not match $ref target title "${title ?? '<unresolved>'}" (${node.$ref})`;
    }
    return `${pointer}: x-tsType "${typeName}" has no descriptor in base.ts and no $ref backing (unchecked override — forbidden)`;
  }

  switch (expected.kind) {
    case 'brand': {
      const st = scalarType(node);
      if (st !== expected.base) {
        return `${pointer}: x-tsType "${typeName}" expects schema type "${expected.base}" but schema is "${st ?? JSON.stringify(node.type)}"`;
      }
      return null;
    }
    case 'enum': {
      if (!Array.isArray(node.enum)) {
        return `${pointer}: x-tsType "${typeName}" is an enum type but schema has no "enum"`;
      }
      const got = [...node.enum].map((v) => String(v)).sort();
      const want = [...expected.values].sort();
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
        return `${pointer}: x-tsType "${typeName}" enum drift — schema=[${got.join(',')}] base=[${want.join(',')}]`;
      }
      return null;
    }
    case 'object': {
      const props = node.properties ?? {};
      const gotKeys = Object.keys(props).sort();
      const wantKeys = Object.keys(expected.properties).sort();
      if (gotKeys.length !== wantKeys.length || gotKeys.some((k, i) => k !== wantKeys[i])) {
        return `${pointer}: x-tsType "${typeName}" property-set drift — schema={${gotKeys.join(',')}} base={${wantKeys.join(',')}}`;
      }
      for (const k of wantKeys) {
        const st = scalarType(props[k]!);
        const want = expected.properties[k];
        if (st !== want) {
          return `${pointer}: x-tsType "${typeName}" property "${k}" type drift — schema="${st ?? 'unknown'}" base="${want}"`;
        }
      }
      const gotReq = [...(node.required ?? [])].map(String).sort();
      const wantReq = [...expected.required].sort();
      if (gotReq.length !== wantReq.length || gotReq.some((v, i) => v !== wantReq[i])) {
        return `${pointer}: x-tsType "${typeName}" required-set drift — schema=[${gotReq.join(',')}] base=[${wantReq.join(',')}]`;
      }
      return null;
    }
  }
}
