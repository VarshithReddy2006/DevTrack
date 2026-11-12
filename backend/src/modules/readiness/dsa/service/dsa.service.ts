import { dsaRepository, AggregatedDSAData } from '../repository/dsa.repository.js';
import { readinessScoreEngine } from '../scoring/ReadinessScoreEngine.js';
import { consistencyEngine } from '../scoring/ConsistencyEngine.js';
import { hardProgressEngine } from '../scoring/HardProgressEngine.js';
import { confidenceEngine } from '../scoring/ConfidenceEngine.js';
import { trendEngine } from '../trend-engine/TrendEngine.js';
import { recommendationEngine } from '../recommendation-engine/RecommendationEngine.js';
import { DSAIntelligenceInput, DSAIntelligenceOutput, Platform, TopicBreakdown } from '../types/dsa.types';

export class DSAService {
  /**
   * Generate comprehensive DSA intelligence
   * Orchestrates all intelligence engines to produce complete DSA analysis
   */
  async generateDSAIntelligence(input: DSAIntelligenceInput): Promise<DSAIntelligenceOutput> {
    const { userId, platform } = input;

    // Fetch aggregated DSA data from repository
    const dsaData = await dsaRepository.aggregateByUserId(userId);

    // Calculate consistency score
    const consistencyScore = consistencyEngine.calculateConsistencyScore({
      currentStreak: dsaData.currentStreak,
      longestStreak: dsaData.longestStreak,
      lastSolvedDate: dsaData.lastSolvedDate,
      totalSolved: dsaData.totalSolved,
    });

    // Calculate readiness score
    const readinessScore = readinessScoreEngine.calculateReadinessScore({
      totalSolved: dsaData.totalSolved,
      easySolved: dsaData.easySolved,
      mediumSolved: dsaData.mediumSolved,
      hardSolved: dsaData.hardSolved,
      topicBreakdown: dsaData.topicBreakdown,
      consistencyScore,
    });

    // Calculate hard progress score
    const hardProgressScore = hardProgressEngine.calculateHardProgressScore({
      hardSolved: dsaData.hardSolved,
      totalSolved: dsaData.totalSolved,
      hardGrowthTrend: 0.1, // TODO: Calculate from historical data
    });

    // Calculate confidence score
    const confidenceScore = confidenceEngine.calculateConfidenceScore({
      lastSyncedAt: dsaData.lastSyncedAt,
      isVerified: dsaData.isVerified,
      totalSolved: dsaData.totalSolved,
      lastSolvedDate: dsaData.lastSolvedDate,
      platform: platform || dsaData.platforms[0] || 'manual',
    });

    // Calculate trend status
    const status = trendEngine.calculateTrend({
      recentActivity: [], // TODO: Calculate from historical data
      currentStreak: dsaData.currentStreak,
      hardGrowthTrend: 0.1, // TODO: Calculate from historical data
    });

    // Generate topic recommendations
    const { strongTopics, weakTopics, nextTopics } = recommendationEngine.generateRecommendations({
      weakTopics: [], // TODO: Calculate from topic breakdown
      targetRole: undefined, // TODO: Get from user profile
      topicBreakdown: dsaData.topicBreakdown,
    });

    // Calculate readiness impact (contribution to overall readiness)
    const readinessImpact = Math.round(readinessScore * 0.2); // 20% weight in overall readiness

    // Calculate verification coverage
    const verificationCoverage = dsaData.isVerified ? 100 : 0;

    // Build difficulty distribution
    const difficultyDistribution = {
      easy: dsaData.easySolved,
      medium: dsaData.mediumSolved,
      hard: dsaData.hardSolved,
      total: dsaData.totalSolved,
    };

    return {
      readinessScore,
      consistencyScore,
      hardProgressScore,
      readinessImpact,
      difficultyDistribution,
      strongTopics,
      weakTopics,
      nextTopics,
      confidenceScore,
      verificationCoverage,
      status,
      lastUpdated: dsaData.lastSyncedAt || new Date(),
    };
  }

  /**
   * Update DSA profile data
   */
  async updateDSAProfile(
    userId: string,
    platform: Platform,
    data: Partial<{
      totalSolved: number;
      easySolved: number;
      mediumSolved: number;
      hardSolved: number;
      currentStreak: number;
      longestStreak: number;
      lastSolvedDate: Date | null;
      topicBreakdown: TopicBreakdown;
    }>
  ): Promise<void> {
    const updateData = {
      ...data,
      lastSyncedAt: new Date(),
    };

    await dsaRepository.update(userId, platform, updateData);
  }

  /**
   * Get DSA profile by user and platform
   */
  async getDSAProfile(userId: string, platform?: Platform): Promise<AggregatedDSAData> {
    if (platform) {
      const profile = await dsaRepository.findByUserIdAndPlatform(userId, platform);
      if (profile) {
        return {
          totalSolved: profile.totalSolved,
          easySolved: profile.easySolved,
          mediumSolved: profile.mediumSolved,
          hardSolved: profile.hardSolved,
          currentStreak: profile.currentStreak,
          longestStreak: profile.longestStreak,
          lastSolvedDate: profile.lastSolvedDate,
          topicBreakdown: profile.topicBreakdown,
          isVerified: profile.isVerified,
          lastSyncedAt: profile.lastSyncedAt,
          platforms: [profile.platform],
        };
      }
    }

    return await dsaRepository.aggregateByUserId(userId);
  }
}

export const dsaService = new DSAService();
