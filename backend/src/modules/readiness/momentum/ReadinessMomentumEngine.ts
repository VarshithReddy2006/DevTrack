import { SnapshotVersioningSystem } from '../../operations/index.js';
import { logger } from '../../../shared/logger.js';

export interface MomentumInput {
  userId: string;
  timeframe?: 'week' | 'month' | 'quarter';
}

export interface MomentumAnalysis {
  userId: string;
  overallMomentum: number; // -100 to 100
  momentumState: 'accelerating' | 'stagnating' | 'regressing' | 'stable';
  components: MomentumComponent[];
  insights: MomentumInsight[];
  trajectory: TrajectoryPoint[];
  learningCadence: LearningCadence;
  timestamp: Date;
}

export interface MomentumComponent {
  component: string;
  currentScore: number;
  previousScore: number;
  change: number;
  velocity: number; // score change per day
  acceleration: number; // velocity change per day
  momentum: number; // -100 to 100
  trend: 'up' | 'down' | 'stable';
}

export interface MomentumInsight {
  type: 'acceleration' | 'stagnation' | 'regression' | 'consistency' | 'breakthrough';
  component: string;
  description: string;
  magnitude: number;
  confidence: number;
  timeframe: string;
}

export interface TrajectoryPoint {
  timestamp: Date;
  score: number;
  component: string;
}

export interface LearningCadence {
  averageActivityPerDay: number;
  consistencyScore: number; // 0-100
  peakActivityTime: string;
  activeDays: number;
  totalDays: number;
  streak: number;
}

class ReadinessMomentumEngineClass {
  private trajectoryCache: Map<string, TrajectoryPoint[]> = new Map();

