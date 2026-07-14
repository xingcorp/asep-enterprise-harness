// Deterministic JSON-Schema -> TypeScript contract generator.
//
// The 12 canonical contracts under packages/contracts/schema/*.schema.json are
// the single source of truth. This generator derives ../generated.ts from them.
// It is intentionally dependency-free (no json-schema-to-typescript) so the
// output is fully deterministic and the drift-guard test can regenerate the
// file in-memory and assert a byte-for-byte match against the committed copy.
//
// Supported subset (sufficient for the ASEP contracts):
//   - type: object (additionalProperties:false) -> interface / inline object
//   - type: string  (+ enum -> string-literal union)
//   - type: integer | number -> number
//   - type: boolean -> boolean
//   - type: array   -> readonly T[]
//   - type: [X, "null"] -> (X | null)
//   - $ref to a sibling schema -> that schema's title type
//   - x-tsType override (on a property or on array items) -> named import from ./base.js
//
// Regenerate with: pnpm --filter @asep/contracts gen:types

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', '..', 'schema');
const OUT_FILE = join(HERE, '..', 'generated.ts');

interface JsonSchema {
  $id?: string;
  title?: string;
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  $ref?: string;
  additionalProperties?: boolean;
  description?: string;
  'x-tsType'?: string;
}

// Names exported by ./base.ts that generated code may import.
const BASE_EXPORTS = new Set([
  'ProjectId', 'RunId', 'MilestoneId', 'TaskId', 'AttemptId', 'ArtifactId',
  'RiskLevel', 'RunStatus', 'SkillRef', 'Budget',
]);

function loadSchemas(): { file: string; schema: JsonSchema }[] {
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort(); // deterministic order
  return files.map((file) => ({
    file,
    schema: JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as JsonSchema,
  }));
}

// Map $id -> title so $ref can resolve to the generated interface name.
function buildRefIndex(schemas: { schema: JsonSchema }[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const { schema } of schemas) {
    if (schema.$id && schema.title) idx.set(schema.$id, schema.title);
  }
  return idx;
}

const imports = new Set<string>();

function noteImport(name: string): void {
  if (BASE_EXPORTS.has(name)) imports.add(name);
}

function refName(ref: string, refIndex: Map<string, string>): string {
  const name = refIndex.get(ref);
  if (!name) throw new Error(`generate-types: unresolved $ref ${ref}`);
  return name;
}

// Render a property/items schema to a TS type expression.
function renderType(
  s: JsonSchema,
  refIndex: Map<string, string>,
  indent: string,
): string {
  const xt = s['x-tsType'];
  if (xt) {
    noteImport(xt);
    return xt;
  }
  if (s.$ref) {
    return refName(s.$ref, refIndex);
  }
  if (s.enum) {
    return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  }
  const t = s.type;
  if (Array.isArray(t)) {
    // e.g. ["string", "null"]
    const parts = t.map((tt) => scalar(tt));
    return parts.join(' | ');
  }
  switch (t) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const item = s.items ?? {};
      const inner = renderType(item, refIndex, indent);
      // Parenthesize unions inside arrays for correctness.
      const needsParens = inner.includes('|');
      return `readonly ${needsParens ? `(${inner})` : inner}[]`;
    }
    case 'object':
      return renderObject(s, refIndex, indent);
    default:
      return 'unknown';
  }
}

function scalar(t: string): string {
  switch (t) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    default: return 'unknown';
  }
}

// Render an inline object literal type (nested, anonymous).
function renderObject(
  s: JsonSchema,
  refIndex: Map<string, string>,
  indent: string,
): string {
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const keys = Object.keys(props); // preserve schema order
  const inner = indent + '  ';
  const lines = keys.map((key) => {
    const optional = required.has(key) ? '' : '?';
    const type = renderType(props[key]!, refIndex, inner);
    return `${inner}readonly ${key}${optional}: ${type};`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

function renderInterface(s: JsonSchema, refIndex: Map<string, string>): string {
  const title = s.title!;
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const keys = Object.keys(props);
  const lines = keys.map((key) => {
    const optional = required.has(key) ? '' : '?';
    const type = renderType(props[key]!, refIndex, '');
    return `  readonly ${key}${optional}: ${type};`;
  });
  const doc = s.description ? `/** ${s.description} */\n` : '';
  return `${doc}export interface ${title} {\n${lines.join('\n')}\n}`;
}

export function generateTypes(): string {
  imports.clear();
  const schemas = loadSchemas();
  const refIndex = buildRefIndex(schemas);

  // Render interfaces first (this populates `imports` via renderType).
  const bodies = schemas.map(({ schema }) => renderInterface(schema, refIndex));

  const importList = [...imports].sort();
  const importLine = importList.length
    ? `import type { ${importList.join(', ')} } from './base.js';\n\n`
    : '';

  const header =
    '// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.\n' +
    '// Source of truth: packages/contracts/schema/*.schema.json\n' +
    '// Regenerate with: pnpm --filter @asep/contracts gen:types\n' +
    '// The drift-guard test (src/drift.test.ts) fails if this file is stale.\n\n';

  return header + importLine + bodies.join('\n\n') + '\n';
}

// CLI entry: write the file when executed directly.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const out = generateTypes();
  writeFileSync(OUT_FILE, out, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`generated ${OUT_FILE} (${out.length} bytes)`);
}
