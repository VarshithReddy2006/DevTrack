import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedPlatform } from '../../../../db/models/connectedPlatform.model.js';
import { ResumeEvidenceClaim, type VerificationStatus } from '../../../../db/models/resumeEvidenceClaim.model.js';
import { ProviderHealthRegistry } from '../../provider/ProviderHealthRegistry.js';
import { IntelligentRecommendationEngine } from '../../recommendation/IntelligentRecommendationEngine.js';
import { TrustAwareGuidanceLayer } from '../TrustAwareGuidanceLayer.js';

vi.mock('../../recommendation/IntelligentRecommendationEngine.js', () => ({
  IntelligentRecommendationEngine: { generateRecommendations: vi.fn() },
}));

describe('TrustAwareGuidanceLayer', () => {
  const now = new Date('2026-11-13T00:00:00Z');
  const userId = new Types.ObjectId();
  const otherUserId = new Types.ObjectId();
  const hour = 60 * 60 * 1000;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    vi.spyOn(ProviderHealthRegistry, 'getHealthSummary').mockReturnValue({
      totalProviders: 1, healthyCount: 1, degradedCount: 0, downCount: 0, degradedModeCount: 0,
    });
    vi.spyOn(ProviderHealthRegistry, 'getDegradedProviders').mockReturnValue([]);
    vi.mocked(IntelligentRecommendationEngine.generateRecommendations).mockResolvedValue([{
      recommendationId: 'recommendation-1',
      userId: userId.toHexString(),
      type: 'project',
      title: 'Build a project',
      description: 'Demonstrate a skill',
      reasoning: '',
      expectedImpact: '',
      confidence: 90,
      evidenceChain: [],
      roadmapDependencies: [],
      priority: 'high',
      estimatedEffort: 'medium',
      createdAt: now,
      expiresAt: new Date(now.getTime() + hour),
    }]);
  });

  it.each<{ statuses: VerificationStatus[]; score: number; confidence: number }>([
    { statuses: [], score: 20, confidence: 74 },
    { statuses: ['unverified', 'flagged'], score: 0, confidence: 70 },
    { statuses: ['verified', 'verified', 'partial', 'flagged'], score: 50, confidence: 80 },
    { statuses: ['verified'], score: 100, confidence: 90 },
  ])('calibrates recommendations at $score% evidence coverage', async ({ statuses, score, confidence }) => {
    const resumeProfileId = new Types.ObjectId();
    await ResumeEvidenceClaim.insertMany([
      { userId: otherUserId, resumeProfileId, claimText: 'Another user’s claim', verificationStatus: 'verified' },
      ...statuses.map((verificationStatus, index) => ({
        userId, resumeProfileId, claimText: `Claim ${index}`, verificationStatus,
      })),
    ]);

    const result = await TrustAwareGuidanceLayer.generateTrustAwareGuidance({ userId: userId.toHexString() });
    expect(result.trustFactors.find(factor => factor.factor === 'evidence-coverage')?.value).toBe(score);
    expect(result.warnings.some(warning => warning.message === 'Limited verified resume evidence')).toBe(score < 70);
    expect(result.recommendations[0]).toMatchObject({
      adjustedConfidence: confidence,
      isTrustReduced: score < 70,
    });
  });

  it('requires current successful syncs from this user’s connected benchmark platforms', async () => {
    const github = await ConnectedPlatform.create({
      userId, platformName: 'github', username: 'developer', profileUrl: 'https://example.test/github',
      syncStatus: 'success', lastSyncedAt: new Date(now.getTime() - 25 * hour),
    });
    const leetcode = await ConnectedPlatform.create({
      userId, platformName: 'leetcode', username: 'developer', profileUrl: 'https://example.test/leetcode',
      syncStatus: 'error', lastSyncedAt: now,
    });
    await ConnectedPlatform.create({
      userId: otherUserId, platformName: 'github', username: 'other', profileUrl: 'https://example.test/other',
      syncStatus: 'success', lastSyncedAt: now,
    });

    async function getBenchmark() {
      const guidance = await TrustAwareGuidanceLayer.generateTrustAwareGuidance({ userId: userId.toHexString() });
      return {
        score: guidance.trustFactors.find(factor => factor.factor === 'benchmark-confidence')?.value,
        warning: guidance.warnings.some(warning => warning.message === 'Benchmark data is incomplete or stale'),
      };
    }

    expect(await getBenchmark()).toEqual({ score: 0, warning: true });
    await github.updateOne({ lastSyncedAt: new Date(now.getTime() - 24 * hour) });
    expect(await getBenchmark()).toEqual({ score: 50, warning: true });
    await leetcode.updateOne({ syncStatus: 'success' });
    expect(await getBenchmark()).toEqual({ score: 100, warning: false });
    await leetcode.updateOne({ isConnected: false });
    expect(await getBenchmark()).toEqual({ score: 50, warning: true });
  });
});
