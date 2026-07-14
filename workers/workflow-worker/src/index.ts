import type { CodingAgentProvider, ReviewProvider } from '@asep/ports';
import type { ContextPack, VerificationResult, WorkOrder } from '@asep/contracts';
import { gatePolicy } from '@asep/policy';

export interface Activities {
  buildContext(order: WorkOrder): Promise<ContextPack>;
  verify(order: WorkOrder, resultSha: string): Promise<VerificationResult>;
  persistCheckpoint(input: unknown): Promise<void>;
}

export async function executeTaskKernel(input: {
  order: WorkOrder;
  implementer: CodingAgentProvider;
  reviewer?: ReviewProvider;
  activities: Activities;
}): Promise<{ accepted: boolean; reason: string }> {
  const policy = gatePolicy(input.order.risk);
  const context = await input.activities.buildContext(input.order);
  const attempt = await input.implementer.execute(input.order, context);
  await input.activities.persistCheckpoint({ phase: 'attempt', attempt });

  if (attempt.status !== 'SUCCEEDED' || !attempt.resultSha) {
    return { accepted: false, reason: `attempt:${attempt.status}` };
  }

  const verification = await input.activities.verify(input.order, attempt.resultSha);
  await input.activities.persistCheckpoint({ phase: 'verification', verification });
  if (verification.verdict !== 'PASS') return { accepted: false, reason: 'verification_failed' };

  if (policy.independentReviewers > 0) {
    if (!input.reviewer) return { accepted: false, reason: 'reviewer_required' };
    // A production implementation passes an immutable diff artifact ID here.
    const review = await input.reviewer.review({
      order: input.order,
      context,
      diffArtifactId: 'artifact-placeholder' as never,
      verification,
      implementerProviderId: input.implementer.providerId
    });
    await input.activities.persistCheckpoint({ phase: 'review', review });
    if (review.verdict !== 'APPROVE') return { accepted: false, reason: `review:${review.verdict}` };
  }

  return { accepted: true, reason: 'all_required_gates_passed' };
}
