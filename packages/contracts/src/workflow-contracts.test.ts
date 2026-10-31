// The workflow contracts: task-workflow-input, run-workflow-input and
// workflow-control. They travel into durable workflow history, so they carry
// identifiers, references, closed enums and numbers only:
//   - every string field is constrained by a pattern, an enum or a format, so no
//     free text can enter history through them;
//   - each is at 1.0.0 with a v1 $id and a frozen v1 snapshot;
//   - the control message is a union discriminated by kind, in its generated
//     type as in its schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RunWorkflowInput, TaskWorkflowInput, WorkflowControlMessage } from './generated.js';
import { contractVersion, validate, type ContractName } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', 'schema');
const FIXTURES = join(HERE, '..', 'fixtures');

const WORKFLOW_CONTRACTS: readonly ContractName[] = ['task-workflow-input', 'run-workflow-input', 'workflow-control'];

type Node = Readonly<Record<string, unknown>>;

/** Every string-typed node of a schema, with its location. */
function stringNodes(node: unknown, at: string, out: { at: string; node: Node }[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => stringNodes(child, `${at}[${i}]`, out));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const n = node as Node;
  const type = n['type'];
  if (type === 'string' || (Array.isArray(type) && type.includes('string'))) out.push({ at, node: n });
  for (const [key, child] of Object.entries(n)) {
    if (key === 'examples' || key === 'enum') continue;
    stringNodes(child, `${at}/${key}`, out);
  }
}

function schemaOf(name: ContractName): Node {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), 'utf8')) as Node;
}

test('every string field of the workflow contracts is constrained by a pattern, an enum or a format', () => {
  for (const name of WORKFLOW_CONTRACTS) {
    const strings: { at: string; node: Node }[] = [];
    stringNodes(schemaOf(name), name, strings);
    assert.ok(strings.length > 0, `${name} has string fields`);
    const loose = strings.filter(({ node }) => !('pattern' in node) && !('enum' in node) && !('format' in node)).map(({ at }) => at);
    assert.deepEqual(loose, [], `${name}: unconstrained string fields`);
  }
});

test('the check for unconstrained strings finds one hidden in a control variant', () => {
  const schema = JSON.parse(JSON.stringify(schemaOf('workflow-control'))) as { oneOf: { properties: Record<string, unknown> }[] };
  schema.oneOf[2]!.properties['note'] = { type: 'string', maxLength: 200 };
  const strings: { at: string; node: Node }[] = [];
  stringNodes(schema, 'workflow-control', strings);
  assert.deepEqual(
    strings.filter(({ node }) => !('pattern' in node) && !('enum' in node) && !('format' in node)).map(({ at }) => at),
    ['workflow-control/oneOf[2]/properties/note'],
  );
});

test('the workflow contracts are new v1 contracts at 1.0.0 with a frozen v1 snapshot', () => {
  for (const name of WORKFLOW_CONTRACTS) {
    const live = schemaOf(name);
    assert.equal(contractVersion(name), '1.0.0', name);
    assert.equal(live['$id'], `https://asep.dev/schema/${name}/v1`, name);
    const snapshot = readFileSync(join(SCHEMA_DIR, 'snapshots', 'v1', `${name}.schema.json`), 'utf8');
    assert.deepEqual(JSON.parse(snapshot), live, `${name}: the v1 snapshot is the schema as it lands`);
  }
});

const ID = {
  request: '01K000000000000000000000Q1',
  task: '01K00000000000000000000005',
  run: '01K00000000000000000000004',
  approval: '01K000000000000000000000A1',
  principal: '01K00000000000000000000009',
};

test('the generated control type is a union discriminated by kind, and the schema agrees with it', () => {
  const messages: WorkflowControlMessage[] = [
    { kind: 'pause', requestId: ID.request, target: { scope: 'task', id: ID.task }, principalId: ID.principal },
    { kind: 'resume', requestId: ID.request, target: { scope: 'run', id: ID.run }, principalId: ID.principal },
    { kind: 'seal', requestId: ID.request, target: { scope: 'run', id: ID.run }, principalId: ID.principal },
    { kind: 'approval-decision', requestId: ID.request, approvalRequestId: ID.approval, decision: 'approve', extensionUsd: 12.5, principalId: ID.principal },
    { kind: 'approval-decision', requestId: ID.request, approvalRequestId: ID.approval, decision: 'reject', extensionUsd: null, principalId: ID.principal },
  ];
  for (const message of messages) {
    assert.deepEqual(validate('workflow-control', message).errors, [], message.kind);
  }
  // @ts-expect-error a seal targets a run, never a task
  const sealTask: WorkflowControlMessage = { kind: 'seal', requestId: ID.request, target: { scope: 'task', id: ID.task }, principalId: ID.principal };
  assert.equal(validate('workflow-control', sealTask).valid, false);
  // @ts-expect-error cancel is the engine's workflow cancellation, not a message
  const cancel: WorkflowControlMessage = { kind: 'cancel', requestId: ID.request, target: { scope: 'task', id: ID.task }, principalId: ID.principal };
  assert.equal(validate('workflow-control', cancel).valid, false);
});

test('the generated input types read the fixtures that the schemas accept', () => {
  const task = JSON.parse(readFileSync(join(FIXTURES, 'valid', 'task-workflow-input-basic.json'), 'utf8')) as TaskWorkflowInput;
  const run = JSON.parse(readFileSync(join(FIXTURES, 'valid', 'run-workflow-input-fixed-tasks.json'), 'utf8')) as RunWorkflowInput;
  assert.equal(validate('task-workflow-input', task).valid, true);
  assert.equal(validate('run-workflow-input', run).valid, true);
  const checkCommands: readonly string[] = task.verification.checks.map((c) => c.commandId);
  assert.deepEqual(checkCommands, ['pnpm-typecheck', 'pnpm-test']);
  const fixed: readonly string[] | null = run.fixedTasks;
  assert.deepEqual(fixed, [ID.task, '01K0000000000000000000000T']);
});

test('a money amount above the input bound, or a non-positive cap, is refused at the boundary', () => {
  const task = JSON.parse(readFileSync(join(FIXTURES, 'valid', 'task-workflow-input-basic.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  for (const [path, value] of [
    [['taskBudget', 'maxCostUsd'], 0],
    [['taskBudget', 'maxCostUsd'], 100_000_000.000001],
    [['attemptBudget', 'maxCostUsd'], 0],
    [['runRemaining', 'costUsd'], -1],
    [['policy', 'maxBudgetExtensionUsd'], 0],
    [['taskBudget', 'maxAttempts'], 11],
    [['governance', 'approvalTtlSeconds'], 59],
    [['governance', 'maxPauseHours'], 169],
  ] as const) {
    const bad = JSON.parse(JSON.stringify(task)) as Record<string, Record<string, unknown>>;
    bad[path[0]]![path[1]] = value;
    assert.equal(validate('task-workflow-input', bad).valid, false, `${path.join('.')} = ${value}`);
  }
});
