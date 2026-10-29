import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKING_LIFECYCLE_STATES,
  FINDING_DISPOSITION_KINDS,
  FINDING_LIFECYCLE_STATES,
  FindingDispositionError,
  ReviewStateError,
  applyFindingDisposition,
  closeVerifiedFinding,
  dispositionActorId,
  effectiveFindingState,
  expireWaiver,
  isLifecycleBlocking,
  markRefutationAdjudicated,
  openFinding,
  recordReviewOutcome,
  transitionReviewRound,
  type DispositionActor,
  type FindingAggregate,
  type FindingDispositionInput,
  type FindingDispositionKind,
  type FindingDispositionRejection,
  type FindingLifecycleState,
  type ReviewRoundState,
} from './assurance.js';

console.log('SUITE-ID: asep-suite:finding-lifecycle');

const AT = '2026-10-29T10:00:00.000Z';
const LATER = '2026-11-05T10:00:00.000Z';
const HUMAN: DispositionActor = { kind: 'human', id: 'reviewer-person-1' };

function modelFinding(state: FindingLifecycleState = 'OPEN', over: Partial<FindingAggregate> = {}): FindingAggregate {
  return {
    ...openFinding({ id: 'f-model', source: 'model', raisedBy: 'primary-gpt', severity: 'HIGH', grounded: true }),
    state,
    ...over,
  };
}

function deterministicFinding(state: FindingLifecycleState = 'OPEN'): FindingAggregate {
  return {
    ...openFinding({
      id: 'f-det',
      source: 'deterministic',
      raisedBy: 'deterministic:secret-in-diff',
      severity: 'CRITICAL',
      grounded: true,
    }),
    state,
  };
}

function sarifFinding(): FindingAggregate {
  return openFinding({ id: 'f-sarif', source: 'sarif', raisedBy: 'sarif:semgrep', severity: 'MEDIUM', grounded: true });
}

function input(
  disposition: FindingDispositionKind,
  actor: DispositionActor,
  over: Partial<FindingDispositionInput> = {},
): FindingDispositionInput {
  return {
    disposition,
    actor,
    rationale: 'decided on the recorded evidence',
    at: AT,
    waiver: disposition === 'WAIVED' ? { expiresAt: LATER, signature: 'sig-ed25519-base64' } : null,
    resolution: null,
    ...over,
  };
}

function rejectsWith(fn: () => unknown, code: FindingDispositionRejection): void {
  assert.throws(fn, (err: unknown) => err instanceof FindingDispositionError && err.code === code, `expected ${code}`);
}

const independentReviewer: DispositionActor = {
  kind: 'reviewer',
  reviewerConfigId: 'comparator-deepseek',
  independentOfImplementer: true,
};
const raiser: DispositionActor = { kind: 'reviewer', reviewerConfigId: 'primary-gpt', independentOfImplementer: true };
const groundedInDelta = { grounded: true, inRepairDelta: true };

