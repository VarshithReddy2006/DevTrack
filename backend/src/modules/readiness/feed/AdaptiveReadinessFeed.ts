import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { SnapshotVersioningSystem } from '../../operations/index.js';
import { logger } from '../../../shared/logger.js';

export interface FeedInput {
  userId: string;
  maxItems?: number;
  timeframe?: 'day' | 'week' | 'month';
}

export interface FeedItem {
  feedId: string;
  userId: string;
  type: 'insight' | 'shift' | 'acceleration' | 'stagnation' | 'regression' | 'milestone';
  title: string;
  description: string;
  category: 'dsa' | 'skills' | 'projects' | 'infrastructure' | 'roadmap' | 'benchmark';
  severity: 'info' | 'warning' | 'critical';
  confidence: number; // 0-100
  evidence: string[];
  timestamp: Date;
  trend: 'up' | 'down' | 'stable' | 'unknown';
  magnitude: number; // -100 to 100
}

class AdaptiveReadinessFeedClass {
  /**
   * Generate adaptive readiness feed with contextual insights
   */
  async generateFeed(input: FeedInput): Promise<FeedItem[]> {
    const { userId, maxItems = 10, timeframe = 'week' } = input;
    
    try {
      logger.info('[AdaptiveReadinessFeed] Generating feed', { userId, timeframe });
      
      // Fetch current readiness data
      const [dsaData, skillsData, projectsData, roadmapData, benchmarksData] = await Promise.all([
        ReadinessDsa.findOne({ userId }),
        ReadinessSkills.findOne({ userId }),
        ReadinessProjects.findOne({ userId }),
        ReadinessRoadmap.findOne({ userId }),
        ReadinessBenchmarks.findOne({ userId }),
      ]);
      
      const feedItems: FeedItem[] = [];
      
      // Generate DSA insights
      if (dsaData) {
        const dsaInsights = this.generateDSAInsights(dsaData, userId, timeframe);
        feedItems.push(...dsaInsights);
      }
      
      // Generate Skills insights
      if (skillsData) {
        const skillInsights = this.generateSkillInsights(skillsData, userId, timeframe);
        feedItems.push(...skillInsights);
      }
      
      // Generate Project insights
      if (projectsData) {
        const projectInsights = this.generateProjectInsights(projectsData, userId, timeframe);
        feedItems.push(...projectInsights);
      }
      
      // Generate Roadmap insights
      if (roadmapData) {
        const roadmapInsights = this.generateRoadmapInsights(roadmapData, userId, timeframe);
        feedItems.push(...roadmapInsights);
      }
      
      // Generate Benchmark insights
      if (benchmarksData) {
        const benchmarkInsights = this.generateBenchmarkInsights(benchmarksData, userId, timeframe);
        feedItems.push(...benchmarkInsights);
      }
      
      // Generate snapshot-based insights (compare with previous snapshots)
      const snapshotInsights = await this.generateSnapshotInsights(userId);
      feedItems.push(...snapshotInsights);
      
      // Sort by recency and severity
      const sortedFeed = this.sortFeed(feedItems);
      
      // Return top items
      const topFeed = sortedFeed.slice(0, maxItems);
      
      logger.info('[AdaptiveReadinessFeed] Feed generated', { 
        userId, 
        itemCount: topFeed.length 
      });
      
      return topFeed;
    } catch (error) {
      logger.error('[AdaptiveReadinessFeed] Failed to generate feed', { userId, error });
      throw error;
    }
  }

