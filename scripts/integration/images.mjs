// Digest-pinned integration backend images (disp. P2-FINAL-HIGH-001).
//
// Every image the integration gate provisions is pinned BY DIGEST, never by a
// mutable tag. A tag can be re-pointed at new bytes under our feet; a
// @sha256:<64hex> digest names exactly one immutable manifest, so the gate
// proves the code against a KNOWN backend build and cannot silently drift.
//
// These digests were captured from the images pulled on the build host
// (docker manifest inspect / images --digests). Each names a multi-arch index
// with linux/amd64 and linux/arm64, so one pin serves the CI runner and an
// arm64 developer host. Changing a digest here is a deliberate, reviewable act
// — exactly the property HIGH-001 requires.

export const IMAGES = Object.freeze({
  // PostgreSQL — the authoritative metadata backend. postgres:17.
  postgres:
    'postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d',
  // VersityGW v1.10.0 (Apache-2.0) — the S3-compatible object store for
  // artifact bytes, serving a POSIX directory. It replaced MinIO, whose image
  // Docker Hub no longer serves.
  objectStore:
    'versity/versitygw@sha256:89cad13cc981986ee284cbafea4613f9533ce6fd5f37a2c96c4c4fb8adb3a316',
  // node:20-alpine (multi-arch index) — runs the canary agent and the egress
  // proxy in adapters/agent-claude/src/agent-sandbox.itest.ts, and is an egress
  // proxy image a pilot can pin (ASEP_EGRESS_PROXY_IMAGE_DIGEST).
  node:
    'node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293',
});

// How the object store is run, by the gate and by compose.yaml alike (an
// executable parity test holds them equal): the S3 API on its default port,
// a health endpoint, and the POSIX backend over /srv. The POSIX backend keeps
// each object's metadata — its checksums among them — in extended attributes.
export const OBJECT_STORE_PORT = 7070;
export const OBJECT_STORE_HEALTH_PATH = '/health';
export const OBJECT_STORE_ARGS = Object.freeze(['--health', OBJECT_STORE_HEALTH_PATH, 'posix', '/srv']);

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
