// Digest-pinned integration backend images (disp. P2-FINAL-HIGH-001).
//
// Every image the integration gate provisions is pinned BY DIGEST, never by a
// mutable tag. A tag can be re-pointed at new bytes under our feet; a
// @sha256:<64hex> digest names exactly one immutable manifest, so the gate
// proves the code against a KNOWN backend build and cannot silently drift.
//
// These digests were captured from the images pulled on the build host
// (docker manifest inspect / images --digests). Changing a digest here is a
// deliberate, reviewable act — exactly the property HIGH-001 requires.

export const IMAGES = Object.freeze({
  // PostgreSQL — the authoritative metadata backend. postgres:17.
  postgres:
    'postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d',
  // MinIO — S3-compatible object store for artifact bytes.
  minio:
    'minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e',
  // node:20-alpine (multi-arch index) — runs the canary agent and the egress
  // proxy in adapters/agent-claude/src/agent-sandbox.itest.ts, and is an egress
  // proxy image a pilot can pin (ASEP_EGRESS_PROXY_IMAGE_DIGEST).
  node:
    'node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293',
});

// The literal digest-pin guard the negative tests assert on: any value that is
// not @sha256:<64 hex> must be rejected before a container is ever started.
export const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

export function assertDigestPinned(ref) {
  if (!DIGEST_PINNED.test(ref)) {
    throw new Error(
      `integration image '${ref}' is not digest-pinned (must end @sha256:<64hex>); ` +
        `refusing to provision a mutable-tag backend (P2-FINAL-HIGH-001)`,
    );
  }
  return ref;
}
