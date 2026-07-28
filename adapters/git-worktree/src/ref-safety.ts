// RefSafetyPolicy — non-bypassable (architecture §16, exit criterion H3, disp.
// P2-PLAN-CRIT-001). The single CRITICAL finding: with Contents:write and a
// free-form branch argument the harness could push straight to `main`. The
// mitigation is enforced BY CONSTRUCTION here:
//   - push targets are GENERATED under an ASEP-owned namespace
//     `asep/<runId>/<taskId>/<attemptId>` — the caller cannot supply a raw ref;
//   - the head must not equal a configured default/protected ref;
//   - the ref is validated with git check-ref-format grammar (mirrored here as
//     a strict regex) — tags, HEAD, option-like and malformed refs rejected;
//   - only an exact create/update refspec is allowed; deletion and force are
//     prohibited (force is expressible only as --force-with-lease against a
//     recorded expected SHA, which this module never emits as a plain force).
//
// This module builds the ONLY refspec the forge adapter is allowed to send, so
// the transport layer physically cannot push anywhere else.

import type { RunId, TaskId, AttemptId } from '@asep/contracts';

export class RefSafetyError extends Error {
  constructor(reason: string) {
    super(`ref-safety violation: ${reason}`);
    this.name = 'RefSafetyError';
  }
}

// Default/protected refs that a push may NEVER target, regardless of namespace.
const PROTECTED_REFS = new Set([
  'main', 'master', 'HEAD', 'trunk', 'develop', 'release',
]);

// A single ASEP branch path segment produced from a ULID id. ULIDs are
// [0-9A-HJKMNP-TV-Z]{26}; we accept that class so a crafted id cannot inject a
// path separator, option, or ref metacharacter.
const ID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// git check-ref-format (short-branch) essentials: no leading '-', no '..', no
// control chars, no space, no ~^:?*[\, no trailing '/' or '.lock', no '@{'.
function assertValidRefFormat(ref: string): void {
  if (ref.length === 0) throw new RefSafetyError('empty ref');
  if (ref.startsWith('-')) throw new RefSafetyError(`ref '${ref}' looks like an option`);
  if (ref.startsWith('/') || ref.endsWith('/')) throw new RefSafetyError(`ref '${ref}' has a leading/trailing slash`);
  if (ref.endsWith('.lock')) throw new RefSafetyError(`ref '${ref}' ends with .lock`);
  if (ref.includes('..')) throw new RefSafetyError(`ref '${ref}' contains '..'`);
  if (ref.includes('@{')) throw new RefSafetyError(`ref '${ref}' contains '@{'`);
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)) throw new RefSafetyError(`ref '${ref}' contains a forbidden character`);
}

export interface AttemptRefIdentity {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
}

/**
 * Generate the ONLY branch an attempt is allowed to push to. The three id
 * components are each validated as ULIDs, so the result is always exactly
 * `asep/<runId>/<taskId>/<attemptId>` and cannot express any other ref.
 */
export function attemptBranch(identity: AttemptRefIdentity): string {
  for (const [label, id] of [
    ['runId', identity.runId], ['taskId', identity.taskId], ['attemptId', identity.attemptId],
  ] as const) {
    if (!ID_SEGMENT.test(id)) throw new RefSafetyError(`${label} '${id}' is not a ULID`);
  }
  const branch = `asep/${identity.runId}/${identity.taskId}/${identity.attemptId}`;
  assertValidRefFormat(branch);
  return branch;
}

export interface SafeRefspec {
  readonly branch: string;
  readonly refspec: string;              // exact create/update, never a delete/force
  readonly forceWithLeaseExpectedSha?: string;
}

/**
 * Validate a branch a caller wants to push and return the exact, safe refspec.
 * Rejects protected refs, malformed refs, and any branch outside the ASEP
 * namespace. Force is only ever expressible as --force-with-lease against a
 * recorded expected SHA (passed through here); a plain force is impossible.
 */
export function safeRefspecFor(branch: string, expectedRemoteSha?: string): SafeRefspec {
  assertValidRefFormat(branch);
  if (PROTECTED_REFS.has(branch)) throw new RefSafetyError(`'${branch}' is a protected ref`);
  if (branch.startsWith('refs/tags/') || branch.startsWith('refs/heads/refs/')) {
    throw new RefSafetyError(`'${branch}' targets tags or a nested refs path`);
  }
  // Must be under the ASEP-owned namespace — the one place we own.
  if (!/^asep\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}$/.test(branch)) {
    throw new RefSafetyError(`'${branch}' is not an ASEP-namespaced attempt branch`);
  }
  const target = `refs/heads/${branch}`;
  // Exact create/update refspec: local branch → same-named remote branch. No
  // leading '+' (which would mean force). Deletion (':refs/…') is unrepresentable.
  const refspec = `${target}:${target}`;
  const base: SafeRefspec = { branch, refspec };
  return expectedRemoteSha ? { ...base, forceWithLeaseExpectedSha: expectedRemoteSha } : base;
}

// A full 40-hex Git object id. An abbreviated SHA is rejected: an ambiguous
// prefix could resolve to a different object on the remote side.
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Validate a branch AND an exact commit SHA, returning the safe refspec that
 * pushes THAT EXACT OBJECT to the ASEP-namespaced target ref.
 *
 * Why this exists alongside safeRefspecFor (disp. P2-FINAL-HIGH-008): the
 * harness commits on a DETACHED worktree, so there is no local branch named
 * `asep/<run>/<task>/<attempt>` for a `refs/heads/x:refs/heads/x` refspec to
 * resolve. Pushing the SHA directly is also strictly stronger: the bytes that
 * land on the remote are exactly the commit that verification and evidence were
 * bound to, not whatever a mutable local branch happens to point at.
 *
 * Every guarantee of safeRefspecFor is preserved: the TARGET is still generated
 * under the ASEP namespace and run through the same validation, so a protected,
 * malformed, tag, or option-like destination stays unrepresentable, and force is
 * still only expressible as --force-with-lease against a recorded SHA.
 */
export function safeCommitRefspecFor(
  commitSha: string,
  branch: string,
  expectedRemoteSha?: string,
): SafeRefspec {
  // Reuse the single authority for target validation — no second policy here.
  const safe = safeRefspecFor(branch, expectedRemoteSha);
  if (!FULL_SHA.test(commitSha)) {
    throw new RefSafetyError(
      `'${commitSha}' is not a full 40-hex commit SHA; refusing to push an ambiguous object`,
    );
  }
  // Source is an immutable object id, destination is the validated safe ref. No
  // leading '+', so this can never mean force; deletion is unrepresentable.
  const refspec = `${commitSha}:refs/heads/${safe.branch}`;
  const base: SafeRefspec = { branch: safe.branch, refspec };
  return expectedRemoteSha ? { ...base, forceWithLeaseExpectedSha: expectedRemoteSha } : base;
}

export { PROTECTED_REFS, FULL_SHA as FULL_SHA_PATTERN };
