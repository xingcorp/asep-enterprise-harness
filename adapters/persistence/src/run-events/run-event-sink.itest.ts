// run_events and the attempt-terminal writes on real PostgreSQL (digest-pinned,
// provisioned by the integration gate), across separate connections: what PGlite,
// one in-process connection, cannot show.
//
//   - two connections append the same event id at once: with the same bytes one
//     inserts and the other is a no-op; with other bytes one inserts and the other
//     gets RunEventConflictError;
//   - UPDATE and DELETE raise SQLSTATE 55000, and the scoped run FK refuses
//     another tenant's run;
//   - a pre-lease terminal write and the attempt's lease acquisition race on two
//     connections: exactly one wins, every time;
//   - the upgrade path: a database at the migration set before 0107 takes 0107 alone,
//     and a second run applies nothing.
//
// *.itest.ts: it runs only under the integration gate and fails closed when
// ASEP_PG_URL is unset.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import type { RunEvent, TenantScope } from '@asep/contracts';
import { RunEventConflictError, type AttemptRef } from '@asep/ports';
import { PgPoolClient } from '../pg-pool-client.js';
import { migrate } from '../migrator.js';
import { MIGRATIONS } from '../migrations.js';
import { makePool, migratedClient, requirePgUrl } from '../itest-support.js';
import {
  AttemptRepository, OrganizationRepository, ProjectRepository, RepositoryBindingRepository,
  RunRepository, TaskRepository,
} from '../repositories.js';
import type { SqlClient } from '../sql.js';
import { SqlRunEventSink } from './run-event-sink.js';
import { SqlAttemptTerminalStore } from './attempt-terminal-store.js';

console.log('SUITE-ID: asep-suite:pg-run-events');

interface Tenant {
  readonly scope: TenantScope;
  readonly newAttempt: () => Promise<AttemptRef>;
  readonly runId: AttemptRef['runId'];
}

async function seedTenant(db: SqlClient): Promise<Tenant> {
  const suffix = Math.random().toString(36).slice(2);
  const org = await new OrganizationRepository(db).create({ name: `org-${suffix}` });
  const project = await new ProjectRepository(db).create({ organizationId: org.id, name: `p-${suffix}`, defaultBranch: 'main' });
  const scope: TenantScope = { organizationId: org.id, projectId: project.id };
  const binding = await new RepositoryBindingRepository(db).create(scope, {
    githubHost: 'github.com', githubOwner: 'acme', githubRepo: `r-${suffix}`, defaultBaseBranch: 'main',
  });
  const run = await new RunRepository(db).create(scope, { repositoryBindingId: binding.id, status: 'EXECUTING', risk: 'R0' });
  const task = await new TaskRepository(db).create(scope, { runId: run.id, repositoryBindingId: binding.id, risk: 'R0' });
  const newAttempt = async (): Promise<AttemptRef> => {
    const attempt = await new AttemptRepository(db).create(scope, { taskId: task.id, repositoryBindingId: binding.id });
    return { repositoryBindingId: binding.id, runId: run.id, taskId: task.id, attemptId: attempt.id };
  };
  return { scope, newAttempt, runId: run.id };
}

function event(t: Tenant, eventId: string, occurredAt = '2026-10-31T00:00:00.000Z'): RunEvent {
  return { eventId, eventType: 'task.started', occurredAt, runId: t.runId };
}

function preLeaseTerminal(t: Tenant, attempt: AttemptRef): RunEvent[] {
  const base = {
    occurredAt: '2026-10-31T00:00:00.000Z', runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId,
    organizationId: t.scope.organizationId, projectId: t.scope.projectId,
  };
  return [
    { ...base, eventId: `${attempt.attemptId}:attempt.declared_complete`, eventType: 'attempt.declared_complete', declaredComplete: false, passedRequiredAssurance: false },
    { ...base, eventId: `${attempt.attemptId}:attempt.completed`, eventType: 'attempt.completed', outcome: 'cancelled', attemptTerminal: 'cancelled' },
  ];
}

