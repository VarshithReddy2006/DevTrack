import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { OnboardingAnalytics } from '../../db/models/onboardingAnalytics.model.js';
import { onboardingActivationRefinement } from '../../modules/onboarding/onboardingActivationRefinement.service.js';
import { setupConfusionDetection } from '../../modules/onboarding/setupConfusionDetection.service.js';

const start = new Date('2026-01-01T00:00:00Z');
const end = new Date('2026-02-01T00:00:00Z');
const dateRange = { start, end };

async function insertAnalytics(records: Record<string, unknown>[]) {
  // Insert raw records so the tests exercise missing legacy fields without Mongoose defaults.
  await OnboardingAnalytics.collection.insertMany(records.map(record => ({
    userId: new Types.ObjectId(),
    startedAt: start,
    ...record,
  })));
}

describe('onboarding metrics aggregation', () => {
  it('weights every setup counter, averages across the date range, and caps friction at 100', async () => {
    await insertAnalytics([
      {
        setupFriction: { platformSyncIssues: 1, authenticationIssues: 2, configurationErrors: 1 },
        completedAt: end,
        totalDuration: 1000,
      },
      {
        startedAt: end,
        setupFriction: { platformSyncIssues: 0, configurationErrors: 1, totalSetupTime: 300001 },
        firstSessionMetrics: { timeToFirstAction: 70000, confusionEvents: 4 },
        earlyEngagement: { problemsAttemptedInFirstHour: 1 },
        dropOffStep: 'sync',
      },
      {
        setupFriction: { authenticationIssues: null, totalSetupTime: 300000 },
        firstSessionMetrics: null,
        dropOffStep: 'sync',
      },
      { startedAt: new Date(start.getTime() - 1), setupFriction: { configurationErrors: 100 } },
      { startedAt: new Date(end.getTime() + 1), setupFriction: { configurationErrors: 100 } },
    ]);

    expect(await onboardingActivationRefinement.getOnboardingRefinementMetrics(dateRange)).toMatchObject({
      totalStarted: 3,
      totalCompleted: 1,
      completionRate: (1 / 3) * 100,
      averageTimeToComplete: 1000,
      setupFrictionScore: 35,
      progressionComprehensionScore: 330 / 3,
      featureConfusionScore: (4 / 3) * 10,
      firstSessionActivationRate: (1 / 3) * 100,
      workspaceUnderstandingScore: 295 / 3,
      dropOffPoints: [{ step: 'sync', count: 2, percentage: (2 / 3) * 100 }],
    });

    await insertAnalytics([{ setupFriction: { authenticationIssues: 100 } }]);
    const capped = await onboardingActivationRefinement.getOnboardingRefinementMetrics(dateRange);
    expect(capped.setupFrictionScore).toBe(100);
    expect(capped.recommendations).toContainEqual(expect.stringContaining('High setup friction'));
  });

  it('sums setup counters and preserves both strict confusion thresholds', async () => {
    await insertAnalytics([
      { setupFriction: { platformSyncIssues: 1, authenticationIssues: 1 }, dropOffReason: 'auth' },
      { setupFriction: { platformSyncIssues: 0, configurationErrors: 2 }, dropOffReason: 'auth' },
      { firstSessionMetrics: { confusionEvents: 4 } },
      { setupFriction: { configurationErrors: 1 }, firstSessionMetrics: { confusionEvents: 3 } },
      { startedAt: new Date(end.getTime() + 1), firstSessionMetrics: { confusionEvents: 99 } },
    ]);

    expect(await setupConfusionDetection.detectSetupConfusion(dateRange)).toMatchObject({
      totalUsers: 4,
      confusedUsers: 3,
      confusionRate: 75,
      commonConfusionPoints: [{ point: 'auth', count: 2, percentage: 50 }],
      setupIssues: [
        { issue: 'configuration', count: 3 },
        { issue: 'platform_sync', count: 1 },
        { issue: 'authentication', count: 1 },
      ],
    });
  });

  it('averages positive timings and counts missing confusion and help metrics as zero', async () => {
    await insertAnalytics([
      {
        firstSessionMetrics: {
          timeToFirstAction: 30000,
          timeToFirstProblem: 100000,
          timeToFirstCompletion: 180000,
          confusionEvents: 3,
          helpRequests: 2,
        },
      },
      { startedAt: end, firstSessionMetrics: { timeToFirstAction: 0, timeToFirstProblem: -1 } },
      { startedAt: new Date(end.getTime() + 1), firstSessionMetrics: { timeToFirstAction: 90000 } },
    ]);

    expect(await setupConfusionDetection.analyzeFirstSessionActivation(dateRange)).toMatchObject({
      averageTimeToFirstAction: 30000,
      averageTimeToFirstProblem: 100000,
      averageTimeToFirstCompletion: 180000,
      confusionEventsPerSession: 1.5,
      helpRequestsPerSession: 1,
      activationQuality: 'medium',
    });
  });

  it('returns zero metrics for an empty range', async () => {
    expect(await onboardingActivationRefinement.getOnboardingRefinementMetrics(dateRange)).toMatchObject({
      totalStarted: 0,
      setupFrictionScore: 0,
      dropOffPoints: [],
    });
    expect(await setupConfusionDetection.detectSetupConfusion(dateRange)).toMatchObject({
      totalUsers: 0,
      confusedUsers: 0,
      confusionRate: 0,
      setupIssues: [],
    });
    expect(await setupConfusionDetection.analyzeFirstSessionActivation(dateRange)).toMatchObject({
      averageTimeToFirstAction: 0,
      averageTimeToFirstProblem: 0,
      averageTimeToFirstCompletion: 0,
      confusionEventsPerSession: 0,
      helpRequestsPerSession: 0,
    });
  });
});
