// The review-loop slot as it lands: the locked block in source, the
// conformance kit run against the three slots of this package, and the kit's own
// oracles shown to refuse broken subjects.
//
//   - the three review-loop files reassemble into the locked block byte for byte
//     (its sha256 is pinned here and checked in the plan's verbatim copy too);
//   - NotConfiguredAssuranceSlot, the default binding, passes every case on a real
//     database (PGlite), the stateful ones included (it records terminal events);
//   - the literal opt-out and the scripted slot, both stateless, pass every case
//     a stateless slot can, with all four outcome kinds;
//   - the default slot proceeds without review only for R0 and R1;
//   - each attempt terminal, and verification ERROR, is stored as the events its
//     meaning says, against an oracle written apart from the slot's own table;
//   - subjects broken on purpose (no fence check, no lease history check, a
//     non-atomic write, an outcome that breaks an invariant, an effect before
//     registration, resolvers that skip a check) fail the case that guards it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ArtifactId, AttemptId, OrganizationId, ProjectId, RepositoryBindingId, RiskLevel, RunEvent, RunId, TaskId, TenantScope,
} from '@asep/contracts';
import type { AttemptRef, AttemptTerminalStore } from '@asep/ports';
import { PgliteClient, SqlAttemptTerminalStore, SqlWorkspaceLeaseRepository, migrate } from '@asep/persistence';
import type { SqlClient, SqlExecutor } from '@asep/persistence';
import {
  AssuranceCancelledError,
  AssuranceFencedError,
  REVIEW_LOOP_DISABLED,
  REVIEW_LOOP_SLOT_VERSION,
  ReviewLoopContractError,
  type AssuranceFence,
  type AssuranceOutcome,
  type AssuranceSlotInput,
  type AssuranceStepContext,
  type AssuranceWorkspaceResolver,
  type AttemptTerminal,
  type LeasedAttemptOutcomeInput,
  type PreLeaseAttemptOutcomeInput,
  type ReviewLoopContractErrorCode,
  type ReviewLoopSlot,
} from '../review-loop/slot.js';
import { createDisabledAssuranceSlot } from '../review-loop/disabled-slot.js';
import {
  createScriptedReviewLoopSlot,
  runRegistrationOrderingContract,
  runReviewLoopContract,
  runWorkspaceResolverContract,
  type ReviewLoopConformanceResult,
  type ReviewLoopConformanceSubject,
  type ScriptedReviewLoopScript,
  type WorkspaceResolverConformanceFixture,
} from '../review-loop/review-loop-contract.js';
import { AssuranceUnavailableError, NotConfiguredAssuranceSlot } from './not-configured-slot.js';
import { recordPreLeaseOutcome } from './pre-lease-outcome.js';

console.log('SUITE-ID: asep-suite:assurance-slot-contract');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

/** sha256 of the slot block the controller handed over (894 lines), as locked at Lane B's 287ed0f. */
const LOCKED_SLOT_BLOCK_SHA256 = '9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a';

// ---------------------------------------------------------------------------
// The locked block in source and in the plan
// ---------------------------------------------------------------------------

const BANNER_RULE = '// ===========================================================================';
const END_OF_BLOCK = '// === end of the locked slot block text ===';
// A declared function of the block, as source implements it: the signature unchanged, `declare` dropped, and a
// body that is one return statement.
const IMPLEMENTED_DECLARATION = /^export function (\w+)\(([\s\S]*?)\): ([^\n]*?) \{\n {2}return [^\n]*;\n\}$/gm;

function read(path: string): string {
  return readFileSync(join(HERE, path), 'utf8');
}

/** A split section of the block: from its banner to the end marker, with the declared functions declared again. */
function sectionOf(source: string): { readonly text: string; readonly declared: readonly string[] } {
  const lines = source.split('\n');
  const start = lines.indexOf(BANNER_RULE);
  const end = lines.indexOf(END_OF_BLOCK);
  assert.ok(start >= 0 && end > start, 'the section has its banner and the end marker');
  const declared: string[] = [];
  const text = lines.slice(start, end).join('\n').replace(IMPLEMENTED_DECLARATION, (_m, name: string, params: string, ret: string) => {
    declared.push(name);
    return `export declare function ${name}(${params}): ${ret};`;
  });
  return { text, declared };
}