test('finding lifecycle transitions follow the table', () => {
  // Independent statement of the lifecycle: disposition → (from states) → to state.
  const expected: Record<FindingDispositionKind, { from: readonly FindingLifecycleState[]; to: FindingLifecycleState }> = {
    ACCEPTED: { from: ['OPEN', 'REFUTED', 'ADJUDICATED'], to: 'ACKNOWLEDGED' },
    REJECTED_WITH_EVIDENCE: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'REFUTED' },
    WAIVED: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'WAIVED' },
    RESOLUTION_CLAIMED: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'FIXED' },
    RESOLUTION_VERIFIED: { from: ['OPEN', 'ACKNOWLEDGED', 'FIXED'], to: 'VERIFIED' },
    REOPENED: { from: ['FIXED', 'VERIFIED', 'WAIVED'], to: 'OPEN' },
  };
  assert.deepEqual([...FINDING_DISPOSITION_KINDS].sort(), Object.keys(expected).sort());

  for (const kind of FINDING_DISPOSITION_KINDS) {
    for (const from of FINDING_LIFECYCLE_STATES) {
      const finding = modelFinding(from, from === 'WAIVED' ? { waiverExpiresAt: LATER } : {});
      const run = (): FindingAggregate => applyFindingDisposition(finding, input(kind, HUMAN));
      if (expected[kind].from.includes(from)) {
        const next = run();
        assert.equal(next.state, expected[kind].to, `${kind} from ${from}`);
        assert.equal(next.version, finding.version + 1);
        assert.equal(next.waiverExpiresAt, kind === 'WAIVED' ? LATER : null);
      } else {
        rejectsWith(run, 'transition-not-allowed');
      }
    }
  }

  assert.deepEqual([...BLOCKING_LIFECYCLE_STATES], ['OPEN', 'ACKNOWLEDGED', 'FIXED']);

  // Bookkeeping transitions with no authority attached.
  assert.equal(markRefutationAdjudicated(modelFinding('REFUTED')).state, 'ADJUDICATED');
  assert.equal(closeVerifiedFinding(modelFinding('VERIFIED')).state, 'CLOSED');
  rejectsWith(() => markRefutationAdjudicated(modelFinding('OPEN')), 'transition-not-allowed');
  rejectsWith(() => closeVerifiedFinding(modelFinding('FIXED')), 'transition-not-allowed');
  for (const terminal of ['CLOSED'] as const) {
    for (const kind of FINDING_DISPOSITION_KINDS) {
      rejectsWith(() => applyFindingDisposition(modelFinding(terminal), input(kind, HUMAN)), 'transition-not-allowed');
    }
  }
});

