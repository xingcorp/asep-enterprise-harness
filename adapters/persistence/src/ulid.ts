// ULID generator (data-model §1). 26-char Crockford base32: 48-bit millisecond
// timestamp + 80-bit randomness, lexicographically sortable. App-generated so
// there is no database sequence or provider lock-in. Monotonic within a single
// millisecond: the random component is incremented rather than re-drawn, so IDs
// minted in the same ms still sort in creation order.

import { randomBytes } from 'node:crypto';

// Crockford base32 alphabet (no I, L, O, U).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_CHARS = 10; // 48 bits / 5 bits-per-char = 9.6 → 10 chars
const RAND_CHARS = 16; // 80 bits / 5 = 16 chars

let lastTime = -1;
let lastRand: number[] = [];

function encodeTime(now: number): string {
  let t = now;
  const out = new Array<string>(TIME_CHARS);
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    out[i] = ENCODING[mod]!;
    t = (t - mod) / ENCODING_LEN;
  }
  return out.join('');
}

function drawRandom(): number[] {
  // 16 base32 chars → 16 groups of 5 bits (80 bits) of randomness.
  const bytes = randomBytes(RAND_CHARS);
  return Array.from(bytes, (b) => b % ENCODING_LEN);
}

function incrementRandom(rand: number[]): number[] {
  const out = rand.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < ENCODING_LEN - 1) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0; // carry
  }
  // Overflowed 80 bits within one ms (astronomically unlikely) — redraw.
  return drawRandom();
}

/** Generate a monotonic ULID string. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRand = incrementRandom(lastRand);
  } else {
    lastTime = now;
    lastRand = drawRandom();
  }
  const rand = lastRand.map((n) => ENCODING[n]!).join('');
  return encodeTime(now) + rand;
}

/** True when s is a syntactically valid 26-char Crockford-base32 ULID. */
export function isUlid(s: string): boolean {
  if (s.length !== TIME_CHARS + RAND_CHARS) return false;
  for (const c of s) if (!ENCODING.includes(c)) return false;
  return true;
}
