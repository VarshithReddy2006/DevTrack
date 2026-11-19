import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import { ResumeEvidenceClaim } from '../src/db/models/resumeEvidenceClaim.model.js';
import { ResumeProfile } from '../src/db/models/resumeProfile.model.js';
import { User } from '../src/db/models/user.model.js';
import { DsaProblem } from '../src/db/models/dsaProblem.model.js';
import { DsaSubmission } from '../src/db/models/dsaSubmission.model.js';
import { evidenceInputHash, sha256 } from '../src/modules/readiness/verification/evidenceProof.js';
import { upsertClaim } from '../src/modules/resume/evidence/evidenceLedger.service.js';

const mocks = vi.hoisted(() => ({ add: vi.fn(), getUser: vi.fn(), publish: vi.fn() }));
vi.mock('../src/shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add }) }));
vi.mock('@clerk/express', () => ({ clerkClient: { users: { getUser: mocks.getUser } } }));
vi.mock('../src/shared/sse/eventBus.js', () => ({ eventBus: { publishEnvelope: mocks.publish } }));
const { processEvidenceVerification, sweepPendingEvidence } = await import('../src/modules/readiness/verification/evidenceVerification.worker.js');

let server: MongoMemoryServer | undefined;
const owner = new Types.ObjectId('1'.repeat(24)), other = new Types.ObjectId('9'.repeat(24));
const sha = 'a'.repeat(40), sourceUrl = 'https://github.com/owner/project/commit/' + sha;
const job = (claim: { _id: unknown; userId: unknown; claimText: string }) => ({ claimId: String(claim._id), userId: String(claim.userId), inputHash: evidenceInputHash(claim) });
let request: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  // Never use an application/shell URI. This process owns the server and unique database.
  server = await MongoMemoryServer.create({ binary: { version: '7.0.14' }, instance: { dbName: 'evidence_' + randomUUID().replaceAll('-', '') } });
  await mongoose.connect(server.getUri());
  await Promise.all([ResumeEvidenceClaim.init(), User.init(), ResumeProfile.init(), DsaSubmission.init()]);
});
beforeEach(async () => {
  vi.resetAllMocks(); mocks.add.mockResolvedValue(undefined); mocks.publish.mockResolvedValue(undefined);
  await User.create({ _id: owner, clerkId: 'clerk-owner', email: 'verified@example.com', username: 'owner', displayName: 'Owner', isEmailVerified: true });
  mocks.getUser.mockResolvedValue({ externalAccounts: [{ provider: 'oauth_github', providerUserId: '123', verification: { status: 'verified' } }],
    emailAddresses: [{ emailAddress: 'verified@example.com', verification: { status: 'verified' } }] });
  request = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/commits/' + sha) ? {
    sha, author: { id: 123 }, committer: { id: 123 }, commit: {
      author: { email: 'verified@example.com' }, committer: { email: 'verified@example.com' },
      verification: { verified: true, reason: 'valid', signature: 'fixture-signature', payload: 'fixture-payload' },
    },
  } : { id: 321, private: false })));
  vi.stubGlobal('fetch', request);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});
afterAll(async () => { await mongoose.disconnect(); await server?.stop(); });

async function githubClaim() {
  return ResumeEvidenceClaim.create({ userId: owner, subjectType: 'repo', subjectKey: 'commit:' + sha,
    claimText: 'Authored the referenced commit', source: 'github', sourceUrl });
}

it('verifies the real persisted claim and stores a recomputable receipt hash before SSE', async () => {
  const claim = await githubClaim();
  await processEvidenceVerification(job(claim));
  const saved = await ResumeEvidenceClaim.findById(claim._id).lean();
  expect(saved).toMatchObject({ verificationStatus: 'verified', verifiedAt: expect.any(Date), proofVerification: { state: 'verified', notificationPending: false } });
  expect(saved!.verificationHash).toBe(sha256({ version: 1, userId: String(owner), claimId: String(claim._id),
    inputHash: job(claim).inputHash, receipt: saved!.proofVerification!.receipt }));
  expect(mocks.publish).toHaveBeenCalledWith(String(owner), 'evidence.verified', expect.objectContaining({ claimId: String(claim._id), verificationHash: saved!.verificationHash }));
  expect((await ResumeEvidenceClaim.findById(claim._id))!.toJSON().verificationStatus).toBe('verified');
});