function reassembledBlock(): { readonly block: string; readonly declared: readonly string[] } {
  const disabled = sectionOf(read('../review-loop/disabled-slot.ts'));
  const kit = sectionOf(read('../review-loop/review-loop-contract.ts'));
  return {
    block: `${read('../review-loop/slot.ts')}\n${disabled.text}\n${kit.text}`,
    declared: [...disabled.declared, ...kit.declared],
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

test('the three review-loop files reassemble into the locked slot block byte for byte', () => {
  const { block, declared } = reassembledBlock();
  assert.deepEqual(declared, [
    'createDisabledAssuranceSlot', 'runReviewLoopContract', 'runRegistrationOrderingContract',
    'runWorkspaceResolverContract', 'createScriptedReviewLoopSlot',
  ]);
  assert.equal(block.split('\n').length - 1, 894);
  assert.equal(sha256(block), LOCKED_SLOT_BLOCK_SHA256);
  // The check has teeth: one changed byte in any section changes the hash.
  assert.notEqual(sha256(block.replace('review-loop/v1', 'review-loop/v2')), LOCKED_SLOT_BLOCK_SHA256);
});

test('the plan carries the same locked block verbatim under its slot-contract heading', () => {
  const plan = readFileSync(join(REPO, 'docs', 'implementation', 'phases', 'phase-03-plan.md'), 'utf8');
  const heading = plan.indexOf('#### Review-loop slot contract (verbatim for S0)');
  assert.ok(heading >= 0, 'the slot-contract heading is present');
  const open = plan.indexOf('```typescript\n', heading);
  const close = plan.indexOf('\n```\n', open);
  assert.ok(open > heading && close > open, 'a typescript fence follows the heading');
  const copy = plan.slice(open + '```typescript\n'.length, close + 1);
  assert.equal(sha256(copy), LOCKED_SLOT_BLOCK_SHA256);
  assert.ok(plan.includes(LOCKED_SLOT_BLOCK_SHA256), 'the plan states the sha256 it pins');
});

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

const makeCtx = (logicalTime: string): AssuranceStepContext => ({
  signal: new AbortController().signal,
  now: () => logicalTime,
  heartbeat: () => undefined,
});

const IDS = {
  organizationId: '01K00000000000000000000001' as OrganizationId,
  projectId: '01K00000000000000000000002' as ProjectId,
  bindingId: '01K00000000000000000000003' as RepositoryBindingId,
  runId: '01K00000000000000000000004' as RunId,
  taskId: '01K00000000000000000000005' as TaskId,
  attemptId: '01K00000000000000000000006' as AttemptId,
};
const SCOPE: TenantScope = { organizationId: IDS.organizationId, projectId: IDS.projectId };

const ref = (kind: string, n: number) => ({ artifactId: `01K0000000000000000000A${n}`.padEnd(26, '0') as ArtifactId, sha256: String(n).repeat(64).slice(0, 64), kind });

function slotInput(fence: AssuranceFence, risk: RiskLevel = 'R0'): AssuranceSlotInput {
  return {
    slotVersion: REVIEW_LOOP_SLOT_VERSION,
    idempotencyKey: `${IDS.attemptId}:assurance:1`,
    scope: SCOPE,
    repositoryBindingId: IDS.bindingId,
    runId: IDS.runId,
    taskId: IDS.taskId,
    attemptId: IDS.attemptId,
    risk,
    round: 1,
    evidenceRef: ref('evidence-bundle', 1),
    workOrderRef: ref('work-order', 2),
    taskBaseSha: 'a'.repeat(40),
    resultSha: 'b'.repeat(40),
    implementer: { providerId: 'claude-code', model: 'claude-opus-5-5' },
    declaredComplete: true,
    priorAdjudicationId: null,
    fence,
    budgetRemaining: { costMicroUsd: 4_000_000, wallClockMs: 1_800_000 },
  };
}

function leasedOutcome(fence: AssuranceFence, attemptId: AttemptId = IDS.attemptId): LeasedAttemptOutcomeInput {
  return {
    slotVersion: REVIEW_LOOP_SLOT_VERSION,
    scope: SCOPE,
    repositoryBindingId: IDS.bindingId,
    runId: IDS.runId,
    taskId: IDS.taskId,
    attemptId,
    risk: 'R0',
    round: 1,
    declaredComplete: true,
    verificationVerdict: 'PASS',
    adjudicationId: 'c'.repeat(64),
    assuranceUnavailable: false,
    failureClass: null,
    cost: { modelCostMicroUsd: 1_250_000, computeCostMicroUsd: null, inputTokens: 1200, outputTokens: 300, toolCalls: 7 },
    terminal: 'proceeded',
    fence,
  };
}

/**
 * PGlite is one in-process connection: two overlapping transactions on it would interleave their statements. The
 * fixture's client queues every statement and transaction, as a single connection does, and can make the next
 * transaction fail at its end, after its statements, so that nothing of it commits.
 */
class SingleConnection implements SqlClient {
  private chain: Promise<unknown> = Promise.resolve();
  private failNext = false;

  constructor(private readonly db: SqlClient) {}

  failNextCommit(): void {
    this.failNext = true;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  query(text: string, params?: Parameters<SqlExecutor['query']>[1]) {
    return this.serial(() => this.db.query(text, params));
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.serial(() => this.db.transaction(async (tx) => {
      const out = await fn(tx);
      if (this.failNext) {
        this.failNext = false;
        throw new Error('injected failure at commit');
      }
      return out;
    }));
  }

  ping(): Promise<boolean> {
    return this.db.ping();
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

const openDbs: PgliteClient[] = [];
test.after(async () => {
  for (const db of openDbs.splice(0)) await db.close();
});

async function seededDb(): Promise<SingleConnection> {
  const raw = await PgliteClient.create();
  openDbs.push(raw);
  await migrate(raw);
  const q = (sql: string, params: unknown[]) => raw.query(sql, params as never);
  await q('insert into organizations (id, name) values ($1, $2)', [IDS.organizationId, 'acme']);
  await q(`insert into projects (id, organization_id, name, default_branch) values ($1, $2, 'web', 'main')`, [IDS.projectId, IDS.organizationId]);
  await q(
    `insert into repository_bindings (id, organization_id, project_id, forge, github_host, github_owner, github_repo, default_base_branch)
     values ($1, $2, $3, 'github', 'github.com', 'acme', 'web', 'main')`,
    [IDS.bindingId, IDS.organizationId, IDS.projectId],
  );
  await q(`insert into runs (id, organization_id, project_id, repository_binding_id, status, risk) values ($1, $2, $3, $4, 'EXECUTING', 'R0')`,
    [IDS.runId, IDS.organizationId, IDS.projectId, IDS.bindingId]);
  await q(`insert into tasks (id, organization_id, project_id, run_id, repository_binding_id, status, risk) values ($1, $2, $3, $4, $5, 'EXECUTING', 'R0')`,
    [IDS.taskId, IDS.organizationId, IDS.projectId, IDS.runId, IDS.bindingId]);
  return new SingleConnection(raw);
}

async function registerAttempt(db: SqlClient, attemptId: AttemptId): Promise<AttemptRef> {
  await db.query(
    `insert into attempts (id, organization_id, project_id, task_id, repository_binding_id, status) values ($1, $2, $3, $4, $5, 'STARTED')`,
    [attemptId, IDS.organizationId, IDS.projectId, IDS.taskId, IDS.bindingId],
  );
  return { repositoryBindingId: IDS.bindingId, runId: IDS.runId, taskId: IDS.taskId, attemptId };
}

const branchOf = (attemptId: AttemptId) => `asep/attempt-${attemptId}`;

async function canonicalRows(db: SqlClient, sql: string, params: readonly (string | null)[]): Promise<string> {
  const r = await db.query(sql, params);
  return JSON.stringify(r.rows.map((row) => Object.keys(row).sort().map((k) => {
    const v = row[k];
    return [k, v instanceof Date ? v.toISOString() : v];
  })));
}

/**
 * The default slot over the attempt-terminal store on a fresh database. `wrapStore` lets a test break the store on
 * purpose; the fixture's lease hooks always use the real store and the workspace lease repository.
 */
function notConfiguredSubject(wrapStore: (store: AttemptTerminalStore, db: SqlClient) => AttemptTerminalStore = (s) => s): ReviewLoopConformanceSubject {
  return async () => {
    const db = await seededDb();
    const store = new SqlAttemptTerminalStore(db);
    const leases = new SqlWorkspaceLeaseRepository(db);
    const attempt = await registerAttempt(db, IDS.attemptId);
    const fenceOf = (lease: Awaited<ReturnType<SqlAttemptTerminalStore['acquireLease']>>): AssuranceFence => {
      if ('denied' in lease) throw new Error(`lease denied: ${lease.reason}`);
      return { leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch };
    };
    let current = fenceOf(await store.acquireLease(SCOPE, { attempt, branch: branchOf(IDS.attemptId), ttlMs: 3_600_000 }));
    let preLeaseCount = 0;
    const slot = new NotConfiguredAssuranceSlot(wrapStore(store, db));
    return {
      slot,
      fixture: {
        stateless: false,
        input: slotInput(current),
        pushGuardInput: null,
        attemptOutcome: leasedOutcome(current),
        prepareRepair: null,
        async rotateFence() {
          // A handoff: the holder's lease expires and the next acquirer takes the branch at the next epoch.
          await db.query(`update workspace_leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [current.leaseId]);
          const next = await leases.acquire(SCOPE, { repositoryBindingId: IDS.bindingId, branch: branchOf(IDS.attemptId), attemptId: IDS.attemptId, ttlMs: 3_600_000 });
          current = fenceOf(next);
          return current;
        },
        async endLease() {
          await leases.release(SCOPE, current.leaseId);
        },
        async preLeaseAttempt() {
          preLeaseCount += 1;
          const attemptId = `01K000000000000000000000P${preLeaseCount}`.padEnd(26, '0').slice(0, 26) as AttemptId;
          const pre = await registerAttempt(db, attemptId);
          let granted: AssuranceFence | null = null;
          return {
            attemptOutcome: {
              ...leasedOutcome(current, attemptId),
              terminal: 'infrastructure-failed',
              fence: null,
              declaredComplete: false,
              verificationVerdict: null,
              adjudicationId: null,
              failureClass: 'environment',
              cost: null,
            },
            async acquireLease() {
              const lease = await store.acquireLease(SCOPE, { attempt: pre, branch: branchOf(attemptId), ttlMs: 3_600_000 });
              if ('denied' in lease) {
                if (lease.reason !== 'attempt-terminal-recorded') throw new Error(`lease denied: ${lease.reason}`);
                return null;
              }
              granted = { leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch };
              return granted;
            },
            async endLease() {
              if (granted !== null) await leases.release(SCOPE, granted.leaseId);
            },
          };
        },
        failNextCommit: () => db.failNextCommit(),
        persistedRoundBytes: (roundKey: string) => canonicalRows(db,
          `select event_id, event_type, schema_version, occurred_at, payload, payload_sha256 from run_events
            where organization_id = $1 and project_id = $2 and event_id like $3 order by event_id`,
          [IDS.organizationId, IDS.projectId, `${roundKey}%`]),
        persistedAttemptBytes: (attemptId: AttemptId) => canonicalRows(db,
          `select event_id, event_type, schema_version, occurred_at, payload, payload_sha256 from run_events
            where organization_id = $1 and project_id = $2 and attempt_id = $3 order by event_id`,
          [IDS.organizationId, IDS.projectId, attemptId]),
      },
    };
  };
}

const STATIC_FENCE: AssuranceFence = { leaseId: '01K00000000000000000000007', fencingEpoch: 3 };

function statelessSubject(slot: () => ReviewLoopSlot, options: {
  readonly pushGuard?: boolean;
  readonly repair?: boolean;
} = {}): ReviewLoopConformanceSubject {
  return async () => {
    const input = slotInput(STATIC_FENCE);
    return {
      slot: slot(),
      fixture: {
        stateless: true,
        input,
        pushGuardInput: options.pushGuard === true ? input : null,
        attemptOutcome: leasedOutcome(STATIC_FENCE),
        prepareRepair: options.repair === true
          ? async () => ({
            input: {
              slotVersion: REVIEW_LOOP_SLOT_VERSION,
              scope: SCOPE,
              attemptId: '01K00000000000000000000007' as AttemptId,
              originalContextPackRef: ref('context-pack', 3),
              repairOrderRef: ref('repair-order', 4),
              fence: { ...STATIC_FENCE, fencingEpoch: 1 },
            },
            rotateFence: async () => ({ ...STATIC_FENCE, fencingEpoch: 2 }),
          })
          : null,
        rotateFence: null,
        endLease: null,
        preLeaseAttempt: null,
        failNextCommit: null,
        persistedRoundBytes: null,
        persistedAttemptBytes: null,
      },
    };
  };
}

function byCase(results: readonly ReviewLoopConformanceResult[]): Record<string, ReviewLoopConformanceResult> {
  return Object.fromEntries(results.map((r) => [r.caseId, r]));
}

function assertOutcomes(results: readonly ReviewLoopConformanceResult[], expected: Readonly<Record<string, 'passed' | 'not-applicable'>>): void {
  const got = byCase(results);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort(), 'the kit ran exactly RLC-01…RLC-18');
  for (const [caseId, status] of Object.entries(expected)) {
    assert.equal(got[caseId]?.status, status, `${caseId}: ${got[caseId]?.detail ?? 'missing'}`);
  }
}

const ALL_CASES = Array.from({ length: 18 }, (_, i) => `RLC-${String(i + 1).padStart(2, '0')}`);
const expectAll = (status: 'passed', except: Readonly<Record<string, 'not-applicable'>> = {}) =>
  Object.fromEntries(ALL_CASES.map((c) => [c, except[c] ?? status]));
const STATELESS_NA = {
  'RLC-05': 'not-applicable', 'RLC-13': 'not-applicable', 'RLC-14': 'not-applicable', 'RLC-16': 'not-applicable',
  'RLC-17': 'not-applicable', 'RLC-18': 'not-applicable',
} as const;

// ---------------------------------------------------------------------------
// The kit against the three slots
// ---------------------------------------------------------------------------

test('NotConfiguredAssuranceSlot passes every case of the kit on a real database, the stateful ones included', async () => {
  const results = await runReviewLoopContract(notConfiguredSubject(), makeCtx);
  assertOutcomes(results, expectAll('passed', { 'RLC-12': 'not-applicable' }));
  console.log(`not-configured RLC-16: ${byCase(results)['RLC-16']?.detail}`);
});

test('the disabled slot (the literal opt-out) passes every case a stateless slot can', async () => {
  const results = await runReviewLoopContract(statelessSubject(() => createDisabledAssuranceSlot(REVIEW_LOOP_DISABLED)), makeCtx);
  assertOutcomes(results, expectAll('passed', { ...STATELESS_NA, 'RLC-12': 'not-applicable' }));
});

const SCRIPTS: ReadonlyArray<readonly [string, ScriptedReviewLoopScript, { readonly pushGuard?: boolean; readonly repair?: boolean }]> = [
  ['PROCEED not-required', { mode: 'not-required', outcomesByRound: { 1: 'PROCEED' } }, {}],
  ['PROCEED shadow', { mode: 'shadow', outcomesByRound: { 1: 'PROCEED' } }, {}],
  ['PROCEED gating', { mode: 'gating', outcomesByRound: { 1: 'PROCEED' } }, {}],
  ['REPAIR gating', { mode: 'gating', outcomesByRound: { 1: 'REPAIR', 2: 'PROCEED' } }, { repair: true }],
  ['ESCALATE gating', { mode: 'gating', outcomesByRound: { 1: 'ESCALATE' } }, {}],
  ['BLOCK shadow (the push guard)', { mode: 'shadow', outcomesByRound: { 1: 'BLOCK' } }, { pushGuard: true }],
];

for (const [label, script, options] of SCRIPTS) {
  test(`the scripted slot (${label}) passes every case a stateless slot can`, async () => {
    const results = await runReviewLoopContract(statelessSubject(() => createScriptedReviewLoopSlot(script), options), makeCtx);
    assertOutcomes(results, expectAll('passed', { ...STATELESS_NA, ...(options.pushGuard === true ? {} : { 'RLC-12': 'not-applicable' as const }) }));
    const outcome = await createScriptedReviewLoopSlot(script).runAssuranceRound(slotInput(STATIC_FENCE), makeCtx('2026-01-01T00:00:00.000Z'));
    assert.equal(outcome.kind, script.outcomesByRound[1]);
  });
}

test('the scripted slot refuses a script whose outcome the contract forbids', async () => {
  for (const kind of ['REPAIR', 'ESCALATE'] as const) {
    for (const mode of ['shadow', 'not-required'] as const) {
      const slot = createScriptedReviewLoopSlot({ mode, outcomesByRound: { 1: kind } });
      await assert.rejects(() => slot.runAssuranceRound(slotInput(STATIC_FENCE), makeCtx('2026-01-01T00:00:00.000Z')),
        (err: unknown) => err instanceof ReviewLoopContractError && err.code === 'invalid-output');
    }
  }
});

// ---------------------------------------------------------------------------
// The default slot's own behaviour
// ---------------------------------------------------------------------------

test('the default slot proceeds without review for R0 and R1 only, and fails closed for every risk that requires review', async () => {
  const subject = await notConfiguredSubject()();
  const ctx = makeCtx('2026-01-01T00:00:00.000Z');
  for (const risk of ['R0', 'R1'] as const) {
    const outcome = await subject.slot.runAssuranceRound({ ...subject.fixture.input, risk }, ctx);
    assert.deepEqual(
      { kind: outcome.kind, mode: outcome.mode, shadow: 'shadow' in outcome ? outcome.shadow : 'absent', calls: outcome.usage.providerCalls },
      { kind: 'PROCEED', mode: 'not-required', shadow: null, calls: 0 },
    );
  }
  const disabled = createDisabledAssuranceSlot(REVIEW_LOOP_DISABLED);
  for (const risk of ['R2', 'R3', 'R4'] as const) {
    await assert.rejects(() => subject.slot.runAssuranceRound({ ...subject.fixture.input, risk }, ctx), AssuranceUnavailableError);
    assert.throws(() => subject.slot.planAssurance({ ...subject.fixture.input, risk }), AssuranceUnavailableError);
    // The opt-out is a different slot: it proceeds whatever the risk, which is why it is never a default.
    assert.equal((await disabled.runAssuranceRound({ ...subject.fixture.input, risk }, ctx)).kind, 'PROCEED');
  }
  assert.throws(() => createDisabledAssuranceSlot('yes' as typeof REVIEW_LOOP_DISABLED), ReviewLoopContractError);
});

test('the default slot records the terminal as the two attempt events, with every fact of the outcome except the fence', async () => {
  const subject = await notConfiguredSubject()();
  const f = subject.fixture;
  if (f.stateless) throw new Error('the default slot is stateful');
  await subject.slot.recordAttemptOutcome(f.attemptOutcome, makeCtx('2026-01-02T03:04:05.000Z'));
  const stored = JSON.parse(await f.persistedAttemptBytes(IDS.attemptId)) as Array<Array<[string, unknown]>>;
  const payloads = stored.map((row) => Object.fromEntries(row)['payload'] as RunEvent);
  const tenant = { organizationId: IDS.organizationId, projectId: IDS.projectId, repositoryBindingId: IDS.bindingId };
  const ids = { runId: IDS.runId, taskId: IDS.taskId, attemptId: IDS.attemptId };
  assert.deepEqual(payloads, [
    {
      eventId: `${IDS.attemptId}:attempt.completed`, eventType: 'attempt.completed', occurredAt: '2026-01-02T03:04:05.000Z',
      ...ids, ...tenant, risk: 'R0', outcome: 'succeeded', attemptTerminal: 'proceeded', reviewRound: 1, repairRound: false,
      assuranceUnavailable: false, verificationVerdict: 'PASS', adjudicationId: 'c'.repeat(64),
      modelCostUsd: 1.25, inputTokens: 1200, outputTokens: 300, toolCalls: 7,
    },
    {
      eventId: `${IDS.attemptId}:attempt.declared_complete`, eventType: 'attempt.declared_complete', occurredAt: '2026-01-02T03:04:05.000Z',
      ...ids, ...tenant, risk: 'R0', declaredComplete: true, passedRequiredAssurance: true,
    },
  ]);
});

// ---------------------------------------------------------------------------
// Each terminal's stored events, against what the terminal means
// ---------------------------------------------------------------------------

// The expected words come from what each terminal means and from the run-event vocabulary, not from the slot's
// own table:
//  - proceeded, escalated: the attempt went through to a pull request that waits for human review, so it succeeded.
//    The harness never accepts work, so no attempt is ever `accepted`;
//  - repair-requested: assurance turned the attempt's result down and asked for a repair, so it was rejected;
//  - blocked: assurance blocked it;
//  - verification-stopped: verification ended the attempt, and the outcome is the verdict's own word: FAIL is
//    `fail`, ERROR is `error`;
//  - agent-failed, infrastructure-failed, budget-exhausted: the agent, the infrastructure or the budget ended it,
//    so it failed;
//  - cancelled: cancelled. When the core took the slot's terminal names, only its `failed` was renamed (to
//    infrastructure-failed); `cancelled` kept its name and its meaning.
// passedRequiredAssurance follows the data model's rule for a slot that does not require review: verification
// passed, and no assurance round blocked the attempt.
interface TerminalCase {
  readonly terminal: AttemptTerminal;
  readonly round: number;
  readonly declaredComplete: boolean;
  readonly verdict: 'PASS' | 'FAIL' | 'ERROR' | null;
  readonly adjudicated: boolean;
  readonly failureClass: string | null;
  readonly agentRan: boolean;
  readonly outcome: NonNullable<RunEvent['outcome']>;
  readonly passedRequiredAssurance: boolean;
}

const TERMINAL_CASES: readonly TerminalCase[] = [
  { terminal: 'proceeded', round: 1, declaredComplete: true, verdict: 'PASS', adjudicated: true, failureClass: null, agentRan: true, outcome: 'succeeded', passedRequiredAssurance: true },
  { terminal: 'escalated', round: 2, declaredComplete: true, verdict: 'PASS', adjudicated: true, failureClass: null, agentRan: true, outcome: 'succeeded', passedRequiredAssurance: true },
  { terminal: 'repair-requested', round: 1, declaredComplete: true, verdict: 'PASS', adjudicated: true, failureClass: 'introduced-regression', agentRan: true, outcome: 'rejected', passedRequiredAssurance: true },
  { terminal: 'blocked', round: 1, declaredComplete: true, verdict: 'PASS', adjudicated: true, failureClass: null, agentRan: true, outcome: 'blocked', passedRequiredAssurance: false },
  { terminal: 'verification-stopped', round: 1, declaredComplete: true, verdict: 'FAIL', adjudicated: false, failureClass: 'introduced-regression', agentRan: true, outcome: 'fail', passedRequiredAssurance: false },
  { terminal: 'verification-stopped', round: 1, declaredComplete: true, verdict: 'ERROR', adjudicated: false, failureClass: 'environment', agentRan: true, outcome: 'error', passedRequiredAssurance: false },
  { terminal: 'agent-failed', round: 1, declaredComplete: false, verdict: null, adjudicated: false, failureClass: 'agent-loop-stall', agentRan: true, outcome: 'failed', passedRequiredAssurance: false },
  { terminal: 'infrastructure-failed', round: 1, declaredComplete: false, verdict: null, adjudicated: false, failureClass: 'environment', agentRan: false, outcome: 'failed', passedRequiredAssurance: false },
  { terminal: 'budget-exhausted', round: 1, declaredComplete: false, verdict: null, adjudicated: false, failureClass: null, agentRan: true, outcome: 'failed', passedRequiredAssurance: false },
  { terminal: 'cancelled', round: 1, declaredComplete: false, verdict: null, adjudicated: false, failureClass: null, agentRan: false, outcome: 'cancelled', passedRequiredAssurance: false },
];

// Every terminal of the slot contract, checked against the union at compile time.
const EVERY_TERMINAL: Readonly<Record<AttemptTerminal, true>> = {
  'verification-stopped': true, 'proceeded': true, 'repair-requested': true, 'escalated': true, 'blocked': true,
  'agent-failed': true, 'budget-exhausted': true, 'cancelled': true, 'infrastructure-failed': true,
};

test('each attempt terminal, and verification ERROR, is stored as the two events its meaning says', async () => {
  assert.deepEqual([...new Set(TERMINAL_CASES.map((c) => c.terminal))].sort(), Object.keys(EVERY_TERMINAL).sort());
  assert.ok(TERMINAL_CASES.some((c) => c.verdict === 'ERROR'), 'the verification ERROR case is covered');
  const db = await seededDb();
  const store = new SqlAttemptTerminalStore(db);
  const slot = new NotConfiguredAssuranceSlot(store);
  const occurredAt = '2026-01-03T04:05:06.000Z';
  const tenant = { organizationId: IDS.organizationId, projectId: IDS.projectId, repositoryBindingId: IDS.bindingId };
  const stored: string[] = [];
  for (const [i, c] of TERMINAL_CASES.entries()) {
    const label = `${c.terminal}${c.verdict === null ? '' : ` (${c.verdict})`}`;
    const attemptId = `01K${'0'.repeat(21)}T${i}` as AttemptId;
    const attempt = await registerAttempt(db, attemptId);
    const lease = await store.acquireLease(SCOPE, { attempt, branch: branchOf(attemptId), ttlMs: 3_600_000 });
    if ('denied' in lease) throw new Error(`lease denied: ${lease.reason}`);
    const adjudicationId = c.adjudicated ? 'c'.repeat(64) : null;
    await slot.recordAttemptOutcome({
      ...leasedOutcome({ leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch }, attemptId),
      terminal: c.terminal,
      round: c.round,
      declaredComplete: c.declaredComplete,
      verificationVerdict: c.verdict,
      adjudicationId,
      failureClass: c.failureClass,
      cost: c.agentRan ? { modelCostMicroUsd: 1_250_000, computeCostMicroUsd: null, inputTokens: 1200, outputTokens: 300, toolCalls: 7 } : null,
    }, makeCtx(occurredAt));
    const rows = await db.query(
      `select payload from run_events where organization_id = $1 and project_id = $2 and attempt_id = $3 order by event_type`,
      [IDS.organizationId, IDS.projectId, attemptId],
    );
    const payloads = rows.rows.map((row) => row['payload'] as RunEvent);
    const ids = { runId: IDS.runId, taskId: IDS.taskId, attemptId };
    assert.deepEqual(payloads, [
      {
        eventId: `${attemptId}:attempt.completed`, eventType: 'attempt.completed', occurredAt, ...ids, ...tenant, risk: 'R0',
        outcome: c.outcome, attemptTerminal: c.terminal, reviewRound: c.round, repairRound: c.round > 1, assuranceUnavailable: false,
        ...(c.verdict === null ? {} : { verificationVerdict: c.verdict }),
        ...(adjudicationId === null ? {} : { adjudicationId }),
        ...(c.failureClass === null ? {} : { failureClass: c.failureClass }),
        ...(c.agentRan ? { modelCostUsd: 1.25, inputTokens: 1200, outputTokens: 300, toolCalls: 7 } : {}),
      },
      {
        eventId: `${attemptId}:attempt.declared_complete`, eventType: 'attempt.declared_complete', occurredAt, ...ids, ...tenant,
        risk: 'R0', declaredComplete: c.declaredComplete, passedRequiredAssurance: c.passedRequiredAssurance,
      },
    ], label);
    stored.push(String(payloads[0]!.outcome));
  }
  assert.ok(!stored.includes('accepted'), 'no attempt is ever stored as accepted');
});

test('the default slot refuses an outcome it cannot write as distinct events, before any write', async () => {
  const subject = await notConfiguredSubject()();
  const f = subject.fixture;
  if (f.stateless) throw new Error('the default slot is stateful');
  const ctx = makeCtx('2026-01-01T00:00:00.000Z');
  const cost = f.attemptOutcome.cost!;
  for (const bad of [
    { ...f.attemptOutcome, cost: { ...cost, modelCostMicroUsd: 1e15 } },
    { ...f.attemptOutcome, cost: { ...cost, toolCalls: 1.5 } },
    { ...f.attemptOutcome, round: 0 },
    { ...f.attemptOutcome, adjudicationId: 'C'.repeat(64) },
    { ...f.attemptOutcome, failureClass: '' },
    { ...f.attemptOutcome, assuranceUnavailable: true },
  ]) {
    await assert.rejects(() => subject.slot.recordAttemptOutcome(bad, ctx), (err: unknown) => err instanceof ReviewLoopContractError && err.code === 'invalid-input');
  }
  assert.equal(await f.persistedAttemptBytes(IDS.attemptId), '[]');
});

// ---------------------------------------------------------------------------
// The kit's oracles refuse broken subjects
// ---------------------------------------------------------------------------

function failedCases(results: readonly ReviewLoopConformanceResult[]): string[] {
  return results.filter((r) => r.status === 'failed').map((r) => r.caseId);
}

// RLC-06's negative fixtures: the scripted slot, made to return each shape the contract forbids, fails the case.
const VIOLATIONS: ReadonlyArray<readonly [string, ScriptedReviewLoopScript, (o: Record<string, unknown>) => void]> = [
  ['PROCEED in shadow mode without its shadow key', { mode: 'shadow', outcomesByRound: { 1: 'PROCEED' } }, (o) => { delete o['shadow']; }],
  ['PROCEED in gating mode with a shadow verdict', { mode: 'gating', outcomesByRound: { 1: 'PROCEED' } }, (o) => { o['shadow'] = { wouldBe: 'PROCEED', reason: null, blockingFindings: 0 }; }],
  ['BLOCK with a shadow key', { mode: 'shadow', outcomesByRound: { 1: 'BLOCK' } }, (o) => { o['shadow'] = null; }],
  ['REPAIR in shadow mode', { mode: 'gating', outcomesByRound: { 1: 'REPAIR' } }, (o) => { o['mode'] = 'shadow'; }],
  ['REPAIR whose nextRound is not round + 1', { mode: 'gating', outcomesByRound: { 1: 'REPAIR' } }, (o) => { o['nextRound'] = 1; }],
  ['REPAIR whose base is not the result commit', { mode: 'gating', outcomesByRound: { 1: 'REPAIR' } }, (o) => { o['repairBaseSha'] = 'f'.repeat(40); }],
  ['ESCALATE without its section', { mode: 'gating', outcomesByRound: { 1: 'ESCALATE' } }, (o) => { o['prBodySectionRef'] = null; }],
  ['a roundKey other than the idempotency key', { mode: 'not-required', outcomesByRound: { 1: 'PROCEED' } }, (o) => { o['roundKey'] = 'other'; }],
];

for (const [label, script, mutate] of VIOLATIONS) {
  test(`RLC-06 fails a slot that returns ${label}`, async () => {
    const broken = (): ReviewLoopSlot => {
      const slot = createScriptedReviewLoopSlot(script);
      return {
        ...slot,
        async runAssuranceRound(input, ctx) {
          const outcome = { ...(await slot.runAssuranceRound(input, ctx)) } as unknown as Record<string, unknown>;
          mutate(outcome);
          return outcome as unknown as AssuranceOutcome;
        },
      };
    };
    const results = await runReviewLoopContract(statelessSubject(broken, { repair: script.outcomesByRound[1] === 'REPAIR' }), makeCtx);
    assert.equal(byCase(results)['RLC-06']?.status, 'failed', JSON.stringify(byCase(results)['RLC-06']));
  });
}

test('RLC-19 refuses an effect before its attempt\'s registration, and needs scenarios that commit steps', async () => {
  const a1 = '01K0000000000000000000000A' as AttemptId;
  const a2 = '01K0000000000000000000000B' as AttemptId;
  const good = await runRegistrationOrderingContract([{
    name: 'two attempts, each registered first',
    run: async () => [
      { kind: 'registration-reconciled', attemptId: a1 },
      { kind: 'attempt-bound-effect', attemptId: a1, effect: 'lease acquisition' },
      { kind: 'registration-reconciled', attemptId: a2 },
      { kind: 'attempt-bound-effect', attemptId: a2, effect: 'agent start' },
      { kind: 'attempt-bound-effect', attemptId: a1, effect: 'terminal write' },
    ],
  }]);
  assert.deepEqual(good.map((r) => r.status), ['passed']);
  const bad = await runRegistrationOrderingContract([
    { name: 'an effect of another attempt first', run: async () => [{ kind: 'registration-reconciled', attemptId: a1 }, { kind: 'attempt-bound-effect', attemptId: a2, effect: 'usage' }] },
    { name: 'nothing committed', run: async () => [] },
    { name: 'a failing scenario', run: async () => { throw new Error('boom'); } },
  ]);
  assert.deepEqual(bad.map((r) => r.status), ['failed', 'failed', 'failed']);
  assert.deepEqual((await runRegistrationOrderingContract([])).map((r) => r.status), ['failed']);
});

// The resolver kit against an in-memory resolver: the correct one passes, and each one that skips a check fails the
// case for that check.
interface LeaseRow { readonly scope: TenantScope; readonly attemptId: AttemptId; readonly leaseId: string; readonly epoch: number; active: boolean }

type ResolverRule = 'scope' | 'active' | 'held' | 'epoch';

function memoryResolverSubject(skip: ResolverRule | null) {
  return async () => {
    const row: LeaseRow = { scope: SCOPE, attemptId: IDS.attemptId, leaseId: '01K0000000000000000000000C', epoch: 4, active: true };
    const resolver: AssuranceWorkspaceResolver = {
      async resolve(scope, query) {
        if (skip !== 'scope' && (scope.organizationId !== row.scope.organizationId || scope.projectId !== row.scope.projectId || query.attemptId !== row.attemptId)) {
          return { kind: 'refused', reason: 'not-in-scope' };
        }
        if (skip !== 'active' && !row.active) return { kind: 'refused', reason: 'lease-not-active' };
        if (skip !== 'held' && query.leaseId !== row.leaseId) return { kind: 'refused', reason: 'lease-not-held' };
        if (skip !== 'epoch' && query.fencingEpoch !== row.epoch) return { kind: 'refused', reason: 'stale-epoch' };
        return { kind: 'resolved', workspace: { workspaceId: '01K0000000000000000000000D' as never, leaseId: query.leaseId } };
      },
    };
    const fixture: WorkspaceResolverConformanceFixture = {
      scope: SCOPE,
      attemptId: row.attemptId,
      fence: { leaseId: row.leaseId, fencingEpoch: row.epoch },
      foreignScope: { organizationId: '01K0000000000000000000000E' as OrganizationId, projectId: '01K0000000000000000000000F' as ProjectId },
      endLease: async () => { row.active = false; },
    };
    return { resolver, fixture };
  };
}

test('the resolver kit passes a resolver that checks scope, liveness, holder and epoch, and fails one that skips any', async () => {
  const correct = await runWorkspaceResolverContract(memoryResolverSubject(null));
  assert.deepEqual(correct.map((r) => [r.caseId, r.status]), [
    ['WRC-01', 'passed'], ['WRC-02', 'passed'], ['WRC-03', 'passed'], ['WRC-04', 'passed'], ['WRC-05', 'passed'],
  ]);
  const guardedBy: Readonly<Record<ResolverRule, string>> = { scope: 'WRC-02', held: 'WRC-03', epoch: 'WRC-04', active: 'WRC-05' };
  for (const [rule, caseId] of Object.entries(guardedBy) as Array<[ResolverRule, string]>) {
    const results = await runWorkspaceResolverContract(memoryResolverSubject(rule));
    assert.deepEqual(failedCases(results), [caseId], `a resolver that skips the ${rule} check`);
  }
});

// ---------------------------------------------------------------------------
// The pre-lease terminal write's result
// ---------------------------------------------------------------------------

function preLeaseOutcome(attemptId: AttemptId): PreLeaseAttemptOutcomeInput {
  return {
    ...leasedOutcome(STATIC_FENCE, attemptId),
    terminal: 'infrastructure-failed',
    fence: null,
    declaredComplete: false,
    verificationVerdict: null,
    adjudicationId: null,
    failureClass: 'environment',
    cost: null,
  };
}

const OTHER_CODES: readonly ReviewLoopContractErrorCode[] = ['invalid-payload', 'invalid-input', 'not-in-scope', 'conflicting-redelivery', 'invalid-output'];

test('a pre-lease write refused with lease-granted is the result recorded: false; every other error stays an error', async () => {
  const ctx = makeCtx('2026-01-01T00:00:00.000Z');
  const input = preLeaseOutcome(IDS.attemptId);
  const throwing = (err: unknown): ReviewLoopSlot => ({
    ...createDisabledAssuranceSlot(REVIEW_LOOP_DISABLED),
    recordAttemptOutcome: async () => {
      throw err;
    },
  });
  assert.deepEqual(await recordPreLeaseOutcome(createDisabledAssuranceSlot(REVIEW_LOOP_DISABLED), input, ctx), { recorded: true });
  assert.deepEqual(await recordPreLeaseOutcome(throwing(new ReviewLoopContractError('lease-granted', 'a lease committed late')), input, ctx), { recorded: false });
  const errors: readonly unknown[] = [
    ...OTHER_CODES.map((code) => new ReviewLoopContractError(code, code)),
    new AssuranceFencedError('a supersession is not a late grant'),
    new AssuranceCancelledError('cancelled'),
    new Error('the database is down'),
    // Only the contract's error class carries the refusal, not anything that looks like it.
    Object.assign(new Error('look-alike'), { code: 'lease-granted' }),
  ];
  for (const err of errors) {
    await assert.rejects(recordPreLeaseOutcome(throwing(err), input, ctx), (thrown) => thrown === err, String((err as Error).message));
  }
});

test('the default slot refuses a pre-lease write once a lease committed, and the write reads that as recorded: false', async () => {
  const db = await seededDb();
  const store = new SqlAttemptTerminalStore(db);
  const slot = new NotConfiguredAssuranceSlot(store);
  const ctx = makeCtx('2026-01-01T00:00:00.000Z');
  // An attempt the lookup found without a lease, whose grant committed before its terminal write.
  const late = '01K000000000000000000000R1' as AttemptId;
  const lateRef = await registerAttempt(db, late);
  const lease = await store.acquireLease(SCOPE, { attempt: lateRef, branch: branchOf(late), ttlMs: 3_600_000 });
  assert.ok(!('denied' in lease), `the lease is granted: ${JSON.stringify(lease)}`);
  assert.deepEqual(await recordPreLeaseOutcome(slot, preLeaseOutcome(late), ctx), { recorded: false });
  assert.equal((await db.query('select count(*)::int as n from run_events where attempt_id = $1', [late])).rows[0]?.['n'], 0, 'nothing is written');
  // An attempt that never had a lease: the write records its terminal.
  const never = '01K000000000000000000000R2' as AttemptId;
  await registerAttempt(db, never);
  assert.deepEqual(await recordPreLeaseOutcome(slot, preLeaseOutcome(never), ctx), { recorded: true });
  assert.equal((await db.query('select count(*)::int as n from run_events where attempt_id = $1', [never])).rows[0]?.['n'], 2, 'the two attempt events');
});
