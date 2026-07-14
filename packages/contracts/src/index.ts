// Public surface of @asep/contracts.
//
// The 12 canonical platform contracts are GENERATED from the JSON Schemas under
// schema/*.schema.json (the single source of truth) into ./generated.ts, and
// re-exported here. Branded identifiers, lifecycle enums, shared value objects
// and the internal execution shapes are hand-authored in ./base.ts.
//
// Runtime schema validation lives in ./validate.ts (ajv-backed). A drift-guard
// test (./drift.test.ts) fails if ./generated.ts is stale relative to the
// schemas, guaranteeing the TypeScript types and JSON Schemas cannot diverge.

export * from './base.js';
export * from './generated.js';

// Runtime validation surface (ajv-backed, single source = schema/*.schema.json).
export {
  validate,
  assertValid,
  contractNames,
  contractVersion,
} from './validate.js';
export type { ContractName, ValidationError, ValidationResult } from './validate.js';

// Backwards-compatible alias: the canonical review finding contract is `Finding`.
export type { Finding as ReviewFinding } from './generated.js';
