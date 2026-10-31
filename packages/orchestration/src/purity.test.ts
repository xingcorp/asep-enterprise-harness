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
//      the core carries no runtime dependency at all). Every relative import,
//      re-export or import type is resolved with the compiler's own module
//      resolution, and its target must be a production file of this scan: a
//      specifier with a percent-encoded character, a query or a fragment, or
//      without the `.js` extension, and one that does not resolve, is rejected.
//      Import-equals declarations, dynamic import() and import types of other
//      modules are rejected;
//   2. every global the core reaches is on an allowlist of deterministic globals: an identifier in a value position
//      that the checker resolves outside its own file (a lib or ambient declaration) or to nothing must be one of
//      ALLOWED_GLOBALS, including through a shorthand property or a local re-export. No ambient declaration
//      (`declare`) and no `import.meta` either: both read the host;
//   3. no source file names a denied global (clock, Intl, Temporal, randomness, timers, process, crypto, require,
//      eval, Function, Reflect, Proxy, global escape hatches), a reflective member (constructor, prototype,
//      __proto__, and the Object members that reach a prototype without naming it) or a denied member (the
//      locale-dependent ones, and the error members that expose host paths), whether as an identifier, with
//      unicode escapes, or as a literal key; a string holding a reflective or denied member name is a literal key
//      wherever it appears. A computed member access must have a key whose type is a finite union of literals, and
//      those literals are checked too; a type assertion inside a computed key is refused, because it gives a key
//      built at run time a literal type it does not have, and so is a double cast through `unknown` or `any`. Math
//      is allowed only as Math.<member> for a fixed set of pure members, and Symbol only as a call or a member other
//      than its registry reads.
//
// The suite asks the TypeScript checker, as the Phase 2 fitness guard does: it
// loads the package's own project with TypeScript 7's native API and overlays
// seeded files in memory. The API is marked unstable, so the suite asserts that
// every production file parsed and that every seed is caught: a change in the
// API turns it red, never green.
//
// The check is a defence layer, not a proof: a value built at run time from
// arbitrary computation can still evade a static check. It closes the shapes
// that are cheap to write by accident or on purpose; the real workflow bundle
// and the replay corpus check what the workflow loads and does. It does not
// close a host-dependent member of an allowed global or value that no deny list
// names, a call whose behaviour differs between engine versions, or a host
// object handed to the core as a value (the core receives only plain data).
//
// Only production source is scanned. Test files and test support
// (src/test-support/**) are exempt: they run under node:test, never inside a
// workflow, and may use runtime imports such as node:test and node:assert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import type { Checker, Symbol as CheckerSymbol, Type } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isAsExpression,
  isBindingElement,
  isBreakOrContinueStatement,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isEnumMember,
  isExportDeclaration,
  isExportSpecifier,
  isExternalModuleReference,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLabeledStatement,
  isLiteralTypeNode,
  isMetaProperty,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNamedExports,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeNode,
} from 'typescript/unstable/ast';
import type { ExportDeclaration, Identifier, ImportDeclaration, Node, SourceFile } from 'typescript/unstable/ast';

console.log('SUITE-ID: asep-suite:orchestration-purity');

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(SRC_DIR);
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const PROJECT = join(PACKAGE_DIR, 'tsconfig.json');
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
  'Reflect',
  'Proxy',
  'fetch',
  // Intl formats the current time when given no date, and Temporal.Now reads the clock.
  'Intl',
  'Temporal',
]);

// Members that reach a constructor or a prototype, and through them Function and every global; the last four do it
// without naming either.
const REFLECTIVE_MEMBERS = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'getPrototypeOf',
  'setPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
]);

// Members whose result depends on the host: the locale (the same call formats or orders differently under another
// locale) and the stack trace, which holds host paths.
const DENIED_MEMBERS = new Set([
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'localeCompare',
  'stack',
  'captureStackTrace',
  'prepareStackTrace',
  'stackTraceLimit',
]);

// The only globals the core may reach: deterministic ones. Math and Symbol carry their own member rules.
const ALLOWED_GLOBALS = new Set([
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'Map',
  'Set',
  'JSON',
  'Error',
  'RangeError',
  'TypeError',
  'Symbol',
  'Math',
  'undefined',
  'NaN',
  'Infinity',
]);

