import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate } from '@asep/contracts';
import { runEval, loadTasks, stableStringify } from './run.js';
import { graderIds, type EvalTask } from './graders.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures');
const SCHEMA_PATH = join(HERE, '..', 'schema', 'eval-task.schema.json');

// Load the eval-task schema into the contracts validator by hand: it is an
// eval-local schema, so we compile it directly with a minimal ajv setup mirror.
// Simpler: assert structural invariants the runner relies on, plus validate
// each fixture against the JSON Schema via a tiny inline ajv instance.

function allFixtures(): { file: string; task: EvalTask }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      task: JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as EvalTask,
    }));
}

test('there are at most 10 synthetic seeds (D4)', () => {
  const fixtures = allFixtures();
  assert.ok(fixtures.length <= 10, `expected <=10 seeds, found ${fixtures.length}`);
  assert.ok(fixtures.length >= 9, 'expected coverage of all 9 grader categories');
});

test('every fixture is labelled with a synthetic source, never fabricated history (D4)', () => {
  // Phase 1 fixtures must be synthetic — either a plain synthetic seed or an
  // adversarial-synthetic one (the prompt-injection task). What is BARRED is a
  // fixture masquerading as a real `historical` task, which would smuggle in
  // fabricated provenance. Both synthetic classes are acceptable here.
  const SYNTHETIC_SOURCES = new Set(['synthetic', 'adversarial-synthetic']);
  for (const { file, task } of allFixtures()) {
    assert.ok(
      SYNTHETIC_SOURCES.has(task.source),
      `${file} must be a synthetic source (got "${task.source}"); real historical tasks are not a Phase 1 deliverable`,
    );
  }
});

test('every fixture carries a privacy class and provenance (no fabricated history)', () => {
  for (const { file, task } of allFixtures()) {
    const t = task as unknown as Record<string, unknown>;
    assert.ok(t['privacyClass'], `${file} missing privacyClass`);
    assert.ok(t['provenance'], `${file} missing provenance`);
  }
});

test('fixtures cover all nine grader categories (D3)', () => {
  const seen = new Set(allFixtures().map(({ task }) => task.grader));
  for (const id of graderIds()) {
    assert.ok(seen.has(id), `no fixture exercises grader "${id}"`);
  }
});

test('negative cases are present and graded (D5)', () => {
  const byGrader = new Map(allFixtures().map(({ task }) => [task.grader, task]));
  for (const neg of ['prompt-injection', 'scope-violation', 'false-completion'] as const) {
    assert.ok(byGrader.has(neg), `missing negative-case fixture for ${neg}`);
  }
  // And they must actually pass their expected verdict when graded.
  const report = runEval();
  const negIds = [
    'eval-07-prompt-injection',
    'eval-08-scope-violation',
    'eval-09-false-completion',
  ];
  for (const id of negIds) {
    const r = report.results.find((x) => x.id === id);
    assert.ok(r, `no result for ${id}`);
    assert.equal(r!.passed, true, `${id} did not grade as expected: ${r!.reason}`);
  }
});

test('the full eval suite passes (every fixture grades to its expected verdict)', () => {
  const report = runEval();
  assert.equal(report.failed, 0, `failing tasks: ${JSON.stringify(report.results.filter((r) => !r.passed))}`);
  assert.equal(report.passed, report.totalTasks);
});

test('runner output is deterministic: two runs are byte-identical (D2)', () => {
  const a = stableStringify(runEval());
  const b = stableStringify(runEval());
  assert.equal(a, b);
});

test('loadTasks returns a stable, id-sorted order (D2)', () => {
  const ids = loadTasks().map((t) => t.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
});

test('every fixture validates against eval-task.schema.json (D1)', async () => {
  // Compile the eval-task schema with the same ajv the contracts package uses.
  const Ajv2020Ns = (await import('ajv/dist/2020.js')).default as unknown as {
    default?: new (o?: Record<string, unknown>) => {
      compile: (s: unknown) => (d: unknown) => boolean;
    };
  };
  const Ctor = (Ajv2020Ns as { default?: unknown }).default ?? Ajv2020Ns;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ajv = new (Ctor as any)({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const validateTask = ajv.compile(schema);
  for (const { file, task } of allFixtures()) {
    const ok = validateTask(task);
    assert.ok(ok, `${file} failed eval-task schema: ${JSON.stringify(validateTask.errors)}`);
  }
  // sanity: the contracts validator is reachable from evals (dependency wired)
  assert.equal(typeof validate, 'function');
});
