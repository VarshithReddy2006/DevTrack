import { SnapshotVersioningSystem } from '../../operations/SnapshotVersioningSystem.js';
import { logger } from '../../../shared/logger.js';

export interface TimelineInput {
  userId: string;
  timeframe?: 'week' | 'month' | 'quarter' | 'year';
}

export interface EvolutionTimeline {
  userId: string;
  milestones: TimelineMilestone[];
  progressionEvents: ProgressionEvent[];
  skillEvolution: SkillEvolutionPoint[];
  infrastructureEvolution: InfrastructureEvolutionPoint[];
  overallTrajectory: TrajectoryPoint[];
  summary: TimelineSummary;
  timestamp: Date;
}

export interface TimelineMilestone {
  milestoneId: string;
  timestamp: Date;
  type: 'verification' | 'deployment' | 'achievement' | 'breakthrough';
  title: string;
  description: string;
  impact: string;
  category: 'dsa' | 'skills' | 'projects' | 'infrastructure' | 'roadmap' | 'benchmark';
}

export interface ProgressionEvent {
  eventId: string;
  timestamp: Date;
  eventType: 'state-transition' | 'milestone' | 'improvement' | 'regression';
  description: string;
  previousValue: number;
  newValue: number;
  component: string;
}

export interface SkillEvolutionPoint {
  timestamp: Date;
  skill: string;
  score: number;
  change: number;
  verificationStatus: 'verified' | 'in-progress' | 'not-started';
}

export interface InfrastructureEvolutionPoint {
  timestamp: Date;
  component: string;
  status: 'added' | 'removed' | 'improved';
  impact: string;
}

export interface TrajectoryPoint {
  timestamp: Date;
  overallScore: number;
  dsaScore: number;
  skillsScore: number;
  projectsScore: number;
  infrastructureScore: number;
}

export interface TimelineSummary {
  totalMilestones: number;
  verifiedSkills: number;
  infrastructureComponentsAdded: number;
  overallImprovement: number;
  mostActivePeriod: string;
  keyAchievements: string[];
}

export class EngineeringEvolutionTimelineClass {
  /**
   * Generate engineering evolution timeline
   */
  async generateTimeline(input: TimelineInput): Promise<EvolutionTimeline> {
    const { userId, timeframe = 'month' } = input;
    
    try {
      logger.info('[EngineeringEvolutionTimeline] Generating timeline', { userId, timeframe });
      
      const relevantSnapshots = (await SnapshotVersioningSystem.getUserSnapshots(userId, {
        modelType: 'core',
        since: this.getCutoffDate(timeframe),
      })).reverse();
      
      // Generate milestones
      const milestones = this.generateMilestones(relevantSnapshots);
      
      // Generate progression events
      const progressionEvents = this.generateProgressionEvents(relevantSnapshots);
      
      // Generate skill evolution
      const skillEvolution = this.generateSkillEvolution(relevantSnapshots);
      
      // Generate infrastructure evolution
      const infrastructureEvolution = this.generateInfrastructureEvolution(relevantSnapshots);
      
      // Generate overall trajectory
      const overallTrajectory = this.generateOverallTrajectory(relevantSnapshots);
      
      // Generate summary
      const summary = this.generateSummary(milestones, skillEvolution, infrastructureEvolution, overallTrajectory);
      
      const timeline: EvolutionTimeline = {
        userId,
        milestones,
        progressionEvents,
        skillEvolution,
        infrastructureEvolution,
        overallTrajectory,
        summary,
        timestamp: new Date(),
      };
      
      logger.info('[EngineeringEvolutionTimeline] Timeline generated', { 
        userId, 
        milestoneCount: milestones.length,
        eventCount: progressionEvents.length 
      });
      
      return timeline;
    } catch (error) {
      logger.error('[EngineeringEvolutionTimeline] Failed to generate timeline', { userId, error });
      throw error;
    }
  }

