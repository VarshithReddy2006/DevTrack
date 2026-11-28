import { ConfidenceScoreInput } from '../types/dsa.types';

export class ConfidenceEngine {
  /**
   * Calculate confidence score based on:
   * - Data freshness
   * - Verified source
   * - Problem count
   * - Recent activity
   * 
   * Returns a score between 0-100
   */
  calculateConfidenceScore(input: ConfidenceScoreInput): number {
    const { lastSyncedAt, isVerified, totalSolved, lastSolvedDate, platform } = input;
    if (totalSolved <= 0) return 0;

    // 1. Data Freshness Score (30% weight)
    const freshnessScore = this.calculateFreshnessScore(lastSyncedAt);

    // 2. Verification Score (25% weight)
    const verificationScore = this.calculateVerificationScore(isVerified, platform);

    // 3. Problem Count Score (25% weight)
    const problemCountScore = this.calculateProblemCountScore(totalSolved);

    // 4. Recent Activity Score (20% weight)
    const activityScore = this.calculateRecentActivityScore(lastSolvedDate);

    // Weighted aggregation
    const totalScore = 
      (freshnessScore * 0.3) +
      (verificationScore * 0.25) +
      (problemCountScore * 0.25) +
      (activityScore * 0.2);

    return Math.min(100, Math.max(0, Math.round(totalScore)));
  }

  /**
   * Calculate data freshness score
   * Based on how recently data was synced
   */
  private calculateFreshnessScore(lastSyncedAt: Date | null): number {
    if (!lastSyncedAt) return 0;

    const now = new Date();
    const hoursSinceSync = Math.floor((now.getTime() - lastSyncedAt.getTime()) / (1000 * 60 * 60));

    // Score decreases as time since sync increases
    if (hoursSinceSync < 1) return 100;  // Synced within last hour
    if (hoursSinceSync < 6) return 95;   // Synced within 6 hours
    if (hoursSinceSync < 12) return 85;  // Synced within 12 hours
    if (hoursSinceSync < 24) return 70;  // Synced within 24 hours
    if (hoursSinceSync < 48) return 50;  // Synced within 2 days
    if (hoursSinceSync < 72) return 30;  // Synced within 3 days
    if (hoursSinceSync < 168) return 15; // Synced within a week
    return 5; // Synced more than a week ago
  }

  /**
   * Calculate verification score
   * Based on whether source is verified and platform type
   */
  private calculateVerificationScore(isVerified: boolean, platform: string): number {
    let score = 0;

    // Platform trustworthiness
    if (platform === 'leetcode') score += 50;
    else if (platform === 'codeforces') score += 45;
    else if (platform === 'manual') score += 20;

    // Verification bonus
    if (isVerified) score += 50;

    return Math.min(100, score);
  }

  /**
   * Calculate problem count score
   * Based on total problems solved (more problems = higher confidence)
   */
  private calculateProblemCountScore(totalSolved: number): number {
    if (totalSolved === 0) return 0;

    // More problems solved = higher confidence in data accuracy
    if (totalSolved >= 500) return 100;
    if (totalSolved >= 200) return 90;
    if (totalSolved >= 100) return 80;
    if (totalSolved >= 50) return 65;
    if (totalSolved >= 25) return 50;
    if (totalSolved >= 10) return 35;
    if (totalSolved >= 5) return 20;
    return 10; // Very few problems
  }

  /**
   * Calculate recent activity score
   * Based on how recently problems were solved
   */
  private calculateRecentActivityScore(lastSolvedDate: Date | null): number {
    if (!lastSolvedDate) return 0;

    const now = new Date();
    const daysSinceLastSolve = Math.floor((now.getTime() - lastSolvedDate.getTime()) / (1000 * 60 * 60 * 24));

    // Score decreases as days since last solve increases
    if (daysSinceLastSolve === 0) return 100; // Solved today
    if (daysSinceLastSolve === 1) return 90;  // Solved yesterday
    if (daysSinceLastSolve <= 3) return 75;   // Solved within 3 days
    if (daysSinceLastSolve <= 7) return 55;   // Solved within a week
    if (daysSinceLastSolve <= 14) return 35;  // Solved within 2 weeks
    if (daysSinceLastSolve <= 30) return 20;  // Solved within a month
    return 5; // Solved more than a month ago
  }
}

export const confidenceEngine = new ConfidenceEngine();
