export interface CorrelationContext {
  readonly traceId: string;
  readonly tenantId: string;
  readonly projectId: string;
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
