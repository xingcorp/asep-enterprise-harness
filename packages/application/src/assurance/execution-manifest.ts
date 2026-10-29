// Execution manifest helpers: bounded output excerpts and test-runner summaries.
//
// Summaries are parsed only from formats this module recognizes (node:test spec and
// TAP reporters, Vitest, Jest). Anything else yields null; a count is never guessed.

import type { TestSummary } from './local-types.js';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

type Counts = { tests: number; pass: number; fail: number; skipped: number; todo: number };

function empty(): Counts {
  return { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
}

/** node:test spec (`ℹ tests 3`) or TAP (`# tests 3`) footer lines, summed over every run in the stream. */
function footer(text: string, marker: 'ℹ' | '#'): Counts | null {
  const re = new RegExp(`^${marker} (tests|pass|fail|cancelled|skipped|skip|todo) (\\d+)\\s*$`, 'gm');
  const counts = empty();
  let sawTests = false;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]);
    switch (m[1]) {
      case 'tests':
        counts.tests += n;
        sawTests = true;
        break;
      case 'pass':
        counts.pass += n;
        break;
      // A cancelled test did not pass; it is counted as a failure.
      case 'fail':
      case 'cancelled':
        counts.fail += n;
        break;
      case 'skipped':
      case 'skip':
        counts.skipped += n;
        break;
      case 'todo':
        counts.todo += n;
        break;
    }
  }
  return sawTests ? counts : null;
}

function tally(parts: string, counts: Counts): void {
  for (const m of parts.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
    const n = Number(m[1]);
    if (m[2] === 'passed') counts.pass += n;
    else if (m[2] === 'failed') counts.fail += n;
    else if (m[2] === 'skipped') counts.skipped += n;
    else counts.todo += n;
  }
}

/** Vitest: `Tests  3 failed | 9 passed (12)`. */
function vitest(text: string): Counts | null {
  const counts = empty();
  let seen = false;
  for (const m of text.matchAll(/^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/gm)) {
    seen = true;
    counts.tests += Number(m[2]);
    tally(m[1]!, counts);
  }
  return seen ? counts : null;
}

/** Jest: `Tests:       1 failed, 10 passed, 11 total`. */
function jest(text: string): Counts | null {
  const counts = empty();
  let seen = false;
  for (const m of text.matchAll(/^Tests:\s+(.+?)\s*$/gm)) {
    const total = /(\d+)\s+total/.exec(m[1]!);
    if (total === null) continue;
    seen = true;
    counts.tests += Number(total[1]);
    tally(m[1]!, counts);
  }
  return seen ? counts : null;
}

/** The test summary printed by a known runner, or null when none is recognized. */
export function parseTestSummary(output: string): TestSummary | null {
  const text = output.replace(ANSI, '').replace(/\r\n?/g, '\n');
  const nodeTest = footer(text, 'ℹ');
  if (nodeTest !== null) return { runner: 'node:test', ...nodeTest };
  const v = vitest(text);
  if (v !== null) return { runner: 'vitest', ...v };
  const j = jest(text);
  if (j !== null) return { runner: 'jest', ...j };
  const tap = footer(text, '#');
  if (tap !== null) return { runner: 'tap', ...tap };
  return null;
}

/**
 * The last `maxBytes` bytes of a stream as UTF-8 text, starting at a character boundary.
 * Null when that tail is not valid UTF-8.
 */
export function excerptTail(content: Uint8Array, maxBytes: number): { readonly text: string; readonly bytes: number } | null {
  let start = Math.max(0, content.byteLength - Math.max(0, maxBytes));
  while (start < content.byteLength && (content[start]! & 0xc0) === 0x80) start += 1;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(start));
    return { text, bytes: content.byteLength - start };
  } catch {
    return null;
  }
}
