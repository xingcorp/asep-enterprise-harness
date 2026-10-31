import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadMeasurementDictionary } from './metrics.js';

console.log('SUITE-ID: asep-suite:assurance-dashboards');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const PROVISIONING = join(REPO_ROOT, 'deploy', 'grafana', 'provisioning');
const DASHBOARD_DIR = join(PROVISIONING, 'dashboards', 'assurance');
// Where compose.yaml and the integration gate mount the provisioning directory.
const MOUNT = '/etc/grafana/provisioning';

// The dashboards and metrics plan §15 requires: false completion, review yield,
// cost and recovery.
const REQUIRED: Record<string, readonly string[]> = {
  'asep-false-completion': ['false_completion_rate'],
  'asep-review-yield': [
    'review_finding_yield', 'review_false_positive_rate', 'review_adjudication_coverage', 'review_ungrounded_rate',
    'reviewer_failure_rate', 'review_egress_stop_rate', 'shadow_would_block_rate', 'review_disposition_latency_ms',
    'repair_success_rate', 'review_escalation_rate',
  ],
  'asep-cost': ['cost_per_accepted_task', 'mean_review_cost_usd', 'review_cost_coverage'],
  'asep-recovery': ['workflow_recovery_rate'],
};

interface Target { refId: string; datasource: { type: string; uid: string }; format: string; rawQuery: boolean; rawSql: string }
interface Panel { id: number; type: string; title: string; datasource: { type: string; uid: string }; targets: Target[] }
interface Variable {
  name: string; type: string; datasource: { type: string; uid: string }; query: string; definition: string;
  allowCustomValue: boolean; multi: boolean; includeAll: boolean;
}
interface Dashboard { uid: string; title: string; editable: boolean; panels: Panel[]; templating: { list: Variable[] } }

function dashboards(): Dashboard[] {
  return readdirSync(DASHBOARD_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DASHBOARD_DIR, f), 'utf8')) as Dashboard);
}

function dataSource() {
  const doc = parseYaml(readFileSync(join(PROVISIONING, 'datasources', 'asep-metrics.yaml'), 'utf8')) as {
    apiVersion: number;
    datasources: { uid: string; type: string; url: string; user: string; editable: boolean;
      secureJsonData: Record<string, string>; jsonData: Record<string, unknown> }[];
  };
  assert.equal(doc.apiVersion, 1);
  assert.equal(doc.datasources.length, 1);
  return doc.datasources[0]!;
}

/** The one query every panel runs: the latest snapshot version of its metric, per window. */
function panelSql(metric: string, dictionaryVersion: string): string {
  return [
    'SELECT window_end AS "time", value, null_reason, snapshot_version',
    'FROM metric_snapshots_latest',
    "WHERE organization_id = '$organization_id'",
    "  AND project_id = '$project_id'",
    `  AND metric_name = '${metric}'`,
    `  AND dictionary_version = '${dictionaryVersion}'`,
    "  AND dimensions = '{}'::jsonb",
    '  AND $__timeFilter(window_end)',
    'ORDER BY window_end',
  ].join('\n');
}

