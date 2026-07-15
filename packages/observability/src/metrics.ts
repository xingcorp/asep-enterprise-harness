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

export interface FilterCondition {
  readonly field: string;
  readonly equals?: unknown;
  readonly notEquals?: unknown;
}

export interface MetricOperand {
  readonly aggregation: 'count' | 'sum' | 'mean';
  readonly events: readonly string[];
  readonly fields?: readonly string[];
  // A single filter condition (back-compat).
  readonly filter?: FilterCondition;
  // A conjunction of filter conditions — ALL must hold (P1-FINAL-MED-003). This
  // is what lets an operand faithfully encode a formula's `where A=x and B=y`.
  readonly filters?: readonly FilterCondition[];
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

// All filter conditions on an operand, normalising the single-`filter` and the
// conjunctive-`filters` forms into one list (P1-FINAL-MED-003).
function operandConditions(op: MetricOperand | undefined): FilterCondition[] {
  if (!op) return [];
  const out: FilterCondition[] = [];
  if (op.filter) out.push(op.filter);
  if (op.filters) out.push(...op.filters);
  return out;
}

// Collect every field name a metric references (operand fields + filters + dims).
function operandFields(op: MetricOperand | undefined): string[] {
  if (!op) return [];
  const out: string[] = [];
  if (op.fields) out.push(...op.fields);
  for (const c of operandConditions(op)) out.push(c.field);
  return out;
}

function operandEvents(op: MetricOperand | undefined): string[] {
  return op ? [...op.events] : [];
}

// --- formula <-> operand agreement (P1-FINAL-MED-003) ------------------------
//
// Each metric carries a human-readable `formula` string AND a structured
// numerator/denominator operand. If the two disagree — e.g. the formula says
// `where outcome=accepted and repairCycles=0` but the operand only encodes
// `repairCycles=0` — the metric is a silent lie: the prose promises one thing,
// the machine computes another. We parse the fields named inside each `where`
// clause of the formula and assert every one is represented by an operand
// filter condition, and vice versa. This forces the conjunctive-filter form
// (`filters: [...]`) whenever a formula's where-clause has more than one term.

// Extract the set of field names named in every `where ...` clause of a formula.
// A where-clause runs from `where` up to the next `)` (operand boundary). Field
// names are the left-hand identifiers of `field=value` / `field!=value` terms.
export function formulaConditionFields(formula: string): Set<string> {
  const fields = new Set<string>();
  const whereRe = /where\s+([^)]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = whereRe.exec(formula)) !== null) {
    const clause = m[1]!;
    // split on `and` (case-insensitive) then take the identifier before =/!=
    for (const term of clause.split(/\s+and\s+/i)) {
      const t = term.trim();
      const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(!=|=)/.exec(t);
      if (fieldMatch) fields.add(fieldMatch[1]!);
    }
  }
  return fields;
}

// The set of fields a single operand encodes as filter conditions.
function operandFilterFieldSet(op: MetricOperand | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of operandConditions(op)) out.add(c.field);
  return out;
}

// Split a ratio formula into its numerator and denominator fragments on the
// single top-level `/` (the one NOT inside parentheses). Non-ratio formulas
// (no denominator) return the whole string as the numerator fragment. This lets
// us attribute each formula `where` clause to the correct operand so a
// numerator/denominator condition swap cannot slip through the agreement check.
export function splitFormula(formula: string): { numerator: string; denominator: string } {
  let depth = 0;
  for (let i = 0; i < formula.length; i++) {
    const c = formula[i]!;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '/' && depth === 0) {
      return {
        numerator: formula.slice(0, i),
        denominator: formula.slice(i + 1),
      };
    }
  }
  return { numerator: formula, denominator: '' };
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

    // formula <-> operand agreement (P1-FINAL-MED-003): every field named in a
    // `where` clause of the formula must be encoded as an operand filter
    // condition, and every operand filter field must appear in the formula.
    // This catches conjunctive drift (formula says `A=x and B=y` but operand
    // only filters on B) in BOTH directions, and — because we attribute each
    // where-clause to its own operand via splitFormula — also catches a
    // numerator/denominator condition swap.
    const { numerator: numFormula, denominator: denFormula } = splitFormula(m.formula);
    const operandChecks: { label: string; formula: string; op: MetricOperand | undefined }[] = [
      { label: 'numerator', formula: numFormula, op: m.numerator },
      { label: 'denominator', formula: denFormula, op: m.denominator },
    ];
    for (const { label, formula, op } of operandChecks) {
      const formulaFields = formulaConditionFields(formula);
      const opFields = operandFilterFieldSet(op);
      for (const f of formulaFields) {
        if (!opFields.has(f)) {
          errors.push({
            metric: m.name,
            problem: `${label} formula filters on "${f}" but the ${label} operand does not encode it (formula<->operand drift)`,
          });
        }
      }
      for (const f of opFields) {
        if (!formulaFields.has(f)) {
          errors.push({
            metric: m.name,
            problem: `${label} operand filters on "${f}" but the ${label} formula does not mention it (formula<->operand drift)`,
          });
        }
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