async function withTwoConnections<T>(fn: (a: SqlClient, b: SqlClient) => Promise<T>): Promise<T> {
  const poolA = makePool(1);
  const poolB = makePool(1);
  try {
    return await fn(PgPoolClient.fromPool(poolA), PgPoolClient.fromPool(poolB));
  } finally {
    await poolA.end();
    await poolB.end();
  }
}

test('two connections appending the same event id with the same bytes: exactly one inserts', async () => {
  const setup = await migratedClient();
  try {
    const t = await seedTenant(setup.client);
    await withTwoConnections(async (a, b) => {
      for (let i = 0; i < 20; i++) {
        const e = event(t, `same-${i}`);
        const results = await Promise.all([new SqlRunEventSink(a).append(t.scope, e), new SqlRunEventSink(b).append(t.scope, e)]);
        assert.deepEqual(results.map((r) => r.appended).sort(), [false, true], `round ${i}`);
      }
    });
    const n = await setup.client.query(
      `select count(*)::int as n from run_events where organization_id = $1 and project_id = $2 and event_id like 'same-%'`,
      [t.scope.organizationId, t.scope.projectId],
    );
    assert.equal(n.rows[0]?.['n'], 20);
  } finally {
    await setup.pool.end();
  }
});

test('two connections appending the same event id with different bytes: one inserts, the other conflicts', async () => {
  const setup = await migratedClient();
  try {
    const t = await seedTenant(setup.client);
    await withTwoConnections(async (a, b) => {
      for (let i = 0; i < 20; i++) {
        const results = await Promise.allSettled([
          new SqlRunEventSink(a).append(t.scope, event(t, `diff-${i}`, '2026-10-31T00:00:00.000Z')),
          new SqlRunEventSink(b).append(t.scope, event(t, `diff-${i}`, '2026-10-31T00:00:01.000Z')),
        ]);
        const appended = results.filter((r) => r.status === 'fulfilled' && r.value.appended);
        const conflicts = results.filter((r) => r.status === 'rejected' && r.reason instanceof RunEventConflictError);
        assert.equal(appended.length, 1, `round ${i}: one insert`);
        assert.equal(conflicts.length, 1, `round ${i}: one conflict`);
      }
    });
  } finally {
    await setup.pool.end();
  }
});

test('run_events refuses UPDATE and DELETE with SQLSTATE 55000 and another tenant\'s run by its scoped FK', async () => {
  const setup = await migratedClient();
  try {
    const t = await seedTenant(setup.client);
    const other = await seedTenant(setup.client);
    await new SqlRunEventSink(setup.client).append(t.scope, event(t, 'immutable'));
    const pk = [t.scope.organizationId, t.scope.projectId, 'immutable'];
    await assert.rejects(
      () => setup.client.query(`update run_events set event_type = 'run.completed' where organization_id = $1 and project_id = $2 and event_id = $3`, pk),
      (err: unknown) => (err as { code?: string }).code === '55000',
    );
    await assert.rejects(
      () => setup.client.query('delete from run_events where organization_id = $1 and project_id = $2 and event_id = $3', pk),
      (err: unknown) => (err as { code?: string }).code === '55000',
    );
    await assert.rejects(
      () => setup.client.query(
        `insert into run_events (organization_id, project_id, event_id, event_type, schema_version, occurred_at, run_id, payload, payload_sha256)
         values ($1, $2, 'cross-tenant', 'task.started', '1.2.0', now(), $3, '{}', $4)`,
        [t.scope.organizationId, t.scope.projectId, other.runId, 'a'.repeat(64)],
      ),
      (err: unknown) => (err as { code?: string }).code === '23503',
    );
  } finally {
    await setup.pool.end();
  }
});