  /**
   * Generate DSA-specific feed insights
   */
  private generateDSAInsights(dsaData: any, userId: string, timeframe: string): FeedItem[] {
    const insights: FeedItem[] = [];
    
    // Check for topic consistency drops
    if (dsaData.solveConsistency < 70) {
      insights.push({
        feedId: this.generateFeedId(userId, 'dsa', 'consistency'),
        userId,
        type: 'stagnation',
        title: 'DSA solve consistency dropped',
        description: `Solve consistency is ${dsaData.solveConsistency}%, below the 70% threshold. Focus on consistent daily practice.`,
        category: 'dsa',
        severity: dsaData.solveConsistency < 50 ? 'critical' : 'warning',
        confidence: 85,
        evidence: [
          `Solve consistency: ${dsaData.solveConsistency}%`,
          `Total solves: ${dsaData.totalSolves}`,
          `Hard problem progression: ${dsaData.hardProblemProgression}%`
        ],
        timestamp: new Date(),
        trend: 'down',
        magnitude: -(100 - dsaData.solveConsistency),
      });
    }
    
    // Check for hard problem acceleration
    if (dsaData.hardProblemProgression > 50) {
      insights.push({
        feedId: this.generateFeedId(userId, 'dsa', 'hard-acceleration'),
        userId,
        type: 'acceleration',
        title: 'Hard problem mastery accelerating',
        description: `Hard problem progression reached ${dsaData.hardProblemProgression}%, indicating strong problem-solving growth.`,
        category: 'dsa',
        severity: 'info',
        confidence: 90,
        evidence: [
          `Hard problem progression: ${dsaData.hardProblemProgression}%`,
          `Solve consistency: ${dsaData.solveConsistency}%`
        ],
        timestamp: new Date(),
        trend: 'up',
        magnitude: dsaData.hardProblemProgression,
      });
    }
    
    // Check for topic-specific stagnation
    if (dsaData.topics) {
      const stagnantTopics = dsaData.topics.filter((t: any) => 
        t.masteryLevel > 30 && t.masteryLevel < 50 && t.recency < 50
      );
      
      stagnantTopics.forEach((topic: any) => {
        insights.push({
          feedId: this.generateFeedId(userId, 'dsa', `topic-${topic.topicName}`),
          userId,
          type: 'stagnation',
          title: `${topic.topicName} mastery plateaued`,
          description: `${topic.topicName} mastery at ${topic.masteryLevel}% with low recency. Consider solving more ${topic.topicName} problems.`,
          category: 'dsa',
          severity: 'warning',
          confidence: 75,
          evidence: [
            `Topic mastery: ${topic.masteryLevel}%`,
            `Recency: ${topic.recency}%`,
            `Confidence: ${topic.confidenceScore}%`
          ],
          timestamp: new Date(),
          trend: 'stable',
          magnitude: 0,
        });
      });
    }
    
    return insights;
  }

  /**
   * Generate Skills-specific feed insights
   */
  private generateSkillInsights(skillsData: any, userId: string, timeframe: string): FeedItem[] {
    const insights: FeedItem[] = [];
    
    // Check for infrastructure verification opportunities
    if (skillsData.domains) {
      const backendDomain = skillsData.domains.find((d: any) => d.name.toLowerCase().includes('backend'));
      
      if (backendDomain && backendDomain.maturity < 60) {
        insights.push({
          feedId: this.generateFeedId(userId, 'skills', 'backend-infra'),
          userId,
          type: 'insight',
          title: 'Backend infrastructure verification would significantly improve readiness',
          description: `Backend domain maturity is ${backendDomain.maturity}%. Adding Redis, Docker, or queue systems would boost infrastructure sophistication.`,
          category: 'infrastructure',
          severity: 'warning',
          confidence: 85,
          evidence: [
            `Backend maturity: ${backendDomain.maturity}%`,
            `Production relevance: ${backendDomain.productionRelevance}%`,
            `Overall engineering depth: ${skillsData.overallEngineeringDepth}%`
          ],
          timestamp: new Date(),
          trend: 'unknown',
          magnitude: 0,
        });
      }
    }
    
    // Check for domain acceleration
    if (skillsData.domains) {
      const acceleratingDomains = skillsData.domains.filter((d: any) => 
        d.maturity > 50 && d.maturity < 80 && d.recency > 70
      );
      
      acceleratingDomains.forEach((domain: any) => {
        insights.push({
          feedId: this.generateFeedId(userId, 'skills', `domain-${domain.name}`),
          userId,
          type: 'acceleration',
          title: `${domain.name} domain accelerating rapidly`,
          description: `${domain.name} maturity is ${domain.maturity}% with high recency (${domain.recency}%), indicating strong recent progress.`,
          category: 'skills',
          severity: 'info',
          confidence: 80,
          evidence: [
            `Domain maturity: ${domain.maturity}%`,
            `Recency: ${domain.recency}%`,
            `Practical exposure: ${domain.practicalExposure}%`
          ],
          timestamp: new Date(),
          trend: 'up',
          magnitude: domain.recency,
        });
      });
    }
    
    return insights;
  }

