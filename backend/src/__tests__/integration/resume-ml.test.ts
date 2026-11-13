import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { ATSAnalysis } from '../../db/models/atsAnalysis.model.js';
import { ReadinessCore } from '../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../db/models/readinessDsa.model.js';
import { ReadinessProjects } from '../../db/models/readinessProjects.model.js';
import { ResumeCredibility } from '../../db/models/resumeCredibility.model.js';
import { ResumeProfile } from '../../db/models/resumeProfile.model.js';
import { ResumeEvidenceClaim } from '../../db/models/resumeEvidenceClaim.model.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import { VerifiedProject } from '../../db/models/verifiedProject.model.js';
import type { EmbeddingResponse } from '../../modules/ai/embedding/EmbeddingProviderAdapter.js';
import { ResumeMLService } from '../../modules/resume/ai/ResumeMLService.js';
import { ResumeOrchestrationEngine } from '../../modules/resume/orchestration/ResumeOrchestrationEngine.js';
import { ResumeIntelligenceService } from '../../modules/resume/services/ResumeIntelligenceService.js';

const backendResume = 'Backend engineer. Built PostgreSQL APIs and Redis queues.';
const backendRole = 'Backend role building PostgreSQL APIs and Redis queues';
const unrelatedRole = 'Manage retail merchandising and seasonal inventory';

function embedding(vector: number[], model = 'test-embedding'): EmbeddingResponse {
  return { vector, provider: 'openai', model, dimensions: vector.length };
}

describe('resume role matching', () => {
  it('uses one transient embedding batch and scores aligned roles higher', async () => {
    const generateEmbeddingBatch = vi.fn(async ([, role]: string[]) => [
      embedding([1, 0]),
      embedding(role === backendRole ? [0.9, 0.1] : [-1, 0]),
    ]);
    const service = new ResumeMLService({ generateEmbeddingBatch });

    const aligned = await service.matchRoleSemantically(backendResume, backendRole);
    const unrelated = await service.matchRoleSemantically(backendResume, unrelatedRole);
    expect(aligned.usedFallback).toBe(false);
    expect(aligned.score).toBeGreaterThan(0.9);
    expect(unrelated).toEqual({ score: 0, usedFallback: false });
    expect(generateEmbeddingBatch).toHaveBeenCalledTimes(2);
    expect(generateEmbeddingBatch).toHaveBeenNthCalledWith(1, [backendResume, backendRole]);
  });

  it('uses lexical similarity when the adapter returns no-key placeholders', async () => {
    const generateEmbeddingBatch = vi.fn(async () => [
      embedding([1, 0], 'deterministic-fallback-v1'),
      embedding([0, 1], 'deterministic-fallback-v1'),
    ]);
    const service = new ResumeMLService({ generateEmbeddingBatch });

    const aligned = await service.matchRoleSemantically(backendResume, backendRole);
    expect(aligned).toMatchObject({ usedFallback: true });
    expect(aligned.score).toBeGreaterThan(0.5);
    expect(await service.matchRoleSemantically(backendResume, unrelatedRole)).toEqual({ score: 0, usedFallback: true });
    expect(await service.matchRoleSemantically(backendResume, backendRole)).toEqual(aligned);
  });

  it('falls back on provider rejection or incompatible vectors and skips blank inputs', async () => {
    const generateEmbeddingBatch = vi.fn()
      .mockRejectedValueOnce(new Error('provider offline'))
      .mockResolvedValueOnce([embedding([1, 0]), embedding([1, 0, 0])]);
    const service = new ResumeMLService({ generateEmbeddingBatch });

    expect(await service.matchRoleSemantically('Redis PostgreSQL', 'Redis PostgreSQL')).toEqual({ score: 1, usedFallback: true });
    expect(await service.matchRoleSemantically(backendResume, unrelatedRole)).toEqual({ score: 0, usedFallback: true });
    expect(await service.matchRoleSemantically(' ', backendRole)).toEqual({ score: 0, usedFallback: true });
    expect(generateEmbeddingBatch).toHaveBeenCalledTimes(2);
  });
});