test('a pre-lease terminal and the attempt\'s lease acquisition race on two connections: exactly one wins', async () => {
  const setup = await migratedClient();
  try {
    const t = await seedTenant(setup.client);
    const seen = new Set<string>();
    await withTwoConnections(async (a, b) => {
      for (let i = 0; i < 20; i++) {
        const attempt = await t.newAttempt();
        const [terminal, lease] = await Promise.all([
          new SqlAttemptTerminalStore(a).recordTerminal(t.scope, attempt, null, preLeaseTerminal(t, attempt)),
          new SqlAttemptTerminalStore(b).acquireLease(t.scope, { attempt, branch: `asep/${attempt.attemptId}`, ttlMs: 600_000 }),
        ]);
        const leaseRows = await setup.client.query('select count(*)::int as n from workspace_leases where attempt_id = $1', [attempt.attemptId]);
        const eventRows = await setup.client.query('select count(*)::int as n from run_events where attempt_id = $1', [attempt.attemptId]);
        if (terminal.kind === 'recorded') {
          assert.deepEqual(lease, { denied: true, reason: 'attempt-terminal-recorded' }, `round ${i}`);
          assert.equal(leaseRows.rows[0]?.['n'], 0, `round ${i}: no lease`);
          assert.equal(eventRows.rows[0]?.['n'], 2, `round ${i}: the terminal`);
          seen.add('terminal-first');
        } else {
          assert.deepEqual(terminal, { kind: 'refused', reason: 'lease-granted' }, `round ${i}`);
          assert.ok(!('denied' in lease), `round ${i}: the lease was granted`);
          assert.equal(leaseRows.rows[0]?.['n'], 1, `round ${i}: one lease`);
          assert.equal(eventRows.rows[0]?.['n'], 0, `round ${i}: no terminal`);
          seen.add('lease-first');
        }
      }
    });
    console.log(`pre-lease race orders observed: ${[...seen].sort().join(', ')}`);
  } finally {
    await setup.pool.end();
  }
});

test('the same terminal written on two connections at once is recorded once and redelivered once', async () => {
  const setup = await migratedClient();
  try {
    const t = await seedTenant(setup.client);
    await withTwoConnections(async (a, b) => {
      for (let i = 0; i < 10; i++) {
        const attempt = await t.newAttempt();
        const results = await Promise.all([
          new SqlAttemptTerminalStore(a).recordTerminal(t.scope, attempt, null, preLeaseTerminal(t, attempt)),
          new SqlAttemptTerminalStore(b).recordTerminal(t.scope, attempt, null, preLeaseTerminal(t, attempt)),
        ]);
        assert.deepEqual(results.map((r) => r.kind).sort(), ['recorded', 'redelivered'], `round ${i}`);
      }
    });
  } finally {
    await setup.pool.end();
  }
});

test('upgrade path: a database at the migration set before 0107 takes 0107 alone, then nothing', async () => {
  const admin = new Pool({ connectionString: requirePgUrl(), max: 1 });
  const dbName = `asep_run_events_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`create database ${dbName}`);
  try {
    const url = new URL(requirePgUrl());
    url.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: url.toString(), max: 2 });
    try {
      const client = PgPoolClient.fromPool(pool);
      const phase2 = MIGRATIONS.filter((m) => m.id < '0100');
      assert.equal(phase2[phase2.length - 1]?.id, '0019_command_output_references');
      await migrate(client, phase2);
      // The run-events set: Phase 2 and 0107, without the orchestration state
      // migrations between them (their upgrade path is orchestration.itest.ts).
      const withRunEvents = MIGRATIONS.filter((m) => m.id < '0100' || m.id === '0107_run_events');
      const upgrade = await migrate(client, withRunEvents);
      assert.deepEqual(upgrade.applied, ['0107_run_events']);
      const again = await migrate(client, withRunEvents);
      assert.deepEqual(again.applied, []);
      const registry = await client.query('select id from schema_migrations order by applied_at, id');
      assert.deepEqual(registry.rows.map((r) => r['id']), withRunEvents.map((m) => m.id));
    } finally {
      await pool.end();
    }
  } finally {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  }
});