  /**
   * Generate Project-specific feed insights
   */
  private generateProjectInsights(projectsData: any, userId: string, timeframe: string): FeedItem[] {
    const insights: FeedItem[] = [];
    
    // Check for deployment evidence
    if (!projectsData.deploymentEvidence || projectsData.deploymentEvidence < 50) {
      insights.push({
        feedId: this.generateFeedId(userId, 'projects', 'deployment'),
        userId,
        type: 'insight',
        title: 'Project deployment evidence would improve engineering maturity',
        description: `Deployment evidence is ${projectsData.deploymentEvidence || 0}%. Deploying projects with Docker will demonstrate production readiness.`,
        category: 'infrastructure',
        severity: 'warning',
        confidence: 80,
        evidence: [
          `Deployment evidence: ${projectsData.deploymentEvidence || 0}%`,
          `Engineering maturity: ${projectsData.engineeringMaturity}%`,
          `Infrastructure sophistication: ${projectsData.infrastructureSophistication}%`
        ],
        timestamp: new Date(),
        trend: 'unknown',
        magnitude: 0,
      });
    }
    
    // Check for system-design maturity
    if (projectsData.systemDesignSignals) {
      const signals = projectsData.systemDesignSignals;
      const signalCount = Object.values(signals).filter(Boolean).length;
      
      if (signalCount >= 4) {
        insights.push({
          feedId: this.generateFeedId(userId, 'projects', 'system-design'),
          userId,
          type: 'acceleration',
          title: 'System-design maturity accelerating rapidly',
          description: `Detected ${signalCount} system-design signals (caching, queues, deployment, monitoring). Strong infrastructure progression.`,
          category: 'infrastructure',
          severity: 'info',
          confidence: 85,
          evidence: [
            `Infrastructure sophistication: ${projectsData.infrastructureSophistication}%`,
            `Signal count: ${signalCount}`,
            `Engineering maturity: ${projectsData.engineeringMaturity}%`
          ],
          timestamp: new Date(),
          trend: 'up',
          magnitude: signalCount * 15,
        });
      }
    }
    
    // Check for stale GitHub signals
    if (projectsData.providerFreshness) {
      const githubFreshness = projectsData.providerFreshness.github;
      if (githubFreshness && githubFreshness.freshness < 50) {
        insights.push({
          feedId: this.generateFeedId(userId, 'projects', 'stale-github'),
          userId,
          type: 'stagnation',
          title: 'Project maturity confidence reduced due to stale GitHub signals',
          description: `GitHub signals are ${githubFreshness.freshness}% fresh. Recent commits or activity would improve confidence.`,
          category: 'projects',
          severity: 'warning',
          confidence: 75,
          evidence: [
            `GitHub freshness: ${githubFreshness.freshness}%`,
            `Project credibility: ${projectsData.projectCredibilityScore}%`,
            `Last updated: ${githubFreshness.lastUpdated}`
          ],
          timestamp: new Date(),
          trend: 'down',
          magnitude: -(100 - githubFreshness.freshness),
        });
      }
    }
    
    return insights;
  }

