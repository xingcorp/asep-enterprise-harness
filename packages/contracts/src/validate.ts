// Runtime schema validation for the canonical ASEP contracts: the 13 platform
// contracts and the five review contracts of independent assurance.
//
// JSON Schema (schema/*.schema.json) is the single source of truth. This module
// compiles those schemas once with Ajv (2020-12 dialect) and exposes a small,
// dependency-injected validation surface. The generated TS types in
// ./generated.ts are the compile-time projection of the same schemas; this
// module is the run-time projection. Both derive from one source, so they
// cannot drift without the drift-guard test (src/drift.test.ts) failing.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020Ns from 'ajv/dist/2020.js';
import addFormatsNs from 'ajv-formats';

// ajv / ajv-formats ship CJS with a nested default under NodeNext ESM interop.
// Unwrap defensively so this works regardless of how the loader presents them.
type AjvCtor = new (opts?: Record<string, unknown>) => AjvInstance;
interface AjvInstance {
  compile(schema: unknown): ValidateFn;
  addSchema(schema: unknown, key?: string): void;
}
interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown[] | null;
}
type AddFormatsFn = (ajv: AjvInstance) => unknown;

const Ajv2020 = ((Ajv2020Ns as unknown as { default?: AjvCtor }).default ??
  Ajv2020Ns) as unknown as AjvCtor;
const addFormats = ((addFormatsNs as unknown as { default?: AddFormatsFn }).default ??
  addFormatsNs) as unknown as AddFormatsFn;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schema');

export interface ValidationError {
  readonly instancePath: string;
  readonly message: string;
  readonly keyword: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

/** The canonical contract names, matching schema $id path segments. */
export type ContractName =
  | 'product-spec'
  | 'requirement'
  | 'acceptance-scenario'
  | 'architecture-invariant'
  | 'work-order'
  | 'context-pack'
  | 'evidence-bundle'
  | 'review-report'
  | 'finding'
  | 'verification-plan'
  | 'run-event'
  | 'skill-manifest'
  | 'execution-envelope'
  | 'review-finding'
  | 'review-record'
  | 'review-packet'
  | 'adjudication-record'
  | 'repair-order';

interface RawSchema {
  $id: string;
  title: string;
  version: string;
}

function buildAjv(): { ajv: AjvInstance; schemas: Map<string, RawSchema> } {
  // strict:false so the custom `version` and `x-tsType` annotations do not
  // trigger strict-mode errors. Structural validation remains fully enforced.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const schemas = new Map<string, RawSchema>();
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();

  // Register every schema first so cross-schema $ref resolves by $id.
  const raws: RawSchema[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as RawSchema;
    ajv.addSchema(raw, raw.$id);
    raws.push(raw);
  }
  for (const raw of raws) {
    // key by contract name derived from $id: https://asep.dev/schema/<name>/v1
    const name = raw.$id.split('/').slice(-2, -1)[0]!;
    schemas.set(name, raw);
  }
  return { ajv, schemas };
}

const { ajv, schemas } = buildAjv();
const validators = new Map<string, ValidateFn>();

function validatorFor(name: ContractName): ValidateFn {
  const cached = validators.get(name);
  if (cached) return cached;
  const raw = schemas.get(name);
  if (!raw) throw new Error(`validate: unknown contract "${name}"`);
  const fn = ajv.compile(raw);
  validators.set(name, fn);
  return fn;
}

function toErrors(raw: unknown[] | null | undefined): ValidationError[] {
  if (!raw) return [];
  return raw.map((e) => {
    const o = e as { instancePath?: string; message?: string; keyword?: string };
    return {
      instancePath: o.instancePath ?? '',
      message: o.message ?? 'invalid',
      keyword: o.keyword ?? 'unknown',
    };
  });
}

/** Validate `data` against a named contract schema. Never throws on invalid input. */
export function validate(name: ContractName, data: unknown): ValidationResult {
  const fn = validatorFor(name);
  const valid = fn(data);
  return { valid, errors: valid ? [] : toErrors(fn.errors) };
}

/** Validate and throw a descriptive error if invalid. Returns `data` typed as T. */
export function assertValid<T>(name: ContractName, data: unknown): T {
  const result = validate(name, data);
  if (!result.valid) {
    const detail = result.errors
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new Error(`contract "${name}" validation failed: ${detail}`);
  }
  return data as T;
}

/** All contract names known to the validator (sorted, deterministic). */
export function contractNames(): ContractName[] {
  return [...schemas.keys()].sort() as ContractName[];
}

/** The declared semver `version` of a contract schema. */
export function contractVersion(name: ContractName): string {
  const raw = schemas.get(name);
  if (!raw) throw new Error(`validate: unknown contract "${name}"`);
  return raw.version;
}