  /**
   * Get cutoff date for timeframe
   */
  private getCutoffDate(timeframe: string): Date {
    const now = new Date();
    switch (timeframe) {
      case 'week':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case 'month':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case 'quarter':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      case 'year':
        return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Generate milestones from snapshots
   */
  private generateMilestones(snapshots: any[]): TimelineMilestone[] {
    const milestones: TimelineMilestone[] = [];
    
    snapshots.forEach((snapshot, index) => {
      const data = snapshot.data;
      const metadata = snapshot.metadata;
      
      // Check for Redis verification
      if (data.projects?.systemDesignSignals?.hasRedis) {
        const existingRedis = milestones.find(m => m.title === 'Redis caching verified');
        if (!existingRedis) {
          milestones.push({
            milestoneId: this.generateMilestoneId('redis', metadata.createdAt),
            timestamp: metadata.createdAt,
            type: 'verification',
            title: 'Redis caching verified',
            description: 'Redis caching detected in project infrastructure',
            impact: 'Infrastructure sophistication improved by ~15%',
            category: 'infrastructure',
          });
        }
      }
      
      // Check for Docker deployment
      if (data.projects?.systemDesignSignals?.hasDocker) {
        const existingDocker = milestones.find(m => m.title === 'Docker deployment verified');
        if (!existingDocker) {
          milestones.push({
            milestoneId: this.generateMilestoneId('docker', metadata.createdAt),
            timestamp: metadata.createdAt,
            type: 'deployment',
            title: 'Docker deployment verified',
            description: 'Docker deployment detected in project infrastructure',
            impact: 'Deployment maturity improved by ~20%',
            category: 'infrastructure',
          });
        }
      }
      
      // Check for Graph mastery improvement
      if (data.dsa?.topics) {
        const graphTopic = data.dsa.topics.find((t: any) =>
          (t.name ?? t.topicName ?? '').toLowerCase().includes('graph') && t.masteryLevel >= 70);
        if (graphTopic && graphTopic.masteryLevel >= 70) {
          const existingGraph = milestones.find(m => m.title === 'Graph mastery achieved');
          if (!existingGraph) {
            milestones.push({
              milestoneId: this.generateMilestoneId('graph', metadata.createdAt),
              timestamp: metadata.createdAt,
              type: 'achievement',
              title: 'Graph mastery achieved',
              description: `Graph topic mastery reached ${graphTopic.masteryLevel}%`,
              impact: 'DSA readiness significantly improved',
              category: 'dsa',
            });
          }
        }
      }
      
      // Check for percentile improvement
      if (data.benchmarks?.relativeComparisons) {
        const aboveAverage = data.benchmarks.relativeComparisons.filter((r: any) => r.interpretation === 'above_average');
        if (aboveAverage.length >= 3) {
          const existingPercentile = milestones.find(m => m.title === 'Percentile breakthrough');
          if (!existingPercentile) {
            milestones.push({
              milestoneId: this.generateMilestoneId('percentile', metadata.createdAt),
              timestamp: metadata.createdAt,
              type: 'breakthrough',
              title: 'Percentile breakthrough',
              description: `${aboveAverage.length} metrics above cohort average`,
              impact: 'Strong relative performance improvement',
              category: 'benchmark',
            });
          }
        }
      }
      
      // Check for roadmap verification
      if (data.roadmap?.verifiedNodes && data.roadmap.verifiedNodes.length >= 10) {
        const existingRoadmap = milestones.find(m => m.title === 'Roadmap milestone: 10 skills verified');
        if (!existingRoadmap) {
          milestones.push({
            milestoneId: this.generateMilestoneId('roadmap-10', metadata.createdAt),
            timestamp: metadata.createdAt,
            type: 'achievement',
            title: 'Roadmap milestone: 10 skills verified',
            description: `${data.roadmap.verifiedNodes.length} skills verified in roadmap`,
            impact: 'Roadmap progression advanced significantly',
            category: 'roadmap',
          });
        }
      }
    });
    
    // Sort by timestamp
    return milestones.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Generate progression events
   */
  private generateProgressionEvents(snapshots: any[]): ProgressionEvent[] {
    const events: ProgressionEvent[] = [];
    
    for (let i = 1; i < snapshots.length; i++) {
      const previous = snapshots[i - 1];
      const current = snapshots[i];
      
      const prevData = previous.data;
      const currData = current.data;
      
      // Check for overall score change
      const prevOverall = prevData.overallScore || 0;
      const currOverall = currData.overallScore || 0;
      const overallChange = currOverall - prevOverall;
      
      if (Math.abs(overallChange) > 5) {
        events.push({
          eventId: this.generateEventId('overall', current.metadata.createdAt),
          timestamp: current.metadata.createdAt,
          eventType: overallChange > 0 ? 'improvement' : 'regression',
          description: `Overall readiness ${overallChange > 0 ? 'increased' : 'decreased'} by ${Math.abs(overallChange).toFixed(1)}%`,
          previousValue: prevOverall,
          newValue: currOverall,
          component: 'overall',
        });
      }
      
      // Check for infrastructure maturity change
      const prevInfra = prevData.projects?.infrastructureSophistication || 0;
      const currInfra = currData.projects?.infrastructureSophistication || 0;
      const infraChange = currInfra - prevInfra;
      
      if (Math.abs(infraChange) > 10) {
        events.push({
          eventId: this.generateEventId('infrastructure', current.metadata.createdAt),
          timestamp: current.metadata.createdAt,
          eventType: infraChange > 0 ? 'improvement' : 'regression',
          description: `Infrastructure maturity ${infraChange > 0 ? 'improved' : 'decreased'} by ${Math.abs(infraChange).toFixed(1)}%`,
          previousValue: prevInfra,
          newValue: currInfra,
          component: 'infrastructure',
        });
      }
      
      // Check for system-design evolution
      const prevSignals = prevData.projects?.systemDesignSignals || {};
      const currSignals = currData.projects?.systemDesignSignals || {};
      
      const newSignals = Object.keys(currSignals).filter(key => currSignals[key] && !prevSignals[key]);
      newSignals.forEach(signal => {
        events.push({
          eventId: this.generateEventId(`signal-${signal}`, current.metadata.createdAt),
          timestamp: current.metadata.createdAt,
          eventType: 'improvement',
          description: `System-design signal added: ${signal}`,
          previousValue: 0,
          newValue: 1,
          component: 'system-design',
        });
      });
    }
    
    return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Generate skill evolution
   */
  private generateSkillEvolution(snapshots: any[]): SkillEvolutionPoint[] {
    const evolution: SkillEvolutionPoint[] = [];
    
    snapshots.forEach(snapshot => {
      const data = snapshot.data;
      const timestamp = snapshot.metadata.createdAt;
      
      // Extract skill evolution from roadmap
      if (data.roadmap?.verifiedNodes) {
        data.roadmap.verifiedNodes.forEach((node: any) => {
          evolution.push({
            timestamp,
            skill: node.nodeId,
            score: 100, // Verified = 100
            change: 0, // Would need previous state to calculate change
            verificationStatus: 'verified',
          });
        });
      }
      
      // Extract skill evolution from skills data
      if (data.skills?.domains) {
        data.skills.domains.forEach((domain: any) => {
          evolution.push({
            timestamp,
            skill: domain.name,
            score: domain.maturity,
            change: 0,
            verificationStatus: domain.maturity > 70 ? 'verified' : domain.maturity > 30 ? 'in-progress' : 'not-started',
          });
        });
      }
    });
    
    return evolution.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Generate infrastructure evolution
   */
  private generateInfrastructureEvolution(snapshots: any[]): InfrastructureEvolutionPoint[] {
    const evolution: InfrastructureEvolutionPoint[] = [];
    const previousSignals: Set<string> = new Set();
    
    snapshots.forEach(snapshot => {
      const data = snapshot.data;
      const timestamp = snapshot.metadata.createdAt;
      const currentSignals = data.projects?.systemDesignSignals || {};
      
      Object.entries(currentSignals).forEach(([signal, value]) => {
        if (value && !previousSignals.has(signal)) {
          evolution.push({
            timestamp,
            component: signal,
            status: 'added',
            impact: `Added ${signal} to infrastructure`,
          });
          previousSignals.add(signal);
        }
      });
    });
    
    return evolution.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Generate overall trajectory
   */
  private generateOverallTrajectory(snapshots: any[]): TrajectoryPoint[] {
    const trajectory: TrajectoryPoint[] = [];
    
    snapshots.forEach(snapshot => {
      const data = snapshot.data;
      const timestamp = snapshot.metadata.createdAt;
      
      trajectory.push({
        timestamp,
        overallScore: data.overallScore || 0,
        dsaScore: data.dsaScore ?? data.dsa?.overallEngineeringDepth ?? 0,
        skillsScore: data.skillsScore ?? data.skills?.overallEngineeringDepth ?? 0,
        projectsScore: data.projectsScore ?? data.projects?.engineeringMaturity ?? 0,
        infrastructureScore: data.infrastructureScore ?? data.projects?.infrastructureSophistication ?? 0,
      });
    });
    
    return trajectory.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Generate timeline summary
   */
  private generateSummary(
    milestones: TimelineMilestone[],
    skillEvolution: SkillEvolutionPoint[],
    infrastructureEvolution: InfrastructureEvolutionPoint[],
    overallTrajectory: TrajectoryPoint[]
  ): TimelineSummary {
    const verifiedSkills = skillEvolution.filter(s => s.verificationStatus === 'verified').length;
    const infrastructureComponentsAdded = infrastructureEvolution.filter(e => e.status === 'added').length;
    
    let overallImprovement = 0;
    if (overallTrajectory.length >= 2) {
      overallImprovement = overallTrajectory[overallTrajectory.length - 1].overallScore - overallTrajectory[0].overallScore;
    }
    
    // Determine most active period
    const eventCounts: Record<string, number> = {};
    milestones.forEach(m => {
      const period = this.getPeriod(m.timestamp);
      eventCounts[period] = (eventCounts[period] || 0) + 1;
    });
    
    const mostActivePeriod = Object.entries(eventCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
    
    // Extract key achievements
    const keyAchievements = milestones
      .filter(m => m.type === 'breakthrough' || m.type === 'achievement')
      .map(m => m.title)
      .slice(0, 5);
    
    return {
      totalMilestones: milestones.length,
      verifiedSkills,
      infrastructureComponentsAdded,
      overallImprovement: Math.round(overallImprovement),
      mostActivePeriod,
      keyAchievements,
    };
  }

  /**
   * Get period from timestamp
   */
  private getPeriod(timestamp: Date): string {
    const month = timestamp.toLocaleString('default', { month: 'long' });
    const year = timestamp.getFullYear();
    return `${month} ${year}`;
  }

  /**
   * Generate milestone ID
   */
  private generateMilestoneId(type: string, timestamp: Date): string {
    return `${type}-${timestamp.getTime()}`;
  }

  /**
   * Generate event ID
   */
  private generateEventId(type: string, timestamp: Date): string {
    return `${type}-${timestamp.getTime()}`;
  }
}

export const EngineeringEvolutionTimeline = new EngineeringEvolutionTimelineClass();
