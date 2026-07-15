// Structural parity guard for x-tsType overrides (P1-FINAL-HIGH-001).
//
// The generator (gen/generate-types.ts) emits an `x-tsType` override verbatim as
// a named import from ./base.ts. That means a value-object override (RiskLevel,
// SkillRef, Budget) or a branded id (TaskId, RunId, ...) bypasses the structural
// generation path entirely: the JSON Schema could drift away from the
// hand-authored base.ts type and the byte-identical drift guard would NOT catch
// it, because generated.ts only ever names the base type.
//
// This module closes that hole. It declares the EXPECTED structure of every base
// export that may back an x-tsType, derived from base.ts, and a checker that
// asserts each schema subschema carrying that override still matches. The parity
// test fails if:
//   - a schema mutates an enum/object that an x-tsType names (RiskLevel enum
//     changes, Budget gains/loses a required field, SkillRef property type
//     changes), OR
//   - an x-tsType override names something with no registered descriptor and no
//     matching $ref (unchecked override — forbidden).
//
// To make a legitimate structural change you must edit BOTH the schema AND the
// descriptor here AND base.ts — the three are locked together on purpose.

export type BaseKind =
  | { readonly kind: 'brand'; readonly base: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | {
      readonly kind: 'object';
      readonly properties: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
      readonly required: readonly string[];
    };

// Expected structure of each base export, mirroring packages/contracts/src/base.ts.
// Keep this in lockstep with base.ts: the parity test is the enforcement.
export const EXPECTED_BASE_STRUCTURE: Readonly<Record<string, BaseKind>> = {
  // Branded string identifiers.
  ProjectId: { kind: 'brand', base: 'string' },
  RunId: { kind: 'brand', base: 'string' },
  MilestoneId: { kind: 'brand', base: 'string' },
  TaskId: { kind: 'brand', base: 'string' },
  AttemptId: { kind: 'brand', base: 'string' },
  ArtifactId: { kind: 'brand', base: 'string' },
  // Lifecycle / risk enums.
  RiskLevel: { kind: 'enum', values: ['R0', 'R1', 'R2', 'R3', 'R4'] },
  RunStatus: {
    kind: 'enum',
    values: [
      'DRAFT', 'DISCOVERY', 'SPECIFICATION_REVIEW', 'ARCHITECTURE_REVIEW',
      'PLANNING', 'READY', 'EXECUTING', 'VERIFYING', 'INDEPENDENT_REVIEW',
      'REPAIRING', 'INTEGRATING', 'PRODUCT_ACCEPTANCE', 'RELEASE_REHEARSAL',
      'WAITING_FOR_APPROVAL', 'PAUSED', 'BLOCKED', 'FAILED', 'CANCELLED', 'DONE',
    ],
  },
  // Shared value objects.
  SkillRef: {
    kind: 'object',
    properties: { id: 'string', version: 'string' },
    required: ['id', 'version'],
  },
  Budget: {
    kind: 'object',
    properties: {
      maxTurns: 'number',
      maxToolCalls: 'number',
      maxCostUsd: 'number',
      maxWallClockMinutes: 'number',
    },
    required: ['maxTurns', 'maxToolCalls', 'maxCostUsd', 'maxWallClockMinutes'],
  },
};

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

// Check one override site against the base-structure registry. `refTitles` maps
// $id -> title so a $ref+x-tsType override (naming a generated contract type)
// can be validated to actually equal the referenced schema title.
// Returns null if the site is valid, or an error message describing the drift.
export function checkOverride(
  site: OverrideSite,
  refTitles: ReadonlyMap<string, string>,
): string | null {
  const { typeName, pointer, node } = site;
  const expected = EXPECTED_BASE_STRUCTURE[typeName];

  if (!expected) {
    // Not a base value object. It must be a $ref override whose name matches the
    // referenced contract title — otherwise it is an unchecked override.
    if (node.$ref) {
      const title = refTitles.get(node.$ref);
      if (title === typeName) return null;
      return `${pointer}: x-tsType "${typeName}" does not match $ref target title "${title ?? '<unresolved>'}" (${node.$ref})`;
    }
    return `${pointer}: x-tsType "${typeName}" has no registered base-structure descriptor and no $ref backing (unchecked override — forbidden)`;
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
