export interface CorrelationContext {
  readonly traceId: string;
  readonly tenantId: string;
  readonly projectId: string;
  // MED-003: the full correlation identity a span/audit row must be able to
  // carry. organizationId is the authenticated tenant root (distinct from the
  // legacy tenantId string), and repositoryBindingId ties an event to the exact
  // repo it acted on. Both optional so pure/unit contexts stay minimal, but the
  // pipeline instrumentation populates them so J2/J4 rows resolve to one point
  // in the org/project/repository/run/task/attempt hierarchy.
  readonly organizationId?: string;
  readonly repositoryBindingId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly agentId?: string;
  readonly workspaceId?: string;
}

export interface MetricPoint {
  readonly name: string;
  readonly value: number;
  readonly attributes: Readonly<Record<string,string|number|boolean>>;
}

export interface TelemetrySink {
  event(name: string, context: CorrelationContext, attributes: Readonly<Record<string,unknown>>): void;
  metric(point: MetricPoint): void;
}

export class ConsoleTelemetrySink implements TelemetrySink {
  event(name: string, context: CorrelationContext, attributes: Readonly<Record<string,unknown>>): void {
    console.log(JSON.stringify({ type: 'event', name, context, attributes, at: new Date().toISOString() }));
  }
  metric(point: MetricPoint): void {
    console.log(JSON.stringify({ type: 'metric', ...point, at: new Date().toISOString() }));
  }
}

// Measurement dictionary (machine-readable) loader + referential-integrity validator.
export {
  loadMeasurementDictionary,
  validateDictionary,
  assertDictionaryValid,
  metricNames,
  metricFamilies,
  type MeasurementDictionary,
  type MetricDefinition,
  type MetricOperand,
  type PrivacyClassRule,
  type DictionaryError,
} from './metrics.js';

// EvidenceBundle generator (schema-valid; raw output referenced, never reduced).
export {
  generateEvidenceBundle,
  type EvidenceInput,
  type RawCheckCapture,
} from './evidence.js';

// OTel-style span vocabulary + tracer (exit J1/J2) and the capturing sink used
// by tests and a Temporal-shaped in-memory exporter.
export {
  SPAN_NAMES,
  isSpanName,
  SpanTracer,
  CapturingTelemetrySink,
  type SpanName,
  type SpanStatus,
  type SpanRecord,
  type SpanHandle,
  type Clock,
  type CapturedEvent,
} from './spans.js';

// Privileged-operation audit vocabulary (exit J4). The concrete
// PostgreSQL-backed sink lives in adapters/persistence; this is the pure shape
// + the closed set of auditable privileged actions.
export {
  PRIVILEGED_ACTIONS,
  isPrivilegedAction,
  auditEvent,
  type PrivilegedAction,
  type AuditEvent,
  type AuditSink,
} from './audit.js';

// Metric evaluator over RunEvents and the dictionary, with append-only snapshot
// versions, plus the golden fixture its unit test and the dashboard itest share.
export {
  METRIC_EVALUATOR_VERSION,
  NO_VALUES_TO_AVERAGE,
  NO_SOURCE_EVENTS,
  CAPTURE_NOT_ENABLED,
  evaluateMetric,
  recomputeMetricSnapshots,
  MemoryMetricSnapshotStore,
  MetricSnapshotRejectedError,
  type MetricWindow,
  type MetricValue,
  type EvaluateOptions,
  type MetricSnapshotScope,
  type MetricSnapshotKey,
  type MetricSnapshot,
  type MetricSnapshotAppendResult,
  type MetricSnapshotStore,
  type RecomputeInput,
  type RecomputeResult,
} from './metric-eval.js';
export {
  GOLDEN_WINDOWS,
  GOLDEN_CAPTURE_OPT_IN,
  GOLDEN_EVENTS,
  GOLDEN_EVENTS_BY_DAY,
  GOLDEN_VALUES,
  type GoldenValue,
} from './metric-eval-golden.js';
