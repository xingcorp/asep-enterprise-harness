// Determinism fitness for the workflow decision core.
//
// The core is imported by Temporal workflow code, which must replay
// byte-for-byte. Anything that reads a clock, a random source, a timer, the
// process or the network would make two replays of the same history diverge.
// The Temporal sandbox only catches some of that at runtime; this suite rejects
// it statically, before a workflow ever runs:
//
//   1. every import or re-export of a non-relative module is type-only, and only
//      from @asep/contracts or @asep/ports (types are erased at build time, so
//      the core carries no runtime dependency at all). A relative import or
//      re-export must stay inside src/, outside src/test-support/, and must not
//      name a test file. Import-equals declarations, dynamic import() and import
//      types of other modules are rejected;
//   2. no source file names a banned global (clock, randomness, timers, process,
//      crypto, require, eval, the Function constructor, global escape hatches),
//      whether as an identifier, with unicode escapes, or as the literal name of
//      a computed member access. Math is allowed only as Math.<member> for a
//      fixed set of pure members.
//
// Each file is parsed with the TypeScript compiler API the repo already depends
// on (TypeScript 7's native API, over an in-memory file system), so comments,
// string literals and formatting can neither hide nor fake a violation. The API
// is marked unstable: the suite asserts that every production file parsed, so a
// change in it turns the suite red, never green.
//
// Only production source is scanned. Test files and test support
// (src/test-support/**) are exempt: they run under node:test, never inside a
// workflow, and may use runtime imports such as node:test and node:assert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import {
  SyntaxKind,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNamedExports,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/unstable/ast';
import type { ExportDeclaration, ImportDeclaration, Node, SourceFile } from 'typescript/unstable/ast';

console.log('SUITE-ID: asep-suite:orchestration-purity');

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const TEST_SUPPORT_DIR = 'test-support';

const TYPE_IMPORT_ALLOWED = new Set(['@asep/contracts', '@asep/ports']);

const BANNED_GLOBALS = new Set([
  'Date',
  'performance',
  'process',
  'crypto',
  'require',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'globalThis',
  'WeakRef',
  'FinalizationRegistry',
  'eval',
  'Function',
  'fetch',
]);

// Pure, deterministic Math members; everything else on Math (random above all) is banned.
const MATH_MEMBERS = new Set(['abs', 'ceil', 'floor', 'imul', 'max', 'min', 'round', 'sign', 'trunc']);

export interface PurityViolation {
  readonly file: string;
  readonly rule: 'runtime-import' | 'type-import-source' | 'import-target' | 'import-equals' | 'dynamic-import' | 'banned-global';
  readonly detail: string;
}

export interface PurityScan {
  /** The files that parsed without a syntax error, in order. */
  readonly parsed: readonly string[];
  readonly violations: readonly PurityViolation[];
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** True when a relative import from `file` (a path under src/) reaches a module the core may depend on. */
function allowedTarget(file: string, specifier: string): boolean {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (target === '..' || target.startsWith('../')) return false;
  if (target.split('/')[0] === TEST_SUPPORT_DIR) return false;
  return !/\.test\.[cm]?[jt]s$/.test(target);
}

function importIsTypeOnly(node: ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.phaseModifier === SyntaxKind.TypeKeyword) return true;
  if (clause.name !== undefined || clause.namedBindings === undefined || !isNamedImports(clause.namedBindings)) return false;
  const elements = clause.namedBindings.elements;
  return elements.length > 0 && elements.every((e) => e.isTypeOnly);
}

