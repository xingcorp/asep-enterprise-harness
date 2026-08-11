// Build-graph fitness test.
//
// THE FAILURE THIS PREVENTS. `pnpm typecheck` and `pnpm build` are both `tsc -b`,
// which walks the *project reference* graph. pnpm also symlinks every workspace
// package into node_modules, so once a dependency's `dist/` exists on disk, TS
// resolves an import through that symlink whether or not the importing project
// declares a `references` entry for it. The two resolution paths mask each other:
//
//   warm tree (dist/ present)  -> import resolves via node_modules  -> PASS
//   clean checkout (no dist/)  -> tsc -b never builds the dependency -> TS2307
//
// So a missing reference is invisible locally and fatal on CI's first run. It also
// cascades: TS2307 on a module makes every value imported from it `any`, which
// then trips noImplicitAny (TS7006) in unrelated-looking lines.
//
// This test closes that gap by comparing, for every workspace TS project, the set
// of @asep/* packages it actually imports against the set it declares as project
// references. A gap is a build-graph defect even while the local tree is green.
//
// It is a real fitness test: it derives both sets from committed source (no
// hard-coded expected list to drift), and the mutation self-tests below prove the
// detector rejects a seeded gap rather than passing by matching nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

// Machine-readable suite marker: the canonical runner asserts this line is
// present so the fitness suite cannot be silently dropped from discovery.
console.log('SUITE-ID: asep-suite:project-references');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// Every directory group that holds a compiled workspace project.
const PROJECT_GROUPS = ['packages', 'adapters', 'apps', 'workers', 'evals'] as const;

interface Project {
  readonly name: string;
  readonly dir: string;
  readonly tsconfig: string;
}

// tsconfig.json permits comments; JSON.parse does not.
function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readJsonc(path: string): Record<string, unknown> {
  return JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as Record<string, unknown>;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Discover projects from the filesystem so a newly added package is covered the
// moment it lands, with no list here to update.
function discoverProjects(): { projects: Project[]; nameToDir: Map<string, string> } {
  const projects: Project[] = [];
  const nameToDir = new Map<string, string>();
  for (const group of PROJECT_GROUPS) {
    const groupDir = join(REPO_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = join(groupDir, entry);
      if (!statSync(dir).isDirectory()) continue;
      const pkgJson = join(dir, 'package.json');
      const tsconfig = join(dir, 'tsconfig.json');
      if (!existsSync(pkgJson) || !existsSync(tsconfig)) continue;
      const name = readJsonc(pkgJson)['name'];
      if (typeof name !== 'string') continue;
      projects.push({ name, dir, tsconfig });
      nameToDir.set(name, dir);
    }
  }
  return { projects, nameToDir };
}

// The @asep/* specifiers a project's source actually imports. Matched against the
// module specifier only (the quoted string), never arbitrary code, so a mention in
// a comment or an identifier cannot produce a false positive.
function importedWorkspacePackages(projectDir: string): Set<string> {
  const found = new Set<string>();
  const srcDir = join(projectDir, 'src');
  for (const file of walkTs(existsSync(srcDir) ? srcDir : projectDir)) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/from\s+'(@asep\/[a-z0-9-]+)'/g)) found.add(m[1]!);
    for (const m of source.matchAll(/import\s*\(\s*'(@asep\/[a-z0-9-]+)'/g)) found.add(m[1]!);
    for (const m of source.matchAll(/require\(\s*'(@asep\/[a-z0-9-]+)'/g)) found.add(m[1]!);
  }
  return found;
}

function declaredReferences(tsconfigPath: string, projectDir: string): Set<string> {
  const raw = readJsonc(tsconfigPath);
  const refs = Array.isArray(raw['references']) ? (raw['references'] as { path?: string }[]) : [];
  return new Set(
    refs
      .map((r) => r.path)
      .filter((p): p is string => typeof p === 'string')
      .map((p) => resolve(projectDir, p)),
  );
}

// Pure detector, exported shape so the self-tests can drive it on fixtures.
function findGaps(
  imports: ReadonlySet<string>,
  references: ReadonlySet<string>,
  nameToDir: ReadonlyMap<string, string>,
): string[] {
  const gaps: string[] = [];
  for (const spec of [...imports].sort()) {
    const targetDir = nameToDir.get(spec);
    // Not a workspace TS project (external dependency) — references do not apply.
    if (!targetDir) continue;
    if (!references.has(resolve(targetDir))) gaps.push(spec);
  }
  return gaps;
}

test('every workspace project declares a reference for each @asep/* package it imports', () => {
  const { projects, nameToDir } = discoverProjects();

  // Guard against the detector silently scanning nothing: if discovery breaks,
  // an empty project set would make this suite vacuously green.
  assert.ok(
    projects.length >= 10,
    `expected to discover at least 10 workspace projects, found ${projects.length}`,
  );

  const violations: string[] = [];
  for (const project of projects) {
    const imports = importedWorkspacePackages(project.dir);
    const references = declaredReferences(project.tsconfig, project.dir);
    for (const gap of findGaps(imports, references, nameToDir)) {
      violations.push(
        `${relative(REPO_ROOT, project.dir)} imports ${gap} but declares no project reference for it ` +
          `(cold \`tsc -b\` cannot order the build and fails with TS2307)`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `build-graph gaps found — these pass on a warm tree and fail on a clean checkout:\n  ${violations.join('\n  ')}`,
  );
});

test('self-check: the detector REJECTS a seeded missing reference', () => {
  const nameToDir = new Map([
    ['@asep/observability', '/repo/packages/observability'],
    ['@asep/ports', '/repo/packages/ports'],
  ]);
  const imports = new Set(['@asep/observability', '@asep/ports']);
  // Declares ports but NOT observability — exactly the shape of the real defect.
  const references = new Set(['/repo/packages/ports']);

  const gaps = findGaps(imports, references, nameToDir);
  assert.deepEqual(gaps, ['@asep/observability']);
});

test('self-check: a fully-referenced project is NOT flagged', () => {
  const nameToDir = new Map([
    ['@asep/observability', '/repo/packages/observability'],
    ['@asep/ports', '/repo/packages/ports'],
  ]);
  const imports = new Set(['@asep/observability', '@asep/ports']);
  const references = new Set(['/repo/packages/observability', '/repo/packages/ports']);

  assert.deepEqual(findGaps(imports, references, nameToDir), []);
});

test('self-check: an external (non-workspace) import is NOT treated as a gap', () => {
  const nameToDir = new Map([['@asep/ports', '/repo/packages/ports']]);
  // `pg` and `@anthropic-ai/sdk` are real dependencies, not workspace projects:
  // they resolve through node_modules and need no project reference.
  const imports = new Set(['@asep/ports', '@asep/not-a-workspace-package']);
  const references = new Set(['/repo/packages/ports']);

  assert.deepEqual(findGaps(imports, references, nameToDir), []);
});

test('self-check: import-specifier matching ignores mentions in comments and identifiers', () => {
  // Proves the scanner keys on the quoted module specifier. A doc comment naming a
  // package, or an identifier containing the text, must not register as an import.
  const decoy = [
    "// see @asep/observability for the span vocabulary",
    "const asepObservabilityNote = 'not an import';",
    "import { x } from '@asep/ports';",
  ].join('\n');

  const found = new Set<string>();
  for (const m of decoy.matchAll(/from\s+'(@asep\/[a-z0-9-]+)'/g)) found.add(m[1]!);

  assert.deepEqual([...found], ['@asep/ports']);
});
