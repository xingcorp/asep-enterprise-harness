// The review contracts: the finding, review record, packet, adjudication record and repair order the independent
// review loop records and exchanges, and the machine check an architecture invariant may carry. The cases below are
// written from the data model's field rules, not read back from the schemas under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ArtifactRef, AttemptStatus } from './base.js';
import type {
  AdjudicationRecord,
  ArchitectureInvariant,
  RepairOrder,
  ReviewFindingRecord,
  ReviewPacket,
  ReviewRecord,
} from './generated.js';
import { validate, type ContractName } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

type Doc = Record<string, any>;

function fixture(name: string): Doc {
  return JSON.parse(readFileSync(join(FIXTURES, 'valid', `${name}.json`), 'utf8')) as Doc;
}

function accepts(contract: ContractName, doc: unknown, label: string): void {
  const result = validate(contract, doc);
  assert.equal(result.valid, true, `${label} must be accepted: ${JSON.stringify(result.errors)}`);
}

function rejects(contract: ContractName, doc: unknown, label: string): void {
  assert.equal(validate(contract, doc).valid, false, `${label} must be rejected`);
}

/** A deep copy of a valid fixture with `edit` applied. */
function variant(name: string, edit: (doc: Doc) => void): Doc {
  const doc = fixture(name);
  edit(doc);
  return doc;
}

// --- compile-time projection --------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | void {}

test('the generated types carry the review contracts as the data model shapes them', () => {
  assertType<Equal<ReviewPacket['packetVersion'], 'review-packet/v1'>>();
  assertType<Equal<ReviewPacket['change']['cumulativeDiff'], ArtifactRef>>();
  assertType<Equal<ReviewPacket['change']['repairDelta'], ArtifactRef | null>>();
  assertType<Equal<ReviewPacket['change']['files'][number]['postImage'], ArtifactRef | null>>();
  assertType<Equal<null extends ReviewPacket['execution']['environment'] ? true : false, true>>();
  assertType<Equal<NonNullable<ReviewPacket['execution']['environment']>['nodeVersion'], string | null>>();
  assertType<Equal<ReviewPacket['priorFindings'], readonly ReviewFindingRecord[]>>();
  assertType<Equal<ReviewRecord['verdict'], 'APPROVE' | 'REQUEST_CHANGES' | 'ESCALATE' | null>>();
  assertType<Equal<ReviewRecord['findings'], readonly ReviewFindingRecord[]>>();
  assertType<Equal<AdjudicationRecord['outcome'], 'PROCEED' | 'REPAIR' | 'ESCALATE' | 'BLOCK'>>();
  assertType<Equal<null extends AdjudicationRecord['shadow'] ? true : false, true>>();
  assertType<Equal<RepairOrder['workOrderRef'], ArtifactRef>>();
  assertType<Equal<NonNullable<ArchitectureInvariant['check']>['kind'], 'forbidden-import'>>();
  assertType<Equal<Extract<AttemptStatus, 'UNDER_REVIEW' | 'CHANGES_REQUESTED'>, 'UNDER_REVIEW' | 'CHANGES_REQUESTED'>>();
});

// --- architecture-invariant check ---------------------------------------------------------------

test('an invariant machine check is a forbidden-import rule over globs and a specifier pattern', () => {
  accepts('architecture-invariant', fixture('architecture-invariant-basic'), 'an invariant without a check');
  accepts('architecture-invariant', fixture('architecture-invariant-forbidden-import'), 'a forbidden-import check');
  const base = 'architecture-invariant-forbidden-import';
  rejects('architecture-invariant', variant(base, (d) => (d.check.kind = 'forbidden-call')), 'another check kind');
  rejects('architecture-invariant', variant(base, (d) => (d.check.fromGlobs = [])), 'a check over no globs');
  rejects('architecture-invariant', variant(base, (d) => (d.check.fromGlobs = [''])), 'an empty glob');
  rejects('architecture-invariant', variant(base, (d) => delete d.check.specifierPattern), 'a check without a pattern');
  rejects('architecture-invariant', variant(base, (d) => (d.check.specifierPattern = '')), 'an empty pattern');
  rejects('architecture-invariant', variant(base, (d) => (d.check.severity = 'HIGH')), 'an unknown check field');
});

// --- review-finding ------------------------------------------------------------------------------

