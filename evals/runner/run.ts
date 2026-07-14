// Deterministic evaluation runner.
//
// Loads every labelled fixture under evals/fixtures/, grades it with the pure
// deterministic graders, and produces a stable report. Determinism guarantees
// (Codex P1-OPT-002):
//   - fixtures are loaded in a fixed lexicographic order (sorted by id)
//   - graders are pure (no model, no network, no clock, no randomness)
//   - the report contains NO timestamps, durations, hostnames or paths
//   - JSON is serialized with sorted keys and a trailing newline
// Running the runner twice from a clean checkout yields byte-identical output.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { enforceDeterminism } from './env.js';
import { grade, type EvalTask, type GradeResult } from './graders.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures');

export interface TaskResult {
  readonly id: string;
  readonly grader: string;
  readonly labels: readonly string[];
  readonly passed: boolean;
  readonly reason: string;
}

export interface EvalReport {
  readonly schema: string;
  readonly totalTasks: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly TaskResult[];
}

// Recursively collect *.json fixture files, sorted for deterministic ordering.
function collectFixtureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFixtureFiles(full));
    } else if (entry.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

export function loadTasks(): EvalTask[] {
  const files = collectFixtureFiles(FIXTURES_DIR);
  const tasks = files.map(
    (f) => JSON.parse(readFileSync(f, 'utf8')) as EvalTask,
  );
  // Sort by id for a stable, path-independent order.
  return tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function runEval(): EvalReport {
  enforceDeterminism();
  const tasks = loadTasks();
  const results: TaskResult[] = tasks.map((t) => {
    const g: GradeResult = grade(t);
    return {
      id: t.id,
      grader: t.grader,
      labels: [...t.labels].sort(),
      passed: g.passed,
      reason: g.reason,
    };
  });
  const passed = results.filter((r) => r.passed).length;
  return {
    schema: 'https://asep.dev/schema/eval-report/v1',
    totalTasks: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

// Deterministic JSON serialization: keys sorted recursively, trailing newline.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
