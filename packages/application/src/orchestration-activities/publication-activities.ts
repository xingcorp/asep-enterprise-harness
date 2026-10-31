// The publication activities: the push, the pull-request upsert and the
// reconciliation read, over the vertical slice's publication steps.
//
// The forge is not fenced: an owner stalled inside a forge call can still reach
// it after a takeover. What holds instead is the publication contract of the steps —
// the push is compare-and-set (the attempt branch must be absent, or already
// hold the attempt's commit), and a pull request's title and body are a pure
// function of the attempt's immutable facts, so a late write by a stale owner
// is a no-op or byte-identical. Each activity still checks the delivery's abort
// signal and its record fence immediately before its forge call.
//
// Every result and every failure reports the publication's effect:
//   applied  the effect is on the remote (the call returned, or a record or a
//            read shows it);
//   none     provably absent: this delivery failed before its forge call, and
//            either it created the side-effect record itself or no record
//            existed, so no other delivery had begun one;
//   unknown  anything else — a failure after the call started, a record some
//            delivery began before, or a FAILED record, which the side-effect
//            log never reopens. The workflow reconciles the remote before any
//            terminal state.
//
// The reconciliation read reports what it observes and decides nothing. Its only
// write rewrites a diverged title and body of the pull request the attempt's
// COMPLETED pr-upsert record names, by that number (the
// reconcilePullRequestStep of the steps). It never creates, retargets, closes or merges a
// pull request, and never moves the branch.

import type { ArtifactRef } from '@asep/contracts';
import type {
  ActivityExecutionContext, ForgeProvider, PullRequestFacts, SideEffectLog, SideEffectOperation,
} from '@asep/ports';
import { parseSideEffectResultRef } from '@asep/ports';
import {
  pullRequestFactsOf, pushStep, reconcilePullRequestStep, upsertPrStep, type PullRequestAssurance,
} from '../pipeline-steps.js';
import { fencedBy } from '../completion-observer.js';
import { throwIfCancelled } from './context.js';
import type { OrchestrationActivityDeps } from './deps.js';
import { boundaryObserver, recordedCommit } from './execution-activities.js';
import { OrchestrationContractError, type AttemptActivityIdentity, type LeasedAttemptIdentity } from './identity.js';
import type { ForgeRepositoryRef } from './ports.js';
import { auditedLog } from './side-effect-audit.js';

export type PublicationEffect = 'applied' | 'none' | 'unknown';

/**
 * A publication activity failed. `effect` says whether the push or the upsert is on the remote; `cause` is the
 * error that ended the activity, whose name decides retryability.
 */
