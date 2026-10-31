// Grafana in the integration gate (exit J4): the digest-pinned Grafana the gate
// starts with the committed provisioning (deploy/grafana/provisioning, mounted
// read-only) must
//   - report itself healthy on GET /api/health;
//   - serve the provisioned data source by its uid;
//   - serve every provisioned dashboard by its uid;
//   - answer every panel query, sent through POST /api/ds/query as the panel
//     holds it, with the snapshot values the evaluator wrote.
//
// The snapshots are the evaluator's golden run (@asep/observability
// GOLDEN_EVENTS_BY_DAY, recomputed day by day, so several series hold more than
// one version), written to a real PostgreSQL that the Grafana data source reads.
// The expected values are the golden's hand-derived ones, and each panel must
// return the latest version only. The comparison with the snapshots of the
// assurance-only loop run is added when that loop lands.
//
// Until migration 0201_metric_snapshots lands, this suite creates the table and
// its latest-version view itself, from the DDL in phase-04-data-model.md §3.2;
// once the migrations create the table, the suite uses theirs.
//
// *.itest.ts: it runs only under the integration gate and fails closed when the
// gate's environment is absent.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import {
  OrganizationRepository, PgPoolClient, ProjectRepository, migrate, ulid,
} from '@asep/persistence';
import {
  GOLDEN_CAPTURE_OPT_IN, GOLDEN_EVENTS_BY_DAY, GOLDEN_VALUES, GOLDEN_WINDOWS,
  MemoryMetricSnapshotStore, loadMeasurementDictionary, recomputeMetricSnapshots,
  type MetricSnapshot,
} from '@asep/observability';
import type { RunEvent } from '@asep/contracts';

console.log('SUITE-ID: asep-suite:assurance-dashboards-real');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const DASHBOARD_DIR = join(REPO_ROOT, 'deploy', 'grafana', 'provisioning', 'dashboards', 'assurance');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`${name} is not set: this suite runs only under the integration gate, which starts Grafana; failing closed`);
  }
  return v;
}

const PG_URL = requireEnv('ASEP_PG_URL');
const GRAFANA_URL = requireEnv('ASEP_GRAFANA_URL');
const GRAFANA_AUTH = `Basic ${Buffer.from(`${requireEnv('ASEP_GRAFANA_USER')}:${requireEnv('ASEP_GRAFANA_PASSWORD')}`).toString('base64')}`;
const METRICS_DB = requireEnv('ASEP_GRAFANA_PG_DATABASE');
if (!/^[a-z_][a-z0-9_]*$/.test(METRICS_DB)) throw new Error(`ASEP_GRAFANA_PG_DATABASE "${METRICS_DB}" is not a plain identifier`);

// phase-04-data-model.md §3.2, with the append-only guard function of §3.1.
const SNAPSHOT_DDL = `
create or replace function assurance_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed (append-only)', tg_op, tg_table_name
    using errcode = '55000';
end;
$$;

create table metric_snapshots (
  id                 char(26)    primary key,
  organization_id    char(26)    not null,
  project_id         char(26)    not null,
  metric_name        text        not null,
  dictionary_version text        not null,
  evaluator_version  text        not null,
  window_start       timestamptz not null,
  window_end         timestamptz not null,
  dimensions         jsonb       not null,
  dimensions_sha256  text        not null,
  snapshot_version   integer     not null,
  value              numeric,
  numerator          numeric,
  denominator        numeric,
  null_reason        text,
  privacy_class      text        not null,
  source_event_count integer     not null,
  source_watermark   timestamptz,
  computed_at        timestamptz not null,
  constraint metric_snapshots_window_ck   check (window_end > window_start),
  constraint metric_snapshots_null_ck     check ((value is null) = (null_reason is not null)),
  constraint metric_snapshots_privacy_ck  check (privacy_class in ('public','operational','sensitive','restricted')),
  constraint metric_snapshots_dims_sha_ck check (dimensions_sha256 ~ '^[0-9a-f]{64}$'),
  constraint metric_snapshots_counts_ck   check (source_event_count >= 0 and snapshot_version >= 1),
  constraint metric_snapshots_version_uq  unique (organization_id, project_id, metric_name, dictionary_version,
                                            window_start, window_end, dimensions_sha256, snapshot_version),
  constraint metric_snapshots_project_fk  foreign key (project_id, organization_id)
    references projects (id, organization_id)
);
create index metric_snapshots_lookup_idx on metric_snapshots (organization_id, project_id, metric_name, window_end);

create function assurance_metric_snapshot_version() returns trigger
language plpgsql as $$
declare
  prev metric_snapshots%rowtype;
begin
  select * into prev from metric_snapshots
   where organization_id = new.organization_id and project_id = new.project_id
     and metric_name = new.metric_name and dictionary_version = new.dictionary_version
     and window_start = new.window_start and window_end = new.window_end
     and dimensions_sha256 = new.dimensions_sha256
   order by snapshot_version desc
   limit 1;
  if not found then
    if new.snapshot_version <> 1 then
      raise exception 'first snapshot version must be 1, got %', new.snapshot_version using errcode = '55000';
    end if;
  elsif new.snapshot_version <> prev.snapshot_version + 1 then
    raise exception 'snapshot version must be %, got %', prev.snapshot_version + 1, new.snapshot_version
      using errcode = '55000';
  elsif (new.value, new.numerator, new.denominator, new.null_reason)
        is not distinct from (prev.value, prev.numerator, prev.denominator, prev.null_reason) then
    raise exception 'snapshot version % repeats version %', new.snapshot_version, prev.snapshot_version
      using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger metric_snapshots_version_guard before insert on metric_snapshots
  for each row execute function assurance_metric_snapshot_version();
create trigger metric_snapshots_append_only before update or delete on metric_snapshots
  for each row execute function assurance_reject_mutation();

create view metric_snapshots_latest as
  select distinct on (organization_id, project_id, metric_name, dictionary_version, window_start, window_end,
                      dimensions_sha256) *
    from metric_snapshots
   order by organization_id, project_id, metric_name, dictionary_version, window_start, window_end,
            dimensions_sha256, snapshot_version desc;
`;

