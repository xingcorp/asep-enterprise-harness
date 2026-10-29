// TypeScript fitness guard suite (exit criteria E8/G3).
//
// Runs scripts/lib/ts-guard.mjs over the real repository — which must be
// clean — and over fixtures that try each evasion a regex misses: an alias, a
// constant-folded computed property name, an object spread, and the rest of
// the shapes the guard closes. Fixtures are VIRTUAL files placed inside a real
// project (apps/control-plane-api), so they type-check against the real
// @asep/ports and @asep/command-runner types and nothing touches the disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — .mjs helpers have no type declarations; we test their runtime contract.
import { runGuard, isShippedSource, CLAIM_ALLOWED_FILES } from './lib/ts-guard.mjs';

console.log('SUITE-ID: asep-suite:ts-guard');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = 'apps/control-plane-api/src';

interface Violation { rule: string; file: string; line: number; message: string }

// Check virtual files (name → source) and return their violations.
function check(files: Record<string, string>, rule?: string): Violation[] {
  const overlay = Object.fromEntries(
    Object.entries(files).map(([name, src]) => [join(ROOT, FIXTURE_DIR, name), src]),
  );
  const rels = new Set(Object.keys(files).map((name) => `${FIXTURE_DIR}/${name}`));
  const { violations } = runGuard({
    root: ROOT,
    overlay,
    include: (rel: string) => rels.has(rel),
    projects: [join(ROOT, 'apps/control-plane-api/tsconfig.json')],
  }) as { violations: Violation[] };
  return rule ? violations.filter((v) => v.rule === rule) : violations;
}

const HANDLE_IMPORTS = `import type { SandboxHandle, SandboxProvider } from '@asep/ports';
import type { SandboxHandleEx } from '@asep/command-runner';
`;

test('the shipped source passes every rule', () => {
  const { violations, filesChecked } = runGuard({ root: ROOT }) as { violations: Violation[]; filesChecked: number };
  assert.ok(filesChecked > 50, `the guard checked only ${filesChecked} files — discovery is broken`);
  assert.deepEqual(violations, [], violations.map((v) => `${v.file}:${v.line} ${v.rule}: ${v.message}`).join('\n'));
});

test('the Docker sandbox provider is the one claim site, and the guard sees its claim', () => {
  assert.deepEqual([...CLAIM_ALLOWED_FILES], ['adapters/command-runner/src/sandbox.ts']);
  const rel = 'adapters/command-runner/src/sandbox.ts';
  const { violations } = runGuard({
    root: ROOT,
    include: (r: string) => r === rel,
    projects: [join(ROOT, 'adapters/command-runner/tsconfig.json')],
    claimAllowed: [],
  }) as { violations: Violation[] };
  const claimLine = readFileSync(join(ROOT, rel), 'utf8').split('\n')
    .findIndex((l) => /^\s+isolationEnforced: true,/.test(l)) + 1;
  assert.ok(claimLine > 0);
  assert.ok(
    violations.some((v) => v.rule === 'isolation-claim' && v.line <= claimLine && v.line >= claimLine - 10),
    `without the allowlist the provider's own claim is flagged: ${JSON.stringify(violations)}`,
  );
});

test('shipped-source selection excludes tests and live proofs', () => {
  assert.equal(isShippedSource('apps/control-plane-api/src/vertical-slice.ts'), true);
  assert.equal(isShippedSource('adapters/agent-claude/src/claude-live.live.ts'), false);
  assert.equal(isShippedSource('apps/control-plane-api/src/app.test.ts'), false);
  assert.equal(isShippedSource('adapters/agent-claude/src/agent-sandbox.itest.ts'), false);
  assert.equal(isShippedSource('scripts/lib/ts-guard.mjs'), false);
});

// --- the three evasions the review named ---------------------------------------

test('evasion: an ALIAS for the claim value is caught', () => {
  const v = check({
    'guard-fixture-alias.ts': `${HANDLE_IMPORTS}
const yes = true;
const alsoYes = yes;
export const h: SandboxHandle = { sandboxId: 's', profile: 'p', isolationEnforced: alsoYes };
`,
  }, 'isolation-claim');
  assert.ok(v.some((x) => x.line === 6), JSON.stringify(v));
});

test('evasion: a COMPUTED property name — folded, aliased, or unresolvable — is caught', () => {
  const v = check({
    'guard-fixture-computed.ts': `${HANDLE_IMPORTS}
const head = 'isolation';
const key = head + 'Enforced';
export const folded = { sandboxId: 's', profile: 'p', [key]: true } as SandboxHandle;
export const templated: SandboxHandle = { sandboxId: 's', profile: 'p', [\`\${head}Enforced\`]: true };
export function unresolvable(k: string): SandboxHandle {
  return { sandboxId: 's', profile: 'p', [k]: true };
}
`,
  }, 'isolation-claim');
  for (const line of [6, 7, 9]) {
    assert.ok(v.some((x) => x.line === line), `line ${line} must be flagged: ${JSON.stringify(v)}`);
  }
});

test('evasion: an OBJECT SPREAD — of a literal, or of a real handle — is caught', () => {
  const v = check({
    'guard-fixture-spread.ts': `${HANDLE_IMPORTS}
const claim = { isolationEnforced: true as const };
export const viaLiteral: SandboxHandle = { sandboxId: 's', profile: 'p', ...claim };
export async function rewrap(p: SandboxProvider): Promise<SandboxHandle> {
  const real = (await p.start('verification-no-network', { workspaceId: 'w' as never, readOnlyPaths: [], writablePaths: [] })) as SandboxHandleEx;
  return { ...real, profile: 'relabelled' };
}
export const nested: SandboxHandle = { sandboxId: 's', profile: 'p', ...{ ...{ isolationEnforced: true } } };
`,
  }, 'isolation-claim');
  for (const line of [4, 5, 8, 10]) {
    assert.ok(v.some((x) => x.line === line), `line ${line} must be flagged: ${JSON.stringify(v)}`);
  }
});

