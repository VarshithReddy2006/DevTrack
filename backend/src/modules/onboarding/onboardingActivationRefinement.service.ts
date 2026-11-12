// src/modules/onboarding/onboardingActivationRefinement.service.ts — Onboarding Activation Refinement Service
// Phase-K: Onboarding + Activation Refinement - Onboarding drop-offs, setup friction, progression comprehension, feature confusion, first-session activation, workspace understanding

import { OnboardingAnalytics } from '../../db/models/onboardingAnalytics.model.js';
import { numberOrZero, topDropOffs, type DropOffCount } from './onboardingMetricsAggregation.js';

interface RefinementTotals {
  totalStarted: number;
  totalCompleted: number;
  averageTimeToComplete: number | null;
  setupFriction: number;
  comprehension: number;
  confusionEvents: number;
  activated: number;
  workspaceUnderstanding: number;
}

export interface OnboardingRefinementMetrics {
  totalStarted: number;
  totalCompleted: number;
  completionRate: number;
  averageTimeToComplete: number;
  dropOffPoints: Array<{ step: string; count: number; percentage: number }>;
  setupFrictionScore: number; // 0-100, higher = more friction
  progressionComprehensionScore: number; // 0-100
  featureConfusionScore: number; // 0-100, higher = more confusion
  firstSessionActivationRate: number;
  workspaceUnderstandingScore: number; // 0-100
  recommendations: string[];
}