  /**
   * Analyze readiness momentum
   */
  async analyzeMomentum(input: MomentumInput): Promise<MomentumAnalysis> {
    const { userId, timeframe = 'month' } = input;
    
    try {
      logger.info('[ReadinessMomentumEngine] Analyzing momentum', { userId, timeframe });
      
      const relevantSnapshots = (await SnapshotVersioningSystem.getUserSnapshots(userId, {
        modelType: 'core',
        since: this.getCutoffDate(timeframe),
      })).reverse();
      
      if (relevantSnapshots.length < 2) {
        // Not enough data for momentum analysis
        return this.generateDefaultMomentum(userId);
      }
      
      // Calculate momentum components
      const components = this.calculateMomentumComponents(relevantSnapshots);
      
      // Calculate overall momentum
      const overallMomentum = this.calculateOverallMomentum(components);
      
      // Determine momentum state
      const momentumState = this.determineMomentumState(overallMomentum);
      
      // Generate insights
      const insights = this.generateMomentumInsights(components, timeframe);
      
      // Build trajectory
      const trajectory = this.buildTrajectory(relevantSnapshots);
      
      // Calculate learning cadence
      const learningCadence = this.calculateLearningCadence(relevantSnapshots);
      
      const analysis: MomentumAnalysis = {
        userId,
        overallMomentum,
        momentumState,
        components,
        insights,
        trajectory,
        learningCadence,
        timestamp: new Date(),
      };
      
      logger.info('[ReadinessMomentumEngine] Momentum analysis completed', { 
        userId, 
        overallMomentum,
        momentumState 
      });
      
      return analysis;
    } catch (error) {
      logger.error('[ReadinessMomentumEngine] Failed to analyze momentum', { userId, error });
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
      default:
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Calculate momentum components
   */
  private calculateMomentumComponents(snapshots: any[]): MomentumComponent[] {
    const components: MomentumComponent[] = [];
    const componentNames = ['dsa', 'skills', 'projects', 'roadmap', 'overall'];
    
    componentNames.forEach(componentName => {
      const scores = snapshots
        .map(s => s.data[componentName] || s.data.overallScore || 0)
        .filter(s => s > 0);
      
      if (scores.length < 2) return;
      
      const currentScore = scores[scores.length - 1];
      const previousScore = scores[scores.length - 2];
      const change = currentScore - previousScore;
      
      // Calculate time span in days
      const timeSpanDays = this.getTimeSpanDays(snapshots);
      
      // Velocity: score change per day
      const velocity = change / timeSpanDays;
      
      // Acceleration: change in velocity (need at least 3 points)
      let acceleration = 0;
      if (scores.length >= 3) {
        const prevVelocity = (scores[scores.length - 2] - scores[scores.length - 3]) / timeSpanDays;
        acceleration = (velocity - prevVelocity) / timeSpanDays;
      }
      
      // Momentum: combination of velocity and acceleration
      const momentum = Math.min(100, Math.max(-100, (velocity * 10) + (acceleration * 50)));
      
      // Determine trend
      let trend: 'up' | 'down' | 'stable' = 'stable';
      if (change > 5) trend = 'up';
      else if (change < -5) trend = 'down';
      
      components.push({
        component: componentName,
        currentScore,
        previousScore,
        change,
        velocity,
        acceleration,
        momentum,
        trend,
      });
    });
    
    return components;
  }

  /**
   * Get time span in days between snapshots
   */
  private getTimeSpanDays(snapshots: any[]): number {
    if (snapshots.length < 2) return 1;
    const first = snapshots[0].metadata.createdAt;
    const last = snapshots[snapshots.length - 1].metadata.createdAt;
    const diffMs = last.getTime() - first.getTime();
    return Math.max(1, diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * Calculate overall momentum from components
   */
  private calculateOverallMomentum(components: MomentumComponent[]): number {
    if (components.length === 0) return 0;
    
    // Weight overall component more heavily
    const weightedSum = components.reduce((sum, comp) => {
      const weight = comp.component === 'overall' ? 2 : 1;
      return sum + comp.momentum * weight;
    }, 0);
    
    const totalWeight = components.reduce((sum, comp) => {
      const weight = comp.component === 'overall' ? 2 : 1;
      return sum + weight;
    }, 0);
    
    return Math.round(weightedSum / totalWeight);
  }

  /**
   * Determine momentum state
   */
  private determineMomentumState(momentum: number): 'accelerating' | 'stagnating' | 'regressing' | 'stable' {
    if (momentum > 20) return 'accelerating';
    if (momentum < -20) return 'regressing';
    if (momentum > 5) return 'stable';
    return 'stagnating';
  }

  /**
   * Generate momentum insights
   */
  private generateMomentumInsights(components: MomentumComponent[], timeframe: string): MomentumInsight[] {
    const insights: MomentumInsight[] = [];
    
    components.forEach(comp => {
      // Acceleration insight
      if (comp.acceleration > 0.5) {
        insights.push({
          type: 'acceleration',
          component: comp.component,
          description: `${comp.component.charAt(0).toUpperCase() + comp.component.slice(1)} maturity accelerating rapidly`,
          magnitude: comp.acceleration,
          confidence: Math.min(95, 70 + comp.acceleration * 20),
          timeframe,
        });
      }
      
      // Stagnation insight
      if (Math.abs(comp.change) < 2 && comp.trend === 'stable') {
        insights.push({
          type: 'stagnation',
          component: comp.component,
          description: `${comp.component.charAt(0).toUpperCase() + comp.component.slice(1)} progression plateau detected`,
          magnitude: comp.change,
          confidence: 75,
          timeframe,
        });
      }
      
      // Regression insight
      if (comp.change < -10) {
        insights.push({
          type: 'regression',
          component: comp.component,
          description: `${comp.component.charAt(0).toUpperCase() + comp.component.slice(1)} score decreased by ${Math.abs(comp.change).toFixed(1)}%`,
          magnitude: comp.change,
          confidence: 85,
          timeframe,
        });
      }
      
      // Breakthrough insight
      if (comp.change > 15) {
        insights.push({
          type: 'breakthrough',
          component: comp.component,
          description: `${comp.component.charAt(0).toUpperCase() + comp.component.slice(1)} exposure increasing steadily`,
          magnitude: comp.change,
          confidence: 90,
          timeframe,
        });
      }
    });
    
    // Consistency insight
    const consistentComponents = components.filter(c => c.trend === 'up' && c.velocity > 0);
    if (consistentComponents.length >= 3) {
      insights.push({
        type: 'consistency',
        component: 'overall',
        description: 'Consistent positive momentum across multiple areas',
        magnitude: consistentComponents.length * 5,
        confidence: 85,
        timeframe,
      });
    }
    
    return insights;
  }

  /**
   * Build trajectory from snapshots
   */
  private buildTrajectory(snapshots: any[]): TrajectoryPoint[] {
    const trajectory: TrajectoryPoint[] = [];
    
    snapshots.forEach(snapshot => {
      const data = snapshot.data;
      const components = ['dsa', 'skills', 'projects', 'roadmap', 'overall'];
      
      components.forEach(component => {
        const score = data[component] || data.overallScore || 0;
        if (score > 0) {
          trajectory.push({
            timestamp: snapshot.metadata.createdAt,
            score,
            component,
          });
        }
      });
    });
    
    // Sort by timestamp
    return trajectory.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Calculate learning cadence
   */
  private calculateLearningCadence(snapshots: any[]): LearningCadence {
    if (snapshots.length === 0) {
      return {
        averageActivityPerDay: 0,
        consistencyScore: 0,
        peakActivityTime: 'Unknown',
        activeDays: 0,
        totalDays: 0,
        streak: 0,
      };
    }
    
    const timeSpanDays = this.getTimeSpanDays(snapshots);
    const activeDays = snapshots.length;
    
    // Calculate average activity per day
    const averageActivityPerDay = activeDays / timeSpanDays;
    
    // Calculate consistency score (how evenly distributed snapshots are)
    const expectedInterval = timeSpanDays / activeDays;
    const intervals: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const diff = snapshots[i].metadata.createdAt.getTime() - snapshots[i - 1].metadata.createdAt.getTime();
      intervals.push(diff / (1000 * 60 * 60 * 24));
    }
    
    const avgInterval = intervals.length > 0 ? intervals.reduce((sum, i) => sum + i, 0) / intervals.length : 0;
    const variance = intervals.length > 0 
      ? intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length
      : 0;
    const consistencyScore = Math.max(0, 100 - (variance / expectedInterval) * 100);
    
    // Determine peak activity time (mock - would need actual activity timestamps)
    const peakActivityTime = 'Afternoon'; // Default
    
    // Calculate streak (consecutive days with activity)
    let streak = 0;
    let maxStreak = 0;
    for (let i = 1; i < snapshots.length; i++) {
      const diff = snapshots[i].metadata.createdAt.getTime() - snapshots[i - 1].metadata.createdAt.getTime();
      const daysDiff = diff / (1000 * 60 * 60 * 24);
      if (daysDiff <= 1.5) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 0;
      }
    }
    
    return {
      averageActivityPerDay: Math.round(averageActivityPerDay * 100) / 100,
      consistencyScore: Math.round(consistencyScore),
      peakActivityTime,
      activeDays,
      totalDays: Math.round(timeSpanDays),
      streak: maxStreak,
    };
  }

  /**
   * Generate default momentum when insufficient data
   */
  private generateDefaultMomentum(userId: string): MomentumAnalysis {
    return {
      userId,
      overallMomentum: 0,
      momentumState: 'stable',
      components: [],
      insights: [],
      trajectory: [],
      learningCadence: {
        averageActivityPerDay: 0,
        consistencyScore: 0,
        peakActivityTime: 'Unknown',
        activeDays: 0,
        totalDays: 0,
        streak: 0,
      },
      timestamp: new Date(),
    };
  }

  /**
   * Get topic-specific momentum
   */
  getTopicMomentum(userId: string, topic: string): MomentumComponent | null {
    const trajectory = this.trajectoryCache.get(userId);
    if (!trajectory) return null;
    
    const topicTrajectory = trajectory.filter(t => t.component === topic);
    if (topicTrajectory.length < 2) return null;
    
    const currentScore = topicTrajectory[topicTrajectory.length - 1].score;
    const previousScore = topicTrajectory[topicTrajectory.length - 2].score;
    const change = currentScore - previousScore;
    
    const timeSpanDays = Math.max(1, 
      (topicTrajectory[topicTrajectory.length - 1].timestamp.getTime() - 
       topicTrajectory[0].timestamp.getTime()) / (1000 * 60 * 60 * 24)
    );
    
    const velocity = change / timeSpanDays;
    const momentum = Math.min(100, Math.max(-100, velocity * 10));
    
    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (change > 5) trend = 'up';
    else if (change < -5) trend = 'down';
    
    return {
      component: topic,
      currentScore,
      previousScore,
      change,
      velocity,
      acceleration: 0,
      momentum,
      trend,
    };
  }
}

export const ReadinessMomentumEngine = new ReadinessMomentumEngineClass();
