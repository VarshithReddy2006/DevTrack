import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { User, UserAnalytics, UserStreakLog } from '../../../db/models/index.js';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { clearConsumerRegistry, consumerRegistry } from '../../../shared/events/consumerRegistry.js';
import {
  createDomainEvent,
  type DsaProblemSolvedPayload,
  type RevisionReviewedPayload,
} from '../../../shared/events/eventContract.js';
import { runConsumer } from '../../../shared/events/runConsumer.js';
import { processDomainReadinessJob } from '../../../modules/readiness/workers/domainReadiness.worker.js';
import { getUnifiedStreak } from '../../../modules/streak/streak.service.js';
import {
  dsaProblemSolvedStreakConsumer,
  revisionCardReviewedStreakConsumer,
  registerStreakConsumers,
} from '../../../modules/streak/consumers/index.js';

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitStreakMilestone: vi.fn(),
    emitStreakAtRisk: vi.fn(),
  },
}));

vi.mock('../../../shared/jobs/index.js', () => ({
  getXpProcessingQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateUserStreak: vi.fn().mockResolvedValue(undefined),
    invalidateDashboard: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: {
    updateFromEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Streak Event Consumers (dsa.problem.solved & revision.card_reviewed)', () => {
  let userId: string;

  beforeAll(async () => {
    await Promise.all([User.init(), UserStreakLog.init(), UserAnalytics.init(), ProcessedEvent.init()]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clearConsumerRegistry();
    userId = new Types.ObjectId().toHexString();
    await User.create({
      _id: new Types.ObjectId(userId),
      clerkId: `clerk_${userId}`,
      email: `streak-${userId}@example.test`,
      username: `streak_${userId.slice(-6)}`,
      displayName: 'Streak Consumer Tester',
      timezone: 'UTC',
    });
  });

  it('records DSA streak activity on dsa.problem.solved and updates UserAnalytics', async () => {
    const solvedAt = new Date().toISOString();
    const event = createDomainEvent<'dsa.problem.solved', DsaProblemSolvedPayload>(
      'dsa.problem.solved',
      {
        platform: 'leetcode',
        problemId: 'two-sum',
        title: 'Two Sum',
        difficulty: 'easy',
        solvedAt,
      },
      { userId }
    );

    const result = await runConsumer(dsaProblemSolvedStreakConsumer, event);
    expect(result).toMatchObject({
      consumerName: 'streak.dsaProblemSolved',
      executed: true,
      skipped: false,
      reason: 'executed',
    });

    const log = await UserStreakLog.findOne({ userId: new Types.ObjectId(userId), streakType: 'dsa' }).lean();
    expect(log).not.toBeNull();
    expect(log?.activityCount).toBe(1);
    expect(log?.sources).toContain('dsa_problem:leetcode:two-sum');

    const analytics = await UserAnalytics.findOne({ userId: new Types.ObjectId(userId) }).lean();
    expect(analytics?.currentStreak).toBe(1);
    expect(analytics?.bestStreak).toBe(1);

    const inbox = await ProcessedEvent.findOne({ consumer: 'streak.dsaProblemSolved', eventId: event.id }).lean();
    expect(inbox).not.toBeNull();
  });

  it('records revision streak activity on revision.card_reviewed and contributes to unified streak', async () => {
    const cardId = new Types.ObjectId().toHexString();
    const reviewedAt = new Date().toISOString();
    const event = createDomainEvent<'revision.card_reviewed', RevisionReviewedPayload>(
      'revision.card_reviewed',
      {
        cardId,
        reviewSeq: 3,
        rating: 'easy',
        reviewedAt,
      },
      { userId }
    );

    const result = await runConsumer(revisionCardReviewedStreakConsumer, event);
    expect(result.executed).toBe(true);
    expect(result.reason).toBe('executed');

    const log = await UserStreakLog.findOne({ userId: new Types.ObjectId(userId), streakType: 'revision' }).lean();
    expect(log).not.toBeNull();
    expect(log?.activityCount).toBe(1);
    expect(log?.sources).toContain(`revision_card:${cardId}:3`);

    const unified = await getUnifiedStreak(userId);
    expect(unified.currentStreak).toBe(1);
    expect(unified.isActiveToday).toBe(true);
  });

  it('deduplicates duplicate eventIds via ProcessedEvent inbox and duplicate sources across distinct eventIds', async () => {
    const cardId = new Types.ObjectId().toHexString();
    const reviewedAt = new Date().toISOString();
    const firstEvent = createDomainEvent<'revision.card_reviewed', RevisionReviewedPayload>(
      'revision.card_reviewed',
      { cardId, reviewSeq: 1, rating: 'hard', reviewedAt },
      { userId }
    );

    const first = await runConsumer(revisionCardReviewedStreakConsumer, firstEvent);
    const duplicate = await runConsumer(revisionCardReviewedStreakConsumer, firstEvent);

    expect(first.reason).toBe('executed');
    expect(duplicate).toMatchObject({
      executed: false,
      skipped: true,
      reason: 'duplicate_inbox',
    });

    // Different eventId representing the same card review sequence should still dedup via UserStreakLog.sources
    const replayedEvent = createDomainEvent<'revision.reviewed', RevisionReviewedPayload>(
      'revision.reviewed',
      { cardId, reviewSeq: 1, rating: 'hard', reviewedAt },
      { userId }
    );
    const replayResult = await runConsumer(revisionCardReviewedStreakConsumer, replayedEvent);
    expect(replayResult.reason).toBe('executed');

    const log = await UserStreakLog.findOne({ userId: new Types.ObjectId(userId), streakType: 'revision' }).lean();
    expect(log?.activityCount).toBe(1);
    expect(log?.sources).toEqual([`revision_card:${cardId}:1`]);
  });

  it('respects user configured local timezone during date rollover evaluation', async () => {
    // User is in Asia/Kolkata (UTC+05:30). 2026-11-24T20:00:00Z is 2026-11-25 01:30 IST.
    await User.updateOne({ _id: new Types.ObjectId(userId) }, { $set: { timezone: 'Asia/Kolkata' } });

    const dsaEvent = createDomainEvent(
      'dsa.problem.solved',
      {
        platform: 'leetcode',
        problemId: 'ist-rollover',
        solvedAt: '2026-11-24T20:00:00.000Z',
      },
      { userId }
    );

    await runConsumer(dsaProblemSolvedStreakConsumer, dsaEvent);

    const log = await UserStreakLog.findOne({ userId: new Types.ObjectId(userId), streakType: 'dsa' }).lean();
    expect(log?.timezone).toBe('Asia/Kolkata');
    expect(log?.dateKey).toBe('2026-11-25');
  });

  it('ignores malformed payloads and invalid userIds gracefully without throwing', async () => {
    const malformedEvent = createDomainEvent(
      'dsa.problem.solved',
      { platform: 'leetcode' } as never,
      { userId }
    );
    await runConsumer(dsaProblemSolvedStreakConsumer, malformedEvent);

    const invalidUserEvent = createDomainEvent<'revision.card_reviewed', RevisionReviewedPayload>(
      'revision.card_reviewed',
      { cardId: 'card-1', reviewSeq: 1, rating: 'easy' },
      { userId: 'not-a-valid-object-id' }
    );
    await runConsumer(revisionCardReviewedStreakConsumer, invalidUserEvent);

    expect(await UserStreakLog.countDocuments({ userId: new Types.ObjectId(userId) })).toBe(0);
  });

  it('registers streak consumers idempotently on domain-readiness and dispatches through worker path', async () => {
    registerStreakConsumers();
    registerStreakConsumers();

    expect(consumerRegistry.getQueues('dsa.problem.solved')).toEqual(['domain-readiness']);
    expect(consumerRegistry.getQueues('revision.card_reviewed')).toEqual(['domain-readiness']);
    expect(consumerRegistry.getQueues('revision.reviewed')).toEqual(['domain-readiness']);

    const dsaResults = await processDomainReadinessJob(
      createDomainEvent(
        'dsa.problem.solved',
        { platform: 'codeforces', problemId: '1900A', solvedAt: new Date().toISOString() },
        { userId }
      )
    );
    const revResults = await processDomainReadinessJob(
      createDomainEvent(
        'revision.card_reviewed',
        {
          cardId: new Types.ObjectId().toHexString(),
          reviewSeq: 2,
          rating: 'easy',
          reviewedAt: new Date().toISOString(),
        },
        { userId }
      )
    );

    expect(dsaResults).toHaveLength(1);
    expect(dsaResults[0]).toMatchObject({ consumerName: 'streak.dsaProblemSolved', reason: 'executed' });
    expect(revResults).toHaveLength(1);
    expect(revResults[0]).toMatchObject({ consumerName: 'streak.revisionCardReviewed', reason: 'executed' });
  });

  it('computes anti-cheat daysDiff in user local calendar days across UTC midnight boundaries', async () => {
    const { recordActivity } = await import('../../../modules/streak/streak.service.js');
    vi.useFakeTimers();
    try {
      // 2026-11-26T12:00:00Z is already 2026-11-27 01:00 in Pacific/Auckland (+13)
      vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));

      // 2026-11-24 local in Pacific/Auckland is 3 local calendar days old -> must be rejected
      await recordActivity({
        userId,
        streakType: 'dsa',
        source: 'auckland-too-old',
        timezone: 'Pacific/Auckland',
        activityDate: new Date('2026-11-24T00:00:00.000Z'),
      });
      expect(await UserStreakLog.countDocuments({ userId: new Types.ObjectId(userId) })).toBe(0);

      // 2026-11-25 local in Pacific/Auckland is 2 local calendar days old -> must be accepted
      await recordActivity({
        userId,
        streakType: 'dsa',
        source: 'auckland-valid-2d',
        timezone: 'Pacific/Auckland',
        activityDate: new Date('2026-11-25T00:00:00.000Z'),
      });
      expect(await UserStreakLog.countDocuments({ userId: new Types.ObjectId(userId), dateKey: '2026-11-25' })).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