  /**
   * Generate Roadmap-specific feed insights
   */
  private generateRoadmapInsights(roadmapData: any, userId: string, timeframe: string): FeedItem[] {
    const insights: FeedItem[] = [];
    
    // Check for roadmap blockers
    if (roadmapData.missingDependencies && roadmapData.missingDependencies.length > 0) {
      const criticalDeps = roadmapData.missingDependencies.filter((d: any) => d.importance === 'high');
      
      if (criticalDeps.length > 0) {
        insights.push({
          feedId: this.generateFeedId(userId, 'roadmap', 'blockers'),
          userId,
          type: 'insight',
          title: `Roadmap progression blocked by ${criticalDeps.length} critical dependencies`,
          description: criticalDeps.map((d: any) => d.nodeId).join(', ') + ' are blocking roadmap advancement.',
          category: 'roadmap',
          severity: 'critical',
          confidence: 90,
          evidence: [
            `Missing dependencies: ${roadmapData.missingDependencies.length}`,
            `Critical dependencies: ${criticalDeps.length}`,
            `Verified nodes: ${roadmapData.verifiedNodes.length}`
          ],
          timestamp: new Date(),
          trend: 'unknown',
          magnitude: 0,
        });
      }
    }
    
    // Check for roadmap verification progress
    if (roadmapData.verifiedNodes && roadmapData.verifiedNodes.length > 0) {
      const recentVerifications = roadmapData.verifiedNodes.filter((n: any) => {
        const verifiedAt = new Date(n.verifiedAt);
        const daysSinceVerification = (Date.now() - verifiedAt.getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceVerification <= 7;
      });
      
      if (recentVerifications.length >= 3) {
        insights.push({
          feedId: this.generateFeedId(userId, 'roadmap', 'verification-progress'),
          userId,
          type: 'acceleration',
          title: 'Roadmap verification progressing rapidly',
          description: `${recentVerifications.length} skill nodes verified in the past week. Strong progression momentum.`,
          category: 'roadmap',
          severity: 'info',
          confidence: 85,
          evidence: [
            `Recent verifications: ${recentVerifications.length}`,
            `Total verified nodes: ${roadmapData.verifiedNodes.length}`,
            `Confidence: ${roadmapData.confidenceScore}%`
          ],
          timestamp: new Date(),
          trend: 'up',
          magnitude: recentVerifications.length * 20,
        });
      }
    }
    
    return insights;
  }

  /**
   * Generate Benchmark-specific feed insights
   */
  private generateBenchmarkInsights(benchmarksData: any, userId: string, timeframe: string): FeedItem[] {
    const insights: FeedItem[] = [];
    
    // Check for percentile improvements
    if (benchmarksData.percentileRankings && benchmarksData.relativeComparisons) {
      const improvedMetrics = benchmarksData.relativeComparisons.filter((r: any) => 
        r.interpretation === 'above_average'
      );
      
      if (improvedMetrics.length >= 2) {
        insights.push({
          feedId: this.generateFeedId(userId, 'benchmark', 'percentile-improvement'),
          userId,
          type: 'acceleration',
          title: 'Backend cohort percentile improved after recent progress',
          description: `${improvedMetrics.length} metrics are above cohort average. Strong relative performance.`,
          category: 'benchmark',
          severity: 'info',
          confidence: 80,
          evidence: improvedMetrics.map((m: any) => `${m.metric}: ${m.cohortPercentile}%`),
          timestamp: new Date(),
          trend: 'up',
          magnitude: improvedMetrics.length * 15,
        });
      }
    }
    
    // Check for low percentile metrics
    if (benchmarksData.relativeComparisons) {
      const lowMetrics = benchmarksData.relativeComparisons.filter((r: any) => 
        r.interpretation === 'below_average' && r.gapToAverage < -20
      );
      
      if (lowMetrics.length > 0) {
        insights.push({
          feedId: this.generateFeedId(userId, 'benchmark', 'percentile-gap'),
          userId,
          type: 'insight',
          title: 'Cohort percentile gap detected in key metrics',
          description: lowMetrics.map((m: any) => `${m.metric} is ${m.gapToAverage}% below average`).join('. '),
          category: 'benchmark',
          severity: 'warning',
          confidence: 75,
          evidence: lowMetrics.map((m: any) => `${m.metric}: ${m.cohortPercentile}%`),
          timestamp: new Date(),
          trend: 'down',
          magnitude: -Math.abs(lowMetrics[0]?.gapToAverage || 0),
        });
      }
    }
    
    return insights;
  }

  /**
   * Generate snapshot-based insights (compare with previous snapshots)
   */
  private async generateSnapshotInsights(userId: string): Promise<FeedItem[]> {
    const insights: FeedItem[] = [];
    
    // Get user's snapshots
    const userSnapshots = await SnapshotVersioningSystem.getUserSnapshots(userId, { modelType: 'core', limit: 2 });
    
    if (userSnapshots.length >= 2) {
      const latest = userSnapshots[0];
      const previous = userSnapshots[1];
      
      // Compare overall scores
      const latestScore = latest.data.overallScore || 0;
      const previousScore = previous.data.overallScore || 0;
      const scoreChange = latestScore - previousScore;
      
      if (scoreChange > 10) {
        insights.push({
          feedId: this.generateFeedId(userId, 'snapshot', 'score-improvement'),
          userId,
          type: 'acceleration',
          title: `Overall readiness score improved by ${scoreChange.toFixed(1)}%`,
          description: `Readiness score increased from ${previousScore}% to ${latestScore}% since last snapshot.`,
          category: 'roadmap',
          severity: 'info',
          confidence: 90,
          evidence: [
            `Previous score: ${previousScore}%`,
            `Current score: ${latestScore}%`,
            `Change: +${scoreChange.toFixed(1)}%`
          ],
          timestamp: new Date(),
          trend: 'up',
          magnitude: scoreChange,
        });
      } else if (scoreChange < -5) {
        insights.push({
          feedId: this.generateFeedId(userId, 'snapshot', 'score-regression'),
          userId,
          type: 'regression',
          title: `Overall readiness score decreased by ${Math.abs(scoreChange).toFixed(1)}%`,
          description: `Readiness score decreased from ${previousScore}% to ${latestScore}% since last snapshot.`,
          category: 'roadmap',
          severity: 'warning',
          confidence: 85,
          evidence: [
            `Previous score: ${previousScore}%`,
            `Current score: ${latestScore}%`,
            `Change: ${scoreChange.toFixed(1)}%`
          ],
          timestamp: new Date(),
          trend: 'down',
          magnitude: scoreChange,
        });
      }
    }
    
    return insights;
  }

  /**
   * Sort feed by recency and severity
   */
  private sortFeed(feed: FeedItem[]): FeedItem[] {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    
    return feed.sort((a, b) => {
      // First sort by severity
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      
      // Then sort by timestamp (most recent first)
      return b.timestamp.getTime() - a.timestamp.getTime();
    });
  }

  /**
   * Generate unique feed ID
   */
  private generateFeedId(userId: string, category: string, identifier: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${userId}-${category}-${identifier}-${timestamp}-${random}`;
  }
}

export const AdaptiveReadinessFeed = new AdaptiveReadinessFeedClass();
