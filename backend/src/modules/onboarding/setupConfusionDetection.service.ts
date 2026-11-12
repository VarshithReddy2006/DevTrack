// src/modules/onboarding/setupConfusionDetection.service.ts — Setup Confusion Detection Service
// Phase-J: Onboarding + Activation Optimization - Setup confusion detection and first-session activation

import mongoose from 'mongoose';
import { OnboardingAnalytics } from '../../db/models/onboardingAnalytics.model.js';
import { SessionReplay } from '../../db/models/sessionReplay.model.js';
import { numberOrZero, topDropOffs, type DropOffCount } from './onboardingMetricsAggregation.js';

interface ConfusionTotals {
  totalUsers: number;
  confusedUsers: number;
  platformSync: number;
  authentication: number;
  configuration: number;
}

type ActivationAverages = Pick<FirstSessionActivation,
  'averageTimeToFirstAction' | 'averageTimeToFirstProblem' | 'averageTimeToFirstCompletion'
  | 'confusionEventsPerSession' | 'helpRequestsPerSession'>;

function positiveTiming(field: string) {
  return { $avg: { $cond: [{ $gt: [field, 0] }, field, null] } };
}

export interface ConfusionDetection {
  totalUsers: number;
  confusedUsers: number;
  confusionRate: number;
  commonConfusionPoints: Array<{ point: string; count: number; percentage: number }>;
  setupIssues: Array<{ issue: string; count: number }>;
  recommendations: string[];
}

export interface FirstSessionActivation {
  averageTimeToFirstAction: number;
  averageTimeToFirstProblem: number;
  averageTimeToFirstCompletion: number;
  confusionEventsPerSession: number;
  helpRequestsPerSession: number;
  activationQuality: 'high' | 'medium' | 'low';
  recommendations: string[];
}

