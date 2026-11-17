import { Types } from 'mongoose';
import { expect, it } from 'vitest';
import { PlatformStats } from '../../db/models/platformStats.model.js';
import { ResumeEvidenceClaim, type IEvidenceSource } from '../../db/models/resumeEvidenceClaim.model.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import { EvidenceGraphEngine } from '../../modules/resume/evidence/EvidenceGraphEngine.js';
import { ResumeEvidenceResolver } from '../../modules/resume/evidence/ResumeEvidenceResolver.js';

const reference = (type: IEvidenceSource['type'], referenceType: string, referenceId: unknown): IEvidenceSource => ({
  type, referenceType, referenceId: String(referenceId), metadata: {},
});

it('persists same-user provenance and recalculates confidence idempotently', async () => {
  const userId = new Types.ObjectId();
  const otherUserId = new Types.ObjectId();
  const resumeProfileId = new Types.ObjectId();
  const [repo, foreignRepo, pendingRepo] = await VerifiedProject.create([
    { userId, name: 'API', repoFullName: 'example/api', repoUrl: 'https://github.com/example/api',
      githubRepoId: '100', verification: { status: 'verified' } },
    { userId: otherUserId, name: 'Other', repoFullName: 'example/other', repoUrl: 'https://github.com/example/other',
      githubRepoId: '101', verification: { status: 'verified' } },
    { userId, name: 'Pending', repoFullName: 'example/pending', repoUrl: 'https://github.com/example/pending',
      githubRepoId: '102' },
  ]);
  const stats = await PlatformStats.create({ userId, platformName: 'leetcode', username: 'candidate', totalSolved: 46 });
  const now = new Date();
  const session = await ResumeSession.create({
    userId, sessionId: 'candidate-session', currentStage: 'COMPLETED',
    uploadMetadata: {
      originalFilename: 'resume.txt', fileType: 'txt', fileSize: 12, mimeType: 'text/plain',
      uploadPath: '/fixture/resume.txt', uploadedAt: now,
    },
    timestamps: { uploadedAt: now, lastUpdated: now },
  });
  const sources = [
    reference('github', 'github', 'https://github.com/Example/Api.git'),
    reference('github', 'githubRepository', repo.githubRepoId),
    reference('project', 'verifiedProject', repo._id),
    reference('dsa', 'platformStats', stats._id),
    reference('manual', 'resumeSession', session.sessionId),
    reference('github', 'verifiedProject', foreignRepo._id),
    reference('github', 'githubRepository', pendingRepo.githubRepoId),
    reference('ai_assisted', 'verifiedProject', repo._id),
  ];
  const [claim, flagged, unsupported, foreign, ledger] = await ResumeEvidenceClaim.create([
    { userId, resumeProfileId, claimText: 'Built and verified a service', evidenceSources: sources },
    { userId, resumeProfileId, claimText: 'Disputed claim', evidenceSources: sources, verificationStatus: 'flagged' },
    { userId, resumeProfileId, claimText: 'Unsupported claim', confidence: 80, evidenceSources: sources.slice(5) },
    { userId: otherUserId, resumeProfileId, claimText: 'Other candidate', confidence: 45 },
    { userId, subjectType: 'repo', subjectKey: 'repo:example/api', claimText: 'Repository ledger entry', confidence: 88 },
  ]);
  await ResumeEvidenceClaim.collection.updateOne({ _id: claim._id }, { $unset: { subjectType: '' } });

  const engine = new EvidenceGraphEngine();
  await engine.buildGraphForUser(userId);
  const snapshot = await ResumeEvidenceClaim.findById(claim.id).lean().orFail();
  expect(snapshot.lineage).toBeUndefined();
  await expect(engine.getTraceability(claim.id)).resolves.toEqual({
    lineage: [
      { sourceModel: 'PlatformStats', sourceId: String(stats._id), relationship: 'synced_platform_stats', weight: 70 },
      { sourceModel: 'ResumeSession', sourceId: String(session._id), relationship: 'resume_origin', weight: 25 },
      { sourceModel: 'VerifiedProject', sourceId: String(repo._id), relationship: 'verified_repository', weight: 90 },
    ],
    provenance: snapshot.evidenceSources,
    confidence: 90,
  });
  await expect(engine.getTraceability(flagged.id)).resolves.toMatchObject({ confidence: 0 });
  await expect(engine.getTraceability(unsupported.id)).resolves.toMatchObject({ confidence: 0, lineage: [] });
  expect((await ResumeEvidenceClaim.findById(foreign.id).orFail()).confidence).toBe(45);
  expect((await ResumeEvidenceClaim.findById(ledger.id).orFail()).confidence).toBe(88);

  await engine.buildGraphForUser(userId);
  expect((await ResumeEvidenceClaim.findById(claim.id).orFail()).updatedAt).toEqual(snapshot.updatedAt);

  await VerifiedProject.deleteOne({ _id: repo._id });
  await engine.buildGraphForUser(userId);
  const rebuilt = await engine.getTraceability(claim.id);
  expect(rebuilt.confidence).toBe(70);
  expect(rebuilt.lineage.map(edge => edge.sourceModel)).toEqual(['PlatformStats', 'ResumeSession']);

  await new ResumeEvidenceResolver().syncClaimToDB(userId, claim.claimText, []);
  await expect(engine.getTraceability(claim.id)).resolves.toEqual({ lineage: [], provenance: [], confidence: 0 });
});