export const onboardingActivationRefinement = {
  // ─── Get Onboarding Refinement Metrics ───────────────────────────────────────
  async getOnboardingRefinementMetrics(dateRange: { start: Date; end: Date }): Promise<OnboardingRefinementMetrics> {
    const completed = { $ne: [{ $ifNull: ['$completedAt', null] }, null] };
    const firstAction = numberOrZero('$firstSessionMetrics.timeToFirstAction');
    const confusion = numberOrZero('$firstSessionMetrics.confusionEvents');
    const helpRequests = numberOrZero('$firstSessionMetrics.helpRequests');

    const hasSessionMetrics = { $ne: [{ $type: '$firstSessionMetrics' }, 'null'] };

    // The streak timing has no schema default. Only an absent value skips the bonus.
    const streakTime = '$earlyEngagement.timeToFirstStreak';
    const quickStreak = {
      $and: [
        { $ne: [{ $type: streakTime }, 'missing'] },
        { $lt: [streakTime, 1800000] },
      ],
    };

    const [result] = await OnboardingAnalytics.aggregate<{ totals: RefinementTotals[]; dropOffs: DropOffCount[] }>([
      { $match: { startedAt: { $gte: dateRange.start, $lte: dateRange.end } } },
      {
        $facet: {
          dropOffs: topDropOffs('$dropOffStep'),
          totals: [{
            $group: {
              _id: null,
              totalStarted: { $sum: 1 },
              totalCompleted: { $sum: { $cond: [completed, 1, 0] } },
              averageTimeToComplete: {
                $avg: {
                  $cond: [
                    { $and: [completed, { $ne: [numberOrZero('$totalDuration'), 0] }] },
                    '$totalDuration',
                    null,
                  ],
                },
              },
              setupFriction: {
                $avg: {
                  $add: [
                    { $multiply: [numberOrZero('$setupFriction.platformSyncIssues'), 10] },
                    { $multiply: [numberOrZero('$setupFriction.authenticationIssues'), 15] },
                    { $multiply: [numberOrZero('$setupFriction.configurationErrors'), 20] },
                    { $cond: [{ $gt: ['$setupFriction.totalSetupTime', 300000] }, 25, 0] },
                  ],
                },
              },
              comprehension: {
                $avg: {
                  $max: [0, {
                    $add: [
                      100,
                      { $multiply: [confusion, -5] },
                      { $multiply: [helpRequests, -3] },
                      {
                        $cond: [
                          hasSessionMetrics,
                          {
                            $add: [
                              { $cond: [{ $lt: [numberOrZero('$firstSessionMetrics.timeToFirstProblem'), 120000] }, 10, 0] },
                              { $cond: [{ $lt: [numberOrZero('$firstSessionMetrics.timeToFirstCompletion'), 300000] }, 15, 0] },
                            ],
                          },
                          0,
                        ],
                      },
                    ],
                  }],
                },
              },
              confusionEvents: { $avg: confusion },
              activated: { $sum: { $cond: [{ $gt: [firstAction, 0] }, 1, 0] } },
              workspaceUnderstanding: {
                $avg: {
                  $add: [
                    100,
                    { $cond: [{ $gt: [firstAction, 60000] }, -20, 0] },
                    { $cond: [{ $gt: ['$earlyEngagement.problemsAttemptedInFirstHour', 0] }, 15, 0] },
                    { $cond: [{ $gt: ['$earlyEngagement.problemsSolvedInFirstHour', 0] }, 20, 0] },
                    { $cond: [quickStreak, 15, 0] },
                  ],
                },
              },
            },
          }],
        },
      },
    ]);
    const totals = result?.totals[0];
    const totalStarted = totals?.totalStarted ?? 0;
    const totalCompleted = totals?.totalCompleted ?? 0;
    const completionRate = totalStarted ? (totalCompleted / totalStarted) * 100 : 0;
    const averageTimeToComplete = totals?.averageTimeToComplete ?? 0;
    const dropOffPoints = (result?.dropOffs ?? []).map(({ _id, count }) => ({
      step: _id,
      count,
      percentage: (count / totalStarted) * 100,
    }));
    const setupFrictionScore = Math.min(100, totals?.setupFriction ?? 0);
    const progressionComprehensionScore = totals?.comprehension ?? 0;
    const featureConfusionScore = Math.min(100, (totals?.confusionEvents ?? 0) * 10);
    const firstSessionActivationRate = totals ? (totals.activated / totalStarted) * 100 : 0;
    const workspaceUnderstandingScore = totals?.workspaceUnderstanding ?? 0;

    const recommendations = this.generateRefinementRecommendations(
      completionRate,
      setupFrictionScore,
      progressionComprehensionScore,
      featureConfusionScore,
      firstSessionActivationRate,
      workspaceUnderstandingScore
    );

    return {
      totalStarted,
      totalCompleted,
      completionRate,
      averageTimeToComplete,
      dropOffPoints,
      setupFrictionScore,
      progressionComprehensionScore,
      featureConfusionScore,
      firstSessionActivationRate,
      workspaceUnderstandingScore,
      recommendations,
    };
  },

  // ─── Generate Refinement Recommendations ────────────────────────────────────────
  generateRefinementRecommendations(
    completionRate: number,
    setupFrictionScore: number,
    progressionComprehensionScore: number,
    featureConfusionScore: number,
    firstSessionActivationRate: number,
    workspaceUnderstandingScore: number
  ): string[] {
    const recommendations: string[] = [];

    if (completionRate < 50) {
      recommendations.push('CRITICAL: Onboarding completion rate below 50% - major redesign needed');
    } else if (completionRate < 70) {
      recommendations.push('Onboarding completion rate concerning - review drop-off points');
    }

    if (setupFrictionScore > 50) {
      recommendations.push('High setup friction - simplify setup process and improve error handling');
    }

    if (progressionComprehensionScore < 60) {
      recommendations.push('Low progression comprehension - improve explanation and reduce confusion');
    }

    if (featureConfusionScore > 40) {
      recommendations.push('High feature confusion - simplify feature discovery and improve guidance');
    }

    if (firstSessionActivationRate < 60) {
      recommendations.push('Low first-session activation - improve initial value proposition');
    }

    if (workspaceUnderstandingScore < 60) {
      recommendations.push('Low workspace understanding - improve onboarding guidance and reduce complexity');
    }

    if (recommendations.length === 0) {
      recommendations.push('Onboarding is healthy - continue monitoring');
    }

    return recommendations;
  },
};

export default onboardingActivationRefinement;
