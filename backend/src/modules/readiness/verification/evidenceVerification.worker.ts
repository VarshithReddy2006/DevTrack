import { Worker } from 'bullmq';
import { z } from 'zod';
import { clerkClient } from '@clerk/express';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { User } from '../../../db/models/user.model.js';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import { logger } from '../../../shared/logger.js';
import { evidenceInputHash, evidenceProof, hasExternalFlag, sha256, type EvidenceProof, type VerifiableClaim, type VerificationDecision } from './evidenceProof.js';
import { enqueueEvidenceVerification } from './evidenceVerification.queue.js';
import { GitHubBackoffError, verifyGitHubCommit, type GitHubIdentity } from './githubVerifier.service.js';

export interface VerificationClaim extends VerifiableClaim {
  updatedAt: Date;
  verificationHash?: string;
  proofVerification?: { state: 'verified' | 'rejected'; inputHash: string; notificationPending: boolean; reason: string; receipt: Record<string, unknown> };
}

export async function verifiedGitHubIdentity(userId: string): Promise<GitHubIdentity | null> {
  const user = await User.findById(userId).select('clerkId').lean();
  if (!user) return null;
  const identity = await clerkClient.users.getUser(user.clerkId);
  const account = identity.externalAccounts.find(account => ['github', 'oauth_github'].includes(account.provider)
    && account.verification?.status === 'verified' && account.providerUserId);
  if (!account) return null;
  return { accountId: account.providerUserId,
    verifiedEmails: identity.emailAddresses.filter(email => email.verification?.status === 'verified').map(email => email.emailAddress) };
}

export async function verifyDsaProof(userId: string, proof: Extract<EvidenceProof, { platform: string }>): Promise<VerificationDecision> {
  const submission = await DsaSubmission.findOne({ userId, platform: proof.platform, status: 'accepted',
    ...(proof.kind === 'dsa_problem' ? { problemId: proof.reference } : { _id: proof.reference }),
    externalId: { $type: 'string', $nin: ['', null], $not: /^manual:/i },
  }).sort({ submittedAt: -1, _id: -1 }).lean();
  if (!submission || !await DsaProblem.exists({ _id: submission.problemId, userId, platform: proof.platform })) {
    return { verified: false, reason: 'accepted_submission_not_found', receipt: { scope: 'accepted_problem_submission', platform: proof.platform } };
  }
  return { verified: true, reason: 'accepted_submission_verified', receipt: { scope: 'accepted_problem_submission',
    platform: proof.platform, submissionId: String(submission._id), problemId: String(submission.problemId),
    externalId: submission.externalId, submittedAt: submission.submittedAt.toISOString() } };
}

export interface EvidenceVerificationDeps {
  load: (userId: string, claimId: string) => Promise<VerificationClaim | null>;
  identity: typeof verifiedGitHubIdentity;
  github: typeof verifyGitHubCommit;
  dsa: typeof verifyDsaProof;
  commit: (claim: VerificationClaim, inputHash: string, decision: VerificationDecision, hash: string | null, checkedAt: Date) => Promise<boolean>;
  notify: (userId: string, claimId: string, inputHash: string, hash: string, receipt: Record<string, unknown>) => Promise<void>;
  now: () => Date;
}

const defaults: EvidenceVerificationDeps = {
  load: (userId, claimId) => ResumeEvidenceClaim.findOne({ _id: claimId, userId }).lean(),
  identity: verifiedGitHubIdentity, github: verifyGitHubCommit, dsa: verifyDsaProof, now: () => new Date(),
  async commit(claim, inputHash, decision, hash, checkedAt) {
    const result = await ResumeEvidenceClaim.updateOne({ _id: claim._id, userId: claim.userId, updatedAt: claim.updatedAt,
      claimText: claim.claimText, source: claim.source ?? null, sourceUrl: claim.sourceUrl ?? null,
      subjectType: claim.subjectType ?? null, subjectKey: claim.subjectKey ?? null,
      // $literal preserves legacy empty metadata instead of Mongoose minimizing query subdocuments.
      $expr: { $eq: [{ $ifNull: ['$evidenceSources', []] }, { $literal: claim.evidenceSources ?? [] }] },
      verificationStatus: claim.verificationStatus ?? 'unverified',
      'metadata.flaggedReason': claim.metadata?.flaggedReason ?? null, 'proofVerification.inputHash': { $ne: inputHash } }, {
      $set: { verificationStatus: decision.verified ? 'verified' : decision.reason === 'proof_reference_removed' ? 'unverified' : 'flagged', ...(hash ? { verificationHash: hash } : {}),
        verifiedAt: decision.verified ? checkedAt : null, confidence: decision.verified ? 100 : 0,
        proofVerification: { state: decision.verified ? 'verified' : 'rejected', inputHash, reason: decision.reason,
          receipt: decision.receipt, notificationPending: decision.verified },
        'metadata.lastVerifiedAt': checkedAt, 'metadata.flaggedReason': decision.verified || decision.reason === 'proof_reference_removed' ? null : decision.reason },
      $inc: { 'metadata.verificationAttempts': 1 },
      ...(!decision.verified ? { $unset: { verificationHash: '' } } : {}),
    }, { runValidators: true });
    return result.matchedCount === 1;
  },
  async notify(userId, claimId, inputHash, hash, receipt) {
    const current = await ResumeEvidenceClaim.findOne({ _id: claimId, userId, verificationStatus: 'verified', verificationHash: hash, 'proofVerification.inputHash': inputHash,
      'proofVerification.notificationPending': true }).lean();
    if (!current || evidenceInputHash(current) !== inputHash) return;
    await eventBus.publishEnvelope(userId, 'evidence.verified', { claimId, inputHash, verificationHash: hash,
      scope: receipt.scope, verificationStatus: 'verified' });
    await ResumeEvidenceClaim.updateOne({ _id: claimId, userId, 'proofVerification.inputHash': inputHash },
      { $set: { 'proofVerification.notificationPending': false } });
  },
};

