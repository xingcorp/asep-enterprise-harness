// Measurement dictionary loader + referential-integrity validator.
//
// The machine-readable dictionary at docs/platform/metrics-dictionary.yaml is
// the single source of metric definitions. This module loads it and validates
// (Codex P1-METRIC-002 + P1-METRIC-003):
//   - every sourceEvent is a defined RunEvent.eventType
//   - every numerator/denominator event is a defined RunEvent.eventType
//   - every field referenced (numerator/denominator fields, filter fields,
//     dimensions) is a defined RunEvent property name
//   - every ratio metric (one with a denominator) declares a zeroDenominatorPolicy
//   - every metric declares a privacyClass drawn from the closed enum
//
// Validation is DETERMINISTIC: file read + parse + set membership. No model,
// no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isRunEventField, isRunEventType } from '@asep/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/observability/src -> repo root is three levels up.
const REPO_ROOT = join(HERE, '..', '..', '..');
const DICTIONARY_PATH = join(REPO_ROOT, 'docs', 'platform', 'metrics-dictionary.yaml');

export interface MetricOperand {
  readonly aggregation: 'count' | 'sum' | 'mean';
  readonly events: readonly string[];
  readonly fields?: readonly string[];
  readonly filter?: { field: string; equals?: unknown; notEquals?: unknown };
}

export interface MetricDefinition {
  readonly name: string;
  readonly family: string;
  readonly purpose: string;
  readonly formula: string;
  readonly numerator: MetricOperand;
  readonly denominator?: MetricOperand;
  readonly dimensions?: readonly string[];
  readonly sourceEvents: readonly string[];
  readonly owner: string;
  readonly sampling: string;
  readonly alertRelevance: string;
  readonly zeroDenominatorPolicy?: string;
  readonly privacyClass: string;
}

export interface PrivacyClassRule {
  readonly description: string;
  readonly capture: string;
  readonly redaction: string;
  readonly retentionDays: number;
  readonly access: string;
}

export interface MeasurementDictionary {
  readonly version: string;
  readonly privacyClasses: Record<string, PrivacyClassRule>;
  readonly metrics: readonly MetricDefinition[];
}

export function loadMeasurementDictionary(): MeasurementDictionary {
  return parseYaml(readFileSync(DICTIONARY_PATH, 'utf8')) as MeasurementDictionary;
}

export interface DictionaryError {
  readonly metric: string;
  readonly problem: string;
}

// Collect every field name a metric references (operand fields + filter + dims).
function operandFields(op: MetricOperand | undefined): string[] {
  if (!op) return [];
  const out: string[] = [];
  if (op.fields) out.push(...op.fields);
  if (op.filter) out.push(op.filter.field);
  return out;
}

function operandEvents(op: MetricOperand | undefined): string[] {
  return op ? [...op.events] : [];
}

/**
 * Validate the dictionary's referential integrity against the RunEvent catalog.
 * Returns an array of errors; an empty array means the dictionary is valid.
 */
export function validateDictionary(dict: MeasurementDictionary): DictionaryError[] {
  const errors: DictionaryError[] = [];
  const privacyClasses = new Set(Object.keys(dict.privacyClasses ?? {}));

  for (const m of dict.metrics) {
    // privacy class must be from the closed enum
    if (!privacyClasses.has(m.privacyClass)) {
      errors.push({ metric: m.name, problem: `unknown privacyClass "${m.privacyClass}"` });
    }

    // source events + operand events must be defined RunEvent.eventType values
    const allEvents = [
      ...m.sourceEvents,
      ...operandEvents(m.numerator),
      ...operandEvents(m.denominator),
    ];
    for (const ev of allEvents) {
      if (!isRunEventType(ev)) {
        errors.push({ metric: m.name, problem: `unknown source event "${ev}" (not a RunEvent.eventType)` });
      }
    }

    // every referenced field must be a RunEvent property
    const allFields = [
      ...operandFields(m.numerator),
      ...operandFields(m.denominator),
      ...(m.dimensions ?? []),
    ];
    for (const f of allFields) {
      if (!isRunEventField(f)) {
        errors.push({ metric: m.name, problem: `unknown field "${f}" (not a RunEvent property)` });
      }
    }

    // a ratio metric (has a denominator) must declare a zero-denominator policy,
    // UNLESS the denominator is a mean/sum over a scalar that cannot be zero by
    // construction. We require the policy whenever a denominator exists and the
    // denominator aggregation is `count` or `sum` (both can be zero).
    if (m.denominator) {
      const denomAgg = m.denominator.aggregation;
      if ((denomAgg === 'count' || denomAgg === 'sum') && !m.zeroDenominatorPolicy) {
        errors.push({ metric: m.name, problem: 'ratio metric missing zeroDenominatorPolicy' });
      }
    }
  }

  return errors;
}

/** Convenience: load + validate, throwing on any error. */
export function assertDictionaryValid(): MeasurementDictionary {
  const dict = loadMeasurementDictionary();
  const errors = validateDictionary(dict);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.metric}: ${e.problem}`).join('; ');
    throw new Error(`measurement dictionary invalid: ${detail}`);
  }
  return dict;
}

/** All metric names (sorted, deterministic). */
export function metricNames(): string[] {
  return loadMeasurementDictionary().metrics.map((m) => m.name).sort();
}

/** All distinct metric families present in the dictionary (sorted). */
export function metricFamilies(): string[] {
  return [...new Set(loadMeasurementDictionary().metrics.map((m) => m.family))].sort();
}