describe('persisted resume recommendations', () => {
  it('prioritizes each owner’s latest ATS, readiness, and project evidence', async () => {
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();
    const profile = new Types.ObjectId();
    await Promise.all([
      ATSAnalysis.create({ userId: first, resumeProfileId: profile, keywordCoverage: [{ keyword: 'Old Keyword', found: false }], createdAt: new Date('2020-01-01') }),
      ATSAnalysis.create({ userId: first, resumeProfileId: profile, keywordCoverage: [{ keyword: 'PostgreSQL', found: false }, { keyword: 'Redis', found: true }] }),
      ReadinessCore.create({ userId: first.toString(), overallScore: 45, targetRoleAlignment: 35 }),
      ReadinessDsa.create({ userId: first.toString(), weakTopics: ['Graphs'] }),
      VerifiedProject.create({
        userId: first, githubRepoId: '123', repoFullName: 'owner/queue', repoUrl: 'https://github.com/owner/queue',
        name: 'Queue Processor', verification: { status: 'verified' },
      }),
      ReadinessProjects.create({ userId: second.toString(), evidenceCoverage: 60, deploymentEvidence: 20 }),
      ReadinessDsa.create({ userId: second.toString(), neglectedTopics: ['Dynamic Programming'] }),
    ]);

    const service = new ResumeMLService();
    const firstActions = await service.optimizeRecommendations(first.toString());
    expect(firstActions).toEqual([
      expect.stringContaining('PostgreSQL'),
      expect.stringContaining('Queue Processor'),
      expect.stringContaining('Graphs'),
    ]);
    expect(firstActions.join(' ')).not.toMatch(/Old Keyword|Redis/);
    expect(await service.optimizeRecommendations(second.toString())).toEqual([
      expect.stringContaining('deployment link'),
      expect.stringContaining('Dynamic Programming'),
    ]);
    expect(await service.optimizeRecommendations(new Types.ObjectId().toString())).toEqual([]);
    expect(await service.optimizeRecommendations('invalid-id')).toEqual([]);
  });

  it('uses unsupported claims and credibility only from the caller’s own resume', async () => {
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();
    const sessionId = 'owned-session';
    const now = new Date();
    await Promise.all([
      ResumeEvidenceClaim.create({
        userId: first, resumeProfileId: new Types.ObjectId(), claimText: 'Unverified claim', verificationStatus: 'flagged',
      }),
      ResumeSession.create({
        sessionId, userId: second, currentStage: 'COMPLETED',
        uploadMetadata: {
          originalFilename: 'resume.txt', fileType: 'txt', fileSize: 10, uploadPath: 'fixture.txt',
          uploadedAt: now, mimeType: 'text/plain',
        },
        timestamps: { uploadedAt: now, lastUpdated: now, completedAt: now },
      }),
      ResumeCredibility.create({ sessionId, suspiciousClaims: ['Unsupported second user claim'], summary: 'Review needed' }),
    ]);

    const service = new ResumeMLService();
    expect(await service.optimizeRecommendations(first.toString())).toEqual([expect.stringContaining('Verify flagged')]);
    expect(await service.optimizeRecommendations(second.toString())).toEqual([expect.stringContaining('Verify flagged')]);
    expect(await service.optimizeRecommendations(new Types.ObjectId().toString())).toEqual([]);
  });

  it('returns personalized actions from the existing resume generation service', async () => {
    const userId = new Types.ObjectId();
    const profile = await ResumeProfile.create({ userId });
    await ATSAnalysis.create({
      userId, resumeProfileId: profile._id, recommendations: ['Use a standard skills heading.'],
    });
    const orchestrate = vi.spyOn(ResumeOrchestrationEngine.prototype, 'orchestrate').mockResolvedValue({
      resumeProfile: profile,
      prioritizedProjects: [],
      prioritizedSkills: [],
      engineeringSignals: {
        infraSignals: { dockerUsage: false, cicdPipeline: false, cloudDeployment: false, monitoring: false, testing: false, score: 0 },
        systemDesignSignals: { architectureComplexity: 0, scalabilityEvidence: false, distributedSystems: false, score: 0 },
        dsaSignals: { problemsSolved: 0, contestsParticipated: 0, averageDifficulty: 'N/A', score: 0 },
      },
      credibilityScore: 0,
      recommendations: ['Existing credibility summary.'],
    });
    try {
      // Both the HTTP controller and worker supply a string at runtime.
      const result = await new ResumeIntelligenceService().generateResume(userId.toString() as unknown as Types.ObjectId);
      expect(result.recommendations).toEqual(['Use a standard skills heading.', 'Existing credibility summary.']);
    } finally {
      orchestrate.mockRestore();
    }
  });
});
