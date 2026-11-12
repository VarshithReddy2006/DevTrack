import { TrendInput, TrendStatus } from '../types/dsa.types';

export class TrendEngine {
  /**
   * Calculate trend status based on:
   * - Recent activity pattern
   * - Current streak
   * - Hard problem growth trend
   * 
   * Returns: 'improving' | 'stable' | 'declining'
   */
  calculateTrend(input: TrendInput): TrendStatus {
    const { recentActivity, currentStreak, hardGrowthTrend } = input;

    // Calculate individual trend scores
    const activityTrend = this.calculateActivityTrend(recentActivity);
    const streakTrend = this.calculateStreakTrend(currentStreak);
    const hardGrowthTrendScore = this.calculateHardGrowthTrend(hardGrowthTrend);

    // Aggregate trend scores
    const trendScore = (activityTrend + streakTrend + hardGrowthTrendScore) / 3;

    // Determine overall trend status
    if (trendScore >= 0.3) return 'improving';
    if (trendScore >= -0.3) return 'stable';
    return 'declining';
  }

  /**
   * Calculate activity trend from recent activity array
   * Returns a score between -1 (declining) to 1 (improving)
   */
  private calculateActivityTrend(recentActivity: number[]): number {
    if (recentActivity.length < 2) return 0;

    const windowDays = Math.floor(recentActivity.length / 2);
    const previous = recentActivity.slice(0, windowDays).reduce((sum, solves) => sum + solves, 0);
    const recent = recentActivity.slice(-windowDays).reduce((sum, solves) => sum + solves, 0);
    return (recent - previous) / Math.max(1, recent, previous);
  }

  /**
   * Calculate streak trend
   * Returns a score between -1 (declining) to 1 (improving)
   */
  private calculateStreakTrend(currentStreak: number): number {
    // High current streak indicates improving trend
    if (currentStreak >= 30) return 1;
    if (currentStreak >= 14) return 0.7;
    if (currentStreak >= 7) return 0.4;
    if (currentStreak >= 3) return 0.1;
    return 0;
  }

  /**
   * Calculate hard growth trend
   * Returns a score between -1 (declining) to 1 (improving)
   */
  private calculateHardGrowthTrend(hardGrowthTrend: number): number {
    // Hard growth trend is already normalized to -1 to 1
    return hardGrowthTrend;
  }
}

export const trendEngine = new TrendEngine();