export class PublicationActivityError extends Error {
  constructor(readonly operation: 'push' | 'pr-upsert', readonly effect: PublicationEffect, cause: unknown) {
    super(`${operation} failed with effect ${effect}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'PublicationActivityError';
  }
}

/**
 * The upserted pull request is not the attempt's reviewable publication: closed, merged, on another base, or not
 * showing the attempt's commit, as the read after the upsert found it. The effect is applied; the workflow
 * reconciles and decides. Not retryable: another delivery finds the same.
 */
export class PullRequestNotReviewableError extends Error {
  constructor(gap: string) {
    super(`the pull request is not the attempt's reviewable publication: ${gap}`);
    this.name = 'PullRequestNotReviewableError';
  }
}

/** What one delivery did to the record and the forge, for the effect of its failure. */
interface EffectTrace {
  /** The record was read before anything else, and found absent. */
  readAbsent: boolean;
  /** begin() was called. */
  beginCalled: boolean;
  /** begin() returned a record this delivery created. */
  created: boolean;
  /** The forge write of the operation was called. */
  callStarted: boolean;
}

function effectOf(trace: EffectTrace): PublicationEffect {
  if (trace.callStarted) return 'unknown';
  if (!trace.beginCalled) return trace.readAbsent ? 'none' : 'unknown';
  return trace.created ? 'none' : 'unknown';
}

function tracingLog(log: SideEffectLog, trace: EffectTrace): SideEffectLog {
  return {
    async begin(scope, input) {
      trace.beginCalled = true;
      const record = await log.begin(scope, input);
      trace.created = !record.existed;
      return record;
    },
    confirmOwner: (scope, key) => log.confirmOwner(scope, key),
    complete: (scope, input) => log.complete(scope, input),
    fail: (scope, input) => log.fail(scope, input),
    find: (scope, key) => log.find(scope, key),
  };
}

/** The forge with the abort check immediately before each write, after the record's owner confirmation. */
function tracingForge(forge: ForgeProvider, trace: EffectTrace, ctx: ActivityExecutionContext): ForgeProvider {
  return {
    async pushBranch(scope, input) {
      throwIfCancelled(ctx, 'the push');
      trace.callStarted = true;
      return forge.pushBranch(scope, input);
    },
    async upsertPullRequest(scope, input) {
      throwIfCancelled(ctx, 'the pull-request upsert');
      trace.callStarted = true;
      return forge.upsertPullRequest(scope, input);
    },
    updatePullRequestContent: (scope, input) => forge.updatePullRequestContent(scope, input),
    resolveRef: (scope, input) => forge.resolveRef(scope, input),
    findPullRequest: (scope, input) => forge.findPullRequest(scope, input),
  };
}

function keyOf(input: AttemptActivityIdentity, operation: SideEffectOperation) {
  return { operation, repositoryBindingId: input.repositoryBindingId, attemptId: input.attemptId };
}

/**
 * Runs one publication operation and reports its effect on failure. A record found FAILED is reported unknown
 * without a call: the side-effect log never reopens it, and the effect may have reached the remote before it was recorded.
 */
async function withEffect<T>(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity, ctx: ActivityExecutionContext, operation: 'push' | 'pr-upsert',
  run: (log: SideEffectLog, forge: ForgeProvider) => Promise<T>,
): Promise<T> {
  const trace: EffectTrace = { readAbsent: false, beginCalled: false, created: false, callStarted: false };
  try {
    const prior = await deps.sideEffects.find(input.scope, keyOf(input, operation));
    trace.readAbsent = prior === null;
    if (prior !== null && prior.state === 'FAILED') {
      throw new OrchestrationContractError(`the ${operation} record of attempt ${input.attemptId} is FAILED`);
    }
    throwIfCancelled(ctx, `the ${operation}`);
    return await run(tracingLog(auditedLog(deps, input, ctx), trace), tracingForge(deps.forge, trace, ctx));
  } catch (err) {
    if (err instanceof PublicationActivityError) throw err;
    throw new PublicationActivityError(operation, effectOf(trace), err);
  }
}

// --- publishBranch ----------------------------------------------------------------

export async function publishBranch(
  deps: OrchestrationActivityDeps, input: LeasedAttemptIdentity, ctx: ActivityExecutionContext,
): Promise<{ readonly effect: 'applied' }> {
  await withEffect(deps, input, ctx, 'push', async (log, forge) => {
    const commit = await recordedCommit(deps, input);
    if (commit === null) throw new OrchestrationContractError(`attempt ${input.attemptId} has no recorded commit to push`);
    const observe = fencedBy(boundaryObserver(deps, input), () => deps.leases.heartbeat(input.scope, input.fence.leaseId));
    // Compare-and-set: the attempt branch must be absent, or already hold the attempt's commit.
    await observe(
      { span: 'forge.push', action: 'forge.push', detail: { branch: input.branch, commitSha: commit.commitSha } },
      () => pushStep({
        forge, log, scope: input.scope, repositoryBindingId: input.repositoryBindingId, attemptId: input.attemptId,
        branch: input.branch, commitSha: commit.commitSha, leaseId: input.fence.leaseId,
      }),
    );
  });
  return { effect: 'applied' };
}

// --- upsertPullRequest -----------------------------------------------------------------

export interface UpsertPullRequestInput extends LeasedAttemptIdentity {
  /** The binding repository the PR is opened in: the task input's repository. */
  readonly repository: ForgeRepositoryRef;
  /** The PR's base: the task input's base branch. */
  readonly baseBranch: string;
  /** The assurance round escalated: the PR says assurance is not satisfied. */
  readonly flagged: boolean;
  /** The round's PR-body section; null when the round had nothing to show or was unavailable. */
  readonly prBodySectionRef: ArtifactRef | null;
}

/** The facts a publication presents, recorded once so every delivery and every reconciliation writes the same. */
interface PublicationFact {
  readonly repository: ForgeRepositoryRef;
  readonly baseBranch: string;
  readonly assurance: PullRequestAssurance;
}

async function publicationFactOf(
  deps: OrchestrationActivityDeps, input: UpsertPullRequestInput,
): Promise<PublicationFact> {
  const key = { attemptId: input.attemptId, kind: 'publication' as const };
  const recorded = await deps.facts.get(input.scope, key) as PublicationFact | null;
  if (recorded !== null) return recorded;
  const section = input.prBodySectionRef === null
    ? null
    : new TextDecoder('utf-8', { fatal: true }).decode((await deps.artifacts.get(input.scope, input.prBodySectionRef)).content);
  const fact: PublicationFact = {
    repository: input.repository,
    baseBranch: input.baseBranch,
    assurance: { flagged: input.flagged, section },
  };
  return (await deps.facts.putOnce(input.scope, { ...key, value: fact })).value as PublicationFact;
}

function factsFor(input: AttemptActivityIdentity, commit: { commitSha: string; evidenceId: string }, fact: PublicationFact): PullRequestFacts {
  return pullRequestFactsOf({
    taskId: input.taskId, attemptId: input.attemptId, commitSha: commit.commitSha, evidenceId: commit.evidenceId,
    base: fact.baseBranch, assurance: fact.assurance,
  });
}

export async function upsertPullRequest(
  deps: OrchestrationActivityDeps, input: UpsertPullRequestInput, ctx: ActivityExecutionContext,
): Promise<{ readonly effect: 'applied'; readonly prNumber: number }> {
  return withEffect(deps, input, ctx, 'pr-upsert', async (log, forge) => {
    const commit = await recordedCommit(deps, input);
    if (commit === null) throw new OrchestrationContractError(`attempt ${input.attemptId} has no recorded commit to publish`);
    const fact = await publicationFactOf(deps, input);
    const observe = fencedBy(boundaryObserver(deps, input), () => deps.leases.heartbeat(input.scope, input.fence.leaseId));
    const upsert = await observe(
      { span: 'forge.pull_request', action: 'forge.pull_request.upsert', detail: { headBranch: input.branch, base: fact.baseBranch } },
      () => upsertPrStep({
        forge, log, scope: input.scope, repositoryBindingId: input.repositoryBindingId, taskId: input.taskId,
        attemptId: input.attemptId, headBranch: input.branch, base: fact.baseBranch, commitSha: commit.commitSha,
        evidenceId: commit.evidenceId, leaseId: input.fence.leaseId, assurance: fact.assurance,
      }),
    );
    // As the vertical slice's driver does: read the PR again after its record, and take only the recorded PR, open,
    // unmerged, on the attempt's base and showing its commit, as the publication.
    const published = await reconcilePullRequestStep({
      forge: deps.forge, scope: input.scope, repositoryBindingId: input.repositoryBindingId, branch: input.branch,
      facts: factsFor(input, commit, fact), observe,
      recorded: { number: upsert.pr.number, url: upsert.pr.url, headBranch: upsert.pr.headBranch, baseBranch: upsert.pr.baseBranch },
    });
    if (published.gap !== undefined || published.pr === null) {
      throw new PublicationActivityError('pr-upsert', 'applied',
        new PullRequestNotReviewableError(published.gap ?? `the forge shows no pull request for ${input.branch}`));
    }
    return { effect: 'applied' as const, prNumber: published.pr.number };
  });
}

// --- reconcilePublication ---------------------------------------------------------------

export interface ReconcilePublicationInput extends AttemptActivityIdentity {
  /** The binding repository the attempt branch was pushed to. */
  readonly repository: ForgeRepositoryRef;
  readonly remoteBranch: string;
  readonly expectedHeadSha: string;
  readonly expectedBaseBranch: string;
  /** The caller's fence while the attempt holds its lease; the content repair is made under it. */
  readonly fence: LeasedAttemptIdentity['fence'] | null;
}

export interface ObservedPullRequestResult {
  readonly number: number;
  readonly headRepository: ForgeRepositoryRef;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseRepository: ForgeRepositoryRef;
  readonly baseBranch: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly contentRepaired: boolean;
}

export interface ReconcilePublicationResult {
  readonly branch: { readonly repository: ForgeRepositoryRef; readonly headSha: string } | null;
  readonly pullRequests: readonly ObservedPullRequestResult[];
}

export async function reconcilePublication(
  deps: OrchestrationActivityDeps, input: ReconcilePublicationInput,
): Promise<ReconcilePublicationResult> {
  const read = { repositoryBindingId: input.repositoryBindingId };
  // The one write: the content repair of the PR the attempt's COMPLETED pr-upsert record names, with the facts
  // the attempt's upsert recorded. With no such record, or no recorded facts, nothing is written.
  let repairedNumber: number | null = null;
  const record = await deps.sideEffects.find(input.scope, keyOf(input, 'pr-upsert'));
  const fact = await deps.facts.get(input.scope, { attemptId: input.attemptId, kind: 'publication' }) as PublicationFact | null;
  const commit = await recordedCommit(deps, input);
  if (record !== null && record.state === 'COMPLETED' && fact !== null && commit !== null) {
    const recorded = parseSideEffectResultRef(record.resultRef, 'pr-upsert');
    const fence = input.fence;
    const observe = fence === null
      ? boundaryObserver(deps, input)
      : fencedBy(boundaryObserver(deps, input), () => deps.leases.heartbeat(input.scope, fence.leaseId));
    const repaired = await reconcilePullRequestStep({
      forge: deps.forge, scope: input.scope, repositoryBindingId: input.repositoryBindingId, branch: input.remoteBranch,
      facts: factsFor(input, commit, fact), observe,
      recorded: { number: recorded.number, url: recorded.url, headBranch: recorded.headBranch, baseBranch: recorded.baseBranch },
    });
    if (repaired.repaired) repairedNumber = recorded.number;
  }
  // The observation is read after any repair, so it shows what the remote holds now.
  const branch = await deps.publicationReader.readBranch(input.scope, { ...read, branch: input.remoteBranch });
  const listed = await deps.publicationReader.listPullRequests(input.scope, { ...read, headBranch: input.remoteBranch });
  return {
    branch: branch === null ? null : { repository: branch.repository, headSha: branch.headSha },
    pullRequests: listed.map((pr) => ({
      number: pr.number,
      headRepository: pr.headRepository,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      baseRepository: pr.baseRepository,
      baseBranch: pr.baseBranch,
      state: pr.state,
      merged: pr.merged,
      contentRepaired: pr.number === repairedNumber,
    })),
  };
}