it('deduplicates concurrent decisions atomically without double-incrementing verification attempts', async () => {
  const claim = await githubClaim();
  await Promise.all([processEvidenceVerification(job(claim)), processEvidenceVerification(job(claim))]);
  const saved = await ResumeEvidenceClaim.findById(claim._id).lean();
  expect(saved!.metadata.verificationAttempts).toBe(1);
  expect(mocks.publish).toHaveBeenCalledOnce();
});

it('retries a failed notification from storage without repeating provider verification', async () => {
  const claim = await githubClaim(); mocks.publish.mockRejectedValueOnce(new Error('SSE unavailable'));
  await expect(processEvidenceVerification(job(claim))).rejects.toThrow('SSE unavailable');
  expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.proofVerification!.notificationPending).toBe(true);
  await processEvidenceVerification(job(claim));
  expect(request).toHaveBeenCalledTimes(2); // One repository request and one commit request only.
  expect(mocks.publish).toHaveBeenCalledTimes(2);
});

it('does not fetch a foreign claim and skips a deleted claim', async () => {
  const claim = await githubClaim();
  await processEvidenceVerification({ ...job(claim), userId: String(other) });
  await ResumeEvidenceClaim.deleteOne({ _id: claim._id });
  await processEvidenceVerification(job(claim));
  expect(request).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
});

it('hides stale attestations from JSON after an edit and does not process superseded jobs', async () => {
  const claim = await githubClaim(); await processEvidenceVerification(job(claim));
  await ResumeEvidenceClaim.updateOne({ _id: claim._id }, { $set: { claimText: 'New, unverified assertion' } });
  const changed = await ResumeEvidenceClaim.findById(claim._id);
  const json = changed!.toJSON();
  expect(json.verificationStatus).toBe('unverified'); expect(json.verificationHash).toBeUndefined();
  request.mockClear(); mocks.publish.mockClear();
  await processEvidenceVerification(job(claim));
  expect(request).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  await sweepPendingEvidence();
  expect(mocks.add).toHaveBeenCalledWith('verify-evidence', expect.objectContaining({ inputHash: evidenceInputHash(changed!) }), expect.any(Object));
});

it('rejects a fraudulent commit and clears a previous success hash', async () => {
  const claim = await githubClaim(); await processEvidenceVerification(job(claim));
  await ResumeEvidenceClaim.updateOne({ _id: claim._id }, { $set: { claimText: 'Changed reference context' } });
  const changed = await ResumeEvidenceClaim.findById(claim._id);
  request.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith('/commits/' + sha) ? {
    sha, author: { id: 999 }, committer: { id: 123 }, commit: { author: { email: 'verified@example.com' }, committer: { email: 'verified@example.com' },
      verification: { verified: true, reason: 'valid', signature: 'fixture', payload: 'fixture' } },
  } : { id: 321, private: false })));
  await processEvidenceVerification(job(changed!));
  expect(await ResumeEvidenceClaim.findById(claim._id).lean()).toMatchObject({ verificationStatus: 'flagged', verifiedAt: null,
    proofVerification: { state: 'rejected', reason: 'github_account_mismatch', notificationPending: false } });
  expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.verificationHash).toBeUndefined();
});

it('leaves a claim unverified when GitHub is unavailable and never reports a false rejection', async () => {
  const claim = await githubClaim(); request.mockResolvedValueOnce(new Response('', { status: 500 }));
  await expect(processEvidenceVerification(job(claim))).rejects.toThrow('unavailable');
  expect(await ResumeEvidenceClaim.findById(claim._id).lean()).toMatchObject({ verificationStatus: 'unverified' });
  expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.proofVerification).toBeUndefined();
});

