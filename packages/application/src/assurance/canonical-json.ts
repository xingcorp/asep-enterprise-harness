// Canonical JSON: sorted object keys, no insignificant whitespace, no undefined.
// Identifiers and digests of review artifacts are computed over these bytes, so the
// same facts always serialize to the same bytes.

import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonical JSON: not a plain object');
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The key of a tuple of fields: the canonical JSON of the array. Every identity, fingerprint,
 * dedupe and ordering key is one, never a joined string, so no separator inside a field can make
 * two different tuples equal, and `null` and `""` stay distinct.
 */
export function tupleKey(fields: readonly unknown[]): string {
  return canonicalJson(fields);
}

/** The sha256 of a tuple's key. */
export function tupleSha256(fields: readonly unknown[]): string {
  return sha256Hex(tupleKey(fields));
}
