// Determinism fitness for the workflow decision core.
//
// The core is imported by Temporal workflow code, which must replay
// byte-for-byte. Anything that reads a clock, a random source, a timer, the
// process or the network would make two replays of the same history diverge.
// The Temporal sandbox only catches some of that at runtime; this suite rejects
// it statically, before a workflow ever runs:
//
//   1. every import/export-from of a non-relative module is type-only, and only
//      from @asep/contracts or @asep/ports (types are erased at build time, so
//      the core carries no runtime dependency at all);
//   2. no source file uses a banned global (clock, randomness, timers, process,
//      crypto, require, dynamic import, global escape hatches).
//
// Test files are exempt: they run under node:test, never inside a workflow.
// Comments and string literals are stripped before scanning, so prose that names
// a banned global is not a violation, while code inside `${...}` still is.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('SUITE-ID: asep-suite:orchestration-purity');

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const TYPE_IMPORT_ALLOWED = new Set(['@asep/contracts', '@asep/ports']);

const BANNED_GLOBALS = [
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
  'fetch',
] as const;

export interface PurityViolation {
  readonly file: string;
  readonly rule: 'runtime-import' | 'type-import-source' | 'banned-global' | 'dynamic-import';
  readonly detail: string;
}

// Replace comments and string/template literal text with spaces, keeping line
// structure and the code inside template `${...}` substitutions.
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const templateDepth: number[] = [];
  let braceDepth = 0;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      out += ch + blank(source.slice(i + 1, j)) + ch;
      i = j + 1;
      continue;
    }
    if (ch === '`' || (ch === '}' && templateDepth.length > 0 && templateDepth.at(-1) === braceDepth)) {
      if (ch === '}') templateDepth.pop();
      // Inside template text until the closing backtick or the next `${`.
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) {
        j += source[j] === '\\' ? 2 : 1;
      }
      out += ch + blank(source.slice(i + 1, j));
      if (source[j] === '$') {
        out += '${';
        templateDepth.push(braceDepth);
        i = j + 2;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth -= 1;
    out += ch;
    i += 1;
  }
  return out;
}

const MODULE_STATEMENT =
  /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[\w*\s{},$]*?\s+from\s+)?(['"])([^'"]+)\3/g;

export function findPurityViolations(file: string, source: string): PurityViolation[] {
  const violations: PurityViolation[] = [];

  // Module specifiers are string literals, so read them from the raw source.
  for (const match of source.matchAll(MODULE_STATEMENT)) {
    const typeOnly = match[2] !== undefined;
    const specifier = match[4]!;
    if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
    if (!typeOnly) {
      violations.push({ file, rule: 'runtime-import', detail: specifier });
    } else if (!TYPE_IMPORT_ALLOWED.has(specifier)) {
      violations.push({ file, rule: 'type-import-source', detail: specifier });
    }
  }

  const code = stripCommentsAndStrings(source);
  if (/\bimport\s*\(/.test(code)) {
    violations.push({ file, rule: 'dynamic-import', detail: 'import(' });
  }
  if (/\bMath\s*\.\s*random\b/.test(code)) {
    violations.push({ file, rule: 'banned-global', detail: 'Math.random' });
  }
  for (const name of BANNED_GLOBALS) {
    // A property access like `x.process` is still a hit: the name is banned
    // wherever it appears as an identifier.
    if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code)) {
      violations.push({ file, rule: 'banned-global', detail: name });
    }
  }
  return violations;
}

function coreSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...coreSourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('the core has source files to check (an empty scan must not look green)', () => {
  assert.ok(coreSourceFiles(SRC_DIR).length >= 5, 'expected the core modules under src/');
});

test('every core source file is deterministic: type-only imports from contracts/ports, no banned globals', () => {
  const all: PurityViolation[] = [];
  for (const full of coreSourceFiles(SRC_DIR)) {
    all.push(...findPurityViolations(relative(SRC_DIR, full), readFileSync(full, 'utf8')));
  }
  assert.deepEqual(all, []);
});

// --- seeded violations: the detector must catch each one -------------------

const SEEDED: readonly { name: string; source: string; rule: PurityViolation['rule']; detail: string }[] = [
  { name: 'runtime import of a workspace package', source: 'import { x } from "@asep/contracts";', rule: 'runtime-import', detail: '@asep/contracts' },
  { name: 'runtime import of a node builtin', source: "import { readFileSync } from 'node:fs';", rule: 'runtime-import', detail: 'node:fs' },
  { name: 'side-effect import', source: "import 'node:crypto';", rule: 'runtime-import', detail: 'node:crypto' },
  { name: 'runtime re-export', source: 'export { a } from "@asep/ports";', rule: 'runtime-import', detail: '@asep/ports' },
  { name: 'type import from a package with node builtins', source: 'import type { FailureClass } from "@asep/policy";', rule: 'type-import-source', detail: '@asep/policy' },
  { name: 'wall clock', source: 'const t = Date.now();', rule: 'banned-global', detail: 'Date' },
  { name: 'new Date', source: 'const d = new Date();', rule: 'banned-global', detail: 'Date' },
  { name: 'randomness', source: 'const r = Math.random();', rule: 'banned-global', detail: 'Math.random' },
  { name: 'timer', source: 'setTimeout(() => 1, 5);', rule: 'banned-global', detail: 'setTimeout' },
  { name: 'process access', source: 'const e = process.env;', rule: 'banned-global', detail: 'process' },
  { name: 'crypto global', source: 'const id = crypto.randomUUID();', rule: 'banned-global', detail: 'crypto' },
  { name: 'require', source: "const fs = require('fs');", rule: 'banned-global', detail: 'require' },
  { name: 'dynamic import', source: "const m = await import('x');", rule: 'dynamic-import', detail: 'import(' },
  { name: 'global escape hatch', source: 'const g = globalThis;', rule: 'banned-global', detail: 'globalThis' },
  { name: 'clock inside a template substitution', source: 'const s = `at ${Date.now()}`;', rule: 'banned-global', detail: 'Date' },
];

for (const seed of SEEDED) {
  test(`seeded violation is caught: ${seed.name}`, () => {
    const found = findPurityViolations('seed.ts', seed.source);
    assert.ok(
      found.some((v) => v.rule === seed.rule && v.detail === seed.detail),
      `expected ${seed.rule}:${seed.detail}, got ${JSON.stringify(found)}`,
    );
  });
}

test('clean constructs are not flagged (no false positives)', () => {
  const source = [
    'import type { TaskId } from "@asep/contracts";',
    'import type { WorkflowEngine } from "@asep/ports";',
    "import { decide } from './task-core.js';",
    "export type { TaskState } from './types.js';",
    "export { decideRun } from './run-core.js';",
    '// Date.now() in a comment is prose, not code',
    "const label = 'process Date setTimeout';",
    'const t = `plain template text with Date`;',
    'const updatedPhase = processedCount + 1;',
    'const m = Math.max(1, 2);',
  ].join('\n');
  assert.deepEqual(findPurityViolations('clean.ts', source), []);
});
