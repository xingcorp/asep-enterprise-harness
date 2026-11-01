// Metric evaluator and versioned snapshot recompute.
//
// The evaluator is the single place the measurement dictionary's formulas are
// computed (docs/platform/metrics-dictionary.yaml). It reads RunEvents and the
// dictionary's own operands, filters, zero-denominator policies and privacy
// classes; it has no formula of its own.
//
// Per operand, in this order:
//   1. take the events of the operand's event types;
//   2. dedupeLatestBy: keep the latest event of each group, by (occurredAt,
//      eventId), so a later disposition of a finding replaces the earlier one;
//   3. keep the events whose window time (cohortBy, else occurredAt) falls in
//      [start, end), so a disposition counts in the cohort of the round it
//      disposes;
//   4. apply the filter conditions (all must hold);
//   5. aggregate, in event-id order: count the events, sum the listed fields,
//      or average them. A sum or mean skips an event that does not carry the
//      field: an unpriced review has no reviewCostUsd and is not averaged in as
//      zero.
//
// A value is a number or null with a reason, never both:
//   - a ratio whose denominator is 0 reports the metric's zeroDenominatorPolicy;
//   - a mean over no values reports `no-values-to-average`;
//   - a count or sum without a denominator over no source event reports
//     `no-source-events`;
//   - a metric whose privacy class captures only on opt-in, without that
//     opt-in, reports `capture-not-enabled` and reads nothing;
//   - a metric the dictionary declares notMeasured reports that reason and
//     reads nothing;
//   - a sum that overflows the finite range reports `aggregate-not-finite`;
//   - a source event without the dedupe key or the window time reports
//     `source-event-lacks-<field>` (`source-event-invalid-<field>` when it is
//     there but not a date-time, or a summed field that is not a number).
//
// A mean reports the sum of its values as numerator and their count as
// denominator, so a stored value can be re-derived from its row.
//
// Snapshots are append-only versions (data model §3.2): a recompute that
// changes nothing writes nothing, a changed value appends the next version, and
// earlier versions stay readable. Two recomputes cannot both write version n+1;
// the loser re-reads and decides again.

import { createHash } from 'node:crypto';
import type { RunEvent } from '@asep/contracts';
import { AGGREGATIONS, type FilterCondition, type MeasurementDictionary, type MetricDefinition, type MetricOperand } from './metrics.js';

/** Recorded on every snapshot; bump when a formula's computation changes. */
export const METRIC_EVALUATOR_VERSION = '1.0.0';

export const NO_VALUES_TO_AVERAGE = 'no-values-to-average';
export const NO_SOURCE_EVENTS = 'no-source-events';
export const CAPTURE_NOT_ENABLED = 'capture-not-enabled';
export const AGGREGATE_NOT_FINITE = 'aggregate-not-finite';

/** A half-open window [start, end) of ISO-8601 instants. */
export interface MetricWindow {
  readonly start: string;
  readonly end: string;
}

export interface MetricValue {
  readonly metricName: string;
  readonly privacyClass: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly nullReason: string | null;
  /** Distinct events the window considered, before the filter conditions. */
  readonly sourceEventCount: number;
}

export interface EvaluateOptions {
  /** Privacy classes whose capture is opt-in and which the operator enabled. */
  readonly captureOptIn?: readonly string[] | undefined;
}

interface OperandResult {
  readonly value: number | null;
  /** For a mean: the sum and count of the values. */
  readonly sum: number;
  readonly count: number;
  readonly considered: readonly RunEvent[];
}

class InvalidSourceEvent {
  constructor(readonly reason: string) {}
}

function field(event: RunEvent, name: string): unknown {
  return (event as unknown as Record<string, unknown>)[name];
}

function instant(event: RunEvent, name: string): number {
  const raw = field(event, name);
  if (raw === undefined || raw === null) throw new InvalidSourceEvent(`source-event-lacks-${name}`);
  const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(ms)) throw new InvalidSourceEvent(`source-event-invalid-${name}`);
  return ms;
}

function laterThan(a: RunEvent, b: RunEvent): boolean {
  const ta = instant(a, 'occurredAt');
  const tb = instant(b, 'occurredAt');
  return ta !== tb ? ta > tb : a.eventId > b.eventId;
}

function conditions(op: MetricOperand): FilterCondition[] {
  return [...(op.filter ? [op.filter] : []), ...(op.filters ?? [])];
}

function holds(event: RunEvent, c: FilterCondition): boolean {
  const v = field(event, c.field);
  return c.notEquals !== undefined ? v !== c.notEquals : v === c.equals;
}

