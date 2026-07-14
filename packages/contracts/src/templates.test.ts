// Template validation (Codex P1-HIGH-001): the YAML templates under templates/
// are the human-facing authoring examples. They MUST validate against the same
// canonical schemas as everything else, so they cannot drift into a different
// (e.g. nested-envelope) shape from the flat contract source of truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validate, type ContractName } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, '..', '..', '..', 'templates');

// Map each template file to the contract it should satisfy.
const TEMPLATE_CONTRACTS: ReadonlyArray<readonly [string, ContractName]> = [
  ['work-order.yaml', 'work-order'],
  ['context-pack.yaml', 'context-pack'],
  ['evidence-bundle.yaml', 'evidence-bundle'],
  ['review-report.yaml', 'review-report'],
  ['product-spec.yaml', 'product-spec'],
  ['skill-manifest.yaml', 'skill-manifest'],
];

for (const [file, contract] of TEMPLATE_CONTRACTS) {
  test(`template ${file} validates against ${contract} schema`, () => {
    const raw = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
    const doc = parseYaml(raw) as unknown;
    const result = validate(contract, doc);
    assert.equal(
      result.valid,
      true,
      `${file} failed ${contract} validation: ${JSON.stringify(result.errors)}`,
    );
  });
}