test('a finding file is a normalized repository path', () => {
  const refused = [
    '', '/abs/path.ts', 'a//b.ts', 'a/', './a.ts', 'a/./b.ts', 'a/../b.ts', '..', '.', 'a\\b.ts', '"src/a.ts"',
    'a\nb.ts', 'a\u0000b.ts', 'a\u001fb.ts', 'a\u007fb.ts', 'a\u0085b.ts', 'a\u009fb.ts', 'a\u2028b.ts', 'a\u2029b.ts',
  ];
  for (const file of refused) {
    rejects('review-finding', variant('review-finding-model', (d) => (d.file = file)), `file ${JSON.stringify(file)}`);
  }
  for (const file of ['src/café.ts', '.github/workflows/ci.yml', 'a/.../b.ts', 'docs/a b.md', 'x']) {
    accepts('review-finding', variant('review-finding-model', (d) => (d.file = file)), `file ${JSON.stringify(file)}`);
  }
});

test('the harness grounds a finding, and an ungrounded finding says why', () => {
  for (const name of ['review-finding-model', 'review-finding-ungrounded', 'review-finding-sarif', 'review-finding-deterministic']) {
    accepts('review-finding', fixture(name), name);
  }
  rejects('review-finding', variant('review-finding-ungrounded', (d) => delete d.groundingReason), 'ungrounded without a reason');
  rejects('review-finding', variant('review-finding-model', (d) => (d.grounded = 'yes')), 'a non-boolean grounded flag');
  rejects('review-finding', variant('review-finding-model', (d) => delete d.grounded), 'a finding without a grounded flag');
});

test('a SARIF log yields only its one sarif-unparsed finding, with no location', () => {
  const base = 'review-finding-sarif';
  rejects('review-finding', variant(base, (d) => (d.raisedBy = 'sarif:semgrep')), 'another SARIF raiser');
  rejects('review-finding', variant(base, (d) => (d.ruleId = 'semgrep.sql-injection')), 'a parsed SARIF rule');
  rejects('review-finding', variant(base, (d) => delete d.ruleId), 'no rule id');
  rejects('review-finding', variant(base, (d) => (d.severity = 'CRITICAL')), 'another severity');
  rejects('review-finding', variant(base, (d) => (d.category = 'SECURITY')), 'another category');
  rejects('review-finding', variant(base, (d) => Object.assign(d, { grounded: false, groundingReason: 'x' })), 'ungrounded');
  rejects('review-finding', variant(base, (d) => (d.file = 'reports/a.sarif')), 'a file');
  rejects('review-finding', variant(base, (d) => (d.lineStart = 1)), 'a line');
  rejects('review-finding', variant(base, (d) => Object.assign(d, { lineStart: 1, lineEnd: 2 })), 'a line range');
});

test('the raiser names its source: a reviewer config, deterministic:<rule> or sarif:unparsed', () => {
  rejects('review-finding', variant('review-finding-model', (d) => (d.raisedBy = 'deterministic:false-green')), 'a model finding raised as a rule');
  rejects('review-finding', variant('review-finding-model', (d) => (d.raisedBy = 'sarif:unparsed')), 'a model finding raised as SARIF');
  rejects('review-finding', variant('review-finding-deterministic', (d) => (d.raisedBy = 'trojan-source')), 'a rule finding without the prefix');
  rejects('review-finding', variant('review-finding-deterministic', (d) => (d.raisedBy = 'deterministic:')), 'a rule finding without a rule');
  rejects('review-finding', variant('review-finding-deterministic', (d) => delete d.ruleId), 'a rule finding without a rule id');
  rejects('review-finding', variant('review-finding-model', (d) => (d.source = 'reviewer')), 'an unknown source');
});

test('a finding has bounded text, a lowercase fingerprint, positive lines and no field beyond the contract', () => {
  const base = 'review-finding-model';
  accepts('review-finding', variant(base, (d) => (d.evidence = 'e'.repeat(8192))), '8192 characters of evidence');
  rejects('review-finding', variant(base, (d) => (d.evidence = 'e'.repeat(8193))), '8193 characters of evidence');
  rejects('review-finding', variant(base, (d) => (d.requiredFix = '')), 'an empty required fix');
  rejects('review-finding', variant(base, (d) => (d.fingerprint = d.fingerprint.toUpperCase())), 'an uppercase fingerprint');
  rejects('review-finding', variant(base, (d) => (d.fingerprint = d.fingerprint.slice(1))), 'a short fingerprint');
  rejects('review-finding', variant(base, (d) => (d.lineStart = 0)), 'line 0');
  rejects('review-finding', variant(base, (d) => delete d.lineStart), 'an end line without a start line');
  rejects('review-finding', variant(base, (d) => (d.lifecycleState = 'DONE')), 'an unknown lifecycle state');
  rejects('review-finding', variant(base, (d) => (d.blocking = true)), 'the adjudication-only blocking flag');
  rejects('review-finding', variant(base, (d) => (d.key = 'k1')), 'the model-local finding key');
});