// Pure, deterministic Math members; everything else on Math (random above all) is banned.
const MATH_MEMBERS = new Set(['abs', 'ceil', 'floor', 'imul', 'max', 'min', 'round', 'sign', 'trunc']);

// Symbol's registry is global state shared across the process.
const SYMBOL_REGISTRY = new Set(['for', 'keyFor']);

export interface PurityViolation {
  readonly file: string;
  readonly rule:
    | 'runtime-import'
    | 'type-import-source'
    | 'import-target'
    | 'import-equals'
    | 'dynamic-import'
    | 'banned-global'
    | 'ambient-global'
    | 'ambient-declaration'
    | 'reflective-member'
    | 'denied-member'
    | 'computed-access'
    | 'asserted-key'
    | 'double-cast';
  readonly detail: string;
}

export interface PurityScan {
  /** The production files that parsed without a syntax error, relative to src/, in order. */
  readonly parsed: readonly string[];
  readonly violations: readonly PurityViolation[];
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Production source: src/**\/*.ts except tests, declarations and test support (paths relative to src/). */
function isProduction(rel: string): boolean {
  return rel.endsWith('.ts') && !rel.endsWith('.test.ts') && !rel.endsWith('.d.ts') && rel.split('/')[0] !== TEST_SUPPORT_DIR;
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

/** True for an `x as T` or `<T>x` assertion. */
function isAssertion(node: Node): boolean {
  return isAsExpression(node) || isTypeAssertion(node);
}

/** True when the subtree holds a type assertion anywhere. */
function holdsAssertion(node: Node): boolean {
  if (isAssertion(node)) return true;
  let found = false;
  node.forEachChild((child) => {
    found ||= holdsAssertion(child);
  });
  return found;
}

/** True for an assertion whose operand, parentheses aside, is itself asserted to `unknown` or `any`. */
function isDoubleCast(node: Node): boolean {
  if (!isAsExpression(node) && !isTypeAssertion(node)) return false;
  let inner: Node = node.expression;
  while (isParenthesizedExpression(inner)) inner = inner.expression;
  return (isAsExpression(inner) || isTypeAssertion(inner))
    && (inner.type.kind === SyntaxKind.UnknownKeyword || inner.type.kind === SyntaxKind.AnyKeyword);
}

function literalText(node: Node | undefined): string | null {
  if (node === undefined) return null;
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** True for the name of a member or a label: a key, not a reference to anything in scope. */
function isMemberOrLabelName(node: Identifier): boolean {
  const parent = node.parent;
  if (isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (isQualifiedName(parent) && parent.right === node) return true;
  if (isBindingElement(parent) && parent.propertyName === node) return true;
  if (isLabeledStatement(parent) || isBreakOrContinueStatement(parent)) return true;
  return (isPropertyAssignment(parent) || isPropertyDeclaration(parent) || isPropertySignatureDeclaration(parent)
    || isMethodDeclaration(parent) || isMethodSignatureDeclaration(parent) || isGetAccessorDeclaration(parent)
    || isSetAccessorDeclaration(parent) || isEnumMember(parent)) && parent.name === node;
}

/** The literal values a key can take, or null when its type is not a finite union of string or number literals. */
function literalKeys(type: Type | undefined): string[] | null {
  if (type === undefined) return null;
  const parts = type.isUnionType() ? type.getTypes() : [type];
  const keys: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteralType() && !part.isNumberLiteralType()) return null;
    keys.push(String(part.value));
  }
  return keys;
}

class FileCheck {
  private readonly out: PurityViolation[] = [];

  constructor(
    private readonly file: string,
    private readonly sourceFile: SourceFile,
    private readonly checker: Checker,
    /** Lower-cased absolute paths of every production file in the scan. */
    private readonly closure: ReadonlySet<string>,
  ) {}

  run(): PurityViolation[] {
    this.visit(this.sourceFile, false);
    return this.out;
  }

  private add(rule: PurityViolation['rule'], detail: string): void {
    if (!this.out.some((v) => v.rule === rule && v.detail === detail)) this.out.push({ file: this.file, rule, detail });
  }

  private textOf(node: Node): string {
    return this.sourceFile.text.slice(node.getStart(this.sourceFile), node.getEnd());
  }

  /** A literal key: denied globals, Math, reflective and denied members may not be reached through it. */
  private literalKey(key: string): void {
    if (REFLECTIVE_MEMBERS.has(key)) this.add('reflective-member', key);
    else if (DENIED_MEMBERS.has(key)) this.add('denied-member', key);
    else if (BANNED_GLOBALS.has(key) || key === 'Math') this.add('banned-global', key);
  }

  /** A value the name refers to must be declared in this file (a local or an import binding) or an allowed global. */
  private reference(name: string, symbol: CheckerSymbol | undefined): void {
    const local = symbol?.declarations?.some((d) => d.path === this.sourceFile.path) ?? false;
    if (!local && !ALLOWED_GLOBALS.has(name)) this.add('ambient-global', name);
  }

  /**
   * The key of a computed member access or a computed property name: a finite union of literals, each allowed, and
   * no type assertion inside it, since the checker would then report the asserted type, not the value's.
   */
  private computedKey(whole: Node, key: Node): void {
    if (holdsAssertion(key)) {
      this.add('asserted-key', this.textOf(whole));
      return;
    }
    const keys = literalKeys(this.checker.getTypeAtLocation(key));
    if (keys === null) this.add('computed-access', this.textOf(whole));
    else for (const k of keys) this.literalKey(k);
  }

  private moduleReference(specifierNode: Node | undefined, typeOnly: boolean): void {
    const specifier = literalText(specifierNode);
    if (specifier === null || specifierNode === undefined) {
      this.add('dynamic-import', 'non-literal module specifier');
    } else if (isRelative(specifier)) {
      if (!this.resolvesIntoClosure(specifierNode, specifier)) this.add('import-target', specifier);
    } else if (!typeOnly) {
      this.add('runtime-import', specifier);
    } else if (!TYPE_IMPORT_ALLOWED.has(specifier)) {
      this.add('type-import-source', specifier);
    }
  }

  /** The compiler resolves the specifier to a production `.ts` file of this scan, spelled as the build expects it. */
  private resolvesIntoClosure(specifierNode: Node, specifier: string): boolean {
    if (/[%?#]/.test(specifier) || !specifier.endsWith('.js')) return false;
    const target = this.checker.getSymbolAtLocation(specifierNode)?.declarations[0];
    return target !== undefined && target.kind === SyntaxKind.SourceFile && this.closure.has(target.path.toLowerCase());
  }

  /** `inType`: the node sits in a type, an interface or a type alias, which the build erases. */
  private visit(node: Node, inType: boolean): void {
    const typeOnly = inType || isTypeNode(node) || isInterfaceDeclaration(node) || isTypeAliasDeclaration(node);
    if ((node as Node & { readonly modifiers?: readonly Node[] }).modifiers?.some((m) => m.kind === SyntaxKind.DeclareKeyword)) {
      // An ambient declaration reads a host global under a local name.
      this.add('ambient-declaration', 'declare');
    }
    if (isImportDeclaration(node)) {
      this.moduleReference(node.moduleSpecifier, importIsTypeOnly(node));
      this.visitChildren(node, true);
      return;
    } else if (isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        this.moduleReference(node.moduleSpecifier, exportIsTypeOnly(node));
        this.visitChildren(node, true);
        return;
      }
    } else if (isExportSpecifier(node)) {
      // A local re-export: the value behind it is a reference like any other.
      if (!typeOnly && !node.isTypeOnly && !(isExportDeclaration(node.parent.parent) && node.parent.parent.isTypeOnly)) {
        const local = node.propertyName ?? node.name;
        if (isIdentifier(local)) this.reference(local.text, this.checker.getExportSpecifierLocalTargetSymbol(node));
      }
    } else if (isImportEqualsDeclaration(node)) {
      if (isExternalModuleReference(node.moduleReference)) {
        this.add('import-equals', literalText(node.moduleReference.expression) ?? 'require');
      }
    } else if (isImportTypeNode(node)) {
      this.moduleReference(isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
    } else if (isMetaProperty(node)) {
      if (node.keywordToken === SyntaxKind.ImportKeyword) this.add('ambient-global', 'import.meta');
      return;
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      this.add('dynamic-import', 'import(');
    } else if (isPropertyAccessExpression(node) && isIdentifier(node.expression) && node.expression.text === 'Math') {
      // Math is allowed only here, as the object of a pure member; the member name is still checked.
      const member = isIdentifier(node.name) ? node.name.text : '';
      if (!MATH_MEMBERS.has(member)) this.add('banned-global', `Math.${member}`);
      if (!typeOnly) this.reference('Math', this.checker.getSymbolAtLocation(node.expression));
      this.visit(node.name, typeOnly);
      return;
    } else if (isPropertyAccessExpression(node) && isIdentifier(node.expression) && node.expression.text === 'Symbol') {
      // Symbol is allowed as the object of a member other than its registry reads.
      const member = isIdentifier(node.name) ? node.name.text : '';
      if (SYMBOL_REGISTRY.has(member)) this.add('denied-member', `Symbol.${member}`);
      if (!typeOnly) this.reference('Symbol', this.checker.getSymbolAtLocation(node.expression));
      this.visit(node.name, typeOnly);
      return;
    } else if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'Symbol') {
      // ... and as a call that makes a fresh symbol.
      if (!typeOnly) this.reference('Symbol', this.checker.getSymbolAtLocation(node.expression));
      for (const argument of node.arguments) this.visit(argument, typeOnly);
      return;
    } else if (isElementAccessExpression(node)) {
      this.computedKey(node, node.argumentExpression);
    } else if (isComputedPropertyName(node)) {
      this.computedKey(node, node.expression);
    } else if (isDoubleCast(node)) {
      // `x as unknown as T` drops every type relation between the value and what the code then treats it as.
      this.add('double-cast', this.textOf(node));
    } else if (isShorthandPropertyAssignment(node)) {
      // `{ name }` reads the value `name` refers to, not a property.
      if (!typeOnly && isIdentifier(node.name)) this.reference(node.name.text, this.checker.getShorthandAssignmentValueSymbol(node));
    } else if (isIdentifier(node)) {
      // `text` is the decoded name, so unicode escapes do not hide it. A member name such as `x.process` is still a
      // hit: the name is denied wherever it appears as an identifier.
      if (REFLECTIVE_MEMBERS.has(node.text)) this.add('reflective-member', node.text);
      else if (DENIED_MEMBERS.has(node.text)) this.add('denied-member', node.text);
      else if (BANNED_GLOBALS.has(node.text) || node.text === 'Math' || node.text === 'Symbol') this.add('banned-global', node.text);
      const parent = node.parent;
      const handled = isShorthandPropertyAssignment(parent) || isExportSpecifier(parent);
      if (!typeOnly && !handled && !isMemberOrLabelName(node)) this.reference(node.text, this.checker.getSymbolAtLocation(node));
    } else {
      // A reflective or denied member name in a string is a key wherever it appears: a property name, a destructuring
      // key, an argument.
      const text = literalText(node);
      if (text !== null && REFLECTIVE_MEMBERS.has(text)) this.add('reflective-member', text);
      else if (text !== null && DENIED_MEMBERS.has(text)) this.add('denied-member', text);
    }
    this.visitChildren(node, typeOnly);
  }

  private visitChildren(node: Node, inType: boolean): void {
    node.forEachChild((child) => this.visit(child, inType));
  }
}

/** A virtual overlay over the real file system: the seeded files appear in their directory, nothing touches the disk. */
function overlayFileSystem(overlay: Readonly<Record<string, string>>) {
  const files = new Map(Object.entries(overlay).map(([path, text]) => [path.toLowerCase(), text]));
  const extras = new Map<string, string[]>();
  for (const path of Object.keys(overlay)) {
    const dir = dirname(path).toLowerCase();
    extras.set(dir, [...(extras.get(dir) ?? []), basename(path)]);
  }
  return {
    readFile: (path: string) => files.get(path.toLowerCase()),
    fileExists: (path: string) => (files.has(path.toLowerCase()) ? true : undefined),
    getAccessibleEntries: (dir: string) => {
      const extra = extras.get(dir.toLowerCase());
      if (extra === undefined) return undefined;
      const entries = { files: [...extra], directories: [] as string[] };
      for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? entries.directories : entries.files).push(e.name);
      return entries;
    },
  };
}

/**
 * Check every production file of the package, plus the overlaid files (paths
 * relative to src/, with forward slashes), with the package's own project.
 */
export function scanCore(overlay: Readonly<Record<string, string>> = {}): PurityScan {
  const absolute = Object.fromEntries(Object.entries(overlay).map(([rel, text]) => [join(SRC_DIR, ...rel.split('/')), text]));
  const production = [...new Set([...coreSourceFiles(SRC_DIR), ...Object.keys(overlay).filter(isProduction)])].sort();
  const closure = new Set(production.map((rel) => join(SRC_DIR, ...rel.split('/')).toLowerCase()));
  const api = new API({ cwd: REPO_ROOT, fs: overlayFileSystem(absolute) });
  try {
    const project = api.updateSnapshot({ openProjects: [PROJECT] }).getProject(PROJECT);
    const parsed: string[] = [];
    const violations: PurityViolation[] = [];
    for (const rel of production) {
      const path = join(SRC_DIR, ...rel.split('/'));
      const sourceFile = project?.program.getSourceFile(path);
      if (project === undefined || sourceFile === undefined || project.program.getSyntacticDiagnostics(path).length > 0) continue;
      parsed.push(rel);
      violations.push(...new FileCheck(rel, sourceFile, project.checker, closure).run());
    }
    return { parsed, violations };
  } finally {
    api.close();
  }
}

/** Production files under src/, relative to it, with forward slashes. */
function coreSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== TEST_SUPPORT_DIR) out.push(...coreSourceFiles(full));
    } else {
      const rel = relative(SRC_DIR, full).split(sep).join('/');
      if (isProduction(rel)) out.push(rel);
    }
  }
  return out;
}

