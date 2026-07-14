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
