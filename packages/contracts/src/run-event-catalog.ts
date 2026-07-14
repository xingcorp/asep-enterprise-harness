// RunEvent field + eventType catalog.
//
// The measurement dictionary (docs/platform/metrics-dictionary.yaml) may only
// reference event types and field names that actually exist on the RunEvent
// contract. This module reads the authoritative run-event schema and exposes
// the closed set of eventType values and property names so the metrics
// validator (Codex P1-METRIC-002) can enforce referential integrity: a metric
// whose source-event or formula operand is not in this catalog fails the gate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_EVENT_SCHEMA = join(HERE, '..', 'schema', 'run-event.schema.json');

interface RunEventSchema {
  properties: Record<string, { enum?: readonly string[] }>;
}

let cache: { fields: readonly string[]; eventTypes: readonly string[] } | undefined;

function load(): { fields: readonly string[]; eventTypes: readonly string[] } {
  if (cache) return cache;
  const schema = JSON.parse(readFileSync(RUN_EVENT_SCHEMA, 'utf8')) as RunEventSchema;
  const fields = Object.keys(schema.properties).sort();
  const eventTypes = [...(schema.properties['eventType']?.enum ?? [])].sort();
  cache = { fields, eventTypes };
  return cache;
}

/** All RunEvent property names (sorted). Metric operands must be a subset. */
export function runEventFields(): readonly string[] {
  return load().fields;
}

/** The closed set of RunEvent.eventType values (sorted). */
export function runEventTypes(): readonly string[] {
  return load().eventTypes;
}

/** Whether a field name exists on the RunEvent contract. */
export function isRunEventField(name: string): boolean {
  return load().fields.includes(name);
}

/** Whether an event-type string is a defined RunEvent.eventType. */
export function isRunEventType(name: string): boolean {
  return load().eventTypes.includes(name);
}