// --- review-record -------------------------------------------------------------------------------

test('a review record carries a verdict exactly when the model output was valid', () => {
  for (const name of ['review-record-fresh', 'review-record-re-review', 'review-record-invalid-output']) {
    accepts('review-record', fixture(name), name);
  }
  rejects('review-record', variant('review-record-fresh', (d) => (d.verdict = null)), 'a valid record without a verdict');
  rejects('review-record', variant('review-record-invalid-output', (d) => (d.verdict = 'ESCALATE')), 'an invalid record with a verdict');
  rejects('review-record', variant('review-record-fresh', (d) => (d.validity = 'UNKNOWN')), 'another validity');
});

test('a fresh review is round 1 with no prior claims; a re-review is a later round', () => {
  rejects('review-record', variant('review-record-fresh', (d) => (d.round = 2)), 'a fresh review in round 2');
  rejects('review-record', variant('review-record-re-review', (d) => (d.round = 1)), 'a re-review in round 1');
  rejects(
    'review-record',
    variant('review-record-fresh', (d) => (d.priorFindingClaims = fixture('review-record-re-review').priorFindingClaims)),
    'prior claims on a fresh review',
  );
  rejects('review-record', variant('review-record-re-review', (d) => (d.priorFindingClaims[0].status = 'FIXED')), 'an unknown claim status');
});

test('a review record follows at least one provider call and records what the gateway did', () => {
  const base = 'review-record-fresh';
  rejects('review-record', variant(base, (d) => (d.providerCalls = 0)), 'no provider call');
  rejects('review-record', variant(base, (d) => (d.gatewayAlteration.status = 'no-request')), 'a gateway that saw no request');
  rejects('review-record', variant(base, (d) => delete d.gatewayAlteration.attributedFields), 'no attributed fields');
  rejects('review-record', variant(base, (d) => (d.gatewayAlteration.appendedSha256 = 'abc')), 'a short appendix digest');
  rejects('review-record', variant(base, (d) => (d.reviewerRole = 'deterministic')), 'a deterministic reviewer role');
  rejects('review-record', variant(base, (d) => (d.usage.outputTokens = -1)), 'negative usage');
  rejects('review-record', variant(base, (d) => (d.confidence = 1.5)), 'confidence above 1');
  rejects('review-record', variant(base, (d) => (d.reviewId = 'r1')), 'a review id that is not a digest');
  rejects('review-record', variant(base, (d) => (d.coderSummary = 'done')), 'the coder self-report');
  rejects('review-record', variant(base, (d) => (d.findings[0].lifecycleState = 'DONE')), 'a finding outside review-finding/v1');
});

// --- review-packet -------------------------------------------------------------------------------

test('a packet has an execution environment exactly when its execution was recorded', () => {
  for (const name of ['review-packet-fresh', 'review-packet-re-review', 'review-packet-corpus']) {
    accepts('review-packet', fixture(name), name);
  }
  for (const verdict of ['PASS', 'FAIL', 'ERROR']) {
    rejects('review-packet', variant('review-packet-fresh', (d) => Object.assign(d.execution, { verdict, environment: null })), `${verdict} without an environment`);
  }
  rejects(
    'review-packet',
    variant('review-packet-corpus', (d) => (d.execution.environment = fixture('review-packet-fresh').execution.environment)),
    'NOT_RECORDED with an environment',
  );
  rejects(
    'review-packet',
    variant('review-packet-corpus', (d) => (d.execution.checks = fixture('review-packet-fresh').execution.checks)),
    'NOT_RECORDED with checks',
  );
  rejects('review-packet', variant('review-packet-fresh', (d) => (d.execution.verdict = 'SKIPPED')), 'an unknown verdict');
});

