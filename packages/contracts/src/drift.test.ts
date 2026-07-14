// Drift guard (Codex P1-CHANGE-002): the generated TypeScript contract types
// MUST stay byte-identical to a fresh regeneration from the JSON Schemas. If a
// schema is edited without running `pnpm --filter @asep/contracts gen:types`,
// this test fails, so the compile-time types cannot silently diverge from the
// single source of truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateTypes } from './gen/generate-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, 'generated.ts');

test('generated.ts is byte-identical to a fresh regeneration', () => {
  const onDisk = readFileSync(GENERATED, 'utf8');
  const fresh = generateTypes();
  assert.equal(
    onDisk,
    fresh,
    'packages/contracts/src/generated.ts is stale. Run: pnpm --filter @asep/contracts gen:types',
  );
});
