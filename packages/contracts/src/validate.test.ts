// Contract validation test: every valid fixture MUST be accepted and every
// invalid fixture MUST be rejected with at least one real error. This proves
// the ajv validator does not silently swallow malformed input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, contractNames, type ContractName } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures');

// Map a fixture file name to its contract by longest matching contract prefix.
// e.g. "acceptance-scenario-basic.json" -> "acceptance-scenario".
function contractOf(file: string): ContractName {
  const base = file.replace(/\.json$/, '');
  const names = contractNames();
  const matches = names
    .filter((n) => base === n || base.startsWith(`${n}-`))
    .sort((a, b) => b.length - a.length);
  const found = matches[0];
  if (!found) throw new Error(`no contract matches fixture "${file}"`);
  return found;
}

function load(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(FIX, dir, file), 'utf8'));
}

test('every valid fixture is accepted', () => {
  const files = readdirSync(join(FIX, 'valid')).filter((f) => f.endsWith('.json')).sort();
  assert.ok(files.length >= 12, `expected >=12 valid fixtures, got ${files.length}`);
  for (const file of files) {
    const name = contractOf(file);
    const result = validate(name, load('valid', file));
    assert.equal(result.valid, true, `valid/${file} (${name}) rejected: ${JSON.stringify(result.errors)}`);
    assert.equal(result.errors.length, 0, `valid/${file} produced errors`);
  }
});

test('every invalid fixture is rejected with a real error', () => {
  const files = readdirSync(join(FIX, 'invalid')).filter((f) => f.endsWith('.json')).sort();
  assert.ok(files.length >= 12, `expected >=12 invalid fixtures, got ${files.length}`);
  for (const file of files) {
    const name = contractOf(file);
    const result = validate(name, load('invalid', file));
    assert.equal(result.valid, false, `invalid/${file} (${name}) was accepted but should be rejected`);
    assert.ok(result.errors.length > 0, `invalid/${file} rejected without any error detail`);
  }
});

test('every contract has at least one valid and one invalid fixture', () => {
  const valid = readdirSync(join(FIX, 'valid')).filter((f) => f.endsWith('.json'));
  const invalid = readdirSync(join(FIX, 'invalid')).filter((f) => f.endsWith('.json'));
  for (const name of contractNames()) {
    assert.ok(
      valid.some((f) => contractOf(f) === name),
      `contract "${name}" has no valid fixture`,
    );
    assert.ok(
      invalid.some((f) => contractOf(f) === name),
      `contract "${name}" has no invalid fixture`,
    );
  }
});

test('schema examples validate against their own schema', () => {
  // Each schema ships an `examples` array; every example must be self-consistent.
  const schemaDir = join(HERE, '..', 'schema');
  const files = readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json')).sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as {
      $id: string;
      examples?: unknown[];
    };
    const name = raw.$id.split('/').slice(-2, -1)[0] as ContractName;
    for (const [i, example] of (raw.examples ?? []).entries()) {
      const result = validate(name, example);
      assert.equal(
        result.valid,
        true,
        `${file} example[${i}] invalid: ${JSON.stringify(result.errors)}`,
      );
    }
  }
});
