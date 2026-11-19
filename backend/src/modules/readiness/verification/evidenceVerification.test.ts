import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { evidenceInputHash } from './evidenceProof.js';
import { GitHubBackoffError } from './githubVerifier.service.js';
import type { EvidenceVerificationDeps, VerificationClaim } from './evidenceVerification.worker.js';

const mocks = vi.hoisted(() => ({ add: vi.fn(), schedule: vi.fn(), close: vi.fn(), rateLimit: vi.fn(), create: vi.fn(),
  find: vi.fn(), getUser: vi.fn(), userFind: vi.fn(), submissionFind: vi.fn(), problemExists: vi.fn() }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add, upsertJobScheduler: mocks.schedule }) }));
vi.mock('../../../shared/jobs/dlq.service.js', () => ({ createDlqWorker: mocks.create }));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => ({ status: 'ready' }) }));
vi.mock('@clerk/express', () => ({ clerkClient: { users: { getUser: mocks.getUser } } }));
vi.mock('../../../db/models/user.model.js', () => ({ User: { findById: mocks.userFind } }));
vi.mock('../../../db/models/resumeEvidenceClaim.model.js', () => ({ ResumeEvidenceClaim: { find: mocks.find } }));
vi.mock('../../../db/models/dsaSubmission.model.js', () => ({ DsaSubmission: { findOne: mocks.submissionFind } }));
vi.mock('../../../db/models/dsaProblem.model.js', () => ({ DsaProblem: { exists: mocks.problemExists } }));
const { processEvidenceVerification, sweepPendingEvidence, startEvidenceVerificationWorker, stopEvidenceVerificationWorker,
  verifiedGitHubIdentity, verifyDsaProof } = await import('./evidenceVerification.worker.js');
const { enqueueEvidenceVerification } = await import('./evidenceVerification.queue.js');
const userId = '1'.repeat(24), claimId = '2'.repeat(24);
function fixture() {
  const claim: VerificationClaim = { _id: claimId, userId, claimText: 'Authored the referenced commit', source: 'github',
    sourceUrl: 'https://github.com/owner/repo/commit/' + 'a'.repeat(40), updatedAt: new Date() };
  const decision = { verified: true, reason: 'verified', receipt: { scope: 'signed_commit_authorship', sha: 'a'.repeat(40) } };
  const deps = {
    load: vi.fn<EvidenceVerificationDeps['load']>(async () => claim),
    identity: vi.fn(async () => ({ accountId: '123', verifiedEmails: ['verified@example.com'] })),
    github: vi.fn(async () => decision), dsa: vi.fn(async () => decision),
    commit: vi.fn<EvidenceVerificationDeps['commit']>(async (_claim, inputHash, result, hash) => {
      claim.verificationHash = hash ?? undefined;
      claim.proofVerification = { state: result.verified ? 'verified' : 'rejected', inputHash,
        reason: result.reason, receipt: result.receipt, notificationPending: result.verified };
      return true;
    }),
    notify: vi.fn<EvidenceVerificationDeps['notify']>(async () => {}), now: () => new Date('2026-11-19T09:00:00Z'),
  } satisfies EvidenceVerificationDeps;
  return { claim, deps, decision, job: { userId, claimId, inputHash: evidenceInputHash(claim) } };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.add.mockResolvedValue(undefined); mocks.schedule.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined); mocks.rateLimit.mockResolvedValue(undefined);
  mocks.create.mockReturnValue({ close: mocks.close, rateLimit: mocks.rateLimit, on: vi.fn() });
});
afterEach(async () => { await stopEvidenceVerificationWorker(); });