interface Target { refId: string; datasource: { type: string; uid: string }; format: string; rawSql: string }
interface Panel { id: number; title: string; targets: Target[] }
interface Variable { name: string; query: string }
interface Dashboard { uid: string; title: string; panels: Panel[]; templating: { list: Variable[] } }

const DASHBOARDS: readonly Dashboard[] = readdirSync(DASHBOARD_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DASHBOARD_DIR, f), 'utf8')) as Dashboard);

async function grafana(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${GRAFANA_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: GRAFANA_AUTH, 'content-type': 'application/json', accept: 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep the text for the message */ }
  return { status: res.status, body };
}

// A dashboard provisioner may still be loading when /api/health already says ok.
async function dashboardByUid(uid: string): Promise<{ status: number; body: any }> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const r = await grafana(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
    if (r.status !== 404 || Date.now() > deadline) return r;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Grafana's dashboard page replaces a single-value variable with its raw value
// before it sends the query; /api/ds/query receives the result. Do the same for
// the dashboard's own variables and nothing else.
function interpolate(sql: string, values: Readonly<Record<string, string>>): string {
  const out = sql.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => {
    if (name.startsWith('__')) return whole;
    const v = values[name];
    if (v === undefined) throw new Error(`query uses variable ${name}, which the test does not set`);
    return v;
  });
  return out;
}

interface Row { time: number; value: number | null; nullReason: string | null; snapshotVersion: number }

function frameRows(result: any, where: string): Row[] {
  assert.equal(result?.status, 200, `${where}: query status ${JSON.stringify(result)}`);
  assert.equal(result.frames.length, 1, `${where}: one frame`);
  const frame = result.frames[0];
  const names: string[] = frame.schema.fields.map((f: { name: string }) => f.name);
  assert.deepEqual(names, ['time', 'value', 'null_reason', 'snapshot_version'], where);
  const [time, value, reason, version] = frame.data.values as unknown[][];
  return (time ?? []).map((t, i) => ({
    time: t as number,
    value: (value?.[i] ?? null) as number | null,
    nullReason: (reason?.[i] ?? null) as string | null,
    snapshotVersion: version?.[i] as number,
  }));
}

let adminPool: Pool;
let pool: Pool;
let scope: { organizationId: string; projectId: string };
let stored: readonly MetricSnapshot[];
const DASHBOARD_METRICS = Object.keys(GOLDEN_VALUES).sort();