test('only an independent reviewer, a human or a deterministic re-check verifies a fix', () => {
  // The raiser's resolution claim moves the finding to FIXED, which is still blocking.
  const claimed = applyFindingDisposition(modelFinding(), input('RESOLUTION_CLAIMED', raiser));
  assert.equal(claimed.state, 'FIXED');
  assert.equal(isLifecycleBlocking(claimed, AT), true);

  // The raiser can never verify its own finding, whatever it cites.
  rejectsWith(
    () => applyFindingDisposition(claimed, input('RESOLUTION_VERIFIED', raiser, { resolution: groundedInDelta })),
    'raiser-cannot-verify',
  );

  // A different reviewer verifies only when independent of the implementer and with a grounded
  // resolution inside the repair delta.
  const verified = applyFindingDisposition(
    claimed,
    input('RESOLUTION_VERIFIED', independentReviewer, { resolution: groundedInDelta }),
  );
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(isLifecycleBlocking(verified, AT), false);
  rejectsWith(
    () =>
      applyFindingDisposition(
        claimed,
        input('RESOLUTION_VERIFIED', { ...independentReviewer, independentOfImplementer: false }, {
          resolution: groundedInDelta,
        }),
      ),
    'reviewer-not-independent',
  );
  rejectsWith(
    () =>
      applyFindingDisposition(
        claimed,
        input('RESOLUTION_VERIFIED', independentReviewer, { resolution: { grounded: false, inRepairDelta: true } }),
      ),
    'resolution-not-grounded',
  );
  rejectsWith(
    () =>
      applyFindingDisposition(
        claimed,
        input('RESOLUTION_VERIFIED', independentReviewer, { resolution: { grounded: true, inRepairDelta: false } }),
      ),
    'resolution-outside-repair-delta',
  );
  rejectsWith(
    () => applyFindingDisposition(claimed, input('RESOLUTION_VERIFIED', independentReviewer)),
    'invalid-input',
  );

  // Deterministic and SARIF findings are not closed by a model's word.
  rejectsWith(
    () =>
      applyFindingDisposition(
        deterministicFinding(),
        input('RESOLUTION_VERIFIED', independentReviewer, { resolution: groundedInDelta }),
      ),
    'actor-not-permitted',
  );
  rejectsWith(
    () =>
      applyFindingDisposition(sarifFinding(), input('RESOLUTION_VERIFIED', independentReviewer, { resolution: groundedInDelta })),
    'actor-not-permitted',
  );

  // A deterministic re-check verifies deterministic findings only.
  const recheck: DispositionActor = { kind: 'harness-rule', rule: 'deterministic-recheck' };
  assert.equal(applyFindingDisposition(deterministicFinding(), input('RESOLUTION_VERIFIED', recheck)).state, 'VERIFIED');
  rejectsWith(() => applyFindingDisposition(modelFinding(), input('RESOLUTION_VERIFIED', recheck)), 'actor-not-permitted');
  rejectsWith(() => applyFindingDisposition(sarifFinding(), input('RESOLUTION_VERIFIED', recheck)), 'actor-not-permitted');
  rejectsWith(
    () =>
      applyFindingDisposition(deterministicFinding(), input('RESOLUTION_VERIFIED', { kind: 'harness-rule', rule: 'closure-without-change' })),
    'actor-not-permitted',
  );

  // A named human verifies any finding.
  for (const finding of [claimed, deterministicFinding(), sarifFinding()]) {
    assert.equal(applyFindingDisposition(finding, input('RESOLUTION_VERIFIED', HUMAN)).state, 'VERIFIED');
  }

  // Closure without change: a claimed fix whose cited file the repair never touched reopens.
  const withoutChange: DispositionActor = { kind: 'harness-rule', rule: 'closure-without-change' };
  assert.equal(applyFindingDisposition(claimed, input('REOPENED', withoutChange)).state, 'OPEN');
  rejectsWith(() => applyFindingDisposition(verified, input('REOPENED', withoutChange)), 'actor-not-permitted');
  // A deterministic rule firing again reopens a verified deterministic finding.
  const detVerified = applyFindingDisposition(deterministicFinding(), input('RESOLUTION_VERIFIED', recheck));
  assert.equal(applyFindingDisposition(detVerified, input('REOPENED', recheck)).state, 'OPEN');
  rejectsWith(() => applyFindingDisposition(verified, input('REOPENED', recheck)), 'actor-not-permitted');

  // Reviewers can claim and verify, nothing else.
  const reviewerForbidden: readonly (readonly [FindingDispositionKind, FindingAggregate])[] = [
    ['ACCEPTED', modelFinding()],
    ['REJECTED_WITH_EVIDENCE', modelFinding()],
    ['WAIVED', modelFinding()],
    ['REOPENED', claimed],
  ];
  for (const [kind, finding] of reviewerForbidden) {
    rejectsWith(() => applyFindingDisposition(finding, input(kind, independentReviewer)), 'actor-not-permitted');
  }
  // Only humans accept a finding as valid.
  rejectsWith(
    () => applyFindingDisposition(modelFinding(), input('ACCEPTED', { kind: 'harness-rule', rule: 'citation-unresolvable' })),
    'actor-not-permitted',
  );
  assert.equal(applyFindingDisposition(modelFinding(), input('ACCEPTED', HUMAN)).state, 'ACKNOWLEDGED');

  assert.equal(dispositionActorId(HUMAN), 'reviewer-person-1');
  assert.equal(dispositionActorId(raiser), 'primary-gpt');
  assert.equal(dispositionActorId(recheck), 'harness-rule:deterministic-recheck');
});