describe('proof verification processing', () => {
  it('persists a hash before notifying and treats duplicate completed work as a no-op', async () => {
    const { job, claim, deps } = fixture();
    await processEvidenceVerification(job, deps);
    expect(claim.verificationHash).toMatch(/^[a-f\d]{64}$/);
    expect(deps.commit.mock.invocationCallOrder[0]).toBeLessThan(deps.notify.mock.invocationCallOrder[0]);
    claim.proofVerification!.notificationPending = false;
    await processEvidenceVerification(job, deps);
    expect(deps.github).toHaveBeenCalledOnce(); expect(deps.notify).toHaveBeenCalledOnce();
  });
  it('retries notification failure from the durable receipt without another GitHub request', async () => {
    const { job, deps } = fixture();
    deps.notify.mockRejectedValueOnce(new Error('SSE offline'));
    await expect(processEvidenceVerification(job, deps)).rejects.toThrow('SSE offline');
    await processEvidenceVerification(job, deps);
    expect(deps.github).toHaveBeenCalledOnce(); expect(deps.commit).toHaveBeenCalledOnce();
    expect(deps.notify).toHaveBeenCalledTimes(2);
  });
  it('does not notify a failed compare-and-set or commit failure', async () => {
    const { job, deps } = fixture();
    deps.commit.mockResolvedValueOnce(false);
    await processEvidenceVerification(job, deps);
    expect(deps.notify).not.toHaveBeenCalled();
    deps.commit.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(processEvidenceVerification(job, deps)).rejects.toThrow('database unavailable');
    expect(deps.notify).not.toHaveBeenCalled();
  });
  it('keeps API errors retryable without recording a fraudulent-claim decision', async () => {
    const { job, deps } = fixture();
    deps.github.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(processEvidenceVerification(job, deps)).rejects.toBeInstanceOf(RetryableError);
    expect(deps.commit).not.toHaveBeenCalled();
  });
  it('records explicit rejection without a success hash or notification', async () => {
    const { job, deps, decision } = fixture();
    decision.verified = false; decision.reason = 'signature_not_verified';
    await processEvidenceVerification(job, deps);
    expect(deps.commit.mock.calls[0][3]).toBeNull(); expect(deps.notify).not.toHaveBeenCalled();
    await processEvidenceVerification(job, deps); expect(deps.github).toHaveBeenCalledOnce();
  });
  it('skips deleted, foreign and superseded jobs', async () => {
    const { job, claim, deps } = fixture();
    deps.load.mockResolvedValueOnce(null);
    await processEvidenceVerification(job, deps);
    claim.claimText = 'Changed'; await processEvidenceVerification(job, deps);
    expect(deps.github).not.toHaveBeenCalled(); expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.load).toHaveBeenCalledWith(userId, claimId);
  });
  it('preserves moderation flags from other verification systems', async () => {
    const { job, claim, deps } = fixture();
    claim.verificationStatus = 'flagged'; claim.metadata = { flaggedReason: 'moderator_rejection' };
    await processEvidenceVerification(job, deps);
    expect(deps.github).not.toHaveBeenCalled(); expect(deps.commit).not.toHaveBeenCalled();
  });
  it.each([{}, { userId, claimId, inputHash: 'bad' }])('rejects malformed job data', async value => {
    await expect(processEvidenceVerification(value, fixture().deps)).rejects.toBeInstanceOf(NonRetryableError);
  });
  it('routes an explicit DSA proof without calling GitHub or Clerk', async () => {
    const { claim, deps } = fixture(); delete claim.sourceUrl;
    claim.evidenceSources = [{ type: 'dsa', referenceType: 'dsa_problem', referenceId: '3'.repeat(24), metadata: { platform: 'codeforces' } }];
    await processEvidenceVerification({ userId, claimId, inputHash: evidenceInputHash(claim) }, deps);
    expect(deps.dsa).toHaveBeenCalledWith(userId, { kind: 'dsa_problem', reference: '3'.repeat(24), platform: 'codeforces' });
    expect(deps.identity).not.toHaveBeenCalled(); expect(deps.github).not.toHaveBeenCalled();
  });
});