before(async () => {
  adminPool = new Pool({ connectionString: PG_URL, max: 1 });
  await adminPool.query(`create database ${METRICS_DB}`);
  const url = new URL(PG_URL);
  url.pathname = `/${METRICS_DB}`;
  pool = new Pool({ connectionString: url.toString(), max: 2 });
  const db = PgPoolClient.fromPool(pool);
  await migrate(db);
  const existing = await pool.query(`select to_regclass('public.metric_snapshots') as t`);
  if (existing.rows[0].t === null) await pool.query(SNAPSHOT_DDL);

  const org = await new OrganizationRepository(db).create({ name: 'dashboards' });
  const project = await new ProjectRepository(db).create({ organizationId: org.id, name: 'dashboards', defaultBranch: 'main' });
  scope = { organizationId: org.id, projectId: project.id };

  const dictionary = loadMeasurementDictionary();
  const store = new MemoryMetricSnapshotStore();
  const seen: RunEvent[] = [];
  for (const [i, day] of GOLDEN_EVENTS_BY_DAY.entries()) {
    seen.push(...day);
    await recomputeMetricSnapshots({
      store, scope, dictionary, metricNames: DASHBOARD_METRICS, windows: GOLDEN_WINDOWS, events: seen,
      computedAt: `2026-10-0${i + 1}T23:00:00.000Z`, captureOptIn: GOLDEN_CAPTURE_OPT_IN,
    });
  }
  stored = store.all();
  for (const s of stored) {
    await pool.query(
      `insert into metric_snapshots (id, organization_id, project_id, metric_name, dictionary_version, evaluator_version,
         window_start, window_end, dimensions, dimensions_sha256, snapshot_version, value, numerator, denominator,
         null_reason, privacy_class, source_event_count, source_watermark, computed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [ulid(), s.organizationId, s.projectId, s.metricName, s.dictionaryVersion, s.evaluatorVersion, s.windowStart,
        s.windowEnd, JSON.stringify(s.dimensions), s.dimensionsSha256, s.snapshotVersion, s.value, s.numerator,
        s.denominator, s.nullReason, s.privacyClass, s.sourceEventCount, s.sourceWatermark, s.computedAt],
    );
  }
});

after(async () => {
  await pool?.end();
  await adminPool?.end();
});

test('grafana loads the provisioned dashboards and panels return snapshot values', async () => {
  // Some series hold more than one version, so a panel that read every version
  // instead of the latest would return extra rows.
  assert.ok(stored.length > DASHBOARD_METRICS.length * GOLDEN_WINDOWS.length, `${stored.length} rows written`);

  const health = await grafana('/api/health');
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(health.body.database, 'ok');
  assert.equal(health.body.version, '12.0.2');

  const dsUids = new Set(DASHBOARDS.flatMap((d) => d.panels.map((p) => p.targets[0]!.datasource.uid)));
  assert.equal(dsUids.size, 1, 'every panel reads one data source');
  const [dsUid] = [...dsUids];
  const ds = await grafana(`/api/datasources/uid/${dsUid}`);
  assert.equal(ds.status, 200, JSON.stringify(ds.body));
  assert.equal(ds.body.uid, dsUid);
  assert.equal(ds.body.type, 'grafana-postgresql-datasource');
  assert.equal(ds.body.jsonData.database, METRICS_DB);
  assert.equal(ds.body.readOnly, true, 'a provisioned data source cannot be edited from the UI');

  assert.equal(DASHBOARDS.length, 4);
  const from = String(Date.parse(GOLDEN_WINDOWS[0]!.start));
  const to = String(Date.parse(GOLDEN_WINDOWS.at(-1)!.end));
  const variables = { organization_id: scope.organizationId, project_id: scope.projectId };
  const checked: string[] = [];
  for (const d of DASHBOARDS) {
    const got = await dashboardByUid(d.uid);
    assert.equal(got.status, 200, `${d.uid}: ${JSON.stringify(got.body)}`);
    assert.equal(got.body.dashboard.uid, d.uid);
    assert.equal(got.body.dashboard.title, d.title);
    assert.equal(got.body.meta.provisioned, true, `${d.uid} comes from the provisioning, not the UI`);
    assert.equal(got.body.meta.folderUid, 'asep-assurance', d.uid);
    assert.deepEqual(
      got.body.dashboard.panels.map((p: Panel) => [p.id, p.targets[0]!.rawSql]),
      d.panels.map((p) => [p.id, p.targets[0]!.rawSql]),
      `${d.uid}: Grafana serves the committed panels`,
    );

    // the variables resolve to the project the snapshots belong to
    for (const v of d.templating.list) {
      const r = await grafana('/api/ds/query', {
        method: 'POST',
        body: { from, to, queries: [{ refId: v.name, datasource: { uid: dsUid }, format: 'table', rawQuery: true, rawSql: interpolate(v.query, variables) }] },
      });
      assert.equal(r.status, 200, `${d.uid} ${v.name}: ${JSON.stringify(r.body)}`);
      const values = r.body.results[v.name].frames[0].data.values[0];
      assert.deepEqual(values.map((x: string) => x.trim()), [variables[v.name as keyof typeof variables]], `${d.uid} ${v.name}`);
    }

    for (const p of d.panels) {
      const t = p.targets[0]!;
      const metric = /metric_name = '([a-z0-9_]+)'/.exec(t.rawSql)![1]!;
      const where = `${d.uid} panel ${p.id} (${metric})`;
      const r = await grafana('/api/ds/query', {
        method: 'POST',
        body: { from, to, queries: [{ ...t, rawSql: interpolate(t.rawSql, variables) }] },
      });
      assert.equal(r.status, 200, `${where}: ${JSON.stringify(r.body)}`);
      const rows = frameRows(r.body.results[t.refId], where);
      const expected = GOLDEN_VALUES[metric];
      assert.ok(expected, `${where}: the golden has the metric`);
      const latest = (i: number) =>
        Math.max(...stored.filter((s) => s.metricName === metric && s.windowStart === GOLDEN_WINDOWS[i]!.start).map((s) => s.snapshotVersion));
      assert.deepEqual(
        rows,
        GOLDEN_WINDOWS.map((w, i) => ({
          time: Date.parse(w.end),
          value: expected[i]!.value,
          nullReason: expected[i]!.nullReason,
          snapshotVersion: latest(i),
        })),
        where,
      );
      checked.push(metric);
    }
  }
  assert.deepEqual(checked.sort(), DASHBOARD_METRICS, 'every golden metric was checked through a panel');
});