test('the core has source files to check (an empty scan must not look green)', () => {
  assert.ok(coreSourceFiles(SRC_DIR).length >= 5, 'expected the core modules under src/');
});

test('the scan covers production source only: tests and test support are excluded', () => {
  const scanned = coreSourceFiles(SRC_DIR);
  assert.ok(scanned.includes('task-core.ts'), 'production modules are scanned');
  assert.ok(existsSync(join(SRC_DIR, TEST_SUPPORT_DIR, 'fixtures.ts')), 'the test-support exclusion must be exercised');
  assert.deepEqual(scanned.filter((f) => f.endsWith('.test.ts') || f.split('/').includes(TEST_SUPPORT_DIR)), []);
});

test('every core source file parses and is deterministic: type-only imports from contracts/ports, no denied construct', () => {
  const scan = scanCore();
  assert.deepEqual(scan.parsed, coreSourceFiles(SRC_DIR), 'every production file must parse');
  assert.deepEqual(scan.violations, []);
});

// --- seeded violations: the detector must catch each one -------------------

// The wall-clock read several seeds hide, spelled in two parts: the repository's rule that tests time their waits on
// the monotonic clock reads test source lines and would take a seed's text for a wait. The scanned source is the same.
const CLOCK_READ = 'Date' + '.now()';

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
  { name: 'percent-encoded path into test support', source: 'import { happyAnswer } from "./%74est-support/fixtures.ts";', rule: 'import-target', detail: './%74est-support/fixtures.ts' },
  { name: 'test file behind a query suffix', source: 'import { x } from "./decide.test.ts?cache";', rule: 'import-target', detail: './decide.test.ts?cache' },
  { name: 'fragment suffix', source: 'import { decideTask } from "./task-core.js#x";', rule: 'import-target', detail: './task-core.js#x' },
  { name: 'hidden runtime module outside the scanned set', source: 'import "./purity-hidden.mjs";', rule: 'import-target', detail: './purity-hidden.mjs' },
  { name: 'source extension instead of the built one', source: 'import { decideTask } from "./task-core.ts";', rule: 'import-target', detail: './task-core.ts' },
  { name: 'relative import that does not resolve', source: 'import { x } from "./no-such-module.js";', rule: 'import-target', detail: './no-such-module.js' },
  { name: 'import-equals', source: 'import fs = require("node:fs");', rule: 'import-equals', detail: 'node:fs' },
  { name: 'wall clock', source: `const t = ${CLOCK_READ};`, rule: 'banned-global', detail: 'Date' },
  { name: 'new Date', source: 'const d = new Date();', rule: 'banned-global', detail: 'Date' },
  { name: 'wall clock behind a unicode escape', source: 'const t = \\u0044ate.now();', rule: 'banned-global', detail: 'Date' },
  { name: 'randomness', source: 'const r = Math.random();', rule: 'banned-global', detail: 'Math.random' },
  { name: 'randomness behind a unicode escape', source: 'const r = M\\u0061th.random();', rule: 'banned-global', detail: 'Math.random' },
  { name: 'randomness through an alias', source: 'const m = Math;\nconst r = m.random();', rule: 'banned-global', detail: 'Math' },
  { name: 'randomness through a computed access', source: 'const r = Math["random"]();', rule: 'banned-global', detail: 'Math' },
  { name: 'denied global through a literal computed access', source: 'declare const scope: Record<string, { env: unknown }>;\nconst e = scope["process"].env;', rule: 'banned-global', detail: 'process' },
  { name: 'denied global through a template computed access', source: 'declare const scope: Record<string, unknown>;\nconst d = scope[`Date`];', rule: 'banned-global', detail: 'Date' },
  { name: 'reflected Function constructor reading the clock', source: `const escapedClock = Reflect.get(() => {}, "constructor")("return ${CLOCK_READ}")();`, rule: 'banned-global', detail: 'Reflect' },
  { name: 'Function constructor through a literal key', source: 'const f = (() => {})["constructor"];', rule: 'reflective-member', detail: 'constructor' },
  { name: 'Function constructor through a member access', source: 'const f = (() => {}).constructor;', rule: 'reflective-member', detail: 'constructor' },
  { name: 'Function constructor through a constant key', source: 'const k = "constructor" as const;\nconst f = (() => {})[k];', rule: 'reflective-member', detail: 'constructor' },
  { name: 'key built at run time', source: 'const k = "constr" + "uctor";\nconst f = (() => {})[k];', rule: 'computed-access', detail: '(() => {})[k]' },
  { name: 'key typed as any string', source: 'declare const scope: Record<string, unknown>;\ndeclare const key: string;\nconst v = scope[key];', rule: 'computed-access', detail: 'scope[key]' },
  { name: 'prototype member', source: 'declare const C: { prototype: object };\nconst p = C.prototype;', rule: 'reflective-member', detail: 'prototype' },
  { name: 'prototype setter as a literal property name', source: 'const o = { "__proto__": null };', rule: 'reflective-member', detail: '__proto__' },
  { name: 'computed property name built at run time', source: 'declare const key: string;\nconst o = { [key]: 1 };', rule: 'computed-access', detail: '[key]' },
  { name: 'constructor key in a destructuring pattern', source: 'const { "constructor": F } = () => {};', rule: 'reflective-member', detail: 'constructor' },
  { name: 'constructor key passed as an argument', source: 'declare const read: (o: object, k: string) => unknown;\nconst F = read(() => {}, "constructor");', rule: 'reflective-member', detail: 'constructor' },
  { name: 'Function reached through the prototype descriptors', source: 'const F = Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(() => {})))[4];', rule: 'reflective-member', detail: 'getPrototypeOf' },
  { name: 'Proxy', source: 'const p = new Proxy({}, {});', rule: 'banned-global', detail: 'Proxy' },
  { name: 'clock read through Intl', source: 'const now = new Intl.DateTimeFormat("en").format();', rule: 'banned-global', detail: 'Intl' },
  { name: 'clock read through Temporal', source: 'const now = Temporal.Now.instant();', rule: 'banned-global', detail: 'Temporal' },
  { name: 'timer', source: 'setTimeout(() => 1, 5);', rule: 'banned-global', detail: 'setTimeout' },
  { name: 'process access', source: 'const e = process.env;', rule: 'banned-global', detail: 'process' },
  { name: 'crypto global', source: 'const id = crypto.randomUUID();', rule: 'banned-global', detail: 'crypto' },
  { name: 'require', source: "const fs = require('fs');", rule: 'banned-global', detail: 'require' },
  { name: 'Function constructor', source: 'const f = new Function("return 1");', rule: 'banned-global', detail: 'Function' },
  { name: 'dynamic import', source: "const m = await import('x');", rule: 'dynamic-import', detail: 'import(' },
  { name: 'dynamic import of a computed name', source: 'declare const name: string;\nconst m = await import(name);', rule: 'dynamic-import', detail: 'import(' },
  { name: 'global escape hatch', source: 'const g = globalThis;', rule: 'banned-global', detail: 'globalThis' },
  { name: 'clock inside a template substitution', source: 'const s = `at ${Date.now()}`;', rule: 'banned-global', detail: 'Date' },
  { name: 'test runner in production source', source: "import test from 'node:test';", rule: 'runtime-import', detail: 'node:test' },
  { name: 'locale-dependent number formatting', source: 'export const reviewLocale = (1234.5).toLocaleString();', rule: 'denied-member', detail: 'toLocaleString' },
  { name: 'host read through navigator', source: 'const cores = navigator.hardwareConcurrency;', rule: 'ambient-global', detail: 'navigator' },
  { name: 'locale-dependent comparison', source: 'const order = "ä".localeCompare("z");', rule: 'denied-member', detail: 'localeCompare' },
  { name: 'locale-dependent case mapping', source: 'const upper = "i".toLocaleUpperCase();', rule: 'denied-member', detail: 'toLocaleUpperCase' },
  { name: 'locale member through a literal key', source: 'const s = (1.5)["toLocaleString"]();', rule: 'denied-member', detail: 'toLocaleString' },
  { name: 'locale member name held in a string', source: 'const key = "localeCompare";', rule: 'denied-member', detail: 'localeCompare' },
  { name: 'global outside the allowlist', source: 'const copy = structuredClone({ a: 1 });', rule: 'ambient-global', detail: 'structuredClone' },
  { name: 'host global through a shorthand property', source: 'const host = { navigator };', rule: 'ambient-global', detail: 'navigator' },
  { name: 'host global through a local re-export', source: 'export { navigator };', rule: 'ambient-global', detail: 'navigator' },
  { name: 'host global read under a local ambient declaration', source: 'declare const navigator: { hardwareConcurrency: number };\nconst n = navigator.hardwareConcurrency;', rule: 'ambient-declaration', detail: 'declare' },
  { name: 'global augmentation', source: 'declare global {\n  var hostClock: () => number;\n}\nconst t = hostClock();', rule: 'ambient-declaration', detail: 'declare' },
  { name: 'module metadata of the host', source: 'const where = import.meta.url;', rule: 'ambient-global', detail: 'import.meta' },
  { name: 'stack trace with host paths', source: 'const where = new Error("x").stack;', rule: 'denied-member', detail: 'stack' },
  { name: 'global symbol registry', source: 'const key = Symbol.for("x");', rule: 'denied-member', detail: 'Symbol.for' },
  { name: 'global symbol registry through an alias', source: 'const S = Symbol;\nconst key = S.keyFor(S("x"));', rule: 'banned-global', detail: 'Symbol' },
  // The v6 re-audit's E12: the key is built at run time and asserted to a harmless literal type.
  {
    name: 'Function constructor through an asserted computed key',
    source: `export const reviewClock = ((() => {})[("constr" + "uctor") as "name"] as unknown as (body: string) => () => number)("return ${CLOCK_READ}")();`,
    rule: 'asserted-key',
    detail: '(() => {})[("constr" + "uctor") as "name"]',
  },
  {
    name: 'the same expression is a double cast too',
    source: `export const reviewClock = ((() => {})[("constr" + "uctor") as "name"] as unknown as (body: string) => () => number)("return ${CLOCK_READ}")();`,
    rule: 'double-cast',
    detail: '(() => {})[("constr" + "uctor") as "name"] as unknown as (body: string) => () => number',
  },
  { name: 'angle-bracket assertion in a computed key', source: 'declare const k: string;\nconst f = (() => {})[<"name">k];', rule: 'asserted-key', detail: '(() => {})[<"name">k]' },
  { name: 'assertion in a computed property name', source: 'declare const k: string;\nconst o = { [k as "a"]: 1 };', rule: 'asserted-key', detail: '[k as "a"]' },
  { name: 'assertion nested deep in a computed key', source: 'declare const k: string;\nconst f = (() => {})[(`${k}` as "name")];', rule: 'asserted-key', detail: '(() => {})[(`${k}` as "name")]' },
  { name: 'double cast through unknown', source: 'const f = (() => 1) as unknown as (body: string) => number;', rule: 'double-cast', detail: '(() => 1) as unknown as (body: string) => number' },
  { name: 'double cast through any', source: 'const f = (() => 1) as any as (body: string) => number;', rule: 'double-cast', detail: '(() => 1) as any as (body: string) => number' },
  { name: 'angle-bracket double cast', source: 'const f = <(body: string) => number><unknown>(() => 1);', rule: 'double-cast', detail: '<(body: string) => number><unknown>(() => 1)' },
  { name: 'double cast through parentheses', source: 'const f = ((() => 1) as unknown) as (body: string) => number;', rule: 'double-cast', detail: '((() => 1) as unknown) as (body: string) => number' },
];