test('only humans waive, and waivers expire', () => {
  const grounded = modelFinding('OPEN', { severity: 'CRITICAL' });

  // No model and no harness rule can waive.
  rejectsWith(() => applyFindingDisposition(grounded, input('WAIVED', independentReviewer)), 'actor-not-permitted');
  rejectsWith(
    () => applyFindingDisposition(grounded, input('WAIVED', { kind: 'harness-rule', rule: 'waiver-expired' })),
    'actor-not-permitted',
  );

  // A waiver needs a rationale, an expiry after the decision and a signature.
  rejectsWith(() => applyFindingDisposition(grounded, input('WAIVED', HUMAN, { waiver: null })), 'waiver-incomplete');
  rejectsWith(
    () => applyFindingDisposition(grounded, input('WAIVED', HUMAN, { waiver: { expiresAt: AT, signature: 'sig' } })),
    'waiver-incomplete',
  );
  rejectsWith(
    () => applyFindingDisposition(grounded, input('WAIVED', HUMAN, { waiver: { expiresAt: LATER, signature: '' } })),
    'waiver-incomplete',
  );
  rejectsWith(() => applyFindingDisposition(grounded, input('WAIVED', HUMAN, { rationale: '' })), 'invalid-input');
  rejectsWith(
    () => applyFindingDisposition(grounded, input('ACCEPTED', HUMAN, { waiver: { expiresAt: LATER, signature: 'sig' } })),
    'invalid-input',
  );

  const waived = applyFindingDisposition(grounded, input('WAIVED', HUMAN));
  assert.equal(waived.state, 'WAIVED');
  assert.equal(waived.waiverExpiresAt, LATER);
  assert.equal(isLifecycleBlocking(waived, AT), false);
  assert.equal(effectiveFindingState(waived, AT), 'WAIVED');

  // At expiry the waiver stops applying: the finding is blocking again, and recording the reopen
  // is allowed only once the waiver has expired.
  assert.equal(effectiveFindingState(waived, LATER), 'OPEN');
  assert.equal(isLifecycleBlocking(waived, LATER), true);
  assert.equal(expireWaiver(waived, AT), waived);
  const reopened = expireWaiver(waived, LATER);
  assert.equal(reopened.state, 'OPEN');
  assert.equal(reopened.waiverExpiresAt, null);
  rejectsWith(
    () => applyFindingDisposition(waived, input('REOPENED', { kind: 'harness-rule', rule: 'waiver-expired' })),
    'waiver-not-expired',
  );

  // A model cannot refute a grounded finding; a harness rule refutes only ungrounded ones.
  rejectsWith(() => applyFindingDisposition(grounded, input('REJECTED_WITH_EVIDENCE', raiser)), 'actor-not-permitted');
  const citation: DispositionActor = { kind: 'harness-rule', rule: 'citation-unresolvable' };
  rejectsWith(
    () => applyFindingDisposition(grounded, input('REJECTED_WITH_EVIDENCE', citation)),
    'grounded-finding-needs-human',
  );
  const ungrounded = modelFinding('OPEN', { grounded: false });
  assert.equal(applyFindingDisposition(ungrounded, input('REJECTED_WITH_EVIDENCE', citation)).state, 'REFUTED');
  assert.equal(applyFindingDisposition(grounded, input('REJECTED_WITH_EVIDENCE', HUMAN)).state, 'REFUTED');

  // A human can reverse a rejection; the latest decision wins.
  const accepted = applyFindingDisposition(grounded, input('ACCEPTED', HUMAN));
  const rejected = applyFindingDisposition(accepted, input('REJECTED_WITH_EVIDENCE', HUMAN));
  assert.equal(applyFindingDisposition(rejected, input('ACCEPTED', HUMAN)).state, 'ACKNOWLEDGED');
});

test('disposition input is validated before any rule', () => {
  const finding = modelFinding();
  rejectsWith(() => applyFindingDisposition(finding, input('ACCEPTED', HUMAN, { at: '29/10/2026' })), 'invalid-input');
  rejectsWith(() => applyFindingDisposition(finding, input('ACCEPTED', HUMAN, { rationale: 'x'.repeat(4001) })), 'invalid-input');
  rejectsWith(() => applyFindingDisposition(finding, input('ACCEPTED', { kind: 'human', id: '' })), 'invalid-input');
  rejectsWith(
    () => applyFindingDisposition(finding, input('ACCEPTED', HUMAN, { resolution: groundedInDelta })),
    'invalid-input',
  );
  rejectsWith(
    () => applyFindingDisposition(finding, input('WAIVED', HUMAN, { waiver: { expiresAt: 'tomorrow', signature: 's' } })),
    'invalid-input',
  );

  // The raiser identity must agree with the finding source.
  assert.throws(() => openFinding({ id: 'x', source: 'model', raisedBy: 'deterministic:rule', severity: 'LOW', grounded: true }));
  assert.throws(() => openFinding({ id: 'x', source: 'deterministic', raisedBy: 'primary-gpt', severity: 'LOW', grounded: true }));
  assert.throws(() => openFinding({ id: 'x', source: 'sarif', raisedBy: 'deterministic:rule', severity: 'LOW', grounded: true }));
  assert.throws(() => openFinding({ id: '', source: 'model', raisedBy: 'primary-gpt', severity: 'LOW', grounded: true }));
  const opened = openFinding({ id: 'x', source: 'model', raisedBy: 'primary-gpt', severity: 'LOW', grounded: false });
  assert.deepEqual(opened, {
    id: 'x',
    source: 'model',
    raisedBy: 'primary-gpt',
    severity: 'LOW',
    grounded: false,
    state: 'OPEN',
    waiverExpiresAt: null,
    version: 0,
  });
});