const jobSchema = z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i), claimId: z.string().regex(/^[a-f\d]{24}$/i), inputHash: z.string().regex(/^[a-f\d]{64}$/) });

export async function processEvidenceVerification(raw: unknown, deps: EvidenceVerificationDeps = defaults): Promise<void> {
  const parsed = jobSchema.safeParse(raw);
  if (!parsed.success) throw new NonRetryableError('Malformed evidence verification job');
  const { userId, claimId, inputHash } = parsed.data;
  const claim = await deps.load(userId, claimId);
  if (!claim || hasExternalFlag(claim) || evidenceInputHash(claim) !== inputHash) return; // Deleted, foreign, moderated or superseded work.
  const prior = claim.proofVerification;
  if (prior?.inputHash === inputHash) {
    if (prior.state === 'verified' && prior.notificationPending && claim.verificationHash) {
      await deps.notify(userId, claimId, inputHash, claim.verificationHash, prior.receipt);
    }
    return;
  }
  const proof = evidenceProof(claim);
  if (!proof && !prior) return;
  let decision: VerificationDecision;
  try {
    decision = !proof ? { verified: false, reason: 'proof_reference_removed', receipt: {} }
      : proof.kind === 'invalid' ? { verified: false, reason: proof.reason, receipt: {} }
      : proof.kind === 'github_commit' ? await deps.github(proof.reference, await deps.identity(userId))
      : await deps.dsa(userId, proof);
  } catch (error) {
    if (error instanceof RetryableError) throw error;
    throw new RetryableError('Evidence verification dependency unavailable', error instanceof Error ? error : undefined);
  }
  const hash = decision.verified ? sha256({ version: 1, userId, claimId, inputHash, receipt: decision.receipt }) : null;
  if (!await deps.commit(claim, inputHash, decision, hash, deps.now())) return;
  if (hash) await deps.notify(userId, claimId, inputHash, hash, decision.receipt);
}

export async function sweepPendingEvidence(): Promise<void> {
  const cursor = ResumeEvidenceClaim.find({ $or: [{ 'evidenceSources.type': { $in: ['github', 'dsa'] } }, { source: 'github' }, { proofVerification: { $exists: true } }] })
    .sort({ _id: 1 }).lean().cursor({ batchSize: 100 });
  try {
    for await (const claim of cursor) {
      if (hasExternalFlag(claim) || (!evidenceProof(claim) && !claim.proofVerification)) continue;
      if (claim.proofVerification?.inputHash === evidenceInputHash(claim) && !claim.proofVerification.notificationPending) continue;
      await enqueueEvidenceVerification(claim);
    }
  } finally { await cursor.close(); }
}

let worker: Worker | null = null;
export async function startEvidenceVerificationWorker(): Promise<Worker> {
  if (worker) return worker;
  worker = createDlqWorker(QueueNames.EVIDENCE_VERIFICATION, async job => {
    try {
      if (job.name === 'sweep') return await sweepPendingEvidence();
      await processEvidenceVerification(job.data);
    } catch (error) {
      if (error instanceof GitHubBackoffError) {
        await worker!.rateLimit(error.retryAfterMs);
        throw typeof Worker?.RateLimitError === 'function'
          ? Worker.RateLimitError()
          : new Error('bullmq:rateLimitExceeded');
      }
      throw error;
    }
  }, { connection: getRedisClient(), concurrency: 2, limiter: { max: 10, duration: 1000 } });
  worker.on('error', error => logger.error('[evidence] Verification worker error', error));
  const queue = getOrCreateQueue(QueueNames.EVIDENCE_VERIFICATION);
  await queue.upsertJobScheduler('evidence-pending-sweep', { every: 60000 }, {
    name: 'sweep', data: {}, opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
  });
  await queue.add('sweep', {}, { jobId: 'evidence-startup-sweep', removeOnComplete: true, removeOnFail: true });
  return worker;
}
export async function stopEvidenceVerificationWorker(): Promise<void> {
  if (!worker) return;
  const closing = worker;
  await closing.close();
  worker = null;
}