test('only a re-review carries prior findings', () => {
  rejects(
    'review-packet',
    variant('review-packet-fresh', (d) => (d.priorFindings = fixture('review-packet-re-review').priorFindings)),
    'prior findings on a fresh review',
  );
  rejects('review-packet', variant('review-packet-re-review', (d) => (d.priorFindings[0].grounded = 'yes')), 'a prior outside review-finding/v1');
});

test('a changed file has a post-image exactly when it is not omitted', () => {
  rejects('review-packet', variant('review-packet-fresh', (d) => (d.change.files[0].postImage = null)), 'no post-image and no omission');
  rejects(
    'review-packet',
    variant('review-packet-re-review', (d) => (d.change.files[1].postImage = fixture('review-packet-fresh').change.files[0].postImage)),
    'an omitted file with a post-image',
  );
  rejects('review-packet', variant('review-packet-re-review', (d) => (d.change.files[1].omittedReason = 'secret')), 'an unknown omission reason');
  rejects('review-packet', variant('review-packet-re-review', (d) => (d.budget.omissions[0].reason = null)), 'an omission without a reason');
});

test('a packet has no field for the coder, the context pack, events, commit messages, other reviewers or its own size', () => {
  const extras: readonly [string, (d: Doc) => void][] = [
    ['coderSelfReport', (d) => (d.coderSelfReport = { summary: 'done' })],
    ['contextPack', (d) => (d.contextPack = {})],
    ['events', (d) => (d.events = [])],
    ['commitMessages', (d) => (d.commitMessages = ['feat: x'])],
    ['otherReviews', (d) => (d.otherReviews = [])],
    ['budget.includedBytes', (d) => (d.budget.includedBytes = 1024)],
    ['change.commitMessage', (d) => (d.change.commitMessage = 'feat: x')],
    ['execution.summary', (d) => (d.execution.summary = 'green')],
  ];
  for (const [label, edit] of extras) rejects('review-packet', variant('review-packet-fresh', edit), label);
});

test('a packet names commits by full sha and pins its version and identity', () => {
  const base = 'review-packet-fresh';
  rejects('review-packet', variant(base, (d) => (d.packetVersion = 'review-packet/v2')), 'another packet version');
  rejects('review-packet', variant(base, (d) => (d.change.resultSha = d.change.resultSha.slice(0, 12))), 'an abbreviated sha');
  rejects('review-packet', variant(base, (d) => (d.change.repairBaseSha = 'HEAD')), 'a symbolic repair base');
  rejects('review-packet', variant(base, (d) => (d.change.cumulativeDiff.sha256 = 'x')), 'a diff ref without a digest');
  rejects('review-packet', variant(base, (d) => delete d.identity.roundKey), 'an identity without a round key');
  rejects('review-packet', variant(base, (d) => (d.risk = 'R5')), 'an unknown risk');
  rejects('review-packet', variant(base, (d) => (d.budget.maxBytes = 0)), 'a zero byte budget');
  rejects('review-packet', variant(base, (d) => (d.execution.checks[0].testSummary.runner = 'mocha')), 'an unknown test runner');
  accepts('review-packet', variant(base, (d) => delete d.workOrder.requirements), 'a packet without requirement statements');
});

// --- adjudication-record -------------------------------------------------------------------------

test('an escalation or block names its reason; a proceed or repair has none', () => {
  for (const name of ['adjudication-record-shadow', 'adjudication-record-drill-repair', 'adjudication-record-push-guard-block']) {
    accepts('adjudication-record', fixture(name), name);
  }
  rejects('adjudication-record', variant('adjudication-record-drill-repair', (d) => (d.outcome = 'ESCALATE')), 'ESCALATE without a reason');
  rejects('adjudication-record', variant('adjudication-record-push-guard-block', (d) => (d.reason = null)), 'BLOCK without a reason');
  rejects('adjudication-record', variant('adjudication-record-drill-repair', (d) => (d.reason = 'max-repair-rounds')), 'REPAIR with a reason');
  rejects('adjudication-record', variant('adjudication-record-shadow', (d) => (d.reason = 'egress-stopped')), 'PROCEED with a reason');
  rejects('adjudication-record', variant('adjudication-record-push-guard-block', (d) => (d.reason = 'blocking-findings')), 'an unknown reason');
});

