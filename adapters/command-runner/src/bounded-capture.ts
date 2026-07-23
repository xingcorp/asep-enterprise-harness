// Bounded streaming output capture (exit criterion D5, disp. P2-PLAN-MED-002).
//
// A verification command's raw stdout/stderr must be captured IN FULL up to a
// hard evidence cap and stored as an immutable artifact BEFORE any summary or
// reducer sees it. Capture is bounded: once maxEvidenceBytes is exceeded the
// stream is truncated with an explicit marker and the `truncated` flag is set,
// so a runaway process cannot exhaust memory, and a required check that needs
// complete evidence can fail closed on the marker rather than trust a summary.
//
// This is a pure, stream-agnostic accumulator so it is unit-testable without a
// real child process: feed it chunks, read back the bounded bytes + a truthful
// byte count of everything that arrived (even bytes past the cap).

export interface BoundedCaptureResult {
  // The retained bytes (<= maxEvidenceBytes, plus the truncation marker if it
  // fired). These are the bytes stored as the evidence artifact.
  readonly bytes: Uint8Array;
  // The TRUE number of bytes that streamed through, including any dropped past
  // the cap — never understated, so evidence accounting stays honest.
  readonly totalBytes: number;
  readonly truncated: boolean;
}

const TRUNCATION_MARKER = '\n[asep: output truncated — evidence cap reached]\n';

export class BoundedCapture {
  private readonly chunks: Uint8Array[] = [];
  private retained = 0;
  private total = 0;
  private didTruncate = false;

  constructor(private readonly maxEvidenceBytes: number) {}

  // Accept one chunk. Retains bytes up to the cap; counts every byte in `total`.
  push(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    if (this.didTruncate) return;
    const remaining = this.maxEvidenceBytes - this.retained;
    if (chunk.byteLength <= remaining) {
      this.chunks.push(chunk);
      this.retained += chunk.byteLength;
      return;
    }
    // Partial fit then truncate.
    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.retained += remaining;
    }
    this.didTruncate = true;
  }

  result(): BoundedCaptureResult {
    const parts = this.chunks.slice();
    if (this.didTruncate) parts.push(new TextEncoder().encode(TRUNCATION_MARKER));
    const size = parts.reduce((n, p) => n + p.byteLength, 0);
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.byteLength;
    }
    return { bytes, totalBytes: this.total, truncated: this.didTruncate };
  }
}

export { TRUNCATION_MARKER };