function byEventId(a: RunEvent, b: RunEvent): number {
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function evaluateOperand(op: MetricOperand, events: readonly RunEvent[], start: number, end: number): OperandResult {
  if (!AGGREGATIONS.has(op.aggregation)) throw new Error(`unknown aggregation "${op.aggregation}"`);
  const types = new Set(op.events);
  // Aggregate in event-id order: a floating-point sum depends on its order, and
  // the same events read back in another order must give the same value.
  let selected = events.filter((e) => types.has(e.eventType)).sort(byEventId);
  if (op.dedupeLatestBy !== undefined) {
    const latest = new Map<unknown, RunEvent>();
    for (const e of selected) {
      const k = field(e, op.dedupeLatestBy);
      if (k === undefined || k === null) throw new InvalidSourceEvent(`source-event-lacks-${op.dedupeLatestBy}`);
      const prev = latest.get(k);
      if (!prev || laterThan(e, prev)) latest.set(k, e);
    }
    selected = [...latest.values()].sort(byEventId);
  }
  const windowField = op.cohortBy ?? 'occurredAt';
  const considered = selected.filter((e) => {
    const t = instant(e, windowField);
    return t >= start && t < end;
  });
  const matching = considered.filter((e) => conditions(op).every((c) => holds(e, c)));
  if (op.aggregation === 'count') return { value: matching.length, sum: matching.length, count: matching.length, considered };
  let sum = 0;
  let count = 0;
  for (const e of matching) {
    for (const f of op.fields ?? []) {
      const v = field(e, f);
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvalidSourceEvent(`source-event-invalid-${f}`);
      sum += v;
      count += 1;
    }
  }
  if (!Number.isFinite(sum)) throw new InvalidSourceEvent(AGGREGATE_NOT_FINITE);
  if (op.aggregation === 'sum') return { value: sum, sum, count, considered };
  return { value: count === 0 ? null : sum / count, sum, count, considered };
}

function parseWindow(window: MetricWindow): { start: number; end: number; startIso: string; endIso: string } {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new RangeError(`metric window [${window.start}, ${window.end}) is not a non-empty interval`);
  }
  return { start, end, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

function definition(dictionary: MeasurementDictionary, metricName: string): MetricDefinition {
  const m = dictionary.metrics.find((x) => x.name === metricName);
  if (!m) throw new Error(`unknown metric "${metricName}" (not in dictionary ${dictionary.version})`);
  return m;
}

/** Evaluate one dictionary metric over `events` in `window`. */
export function evaluateMetric(
  dictionary: MeasurementDictionary,
  metricName: string,
  events: readonly RunEvent[],
  window: MetricWindow,
  options: EvaluateOptions = {},
): MetricValue {
  const m = definition(dictionary, metricName);
  const w = parseWindow(window);
  const base = { metricName, privacyClass: m.privacyClass, windowStart: w.startIso, windowEnd: w.endIso };
  const rule = dictionary.privacyClasses[m.privacyClass];
  if (!rule) throw new Error(`metric "${metricName}" has unknown privacy class "${m.privacyClass}"`);
  if (rule.capture !== 'always' && !(options.captureOptIn ?? []).includes(m.privacyClass)) {
    return { ...base, value: null, numerator: null, denominator: null, nullReason: CAPTURE_NOT_ENABLED, sourceEventCount: 0 };
  }
  if (m.notMeasured !== undefined) {
    return { ...base, value: null, numerator: null, denominator: null, nullReason: m.notMeasured, sourceEventCount: 0 };
  }

  let num: OperandResult;
  let den: OperandResult | undefined;
  try {
    num = evaluateOperand(m.numerator, events, w.start, w.end);
    den = m.denominator ? evaluateOperand(m.denominator, events, w.start, w.end) : undefined;
  } catch (err) {
    if (!(err instanceof InvalidSourceEvent)) throw err;
    return { ...base, value: null, numerator: null, denominator: null, nullReason: err.reason, sourceEventCount: 0 };
  }
  const sourceEventCount = new Set([...num.considered, ...(den?.considered ?? [])].map((e) => e.eventId)).size;
  const result = (value: number | null, numerator: number | null, denominator: number | null, nullReason: string | null) =>
    ({ ...base, value, numerator, denominator, nullReason, sourceEventCount });

  if (den) {
    const numerator = num.value;
    const denominator = den.value;
    if (denominator === null) return result(null, numerator, null, NO_VALUES_TO_AVERAGE);
    if (denominator === 0) {
      return result(null, numerator, 0, m.zeroDenominatorPolicy ?? 'zero-denominator');
    }
    if (numerator === null) return result(null, null, denominator, NO_VALUES_TO_AVERAGE);
    return result(numerator / denominator, numerator, denominator, null);
  }
  if (m.numerator.aggregation === 'mean') {
    return num.value === null
      ? result(null, num.sum, num.count, NO_VALUES_TO_AVERAGE)
      : result(num.value, num.sum, num.count, null);
  }
  if (sourceEventCount === 0) return result(null, num.value, null, NO_SOURCE_EVENTS);
  return result(num.value, num.value, null, null);
}

// --- versioned snapshots ------------------------------------------------------

export interface MetricSnapshotScope {
  readonly organizationId: string;
  readonly projectId: string;
}

/** What identifies one snapshot series; its versions count from 1. */
export interface MetricSnapshotKey extends MetricSnapshotScope {
  readonly metricName: string;
  readonly dictionaryVersion: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly dimensionsSha256: string;
}

/** One row of `metric_snapshots` (data model §3.2), without its storage id. */
export interface MetricSnapshot extends MetricSnapshotKey {
  readonly evaluatorVersion: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly snapshotVersion: number;
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly nullReason: string | null;
  readonly privacyClass: string;
  readonly sourceEventCount: number;
  readonly sourceWatermark: string | null;
  readonly computedAt: string;
}

/**
 * `appended`: the row is stored. `version-taken`: another writer already holds
 * that version or a later one, so the caller re-reads the latest and decides
 * again. Any other refusal (a gap in the versions, a version that repeats its
 * predecessor's value, a row that breaks a check constraint) throws: it is a
 * caller defect, not a race.
 */
export type MetricSnapshotAppendResult = 'appended' | 'version-taken';

export interface MetricSnapshotStore {
  latest(key: MetricSnapshotKey): Promise<MetricSnapshot | null>;
  append(snapshot: MetricSnapshot): Promise<MetricSnapshotAppendResult>;
}

/** A snapshot the store's rules refuse. */
export class MetricSnapshotRejectedError extends Error {
  override readonly name = 'MetricSnapshotRejectedError';
}

const PRIVACY_CLASSES: ReadonlySet<string> = new Set(['public', 'operational', 'sensitive', 'restricted']);

function seriesKey(k: MetricSnapshotKey): string {
  return JSON.stringify([k.organizationId, k.projectId, k.metricName, k.dictionaryVersion, k.windowStart, k.windowEnd, k.dimensionsSha256]);
}

function sameValue(a: MetricSnapshot, b: Pick<MetricSnapshot, 'value' | 'numerator' | 'denominator' | 'nullReason'>): boolean {
  return a.value === b.value && a.numerator === b.numerator && a.denominator === b.denominator && a.nullReason === b.nullReason;
}

/**
 * In-memory snapshot store with the rules of the `metric_snapshots` table: the
 * check constraints, versions contiguous from 1, each version a change of
 * value, numerator, denominator or null reason, and no update or delete.
 */
export class MemoryMetricSnapshotStore implements MetricSnapshotStore {
  readonly #series = new Map<string, MetricSnapshot[]>();
  readonly #rows: MetricSnapshot[] = [];

  async latest(key: MetricSnapshotKey): Promise<MetricSnapshot | null> {
    return this.#series.get(seriesKey(key))?.at(-1) ?? null;
  }

  async append(snapshot: MetricSnapshot): Promise<MetricSnapshotAppendResult> {
    const reject = (why: string): never => {
      throw new MetricSnapshotRejectedError(`metric snapshot ${snapshot.metricName} v${snapshot.snapshotVersion}: ${why}`);
    };
    if (!(Date.parse(snapshot.windowEnd) > Date.parse(snapshot.windowStart))) reject('window_end must be after window_start');
    if ((snapshot.value === null) !== (snapshot.nullReason !== null)) reject('a value and a null reason exclude each other');
    if (!PRIVACY_CLASSES.has(snapshot.privacyClass)) reject(`unknown privacy class "${snapshot.privacyClass}"`);
    if (!/^[0-9a-f]{64}$/.test(snapshot.dimensionsSha256)) reject('dimensions_sha256 is not a sha256');
    if (!Number.isInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1 || snapshot.sourceEventCount < 0) {
      reject('versions start at 1 and counts are not negative');
    }
    const k = seriesKey(snapshot);
    const series = this.#series.get(k) ?? [];
    const prev = series.at(-1);
    if (prev && snapshot.snapshotVersion <= prev.snapshotVersion) return 'version-taken';
    if (!prev && snapshot.snapshotVersion !== 1) reject('the first snapshot version must be 1');
    if (prev && snapshot.snapshotVersion !== prev.snapshotVersion + 1) reject(`the next version is ${prev.snapshotVersion + 1}`);
    if (prev && sameValue(prev, snapshot)) reject(`it repeats version ${prev.snapshotVersion}`);
    const row = Object.freeze({ ...snapshot, dimensions: Object.freeze({ ...snapshot.dimensions }) });
    series.push(row);
    this.#series.set(k, series);
    this.#rows.push(row);
    return 'appended';
  }

  /** Every version of one series, oldest first. */
  versions(key: MetricSnapshotKey): readonly MetricSnapshot[] {
    return [...(this.#series.get(seriesKey(key)) ?? [])];
  }

  /** Every stored row, in the order it was appended. */
  all(): readonly MetricSnapshot[] {
    return [...this.#rows];
  }
}

export interface RecomputeInput extends EvaluateOptions {
  readonly store: MetricSnapshotStore;
  readonly scope: MetricSnapshotScope;
  readonly dictionary: MeasurementDictionary;
  /** Metrics to recompute; every dictionary metric when absent. */
  readonly metricNames?: readonly string[] | undefined;
  readonly windows: readonly MetricWindow[];
  /** The scope's events; the caller reads them for this scope only. */
  readonly events: readonly RunEvent[];
  /** The recompute's logical time, recorded as computed_at. */
  readonly computedAt: string;
  /** The newest insertion time among the events read, when the caller knows it. */
  readonly sourceWatermark?: string | null | undefined;
}

export interface RecomputeResult {
  readonly appended: readonly MetricSnapshot[];
  /** Series whose latest version already held the computed value. */
  readonly unchanged: number;
}

// Snapshot dimensions are not broken down yet: every series is the whole scope.
const NO_DIMENSIONS: Readonly<Record<string, string>> = Object.freeze({});
const NO_DIMENSIONS_SHA256 = createHash('sha256').update(JSON.stringify(NO_DIMENSIONS)).digest('hex');
const MAX_APPEND_ATTEMPTS = 5;

/**
 * Recompute each metric in each window and append a new snapshot version
 * wherever the value changed. A late disposition recomputes its round's cohort.
 */
export async function recomputeMetricSnapshots(input: RecomputeInput): Promise<RecomputeResult> {
  const computedMs = Date.parse(input.computedAt);
  if (!Number.isFinite(computedMs)) throw new RangeError(`computedAt "${input.computedAt}" is not an instant`);
  const computedAt = new Date(computedMs).toISOString();
  const names = [...new Set(input.metricNames ?? input.dictionary.metrics.map((m) => m.name))].sort();
  for (const name of names) definition(input.dictionary, name);
  const values = names.flatMap((name) =>
    input.windows.map((w) => evaluateMetric(input.dictionary, name, input.events, w, { captureOptIn: input.captureOptIn })),
  );

  const appended: MetricSnapshot[] = [];
  let unchanged = 0;
  for (const v of values) {
    const key: MetricSnapshotKey = {
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
      metricName: v.metricName,
      dictionaryVersion: input.dictionary.version,
      windowStart: v.windowStart,
      windowEnd: v.windowEnd,
      dimensionsSha256: NO_DIMENSIONS_SHA256,
    };
    for (let attempt = 1; ; attempt += 1) {
      const prev = await input.store.latest(key);
      if (prev && sameValue(prev, v)) {
        unchanged += 1;
        break;
      }
      const snapshot: MetricSnapshot = Object.freeze({
        ...key,
        evaluatorVersion: METRIC_EVALUATOR_VERSION,
        dimensions: NO_DIMENSIONS,
        snapshotVersion: (prev?.snapshotVersion ?? 0) + 1,
        value: v.value,
        numerator: v.numerator,
        denominator: v.denominator,
        nullReason: v.nullReason,
        privacyClass: v.privacyClass,
        sourceEventCount: v.sourceEventCount,
        sourceWatermark: input.sourceWatermark ?? null,
        computedAt,
      });
      if ((await input.store.append(snapshot)) === 'appended') {
        appended.push(snapshot);
        break;
      }
      if (attempt >= MAX_APPEND_ATTEMPTS) {
        throw new Error(`metric snapshot ${v.metricName} [${v.windowStart}, ${v.windowEnd}): lost the version race ${attempt} times`);
      }
    }
  }
  return { appended, unchanged };
}