// A spread of an untyped value makes the whole literal `any`, so the literal's
// own type no longer shows the claim; the guard must still see it.
test('evasion: a spread of an UNTYPED value — into a handle, or beside a claim — is caught', () => {
  const v = check({
    'guard-fixture-untyped-spread.ts': `${HANDLE_IMPORTS}
const yes = true;
declare function adopt(h: SandboxHandle): void;
export function launder(raw: string): void {
  adopt({ sandboxId: 's', profile: 'p', ...JSON.parse(raw) });
}
export const beside = { ...JSON.parse('{}'), isolationEnforced: yes };
`,
  }, 'isolation-claim');
  assert.ok(v.some((x) => x.line === 7 && /spread/.test(x.message)), `the untyped spread: ${JSON.stringify(v)}`);
  assert.ok(v.some((x) => x.line === 9 && /not false/.test(x.message)), `the claim beside it: ${JSON.stringify(v)}`);
});

// --- the rest of the claim shapes ------------------------------------------------------

test('every other way to write the claim is caught', () => {
  const v = check({
    'guard-fixture-writes.ts': `${HANDLE_IMPORTS}
const isolationEnforced = true;
export const shorthand: SandboxHandle = { sandboxId: 's', profile: 'p', isolationEnforced };
export function assigned(h: SandboxHandle & { isolationEnforced?: boolean }): void {
  (h as { isolationEnforced?: boolean }).isolationEnforced = true;
}
export function element(h: { isolationEnforced?: boolean }, k: string): void {
  h[k as 'isolationEnforced'] = true;
}
export function assigns(h: SandboxHandle, src: { isolationEnforced: boolean }): void {
  Object.assign(h, src);
  const { assign } = Object;
  assign(h, src);
}
export function defines(h: SandboxHandle, k: string): void {
  Object.defineProperty(h, k, { value: true });
  Reflect.set(h, k, true);
}
export class FakeHandle implements SandboxHandle {
  sandboxId = 's';
  profile = 'p';
  isolationEnforced = true;
}
export const getter = { sandboxId: 's', profile: 'p', get isolationEnforced() { return true; } };
export const smuggled = JSON.parse('{"sandboxId":"s"}') as SandboxHandle;
export const doubleCast = ({} as unknown) as SandboxHandleEx;
export const untyped: SandboxHandle = JSON.parse('{}');
export const viaString = Object.fromEntries([['isolation' + 'Enforced', true]]);
`,
  }, 'isolation-claim');
  const lines = new Set(v.map((x) => x.line));
  const expected: Record<number, string> = {
    5: 'shorthand', 7: 'property write', 10: 'element write with an unresolvable key',
    13: 'Object.assign', 15: 'destructured assign', 18: 'Object.defineProperty', 19: 'Reflect.set',
    24: 'class property', 26: 'getter', 27: 'cast from any', 28: 'double cast through unknown',
    29: 'any flowing into a handle', 30: 'the property name as a string',
  };
  for (const [line, what] of Object.entries(expected)) {
    assert.ok(lines.has(Number(line)), `${what} (line ${line}) must be flagged: ${JSON.stringify(v)}`);
  }
});

test('honest code is NOT flagged: false claims, reads, handle casts and passing a handle on', () => {
  const v = check({
    'guard-fixture-honest.ts': `${HANDLE_IMPORTS}
export interface Described { readonly isolationEnforced?: boolean }
export const unsandboxed: SandboxHandle = { sandboxId: 'l', profile: 'p', isolationEnforced: false };
export function enforced(h: SandboxHandle): boolean {
  return (h as { isolationEnforced?: boolean }).isolationEnforced === true && h.isolationEnforced !== false;
}
export function widen(h: SandboxHandle): SandboxHandleEx {
  return h as SandboxHandleEx;
}
export async function use(p: SandboxProvider, run: (h: SandboxHandle) => Promise<void>): Promise<void> {
  const h = await p.start('verification-no-network', { workspaceId: 'w' as never, readOnlyPaths: [], writablePaths: [] });
  await run(h);
  await p.stop(h);
}
export const unrelated = { profile: 'verification-no-network', ['sandbox' + 'Id']: 'x' };
`,
  });
  assert.deepEqual(v, []);
});

// --- the retired waiver vocabulary ---------------------------------------------------------

test('the retired waivers cannot come back: names, folded tokens, cross-module aliases', () => {
  const v = check({
    'guard-fixture-parts.ts': `export const PART = 'waived-pilot';
export const MODE = 'pilot-' as const;
`,
    'guard-fixture-waiver.ts': `import { PART, MODE } from './guard-fixture-parts.js';
export const sandboxRequirement = 'required';
const head = 'waived-';
export const folded = head + 'pilot-only';
export const viaImport = PART + '-only';
export const templated = \`\${MODE}unsandboxed\`;
export const env = process.env['ASEP_' + 'SANDBOX_MODE'];
export const prop = { ['host' + 'ExecutionWaiver']: true };
`,
  }, 'retired-isolation-waiver');
  const at = (file: string, line: number) => v.some((x) => x.file.endsWith(file) && x.line === line);
  for (const line of [2, 4, 5, 6, 7, 8]) {
    assert.ok(at('guard-fixture-waiver.ts', line), `line ${line} must be flagged: ${JSON.stringify(v)}`);
  }
  assert.ok(!v.some((x) => x.file.endsWith('guard-fixture-parts.ts')),
    'a fragment alone is not the token; the use that completes it is');
});