function exportIsTypeOnly(node: ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined || !isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

function literalText(node: Node | undefined): string | null {
  if (node === undefined) return null;
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function checkSourceFile(file: string, sourceFile: SourceFile): PurityViolation[] {
  const out: PurityViolation[] = [];
  const add = (rule: PurityViolation['rule'], detail: string): void => {
    if (!out.some((v) => v.rule === rule && v.detail === detail)) out.push({ file, rule, detail });
  };
  const moduleReference = (specifier: string | null, typeOnly: boolean): void => {
    if (specifier === null) add('dynamic-import', 'non-literal module specifier');
    else if (isRelative(specifier)) {
      if (!allowedTarget(file, specifier)) add('import-target', specifier);
    } else if (!typeOnly) add('runtime-import', specifier);
    else if (!TYPE_IMPORT_ALLOWED.has(specifier)) add('type-import-source', specifier);
  };

  const visit = (node: Node): void => {
    if (isImportDeclaration(node)) {
      moduleReference(literalText(node.moduleSpecifier), importIsTypeOnly(node));
    } else if (isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) moduleReference(literalText(node.moduleSpecifier), exportIsTypeOnly(node));
    } else if (isImportEqualsDeclaration(node)) {
      if (isExternalModuleReference(node.moduleReference)) add('import-equals', literalText(node.moduleReference.expression) ?? 'require');
    } else if (isImportTypeNode(node)) {
      moduleReference(isLiteralTypeNode(node.argument) ? literalText(node.argument.literal) : null, true);
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      add('dynamic-import', 'import(');
    } else if (isPropertyAccessExpression(node) && isIdentifier(node.expression) && node.expression.text === 'Math') {
      // Math is allowed only here, as the object of a pure member; the member name is still checked.
      const member = isIdentifier(node.name) ? node.name.text : '';
      if (!MATH_MEMBERS.has(member)) add('banned-global', `Math.${member}`);
      visit(node.name);
      return;
    } else if (isElementAccessExpression(node)) {
      const name = literalText(node.argumentExpression);
      if (name !== null && (BANNED_GLOBALS.has(name) || name === 'Math')) add('banned-global', name);
    } else if (isIdentifier(node)) {
      // `text` is the decoded name, so unicode escapes do not hide it. A member name such as `x.process` is still a
      // hit: the name is banned wherever it appears as an identifier.
      if (BANNED_GLOBALS.has(node.text) || node.text === 'Math') add('banned-global', node.text);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return out;
}

const VIRTUAL_ROOT = '/purity';
const VIRTUAL_CONFIG = `${VIRTUAL_ROOT}/tsconfig.json`;

/** Parse the files (paths relative to src/, with forward slashes) in memory and check each one. */
export function scanSources(files: Readonly<Record<string, string>>): PurityScan {
  const names = Object.keys(files).sort();
  const virtual: Record<string, string> = {
    [VIRTUAL_CONFIG]: JSON.stringify({
      compilerOptions: { target: 'esnext', module: 'nodenext', noLib: true, noResolve: true, types: [] },
      files: names.map((name) => `src/${name}`),
    }),
  };
  for (const name of names) virtual[`${VIRTUAL_ROOT}/src/${name}`] = files[name]!;
  const api = new API({ fs: createVirtualFileSystem(virtual) });
  try {
    const program = api.updateSnapshot({ openProjects: [VIRTUAL_CONFIG] }).getProject(VIRTUAL_CONFIG)?.program;
    const parsed: string[] = [];
    const violations: PurityViolation[] = [];
    for (const name of names) {
      const path = `${VIRTUAL_ROOT}/src/${name}`;
      const sourceFile = program?.getSourceFile(path);
      if (sourceFile === undefined || program!.getSyntacticDiagnostics(path).length > 0) continue;
      parsed.push(name);
      violations.push(...checkSourceFile(name, sourceFile));
    }
    return { parsed, violations };
  } finally {
    api.close();
  }
}

function coreSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== TEST_SUPPORT_DIR) out.push(...coreSourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('the core has source files to check (an empty scan must not look green)', () => {
  assert.ok(coreSourceFiles(SRC_DIR).length >= 5, 'expected the core modules under src/');
});

test('the scan covers production source only: tests and test support are excluded', () => {
  const scanned = coreSourceFiles(SRC_DIR).map((full) => relative(SRC_DIR, full));
  assert.ok(scanned.includes('task-core.ts'), 'production modules are scanned');
  assert.ok(existsSync(join(SRC_DIR, TEST_SUPPORT_DIR, 'fixtures.ts')), 'the test-support exclusion must be exercised');
  assert.deepEqual(scanned.filter((f) => f.endsWith('.test.ts') || f.split(sep).includes(TEST_SUPPORT_DIR)), []);
});

test('every core source file parses and is deterministic: type-only imports from contracts/ports, no banned globals', () => {
  const files: Record<string, string> = {};
  for (const full of coreSourceFiles(SRC_DIR)) files[relative(SRC_DIR, full).split(sep).join('/')] = readFileSync(full, 'utf8');
  const scan = scanSources(files);
  assert.deepEqual(scan.parsed, Object.keys(files).sort(), 'every production file must parse');
  assert.deepEqual(scan.violations, []);
});

// --- seeded violations: the detector must catch each one -------------------

const SEEDED: readonly { name: string; source: string; rule: PurityViolation['rule']; detail: string }[] = [
  { name: 'runtime import of a workspace package', source: 'import { x } from "@asep/contracts";', rule: 'runtime-import', detail: '@asep/contracts' },
  { name: 'runtime import of a node builtin', source: "import { readFileSync } from 'node:fs';", rule: 'runtime-import', detail: 'node:fs' },
  { name: 'side-effect import', source: "import 'node:crypto';", rule: 'runtime-import', detail: 'node:crypto' },
  { name: 'runtime re-export', source: 'export { a } from "@asep/ports";', rule: 'runtime-import', detail: '@asep/ports' },
  { name: 're-export with a comment inside', source: 'export /* bridge */ { readFileSync as read } from "node:fs";', rule: 'runtime-import', detail: 'node:fs' },
  { name: 'mixed type and value specifiers', source: 'import { type TaskId, isTaskId } from "@asep/contracts";', rule: 'runtime-import', detail: '@asep/contracts' },
  { name: 'type import from a package with node builtins', source: 'import type { FailureClass } from "@asep/policy";', rule: 'type-import-source', detail: '@asep/policy' },
  { name: 'import type of another module', source: 'type Stats = import("node:fs").Stats;', rule: 'type-import-source', detail: 'node:fs' },
  { name: 'relative import out of the package', source: 'import { transitionTask } from "../../domain/src/index.js";', rule: 'import-target', detail: '../../domain/src/index.js' },
  { name: 'export * out of the package', source: 'export * from "../../domain/src/index.js";', rule: 'import-target', detail: '../../domain/src/index.js' },
  { name: 'import of test support', source: 'import { happyAnswer } from "./test-support/fixtures.js";', rule: 'import-target', detail: './test-support/fixtures.js' },
  { name: 'type import of test support', source: 'import type { Responder } from "./test-support/fixtures.js";', rule: 'import-target', detail: './test-support/fixtures.js' },
  { name: 'import of a test file', source: 'import { x } from "./decide.test.js";', rule: 'import-target', detail: './decide.test.js' },
  { name: 'import-equals', source: 'import fs = require("node:fs");', rule: 'import-equals', detail: 'node:fs' },
  { name: 'wall clock', source: 'const t = Date.now();', rule: 'banned-global', detail: 'Date' },
  { name: 'new Date', source: 'const d = new Date();', rule: 'banned-global', detail: 'Date' },
  { name: 'wall clock behind a unicode escape', source: 'const t = \\u0044ate.now();', rule: 'banned-global', detail: 'Date' },
  { name: 'randomness', source: 'const r = Math.random();', rule: 'banned-global', detail: 'Math.random' },
  { name: 'randomness behind a unicode escape', source: 'const r = M\\u0061th.random();', rule: 'banned-global', detail: 'Math.random' },
  { name: 'randomness through an alias', source: 'const m = Math;\nconst r = m.random();', rule: 'banned-global', detail: 'Math' },
  { name: 'randomness through a computed access', source: 'const r = Math["random"]();', rule: 'banned-global', detail: 'Math' },
  { name: 'banned global through a computed access', source: 'const e = scope["process"].env;', rule: 'banned-global', detail: 'process' },
  { name: 'banned global through a template computed access', source: 'const d = scope[`Date`];', rule: 'banned-global', detail: 'Date' },
  { name: 'timer', source: 'setTimeout(() => 1, 5);', rule: 'banned-global', detail: 'setTimeout' },
  { name: 'process access', source: 'const e = process.env;', rule: 'banned-global', detail: 'process' },
  { name: 'crypto global', source: 'const id = crypto.randomUUID();', rule: 'banned-global', detail: 'crypto' },
  { name: 'require', source: "const fs = require('fs');", rule: 'banned-global', detail: 'require' },
  { name: 'Function constructor', source: 'const f = new Function("return 1");', rule: 'banned-global', detail: 'Function' },
  { name: 'dynamic import', source: "const m = await import('x');", rule: 'dynamic-import', detail: 'import(' },
  { name: 'dynamic import of a computed name', source: 'const m = await import(name);', rule: 'dynamic-import', detail: 'import(' },
  { name: 'global escape hatch', source: 'const g = globalThis;', rule: 'banned-global', detail: 'globalThis' },
  { name: 'clock inside a template substitution', source: 'const s = `at ${Date.now()}`;', rule: 'banned-global', detail: 'Date' },
  { name: 'test runner in production source', source: "import test from 'node:test';", rule: 'runtime-import', detail: 'node:test' },
];

let seededScan: PurityScan | null = null;

/** All seeds parsed in one scan, each as its own file at the top of src/. */
function scanSeeds(): PurityScan {
  seededScan ??= scanSources(Object.fromEntries(SEEDED.map((seed, i) => [`seed-${i}.ts`, seed.source])));
  return seededScan;
}

test('every seeded violation parses', () => {
  assert.equal(scanSeeds().parsed.length, SEEDED.length, 'a seed that does not parse proves nothing');
});

SEEDED.forEach((seed, i) => {
  test(`seeded violation is caught: ${seed.name}`, () => {
    const found = scanSeeds().violations.filter((v) => v.file === `seed-${i}.ts`);
    assert.ok(
      found.some((v) => v.rule === seed.rule && v.detail === seed.detail),
      `expected ${seed.rule}:${seed.detail}, got ${JSON.stringify(found)}`,
    );
  });
});

test('clean constructs are not flagged (no false positives)', () => {
  const clean = [
    'import type { TaskId } from "@asep/contracts";',
    'import { type RunId, type TaskId as Id } from "@asep/contracts";',
    'import type * as Contracts from "@asep/contracts";',
    'import type { WorkflowEngine } from "@asep/ports";',
    "import { decide } from './task-core.js';",
    "import { helper } from './nested/helper.js';",
    "export type { TaskState } from './types.js';",
    'export { type TaskId as Task } from "@asep/contracts";',
    "export { decideRun } from './run-core.js';",
    "export * from './types.js';",
    "type Types = typeof import('./types.js');",
    '// Date.now() and Math.random() in a comment are prose, not code',
    "const label = 'process Date setTimeout Math.random';",
    'const t = `plain template text with Date`;',
    'const updatedPhase = processedCount + 1;',
    'const m = Math.max(1, 2) + Math.min(1, 2) + Math.ceil(0.5) + Math.floor(0.5) + Math.round(0.5);',
    'const n = Math.abs(-1) + Math.sign(-1) + Math.trunc(-1.5) + Math.imul(2, 3);',
    'const field = record["status"];',
  ].join('\n');
  const scan = scanSources({ 'clean.ts': clean, 'nested/clean.ts': "import { decide } from '../task-core.js';" });
  assert.deepEqual(scan.parsed, ['clean.ts', 'nested/clean.ts'], 'both clean files parse');
  assert.deepEqual(scan.violations, []);
});