describe('authoritative identities and local DSA proof', () => {
  it('uses verified Clerk emails and a verified linked GitHub id instead of claim metadata', async () => {
    mocks.userFind.mockReturnValue({ select: () => ({ lean: async () => ({ clerkId: 'clerk-user' }) }) });
    mocks.getUser.mockResolvedValue({ externalAccounts: [{ provider: 'oauth_github', providerUserId: '123', verification: { status: 'verified' } }],
      emailAddresses: [{ emailAddress: 'verified@example.com', verification: { status: 'verified' } }, { emailAddress: 'unverified@example.com', verification: { status: 'unverified' } }] });
    expect(await verifiedGitHubIdentity(userId)).toEqual({ accountId: '123', verifiedEmails: ['verified@example.com'] });
    mocks.getUser.mockResolvedValueOnce({ externalAccounts: [], emailAddresses: [] });
    expect(await verifiedGitHubIdentity(userId)).toBeNull();
  });
  it('requires an owned accepted submission and an owned problem on the same platform', async () => {
    const submission = { _id: 'submission', problemId: 'problem', externalId: 'platform-123', submittedAt: new Date() };
    mocks.submissionFind.mockReturnValue({ sort: () => ({ lean: async () => submission }) });
    mocks.problemExists.mockResolvedValue(true);
    const proof = { kind: 'dsa_problem', reference: '3'.repeat(24), platform: 'leetcode' } as const;
    expect((await verifyDsaProof(userId, proof)).verified).toBe(true);
    expect(mocks.submissionFind).toHaveBeenCalledWith(expect.objectContaining({ userId, platform: 'leetcode', status: 'accepted', problemId: proof.reference }));
    expect(mocks.problemExists).toHaveBeenCalledWith({ _id: 'problem', userId, platform: 'leetcode' });
    mocks.problemExists.mockResolvedValueOnce(false);
    expect((await verifyDsaProof(userId, proof)).verified).toBe(false);
  });
});

describe('durable enqueue and worker lifecycle', () => {
  it('enqueues explicit proofs with an input-bound stable id, ignores summaries, and tolerates Redis outages', async () => {
    const { claim } = fixture();
    await enqueueEvidenceVerification(claim);
    expect(mocks.add).toHaveBeenCalledWith('verify-evidence', expect.objectContaining({ userId, claimId }),
      expect.objectContaining({ jobId: `evidence-${claimId}-${evidenceInputHash(claim)}`, attempts: 5 }));
    mocks.add.mockRejectedValueOnce(new Error('Redis offline'));
    await expect(enqueueEvidenceVerification(claim)).resolves.toBeUndefined();
    const count = mocks.add.mock.calls.length;
    await enqueueEvidenceVerification({ ...claim, sourceUrl: undefined });
    expect(mocks.add).toHaveBeenCalledTimes(count);
  });
  it('sweeps unfinished claims, skips complete receipts, and closes its cursor', async () => {
    const { claim } = fixture();
    const completed = { ...claim, proofVerification: { state: 'verified', inputHash: evidenceInputHash(claim), notificationPending: false } };
    const close = vi.fn();
    const cursor = { async *[Symbol.asyncIterator]() { yield claim; yield completed; yield { ...claim, sourceUrl: undefined }; }, close };
    mocks.find.mockReturnValue({ sort: () => ({ lean: () => ({ cursor: () => cursor }) }) });
    await sweepPendingEvidence();
    expect(mocks.add).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it('starts once, schedules catch-up and periodic scans, and drains on shutdown', async () => {
    await startEvidenceVerificationWorker(); await startEvidenceVerificationWorker();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.schedule).toHaveBeenCalledWith('evidence-pending-sweep', { every: 60000 }, expect.objectContaining({ name: 'sweep' }));
    expect(mocks.add).toHaveBeenCalledWith('sweep', {}, expect.objectContaining({ jobId: 'evidence-startup-sweep' }));
    await stopEvidenceVerificationWorker(); await stopEvidenceVerificationWorker();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('applies GitHub reset backoff to the whole queue using BullMQ rate-limit retry', async () => {
    await startEvidenceVerificationWorker();
    const run = mocks.create.mock.calls[0][1];
    mocks.userFind.mockReturnValue({ select: () => ({ lean: async () => { throw new GitHubBackoffError(120000); } }) });
    // Drive the handler using a sweep error, without performing a network request.
    mocks.find.mockImplementationOnce(() => { throw new GitHubBackoffError(120000); });
    await expect(run({ name: 'sweep', data: {} })).rejects.toThrow('bullmq:rateLimitExceeded');
    expect(mocks.rateLimit).toHaveBeenCalledWith(120000);
  });
});