export const setupConfusionDetection = {
  // ─── Detect Setup Confusion ────────────────────────────────────────────────
  async detectSetupConfusion(dateRange: { start: Date; end: Date }): Promise<ConfusionDetection> {
    const platformSync = numberOrZero('$setupFriction.platformSyncIssues');
    const authentication = numberOrZero('$setupFriction.authenticationIssues');
    const configuration = numberOrZero('$setupFriction.configurationErrors');
    const confused = {
      $or: [
        { $gt: [numberOrZero('$firstSessionMetrics.confusionEvents'), 3] },
        { $gt: [{ $add: [platformSync, authentication, configuration] }, 1] },
      ],
    };
    const [result] = await OnboardingAnalytics.aggregate<{ totals: ConfusionTotals[]; dropOffs: DropOffCount[] }>([
      { $match: { startedAt: { $gte: dateRange.start, $lte: dateRange.end } } },
      {
        $facet: {
          dropOffs: topDropOffs('$dropOffReason'),
          totals: [{
            $group: {
              _id: null,
              totalUsers: { $sum: 1 },
              confusedUsers: { $sum: { $cond: [confused, 1, 0] } },
              platformSync: { $sum: { $max: [0, platformSync] } },
              authentication: { $sum: { $max: [0, authentication] } },
              configuration: { $sum: { $max: [0, configuration] } },
            },
          }],
        },
      },
    ]);
    const totals = result?.totals[0];
    const totalUsers = totals?.totalUsers ?? 0;
    const confusedUsers = totals?.confusedUsers ?? 0;
    const confusionRate = totalUsers ? (confusedUsers / totalUsers) * 100 : 0;
    const commonConfusionPoints = (result?.dropOffs ?? []).map(({ _id, count }) => ({
      point: _id,
      count,
      percentage: (count / totalUsers) * 100,
    }));
    const setupIssuesArray = [
      { issue: 'platform_sync', count: totals?.platformSync ?? 0 },
      { issue: 'authentication', count: totals?.authentication ?? 0 },
      { issue: 'configuration', count: totals?.configuration ?? 0 },
    ].filter(({ count }) => count > 0).sort((a, b) => b.count - a.count);

    // Generate recommendations
    const recommendations = this.generateConfusionRecommendations(
      confusionRate,
      commonConfusionPoints,
      setupIssuesArray
    );

    return {
      totalUsers,
      confusedUsers,
      confusionRate,
      commonConfusionPoints,
      setupIssues: setupIssuesArray,
      recommendations,
    };
  },

  // ─── Generate Confusion Recommendations ────────────────────────────────────
  generateConfusionRecommendations(
    confusionRate: number,
    confusionPoints: Array<{ point: string; count: number; percentage: number }>,
    setupIssues: Array<{ issue: string; count: number }>
  ): string[] {
    const recommendations: string[] = [];

    if (confusionRate > 30) {
      recommendations.push('CRITICAL: High confusion rate - major onboarding redesign needed');
    } else if (confusionRate > 15) {
      recommendations.push('Concerning confusion rate - review onboarding clarity');
    }

    confusionPoints.slice(0, 3).forEach(({ point }) => {
      recommendations.push(`Address confusion at "${point}" - improve guidance and reduce ambiguity`);
    });

    setupIssues.slice(0, 3).forEach(({ issue }) => {
      recommendations.push(`Fix ${issue} issues - improve setup reliability and error messages`);
    });

    if (recommendations.length === 0) {
      recommendations.push('Setup confusion is low - continue monitoring');
    }

    return recommendations;
  },

  // ─── Analyze First Session Activation ───────────────────────────────────────
  async analyzeFirstSessionActivation(dateRange: { start: Date; end: Date }): Promise<FirstSessionActivation> {
    const [averages] = await OnboardingAnalytics.aggregate<ActivationAverages>([
      { $match: { startedAt: { $gte: dateRange.start, $lte: dateRange.end } } },
      {
        $group: {
          _id: null,
          averageTimeToFirstAction: positiveTiming('$firstSessionMetrics.timeToFirstAction'),
          averageTimeToFirstProblem: positiveTiming('$firstSessionMetrics.timeToFirstProblem'),
          averageTimeToFirstCompletion: positiveTiming('$firstSessionMetrics.timeToFirstCompletion'),
          confusionEventsPerSession: { $avg: numberOrZero('$firstSessionMetrics.confusionEvents') },
          helpRequestsPerSession: { $avg: numberOrZero('$firstSessionMetrics.helpRequests') },
        },
      },
    ]);
    const averageTimeToFirstAction = averages?.averageTimeToFirstAction ?? 0;
    const averageTimeToFirstProblem = averages?.averageTimeToFirstProblem ?? 0;
    const averageTimeToFirstCompletion = averages?.averageTimeToFirstCompletion ?? 0;
    const averageConfusionEvents = averages?.confusionEventsPerSession ?? 0;
    const averageHelpRequests = averages?.helpRequestsPerSession ?? 0;

    // Determine activation quality
    const activationQuality = this.determineActivationQuality(
      averageTimeToFirstAction,
      averageConfusionEvents,
      averageHelpRequests
    );

    // Generate recommendations
    const recommendations = this.generateActivationRecommendations(
      averageTimeToFirstAction,
      averageTimeToFirstProblem,
      averageConfusionEvents,
      averageHelpRequests,
      activationQuality
    );

    return {
      averageTimeToFirstAction,
      averageTimeToFirstProblem,
      averageTimeToFirstCompletion,
      confusionEventsPerSession: averageConfusionEvents,
      helpRequestsPerSession: averageHelpRequests,
      activationQuality,
      recommendations,
    };
  },

  // ─── Determine Activation Quality ───────────────────────────────────────────
  determineActivationQuality(
    timeToFirstAction: number,
    confusionEvents: number,
    helpRequests: number
  ): 'high' | 'medium' | 'low' {
    if (timeToFirstAction < 30000 && confusionEvents < 2 && helpRequests < 1) {
      return 'high';
    }
    if (timeToFirstAction < 60000 && confusionEvents < 4 && helpRequests < 2) {
      return 'medium';
    }
    return 'low';
  },

  // ─── Generate Activation Recommendations ─────────────────────────────────────
  generateActivationRecommendations(
    timeToFirstAction: number,
    timeToFirstProblem: number,
    confusionEvents: number,
    helpRequests: number,
    activationQuality: 'high' | 'medium' | 'low'
  ): string[] {
    const recommendations: string[] = [];

    if (activationQuality === 'low') {
      recommendations.push('Poor activation quality - major onboarding improvements needed');
    }

    if (timeToFirstAction > 60000) {
      recommendations.push('Long time to first action - reduce cognitive load and improve initial guidance');
    }

    if (timeToFirstProblem > 120000) {
      recommendations.push('Long time to first problem - improve problem discovery and accessibility');
    }

    if (confusionEvents > 3) {
      recommendations.push('High confusion events - improve UX clarity and reduce ambiguity');
    }

    if (helpRequests > 2) {
      recommendations.push('High help requests - improve self-service guidance and reduce need for support');
    }

    if (recommendations.length === 0) {
      recommendations.push('First session activation is healthy - continue monitoring');
    }

    return recommendations;
  },

  // ─── Get Session Replay Analysis ─────────────────────────────────────────────
  async getSessionReplayAnalysis(userId: mongoose.Types.ObjectId): Promise<{
    sessionId: string;
    confusionEvents: number;
    hesitationPoints: number;
    errorEvents: number;
    totalFriction: number;
    recommendations: string[];
  }> {
    const sessionReplays = await SessionReplay.find({ userId }).sort({ startTime: -1 }).limit(1);

    if (sessionReplays.length === 0) {
      return {
        sessionId: '',
        confusionEvents: 0,
        hesitationPoints: 0,
        errorEvents: 0,
        totalFriction: 0,
        recommendations: ['No session replay data available'],
      };
    }

    const replay = sessionReplays[0];

    const confusionEvents = replay.frictionEvents.filter(f => f.type === 'confusion').length;
    const hesitationPoints = replay.frictionEvents.filter(f => f.type === 'hesitation').length;
    const errorEvents = replay.frictionEvents.filter(f => f.type === 'error').length;
    const totalFriction = replay.frictionEvents.length;

    const recommendations = this.generateReplayRecommendations(
      confusionEvents,
      hesitationPoints,
      errorEvents,
      totalFriction
    );

    return {
      sessionId: replay.sessionId,
      confusionEvents,
      hesitationPoints,
      errorEvents,
      totalFriction,
      recommendations,
    };
  },

  // ─── Generate Replay Recommendations ────────────────────────────────────────
  generateReplayRecommendations(
    confusionEvents: number,
    hesitationPoints: number,
    errorEvents: number,
    totalFriction: number
  ): string[] {
    const recommendations: string[] = [];

    if (confusionEvents > 3) {
      recommendations.push('High confusion events - review UX for clarity issues');
    }

    if (hesitationPoints > 5) {
      recommendations.push('Frequent hesitation - reduce cognitive load and improve decision clarity');
    }

    if (errorEvents > 2) {
      recommendations.push('Error events detected - improve error handling and prevention');
    }

    if (totalFriction > 10) {
      recommendations.push('High overall friction - comprehensive UX review needed');
    }

    if (recommendations.length === 0) {
      recommendations.push('Session appears smooth - no major friction detected');
    }

    return recommendations;
  },
};

export default setupConfusionDetection;
