import { evidenceInputHash, evidenceProof, hasExternalFlag, type VerifiableClaim } from './evidenceProof.js';

/** Fast path after a claim write; the durable worker sweep repairs queue outages. */
export async function enqueueEvidenceVerification(claim: VerifiableClaim): Promise<void> {
  if (hasExternalFlag(claim) || (!evidenceProof(claim) && !claim.proofVerification)) return;
  try {
    const { getOrCreateQueue } = await import('../../../shared/jobs/queueFactory.js');
    const { QueueNames } = await import('../../../shared/jobs/types.js');
    const inputHash = evidenceInputHash(claim);
    await getOrCreateQueue(QueueNames.EVIDENCE_VERIFICATION).add('verify-evidence', {
      userId: String(claim.userId), claimId: String(claim._id), inputHash,
    }, { jobId: `evidence-${claim._id}-${inputHash}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 }, removeOnFail: { count: 500 } });
  } catch (error) {
    const { logger } = await import('../../../shared/logger.js');
    logger.warn('[evidence] Queue unavailable; pending claim will be recovered by sweep', { claimId: String(claim._id), error: error instanceof Error ? error.name : 'unknown' });
  }
}