test('review rounds open, adjudicate and are superseded in order', () => {
  const allowed: Record<ReviewRoundState, readonly ReviewRoundState[]> = {
    OPEN: ['ADJUDICATED'],
    ADJUDICATED: ['SUPERSEDED'],
    SUPERSEDED: [],
  };
  for (const from of Object.keys(allowed) as ReviewRoundState[]) {
    for (const to of Object.keys(allowed) as ReviewRoundState[]) {
      const round = { id: 'round-1', round: 1, state: from, version: 3 };
      if (allowed[from].includes(to)) {
        assert.deepEqual(transitionReviewRound(round, to), { ...round, state: to, version: 4 });
      } else {
        assert.throws(() => transitionReviewRound(round, to), ReviewStateError, `${from} -> ${to}`);
      }
    }
  }
});

test('review records are final except a failed call retried under a newer claim', () => {
  const first = recordReviewOutcome(null, { reviewId: 'r'.repeat(64), terminalState: 'FAILED', callGeneration: 1 });
  assert.deepEqual(first, { reviewId: 'r'.repeat(64), terminalState: 'FAILED', callGeneration: 1, version: 0 });

  // A failed call is retried only under a newer claim.
  assert.throws(
    () => recordReviewOutcome(first, { reviewId: first.reviewId, terminalState: 'COMPLETED', callGeneration: 1 }),
    ReviewStateError,
  );
  const completed = recordReviewOutcome(first, { reviewId: first.reviewId, terminalState: 'COMPLETED', callGeneration: 2 });
  assert.equal(completed.terminalState, 'COMPLETED');
  assert.equal(completed.version, 1);
  assert.equal(
    recordReviewOutcome(first, { reviewId: first.reviewId, terminalState: 'FAILED', callGeneration: 2 }).terminalState,
    'FAILED',
  );
  // A no-request outcome cannot replace a failed call.
  assert.throws(
    () => recordReviewOutcome(first, { reviewId: first.reviewId, terminalState: 'EGRESS_STOPPED', callGeneration: 2 }),
    ReviewStateError,
  );

  // Final records never change.
  for (const terminal of ['COMPLETED', 'EGRESS_STOPPED', 'SKIPPED_PUSH_GUARD'] as const) {
    const final = recordReviewOutcome(null, { reviewId: first.reviewId, terminalState: terminal, callGeneration: 1 });
    for (const next of ['COMPLETED', 'FAILED', 'EGRESS_STOPPED', 'SKIPPED_PUSH_GUARD'] as const) {
      assert.throws(
        () => recordReviewOutcome(final, { reviewId: first.reviewId, terminalState: next, callGeneration: 2 }),
        ReviewStateError,
        `${terminal} -> ${next}`,
      );
    }
  }
  // A record belongs to one reviewId, and generations start at 1.
  assert.throws(
    () => recordReviewOutcome(first, { reviewId: 's'.repeat(64), terminalState: 'COMPLETED', callGeneration: 2 }),
    ReviewStateError,
  );
  assert.throws(
    () => recordReviewOutcome(null, { reviewId: first.reviewId, terminalState: 'COMPLETED', callGeneration: 0 }),
    ReviewStateError,
  );
});