const seedFile = (i: number) => `purity-seed-${String(i).padStart(2, '0')}.ts`;
let seededScan: PurityScan | null = null;

/** All seeds in one scan, each as its own production file in src/, next to the module a seed hides behind. */
function scanSeeds(): PurityScan {
  seededScan ??= scanCore({
    ...Object.fromEntries(SEEDED.map((seed, i) => [seedFile(i), `${seed.source}\nexport {};\n`])),
    'purity-hidden.mjs': `export const hiddenClock = ${CLOCK_READ};\n`,
  });
  return seededScan;
}

test('every seeded violation parses, and the real production files stay clean beside them', () => {
  const scan = scanSeeds();
  assert.deepEqual(scan.parsed.filter((f) => f.startsWith('purity-seed-')), SEEDED.map((_s, i) => seedFile(i)), 'a seed that does not parse proves nothing');
  assert.deepEqual(scan.violations.filter((v) => !v.file.startsWith('purity-seed-')), [], 'production files are unaffected');
});

SEEDED.forEach((seed, i) => {
  test(`seeded violation is caught: ${seed.name}`, () => {
    const found = scanSeeds().violations.filter((v) => v.file === seedFile(i));
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
    "import { decideTask } from './task-core.js';",
    "import type { TaskState } from './types.js';",
    "export type { TaskEvent } from './types.js';",
    'export { type TaskId as Task } from "@asep/contracts";',
    "export { decideRun } from './run-core.js';",
    "export * from './types.js';",
    "type Types = typeof import('./types.js');",
    '// Date.now(), Math.random(), toLocaleString() and Reflect in a comment are prose, not code',
    "const label = 'process Date setTimeout Math.random constructor toLocaleString navigator';",
    'const t = `plain template text with Date`;',
    'function counted(processedCount: number): number {',
    '  return processedCount + 1;',
    '}',
    'const m = Math.max(1, 2) + Math.min(1, 2) + Math.ceil(0.5) + Math.floor(0.5) + Math.round(0.5);',
    'const n = Math.abs(-1) + Math.sign(-1) + Math.trunc(-1.5) + Math.imul(2, 3);',
    "type Kind = 'a' | 'b';",
    'function fields(record: { readonly status: string }, kind: Kind, list: readonly number[]) {',
    '  const table: Readonly<Record<Kind, number>> = { a: 1, b: 2 };',
    '  return [record["status"], table[kind], list[0]] as const;',
    '}',
    "const keyed = { ['fixed']: 1 };",
    'const widened = 1 as number;',
    'const narrowed = { kind: "a" } as { readonly kind: Kind };',
    'const unknownOnly = JSON.parse("1") as unknown;',
    'const globals = [',
    '  Object.keys({ a: 1 }), Array.from([1]), Number.isFinite(1), String(1), Boolean(0), BigInt(1),',
    '  new Map<string, number>(), new Set<number>(), JSON.stringify({}), new Error("x").message,',
    '  new RangeError("r"), new TypeError("t"), Symbol("s"), Symbol.iterator, undefined, NaN, Infinity,',
    '];',
    'const shorthand = { label, t };',
    'const { status } = { status: "ok" };',
    'export { label as text };',
    'export { decideTask, label, t, counted, m, n, fields, keyed, widened, narrowed, unknownOnly, globals, shorthand, status };',
    'export type { TaskId, RunId, Id, Contracts, WorkflowEngine, TaskState, Types };',
  ].join('\n');
  const scan = scanCore({ 'purity-clean.ts': clean });
  assert.ok(scan.parsed.includes('purity-clean.ts'), 'the clean file parses');
  assert.deepEqual(scan.violations.filter((v) => v.file === 'purity-clean.ts'), []);
});
