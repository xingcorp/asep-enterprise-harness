// The review ports: a reviewer that sees only a rendered prompt and returns an untrusted
// observation, a trusted reader of the reviewed change, and the earlier review port kept,
// deprecated, with its shape unchanged. The checks are structural: they compile only while the
// ports keep the shapes below, and the deprecation is read from the declaration itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  ArtifactId, ArtifactRef, ContextPack, ReviewReport, TenantScope, VerificationResult, WorkOrder, WorkspaceId,
} from '@asep/contracts';
import type {
  GatewayAlteration,
  ReviewBlob,
  ReviewProvider,
  ReviewSourceReader,
  ReviewerExecuteRequest,
  ReviewerObservation,
  ReviewerObservationStatus,
  ReviewerProvider,
  ReviewerUsage,
  WorkspaceCapability,
} from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | void {}

const ref = (kind: string): ArtifactRef => ({ artifactId: `01J0000000000000000000${kind.slice(0, 4).toUpperCase()}` as ArtifactId, sha256: 'a'.repeat(64), kind });
const scope = { organizationId: 'org', projectId: 'project' } as unknown as TenantScope;

test('a reviewer is handed a rendered prompt and nothing else, and returns an untrusted observation', async () => {
  // The request carries the harness's review id, the prompt artifact and its digest, a budget and a
  // cancellation signal: no work order, context pack, diff, coder report or other reviewer's output.
  assertType<Equal<keyof ReviewerExecuteRequest, 'reviewId' | 'promptRef' | 'promptSha256' | 'budget' | 'signal'>>();
  assertType<Equal<keyof ReviewerObservation,
    'status' | 'outputText' | 'rawRequestRef' | 'rawResponseRef' | 'servedModel' | 'providerRequestId' | 'gatewayAlteration' | 'usage' | 'detail'>>();
  assertType<Equal<ReviewerObservation['outputText'], string | null>>();
  assertType<Equal<ReviewerObservationStatus,
    'COMPLETED' | 'REFUSED' | 'INCOMPLETE' | 'MALFORMED' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'AUTH_ERROR' | 'CONTEXT_OVERFLOW'
    | 'BUDGET_EXHAUSTED' | 'CANCELLED'>>();
  assertType<Equal<GatewayAlteration['status'], 'altered' | 'unaltered' | 'unknown' | 'no-request'>>();
  assertType<Equal<keyof ReviewerUsage,
    'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens' | 'wallClockMs' | 'transportAttempts'>>();

  const seen: ReviewerExecuteRequest[] = [];
  const reviewer: ReviewerProvider = {
    descriptor: { reviewerConfigId: 'primary-scripted', providerId: 'scripted-fake', model: 'model-x', configSha256: 'b'.repeat(64) },
    async review(_scope, req) {
      seen.push(req);
      return {
        status: 'COMPLETED',
        outputText: '{"verdict":"APPROVE","findings":[],"priorFindingClaims":[],"packetAssessment":{"coverage":"complete","notes":""}}',
        rawRequestRef: ref('raw-request'),
        rawResponseRef: ref('raw-response'),
        servedModel: 'model-x',
        providerRequestId: 'req-1',
        gatewayAlteration: { status: 'unaltered', appendedBytes: 0, appendedSha256: null, appendixRef: null, toolsAttributed: false, attributedFields: [] },
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, wallClockMs: 3, transportAttempts: 1 },
        detail: null,
      };
    },
  };
  const request: ReviewerExecuteRequest = {
    reviewId: 'c'.repeat(64),
    promptRef: ref('review-prompt'),
    promptSha256: 'a'.repeat(64),
    budget: { maxOutputTokens: 4096, maxWallClockMs: 60_000, maxTransportAttempts: 3 },
    signal: new AbortController().signal,
  };
  const observation = await reviewer.review(scope, request);
  assert.equal(observation.status, 'COMPLETED');
  assert.deepEqual(Object.keys(seen[0]!).sort(), ['budget', 'promptRef', 'promptSha256', 'reviewId', 'signal']);
});

test('the review source reads the change from a workspace capability and never cuts it silently', async () => {
  type DiffRange = Awaited<ReturnType<ReviewSourceReader['diffRange']>>;
  assertType<Equal<keyof DiffRange, 'diff' | 'bytes' | 'overLimit' | 'changedFiles'>>();
  assertType<Equal<Parameters<ReviewSourceReader['readBlobs']>[1]['workspace'], WorkspaceCapability>>();
  assertType<Equal<ReviewBlob['omittedReason'], 'binary' | 'too-large' | 'deleted' | 'submodule' | 'non-utf8' | 'unsafe-path' | null>>();

  const workspace: WorkspaceCapability = { workspaceId: 'ws-1' as WorkspaceId, leaseId: 'lease-1' };
  const reader: ReviewSourceReader = {
    async diffRange(_scope, input) {
      return { diff: ref('review-diff'), bytes: input.maxBytes + 1, overLimit: true, changedFiles: [{ path: 'src/a.ts', status: 'M', binary: false }] };
    },
    async readBlobs(_scope, input) {
      return input.paths.map((path) => ({ path, blob: null, bytes: 0, lineCount: 0, omittedReason: 'too-large' as const }));
    },
  };
  const diff = await reader.diffRange(scope, { workspace, fromSha: '1'.repeat(40), toSha: '2'.repeat(40), maxBytes: 10 });
  assert.equal(diff.overLimit, true);
  const blobs = await reader.readBlobs(scope, { workspace, sha: '2'.repeat(40), paths: ['src/a.ts'], maxBytesPerFile: 1 });
  assert.deepEqual(blobs.map((b) => [b.path, b.blob, b.omittedReason]), [['src/a.ts', null, 'too-large']]);
});

test('the earlier review port keeps its shape and is marked deprecated', async () => {
  // An implementation written against the earlier port still satisfies it unchanged.
  const legacy: ReviewProvider = {
    providerId: 'legacy',
    async review(input: { order: WorkOrder; context: ContextPack; diffArtifactId: ArtifactId; verification: VerificationResult; implementerProviderId: string }): Promise<ReviewReport> {
      return { reviewerProvider: 'legacy', reviewerModel: input.implementerProviderId, verdict: 'APPROVE', findings: [], confidence: 1 };
    },
  };
  assertType<Equal<Parameters<ReviewProvider['review']>[0],
    { order: WorkOrder; context: ContextPack; diffArtifactId: ArtifactId; verification: VerificationResult; implementerProviderId: string }>>();
  assertType<Equal<Awaited<ReturnType<ReviewProvider['review']>>, ReviewReport>>();
  assert.equal(legacy.providerId, 'legacy');

  const source = readFileSync(join(HERE, 'index.ts'), 'utf8');
  const declaration = source.indexOf('export interface ReviewProvider {');
  assert.ok(declaration > 0, 'ReviewProvider is declared');
  const start = source.lastIndexOf('/**', declaration);
  const end = source.indexOf('*/', start);
  assert.ok(start >= 0 && end > start, 'ReviewProvider has a doc comment');
  assert.equal(source.slice(end + 2, declaration).trim(), '', 'the doc comment sits right above the declaration');
  const doc = source.slice(start, end);
  assert.match(doc, /@deprecated/, 'the doc comment marks ReviewProvider deprecated');
  assert.match(doc, /ReviewerProvider/, 'and names its successor');
});
