import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { ConnectedPlatform } from '../../../db/models/connectedPlatform.model.js';
import { logger } from '../../../shared/logger.js';
import { subDays, differenceInDays } from 'date-fns';

export interface DSAIntelligenceInput {
  userId: string;
  platform?: 'leetcode' | 'codeforces' | 'codechef';
}

export const DsaIntelligenceEngine = {
  /**
   * Processes raw DSA metrics to generate deterministic intelligence.
   * Does NOT hallucinate - relies strictly on actual solves.
   */
  async generateIntelligence(input: DSAIntelligenceInput): Promise<void> {
    try {
      const { userId, platform } = input;
      
      // Readiness is unique per user, so every trigger must read the whole user.
      const submissions = await DsaSubmission.find({ userId, status: 'accepted' }).sort({ submittedAt: -1 }).lean();
      const [problems, providers] = await Promise.all([
        DsaProblem.find({ userId, _id: { $in: submissions.map(s => s.problemId) } }).select('difficulty tags').lean(),
        ConnectedPlatform.find({ userId, isConnected: true, platformName: { $in: ['leetcode', 'codeforces', 'codechef'] } })
          .select('platformName lastSyncedAt').lean(),
      ]);
      const problemMap = new Map(problems.map(p => [p._id.toString(), p]));
      const solves = new Map<string, { problemId: string; difficulty?: string; topics: string[]; submittedAt: Date }>();
      for (const submission of submissions) {
        // A shared problemId is the existing canonical identity. Titles and
        // provider-local externalIds cannot establish cross-platform equality.
        const key = submission.problemId.toString();
        const problem = problemMap.get(key);
        const topics = [...new Set([...(problem?.tags ?? []), ...(submission.topicTags ?? [])])];
        const existing = solves.get(key);
        if (existing) existing.topics = [...new Set([...existing.topics, ...topics])];
        else solves.set(key, { problemId: key, difficulty: problem?.difficulty, topics, submittedAt: submission.submittedAt });
      }
      const uniqueSolves = [...solves.values()];
      const totalSolves = uniqueSolves.length;
      
      // Calculate difficulty distribution
      const difficultyDistribution = this.calculateDifficultyDistribution(uniqueSolves);
      
      // Calculate hard problem progression
      const hardProblemProgression = this.calculateHardProblemProgression(uniqueSolves, totalSolves);
      
      // Calculate solve consistency (streak-based)
      const solveConsistency = this.calculateSolveConsistency(submissions);
      
      // Process topic mastery with depth analysis
      const processedTopics = this.processTopicMastery([], uniqueSolves);
      
      // Identify weak and neglected topics
      const weakTopics = processedTopics.filter(t => t.masteryLevel < 40).map(t => t.name);
      const neglectedTopics = processedTopics.filter(t => t.confidenceScore < 30).map(t => t.name);
      
      // Calculate progression trajectory
      const progressionTrajectory = this.calculateProgressionTrajectory(submissions);
      
      // Calculate contest participation
      const contestParticipation = this.calculateContestParticipation(submissions);
      
      // Calculate provider freshness
      const providerFreshness: Record<string, { lastSync: Date; freshnessScore: number }> = {};
      const platformNames = new Set([...submissions.map(s => s.platform), ...providers.map(p => p.platformName)]);
      for (const name of platformNames) {
        const provider = providers.find(p => p.platformName === name);
        providerFreshness[name] = this.calculateProviderFreshness(
          submissions.filter(s => s.platform === name), name, provider ? provider.lastSyncedAt ?? new Date(0) : undefined,
        );
      }
      // A fresh provider must not mask stale evidence from another provider.
      const freshnessValues = Object.values(providerFreshness);
      const compositeFreshness = { freshnessScore: freshnessValues.length
        ? freshnessValues.reduce((sum, p) => sum + p.freshnessScore, 0) / freshnessValues.length : 0 };
      
      // Calculate overall confidence score
      const confidenceScore = this.calculateOverallConfidence(
        totalSolves,
        solveConsistency,
        processedTopics,
        compositeFreshness
      );
      
      const confidenceReasoning = this.generateConfidenceReasoning(
        totalSolves,
        solveConsistency,
        processedTopics.length,
        compositeFreshness
      );
      
      const evidenceCoverage = this.calculateEvidenceCoverage(
        totalSolves,
        processedTopics.length,
        submissions.length
      );
      
      await ReadinessDsa.findOneAndUpdate(
        { userId },
        {
          totalSolves,
          hardProblemProgression,
          solveConsistency,
          difficultyDistribution,
          topics: processedTopics,
          weakTopics,
          neglectedTopics,
          confidenceScore,
          confidenceReasoning,
          evidenceCoverage,
          providerFreshness,
          snapshotVersion: '1.0.0',
          analyticsVersion: '1.0.0',
          computedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      logger.info('[DsaIntelligenceEngine] Successfully generated DSA intelligence', { userId, platform });
    } catch (error) {
      logger.error('[DsaIntelligenceEngine] Failed to generate intelligence', { input, error });
      throw error;
    }
  },

  /**
   * Calculate difficulty distribution from submissions
   */
  calculateDifficultyDistribution(submissions: any[]): { easy: number; medium: number; hard: number } {
    const distribution = { easy: 0, medium: 0, hard: 0 };
    const uniqueProblems = new Set();
    
    submissions.forEach(sub => {
      const key = sub.problemId.toString();
      if (!uniqueProblems.has(key)) {
        uniqueProblems.add(key);
        const difficulty = sub.difficulty?.toLowerCase();
        if (!difficulty) return;
        if (difficulty.includes('hard')) distribution.hard++;
        else if (difficulty.includes('medium')) distribution.medium++;
        else distribution.easy++;
      }
    });
    
    return distribution;
  },

  /**
   * Calculate hard problem progression metric
   */
  calculateHardProblemProgression(submissions: any[], totalSolves: number): number {
    if (totalSolves === 0) return 0;
    
    const hardSolves = submissions.filter(s => 
      s.difficulty?.toLowerCase().includes('hard')
    ).length;
    
    // Hard problems should be ~10% of total solves for healthy progression
    const expectedHardRatio = 0.1;
    const actualHardRatio = hardSolves / totalSolves;
    
    return Math.min(100, Math.floor((actualHardRatio / expectedHardRatio) * 100));
  },

  /**
   * Calculate solve consistency based on activity patterns
   */
  calculateSolveConsistency(submissions: any[]): number {
    if (submissions.length === 0) return 0;
    
    const now = new Date();
    const thirtyDaysAgo = subDays(now, 30);
    
    // Group submissions by day
    const dailyActivity = new Map<string, number>();
    submissions.forEach(sub => {
      const date = sub.submittedAt.toISOString().split('T')[0];
      dailyActivity.set(date, (dailyActivity.get(date) || 0) + 1);
    });
    
    // Count active days in last 30 days
    let activeDays = 0;
    for (let i = 0; i < 30; i++) {
      const date = subDays(now, i).toISOString().split('T')[0];
      if (dailyActivity.has(date)) activeDays++;
    }
    
    // Consistency score based on active days (max 30)
    return Math.min(100, Math.floor((activeDays / 20) * 100));
  },

  /**
   * Process topic mastery with depth analysis
   */
  processTopicMastery(topicProgress: any[], submissions: any[]): any[] {
    const topicMap = new Map<string, any>();
    
    // Aggregate submissions by topic
    submissions.forEach(sub => {
      const topics = sub.topics || [];
      topics.forEach((topicName: string) => {
        if (!topicMap.has(topicName)) {
          topicMap.set(topicName, {
            solves: 0,
            hardSolves: 0,
            recentSolves: 0,
            activeDays: new Set<string>(),
            lastSolve: null,
          });
        }
        const topic = topicMap.get(topicName)!;
        topic.solves++;
        if (sub.difficulty?.toLowerCase().includes('hard')) topic.hardSolves++;
        
        const daysSince = differenceInDays(new Date(), sub.submittedAt);
        if (daysSince <= 7) topic.recentSolves++;
        topic.activeDays.add(sub.submittedAt.toISOString().split('T')[0]);
        
        if (!topic.lastSolve || sub.submittedAt > topic.lastSolve) {
          topic.lastSolve = sub.submittedAt;
        }
      });
    });
    
    // Process each topic
    const processedTopics: any[] = [];
    topicMap.forEach((data, topicName) => {
      const masteryLevel = this.calculateTopicMastery(data.solves, data.hardSolves);
      const confidenceScore = this.calculateTopicConfidence(data.recentSolves, data.lastSolve);
      const evidenceCoverage = Math.min(100, (data.solves / 50) * 100);
      const progressionTrend = this.determineProgressionTrend(data.recentSolves, data.solves);
      const hardLevelMaturity = Math.min(100, data.hardSolves * 25);
      const consistency = Math.min(100, data.activeDays.size * 8);
      
      processedTopics.push({
        name: topicName,
        masteryLevel,
        confidenceScore,
        evidenceCoverage,
        progressionTrend,
        hardLevelMaturity,
        recency: data.lastSolve || new Date(),
        consistency,
      });
    });
    
    return processedTopics;
  },

  /**
   * Calculate topic mastery level
   */
  calculateTopicMastery(solves: number, hardSolves: number): number {
    if (solves === 0) return 0;
    
    // Base mastery from solve count
    let mastery = Math.min(100, solves * 5);
    
    // Bonus for hard problems
    if (hardSolves > 0) {
      mastery = Math.min(100, mastery + (hardSolves * 10));
    }
    
    return mastery;
  },

  /**
   * Calculate topic confidence based on recency
   */
  calculateTopicConfidence(recentSolves: number, lastSolve: Date | null): number {
    if (!lastSolve) return 0;
    
    const daysSince = differenceInDays(new Date(), lastSolve);
    
    // Recent activity boosts confidence
    if (recentSolves > 0) return 100;
    
    // Decay confidence over time
    const decay = Math.max(0, 100 - (daysSince * 2));
    return decay;
  },

  /**
   * Determine progression trend for a topic
   */
  determineProgressionTrend(recentSolves: number, totalSolves: number): 'improving' | 'stagnating' | 'declining' {
    if (recentSolves >= 5) return 'improving';
    if (recentSolves === 0 && totalSolves > 0) return 'declining';
    return 'stagnating';
  },

  /**
   * Calculate overall progression trajectory
   */
  calculateProgressionTrajectory(submissions: any[]): {
    trend: 'improving' | 'stagnating' | 'declining';
    velocity: number;
    acceleration: number;
  } {
    const now = new Date();
    const last7Days = submissions.filter(s => differenceInDays(now, s.submittedAt) <= 7).length;
    const last30Days = submissions.filter(s => differenceInDays(now, s.submittedAt) <= 30).length;
    const last60Days = submissions.filter(s => differenceInDays(now, s.submittedAt) <= 60).length;
    
    // Calculate velocity (solves per day)
    const velocity = last30Days / 30;
    
    // Calculate acceleration (change in velocity)
    const velocity7 = last7Days / 7;
    const velocity30 = last30Days / 30;
    const acceleration = velocity7 - velocity30;
    
    let trend: 'improving' | 'stagnating' | 'declining' = 'stagnating';
    if (acceleration > 0.1) trend = 'improving';
    else if (acceleration < -0.1) trend = 'declining';
    
    return { trend, velocity, acceleration };
  },

  /**
   * Calculate contest participation metrics
   */
  calculateContestParticipation(submissions: any[]): {
    participated: boolean;
    recentContests: number;
    contestRating: number | null;
  } {
    // Filter for contest submissions
    const contestSubmissions = submissions.filter(s => s.contestName);
    const participated = contestSubmissions.length > 0;
    
    const now = new Date();
    const recentContests = contestSubmissions.filter(s => 
      differenceInDays(now, s.submittedAt) <= 90
    ).length;
    
    // Extract rating if available
    const contestRating = submissions[0]?.rating || null;
    
    return { participated, recentContests, contestRating };
  },

  /**
   * Calculate provider freshness score
   */
  calculateProviderFreshness(submissions: any[], platform: string, syncedAt?: Date): {
    lastSync: Date;
    freshnessScore: number;
  } {
    const lastSync = syncedAt ?? (submissions.length > 0 ? submissions[0].submittedAt : new Date(0));
    
    const daysSinceSync = differenceInDays(new Date(), lastSync);
    const freshnessScore = Math.max(0, 100 - (daysSinceSync * 2));
    
    return { lastSync, freshnessScore };
  },

  /**
   * Calculate overall confidence score
   */
  calculateOverallConfidence(
    totalSolves: number,
    solveConsistency: number,
    topics: any[],
    providerFreshness: { freshnessScore: number }
  ): number {
    let confidence = 0;
    
    // Solve volume contributes
    confidence += Math.min(30, totalSolves * 0.5);
    
    // Consistency contributes
    confidence += solveConsistency * 0.3;
    
    // Topic diversity contributes
    confidence += Math.min(20, topics.length * 5);
    
    // Provider freshness contributes
    confidence += providerFreshness.freshnessScore * 0.2;
    
    return Math.min(100, Math.round(confidence));
  },

  /**
   * Generate confidence reasoning
   */
  generateConfidenceReasoning(
    totalSolves: number,
    solveConsistency: number,
    topicCount: number,
    providerFreshness: { freshnessScore: number }
  ): string {
    const reasons: string[] = [];
    
    if (totalSolves > 100) reasons.push('Strong solve volume');
    else if (totalSolves > 50) reasons.push('Moderate solve volume');
    else reasons.push('Limited solve volume');
    
    if (solveConsistency > 70) reasons.push('High consistency');
    else if (solveConsistency > 40) reasons.push('Moderate consistency');
    else reasons.push('Low consistency');
    
    if (topicCount > 10) reasons.push('Diverse topic coverage');
    else if (topicCount > 5) reasons.push('Moderate topic coverage');
    else reasons.push('Limited topic coverage');
    
    if (providerFreshness.freshnessScore > 80) reasons.push('Fresh provider data');
    else if (providerFreshness.freshnessScore > 50) reasons.push('Adequate provider data');
    else reasons.push('Stale provider data');
    
    return reasons.join(', ');
  },

  /**
   * Calculate evidence coverage
   */
  calculateEvidenceCoverage(totalSolves: number, topicCount: number, submissionCount: number): number {
    let coverage = 0;
    
    // Solve volume coverage
    coverage += Math.min(40, totalSolves * 0.4);
    
    // Topic diversity coverage
    coverage += Math.min(30, topicCount * 6);
    
    // Submission depth coverage
    coverage += Math.min(30, submissionCount * 0.3);
    
    return Math.min(100, Math.round(coverage));
  },
};