test('panels and dictionary metrics correspond one to one', () => {
  const dict = loadMeasurementDictionary();
  const known = new Set(dict.metrics.map((m) => m.name));
  const ds = dataSource();
  const all = dashboards();
  assert.deepEqual(all.map((d) => d.uid).sort(), Object.keys(REQUIRED).sort(), 'exactly the four assurance dashboards');

  const seen = new Map<string, string>();
  for (const d of all) {
    assert.equal(d.editable, false, `${d.uid} is provisioned read-only`);
    assert.deepEqual(new Set(d.panels.map((p) => p.id)).size, d.panels.length, `${d.uid}: panel ids are unique`);
    const metrics: string[] = [];
    for (const p of d.panels) {
      const where = `${d.uid} panel ${p.id}`;
      assert.deepEqual(p.datasource, { type: ds.type, uid: ds.uid }, where);
      assert.equal(p.targets.length, 1, `${where} has one query`);
      const t = p.targets[0]!;
      assert.deepEqual(t.datasource, p.datasource, where);
      assert.equal(t.format, 'table', where);
      assert.equal(t.rawQuery, true, where);
      const metric = /metric_name = '([a-z0-9_]+)'/.exec(t.rawSql)?.[1];
      assert.ok(metric && known.has(metric), `${where} reads a dictionary metric, got ${metric}`);
      // the latest version only, of the current dictionary, for the whole project
      assert.equal(t.rawSql, panelSql(metric, dict.version), where);
      assert.ok(!seen.has(metric), `${metric} has one panel, not one on ${seen.get(metric)} and one on ${where}`);
      seen.set(metric, where);
      metrics.push(metric);
    }
    assert.deepEqual(metrics, REQUIRED[d.uid], `${d.uid} shows its required metrics`);
  }
  assert.deepEqual([...seen.keys()].sort(), Object.values(REQUIRED).flat().sort(), 'every required metric has a panel');
});

test('panels select their project through the organization and project variables', () => {
  const ds = dataSource();
  for (const d of dashboards()) {
    assert.deepEqual(d.templating.list.map((v) => [v.name, v.type]), [['organization_id', 'query'], ['project_id', 'query']], d.uid);
    for (const v of d.templating.list) {
      assert.deepEqual(v.datasource, { type: ds.type, uid: ds.uid }, `${d.uid} ${v.name}`);
      assert.equal(v.definition, v.query, `${d.uid} ${v.name}`);
      assert.match(v.query, /FROM metric_snapshots_latest/, `${d.uid} ${v.name}`);
      // Panels put the value into their SQL as it is: only a value the variable's
      // own query returned may be chosen, never one typed into the picker or URL.
      assert.equal(v.allowCustomValue, false, `${d.uid} ${v.name} takes no typed value`);
      assert.equal(v.multi, false, `${d.uid} ${v.name}`);
      assert.equal(v.includeAll, false, `${d.uid} ${v.name}`);
    }
    // a panel names no variable the dashboard does not define
    const names = new Set(d.templating.list.map((v) => v.name));
    for (const p of d.panels) {
      for (const m of p.targets[0]!.rawSql.matchAll(/\$(?!__)\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        assert.ok(names.has(m[1]!), `${d.uid} panel ${p.id} uses undefined variable ${m[1]}`);
      }
    }
  }
});

test('the data source and the dashboard provider are provisioned from the mounted directory', () => {
  const ds = dataSource();
  assert.equal(ds.uid, 'asep-metrics');
  assert.equal(ds.type, 'grafana-postgresql-datasource');
  assert.equal(ds.editable, false);
  // connection values come from the environment; no credential is written in the file
  assert.equal(ds.url, '${ASEP_METRICS_PG_HOST}');
  assert.equal(ds.user, '${ASEP_METRICS_PG_USER}');
  assert.deepEqual(ds.secureJsonData, { password: '${ASEP_METRICS_PG_PASSWORD}' });
  assert.equal(ds.jsonData['database'], '${ASEP_METRICS_PG_DATABASE}');

  const providers = parseYaml(readFileSync(join(PROVISIONING, 'dashboards', 'asep-assurance.yaml'), 'utf8')) as {
    apiVersion: number;
    providers: { type: string; disableDeletion: boolean; allowUiUpdates: boolean; options: { path: string } }[];
  };
  assert.equal(providers.apiVersion, 1);
  assert.equal(providers.providers.length, 1);
  const p = providers.providers[0]!;
  assert.equal(p.type, 'file');
  assert.equal(p.allowUiUpdates, false);
  assert.equal(p.options.path, `${MOUNT}/dashboards/assurance`, 'the provider reads the committed dashboard directory');
  assert.equal(join(PROVISIONING, p.options.path.slice(MOUNT.length)), DASHBOARD_DIR);
});