it('does not commit a result if the claim is edited during the provider request', async () => {
  const claim = await githubClaim(); const original = request.getMockImplementation()!;
  request.mockImplementationOnce(async (url: string) => {
    await ResumeEvidenceClaim.updateOne({ _id: claim._id }, { $set: { claimText: 'Concurrent edit' } });
    return original(url);
  });
  await processEvidenceVerification(job(claim));
  expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.verificationHash).toBeUndefined();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it('requires accepted submissions on the same owned DSA problem and rejects manual/foreign records', async () => {
  const problem = await DsaProblem.create({ userId: owner, platform: 'leetcode', externalId: 'two-sum', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', difficulty: 'easy', category: 'Arrays' });
  const claim = await ResumeEvidenceClaim.create({ userId: owner, subjectType: 'dsa_rating', subjectKey: 'solve:' + problem._id,
    source: 'leetcode', claimText: 'Solved the referenced problem', evidenceSources: [{ type: 'dsa', referenceType: 'dsa_problem', referenceId: String(problem._id), metadata: { platform: 'leetcode' } }] });
  await DsaSubmission.create({ userId: other, platform: 'leetcode', problemId: problem._id, externalId: 'foreign', status: 'accepted', language: 'typescript', submittedAt: new Date() });
  await DsaSubmission.create({ userId: owner, platform: 'leetcode', problemId: problem._id, externalId: 'manual:1', status: 'accepted', language: 'typescript', submittedAt: new Date() });
  await processEvidenceVerification(job(claim));
  expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.verificationStatus).toBe('flagged');
  await DsaSubmission.create({ userId: owner, platform: 'leetcode', problemId: problem._id, externalId: 'synced-123', status: 'accepted', language: 'typescript', submittedAt: new Date() });
  // Re-verification uses a new claim revision, rather than replaying a rejected receipt.
  await ResumeEvidenceClaim.updateOne({ _id: claim._id }, { $set: { claimText: 'Solved the referenced problem after sync' } });
  const changed = await ResumeEvidenceClaim.findById(claim._id);
  await processEvidenceVerification(job(changed!));
  expect((await ResumeEvidenceClaim.findById(claim._id).lean())!.verificationStatus).toBe('verified');
  expect(request).not.toHaveBeenCalled(); expect(mocks.getUser).not.toHaveBeenCalled();
});

it('automatically enqueues ledger upserts and recovers queue outages through the durable sweep', async () => {
  const profile = await ResumeProfile.create({ userId: owner });
  mocks.add.mockRejectedValueOnce(new Error('Redis unavailable'));
  const claim = await upsertClaim(owner, { subjectType: 'resume_claim', resumeProfileId: profile._id as Types.ObjectId,
    subjectKey: 'explicit-commit', claimText: 'Authored a commit', source: 'github', sourceUrl, fetchedAt: new Date() });
  expect(claim).toBeTruthy(); expect(mocks.add).toHaveBeenCalledOnce();
  await sweepPendingEvidence(); expect(mocks.add).toHaveBeenCalledTimes(2);
  expect(mocks.add.mock.calls[1][1].inputHash).toBe(evidenceInputHash(claim));
});

it('keeps legacy missing-default fields consistent between lean verification and public document JSON', async () => {
  const claimId = new Types.ObjectId();
  await ResumeEvidenceClaim.collection.insertOne({ _id: claimId, userId: owner, claimText: 'Legacy explicit commit',
    evidenceSources: [{ type: 'github', referenceType: 'github_commit', referenceId: sourceUrl, metadata: {} }],
    updatedAt: new Date(), createdAt: new Date(), verificationStatus: 'unverified' });
  const raw = await ResumeEvidenceClaim.findById(claimId).lean();
  await processEvidenceVerification(job(raw!));
  expect((await ResumeEvidenceClaim.findById(claimId).lean())!.verificationStatus).toBe('verified');
  const saved = await ResumeEvidenceClaim.findById(claimId);
  expect(saved!.toJSON()).toMatchObject({ verificationStatus: 'verified', verificationHash: expect.stringMatching(/^[a-f\d]{64}$/) });
});

it('retires a stale stored attestation when its proof is removed, including direct database edits', async () => {
  const claim = await githubClaim(); await processEvidenceVerification(job(claim));
  await ResumeEvidenceClaim.updateOne({ _id: claim._id }, { $set: { source: 'user', claimText: 'A new assertion without a proof' }, $unset: { sourceUrl: '' } });
  const changed = await ResumeEvidenceClaim.findById(claim._id);
  expect(changed!.toJSON()).toMatchObject({ verificationStatus: 'unverified', confidence: 0 });
  mocks.add.mockClear(); await sweepPendingEvidence();
  expect(mocks.add).toHaveBeenCalledWith('verify-evidence', expect.objectContaining({ inputHash: evidenceInputHash(changed!) }), expect.any(Object));
  await processEvidenceVerification(job(changed!));
  const saved = await ResumeEvidenceClaim.findById(claim._id).lean();
  expect(saved).toMatchObject({ verificationStatus: 'unverified', confidence: 0, proofVerification: { reason: 'proof_reference_removed', notificationPending: false } });
  expect(saved!.verificationHash).toBeUndefined(); expect(saved!.verifiedAt).toBeNull();
});