test('outside gating mode a round only proceeds or blocks, and a shadow proceed records what gating would do', () => {
  for (const mode of ['shadow', 'not-required']) {
    rejects('adjudication-record', variant('adjudication-record-drill-repair', (d) => (d.mode = mode)), `REPAIR in ${mode} mode`);
    rejects(
      'adjudication-record',
      variant('adjudication-record-drill-repair', (d) => Object.assign(d, { mode, outcome: 'ESCALATE', reason: 'reviewer-unavailable' })),
      `ESCALATE in ${mode} mode`,
    );
  }
  rejects('adjudication-record', variant('adjudication-record-shadow', (d) => (d.shadow = null)), 'a shadow proceed without the would-be verdict');
  rejects(
    'adjudication-record',
    variant('adjudication-record-drill-repair', (d) => (d.shadow = fixture('adjudication-record-shadow').shadow)),
    'a gating decision with a shadow verdict',
  );
  rejects(
    'adjudication-record',
    variant('adjudication-record-push-guard-block', (d) => (d.shadow = fixture('adjudication-record-shadow').shadow)),
    'a shadow block with a shadow verdict',
  );
  rejects('adjudication-record', variant('adjudication-record-shadow', (d) => (d.shadow.wouldBe = 'BLOCK')), 'a would-be block');
  accepts(
    'adjudication-record',
    variant('adjudication-record-shadow', (d) => Object.assign(d, { mode: 'not-required', shadow: null, ruleFired: 'A2' })),
    'a not-required proceed',
  );
});

test('the push guard blocks with a reason and passes without one', () => {
  rejects('adjudication-record', variant('adjudication-record-push-guard-block', (d) => delete d.pushGuard.reason), 'BLOCK without a reason');
  rejects('adjudication-record', variant('adjudication-record-shadow', (d) => (d.pushGuard.reason = 'forbidden-path')), 'PASS with a reason');
  rejects('adjudication-record', variant('adjudication-record-push-guard-block', (d) => (d.pushGuard.reason = 'packet-over-budget')), 'a non-guard reason');
});

test('an adjudication names its rule, its fence and its inputs, grounds with reasons and carries no timestamp', () => {
  const base = 'adjudication-record-shadow';
  for (const rule of ['A0', 'A12', 'a1', 'B1']) rejects('adjudication-record', variant(base, (d) => (d.ruleFired = rule)), `rule ${rule}`);
  rejects('adjudication-record', variant(base, (d) => (d.fence.fencingEpoch = 0)), 'fencing epoch 0');
  rejects('adjudication-record', variant(base, (d) => delete d.fence.leaseId), 'a fence without a lease');
  rejects('adjudication-record', variant(base, (d) => (d.inputs.reviewRecordSha256s = ['r1'])), 'a review record input that is not a digest');
  rejects('adjudication-record', variant(base, (d) => (d.grounding[0].reason = 'path-not-in-packet')), 'a grounded finding with a reason');
  rejects('adjudication-record', variant(base, (d) => (d.grounding[1].reason = null)), 'an ungrounded finding without a reason');
  rejects('adjudication-record', variant(base, (d) => (d.blocking[0].reason = 'reviewer-said-so')), 'an unknown blocking reason');
  rejects('adjudication-record', variant(base, (d) => (d.verdictMismatches[0].verdict = 'ESCALATE')), 'an escalation as a verdict mismatch');
  rejects('adjudication-record', variant(base, (d) => (d.decidedAt = '2026-10-31T00:00:00Z')), 'a decision timestamp');
  rejects(
    'adjudication-record',
    variant('adjudication-record-drill-repair', (d) => (d.closureDecisions[0].rule = 'scanner-recheck')),
    'a scanner re-check closure',
  );
});

// --- repair-order --------------------------------------------------------------------------------

test('a repair order anchors the next round to the reviewed commit under the fixed closure rule', () => {
  accepts('repair-order', fixture('repair-order-basic'), 'repair-order-basic');
  const base = 'repair-order-basic';
  rejects('repair-order', variant(base, (d) => (d.closureRule = 'the coder confirms the fix')), 'another closure rule');
  rejects('repair-order', variant(base, (d) => (d.nextRound = 1)), 'a repair in round 1');
  rejects('repair-order', variant(base, (d) => (d.repairBaseSha = null)), 'no repair base');
  rejects('repair-order', variant(base, (d) => (d.adjudicationId = 'a1')), 'an adjudication id that is not a digest');
  rejects('repair-order', variant(base, (d) => (d.blockingFindings[0].grounded = 'yes')), 'a finding outside review-finding/v1');
  rejects('repair-order', variant(base, (d) => delete d.workOrderRef.kind), 'a work-order ref without a kind');
});
